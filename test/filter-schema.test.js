// Offline shape tests for the shared filters/year schema (src/tools/filter-schema.js).
// This module had no direct test coverage: it is declarative and registry-driven,
// so the contract to pin is structural — the surface tracks FILTER_DIMENSIONS,
// stays `.strict()`, enum-constrains valueMap dimensions, and rejects empties.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filtersSchema, yearSchema, enrichmentDims, assertRanges, rangeInputs,
} from '../src/tools/filter-schema.js';
import { RANGE_KEYS } from '../src/config.js';
import { FILTER_DIMENSIONS, FACET_DIMENSIONS, MAX_FILTER_VALUES_PER_DIMENSION } from '../src/config.js';

test('filtersSchema exposes exactly one optional property per FILTER_DIMENSIONS entry', () => {
  const keys = Object.keys(filtersSchema.shape).sort();
  assert.deepEqual(keys, [...FILTER_DIMENSIONS].sort());
});

test('filtersSchema is strict — an unknown dimension is rejected', () => {
  assert.equal(filtersSchema.safeParse({ not_a_dimension: ['x'] }).success, false);
});

test('filtersSchema accepts a non-empty string-array value and rejects an empty array', () => {
  assert.equal(filtersSchema.safeParse({ library: ['Bern, UB'] }).success, true);
  assert.equal(filtersSchema.safeParse({ library: [] }).success, false,
    'an empty value array is not a valid narrowing');
  assert.equal(filtersSchema.safeParse({}).success, true, 'no narrowing at all is valid');
});

test('a valueMap dimension (object_type) is enum-constrained to its friendly keys', () => {
  const validKey = Object.keys(FACET_DIMENSIONS.object_type.valueMap)[0];
  assert.equal(filtersSchema.safeParse({ object_type: [validKey] }).success, true);
  assert.equal(filtersSchema.safeParse({ object_type: ['not-a-real-object-type'] }).success, false);
});

test('yearSchema bounds the corpus-wide range and requires an integer', () => {
  assert.equal(yearSchema.safeParse(1800).success, true);
  assert.equal(yearSchema.safeParse(999).success, false);
  assert.equal(yearSchema.safeParse(2101).success, false);
  assert.equal(yearSchema.safeParse(1800.5).success, false);
});

test('filtersSchema caps the number of values per dimension', () => {
  const atCap = Array.from({ length: MAX_FILTER_VALUES_PER_DIMENSION }, (_, i) => `value ${i}`);
  assert.equal(filtersSchema.safeParse({ library: atCap }).success, true, 'exactly at the cap is valid');
  assert.equal(filtersSchema.safeParse({ library: [...atCap, 'one too many'] }).success, false,
    'one value over the cap is rejected');
});

test('assertRanges rejects an inverted range and allows valid/equal/open-ended bounds', () => {
  // Inverted ranges reach the backend as an ES range whose start > end, which
  // 400s with an opaque "all shards failed" — the guard must fire first.
  assert.throws(() => assertRanges({ year_from: 1900, year_to: 1800 }), /year_from.*exceeds.*year_to/);
  assert.doesNotThrow(() => assertRanges({ year_from: 1800, year_to: 1900 }));
  assert.doesNotThrow(() => assertRanges({ year_from: 1850, year_to: 1850 }), 'a single-year range is valid');
  assert.doesNotThrow(() => assertRanges({ year_from: 1850 }), 'open-ended above');
  assert.doesNotThrow(() => assertRanges({ year_to: 1850 }), 'open-ended below');
  assert.doesNotThrow(() => assertRanges({}));
  assert.doesNotThrow(() => assertRanges());
  assert.throws(() => assertRanges({ pages_min: 300, pages_max: 100 }), /pages_min.*exceeds.*pages_max/);
  assert.doesNotThrow(() => assertRanges({ pages_min: 100, pages_max: 100 }));
});

test('enrichmentDims flags the machine-derived dimensions and not the catalogued ones', () => {
  assert.ok(enrichmentDims.includes('subject_area'));
  assert.ok(enrichmentDims.includes('topic'));
  assert.ok(!enrichmentDims.includes('library'), 'library is catalogued, not an enrichment');
});

// The compiler and the echo iterate RANGE_FILTERS while the input schema is
// written out by hand; a key in one but not the other is validated-but-never-sent
// (or sent-but-never-accepted), so pin the pairing.
test('rangeInputs declares exactly the RANGE_FILTERS bounds', () => {
  assert.deepEqual(Object.keys(rangeInputs).sort(), [...RANGE_KEYS].sort());
});
