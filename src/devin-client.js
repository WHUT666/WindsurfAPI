/**
 * Devin REST client — thin wrapper around api.devin.ai.
 *
 * Speaks both API surfaces:
 *
 *   v1 (legacy, org-scoped via apk_* key):
 *     POST   /v1/sessions
 *     GET    /v1/sessions/{id}                    ← messages embedded in response
 *     POST   /v1/sessions/{id}/message
 *
 *   v3 (current, RBAC + service-user / cog_* tokens):
 *     POST   /v3/organizations/{org_id}/sessions
 *     GET    /v3/organizations/{org_id}/sessions/{id}
 *     GET    /v3/organizations/{org_id}/sessions/{id}/messages
 *     POST   /v3/organizations/{org_id}/sessions/{id}/messages
 *
 * The v3 surface is required for the new service-user token family
 * (`cog_*`, May 2026+) — those keys 401 against every v1 endpoint, so a
 * v1-only client breaks the moment the operator rotates their token.
 *
 * Caller picks the version with config.devinApiVersion:
 *   'v1'   — force v1 (legacy keys)
 *   'v3'   — force v3 (needs config.devinOrgId; cog_* / apk_user_* keys)
 *   'auto' — try v1, on 401/403 swap to v3 and cache the choice
 *
 * Auth: `Authorization: Bearer <key>`. Keys are pulled from
 * config.devinApiKey at call time (not at import) so dashboard-driven
 * key rotation works without a process restart.
 *
 * Response normalization: v3 returns sessions and messages on separate
 * endpoints with `source: 'user'|'devin'` instead of v1's
 * `type: 'user_message'|'devin_message'`, and uses `status` instead of
 * `status_enum`. `getSession` returns a normalized v1-shaped object so
 * handlers/devin-chat.js never has to branch.
 *
 * Zero npm deps — uses global fetch (Node 20+).
 */

import { config, log } from './config.js';

class DevinApiError extends Error {
  constructor(message, { status = 0, body = null, endpoint = '' } = {}) {
    super(message);
    this.name = 'DevinApiError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

function requireApiKey() {
  const key = config.devinApiKey;
  if (!key) {
    throw new DevinApiError('DEVIN_API_KEY not configured', { status: 503 });
  }
  return key;
}

async function devinFetch(method, path, { body, signal, apiKey } = {}) {
  const base = (config.devinApiBase || 'https://api.devin.ai').replace(/\/+$/, '');
  const url = `${base}${path}`;
  const headers = {
    'Authorization': `Bearer ${apiKey || requireApiKey()}`,
    'Accept': 'application/json',
  };
  const init = { method, headers, signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new DevinApiError(`Network error calling Devin API: ${err.message}`, {
      status: 0, endpoint: path,
    });
  }
  let parsed = null;
  const text = await res.text();
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const message = typeof parsed === 'object' && parsed?.detail
      ? (Array.isArray(parsed.detail) ? JSON.stringify(parsed.detail) : String(parsed.detail))
      : `Devin API ${res.status} on ${method} ${path}`;
    throw new DevinApiError(message, { status: res.status, body: parsed, endpoint: path });
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────
// API-version routing
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cached "auto" decision. Populated by `_probeForAuto()` once per process
 * (per DEVIN_API_KEY rotation): one 200/401 round-trip on POST /v1/sessions
 * is enough to determine whether the current key works on v1.
 *
 * Keyed by the API key itself so a config-level key swap (without restart)
 * triggers a fresh probe instead of reusing stale routing.
 */
const _autoVersionCache = new Map(); // apiKey → 'v1' | 'v3'

function configuredVersion() {
  const v = String(config.devinApiVersion || 'auto').toLowerCase();
  if (v === 'v1' || v === 'v3') return v;
  return 'auto';
}

function requireOrgId() {
  const orgId = config.devinOrgId;
  if (!orgId) {
    throw new DevinApiError(
      'DEVIN_ORG_ID is required when DEVIN_API_VERSION=v3 (or when auto-detect picks v3). ' +
      'Find your org id at https://app.devin.ai/settings/team or via GET /v2/enterprise/organizations.',
      { status: 503 },
    );
  }
  return orgId;
}

/**
 * Resolve the effective API version for an outgoing call.
 * - 'v1' / 'v3' explicit → return verbatim.
 * - 'auto' → return cached probe result; null if not yet probed (caller probes lazily).
 */
function effectiveVersion(apiKey) {
  const cfg = configuredVersion();
  if (cfg !== 'auto') return cfg;
  return _autoVersionCache.get(apiKey || config.devinApiKey) || null;
}

/**
 * Lazily probe which API surface the current key speaks. Called from
 * createSession when version='auto' and no decision is cached yet.
 *
 * Strategy: try a real v1 call. If it 401/403s, mark this key as v3.
 * The probe is the actual createSession call (passed via `probeFn`), so we
 * don't burn a wasted round-trip — we just intercept its first 401 and retry
 * on v3 instead.
 */
function _markAutoVersion(apiKey, version) {
  const key = apiKey || config.devinApiKey;
  if (!key) return;
  _autoVersionCache.set(key, version);
  log.info(`Devin: auto-detected API version=${version} for key=${maskKey(key)}`);
}

/** Test-only: clear the auto-detect cache. */
export function _clearAutoVersionCache() {
  _autoVersionCache.clear();
}

function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

/**
 * Build the upstream path for a session-scoped operation.
 *
 * @param {'create'|'get'|'send_message'|'list_messages'} op
 * @param {string} sessionId
 * @param {'v1'|'v3'} version
 */
function pathFor(op, sessionId, version) {
  if (version === 'v3') {
    const orgId = requireOrgId();
    const prefix = `/v3/organizations/${encodeURIComponent(orgId)}/sessions`;
    if (op === 'create') return prefix;
    const sid = encodeURIComponent(sessionId);
    if (op === 'get') return `${prefix}/${sid}`;
    if (op === 'send_message') return `${prefix}/${sid}/messages`;
    if (op === 'list_messages') return `${prefix}/${sid}/messages`;
    throw new DevinApiError(`Unknown session op: ${op}`, { status: 500 });
  }
  // v1
  if (op === 'create') return '/v1/sessions';
  const sid = encodeURIComponent(sessionId);
  if (op === 'get') return `/v1/sessions/${sid}`;
  if (op === 'send_message') return `/v1/sessions/${sid}/message`;
  if (op === 'list_messages') return `/v1/sessions/${sid}`;
  throw new DevinApiError(`Unknown session op: ${op}`, { status: 500 });
}

/**
 * Run a session-scoped fetch, honoring config.devinApiVersion. In 'auto'
 * mode the first 401/403 from v1 silently retries on v3 and caches the
 * choice for subsequent calls.
 */
async function sessionFetch(op, { sessionId, body, signal, apiKey } = {}) {
  const effectiveKey = apiKey || config.devinApiKey;
  let version = effectiveVersion(effectiveKey);
  if (!version) {
    // First call in auto mode — start with v1 unless an explicit org_id
    // hints v3 was intended.
    version = config.devinOrgId ? 'v3' : 'v1';
  }

  const method = (op === 'create' || op === 'send_message') ? 'POST' : 'GET';
  const path = pathFor(op, sessionId, version);
  try {
    const parsed = await devinFetch(method, path, { body, signal, apiKey });
    if (configuredVersion() === 'auto' && !_autoVersionCache.has(effectiveKey)) {
      _markAutoVersion(effectiveKey, version);
    }
    return { parsed, version };
  } catch (err) {
    // Auto-detect fallback: 401/403 on v1 → retry on v3.
    //
    // Skip the fallback when DEVIN_ORG_ID isn't configured — we can't form
    // a v3 path without it. The caller's options at that point are either
    // (a) set DEVIN_ORG_ID and DEVIN_API_VERSION=v3 explicitly, or
    // (b) treat the 401 verbatim. Re-raising the original 401 is more
    // actionable than swallowing it under a "missing org_id" error.
    if (
      configuredVersion() === 'auto' &&
      version === 'v1' &&
      err instanceof DevinApiError &&
      (err.status === 401 || err.status === 403) &&
      config.devinOrgId
    ) {
      log.info(`Devin: v1 returned ${err.status}, retrying on v3 (key=${maskKey(effectiveKey)})`);
      const v3Path = pathFor(op, sessionId, 'v3');
      const parsed = await devinFetch(method, v3Path, { body, signal, apiKey });
      _markAutoVersion(effectiveKey, 'v3');
      return { parsed, version: 'v3' };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────

/**
 * Create a new Devin session.
 *
 * @param {object} params
 * @param {string} params.prompt - Required. Initial task prompt.
 * @param {string} [params.snapshot_id]
 * @param {string} [params.playbook_id]
 * @param {string[]} [params.tags]
 * @param {string} [params.title]
 * @param {number} [params.max_acu_limit]
 * @param {boolean} [params.idempotent]
 * @param {boolean} [params.unlisted]
 * @param {object} [params.structured_output_schema]
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.apiKey] - Override the configured DEVIN_API_KEY.
 * @returns {Promise<{session_id: string, url: string, is_new_session?: boolean, _api_version?: 'v1'|'v3'}>}
 */
export async function createSession(params, opts = {}) {
  if (!params || typeof params.prompt !== 'string' || !params.prompt.length) {
    throw new DevinApiError('createSession: prompt is required', { status: 400 });
  }
  const body = { prompt: params.prompt };
  for (const k of ['snapshot_id', 'playbook_id', 'tags', 'title', 'max_acu_limit', 'idempotent', 'unlisted', 'knowledge_ids', 'secret_ids', 'session_secrets', 'structured_output_schema']) {
    if (params[k] !== undefined && params[k] !== null) body[k] = params[k];
  }
  log.debug(`Devin: createSession (acu=${params.max_acu_limit ?? 'default'}, snapshot=${params.snapshot_id || 'none'})`);
  const { parsed, version } = await sessionFetch('create', {
    body, signal: opts.signal, apiKey: opts.apiKey,
  });
  if (parsed && typeof parsed === 'object') parsed._api_version = version;
  return parsed;
}

/**
 * Get current session status + messages, normalized to the v1 shape so
 * handlers can treat both API surfaces interchangeably:
 *   {
 *     session_id,
 *     status,            // raw status string
 *     status_enum,       // working|blocked|finished|expired|... (derived for v3)
 *     messages: [        // each entry: {event_id, type, message, ...}
 *       { event_id, type: 'user_message'|'devin_message'|..., message, ... },
 *     ],
 *     structured_output,
 *     pull_request,      // {url, ...} or null
 *     ...
 *   }
 *
 * For v3, this issues TWO requests — the session detail and the
 * /messages page — and merges them. The extra round trip is acceptable
 * because the chat adapter polls on a 2s cadence anyway.
 */
export async function getSession(sessionId, opts = {}) {
  if (!sessionId) throw new DevinApiError('getSession: sessionId is required', { status: 400 });
  const { parsed, version } = await sessionFetch('get', {
    sessionId, signal: opts.signal, apiKey: opts.apiKey,
  });
  if (version === 'v1') {
    return parsed;
  }
  // v3: fetch messages separately and normalize.
  let messagesPayload = null;
  try {
    messagesPayload = await devinFetch(
      'GET',
      pathFor('list_messages', sessionId, 'v3') + '?limit=200',
      { signal: opts.signal, apiKey: opts.apiKey },
    );
  } catch (err) {
    // Best-effort — if messages 404 we still return the session shell so
    // status polls work. Log and continue.
    log.warn(`Devin v3 list_messages failed for ${sessionId.slice(0, 8)}: ${err.message}`);
  }
  return normalizeV3Session(parsed, messagesPayload);
}

/**
 * Send a follow-up message to an active session.
 * Returns null on success, or {detail} when the session is in a non-running state.
 */
export async function sendMessage(sessionId, message, opts = {}) {
  if (!sessionId) throw new DevinApiError('sendMessage: sessionId is required', { status: 400 });
  if (typeof message !== 'string' || !message.length) {
    throw new DevinApiError('sendMessage: message is required', { status: 400 });
  }
  // v1 expects {"message": "..."}; v3 also accepts {"message": "..."}.
  // We send the same body shape to both surfaces; sessionFetch picks the path.
  const { parsed } = await sessionFetch('send_message', {
    sessionId, body: { message }, signal: opts.signal, apiKey: opts.apiKey,
  });
  return parsed;
}

/** Terminal statuses where Devin is no longer making progress on the current turn. */
export const TERMINAL_STATUSES = new Set(['blocked', 'finished', 'expired']);

/** Statuses where the session is alive and accepting messages. */
export const ACTIVE_STATUSES = new Set(['working', 'resumed', 'resume_requested', 'resume_requested_frontend']);

/**
 * Convert a v3 session detail + paginated message list into the v1 shape
 * the rest of the codebase expects.
 *
 * v3 message shape (from /v3/organizations/<org>/sessions/<id>/messages):
 *   {items: [{event_id, source, message, created_at, ...}], end_cursor, has_next_page}
 *
 * v1 message shape (embedded in GET /v1/sessions/<id>):
 *   {messages: [{event_id, type: 'user_message'|'devin_message'|..., message, ...}]}
 *
 * source mapping:
 *   'user'     → type: 'user_message'
 *   'devin'    → type: 'devin_message'
 *   'agent'    → type: 'devin_message' (defensive — Devin docs use both)
 *   '<other>'  → type: '<source>'      (carry through verbatim)
 */
export function normalizeV3Session(sessionDetail, messagesPayload) {
  const out = { ...(sessionDetail || {}) };
  // v3 has `status` and `status_detail`; v1 has `status` + `status_enum`.
  // status_detail is the fine-grained working/blocked/expired hint we need.
  if (!out.status_enum) {
    out.status_enum = sessionDetail?.status_detail || sessionDetail?.status || null;
  }
  // pull_requests (v3, array) vs pull_request (v1, single object).
  if (!out.pull_request && Array.isArray(sessionDetail?.pull_requests) && sessionDetail.pull_requests.length > 0) {
    out.pull_request = sessionDetail.pull_requests[0];
  }
  const items = Array.isArray(messagesPayload?.items)
    ? messagesPayload.items
    : Array.isArray(messagesPayload)
      ? messagesPayload
      : [];
  out.messages = items.map((ev) => {
    if (!ev || typeof ev !== 'object') return ev;
    const src = String(ev.source || '').toLowerCase();
    let type = ev.type;
    if (!type) {
      if (src === 'user' || src === 'human') type = 'user_message';
      else if (src === 'devin' || src === 'agent' || src === 'assistant') type = 'devin_message';
      else type = src || 'event';
    }
    return { ...ev, type };
  });
  return out;
}

/**
 * Poll a session until it reaches a terminal status, an abort signal fires,
 * or the timeout elapses.
 *
 * When `progressDetector` is provided, the loop will NOT treat a terminal
 * status as final until the detector returns true for the polled session.
 * This handles the follow-up case: right after `sendMessage` the Devin API
 * may insert the new user_message into the session immediately while still
 * reporting status_enum=blocked from the prior turn. A naive event-after-
 * cursor check would exit before the actual assistant reply lands; the
 * detector lets the caller demand a meaningful state change (e.g., a new
 * assistant message after a given cursor).
 *
 * @param {string} sessionId
 * @param {object} opts
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.maxWaitMs]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.apiKey]
 * @param {(session: object) => void} [opts.onProgress] - Called after every successful poll.
 * @param {(session: object) => boolean} [opts.progressDetector] - Returns true
 *   when this poll's session contains the progress the caller is waiting for.
 *   Terminal exit is suppressed until it returns true.
 * @returns {Promise<{session: object, timedOut: boolean}>}
 */
export async function pollUntilTerminal(sessionId, opts = {}) {
  const intervalMs = Math.max(250, opts.intervalMs ?? config.devinPollIntervalMs);
  const maxWaitMs = Math.max(intervalMs, opts.maxWaitMs ?? config.devinMaxWaitMs);
  const deadline = Date.now() + maxWaitMs;
  const detector = typeof opts.progressDetector === 'function' ? opts.progressDetector : null;
  let session = null;
  while (true) {
    if (opts.signal?.aborted) throw new DevinApiError('aborted', { status: 499 });
    session = await getSession(sessionId, { signal: opts.signal, apiKey: opts.apiKey });
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress(session); } catch (e) { log.warn(`Devin onProgress hook threw: ${e.message}`); }
    }
    const statusEnum = session?.status_enum || null;
    if (statusEnum && TERMINAL_STATUSES.has(statusEnum)) {
      if (!detector || detector(session)) {
        return { session, timedOut: false };
      }
    }
    if (Date.now() >= deadline) {
      return { session, timedOut: true };
    }
    await sleep(Math.min(intervalMs, Math.max(50, deadline - Date.now())), opts.signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(new DevinApiError('aborted', { status: 499 })); };
    const cleanup = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) { cleanup(); return reject(new DevinApiError('aborted', { status: 499 })); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export { DevinApiError };

// Test helpers — exported so tests can introspect routing without
// touching internal globals.
export const _internals = {
  effectiveVersion,
  configuredVersion,
  pathFor,
  _autoVersionCache,
};
