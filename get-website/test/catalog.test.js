import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

function createWorker(fetch, bindings = {}) {
  const cached = new Map();
  const usedTokens = new Set();
  const sandbox = {
    Response, Request, URL, TextEncoder, TextDecoder, crypto: webcrypto, atob, btoa,
    caches: { default: {
      match: async key => cached.get(key.url)?.clone(),
      put: async (key, response) => cached.set(key.url, response.clone())
    } },
    fetch
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('export default {', 'globalThis.worker = {'), sandbox);
  const env = { ...bindings, AUTH_DB: { prepare: () => ({ bind: (_now, tokenHash) => ({
    first: async () => {
      if (usedTokens.has(tokenHash)) return null;
      usedTokens.add(tokenHash);
      return { id: 'test' };
    }
  }) }) } };
  let tokenNumber = 0;
  return (url, { authorization = 'Basic ' + btoa(`get-website:test-${++tokenNumber}`) } = {}) =>
    sandbox.worker.fetch(new Request('https://api.shortcuts.plus/get-website', {
      method: 'POST', headers: authorization ? { authorization } : {},
      body: JSON.stringify({ url })
    }), env, {
      waitUntil: () => { assert.fail('Page packaging must not schedule link preloading'); }
    });
}

async function requestCatalog(records, registry) {
  const request = createWorker(async (url, options) => {
    if (String(url) === 'https://shortcuts.plus/') return new Response('<title>Home</title>', { headers: { 'content-type': 'text/html' } });
    if (String(url).endsWith('/data/shortcuts.json')) return Response.json(records);
    if (String(url) === 'https://s.shortcuts.plus/') return registry(JSON.parse(options.body).shortcut);
    throw new Error('Unexpected request: ' + url);
  });
  const response = await request('https://shortcuts.plus/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="webpage.html"');
  return response.text();
}

test('returns an HTML file containing every ID-only shortcut, including records beyond 60', async () => {
  const records = Array.from({ length: 75 }, (_, i) => ({ id: `shortcut-${i}`, title: `Shortcut ${i}`, category: ['Utilities'] }));
  const html = await requestCatalog(records, id => Response.json({ success: true, name: id, download: `https://www.icloud.com/shortcuts/${id}` }));
  assert.match(html, /^<!doctype html>/i);
  assert.equal((html.match(/class="project-card"/g) || []).length, 75);
  assert.ok(html.includes('href="https://www.icloud.com/shortcuts/shortcut-74"'));
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('75</span>'));
});

test('keeps entries visible on registry failure, escapes text, rejects unsafe download URLs', async () => {
  const html = await requestCatalog([
    { id: 'offline', title: '<img src=x onerror=alert(1)>', desc: '<script>bad</script>' },
    { title: 'Legacy', link: 'https://www.icloud.com/shortcuts/legacy' },
    { id: 'unsafe', title: 'Unsafe' }, null
  ], id => {
    if (id === 'offline') throw new Error('Offline');
    return Response.json({ success: true, download: 'javascript:alert(1)' });
  });
  assert.equal((html.match(/class="project-card"/g) || []).length, 3);
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('href="https://shortcuts.plus/full.html?s=0"'));
  assert.ok(html.includes('href="https://www.icloud.com/shortcuts/legacy"'));
});

test('returns only packaged HTML, inlines assets, caches the result, and never preloads links or forms', async () => {
  const calls = [];
  const request = createWorker(async url => {
    calls.push(String(url));
    if (String(url) === 'https://example.com/page') return new Response(
      '<!doctype html><html><head><title>Example</title><link rel="stylesheet" href="/styles.css"><script src="/app.js" defer></script></head><body><a href="/next">Next page</a><form action="/search" method="GET"><input name="q"></form></body></html>',
      { headers: { 'content-type': 'text/html' } }
    );
    if (String(url) === 'https://example.com/styles.css') return new Response('body{background:url("/image.png")}', { headers: { 'content-type': 'text/css' } });
    if (String(url) === 'https://example.com/app.js') return new Response('window.packaged = true;', { headers: { 'content-type': 'text/javascript' } });
    throw new Error('Unexpected request: ' + url);
  });
  const first = await request('https://example.com/page');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(first.headers.get('content-disposition'), 'attachment; filename="webpage.html"');
  const html = await first.text();
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('<base href="https://example.com/page">'));
  assert.ok(html.includes('<style data-inlined-from="https://example.com/styles.css">'));
  assert.ok(html.includes('url("https://example.com/image.png")'));
  assert.ok(html.includes('data-inlined-from="https://example.com/app.js"'));
  assert.ok(html.includes('window.packaged = true;'));
  assert.ok(!html.includes('src="/app.js"'));
  assert.deepEqual(calls, ['https://example.com/page', 'https://example.com/styles.css', 'https://example.com/app.js']);

  const second = await request('https://example.com/page');
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await second.text(), html);
  assert.equal(calls.length, 3, 'Cache hit should avoid all upstream requests');

  const unauthorized = await request('https://example.com/page', { authorization: null });
  assert.equal(unauthorized.status, 401, 'A cache hit must still require authentication');
  assert.match(unauthorized.headers.get('content-type'), /^application\/json/);
  assert.equal(calls.length, 3);
});

test('keeps validation errors as JSON rather than downloadable HTML', async () => {
  const request = createWorker(async () => assert.fail('Invalid URLs must not fetch upstream'));
  const response = await request('http://localhost/private');
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.ok((await response.json()).error);
  assert.equal(response.headers.get('content-disposition'), null);
});


test('resolves downloads through the registry service binding instead of a blocked same-zone fetch', async () => {
  const globalCalls = [];
  let registryCalls = 0;
  const request = createWorker(async url => {
    globalCalls.push(String(url));
    if (String(url) === 'https://shortcuts.plus/') return new Response('<title>Home</title>', { headers: { 'content-type': 'text/html' } });
    if (String(url) === 'https://shortcuts.plus/data/shortcuts.json') return Response.json([{ id: 'webportal-plus', title: 'WebPortal+' }]);
    throw new Error('Same-zone registry requests are unavailable through global fetch');
  }, {
    REGISTRY: { fetch: async request => {
      registryCalls++;
      assert.equal(request.url, 'https://s.shortcuts.plus/');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('content-type'), 'application/json');
      assert.deepEqual(await request.json(), { shortcut: 'webportal-plus' });
      return Response.json({ success: true, name: 'WebPortal+', download: 'https://www.icloud.com/shortcuts/webportal' });
    } }
  });
  const response = await request('https://shortcuts.plus/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await response.text();
  assert.ok(html.includes('href="https://www.icloud.com/shortcuts/webportal"'));
  assert.ok(!html.includes('href="https://shortcuts.plus/full.html?s=0"'));
  assert.equal(registryCalls, 1);
  assert.deepEqual(globalCalls, ['https://shortcuts.plus/', 'https://shortcuts.plus/data/shortcuts.json']);
});
