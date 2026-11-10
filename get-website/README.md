# Shortcuts Plus Website API

Cloudflare Worker base URL: `https://api.shortcuts.plus`

## Endpoints

### 1. Get a webpage

`POST /get-website`

Send JSON `{ "url": "https://example.com" }` with a valid Basic token in the
`Authorization` header. A successful response contains only the finished,
packaged HTML file, with these headers:

```http
Content-Type: text/html; charset=utf-8
Content-Disposition: attachment; filename="webpage.html"
```

The response body is HTML, starting with the packaged document, rather than a
JSON dictionary. Authentication and validation errors still return JSON with an
`error` property and an appropriate HTTP error status.

**Migration from the former JSON response:** remove **Get Dictionary from
Input** and extraction of `file` from existing shortcuts. Use the response
itself as the HTML file. The API no longer returns `file`, `dynamic`, `metadata`,
or `instructions` fields. It does not extract links or forms into native menu
definitions, and it does not preload linked pages.

### 2. Generate a vCard menu file

`POST /vcf-menu`

Send the JSON object directly as the POST request body. Each property name
becomes a contact title, and its string value becomes the subtitle:

```json
{
  "title": "description",
  "Item 1": "An item.",
  "Item 2": "Another item."
}
```

For Apple Shortcuts, use **Get Contents of URL** with method **POST**, set the
request body to **JSON**, and include the API's Basic token in the
`Authorization` header. No URL encoding or query parameter is needed. Returns
one downloadable `shortcuts-menu.vcf` file containing one separate vCard
contact per object property, in the same order.

## Authentication

The public `POST /auth` endpoint issues a short-lived, single-use Basic
authorization value. It does not require Cloudflare Access or an identity login.

Send JSON containing only `api` (`get-website` or `vcf-menu`). The response body
is only the Basic authorization value as plain text. Tokens expire after 10
seconds, are bound to the selected API's ID, and can be used once.

Example request:

```json
{
  "api": "get-website"
}
```

Each protected API has its own fixed ID. The Basic authorization username
contains that API ID, and the API verifies that the ID matches its own before
consuming the token. A token issued for one API cannot authorize another API.
No caller-provided name is requested or used.

Because `/auth` is public, anyone can request a token. Keep issued authorization
values private and use them immediately.

## Suggested Apple Shortcuts flow

1. Call `POST https://api.shortcuts.plus/auth` with JSON
   `{ "api": "get-website" }` and retain the plain-text Basic authorization value.
2. Request `https://api.shortcuts.plus/get-website` using **Get Contents of URL**
   with method **POST** and JSON body `{ "url": "https://example.com" }`. Set the
   HTTP `Authorization` header to the value returned by `/auth`.
3. Use the response directly as `webpage.html` and pass it to **Quick Look**.
   If Shortcuts treats the response as text, name or save it with an `.html`
   extension before previewing it.

Quick Look displays the HTML file. The Worker does not provide native
interaction menus or callbacks from the preview. To package another URL, obtain
a fresh token and repeat the request with that URL.

## Packaging behavior

The Worker packages only the requested page and its linked CSS/JavaScript
resources. It inlines linked stylesheets, nested CSS imports (limited depth),
and external script files, rewrites CSS URLs to absolute URLs, and injects a
base URL so remaining relative resources can resolve. Packaged pages are
cached briefly for repeat requests; links and form targets are not fetched in
the background.

When the requested page is the Shortcuts Plus homepage
(`https://shortcuts.plus/`), the API returns a dedicated static collection with
an Apple-inspired layout. It fetches `/data/shortcuts.json` and includes every
valid catalog entry, with its title, description, categories, and destination
link. ID-based entries resolve their current name, description, and download
URL through the same registry as the website
(`POST https://s.shortcuts.plus/`). Production calls use the `REGISTRY` service
binding to `shortcuts-registry`, because Cloudflare does not support ordinary
fetches between same-zone routed Workers. Legacy HTTPS links remain supported. If a
lookup fails or returns an unsafe link, the entry still appears with a link to
its detail page. The collection is not limited to 60 shortcuts and does not
require JavaScript execution in Quick Look.

For YouTube pages containing supported public embedded video data, the Worker
returns a static feed with the detected videos, thumbnails, and available
video details. Other pages use the regular HTML packager.

The Worker does not execute JavaScript or render the page in Chromium. Some
sites require cookies, authentication, anti-bot challenges, or browser execution
and may not work in the packaged file.

The Worker accepts only public HTTP/HTTPS destinations,
blocks local/private/reserved hosts, validates redirects, and does not forward
user cookies or credentials. HTML is limited to 2 MB; each fetched CSS/JS
resource to 1 MB; aggregate CSS/JS to 4 MB; and no more than 24 external CSS/JS
resources are fetched. Images, fonts, video, and other binary media remain
external.

## Active API directory

`GET https://api.shortcuts.plus/api` returns a plain-text, single-array list of
every active endpoint, including its HTTP method:

- `POST /auth` — issue a short-lived token for an active API.
- `POST /get-website` — return a packaged HTML file for a public webpage.
- `POST /vcf-menu` — generate a vCard menu file.

The former Posts API has been retired. No publishing, listing, or
individual-post endpoints are active.

## Test and deployment

Run `npm test` in `get-website` for request-handler regression tests. Tests use
mocked registry, authentication storage, and cache; they do not call production
services.

Deploy both the website and the `shortcuts-get-website` Worker to release the
matching views. Preserve the Worker's existing production bindings and settings,
including `AUTH_DB`, when deploying.
