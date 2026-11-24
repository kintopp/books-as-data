// Offline unit tests for the sgbr_facet_breakdown cross-tab: the compiler's
// grid-building (buildStatsCrosstabVariables) and the shaper
// (buildFacetBreakdownResponse), modeled after facet.test.js / compiler.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatsCrosstabVariables, buildDimensionFilters } from '../src/search/compiler.js';
import { buildFacetBreakdownResponse, buildAxisMeta } from '../src/lib/facet_breakdown.js';
import { registerFacetBreakdownTool } from '../src/tools/facet_breakdown.js';
import { clearGraphqlCache } from '../src/graphql/client.js';
import { FACET_DIMENSIONS } from '../src/config.js';
import { makeRouter, installFetchStub, facetPayload } from './stub-backend.js';
import { captureHandler } from './helpers.js';

const hasFlagsAll = (filters) =>
  filters.some((f) => f.boolTerm?.field === 'flags' && f.boolTerm?.values?.includes('all'));

// Two shaped facet-axis rows (as buildFacetResponse would produce): languages
// for the row axis, genres for the column axis.
const rowValues = [
  { value: 'Deutsch', count: 108362 },
  { value: 'Französisch', count: 16372 },
];
const colValues = [
  { value: 'Nachruf', count: 5000 },
  { value: 'Hochschulschrift', count: 20000 },
];

test('buildStatsCrosstabVariables: throws on an unknown facet or breakdown dimension', () => {
  assert.throws(
    () => buildStatsCrosstabVariables({ facet: 'bogus', breakdown: 'genre', rowValues, colValues }),
    /unknown facet dimension/,
  );
  assert.throws(
    () => buildStatsCrosstabVariables({ facet: 'language', breakdown: 'bogus', rowValues, colValues }),
    /unknown breakdown dimension/,
  );
});

test('buildStatsCrosstabVariables: builds one queryFilters entry per cell, both axis clauses AND-combined', () => {
  const v = buildStatsCrosstabVariables({
    query: 'Basel', facet: 'language', breakdown: 'genre', rowValues, colValues,
  });
  assert.equal(v.query, 'Basel');
  assert.equal('view' in v, false, 'stats rejects a view arg');
  assert.ok(hasFlagsAll(v.filters), 'base filters (flags:all) ride in `filters`');
  assert.equal(v.queryFilters.length, rowValues.length * colValues.length);

  // Cell (0,0): Deutsch × Nachruf.
  const cell00 = v.queryFilters.find((c) => c.name === '0:0');
  assert.ok(cell00, 'expected a cell named "0:0"');
  assert.equal(cell00.inFilter.length, 2, 'both the row and column dimension clauses');
  const values = cell00.inFilter.flatMap((f) => f.boolTerm.values);
  assert.ok(values.includes('[language].Deutsch'));
  assert.ok(values.includes('[genre].Nachruf'));

  // Cell (1,1): Französisch × Hochschulschrift.
  const cell11 = v.queryFilters.find((c) => c.name === '1:1');
  const values11 = cell11.inFilter.flatMap((f) => f.boolTerm.values);
  assert.ok(values11.includes('[language].Französisch'));
  assert.ok(values11.includes('[genre].Hochschulschrift'));
});

test('buildStatsCrosstabVariables: puts every narrowing clause in each cell, sharing only flags', () => {
  const v = buildStatsCrosstabVariables({
    query: 'Basel', facet: 'language', breakdown: 'genre', rowValues, colValues, fullTextOnly: true,
    filters: { library: ['Bern, UB Münstergasse'] }, year_from: 1800, year_to: 1849,
  });
  // stats mislabels cells when any narrowing clause is shared.
  assert.deepEqual(v.filters, [{ boolTerm: { and: true, field: 'flags', values: ['all'] } }]);
  for (const cell of v.queryFilters) {
    const values = cell.inFilter.flatMap((f) => f.boolTerm?.values || []);
    assert.ok(values.some((x) => x.startsWith('[library].')), `${cell.name}: library narrowing`);
    assert.ok(cell.inFilter.some((f) => f.boolTerm?.field === '[facet.daterange].daterange'), `${cell.name}: year range`);
    assert.ok(values.some((x) => x.startsWith('[availableData].')), `${cell.name}: full-text-only`);
  }
});

// Shaper tests.

function syntheticStats(rows, cols) {
  const statsResult = [];
  rows.forEach((_, i) => cols.forEach((_, j) => {
    statsResult.push({ name: `${i}:${j}`, countResult: { resultCount: (i + 1) * 10 + j } });
  }));
  return statsResult;
}

test('buildFacetBreakdownResponse: shapes a 2x2 grid from statsResult keyed by i:j', () => {
  const statsResult = syntheticStats(rowValues, colValues);
  const { structured } = buildFacetBreakdownResponse({
    facet: 'language', breakdown: 'genre', query: 'Basel', scope: 'all', fullTextOnly: false,
    rowValues, colValues, statsResult,
  });
  assert.equal(structured.facet, 'language');
  assert.equal(structured.breakdown, 'genre');
  assert.equal(structured.rows.length, 2);
  assert.equal(structured.rows[0].value, 'Deutsch');
  assert.equal(structured.rows[0].total, 108362, "row total is the facet-A bucket count, not a cell sum");
  assert.equal(structured.rows[0].cells.length, 2);
  assert.equal(structured.rows[0].cells[0].value, 'Nachruf');
  assert.equal(structured.rows[0].cells[0].count, 10); // i=0,j=0 -> (0+1)*10+0
  assert.equal(structured.rows[1].cells[1].count, 21); // i=1,j=1 -> (1+1)*10+1
});

test('buildFacetBreakdownResponse: carries gnd_id through for an author axis', () => {
  const authorRows = [{ value: 'Burckhardt, Jacob', count: 12, gnd_id: '(DE-588)118516272' }];
  const cols = [{ value: 'Nachruf', count: 5 }];
  const statsResult = [{ name: '0:0', countResult: { resultCount: 3 } }];
  const { structured } = buildFacetBreakdownResponse({
    facet: 'author', breakdown: 'genre', query: '', scope: 'all', fullTextOnly: false,
    rowValues: authorRows, colValues: cols, statsResult,
  });
  assert.equal(structured.rows[0].gnd_id, '(DE-588)118516272');
});

test('buildFacetBreakdownResponse: text channel renders the grid and never a summed total', () => {
  const statsResult = syntheticStats(rowValues, colValues);
  const { text } = buildFacetBreakdownResponse({
    facet: 'language', breakdown: 'genre', query: 'Basel', scope: 'all', fullTextOnly: false,
    rowValues, colValues, statsResult,
  });
  assert.match(text, /Deutsch/);
  assert.match(text, /Nachruf/);
  assert.match(text, /not a sum of the (displayed )?cells/);
  // The row total (108,362) must appear as the facet bucket note, and must NOT
  // be presented as the sum of its own cells (10 + 11 = 21, not 108,362).
  assert.match(text, /108,362/);
});

test('buildFacetBreakdownResponse: echoes applied_filters when narrowed', () => {
  const statsResult = syntheticStats(rowValues, colValues);
  const applied = { filters: { library: ['Bern, UB Münstergasse'] } };
  const { structured } = buildFacetBreakdownResponse({
    facet: 'language', breakdown: 'genre', query: 'Basel', scope: 'all', fullTextOnly: false,
    rowValues, colValues, statsResult, applied,
  });
  assert.deepEqual(structured.applied_filters, applied);
});

// An incomplete grid must FAIL, not silently zero-fill: the backend returns a named
// entry for every requested cell, including zero-count ones, so a missing cell is
// always an anomaly — and a fabricated 0 in an "exact counts" tool is worse than an
// error the model can retry.
test('buildFacetBreakdownResponse: an empty statsResult throws instead of yielding an all-zero grid', () => {
  assert.throws(
    () => buildFacetBreakdownResponse({
      facet: 'language', breakdown: 'genre', query: '', scope: 'all', fullTextOnly: false,
      rowValues, colValues, statsResult: [], // no cells at all
    }),
    /incomplete cross-tab grid: 4 of 4/,
  );
});

test('buildFacetBreakdownResponse: a partially missing grid throws with the missing-cell count', () => {
  const statsResult = syntheticStats(rowValues, colValues).filter((c) => c.name !== '1:0');
  assert.throws(
    () => buildFacetBreakdownResponse({
      facet: 'language', breakdown: 'genre', query: '', scope: 'all', fullTextOnly: false,
      rowValues, colValues, statsResult,
    }),
    /incomplete cross-tab grid: 1 of 4/,
  );
});

test('buildFacetBreakdownResponse: a cell without a numeric countResult counts as missing', () => {
  const statsResult = syntheticStats(rowValues, colValues);
  statsResult[0] = { name: '0:0', countResult: null }; // present but uncountable
  assert.throws(
    () => buildFacetBreakdownResponse({
      facet: 'language', breakdown: 'genre', query: '', scope: 'all', fullTextOnly: false,
      rowValues, colValues, statsResult,
    }),
    /incomplete cross-tab grid: 1 of 4/,
  );
});

test('buildFacetBreakdownResponse: a genuine zero-count cell (named, resultCount 0) is NOT missing', () => {
  const statsResult = syntheticStats(rowValues, colValues);
  statsResult[0] = { name: '0:0', countResult: { resultCount: 0 } };
  const { structured } = buildFacetBreakdownResponse({
    facet: 'language', breakdown: 'genre', query: '', scope: 'all', fullTextOnly: false,
    rowValues, colValues, statsResult,
  });
  assert.equal(structured.rows[0].cells[0].count, 0);
});

// ── buildAxisMeta + axis truncation reporting ────────────────────────────────

test('buildAxisMeta flags truncation from distinct_values/others_count', () => {
  // 25 shown of 134 total libraries, ~1M docs in the un-shown values → truncated.
  const shaped = { values: new Array(25).fill({ value: 'x', count: 1 }), distinct_values: 134, others_count: 1007967 };
  const axis = buildAxisMeta('library', 25, shaped);
  assert.deepEqual(axis, {
    dimension: 'library', requested_size: 25, returned: 25,
    distinct_values: 134, others_count: 1007967, truncated: true,
  });
});

test('buildAxisMeta is not truncated when every value fits', () => {
  const shaped = { values: [{ value: 'Deutsch', count: 9 }], distinct_values: 1, others_count: 0 };
  const axis = buildAxisMeta('language', 10, shaped);
  assert.equal(axis.truncated, false);
});

test('buildAxisMeta fallback: a bare {values} object is treated as complete (distinct unknown)', () => {
  const axis = buildAxisMeta('genre', undefined, { values: [{ value: 'Nachruf', count: 1 }] });
  assert.equal(axis.distinct_values, null);
  assert.equal(axis.others_count, 0);
  assert.equal(axis.truncated, false);
  assert.equal(axis.requested_size, 1, 'requested_size falls back to the returned count');
});

// ── same-dimension clash on an axis ──────────────────────────────────────────
// Axis discovery inherits RDV's exclude-own-filter aggregation, so a filtered
// axis's values/distinct_values/others_count ignore that filter. The CELLS stay
// exact, so the fix is to drop the misleading per-row total, not the grid.

test('buildAxisMeta propagates a same-dimension clash and leaves a clean axis untouched', () => {
  const clashed = buildAxisMeta('language', 2, {
    values: rowValues, distinct_values: 201, others_count: 9000, same_dimension_filter: true,
  });
  assert.equal(clashed.same_dimension_filter, true);
  assert.equal(clashed.truncated, true, 'still answers "would raising size show more rows?"');

  const clean = buildAxisMeta('genre', 2, { values: colValues, distinct_values: 2, others_count: 0 });
  assert.equal('same_dimension_filter' in clean, false, 'absent, not false — the common axis stays lean');
});

test('a filtered row axis omits per-row totals and says why', () => {
  const rowAxis = buildAxisMeta('language', 2, {
    values: rowValues, distinct_values: 201, others_count: 9000, same_dimension_filter: true,
  });
  const colAxis = buildAxisMeta('genre', 2, { values: colValues, distinct_values: 2, others_count: 0 });
  const { structured, text } = buildFacetBreakdownResponse({
    facet: 'language', breakdown: 'genre', query: '', scope: 'all', fullTextOnly: false,
    rowValues, colValues, statsResult: syntheticStats(rowValues, colValues), rowAxis, colAxis,
  });
  // 108,362 next to an exact cell is the trap this omission exists to close.
  assert.ok(structured.rows.every((r) => !('total' in r)), 'no un-narrowed total beside exact cells');
  assert.ok(structured.rows.every((r) => r.cells.length === 2), 'the grid itself is unchanged');
  assert.match(text, /rows \("language"\) also appear in `filters`/);
  assert.match(text, /CELLS below\s+are unaffected/);
});

test('an unfiltered axis keeps its per-row totals', () => {
  const rowAxis = buildAxisMeta('language', 2, { values: rowValues, distinct_values: 2, others_count: 0 });
  const { structured } = buildFacetBreakdownResponse({
    facet: 'language', breakdown: 'genre', query: '', scope: 'all', fullTextOnly: false,
    rowValues, colValues, statsResult: syntheticStats(rowValues, colValues), rowAxis,
  });
  assert.equal(structured.rows[0].total, 108362);
});

test('buildFacetBreakdownResponse: carries row_axis/col_axis and renders a truncation note', () => {
  const statsResult = syntheticStats(rowValues, colValues);
  const rowAxis = buildAxisMeta('language', 2, { values: rowValues, distinct_values: 40, others_count: 9000 });
  const colAxis = buildAxisMeta('genre', 2, { values: colValues, distinct_values: 2, others_count: 0 });
  const { structured, text } = buildFacetBreakdownResponse({
    facet: 'language', breakdown: 'genre', query: 'Basel', scope: 'all', fullTextOnly: false,
    rowValues, colValues, statsResult, rowAxis, colAxis,
  });
  assert.equal(structured.row_axis.truncated, true);
  assert.equal(structured.row_axis.distinct_values, 40);
  assert.equal(structured.col_axis.truncated, false);
  assert.match(text, /Axes truncated/);
  assert.match(text, /top 2 of 40 "language" values/);
  // The complete (non-truncated) column axis must NOT be named in the note.
  assert.doesNotMatch(text, /"genre" values/);
});

test('buildFacetBreakdownResponse: axis metadata is populated even without an explicit rowAxis/colAxis', () => {
  const statsResult = syntheticStats(rowValues, colValues);
  const { structured, text } = buildFacetBreakdownResponse({
    facet: 'language', breakdown: 'genre', query: 'Basel', scope: 'all', fullTextOnly: false,
    rowValues, colValues, statsResult, // no rowAxis/colAxis → fallback path
  });
  assert.equal(structured.row_axis.dimension, 'language');
  assert.equal(structured.row_axis.returned, 2);
  assert.equal(structured.row_axis.truncated, false);
  assert.doesNotMatch(text, /Axes truncated/, 'no truncation note when neither axis is capped');
});

// ── Handler-level: unusable axis buckets are dropped before the grid ─────────
// Registers the real tool against a fake server and drives its handler with a
// stubbed global fetch (pattern from clients.test.js): the row-axis discovery
// returns one good bucket and one empty-label bucket, and the handler must
// exclude the empty one from the stats grid (every cell keeps BOTH axis
// clauses) and say so in a warning. Cannot happen on the current backend
// (probed 2026-07-10) — this pins the guard for a future index anomaly.

test('facet_breakdown handler: drops an empty-label axis bucket, warns, and keeps two clauses per cell', async () => {
  const { registerFacetBreakdownTool } = await import('../src/tools/facet_breakdown.js');
  const { clearGraphqlCache } = await import('../src/graphql/client.js');

  let handler;
  registerFacetBreakdownTool({ registerTool: (_name, _cfg, h) => { handler = h; } });

  const facetPayload = (dim) => ({
    facetFiltered: {
      count: 2, nbTotal: 10, othersCount: 0,
      values: dim === 'language'
        ? [
            { __typename: 'FacetValueString', strVal: 'strings:Deutsch', count: 7 },
            { __typename: 'FacetValueString', strVal: 'strings:', count: 3 }, // empty label → value ''
          ]
        : [
            { __typename: 'FacetValueString', strVal: 'strings:Nachruf', count: 4 },
            { __typename: 'FacetValueString', strVal: 'strings:Hochschulschrift', count: 2 },
          ],
    },
  });

  const statsBodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes('facetFiltered')) {
      const dim = body.variables.facet.term.include?.[0];
      return { ok: true, json: async () => ({ data: facetPayload(dim) }) };
    }
    statsBodies.push(body);
    // Echo a complete grid for exactly the cells the handler asked for.
    const statsResult = body.variables.queryFilters.map((qf) => ({
      name: qf.name, countResult: { resultCount: 1 },
    }));
    return { ok: true, json: async () => ({ data: { stats: { statsResult } } }) };
  };

  try {
    const res = await handler(
      { facet: 'language', breakdown: 'genre', query: '', scope: 'all', full_text_only: false, size: 10, breakdown_size: 10 },
      { mcpReq: {} },
    );
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    const s = res.structuredContent;
    // The empty-label bucket is gone from the grid and the axis meta matches.
    assert.deepEqual(s.rows.map((r) => r.value), ['Deutsch']);
    assert.equal(s.rows[0].cells.length, 2);
    assert.equal(s.row_axis.returned, 1);
    assert.ok(
      (s.warnings || []).some((w) => /Dropped 1 "language" axis value/.test(w)),
      `expected a dropped-bucket warning, got: ${JSON.stringify(s.warnings)}`,
    );
    // The stats request itself must carry two clauses in every cell filter.
    assert.equal(statsBodies.length, 1);
    for (const qf of statsBodies[0].variables.queryFilters) {
      assert.equal(qf.inFilter.length, 2, `cell ${qf.name} must AND both axis clauses`);
    }
  } finally {
    globalThis.fetch = realFetch;
    clearGraphqlCache();
  }
});

// ── Handler-level: an empty axis under a pinned-vocabulary filter ────────────
// A renamed `availability`/`object_type` value narrows the population to zero,
// which reaches this tool as an axis with no buckets. The bare "broaden the
// query" advice sends the model the wrong way, so the stale-vocabulary hint
// (the same one sgbr_search and sgbr_facet_values return as a warning) has to
// ride on the error. The control case pins that it does NOT fire otherwise.

async function emptyAxisError(args) {
  const { registerFacetBreakdownTool } = await import('../src/tools/facet_breakdown.js');
  const { clearGraphqlCache } = await import('../src/graphql/client.js');

  let handler;
  registerFacetBreakdownTool({ registerTool: (_name, _cfg, h) => { handler = h; } });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { facetFiltered: { count: 0, nbTotal: 0, othersCount: 0, values: [] } } }),
  });
  try {
    return await handler(
      { facet: 'language', breakdown: 'genre', query: '', scope: 'all', full_text_only: false, size: 10, breakdown_size: 10, ...args },
      { mcpReq: {} },
    );
  } finally {
    globalThis.fetch = realFetch;
    clearGraphqlCache();
  }
}

test('facet_breakdown handler: an empty axis under a pinned-vocabulary filter names the stale value as the likely cause', async () => {
  const res = await emptyAxisError({ filters: { availability: ['Volltext'] } });
  assert.equal(res.isError, true);
  const text = res.content?.[0]?.text || '';
  assert.match(text, /No values for dimension "language"/);
  assert.match(text, /narrowing by availability/);
  assert.match(text, /sgbr_facet_values/, 'must point at the tool that re-reads the live values');
});

test('facet_breakdown handler: an empty axis without a vocabulary filter keeps the plain advice', async () => {
  const res = await emptyAxisError({ filters: { library: ['Nirgendwo'] } });
  assert.equal(res.isError, true);
  const text = res.content?.[0]?.text || '';
  assert.match(text, /Try a broader query or fewer filters/);
  assert.doesNotMatch(text, /occasionally renames/);
});

// fetchStatsCells: a narrowed grid is trusted only once two stats calls agree.
const crosstab = captureHandler(registerFacetBreakdownTool);
const LANGS = [['Deutsch', 60], ['Französisch', 40]];
const GENRE_ROWS = [['Nachruf', 30], ['Hochschulschrift', 20]];
const CROSSTAB_ARGS = {
  query: '', scope: 'all', full_text_only: false,
  facet: 'language', breakdown: 'genre', size: 2, breakdown_size: 2,
};

// Answers each Stats call from `grids` in turn (the last one repeats), naming
// cells as the request did, whatever order the request listed them in.
function runCrosstab(args, grids, { rows = LANGS, cols = GENRE_ROWS, keepCache = false } = {}) {
  const statsVars = [];
  const stub = installFetchStub(makeRouter({
    graphql: {
      FacetFilter: (vars) => ({
        facetFiltered: vars.facet.term.field === FACET_DIMENSIONS.language.field
          && vars.facet.term.include?.[0] === FACET_DIMENSIONS.language.include[0]
          ? facetPayload('language', rows) : facetPayload('genre', cols),
      }),
      Stats: (vars) => {
        const grid = grids[Math.min(statsVars.length, grids.length - 1)];
        statsVars.push(vars);
        return { stats: { statsResult: vars.queryFilters.map(({ name }) => ({ name, countResult: { resultCount: grid[name] } })) } };
      },
    },
  }));
  return crosstab(args).finally(() => { stub.restore(); if (!keepCache) clearGraphqlCache(); })
    .then((res) => ({ res, statsCalls: statsVars.length, statsVars }));
}
const GOOD = { '0:0': 11, '0:1': 12, '1:0': 21, '1:1': 22 };
const SHUFFLED = { '0:0': 21, '0:1': 12, '1:0': 11, '1:1': 22 };
const cellsOf = (res) => res.structuredContent.rows.map((r) => r.cells.map((c) => c.count));

test('crosstab: both axes filtered, an all-zero grid names a pinned vocabulary as the likely cause', async () => {
  const args = {
    ...CROSSTAB_ARGS, facet: 'availability', breakdown: 'language',
    filters: { availability: ['Volltext'], language: ['Deutsch'] },
  };
  const { res } = await runCrosstab(args, [{ '0:0': 0 }]);
  assert.notEqual(res.isError, true);
  assert.match(res.content[0].text, /narrowing by availability/);
  const { res: found } = await runCrosstab(args, [{ '0:0': 5 }]);
  assert.doesNotMatch(found.content[0].text, /narrowing by availability/);
});

test('crosstab: an un-narrowed grid needs one stats call', async () => {
  const { res, statsCalls } = await runCrosstab(CROSSTAB_ARGS, [GOOD]);
  assert.ok(statsCalls <= 1, `at most one stats call (made ${statsCalls})`);
  assert.deepEqual(cellsOf(res), [[11, 12], [21, 22]]);
});

test('crosstab: a narrowed grid is checked against a second call', async () => {
  const { res, statsCalls } = await runCrosstab({ ...CROSSTAB_ARGS, year_from: 1850 }, [GOOD]);
  assert.equal(statsCalls, 2, 'two calls: the fewest that can corroborate, and all an agreeing pair needs');
  assert.deepEqual(cellsOf(res), [[11, 12], [21, 22]]);
});

test('crosstab: a mislabelled answer is outvoted by two that agree', async () => {
  const { res, statsCalls } = await runCrosstab({ ...CROSSTAB_ARGS, year_from: 1850 }, [SHUFFLED, GOOD]);
  assert.ok(statsCalls <= 3, `at most three stats calls (made ${statsCalls})`);
  assert.deepEqual(cellsOf(res), [[11, 12], [21, 22]]);
});

// A stats stub whose every position answers with the count of the cell listed
// after it — a mislabel that follows submission position, identical under any
// rotation or reflection of the cell order.
function shiftedStats(rows, cols, truth) {
  const calls = [];
  const stub = installFetchStub(makeRouter({
    graphql: {
      FacetFilter: (vars) => ({
        facetFiltered: vars.facet.term.include?.[0] === FACET_DIMENSIONS.language.include[0]
          ? facetPayload('language', rows) : facetPayload('genre', cols),
      }),
      Stats: ({ queryFilters: q }) => {
        calls.push(q.length);
        return { stats: { statsResult: q.map(({ name }, p) => ({ name, countResult: { resultCount: truth[q[(p + 1) % q.length].name] } })) } };
      },
    },
  }));
  return { calls, restore: () => { stub.restore(); clearGraphqlCache(); } };
}

test('crosstab: a narrowed grid of up to three cells is counted one cell per call', async () => {
  const s = shiftedStats([['Deutsch', 60], ['Französisch', 40], ['Latein', 20]], [['Nachruf', 30]],
    { '0:0': 10, '1:0': 20, '2:0': 30 });
  try {
    const res = await crosstab({ ...CROSSTAB_ARGS, size: 3, breakdown_size: 1, year_from: 1850 });
    assert.deepEqual(cellsOf(res), [[10], [20], [30]], 'a one-cell call has no other name to give its count');
    assert.ok(s.calls.every((n) => n === 1), `cells per call: ${s.calls}`);
  } finally { s.restore(); }
});

test('crosstab: a larger grid mislabelled by submission position is refused, not agreed on', async () => {
  const s = shiftedStats(LANGS, GENRE_ROWS, GOOD);
  try {
    const res = await crosstab({ ...CROSSTAB_ARGS, year_from: 1850 });
    assert.equal(res.isError, true, `a shifted grid must not pass as exact: ${JSON.stringify(res.structuredContent?.rows)}`);
  } finally { s.restore(); }
});

test('crosstab: grids that never agree are an error, not a guess', async () => {
  const flip = { '0:0': 12, '0:1': 11, '1:0': 21, '1:1': 22 };
  const other = { '0:0': 11, '0:1': 21, '1:0': 12, '1:1': 22 };
  const { res, statsCalls } = await runCrosstab({ ...CROSSTAB_ARGS, year_from: 1850 }, [GOOD, SHUFFLED, flip, other]);
  assert.ok(statsCalls <= 4, `at most four stats calls (made ${statsCalls})`);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no two grids that agree/);
});

test('crosstab: a retry after a refused grid reaches the backend again', async () => {
  const flip = { '0:0': 12, '0:1': 11, '1:0': 21, '1:1': 22 };
  const other = { '0:0': 11, '0:1': 21, '1:0': 12, '1:1': 22 };
  const args = { ...CROSSTAB_ARGS, year_from: 1850 };
  const grids = [SHUFFLED, flip, other, { '0:0': 1, '0:1': 2, '1:0': 3, '1:1': 4 }];
  try {
    const { res: first } = await runCrosstab(args, grids, { keepCache: true });
    const { res: second, statsCalls } = await runCrosstab(args, [GOOD], { keepCache: true });
    assert.equal(first.isError, true);
    assert.match(first.content[0].text, /no two grids that agree/);
    assert.notEqual(second.isError, true);
    assert.ok(statsCalls >= 2, `the retry made ${statsCalls} stats calls`);
  } finally { clearGraphqlCache(); }
});

test('crosstab: an empty-label bucket does not mark a complete axis truncated', async () => {
  const { res } = await runCrosstab(
    { ...CROSSTAB_ARGS, breakdown: 'content_flags', size: 2, breakdown_size: 25 },
    [{ '0:0': 1, '0:1': 2, '1:0': 3, '1:1': 4 }],
    { cols: [['A', 5], ['', 3], ['B', 2]] },
  );
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent.col_axis.truncated, false);
  assert.doesNotMatch(res.content[0].text, /Raise/);
});

test('crosstab: a filtered axis lists the filter\'s own values, not discovered ones', async () => {
  const { res } = await runCrosstab(
    { ...CROSSTAB_ARGS, size: 5, filters: { language: ['Rumänisch'] } }, [GOOD],
  );
  assert.notEqual(res.isError, true);
  assert.deepEqual(res.structuredContent.rows.map((r) => r.value), ['Rumänisch']);
  const axis = res.structuredContent.row_axis;
  assert.equal(axis.truncated, false);
  assert.equal(axis.same_dimension_filter, true);
});

test('crosstab: full_text_only on an availability axis is a clash that lists discovered values', async () => {
  const { res } = await runCrosstab(
    { ...CROSSTAB_ARGS, facet: 'availability', breakdown: 'language', full_text_only: true },
    [GOOD],
    { rows: [['Digitalisat (Volltext)', 60], ['kein Digitalisat', 40]], cols: LANGS },
  );
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const sc = res.structuredContent;
  assert.equal(sc.row_axis.same_dimension_filter, true);
  assert.ok(sc.rows.every((r) => !('total' in r)), 'per-row totals are omitted');
  const text = res.content[0].text;
  assert.match(text, /both filtered and aggregated/);
  assert.doesNotMatch(text, /lists your filter's own values/);
});

test('crosstab: mixed clash describes each axis by its own cause', async () => {
  const { res } = await runCrosstab(
    { ...CROSSTAB_ARGS, facet: 'availability', breakdown: 'language', full_text_only: true, filters: { language: ['Rumänisch'] } },
    [GOOD],
    { rows: [['Digitalisat (Volltext)', 60], ['kein Digitalisat', 40]], cols: LANGS },
  );
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.equal(res.structuredContent.row_axis.same_dimension_filter, true);
  assert.equal(res.structuredContent.col_axis.same_dimension_filter, true);
  const text = res.content[0].text;
  assert.match(text, /rows \("availability"\) are narrowed by `full_text_only` and list values discovered as if it were false/);
  assert.match(text, /columns \("language"\) also appear in `filters` and list your filter's own values/);
});

test('crosstab: a filtered author axis prices cells with the same clause the filter compiles to', async () => {
  const author = 'Goethe, Johann Wolfgang von';
  const { res, statsVars } = await runCrosstab(
    { ...CROSSTAB_ARGS, facet: 'author', filters: { author: [author] } }, [GOOD],
  );
  assert.notEqual(res.isError, true);
  assert.deepEqual(res.structuredContent.rows.map((r) => r.value), [author]);
  const [expected] = buildDimensionFilters({ filters: { author: [author] } });
  for (const cell of statsVars[0].queryFilters) assert.deepEqual(cell.inFilter[0], expected);
});

test('crosstab: the cell limit counts a filtered axis by its filter values, not its size', async () => {
  const filters = { language: ['Rumänisch'] };
  const { res } = await runCrosstab({ ...CROSSTAB_ARGS, size: 25, breakdown_size: 25, filters }, [GOOD]);
  assert.notEqual(res.isError, true, 'a 1×25 grid is within the limit');
  const { res: over } = await runCrosstab({ ...CROSSTAB_ARGS, size: 25, breakdown_size: 25 }, [GOOD]);
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /25×25 = 625 cells/);
});
