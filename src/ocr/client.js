// Fetches per-page OCR assets (hOCR or plain text) from the mediaserver host
// root. Shares the timeout/retry/Retry-After loop (lib/http.js) and the LRU+TTL
// cache shape with the fulltext/image clients, but is addressed by full URL
// (built by src/lib/ocr.js#ocrAssetUrl) rather than by scan id, since it serves
// two different asset kinds (hocr/text) at two different paths for the same page.

import {
  OCR_CACHE_MAX, OCR_CACHE_TTL_MS, OCR_PAGE_TEXT_CACHE_MAX, OCR_PAGE_CONCURRENCY,
} from '../config.js';
import { createAsyncCache } from '../lib/cache.js';
import { authHeaders, authFingerprint } from '../lib/auth.js';
import { fetchWithRetry } from '../lib/http.js';
import { isAbort } from '../lib/async.js';
import { ocrAssetUrl } from '../lib/ocr.js';
import { normalizeOcrText } from '../lib/fulltext.js';

export class OcrError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'OcrError';
    this.status = status;
  }
}

const cache = createAsyncCache({ max: OCR_CACHE_MAX, ttlMs: OCR_CACHE_TTL_MS });
const pageTextCache = createAsyncCache({ max: OCR_PAGE_TEXT_CACHE_MAX, ttlMs: OCR_CACHE_TTL_MS });

// Scope cache entries to the auth context so a body fetched anonymously is never
// served for a request carrying an ACL token (or vice-versa).
function cacheKey(url) {
  return `${authFingerprint()}:${url}`;
}

function download(url, opts = {}) {
  return fetchWithRetry(url, {
    signal: opts.signal,
    service: 'OCR service',
    makeError: (message, meta) => new OcrError(message, meta),
    fetchOptions: { headers: authHeaders() },
    onOk: async (res) => res.text(),
  });
}

/**
 * Fetch the raw body of an OCR asset URL (cached), unmodified — the hOCR parser
 * reads it as-is. Plain page text goes through fetchOcrPageText instead.
 */
export async function fetchOcrAsset(url, opts = {}) {
  return cache.fetchCached(
    cacheKey(url),
    // Loader runs on the cache's shared internal signal, not this caller's —
    // see cache.js cancellation semantics.
    (loaderSignal) => download(url, { signal: loaderSignal }),
    { signal: opts.signal },
  );
}

/**
 * One scan page's normalized OCR text (cached). Returns { exists, text }: the
 * mediaserver answers a page past the volume's end with 404 and a blank page
 * with an empty 200, so only the 404 means "no such page".
 */
export async function fetchOcrPageText(scanId, page, opts = {}) {
  const url = ocrAssetUrl(scanId, page, 'text');
  return pageTextCache.fetchCached(
    cacheKey(url),
    (loaderSignal) => download(url, { signal: loaderSignal }).then(
      (raw) => ({ exists: true, text: normalizeOcrText(raw) }),
      (err) => {
        if (err instanceof OcrError && err.status === 404) return { exists: false, text: '' };
        throw err;
      },
    ),
    { signal: opts.signal },
  );
}

/**
 * Read scan pages from..to (inclusive) through a rolling pool of
 * OCR_PAGE_CONCURRENCY requests, launched in page order. Pages run 1..N, so no
 * page past a missing one is launched, and `stop(result)` returning true halts
 * further launches too; pages already in flight still settle, so the result
 * covers from..(its last page) without gaps. Returns { pages, stopped }: every
 * settled page sorted, as { page, exists, text } or { page, error } for a fetch
 * that failed after retries, and whether `stop` cut the read short.
 * `onSettled(count)` is called with the number of pages settled so far.
 */
export async function scanOcrPages(scanId, from, to, { signal, stop, onSettled } = {}) {
  const pages = [];
  let next = from;
  let end = to;
  let stopped = false;
  const worker = async () => {
    while (next <= end) {
      const page = next++;
      let result;
      try {
        result = { page, ...(await fetchOcrPageText(scanId, page, { signal })) };
      } catch (error) {
        if (isAbort(error, signal)) {
          end = 0;
          throw error;
        }
        result = { page, error };
      }
      pages.push(result);
      if (result.exists === false) end = Math.min(end, page - 1);
      if (stop?.(result) && next <= end) {
        stopped = true;
        end = next - 1;
      }
      onSettled?.(pages.length);
    }
  };
  await Promise.all(Array.from({ length: OCR_PAGE_CONCURRENCY }, worker));
  return { pages: pages.sort((a, b) => a.page - b.page), stopped };
}

/**
 * Scan pages from..to as [{ page, text }], ending at the volume's last page: a
 * result ending before `to` means the volume ended there. A page that fails to
 * fetch fails the read, since a span with a hole in it would misquote the book.
 */
export async function fetchOcrPageTexts(scanId, from, to, opts = {}) {
  const { pages } = await scanOcrPages(scanId, from, to, { ...opts, stop: (r) => Boolean(r.error) });
  const read = [];
  for (const r of pages) {
    if (r.error) throw r.error;
    if (!r.exists) break;
    read.push({ page: r.page, text: r.text });
  }
  return read;
}

/**
 * The volume's last page below `missing` (a page known not to exist), found by
 * bisection in about log2(missing) cached page requests. 0 when page 1 is
 * missing too — the scan has no OCR at all.
 */
export async function findLastOcrPage(scanId, missing, opts = {}) {
  if (!(await fetchOcrPageText(scanId, 1, opts)).exists) return 0;
  let lo = 1;
  let hi = missing;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await fetchOcrPageText(scanId, mid, opts)).exists) lo = mid;
    else hi = mid;
  }
  return lo;
}
