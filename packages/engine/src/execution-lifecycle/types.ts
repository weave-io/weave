/**
 * Execution Lifecycle — shared types and I/O interfaces.
 *
 * Contains all input/output interfaces, effect types, result type aliases,
 * and the `SafeMetadata` type used across lifecycle modules.
 *
 * @see packages/engine/src/execution-lifecycle.ts — compatibility barrel
 * @see docs/reference/execution-lifecycle.md
 */

import type { ReconciliationReason, WorkflowConfig } from "@weaveio/weave-core";
import type { ResultAsync } from "neverthrow";
import type {
  PermissionError,
  PermissionOutcome,
  PermissionSession,
} from "../permissions/index.js";
import type { PlanStateProvider } from "../plan-state-provider.js";
import type { RunAgentEffect } from "../run-agent-effects.js";
import type {
  ArtifactApprovalActor,
  ArtifactId,
  ArtifactInputDecl,
  ArtifactInputRole,
  ArtifactInputSummary,
  ArtifactRef,
  ArtifactRefInput,
  ConsumedArtifactRecord,
  ExecutionLease,
  ExecutionLeaseId,
  OwnerId,
  SessionSnapshotId,
  StepAttemptRecord,
  WorkflowInstance,
  WorkflowInstanceId,
  WorkflowInstanceStatus,
} from "../runtime/types.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";

// Re-export types needed by consumers of this module
export type {
  ArtifactApprovalActor,
  ArtifactId,
  ArtifactInputDecl,
  ArtifactInputRole,
  ArtifactInputSummary,
  ArtifactRef,
  ArtifactRefInput,
  ConsumedArtifactRecord,
  ExecutionLease,
  ExecutionLeaseId,
  SessionSnapshotId,
  StepAttemptRecord,
  WorkflowInstance,
  WorkflowInstanceId,
};

// ---------------------------------------------------------------------------
// SafeMetadata — structurally sanitized metadata type
// ---------------------------------------------------------------------------

/**
 * Sanitized metadata type for lifecycle inputs.
 *
 * Constrained to `Record<string, string | number | boolean>` to structurally
 * prevent the following from appearing in lifecycle inputs:
 * - Nested objects or arrays (which could carry raw prompts or credentials)
 * - Any field named like a credential (enforced by the sanitizer at runtime)
 *
 * EXPLICITLY EXCLUDED by this type:
 * - Raw prompts, completions, or transcripts (would require `string` values
 *   in nested objects — not possible with this flat record type)
 * - Credentials, tokens, cookies, authorization headers (flat string values
 *   are allowed but the sanitizer rejects known credential field names)
 * - Raw provider payloads (require nested objects — structurally excluded)
 * - Arrays of any kind (structurally excluded)
 *
 * Long string values are allowed (e.g. step names, agent names, model IDs)
 * but the field names are validated at runtime by the sanitizer.
 */
export type SafeMetadata = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// LifecycleError — discriminated union
// ---------------------------------------------------------------------------

/**
 * Invalid lifecycle input — a required field is missing, malformed, or
 * violates a structural constraint (e.g. SafeMetadata contains a denied key).
 */
export interface LifecycleValidationError {
  readonly type: "validation";
  readonly message: string;
  readonly field?: string;
}

/**
 * A referenced workflow instance, step, or session was not found.
 */
export interface LifecycleNotFoundError {
  readonly type: "not_found";
  readonly entity: string;
  readonly id: string;
  readonly message: string;
}

/**
 * An unexpired foreign lease blocks the requested operation.
 */
export interface LifecycleLeaseConflictError {
  readonly type: "lease_conflict";
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly conflictingLeaseId: ExecutionLeaseId;
  readonly message: string;
}

/**
 * An underlying Runtime Store write failed.
 */
export interface LifecyclePersistenceError {
  readonly type: "persistence";
  readonly message: string;
  readonly cause?: { readonly type: string; readonly message: string };
}

/**
 * Policy evaluation failed.
 */
export interface LifecyclePolicyDecisionError {
  readonly type: "policy_decision";
  readonly message: string;
  readonly rule?: string;
}

/**
 * Discriminated union of all lifecycle error variants.
 */
export type LifecycleError =
  | LifecycleValidationError
  | LifecycleNotFoundError
  | LifecycleLeaseConflictError
  | LifecyclePersistenceError
  | LifecyclePolicyDecisionError;

// ---------------------------------------------------------------------------
// LifecycleEffect — discriminated union
// ---------------------------------------------------------------------------

/**
 * Wraps a `RunAgentEffect` as a lifecycle dispatch effect.
 */
export interface DispatchAgentEffect {
  readonly kind: "dispatch-agent";
  readonly runAgent: RunAgentEffect;
}

/**
 * Signals that the current execution should be paused.
 */
export interface PauseExecutionEffect {
  readonly kind: "pause-execution";
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly reason?: string;
}

/**
 * Signals that the current execution has completed.
 */
export interface CompleteExecutionEffect {
  readonly kind: "complete-execution";
  readonly workflowInstanceId: WorkflowInstanceId;
}

/**
 * Discriminated union of all lifecycle effects.
 */
export type LifecycleEffect =
  | DispatchAgentEffect
  | PauseExecutionEffect
  | CompleteExecutionEffect;

// ---------------------------------------------------------------------------
// Step completion signal
// ---------------------------------------------------------------------------

/**
 * Structured signal describing how a workflow step completed.
 */
export interface StepCompletionSignal {
  readonly outcome: "success" | "blocked" | "failed" | "paused";
  readonly method?:
    | "agent_signal"
    | "user_confirm"
    | "review_verdict"
    | "plan_created"
    | "plan_complete";
  readonly approved?: boolean;
  readonly message?: string;
  readonly artifacts?: readonly ArtifactRefInput[];
  readonly nextStepHint?: string;
}

// ---------------------------------------------------------------------------
// WorkflowExecutionContext
// ---------------------------------------------------------------------------

/**
 * Workflow execution context passed to lifecycle methods.
 */
export interface WorkflowExecutionContext {
  readonly workflowName: string;
  readonly goal: string;
  readonly slug: string;
  readonly workflows: Record<string, WorkflowConfig>;
}

// ---------------------------------------------------------------------------
// ExecutionAuthorizationSource
// ---------------------------------------------------------------------------

/**
 * Discriminated union of the authorization sources for execution transitions.
 */
export type ExecutionAuthorizationSource = "user" | "agent" | "hook" | "event";

/** All valid `ExecutionAuthorizationSource` values as a readonly tuple. */
export const EXECUTION_AUTHORIZATION_SOURCES = [
  "user",
  "agent",
  "hook",
  "event",
] as const satisfies readonly ExecutionAuthorizationSource[];

// ---------------------------------------------------------------------------
// ExecutionOperationKind
// ---------------------------------------------------------------------------

/**
 * Discriminated union of the explicit execution operation kinds.
 */
export type ExecutionOperationKind =
  | "start"
  | "resume"
  | "pause"
  | "inspect"
  | "advance";

/** All valid `ExecutionOperationKind` values as a readonly tuple. */
export const EXECUTION_OPERATION_KINDS = [
  "start",
  "resume",
  "pause",
  "inspect",
  "advance",
] as const satisfies readonly ExecutionOperationKind[];

// ---------------------------------------------------------------------------
// ReconciliationAuthorizationSource
// ---------------------------------------------------------------------------

/**
 * The authorized source for each reconciliation reason.
 */
export type ReconciliationAuthorizationSource =
  | "user"
  | "runtime"
  | "review-gate"
  | "security-gate";

/** All valid `ReconciliationAuthorizationSource` values as a readonly tuple. */
export const RECONCILIATION_AUTHORIZATION_SOURCES = [
  "user",
  "runtime",
  "review-gate",
  "security-gate",
] as const satisfies readonly ReconciliationAuthorizationSource[];

/**
 * The closed built-in reconciliation reason set.
 */
export const RECONCILIATION_REASONS = [
  "execution-mismatch",
  "user-revision-request",
  "review-rejection",
  "security-rejection",
] as const satisfies readonly ReconciliationReason[];

// ---------------------------------------------------------------------------
// 1. observeSession — Input / Output
// ---------------------------------------------------------------------------

export interface ObserveSessionInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly harnessName: string;
  readonly harnessVersion?: string;
  readonly agentName: string;
  readonly modelId?: string;
  readonly stepName?: string;
  readonly sessionStatus: "active" | "idle" | "terminated";
  readonly metadata?: SafeMetadata;
}

export interface ObserveSessionOutput {
  readonly snapshotId: SessionSnapshotId;
}

// ---------------------------------------------------------------------------
// 2. startExecution — Input / Output
// ---------------------------------------------------------------------------

export interface StartExecutionInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly ownerId: string;
  readonly authorizationSource?: ExecutionAuthorizationSource;
  readonly now?: string;
  readonly metadata?: SafeMetadata;
  readonly context?: WorkflowExecutionContext;
}

export interface StartExecutionOutput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly effects: readonly LifecycleEffect[];
}

// ---------------------------------------------------------------------------
// 3. resumeExecution — Input / Output
// ---------------------------------------------------------------------------

/**
 * Explicit, user-authorized takeover correlation for one exact pre-reload
 * lease. Combined with the sibling
 * `workflowInstanceId`, this must match the active `ExecutionLease` exactly
 * (lease ID and owner) or `resumeExecution` fails closed with the ordinary
 * `lease_conflict` error - never a broad foreign-lease steal.
 */
export interface ResumeRecoveryTakeover {
  /** The exact lease ID the durable pointer correlated to this instance. */
  readonly expectedLeaseId: ExecutionLeaseId;
  /** The exact owner ID the currently active lease must be held by. */
  readonly expectedOwnerId: OwnerId;
}

export interface ResumeExecutionInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly ownerId: string;
  readonly authorizationSource?: ExecutionAuthorizationSource;
  readonly now?: string;
  readonly metadata?: SafeMetadata;
  /**
   * Optional explicit takeover correlation. See {@link ResumeRecoveryTakeover}.
   * Absent by default; ordinary resume behavior (acquire, replacing only an
   * already-expired lease) is unchanged when omitted.
   */
  readonly recoveryTakeover?: ResumeRecoveryTakeover;
}

export interface ResumeExecutionOutput {
  readonly leaseId: ExecutionLeaseId;
  readonly effects: readonly LifecycleEffect[];
}

// ---------------------------------------------------------------------------
// 4. handleUserInterrupt — Input / Output
// ---------------------------------------------------------------------------

export interface HandleUserInterruptInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly signal: "cancel" | "pause";
  readonly metadata?: SafeMetadata;
}

export interface HandleUserInterruptOutput {
  readonly effects: readonly LifecycleEffect[];
}

// ---------------------------------------------------------------------------
// 5. dispatchStep — Input / Output
// ---------------------------------------------------------------------------

export interface DispatchStepInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly stepName?: string;
  readonly metadata?: SafeMetadata;
  readonly context?: WorkflowExecutionContext;
  readonly pinnedArtifactRevisions?: readonly ConsumedArtifactRecord[];
  readonly artifactDigests?: Readonly<Record<string, string>>;
}

export interface DispatchStepOutput {
  readonly stepName: string;
  readonly effects: readonly LifecycleEffect[];
  readonly artifactInputSummary?: ArtifactInputSummary;
  /**
   * EPHEMERAL — the fully rendered `step.prompt` text for `stepName`, present
   * only when a configured step's prompt was rendered during this dispatch.
   *
   * This is NOT part of any `LifecycleEffect` and MUST NOT be persisted,
   * logged, or copied into one. Adapters read it exactly once, compose it
   * with their own resolved `AgentDescriptor.composedPrompt`, and discard it.
   * `RunAgentEffect.promptMetadata.byteLength` remains the only
   * effect-visible trace of the rendered prompt; see the Pi adapter's
   * composed-prompt security invariant.
   */
  readonly stepPromptText?: string;
}

// ---------------------------------------------------------------------------
// 6. completeStep — Input / Output
// ---------------------------------------------------------------------------

export interface CompleteStepInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly stepName: string;
  readonly completionSignal: StepCompletionSignal;
  readonly metadata?: SafeMetadata;
  readonly context?: WorkflowExecutionContext;
  readonly planStateProvider?: PlanStateProvider;
}

export interface CompleteStepOutput {
  readonly effects: readonly LifecycleEffect[];
  /**
   * EPHEMERAL — the fully rendered `step.prompt` text for the step targeted
   * by this output's `dispatch-agent` effect (if any), present only when
   * `completeStep` auto-advanced to a next step or re-dispatched a gate step
   * on retry. See `DispatchStepOutput.stepPromptText` for the same security
   * contract: never persisted, never logged, never copied into an effect.
   */
  readonly stepPromptText?: string;
}

// ---------------------------------------------------------------------------
// 7. beforeTool — Input / Output
// ---------------------------------------------------------------------------

/**
 * Non-authoritative static policy preview input.
 *
 * This describes adapter-resolved policy intent only. It does not prove that
 * a tool call is authorized to execute, establish adapter readiness, or issue
 * a permission permit.
 */
export interface StaticToolPolicyPreviewInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly agentName: string;
  readonly toolCapability:
    | "read"
    | "write"
    | "execute"
    | "delegate"
    | "network";
  readonly toolName: string;
  readonly effectiveToolPolicy: EffectiveToolPolicy;
  readonly metadata?: SafeMetadata;
}

export interface StaticToolPolicyPreviewOutput {
  readonly decision: "allow" | "deny" | "ask";
  readonly reason?: string;
}

export type StaticToolPolicyPreviewResult = ResultAsync<
  StaticToolPolicyPreviewOutput,
  LifecycleError
>;

/** Inputs for the authoritative, registered permission-session path. */
export interface RegisteredBeforeToolInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly agentName: string;
  readonly toolName: string;
  readonly permission: {
    readonly session: PermissionSession;
    readonly project: string;
    readonly controllerSession: string;
    readonly registryGeneration: string;
    readonly call: unknown;
    readonly approvalUiAvailable: boolean;
  };
}

export type RegisteredBeforeToolResult = ResultAsync<
  PermissionOutcome,
  LifecycleError | PermissionError
>;

// ---------------------------------------------------------------------------
// 8. inspectExecution — Input / Output
// ---------------------------------------------------------------------------

export interface InspectExecutionInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly metadata?: SafeMetadata;
}

export interface InspectExecutionOutput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly status: WorkflowInstanceStatus;
  readonly currentStepName?: string;
  readonly workflowName: string;
  readonly goal: string;
  readonly slug: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly errorMessage?: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly hasActiveLease: boolean;
  /**
   * All recorded step attempts for this instance, in dispatch order.
   *
   * Exposes `WorkflowInstance.stepAttempts` through the read-only
   * `inspectExecution` projection so
   * adapters can determine, before calling `dispatchStep`, whether the
   * current step already has a prior attempt and — if so — which exact
   * artifact revisions it consumed. This is what lets an adapter compute
   * `pinnedArtifactRevisions` that reuse the prior attempt's revisions on
   * retry (the engine's own default when `pinnedArtifactRevisions` is
   * omitted; see `latestAttemptForStep` in
   * `execution-lifecycle/artifacts.ts`) instead of re-deriving "latest
   * revision" from scratch, which silently rebinds to newer artifact
   * revisions and violates the no-automatic-latest-artifact-rebinding
   * invariant.
   */
  readonly stepAttempts: readonly StepAttemptRecord[];
}

// ---------------------------------------------------------------------------
// 9. approveArtifact — Input / Output
// ---------------------------------------------------------------------------

export interface ApproveArtifactInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly artifactId: ArtifactId;
  readonly approvalState: "approved" | "rejected";
  /**
   * Structured approval actor (user provenance or gate agent).
   * Replaces the bare `approverAgent` string.
   */
  readonly actor: ArtifactApprovalActor;
  /**
   * Expected artifact revision. Must match the stored revision or the
   * approval fails closed as a policy decision (`stale_revision`).
   */
  readonly expectedRevision: number;
  /**
   * When the artifact carries integrity metadata, callers must bind the
   * expected digest. Mismatch fails closed (`digest_mismatch`).
   */
  readonly expectedDigest?: string;
  /**
   * Required for agent actors so the engine can verify the agent is an
   * authorized gate on the active workflow definition.
   */
  readonly context?: WorkflowExecutionContext;
  readonly metadata?: SafeMetadata;
}

export interface ApproveArtifactOutput {
  readonly instance: WorkflowInstance;
}

// ---------------------------------------------------------------------------
// 10. reconcileExecution — Input / Output
// ---------------------------------------------------------------------------

export interface ReconcileExecutionInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly reason: ReconciliationReason;
  readonly authorizationSource: ReconciliationAuthorizationSource;
  readonly triggeringStepName?: string;
  readonly context?: WorkflowExecutionContext;
  readonly planStateProvider?: PlanStateProvider;
  readonly metadata?: SafeMetadata;
}

export interface ReconcileExecutionOutput {
  readonly handlerStepName?: string;
  readonly handlerFound: boolean;
  readonly effects: readonly LifecycleEffect[];
  readonly gateReRunStepName?: string;
  /**
   * EPHEMERAL — the fully rendered `step.prompt` text for `handlerStepName`,
   * present only when a handler step was found and dispatched. See
   * `DispatchStepOutput.stepPromptText` for the same security contract:
   * never persisted, never logged, never copied into an effect.
   */
  readonly stepPromptText?: string;
}

// ---------------------------------------------------------------------------
// Result type aliases (convenience)
// ---------------------------------------------------------------------------

export type ObserveSessionResult = ResultAsync<
  ObserveSessionOutput,
  LifecycleError
>;
export type StartExecutionResult = ResultAsync<
  StartExecutionOutput,
  LifecycleError
>;
export type ResumeExecutionResult = ResultAsync<
  ResumeExecutionOutput,
  LifecycleError
>;
export type HandleUserInterruptResult = ResultAsync<
  HandleUserInterruptOutput,
  LifecycleError
>;
export type DispatchStepResult = ResultAsync<
  DispatchStepOutput,
  LifecycleError
>;
export type CompleteStepResult = ResultAsync<
  CompleteStepOutput,
  LifecycleError
>;
export type InspectExecutionResult = ResultAsync<
  InspectExecutionOutput,
  LifecycleError
>;
export type ApproveArtifactResult = ResultAsync<
  ApproveArtifactOutput,
  LifecycleError
>;
export type ReconcileExecutionResult = ResultAsync<
  ReconcileExecutionOutput,
  LifecycleError
>;
