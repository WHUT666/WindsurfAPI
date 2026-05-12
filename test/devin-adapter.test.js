/**
 * Tests for the Devin Sessions provider adapter.
 *
 * Strategy: install a global fetch stub for the duration of each test so
 * we exercise the full adapter (client + session cache + handler) without
 * touching the network or the Windsurf account pool.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resolveModel, getModelInfo } from '../src/models.js';
import { clear as cacheClear, fingerprint, lookup, store, size as cacheSize } from '../src/devin-session-cache.js';
import { createSession, getSession, sendMessage, pollUntilTerminal, DevinApiError, TERMINAL_STATUSES } from '../src/devin-client.js';
import { messagesToPrompt, contentToText, tailUserMessage, extractNewAssistantMessages, lastEventId, handleDevinChat } from '../src/handlers/devin-chat.js';
import { config } from '../src/config.js';

// Capture original env, config snapshot, and global fetch for restore.
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalDevinConfig = {
  devinApiKey: config.devinApiKey,
  devinApiBase: config.devinApiBase,
  devinPollIntervalMs: config.devinPollIntervalMs,
  devinMaxWaitMs: config.devinMaxWaitMs,
  devinDefaultSnapshotId: config.devinDefaultSnapshotId,
  devinDefaultPlaybookId: config.devinDefaultPlaybookId,
  devinSessionCacheTtlMs: config.devinSessionCacheTtlMs,
  devinSessionCacheMaxEntries: config.devinSessionCacheMaxEntries,
};

function installFetchStub(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = typeof url === 'string' ? url : url.url;
    const method = (init.method || 'GET').toUpperCase();
    const key = `${method} ${new URL(u).pathname}`;
    calls.push({ url: u, method, init, key });
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({ detail: `No stub for ${key}` }), { status: 404 });
    }
    return handler({ url: u, init, calls });
  };
  return calls;
}

function restoreFetch() { globalThis.fetch = originalFetch; }

beforeEach(() => {
  cacheClear();
  // config is built at module load, so mutate fields directly (they're plain props).
  config.devinApiKey = 'apk_test_key';
  config.devinApiBase = 'https://api.devin.ai';
  config.devinPollIntervalMs = 5;
  config.devinMaxWaitMs = 500;
  config.devinDefaultSnapshotId = '';
  config.devinDefaultPlaybookId = '';
  config.devinSessionCacheTtlMs = 60 * 60 * 1000;
  config.devinSessionCacheMaxEntries = 1000;
});
afterEach(() => {
  process.env = originalEnv;
  Object.assign(config, originalDevinConfig);
  restoreFetch();
  cacheClear();
});

describe('Devin model registration', () => {
  it('registers devin / devin-fast / devin-deep with provider=devin-sessions', () => {
    for (const name of ['devin', 'devin-fast', 'devin-deep']) {
      assert.equal(resolveModel(name), name);
      const info = getModelInfo(name);
      assert.ok(info, `${name} is missing from MODELS`);
      assert.equal(info.provider, 'devin-sessions');
    }
  });

  it('devin-fast and devin-deep carry distinct max_acu_limit hints', () => {
    assert.equal(getModelInfo('devin').devinMaxAcu, undefined);
    assert.equal(getModelInfo('devin-fast').devinMaxAcu, 5);
    assert.equal(getModelInfo('devin-deep').devinMaxAcu, 50);
  });
});

describe('messagesToPrompt / contentToText', () => {
  it('preserves role boundaries and labels system messages', () => {
    const prompt = messagesToPrompt([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'fix bug' },
    ]);
    assert.match(prompt, /<system>\nbe helpful\n<\/system>/);
    assert.match(prompt, /<user>\nhello\n<\/user>/);
    assert.match(prompt, /<assistant>\nhi\n<\/assistant>/);
    assert.match(prompt, /<user>\nfix bug\n<\/user>/);
  });

  it('coerces multimodal user content to text + image placeholders', () => {
    const text = contentToText([
      { type: 'text', text: 'caption this' },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
    ]);
    assert.match(text, /caption this/);
    assert.match(text, /\[image: https:\/\/example\.com\/cat\.png\]/);
  });

  it('tailUserMessage returns null when last is not user', () => {
    assert.equal(tailUserMessage([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), null);
    assert.equal(tailUserMessage([{ role: 'user', content: 'hello' }]), 'hello');
  });
});

describe('devin-session-cache', () => {
  it('round-trips a fingerprint → session id', () => {
    const fp = fingerprint('caller', [{ role: 'user', content: 'a' }]);
    assert.equal(lookup(fp), null);
    store(fp, 'devin-session-abc');
    assert.equal(lookup(fp), 'devin-session-abc');
  });

  it('different caller keys produce different fingerprints', () => {
    const msgs = [{ role: 'user', content: 'same' }];
    assert.notEqual(fingerprint('a', msgs), fingerprint('b', msgs));
  });

  it('normalizes array content to stable text', () => {
    const a = fingerprint('c', [{ role: 'user', content: 'hi' }]);
    const b = fingerprint('c', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    assert.equal(a, b);
  });

  it('clear empties the cache', () => {
    store('x', 'y');
    assert.ok(cacheSize() >= 1);
    cacheClear();
    assert.equal(cacheSize(), 0);
  });
});

describe('devin-client', () => {
  it('createSession posts prompt and forwards optional params', async () => {
    const calls = installFetchStub({
      'POST /v1/sessions': async ({ init }) => {
        const body = JSON.parse(init.body);
        assert.equal(body.prompt, 'do the thing');
        assert.equal(body.max_acu_limit, 5);
        assert.equal(body.snapshot_id, 'snap_x');
        return new Response(JSON.stringify({ session_id: 'devin-1', url: 'https://app/...', is_new_session: true }), { status: 200 });
      },
    });
    const out = await createSession({ prompt: 'do the thing', max_acu_limit: 5, snapshot_id: 'snap_x' });
    assert.equal(out.session_id, 'devin-1');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer apk_test_key');
  });

  it('createSession throws DevinApiError on 401 with API detail', async () => {
    installFetchStub({
      'POST /v1/sessions': async () => new Response(JSON.stringify({ detail: 'bad key' }), { status: 401 }),
    });
    await assert.rejects(
      () => createSession({ prompt: 'x' }),
      (err) => err instanceof DevinApiError && err.status === 401 && /bad key/.test(err.message),
    );
  });

  it('getSession returns parsed payload', async () => {
    installFetchStub({
      'GET /v1/sessions/devin-1': async () => new Response(JSON.stringify({
        session_id: 'devin-1', status: 'finished', status_enum: 'finished',
        messages: [{ type: 'devin_message', message: 'done', event_id: 'e1', timestamp: 't' }],
      }), { status: 200 }),
    });
    const s = await getSession('devin-1');
    assert.equal(s.status_enum, 'finished');
    assert.equal(s.messages.length, 1);
  });

  it('sendMessage posts message body', async () => {
    let captured = null;
    installFetchStub({
      'POST /v1/sessions/devin-1/message': async ({ init }) => {
        captured = JSON.parse(init.body);
        return new Response('', { status: 200 });
      },
    });
    const res = await sendMessage('devin-1', 'follow-up');
    assert.equal(captured.message, 'follow-up');
    // empty body → null
    assert.equal(res, null);
  });

  it('pollUntilTerminal polls until status_enum is terminal', async () => {
    let getCount = 0;
    installFetchStub({
      'GET /v1/sessions/devin-1': async () => {
        getCount++;
        const status = getCount < 3 ? 'working' : 'finished';
        return new Response(JSON.stringify({
          session_id: 'devin-1', status, status_enum: status,
          messages: [{ type: 'devin_message', message: `m${getCount}`, event_id: `e${getCount}`, timestamp: 't' }],
        }), { status: 200 });
      },
    });
    const { session, timedOut } = await pollUntilTerminal('devin-1', { intervalMs: 5, maxWaitMs: 1000 });
    assert.equal(timedOut, false);
    assert.equal(session.status_enum, 'finished');
    assert.ok(TERMINAL_STATUSES.has(session.status_enum));
    assert.ok(getCount >= 3, 'should have polled at least 3 times');
  });

  it('pollUntilTerminal honours maxWaitMs and reports timedOut', async () => {
    installFetchStub({
      'GET /v1/sessions/devin-1': async () => new Response(JSON.stringify({
        session_id: 'devin-1', status: 'working', status_enum: 'working', messages: [],
      }), { status: 200 }),
    });
    const { timedOut } = await pollUntilTerminal('devin-1', { intervalMs: 5, maxWaitMs: 30 });
    assert.equal(timedOut, true);
  });
});

describe('extractNewAssistantMessages', () => {
  const session = {
    messages: [
      { type: 'user_message', event_id: 'u1', message: 'go' },
      { type: 'devin_message', event_id: 'd1', message: 'starting' },
      { type: 'devin_message', event_id: 'd2', message: 'working' },
    ],
  };

  it('returns all assistant messages when cursor is null', () => {
    const { messages, newSinceEventId } = extractNewAssistantMessages(session, null);
    assert.deepEqual(messages, ['starting', 'working']);
    assert.equal(newSinceEventId, 'd2');
  });

  it('returns only messages after cursor', () => {
    const { messages, newSinceEventId } = extractNewAssistantMessages(session, 'd1');
    assert.deepEqual(messages, ['working']);
    assert.equal(newSinceEventId, 'd2');
  });

  it('falls back to last-user-message boundary when cursor is unknown', () => {
    const { messages } = extractNewAssistantMessages(session, 'event-that-was-pruned');
    assert.deepEqual(messages, ['starting', 'working']);
  });

  it('lastEventId returns trailing event_id', () => {
    assert.equal(lastEventId(session), 'd2');
    assert.equal(lastEventId({ messages: [] }), null);
    assert.equal(lastEventId(null), null);
  });
});

describe('handleDevinChat (end-to-end, mocked fetch)', () => {
  it('refuses when DEVIN_API_KEY is missing', async () => {
    config.devinApiKey = '';
    const result = await handleDevinChat({ model: 'devin', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.status, 503);
    assert.match(result.body.error.message, /DEVIN_API_KEY/);
  });

  it('creates a new session and returns aggregated assistant content', async () => {
    let createdParams = null;
    installFetchStub({
      'POST /v1/sessions': async ({ init }) => {
        createdParams = JSON.parse(init.body);
        return new Response(JSON.stringify({ session_id: 'devin-1', url: 'https://app/...', is_new_session: true }), { status: 200 });
      },
      'GET /v1/sessions/devin-1': async () => new Response(JSON.stringify({
        session_id: 'devin-1',
        status: 'finished',
        status_enum: 'finished',
        messages: [
          { type: 'user_message', event_id: 'u1', message: 'fix it', timestamp: 't' },
          { type: 'devin_message', event_id: 'd1', message: 'fixed', timestamp: 't' },
        ],
        pull_request: { url: 'https://github.com/o/r/pull/1' },
      }), { status: 200 }),
    });
    const result = await handleDevinChat({ model: 'devin-fast', messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'fix it' },
    ]});
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.role, 'assistant');
    assert.match(result.body.choices[0].message.content, /fixed/);
    assert.match(result.body.choices[0].message.content, /github\.com\/o\/r\/pull\/1/);
    assert.equal(result.body.choices[0].finish_reason, 'stop');
    assert.equal(result.headers['x-devin-session-id'], 'devin-1');
    assert.equal(result.body.x_devin.session_id, 'devin-1');
    // devin-fast should set max_acu_limit=5 on session creation
    assert.equal(createdParams.max_acu_limit, 5);
    // System message should be baked into the prompt
    assert.match(createdParams.prompt, /<system>\s*be terse/);
  });

  it('reuses a cached session on a follow-up turn via fingerprint', async () => {
    // Pre-seed the cache as if a prior turn had completed.
    const prior = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
    ];
    store(fingerprint('', prior), 'devin-existing');

    let createCalls = 0;
    let messageBody = null;
    installFetchStub({
      'POST /v1/sessions': async () => { createCalls++; return new Response('{}', { status: 200 }); },
      'GET /v1/sessions/devin-existing': async ({ calls }) => {
        // First GET: snapshot for cursor. Second+: poll loop.
        const polls = calls.filter(c => c.key === 'GET /v1/sessions/devin-existing').length;
        const status = polls < 2 ? 'working' : 'finished';
        return new Response(JSON.stringify({
          session_id: 'devin-existing',
          status, status_enum: status,
          messages: polls < 2 ? [
            { type: 'user_message', event_id: 'u1', message: 'hi', timestamp: 't' },
            { type: 'devin_message', event_id: 'd1', message: 'hello!', timestamp: 't' },
          ] : [
            { type: 'user_message', event_id: 'u1', message: 'hi', timestamp: 't' },
            { type: 'devin_message', event_id: 'd1', message: 'hello!', timestamp: 't' },
            { type: 'user_message', event_id: 'u2', message: 'follow up', timestamp: 't' },
            { type: 'devin_message', event_id: 'd2', message: 'sure thing', timestamp: 't' },
          ],
        }), { status: 200 });
      },
      'POST /v1/sessions/devin-existing/message': async ({ init }) => {
        messageBody = JSON.parse(init.body);
        return new Response('', { status: 200 });
      },
    });

    const result = await handleDevinChat({
      model: 'devin',
      messages: [...prior, { role: 'user', content: 'follow up' }],
    });
    assert.equal(result.status, 200);
    assert.equal(createCalls, 0, 'must not create a new session when fingerprint hits');
    assert.equal(messageBody?.message, 'follow up');
    assert.match(result.body.choices[0].message.content, /sure thing/);
    // Should not double-emit the pre-existing assistant text from the prior turn
    assert.doesNotMatch(result.body.choices[0].message.content, /hello!/);
  });

  it('X-Devin-Session-Id header overrides the fingerprint cache', async () => {
    // Seed a cache entry pointing at a different session id; the header
    // must win.
    store(fingerprint('', [{ role: 'user', content: 'first' }]), 'devin-from-cache');

    let createCalls = 0;
    let messageTarget = null;
    installFetchStub({
      'POST /v1/sessions': async () => { createCalls++; return new Response('{}', { status: 200 }); },
      'POST /v1/sessions/devin-explicit/message': async ({ init }) => {
        messageTarget = JSON.parse(init.body);
        return new Response('', { status: 200 });
      },
      'GET /v1/sessions/devin-explicit': async () => new Response(JSON.stringify({
        session_id: 'devin-explicit',
        status: 'finished', status_enum: 'finished',
        messages: [
          { type: 'user_message', event_id: 'u1', message: 'next', timestamp: 't' },
          { type: 'devin_message', event_id: 'd1', message: 'overridden', timestamp: 't' },
        ],
      }), { status: 200 }),
    });
    const result = await handleDevinChat(
      { model: 'devin', messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'next' },
      ]},
      { headers: { 'x-devin-session-id': 'devin-explicit' } },
    );
    assert.equal(result.status, 200);
    assert.equal(createCalls, 0);
    assert.equal(messageTarget.message, 'next');
    assert.match(result.body.choices[0].message.content, /overridden/);
    assert.equal(result.headers['x-devin-session-id'], 'devin-explicit');
  });

  it('falls back to creating a new session when cached session is gone (404)', async () => {
    store(fingerprint('', [{ role: 'user', content: 'old' }]), 'devin-dead');
    let createCalls = 0;
    installFetchStub({
      'GET /v1/sessions/devin-dead': async () => new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }),
      'POST /v1/sessions': async () => { createCalls++; return new Response(JSON.stringify({ session_id: 'devin-fresh', url: '/' }), { status: 200 }); },
      'GET /v1/sessions/devin-fresh': async () => new Response(JSON.stringify({
        session_id: 'devin-fresh', status: 'finished', status_enum: 'finished',
        messages: [{ type: 'devin_message', event_id: 'd1', message: 'fresh', timestamp: 't' }],
      }), { status: 200 }),
    });
    const result = await handleDevinChat({
      model: 'devin', messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'old reply' },
        { role: 'user', content: 'new turn' },
      ],
    });
    assert.equal(result.status, 200);
    assert.equal(createCalls, 1);
    assert.match(result.body.choices[0].message.content, /fresh/);
  });

  it('returns finish_reason=length when polling times out without terminal status', async () => {
    config.devinMaxWaitMs = 20;
    installFetchStub({
      'POST /v1/sessions': async () => new Response(JSON.stringify({ session_id: 'devin-slow', url: '/' }), { status: 200 }),
      'GET /v1/sessions/devin-slow': async () => new Response(JSON.stringify({
        session_id: 'devin-slow', status: 'working', status_enum: 'working',
        messages: [{ type: 'devin_message', event_id: 'd1', message: 'still thinking', timestamp: 't' }],
      }), { status: 200 }),
    });
    const result = await handleDevinChat({ model: 'devin', messages: [{ role: 'user', content: 'go' }] });
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].finish_reason, 'length');
    assert.match(result.body.choices[0].message.content, /still thinking/);
  });

  it('maps Devin 401 to OpenAI authentication_error', async () => {
    installFetchStub({
      'POST /v1/sessions': async () => new Response(JSON.stringify({ detail: 'invalid api key' }), { status: 401 }),
    });
    const result = await handleDevinChat({ model: 'devin', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.type, 'authentication_error');
    assert.match(result.body.error.message, /invalid api key/);
  });
});

describe('stream mode', () => {
  it('emits SSE chunks for each new Devin message and a final stop chunk', async () => {
    let polls = 0;
    installFetchStub({
      'POST /v1/sessions': async () => new Response(JSON.stringify({ session_id: 'devin-s1', url: '/' }), { status: 200 }),
      'GET /v1/sessions/devin-s1': async () => {
        polls++;
        const finished = polls >= 3;
        return new Response(JSON.stringify({
          session_id: 'devin-s1',
          status: finished ? 'finished' : 'working',
          status_enum: finished ? 'finished' : 'working',
          messages: polls === 1
            ? [{ type: 'devin_message', event_id: 'd1', message: 'first', timestamp: 't' }]
            : polls === 2
              ? [
                  { type: 'devin_message', event_id: 'd1', message: 'first', timestamp: 't' },
                  { type: 'devin_message', event_id: 'd2', message: 'second', timestamp: 't' },
                ]
              : [
                  { type: 'devin_message', event_id: 'd1', message: 'first', timestamp: 't' },
                  { type: 'devin_message', event_id: 'd2', message: 'second', timestamp: 't' },
                  { type: 'devin_message', event_id: 'd3', message: 'final', timestamp: 't' },
                ],
        }), { status: 200 });
      },
    });
    const result = await handleDevinChat({
      model: 'devin', stream: true,
      messages: [{ role: 'user', content: 'go' }],
    });
    assert.equal(result.stream, true);

    // Drive the handler against a minimal mock res.
    const chunks = [];
    const mockRes = {
      writableEnded: false,
      write(chunk) { chunks.push(String(chunk)); return true; },
      end() { this.writableEnded = true; },
      on() {},
    };
    await result.handler(mockRes);
    const joined = chunks.join('');
    assert.match(joined, /"role":"assistant"/, 'initial assistant role chunk should be emitted');
    assert.match(joined, /first/);
    assert.match(joined, /second/);
    assert.match(joined, /final/);
    assert.match(joined, /"finish_reason":"stop"/);
    assert.match(joined, /data: \[DONE\]/);
  });
});
