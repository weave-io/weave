/**
 * Denylist-based sanitization helpers for the Runtime Journal and SessionSnapshot.
 *
 * Scans `data` JSON for known secret-like field names and either redacts or
 * rejects entries containing them. Raw prompts, completions, and transcripts
 * are also rejected.
 *
 * Design: denylist approach — any field whose key matches a known secret
 * pattern causes the entry to be rejected with a typed `journal_write` error.
 * This is intentionally strict: false positives are preferable to leaking
 * credentials or raw content.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import { err, ok, type Result } from "neverthrow";
import type { RuntimeStoreError } from "./errors.js";
import { journalWriteError } from "./errors.js";
import type { JsonObject } from "./types.js";

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

/**
 * Exact field name matches (case-insensitive) that trigger rejection.
 *
 * Covers:
 * - Auth/credential fields: token, apiKey, api_key, password, secret,
 *   authorization, cookie, bearer, accessToken, access_token, refreshToken,
 *   refresh_token, clientSecret, client_secret, privateKey, private_key
 * - Raw content fields: prompt, completion, transcript, rawPrompt, raw_prompt,
 *   rawCompletion, raw_completion, rawTranscript, raw_transcript
 */
const DENIED_FIELD_NAMES: ReadonlySet<string> = new Set([
  // Auth / credential fields
  "token",
  "apikey",
  "api_key",
  "password",
  "secret",
  "authorization",
  "cookie",
  "bearer",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "clientsecret",
  "client_secret",
  "privatekey",
  "private_key",
  "auth",
  "credentials",
  "credential",
  // Raw content fields
  "prompt",
  "completion",
  "transcript",
  "rawprompt",
  "raw_prompt",
  "rawcompletion",
  "raw_completion",
  "rawtranscript",
  "raw_transcript",
  "systemprompt",
  "system_prompt",
  "userprompt",
  "user_prompt",
  "assistantmessage",
  "assistant_message",
]);

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Check whether a field key matches the denylist (case-insensitive).
 */
function isDeniedKey(key: string): boolean {
  return DENIED_FIELD_NAMES.has(key.toLowerCase());
}

/** Sentinel returned by `findDeniedKey` when recursion exceeds the depth limit. */
const DEPTH_LIMIT_EXCEEDED = "__depth_limit_exceeded__" as const;

/**
 * Recursively scan a value for denied field names.
 *
 * Returns the first denied key found, `"__depth_limit_exceeded__"` when the
 * nesting depth exceeds the safety limit, or `null` if the value is clean.
 *
 * Exceeding the depth limit is treated as a rejection rather than a clean
 * result — deeply nested objects could hide denied keys beyond the scan
 * horizon and must not be silently persisted.
 */
function findDeniedKey(
  value: unknown,
  depth = 0,
): string | typeof DEPTH_LIMIT_EXCEEDED | null {
  // Limit recursion depth to avoid stack overflow on deeply nested objects.
  // Treat depth-limit as a rejection — denied keys could be hidden deeper.
  if (depth > 10) return DEPTH_LIMIT_EXCEEDED;
  if (value === null || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeniedKey(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isDeniedKey(key)) return key;
    const found = findDeniedKey(child, depth + 1);
    if (found !== null) return found;
  }

  return null;
}

/**
 * Validate that a `data` payload contains no denied field names.
 *
 * Returns `ok(data)` if clean, or `err(journal_write)` if a denied key is found.
 *
 * @param data - The journal entry `data` payload to validate.
 * @returns `Result<JsonObject, RuntimeStoreError>`
 */
export function sanitizeJournalData(
  data: JsonObject,
): Result<JsonObject, RuntimeStoreError> {
  const deniedKey = findDeniedKey(data);
  if (deniedKey === null) return ok(data);
  if (deniedKey === DEPTH_LIMIT_EXCEEDED) {
    return err(
      journalWriteError(
        "Journal entry data exceeds maximum nesting depth for safe sanitization.",
      ),
    );
  }
  return err(
    journalWriteError(
      `Journal entry data contains a denied field: "${deniedKey}". ` +
        "Raw prompts, completions, credentials, tokens, and secret-like fields must not be stored in journal entries.",
    ),
  );
}

/**
 * Validate that a `metadata` payload (for SessionSnapshot) contains no denied field names.
 *
 * Returns `ok(metadata)` if clean, or `err(journal_write)` if a denied key is found.
 *
 * @param metadata - The session snapshot metadata to validate.
 * @returns `Result<Record<string, string | number | boolean>, RuntimeStoreError>`
 */
export function sanitizeSnapshotMetadata(
  metadata: Record<string, string | number | boolean>,
): Result<Record<string, string | number | boolean>, RuntimeStoreError> {
  const deniedKey = findDeniedKey(metadata);
  if (deniedKey === null) return ok(metadata);
  if (deniedKey === DEPTH_LIMIT_EXCEEDED) {
    return err(
      journalWriteError(
        "Session snapshot metadata exceeds maximum nesting depth for safe sanitization.",
      ),
    );
  }
  return err(
    journalWriteError(
      `Session snapshot metadata contains a denied field: "${deniedKey}". ` +
        "Credentials, tokens, and secret-like fields must not be stored in session snapshots.",
    ),
  );
}
