// SEP-2549 cache hints on the cacheable list results, asserted on the wire.
//
// Why the transport is driven directly instead of through a `Client`: the SDK stamps
// `ttlMs`/`cacheScope` ONLY on 2026-07-28-era results, and the installed
// @modelcontextprotocol/client's LATEST_PROTOCOL_VERSION is '2025-11-25' — its
// `initialize` handshake cannot reach the era that carries the fields. So a
// withClient() test would assert `undefined` forever and read as "the hints don't
// work". The 2026 era is entered by calling `server/discover` with the per-request
// `_meta` envelope, which needs raw messages but not a raw pipe.
//
// Both directions are pinned on purpose: the modern path must carry the
// configured values, and the legacy path must carry NONE (the SDK contract is
// that 2025-era responses are never affected). Losing the second assertion is
// how someone later "fixes" a non-bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withClient, withModernServer, MODERN_VERSION } from './helpers.js';
import { CACHE_HINTS } from '../src/config.js';

const MANIFEST_TOOL_ORDER = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
  .tools.map((t) => t.name);

// No hand-rolled per-request timer: node:test's own timeout covers a server that
// never answers, and reports it as this test rather than as a bare rejection.
test('a 2026-era connection gets the configured cache hints', { timeout: 20000 }, async () => {
  await withModernServer(async (call) => {
    const discover = await call('server/discover');
    assert.ok(
      discover.supportedVersions?.includes(MODERN_VERSION),
      `server/discover must advertise ${MODERN_VERSION}; got ${JSON.stringify(discover.supportedVersions)}`,
    );
    // A TTL is only an honest freshness signal if it is the ONLY one: the SDK
    // defaults listChanged to true, and this server never sends the notification.
    assert.equal(discover.capabilities?.tools?.listChanged, false,
      'tools.listChanged must be advertised false — nothing here emits list_changed');

    // Driven off the config map, not a hardcoded pair: the SDK validates hint
    // VALUES at construction but never the keys, so a method name that is
    // typo'd — or simply added later — is accepted and silently never stamped.
    for (const [method, hint] of Object.entries(CACHE_HINTS)) {
      const result = await call(method);
      assert.equal(result.ttlMs, hint.ttlMs, `${method} must carry the configured ttlMs`);
      assert.equal(result.cacheScope, hint.cacheScope, `${method} must carry the configured cacheScope`);
    }
  });
});

test('a 2025-era connection carries no cache fields at all', async () => {
  await withClient('ub-sgbr-cache-hints-legacy', async (client) => {
    const res = await client.listTools();
    assert.ok(res.tools.length, 'sanity: the legacy path still serves tools');
    assert.equal(res.ttlMs, undefined, 'the 2025 era must not be stamped');
    assert.equal(res.cacheScope, undefined, 'the 2025 era must not be stamped');
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, false,
      'the legacy initialize handshake must also advertise listChanged:false');
  });
});

// The 2026-07-28 revision says tools/list SHOULD be deterministically ordered —
// it is what makes a `public` 24 h TTL (and an LLM prompt-cache hit on the
// catalogue) worth anything. Pinned to manifest.json's sequence rather than to
// "same as last call": a fixed reference catches a reorder, not just jitter, and
// keeps the Desktop bundle's listing and the wire listing the same order.
test('tools/list order is deterministic and matches manifest.json', async () => {
  const first = await withClient('ub-sgbr-order-a', async (c) => (await c.listTools()).tools.map((t) => t.name));
  const second = await withClient('ub-sgbr-order-b', async (c) => (await c.listTools()).tools.map((t) => t.name));
  assert.deepEqual(first, MANIFEST_TOOL_ORDER, 'wire order must equal manifest.json order');
  assert.deepEqual(second, first, 'two connections must list tools in the same order');
});
