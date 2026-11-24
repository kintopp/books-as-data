// Packaging invariants for what `npm pack` actually ships.
//
// The drift class this pins: a shipped entrypoint importing a package that is
// only a devDependency — fine in the dev checkout, ERR_MODULE_NOT_FOUND in every
// real install, because npm installs a dependency's devDependencies for nobody.
// That is why @modelcontextprotocol/client is an optionalDependency: installed
// by default so `bbad` resolves, while build-mcpb.mjs passes `--omit=optional`
// to keep it out of the Desktop bundle (which ships only src/, never scripts/).
// Do not "tidy" it back into devDependencies.
//
// The walk starts from each `bin` target and follows the real import graph
// rather than spot-checking one file, so it also fails if src/ ever starts
// importing a devDependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

// Matches `import 'x'`, `import(…'x')`, and `… from 'x'` — enough for this
// repo's plain ESM (no bundler, no transpile step, no import assertions).
const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;

// '@scope/name/sub' → '@scope/name'; 'name/sub' → 'name'.
const packageName = (spec) => (spec.startsWith('@')
  ? spec.split('/').slice(0, 2).join('/')
  : spec.split('/')[0]);

// Walk the static import graph from `entry`, following RELATIVE imports inside
// the repo, and return the set of bare package names reached. `node:` builtins
// are always available, so they are not dependencies to declare.
function externalDeps(entry) {
  const seen = new Set();
  const external = new Set();
  const queue = [resolve(ROOT, entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(SPECIFIER)) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        queue.push(resolve(dirname(file), spec));
        continue;
      }
      // Ignore anything that isn't specifier-shaped (a stray prose match from a
      // comment); real specifiers never contain whitespace.
      if (/\s/.test(spec)) continue;
      external.add(packageName(spec));
    }
  }
  return { external, files: seen };
}

// Everything a consumer gets on `npm install`: devDependencies are explicitly NOT
// installed for a dependency, which is the whole point of this test.
const installable = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);
const devOnly = new Set(Object.keys(pkg.devDependencies ?? {}));

test('every bin target imports only packages a consumer install provides', () => {
  const bins = Object.entries(pkg.bin ?? {});
  assert.ok(bins.length, 'package.json must declare at least one bin');
  for (const [binName, entry] of bins) {
    const { external } = externalDeps(entry);
    for (const dep of external) {
      assert.ok(
        installable.has(dep),
        `bin "${binName}" (${entry}) imports "${dep}", which is not in dependencies or `
        + `optionalDependencies${devOnly.has(dep) ? ' — it is a devDependency, so an installed '
          + 'bin cannot resolve it (move it to dependencies or optionalDependencies)' : ''}`,
      );
    }
  }
});

test('every bin target is actually shipped by the `files` allowlist', () => {
  // A bin that `files` excludes is a dangling entry: npm links it on install and
  // the target isn't there. `files` entries are paths or directory prefixes.
  const shipped = (pkg.files ?? []).map((f) => f.replace(/\/$/, ''));
  for (const [binName, entry] of Object.entries(pkg.bin ?? {})) {
    const rel = relative(ROOT, resolve(ROOT, entry));
    assert.ok(
      shipped.some((f) => rel === f || rel.startsWith(`${f}/`)),
      `bin "${binName}" points at ${rel}, which no "files" entry ships (${shipped.join(', ')})`,
    );
  }
});

// The server and the CLI have deliberately different dependency footprints: the
// stdio server must stay installable from `dependencies` alone, because that is
// what the MCPB bundle's `npm ci --omit=dev --omit=optional` gives it.
test('the server entrypoint needs no optionalDependency', () => {
  const { external } = externalDeps('src/index.js');
  const required = new Set(Object.keys(pkg.dependencies ?? {}));
  const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  for (const dep of external) {
    assert.ok(required.has(dep),
      `src/index.js imports "${dep}", which must be a plain dependency (the .mcpb bundle omits dev and optional)`);
    assert.ok(!optional.has(dep),
      `src/index.js imports "${dep}" from optionalDependencies — the .mcpb bundle omits those, so the server would not start`);
  }
});

// The bundle ships every file under src/ except PAYLOAD_EXCLUDE, and none of them
// may reach an optionalDependency, which its install omits: src/http.js (the HTTP
// entry's @modelcontextprotocol/node) is shipped by npm but kept out of the bundle.
test('no file the mcpb bundle ships reaches an optionalDependency', () => {
  const build = readFileSync(resolve(ROOT, 'scripts/build-mcpb.mjs'), 'utf8');
  const exclude = [...(build.match(/const PAYLOAD_EXCLUDE = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  const files = readdirSync(resolve(ROOT, 'src'), { recursive: true })
    .filter((f) => f.endsWith('.js')).map((f) => `src/${f.split(sep).join('/')}`);
  assert.ok(files.includes('src/http.js'), 'the walk must see the HTTP entry');
  for (const file of files.filter((f) => !exclude.includes(f))) {
    for (const dep of externalDeps(file).external) {
      assert.ok(!optional.has(dep), `${file} reaches optionalDependency "${dep}" but the .mcpb bundle ships it; add it to PAYLOAD_EXCLUDE`);
    }
  }
});

// Pins the reason the client can be optional at all: the bundle payload excludes
// scripts/, so nothing in it imports the client. If PAYLOAD_DIRS ever grew to
// include scripts/, `--omit=optional` would start shipping a broken CLI.
test('the mcpb build omits optional deps and ships no scripts/ payload', () => {
  const build = readFileSync(resolve(ROOT, 'scripts/build-mcpb.mjs'), 'utf8');
  assert.match(build, /--omit=optional/,
    'build-mcpb.mjs must pass --omit=optional so the CLI-only client stays out of the bundle');
  const payloadDirs = build.match(/const PAYLOAD_DIRS = \[([^\]]*)\]/)?.[1] ?? '';
  assert.ok(!payloadDirs.includes('scripts'),
    'the bundle payload must not ship scripts/ while optional deps are omitted (the CLI would be unloadable)');
});
