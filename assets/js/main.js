(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Theme ---------- */
  var themeBtn = document.getElementById('theme-toggle');
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function currentTheme() {
    return root.getAttribute('data-theme') || (darkQuery.matches ? 'dark' : 'light');
  }

  function syncThemeLabel() {
    themeBtn.setAttribute('aria-label', currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }

  themeBtn.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    syncThemeLabel();
    document.dispatchEvent(new CustomEvent('themechange'));
  });
  syncThemeLabel();

  /* ---------- Mobile menu ---------- */
  var menuBtn = document.getElementById('menu-toggle');
  var nav = document.getElementById('nav');

  function setMenu(open) {
    nav.classList.toggle('is-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  menuBtn.addEventListener('click', function () {
    setMenu(!nav.classList.contains('is-open'));
  });
  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) setMenu(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      setMenu(false);
      menuBtn.focus();
    }
  });

  /* ---------- Header border on scroll ---------- */
  var header = document.getElementById('site-header');
  function onScroll() { header.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Active nav link ---------- */
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav-list a'));
  if ('IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('is-active'); });
        var link = byId[entry.target.id];
        if (link) link.classList.add('is-active');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    document.querySelectorAll('main section[id]').forEach(function (s) { spy.observe(s); });
  }

  /* ---------- Project filter ---------- */
  var filters = Array.prototype.slice.call(document.querySelectorAll('.filter'));
  var projects = Array.prototype.slice.call(document.querySelectorAll('.project'));
  var empty = document.getElementById('projects-empty');

  filters.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var cat = btn.getAttribute('data-filter');
      filters.forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      var shown = 0;
      projects.forEach(function (p) {
        var match = cat === 'all' || p.getAttribute('data-cat').split(' ').indexOf(cat) !== -1;
        p.hidden = !match;
        if (match) {
          shown++;
          p.classList.add('is-visible');
        }
      });
      empty.hidden = shown > 0;
    });
  });

  // A link to a project hidden by the current filter resets the filter so the jump lands.
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href^="#"]');
    var target = link && document.getElementById(link.getAttribute('href').slice(1));
    if (target && target.classList.contains('project') && target.hidden) filters[0].click();
  });

  /* ---------- Reveal on scroll ---------- */
  var reveals = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Footer year ---------- */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  /* ---------- Hero animation ---------- */
  var canvas = document.getElementById('mcl-canvas');
  if (canvas && window.MCL) window.MCL.mount(canvas, document.getElementById('mcl-status'));
})();
