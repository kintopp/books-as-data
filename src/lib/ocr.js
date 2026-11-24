// Per-page OCR: builds hOCR/plain-text asset URLs, parses hOCR into layout
// regions, converts pixel bboxes to percent-of-page crops (feeding
// sgbr_inspect_image's `region_pct`), and shapes the sgbr_get_page_ocr response.
// No DOM/HTML parser dependency — hOCR here is a narrow, machine-generated
// dialect, so a targeted regex walk is enough (probe: rdv-iiif-page-ocr.md *(internal)*).

import {
  OCR_ENDPOINT_BASE, FULLTEXT_INJECTION_BOUNDARY, OCR_SOURCE_NOTE, PER_CHANNEL_RESULT_BUDGET, OCR_TEXT_FIELD_BUDGET,
} from '../config.js';
import { gbooksPageSegment, pctSeg, viewerLine, viewerUrl } from './image.js';

const EXT = { hocr: 'html', text: 'txt' };

// Build the OCR asset URL for one page. Reuses imageUrl's `_{page}` 8-digit,
// 1-based page grammar (gbooksPageSegment), but on the mediaserver HOST ROOT
// (no `/iiif/3` segment) and a different extension/suffix.
export function ocrAssetUrl(scanId, page, kind) {
  return `${OCR_ENDPOINT_BASE}/gbooks/${encodeURIComponent(scanId)}_${gbooksPageSegment(page)}.${EXT[kind]}/item`;
}

const BBOX_RE = /\bbbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/;
const WCONF_RE = /x_wconf\s+(\d+)/;

function parseBbox(title) {
  const m = BBOX_RE.exec(title || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

function parseWconf(title) {
  const m = WCONF_RE.exec(title || '');
  return m ? Number(m[1]) : null;
}

const ENTITY_MAP = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function unescapeHtml(s) {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (e) => ENTITY_MAP[e]);
}

// Regex token walk over hOCR's ocr_page / ocrx_block / ocr_line / ocrx_word
// elements, in document order. Single-quoted attributes, `class` before `title`
// (probe-confirmed layout).
const TOKEN = /class=['"](ocr_page|ocrx_block|ocr_line|ocrx_word)['"][^>]*?title=['"]([^'"]+)['"]\s*>([^<]*)/g;

/**
 * Parse a hOCR document into page dimensions + block/line/word regions.
 * Returns { pageWidth, pageHeight, regions: {block, line, word}, wordLineEnds, counts };
 * `wordLineEnds` holds the indices of the word regions that close a line, so a
 * trailing `-` can be told from a hyphen token inside the line.
 */
export function parseHocr(html) {
  let pageWidth = 0;
  let pageHeight = 0;
  const regions = { block: [], line: [], word: [] };
  const wordLineEnds = new Set();
  const closeLine = () => { if (regions.word.length) wordLineEnds.add(regions.word.length - 1); };
  let curBlock = null;
  let curLine = null;

  for (const m of (html || '').matchAll(TOKEN)) {
    const cls = m[1];
    const title = m[2];
    const bbox = parseBbox(title);
    const conf = parseWconf(title);

    if (cls === 'ocr_page') {
      if (bbox) { pageWidth = bbox[2]; pageHeight = bbox[3]; }
      continue;
    }
    // A region is only emitted when it carries a real bbox: every downstream
    // consumer (bboxToRegionPct → region_pct, and the length-4 output schema)
    // assumes a 4-number box, and parseBbox returns null for a bbox-less title.
    // Keep the curBlock/curLine pointers regardless so word text still
    // aggregates into an (unemitted) parent for reading-order joins.
    if (cls === 'ocrx_block') {
      closeLine();
      curBlock = { type: 'block', text: '', bbox_px: bbox, confidence: conf, _words: [] };
      if (bbox) regions.block.push(curBlock);
      curLine = null;
      continue;
    }
    if (cls === 'ocr_line') {
      closeLine();
      curLine = { type: 'line', text: '', bbox_px: bbox, confidence: conf, _words: [] };
      if (bbox) regions.line.push(curLine);
      continue;
    }
    // ocrx_word
    const text = unescapeHtml(m[3]).trim();
    if (!text) continue;
    if (curLine) curLine._words.push(text);
    if (curBlock) curBlock._words.push(text);
    if (bbox) regions.word.push({ type: 'word', text, bbox_px: bbox, confidence: conf });
  }

  closeLine();
  for (const line of regions.line) { line.text = line._words.join(' '); delete line._words; }
  for (const block of regions.block) { block.text = block._words.join(' '); delete block._words; }

  return {
    pageWidth,
    pageHeight,
    regions,
    wordLineEnds,
    counts: { blocks: regions.block.length, lines: regions.line.length, words: regions.word.length },
  };
}

// Convert a pixel bbox [x1,y1,x2,y2] to a percent-of-page [x,y,w,h] region,
// top-left origin — the same shape sgbr_inspect_image's `region_pct` accepts, and
// through the same pctSeg formatter so the values round and clamp identically.
export function bboxToRegionPct([x1, y1, x2, y2], w, h) {
  return [pctSeg((x1 / w) * 100), pctSeg((y1 / h) * 100), pctSeg(((x2 - x1) / w) * 100), pctSeg(((y2 - y1) / h) * 100)];
}

// Reserve the marker's own length before slicing, so the RESULT honours `cap` —
// callers pass hard channel budgets (PER_CHANNEL_RESULT_BUDGET), and appending
// after a full-width slice would overshoot every one of them. A cut between a
// surrogate pair steps back one code unit, so the text never ends in half a character.
const TRUNC_MARK = '… truncated';

export function truncateText(s, cap, mark = TRUNC_MARK) {
  if (s.length <= cap) return s;
  let head = s.slice(0, Math.max(0, cap - mark.length));
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}${mark}`;
}

// Keep the longest prefix of `regions` whose JSON serialization fits `budget`
// chars. A region-count cap alone can't bound the response: 2,000 word regions
// serialize to ~300k chars — twice RESULT_CHAR_CEILING — so the count cap is
// backed by this serialized-size cap. Prefix (not sampling): regions are in
// document order, and a predictable "first N fit" beats a lossy scatter.
export function capRegionsByBudget(regions, budget) {
  let used = 2; // the enclosing [] of the serialized array
  const kept = [];
  for (const r of regions) {
    const len = JSON.stringify(r).length + 1; // +1 for the separating comma
    if (used + len > budget) break;
    used += len;
    kept.push(r);
  }
  return kept;
}

/**
 * One region as a text-channel line, shared by sgbr_get_page_ocr and sgbr_locate_text.
 * Both list every region they return: a host that passes the model only the text
 * channel has no other way to reach a region_pct.
 */
export function formatRegionLine(r) {
  return `"${r.text}" bbox_px=[${r.bbox_px.join(',')}] region_pct=[${r.region_pct.join(',')}]`;
}

/**
 * Assemble both response channels for sgbr_get_page_ocr.
 */
export function buildPageOcrResponse({
  scanId, recordId, page, parsed, plainText, level, maxRegions, hocrUrl, textUrl,
}) {
  const { pageWidth, pageHeight, regions, counts } = parsed;

  let list;
  if (level === 'page') {
    // The page text is carried once, in `text`, not again in the region.
    list = [{ type: 'page', text: '', bbox_px: [0, 0, pageWidth, pageHeight], confidence: null }];
  } else {
    list = regions[level] || [];
  }

  const countCapped = list.length > maxRegions ? list.slice(0, maxRegions) : list;
  const withPct = countCapped.map((r) => ({
    ...r,
    region_pct: bboxToRegionPct(r.bbox_px, pageWidth || 1, pageHeight || 1),
  }));

  const structured = {
    scan_id: scanId,
    id: recordId || null,
    page,
    level,
    hocr_url: hocrUrl,
    text_url: textUrl || null,
    page_width: pageWidth,
    page_height: pageHeight,
    counts,
    regions: [],
    returned_regions: 0,
    truncated: false,
    truncation_reason: null,
    ocr_note: OCR_SOURCE_NOTE,
    // Cap the text field at its sub-budget (half the channel) so a pathological
    // text blob can't starve the regions allocation below.
    text: truncateText(plainText || '', OCR_TEXT_FIELD_BUDGET),
    viewer_url: viewerUrl(recordId, page),
  };
  // Budget the WHOLE serialized structuredContent, not just the text field: the
  // fixed fields + capped text are measured first (with `regions` empty), and
  // regions get only what remains of the per-channel budget. `truncated` covers
  // both caps; `truncation_reason` disambiguates them because they imply
  // opposite follow-ups — 'max_regions': the count cap bit, raise max_regions
  // to see more; 'result_budget': the size budget bit, so raising max_regions
  // is futile — request a coarser level, a narrower page, or include_text:false
  // to free budget. Budget takes precedence when both bit: it is the binding cap.
  const overhead = JSON.stringify(structured).length;
  const kept = capRegionsByBudget(withPct, PER_CHANNEL_RESULT_BUDGET - overhead);
  structured.regions = kept;
  structured.returned_regions = kept.length;
  structured.truncated = list.length > kept.length;
  structured.truncation_reason = !structured.truncated
    ? null
    : (kept.length < withPct.length ? 'result_budget' : 'max_regions');

  const regionLines = kept.map((r) => `  - ${formatRegionLine(r)}`);
  // Spell out WHY regions were truncated (mirrors buildLocateResponse's
  // truncNote): the two reasons imply opposite follow-ups.
  let truncNote = '';
  if (structured.truncation_reason === 'max_regions') {
    truncNote = ' (truncated: max_regions — raise max_regions to see more)';
  } else if (structured.truncation_reason === 'result_budget') {
    truncNote = ' (truncated: response budget — request a coarser level, or include_text:false to free budget)';
  }
  const header = [
    `Page OCR — scan ${scanId}${recordId ? ` (record ${recordId})` : ''}, page ${page}.`,
    `Page ${pageWidth}×${pageHeight}px. Counts: ${counts.blocks} blocks, ${counts.lines} lines, ${counts.words} words.`,
    `Level "${level}": ${kept.length} region(s) returned${truncNote}.`,
    ...(structured.viewer_url ? [viewerLine(structured.viewer_url)] : []),
  ];
  // Assemble the human channel from the raw plainText (not structured.text) and
  // truncate once, so a near-budget page can't stack two truncation markers. The
  // regions go before the page text so that the cut falls on the text, which
  // sgbr_get_fulltext can also serve, and never on a region_pct.
  // The injection boundary precedes EVERY OCR-derived string — the region
  // texts are as verbatim as the page body, so it must come before both.
  const body = [
    ...header,
    ...(regionLines.length || plainText ? ['', FULLTEXT_INJECTION_BOUNDARY] : []),
    ...(regionLines.length ? ['', 'Regions:', ...regionLines] : []),
    ...(plainText ? ['', plainText] : []),
  ];
  const text = truncateText(body.join('\n'), PER_CHANNEL_RESULT_BUDGET);

  return { structured, text };
}
