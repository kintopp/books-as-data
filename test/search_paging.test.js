// Offline boundary tests for sgbr_search's deep-paging guard
// (src/tools/search.js#assertPageWindow).
//
// The guard exists so a too-deep page produces actionable text instead of the
// backend's opaque error. Elasticsearch rejects on `from + size >
// max_result_window`, so a guard on the START offset ((page-1) × page_size) would
// admit requests with `from` just under the window and `from + size` just over it.
//
// That arithmetic is easy to get wrong, so the boundary is pinned from BOTH sides,
// and specifically at page_sizes that do NOT divide MAX_RESULT_WINDOW evenly: every
// "obvious" size (10/20/25/50) divides 10000 exactly, which is precisely why the gap
// went unnoticed. Pure + offline — the guard throws before any upstream call, so no
// network or stage host is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPageWindow } from '../src/tools/search.js';
import { MAX_RESULT_WINDOW, MAX_PAGE_SIZE } from '../src/config.js';

const at = (page, page_size) => () => assertPageWindow({ page, page_size });

test('assertPageWindow allows a window ending exactly on MAX_RESULT_WINDOW', () => {
  // page × size == the window: the last result index is reachable, so this is
  // the deepest legal page and must NOT be rejected (an off-by-one here would
  // cost callers a whole page of legitimately reachable results).
  assert.doesNotThrow(at(1000, 10));
  assert.doesNotThrow(at(200, 50));
  assert.doesNotThrow(at(400, 25));
  assert.doesNotThrow(at(MAX_RESULT_WINDOW, 1));
});

test('assertPageWindow rejects the first page past MAX_RESULT_WINDOW', () => {
  for (const [page, size] of [[1001, 10], [201, 50], [401, 25], [MAX_RESULT_WINDOW + 1, 1]]) {
    assert.throws(at(page, size), /too deep/, `page ${page} × ${size} must be rejected`);
  }
});

// The trap case: `from` under the window, `from + size` over it. Only reachable when
// page_size does not divide MAX_RESULT_WINDOW — a start-offset guard would admit
// every one of these.
test('assertPageWindow rejects a window that STARTS inside but ENDS past the result window', () => {
  for (const [page, size] of [[334, 30], [3334, 3], [1429, 7], [770, 13]]) {
    const from = (page - 1) * size;
    assert.ok(from < MAX_RESULT_WINDOW, `fixture invalid: from ${from} should be inside the window`);
    assert.ok(page * size > MAX_RESULT_WINDOW, `fixture invalid: page ${page} × ${size} should overrun`);
    assert.throws(at(page, size), /too deep/,
      `page ${page} × size ${size} (from ${from}, last index ${page * size}) must be rejected`);
  }
});

test('assertPageWindow error text names the arithmetic and an actionable next step', () => {
  assert.throws(at(334, 30), (err) => {
    assert.match(err.message, /page 334 × size 30 = 10020 results/, 'states the computed overrun');
    assert.match(err.message, new RegExp(`${MAX_RESULT_WINDOW}-result window`), 'names the limit');
    assert.match(err.suggestion, /Narrow the query|smaller page number/, 'offers a recovery');
    return true;
  });
});

test('assertPageWindow allows ordinary shallow paging at every legal page size', () => {
  for (let size = 1; size <= MAX_PAGE_SIZE; size++) {
    assert.doesNotThrow(at(1, size), `page 1 × size ${size} must always be allowed`);
  }
});

// A CONFIG invariant, not a paging case: the two constants must stay compatible,
// or page 1 at the largest legal size would be rejected and no page would be
// legal at all. The behavioural half (doesNotThrow at every size) is already the
// loop above — this asserts the relationship the loop silently depends on.
test('MAX_PAGE_SIZE must fit inside the result window', () => {
  assert.ok(MAX_PAGE_SIZE <= MAX_RESULT_WINDOW,
    `MAX_PAGE_SIZE (${MAX_PAGE_SIZE}) must not exceed MAX_RESULT_WINDOW (${MAX_RESULT_WINDOW})`);
});
