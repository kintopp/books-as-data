// Shapes an RDV `Facet` (from facetFiltered) into normalized {value, count}
// rows and renders the text channel. Handles the three value-union members the
// exposed dimensions produce: strings (strVal, "strings:"-prefixed), authors
// (label + GND identifier), and years (timeRange → single year).

import { narrowsDimension, renderApplied } from './applied.js';
import { FACET_DIMENSIONS } from '../config.js';

// A dimension the index has no value for is not always ABSENT from the record: some
// dimensions store an empty string instead, which faceting returns as a bucket of
// its own and counts in `nbTotal`. `object_type` does (roughly 40% of records carry
// an empty type), as does `content_flags`; `genre` omits absent records properly.
//
// One predicate, two callers with different stakes: here it keeps coverage_pct
// from reporting 100% for a dimension nothing can be filtered by, and in
// sgbr_facet_breakdown it drops an axis bucket whose cells would silently count
// the other dimension only. They must agree on what "no value" looks like.
export const hasValue = (v) => v.value != null && v.value !== '';

// Exported so src/lib/facet_breakdown.js can reuse the exact same union-member
// normalization for cross-tab axis values, rather than drifting a copy.
export function shapeValue(v) {
  switch (v.__typename) {
    case 'FacetValueString':
      return { value: (v.strVal || '').replace(/^strings:/, ''), count: v.count };
    case 'FacetValueInt':
      return { value: v.intVal, count: v.count };
    case 'FacetValueLabelIdentifier': {
      const row = { value: v.label, count: v.count };
      const id = v.identifier?.[0];
      // Named gnd_id (not `id`) so the generic `id` key keeps meaning "record id"
      // everywhere in the API surface.
      if (id) row.gnd_id = id; // GND, e.g. (DE-588)11851752X
      return row;
    }
    case 'FacetValueTimeRange':
      return { value: v.startTime ? Number(v.startTime.slice(0, 4)) : null, count: v.count };
    default:
      return { value: null, count: v.count ?? 0 };
  }
}

export function buildFacetResponse(facet, { name, query, scope, fullTextOnly, total = null, applied }) {
  let values = (facet.values || []).map(shapeValue);
  // The daterange facet ignores `size` (returns every year bucket) and puts the
  // total doc count — not bucket cardinality — in `count`. Present years
  // chronologically and derive the distinct count from the buckets themselves.
  // Under a year range the buckets still count every year a matching record's
  // date span covers, so they spill outside the window; the in-window ones are
  // exact per-year counts, so keep only those.
  const isYear = name === 'year';
  if (isYear) {
    const from = applied?.year_from ?? -Infinity;
    const to = applied?.year_to ?? Infinity;
    values = values
      .filter((v) => v.value != null && v.value >= from && v.value <= to)
      .sort((a, b) => a.value - b.value);
  }

  // Enrichment coverage: what fraction of the query's hits carry this dimension.
  // A trust signal — a facet covering 9% of hits should be read more cautiously
  // than one at 100%. Matches the front-end's "% covered" indicator.
  //
  // Suppressed for multi-valued dimensions. `nbTotal` counts VALUE occurrences,
  // so a record carrying two `scan_source` values is counted twice and the ratio
  // exceeds 100% — a coverage figure that reads as a confidence signal while
  // being arithmetically meaningless. null (with the integrity warning that fires
  // alongside it) is the honest answer; the raw counts are still reported.
  //
  // Empty-valued records (see hasValue) are subtracted from BOTH the numerator
  // and the reported `matching_records`, so the ratio answers "how many hits can
  // I actually read off this dimension". Detectable only when such a bucket is
  // inside the returned window — a small `size` can leave it unseen, which
  // degrades to the backend's own inflated figure, not to a differently-wrong one.
  // Summed, not first-found, because facet_breakdown drops EVERY no-value bucket
  // and the two readings of hasValue have to agree.
  const noValue = values.filter((v) => !hasValue(v));
  const absent = noValue.length ? noValue.reduce((sum, v) => sum + (v.count ?? 0), 0) : null;
  const multiValued = Boolean(FACET_DIMENSIONS[name]?.multiValued);
  // The second coverage suppressor, and the more dangerous one. RDV excludes a
  // dimension's own filter clause from that dimension's own aggregation, so
  // faceting `name` while filtering it returns COLLECTION-WIDE buckets while
  // `query_total` stays correctly narrowed. The ratio then divides two different
  // populations, and because matching >> total it lands on coveragePercent's
  // `matching >= total → 100` branch — the maximum trust signal on the one
  // response that has earned none. Detected off what the caller actually sent:
  // `applied` plus `fullTextOnly`, which `applied` deliberately does not echo.
  const sameDimensionFilter = narrowsDimension({ ...applied, full_text_only: fullTextOnly }, name);
  // NOT subtracted for a multi-valued dimension: there `nbTotal` counts value
  // OCCURRENCES, so taking a record count off it mixes two units, and pulling the
  // total under `query_total` would silence the over-sum warning that is the only
  // signal those buckets don't add up. Nothing is lost — coverage_pct is null
  // there anyway, and absent_records is still reported.
  const matching = facet.nbTotal != null
    ? facet.nbTotal - (multiValued ? 0 : (absent ?? 0))
    : null;
  const coveragePct = (!multiValued && !sameDimensionFilter && matching != null && total)
    ? coveragePercent(matching, total)
    : null;

  const structured = {
    facet: name,
    query,
    scope,
    full_text_only: fullTextOnly,
    distinct_values: isYear ? values.length : (facet.count ?? null), // total buckets for this dimension
    matching_records: matching, // docs carrying a real value of this dimension
    absent_records: absent, // docs indexed with an empty value (null if none seen)
    query_total: total, // all hits for the query (null if the count call failed)
    coverage_pct: coveragePct, // matching_records / query_total, as a percentage
    multi_valued: multiValued, // a record may sit in several buckets; buckets over-sum
    // This dimension is BOTH filtered and faceted, so the buckets above (and
    // matching_records / distinct_values / others_count) ignore that filter.
    same_dimension_filter: sameDimensionFilter,
    returned: values.length,
    others_count: isYear ? 0 : (facet.othersCount ?? 0), // docs in buckets beyond `returned`
    values,
  };
  if (applied) structured.applied_filters = applied; // self-describing narrowing
  return { structured, text: renderFacetText(structured) };
}

// One decimal, so an integer share still prints as an integer — but never round
// a partial coverage to a whole 100 (or a non-empty one to 0). "100%" is exactly
// the claim a trust signal must not make falsely: 3,566 of 3,575 is 99.7, and
// displaying it as 100 is what makes a real gap invisible at a glance.
function coveragePercent(matching, total) {
  if (matching >= total) return 100;
  if (matching <= 0) return 0;
  return Math.min(99.9, Math.max(0.1, Math.round((matching / total) * 1000) / 10));
}

// What fills the coverage slot: a real figure, or else the reason there isn't
// one. The two suppressors both null coverage_pct and can co-occur (a filtered
// content_flags facet is multi-valued too), so the same-dimension case leads —
// it is the one that makes the counts describe a different population, not just
// a different unit.
function coverageNote(s) {
  if (s.same_dimension_filter) {
    return ' — but these buckets IGNORE this dimension\'s own filter (RDV excludes it from its own '
      + 'aggregation); your query and every other filter still scope them, this one does not';
  }
  if (s.coverage_pct != null) {
    return ` (${s.coverage_pct}% of ${s.query_total.toLocaleString('en-US')} hits carry this dimension)`;
  }
  if (s.multi_valued) return ' (a record may carry several values, so bucket counts over-sum the record total)';
  return '';
}

function renderFacetText(s) {
  const scopeNote = s.scope && s.scope !== 'all' ? `, scope: ${s.scope}` : '';
  const q = s.query ? `"${s.query}"` : '(all records)';
  const distinct = s.distinct_values != null ? s.distinct_values.toLocaleString('en-US') : '?';
  const docs = s.matching_records != null ? s.matching_records.toLocaleString('en-US') : '?';
  const coverage = coverageNote(s);
  const lines = [
    `Facet "${s.facet}" for query ${q}${scopeNote} — ${distinct} distinct value(s) ` +
    `across ${docs} record(s)${coverage}; showing ${s.returned}${s.facet === 'year' ? ' (chronological)' : ' (most frequent first)'}:`,
  ];
  const narrowing = renderApplied(s.applied_filters);
  if (narrowing) lines.push(`Narrowed by: ${narrowing}`);
  if (s.absent_records) {
    // Only claim the exclusion where there IS a coverage figure to exclude them
    // from — a multi-valued dimension reports none, and still counts them.
    const excluded = s.coverage_pct != null ? ' excluded from the coverage above, and' : '';
    lines.push(
      `${s.absent_records.toLocaleString('en-US')} record(s) are indexed with an EMPTY value ` +
      `for this dimension —${excluded} unreachable by any filter on it, ` +
      'so a value\'s absence here is not evidence about those records.',
    );
  }
  lines.push('');
  for (const v of s.values) {
    const idNote = v.gnd_id ? `  [${v.gnd_id}]` : '';
    // Blank prints as nothing at all; name the bucket so it reads as a finding.
    const label = hasValue(v) ? v.value : '(no value recorded)';
    lines.push(`  ${v.count.toLocaleString('en-US').padStart(9)}  ${label}${idNote}`);
  }
  if (s.others_count) {
    lines.push('', `(+${s.others_count.toLocaleString('en-US')} record(s) in other values — raise \`size\` to see more.)`);
  }
  return lines.join('\n');
}
