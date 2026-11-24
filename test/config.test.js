// Offline unit tests for config helpers: env-var validation and the HTTPS
// token-transport guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posIntEnv, assertAuthEndpointsSecure, FACET_DIMENSIONS, userAgent, SERVER_VERSION } from '../src/config.js';
import { withEnv } from './helpers.js';

const KEY = 'SGBR_TEST_POSINT';

test('posIntEnv: unset or empty falls back', () => {
  withEnv(KEY, undefined, () => assert.equal(posIntEnv(KEY, 30000), 30000));
  withEnv(KEY, '', () => assert.equal(posIntEnv(KEY, 30000), 30000));
});

test('posIntEnv: a valid integer in range is used', () => {
  withEnv(KEY, '5000', () => assert.equal(posIntEnv(KEY, 30000, { min: 100, max: 600000 }), 5000));
});

test('posIntEnv: junk, floats, negatives and out-of-range fall back', () => {
  withEnv(KEY, 'abc', () => assert.equal(posIntEnv(KEY, 30000), 30000));
  withEnv(KEY, '1.5', () => assert.equal(posIntEnv(KEY, 30000), 30000));
  withEnv(KEY, '-5', () => assert.equal(posIntEnv(KEY, 30000, { min: 1 }), 30000));
  withEnv(KEY, '99', () => assert.equal(posIntEnv(KEY, 30000, { min: 100 }), 30000));
  withEnv(KEY, '700000', () => assert.equal(posIntEnv(KEY, 30000, { max: 600000 }), 30000));
});

test('assertAuthEndpointsSecure: no token → no-op even over http', () => {
  assert.doesNotThrow(() => assertAuthEndpointsSecure({ token: '', graphqlEndpoint: 'http://x/graphql' }));
});

test('assertAuthEndpointsSecure: token + https endpoints is allowed', () => {
  assert.doesNotThrow(() => assertAuthEndpointsSecure({
    token: 'secret', graphqlEndpoint: 'https://x/graphql', fulltextEndpoint: 'https://y/api',
  }));
});

test('assertAuthEndpointsSecure: token + non-https endpoint throws', () => {
  assert.throws(
    () => assertAuthEndpointsSecure({ token: 'secret', graphqlEndpoint: 'http://x/graphql' }),
    /Refusing to send SGBR_ACCESS_TOKEN to non-HTTPS/,
  );
});

test('assertAuthEndpointsSecure: token + non-https OCR endpoint throws', () => {
  assert.throws(
    () => assertAuthEndpointsSecure({ token: 'secret', ocrEndpoint: 'http://x/ocr' }),
    /Refusing to send SGBR_ACCESS_TOKEN to non-HTTPS/,
  );
});

test('assertAuthEndpointsSecure: a malformed token fails at launch, unquoted', () => {
  assert.throws(
    () => assertAuthEndpointsSecure({ token: 'abc\nSIGNATURE', graphqlEndpoint: 'https://x/graphql' }),
    (err) => /malformed/.test(err.message) && !`${err.message} ${err.suggestion}`.includes('SIGNATURE'),
  );
});

test('assertAuthEndpointsSecure: token + malformed endpoint throws', () => {
  assert.throws(
    () => assertAuthEndpointsSecure({ token: 'secret', graphqlEndpoint: 'not a url' }),
    /not a valid URL/,
  );
});

// Registry invariant behind src/search/compiler.js#dimensionFilter: filtering
// uses include[0] while faceting forwards the whole include array. That is only
// coherent while every include-bearing dimension carries exactly ONE value — a
// multi-include dimension would make search narrowing and facet counts silently
// disagree. If you need a multi-include dimension, teach dimensionFilter to OR
// across the include values first, then relax this test.
test('every include-bearing facet dimension has exactly one include value', () => {
  for (const [name, dim] of Object.entries(FACET_DIMENSIONS)) {
    if (!dim.include) continue;
    assert.equal(
      dim.include.length, 1,
      `dimension "${name}" must carry exactly one include value (filtering reads include[0])`,
    );
  }
});

test('userAgent: name/version plus the launcher-set entry point, stdio by default', () => {
  const base = `ub-sgbr-mcp/${SERVER_VERSION}`;
  withEnv('SGBR_ENTRY_POINT', undefined, () => assert.equal(userAgent(), `${base} (stdio)`));
  withEnv('SGBR_ENTRY_POINT', 'mcpb', () => assert.equal(userAgent(), `${base} (mcpb)`));
  withEnv('SGBR_ENTRY_POINT', ' CLI ', () => assert.equal(userAgent(), `${base} (cli)`));
  // Anything that isn't a short token falls back rather than landing in a header.
  withEnv('SGBR_ENTRY_POINT', 'a b\r\nX-Evil: 1', () => assert.equal(userAgent(), `${base} (stdio)`));
});
