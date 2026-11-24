// Shared id → scan-id resolution for the scan-addressed tools. Accepts a record
// `id`, a `scan_id`, or both — the tools' input schemas take either.
// (Deliberately uncounted: this is imported by every tool that addresses a scan,
// and an enumeration here goes stale the moment one is added.)
//
// Only a record id we actually resolved the scan FROM is echoed back as
// `recordId`. When `scan_id` is given directly it is the source of truth, and an
// accompanying `id` is unverified — attaching it would misattribute this scan's
// content to a record we never looked up.

import { GET_RECORD_QUERY, SEARCH_QUERY } from '../graphql/operations.js';
import { graphqlRequest } from '../graphql/client.js';
import { isEmptyRecord, getScanIds, formatScanIds, deriveScanTarget, isFoldout, MULTI_SCAN_KINDS } from './detail.js';
import { buildSearchVariables } from '../search/compiler.js';
import { ToolError } from './errors.js';

/**
 * Resolve tool args to { scanId, recordId, page?, scanIds? }.
 * @param {{id?: string, scan_id?: string}} args  the tool's validated input
 * @param {object} cfg
 * @param {AbortSignal} [cfg.signal]
 * @param {{what: string, hint: string}} cfg.missing  per-tool error text when the
 *   record exists but has no scan: `Record "<id>" <what>.` + the hint.
 * @param {boolean} [cfg.allowDerivedScan]  for a fold-out plate, resolve to its
 *   parent scan plus the plate's own `page`, derived from its media URLs / id.
 *   Opt-in per tool, because "the parent scan" means different things
 *   to each: the page-addressed tools (sgbr_inspect_image, sgbr_get_page_ocr)
 *   land on the plate's own page and want it, while the whole-scan ones
 *   (sgbr_get_fulltext, sgbr_locate_text) would silently widen to the entire
 *   parent volume and keep erroring instead.
 * @param {boolean} [cfg.allowMultiScan]  accept a record listing several scans (the
 *   volumes of a multivolume work, or copies held by different libraries) and
 *   resolve it to the first. Off by default: the first scan is an arbitrary pick
 *   (one volume, one library's pagination), and echoing the work id back would
 *   label it as the whole work. sgbr_locate_text opts in because it enumerates
 *   sibling volumes itself, searches only the record for exactly one scan, and
 *   names the scans it left unsearched from `scanIds`.
 * @param {(derived: {scanId: string, page: number}) => {what: string, hint: string}}
 *   [cfg.missing.derived]  for a tool that refuses the derived scan: build the
 *   error text from what WAS derivable, so a plate gets pointed at the tools that
 *   can read it rather than a flat "no OCR" dead end.
 */
export async function resolveScanTarget({ id, scan_id: scanIdArg }, { signal, missing, allowDerivedScan = false, allowMultiScan = false }) {
  const providedRecordId = id?.trim() || null;
  // Scan ids are uppercase and every downstream id comparison is case-sensitive.
  const scanId = (scanIdArg?.trim() || '').toUpperCase();
  if (scanId) return { scanId, recordId: null };

  if (!providedRecordId) {
    throw new ToolError(
      'Provide either `id` (a record id) or `scan_id`.',
      'Use the id from an sgbr_search result, or digital.scan_id from sgbr_get_record.',
    );
  }
  const data = await graphqlRequest(GET_RECORD_QUERY, { id: providedRecordId }, { signal });
  const record = data?.get;
  if (isEmptyRecord(record)) {
    throw new ToolError(
      `No record found for id "${providedRecordId}".`,
      'Check the id — it must be a full record id from an sgbr_search result.',
    );
  }
  // Classify a fold-out plate on its TYPE, before reading any scan id. A plate
  // stands for one page of a parent volume, and its own `sgbrScannedDigIds` holds
  // that parent's id, so the scan id cannot tell the two apart: trusting it first
  // would resolve every plate to its whole book — silently, with the plate's own id
  // still attached.
  if (isFoldout(record)) {
    const plate = deriveScanTarget(record);
    if (plate && allowDerivedScan) {
      return { scanId: plate.scanId, recordId: providedRecordId, page: plate.page };
    }
    // Refusing (or unable to address the plate) — but never by falling through to
    // the scan id below, which is the parent volume this branch exists to keep
    // the request off. Say what we know when we know it.
    if (plate && missing.derived) {
      const { what, hint } = missing.derived(plate);
      throw new ToolError(`Record "${providedRecordId}" ${what}.`, hint);
    }
    throw new ToolError(`Record "${providedRecordId}" ${missing.what}.`, missing.hint);
  }

  const scans = getScanIds(record);
  if (scans.length > 1 && !allowMultiScan) {
    throw new ToolError(
      `Record "${providedRecordId}" lists ${scans.length} scans (${MULTI_SCAN_KINDS}): ${formatScanIds(scans)}.`,
      'Pass one of them as `scan_id`, or use that scan\'s own record (its id ends in `_<scan id>`; find it with sgbr_search scope "identifier"). sgbr_get_record lists them as digital.scan_ids.',
    );
  }
  const resolved = scans[0];
  if (resolved) {
    return { scanId: resolved, recordId: providedRecordId, scanIds: scans }; // verified: scan derived from this record
  }
  // Scan-less record (e.g. a foldout / Falttafel plate): its own id + media URLs
  // still encode {parentScan}_{page}. The page rides back as a default the
  // page-addressed tools use when the caller didn't pin one.
  const derived = deriveScanTarget(record);
  if (derived) {
    if (allowDerivedScan) {
      return { scanId: derived.scanId, recordId: providedRecordId, page: derived.page };
    }
    // Refusing, but we know exactly what this is — say so.
    if (missing.derived) {
      const { what, hint } = missing.derived(derived);
      throw new ToolError(`Record "${providedRecordId}" ${what}.`, hint);
    }
  }
  throw new ToolError(`Record "${providedRecordId}" ${missing.what}.`, missing.hint);
}

/**
 * The record id a page-addressed tool may echo for `page`. A fold-out plate
 * record stands for exactly ONE page (`platePage`, from resolveScanTarget);
 * any other page is the parent volume's content, so the plate id must not ride
 * along — the same reasoning as the scan_id-without-id case above.
 */
export function attributedRecordId({ recordId, page: platePage }, page) {
  return platePage != null && page !== platePage ? null : recordId;
}

/**
 * The record that stands for exactly one scan: a single-volume work, or a
 * volume record `id…_<scan>`. A scan id also matches the parent of a
 * multivolume or multi-copy work, which is never returned — it spans the other
 * volumes and copies. `recordId`, the caller's already-resolved record, answers
 * without a search when it is such a record. Null when the scan has none.
 */
export async function findScanRecordId(scanId, { recordId, signal } = {}) {
  const isVolume = (id) => id.endsWith(`_${scanId}`);
  const onlyThisScan = (record) => {
    const scans = getScanIds(record);
    return scans.length === 1 && scans[0] === scanId;
  };
  if (recordId) {
    if (isVolume(recordId)) return recordId;
    if (onlyThisScan((await graphqlRequest(GET_RECORD_QUERY, { id: recordId }, { signal }))?.get)) return recordId;
  }
  // Search hits carry the same `sgbrScannedDigIds` block a Get returns.
  const variables = buildSearchVariables({ query: scanId, scope: 'identifier', pageSize: 5 });
  const hits = (await graphqlRequest(SEARCH_QUERY, variables, { signal }))?.search?.results || [];
  const volume = hits.find((h) => isVolume(h.id));
  if (volume) return volume.id;
  return hits.length === 1 && onlyThisScan(hits[0]) ? hits[0].id : null;
}
