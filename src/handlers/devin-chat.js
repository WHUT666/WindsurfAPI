/**
 * Devin Sessions → OpenAI Chat Completions adapter.
 *
 * Translates a synchronous /v1/chat/completions request into:
 *   1. Find-or-create a Devin session (fingerprint cache + X-Devin-Session-Id header)
 *   2. Send the new user turn (only on cache HIT; new sessions get the
 *      full conversation baked into the initial prompt)
 *   3. Poll session until status_enum reaches a terminal state
 *      ('blocked' / 'finished' / 'expired') OR DEVIN_MAX_WAIT_MS elapses
 *   4. Aggregate Devin-side messages emitted during this turn into a
 *      single assistant message and return in OpenAI shape
 *
 * Stream support is pseudo-streaming: we poll the session and emit
 * deltas as new Devin messages appear, keeping the SSE alive with
 * heartbeat comments. This matches how the rest of the proxy bridges
 * polled upstreams (cascade) to SSE clients.
 *
 * The adapter is registered as `provider: 'devin-sessions'` in
 * src/models.js. handleChatCompletions short-circuits to handleDevinChat
 * before touching the Windsurf account pool / language server code path.
 */

import { randomUUID } from 'crypto';
import { createSession, getSession, sendMessage, pollUntilTerminal, TERMINAL_STATUSES, DevinApiError } from '../devin-client.js';
import { fingerprint as fpDevin, lookup as cacheLookup, store as cacheStore, invalidateSession as cacheInvalidateSession } from '../devin-session-cache.js';
import { config, log } from '../config.js';
import { getModelInfo, resolveModel } from '../models.js';

const HEARTBEAT_MS = 15_000;

/**
 * Extract a single header value, case-insensitively, from a request headers
 * object (Node http: lowercased; raw fetch: original case).
 */
function header(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (typeof headers.get === 'function') {
    return headers.get(lower) || headers.get(name) || null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

/**
 * Convert OpenAI `messages[]` (system/user/assistant/tool) into a single
 * Devin prompt string. Used when creating a new session from a fresh
 * conversation. Devin's prompt is plain text — multimodal parts are
 * coerced to text descriptions.
 */
function messagesToPrompt(messages, { promptPrefix = '' } = {}) {
  const lines = [];
  if (promptPrefix) lines.push(promptPrefix);
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || 'user');
    const text = contentToText(m.content);
    if (role === 'system') {
      // System messages become a labelled preamble. Devin doesn't have a
      // first-class system role, but it respects guidance in the prompt.
      lines.push(`<system>\n${text}\n</system>`);
    } else if (role === 'tool') {
      const name = m.name || m.tool_call_id || 'tool';
      lines.push(`<tool_result name="${name}">\n${text}\n</tool_result>`);
    } else {
      lines.push(`<${role}>\n${text}\n</${role}>`);
    }
  }
  return lines.filter(Boolean).join('\n\n');
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const parts = [];
  for (const p of content) {
    if (typeof p === 'string') { parts.push(p); continue; }
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string') { parts.push(p.text); continue; }
    if (p.type === 'image_url' && p.image_url?.url) {
      parts.push(`[image: ${shortenUrl(p.image_url.url)}]`);
      continue;
    }
    if (p.type === 'input_image' && p.image_url) {
      parts.push(`[image: ${shortenUrl(p.image_url)}]`);
      continue;
    }
    if (p.type === 'tool_use') {
      parts.push(`[tool_use ${p.name || ''}: ${JSON.stringify(p.input || {})}]`);
      continue;
    }
    if (p.type === 'tool_result') {
      parts.push(`[tool_result: ${contentToText(p.content)}]`);
      continue;
    }
  }
  return parts.join('\n');
}

function shortenUrl(url) {
  if (typeof url !== 'string') return '';
  if (url.startsWith('data:')) return url.slice(0, 32) + '…(base64)';
  return url.length > 120 ? url.slice(0, 120) + '…' : url;
}

/**
 * Pick the tail user turn that should be sent as a follow-up message
 * when reusing an existing session. Returns null if the last message
 * isn't a user message (in which case we bake the whole history into
 * a fresh session instead).
 */
function tailUserMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;
  const text = contentToText(last.content);
  return text || null;
}

/** Devin SessionMessage event types that represent assistant-side output. */
const ASSISTANT_MESSAGE_TYPES = new Set([
  'devin_message',
  'assistant_message',
  'agent_message',
]);

/**
 * Extract new assistant-side messages emitted since `sinceEventId`.
 * Returns an array of message bodies (each one a separate Devin event),
 * plus the cursor advanced past the last extracted event.
 *
 * When sinceEventId is null, treat the start of the session as the boundary
 * (everything assistant-side counts). If sinceEventId is non-null but not
 * found in the message list (Devin pruned old events), fall back to the
 * messages after the last user_message event.
 */
function extractNewAssistantMessages(session, sinceEventId) {
  if (!session?.messages?.length) {
    return { messages: [], newSinceEventId: sinceEventId, prInfo: null };
  }
  let collecting = sinceEventId == null;
  let cursor = sinceEventId;
  const out = [];
  for (const ev of session.messages) {
    if (!ev) continue;
    const eventId = ev.event_id || '';
    if (!collecting) {
      if (eventId === sinceEventId) collecting = true;
      continue;
    }
    if (eventId) cursor = eventId;
    if (ASSISTANT_MESSAGE_TYPES.has(ev.type)) {
      const msg = typeof ev.message === 'string' ? ev.message : '';
      if (msg) out.push(msg);
    }
  }
  // Fallback: sinceEventId wasn't in the list — return everything after
  // the last user_message event.
  if (!collecting) {
    let started = false;
    out.length = 0;
    cursor = sinceEventId;
    for (const ev of session.messages) {
      if (!ev) continue;
      if (ev.type === 'user_message' || ev.type === 'human_message') {
        started = true;
        out.length = 0;
        continue;
      }
      if (!started) continue;
      if (ev.event_id) cursor = ev.event_id;
      if (ASSISTANT_MESSAGE_TYPES.has(ev.type)) {
        const msg = typeof ev.message === 'string' ? ev.message : '';
        if (msg) out.push(msg);
      }
    }
  }
  return {
    messages: out,
    newSinceEventId: cursor,
    prInfo: session?.pull_request || null,
  };
}

/** Convenience: joined-text view used by the non-stream path. */
function extractNewAssistantText(session, sinceEventId) {
  const { messages, newSinceEventId, prInfo } = extractNewAssistantMessages(session, sinceEventId);
  return { text: messages.join('\n\n'), newSinceEventId, prInfo };
}

/** Last event_id in the session messages — used as a starting cursor. */
function lastEventId(session) {
  if (!session?.messages?.length) return null;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i]?.event_id) return session.messages[i].event_id;
  }
  return null;
}

/**
 * Build the per-model Devin session params based on the resolved model.
 *   devin       → no overrides (Devin chooses ACU budget)
 *   devin-fast  → max_acu_limit = 5
 *   devin-deep  → max_acu_limit = 50
 */
function deriveSessionParamsForModel(modelKey, info, body) {
  const params = {};
  if (info?.devinMaxAcu) params.max_acu_limit = info.devinMaxAcu;
  // Allow per-request override via OpenAI metadata.devin_max_acu — clients
  // that want fine-grained budget control can supply it without us
  // inventing dozens of model variants.
  const metaAcu = body?.metadata?.devin_max_acu;
  if (Number.isFinite(metaAcu) && metaAcu > 0) params.max_acu_limit = metaAcu;
  if (config.devinDefaultSnapshotId) params.snapshot_id = config.devinDefaultSnapshotId;
  if (body?.metadata?.devin_snapshot_id) params.snapshot_id = String(body.metadata.devin_snapshot_id);
  if (config.devinDefaultPlaybookId) params.playbook_id = config.devinDefaultPlaybookId;
  if (body?.metadata?.devin_playbook_id) params.playbook_id = String(body.metadata.devin_playbook_id);
  if (body?.metadata?.devin_title) params.title = String(body.metadata.devin_title);
  if (body?.metadata?.devin_structured_output_schema && typeof body.metadata.devin_structured_output_schema === 'object') {
    params.structured_output_schema = body.metadata.devin_structured_output_schema;
  }
  return params;
}

/**
 * Resolve the Devin session for this request:
 *   1. Explicit X-Devin-Session-Id header → use that, send tail user message.
 *   2. Fingerprint cache hit on messages[0..n-1] → reuse, send tail.
 *   3. Otherwise create a new session with the full conversation as prompt.
 */
async function resolveSession({ messages, callerKey, headers, modelKey, modelInfo, body, signal }) {
  const explicit = header(headers, 'x-devin-session-id');
  if (explicit) {
    log.info(`Devin: explicit session id from header session=${explicit.slice(0, 8)}`);
    const tail = tailUserMessage(messages);
    if (tail) {
      try {
        const res = await sendMessage(explicit, tail, { signal });
        if (res && typeof res === 'object' && res.detail) {
          // Session is suspended/finished — surface clean error
          throw new DevinApiError(`Devin session ${explicit} not running: ${res.detail}`, { status: 409 });
        }
      } catch (err) {
        if (err instanceof DevinApiError && err.status === 404) {
          throw new DevinApiError(`Devin session ${explicit} not found`, { status: 404 });
        }
        throw err;
      }
    }
    return { sessionId: explicit, source: 'header', cursor: null };
  }

  // Try fingerprint reuse — hash everything except the tail user message.
  let cursor = null;
  if (messages.length >= 2 && messages[messages.length - 1]?.role === 'user') {
    const prefix = messages.slice(0, -1);
    const fp = fpDevin(callerKey || '', prefix);
    const sid = cacheLookup(fp);
    if (sid) {
      const tail = tailUserMessage(messages);
      if (tail) {
        try {
          // Snapshot event cursor BEFORE sending so we know what's new.
          const snapshot = await getSession(sid, { signal });
          cursor = lastEventId(snapshot);
          const sendRes = await sendMessage(sid, tail, { signal });
          if (sendRes && typeof sendRes === 'object' && sendRes.detail) {
            log.info(`Devin: cached session ${sid.slice(0, 8)} not running (${sendRes.detail}) — creating new`);
            cacheInvalidateSession(sid);
          } else {
            log.info(`Devin: reuse cached session=${sid.slice(0, 8)} fp=${fp.slice(0, 12)}`);
            return { sessionId: sid, source: 'fingerprint', cursor };
          }
        } catch (err) {
          if (err instanceof DevinApiError && (err.status === 404 || err.status === 410)) {
            log.info(`Devin: cached session ${sid.slice(0, 8)} stale (${err.status}) — creating new`);
            cacheInvalidateSession(sid);
          } else {
            throw err;
          }
        }
      }
    }
  }

  // Fresh session
  const prompt = messagesToPrompt(messages);
  const params = deriveSessionParamsForModel(modelKey, modelInfo, body);
  const created = await createSession({ ...params, prompt }, { signal });
  log.info(`Devin: created session=${created.session_id?.slice(0, 8)} model=${modelKey}`);
  return { sessionId: created.session_id, source: 'created', cursor: null, sessionUrl: created.url };
}

/**
 * Public entry — handle a Devin chat completions request.
 * Returns the same shape as handleChatCompletions:
 *   non-stream: { status, body, headers? }
 *   stream:     { status, stream: true, headers, handler(res) }
 */
export async function handleDevinChat(body, context = {}) {
  if (!config.devinApiKey) {
    return {
      status: 503,
      body: {
        error: {
          message: 'Devin provider is not configured (set DEVIN_API_KEY).',
          type: 'configuration_error',
        },
      },
    };
  }
  const modelKey = resolveModel(body.model) || 'devin';
  const modelInfo = getModelInfo(modelKey);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const callerKey = context.callerKey || body.__callerKey || '';
  const headers = context.headers || {};
  const wantStream = !!body.stream;
  const chatId = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24);
  const created = Math.floor(Date.now() / 1000);
  const displayModel = modelInfo?.name || modelKey;

  if (messages.length === 0) {
    return { status: 400, body: { error: { message: 'messages must be non-empty', type: 'invalid_request' } } };
  }

  const abortController = new AbortController();

  let resolved;
  try {
    resolved = await resolveSession({
      messages, callerKey, headers, modelKey, modelInfo, body,
      signal: abortController.signal,
    });
  } catch (err) {
    return devinErrorToOpenAI(err, displayModel);
  }
  const sessionId = resolved.sessionId;
  let cursor = resolved.cursor;

  if (!wantStream) {
    let session;
    try {
      const result = await pollUntilTerminal(sessionId, {
        signal: abortController.signal,
        onProgress: () => {},
      });
      session = result.session;
      const timedOut = result.timedOut;
      const { text, newSinceEventId, prInfo } = extractNewAssistantText(session, cursor);
      // Persist fingerprint→session for the next turn so the user can keep
      // chatting against this session via the OpenAI client without
      // tracking session ids themselves.
      const afterMessages = [...messages, { role: 'assistant', content: text }];
      cacheStore(fpDevin(callerKey, afterMessages), sessionId);
      const content = composeAssistantContent(text, prInfo, session);
      return {
        status: 200,
        headers: {
          'x-devin-session-id': sessionId,
          'x-devin-status': session?.status_enum || session?.status || '',
        },
        body: buildOpenAIResponseBody({
          chatId, created, displayModel, content, session,
          finishReason: timedOut ? 'length' : 'stop',
          usagePrompt: messages, usageCompletion: text,
        }),
      };
    } catch (err) {
      return devinErrorToOpenAI(err, displayModel);
    }
  }

  // Streaming (pseudo-SSE via polling)
  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'x-devin-session-id': sessionId,
    },
    async handler(res) {
      const send = (data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      const sendDone = () => {
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      };
      const sendError = (message, type = 'upstream_error', code = null) => {
        send({
          id: chatId, object: 'chat.completion.chunk', created, model: displayModel,
          choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
          error: { message, type, code },
        });
        sendDone();
      };

      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, HEARTBEAT_MS);
      const stopHeartbeat = () => clearInterval(heartbeat);
      res.on('close', stopHeartbeat);

      // Send the role chunk immediately so clients see the assistant boundary.
      send({
        id: chatId, object: 'chat.completion.chunk', created, model: displayModel,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });

      let fullText = '';
      let lastSession = null;
      let timedOut = false;
      try {
        const result = await pollUntilTerminal(sessionId, {
          signal: abortController.signal,
          onProgress: (session) => {
            lastSession = session;
            const { messages: newMsgs, newSinceEventId } = extractNewAssistantMessages(session, cursor);
            if (newMsgs.length > 0) {
              for (const msg of newMsgs) {
                const sep = fullText ? '\n\n' : '';
                const delta = sep + msg;
                fullText += delta;
                send({
                  id: chatId, object: 'chat.completion.chunk', created, model: displayModel,
                  choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                });
              }
              cursor = newSinceEventId || cursor;
            }
          },
        });
        lastSession = result.session;
        timedOut = result.timedOut;
        const { prInfo } = extractNewAssistantText(result.session, null);
        const tail = composeStreamTail(result.session, prInfo);
        if (tail) {
          send({
            id: chatId, object: 'chat.completion.chunk', created, model: displayModel,
            choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
          });
          fullText += tail;
        }
      } catch (err) {
        stopHeartbeat();
        const oa = devinErrorToOpenAI(err, displayModel);
        sendError(oa.body?.error?.message || err.message, oa.body?.error?.type || 'upstream_error');
        return;
      }

      // Final chunk + cache
      const afterMessages = [...messages, { role: 'assistant', content: fullText }];
      cacheStore(fpDevin(callerKey, afterMessages), sessionId);

      send({
        id: chatId, object: 'chat.completion.chunk', created, model: displayModel,
        choices: [{ index: 0, delta: {}, finish_reason: timedOut ? 'length' : 'stop' }],
        usage: estimateUsage(messages, fullText),
        x_devin: {
          session_id: sessionId,
          status: lastSession?.status_enum || lastSession?.status || '',
          pull_request_url: lastSession?.pull_request?.url || null,
        },
      });
      stopHeartbeat();
      sendDone();
    },
  };
}

function composeAssistantContent(text, prInfo, session) {
  let body = text || '';
  const tail = composeStreamTail(session, prInfo);
  if (tail) body += tail;
  if (!body) body = '(Devin session produced no assistant message before timeout.)';
  return body;
}

function composeStreamTail(session, prInfo) {
  const parts = [];
  if (prInfo?.url) parts.push(`\n\n---\nPull request: ${prInfo.url}`);
  if (session?.status_enum && session.status_enum !== 'finished' && session.status_enum !== 'blocked') {
    parts.push(`\n\n_(session status: ${session.status_enum})_`);
  }
  return parts.join('');
}

function buildOpenAIResponseBody({ chatId, created, displayModel, content, session, finishReason, usagePrompt, usageCompletion }) {
  return {
    id: chatId,
    object: 'chat.completion',
    created,
    model: displayModel,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: estimateUsage(usagePrompt, usageCompletion),
    x_devin: {
      session_id: session?.session_id || null,
      status: session?.status_enum || session?.status || '',
      pull_request_url: session?.pull_request?.url || null,
      structured_output: session?.structured_output ?? null,
    },
  };
}

/**
 * Rough token estimate — Devin doesn't return token counts. We use the
 * standard ~4-chars-per-token heuristic to fill OpenAI's required usage
 * fields. Clients that need exact billing should use the Devin ACU
 * surface, not this estimate.
 */
function estimateUsage(promptMessages, completionText) {
  const promptChars = (Array.isArray(promptMessages) ? promptMessages : [])
    .reduce((n, m) => n + (contentToText(m?.content)?.length || 0), 0);
  const completionChars = completionText ? completionText.length : 0;
  const promptTokens = Math.max(1, Math.round(promptChars / 4));
  const completionTokens = Math.max(0, Math.round(completionChars / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function devinErrorToOpenAI(err, displayModel) {
  if (err?.name === 'AbortError') {
    return { status: 499, body: { error: { message: 'Client disconnected', type: 'aborted' } } };
  }
  if (err instanceof DevinApiError) {
    let type = 'upstream_error';
    if (err.status === 401 || err.status === 403) type = 'authentication_error';
    else if (err.status === 404) type = 'not_found_error';
    else if (err.status === 429) type = 'rate_limit_exceeded';
    else if (err.status === 503) type = 'service_unavailable';
    else if (err.status >= 500) type = 'upstream_server_error';
    else if (err.status >= 400 && err.status < 500) type = 'invalid_request';
    return {
      status: err.status || 502,
      body: {
        error: {
          message: `Devin (${displayModel}): ${err.message}`,
          type,
          code: err.status ? String(err.status) : null,
        },
      },
    };
  }
  log.error(`Devin handler unexpected error: ${err?.stack || err?.message || err}`);
  return {
    status: 500,
    body: { error: { message: `Devin (${displayModel}): ${err?.message || 'unknown error'}`, type: 'internal_error' } },
  };
}

// Re-exports for tests.
export { messagesToPrompt, contentToText, tailUserMessage, extractNewAssistantText, extractNewAssistantMessages, lastEventId };
