// Delivery sizing for images the MODEL inspects: the largest IIIF confined box
// whose result the consuming model accepts untouched, never larger than the
// region's own pixels. Budget constants and their rationale live in config.js.
//
// Separate from image.js on purpose: that module owns the mediaserver's URL
// grammar, this one owns a vision encoder's billing rules. The two change for
// entirely unrelated reasons, and nobody revising a model's token limit would
// think to look in a file about IIIF paths.

import {
  VISION_PATCH, VISION_MAX_EDGE, VISION_MAX_TOKENS, VISION_MAX_AREA,
} from '../config.js';

/** Width or height rounded up to the patch grid — what the encoder measures. */
export function padToPatch(px) {
  return Math.ceil(px / VISION_PATCH) * VISION_PATCH;
}

/** Visual-token cost of a w×h image: one token per 28×28 patch. */
export function visualTokens(width, height) {
  return Math.ceil(width / VISION_PATCH) * Math.ceil(height / VISION_PATCH);
}

/**
 * What IIIF `!box,box` yields for a width×height region: scaled to fit inside the
 * box with aspect preserved. The server derives both dimensions, so predict them
 * the same way it does; being a pixel out only ever costs a pixel.
 */
export function confinedBox(width, height, box) {
  const scale = box / Math.max(width, height);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** True when a delivered w×h image reaches the model unmodified. */
export function fitsVisionBudget(width, height) {
  return padToPatch(width) <= VISION_MAX_EDGE
    && padToPatch(height) <= VISION_MAX_EDGE
    && visualTokens(width, height) <= VISION_MAX_TOKENS
    && width * height <= VISION_MAX_AREA;
}

/**
 * Largest confined box for a region of this shape that arrives untouched.
 *
 * Which ceiling binds flips with aspect ratio, so no single scalar expresses it:
 * an elongated region is edge-bound (1988) while a square one is token-bound
 * (1932). For whole pages of this corpus the edge always binds — but a crop's
 * shape is whatever the caller asks for, and a near-square crop of a foldout does
 * reach the token limit, where a flat cap would be silently downscaled.
 *
 * Scans largest-first, so the first fit is the answer. A binary search would be
 * fewer probes but would rest on an unstated monotonicity invariant; against the
 * IIIF fetch that follows, the scan is not worth the extra thing to prove.
 */
export function maxDeliveryEdge(regionWidth, regionHeight) {
  if (!(regionWidth > 0) || !(regionHeight > 0)) return VISION_MAX_EDGE;
  for (let box = VISION_MAX_EDGE; box > 1; box--) {
    const [w, h] = confinedBox(regionWidth, regionHeight, box);
    if (fitsVisionBudget(w, h)) return box;
  }
  return 1; // region taller than the edge cap even one pixel wide
}

/**
 * Compose the two ceilings for one request and report which one bound it.
 *
 * `boundBy` must stay distinguishable, because the two tell the model OPPOSITE
 * things about what to do next:
 *   'native' — the region has no more real pixels; a WIDER crop adds detail, a
 *              larger max_long_edge adds nothing but interpolation.
 *   'vision' — anything larger is downscaled before the model sees it; a TIGHTER
 *              crop raises pixels-per-glyph, a wider delivery gains nothing.
 * `null` means the request already fitted and nothing was reduced.
 *
 * `regionWidth`/`regionHeight` are the region's NATIVE pixels. Pass nulls when
 * they could not be determined (an info.json that failed): the native clamp is
 * skipped rather than guessed — a wrong clamp would silently downscale real detail
 * — and the edge is capped at what a square fits, so any shape arrives undownscaled.
 * No `boundBy` then: with the shape unknown, "a tighter crop" would be a guess.
 */
export function resolveDeliveryEdge(requested, regionWidth, regionHeight) {
  if (!(regionWidth > 0 && regionHeight > 0)) {
    return { edge: Math.min(requested, maxDeliveryEdge(1, 1)), boundBy: null };
  }
  const visionMax = maxDeliveryEdge(regionWidth, regionHeight);
  const nativeMax = Math.max(regionWidth, regionHeight);
  const edge = Math.max(1, Math.min(requested, visionMax, nativeMax));
  if (edge >= requested) return { edge: requested, boundBy: null };
  // Native wins ties: when a region is both smaller than the box and over budget,
  // upscaling is the more actionable thing to tell the caller about.
  return { edge, boundBy: nativeMax <= visionMax ? 'native' : 'vision' };
}
