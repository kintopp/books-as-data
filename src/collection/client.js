// Cached, anonymous fetch of a parent IIIF Collection manifest, used by
// sgbr_locate_text for multivolume sibling enumeration. Sibling client to
// ocr/client.js / fulltext/client.js / image/client.js: same fetchWithRetry +
// createAsyncCache shape, but see the AUTH POLICY note on fetchCollectionChildren
// for why this one sends no auth headers and keys its cache by URL alone. The pure
// Collection-JSON parser stays in lib/locate.js (parseCollectionChildren). See
// rdv-iiif-page-ocr.md *(internal)* for the shape of multivolume Collection
// manifests.

import { COLLECTION_CACHE_MAX, COLLECTION_CACHE_TTL_MS } from '../config.js';
import { createAsyncCache } from '../lib/cache.js';
import { fetchWithRetry } from '../lib/http.js';
import { parseCollectionChildren } from '../lib/locate.js';

class CollectionFetchError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'CollectionFetchError';
    this.status = status;
  }
}

// Cache keyed by URL ALONE (no auth-fingerprint scoping): this fetch sends NO
// auth headers (see fetchCollectionChildren doc comment below), so its response
// is auth-independent and the extra key dimension is unnecessary.
const collectionCache = createAsyncCache({ max: COLLECTION_CACHE_MAX, ttlMs: COLLECTION_CACHE_TTL_MS });

function downloadCollection(url, opts = {}) {
  return fetchWithRetry(url, {
    signal: opts.signal,
    service: 'IIIF manifest service',
    makeError: (message, meta) => new CollectionFetchError(message, meta),
    fetchOptions: {}, // deliberately no authHeaders() — see doc comment below
    onOk: (res) => res.json(),
  });
}

/**
 * Fetch a record's IIIF manifest URL and return its ordered child scan ids
 * (null when it isn't a Collection, or on any failure). AUTH POLICY: sends NO
 * auth headers and is keyed by URL alone — the manifest URL comes from
 * record data (digital.iiif_manifest), not one of the configured,
 * assertAuthEndpointsSecure-validated endpoints, so forwarding
 * SGBR_ACCESS_TOKEN to an arbitrary record-supplied URL could leak the
 * credential to an unexpected/non-HTTPS host. Sibling enumeration is
 * best-effort and anonymous: IIIF manifests are public metadata, and if a
 * restricted work's manifest 401s, enumeration degrades to null while the
 * resolved volume itself is still searched.
 */
export async function fetchCollectionChildren(manifestUrl, opts = {}) {
  try {
    const json = await collectionCache.fetchCached(
      manifestUrl,
      (loaderSignal) => downloadCollection(manifestUrl, { signal: loaderSignal }),
      { signal: opts.signal },
    );
    return parseCollectionChildren(json);
  } catch {
    return null;
  }
}
