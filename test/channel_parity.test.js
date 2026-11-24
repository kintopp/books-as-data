// A host may show the model only one channel: Claude Desktop reads the text,
// Claude Code reads structuredContent. So whatever the model needs to make its
// next call must be in BOTH. warning_parity.test.js pins the warnings; this file
// pins the handles a follow-up call is built from.
//
// How it could fail:
//   - an id in structuredContent that the text never shows, so a text-only host
//     cannot follow it up. An id is a string under a key `id` or `*_id`, or an
//     element of an array under `*_ids`, at any depth;
//   - `locate_text`'s `unsearched_scans` and `siblings.volumes`, scan-id lists
//     outside that key rule, missing from the text;
//   - a continuation (`next_page`, `next_offset`, `next_start_page`) that the
//     text does not name;
//   - a `viewer_url` the text never shows: without it a text-only model builds
//     the link from a work id and `?page=N`, which opens the wrong page;
//   - a `region_pct` the text never shows, so a text-only model cannot crop it;
//   - a tool added later with no scenario here (the registry guard).
//
// Ids match on word boundaries, never as substrings: a plate's record id
// `ZBZ-00138157_00000165` contains its parent scan id, so a substring check
// passes when the scan id itself is never shown. A continuation matches its
// phrase (`page 2`, `offset 500`), not the bare number, which nearly always
// appears somewhere.
//
// Every fixture stays at 20 scans or fewer: get_record's text and locate_text's
// unsearched list cap at 20 by design, and that cap is not what this tests.
//
// A failure here is a finding, not a test bug: show the value in the text.
// Never loosen the walk to make it pass.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { registerSearchTool } from '../src/tools/search.js';
import { registerGetRecordTool } from '../src/tools/get_record.js';
import { registerFacetValuesTool } from '../src/tools/facet_values.js';
import { registerFacetBreakdownTool } from '../src/tools/facet_breakdown.js';
import { registerGetFullTextTool } from '../src/tools/get_fulltext.js';
import { registerAutocompleteTool } from '../src/tools/autocomplete.js';
import { registerInspectImageTool } from '../src/tools/inspect_image.js';
import { registerGetPageOcrTool } from '../src/tools/get_page_ocr.js';
import { registerLocateTextTool } from '../src/tools/locate_text.js';
import { registerGuideTool } from '../src/tools/guide.js';
import { clearGraphqlCache } from '../src/graphql/client.js';
import { FACET_DIMENSIONS, MAX_IMAGE_LONG_EDGE } from '../src/config.js';
import { makeRouter, installFetchStub, record, searchPayload, facetPayload } from './stub-backend.js';
import { captureHandler, withClient } from './helpers.js';

// ── the walk ─────────────────────────────────────────────────────────────────

const ID_KEY = /^(id|.+_id)$/;
const ID_LIST_KEY = /^(.+_ids|unsearched_scans|volumes)$/;
const CONTINUATIONS = { next_page: 'page', next_offset: 'offset', next_start_page: 'start_page' };

// Every handle in a structuredContent tree, as { path, value, pattern }.
function handles(node, path = '') {
  if (Array.isArray(node)) return node.flatMap((v, i) => handles(v, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => {
    const at = path ? `${path}.${key}` : key;
    if (ID_KEY.test(key) && typeof value === 'string' && value) {
      return [{ path: at, value, pattern: idPattern(value) }];
    }
    if (ID_LIST_KEY.test(key) && Array.isArray(value)) {
      return value.filter((v) => typeof v === 'string' && v)
        .map((v, i) => ({ path: `${at}[${i}]`, value: v, pattern: idPattern(v) }));
    }
    if (key === 'viewer_url' && typeof value === 'string' && value) {
      return [{ path: at, value, pattern: new RegExp(`${RegExp.escape(value)}(?![\\w?=&-])`) }];
    }
    if (key === 'region_pct' && Array.isArray(value)) {
      return [{ path: at, value: value.join(','), pattern: new RegExp(`region_pct=\\[${RegExp.escape(value.join(','))}\\]`) }];
    }
    if (Object.hasOwn(CONTINUATIONS, key) && typeof value === 'number') {
      return [{ path: at, value: `${CONTINUATIONS[key]} ${value}`, pattern: new RegExp(`\\b${CONTINUATIONS[key]} ${value}\\b`, 'i') }];
    }
    return handles(value, at);
  });
}

const idPattern = (id) => new RegExp(`(?<![A-Za-z0-9_-])${RegExp.escape(id)}(?![A-Za-z0-9_-])`);

const textOf = (res) => (res.content ?? [])
  .filter((c) => c.type === 'text')
  .map((c) => c.text)
  .join('\n');

// ── the scenarios ────────────────────────────────────────────────────────────

const search = captureHandler(registerSearchTool);
const getRecord = captureHandler(registerGetRecordTool);
const facetValues = captureHandler(registerFacetValuesTool);
const facetBreakdown = captureHandler(registerFacetBreakdownTool);
const getFullText = captureHandler(registerGetFullTextTool);
const autocomplete = captureHandler(registerAutocompleteTool);
const inspectImage = captureHandler(registerInspectImageTool);
const getPageOcr = captureHandler(registerGetPageOcrTool);
const locateText = captureHandler(registerLocateTextTool);
const guide = captureHandler(registerGuideTool);

// Direct invocation bypasses zod, so every scenario spells out the defaults.
const SEARCH_ARGS = { query: '', scope: 'all', full_text_only: false, page: 1, page_size: 10 };
const FACET_ARGS = { query: '', scope: 'all', full_text_only: false, facet: 'library', size: 20 };
const BREAKDOWN_ARGS = {
  query: '', scope: 'all', full_text_only: false,
  facet: 'language', breakdown: 'genre', size: 2, breakdown_size: 2,
};
const COMP_ARGS = { query: '', scope: 'all', full_text_only: false, limit: 10 };
const FULLTEXT_ARGS = { offset: 0, max_chars: 15000 };
const IMAGE_ARGS = { max_long_edge: MAX_IMAGE_LONG_EDGE };
const PAGE_OCR_ARGS = { level: 'line', include_text: true, max_regions: 50 };
const LOCATE_ARGS = { engine: 'page_scan', start_page: 1, max_pages: 20, max_hits: 5, level: 'line' };

// The OCR, image and content-search clients cache at module scope with no
// clear(), so every scenario that touches them uses its own scan id.
let seq = 0;
const freshScan = () => `UBBS-CP${String(++seq).padStart(5, '0')}`;

const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `Zeile ${i} der Basler Chronik.`).join('\n');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x41, 0xff, 0xd9]);

const hocr = (words) => `<div class='ocr_page' title='bbox 0 0 1000 2000'>
<div class='ocrx_block' title='bbox 10 10 990 200'>
<span class='ocr_line' title='bbox 10 10 990 100'>
${words.map((w, i) => `<span class='ocrx_word' title='bbox ${10 + i * 100} 10 ${100 + i * 100} 100;x_wconf 90'>${w}</span>`).join('\n')}
</span></div></div>`;

const plateRecord = (plateId) => record(plateId, {
  sgbrObjectType: ['Falttafel'],
  thumbnail: [{ link: `https://host/iiif/3/gbooks/${plateId}.jp2/full/400,/0/default.jpg` }],
});

const collection = (...scans) => ({
  type: 'Collection',
  items: scans.map((s) => ({ id: `https://host/iiif/3/gbooks/${s}/manifest`, type: 'Manifest' })),
});

const facetByDimension = (byDim) => (vars) => {
  for (const [dim, values] of Object.entries(byDim)) {
    if (FACET_DIMENSIONS[dim].field === vars?.facet?.term?.field) {
      return { facetFiltered: facetPayload(dim, values) };
    }
  }
  throw new Error(`no facet fixture for field ${vars?.facet?.term?.field}`);
};
const LANGUAGES = [['Deutsch', 60], ['Französisch', 40]];
const GENRES = [['Nachruf', 30], ['Hochschulschrift', 20]];
const statsGrid = (rows, cols) => ({
  stats: {
    statsResult: rows.flatMap((_, i) => cols.map((__, j) => ({ name: `${i}:${j}`, countResult: { resultCount: 1 } }))),
  },
});

// `min` is the number of handles the scenario exists to check, so a fixture
// that stops producing them fails instead of passing on an empty walk. A tool
// whose output carries no handle at all keeps its row, at min 0, so the registry
// guard still sees it.
// Each `make` builds fresh fixtures and args, because scan ids must not repeat.
const SCENARIOS = [
  {
    name: 'search: hit ids and the next page',
    tool: 'sgbr_search', handler: search, min: 11,
    make: () => ({
      fixtures: {
        graphql: {
          Search: {
            // A full page, so that a next page exists; the plate id contains a
            // book's scan id, which a substring match would take for the book's.
            search: searchPayload([
              record('ZBZ-00138157_00000165', { titleInfoMainTitle: ['Geologische Karte'], sgbrObjectType: ['Falttafel'] }),
              ...Array.from({ length: 9 }, (_, i) => record(`id99110455095970550${i}_UBBS-0017364${i}`, {
                titleInfoMainTitle: [`Basler Chronik ${i}`],
              })),
            ], { totalCount: 30 }),
          },
        },
      },
      args: { ...SEARCH_ARGS, query: 'Basel' },
    }),
  },
  {
    name: 'get_record: a single-scan record',
    tool: 'sgbr_get_record', handler: getRecord, min: 2,
    make: () => ({
      fixtures: {
        graphql: {
          Get: {
            get: record('id991104550959705501_UBBS-00173645', {
              titleInfoMainTitle: ['Basler Chronik'],
              sgbrScannedDigIds: ['UBBS-00173645'],
              availableData: ['Volltext'],
            }),
          },
        },
      },
      args: { id: 'id991104550959705501_UBBS-00173645' },
    }),
  },
  {
    name: 'get_record: a multi-scan work lists every scan',
    tool: 'sgbr_get_record', handler: getRecord, min: 4,
    make: () => ({
      fixtures: {
        graphql: {
          Get: {
            get: record('id991170000000005501', {
              titleInfoMainTitle: ['Sammelwerk'],
              sgbrScannedDigIds: ['ZHBL-00012345', 'UBBS-00067890', 'UBBE-00011111'],
            }),
          },
        },
      },
      args: { id: 'id991170000000005501' },
    }),
  },
  {
    name: 'facet_values: no handles',
    tool: 'sgbr_facet_values', handler: facetValues, min: 0,
    make: () => ({
      fixtures: {
        graphql: {
          FacetFilter: { facetFiltered: facetPayload('library', [['Basel, UB', 60]]) },
          Search: { search: searchPayload([], { totalCount: 200 }) },
        },
      },
      args: { ...FACET_ARGS },
    }),
  },
  {
    name: 'facet_breakdown: no handles',
    tool: 'sgbr_facet_breakdown', handler: facetBreakdown, min: 0,
    make: () => ({
      fixtures: {
        graphql: {
          FacetFilter: facetByDimension({ language: LANGUAGES, genre: GENRES }),
          Search: { search: searchPayload([], { totalCount: 100 }) },
          Stats: statsGrid(LANGUAGES, GENRES),
        },
      },
      args: { ...BREAKDOWN_ARGS },
    }),
  },
  {
    name: 'get_fulltext: a record id resolved to its scan, with the next offset',
    tool: 'sgbr_get_fulltext', handler: getFullText, min: 3,
    make: () => {
      const scan = freshScan();
      const id = `id991000000000005501_${scan}`;
      return {
        fixtures: {
          graphql: { Get: { get: record(id, { sgbrScannedDigIds: [scan] }) } },
          fulltext: { [scan]: LONG_TEXT },
        },
        args: { ...FULLTEXT_ARGS, id, max_chars: 500 },
      };
    },
  },
  {
    name: 'autocomplete: no handles',
    tool: 'sgbr_autocomplete', handler: autocomplete, min: 0,
    make: () => ({
      fixtures: {
        graphql: {
          Autocomplete: {
            autocomplete: {
              namedResults: [{ name: 'author', results: ['Burckhardt, Jacob'] }],
              countResult: { resultCount: 3 },
            },
          },
        },
      },
      args: { ...COMP_ARGS, query: 'Burck', scope: 'author' },
    }),
  },
  {
    name: 'inspect_image: a page by scan id',
    tool: 'sgbr_inspect_image', handler: inspectImage, min: 1,
    make: () => ({
      fixtures: { image: { 'page:3': JPEG } },
      args: { ...IMAGE_ARGS, scan_id: freshScan(), page: 3 },
    }),
  },
  {
    name: 'inspect_image: a plate id beside its parent scan',
    tool: 'sgbr_inspect_image', handler: inspectImage, min: 2,
    make: () => {
      const plateId = `${freshScan()}_00000011`;
      return {
        fixtures: { graphql: { Get: { get: plateRecord(plateId) } }, image: { 'page:11': JPEG } },
        args: { ...IMAGE_ARGS, id: plateId },
      };
    },
  },
  {
    name: 'get_page_ocr: a page by scan id',
    tool: 'sgbr_get_page_ocr', handler: getPageOcr, min: 2,
    make: () => ({
      fixtures: { ocr: { 'hocr:5': hocr(['Der', 'Mann', 'in', 'Basel']), 'text:5': 'Der Mann in Basel' } },
      args: { ...PAGE_OCR_ARGS, scan_id: freshScan(), page: 5 },
    }),
  },
  {
    name: 'get_page_ocr: a plate id beside its parent scan',
    tool: 'sgbr_get_page_ocr', handler: getPageOcr, min: 3,
    make: () => {
      const plateId = `${freshScan()}_00000011`;
      return {
        fixtures: {
          graphql: { Get: { get: plateRecord(plateId) } },
          ocr: { 'hocr:11': hocr(['Baunormalien', 'der', 'Gotthardbahn']) },
        },
        args: { ...PAGE_OCR_ARGS, include_text: false, id: plateId },
      };
    },
  },
  {
    name: 'locate_text: a multivolume work names its sibling volumes',
    tool: 'sgbr_locate_text', handler: locateText, min: 4,
    make: () => {
      const scan = freshScan();
      const id = `id991000000000005502_${scan}`;
      const manifestUrl = `https://host/iiif/3/${scan}/collection`;
      return {
        fixtures: {
          graphql: {
            Get: { get: record(id, { sgbrScannedDigIds: [scan], iiifManifest: [{ link: manifestUrl }] }) },
          },
          manifest: { [manifestUrl]: collection(scan, 'UBBS-00222222', 'UBBS-00333333') },
          ocr: { 'text:1': 'Der Mann war in Basel geboren' },
        },
        args: { ...LOCATE_ARGS, id, phrase: 'Basel' },
      };
    },
  },
  {
    name: 'locate_text: a scan stopped by max_pages names where to resume',
    tool: 'sgbr_locate_text', handler: locateText, min: 3,
    make: () => ({
      // Page 3 exists, so the two-page window ends before the volume does.
      fixtures: { ocr: { 'text:1': 'Basel', 'hocr:1': hocr(['Basel']), 'text:2': 'Bern', 'text:3': 'Zürich' } },
      args: { ...LOCATE_ARGS, scan_id: freshScan(), phrase: 'Basel', max_pages: 2 },
    }),
  },
  {
    name: 'locate_text: a multi-scan work names the scans it did not search',
    tool: 'sgbr_locate_text', handler: locateText, min: 3,
    make: () => {
      const [first, second] = [freshScan(), freshScan()];
      const manifestUrl = `https://host/iiif/3/${first}/manifest`;
      return {
        fixtures: {
          graphql: {
            Get: {
              get: record('id991000000000005503', {
                sgbrScannedDigIds: [first, second],
                iiifManifest: [{ link: manifestUrl }],
              }),
            },
          },
          manifest: { [manifestUrl]: null },
          ocr: { 'text:1': 'Der Mann war in Basel geboren' },
        },
        args: { ...LOCATE_ARGS, id: 'id991000000000005503', phrase: 'Basel' },
      };
    },
  },
  {
    // Static text with no ids; its topic names are guarded by test/guide.test.js.
    name: 'guide: a topic carries no handles',
    tool: 'sgbr_guide', handler: guide, min: 0,
    make: () => ({ fixtures: {}, args: { topic: 'overview' } }),
  },
];

// ── guard 1: every tool has a scenario ───────────────────────────────────────

test('every registered tool is covered by a channel-parity scenario', async () => {
  const { tools } = await withClient('ub-sgbr-channel-parity', (client) => client.listTools());
  const covered = [...new Set(SCENARIOS.map((s) => s.tool))].sort();
  assert.deepEqual(covered, tools.map((t) => t.name).sort(),
    'each tool needs at least one scenario here, even one with no handles to check');
});

// ── guard 2: every handle in structuredContent is in the text ────────────────

let stub = null;
afterEach(() => { stub?.restore(); stub = null; clearGraphqlCache(); });

for (const scenario of SCENARIOS) {
  test(`the text shows every id and continuation — ${scenario.name}`, async () => {
    const { fixtures, args } = scenario.make();
    stub = installFetchStub(makeRouter(fixtures));
    clearGraphqlCache();

    const res = await scenario.handler(args, { mcpReq: {} });
    assert.notEqual(res.isError, true, `scenario errored: ${textOf(res)}`);

    const found = handles(res.structuredContent);
    assert.ok(found.length >= scenario.min,
      `scenario expects at least ${scenario.min} handle(s); got ${JSON.stringify(found.map((h) => h.path))}`);

    const text = textOf(res);
    const missing = found.filter((h) => !h.pattern.test(text)).map((h) => `${h.path} = ${h.value}`);
    assert.deepEqual(missing, [], `structuredContent handles the text never shows:\n${text}`);
  });
}
