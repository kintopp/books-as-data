// sgbr_autocomplete — type-ahead suggestions for titles, authors, and subjects.
// Suggestions are search phrases, not filter values — see lib/autocomplete.js.

import { z } from 'zod';
import { AUTOCOMPLETE_QUERY } from '../graphql/operations.js';
import { graphqlRequest } from '../graphql/client.js';
import { buildAutocompleteVariables } from '../search/compiler.js';
import { buildAutocompleteResponse } from '../lib/autocomplete.js';
import { detectQueryWarnings, withWarnings } from '../lib/warnings.js';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import {
  AUTOCOMPLETE_GROUPS, AUTOCOMPLETE_SCOPES,
  DEFAULT_AUTOCOMPLETE_LIMIT, MAX_AUTOCOMPLETE_LIMIT, MAX_QUERY_LEN,
  READ_ONLY_ANNOTATIONS,
} from '../config.js';

export const AUTOCOMPLETE_TOOL_NAME = 'sgbr_autocomplete';

const inputSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LEN).describe(
    'A partial term (prefix) to complete, e.g. "Burck". Matched against title/author/subject index terms.'
  ),
  scope: z.enum(AUTOCOMPLETE_SCOPES).default('all')
    .describe('Which suggestion group(s) to return: "all" (title + author + subject), or one of them.'),
  full_text_only: z.boolean().default(false)
    .describe('If true, suggest only from items that have machine-readable full text.'),
  limit: z.number().int().min(1).max(MAX_AUTOCOMPLETE_LIMIT).default(DEFAULT_AUTOCOMPLETE_LIMIT)
    .describe(`Max suggestions per group (max ${MAX_AUTOCOMPLETE_LIMIT}).`),
}).strict();

const description =
  'Complete a partial term into title, author, or subject search phrases. ' +
  'These are not filter values: author and subject suggestions come from a different vocabulary than ' +
  'filters.author / filters.subject_heading read, so as filters most return a clean zero and ' +
  'the rest match the wrong entity (a namesake, a printing house). Take filter values from ' +
  'sgbr_facet_values (for authors: facet="author", scope="author", the surname as query), ' +
  'which also ranks the most frequent name first — prefix-ranked suggestions can miss the ' +
  'dominant form entirely. ' +
  'Returns grouped suggestion lists, plus exact_term_records when scope is a single group ' +
  '(the backend reports no count for scope="all"): that counts records matching your query as a ' +
  'complete term, not the suggestions — a partial prefix scores 0 beside a full suggestion list, ' +
  'so never read it as "no records".';

// Output contract for structuredContent. `suggestions` carries only the groups
// the `scope` asked for (all three for "all", otherwise one), so each is optional.
export const outputSchema = z.object({
  query: z.string(),
  scope: z.enum(AUTOCOMPLETE_SCOPES),
  full_text_only: z.boolean(),
  // Records matching `query` as a whole indexed term — deliberately NOT a count
  // of the prefix or of the suggestions; see the shaper. null when unreported.
  exact_term_records: z.number().nullable(),
  suggestions: z.object({
    title: z.array(z.string()).optional(),
    author: z.array(z.string()).optional(),
    subject: z.array(z.string()).optional(),
  }),
  // Advisory notes about the prefix (same detector as sgbr_search); suggestions
  // were still matched against it verbatim. See src/lib/warnings.js.
  warnings: z.array(z.string()).optional(),
});

export function registerAutocompleteTool(server) {
  server.registerTool(
    AUTOCOMPLETE_TOOL_NAME,
    {
      title: AUTOCOMPLETE_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(AUTOCOMPLETE_TOOL_NAME, 'Autocomplete failed', async (args, ctx) => {
      const variables = buildAutocompleteVariables({
        query: args.query,
        scope: args.scope,
        fullTextOnly: args.full_text_only,
      });

      const data = await graphqlRequest(AUTOCOMPLETE_QUERY, variables, { signal: ctx?.mcpReq?.signal });
      const autocomplete = data?.autocomplete;
      if (!autocomplete) throw new ToolError('The autocomplete endpoint returned no data.');

      const groups = args.scope === 'all' ? Object.keys(AUTOCOMPLETE_GROUPS) : [args.scope];
      const shaped = buildAutocompleteResponse(autocomplete, {
        query: args.query,
        scope: args.scope,
        fullTextOnly: args.full_text_only,
        groups,
        limit: args.limit,
      });
      const { structured, text } = withWarnings(shaped, detectQueryWarnings(args.query));
      return { content: [{ type: 'text', text }], structuredContent: structured };
    }),
  );
}
