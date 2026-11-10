# Shortcuts Plus Website API

Cloudflare Worker base URL: `https://api.shortcuts.plus`

## Endpoints

### 1. Get a webpage

`POST /get-website`

This is the only webpage endpoint. It returns a JSON dictionary:

- `file`: packaged HTML string to save as an `.html` file and preview with Quick Look.
- `dynamic`: preloaded native Shortcuts interaction definitions extracted from ordinary links and GET forms. These are data for Shortcuts to use; there is no separate action endpoint.
- `metadata`: title, source URL, asset counts, cache information, and preloaded link information.
- `instructions`: guidance for using the returned dynamic definitions.

Example response shape:

```json
{
  "file": "<!doctype html>...",
  "dynamic": [
    { "id": "link_1", "label": "About", "type": "link", "method": "GET", "target": "https://example.com/about" },
    {
      "id": "form_1",
      "label": "Search",
      "type": "form",
      "method": "GET",
      "target": "https://example.com/search",
      "fields": [
        { "id": "field_1", "name": "q", "label": "Search", "type": "text", "required": true }
      ]
    }
  ],
  "metadata": {
    "title": "Example",
    "source": "https://example.com/",
    "version": 1,
    "preloaded": [{ "id": "link_1", "label": "About" }]
  }
}
```

To follow a link, have Shortcuts send another `POST /get-website` request with JSON `{ "url": "<selected target>" }`. For a GET form, collect the listed field values in Shortcuts, add them to the form's `target` as URL query parameters using each field's `name`, then request `/get-website` with the resulting URL. The API itself does not receive interaction selections or submit forms.

### 2. Generate a vCard menu file

`POST /vcf-menu`

Send the JSON object directly as the POST request body. Each property name becomes a contact title, and its string value becomes the subtitle:

```json
{
  "title": "description",
  "Item 1": "An item.",
  "Item 2": "Another item."
}
```

For Apple Shortcuts, use **Get Contents of URL** with method **POST**, set the request body to **JSON**, and include the API's Basic token in the `Authorization` header. No URL encoding or query parameter is needed. Returns one downloadable `shortcuts-menu.vcf` file containing one separate vCard contact per object property, in the same order.

## Authentication

The public `POST /auth` endpoint issues a short-lived, single-use Basic authorization value. It does not require Cloudflare Access or an identity login.

Send JSON containing only `api` (`get-website`, `vcf-menu`, or `posts`). The response body is only the Basic authorization value as plain text. Tokens expire after 10 seconds, are bound to the selected API's ID, and can be used once.

Example request:

```json
{
  "api": "get-website"
}
```

Each protected API has its own fixed ID. The Basic authorization username contains that API ID, and the API verifies that the ID matches its own before consuming the token. A token issued for one API cannot authorize another API. No caller-provided name is requested or used.

Because `/auth` is public, anyone can request a token. Keep issued authorization values private and use them immediately.

## Suggested Apple Shortcuts flow

1. Call `POST https://api.shortcuts.plus/auth` with JSON `{ "api": "get-website" }` and use the plain-text Basic authorization value returned.
2. Request `https://api.shortcuts.plus/get-website` using **Get Contents of URL** with method **POST** and JSON body `{ "url": "https://example.com" }`.
3. Set the HTTP `Authorization` header to the supplied Basic authorization value.
4. Use **Get Dictionary from Input** on the webpage response.
5. Get the `file` value, save it with an `.html` extension, and use **Quick Look** to preview it.
6. Get the `dynamic` array and use **Choose from List** with the item labels.
7. When a link is chosen, repeat the POST request with that item's `target` as the JSON `url` value. For a GET form, collect its fields and build the target URL with those values as query parameters, then send that URL as the JSON `url` value.

Shortcuts handles choices and form prompts natively. Quick Look is only the display surface: it does not send a callback when an HTML element is tapped.

## Preloading and packaging behavior

The Worker packages the requested page and preloads up to four unique same-origin links in the background. Those pages are cached opportunistically, so a later `/get-website` request for one of them may be faster. The `dynamic` array is also included in the initial response so Shortcuts can build its menus and prompts without first making another request to discover the links and form fields. Preloading is limited; it does not recursively crawl the entire site.

The packager inlines linked stylesheets, nested CSS imports (limited depth), and external classic script files, and rewrites CSS URLs to absolute URLs. It injects a base URL so remaining relative resources can resolve.

When the requested page is the Shortcuts Plus homepage (`https://shortcuts.plus/`), the API uses a dedicated compact menu renderer instead of returning the regular website layout. It fetches `/data/shortcuts.json` and creates one mobile-friendly, vertically scrollable menu containing up to 60 entries, with each item's title, description, badge, categories, and destination link. The same entries are exposed in the `dynamic` array (with the item title as the label), so Shortcuts can also build a native **Choose from List** menu. This is a static pre-rendered view and does not require JavaScript execution in Quick Look.

It does not execute JavaScript or render the page in Chromium. It cannot reliably discover actions implemented only by JavaScript, buttons with no ordinary link/form behavior, dynamically created controls, or forms using POST. The interaction extractor exposes ordinary links and GET forms only. Some sites may require cookies, authentication, anti-bot challenges, or browser execution and therefore may not work.

The Worker accepts only public HTTP/HTTPS destinations, blocks local/private/reserved hosts, validates redirects, and does not forward user cookies or credentials. HTML is limited to 2 MB; each fetched CSS/JS resource to 1 MB; aggregate CSS/JS to 4 MB; and no more than 24 external CSS/JS resources are fetched. Images, fonts, video, and other binary media remain external.



## Active API directory

`GET https://api.shortcuts.plus/api` returns a plain-text, single-array list of every active endpoint, including its HTTP method.

The directory currently lists:

- `get-website` — webpage packaging.
- `vcf-menu` — downloadable vCard menu generation.
- `posts` — public post publishing and retrieval.



## Public Posts API

The Posts API is served from `https://posts.shortcuts.plus`. Posts are public to read. Publishing requires a short-lived, single-use Basic token scoped specifically to the `posts` API.

### Authentication

Send:

```http
POST https://posts.shortcuts.plus/auth
Content-Type: application/json

{"api":"posts"}
```

The response body is the Basic authorization value as plain text. Use it immediately; it expires after 10 seconds and can only be used once.

### Publish a post

```http
POST https://posts.shortcuts.plus/
Authorization: Basic <token>
Content-Type: application/json

{
  "name": "Post title",
  "content": "The text of the post",
  "poster": "Display name"
}
```

All three fields are required. The API also accepts an iCloud Shortcut sharing link in `content`, but rejects other URLs. Accepted links use the `https://www.icloud.com/shortcuts/...` or `https://icloud.com/shortcuts/...` format. Other content is stored as plain text.

The server automatically assigns an incrementing numeric ID and records the UTC date, time, and ISO-8601 creation timestamp. Do not send date or time fields.

A successful response includes the permanent URL, for example `https://posts.shortcuts.plus/1`.

### Read posts

- `GET https://posts.shortcuts.plus/all` — public list, newest first.
- `GET https://posts.shortcuts.plus/all?limit=25&offset=0` — paginated list (maximum 100 per request).
- `GET https://posts.shortcuts.plus/1` — retrieve post ID 1.

Each post includes `id`, `name`, `content`, `content_type`, `date`, `time`, `timezone` (always `UTC`), `created_at`, `poster`, and `url`. The list response also includes pagination metadata and its sort order.

## Test

`POST https://api.shortcuts.plus/get-website` with JSON body `{ "url": "https://example.com" }`
