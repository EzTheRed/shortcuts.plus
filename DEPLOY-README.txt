SHORTCUTS+ STATIC SITE

Canonical site structure:

/index.html
/404.html
/library.html
/assets/css/styles.css
/assets/js/app.js
/assets/icons/favicon.svg
/data/shortcuts.json
/CNAME
/_headers
/_redirects

The main page loads:
  /assets/css/styles.css
  /assets/js/app.js
  https://s.shortcuts.plus/all
  /assets/icons/favicon.svg

Do not keep duplicate runtime files at the repository root.

Delete these stale files:
  /styles.css
  /shortcuts.json
  /favicon.svg

Shortcut metadata is served by the registry API:
  GET https://s.shortcuts.plus/all
  POST https://s.shortcuts.plus/details

Deploy registry/worker.mjs to the existing shortcuts-registry Worker before
releasing the website. See registry/README.md.
Keep /data/shortcuts.json for old index-based detail links and existing consumers.

The deployment host should publish the repository root as the site root.

If using a host that supports _headers and _redirects, leave those files in place.

Shortcuts+ is an independent website and is not affiliated with Apple.
