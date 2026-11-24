// sgbr_get_record — fetch one record's full detail by id (get(id)): full
// bibliographic metadata, IIIF manifest, full-text links, CSL-JSON citation,
// and GND/GeoNames authorities.

import { z } from 'zod';
import { GET_RECORD_QUERY } from '../graphql/operations.js';
import { graphqlRequest } from '../graphql/client.js';
import { buildRecordResponse, isEmptyRecord, MULTI_SCAN_KINDS } from '../lib/detail.js';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { READ_ONLY_ANNOTATIONS, IMAGE_DESCRIPTION_NOTE } from '../config.js';

export const GET_RECORD_TOOL_NAME = 'sgbr_get_record';

const inputSchema = z.object({
  id: z.string().min(1).describe(
    'The record id, exactly as returned in the `id` field of an sgbr_search result ' +
    '(e.g. "id991104550959705501_UBBS-00173645").'
  ),
}).strict();

const description =
  'Expand one search-result `id` into that record\'s complete detail. ' +
  'Returns full bibliographic metadata, a ready-to-use CSL-JSON citation, the IIIF manifest URL, ' +
  'full-text and bulk-download links, thumbnail, license, and GND/GeoNames authorities. It is the hub between ' +
  'search and the page tools: `digital.scan_id` is what sgbr_get_fulltext, sgbr_locate_text, ' +
  'sgbr_get_page_ocr and sgbr_inspect_image address. A record listing several scans shows them as ' +
  '`digital.scan_ids`: pass one of those, since the other page tools refuse its id and sgbr_locate_text ' +
  'searches only the first. A record without a scan id (often partner-scanned) ' +
  'cannot be read or viewed page by page whatever its availability says; `viewer_url` is the citable ' +
  'link. Per-page media lists are summarised to counts and a license, not enumerated, and no page ' +
  'text is returned. A fold-out plate `id` returns the plate\'s record, whose `scan_id` is its parent ' +
  'volume\'s. An unknown id is an error result, not an empty record.';

// Output contract for structuredContent. The shaper (`src/lib/detail.js`) prunes
// empty values, so almost every field is `.optional()`; only the id/title anchors
// are guaranteed. The schema is non-strict (the SDK preserves unmodeled keys), so
// the freeform CSL-JSON blob is kept permissive rather than enumerated.
const authorityOut = z.object({ type: z.string(), url: z.string() });
const agentOut = z.object({
  name: z.string(),
  roles: z.array(z.string()).optional(),
  authorities: z.array(authorityOut).optional(),
});
const digitalOut = z.object({
  scan_id: z.string().optional(),
  scan_ids: z.array(z.string()).optional().describe(
    `Every scan this record lists, when there is more than one (${MULTI_SCAN_KINDS}). ` +
    'sgbr_get_fulltext, sgbr_get_page_ocr and sgbr_inspect_image refuse this record\'s id; pass one of these as ' +
    'scan_id. sgbr_locate_text accepts it but searches only the first.'
  ),
  full_text_available: z.boolean().optional(),
  iiif_manifest: z.string().optional(),
  thumbnail: z.string().optional(),
  full_text_url: z.string().optional(),
  persistent_urn: z.string().optional(),
  ark: z.string().optional().describe('Persistent citable id (ark:24630/…); Google-scanned volumes only.'),
  ark_url: z.string().optional(),
  processed_on: z.string().optional().describe(
    'Date of the image/OCR run being served. Google re-processes volumes and only the latest run is ' +
    'kept, so page text and numbering quoted from this record are tied to this date.'
  ),
  file_count: z.string().optional(),
  // Whole-volume bulk downloads (page scans / OCR), when the backend offers them.
  scans_zip_url: z.string().optional(),
  ocr_zip_url: z.string().optional(),
  license: z.object({ label: z.string(), url: z.string().optional() }).optional(),
  access: z.union([z.string(), z.array(z.string())]).optional(),
  scanned_at: z.string().optional(),
});
const citationOut = z.object({
  csl: z.record(z.string(), z.any()).optional(), // freeform CSL-JSON
  formatted: z.string().optional(),
  note: z.string().optional(), // replaces csl/formatted when the record is size-capped
});
export const outputSchema = z.object({
  id: z.string(),
  title: z.string(),
  authors: z.array(agentOut).optional(),
  date: z.string().optional(),
  place: z.string().optional(),
  publisher: z.string().optional(),
  origin: z.string().optional(),
  language: z.array(z.string()).optional().describe('Every language the record carries; each one is a `filters.language` value.'),
  resource_type: z.string().optional(),
  // The availability class string (Digitalisat (Volltext) / kein Digitalisat /
  // Digitalisat (extern) / Falttafel) — mirrors sgbr_search; distinguishes the
  // three non-full-text classes that `digital.full_text_available` collapses.
  // Discover the live values with sgbr_facet_values facet="availability" rather
  // than hard-coding them: the backend renames this vocabulary between releases.
  availability: z.string().optional(),
  extent: z.string().optional(),
  image_description: z.string().optional().describe(IMAGE_DESCRIPTION_NOTE),
  subjects: z.array(z.string()).optional(),
  classification: z.object({
    topic: z.array(z.string()).optional(),
    subject_area: z.array(z.string()).optional(),
  }).optional(),
  series: z.array(z.string()).optional(),
  table_of_contents: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  call_number: z.string().optional(),
  holding: z.string().optional(),
  record_identifier: z.string().optional(),
  viewer_url: z.string().optional(),
  digital: digitalOut.optional(),
  citation: citationOut.optional(),
  truncated: z.boolean().optional(),
});

export function registerGetRecordTool(server) {
  server.registerTool(
    GET_RECORD_TOOL_NAME,
    {
      title: GET_RECORD_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(GET_RECORD_TOOL_NAME, 'Record lookup failed', async (args, ctx) => {
      const id = args.id.trim();
      if (!id) {
        throw new ToolError(
          'Provide a record `id`.',
          'Use the id from an sgbr_search result (the `id` field).',
        );
      }
      const data = await graphqlRequest(
        GET_RECORD_QUERY,
        { id },
        { signal: ctx?.mcpReq?.signal },
      );
      const record = data?.get;
      if (isEmptyRecord(record)) {
        throw new ToolError(
          `No record found for id "${id}".`,
          'Check the id — it must be a full record id from an sgbr_search result (the `id` field).',
        );
      }

      const { structured, text } = buildRecordResponse(record);
      return { content: [{ type: 'text', text }], structuredContent: structured };
    }),
  );
}
