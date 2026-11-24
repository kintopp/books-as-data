// sgbr_get_fulltext — retrieve the plain OCR full text of a digitised book, one
// bounded character window at a time (a whole book is ~650k chars), or a span of
// scan pages marked page by page. Accepts a record `id` (scan id resolved
// automatically) or a `scan_id` directly.

import { z } from 'zod';
import { fetchFullText, fullTextUrl, FullTextError } from '../fulltext/client.js';
import { fetchOcrPageTexts, findLastOcrPage } from '../ocr/client.js';
import { resolveScanTarget } from '../lib/resolve.js';
import { buildFullTextResponse, joinPages } from '../lib/fulltext.js';
import { viewerUrl } from '../lib/image.js';
import { withTool } from '../lib/tool.js';
import { progressReporter } from '../lib/progress.js';
import { ToolError } from '../lib/errors.js';
import {
  DEFAULT_FULLTEXT_MAX_CHARS, MAX_FULLTEXT_MAX_CHARS, MAX_FULLTEXT_PAGE_SPAN, READ_ONLY_ANNOTATIONS,
} from '../config.js';

export const GET_FULLTEXT_TOOL_NAME = 'sgbr_get_fulltext';

const inputSchema = z.object({
  id: z.string().min(1).optional().describe(
    'Record id from an sgbr_search result. The tool resolves its scan id automatically. ' +
    'Provide this OR scan_id.'
  ),
  scan_id: z.string().min(1).optional().describe(
    'Scan id from sgbr_get_record (`digital.scan_id`, e.g. "UBBS-00190048"). Use it to skip ' +
    'the id→scan lookup. Provide this OR id.'
  ),
  page_from: z.number().int().min(1).optional().describe(
    'Read from this scan page (the numbering sgbr_locate_text, sgbr_get_page_ocr and the viewer\'s ' +
    '?page=N use) instead of the whole book. Each page is marked `--- page N ---`.'
  ),
  page_to: z.number().int().min(1).optional().describe(
    `Last scan page to read (inclusive; defaults to page_from; at most ${MAX_FULLTEXT_PAGE_SPAN} pages ` +
    'per call). Requires page_from.'
  ),
  offset: z.number().int().min(0).default(0).describe(
    '0-based character offset into the full text (or into the page span). Use the `next_offset` ' +
    'from a prior call to page forward.'
  ),
  max_chars: z.number().int().min(500).max(MAX_FULLTEXT_MAX_CHARS).default(DEFAULT_FULLTEXT_MAX_CHARS)
    .describe(`Max characters to return in this window (${DEFAULT_FULLTEXT_MAX_CHARS} default, ${MAX_FULLTEXT_MAX_CHARS} max). The window snaps to a word boundary.`),
}).strict();

const description =
  'Read one item\'s OCR full text in paged character windows. ' +
  'Books are large, so page forward with `offset`/`next_offset`, or read a span of scan pages with ' +
  '`page_from`/`page_to`. Identify the item by record `id` ' +
  '(from sgbr_search) or `scan_id` (from sgbr_get_record). Text is uncorrected OCR, often Fraktur, ' +
  'so expect recognition errors. A fold-out plate `id` is refused: a plate is one page and its ' +
  'scan_id is the parent volume\'s, so read the plate\'s own lettering with sgbr_get_page_ocr, or ' +
  'pass the parent `scan_id` here to read the whole volume deliberately.';

// Output contract for structuredContent. All keys always present; `id` is null when
// the item was addressed by scan_id, `next_offset` is null on the last page. The
// page fields are null when the whole book was read; `last_page` is set only when
// the requested span ran past the volume's end; `viewer_url` is set only for a page
// span read through a record `id` (it deep-links the window's first page).
export const outputSchema = z.object({
  scan_id: z.string(),
  id: z.string().nullable(),
  page_from: z.number().nullable(),
  page_to: z.number().nullable(),
  // The pages this window holds text from; narrower than the span once it is paged by offset.
  window_page_from: z.number().nullable(),
  window_page_to: z.number().nullable(),
  last_page: z.number().nullable(),
  viewer_url: z.string().nullable(),
  source_url: z.string(),
  total_chars: z.number(),
  offset: z.number(),
  returned_chars: z.number(),
  next_offset: z.number().nullable(),
  has_more: z.boolean(),
  ocr_note: z.string(),
  text: z.string(),
});

// Reject a malformed page span before any request: page_to alone, an inverted
// span, or one over the cap. Handler-level, like the narrowing tools' range
// guard, so the input schema stays a plain `.strict()` object.
export function assertPageSpan({ page_from: from, page_to: to } = {}) {
  if (to == null) return;
  if (from == null) {
    throw new ToolError('`page_to` needs `page_from`.', `Pass page_from too (e.g. page_from: ${to} for that one page).`);
  }
  if (to < from) {
    throw new ToolError(
      `\`page_from\` (${from}) exceeds \`page_to\` (${to}), so the span holds no pages.`,
      'Swap the two bounds — the span is inclusive on both ends.',
    );
  }
  if (to - from + 1 > MAX_FULLTEXT_PAGE_SPAN) {
    throw new ToolError(
      `Pages ${from}–${to} are ${to - from + 1} pages; at most ${MAX_FULLTEXT_PAGE_SPAN} are read per call.`,
      `Request pages ${from}–${from + MAX_FULLTEXT_PAGE_SPAN - 1}, then continue from page ${from + MAX_FULLTEXT_PAGE_SPAN}.`,
    );
  }
}

const noFullText = (scanId) => new ToolError(
  `No full text is available for scan "${scanId}".`,
  'Check the scan id (sgbr_get_record\'s digital.scan_id) and the record\'s `availability`: only `Digitalisat (Volltext)` records carry OCR text here.',
);

async function readWholeBook(scanId, signal) {
  const { text: full, url } = await fetchFullText(scanId, { signal }).catch((err) => {
    // An unknown scan answers 400 ("Files for scan_id not found"), not 404.
    if (err instanceof FullTextError && (err.status === 400 || err.status === 404)) throw noFullText(scanId);
    throw err;
  });
  if (!full) throw noFullText(scanId);
  return { full, url };
}

async function readPages(scanId, from, to, { signal, report }) {
  const span = to - from + 1;
  const pages = await fetchOcrPageTexts(scanId, from, to, {
    signal,
    onSettled: (n) => report(n, span, `Read ${n} of ${span} pages`),
  });
  if (!pages.length) {
    const last = await findLastOcrPage(scanId, from, { signal });
    if (!last) throw noFullText(scanId);
    throw new ToolError(
      `Page ${from} is past the end of scan "${scanId}", which has ${last} page(s).`,
      `Request a span within pages 1–${last}.`,
    );
  }
  const pageTo = pages.at(-1).page;
  return {
    full: joinPages(pages),
    // The whole-book text the span is cut from: the per-page assets it was read
    // from concatenate to exactly that text.
    url: fullTextUrl(scanId),
    pageFrom: from,
    pageTo,
    lastPage: pageTo < to ? pageTo : null,
  };
}

export function registerGetFullTextTool(server) {
  server.registerTool(
    GET_FULLTEXT_TOOL_NAME,
    {
      title: GET_FULLTEXT_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(GET_FULLTEXT_TOOL_NAME, 'Full-text retrieval failed', async (args, ctx) => {
      const signal = ctx?.mcpReq?.signal;
      assertPageSpan(args);
      const { scanId, recordId } = await resolveScanTarget(args, {
        signal,
        // NOT allowDerivedScan: this tool reads a WHOLE scan, and the parent
        // volume's full text is not what a single plate stands for. But when the
        // refusal is a plate, say so — the flat hint below would otherwise send
        // the model to sgbr_get_record only to confirm "no" a second time.
        missing: {
          what: 'has no digitised full text',
          hint: 'Confirm digital.full_text_available with sgbr_get_record first.',
          derived: ({ scanId: parentScan, page }) => ({
            what: 'is a fold-out plate, so it has no full text of its own',
            hint:
              `It is page ${page} of scan "${parentScan}". Call sgbr_get_page_ocr with this id to ` +
              `read the plate's own OCR (its page is automatic), or sgbr_inspect_image to view it. ` +
              `For the parent volume's text, call again with scan_id "${parentScan}" (add ` +
              `page_from: ${page} for just that page).`,
          }),
        },
      });

      const read = args.page_from != null
        ? await readPages(scanId, args.page_from, args.page_to ?? args.page_from, {
          signal, report: progressReporter(ctx),
        })
        : await readWholeBook(scanId, signal);

      const { structured, text } = buildFullTextResponse({
        scanId, recordId, offset: args.offset, maxChars: args.max_chars, ...read,
        viewerUrlFor: (page) => viewerUrl(recordId, page),
      });
      return { content: [{ type: 'text', text }], structuredContent: structured };
    }),
  );
}
