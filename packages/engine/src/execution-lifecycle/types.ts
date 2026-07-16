/**
 * Execution Lifecycle — shared types and I/O interfaces.
 *
 * Contains all input/output interfaces, effect types, result type aliases,
 * and the `SafeMetadata` type used across lifecycle modules.
 *
 * @see packages/engine/src/execution-lifecycle.ts — compatibility barrel
 * @see docs/adapter-boundary.md — Execution Lifecycle Surface section
 */

import type {
  AgentConfig,
  ReconciliationReason,
  WorkflowConfig,
} from "@weaveio/weave-core";
import type { ResultAsync } from "neverthrow";
import type { PlanStateProvider } from "../plan-state-provider.js";
import type { RunAgentEffect } from "../run-agent-effects.js";
import type {
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
} from "../runtime/types.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";

// Re-export types needed by consumers of this module
export type {
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
 * Structured signal describing how a workflow step finished.
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
  /**
   * Optional agent config map from the WeaveConfig.
   *
   * When provided, `dispatchStep` uses this to detect gate steps whose named
   * agent declares `review_models` and populates `RunAgentEffect.reviewFanOutIntent`
   * accordingly. Adapters then route those steps through `ReviewOrchestrator`.
   *
   * When absent, fan-out intent detection is skipped and all gate steps use
   * single-agent execution.
   */
  readonly agentConfigs?: Readonly<Record<string, AgentConfig>>;
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

export interface ResumeExecutionInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly ownerId: string;
  readonly authorizationSource?: ExecutionAuthorizationSource;
  readonly now?: string;
  readonly metadata?: SafeMetadata;
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
  /** Rendered step prompt text for adapter use (e.g. review fan-out). Never appears on RunAgentEffect. */
  readonly renderedPrompt?: string;
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
}

// ---------------------------------------------------------------------------
// 7. beforeTool — Input / Output
// ---------------------------------------------------------------------------

export interface BeforeToolInput {
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

export interface BeforeToolOutput {
  readonly decision: "allow" | "deny" | "ask";
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// 8. inspectExecution — Input / Output
// ---------------------------------------------------------------------------

export interface InspectExecutionInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly metadata?: SafeMetadata;
}

export interface InspectExecutionOutput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly status: import("../runtime/types.js").WorkflowInstanceStatus;
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
}

// ---------------------------------------------------------------------------
// 9. approveArtifact — Input / Output
// ---------------------------------------------------------------------------

export interface ApproveArtifactInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly artifactId: ArtifactId;
  readonly approvalState: "approved" | "rejected";
  readonly approverAgent: string;
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
export type BeforeToolResult = ResultAsync<BeforeToolOutput, LifecycleError>;
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
