// Offline unit tests for the query refusal and warning detectors, the
// single-owner text mirror, and the response applier (src/lib/warnings.js). Pure functions, no
// network. The three query tools declare a `warnings` output field, asserted
// here against their shipped schemas so the contract can't silently drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertQuery, detectQueryError, detectQueryWarnings, detectSameDimensionFacetWarnings,
  detectVocabularyWarnings, mirrorWarnings, withWarnings,
} from '../src/lib/warnings.js';
import { ToolError } from '../src/lib/errors.js';
import { outputSchema as searchOutput } from '../src/tools/search.js';
import { outputSchema as facetOutput } from '../src/tools/facet_values.js';
import { outputSchema as autocompleteOutput } from '../src/tools/autocomplete.js';

// --- detectQueryError: the whole-corpus forms ----------------------------------

for (const [form, queries, suggestion] of [
  ['wrapped in parentheses (the backend empties it)',
    ['(Cholera)', '(Cholera*) | (choléra*)', '( Cholera )', '((Cholera))', '  (Cholera Karte)  '], /Remove the parentheses/],
  ['that is only whitespace (the trim would make it the empty query)',
    [' ', '   ', '\t\n'], /pass "" explicitly/],
]) {
  test(`refuses a query ${form}`, () => {
    for (const q of queries) {
      const e = detectQueryError(q);
      assert.ok(e, `expected a refusal for: ${JSON.stringify(q)}`);
      assert.match(e.message, /whole corpus/i);
      assert.match(e.suggestion, suggestion);
    }
  });
}

test('assertQuery raises the refusal as a ToolError and passes clean queries through', () => {
  assert.throws(() => assertQuery({ query: '(Cholera)' }), ToolError);
  assert.doesNotThrow(() => assertQuery({ query: 'Cholera' }));
  assert.doesNotThrow(() => assertQuery({ query: '' }));
  assert.doesNotThrow(() => assertQuery({}));
});

// A leading "-" is an exact exclusion (`-Karte Basel` = Basel minus Karte), so
// it is a real query, not a whole-corpus form.
test('does not refuse partial, quoted or inner parentheses, nor any "-"', () => {
  for (const q of ['(Cholera', 'Cholera)', 'Cholera (1831)', '(Cholera) Karte', '"(Cholera)"',
    'Karte -Basel', '-Karte Basel', '-Karte', 'Cholera-Epidemie', '', 'Cholera']) {
    assert.equal(detectQueryError(q), null, `unexpected refusal for: ${JSON.stringify(q)} ("" is the documented whole-corpus query)`);
  }
  assert.equal(detectQueryError(undefined), null);
});

// --- detectQueryWarnings: parser traps ----------------------------------------

test('flags standalone uppercase AND/OR/NOT as literal terms', () => {
  for (const q of ['Basel AND Bern', 'Basel OR Bern', 'NOT Basel', 'a AND b OR c']) {
    const w = detectQueryWarnings(q);
    assert.equal(w.length, 1, `expected one warning for: ${q}`);
    assert.match(w[0], /literal search term/i);
    assert.match(w[0], /a\|b/, 'should suggest the symbolic operators');
  }
});

test('names which operators appeared, de-duplicated', () => {
  assert.match(detectQueryWarnings('a AND b AND c')[0], /Treating AND /);
  assert.match(detectQueryWarnings('a AND b OR c')[0], /Treating AND\/OR /);
});

test('does not flag operators inside a quoted phrase', () => {
  assert.deepEqual(detectQueryWarnings('"Sturm AND Drang"'), []);
  assert.deepEqual(detectQueryWarnings('"black OR white" cats'), []);
});

test('does not flag lowercase and/or/not or operator substrings inside words', () => {
  assert.deepEqual(detectQueryWarnings('katze and hund'), []); // lowercase = ordinary words
  assert.deepEqual(detectQueryWarnings('DOCTOR GRANDOR MOOR'), []); // AND/OR embedded, no boundary
});

// --- detectQueryWarnings: field:value ------------------------------------------

test('flags field:value syntax', () => {
  for (const q of ['title:Basel', 'author:Burckhardt', 'a b subject:law']) {
    const w = detectQueryWarnings(q);
    assert.ok(w.some((x) => /field:value/i.test(x)), `expected a field:value warning for: ${q}`);
    assert.ok(w.some((x) => /scope/i.test(x)), 'should point to the scope argument');
  }
});

test('flags field:value after a - or | operator', () => {
  for (const q of ['Basel -author:Burckhardt', 'Karte|title:Plan']) {
    const w = detectQueryWarnings(q).filter((x) => /field:value/i.test(x));
    assert.equal(w.length, 1, `expected exactly one field:value warning for: ${q}`);
  }
});

test('does not flag hyphenated or piped plain terms', () => {
  for (const q of ['Cholera-Epidemie', 'Karte|Plan', 'http://x.y|z']) {
    assert.deepEqual(detectQueryWarnings(q), [], q);
  }
});

test('does not mistake a URL scheme or a time for field:value', () => {
  assert.deepEqual(detectQueryWarnings('http://example.org/foo'), []);
  assert.deepEqual(detectQueryWarnings('https://d-nb.info/gnd/118516531'), []);
  assert.deepEqual(detectQueryWarnings('12:30'), []); // digit-led, not a field
});

test('does not flag colons inside a quoted phrase', () => {
  assert.deepEqual(detectQueryWarnings('"Basel: a history"'), []);
});

test('can report both trap kinds at once', () => {
  const w = detectQueryWarnings('title:Basel AND Bern');
  assert.equal(w.length, 2, 'expected a boolean warning and a field:value warning');
});

// --- detectQueryWarnings: clean / degenerate inputs ----------------------------

test('returns no warnings for clean or empty queries', () => {
  for (const q of ['', 'Basel', '+Basel +Bern', 'Über die Räuber', 'stadt*', 'haus~1', undefined, null, 42]) {
    assert.deepEqual(detectQueryWarnings(q), [], `expected no warnings for: ${String(q)}`);
  }
});

// The parser's inner-parenthesis and mid-word-wildcard traps are guidance in
// src/guide.md and the tool description, NOT warnings — a detector
// for them misfired on ordinary punctuation (see warnings.js). Pinned so it is
// not re-added by accident.
test('does not warn on the guidance-only parser traps', () => {
  for (const q of ['Cholera* | Karte*', 'Basel Karte*', 'Karte -Basel', 'Cholera (1831)',
    'Karte*, Basel', 'Wer war Burckhardt?', '"Stadtplan Basel"~6 Karte']) {
    assert.deepEqual(detectQueryWarnings(q), [], `expected no warnings for: ${q}`);
  }
});

// --- mirrorWarnings: single-owner text formatting ------------------------------

test('mirrorWarnings appends prefixed lines after a blank-line separator', () => {
  const out = mirrorWarnings('body text', ['first', 'second']);
  assert.equal(out, 'body text\n\n⚠ first\n⚠ second');
});

test('mirrorWarnings returns text unchanged when there are no warnings', () => {
  assert.equal(mirrorWarnings('body', []), 'body');
  assert.equal(mirrorWarnings('body', undefined), 'body');
});

test('mirrorWarnings handles an empty base text', () => {
  assert.equal(mirrorWarnings('', ['note']), '⚠ note');
});

// --- detectVocabularyWarnings --------------------------------------------------
// Fires only at exactly zero and only under a pinned-vocabulary dimension (the
// handler-level control cases live in facet_breakdown.test.js). What is pinned
// here is ATTRIBUTION: the pinned dimension is the likeliest culprit, never the
// only one, and a caller who re-checks it, finds it live, and stops looking has
// been sent past the real stale value.

test('a zero under a pinned dimension also names the other filters in the call', () => {
  const [w] = detectVocabularyWarnings(
    { filters: { availability: ['Digitalisat (Volltext)'], scan_source: ['BSB'], library: ['x'] } },
    0,
  );
  assert.match(w, /narrowing by availability/, 'the pinned dimension still leads');
  assert.match(w, /scan_source, library/, 'the un-pinned filters must be named as suspects too');
  assert.match(w, /match facet values exactly/, 'must say why an abbreviated value empties a call');
});

test('a zero under a pinned dimension alone says nothing about other filters', () => {
  const [w] = detectVocabularyWarnings({ full_text_only: true }, 0);
  assert.match(w, /narrowing by full_text_only/);
  assert.doesNotMatch(w, /other values in this call/, 'there are none — do not invent suspects');
});

// The remedy follows who spelled the value. A caller-passed `availability` value
// can be re-read and retried; `object_type` keys and `full_text_only` are mapped
// by the server, so "retry with the facet's value" would be rejected by the
// schema (the facet reads `Einzelseite`, the filter takes `foldout`).
test('a caller-passed vocabulary value is re-read and retried', () => {
  const [w] = detectVocabularyWarnings({ filters: { availability: ['Volltext'] } }, 0);
  assert.match(w, /facet="availability"\) and retry/);
  assert.doesNotMatch(w, /mapped to stored values/);
});

test('a server-mapped value is compared against the facet, never retried', () => {
  for (const args of [{ filters: { object_type: ['foldout'] } }, { full_text_only: true }]) {
    const [w] = detectVocabularyWarnings(args, 0);
    assert.match(w, /mapped to stored values by this server/);
    assert.match(w, /drop that narrowing/);
    assert.doesNotMatch(w, /and retry/, 'the schema rejects any value but the keys');
  }
  const [w] = detectVocabularyWarnings({ full_text_only: true }, 0);
  assert.match(w, /facet="availability"/, 'full_text_only reads back through the availability facet');
});

test('stays silent on a non-zero total and on filters with no pinned dimension', () => {
  assert.deepEqual(detectVocabularyWarnings({ filters: { availability: ['x'] } }, 1), []);
  assert.deepEqual(detectVocabularyWarnings({ filters: { scan_source: ['BSB'] } }, 0), []);
});

// --- detectSameDimensionFacetWarnings ------------------------------------------
// The trap: RDV drops a dimension's own filter from its own aggregation, so the
// buckets count a wider population than query_total (faceting `language` under
// filters.language:["Latein"] still returns the full Deutsch bucket). Only that
// dimension's narrowing goes: the query still scopes the buckets, so the warning
// must not call them collection-wide.

test('fires when the faceted dimension is also filtered', () => {
  const w = detectSameDimensionFacetWarnings({ filters: { language: ['Latein'] } }, ['language']);
  assert.equal(w.length, 1);
  assert.match(w[0], /"language" is both filtered and aggregated/);
  assert.match(w[0], /inclusion-exclusion/, 'must name the recipe that does work');
  assert.match(w[0], /A \+ B - union/, 'must spell the arithmetic out');
  assert.match(w[0], /query_total/, 'must say which number is still trustworthy');
  assert.match(w[0], /your query/, 'must say the query still scopes the buckets');
});

// The wording this class of warning must never drift back to. "Collection-wide"
// reads as "your query was discarded too", which is false and expensive: a
// caller who believes it throws away buckets that are correctly query-scoped.
test('no same-dimension warning calls the buckets collection-wide', () => {
  const cases = [
    [{ filters: { language: ['Latein'] } }, ['language'], 'buckets'],
    [{ filters: { language: ['Latein'] } }, ['language'], 'axis'],
  ];
  for (const [args, dims, surface] of cases) {
    for (const w of detectSameDimensionFacetWarnings(args, dims, surface)) {
      assert.doesNotMatch(w, /collection-wide|whole collection/i, `${surface}: ${w}`);
    }
  }
});

// A year range narrows the year facet properly (its clause carries a family
// selector, which RDV does apply to the year aggregation), so it never clashes.
test('a year range is no clash, under the year facet or any other', () => {
  for (const args of [{ year_from: 1850 }, { year_to: 1900 }, { year_from: 1850, year_to: 1900 }]) {
    assert.deepEqual(detectSameDimensionFacetWarnings({ facet: 'year', ...args }, ['year']), []);
    assert.deepEqual(detectSameDimensionFacetWarnings(args, ['library']), []);
  }
});

test('stays silent when the filter names a DIFFERENT dimension', () => {
  // The cross-tab slice the skill recommends — this must not be warned about.
  assert.deepEqual(
    detectSameDimensionFacetWarnings({ filters: { library: ['Bern, UB Münstergasse'] } }, ['language']),
    [],
  );
});

test('checks both cross-tab axes and phrases the damage for a grid', () => {
  const args = { filters: { language: ['Latein'], genre: ['Hochschulschrift'] } };
  const w = detectSameDimensionFacetWarnings(args, ['language', 'genre'], 'axis');
  assert.equal(w.length, 2, 'one per clashing axis');
  assert.ok(w.every((x) => /lists your filter's own values instead of discovered ones, and its per-row totals are omitted rather than shipped un-narrowed/.test(x)), 'must match what the shaper does');
  assert.ok(w.every((x) => /same_dimension_filter: true/.test(x)), 'point at the structured marker');
  assert.ok(w.every((x) => /CELLS are still correct/.test(x)), 'the grid interior stays exact — say so');
  assert.ok(w.every((x) => !/as if filters\.|not the intersection you asked for/.test(x)),
    'an axis ships the filter\'s own values, so the un-narrowed-distribution claim would be false');
  const [b] = detectSameDimensionFacetWarnings({ filters: { language: ['Latein'] } }, ['language']);
  assert.match(b, /as if filters\.language were unset/);
  assert.match(b, /not the intersection you asked for/);
});

test('full_text_only clashes with the availability dimension only', () => {
  const w = detectSameDimensionFacetWarnings({ full_text_only: true }, ['availability']);
  assert.equal(w.length, 1);
  assert.match(w[0], /full_text_only/);
  assert.match(w[0], /both filtered and aggregated/);
  assert.doesNotMatch(w[0], /filters\.availability were unset/);
  assert.deepEqual(detectSameDimensionFacetWarnings({ full_text_only: true }, ['language']), []);
  assert.deepEqual(detectSameDimensionFacetWarnings({ full_text_only: false }, ['availability']), []);
});

test('full_text_only on an availability axis does not claim the axis lists the filter\'s values', () => {
  const [w] = detectSameDimensionFacetWarnings({ full_text_only: true }, ['availability'], 'axis');
  assert.match(w, /full_text_only/);
  assert.doesNotMatch(w, /lists your filter's own values/);
  assert.match(w, /per-row totals are omitted/);
});

test('an explicit availability filter keeps the filters wording even with full_text_only', () => {
  const [w] = detectSameDimensionFacetWarnings(
    { full_text_only: true, filters: { availability: ['Volltext'] } }, ['availability']);
  assert.match(w, /as if filters\.availability were unset/);
});

test('tolerates a missing or empty filters object', () => {
  for (const args of [{}, undefined, { filters: null }, { filters: { language: [] } }]) {
    assert.deepEqual(detectSameDimensionFacetWarnings(args, ['language']), []);
  }
  assert.deepEqual(detectSameDimensionFacetWarnings({ filters: { language: ['x'] } }, []), []);
});

test('throws on an unknown surface rather than defaulting to the wrong phrasing', () => {
  // A silent fallback to `buckets` would tell a cross-tab caller to trust
  // query_total — a field that response does not carry.
  assert.throws(
    () => detectSameDimensionFacetWarnings({ filters: { language: ['x'] } }, ['language'], 'grid'),
    TypeError,
  );
});

// --- withWarnings: uniform applier ---------------------------------------------

test('withWarnings attaches structured.warnings and mirrors text', () => {
  const shaped = { structured: { total: 3 }, text: 'Found 3.' };
  const out = withWarnings(shaped, ['note']);
  assert.deepEqual(out.structured, { total: 3, warnings: ['note'] });
  assert.equal(out.text, 'Found 3.\n\n⚠ note');
});

test('withWarnings is a no-op when there are no warnings', () => {
  const shaped = { structured: { total: 3 }, text: 'Found 3.' };
  assert.deepEqual(withWarnings(shaped, []), shaped);
  assert.deepEqual(withWarnings(shaped, undefined), shaped);
});

test('withWarnings does not mutate the input structured object', () => {
  const shaped = { structured: { total: 3 }, text: 'x' };
  withWarnings(shaped, ['w']);
  assert.equal('warnings' in shaped.structured, false, 'input must be left untouched');
});

// --- output-schema contract ----------------------------------------------------

test('each query tool output schema accepts a warnings array', () => {
  assert.doesNotThrow(() => searchOutput.parse({
    total: 0, page: 1, page_size: 10, sort: 'relevance', returned: 0, has_more: false, next_page: null,
    results: [], warnings: ['w'],
  }));
  assert.doesNotThrow(() => facetOutput.parse({
    facet: 'library', query: 'x', scope: 'all', full_text_only: false,
    distinct_values: null, matching_records: null, absent_records: null, query_total: null, coverage_pct: null,
    multi_valued: false, same_dimension_filter: false, returned: 0, others_count: 0, values: [], warnings: ['w'],
  }));
  assert.doesNotThrow(() => autocompleteOutput.parse({
    query: 'x', scope: 'all', full_text_only: false, exact_term_records: null,
    suggestions: {}, warnings: ['w'],
  }));
});
