// sgbr_facet_breakdown — cross-tabulate two facet dimensions in one call. Runs
// two axis-discovery `facetFiltered` calls (for the row/column labels) plus one
// batched `stats` call that prices every cell exactly (rdv-stats-crosstab.md
// *(internal)*) — 3 calls total for a full N×M grid, vs. the N+1-call
// `sgbr_facet_values` fan-out (rdv-facet-breakdown.md *(internal)*) that
// remains the manual fallback.

import { z } from 'zod';
import { STATS_QUERY, FACET_FILTERED_QUERY } from '../graphql/operations.js';
import { graphqlRequest } from '../graphql/client.js';
import { buildFacetVariables, buildStatsCrosstabVariables } from '../search/compiler.js';
import { buildFacetResponse, hasValue } from '../lib/facet.js';
import { buildFacetBreakdownResponse, buildAxisMeta } from '../lib/facet_breakdown.js';
import { buildApplied, narrowsDimension } from '../lib/applied.js';
import {
  assertQuery, detectQueryWarnings, detectSameDimensionFacetWarnings, detectVocabularyWarnings, withWarnings,
} from '../lib/warnings.js';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import {
  filtersSchema, excludeSchema, appliedFiltersSchema, narrowingFrom, enrichmentDims,
  assertRanges, rangeInputs, FILTER_VALUES_HINT,
} from './filter-schema.js';
import {
  FACET_NAMES, FACET_DIMENSIONS, SCOPE_NAMES, MAX_QUERY_LEN,
  DEFAULT_CROSSTAB_AXIS_SIZE, MAX_CROSSTAB_AXIS_SIZE, MAX_CROSSTAB_CELLS,
  READ_ONLY_ANNOTATIONS,
} from '../config.js';

export const FACET_BREAKDOWN_TOOL_NAME = 'sgbr_facet_breakdown';

const facetList = FACET_NAMES.map((n) => `${n} (${FACET_DIMENSIONS[n].label})`).join(', ');

const inputSchema = z.object({
  facet: z.enum(FACET_NAMES).describe(
    `Row dimension. One of: ${facetList}. Must differ from \`breakdown\`; ` +
    '"year" and "object_type" are not supported as axes (see sgbr_facet_values / sgbr_search instead).'
  ),
  breakdown: z.enum(FACET_NAMES).describe(
    'Column dimension. Same set as `facet` (and the same "year"/"object_type" exclusion); must differ from `facet`.'
  ),
  query: z.string().max(MAX_QUERY_LEN).default('').describe(
    'Free-text query the grid is computed over (same symbolic-Lucene rules as sgbr_search; ' +
    'empty = whole corpus).'
  ),
  scope: z.enum(SCOPE_NAMES).default('all')
    .describe('Restrict the query to one field group (same as sgbr_search).'),
  full_text_only: z.boolean().default(false)
    .describe('If true, count only digitised items that have machine-readable full text.'),
  filters: filtersSchema.optional().describe(
    'Narrow the population the grid counts over, by dimension (same keys/values as sgbr_search). ' +
    `Values within one dimension are OR-ed; different dimensions AND. ${FILTER_VALUES_HINT} ` +
    `Note: ${enrichmentDims.join(', ')} are machine-derived enrichments, not catalogued data.`
  ),
  exclude: excludeSchema,
  ...rangeInputs,
  size: z.number().int().min(1).max(MAX_CROSSTAB_AXIS_SIZE).default(DEFAULT_CROSSTAB_AXIS_SIZE)
    .describe(`Max number of row values, the most frequent first (max ${MAX_CROSSTAB_AXIS_SIZE}).`),
  breakdown_size: z.number().int().min(1).max(MAX_CROSSTAB_AXIS_SIZE).default(DEFAULT_CROSSTAB_AXIS_SIZE)
    .describe(`Max number of column values, the most frequent first (max ${MAX_CROSSTAB_AXIS_SIZE}).`),
}).strict();

const description =
  'Cross-tabulate two dimensions into one exact grid of record counts. ' +
  'E.g. language × genre, or library × availability. Auto-discovers the top values of each ' +
  'dimension, then prices every cell exactly with batched `stats` calls — not a ' +
  'facet-bucket approximation. Each axis is a top-N grid, not a complete enumeration: only the ' +
  'top `size`/`breakdown_size` values appear, and `row_axis`/`col_axis` report ' +
  '`distinct_values`/`others_count`/`truncated` so an absent value is not read as absent from the ' +
  'corpus (raise the sizes, or use sgbr_facet_values for the full list of one dimension). ' +
  '`year` and `object_type` are not supported as axes; use sgbr_facet_values or sgbr_search ' +
  'filters for those.';

// Per-axis truncation metadata: a cross-tab only ever shows the top `size` values
// of each dimension, and the raw response otherwise gives no hint that more exist.
const axisOut = z.object({
  dimension: z.enum(FACET_NAMES),
  requested_size: z.number().int(),
  returned: z.number().int(),
  distinct_values: z.number().nullable(),
  others_count: z.number().int(),
  truncated: z.boolean(),
  same_dimension_filter: z.boolean().optional().describe(
    'Present (true) only when `filters` narrows this axis\'s own dimension, or `full_text_only` is set '
    + 'on an `availability` axis. RDV excludes a dimension\'s own filter from its own aggregation, so '
    + 'this axis lists the filter\'s own values rather than discovered ones (for `full_text_only`, the '
    + 'discovered values are un-narrowed), and per-row `total` is omitted. '
    + 'The grid\'s cells are unaffected — each ANDs its own axis clauses on top of the filter.',
  ),
});

// Output contract for structuredContent. Nested rows[].cells[] (NOT sgbr_facet_values'
// flat values[] — a cross-tab ships the whole grid as one payload). `total` on a row
// is that row's OWN facet-bucket count (from axis discovery), never a sum of its
// cells — string dimensions can be multi-valued per record, so cells may overlap.
// Axis discovery would inherit RDV's exclude-own-filter aggregation, so a filtered
// axis lists the filter's own values and omits its row totals; its cells stay exact.
// `row_axis`/`col_axis` report whether each axis was capped (top-N, not a complete
// enumeration) so a caller doesn't read an absent value as absent from the corpus.
export const outputSchema = z.object({
  facet: z.enum(FACET_NAMES),
  breakdown: z.enum(FACET_NAMES),
  query: z.string(),
  scope: z.enum(SCOPE_NAMES),
  full_text_only: z.boolean(),
  row_axis: axisOut,
  col_axis: axisOut,
  rows: z.array(z.object({
    value: z.union([z.string(), z.number()]).nullable(),
    gnd_id: z.string().optional(),
    total: z.number().nullable().optional(),
    cells: z.array(z.object({
      value: z.union([z.string(), z.number()]).nullable(),
      gnd_id: z.string().optional(),
      count: z.number(),
    })),
  })),
  applied_filters: appliedFiltersSchema.optional(),
  warnings: z.array(z.string()).optional(),
});

// Dimensions not supported as a cross-tab axis: `year` needs range buckets, not
// value filters; `object_type` has read/write asymmetry (facet returns stored German
// values, the filter path expects friendly keys).
const UNSUPPORTED_AXES = new Set(['year', 'object_type']);

const STATS_MAX_ATTEMPTS = 4;

// A narrowed grid can come back with real counts under the wrong cell names
// (a backend defect; see buildStatsCrosstabVariables). A one-cell call has only
// one name to give, so a grid of up to SMALL_GRID_CELLS is counted cell by cell.
// A larger one is trusted once two calls agree cell for cell having listed the
// cells in orders that differ by more than a rotation or a reflection: a mislabel
// that follows submission position looks the same under either. Verification
// reads bypass the response cache: a cached copy of an earlier attempt would
// "agree" with itself.
// An un-narrowed grid has never mislabelled, so its single call stays cached.
const SMALL_GRID_CELLS = 3;

// Does order `b` differ from order `a` by only a rotation or a reflection?
function dihedralTo(a, b) {
  const n = a.length;
  const at = new Map(a.map((v, i) => [v, i]));
  const rel = b.map((v) => at.get(v));
  const step = (sign) => rel.every((v, i) => v === (((rel[0] + sign * i) % n) + n) % n);
  return step(1) || step(-1);
}

// The identity, then deterministic shuffles that each differ from it by more than
// a rotation or reflection (always possible from four cells up).
function verificationOrders(n, count) {
  const identity = [...Array(n).keys()];
  const orders = [identity];
  let seed = 1;
  const rand = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  while (orders.length < count) {
    const p = [...identity];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    if (!dihedralTo(identity, p)) orders.push(p);
  }
  return orders;
}

async function fetchStatsCells(vars, { signal }) {
  const narrowed = vars.queryFilters.some((c) => c.inFilter.length > 2);
  const n = vars.queryFilters.length;
  const request = async (queryFilters, cache) => {
    const result = (await graphqlRequest(STATS_QUERY, { ...vars, queryFilters }, { signal, cache }))?.stats?.statsResult;
    if (!result) throw new ToolError('The stats endpoint returned no data for the cross-tab grid.');
    return result;
  };
  if (!narrowed || n === 1) return request(vars.queryFilters, true);
  if (n <= SMALL_GRID_CELLS) {
    return (await Promise.all(vars.queryFilters.map((cell) => request([cell], true)))).flat();
  }
  const orders = verificationOrders(n, STATS_MAX_ATTEMPTS);
  const attempt = async (k) => ({ order: orders[k], result: await request(orders[k].map((i) => vars.queryFilters[i]), false) });
  const key = (result) => result.map((r) => `${r?.name}=${r?.countResult?.resultCount}`).sort().join(',');
  const seen = new Map(); // grid → the orders that produced it
  const results = await Promise.all([attempt(0), attempt(1)]);
  for (let k = 2; ; k++) {
    for (const { order, result } of results.splice(0)) {
      const id = key(result);
      const prior = seen.get(id) ?? [];
      if (prior.some((o) => !dihedralTo(o, order))) return result;
      seen.set(id, [...prior, order]);
    }
    if (k >= STATS_MAX_ATTEMPTS) break;
    results.push(await attempt(k));
  }
  throw new ToolError(
    `The stats endpoint returned no two grids that agree across ${STATS_MAX_ATTEMPTS} calls for the same cross-tab, ` +
    'so its cell counts cannot be trusted.',
    'Retry, or count the cells with sgbr_facet_values (one dimension filtered, the other faceted).',
  );
}

export function registerFacetBreakdownTool(server) {
  server.registerTool(
    FACET_BREAKDOWN_TOOL_NAME,
    {
      title: FACET_BREAKDOWN_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(FACET_BREAKDOWN_TOOL_NAME, 'Facet breakdown failed', async (args, ctx) => {
      assertQuery(args);
      assertRanges(args);
      const signal = ctx?.mcpReq?.signal;

      if (args.facet === args.breakdown) {
        throw new ToolError(
          `\`facet\` and \`breakdown\` must differ (both were "${args.facet}").`,
          'Pick two different dimensions — a dimension crossed with itself is meaningless.',
        );
      }
      for (const [role, dim] of [['facet', args.facet], ['breakdown', args.breakdown]]) {
        if (UNSUPPORTED_AXES.has(dim)) {
          throw new ToolError(
            `\`${role}\`="${dim}" is not supported as a cross-tab axis.`,
            dim === 'year'
              ? 'Use sgbr_facet_values (facet="year") or sgbr_search year_from/year_to for year breakdowns.'
              : 'Use sgbr_facet_values (facet="object_type") or sgbr_search filters.object_type instead.',
          );
        }
      }
      // RDV drops a dimension's own `filters` clause from its own aggregation, so
      // a filtered axis's discovered top-N is corpus-wide and may not even contain
      // the values filtered on. Its cells AND the filter anyway; list the filter's
      // own values instead, with no discovery call.
      const rowOwn = args.filters?.[args.facet]?.length ? args.filters[args.facet] : null;
      const colOwn = args.filters?.[args.breakdown]?.length ? args.filters[args.breakdown] : null;
      const rowCount = rowOwn?.length ?? args.size;
      const colCount = colOwn?.length ?? args.breakdown_size;
      const cellCount = rowCount * colCount;
      if (cellCount > MAX_CROSSTAB_CELLS) {
        throw new ToolError(
          `Requested grid is ${rowCount}×${colCount} = ${cellCount} cells, over the ${MAX_CROSSTAB_CELLS}-cell limit.`,
          rowOwn || colOwn
            ? 'Lower `size` and/or `breakdown_size`, or filter on fewer values of the filtered axis.'
            : 'Lower `size` and/or `breakdown_size`.',
        );
      }

      const narrowing = narrowingFrom(args);
      // `applied` rides along purely so each axis shaper can flag a
      // same-dimension clash the same way sgbr_facet_values does — one detection
      // site, so the two tools cannot disagree about what counts as one.
      const applied = buildApplied(args);

      const discoverAxis = async (role, dim, size, own) => {
        if (own) {
          return {
            values: own.map((value) => ({ value })), distinct_values: own.length, others_count: 0,
            same_dimension_filter: narrowsDimension(applied, dim),
          };
        }
        const data = await graphqlRequest(FACET_FILTERED_QUERY, buildFacetVariables({
          query: args.query, scope: args.scope, fullTextOnly: args.full_text_only,
          facet: dim, size, ...narrowing,
        }), { signal });
        const facet = data?.facetFiltered;
        if (!facet) throw new ToolError(`The facet endpoint returned no data for ${role}="${dim}".`);
        return buildFacetResponse(facet, {
          name: dim, query: args.query, scope: args.scope, fullTextOnly: args.full_text_only, applied,
        }).structured;
      };
      const [rowStructured, colStructured] = await Promise.all([
        discoverAxis('facet', args.facet, args.size, rowOwn),
        discoverAxis('breakdown', args.breakdown, args.breakdown_size, colOwn),
      ]);

      // A null/empty axis bucket cannot be narrowed on: buildDimensionFilters
      // drops falsy values, so such a bucket's cells would silently count only
      // the OTHER dimension — an inflated number presented as exact. This is
      // REACHABLE, not hypothetical: `content_flags` carries an empty bucket at
      // rank 13, inside any `size` above 12. Drop the bucket, say so in a
      // warning, and let the compiler's two-clause cell assertion backstop
      // anything that slips by.
      // Carry each axis's own bucket totals so the grid can report that it shows
      // only the top `size`/`breakdown_size` values, not every value that exists.
      // Meta is computed over the KEPT values so `returned` matches the grid.
      // Dropped buckets leave `distinct_values` too, or an empty-label bucket
      // would read as unshown values.
      const axisWarnings = [];
      const keepLabelled = (dim, size, structured) => {
        const values = structured.values.filter(hasValue);
        const dropped = structured.values.length - values.length;
        if (dropped) {
          axisWarnings.push(
            `Dropped ${dropped} "${dim}" axis value(s) with an empty label — ` +
            'they cannot be filtered on, so their cells would have counted the other dimension only.',
          );
        }
        const distinct = structured.distinct_values == null ? null : structured.distinct_values - dropped;
        return { values, meta: buildAxisMeta(dim, size, { ...structured, values, distinct_values: distinct }) };
      };
      const { values: rowValues, meta: rowAxis } = keepLabelled(args.facet, args.size, rowStructured);
      const { values: colValues, meta: colAxis } = keepLabelled(args.breakdown, args.breakdown_size, colStructured);

      // A pinned-vocabulary filter on a value the backend has renamed narrows the
      // population to nothing, so an axis comes back empty and the generic advice
      // sends the model off broadening the query instead of re-checking the value.
      // Same detector sgbr_search and sgbr_facet_values use; an empty axis is this
      // tool's zero-result case, since it computes no separate hit count to test.
      const [staleVocabulary] = detectVocabularyWarnings(args, 0);
      const emptyAxisAdvice = staleVocabulary
        ? `${staleVocabulary} Otherwise, try a broader query or fewer filters.`
        : 'Try a broader query or fewer filters.';
      if (!rowValues.length) {
        throw new ToolError(`No values for dimension "${args.facet}" over this query.`, emptyAxisAdvice);
      }
      if (!colValues.length) {
        throw new ToolError(`No values for dimension "${args.breakdown}" over this query.`, emptyAxisAdvice);
      }

      const statsVars = buildStatsCrosstabVariables({
        query: args.query, scope: args.scope, fullTextOnly: args.full_text_only,
        facet: args.facet, breakdown: args.breakdown, rowValues, colValues, ...narrowing,
      });
      const statsResult = await fetchStatsCells(statsVars, { signal });

      const shaped = buildFacetBreakdownResponse({
        facet: args.facet, breakdown: args.breakdown, query: args.query, scope: args.scope,
        fullTextOnly: args.full_text_only, rowValues, colValues, statsResult,
        rowAxis, colAxis, applied,
      });
      // With both axes filtered nothing is discovered, so a stale value surfaces
      // only as an all-zero grid, never as the empty axis handled above.
      const gridEmpty = shaped.structured.rows.every((r) => r.cells.every((c) => c.count === 0));
      const { structured, text } = withWarnings(shaped, [
        ...(gridEmpty ? detectVocabularyWarnings(args, 0) : []),
        ...detectQueryWarnings(args.query),
        ...detectSameDimensionFacetWarnings(args, [args.facet, args.breakdown], 'axis'),
        ...axisWarnings,
      ]);
      return { content: [{ type: 'text', text }], structuredContent: structured };
    }),
  );
}
