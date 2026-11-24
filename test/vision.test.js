// Offline unit tests for the image delivery solver. No network — pure functions
// from src/lib/vision.js plus the geometry helpers in src/lib/image.js.
//
// The assertion that earns its keep is MAXIMALITY, not fit: "the result fits"
// passes trivially for any conservative implementation, including a broken one
// that always returns 200. Asserting that box + 1 does NOT fit is what pins the
// value. The predicate is stated ONCE, from the exported constants — two copies
// invite them to disagree about exactly the thing under test, and an inlined
// number would keep passing against a superseded contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  padToPatch, visualTokens, confinedBox, fitsVisionBudget, maxDeliveryEdge, resolveDeliveryEdge,
} from '../src/lib/vision.js';
import { regionPixelDims, jpegDimensions } from '../src/lib/image.js';
import {
  VISION_PATCH, VISION_MAX_EDGE, VISION_MAX_TOKENS, VISION_MAX_AREA, MAX_IMAGE_LONG_EDGE,
} from '../src/config.js';

// Does asking for `!box,box` on a w×h region produce something the model takes
// untouched? The single statement of the contract the solver maximises.
const boxFits = (box, w, h) => fitsVisionBudget(...confinedBox(w, h, box));

// Real page dimensions from the corpus census (vision-image-sizing-census.md
// *(internal)*).
const SHAPES = [
  ['book page, median', 1544, 2480],
  ['book page, narrow', 1320, 2368],
  ['book page, widest short edge', 6387, 4200],
  ['foldout, median', 4584, 2863],
  ['foldout, extreme landscape', 8530, 3322],
  ['foldout, near-square crop', 2400, 2300],
  ['square', 2000, 2000],
  ['word region', 70, 30],
  ['line region', 870, 50],
];

test('maxDeliveryEdge returns the largest box that survives, for every corpus shape', () => {
  for (const [label, w, h] of SHAPES) {
    const box = maxDeliveryEdge(w, h);
    assert.ok(boxFits(box, w, h), `${label}: ${box}px must fit the budget`);
    assert.ok(!boxFits(box + 1, w, h), `${label}: ${box + 1}px must not — ${box} is the ceiling`);
  }
});

test('the binding ceiling flips with aspect ratio', () => {
  // An elongated region is edge-bound and reaches the cap; a square one is
  // token-bound below it. A single scalar cannot express both — which is the
  // whole reason this module exists rather than one more constant.
  assert.equal(maxDeliveryEdge(8530, 3322), VISION_MAX_EDGE, 'elongated: edge-bound at the cap');
  const square = maxDeliveryEdge(2000, 2000);
  assert.ok(square < VISION_MAX_EDGE, `square must be token-bound below the cap, got ${square}`);
  assert.ok(visualTokens(square, square) <= VISION_MAX_TOKENS);
});

test('a near-square foldout crop is held under the token budget, not just the edge cap', () => {
  // The one case in this corpus where a flat cap would be silently downscaled:
  // book pages are too narrow to yield a near-square region above the cap, but
  // foldouts (median short edge 2863px) are not.
  const [w, h] = [2400, 2300];
  assert.ok(
    visualTokens(...confinedBox(w, h, VISION_MAX_EDGE)) > VISION_MAX_TOKENS,
    'precondition: a flat cap would exceed the budget for this shape',
  );
  assert.ok(visualTokens(...confinedBox(w, h, maxDeliveryEdge(w, h))) <= VISION_MAX_TOKENS);
});

test('the cap is patch-aligned and under the many-image per-side limit', () => {
  // Regression guard. 1540 was the old cap; 2016 is the next patch boundary and
  // is OVER the ~2000px limit that applies once a request carries more than 20
  // images. Don't "fix" the cap to either.
  assert.equal(VISION_MAX_EDGE % VISION_PATCH, 0, 'a non-aligned cap wastes a partial patch row');
  assert.ok(VISION_MAX_EDGE < 2000, 'must stay under the many-image per-side limit');
  assert.notEqual(VISION_MAX_EDGE, 1540, 'the pre-clamp cap, superseded');
  assert.notEqual(VISION_MAX_EDGE, 2016, 'the next patch boundary is over the limit — round DOWN');
  // The edge check runs on the PADDED width, so nothing between the cap and the
  // next boundary is reachable anyway.
  assert.equal(padToPatch(VISION_MAX_EDGE + 1), VISION_MAX_EDGE + VISION_PATCH);
});

test('the schema bound and the solver cap are the same constant', () => {
  // A literal in the schema would let it reject values the solver would serve,
  // with no compile error to catch it.
  assert.equal(MAX_IMAGE_LONG_EDGE, VISION_MAX_EDGE);
});

test('resolveDeliveryEdge distinguishes the two ceilings', () => {
  // Native-bound: the region has no more pixels. A WIDER crop is the remedy.
  const small = resolveDeliveryEdge(VISION_MAX_EDGE, 175, 132);
  assert.equal(small.edge, 175);
  assert.equal(small.boundBy, 'native');

  // Vision-bound: the region has pixels to spare but the delivery is over budget.
  const big = resolveDeliveryEdge(VISION_MAX_EDGE, 4000, 3800);
  assert.equal(big.boundBy, 'vision');
  assert.ok(big.edge < VISION_MAX_EDGE);

  // Nothing reduced: the request already fits inside both ceilings.
  const fine = resolveDeliveryEdge(800, 4000, 6000);
  assert.deepEqual(fine, { edge: 800, boundBy: null });
});

test('resolveDeliveryEdge skips the native clamp when dimensions are unknown', () => {
  // An info.json that failed must not become a clamp to zero — that would
  // silently downscale every image on a transient lookup failure.
  const unknown = resolveDeliveryEdge(VISION_MAX_EDGE, 0, 0);
  assert.ok(unknown.edge > 1900);
  // Unknown shape: the edge must still be safe for a near-square image.
  assert.ok(fitsVisionBudget(unknown.edge, unknown.edge));
  assert.equal(unknown.boundBy, null);
});

test('regionPixelDims converts a pct region to native pixels', () => {
  assert.deepEqual(regionPixelDims([10, 10, 10, 5], 1752, 2632), { width: 175, height: 132 });
  // No region means the whole page.
  assert.deepEqual(regionPixelDims(null, 1752, 2632), { width: 1752, height: 2632 });
  // Unknown page size is reported as zero, not guessed.
  assert.deepEqual(regionPixelDims([0, 0, 50, 50], 0, 0), { width: 0, height: 0 });
});

test('regionPixelDims clips overhang the way the server does', () => {
  // A region starting inside the page but running past its edge comes back
  // clipped, not scaled — so only the part that landed has pixels. Measuring the
  // requested 20% would over-estimate and defeat the clamp.
  const { width } = regionPixelDims([90, 0, 20, 10], 1000, 1000);
  assert.equal(width, 100, 'only the 10% inside the page counts');
});

test('regionPixelDims measures the rounded percentages the URL carries', () => {
  // pctSeg rounds to 2 decimals before the URL is built; measuring the raw value
  // would describe a region that was never requested.
  const { width } = regionPixelDims([0, 0, 33.333, 10], 3000, 1000);
  assert.equal(width, Math.round(3000 * 33.33 / 100));
});

test('jpegDimensions reads the frame header, and refuses non-JPEG bytes', () => {
  // Minimal JPEG: SOI, SOF0 (1988 high × 1324 wide), EOI.
  const jpeg = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x07, 0xC4, 0x05, 0x2C, 0x01, 0x11, 0x00, 0xFF, 0xD9,
  ]);
  assert.deepEqual(jpegDimensions(jpeg), { width: 1324, height: 1988 });
  assert.equal(jpegDimensions(Buffer.from('not a jpeg at all')), null);
  assert.equal(jpegDimensions(Buffer.alloc(0)), null);
  // Truncated after the marker: null, never a partial read.
  assert.equal(jpegDimensions(Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00])), null);
});

test('the area ceiling is carried even though it never binds', () => {
  // 1988² = 3.95 MP against the server's advertised 10 MP maxArea. The guard is
  // here so the solver stays correct the day either number moves.
  assert.ok(VISION_MAX_EDGE ** 2 < VISION_MAX_AREA);
  assert.ok(!fitsVisionBudget(4000, 4000), 'over on every ceiling, area included');
});
