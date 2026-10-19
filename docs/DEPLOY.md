# Shortcuts+ site layout

Upload the contents of this folder as the site root. The home page is `/index.html`.

```
index.html              home page
404.html                missing-page page
library.html            old /library URL, redirects home
CNAME                   custom domain (shortcuts.plus)
_headers                cache rules for Cloudflare Pages
_redirects              old flat URLs → new folders
assets/css/styles.css   site styles
assets/js/app.js        gallery app
assets/icons/favicon.svg
data/shortcuts.json     shortcut library
docs/DEPLOY.md          this note (not linked from the site)
```

GitHub Pages does not read `_redirects`. The old `/library.html` file still sends people home. After you copy this in, delete the old root files so they do not shadow the new ones:

- `app.js`
- `styles.css`
- `favicon.svg`
- `shortcuts.json`
- `DEPLOY-README.txt`

Add new shortcuts in `data/shortcuts.json`. Each category is a top-level key. Icons the app knows: `music`, `image`, `note`, `calendar`, `bell`, `scan`, `spark`.

Paths start with `/` because the live site is the domain root (`shortcuts.plus`).
