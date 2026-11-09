# Shortcuts Plus Page Packager

Cloudflare Worker endpoint:

`https://api.shortcuts.plus/get-website?url=https%3A%2F%2Fexample.com`

The endpoint returns a single HTML document intended to be saved locally as an `.html` file.

## What it packages

- Original HTML markup.
- Linked stylesheets (`<link rel="stylesheet">`) fetched and inlined as `<style>`.
- CSS `@import` rules, with a limited import depth.
- External JavaScript `<script src="...">` resources inlined into their script elements.
- Relative CSS `url(...)` references are rewritten to absolute URLs.
- A `<base>` element is added so remaining relative links and media resolve against the final webpage URL.

## Important limitations

This is a server-side source packager, not a browser renderer. It does not execute page JavaScript, run a login session, capture content created only after scripts run, or guarantee that every website can be reconstructed. JavaScript module imports may still load additional resources. Images, video, fonts, and other binary media remain external (they are not embedded as data in the HTML file). Some sites block automated requests or require cookies, headers, or authentication.

For safety and resource control, the service accepts only public HTTP/HTTPS URLs, does not forward your cookies or credentials, limits the HTML to 2 MB, each fetched CSS/JS resource to 1 MB, aggregate CSS/JS to 4 MB, and fetches at most 24 external CSS/JS resources. Only GET and OPTIONS are supported.

## Test

Use:

`https://api.shortcuts.plus/get-website?url=https%3A%2F%2Fexample.com`

The response is HTML with a download filename of `shortcuts-page.html`. In Apple Shortcuts, use **Get Contents of URL**, then save the returned content as an HTML file. Quick Look can preview the saved file, subject to iOS's local-file rendering limitations.
