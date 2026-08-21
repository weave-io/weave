/**
 * Bounded recovery pointer persistence (Pi adapter contract). Pi's own JSONL entries
 * hold correlation only - never the Runtime Store's authoritative state.
 * `PiWeaveRecoveryPointerV1` is deliberately narrow: after a matching
 * Runtime Store commit succeeds, the adapter appends one pointer; on
 * restart the newest *valid* pointer on the active branch is only ever
 * compared against the Runtime Store (which always wins) - it never
 * authorizes work by itself, and a pointer-append failure degrades
 * telemetry without rolling back or repeating the already-committed write.
 */

import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  makeSessionPointerAppendFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { JsonValue } from "./strict-json.js";
import { parseStrictJson } from "./strict-json.js";

export const RECOVERY_POINTER_SCHEMA_VERSION = 1 as const;

const boundedId = z.string().min(1).max(256);

/** Bounded, history-facing linkage only. It contains identifiers, never text. */
export const PiWorkflowAttemptLinkageSchema = z
  .object({
    attemptId: boundedId,
    previousAttemptId: boundedId.optional(),
  })
  .strict();
export type PiWorkflowAttemptLinkage = z.infer<
  typeof PiWorkflowAttemptLinkageSchema
>;

export const PiWeaveRecoveryPointerSchema = z
  .object({
    schemaVersion: z.literal(RECOVERY_POINTER_SCHEMA_VERSION),
    workflowId: boundedId.optional(),
    leaseId: boundedId.optional(),
    controllerGeneration: boundedId,
    /** False trust and quarantine markers always fail closed. */
    trusted: z.boolean().optional(),
    quarantined: z.boolean().optional(),
    attempt: PiWorkflowAttemptLinkageSchema.optional(),
    planName: z.string().min(1).optional(),
    planRevision: z.number().int().nonnegative().optional(),
    status: z.enum(["recoverable", "terminal"]),
    observedAt: z.string().min(1).max(128),
  })
  .strict();

export type PiWeaveRecoveryPointerV1 = z.infer<
  typeof PiWeaveRecoveryPointerSchema
>;

/** planName and planRevision must appear together, never one without the other (Pi adapter contract). */
function hasConsistentPlanFields(candidate: PiWeaveRecoveryPointerV1): boolean {
  return (
    (candidate.planName === undefined) ===
    (candidate.planRevision === undefined)
  );
}

export type RecoveryPointerValidationFailure =
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "unknown-version" };

type RecoveryPointerInput =
  | JsonValue
  | Readonly<Record<string, JsonValue | undefined>>;

/** Never throws; malformed/unknown-version pointers are a deduplicated diagnostic, never a crash. */
export function parseRecoveryPointer(
  raw: RecoveryPointerInput,
): Result<PiWeaveRecoveryPointerV1, RecoveryPointerValidationFailure> {
  const parsed = PiWeaveRecoveryPointerSchema.safeParse(raw);
  if (!parsed.success) {
    const versionIssue = parsed.error.issues.some(
      (issue) => issue.path[0] === "schemaVersion",
    );
    if (versionIssue) return err({ kind: "unknown-version" });
    return err({
      kind: "malformed",
      reason: parsed.error.issues[0]?.message ?? "invalid shape",
    });
  }
  if (!hasConsistentPlanFields(parsed.data)) {
    return err({
      kind: "malformed",
      reason: "planName and planRevision must appear together",
    });
  }
  return ok(parsed.data);
}

/**
 * A pointer is stale/mismatched relative to the *current* controller
 * generation when its `controllerGeneration` doesn't match. Automatic
 * recovery (startup hooks, continuation) must never treat a stale-generation
 * pointer as authorizing anything.
 */
export function isPointerForCurrentGeneration(
  pointer: PiWeaveRecoveryPointerV1,
  currentGenerationId: string,
): boolean {
  return pointer.controllerGeneration === currentGenerationId;
}

/**
 * Check if a pointer is eligible for explicit resume (user-confirmed
 * /weave:resume). Terminal pointers always fail closed. Recoverable pointers
 * are eligible even from a prior generation - the pointer provides
 * correlation only; the Runtime Store and lease semantics remain
 * authoritative (Issue #21 S019/S020).
 */
export function isPointerEligibleForExplicitResume(
  pointer: PiWeaveRecoveryPointerV1,
): boolean {
  return (
    pointer.status === "recoverable" &&
    pointer.trusted !== false &&
    pointer.quarantined !== true
  );
}

/**
 * Creates the metadata for a fresh workflow attempt. The identifiers are the
 * only linkage exported to history; callers must not place prompts,
 * transcripts, interventions, or task text in this object.
 */
export type WorkflowAttemptLinkageValidationFailure = {
  readonly kind: "malformed";
  readonly reason: "attempt-id" | "previous-attempt-id";
};

type WorkflowAttemptLinkageInput = {
  attemptId: string;
  previousAttemptId?: string;
};

/** Creates fresh attempt linkage without throwing on bounded input failures. */
export function createWorkflowAttemptLinkage(
  previousAttemptId: string | undefined,
  newAttemptId?: string,
): Result<PiWorkflowAttemptLinkage, WorkflowAttemptLinkageValidationFailure> {
  // Keep UUID generation inside the Result boundary: crypto providers and
  // test doubles are allowed to fail without throwing from this API.
  const generated: Result<string, WorkflowAttemptLinkageValidationFailure> =
    Result.fromThrowable(
      () => newAttemptId ?? crypto.randomUUID(),
      () => ({ kind: "malformed" as const, reason: "attempt-id" as const }),
    )();
  if (generated.isErr()) {
    return err<
      PiWorkflowAttemptLinkage,
      WorkflowAttemptLinkageValidationFailure
    >(generated.error);
  }
  const attemptId = generated.value;
  // New attempts are always UUIDs. Previous IDs remain bounded strings so
  // pointers written by older adapter versions stay readable.
  if (!z.string().uuid().safeParse(attemptId).success) {
    return err<
      PiWorkflowAttemptLinkage,
      WorkflowAttemptLinkageValidationFailure
    >({ kind: "malformed", reason: "attempt-id" });
  }
  const linkageInput: WorkflowAttemptLinkageInput = { attemptId };
  if (previousAttemptId !== undefined) {
    linkageInput.previousAttemptId = previousAttemptId;
  }
  const parsed = PiWorkflowAttemptLinkageSchema.safeParse(linkageInput);
  if (!parsed.success) {
    return err<
      PiWorkflowAttemptLinkage,
      WorkflowAttemptLinkageValidationFailure
    >({
      kind: "malformed",
      reason:
        previousAttemptId === undefined ? "attempt-id" : "previous-attempt-id",
    });
  }
  return ok(parsed.data);
}

/**
 * Reconstructs the tracker-shaped `{ workflowInstanceId, leaseId }`
 * correlation an explicit `/weave:resume` needs from a durable recovery
 * pointer alone (Issue #21 S020).
 *
 * Reload/restart installs a fresh controller generation whose in-memory
 * `PiActiveWorkflowTracker` starts empty even though the durable pointer
 * file on disk survives - by design, this must never auto-resume anything
 * (S019). But once the user explicitly runs `/weave:resume`, the dispatcher
 * needs *some* correlation to hand `handleWeaveResume` (which only ever
 * reads the in-memory tracker, never the pointer store itself). This
 * function is that seam: pure, fails closed on anything that isn't a
 * recoverable pointer with both a known `workflowId` and `leaseId` -
 * malformed correlation data with either missing is never enough to seed,
 * even though `resumeExecution` itself later consumes only
 * `workflowInstanceId`. It never itself authorizes work - the caller still
 * owes the engine a fresh `controller.inspect()` / `resumeExecution()`
 * round trip, so the Runtime Store and lease semantics remain the only
 * authority over whether resume actually succeeds.
 */
export function activeInstanceFromRecoveryPointer(
  pointer: PiWeaveRecoveryPointerV1,
):
  | {
      workflowInstanceId: string;
      leaseId: string;
      controllerGeneration: string;
      attemptId?: string;
    }
  | undefined {
  if (!isPointerEligibleForExplicitResume(pointer)) return undefined;
  if (pointer.workflowId === undefined) return undefined;
  if (pointer.leaseId === undefined) return undefined;
  const activeInstance = {
    workflowInstanceId: pointer.workflowId,
    leaseId: pointer.leaseId,
    controllerGeneration: pointer.controllerGeneration,
  };
  if (pointer.attempt?.attemptId === undefined) return activeInstance;
  return {
    ...activeInstance,
    attemptId: pointer.attempt.attemptId,
  };
}

export interface PiRecoveryPointerStore {
  appendPointer(
    pointer: PiWeaveRecoveryPointerV1,
  ): ResultAsync<void, PiAdapterFailure>;
  /** Newest valid pointer on the active branch, skipping malformed/unknown-version lines. */
  readLatestPointer(): ResultAsync<
    PiWeaveRecoveryPointerV1 | undefined,
    PiAdapterFailure
  >;
}

/** In-memory fake for isolated tests. */
export class InMemoryRecoveryPointerStore implements PiRecoveryPointerStore {
  private readonly pointers: PiWeaveRecoveryPointerV1[] = [];
  private failNextAppend: string | undefined;

  setFailNextAppend(reason: string): void {
    this.failNextAppend = reason;
  }

  appendPointer(
    pointer: PiWeaveRecoveryPointerV1,
  ): ResultAsync<void, PiAdapterFailure> {
    if (this.failNextAppend !== undefined) {
      const reason = this.failNextAppend;
      this.failNextAppend = undefined;
      return errAsync(makeSessionPointerAppendFailedFailure(reason));
    }
    this.pointers.push(pointer);
    return ResultAsync.fromSafePromise(Promise.resolve());
  }

  readLatestPointer(): ResultAsync<
    PiWeaveRecoveryPointerV1 | undefined,
    PiAdapterFailure
  > {
    return ResultAsync.fromSafePromise(Promise.resolve(this.pointers.at(-1)));
  }

  all(): readonly PiWeaveRecoveryPointerV1[] {
    return this.pointers;
  }
}

/**
 * Bun-backed JSONL append/read implementation. Appends are newline-
 * delimited JSON; malformed lines are skipped when reading the latest
 * pointer (never thrown, never crash the read path). This module does not
 * itself prove no-follow containment of the runtime directory - it is
 * expected to be constructed with an already-verified path (the Runtime
 * Store activation path establishes that proof; scope is the
 * pointer record shape and read/append semantics, not a second containment
 * implementation).
 */
export class BunJsonlRecoveryPointerStore implements PiRecoveryPointerStore {
  constructor(private readonly filePath: string) {}

  appendPointer(
    pointer: PiWeaveRecoveryPointerV1,
  ): ResultAsync<void, PiAdapterFailure> {
    return ResultAsync.fromPromise(
      (async () => {
        const line = `${JSON.stringify(pointer)}\n`;
        const existing = await Bun.file(this.filePath)
          .text()
          .catch(() => "");
        await Bun.write(this.filePath, existing + line);
      })(),
      // Fixed, bounded reason only - never the raw thrown `Error.message`,
      // which for filesystem I/O failures routinely embeds the absolute
      // path being written.
      () => makeSessionPointerAppendFailedFailure("pointer-append-io-failed"),
    );
  }

  readLatestPointer(): ResultAsync<
    PiWeaveRecoveryPointerV1 | undefined,
    PiAdapterFailure
  > {
    return ResultAsync.fromPromise(
      (async () => {
        const text = await Bun.file(this.filePath)
          .text()
          .catch(() => "");
        const lines = text.split("\n").filter((line) => line.trim().length > 0);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const parsedJson = parseStrictJson(lines[i]);
          if (parsedJson.isErr()) continue;
          const validated = parseRecoveryPointer(parsedJson.value);
          if (validated.isOk()) return validated.value;
        }
        return;
      })(),
      // Fixed, bounded reason only - never the raw thrown `Error.message`.
      () => makeSessionPointerAppendFailedFailure("pointer-read-io-failed"),
    );
  }
}
