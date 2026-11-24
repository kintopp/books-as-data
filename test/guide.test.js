// How sgbr_guide could fail (after skkg-mcp's test/guide.test.js):
// - A section of src/guide.md is missing from the topics, cut short, duplicated, or out of
//   order, or text before the first section is silently dropped.
// - A topic cannot be reached by its name, or returns another section.
// - Without `topic`, it returns something other than the overview, or the overview stops
//   naming every other topic or carrying the checklist.
// - The guide points to a topic that does not exist, or still to SKILL.md or references/.
// - The text channel lacks the section or the names of the other topics, or is JSON.
// - It needs the backend, so a host that cannot reach books-as-data gets an error.
// - An unknown topic is accepted and answered with something.
// - A topic outgrows the result size limit, or a lowered limit is ignored.
// - The description stops saying when to read it, or names topics the guide does not have.
// - The server instructions stop pointing to it, or push a query trap past, the 512
//   characters some hosts pass on.
// - A heading that slugs badly (non-ASCII letters, two headings to one name), an empty
//   section, or a `##` inside a code fence is accepted and misnames or splits a topic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withClient, assertWireValid, ROOT } from './helpers.js';
import { outputSchema } from '../src/tools/guide.js';
import { parseGuide } from '../src/lib/guide.js';
import { PER_CHANNEL_RESULT_BUDGET } from '../src/config.js';

const NAME = 'sgbr_guide';
// Unreachable endpoints: the guide must answer without the backend.
const DEAD = 'http://127.0.0.1:9';
const OFFLINE = {
  env: {
    SGBR_GRAPHQL_ENDPOINT: `${DEAD}/graphql`, SGBR_FULLTEXT_ENDPOINT: DEAD,
    SGBR_IMAGE_ENDPOINT: `${DEAD}/iiif/3`, SGBR_OCR_ENDPOINT: DEAD,
  },
};
const source = readFileSync(join(ROOT, 'src', 'guide.md'), 'utf8');
const headings = [...source.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

async function read(client, args = {}) {
  const res = await client.callTool({ name: NAME, arguments: args });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  return { structured: assertWireValid(outputSchema, res.structuredContent), text: res.content[0].text };
}

test('every section of the guide is one topic, named after its heading, and the topics rebuild the sections', async () => {
  await withClient('guide-topics', async (client) => {
    const { structured } = await read(client);
    assert.deepEqual(structured.topics.map((t) => t.title), headings);
    assert.equal(structured.topics.find((t) => t.title === 'Historic spelling')?.topic, 'historic_spelling');
    assert.equal(structured.topics.find((t) => t.title === 'Cross-tabs')?.topic, 'cross_tabs');

    const texts = [];
    for (const { topic, title } of structured.topics) {
      const r = await read(client, { topic });
      assert.equal(r.structured.topic, topic);
      assert.equal(r.structured.title, title);
      texts.push(`## ${title}\n\n${r.structured.text}`);
    }
    assert.equal(`${texts.join('\n\n')}\n`, source.slice(source.indexOf('\n## ') + 1));
  }, OFFLINE);
});

test('without a topic it returns the overview, which names every other topic and holds the checklist', async () => {
  await withClient('guide-default', async (client) => {
    const { structured } = await read(client);
    assert.equal(structured.topic, 'overview');
    assert.match(structured.text, /### Checklist/);
    assert.match(structured.text, /sgbr_locate_text/);
    for (const { topic } of structured.topics.slice(1)) {
      assert.ok(structured.text.includes(`\`${topic}\``), `the overview never names topic ${topic}`);
    }
  }, OFFLINE);
});

test('every topic the guide points to exists, and nothing points to the old skill files', () => {
  const names = new Set(parseGuide(source).map((t) => t.topic));
  const pointed = [...source.matchAll(/topics? `([a-z_]+)`/g)].map((m) => m[1]);
  assert.ok(pointed.length >= 10, `only ${pointed.length} topic pointers found`);
  assert.deepEqual(pointed.filter((t) => !names.has(t)), []);
  assert.doesNotMatch(source, /SKILL\.md|references\//);
});

test('the text channel holds the section and names every other topic, not JSON', async () => {
  await withClient('guide-text', async (client) => {
    const { structured, text } = await read(client, { topic: 'foldouts' });
    assert.ok(text.startsWith('Books as Data guide, topic foldouts\n'), text.slice(0, 80));
    assert.ok(text.includes(`## Foldouts\n\n${structured.text}\n`), 'the section is in the text');
    const others = structured.topics.map((t) => t.topic).filter((t) => t !== 'foldouts');
    assert.ok(text.endsWith(`Other topics, to pass as \`topic\`: ${others.join(', ')}.`), text.slice(-200));
  }, OFFLINE);
});

test('an unknown topic is refused', async () => {
  await withClient('guide-unknown', async (client) => {
    const res = await client.callTool({ name: NAME, arguments: { topic: 'iconography' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /topic/);
  }, OFFLINE);
});

test('every topic fits the per-channel result budget in both channels', async () => {
  await withClient('guide-size', async (client) => {
    const { structured } = await read(client);
    for (const { topic } of structured.topics) {
      const r = await read(client, { topic });
      assert.ok(r.text.length <= PER_CHANNEL_RESULT_BUDGET, `${topic}: text ${r.text.length}`);
      assert.ok(JSON.stringify(r.structured).length <= PER_CHANNEL_RESULT_BUDGET, `${topic}: structured`);
    }
  }, OFFLINE);
});

test('a topic over a lowered result size limit is refused, not sent', async () => {
  await withClient('guide-ceiling', async (client) => {
    const res = await client.callTool({ name: NAME, arguments: { topic: 'collection' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /too large for the result size limit \(400 characters per channel\).*SGBR_RESULT_CHAR_CEILING/s);
  }, { env: { ...OFFLINE.env, SGBR_RESULT_CHAR_CEILING: '1000' } });
});

test('the description says when to read it and lists exactly the topic names that `topic` takes', async () => {
  await withClient('guide-description', async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === NAME);
    assert.equal(tool.description.split('. ')[0], 'How to search Books as Data well: read it before your first search');
    const names = tool.inputSchema.properties.topic.enum;
    assert.equal(names.length, headings.length);
    assert.ok(tool.description.includes(` Topics: ${names.join(', ')}. `), tool.description);
  }, OFFLINE);
});

test('the first 512 characters of the server instructions point to sgbr_guide and keep the query traps', async () => {
  await withClient('guide-instructions', async (client) => {
    const head = (client.getInstructions() ?? '').slice(0, 512);
    assert.ok(head.includes('Read sgbr_guide before the first search.'), head);
    assert.ok(head.includes('the words AND/OR/NOT and field:value are not operators.'), head);
  }, OFFLINE);
});

test('the parser', async (t) => {
  await t.test('names a topic after its heading', () => {
    assert.deepEqual(parseGuide('# T\n\n## A b\n\ntext\n'), [{ topic: 'a_b', title: 'A b', text: 'text' }]);
  });
  await t.test('refuses text before the first section', () => {
    assert.throws(() => parseGuide('# T\n\nAlways OR the spellings.\n\n## A\n\ntext\n'), /before the first `##` section/);
  });
  await t.test('refuses a guide without sections', () => {
    assert.throws(() => parseGuide('# T\n\ntext\n'), /no `##` section/);
  });
  await t.test('refuses an empty section', () => {
    assert.throws(() => parseGuide('# T\n\n## A\n\n## B\n\ntext\n'), /"A" has no name or no text/);
  });
  await t.test('refuses two headings with one topic name', () => {
    assert.throws(() => parseGuide('# T\n\n## A b\n\none\n\n## A, b\n\ntwo\n'), /two sections are named a_b/);
  });
  await t.test('refuses a heading with letters the topic name would drop', () => {
    assert.throws(() => parseGuide('# T\n\n## Überblick\n\ntext\n'), /ASCII/);
  });
  await t.test('refuses a code fence, which could hide a heading', () => {
    assert.throws(() => parseGuide('# T\n\n## A\n\n```\n## B\n```\n'), /code fence/);
  });
});
