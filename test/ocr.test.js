// Offline unit tests for per-page OCR URL construction, hOCR parsing, bbox→pct
// conversion, and response shaping. No network access for the offline cases —
// these exercise pure functions in src/lib/ocr.js. One live-gated case (SGBR_LIVE=1)
// hits the real mediaserver for a known scan/page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ocrAssetUrl, parseHocr, bboxToRegionPct, buildPageOcrResponse, capRegionsByBudget, truncateText,
} from '../src/lib/ocr.js';
import { fetchOcrAsset } from '../src/ocr/client.js';
import {
  OCR_ENDPOINT_BASE, FRONTEND_BASE_URL, FULLTEXT_INJECTION_BOUNDARY,
  PER_CHANNEL_RESULT_BUDGET, RESULT_CHAR_CEILING, MAX_OCR_MAX_REGIONS,
} from '../src/config.js';
import { KNOWN_OCR_SCAN, KNOWN_OCR_PAGE, KNOWN_OCR_PHRASE, LIVE } from './helpers.js';

// A small hand-built hOCR fixture: 2 blocks, 2 lines, 3 words. Mirrors the
// probe-observed structure (single-quoted attributes, class before title) —
// see rdv-iiif-page-ocr.md *(internal)*. The first word matches the probe's
// documented sample bbox/confidence for ZBZ-00057370 page 5.
const FIXTURE_HOCR = `<!doctype html>
<html>
<head><meta name='ocr-capabilities' content='ocr_page ocr_par ocr_block ocrx_block ocrx_word ocrp_lang ocr_line' /></head>
<body>
<div class='ocr_page' title='bbox 0 0 1256 2352;x_wconf 85;ppageno 5'>
  <div class='ocrx_block' title='bbox 139 192 1070 382;x_wconf 86'>
    <p class='ocr_par' title='bbox 139 192 1070 382;x_wconf 86'>
      <span class='ocr_line' title='bbox 139 192 1070 382;x_wconf 87'>
        <span class='ocrx_word' title='bbox 139 192 1070 382;x_wconf 87'>Beschäftigungen</span>
        <span class='ocrx_word' title='bbox 1080 192 1150 382;x_wconf 90'>der</span>
      </span>
    </p>
  </div>
  <div class='ocrx_block' title='bbox 139 400 1070 600;x_wconf 80'>
    <p class='ocr_par' title='bbox 139 400 1070 600;x_wconf 80'>
      <span class='ocr_line' title='bbox 139 400 1070 600;x_wconf 82'>
        <span class='ocrx_word' title='bbox 139 400 500 600;x_wconf 82'>Menschen</span>
      </span>
    </p>
  </div>
</div>
</body>
</html>`;

test('ocrAssetUrl builds the hocr and text URLs with 8-digit page padding', () => {
  const hocr = ocrAssetUrl('ZBZ-00057370', 5, 'hocr');
  const text = ocrAssetUrl('ZBZ-00057370', 5, 'text');
  assert.equal(hocr, `${OCR_ENDPOINT_BASE}/gbooks/ZBZ-00057370_00000005.html/item`);
  assert.equal(text, `${OCR_ENDPOINT_BASE}/gbooks/ZBZ-00057370_00000005.txt/item`);
  assert.ok(!OCR_ENDPOINT_BASE.includes('/iiif/'), 'OCR base must not contain /iiif/');
});

test('parseHocr extracts page dims and counts from the fixture', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  assert.equal(parsed.pageWidth, 1256);
  assert.equal(parsed.pageHeight, 2352);
  assert.equal(parsed.counts.blocks, 2);
  assert.equal(parsed.counts.lines, 2);
  assert.equal(parsed.counts.words, 3);
});

test('parseHocr reads the first word\'s text, bbox, and confidence', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  const word = parsed.regions.word[0];
  assert.equal(word.text, 'Beschäftigungen');
  assert.deepEqual(word.bbox_px, [139, 192, 1070, 382]);
  assert.equal(word.confidence, 87);
});

test('parseHocr joins line/block text from their words', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  assert.equal(parsed.regions.line[0].text, 'Beschäftigungen der');
  assert.equal(parsed.regions.block[0].text, 'Beschäftigungen der');
  assert.equal(parsed.regions.line[1].text, 'Menschen');
});

test('parseHocr on empty input returns zero dims and empty regions', () => {
  const parsed = parseHocr('');
  assert.equal(parsed.pageWidth, 0);
  assert.equal(parsed.pageHeight, 0);
  assert.deepEqual(parsed.regions, { block: [], line: [], word: [] });
  assert.deepEqual(parsed.counts, { blocks: 0, lines: 0, words: 0 });
});

// Regression fixture for the null-bbox path: hOCR whose title attributes can
// legitimately lack a `bbox` token. parseBbox returns null there, and every
// downstream consumer (bboxToRegionPct → region_pct, the length-4 output schema)
// assumes a 4-number box — so a bbox-less region must be DROPPED at parse, not
// carried through to crash the shaper. The bbox-less word's TEXT must still
// aggregate into its line/block for reading order.
const FIXTURE_HOCR_MISSING_BBOX = `<!doctype html>
<html><body>
<div class='ocr_page' title='bbox 0 0 1000 2000;x_wconf 85'>
  <div class='ocrx_block' title='bbox 100 100 900 300;x_wconf 86'>
    <span class='ocr_line' title='bbox 100 100 900 190;x_wconf 87'>
      <span class='ocrx_word' title='bbox 100 100 200 190;x_wconf 90'>Gut</span>
      <span class='ocrx_word' title='x_wconf 80'>bboxless</span>
    </span>
    <span class='ocr_line' title='x_wconf 70'>
      <span class='ocrx_word' title='bbox 100 200 260 290;x_wconf 90'>Basel</span>
    </span>
  </div>
</div>
</body></html>`;

test('parseHocr drops bbox-less regions but keeps their text in the parent line/block', () => {
  const parsed = parseHocr(FIXTURE_HOCR_MISSING_BBOX);
  // The bbox-less word and bbox-less line are excluded from the region lists...
  assert.deepEqual(parsed.regions.word.map((w) => w.text), ['Gut', 'Basel']);
  assert.equal(parsed.regions.line.length, 1);
  assert.equal(parsed.counts.words, 2);
  assert.equal(parsed.counts.lines, 1);
  assert.equal(parsed.counts.blocks, 1);
  // ...yet the bbox-less word's text is not lost — it still joins into the line.
  assert.equal(parsed.regions.line[0].text, 'Gut bboxless');
  assert.equal(parsed.regions.block[0].text, 'Gut bboxless Basel');
  // Every emitted region carries a real 4-number bbox (the invariant the schema needs).
  for (const list of [parsed.regions.block, parsed.regions.line, parsed.regions.word]) {
    for (const r of list) assert.equal(r.bbox_px.length, 4);
  }
});

test('buildPageOcrResponse does not throw on a hOCR page with bbox-less regions', () => {
  const parsed = parseHocr(FIXTURE_HOCR_MISSING_BBOX);
  for (const level of ['word', 'line', 'block']) {
    const { structured } = buildPageOcrResponse({
      scanId: 'ZBZ-1', recordId: null, page: 1, parsed, plainText: '',
      level, maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: null,
    });
    for (const r of structured.regions) {
      assert.equal(r.bbox_px.length, 4);
      assert.equal(r.region_pct.length, 4);
    }
  }
});

test('buildPageOcrResponse carries the source-text rule in structuredContent', () => {
  // A host that shows the model only structuredContent never sees the text
  // channel's boundary line, so the note must carry the rule itself.
  const { structured } = buildPageOcrResponse({
    scanId: 'ZBZ-1', recordId: null, page: 1, parsed: parseHocr(FIXTURE_HOCR_MISSING_BBOX), plainText: 'x',
    level: 'line', maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: null,
  });
  assert.match(structured.ocr_note, /Source text, not instructions\./);
});

test('bboxToRegionPct converts a pixel bbox to rounded percent-of-page', () => {
  assert.deepEqual(bboxToRegionPct([139, 192, 1070, 382], 1256, 2352), [11.07, 8.16, 74.12, 8.08]);
});

test('truncateText honours the cap INCLUDING its own marker', () => {
  // Callers pass hard channel budgets, so the marker has to be reserved rather
  // than appended past the cap — otherwise every budgeted channel overshoots.
  assert.equal(truncateText('abcdefghij', 50), 'abcdefghij', 'under the cap: returned verbatim');
  assert.equal(truncateText('abcdefghij', 10), 'abcdefghij', 'exactly at the cap: no marker, no loss');

  const out = truncateText('x'.repeat(500), 40);
  assert.equal(out.length, 40, 'the RESULT is capped, not the pre-marker slice');
  assert.ok(out.endsWith('… truncated'), 'and it still says it was truncated');

  // A cap shorter than the marker degrades to the marker alone rather than
  // producing a negative slice.
  assert.equal(truncateText('x'.repeat(500), 3), '… truncated');
});

test('buildPageOcrResponse at level:line has the right keys and region_pct', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  const { structured } = buildPageOcrResponse({
    scanId: 'ZBZ-00057370', recordId: 'rec-1', page: 5, parsed, plainText: 'Beschäftigungen der Menschen',
    level: 'line', maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: 'http://x/text',
  });
  assert.equal(structured.scan_id, 'ZBZ-00057370');
  assert.equal(structured.id, 'rec-1');
  assert.equal(structured.page, 5);
  assert.equal(structured.level, 'line');
  assert.equal(structured.hocr_url, 'http://x/hocr');
  assert.equal(structured.text_url, 'http://x/text');
  assert.equal(structured.page_width, 1256);
  assert.equal(structured.page_height, 2352);
  assert.deepEqual(structured.counts, { blocks: 2, lines: 2, words: 3 });
  assert.equal(structured.regions.length, 2);
  for (const r of structured.regions) {
    assert.equal(r.region_pct.length, 4);
  }
  assert.equal(structured.returned_regions, 2);
  assert.equal(structured.truncated, false);
  assert.equal(structured.truncation_reason, null);
  assert.equal(structured.viewer_url, `${FRONTEND_BASE_URL}/en/detail/rec-1?page=5`);
});

test('buildPageOcrResponse has a null viewer_url without a recordId', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  const { structured } = buildPageOcrResponse({
    scanId: 'ZBZ-00057370', recordId: null, page: 5, parsed, plainText: '',
    level: 'line', maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: null,
  });
  assert.equal(structured.id, null);
  assert.equal(structured.viewer_url, null);
});

test('buildPageOcrResponse truncates when maxRegions is below the region count', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  const { structured } = buildPageOcrResponse({
    scanId: 'ZBZ-00057370', recordId: null, page: 5, parsed, plainText: '',
    level: 'line', maxRegions: 1, hocrUrl: 'http://x/hocr', textUrl: null,
  });
  assert.equal(structured.returned_regions, 1);
  assert.equal(structured.truncated, true);
  assert.equal(structured.truncation_reason, 'max_regions');
});

test('buildPageOcrResponse at level:page returns one synthetic page region', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  const { structured } = buildPageOcrResponse({
    scanId: 'ZBZ-00057370', recordId: null, page: 5, parsed, plainText: 'hello world',
    level: 'page', maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: null,
  });
  assert.equal(structured.regions.length, 1);
  const region = structured.regions[0];
  assert.equal(region.type, 'page');
  assert.deepEqual(region.bbox_px, [0, 0, 1256, 2352]);
  assert.deepEqual(region.region_pct, [0, 0, 100, 100]);
  assert.equal(region.confidence, null);
  assert.equal(structured.text, 'hello world');
  assert.deepEqual(structured.counts, { blocks: 2, lines: 2, words: 3 });
});

test('buildPageOcrResponse at level:page carries the page text once, not again in the region', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  const { structured } = buildPageOcrResponse({
    scanId: 'ZBZ-00057370', recordId: null, page: 5, parsed, plainText: 'x'.repeat(31000),
    level: 'page', maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: null,
  });
  assert.equal(structured.regions.length, 1);
  assert.equal(structured.truncated, false);
  assert.equal(structured.regions[0].text, '');
});

test('buildPageOcrResponse at level:page with empty plainText returns empty text', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  const { structured } = buildPageOcrResponse({
    scanId: 'ZBZ-00057370', recordId: null, page: 5, parsed, plainText: '',
    level: 'page', maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: null,
  });
  assert.equal(structured.regions[0].text, '');
  assert.equal(structured.text, '');
});

// ── Response-size budget (both channels must respect the result ceiling) ─────

// A dense word-level page at the max region cap: without the serialized budget,
// 2,000 word regions alone serialize to ~300k chars — twice RESULT_CHAR_CEILING.
function syntheticDenseParsed(wordCount) {
  const words = [];
  for (let i = 0; i < wordCount; i++) {
    const x = 100 + (i % 40) * 55;
    const y = 120 + Math.floor(i / 40) * 42;
    words.push({ type: 'word', text: `Wörterbuch${i}`, bbox_px: [x, y, x + 50, y + 38], confidence: 87 });
  }
  return {
    pageWidth: 2400, pageHeight: 3600,
    regions: { block: [], line: [], word: words },
    counts: { blocks: 12, lines: 55, words: words.length },
  };
}

test('capRegionsByBudget keeps the longest prefix that fits and [] when nothing does', () => {
  const regions = [{ a: 'x'.repeat(40) }, { a: 'y'.repeat(40) }, { a: 'z'.repeat(40) }];
  const one = JSON.stringify(regions[0]).length; // all three serialize equally
  assert.equal(capRegionsByBudget(regions, 2 + 2 * (one + 1)).length, 2);
  assert.deepEqual(capRegionsByBudget(regions, 0), []);
  assert.deepEqual(capRegionsByBudget(regions, -50), [], 'a negative budget (overhead exceeded it) keeps nothing');
  assert.equal(capRegionsByBudget(regions, 10_000).length, 3);
});

test('buildPageOcrResponse: a max-knobs dense page stays within the per-channel budget on BOTH channels', () => {
  const parsed = syntheticDenseParsed(2200);
  const plainText = 'Ein historischer Fraktur-Absatz. '.repeat(3000); // ~99k chars
  const { structured, text } = buildPageOcrResponse({
    scanId: 'ZBZ-1', recordId: 'rec-1', page: 42, parsed, plainText,
    level: 'word', maxRegions: MAX_OCR_MAX_REGIONS, hocrUrl: 'http://x/hocr', textUrl: 'http://x/text',
  });
  const structLen = JSON.stringify(structured).length;
  assert.ok(structLen <= PER_CHANNEL_RESULT_BUDGET,
    `structuredContent ${structLen} chars exceeds the ${PER_CHANNEL_RESULT_BUDGET} per-channel budget`);
  // Exactly the budget, marker included — truncateText reserves the marker's
  // length rather than appending past the cap.
  assert.ok(text.length <= PER_CHANNEL_RESULT_BUDGET,
    `text channel ${text.length} chars exceeds the ${PER_CHANNEL_RESULT_BUDGET} per-channel budget`);
  assert.ok(structLen + text.length < RESULT_CHAR_CEILING, 'the two channels together must stay under the ceiling');
  assert.equal(structured.truncated, true);
  assert.equal(structured.truncation_reason, 'result_budget', 'the size budget, not max_regions, was the binding cap');
  assert.ok(structured.returned_regions > 0, 'the budget must not starve regions entirely on a text-heavy page');
  assert.ok(structured.returned_regions < 2200);
  assert.equal(structured.regions.length, structured.returned_regions);
});

test('buildPageOcrResponse: the budget never bites a default-sized call', () => {
  const parsed = syntheticDenseParsed(2200);
  const { structured } = buildPageOcrResponse({
    scanId: 'ZBZ-1', recordId: null, page: 1, parsed, plainText: 'kurzer Seitentext',
    level: 'word', maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: null,
  });
  assert.equal(structured.returned_regions, 200, 'the default region cap fits comfortably; only max_regions was applied');
  assert.equal(structured.truncated, true); // count-capped (2200 > 200), not budget-capped
  assert.equal(structured.truncation_reason, 'max_regions');
});

test('buildPageOcrResponse: the text channel lists every returned region with its region_pct', () => {
  const cases = [
    { name: 'default-sized', plainText: 'kurzer Seitentext', maxRegions: 200 },
    { name: 'max-knobs, text-heavy', plainText: 'Ein historischer Fraktur-Absatz. '.repeat(3000), maxRegions: MAX_OCR_MAX_REGIONS },
  ];
  for (const { name, plainText, maxRegions } of cases) {
    const { structured, text } = buildPageOcrResponse({
      scanId: 'ZBZ-1', recordId: null, page: 1, parsed: syntheticDenseParsed(2200), plainText,
      level: 'word', maxRegions, hocrUrl: 'http://x/hocr', textUrl: 'http://x/text',
    });
    assert.ok(structured.returned_regions > 5, `${name}: more than five regions`);
    for (const r of structured.regions) {
      assert.ok(text.includes(`"${r.text}" bbox_px=[${r.bbox_px.join(',')}] region_pct=[${r.region_pct.join(',')}]`),
        `${name}: region "${r.text}" is missing from the text channel`);
    }
    assert.ok(text.length <= PER_CHANNEL_RESULT_BUDGET, `${name}: text channel within budget`);
  }
});

// ── Injection boundary placement ──────────────────────────────────────────────

test('buildPageOcrResponse: the injection boundary precedes the OCR-derived regions', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  const { text } = buildPageOcrResponse({
    scanId: 'ZBZ-00057370', recordId: null, page: 5, parsed, plainText: 'Beschäftigungen der Menschen',
    level: 'line', maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: 'http://x/text',
  });
  const boundaryAt = text.indexOf(FULLTEXT_INJECTION_BOUNDARY);
  const regionsAt = text.indexOf('Regions:');
  assert.ok(boundaryAt !== -1, 'boundary line present');
  assert.ok(regionsAt !== -1, 'regions present');
  assert.ok(boundaryAt < regionsAt, 'boundary must come BEFORE the first OCR-derived string');
});

test('buildPageOcrResponse: the boundary appears for regions even without plainText', () => {
  const parsed = parseHocr(FIXTURE_HOCR);
  const { text } = buildPageOcrResponse({
    scanId: 'ZBZ-00057370', recordId: null, page: 5, parsed, plainText: '',
    level: 'line', maxRegions: 200, hocrUrl: 'http://x/hocr', textUrl: null,
  });
  assert.ok(text.includes(FULLTEXT_INJECTION_BOUNDARY), 'region text alone is still OCR-derived');
});

// Live-gated: fetch the real hOCR for a known scan/page and sanity-check counts.
// Resilient thresholds (not exact equality) since backend content can shift.
test('live: fetches and parses real hOCR for the known OCR scan/page', { skip: !LIVE }, async () => {
  const url = ocrAssetUrl(KNOWN_OCR_SCAN, KNOWN_OCR_PAGE, 'hocr');
  const html = await fetchOcrAsset(url);
  const parsed = parseHocr(html);
  assert.ok(parsed.pageWidth > 0, 'expected a nonzero page width');
  assert.ok(parsed.counts.words >= 20, `expected >=20 words, got ${parsed.counts.words}`);
  const allText = parsed.regions.word.map((w) => w.text).join(' ');
  assert.ok(allText.includes(KNOWN_OCR_PHRASE), `expected "${KNOWN_OCR_PHRASE}" in parsed words: ${allText}`);
});

test('buildPageOcrResponse: the text channel carries the viewer link only when there is one', () => {
  const parsed = parseHocr(FIXTURE_HOCR_MISSING_BBOX);
  const args = { scanId: 'ZBZ-1', page: 3, parsed, plainText: '', level: 'line', maxRegions: 10, hocrUrl: 'http://x/hocr', textUrl: null };
  const linked = buildPageOcrResponse({ ...args, recordId: 'id-1' });
  assert.ok(linked.structured.viewer_url);
  assert.ok(linked.text.includes(`View online: ${linked.structured.viewer_url}`));
  assert.doesNotMatch(buildPageOcrResponse({ ...args, recordId: null }).text, /View online/);
});
