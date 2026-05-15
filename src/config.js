import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env file manually (zero dependencies)
function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      // Strip inline comments for unquoted values: PORT=3003 # port → 3003
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

// `sharedDataDir` is the cluster-shared root: a single accounts.json lives
// here so add-account writes from any replica are visible to every replica
// after restart. `dataDir` is replica-local under REPLICA_ISOLATE=1 and is
// safe to use for telemetry that does not need cross-replica visibility.
// See issue #67 — when the two were collapsed into one path, every
// docker-compose upgrade orphaned the user's accounts.json under a stale
// `replica-${HOSTNAME}` subdir.
const sharedDataDir = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : ROOT;
const dataDir = (() => {
  let base = sharedDataDir;
  if (process.env.REPLICA_ISOLATE === '1' && process.env.HOSTNAME) {
    base = join(base, `replica-${process.env.HOSTNAME}`);
  }
  return base;
})();

try {
  mkdirSync(sharedDataDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
} catch {}

export function defaultLsBinaryPath(platform = process.platform, arch = process.arch, home = process.env.HOME) {
  if (platform === 'darwin') {
    const name = arch === 'arm64' ? 'language_server_macos_arm' : 'language_server_macos_x64';
    return `${home}/.windsurf/${name}`;
  }
  const name = arch === 'arm64' ? 'language_server_linux_arm' : 'language_server_linux_x64';
  return `/opt/windsurf/${name}`;
}

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  // Bind host. Defaults to all interfaces. Set HOST=127.0.0.1 (or BIND_HOST=)
  // for localhost-only deployments — when bound non-locally, missing API_KEY /
  // DASHBOARD_PASSWORD switches to fail-closed instead of default-allow.
  host: process.env.HOST || process.env.BIND_HOST || '0.0.0.0',
  apiKey: process.env.API_KEY || '',
  dataDir,
  sharedDataDir,

  codeiumAuthToken: process.env.CODEIUM_AUTH_TOKEN || '',
  codeiumApiKey: process.env.CODEIUM_API_KEY || '',
  codeiumEmail: process.env.CODEIUM_EMAIL || '',
  codeiumPassword: process.env.CODEIUM_PASSWORD || '',

  codeiumApiUrl: process.env.CODEIUM_API_URL || 'https://server.self-serve.windsurf.com',
  defaultModel: process.env.DEFAULT_MODEL || 'claude-4.5-sonnet-thinking',
  maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Language server
  lsBinaryPath: process.env.LS_BINARY_PATH || defaultLsBinaryPath(),
  lsPort: parseInt(process.env.LS_PORT || '42100', 10),

  // Dashboard
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // Proxy testing
  allowPrivateProxyHosts: process.env.ALLOW_PRIVATE_PROXY_HOSTS === '1',

  // Devin Sessions provider (https://docs.devin.ai/api-reference/overview)
  // Optional upstream that wraps Cognition's official Devin REST API as
  // an OpenAI-compatible /v1/chat/completions endpoint. Independent of
  // the Windsurf account pool — set DEVIN_API_KEY to enable.
  devinApiKey: process.env.DEVIN_API_KEY || '',
  devinApiBase: process.env.DEVIN_API_BASE || 'https://api.devin.ai',
  // API surface the chat adapter should target.
  //   'v1'   — legacy /v1/sessions/... (org-scoped via apk_* key)
  //   'v3'   — current /v3/organizations/<org>/sessions/... (cog_*, apk_user_*, etc.)
  //   'auto' — try v1 first; on 401/403, fall back to v3 and cache the choice.
  // The passthrough at /v1/devin/* is unaffected — it routes by path prefix.
  devinApiVersion: (process.env.DEVIN_API_VERSION || 'auto').toLowerCase(),
  // Required for v3 (and used by /v1/devin/_proxy/info for introspection).
  // Service-user tokens (`cog_*`) and personal access tokens (`apk_user_*`) only
  // authenticate against v3 endpoints, which need the org_id baked into the path.
  devinOrgId: process.env.DEVIN_ORG_ID || '',
  devinDefaultSnapshotId: process.env.DEVIN_DEFAULT_SNAPSHOT_ID || '',
  devinDefaultPlaybookId: process.env.DEVIN_DEFAULT_PLAYBOOK_ID || '',
  // Poll cadence and wall-clock cap for synchronous chat completions.
  // Devin sessions are async tasks; we poll the GET /v1/sessions/{id}
  // endpoint every devinPollIntervalMs until a terminal status is reached
  // or devinMaxWaitMs elapses.
  devinPollIntervalMs: parseInt(process.env.DEVIN_POLL_INTERVAL_MS || '2000', 10),
  devinMaxWaitMs: parseInt(process.env.DEVIN_MAX_WAIT_MS || '600000', 10),
  // Fingerprint-based session reuse cache (process-local; X-Devin-Session-Id
  // header always overrides).
  devinSessionCacheTtlMs: parseInt(process.env.DEVIN_SESSION_CACHE_TTL_MS || String(60 * 60 * 1000), 10),
  devinSessionCacheMaxEntries: parseInt(process.env.DEVIN_SESSION_CACHE_MAX_ENTRIES || '1000', 10),
};

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

export const log = {
  debug: (...args) => currentLevel <= 0 && console.log('[DEBUG]', ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', ...args),
  error: (...args) => currentLevel <= 3 && console.error('[ERROR]', ...args),
};
