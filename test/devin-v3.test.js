/**
 * Devin Cloud reverse proxy — v3 API surface coverage.
 *
 * The chat adapter and REST passthrough are exercised against both API
 * surfaces in devin-adapter.test.js / devin-passthrough.test.js, but
 * those default to v1. This file pins down the v3-only behaviors that
 * the proxy needs to keep working as service-user (`cog_*`) tokens
 * become the norm:
 *
 *   1. devin-client.js routes session ops to /v3/organizations/<org>/...
 *      when DEVIN_API_VERSION=v3 (and refuses to issue requests when
 *      DEVIN_ORG_ID isn't set).
 *   2. Auto-detect: DEVIN_API_VERSION=auto attempts v1 first, and on a
 *      401/403 falls back to v3 — only when DEVIN_ORG_ID is configured.
 *      Without org_id, the original 401 must propagate (better signal
 *      than a generic "missing org_id" error).
 *   3. normalizeV3Session converts the v3 messages payload (separate
 *      endpoint, `source` field) into the v1-shaped `messages[]` array
 *      with `type` so downstream extractors keep working.
 *   4. /v1/devin/_proxy/info reports configuration without leaking the
 *      key; /v1/devin/_proxy/routes returns the allowlist.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';

import { config } from '../src/config.js';
import {
  createSession,
  getSession,
  sendMessage,
  normalizeV3Session,
  DevinApiError,
  _clearAutoVersionCache,
  _internals as clientInternals,
} from '../src/devin-client.js';
import { handleDevinPassthrough } from '../src/handlers/devin-passthrough.js';

const ORIG = {
  fetch: globalThis.fetch,
  apiKey: config.devinApiKey,
  apiBase: config.devinApiBase,
  apiVersion: config.devinApiVersion,
  orgId: config.devinOrgId,
};

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
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }
    return handler({ url: u, init, parsed });
  };
  return calls;
}

function mockReq({ method = 'GET', url = '/v1/devin/_proxy/info', headers = {}, body = null }) {
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
  return w;
}

beforeEach(() => {
  config.devinApiKey = 'cog_test_v3_key';
  config.devinApiBase = 'https://api.devin.ai';
  config.devinApiVersion = 'auto';
  config.devinOrgId = '';
  _clearAutoVersionCache();
});

afterEach(() => {
  globalThis.fetch = ORIG.fetch;
  config.devinApiKey = ORIG.apiKey;
  config.devinApiBase = ORIG.apiBase;
  config.devinApiVersion = ORIG.apiVersion;
  config.devinOrgId = ORIG.orgId;
});

describe('devin-client v3 routing', () => {
  it('createSession with version=v3 hits /v3/organizations/<org>/sessions', async () => {
    config.devinApiVersion = 'v3';
    config.devinOrgId = 'org-abc';
    const calls = installFetchStub({
      'POST /v3/organizations/org-abc/sessions': () =>
        new Response(JSON.stringify({ session_id: 'devin-xyz', url: 'https://app.devin.ai/sessions/xyz' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
    });
    const session = await createSession({ prompt: 'hello', max_acu_limit: 5 });
    assert.equal(session.session_id, 'devin-xyz');
    assert.equal(session._api_version, 'v3');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/v3\/organizations\/org-abc\/sessions$/);
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent.prompt, 'hello');
    assert.equal(sent.max_acu_limit, 5);
  });

  it('refuses v3 calls when DEVIN_ORG_ID is missing', async () => {
    config.devinApiVersion = 'v3';
    config.devinOrgId = '';
    installFetchStub({}); // shouldn't be called
    await assert.rejects(
      () => createSession({ prompt: 'hello' }),
      (e) => e instanceof DevinApiError && /DEVIN_ORG_ID/.test(e.message),
    );
  });

  it('getSession on v3 merges /sessions and /messages into a v1-shaped payload', async () => {
    config.devinApiVersion = 'v3';
    config.devinOrgId = 'org-abc';
    installFetchStub({
      'GET /v3/organizations/org-abc/sessions/devin-1': () => new Response(JSON.stringify({
        session_id: 'devin-1',
        status: 'running',
        status_detail: 'working',
        pull_requests: [{ url: 'https://github.com/x/y/pull/1' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      'GET /v3/organizations/org-abc/sessions/devin-1/messages': () => new Response(JSON.stringify({
        items: [
          { event_id: 'e1', source: 'user', message: 'hi', created_at: 1 },
          { event_id: 'e2', source: 'devin', message: 'hello back', created_at: 2 },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const session = await getSession('devin-1');
    assert.equal(session.session_id, 'devin-1');
    // status_enum is synthesised from status_detail so the chat handler's
    // TERMINAL_STATUSES check works on v3 payloads.
    assert.equal(session.status_enum, 'working');
    // pull_request is flattened from pull_requests[0] for v1 compatibility.
    assert.equal(session.pull_request.url, 'https://github.com/x/y/pull/1');
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[0].type, 'user_message');
    assert.equal(session.messages[1].type, 'devin_message');
  });

  it('sendMessage on v3 posts to /messages (note: v3 plural, v1 singular)', async () => {
    config.devinApiVersion = 'v3';
    config.devinOrgId = 'org-abc';
    const calls = installFetchStub({
      'POST /v3/organizations/org-abc/sessions/devin-1/messages': () =>
        new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    await sendMessage('devin-1', 'follow-up');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v3\/organizations\/org-abc\/sessions\/devin-1\/messages$/);
    assert.equal(JSON.parse(calls[0].body).message, 'follow-up');
  });

  it('forwards Authorization: Bearer with the configured key on every v3 call', async () => {
    config.devinApiVersion = 'v3';
    config.devinOrgId = 'org-abc';
    config.devinApiKey = 'cog_secret123';
    const calls = installFetchStub({
      'POST /v3/organizations/org-abc/sessions': () =>
        new Response(JSON.stringify({ session_id: 'd' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    await createSession({ prompt: 'x' });
    const got = calls[0].headers;
    const headers = got instanceof Headers ? Object.fromEntries(got.entries()) : got;
    assert.equal(headers.Authorization || headers.authorization, 'Bearer cog_secret123');
  });
});

describe('devin-client auto-detect', () => {
  it('auto falls back to v3 when v1 returns 401 (with no org_id hint, v1 is tried first)', async () => {
    config.devinApiVersion = 'auto';
    // Don't set org_id up front — we want the loader to default to v1 first
    // so we can exercise the 401-fallback path. The 401 handler in
    // devin-client uses `config.devinOrgId` to decide whether to retry on
    // v3, so we set it *after* installing the fetch stub.
    config.devinOrgId = '';
    const calls = installFetchStub({
      'POST /v1/sessions': () => {
        // Set org_id just before the v3 retry would happen — emulates the
        // operator configuring both DEVIN_API_KEY and DEVIN_ORG_ID at
        // startup, then triggering the first call.
        config.devinOrgId = 'org-abc';
        return new Response(JSON.stringify({ detail: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json' },
        });
      },
      'POST /v3/organizations/org-abc/sessions': () => new Response(JSON.stringify({ session_id: 'devin-1' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    });
    const session = await createSession({ prompt: 'hello' });
    assert.equal(session.session_id, 'devin-1');
    assert.equal(session._api_version, 'v3');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/v1\/sessions$/);
    assert.match(calls[1].url, /\/v3\/organizations\/org-abc\/sessions$/);
    // After fallback, the choice is cached so a second call goes straight to v3.
    const session2 = await createSession({ prompt: 'second' });
    assert.equal(session2.session_id, 'devin-1');
    assert.equal(calls.length, 3);
    assert.match(calls[2].url, /\/v3\/organizations\/org-abc\/sessions$/);
  });

  it('auto re-raises the original 401 when DEVIN_ORG_ID is not set', async () => {
    config.devinApiVersion = 'auto';
    config.devinOrgId = '';
    installFetchStub({
      'POST /v1/sessions': () => new Response(JSON.stringify({ detail: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      }),
    });
    await assert.rejects(
      () => createSession({ prompt: 'hi' }),
      (e) => e instanceof DevinApiError && e.status === 401,
    );
  });

  it('auto starts on v3 when DEVIN_ORG_ID hints v3 was intended', async () => {
    config.devinApiVersion = 'auto';
    config.devinOrgId = 'org-abc';
    const calls = installFetchStub({
      'POST /v3/organizations/org-abc/sessions': () => new Response(JSON.stringify({ session_id: 'devin-1' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    });
    await createSession({ prompt: 'x' });
    // No v1 round-trip when org_id is configured up front.
    assert.equal(calls.filter(c => c.url.includes('/v1/sessions')).length, 0);
    assert.equal(calls.filter(c => c.url.includes('/v3/organizations/org-abc/sessions')).length, 1);
  });
});

describe('normalizeV3Session', () => {
  it('synthesises status_enum from status_detail', () => {
    const norm = normalizeV3Session({ status: 'running', status_detail: 'blocked' }, { items: [] });
    assert.equal(norm.status_enum, 'blocked');
  });

  it('falls back to status when status_detail is missing', () => {
    const norm = normalizeV3Session({ status: 'finished' }, { items: [] });
    assert.equal(norm.status_enum, 'finished');
  });

  it('maps source → type for all known sources', () => {
    const norm = normalizeV3Session({}, {
      items: [
        { event_id: 'a', source: 'user', message: 'q' },
        { event_id: 'b', source: 'devin', message: 'a' },
        { event_id: 'c', source: 'agent', message: 'a2' },
        { event_id: 'd', source: 'system', message: 'note' },
      ],
    });
    assert.equal(norm.messages[0].type, 'user_message');
    assert.equal(norm.messages[1].type, 'devin_message');
    assert.equal(norm.messages[2].type, 'devin_message');
    assert.equal(norm.messages[3].type, 'system');
  });

  it('preserves event_id, message, and any extra fields', () => {
    const norm = normalizeV3Session({}, {
      items: [{ event_id: 'e1', source: 'user', message: 'hi', created_at: 1234, extra: 'x' }],
    });
    assert.equal(norm.messages[0].event_id, 'e1');
    assert.equal(norm.messages[0].message, 'hi');
    assert.equal(norm.messages[0].created_at, 1234);
    assert.equal(norm.messages[0].extra, 'x');
  });

  it('handles array-shaped messages payload (defensive)', () => {
    const norm = normalizeV3Session({}, [{ event_id: 'x', source: 'devin', message: 'hi' }]);
    assert.equal(norm.messages.length, 1);
    assert.equal(norm.messages[0].type, 'devin_message');
  });

  it('coerces missing items into an empty array', () => {
    const norm = normalizeV3Session({ status: 'running' }, null);
    assert.deepEqual(norm.messages, []);
  });
});

describe('/v1/devin/_proxy/info', () => {
  it('reports configured + version + masked key + cached effective version', async () => {
    config.devinApiKey = 'cog_abcd1234efgh5678';
    config.devinApiVersion = 'auto';
    config.devinOrgId = 'org-abc';
    // Seed the auto-detect cache so the response surfaces it.
    clientInternals._autoVersionCache.set('cog_abcd1234efgh5678', 'v3');

    const req = mockReq({ method: 'GET', url: '/v1/devin/_proxy/info' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 200);
    const info = res._json();
    assert.equal(info.configured, true);
    assert.equal(info.api_version_setting, 'auto');
    assert.equal(info.org_id, 'org-abc');
    assert.equal(info.api_key_prefix, 'cog_');
    assert.equal(info.cached_effective_version, 'v3');
    // The actual key value MUST NOT be in the payload.
    assert.ok(!JSON.stringify(info).includes('abcd1234efgh5678'));
    assert.match(info.api_key_mask, /cog_…5678/);
  });

  it('returns 503 when DEVIN_API_KEY is unset', async () => {
    config.devinApiKey = '';
    const req = mockReq({ method: 'GET', url: '/v1/devin/_proxy/info' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 503);
    assert.equal(res._json().error.type, 'configuration_error');
  });

  it('with ?probe=1, runs a real probe against v1 and v3', async () => {
    config.devinApiKey = 'cog_key';
    config.devinOrgId = 'org-abc';
    const calls = installFetchStub({
      'GET /v1/sessions': () => new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 }),
      'GET /v3/organizations/org-abc/sessions': () => new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    });
    const req = mockReq({ method: 'GET', url: '/v1/devin/_proxy/info?probe=1' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 200);
    const info = res._json();
    assert.ok(info.probe);
    assert.equal(info.probe.v1.status, 401);
    assert.equal(info.probe.v3.status, 200);
    assert.equal(info.probe.effective, 'v3');
    assert.equal(calls.length, 2);
  });

  it('probe reports "DEVIN_ORG_ID not configured" when org_id is missing', async () => {
    config.devinApiKey = 'cog_key';
    config.devinOrgId = '';
    installFetchStub({
      'GET /v1/sessions': () => new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 }),
    });
    const req = mockReq({ method: 'GET', url: '/v1/devin/_proxy/info?probe=1' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    const info = res._json();
    assert.equal(info.probe.v3.ok, false);
    assert.match(info.probe.v3.error, /DEVIN_ORG_ID/);
  });
});

describe('/v1/devin/_proxy/routes', () => {
  it('returns the static allowlist as JSON', async () => {
    config.devinApiKey = 'cog_key';
    const req = mockReq({ method: 'GET', url: '/v1/devin/_proxy/routes' });
    const res = mockRes();
    await handleDevinPassthrough(req, res);
    assert.equal(res._status(), 200);
    const body = res._json();
    assert.ok(Array.isArray(body.routes));
    assert.ok(body.count > 20);
    const sessionsRoute = body.routes.find(r => r.method === 'POST' && r.pattern === '/sessions');
    assert.ok(sessionsRoute);
    assert.equal(sessionsRoute.upstream, '/v1/sessions');
    // No fetch should fire — this is a pure-config endpoint.
  });
});
