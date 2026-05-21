/**
 * Execution Lifecycle Surface for the Weave engine.
 *
 * Defines the 7 lifecycle methods that adapters call after mapping concrete
 * harness events into engine-owned policy decisions. This surface supersedes
 * the transitional `registerHook()` method on `HarnessAdapter`.
 *
 * ## Lifecycle Methods
 *
 * 1. `observeSession`    — adapter reports a normalized session observation
 * 2. `startExecution`    — adapter signals that a new workflow execution begins
 * 3. `resumeExecution`   — adapter signals that a paused execution resumes
 * 4. `handleUserInterrupt` — adapter signals a user-initiated interrupt
 * 5. `dispatchStep`      — adapter requests dispatch of the next workflow step
 * 6. `completeStep`      — adapter signals that a step has finished
 * 7. `beforeTool`        — adapter signals that a tool call is about to execute
 *
 * ## Security Invariants
 *
 * Input types structurally exclude raw prompts, completions, transcripts,
 * credentials, cookies, tokens, authorization headers, and raw provider
 * payloads. The `SafeMetadata` type enforces this at the type level.
 *
 * ## Error Handling
 *
 * All lifecycle errors are returned as `Result<T, LifecycleError>` from
 * neverthrow — never thrown. The `LifecycleError` discriminated union covers
 * the five failure modes: `validation`, `not_found`, `lease_conflict`,
 * `persistence`, and `policy_decision`.
 *
 * @see docs/adapter-boundary.md — Execution Lifecycle Surface section
 */

import type { Result } from "neverthrow";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { RunAgentEffect } from "./run-agent-effects.js";
import type { RuntimeStoreConflictError } from "./runtime/errors.js";
import type { RuntimeStore } from "./runtime/store.js";
import type {
  ArtifactRef,
  ExecutionLeaseId,
  SessionSnapshotId,
  WorkflowInstanceId,
} from "./runtime/types.js";
import { createOwnerId } from "./runtime/types.js";

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
  /** Human-readable description of the validation failure. */
  readonly message: string;
  /** The field or path that failed validation, if applicable. */
  readonly field?: string;
}

/**
 * A referenced workflow instance, step, or session was not found.
 */
export interface LifecycleNotFoundError {
  readonly type: "not_found";
  /** The entity type that was not found (e.g. "WorkflowInstance", "step"). */
  readonly entity: string;
  /** The ID or name that was looked up. */
  readonly id: string;
  /** Human-readable description. */
  readonly message: string;
}

/**
 * An unexpired foreign lease blocks the requested operation.
 *
 * Raised when attempting to start or resume execution while another owner
 * holds an unexpired lease on the same workflow instance.
 */
export interface LifecycleLeaseConflictError {
  readonly type: "lease_conflict";
  /** The workflow instance whose lease is in conflict. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The ID of the conflicting (unexpired) lease. */
  readonly conflictingLeaseId: ExecutionLeaseId;
  /** Human-readable description of the conflict. */
  readonly message: string;
}

/**
 * An underlying Runtime Store write failed.
 *
 * Wraps persistence-layer failures so callers do not need to import
 * `RuntimeStoreError` directly.
 */
export interface LifecyclePersistenceError {
  readonly type: "persistence";
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Underlying cause, if available. */
  readonly cause?: unknown;
}

/**
 * Policy evaluation failed — the engine could not compute a valid policy
 * decision for the given lifecycle input.
 */
export interface LifecyclePolicyDecisionError {
  readonly type: "policy_decision";
  /** Human-readable description of the policy failure. */
  readonly message: string;
  /** The policy capability or rule that could not be evaluated, if known. */
  readonly rule?: string;
}

/**
 * Discriminated union of all lifecycle error variants.
 *
 * All lifecycle methods return `Result<T, LifecycleError>` from neverthrow.
 * Errors are never thrown.
 */
export type LifecycleError =
  | LifecycleValidationError
  | LifecycleNotFoundError
  | LifecycleLeaseConflictError
  | LifecyclePersistenceError
  | LifecyclePolicyDecisionError;

// ---------------------------------------------------------------------------
// LifecycleError factory helpers
// ---------------------------------------------------------------------------

/** Create a LifecycleValidationError. */
export function lifecycleValidationError(
  message: string,
  field?: string,
): LifecycleValidationError {
  return { type: "validation", message, field };
}

/** Create a LifecycleNotFoundError. */
export function lifecycleNotFoundError(
  entity: string,
  id: string,
  message?: string,
): LifecycleNotFoundError {
  return {
    type: "not_found",
    entity,
    id,
    message: message ?? `${entity} '${id}' not found`,
  };
}

/** Create a LifecycleLeaseConflictError. */
export function lifecycleLeaseConflictError(
  workflowInstanceId: WorkflowInstanceId,
  conflictingLeaseId: ExecutionLeaseId,
  message: string,
): LifecycleLeaseConflictError {
  return {
    type: "lease_conflict",
    workflowInstanceId,
    conflictingLeaseId,
    message,
  };
}

/** Create a LifecyclePersistenceError. */
export function lifecyclePersistenceError(
  message: string,
  cause?: unknown,
): LifecyclePersistenceError {
  return { type: "persistence", message, cause };
}

/** Create a LifecyclePolicyDecisionError. */
export function lifecyclePolicyDecisionError(
  message: string,
  rule?: string,
): LifecyclePolicyDecisionError {
  return { type: "policy_decision", message, rule };
}

// ---------------------------------------------------------------------------
// LifecycleEffect — discriminated union
// ---------------------------------------------------------------------------

/**
 * Wraps a `RunAgentEffect` as a lifecycle dispatch effect.
 *
 * Emitted by `dispatchStep` when the engine determines that a workflow step
 * should be executed by spawning an agent.
 */
export interface DispatchAgentEffect {
  readonly kind: "dispatch-agent";
  /** The underlying run-agent effect carrying the agent descriptor and policy. */
  readonly runAgent: RunAgentEffect;
}

/**
 * Signals that the current execution should be paused.
 *
 * Emitted by `dispatchStep` or `completeStep` when a gate step rejects or
 * a step outcome is `"paused"`.
 */
export interface PauseExecutionEffect {
  readonly kind: "pause-execution";
  /** The workflow instance to pause. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** Optional human-readable reason for the pause. */
  readonly reason?: string;
}

/**
 * Signals that the current execution has completed.
 *
 * Emitted by `completeStep` when the final step of a workflow finishes
 * successfully.
 */
export interface CompleteExecutionEffect {
  readonly kind: "complete-execution";
  /** The workflow instance that completed. */
  readonly workflowInstanceId: WorkflowInstanceId;
}

/**
 * Discriminated union of all lifecycle effects.
 *
 * Effects are pure data records — they carry no side effects themselves.
 * Adapters receive them and apply harness-specific materialisation.
 *
 * Variants:
 * - `dispatch-agent` — wraps `RunAgentEffect`; the dispatch variant
 * - `pause-execution` — signals execution should be paused
 * - `complete-execution` — signals execution has completed
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
 *
 * Used as the `completionSignal` field in `CompleteStepInput`.
 *
 * Fields:
 * - `outcome` — the terminal state of the step
 * - `message` — optional safe human-readable message (no raw prompts/completions)
 * - `artifacts` — optional artifact references produced by the step
 * - `nextStepHint` — optional hint for the engine about which step to dispatch next
 */
export interface StepCompletionSignal {
  /** Terminal outcome of the step. */
  readonly outcome: "success" | "blocked" | "failed" | "paused";
  /**
   * Optional safe human-readable message describing the outcome.
   * Must not contain raw prompts, completions, credentials, or tokens.
   */
  readonly message?: string;
  /** Optional artifact references produced by this step. */
  readonly artifacts?: readonly ArtifactRef[];
  /**
   * Optional hint for the engine about which step to dispatch next.
   * The engine may ignore this hint if workflow topology dictates otherwise.
   */
  readonly nextStepHint?: string;
}

// ---------------------------------------------------------------------------
// 1. observeSession — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `observeSession`.
 *
 * Adapters call this to report a normalized session observation to the engine.
 * The engine may record this as a `SessionSnapshot` in the Runtime Store.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface ObserveSessionInput {
  /** The workflow instance this session is associated with. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The execution lease active during this session. */
  readonly leaseId: ExecutionLeaseId;
  /** Harness adapter name (e.g. "opencode", "claude-code"). */
  readonly harnessName: string;
  /** Harness adapter version string, if available. */
  readonly harnessVersion?: string;
  /** Name of the agent active in this session. */
  readonly agentName: string;
  /** Model identifier used in this session (no provider payload). */
  readonly modelId?: string;
  /** Current step name at the time of observation. */
  readonly stepName?: string;
  /** Normalized session status from the harness perspective. */
  readonly sessionStatus: "active" | "idle" | "terminated";
  /**
   * Structured, sanitized metadata about the session.
   * Must not contain raw prompts, completions, credentials, or tokens.
   */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `observeSession`.
 *
 * Returns the ID of the recorded `SessionSnapshot`.
 */
export interface ObserveSessionOutput {
  /** The ID of the recorded SessionSnapshot. */
  readonly snapshotId: SessionSnapshotId;
}

// ---------------------------------------------------------------------------
// 2. startExecution — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `startExecution`.
 *
 * Adapters call this when a new workflow execution begins. The engine
 * acquires an execution lease and transitions the workflow instance to
 * `running` status.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface StartExecutionInput {
  /** The workflow instance to start executing. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The owner identifier for the execution lease (e.g. session ID). */
  readonly ownerId: string;
  /** ISO 8601 timestamp for lease acquisition (defaults to now if omitted). */
  readonly now?: string;
  /** Optional structured metadata about the execution start. */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `startExecution`.
 *
 * Returns the acquired execution lease ID and the initial lifecycle effects.
 */
export interface StartExecutionOutput {
  /** The ID of the acquired execution lease. */
  readonly leaseId: ExecutionLeaseId;
  /** Initial lifecycle effects to apply (e.g. dispatch the first step). */
  readonly effects: readonly LifecycleEffect[];
}

// ---------------------------------------------------------------------------
// 3. resumeExecution — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `resumeExecution`.
 *
 * Adapters call this when a paused or blocked execution resumes. The engine
 * acquires a new execution lease (replacing any expired lease) and transitions
 * the workflow instance back to `running` status.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface ResumeExecutionInput {
  /** The workflow instance to resume. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The owner identifier for the new execution lease. */
  readonly ownerId: string;
  /** ISO 8601 timestamp for lease acquisition (defaults to now if omitted). */
  readonly now?: string;
  /** Optional structured metadata about the resume event. */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `resumeExecution`.
 *
 * Returns the new execution lease ID and the resume lifecycle effects.
 */
export interface ResumeExecutionOutput {
  /** The ID of the newly acquired execution lease. */
  readonly leaseId: ExecutionLeaseId;
  /** Lifecycle effects to apply on resume (e.g. re-dispatch the current step). */
  readonly effects: readonly LifecycleEffect[];
}

// ---------------------------------------------------------------------------
// 4. handleUserInterrupt — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `handleUserInterrupt`.
 *
 * Adapters call this when the user explicitly interrupts an in-progress
 * execution (e.g. pressing Ctrl+C, clicking a stop button, or issuing a
 * cancel command). The engine evaluates the interrupt policy and returns
 * the appropriate lifecycle effects.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface HandleUserInterruptInput {
  /** The workflow instance being interrupted. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The active execution lease at the time of interrupt. */
  readonly leaseId: ExecutionLeaseId;
  /**
   * The interrupt signal type.
   * - `cancel` — user wants to cancel the execution entirely
   * - `pause`  — user wants to pause and resume later
   */
  readonly signal: "cancel" | "pause";
  /** Optional structured metadata about the interrupt event. */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `handleUserInterrupt`.
 *
 * Returns the lifecycle effects resulting from the interrupt policy decision.
 */
export interface HandleUserInterruptOutput {
  /** Lifecycle effects to apply (e.g. pause or complete execution). */
  readonly effects: readonly LifecycleEffect[];
}

// ---------------------------------------------------------------------------
// 5. dispatchStep — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `dispatchStep`.
 *
 * Adapters call this to request dispatch of the next (or a specific) workflow
 * step. The engine evaluates the workflow topology, resolves the step's agent
 * and policy, and returns a `DispatchAgentEffect` wrapping a `RunAgentEffect`.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface DispatchStepInput {
  /** The workflow instance whose next step should be dispatched. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The active execution lease. */
  readonly leaseId: ExecutionLeaseId;
  /**
   * Optional explicit step name to dispatch.
   * When omitted, the engine determines the next step from workflow topology.
   */
  readonly stepName?: string;
  /** Optional structured metadata about the dispatch request. */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `dispatchStep`.
 *
 * Returns the lifecycle effects for the dispatched step. The primary effect
 * is a `DispatchAgentEffect` wrapping the `RunAgentEffect` for the step's agent.
 */
export interface DispatchStepOutput {
  /** The name of the step being dispatched. */
  readonly stepName: string;
  /** Lifecycle effects to apply (always includes a `dispatch-agent` effect). */
  readonly effects: readonly LifecycleEffect[];
}

// ---------------------------------------------------------------------------
// 6. completeStep — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `completeStep`.
 *
 * Adapters call this when a workflow step has finished. The engine records
 * the completion, updates the workflow instance, and returns the next
 * lifecycle effects (e.g. dispatch the next step, pause, or complete).
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface CompleteStepInput {
  /** The workflow instance whose step completed. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The active execution lease. */
  readonly leaseId: ExecutionLeaseId;
  /** The name of the step that completed. */
  readonly stepName: string;
  /** Structured signal describing how the step finished. */
  readonly completionSignal: StepCompletionSignal;
  /** Optional structured metadata about the completion event. */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `completeStep`.
 *
 * Returns the lifecycle effects following step completion.
 */
export interface CompleteStepOutput {
  /** Lifecycle effects to apply (e.g. dispatch next step, pause, or complete). */
  readonly effects: readonly LifecycleEffect[];
}

// ---------------------------------------------------------------------------
// 7. beforeTool — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `beforeTool`.
 *
 * Adapters call this immediately before a tool call executes. The engine
 * evaluates the abstract tool policy and returns a policy decision.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads, tool arguments
 * (which may contain sensitive data).
 */
export interface BeforeToolInput {
  /** The workflow instance in which the tool call occurs. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The active execution lease. */
  readonly leaseId: ExecutionLeaseId;
  /** The name of the agent making the tool call. */
  readonly agentName: string;
  /**
   * The abstract capability category of the tool being called.
   * Adapters map concrete harness tool names to these abstract categories.
   */
  readonly toolCapability:
    | "read"
    | "write"
    | "execute"
    | "delegate"
    | "network";
  /**
   * The harness-specific tool name (for logging/audit only).
   * Must not contain raw arguments, credentials, or sensitive data.
   */
  readonly toolName: string;
  /** Optional structured metadata about the tool call context. */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `beforeTool`.
 *
 * Returns the engine's policy decision for the tool call.
 */
export interface BeforeToolOutput {
  /**
   * The policy decision for this tool call.
   * - `allow` — the tool call is permitted; proceed
   * - `deny`  — the tool call is blocked; adapter should abort
   * - `ask`   — the engine defers to the user; adapter should prompt for approval
   */
  readonly decision: "allow" | "deny" | "ask";
  /**
   * Optional human-readable reason for the decision.
   * Must not contain raw prompts, completions, credentials, or tokens.
   */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Result type aliases (convenience)
// ---------------------------------------------------------------------------

/** Result type for `observeSession`. */
export type ObserveSessionResult = Result<ObserveSessionOutput, LifecycleError>;

/** Result type for `startExecution`. */
export type StartExecutionResult = Result<StartExecutionOutput, LifecycleError>;

/** Result type for `resumeExecution`. */
export type ResumeExecutionResult = Result<
  ResumeExecutionOutput,
  LifecycleError
>;

/** Result type for `handleUserInterrupt`. */
export type HandleUserInterruptResult = Result<
  HandleUserInterruptOutput,
  LifecycleError
>;

/** Result type for `dispatchStep`. */
export type DispatchStepResult = Result<DispatchStepOutput, LifecycleError>;

/** Result type for `completeStep`. */
export type CompleteStepResult = Result<CompleteStepOutput, LifecycleError>;

/** Result type for `beforeTool`. */
export type BeforeToolResult = Result<BeforeToolOutput, LifecycleError>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a `RuntimeStoreConflictError` to a `LifecycleLeaseConflictError`.
 *
 * The conflicting lease ID is extracted from `conflictingId` when present.
 */
function mapConflictToLeaseConflict(
  workflowInstanceId: WorkflowInstanceId,
  storeError: RuntimeStoreConflictError,
): LifecycleLeaseConflictError {
  const conflictingLeaseId = storeError.conflictingId
    ? (storeError.conflictingId as ExecutionLeaseId)
    : ("unknown" as ExecutionLeaseId);
  return lifecycleLeaseConflictError(
    workflowInstanceId,
    conflictingLeaseId,
    storeError.message,
  );
}

// ---------------------------------------------------------------------------
// 1. observeSession — implementation
// ---------------------------------------------------------------------------

/**
 * Record a normalized session observation as a `SessionSnapshot` in the
 * Runtime Store.
 *
 * Validates required fields, builds a `RecordSessionSnapshotInput`, and
 * delegates to `store.snapshots.record()`. The sanitizer inside the store
 * rejects metadata containing denied field names (credentials, raw content).
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
    .mapErr((storeError) =>
      lifecyclePersistenceError(storeError.message, storeError),
    )
    .map((snapshot) => ({ snapshotId: snapshot.id }));
}

// ---------------------------------------------------------------------------
// 2. startExecution — implementation
// ---------------------------------------------------------------------------

/**
 * Start a new workflow execution.
 *
 * Creates or updates the `WorkflowInstance` to `running` status and acquires
 * an `ExecutionLease`. Uses one clock source per operation: `input.now` if
 * provided, otherwise `new Date().toISOString()`.
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

  const ownerId = createOwnerId(input.ownerId);

  // Find or create the workflow instance, then update to running, then acquire lease
  return store.instances
    .findById(input.workflowInstanceId)
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, storeError),
    )
    .andThen((existing) => {
      if (existing === null) {
        return store.instances
          .create({
            workflowName: input.workflowInstanceId,
            goal: input.workflowInstanceId,
            slug: input.workflowInstanceId,
          })
          .mapErr(
            (storeError): LifecycleError =>
              lifecyclePersistenceError(storeError.message, storeError),
          )
          .andThen((created) =>
            store.instances
              .update(created.id, { status: "running" })
              .mapErr(
                (storeError): LifecycleError =>
                  lifecyclePersistenceError(storeError.message, storeError),
              ),
          );
      }
      return store.instances
        .update(existing.id, { status: "running" })
        .mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, storeError),
        );
    })
    .andThen(() =>
      store.leases
        .acquire({
          workflowInstanceId: input.workflowInstanceId,
          ownerId,
          ttlMs: 3_600_000,
        })
        .mapErr((storeError): LifecycleError => {
          if (storeError.type === "conflict") {
            return mapConflictToLeaseConflict(
              input.workflowInstanceId,
              storeError,
            );
          }
          return lifecyclePersistenceError(storeError.message, storeError);
        }),
    )
    .map((lease) => ({ leaseId: lease.id, effects: [] as LifecycleEffect[] }));
}

// ---------------------------------------------------------------------------
// 3. resumeExecution — implementation
// ---------------------------------------------------------------------------

/**
 * Resume a paused or blocked workflow execution.
 *
 * Verifies the workflow instance exists, acquires a new lease (the store
 * replaces expired leases atomically), and updates the instance to `running`.
 * Returns a typed `lease_conflict` error when an unexpired foreign lease blocks
 * the operation.
 *
 * @param input - Resume parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ leaseId, effects: [] })` on success, or a typed `LifecycleError`.
 */
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

  const ownerId = createOwnerId(input.ownerId);

  return store.instances
    .findById(input.workflowInstanceId)
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, storeError),
    )
    .andThen((existing) => {
      if (existing === null) {
        return errAsync(
          lifecycleNotFoundError(
            "WorkflowInstance",
            input.workflowInstanceId as string,
          ),
        );
      }
      return store.leases
        .acquire({
          workflowInstanceId: input.workflowInstanceId,
          ownerId,
          ttlMs: 3_600_000,
        })
        .mapErr((storeError): LifecycleError => {
          if (storeError.type === "conflict") {
            return mapConflictToLeaseConflict(
              input.workflowInstanceId,
              storeError,
            );
          }
          return lifecyclePersistenceError(storeError.message, storeError);
        })
        .andThen((lease) =>
          store.instances
            .update(input.workflowInstanceId, { status: "running" })
            .mapErr(
              (storeError): LifecycleError =>
                lifecyclePersistenceError(storeError.message, storeError),
            )
            .map(() => lease),
        );
    })
    .map((lease) => ({
      leaseId: lease.id,
      effects: [] as LifecycleEffect[],
    }));
}
