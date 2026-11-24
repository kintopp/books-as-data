// Offline unit tests for the shared token-frugality pruner (src/lib/prune.js).
// Pins the invariant stated in the file header: drop '', null, undefined, [], {}
// recursively — while NEVER touching `false`/`0`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prune } from '../src/lib/prune.js';

test('prune drops empty scalars but keeps false and 0', () => {
  assert.equal(prune(''), undefined);
  assert.equal(prune(null), undefined);
  assert.equal(prune(undefined), undefined);
  // The documented non-negotiable: falsy-but-meaningful values survive.
  assert.equal(prune(false), false);
  assert.equal(prune(0), 0);
  assert.equal(prune('x'), 'x');
});

test('prune drops empty arrays/objects and keeps populated ones', () => {
  assert.equal(prune([]), undefined);
  assert.equal(prune({}), undefined);
  assert.deepEqual(prune(['a']), ['a']);
  assert.deepEqual(prune({ a: 1 }), { a: 1 });
});

test('prune filters empty members out of arrays', () => {
  assert.deepEqual(prune(['', 'x', null, 0]), ['x', 0]);
  assert.equal(prune(['', null, undefined]), undefined, 'an array of only-empties collapses');
});

test('prune drops empty-valued keys from an object, keeping false/0', () => {
  assert.deepEqual(
    prune({ a: '', b: 'keep', c: null, d: false, e: 0, f: [] }),
    { b: 'keep', d: false, e: 0 },
  );
});

test('prune collapses recursively — an object whose descendants are all empty becomes undefined', () => {
  assert.equal(prune({ a: { b: '' }, c: [null, {}] }), undefined);
  assert.deepEqual(
    prune({ outer: { keep: 'v', drop: '' }, empty: {} }),
    { outer: { keep: 'v' } },
  );
});

// Boundary documentation (not a code change): prune treats ANY non-array object
// as a key/value bag. A class instance with no own enumerable keys therefore
// prunes to undefined. No shaper passes such a value today; this test records
// the edge so a future caller who does isn't surprised.
test('prune treats a keyless object instance as empty (documented boundary)', () => {
  class Empty {}
  assert.equal(prune(new Empty()), undefined);
});
