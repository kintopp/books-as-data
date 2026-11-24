// Settings of the Streamable HTTP entry (src/http.js), apart from config.js so the stdio
// entry never reads them: a stray PORT in a Desktop env would warn on every launch.

import { posIntEnv } from './config.js';

// Railway sets PORT, RAILWAY_PUBLIC_DOMAIN and RAILWAY_GIT_COMMIT_SHA.
export const HTTP_PORT = posIntEnv('PORT', 3000, { min: 0, max: 65535 });
export const HTTP_MAX_BODY_BYTES = 1_048_576;
// Wall clock per request, just under Claude's 240 s per tool call: a long page scan
// makes many upstream requests, so a budget for one request's retries would cut it short.
export const HTTP_RESPONSE_TIMEOUT_MS = posIntEnv('SGBR_HTTP_RESPONSE_TIMEOUT_MS', 235_000, { min: 100, max: 1_200_000 });
export const HTTP_MAX_INFLIGHT = posIntEnv('SGBR_HTTP_MAX_INFLIGHT', 16, { min: 1, max: 10_000 });
// Comma-separated origins or `*.host` globs that replace the defaults; "*" allows any.
export const MCP_ALLOWED_ORIGINS = process.env.MCP_ALLOWED_ORIGINS;
// Comma-separated hosts; with none (and no RAILWAY_PUBLIC_DOMAIN) the Host check is off.
export const MCP_ALLOWED_HOSTS = process.env.MCP_ALLOWED_HOSTS;
export const RAILWAY_PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
export const DEPLOYED_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown';
export const HTTP_BUSY_RETRY_AFTER_S = 5;
export const HTTP_CORS_MAX_AGE_S = 600;
// After SIGTERM, calls in flight get this long before the process exits.
export const HTTP_DRAIN_MS = 10_000;
