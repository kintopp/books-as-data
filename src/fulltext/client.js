// Fetches plain OCR full text from the REST gbooks service and normalizes it.
// The timeout/retry/Retry-After loop is shared via lib/http.js; bodies are cached
// (LRU+TTL) so offset pagination over one book downloads it once. The endpoint
// mislabels the body as text/html and sends an unreliable content-length — treat
// it as plain text and measure the decoded string.

import { FULLTEXT_ENDPOINT_BASE, FULLTEXT_CACHE_MAX, FULLTEXT_CACHE_TTL_MS } from '../config.js';
import { createAsyncCache } from '../lib/cache.js';
import { authHeaders, authFingerprint } from '../lib/auth.js';
import { fetchWithRetry } from '../lib/http.js';
import { normalizeOcrText } from '../lib/fulltext.js';

export class FullTextError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'FullTextError';
    this.status = status;
  }
}

const cache = createAsyncCache({ max: FULLTEXT_CACHE_MAX, ttlMs: FULLTEXT_CACHE_TTL_MS });

export function fullTextUrl(scanId) {
  return `${FULLTEXT_ENDPOINT_BASE}/get_gb_fulltext/${encodeURIComponent(scanId)}`;
}

// Scope cache entries to the auth context so a body fetched anonymously is never
// served for a request carrying an ACL token (or vice-versa).
function cacheKey(scanId) {
  return `${authFingerprint()}:${scanId}`;
}

function download(scanId, opts = {}) {
  return fetchWithRetry(fullTextUrl(scanId), {
    signal: opts.signal,
    service: 'Full-text service',
    makeError: (message, meta) => new FullTextError(message, meta),
    fetchOptions: { headers: authHeaders() },
    onOk: async (res) => normalizeOcrText(await res.text()),
  });
}

/**
 * Fetch normalized full text for a scan id (cached). Returns { text, url }.
 * Empty/whitespace body → text is '' (caller decides how to report "no text").
 */
export async function fetchFullText(scanId, opts = {}) {
  const text = await cache.fetchCached(
    cacheKey(scanId),
    // Loader runs on the cache's shared internal signal, not this caller's —
    // see cache.js cancellation semantics.
    (loaderSignal) => download(scanId, { signal: loaderSignal }),
    { signal: opts.signal },
  );
  return { text, url: fullTextUrl(scanId) };
}
