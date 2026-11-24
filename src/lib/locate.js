// sgbr_locate_text: pure normalize/match/region-locate/Collection-parse/
// response-shaping helpers. The one cached HTTP dependency — the anonymous,
// best-effort fetch of a record's parent IIIF Collection manifest for multivolume
// sibling enumeration — lives in the peer client module collection/client.js,
// mirroring the ocr.js / ocr/client.js split (pure shapers vs. one small HTTP
// client). See rdv-iiif-page-ocr.md *(internal)* for the shape of per-page OCR
// assets and multivolume Collection manifests this file assumes.

import {
  LOCATE_MAX_REGIONS_PER_HIT, LOCATE_FAILED_PAGES_LIST_CAP, PER_CHANNEL_RESULT_BUDGET,
  FULLTEXT_INJECTION_BOUNDARY, OCR_SOURCE_NOTE, LOCATE_SNIPPET_CONTEXT_CHARS, LOCATE_UNSEARCHED_SCANS_LIST_CAP,
} from '../config.js';
import { bboxToRegionPct, capRegionsByBudget, formatRegionLine, truncateText } from './ocr.js';
import { parseGbooksImageUrl, viewerUrl } from './image.js';
import { formatScanIds, MULTI_SCAN_KINDS } from './detail.js';

// Normalize OCR/query text for matching: lowercase, long-ſ→s, strip diacritics,
// join hyphen-at-linebreak, collapse whitespace. Order matters: de-hyphenate
// BEFORE collapsing whitespace (a de-hyphenated join can leave irregular
// whitespace around the join point that the collapse step then cleans up).
export function normalizeForMatch(s) {
  return (s || '')
    .replace(/ſ/g, 's')                    // long s → s
    .replace(/-\s*\n\s*/g, '')             // wort-\n fortsetzung → wortfortsetzung
    .normalize('NFD').replace(/\p{Diacritic}/gu, '') // fold diacritics
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Does a page's raw .txt contain the (already-normalized) phrase?
export function pageHasPhrase(rawTxt, phraseNorm) {
  if (!phraseNorm) return false;
  return normalizeForMatch(rawTxt).includes(phraseNorm);
}

// Count non-overlapping occurrences of phraseNorm in the normalized page text.
function countMatches(rawTxt, phraseNorm) {
  if (!phraseNorm) return 0;
  const norm = normalizeForMatch(rawTxt);
  let count = 0;
  let at = norm.indexOf(phraseNorm);
  while (at !== -1) {
    count += 1;
    at = norm.indexOf(phraseNorm, at + phraseNorm.length);
  }
  return count;
}

// A normalized-context snippet around the first occurrence (± contextChars),
// with leading/trailing … when clipped. Returns '' if not found.
function snippetAround(rawTxt, phraseNorm, contextChars) {
  if (!phraseNorm) return '';
  const norm = normalizeForMatch(rawTxt);
  const at = norm.indexOf(phraseNorm);
  if (at === -1) return '';
  const start = Math.max(0, at - contextChars);
  const end = Math.min(norm.length, at + phraseNorm.length + contextChars);
  const lead = start > 0 ? '…' : '';
  const trail = end < norm.length ? '…' : '';
  return `${lead}${norm.slice(start, end)}${trail}`;
}

// hOCR emits `-`, `,`, `.` as their own ocrx_word tokens and parseHocr joins words
// with a space, so the page's `.txt` "Luft-Sauer" reads "Luft - Sauer" in a region.
// normalizeForMatch keeps the spaces AROUND punctuation, so without this a
// punctuated phrase matches the page but anchors no region. Region stream only —
// normalizeForMatch also feeds snippetAround, where "her,als" would be unfaithful
// OCR.
const tightenPunctuation = (s) => s.replace(/\s*([^\p{L}\p{N}\s])\s*/gu, '$1');
const PUNCT = /[^\p{L}\p{N}\s]/u;

// OCCURRENCE-AWARE region matching (NOT a naive per-region substring test — that
// would mark every stray "in" on the page when the phrase is "in Basel", and
// those regions feed sgbr_inspect_image crops). Build the document-order
// normalized concatenation of the level's regions, find where the phrase
// actually occurs in THAT stream, and return only the regions whose character
// span overlaps a real occurrence. Returns regions in document order, capped to
// LOCATE_MAX_REGIONS_PER_HIT, each carrying bbox_px + region_pct. If no region
// span overlaps, returns [] — the hit's page + snippet still stand; regions are
// best-effort anchors.
export function locateRegions(parsed, phraseNorm, level) {
  const regions = (parsed?.regions?.[level]) || [];
  if (!phraseNorm || !regions.length) return [];
  // No usable page dimensions → no regions. A 1px fallback here would turn every
  // bbox into a clamped [100,100,100,100] region_pct — a plausible-looking crop
  // that the media server rejects. sgbr_get_page_ocr REJECTS dimensionless pages
  // outright; on this best-effort path the hit (page + snippet) stands and only
  // the visual anchors are declared unavailable.
  if (!parsed.pageWidth || !parsed.pageHeight) return [];

  // Only regions that contribute characters enter the stream. A region can
  // normalize to nothing — most concretely a bbox-carrying ocr_line whose every
  // word trimmed away, which parseHocr still emits (text: '') — and such a region
  // can never anchor a phrase. Dropping it beats giving it a zero-width span,
  // which would eat the hyphen fold meant for the next real region (the `-` is
  // consumed against the empty span, so the true seam no longer sees one and
  // re-inserts a space). `spanRegion[k]` maps span k back to its index in
  // `regions`, so spans stay contiguous and the previous span is always the
  // contributing one.
  const spans = [];
  const spanRegion = [];
  let joined = '';
  for (let i = 0; i < regions.length; i++) {
    const norm = tightenPunctuation(normalizeForMatch(regions[i].text));
    if (!norm) continue;
    if (joined) {
      // A line or block boundary is a line break; between two words it is one
      // only where the earlier word closes its line, else `-` is an in-line token.
      const lineBreak = level !== 'word' || parsed.wordLineEnds?.has(spanRegion[spanRegion.length - 1]);
      if (lineBreak && joined.endsWith('-')) {
        // Fold a trailing hyphen the way normalizeForMatch folds `-\n` (which
        // can't fire here). The contributing span shrinks with it so the two
        // stay adjacent rather than overlapping.
        joined = joined.slice(0, -1);
        spans[spans.length - 1][1] -= 1;
      } else if (!PUNCT.test(joined.slice(-1)) && !PUNCT.test(norm.slice(0, 1))) {
        // Space only between letters/digits — the same policy tightenPunctuation
        // applies within a region, so a phrase spanning the seam folds identically.
        joined += ' ';
      }
    }
    const start = joined.length;
    joined += norm;
    spans.push([start, joined.length]);
    spanRegion.push(i);
  }

  // The phrase arrives normalizeForMatch-ed; tighten it too so both sides agree.
  const needle = tightenPunctuation(phraseNorm);
  if (!needle) return [];

  const hitIdx = new Set();
  let at = joined.indexOf(needle);
  while (at !== -1) {
    const end = at + needle.length;
    for (let k = 0; k < spans.length; k++) {
      const [s, e] = spans[k];
      if (s < end && e > at) hitIdx.add(spanRegion[k]);
    }
    at = joined.indexOf(needle, at + needle.length);
  }

  return [...hitIdx].sort((a, b) => a - b).slice(0, LOCATE_MAX_REGIONS_PER_HIT).map((i) => {
    const r = regions[i];
    return {
      type: r.type,
      text: r.text,
      bbox_px: r.bbox_px,
      confidence: r.confidence,
      region_pct: bboxToRegionPct(r.bbox_px, parsed.pageWidth, parsed.pageHeight),
    };
  });
}

// IIIF Content Search (v1) body → its hit lines. Each resource marks one text
// block of one scan page: `on` is …/gbooks/<scan, lower-cased>_<8-digit page>.jp2/…#xywh=
// and `resource.chars` the block with each phrase match wrapped in exactly one
// <em> — a block can hold several, so `matches` counts the marks. A `null` body
// is the service's answer to zero hits and to a query it could not parse alike.
const XYWH_RE = /#xywh=(\d+),(\d+),(\d+),(\d+)$/;
export function parseContentSearch(json) {
  return (json?.resources || []).flatMap((r) => {
    const target = parseGbooksImageUrl(r?.on);
    const box = XYWH_RE.exec(r?.on || '');
    if (!target || !box) return [];
    const chars = String(r.resource?.chars || '');
    return [{
      scanId: target.scanId.toUpperCase(),
      page: target.page,
      box: box.slice(1, 5).map(Number),
      text: chars.replace(/<\/?em>/g, '').trim(),
      matches: (chars.match(/<em>/g) || []).length,
    }];
  });
}

// One scan's Content Search lines grouped by page, in page order — the service
// ranks by relevance, and a locator reads front to back.
export function contentSearchPages(lines, scanId) {
  const byPage = new Map();
  for (const line of lines) {
    if (line.scanId !== scanId) continue;
    if (!byPage.has(line.page)) byPage.set(line.page, []);
    byPage.get(line.page).push(line);
  }
  return [...byPage].sort((a, b) => a[0] - b[0]).map(([page, pageLines]) => ({ page, lines: pageLines }));
}

// A page's Content Search lines as line regions, in the shape locateRegions
// returns. Needs the page's pixel size (from its hOCR) for `region_pct`.
function contentSearchRegions(lines, pageWidth, pageHeight) {
  if (!pageWidth || !pageHeight) return [];
  return lines.slice(0, LOCATE_MAX_REGIONS_PER_HIT).map(({ box: [x, y, w, h], text }) => {
    const bbox = [x, y, x + w, y + h];
    return { type: 'line', text, bbox_px: bbox, confidence: null, region_pct: bboxToRegionPct(bbox, pageWidth, pageHeight) };
  });
}

// One hit page from its fetched text and parsed hOCR (either may be missing —
// the page still stands). Where the substring matcher cannot see what Content
// Search matched (tokenised differently), the service's own lines stand in.
export function shapeLocateHit({ page, text, parsed, csLines }, { phraseNorm, level, viewerRecordId }) {
  let regions = parsed ? locateRegions(parsed, phraseNorm, level) : [];
  if (!regions.length && csLines && level === 'line' && parsed) {
    regions = contentSearchRegions(csLines, parsed.pageWidth, parsed.pageHeight);
  }
  return {
    page,
    // The service's own marks, when it answered: a substring count would also
    // count "Rat" inside "Rathaus".
    match_count: csLines?.length
      ? csLines.reduce((n, l) => n + (l.matches || 1), 0)
      : countMatches(text, phraseNorm),
    snippet: snippetAround(text, phraseNorm, LOCATE_SNIPPET_CONTEXT_CHARS) || (csLines ? normalizeForMatch(csLines[0].text) : ''),
    viewer_url: viewerUrl(viewerRecordId, page),
    regions,
  };
}

// Extract the ordered, de-duplicated child scan ids from a parsed IIIF manifest
// JSON. Returns null when it is not a Collection (i.e. a single-volume Manifest).
const CHILD_SCAN_ID_RE = /([A-Z]{2,6}-\d{6,})/;
export function parseCollectionChildren(manifestJson) {
  if (manifestJson?.type !== 'Collection') return null;
  const out = [];
  for (const it of manifestJson.items || []) {
    const m = CHILD_SCAN_ID_RE.exec(it?.id || '');
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// Boundary reconciliation (pure, so it is unit-testable without network). Given
// the per-page scan outcomes gathered so far — [{ page, status }] where status
// is 200, 404, or a fetch error code — return the FIRST 404 page (the
// end-of-volume boundary) or null if none seen yet. Callers MUST discard any
// candidate hit whose page >= this boundary, EVEN IF that page returned 200
// while in flight alongside the 404: pages are contiguous 1..N then 404
// (probed), so a 200 past the first 404 is spurious and must never be reported.
export function firstEndPage(outcomes) {
  const ends = outcomes.filter((o) => o.status === 404).map((o) => o.page);
  return ends.length ? Math.min(...ends) : null;
}

// The pages whose `.txt` fetch FAILED (not 200, not the 404 end-of-volume
// boundary) — i.e. pages the scan claims to have covered but never actually
// read. Pages at/after the boundary are excluded (they're spurious probes past
// the volume end, like the 200s the tool already discards). Pure, sorted; the
// caller turns a non-empty result into a coverage warning — WITHOUT this, a
// transient 5xx/network failure on the one page containing the phrase reads as
// a confident "no matches".
export function failedPages(outcomes, boundary) {
  return outcomes
    .filter((o) => o.status !== 200 && o.status !== 404 && (boundary == null || o.page < boundary))
    .map((o) => o.page)
    .sort((a, b) => a - b);
}

// The volume's page count is `boundary - 1` — but ONLY when we have positive
// evidence that page `boundary-1` actually exists (was observed 200). Resuming
// with a start_page PAST the true end makes the first probed page itself a 404,
// so `boundary` overshoots and `boundary-1` would be a fabricated total. Without
// a confirmed 200 immediately before the boundary, the count is honestly unknown
// (null) rather than guessed. Pure, so the overshoot edge is unit-testable.
export function computeVolumePageCount(outcomes, boundary) {
  if (boundary == null) return null;
  return outcomes.some((o) => o.status === 200 && o.page === boundary - 1) ? boundary - 1 : null;
}

/**
 * Assemble both response channels for sgbr_locate_text.
 */
export function buildLocateResponse({
  scanId, recordId, phrase, level, startPage, engine = 'page_scan', pagesScanned = null, volumePageCount = null, hits,
  truncated, truncationReason = null, siblings, failedPages: failed = [], scanIds = [],
}) {
  // The Collection read behind `siblings` is best-effort and need not list other
  // libraries' copies; only the record's own scan list names every scan left out.
  const unsearched = scanIds.filter((s) => s !== scanId && !siblings?.volumes.includes(s));
  const structured = {
    scan_id: scanId,
    id: recordId || null,
    phrase,
    level,
    start_page: startPage,
    engine,
    // Pages CHECKED, including failed fetches — next_start_page is
    // startPage + pagesScanned, so this must stay the width of the scan window.
    // Incomplete coverage is reported separately (pages_failed / failed_pages).
    pages_scanned: pagesScanned,
    pages_failed: failed.length,
    failed_pages: failed.slice(0, LOCATE_FAILED_PAGES_LIST_CAP),
    volume_page_count: volumePageCount,
    ocr_note: OCR_SOURCE_NOTE,
    hits,
    returned_hits: hits.length,
    truncated,
    truncation_reason: truncated ? truncationReason : null,
    next_start_page: truncated && truncationReason === 'max_pages' ? startPage + pagesScanned : null,
    // Region-budget trimming (below) is deliberately NOT folded into
    // `truncated`/`truncation_reason`: those describe incomplete SEARCH COVERAGE
    // (pages not scanned / matches not returned), and trimmed regions leave the
    // hits and snippets complete — conflating them would make a client infer
    // that matches are missing. Its own flag instead:
    regions_truncated: false,
    siblings: siblings || null,
    scans_unsearched: unsearched.length,
    unsearched_scans: unsearched.slice(0, LOCATE_UNSEARCHED_SCANS_LIST_CAP),
  };
  // Budget the serialized structuredContent (mirrors buildPageOcrResponse):
  // fixed fields + snippets are measured first (regions emptied), then regions
  // fill the remainder in document order — a max-knobs call (50 hits × 20
  // regions) would otherwise serialize past the per-channel budget. Later hits
  // degrade to snippet-only, which the regions contract already allows
  // (best-effort anchors; the page + snippet still stand).
  let remaining = PER_CHANNEL_RESULT_BUDGET
    - JSON.stringify({ ...structured, hits: hits.map((h) => ({ ...h, regions: [] })) }).length;
  structured.hits = hits.map((h) => {
    const kept = capRegionsByBudget(h.regions || [], remaining);
    remaining -= JSON.stringify(kept).length;
    if (kept.length < (h.regions || []).length) structured.regions_truncated = true;
    return { ...h, regions: kept };
  });

  // A truncated result is only actionable if the caller knows WHY it stopped and
  // what to do next — spell it out in the header rather than a bare "(truncated)".
  let truncNote = '';
  if (truncated) {
    if (structured.truncation_reason === 'max_pages') {
      truncNote = ` (truncated: reached the max_pages scan window — resume with start_page ${structured.next_start_page} to scan further)`;
    } else if (structured.truncation_reason === 'max_hits') {
      truncNote = ' (truncated: reached max_hits — raise max_hits, or resume with start_page past the last hit, to see more)';
    } else {
      truncNote = ' (truncated)';
    }
  }
  const headerCount = hits.length ? `${hits.length} page(s)` : 'no pages';
  const header = [
    `Located "${phrase}" in scan ${scanId}${recordId ? ` (record ${recordId})` : ''} by ` +
      `${engine === 'content_search' ? 'content search' : 'page scan'}: ${headerCount}${truncNote}.`,
    ...(structured.regions_truncated
      ? ['Some hits carry fewer/no regions (trimmed to fit the response budget) — the hits and snippets ' +
         'themselves are complete; use sgbr_get_page_ocr on a specific page for its full regions.']
      : []),
  ];
  const hitLines = hits.map((h) => `  p${h.page} (${h.match_count}×)${h.viewer_url ? ` ${h.viewer_url}` : ''}: ${h.snippet}`);
  const siblingLines = siblings
    ? [`Multivolume work — searched volume ${siblings.searched_volume} of ${siblings.volumes.length}; ` +
      `other volumes: ${siblings.volumes.filter((v) => v !== siblings.searched_volume).join(', ') || '(none other found)'}.`]
    : [];
  if (unsearched.length) {
    siblingLines.push(
      `This record lists ${scanIds.length} scans (${MULTI_SCAN_KINDS}); not searched` +
      `${siblings ? ' and not among those volumes' : ''}: ${formatScanIds(unsearched, LOCATE_UNSEARCHED_SCANS_LIST_CAP)}. ` +
      'Call again with one of them as `scan_id` to search it.',
    );
  }

  // The regions that survived the budget above, so both channels name the same ones.
  const regionLines = structured.hits.flatMap((h) => h.regions.map((r) => `  p${h.page}: ${formatRegionLine(r)}`));

  // Snippets and region texts are verbatim (normalized) OCR — the same untrusted
  // source text as a full-text window, so they sit behind the same injection
  // boundary line, with no tool note between it and them.
  const body = [
    ...header,
    ...(hitLines.length ? ['', FULLTEXT_INJECTION_BOUNDARY, ...hitLines] : []),
    ...(regionLines.length ? ['', 'Regions:', ...regionLines] : []),
    ...(siblingLines.length ? ['', ...siblingLines] : []),
  ];
  const text = truncateText(body.join('\n'), PER_CHANNEL_RESULT_BUDGET);

  return { structured, text };
}
