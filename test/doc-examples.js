// The argument fragments the docs and the tool descriptions show the model, for
// test/doc_examples.test.js. They write fragments, not whole calls: the docs as
// code spans (`filters: { genre: ["Hochschulschrift"] }`, `facet: "language",
// breakdown: "genre"`), the descriptions as prose (`facet="year"`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.js';
import { readSkillFiles } from '../scripts/build-skill.mjs';
import { DOC_PATH } from '../scripts/build-docs.mjs';

// A key is a lowercase snake_case word, then a colon AND whitespace. That rule
// is what keeps `title:Basel` (a deliberate example of wrong query syntax) and
// `Beschreibung: Bd. #` (a content_flags value) out.
const KEY = /(?:^|[{,]\s*)([a-z][a-z0-9_]*):\s/g;
const FRAGMENT_START = /^\{?\s*[a-z][a-z0-9_]*:\s/;
// The prose form: one `key="value"` pair, outside code spans.
const PROSE_PAIR = /(?<![\w.-])([a-z][a-z0-9_]*)="([^"]*)"/g;

/** The Markdown sources, as [{ source, text }], with docs/tools.md's generated blocks cut. */
export function readDocSources() {
  const skill = readSkillFiles()
    .filter((file) => file.name.endsWith('.md'))
    .map((file) => ({ source: join('skill', file.name), text: file.content }));
  const scenarios = join('docs', 'research-scenarios.md');
  const guide = join('src', 'guide.md');
  return [
    ...skill,
    { source: guide, text: readFileSync(join(ROOT, guide), 'utf8') },
    { source: scenarios, text: readFileSync(join(ROOT, scenarios), 'utf8') },
    // The generated blocks render the descriptions, which wireSources reads from the wire.
    {
      source: join('docs', 'tools.md'),
      text: readFileSync(DOC_PATH, 'utf8').replace(/<!-- generated:[\s\S]*?<!-- \/generated -->/g, ''),
    },
  ];
}

/** The model-facing text of a live listTools() plus the instructions, as [{ source, text }]. */
export function wireSources(tools, instructions) {
  const out = [{ source: 'instructions', text: instructions ?? '' }];
  const walk = (node, source) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, source)); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.description === 'string') out.push({ source, text: node.description });
    for (const [k, v] of Object.entries(node)) if (k !== 'description') walk(v, source);
  };
  for (const t of tools) {
    out.push({ source: t.name, text: t.description ?? '' });
    walk(t.inputSchema, `${t.name} input`);
    walk(t.outputSchema, `${t.name} output`);
  }
  return out;
}

// Bare keys quoted, so a fragment in JSON values parses as JSON.
const quoteKeys = (s) => s.replace(KEY, (m, key) => m.replace(`${key}:`, `"${key}":`));

/**
 * Every fragment in the sources, as { source, span, keys, args }. `args` is
 * the parsed argument object when every value is JSON (a checked fragment),
 * else null: a bare word (`object_type: foldout`) or a placeholder
 * (`filters: { author: [...] }`) has only its keys checked. `keys` holds
 * every key, outer and inner.
 */
export function extractFragments(sources) {
  const fragments = [];
  for (const { source, text } of sources) {
    // A fenced block's backticks would pair with the inline spans around it.
    // Markdown reads a line break inside a span as a space.
    const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/\n\s*/g, ' ');
    const spans = [...prose.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    for (const span of spans.filter((x) => FRAGMENT_START.test(x))) {
      const body = span.startsWith('{') ? span : `{${span}}`;
      let args = null;
      try { args = JSON.parse(quoteKeys(body)); } catch { /* keys only */ }
      const keys = args ? objectKeys(args) : [...body.matchAll(KEY)].map((m) => m[1]);
      fragments.push({ source, span, keys, args });
    }
    // HTML attributes (`<img width="75%">`) share the prose form.
    const outside = prose.replace(/`[^`]+`/g, ' ').replace(/<[a-z][^>]*>/gi, ' ');
    for (const [span, key, value] of outside.matchAll(PROSE_PAIR)) {
      fragments.push({ source, span, keys: [key], args: { [key]: value } });
    }
  }
  return fragments;
}

function objectKeys(node) {
  if (Array.isArray(node) || !node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => [k, ...objectKeys(v)]);
}

/** Every `sgbr_x` tool name the sources mention, as { source, name }. */
export function extractMentions(sources) {
  return sources.flatMap(({ source, text }) => [...text.matchAll(/\bsgbr_[a-z_]+/g)]
    .map((m) => ({ source, name: m[0].replace(/_+$/, '') })));
}

// ── the checks, over a live listTools() ──────────────────────────────────────

const DIMENSION_PARENTS = ['filters', 'exclude'];

function propertyNames(node) {
  if (Array.isArray(node)) return node.flatMap(propertyNames);
  if (!node || typeof node !== 'object') return [];
  const own = node.properties && typeof node.properties === 'object' ? Object.keys(node.properties) : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
}

/**
 * What the wire accepts, keyed for the checks: `inputs` maps a top-level input
 * property to the tools' input schemas that take it, with `required` dropped so
 * one property can be checked alone, `dimensions` maps a
 * `filters`/`exclude` property to its property schemas, `outputs` holds every
 * property name at any depth of any output schema.
 */
export function schemaIndex(tools) {
  const inputs = new Map();
  const dimensions = new Map();
  const add = (map, key, schema) => map.set(key, [...(map.get(key) ?? []), schema]);
  for (const t of tools) {
    const props = t.inputSchema?.properties ?? {};
    // One object per tool: Ajv caches a compiled schema by object identity.
    const optional = { ...t.inputSchema };
    delete optional.required;
    for (const key of Object.keys(props)) add(inputs, key, optional);
    for (const parent of DIMENSION_PARENTS) {
      for (const [key, schema] of Object.entries(props[parent]?.properties ?? {})) add(dimensions, key, schema);
    }
  }
  return { inputs, dimensions, outputs: new Set(tools.flatMap((t) => propertyNames(t.outputSchema))) };
}

/** Each fragment key no tool takes or returns, as "source: key in span". */
export function unknownKeys(fragments, index) {
  return fragments.flatMap((f) => f.keys
    .filter((k) => !index.inputs.has(k) && !index.dimensions.has(k) && !index.outputs.has(k))
    .map((k) => `${f.source}: ${k} in \`${f.span}\``));
}

/**
 * Each checked value every applicable schema refuses, as "source: span — error".
 * A top-level input is checked against the input schemas that take it; a
 * dimension written without its `filters:` wrapper against that dimension's own
 * schema. An output-only key describes a result, not an argument, so it is not
 * checked.
 */
export function rejectedValues(fragments, index, validator) {
  const accepts = (schema, value) => validator.getValidator(schema)(value);
  const failures = [];
  for (const f of fragments.filter((x) => x.args)) {
    for (const [key, value] of Object.entries(f.args)) {
      const results = [
        ...(index.inputs.get(key) ?? []).map((s) => accepts(s, { [key]: value })),
        ...(index.dimensions.get(key) ?? []).map((s) => accepts(s, value)),
      ];
      if (!results.length) continue;
      if (!results.some((r) => r.valid)) failures.push(`${f.source}: \`${f.span}\` — ${results[0].errorMessage}`);
    }
  }
  return failures;
}

/** The distinct (dimension, value) pairs of every checked dimension fragment. */
export function vocabularyPairs(fragments, index) {
  const pairs = new Map();
  const addAll = (dimension, values) => {
    if (!Array.isArray(values)) return;
    for (const value of values.filter((v) => typeof v === 'string')) pairs.set(`${dimension}\u0000${value}`, { dimension, value });
  };
  for (const f of fragments.filter((x) => x.args)) {
    for (const [key, value] of Object.entries(f.args)) {
      if (DIMENSION_PARENTS.includes(key) && value && typeof value === 'object') {
        for (const [dimension, values] of Object.entries(value)) addAll(dimension, values);
      } else if (index.dimensions.has(key) && !index.inputs.has(key)) {
        addAll(key, value);
      }
    }
  }
  return [...pairs.values()];
}
