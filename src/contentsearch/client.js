// Fetches IIIF Content Search (v1) results for one record: the service the
// website's viewer searches a volume with. Keyed by RECORD id — a scan id or a
// bare MMS id answers `null`, the same as zero hits. Shares the fetch loop
// (lib/http.js) and cache shape with the other REST clients; the body is read
// through a byte cap because the service neither pages nor declares a size.

import {
  GRAPHQL_ENDPOINT, CONTENT_SEARCH_MAX_BYTES, CONTENT_SEARCH_CACHE_MAX, CONTENT_SEARCH_CACHE_TTL_MS,
} from '../config.js';
import { createAsyncCache } from '../lib/cache.js';
import { authHeaders, authFingerprint } from '../lib/auth.js';
import { fetchWithRetry } from '../lib/http.js';
import { parseContentSearch } from '../lib/locate.js';

export class ContentSearchError extends Error {
  constructor(message, { status, tooLarge = false, transient = false } = {}) {
    super(message);
    this.name = 'ContentSearchError';
    this.status = status;
    this.tooLarge = tooLarge;
    this.transient = transient;
  }
}

const cache = createAsyncCache({ max: CONTENT_SEARCH_CACHE_MAX, ttlMs: CONTENT_SEARCH_CACHE_TTL_MS });

// The phrase goes out quoted, so the service matches it as a phrase rather than
// OR-ing its words. A stray `"` or `\` inside would unbalance the query, which
// the service answers with a silent `null`.
export function contentSearchUrl(recordId, phrase) {
  const q = `"${phrase.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
  return new URL(`/iiif/services/${encodeURIComponent(recordId)}/search?q=${encodeURIComponent(q)}`,
    GRAPHQL_ENDPOINT).href;
}

// The body as text, or null once it passes `maxBytes`.
async function readCapped(res, maxBytes) {
  if (!res.body) throw new ContentSearchError('Content search returned an empty body.', { status: res.status });
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Search one record's scan(s) for a phrase (cached). Returns the hit lines as
 * [{ scanId, page, box: [x, y, w, h], text }], in the service's relevance order;
 * throws ContentSearchError with `tooLarge` when the body passes the byte cap.
 */
export async function fetchContentSearch(recordId, phrase, opts = {}) {
  const url = contentSearchUrl(recordId, phrase);
  // An oversized answer is cached as null, so a repeat call does not stream
  // the capped megabytes again just to learn the same thing.
  const lines = await cache.fetchCached(
    `${authFingerprint()}:${url}`,
    (loaderSignal) => fetchWithRetry(url, {
      signal: loaderSignal,
      service: 'Content search service',
      makeError: (message, meta) => new ContentSearchError(message, meta),
      fetchOptions: { headers: authHeaders() },
      onOk: async (res) => {
        const body = await readCapped(res, CONTENT_SEARCH_MAX_BYTES);
        if (body == null) return null;
        try {
          return parseContentSearch(JSON.parse(body));
        } catch {
          throw new ContentSearchError('Content search returned malformed JSON.', { transient: true });
        }
      },
    }),
    { signal: opts.signal },
  );
  if (!lines) {
    throw new ContentSearchError(
      `Content search returned more than ${CONTENT_SEARCH_MAX_BYTES} bytes of hits.`, { tooLarge: true });
  }
  return lines;
}
