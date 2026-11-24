// sgbr_locate_text — find which page(s) of a scanned book contain a phrase, in
// ONE scan volume. Two engines: the platform's IIIF Content Search (the
// website viewer's search — every hit page in one call, whole words, exact
// accents), and a scan of the cheap per-page `.txt` OCR (normalized substrings,
// stopping at the 404 page boundary). "auto" asks Content Search first and
// scans when it finds nothing. hOCR is then fetched only for the hit pages to
// return line/word regions (bbox_px + region_pct, ready for
// sgbr_inspect_image). For a multivolume work it also returns the ordered
// sibling scan ids (best-effort, from the parent IIIF Collection) so the model
// can re-call with the next volume's scan_id.

import { z } from 'zod';
import { fetchOcrAsset, fetchOcrPageText, scanOcrPages, findLastOcrPage, OcrError } from '../ocr/client.js';
import { fetchContentSearch, ContentSearchError } from '../contentsearch/client.js';
import { resolveScanTarget, findScanRecordId } from '../lib/resolve.js';
import { ocrAssetUrl, parseHocr } from '../lib/ocr.js';
import {
  normalizeForMatch, pageHasPhrase, firstEndPage, computeVolumePageCount, failedPages,
  contentSearchPages, shapeLocateHit, buildLocateResponse,
} from '../lib/locate.js';
import { fetchCollectionChildren } from '../collection/client.js';
import { GET_RECORD_QUERY } from '../graphql/operations.js';
import { graphqlRequest } from '../graphql/client.js';
import { isEmptyRecord, getManifestUrl } from '../lib/detail.js';
import { withTool } from '../lib/tool.js';
import { progressReporter } from '../lib/progress.js';
import { isAbort, mapPool } from '../lib/async.js';
import { ToolError } from '../lib/errors.js';
import { withWarnings } from '../lib/warnings.js';
import {
  DEFAULT_LOCATE_MAX_PAGES, MAX_LOCATE_MAX_PAGES, DEFAULT_LOCATE_MAX_HITS, MAX_LOCATE_MAX_HITS,
  OCR_PAGE_CONCURRENCY, READ_ONLY_ANNOTATIONS,
} from '../config.js';

export const LOCATE_TEXT_TOOL_NAME = 'sgbr_locate_text';

const inputSchema = z.object({
  id: z.string().min(1).optional().describe(
    'Record id from an sgbr_search result. Resolves its scan id automatically and enables sibling-' +
    'volume enumeration for multivolume works. Provide this OR scan_id.'
  ),
  scan_id: z.string().min(1).optional().describe(
    'Scan id directly (e.g. "ZBZ-00123359"), from sgbr_get_record\'s digital.scan_id. Skips the ' +
    'id→scan lookup but yields no sibling volume list (no record to derive it from). Provide this OR id.'
  ),
  phrase: z.string().min(1).max(200).describe(
    'Text to locate, as a phrase. Content search matches it as whole words, case-insensitively but ' +
    'with exact accents; the page scan matches it as a case/diacritic-insensitive substring of ' +
    'normalized OCR (Fraktur long-ſ folded, hyphen-at-linebreak joined).'
  ),
  engine: z.enum(['auto', 'content_search', 'page_scan']).default('auto').describe(
    '"auto" (default) asks the platform\'s content search — the website viewer\'s search, the whole ' +
    'volume in one call — and falls back to the page scan when it finds nothing or cannot run. ' +
    '"page_scan" also finds the phrase inside longer words, in other accent forms, and split across ' +
    'a line break. "content_search" never falls back.'
  ),
  start_page: z.number().int().min(1).default(1).describe(
    '1-based page to begin at (resume within a large volume, or past the last hit).'
  ),
  max_pages: z.number().int().min(1).max(MAX_LOCATE_MAX_PAGES).default(DEFAULT_LOCATE_MAX_PAGES).describe(
    `Cost cap on pages the page scan reads from start_page (default ${DEFAULT_LOCATE_MAX_PAGES}, max ` +
    `${MAX_LOCATE_MAX_PAGES}); the scan also stops early at the 404 page boundary. Content search ` +
    'always covers the whole volume.'
  ),
  max_hits: z.number().int().min(1).max(MAX_LOCATE_MAX_HITS).default(DEFAULT_LOCATE_MAX_HITS).describe(
    `Cap on matching pages returned (default ${DEFAULT_LOCATE_MAX_HITS}, max ${MAX_LOCATE_MAX_HITS}); ` +
    'hOCR is fetched only for these.'
  ),
  level: z.enum(['line', 'word']).default('line').describe(
    'Region granularity for each hit.'
  ),
}).strict();

const description =
  'Locate a phrase in a scanned book\'s OCR and return the page(s) it is on. ' +
  'Asks the platform\'s content search (whole words, exact accents) and, when that finds nothing, ' +
  'scans the pages\' OCR for the phrase as a substring; `engine` says which answered. For each hit ' +
  'returns the page, a context snippet, and line/word regions with ' +
  '`bbox_px` + `region_pct` ' +
  '(feed `region_pct` to sgbr_inspect_image to crop/verify; `regions` is best-effort and may be ' +
  'empty — the page and snippet still stand). Text is uncorrected Fraktur OCR, so ' +
  'expect misses. Searches one volume — for a multivolume work it returns the ordered sibling ' +
  '`volumes` so you can call again with the next `scan_id`, and `unsearched_scans` names any other ' +
  'scan the record lists (a volume or another library\'s copy) that went unsearched. A fold-out plate `id` is refused (a plate ' +
  'is one page; its scan_id is the parent volume\'s) — pass the parent `scan_id` to search the volume.';

const regionSchema = z.object({
  type: z.enum(['line', 'word']),
  text: z.string(),
  bbox_px: z.array(z.number()).length(4),
  confidence: z.number().nullable(),
  region_pct: z.array(z.number()).length(4),
});

const hitSchema = z.object({
  page: z.number(),
  match_count: z.number(),
  snippet: z.string(),
  viewer_url: z.string().nullable(),
  regions: z.array(regionSchema),
});

const siblingsSchema = z.object({
  is_multivolume: z.literal(true),
  searched_volume: z.string(),
  volumes: z.array(z.string()),
});

export const outputSchema = z.object({
  scan_id: z.string(),
  id: z.string().nullable(),
  phrase: z.string(),
  level: z.enum(['line', 'word']),
  start_page: z.number(),
  engine: z.enum(['content_search', 'page_scan']),
  // Pages CHECKED from start_page (the resume axis: next start_page =
  // start_page + pages_scanned), INCLUDING any that failed to fetch — those are
  // broken out below so incomplete coverage is never silent. Null for content
  // search, which covers the whole volume without reading pages.
  pages_scanned: z.number().nullable(),
  // Pages in the window whose OCR fetch failed after retries — they were NOT
  // searched, so a "no matches" result does not cover them. `failed_pages`
  // enumerates the first few (capped); `pages_failed` is the full count.
  pages_failed: z.number(),
  failed_pages: z.array(z.number()),
  volume_page_count: z.number().nullable(),
  ocr_note: z.string(),
  hits: z.array(hitSchema),
  returned_hits: z.number(),
  truncated: z.boolean(),
  // Why the result is capped (null when not truncated): 'max_hits' = more
  // matches may exist on the scanned pages (raise max_hits); 'max_pages' = the
  // volume extends past the scan window (resume with start_page += max_pages).
  truncation_reason: z.enum(['max_hits', 'max_pages']).nullable(),
  next_start_page: z.number().int().nullable().describe(
    'The page after the scan window, set when the scan stopped at max_pages: pass it as start_page ' +
    'to scan further. Null otherwise.'
  ),
  // True when some hits' region lists were trimmed to fit the response budget.
  // Distinct from `truncated`/`truncation_reason` (incomplete SEARCH coverage):
  // the hits and snippets themselves are complete — only the visual anchors are
  // reduced. Re-fetch a page's full regions via sgbr_get_page_ocr.
  regions_truncated: z.boolean(),
  siblings: siblingsSchema.nullable(),
  // Scans the record lists that neither this call nor `siblings` covers.
  scans_unsearched: z.number(),
  unsearched_scans: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
});

// Content Search finds every hit page of the scan in one call, from start_page
// on; max_pages does not apply, and pages are never read one by one.
async function findWithContentSearch({ csRecordId, scanId, args, signal }) {
  const lines = await fetchContentSearch(csRecordId, args.phrase, { signal });
  const pages = contentSearchPages(lines, scanId).filter((p) => p.page >= args.start_page);
  return {
    engine: 'content_search',
    candidates: pages.slice(0, args.max_hits).map(({ page, lines: csLines }) => ({ page, csLines })),
    truncationReason: pages.length > args.max_hits ? 'max_hits' : null,
    warnings: pages.length ? [] : [
      'No matches found — content search matches whole words with exact accents; engine ' +
      '"page_scan" also finds the phrase inside longer words and in other accent forms.',
    ],
  };
}

// Reads `.txt` pages from start_page until max_pages, the volume's end (the
// first 404) or max_hits matching pages.
async function findWithPageScan({ scanId, phraseNorm, args, signal, report }) {
  const lastPage = args.start_page + args.max_pages - 1;
  const candidates = [];
  const { pages, stopped } = await scanOcrPages(scanId, args.start_page, lastPage, {
    signal,
    // max_pages is only an upper bound: the volume may end sooner.
    onSettled: (n) => report(n, args.max_pages,
      `Scanned ${n} of up to ${args.max_pages} pages, ${candidates.length} matching`),
    stop: (r) => {
      if (r.exists && pageHasPhrase(r.text, phraseNorm)) candidates.push({ page: r.page, rawTxt: r.text });
      return candidates.length >= args.max_hits;
    },
  });
  // A failed page is recorded, not fatal: failedPages() turns it into
  // pages_failed + a warning, so it never reads as a page without the phrase.
  const outcomes = pages.map((r) => ({
    page: r.page,
    status: r.error ? (r.error instanceof OcrError ? r.error.status : 0) : (r.exists ? 200 : 404),
  }));
  const boundary = firstEndPage(outcomes);
  // Pages in flight when the 404 or the max_hits stop landed still settle: a
  // match past the volume's end is spurious, and matches may overshoot
  // max_hits. max_hits outranks max_pages as the reason — a scan that stopped
  // for hits never reached the page cap.
  const inRange = candidates
    .filter((c) => boundary == null || c.page < boundary)
    .sort((a, b) => a.page - b.page);
  const cappedByHits = (stopped && boundary == null) || inRange.length > args.max_hits;
  const cappedByPages = boundary == null && !stopped && outcomes.at(-1)?.page >= lastPage;
  const truncationReason = cappedByHits ? 'max_hits' : (cappedByPages ? 'max_pages' : null);

  const warnings = [];
  const failed = failedPages(outcomes, boundary);
  if (failed.length) {
    const shown = failed.slice(0, 10).join(', ');
    const more = failed.length > 10 ? `, … (${failed.length} total)` : '';
    warnings.push(
      `${failed.length} page(s) failed to fetch after retries (page ${shown}${more}) and were ` +
      'NOT searched — coverage is incomplete, so a miss on those pages is unproven. ' +
      'Re-run the same call to retry them.',
    );
  }
  const volumePageCount = await confirmVolumePageCount(scanId, outcomes, boundary, signal);
  if (boundary === args.start_page && volumePageCount != null) {
    warnings.push(
      `start_page ${args.start_page} is past the end of this volume, which has ${volumePageCount} ` +
      `page(s), so no page was searched. Re-call with a start_page within 1–${volumePageCount}.`,
    );
  } else if (!inRange.length) {
    warnings.push(
      'No matches found — per-page OCR coverage is not exhaustively proven across all libraries; ' +
      'a null result may mean this material is not OCR\'d here, not that the phrase is absent.',
    );
  }
  return {
    engine: 'page_scan',
    candidates: inRange.slice(0, args.max_hits),
    truncationReason,
    // Pages in flight past the end settle as 404s too; they are not the volume's.
    pagesScanned: boundary == null ? outcomes.length : outcomes.filter((o) => o.page < boundary).length,
    volumePageCount,
    failed,
    warnings,
  };
}

// A rejection handler for a best-effort read: a caller's cancel still propagates,
// anything else degrades to `fallback`.
const degrade = (signal, fallback) => (err) => {
  if (isAbort(err, signal)) throw err;
  return fallback;
};

// The scan proves the volume's size only when it saw the page before the first
// 404. Otherwise (a start_page past the end, or that page failed to fetch) a
// cached bisection recovers it; a failure there leaves the count unknown rather
// than failing the scan, and a volume with no OCR at all has no count to report.
async function confirmVolumePageCount(scanId, outcomes, boundary, signal) {
  const seen = computeVolumePageCount(outcomes, boundary);
  if (seen != null || boundary == null) return seen;
  return findLastOcrPage(scanId, boundary, { signal }).then((n) => n || null, degrade(signal, null));
}

// One hit page: its text (the page scan already holds it) and its hOCR. Either
// fetch failing degrades the hit, never drops it — the page still stands.
async function buildHit({ cand, scanId, phraseNorm, level, viewerRecordId, signal }) {
  const [text, parsed] = await Promise.all([
    cand.rawTxt ?? fetchOcrPageText(scanId, cand.page, { signal }).then((r) => r.text, degrade(signal, '')),
    fetchOcrAsset(ocrAssetUrl(scanId, cand.page, 'hocr'), { signal }).then(parseHocr).catch(degrade(signal, null)),
  ]);
  return shapeLocateHit({ page: cand.page, text, parsed, csLines: cand.csLines }, { phraseNorm, level, viewerRecordId });
}

// A multivolume work's ordered sibling scan ids, from its parent IIIF
// Collection. Best-effort: null on any failure, never failing the tool call.
async function findSiblings(recordId, scanId, signal) {
  try {
    const record = (await graphqlRequest(GET_RECORD_QUERY, { id: recordId }, { signal }))?.get;
    const manifestUrl = !isEmptyRecord(record) && getManifestUrl(record);
    const children = manifestUrl ? await fetchCollectionChildren(manifestUrl, { signal }) : null;
    return children?.length ? { is_multivolume: true, searched_volume: scanId, volumes: children } : null;
  } catch {
    return null;
  }
}

export function registerLocateTextTool(server) {
  server.registerTool(
    LOCATE_TEXT_TOOL_NAME,
    {
      title: LOCATE_TEXT_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(LOCATE_TEXT_TOOL_NAME, 'Locate-text search failed', async (args, ctx) => {
      const signal = ctx?.mcpReq?.signal;
      const { scanId, recordId, scanIds } = await resolveScanTarget(args, {
        signal,
        // Enumerates sibling volumes itself and runs Content Search only on the
        // record for exactly one scan.
        allowMultiScan: true,
        // NOT allowDerivedScan: this tool sweeps a page RANGE, so a plate's
        // parent scan would silently turn "search this record" into "search the
        // whole parent volume" and attribute every hit to the one-page plate.
        // A plate is a single page anyway, which makes "which page?" degenerate
        // — so refuse, but hand back the address that does work.
        missing: {
          what: 'has no digitised page OCR to search',
          hint: 'Confirm digital.scan_id via sgbr_get_record first.',
          derived: ({ scanId: parentScan, page }) => ({
            what: `is a single fold-out plate, so there is no page range to search`,
            hint:
              `It is page ${page} of scan "${parentScan}". To read that plate's own OCR call ` +
              `sgbr_get_page_ocr with this id (its page is automatic), or sgbr_inspect_image to view ` +
              `it. To search the whole parent volume instead, call again with scan_id "${parentScan}".`,
          }),
        },
      });

      const phraseNorm = normalizeForMatch(args.phrase);
      if (!phraseNorm) {
        throw new ToolError('Phrase is empty after normalization.', 'Provide letters/digits to search for.');
      }
      const siblings = recordId ? findSiblings(recordId, scanId, signal) : null;
      // The record for exactly this scan: content search runs on it, and a
      // multi-scan work's hits link through it. Looked up once, alongside the
      // scan; the no-op catch only keeps an un-awaited failure from going unhandled.
      const multiScan = scanIds?.length > 1;
      const scanRecord = args.engine !== 'page_scan' || multiScan
        ? findScanRecordId(scanId, { recordId, signal })
        : null;
      scanRecord?.catch(() => {});

      // Content Search runs only on the record for exactly this scan — a work id
      // spans every volume and copy it lists. "auto" hands anything short of
      // hits over to the page scan; a forced engine surfaces the failure.
      const forced = args.engine === 'content_search';
      const warnings = [];
      let csRecordId = null;
      let found = null;
      if (args.engine !== 'page_scan') {
        try {
          csRecordId = await scanRecord;
          if (csRecordId) {
            found = await findWithContentSearch({ csRecordId, scanId, args, signal });
          } else if (forced) {
            throw new ToolError(
              `Content search has no record for scan "${scanId}".`,
              'Pass the record `id` instead, or use engine "auto" or "page_scan" to scan the pages.',
            );
          }
        } catch (err) {
          if (isAbort(err, signal) || forced) throw err;
          if (err instanceof ContentSearchError && err.tooLarge) {
            warnings.push(
              'The phrase has too many matches for content search to return, so the page scan was used ' +
              'instead: it reads pages from start_page and stops at max_hits.',
            );
          }
        }
        if (!forced && !found?.candidates.length) found = null;
      }
      found ??= await findWithPageScan({ scanId, phraseNorm, args, signal, report: progressReporter(ctx) });
      warnings.push(...found.warnings);

      // A content-search hit reads its page text as well as its hOCR.
      const limit = found.engine === 'content_search' ? Math.ceil(OCR_PAGE_CONCURRENCY / 2) : OCR_PAGE_CONCURRENCY;
      // A work id's viewer pages run across every scan it lists, so `?page=N`
      // lands on this scan only under the record for exactly this scan — with
      // none, the hits carry no link rather than one to another scan's page.
      const viewerRecordId = !multiScan ? csRecordId || recordId
        : found.candidates.length ? await scanRecord.catch(degrade(signal, null)) : null;
      const hits = await mapPool(found.candidates, limit, (cand) => buildHit({
        cand, scanId, phraseNorm, level: args.level, viewerRecordId, signal,
      }));

      // The multivolume caveat is rendered once by buildLocateResponse's sibling
      // lines (and carried in structuredContent.siblings/unsearched_scans), never as a warning.
      const response = buildLocateResponse({
        scanId, recordId, phrase: args.phrase, level: args.level, startPage: args.start_page,
        engine: found.engine, pagesScanned: found.pagesScanned, volumePageCount: found.volumePageCount,
        hits, truncated: found.truncationReason != null, truncationReason: found.truncationReason,
        siblings: await siblings, scanIds, failedPages: found.failed,
      });
      const { structured, text } = withWarnings(response, warnings);
      return { content: [{ type: 'text', text }], structuredContent: structured };
    }),
  );
}
