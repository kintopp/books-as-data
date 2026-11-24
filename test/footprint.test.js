// The token budget of what the server puts in front of a model before any call,
// by scripts/footprint.mjs's characters / 4 estimate, which needs no key and no
// network. The estimate undercounts JSON: run the script with ANTHROPIC_API_KEY
// for exact counts.
//
// How the budget could fail:
//   - the catalogue, one tool, or the instructions grow past their budget
//     without a commit that raises it and says why;
//   - the instructions grow past the 4,096 characters Claude Code keeps of
//     them, which would cut the source-text rule at their end;
//   - the measured catalogue includes output schemas, which hosts do not give
//     the model, so the budget measures the wrong thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient } from './helpers.js';
import { estimate, toApiTool } from '../scripts/footprint.mjs';

// About 10% above the estimate. Raise one only in a commit that says why.
const CATALOGUE_BUDGET = 14_500;
const TOOL_BUDGET = 3_700;
const INSTRUCTIONS_BUDGET_CHARS = 2_950;
const CLAUDE_CODE_INSTRUCTIONS_CHARS = 4_096;

test('the catalogue and the instructions stay within their budget', async (t) => {
  await withClient('ub-sgbr-footprint-budget', async (client) => {
    const { tools } = await client.listTools();
    const api = tools.map(toApiTool);

    await t.test('the measured definition is what a host gives the model', () => {
      for (const tool of api) assert.deepEqual(Object.keys(tool).sort(), ['description', 'input_schema', 'name'], tool.name);
    });

    await t.test('the whole catalogue', () => {
      const n = estimate(JSON.stringify(api));
      assert.ok(n <= CATALOGUE_BUDGET, `catalogue ${n} > ${CATALOGUE_BUDGET}`);
    });

    await t.test('each tool', () => {
      const over = api.map((x) => [x.name, estimate(JSON.stringify(x))]).filter(([, n]) => n > TOOL_BUDGET);
      assert.deepEqual(over, [], `over ${TOOL_BUDGET}`);
    });

    await t.test('the instructions', () => {
      const chars = (client.getInstructions() ?? '').length;
      assert.ok(chars > 0, 'no instructions');
      assert.ok(chars <= INSTRUCTIONS_BUDGET_CHARS, `instructions ${chars} > ${INSTRUCTIONS_BUDGET_CHARS} characters`);
      assert.ok(INSTRUCTIONS_BUDGET_CHARS <= CLAUDE_CODE_INSTRUCTIONS_CHARS,
        `the budget may not pass the ${CLAUDE_CODE_INSTRUCTIONS_CHARS} characters Claude Code keeps`);
    });
  });
});
