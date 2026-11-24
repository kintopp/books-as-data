// Headless-CLI contract test (scripts/cli.mjs). Runs the CLI as a child process
// over the zero-config stdio path (it spawns `node src/index.js` itself). The
// offline-safe assertions (help, introspection, --show-call dry-run, usage
// errors) spawn the server but make NO upstream request, so they run in the
// default suite; the assertions that actually call a tool are gated behind
// SGBR_LIVE=1, exactly like test/smoke.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, statSync, rmSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  KNOWN_ID, KNOWN_SCAN, KNOWN_OCR_SCAN, KNOWN_OCR_PAGE, KNOWN_OCR_PHRASE,
  LIVE, runCli, jsonlRows,
} from './helpers.js';

// ── Offline-safe: top-level help is static (never connects) ─────────────────────
test('top-level --help renders statically with all ten verbs', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: bbad/);
  assert.match(r.stdout, /Commands:/);
  for (const verb of ['search', 'get', 'facets', 'fulltext', 'comp', 'inspect', 'crosstab', 'pageocr', 'locate', 'guide']) {
    assert.match(r.stdout, new RegExp(`\\b${verb}\\b`), `help lists the ${verb} command`);
  }
  assert.match(r.stdout, /stdio only/);
  assert.doesNotMatch(r.stderr, /Connection failed/);
});

// The CLI's `--help` examples are hand-authored, and a stale record id fails
// SILENTLY (HTTP 200 with an empty result, per test/helpers.js): copy-pasting the
// documented example would just return "no record found". Pin them to the live
// fixtures, which `npm run test:live` revalidates.
test('the CLI\'s hand-authored examples use the live fixture ids', async () => {
  const src = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8');
  for (const fixture of [KNOWN_ID, KNOWN_SCAN, KNOWN_OCR_SCAN]) {
    assert.ok(src.includes(fixture), `the examples reference the ${fixture} fixture`);
  }
  const ids = new Set([...src.matchAll(/\bid9\d{14,}_[A-Za-z0-9-]+/g)].map((m) => m[0]));
  assert.ok(ids.size > 0, 'at least one record id appears in the examples');
  for (const id of ids) {
    assert.equal(id, KNOWN_ID, `record id ${id} is not the live fixture — re-derive it from a live search`);
  }
});

test('unknown command is a usage error (exit 2), no connection', async () => {
  const r = await runCli(['frobnicate']);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.length > 0, 'stderr explains the error');
});

// ── Offline-safe: introspection (spawns server, reads schema, no upstream call) ──
test('tools --json lists the ten in-scope tools with input schemas', async () => {
  const r = await runCli(['tools', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const tools = JSON.parse(r.stdout);
  assert.equal(tools.length, 10, `ten tools (got ${tools.length})`);
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has('sgbr_search') && names.has('sgbr_inspect_image'), 'includes search + inspect');
  assert.ok(tools.every((t) => t.inputSchema && typeof t.inputSchema === 'object'), 'each carries an inputSchema');
  // The server's registration order (= manifest.json's), not the VERBS table's: the
  // pack job reads this list as what the shipped server serves.
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(tools.map((t) => t.name), manifest.tools.map((t) => t.name));
});

test('tools --compact is a small manifest with verb/positional/result/paging', async () => {
  const r = await runCli(['tools', '--compact']);
  assert.equal(r.code, 0, r.stderr);
  const manifest = JSON.parse(r.stdout);
  assert.equal(manifest.length, 10);
  const search = manifest.find((m) => m.tool === 'sgbr_search');
  assert.equal(search.verb, 'search');
  assert.equal(search.positional, 'query');
  assert.equal(search.result, 'results');
  assert.equal(search.page, 'page');
  assert.equal(search.args.query, 'string', 'args carry name→type, no schema');
  assert.equal(manifest.find((m) => m.tool === 'sgbr_get_record').result, 'single');
  assert.equal(manifest.find((m) => m.tool === 'sgbr_facet_values').result, 'values');
  assert.equal(manifest.find((m) => m.tool === 'sgbr_inspect_image').result, 'image');
  // A required arg is marked with a trailing "!": get_record.id is required.
  assert.match(manifest.find((m) => m.tool === 'sgbr_get_record').args.id ?? '', /!$/);
  const xtab = manifest.find((m) => m.tool === 'sgbr_facet_breakdown');
  assert.equal(xtab.verb, 'crosstab');
  assert.equal(xtab.positional, 'facet');
  assert.equal(xtab.result, 'rows');
  assert.match(xtab.args.breakdown, /!$/, 'breakdown is required');
  // Compact must be far cheaper than the full schema dump.
  const full = await runCli(['tools', '--json']);
  assert.ok(r.stdout.length < full.stdout.length, 'compact smaller than --json');
});

// ── Offline-safe: --show-call dry-run resolves args without calling the tool ─────
test('--show-call resolves the --max→page_size alias and the query positional', async () => {
  const r = await runCli(['--show-call', 'search', 'Basel', '--max', '3']);
  assert.equal(r.code, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.equal(call.tool, 'sgbr_search');
  assert.equal(call.arguments.query, 'Basel', 'positional → query');
  assert.equal(call.arguments.page_size, 3, '--max resolved to page_size (number-coerced)');
});

test('--show-call maps the facets positional to the facet enum param', async () => {
  const r = await runCli(['--show-call', 'facets', 'language', '--query', 'Basel']);
  assert.equal(r.code, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.equal(call.tool, 'sgbr_facet_values');
  assert.equal(call.arguments.facet, 'language', 'positional → facet');
  assert.equal(call.arguments.query, 'Basel');
});

test('--show-call maps crosstab positional/flags to facet/breakdown/size/breakdown_size', async () => {
  const r = await runCli([
    '--show-call', 'crosstab', 'language',
    '--breakdown', 'genre', '--query', 'Basel', '--max', '4', '--breakdown_size', '3',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.equal(call.tool, 'sgbr_facet_breakdown');
  assert.equal(call.arguments.facet, 'language', 'positional → facet');
  assert.equal(call.arguments.breakdown, 'genre');
  assert.equal(call.arguments.query, 'Basel');
  assert.equal(call.arguments.size, 4, '--max resolved to size (number-coerced)');
  assert.equal(call.arguments.breakdown_size, 3);
});

// REGRESSION: `--max` mapped to locate's `max_pages` — a COST cap on pages scanned,
// not a cap on what comes back. `-n 2` silently narrowed the scan window to two
// pages instead of returning up to two hits, the opposite of what it means on every
// other verb (and of what topUsage advertises it as).
test('--max on locate is the result cap (max_hits), not the max_pages scan window', async () => {
  const r = await runCli(['--show-call', 'locate', 'Erdbeben', '--scan_id', KNOWN_OCR_SCAN, '--max', '2']);
  assert.equal(r.code, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.equal(call.tool, 'sgbr_locate_text');
  assert.equal(call.arguments.max_hits, 2, '--max resolves to max_hits');
  assert.equal(call.arguments.max_pages, undefined, 'the scan-window cost cap is left at its default');
  const help = await runCli(['locate', '--help']);
  assert.match(help.stdout, /Aliases:\s+--max, -n\s+→\s+max_hits/, 'per-verb help documents the same alias');
});

// Every verb's `cap` must be the cap on what comes back, so `--max/-n` reads the
// same way throughout. Asserted structurally (not per verb) so a verb added later
// with a cost cap wired to --max fails here.
test('every verb --max alias names a result cap, never a cost cap', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0, r.stderr);
  const capLine = r.stdout.split('\n').find((l) => l.includes('--max N'));
  assert.ok(capLine, 'top-level help documents the --max alias');
  assert.doesNotMatch(capLine, /max_pages/, 'max_pages caps pages SCANNED, so it is not a --max target');
});

test('--show-call coerces a comma-form --region_pct to an array of numbers', async () => {
  const r = await runCli(['--show-call', 'inspect', '--scan_id', 'UBBS-00190048', '--region_pct', '0,85,30,15']);
  assert.equal(r.code, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.equal(call.tool, 'sgbr_inspect_image');
  assert.deepEqual(call.arguments.region_pct, [0, 85, 30, 15], 'region_pct should be numbers, not strings');
});

test('--show-call coerces repeated --region_pct flags to an array of numbers', async () => {
  const r = await runCli([
    '--show-call', 'inspect', '--scan_id', 'UBBS-00190048',
    '--region_pct', '0', '--region_pct', '85', '--region_pct', '30', '--region_pct', '15',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.deepEqual(call.arguments.region_pct, [0, 85, 30, 15], 'repeated flags should build the same numeric array');
});

test('--show-call coerces a JSON-array-looking --region_pct to numbers', async () => {
  const r = await runCli(['--show-call', 'inspect', '--scan_id', 'UBBS-00190048', '--region_pct', '[0,85,30,15]']);
  assert.equal(r.code, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.deepEqual(call.arguments.region_pct, [0, 85, 30, 15], 'JSON-looking array should match the tool schema shape');
});

test('malformed --filters JSON is a usage error (exit 2) naming the flag', async () => {
  const r = await runCli(['search', '--filters', 'not-json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /filters/, 'stderr names the offending flag');
});

// The dry-run and the real call share one schema validation pass, so --show-call
// can never print a call the server's strict schema would reject.
test('an unknown flag is a usage error (exit 2), even on the --show-call dry-run', async () => {
  const r = await runCli(['--show-call', 'search', 'Basel', '-x', 'foo']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--x is not a flag/, 'stderr names the unknown flag');
  assert.equal(r.stdout, '', 'no call is printed');
});

// A near-miss like `--full-text-only` must not report "requires a value", which
// implies the flag exists.
test('a mis-punctuated flag is reported as unknown, with the near miss', async () => {
  const r = await runCli(['--show-call', 'search', 'Basel', '--full-text-only', '--json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--full-text-only is not a flag/, 'stderr calls it unknown, not value-less');
  assert.match(r.stderr, /Did you mean --full_text_only\?/, 'stderr offers the near miss');
  assert.doesNotMatch(r.stderr, /requires a value/);
  assert.equal(r.stdout, '', 'no call is printed');
});

// `--flag true` would otherwise surface as "unexpected extra argument" — the
// symptom, not the cause.
test('a boolean flag given a separate value explains boolean syntax', async () => {
  const r = await runCli(['--show-call', 'search', 'Basel', '--full_text_only', 'true']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--full_text_only is a boolean flag and takes no separate value/);
  assert.match(r.stderr, /--full_text_only=true/, 'stderr shows the explicit form');
  assert.doesNotMatch(r.stderr, /unexpected extra argument/i);
});

test('a bare boolean flag and its explicit = form both still reach the wire', async () => {
  const bare = await runCli(['--show-call', 'search', 'Basel', '--full_text_only']);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /"full_text_only":\s*true/);
  const explicit = await runCli(['--show-call', 'search', 'Basel', '--full_text_only=false']);
  assert.equal(explicit.code, 0);
  assert.match(explicit.stdout, /"full_text_only":\s*false/);
});

// REGRESSION: the message above recommends `--flag=true`, but the CLI's own bool
// globals are read with strict `=== true` — the tokenizer's string 'true' silently
// disabled them, so following the advice produced wrong output with no error.
// --show-call is itself a global bool AND the offline seam: if the `=` form is
// ignored the CLI stops dry-running and tries to execute, so this asserts the fix
// without an upstream request.
test('the = form recommended for a boolean works for the CLI\'s own global flags', async () => {
  const explicit = await runCli(['--show-call=true', 'search', 'Basel', '--max', '1']);
  assert.equal(explicit.code, 0);
  const bare = await runCli(['--show-call', 'search', 'Basel', '--max', '1']);
  assert.equal(bare.code, 0);
  assert.equal(explicit.stdout, bare.stdout, '--show-call=true must behave exactly like --show-call');
  assert.match(explicit.stdout, /"tool":\s*"sgbr_search"/, 'still the dry-run shape, i.e. never executed');
  // The `=false` half is asserted on a TOOL boolean instead (the preceding test and
  // the repeated-flag one below), since both parse through this same boolFlagValue:
  // --show-call=false would mean "actually execute", i.e. an upstream request.
});

test('a repeated boolean flag stays boolean (last wins), not a [true,true] array', async () => {
  const r = await runCli(['--show-call', 'search', 'Basel', '--full_text_only', '--full_text_only=false']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /"full_text_only":\s*false/);
  assert.doesNotMatch(r.stdout, /"full_text_only":\s*\[/, 'must not put an array on the wire');
});

test('a non-boolean value for a boolean flag is a usage error, not a silent false', async () => {
  const r = await runCli(['--show-call', 'search', 'Basel', '--full_text_only=maybe']);
  assert.equal(r.code, 2);
  // Match the distinctive tail, so this can't pass on the "takes no separate
  // value" message that shares the same opening clause.
  assert.match(r.stderr, /--full_text_only=true or --full_text_only=false \(got "maybe"\)/);
  // A lookup-object parser would find Object.prototype.constructor and sail past.
  const proto = await runCli(['search', 'Basel', '--max', '1', '--json=constructor']);
  assert.equal(proto.code, 2);
  assert.match(proto.stderr, /--json=true or --json=false \(got "constructor"\)/);
});

test('a non-numeric value for a number flag is a usage error (exit 2), not a silent null', async () => {
  const r = await runCli(['--show-call', 'search', 'Basel', '--page_size', 'abc']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--page_size expects a number/);
});

test('a value-taking flag followed by a short flag is rejected, not silently swallowed', async () => {
  const r = await runCli(['--show-call', 'search', 'Basel', '--fields', '-n']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--fields requires a value/);
});

test('a missing required param is a usage error (exit 2) before anything is sent', async () => {
  const r = await runCli(['--show-call', 'get']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /requires <id>/);
});

// A stray extra positional must be a usage error, not silently discarded —
// `facets year "Cholera"` would run as a whole-corpus survey with the query dropped.
test('an extra positional beyond the primary is a usage error (exit 2), not silently dropped', async () => {
  const r = await runCli(['--show-call', 'facets', 'year', 'Cholera']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unexpected extra argument/i, 'stderr flags the extra positional');
  assert.match(r.stderr, /"Cholera"/, 'stderr names the discarded value');
  assert.equal(r.stdout, '', 'no call is printed');
});

test('the primary positional alone is still accepted (regression guard for the extra-positional check)', async () => {
  const r = await runCli(['--show-call', 'facets', 'year', '--query', 'Cholera']);
  assert.equal(r.code, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.equal(call.arguments.facet, 'year');
  assert.equal(call.arguments.query, 'Cholera');
});

// The same guard must hold in --stdin batch mode, where the positional is read
// from stdin (one per line): a command-line positional would otherwise be
// silently dropped. The guard fires before any stdin read, so no input is needed.
test('a command-line positional in --stdin batch mode is a usage error (exit 2)', async () => {
  const r = await runCli(['search', 'Basel', '--stdin']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unexpected extra argument/i, 'stderr flags the stray positional');
  assert.match(r.stderr, /--stdin/, 'stderr explains the batch-mode source');
  assert.equal(r.stdout, '', 'no call is printed');
});

test('--max and the verb\'s own cap flag together are a usage error (exit 2)', async () => {
  const r = await runCli(['search', 'Basel', '-n', '5', '--page_size', '20']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /--max\/-n and --page_size set the same parameter/);
});

test('--stdin with --out is a usage error: every line would overwrite the same file', async () => {
  const r = await runCli(['inspect', '--stdin', '--out', 'x.jpg'], { stdin: 'a\nb\n' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--out/);
});

// ── Offline-safe: per-command help reads the tool's live description + schema ────
test('search --help shows the live description, schema flags, and the --max alias', async () => {
  const r = await runCli(['search', '--help']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /search → sgbr_search/);
  assert.match(r.stdout, /Search records by relevance/, 'the tool\'s own description is rendered live');
  assert.match(r.stdout, /--query <string>/, 'schema-derived flag listed');
  assert.match(r.stdout, /Aliases:\s+--max, -n\s+→\s+page_size/, 'documents the per-verb --max alias');
  assert.match(r.stdout, /Example:\n\s+bbad search/, 'worked example present');
});

test('crosstab --help shows the live description, schema flags, and the --max alias', async () => {
  const r = await runCli(['crosstab', '--help']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /crosstab → sgbr_facet_breakdown/);
  assert.match(r.stdout, /Cross-tabulate/, 'the tool\'s own description is rendered live');
  // The tool's shipped description opens with a complete, self-contained sentence
  // within the deferred-gloss budget (test/smoke.test.js enforces <=79 chars
  // server-side); re-derive the first sentence here rather than hardcoding it.
  const descBlock = r.stdout.split('\n\n')[1] ?? '';
  const firstSentence = descBlock.split('. ')[0];
  assert.ok(firstSentence.length <= 79, `first sentence is ${firstSentence.length} chars; must be <= 79`);
  assert.match(r.stdout, /--breakdown <string>/, 'schema flag for the column dimension');
  assert.match(r.stdout, /Aliases:\s+--max, -n\s+→\s+size/, 'documents the per-verb --max alias');
  assert.match(r.stdout, /Example:\n\s+bbad crosstab/, 'worked example present');
});

// ── Live (SGBR_LIVE=1): real tool calls over the CLI ────────────────────────────
test('search returns JSONL rows + a stderr count line', { skip: !LIVE }, async () => {
  const r = await runCli(['search', 'Basel', '--max', '3', '--fields', 'id,title']);
  assert.equal(r.code, 0, r.stderr);
  const rows = jsonlRows(r.stdout);
  assert.ok(rows.length >= 1 && rows.length <= 3, `1–3 rows (got ${rows.length})`);
  assert.ok(rows.every((row) => 'id' in row), 'each row projected to {id,title} carries id');
  assert.match(r.stderr, /\bshown\b/, 'stderr carries the pagination summary');
});

test('get returns one projected JSON object for a known id', { skip: !LIVE }, async () => {
  const r = await runCli(['get', KNOWN_ID, '--fields', 'id,title']);
  assert.equal(r.code, 0, r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.id, KNOWN_ID);
  assert.ok(typeof obj.title === 'string' && obj.title.length > 0, 'title present');
});

test('inspect --out writes the page-image bytes to disk', { skip: !LIVE }, async () => {
  const out = join(tmpdir(), `bbad-cli-${process.pid}.jpg`);
  rmSync(out, { force: true });
  const r = await runCli(['inspect', '--scan_id', KNOWN_SCAN, '--page', '1', '--max_long_edge', '800', '--out', out], { timeout: 90000 });
  assert.equal(r.code, 0, `exit 0 (got ${r.code}${r.killed ? ', timed out' : ''}) ${r.stderr}`);
  assert.ok(existsSync(out) && statSync(out).size > 0, 'image file written with non-zero size');
  rmSync(out, { force: true });
});

// facets is a list tool: JSONL value rows to stdout, a summary line to stderr.
test('facets returns JSONL value rows + a stderr summary', { skip: !LIVE }, async () => {
  const r = await runCli(['facets', 'library', '--query', 'Basel', '--max', '5', '--fields', 'value,count']);
  assert.equal(r.code, 0, r.stderr);
  const rows = jsonlRows(r.stdout);
  assert.ok(rows.length >= 1 && rows.length <= 5, `1–5 value rows (got ${rows.length})`);
  assert.ok(rows.every((row) => 'value' in row && 'count' in row), 'each row projected to {value,count}');
  assert.ok(rows.every((row) => Number.isInteger(row.count)), 'counts are integers');
  assert.match(r.stderr, /value\(s\)/, 'stderr carries the facet summary line');
});

// --json dumps the whole structuredContent verbatim (no list-splitting/projection).
test('facets --json emits the whole structuredContent object', { skip: !LIVE }, async () => {
  const r = await runCli(['facets', 'library', '--query', 'Basel', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.facet, 'library');
  assert.ok(Array.isArray(obj.values) && obj.values.length > 0, 'values array present');
  assert.ok(Number.isInteger(obj.distinct_values), 'distinct_values is an integer');
});

// fulltext is a single-object window tool: one compact JSON object to stdout, a
// next-window nudge to stderr while more text remains.
test('fulltext returns one windowed object and nudges toward the next window', { skip: !LIVE }, async () => {
  const r = await runCli(['fulltext', KNOWN_ID, '--max_chars', '2000',
    '--fields', 'scan_id,total_chars,returned_chars,has_more,next_offset']);
  assert.equal(r.code, 0, r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.scan_id, KNOWN_SCAN, 'record id resolved to its scan id');
  assert.ok(obj.total_chars > 2000, 'expected a large book');
  assert.ok(obj.returned_chars > 0 && obj.returned_chars <= 2000, 'window respects max_chars');
  assert.equal(obj.has_more, true, 'more windows remain for a big book');
  assert.match(r.stderr, /--offset \d+/, 'stderr nudges toward the next window');
});

// comp (autocomplete) is a single-object tool: one compact JSON object of grouped suggestions.
test('comp returns one grouped-suggestions object', { skip: !LIVE }, async () => {
  const r = await runCli(['comp', 'Burck', '--max', '4']);
  assert.equal(r.code, 0, r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.ok(obj.suggestions && typeof obj.suggestions === 'object', 'grouped suggestions object');
  assert.ok(Object.keys(obj.suggestions).length > 0, 'at least one suggestion group');
  assert.equal(obj.exact_term_records, null, 'comp defaults to scope=all, which carries no count');
});

// crosstab --json dumps the whole nested structuredContent (rows[].cells[]) verbatim.
// This does not re-test backend reconciliation — test/smoke.test.js already owns
// that invariant (cross-checking a cell against sgbr_search).
test('crosstab --json emits the nested rows/cells grid', { skip: !LIVE }, async () => {
  const r = await runCli([
    'crosstab', 'language', '--breakdown', 'genre', '--query', 'Basel',
    '--max', '2', '--breakdown_size', '2', '--json',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.facet, 'language');
  assert.equal(obj.breakdown, 'genre');
  assert.ok(Array.isArray(obj.rows) && obj.rows.length >= 1 && obj.rows.length <= 2, `1-2 rows (got ${obj.rows?.length})`);
  assert.ok(Array.isArray(obj.rows[0].cells) && obj.rows[0].cells.length >= 1 && obj.rows[0].cells.length <= 2,
    `1-2 cells in the first row (got ${obj.rows[0].cells?.length})`);
});

// A capped result must never pipe on as a complete one. The tools state these
// caveats in their text channel, which the CLI replaces with JSONL — so the default
// (non---json) path has to restate them on stderr or the caps go silent. Each note
// below compensates for metadata the projected view structurally cannot carry.
test('crosstab reports both axes as top-N capped, not just a row count', { skip: !LIVE }, async () => {
  const r = await runCli([
    'crosstab', 'language', '--breakdown', 'genre', '--query', 'Basel',
    '--max', '2', '--breakdown_size', '2', '--fields', 'value',
  ]);
  assert.equal(r.code, 0, r.stderr);
  // row_axis/col_axis are nested, so neither the JSONL rows nor --fields reach them.
  assert.match(r.stderr, /note: rows truncated — showing the top 2 of \d+ "language" values/);
  assert.match(r.stderr, /note: columns truncated — .*"genre" values/);
  assert.match(r.stderr, /raise --breakdown_size/, 'the note names the flag that widens the column axis');
});

// The empty-value bucket prints as a blank `value` cell, and the count plus the
// "no filter reaches these" caveat sit in a top-level field the rows never carry.
test('facets restates the empty-value bucket the JSONL rows render as blank', { skip: !LIVE }, async () => {
  const r = await runCli(['facets', 'object_type', '--fields', 'value,count']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /note: [\d,]+ record\(s\) sit in the empty \(""\) value bucket/);
  assert.match(r.stderr, /no filter on this dimension can select them/);
});

test('locate names the unscanned tail and the --start_page to resume from', { skip: !LIVE }, async () => {
  const r = await runCli(['locate', KNOWN_OCR_PHRASE, '--scan_id', KNOWN_OCR_SCAN,
    '--max_pages', '8', '--fields', 'page'], { timeout: 90000 });
  assert.equal(r.code, 0, r.stderr);
  const rows = jsonlRows(r.stdout);
  assert.ok(rows.some((row) => row.page === KNOWN_OCR_PAGE), `the phrase is found on page ${KNOWN_OCR_PAGE}`);
  // Without this the caller reads "N shown" as "the phrase is on exactly N pages of
  // the volume", when only the first 8 pages were ever searched.
  assert.match(r.stderr, /note: only pages 1–8 of the volume were scanned/);
  assert.match(r.stderr, /--start_page 9/, 'the note names the exact resume point');
});

test('pageocr reports the region cap and points at the page text it cannot inline', { skip: !LIVE }, async () => {
  const r = await runCli(['pageocr', '--scan_id', KNOWN_OCR_SCAN, '--page', String(KNOWN_OCR_PAGE),
    '--level', 'word', '--max', '3']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(jsonlRows(r.stdout).length, 3, 'the region cap is honoured');
  assert.match(r.stderr, /note: reached --max_regions/);
  // `text` is a top-level field, so the region rows (and --fields, which projects
  // them) cannot carry it — say where it is rather than dropping it silently.
  assert.match(r.stderr, /note: top-level `text` \([\d,]+ chars\) is not part of the rows — pass --json/);
});

// --json/--table were silent no-ops on `inspect` alone: its branch wrote compact
// JSON and returned before either flag was consulted.
test('inspect honours --table and --json like every other single-object verb', { skip: !LIVE }, async () => {
  const table = await runCli(['inspect', '--scan_id', KNOWN_SCAN, '--page', '1',
    '--max_long_edge', '400', '--table', '--fields', 'scan_id,page'], { timeout: 90000 });
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /^scan_id\s+page\n-+\s+-+\n/, 'a real table, not a JSON object');
  const json = await runCli(['inspect', '--scan_id', KNOWN_SCAN, '--page', '1',
    '--max_long_edge', '400', '--json'], { timeout: 90000 });
  assert.equal(json.code, 0, json.stderr);
  assert.match(json.stdout, /^\{\n {2}"scan_id":/, 'pretty-printed, not compact');
  assert.equal(JSON.parse(json.stdout).scan_id, KNOWN_SCAN);
});
