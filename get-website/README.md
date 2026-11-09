# Shortcuts Plus — Get Website Worker

This Cloudflare Worker retrieves the HTML source of a public webpage for use in Apple Shortcuts.

## Endpoint

GET https://api.shortcuts.plus/get-website?url=https%3A%2F%2Fexample.com

The response is HTML. A base element is inserted into the document so relative resource URLs resolve against the final webpage URL.

## Health check

Open https://api.shortcuts.plus/. A JSON response with "status": "ok" indicates that the Worker is running.

## Deploy

- Repository: EzTheRed/shortcuts.plus
- Branch: main
- Project path: /get-website
- Build command: leave blank
- Worker name: shortcuts-get-website

The wrangler.jsonc file contains the Worker configuration.

## Limits and security

- Only GET and CORS preflight requests are supported.
- Only HTTP and HTTPS targets are accepted.
- Localhost, common private/reserved IP ranges, and local-only hostnames are rejected.
- Redirect destinations are validated, with a maximum of five redirects.
- HTML responses are limited to 2 MB.
- The Worker returns source HTML; it does not execute page JavaScript or render a browser view.
