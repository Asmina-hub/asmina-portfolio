/*
 * Hero animation — a tiny Monte Carlo localization demo.
 *
 * A robot drives through a floor plan that has three identical rooms. LiDAR
 * alone cannot tell them apart, so the particle cloud splits across all three
 * until an LLM "observation" names the room; the filter then collapses onto
 * the true pose and tracks it. A toy version of the master's thesis.
 */
(function (root) {
  'use strict';

  var W = 120, H = 72;      // map size in units (1 unit ≈ 0.25 m)
  var N = 500;              // particles
  var RAYS = 16;
  var RANGE = 30;
  var SPEED = 10;           // units per second
  var TICK = 0.35;          // seconds between sensor updates / resampling
  var LLM_AT = 3.2;         // seconds into a run when the LLM is queried
  var LLM_P = 0.87;
  var HOLD = 2;             // pause at the end of the path before restarting
  var SIGMA = 4;            // LiDAR range noise used by the likelihood
  var INJECT = 0.01;        // random particle injection per resample
  var M_PER_UNIT = 0.25;

  // Rooms repeat every 40 units, so a LiDAR scan alone is ambiguous between them.
  var WALLS = [
    [0, 0, 120, 0], [120, 0, 120, 72], [120, 72, 0, 72], [0, 72, 0, 0],
    [40, 0, 40, 30], [80, 0, 80, 30], [40, 42, 40, 72], [80, 42, 80, 72],
    [0, 30, 16, 30], [24, 30, 56, 30], [64, 30, 96, 30], [104, 30, 120, 30],
    [0, 42, 26, 42], [34, 42, 66, 42], [74, 42, 106, 42], [114, 42, 120, 42]
  ];

  var ROOMS = [
    { name: 'Office',   x0: 0,  y0: 0,  x1: 40,  y1: 30 },
    { name: 'Lab',      x0: 40, y0: 0,  x1: 80,  y1: 30 },
    { name: 'Kitchen',  x0: 80, y0: 0,  x1: 120, y1: 30 },
    { name: 'Corridor', x0: 0,  y0: 30, x1: 120, y1: 42 },
    { name: 'Seminar',  x0: 0,  y0: 42, x1: 40,  y1: 72 },
    { name: 'Server',   x0: 40, y0: 42, x1: 80,  y1: 72 },
    { name: 'Storage',  x0: 80, y0: 42, x1: 120, y1: 72 }
  ];
  var TARGET = 2;

  var PATH = [[108, 10], [90, 10], [90, 22], [100, 24], [100, 36], [60, 36], [30, 36], [30, 52], [18, 60]];

  var ANGLES = [];
  for (var k = 0; k < RAYS; k++) ANGLES.push((k + 0.5) * 2 * Math.PI / RAYS);

  function cast(x, y, a) {
    var dx = Math.cos(a), dy = Math.sin(a), best = RANGE;
    for (var i = 0; i < WALLS.length; i++) {
      var s = WALLS[i], ex = s[2] - s[0], ey = s[3] - s[1];
      var den = dx * ey - dy * ex;
      if (den > -1e-9 && den < 1e-9) continue;
      var qx = s[0] - x, qy = s[1] - y;
      var t = (qx * ey - qy * ex) / den;
      var u = (qx * dy - qy * dx) / den;
      if (t > 0 && t < best && u >= 0 && u <= 1) best = t;
    }
    return best;
  }

  function inRoom(r, x, y) {
    return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function createSim(rand) {
    rand = rand || Math.random;

    function gauss() {
      var u = 1 - rand(), v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    var segLen = [], total = 0;
    for (var i = 1; i < PATH.length; i++) {
      var l = Math.hypot(PATH[i][0] - PATH[i - 1][0], PATH[i][1] - PATH[i - 1][1]);
      segLen.push(l);
      total += l;
    }

    function along(d) {
      for (var i = 0; i < segLen.length; i++) {
        if (d <= segLen[i] || i === segLen.length - 1) {
          var f = Math.min(1, d / segLen[i]), a = PATH[i], b = PATH[i + 1];
          return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, h: Math.atan2(b[1] - a[1], b[0] - a[0]) };
        }
        d -= segLen[i];
      }
    }

    var s = {
      W: W, H: H, walls: WALLS, rooms: ROOMS, target: TARGET, angles: ANGLES, range: RANGE,
      n: N, px: new Float32Array(N), py: new Float32Array(N), scan: new Float32Array(RAYS),
      t: 0, x: 0, y: 0, h: 0, phase: 'global', llmAt: -1, est: null, error: null, llmAtTime: LLM_AT
    };
    var qx = new Float32Array(N), qy = new Float32Array(N), lw = new Float64Array(N);
    var dist = 0, acc = 0, ticks = 0, llmDone = false, endAt = -1;

    function scatter(i) {
      s.px[i] = 1 + rand() * (W - 2);
      s.py[i] = 1 + rand() * (H - 2);
    }

    function sense() {
      for (var k = 0; k < RAYS; k++) s.scan[k] = cast(s.x, s.y, ANGLES[k]);
    }

    function update(inject, useLLM) {
      sense();
      var i, k, room = 0;
      for (i = 0; i < ROOMS.length; i++) if (inRoom(ROOMS[i], s.x, s.y)) { room = i; break; }
      var r0 = ROOMS[room];
      // Soft likelihood until the LLM speaks, so every matching room keeps its share of particles.
      if (inject) ticks = 0;
      var beta = llmDone || inject ? Math.min(1, 0.3 + 0.15 * ticks++) : Math.min(0.3, 0.1 + 0.05 * ticks++);
      // Inject particles into the room the LLM names, to recover from a wrong lock.
      if (inject) {
        for (i = 0; i < N; i++) {
          if (rand() < 0.25) { s.px[i] = r0.x0 + 1 + rand() * (r0.x1 - r0.x0 - 2); s.py[i] = r0.y0 + 1 + rand() * (r0.y1 - r0.y0 - 2); }
        }
      }
      var max = -Infinity;
      for (i = 0; i < N; i++) {
        var L = 0;
        for (k = 0; k < RAYS; k++) {
          var d = Math.min(Math.abs(cast(s.px[i], s.py[i], ANGLES[k]) - s.scan[k]), 10);
          L -= d * d;
        }
        L *= beta / (2 * SIGMA * SIGMA);
        if (useLLM) L += Math.log(inRoom(r0, s.px[i], s.py[i]) ? LLM_P : (1 - LLM_P) / (ROOMS.length - 1));
        lw[i] = L;
        if (L > max) max = L;
      }
      var sum = 0;
      for (i = 0; i < N; i++) {
        lw[i] = Math.exp(lw[i] - max);
        sum += lw[i];
      }
      // Low-variance resampling.
      var r = rand() / N, c = lw[0] / sum, j = 0;
      for (var m = 0; m < N; m++) {
        var u = r + m / N;
        while (u > c && j < N - 1) c += lw[++j] / sum;
        qx[m] = s.px[j] + gauss() * 0.5;
        qy[m] = s.py[j] + gauss() * 0.5;
      }
      s.px.set(qx);
      s.py.set(qy);
      for (m = 0; m < N; m++) if (rand() < INJECT) scatter(m);
    }

    // Mean-shift from the cloud's mean to its densest cluster; report a pose only once most particles agree.
    function estimate() {
      var mx = 0, my = 0, inside = 0, i;
      for (i = 0; i < N; i++) { mx += s.px[i]; my += s.py[i]; }
      mx /= N; my /= N;
      for (var it = 0; it < 4; it++) {
        var sx = 0, sy = 0;
        inside = 0;
        for (i = 0; i < N; i++) {
          var dx = s.px[i] - mx, dy = s.py[i] - my;
          if (dx * dx + dy * dy < 100) { sx += s.px[i]; sy += s.py[i]; inside++; }
        }
        if (!inside) break;
        mx = sx / inside; my = sy / inside;
      }
      if (inside > 0.6 * N) {
        s.est = { x: mx, y: my };
        s.error = Math.hypot(mx - s.x, my - s.y) * M_PER_UNIT;
      } else {
        s.est = null;
        s.error = null;
      }
    }

    function reset() {
      s.t = 0; dist = 0; acc = 0; ticks = 0; llmDone = false; endAt = -1;
      s.phase = 'global'; s.llmAt = -1; s.est = null; s.error = null;
      var p = along(0);
      s.x = p.x; s.y = p.y; s.h = p.h;
      for (var i = 0; i < N; i++) scatter(i);
      sense();
    }

    function step(dt) {
      s.t += dt;
      if (dist >= total) {
        if (endAt < 0) endAt = s.t;
        if (s.t - endAt > HOLD) reset();
        return;
      }
      var x0 = s.x, y0 = s.y;
      dist = Math.min(total, dist + SPEED * dt);
      var p = along(dist);
      s.x = p.x; s.y = p.y;
      var dh = Math.atan2(Math.sin(p.h - s.h), Math.cos(p.h - s.h));
      s.h += dh * Math.min(1, dt * 8);

      var dx = s.x - x0, dy = s.y - y0, sd = 0.03 + 0.15 * Math.hypot(dx, dy);
      for (var i = 0; i < N; i++) {
        s.px[i] = clamp(s.px[i] + dx + gauss() * sd, 0.5, W - 0.5);
        s.py[i] = clamp(s.py[i] + dy + gauss() * sd, 0.5, H - 0.5);
      }

      acc += dt;
      if (acc >= TICK) {
        acc -= TICK;
        var first = !llmDone && s.t >= LLM_AT;
        update(first, first || s.phase === 'llm');
        if (first) { llmDone = true; s.llmAt = s.t; s.phase = 'llm'; }
      }
      if (s.phase === 'llm' && s.t - s.llmAt > 2.4) s.phase = 'tracking';
      estimate();
    }

    s.reset = reset;
    s.step = step;
    s.cast = cast;
    reset();
    return s;
  }

  /* ---------- Rendering ---------- */

  function mount(canvas, statusEl) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var sim = createSim();
    var reduce = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    var colors = {}, view = { s: 1, ox: 0, oy: 0, w: 0, h: 0 };
    var raf = 0, last = 0, onScreen = true, statusKey = '';

    function readColors() {
      var cs = getComputedStyle(document.documentElement);
      colors.fg = cs.getPropertyValue('--fg').trim() || '#111';
      colors.muted = cs.getPropertyValue('--muted').trim() || '#666';
      colors.line = cs.getPropertyValue('--line').trim() || '#ddd';
      colors.accent = cs.getPropertyValue('--accent').trim() || '#0b7a68';
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      var dpr = Math.min(root.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var pad = 8;
      view.w = rect.width; view.h = rect.height;
      view.s = Math.min((rect.width - pad * 2) / W, (rect.height - pad * 2) / H);
      view.ox = (rect.width - W * view.s) / 2;
      view.oy = (rect.height - H * view.s) / 2;
    }

    function X(x) { return view.ox + x * view.s; }
    function Y(y) { return view.oy + y * view.s; }

    function draw() {
      var s = view.s, i, k;
      ctx.clearRect(0, 0, view.w, view.h);

      // Survey grid
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.line;
      for (var gx = 6; gx < W; gx += 6) {
        for (var gy = 6; gy < H; gy += 6) ctx.fillRect(X(gx) - 0.75, Y(gy) - 0.75, 1.5, 1.5);
      }

      // LLM highlight on the named room
      if (sim.llmAt >= 0) {
        var since = sim.t - sim.llmAt;
        var a = since < 0.3 ? since / 0.3 : Math.max(0, 1 - (since - 0.3) / 2.2);
        if (a > 0) {
          var r = sim.rooms[sim.target];
          ctx.globalAlpha = 0.14 * a;
          ctx.fillStyle = colors.accent;
          ctx.fillRect(X(r.x0), Y(r.y0), (r.x1 - r.x0) * s, (r.y1 - r.y0) * s);
        }
      }

      // Room labels
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = colors.muted;
      ctx.font = '500 ' + Math.max(8, Math.min(11, s * 2.6)) + 'px "JetBrains Mono", ui-monospace, monospace';
      ctx.textBaseline = 'top';
      for (i = 0; i < sim.rooms.length; i++) {
        ctx.fillText(sim.rooms[i].name.toUpperCase(), X(sim.rooms[i].x0 + 2.5), Y(sim.rooms[i].y0 + 2.2));
      }

      // Walls
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = colors.fg;
      ctx.lineWidth = Math.max(1.5, s * 0.5);
      ctx.lineCap = 'square';
      ctx.beginPath();
      for (i = 0; i < sim.walls.length; i++) {
        var w = sim.walls[i];
        ctx.moveTo(X(w[0]), Y(w[1]));
        ctx.lineTo(X(w[2]), Y(w[3]));
      }
      ctx.stroke();

      // LiDAR rays from the true pose
      ctx.strokeStyle = colors.accent;
      ctx.fillStyle = colors.accent;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      for (k = 0; k < sim.angles.length; k++) {
        ctx.moveTo(X(sim.x), Y(sim.y));
        ctx.lineTo(X(sim.x + Math.cos(sim.angles[k]) * sim.scan[k]), Y(sim.y + Math.sin(sim.angles[k]) * sim.scan[k]));
      }
      ctx.stroke();
      ctx.globalAlpha = 0.9;
      for (k = 0; k < sim.angles.length; k++) {
        if (sim.scan[k] >= sim.range) continue;
        ctx.beginPath();
        ctx.arc(X(sim.x + Math.cos(sim.angles[k]) * sim.scan[k]), Y(sim.y + Math.sin(sim.angles[k]) * sim.scan[k]), 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // Particles
      ctx.globalAlpha = 0.55;
      var ps = Math.max(1.6, s * 0.38);
      for (i = 0; i < sim.n; i++) ctx.fillRect(X(sim.px[i]) - ps / 2, Y(sim.py[i]) - ps / 2, ps, ps);

      // Pose estimate
      if (sim.est) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(X(sim.est.x), Y(sim.est.y), Math.max(8, s * 4), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Robot
      var rr = Math.max(4, s * 1.7);
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.fg;
      ctx.beginPath();
      ctx.arc(X(sim.x), Y(sim.y), rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colors.fg;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(sim.x), Y(sim.y));
      ctx.lineTo(X(sim.x) + Math.cos(sim.h) * rr * 2.2, Y(sim.y) + Math.sin(sim.h) * rr * 2.2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    var STATUS = {
      global: '<span class="mcl-step">01</span> LiDAR only — the scan fits three identical rooms',
      llm: '<span class="mcl-step">02</span> LLM sees “fridge, sink, kettle” → kitchen (p = 0.87)',
      tracking: '<span class="mcl-step">03</span> Localized — tracking the robot, error '
    };

    function updateStatus() {
      if (!statusEl) return;
      var key = sim.phase, html = STATUS[sim.phase];
      if (sim.phase === 'tracking') {
        var e = sim.error == null ? '—' : sim.error.toFixed(1) + ' m';
        key += e;
        html += e;
      }
      if (key !== statusKey) {
        statusKey = key;
        statusEl.innerHTML = html;
      }
    }

    function frame(ts) {
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 1 / 60;
      last = ts;
      sim.step(dt);
      draw();
      updateStatus();
      raf = root.requestAnimationFrame(frame);
    }

    function start() {
      if (raf || reduce.matches || !onScreen || document.hidden) return;
      last = 0;
      raf = root.requestAnimationFrame(frame);
    }

    function stop() {
      if (raf) root.cancelAnimationFrame(raf);
      raf = 0;
    }

    // Reduced motion: show one still frame with the multi-room ambiguity visible.
    function still() {
      sim.reset();
      while (sim.t < sim.llmAtTime - 0.3) sim.step(1 / 30);
      draw();
      updateStatus();
    }

    function refresh() {
      readColors();
      resize();
      if (reduce.matches) { stop(); still(); } else { draw(); start(); }
    }

    readColors();
    resize();

    if (root.ResizeObserver) new ResizeObserver(function () { resize(); if (!raf) draw(); }).observe(canvas);
    else root.addEventListener('resize', function () { resize(); if (!raf) draw(); });

    if (root.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        if (onScreen) start(); else stop();
      }).observe(canvas);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
    document.addEventListener('themechange', function () { readColors(); if (!raf) draw(); });
    if (root.matchMedia) {
      var scheme = root.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () { readColors(); if (!raf) draw(); };
      if (scheme.addEventListener) scheme.addEventListener('change', onScheme);
      if (reduce.addEventListener) reduce.addEventListener('change', refresh);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (!raf) draw(); });

    refresh();
  }

  var api = { createSim: createSim, mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MCL = api;
})(typeof window !== 'undefined' ? window : globalThis);
