/**
 * Runtime Command Operations — shared type vocabulary.
 *
 * Defines the harness-agnostic command-operation contract for the minimal
 * runtime lifecycle: operation kinds, typed inputs, typed success/failure/
 * degraded/unsupported results, effect projection seams, and renderer-ready
 * but harness-neutral result data.
 *
 * ## Design constraints
 *
 * - No OpenCode imports, concrete command names, concrete tool names, or
 *   harness plugin APIs appear in this module.
 * - All fallible operations return `ResultAsync<T, E>` from neverthrow.
 * - Result data is renderer-ready: adapters can format it for slash commands,
 *   plugin tools, UI actions, or scripts without duplicating lifecycle logic.
 * - Effect projection seams (`effects`) carry `LifecycleEffect` values that
 *   adapters apply through their own projection behavior.
 *
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 * @see docs/adapter-boundary.md
 * @see packages/engine/src/execution-lifecycle/types.ts — lifecycle I/O types
 * @see packages/engine/src/plan-state-provider.ts — plan existence/completion
 * @see packages/engine/src/runtime/store.ts — RuntimeStore
 */

import type { ResultAsync } from "neverthrow";
import type { AdapterHealthReport } from "../capability-contract.js";
import type {
  InspectExecutionOutput,
  LifecycleEffect,
  LifecycleError,
  StepCompletionSignal,
} from "../execution-lifecycle.js";
import type { PlanStateProvider } from "../plan-state-provider.js";
import type { RuntimeStore } from "../runtime/store.js";
import type {
  ExecutionLeaseId,
  WorkflowInstanceId,
  WorkflowInstanceStatus,
} from "../runtime/types.js";

// ---------------------------------------------------------------------------
// § 1 — Command Operation Kinds
// ---------------------------------------------------------------------------

/**
 * The closed set of runtime command operation kinds.
 *
 * - `start-plan`          — start execution of a named plan file.
 * - `run-named-workflow`  — explicitly run a named workflow (separate from plan execution).
 * - `inspect-status`      — read-only inspection of active execution state.
 * - `abort-execution`     — cancel or abort an active execution.
 * - `advance-step`        — advance or complete a blocked step.
 * - `runtime-health`      — report adapter/runtime readiness and command-entrypoint support.
 */
export type CommandOperationKind =
  | "start-plan"
  | "run-named-workflow"
  | "inspect-status"
  | "abort-execution"
  | "advance-step"
  | "runtime-health";

/** All valid `CommandOperationKind` values as a readonly tuple. */
export const COMMAND_OPERATION_KINDS = [
  "start-plan",
  "run-named-workflow",
  "inspect-status",
  "abort-execution",
  "advance-step",
  "runtime-health",
] as const satisfies readonly CommandOperationKind[];

// ---------------------------------------------------------------------------
// § 2 — Command Operation Result Outcomes
// ---------------------------------------------------------------------------

/**
 * The four possible outcomes for any command operation.
 *
 * - `success`     — the operation completed as intended.
 * - `failure`     — the operation failed due to a lifecycle or validation error.
 * - `degraded`    — the operation partially succeeded or ran with reduced capability.
 * - `unsupported` — the operation is not supported in the current adapter/harness context.
 */
export type CommandOperationOutcome =
  | "success"
  | "failure"
  | "degraded"
  | "unsupported";

/** All valid `CommandOperationOutcome` values as a readonly tuple. */
export const COMMAND_OPERATION_OUTCOMES = [
  "success",
  "failure",
  "degraded",
  "unsupported",
] as const satisfies readonly CommandOperationOutcome[];

// ---------------------------------------------------------------------------
// § 3 — Command Operation Errors
// ---------------------------------------------------------------------------

/**
 * Validation error for a command operation input.
 *
 * Returned when required fields are missing, malformed, or violate a
 * structural constraint before any lifecycle method is called.
 *
 * `maxSteps` is populated when `field === "maxSteps"` so callers can read
 * the structured value without parsing the human-readable `message`.
 */
export interface CommandValidationError {
  readonly type: "command_validation";
  readonly message: string;
  readonly field?: string;
  /** Structured step cap — present when `field === "maxSteps"`. */
  readonly maxSteps?: number;
}

/**
 * A referenced plan, workflow, or execution was not found.
 */
export interface CommandNotFoundError {
  readonly type: "command_not_found";
  readonly entity: "plan" | "workflow" | "execution" | "lease";
  readonly name: string;
  readonly message: string;
}

/**
 * The operation is not supported in the current adapter/harness context.
 */
export interface CommandUnsupportedError {
  readonly type: "command_unsupported";
  readonly operation: CommandOperationKind;
  readonly reason: string;
}

/**
 * The operation is supported but running in a degraded mode.
 */
export interface CommandDegradedError {
  readonly type: "command_degraded";
  readonly operation: CommandOperationKind;
  readonly reason: string;
  readonly partialResult?: CommandOperationResultData;
}

/**
 * A lifecycle error propagated from an underlying lifecycle method.
 */
export interface CommandLifecycleError {
  readonly type: "command_lifecycle";
  readonly operation: CommandOperationKind;
  readonly cause: LifecycleError;
}

/**
 * Discriminated union of all command operation error variants.
 */
export type CommandOperationError =
  | CommandValidationError
  | CommandNotFoundError
  | CommandUnsupportedError
  | CommandDegradedError
  | CommandLifecycleError;

// ---------------------------------------------------------------------------
// § 4 — Renderer-ready result data (harness-neutral)
// ---------------------------------------------------------------------------

/**
 * Renderer-ready summary for a start-plan or run-named-workflow operation.
 *
 * Adapters use this to format success/failure messages without duplicating
 * lifecycle state-transition logic.
 */
export interface ExecutionStartedData {
  readonly kind: "execution-started";
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly workflowName: string;
  readonly goal: string;
  readonly slug: string;
  /** Effects to be applied by the adapter's projection behavior. */
  readonly effects: readonly LifecycleEffect[];
}

/**
 * Renderer-ready summary for an inspect-status operation.
 *
 * Contains the full `InspectExecutionOutput` for adapters to render.
 */
export interface ExecutionStatusData {
  readonly kind: "execution-status";
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
  readonly hasActiveLease: boolean;
  /** Full inspection output for adapters that need additional fields. */
  readonly raw: InspectExecutionOutput;
}

/**
 * Renderer-ready summary for an abort-execution operation.
 */
export interface ExecutionAbortedData {
  readonly kind: "execution-aborted";
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly signal: "cancel" | "pause";
  /** Effects to be applied by the adapter's projection behavior. */
  readonly effects: readonly LifecycleEffect[];
}

/**
 * Renderer-ready summary for an advance-step operation.
 */
export interface StepAdvancedData {
  readonly kind: "step-advanced";
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly stepName: string;
  readonly completionSignal: StepCompletionSignal;
  /** Effects to be applied by the adapter's projection behavior. */
  readonly effects: readonly LifecycleEffect[];
}

/**
 * Renderer-ready summary for a runtime-health operation.
 */
export interface RuntimeHealthData {
  readonly kind: "runtime-health";
  /** Full adapter health report from the capability contract. */
  readonly healthReport: AdapterHealthReport;
  /** Whether the command-entrypoints capability is satisfied. */
  readonly commandEntrypointsSupported: boolean;
  /** Human-readable summary of degraded or unsupported operations. */
  readonly degradedOperations: readonly string[];
  /** Human-readable summary of unsupported operations. */
  readonly unsupportedOperations: readonly string[];
}

/**
 * Discriminated union of all renderer-ready result data variants.
 */
export type CommandOperationResultData =
  | ExecutionStartedData
  | ExecutionStatusData
  | ExecutionAbortedData
  | StepAdvancedData
  | RuntimeHealthData;

// ---------------------------------------------------------------------------
// § 5 — Command Operation Results (neverthrow ResultAsync)
// ---------------------------------------------------------------------------

/**
 * Result type for any command operation.
 *
 * `Ok` carries renderer-ready result data; `Err` carries a typed error.
 */
export type CommandOperationResult<
  T extends CommandOperationResultData = CommandOperationResultData,
> = ResultAsync<T, CommandOperationError>;

/**
 * Result type for the start-plan command operation.
 */
export type StartPlanResult = CommandOperationResult<ExecutionStartedData>;

/**
 * Result type for the run-named-workflow command operation.
 */
export type RunNamedWorkflowResult =
  CommandOperationResult<ExecutionStartedData>;

/**
 * Result type for the inspect-status command operation.
 */
export type InspectStatusResult = CommandOperationResult<ExecutionStatusData>;

/**
 * Result type for the abort-execution command operation.
 */
export type AbortExecutionResult = CommandOperationResult<ExecutionAbortedData>;

/**
 * Result type for the advance-step command operation.
 */
export type AdvanceStepResult = CommandOperationResult<StepAdvancedData>;

/**
 * Result type for the runtime-health command operation.
 */
export type RuntimeHealthResult = CommandOperationResult<RuntimeHealthData>;

/**
 * Input for the start-plan command operation.
 *
 * Adapters supply the plan name, the workflow name to use for execution,
 * the runtime store, and an optional plan state provider.
 *
 * The engine validates the plan via `planStateProvider` before creating
 * any `WorkflowInstance`. If `planStateProvider` is absent, the operation
 * returns a `command_validation` error.
 */
export interface StartPlanInput {
  /** Name of the plan file to start (validated via `planStateProvider`). */
  readonly planName: string;
  /**
   * Name of the workflow to use for plan execution.
   * Must exist in the adapter-supplied workflow registry.
   */
  readonly workflowName: string;
  /** Goal description for the workflow instance. */
  readonly goal: string;
  /** Slug for the workflow instance (used for plan file naming). */
  readonly slug: string;
  /** Owner identifier for the execution lease. */
  readonly ownerId: string;
  /** Runtime store for persisting the workflow instance and lease. */
  readonly store: RuntimeStore;
  /**
   * Provider for plan file existence checks.
   * Required — absence returns a `command_validation` error.
   */
  readonly planStateProvider: PlanStateProvider;
  /**
   * Workflow registry — maps workflow names to workflow configs.
   * Required for validating that `workflowName` exists.
   */
  readonly workflows: Record<string, unknown>;
  /** Optional ISO-8601 timestamp override (for testing). */
  readonly now?: string;
}

/**
 * Input for the run-named-workflow command operation.
 *
 * Named workflow execution is explicitly separate from ordinary plan execution.
 * Adapters supply the workflow name, goal, and runtime store.
 */
export interface RunNamedWorkflowInput {
  /** Name of the workflow to run (must exist in `workflows`). */
  readonly workflowName: string;
  /** Goal description for the workflow instance. */
  readonly goal: string;
  /** Slug for the workflow instance. */
  readonly slug: string;
  /** Owner identifier for the execution lease. */
  readonly ownerId: string;
  /** Runtime store for persisting the workflow instance and lease. */
  readonly store: RuntimeStore;
  /**
   * Workflow registry — maps workflow names to workflow configs.
   * Required for validating that `workflowName` exists.
   */
  readonly workflows: Record<string, unknown>;
  /**
   * Optional plan state provider for `plan_created` / `plan_complete`
   * completion methods.
   *
   * When a workflow step uses `plan_created` or `plan_complete` as its
   * completion method, the engine requires a `PlanStateProvider`. Adapters
   * supply this provider when their workflow may include plan-oriented steps.
   * Absent provider causes the engine to fail closed for those steps.
   */
  readonly planStateProvider?: PlanStateProvider;
  /**
   * Safety cap on the number of steps dispatched.
   *
   * Forwarded to `runWorkflowLifecycle`. Defaults to 100 when omitted.
   * Must be ≥ 1; values below 1 return a `command_validation` error.
   */
  readonly maxSteps?: number;
  /** Optional ISO-8601 timestamp override (for testing). */
  readonly now?: string;
}

/**
 * Input for the inspect-status command operation.
 *
 * Read-only — does not mutate any state.
 */
export interface InspectStatusInput {
  /** Workflow instance to inspect. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** Runtime store for reading the workflow instance. */
  readonly store: RuntimeStore;
}

/**
 * Input for the abort-execution command operation.
 *
 * Affects only the identified active execution.
 * Returns a typed error when the target is missing, already terminal, or ambiguous.
 */
export interface AbortExecutionInput {
  /** Workflow instance to abort. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** Active lease ID for the execution. */
  readonly leaseId: ExecutionLeaseId;
  /** Abort signal: `"cancel"` terminates; `"pause"` suspends. */
  readonly signal: "cancel" | "pause";
  /** Runtime store for reading/writing the workflow instance. */
  readonly store: RuntimeStore;
}

/**
 * Input for the advance-step command operation.
 *
 * Advances or completes a blocked step when no automatic completion signal
 * is available. Requires explicit workflow instance, lease, step name, and
 * completion signal.
 */
export interface AdvanceStepInput {
  /** Workflow instance containing the blocked step. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** Active lease ID for the execution. */
  readonly leaseId: ExecutionLeaseId;
  /** Name of the step to advance. */
  readonly stepName: string;
  /** Completion signal describing how the step finished. */
  readonly completionSignal: StepCompletionSignal;
  /** Runtime store for reading/writing the workflow instance. */
  readonly store: RuntimeStore;
  /**
   * Optional plan state provider for `plan_created` / `plan_complete`
   * completion methods.
   */
  readonly planStateProvider?: PlanStateProvider;
  /**
   * Workflow execution context for step completion routing.
   * Required when the step uses `plan_created` or `plan_complete` completion.
   */
  readonly context?: {
    readonly workflowName: string;
    readonly goal: string;
    readonly slug: string;
    readonly workflows: Record<string, unknown>;
  };
}

/**
 * Input for the runtime-health command operation.
 *
 * Pure — accepts explicit adapter-supplied health inputs and returns a
 * normalized health report without performing any harness I/O.
 */
export interface RuntimeHealthInput {
  /**
   * Adapter-supplied health report from the capability contract.
   * Adapters build this via `buildAdapterHealthReport` before calling
   * the health command operation.
   */
  readonly healthReport: AdapterHealthReport;
  /**
   * Explicit list of operations the adapter considers degraded.
   * Adapters populate this from their own capability assessment.
   */
  readonly degradedOperations?: readonly string[];
  /**
   * Explicit list of operations the adapter considers unsupported.
   * Adapters populate this from their own capability assessment.
   */
  readonly unsupportedOperations?: readonly string[];
}
