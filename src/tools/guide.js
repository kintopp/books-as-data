// sgbr_guide: how to use the sgbr tools well, one topic per call (after skkg-mcp). The text is
// src/guide.md, the only copy of the guidance: the books-as-data skill only points here, so an
// installed skill cannot go stale against the server.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { parseGuide } from '../lib/guide.js';
import { READ_ONLY_ANNOTATIONS, PER_CHANNEL_RESULT_BUDGET } from '../config.js';

export const GUIDE_TOOL_NAME = 'sgbr_guide';

const TOPICS = parseGuide(readFileSync(new URL('../guide.md', import.meta.url), 'utf8'));
const TOPIC_LIST = TOPICS.map(({ topic, title }) => ({ topic, title }));
const DEFAULT_TOPIC = TOPICS[0].topic;

const description =
  'How to search Books as Data well: read it before your first search. Read one topic at a time. ' +
  `Topics: ${TOPICS.map((t) => t.topic).join(', ')}. ` +
  `Start with ${DEFAULT_TOPIC}, then read the topics the question needs; each result names the others.`;

const inputSchema = z.object({
  topic: z.enum(TOPICS.map((t) => t.topic)).default(DEFAULT_TOPIC).describe(
    `Topic to read: ${TOPICS.map((t) => `${t.topic} (${t.title})`).join(', ')}. Default ${DEFAULT_TOPIC}`),
}).strict();

export const outputSchema = z.object({
  topic: z.string(),
  title: z.string(),
  text: z.string().describe('The topic\'s guidance, in Markdown'),
  topics: z.array(z.object({ topic: z.string(), title: z.string() })).describe('Every topic, in order, to pass as `topic`'),
});

function renderGuide(r) {
  const others = TOPIC_LIST.filter((t) => t.topic !== r.topic).map((t) => t.topic);
  return [
    `Books as Data guide, topic ${r.topic}`,
    '',
    `## ${r.title}`,
    '',
    r.text,
    '',
    `Other topics, to pass as \`topic\`: ${others.join(', ')}.`,
  ].join('\n');
}

// Built once: the file and the ceiling are both fixed at startup. An oversized topic is
// refused per call rather than at load, so a lowered ceiling never stops the server starting.
const RESULTS = new Map(TOPICS.map(({ topic, title, text }) => {
  const structured = { topic, title, text, topics: TOPIC_LIST };
  const rendered = renderGuide(structured);
  const fits = Math.max(rendered.length, JSON.stringify(structured).length) <= PER_CHANNEL_RESULT_BUDGET;
  return [topic, fits ? { content: [{ type: 'text', text: rendered }], structuredContent: structured } : null];
}));

function guideTopic({ topic }) {
  const result = RESULTS.get(topic);
  if (!result) {
    throw new ToolError(`Topic ${topic} is too large for the result size limit (${PER_CHANNEL_RESULT_BUDGET} characters per channel).`,
      'The server\'s SGBR_RESULT_CHAR_CEILING is too low for this topic; whoever runs the server can raise it.');
  }
  return result;
}

export function registerGuideTool(server) {
  server.registerTool(
    GUIDE_TOOL_NAME,
    {
      title: GUIDE_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      // It serves a file shipped with the server and reaches no backend.
      annotations: { ...READ_ONLY_ANNOTATIONS, openWorldHint: false },
    },
    withTool(GUIDE_TOOL_NAME, 'Guide failed', async (args) => guideTopic(args)),
  );
}
