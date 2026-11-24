// Resolves {scanId, page, longEdge} to a IIIF Image API URL and shapes the
// sgbr_inspect_image response. The URL grammar and page-id formatting are
// spike-confirmed (rdv-iiif-images.md *(internal)*).

import {
  IMAGE_ENDPOINT_BASE, DEFAULT_IMAGE_LONG_EDGE, MAX_IMAGE_LONG_EDGE, MAX_IMAGE_BYTES,
  FRONTEND_BASE_URL,
} from '../config.js';
import { visualTokens } from './vision.js';

// Format one pct coordinate: clamp into [0,100], round to 2 decimals, and
// strip float noise (Number() drops trailing zeros) so URLs stay canonical
// cache keys. Shared with sgbr_get_page_ocr's bbox→region_pct conversion so both
// producers of a `region_pct` round and clamp identically.
export function pctSeg(n) {
  return Number(Math.min(Math.max(0, n), 100).toFixed(2));
}

// Format a gbooks page segment: 1-based, zero-padded to 8 digits. The schema
// validates `page`, but this builds a URL path segment — treat it defensively so
// no caller can smuggle a non-numeric value into the path. Shared with
// sgbr_get_page_ocr's OCR-asset URLs so the one grammar lives in one place.
export function gbooksPageSegment(page) {
  return String(Math.max(1, Math.trunc(Number(page) || 1))).padStart(8, '0');
}

// Shareable front-end viewer deep-link for a record, optionally opened at a
// scanned page (`?page=N`). Null when there's no record id (e.g. a scan_id-only
// call) — the portal is keyed by record id. The one place this grammar lives.
export function viewerUrl(recordId, page) {
  if (!recordId) return null;
  const base = `${FRONTEND_BASE_URL}/en/detail/${recordId}`;
  return page != null ? `${base}?page=${page}` : base;
}

// The text channel's line for a viewer_url, so every tool words the link alike. `page`
// names the page the link opens when the line does not already say it.
export function viewerLine(url, page) {
  return `View online${page != null ? ` (page ${page})` : ''}: ${url}`;
}

// The `/gbooks/{scanId}_{page}.jp2` prefix both addressable forms share. One
// helper so the image and info.json URLs cannot drift apart.
function gbooksImageBase(scanId, page) {
  return `${IMAGE_ENDPOINT_BASE}/gbooks/${encodeURIComponent(scanId)}_${gbooksPageSegment(page)}.jp2`;
}

// IIIF Image API description for one page — the source of the NATIVE pixel
// dimensions the delivery clamp needs. Same host and path grammar as imageUrl.
export function imageInfoUrl({ scanId, page = 1 }) {
  return `${gbooksImageBase(scanId, page)}/info.json`;
}

/**
 * Native pixel size of the region a `region_pct` addresses, given the page's own
 * native dimensions. `{ width: 0, height: 0 }` when the page dimensions are
 * unknown, so callers can tell "no region clamp available" from a real size.
 *
 * Measures the ROUNDED percentages the URL actually carries, and clips overhang
 * the way the server does: a region starting inside the page but running past its
 * edge comes back clipped, not scaled, so its real width is the part that landed.
 */
export function regionPixelDims(regionPct, nativeWidth, nativeHeight) {
  if (!(nativeWidth > 0) || !(nativeHeight > 0)) return { width: 0, height: 0 };
  if (!Array.isArray(regionPct) || regionPct.length !== 4) {
    return { width: nativeWidth, height: nativeHeight };
  }
  const [x, y, w, h] = regionPct.map(pctSeg);
  const spanX = Math.max(0, Math.min(100, x + w) - x);
  const spanY = Math.max(0, Math.min(100, y + h) - y);
  return {
    width: Math.max(1, Math.round(nativeWidth * spanX / 100)),
    height: Math.max(1, Math.round(nativeHeight * spanY / 100)),
  };
}

/**
 * Dimensions from a JPEG's frame header, or null if the bytes aren't a JPEG we
 * can read. The mediaserver treats the confined box as advisory — it overshot by
 * up to 42px whenever it upscaled — so what was delivered is read from the bytes
 * rather than predicted from the request.
 */
export function jpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;
  let i = 2;
  while (i + 1 < buffer.length) {
    if (buffer[i] !== 0xFF) { i += 1; continue; }
    const marker = buffer[i + 1];
    if (marker === 0xFF) { i += 1; continue; } // fill byte
    // Standalone markers carry no length field.
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    if (i + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0–SOF15 carry the frame size; DHT/JPG/DAC sit in the same range and don't.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      if (i + 9 > buffer.length) return null;
      return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
    }
    i += 2 + length;
  }
  return null;
}

// Build the IIIF Image API URL for one page, capping the LONG edge at `longEdge`.
// `!w,h` = confined box (fit inside w×h, aspect preserved) → max(width,height) ≤ w.
// Keep the exact formatting here and in gbooksPageSegment — the only places to fix
// if the mediaserver renames identifiers or changes its size grammar.
export function imageUrl({ scanId, page = 1, longEdge = DEFAULT_IMAGE_LONG_EDGE, regionPct = null }) {
  const edge = Math.min(Math.max(1, Math.trunc(longEdge)), MAX_IMAGE_LONG_EDGE);
  // Region: percent form (`pct:x,y,w,h`, top-left origin) or the whole page. The
  // mediaserver clamps out-of-range regions itself but 400s on zero area
  // (rdv-iiif-images.md region addendum *(internal)*), so the tool schema rejects
  // w/h < 0.01 before we ever build a URL — 0.01 (not 0) because pctSeg's 2-decimal
  // rounding would turn a smaller width into a zero-area URL behind the schema's
  // back. Never emit the v3 `^` upscale prefix (the server rejects it) or the size
  // keyword `full` (removed in v3 — the size slot here is always `!N,N`).
  // Withholding `^` does NOT prevent upscaling: the server enlarges a region smaller
  // than the box regardless, and its info.json does not list `sizeUpscaling` either.
  // Only the caller-side clamp (src/lib/vision.js) stops it.
  const region = Array.isArray(regionPct) && regionPct.length === 4
    ? `pct:${regionPct.map(pctSeg).join(',')}`
    : 'full';
  return `${gbooksImageBase(scanId, page)}/${region}/!${edge},${edge}/0/default.jpg`;
}

// A gbooks page segment is 1-based; reject 0 / non-positive / non-numeric.
function toPage(digits) {
  const n = Number(digits);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// The inverse of imageUrl's `/gbooks/{scanId}_{page}.jp2` path grammar. The
// backend echoes that same `{scanId}_{page}` pairing in two places for a foldout
// plate that has no scan id of its own — the plate's thumbnail URL and its own
// record id — and these two parsers recover { scanId, page } from each. Keeping
// the grammar AND its inverse in this one file is what the imageUrl comment above
// promises: rename the identifiers or change the size grammar here and nowhere
// else. Each returns null when the input isn't this shape (or the page isn't 1+).
const GBOOKS_IMAGE_URL_RE = /\/gbooks\/([^/]+)_(\d{4,})\.jp2/;
const GBOOKS_ID_RE = /^(.+)_(\d{4,})$/;

export function parseGbooksImageUrl(url) {
  const m = GBOOKS_IMAGE_URL_RE.exec(url || '');
  const page = m && toPage(m[2]);
  return page ? { scanId: m[1], page } : null;
}

export function parseGbooksId(id) {
  const m = GBOOKS_ID_RE.exec(id || '');
  const page = m && toPage(m[2]);
  return page ? { scanId: m[1], page } : null;
}

export function buildImageResponse({ scanId, recordId, page, longEdge, regionPct, buffer, mimeType, url }) {
  // Null over the receiving client's per-image budget (10 MB on claude.ai and the
  // Claude API, 5 MB on Bedrock/Vertex — sized for the smaller); the caller turns
  // it into a ToolError telling the LLM to lower `max_long_edge`.
  const data = buffer.length > MAX_IMAGE_BYTES ? null : buffer.toString('base64');
  // What actually arrived, read from the bytes. `long_edge` is the box that was
  // requested after clamping; these are the pixels behind it, and the two differ
  // whenever the server rounds. Null when the body isn't a readable JPEG.
  const delivered = jpegDimensions(buffer);
  const structured = {
    scan_id: scanId,
    id: recordId || null,
    page,
    long_edge: longEdge,
    delivered_width: delivered?.width ?? null,
    delivered_height: delivered?.height ?? null,
    visual_tokens: delivered ? visualTokens(delivered.width, delivered.height) : null,
    region_pct: regionPct ?? null,
    mime_type: mimeType,
    byte_size: buffer.length,
    source_url: url,
    // Human-openable portal deep-link for this exact page (mirrors
    // sgbr_get_record's viewer_url). Null when the caller came in via scan_id
    // only — the portal is keyed by record id, which we then lack.
    viewer_url: viewerUrl(recordId, page),
  };
  return { data, structured };
}
