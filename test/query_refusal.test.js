// Every tool whose `query` reaches the Lucene parser must refuse the
// whole-corpus forms (src/lib/warnings.js assertQuery). The set is derived from
// the live tool list rather than typed out, so a tenth tool that declares a
// `query` and forgets the guard fails here on arrival. Offline-safe: a refused
// query makes no request, and a tool that did NOT refuse would fail this test
// on the message before any network error could be mistaken for a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient } from './helpers.js';

// A prefix suggester, not the parser: none of the refused forms mean the same
// thing there (see assertQuery).
const EXEMPT = new Set(['sgbr_autocomplete']);

// The other required arguments each query tool needs to get past zod and into
// its handler, where the refusal fires first. A new query tool with required
// arguments missing here fails on validation, which is the loud failure wanted.
const REQUIRED = {
  sgbr_facet_values: { facet: 'library' },
  sgbr_facet_breakdown: { facet: 'language', breakdown: 'genre' },
};

const REFUSED = ['(Cholera*) | (choléra*)', '   '];

test('every query-taking tool refuses the whole-corpus forms', async () => {
  await withClient('ub-sgbr-refusal', async (client) => {
    const { tools } = await client.listTools();
    const queryTools = tools.filter((t) => t.inputSchema?.properties?.query && !EXEMPT.has(t.name));
    assert.ok(queryTools.length >= 3, `expected the three query tools, got: ${queryTools.map((t) => t.name).join(', ')}`);
    for (const { name } of queryTools) {
      for (const query of REFUSED) {
        const res = await client.callTool({ name, arguments: { ...(REQUIRED[name] || {}), query } });
        assert.equal(res.isError, true, `${name} did not refuse ${JSON.stringify(query)}`);
        assert.match(res.content[0].text, /whole corpus/i, `${name}: ${res.content[0].text}`);
      }
    }
  });
});
