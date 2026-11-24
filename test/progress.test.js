// notifications/progress for the page-scanning tools. No known host sends a
// progressToken yet, so only the wire tests here would notice the SDK routing
// (ctx.mcpReq.notify + _meta.progressToken) breaking — on either era.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { progressReporter } from '../src/lib/progress.js';
import { registerLocateTextTool } from '../src/tools/locate_text.js';
import { PROGRESS_MIN_INTERVAL_MS } from '../src/config.js';
import { captureHandler, withClient, withModernServer } from './helpers.js';
import { makeRouter, installFetchStub, startStubServer } from './stub-backend.js';

const PAGES = 12;
const ocr = {};
for (let p = 1; p <= PAGES; p++) ocr[`text:${p}`] = p % 4 ? `Seite ${p}` : `Seite ${p} in Basel`;

const LOCATE_ARGS = { phrase: 'in Basel', engine: 'page_scan', start_page: 1, max_pages: 40, max_hits: 50, level: 'line' };

function fakeCtx(token) {
  const sent = [];
  const ctx = { mcpReq: { notify: async (n) => { sent.push(n); } } };
  if (token != null) ctx.mcpReq._meta = { progressToken: token };
  return { ctx, sent };
}

// ── reporter contract ────────────────────────────────────────────────────────

test('progressReporter: without a progressToken nothing is ever sent', () => {
  const { ctx, sent } = fakeCtx(null);
  const report = progressReporter(ctx);
  report(1, 10, 'x');
  assert.equal(sent.length, 0);
  assert.doesNotThrow(() => progressReporter(undefined)(1));
});

test('progressReporter: carries the token, throttles, and only ever increases', () => {
  const { ctx, sent } = fakeCtx(7);
  let clock = 0;
  const report = progressReporter(ctx, { now: () => clock });
  report(1, 10, 'one');   // first call always goes out
  clock = PROGRESS_MIN_INTERVAL_MS / 2;
  report(2, 10, 'two');   // inside the interval — dropped
  clock = PROGRESS_MIN_INTERVAL_MS * 2;
  report(1, 10, 'back');  // interval passed but not increasing — dropped
  report(3);              // increasing, no total/message
  assert.deepEqual(sent, [
    { method: 'notifications/progress', params: { progressToken: 7, progress: 1, total: 10, message: 'one' } },
    { method: 'notifications/progress', params: { progressToken: 7, progress: 3 } },
  ]);
});

test('progressReporter: the completing report is never throttled away', () => {
  const { ctx, sent } = fakeCtx(7);
  let clock = 0;
  const report = progressReporter(ctx, { now: () => clock });
  report(1, 10);
  clock = 1;
  report(10, 10);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].params.progress, 10);
  assert.equal(sent[1].params.total, 10);
});

test('progressReporter: a failing transport never surfaces into the tool call', async () => {
  const report = progressReporter({
    mcpReq: { _meta: { progressToken: 't' }, notify: () => Promise.reject(new Error('closed')) },
  });
  assert.doesNotThrow(() => report(1));
  await new Promise((r) => setImmediate(r)); // an unhandled rejection would fail the run here
});

// ── handler seam ─────────────────────────────────────────────────────────────

test('locate_text page scan: reports pages scanned against max_pages, and still returns its result', async () => {
  const stub = installFetchStub(makeRouter({ ocr }));
  try {
    const { ctx, sent } = fakeCtx('loc');
    const res = await captureHandler(registerLocateTextTool)({ ...LOCATE_ARGS, scan_id: 'PROGRESS-0001' }, ctx);
    assert.ok(!res.isError, res.content?.[0]?.text);
    assert.equal(res.structuredContent.hits.length, PAGES / 4);
    assert.ok(sent.length >= 1, 'at least the first settled page is reported');
    const { params } = sent[0];
    assert.equal(params.progressToken, 'loc');
    assert.equal(params.total, LOCATE_ARGS.max_pages);
    assert.match(params.message, /^Scanned \d+ of up to 40 pages, \d+ matching$/);
  } finally {
    stub.restore();
  }
});

// ── wire, both eras ──────────────────────────────────────────────────────────

let backend;
before(async () => { backend = await startStubServer(makeRouter({ ocr })); });
after(async () => { await backend?.close(); });

const wireArgs = (scanId) => ({ name: 'sgbr_locate_text', arguments: { ...LOCATE_ARGS, scan_id: scanId } });

function assertScanProgress(notes) {
  assert.ok(notes.length >= 1, 'no progress notification reached the client');
  assert.equal(notes[0].total, LOCATE_ARGS.max_pages);
  assert.match(notes[0].message, /^Scanned \d+ of up to 40 pages/);
}

test('wire (2025 era): a client passing onprogress receives the scan\'s progress', async () => {
  await withClient('ub-sgbr-progress', async (client) => {
    const seen = [];
    const res = await client.callTool(wireArgs('PROGRESS-0002'), { onprogress: (p) => seen.push(p) });
    assert.ok(!res.isError, res.content?.[0]?.text);
    assertScanProgress(seen);
  }, { env: backend.env });
});

test('wire (2026-07-28 era): progress is delivered for a per-request-envelope call', async () => {
  const notes = [];
  await withModernServer(async (call) => {
    const res = await call('tools/call', wireArgs('PROGRESS-0003'), { progressToken: 'modern' });
    assert.ok(!res.isError, JSON.stringify(res.content));
  }, {
    env: backend.env,
    onNotification: (msg) => { if (msg.method === 'notifications/progress') notes.push(msg.params); },
  });
  assertScanProgress(notes);
  assert.equal(notes[0].progressToken, 'modern');
});
