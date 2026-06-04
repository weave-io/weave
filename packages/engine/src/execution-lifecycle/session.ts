/**
 * Execution Lifecycle — observeSession implementation.
 *
 * Records a normalized session observation as a `SessionSnapshot` in the
 * Runtime Store. This is a passive observation — it never creates instances,
 * acquires leases, or emits lifecycle effects.
 *
 * @see docs/adr/0004-workflow-first-execution-contract.md — Execution boundary
 */

import type { ResultAsync } from "neverthrow";
import { errAsync } from "neverthrow";
import type { RuntimeStore } from "../runtime/store.js";
import { lifecycleValidationError } from "./errors.js";
import { mapStoreError } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  LifecycleError,
  ObserveSessionInput,
  ObserveSessionOutput,
} from "./types.js";

/**
 * Record a normalized session observation as a `SessionSnapshot` in the
 * Runtime Store.
 *
 * ## Execution Boundary Invariant
 *
 * `observeSession` is a **passive observation** — it is NOT an execution
 * operation. It NEVER:
 * - Creates a `WorkflowInstance`
 * - Acquires an `ExecutionLease`
 * - Transitions instance status
 * - Emits `LifecycleEffect` values
 *
 * @param input - Normalized session observation from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ snapshotId })` on success, or a typed `LifecycleError`.
 */
export function observeSession(
  input: ObserveSessionInput,
  store: RuntimeStore,
): ResultAsync<ObserveSessionOutput, LifecycleError> {
  if (!input.workflowInstanceId) {
    return errAsync(
      lifecycleValidationError(
        "workflowInstanceId is required",
        "workflowInstanceId",
      ),
    );
  }
  if (!input.leaseId) {
    return errAsync(lifecycleValidationError("leaseId is required", "leaseId"));
  }
  if (!input.harnessName) {
    return errAsync(
      lifecycleValidationError("harnessName is required", "harnessName"),
    );
  }
  if (!input.agentName) {
    return errAsync(
      lifecycleValidationError("agentName is required", "agentName"),
    );
  }
  if (!input.sessionStatus) {
    return errAsync(
      lifecycleValidationError("sessionStatus is required", "sessionStatus"),
    );
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  const snapshotInput = {
    workflowInstanceId: input.workflowInstanceId,
    leaseId: input.leaseId,
    harnessName: input.harnessName,
    ...(input.harnessVersion ? { harnessVersion: input.harnessVersion } : {}),
    agentName: input.agentName,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.stepName ? { stepName: input.stepName } : {}),
    sessionStatus: input.sessionStatus,
    metadata: input.metadata ?? {},
  };

  return store.snapshots
    .record(snapshotInput)
    .mapErr((storeError) => mapStoreError(storeError))
    .map((snapshot) => ({ snapshotId: snapshot.id }));
}
