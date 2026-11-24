#!/usr/bin/env node
// Token footprint: what the server puts in front of a model before any call,
// measured over stdio without running a model or calling a tool. Counts the tool
// catalogue as a host hands it over (name, description, input schema), the
// one-line leads that hosts loading tools on demand show first, each tool's
// share, the instructions, the skill (SKILL.md frontmatter and body), and each
// topic of sgbr_guide. Exact counts come from Anthropic's free token-counting endpoint
// when ANTHROPIC_API_KEY is set (in the environment, the project's .env, or
// ~/.env); otherwise characters / 4, which undercounts JSON.
//
//   node scripts/footprint.mjs [--model <id>] [--estimate] [--json]
//
// --estimate skips the endpoint, as test/footprint.test.js does.

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { frontmatter, readSkillFiles } from './build-skill.mjs';
import { parseGuide } from '../src/lib/guide.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The server is only listed, never called; a dead endpoint makes any request it
// sends anyway fail at once instead of reaching the library's servers.
const DEAD = 'http://127.0.0.1:9';
const SERVER_ENV = {
  SGBR_GRAPHQL_ENDPOINT: DEAD,
  SGBR_FULLTEXT_ENDPOINT: DEAD,
  SGBR_IMAGE_ENDPOINT: DEAD,
  SGBR_OCR_ENDPOINT: DEAD,
};

/** The estimate the budget test uses: characters / 4, rounded up. */
export const estimate = (text) => Math.ceil(text.length / 4);

/** A tool as the Messages API takes it: what a host gives the model, without the output schema. */
export const toApiTool = (t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema });

// Up to the first ". ", the sentence the gloss budget in test/smoke.test.js checks.
const lead = (d = '') => (d.includes('. ') ? d.slice(0, d.indexOf('. ') + 1) : d);

function parseArgs(argv) {
  const opts = { model: 'claude-opus-5-5', estimate: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--model': opts.model = argv[++i]; break;
      case '--estimate': opts.estimate = true; break;
      case '--json': opts.json = true; break;
      default: console.error(`Unknown flag: ${argv[i]}`); process.exit(2);
    }
  }
  return opts;
}

function loadEnv() {
  if (process.env.ANTHROPIC_API_KEY) return;
  for (const file of [join(ROOT, '.env'), join(homedir(), '.env')]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // absent
    }
    if (process.env.ANTHROPIC_API_KEY) return;
  }
}

// Exact counts are differences against a request with one short message and no
// tools, so they exclude the request's framing. A catalogue count includes the
// tool-use preamble the API adds once tools exist; each tool's share is the
// catalogue minus the catalogue without it, which does not.
function makeCounter(model, estimateOnly) {
  const key = !estimateOnly && process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { exact: false, text: async (t) => estimate(t), tools: async (tools) => estimate(JSON.stringify(tools)) };
  }
  const raw = async (body) => {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '.' }], ...body }),
    });
    if (!res.ok) throw new Error(`count_tokens ${res.status}: ${await res.text()}`);
    return (await res.json()).input_tokens;
  };
  let baseline;
  const diff = async (body) => (await raw(body)) - await (baseline ??= raw({}));
  return {
    exact: true,
    text: (t) => diff({ messages: [{ role: 'user', content: t || '.' }] }),
    tools: (tools) => diff({ tools }),
  };
}

function skillParts() {
  const [skill] = readSkillFiles();
  const front = frontmatter(skill.content);
  return [
    { label: 'SKILL.md frontmatter (always loaded)', text: front },
    { label: 'SKILL.md body (loaded when the skill triggers)', text: skill.content.slice(front.length) },
  ];
}

async function measure(count) {
  const env = { ...process.env, ...SERVER_ENV };
  delete env.SGBR_ACCESS_TOKEN;
  const client = new Client({ name: 'ub-sgbr-footprint', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(ROOT, 'src', 'index.js')], env, stderr: 'ignore',
  }));
  try {
    const { tools } = await client.listTools();
    const api = tools.map(toApiTool);
    const instructions = client.getInstructions() ?? '';
    const full = await count.tools(api);
    const perTool = await Promise.all(api.map(async (t) => ({
      name: t.name,
      tokens: full - await count.tools(api.filter((x) => x !== t)),
      description: await count.text(t.description),
    })));
    return {
      catalogue: {
        tools: tools.length,
        full,
        leads: await count.text(tools.map((t) => `${t.name}: ${lead(t.description)}`).join('\n')),
        descriptions: perTool.reduce((s, t) => s + t.description, 0),
      },
      perTool: perTool.sort((a, b) => b.tokens - a.tokens),
      instructions: { chars: instructions.length, tokens: await count.text(instructions) },
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.estimate) loadEnv();
  const count = makeCounter(opts.model, opts.estimate);
  const server = await measure(count);
  const skill = await Promise.all(skillParts().map(async ({ label, text }) => ({ label, tokens: await count.text(text) })));
  const topics = parseGuide(readFileSync(join(ROOT, 'src', 'guide.md'), 'utf8'));
  const guide = await Promise.all(topics.map(async ({ topic, text }) => ({ topic, tokens: await count.text(text) })));
  const report = { model: count.exact ? opts.model : undefined, exact: count.exact, ...server, skill, guide };
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const n = (x) => x.toLocaleString('en-US').padStart(7);
  console.log(count.exact ? `Tokens, counted for ${opts.model}` : 'Tokens, ESTIMATED as characters / 4 (set ANTHROPIC_API_KEY for exact counts)');
  const c = report.catalogue;
  console.log('\nTool catalogue');
  console.log(`  ${n(c.full)}  all ${c.tools} tools, full definitions${count.exact ? ', with the API\'s tool-use preamble' : ''}`);
  console.log(`  ${n(c.descriptions)}  of which descriptions, counted as text (the rest is input schemas and framing)`);
  console.log(`  ${n(c.leads)}  names and first sentences only, as hosts that load tools on demand show them`);
  console.log('\nPer tool (the catalogue minus the catalogue without it)');
  for (const t of report.perTool) console.log(`  ${n(t.tokens)}  ${t.name}  (description ${t.description})`);
  console.log(`\nInstructions\n  ${n(report.instructions.tokens)}  ${report.instructions.chars} characters`);
  console.log('\nSkill');
  for (const s of report.skill) console.log(`  ${n(s.tokens)}  ${s.label}`);
  console.log('\nGuide (one topic per sgbr_guide call, loaded on demand)');
  for (const g of report.guide) console.log(`  ${n(g.tokens)}  ${g.topic}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
