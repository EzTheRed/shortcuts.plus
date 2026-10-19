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
  /data/shortcuts.json
  /assets/icons/favicon.svg

Do not keep duplicate runtime files at the repository root.

Delete these stale files:
  /styles.css
  /shortcuts.json
  /favicon.svg

Shortcut metadata belongs in:
  /data/shortcuts.json

The deployment host should publish the repository root as the site root.

If using a host that supports _headers and _redirects, leave those files in place.

Shortcuts+ is an independent website and is not affiliated with Apple.
