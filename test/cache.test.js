// Direct unit tests for the LRU+TTL async cache — eviction order, expiry,
// in-flight de-duplication, and (crucially) that de-dup does NOT couple
// concurrent callers' abort lifetimes: one caller cancelling must never fail
// another, and the underlying load is torn down only when nobody wants it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncCache } from '../src/lib/cache.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('evicts the least-recently-used entry beyond max', () => {
  const cache = createAsyncCache({ max: 2, ttlMs: 60000 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // touch a → b is now the oldest
  cache.set('c', 3); // evicts b
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('entries expire after ttlMs', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 10 });
  cache.set('k', 'v');
  assert.equal(cache.get('k'), 'v');
  await tick(25);
  assert.equal(cache.get('k'), undefined);
});

test('fetchCached reloads after expiry', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 10 });
  let calls = 0;
  const loader = async () => { calls += 1; return `v${calls}`; };
  assert.equal(await cache.fetchCached('k', loader), 'v1');
  assert.equal(await cache.fetchCached('k', loader), 'v1'); // still cached
  await tick(25);
  assert.equal(await cache.fetchCached('k', loader), 'v2'); // expired → reload
  assert.equal(calls, 2);
});

test('concurrent misses share one loader call', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 60000 });
  let calls = 0;
  const loader = async () => { calls += 1; await tick(10); return 'v'; };
  const [a, b] = await Promise.all([
    cache.fetchCached('k', loader),
    cache.fetchCached('k', loader),
  ]);
  assert.equal(a, 'v');
  assert.equal(b, 'v');
  assert.equal(calls, 1);
});

test('a failed load is not cached; the next call retries', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 60000 });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return 'v';
  };
  await assert.rejects(cache.fetchCached('k', loader), /boom/);
  assert.equal(await cache.fetchCached('k', loader), 'v');
  assert.equal(calls, 2);
});

test('one caller aborting does not fail the other waiter', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 60000 });
  let loaderSignal;
  const loader = async (signal) => { loaderSignal = signal; await tick(30); return 'v'; };
  const a = new AbortController();
  const b = new AbortController();
  const pa = cache.fetchCached('k', loader, { signal: a.signal });
  const pb = cache.fetchCached('k', loader, { signal: b.signal });
  a.abort();
  await assert.rejects(pa, { name: 'AbortError' });
  assert.equal(await pb, 'v', 'the surviving caller still gets the value');
  assert.equal(loaderSignal.aborted, false, 'the load must stay alive while a waiter remains');
});

test('the underlying load is aborted only when every waiter has aborted', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 60000 });
  let loaderSignal;
  const loader = (signal) => new Promise((_resolve, reject) => {
    loaderSignal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const a = new AbortController();
  const b = new AbortController();
  const pa = cache.fetchCached('k', loader, { signal: a.signal });
  const pb = cache.fetchCached('k', loader, { signal: b.signal });
  a.abort();
  await assert.rejects(pa, { name: 'AbortError' });
  assert.equal(loaderSignal.aborted, false);
  b.abort();
  await assert.rejects(pb, { name: 'AbortError' });
  assert.equal(loaderSignal.aborted, true, 'all waiters gone → the load is torn down');
});

test('a signal-less caller pins the load alive when others abort', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 60000 });
  let loaderSignal;
  const loader = async (signal) => { loaderSignal = signal; await tick(20); return 'v'; };
  const b = new AbortController();
  const pa = cache.fetchCached('k', loader); // no signal → can never abort
  const pb = cache.fetchCached('k', loader, { signal: b.signal });
  b.abort();
  await assert.rejects(pb, { name: 'AbortError' });
  assert.equal(await pa, 'v');
  assert.equal(loaderSignal.aborted, false);
});

// ── Retirement semantics. The entry is removed from the inflight map synchronously
// when its last waiter aborts (and on clear()), while the doomed loader settles in
// the background — so these three pin the race an async-only cleanup would lose: a
// same-key caller in the abort-to-settle gap must get a fresh load, and the retired
// loader's late completion must neither delete nor overwrite whatever replaced it.

test('a new caller after the last waiter aborted gets a fresh load, not the aborted promise', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 60000 });
  let calls = 0;
  const loader = (signal) => new Promise((resolve, reject) => {
    calls += 1;
    const value = `v${calls}`;
    const t = setTimeout(() => resolve(value), 20);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
  const a = new AbortController();
  const pa = cache.fetchCached('k', loader, { signal: a.signal });
  pa.catch(() => {});
  a.abort(); // the only waiter detaches → the shared load is torn down
  // Same tick — before the aborted loader's finally can delete the entry:
  const fresh = cache.fetchCached('k', loader);
  await assert.rejects(pa, { name: 'AbortError' });
  assert.equal(await fresh, 'v2', 'the new caller must trigger a fresh load, not inherit the aborted one');
  assert.equal(calls, 2);
});

test('a stale loader settling late neither deletes nor overwrites its replacement', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 60000 });
  let calls = 0;
  const loader = (signal) => new Promise((resolve, reject) => {
    calls += 1;
    const value = `v${calls}`;
    if (calls === 1) {
      // Slow teardown: ignore the abort and still RESOLVE late — the worst case,
      // because an unguarded `set()` would overwrite the replacement's value.
      setTimeout(() => resolve(value), 40);
    } else {
      const t = setTimeout(() => resolve(value), 5);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
    }
  });
  const a = new AbortController();
  const pa = cache.fetchCached('k', loader, { signal: a.signal });
  pa.catch(() => {});
  a.abort();
  const fresh = cache.fetchCached('k', loader); // replacement load (v2)
  assert.equal(await fresh, 'v2');
  await tick(50); // let the stale v1 loader settle after the replacement is cached
  assert.equal(await cache.fetchCached('k', loader), 'v2', 'the stale load must not clobber the cached replacement');
  assert.equal(calls, 2, 'no third load: the replacement value must still be cached');
});

test('clear() during an in-flight load prevents stale repopulation', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 60000 });
  let calls = 0;
  const loader = async () => { calls += 1; await tick(20); return `v${calls}`; };
  const p = cache.fetchCached('k', loader);
  cache.clear(); // reset while the load is mid-flight (the test-seam usage)
  assert.equal(await p, 'v1', 'the in-flight caller still gets its value');
  assert.equal(cache.get('k'), undefined, 'a cleared cache must not be repopulated by the pre-clear load');
  assert.equal(await cache.fetchCached('k', loader), 'v2', 'the next fetch observes a fresh loader call');
});

test('an already-aborted caller never reaches the loader', async () => {
  const cache = createAsyncCache({ max: 4, ttlMs: 60000 });
  let calls = 0;
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    cache.fetchCached('k', async () => { calls += 1; return 'v'; }, { signal: c.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
});

test('a loader resolving to undefined does not take a cache slot', async () => {
  const cache = createAsyncCache({ max: 2, ttlMs: 60000 });
  await cache.fetchCached('a', async () => 'A');
  await cache.fetchCached('b', async () => 'B');
  assert.equal(await cache.fetchCached('u', async () => undefined), undefined);
  assert.equal(cache.get('a'), 'A');
});
