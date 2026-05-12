/**
 * Devin REST client — thin wrapper around api.devin.ai v1.
 *
 * Endpoints (https://docs.devin.ai/api-reference/sessions/*):
 *   POST   /v1/sessions                    create
 *   GET    /v1/sessions/{id}               status + messages
 *   POST   /v1/sessions/{id}/message       follow-up message
 *
 * Auth: `Authorization: Bearer <apk_user_* | apk_*>`. Same key style as
 * the official Devin SDK. Keys are pulled from DEVIN_API_KEY at call
 * time (not at import) so dashboard-driven key rotation works without
 * a process restart.
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
 * @returns {Promise<{session_id: string, url: string, is_new_session?: boolean}>}
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
  return devinFetch('POST', '/v1/sessions', { body, signal: opts.signal, apiKey: opts.apiKey });
}

/**
 * Get current session status + messages.
 * @returns GetSessionResponse — {session_id, status, status_enum, messages[], structured_output, pull_request, ...}
 */
export async function getSession(sessionId, opts = {}) {
  if (!sessionId) throw new DevinApiError('getSession: sessionId is required', { status: 400 });
  return devinFetch('GET', `/v1/sessions/${encodeURIComponent(sessionId)}`, {
    signal: opts.signal, apiKey: opts.apiKey,
  });
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
  return devinFetch('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/message`, {
    body: { message }, signal: opts.signal, apiKey: opts.apiKey,
  });
}

/** Terminal statuses where Devin is no longer making progress on the current turn. */
export const TERMINAL_STATUSES = new Set(['blocked', 'finished', 'expired']);

/** Statuses where the session is alive and accepting messages. */
export const ACTIVE_STATUSES = new Set(['working', 'resumed', 'resume_requested', 'resume_requested_frontend']);

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
