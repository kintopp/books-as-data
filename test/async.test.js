// Direct tests for the async helpers (src/lib/async.js) — above all the
// abortableSleep cleanup contract: a retry-heavy request reuses ONE caller
// signal for every backoff sleep, so each settled sleep must fully detach from
// the signal or listeners accumulate for the signal's lifetime (and can trip
// Node's MaxListenersExceededWarning under a retry storm).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { abortableSleep, mapPool } from '../src/lib/async.js';

test('a completed sleep leaves no abort listener on the signal', async () => {
  const ac = new AbortController();
  // Well past the ~10-listener warning threshold, mirroring a retry storm.
  for (let i = 0; i < 12; i++) await abortableSleep(1, ac.signal);
  assert.equal(
    getEventListeners(ac.signal, 'abort').length, 0,
    'normal completion must remove its abort listener, not leave it to accumulate',
  );
});

test('an aborted sleep rejects with an AbortError and detaches from the signal', async () => {
  const ac = new AbortController();
  const p = abortableSleep(60000, ac.signal); // long timer: a leak would stall the runner
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
});

test('an already-aborted signal rejects before any timer is scheduled', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(abortableSleep(60000, ac.signal), { name: 'AbortError' });
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
});

test('a signal-less sleep resolves normally', async () => {
  await abortableSleep(1); // must not throw on the no-signal fast path
});

test('mapPool keeps input order and never exceeds its limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapPool([30, 5, 20, 1, 10], 2, async (ms) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return ms * 2;
  });
  assert.deepEqual(out, [60, 10, 40, 2, 20]);
  assert.equal(peak, 2);
});

test('mapPool stops launching after a rejection', async () => {
  const seen = [];
  await assert.rejects(mapPool([1, 2, 3, 4], 1, async (n) => {
    seen.push(n);
    if (n === 2) throw new Error('boom');
  }), /boom/);
  assert.deepEqual(seen, [1, 2]);
});
