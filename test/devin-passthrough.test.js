/**
 * Devin Cloud REST passthrough — covers the /v1/devin/* mount in
 * handlers/devin-passthrough.js. Strategy mirrors devin-adapter.test.js:
 * stub the global `fetch` to a route table so the handler exercises its
 * full pipeline (path match → auth → body shaping → response stream)
 * without touching the network.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { config } from '../src/config.js';
import {
  handleDevinPassthrough,
  matchRoute,
  ALLOWED_ROUTES,
} from '../src/handlers/devin-passthrough.js';

const originalFetch = globalThis.fetch;
const originalDevinKey = config.devinApiKey;
const originalDevinBase = config.devinApiBase;

function installFetchStub(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = typeof url === 'string' ? url : url.url;
    const parsed = new URL(u);
    const method = (init.method || 'GET').toUpperCase();
    const key = `${method} ${parsed.pathname}`;
    calls.push({ url: u, method, init, headers: init.headers || {}, body: init.body });
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({ detail: `No stub for ${key}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handler({ url: u, init, parsed });
  };
  return calls;
}

function restoreFetch() { globalThis.fetch = originalFetch; }

// Lightweight stand-ins for Node's IncomingMessage / ServerResponse so
// we can drive handleDevinPassthrough without spinning up an http
// server per test. Only the shape the handler relies on is implemented.
function mockReq({ method = 'GET', url = '/v1/devin/sessions', headers = {}, body = null }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = lower;
  return stream;
}

function mockRes() {
  const chunks = [];
  let status = 0;
  let headers = {};
  const w = new Writable({
    write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  w.writeHead = (s, h) => { status = s; headers = { ...h }; };
  w.setHeader = (k, v) => { headers[k] = v; };
  w._status = () => status;
  w._headers = () => headers;
  w._body = () => Buffer.concat(chunks);
  w._json = () => {
    const txt = Buffer.concat(chunks).toString('utf-8');
    return txt ? JSON.parse(txt) : null;
  };
  // Override end so .writableEnded flips true the way the real Response does
  const origEnd = w.end.bind(w);
  w.end = (...args) => { origEnd(...args); };
  return w;
}

beforeEach(() => {
  config.devinApiKey = 'apk_test_passthrough';
  config.devinApiBase = 'https://api.devin.ai';
});

afterEach(() => {
  restoreFetch();
  config.devinApiKey = originalDevinKey;
  config.devinApiBase = originalDevinBase;
});

describe('matchRoute', () => {
  it('matches static and parametric session routes', () => {
    assert.deepEqual(matchRoute('GET', '/sessions'), { upstreamPath: '/v1/sessions', params: {} });
    assert.deepEqual(matchRoute('POST', '/sessions'), { upstreamPath: '/v1/sessions', params: {} });

    const got = matchRoute('GET', '/sessions/devin-abc');
    assert.deepEqual(got, { upstreamPath: '/v1/sessions/devin-abc', params: { id: 'devin-abc' } });

    const sendMsg = matchRoute('POST', '/sessions/devin-x/message');
    assert.deepEqual(sendMsg, { upstreamPath: '/v1/sessions/devin-x/message', params: { id: 'devin-x' } });

    const del = matchRoute('DELETE', '/sessions/devin-y');
    assert.deepEqual(del, { upstreamPath: '/v1/sessions/devin-y', params: { id: 'devin-y' } });
  });

  it('matches every method/path tuple in ALLOWED_ROUTES exactly once', () => {
    for (const [method, pattern] of ALLOWED_ROUTES) {
      const concrete = fillPattern(pattern);
      const got = matchRoute(method, concrete);
      assert.ok(got, `${method} ${concrete} should match`);
    }
  });

  it('rejects unknown paths and wrong methods', () => {
    assert.equal(matchRoute('PATCH', '/sessions'), null);          // wrong method
    assert.equal(matchRoute('GET', '/sessions/abc/extra'), null);  // extra segment
    assert.equal(matchRoute('GET', '/unknown'), null);
    assert.equal(matchRoute('POST', '/secrets/abc'), null);        // POST /secrets/:id not allowed
  });

  it('url-encodes path params so colons in devin ids pass through', () => {
    const got = matchRoute('GET', '/sessions/' + encodeURIComponent('devin-abc:xyz'));
    assert.ok(got);
    assert.match(got.upstreamPath, /devin-abc%3Axyz/);
  });

  it('routes /v3 organization paths to /v3/organizations/<org_id>/... upstream', () => {
    const create = matchRoute('POST', '/v3/organizations/org-abc/sessions');
    assert.deepEqual(create, { upstreamPath: '/v3/organizations/org-abc/sessions', params: { org_id: 'org-abc' } });

    const get = matchRoute('GET', '/v3/organizations/org-abc/sessions/devin-xyz');
    assert.deepEqual(get, {
      upstreamPath: '/v3/organizations/org-abc/sessions/devin-xyz',
      params: { org_id: 'org-abc', devin_id: 'devin-xyz' },
    });

    const msg = matchRoute('POST', '/v3/organizations/org-abc/sessions/devin-xyz/messages');
    assert.equal(msg.upstreamPath, '/v3/organizations/org-abc/sessions/devin-xyz/messages');

    const arch = matchRoute('POST', '/v3/organizations/org-abc/sessions/devin-xyz/archive');
    assert.equal(arch.upstreamPath, '/v3/organizations/org-abc/sessions/devin-xyz/archive');

    const insightsGen = matchRoute('POST', '/v3/organizations/org-abc/sessions/devin-xyz/insights/generate');
    assert.equal(insightsGen.upstreamPath, '/v3/organizations/org-abc/sessions/devin-xyz/insights/generate');
  });

  it('prefers the static /sessions/insights row over the :devin_id capture', () => {
    // Both rows have the same segment count (6) — the matcher must return
    // the static one because it is listed earlier in ALLOWED_ROUTES.
    const got = matchRoute('GET', '/v3/organizations/org-abc/sessions/insights');
    assert.deepEqual(got, { upstreamPath: '/v3/organizations/org-abc/sessions/insights', params: { org_id: 'org-abc' } });
  });

  it('routes /v3 enterprise + /v2 enterprise paths verbatim', () => {
    assert.deepEqual(matchRoute('GET', '/v3/enterprise/sessions'), { upstreamPath: '/v3/enterprise/sessions', params: {} });
    assert.deepEqual(matchRoute('GET', '/v3/enterprise/playbooks/pb-1'), { upstreamPath: '/v3/enterprise/playbooks/pb-1', params: { playbook_id: 'pb-1' } });

    assert.deepEqual(matchRoute('GET', '/v2/enterprise/audit-logs'), { upstreamPath: '/v2/enterprise/audit-logs', params: {} });
    assert.deepEqual(matchRoute('GET', '/v2/enterprise/consumption/cycles'), { upstreamPath: '/v2/enterprise/consumption/cycles', params: {} });

    // The static "members/organizations" row must win over the
    // /members/:member_id capture even though both have 4 segments.
    assert.deepEqual(matchRoute('GET', '/v2/enterprise/members/organizations'), { upstreamPath: '/v2/enterprise/members/organizations', params: {} });
    assert.deepEqual(matchRoute('GET', '/v2/enterprise/members/mem-1'), { upstreamPath: '/v2/enterprise/members/mem-1', params: { member_id: 'mem-1' } });

    // Bulk revoke (no key id) vs single revoke — same method, different segment count
    assert.deepEqual(matchRoute('DELETE', '/v2/enterprise/api-keys'), { upstreamPath: '/v2/enterprise/api-keys', params: {} });
    assert.deepEqual(matchRoute('DELETE', '/v2/enterprise/api-keys/key-9'), { upstreamPath: '/v2/enterprise/api-keys/key-9', params: { key_id: 'key-9' } });
  });
});

/**
 * Generate a concrete sample path for a route pattern by replacing every
 * `:name` placeholder with `sample-<name>`. The same substitution is
 * used on the upstream template so the walker test can validate that
 * the proxy forwards to the right URL regardless of how many path
 * params a route declares (the v1 list only uses `:id`, but the v3
 * list uses `:org_id`, `:devin_id`, `:note_id`, `:playbook_id`,
 * `:secret_id`, `:attachment_id`, `:user_id`, etc.).
 */
function fillPattern(input) {
  return input.replace(/(:|\$\{)(\w+)\}?/g, (_, _prefix, name) => `sample-${name}`);
}

describe('handleDevinPassthrough — auth + routing', () => {
  it('returns 503 when DEVIN_API_KEY is missing', async () => {
    config.devinApiKey = '';
    installFetchStub({});
    const req = mockReq({ method: 'GET', url: '/v1/devin/sessions' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 503);
    assert.equal(res._json().error.type, 'configuration_error');
  });

  it('returns 404 for an unknown sub-path', async () => {
    installFetchStub({});
    const req = mockReq({ method: 'GET', url: '/v1/devin/unknown' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 404);
    assert.equal(res._json().error.type, 'not_found');
  });

  it('returns 404 for an empty sub-path', async () => {
    installFetchStub({});
    const req = mockReq({ method: 'GET', url: '/v1/devin' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 404);
  });

  it('rejects an unsupported HTTP method with 404', async () => {
    installFetchStub({});
    const req = mockReq({ method: 'PATCH', url: '/v1/devin/sessions' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 404);
  });
});

describe('handleDevinPassthrough — body shaping', () => {
  it('forwards Bearer DEVIN_API_KEY and JSON body to the upstream URL', async () => {
    const calls = installFetchStub({
      'POST /v1/sessions': () => new Response(JSON.stringify({ session_id: 'devin-new' }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }),
    });
    const req = mockReq({
      method: 'POST',
      url: '/v1/devin/sessions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', max_acu_limit: 5 }),
    });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 201);
    assert.deepEqual(res._json(), { session_id: 'devin-new' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.devin.ai/v1/sessions');
    assert.equal(calls[0].headers.Authorization, 'Bearer apk_test_passthrough');
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    assert.equal(JSON.parse(calls[0].body).prompt, 'hi');
  });

  it('returns 400 on invalid JSON without hitting upstream', async () => {
    const calls = installFetchStub({});
    const req = mockReq({
      method: 'POST',
      url: '/v1/devin/sessions',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 400);
    assert.equal(res._json().error.type, 'invalid_request');
    assert.equal(calls.length, 0);
  });

  it('GET requests do not send a body and preserve the query string', async () => {
    const calls = installFetchStub({
      'GET /v1/sessions': () => new Response(JSON.stringify({ sessions: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    });
    const req = mockReq({ method: 'GET', url: '/v1/devin/sessions?limit=10&cursor=abc' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 200);
    assert.equal(calls[0].url, 'https://api.devin.ai/v1/sessions?limit=10&cursor=abc');
    assert.equal(calls[0].init.body, undefined);
  });

  it('multipart upload forwards the raw Content-Type and streams the body', async () => {
    const calls = installFetchStub({
      'POST /v1/attachments': async ({ init }) => {
        // Consume the streamed body so the test can assert it ran.
        let len = 0;
        if (init.body && typeof init.body.getReader === 'function') {
          const reader = init.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            len += value.length;
          }
        }
        return new Response(JSON.stringify({ id: 'attach-1', bytes: len }), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.txt"\r\nContent-Type: text/plain\r\n\r\nhello world\r\n--${boundary}--\r\n`;
    const req = mockReq({
      method: 'POST',
      url: '/v1/devin/attachments',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 201);
    const out = res._json();
    assert.equal(out.id, 'attach-1');
    assert.equal(out.bytes, Buffer.byteLength(body));
    assert.equal(calls[0].headers['Content-Type'], `multipart/form-data; boundary=${boundary}`);
  });

  it('forwards 302 redirects verbatim (presigned download URL)', async () => {
    installFetchStub({
      'GET /v1/attachments/foo/file': () => new Response('', {
        status: 302,
        headers: { 'Location': 'https://devin-attachments.example.com/presigned?sig=x' },
      }),
    });
    const req = mockReq({ method: 'GET', url: '/v1/devin/attachments/foo/file' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 302);
    assert.equal(res._headers().Location, 'https://devin-attachments.example.com/presigned?sig=x');
  });
});

describe('handleDevinPassthrough — error pass-through', () => {
  it('forwards non-2xx upstream responses with their JSON body and status', async () => {
    installFetchStub({
      'POST /v1/sessions': () => new Response(JSON.stringify({ detail: 'Bad API key' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      }),
    });
    const req = mockReq({
      method: 'POST', url: '/v1/devin/sessions',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 401);
    assert.deepEqual(res._json(), { detail: 'Bad API key' });
  });

  it('maps fetch network errors to a 502 JSON envelope', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    const req = mockReq({ method: 'GET', url: '/v1/devin/sessions' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 502);
    assert.equal(res._json().error.type, 'upstream_error');
  });
});

describe('handleDevinPassthrough — every allowed route reaches the right upstream URL', () => {
  it('walks ALLOWED_ROUTES and checks each one passes through', async () => {
    for (const [method, pattern, template] of ALLOWED_ROUTES) {
      const concretePath = fillPattern(pattern);
      const upstream = fillPattern(template);
      const calls = installFetchStub({
        [`${method} ${upstream}`]: () => new Response(JSON.stringify({ ok: true, route: `${method} ${upstream}` }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
      });
      const needsBody = method === 'POST' || method === 'PATCH' || method === 'PUT';
      const req = mockReq({
        method,
        url: `/v1/devin${concretePath}`,
        headers: needsBody ? { 'content-type': 'application/json' } : {},
        body: needsBody ? '{}' : null,
      });
      const res = mockRes();
      await handleDevinPassthrough(req, res);
      assert.equal(res._status(), 200, `${method} ${concretePath} should return 200`);
      assert.equal(res._json().route, `${method} ${upstream}`);
      assert.equal(calls.length, 1, `${method} ${concretePath} should issue exactly one upstream call`);
      assert.match(calls[0].url, new RegExp(upstream.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('forwards v3 organization session creation including the org_id from the URL', async () => {
    const calls = installFetchStub({
      'POST /v3/organizations/org-real/sessions': () =>
        new Response(JSON.stringify({ devin_id: 'devin-fresh' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
    });
    const req = mockReq({
      method: 'POST',
      url: '/v1/devin/v3/organizations/org-real/sessions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', max_acu_limit: 5 }),
    });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 200);
    assert.deepEqual(res._json(), { devin_id: 'devin-fresh' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.devin.ai/v3/organizations/org-real/sessions');
    assert.equal(calls[0].headers.Authorization, 'Bearer apk_test_passthrough');
    assert.equal(JSON.parse(calls[0].body).prompt, 'hello');
  });

  it('preserves query strings on v3 list endpoints (cursor pagination)', async () => {
    const calls = installFetchStub({
      'GET /v3/organizations/org-real/sessions': () =>
        new Response(JSON.stringify({ items: [], has_more: false }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
    });
    const req = mockReq({
      method: 'GET',
      url: '/v1/devin/v3/organizations/org-real/sessions?first=50&after=cursor-abc',
    });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 200);
    assert.equal(calls[0].url, 'https://api.devin.ai/v3/organizations/org-real/sessions?first=50&after=cursor-abc');
  });

  it('forwards v2 enterprise audit-logs reads through verbatim', async () => {
    const calls = installFetchStub({
      'GET /v2/enterprise/audit-logs': () =>
        new Response(JSON.stringify({ logs: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
    });
    const req = mockReq({
      method: 'GET',
      url: '/v1/devin/v2/enterprise/audit-logs?limit=100',
    });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 200);
    assert.equal(calls[0].url, 'https://api.devin.ai/v2/enterprise/audit-logs?limit=100');
  });

  it('rejects sub-paths not in the allowlist even if they look v3-shaped', async () => {
    const calls = installFetchStub({});
    const req = mockReq({
      method: 'POST',
      url: '/v1/devin/v3/organizations/org-real/sessions/devin-x/danger',
    });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 404);
    assert.equal(res._json().error.type, 'not_found');
    assert.equal(calls.length, 0);
  });
});

/**
 * Adversarial: every method/path tuple advertised in docs/devin-provider.md
 * must resolve to a row in ALLOWED_ROUTES. Without this the route tables in
 * docs and the matcher silently drift apart — e.g. the docs once advertised
 * `PUT /v3/organizations/:org_id/sessions/:devin_id/tags` while the code
 * only listed DELETE on the same path. The walker would not catch that
 * because it iterates rows that ARE in the table.
 */
describe('docs/devin-provider.md ↔ ALLOWED_ROUTES consistency', () => {
  // Inline parser so the test stays self-contained. The route tables in
  // devin-provider.md follow a fixed shape:
  //   | `/v1/devin/<proxy-path>` | `METHOD1` / `METHOD2` (annotation) |
  // The proxy-path is what handleDevinPassthrough sees after stripping
  // the `/v1/devin/` prefix, so it is also what matchRoute consumes.
  const here = dirname(fileURLToPath(import.meta.url));
  const md = readFileSync(resolve(here, '..', 'docs', 'devin-provider.md'), 'utf-8');

  const documented = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const m = line.match(/^\|\s*`(\/v1\/devin\/[^`]*)`\s*\|\s*([^|]+)\|/);
    if (!m) continue;
    const proxyPath = m[1].replace(/^\/v1\/devin/, '') || '/';
    // Skip the OpenAI/Anthropic translation surfaces — those are not
    // proxied through /v1/devin so they shouldn't be in ALLOWED_ROUTES.
    if (!proxyPath.startsWith('/')) continue;
    // Skip /v1/devin/_proxy/* — those are introspection endpoints
    // handled inline in handleDevinPassthrough, not entries in
    // ALLOWED_ROUTES (which is only for upstream-bound passthrough).
    if (proxyPath.startsWith('/_proxy/')) continue;
    const methodsCell = m[2];
    const methods = methodsCell.match(/`(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)`/g);
    if (!methods) continue;
    for (const tok of methods) {
      const method = tok.replace(/`/g, '');
      documented.push({ method, path: proxyPath });
    }
  }

  it('parses at least one row out of the docs (sanity)', () => {
    assert.ok(documented.length > 20, `expected >20 documented routes, got ${documented.length}`);
  });

  it('every documented (METHOD, path) tuple matches a row in ALLOWED_ROUTES', () => {
    const missing = [];
    for (const { method, path } of documented) {
      const concrete = fillPattern(path);
      const got = matchRoute(method, concrete);
      if (!got) missing.push(`${method} ${path}`);
    }
    assert.deepEqual(missing, [], `Routes in docs but missing from ALLOWED_ROUTES:\n  ${missing.join('\n  ')}`);
  });

  it('every ALLOWED_ROUTES row is mentioned somewhere in docs', () => {
    // Build a normalized lookup of documented (METHOD, path) pairs.
    const docSet = new Set(documented.map(({ method, path }) => `${method} ${path}`));
    const undocumented = [];
    for (const [method, pattern] of ALLOWED_ROUTES) {
      if (!docSet.has(`${method} ${pattern}`)) {
        undocumented.push(`${method} ${pattern}`);
      }
    }
    assert.deepEqual(undocumented, [], `Routes in ALLOWED_ROUTES but absent from docs:\n  ${undocumented.join('\n  ')}`);
  });
});
