// The argument fragments src/guide.md, SKILL.md, docs/ and the tool
// descriptions show the model must still be arguments the server accepts. A
// stale example fails silently: a renamed parameter is refused, but a stale
// vocabulary value returns an EMPTY RESULT, not an error, so the example reads
// as a real finding of zero.
//
// How the examples could fail:
//   - the extractor stops seeing them (a changed span style, a moved file, the
//     descriptions' prose form), so every check below passes on nothing;
//   - a fragment names a key no tool takes or returns: a renamed parameter or a
//     typo (`genres:` for `genre:`);
//   - a checked value is one its schema refuses: a renamed enum value (`sort`,
//     `scope`, `engine`, `facet`) or a wrong type;
//   - a prose mention `sgbr_x` names no registered tool;
//   - live only: a filter value no record carries any more (a renamed
//     vocabulary), which every offline check passes.
//
// Schemas come from listTools(), the wire contract, never from importing
// config.js. When a check fails on today's docs, fix the doc; when the doc and
// the server disagree about behaviour, not spelling, ask first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { LIVE, liveSearchCount, withClient } from './helpers.js';
import {
  readDocSources, wireSources, extractFragments, extractMentions,
  schemaIndex, unknownKeys, rejectedValues, vocabularyPairs,
} from './doc-examples.js';

const { tools, instructions } = await withClient('ub-sgbr-doc-examples', async (client) => ({
  tools: (await client.listTools()).tools,
  instructions: client.getInstructions(),
}));
const docs = readDocSources();
const wire = wireSources(tools, instructions);
const sources = [...docs, ...wire];
const fragments = extractFragments(sources);
const index = schemaIndex(tools);

// Room to delete an example, none to lose a whole file.
const MIN_FRAGMENTS = 60;

test('the extractor still finds the documented fragments', () => {
  assert.ok(fragments.length >= MIN_FRAGMENTS, `found only ${fragments.length} fragment(s)`);
  assert.ok(
    fragments.some((f) => f.args && JSON.stringify(f.args) === JSON.stringify({ filters: { genre: ['Hochschulschrift'] } })),
    'the known fragment `filters: { genre: ["Hochschulschrift"] }` is no longer found',
  );
  assert.ok(extractFragments(wire).length > 0, 'no fragment found in the descriptions, so their examples go unchecked');
});

test('every fragment key is a parameter, a filter dimension or an output field', () => {
  assert.deepEqual(unknownKeys(fragments, index), []);
});

test('every checked value is accepted by its schema', () => {
  assert.deepEqual(rejectedValues(fragments, index, new AjvJsonSchemaValidator()), []);
});

test('every sgbr_x mention names a registered tool', () => {
  const names = new Set(tools.map((t) => t.name));
  const unknown = extractMentions(sources).filter((m) => !names.has(m.name)).map((m) => `${m.source}: ${m.name}`);
  assert.deepEqual([...new Set(unknown)], []);
});

// The release-time live run only, never CI. Sequential and count-only (a
// pageSize-0 search per pair, no other operation), and capped before the first
// call so a growing doc set cannot turn into a burst on the library's servers.
// Raising the cap is a deliberate commit.
const MAX_LIVE_PAIRS = 30;

test('live: every documented filter value still matches records', { skip: !LIVE }, async () => {
  const pairs = vocabularyPairs(fragments, index);
  assert.ok(pairs.length > 0, 'no documented filter value found');
  assert.ok(pairs.length <= MAX_LIVE_PAIRS, `${pairs.length} pairs exceed the cap of ${MAX_LIVE_PAIRS}; no call was sent`);
  const empty = [];
  for (const { dimension, value } of pairs) {
    const count = await liveSearchCount({ filters: { [dimension]: [value] } });
    if (!(count > 0)) empty.push(`${dimension}: ${value} → ${count}`);
  }
  assert.deepEqual(empty, [], 'documented filter values that match no record');
});
