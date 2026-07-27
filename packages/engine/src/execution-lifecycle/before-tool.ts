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

type SnapshotRecord = Record<string, unknown>;
type ReflectedEntry = {
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor | undefined;
};

/**
 * Snapshot a trusted-shaped record without invoking getters. All reflection is
 * inside one neverthrow boundary so hostile proxies cannot escape as throws.
 */
function snapshotPlainRecord(
  input: unknown,
  fields: readonly string[],
  path: string,
): Result<SnapshotRecord, LifecycleValidationError> {
  const reflected = Result.fromThrowable(
    () => {
      if (typeof input !== "object" || input === null)
        return { valid: false as const };
      const prototype = Object.getPrototypeOf(input);
      const keys = Reflect.ownKeys(input);
      const entries: ReflectedEntry[] = keys.map((key) => ({
        key,
        descriptor: Object.getOwnPropertyDescriptor(input, key),
      }));
      return { valid: true as const, prototype, entries };
    },
    () => lifecycleValidationError(`${path} must be a plain object`, path),
  )();
  if (reflected.isErr()) return err(reflected.error);
  if (!reflected.value.valid)
    return err(
      lifecycleValidationError(`${path} must be a plain object`, path),
    );
  if (
    reflected.value.prototype !== Object.prototype &&
    reflected.value.prototype !== null
  )
    return err(
      lifecycleValidationError(`${path} must be a plain object`, path),
    );
  if (reflected.value.entries.length !== fields.length)
    return err(
      lifecycleValidationError(
        `${path} has unexpected or missing fields`,
        path,
      ),
    );

  const snapshot: SnapshotRecord = {};
  const seen = new Set<string>();
  for (const entry of reflected.value.entries) {
    if (typeof entry.key !== "string" || !fields.includes(entry.key))
      return err(
        lifecycleValidationError(
          `${path} has unexpected or missing fields`,
          path,
        ),
      );
    if (seen.has(entry.key))
      return err(
        lifecycleValidationError(
          `${path} has unexpected or missing fields`,
          path,
        ),
      );
    seen.add(entry.key);
    const descriptor = entry.descriptor;
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    )
      return err(
        lifecycleValidationError(
          `${path}.${entry.key} must be an own enumerable data property`,
          `${path}.${entry.key}`,
        ),
      );
    snapshot[entry.key] = descriptor.value;
  }
  for (const field of fields)
    if (!seen.has(field))
      return err(
        lifecycleValidationError(
          `${path} has unexpected or missing fields`,
          path,
        ),
      );
  return ok(snapshot);
}

function requiredText(
  record: SnapshotRecord,
  field: string,
): Result<string, LifecycleValidationError> {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0)
    return err(lifecycleValidationError(`${field} is required`, field));
  return ok(value);
}

function captureRegisteredInput(
  input: RegisteredBeforeToolInput,
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
    topLevel.value.permission,
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
  if (typeof permission.value.approvalUiAvailable !== "boolean")
    return err(
      lifecycleValidationError(
        "approvalUiAvailable must be boolean",
        "permission.approvalUiAvailable",
      ),
    );

  const sessionCheck = validatePermissionSession(permission.value.session);
  if (sessionCheck.isErr())
    return err(
      lifecycleValidationError(
        "permission.session must be a PermissionSession instance",
        "permission.session",
      ),
    );

  return ok({
    workflowInstanceId:
      workflowInstanceId.value as RegisteredBeforeToolInput["workflowInstanceId"],
    leaseId: leaseId.value as RegisteredBeforeToolInput["leaseId"],
    agentName: agentName.value,
    toolName: toolName.value,
    permission: {
      session: permission.value
        .session as RegisteredBeforeToolInput["permission"]["session"],
      project: project.value,
      controllerSession: controllerSession.value,
      registryGeneration: registryGeneration.value,
      call: permission.value.call,
      approvalUiAvailable: permission.value.approvalUiAvailable,
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
  if (
    !(ABSTRACT_CAPABILITIES as readonly string[]).includes(input.toolCapability)
  )
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
export function beforeTool(
  input: RegisteredBeforeToolInput,
): RegisteredBeforeToolResult {
  const captured = captureRegisteredInput(input);
  if (captured.isErr()) return errAsync(captured.error);
  const permission = captured.value.permission;
  const session = validatePermissionSession(permission.session);
  if (session.isErr())
    return errAsync(
      lifecycleValidationError(
        "permission.session must be a PermissionSession instance",
        "permission.session",
      ),
    );
  // Non-virtual dispatch: never look up session.authorizeCall on the instance.
  return authorizePermissionSessionCall(session.value, {
    project: permission.project,
    session: permission.controllerSession,
    agentName: captured.value.agentName,
    toolIdentity: captured.value.toolName,
    registryGeneration: permission.registryGeneration,
    call: permission.call,
    approvalUiAvailable: permission.approvalUiAvailable,
  });
}
