#!/usr/bin/env node
/**
 * Headless CLI over the "Books as Data" (RDV) MCP server's tools.
 *
 * This is an MCP *client* — it drives the existing server, so a CLI query and an
 * LLM query call the same callTool() on the same server and return identical
 * results (it also doubles as a debug/regression harness + a jq-friendly pipe).
 * There is NO second implementation of any search/lookup logic here.
 *
 * Transport: stdio only. Spawns `node src/index.js` — zero-config (no build step,
 * no data files), never the HTTP entry (src/http.js). The parent
 * environment (SGBR_ACCESS_TOKEN, SGBR_*_ENDPOINT, SGBR_LOG, …) is forwarded to
 * the spawned server, so the CLI honours the same auth/endpoint overrides.
 *
 * Output is JSON-first for agent/pipeline use:
 *   default   list tools → JSONL on stdout; single-object tools → one compact JSON object.
 *   --json    print the entire structuredContent as one pretty JSON object (verbatim).
 *   --table   terse human table (opt-in).
 *   --fields  a,b,c   top-level key projection (the biggest token lever).
 *   --out     inspect: write the page-image bytes to a file.
 *   --stdin   batch: read the primary positional from stdin, one invocation per line.
 *   counts + pagination hints + warnings go to STDERR (keeps stdout pure JSONL).
 *
 * Exit codes:  0 ok · 1 tool/connection error · 2 usage error.
 *
 * Examples:
 *   node scripts/cli.mjs search "Basel" --max 5 --fields id,title,date
 *   node scripts/cli.mjs get id991104550959705501_UBBS-00173645 --fields title,authors,date
 *   node scripts/cli.mjs facets language --query Basel --table
 *   node scripts/cli.mjs fulltext id991104550959705501_UBBS-00173645 --offset 4000 --max_chars 4000
 *   node scripts/cli.mjs inspect --scan_id UBBS-00173645 --page 12 --out page12.jpg
 *   node scripts/cli.mjs tools --compact          # compact capability manifest (agent bootstrap)
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(SERVER_ROOT, 'src', 'index.js');

// Bad input the user can fix (e.g. malformed --filters JSON) → exit 2, not 1.
class UsageError extends Error {}

// One canonical "message from a caught error" form (an Error's .message, else the
// stringified value) for every catch/diagnostic site.
const errMsg = (err) => err?.message ?? String(err);

// ── Verb → tool table (presentation metadata only; schemas come from listTools) ──
// `pos`    = which input param the first positional maps to.
// `list`   = key in structuredContent holding the result array (list tools).
// `total`  = key holding the count for the pagination summary.
// `single` = the tool returns one object, not a list.
// `image`  = the tool returns image bytes in the content channel (→ --out).
// `window` = single tool with char-window paging (offset/next_offset), e.g. fulltext.
// `page`   = "page" (1-based page/page_size). RDV has no offset/token paging.
// `cap`    = the schema param the friendly --max/-n alias maps to. Always the cap on
//            what comes back, never a cost cap on work done — locate takes `max_hits`
//            (pages returned), not `max_pages` (pages scanned).
// `aside`  = a payload key outside the `list` rows (pageocr's page text), which
//            neither the default JSONL nor --fields can reach.
//
// The verbs deliberately drop the `sgbr_` prefix; `get`/`inspect` mirror the family
// (rijks-mcp uses `inspect` for its image tool), and `comp` abbreviates autocomplete.
const VERBS = {
  search:   { tool: 'sgbr_search',           pos: 'query', list: 'results', total: 'total', page: 'page', cap: 'page_size' },
  get:      { tool: 'sgbr_get_record',       pos: 'id',    single: true },
  facets:   { tool: 'sgbr_facet_values',     pos: 'facet', list: 'values', total: 'distinct_values', cap: 'size' },
  fulltext: { tool: 'sgbr_get_fulltext',     pos: 'id',    single: true, window: true, cap: 'max_chars' },
  comp:     { tool: 'sgbr_autocomplete',     pos: 'query', single: true, cap: 'limit' },
  inspect:  { tool: 'sgbr_inspect_image',    pos: 'id',    image: true },
  crosstab: { tool: 'sgbr_facet_breakdown',  pos: 'facet', list: 'rows', total: null, cap: 'size' },
  pageocr:  { tool: 'sgbr_get_page_ocr',     pos: 'id',    list: 'regions', total: null, cap: 'max_regions', aside: 'text' },
  locate:   { tool: 'sgbr_locate_text',      pos: 'phrase', list: 'hits', total: null, cap: 'max_hits' },
  guide:    { tool: 'sgbr_guide',            pos: 'topic', single: true },
};
const TOOL_TO_VERB = Object.fromEntries(Object.entries(VERBS).map(([v, c]) => [c.tool, v]));
const IN_SCOPE_TOOLS = new Set(Object.values(VERBS).map((c) => c.tool));

// The one piece of hand-authored copy: a worked example per verb (a schema can't
// generate a *good* example). Everything else in --help is read live from the
// tool's own description + input schema, so there is no summary to keep in sync.
// Ids are not portable across backend releases, and a superseded one resolves to an
// empty result rather than an error — keep them equal to test/helpers.js' live fixtures.
const VERB_EXAMPLE = {
  search:   'bbad search "Basel" --max 5 --fields id,title,date',
  get:      'bbad get id991104550959705501_UBBS-00173645 --fields title,authors,date',
  facets:   'bbad facets language --query Basel --table',
  fulltext: 'bbad fulltext id991104550959705501_UBBS-00173645 --offset 4000 --max_chars 4000',
  comp:     'bbad comp "Burck" --json',
  inspect:  'bbad inspect --scan_id UBBS-00173645 --page 12 --out page12.jpg  # In a real MCP client a user could request a LLM to e.g. transcribe the page image',
  crosstab: 'bbad crosstab language --breakdown genre --query Basel --json',
  pageocr:  'bbad pageocr --scan_id ZBZ-00057370 --page 5 --level line',
  locate:   'bbad locate "Beschäftigungen" --scan_id ZBZ-00057370 --level line',
  guide:    'bbad guide query_syntax --fields text',
};
// Invariant: every verb has an example. Catches a verb added to VERBS but not here at load.
for (const v of Object.keys(VERBS)) {
  if (!VERB_EXAMPLE[v]) throw new Error(`VERB_EXAMPLE is missing an example for verb "${v}"`);
}

// Global flags (consumed by the CLI, never forwarded as tool args). NB: `--compact` is
// NOT here on purpose — it's only meaningful on the `tools` verb (handled by argv
// inspection before tokenize).
const GLOBAL_BOOL = new Set(['json', 'table', 'quiet', 'show-call', 'help', 'stdin']);
const GLOBAL_VALUE = new Set(['fields', 'out']);
// Short/friendly flag aliases → canonical name. `max` is resolved per-verb to cfg.cap
// in buildToolArgs (page_size/size/limit/max_chars differ per tool).
const FLAG_ALIASES = { n: 'max', o: 'out', h: 'help' };
// Value-taking flags to skip (with their value) during the pre-scan for the verb.
// Only alias *targets* are listed: `-n` resolves to `max` before the set is consulted.
const PRESCAN_VALUE = new Set([...GLOBAL_VALUE, 'max']);

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/tiff': '.tif' };

// The commonest flag slip is punctuation, not spelling: `--full-text-only`.
function nearestFlag(key, candidates) {
  const squash = (s) => s.replace(/[-_]/g, '').toLowerCase();
  return [...candidates].find((c) => c !== key && squash(c) === squash(key)) || null;
}

// The one "you typed a flag that doesn't exist" message. Both catch sites use it
// — the tokenizer's early one (a value-less typo) and validateToolArgs' late one
// (`--typo value`) — so the same mistake can't read two different ways depending
// on which shape it was written in. `candidates` is the pool searched for a near
// miss; `list` enumerates the tool's own flags where the caller knows them.
function unknownFlagError(key, { verb, candidates, list }) {
  const near = nearestFlag(key, candidates);
  return new UsageError(
    `--${key} is not a flag${verb ? ` for "${verb}"` : ''}.`
    + `${near ? ` Did you mean --${near}?` : ''}`
    + `${list ? ` Tool flags: ${list}` : ''}`
    + `${verb ? ` (see \`bbad ${verb} --help\`)` : ''}`,
  );
}

// Is this token flag-shaped — long (`--json`) or short (`-n`)? Module scope so the
// loop-top "is this a positional?" test and the "did the value go missing?" test
// below are literally the same predicate rather than two copies that agree today.
const isFlagLike = (t) => t.startsWith('--')
  || (t.startsWith('-') && t.length === 2 && /[a-z]/i.test(t[1]));

// What does a boolean-flag token mean? Both accepted forms answer here, so the
// bare and `=value` contracts can't drift apart. `next` is only inspected, never
// consumed — a boolean never takes the following token.
// The result must be a REAL boolean, not the string 'true': the CLI's own bool
// globals are read with strict `flags.json === true`, so a string there would
// silently ignore the very form the "takes no separate value" error recommends.
// Rejecting any other value follows coerce()'s number policy — an actionable exit
// 2 beats a silently-false flag. Compared rather than looked up in an object:
// `--json=constructor` would inherit a truthy Object.prototype member and slip
// past an `=== undefined` guard.
function boolFlagValue(key, val, next) {
  if (val === undefined) {
    // `--flag true` would drop `true` into the positionals and resurface as
    // "unexpected extra argument" — name the real cause instead.
    if (next === 'true' || next === 'false') {
      throw new UsageError(
        `--${key} is a boolean flag and takes no separate value — write --${key} for true, ` +
        `or --${key}=${next} to be explicit`,
      );
    }
    return true;
  }
  const v = String(val).toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new UsageError(`--${key} is a boolean flag — write --${key}=true or --${key}=false (got "${val}")`);
}

// Flag classification for one tool, in a single pass over its schema:
// `boolSet` = flags that take no value (boolean params + the CLI's own bool
// globals); `known` = every key the tokenizer should recognise at all (that plus
// the value-taking globals and the --max alias), used only to tell a typo from a
// flag whose value went missing.
function flagSetsFor(schema, cfg) {
  const props = schema?.properties ?? {};
  const boolSet = new Set(GLOBAL_BOOL);
  const known = new Set([...GLOBAL_BOOL, ...GLOBAL_VALUE, ...Object.keys(props)]);
  for (const [name, prop] of Object.entries(props)) {
    if (propType(prop) === 'boolean') boolSet.add(name);
  }
  if (cfg?.cap) known.add('max');
  return { boolSet, known };
}

// ── Tiny arg tokenizer ────────────────────────────────────────────────────────
// parseArgs can't disambiguate `--flag value` from a boolean without a per-flag
// spec, and we only know booleans after listTools(). So we hand-roll: a flag is
// boolean if it's in `boolSet`; otherwise it consumes the next token as its value.
// `--key=value` always works; repeated keys collect into an array.
function tokenize(args, boolSet, { known, verb } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (!isFlagLike(a)) {
      positionals.push(a);
      continue;
    }
    const dashless = a.replace(/^--?/, '');
    const eq = dashless.indexOf('=');
    let key, val;
    if (eq !== -1) {
      key = dashless.slice(0, eq);
      val = dashless.slice(eq + 1);
    } else {
      key = dashless;
    }
    key = FLAG_ALIASES[key] || key;
    const isBool = boolSet.has(key);
    if (isBool) {
      val = boolFlagValue(key, val, args[i + 1]);
    } else if (val === undefined) {
      const next = args[i + 1];
      // A non-boolean flag needs a value. Reject end-of-args and the case where
      // the next token is itself a flag — long (`--max --json`) OR short
      // (`--fields -n`), reusing isFlagLike so this and the positional test above
      // can't disagree. The `--key=value` form is the escape hatch for any value
      // that genuinely starts with a dash.
      if (next === undefined || isFlagLike(next)) {
        // An unrecognised key is likelier a typo than a flag whose value went
        // missing, and "requires a value" implies the flag exists. Only reached
        // when nothing value-shaped follows; `--typo value` hits validateToolArgs.
        if (known && !known.has(key)) throw unknownFlagError(key, { verb, candidates: known });
        throw new UsageError(`--${key} requires a value (use --${key}=<value> if the value starts with a dash)`);
      }
      val = next;
      i++;
    }
    // Repeated keys collect into an array — EXCEPT booleans, where last wins:
    // `[true, true]` would fail every `=== true` read downstream, so `--json --json`
    // would silently disable --json (and a repeated tool boolean would put an array
    // on the wire for a boolean param).
    if (key in flags && !isBool) flags[key] = [].concat(flags[key], val);
    else flags[key] = val;
  }
  return { flags, positionals };
}

// ── JSON Schema → arg classification ────────────────────────────────────────────
function propType(prop) {
  if (!prop || typeof prop !== 'object') return 'string';
  // Arrays of numbers (e.g. inspect.region_pct) — route through the numeric
  // coercion so each element is Number()-checked; comma form is split first.
  if (prop.type === 'array' && (prop.items?.type === 'number' || prop.items?.type === 'integer')) return 'numarray';
  if (prop.type === 'array') return 'array';
  if (prop.type === 'integer' || prop.type === 'number') return 'number';
  if (prop.type === 'boolean') return 'boolean';
  // unions (e.g. string | string[]) → allow repeatable
  if (Array.isArray(prop.anyOf) && prop.anyOf.some((b) => b?.type === 'array')) return 'array';
  // Nested object params (e.g. sgbr_search.filters) take a JSON literal:
  //   --filters '{"language":["ger"]}' — parsed in coerce() before it goes on the wire.
  if (prop.type === 'object') return 'json';
  return 'string';
}

function coerce(value, type, name) {
  if (type === 'number') {
    // Reject non-numeric input here (exit 2, actionable) instead of letting
    // Number() coin a NaN that JSON.stringify would silently turn into null.
    const arr = [].concat(value).map((v) => {
      const n = v === '' ? NaN : Number(v);
      if (Number.isNaN(n)) throw new UsageError(`--${name} expects a number, got "${v}"`);
      return n;
    });
    return arr.length === 1 ? arr[0] : arr;
  }
  if (type === 'boolean') {
    // tokenize() already resolved every boolean FLAG to a real boolean (boolSet
    // covers each schema boolean), so a string only arrives here from a boolean
    // positional or --stdin line. Reuse the flag parser rather than keeping a
    // second, laxer one — a lone `=== 'true'` test would silently read "maybe" as
    // false, which is exactly what the flag path raises an actionable error for.
    const arr = [].concat(value).map((v) => boolFlagValue(name, v));
    return arr.length === 1 ? arr[0] : arr;
  }
  if (type === 'array') return [].concat(value);
  if (type === 'numarray') {
    return [].concat(value).flatMap((v) => {
      const raw = String(v).trim();
      // The `[...]` JSON shorthand is numarray-ONLY: a numeric element can never
      // itself start with '[', so the parse is unambiguous. String `array` flags
      // must not get it — a bracketed value there can be a legitimate literal
      // (catalogue strings like "[Anon.]"), which JSON.parse would corrupt.
      if (raw.startsWith('[') && raw.endsWith(']')) {
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error('not an array');
          return parsed;
        } catch (e) {
          throw new UsageError(`--${name} expects a JSON array of numbers — ${e.message}`);
        }
      }
      return raw.split(',');
    }).map((v) => {
      const n = v === '' ? NaN : Number(v);
      if (Number.isNaN(n)) throw new UsageError(`--${name} expects numbers, got "${v}"`);
      return n;
    });
  }
  if (type === 'json') {
    if (typeof value !== 'string') throw new UsageError(`--${name} expects a single JSON object (pass it once)`);
    try { return JSON.parse(value); }
    catch (e) { throw new UsageError(`--${name} expects a JSON object (e.g. '{"language":["ger"]}') — ${e.message}`); }
  }
  return value;
}

// Map tokenized flags + positionals → tool arguments (coerced per schema).
function buildToolArgs(verb, verbCfg, schema, flags, positionals) {
  const props = schema?.properties ?? {};
  /** @type {Record<string, unknown>} */
  const args = {};
  for (const [key, raw] of Object.entries(flags)) {
    if (GLOBAL_BOOL.has(key) || GLOBAL_VALUE.has(key)) continue;
    let name = key;
    if (key === 'max') {
      // Per-verb alias: --max/-n → the tool's result-cap param (page_size/size/limit/max_chars).
      if (!verbCfg.cap) throw new UsageError(`--max/-n is not a flag for "${verb}" — see \`bbad ${verb} --help\``);
      name = verbCfg.cap;
      // Both spellings set one parameter; letting the later one win would drop a value silently.
      if (flags[name] !== undefined) throw new UsageError(`--max/-n and --${name} set the same parameter for "${verb}"; pass one`);
    }
    args[name] = coerce(raw, propType(props[name]), name);
  }
  // First positional → the verb's primary param (if the flag wasn't already set).
  // An empty positional is dropped, not coerced: several primary params are
  // required (get.id, comp.query, facets.facet), so we never put pos:"" on the
  // wire — let the server's own required-field validation produce a clean error.
  let consumed = 0;
  if (positionals.length && verbCfg.pos && args[verbCfg.pos] === undefined && positionals[0] !== '') {
    args[verbCfg.pos] = coerce(positionals[0], propType(props[verbCfg.pos]), verbCfg.pos);
    consumed = 1;
  }
  // A verb consumes at most one positional (its primary param). Reject any extra
  // rather than silently discarding it — `facets year "Cholera"` would otherwise run
  // as a whole-corpus survey with the query dropped. Empty strings never go on the
  // wire, so they don't count as extras.
  const extra = positionals.slice(consumed).filter((p) => p !== '');
  if (extra.length) {
    const shown = extra.map((e) => `"${e}"`).join(', ');
    const hint = verbCfg.pos
      ? `"${verb}" takes a single <${verbCfg.pos}> positional; pass other values as flags`
      : `"${verb}" takes no positional arguments`;
    throw new UsageError(`unexpected extra argument(s): ${shown} — ${hint} (see \`bbad ${verb} --help\`)`);
  }
  return args;
}

// Validate resolved args against the tool's live inputSchema BEFORE anything is
// printed or sent: an unknown flag or a missing required param is a usage error
// (exit 2) in the schema's own vocabulary — and --show-call can never present a
// call as clean that the server's strict schema is guaranteed to reject.
function validateToolArgs(verb, schema, args, { requireRequired = true } = {}) {
  const props = schema?.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!(key in props)) {
      throw unknownFlagError(key, {
        verb,
        candidates: Object.keys(props),
        list: Object.keys(props).map((p) => `--${p}`).join(', '),
      });
    }
  }
  if (requireRequired) {
    for (const req of schema?.required ?? []) {
      if (args[req] === undefined) {
        throw new UsageError(`"${verb}" requires <${req}> (positional or --${req}) — see \`bbad ${verb} --help\``);
      }
    }
  }
}

// ── Transport / connection ───────────────────────────────────────────────────
const SERVER_BANNER = /^\[ub-sgbr-mcp\] listening on stdio\n/m;

async function connect({ quiet = false } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: SERVER_ROOT,
    // Forward the whole environment so SGBR_ACCESS_TOKEN / endpoint overrides /
    // SGBR_LOG reach the server (StdioClientTransport otherwise inherits only a
    // safe allowlist). The server's stderr is piped so its startup banner can be
    // dropped; everything else it says (a config warning, SGBR_LOG lines, a crash)
    // is passed on unless --quiet, and is reported on a failed connect regardless.
    env: { ...process.env, SGBR_ENTRY_POINT: 'cli' },
    stderr: 'pipe',
  });
  const serverErr = [];
  const onServerErr = (c) => serverErr.push(c.toString());
  transport.stderr?.on('data', onServerErr);
  const client = new Client({ name: 'bbad-cli', version: '0.1' });
  try {
    await client.connect(transport);
  } catch (err) {
    const tail = serverErr.join('').trim();
    throw new Error(tail ? `${errMsg(err)}\n${tail}` : errMsg(err), { cause: err });
  }
  transport.stderr?.off('data', onServerErr);
  const forward = (text) => {
    const rest = text.replace(SERVER_BANNER, '');
    if (rest) process.stderr.write(rest);
  };
  if (!quiet) {
    forward(serverErr.join(''));
    transport.stderr?.on('data', (c) => forward(c.toString()));
  }
  return client;
}

// ── Result helpers ─────────────────────────────────────────────────────────────
const textOf = (res) => (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const imageOf = (res) => (res.content ?? []).find((c) => c.type === 'image');

function parseFields(f) {
  return f ? String(f).split(',').map((s) => s.trim()).filter(Boolean) : null;
}

function project(obj, fields) {
  if (!fields || !obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

// A table cell holds a scalar or a list of them (authors, languages), joined.
const isScalar = (v) => v == null || typeof v !== 'object';
const tableValue = (v) => (Array.isArray(v) && v.every(isScalar) ? v.join('; ') : v);
const isCell = (v) => isScalar(tableValue(v));

function renderTable(rows, fields) {
  if (!rows.length) return '(no results)';
  const cols = (fields && fields.length ? fields : Object.keys(rows[0]).filter((k) => isCell(rows[0][k])))
    .slice(0, 6);
  const cell = (raw) => {
    const v = tableValue(raw);
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 40 ? s.slice(0, 37) + '…' : s;
  };
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const fmt = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  const lines = [fmt(cols), fmt(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) lines.push(fmt(cols.map((c) => cell(r[c]))));
  return lines.join('\n');
}

// Pagination/summary line for list tools (→ stderr). search pages by 1-based page
// (+ has_more); facets is size-capped (others_count = values beyond the returned set).
function paginationSummary(verbCfg, data, list) {
  if (verbCfg.page === 'page') {
    const page = Number(data.page ?? 1) || 1;
    const total = verbCfg.total ? data[verbCfg.total] : undefined;
    let s = `${list.length} shown (page ${page})${typeof total === 'number' ? ` of ${total}` : ''}`;
    if (data.next_page != null) s += `; pass --page ${data.next_page} for more`;
    else if (data.has_more) {
      s += data.returned < data.page_size
        ? '; the page came back short — see the warning before paging on'
        : '; more exist past the result window — narrow the query to reach them';
    }
    return s;
  }
  // Non-paged list tool (facets): total (distinct_values) is the count of value
  // buckets; others_count is RECORDS in the tail buckets beyond those returned —
  // not additional values. Mirror the tool's own text-channel wording so the two
  // never disagree.
  const total = verbCfg.total ? data[verbCfg.total] : undefined;
  if (typeof data.others_count === 'number') {
    const shown = `${list.length} of ${typeof total === 'number' ? total : '?'} value(s)`;
    return data.others_count > 0
      ? `${shown}; +${data.others_count.toLocaleString('en-US')} record(s) in other values (raise --size)`
      : shown;
  }
  return `${list.length} shown${typeof total === 'number' ? ` of ${total}` : ''}`;
}

// What a truncated result means and what widens it, keyed by the tool's own
// `truncation_reason`. The reasons are disjoint across tools (max_pages/max_hits from
// locate, max_regions/result_budget from pageocr), so one flat table needs no per-verb
// branch; each names the CLI flag rather than the raw schema param.
const TRUNCATION_NOTES = {
  max_hits: () => 'reached --max_hits (--max/-n) — raise it, or resume with --start_page past the last hit, to see more matching pages',
  max_pages: (d) => {
    const next = d.next_start_page;
    return `only pages ${d.start_page}–${next - 1} of the volume were scanned (--max_pages window), so `
      + `a phrase further in is NOT ruled out — resume with --start_page ${next}`;
  },
  max_regions: () => 'reached --max_regions (--max/-n) — raise it to see more regions',
  result_budget: () => 'hit the response-size budget (raising --max_regions will not help) — '
    + 'request a coarser --level, or --include_text=false',
};

// Caveats the tools state only in their human-readable text channel, which the CLI
// replaces with JSONL — without them a capped result reads as a complete one.
function resultNotes(verbCfg, data) {
  const notes = [];
  if (verbCfg.window && data.has_more && data.next_offset != null) {
    const same = data.page_from != null ? ' (with the same --page_from/--page_to)' : '';
    notes.push(`more text — pass --offset ${data.next_offset}${same} for the next window`);
  }
  if (data.last_page != null) {
    notes.push(`the volume ends at page ${data.last_page} — the span was cut there`);
  }
  // Each cross-tab axis is a top-N grid, so an absent value is not absent from the
  // corpus. That lives in nested row_axis/col_axis, which --fields cannot project.
  for (const [key, role, flag] of [['row_axis', 'rows', '--max'], ['col_axis', 'columns', '--breakdown_size']]) {
    const axis = data[key];
    if (!axis?.truncated) continue;
    const of = axis.distinct_values != null ? ` of ${axis.distinct_values.toLocaleString('en-US')}` : '';
    const rest = axis.others_count
      ? `, ${axis.others_count.toLocaleString('en-US')} record(s) in the un-shown values` : '';
    notes.push(`${role} truncated — showing the top ${axis.returned}${of} "${axis.dimension}" values${rest}; raise ${flag}`);
  }
  // The tool searched one volume of a multivolume work; an empty result is not "absent from the work".
  if (data.siblings?.is_multivolume) {
    const { searched_volume: searched, volumes } = data.siblings;
    const others = volumes.filter((v) => v !== searched);
    notes.push(`multivolume work — searched only volume ${searched} of `
      + `${volumes.length}; other volumes: ${others.join(', ') || '(none other found)'}; `
      + 'rerun with --scan_id <volume> for each');
  }
  // Scans the record lists beyond what the sibling note covers.
  if (data.unsearched_scans?.length) {
    const more = data.scans_unsearched - data.unsearched_scans.length;
    notes.push(`not searched: ${data.unsearched_scans.join(', ')}${more > 0 ? `, … (${more} more)` : ''} `
      + '(other scans this record lists); rerun with --scan_id <scan> for each');
  }
  // Cross-tab row totals are each value's own facet count, so they cannot be re-derived from the cells.
  if (Array.isArray(data.rows) && data.rows.some((r) => r.total != null)) {
    notes.push('row totals are each value\'s own facet count, not a sum of its cells (cells can overlap)');
  }
  // The facet rows carry an empty-value bucket as a blank `value`, which reads as
  // a glitch rather than as the finding it is; the count and the "no filter can
  // reach these" caveat live in top-level fields the JSONL path never emits.
  // Coverage is a top-level figure too; null means the tool withheld it (warned).
  if (typeof data.coverage_pct === 'number' && typeof data.query_total === 'number') {
    notes.push(`${data.coverage_pct}% of ${data.query_total.toLocaleString('en-US')} hits carry this dimension`);
  }
  if (data.absent_records) {
    const excluded = typeof data.coverage_pct === 'number' ? ', and they are excluded from that coverage' : '';
    notes.push(`${data.absent_records.toLocaleString('en-US')} record(s) sit in the empty ("") `
      + `value bucket — no filter on this dimension can select them${excluded}`);
  }
  // A bare `truncated` is only actionable with the reason.
  if (data.truncated === true) {
    notes.push(TRUNCATION_NOTES[data.truncation_reason]?.(data) ?? 'result truncated');
  }
  // Narrower than `truncated`: the hits and snippets are complete, the anchors are not.
  if (data.regions_truncated === true) {
    notes.push('some hits\' region lists were trimmed to fit the response budget — '
      + 'refetch a page\'s full regions with `pageocr`');
  }
  const aside = verbCfg.aside ? data[verbCfg.aside] : null;
  if (typeof aside === 'string' && aside.length) {
    notes.push(`top-level \`${verbCfg.aside}\` (${aside.length.toLocaleString('en-US')} chars) `
      + 'is not part of the rows — pass --json to read it');
  }
  return notes;
}

function emitNotes(verbCfg, data, quiet, pre = '') {
  if (quiet) return;
  for (const note of resultNotes(verbCfg, data)) process.stderr.write(`${pre}note: ${note}\n`);
}

// ── Output rendering ─────────────────────────────────────────────────────────
// `input` is the --stdin line this result answers: every row carries it and every
// stderr line names it, so a batch's output stays attributable line by line.
function renderResult(res, verbCfg, flags, input = null) {
  const fields = parseFields(flags.fields);
  const data = res.structuredContent ?? safeParseJson(textOf(res));
  const quiet = flags.quiet === true;
  const pre = input == null ? '' : `[${input}] `;
  const tag = (row) => (input == null ? row : { input, ...row });
  const tableFields = fields && input != null ? ['input', ...fields] : fields;
  // ub-sgbr's compiler emits advisory query warnings (AND/OR/NOT + field:value
  // misuse) in structuredContent.warnings — mirror them to stderr, off stdout.
  const emitWarnings = () => {
    if (!quiet && Array.isArray(data?.warnings) && data.warnings.length) {
      process.stderr.write(`${pre}warnings: ` + data.warnings.join(' | ') + '\n');
    }
  };

  // Image tool — write the bytes to --out, never dump base64 to stdout. Bytes only:
  // the metadata falls through to the single-object path, so --json/--table work there.
  if (verbCfg.image) {
    const img = imageOf(res);
    if (flags.out && img) {
      let out = String(flags.out);
      if (!path.extname(out)) out += MIME_EXT[img.mimeType] ?? '.bin';
      writeFileSync(out, Buffer.from(img.data, 'base64'));
      if (!quiet) process.stderr.write(`${pre}Wrote ${out} (${img.mimeType})\n`);
    } else if (img && !quiet) {
      process.stderr.write(`${pre}Image bytes available (${img.mimeType}); pass --out <file> to save them.\n`);
    }
  }

  if (!data || typeof data !== 'object') {
    // No structuredContent — fall back to the human-readable text channel.
    process.stdout.write(textOf(res) + '\n');
    return;
  }

  // --json: full structuredContent verbatim (pretty), no list-splitting/projection.
  // Nothing is elided, hence no truncation notes — those only compensate for what the
  // projected views drop.
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(tag(data), null, 2) + '\n');
    emitWarnings();
    return;
  }

  // Single-object tools (get, fulltext, comp) and inspect's image metadata → one
  // compact JSON object.
  if (verbCfg.single || verbCfg.image) {
    if (flags.table === true) process.stdout.write(renderTable([tag(project(flatten(data), fields))], tableFields) + '\n');
    else process.stdout.write(JSON.stringify(tag(project(data, fields))) + '\n');
    emitNotes(verbCfg, data, quiet, pre);
    emitWarnings();
    return;
  }

  // List tools → JSONL (default) or table.
  const listKey = verbCfg.list ?? Object.keys(data).find((k) => Array.isArray(data[k]));
  const list = Array.isArray(data[listKey]) ? data[listKey] : [];
  if (flags.table === true) {
    process.stdout.write(renderTable(list.map((r) => tag(project(r, fields))), tableFields) + '\n');
  } else {
    for (const row of list) process.stdout.write(JSON.stringify(tag(project(row, fields))) + '\n');
  }
  if (!quiet) process.stderr.write(pre + paginationSummary(verbCfg, data, list) + '\n');
  emitNotes(verbCfg, data, quiet, pre);
  emitWarnings();
}

// Shallow-flatten an object for table display (drops nested objects/arrays).
function flatten(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isCell(v)) out[k] = v;
  }
  return out;
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Read stdin to EOF and return the meaningful lines: trimmed, with blanks and
// `#`-comment lines dropped. Used by --stdin batch mode (one invocation per line).
async function readStdinLines() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// ── Help / discovery ─────────────────────────────────────────────────────────
// Fully static — no toolMap, no connection. The per-verb command line lists the
// mapped tool name only; the rich (live) description is one `<verb> --help` away.
function topUsage() {
  // Derived from VERBS so these lines can't drift from the table (which verb caps
  // with what, which verb produces an image) when a verb is added or repointed.
  const capMap = Object.entries(VERBS).filter(([, c]) => c.cap).map(([v, c]) => `${c.cap} (${v})`).join(' · ');
  const imageVerbs = Object.keys(VERBS).filter((v) => VERBS[v].image).join('/');
  const lines = [
    'bbad — headless CLI over the "Books as Data" MCP tools',
    '',
    'Usage: bbad <command> [args] [flags]',
    '       bbad tools [--compact|--json]   list tool capabilities (compact = agent bootstrap)',
    '       bbad <command> --help           full description, flags + an example for one command',
    '',
    'Commands:',
  ];
  for (const verb of Object.keys(VERBS)) {
    lines.push(`  ${verb.padEnd(10)} ${VERBS[verb].tool}`);
  }
  lines.push(
    '',
    'Common flags:',
    '  --fields a,b,c   project to these top-level keys on every row (biggest token saver)',
    `  --max N  (-n)    result cap → ${capMap}`,
    '  --json           full structuredContent payload, pretty-printed',
    '  --table          terse human-readable table',
    `  --out <file>     ${imageVerbs}: write the page-image bytes to disk`,
    '  --quiet          suppress the stderr count/summary/warning lines, and the server\'s own stderr',
    '  --show-call      print the resolved {tool, arguments} WITHOUT executing (cheap dry-run)',
    '  --stdin          batch: read the positional from stdin, one invocation per line (one connection); not with --out.',
    '                   Each row gains an `input` field, and each summary/note/warning line a [<input>] prefix',
    '',
    'Transport:  stdio only — spawns `node src/index.js` (zero-config: no build step).',
    '            SGBR_ACCESS_TOKEN, SGBR_*_ENDPOINT and SGBR_LOG are forwarded to the server.',
    'Output:     list tools → JSONL · single-object tools → one compact JSON · counts+warnings → stderr.',
    'Exit:       0 ok · 1 tool/connection error · 2 usage error',
  );
  return lines.join('\n');
}

// First line of a description, truncated on a word boundary (no mid-word cuts) with an ellipsis.
function clip(text, n) {
  const s = (text ?? '').split('\n')[0];
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut) + '…';
}

// Surface a flag's allowed values (string enum or array-of-enum); inline if short, else punt.
function enumValues(prop) {
  const vals = Array.isArray(prop?.enum) ? prop.enum
    : Array.isArray(prop?.items?.enum) ? prop.items.enum
      : null;
  if (!vals || !vals.length) return null;
  const joined = vals.map(String).join('|');
  return joined.length <= 60 ? `{${joined}}` : `{${vals.length} values — see \`tools --json\`}`;
}

// Per-command help. With a live `tool` (server reachable): the tool's own full
// description + schema-derived flag list (enums + the --max alias) + a worked
// example. Without one (`tool` null): the header + example + a hint.
function verbHelp(verb, cfg, tool) {
  const lines = [`${verb} → ${cfg.tool}`, ''];
  if (tool?.description) lines.push(tool.description, '');
  if (cfg.pos) lines.push(`Positional: <${cfg.pos}>  (first positional maps to --${cfg.pos})`, '');
  if (tool) {
    const props = tool.inputSchema?.properties ?? {};
    const required = new Set(tool.inputSchema?.required ?? []);
    lines.push('Flags:');
    for (const [name, prop] of Object.entries(props)) {
      const req = required.has(name) ? ' (required)' : '';
      const desc = clip(prop?.description, 90);
      const enums = enumValues(prop);
      lines.push(`  --${name} <${propType(prop)}>${req}  ${desc}${enums ? '  ' + enums : ''}`);
    }
    if (cfg.image) lines.push('  --out <file>  write the image bytes to disk');
    if (cfg.cap) lines.push('', `Aliases:  --max, -n  → ${cfg.cap}`);
  }
  lines.push('', 'Example:', '  ' + VERB_EXAMPLE[verb]);
  if (!tool) lines.push(
    '',
    '(The full description + flag list are read live from the server, which could not be spawned.',
    ' Check that `node src/index.js` starts — run `npm start` to see any startup error.)',
  );
  return lines.join('\n');
}

// Static help for the built-in `tools` command (advertised in topUsage). Describes the three
// output modes; like the other help paths it renders without connecting to a server.
function toolsHelp() {
  return [
    'tools — list the in-scope tool capabilities (introspection; not a real tool call)',
    '',
    'Usage: bbad tools [--compact|--json]',
    '',
    '  (default)   verb → tool-name table',
    '  --compact   compact capability manifest (agent bootstrap): one entry per tool —',
    '              verb, tool, positional, result shape, paging, args as name→type (`!` = required)',
    '  --json      full input + output JSON Schema per tool (deep introspection)',
    '',
    'All three read the live schema, so they spawn the server (zero-config: `node src/index.js`).',
  ].join('\n');
}

// Lists what the server registered, not the VERBS table, so the pack job's
// comparison with manifest.json reads the shipped server.
function toolsDump(toolMap, asJson) {
  const tools = [...toolMap.values()].map((t) => ({
    name: t.name, verb: TOOL_TO_VERB[t.name] ?? null,
    description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema,
  }));
  if (asJson) return JSON.stringify(tools, null, 2);
  return tools.map((t) => `${(t.verb ?? '-').padEnd(10)} ${t.name}`).join('\n');
}

// Compact capability manifest for agent bootstrap — verb, tool, positional, result
// shape, paging, and arg names→types only (no descriptions or full JSON Schemas). A
// trailing "!" marks a required arg. Orders of magnitude cheaper than `tools --json`.
function toolsCompact(toolMap) {
  return [...IN_SCOPE_TOOLS].map((name) => {
    const verb = TOOL_TO_VERB[name];
    const cfg = VERBS[verb];
    const schema = toolMap.get(name)?.inputSchema;
    const required = new Set(schema?.required ?? []);
    const args = {};
    for (const [k, prop] of Object.entries(schema?.properties ?? {})) {
      args[k] = propType(prop) + (required.has(k) ? '!' : '');
    }
    const result = cfg.single ? 'single' : cfg.image ? 'image' : (cfg.list ?? null);
    const entry = { verb, tool: name, positional: cfg.pos ?? null, result, args };
    if (cfg.page) entry.page = cfg.page;
    return entry;
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);

  // Pre-scan for the verb: the first bare token, skipping value-taking global flags
  // (--fields/--out/--max/-n) in their space form so their value isn't mistaken for it.
  let verb;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      const bare = a.replace(/^--?/, '').split('=')[0];
      const key = FLAG_ALIASES[bare] ?? bare;
      if (PRESCAN_VALUE.has(key) && !a.includes('=')) i++; // skip its value
      continue;
    }
    verb = a;
    break;
  }

  const wantsHelp = argv.includes('--help') || argv.includes('-h') || verb === 'help' || argv.length === 0;
  const isTopHelp = wantsHelp && (verb === 'help' || verb === undefined);

  // Top-level help is fully static — render it WITHOUT connecting (instant, offline-safe).
  if (isTopHelp) {
    process.stdout.write(topUsage() + '\n');
    return;
  }

  // `tools` is a built-in (not in VERBS) but advertised in the usage — its --help is static too.
  if (wantsHelp && verb === 'tools') {
    process.stdout.write(toolsHelp() + '\n');
    return;
  }

  const cfg = VERBS[verb];
  // Unknown command (and not the built-in `tools`) is a static usage error — no server needed.
  if (!cfg && verb !== 'tools') {
    process.stderr.write(`Unknown command: ${verb ?? '(none)'}\n\n${topUsage()}\n`);
    process.exitCode = 2;
    return;
  }
  const isVerbHelp = wantsHelp && !!cfg; // `<command> --help`

  let client;
  try {
    client = await connect({ quiet: argv.includes('--quiet') });
  } catch (err) {
    // Per-command help degrades to static verb info + a hint when the server won't spawn.
    if (isVerbHelp) {
      process.stdout.write(verbHelp(verb, cfg, null) + '\n');
      return;
    }
    process.stderr.write(`Connection failed: ${errMsg(err)}\n`);
    process.stderr.write('Hint: check that `node src/index.js` starts (run `npm start`).\n');
    process.exitCode = 1;
    return;
  }

  // A PID-targeted SIGINT/SIGTERM would otherwise skip the `finally` below and
  // orphan the spawned server (client.close() is what tears the child down).
  // Close first, then exit with the conventional 128+signal code.
  const onSignal = (code) => {
    client.close().catch(() => {}).finally(() => process.exit(code));
  };
  process.on('SIGINT', () => onSignal(130));
  process.on('SIGTERM', () => onSignal(143));

  try {
    const listed = await client.listTools();
    const toolMap = new Map(listed.tools.map((t) => [t.name, t]));

    if (verb === 'tools') {
      if (argv.includes('--compact')) {
        process.stdout.write(JSON.stringify(toolsCompact(toolMap), null, 2) + '\n');
      } else {
        process.stdout.write(toolsDump(toolMap, argv.includes('--json')) + '\n');
      }
      return;
    }

    const tool = toolMap.get(cfg.tool);
    if (!tool) {
      process.stderr.write(`Tool ${cfg.tool} is not available on this server.\n`);
      process.exitCode = 1;
      return;
    }

    if (isVerbHelp) {
      process.stdout.write(verbHelp(verb, cfg, tool) + '\n');
      return;
    }

    // Re-tokenize using the tool's schema, dropping the verb itself from positionals.
    const { boolSet, known } = flagSetsFor(tool.inputSchema, cfg);
    const { flags, positionals } = tokenize(argv, boolSet, { known, verb });
    // The verb is always the first bare token; drop it so the rest map to tool params.
    const restPositionals = positionals[0] === verb ? positionals.slice(1) : positionals;

    // Batch mode: read the primary positional from stdin, one invocation per line
    // over this single connection. Other flags (--fields/--json/--max/…) apply per line.
    if (flags.stdin === true) {
      if (!cfg.pos) throw new UsageError(`--stdin needs a verb with a positional argument; ${verb} has none`);
      // The <pos> arrives from stdin, one per line, so buildToolArgs is called with
      // no positionals below — meaning its extra-positional guard is bypassed here.
      // Re-assert it: a command-line positional would otherwise be silently dropped.
      const stray = restPositionals.filter((p) => p !== '');
      if (stray.length) {
        const shown = stray.map((e) => `"${e}"`).join(', ');
        throw new UsageError(
          `unexpected extra argument(s): ${shown} — in --stdin mode the <${cfg.pos}> is read from ` +
          `stdin, one per line; remove the command-line value(s) (see \`bbad ${verb} --help\`)`,
        );
      }
      if (process.stdin.isTTY) throw new UsageError("--stdin set but stdin is a TTY — pipe input (e.g. `printf 'Basel\\n' | bbad search --stdin`)");
      if (cfg.image && flags.out) {
        throw new UsageError('--out cannot be combined with --stdin: every input line would overwrite the same file. Run one `inspect` per page instead.');
      }
      const lines = await readStdinLines();
      // The non-positional flags are identical for every line — coerce them once,
      // then per line just clone and set the positional (skips re-parsing e.g.
      // --filters JSON on each iteration).
      const baseArgs = buildToolArgs(verb, cfg, tool.inputSchema, flags, []);
      // Unknown flags fail fast, before the first line is processed; required
      // params are checked per line (the positional arrives with each line).
      validateToolArgs(verb, tool.inputSchema, baseArgs, { requireRequired: false });
      const posProp = tool.inputSchema?.properties?.[cfg.pos];
      let failures = 0;
      for (const line of lines) {
        const toolArgs = { ...baseArgs, [cfg.pos]: coerce(line, propType(posProp), cfg.pos) };
        validateToolArgs(verb, tool.inputSchema, toolArgs);
        if (flags['show-call'] === true) {
          process.stdout.write(JSON.stringify({ tool: cfg.tool, arguments: toolArgs }) + '\n');
          continue;
        }
        try {
          const res = await client.callTool({ name: cfg.tool, arguments: toolArgs });
          if (res.isError) { process.stderr.write(`[${line}] ${textOf(res)}\n`); failures++; continue; }
          renderResult(res, cfg, flags, line);
        } catch (err) {
          process.stderr.write(`[${line}] Error: ${errMsg(err)}\n`);
          failures++;
        }
      }
      if (failures) {
        process.stderr.write(`${failures} of ${lines.length} input(s) failed\n`);
        process.exitCode = 1;
      }
      return;
    }

    const toolArgs = buildToolArgs(verb, cfg, tool.inputSchema, flags, restPositionals);
    // Validated before EITHER path below — the dry-run prints only calls the
    // real invocation could actually make.
    validateToolArgs(verb, tool.inputSchema, toolArgs);

    if (flags['show-call'] === true) {
      process.stdout.write(JSON.stringify({ tool: cfg.tool, arguments: toolArgs }, null, 2) + '\n');
      return;
    }

    const res = await client.callTool({ name: cfg.tool, arguments: toolArgs });
    if (res.isError) {
      process.stderr.write(textOf(res) + '\n');
      process.exitCode = 1;
      return;
    }
    renderResult(res, cfg, flags);
  } catch (err) {
    process.stderr.write(`Error: ${errMsg(err)}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  } finally {
    await client.close().catch(() => {});
  }
}

// A reader that stops early (`| head`) closes the pipe; that ends the pipeline
// stage, not the CLI with a stack trace. The server exits on its stdin closing.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main();
