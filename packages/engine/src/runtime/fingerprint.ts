/**
 * CSPRNG salt creation and SHA-256 salted fingerprinting for the Runtime Journal.
 *
 * - Salt creation uses `crypto.getRandomValues` (available in Bun) for ≥128 bits entropy.
 * - Fingerprinting uses `node:crypto` SHA-256 (FIPS-approved; MD5/SHA-1 forbidden by construction).
 * - Fingerprints replace raw prompt/completion content — raw content is never stored.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import { createHash } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
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
  return Buffer.from(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// SHA-256 salted fingerprinting
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 salted fingerprint of the given content string.
 *
 * The fingerprint is `SHA-256(salt + content)` encoded as a hex string.
 * MD5, SHA-1, and non-cryptographic hashes are forbidden by construction —
 * only `sha256` is passed to `createHash`.
 *
 * Use this to store a correlation handle for prompt/completion content
 * without persisting the raw content itself.
 *
 * @param salt - The per-project hex salt from `runtime_metadata`.
 * @param content - The raw content to fingerprint (never stored).
 * @returns `Result<string, RuntimeStoreError>` — hex fingerprint or error.
 */
export function fingerprintContent(
  salt: string,
  content: string,
): Result<string, RuntimeStoreError> {
  try {
    const hash = createHash("sha256");
    hash.update(salt);
    hash.update(content);
    return ok(hash.digest("hex"));
  } catch (cause) {
    return err(
      journalWriteError("Failed to compute SHA-256 fingerprint", cause),
    );
  }
}
