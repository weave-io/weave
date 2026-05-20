/**
 * RuntimeJournalWriter — the only adapter-facing journal emission API.
 *
 * Adapters call `RuntimeJournalWriter.write()` to emit journal entries.
 * The writer enforces:
 *   1. Fixed-envelope validation (required fields, structured source, severity)
 *   2. 64 KiB serialized payload size limit on the `data` field
 *   3. Denylist sanitization — rejects entries with secret/raw-content fields
 *   4. Delegates to the underlying `RuntimeJournalRepository.append()`
 *
 * Fingerprinting helpers are exposed separately via `packages/engine/src/runtime/fingerprint.ts`.
 * The writer itself does not fingerprint — callers fingerprint content before
 * placing it in `data`.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import { logger } from "../logger.js";
import type { RuntimeStoreError } from "./errors.js";
import { journalWriteError } from "./errors.js";
import { sanitizeJournalData } from "./sanitizer.js";
import type { RuntimeJournalRepository } from "./store.js";
import type {
  ExecutionLeaseId,
  JournalEntrySource,
  JournalSeverity,
  RuntimeJournalEntry,
  WorkflowInstanceId,
} from "./types.js";
import { JOURNAL_SEVERITIES } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum serialized size of the `data` field in bytes (64 KiB). */
const MAX_DATA_BYTES = 64 * 1024;

const log = logger.child({ module: "runtime-journal-writer" });

// ---------------------------------------------------------------------------
// WriteJournalEntryInput
// ---------------------------------------------------------------------------

/**
 * Input for writing a journal entry via `RuntimeJournalWriter`.
 *
 * Mirrors `RuntimeJournalEntry` minus `id` and `timestamp` (assigned by the writer).
 * All fields are validated before the entry is forwarded to the repository.
 */
export interface WriteJournalEntryInput {
  /** Structured source identifying the emitting component. */
  readonly source: JournalEntrySource;
  /** Logical event type identifier (e.g. "step.started", "lease.acquired"). */
  readonly eventType: string;
  /** The ExecutionLease active when this entry was recorded, if any. */
  readonly executionId?: ExecutionLeaseId;
  /** The WorkflowInstance this entry relates to, if any. */
  readonly workflowInstanceId?: WorkflowInstanceId;
  /** The step name this entry relates to, if any. */
  readonly stepId?: string;
  /** Severity level of this entry. */
  readonly severity: JournalSeverity;
  /**
   * Sanitized, size-bounded JSON data payload.
   * Must not contain raw prompts, completions, credentials, tokens, or PII.
   * Fingerprints (SHA-256 hex strings) may be stored here instead of raw content.
   */
  readonly data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

/**
 * Validate the fixed envelope fields of a `WriteJournalEntryInput`.
 *
 * Checks:
 * - `source.kind` is "engine" or "adapter"
 * - `source.name` is a non-empty string
 * - `eventType` is a non-empty string
 * - `severity` is one of the valid `JournalSeverity` values
 * - `data` is a plain object (not null, not array)
 *
 * Returns `ok(undefined)` if valid, or `err(journal_write)` if invalid.
 */
function validateEnvelope(
  input: WriteJournalEntryInput,
): Result<undefined, RuntimeStoreError> {
  if (input.source.kind !== "engine" && input.source.kind !== "adapter") {
    return err(
      journalWriteError(
        `Invalid source.kind: "${input.source.kind}". Must be "engine" or "adapter".`,
      ),
    );
  }

  if (
    typeof input.source.name !== "string" ||
    input.source.name.trim().length === 0
  ) {
    return err(journalWriteError("source.name must be a non-empty string."));
  }

  if (
    typeof input.eventType !== "string" ||
    input.eventType.trim().length === 0
  ) {
    return err(journalWriteError("eventType must be a non-empty string."));
  }

  if (!(JOURNAL_SEVERITIES as readonly string[]).includes(input.severity)) {
    return err(
      journalWriteError(
        `Invalid severity: "${input.severity}". Must be one of: ${JOURNAL_SEVERITIES.join(", ")}.`,
      ),
    );
  }

  if (
    input.data === null ||
    typeof input.data !== "object" ||
    Array.isArray(input.data)
  ) {
    return err(
      journalWriteError(
        "data must be a plain JSON object (not null, not an array).",
      ),
    );
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Payload size check
// ---------------------------------------------------------------------------

/**
 * Check that the serialized `data` payload does not exceed 64 KiB.
 *
 * Returns `ok(undefined)` if within limit, or `err(journal_write)` if exceeded.
 */
function checkPayloadSize(
  data: Record<string, unknown>,
): Result<undefined, RuntimeStoreError> {
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch (cause) {
    return err(
      journalWriteError(
        "Failed to serialize journal entry data for size check",
        cause,
      ),
    );
  }

  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > MAX_DATA_BYTES) {
    return err(
      journalWriteError(
        `Journal entry data exceeds the 64 KiB limit (${byteLength} bytes). ` +
          "Reduce the payload size or use fingerprints instead of raw content.",
      ),
    );
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// RuntimeJournalWriter
// ---------------------------------------------------------------------------

/**
 * The only adapter-facing journal emission API.
 *
 * Wraps a `RuntimeJournalRepository` and enforces:
 * - Envelope validation (required fields, structured source, valid severity)
 * - 64 KiB serialized payload size limit on `data`
 * - Denylist sanitization (rejects secret/raw-content fields)
 *
 * Adapters must use this writer — they must not call the repository directly.
 *
 * In best-effort mode (default), pre-flight validation failures are logged and
 * returned as errors. Repository `append()` failures are logged and swallowed
 * (returning `ok(undefined)`) so the surrounding transaction can still commit.
 * In strict mode, all failures propagate as `journal_write` errors.
 */
export class RuntimeJournalWriter {
  private readonly strictMode: boolean;

  constructor(
    private readonly repository: RuntimeJournalRepository,
    options: { strictMode?: boolean } = {},
  ) {
    this.strictMode = options.strictMode ?? false;
  }

  /**
   * Write a journal entry after validating the envelope, checking the payload
   * size limit, and sanitizing the `data` field.
   *
   * Returns `ResultAsync<RuntimeJournalEntry | undefined, RuntimeStoreError>`.
   *
   * In best-effort mode:
   * - Pre-flight failures (validation, sanitization, size) are logged and returned as errors.
   * - Repository `append()` failures are logged and swallowed — returns `ok(undefined)`
   *   so the surrounding transaction can commit.
   *
   * In strict mode, all failures propagate as errors.
   */
  write(
    input: WriteJournalEntryInput,
  ): ResultAsync<RuntimeJournalEntry | undefined, RuntimeStoreError> {
    // 1. Validate envelope
    const envelopeResult = validateEnvelope(input);
    if (envelopeResult.isErr()) {
      return this.handlePreflightError(envelopeResult.error);
    }

    // 2. Sanitize data
    const sanitizeResult = sanitizeJournalData(input.data);
    if (sanitizeResult.isErr()) {
      return this.handlePreflightError(sanitizeResult.error);
    }

    // 3. Check payload size
    const sizeResult = checkPayloadSize(input.data);
    if (sizeResult.isErr()) {
      return this.handlePreflightError(sizeResult.error);
    }

    // 4. Delegate to repository — handle failures per strict/best-effort mode
    return this.repository
      .append({
        source: input.source,
        eventType: input.eventType,
        executionId: input.executionId,
        workflowInstanceId: input.workflowInstanceId,
        stepId: input.stepId,
        severity: input.severity,
        data: sanitizeResult.value,
      })
      .orElse((error) => {
        if (this.strictMode) {
          return errAsync(error);
        }
        log.warn(
          { err: error },
          "Journal append failed (best-effort mode): " +
            (error.type === "journal_write" ? error.message : error.type),
        );
        return okAsync(undefined);
      });
  }

  /**
   * Handle a pre-flight validation/sanitization/size error.
   *
   * In best-effort mode: log a warning and return the error.
   * In strict mode: return the error directly.
   *
   * Pre-flight errors always propagate as errors (unlike repository failures
   * which are swallowed in best-effort mode) because they indicate a programming
   * error in the caller, not a transient infrastructure failure.
   */
  private handlePreflightError(
    error: RuntimeStoreError,
  ): ResultAsync<RuntimeJournalEntry | undefined, RuntimeStoreError> {
    if (!this.strictMode) {
      log.warn(
        { err: error },
        "Journal write rejected (best-effort mode): " +
          (error.type === "journal_write" ? error.message : error.type),
      );
    }
    return errAsync(error);
  }
}
