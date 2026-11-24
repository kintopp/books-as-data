// The single seam for outbound authentication. Anonymous access already returns
// all public content; setting SGBR_ACCESS_TOKEN adds a bearer token so requests
// can reach ACL-restricted records (the token must be obtained out-of-band —
// there is no interactive OIDC flow in this stdio server). Read at call time so
// the env can be set per process without import-order surprises.

import { createHash } from 'node:crypto';
import { ToolError } from './errors.js';

// What fetch refuses in a header value: CR/LF/NUL, which it rejects with the
// whole value in its message — carrying the token into the tool result and every
// log — and anything beyond Latin-1, which it cannot send at all. Everything else
// goes out as-is, so refusing more would only lock out a working token. The
// error here must never quote the token.
const UNSENDABLE = /[\r\n\0]|[\u0100-\u{10FFFF}]/u;

// The trimmed access token, or '' when running anonymously. The single place the
// token env var is read, so callers (header building, cache keying) stay in sync.
export function getAccessToken() {
  return process.env.SGBR_ACCESS_TOKEN?.trim() || '';
}

export function assertTokenWellFormed(token) {
  if (token && UNSENDABLE.test(token)) {
    throw new ToolError(
      'SGBR_ACCESS_TOKEN is malformed: it contains a line break, a NUL or a character beyond Latin-1, which an HTTP header cannot carry.',
      'Re-copy the token as a single line, or unset SGBR_ACCESS_TOKEN for anonymous access.',
    );
  }
}

export function authHeaders() {
  const token = getAccessToken();
  assertTokenWellFormed(token);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// A short, one-way fingerprint of the current access token (or 'anon' when
// anonymous), used to scope every HTTP client's cache keys to the auth context —
// so a body fetched with one identity is never served to another. The token
// itself never appears in a key, only this fingerprint of it.
export function authFingerprint() {
  const token = getAccessToken();
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : 'anon';
}
