// A canned RDV backend for offline tests: ONE routing table, TWO transports.
//
// `makeRouter` owns the fixtures; `installFetchStub` (replaces globalThis.fetch)
// and `startStubServer` (a real loopback socket) are thin adapters over it, so
// the two transports cannot drift apart. Subprocess tests need the socket:
// scripts/cli.mjs spawns src/index.js as a child, so nothing in this process can
// stub its fetch — it needs a real endpoint and the env vars cli.mjs forwards.
//
// IMPORTANT — endpoints are read at MODULE LOAD. src/config.js resolves
// SGBR_*_ENDPOINT into `export const` at import time, and ESM hoists all imports
// above module-body code, so a test file CANNOT set the env at the top and then
// statically import a src module. Two consequences:
//   * In-process tests use installFetchStub, which needs no env at all (the URL
//     the client builds is matched by shape, not by host).
//   * Subprocess tests use startStubServer and pass `env` to the child, where
//     the child's own module load happens after the vars are set.
// Do not "simplify" the in-process path to use the socket; it would reintroduce
// the hoisting problem for no benefit.
//
// Unrouted requests are a hard failure, never a silent empty result: a test that
// accidentally reaches the real network must break loudly.

import { createServer } from 'node:http';
import { once } from 'node:events';
import { parse, Kind } from 'graphql';

// ── fixture builders ─────────────────────────────────────────────────────────

// A raw RDV record from a { key: [entry, ...] } spec, where an entry is a string
// (text only) or an object { text, link, extended }. Same shape as the `raw`
// helper in record.test.js — deliberately duplicated rather than shared, since
// that file tests the shaper against it and this one feeds whole handlers.
export function record(id, spec) {
  return {
    id,
    result: Object.entries(spec).map(([key, entries]) => ({
      key,
      metadata: entries.map((e) => (typeof e === 'string' ? { text: e } : e)),
    })),
  };
}

// A `search` payload. `records` are raw records (from `record()`); `highlights`
// can be attached per record by the caller before passing them in.
export function searchPayload(records, { totalCount = records.length, counts = {} } = {}) {
  return {
    totalCount,
    parsedError: null,
    countResult: {
      resultCount: counts.resultCount ?? totalCount,
      digitalizedCount: counts.digitalizedCount ?? 0,
      allACLCount: counts.allACLCount ?? 0,
      optionalCount: counts.optionalCount ?? 0,
    },
    results: records,
  };
}

// A `facetFiltered` payload from [value, count] pairs (string dimension) or from
// explicit typed value objects.
//
// The two totals are easy to transpose, so they are derived here once, from the
// buckets, according to their meaning:
//   `count`   — DISTINCT buckets for this dimension (→ distinct_values)
//   `nbTotal` — RECORDS carrying the dimension (→ matching_records, the
//               numerator of coverage_pct)
// A test that needs them to disagree with the buckets (a truncated bucket list,
// say) should pass explicit typed values rather than growing overrides here.
export function facetPayload(name, values, { othersCount = 0 } = {}) {
  const typed = values.map((v) => (Array.isArray(v)
    ? { __typename: 'FacetValueString', strVal: v[0], count: v[1] }
    : v));
  return {
    name,
    group: 'strings',
    count: typed.length,
    nbTotal: typed.reduce((n, v) => n + (v.count || 0), 0),
    othersCount,
    values: typed,
  };
}

// ── the router ───────────────────────────────────────────────────────────────

// `query Search(` → 'Search'. The documents in graphql/operations.js all carry a
// named operation, so this is stable without parsing GraphQL properly.
export function graphqlOperation(query) {
  return /query\s+(\w+)/.exec(String(query || ''))?.[1] ?? null;
}

// Answer only what the query selected, as the real backend does. Fixtures are
// written whole, so without this a field dropped from an operation document
// (`link`/`extended`, `highlights`, …) would still reach the shaper offline.
function project(value, selectionSet) {
  if (value == null || !selectionSet) return value;
  if (Array.isArray(value)) return value.map((v) => project(v, selectionSet));
  const out = {};
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) {
      const name = sel.name.value;
      if (Object.hasOwn(value, name)) out[sel.alias?.value ?? name] = project(value[name], sel.selectionSet);
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      const type = sel.typeCondition?.name.value;
      if (!type || value.__typename === type) Object.assign(out, project(value, sel.selectionSet));
    } else {
      throw new Error(`stub-backend: unsupported GraphQL selection kind ${sel.kind}`);
    }
  }
  return out;
}

function projectToQuery(data, query) {
  const op = parse(query).definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION);
  return project(data, op.selectionSet);
}

const NOT_FOUND = { status: 404, contentType: 'text/plain', body: 'not found' };

/**
 * Build a request router over a fixture spec. Every section is optional; a
 * request that matches no fixture returns 404, EXCEPT one whose URL matches no
 * known shape at all, which throws (a stray request must not look like a
 * legitimate miss).
 *
 * @param {object} fx
 * @param {Record<string, object|Function>} [fx.graphql]  operation name → data
 *   object (the `data` field of the GraphQL envelope) or (variables) => data,
 *   trimmed to the fields the request's query selects.
 *   A value of `{ errors: [...] }` is sent as a GraphQL error envelope instead.
 * @param {Record<string, string>} [fx.fulltext]  scan id → whole-book OCR text
 * @param {Record<string, string>} [fx.ocr]       'text:<page>' | 'hocr:<page>' → body
 * @param {Record<string, Buffer|string>} [fx.image]  'page:<n>' → bytes
 * @param {Record<string, object>} [fx.info]  'page:<n>' → IIIF info.json body
 *   (`{ width, height }`). Omit to answer 404 — the delivery clamp then has no
 *   native size and is skipped, which is a supported path, not a broken test.
 * @param {Record<string, object|null|string>} [fx.search]  record id → IIIF Content
 *   Search body (`null` is the service's zero-hit answer); a string is sent raw.
 *   Absent → 404.
 * @param {Record<string, object|null>} [fx.manifest]  full URL → IIIF Collection
 *   JSON, or `null` to answer that URL with a 404. The null is not decoration:
 *   every other section infers "legitimate miss" from the URL's SHAPE, but a
 *   manifest URL comes from record data and has no shape to match, so an absent
 *   key stays a hard failure and a deliberate 404 must be spelled out.
 */
export function makeRouter(fx = {}) {
  return function route(url, init = {}) {
    const u = String(url);
    // Not every server folds an empty path segment, so a request must not carry one.
    if (/^[a-z]+:\/\/[^/]+.*\/\//.test(u.split('?')[0])) throw new Error(`stub-backend: empty path segment in ${u}`);

    // GraphQL is the only POST; identify the operation from the body.
    if ((init.method || 'GET').toUpperCase() === 'POST') {
      const { query, variables } = JSON.parse(init.body || '{}');
      const op = graphqlOperation(query);
      const fixture = fx.graphql?.[op];
      if (fixture === undefined) {
        throw new Error(`stub-backend: no fixture for GraphQL operation "${op}"`);
      }
      const data = typeof fixture === 'function' ? fixture(variables) : fixture;
      const envelope = data && data.errors ? { errors: data.errors } : { data: projectToQuery(data, query) };
      return { status: 200, contentType: 'application/json', body: JSON.stringify(envelope) };
    }

    if (fx.manifest && Object.hasOwn(fx.manifest, u)) {
      return fx.manifest[u] === null
        ? NOT_FOUND
        : { status: 200, contentType: 'application/json', body: JSON.stringify(fx.manifest[u]) };
    }

    // IIIF Content Search: …/iiif/services/<record id>/search?q=…
    const cs = /\/iiif\/services\/([^/?]+)\/search\?q=/.exec(u);
    if (cs) {
      const body = fx.search?.[decodeURIComponent(cs[1])];
      if (body === undefined) return NOT_FOUND;
      return { status: 200, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) };
    }

    // Whole-book full text: …/get_gb_fulltext/<scanId>
    const ft = /\/get_gb_fulltext\/([^/?]+)$/.exec(u);
    if (ft) {
      const body = fx.fulltext?.[decodeURIComponent(ft[1])];
      return body === undefined
        ? NOT_FOUND
        : { status: 200, contentType: 'text/html', body };
    }

    // Per-page OCR asset: …/gbooks/<scan>_<8 digits>.<txt|html>/item
    const asset = /\/gbooks\/[^/]*_(\d{8})\.(txt|html)\/item$/.exec(u);
    if (asset) {
      const body = fx.ocr?.[`${asset[2] === 'txt' ? 'text' : 'hocr'}:${Number(asset[1])}`];
      return body === undefined
        ? NOT_FOUND // the shape the mediaserver uses past the last page
        : { status: 200, contentType: 'text/plain', body };
    }

    // IIIF image description: …/gbooks/<scan>_<8 digits>.jp2/info.json. Must be
    // matched BEFORE the image route below, whose pattern also accepts it.
    // Absent fixture → 404, which is the routine "no native dimensions" path:
    // the delivery clamp is skipped and the image still serves at the requested
    // size, so tests that don't care about sizing need no fixture.
    const info = /\/gbooks\/[^/]*_(\d{8})\.jp2\/info\.json$/.exec(u);
    if (info) {
      const body = fx.info?.[`page:${Number(info[1])}`];
      return body === undefined
        ? NOT_FOUND
        : { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
    }

    // IIIF page image: …/gbooks/<scan>_<8 digits>.jp2/<region>/!w,h/0/default.jpg
    const img = /\/gbooks\/[^/]*_(\d{8})\.jp2\//.exec(u);
    if (img) {
      const body = fx.image?.[`page:${Number(img[1])}`];
      return body === undefined
        ? NOT_FOUND
        : { status: 200, contentType: 'image/jpeg', body };
    }

    throw new Error(`stub-backend: unrouted request ${u} — a test reached an unexpected address`);
  };
}

// ── transport A: in-process fetch stub ───────────────────────────────────────

// Minimal Response surface, covering exactly what the clients touch: json()
// (graphql, collection), text() (fulltext, ocr), arrayBuffer() + headers.get
// (image), and ok/status/headers on the failure path.
function fakeResponse({ status, contentType, body }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => JSON.parse(buf.toString('utf8')),
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    body: new Response(buf).body, // streamed by capped readers; http.js cancels unread non-ok bodies
  };
}

/**
 * Replace globalThis.fetch with the router. Returns { calls, restore }; `calls`
 * accumulates { url, method, headers, variables } so a test can assert the
 * COMPILED REQUEST, not just the shaped response.
 */
export function installFetchStub(router) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    let variables;
    if (method === 'POST' && init.body) {
      try { variables = JSON.parse(init.body).variables; } catch { /* not JSON */ }
    }
    calls.push({ url: String(url), method, headers: init.headers ?? {}, variables });
    return fakeResponse(router(url, init));
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// ── transport B: real localhost server (for subprocess tests) ────────────────

/**
 * Start the router on 127.0.0.1:0, answering each request after `delayMs`. Returns
 * { env, requests, userAgents, close }: `env` is the SGBR_*_ENDPOINT overrides to hand a
 * child process, `requests()` the number of requests received so far, `userAgents()` the
 * User-Agent each one carried. Loopback only — the
 * default suite stays offline.
 */
export async function startStubServer(router, { delayMs = 0 } = {}) {
  let received = 0;
  const agents = [];
  const server = createServer((req, res) => {
    received++;
    agents.push(req.headers['user-agent']);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => setTimeout(() => {
      const url = `http://127.0.0.1:${server.address().port}${req.url}`;
      const init = { method: req.method, body: Buffer.concat(chunks).toString('utf8') };
      let out;
      try {
        out = router(url, init);
      } catch (err) {
        // An unrouted request must be diagnosable from the client side too, so
        // send the reason rather than a bare 500 the CLI would render as noise.
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(err.message);
        return;
      }
      res.writeHead(out.status, { 'content-type': out.contentType });
      res.end(Buffer.isBuffer(out.body) ? out.body : String(out.body));
    }, delayMs));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    env: {
      SGBR_GRAPHQL_ENDPOINT: `${base}/graphql`,
      SGBR_FULLTEXT_ENDPOINT: base,
      SGBR_IMAGE_ENDPOINT: `${base}/iiif/3`,
      SGBR_OCR_ENDPOINT: base,
    },
    requests: () => received,
    userAgents: () => [...agents],
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
