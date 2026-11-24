// Offline orchestration tests for resolveScanTarget (src/lib/resolve.js). These stub
// the GraphQL fetch so every branch — the scan_id fast path, id→scan resolution, the
// empty-record 200 (isEmptyRecord, not a 404), the scan-less error, and the
// foldout-derived fallback behind allowDerivedScan — runs in CI.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScanTarget, findScanRecordId } from '../src/lib/resolve.js';
import { SCOPE_FIELDS } from '../src/config.js';
import { clearGraphqlCache } from '../src/graphql/client.js';
import { ToolError } from '../src/lib/errors.js';

const realFetch = globalThis.fetch;
// Restore fetch AND drop the GraphQL response cache so each test's stub is
// actually reached (record ids are also unique per test, belt and braces).
afterEach(() => { globalThis.fetch = realFetch; clearGraphqlCache(); });

const MISSING = { what: 'has no digitised scan', hint: 'Try a record with full text.' };

// Minimal record in the backend's get() shape: `result` is the key/metadata
// sidecar list that getScanId / deriveScanTarget mine.
const record = (id, entries = []) => ({ id, result: entries });
const scanEntry = (scanId) => ({ key: 'sgbrScannedDigIds', metadata: [{ text: scanId }] });

// Stub the GraphQL POST to return one fixed record; returns a call counter so
// tests can assert whether the resolver hit the network at all.
function stubRecord(rec) {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ data: { get: rec } }) }; };
  return () => calls;
}

test('a direct scan_id bypasses GraphQL and returns recordId null', async () => {
  const calls = stubRecord(record('never-fetched'));
  const out = await resolveScanTarget({ scan_id: '  UBBS-00190048  ' }, { missing: MISSING });
  assert.deepEqual(out, { scanId: 'UBBS-00190048', recordId: null });
  assert.equal(calls(), 0, 'the scan_id fast path must not hit the network');
});

test('a lowercase scan_id is upper-cased so downstream id comparisons match', async () => {
  stubRecord(record('never-fetched'));
  const out = await resolveScanTarget({ scan_id: ' ubbs-00190048 ' }, { missing: MISSING });
  assert.equal(out.scanId, 'UBBS-00190048');
});

test('supplying both id and scan_id does not attribute the unverified id', async () => {
  // scan_id is the source of truth; echoing back an id we never looked up would
  // misattribute this scan's content to an unverified record.
  const calls = stubRecord(record('rec-unverified-1'));
  const out = await resolveScanTarget(
    { id: 'rec-unverified-1', scan_id: 'UBBS-00190048' },
    { missing: MISSING },
  );
  assert.deepEqual(out, { scanId: 'UBBS-00190048', recordId: null });
  assert.equal(calls(), 0);
});

test('a record id resolves to its scan id with a verified recordId', async () => {
  const calls = stubRecord(record('rec-scan-1', [scanEntry('UBBS-42')]));
  const out = await resolveScanTarget({ id: 'rec-scan-1' }, { missing: MISSING });
  assert.deepEqual(out, { scanId: 'UBBS-42', recordId: 'rec-scan-1', scanIds: ['UBBS-42'] });
  assert.equal(calls(), 1);
});

test('an empty record (HTTP 200, empty result) throws the actionable not-found ToolError', async () => {
  // The backend answers a bad id with 200 + an empty record, not a 404 — the
  // resolver must translate that into guidance, not pass the husk downstream.
  stubRecord({ id: 'rec-missing-1', result: [] });
  await assert.rejects(
    () => resolveScanTarget({ id: 'rec-missing-1' }, { missing: MISSING }),
    (e) => e instanceof ToolError
      && /No record found for id "rec-missing-1"/.test(e.message)
      && /sgbr_search/.test(e.suggestion),
  );
});

test('a scan-less record errors with the per-tool missing text when derivation is off', async () => {
  stubRecord(record('rec-noscan-1', [{ key: 'title', metadata: [{ text: 'A book' }] }]));
  await assert.rejects(
    () => resolveScanTarget({ id: 'rec-noscan-1' }, { missing: MISSING }),
    (e) => e instanceof ToolError
      && e.message === 'Record "rec-noscan-1" has no digitised scan.'
      && e.suggestion === MISSING.hint,
  );
});

test('a scan-less foldout derives its parent scan and page only under allowDerivedScan', async () => {
  // A foldout plate carries no sgbrScannedDigIds, but its thumbnail URL encodes
  // {parentScan}_{page} — the authoritative derivation source (see detail.js).
  const plate = () => record('ZHBL-00036929_00000022', [
    { key: 'thumbnail', metadata: [{ link: 'https://host/iiif/2/gbooks/ZHBL-00036929_00000022.jp2/full/!150,150/0/default.jpg' }] },
  ]);
  stubRecord(plate());
  const out = await resolveScanTarget(
    { id: 'ZHBL-00036929_00000022' },
    { missing: MISSING, allowDerivedScan: true },
  );
  assert.deepEqual(
    out,
    { scanId: 'ZHBL-00036929', recordId: 'ZHBL-00036929_00000022', page: 22 },
    'the derived target carries the parent scan, the verified record id, and the default page',
  );

  // The same record WITHOUT the opt-in must error: the whole-scan tools
  // (get_fulltext, locate_text) keep rejecting plates, since the parent scan
  // would widen the request past what the plate record stands for. Only the
  // page-addressed tools (inspect_image, get_page_ocr) derive.
  clearGraphqlCache();
  stubRecord(plate());
  await assert.rejects(
    () => resolveScanTarget({ id: 'ZHBL-00036929_00000022' }, { missing: MISSING }),
    (e) => e instanceof ToolError && /has no digitised scan/.test(e.message),
  );
});

test('a refusing tool can still phrase its error from what WAS derivable', async () => {
  // locate_text declines the derived scan (a page RANGE over the parent volume
  // is not what a one-page plate stands for) but should hand back the working
  // address rather than a flat "no OCR" dead end.
  stubRecord(record('ZHBL-00036929_00000022', [
    { key: 'thumbnail', metadata: [{ link: 'https://host/iiif/2/gbooks/ZHBL-00036929_00000022.jp2/full/!150,150/0/default.jpg' }] },
  ]));
  await assert.rejects(
    () => resolveScanTarget({ id: 'ZHBL-00036929_00000022' }, {
      missing: {
        ...MISSING,
        derived: ({ scanId, page }) => ({
          what: 'is a single fold-out plate',
          hint: `It is page ${page} of scan "${scanId}".`,
        }),
      },
    }),
    (e) => e instanceof ToolError
      && e.message === 'Record "ZHBL-00036929_00000022" is a single fold-out plate.'
      && e.suggestion === 'It is page 22 of scan "ZHBL-00036929".',
  );
});

test('a scan-less NON-foldout record ignores missing.derived and uses the flat text', async () => {
  // The hook must only fire when there is something to derive; an ordinary
  // scan-less record has no plate address to offer.
  stubRecord(record('rec-noscan-2', [{ key: 'title', metadata: [{ text: 'A book' }] }]));
  await assert.rejects(
    () => resolveScanTarget({ id: 'rec-noscan-2' }, {
      missing: { ...MISSING, derived: () => ({ what: 'SHOULD NOT FIRE', hint: 'nope' }) },
    }),
    (e) => e instanceof ToolError && e.message === 'Record "rec-noscan-2" has no digitised scan.',
  );
});

// ── A plate carries its PARENT's scan id ─────────────────────────────────────
// The tests above model a scan-less plate. The current index fills a plate's
// `sgbrScannedDigIds` with the parent VOLUME's scan, so trusting the scan id would
// resolve every plate to its whole book (inspect_image returning parent page 1,
// get_fulltext the parent's full text, the whole-scan refusal never firing). The
// plate must be recognised by TYPE before any scan id is read.

const newIndexPlate = (id, parentScan) => record(id, [
  scanEntry(parentScan), // the PARENT volume's scan — not the plate's own
  { key: 'availableData', metadata: [{ text: 'Falttafel' }] },
  { key: 'thumbnail', metadata: [{ link: `https://host/iiif/3/gbooks/${id}.jp2/full/400,/0/default.jpg` }] },
]);

test('a plate carrying its parent scan id still resolves to the plate page, not the whole volume', async () => {
  stubRecord(newIndexPlate('ZBZ-00138157_00000165', 'ZBZ-00138157'));
  const out = await resolveScanTarget(
    { id: 'ZBZ-00138157_00000165' },
    { missing: MISSING, allowDerivedScan: true },
  );
  assert.deepEqual(out, {
    scanId: 'ZBZ-00138157',
    recordId: 'ZBZ-00138157_00000165',
    page: 165,
  }, 'the plate page must survive the parent scan id being present');
});

test('a whole-scan tool still refuses a plate that carries its parent scan id', async () => {
  stubRecord(newIndexPlate('ZBZ-00138157_00000165', 'ZBZ-00138157'));
  await assert.rejects(
    () => resolveScanTarget({ id: 'ZBZ-00138157_00000165' }, {
      missing: {
        ...MISSING,
        derived: ({ scanId, page }) => ({
          what: 'is a single fold-out plate',
          hint: `It is page ${page} of scan "${scanId}".`,
        }),
      },
    }),
    (e) => e instanceof ToolError
      && e.message === 'Record "ZBZ-00138157_00000165" is a single fold-out plate.'
      && e.suggestion === 'It is page 165 of scan "ZBZ-00138157".',
    'without allowDerivedScan a plate must error, never widen to its parent volume',
  );
});

test('a plate recognised by object_type refuses even when its page is underivable', async () => {
  // No thumbnail and an id with no page suffix: we cannot address the plate, but
  // we can still tell it is one — so the parent scan must not be handed back as
  // if it were the plate's own.
  stubRecord(record('rec-plate-unaddressable', [
    scanEntry('UBBS-99'),
    { key: 'sgbrObjectType', metadata: [{ text: 'Einzelseite' }] },
  ]));
  await assert.rejects(
    () => resolveScanTarget({ id: 'rec-plate-unaddressable' }, { missing: MISSING, allowDerivedScan: true }),
    (e) => e instanceof ToolError && e.message === 'Record "rec-plate-unaddressable" has no digitised scan.',
  );
});

test('an ordinary volume is unaffected: its own scan id wins over its page-1 thumbnail', async () => {
  // The regression guard must not overreach — a normal record's thumbnail is
  // page 1 of its OWN scan and parses as a plate address just as happily.
  stubRecord(record('rec-volume-1', [
    scanEntry('UBBS-00190048'),
    { key: 'availableData', metadata: [{ text: 'Digitalisat (Volltext)' }] },
    { key: 'thumbnail', metadata: [{ link: 'https://host/iiif/3/gbooks/UBBS-00190048_00000001.jp2/full/400,/0/default.jpg' }] },
  ]));
  const out = await resolveScanTarget({ id: 'rec-volume-1' }, { missing: MISSING, allowDerivedScan: true });
  assert.deepEqual(out, { scanId: 'UBBS-00190048', recordId: 'rec-volume-1', scanIds: ['UBBS-00190048'] });
  assert.equal('page' in out, false, 'an ordinary volume must not acquire a default page');
});

test('neither id nor scan_id throws the guidance ToolError before any network call', async () => {
  const calls = stubRecord(record('never-fetched'));
  await assert.rejects(
    () => resolveScanTarget({}, { missing: MISSING }),
    (e) => e instanceof ToolError && /either `id`.*or `scan_id`/.test(e.message),
  );
  assert.equal(calls(), 0);
});

// ── findScanRecordId ─────────────────────────────────────────────────────────

// Route the two operations the lookup makes: Search (the identifier scope; its
// hits carry the same scan block as the record) and Get (the caller's own
// record). Asserts the identifier scope is used; returns the operations made.
function stubLookup({ hits, records = {} }) {
  const ops = [];
  globalThis.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const op = /query\s+(\w+)/.exec(query)[1];
    ops.push(op);
    let data;
    if (op === 'Search') {
      assert.deepEqual(variables.searchFields.map((f) => f.field), SCOPE_FIELDS.identifier);
      data = { search: { totalCount: hits.length, results: hits.map((id) => records[id] ?? { id }) } };
    } else {
      data = { get: records[variables.id] ?? { id: variables.id, result: [] } };
    }
    return { ok: true, json: async () => ({ data }) };
  };
  return ops;
}

test('findScanRecordId picks the volume record over its multivolume parent', async () => {
  stubLookup({ hits: ['id1', 'id1_UBBE-1'] });
  assert.equal(await findScanRecordId('UBBE-1'), 'id1_UBBE-1');
});

test('findScanRecordId accepts a single-volume work carrying only that scan', async () => {
  stubLookup({ hits: ['id2'], records: { id2: record('id2', [scanEntry('ZBZ-2')]) } });
  assert.equal(await findScanRecordId('ZBZ-2'), 'id2');
});

test('findScanRecordId refuses a work spanning other scans — it would search every copy', async () => {
  const copies = { key: 'sgbrScannedDigIds', metadata: [{ text: 'ZHBL-3' }, { text: 'UBBS-3' }] };
  stubLookup({ hits: ['id3'], records: { id3: record('id3', [copies]) } });
  assert.equal(await findScanRecordId('UBBS-3'), null);
});

test('findScanRecordId returns null when the identifier scope misses the scan', async () => {
  stubLookup({ hits: [] });
  assert.equal(await findScanRecordId('ZBZ-4'), null);
});

test('findScanRecordId takes the caller\'s own record without a search when it stands for the scan', async () => {
  const ops = stubLookup({ hits: [], records: { id5: record('id5', [scanEntry('ZBZ-5')]) } });
  assert.equal(await findScanRecordId('ZBZ-5', { recordId: 'id5' }), 'id5');
  assert.equal(await findScanRecordId('ZBZ-5', { recordId: 'id6_ZBZ-5' }), 'id6_ZBZ-5');
  assert.deepEqual(ops, ['Get']);
});

const multiScanRecord = (id) => record(id, [
  { key: 'sgbrScannedDigIds', metadata: [{ text: 'ZHBL-1' }, { text: 'UBBS-1' }] },
]);

test('a record listing several scans is refused by default, naming every scan', async () => {
  stubRecord(multiScanRecord('id991-refuse'));
  await assert.rejects(
    resolveScanTarget({ id: 'id991-refuse' }, { missing: MISSING }),
    (err) => err instanceof ToolError && /ZHBL-1/.test(err.message) && /UBBS-1/.test(err.message)
      && /scan_id/.test(err.suggestion),
  );
});

test('allowMultiScan resolves a multi-scan record to its first scan, listing them all', async () => {
  stubRecord(multiScanRecord('id991-allow'));
  const out = await resolveScanTarget({ id: 'id991-allow' }, { missing: MISSING, allowMultiScan: true });
  assert.deepEqual(out, { scanId: 'ZHBL-1', recordId: 'id991-allow', scanIds: ['ZHBL-1', 'UBBS-1'] });
});
