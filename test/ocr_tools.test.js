// Offline handler-level tests for the two OCR tools (sgbr_get_page_ocr,
// sgbr_locate_text) and the page reader they share with sgbr_get_fulltext's
// spans: registration → orchestration → degradation, driven by a
// stubbed global fetch (pattern from clients.test.js). The tools' pure helpers
// are covered in ocr.test.js / locate.test.js and the live protocol contract in
// smoke.test.js; these pin the handler seams between them — the scan_id fast
// path, optional-text degradation, per-page failure accounting, hOCR-miss
// region degradation, and abort propagation.
//
// Every test uses a FRESH scan id: the OCR client caches bodies by URL at
// module scope, so reusing a scan id would serve one test's stubbed body to the
// next instead of hitting its stub.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerGetPageOcrTool, outputSchema as pageOcrOutput } from '../src/tools/get_page_ocr.js';
import { registerLocateTextTool, outputSchema as locateOutput } from '../src/tools/locate_text.js';
import { clearGraphqlCache } from '../src/graphql/client.js';
import { fetchOcrPageTexts, OcrError } from '../src/ocr/client.js';
import { captureHandler, assertWireValid } from './helpers.js';

const pageOcrHandler = captureHandler(registerGetPageOcrTool);
const locateHandler = captureHandler(registerLocateTextTool);

let scanSeq = 0;
const freshScanId = () => `TEST-${String(++scanSeq).padStart(4, '0')}`;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const okBody = (body) => ({ ok: true, text: async () => body });
const httpStatus = (code) => ({ ok: false, status: code, headers: { get: () => null } });

// Route stubbed responses by `${kind}:${page}` parsed from the ocrAssetUrl
// grammar (…/gbooks/<scan>_<8-digit page>.<txt|html>/item). A missing route is
// a 404 — the same shape the mediaserver uses for the page-after-last, so the
// volume boundary falls out of the routing table for free. A numeric route
// value is served as that HTTP status. Returns the list of route keys fetched.
function stubOcrFetch(routes) {
  const fetched = [];
  globalThis.fetch = async (url) => {
    const m = /_(\d{8})\.(txt|html)\/item$/.exec(String(url));
    assert.ok(m, `unexpected fetch in offline test: ${url}`);
    const key = `${m[2] === 'txt' ? 'text' : 'hocr'}:${Number(m[1])}`;
    fetched.push(key);
    const route = routes[key];
    if (route === undefined) return httpStatus(404);
    if (typeof route === 'number') return httpStatus(route);
    return okBody(route);
  };
  return fetched;
}

// Minimal parseable hOCR: one page (1000×2000), one block, one line carrying
// `words` (single-quoted attrs, class before title — the probed layout).
function hocrPage(words) {
  const spans = words.map((w, i) =>
    `<span class='ocrx_word' title='bbox ${10 + i * 100} 10 ${100 + i * 100} 100;x_wconf 90'>${w}</span>`).join('\n');
  return `<div class='ocr_page' title='bbox 0 0 1000 2000'>
<div class='ocrx_block' title='bbox 10 10 990 200'>
<span class='ocr_line' title='bbox 10 10 990 100'>
${spans}
</span></div></div>`;
}

const PAGE_OCR_ARGS = { page: 1, level: 'line', include_text: true, max_regions: 50 };
const LOCATE_ARGS = { phrase: 'in Basel', engine: 'page_scan', start_page: 1, max_pages: 20, max_hits: 5, level: 'line' };

// ── the shared page reader ─────────────────────────────────────────────────

test('fetchOcrPageTexts: reads pages in order and ends at the volume\'s last page', async () => {
  const scanId = freshScanId();
  const routes = {};
  for (let p = 1; p <= 12; p++) routes[`text:${p}`] = `Seite ${p}`;
  stubOcrFetch(routes);
  const pages = await fetchOcrPageTexts(scanId, 3, 30);
  assert.deepEqual(pages.map((p) => p.page), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(pages[0].text, 'Seite 3');
});

test('fetchOcrPageTexts: a page that fails to fetch fails the read — a span never has a hole', async () => {
  const scanId = freshScanId();
  stubOcrFetch({ 'text:1': 'a', 'text:2': 400, 'text:3': 'c' });
  await assert.rejects(fetchOcrPageTexts(scanId, 1, 3), (err) => err instanceof OcrError && err.status === 400);
});

// ── sgbr_get_page_ocr ────────────────────────────────────────────────────────

test('get_page_ocr handler: refuses a multi-scan work id and lists its scans', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, 'POST', `unexpected non-GraphQL fetch: ${url}`);
    const data = { get: { id: 'id991-ocr', result: [
      { key: 'sgbrScannedDigIds', metadata: [{ text: 'ZHBL-1' }, { text: 'UBBS-1' }] },
    ] } };
    return { ok: true, json: async () => ({ data }) };
  };
  clearGraphqlCache();
  const res = await pageOcrHandler({ ...PAGE_OCR_ARGS, id: 'id991-ocr' }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ZHBL-1/);
  assert.match(res.content[0].text, /UBBS-1/);
});

test('get_page_ocr handler: happy path returns schema-valid regions + text on the scan_id fast path', async () => {
  const scanId = freshScanId();
  stubOcrFetch({
    'hocr:5': hocrPage(['Der', 'Mann', 'war', 'in', 'Basel']),
    'text:5': 'Der Mann war in Basel geboren',
  });
  const res = await pageOcrHandler({ ...PAGE_OCR_ARGS, scan_id: scanId, page: 5 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = assertWireValid(pageOcrOutput, res.structuredContent); // must satisfy the shipped contract
  assert.equal(out.scan_id, scanId);
  assert.equal(out.id, null, 'scan_id path resolves no record id');
  assert.equal(out.counts.words, 5);
  assert.ok(out.regions.length >= 1, 'expected line regions');
  assert.equal(out.regions[0].region_pct.length, 4);
  assert.equal(out.text, 'Der Mann war in Basel geboren');
  assert.ok(out.text_url, 'a successful text fetch must surface its URL');
  assert.equal(out.viewer_url, null, 'no record id → no viewer link');
});

test('get_page_ocr handler: a failed optional text fetch degrades to empty text with a null text_url', async () => {
  const scanId = freshScanId();
  stubOcrFetch({
    'hocr:1': hocrPage(['Nur', 'Layout']),
    'text:1': 404, // the optional sidecar is missing — regions must still ship
  });
  const res = await pageOcrHandler({ ...PAGE_OCR_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = assertWireValid(pageOcrOutput, res.structuredContent);
  assert.equal(out.text, '');
  assert.equal(out.text_url, null, 'a failed text fetch must not claim a text URL');
  assert.ok(out.regions.length >= 1, 'the hOCR regions must survive the text miss');
});

test('get_page_ocr handler: a transient text failure also degrades, the regions still ship', async () => {
  const scanId = freshScanId();
  stubOcrFetch({ 'hocr:1': hocrPage(['Nur', 'Layout']), 'text:1': 400 });
  const res = await pageOcrHandler({ ...PAGE_OCR_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = assertWireValid(pageOcrOutput, res.structuredContent);
  assert.equal(out.text, '');
  assert.equal(out.text_url, null);
  assert.ok(out.regions.length >= 1);
});

test('get_page_ocr handler: a page locate_text already scanned is not downloaded again', async () => {
  const scanId = freshScanId();
  const fetched = stubOcrFetch({
    'text:1': 'Der Mann war in Basel geboren',
    'hocr:1': hocrPage(['Der', 'Mann', 'war', 'in', 'Basel', 'geboren']),
  });
  await locateHandler({ ...LOCATE_ARGS, scan_id: scanId }, { mcpReq: {} });
  const res = await pageOcrHandler({ ...PAGE_OCR_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.equal(res.structuredContent.text, 'Der Mann war in Basel geboren');
  assert.equal(fetched.filter((k) => k === 'text:1').length, 1, `fetches: ${fetched}`);
});

test('get_page_ocr handler: a page without OCR layout is an isError result with guidance', async () => {
  const scanId = freshScanId();
  stubOcrFetch({ 'hocr:1': '<html><body>image-only page</body></html>' });
  const res = await pageOcrHandler({ ...PAGE_OCR_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text || '', /No OCR layout/i);
});

test('get_page_ocr handler: an aborted request surfaces as an error, never a fabricated result', async () => {
  const scanId = freshScanId();
  stubOcrFetch({ 'hocr:1': hocrPage(['egal']) });
  const ac = new AbortController();
  ac.abort();
  const res = await pageOcrHandler({ ...PAGE_OCR_ARGS, scan_id: scanId }, { mcpReq: { signal: ac.signal } });
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text || '', /abort/i);
});

// ── the fold-out plate path (probed live 2026-07-23) ─────────────────────────
//
// A plate record carries no scan id, but its id encodes {parentScan}_{page} and
// the per-page hOCR at that address is the plate's own lettering. These pin the
// two halves of the attribution rule: the plate's page is used when the caller
// omits one, and the record id is DROPPED when the caller addresses a different
// page (that content belongs to the parent volume, not the plate).

// Route both hops: anything that isn't an OCR asset URL is the GraphQL POST.
function stubPlateFetch(plateId, routes) {
  const rec = {
    id: plateId,
    result: [{ key: 'thumbnail', metadata: [{ link: `https://host/iiif/3/gbooks/${plateId}.jp2/full/400,/0/default.jpg` }] }],
  };
  globalThis.fetch = async (url) => {
    const m = /_(\d{8})\.(txt|html)\/item$/.exec(String(url));
    if (!m) return { ok: true, json: async () => ({ data: { get: rec } }) };
    const key = `${m[2] === 'txt' ? 'text' : 'hocr'}:${Number(m[1])}`;
    const route = routes[key];
    if (route === undefined) return httpStatus(404);
    return okBody(route);
  };
}

test('get_page_ocr handler: a fold-out plate id needs no page and keeps its attribution', async () => {
  const scanId = freshScanId();
  const plateId = `${scanId}_00000011`;
  stubPlateFetch(plateId, { 'hocr:11': hocrPage(['Baunormalien', 'der', 'Gotthardbahn']) });
  clearGraphqlCache();

  const res = await pageOcrHandler(
    { level: 'line', include_text: false, max_regions: 50, id: plateId },
    { mcpReq: {} },
  );
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = res.structuredContent;
  assert.equal(out.page, 11, 'the plate page rides in from the derived target');
  assert.equal(out.scan_id, scanId);
  assert.equal(out.id, plateId, 'this IS the page the plate record stands for');
  assert.match(out.regions[0].text, /Baunormalien/);
  assertWireValid(pageOcrOutput, out);
});

test('get_page_ocr handler: an explicit page on a plate id reads the parent volume and drops the id', async () => {
  const scanId = freshScanId();
  const plateId = `${scanId}_00000011`;
  stubPlateFetch(plateId, { 'hocr:3': hocrPage(['Titelblatt']) });
  clearGraphqlCache();

  const res = await pageOcrHandler(
    { level: 'line', include_text: false, max_regions: 50, id: plateId, page: 3 },
    { mcpReq: {} },
  );
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = res.structuredContent;
  assert.equal(out.page, 3);
  assert.equal(out.scan_id, scanId, 'still the parent scan');
  assert.equal(out.id, null, 'page 3 is the parent volume, NOT the plate — do not misattribute');
  assert.doesNotMatch(res.content[0].text, new RegExp(plateId), 'the text channel must not claim it either');
  assertWireValid(pageOcrOutput, out);
});

test('get_page_ocr handler: a missing page on a non-plate address is an actionable isError', async () => {
  const res = await pageOcrHandler(
    { level: 'line', include_text: false, max_regions: 50, scan_id: freshScanId() },
    { mcpReq: {} },
  );
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text || '', /Provide a `page`/);
});

test('locate_text handler: a plate id is refused with the address that DOES work', async () => {
  const scanId = freshScanId();
  const plateId = `${scanId}_00000011`;
  stubPlateFetch(plateId, {});
  clearGraphqlCache();

  const res = await locateHandler({ ...LOCATE_ARGS, id: plateId }, { mcpReq: {} });
  assert.equal(res.isError, true);
  const text = res.content?.[0]?.text || '';
  assert.match(text, /fold-out plate/i);
  assert.match(text, /page 11/, 'name the plate page');
  assert.match(text, new RegExp(scanId), 'name the parent scan so the caller can widen deliberately');
  assert.match(text, /sgbr_get_page_ocr/, 'point at the tool that can read it');
});

// ── sgbr_locate_text ─────────────────────────────────────────────────────────

test('locate_text handler: finds the phrase, returns regions, and stops at the volume boundary', async () => {
  const scanId = freshScanId();
  stubOcrFetch({
    'text:1': 'nichts hier',
    'text:2': 'Der Mann war in Basel geboren',
    'text:3': 'auch nichts',
    // pages 4+ 404 → the volume ends after page 3
    'hocr:2': hocrPage(['Der', 'Mann', 'war', 'in', 'Basel', 'geboren']),
  });
  const res = await locateHandler({ ...LOCATE_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = assertWireValid(locateOutput, res.structuredContent);
  assert.deepEqual(out.hits.map((h) => h.page), [2]);
  assert.equal(out.volume_page_count, 3, 'the 404 boundary caps the volume');
  assert.ok(out.hits[0].regions.length >= 1, 'expected hOCR line regions for the hit');
  assert.equal(out.hits[0].regions[0].region_pct.length, 4);
  assert.ok(out.hits[0].snippet.includes('in basel'), 'snippets carry the NORMALIZED (lowercased) text');
  assert.equal(out.pages_failed, 0);
  assert.equal(out.truncated, false);
  assert.equal(out.siblings, null, 'scan_id path yields no sibling enumeration');
});

test('locate_text handler: a start_page past the end reports the volume\'s size, not a bare miss', async () => {
  const scanId = freshScanId();
  stubOcrFetch({ 'text:1': 'a', 'text:2': 'b', 'text:3': 'c' }); // pages 4+ 404
  const res = await locateHandler({ ...LOCATE_ARGS, scan_id: scanId, start_page: 9 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = assertWireValid(locateOutput, res.structuredContent);
  assert.equal(out.volume_page_count, 3);
  assert.equal(out.warnings.length, 1, JSON.stringify(out.warnings));
  assert.match(out.warnings[0], /start_page 9 is past the end of this volume, which has 3 page\(s\)/);
});

test('locate_text handler: a scan that reaches the volume\'s end counts only the volume\'s pages', async () => {
  // Pages in flight past the end still settle as 404s; they are not pages of the volume.
  const scanId = freshScanId();
  stubOcrFetch({ 'text:1': 'a', 'text:2': 'in Basel', 'text:3': 'c' }); // pages 4+ 404
  const out = (await locateHandler({ ...LOCATE_ARGS, scan_id: scanId }, { mcpReq: {} })).structuredContent;
  assert.equal(out.volume_page_count, 3);
  assert.equal(out.pages_scanned, 3);
  const past = (await locateHandler({ ...LOCATE_ARGS, scan_id: scanId, start_page: 9 }, { mcpReq: {} })).structuredContent;
  assert.equal(past.pages_scanned, 0, 'a start past the end searches no page');
});

test('locate_text handler: a scan with no OCR pages keeps an unknown page count', async () => {
  const scanId = freshScanId();
  stubOcrFetch({}); // every page 404
  const out = (await locateHandler({ ...LOCATE_ARGS, scan_id: scanId }, { mcpReq: {} })).structuredContent;
  assert.equal(out.volume_page_count, null);
  assert.ok(out.warnings.some((w) => /No matches found/.test(w)));
});

test('locate_text handler: max_hits stops the scan early, keeps hits in page order, and says why', async () => {
  const scanId = freshScanId();
  const routes = {};
  for (let p = 1; p <= 20; p++) routes[`text:${p}`] = 'in Basel';
  const fetched = stubOcrFetch(routes);
  const out = (await locateHandler({ ...LOCATE_ARGS, scan_id: scanId, max_hits: 3 }, { mcpReq: {} })).structuredContent;
  assert.deepEqual(out.hits.map((h) => h.page), [1, 2, 3]);
  assert.equal(out.truncated, true);
  assert.equal(out.truncation_reason, 'max_hits');
  const scanned = fetched.filter((k) => k.startsWith('text:')).length;
  assert.ok(scanned < 20, `the scan must stop launching once max_hits is reached (fetched ${scanned})`);
  assert.equal(out.pages_scanned, scanned, 'coverage is contiguous, so it counts every page read');
});

test('locate_text handler: exactly max_hits hits in a volume that ends is complete, not truncated', async () => {
  const scanId = freshScanId();
  stubOcrFetch({ 'text:1': 'in Basel', 'text:2': 'nichts', 'text:3': 'in Basel' }); // pages 4+ 404
  const out = (await locateHandler({ ...LOCATE_ARGS, scan_id: scanId, max_hits: 2 }, { mcpReq: {} })).structuredContent;
  assert.deepEqual(out.hits.map((h) => h.page), [1, 3]);
  assert.equal(out.volume_page_count, 3);
  assert.equal(out.truncated, false);
});

test('locate_text handler: a non-404 page failure is reported as unsearched coverage, not silence', async () => {
  const scanId = freshScanId();
  stubOcrFetch({
    'text:1': 'nichts',
    'text:2': 400, // non-retryable failure: this page was NOT searched
    'text:3': 'Der Mann war in Basel geboren',
    'hocr:3': hocrPage(['Der', 'Mann', 'war', 'in', 'Basel', 'geboren']),
  });
  const res = await locateHandler({ ...LOCATE_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = assertWireValid(locateOutput, res.structuredContent);
  assert.deepEqual(out.hits.map((h) => h.page), [3], 'pages after the failure are still searched');
  assert.equal(out.pages_failed, 1);
  assert.deepEqual(out.failed_pages, [2]);
  assert.ok(
    (out.warnings || []).some((w) => /NOT searched/.test(w)),
    `expected an incomplete-coverage warning, got: ${JSON.stringify(out.warnings)}`,
  );
});

test('locate_text handler: a failed hOCR fetch degrades to an empty region list, the hit stands', async () => {
  const scanId = freshScanId();
  stubOcrFetch({
    'text:1': 'Der Mann war in Basel geboren',
    'hocr:1': 400, // regions unavailable — the page + snippet must still ship
  });
  const res = await locateHandler({ ...LOCATE_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = assertWireValid(locateOutput, res.structuredContent);
  assert.deepEqual(out.hits.map((h) => h.page), [1]);
  assert.deepEqual(out.hits[0].regions, []);
  assert.ok(out.hits[0].snippet.includes('in basel'), 'snippets carry the NORMALIZED (lowercased) text');
});

test('locate_text handler: an aborted request surfaces as an error, never a fabricated result', async () => {
  const scanId = freshScanId();
  stubOcrFetch({ 'text:1': 'egal' });
  const ac = new AbortController();
  ac.abort();
  const res = await locateHandler({ ...LOCATE_ARGS, scan_id: scanId }, { mcpReq: { signal: ac.signal } });
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text || '', /abort/i);
});
