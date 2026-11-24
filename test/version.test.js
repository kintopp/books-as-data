// package.json is the one hand-edited version: src/config.js imports it, and the
// build scripts stamp it into the .mcpb manifest and SKILL.md. The lockfile
// is npm's own copy, rewritten by `npm version` / `npm install` but never from a
// hand-edited package.json — hence the check below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERVER_VERSION } from '../src/config.js';

const read = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));

// Bump with `npm version <x.y.z> --no-git-tag-version`, which rewrites both.
test('package-lock.json versions agree (top-level and root package entry)', () => {
  const lock = read('package-lock.json');
  assert.equal(lock.version, SERVER_VERSION, 'package-lock.json version must match SERVER_VERSION');
  assert.equal(lock.packages[''].version, SERVER_VERSION,
    'package-lock.json root package entry must match SERVER_VERSION');
});
