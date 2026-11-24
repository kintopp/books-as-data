// Offline unit tests for the applied_filters build/render pair (src/lib/applied.js).
// Pins the round-trip contract both sgbr_search and sgbr_facet_values depend on:
// buildApplied is undefined when nothing was narrowed, strips the no-op scope
// 'all', and gates scope/full_text_only behind includeScope (the search-only
// superset); renderApplied is the one-line human echo of the same object.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplied, renderApplied } from '../src/lib/applied.js';

test('buildApplied is undefined when nothing was narrowed', () => {
  assert.equal(buildApplied({}), undefined);
  assert.equal(buildApplied({ scope: 'all' }, { includeScope: true }), undefined,
    'the no-op scope "all" must not by itself produce an applied_filters block');
  assert.equal(buildApplied({ filters: {} }), undefined, 'an empty filters object is not a narrowing');
});

test('buildApplied collects filters and year bounds', () => {
  const applied = buildApplied({ filters: { library: ['Bern, UB'] }, year_from: 1800, year_to: 1850 });
  assert.deepEqual(applied, { filters: { library: ['Bern, UB'] }, year_from: 1800, year_to: 1850 });
});

test('buildApplied echoes scope/full_text_only ONLY under includeScope (the search superset)', () => {
  const search = buildApplied({ scope: 'call_number', full_text_only: true }, { includeScope: true });
  assert.deepEqual(search, { scope: 'call_number', full_text_only: true });

  // The facet caller opts out — those live as separate top-level fields there,
  // so they must not leak into its applied_filters echo.
  assert.equal(buildApplied({ scope: 'call_number', full_text_only: true }), undefined);
});

// Internal defensive contract — NOT reachable through any tool. `yearSchema` is
// `z.number().int().min(1000).max(2100)` (src/tools/filter-schema.js), so 0 is
// rejected long before buildApplied sees it. Kept because it pins WHY the guard
// is `!= null` rather than a falsiness check: a future bound that legitimately
// is 0 must not silently vanish from the echo.
test('buildApplied treats year 0 as a real bound (!= null), not absent', () => {
  assert.deepEqual(buildApplied({ year_from: 0 }), { year_from: 0 });
});

test('renderApplied is empty for an undefined narrowing', () => {
  assert.equal(renderApplied(undefined), '');
});

test('renderApplied joins scope, full-text, filters (| within a dim) and a year range', () => {
  const rendered = renderApplied({
    scope: 'call_number',
    full_text_only: true,
    filters: { library: ['Bern, UB', 'Basel, UB'] },
    year_from: 1800,
    year_to: 1850,
  });
  assert.equal(rendered, 'scope=call_number; full text only; library=Bern, UB | Basel, UB; year 1800–1850');
});

test('renderApplied shows an open year bound with an ellipsis', () => {
  assert.equal(renderApplied({ year_from: 1800 }), 'year 1800–…');
  assert.equal(renderApplied({ year_to: 1850 }), 'year …–1850');
});

test('build → render round-trips a facet-side narrowing (no scope leakage)', () => {
  const args = { filters: { subject_area: ['Theologie'] }, year_from: 1700 };
  assert.equal(renderApplied(buildApplied(args)), 'subject_area=Theologie; year 1700–…');
});

test('buildApplied echoes exclude, and renderApplied marks it as a negation', () => {
  const applied = buildApplied({ filters: { language: ['Deutsch'] }, exclude: { object_type: ['foldout'] } });
  assert.deepEqual(applied, { filters: { language: ['Deutsch'] }, exclude: { object_type: ['foldout'] } });
  assert.equal(renderApplied(applied), 'language=Deutsch; object_type≠foldout');
  assert.equal(buildApplied({ exclude: {} }), undefined, 'an empty exclude object is not a narrowing');
});

test('buildApplied/renderApplied echo the page-count and OCR-quality bounds', () => {
  const applied = buildApplied({ pages_min: 100, pages_max: 300, ocr_quality_min: 95 });
  assert.deepEqual(applied, { pages_min: 100, pages_max: 300, ocr_quality_min: 95 });
  assert.equal(renderApplied(applied), 'pages 100–300; OCR quality ≥ 95');
  assert.equal(renderApplied(buildApplied({ pages_max: 50 })), 'pages …–50');
});
