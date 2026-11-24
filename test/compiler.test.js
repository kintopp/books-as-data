// Offline unit tests for the GraphQL variable compiler. These lock the probed
// invariants (scope→searchFields, always-send-view, filter shape, pagination
// math) so a refactor can't silently change what we send the backend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchVariables, buildFacetVariables, buildAutocompleteVariables, buildStatsCrosstabVariables,
} from '../src/search/compiler.js';
import { VIEW, DEFAULT_SEARCH_FIELDS, SCOPE_NAMES } from '../src/config.js';

const hasFlagsAll = (filters) =>
  filters.some((f) => f.boolTerm?.field === 'flags' && f.boolTerm?.values?.includes('all'));
const fullTextFilter = (filters) =>
  filters.find((f) => f.boolTerm?.values?.includes('[availableData].Volltext'));

test('buildSearchVariables: defaults send view, all fields, flags filter, page 1', () => {
  const v = buildSearchVariables({});
  assert.equal(v.query, '');
  assert.equal(v.view, VIEW);
  assert.deepEqual(v.searchFields, DEFAULT_SEARCH_FIELDS.map((field) => ({ field })));
  assert.ok(hasFlagsAll(v.filters), 'must always send the flags:all filter');
  assert.equal(fullTextFilter(v.filters), undefined, 'no full-text filter by default');
  assert.equal(v.size, 10);
  assert.equal(v.first, 0);
  assert.deepEqual(v.sort, [{ field: '_score', order: 'desc' }]);
});

test('the query is trimmed for search, facet and cross-tab variables', () => {
  assert.equal(buildSearchVariables({ query: ' Cholera* ' }).query, 'Cholera*');
  assert.equal(buildFacetVariables({ query: '\tCholera*\n', facet: 'language', size: 5 }).query, 'Cholera*');
  const stats = buildStatsCrosstabVariables({
    query: ' Cholera* ', facet: 'language', breakdown: 'genre',
    rowValues: [{ value: 'Deutsch' }], colValues: [{ value: 'Nachruf' }],
  });
  assert.equal(stats.query, 'Cholera*');
  // Inner spacing is forwarded as written.
  assert.equal(buildSearchVariables({ query: 'Cholera* | Karte*' }).query, 'Cholera* | Karte*');
  // Autocomplete keeps a trailing space: it may be a word boundary there.
  assert.equal(buildAutocompleteVariables({ query: 'Basel ' }).query, 'Basel ');
});

test('buildSearchVariables: scope maps to a single search field', () => {
  assert.deepEqual(buildSearchVariables({ scope: 'title' }).searchFields, [{ field: 'search.title' }]);
  assert.deepEqual(buildSearchVariables({ scope: 'author' }).searchFields, [{ field: 'search.author' }]);
});

// Internal defensive contract — unreachable through any tool, whose `scope` is
// `z.enum(SCOPE_NAMES)`. A new caller with a bad scope must fail loudly, not
// quietly search other fields than it asked for.
test('buildSearchVariables: throws on an unknown scope', () => {
  assert.throws(() => buildSearchVariables({ scope: 'nonsense' }), /unknown scope/);
});

test('buildSearchVariables: pagination computes first = (page-1)*size', () => {
  const v = buildSearchVariables({ page: 3, pageSize: 20 });
  assert.equal(v.size, 20);
  assert.equal(v.first, 40);
});

test('buildSearchVariables: fullTextOnly prepends the Volltext filter', () => {
  const v = buildSearchVariables({ fullTextOnly: true });
  assert.ok(fullTextFilter(v.filters), 'expected the full-text filter');
  assert.equal(v.filters[0].boolTerm.field, '[facet.strings].string.keyword');
  assert.ok(hasFlagsAll(v.filters), 'flags:all still present');
});

const dimFilter = (filters, dimension) =>
  filters.find((f) => (f.boolTerm?.values || []).some((v) => v.startsWith(`[${dimension}].`)));
const rangeFilter = (filters) => filters.find((f) => f.boolTerm?.field === '[facet.daterange].daterange');
const agentFilter = (filters) => filters.find((f) => f.boolTerm?.field === '[facet.agents].agent.label.keyword');

// A friendly object_type key expands to EVERY stored spelling the backend has used,
// OR-ed into one clause, so the same request narrows correctly whichever vocabulary
// is being served (one release renamed Falttafel → Einzelseite). Asserting the whole
// set — not just "contains the current one" — is what stops a well-meaning cleanup
// from dropping the alias that keeps the other live backend working.
test('buildSearchVariables: filters.object_type=[foldout] ORs every known spelling', () => {
  const v = buildSearchVariables({ filters: { object_type: ['foldout'] } });
  const f = dimFilter(v.filters, 'sgbrObjectType');
  assert.ok(f, 'expected an sgbrObjectType filter');
  assert.deepEqual(
    f.boolTerm.values,
    ['[sgbrObjectType].Falttafel', '[sgbrObjectType].Einzelseite'],
    'foldout maps to both the old and the current stored value',
  );
  assert.equal(f.boolTerm.field, '[facet.strings].string.keyword');
  assert.equal(f.boolTerm.and, false, 'string-dimension filters OR across values');
  assert.ok(hasFlagsAll(v.filters), 'flags:all still present');
});

test('buildSearchVariables: full_text_only ORs every availability spelling', () => {
  const f = dimFilter(buildSearchVariables({ fullTextOnly: true }).filters, 'availableData');
  assert.ok(f, 'expected an availableData filter');
  assert.deepEqual(f.boolTerm.values, ['[availableData].Volltext', '[availableData].Digitalisat (Volltext)']);
  assert.equal(f.boolTerm.and, false);
});

test('buildSearchVariables: a concept dimension filters on its own field with the [dim].value encoding', () => {
  const v = buildSearchVariables({ filters: { subject_heading: ['Schweiz'] } });
  const f = dimFilter(v.filters, 'topic');
  assert.ok(f, 'expected a concept filter');
  assert.deepEqual(f.boolTerm.values, ['[topic].Schweiz']);
  assert.equal(f.boolTerm.field, '[facet.concepts].concept.label.keyword');
  assert.equal(f.boolTerm.and, false);
});

test('buildSearchVariables: sort resolves through the allow-list, relevance by default', () => {
  assert.deepEqual(buildSearchVariables({}).sort, [{ field: '_score', order: 'desc' }]);
  assert.deepEqual(buildSearchVariables({ sort: 'year_asc' }).sort, [{ field: 'mapping.date.gte', order: 'asc' }]);
  assert.deepEqual(buildSearchVariables({ sort: 'title_desc' }).sort, [{ field: 'sort.title', order: 'desc' }]);
  // Unreachable through the tool (`z.enum(SORT_NAMES)`); a new caller with a bad
  // name must fail loudly rather than silently get relevance order.
  assert.throws(() => buildSearchVariables({ sort: 'nonsense' }), /unknown sort/);
});

test('buildSearchVariables: a string dimension ORs multiple values in one clause', () => {
  const f = dimFilter(buildSearchVariables({ filters: { library: ['Bern, UB Münstergasse', 'Luzern, ZHB'] } }).filters, 'library');
  assert.deepEqual(f.boolTerm.values, ['[library].Bern, UB Münstergasse', '[library].Luzern, ZHB']);
  assert.equal(f.boolTerm.and, false);
});

// Internal defensive contract — unreachable through any tool: `filtersSchema` is
// `.strict()` (bogus keys rejected) with `.min(1)` arrays (empty ones rejected).
// Pins that a stray key becomes NO clause rather than a malformed one, since a
// filter the backend cannot parse would silently narrow to nothing.
test('buildSearchVariables: unknown filter keys and empty arrays are skipped', () => {
  const { filters } = buildSearchVariables({ filters: { bogus: ['x'], library: [] } });
  assert.equal(dimFilter(filters, 'library'), undefined);
  assert.equal(filters.some((f) => (f.boolTerm?.values || []).some((x) => /bogus/.test(x))), false);
});

test('buildSearchVariables: author filter uses the agent field with plain labels (OR)', () => {
  const f = agentFilter(buildSearchVariables({ filters: { author: ['Krünitz, Johann Georg (1728-1796)'] } }).filters);
  assert.ok(f, 'expected an agent-field filter');
  assert.deepEqual(f.boolTerm.values, ['Krünitz, Johann Georg (1728-1796)']);
  assert.equal(f.boolTerm.and, false);
});

test('buildSearchVariables: year_from/year_to add an RFC3339 rangeValues clause', () => {
  const f = rangeFilter(buildSearchVariables({ year_from: 1800, year_to: 1850 }).filters);
  assert.ok(f, 'expected a daterange filter');
  assert.equal(f.boolTerm.and, true);
  assert.deepEqual(f.boolTerm.rangeValues, [{ startTime: '1800-01-01T00:00:00Z', endTime: '1850-12-31T23:59:59Z' }]);
  // Without the family selector the range matches ANY daterange family, so page
  // counts and OCR scores leak into the year filter.
  assert.deepEqual(f.boolTerm.values, ['[daterange].undefined']);
});

test('buildSearchVariables: an open-ended year range uses sentinel bounds', () => {
  const from = rangeFilter(buildSearchVariables({ year_from: 1800 }).filters);
  assert.match(from.boolTerm.rangeValues[0].startTime, /^1800-/);
  assert.match(from.boolTerm.rangeValues[0].endTime, /^9999-/);
  const to = rangeFilter(buildSearchVariables({ year_to: 1850 }).filters);
  assert.match(to.boolTerm.rangeValues[0].startTime, /^0000-/);
});

test('buildSearchVariables: page-count and OCR-quality bounds each add a family-selected range', () => {
  const ranges = buildSearchVariables({ year_from: 1850, pages_min: 100, pages_max: 300, ocr_quality_min: 95 })
    .filters.filter((f) => f.boolTerm?.field === '[facet.daterange].daterange');
  const byFamily = Object.fromEntries(ranges.map((f) => [f.boolTerm.values[0], f.boolTerm.rangeValues[0]]));
  assert.deepEqual(Object.keys(byFamily).sort(), [
    '[daterange].undefined', '[sgbrMediaCountAsDate].undefined', '[sgbrOcrQualityAsDate].undefined',
  ]);
  assert.deepEqual(byFamily['[sgbrMediaCountAsDate].undefined'],
    { startTime: '0100-01-01T00:00:00Z', endTime: '0300-12-31T23:59:59Z' });
  assert.deepEqual(byFamily['[sgbrOcrQualityAsDate].undefined'],
    { startTime: '0095-01-01T00:00:00Z', endTime: '9999-12-31T23:59:59Z' });
  // Unset bounds add nothing.
  assert.equal(buildSearchVariables({}).filters.some((f) => f.boolTerm?.rangeValues), false);
});

test('buildSearchVariables: call_number scope maps to search.callNumber', () => {
  assert.deepEqual(buildSearchVariables({ scope: 'call_number' }).searchFields, [{ field: 'search.callNumber' }]);
});

test('buildSearchVariables: no dimension or year filters by default', () => {
  const { filters } = buildSearchVariables({});
  assert.equal(rangeFilter(filters), undefined);
  assert.equal(filters.some((f) => (f.boolTerm?.values || []).some((v) => v.startsWith('['))), false);
});

test('buildFacetVariables: throws on an unknown dimension', () => {
  assert.throws(() => buildFacetVariables({ facet: 'bogus' }), /unknown facet dimension/);
});

test('buildFacetVariables: string dimension carries field + include + size', () => {
  const v = buildFacetVariables({ facet: 'library', size: 30 });
  assert.equal(v.view, VIEW);
  assert.equal(v.facet.term.field, '[facet.strings].string.keyword');
  assert.deepEqual(v.facet.term.include, ['library']);
  assert.equal(v.facet.term.size, 30);
});

test('buildFacetVariables: year dimension omits include', () => {
  const v = buildFacetVariables({ facet: 'year', size: 5 });
  assert.equal(v.facet.term.field, '[facet.daterange].daterange');
  assert.equal('include' in v.facet.term, false);
});

test('buildFacetVariables: object_type / foldout_type map to their include selectors', () => {
  assert.deepEqual(buildFacetVariables({ facet: 'object_type', size: 4 }).facet.term.include, ['sgbrObjectType']);
  assert.deepEqual(buildFacetVariables({ facet: 'foldout_type', size: 16 }).facet.term.include, ['foldoutTypeNew']);
});

test('buildFacetVariables: applies dimension filters (cross-tab) alongside the facet term', () => {
  const v = buildFacetVariables({ facet: 'language', size: 20, filters: { library: ['Bern, UB Münstergasse'] } });
  assert.deepEqual(v.facet.term.include, ['language'], 'still facets the requested dimension');
  const f = dimFilter(v.filters, 'library');
  assert.ok(f, 'the library filter clause is present in the facet population');
  assert.deepEqual(f.boolTerm.values, ['[library].Bern, UB Münstergasse']);
  assert.ok(hasFlagsAll(v.filters), 'base flags:all still present');
});

test('buildFacetVariables: applies a year range to the facet population', () => {
  const v = buildFacetVariables({ facet: 'language', size: 20, year_from: 1800, year_to: 1849 });
  const r = rangeFilter(v.filters);
  assert.ok(r, 'expected a daterange clause');
  assert.deepEqual(r.boolTerm.rangeValues, [{ startTime: '1800-01-01T00:00:00Z', endTime: '1849-12-31T23:59:59Z' }]);
});

test('buildFacetVariables: no dimension/year filters by default (parity with search)', () => {
  const v = buildFacetVariables({ facet: 'language', size: 20 });
  assert.equal(rangeFilter(v.filters), undefined);
  assert.equal(v.filters.some((f) => (f.boolTerm?.values || []).some((x) => x.startsWith('['))), false);
});

test('buildAutocompleteVariables: scope=all requests every group and sends no view', () => {
  const v = buildAutocompleteVariables({ query: 'Bur' });
  assert.equal('view' in v, false, 'autocomplete takes no view');
  assert.deepEqual(v.searchNamedFields.map((n) => n.name), ['title', 'author', 'subject']);
});

test('buildAutocompleteVariables: single scope maps name → search field', () => {
  const v = buildAutocompleteVariables({ query: 'Bur', scope: 'title' });
  assert.deepEqual(v.searchNamedFields, [{ name: 'title', searchFields: [{ field: 'search.title' }] }]);
});

test('buildAutocompleteVariables: fullTextOnly prepends the Volltext filter', () => {
  const v = buildAutocompleteVariables({ query: 'Bur', fullTextOnly: true });
  assert.ok(fullTextFilter(v.filters));
  assert.ok(hasFlagsAll(v.filters));
});

// buildStatsCrosstabVariables — the `stats` batched cross-tab grid assembler.
// Full grid-shape assertions live in test/facet_breakdown.test.js alongside the
// shaper; these lock the compiler-layer invariants (no `view`, base filters vs.
// per-cell inFilter, unknown-dimension guards) at the same altitude as this file's
// other builders.
const crosstabRows = [{ value: 'Deutsch', count: 1 }, { value: 'Französisch', count: 2 }];
const crosstabCols = [{ value: 'Nachruf', count: 3 }];

test('buildStatsCrosstabVariables: throws on an unknown facet dimension', () => {
  assert.throws(
    () => buildStatsCrosstabVariables({ facet: 'bogus', breakdown: 'genre', rowValues: crosstabRows, colValues: crosstabCols }),
    /unknown facet dimension/,
  );
});

test('buildStatsCrosstabVariables: throws on an unknown breakdown dimension', () => {
  assert.throws(
    () => buildStatsCrosstabVariables({ facet: 'language', breakdown: 'bogus', rowValues: crosstabRows, colValues: crosstabCols }),
    /unknown breakdown dimension/,
  );
});

test('buildStatsCrosstabVariables: sends no `view` (stats rejects it)', () => {
  const v = buildStatsCrosstabVariables({ facet: 'language', breakdown: 'genre', rowValues: crosstabRows, colValues: crosstabCols });
  assert.equal('view' in v, false);
});

test('buildStatsCrosstabVariables: base filters (flags:all) ride in `filters`, not per-cell', () => {
  const v = buildStatsCrosstabVariables({ facet: 'language', breakdown: 'genre', rowValues: crosstabRows, colValues: crosstabCols });
  assert.ok(hasFlagsAll(v.filters));
  assert.equal(v.queryFilters.length, crosstabRows.length * crosstabCols.length);
  for (const cell of v.queryFilters) {
    assert.equal(cell.inFilter.some((f) => f.boolTerm?.field === 'flags'), false, 'flags:all belongs in filters, not inFilter');
  }
});

test('buildStatsCrosstabVariables: each cell inFilter AND-combines the row + column value', () => {
  const v = buildStatsCrosstabVariables({ facet: 'language', breakdown: 'genre', rowValues: crosstabRows, colValues: crosstabCols });
  const cell = v.queryFilters.find((c) => c.name === '0:0');
  const values = cell.inFilter.flatMap((f) => f.boolTerm.values);
  assert.deepEqual(values.sort(), ['[genre].Nachruf', '[language].Deutsch']);
});

test('buildStatsCrosstabVariables: throws when an axis value compiles to fewer than two clauses', () => {
  // buildDimensionFilters drops falsy values, so a null/empty axis bucket would
  // yield a one-sided (or empty) cell filter that counts the wrong population
  // as an exact-looking number. The tool pre-filters such buckets; the compiler
  // must fail loudly if one ever gets through.
  for (const bad of [null, '']) {
    assert.throws(
      () => buildStatsCrosstabVariables({
        facet: 'language', breakdown: 'genre',
        rowValues: [{ value: bad, count: 3 }], colValues: crosstabCols,
      }),
      /instead of 2/,
      `expected a throw for axis value ${JSON.stringify(bad)}`,
    );
  }
});

// `exclude` shares dimensionFilter with `filters`, so the only thing to pin is
// the negation: the whole OR-ed clause gets `not`, and a positive clause on the
// same call stays positive.
test('exclude compiles to a negated clause on search and facet bases and in every cross-tab cell', () => {
  const s = buildSearchVariables({ filters: { language: ['Deutsch'] }, exclude: { object_type: ['foldout'] } });
  const neg = dimFilter(s.filters, 'sgbrObjectType');
  assert.equal(neg.boolTerm.not, true);
  assert.deepEqual(neg.boolTerm.values, ['[sgbrObjectType].Falttafel', '[sgbrObjectType].Einzelseite']);
  assert.equal(dimFilter(s.filters, 'language').boolTerm.not, undefined, 'the positive filter stays positive');

  const f = buildFacetVariables({ facet: 'language', size: 5, exclude: { library: ['UB Basel'] } });
  assert.equal(dimFilter(f.filters, 'library').boolTerm.not, true);

  const row = [{ value: 'Deutsch', count: 1 }];
  const c = buildStatsCrosstabVariables({
    facet: 'language', breakdown: 'library', rowValues: row, colValues: [{ value: 'UB Basel', count: 1 }],
    exclude: { genre: ['Roman'] },
  });
  // stats mislabels cells when a negated clause is shared, so it rides in each cell.
  assert.equal(dimFilter(c.filters, 'genre'), undefined, 'no negated clause in the shared filters');
  assert.equal(dimFilter(c.queryFilters[0].inFilter, 'genre').boolTerm.not, true, 'each cell carries the exclusion');
});

test('image_description scope maps to the AI description field', () => {
  assert.deepEqual(buildSearchVariables({ scope: 'image_description' }).searchFields, [{ field: 'mapping.temp.field1' }]);
});

// identifier is excluded: its scan-id/barcode fields are exact-match lookups, not text.
test('the default scope searches every field a narrower text scope does', () => {
  const defaults = new Set(buildSearchVariables({}).searchFields.map((f) => f.field));
  for (const scope of SCOPE_NAMES.filter((s) => s !== 'all' && s !== 'identifier')) {
    for (const { field } of buildSearchVariables({ scope }).searchFields) {
      assert.ok(defaults.has(field), `scope "${scope}" searches ${field}, which a bare query skips`);
    }
  }
});
