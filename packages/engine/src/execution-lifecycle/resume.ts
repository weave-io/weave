/**
 * Execution Lifecycle — resumeExecution implementation.
 *
 * Resumes a paused or blocked workflow execution. Acquires a new lease
 * (replacing any expired lease) and transitions the instance to `running`.
 *
 * Optional `recoveryTakeover` (Issue #21 Task 12 S020) lets a fresh owner
 * take over one exact pre-reload lease: in one atomic transaction, the
 * active lease must match `workflowInstanceId` + `expectedLeaseId` +
 * `expectedOwnerId` exactly before release (its own owner) and fresh
 * acquire. Any mismatch, terminal instance, or malformed correlation fails
 * closed with no mutation — never a broad foreign-lease steal. Takeover
 * also requires `authorizationSource === "user"` explicitly (never
 * defaulted); ordinary resume keeps the prior default-to-`"user"` behavior.
 *
 * @see docs/adr/0004-workflow-first-execution-contract.md
 * @see docs/adapters/pi.md#plans-artifacts-and-recovery
 */

import type { Result, ResultAsync } from "neverthrow";
import { err, errAsync, ok } from "neverthrow";
import {
  conflictError,
  notFoundError,
  type RuntimeStoreConflictError,
  type RuntimeStoreError,
} from "../runtime/errors.js";
import type {
  RuntimeStore,
  RuntimeStoreTransaction,
} from "../runtime/store.js";
import {
  createOwnerId,
  type ExecutionLease,
  type OwnerId,
  type WorkflowInstanceId,
} from "../runtime/types.js";
import { validateAuthorizationSource } from "./authorization.js";
import { lifecycleNotFoundError, lifecycleValidationError } from "./errors.js";
import { mapConflictToLeaseConflict, mapStoreError } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  ExecutionAuthorizationSource,
  LifecycleError,
  ResumeExecutionInput,
  ResumeExecutionOutput,
  ResumeRecoveryTakeover,
} from "./types.js";

/** Lease TTL granted on resume (1 hour). */
const RESUME_LEASE_TTL_MS = 3_600_000;

/** WorkflowInstance statuses that can never be resumed via takeover. */
const TERMINAL_INSTANCE_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function resumeExecution(
  input: ResumeExecutionInput,
  store: RuntimeStore,
): ResultAsync<ResumeExecutionOutput, LifecycleError> {
  if (!input.workflowInstanceId) {
    return errAsync(
      lifecycleValidationError(
        "workflowInstanceId is required",
        "workflowInstanceId",
      ),
    );
  }
  if (!input.ownerId) {
    return errAsync(lifecycleValidationError("ownerId is required", "ownerId"));
  }

  if (
    input.recoveryTakeover !== undefined &&
    input.authorizationSource !== "user"
  ) {
    return errAsync(
      lifecycleValidationError(
        'recoveryTakeover requires an explicit authorizationSource of "user"',
        "authorizationSource",
      ),
    );
  }

  const authSource: ExecutionAuthorizationSource =
    input.authorizationSource ?? "user";
  const authCheck = validateAuthorizationSource(authSource, "resumeExecution");
  if (authCheck.isErr()) return errAsync(authCheck.error);

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  const takeoverCheck = validateRecoveryTakeover(input.recoveryTakeover);
  if (takeoverCheck.isErr()) return errAsync(takeoverCheck.error);
  const takeover = takeoverCheck.value;

  const ownerId = createOwnerId(input.ownerId);
  const workflowInstanceId = input.workflowInstanceId;

  return store
    .transaction((tx) =>
      tx.instances
        .findById(workflowInstanceId)
        .andThen((existing): ResultAsync<ExecutionLease, RuntimeStoreError> => {
          if (existing === null) {
            return errAsync(
              notFoundError("WorkflowInstance", workflowInstanceId),
            );
          }
          if (
            takeover !== undefined &&
            TERMINAL_INSTANCE_STATUSES.has(existing.status)
          ) {
            return errAsync(
              conflictError(
                "WorkflowInstance",
                "Workflow instance is in a terminal status and cannot be resumed",
                workflowInstanceId,
              ),
            );
          }
          return acquireResumeLease(tx, workflowInstanceId, ownerId, takeover);
        })
        .andThen((lease) =>
          tx.instances
            .update(workflowInstanceId, { status: "running" })
            .map(() => lease),
        ),
    )
    .mapErr((storeError): LifecycleError => {
      if (storeError.type === "not_found") {
        return lifecycleNotFoundError(storeError.entity, storeError.id);
      }
      if (storeError.type === "conflict") {
        return mapConflictToLeaseConflict(workflowInstanceId, storeError);
      }
      return mapStoreError(storeError);
    })
    .map((lease) => ({ leaseId: lease.id, effects: [] }));
}

/** Validate an optional takeover correlation's shape before any store access. */
function validateRecoveryTakeover(
  takeover: ResumeRecoveryTakeover | undefined,
): Result<ResumeRecoveryTakeover | undefined, LifecycleError> {
  if (takeover === undefined) {
    return ok<ResumeRecoveryTakeover | undefined, LifecycleError>(void 0);
  }
  if (!takeover.expectedLeaseId?.trim()) {
    return err(
      lifecycleValidationError(
        "recoveryTakeover.expectedLeaseId is required",
        "recoveryTakeover.expectedLeaseId",
      ),
    );
  }
  if (!takeover.expectedOwnerId?.trim()) {
    return err(
      lifecycleValidationError(
        "recoveryTakeover.expectedOwnerId is required",
        "recoveryTakeover.expectedOwnerId",
      ),
    );
  }
  return ok(takeover);
}

/**
 * Without `takeover`, acquire behaves exactly as before (only an expired
 * lease is replaced). With `takeover`: no active lease means nothing to
 * take over, so acquire proceeds directly; an active lease must match
 * `workflowInstanceId` + `takeover` exactly, else fail closed with
 * `conflict` and no mutation.
 */
function acquireResumeLease(
  tx: RuntimeStoreTransaction,
  workflowInstanceId: WorkflowInstanceId,
  ownerId: OwnerId,
  takeover: ResumeRecoveryTakeover | undefined,
): ResultAsync<ExecutionLease, RuntimeStoreError> {
  const acquireFresh = (): ResultAsync<ExecutionLease, RuntimeStoreError> =>
    tx.leases.acquire({
      workflowInstanceId,
      ownerId,
      ttlMs: RESUME_LEASE_TTL_MS,
    });

  if (takeover === undefined) return acquireFresh();

  return tx.leases.findActive().andThen((activeLease) => {
    if (activeLease === null) return acquireFresh();

    const mismatch = matchTakeoverLease(
      activeLease,
      workflowInstanceId,
      takeover,
    );
    if (mismatch !== undefined) return errAsync(mismatch);

    return tx.leases
      .release(activeLease.id, activeLease.ownerId)
      .andThen(acquireFresh);
  });
}

/** Exact-match check; returns `undefined` on match or a typed conflict. */
function matchTakeoverLease(
  activeLease: ExecutionLease,
  workflowInstanceId: WorkflowInstanceId,
  takeover: ResumeRecoveryTakeover,
): RuntimeStoreConflictError | undefined {
  if (activeLease.workflowInstanceId !== workflowInstanceId) {
    return conflictError(
      "ExecutionLease",
      "Active lease belongs to a different workflow instance",
      activeLease.id,
    );
  }
  if (activeLease.id !== takeover.expectedLeaseId) {
    return conflictError(
      "ExecutionLease",
      "Active lease does not match the expected recovery lease",
      activeLease.id,
    );
  }
  if (activeLease.ownerId !== takeover.expectedOwnerId) {
    return conflictError(
      "ExecutionLease",
      "Active lease owner does not match the expected recovery owner",
      activeLease.id,
    );
  }
  return undefined;
}
