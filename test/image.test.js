// Offline unit tests for IIIF image URL construction and response shaping.
// No network access — these exercise pure functions in src/lib/image.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageUrl, buildImageResponse } from '../src/lib/image.js';
import { MAX_IMAGE_LONG_EDGE, MAX_IMAGE_BYTES, FRONTEND_BASE_URL, DEFAULT_IMAGE_LONG_EDGE } from '../src/config.js';

test('imageUrl caps the long edge with an IIIF confined-box size', () => {
  const url = imageUrl({ scanId: 'UBBS-00190048', page: 1 });
  assert.ok(url.includes('UBBS-00190048_00000001.jp2'), `expected page segment in ${url}`);
  assert.ok(
    url.includes(`full/!${DEFAULT_IMAGE_LONG_EDGE},${DEFAULT_IMAGE_LONG_EDGE}/0/default.jpg`),
    `expected default confined-box size in ${url}`,
  );
});

test('imageUrl clamps long edge to MAX_IMAGE_LONG_EDGE', () => {
  const url = imageUrl({ scanId: 'UBBS-00190048', page: 1, longEdge: 99999 });
  assert.ok(
    url.includes(`full/!${MAX_IMAGE_LONG_EDGE},${MAX_IMAGE_LONG_EDGE}/0/default.jpg`),
    `expected clamped size in ${url}`,
  );
});

test('imageUrl zero-pads the page to 8 digits, 1-based', () => {
  assert.ok(imageUrl({ scanId: 'UBBS-00190048', page: 5 }).includes('_00000005.jp2'));
  assert.ok(imageUrl({ scanId: 'UBBS-00190048', page: 179 }).includes('_00000179.jp2'));
});

test('buildImageResponse withholds the bytes over MAX_IMAGE_BYTES', () => {
  const { data, structured } = buildImageResponse({
    scanId: 'UBBS-00190048', recordId: null, page: 1, longEdge: DEFAULT_IMAGE_LONG_EDGE,
    buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1), mimeType: 'image/jpeg', url: 'http://x/page.jpg',
  });
  assert.equal(data, null);
  assert.equal(structured.byte_size, MAX_IMAGE_BYTES + 1);
});

test('buildImageResponse keeps base64 out of structuredContent', () => {
  const buffer = Buffer.from('fake-jpeg-bytes');
  const { data, structured } = buildImageResponse({
    scanId: 'UBBS-00190048', recordId: 'rec-1', page: 1, longEdge: DEFAULT_IMAGE_LONG_EDGE,
    buffer, mimeType: 'image/jpeg', url: 'http://x/page.jpg',
  });
  assert.equal(data, buffer.toString('base64'));
  const json = JSON.stringify(structured);
  assert.ok(!json.includes(data), 'base64 must not appear in structuredContent');
  assert.equal(structured.scan_id, 'UBBS-00190048');
  assert.equal(structured.id, 'rec-1');
  assert.equal(structured.page, 1);
  assert.equal(structured.long_edge, DEFAULT_IMAGE_LONG_EDGE);
  assert.equal(structured.byte_size, buffer.length);
  assert.equal(structured.mime_type, 'image/jpeg');
  assert.equal(structured.source_url, 'http://x/page.jpg');
  assert.equal(structured.viewer_url, `${FRONTEND_BASE_URL}/en/detail/rec-1?page=1`);
});

test('buildImageResponse has no viewer_url when the record id is unknown (scan_id path)', () => {
  const { structured } = buildImageResponse({
    scanId: 'UBBS-00190048', recordId: null, page: 3, longEdge: 800,
    buffer: Buffer.from('x'), mimeType: 'image/jpeg', url: 'http://x/p.jpg',
  });
  assert.equal(structured.id, null);
  assert.equal(structured.viewer_url, null);
});

test('imageUrl emits a pct region segment when regionPct is given', () => {
  const url = imageUrl({ scanId: 'UBBS-00190048', page: 5, regionPct: [0, 85, 30, 15] });
  assert.ok(url.includes('/pct:0,85,30,15/'), `expected region segment in ${url}`);
  assert.ok(
    url.endsWith(`/!${DEFAULT_IMAGE_LONG_EDGE},${DEFAULT_IMAGE_LONG_EDGE}/0/default.jpg`),
    `expected default size suffix in ${url}`,
  );
});

test('imageUrl defaults to the full region', () => {
  const url = imageUrl({ scanId: 'UBBS-00190048', page: 1 });
  assert.ok(url.includes('/full/!'), `expected full region in ${url}`);
  assert.ok(!url.includes('pct:'), `expected no pct segment in ${url}`);
});

test('imageUrl clamps and rounds pct coordinates', () => {
  const url = imageUrl({ scanId: 'UBBS-00190048', page: 1, regionPct: [-5, 110, 33.333, 15.005] });
  assert.ok(url.includes('/pct:0,100,33.33,15.01/'), `expected clamped/rounded region in ${url}`);
});

test('imageUrl never emits an upscale caret or a v3-invalid full size', () => {
  const url = imageUrl({ scanId: 'UBBS-00190048', page: 1, regionPct: [0, 85, 30, 15] });
  assert.ok(!url.includes('^'), `expected no caret in ${url}`);
  assert.ok(!url.includes('/full/full/'), `expected no invalid full size in ${url}`);
  assert.match(url, /\/!\d+,\d+\//, `expected an !N,N size segment in ${url}`);
});

test('buildImageResponse echoes region_pct and nulls it when absent', () => {
  const withRegion = buildImageResponse({
    scanId: 'UBBS-00190048', recordId: 'rec-1', page: 1, longEdge: 600, regionPct: [0, 85, 30, 15],
    buffer: Buffer.from('x'), mimeType: 'image/jpeg', url: 'http://x/p.jpg',
  });
  assert.deepEqual(withRegion.structured.region_pct, [0, 85, 30, 15]);

  const withoutRegion = buildImageResponse({
    scanId: 'UBBS-00190048', recordId: 'rec-1', page: 1, longEdge: 600,
    buffer: Buffer.from('x'), mimeType: 'image/jpeg', url: 'http://x/p.jpg',
  });
  assert.equal(withoutRegion.structured.region_pct, null);
});
