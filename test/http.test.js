// The Streamable HTTP entry (src/http.js), spawned on a free port and spoken to with raw fetch:
// the SDK client cannot speak the 2026-07-28 wire. The backend is a loopback stub
// (stub-backend.js#startStubServer), so the suite stays offline.
//
// How it could fail:
// - it starts with SGBR_ACCESS_TOKEN set, or its refusal quotes the token
// - the MCP endpoint answers on a path other than /mcp, or another path answers anything but 404
// - /health is closed or checks the Host
// - it lists other tools than stdio, or a tool call fails on either protocol revision
// - its backend requests are not tagged `(http)` in the User-Agent
// - a foreign or malformed Origin passes, or claude.ai or Origin: null is refused; with a
//   configured host or RAILWAY_PUBLIC_DOMAIN a foreign Host passes
// - a bad allowlist entry starts a server that refuses every request, instead of exiting with its name
// - the wall-clock guard exceeds Claude's 240 s per call, or cuts a default request's retries short
// - GET or DELETE on the endpoint is not 405; a body over 1 MiB is not 413; a compressed body is decoded
// - a slow call is not cut at the wall-clock guard, or keeps reaching the backend after it; the request
//   over the in-flight limit is not 503; a 2025 SSE answer holds back its headers until the tool is done
// - importing the stdio server reads the HTTP entry's env
// - a call is not logged, a log line has no level or a failure no error_type, or it holds the
//   input or an error that quotes it
// - SIGTERM drops a call in flight

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { join } from 'node:path';
import { ENVELOPE, MODERN_VERSION, ROOT, withClient } from './helpers.js';
import { makeRouter, startStubServer } from './stub-backend.js';

const HTTP_ENTRY = join(ROOT, 'src', 'http.js');
const LEGACY = '2025-06-18';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const ocr = { 'text:1': 'Seite 1 in Basel', 'text:2': 'Seite 2 in Basel' };
let fast, slow;
before(async () => {
  // An unknown id is an empty result, which the handler refuses by quoting the id.
  fast = await startStubServer(makeRouter({ ocr, graphql: { Get: { get: { id: '', result: [] } } } }));
  slow = await startStubServer(makeRouter({ ocr }), { delayMs: 1000 });
});
after(async () => { await fast?.close(); await slow?.close(); });

// A distinct scan id per call, so no response cache answers a call the test needs to reach the backend.
let scans = 0;
const locateArgs = () => ({ phrase: 'in Basel', engine: 'page_scan', scan_id: `HTTPTEST-${++scans}`, start_page: 1, max_pages: 3 });

// Nothing inherited may reach the child: the default endpoints are production.
const INHERITED = /^(SGBR_|MCP_ALLOWED_|RAILWAY_)|^PORT$/;
function childEnv(env, backend) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k)));
  return { ...base, PORT: '0', ...backend.env, ...env };
}

// Spawns src/http.js on a free port, resolved once it prints its listening line.
async function boot(env = {}, backend = fast) {
  const child = spawn(process.execPath, [HTTP_ENTRY], { cwd: ROOT, env: childEnv(env, backend), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const exited = once(child, 'exit');
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in 10 s; stderr: ${stderr}`)), 10_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const m = /listening on (http:\/\/[^"\s]+)/.exec(stderr);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`server exited early; stderr: ${stderr}`)); });
  });
  return {
    url,
    mcp: `${url}/mcp`,
    child,
    stderr: () => stderr,
    lines: () => stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)),
    exited: exited.then(([code]) => code),
    stop: async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; },
  };
}

async function withServer(env, fn, backend) {
  const server = await boot(env, backend);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

// A child expected to refuse to start; resolves with its exit code and stderr.
async function refusal(env) {
  const child = spawn(process.execPath, [HTTP_ENTRY], { cwd: ROOT, env: childEnv(env, fast), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // A server that starts anyway is killed, so the test fails instead of hanging.
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  const error = stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).find((l) => l.level === 'error');
  return { code, stderr, error };
}

const parseBody = (text) => { try { return JSON.parse(text.replace(/^event:.*\ndata: /m, '')); } catch { return null; } };

async function post(server, headers, body, url = server.mcp) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: parseBody(await res.text()) };
}

const modern = (server, method, params = {}, name, headers = {}) => post(server,
  { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': method, ...(name && { 'mcp-name': name }), ...headers },
  { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } });
const call = (server, name, args) => modern(server, 'tools/call', { name, arguments: args }, name);
const legacy = (server, method, params = {}) => post(server, { 'mcp-protocol-version': LEGACY },
  { jsonrpc: '2.0', id: 2, method, params });

// A raw request: fetch() forbids setting Host.
const statusWithHost = (server, host) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } });
  const req = request(server.mcp, {
    method: 'POST',
    headers: { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list', host, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) },
  }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject);
  req.end(body);
});

test('it refuses to start with SGBR_ACCESS_TOKEN set, and never quotes the token', async () => {
  const { code, stderr, error } = await refusal({ SGBR_ACCESS_TOKEN: 'token-marker-4711' });
  assert.equal(code, 1, stderr);
  assert.doesNotMatch(stderr, /listening on/);
  assert.match(error?.msg ?? '', /^SGBR_ACCESS_TOKEN is set: the HTTP entry serves anonymous access only/);
  assert.doesNotMatch(stderr, /token-marker-4711/);
});

test('only /mcp is the endpoint; every other path is 404', async () => {
  await withServer({}, async (server) => {
    const init = { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 't', version: '0' } };
    const rpc = { jsonrpc: '2.0', id: 1, method: 'initialize', params: init };
    const ok = await post(server, { 'mcp-protocol-version': LEGACY }, rpc);
    assert.equal(ok.status, 200);
    assert.equal(ok.body?.result?.serverInfo?.name, 'books-as-data');
    for (const path of ['/', '/mcp/', '/MCP', '/mcp/x', '/a/mcp']) {
      const res = await post(server, { 'mcp-protocol-version': LEGACY }, rpc, `${server.url}${path}`);
      assert.equal(res.status, 404, path);
    }
  });
});

test('/health is public and reports the version and commit', async () => {
  await withServer({ RAILWAY_GIT_COMMIT_SHA: 'abc123', MCP_ALLOWED_HOSTS: 'mcp.example.org' }, async (server) => {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.status, 'ok');
    assert.equal(body.server, 'books-as-data');
    assert.match(body.version, /^\d+\.\d+\.\d+/);
    assert.equal(body.commit, 'abc123');
    assert.match(body.node, /^v24\./);
    assert.equal((await fetch(`${server.url}/health`, { method: 'POST' })).status, 404);
  });
});

test('both protocol revisions list the tools of the stdio server and call one', async () => {
  const stdio = await withClient('http-compare', async (client) => (await client.listTools()).tools.map((t) => t.name).sort(),
    { env: fast.env });
  await withServer({}, async (server) => {
    assert.deepEqual((await legacy(server, 'tools/list')).body.result.tools.map((t) => t.name).sort(), stdio);
    const old = await legacy(server, 'tools/call', { name: 'sgbr_locate_text', arguments: locateArgs() });
    assert.equal(old.status, 200);
    assert.equal(old.body?.result?.isError, undefined, JSON.stringify(old.body));
    assert.equal(old.body.result.structuredContent.hits.length, 2);

    const list = await modern(server, 'tools/list');
    assert.match(list.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), stdio);
    const now = await call(server, 'sgbr_locate_text', locateArgs());
    assert.equal(now.body?.result?.structuredContent?.hits?.length, 2, JSON.stringify(now.body));
  });
});

test('every backend request carries the http entry point in its User-Agent', async () => {
  const backend = await startStubServer(makeRouter({ ocr }));
  try {
    await withServer({}, async (server) => {
      const res = await call(server, 'sgbr_locate_text', locateArgs());
      assert.equal(res.body?.result?.isError, undefined, JSON.stringify(res.body));
    }, backend);
    const agents = backend.userAgents();
    assert.ok(agents.length > 0);
    for (const ua of agents) assert.match(ua, /^ub-sgbr-mcp\/\S+ \(http\)$/);
  } finally {
    await backend.close();
  }
});

test('Origin: claude.ai and Origin: null pass, a foreign or malformed Origin is 403', async () => {
  await withServer({}, async (server) => {
    const status = async (origin) => (await modern(server, 'tools/list', {}, undefined, { origin })).status;
    assert.equal(await status('https://evil.example'), 403);
    assert.equal(await status('not a url'), 403);
    assert.equal(await status('https://claude.ai'), 200);
    assert.equal(await status('https://www.claude.ai'), 200);
    assert.equal(await status('null'), 200);
    const ok = await fetch(server.mcp, { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://claude.ai');
    assert.equal((await fetch(server.mcp, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403);
  });
  await withServer({ MCP_ALLOWED_ORIGINS: 'https://*.example.org' }, async (server) => {
    const status = async (origin) => (await modern(server, 'tools/list', {}, undefined, { origin })).status;
    assert.equal(await status('https://a.example.org'), 200);
    assert.equal(await status('https://claude.ai'), 403, 'MCP_ALLOWED_ORIGINS replaces the defaults');
  });
});

test('Host: a configured host or RAILWAY_PUBLIC_DOMAIN turns the check on, and /health is exempt', async () => {
  await withServer({}, async (server) => {
    assert.equal(await statusWithHost(server, 'anything.example'), 200, 'no host configured, no check');
  });
  for (const env of [{ MCP_ALLOWED_HOSTS: 'mcp.example.org' }, { RAILWAY_PUBLIC_DOMAIN: 'mcp.example.org' }]) {
    await withServer(env, async (server) => {
      assert.equal(await statusWithHost(server, 'evil.example'), 403, JSON.stringify(env));
      assert.equal(await statusWithHost(server, 'mcp.example.org'), 200, JSON.stringify(env));
      assert.equal(await statusWithHost(server, 'MCP.example.org:8443'), 200, JSON.stringify(env));
      assert.equal((await fetch(`${server.url}/health`)).status, 200);
    });
  }
});

test('a bad allowlist entry stops the server at startup, naming the entry', async () => {
  for (const [name, entry] of [['MCP_ALLOWED_HOSTS', 'mcp.example.org:port'], ['MCP_ALLOWED_ORIGINS', 'foo*.example']]) {
    const { code, stderr, error } = await refusal({ [name]: entry });
    assert.equal(code, 1, stderr);
    assert.doesNotMatch(stderr, /listening on/);
    assert.ok(error?.msg.startsWith(`${name}: "${entry}" is not a hostname`), stderr);
  }
});

test('the wall-clock guard stays under Claude\'s 240 s per call and outlasts a default request\'s retries', () => {
  const read = (env) => {
    const out = spawnSync(process.execPath,
      ['--input-type=module', '-e', "const c = await import('./src/config.js'); const h = await import('./src/http-config.js'); console.log(JSON.stringify([h.HTTP_RESPONSE_TIMEOUT_MS, c.REQUEST_TIMEOUT_MS, c.MAX_RETRIES]))"],
      { cwd: ROOT, env: { ...process.env, SGBR_HTTP_RESPONSE_TIMEOUT_MS: '', SGBR_TIMEOUT_MS: '', ...env }, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  const [guard, request, retries] = read({});
  assert.ok(guard > request * (retries + 1), `${guard} ms`);
  assert.ok(guard < 240_000, `${guard} ms`);
  assert.ok(read({ SGBR_TIMEOUT_MS: '400000' })[0] < 240_000, 'a raised request timeout does not lift the guard past 240 s');
});

test('the stdio entry\'s settings never read the HTTP entry\'s env', () => {
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/server.js')"],
    { cwd: ROOT, env: { ...process.env, PORT: 'not-a-port', SGBR_HTTP_MAX_INFLIGHT: '0' }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /PORT|SGBR_HTTP_MAX_INFLIGHT/);
});

test('GET and DELETE on the endpoint are 405, a body over 1 MiB is 413, a compressed body 415', async () => {
  await withServer({}, async (server) => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(server.mcp, { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('x-accel-buffering'), 'no');
    }
    // Declared, not sent: the refusal must not wait for the body, and a client still writing
    // one would race the closed socket.
    const big = await new Promise((resolve, reject) => {
      const req = request(server.mcp, {
        method: 'POST',
        headers: { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list', 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', 'content-length': 1_500_000 },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('no answer within 5 s: the server waits for the body')));
      req.flushHeaders();
    });
    assert.equal(big, 413);
    for (const encoding of ['gzip', 'br']) {
      const res = await modern(server, 'tools/list', {}, undefined, { 'content-encoding': encoding });
      assert.equal(res.status, 415, encoding);
    }
    assert.equal((await modern(server, 'tools/list', {}, undefined, { 'content-encoding': 'identity' })).status, 200);
  });
});

test('a slow call is cut at the wall-clock guard, and the server stays healthy', async () => {
  await withServer({ SGBR_HTTP_RESPONSE_TIMEOUT_MS: '300' }, async (server) => {
    const started = Date.now();
    const res = await call(server, 'sgbr_locate_text', locateArgs());
    assert.equal(res.status, 504);
    assert.deepEqual(res.body, { error: 'Request timeout' });
    assert.ok(Date.now() - started < 900, `took ${Date.now() - started} ms`);
    await sleep(1500);
    assert.equal(server.child.exitCode, null, server.stderr());
    assert.equal((await fetch(`${server.url}/health`)).status, 200);
    assert.doesNotMatch(server.stderr(), /ERR_HTTP_HEADERS_SENT|unhandled/);
  }, slow);
});

test('a call cut at the guard stops reaching the backend', async () => {
  const pages = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`text:${i + 1}`, `Seite ${i + 1}`]));
  const backend = await startStubServer(makeRouter({ ocr: pages }), { delayMs: 400 });
  try {
    await withServer({ SGBR_HTTP_RESPONSE_TIMEOUT_MS: '300' }, async (server) => {
      const res = await call(server, 'sgbr_locate_text', { ...locateArgs(), max_pages: 40 });
      assert.equal(res.status, 504);
      // Requests in flight at the guard may still arrive; a scan left running would send a
      // new wave every delayMs until all 40 pages are read.
      await sleep(600);
      const atCut = backend.requests();
      await sleep(1500);
      assert.equal(backend.requests(), atCut, `the scan kept going: ${atCut} → ${backend.requests()} requests`);
      assert.ok(atCut < 40, `${atCut} requests`);
    }, backend);
  } finally {
    await backend.close();
  }
});

test('a 2025 SSE answer commits its headers while the tool is still running', async () => {
  await withServer({}, async (server) => {
    const started = Date.now();
    const res = await fetch(server.mcp, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': LEGACY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sgbr_locate_text', arguments: locateArgs() } }),
    });
    assert.ok(Date.now() - started < 800, `headers took ${Date.now() - started} ms`);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(parseBody(await res.text())?.id, 2);
    assert.ok(Date.now() - started >= 1000, 'the tool really waited on the slow backend');
  }, slow);
});

test('a request over the in-flight limit is 503 with Retry-After, and the slot comes back', async () => {
  await withServer({ SGBR_HTTP_MAX_INFLIGHT: '1' }, async (server) => {
    const first = call(server, 'sgbr_locate_text', locateArgs());
    await sleep(250);
    const second = await modern(server, 'tools/list');
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('retry-after'), '5');
    assert.equal((await first).status, 200);
    assert.equal((await modern(server, 'tools/list')).status, 200);
  }, slow);
});

test('every call is logged with a level, without its input or an error that quotes it', async () => {
  await withServer({}, async (server) => {
    await call(server, 'sgbr_locate_text', { ...locateArgs(), scan_id: 'MARKERSCAN-0001' });
    // A wrapped query is refused by the handler, so the error names it.
    const refused = await call(server, 'sgbr_search', { query: '(markerquery)' });
    assert.equal(refused.body?.result?.isError, true, JSON.stringify(refused.body));
    const missing = await call(server, 'sgbr_get_record', { id: 'markerid-0000' });
    assert.match(missing.body?.result?.content?.[0]?.text ?? '', /markerid-0000/, 'the error quotes the input');
    // Rejected by the SDK before any handler runs, so only the transport could log them.
    await call(server, 'sgbr_search', { query: 'markerschema', markerkey: 1 });
    await call(server, 'markertool', { query: 'markerunknown' });
    await sleep(100);
    const calls = server.lines().filter((l) => l.tool);
    assert.deepEqual(calls.map((l) => [l.tool, l.ok, l.level, l.error_type]),
      [['sgbr_locate_text', true, 'info', undefined], ['sgbr_search', false, 'warn', 'ToolError'],
        ['sgbr_get_record', false, 'warn', 'ToolError']]);
    for (const l of calls) assert.equal(typeof l.ms, 'number');
    assert.doesNotMatch(server.stderr(), /MARKERSCAN|markerquery|markerschema|markerkey|markertool|markerunknown|markerid|in Basel/);
    for (const l of server.lines()) assert.ok(l.level, JSON.stringify(l));
  });
});

test('SIGTERM lets a call in flight finish, then exits 0', async () => {
  const server = await boot({}, slow);
  try {
    const pending = call(server, 'sgbr_locate_text', locateArgs());
    await sleep(250);
    server.child.kill('SIGTERM');
    assert.equal((await pending).status, 200);
    assert.equal(await server.exited, 0);
  } finally {
    await server.stop();
  }
});
