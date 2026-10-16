# Asmina Nassar — Portfolio

Personal portfolio site for an AI & Robotics Engineer. Plain HTML, CSS and JavaScript, so there's no build step.

```
index.html                 all page content
assets/css/style.css       styles (colours and fonts are tokens at the top)
assets/js/main.js          theme toggle, mobile menu, project filter, scroll reveal
assets/js/mcl.js           hero animation (Monte Carlo localization demo)
.github/workflows/deploy.yml   GitHub Pages deployment
```

## Preview locally

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a GitHub repository and push this folder to the `main` branch.
2. In the repository, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Every push to `main` now deploys automatically. You can also run the workflow manually from the **Actions** tab.

The site is published at `https://<username>.github.io/<repo>/`. If you name the repository `<username>.github.io`, it's served from `https://<username>.github.io/` instead.

## Editing content

- **Text, jobs, projects:** edit `index.html`. Each project is an `<article class="project">`. Its `data-cat` attribute (`robotics`, `ai`, `cv`, `ml`) controls which filters show it.
- **Colours:** change `--accent` and the other tokens at the top of `style.css`. There's a light set and a dark set.
