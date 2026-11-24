// Windows a (normalized) full-text blob into a bounded, stateless page and
// renders both response channels. Offsets are character positions into the
// normalized text, so paging is deterministic and repeatable across calls.

import { FULLTEXT_INJECTION_BOUNDARY, OCR_SOURCE_NOTE } from '../config.js';
import { viewerLine } from './image.js';

// Collapse the OCR's ragged whitespace so windows carry more signal per char:
// trim trailing spaces per line, cap blank-line runs at one, trim the ends.
export function normalizeOcrText(raw) {
  return raw
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Slice [offset, offset+maxChars), snapping the end back to the last whitespace
// so we don't cut a word mid-token (unless we're already at the document end).
// A line matching `unbreakable` is never cut: the window ends before it instead.
export function windowText(full, offset, maxChars, { unbreakable = null } = {}) {
  const total = full.length;
  // Truncate (not `| 0`, which is 32-bit and wraps offsets > 2^31 to negative,
  // silently restarting at the start of the book) and clamp into [0, total] so
  // an over-range offset lands at end-of-text rather than page one.
  const off = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  const start = Math.min(Math.max(0, off), total);
  let end = Math.min(start + maxChars, total);
  if (end < total) {
    const snap = Math.max(full.lastIndexOf('\n', end), full.lastIndexOf(' ', end));
    if (snap > start) end = snap;
    if (unbreakable) {
      const lineStart = full.lastIndexOf('\n', end - 1) + 1;
      const nl = full.indexOf('\n', lineStart);
      const lineEnd = nl === -1 ? total : nl;
      if (end < lineEnd && lineStart > start && unbreakable.test(full.slice(lineStart, lineEnd))) end = lineStart;
    }
  }
  const text = full.slice(start, end);
  const hasMore = end < total;
  return {
    text,
    total,
    start,
    end,
    returned: text.length,
    hasMore,
    nextOffset: hasMore ? end : null,
  };
}

// Scan pages joined under a marker line each, so any window of the result can
// be cited by scan page. A blank page keeps its marker rather than vanishing, so
// the page run stays visibly contiguous. The marker's one spelling is here: the
// window parser below reads it back.
const pageMarker = (page, note = '') => `--- page ${page}${note} ---`;
const PAGE_MARKER_LINE = /^--- page (\d+)(?: \([^)\n]*\))? ---$/;
const PAGE_MARKERS = new RegExp(PAGE_MARKER_LINE.source, 'gm');

export function joinPages(pages) {
  return pages
    .map(({ page, text }) => (text ? `${pageMarker(page)}\n${text}` : pageMarker(page, ' (no text)')))
    .join('\n\n');
}

// The first and last page a window of joined pages holds text from, and whether
// it opens mid-page. A window after the first starts wherever the previous one
// stopped, so the span's own page_from would misattribute its opening lines.
function windowPages(full, w) {
  const lead = w.text.length - w.text.trimStart().length;
  const first = w.start + lead;
  const last = w.start + w.text.trimEnd().length - 1;
  if (last < first) return null;
  let from = null;
  let to = null;
  let opensOnMarker = false;
  for (const m of full.matchAll(PAGE_MARKERS)) {
    if (m.index + m[0].length - 1 > last) break;
    if (m.index <= first) { from = Number(m[1]); opensOnMarker = m.index === first; }
    to = Number(m[1]);
  }
  return from == null ? null : { from, to, continued: !opensOnMarker };
}

// `pageFrom`/`pageTo` are the span read (null when reading the whole book), and
// stay the continuation's arguments; `window_page_from/to` are the pages this
// window holds. `lastPage` is the volume's last page, known only when the
// requested range ran past it.
export function buildFullTextResponse({
  scanId, recordId, full, url, offset, maxChars,
  pageFrom = null, pageTo = null, lastPage = null, viewerUrlFor = null,
}) {
  const w = windowText(full, offset, maxChars, { unbreakable: pageFrom != null ? PAGE_MARKER_LINE : null });
  const wp = pageFrom != null ? windowPages(full, w) : null;
  const structured = {
    scan_id: scanId,
    id: recordId || null,
    page_from: pageFrom,
    page_to: pageTo,
    window_page_from: wp?.from ?? null,
    window_page_to: wp?.to ?? null,
    last_page: lastPage,
    viewer_url: wp && viewerUrlFor ? viewerUrlFor(wp.from) : null,
    source_url: url,
    total_chars: w.total,
    offset: w.start,
    returned_chars: w.returned,
    next_offset: w.nextOffset,
    has_more: w.hasMore,
    ocr_note: OCR_SOURCE_NOTE,
    text: w.text,
  };
  return { structured, text: renderFullTextText(structured, w, wp?.continued) };
}

function renderFullTextText(s, w, continued) {
  const pct = s.total_chars ? Math.round((w.end / s.total_chars) * 100) : 100;
  const narrower = s.window_page_from != null && (w.start > 0 || w.hasMore);
  const pages = s.page_from != null
    ? `, scan pages ${s.page_from}–${s.page_to}${narrower ? ` (this window: ${s.window_page_from}–${s.window_page_to})` : ''}`
    : '';
  const ends = s.last_page != null ? ` The volume ends at page ${s.last_page}.` : '';
  const header = [
    `Full text — scan ${s.scan_id}${s.id ? ` (record ${s.id})` : ''}${pages}.${ends}`,
    `Characters ${w.start.toLocaleString('en-US')}–${w.end.toLocaleString('en-US')} of ` +
      `${s.total_chars.toLocaleString('en-US')} (${pct}%). ${s.ocr_note}`,
    ...(s.viewer_url ? [viewerLine(s.viewer_url, s.window_page_from)] : []),
  ];
  const span = s.page_from != null ? ' with the same page_from/page_to' : '';
  const footer = s.has_more
    ? ['', `--- More available. Request offset ${s.next_offset}${span} to continue. ---`]
    : ['', '--- End of text. ---'];
  const body = continued ? `${pageMarker(s.window_page_from, ' (continued)')}\n${s.text.trimStart()}` : s.text;
  return [...header, '', FULLTEXT_INJECTION_BOUNDARY, body, ...footer].join('\n');
}
