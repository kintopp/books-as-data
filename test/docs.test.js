// docs/tools.md quotes the server's wire text — the MCP `instructions`, and each
// tool's `description` and parameter table — inside generated blocks that
// `npm run build:docs` renders from a live listTools. Asserted against the REAL
// wire: the server is spawned over stdio, so this checks what a client is
// actually told. Offline — initialize and listTools make no backend call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withClient } from './helpers.js';
import { DOC_PATH, renderToolsDoc } from '../scripts/build-docs.mjs';

const DOC = readFileSync(DOC_PATH, 'utf8');
const wire = withClient('ub-sgbr-docs', async (client) => ({
  instructions: client.getInstructions(),
  tools: (await client.listTools()).tools,
}));

test('docs/tools.md\'s generated blocks match the wire', async () => {
  assert.equal(DOC, renderToolsDoc(DOC, await wire),
    'docs/tools.md is stale — run `npm run build:docs` and commit the result');
});

// The one closed set the doc still enumerates by hand: it is where a reader
// picks a dimension from, so a missing row is unreachable and a leftover one is
// a value the server rejects.
test('docs/tools.md\'s dimension table has exactly the facet dimensions', async () => {
  const { tools } = await wire;
  const dims = tools.find((t) => t.name === 'sgbr_facet_values').inputSchema.properties.facet.enum;
  const table = DOC.slice(DOC.indexOf('### Dimensions')).split(/^## /m)[0];
  const rows = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...rows].sort(), [...dims].sort());
});
