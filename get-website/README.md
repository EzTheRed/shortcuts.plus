# Shortcuts Plus Dynamic Page API

Cloudflare Worker base URL: `https://api.shortcuts.plus`

## Endpoints

### 1. Load a webpage

`GET /get-website?url=<URL-encoded-public-http-or-https-url>`

Returns a JSON dictionary:

- `file`: packaged HTML string to save as an `.html` file and preview with Quick Look.
- `dynamic`: native Shortcuts interaction definitions extracted from links and GET forms.
- `metadata`: title, source URL, asset counts, and generation time.
- `instructions`: how to submit an action.

Example shape:

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
  "metadata": { "title": "Example", "source": "https://example.com/", "version": 1 }
}
```

### 2. Submit a native interaction

`POST /action` with JSON:

```json
{
  "url": "https://example.com/",
  "actionId": "form_1",
  "values": { "q": "hello world" }
}
```

For a link, send its `link_N` id and omit `values`. For a form, send the `form_N` id and a `values` dictionary keyed by each field's HTML `name`. The Worker re-fetches the current page, validates that the action still exists, follows the selected link or submits the GET form, and returns the same JSON response shape for the next page. Same-origin linked pages may already be cached from background preloading, so selecting one can return much faster.


### 3. Generate a vCard menu file

`POST /vcf-menu` with a JSON object. Each property name becomes a contact title, and its string value becomes the subtitle:

```json
{
  "title": "description",
  "Item 1": "An item.",
  "Item 2": "Another item."
}
```

Send the object as the raw JSON request body with `Content-Type: application/json`. Returns one downloadable `shortcuts-menu.vcf` file containing one separate vCard contact per object property, in the same order. Each property name is written to both the `FN` (formatted name) and `N` (name) properties; its value is written to `ORG` (company). Text properties use `CHARSET=UTF-8`. Each contact also gets a `NOTE` identifier (`item_1`, `item_2`, and so on) so Shortcuts can distinguish duplicate titles. Contacts are separated by a blank line. A valid 1×1 transparent PNG is embedded in the `PHOTO` property to suppress the default initials/monogram avatar in contact views that honor the photo; it is not a visible picture.

## Suggested Apple Shortcuts flow

1. Ask for or receive the starting URL.
2. Use **Get Contents of URL** with `/get-website?url=` plus the URL-encoded starting URL.
3. Use **Get Dictionary from Input** on the response.
4. Get the `file` value, save it with an `.html` extension, and use **Quick Look** to preview it.
5. Get the `dynamic` array. Use **Choose from List** with the item labels.
6. Branch on the chosen item's `type`:
   - `link`: submit its `id` to `POST /action`.
   - `form`: ask for each listed field using native Shortcuts actions, build a `values` dictionary, then submit.
7. Parse the returned dictionary and repeat from step 4.

Shortcuts does not receive a callback from Quick Look when an HTML element is tapped. Native menus and prompts are the interaction surface; Quick Look is the display surface.

## Packaging behavior and limitations

The packager inlines linked stylesheets, nested CSS imports (limited depth), external classic script files, and rewrites CSS URLs to absolute URLs. It injects a base URL so remaining relative resources can resolve.

It does not execute JavaScript or render the page in Chromium. Preloading is deliberately limited to four same-origin links per page; it does not recursively crawl the whole site. Cache entries are opportunistic and may not be shared between Cloudflare data centers. It cannot reliably discover actions implemented only by JavaScript, buttons with no ordinary link/form behavior, dynamically created controls, or forms using POST. The interaction extractor currently exposes ordinary links and GET forms only. Some sites may require cookies, authentication, anti-bot challenges, or browser execution and therefore may not work.

The Worker accepts only public HTTP/HTTPS destinations, blocks local/private/reserved hosts, validates redirects, and does not forward user cookies or credentials. HTML is limited to 2 MB; each fetched CSS/JS resource to 1 MB; aggregate CSS/JS to 4 MB; and no more than 24 external CSS/JS resources are fetched. Images, fonts, video, and other binary media remain external.

## Test

`https://api.shortcuts.plus/get-website?url=https%3A%2F%2Fexample.com`
