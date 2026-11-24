// Unit tests for the auth seam. Runs offline (no API): both authHeaders and
// authFingerprint read the env at call time, so we can toggle SGBR_ACCESS_TOKEN
// directly. The fingerprint tests pin the cache-scoping identity contract —
// header creation and cache keying both derive from getAccessToken(), and a
// drift between them could cross-serve ACL-restricted content (see the
// companion cache-isolation test in clients.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, authFingerprint } from '../src/lib/auth.js';
import { ToolError } from '../src/lib/errors.js';
import { withTool } from '../src/lib/tool.js';
import { graphqlRequest, clearGraphqlCache } from '../src/graphql/client.js';
import { installFetchStub } from './stub-backend.js';
import { withEnv, setEnv } from './helpers.js';

test('authHeaders omits Authorization when no token is set', () => {
  withEnv('SGBR_ACCESS_TOKEN', undefined, () => {
    assert.deepEqual(authHeaders(), {}, 'anonymous requests must send no Authorization header');
  });
});

test('authHeaders adds a bearer token when SGBR_ACCESS_TOKEN is set', () => {
  withEnv('SGBR_ACCESS_TOKEN', '  abc.def.ghi  ', () => { // whitespace should be trimmed
    assert.deepEqual(authHeaders(), { Authorization: 'Bearer abc.def.ghi' });
  });
});

test('authFingerprint never leaks the raw token', () => {
  const token = 'super-secret-token';
  const fp = withEnv('SGBR_ACCESS_TOKEN', token, () => authFingerprint());
  assert.equal(typeof fp, 'string');
  for (const part of token.split('-')) {
    assert.ok(!fp.includes(part), `no fragment of the raw token ("${part}") may appear in the fingerprint`);
  }
});

test('authFingerprint is stable within one identity and distinct across identities', () => {
  const fpA = withEnv('SGBR_ACCESS_TOKEN', 'token-a', () => authFingerprint());
  const fpAgain = withEnv('SGBR_ACCESS_TOKEN', 'token-a', () => authFingerprint());
  const fpB = withEnv('SGBR_ACCESS_TOKEN', 'token-b', () => authFingerprint());
  assert.equal(fpA, fpAgain, 'same token → same fingerprint (cache hits stay possible)');
  assert.notEqual(fpA, fpB, 'different tokens → different fingerprints');
  const fpAnon = withEnv('SGBR_ACCESS_TOKEN', undefined, () => authFingerprint());
  assert.notEqual(fpA, fpAnon, 'a token-bearing identity never collides with anonymous');
  // Trimming must not fork the identity: cache keys and headers see one token.
  const fpTrimmed = withEnv('SGBR_ACCESS_TOKEN', '  token-a  ', () => authFingerprint());
  assert.equal(fpTrimmed, fpA, 'whitespace around the token must not create a separate cache identity');
});

// A token fetch would reject (a line break from a wrapped paste, a non-Latin-1
// character) must be refused before any request, and never quoted: fetch's own
// rejection of a line break embeds the whole header value.
const MALFORMED = ['eyJhbGciOi.PAYLOAD\nSIGNATURE', 'abc\rSIGNATURE', 'abc\r\nSIGNATURE', 'abc€SIGNATURE'];

test('authHeaders refuses a malformed token without quoting it', () => {
  for (const token of MALFORMED) {
    withEnv('SGBR_ACCESS_TOKEN', token, () => {
      assert.throws(() => authHeaders(), (err) => err instanceof ToolError
        && !`${err.message} ${err.suggestion}`.includes('SIGNATURE'), JSON.stringify(token));
    });
  }
});

test('authHeaders passes through any token fetch can send', () => {
  // Opaque tokens are not always RFC 6750 b64tokens; refusing one fetch would
  // send stops the server from starting at all.
  for (const token of ['aZ09-._~+/==', 'a:b%c!$d', 'inner space', 'in\tner', 'Latin-1 ä']) {
    withEnv('SGBR_ACCESS_TOKEN', token, () => {
      assert.deepEqual(authHeaders(), { Authorization: `Bearer ${token}` }, JSON.stringify(token));
    });
  }
});

test('a malformed token fails the tool call before any fetch, and never reaches its text', async () => {
  const stub = installFetchStub(() => { throw new Error('no request may be sent'); });
  const restoreEnv = setEnv('SGBR_ACCESS_TOKEN', MALFORMED[0]);
  try {
    clearGraphqlCache();
    const run = withTool('sgbr_search', 'Search failed', async () => { await graphqlRequest('{x}', {}); });
    const res = await run({ query: 'x' }, {});
    assert.equal(res.isError, true);
    assert.doesNotMatch(res.content[0].text, /SIGNATURE/);
    assert.deepEqual(stub.calls, [], 'refused before the retry loop, so nothing is sent');
  } finally {
    restoreEnv();
    stub.restore();
  }
});
