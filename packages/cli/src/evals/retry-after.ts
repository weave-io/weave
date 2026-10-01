/**
 * Reading an HTTP `Retry-After` header, for the eval clients that retry a
 * rate-limited call: the model client (`RateLimitRetryingModelClient`) and
 * the judge (`JevJudge`).
 */

/** The longest a `Retry-After` header may make a client wait. */
export const RETRY_AFTER_MAX_MS = 30_000;

/**
 * The wait a `Retry-After` header asks for, in milliseconds, capped at
 * `RETRY_AFTER_MAX_MS`. Accepts delta-seconds and an HTTP date; anything
 * else is ignored.
 */
export function retryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - now, 0), RETRY_AFTER_MAX_MS);
}
