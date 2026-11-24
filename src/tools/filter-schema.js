// Shared zod schema for the `filters` object + the range bounds, so every tool
// that narrows a query (sgbr_search, sgbr_facet_values, sgbr_facet_breakdown)
// exposes the SAME surface, driven off the FACET_DIMENSIONS and RANGE_FILTERS
// registries. Building this once here is what keeps their narrowing from
// drifting apart.

import { z } from 'zod';
import {
  FILTER_DIMENSIONS, FACET_DIMENSIONS, MAX_FILTER_VALUES_PER_DIMENSION, DATERANGE_MAX_YEAR,
  RANGE_FILTERS, RANGE_KEYS,
} from '../config.js';
import { ToolError } from '../lib/errors.js';

// Publication-year bound. Wider than the corpus (1700–1900) on purpose — the
// backend just range-filters, and a caller may legitimately probe the edges.
export const yearSchema = z.number().int().min(1000).max(2100);

// Every RANGE_FILTERS bound, spread into each narrowing tool's input schema.
// Each range is its own clause, so a record without the measure is dropped —
// hence the exclusion notes.
const pagesSchema = z.number().int().min(1).max(DATERANGE_MAX_YEAR);
export const rangeInputs = {
  year_from: yearSchema.optional()
    .describe('Only records published in or after this year (inclusive publication-date range).'),
  year_to: yearSchema.optional()
    .describe('Only records published in or before this year (inclusive publication-date range).'),
  pages_min: pagesSchema.optional().describe(
    'Only records with at least this many page images (a multivolume work counts all its volumes\'); '
    + 'records without scans are excluded.',
  ),
  pages_max: pagesSchema.optional().describe('Only records with at most this many page images (see pages_min).'),
  ocr_quality_min: z.number().int().min(0).max(100).optional().describe(
    'Only records whose OCR quality score (0–100, mostly 90–95) is at least this; records without '
    + 'their own scan (multivolume parent works, metadata-only records) are excluded.',
  ),
};

// One telling of how filter VALUES are found, appended to the three
// filter-bearing tools' `filters` descriptions. The schemas are $ref-free, so
// filtersSchema is inlined once per tool in the model-facing catalogue —
// restating this inside every dimension's own description multiplied one
// sentence by sixty. Per-dimension descriptions carry only the label; don't
// re-add per-dimension boilerplate here.
export const FILTER_VALUES_HINT =
  'Dimension values are exact facet values — discover them with sgbr_facet_values '
  + 'facet=<dim> — except object_type, whose enum lists friendly keys.';

// Registry-driven `filters` object: one property per narrowable dimension, so
// the surface can't drift from FACET_DIMENSIONS. Values within a dimension OR;
// different dimensions AND. A dimension carrying a `valueMap` (e.g. object_type)
// takes that map's friendly keys; every other dimension takes exact facet values
// (discoverable via sgbr_facet_values).
const filterProps = {};
for (const dim of FILTER_DIMENSIONS) {
  const { label, valueMap } = FACET_DIMENSIONS[dim];
  const values = valueMap
    ? z.array(z.enum(Object.keys(valueMap))).min(1).max(MAX_FILTER_VALUES_PER_DIMENSION)
    : z.array(z.string().min(1).max(200)).min(1).max(MAX_FILTER_VALUES_PER_DIMENSION);
  // The valueMap caveat stays per-dimension (it is the one place the friendly
  // key ↔ raw label mismatch can bite); the key list itself lives in the enum.
  const how = valueMap
    ? ' Facets show the raw labels; filters take these friendly keys.'
    : '';
  filterProps[dim] = values.optional().describe(`Filter by ${label}.${how}`);
}
export const filtersSchema = z.object(filterProps).strict();

// `exclude` takes the same dimension → values shape as `filters`. The
// stale-value caveat matters more here than for `filters`: a value matching
// nothing excludes nothing, the result looks like success, and the zero-result
// warning can never fire for it.
export const excludeSchema = filtersSchema.optional().describe(
  'Drop records carrying ANY of these values, per dimension (same keys and exact values as '
  + '`filters`). Unlike a filter it keeps records with no value for that dimension, e.g. the '
  + 'untyped records filters.object_type can never reach. A misspelled value silently excludes '
  + 'nothing — take values from sgbr_facet_values.',
);

// Output twin of the narrowing inputs: the applied_filters echo built by
// src/lib/applied.js#buildApplied. sgbr_search extends it with scope/full_text_only.
export const appliedFiltersSchema = z.object({
  filters: filtersSchema.optional(),
  exclude: filtersSchema.optional(),
  ...rangeInputs,
});

// Tool args → the compiler's narrowing options, so a new narrowing argument is
// forwarded by all three tools or by none.
export const narrowingFrom = (args) => ({
  filters: args.filters,
  exclude: args.exclude,
  ...Object.fromEntries(RANGE_KEYS.map((k) => [k, args[k]])),
});

// Machine-derived dimensions, called out in each tool's `filters` description so
// callers know these are enrichments rather than catalogued data.
export const enrichmentDims = FILTER_DIMENSIONS.filter((d) => FACET_DIMENSIONS[d].enrichment);

// Reject an inverted range before it reaches the backend: the compiler turns each
// bound pair into an Elasticsearch date range whose start is after its end, and the
// backend answers with an opaque HTTP 400 ("all shards failed") that a caller cannot
// self-correct from. A handler-level guard rather than a zod .refine(): it keeps the
// registered input schemas plain `.strict()` objects, and it matches how the tools'
// sibling cross-field checks (facet ≠ breakdown, the cross-tab cell cap) already
// surface — as actionable ToolErrors. Every tool taking the ranges (sgbr_search,
// sgbr_facet_values, sgbr_facet_breakdown) must call this first.
export function assertRanges(args = {}) {
  for (const { lo, hi } of RANGE_FILTERS) {
    if (hi && args[lo] != null && args[hi] != null && args[lo] > args[hi]) {
      throw new ToolError(
        `\`${lo}\` (${args[lo]}) exceeds \`${hi}\` (${args[hi]}), so the range matches nothing.`,
        'Swap the two bounds — the range is inclusive on both ends.',
      );
    }
  }
}
