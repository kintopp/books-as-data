// Live tests for the per-family daterange filter.
//
// The `[facet.daterange].daterange` field holds the publication date AND five
// numeric `*AsDate` families (OCR quality, media/volume/item counts, ZB genre
// confidence) encoded as pseudo-dates. A bare `rangeValues` clause matches a
// record where ANY family falls in the range, so the compiler names the family
// as `values: ['[<family>].undefined']` — the form the website's own filter
// builder emits (a JS artifact), and the only suffix the backend honours.
//
// These tests bypass the tool layer where they need to: the tool schema floors
// years at 1000, and the probe needs year 100 — a year no publication in this
// 1699–1901 corpus can carry, so every hit there is a numeric family leaking in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, liveSearchCount } from './helpers.js';
import { graphqlRequest } from '../src/graphql/client.js';
import { FACET_FILTERED_QUERY } from '../src/graphql/operations.js';
import { buildDimensionFilters, buildFacetVariables } from '../src/search/compiler.js';
import { shapeValue } from '../src/lib/facet.js';
import { RANGE_FILTERS } from '../src/config.js';

const familyOf = (lo) => RANGE_FILTERS.find((r) => r.lo === lo).family;

// The compiler's own year-100 clause, with its family selector swapped out.
const [year100] = buildDimensionFilters({ year_from: 100, year_to: 100 });
const withSelector = (values) => {
  const boolTerm = { ...year100.boolTerm, values };
  if (!values) delete boolTerm.values;
  return { boolTerm };
};

test('live: a year filter matches no record in a year with no publications', { skip: !LIVE }, async () => {
  const count = await liveSearchCount({ query: '', year_from: 100, year_to: 100 });
  assert.equal(count, 0,
    `year 100–100 matched ${count} records — numeric *AsDate values are leaking into the publication-year `
    + 'filter, so the `[daterange].undefined` family selector has stopped working: re-probe the website\'s filter form');
});

// Canary for the form itself. The selector works only because the website's
// builder emits `.undefined`; if the website is fixed, the backend may start
// honouring a proper selector — or stop honouring this one (the invariant above
// catches that). When THIS fails: re-probe and consider the cleaner form.
test('live: the daterange canary — only the `.undefined` selector picks a family', { skip: !LIVE }, async () => {
  const count = (clause) => liveSearchCount({ query: '' }, { extraFilter: clause });
  const unselected = await count(withSelector(null));
  assert.ok(unselected > 0,
    'a bare year-100 range returned 0: the backend no longer mixes the families — the selector may be unnecessary now');
  const bareFamily = await count(withSelector([`[${familyOf('year_from')}]`]));
  assert.equal(bareFamily, unselected,
    'a bare `[daterange]` selector changed the count: a proper family form may have arrived — re-probe and consider switching');
});

// A measure filter must count exactly what that family's facet reports for the
// same range, which is what proves the clause selects the family it names. Both
// sides are narrowed by the same year window (a different family) to keep the
// facet — which ignores `size` — from shipping every page count in the corpus.
test('live: the page-count filter agrees with the page-count facet', { skip: !LIVE }, async () => {
  const slice = { query: '', year_from: 1850, year_to: 1851 };
  const filtered = await liveSearchCount({ ...slice, pages_min: 100, pages_max: 110 });
  const vars = buildFacetVariables({ ...slice, facet: 'year', size: 10 });
  vars.facet.term.include = [familyOf('pages_min')];
  const { values } = (await graphqlRequest(FACET_FILTERED_QUERY, vars)).facetFiltered;
  const inRange = values.map(shapeValue).filter((v) => v.value >= 100 && v.value <= 110);
  assert.ok(inRange.length > 0, 'the page-count facet returned no buckets in 100–110 — has the include form changed?');
  const sum = inRange.reduce((acc, v) => acc + v.count, 0);
  assert.equal(filtered, sum, `pages 100–110 filtered to ${filtered} but the facet buckets sum to ${sum}`);
});
