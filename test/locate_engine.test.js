// Offline handler tests for sgbr_locate_text's engine choice: content search
// first, the page scan when it finds nothing, cannot run, or would return too
// much; and how a content-search hit is built (page text for the snippet, hOCR
// or the service's own line boxes for the regions). The page-scan path itself
// is covered by ocr_tools.test.js and collection.test.js.
//
// Handlers are driven directly, which bypasses zod, so every call spells out
// the schema defaults. Each test uses a fresh scan id: the OCR and content-
// search clients cache at module scope.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerLocateTextTool, outputSchema as locateOutput } from '../src/tools/locate_text.js';
import { clearGraphqlCache } from '../src/graphql/client.js';
import { CONTENT_SEARCH_MAX_BYTES } from '../src/config.js';
import { makeRouter, installFetchStub, record, searchPayload } from './stub-backend.js';
import { captureHandler, assertWireValid } from './helpers.js';

const locate = captureHandler(registerLocateTextTool);
const ARGS = { engine: 'auto', start_page: 1, max_pages: 20, max_hits: 5, level: 'line' };

let stub = null;
afterEach(() => { stub?.restore(); stub = null; clearGraphqlCache(); });
function serve(fixtures) {
  stub = installFetchStub(makeRouter(fixtures));
  clearGraphqlCache();
  return stub.calls;
}

let seq = 0;
const fresh = () => {
  const scan = `UBBS-CS${String(++seq).padStart(5, '0')}`;
  return { scan, volumeId: `id99${seq}_${scan}`, workId: `id99${seq}` };
};

const csBody = (scan, hits) => ({
  resources: hits.map(([page, xywh, chars]) => ({
    on: `https://books-as-data.ch/media/gbooks/${scan.toLowerCase()}_${String(page).padStart(8, '0')}.jp2/iiif/v3/canvas#xywh=${xywh}`,
    resource: { chars },
  })),
});

// One-line hOCR page (1000×2000) whose words are `words`.
const hocr = (words) => `<div class='ocr_page' title='bbox 0 0 1000 2000'>
<span class='ocr_line' title='bbox 10 10 990 100'>
${words.map((w, i) => `<span class='ocrx_word' title='bbox ${10 + i * 100} 10 ${100 + i * 100} 100;x_wconf 90'>${w}</span>`).join('\n')}
</span></div>`;

// The record get() returns for a volume id: just the scan it carries (no
// manifest, so the handler's sibling lookup finds nothing).
const getVolume = (scan) => ({ id }) => ({ get: record(id, { sgbrScannedDigIds: [scan] }) });

const txtCalls = (calls) => calls.filter((c) => /\.txt\/item$/.test(c.url)).map((c) => Number(/_(\d{8})\.txt/.exec(c.url)[1]));

test('auto on a volume id answers from content search: hit pages in page order, only they are read', async () => {
  const { scan, volumeId } = fresh();
  const calls = serve({
    search: { [volumeId]: csBody(scan, [[72, '1,1,1,1', 'die <em>Brücke</em>'], [47, '1,1,1,1', 'die <em>Brücke</em>']]) },
    ocr: { 'text:47': 'Über die Brücke.', 'text:72': 'Und die Brücke.', 'hocr:47': hocr(['die', 'Brücke']), 'hocr:72': hocr(['die', 'Brücke']) },
    graphql: { Get: getVolume(scan) },
  });
  const res = await locate({ ...ARGS, id: volumeId, phrase: 'Brücke' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = assertWireValid(locateOutput, res.structuredContent);
  assert.equal(out.engine, 'content_search');
  assert.deepEqual(out.hits.map((h) => h.page), [47, 72]);
  assert.equal(out.pages_scanned, null);
  assert.ok(out.hits[0].snippet.includes('die brucke'), 'snippets carry the normalized page text');
  assert.ok(out.hits[0].regions.length >= 1);
  assert.match(out.hits[0].viewer_url, new RegExp(`${volumeId}\\?page=47$`));
  assert.deepEqual(txtCalls(calls).sort((a, b) => a - b), [47, 72], 'no page scan ran');
  assert.match(res.content[0].text, /by content search: 2 page\(s\)/);
});

test('auto falls back to the page scan when content search finds nothing', async () => {
  const { scan, volumeId } = fresh();
  serve({
    search: { [volumeId]: null },
    ocr: { 'text:1': 'nichts', 'text:2': 'die Rheinbrücke', 'hocr:2': hocr(['die', 'Rheinbrücke']) },
    graphql: { Get: getVolume(scan) },
  });
  const out = (await locate({ ...ARGS, id: volumeId, phrase: 'brücke' }, { mcpReq: {} })).structuredContent;
  assert.equal(out.engine, 'page_scan');
  assert.deepEqual(out.hits.map((h) => h.page), [2], 'the substring scan finds what whole-word search cannot');
  assert.equal(typeof out.pages_scanned, 'number');
  assert.equal(out.scan_id, scan);
});

test('a scan_id call reaches content search through the identifier lookup, never the parent work', async () => {
  const { scan, volumeId, workId } = fresh();
  const calls = serve({
    graphql: { Search: { search: searchPayload([record(workId, {}), record(volumeId, {})]) } },
    search: { [volumeId]: csBody(scan, [[3, '1,1,1,1', '<em>Basel</em>']]) },
    ocr: { 'text:3': 'in Basel', 'hocr:3': hocr(['in', 'Basel']) },
  });
  const out = (await locate({ ...ARGS, scan_id: scan, phrase: 'Basel' }, { mcpReq: {} })).structuredContent;
  assert.equal(out.engine, 'content_search');
  assert.equal(out.id, null, 'the looked-up record is not echoed as the caller\'s id');
  assert.match(out.hits[0].viewer_url, new RegExp(`${volumeId}\\?page=3$`), 'links go to the volume, not the work');
  assert.ok(!calls.some((c) => c.url.includes(`/services/${workId}/`)), 'the work id spans other copies — never searched');
});

test('too many content-search hits fall back to the page scan, with a warning saying why', async () => {
  const { scan, volumeId } = fresh();
  serve({
    search: { [volumeId]: 'x'.repeat(CONTENT_SEARCH_MAX_BYTES + 10) },
    ocr: { 'text:1': 'und', 'hocr:1': hocr(['und']) },
    graphql: { Get: getVolume(scan) },
  });
  const out = (await locate({ ...ARGS, id: volumeId, phrase: 'und' }, { mcpReq: {} })).structuredContent;
  assert.equal(out.engine, 'page_scan');
  assert.ok(out.warnings.some((w) => /too many matches for content search/.test(w)), JSON.stringify(out.warnings));
});

test('content search respects start_page and caps at max_hits', async () => {
  const { scan, volumeId } = fresh();
  const hits = [2, 4, 6, 8, 10].map((p) => [p, '1,1,1,1', '<em>Rat</em>']);
  const ocr = {};
  for (const [p] of hits) { ocr[`text:${p}`] = 'der Rat'; ocr[`hocr:${p}`] = hocr(['der', 'Rat']); }
  serve({ search: { [volumeId]: csBody(scan, hits) }, ocr, graphql: { Get: getVolume(scan) } });
  const out = (await locate({ ...ARGS, id: volumeId, phrase: 'Rat', start_page: 4, max_hits: 2 }, { mcpReq: {} })).structuredContent;
  assert.deepEqual(out.hits.map((h) => h.page), [4, 6]);
  assert.equal(out.truncated, true);
  assert.equal(out.truncation_reason, 'max_hits');
});

test('a content-search hit the page text cannot anchor keeps the service\'s snippet and line box', async () => {
  const { scan, volumeId } = fresh();
  serve({
    search: { [volumeId]: csBody(scan, [[5, '100,200,300,50', 'die <em>Rhein-brücke</em> bei Basel']]) },
    ocr: { 'text:5': 'die Rhein brücke bei Basel', 'hocr:5': hocr(['die', 'Rhein', 'brücke']) },
    graphql: { Get: getVolume(scan) },
  });
  const out = (await locate({ ...ARGS, id: volumeId, phrase: 'Rhein-brücke' }, { mcpReq: {} })).structuredContent;
  const [hit] = out.hits;
  assert.equal(hit.snippet, 'die rhein-brucke bei basel');
  assert.equal(hit.match_count, 1);
  assert.deepEqual(hit.regions.map((r) => r.bbox_px), [[100, 200, 400, 250]]);
});

test('engine content_search refuses a scan it has no record for instead of scanning', async () => {
  const { scan } = fresh();
  serve({ graphql: { Search: { search: searchPayload([]) } } });
  const res = await locate({ ...ARGS, engine: 'content_search', scan_id: scan, phrase: 'Basel' }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Content search has no record for scan/);
});

test('locate does not refuse a multi-scan work id', async () => {
  const { workId } = fresh();
  serve({
    graphql: { Get: () => ({ get: record(workId, { sgbrScannedDigIds: ['ZHBL-LM1', 'UBBS-LM1'] }) }) },
  });
  const res = await locate({ ...ARGS, id: workId, phrase: 'Brücke' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.scan_id, 'ZHBL-LM1', 'searches the first scan the work lists');
});

// A work id's viewer pages run across every scan it lists, so a hit on one scan
// must link through the record for exactly that scan, or not at all.
const getWork = (scan) => ({ id }) => ({ get: record(id, { sgbrScannedDigIds: [scan, 'ZHBL-OTHERCOPY'] }) });

test('a page-scan hit on a multi-scan work links through the record for the searched scan', async () => {
  const { scan, volumeId, workId } = fresh();
  serve({
    graphql: { Get: getWork(scan), Search: { search: searchPayload([record(volumeId, { sgbrScannedDigIds: [scan] })]) } },
    ocr: { 'text:1': 'Die Brücke bei Basel' },
  });
  const res = await locate({ ...ARGS, engine: 'page_scan', id: workId, phrase: 'Brücke' }, { mcpReq: {} });
  assertWireValid(locateOutput, res.structuredContent);
  const [hit] = res.structuredContent.hits;
  assert.equal(hit.page, 1);
  assert.match(hit.viewer_url, new RegExp(`/detail/${volumeId}\\?page=1$`));
});

test('a multi-scan work whose scan has no record of its own gets hits without a viewer link', async () => {
  const { scan, workId } = fresh();
  serve({
    graphql: { Get: getWork(scan), Search: { search: searchPayload([]) } },
    ocr: { 'text:1': 'Die Brücke bei Basel' },
  });
  const res = await locate({ ...ARGS, id: workId, phrase: 'Brücke' }, { mcpReq: {} });
  assertWireValid(locateOutput, res.structuredContent);
  const [hit] = res.structuredContent.hits;
  assert.equal(hit.page, 1, 'the hit itself stands');
  assert.equal(hit.viewer_url, null, 'never the work id, whose page 1 is another scan\'s');
});

test('a failed per-scan record lookup is made once, and its hits carry no viewer link', async () => {
  // An error is not cached, so a second lookup would repeat the whole failure.
  const { scan, workId } = fresh();
  const calls = serve({
    graphql: { Get: getWork(scan), Search: { errors: [{ message: 'search unavailable' }] } },
    ocr: { 'text:1': 'Die Brücke bei Basel' },
  });
  const res = await locate({ ...ARGS, id: workId, phrase: 'Brücke' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.engine, 'page_scan');
  assert.equal(res.structuredContent.hits[0].viewer_url, null);
  assert.equal(calls.filter((c) => c.variables?.searchFields).length, 1, 'one lookup serves both engine and link');
});
