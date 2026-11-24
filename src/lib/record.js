// Shapes raw RDV `Result` records (flat key→metadata[] lists) into compact,
// token-frugal objects, and renders the human-readable text channel.

import {
  SEARCH_HIGHLIGHT_FIELD, SEARCH_SNIPPET_MAX_COUNT, SEARCH_SNIPPET_MAX_CHARS,
  MAX_RESULT_WINDOW, RECORD_KEY_ALIASES, AGENT_KEYS, FULLTEXT_AVAILABILITY_RE, DEFAULT_SORT, IMAGE_DESCRIPTION_MAX_CHARS,
} from '../config.js';
import { renderApplied } from './applied.js';
import { prune } from './prune.js';

function pick(record, key) {
  const mr = record.result?.find((m) => m.key === key);
  return mr?.metadata?.[0]?.text || '';
}
// First non-empty value across a logical field's known physical keys, so a
// backend key rename is absorbed by editing RECORD_KEY_ALIASES alone.
function pickAny(record, logical) {
  for (const key of RECORD_KEY_ALIASES[logical] || []) {
    const v = pick(record, key);
    if (v) return v;
  }
  return '';
}
function pickAll(record, key) {
  const mr = record.result?.find((m) => m.key === key);
  return (mr?.metadata || []).map((m) => m.text).filter(Boolean);
}
// Every value across a logical field's physical keys — the same reading as
// detail.js#textsAny, so sgbr_search and sgbr_get_record cannot disagree.
function pickAllAny(record, logical) {
  return (RECORD_KEY_ALIASES[logical] || []).flatMap((key) => pickAll(record, key));
}
// Elasticsearch refuses a page whose LAST result index (page × page_size) passes
// max_result_window. Shared by assertPageWindow and the has_more hint, so the
// hint never offers a page the guard refuses.
export const pastResultWindow = (page, pageSize) => page * pageSize > MAX_RESULT_WINDOW;
// The per-field cap every free-text value on a hit gets (snippets, descriptions).
const capChars = (str, max) => (str.length > max ? str.slice(0, max) + '…' : str);

// Flatten the RDV `highlights` Map into up to N cleaned, length-capped snippet
// strings from the full-text field — the only field sgbr_search highlights, so
// the response map is only ever empty or keyed by SEARCH_HIGHLIGHT_FIELD.
// Strips highlight markup generically (do not assume <em>), collapses OCR
// whitespace, and drops empties. Returns [] when there are no usable snippets.
//
// The tag NAME is anchored (a letter or `/` must follow `<`) rather than matching
// any `<…>` span: ES inserts its tags into the source verbatim without escaping
// what was already there, so a bare `<`/`>` pair in the OCR — "the ratio a < b
// and b > c" — is corpus text, not markup, and a `<[^>]+>` sweep would silently
// swallow everything between them. Every real highlighter tag (<em>, </em>,
// <mark>, <span …>) still matches.
//
// DELIBERATE: these fragments do NOT get the FULLTEXT_INJECTION_BOUNDARY line
// that fulltext/page-OCR/locate outputs carry. They are sub-sentence,
// highlighter-selected, markup-stripped excerpts (≤ SEARCH_SNIPPET_MAX_CHARS),
// and sgbr_search is the highest-frequency tool — a ⚠️ boundary on every search
// response would tax each call for the lowest-exposure surface. The boundary
// convention (config.js) applies to VERBATIM page text, not highlight fragments.
const HIGHLIGHT_TAG = /<\/?[a-zA-Z][^>]*>/g;

function extractSnippets(highlights) {
  const frags = highlights?.[SEARCH_HIGHLIGHT_FIELD];
  if (!Array.isArray(frags)) return [];
  const out = [];
  for (const frag of frags) {
    if (typeof frag !== 'string') continue;
    const clean = frag.replace(HIGHLIGHT_TAG, '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    out.push(capChars(clean, SEARCH_SNIPPET_MAX_CHARS));
    if (out.length >= SEARCH_SNIPPET_MAX_COUNT) break;
  }
  return out;
}

// A search-result-sized view of a record. Full detail (IIIF, citation, authorities)
// is sgbr_get_record's (src/lib/detail.js).
export function toCompactRecord(record) {
  const snippets = extractSnippets(record.highlights);
  const availability = pickAny(record, 'availability');
  const compact = {
    id: record.id, // guaranteed anchor — the pruned fields drop when empty
    ...prune({
      title: pickAny(record, 'title'),
      authors: [...new Set(AGENT_KEYS.flatMap((key) => pickAll(record, key)))],
      date: pickAny(record, 'date'),
      place: pickAny(record, 'place'),
      // Multi-valued per record (Latin-German volumes); each value is a filters.language value.
      language: pickAllAny(record, 'language'),
      resource_type: pickAny(record, 'resource_type'),
      availability,
      call_number: pickAny(record, 'call_number'),
      // Plates only, one sentence each — surfaced so a plate can be triaged by
      // what it depicts without an sgbr_inspect_image call.
      image_description: capChars(pickAny(record, 'image_description'), IMAGE_DESCRIPTION_MAX_CHARS),
    }),
    // Matched, not compared — the backend renames availability values between
    // releases; see the vocabulary note in config.js.
    full_text_available: FULLTEXT_AVAILABILITY_RE.test(availability),
  };
  if (snippets.length) compact.snippets = snippets;
  return compact;
}

// `sort` defaults here as well as in the tool schema: it is a required field of
// the declared output contract, so a caller that omits it must still produce a
// schema-valid response rather than an undefined the SDK validator rejects.
export function buildSearchResponse(search, { page, pageSize, sort = DEFAULT_SORT, applied } = {}) {
  const results = (search.results || []).map(toCompactRecord);
  const total = search.totalCount ?? search.countResult?.resultCount ?? results.length;
  const hasMore = page * pageSize < total;
  // A short page or the result window leaves no next page that continues this one.
  const short = isShortPage({ total, page, page_size: pageSize, returned: results.length });
  const structured = {
    total,
    page,
    page_size: pageSize,
    sort,
    returned: results.length,
    has_more: hasMore,
    next_page: hasMore && !short && !pastResultWindow(page + 1, pageSize) ? page + 1 : null,
    results,
  };
  // Echo the applied filters so structuredContent is self-describing / round-trippable.
  if (applied) structured.applied_filters = applied;
  if (search.parsedError) structured.parsed_error = search.parsedError;
  return { structured, text: renderSearchText(structured) };
}

// A page that comes back short while records remain past it means the backend
// capped the page below page_size; paging on at that size would skip the gap.
function isShortPage({ total, page, page_size: pageSize, returned }) {
  return Boolean(returned) && returned < pageSize && (page - 1) * pageSize + returned < total;
}

export function shortPageWarnings(s) {
  if (!isShortPage(s)) return [];
  const { page, page_size: pageSize, returned } = s;
  const offset = (page - 1) * pageSize;
  return [
    `The backend returned ${returned} of the ${pageSize} results requested although more remain. ` +
    `Results ${offset + returned + 1}–${offset + pageSize} were not returned, so paging on at ` +
    `page_size ${pageSize} would skip them. Re-request from page 1 with page_size ${returned} ` +
    '(page numbers shift with page_size).',
  ];
}

export function pastEndWarnings(s) {
  const { total, page, page_size: pageSize, returned } = s;
  if (!(total > 0) || returned !== 0 || (page - 1) * pageSize < total) return [];
  const last = Math.ceil(total / pageSize);
  return [
    `No records on this page: page ${page} is past the last page (${last}) of ${total} record(s) ` +
    `at page_size ${pageSize}; request page ${last} or lower.`,
  ];
}

function renderSearchText(s) {
  const order = s.sort && s.sort !== DEFAULT_SORT ? `, sorted by ${s.sort}` : '';
  const lines = [`Found ${s.total.toLocaleString('en-US')} record(s); showing ${s.returned} (page ${s.page}${order}).`];
  const applied = renderApplied(s.applied_filters);
  if (applied) lines.push(`Filters: ${applied}`);
  if (s.parsed_error) lines.push(`Parser note: ${s.parsed_error}`);
  lines.push('');
  s.results.forEach((r, i) => {
    const n = (s.page - 1) * s.page_size + i + 1;
    const meta = [r.date, r.place, r.language?.join('; '), r.resource_type].filter(Boolean).join(' · ');
    lines.push(`${n}. ${r.title || '(untitled)'}${r.authors?.length ? ' — ' + r.authors.join('; ') : ''}`);
    if (meta) lines.push(`   ${meta}`);
    lines.push(`   id: ${r.id}${r.full_text_available ? '  ·  full text available' : ''}`);
    if (r.image_description) lines.push(`   AI image description: ${r.image_description}`);
    if (r.snippets?.length) {
      for (const s of r.snippets) lines.push(`   … ${s} …`);
    }
  });
  // A short page's own warning says how to continue instead.
  if (s.next_page != null) {
    lines.push('', `More results available — request page ${s.next_page}.`);
  } else if (s.has_more && pastResultWindow(s.page + 1, s.page_size)) {
    lines.push('', `More results exist, but the next page is past the backend's ${MAX_RESULT_WINDOW}-record result window — narrow the query (filters, year range) to reach them.`);
  }
  return lines.join('\n');
}
