// Fetches page image bytes from the IIIF mediaserver. Shares the timeout/retry/
// Retry-After loop (lib/http.js) and the LRU+TTL cache with the other clients, but
// returns a binary image body instead of normalized text — no text handling here.

import { IMAGE_CACHE_MAX, IMAGE_INFO_CACHE_MAX, IMAGE_CACHE_TTL_MS } from '../config.js';
import { createAsyncCache } from '../lib/cache.js';
import { authHeaders, authFingerprint } from '../lib/auth.js';
import { fetchWithRetry } from '../lib/http.js';

export class ImageError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'ImageError';
    this.status = status;
  }
}

const cache = createAsyncCache({ max: IMAGE_CACHE_MAX, ttlMs: IMAGE_CACHE_TTL_MS });

// Scope cache entries to the auth context so an image fetched anonymously is
// never served for a request carrying an ACL token (or vice-versa).
function cacheKey(url) {
  return `${authFingerprint()}:${url}`;
}

function download(url, opts = {}) {
  return fetchWithRetry(url, {
    signal: opts.signal,
    service: 'Image service',
    makeError: (message, meta) => new ImageError(message, meta),
    fetchOptions: { headers: authHeaders() },
    onOk: async (res) => {
      // A 200 with a non-image body (an HTML error page, a JSON fault) must not
      // be cached or handed to the model as pixels. A missing header still
      // defaults to JPEG — the mediaserver labels real images, and test stubs
      // may not send headers at all.
      const mimeType = (res.headers.get('content-type') || '').split(';')[0].trim() || 'image/jpeg';
      if (!mimeType.startsWith('image/')) {
        // The unread body is cancelled by fetchWithRetry's catch, like every
        // other abandoned response.
        throw new ImageError(
          `Image service returned ${mimeType} instead of an image.`,
          { status: res.status },
        );
      }
      return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
    },
  });
}

/**
 * Fetch image bytes for a IIIF Image API URL (cached). Returns
 * { buffer, mimeType }.
 */
export async function fetchImage(url, opts = {}) {
  const { buffer, mimeType } = await cache.fetchCached(
    cacheKey(url),
    // Loader runs on the cache's shared internal signal, not this caller's —
    // see cache.js cancellation semantics.
    (loaderSignal) => download(url, { signal: loaderSignal }),
    { signal: opts.signal },
  );
  // Hand each caller its own copy — mirrors graphqlRequest's structuredClone
  // posture, so an in-place edit can never corrupt later cache hits.
  return { buffer: Buffer.from(buffer), mimeType };
}

// Its own cache: the values are a few bytes of JSON against the image cache's
// megabytes, so sharing one LRU would let a couple of page fetches evict the
// dimensions every later crop of the same page needs.
const infoCache = createAsyncCache({ max: IMAGE_INFO_CACHE_MAX, ttlMs: IMAGE_CACHE_TTL_MS });

/**
 * Native pixel dimensions for a page, from its IIIF info.json (cached).
 * Returns `{ width, height }`, or **null** when the description can't be read.
 *
 * Null is a routine outcome, not an error: this only feeds the delivery clamp,
 * and a page whose description is missing must still be fetchable at the
 * requested size. Never let a failure here fail the image call.
 */
export async function fetchImageInfo(url, opts = {}) {
  try {
    return await infoCache.fetchCached(
      cacheKey(url),
      (loaderSignal) => fetchWithRetry(url, {
        signal: loaderSignal,
        service: 'Image service',
        makeError: (message, meta) => new ImageError(message, meta),
        fetchOptions: { headers: authHeaders() },
        onOk: async (res) => {
          const body = await res.json();
          const width = Number(body?.width);
          const height = Number(body?.height);
          return width > 0 && height > 0 ? { width, height } : null;
        },
      }),
      { signal: opts.signal },
    );
  } catch (err) {
    // A caller's own cancellation must still propagate — only the description
    // being unavailable is the routine outcome this swallows.
    if (opts.signal?.aborted) throw err;
    return null;
  }
}
