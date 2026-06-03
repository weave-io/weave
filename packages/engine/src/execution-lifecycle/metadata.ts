/**
 * Execution Lifecycle — metadata sanitization.
 *
 * Runtime enforcement of the SafeMetadata constraint: rejects any metadata
 * record containing credential-like or raw-content field names.
 *
 * @see packages/engine/src/execution-lifecycle/types.ts — SafeMetadata type
 */

import { err, ok, type Result } from "neverthrow";
import { lifecycleValidationError } from "./errors.js";
import type { LifecycleValidationError, SafeMetadata } from "./types.js";

/**
 * Denylist of field name fragments (lowercased) that must not appear in
 * lifecycle metadata. Checked case-insensitively against each key.
 */
const LIFECYCLE_DENIED_METADATA_KEYS: ReadonlySet<string> = new Set([
  // Credential/token keys
  "token",
  "apikey",
  "api_key",
  "password",
  "secret",
  "credential",
  "authorization",
  "bearer",
  "authheader",
  "auth_header",
  "apitoken",
  "api_token",
  "accesskey",
  "access_key",
  "sessionid",
  "session_id",
  "jwt",
  "cookie",
  "cookies",
  // Raw prompt/completion/transcript keys
  "prompt",
  "completion",
  "transcript",
  "message",
  "content",
  "rawprompt",
  "raw_prompt",
  "rawcompletion",
  "raw_completion",
  "rawtranscript",
  "raw_transcript",
  // Common token variants
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "oauthtoken",
  "oauth_token",
  "bearertoken",
  "bearer_token",
  // Additional credential variants
  "privatekey",
  "private_key",
  "clientsecret",
  "client_secret",
  "x-api-key",
  "xapikey",
]);

/**
 * Runtime sanitization for lifecycle metadata.
 *
 * Checks each key in `metadata` against the denylist (case-insensitive).
 * Returns `ok(metadata)` if all keys are safe, or
 * `err(LifecycleValidationError)` if any denied key is found.
 */
export function sanitizeMetadata(
  metadata: SafeMetadata,
): Result<SafeMetadata, LifecycleValidationError> {
  for (const key of Object.keys(metadata)) {
    if (LIFECYCLE_DENIED_METADATA_KEYS.has(key.toLowerCase())) {
      return err(
        lifecycleValidationError(
          `Metadata contains a denied field: ${key}`,
          "metadata",
        ),
      );
    }
  }
  return ok(metadata);
}
