# Shortcuts+ registry

The public catalog and shortcut details live in the existing `shortcuts-registry`
Worker and its `DB` D1 binding. Website pages read this API directly; adding an
active registry entry makes it available in the website library without editing
`data/shortcuts.json`.

| Request | Response |
| --- | --- |
| `GET https://s.shortcuts.plus/all` | `{ "success": true, "shortcuts": [...] }`, every active shortcut sorted by identifier |
| `POST https://s.shortcuts.plus/details` | Details selected by the JSON body below |
| `POST https://s.shortcuts.plus/detail` | Alias of `/details` |
| `POST https://s.shortcuts.plus/` | Existing lookup, defaults to all details |

```json
{ "details": "version", "shortcut": "webportal-plus" }
```

```json
{ "success": true, "shortcut": "webportal-plus", "version": "1.1" }
```

Use `"details":"all"` to return name, description, version, download, updated,
and public metadata such as categories. Identifiers are case-sensitive. Unknown
or inactive shortcuts return 404. Invalid details selectors return 400.
Lookup requests require `Content-Type: application/json` and at most 4096 bytes.
CORS permits browser GET, POST, and OPTIONS requests without credentials.
`POST /all` also returns the catalog for Shortcuts clients that use POST.

New website detail links use `full.html?shortcut=<identifier>`, so catalog order
does not affect links. Old `full.html?s=<index>` links still resolve through the
legacy `data/shortcuts.json` file; retain that file for these links and existing
consumers.

Run `node --test test/*.test.mjs` from the repository root. The tests use a mock
D1 binding and exercise the actual browser client against the registry handler.
Deploy `worker.mjs` to the existing `shortcuts-registry` Worker, preserving its
`DB` binding, compatibility settings, observability, and zone route. Deploy the
registry before the website assets.
