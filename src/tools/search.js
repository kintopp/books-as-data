// sgbr_search — the primary tool: faceted relevance search over the corpus.

import { z } from 'zod';
import { SEARCH_QUERY } from '../graphql/operations.js';
import { graphqlRequest } from '../graphql/client.js';
import { buildSearchVariables } from '../search/compiler.js';
import { buildSearchResponse, pastEndWarnings, pastResultWindow, shortPageWarnings } from '../lib/record.js';
import { buildApplied } from '../lib/applied.js';
import { assertQuery, detectQueryWarnings, detectVocabularyWarnings, withWarnings } from '../lib/warnings.js';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import {
  filtersSchema, excludeSchema, appliedFiltersSchema, narrowingFrom, enrichmentDims,
  assertRanges, rangeInputs, FILTER_VALUES_HINT,
} from './filter-schema.js';
import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_RESULT_WINDOW, MAX_QUERY_LEN,
  SCOPE_NAMES, SORT_NAMES, DEFAULT_SORT, READ_ONLY_ANNOTATIONS, IMAGE_DESCRIPTION_NOTE,
} from '../config.js';

export const SEARCH_TOOL_NAME = 'sgbr_search';

const inputSchema = z.object({
  query: z.string().max(MAX_QUERY_LEN).default('').describe(
    'Free-text query over the "Books as Data" corpus (~1.07M records, mostly German). ' +
    'Operators: bare terms AND; a|b OR; -term excludes (also -"phrase", -stem*); "exact phrase"; ' +
    '"a b"~N (proximity); term~1 (fuzzy; a bare term~ allows two edits, looser still); trailing * ' +
    'stem (Karte*). The backend never ' +
    'errors on misuse. This server refuses a query wrapped in parentheses (read as empty → whole ' +
    'corpus); everything else is forwarded as written, including forms that silently mis-search: ' +
    'parentheses elsewhere are stripped, mid-word ?/* wildcards return 0 in title/author/subject ' +
    'scope and an unrelated set in full text (use term~1 or OR the spellings), ' +
    'and the words AND/OR/NOT and field:value are literal text (warned). Empty query matches everything.'
  ),
  scope: z.enum(SCOPE_NAMES).default('all')
    .describe(
      'Restrict the query to one field group: all (default), title, author, subject, call_number, ' +
      'fulltext, image_description (the AI descriptions of foldout plates — German, one sentence each), ' +
      'or identifier (an exact MMS id like 991104550959705501 or scan id like UBBS-00173645; a partial ' +
      'id returns 0, and a scan id of a multivolume or multi-copy work also returns that parent work).'
    ),
  full_text_only: z.boolean().default(false)
    .describe(
      'If true, only return digitised items with machine-readable full text. A shortcut for the ' +
      'matching `filters.availability` values — prefer it over spelling one out, since the backend ' +
      'renames them between releases and this flag tracks every spelling.'
    ),
  filters: filtersSchema.optional().describe(
    'Narrow the result set by dimension. Values within one dimension are OR-ed; different ' +
    `dimensions are AND-ed. ${FILTER_VALUES_HINT} Note: ${enrichmentDims.join(', ')} are ` +
    'machine-derived enrichments (rule-based or AI), not catalogued data.'
  ),
  exclude: excludeSchema,
  ...rangeInputs,
  sort: z.enum(SORT_NAMES).default(DEFAULT_SORT).describe(
    'Result ordering: "relevance" (default, best match first — the only ordering that makes ' +
    'snippets meaningful), "year_asc"/"year_desc" by publication date, or "title_asc"/"title_desc" ' +
    'by title. Use a catalogue sort to find the earliest/latest or to page a set alphabetically; ' +
    'keep relevance when the query is a research question rather than an enumeration.'
  ),
  page: z.number().int().min(1).default(1).describe('1-based page number.'),
  page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE)
    .describe(`Results per page (max ${MAX_PAGE_SIZE}).`),
}).strict();

// Output contract for structuredContent. We declare it and echo the applied
// filters as `applied_filters`, so a client can round-trip a result → tweak one
// filter → resubmit without reparsing text.
const recordOut = z.object({
  id: z.string(),
  title: z.string().optional(),
  authors: z.array(z.string()).optional(),
  date: z.string().optional(),
  place: z.string().optional(),
  language: z.array(z.string()).optional().describe('Every language the record carries; each one is a `filters.language` value.'),
  resource_type: z.string().optional(),
  availability: z.string().optional(),
  full_text_available: z.boolean().optional(),
  call_number: z.string().optional(),
  image_description: z.string().optional().describe(IMAGE_DESCRIPTION_NOTE),
  snippets: z.array(z.string()).optional(),
});
// applied_filters echoes the (already-validated) request params verbatim, so its
// schema is the same shapes the input uses — reused, not re-derived, to stay in
// lockstep with the filter registry and range bounds.
const appliedOut = appliedFiltersSchema.extend({
  scope: z.enum(SCOPE_NAMES).optional(),
  full_text_only: z.boolean().optional(),
});
export const outputSchema = z.object({
  total: z.number().int(),
  page: z.number().int(),
  page_size: z.number().int(),
  // Ordering is not a narrowing, so it rides here rather than in applied_filters
  // (which round-trips the filter surface). Always echoed, including the default.
  sort: z.enum(SORT_NAMES),
  returned: z.number().int(),
  has_more: z.boolean().describe('More records match than this page and the ones before it hold.'),
  next_page: z.number().int().nullable().describe(
    'The page to request next, or null — also while has_more is true, when the next page lies past the ' +
    'backend\'s result window (narrow the query to reach those records) or this page came back short ' +
    '(a warning says how to continue).'
  ),
  results: z.array(recordOut),
  applied_filters: appliedOut.optional(),
  parsed_error: z.string().optional(),
  // Advisory notes about the query itself (e.g. AND/OR/NOT or field:value used as
  // if they were operators) — the query still ran verbatim. See src/lib/warnings.js.
  warnings: z.array(z.string()).optional(),
});

const description =
  'Read sgbr_guide before your first search. ' +
  'Search records by relevance across full text and catalogue metadata. ' +
  'Each hit returns title, author, date, place, language, type, availability, and an `id` to pass to ' +
  'sgbr_get_record. Narrow with `filters` (library, language, genre, object_type/foldouts, …), ' +
  'a `year_from`/`year_to` range, `scope` (title/author/subject/call_number/fulltext/image_description/identifier), or `full_text_only`. ' +
  'For object type (work/multivolume/volume/foldout), filter with `filters.object_type` or survey with sgbr_facet_values — ' +
  'hits do not carry it; their `availability` tells a fold-out plate from a book.';

// Reject a page whose window runs past the backend's result window, before it
// reaches the backend as an opaque error. Elasticsearch compares `from + size` (NOT
// `from` alone) against max_result_window, so this tests the window's LAST result
// index — page × page_size. A test on `from` would admit any page_size that doesn't
// divide MAX_RESULT_WINDOW: `from` lands just under the window with `from + size`
// just over it (page 334 × size 30 → from 9990, last index 10020). Exported (like
// filter-schema's assertRanges) so both sides of the boundary are unit-testable
// without a network call.
export function assertPageWindow({ page, page_size: pageSize }) {
  if (pastResultWindow(page, pageSize)) {
    const lastIndex = page * pageSize;
    throw new ToolError(
      `That page is too deep: page ${page} × size ${pageSize} = ${lastIndex} results, ` +
      `past the backend's ~${MAX_RESULT_WINDOW}-result window.`,
      'Narrow the query with more terms or filters, or use a smaller page number.',
    );
  }
}

export function registerSearchTool(server) {
  server.registerTool(
    SEARCH_TOOL_NAME,
    {
      title: SEARCH_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(SEARCH_TOOL_NAME, 'Search failed', async (args, ctx) => {
      assertQuery(args);
      assertRanges(args);
      assertPageWindow(args);
      const { page, page_size: pageSize } = args;

      const variables = buildSearchVariables({
        query: args.query,
        scope: args.scope,
        fullTextOnly: args.full_text_only,
        ...narrowingFrom(args),
        page,
        pageSize,
        sort: args.sort,
      });

      const data = await graphqlRequest(SEARCH_QUERY, variables, { signal: ctx?.mcpReq?.signal });
      const search = data?.search;
      if (!search) throw new ToolError('The search endpoint returned no data.');

      const shaped = buildSearchResponse(search, {
        page, pageSize, sort: args.sort, applied: buildApplied(args, { includeScope: true }),
      });
      const warnings = [
        ...detectQueryWarnings(args.query),
        ...detectVocabularyWarnings(args, shaped.structured.total),
        ...shortPageWarnings(shaped.structured),
        ...pastEndWarnings(shaped.structured),
      ];
      const { structured, text } = withWarnings(shaped, warnings);
      return { content: [{ type: 'text', text }], structuredContent: structured };
    }),
  );
}
