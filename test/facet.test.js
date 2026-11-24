// Offline unit tests for facet shaping — one assertion per FacetValue union
// member, plus the year dimension's chronological sort and count semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFacetResponse } from '../src/lib/facet.js';
import { buildFacetIntegrityWarnings } from '../src/lib/warnings.js';

function shape(value, name = 'library', facetExtra = {}) {
  const facet = { values: [value], count: 5, nbTotal: 100, othersCount: 3, ...facetExtra };
  return buildFacetResponse(facet, { name, query: 'x', scope: 'all', fullTextOnly: false });
}

test('FacetValueString strips the "strings:" prefix', () => {
  const { structured } = shape({ __typename: 'FacetValueString', strVal: 'strings:German', count: 7 });
  assert.deepEqual(structured.values[0], { value: 'German', count: 7 });
});

test('FacetValueInt passes the integer through', () => {
  const { structured } = shape({ __typename: 'FacetValueInt', intVal: 42, count: 2 });
  assert.deepEqual(structured.values[0], { value: 42, count: 2 });
});

test('FacetValueLabelIdentifier attaches the GND identifier', () => {
  const { structured } = shape({
    __typename: 'FacetValueLabelIdentifier', label: 'Burckhardt', count: 4, identifier: ['(DE-588)118516272'],
  }, 'author');
  assert.deepEqual(structured.values[0], { value: 'Burckhardt', count: 4, gnd_id: '(DE-588)118516272' });
});

test('FacetValueTimeRange extracts the leading year', () => {
  const { structured } = shape(
    { __typename: 'FacetValueTimeRange', startTime: '1850-01-01', count: 9 }, 'year',
  );
  assert.equal(structured.values[0].value, 1850);
});

test('unknown union member degrades to a null value with a count', () => {
  const { structured } = shape({ __typename: 'FacetValueMystery', count: 1 });
  assert.deepEqual(structured.values[0], { value: null, count: 1 });
});

test('string facet reports distinct/matching/others from the backend', () => {
  const { structured } = shape({ __typename: 'FacetValueString', strVal: 'strings:x', count: 1 });
  assert.equal(structured.distinct_values, 5);
  assert.equal(structured.matching_records, 100);
  assert.equal(structured.others_count, 3);
});

test('year facet sorts chronologically and derives distinct from buckets', () => {
  const facet = {
    values: [
      { __typename: 'FacetValueTimeRange', startTime: '1875-01-01', count: 2 },
      { __typename: 'FacetValueTimeRange', startTime: '1850-01-01', count: 5 },
      { __typename: 'FacetValueTimeRange', startTime: '1860-01-01', count: 3 },
    ],
    count: 999, nbTotal: 10, othersCount: 42,
  };
  const { structured } = buildFacetResponse(facet, { name: 'year', query: '', scope: 'all', fullTextOnly: false });
  assert.deepEqual(structured.values.map((v) => v.value), [1850, 1860, 1875]);
  assert.equal(structured.distinct_values, 3, 'distinct = bucket count, not backend count');
  assert.equal(structured.others_count, 0, 'year has no "others" bucket');
});

test('coverage_pct = matching_records / query_total when a total is provided', () => {
  const facet = { values: [{ __typename: 'FacetValueString', strVal: 'strings:x', count: 1 }], count: 5, nbTotal: 100, othersCount: 3 };
  const { structured, text } = buildFacetResponse(facet, { name: 'genre', query: 'x', scope: 'all', fullTextOnly: false, total: 400 });
  assert.equal(structured.matching_records, 100);
  assert.equal(structured.query_total, 400);
  assert.equal(structured.coverage_pct, 25);
  assert.match(text, /25% of 400 hits/);
});

// object_type indexes "no type" as an empty STRING, so nbTotal counts those
// records as covered and the dimension reports 100% while 40% of the corpus
// carries nothing. The empty bucket is absence, and coverage must say so.
test('an empty-string bucket counts as absent, not as coverage', () => {
  const facet = {
    values: [
      { __typename: 'FacetValueString', strVal: 'strings:', count: 40 },
      { __typename: 'FacetValueString', strVal: 'strings:Werk', count: 60 },
    ],
    count: 2, nbTotal: 100, othersCount: 0,
  };
  const { structured, text } = buildFacetResponse(facet, {
    name: 'object_type', query: '', scope: 'all', fullTextOnly: false, total: 100,
  });
  assert.equal(structured.absent_records, 40);
  assert.equal(structured.matching_records, 60, 'nbTotal minus the empty bucket');
  assert.equal(structured.coverage_pct, 60, 'not 100');
  assert.deepEqual(structured.values[0], { value: '', count: 40 }, 'the bucket itself is still reported');
  assert.match(text, /\(no value recorded\)/, 'a blank label would print as nothing at all');
  assert.match(text, /unreachable by any filter/);
});

// `nbTotal` counts value OCCURRENCES for a multi-valued dimension, so taking a
// record count off it mixes units — and could pull it under query_total, which
// is the one condition the over-sum warning fires on.
test('a multi-valued dimension reports absent_records without subtracting them', () => {
  const facet = {
    values: [
      { __typename: 'FacetValueString', strVal: 'strings:', count: 10 },
      { __typename: 'FacetValueString', strVal: 'strings:IMAGE_ON_PAGE', count: 90 },
    ],
    count: 2, nbTotal: 150, othersCount: 0,
  };
  const { structured } = buildFacetResponse(facet, {
    name: 'content_flags', query: '', scope: 'all', fullTextOnly: false, total: 100,
  });
  assert.equal(structured.absent_records, 10, 'still reported');
  assert.equal(structured.matching_records, 150, 'raw nbTotal — occurrences, not records');
  assert.equal(structured.coverage_pct, null);
  assert.ok(structured.matching_records > structured.query_total,
    'the over-sum the integrity warning keys on must survive');
});

// facet_breakdown drops EVERY no-value bucket; counting only the first would
// leave matching_records inflated by the rest.
test('every no-value bucket counts toward absent_records, not just the first', () => {
  const facet = {
    values: [
      { __typename: 'FacetValueString', strVal: 'strings:', count: 30 },
      { __typename: 'FacetValueMystery', count: 10 },
      { __typename: 'FacetValueString', strVal: 'strings:Werk', count: 60 },
    ],
    count: 3, nbTotal: 100, othersCount: 0,
  };
  const { structured } = buildFacetResponse(facet, {
    name: 'object_type', query: '', scope: 'all', fullTextOnly: false, total: 100,
  });
  assert.equal(structured.absent_records, 40);
  assert.equal(structured.matching_records, 60);
});

test('absent_records is null when no empty bucket came back', () => {
  const facet = { values: [{ __typename: 'FacetValueString', strVal: 'strings:x', count: 1 }], count: 5, nbTotal: 100, othersCount: 3 };
  const { structured, text } = buildFacetResponse(facet, { name: 'genre', query: 'x', scope: 'all', fullTextOnly: false, total: 400 });
  assert.equal(structured.absent_records, null);
  assert.doesNotMatch(text, /EMPTY value/);
});

// The rounding that made defect 2 invisible at a glance: 3,566 of 3,575 authors
// displayed as "100%". A partial share must never render as a whole 100.
test('a partial coverage never rounds up to 100%', () => {
  const facet = { values: [{ __typename: 'FacetValueString', strVal: 'strings:x', count: 1 }], count: 5, nbTotal: 3566, othersCount: 0 };
  const { structured, text } = buildFacetResponse(facet, { name: 'genre', query: 'x', scope: 'all', fullTextOnly: false, total: 3575 });
  assert.equal(structured.coverage_pct, 99.7);
  assert.match(text, /99\.7% of 3,575 hits/);
});

test('full coverage still reports exactly 100%', () => {
  const facet = { values: [{ __typename: 'FacetValueString', strVal: 'strings:x', count: 1 }], count: 5, nbTotal: 400, othersCount: 0 };
  const { structured } = buildFacetResponse(facet, { name: 'genre', query: 'x', scope: 'all', fullTextOnly: false, total: 400 });
  assert.equal(structured.coverage_pct, 100);
});

test('coverage_pct is null when no query total is available', () => {
  const facet = { values: [{ __typename: 'FacetValueString', strVal: 'strings:x', count: 1 }], count: 5, nbTotal: 100, othersCount: 3 };
  const { structured } = buildFacetResponse(facet, { name: 'genre', query: 'x', scope: 'all', fullTextOnly: false });
  assert.equal(structured.coverage_pct, null);
  assert.equal(structured.query_total, null);
});

test('renders a text channel naming the facet', () => {
  const { text } = shape({ __typename: 'FacetValueString', strVal: 'strings:German', count: 7 });
  assert.match(text, /Facet "library"/);
});

test('echoes applied narrowing into structuredContent and the text channel', () => {
  const facet = { values: [{ __typename: 'FacetValueString', strVal: 'strings:German', count: 7 }], count: 5, nbTotal: 100, othersCount: 3 };
  const applied = { filters: { library: ['Bern, UB Münstergasse'] }, year_from: 1800, year_to: 1849 };
  const { structured, text } = buildFacetResponse(facet, { name: 'language', query: 'x', scope: 'all', fullTextOnly: false, total: 400, applied });
  assert.deepEqual(structured.applied_filters, applied);
  assert.match(text, /Narrowed by: library=Bern, UB Münstergasse; year 1800–1849/);
});

test('omits applied_filters when nothing was narrowed', () => {
  const { structured, text } = shape({ __typename: 'FacetValueString', strVal: 'strings:German', count: 7 });
  assert.equal('applied_filters' in structured, false);
  assert.doesNotMatch(text, /Narrowed by:/);
});

// ── same-dimension clash: filtered and faceted at once ───────────────────────
// RDV excludes a dimension's own filter from its own aggregation, so the buckets
// drop that one dimension's narrowing (not the query) while query_total keeps
// it — they count a wider population than the total. Suppressed like
// multi_valued rather than reported as a percentage of two different populations.

const clash = (name = 'library') => buildFacetResponse(
  { values: [{ __typename: 'FacetValueString', strVal: 'strings:Basel', count: 7 }], count: 5, nbTotal: 900, othersCount: 3 },
  {
    name,
    query: 'x',
    scope: 'all',
    fullTextOnly: false,
    total: 100,
    applied: { filters: { [name]: ['Basel, UB'] } },
  },
);

test('same-dimension filter nulls coverage_pct instead of reporting a false 100%', () => {
  const { structured } = clash();
  // matching (900) >= total (100) would otherwise hit coveragePercent's `100` branch —
  // the maximum trust signal on the one response that has earned none.
  assert.equal(structured.same_dimension_filter, true);
  assert.equal(structured.coverage_pct, null);
  assert.equal(structured.matching_records, 900, 'raw counts are still reported, as for multi_valued');
  assert.equal(structured.query_total, 100, 'the one number that stays correct');
});

test('same-dimension filter says so in the text channel', () => {
  assert.match(clash().text, /IGNORE this dimension's own filter/);
});

test('a filter on a DIFFERENT dimension leaves coverage reporting alone', () => {
  const { structured } = buildFacetResponse(
    { values: [{ __typename: 'FacetValueString', strVal: 'strings:Basel', count: 7 }], count: 5, nbTotal: 50, othersCount: 0 },
    {
      name: 'library',
      query: 'x',
      scope: 'all',
      fullTextOnly: false,
      total: 100,
      applied: { filters: { language: ['Latein'] } },
    },
  );
  assert.equal(structured.same_dimension_filter, false);
  assert.equal(structured.coverage_pct, 50);
});

test('integrity warnings defer to the same-dimension diagnosis', () => {
  // The over-sum is EXPECTED here and already explained precisely, so a second
  // warning blaming coverage_pct (which is null) would be stale advice.
  assert.deepEqual(
    buildFacetIntegrityWarnings({ facet: 'library' }, clash().structured),
    [],
  );
});

test('facet integrity warnings flag raw matching counts above query totals', () => {
  const warnings = buildFacetIntegrityWarnings({ facet: 'language' }, {
    matching_records: 40,
    query_total: 13,
    values: [],
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /matching_records \(40\) exceeds query_total \(13\)/);
});

test('facet integrity warnings stay quiet for reconciled non-year facets', () => {
  assert.deepEqual(buildFacetIntegrityWarnings({ facet: 'language', year_from: 1830, year_to: 1875 }, {
    matching_records: 13,
    query_total: 13,
    values: [{ value: 'Deutsch', count: 12 }],
  }), []);
});

// Under a year range RDV narrows the year aggregation, but each matching record
// still lands in every year its date span covers — buckets spill outside the
// window. The in-window buckets are exact per-year counts, so keep only those.
test('a year range trims the year facet to its window and is no same-dimension clash', () => {
  const bucket = (year, count) => ({ __typename: 'FacetValueTimeRange', startTime: `${year}-01-01T00:00:00Z`, count });
  const yearFacet = (applied, total) => buildFacetResponse(
    { values: [bucket(1851, 17362), bucket(1849, 10403), bucket(1850, 17962), bucket(1700, 3)], count: total, nbTotal: total, othersCount: 0 },
    { name: 'year', query: '', scope: 'all', fullTextOnly: false, total, applied },
  ).structured;

  const s = yearFacet({ year_from: 1850, year_to: 1851 }, 30000);
  assert.deepEqual(s.values.map((v) => v.value), [1850, 1851]);
  assert.equal(s.distinct_values, 2);
  assert.equal(s.same_dimension_filter, false);
  assert.equal(s.coverage_pct, 100);
  assert.deepEqual(yearFacet({ year_from: 1850 }, 30000).values.map((v) => v.value), [1850, 1851], 'open above');
  assert.deepEqual(yearFacet({ year_to: 1849 }, 30000).values.map((v) => v.value), [1700, 1849], 'open below');
  // Unbounded: every bucket, chronologically.
  assert.deepEqual(yearFacet(undefined, 1073915).values.map((v) => v.value), [1700, 1849, 1850, 1851]);
});

test('full_text_only on the availability facet is a same-dimension clash', () => {
  const { structured } = buildFacetResponse(
    { values: [{ __typename: 'FacetValueString', strVal: 'strings:kein Digitalisat', count: 70 }], count: 5, nbTotal: 900, othersCount: 0 },
    { name: 'availability', query: 'x', scope: 'all', fullTextOnly: true, applied: undefined, total: 100 },
  );
  assert.equal(structured.same_dimension_filter, true);
  assert.equal(structured.coverage_pct, null);
});

test('full_text_only leaves other facets alone', () => {
  const { structured } = buildFacetResponse(
    { values: [{ __typename: 'FacetValueString', strVal: 'strings:Basel', count: 7 }], count: 5, nbTotal: 50, othersCount: 0 },
    { name: 'library', query: 'x', scope: 'all', fullTextOnly: true, applied: undefined, total: 100 },
  );
  assert.equal(structured.same_dimension_filter, false);
  assert.equal(structured.coverage_pct, 50);
});
