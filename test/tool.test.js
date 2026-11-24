// Offline unit tests for the shared tool-handler wrapper (src/lib/tool.js): the
// try/catch → isError error shape and the gated per-call stderr log line. No
// network. Toggles SGBR_LOG and captures console.error manually (the withEnv
// helper is sync-only, so it can't span an awaited call).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTool } from '../src/lib/tool.js';
import { ToolError } from '../src/lib/errors.js';
import { setEnv } from './helpers.js';

// Run fn() with SGBR_LOG forced to `logVal` (undefined = unset) and console.error
// captured; restore both afterwards. Async-aware — awaits fn before restoring.
async function capture(logVal, fn) {
  const restore = setEnv('SGBR_LOG', logVal);
  const savedErr = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = savedErr;
    restore();
  }
}

const ok = async () => ({ content: [{ type: 'text', text: 'hi' }], structuredContent: { a: 1 } });

test('withTool passes a success result through unchanged', async () => {
  const { result } = await capture(undefined, () => withTool('t', 'T failed', ok)({ q: 'x' }));
  assert.deepEqual(result, { content: [{ type: 'text', text: 'hi' }], structuredContent: { a: 1 } });
});

test('withTool formats a thrown ToolError with the label, and never carries structuredContent', async () => {
  const handler = async () => { throw new ToolError('bad input', 'do better'); };
  const { result } = await capture(undefined, () => withTool('t', 'Search failed', handler)({}));
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Search failed: bad input — do better');
  assert.equal('structuredContent' in result, false, 'error path must not carry structuredContent (−32602)');
});

test('withTool logs one JSON line per call only when SGBR_LOG=1', async () => {
  const off = await capture(undefined, () => withTool('sgbr_x', 'X failed', ok)({ q: 'x' }));
  assert.equal(off.lines.length, 0, 'no log when SGBR_LOG is unset');

  const on = await capture('1', () => withTool('sgbr_x', 'X failed', ok)({ q: 'x' }));
  assert.equal(on.lines.length, 1, 'exactly one line when SGBR_LOG=1');
  const line = JSON.parse(on.lines[0]);
  assert.equal(line.tool, 'sgbr_x');
  assert.equal(line.ok, true);
  assert.ok(Number.isInteger(line.ms) && line.ms >= 0, 'ms is a non-negative integer');
  assert.equal(line.input, JSON.stringify({ q: 'x' }));
  assert.equal(line.output_bytes, Buffer.byteLength('hi', 'utf8'), 'output_bytes = utf8 byte length of content text');
  assert.equal(
    line.structured_bytes,
    Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf8'),
    'structured_bytes = utf8 byte length of serialised structuredContent',
  );
});

test('withTool logs structured_bytes: 0 when structuredContent is absent', async () => {
  const handler = async () => ({ content: [{ type: 'text', text: 'no structured here' }] });
  const { lines } = await capture('1', () => withTool('sgbr_x', 'X failed', handler)({}));
  const line = JSON.parse(lines[0]);
  assert.equal(line.structured_bytes, 0);
  assert.equal(line.output_bytes, Buffer.byteLength('no structured here', 'utf8'));
});

test('withTool logs output_bytes using UTF-8 byte length, not JS string length, for multi-byte text', async () => {
  const multiByte = 'schön café ü'; // multi-byte UTF-8 chars
  const handler = async () => ({ content: [{ type: 'text', text: multiByte }] });
  const { lines } = await capture('1', () => withTool('sgbr_x', 'X failed', handler)({}));
  const line = JSON.parse(lines[0]);
  assert.equal(line.output_bytes, Buffer.byteLength(multiByte, 'utf8'));
  assert.ok(line.output_bytes > multiByte.length, 'multi-byte text has more bytes than JS chars');
});

test('withTool logs ok:false + error for a thrown handler', async () => {
  const handler = async () => { throw new ToolError('nope'); };
  const { lines } = await capture('1', () => withTool('sgbr_x', 'X failed', handler)({ id: 'z' }));
  const line = JSON.parse(lines[0]);
  assert.equal(line.ok, false);
  assert.equal(line.error, 'nope');
});

test('withTool logs ok:false when the handler returns an isError result without throwing', async () => {
  const handler = async () => ({ content: [{ type: 'text', text: 'x' }], isError: true });
  const { result, lines } = await capture('1', () => withTool('sgbr_x', 'X failed', handler)({}));
  assert.equal(result.isError, true, 'the result is passed through unchanged');
  assert.equal(JSON.parse(lines[0]).ok, false, 'and logged as not-ok');
});

test('withTool threads all call args (args, ctx) through to the handler', async () => {
  let seen;
  const handler = async (args, ctx) => { seen = { args, ctx }; return { content: [] }; };
  const ctx = { mcpReq: { signal: 'SIG' } };
  await capture(undefined, () => withTool('t', 'T failed', handler)({ q: 'x' }, ctx));
  assert.deepEqual(seen.args, { q: 'x' });
  assert.equal(seen.ctx.mcpReq.signal, 'SIG', 'abort signal must reach the handler unchanged');
});

test('withTool caps a long input in the log line', async () => {
  const longQuery = 'x'.repeat(1000);
  const { lines } = await capture('1', () => withTool('t', 'T failed', ok)({ query: longQuery }));
  const line = JSON.parse(lines[0]);
  assert.ok(line.input.length <= 301, 'input capped to 300 chars + a 1-char ellipsis');
  assert.ok(line.input.endsWith('…'), 'capped input ends with an ellipsis');
});

test('withTool omits input from the log when args are empty', async () => {
  const { lines } = await capture('1', () => withTool('t', 'T failed', ok)({}));
  assert.equal('input' in JSON.parse(lines[0]), false, 'empty args → no input field');
});

test('withTool marks progress_token only when the client asked for progress', async () => {
  const run = (ctx) => capture('1', () => withTool('t', 'T failed', ok)({ q: 1 }, ctx));
  const asked = JSON.parse((await run({ mcpReq: { _meta: { progressToken: 0 } } })).lines[0]);
  assert.equal(asked.progress_token, true, 'a token of 0 is still a token');
  const silent = JSON.parse((await run({ mcpReq: { _meta: {} } })).lines[0]);
  assert.equal('progress_token' in silent, false);
});

test('a hosted line names a failure by its class and status, never by its message or the input', async () => {
  // A fresh module instance, so switching it to hosted logging leaves the shared one alone.
  const hosted = await import('../src/lib/tool.js?hosted');
  hosted.useHostedLog();
  const backendDown = async () => { throw Object.assign(new Error('upstream said markerquery'), { name: 'OcrError', status: 503 }); };
  const refused = async () => { throw new ToolError('no record markerid', 'check markerid'); };
  const odd = async () => { throw Object.assign(new Error('x'), { name: 'name with markerquery', status: '503' }); };
  const { lines } = await capture(undefined, async () => {
    await hosted.withTool('sgbr_x', 'X failed', backendDown)({ q: 'markerquery' });
    await hosted.withTool('sgbr_x', 'X failed', refused)({ id: 'markerid' });
    await hosted.withTool('sgbr_x', 'X failed', odd)({});
    await hosted.withTool('sgbr_x', 'X failed', ok)({ q: 'markerquery' });
  });
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepEqual(parsed.map((l) => [l.level, l.ok, l.error_type, l.status]), [
    ['warn', false, 'OcrError', 503],
    ['warn', false, 'ToolError', undefined],
    ['warn', false, 'unknown', undefined],
    ['info', true, undefined, undefined],
  ]);
  assert.doesNotMatch(lines.join('\n'), /marker|upstream said/);
});
