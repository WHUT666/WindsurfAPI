/**
 * Devin session reuse cache — maps a conversation-history fingerprint to
 * an existing Devin session_id so multi-turn OpenAI-style chats land on
 * the same long-running Devin task instead of spawning a new ACU-burning
 * session every request.
 *
 * Strategy:
 *   - Fingerprint = SHA-256 of (callerKey + N-1 prior messages, normalized).
 *   - When a request arrives, look up the fingerprint of (messages without
 *     the new tail user turn). Hit → reuse session, send the tail as a
 *     follow-up. Miss → create a new session with the full conversation
 *     baked into the prompt.
 *   - After the turn completes, store the AFTER fingerprint (all messages
 *     including the new assistant reply) → session_id, so the NEXT request
 *     in the conversation hits the cache.
 *
 * Entries TTL out after DEVIN_SESSION_CACHE_TTL_MS (default 1h) to bound
 * memory and to avoid resurrecting sessions Devin has already expired.
 *
 * Single-process only — horizontal replicas have independent caches.
 * Explicit X-Devin-Session-Id header always overrides the cache.
 */

import { createHash } from 'crypto';
import { config, log } from './config.js';

const _cache = new Map(); // fingerprint -> { sessionId, expiresAt }

function ttlMs() {
  return Math.max(60_000, config.devinSessionCacheTtlMs ?? 60 * 60 * 1000);
}

function maxEntries() {
  return Math.max(10, config.devinSessionCacheMaxEntries ?? 1000);
}

/**
 * Normalize a message list into a stable string for hashing.
 * - Role + content only (drops volatile fields like name, tool_call_id timestamps)
 * - Coerces array-content to text by joining text parts
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return '';
    const role = String(m.role || 'user');
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .map((p) => (typeof p === 'string' ? p : (p?.text || '')))
        .filter(Boolean)
        .join('\n');
    }
    return `${role}\n${content}`;
  }).join('\n----\n');
}

/**
 * Compute a fingerprint for a conversation prefix.
 * @param {string} callerKey
 * @param {Array} messages
 * @returns {string} hex digest
 */
export function fingerprint(callerKey, messages) {
  const hash = createHash('sha256');
  hash.update(`devin-v1\n${callerKey || ''}\n`);
  hash.update(normalizeMessages(messages));
  return hash.digest('hex');
}

/** Look up a session for a given fingerprint. Returns null if absent / expired. */
export function lookup(fp) {
  if (!fp) return null;
  const entry = _cache.get(fp);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    _cache.delete(fp);
    return null;
  }
  return entry.sessionId;
}

/** Insert or refresh a fingerprint → session_id mapping. */
export function store(fp, sessionId) {
  if (!fp || !sessionId) return;
  if (_cache.size >= maxEntries()) {
    // Drop oldest entry (insertion order). Simple LRU-ish; good enough
    // for our use case where TTL does the heavy lifting.
    const oldestKey = _cache.keys().next().value;
    if (oldestKey) _cache.delete(oldestKey);
  }
  _cache.set(fp, { sessionId, expiresAt: Date.now() + ttlMs() });
  log.debug(`Devin session cache store fp=${fp.slice(0, 12)} session=${sessionId.slice(0, 8)} (size=${_cache.size})`);
}

/** Invalidate a specific session id across all fingerprints. */
export function invalidateSession(sessionId) {
  if (!sessionId) return 0;
  let removed = 0;
  for (const [fp, entry] of _cache.entries()) {
    if (entry.sessionId === sessionId) {
      _cache.delete(fp);
      removed++;
    }
  }
  return removed;
}

/** Clear the entire cache. Test-only. */
export function clear() {
  _cache.clear();
}

/** Internal: number of entries (test helper). */
export function size() {
  return _cache.size;
}
