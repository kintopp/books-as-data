// Offline handler-level tests for six tools: sgbr_search, sgbr_get_record,
// sgbr_facet_values, sgbr_autocomplete, sgbr_get_fulltext, sgbr_inspect_image.
// (sgbr_facet_breakdown → facet_breakdown.test.js; the OCR pair →
// ocr_tools.test.js; which tools refuse a whole-corpus query →
// query_refusal.test.js.)
//
// These cover the wiring between compiler, resolver and shaper — each well
// unit-tested alone — so they assert three things a unit test cannot reach:
// the COMPILED REQUEST the backend received (stub-backend's `calls`), BOTH
// output channels, and abort propagation.
//
// Handlers are driven directly, which bypasses zod: every ARGS constant here
// must spell out the defaults the schema would otherwise supply.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { registerSearchTool, outputSchema as searchOutput } from '../src/tools/search.js';
import { registerGetRecordTool, outputSchema as recordOutput } from '../src/tools/get_record.js';
import { registerFacetValuesTool, outputSchema as facetOutput } from '../src/tools/facet_values.js';
import { registerAutocompleteTool, outputSchema as autocompleteOutput } from '../src/tools/autocomplete.js';
import { registerGetFullTextTool, outputSchema as fulltextOutput } from '../src/tools/get_fulltext.js';
import { registerInspectImageTool } from '../src/tools/inspect_image.js';
import { fitsVisionBudget } from '../src/lib/vision.js';
import { clearGraphqlCache } from '../src/graphql/client.js';
import { DEFAULT_SEARCH_FIELDS, MAX_IMAGE_BYTES, MAX_IMAGE_LONG_EDGE } from '../src/config.js';
import { makeRouter, installFetchStub, record, searchPayload, facetPayload } from './stub-backend.js';
import { captureHandler, assertWireValid } from './helpers.js';

const search = captureHandler(registerSearchTool);
const getRecord = captureHandler(registerGetRecordTool);
const facetValues = captureHandler(registerFacetValuesTool);
const autocomplete = captureHandler(registerAutocompleteTool);
const getFullText = captureHandler(registerGetFullTextTool);
const inspectImage = captureHandler(registerInspectImageTool);

// Schema defaults, spelled out because direct invocation skips zod.
const SEARCH_ARGS = { query: '', scope: 'all', full_text_only: false, page: 1, page_size: 10 };
const FACET_ARGS = { query: '', scope: 'all', full_text_only: false, facet: 'library', size: 20 };
const COMP_ARGS = { query: '', scope: 'all', full_text_only: false, limit: 10 };
const FULLTEXT_ARGS = { offset: 0, max_chars: 15000 };
// Direct invocation bypasses zod, so the schema default is spelled out — from the
// constant, never a literal. An inlined number here would keep passing against
// the old cap while asserting nothing about the new one.
const IMAGE_ARGS = { max_long_edge: MAX_IMAGE_LONG_EDGE };

let stub = null;
afterEach(() => { stub?.restore(); stub = null; clearGraphqlCache(); });

// Install the router and keep the call log for request-shape assertions.
function serve(fixtures) {
  stub = installFetchStub(makeRouter(fixtures));
  clearGraphqlCache();
  return stub.calls;
}

// Each test drives exactly one tool, so the POSTs arrive in a known order and
// indexing them is clearer than matching on operation name.
const postVars = (calls) => calls.filter((c) => c.method === 'POST').map((c) => c.variables);

// A book long enough to window.
const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `Zeile ${i} der Basler Chronik.`).join('\n');

// The image client caches bodies by URL at MODULE scope and exports no clear(),
// so two image tests sharing a scan id + page would serve the first one's bytes
// to the second — which silently turns a later assertion into a vacuous pass.
// (It did: the uncropped-400 test below was reading the over-budget test's
// cached buffer until this was introduced.) One scan id per test.
let scanSeq = 0;
const freshScanId = () => `UBBS-IMG${String(++scanSeq).padStart(5, '0')}`;

// ── sgbr_search ──────────────────────────────────────────────────────────────

test('search: compiles the request, shapes hits, and fills both channels', async () => {
  const hit = record('id-1', {
    titleInfoMainTitle: ['Basler Chronik'],
    facetGeneralAuthor: ['Wurstisen, Christian'],
    originInfoPublicationDate: ['1580'],
    availableData: ['Volltext'],
  });
  hit.highlights = { 'mapping.fulltext': ['… der Stadt <em>Basel</em> …'] };
  const calls = serve({ graphql: { Search: { search: searchPayload([hit], { totalCount: 1 }) } } });

  const res = await search({ ...SEARCH_ARGS, query: 'Basel', page_size: 10 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);

  // 1. the compiled request — the plumbing CLAUDE.md says every call must carry
  const [vars] = postVars(calls);
  assert.equal(vars.query, 'Basel');
  assert.equal(vars.view, 'sgbr', 'every search/facet call must send view:"sgbr"');
  assert.deepEqual(vars.searchFields, DEFAULT_SEARCH_FIELDS.map((field) => ({ field })));
  assert.equal(vars.size, 10);
  assert.equal(vars.first, 0, 'page 1 → offset 0');
  assert.deepEqual(vars.sort, [{ field: '_score', order: 'desc' }], 'no server-side sort beyond _score');

  // 2. structuredContent and its declared schema
  const out = res.structuredContent;
  assert.equal(out.total, 1);
  assert.equal(out.page, 1);
  assert.equal(out.returned, 1);
  assert.equal(out.has_more, false);
  assert.equal(out.results[0].id, 'id-1');
  assert.equal(out.results[0].title, 'Basler Chronik');
  assert.deepEqual(out.results[0].snippets, ['… der Stadt Basel …'], 'highlighter tags stripped');
  assertWireValid(searchOutput, out);

  // 3. the human channel carries the same facts
  assert.match(res.content[0].text, /Basler Chronik/);
  assert.equal(res.content[0].type, 'text');
});

test('search: echoes narrowing as applied_filters and compiles the filter clauses', async () => {
  const calls = serve({ graphql: { Search: { search: searchPayload([], { totalCount: 0 }) } } });
  const res = await search({
    ...SEARCH_ARGS, query: 'Basel', scope: 'title', full_text_only: true,
    filters: { library: ['Bern, UB'] }, year_from: 1800, year_to: 1850,
  }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);

  const [vars] = postVars(calls);
  assert.deepEqual(vars.searchFields, [{ field: 'search.title' }], 'scope maps to searchFields, never query syntax');
  const values = vars.filters.flatMap((f) => f.boolTerm?.values || []);
  assert.ok(values.includes('[library].Bern, UB'), 'a string dim filters as [dim].value, not the strings: read form');
  assert.ok(JSON.stringify(vars.filters).includes('Volltext'), 'full_text_only adds the availableData filter');

  // The round-trip contract: a client can tweak one filter and resubmit.
  assert.deepEqual(res.structuredContent.applied_filters, {
    scope: 'title', full_text_only: true,
    filters: { library: ['Bern, UB'] }, year_from: 1800, year_to: 1850,
  });
});

test('search: attaches query-misuse warnings to BOTH channels', async () => {
  serve({ graphql: { Search: { search: searchPayload([], { totalCount: 0 }) } } });
  const res = await search({ ...SEARCH_ARGS, query: 'Basel AND Bern' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.ok(res.structuredContent.warnings?.some((w) => /AND/.test(w)), 'structured warning present');
  assert.match(res.content[0].text, /AND/, 'and mirrored into the text channel');
  assertWireValid(searchOutput, res.structuredContent);
});

// A page past the last one comes back empty with a non-zero total. How the
// past-end warning could fail:
//   - firing on zero hits, which has its own reading (no records match);
//   - an off-by-one at an exactly divisible total (10 at page_size 10: page 2
//     is past the end, page 1 is not);
//   - firing on the last, partial page;
//   - firing beside the short-page warning on a capped page with records left.
// A page past the result window never gets that far: it is refused unsent.
const PAST_END_RE = /No records on this page: page \d+ is past the last page/;
async function searchPage(totalCount, returned, page, pageSize = 10) {
  const hits = Array.from({ length: returned }, (_, i) => record(`id-pe-${i}`, { titleInfoMainTitle: ['T'] }));
  serve({ graphql: { Search: { search: searchPayload(hits, { totalCount }) } } });
  const res = await search({ ...SEARCH_ARGS, query: 'Basel', page, page_size: pageSize }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assertWireValid(searchOutput, res.structuredContent);
  return { res, warnings: res.structuredContent.warnings ?? [] };
}

test('search: a page past the end warns in both channels and names the last page', async () => {
  const { res, warnings } = await searchPage(10, 0, 5);
  const expected = 'No records on this page: page 5 is past the last page (1) of 10 record(s) at ' +
    'page_size 10; request page 1 or lower.';
  assert.deepEqual(warnings, [expected]);
  assert.ok(res.content[0].text.includes(`⚠ ${expected}`), 'mirrored into the text channel');
});

test('search: an exactly divisible total warns one page past the end, not on the last page', async () => {
  const past = await searchPage(10, 0, 2);
  assert.ok(past.warnings.some((w) => PAST_END_RE.test(w)), 'page 2 of 10 at page_size 10');
  const last = await searchPage(10, 10, 1);
  assert.deepEqual(last.warnings, [], 'page 1 holds all 10');
});

test('search: no past-end warning on zero hits or on the last partial page', async () => {
  const none = await searchPage(0, 0, 1);
  assert.ok(!none.warnings.some((w) => PAST_END_RE.test(w)), 'zero hits has its own reading');
  const partial = await searchPage(15, 5, 2);
  assert.deepEqual(partial.warnings, [], 'the last page is short by nature');
});

test('search: a capped page with records left gets the short-page warning only', async () => {
  const { warnings } = await searchPage(100, 6, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /returned 6 of the 10 results requested/);
});

test('search: a page past the result window is refused before any request', async () => {
  const calls = serve({});
  const res = await search({ ...SEARCH_ARGS, query: 'Basel', page: 2000, page_size: 10 }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.equal(postVars(calls).length, 0);
});

test('search: propagates the caller abort signal to the backend request', async () => {
  // The wiring most easily lost in a refactor: ctx.mcpReq.signal → graphqlRequest.
  serve({ graphql: { Search: { search: searchPayload([]) } } });
  const ac = new AbortController();
  ac.abort();
  const res = await search({ ...SEARCH_ARGS, query: 'Basel' }, { mcpReq: { signal: ac.signal } });
  assert.equal(res.isError, true, 'an aborted call must not return results');
});

// ── sgbr_get_record ──────────────────────────────────────────────────────────

test('get_record: mines the link/extended sidecars into a detail record', async () => {
  const rec = record('id-42', {
    titleInfoMainTitle: ['Basler Chronik'],
    sgbrScannedDigIds: ['UBBS-00190048'],
    availableData: ['Volltext'],
    iiifManifest: [{ text: 'manifest', link: 'https://host/iiif/3/UBBS-00190048/manifest' }],
    facetGeneralAuthor: [{
      text: 'Wurstisen, Christian',
      extended: JSON.stringify({ roles: ['author'], authorities: [{ text: 'GND', link: 'https://d-nb.info/gnd/118635174' }] }),
    }],
  });
  const calls = serve({ graphql: { Get: { get: rec } } });

  const res = await getRecord({ id: 'id-42' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);

  assert.equal(postVars(calls)[0].id, 'id-42', 'the id reaches the backend unmangled');
  const out = res.structuredContent;
  assert.equal(out.id, 'id-42');
  assert.equal(out.digital.scan_id, 'UBBS-00190048');
  assert.equal(out.digital.full_text_available, true);
  assert.match(out.digital.iiif_manifest, /manifest$/, 'read from the `link` sidecar, not `text`');
  assert.equal(out.authors[0].authorities[0].url, 'https://d-nb.info/gnd/118635174',
    'the GND authority is mined from the `extended` JSON string');
  assertWireValid(recordOutput, out);
  assert.match(res.content[0].text, /Basler Chronik/);
});

test('get_record: trims stray whitespace from the id', async () => {
  const calls = serve({ graphql: { Get: { get: record('id-42', { titleInfoMainTitle: ['Basler Chronik'] }) } } });
  const res = await getRecord({ id: ' id-42 ' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(postVars(calls)[0].id, 'id-42');
  assert.equal(res.structuredContent.id, 'id-42');
});

test('get_record: an empty result is a clean not-found, not a crash', async () => {
  // The backend answers a bad id with HTTP 200 + empty result, never a 404.
  serve({ graphql: { Get: { get: { id: '', result: [] } } } });
  const res = await getRecord({ id: 'nope' }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No record found for id "nope"/);
  assert.equal(res.structuredContent, undefined, 'an error result carries no structuredContent');
});

// ── sgbr_facet_values ────────────────────────────────────────────────────────

test('facet_values: counts a dimension and reports enrichment coverage', async () => {
  const calls = serve({
    graphql: {
      FacetFilter: { facetFiltered: facetPayload('library', [['Basel, UB', 60], ['Bern, UB', 40]]) },
      Search: { search: searchPayload([], { totalCount: 200 }) },
    },
  });

  const res = await facetValues({ ...FACET_ARGS, query: 'Basel', facet: 'library' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);

  // The counting query and the coverage query must carry the SAME narrowing, or
  // coverage_pct compares against the wrong denominator.
  const [a, b] = postVars(calls);
  assert.deepEqual(a.searchFields, b.searchFields, 'facet and count must agree on scope');
  assert.deepEqual(a.filters, b.filters, 'facet and count must agree on filters');
  assert.equal(a.view, 'sgbr');

  const out = res.structuredContent;
  assert.equal(out.facet, 'library');
  assert.deepEqual(out.values.map((v) => v.value), ['Basel, UB', 'Bern, UB']);
  assert.equal(out.distinct_values, 2, 'facet.count is bucket cardinality');
  assert.equal(out.matching_records, 100, 'facet.nbTotal — records carrying the dimension');
  assert.equal(out.query_total, 200, 'the parallel count call supplies the denominator');
  assert.equal(out.coverage_pct, 50, '100 of 200 hits carry this dimension');
  assertWireValid(facetOutput, out);
  assert.match(res.content[0].text, /Basel, UB/);
});

test('facet_values: full_text_only on the availability facet is flagged as a same-dimension clash', async () => {
  serve({
    graphql: {
      FacetFilter: { facetFiltered: facetPayload('availability', [['Digitalisat (Volltext)', 60], ['kein Digitalisat', 40]]) },
      Search: { search: searchPayload([], { totalCount: 60 }) },
    },
  });
  const res = await facetValues({ ...FACET_ARGS, facet: 'availability', full_text_only: true }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.same_dimension_filter, true);
  assert.equal(res.structuredContent.coverage_pct, null);
  assert.match(res.content[0].text, /both filtered and aggregated/);
});

test('facet_values: a failed count degrades to null coverage instead of failing the tool', async () => {
  // The best-effort half of the parallel pair — untested offline until now.
  serve({
    graphql: {
      FacetFilter: { facetFiltered: facetPayload('library', [['Basel, UB', 60]]) },
      Search: { errors: [{ message: 'stats unavailable' }] },
    },
  });
  const res = await facetValues({ ...FACET_ARGS, facet: 'library' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, 'a failed count must not fail the facet call');
  assert.equal(res.structuredContent.matching_records, 60, 'the facet itself still counted');
  assert.equal(res.structuredContent.query_total, null, 'the denominator is what was lost');
  assert.equal(res.structuredContent.coverage_pct, null, 'no denominator → no coverage claim');
  assertWireValid(facetOutput, res.structuredContent);
});

// ── sgbr_autocomplete ────────────────────────────────────────────────────────

test('autocomplete: reads namedResults and groups suggestions', async () => {
  const calls = serve({
    graphql: {
      Autocomplete: {
        autocomplete: {
          // The trap: titles/authors/subjects are ALWAYS empty; the real
          // suggestions arrive in namedResults keyed by our requested name.
          titles: [], authors: [], subjects: [],
          namedResults: [
            { name: 'title', results: ['Burckhardt Chronik', 'Burckhardt Reise'] },
            { name: 'author', results: ['Burckhardt, Jacob'] },
            { name: 'subject', results: [] },
          ],
          countResult: { resultCount: 12 },
        },
      },
    },
  });

  const res = await autocomplete({ ...COMP_ARGS, query: 'Burck' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);

  const [vars] = postVars(calls);
  assert.equal(vars.query, 'Burck');
  assert.ok(!('view' in vars) || vars.view === undefined, 'autocomplete REJECTS a view arg');
  assert.deepEqual(vars.searchNamedFields.map((f) => f.name), ['title', 'author', 'subject']);

  const out = res.structuredContent;
  assert.deepEqual(out.suggestions.title, ['Burckhardt Chronik', 'Burckhardt Reise']);
  assert.deepEqual(out.suggestions.author, ['Burckhardt, Jacob']);
  assertWireValid(autocompleteOutput, out);
  assert.match(res.content[0].text, /Burckhardt/);
});

test('autocomplete: a single scope requests and returns only that group', async () => {
  const calls = serve({
    graphql: {
      Autocomplete: {
        autocomplete: {
          namedResults: [{ name: 'author', results: ['Burckhardt, Jacob'] }],
          countResult: { resultCount: 3 },
        },
      },
    },
  });
  const res = await autocomplete({ ...COMP_ARGS, query: 'Burck', scope: 'author' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.deepEqual(postVars(calls)[0].searchNamedFields.map((f) => f.name), ['author']);
  assert.deepEqual(Object.keys(res.structuredContent.suggestions), ['author']);
  assertWireValid(autocompleteOutput, res.structuredContent);
});

// ── sgbr_get_fulltext ────────────────────────────────────────────────────────

test('get_fulltext: windows a book by scan_id and points at the next window', async () => {
  const scanId = freshScanId();
  serve({ fulltext: { [scanId]: LONG_TEXT } });
  const res = await getFullText({ ...FULLTEXT_ARGS, scan_id: scanId, max_chars: 500 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);

  const out = res.structuredContent;
  assert.equal(out.scan_id, scanId);
  assert.equal(out.total_chars, LONG_TEXT.length);
  assert.ok(out.returned_chars > 0 && out.returned_chars <= 500, 'the window respects max_chars');
  assert.equal(out.has_more, true);
  assert.equal(out.next_offset, out.returned_chars);
  assertWireValid(fulltextOutput, out);
});

test('get_fulltext: resolves a record id to its scan and keeps the attribution', async () => {
  const scanId = freshScanId();
  serve({
    graphql: { Get: { get: record('id-42', { sgbrScannedDigIds: [scanId] }) } },
    fulltext: { [scanId]: LONG_TEXT },
  });
  const res = await getFullText({ ...FULLTEXT_ARGS, id: 'id-42' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.scan_id, scanId);
  assert.equal(res.structuredContent.id, 'id-42', 'a scan resolved FROM a record keeps that attribution');
  assertWireValid(fulltextOutput, res.structuredContent);
});

test('get_fulltext: refuses a multi-scan work id, lists its scans and fetches no text', async () => {
  const calls = serve({
    graphql: { Get: { get: record('id991-ft', { sgbrScannedDigIds: ['ZHBL-1', 'UBBS-1'] }) } },
  });
  const res = await getFullText({ ...FULLTEXT_ARGS, id: 'id991-ft' }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ZHBL-1/);
  assert.match(res.content[0].text, /UBBS-1/);
  assert.equal(calls.some((c) => /get_gb_fulltext/.test(c.url)), false, 'no full-text fetch was made');
});

test('inspect_image: refuses a multi-scan work id, lists its scans and fetches no image', async () => {
  const calls = serve({
    graphql: { Get: { get: record('id991-img', { sgbrScannedDigIds: ['ZHBL-1', 'UBBS-1'] }) } },
  });
  const res = await inspectImage({ ...IMAGE_ARGS, id: 'id991-img', page: 1 }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ZHBL-1/);
  assert.match(res.content[0].text, /UBBS-1/);
  assert.equal(calls.some((c) => /default\.jpg|info\.json/.test(c.url)), false, 'no image fetch was made');
});

test('get_fulltext: an unknown scan (HTTP 400) is the actionable no-full-text error', async () => {
  const scanId = freshScanId();
  stub = installFetchStub(() => ({ status: 400, contentType: 'application/json', body: '{"message":"Files for scan_id not found"}' }));
  const res = await getFullText({ ...FULLTEXT_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No full text is available/);
});

test('get_fulltext: an empty body is an actionable error, not an empty window', async () => {
  const scanId = freshScanId();
  serve({ fulltext: { [scanId]: '' } });
  const res = await getFullText({ ...FULLTEXT_ARGS, scan_id: scanId }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No full text is available/);
});

// Per-page OCR text assets: a blank page is an empty 200, past the end is 404
// (the stub answers any page without a fixture with 404).
const PAGES = { 'text:1': 'Titel\n', 'text:2': '', 'text:3': 'Die Brücke\n' };

test('get_fulltext: reads a page span with a marker per page, blank pages kept', async () => {
  const scanId = freshScanId();
  serve({ ocr: PAGES });
  const res = await getFullText({ ...FULLTEXT_ARGS, scan_id: scanId, page_from: 1, page_to: 3 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = res.structuredContent;
  assert.equal(out.text, '--- page 1 ---\nTitel\n\n--- page 2 (no text) ---\n\n--- page 3 ---\nDie Brücke');
  assert.deepEqual([out.page_from, out.page_to, out.last_page], [1, 3, null]);
  assert.equal(out.viewer_url, null, 'no record id, no viewer link');
  assert.match(out.source_url, new RegExp(`get_gb_fulltext/${scanId}$`), 'the whole-book text the span is cut from');
  assertWireValid(fulltextOutput, out);
});

test('get_fulltext: a span past the end is trimmed and names the last page', async () => {
  const scanId = freshScanId();
  serve({ ocr: PAGES });
  const res = await getFullText({ ...FULLTEXT_ARGS, scan_id: scanId, page_from: 2, page_to: 20 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.deepEqual([res.structuredContent.page_to, res.structuredContent.last_page], [3, 3]);
  assert.match(res.content[0].text, /The volume ends at page 3\./);
});

test('get_fulltext: a span starting past the end says how many pages the scan has', async () => {
  const scanId = freshScanId();
  serve({ ocr: PAGES });
  const res = await getFullText({ ...FULLTEXT_ARGS, scan_id: scanId, page_from: 9 }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Page 9 is past the end .* which has 3 page\(s\)/);
});

test('get_fulltext: a page span on a scan with no OCR is the no-full-text error', async () => {
  const scanId = freshScanId();
  serve({ ocr: {} });
  const res = await getFullText({ ...FULLTEXT_ARGS, scan_id: scanId, page_from: 1 }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No full text is available/);
});

// ── sgbr_inspect_image ───────────────────────────────────────────────────────

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(2048).fill(0x41), 0xff, 0xd9]);

test('inspect_image: returns image bytes on the image channel plus a text caption', async () => {
  const scanId = freshScanId();
  const calls = serve({ image: { 'page:3': JPEG } });
  const res = await inspectImage({ ...IMAGE_ARGS, scan_id: scanId, page: 3 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);

  // The IIIF grammar is built in one helper; pin that the handler used it. With
  // no `info` fixture the description 404s, so the native clamp is skipped and
  // the edge is capped at what a near-square image can take undownscaled.
  const imageCall = calls.find((c) => c.url.includes('/default.jpg'));
  const m = new RegExp(`/gbooks/${scanId}_00000003\\.jp2/full/!(\\d+),(\\d+)/0/default\\.jpg$`).exec(imageCall.url);
  assert.ok(m, imageCall.url);
  assert.equal(m[1], m[2]);
  assert.ok(Number(m[1]) > 1900 && Number(m[1]) <= MAX_IMAGE_LONG_EDGE);
  assert.ok(fitsVisionBudget(Number(m[1]), Number(m[1])), 'a square at the fallback edge must reach the model undownscaled');

  const [image, text] = res.content;
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(image.data, 'base64').length, JPEG.length, 'the real bytes ride on the image block');
  assert.equal(text.type, 'text');
  assert.match(text.text, new RegExp(`Page 3 of scan ${scanId}`));
  assert.equal(res.structuredContent.page, 3);
});

function plateRecord(plateId) {
  return record(plateId, {
    sgbrObjectType: ['Falttafel'],
    thumbnail: [{ link: `https://host/iiif/3/gbooks/${plateId}.jp2/full/400,/0/default.jpg` }],
  });
}

test('inspect_image: an explicit page on a plate id reads the parent volume and drops the id', async () => {
  const scanId = freshScanId();
  const plateId = `${scanId}_00000057`;
  serve({
    graphql: { Get: { get: plateRecord(plateId) } },
    image: { 'page:3': JPEG, 'page:57': JPEG },
  });
  const res = await inspectImage({ ...IMAGE_ARGS, id: plateId, page: 3 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.page, 3);
  assert.equal(res.structuredContent.scan_id, scanId);
  assert.equal(res.structuredContent.id ?? null, null, 'page 3 is the parent volume, not the plate');
  assert.doesNotMatch(res.structuredContent.viewer_url ?? '', new RegExp(plateId));
  assert.doesNotMatch(res.content[1].text, new RegExp(plateId));
});

test('inspect_image: a plate id without a page keeps its attribution', async () => {
  const scanId = freshScanId();
  const plateId = `${scanId}_00000057`;
  serve({
    graphql: { Get: { get: plateRecord(plateId) } },
    image: { 'page:57': JPEG },
  });
  const res = await inspectImage({ ...IMAGE_ARGS, id: plateId }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.page, 57);
  assert.equal(res.structuredContent.id, plateId);
  assert.match(res.structuredContent.viewer_url, new RegExp(plateId));
});

test('inspect_image: a crop compiles into the IIIF region and is echoed back', async () => {
  const calls = serve({ image: { 'page:3': JPEG } });
  const res = await inspectImage(
    { ...IMAGE_ARGS, scan_id: freshScanId(), page: 3, region_pct: [10, 20, 30, 40] },
    { mcpReq: {} },
  );
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const imageCall = calls.find((c) => c.url.includes('/default.jpg'));
  assert.match(imageCall.url, /\/pct:10,20,30,40\//, 'region_pct compiles to a IIIF pct: region');
  assert.deepEqual(res.structuredContent.region_pct, [10, 20, 30, 40]);
  // No info.json here, so nothing could hold a small crop back from being enlarged.
  const [warning] = res.structuredContent.warnings;
  assert.match(warning, /native size could not be read/);
  assert.match(warning, /widen region_pct/);
});

test('inspect_image: a large crop without info.json carries no sizing warning', async () => {
  serve({ image: { 'page:3': JPEG } });
  const res = await inspectImage(
    { ...IMAGE_ARGS, scan_id: freshScanId(), page: 3, region_pct: [0, 0, 90, 90], max_long_edge: 512 },
    { mcpReq: {} },
  );
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.warnings, undefined, 'a 90% crop of any book page exceeds 512px');
});

test('inspect_image: a whole page without info.json carries no sizing warning', async () => {
  serve({ image: { 'page:3': JPEG } });
  const res = await inspectImage({ ...IMAGE_ARGS, scan_id: freshScanId(), page: 3 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.warnings, undefined);
});

test('inspect_image: a crop is clamped to the region\'s own scanned pixels', async () => {
  // The defect this whole path exists for: the mediaserver upscales a region
  // smaller than the requested box (despite advertising no `sizeUpscaling`), so
  // a word-sized crop would otherwise be interpolated up to a full-page payload
  // carrying no more information.
  const scanId = freshScanId();
  const calls = serve({
    image: { 'page:3': JPEG },
    info: { 'page:3': { width: 1752, height: 2632 } },
  });
  const res = await inspectImage(
    // 10% × 5% of 1752×2632 = 175×132 native pixels.
    { ...IMAGE_ARGS, scan_id: scanId, page: 3, region_pct: [10, 10, 10, 5] },
    { mcpReq: {} },
  );
  assert.notEqual(res.isError, true, res.content?.[0]?.text);

  const imageCall = calls.find((c) => c.url.includes('/default.jpg'));
  assert.match(imageCall.url, /\/!175,175\//, 'the box is the region\'s native long edge, not the request');
  assert.equal(res.structuredContent.long_edge, 175);

  const [warning] = res.structuredContent.warnings;
  assert.match(warning, /175×132 pixels/, 'names the real size so the model can judge it');
  assert.match(warning, /widen region_pct/, 'points at the lever that actually adds pixels');
  assert.doesNotMatch(warning, /downscaled/, 'must not give the opposite (vision-bound) advice');
});

test('inspect_image: a full page is NOT clamped when it has pixels to spare', async () => {
  const calls = serve({
    image: { 'page:1': JPEG },
    info: { 'page:1': { width: 3000, height: 4200 } },
  });
  const res = await inspectImage({ ...IMAGE_ARGS, scan_id: freshScanId(), page: 1 }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const imageCall = calls.find((c) => c.url.includes('/default.jpg'));
  assert.match(imageCall.url, new RegExp(`/!${MAX_IMAGE_LONG_EDGE},${MAX_IMAGE_LONG_EDGE}/`));
  assert.equal(res.structuredContent.warnings, undefined, 'nothing was reduced, so nothing to warn about');
});

test('inspect_image: a 400 on a cropped request is translated into crop advice', async () => {
  // The bare backend 400 names neither the cause nor a fix; the handler must
  // turn it into something the model can self-correct from.
  stub = installFetchStub(() => ({ status: 400, contentType: 'text/plain', body: 'Bad Request' }));
  clearGraphqlCache();
  const res = await inspectImage(
    { ...IMAGE_ARGS, scan_id: freshScanId(), page: 1, region_pct: [0.01, 0.01, 0.01, 0.01] },
    { mcpReq: {} },
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /region_pct crop/);
  assert.match(res.content[0].text, /less than one pixel/, 'names the actual cause');
});

test('inspect_image: an over-budget image is refused with a smaller-edge suggestion', async () => {
  // The shaper drops `data` rather than blowing the response budget; the handler
  // must turn that into actionable text instead of returning an image block with
  // no image in it.
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1024, 0x41);
  serve({ image: { 'page:1': huge } });
  const res = await inspectImage({ ...IMAGE_ARGS, scan_id: freshScanId(), page: 1 }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Image too large/);
  assert.match(res.content[0].text, /smaller max_long_edge/, 'names the knob that fixes it');
});

test('inspect_image: an uncropped 400 is NOT mislabelled as a crop problem', async () => {
  // The other half of the same branch: without region_pct the crop advice would
  // be a confident wrong answer.
  stub = installFetchStub(() => ({ status: 400, contentType: 'text/plain', body: 'Bad Request' }));
  clearGraphqlCache();
  const res = await inspectImage({ ...IMAGE_ARGS, scan_id: freshScanId(), page: 1 }, { mcpReq: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Image service returned HTTP 400/, 'the raw service error, unembellished');
  assert.doesNotMatch(res.content[0].text, /less than one pixel/);
});

// --- a refused query never reaches the backend --------------------------------
// (Which forms are refused, and by which tools, is pinned in warnings.test.js and
// query_refusal.test.js; this checks only the ordering the stub can see.)

test('a refused query is an isError with zero requests', async () => {
  const calls = serve({});
  const res = await search({ ...SEARCH_ARGS, query: '(Cholera)' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /whole corpus/i);
  assert.equal(postVars(calls).length, 0, 'a refused query must not reach the backend');
});
