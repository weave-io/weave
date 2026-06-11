/**
 * Environment contract for `weave eval run`.
 *
 * Reads and validates environment variables required by the eval runner.
 * The primary concern is `OPENROUTER_API_KEY` — without it, the runner
 * cannot contact the OpenRouter inference API and must fail fast before any
 * eval execution begins.
 *
 * Design decisions:
 *   - All env reads go through a single `readEvalEnv()` call so every
 *     caller gets a typed, validated snapshot. There is no module-level
 *     global state; callers can inject a mock `env` in tests.
 *   - The API key value is carried inside `EvalEnv` as an opaque string.
 *     It is NEVER logged, interpolated into error messages, or serialized to
 *     disk. Callers must treat it as a secret.
 *   - `OPENROUTER_BASE_URL` must use `https://` in production. An `http://`
 *     scheme is only accepted when `allowHttpBaseUrl` is explicitly set to
 *     `true` — this option exists solely for integration tests targeting a
 *     local stub server and is never reachable from CLI or CI production env
 *     handling. Callers that do not pass this option always require `https://`.
 *
 * Required env vars:
 *   - `OPENROUTER_API_KEY` — OpenRouter API key. Must be non-empty.
 *
 * Optional env vars:
 *   - `OPENROUTER_BASE_URL` — Base URL for the OpenRouter API. Must start
 *     with `https://`. Defaults to `DEFAULT_OPENROUTER_BASE_URL`.
 */

import { err, ok, type Result } from "neverthrow";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The default OpenRouter API base URL.
 *
 * OpenRouter documentation: https://openrouter.ai/docs
 * All inference requests target the `/chat/completions` path under this URL.
 * The trailing slash is intentionally omitted so path construction via
 * template literals produces canonical URLs without double slashes.
 */
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Name of the required API key environment variable.
 * Exported so tests and error messages can reference the canonical name.
 */
export const OPENROUTER_API_KEY_ENV_VAR = "OPENROUTER_API_KEY";

/**
 * Name of the optional base URL override environment variable.
 */
export const OPENROUTER_BASE_URL_ENV_VAR = "OPENROUTER_BASE_URL";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Typed error returned when the environment is not correctly configured.
 *
 * The `MissingApiKey` variant is the only failure mode currently: any other
 * env validation issues (e.g. malformed base URL) are surfaced as separate
 * variants to keep the discriminated union extensible.
 */
export type EvalEnvError =
  | {
      type: "MissingApiKey";
      /** Name of the environment variable that was absent or empty. */
      envVar: string;
      /** Human-readable explanation. Does NOT include the key value. */
      message: string;
    }
  | {
      type: "InvalidBaseUrl";
      /** The raw URL value that failed validation. */
      value: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Validated environment snapshot
// ---------------------------------------------------------------------------

/**
 * A validated snapshot of the environment variables needed by the eval runner.
 *
 * Produced by `readEvalEnv()`. All fields have been validated. The `apiKey`
 * field is a secret — callers must not log or serialize it.
 */
export interface EvalEnv {
  /**
   * OpenRouter API key.
   *
   * SECURITY: treat as a secret. Never log, print, or include in error
   * messages. Pass directly to the HTTP client that constructs the
   * `Authorization` header.
   */
  readonly apiKey: string;
  /**
   * Base URL for the OpenRouter API.
   * Defaults to `DEFAULT_OPENROUTER_BASE_URL`.
   */
  readonly baseUrl: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read and validate the eval runner environment variables.
 *
 * Accepts an optional `env` map so tests can inject values without touching
 * the real process environment. When `env` is omitted, `Bun.env` is used.
 *
 * ## `allowHttpBaseUrl` — test-only escape hatch
 *
 * By default, `OPENROUTER_BASE_URL` must start with `https://`. Passing an
 * `http://` URL in a production or CI context would allow API keys to be
 * transmitted over an unencrypted connection.
 *
 * Setting `allowHttpBaseUrl: true` relaxes this constraint to permit `http://`
 * URLs. **This flag is only for integration tests that point at a local stub
 * server and must never be set from CLI flags, env variables, or CI workflow
 * steps.**
 *
 * Returns `ok(EvalEnv)` when all required variables are present and valid.
 * Returns `err(EvalEnvError)` immediately on the first validation failure —
 * callers should surface the error and abort before any eval execution.
 *
 * @example
 * ```ts
 * const envResult = readEvalEnv();
 * if (envResult.isErr()) {
 *   // surface envResult.error.message and exit
 * }
 * const { apiKey, baseUrl } = envResult.value;
 * // pass apiKey to OpenRouterClient — never log it
 * ```
 */
export function readEvalEnv(
  env: Record<string, string | undefined> = Bun.env,
  { allowHttpBaseUrl = false }: { allowHttpBaseUrl?: boolean } = {},
): Result<EvalEnv, EvalEnvError> {
  // --- Required: OPENROUTER_API_KEY ---
  const rawApiKey = env[OPENROUTER_API_KEY_ENV_VAR];
  if (rawApiKey === undefined || rawApiKey.trim() === "") {
    return err({
      type: "MissingApiKey",
      envVar: OPENROUTER_API_KEY_ENV_VAR,
      message:
        `${OPENROUTER_API_KEY_ENV_VAR} is required but was not set. ` +
        `Set it in your shell environment before running \`weave eval run\`. ` +
        `The key is available in your OpenRouter account settings at ` +
        `https://openrouter.ai/settings/keys`,
    });
  }

  const apiKey = rawApiKey;

  // --- Optional: OPENROUTER_BASE_URL ---
  const rawBaseUrl = env[OPENROUTER_BASE_URL_ENV_VAR];
  let baseUrl = DEFAULT_OPENROUTER_BASE_URL;

  if (rawBaseUrl !== undefined && rawBaseUrl.trim() !== "") {
    const trimmed = rawBaseUrl.trim();

    // Production requirement: only https:// is accepted by default.
    // The allowHttpBaseUrl flag permits http:// ONLY for test stub servers
    // and is never reachable through CLI/CI production code paths.
    const httpsOk = trimmed.startsWith("https://");
    const httpOk = allowHttpBaseUrl && trimmed.startsWith("http://");

    if (!httpsOk && !httpOk) {
      const schemeNote = allowHttpBaseUrl
        ? "an http:// or https:// URL"
        : "an https:// URL (http:// is not permitted in production)";
      return err({
        type: "InvalidBaseUrl",
        value: trimmed,
        message:
          `${OPENROUTER_BASE_URL_ENV_VAR} must be ${schemeNote}, ` +
          `but got a value that does not start with a recognized scheme. ` +
          `Remove ${OPENROUTER_BASE_URL_ENV_VAR} to use the default: ${DEFAULT_OPENROUTER_BASE_URL}`,
      });
    }
    // Strip trailing slash for consistent path construction downstream.
    baseUrl = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }

  return ok({ apiKey, baseUrl });
}
