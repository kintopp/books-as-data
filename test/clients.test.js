// Offline unit tests for the HTTP clients, driven by a stubbed global fetch:
// success, GraphQL error mapping, non-retryable vs retryable status, external
// cancellation, and full-text normalization + in-flight cache de-duplication.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { graphqlRequest, GraphQLError, clearGraphqlCache } from '../src/graphql/client.js';
import { fetchFullText } from '../src/fulltext/client.js';
import { fetchImage, ImageError } from '../src/image/client.js';
import { parseRetryAfter, fetchWithRetry } from '../src/lib/http.js';
import { MAX_RETRIES, GRAPHQL_ENDPOINT, CONTENT_SEARCH_MAX_BYTES } from '../src/config.js';
import { fetchContentSearch, contentSearchUrl, ContentSearchError } from '../src/contentsearch/client.js';
import { createServer } from 'node:http';
import { setEnv } from './helpers.js';

const realFetch = globalThis.fetch;
// Restore fetch AND drop the response cache, so each test's stubbed fetch is
// actually reached instead of a prior test's cached (operation, variables) entry.
afterEach(() => { globalThis.fetch = realFetch; clearGraphqlCache(); });

test('graphqlRequest returns data on success', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ data: { search: { totalCount: 1 } } }) }; };
  assert.deepEqual(await graphqlRequest('q', {}), { search: { totalCount: 1 } });
  assert.equal(calls, 1);
});

test('graphqlRequest maps GraphQL errors[] to a GraphQLError', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'bad query' }] }) });
  await assert.rejects(
    () => graphqlRequest('q', {}),
    (e) => e instanceof GraphQLError && /bad query/.test(e.message),
  );
});

test('graphqlRequest does not retry a non-retryable status', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 400, headers: { get: () => null } }; };
  await assert.rejects(() => graphqlRequest('q', {}), (e) => e instanceof GraphQLError && e.status === 400);
  assert.equal(calls, 1, 'a 400 must not be retried');
});

test('graphqlRequest honors an already-aborted signal without hitting the network', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ data: {} }) }; };
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => graphqlRequest('q', {}, { signal: ac.signal }));
  assert.equal(calls, 0, 'a cancelled request must not reach fetch');
});

test('graphqlRequest retries a retryable status then succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // the 503's ~1s backoff is instant under mocked timers
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503, headers: { get: () => null } };
    return { ok: true, json: async () => ({ data: { ok: true } }) };
  };
  const p = graphqlRequest('q', {});
  await settleRetries(t); // fire the pending backoff (settleRetries/drainMicrotasks are defined below)
  assert.deepEqual(await p, { ok: true });
  assert.equal(calls, 2);
});

test('graphqlRequest fails fast on a Retry-After beyond the ceiling', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '120' : null) } };
  };
  await assert.rejects(
    () => graphqlRequest('q', {}),
    (e) => e instanceof GraphQLError && e.status === 429 && /rate-limited/i.test(e.message),
  );
  assert.equal(calls, 1, 'a 120s Retry-After must not be retried at the 30s ceiling');
});

test('graphqlRequest honors a Retry-After under the ceiling and retries', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503, headers: { get: (h) => (h === 'retry-after' ? '0' : null) } };
    return { ok: true, json: async () => ({ data: { ok: true } }) };
  };
  assert.deepEqual(await graphqlRequest('q', {}), { ok: true });
  assert.equal(calls, 2);
});

test('graphqlRequest coalesces identical (operation, variables) calls', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ data: { n: calls } }) }; };
  const a = await graphqlRequest('same', { x: 1 });
  const b = await graphqlRequest('same', { x: 1 }); // identical → served from cache, no fetch
  assert.deepEqual(a, b);
  assert.equal(calls, 1, 'the second identical call must be served from cache');
  await graphqlRequest('same', { x: 2 }); // different variables → a fresh fetch
  assert.equal(calls, 2, 'a different variables object must miss the cache');
});

test('graphqlRequest with cache:false always fetches and stores nothing', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ data: { n: calls } }) }; };
  await graphqlRequest('same', { x: 1 }, { cache: false });
  await graphqlRequest('same', { x: 1 }, { cache: false });
  assert.equal(calls, 2, 'identical uncached calls each reach the backend');
  await graphqlRequest('same', { x: 1 });
  assert.equal(calls, 3, 'the uncached calls left nothing in the cache');
});

test('graphqlRequest never serves one auth identity a response cached under another', async () => {
  // The security invariant behind authFingerprint(): the cache key embeds the
  // current identity, so an anonymous response must never satisfy a token-bearing
  // caller (or vice-versa), while repeats under ONE identity still coalesce.
  let calls = 0;
  globalThis.fetch = async (_url, { headers }) => {
    calls++;
    return { ok: true, json: async () => ({ data: { auth: headers.Authorization ?? 'anon' } }) };
  };
  // setEnv (not withEnv): the override must span an await — see helpers.js.
  const under = async (token, run) => {
    const restore = setEnv('SGBR_ACCESS_TOKEN', token);
    try { return await run(); } finally { restore(); }
  };
  const anon = await under(undefined, () => graphqlRequest('same-op', { x: 1 }));
  const a1 = await under('token-a', () => graphqlRequest('same-op', { x: 1 }));
  const a2 = await under('token-a', () => graphqlRequest('same-op', { x: 1 }));
  const b = await under('token-b', () => graphqlRequest('same-op', { x: 1 }));
  assert.equal(anon.auth, 'anon');
  assert.equal(a1.auth, 'Bearer token-a', 'the token identity fetched fresh, with its own header');
  assert.deepEqual(a2, a1, 'a repeat under the same token is a cache hit');
  assert.equal(b.auth, 'Bearer token-b', 'a second token never sees the first token\'s response');
  assert.equal(calls, 3, 'anon, token-a, token-b each fetch once; the token-a repeat coalesces');
});

// The GraphQL-specific half of the transient-parse contract. fetchWithRetry's
// generic side is covered below ('retries a transient 2xx body-parse failure'),
// but only src/graphql/client.js:63-73 decides that an unparseable HTTP 200 —
// a proxy error page or truncated stream, never a GraphQL response — is worth
// retrying, by setting `transient = true` on the typed error. Drop that one
// assignment and a recoverable gateway hiccup becomes a hard tool failure, with
// the generic tests still green.
test('graphqlRequest retries an unparseable HTTP 200, then succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    }
    return { ok: true, status: 200, json: async () => ({ data: { ok: true } }) };
  };
  const p = graphqlRequest('q', {});
  await settleRetries(t);
  assert.deepEqual(await p, { ok: true });
  assert.equal(calls, 2, 'a non-JSON 200 must be retried, not surfaced on the first attempt');
});

test('graphqlRequest surfaces a persistent non-JSON 200 as an actionable GraphQLError', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  };
  const p = graphqlRequest('q', {});
  // Attach the rejection handler BEFORE settling — see the note on
  // 'rethrows the original error after exhausting transient retries' below.
  const rejection = assert.rejects(p, (e) => {
    assert.ok(e instanceof GraphQLError, 'typed, so callers can tell it from a transport error');
    // The text is what an LLM sees: it must name the actual condition, not a
    // bare SyntaxError that reads as a bug in this server.
    assert.match(e.message, /non-JSON response/i);
    assert.match(e.message, /HTTP 200/);
    return true;
  });
  await settleRetries(t);
  await rejection;
  assert.equal(calls, MAX_RETRIES + 1, 'exhausts the retry budget before giving up');
});

test('parseRetryAfter reads seconds and HTTP-date, and rejects junk', () => {
  const hdr = (v) => ({ headers: { get: (h) => (h === 'retry-after' && v !== undefined ? v : null) } });
  assert.equal(parseRetryAfter(hdr('120')), 120000);
  assert.equal(parseRetryAfter(hdr('0')), 0);
  assert.equal(parseRetryAfter(hdr(undefined)), undefined);
  assert.equal(parseRetryAfter(hdr('not-a-date')), undefined);
  assert.equal(parseRetryAfter(hdr('Wed, 21 Oct 2015 07:28:00 GMT')), 0, 'a past date clamps to 0');
  const future = parseRetryAfter(hdr(new Date(Date.now() + 60000).toUTCString()));
  assert.ok(future > 0 && future <= 60000, `a future date should be ~60s, got ${future}`);
});

test('fetchFullText normalizes the body and returns the source url', async () => {
  globalThis.fetch = async () => ({ ok: true, text: async () => 'hello  \nworld' });
  const { text, url } = await fetchFullText('SCAN-success-1');
  assert.equal(text, 'hello\nworld');
  assert.match(url, /get_gb_fulltext\/SCAN-success-1$/);
});

test('fetchFullText de-duplicates concurrent misses for one scan id', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, text: async () => 'body' }; };
  const [a, b] = await Promise.all([fetchFullText('SCAN-dedup-1'), fetchFullText('SCAN-dedup-1')]);
  assert.equal(a.text, 'body');
  assert.equal(b.text, 'body');
  assert.equal(calls, 1, 'concurrent misses share a single download');
});

// ── fetchWithRetry, driven directly ─────────────────────────────────────────────
// The shared loop (src/lib/http.js) is used by all three clients but its transient
// branches (network TypeError, timeout AbortError, a 2xx whose body fails to parse,
// abort-during-backoff, exhaustion) are hard to reach through graphqlRequest alone.
// Drive it directly with a stub fetch + a stub makeError/onOk.
const makeTestError = (message, meta = {}) =>
  Object.assign(new Error(message), { name: 'TestError', status: meta.status });

// setImmediate stays real under mocked setTimeout, so this drains the microtask
// queue — letting a just-thrown fetch reach its `await abortableSleep` and register
// the backoff timer before we fire it.
const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

// Fire every backoff sleep as it is scheduled. Extra passes are harmless no-ops:
// the stub fetches ignore the abort signal, so `runAll()` firing a stale
// per-request timeout does nothing — the only effect that matters is resolving the
// pending backoff. So we loop a generous fixed number of rounds and let the call
// settle, rather than counting exact rounds per test.
async function settleRetries(t) {
  for (let i = 0; i < MAX_RETRIES + 2; i++) {
    await drainMicrotasks();
    t.mock.timers.runAll();
  }
  await drainMicrotasks();
}

// The shape fetch gives a network failure: a TypeError wrapping the system error.
const networkError = (message = 'fetch failed') =>
  new TypeError(message, { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

// REAL fetch rejections, so the retry rule is pinned to the shapes undici
// actually throws. All on loopback. Port 1 is NOT a refused connection: fetch
// blocks it as a bad port, itself a deterministic rejection.
const rejection = (promise) => promise.then(() => assert.fail('fetch should reject'), (e) => e);
const realFetchError = (...args) => rejection(realFetch(...args));

async function withLocalServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// A port that was just listening and now refuses.
const closedPortUrl = () => withLocalServer(() => {}, (url) => url);

// A real "terminated" body error: the server promises 1000 bytes, then drops the socket.
const realBodyCutError = () => withLocalServer((_req, res) => {
  res.writeHead(200, { 'content-length': '1000' });
  res.write('partial');
  setTimeout(() => res.socket.destroy(), 20);
}, async (url) => rejection((await realFetch(url)).text()));

// Drives one fetchWithRetry call whose fetch throws `fetchErrors` in turn, then
// succeeds; resolves to { result | error, fetches }.
async function runWithFetchErrors(t, fetchErrors, onOk = async () => 'body') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fetches = 0;
  globalThis.fetch = async () => {
    if (fetches++ < fetchErrors.length) throw fetchErrors[fetches - 1];
    return { ok: true };
  };
  const p = fetchWithRetry('u', { service: 'Test', makeError: makeTestError, onOk })
    .then((result) => ({ result }), (error) => ({ error }));
  await settleRetries(t);
  return { ...(await p), fetches };
}

test('fetchWithRetry retries the network failure fetch really throws', async (t) => {
  const refused = await realFetchError(await closedPortUrl());
  const { result, fetches } = await runWithFetchErrors(t, [refused]);
  assert.equal(result, 'body');
  assert.equal(fetches, 2, 'a refused connection is transient');
});

test('fetchWithRetry fails at once when fetch rejects its own input', async (t) => {
  const rejections = {
    'an invalid header value': await realFetchError('http://127.0.0.1:1/', { headers: { 'X-Test': 'a\nb' } }),
    'an unparseable URL': await realFetchError('not a url'),
    'a blocked port': await realFetchError('http://127.0.0.1:1/'),
    ...await withLocalServer((_req, res) => res.end('ok'), async (url) => ({
      'a header undici refuses to send': await realFetchError(url, { headers: { 'transfer-encoding': 'chunked' } }),
      'an unsupported header': await realFetchError(url, { headers: { expect: '100-continue' } }),
      'a body shorter than its content-length': await realFetchError(url, {
        method: 'POST', body: 'abc', headers: { 'content-length': '10' },
      }),
    })),
  };
  for (const [what, err] of Object.entries(rejections)) {
    const { error, fetches } = await runWithFetchErrors(t, [err, err, err, err]);
    assert.equal(error, err, `${what} surfaces as thrown`);
    assert.equal(fetches, 1, `${what} is deterministic, so it is not retried`);
    t.mock.timers.reset();
  }
});

test('fetchWithRetry does not retry a TypeError thrown by a bug in onOk', async (t) => {
  let parses = 0;
  const { error, fetches } = await runWithFetchErrors(t, [], async () => { parses++; return undefined.body; });
  assert.ok(error instanceof TypeError);
  assert.equal(fetches, 1);
  assert.equal(parses, 1, 'the same bug would only repeat');
});

test('fetchWithRetry retries a body cut mid-stream while onOk reads it', async (t) => {
  const cut = await realBodyCutError();
  let parses = 0;
  const { result, fetches } = await runWithFetchErrors(t, [], async () => {
    if (parses++ === 0) throw cut;
    return 'body';
  });
  assert.equal(result, 'body');
  assert.equal(fetches, 2, 'a dropped connection mid-body is transient');
});

test('fetchWithRetry treats a timeout-shaped AbortError as transient and retries', async (t) => {
  // With no caller signal, an AbortError can only be our own per-request timeout.
  const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { result, fetches } = await runWithFetchErrors(t, [timeout]);
  assert.equal(result, 'body');
  assert.equal(fetches, 2, 'a timeout AbortError with no caller signal is retried, not surfaced');
});

test('fetchWithRetry retries a transient 2xx body-parse failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fetches = 0, parses = 0;
  globalThis.fetch = async () => { fetches++; return { ok: true }; };
  const onOk = async () => {
    parses++;
    if (parses === 1) { const e = new Error('bad body'); e.transient = true; throw e; } // opt-in retry
    return 'parsed';
  };
  const p = fetchWithRetry('u', { service: 'Test', makeError: makeTestError, onOk });
  await settleRetries(t);
  assert.equal(await p, 'parsed');
  assert.equal(fetches, 2, 'an err.transient=true from onOk re-fetches once');
});

test('fetchWithRetry rethrows the original error after exhausting transient retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw networkError('persistent network fail'); };
  const p = fetchWithRetry('u', { service: 'Test', makeError: makeTestError, onOk: async () => 'body' });
  // Attach the rejection handler BEFORE settling: p rejects mid-settle, and an
  // un-consumed rejection would trip the runner's unhandledRejection guard.
  const rejection = assert.rejects(p, (e) => e instanceof TypeError && /persistent network fail/.test(e.message));
  await settleRetries(t);
  await rejection;
  assert.equal(fetches, MAX_RETRIES + 1, 'MAX_RETRIES+1 attempts, then the original error is rethrown');
});

test('fetchWithRetry surfaces a service error after exhausting a retryable status', async () => {
  // Retry-After:0 keeps the real backoff instant, so no mocked timers are needed.
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return { ok: false, status: 503, headers: { get: (h) => (h === 'retry-after' ? '0' : null) } };
  };
  await assert.rejects(
    () => fetchWithRetry('u', { service: 'Widget service', makeError: makeTestError, onOk: async () => 'body' }),
    (e) => e.name === 'TestError' && e.status === 503 && /Widget service returned HTTP 503/.test(e.message),
  );
  assert.equal(fetches, MAX_RETRIES + 1, 'all four attempts made before giving up');
});

test('fetchWithRetry stops retrying when the caller aborts during backoff', async () => {
  let fetches = 0;
  // 503 with no Retry-After → a real ~1s backoff begins; abort partway through it.
  globalThis.fetch = async () => { fetches++; return { ok: false, status: 503, headers: { get: () => null } }; };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20);
  await assert.rejects(
    () => fetchWithRetry('u', { signal: ac.signal, service: 'Test', makeError: makeTestError, onOk: async () => 'body' }),
    (e) => e.name === 'AbortError',
  );
  clearTimeout(timer);
  assert.equal(fetches, 1, 'the backoff was cut short, so the second attempt never fires');
});

test('fetchWithRetry never retries a caller abort that lands mid-fetch', async () => {
  let fetches = 0;
  const ac = new AbortController();
  globalThis.fetch = (_url, { signal }) => {
    fetches++;
    return new Promise((_resolve, reject) => {
      // Honor abort like undici: reject with an AbortError when the signal fires.
      signal.addEventListener('abort', () => {
        const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e);
      }, { once: true });
      setTimeout(() => ac.abort(), 5); // the caller cancels while the fetch is pending
    });
  };
  await assert.rejects(
    () => fetchWithRetry('u', { signal: ac.signal, service: 'Test', makeError: makeTestError, onOk: async () => 'body' }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(fetches, 1, 'caller cancellation propagates immediately, never retried');
});

// `bodyUsed` is true once a body is cancelled OR read, so either way of releasing
// the connection passes; only an untouched body fails.
test('fetchWithRetry disposes every non-ok body, including the terminal one', async () => {
  const responses = [];
  globalThis.fetch = async () => {
    assert.ok(responses.every((r) => r.bodyUsed), 'each earlier body was disposed before the next attempt');
    const res = new Response('busy', { status: 503, headers: { 'retry-after': '0' } }); // instant backoff
    responses.push(res);
    return res;
  };
  await assert.rejects(
    () => fetchWithRetry('u', { service: 'Test', makeError: makeTestError, onOk: async () => 'body' }),
    (e) => e.name === 'TestError' && e.status === 503,
  );
  assert.equal(responses.length, MAX_RETRIES + 1);
  assert.ok(responses.every((r) => r.bodyUsed), 'the terminal body too, before the error');
});

test('fetchWithRetry cancels the abandoned 2xx body when onOk throws, transient and terminal alike', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cancelled = [];
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    const attempt = fetches;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { cancel: () => { cancelled.push(attempt); return Promise.resolve(); } },
    };
  };
  // Attempt 1's extractor throws transient (the unparseable-2xx shape) without
  // touching the body; attempt 2 succeeds. The loop must dispose body 1 — the
  // extractor need not.
  const p = fetchWithRetry('u', {
    service: 'Test',
    makeError: makeTestError,
    onOk: async () => {
      if (fetches === 1) throw Object.assign(makeTestError('unparseable body'), { transient: true });
      return 'parsed';
    },
  });
  await settleRetries(t);
  assert.equal(await p, 'parsed');
  assert.deepEqual(cancelled, [1], 'only the abandoned body is cancelled, never the consumed one');

  // A terminal onOk throw (e.g. the image client rejecting a non-image 200)
  // must dispose its body too, before the error surfaces.
  t.mock.timers.reset();
  cancelled.length = 0;
  fetches = 0;
  await assert.rejects(
    () => fetchWithRetry('u', {
      service: 'Test',
      makeError: makeTestError,
      onOk: async () => { throw makeTestError('not an image'); },
    }),
    (e) => e.name === 'TestError' && /not an image/.test(e.message),
  );
  assert.equal(fetches, 1, 'a non-transient onOk error is never retried');
  assert.deepEqual(cancelled, [1], 'the terminal attempt’s body is cancelled before the throw');
});

test('a body-disposal failure never masks the service error', async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return {
      ok: false,
      status: 503,
      headers: { get: (h) => (h === 'retry-after' ? '0' : null) },
      // Alternate the two failure shapes — a synchronous throw and an async
      // rejection. A missing rejection handler would trip the runner's
      // unhandledRejection guard, so this also pins the .catch() path.
      body: {
        cancel: fetches % 2
          ? () => { throw new Error('sync cancel failure'); }
          : () => Promise.reject(new Error('async cancel failure')),
      },
    };
  };
  await assert.rejects(
    () => fetchWithRetry('u', { service: 'Widget service', makeError: makeTestError, onOk: async () => 'body' }),
    (e) => e.name === 'TestError' && e.status === 503 && /Widget service returned HTTP 503/.test(e.message),
  );
  assert.equal(fetches, MAX_RETRIES + 1, 'disposal failures neither abort the retry loop nor mask the outcome');
});

// ── Timeout classification. The loop
// tracks whether its OWN per-attempt timer fired and relabels only the TERMINAL
// AbortError as a typed service timeout (via makeError); mid-loop timeouts keep
// retrying as transient, and genuine caller cancellation keeps surfacing as an
// AbortError (pinned by the two caller-abort tests above).
test('exhausted local timeouts surface a service-specific timeout error, not a bare AbortError', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // makes each 30s request timer instantly firable
  let fetches = 0;
  globalThis.fetch = (_url, { signal }) => {
    fetches++;
    return new Promise((_resolve, reject) => {
      // Never respond; reject on abort like undici — so every attempt can only
      // end via the per-request timeout (no caller signal is passed at all).
      signal.addEventListener('abort', () => {
        const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e);
      }, { once: true });
    });
  };
  const p = fetchWithRetry('u', { service: 'Test', makeError: makeTestError, onOk: async () => 'body' });
  const rejection = assert.rejects(
    p,
    (e) => e.name === 'TestError' && /timed out/i.test(e.message),
    'the terminal error must be typed via makeError and name the timeout, not a generic AbortError',
  );
  // Each attempt needs two timer firings (the request timeout, then the backoff),
  // so settle twice as many rounds as attempts, plus slack.
  for (let i = 0; i < 2 * (MAX_RETRIES + 1) + 2; i++) {
    await drainMicrotasks();
    t.mock.timers.runAll();
  }
  await drainMicrotasks();
  await rejection;
  assert.equal(fetches, MAX_RETRIES + 1, 'timeouts are still transient: all attempts run before the terminal mapping');
});

// ── fetchImage (image client) ────────────────────────────────────────────────────
// The image client shares the retry loop + cache but was untested. Unique URLs per
// test sidestep the module-level cache (no exported clear), mirroring the full-text
// tests above.
test('fetchImage returns the buffer and content-type on success', async () => {
  globalThis.fetch = async () => ({
    ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
  });
  const { buffer, mimeType } = await fetchImage('https://img.test/IMG-success-1');
  assert.ok(Buffer.isBuffer(buffer));
  assert.deepEqual([...buffer], [1, 2, 3, 4]);
  assert.equal(mimeType, 'image/png');
});

test('fetchImage falls back to image/jpeg when content-type is missing', async () => {
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(2) });
  const { mimeType } = await fetchImage('https://img.test/IMG-nomime-1');
  assert.equal(mimeType, 'image/jpeg');
});

test('fetchImage maps a non-retryable status to an ImageError', async () => {
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return { ok: false, status: 404, headers: { get: () => null } }; };
  await assert.rejects(
    () => fetchImage('https://img.test/IMG-404-1'),
    (e) => e instanceof ImageError && e.status === 404 && /Image service returned HTTP 404/.test(e.message),
  );
  assert.equal(fetches, 1, 'a 404 is not retried');
});

test('fetchImage de-duplicates concurrent misses for one url', async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(3) };
  };
  const url = 'https://img.test/IMG-dedup-1';
  const [a, b] = await Promise.all([fetchImage(url), fetchImage(url)]);
  assert.equal(a.buffer.length, 3);
  assert.equal(b.buffer.length, 3);
  assert.equal(fetches, 1, 'concurrent misses share a single download');
});

test('fetchImage rejects a 200 non-image body and does not cache the failure', async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return {
      ok: true, status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      arrayBuffer: async () => { throw new Error('body must not be read'); },
    };
  };
  const url = 'https://img.test/IMG-html-1';
  await assert.rejects(
    () => fetchImage(url),
    (e) => e instanceof ImageError && /text\/html instead of an image/.test(e.message),
  );
  await assert.rejects(() => fetchImage(url), (e) => e instanceof ImageError);
  assert.equal(fetches, 2, 'a rejected body must not be served from cache');
});

test('fetchImage strips content-type parameters from the reported mime type', async () => {
  globalThis.fetch = async () => ({
    ok: true, headers: { get: () => 'image/png; charset=binary' }, arrayBuffer: async () => new ArrayBuffer(1),
  });
  const { mimeType } = await fetchImage('https://img.test/IMG-params-1');
  assert.equal(mimeType, 'image/png');
});

test('fetchImage hands each caller an independent buffer copy', async () => {
  globalThis.fetch = async () => ({
    ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Uint8Array.from([9, 9, 9]).buffer,
  });
  const url = 'https://img.test/IMG-copy-1';
  const first = await fetchImage(url);
  first.buffer[0] = 0; // mutate this caller's copy
  const second = await fetchImage(url); // served from cache
  assert.equal(second.buffer[0], 9, 'a cache hit is unaffected by a prior caller mutating its buffer');
});

// ── Content Search ───────────────────────────────────────────────────────────

const streamed = (body) => ({ ok: true, status: 200, headers: { get: () => null }, body: new Response(body).body });

test('contentSearchUrl quotes the phrase on the GraphQL host and drops characters that unbalance it', () => {
  const url = new URL(contentSearchUrl('id1_UBBS-1', 'Rhein "brücke\\ '));
  assert.equal(url.origin, new URL(GRAPHQL_ENDPOINT).origin);
  assert.equal(url.pathname, '/iiif/services/id1_UBBS-1/search');
  assert.equal(url.searchParams.get('q'), '"Rhein brücke"');
});

test('fetchContentSearch reads the service\'s null body as no hits, and caches by record and phrase', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return streamed('null'); };
  assert.deepEqual(await fetchContentSearch('id-cs-null', 'nirgends'), []);
  assert.deepEqual(await fetchContentSearch('id-cs-null', 'nirgends'), []);
  assert.equal(calls, 1);
});

test('fetchContentSearch stops reading past the byte cap, says the result was too large, and caches that', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return streamed('x'.repeat(CONTENT_SEARCH_MAX_BYTES + 1)); };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      () => fetchContentSearch('id-cs-big', 'und'),
      (e) => e instanceof ContentSearchError && e.tooLarge === true,
    );
  }
  assert.equal(calls, 1, 'a repeat call must not stream the capped body again');
});

test('every request carries the identifying User-Agent alongside client headers', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(init.headers); return { ok: true, json: async () => ({ data: {} }) }; };
  const restore = setEnv('SGBR_ENTRY_POINT', 'cli');
  try {
    await graphqlRequest('query { ua }', {});
  } finally {
    restore();
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0]['User-Agent'], /^ub-sgbr-mcp\/\d+\.\d+\.\d+ \(cli\)$/);
  assert.equal(seen[0]['Content-Type'], 'application/json', 'client headers survive the merge');
});

// ── Transport failures reported under their real cause ───────────────────────────
test('a timeout while the GraphQL body is being read is reported as a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e);
      }, { once: true });
    }),
  });
  const rejection = assert.rejects(graphqlRequest('q-body-timeout', {}), (e) => {
    assert.match(e.message, /timed out/);
    assert.match(e.message, /SGBR_TIMEOUT_MS/);
    return true;
  });
  for (let i = 0; i < 2 * (MAX_RETRIES + 1) + 2; i++) {
    await drainMicrotasks();
    t.mock.timers.runAll();
  }
  await drainMicrotasks();
  await rejection;
});

test('the terminal timeout message counts the attempts that timed out, not all attempts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fetches = 0;
  globalThis.fetch = (_url, { signal }) => {
    fetches++;
    if (fetches === 1) return Promise.resolve({ ok: false, status: 503, headers: { get: () => null }, body: { cancel() {} } });
    if (fetches < MAX_RETRIES + 1) return Promise.reject(networkError());
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e);
      }, { once: true });
    });
  };
  const rejection = assert.rejects(
    fetchWithRetry('u', { service: 'Test', makeError: makeTestError, onOk: async () => 'body' }),
    (e) => {
      assert.doesNotMatch(e.message, /\(4 attempts\)/);
      assert.match(e.message, /1 of 4/);
      return true;
    },
  );
  for (let i = 0; i < 2 * (MAX_RETRIES + 1) + 2; i++) {
    await drainMicrotasks();
    t.mock.timers.runAll();
  }
  await drainMicrotasks();
  await rejection;
});

test('graphqlRequest reports a null JSON body as an unexpected response, not a TypeError', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return { ok: true, status: 200, json: async () => null }; };
  const rejection = assert.rejects(graphqlRequest('q-null-body', {}), (e) => {
    assert.ok(e instanceof GraphQLError);
    assert.match(e.message, /unexpected|non-JSON/i);
    return true;
  });
  await settleRetries(t);
  await rejection;
  assert.equal(fetches, MAX_RETRIES + 1);
});

test('fetchContentSearch reports a 200 with no body as a ContentSearchError', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, body: null });
  await assert.rejects(() => fetchContentSearch('id-cs-nobody', 'und'), (e) => e instanceof ContentSearchError);
});
