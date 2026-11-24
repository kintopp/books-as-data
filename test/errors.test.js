// Offline unit tests for error normalization.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError, formatErrorText } from '../src/lib/errors.js';

test('ToolError with a suggestion joins message and suggestion', () => {
  assert.equal(
    formatErrorText(new ToolError('No record found.', 'Check the id.')),
    'No record found. — Check the id.',
  );
});

test('ToolError without a suggestion returns just the message', () => {
  assert.equal(formatErrorText(new ToolError('Bad input.')), 'Bad input.');
});

test('a plain Error surfaces its message', () => {
  assert.equal(formatErrorText(new Error('boom')), 'boom');
});

test('a raw string passes through', () => {
  assert.equal(formatErrorText('just text'), 'just text');
});
