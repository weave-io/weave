/**
 * CSPRNG salt creation and SHA-256 salted fingerprinting for the Runtime Journal.
 *
 * - Salt creation uses `crypto.getRandomValues` (available in Bun) for ≥128 bits entropy.
 * - Fingerprinting uses `crypto.subtle.digest` (Web Crypto API, available in Bun).
 * - Fingerprints replace raw prompt/completion content — raw content is never stored.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import { ResultAsync } from "neverthrow";
import type { RuntimeStoreError } from "./errors.js";
import { journalWriteError } from "./errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of random bytes for the project salt (16 bytes = 128 bits). */
const SALT_BYTE_LENGTH = 16;

// ---------------------------------------------------------------------------
// Salt creation
// ---------------------------------------------------------------------------

/**
 * Create a new per-project CSPRNG salt with ≥128 bits of entropy.
 *
 * Uses `crypto.getRandomValues` (available in Bun and all modern runtimes).
 * Returns the salt as a hex string for storage in `runtime_metadata`.
 *
 * A new salt is created each time a `RuntimeStore` is initialized, intentionally
 * breaking cross-store fingerprint correlation.
 */
export function createProjectSalt(): string {
  const bytes = new Uint8Array(SALT_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// SHA-256 salted fingerprinting
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 salted fingerprint of the given content string.
 *
 * The fingerprint is `SHA-256(salt + content)` encoded as a hex string.
 * MD5, SHA-1, and non-cryptographic hashes are forbidden by construction —
 * only `SHA-256` is passed to `crypto.subtle.digest`.
 *
 * Uses the Web Crypto API (`crypto.subtle.digest`), which is available in Bun
 * and all modern runtimes without importing `node:crypto`.
 *
 * Use this to store a correlation handle for prompt/completion content
 * without persisting the raw content itself.
 *
 * @param salt - The per-project hex salt from `runtime_metadata`.
 * @param content - The raw content to fingerprint (never stored).
 * @returns `ResultAsync<string, RuntimeStoreError>` — hex fingerprint or error.
 */
export function fingerprintContent(
  salt: string,
  content: string,
): ResultAsync<string, RuntimeStoreError> {
  const encoder = new TextEncoder();
  const data = encoder.encode(salt + content);
  return ResultAsync.fromPromise(
    crypto.subtle.digest("SHA-256", data).then((hashBuffer) =>
      Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    ),
    (cause) =>
      journalWriteError("Failed to compute SHA-256 fingerprint", cause),
  );
}
