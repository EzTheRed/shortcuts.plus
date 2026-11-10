# Shortcuts Plus Website API

Cloudflare Worker base URL: `https://api.shortcuts.plus`

## Endpoints

### 1. Get a webpage

`GET /get-website?url=<URL-encoded-public-http-or-https-url>`

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

To follow a link, have Shortcuts request `/get-website` again using that item's `target` as the URL parameter. For a GET form, collect the listed field values in Shortcuts, add them to the form's `target` as URL query parameters using each field's `name`, then request `/get-website` with the resulting URL. The API itself does not receive interaction selections or submit forms.

### 2. Generate a vCard menu file

`GET /vcf-menu?data=<URL-encoded-JSON>`

Pass a URL-encoded JSON object in the `data` query parameter. Each property name becomes a contact title, and its string value becomes the subtitle:

```json
{
  "title": "description",
  "Item 1": "An item.",
  "Item 2": "Another item."
}
```

For Apple Shortcuts, use **URL Encode** on the JSON text, then append the result to:

```text
https://api.shortcuts.plus/vcf-menu?data=
```

Use **Get Contents of URL** with method **GET**. No request body or headers are needed. The endpoint is GET-only; POST is not supported. Keep the JSON compact because URL length limits apply. Returns one downloadable `shortcuts-menu.vcf` file containing one separate vCard contact per object property, in the same order.

## Suggested Apple Shortcuts flow

1. Ask for or receive the starting URL.
2. Use **URL Encode** on the URL.
3. Use **Get Contents of URL** with `https://api.shortcuts.plus/get-website?url=` followed by the encoded URL.
4. Use **Get Dictionary from Input** on the response.
5. Get the `file` value, save it with an `.html` extension, and use **Quick Look** to preview it.
6. Get the `dynamic` array and use **Choose from List** with the item labels.
7. When a link is chosen, use its `target` to call `/get-website` again. For a GET form, ask for the listed field values, build the target URL with those values as query parameters, and call `/get-website` again.
8. Repeat the display and selection steps for the returned page.

Shortcuts handles choices and form prompts natively. Quick Look is only the display surface: it does not send a callback when an HTML element is tapped.

## Preloading and packaging behavior

The Worker packages the requested page and preloads up to four unique same-origin links in the background. Those pages are cached opportunistically, so a later `/get-website` request for one of them may be faster. The `dynamic` array is also included in the initial response so Shortcuts can build its menus and prompts without first making another request to discover the links and form fields. Preloading is limited; it does not recursively crawl the entire site.

The packager inlines linked stylesheets, nested CSS imports (limited depth), and external classic script files, and rewrites CSS URLs to absolute URLs. It injects a base URL so remaining relative resources can resolve.

It does not execute JavaScript or render the page in Chromium. It cannot reliably discover actions implemented only by JavaScript, buttons with no ordinary link/form behavior, dynamically created controls, or forms using POST. The interaction extractor exposes ordinary links and GET forms only. Some sites may require cookies, authentication, anti-bot challenges, or browser execution and therefore may not work.

The Worker accepts only public HTTP/HTTPS destinations, blocks local/private/reserved hosts, validates redirects, and does not forward user cookies or credentials. HTML is limited to 2 MB; each fetched CSS/JS resource to 1 MB; aggregate CSS/JS to 4 MB; and no more than 24 external CSS/JS resources are fetched. Images, fonts, video, and other binary media remain external.

## Test

`https://api.shortcuts.plus/get-website?url=https%3A%2F%2Fexample.com`
