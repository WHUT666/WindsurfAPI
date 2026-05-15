/**
 * Devin Cloud REST passthrough — mounts every public Devin endpoint that
 * isn't already wrapped by the OpenAI-shaped /v1/chat/completions adapter
 * under `/v1/devin/*`, so callers can drive Devin's full toolchain
 * (sessions / attachments / knowledge / playbooks / secrets / enterprise
 * audit + consumption metrics) through a single endpoint without
 * juggling two API keys client-side.
 *
 * Why this lives next to handlers/devin-chat.js
 * ────────────────────────────────────────────
 * `handlers/devin-chat.js` adapts Devin → OpenAI: prompt → session,
 * polling, SSE faking, etc. It only covers conversation. Production
 * deployments also want to:
 *   • list / terminate / tag sessions (cleanup, dashboards)
 *   • upload context attachments before starting a session
 *   • CRUD org knowledge entries, playbooks, secrets
 *   • read consumption / audit logs at the enterprise level
 * Reimplementing those would add zero value — Devin's REST schema is
 * already stable. So this module pipes them through verbatim, only
 * inserting the operator's `DEVIN_API_KEY` as `Authorization: Bearer …`
 * and translating non-2xx into the same OpenAI-shaped error type
 * `handleDevinChat` emits so a single client error handler covers both.
 *
 * Routing
 * ───────
 *   /v1/devin/<rest>   →  https://api.devin.ai/<rest>
 *
 * Three Devin API surfaces are exposed under this single mount:
 *   • v1 (legacy, org-scoped via apk_* key): routes that start with
 *     `/sessions`, `/attachments`, `/knowledge`, `/playbooks`, `/secrets`
 *     (the v1 prefix is implied — kept for back-compat with the original
 *     mount before v3 existed).
 *   • v3 (current, RBAC + service-user tokens): routes that explicitly
 *     start with `/v3/organizations/:org_id/...` or `/v3/enterprise/...`.
 *     Callers must provide the org id themselves; the proxy does not
 *     guess it from `DEVIN_API_KEY` because a single service-user token
 *     may be scoped to multiple orgs in enterprise deployments.
 *   • v2 (legacy enterprise, personal-key-only): routes under
 *     `/v2/enterprise/...` for billing, consumption metrics, audit logs,
 *     enterprise API key management. Kept because v3 hasn't fully
 *     replaced these surfaces yet (consumption-cycles in particular).
 * Trailing query string and the HTTP method are preserved verbatim.
 *
 * Body shaping
 * ────────────
 *   • JSON requests are read, JSON-validated (we already require a
 *     `Content-Type: application/json` body for almost all endpoints),
 *     and re-serialised. This catches syntax errors before they reach
 *     Devin and returns a tidy 400 instead of an upstream 422.
 *   • Multipart `POST /v1/devin/attachments` is streamed through —
 *     we copy the raw request body + Content-Type header without
 *     buffering, so multi-megabyte uploads don't blow up memory.
 *   • `GET /v1/devin/attachments/:id/file` is also streamed, but Devin
 *     answers with a 302 to a presigned URL — we forward the redirect
 *     verbatim so the client downloads directly from the storage host
 *     and we never proxy the bytes.
 *
 * Auth surface
 * ────────────
 *   • The proxy's own `API_KEY` gate (validateApiKey in server.js) runs
 *     BEFORE this handler — callers must already have proven they're
 *     trusted to hit the proxy. This route only adds the `DEVIN_API_KEY`
 *     env value as the upstream bearer; we never accept a per-request
 *     Devin token from the caller (would defeat the point of the proxy).
 *   • If `DEVIN_API_KEY` isn't configured, every route returns 503 with
 *     the same shape `handleDevinChat` uses for the missing-key case.
 *
 * Endpoint allowlist
 * ──────────────────
 * Anything not in ALLOWED_ROUTES returns 404 so a typo doesn't silently
 * pivot to an unintended Devin endpoint. The list mirrors the public
 * Devin API surfaces (v1, v3 organization + enterprise, v2 enterprise)
 * from docs.devin.ai/llms.txt. Adding a new endpoint requires an
 * explicit entry here — silent passthrough of unknown routes would
 * expose any future preview endpoint the proxy operator hasn't audited.
 */

import { config, log } from '../config.js';

const DEFAULT_DEVIN_BASE = 'https://api.devin.ai';

/**
 * Allowlist of (METHOD, path-pattern) → upstream-path-template tuples.
 * Path patterns use `:id` placeholders that capture a single segment
 * (no slashes). Upstream templates substitute `${id}` back in.
 *
 * Keep this aligned with docs.devin.ai/llms.txt. New endpoints should be
 * added explicitly — silent passthrough of unknown routes would expose
 * any future preview endpoint the proxy operator hasn't audited.
 */
const ALLOWED_ROUTES = [
  // Sessions
  ['POST',   '/sessions',                    '/v1/sessions'],
  ['GET',    '/sessions',                    '/v1/sessions'],
  ['GET',    '/sessions/:id',                '/v1/sessions/${id}'],
  ['POST',   '/sessions/:id/message',        '/v1/sessions/${id}/message'],
  ['DELETE', '/sessions/:id',                '/v1/sessions/${id}'],
  ['POST',   '/sessions/:id/tags',           '/v1/sessions/${id}/tags'],
  ['PUT',    '/sessions/:id/tags',           '/v1/sessions/${id}/tags'],

  // Attachments
  ['POST',   '/attachments',                 '/v1/attachments'],
  ['GET',    '/attachments/:id/file',        '/v1/attachments/${id}/file'],

  // Knowledge
  ['GET',    '/knowledge',                   '/v1/knowledge'],
  ['POST',   '/knowledge',                   '/v1/knowledge'],
  ['PATCH',  '/knowledge/:id',               '/v1/knowledge/${id}'],
  ['PUT',    '/knowledge/:id',               '/v1/knowledge/${id}'],
  ['DELETE', '/knowledge/:id',               '/v1/knowledge/${id}'],

  // Playbooks
  ['GET',    '/playbooks',                   '/v1/playbooks'],
  ['GET',    '/playbooks/:id',               '/v1/playbooks/${id}'],
  ['POST',   '/playbooks',                   '/v1/playbooks'],
  ['PATCH',  '/playbooks/:id',               '/v1/playbooks/${id}'],
  ['PUT',    '/playbooks/:id',               '/v1/playbooks/${id}'],
  ['DELETE', '/playbooks/:id',               '/v1/playbooks/${id}'],

  // Secrets
  ['GET',    '/secrets',                     '/v1/secrets'],
  ['POST',   '/secrets',                     '/v1/secrets'],
  ['DELETE', '/secrets/:id',                 '/v1/secrets/${id}'],

  // ─────────────────────────────────────────────────────────────────────
  // v3 — current Devin API (service-user tokens, RBAC, org-scoped).
  // Callers must include `/v3/organizations/<org_id>/...` in the path;
  // we never guess org_id from the API key because a single service-user
  // token may be valid across multiple orgs in enterprise deployments.
  // Static segments (e.g. /sessions/insights) MUST come before capture
  // patterns (e.g. /sessions/:devin_id) so the matcher returns the
  // intended row when both have the same segment count.
  // ─────────────────────────────────────────────────────────────────────

  // v3 organizations — sessions (https://docs.devin.ai/api-reference/v3/sessions)
  ['POST',   '/v3/organizations/:org_id/sessions',                              '/v3/organizations/${org_id}/sessions'],
  ['GET',    '/v3/organizations/:org_id/sessions',                              '/v3/organizations/${org_id}/sessions'],
  ['GET',    '/v3/organizations/:org_id/sessions/insights',                     '/v3/organizations/${org_id}/sessions/insights'],
  ['GET',    '/v3/organizations/:org_id/sessions/:devin_id',                    '/v3/organizations/${org_id}/sessions/${devin_id}'],
  ['DELETE', '/v3/organizations/:org_id/sessions/:devin_id',                    '/v3/organizations/${org_id}/sessions/${devin_id}'],
  ['POST',   '/v3/organizations/:org_id/sessions/:devin_id/messages',           '/v3/organizations/${org_id}/sessions/${devin_id}/messages'],
  ['POST',   '/v3/organizations/:org_id/sessions/:devin_id/tags',               '/v3/organizations/${org_id}/sessions/${devin_id}/tags'],
  ['PUT',    '/v3/organizations/:org_id/sessions/:devin_id/tags',               '/v3/organizations/${org_id}/sessions/${devin_id}/tags'],
  ['POST',   '/v3/organizations/:org_id/sessions/:devin_id/archive',            '/v3/organizations/${org_id}/sessions/${devin_id}/archive'],
  ['POST',   '/v3/organizations/:org_id/sessions/:devin_id/attachments',        '/v3/organizations/${org_id}/sessions/${devin_id}/attachments'],
  ['POST',   '/v3/organizations/:org_id/sessions/:devin_id/insights/generate',  '/v3/organizations/${org_id}/sessions/${devin_id}/insights/generate'],

  // v3 organizations — knowledge notes (org-scoped)
  ['GET',    '/v3/organizations/:org_id/knowledge/notes',                       '/v3/organizations/${org_id}/knowledge/notes'],
  ['POST',   '/v3/organizations/:org_id/knowledge/notes',                       '/v3/organizations/${org_id}/knowledge/notes'],
  ['GET',    '/v3/organizations/:org_id/knowledge/notes/:note_id',              '/v3/organizations/${org_id}/knowledge/notes/${note_id}'],
  ['PATCH',  '/v3/organizations/:org_id/knowledge/notes/:note_id',              '/v3/organizations/${org_id}/knowledge/notes/${note_id}'],
  ['PUT',    '/v3/organizations/:org_id/knowledge/notes/:note_id',              '/v3/organizations/${org_id}/knowledge/notes/${note_id}'],
  ['DELETE', '/v3/organizations/:org_id/knowledge/notes/:note_id',              '/v3/organizations/${org_id}/knowledge/notes/${note_id}'],

  // v3 organizations — playbooks (org-scoped)
  ['GET',    '/v3/organizations/:org_id/playbooks',                             '/v3/organizations/${org_id}/playbooks'],
  ['POST',   '/v3/organizations/:org_id/playbooks',                             '/v3/organizations/${org_id}/playbooks'],
  ['GET',    '/v3/organizations/:org_id/playbooks/:playbook_id',                '/v3/organizations/${org_id}/playbooks/${playbook_id}'],
  ['PATCH',  '/v3/organizations/:org_id/playbooks/:playbook_id',                '/v3/organizations/${org_id}/playbooks/${playbook_id}'],
  ['PUT',    '/v3/organizations/:org_id/playbooks/:playbook_id',                '/v3/organizations/${org_id}/playbooks/${playbook_id}'],
  ['DELETE', '/v3/organizations/:org_id/playbooks/:playbook_id',                '/v3/organizations/${org_id}/playbooks/${playbook_id}'],

  // v3 organizations — secrets (org-scoped)
  ['GET',    '/v3/organizations/:org_id/secrets',                               '/v3/organizations/${org_id}/secrets'],
  ['POST',   '/v3/organizations/:org_id/secrets',                               '/v3/organizations/${org_id}/secrets'],
  ['DELETE', '/v3/organizations/:org_id/secrets/:secret_id',                    '/v3/organizations/${org_id}/secrets/${secret_id}'],

  // v3 organizations — attachments (org-scoped). The legacy v1 surface
  // also exposes /v1/attachments without org scope; both routes are
  // listed so callers can pick whichever matches their API key tier.
  ['POST',   '/v3/organizations/:org_id/attachments',                           '/v3/organizations/${org_id}/attachments'],
  ['GET',    '/v3/organizations/:org_id/attachments/:attachment_id/file',      '/v3/organizations/${org_id}/attachments/${attachment_id}/file'],

  // v3 organizations — service users (only the org-level ones; the
  // enterprise mint endpoint lives under /v3/enterprise/* below).
  ['GET',    '/v3/organizations/:org_id/service-users',                         '/v3/organizations/${org_id}/service-users'],
  ['POST',   '/v3/organizations/:org_id/service-users',                         '/v3/organizations/${org_id}/service-users'],
  ['GET',    '/v3/organizations/:org_id/service-users/:user_id',                '/v3/organizations/${org_id}/service-users/${user_id}'],
  ['DELETE', '/v3/organizations/:org_id/service-users/:user_id',                '/v3/organizations/${org_id}/service-users/${user_id}'],

  // v3 organizations — users (read-only org membership directory)
  ['GET',    '/v3/organizations/:org_id/users',                                 '/v3/organizations/${org_id}/users'],
  ['GET',    '/v3/organizations/:org_id/users/:user_id',                        '/v3/organizations/${org_id}/users/${user_id}'],

  // ─────────────────────────────────────────────────────────────────────
  // v3 enterprise — cross-org operations gated on enterprise admin role.
  // Sessions / knowledge / playbooks have org-equivalent endpoints above;
  // enterprise variants let an admin operate across every org in their
  // enterprise with a single token.
  // ─────────────────────────────────────────────────────────────────────

  ['GET',    '/v3/enterprise/sessions',                                         '/v3/enterprise/sessions'],
  ['GET',    '/v3/enterprise/sessions/:devin_id',                               '/v3/enterprise/sessions/${devin_id}'],
  ['DELETE', '/v3/enterprise/sessions/:devin_id',                               '/v3/enterprise/sessions/${devin_id}'],
  ['POST',   '/v3/enterprise/sessions/:devin_id/messages',                      '/v3/enterprise/sessions/${devin_id}/messages'],
  ['POST',   '/v3/enterprise/sessions/:devin_id/archive',                       '/v3/enterprise/sessions/${devin_id}/archive'],
  ['POST',   '/v3/enterprise/sessions/:devin_id/tags',                          '/v3/enterprise/sessions/${devin_id}/tags'],
  ['PUT',    '/v3/enterprise/sessions/:devin_id/tags',                          '/v3/enterprise/sessions/${devin_id}/tags'],

  // List the organizations under this enterprise (mentioned in the v3
  // migration guide as a current-API-only endpoint). Useful for ops
  // dashboards that want to enumerate orgs without falling back to v2.
  ['GET',    '/v3/enterprise/organizations',                                    '/v3/enterprise/organizations'],

  ['GET',    '/v3/enterprise/knowledge/notes',                                  '/v3/enterprise/knowledge/notes'],
  ['POST',   '/v3/enterprise/knowledge/notes',                                  '/v3/enterprise/knowledge/notes'],
  ['GET',    '/v3/enterprise/knowledge/notes/:note_id',                         '/v3/enterprise/knowledge/notes/${note_id}'],
  ['PATCH',  '/v3/enterprise/knowledge/notes/:note_id',                         '/v3/enterprise/knowledge/notes/${note_id}'],
  ['PUT',    '/v3/enterprise/knowledge/notes/:note_id',                         '/v3/enterprise/knowledge/notes/${note_id}'],
  ['DELETE', '/v3/enterprise/knowledge/notes/:note_id',                         '/v3/enterprise/knowledge/notes/${note_id}'],

  ['GET',    '/v3/enterprise/playbooks',                                        '/v3/enterprise/playbooks'],
  ['POST',   '/v3/enterprise/playbooks',                                        '/v3/enterprise/playbooks'],
  ['GET',    '/v3/enterprise/playbooks/:playbook_id',                           '/v3/enterprise/playbooks/${playbook_id}'],
  ['PATCH',  '/v3/enterprise/playbooks/:playbook_id',                           '/v3/enterprise/playbooks/${playbook_id}'],
  ['PUT',    '/v3/enterprise/playbooks/:playbook_id',                           '/v3/enterprise/playbooks/${playbook_id}'],
  ['DELETE', '/v3/enterprise/playbooks/:playbook_id',                           '/v3/enterprise/playbooks/${playbook_id}'],

  // ─────────────────────────────────────────────────────────────────────
  // v2 enterprise — legacy admin surface (audit logs, consumption,
  // billing, member management, enterprise API key provisioning).
  // Kept whitelisted because v3 hasn't ported every endpoint yet; ops
  // dashboards still need consumption-cycles for ACU budgeting.
  // ─────────────────────────────────────────────────────────────────────

  // Audit + consumption (read-only)
  ['GET',    '/v2/enterprise/audit-logs',                                       '/v2/enterprise/audit-logs'],
  ['GET',    '/v2/enterprise/consumption/cycles',                               '/v2/enterprise/consumption/cycles'],
  ['GET',    '/v2/enterprise/consumption/daily',                                '/v2/enterprise/consumption/daily'],
  ['GET',    '/v2/enterprise/consumption/user-daily',                           '/v2/enterprise/consumption/user-daily'],
  ['GET',    '/v2/enterprise/consumption/pr-metrics',                           '/v2/enterprise/consumption/pr-metrics'],
  ['GET',    '/v2/enterprise/consumption/searches-metrics',                     '/v2/enterprise/consumption/searches-metrics'],
  ['GET',    '/v2/enterprise/consumption/sessions-metrics',                     '/v2/enterprise/consumption/sessions-metrics'],
  ['GET',    '/v2/enterprise/consumption/usage-metrics',                        '/v2/enterprise/consumption/usage-metrics'],

  // API key management — provision / revoke single / revoke all
  ['GET',    '/v2/enterprise/api-keys',                                         '/v2/enterprise/api-keys'],
  ['POST',   '/v2/enterprise/api-keys',                                         '/v2/enterprise/api-keys'],
  ['DELETE', '/v2/enterprise/api-keys',                                         '/v2/enterprise/api-keys'],
  ['DELETE', '/v2/enterprise/api-keys/:key_id',                                 '/v2/enterprise/api-keys/${key_id}'],

  // Members
  ['GET',    '/v2/enterprise/members',                                          '/v2/enterprise/members'],
  ['POST',   '/v2/enterprise/members/invite',                                   '/v2/enterprise/members/invite'],
  ['POST',   '/v2/enterprise/members/roles/migrate',                            '/v2/enterprise/members/roles/migrate'],
  ['PATCH',  '/v2/enterprise/members/roles',                                    '/v2/enterprise/members/roles'],
  ['GET',    '/v2/enterprise/members/organizations',                            '/v2/enterprise/members/organizations'],
  ['GET',    '/v2/enterprise/members/roles',                                    '/v2/enterprise/members/roles'],
  ['GET',    '/v2/enterprise/members/:member_id',                               '/v2/enterprise/members/${member_id}'],
  ['DELETE', '/v2/enterprise/members/:member_id',                               '/v2/enterprise/members/${member_id}'],

  // Organizations + IdP groups
  ['GET',    '/v2/enterprise/organizations',                                    '/v2/enterprise/organizations'],
  ['POST',   '/v2/enterprise/organizations',                                    '/v2/enterprise/organizations'],
  ['GET',    '/v2/enterprise/groups',                                           '/v2/enterprise/groups'],
  ['POST',   '/v2/enterprise/groups',                                           '/v2/enterprise/groups'],
  ['GET',    '/v2/enterprise/groups/:group_id',                                 '/v2/enterprise/groups/${group_id}'],

  // Org group limits
  ['GET',    '/v2/enterprise/org-group-limits',                                 '/v2/enterprise/org-group-limits'],
  ['PATCH',  '/v2/enterprise/org-group-limits',                                 '/v2/enterprise/org-group-limits'],

  // VPC / infrastructure visibility
  ['GET',    '/v2/enterprise/infrastructure/hypervisors',                       '/v2/enterprise/infrastructure/hypervisors'],
];

/**
 * Match `path` (already stripped of the `/v1/devin` prefix) and `method`
 * against ALLOWED_ROUTES.
 *
 * Returns { upstreamPath, params } when matched, otherwise null. We try
 * an exact match first (no params) so static routes ('/sessions') win
 * over `:id` capture patterns ('/sessions/:id').
 */
export function matchRoute(method, path) {
  const upMethod = String(method || '').toUpperCase();
  for (const [m, pattern, template] of ALLOWED_ROUTES) {
    if (m !== upMethod) continue;
    const params = matchPattern(pattern, path);
    if (!params) continue;
    const upstreamPath = template.replace(/\$\{(\w+)\}/g, (_, k) =>
      encodeURIComponent(params[k] ?? ''),
    );
    return { upstreamPath, params };
  }
  return null;
}

function matchPattern(pattern, path) {
  const pp = pattern.split('/');
  const pa = path.split('/');
  if (pp.length !== pa.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) {
      if (!pa[i]) return null;
      params[pp[i].slice(1)] = decodeURIComponent(pa[i]);
    } else if (pp[i] !== pa[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Map a Node http.IncomingMessage onto the upstream Devin REST call and
 * pipe the response back into `res`.
 *
 * Returns a Promise that resolves once the response is fully written.
 * Errors from the upstream fetch are caught and translated into a 502
 * JSON body. Bytes are streamed for both directions — the JSON
 * round-trip happens entirely inside Node's fetch implementation, but
 * for binary endpoints (attachment download) we read the upstream
 * body as a stream and pipe it without buffering.
 */
export async function handleDevinPassthrough(req, res) {
  // Strip the /v1/devin prefix off the request URL so callers can use
  // either `/v1/devin/sessions` or `/v1/devin/sessions/xyz?param=1`.
  const url = new URL(req.url, 'http://x');
  const fullPath = url.pathname;
  if (!fullPath.startsWith('/v1/devin')) {
    return jsonError(res, 404, 'not_found', `Unknown path: ${fullPath}`);
  }
  let subPath = fullPath.slice('/v1/devin'.length) || '/';
  if (subPath !== '/' && subPath.endsWith('/')) subPath = subPath.slice(0, -1);
  if (subPath === '/' || subPath === '') {
    return jsonError(res, 404, 'not_found', 'Use /v1/devin/<endpoint>. See docs/devin-provider.md.');
  }

  const match = matchRoute(req.method, subPath);
  if (!match) {
    return jsonError(
      res,
      404,
      'not_found',
      `No Devin passthrough route for ${req.method} /v1/devin${subPath}.`,
    );
  }

  const apiKey = config.devinApiKey;
  if (!apiKey) {
    // Mirror the shape handleDevinChat uses so a single client-side
    // error handler covers both surfaces.
    return jsonError(res, 503, 'configuration_error', 'Devin provider is not configured (set DEVIN_API_KEY).');
  }

  const base = (config.devinApiBase || DEFAULT_DEVIN_BASE).replace(/\/+$/, '');
  const upstreamUrl = base + match.upstreamPath + (url.search || '');
  const contentType = String(req.headers['content-type'] || '');
  const isMultipart = contentType.toLowerCase().startsWith('multipart/');
  const isBinaryUpload = contentType && !contentType.startsWith('application/json') && !isMultipart && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH');

  const upstreamHeaders = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': req.headers['accept'] || 'application/json',
  };

  let body;
  try {
    if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') {
      body = undefined;
    } else if (isMultipart || isBinaryUpload) {
      // Stream the raw request body. Node's fetch accepts a ReadableStream
      // here; we forward the original Content-Type / Content-Length so the
      // remote multipart parser sees the same boundary the client sent.
      upstreamHeaders['Content-Type'] = contentType;
      if (req.headers['content-length']) {
        upstreamHeaders['Content-Length'] = String(req.headers['content-length']);
      }
      body = nodeReqToWebStream(req);
    } else {
      // JSON path — buffer + re-serialize so we can return a clean 400
      // instead of a 422 from Devin's pydantic validator.
      const raw = await readBodyAsString(req);
      if (raw.length === 0) {
        body = undefined;
      } else {
        try {
          const parsed = JSON.parse(raw);
          upstreamHeaders['Content-Type'] = 'application/json';
          body = JSON.stringify(parsed);
        } catch (err) {
          return jsonError(res, 400, 'invalid_request', `Invalid JSON in body: ${err.message}`);
        }
      }
    }
  } catch (err) {
    if (err && err.statusCode) {
      return jsonError(res, err.statusCode, 'invalid_request', err.message || 'Bad request');
    }
    return jsonError(res, 400, 'invalid_request', err?.message || 'Bad request');
  }

  log.debug(`Devin passthrough: ${req.method} ${subPath} → ${match.upstreamPath}`);

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body,
      // Some attachment downloads return 302 — let the client follow it
      // (we forward the redirect rather than transparently following it,
      // so presigned-URL handling stays in the caller's network).
      redirect: 'manual',
      // Node fetch needs duplex:'half' when uploading a stream.
      duplex: body && typeof body !== 'string' ? 'half' : undefined,
    });
  } catch (err) {
    log.warn(`Devin passthrough fetch error: ${err.message}`);
    return jsonError(res, 502, 'upstream_error', `Network error calling Devin API: ${err.message}`);
  }

  // Forward status + selected response headers. We intentionally do NOT
  // copy Set-Cookie / Server / etc — Devin doesn't use them today, and
  // pass-through cookies would be a cross-tenant leak vector.
  const responseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
  const passHeaders = ['content-type', 'content-length', 'location', 'content-disposition', 'etag'];
  for (const h of passHeaders) {
    const v = upstreamRes.headers.get(h);
    if (v) responseHeaders[h.replace(/(^|-)([a-z])/g, (_, p, c) => p + c.toUpperCase())] = v;
  }
  res.writeHead(upstreamRes.status, responseHeaders);

  // Stream the body. For non-2xx responses we still stream the body
  // verbatim — Devin returns JSON error details there and the client
  // wants to see them.
  if (!upstreamRes.body) {
    res.end();
    return;
  }
  try {
    // Web ReadableStream → Node Writable
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !res.writableEnded) {
        if (!res.write(Buffer.from(value))) {
          await once(res, 'drain');
        }
      }
    }
  } catch (err) {
    log.warn(`Devin passthrough body stream error: ${err.message}`);
  } finally {
    if (!res.writableEnded) res.end();
  }
}

function jsonError(res, status, type, message) {
  const data = JSON.stringify({ error: { message, type } });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBodyAsString(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 10 * 1024 * 1024;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Wrap a Node IncomingMessage as a Web ReadableStream so the global fetch
 * can stream it upstream. Used for multipart/binary uploads where
 * buffering the entire payload would defeat the point of streaming.
 */
function nodeReqToWebStream(req) {
  return new ReadableStream({
    start(controller) {
      req.on('data', (chunk) => {
        try { controller.enqueue(new Uint8Array(chunk)); } catch { /* closed */ }
      });
      req.on('end', () => {
        try { controller.close(); } catch { /* closed */ }
      });
      req.on('error', (err) => {
        try { controller.error(err); } catch { /* closed */ }
      });
    },
    cancel() {
      try { req.destroy(); } catch { /* already destroyed */ }
    },
  });
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

// Test helpers — keep at the bottom so production callers don't import them by accident.
export { ALLOWED_ROUTES };
