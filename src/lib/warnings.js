// Detects RDV anti-patterns and mirrors advisory warnings into the
// human-readable text channel. One module, two concerns: the pure detectors
// (query-syntax anti-patterns on a raw `query` arg; result-integrity checks on
// a shaped facet response) and the SINGLE owner of warning text — no tool or
// shaper appends its own `⚠ ` lines (that would double-render). See
// rdv-search-syntax.md and rdv-facets-and-collections.md, both *(internal)*.
//
// The two query traps warned about here, neither of which the backend reports
// (`parsedError` is always null; see rdv-query-parser-2026-09-05.md *(internal)*):
//   1. AND/OR/NOT are literal terms, NOT boolean operators — a query containing
//      them silently searches for the words. Use bare terms (AND) or a|b instead.
//   2. field:value is not field scoping — RDV scopes via the `scope` argument.
//      Its outcome is not even consistently empty: `title:Gletscher` returns 0 while
//      `title:Basel` returns a few records, none of them field-scoped matches. So
//      neither an empty nor a non-empty response tells the caller anything, and this
//      warning is the only reliable signal.
// Detection is WARN-ONLY: the query still runs verbatim. RDV never errors on
// these (it just mis-searches), so there is no probe to confirm an auto-rewrite
// the way GLOBALISE's FTS sanitizer can — a warning that lets the model re-issue
// is safe; a silent rewrite would be a guess. The ONE exception is
// detectQueryError: forms whose result is provably the whole corpus are refused
// before the backend call, because no reading of that result is the answer to
// what was asked.
//
// The parser's OTHER traps — inner parentheses are stripped, mid-word `?`/`*`
// return 0 on the catalogue fields — are deliberately NOT warned about here.
// Detecting them means pattern-matching the query string, and that misfired on
// ordinary punctuation (`Karte*, Basel`, `Burckhardt?`) and mangled phrase
// clauses; a wrong warning is read as authoritative and outranks
// the result the model just saw. They are guidance in src/guide.md and the tool
// description instead. Don't re-add them without a detector that is exact.

import { clashCause, narrowsDimension } from './applied.js';
import { ToolError } from './errors.js';
import { FACET_DIMENSIONS, FULLTEXT_ONLY_DIMENSION, TYPICAL_PAGE_LONG_EDGE } from '../config.js';

const WARN_PREFIX = '⚠ ';

// Uppercase, standalone boolean words. Case-sensitive on purpose: lowercase
// and/or/not are ordinary corpus words (flagging them would be noisy) and are
// rarely meant as operators; the uppercase form is the deliberate-boolean tell.
const BOOL_OPERATORS = /\b(AND|OR|NOT)\b/g;

// field:value — a term (letter/underscore-led) followed by ':' then a non-space,
// excluding a URL scheme's '://' so "http://…" doesn't trip it. The clause may
// start a word or follow '|', and may carry a leading '-' (-author:X). Colons
// inside "phrases" are removed before this runs, and a leading digit (times like
// 12:30) is excluded by the required letter/underscore first char.
const FIELD_VALUE = /(?:^|\s|\|)-?[A-Za-z_][\w.]*:(?!\/\/)\S/;

// Quoted phrases are literal user intent (a title, an exact phrase), so any
// operator/colon inside them is deliberate — strip them before scanning.
const QUOTED_PHRASE = /"[^"]*"/g;

// A query whose WHOLE text sits inside one pair of parentheses; inner, partial
// or quoted parentheses are merely stripped by the backend and are not refused.
const WRAPPED_IN_PARENS = /^\(.*\)$/s;

/**
 * The query forms that must not be sent at all, or null. Not a warning: the
 * response to each is the (near-)whole corpus, which is wrong under every
 * reading, so the caller is told before a backend call is spent. The empty
 * string itself is NOT refused — it is the documented way to count or facet the
 * whole corpus; only a non-empty query that the compiler's trim would turn into
 * one is, since its author meant to search for something. Pure; returns
 * `{ message, suggestion }`; assertQuery below raises it.
 */
export function detectQueryError(query) {
  if (typeof query !== 'string') return null;
  const q = query.trim();
  if (query && !q) {
    return {
      message: 'The query is only whitespace, which would run as the EMPTY query and return the whole corpus.',
      suggestion: 'Supply search terms, or pass "" explicitly if the whole corpus is what you want to count.',
    };
  }
  if (WRAPPED_IN_PARENS.test(q)) {
    return {
      message: 'The query is wrapped in parentheses, which the backend reads as an EMPTY query — ' +
        'it would return the whole corpus, not your terms.',
      suggestion: 'Remove the parentheses; they never group here. Run the alternatives as separate ' +
        'calls, or OR plain terms as a|b.',
    };
  }
  return null;
}

/**
 * Handler-level guard over detectQueryError: throws the refusal as a ToolError
 * so it surfaces as `isError` before any backend call. Called first by every
 * tool whose `query` reaches the Lucene parser (sgbr_search, sgbr_facet_values,
 * sgbr_facet_breakdown; test/query_refusal.test.js derives that set from the
 * wire). sgbr_autocomplete is deliberately NOT a caller — its backend is a
 * prefix suggester, not the parser, so none of the refused forms mean the same
 * thing there.
 */
export function assertQuery({ query } = {}) {
  const refused = detectQueryError(query);
  if (refused) throw new ToolError(refused.message, refused.suggestion);
}

/**
 * Advisory warnings for a raw free-text query, or `[]` when it is clean. Pure
 * and side-effect-free; safe to call on any tool's `query` arg (including '').
 */
export function detectQueryWarnings(query) {
  if (typeof query !== 'string' || !query) return [];
  const unquoted = query.replace(QUOTED_PHRASE, ' ');
  const warnings = [];

  const ops = [...new Set(unquoted.match(BOOL_OPERATORS) || [])];
  if (ops.length) {
    warnings.push(
      `Treating ${ops.join('/')} as literal search term(s), not boolean operators — ` +
      'RDV has no AND/OR/NOT. Use bare terms (AND), a|b (OR) and -term (exclude).',
    );
  }

  if (FIELD_VALUE.test(unquoted)) {
    warnings.push(
      'field:value syntax (e.g. "title:Basel") does no field scoping here — it usually ' +
      'matches nothing, but sometimes returns a small unrelated set instead, so do not read ' +
      'either outcome as a result. Re-issue using the scope argument (e.g. scope="title") ' +
      'to restrict which fields are searched.',
    );
  }

  return warnings;
}

// Dimensions whose accepted values are a controlled vocabulary this server pins
// rather than discovers — the ones a backend rename can silently empty. Read off the
// explicit `vocabulary` flag, NOT off `valueMap`: `availability` has no valueMap
// (callers pass its raw German values) yet is precisely the dimension a rename
// silently empties, so inferring from valueMap would have left the worst case
// uncovered. `full_text_only` belongs here too — it is the availability vocabulary
// wearing a boolean.
const VOCABULARY_DIMENSIONS = new Set(
  Object.entries(FACET_DIMENSIONS).filter(([, d]) => d.vocabulary).map(([name]) => name),
);

/**
 * Warn when a query narrowed by a pinned-vocabulary dimension returned NOTHING.
 *
 * This is the migration trap made visible. A term filter on a value the backend has
 * renamed answers HTTP 200 with zero hits, which is indistinguishable from an honest
 * empty result — a release can rename a whole dimension's values at once, and every
 * affected call then looks like a successful search of a corpus that happens to
 * contain nothing.
 *
 * Deliberately narrow: only fires at EXACTLY zero and only when a pinned
 * dimension was used, so a legitimately empty niche query is the only false
 * positive, and it costs no extra backend call. Pure — `total` is the shaped
 * response's own count.
 */
export function detectVocabularyWarnings(args, total) {
  if (total !== 0) return [];
  const dims = Object.keys(args?.filters || {});
  const used = dims.filter((d) => VOCABULARY_DIMENSIONS.has(d));
  if (args?.full_text_only) used.push('full_text_only');
  if (!used.length) return [];
  // Naming ONLY the pinned dimensions is a misattribution when the call narrows
  // by others too: every filter value has to match a live facet value exactly,
  // so an abbreviated one (`BSB` for `BSB (Google Books Partnership)`) empties
  // the result the same silent way. A caller sent to re-check the one dimension
  // that was fine confirms it and stops looking — the failure this warning
  // exists to prevent, one dimension over.
  const others = dims.filter((d) => !VOCABULARY_DIMENSIONS.has(d));
  const alsoCheck = others.length
    ? ` The other values in this call (${others.join(', ')}) can empty it the same way: filters `
      + 'match facet values exactly, so an abbreviated or guessed one also returns a clean zero.'
    : '';
  // A value the caller passed verbatim can be re-read and retried. One the server
  // maps for them (a `valueMap` key, `full_text_only`) cannot: the schema admits
  // only the keys, so a stale mapping shows up as facet counts the filter missed,
  // and dropping that narrowing is the only recourse.
  const passed = used.filter((d) => d !== 'full_text_only' && !FACET_DIMENSIONS[d].valueMap);
  const mapped = used.filter((d) => !passed.includes(d));
  const facetArg = (list) => [...new Set(list.map((d) => (d === 'full_text_only' ? FULLTEXT_ONLY_DIMENSION : d)))]
    .map((d) => `facet="${d}"`).join(', ');
  const remedies = [];
  if (passed.length) {
    remedies.push(`re-check the live values with sgbr_facet_values (${facetArg(passed)}) and retry`);
  }
  if (mapped.length) {
    remedies.push(`compare with sgbr_facet_values (${facetArg(mapped)}) over the same query: ` +
      `${mapped.join(', ')} ${mapped.length > 1 ? 'are' : 'is'} mapped to stored values by this server, so ` +
      'records there mean the mapping is stale — drop that narrowing and say so');
  }
  return [
    `Zero results while narrowing by ${used.join(', ')}. The backend occasionally renames these ` +
    'values, and a stale one matches nothing rather than erroring — before concluding the corpus ' +
    `has none, ${remedies.join('; and ')}.${alsoCheck}`,
  ];
}

// What a same-dimension clash ruins, and what survives it, per aggregating tool.
// Both live here because this module is the single owner of warning text. The
// `trusted` half is not padding: the two tools have different trustworthy
// numbers (the cross-tab response carries no query_total at all), and naming the
// wrong one would send a caller to a field that isn't there. Which is also why
// the lookup below has NO default branch — falling back to `buckets` on an
// unknown key would commit exactly that error, silently.
const SAME_DIMENSION_SURFACES = {
  buckets: {
    effect: (d, cause) => {
      const ignored = cause === 'full_text_only' ? 'full_text_only were false' : `filters.${d} were unset`;
      return 'the returned buckets (the response carries same_dimension_filter: true, and '
        + `coverage_pct is null, for this reason) are counted as if ${ignored} — `
        + 'a distribution over your query with this one dimension un-narrowed, not the intersection you '
        + 'asked for';
    },
    trusted: "query_total — and every other dimension's narrowing — is still correct",
  },
  axis: {
    effect: (_d, cause) => (cause === 'full_text_only'
      ? "that axis's values are discovered as if full_text_only were false (so rows outside the "
        + 'full-text values show zero cells)'
      : "that axis lists your filter's own values instead of discovered ones")
      + ', and its per-row totals are omitted rather than shipped un-narrowed (the axis carries '
      + 'same_dimension_filter: true)',
    trusted: "the grid's CELLS are still correct (each ANDs its own axis clauses on top of the "
      + "filter, so a cell IS the true intersection), as is every other dimension's narrowing",
  },
};

/**
 * Warn when one dimension is BOTH filtered and aggregated in the same call.
 *
 * RDV excludes a dimension's own filter clause from that dimension's aggregation —
 * the multi-select-facet convention ("what would you get if you changed *this*
 * selection"), right for a UI sidebar and wrong for anyone reading buckets as
 * counts. E.g. faceting `language` while filtering `language:["Latein"]` returns a
 * `Deutsch` bucket byte-identical to the same call with no language filter at all,
 * while every OTHER dimension's filter still applies and `query_total` is narrowed
 * correctly. So the response reads as internally consistent while one dimension's
 * numbers answer a different question.
 *
 * ONLY that dimension's own narrowing drops out — the query still scopes the
 * buckets (`Cholera` + `language:["Latein"]` gives Deutsch ~19.8k, the query's
 * own figure, not the corpus's ~640k). Don't call these buckets
 * "collection-wide": that reads as "the query was discarded too" and invites
 * throwing away numbers that are usable. A queryless probe cannot tell the two
 * apart, so re-probe WITH a query before restating this anywhere.
 *
 * Nothing else catches this. buildFacetIntegrityWarnings fires on it only as a
 * side effect (un-narrowed buckets outgrow the narrowed total) and then
 * misattributes it to coverage_pct or multi-valuedness — worse than silence,
 * because a caller who acts on that advice stops looking.
 *
 * Pure. `dims` is what the call aggregates over (one facet, or both cross-tab
 * axes); `surface` keys the phrasing above, and an unknown key throws.
 */
export function detectSameDimensionFacetWarnings(args, dims, surface = 'buckets') {
  const { effect, trusted } = SAME_DIMENSION_SURFACES[surface];
  return dims
    .filter((d) => narrowsDimension(args, d))
    .map((d) => `"${d}" is both filtered and aggregated in this call: RDV excludes a dimension's own `
      + `filter from its own aggregation, so ${effect(d, clashCause(args, d))}. `
      + `By contrast ${trusted}. To count records carrying two values of ONE dimension, use `
      + 'inclusion-exclusion over sgbr_search: count value A, count value B, then count both values '
      + 'together (values within a dimension are OR-ed, so that third call is the union); the '
      + 'intersection is A + B - union.');
}

/**
 * Integrity warnings for a shaped facet response, or `[]` when it reconciles.
 * Pure, like detectQueryWarnings — `args` is the tool's validated input,
 * `structured` the shaper's structuredContent.
 */
export function buildFacetIntegrityWarnings(args, structured) {
  const warnings = [];
  const matching = structured?.matching_records;
  const total = structured?.query_total;

  // A same-dimension clash makes the over-sum EXPECTED (the buckets drop this
  // dimension's own narrowing while the total keeps it), and
  // detectSameDimensionFacetWarnings already says so precisely. Firing here too
  // would append advice blaming coverage_pct — which this response has already
  // nulled for that very reason — so the caller would get the right diagnosis
  // followed by a stale one. Same reasoning as the multi_valued branch below:
  // an explained over-sum is not an anomaly.
  if (structured?.same_dimension_filter) return warnings;

  if (Number.isInteger(matching) && Number.isInteger(total) && matching > total) {
    // Expected for a known multi-valued dimension (one record, several buckets)
    // and anomalous otherwise — same arithmetic, different advice, so say which.
    warnings.push(structured?.multi_valued
      ? `"${args?.facet}" is multi-valued: matching_records (${matching}) counts value occurrences, ` +
        `not records, so it exceeds query_total (${total}) and the buckets sum above it. ` +
        'coverage_pct is omitted for this reason; use sgbr_search for an exact record count per value.'
      : `Facet matching_records (${matching}) exceeds query_total (${total}); ` +
        'treat coverage_pct as unreliable for this response and verify exact totals with sgbr_search.',
    );
  }

  return warnings;
}

/**
 * Warn when a requested image size was reduced, and say which ceiling did it.
 *
 * The two reasons must stay distinguishable: they tell the model OPPOSITE things
 * about what would actually help. 'native' means the region holds no more pixels,
 * so a WIDER crop is the only source of more detail; 'vision' means the delivery
 * was already over the encoder's budget, so a TIGHTER crop raises pixels-per-glyph
 * while a bigger request gains nothing. Advice that points the wrong way here is
 * worse than none — the model spends a call proving it changed nothing.
 *
 * Pure. `boundBy` is resolveDeliveryEdge's verdict; null means nothing was reduced.
 * A crop whose native size is unknown (no info.json) is the one unreduced case
 * that can still warn: the server upscales a small one and nothing here could
 * stop it. It warns only when, on a typical page, the crop would be smaller than
 * the delivery edge — a large crop carries no such risk.
 */
export function detectImageSizingWarnings({
  boundBy, requested, edge, regionWidth, regionHeight, regionPct,
}) {
  const hasRegion = Boolean(regionPct);
  const nativeUnknown = hasRegion && !(regionWidth > 0 && regionHeight > 0);
  if (nativeUnknown && (Math.max(regionPct[2], regionPct[3]) / 100) * TYPICAL_PAGE_LONG_EDGE < edge) {
    return [
      `The page's native size could not be read, so this crop was requested at ${edge}px without ` +
      'checking how many pixels the region really holds. A small region is enlarged by the server, ' +
      'which adds interpolation, not detail: if the image looks soft, widen region_pct rather than ' +
      'raising max_long_edge.',
    ];
  }
  if (!boundBy) return [];
  const clamped = `Image size reduced from the requested ${requested}px to ${edge}px`;
  if (boundBy === 'native') {
    const source = hasRegion ? 'That region holds' : 'This page holds';
    const widen = hasRegion
      ? 'To see more detail, widen region_pct — a line or block region rather than a single ' +
        'word — since only a larger region carries more pixels.'
      : 'This is the full resolution the page was scanned at.';
    return [
      `${clamped}: ${source} only ${regionWidth}×${regionHeight} pixels, so anything larger is ` +
      `interpolation, not detail. ${widen} Raising max_long_edge would change nothing.`,
    ];
  }
  return [
    `${clamped}: a larger image is downscaled before you ever see it, so the extra pixels ` +
    'would be paid for and discarded. To resolve finer detail, crop TIGHTER with region_pct ' +
    '— a smaller region delivered at this size shows more, while a larger request shows nothing more.',
  ];
}

/**
 * The SINGLE place query warnings reach `content[].text`: append them under a
 * blank-line separator with a unified prefix. Callers MUST route warnings
 * through here (via withWarnings) rather than formatting their own `⚠ ` lines.
 * Returns `text` unchanged when there are no warnings.
 */
export function mirrorWarnings(text, warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return text;
  const block = warnings.map((w) => `${WARN_PREFIX}${w}`).join('\n');
  return text ? `${text}\n\n${block}` : block;
}

/**
 * Apply warnings to a `{ structured, text }` shaper result uniformly: non-empty
 * warnings ride on structuredContent (the schema-declared `warnings` field) and
 * are mirrored into the text channel. One helper so all three query tools attach
 * them identically. No-op (returns the same object) when there are no warnings,
 * so the default path stays byte-identical.
 */
export function withWarnings(response, warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return response;
  return {
    structured: { ...response.structured, warnings },
    text: mirrorWarnings(response.text, warnings),
  };
}
