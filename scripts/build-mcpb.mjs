#!/usr/bin/env node
// Build a FAT .mcpb bundle (source + production node_modules, no dev deps).
//
// Why stage instead of `mcpb pack .`: the repo's own node_modules carries
// devDependencies (eslint, @modelcontextprotocol/client, …) and the tree also
// holds test/, research/, scripts/ — none of which belong in the shipped bundle.
// So we assemble a clean payload in a temp dir, run a production-only install
// there, then pack that. Non-destructive: the repo's node_modules is never touched.
//
// Usage: npm run build:mcpb   →   dist/books-as-data.mcpb

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const output = join(distDir, 'books-as-data.mcpb');

// Prefer the repo's own devDependency copy of the mcpb CLI (installed by
// `npm ci`), falling back to a PATH-installed one. Either way, a missing binary
// gets an actionable message instead of a raw ENOENT.
const localMcpb = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb');
const mcpbBin = existsSync(localMcpb) ? localMcpb : 'mcpb';

// What the server needs at runtime — deliberately excludes test/, research/,
// scripts/, .git, and the dev-laden repo node_modules. package.json must ride
// along so Node resolves src/*.js as ESM ("type":"module"); the lockfile makes
// the production install reproducible.
const PAYLOAD_FILES = ['manifest.json', 'package.json', 'package-lock.json'];
const PAYLOAD_DIRS = ['src'];
// The HTTP entry imports an optionalDependency, which the install below omits.
const PAYLOAD_EXCLUDE = ['src/http.js'];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const runMcpb = (args, cwd) => {
  try {
    run(mcpbBin, args, cwd);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.error(
        '✖ The `mcpb` CLI was not found. Run `npm ci` first — it is a devDependency ' +
        '(@anthropic-ai/mcpb) — or install it globally with `npm i -g @anthropic-ai/mcpb`.',
      );
      process.exit(1);
    }
    throw err;
  }
};

// Skip OS metadata (.DS_Store, Thumbs.db) so the staged payload — and thus the
// packed bundle — is deterministic regardless of local cruft in the source tree.
const OS_CRUFT = new Set(['.DS_Store', 'Thumbs.db']);
const notOsCruft = (src) => !OS_CRUFT.has(basename(src));
const shipped = (src) => notOsCruft(src) && !PAYLOAD_EXCLUDE.includes(relative(root, src).split(sep).join('/'));

const staging = mkdtempSync(join(tmpdir(), 'books-as-data-mcpb-'));
try {
  for (const f of PAYLOAD_FILES) cpSync(join(root, f), join(staging, f));
  for (const d of PAYLOAD_DIRS) cpSync(join(root, d), join(staging, d), { recursive: true, filter: shipped });

  // manifest.json carries no version of its own; package.json is the one source.
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifestPath = join(staging, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

  // Production-only install → fat bundle without devDependencies.
  //
  // `--omit=optional` too: @modelcontextprotocol/client is an optionalDependency
  // (needed only by scripts/cli.mjs, the headless CLI — which this payload does
  // not ship, since PAYLOAD_DIRS excludes scripts/). It is optional rather than
  // dev so an INSTALLED `bbad` bin can resolve it; omitting it here keeps the
  // bundle to what the stdio server actually loads, sparing ~7 MB and the client's
  // own transitive deps (jose, eventsource, pkce-challenge, cross-spawn) that
  // would otherwise ride into the Desktop bundle's supply chain for nothing.
  run('npm', ['ci', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], staging);

  runMcpb(['validate', 'manifest.json'], staging);
  mkdirSync(distDir, { recursive: true });
  runMcpb(['pack', '.', output], staging);

  console.error(`\n✔ Built ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
