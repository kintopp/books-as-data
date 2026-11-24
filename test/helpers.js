// Shared test utilities.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { graphqlRequest } from '../src/graphql/client.js';
import { SEARCH_QUERY } from '../src/graphql/operations.js';
import { buildSearchVariables } from '../src/search/compiler.js';

// The ONE live-suite gate. Every live test must spell it `{ skip: !LIVE }` (or
// the equivalent `process.env.SGBR_LIVE !== '1'`) — exact equality, never
// truthiness. `skip: !process.env.SGBR_LIVE` reads as the same thing but RUNS
// the live suite for any non-empty value, including the `SGBR_LIVE=0` someone
// would set to turn it off. Two files had exactly that bug.
export const LIVE = process.env.SGBR_LIVE === '1';

// Backend fixtures for the live (SGBR_LIVE=1) tests — a single source of truth
// shared by smoke.test.js and cli.test.js so the two suites can't drift if the
// backend data changes.
//
// Record ids are NOT portable across backend releases: the 2026-08-10 index
// rebuilt them from `id{almaId}_{opaqueToken}` to `id{almaId}_{scanId}`, and an
// id from the old index resolves to HTTP 200 with an empty result rather than an
// error. Re-derive these from a live search after any backend move — do not
// assume a failing fixture means a broken tool.
export const KNOWN_ID = 'id991104550959705501_UBBS-00173645'; // 1882 Basel book, has full text + citation
export const KNOWN_SCAN = 'UBBS-00173645';                     // scan of the KNOWN_ID book, has plain OCR text

// Per-page OCR fixture: a scan with known hOCR + plain-text sidecars, and a
// phrase that appears on a known page — shared by smoke.test.js, ocr.test.js
// and locate.test.js so the three suites can't drift if the stage data changes.
export const KNOWN_OCR_SCAN = 'ZBZ-00057370';
export const KNOWN_OCR_PAGE = 5;
export const KNOWN_OCR_PHRASE = 'Beschäftigungen';

// Fold-out plate fixture. The one record shape no offline stub can be trusted to
// model, because its shape is exactly what moved: before 2026-08-10 a plate had no
// `sgbrScannedDigIds`, and the relaunched index fills it with the PARENT volume's
// scan. Most offline foldout tests still model a scan-less plate (only
// resolve.test.js stubs the parent-scan shape, at the resolver), so this live pair
// is what proves the plate path end to end.
export const KNOWN_FOLDOUT_ID = 'ZBZ-00138157_00000165'; // plate 165 of an 1854 geology thesis
export const KNOWN_FOLDOUT_SCAN = 'ZBZ-00138157';        // its PARENT volume's scan
export const KNOWN_FOLDOUT_PAGE = 165;

// Set (or, when value === undefined, clear) an env var and return a function that
// restores its previous value. The primitive behind scoped env overrides — used by
// the sync withEnv below and by async callers that must span an awaited call (e.g.
// capture() in tool.test.js), which withEnv's sync try/finally can't wrap.
export function setEnv(name, value) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  };
}

// Set an env var for the duration of run(), then restore the previous value. Keeps
// env-dependent tests isolated regardless of what run() throws. Sync-only — for an
// awaited body, use setEnv directly (see the note above).
export function withEnv(name, value, run) {
  const restore = setEnv(name, value);
  try {
    return run();
  } finally {
    restore();
  }
}

// Register a tool against a stand-in McpServer and hand back just its
// withTool-wrapped handler, so a test can drive the tool in-process without a
// transport. Every tool module exports exactly one register<Tool>() taking
// { registerTool }, which is what makes one helper enough for all nine.
//
// Direct invocation BYPASSES the zod layer, so a caller's args must carry every
// field the handler reads — no schema defaults are applied.
export function captureHandler(register) {
  let handler = null;
  register({ registerTool: (_name, _cfg, h) => { handler = h; } });
  return handler;
}

// Validate structuredContent the way a client does: against the tool's advertised
// JSON Schema, where an undeclared key is an additionalProperties violation that
// fails the call. zod's .parse() strips such keys instead, so a parse-based check
// passes a shaper field its outputSchema forgot to declare. Returns the object
// unchanged, so it drops in wherever a test read the result of .parse().
const wireValidator = new AjvJsonSchemaValidator();
export function assertWireValid(outputSchema, structured) {
  const jsonSchema = outputSchema['~standard'].jsonSchema.output({ target: 'draft-2020-12' });
  const { valid, errorMessage } = wireValidator.getValidator(jsonSchema)(structured);
  assert.ok(valid, errorMessage);
  return structured;
}

// ── live probes below the tool layer ─────────────────────────────────────────

/**
 * Record count for a compiled search, live. Bypasses the tool layer on purpose
 * so the live contract files can probe forms the tools refuse or rewrite:
 * `rawQuery` replaces the compiled (trimmed) query verbatim, `extraFilter`
 * appends one backend clause the compiler cannot express. `pageSize: 0` — the
 * count needs no hit documents (sgbr_facet_values counts the same way).
 */
export async function liveSearchCount(args, { rawQuery, extraFilter } = {}) {
  const vars = buildSearchVariables({ ...args, pageSize: 0 });
  if (rawQuery !== undefined) vars.query = rawQuery;
  if (extraFilter) vars.filters.push(extraFilter);
  const data = await graphqlRequest(SEARCH_QUERY, vars);
  return data.search.countResult?.resultCount ?? data.search.totalCount;
}

// ── driving the real server as a child process ───────────────────────────────

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'scripts', 'cli.mjs');
export const SERVER_ENTRY = join(ROOT, 'src', 'index.js');

// `env` is merged over process.env for the child — how a test points the server
// at a stub backend (stub-backend.js#startStubServer).
const serverParams = (env) => ({
  command: process.execPath,
  args: [SERVER_ENTRY],
  ...(env && { env: { ...process.env, ...env } }),
});

/**
 * Spawn the real server over stdio, hand `run` a connected client, and close it
 * on every path. `name` only labels the client in the handshake.
 *
 * Note this connects through `initialize`, which pins the connection to the
 * 2025 era: the installed client SDK's LATEST_PROTOCOL_VERSION is 2025-11-25.
 * A test that needs the 2026 wire uses withModernServer below.
 */
export async function withClient(name, run, { env } = {}) {
  const transport = new StdioClientTransport(serverParams(env));
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

export const MODERN_VERSION = '2026-07-28';
// The reserved envelope keys a 2026-era request carries in `_meta`. Spelled out
// rather than imported from the SDK: the tests using it assert the WIRE, and
// importing the constants would let a rename pass unnoticed on both sides.
export const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'ub-sgbr-test', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/**
 * A 2026-era caller: the SDK's stdio transport (spawn, framing, lifecycle) with
 * hand-built messages on top, so the envelope reaches the server verbatim.
 * `run` gets `call(method, params?, meta?)`, where `meta` joins the envelope in
 * `_meta`; server notifications go to `onNotification`.
 */
export async function withModernServer(run, { env, onNotification } = {}) {
  const transport = new StdioClientTransport(serverParams(env));
  const pending = new Map();
  let nextId = 0;

  transport.onmessage = (msg) => {
    if (msg.id === undefined) { onNotification?.(msg); return; }
    const settle = pending.get(msg.id);
    if (settle) { pending.delete(msg.id); settle(msg); }
  };
  await transport.start();

  const call = (method, params = {}, meta = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (msg) => (msg.error
      ? reject(new Error(`${method}: ${msg.error.message}`))
      : resolve(msg.result)));
    transport.send({ jsonrpc: '2.0', id, method, params: { ...params, _meta: { ...ENVELOPE, ...meta } } });
  });

  try {
    return await run(call);
  } finally {
    await transport.close();
  }
}

/**
 * Run the CLI; resolve with {code, killed, signal, stdout, stderr}. Never rejects,
 * so a test asserts on the exit code rather than catching. `env` is merged over
 * process.env — that is how cli_render.test.js points the SPAWNED SERVER at a stub
 * backend (cli.mjs forwards its whole environment to the child it spawns).
 */
export function runCli(args, { stdin, timeout = 60000, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath, [CLI, ...args],
      { cwd: ROOT, timeout, maxBuffer: 32 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) => {
        // A timeout/signal kill leaves err.code null (only err.killed/err.signal are
        // set), so `err?.code ?? 0` would mislabel a killed run as a clean exit 0.
        // Synthesize a nonzero code (124, the conventional timeout code) in that case.
        const killed = !!err?.killed || !!err?.signal;
        const code = err?.code ?? (killed ? 124 : 0);
        resolve({ code, killed, signal: err?.signal ?? null, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    if (stdin !== undefined) { child.stdin.write(stdin); child.stdin.end(); }
  });
}

/** Parse the CLI's stdout as JSONL — the pipeable-output contract both CLI suites assert. */
export const jsonlRows = (s) => s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
