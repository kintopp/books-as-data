// Offline unit tests for the record shapers (search-result + full detail),
// including the get_record output-budget guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCompactRecord, buildSearchResponse, shortPageWarnings } from '../src/lib/record.js';
import {
  toDetailRecord, buildRecordResponse, isEmptyRecord, getScanId, deriveScanTarget,
} from '../src/lib/detail.js';
import { outputSchema as recordOutput } from '../src/tools/get_record.js';
import { outputSchema as searchOutput } from '../src/tools/search.js';
import { assertWireValid } from './helpers.js';
import {
  RESULT_CHAR_CEILING, PER_CHANNEL_RESULT_BUDGET, SEARCH_SNIPPET_MAX_CHARS, IMAGE_DESCRIPTION_MAX_CHARS,
  GRAPHQL_ENDPOINT, FULLTEXT_ENDPOINT_BASE,
} from '../src/config.js';

// Build a raw RDV record from a { key: [entry, ...] } spec, where an entry is a
// string (text only) or an object { text, link, extended }.
function raw(id, spec) {
  const result = Object.entries(spec).map(([key, entries]) => ({
    key,
    metadata: entries.map((e) => (typeof e === 'string' ? { text: e } : e)),
  }));
  return { id, result };
}

test('toCompactRecord picks the primary fields and the full-text flag', () => {
  const rec = raw('id-1', {
    titleInfoMainTitle: ['Basel'],
    facetGeneralAuthor: ['Smith, J', 'Doe, A'],
    originInfoPublicationDate: ['1850'],
    availableData: ['Volltext'],
  });
  const c = toCompactRecord(rec);
  assert.equal(c.id, 'id-1');
  assert.equal(c.title, 'Basel');
  assert.deepEqual(c.authors, ['Smith, J', 'Doe, A']);
  assert.equal(c.date, '1850');
  assert.equal(c.availability, 'Volltext');
  assert.equal(c.full_text_available, true);
});

test('a search hit names the same authors as its record, corporate bodies included', () => {
  const corporateOnly = raw('id-corp', { titleInfoMainTitle: ['Bericht'], nameCorporate: ['Naturforschende Gesellschaft'] });
  assert.deepEqual(toCompactRecord(corporateOnly).authors, ['Naturforschende Gesellschaft']);
  const both = raw('id-both', {
    titleInfoMainTitle: ['Bericht'], facetGeneralAuthor: ['Smith, J', 'Basel'], nameCorporate: ['Basel'],
  });
  assert.deepEqual(toCompactRecord(both).authors,
    buildRecordResponse(both).structured.authors.map((a) => a.name));
});

test('toCompactRecord prunes empty fields, keeping the id and full-text anchors', () => {
  const c = toCompactRecord(raw('id-sparse', { titleInfoMainTitle: ['Basel'] }));
  assert.deepEqual(c, { id: 'id-sparse', title: 'Basel', full_text_available: false },
    'sparse records must not ship empty-string/empty-array keys');
});

test('toCompactRecord surfaces cleaned full-text snippets', () => {
  const rec = raw('id-1', { titleInfoMainTitle: ['Basel'] });
  rec.highlights = { 'mapping.fulltext': ['… der Stadt <em>Basel</em> …'] };
  const c = toCompactRecord(rec);
  assert.deepEqual(c.snippets, ['… der Stadt Basel …']);
});

test('toCompactRecord strips highlighter tags but keeps bare angle brackets in OCR text', () => {
  // ES inserts its tags into the source verbatim without escaping what was
  // already there, so a literal '<'/'>' pair in the corpus is TEXT. A blanket
  // <[^>]+> sweep would swallow everything between them; the tag name is
  // anchored so it can't.
  const rec = raw('id-1', { titleInfoMainTitle: ['Verhältnis'] });
  rec.highlights = {
    'mapping.fulltext': ['wenn a < b und b > c, so folgt <em>a < c</em>'],
  };
  const c = toCompactRecord(rec);
  assert.deepEqual(c.snippets, ['wenn a < b und b > c, so folgt a < c']);
});

test('toCompactRecord strips highlighter tags other than <em>', () => {
  // The generality the anchored pattern must NOT lose.
  const rec = raw('id-1', { titleInfoMainTitle: ['Basel'] });
  rec.highlights = {
    'mapping.fulltext': ['der <mark class="hl">Rhein</mark> bei <span>Basel</span>'],
  };
  assert.deepEqual(toCompactRecord(rec).snippets, ['der Rhein bei Basel']);
});

test('toCompactRecord caps snippet count and length', () => {
  const rec = raw('id-1', { titleInfoMainTitle: ['Basel'] });
  const longFrag = 'x'.repeat(SEARCH_SNIPPET_MAX_CHARS + 50);
  rec.highlights = {
    'mapping.fulltext': ['frag one', longFrag, 'frag three', 'frag four', 'frag five'],
  };
  const c = toCompactRecord(rec);
  assert.equal(c.snippets.length, 3);
  const capped = c.snippets.find((s) => s.startsWith('x'));
  assert.ok(capped, 'expected the long fragment among the kept snippets');
  assert.ok(capped.endsWith('…'), 'long fragment should end with an ellipsis');
  assert.ok(capped.length <= SEARCH_SNIPPET_MAX_CHARS + 1, 'fragment should be capped to the char limit + ellipsis');
});

test('toCompactRecord omits snippets when highlights are absent or empty', () => {
  const rec = raw('id-1', { titleInfoMainTitle: ['Basel'] });
  assert.equal('snippets' in toCompactRecord(rec), false);

  rec.highlights = {};
  assert.equal('snippets' in toCompactRecord(rec), false);
});

test('renderSearchText includes snippet lines', () => {
  const rec = raw('id-1', { titleInfoMainTitle: ['Basel'] });
  rec.highlights = { 'mapping.fulltext': ['… der Stadt <em>Basel</em> …'] };
  const search = { results: [rec], totalCount: 1 };
  const { text } = buildSearchResponse(search, { page: 1, pageSize: 10 });
  assert.match(text, /… .*Basel.* …/);
});

test('buildSearchResponse computes total, returned and has_more', () => {
  const search = { results: [raw('a', { titleInfoMainTitle: ['A'] })], totalCount: 100 };
  const { structured } = buildSearchResponse(search, { page: 1, pageSize: 10 });
  assert.equal(structured.total, 100);
  assert.equal(structured.returned, 1);
  assert.equal(structured.has_more, true);

  const last = buildSearchResponse({ results: [], totalCount: 5 }, { page: 1, pageSize: 10 });
  assert.equal(last.structured.has_more, false);
});

test('buildSearchResponse echoes applied filters and omits the key when absent', () => {
  const search = { results: [], totalCount: 5 };
  const applied = { scope: 'call_number', filters: { library: ['Bern, UB Münstergasse'] }, year_from: 1800 };
  const { structured, text } = buildSearchResponse(search, { page: 1, pageSize: 10, applied });
  assert.deepEqual(structured.applied_filters, applied);
  assert.match(text, /Filters:/);

  const bare = buildSearchResponse(search, { page: 1, pageSize: 10 });
  assert.equal('applied_filters' in bare.structured, false);
});

test('toDetailRecord keeps id/title anchors even for a sparse record', () => {
  const d = toDetailRecord(raw('id-x', {}));
  assert.equal(d.id, 'id-x');
  assert.equal(d.title, '(untitled)');
});

test('toDetailRecord builds a front-end viewer_url from the record id', () => {
  const d = toDetailRecord(raw('id-42', { titleInfoMainTitle: ['T'] }));
  assert.equal(typeof d.viewer_url, 'string');
  assert.ok(d.viewer_url.endsWith('/en/detail/id-42'), `unexpected viewer_url: ${d.viewer_url}`);
});

test('toDetailRecord merges agents across keys, unioning roles and dedup authorities', () => {
  const auth = { text: 'GND', link: 'http://d-nb.info/gnd/1' };
  const rec = raw('id-1', {
    titleInfoMainTitle: ['T'],
    facetGeneralAuthor: [{ text: 'Smith, J', extended: JSON.stringify({ roles: ['author'], authorities: [auth] }) }],
    nameCorporate: [{ text: 'Smith, J', extended: JSON.stringify({ roles: ['editor'], authorities: [auth] }) }],
  });
  const d = toDetailRecord(rec);
  assert.equal(d.authors.length, 1);
  assert.deepEqual(d.authors[0].roles, ['author', 'editor']);
  assert.equal(d.authors[0].authorities.length, 1, 'same authority url must not duplicate');
});

// The classification keys must match the query-side dimension names
// (FACET_DIMENSIONS `topic`/`subject_area`), so a value read from a record
// round-trips directly into a search/facet `filters` narrowing.
test('toDetailRecord names classification keys after the query-side dimensions', () => {
  const rec = raw('id-1', {
    titleInfoMainTitle: ['T'],
    enrichmentDdc: ['Geschichte'],
    enrichmentFachgebiet: ['Theologie'],
  });
  assert.deepEqual(toDetailRecord(rec).classification,
    { topic: ['Geschichte'], subject_area: ['Theologie'] });
});

// The availability CLASS (availableData) is the reliably-populated signal that
// tells a foldout plate from a partner-scanned / metadata-only record; sgbr_search
// exposes it, and get_record must mirror it rather than collapsing all three
// non-full-text classes into `digital.full_text_available: false`.
test('toDetailRecord surfaces the availability class and renders it', () => {
  const rec = raw('id-fold', { titleInfoMainTitle: ['Karte'], availableData: ['Einzelseite (Falttafel)'] });
  const d = toDetailRecord(rec);
  assert.equal(d.availability, 'Einzelseite (Falttafel)');
  assert.equal(d.digital.full_text_available, false, 'a foldout is not full text');
  const { text } = buildRecordResponse(rec);
  assert.match(text, /Availability: Einzelseite \(Falttafel\)/);
});

// Both channels must carry the markers src/guide.md tells the model to read. These
// two lived only in structuredContent, so a host forwarding just `content` hid
// them — and the foldout note is the one the skill names verbatim.
test('renders record notes into the text channel', () => {
  const rec = raw('id-fold', {
    titleInfoMainTitle: ['Karte'],
    availableData: ['Falttafel'],
    noteOther: ['Diese Objekt ist nur eine einzelne Falttafel aus dem oben verlinkten Buch.'],
  });
  const { text } = buildRecordResponse(rec);
  assert.match(text, /Notes: Diese Objekt ist nur eine einzelne Falttafel/);
});

// Stated in both directions, unlike the other digital flags: silence would read
// as "unknown" exactly where false is the load-bearing answer (foldouts, and
// `Digitalisat (extern)` records that DO have per-page OCR).
test('renders the full-text flag in the text channel when it is false', () => {
  const withScan = buildRecordResponse(raw('id-fold', {
    titleInfoMainTitle: ['Karte'],
    availableData: ['Falttafel'],
    sgbrScannedDigIds: ['ZBZ-00052701'],
  })).text;
  assert.match(withScan, /Digital: no indexed full text · scan id ZBZ-00052701/);

  const fullText = buildRecordResponse(raw('id-vol', {
    titleInfoMainTitle: ['Band'],
    availableData: ['Volltext'],
    sgbrScannedDigIds: ['UBBS-00180121'],
  })).text;
  assert.match(fullText, /Digital: full text available/);

  // No scan at all (catalogue-only): nothing digital to report either way.
  const catalogueOnly = buildRecordResponse(raw('id-meta', {
    titleInfoMainTitle: ['C'], availableData: ['kein Digitalisat'],
  })).text;
  assert.doesNotMatch(catalogueOnly, /no indexed full text/);
});

test('toDetailRecord distinguishes the non-full-text classes that the boolean collapses', () => {
  const scans = toDetailRecord(raw('id-scan', { titleInfoMainTitle: ['B'], availableData: ['Scans (nicht durchsuchbar)'] }));
  const meta = toDetailRecord(raw('id-meta', { titleInfoMainTitle: ['C'], availableData: ['nur Metadaten'] }));
  assert.equal(scans.availability, 'Scans (nicht durchsuchbar)');
  assert.equal(meta.availability, 'nur Metadaten');
  assert.equal(scans.digital.full_text_available, false);
  assert.equal(meta.digital.full_text_available, false);
});

// Neither shaper surfaces object_type: the per-record sgbrObjectType is a display
// value in a different vocabulary from the facet (plates `Falttafel`, not
// `Einzelseite`), so it would not round-trip into filters.
test('neither the search hit nor the detail record carries an object_type key', () => {
  const rec = raw('id-plain', { titleInfoMainTitle: ['Buch'], sgbrObjectType: ['Falttafel'] });
  assert.equal('object_type' in toDetailRecord(rec), false);
  assert.equal('object_type' in toCompactRecord(rec), false);
});

// mediaIiif lists more than the record's own manifest: a work lists its volumes,
// a plate its parent volume. Only the entry for the record's OWN manifest may
// supply the ARK and process date, or a plate would cite its whole book.
const iiifEntry = (id, meta) => ({
  url: `https://books-as-data.ch/iiif/${id}/manifest`,
  metadata: meta,
});
const mediaIiif = (...content) => [{ text: '', link: '', extended: JSON.stringify({ content }) }];
const pid = (ark) => ({ pid: [{ text: ark, link: `https://n2t.net/${ark}` }] });

test('toDetailRecord reads the ARK and process date from the record\'s own mediaIiif entry', () => {
  const d = toDetailRecord(raw('id9_UBBS-1', {
    mediaIiif: mediaIiif(iiifEntry('id9_UBBS-1', { ...pid('ark:24630/gbv1ubbsv1'), lastUpdateDate: [{ text: '2026-04-02' }] })),
  }));
  assert.equal(d.digital.ark, 'ark:24630/gbv1ubbsv1');
  assert.equal(d.digital.ark_url, 'https://n2t.net/ark:24630/gbv1ubbsv1');
  assert.equal(d.digital.processed_on, '2026-04-02');
  assert.match(buildRecordResponse(raw('id9_UBBS-1', {
    mediaIiif: mediaIiif(iiifEntry('id9_UBBS-1', pid('ark:24630/gbv1ubbsv1'))),
  })).text, /ARK \(persistent id\): ark:24630\/gbv1ubbsv1/);
});

test('toDetailRecord never borrows a sibling\'s or parent\'s ARK', () => {
  const work = toDetailRecord(raw('id9', {
    titleInfoMainTitle: ['Werk'],
    mediaIiif: mediaIiif(iiifEntry('id9_ZHBL-2', pid('ark:24630/gbv1zhblv2')), iiifEntry('id9_UBBS-1', pid('ark:24630/gbv1ubbsv1'))),
  }));
  assert.equal(work.digital?.ark, undefined, 'a work lists its volumes\' ARKs, not its own');
  const plate = toDetailRecord(raw('ZBZ-1_00000165', {
    mediaIiif: mediaIiif(
      iiifEntry('ZBZ-1_00000165', { lastUpdateDate: [{ text: '2024-09-30' }] }),
      iiifEntry('id7', pid('ark:24630/gbv1zbzv1')),
    ),
  }));
  assert.equal(plate.digital.ark, undefined, 'the parent volume\'s ARK is not the plate\'s');
  assert.equal(plate.digital.processed_on, '2024-09-30');
});

test('the AI image description rides on detail records in full and on search hits capped', () => {
  const long = 'Eine Karte. '.repeat(40);
  const rec = raw('ZBZ-1_00000165', { sgbrTempField1: [long] });
  assert.equal(toDetailRecord(rec).image_description, long);
  const hit = toCompactRecord(rec).image_description;
  assert.equal(hit.length, IMAGE_DESCRIPTION_MAX_CHARS + 1);
  assert.ok(hit.endsWith('…'));
  assert.equal(toCompactRecord(raw('id-1', { titleInfoMainTitle: ['Buch'] })).image_description, undefined);
});

test('getScanId returns the digitised-scan id or empty string', () => {
  assert.equal(getScanId(raw('id-1', { sgbrScannedDigIds: ['UBBS-00190048'] })), 'UBBS-00190048');
  assert.equal(getScanId(raw('id-1', {})), '');
});

test('isEmptyRecord flags missing id or empty result', () => {
  assert.equal(isEmptyRecord(null), true);
  assert.equal(isEmptyRecord({ id: 'x', result: [] }), true);
  assert.equal(isEmptyRecord(raw('id-1', { titleInfoMainTitle: ['T'] })), false);
});

// deriveScanTarget: the foldout fallback. A scan-less plate still points at its
// page image via the media URL and its own id (both {parentScan}_{page}).
const foldoutThumb = { text: '', link: 'https://media.example/iiif/3/gbooks/ZHBL-00036929_00000022.jp2/full/{$widthInPx},/0/default.jpg' };

test('deriveScanTarget reads the parent scan + page from the gbooks media URL', () => {
  const rec = raw('ZHBL-00036929_00000022', { thumbnail: [foldoutThumb], availableData: ['Einzelseite (Falttafel)'] });
  assert.deepEqual(deriveScanTarget(rec), { scanId: 'ZHBL-00036929', page: 22 });
});

test('deriveScanTarget falls back to the {scan}_{page} id when no media URL is present', () => {
  const rec = raw('ZHBL-00036929_00000022', { availableData: ['Einzelseite (Falttafel)'] });
  assert.deepEqual(deriveScanTarget(rec), { scanId: 'ZHBL-00036929', page: 22 });
});

test('deriveScanTarget prefers the authoritative media URL over the id', () => {
  // A media URL that disagrees with the id wins — it is the addressable path.
  const rec = raw('bogus_00000099', { thumbnail: [foldoutThumb] });
  assert.deepEqual(deriveScanTarget(rec), { scanId: 'ZHBL-00036929', page: 22 });
});

test('deriveScanTarget returns null for a genuinely image-less record', () => {
  // Pre-2026-08-10 id grammar (`id{almaId}_{opaqueToken}`) on purpose: it is the
  // shape whose suffix must NOT parse as a scan. Do not "refresh" it to a current
  // id — those end in a real scan id, which derives a target and returns non-null.
  assert.equal(deriveScanTarget(raw('id991148894999705501_DSVN642583', {})), null);
  assert.equal(deriveScanTarget(raw('plain-id-no-page', {})), null);
  assert.equal(deriveScanTarget(null), null);
});

// The id fallback is gated on foldout evidence: an ordinary scan-less record
// whose id merely ends in `_<digits>` must NOT be mistaken for a plate (else the
// image tool builds a bogus scan URL instead of the clean "no images" error).
test('deriveScanTarget refuses the id fallback for a non-foldout record', () => {
  assert.equal(deriveScanTarget(raw('SOMEBOOK-1234_00000007', {})), null);
});

test('deriveScanTarget applies the id fallback once the record is marked a foldout', () => {
  // Either the object type or the availability class counts as evidence.
  assert.deepEqual(
    deriveScanTarget(raw('SOMEBOOK-1234_00000007', { sgbrObjectType: ['Falttafel'] })),
    { scanId: 'SOMEBOOK-1234', page: 7 },
  );
  assert.deepEqual(
    deriveScanTarget(raw('SOMEBOOK-1234_00000007', { availableData: ['Einzelseite (Falttafel)'] })),
    { scanId: 'SOMEBOOK-1234', page: 7 },
  );
});

test('buildRecordResponse caps each channel to the per-copy budget so their sum fits the ceiling', () => {
  const bigNotes = Array.from({ length: 3000 }, () => 'N'.repeat(200)); // ~600k chars
  const rec = raw('id-big', { titleInfoMainTitle: ['Huge'], noteOther: bigNotes });
  const { structured, text } = buildRecordResponse(rec);
  assert.equal(structured.truncated, true, 'oversized record should be flagged truncated');
  const structuredLen = JSON.stringify(structured).length;
  // Each channel independently stays within the per-channel budget (½ the safe ceiling)...
  assert.ok(structuredLen <= PER_CHANNEL_RESULT_BUDGET, 'structured must fit the per-channel budget');
  assert.ok(text.length <= PER_CHANNEL_RESULT_BUDGET, 'text channel must fit the per-channel budget');
  // ...so that BOTH copies together (what the host may meter as one result) fit the
  // platform ceiling — the guarantee capping each to the full ceiling did NOT give.
  assert.ok(structuredLen + text.length <= RESULT_CHAR_CEILING, 'both channels together must fit the ceiling');
  assert.equal(structured.id, 'id-big', 'id anchor survives truncation');
});

test('capStructured trims a huge authors list and still honors the budget', () => {
  const authors = Array.from({ length: 5000 }, (_, i) => `Author ${i}, Firstname`);
  const rec = raw('id-authors', { titleInfoMainTitle: ['Proceedings'], facetGeneralAuthor: authors });
  const { structured } = buildRecordResponse(rec);
  assert.equal(structured.truncated, true);
  assert.ok(
    JSON.stringify(structured).length <= PER_CHANNEL_RESULT_BUDGET,
    'authors alone must not blow the structured-channel budget',
  );
  assert.ok(structured.authors.length < 5000, 'authors list must be trimmed');
  assert.ok(structured.authors.length > 0, 'some authors survive');
});

test('capStructured trims the largest field first, sparing small ones', () => {
  const bigNotes = Array.from({ length: 3000 }, () => 'N'.repeat(200)); // ~600k chars
  const rec = raw('id-mixed', {
    titleInfoMainTitle: ['Huge'],
    tableOfContents: ['Chapter 1', 'Chapter 2'],
    noteOther: bigNotes,
  });
  const { structured } = buildRecordResponse(rec);
  assert.equal(structured.truncated, true);
  assert.deepEqual(
    structured.table_of_contents, ['Chapter 1', 'Chapter 2'],
    'a small field must survive untouched when a huge one caused the overflow',
  );
  assert.ok(JSON.stringify(structured).length <= PER_CHANNEL_RESULT_BUDGET);
});

// ── the two size backstops (src/lib/detail.js:244-260) ──────────────────────
//
// The tests above all overflow through HEAVY_FIELDS, which the targeted
// list-trimming handles. These cover what happens when it CANNOT: the budget is
// a promise (CLAUDE.md calls token frugality a feature), and these two fallbacks
// are what keep it when the overflow sits somewhere the trimmer does not model.
// Both were uncovered — detail.js had the lowest branch coverage of any lib file.

test('capStructured drops an oversized citation to a note when trimming cannot help', () => {
  // `citation` is built from the cslItem sidecar and is NOT a HEAVY_FIELDS list,
  // so no amount of prefix-trimming touches it.
  const hugeCsl = { title: 'X'.repeat(80000), type: 'book' };
  const rec = raw('id-cite', {
    titleInfoMainTitle: ['Cited'],
    cslItem: [{ text: 'csl', extended: JSON.stringify(hugeCsl) }],
  });
  const { structured } = buildRecordResponse(rec);
  assert.equal(structured.truncated, true);
  assert.deepEqual(structured.citation, { note: 'omitted to fit size limits' },
    'the citation is replaced by an explicit note, never silently dropped');
  assert.ok(JSON.stringify(structured).length <= PER_CHANNEL_RESULT_BUDGET);
  assert.equal(structured.id, 'id-cite');
  assert.equal(structured.title, 'Cited');
});

test('capStructured drops non-anchor fields when every targeted trim fails', () => {
  // classification is an OBJECT outside HEAVY_FIELDS: the trimmer skips it (it
  // only walks arrays) and there is no citation to sacrifice, so the final
  // backstop is the only thing standing between this record and a blown budget.
  const rec = raw('id-backstop', {
    titleInfoMainTitle: ['Classified'],
    enrichmentDdc: Array.from({ length: 4000 }, (_, i) => `DDC ${i} ${'D'.repeat(60)}`),
    locationHoldingCallNumber: ['UBH AB 12'],
  });
  const { structured } = buildRecordResponse(rec);
  assert.equal(structured.truncated, true);
  assert.ok(JSON.stringify(structured).length <= PER_CHANNEL_RESULT_BUDGET,
    'the budget is a promise — it must hold even here');
  // The anchor set lives at src/lib/detail.js:252; assert it behaviourally so a
  // change there fails here rather than drifting past a hardcoded copy.
  assert.equal(structured.id, 'id-backstop', 'id is an anchor');
  assert.equal(structured.title, 'Classified', 'title is an anchor');
  assert.equal(structured.truncated, true, 'the truncation flag is an anchor');
});

test('buildRecordResponse truncates the TEXT channel even when structured already fits', () => {
  // The text channel has its own promise, and structured fitting does not imply
  // text fitting: renderRecordText emits one line per authority and REPEATS the
  // author name on each, while the JSON stores that name once. A long name with
  // many authorities therefore renders several times larger than it serializes —
  // the one shape that reaches the text-side guard.
  const authorities = Array.from({ length: 1000 }, (_, i) => ({
    text: 'GND', link: `https://d-nb.info/gnd/${i}`,
  }));
  const rec = raw('id-textcap', {
    titleInfoMainTitle: ['Authority Explosion'],
    facetGeneralAuthor: [{ text: 'N'.repeat(200), extended: JSON.stringify({ roles: [], authorities }) }],
  });
  const { structured, text } = buildRecordResponse(rec);
  assert.ok(JSON.stringify(structured).length <= PER_CHANNEL_RESULT_BUDGET);
  assert.ok(text.length <= PER_CHANNEL_RESULT_BUDGET, 'the text channel is capped independently');
  assert.match(text, /Detail truncated to fit size limits/, 'and says so rather than cutting silently');
  assert.match(text, /\nid: id-textcap$/, 'the id anchor survives the cut');
});

test('buildRecordResponse leaves a normal record untouched', () => {
  const rec = raw('id-1', { titleInfoMainTitle: ['Basel'], noteOther: ['a short note'] });
  const { structured } = buildRecordResponse(rec);
  assert.equal(structured.truncated, undefined);
  assert.equal(structured.title, 'Basel');
});

test('records carrying every new field pass the tools\' outputSchemas as a client validates them', () => {
  const plate = raw('ZBZ-1_00000165', {
    titleInfoMainTitle: ['Tafel'], sgbrTempField1: ['Eine Karte.'], sgbrScannedDigIds: ['ZBZ-1'],
    sgbrObjectType: ['Falttafel'], availableData: ['Falttafel'],
    mediaIiif: mediaIiif(iiifEntry('ZBZ-1_00000165', { ...pid('ark:24630/x'), lastUpdateDate: [{ text: '2024-09-30' }] })),
  });
  assertWireValid(recordOutput, buildRecordResponse(plate).structured);
  const search = buildSearchResponse({ totalCount: 1, results: [plate] }, {
    page: 1, pageSize: 10, applied: { filters: { language: ['Deutsch'] }, exclude: { object_type: ['foldout'] } },
  });
  assertWireValid(searchOutput, search.structured);
});

// The bare zip keys carry a path relative to the GraphQL service; the `…Fix`
// twins name an internal staging host, so they must never win.
test('toDetailRecord resolves the relative zip links against the GraphQL endpoint', () => {
  const d = toDetailRecord(raw('id-7_SCAN-1', {
    sgbrScannedDigIds: ['SCAN-1'],
    sgbrFullZipDl: [{ text: 'id-7_SCAN-1', link: 'graphql:/download/zip/id-7_SCAN-1' }],
    sgbrOcrZipDl: [{ text: 'id-7_SCAN-1', link: 'graphql:/download/zip_ocr/id-7_SCAN-1' }],
    sgbrFullZipDlFix: [{ text: '', link: 'https://internal-stage.example/download/zip/id-7_SCAN-1' }],
  }));
  const base = new URL('.', GRAPHQL_ENDPOINT).href;
  assert.equal(d.digital.scans_zip_url, `${base}download/zip/id-7_SCAN-1`);
  assert.equal(d.digital.ocr_zip_url, `${base}download/zip_ocr/id-7_SCAN-1`);
});

test('toDetailRecord reads BdZipOcr and puts the full-text link and zips on public hosts', () => {
  const rec = raw('id-8_SCAN-2', {
    sgbrScannedDigIds: ['SCAN-2'],
    BdZipOcr: [{ text: '', link: 'graphql:/download/zip_ocr/id-8_SCAN-2' }],
    completeText: [{ text: '', link: 'https://gbooks.internal.example/v1/swissgbooks_api/get_gb_fulltext/SCAN-2' }],
  });
  const d = toDetailRecord(rec);
  assert.equal(d.digital.ocr_zip_url, `${new URL('.', GRAPHQL_ENDPOINT).href}download/zip_ocr/id-8_SCAN-2`);
  assert.equal(d.digital.full_text_url, `${FULLTEXT_ENDPOINT_BASE}/get_gb_fulltext/SCAN-2`);
  const { text } = buildRecordResponse(rec);
  assert.ok(!text.includes('internal.example'), 'the internal host must not reach the text channel');
  assert.match(text, /OCR zip \(whole volume, GET only\): \S+zip_ocr\/id-8_SCAN-2/);
});

test('shortPageWarnings flags a capped page but not the last one', () => {
  const page = (returned, total, p = 1) => shortPageWarnings({ total, page: p, page_size: 20, returned });
  assert.match(page(12, 100)[0], /returned 12 of the 20 .*page_size 12/);
  assert.deepEqual(page(20, 100), [], 'a full page');
  assert.deepEqual(page(5, 45, 3), [], 'the last page is short by nature');
  assert.deepEqual(page(0, 0), [], 'no hits at all');
});

test('both shapers fall back to dateNormalized when the publication date is absent', () => {
  const rec = raw('id-d', { titleInfoMainTitle: ['T'], dateNormalized: ['1780'] });
  assert.equal(toCompactRecord(rec).date, '1780');
  assert.equal(toDetailRecord(rec).date, '1780');
});

test('both shapers show every language of a multilingual record', () => {
  const rec = raw('id-l', { titleInfoMainTitle: ['T'], language: ['Deutsch', 'Latein'] });
  // A list, so each value goes straight back into filters.language.
  assert.deepEqual(toCompactRecord(rec).language, ['Deutsch', 'Latein']);
  assert.deepEqual(toDetailRecord(rec).language, ['Deutsch', 'Latein']);
  const one = raw('id-m', { titleInfoMainTitle: ['T'], language: ['Deutsch'] });
  assert.deepEqual(toCompactRecord(one).language, ['Deutsch']);
  assert.deepEqual(toDetailRecord(one).language, ['Deutsch']);
  assert.match(buildSearchResponse({ totalCount: 1, results: [rec] }, { page: 1, pageSize: 10 }).text, /Deutsch; Latein/);
  assert.match(buildRecordResponse(rec).text, /Language: Deutsch; Latein/);
});

test('shortPageWarnings names the skipped results and where to resume', () => {
  const [w] = shortPageWarnings({ total: 100, page: 3, page_size: 25, returned: 20 });
  assert.match(w, /results 71–75 were not returned/i);
  assert.match(w, /page 1 with page_size 20/);
});

test('has_more text does not point past the result window', () => {
  const { structured, text } = buildSearchResponse({ totalCount: 640000, results: [] }, { page: 400, pageSize: 25 });
  assert.equal(structured.has_more, true);
  assert.equal(structured.next_page, null, 'no page the window guard would refuse');
  assert.doesNotMatch(text, /request page 401/);
  assert.match(text, /result window/i);
  const { text: early } = buildSearchResponse({ totalCount: 640000, results: [] }, { page: 2, pageSize: 25 });
  assert.match(early, /request page 3/);
  assert.equal(buildSearchResponse({ totalCount: 640000, results: [] }, { page: 2, pageSize: 25 }).structured.next_page, 3);
});

test('a short page offers no next page, since paging on would skip results', () => {
  const hits = Array.from({ length: 18 }, (_, i) => raw(`id-${i}`, { titleInfoMainTitle: ['T'] }));
  const { structured, text } = buildSearchResponse({ totalCount: 100, results: hits }, { page: 1, pageSize: 25 });
  assert.equal(structured.has_more, true);
  assert.equal(structured.next_page, null);
  assert.doesNotMatch(text, /request page 2|result window/);
});

test('buildRecordResponse surfaces every scan of a multi-scan record', () => {
  const { structured, text } = buildRecordResponse(raw('id991', {
    titleInfoMainTitle: ['Werk'], sgbrScannedDigIds: ['ZHBL-1', 'UBBS-1'],
  }));
  assert.deepEqual(structured.digital.scan_ids, ['ZHBL-1', 'UBBS-1']);
  assert.equal(structured.digital.scan_id, 'ZHBL-1');
  assert.match(text, /UBBS-1/);
  assert.match(text, /pass one of them as scan_id; only sgbr_locate_text accepts this record's id, and it searches only the first/);
  assertWireValid(recordOutput, structured);
  const single = buildRecordResponse(raw('id992', { titleInfoMainTitle: ['Band'], sgbrScannedDigIds: ['ZHBL-2'] }));
  assert.equal('scan_ids' in single.structured.digital, false);
});

test('buildRecordResponse says in the text channel when it trimmed', () => {
  const notes = Array.from({ length: 2000 }, (_, i) => `Note ${i} ${'x'.repeat(200)}`);
  const { structured, text } = buildRecordResponse(raw('id-trim', { titleInfoMainTitle: ['Viel'], noteOther: notes }));
  assert.equal(structured.truncated, true);
  assert.match(text, /truncated|trimmed/i);
  assert.match(text, /\nid: id-trim$/);
});

test('buildRecordResponse: the text channel lists the table of contents', () => {
  const { text } = buildRecordResponse(raw('id-toc', {
    titleInfoMainTitle: ['Werke'],
    tableOfContents: ['Erster Theil', 'Zweyter Theil'],
  }));
  assert.match(text, /^Contents: Erster Theil · Zweyter Theil$/m);
  assert.doesNotMatch(buildRecordResponse(raw('id-none', { titleInfoMainTitle: ['Werke'] })).text, /^Contents:/m);
});
