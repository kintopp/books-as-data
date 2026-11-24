// Offline tests for the CLI's OUTPUT half — everything downstream of a tool
// call: renderResult's JSONL emission, --table, --fields projection, the
// stdout/stderr split, --json passthrough, image writing and --stdin batching.
// cli.test.js owns the other half (parsing, help, schema introspection, usage
// errors), all of which stops before a request is made.
//
// Why a real socket rather than a fetch stub: the CLI spawns src/index.js as a
// SUBPROCESS, so nothing in this process can replace its fetch. It forwards its
// whole environment to that child, which is what makes endpoint redirection
// work — the child resolves SGBR_*_ENDPOINT at its own module load, safely
// after we set them.
//
// The path under test is the genuine CLI → MCP client → stdio → server → tool →
// shaper chain, with only the far side of HTTP faked.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeRouter, startStubServer, record, searchPayload, facetPayload } from './stub-backend.js';
import { runCli as spawnCli, jsonlRows, assertWireValid, CLI } from './helpers.js';
import { FACET_DIMENSIONS } from '../src/config.js';
import { outputSchema as facetBreakdownOutput } from '../src/tools/facet_breakdown.js';

const SCAN = 'UBBS-00190048';
const REC_ID = 'id-cli-1';
const BOOK = Array.from({ length: 30 }, (_, i) => `Zeile ${i} der Basler Chronik.`).join('\n');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(4096).fill(0x41), 0xff, 0xd9]);

// One hOCR page: 1000×2000, one block, one line of words — the probed layout
// (single-quoted attrs, class before title).
const hocrPage = (words) => `<html><body>
<div class='ocr_page' title='bbox 0 0 1000 2000'>
<div class='ocr_carea' title='bbox 10 10 900 200'>
<span class='ocr_line' title='bbox 10 10 900 100'>
${words.map((w, i) => `<span class='ocrx_word' title='bbox ${10 + i * 100} 10 ${100 + i * 100} 100;x_wconf 90'>${w}</span>`).join('\n')}
</span></div></div></body></html>`;

const rec = record(REC_ID, {
  titleInfoMainTitle: ['Basler Chronik'],
  facetGeneralAuthor: ['Wurstisen, Christian'],
  originInfoPublicationDate: ['1580'],
  sgbrScannedDigIds: [SCAN],
  availableData: ['Volltext'],
});
const hit = record(REC_ID, {
  language: ['Deutsch', 'Latein'],
  titleInfoMainTitle: ['Basler Chronik'],
  facetGeneralAuthor: ['Wurstisen, Christian'],
  originInfoPublicationDate: ['1580'],
  availableData: ['Volltext'],
});
const hit2 = record('id-cli-2', {
  titleInfoMainTitle: ['Bernische Chronik'],
  originInfoPublicationDate: ['1600'],
});

const FIXTURES = {
  graphql: {
    // A deep page answers from a large corpus, so the result window comes into play.
    Search: ({ first, query }) => ({
      search: query === 'Nirgendwo' ? searchPayload([], { totalCount: 0 })
        : searchPayload([hit, hit2], { totalCount: first >= 9000 ? 640000 : 42 }),
    }),
    // A FUNCTION of the variables, not a constant: a router that answers every
    // id with the same record cannot test the not-found path (it silently made
    // the error test below pass with exit 0 until this was fixed). The backend
    // answers a bad id with HTTP 200 + an empty result, never a 404.
    Get: ({ id }) => ({
      get: id === REC_ID ? rec : id === MULTIVOL_ID ? multivolRecord() : id === MULTICOPY_ID ? multicopyRecord()
        : { id: '', result: [] },
    }),
    FacetFilter: ({ facet }) => ({
      facetFiltered: facet.term.include?.[0] === FACET_DIMENSIONS.genre.include[0]
        ? facetPayload('genre', [['Nachruf', 30], ['Hochschulschrift', 20]])
        : facetPayload('library', [['Basel, UB', 60], ['Bern, UB', 40]], { othersCount: 7 }),
    }),
    Autocomplete: {
      autocomplete: {
        namedResults: [
          { name: 'title', results: ['Burckhardt Chronik'] },
          { name: 'author', results: ['Burckhardt, Jacob'] },
          { name: 'subject', results: [] },
        ],
        countResult: { resultCount: 12 },
      },
    },
    // Every cell the request names, counted from its name, so the grid is checkable.
    Stats: ({ queryFilters }) => ({
      stats: {
        statsResult: queryFilters.map(({ name }) => {
          const [i, j] = name.split(':').map(Number);
          return { name, countResult: { resultCount: 10 * (i + 1) + (j + 1) } };
        }),
      },
    }),
  },
  fulltext: { [SCAN]: BOOK },
  image: { 'page:12': JPEG },
  ocr: {
    'text:1': 'nichts hier',
    'text:2': 'Der Mann war in Basel geboren',
    'hocr:2': hocrPage(['Der', 'Mann', 'war', 'in', 'Basel', 'geboren']),
    'hocr:5': hocrPage(['Beschäftigungen', 'der', 'Landleute']),
    'text:5': 'Beschäftigungen der Landleute',
  },
};

// A work whose manifest is a Collection of three volumes; the manifest URL is
// built from the stub's own port, so the record is made per request.
const MULTIVOL_ID = 'id-cli-multivol';
const VOLUMES = ['UBBS-00190048', 'UBBS-00190049', 'UBBS-00190050'];
const manifestUrl = () => `${backend.env.SGBR_OCR_ENDPOINT}/coll/manifest`;
const multivolRecord = () => record(MULTIVOL_ID, {
  sgbrScannedDigIds: [SCAN],
  iiifManifest: [{ link: manifestUrl() }],
});

// A work listing a second library's copy and no manifest, so no sibling line covers it.
const MULTICOPY_ID = 'id-cli-multicopy';
const OTHER_COPY = 'ZBZ-00000777';
const multicopyRecord = () => record(MULTICOPY_ID, { sgbrScannedDigIds: [SCAN, OTHER_COPY] });

let backend = null;
before(async () => {
  backend = await startStubServer(makeRouter(FIXTURES));
  FIXTURES.manifest = {
    [manifestUrl()]: {
      type: 'Collection',
      items: VOLUMES.map((s) => ({ id: `https://host/iiif/3/gbooks/${s}/manifest`, type: 'Manifest' })),
    },
  };
});
after(async () => { await backend?.close(); });

// The shared runner, with the stub backend's endpoints bound in. `backend` is
// read per call rather than captured, so before() has run by the time it matters.
const runCli = (args, opts = {}) => spawnCli(args, { ...opts, env: backend.env });

// ── the stdout/stderr contract ───────────────────────────────────────────────

test('search renders JSONL on stdout and the count summary on stderr', async () => {
  // --max 2: the stub's two hits are a full page, so paging on is offered.
  const r = await runCli(['search', 'Basel', '--max', '2']);
  assert.equal(r.code, 0, r.stderr);
  const rows = jsonlRows(r.stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, REC_ID);
  assert.equal(rows[0].title, 'Basler Chronik');
  // The invariant that makes the CLI pipeable: stdout is PURE JSONL.
  assert.match(r.stderr, /2 shown \(page 1\) of 42/, 'the pagination summary belongs on stderr');
  assert.match(r.stderr, /--page 2 for more/, 'and tells the user how to page');
  assert.doesNotMatch(r.stdout, /shown/, 'and must never leak into stdout');
});

test('search on the last page inside the result window offers no page past it', async () => {
  const r = await runCli(['search', 'Basel', '--max', '2', '--page', '5000']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /--page 5001/);
  assert.match(r.stderr, /past the result window/);
});

test('search on a short page offers no next page, pointing at the warning instead', async () => {
  const r = await runCli(['search', 'Basel', '--max', '5']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /--page 2/);
  assert.match(r.stderr, /the page came back short/);
  assert.match(r.stderr, /warnings: .*were not returned/);
});

test('--fields projects each row to the requested keys only', async () => {
  const r = await runCli(['search', 'Basel', '--fields', 'id,title']);
  assert.equal(r.code, 0, r.stderr);
  for (const row of jsonlRows(r.stdout)) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'title'], 'projection drops every other key');
  }
});

test('--table renders aligned columns instead of JSONL', async () => {
  const r = await runCli(['search', 'Basel', '--fields', 'id,title', '--table']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /id\s+title/, 'a header row');
  assert.ok(lines.some((l) => /Basler Chronik/.test(l)), 'and the data');
  assert.throws(() => JSON.parse(lines[0]), 'table mode is deliberately not JSON');
});

test('--table shows a list field (languages, authors) as one joined cell', async () => {
  const r = await runCli(['search', 'Basel', '--fields', 'id,language', '--table']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.split('\n').some((l) => /Deutsch; Latein/.test(l)), r.stdout);
  const jsonl = await runCli(['search', 'Basel', '--fields', 'language']);
  assert.deepEqual(jsonlRows(jsonl.stdout)[0].language, ['Deutsch', 'Latein'], 'JSONL keeps the list');
});

test('--json dumps structuredContent verbatim, unprojected', async () => {
  const r = await runCli(['facets', 'library', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.facet, 'library');
  assert.equal(obj.values.length, 2);
  assert.equal(obj.matching_records, 100, 'the whole object, not a projection');
});

// The only successful cross-tab offline that crosses the MCP boundary, where the
// server validates structuredContent against the tool's outputSchema.
test('crosstab --json returns a grid that satisfies the advertised outputSchema', async () => {
  const r = await runCli(['crosstab', 'library', '--breakdown', 'genre', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const obj = assertWireValid(facetBreakdownOutput, JSON.parse(r.stdout));
  assert.deepEqual(
    obj.rows.map((row) => [row.value, ...row.cells.map((c) => c.count)]),
    [['Basel, UB', 11, 12], ['Bern, UB', 21, 22]],
  );
});

test('the server\'s own stderr reaches ours, its startup banner excepted', async () => {
  const logged = await spawnCli(['search', 'Basel'], { env: { ...backend.env, SGBR_LOG: '1' } });
  assert.equal(logged.code, 0, logged.stderr);
  assert.match(logged.stderr, /"tool":"sgbr_search"/, 'an SGBR_LOG line is forwarded');
  assert.doesNotMatch(logged.stderr, /listening on stdio/);
  assert.equal(jsonlRows(logged.stdout).length, 2, 'and stdout stays pure JSONL');
  const quiet = await spawnCli(['search', 'Basel', '--quiet'], { env: { ...backend.env, SGBR_LOG: '1' } });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(quiet.stderr.trim(), '', '--quiet silences the forwarded lines too');
});

test('a reader that closes the pipe early ends the CLI quietly', async () => {
  const child = spawn(process.execPath, [CLI, 'search', 'Basel'], { env: { ...process.env, ...backend.env } });
  child.stdout.destroy(); // `| head -0`: nothing will ever read what the CLI writes
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /EPIPE|at .*cli\.mjs/);
});

test('--quiet keeps stderr clean while stdout is unchanged', async () => {
  const loud = await runCli(['search', 'Basel']);
  const quiet = await runCli(['search', 'Basel', '--quiet']);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(quiet.stdout, loud.stdout, '--quiet must not change the data channel');
  assert.doesNotMatch(quiet.stderr, /shown/, 'only the summary is suppressed');
});

test('query warnings are routed to stderr, never into the JSONL', async () => {
  const r = await runCli(['search', 'Basel AND Bern']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /warnings:.*AND/s, 'the AND/OR/NOT misuse warning reaches the user');
  jsonlRows(r.stdout); // throws if a warning line contaminated stdout
});

// ── the single-object verbs ──────────────────────────────────────────────────

test('get emits one JSON object', async () => {
  const r = await runCli(['get', REC_ID, '--fields', 'id,title']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { id: REC_ID, title: 'Basler Chronik' });
});

test('fulltext windows the book and nudges toward the next window', async () => {
  const r = await runCli(['fulltext', REC_ID, '--max_chars', '500']);
  assert.equal(r.code, 0, r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.scan_id, SCAN, 'the record id resolved to its scan');
  assert.equal(obj.has_more, true);
  assert.match(r.stderr, new RegExp(`--offset ${obj.next_offset}`), 'names the exact next offset');
});

test('comp emits one grouped-suggestions object', async () => {
  const r = await runCli(['comp', 'Burck']);
  assert.equal(r.code, 0, r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.deepEqual(obj.suggestions.author, ['Burckhardt, Jacob']);
});

// ── the image verb ───────────────────────────────────────────────────────────

test('inspect --out writes the bytes to disk and keeps base64 off stdout', async () => {
  const out = join(tmpdir(), `sgbr-cli-render-${process.pid}.jpg`);
  rmSync(out, { force: true });
  try {
    const r = await runCli(['inspect', '--scan_id', SCAN, '--page', '12', '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(out), 'the file was written');
    assert.equal(statSync(out).size, JPEG.length, 'byte-for-byte, not re-encoded');
    assert.deepEqual(readFileSync(out), JPEG);
    assert.match(r.stderr, /Wrote /, 'the confirmation is a stderr note');
    // The point of --out: a base64 blob must never hit the data channel.
    assert.doesNotMatch(r.stdout, /[A-Za-z0-9+/]{200}/, 'no base64 payload on stdout');
    JSON.parse(r.stdout.trim());
  } finally {
    rmSync(out, { force: true });
  }
});

test('inspect without --out says how to save the bytes rather than dumping them', async () => {
  const r = await runCli(['inspect', '--scan_id', SCAN, '--page', '12']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /pass --out/, 'points at the flag that saves them');
  assert.doesNotMatch(r.stdout, /[A-Za-z0-9+/]{200}/);
});

test('inspect --out infers the extension from the mime type', async () => {
  const base = join(tmpdir(), `sgbr-cli-render-noext-${process.pid}`);
  rmSync(`${base}.jpg`, { force: true });
  try {
    const r = await runCli(['inspect', '--scan_id', SCAN, '--page', '12', '--out', base]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(`${base}.jpg`), 'image/jpeg → .jpg appended');
  } finally {
    rmSync(`${base}.jpg`, { force: true });
  }
});

// ── the two verbs that had never executed through the CLI ────────────────────

test('pageocr renders layout regions as JSONL', async () => {
  const r = await runCli(['pageocr', '--scan_id', SCAN, '--page', '5', '--level', 'line']);
  assert.equal(r.code, 0, r.stderr);
  const rows = jsonlRows(r.stdout);
  assert.ok(rows.length >= 1, 'at least one region');
  assert.equal(rows[0].type, 'line');
  assert.match(rows[0].text, /Beschäftigungen/, 'UTF-8 survives the stdio round trip');
  assert.ok(Array.isArray(rows[0].region_pct), 'each region carries its percentage box');
});

test('an endpoint override with a trailing slash reaches the same assets', async () => {
  const env = { ...backend.env };
  for (const k of ['SGBR_FULLTEXT_ENDPOINT', 'SGBR_IMAGE_ENDPOINT', 'SGBR_OCR_ENDPOINT']) env[k] += '/';
  const ocr = await spawnCli(['pageocr', '--scan_id', SCAN, '--page', '5', '--level', 'line'], { env });
  assert.equal(ocr.code, 0, ocr.stderr);
  assert.match(jsonlRows(ocr.stdout)[0].text, /Beschäftigungen/);
  const text = await spawnCli(['fulltext', '--scan_id', SCAN, '--json'], { env });
  assert.equal(text.code, 0, text.stderr);
});

test('pageocr --json exposes the whole page object', async () => {
  const r = await runCli(['pageocr', '--scan_id', SCAN, '--page', '5', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.scan_id, SCAN);
  assert.equal(obj.page, 5);
  assert.ok(Array.isArray(obj.regions));
});

test('locate finds the phrase and renders hits as JSONL', async () => {
  const r = await runCli(['locate', 'Basel', '--scan_id', SCAN, '--level', 'line']);
  assert.equal(r.code, 0, r.stderr);
  const rows = jsonlRows(r.stdout);
  assert.equal(rows.length, 1, 'one page matched');
  assert.equal(rows[0].page, 2);
  // Snippets are NORMALIZED context, not raw OCR (src/lib/locate.js:49) — so the
  // match is case-folded here by design, not by accident.
  assert.match(rows[0].snippet, /basel/);
  assert.equal(rows[0].match_count, 1);
  assert.ok(rows[0].regions.length >= 1, 'the matching line was located on the page');
});

test('locate on a work listing another copy names it on stderr as not searched', async () => {
  const r = await runCli(['locate', 'Basel', '--id', MULTICOPY_ID, '--level', 'line']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`note: not searched: ${OTHER_COPY} `));
});

test('locate on a multivolume work says on stderr that only one volume was searched', async () => {
  const r = await runCli(['locate', 'Basel', '--id', MULTIVOL_ID, '--level', 'line']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /note: multivolume work — searched only volume/);
  assert.match(r.stderr, new RegExp(VOLUMES[1]));
  assert.match(r.stderr, new RegExp(VOLUMES[2]));
  jsonlRows(r.stdout); // notes never reach stdout
});

test('facets restates coverage, and claims the empty bucket is excluded only from a real figure', async () => {
  const stub = await startStubServer(makeRouter({
    graphql: {
      FacetFilter: ({ facet }) => ({
        facetFiltered: facetPayload(facet.term.include[0], [['Basel, UB', 60], ['', 5]]),
      }),
      Search: { search: searchPayload([], { totalCount: 100 }) },
    },
  }));
  try {
    const single = await spawnCli(['facets', 'library', '--query', 'Basel'], { env: stub.env });
    assert.equal(single.code, 0, single.stderr);
    assert.match(single.stderr, /note: 60% of 100 hits carry this dimension/);
    assert.match(single.stderr, /5 record\(s\) sit in the empty .* excluded from that coverage/);
    // A multi-valued dimension has no coverage figure to exclude them from.
    const multi = await spawnCli(['facets', 'scan_source', '--query', 'Basel'], { env: stub.env });
    assert.equal(multi.code, 0, multi.stderr);
    assert.doesNotMatch(multi.stderr, /carry this dimension|excluded/);
    assert.match(multi.stderr, /5 record\(s\) sit in the empty/);
  } finally {
    await stub.close();
  }
});

test('crosstab restates on stderr that row totals are not a sum of the cells', async () => {
  const r = await runCli(['crosstab', 'language', '--breakdown', 'genre']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /not a sum/);
});

test('crosstab with a same-dimension filter surfaces the caveat once, via warnings', async () => {
  const r = await runCli(['crosstab', 'language', '--breakdown', 'genre', '--filters', '{"language":["Deutsch"]}']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /same_dimension_filter|own filter/);
  assert.ok((r.stderr.match(/same_dimension_filter/g) ?? []).length <= 1, 'not duplicated by a note');
});

test('locate --fields projects hit rows like any other list verb', async () => {
  const r = await runCli(['locate', 'Basel', '--scan_id', SCAN, '--fields', 'page,match_count']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(jsonlRows(r.stdout)[0]).sort(), ['match_count', 'page']);
});

// ── batch mode ───────────────────────────────────────────────────────────────

test('--stdin runs one invocation per line and concatenates the output', async () => {
  const r = await runCli(['search', '--stdin', '--fields', 'id'], { stdin: 'Basel\nBern\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(jsonlRows(r.stdout).length, 4, '2 queries × 2 hits, one JSONL stream');
});

test('--stdin ties each row and summary to its input line, a zero-hit one included', async () => {
  const r = await runCli(['search', '--stdin', '--fields', 'id'], { stdin: 'Basel\nNirgendwo\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(jsonlRows(r.stdout).map((row) => row.input), ['Basel', 'Basel']);
  assert.match(r.stderr, /^\[Basel\] 2 shown/m);
  assert.match(r.stderr, /^\[Nirgendwo\] 0 shown/m, 'an input with no hits still answers');
});

test('--stdin skips blank and #-comment lines', async () => {
  const r = await runCli(['search', '--stdin', '--fields', 'id'], { stdin: '# a note\n\nBasel\n\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(jsonlRows(r.stdout).length, 2, 'only the one real query ran');
});

// ── the error channel ────────────────────────────────────────────────────────

test('a tool-level error exits nonzero with the message on stderr', async () => {
  const r = await runCli(['get', 'no-such-record']);
  assert.notEqual(r.code, 0, 'a failed lookup must not report success');
  assert.match(r.stderr, /No record found/);
  assert.equal(r.stdout.trim(), '', 'nothing on the data channel when there is no data');
});
