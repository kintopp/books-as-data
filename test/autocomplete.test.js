// Offline unit tests for autocomplete shaping: group selection, per-group limit,
// suggestion cleaning, and the exact-term count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutocompleteResponse } from '../src/lib/autocomplete.js';

const sample = {
  namedResults: [
    { name: 'title', results: ['Burckhardt', 'Burg', 'Burgdorf'] },
    { name: 'author', results: ['Burg, X'] },
  ],
  countResult: { resultCount: 42 },
};

test('groups suggestions by requested name and reports the exact-term count', () => {
  const { structured } = buildAutocompleteResponse(sample, {
    query: 'Bur', scope: 'all', fullTextOnly: false, groups: ['title', 'author', 'subject'], limit: 10,
  });
  assert.deepEqual(structured.suggestions.title, ['Burckhardt', 'Burg', 'Burgdorf']);
  assert.deepEqual(structured.suggestions.author, ['Burg, X']);
  assert.deepEqual(structured.suggestions.subject, [], 'missing group → empty list');
  assert.equal(structured.exact_term_records, 42, 'a positive count is trusted whatever the group count');
});

// RDV returns a flat 0 beside a full suggestion list when several named groups are
// requested. Reporting that 0 would read as "no records match".
test('a multi-group zero count is reported as unknown, not as zero', () => {
  const zeroed = { ...sample, countResult: { resultCount: 0 } };
  const { structured, text } = buildAutocompleteResponse(zeroed, {
    query: 'Bur', scope: 'all', fullTextOnly: false, groups: ['title', 'author', 'subject'], limit: 10,
  });
  assert.equal(structured.exact_term_records, null);
  assert.deepEqual(structured.suggestions.title, ['Burckhardt', 'Burg', 'Burgdorf'], 'suggestions still stand');
  assert.doesNotMatch(text, /^Autocomplete for "Bur" — 0 /m);
  assert.match(text, /count not reported/);
});

// With ONE group the backend does populate it, so a 0 there is a real zero.
test('a single-group zero count is a real zero', () => {
  const zeroed = { namedResults: [{ name: 'title', results: [] }], countResult: { resultCount: 0 } };
  const { structured } = buildAutocompleteResponse(zeroed, {
    query: 'zzz', scope: 'title', fullTextOnly: false, groups: ['title'], limit: 10,
  });
  assert.equal(structured.exact_term_records, 0);
});

// The count answers a different question from the suggestions (whole term vs.
// prefix), so the text channel must not let a 0 read as "nothing matches" —
// that is the whole reason the field is not called matching_records.
test('a real zero is rendered as a whole-term count, not as "no records"', () => {
  const { text } = buildAutocompleteResponse(
    { namedResults: [{ name: 'title', results: ['Erdbebenkunde'] }], countResult: { resultCount: 0 } },
    { query: 'Erdbeb', scope: 'title', fullTextOnly: false, groups: ['title'], limit: 10 },
  );
  assert.match(text, /COMPLETE term/);
  assert.match(text, /prefix matches/);
});

// The suggestion index returns MARC non-filing markup raw; every other surface
// serves the same title cleaned, and the model pastes these straight into a query.
test('strips MARC non-filing markers from suggestions', () => {
  const { structured } = buildAutocompleteResponse(
    { namedResults: [{ name: 'title', results: ['<<Die>> Erdbeben-Theorie Rudolf Falb\'s'] }], countResult: null },
    { query: 'Erdbeb', scope: 'title', fullTextOnly: false, groups: ['title'], limit: 10 },
  );
  assert.deepEqual(structured.suggestions.title, ['Die Erdbeben-Theorie Rudolf Falb\'s']);
});

// An author/subject suggestion is a FILTER value compiled to an exact keyword
// match, so rewriting it would turn a good suggestion into a well-formed zero.
// Titles are the only group with no filter dimension behind them.
test('leaves filterable groups byte-identical, markup and all', () => {
  const { structured } = buildAutocompleteResponse(
    {
      namedResults: [
        { name: 'author', results: ['<<Die>> Gesellschaft'] },
        { name: 'subject', results: ['<<Der>> Erste Weltkrieg'] },
      ],
      countResult: null,
    },
    { query: 'x', scope: 'all', fullTextOnly: false, groups: ['title', 'author', 'subject'], limit: 10 },
  );
  assert.deepEqual(structured.suggestions.author, ['<<Die>> Gesellschaft']);
  assert.deepEqual(structured.suggestions.subject, ['<<Der>> Erste Weltkrieg']);
});

test('dedupes suggestions that stripping collapsed onto one string', () => {
  const { structured } = buildAutocompleteResponse(
    { namedResults: [{ name: 'title', results: ['<<Die>> Alpen', 'Die Alpen', 'Alpenflora'] }], countResult: null },
    { query: 'Alp', scope: 'title', fullTextOnly: false, groups: ['title'], limit: 2 },
  );
  assert.deepEqual(structured.suggestions.title, ['Die Alpen', 'Alpenflora'],
    'the limit should buy two DISTINCT completions, not one twice');
});

test('applies the per-group limit', () => {
  const { structured } = buildAutocompleteResponse(sample, {
    query: 'Bur', scope: 'title', fullTextOnly: false, groups: ['title'], limit: 2,
  });
  assert.deepEqual(structured.suggestions.title, ['Burckhardt', 'Burg']);
});

test('null count and no suggestions render a gentle fallback', () => {
  const { structured, text } = buildAutocompleteResponse(
    { namedResults: [], countResult: null },
    { query: 'zzz', scope: 'all', fullTextOnly: false, groups: ['title', 'author', 'subject'], limit: 10 },
  );
  assert.equal(structured.exact_term_records, null);
  assert.match(text, /No suggestions/);
});
