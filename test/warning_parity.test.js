// The wire half of "two output channels, always": a warning must reach BOTH.
//
// A warning that lands only in `content[].text` is invisible to a client reading
// structuredContent, and one that lands only in structuredContent is invisible
// to a reader of the text: a host may show the model only one channel.
// `withWarnings` mirrors a single list into both; these tests pin that no tool
// has drifted off it, at the handler boundary rather than inside the helper.
//
// What is enforced here is PREFIX SYMMETRY: a `⚠ ` line with no structured
// entry, or a structured entry with no line. An un-prefixed caveat buried in
// prose is invisible to both guards below, and deliberately so — "is this
// sentence a caveat?" is not a decidable question for a regex. Do not read
// these tests as covering it.
//
// Three guards, failing for different reasons: the registry check catches a
// warning-capable tool nobody wrote a scenario for, the source lint catches a
// tool formatting its own line (which the mirror never sees), and the
// behavioural check catches the two channels disagreeing.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { registerSearchTool } from '../src/tools/search.js';
import { registerFacetValuesTool } from '../src/tools/facet_values.js';
import { registerFacetBreakdownTool } from '../src/tools/facet_breakdown.js';
import { registerLocateTextTool } from '../src/tools/locate_text.js';
import { registerAutocompleteTool } from '../src/tools/autocomplete.js';
import { registerInspectImageTool } from '../src/tools/inspect_image.js';
import { clearGraphqlCache } from '../src/graphql/client.js';
import { FACET_DIMENSIONS, MAX_IMAGE_LONG_EDGE } from '../src/config.js';
import { makeRouter, installFetchStub, searchPayload, facetPayload } from './stub-backend.js';
import { captureHandler, ROOT, withClient } from './helpers.js';

// U+26A0 + SPACE, mirrorWarnings' WARN_PREFIX. Deliberately NOT the `⚠️` used by
// the full-text injection boundary in config.js, which is U+26A0 + U+FE0F (the
// emoji variation selector) + SPACE and therefore never matches this. Keep the
// distinction: a bare-glyph check would flag that boundary as a stray warning,
// and a looser extractor would mis-parse an OCR body as a warning list.
const WARN_PREFIX = '⚠ ';

const structuredWarnings = (res) => res.structuredContent?.warnings ?? [];
const textWarnings = (res) => (res.content ?? [])
  .filter((c) => c.type === 'text' && typeof c.text === 'string')
  .flatMap((c) => c.text.split('\n'))
  .filter((line) => line.startsWith(WARN_PREFIX))
  .map((line) => line.slice(WARN_PREFIX.length));

// ── the scenarios ────────────────────────────────────────────────────────────

const search = captureHandler(registerSearchTool);
const facetValues = captureHandler(registerFacetValuesTool);
const facetBreakdown = captureHandler(registerFacetBreakdownTool);
const locateText = captureHandler(registerLocateTextTool);
const autocomplete = captureHandler(registerAutocompleteTool);
const inspectImage = captureHandler(registerInspectImageTool);

// Direct invocation bypasses zod, so every scenario spells out the defaults.
const SEARCH_ARGS = { query: '', scope: 'all', full_text_only: false, page: 1, page_size: 10 };
const FACET_ARGS = { query: '', scope: 'all', full_text_only: false, facet: 'library', size: 20 };
const COMP_ARGS = { query: '', scope: 'all', full_text_only: false, limit: 10 };
const BREAKDOWN_ARGS = {
  query: '', scope: 'all', full_text_only: false,
  facet: 'language', breakdown: 'genre', size: 2, breakdown_size: 2,
};
const LOCATE_ARGS = { phrase: '', start_page: 1, max_pages: 5, max_hits: 5, level: 'line' };
const IMAGE_ARGS = { max_long_edge: MAX_IMAGE_LONG_EDGE };

const LANGUAGES = [['Deutsch', 60], ['Französisch', 40]];
const GENRES = [['Nachruf', 30], ['Hochschulschrift', 20]];
const NO_HITS = { graphql: { Search: { search: searchPayload([], { totalCount: 0 }) } } };

// One FacetFilter fixture serving both cross-tab axes, routed by the dimension's
// backend field — the two axis calls are otherwise indistinguishable.
const facetByDimension = (byDim) => (vars) => {
  for (const [dim, values] of Object.entries(byDim)) {
    if (FACET_DIMENSIONS[dim].field === vars?.facet?.term?.field) {
      return { facetFiltered: facetPayload(dim, values) };
    }
  }
  throw new Error(`no facet fixture for field ${vars?.facet?.term?.field}`);
};

// Every cell the grid asks for, so the shaper's missing-cell hard-fail stays out
// of the way of what this file is actually testing.
const statsGrid = (rows, cols) => ({
  stats: {
    statsResult: rows.flatMap((_, i) => cols.map((__, j) => ({
      name: `${i}:${j}`, countResult: { resultCount: 1 },
    }))),
  },
});

// `expect` names the warning each row exists to provoke, so a fixture that stops
// provoking one fails as a vacuous test rather than passing on two empty lists.
const SCENARIOS = [
  {
    name: 'search: AND read as a literal term',
    tool: 'sgbr_search', handler: search, fixtures: NO_HITS,
    args: { ...SEARCH_ARGS, query: 'Basel AND Bern' },
    expect: /literal search term/,
  },
  {
    name: 'search: field:value does no field scoping',
    tool: 'sgbr_search', handler: search, fixtures: NO_HITS,
    args: { ...SEARCH_ARGS, query: 'title:Basel' },
    expect: /field:value syntax/,
  },
  {
    name: 'search: a pinned-vocabulary narrowing that returned zero',
    tool: 'sgbr_search', handler: search, fixtures: NO_HITS,
    args: { ...SEARCH_ARGS, filters: { availability: ['Nicht Existierender Wert'] } },
    expect: /occasionally renames these/,
  },
  {
    name: 'search: a page past the last one',
    tool: 'sgbr_search', handler: search,
    fixtures: { graphql: { Search: { search: searchPayload([], { totalCount: 10 }) } } },
    args: { ...SEARCH_ARGS, query: 'Basel', page: 5 },
    expect: /past the last page/,
  },
  {
    name: 'autocomplete: AND read as a literal term',
    tool: 'sgbr_autocomplete', handler: autocomplete,
    fixtures: {
      graphql: {
        Autocomplete: {
          autocomplete: {
            namedResults: [{ name: 'author', results: ['Burckhardt, Jacob'] }],
            countResult: { resultCount: 3 },
          },
        },
      },
    },
    args: { ...COMP_ARGS, query: 'Burckhardt AND Basel', scope: 'author' },
    expect: /literal search term/,
  },
  {
    name: 'facet_values: one dimension both filtered and aggregated',
    tool: 'sgbr_facet_values', handler: facetValues,
    fixtures: {
      graphql: {
        FacetFilter: { facetFiltered: facetPayload('library', [['Basel, UB', 60]]) },
        Search: { search: searchPayload([], { totalCount: 200 }) },
      },
    },
    args: { ...FACET_ARGS, facet: 'library', filters: { library: ['Basel, UB'] } },
    expect: /both filtered and aggregated/,
  },
  {
    name: 'facet_values: buckets out-summing the query total',
    tool: 'sgbr_facet_values', handler: facetValues,
    fixtures: {
      graphql: {
        FacetFilter: { facetFiltered: facetPayload('library', [['Basel, UB', 600]]) },
        Search: { search: searchPayload([], { totalCount: 10 }) },
      },
    },
    args: { ...FACET_ARGS, facet: 'library' },
    expect: /exceeds query_total/,
  },
  {
    name: 'facet_breakdown: an axis both filtered and aggregated',
    tool: 'sgbr_facet_breakdown', handler: facetBreakdown,
    fixtures: {
      graphql: {
        FacetFilter: facetByDimension({ language: LANGUAGES, genre: GENRES }),
        Search: { search: searchPayload([], { totalCount: 100 }) },
        Stats: statsGrid(LANGUAGES, GENRES),
      },
    },
    args: { ...BREAKDOWN_ARGS, filters: { language: ['Deutsch'] } },
    expect: /both filtered and aggregated/,
  },
  {
    name: 'inspect_image: a crop clamped to its own scanned pixels',
    tool: 'sgbr_inspect_image', handler: inspectImage,
    // 2% × 1% of 1752×2632 = 35×26 native pixels, far under any requested box.
    fixtures: {
      image: { 'page:1': Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]) },
      info: { 'page:1': { width: 1752, height: 2632 } },
    },
    args: { ...IMAGE_ARGS, scan_id: 'UBBS-WARNPARITY', page: 1, region_pct: [10, 10, 2, 1] },
    expect: /interpolation, not detail/,
  },
  {
    name: 'locate_text: a miss that OCR coverage cannot prove',
    tool: 'sgbr_locate_text', handler: locateText,
    // Page 1 has text without the phrase; page 2 is absent → the 404 page
    // boundary, so the scan stops there with no hits.
    fixtures: { ocr: { 'text:1': 'Eine Seite ohne den gesuchten Ausdruck.' } },
    args: { ...LOCATE_ARGS, scan_id: 'UBBS-WARNPARITY', phrase: 'Gletscher' },
    expect: /not exhaustively proven/,
  },
];

// ── guard 1: every warning-capable tool has a scenario ───────────────────────

// Registry-driven, following test/docs.test.js: a tool that declares `warnings`
// in its outputSchema is a tool that can warn, and the wire is the only list of
// those that cannot go stale. An enumeration maintained by hand misses tool ten
// — it already missed sgbr_autocomplete once.
test('every tool that can emit warnings is covered by a scenario', async () => {
  const { tools } = await withClient('ub-sgbr-warning-parity', (client) => client.listTools());
  const canWarn = tools
    .filter((t) => t.outputSchema?.properties?.warnings)
    .map((t) => t.name).sort();
  const covered = [...new Set(SCENARIOS.map((s) => s.tool))].sort();

  assert.deepEqual(
    covered, canWarn,
    'each tool declaring a `warnings` output field needs at least one parity scenario',
  );
});

// ── guard 2: nobody formats their own warning line ───────────────────────────

function jsFilesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath, e.name));
}

// A lint, not a proof: it matches the literal prefix, so a `\u`-escaped spelling
// of the same character walks straight past it. The gap is left open on purpose
// — guard 3 catches the escaped form for any tool that has a scenario, and a
// source scan that tried to evaluate escapes would be the wrong tool for the job.
test('the warning prefix is emitted from exactly one module', () => {
  const offenders = jsFilesUnder(join(ROOT, 'src'))
    .filter((file) => readFileSync(file, 'utf8').includes(WARN_PREFIX))
    .map((file) => relative(ROOT, file));

  assert.deepEqual(
    offenders, ['src/lib/warnings.js'],
    'warnings.js owns the ⚠ prefix; a second emitter bypasses the structuredContent mirror',
  );
});

// ── guard 3: both channels agree, per tool ───────────────────────────────────

let stub = null;
afterEach(() => { stub?.restore(); stub = null; clearGraphqlCache(); });

function serve(fixtures) {
  stub = installFetchStub(makeRouter(fixtures));
  clearGraphqlCache();
}

for (const scenario of SCENARIOS) {
  test(`both channels carry the same warnings — ${scenario.name}`, async () => {
    serve(scenario.fixtures);
    const res = await scenario.handler(scenario.args, { mcpReq: {} });
    assert.notEqual(res.isError, true, `scenario errored: ${res.content?.[0]?.text}`);

    const structured = structuredWarnings(res);
    assert.ok(
      structured.some((w) => scenario.expect.test(w)),
      `scenario no longer provokes ${scenario.expect}; got: ${JSON.stringify(structured)}`,
    );
    // Exact equality, in order: `withWarnings` mirrors one list into both
    // channels, so anything but identity means a second, unmirrored source.
    assert.deepEqual(
      textWarnings(res), structured,
      'the text channel must render exactly the warnings structuredContent declares',
    );
  });
}

test('a clean call carries no warnings in either channel', async () => {
  serve({ graphql: { Search: { search: searchPayload([], { totalCount: 7 }) } } });
  const res = await search({ ...SEARCH_ARGS, query: 'Basel' }, { mcpReq: {} });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  // The `warnings` key must be ABSENT, not an empty array: withWarnings returns
  // the shaper's object untouched when there is nothing to say, and prune()
  // keeps empty values out of the payload.
  assert.equal(res.structuredContent.warnings, undefined, 'no warnings key on a clean result');
  assert.deepEqual(textWarnings(res), [], 'no ⚠ lines in the text channel');
});
