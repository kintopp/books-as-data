// Offline tests for the IIIF Collection client (src/collection/client.js) and
// its one caller, sgbr_locate_text's sibling enumeration. The pure parser
// (parseCollectionChildren) is covered in locate.test.js; this file owns what
// that cannot reach — the transport, the cache, the degrade-to-null contract,
// and the AUTH POLICY.
//
// The auth policy is the point of the file. fetchCollectionChildren is the ONLY
// client that must NOT send SGBR_ACCESS_TOKEN: its URL comes from record data
// rather than a configured, assertAuthEndpointsSecure-validated endpoint, so
// standardising `fetchOptions: {}` → `authHeaders()` across the sibling clients
// would leak the credential to an arbitrary host. The test is written
// DIFFERENTIALLY — it asserts a sibling client DOES send the header under the
// identical env — so it fails on exactly that refactor instead of passing
// vacuously if header capture ever broke.
//
// Every test uses a FRESH manifest URL: collectionCache lives at module scope
// and exports no clear(), so a reused URL would serve one test's body to the next.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCollectionChildren } from '../src/collection/client.js';
import { fetchFullText } from '../src/fulltext/client.js';
import { registerLocateTextTool } from '../src/tools/locate_text.js';
import { clearGraphqlCache } from '../src/graphql/client.js';
import { setEnv, captureHandler } from './helpers.js';
import { makeRouter, installFetchStub, record } from './stub-backend.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; clearGraphqlCache(); });

let urlSeq = 0;
const freshManifestUrl = () => `https://manifest.example/iiif/3/coll-${++urlSeq}/manifest`;
let scanSeq = 0;
const freshScanId = () => `COLL-${String(++scanSeq).padStart(4, '0')}`;

// A IIIF Collection whose child ids carry scan ids in the probed shape
// (CHILD_SCAN_ID_RE = /([A-Z]{2,6}-\d{6,})/).
const collection = (...scanIds) => ({
  type: 'Collection',
  items: scanIds.map((s) => ({ id: `https://host/iiif/3/gbooks/${s}/manifest`, type: 'Manifest' })),
});

const okJson = (body) => ({ ok: true, json: async () => body });
const httpStatus = (code) => ({ ok: false, status: code, headers: { get: () => null } });

// ── AUTH POLICY (the credential-boundary invariant) ──────────────────────────

test('fetchCollectionChildren sends NO Authorization header, while a sibling client does', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return String(url).includes('manifest')
      ? okJson(collection('UBBS-000111', 'UBBS-000222'))
      : { ok: true, text: async () => 'body' };
  };

  const restore = setEnv('SGBR_ACCESS_TOKEN', 'super-secret-token');
  try {
    await fetchCollectionChildren(freshManifestUrl());
    // Same process, same env, same shared fetchWithRetry — the ONLY difference is
    // the client's policy. Without this half, a broken header capture above would
    // make the assertion pass for the wrong reason.
    await fetchFullText(freshScanId());
  } finally {
    restore();
  }

  const [manifestCall, fullTextCall] = seen;
  const authKeys = Object.keys(manifestCall.headers).filter((k) => /^authorization$/i.test(k));
  assert.deepEqual(authKeys, [], 'the record-supplied manifest URL must never receive the bearer token');
  assert.doesNotMatch(JSON.stringify(manifestCall), /super-secret-token/,
    'the token must not reach a record-supplied URL by ANY header or field');

  const siblingAuth = Object.entries(fullTextCall.headers).find(([k]) => /^authorization$/i.test(k));
  assert.ok(siblingAuth, 'control: a configured-endpoint client DOES send the token, so this test can fail');
  assert.match(siblingAuth[1], /^Bearer super-secret-token$/);
});

test('fetchCollectionChildren still identifies itself: no auth, but the User-Agent', async () => {
  let headers;
  globalThis.fetch = async (url, init) => { headers = init?.headers ?? {}; return okJson(collection('UBBS-000111')); };
  await fetchCollectionChildren(freshManifestUrl());
  assert.match(headers['User-Agent'], /^ub-sgbr-mcp\/\d+\.\d+\.\d+ \(/);
});

test('the collection cache is keyed by URL alone, so a token change does not re-key it', async () => {
  // The deliberate asymmetry with the auth-fingerprinted siblings: this response
  // is auth-INDEPENDENT (no credential is ever sent), so scoping the key by
  // identity would only cost a redundant fetch. Pins the reasoning in the
  // client's comment at src/collection/client.js:23-25.
  let calls = 0;
  globalThis.fetch = async () => { calls++; return okJson(collection('UBBS-000111')); };

  const url = freshManifestUrl();
  const anon = await fetchCollectionChildren(url);
  const restore = setEnv('SGBR_ACCESS_TOKEN', 'a-token');
  let withToken;
  try {
    withToken = await fetchCollectionChildren(url);
  } finally {
    restore();
  }

  assert.deepEqual(anon, ['UBBS-000111']);
  assert.deepEqual(withToken, anon);
  assert.equal(calls, 1, 'one fetch: identity is not part of the key because it is not part of the request');
});

// ── transport + degrade-to-null ──────────────────────────────────────────────

test('fetchCollectionChildren caches by URL, so repeat enumeration downloads once', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return okJson(collection('UBBS-000111', 'UBBS-000222')); };

  const url = freshManifestUrl();
  const a = await fetchCollectionChildren(url);
  const b = await fetchCollectionChildren(url);
  assert.deepEqual(a, ['UBBS-000111', 'UBBS-000222']);
  assert.deepEqual(b, a);
  assert.equal(calls, 1, 'the second call must be served from cache');

  await fetchCollectionChildren(freshManifestUrl());
  assert.equal(calls, 2, 'a different manifest URL must miss the cache');
});

test('fetchCollectionChildren de-duplicates concurrent enumeration of one manifest', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return okJson(collection('UBBS-000111'));
  };
  const url = freshManifestUrl();
  const [a, b] = await Promise.all([fetchCollectionChildren(url), fetchCollectionChildren(url)]);
  assert.deepEqual(a, ['UBBS-000111']);
  assert.deepEqual(b, ['UBBS-000111']);
  assert.equal(calls, 1, 'an in-flight fetch must be shared, not duplicated');
});

test('a 404 manifest degrades to null rather than throwing', async () => {
  // 404 (not 5xx) on purpose: a retryable status would burn the real backoff.
  globalThis.fetch = async () => httpStatus(404);
  assert.equal(await fetchCollectionChildren(freshManifestUrl()), null);
});

test('a 401 on a restricted manifest degrades to null — anonymous enumeration is best-effort', async () => {
  // The case the AUTH POLICY accepts by design: without a token, a restricted
  // work's manifest may refuse us. Sibling enumeration is then simply absent;
  // the resolved volume itself is still searched.
  globalThis.fetch = async () => httpStatus(401);
  assert.equal(await fetchCollectionChildren(freshManifestUrl()), null);
});

test('an unparseable manifest body degrades to null without retrying', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  };
  assert.equal(await fetchCollectionChildren(freshManifestUrl()), null);
  assert.equal(calls, 1, 'a JSON parse failure here is not marked transient, unlike the GraphQL client');
});

test('a single-volume Manifest (not a Collection) yields null, not an empty list', async () => {
  // The distinction the caller depends on: null means "no siblings to speak of",
  // and locate_text only reports siblings for a non-empty array.
  globalThis.fetch = async () => okJson({ type: 'Manifest', items: [{ id: 'https://host/UBBS-000111' }] });
  assert.equal(await fetchCollectionChildren(freshManifestUrl()), null);
});

test('an already-aborted signal returns null without reaching the network', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return okJson(collection('UBBS-000111')); };
  const ac = new AbortController();
  ac.abort();
  assert.equal(await fetchCollectionChildren(freshManifestUrl(), { signal: ac.signal }), null);
  assert.equal(calls, 0, 'a cancelled enumeration must not hit the network');
});

// ── caller integration: sgbr_locate_text sibling enumeration ─────────────────
//
// src/tools/locate_text.js:276-293 wires record → iiif_manifest → children →
// structuredContent.siblings. Covered here rather than in ocr_tools.test.js
// because the manifest hop is what makes it interesting.

const locateHandler = captureHandler(registerLocateTextTool);
const LOCATE_ARGS = { engine: 'page_scan', phrase: 'Basel', level: 'line', start_page: 1, max_pages: 20, max_hits: 5 };
const FOUND_ON_PAGE_1 = { 'text:1': 'Der Mann war in Basel geboren' };

// Routes all three hops a locate-by-record-id call makes: GraphQL Get, per-page
// OCR assets, and the manifest. Deliberately the SHARED router from
// stub-backend.js rather than a fourth hand-rolled one — it already matches each
// hop by the URL shape the real clients build, and an unrouted address throws
// there, so a stray real request fails loudly instead of hanging.
function stubLocateFetch({ recordId, scanId, scans = [scanId], manifestUrl, manifest = null, ocr = FOUND_ON_PAGE_1 }) {
  const rec = record(recordId, {
    sgbrScannedDigIds: scans,
    iiifManifest: [{ link: manifestUrl }],
  });
  return installFetchStub(makeRouter({
    // A function of the variables, so an unexpected id can't be answered with
    // this record: the backend returns 200 + an empty result for a bad id.
    graphql: { Get: ({ id }) => ({ get: id === recordId ? rec : { id: '', result: [] } }) },
    manifest: { [manifestUrl]: manifest }, // null → 404, the degrade path
    ocr,
  }));
}

test('locate_text reports sibling volumes when the record\'s manifest is a Collection', async () => {
  const scanId = freshScanId();
  const manifestUrl = freshManifestUrl();
  stubLocateFetch({
    recordId: 'rec-multivol', scanId, manifestUrl,
    manifest: collection('UBBS-000111', 'UBBS-000222', 'UBBS-000333'),
  });
  clearGraphqlCache();

  const res = await locateHandler({ ...LOCATE_ARGS, id: 'rec-multivol' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const sib = res.structuredContent.siblings;
  assert.ok(sib, 'siblings must be populated for a Collection manifest');
  assert.equal(sib.is_multivolume, true);
  assert.equal(sib.searched_volume, scanId, 'names which volume was actually searched');
  assert.deepEqual(sib.volumes, ['UBBS-000111', 'UBBS-000222', 'UBBS-000333']);
  // The caveat must be visible in the human channel too, per the two-channels rule.
  assert.match(res.content[0].text, /UBBS-000222/);
});

test('locate_text still succeeds, with siblings null, when the manifest fetch fails', async () => {
  // Best-effort: enumeration failing must never cost the caller their hits.
  const scanId = freshScanId();
  stubLocateFetch({
    recordId: 'rec-nomanifest', scanId, manifestUrl: freshManifestUrl(),
    manifest: null, // → 404
  });
  clearGraphqlCache();

  const res = await locateHandler({ ...LOCATE_ARGS, id: 'rec-nomanifest' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.siblings, null, 'degrades to null, not an error');
  assert.equal(res.structuredContent.hits.length, 1, 'the hit survives the failed enumeration');
});

// The record's own scan list is the one signal that survives a failed or
// copy-blind Collection read, so the scans it lists but nobody searched are named.
async function locateMultiScan(recordId, scans, manifestScans = null) {
  stubLocateFetch({
    recordId, scanId: scans[0], scans, manifestUrl: freshManifestUrl(),
    manifest: manifestScans && collection(...manifestScans),
  });
  clearGraphqlCache();
  const res = await locateHandler({ ...LOCATE_ARGS, id: recordId }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.scan_id, scans[0]);
  return res;
}

test('locate_text names the unsearched scans of a multi-scan work when the manifest fetch fails', async () => {
  const [first, second] = [freshScanId(), freshScanId()];
  const res = await locateMultiScan('rec-multiscan-nomanifest', [first, second]);
  assert.equal(res.structuredContent.siblings, null, 'no Collection, so no confirmed volume list');
  assert.deepEqual(res.structuredContent.unsearched_scans, [second]);
  assert.match(res.content[0].text, new RegExp(`lists 2 scans .*not searched: ${second}\\.`));
});

test('locate_text names no unsearched scan when the Collection lists every scan', async () => {
  const scans = ['UBBS-000444', 'UBBS-000555'];
  const res = await locateMultiScan('rec-multiscan-covered', scans, scans);
  assert.deepEqual(res.structuredContent.siblings.volumes, scans);
  assert.deepEqual(res.structuredContent.unsearched_scans, [], 'the sibling line already names the other volume');
  assert.doesNotMatch(res.content[0].text, /not searched/);
});

test('locate_text names a listed copy the Collection leaves out', async () => {
  const [first, second, copy] = ['UBBS-000666', 'UBBS-000777', 'ZBZ-000888'];
  const res = await locateMultiScan('rec-multiscan-copy', [first, second, copy], [first, second]);
  assert.deepEqual(res.structuredContent.unsearched_scans, [copy]);
  assert.match(res.content[0].text, new RegExp(`not searched and not among those volumes: ${copy}\\.`));
});

test('locate_text omits siblings for a single-volume Manifest', async () => {
  const scanId = freshScanId();
  const manifestUrl = freshManifestUrl();
  stubLocateFetch({
    recordId: 'rec-singlevol', scanId, manifestUrl,
    manifest: { type: 'Manifest', items: [] },
  });
  clearGraphqlCache();

  const res = await locateHandler({ ...LOCATE_ARGS, id: 'rec-singlevol' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.siblings, null);
});

test('locate_text addressed by scan_id never enumerates siblings at all', async () => {
  // No record id was resolved, so there is no manifest to consult — the handler's
  // `if (recordId)` guard. Pins that the tool does not invent a sibling lookup
  // (the page scan, pinned here, also makes no content-search record lookup).
  const scanId = freshScanId();
  // OCR assets are the ONLY fixtures: the router throws on any other address, so
  // a manifest or GraphQL hop would fail loudly rather than be quietly counted.
  const stub = installFetchStub(makeRouter({ ocr: FOUND_ON_PAGE_1 }));

  const res = await locateHandler({ ...LOCATE_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.siblings, null);
  // Asserted as an allowlist, not a denylist: installFetchStub records a call
  // BEFORE routing it, so a manifest GET to an unrouted URL would still appear
  // here (the router's throw only degrades it to siblings:null). Naming the one
  // shape that IS expected is what makes "no manifest hop, no GraphQL hop" real.
  const strays = stub.calls.filter((c) => !/\/gbooks\/[^/]*_\d{8}\.(txt|html)\/item$/.test(c.url));
  assert.deepEqual(strays, [], 'no record id resolved → only per-page OCR assets are fetched');
  assert.ok(stub.calls.length > 0, 'control: the OCR hops did happen, so the filter above is not vacuous');
});
