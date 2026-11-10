import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
async function requestCatalog(records, registry) {
  const cached = new Map();
  const sandbox = {
    Response, Request, URL, TextEncoder, TextDecoder, crypto: webcrypto, atob, btoa,
    caches: { default: {
      match: async key => cached.get(key.url)?.clone(),
      put: async (key, response) => cached.set(key.url, response)
    } },
    fetch: async (url, options) => {
      if (String(url) === 'https://shortcuts.plus/') return new Response('<title>Home</title>', { headers: { 'content-type': 'text/html' } });
      if (String(url).endsWith('/data/shortcuts.json')) return Response.json(records);
      if (String(url) === 'https://s.shortcuts.plus/') return registry(JSON.parse(options.body).shortcut);
      throw new Error('Unexpected request: ' + url);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('export default {', 'globalThis.worker = {'), sandbox);
  const env = { AUTH_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'test' }) }) }) } };
  const response = await sandbox.worker.fetch(new Request('https://api.shortcuts.plus/get-website', {
    method: 'POST', headers: { authorization: 'Basic ' + btoa('get-website:test') },
    body: JSON.stringify({ url: 'https://shortcuts.plus/' })
  }), env, {});
  assert.equal(response.status, 200);
  return response.json();
}

test('resolves every ID-only shortcut, including records beyond 60', async () => {
  const records = Array.from({ length: 75 }, (_, i) => ({ id: `shortcut-${i}`, title: `Shortcut ${i}`, category: ['Utilities'] }));
  const result = await requestCatalog(records, id => Response.json({ success: true, name: id, download: `https://www.icloud.com/shortcuts/${id}` }));
  assert.equal(result.metadata.shortcutCount, 75);
  assert.equal((result.file.match(/class="project-card"/g) || []).length, 75);
  assert.equal(result.dynamic.length, 76); // Home plus every shortcut.
  assert.ok(result.dynamic.some(item => item.target.endsWith('/shortcut-74') && item.label === 'shortcut-74'));
  assert.ok(!result.file.includes('<script'));
  assert.ok(result.file.includes('75</span>'));
});

test('keeps entries visible on registry failure, escapes text, rejects unsafe download URLs', async () => {
  const result = await requestCatalog([
    { id: 'offline', title: '<img src=x onerror=alert(1)>', desc: '<script>bad</script>' },
    { title: 'Legacy', link: 'https://www.icloud.com/shortcuts/legacy' },
    { id: 'unsafe', title: 'Unsafe' }, null
  ], id => {
    if (id === 'offline') throw new Error('Offline');
    return Response.json({ success: true, download: 'javascript:alert(1)' });
  });
  assert.equal(result.metadata.shortcutCount, 3);
  assert.ok(result.file.includes('&lt;img'));
  assert.ok(!result.file.includes('href="javascript:'));
  assert.ok(result.dynamic.some(item => item.target === 'https://shortcuts.plus/full.html?s=0'));
  assert.ok(result.dynamic.some(item => item.target.endsWith('/legacy')));
});
