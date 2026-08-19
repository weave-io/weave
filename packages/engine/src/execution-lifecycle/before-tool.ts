/**
 * Execution Lifecycle — beforeTool compatibility and static policy preview.
 *
 * `beforeTool` is the authoritative permission contract compatibility path. It accepts
 * only a registered call snapshot and delegates directly to PermissionSession.
 * The legacy one-capability evaluator lives in `previewToolPolicy`; its result
 * is informational and cannot authorize execution or establish readiness.
 */

import { err, errAsync, ok, okAsync, Result } from "neverthrow";
import {
  authorizePermissionSessionCall,
  validatePermissionSession,
} from "../permissions/session.js";
import {
  createExecutionLeaseId,
  createWorkflowInstanceId,
} from "../runtime/types.js";
import { ABSTRACT_CAPABILITIES } from "../tool-policy.js";
import { lifecycleValidationError } from "./errors.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  LifecycleValidationError,
  RegisteredBeforeToolInput,
  RegisteredBeforeToolResult,
  StaticToolPolicyPreviewInput,
  StaticToolPolicyPreviewOutput,
  StaticToolPolicyPreviewResult,
} from "./types.js";

const REGISTERED_INPUT_FIELDS = [
  "workflowInstanceId",
  "leaseId",
  "agentName",
  "toolName",
  "permission",
] as const;
const PERMISSION_CONTEXT_FIELDS = [
  "session",
  "project",
  "controllerSession",
  "registryGeneration",
  "call",
  "approvalUiAvailable",
] as const;

type SnapshotFields = ReadonlyMap<string, PropertyDescriptor>;
type ObjectLike<T> = T & object;

const isObjectLike = <T>(value: T): value is ObjectLike<T> =>
  value !== null && Object(value) === value;

const primitiveTag = <T>(value: T): string => {
  const tagged = Result.fromThrowable(
    () => Object.prototype.toString.call(value),
    () => "[object Object]",
  )();
  return tagged.isOk() ? tagged.value : "[object Object]";
};

const invalidPlainRecord = (
  path: string,
): ReturnType<typeof lifecycleValidationError> =>
  lifecycleValidationError(`${path} must be a plain object`, path);

/**
 * Snapshot a trusted-shaped record without invoking getters. All reflection is
 * inside one neverthrow boundary so hostile proxies cannot escape as throws.
 */
function snapshotPlainRecord<T>(
  input: T,
  fields: readonly string[],
  path: string,
): Result<SnapshotFields, LifecycleValidationError> {
  const reflected = Result.fromThrowable(
    () => {
      if (!isObjectLike(input)) return err(invalidPlainRecord(path));
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null)
        return err(invalidPlainRecord(path));

      const allowed = new Set(fields);
      const descriptors = new Map<string, PropertyDescriptor>();
      for (const key of Reflect.ownKeys(input)) {
        if (Object.prototype.toString.call(key) !== "[object String]")
          return err(
            lifecycleValidationError(
              `${path} has unexpected or missing fields`,
              path,
            ),
          );
        const field = String(key);
        if (!allowed.has(field))
          return err(
            lifecycleValidationError(
              `${path} has unexpected or missing fields`,
              path,
            ),
          );
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        )
          return err(
            lifecycleValidationError(
              `${path}.${field} must be an own enumerable data property`,
              `${path}.${field}`,
            ),
          );
        descriptors.set(field, descriptor);
      }
      if (descriptors.size !== fields.length)
        return err(
          lifecycleValidationError(
            `${path} has unexpected or missing fields`,
            path,
          ),
        );
      for (const field of fields)
        if (!descriptors.has(field))
          return err(
            lifecycleValidationError(
              `${path} has unexpected or missing fields`,
              path,
            ),
          );
      return ok(descriptors);
    },
    () => invalidPlainRecord(path),
  )();
  return reflected.andThen((result) => result);
}

function requiredText(
  fields: SnapshotFields,
  field: string,
): Result<string, LifecycleValidationError> {
  const value = fields.get(field)?.value;
  if (primitiveTag(value) !== "[object String]")
    return err(lifecycleValidationError(`${field} is required`, field));
  const text = String(value);
  if (text.length === 0)
    return err(lifecycleValidationError(`${field} is required`, field));
  return ok(text);
}

function requiredBoolean(
  fields: SnapshotFields,
  field: string,
): Result<boolean, LifecycleValidationError> {
  const value = fields.get(field)?.value;
  if (value !== true && value !== false)
    return err(lifecycleValidationError(`${field} must be boolean`, field));
  return ok(value);
}

function captureRegisteredInput<T>(
  input: T,
): Result<RegisteredBeforeToolInput, LifecycleValidationError> {
  const topLevel = snapshotPlainRecord(input, REGISTERED_INPUT_FIELDS, "input");
  if (topLevel.isErr()) return err(topLevel.error);

  const workflowInstanceId = requiredText(topLevel.value, "workflowInstanceId");
  if (workflowInstanceId.isErr()) return err(workflowInstanceId.error);
  const leaseId = requiredText(topLevel.value, "leaseId");
  if (leaseId.isErr()) return err(leaseId.error);
  const agentName = requiredText(topLevel.value, "agentName");
  if (agentName.isErr()) return err(agentName.error);
  const toolName = requiredText(topLevel.value, "toolName");
  if (toolName.isErr()) return err(toolName.error);

  const permission = snapshotPlainRecord(
    topLevel.value.get("permission")?.value,
    PERMISSION_CONTEXT_FIELDS,
    "permission",
  );
  if (permission.isErr()) return err(permission.error);
  const project = requiredText(permission.value, "project");
  if (project.isErr()) return err(project.error);
  const controllerSession = requiredText(permission.value, "controllerSession");
  if (controllerSession.isErr()) return err(controllerSession.error);
  const registryGeneration = requiredText(
    permission.value,
    "registryGeneration",
  );
  if (registryGeneration.isErr()) return err(registryGeneration.error);
  const approvalUiAvailable = requiredBoolean(
    permission.value,
    "approvalUiAvailable",
  );
  if (approvalUiAvailable.isErr()) return err(approvalUiAvailable.error);

  const session = validatePermissionSession(
    permission.value.get("session")?.value,
  );
  if (session.isErr())
    return err(
      lifecycleValidationError(
        "permission.session must be a PermissionSession instance",
        "permission.session",
      ),
    );

  return ok({
    workflowInstanceId: createWorkflowInstanceId(workflowInstanceId.value),
    leaseId: createExecutionLeaseId(leaseId.value),
    agentName: agentName.value,
    toolName: toolName.value,
    permission: {
      session: session.value,
      project: project.value,
      controllerSession: controllerSession.value,
      registryGeneration: registryGeneration.value,
      call: permission.value.get("call")?.value,
      approvalUiAvailable: approvalUiAvailable.value,
    },
  });
}

/**
 * Evaluate static abstract policy intent for display, diagnostics, or adapter
 * mapping. This helper never authorizes a call, issues a permit, or establishes
 * adapter readiness.
 */
export function previewToolPolicy(
  input: StaticToolPolicyPreviewInput,
): StaticToolPolicyPreviewResult {
  if (!input.workflowInstanceId)
    return errAsync(
      lifecycleValidationError(
        "workflowInstanceId is required",
        "workflowInstanceId",
      ),
    );
  if (!input.leaseId)
    return errAsync(lifecycleValidationError("leaseId is required", "leaseId"));
  if (!input.toolCapability)
    return errAsync(
      lifecycleValidationError("toolCapability is required", "toolCapability"),
    );
  if (!input.toolName)
    return errAsync(
      lifecycleValidationError("toolName is required", "toolName"),
    );
  if (!input.effectiveToolPolicy)
    return errAsync(
      lifecycleValidationError(
        "effectiveToolPolicy is required",
        "effectiveToolPolicy",
      ),
    );
  if (!ABSTRACT_CAPABILITIES.includes(input.toolCapability))
    return errAsync(
      lifecycleValidationError(
        `toolCapability '${input.toolCapability}' is not a recognized abstract capability`,
        "toolCapability",
      ),
    );
  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }
  const decision = input.effectiveToolPolicy[input.toolCapability];
  return okAsync({ decision } satisfies StaticToolPolicyPreviewOutput);
}

/**
 * Authorize one intercepted registered call through the permission contract permission
 * session. Legacy static-policy-shaped input is rejected by the exact-shape
 * snapshot instead of being dispatched to a fallback evaluator.
 *
 * Authorization uses the module-private non-virtual
 * {@link authorizePermissionSessionCall} entry so attacker-controlled own or
 * prototype `authorizeCall` methods cannot redirect the decision.
 */
export function beforeTool<T>(input: T): RegisteredBeforeToolResult {
  const captured = captureRegisteredInput(input);
  if (captured.isErr()) return errAsync(captured.error);
  const permission = captured.value.permission;
  return authorizePermissionSessionCall(permission.session, {
    project: permission.project,
    session: permission.controllerSession,
    agentName: captured.value.agentName,
    toolIdentity: captured.value.toolName,
    registryGeneration: permission.registryGeneration,
    call: permission.call,
    approvalUiAvailable: permission.approvalUiAvailable,
  });
}
