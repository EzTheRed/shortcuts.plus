import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

function createWorker({ run, missingAI = false } = {}) {
  const tokens = new Map();
  const calls = [];
  let now = Date.UTC(2026, 10, 10, 12);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const sandbox = {
    Response, Request, URL, TextEncoder, TextDecoder, ReadableStream,
    Uint8Array, Date: Clock, crypto: webcrypto, atob, btoa,
    console: { log() {}, error() {}, warn() {} },
    fetch: async () => assert.fail('AI must use the binding, without web requests or provider fallbacks'),
    caches: { default: {
      match: async () => assert.fail('AI replies must not use a shared cache'),
      put: async () => assert.fail('AI replies must not be stored in a shared cache')
    } }
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('export default {', 'globalThis.worker = {'), sandbox);
  const env = {
    AUTH_DB: { prepare(sql) {
      assert.match(sql, /^(INSERT INTO auth_tokens|UPDATE auth_tokens)/);
      return { bind(...args) {
        if (sql.startsWith('INSERT')) return { async run() {
          const [id, hash, name, identity, scope, issuedAt, expiresAt, type] = args;
          tokens.set(hash, { id, name, identity, scope, issuedAt, expiresAt, type, usedAt: null, revoked: false });
          return { success: true };
        } };
        return { async first() {
          const [usedAt, hash, scope, type, checkedAt] = args;
          const row = tokens.get(hash);
          if (!row || row.scope !== scope || row.type !== type || row.expiresAt <= checkedAt || row.usedAt !== null || row.revoked) return null;
          row.usedAt = usedAt;
          return { id: row.id };
        } };
      } };
    } }
  };
  if (!missingAI) env.AI = { async run(model, input) {
    calls.push(JSON.parse(JSON.stringify({ model, input })));
    return run ? run(model, input) : { choices: [{ message: {
      content: JSON.stringify([{ type: 'text', contents: 'A helpful answer.' }])
    } }] };
  } };
  const dispatch = request => sandbox.worker.fetch(request, env, {
    waitUntil: () => assert.fail('AI must not schedule storage or background work')
  });
  async function issue(api = 'ai') {
    const response = await dispatch(new Request('https://api.shortcuts.plus/auth', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api })
    }));
    assert.equal(response.status, 200, 'AI must be an accepted /auth scope');
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    return response.text();
  }
  async function request(payload, options = {}) {
    const authorization = options.authorization === undefined ? await issue() : options.authorization;
    const headers = new Headers({ 'content-type': 'application/json', ...options.headers });
    if (authorization !== null) headers.set('authorization', authorization);
    const body = options.rawBody === undefined ? JSON.stringify(payload) : options.rawBody;
    return dispatch(new Request('https://api.shortcuts.plus/ai', {
      method: 'POST', headers, body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {})
    }));
  }
  return { issue, request, dispatch, calls, tokens, advance: milliseconds => { now += milliseconds; } };
}

test('issues an AI-scoped ten-second token and returns a stateless JSON content array', async () => {
  const worker = createWorker();
  const authorization = await worker.issue();
  assert.equal(atob(authorization.slice('Basic '.length)).split(':')[0], 'ai');
  const token = [...worker.tokens.values()][0];
  assert.equal(token.expiresAt - token.issuedAt, 10);
  const response = await worker.request({ prompt: '  What does shortcuts.plus do?  ' }, { authorization });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await response.json(), [{ type: 'text', contents: 'A helpful answer.' }]);
  const { model, input } = worker.calls[0];
  assert.equal(model, '@cf/google/gemma-4-26b-a4b-it');
  assert.equal(input.max_completion_tokens, 512);
  assert.equal(input.stream, false);
  assert.equal(input.store, false);
  assert.equal(input.chat_template_kwargs.enable_thinking, false);
  assert.equal(input.response_format.type, 'json_schema');
  assert.equal(input.response_format.json_schema.strict, true);
  const schema = input.response_format.json_schema.schema;
  assert.equal(schema.type, 'array');
  assert.equal(schema.minItems, 1);
  assert.equal(schema.maxItems, 16);
  assert.equal(schema.items.type, 'object');
  assert.equal(schema.items.additionalProperties, false);
  assert.deepEqual(schema.items.required.slice().sort(), ['contents', 'type']);
  assert.deepEqual(schema.items.properties.type.enum, ['text']);
  assert.equal(input.messages.length, 2);
  assert.equal(input.messages[0].role, 'system');
  assert.match(input.messages[0].content, /shortcuts\.plus/i);
  assert.deepEqual(input.messages[1], { role: 'user', content: 'What does shortcuts.plus do?' });

  await worker.request({ prompt: 'Tell me a joke.' });
  assert.equal(worker.calls.length, 2);
  assert.equal(worker.calls[1].input.messages.length, 2);
  assert.equal(worker.calls[1].input.messages[1].content, 'Tell me a joke.');
  assert.ok(!JSON.stringify(worker.calls[1]).includes('What does shortcuts.plus do?'));
});

test('preserves ordered text blocks, multiline contents, and code without treating types as extensions', async () => {
  const blocks = [
    { type: 'text', contents: '  Here is the page:\n' },
    { type: 'text', contents: '<!doctype html>\n<html>\n<script>console.log("hello");</script>\n</html>\n' },
    { type: 'text', contents: '{\n  "message": "Hello 😀",\n  "number": 42\n}\n' },
    { type: 'text', contents: 'const answer = 42;\nconsole.log(answer);\n' },
    { type: 'text', contents: 'The incomplete JSON fragment is {invalid' }
  ];
  const worker = createWorker({ run: async () => ({ choices: [{ message: { content: JSON.stringify(blocks) } }] }) });
  const response = await worker.request({ prompt: 'Create a webpage and explain it.' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, blocks, 'Block order, category, whitespace, and content must survive unchanged');
  for (const block of result) assert.deepEqual(Object.keys(block).sort(), ['contents', 'type']);
});

test('rejects invalid content arrays and unsupported media without stripping fields, retrying, or falling back', async () => {
  const invalid = [
    'not JSON',
    '```json\n[{"type":"text","contents":"hello"}]\n```',
    JSON.stringify({ type: 'text', contents: 'hello' }),
    'null',
    '[]',
    JSON.stringify(Array.from({ length: 17 }, () => ({ type: 'text', contents: 'hello' }))),
    '[null]',
    JSON.stringify([{ type: 'text', contents: 'hello', title: 'extra' }]),
    JSON.stringify([{ type: 'image', contents: 'https://example.com/image.png' }]),
    JSON.stringify([{ type: 'audio', contents: 'https://example.com/audio.mp3' }]),
    JSON.stringify([{ type: '.txt', contents: 'hello' }]),
    JSON.stringify([{ type: '.mp3', contents: 'audio' }]),
    JSON.stringify([{ type: '.tiff', contents: 'image' }]),
    JSON.stringify([{ type: 'txt', contents: 'hello' }]),
    JSON.stringify([{ type: '.HTML', contents: '<html></html>' }]),
    JSON.stringify([{ type: 42, contents: 'hello' }]),
    JSON.stringify([{ type: 'text', contents: null }]),
    JSON.stringify([{ type: 'text', contents: {} }]),
    JSON.stringify([{ type: 'text', contents: '' }]),
    JSON.stringify([{ type: 'text' }]),
    JSON.stringify([{ contents: 'hello' }])
  ];
  for (const content of invalid) {
    const worker = createWorker({ run: async () => ({ choices: [{ message: { content } }] }) });
    const response = await worker.request({ prompt: 'hello' });
    assert.equal(response.status, 503, content);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal(worker.calls.length, 1, 'Invalid output must not trigger another model request');
  }
  const blocks = Array.from({ length: 16 }, (_, i) => ({ type: 'text', contents: `Part ${i + 1}` }));
  const worker = createWorker({ run: async () => ({ choices: [{ message: { content: JSON.stringify(blocks) } }] }) });
  const response = await worker.request({ prompt: 'hello' });
  assert.equal(response.status, 200, 'The documented upper bound of sixteen blocks must be accepted');
  assert.deepEqual(await response.json(), blocks);
});

test('rejects absent, expired, wrong-scope, and replayed tokens before inference', async () => {
  const worker = createWorker();
  assert.equal((await worker.request({ prompt: 'Hello' }, { authorization: null })).status, 401);
  const wrongScope = await worker.issue('get-website');
  assert.equal((await worker.request({ prompt: 'Hello' }, { authorization: wrongScope })).status, 401);
  const expired = await worker.issue();
  worker.advance(10_000);
  assert.equal((await worker.request({ prompt: 'Hello' }, { authorization: expired })).status, 401);
  const singleUse = await worker.issue();
  const responses = await Promise.all([
    worker.request({ prompt: 'Hello' }, { authorization: singleUse }),
    worker.request({ prompt: 'Hello' }, { authorization: singleUse })
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
  assert.equal(worker.calls.length, 1, 'One token must authorize at most one inference even under concurrent use');
});

test('counts 250 Unicode code points after trimming and rejects longer prompts', async () => {
  const worker = createWorker();
  assert.equal((await worker.request({ prompt: '  ' + '😀'.repeat(250) + '\n' })).status, 200);
  assert.equal(worker.calls[0].input.messages[1].content, '😀'.repeat(250));
  assert.equal((await worker.request({ prompt: '😀'.repeat(251) })).status, 400);
  assert.equal((await worker.request({ prompt: 'a'.repeat(251) })).status, 400);
  assert.equal(worker.calls.length, 1);
});

test('rejects invalid JSON, non-text inputs, history, and model overrides without inference', async () => {
  const worker = createWorker();
  for (const payload of [null, [], 'hello', {}, { prompt: '' }, { prompt: '\n  ' },
    { prompt: 42 }, { prompt: ['hello'] }, { prompt: 'hello', history: [] },
    { prompt: 'hello', model: '@cf/another/model' }, { prompt: 'hello', messages: [] }]) {
    const response = await worker.request(payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal((await worker.request(null, { rawBody: '{' })).status, 400);
  assert.equal((await worker.request({ prompt: 'hello' }, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(worker.calls.length, 0);
});

test('bounds request bytes even when a streamed body omits Content-Length', async () => {
  const worker = createWorker();
  const encoder = new TextEncoder();
  const chunks = ['{"prompt":"hello"}', ' '.repeat(2500), ' '.repeat(2500)];
  const stream = new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(encoder.encode(chunks.shift()));
      else controller.close();
    }
  });
  const response = await worker.request(null, { rawBody: stream });
  assert.equal(response.status, 413);
  assert.equal(worker.calls.length, 0);
});

test('fails closed when the AI binding is absent or returns an empty or truncated answer', async () => {
  assert.equal((await createWorker({ missingAI: true }).request({ prompt: 'hello' })).status, 503);
  for (const result of [{}, { choices: [] }, { choices: [{ message: { content: null } }] },
    { choices: [{ message: { content: '   ' } }] },
    { choices: [{ finish_reason: 'length', message: { content: JSON.stringify([{ type: 'text', contents: 'Truncated' }]) } }] }]) {
    const worker = createWorker({ run: async () => result });
    const response = await worker.request({ prompt: 'hello' });
    assert.equal(response.status, 503);
    assert.equal(worker.calls.length, 1, 'Failures must not call a paid fallback or retry inference');
  }
});

test('reports the free daily quota as 429 with Retry-After and conceals provider errors', async () => {
  for (const error of [Object.assign(new Error('quota'), { code: 3036 }),
    new Error('AI_ERROR: 3036: Account has exceeded its daily free allocation'),
    Object.assign(new Error('limited'), { status: 429 })]) {
    const worker = createWorker({ run: async () => { throw error; } });
    const response = await worker.request({ prompt: 'hello' });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal(worker.calls.length, 1);
  }
  const worker = createWorker({ run: async () => { throw new Error('sensitive-provider-detail'); } });
  const response = await worker.request({ prompt: 'hello' });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('sensitive-provider-detail'));
});

test('advertises the AI endpoint and allows Shortcuts-compatible CORS preflight', async () => {
  const worker = createWorker();
  const directory = await worker.dispatch(new Request('https://api.shortcuts.plus/api'));
  assert.ok(JSON.parse(await directory.text()).includes('POST https://api.shortcuts.plus/ai'));
  const method = await worker.dispatch(new Request('https://api.shortcuts.plus/ai'));
  assert.equal(method.status, 405);
  const preflight = await worker.dispatch(new Request('https://api.shortcuts.plus/ai', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/i);
  assert.equal(worker.calls.length, 0);
});
