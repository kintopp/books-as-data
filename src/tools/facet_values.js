// sgbr_facet_values — values + counts for one facet dimension, scoped to a
// query (facetFiltered). Answers "which libraries / languages / years / authors
// / topics exist for this search, and how many records each."

import { z } from 'zod';
import { FACET_FILTERED_QUERY, SEARCH_QUERY } from '../graphql/operations.js';
import { graphqlRequest } from '../graphql/client.js';
import { buildFacetVariables, buildSearchVariables } from '../search/compiler.js';
import { buildFacetResponse } from '../lib/facet.js';
import { buildApplied } from '../lib/applied.js';
import {
  assertQuery, buildFacetIntegrityWarnings, detectQueryWarnings, detectSameDimensionFacetWarnings,
  detectVocabularyWarnings, withWarnings,
} from '../lib/warnings.js';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import {
  filtersSchema, excludeSchema, appliedFiltersSchema, narrowingFrom, enrichmentDims,
  assertRanges, rangeInputs, FILTER_VALUES_HINT,
} from './filter-schema.js';
import {
  FACET_NAMES, FACET_DIMENSIONS, SCOPE_NAMES, DEFAULT_FACET_SIZE, MAX_FACET_SIZE, MAX_QUERY_LEN,
  READ_ONLY_ANNOTATIONS,
} from '../config.js';

export const FACET_VALUES_TOOL_NAME = 'sgbr_facet_values';

const facetList = FACET_NAMES.map((n) => `${n} (${FACET_DIMENSIONS[n].label})`).join(', ');

const inputSchema = z.object({
  facet: z.enum(FACET_NAMES).describe(
    `Which dimension to break down. One of: ${facetList}.`
  ),
  query: z.string().max(MAX_QUERY_LEN).default('').describe(
    'Free-text query the facet is computed over (same symbolic-Lucene rules as sgbr_search; ' +
    'empty = whole corpus). Counts match what sgbr_search would return for the same query/scope.'
  ),
  scope: z.enum(SCOPE_NAMES).default('all')
    .describe('Restrict the query to one field group (same as sgbr_search).'),
  full_text_only: z.boolean().default(false)
    .describe('If true, count only digitised items that have machine-readable full text.'),
  filters: filtersSchema.optional().describe(
    'Narrow the population the facet counts over, by dimension (same keys/values as sgbr_search). ' +
    `Values within one dimension are OR-ed; different dimensions AND. ${FILTER_VALUES_HINT} ` +
    `Note: ${enrichmentDims.join(', ')} are machine-derived enrichments, not catalogued data.`
  ),
  exclude: excludeSchema,
  ...rangeInputs,
  year_from: rangeInputs.year_from.describe(
    `${rangeInputs.year_from.description} With facet="year" the buckets are trimmed to the range.`,
  ),
  size: z.number().int().min(1).max(MAX_FACET_SIZE).default(DEFAULT_FACET_SIZE)
    .describe(`Max number of values to return, the most frequent first (max ${MAX_FACET_SIZE}). Ignored for "year", which always returns the full per-year distribution in chronological order.`),
}).strict();

const description =
  'Read sgbr_guide before your first search. ' +
  'Break a query down by one dimension, returning each value with its count. ' +
  'Dimensions include library, language, publication year, author, genre, and topic. ' +
  'Counts are scoped to the query (and any `filters` / ranges) so they agree with sgbr_search. ' +
  'The year facet is an overlapping density profile; if warnings appear, verify exact totals with sgbr_search. ' +
  'Facet one dimension while filtering on another to build a cross-tab slice. ' +
  'Some dimensions (notably object_type) store "no value" as an empty bucket: those records are ' +
  'reported as absent_records, excluded from coverage_pct, and cannot be reached by a filter on ' +
  'that dimension — so read a value\'s absence as evidence only across matching_records.';

// Output contract for structuredContent. All keys are always present; the count
// fields are nullable (a failed/omitted total yields null), as is a value (the
// year facet can produce a null bucket). `gnd_id` (a GND authority identifier)
// is author-only.
export const outputSchema = z.object({
  facet: z.enum(FACET_NAMES),
  query: z.string(),
  scope: z.enum(SCOPE_NAMES),
  full_text_only: z.boolean(),
  distinct_values: z.number().nullable(),
  matching_records: z.number().nullable(),
  // Records the index stores with an EMPTY value for this dimension rather than
  // omitting it — excluded from matching_records/coverage_pct, and unreachable
  // by any filter on this dimension. Detected from the RETURNED values, so the
  // `.describe()` is load-bearing: null means "none among them", not a
  // guarantee, and a bucket ranked below `size` would leave coverage_pct high.
  absent_records: z.number().nullable().describe(
    'Records indexed with an empty value for this dimension: excluded from matching_records and '
    + 'coverage_pct, and unreachable by any filter on it. null = no such bucket among the returned '
    + 'values — if others_count is high, raise `size` before trusting a 100% coverage_pct.',
  ),
  query_total: z.number().nullable(),
  coverage_pct: z.number().nullable(),
  // True when one record can carry several values of this dimension, so the
  // buckets sum above query_total and coverage_pct is deliberately null.
  multi_valued: z.boolean(),
  same_dimension_filter: z.boolean().describe(
    'True when the SAME dimension being faceted is also narrowed by `filters`. RDV excludes a '
    + 'dimension\'s own filter from its own aggregation, so values[], matching_records, distinct_values and '
    + 'others_count are then counted as if that filter were unset: your query still scopes them, '
    + 'this dimension no longer does, so they are not the intersection you asked for. '
    + 'coverage_pct is null for this reason. query_total, and every other dimension\'s '
    + 'narrowing, remain correct; to intersect two values of one dimension use inclusion-exclusion '
    + 'over sgbr_search (A + B - union).',
  ),
  returned: z.number(),
  others_count: z.number(),
  values: z.array(z.object({
    value: z.union([z.string(), z.number()]).nullable(),
    count: z.number(),
    gnd_id: z.string().optional(),
  })),
  // Echoes the dimension `filters` / ranges this count was narrowed by (scope
  // and full_text_only are already top-level), so a caller can round-trip a slice
  // → tweak → resubmit. Omitted when no narrowing was applied.
  applied_filters: appliedFiltersSchema.optional(),
  // Advisory notes about query syntax or facet integrity; the counts were still
  // computed over the query verbatim. See src/lib/warnings.js.
  warnings: z.array(z.string()).optional(),
});

export function registerFacetValuesTool(server) {
  server.registerTool(
    FACET_VALUES_TOOL_NAME,
    {
      title: FACET_VALUES_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(FACET_VALUES_TOOL_NAME, 'Facet lookup failed', async (args, ctx) => {
      assertQuery(args);
      assertRanges(args);
      const signal = ctx?.mcpReq?.signal;
      const narrowing = narrowingFrom(args);
      const facetVars = buildFacetVariables({
        query: args.query,
        scope: args.scope,
        fullTextOnly: args.full_text_only,
        facet: args.facet,
        size: args.size,
        ...narrowing,
      });
      // In parallel, count the query's total hits so we can report enrichment
      // coverage (matching_records / total). It must apply the SAME narrowing as
      // the facet, or coverage_pct would compare against the wrong denominator.
      // Best-effort: a failed/omitted count just yields a null coverage rather
      // than failing the whole tool.
      const countVars = buildSearchVariables({
        query: args.query, scope: args.scope, fullTextOnly: args.full_text_only,
        ...narrowing, page: 1, pageSize: 0,
      });
      const [data, total] = await Promise.all([
        graphqlRequest(FACET_FILTERED_QUERY, facetVars, { signal }),
        graphqlRequest(SEARCH_QUERY, countVars, { signal }).then((d) => d?.search?.totalCount ?? null).catch(() => null),
      ]);
      const facet = data?.facetFiltered;
      if (!facet) throw new ToolError('The facet endpoint returned no data.');

      const shaped = buildFacetResponse(facet, {
        name: args.facet,
        query: args.query,
        scope: args.scope,
        fullTextOnly: args.full_text_only,
        total,
        applied: buildApplied(args),
      });
      const warnings = [
        ...detectQueryWarnings(args.query),
        ...detectVocabularyWarnings(args, total),
        ...detectSameDimensionFacetWarnings(args, [args.facet]),
        ...buildFacetIntegrityWarnings(args, shaped.structured),
      ];
      const { structured, text } = withWarnings(shaped, warnings);
      return { content: [{ type: 'text', text }], structuredContent: structured };
    }),
  );
}
