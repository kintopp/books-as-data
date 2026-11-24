// GraphQL-over-HTTP client for the RDV endpoint. Node 24 gives us global fetch +
// AbortController, so no HTTP dependency. The timeout/retry/Retry-After loop lives
// in lib/http.js; this module adds GraphQL `errors[]` parsing (which can coexist
// with a 200 + data) and an LRU+TTL response cache. The corpus is read-only, so
// caching is safe and coalesces the identical calls tool-chaining produces (one
// record resolved by three tools; a facet query's total re-counted per facet).

import { createHash } from 'node:crypto';
import { GRAPHQL_ENDPOINT, GRAPHQL_CACHE_MAX, GRAPHQL_CACHE_TTL_MS } from '../config.js';
import { authHeaders, authFingerprint } from '../lib/auth.js';
import { throwIfAborted } from '../lib/async.js';
import { fetchWithRetry } from '../lib/http.js';
import { createAsyncCache } from '../lib/cache.js';

export class GraphQLError extends Error {
  constructor(message, { errors, status } = {}) {
    super(message);
    this.name = 'GraphQLError';
    this.errors = errors;
    this.status = status;
  }
}

const cache = createAsyncCache({ max: GRAPHQL_CACHE_MAX, ttlMs: GRAPHQL_CACHE_TTL_MS });

// Test seam: drop cached responses so unit tests that reuse an (operation,
// variables) pair each observe a fresh fetch. Production never needs it — the
// read-only corpus lets entries simply expire.
export function clearGraphqlCache() { cache.clear(); }

// Deterministic serialization of the variables object (sorted keys, recursive) so
// two logically-identical requests produce one cache key regardless of key order.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

// Cache key = auth context + a hash of the operation document + canonical
// variables. Auth is folded in via authFingerprint() (never the raw token), so an
// anonymous response is never served to a token-bearing caller or vice-versa.
function cacheKey(query, variables) {
  const body = createHash('sha256')
    .update(stableStringify([query, variables ?? {}]))
    .digest('hex').slice(0, 32);
  return `${authFingerprint()}:${body}`;
}

function execute(query, variables, opts) {
  return fetchWithRetry(GRAPHQL_ENDPOINT, {
    signal: opts.signal,
    service: 'GraphQL endpoint',
    makeError: (message, meta) => new GraphQLError(message, meta),
    fetchOptions: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ query, variables }),
    },
    onOk: async (res) => {
      let body;
      try {
        body = await res.json();
      } catch (err) {
        // Our own timer firing mid-read must reach the loop's timeout relabel.
        if (err?.name === 'AbortError') throw err;
        // A 2xx with a non-JSON body is a proxy/gateway artefact (error page,
        // truncated stream), not a GraphQL response. Typed — and marked
        // transient so the shared retry loop treats it like a network flake.
        const parseError = new GraphQLError(
          'GraphQL endpoint returned a non-JSON response (unparseable body on HTTP 200).',
          { status: res.status },
        );
        parseError.transient = true;
        throw parseError;
      }
      if (body === null || typeof body !== 'object') {
        const shapeError = new GraphQLError(
          'GraphQL endpoint returned an unexpected response (no JSON object on HTTP 200).',
          { status: res.status },
        );
        shapeError.transient = true;
        throw shapeError;
      }
      if (body.errors && body.errors.length) {
        // Query/logic errors — not retryable. Surface the backend messages.
        throw new GraphQLError(body.errors.map((e) => e.message).join('; '), { errors: body.errors });
      }
      return body.data;
    },
  });
}

/**
 * Execute a GraphQL operation. Returns the `data` object, or throws GraphQLError.
 * Identical (operation, variables) calls within the cache TTL are coalesced; a
 * thrown error is never cached, so a transient failure won't poison later calls.
 * @param {string} query   GraphQL document
 * @param {object} variables
 * @param {{signal?: AbortSignal, cache?: boolean}} [opts]  optional external cancellation;
 *   `cache: false` bypasses the response cache, for a caller that must observe a fresh
 *   backend answer (e.g. to cross-check two reads).
 */
export async function graphqlRequest(query, variables, opts = {}) {
  throwIfAborted(opts.signal); // cancelled callers never reach cache or network
  if (opts.cache === false) return execute(query, variables, { signal: opts.signal });
  const data = await cache.fetchCached(
    cacheKey(query, variables),
    // The loader runs on the cache's shared internal signal (aborted only when
    // every de-duplicated caller has aborted) — never on one caller's signal,
    // which would let one cancelled tool call fail an unrelated concurrent one.
    (loaderSignal) => execute(query, variables, { signal: loaderSignal }),
    { signal: opts.signal },
  );
  // Hand each caller an independent copy. The cache holds one shared object and
  // shapers read the response freely; a clone keeps a future in-place edit from
  // corrupting later cache hits — cheap next to the network call it elides.
  return data == null ? data : structuredClone(data);
}
