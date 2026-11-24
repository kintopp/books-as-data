#!/usr/bin/env node
// Proves the PACKED ARTIFACT works: npm pack → install into a throwaway dir with
// production deps only → run both shipped bins for real.
//
// Deliberately NOT part of `npm test`: it resolves @modelcontextprotocol/* from
// the registry, which would break the "npm test is OFFLINE" invariant CLAUDE.md
// states. It runs as its own CI job instead. test/packaging.test.js pins the same
// drift class statically and stays — it fails earlier and cheaper; this is the
// part a static proxy cannot do, namely show that the tarball installs and runs.
//
// Usage: node scripts/pack-smoke.mjs   (exit 0 = the deliverable is sound)

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// The bins come from package.json, not from literals here — the same source
// test/packaging.test.js derives them from. A bin added or renamed there is then
// covered by the ship/link checks below automatically, rather than silently
// dropping out of the install-and-launch proof.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const BINS = Object.entries(pkg.bin ?? {});
// Compared as sorted sets, not sequences: `bbad tools` lists in its own verb order,
// and wire order is already pinned against manifest.json by test/cache_hints.test.js.
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const MANIFEST_TOOLS = manifest.tools.map((t) => t.name).sort();

let failures = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ✔ ${label}`);
  } catch (err) {
    failures++;
    console.error(`  ✖ ${label}\n      ${err.message.split('\n').slice(0, 6).join('\n      ')}`);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const work = mkdtempSync(join(tmpdir(), 'sgbr-pack-'));
console.log(`workdir: ${work}`);

try {
  // ── pack ───────────────────────────────────────────────────────────────────
  console.log('\npacking…');
  const packed = JSON.parse(
    execFileSync(npm, ['pack', '--json', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8' }),
  );
  const tarball = join(work, packed[0].filename);
  const shipped = packed[0].files.map((f) => f.path);
  console.log(`  ${packed[0].filename} (${shipped.length} files, ${Math.round(packed[0].size / 1024)} KB)`);

  await check(`the tarball ships all ${BINS.length} bin targets`, () => {
    for (const [name, entry] of BINS) {
      const rel = entry.replace(/^\.\//, '');
      assert(shipped.includes(rel), `${rel} (bin ${name}) missing from the tarball`);
    }
  });
  await check('the tarball ships no test or dev files', () => {
    const stray = shipped.filter((f) => f.startsWith('test/') || f.endsWith('.test.js'));
    assert(stray.length === 0, `unexpected files shipped: ${stray.join(', ')}`);
  });

  // ── install as a consumer would ────────────────────────────────────────────
  console.log('\ninstalling (production deps only)…');
  const app = join(work, 'app');
  mkdirSync(app, { recursive: true });
  execFileSync(npm, ['init', '-y'], { cwd: app, stdio: 'ignore' });
  // --omit=dev is what a real consumer install does; optionalDependencies are
  // deliberately NOT omitted, because that is how `bbad` gets its client.
  execFileSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', tarball], {
    cwd: app, stdio: 'inherit', timeout: 300000,
  });

  const binDir = join(app, 'node_modules', '.bin');
  await check('every declared bin is linked into node_modules/.bin', () => {
    const linked = readdirSync(binDir);
    for (const [name] of BINS) assert(linked.includes(name), `${name} not linked`);
  });

  await check('the optional client IS installed (the bin depends on it)', () => {
    assert(
      existsSync(join(app, 'node_modules', '@modelcontextprotocol', 'client')),
      '@modelcontextprotocol/client absent — bbad would die with ERR_MODULE_NOT_FOUND',
    );
  });

  // ── run the shipped bins ───────────────────────────────────────────────────
  console.log('\nrunning the shipped bins…');

  await check('bbad --help runs from the installed package', () => {
    const out = execFileSync(join(binDir, 'bbad'), ['--help'], { cwd: app, encoding: 'utf8', timeout: 60000 });
    assert(/Usage: bbad/.test(out), 'help banner missing');
  });

  // The real proof for the CLI: `tools` spawns the server over stdio and drives a
  // genuine MCP handshake, so it exercises BOTH bins and the optional client.
  await check('bbad tools --json completes a real MCP handshake against the shipped server', () => {
    const out = execFileSync(join(binDir, 'bbad'), ['tools', '--json'], {
      cwd: app, encoding: 'utf8', timeout: 120000,
    });
    const tools = JSON.parse(out);
    assert(Array.isArray(tools), 'tools --json did not print an array');
    const shippedTools = tools.map((t) => t.name).sort();
    assert(JSON.stringify(shippedTools) === JSON.stringify(MANIFEST_TOOLS),
      `shipped tools [${shippedTools}] differ from manifest.json [${MANIFEST_TOOLS}]`);
  });

  await check('ub-sgbr-mcp answers a raw JSON-RPC initialize', async () => {
    const res = await initializeOverStdio(join(binDir, 'ub-sgbr-mcp'), app);
    assert(res?.result?.serverInfo?.name, 'no serverInfo in the initialize result');
    assert(res.result.capabilities?.tools, 'the server did not advertise tool capability');
  });

  // ── the Desktop bundle's payload boundary ──────────────────────────────────
  // This is the precondition that makes @modelcontextprotocol/client safe as an
  // optionalDependency: the bundle ships src/ and NEVER scripts/, so its
  // --omit=optional install cannot leave a shipped entrypoint unresolvable.
  // test/packaging.test.js pins it statically; this reads the real archive.
  const bundle = join(ROOT, 'dist', 'books-as-data.mcpb');
  if (existsSync(bundle)) {
    await check('the .mcpb payload contains src/ but never scripts/ or src/http.js', () => {
      const listing = execFileSync('unzip', ['-Z1', bundle], { encoding: 'utf8' });
      const entries = listing.split('\n').filter(Boolean);
      assert(entries.some((e) => e.startsWith('src/')), 'no src/ in the bundle payload');
      assert(!entries.some((e) => e.startsWith('scripts/')),
        'scripts/ leaked into the bundle — the optionalDependency is no longer safe to omit');
      assert(!entries.includes('src/http.js'),
        'src/http.js leaked into the bundle — it imports an optionalDependency the bundle omits');
    });
  } else {
    console.log('  – .mcpb payload check skipped (run `npm run build:mcpb` first)');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

// Speak JSON-RPC to the server directly — no client library — so this half of the
// proof does not depend on the optional dependency the CLI needs.
function initializeOverStdio(bin, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    // A crash on startup must surface its stderr, not a bare 30 s timeout.
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-4096); });
    // After a successful resolve the exit from child.kill() lands here as a no-op.
    const fail = (why) => { clearTimeout(timer); rejectPromise(new Error(`${why}:\n${stderrTail}`)); };
    const timer = setTimeout(() => { child.kill(); fail('server did not answer in 30s'); }, 30000);
    child.once('exit', (code, sig) => fail(`server exited (${code ?? sig}) before answering`));
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      // Line-delimited JSON-RPC: take the first complete line that parses.
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            clearTimeout(timer);
            child.kill();
            resolvePromise(msg);
            return;
          }
        } catch { /* partial line — wait for more */ }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); rejectPromise(e); });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pack-smoke', version: '0.0.0' },
      },
    })}\n`);
  });
}
