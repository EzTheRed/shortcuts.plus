import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import worker from "../registry/worker.mjs";

const rows = [
  { shortcut: "webportal-plus", name: "WebPortal+", version: "1.1", description: "Browse the web.", download: "https://www.icloud.com/shortcuts/example", updated: "2026-11-09", active: 1, metadata_json: JSON.stringify({ category: ["Featured", "Web"], source: "EzTheRed", success: false }) },
  { shortcut: "new-shortcut", name: "New Shortcut", version: "2.0", description: "Only in the registry.", download: "https://www.icloud.com/shortcuts/new", updated: "2026-11-10", active: 1, metadata_json: "{}" },
  { shortcut: "retired", name: "Retired", active: 0, metadata_json: "{}" }
];

function environment(records = rows) {
  return { DB: { prepare(sql) {
    assert.match(sql, /WHERE .*active=1/);
    return {
      async all() {
        return { results: records.filter(row => row.active === 1).sort((a, b) => a.shortcut.localeCompare(b.shortcut)) };
      },
      bind(shortcut) {
        assert.match(sql, /shortcut=\?/);
        return { async first() { return records.find(row => row.active === 1 && row.shortcut === shortcut) ?? null; } };
      }
    };
  } } };
}

const lookup = (path, body, env = environment()) => worker.fetch(new Request(`https://s.shortcuts.plus${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
}), env);

test("catalog returns every active entry and supports GET and POST", async () => {
  for (const method of ["GET", "POST"]) {
    const response = await worker.fetch(new Request("https://s.shortcuts.plus/all", { method }), environment());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const data = await response.json();
    assert.equal(data.success, true);
    assert.deepEqual(data.shortcuts.map(item => item.shortcut), ["new-shortcut", "webportal-plus"]);
    assert.ok(data.shortcuts.every(item => !("metadata_json" in item) && !("active" in item)));
  }
  const empty = await worker.fetch(new Request("https://s.shortcuts.plus/all"), environment([]));
  assert.deepEqual(await empty.json(), { success: true, shortcuts: [] });
});

test("version selector, all details, alias, and existing root lookups", async () => {
  for (const path of ["/details", "/detail", "/"]) {
    const version = await lookup(path, { details: "version", shortcut: "webportal-plus" });
    assert.deepEqual(await version.json(), { success: true, shortcut: "webportal-plus", version: "1.1" });
    const all = await lookup(path, { details: "all", shortcut: "webportal-plus" });
    const data = await all.json();
    assert.equal(data.success, true);
    assert.equal(data.download, rows[0].download);
    assert.deepEqual(data.category, ["Featured", "Web"]);
  }
  const legacy = await lookup("/", { shortcut: "webportal-plus" });
  assert.equal((await legacy.json()).version, "1.1");
});

test("invalid requests, unknown and inactive shortcuts return useful errors", async () => {
  for (const shortcut of ["missing", "retired", "' OR 1=1 --"]) {
    assert.equal((await lookup("/details", { shortcut })).status, 404);
  }
  for (const body of [null, [], {}, { shortcut: "" }, { shortcut: 1 }, { shortcut: " ".repeat(4) }]) {
    assert.equal((await lookup("/details", body)).status, 400);
  }
  assert.equal((await lookup("/details", { shortcut: "webportal-plus", details: "private" })).status, 400);
  assert.equal((await lookup("/details", { shortcut: "x".repeat(121) })).status, 400);
  assert.equal((await lookup("/details", { shortcut: "x".repeat(4096) })).status, 413);
  const broken = await worker.fetch(new Request("https://s.shortcuts.plus/details", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), environment());
  assert.equal(broken.status, 400);
  const type = await worker.fetch(new Request("https://s.shortcuts.plus/details", { method: "POST", body: "{}" }), environment());
  assert.equal(type.status, 415);
  const preflight = await worker.fetch(new Request("https://s.shortcuts.plus/details", { method: "OPTIONS" }), environment());
  assert.equal(preflight.status, 204);
});

function client(records = rows) {
  const calls = [];
  const context = vm.createContext({ window: {}, document: {}, URL, AbortSignal, console, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url === "https://shortcuts.plus/data/shortcuts.json") return Response.json([{ id: "webportal-plus", title: "Legacy" }]);
    return worker.fetch(new Request(url, options), environment(records));
  } });
  vm.runInContext(readFileSync(new URL("../assets/js/app.js", import.meta.url), "utf8"), context);
  return { app: context.window.ShortcutsApp, calls };
}

test("browser library uses one API request and includes registry-only shortcuts", async () => {
  const { app, calls } = client();
  const items = await app.getItems();
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "New Shortcut");
  assert.equal(items[1].link, rows[0].download);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://s.shortcuts.plus/all");
  assert.equal(app.fullURL(items[1]), "https://shortcuts.plus/full.html?shortcut=webportal-plus");
});

test("browser details and update checks use the selected detail API; old URLs keep their identity", async () => {
  const { app, calls } = client();
  const item = await app.getItem("webportal-plus");
  assert.equal(item.title, "WebPortal+");
  assert.equal(await app.getVersion("webportal-plus"), "1.1");
  assert.equal(calls[0].url, "https://s.shortcuts.plus/details");
  assert.equal(JSON.parse(calls[0].options.body).details, "all");
  assert.equal(JSON.parse(calls[1].options.body).details, "version");
  assert.equal((await app.getLegacyItem(0)).id, "webportal-plus");
  await assert.rejects(app.getItem("missing"), /No active shortcut/);
});

test("browser rejects unsafe download links and preserves shortcuts with identical links", async () => {
  const { app } = client();
  const items = app.normalize([
    { shortcut: "one", name: "One", download: "javascript:alert(1)" },
    { shortcut: "two", name: "Two", download: "https://www.icloud.com/shortcuts/shared" },
    { shortcut: "three", name: "Three", download: "https://www.icloud.com/shortcuts/shared" }
  ]);
  assert.equal(items.length, 3);
  assert.equal(items[0].link, "");
});
