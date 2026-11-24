// sgbr_inspect_image — fetch a bounded page image (a map, a plate, a cover) so
// the model can visually inspect it. Accepts a record `id` (scan id resolved
// automatically) or a `scan_id` directly. One page per call, size-bounded —
// no bulk image dump; an optional `region_pct` crops to part of the page.

import { z } from 'zod';
import { fetchImage, fetchImageInfo, ImageError } from '../image/client.js';
import { resolveScanTarget, attributedRecordId } from '../lib/resolve.js';
import {
  imageUrl, imageInfoUrl, regionPixelDims, buildImageResponse, pctSeg, viewerLine,
} from '../lib/image.js';
import { resolveDeliveryEdge } from '../lib/vision.js';
import { detectImageSizingWarnings, mirrorWarnings } from '../lib/warnings.js';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import {
  DEFAULT_IMAGE_LONG_EDGE, MIN_IMAGE_LONG_EDGE, MAX_IMAGE_LONG_EDGE, READ_ONLY_ANNOTATIONS,
} from '../config.js';

export const INSPECT_IMAGE_TOOL_NAME = 'sgbr_inspect_image';

const inputSchema = z.object({
  id: z.string().min(1).optional().describe(
    'Record id from an sgbr_search result. The tool resolves its scan id automatically. ' +
    'Provide this OR scan_id.'
  ),
  scan_id: z.string().min(1).optional().describe(
    'Scan id from sgbr_get_record (`digital.scan_id`, e.g. "UBBS-00190048"). Use it to skip ' +
    'the id→scan lookup. Provide this OR id.'
  ),
  page: z.number().int().min(1).optional().describe(
    'Scanned-image page to fetch, 1-based (the same axis as the viewer\'s `?page=N` deep ' +
    'link). Defaults to 1 — except a foldout/Falttafel record addressed by `id`, whose own ' +
    'plate page is resolved automatically (override by passing `page`). Note the thumbnail ' +
    'page shown by sgbr_get_record is often a different, editorially-chosen "representative ' +
    'page" — request the page you actually want.'
  ),
  region_pct: z.array(z.number().min(0).max(100)).length(4)
    // ≥ 0.01, not > 0: the URL builder rounds pct coordinates to 2 decimals, so a
    // width of e.g. 0.004 would pass a plain > 0 check and still round to a
    // zero-area region — which the server 400s on.
    .refine((r) => r[2] >= 0.01 && r[3] >= 0.01, { message: 'region_pct width and height must be >= 0.01' })
    // x/y at the right/bottom edge give a crop with zero effective area: the server
    // clamps the overhang, leaving nothing (x=100 is a deterministic HTTP 500 that
    // would also burn the retry loop). Checked on the ROUNDED value — 99.999 rounds
    // to 100 in the URL behind a raw < 100 check's back. Overhang with x/y INSIDE
    // the page (e.g. [95,0,10,10]) is fine — the server clips it to the boundary and
    // returns the partial crop.
    .refine((r) => pctSeg(r[0]) < 100 && pctSeg(r[1]) < 100, {
      message: 'region_pct x and y must be < 100 — a crop starting at the right/bottom page edge has zero area',
    })
    .optional()
    .describe(
      'Optional sub-region crop as percentages of the full page: [x, y, width, height], ' +
      'top-left origin. E.g. [0, 85, 30, 15] = the bottom-left corner (good for reading a ' +
      'printed page number cheaply), [25, 25, 50, 50] = the centre. Omit for the whole page. ' +
      'The crop is delivered at its own scanned resolution, never enlarged, so a small ' +
      'region arrives small and cheap — prefer a crop over a full page whenever you only ' +
      'need part of it.'
    ),
  max_long_edge: z.number().int().min(MIN_IMAGE_LONG_EDGE).max(MAX_IMAGE_LONG_EDGE).default(DEFAULT_IMAGE_LONG_EDGE)
    .describe(
      `Upper bound on the image's longest edge in pixels (${MIN_IMAGE_LONG_EDGE}-` +
      `${MAX_IMAGE_LONG_EDGE}, default ${DEFAULT_IMAGE_LONG_EDGE} = the largest that reaches you ` +
      'undownscaled). This is a ceiling, not a target: the image is also capped at the ' +
      "region's own scanned resolution, so a small crop arrives small (and cheap) no matter " +
      'what you pass here. Request smaller only for frugality; to see more detail, change ' +
      'region_pct, not this.'
    ),
}).strict();

const description =
  'Fetch one page image and inspect it yourself for the user. ' +
  'Returns image bytes for your own visual analysis. The client may also show the image to the ' +
  'user; that is expected, so neither avoid the call nor try to hide or comment on the image ' +
  'for that reason. To link the user to the page itself, give the result\'s viewer_url when ' +
  'present. Best for inherently ' +
  'visual material (e.g. maps, plates, music notation) or to sanity-check unreliable OCR from ' +
  'sgbr_get_fulltext. Identify the page by record `id` or `scan_id` plus a `page`; if the user pastes ' +
  'a viewer link `.../detail/{id}?page={n}`, extract `{id}` and `{n}`. ' +
  'Pass region_pct to crop to part of the page (e.g. a page-number corner or one figure of a ' +
  'plate) at a fraction of the payload — those region_pct values can come straight from ' +
  'sgbr_get_page_ocr\'s or sgbr_locate_text\'s layout regions. A crop is delivered at its own ' +
  'scanned resolution, so a word-sized region arrives small and cheap; when you need more ' +
  'detail, widen region_pct rather than raising max_long_edge — only a larger region carries ' +
  'more pixels. ' +
  'A non-error result is the page image itself (the pixels are included; see byte_size): describe ' +
  'what you see in it. A fetch failure arrives as an explicit error result, never as an empty image.';

// Output contract for structuredContent (the base64 image bytes ride in the
// `content` channel, not here). `id`/`viewer_url` are null on the scan_id-only
// path, where no record id was resolved.
export const outputSchema = z.object({
  scan_id: z.string(),
  id: z.string().nullable(),
  page: z.number(),
  // The box that was requested after clamping — an upper bound. The delivered_*
  // pair is what actually arrived; they differ when the server rounds.
  long_edge: z.number(),
  delivered_width: z.number().nullable(),
  delivered_height: z.number().nullable(),
  visual_tokens: z.number().nullable(),
  region_pct: z.array(z.number()).nullable(),
  mime_type: z.string(),
  byte_size: z.number(),
  source_url: z.string(),
  viewer_url: z.string().nullable(),
  warnings: z.array(z.string()).optional(),
});

export function registerInspectImageTool(server) {
  server.registerTool(
    INSPECT_IMAGE_TOOL_NAME,
    {
      title: INSPECT_IMAGE_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(INSPECT_IMAGE_TOOL_NAME, 'Image inspection failed', async (args, ctx) => {
      const signal = ctx?.mcpReq?.signal;
      const { scanId, recordId, page: derivedPage } = await resolveScanTarget(args, {
        signal,
        allowDerivedScan: true,
        missing: {
          what: 'has no digitised images',
          hint: 'Confirm digital.scan_id is present via sgbr_get_record first.',
        },
      });
      // Honour an explicit `page`; otherwise use a foldout's auto-resolved plate
      // page, and fall back to page 1 for an ordinary scan.
      const page = args.page ?? derivedPage ?? 1;
      const attributedId = attributedRecordId({ recordId, page: derivedPage }, page);

      // Solve the delivery size before asking for pixels. The mediaserver honours
      // `!N,N` downward but UPSCALES a region smaller than the box — despite its own
      // info.json advertising no `sizeUpscaling` — so without this a word-sized
      // region_pct is interpolated up to a full-page payload carrying no more
      // information (cost: see MAX_IMAGE_LONG_EDGE in config.js). info.json is the
      // only source of the native size, and a page that has none must still be
      // fetchable, so a null skips the clamp rather than blocking the call.
      const info = await fetchImageInfo(imageInfoUrl({ scanId, page }), { signal });
      const region = regionPixelDims(args.region_pct, info?.width, info?.height);
      const { edge, boundBy } = resolveDeliveryEdge(
        args.max_long_edge, region.width, region.height,
      );
      const warnings = detectImageSizingWarnings({
        boundBy,
        requested: args.max_long_edge,
        edge,
        regionWidth: region.width,
        regionHeight: region.height,
        regionPct: args.region_pct,
      });

      const url = imageUrl({ scanId, page, longEdge: edge, regionPct: args.region_pct });
      let buffer, mimeType;
      try {
        ({ buffer, mimeType } = await fetchImage(url, { signal }));
      } catch (err) {
        // A 400 on a cropped request is almost always the crop, not the page: the
        // schema can't catch sub-pixel regions (0.01% of a ~2,000px page rounds to
        // zero PIXELS), so translate the server's bare 400 into the self-correction
        // the model actually needs.
        if (args.region_pct && err instanceof ImageError && err.status === 400) {
          throw new ToolError(
            `The media server rejected the region_pct crop [${args.region_pct.join(', ')}] (HTTP 400).`,
            'The crop likely covers less than one pixel of the source page — enlarge width/height, ' +
            'move x/y away from the page edge, or omit region_pct for the whole page.',
          );
        }
        throw err;
      }
      const { data, structured } = buildImageResponse({
        scanId, recordId: attributedId, page, longEdge: edge, regionPct: args.region_pct, buffer, mimeType, url,
      });

      if (!data) {
        throw new ToolError(
          `Image too large to return at long edge ${edge}px.`,
          'Retry with a smaller max_long_edge.',
        );
      }

      const size = structured.delivered_width
        ? `${structured.delivered_width}×${structured.delivered_height}px`
        : `long edge ≤ ${edge}px`;
      const format = mimeType.replace(/^image\//, '').toUpperCase();
      return {
        content: [
          { type: 'image', data, mimeType },
          {
            type: 'text',
            // Warnings go through the shared renderer, never a second hand-spliced
            // phrasing — hand-building this content array (unavoidable, since the
            // response carries an image block) does not license hand-rendering them.
            text: mirrorWarnings(
              `Page ${page} of scan ${scanId}${attributedId ? ` (record ${attributedId})` : ''}` +
              `${args.region_pct ? ` (region ${args.region_pct.join(',')}% of the page)` : ''} — ` +
              `${Math.round(structured.byte_size / 1024)} KB ${format}, ${size}. Source: ${url}` +
              `${structured.viewer_url ? `\n${viewerLine(structured.viewer_url)}` : ''}`,
              warnings,
            ),
          },
        ],
        structuredContent: warnings.length ? { ...structured, warnings } : structured,
      };
    }),
  );
}
