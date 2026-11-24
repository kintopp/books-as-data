// Shared wrapper for every tool handler — the one place that owns the two
// cross-cutting concerns every tool shares: the try/catch → isError error shape
// and a gated per-call debug line. Threads the handler's call args — including
// ctx.mcpReq.signal for abort propagation — through unchanged.
//
// Logging is OFF by default; set SGBR_LOG=1 for one JSON line per call on stderr:
// { tool, ms, ok, error?, input?, progress_token?, output_bytes, structured_bytes }.
// The hosted line drops error and input for { level, error_type?, status? }.
// `progress_token: true` shows which hosts ask for progress. A local debug
// aid, NOT a shared analyser contract — the shape matches the sibling servers only
// so the same jq filters work. The env is read at call time (like the auth seam),
// so a host or test can toggle it without reimport, and nothing is serialized
// unless it is '1'.
//
// stdout is reserved for JSON-RPC; all logging goes to stderr (console.error).
//
// The error path returns ONLY { content, isError } — never structuredContent: a
// bare error object fails SDK validation against a tool's outputSchema (-32602).

import { performance } from 'node:perf_hooks';
import { formatErrorText } from './errors.js';
import { progressTokenOf } from './progress.js';

const LOG_ENV = 'SGBR_LOG';

// The HTTP entry logs every call, with a level (Railway files a line without one
// as an error), and never the input or an error message, which can quote it:
// queries are user content. Switched on by the entry itself, never by an env var
// a deployment could change.
let hostedLog = false;
export const useHostedLog = () => { hostedLog = true; };
// Cap the logged input so one oversized query (up to MAX_QUERY_LEN) can't bloat a
// debug line; the full value still reaches the backend.
const INPUT_LOG_MAX = 300;

function summariseInput(args) {
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return undefined;
  const s = JSON.stringify(args);
  return s.length > INPUT_LOG_MAX ? `${s.slice(0, INPUT_LOG_MAX)}…` : s;
}

// UTF-8 byte length of the result's human-readable text content (all
// `content[].text` entries concatenated), for the SGBR_LOG size-visibility line.
function byteLengthOfText(result) {
  const content = result?.content;
  if (!Array.isArray(content) || !content.length) return 0;
  const text = content.filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text).join('');
  return Buffer.byteLength(text, 'utf8');
}

// UTF-8 byte length of the JSON-serialised structuredContent, or 0 when absent.
function byteLengthOfStructured(result) {
  if (!result || !('structuredContent' in result) || result.structuredContent === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8');
}

// Wrap a tool handler. `name` is the tool name (logged); `label` is the human-facing
// prefix for an error result (e.g. "Search failed"). One exit point, logged once.
export function withTool(name, label, handler) {
  return async (...callArgs) => {
    const start = performance.now();
    let result;
    let thrown;
    try {
      result = await handler(...callArgs);
    } catch (err) {
      thrown = err;
      result = { content: [{ type: 'text', text: `${label}: ${formatErrorText(err)}` }], isError: true };
    }
    // Build and emit the line only when logging is on — no serialization otherwise.
    if (hostedLog || process.env[LOG_ENV] === '1') {
      const line = {
        tool: name,
        ms: Math.round(performance.now() - start),
        ok: !result?.isError,
        ...(progressTokenOf(callArgs[1]) != null && { progress_token: true }),
        output_bytes: byteLengthOfText(result),
        structured_bytes: byteLengthOfStructured(result),
      };
      console.error(JSON.stringify(hostedLog
        ? { level: line.ok ? 'info' : 'warn', ...line, ...errorCause(thrown) }
        : { ...line, ...debugDetail(thrown, callArgs[0]) }));
    }
    return result;
  };
}

// What a hosted line may say about a failure: the error's class and HTTP status, which
// no input can reach. Its message can quote the input.
function errorCause(err) {
  if (err === undefined) return {};
  const type = /^\w{1,40}$/.test(err?.name ?? '') ? err.name : 'unknown';
  return { error_type: type, ...(Number.isInteger(err?.status) && { status: err.status }) };
}

function debugDetail(err, args) {
  const input = summariseInput(args);
  return { ...(err !== undefined && { error: formatErrorText(err) }), ...(input && { input }) };
}
