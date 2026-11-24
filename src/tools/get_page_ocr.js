// sgbr_get_page_ocr — fetch one page's OCR text and layout regions (line/word/
// block boxes with pixel + percent coordinates) from IIIF hOCR. Accepts a record
// `id` (scan id resolved automatically) or a `scan_id` directly. Closes the
// search → record → locate text on page → crop-and-verify loop: `region_pct`
// feeds directly into sgbr_inspect_image.

import { z } from 'zod';
import { fetchOcrAsset, fetchOcrPageText } from '../ocr/client.js';
import { resolveScanTarget, attributedRecordId } from '../lib/resolve.js';
import { ocrAssetUrl, parseHocr, buildPageOcrResponse } from '../lib/ocr.js';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { DEFAULT_OCR_MAX_REGIONS, MAX_OCR_MAX_REGIONS, READ_ONLY_ANNOTATIONS } from '../config.js';

export const GET_PAGE_OCR_TOOL_NAME = 'sgbr_get_page_ocr';

const inputSchema = z.object({
  id: z.string().min(1).optional().describe(
    'Record id from an sgbr_search result. Resolves its scan id automatically. Provide this OR scan_id.'
  ),
  scan_id: z.string().min(1).optional().describe(
    'Scan id from sgbr_get_record (`digital.scan_id`, e.g. "ZBZ-00123359"). Skips the id→scan lookup. ' +
    'Provide this OR id.'
  ),
  page: z.number().int().min(1).optional().describe(
    'Scanned-image page, 1-based (same axis as the viewer\'s ?page=N and sgbr_inspect_image `page`). ' +
    'Omit only for a fold-out plate `id`, which supplies its own plate page; every other address ' +
    'requires it. Passing a page other than a plate\'s own reads the parent volume instead, so the ' +
    'response `id` is null (that page is not what the plate record stands for).'
  ),
  level: z.enum(['page', 'block', 'line', 'word']).default('line').describe(
    'Granularity of returned regions. "line" (default) balances detail and size; "word" can be large; ' +
    '"page" returns only the page box + counts.'
  ),
  include_text: z.boolean().default(true).describe(
    'Also fetch the plain per-page OCR text (reading order). Set false to skip the extra fetch.'
  ),
  max_regions: z.number().int().min(1).max(MAX_OCR_MAX_REGIONS).default(DEFAULT_OCR_MAX_REGIONS).describe(
    `Cap on regions returned (default ${DEFAULT_OCR_MAX_REGIONS}, max ${MAX_OCR_MAX_REGIONS}). Excess ` +
    'regions are dropped in document order; the "truncated" flag reports when this happened.'
  ),
}).strict();

const description =
  'Get one page\'s OCR text and layout regions (line/word boxes). ' +
  'Fetches IIIF hOCR for a single page and parses it into block/line/word regions, each with a pixel ' +
  '`bbox_px` and a `region_pct` — the latter is ready to pass straight to sgbr_inspect_image\'s ' +
  '`region_pct` argument to crop and visually verify that exact spot on the page. Also returns the ' +
  'page\'s plain OCR text (reading order) unless `include_text` is false. Text is uncorrected OCR, ' +
  'often Fraktur, so expect recognition errors. Identify the page by record `id` or `scan_id` plus a ' +
  '`page`; a fold-out plate `id` needs no `page` (it resolves to its own plate page, so a map or ' +
  'table\'s printed lettering can be read directly). If you do not yet know which page, use ' +
  'sgbr_locate_text to find the page(s) a phrase appears on first.';

// Output contract for structuredContent. All keys always present; `id`/`text_url`/
// `viewer_url` are null when not applicable (scan_id-only path, or include_text
// false).
const regionSchema = z.object({
  type: z.enum(['page', 'block', 'line', 'word']),
  text: z.string(),
  bbox_px: z.array(z.number()).length(4),
  confidence: z.number().nullable(),
  region_pct: z.array(z.number()).length(4),
});

export const outputSchema = z.object({
  scan_id: z.string(),
  id: z.string().nullable(),
  page: z.number(),
  level: z.enum(['page', 'block', 'line', 'word']),
  hocr_url: z.string(),
  text_url: z.string().nullable(),
  page_width: z.number(),
  page_height: z.number(),
  counts: z.object({ blocks: z.number(), lines: z.number(), words: z.number() }),
  regions: z.array(regionSchema),
  returned_regions: z.number(),
  truncated: z.boolean(),
  // Why regions were dropped (null when not truncated): 'max_regions' = the
  // count cap bit — raise max_regions to see more; 'result_budget' = the
  // serialized-size budget bit — raising max_regions won't help; request a
  // coarser level or include_text:false instead.
  truncation_reason: z.enum(['max_regions', 'result_budget']).nullable(),
  ocr_note: z.string(),
  text: z.string(),
  viewer_url: z.string().nullable(),
});

export function registerGetPageOcrTool(server) {
  server.registerTool(
    GET_PAGE_OCR_TOOL_NAME,
    {
      title: GET_PAGE_OCR_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(GET_PAGE_OCR_TOOL_NAME, 'Page OCR retrieval failed', async (args, ctx) => {
      const signal = ctx?.mcpReq?.signal;
      const { scanId, recordId, page: platePage } = await resolveScanTarget(args, {
        signal,
        // A fold-out plate carries no scan id of its own, but its id encodes
        // {parentScan}_{page} — and the per-page hOCR at that address is the plate's
        // own lettering. Page-addressed, so unlike the whole-scan tools this lands
        // ON the plate, not around it.
        allowDerivedScan: true,
        missing: {
          what: 'has no digitised page OCR',
          hint: 'Confirm digital.scan_id is present via sgbr_get_record first.',
        },
      });

      const page = args.page ?? platePage;
      if (!page) {
        throw new ToolError(
          'Provide a `page`.',
          'Only a fold-out plate id carries its own page; for any other record or a scan_id, pass the ' +
          '1-based page — sgbr_locate_text finds which page a phrase is on.',
        );
      }
      const attributedId = attributedRecordId({ recordId, page: platePage }, page);

      const hocrUrl = ocrAssetUrl(scanId, page, 'hocr');
      const html = await fetchOcrAsset(hocrUrl, { signal });
      const parsed = parseHocr(html);

      if (!parsed.pageWidth || !parsed.counts.words) {
        throw new ToolError(
          `No OCR layout found for scan "${scanId}" page ${page}.`,
          'This page may be image-only (no OCR), out of range, or not yet processed. Try sgbr_inspect_image ' +
          'to view the page, or sgbr_get_fulltext for flat OCR text.',
        );
      }

      let plainText = '';
      let textUrl = null;
      if (args.include_text) {
        try {
          const got = await fetchOcrPageText(scanId, page, { signal });
          if (got.exists) {
            plainText = got.text;
            textUrl = ocrAssetUrl(scanId, page, 'text');
          }
        } catch { /* leave plainText/textUrl at their defaults on a text-fetch miss */ }
      }

      const { structured, text } = buildPageOcrResponse({
        scanId, recordId: attributedId, page, parsed, plainText,
        level: args.level, maxRegions: args.max_regions, hocrUrl, textUrl,
      });
      return { content: [{ type: 'text', text }], structuredContent: structured };
    }),
  );
}
