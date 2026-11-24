// The one place that owns the `applied_filters` echo — the self-describing
// narrowing both sgbr_search and sgbr_facet_values return so a client can
// round-trip a result → tweak one filter → resubmit. Building AND rendering it
// here keeps the two tools from drifting (the same goal filter-schema.js serves
// for the input surface). `filters` / range bounds are common to both tools;
// `scope` / `full_text_only` are echoed inside applied_filters only by
// sgbr_search — sgbr_facet_values carries them as separate top-level fields, so
// it opts out of `includeScope`.

import { FULLTEXT_ONLY_DIMENSION, RANGE_FILTERS, RANGE_KEYS } from '../config.js';

// What makes this narrowing clash with faceting `dim`, or null. A `filters`
// clause does — RDV drops it from its own dimension's aggregation, while `exclude`
// and the family-selected ranges (year included) narrow their own aggregation
// properly — and so does `full_text_only`, which compiles to the same clause on
// its dimension. An explicit filter wins as the cause: the cross-tab then lists
// the filter's own values rather than discovered ones.
export function clashCause(n, dim) {
  if (n?.filters?.[dim]?.length) return 'filters';
  if (dim === FULLTEXT_ONLY_DIMENSION && n?.full_text_only === true) return 'full_text_only';
  return null;
}
export const narrowsDimension = (n, dim) => clashCause(n, dim) != null;

// Build the applied_filters object from validated tool args, or undefined when
// nothing was narrowed (so the key is simply absent).
export function buildApplied(args, { includeScope = false } = {}) {
  const applied = {};
  if (includeScope) {
    if (args.scope && args.scope !== 'all') applied.scope = args.scope;
    if (args.full_text_only) applied.full_text_only = true;
  }
  if (args.filters && Object.keys(args.filters).length) applied.filters = args.filters;
  if (args.exclude && Object.keys(args.exclude).length) applied.exclude = args.exclude;
  for (const k of RANGE_KEYS) {
    if (args[k] != null) applied[k] = args[k];
  }
  return Object.keys(applied).length ? applied : undefined;
}

// One-line human-readable summary of that narrowing. Handles the search superset
// (scope / full_text_only) gracefully — those keys are simply absent for the
// facet caller, so their clauses are skipped.
export function renderApplied(a) {
  if (!a) return '';
  const parts = [];
  if (a.scope) parts.push(`scope=${a.scope}`);
  if (a.full_text_only) parts.push('full text only');
  for (const [k, v] of Object.entries(a.filters || {})) parts.push(`${k}=${v.join(' | ')}`);
  for (const [k, v] of Object.entries(a.exclude || {})) parts.push(`${k}≠${v.join(' | ')}`);
  for (const { lo, hi, label } of RANGE_FILTERS) {
    if (!hi) {
      if (a[lo] != null) parts.push(`${label} ≥ ${a[lo]}`);
    } else if (a[lo] != null || a[hi] != null) {
      parts.push(`${label} ${a[lo] ?? '…'}–${a[hi] ?? '…'}`);
    }
  }
  return parts.join('; ');
}
