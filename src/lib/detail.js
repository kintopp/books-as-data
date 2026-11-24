// Shapes a raw RDV `Result` (from get(id)) into a curated, token-bounded detail
// record. Unlike the search shaper (record.js), this reads the `link`/`extended`
// sidecars where RDV keeps its richest data: CSL-JSON citation, IIIF manifests,
// GND/GeoNames authorities, full-text links. Bulk media file lists (hundreds of
// per-page entries) are summarized to counts + license, never enumerated.

import {
  DEFAULT_THUMBNAIL_WIDTH, PER_CHANNEL_RESULT_BUDGET, GRAPHQL_ENDPOINT,
  RECORD_KEY_ALIASES, AGENT_KEYS, FULLTEXT_AVAILABILITY_RE, FOLDOUT_RE,
} from '../config.js';
import { parseGbooksImageUrl, parseGbooksId, viewerLine, viewerUrl } from './image.js';
import { prune } from './prune.js';
import { truncateText } from './ocr.js';
import { fullTextUrl } from '../fulltext/client.js';

// --- low-level accessors over the flat key → [{text, link, extended}] shape ---
function entries(record, key) {
  return record.result?.find((m) => m.key === key)?.metadata || [];
}
function text(record, key) {
  return entries(record, key)[0]?.text || '';
}
function texts(record, key) {
  return entries(record, key).map((m) => m.text).filter(Boolean);
}
function link(record, key) {
  return serviceUrl(entries(record, key)[0]?.link || '');
}
// A `graphql:/…` link is relative to the GraphQL service root, so it resolves
// against the configured endpoint and follows SGBR_GRAPHQL_ENDPOINT to whatever
// host serves this index. Anything else passes through.
function serviceUrl(url) {
  if (!url.startsWith('graphql:/')) return url;
  return new URL(url.slice('graphql:/'.length), GRAPHQL_ENDPOINT).href;
}
// The record's own full-text links name an internal host; rebuild the URL on
// the configured public endpoint so answers never hand a user that host.
function publicFullTextUrl(record) {
  const url = linkAny(record, 'full_text_url');
  const scan = url.match(/\/get_gb_fulltext\/([^/?#]+)$/)?.[1];
  return scan ? fullTextUrl(decodeURIComponent(scan)) : url;
}
function parse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}
function ext(record, key) {
  return parse(entries(record, key)[0]?.extended);
}

// First non-empty value across a logical field's known physical keys — the one
// place a backend projection-key rename has to be absorbed (RECORD_KEY_ALIASES).
function textAny(record, logical) {
  for (const key of RECORD_KEY_ALIASES[logical] || []) {
    const v = text(record, key);
    if (v) return v;
  }
  return '';
}
function linkAny(record, logical) {
  for (const key of RECORD_KEY_ALIASES[logical] || []) {
    const v = link(record, key);
    if (v) return v;
  }
  return '';
}
// Every value of the logical field across all its physical keys. Unlike textAny
// this CONCATENATES rather than picks: `notes` is a list and its keys can
// coexist. Deliberately NOT de-duplicated — repeated values are legitimate
// catalogue data, and collapsing them would quietly shrink a list the size caps
// exist to bound.
function textsAny(record, logical) {
  return (RECORD_KEY_ALIASES[logical] || []).flatMap((key) => texts(record, key));
}

// The availability CLASS string (Digitalisat (Volltext) / kein Digitalisat /
// Digitalisat (extern) / Falttafel — and the older spellings Volltext / nur
// Metadaten / Scans (nicht durchsuchbar) / Einzelseite (Falttafel)). One place owns
// the key precedence so the derived `full_text_available` boolean and the surfaced
// `availability` string can never read different keys.
function availabilityClass(record) {
  return textAny(record, 'availability') || null;
}

// Merge the agent keys by display name, unioning roles and collecting authority
// links (GND/GeoNames).
function buildAgents(record) {
  const byName = new Map();
  for (const key of AGENT_KEYS) {
    for (const m of entries(record, key)) {
      const name = m.text;
      if (!name) continue;
      const cur = byName.get(name) || { name, roles: [], authorities: [] };
      const e = parse(m.extended);
      for (const role of e?.roles || []) {
        if (!cur.roles.includes(role)) cur.roles.push(role);
      }
      for (const a of e?.authorities || []) {
        if (a.link && !cur.authorities.some((x) => x.url === a.link)) {
          cur.authorities.push({ type: a.text || 'authority', url: a.link });
        }
      }
      byName.set(name, cur);
    }
  }
  return [...byName.values()];
}

// License lives flat on media.extended.content[] (license/licenseUrl) or nested
// under mediaNew's metadata.license[]. Pull the first we find.
function buildLicense(record) {
  const flat = ext(record, 'media')?.content?.find((c) => c.license);
  if (flat) return { label: flat.license, url: flat.licenseUrl || null };
  const nested = ext(record, 'mediaNew')?.content
    ?.map((c) => c.metadata?.license?.[0])
    .find(Boolean);
  if (nested) return { label: nested.text, url: nested.link || null };
  return null;
}

// The record's OWN entry in `mediaIiif`, matched by manifest URL rather than
// taken first: a work lists one entry per digitised volume and a plate lists its
// parent volume's too, so `content[0]` can carry another object's ARK and dates.
function ownIiifEntry(record, entries) {
  const own = `/iiif/${record.id}/manifest`;
  return entries.find((c) => c.url?.endsWith(own)) || null;
}

function buildDigital(record) {
  const available = availabilityClass(record);
  const media0 = ext(record, 'media')?.content?.[0] || ext(record, 'mediaNew')?.content?.[0];
  const acl = media0?.acl || [];
  const thumb = link(record, 'thumbnail');
  const iiif = ext(record, 'mediaIiif')?.content || [];
  const own = ownIiifEntry(record, iiif)?.metadata;
  const ark = own?.pid?.[0];
  const scans = getScanIds(record);
  return prune({
    scan_id: scans[0] || null,
    scan_ids: scans.length > 1 ? scans : null,
    // Matched, not compared — see the vocabulary note in config.js.
    full_text_available: FULLTEXT_AVAILABILITY_RE.test(available || ''),
    iiif_manifest: getManifestUrl(record) || null,
    thumbnail: thumb ? thumb.replace('{$widthInPx}', String(DEFAULT_THUMBNAIL_WIDTH)) : null,
    full_text_url: publicFullTextUrl(record) || null,
    persistent_urn: link(record, 'locationDigital') || null,
    // The platform's citable persistent id. Only Google-scanned volumes carry
    // one in the API — works, plates and external scans don't. Present it as an
    // identifier beside viewer_url, not as the link: the resolver chain behind
    // ark_url can dead-end in a 404 while the id itself stays valid.
    ark: ark?.text || null,
    ark_url: ark?.link || null,
    // Google re-runs images and OCR and the platform keeps only the latest run,
    // so the text behind a scan id can change; this date is the site's marker
    // for which run is served ("process date" on the detail page).
    processed_on: own?.lastUpdateDate?.[0]?.text || null,
    file_count: text(record, 'fileCount') || text(record, 'mediaContent') || null,
    // Whole-volume bulk exports — the corpus is a research platform, so "give me
    // every page's OCR at once" is a first-class need the per-page tools serve
    // only expensively. Absent on records without a digitisation, so they prune.
    scans_zip_url: linkAny(record, 'scans_zip_url') || null,
    ocr_zip_url: linkAny(record, 'ocr_zip_url') || null,
    license: buildLicense(record),
    access: acl.includes('global/guest') ? 'public' : (acl.length ? acl : null),
    scanned_at: text(record, 'sgbrScanAt') || null,
  });
}

// Build a short human-readable citation from the CSL-JSON payload.
function formatCitation(csl) {
  if (!csl) return null;
  const authors = (csl.author || [])
    .map((a) => a.literal || [a.family, a.given].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ');
  const year = csl.issued?.raw || csl.issued?.['date-parts']?.[0]?.[0] || '';
  const parts = [
    authors && `${authors}.`,
    csl.title && `${csl.title}.`,
    [csl['publisher-place'], csl.publisher].filter(Boolean).join(': '),
    year && `${year}.`,
  ].filter(Boolean);
  return parts.join(' ') || null;
}

export function toDetailRecord(record) {
  const csl = ext(record, 'cslItem');
  const detail = {
    id: record.id,
    title: textAny(record, 'title') || null,
    authors: buildAgents(record),
    date: textAny(record, 'date') || null,
    place: textAny(record, 'place') || null,
    publisher: csl?.publisher || null,
    origin: text(record, 'originInfoPublication') || null,
    language: textsAny(record, 'language'),
    resource_type: textAny(record, 'resource_type') || null,
    // The availability CLASS (German): Digitalisat (Volltext) / kein Digitalisat
    // / Digitalisat (extern) / Falttafel — the reliably-populated signal that
    // tells a foldout plate from a partner-scanned or metadata-only record, which the
    // derived `digital.full_text_available` boolean collapses. Neither shaper adds
    // `object_type` beside it: the per-record `sgbrObjectType` is a display value
    // in a different vocabulary from the facet (works and multivolume parents
    // empty, plates `Falttafel` where the facet says `Einzelseite`, metadata-only
    // records `Kein Digitalisat`), so it would not round-trip into `filters`.
    availability: availabilityClass(record),
    extent: text(record, 'physicalDescriptionExtentFull')
      || text(record, 'physicalDescriptionExtent') || null,
    image_description: textAny(record, 'image_description') || null,
    subjects: texts(record, 'subjectLocal'),
    // Keys match the query-side dimension names (FACET_DIMENSIONS), so a value
    // read here round-trips directly into a search/facet `filters` narrowing.
    classification: prune({
      topic: texts(record, 'enrichmentDdc'),
      subject_area: texts(record, 'enrichmentFachgebiet'),
    }),
    series: texts(record, 'relatedItemSeriesEntries'),
    table_of_contents: texts(record, 'tableOfContents'),
    notes: textsAny(record, 'notes'),
    call_number: textAny(record, 'call_number') || null,
    holding: text(record, 'locationHolding') || null,
    record_identifier: text(record, 'recordIdentifier') || record.id,
    // Shareable front-end viewer link; append `?page=N` to open a scanned page.
    viewer_url: viewerUrl(record.id),
    digital: buildDigital(record),
    citation: prune({ csl, formatted: formatCitation(csl) }),
  };
  // Prune everything except the always-present anchors, so callers can rely on
  // `id` / `title` existing even when a record is sparse.
  const pruned = prune(detail) || {};
  pruned.id = detail.id;
  if (!pruned.title) pruned.title = detail.title || '(untitled)';
  return pruned;
}

export function isEmptyRecord(record) {
  return !record || !record.id || !(record.result?.length);
}

// The digitised-scan id (e.g. "UBBS-00190048") that keys the REST full-text /
// IIIF services. Empty string when the record has no digitisation.
export function getScanId(record) {
  return getScanIds(record)[0] || '';
}
// Every scan a record carries: one for a volume or single-volume work; a
// multivolume or multi-copy work lists its volumes' and copies' scans.
export function getScanIds(record) {
  return texts(record || {}, 'sgbrScannedDigIds');
}
// What a record listing several scans holds — the phrase its error and result text share.
export const MULTI_SCAN_KINDS = 'the volumes of a multivolume work, or copies held by different libraries';

// A scan list for model-facing text, capped so a long multivolume work stays short.
export function formatScanIds(scans, max = 20) {
  return scans.slice(0, max).join(', ') + (scans.length > max ? `, … (${scans.length - max} more)` : '');
}

// The record's own IIIF manifest URL — for a multivolume work, the Collection
// manifest listing its volumes. Empty string when there is none.
export function getManifestUrl(record) {
  return record ? link(record, 'iiifManifest') : '';
}

// Positive evidence that a record is a foldout plate: its object type or its
// availability class. Both are matched against FOLDOUT_RE rather than compared to a
// pinned value — the backend has spelled this class `Falttafel`, `Einzelseite
// (Falttafel)` and `Einzelseite` across two releases, and an equality test silently
// stops recognising plates the day it is renamed again. Gates the id-based scan
// derivation below, and — because a plate's `sgbrScannedDigIds` holds its PARENT's
// scan — it is also the ONLY reliable way for src/lib/resolve.js to tell a plate
// from an ordinary volume.
export function isFoldout(record) {
  return FOLDOUT_RE.test(text(record, 'sgbrObjectType'))
    || FOLDOUT_RE.test(availabilityClass(record) || '');
}

// The page image a record points at, as {scanId, page}. A foldout / Falttafel
// plate is one page of a parent volume, and the backend echoes that address
// (`{scanId}_{page}`) in two places: the plate's thumbnail URL
// (`…/gbooks/{scanId}_{page}.jp2/…`) and its own record id (e.g.
// "ZHBL-00036929_00000022" → scan "ZHBL-00036929", page 22). The grammar for both
// lives in image.js. Prefer the thumbnail URL — it is the authoritative,
// addressable image path. The record id is only a heuristic, so fall back to it
// ONLY for a record we can confirm is a foldout; otherwise an ordinary record
// whose id merely ends in `_<digits>` would resolve to a bogus scan. Returns null
// when nothing resolves — so a genuinely image-less record stays image-less.
//
// Callers must gate on isFoldout() themselves before treating a result as a
// plate: an ordinary volume's thumbnail is page 1 of its OWN scan and parses
// here just as happily.
export function deriveScanTarget(record) {
  if (!record) return null;
  return parseGbooksImageUrl(link(record, 'thumbnail'))
    || (isFoldout(record) ? parseGbooksId(record.id) : null);
}

// A single record is almost always a few KB, but an item with a huge authors /
// table of contents / notes list could blow the host's output budget. The record
// rides on both channels (text + structuredContent), so cap EACH to the
// per-channel budget (½ of the safe ceiling) — then their sum stays under the
// ceiling even if the host meters both together. Trim the unbounded arrays
// LARGEST FIRST (so a small innocent list is never sacrificed for a huge one),
// then drop the CSL blob, then — as a guarantee, not an expectation — drop any
// remaining non-anchor field. Anchors (id/title) survive.
const HEAVY_FIELDS = ['authors', 'table_of_contents', 'notes', 'subjects', 'series'];
const TRUNC_NOTE =
  '\n\n--- Detail truncated to fit size limits; some list fields were shortened. ---';

function jsonLen(obj) {
  return JSON.stringify(obj).length;
}

function capStructured(structured, budget) {
  if (jsonLen(structured) <= budget) return structured;
  // We only get here when the record already exceeds budget, so truncation is
  // certain — set the flag up front so its bytes are counted while we search for
  // the largest fitting prefix (otherwise adding it afterwards can tip us back
  // over the ceiling by the length of the flag itself).
  const out = { ...structured, truncated: true };
  // Trim the biggest contributor first: sorting by serialized size means a tiny
  // table_of_contents survives untouched when a huge notes list is the culprit.
  const candidates = HEAVY_FIELDS
    .filter((f) => Array.isArray(out[f]) && out[f].length)
    .sort((a, b) => jsonLen(out[b]) - jsonLen(out[a]));
  for (const field of candidates) {
    if (jsonLen(out) <= budget) break;
    // Binary-search the largest kept prefix that fits, so we serialise the record
    // O(log n) times instead of once per dropped entry (O(n²) on a huge field).
    const original = out[field];
    let lo = 0;
    let hi = original.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      out[field] = original.slice(0, mid);
      if (jsonLen(out) <= budget) lo = mid;
      else hi = mid - 1;
    }
    out[field] = original.slice(0, lo);
    if (!out[field].length) delete out[field];
  }
  if (jsonLen(out) > budget && out.citation) {
    out.citation = { note: 'omitted to fit size limits' };
  }
  // Backstop: the list-trimming above models the realistic overflows, but the
  // budget is a promise — enforce it against anything it didn't model (e.g. an
  // oversized field outside HEAVY_FIELDS) by dropping non-anchor fields,
  // largest first. Reached only when a record defeats every targeted trim.
  if (jsonLen(out) > budget) {
    const anchors = new Set(['id', 'title', 'truncated']);
    const droppable = Object.keys(out)
      .filter((k) => !anchors.has(k))
      .sort((a, b) => jsonLen(out[b]) - jsonLen(out[a]));
    for (const key of droppable) {
      if (jsonLen(out) <= budget) break;
      delete out[key];
    }
  }
  return out;
}

const TRIMMED_NOTE =
  '\n\n[Some lists (and possibly the citation) were trimmed to fit size limits; structuredContent.truncated is set.]';

export function buildRecordResponse(record) {
  const structured = capStructured(toDetailRecord(record), PER_CHANNEL_RESULT_BUDGET);
  // The `id:` anchor goes last, outside the cut, so neither the hard cut nor
  // the trim note can remove it.
  const idLine = `\n\nid: ${structured.id}`;
  const note = structured.truncated ? TRIMMED_NOTE : '';
  const body = truncateText(renderRecordText(structured), PER_CHANNEL_RESULT_BUDGET - idLine.length - note.length, TRUNC_NOTE);
  return { structured, text: body + note + idLine };
}

function renderRecordText(r) {
  const lines = [r.title || '(untitled)'];
  if (r.authors?.length) {
    lines.push(...r.authors.map((a) => {
      const roles = a.roles?.length ? ` (${a.roles.join(', ')})` : '';
      return `  by ${a.name}${roles}`;
    }));
  }
  const pub = [r.place, r.publisher, r.date].filter(Boolean).join(', ');
  if (pub) lines.push(pub);

  const facts = [];
  if (r.language?.length) facts.push(`Language: ${r.language.join('; ')}`);
  if (r.resource_type) facts.push(`Type: ${r.resource_type}`);
  if (r.availability) facts.push(`Availability: ${r.availability}`);
  if (r.extent) facts.push(`Extent: ${r.extent}`);
  if (r.call_number) facts.push(`Call number: ${r.call_number}`);
  if (facts.length) { lines.push('', ...facts); }

  if (r.image_description) lines.push('', `AI image description: ${r.image_description}`);
  if (r.subjects?.length) lines.push('', `Subjects: ${r.subjects.join('; ')}`);
  if (r.classification?.topic?.length) lines.push(`Topic: ${r.classification.topic.join('; ')}`);
  if (r.classification?.subject_area?.length) lines.push(`Subject area: ${r.classification.subject_area.join('; ')}`);
  if (r.series?.length) lines.push(`Series: ${r.series.join('; ')}`);
  // Notes carry load-bearing markers the rest of the render can't express — the
  // foldout's "nur eine einzelne Falttafel aus dem oben verlinkten Buch" above
  // all. Omitted here, they existed only in structuredContent, so a host that
  // forwards just the text channel hid a marker the guide tells the model to
  // read. Length is not a risk: capStructured already trimmed `notes` to the
  // per-channel budget before this runs.
  if (r.notes?.length) lines.push(`Notes: ${r.notes.join(' · ')}`);
  if (r.table_of_contents?.length) lines.push(`Contents: ${r.table_of_contents.join(' · ')}`);

  const d = r.digital || {};
  const dig = [];
  // Stated in BOTH directions, unlike the other flags: `full_text_available` is
  // false on foldouts and on `Digitalisat (extern)` records that do have per-page
  // OCR, so silence would read as "unknown" exactly where the distinction decides
  // which tool can reach the text. "No indexed full text" — never "no OCR".
  if (d.scan_id || d.full_text_available) {
    dig.push(d.full_text_available ? 'full text available' : 'no indexed full text');
  }
  if (d.scan_id) dig.push(`scan id ${d.scan_id}`);
  if (d.file_count) dig.push(d.file_count);
  if (d.license) dig.push(`license ${d.license.label}`);
  if (dig.length) lines.push('', `Digital: ${dig.join(' · ')}`);
  if (d.scan_ids) {
    lines.push(`  ${d.scan_ids.length} scans (${MULTI_SCAN_KINDS}): ${formatScanIds(d.scan_ids)} — pass one of them as scan_id; ` +
      'only sgbr_locate_text accepts this record\'s id, and it searches only the first');
  }
  if (d.iiif_manifest) lines.push(`  IIIF manifest: ${d.iiif_manifest}`);
  if (d.full_text_url) lines.push(`  Full text: ${d.full_text_url}`);
  if (d.ocr_zip_url) lines.push(`  OCR zip (whole volume, GET only): ${d.ocr_zip_url}`);
  if (d.scans_zip_url) lines.push(`  Scans zip (whole volume, GET only): ${d.scans_zip_url}`);
  if (d.persistent_urn) lines.push(`  Persistent URN: ${d.persistent_urn}`);
  if (d.ark) lines.push(`  ARK (persistent id): ${d.ark}`);
  if (d.processed_on) lines.push(`  Scan/OCR processed: ${d.processed_on} (re-processing can change the text)`);

  if (r.viewer_url) {
    const pageHint = r.digital?.scan_id ? ' (append ?page=N to open a scanned page)' : '';
    lines.push('', `${viewerLine(r.viewer_url)}${pageHint}`);
  }

  for (const a of r.authors || []) {
    for (const auth of a.authorities || []) lines.push(`  ${a.name} → ${auth.type}: ${auth.url}`);
  }
  if (r.citation?.formatted) lines.push('', `Citation: ${r.citation.formatted}`);
  return lines.join('\n');
}
