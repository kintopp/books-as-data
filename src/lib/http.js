// The one fetch-with-retry loop shared by every HTTP client in src/.
// Handles per-request timeout, external abort propagation,
// capped exponential backoff on transient failures, and RFC-9110 `Retry-After`
// (honored verbatim under RETRY_MAX_DELAY_MS, failed fast above it). Each client
// supplies only what differs: its fetch options, a success extractor (`onOk`),
// and an error factory (`makeError(message, { status })`).

import { REQUEST_TIMEOUT_MS, MAX_RETRIES, RETRY_MAX_DELAY_MS, userAgent } from '../config.js';
import { abortableSleep, throwIfAborted } from './async.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const backoffMs = (attempt) => Math.min(1000 * 2 ** attempt, RETRY_MAX_DELAY_MS); // 1s, 2s, 4s, … capped

// fetch reports a network failure — refused, DNS, a body cut mid-stream — as a
// TypeError whose cause carries a system or undici error code. One whose cause
// has no code (an invalid header, a blocked port, a bug in an `onOk`) or one of
// these codes is fetch rejecting the request itself: every retry would repeat it.
const REQUEST_REJECTED_CODES = new Set([
  'ERR_INVALID_URL', 'UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
]);
const isNetworkFailure = (err) =>
  err.name === 'TypeError' && typeof err.cause?.code === 'string' && !REQUEST_REJECTED_CODES.has(err.cause.code);

// A non-2xx body is never read (only its status/headers are), so cancel it —
// undici keeps the connection busy until the body is consumed, cancelled, or
// GC'd, which delays reuse across retries. Best-effort by design: a disposal
// failure (or a body-less stub in tests) must never mask the service error
// about to be surfaced.
export function discardBody(res) {
  try { res.body?.cancel().catch(() => {}); } catch { /* best-effort */ }
}

// Parse an HTTP `Retry-After` header (RFC 9110) into milliseconds, or undefined
// when it is absent or unparseable. Accepts both wire forms: delta-seconds
// ("120") and an HTTP-date ("Wed, 21 Oct 2025 07:28:00 GMT"); a date already in
// the past yields 0 (retry now). Takes the Response so callers don't repeat the
// header read.
export function parseRetryAfter(res) {
  const raw = res?.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw); // delta-seconds form (spec: an integer)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw); // HTTP-date form
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/**
 * Fetch `url` with timeout + retry. Returns `await onOk(res)` on a 2xx.
 * @param {string} url
 * @param {object} cfg
 * @param {AbortSignal} [cfg.signal]         caller cancellation
 * @param {object}      [cfg.fetchOptions]   method/headers/body (signal is added)
 * @param {string}       cfg.service         human label for error messages
 * @param {(msg: string, meta: {status?: number}) => Error} cfg.makeError
 * @param {(res: Response) => Promise<any>}  cfg.onOk  success-body extractor
 */
export async function fetchWithRetry(url, { signal, fetchOptions = {}, service, makeError, onOk }) {
  // Set here, not per client, so no client can go out unidentified — including
  // the collection client, whose no-auth policy doesn't extend to this header.
  fetchOptions = { ...fetchOptions, headers: { ...fetchOptions.headers, 'User-Agent': userAgent() } };
  let lastError;
  let timeouts = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    throwIfAborted(signal); // caller cancelled during a prior backoff
    const controller = new AbortController();
    // Track whether OUR timer fired: a local timeout and a caller cancel both
    // surface as AbortError, but only the former should ever be relabelled.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetch(url, { ...fetchOptions, signal: controller.signal });
      if (!res.ok) {
        discardBody(res); // every non-ok path below leaves the body unread
        const retryable = RETRYABLE_STATUS.has(res.status);
        const retryAfter = retryable ? parseRetryAfter(res) : undefined;
        // Above the ceiling, retrying sooner than the server permits just burns
        // an attempt — fail fast with actionable text instead.
        if (retryAfter != null && retryAfter > RETRY_MAX_DELAY_MS) {
          throw makeError(
            `${service} is rate-limited (HTTP ${res.status}); it asked to wait ` +
            `${Math.ceil(retryAfter / 1000)}s, beyond the ${RETRY_MAX_DELAY_MS / 1000}s retry ceiling.`,
            { status: res.status },
          );
        }
        if (retryable && attempt < MAX_RETRIES) {
          lastError = makeError(`HTTP ${res.status}`, { status: res.status });
          // Honor a Retry-After under the ceiling; otherwise exponential backoff.
          await abortableSleep(retryAfter ?? backoffMs(attempt), signal);
          continue;
        }
        throw makeError(`${service} returned HTTP ${res.status}`, { status: res.status });
      }
      return await onOk(res);
    } catch (err) {
      // An onOk throw abandons its 2xx response — cancel any body it left
      // undrained, or a transient retry re-fetches while the old connection
      // stays pinned. (Non-ok bodies were already discarded above.)
      if (res?.ok) discardBody(res);
      throwIfAborted(signal, err); // a caller cancel surfaces as AbortError too; never retry it
      if (timedOut && err.name === 'AbortError') timeouts++; // the timer can also fire during a backoff
      // Network failure or our own timeout (AbortError) → retry. Errors we
      // threw above (via makeError / onOk) fall through — unless the thrower
      // opted in by setting `err.transient = true` (e.g. a 2xx whose body failed
      // to parse: likely a proxy flake).
      const transient = err.transient === true || err.name === 'AbortError' || isNetworkFailure(err);
      if (transient && attempt < MAX_RETRIES) {
        lastError = err;
        await abortableSleep(backoffMs(attempt), signal);
        continue;
      }
      // Terminal, and the caller didn't cancel (ruled out above): if this
      // attempt died to OUR timer, the bare "operation was aborted" AbortError
      // would be indistinguishable from a deliberate cancel and names neither
      // the service nor the limit — relabel it as a typed timeout error.
      if (timedOut && err.name === 'AbortError') {
        throw makeError(
          `${service} timed out after ${REQUEST_TIMEOUT_MS / 1000}s on its last attempt ` +
          `(${timeouts} of ${MAX_RETRIES + 1} attempts timed out). The backend may be slow or unreachable; ` +
          'SGBR_TIMEOUT_MS raises the per-attempt limit.',
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  // Unreachable by construction — the final attempt always returns or throws
  // above (`continue` is gated on attempt < MAX_RETRIES). Kept as a guard so a
  // future edit to the retry conditions fails loudly instead of resolving to
  // `undefined`.
  throw lastError || makeError(`${service} request failed after retries`);
}
