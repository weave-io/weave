/**
 * Execution Lifecycle — startExecution implementation.
 *
 * The sole authorized entry point for durable workflow execution. Only
 * `startExecution` may create a `WorkflowInstance` or acquire an
 * `ExecutionLease`.
 *
 * @see docs/adr/0004-workflow-first-execution-contract.md
 */

import type { ResultAsync } from "neverthrow";
import { err, errAsync, ok, type Result } from "neverthrow";
import type { RuntimeStore } from "../runtime/store.js";
import { createOwnerId } from "../runtime/types.js";
import { validateAuthorizationSource } from "./authorization.js";
import { lifecycleNotFoundError, lifecycleValidationError } from "./errors.js";
import { mapConflictToLeaseConflict, mapStoreError } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  ExecutionAuthorizationSource,
  LifecycleEffect,
  LifecycleError,
  StartExecutionInput,
  StartExecutionOutput,
  WorkflowExecutionContext,
  WorkflowInstanceId,
} from "./types.js";

/**
 * Validate the workflow execution context and resolve the instance creation
 * fields (`workflowName`, `goal`, `slug`, `currentStepName`).
 */
function resolveInstanceFields(
  workflowInstanceId: WorkflowInstanceId,
  context: WorkflowExecutionContext | undefined,
): Result<
  {
    workflowName: string;
    goal: string;
    slug: string;
    currentStepName: string | undefined;
  },
  LifecycleError
> {
  if (context === undefined) {
    return ok({
      workflowName: workflowInstanceId,
      goal: workflowInstanceId,
      slug: workflowInstanceId,
      currentStepName: undefined,
    });
  }

  if (!context.workflowName) {
    return err(
      lifecycleValidationError(
        "context.workflowName is required",
        "context.workflowName",
      ),
    );
  }

  const workflowConfig = context.workflows[context.workflowName];
  if (workflowConfig === undefined) {
    return err(
      lifecycleNotFoundError(
        "workflow",
        context.workflowName,
        `Workflow "${context.workflowName}" not found in provided workflow map`,
      ),
    );
  }

  const firstStep = workflowConfig.steps[0];
  const currentStepName = firstStep?.name;

  return ok({
    workflowName: context.workflowName,
    goal: context.goal,
    slug: context.slug,
    currentStepName,
  });
}

/**
 * Start a new workflow execution.
 *
 * This is the **sole authorized entry point** for durable execution. Only
 * `startExecution` may create a `WorkflowInstance` or acquire an
 * `ExecutionLease`. No other lifecycle method, adapter hook, idle event,
 * continuation hook, or session observation may implicitly start execution.
 *
 * @param input - Execution start parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ leaseId, effects: [] })` on success, or a typed `LifecycleError`.
 */
export function startExecution(
  input: StartExecutionInput,
  store: RuntimeStore,
): ResultAsync<StartExecutionOutput, LifecycleError> {
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

  const authSource: ExecutionAuthorizationSource =
    input.authorizationSource ?? "user";
  const authCheck = validateAuthorizationSource(authSource, "startExecution");
  if (authCheck.isErr()) return errAsync(authCheck.error);

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  const fieldsResult = resolveInstanceFields(
    input.workflowInstanceId,
    input.context,
  );
  if (fieldsResult.isErr()) return errAsync(fieldsResult.error);
  const fields = fieldsResult.value;

  const ownerId = createOwnerId(input.ownerId);

  return store.instances
    .findById(input.workflowInstanceId)
    .mapErr((storeError): LifecycleError => mapStoreError(storeError))
    .andThen((existing) => {
      if (existing === null) {
        return store.instances
          .create({
            id: input.workflowInstanceId,
            workflowName: fields.workflowName,
            goal: fields.goal,
            slug: fields.slug,
          })
          .mapErr((storeError): LifecycleError => mapStoreError(storeError))
          .andThen((created) => {
            const updateInput =
              fields.currentStepName !== undefined
                ? {
                    status: "running" as const,
                    currentStepName: fields.currentStepName,
                  }
                : { status: "running" as const };
            return store.instances
              .update(created.id, updateInput)
              .mapErr(
                (storeError): LifecycleError => mapStoreError(storeError),
              );
          });
      }
      const existingUpdateInput =
        fields.currentStepName !== undefined
          ? {
              status: "running" as const,
              currentStepName: fields.currentStepName,
            }
          : { status: "running" as const };
      return store.instances
        .update(existing.id, existingUpdateInput)
        .mapErr((storeError): LifecycleError => mapStoreError(storeError));
    })
    .andThen((instance) =>
      store.leases
        .acquire({
          workflowInstanceId: instance.id,
          ownerId,
          ttlMs: 3_600_000,
        })
        .mapErr((storeError): LifecycleError => {
          if (storeError.type === "conflict") {
            return mapConflictToLeaseConflict(instance.id, storeError);
          }
          return mapStoreError(storeError);
        }),
    )
    .map((lease) => ({
      workflowInstanceId: lease.workflowInstanceId,
      leaseId: lease.id,
      effects: [] as LifecycleEffect[],
    }));
}
