/**
 * Execution Lifecycle Surface for the Weave engine.
 *
 * Defines the 8 lifecycle methods that adapters call after mapping concrete
 * harness events into engine-owned policy decisions.
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
 * 8. `inspectExecution`  — adapter queries execution state without side effects
 *
 * ## Explicit Execution Operations vs. Observation
 *
 * The lifecycle surface distinguishes two categories of operations:
 *
 * **Explicit execution operations** (`ExecutionOperationKind`):
 * - `start`   — `startExecution`: sole authorized entry point for durable execution
 * - `resume`  — `resumeExecution`: resumes a paused or blocked execution
 * - `pause`   — `handleUserInterrupt` with `signal: "pause"`
 * - `inspect` — `inspectExecution`: read-only state query, no side effects
 * - `advance` — `dispatchStep` + `completeStep`: drive execution forward
 *
 * **Observation operations** (NOT execution operations):
 * - `observeSession`: records a session snapshot; CANNOT start, resume, or
 *   advance durable execution. Calling `observeSession` never creates a
 *   `WorkflowInstance` or acquires an `ExecutionLease`.
 *
 * This distinction enforces ADR 0004: ordinary Loom conversation, session idle
 * events, continuation hooks, and lifecycle observations are explicitly
 * forbidden from implicitly starting durable execution. Only an explicit,
 * user-authorized call to `startExecution` may begin durable execution.
 *
 * ## Security Invariants
 *
 * Input types structurally exclude raw prompts, completions, transcripts,
 * credentials, cookies, tokens, authorization headers, and raw provider
 * payloads. The `SafeMetadata` type enforces this at the type level.
 *
 * ## Error Handling
 *
 * All lifecycle errors are returned as `ResultAsync<T, LifecycleError>` from
 * neverthrow — never thrown. The `LifecycleError` discriminated union covers
 * the five failure modes: `validation`, `not_found`, `lease_conflict`,
 * `persistence`, and `policy_decision`.
 *
 * @see docs/adapter-boundary.md — Execution Lifecycle Surface section
 * @see docs/adr/0004-workflow-first-execution-contract.md — Execution boundary
 */

import type {
  ReconciliationReason,
  WorkflowConfig,
  WorkflowStep,
} from "@weave/core";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import type {
  PlanStateError,
  PlanStateProvider,
} from "./plan-state-provider.js";
import type { RunAgentEffect } from "./run-agent-effects.js";
import type { RuntimeStoreConflictError } from "./runtime/errors.js";
import type { RuntimeStore } from "./runtime/store.js";
import type {
  ArtifactId,
  ArtifactInputDecl,
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
} from "./runtime/types.js";
import { createOwnerId } from "./runtime/types.js";
import {
  type RendererError,
  renderTemplate,
  type TemplateContext,
} from "./template-renderer.js";
import {
  ABSTRACT_CAPABILITIES,
  type EffectiveToolPolicy,
  evaluateEffectiveToolPolicy,
} from "./tool-policy.js";

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
// Metadata sanitization — runtime enforcement
// ---------------------------------------------------------------------------

/**
 * Denylist of field name fragments (lowercased) that must not appear in
 * lifecycle metadata. Checked case-insensitively against each key.
 *
 * Extends the store-layer denylist with additional credential-like names
 * that are specific to the lifecycle surface (e.g. authHeader, jwt, sessionId).
 */
const LIFECYCLE_DENIED_METADATA_KEYS: ReadonlySet<string> = new Set([
  // Existing credential/token keys
  "token",
  "apikey",
  "api_key",
  "password",
  "secret",
  "credential",
  "authorization",
  "bearer",
  "authheader",
  "auth_header",
  "apitoken",
  "api_token",
  "accesskey",
  "access_key",
  "sessionid",
  "session_id",
  "jwt",
  "cookie",
  "cookies",
  // Raw prompt/completion/transcript keys
  "prompt",
  "completion",
  "transcript",
  "message",
  "content",
  "rawprompt",
  "raw_prompt",
  "rawcompletion",
  "raw_completion",
  "rawtranscript",
  "raw_transcript",
  // Common token variants
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "oauthtoken",
  "oauth_token",
  "bearertoken",
  "bearer_token",
  // Additional credential variants
  "privatekey",
  "private_key",
  "clientsecret",
  "client_secret",
  "x-api-key",
  "xapikey",
]);

/**
 * Runtime sanitization for lifecycle metadata.
 *
 * Checks each key in `metadata` against the denylist (case-insensitive).
 * Returns `ok(metadata)` if all keys are safe, or
 * `err(LifecycleValidationError)` if any denied key is found.
 *
 * @param metadata - The SafeMetadata record to validate.
 * @returns `Result<SafeMetadata, LifecycleValidationError>`
 */
export function sanitizeMetadata(
  metadata: SafeMetadata,
): Result<SafeMetadata, LifecycleValidationError> {
  for (const key of Object.keys(metadata)) {
    if (LIFECYCLE_DENIED_METADATA_KEYS.has(key.toLowerCase())) {
      return err(
        lifecycleValidationError(
          `Metadata contains a denied field: ${key}`,
          "metadata",
        ),
      );
    }
  }
  return ok(metadata);
}

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
  /**
   * Narrowed cause — preserves type discriminant and message only.
   * Prevents raw store internals (SQL, file paths, stack traces) from leaking.
   */
  readonly cause?: { readonly type: string; readonly message: string };
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
 * All lifecycle methods return `ResultAsync<T, LifecycleError>` from neverthrow.
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
  cause?: { readonly type: string; readonly message: string },
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
 * - `outcome`  — the terminal state of the step
 * - `method`   — the completion method being signalled (optional; when present
 *                the engine validates it against the step's declared method)
 * - `approved` — for `review_verdict` signals: `true` = approved, `false` = rejected
 * - `message`  — optional safe human-readable message (no raw prompts/completions)
 * - `artifacts` — optional artifact references produced by the step
 * - `nextStepHint` — optional hint for the engine about which step to dispatch next
 *
 * ## Completion method semantics
 *
 * | `method`         | Required fields | Engine behaviour                                   |
 * |------------------|-----------------|----------------------------------------------------|
 * | `agent_signal`   | —               | Treat as success; auto-advance                     |
 * | `user_confirm`   | —               | Treat as success; auto-advance                     |
 * | `review_verdict` | `approved`      | `true` → advance; `false` → apply `on_reject` policy |
 * | `plan_created`   | —               | Check `.weave/plans/<plan_name>.md` exists         |
 * | `plan_complete`  | —               | Check plan file has no `- [ ]` checkboxes          |
 *
 * When `method` is omitted the engine skips method validation (legacy path).
 */
export interface StepCompletionSignal {
  /** Terminal outcome of the step. */
  readonly outcome: "success" | "blocked" | "failed" | "paused";
  /**
   * The completion method being signalled.
   *
   * When provided and `context` is present in `CompleteStepInput`, the engine
   * validates this value against the step's declared `completion.method`.
   * A mismatch returns a typed `validation` error before any state changes.
   *
   * When omitted the engine skips method validation (legacy / adapter-driven path).
   */
  readonly method?:
    | "agent_signal"
    | "user_confirm"
    | "review_verdict"
    | "plan_created"
    | "plan_complete";
  /**
   * Gate verdict for `review_verdict` signals.
   *
   * - `true`  — the gate approved; the engine advances to the next step.
   * - `false` — the gate rejected; the engine applies the step's `on_reject` policy.
   *
   * Required when `method === "review_verdict"`. Ignored for other methods.
   */
  readonly approved?: boolean;
  /**
   * Optional safe human-readable message describing the outcome.
   * Must not contain raw prompts, completions, credentials, or tokens.
   */
  readonly message?: string;
  /**
   * Optional artifact references produced by this step.
   *
   * Agents provide name + path (and optional metadata). The store assigns
   * the stable ArtifactId, monotonic revision, and initial approvalState
   * when persisting via `WorkflowInstanceRepository.addArtifact()`.
   */
  readonly artifacts?: readonly ArtifactRefInput[];
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
 * Workflow execution context passed to `startExecution`.
 *
 * Provides the engine with the information it needs to:
 * 1. Validate that `workflowName` exists in the known workflow map.
 * 2. Populate the `WorkflowInstance` with the correct `workflowName`, `goal`,
 *    `slug`, and `currentStepName` (the name of the first step).
 *
 * The `workflows` map is a narrow slice of `WeaveConfig.workflows` — adapters
 * pass only what the engine needs rather than the full config object.
 */
export interface WorkflowExecutionContext {
  /**
   * The logical name of the workflow to execute (must exist in `workflows`).
   * Used as `workflowName` on the created `WorkflowInstance`.
   */
  readonly workflowName: string;
  /**
   * Human-readable goal for this execution instance.
   * Used as `goal` on the created `WorkflowInstance`.
   */
  readonly goal: string;
  /**
   * URL-safe slug for this execution instance (e.g. derived from the goal).
   * Used as `slug` on the created `WorkflowInstance`.
   */
  readonly slug: string;
  /**
   * Map of known workflow definitions, keyed by workflow name.
   * The engine validates `workflowName` against this map and reads the first
   * step name to initialize `currentStepName` on the instance.
   *
   * Accepts `WeaveConfig["workflows"]` directly — the type is compatible.
   */
  readonly workflows: Record<string, WorkflowConfig>;
}

/**
 * Input for `startExecution`.
 *
 * Adapters call this when a new workflow execution begins. The engine
 * acquires an execution lease and transitions the workflow instance to
 * `running` status.
 *
 * **Authorization requirement**: `authorizationSource` MUST be `"user"`.
 * The engine rejects any other source with a `policy_decision` error.
 * Agents, hooks, and events may not self-start durable execution (ADR 0004).
 *
 * When `context` is provided the engine validates `context.workflowName`
 * against `context.workflows` before creating any instance. An unknown
 * workflow name returns a `not_found` error; a missing `workflowName` returns
 * a `validation` error. On success the instance is created with the correct
 * `workflowName`, `goal`, `slug`, and `currentStepName` (first step).
 *
 * When `context` is omitted the engine falls back to legacy behaviour:
 * `workflowInstanceId` is used as a placeholder for all three name fields.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface StartExecutionInput {
  /** The workflow instance to start executing. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The owner identifier for the execution lease (e.g. session ID). */
  readonly ownerId: string;
  /**
   * The source of authorization for this execution start.
   *
   * MUST be `"user"` — the engine rejects any other value with a
   * `policy_decision` error. Adapters must not pass `"agent"`, `"hook"`,
   * or `"event"` here; those sources represent forbidden self-start paths.
   *
   * When omitted, the engine defaults to `"user"` for backward compatibility
   * with existing callers that pre-date this field. New callers SHOULD always
   * provide this field explicitly.
   *
   * @see docs/adr/0004-workflow-first-execution-contract.md
   */
  readonly authorizationSource?: ExecutionAuthorizationSource;
  /** ISO 8601 timestamp for lease acquisition (defaults to now if omitted). */
  readonly now?: string;
  /** Optional structured metadata about the execution start. */
  readonly metadata?: SafeMetadata;
  /**
   * Optional workflow execution context.
   *
   * When provided the engine validates the workflow name, initializes the
   * instance with proper fields, and sets `currentStepName` to the first step.
   * When omitted the engine uses `workflowInstanceId` as a placeholder (legacy).
   */
  readonly context?: WorkflowExecutionContext;
}

/**
 * Output from `startExecution`.
 *
 * Returns the workflow instance ID, the acquired execution lease ID, and the
 * initial lifecycle effects.
 *
 * Invariant: `workflowInstanceId` always matches the ID of the instance that
 * was created or updated AND the `workflowInstanceId` on the acquired lease.
 */
export interface StartExecutionOutput {
  /**
   * The ID of the workflow instance that was created or updated.
   * Always matches the `workflowInstanceId` on the acquired lease.
   */
  readonly workflowInstanceId: WorkflowInstanceId;
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
 * **Authorization requirement**: `authorizationSource` MUST be `"user"`.
 * The engine rejects any other source with a `policy_decision` error.
 * Hooks and events may not implicitly resume durable execution (ADR 0004).
 * The legacy `workContinuation` hook's automatic Tapestry re-injection is
 * superseded by this explicit authorization requirement.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface ResumeExecutionInput {
  /** The workflow instance to resume. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The owner identifier for the new execution lease. */
  readonly ownerId: string;
  /**
   * The source of authorization for this execution resume.
   *
   * MUST be `"user"` — the engine rejects any other value with a
   * `policy_decision` error. Adapters must not pass `"agent"`, `"hook"`,
   * or `"event"` here; those sources represent forbidden implicit-resume paths.
   *
   * When omitted, the engine defaults to `"user"` for backward compatibility
   * with existing callers that pre-date this field. New callers SHOULD always
   * provide this field explicitly.
   *
   * @see docs/adr/0004-workflow-first-execution-contract.md
   */
  readonly authorizationSource?: ExecutionAuthorizationSource;
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
 * When `context` is provided the engine resolves the step from
 * `context.workflows`, uses `step.agent` as the agent name, renders
 * `step.prompt` with instance context and artifact references, validates
 * declared `step.inputs` artifacts, and emits a fully-populated effect with
 * `completionMethod`, `stepType`, `correlationId`, and `promptMetadata`.
 *
 * When `context` is omitted the engine falls back to legacy behaviour: the
 * step name is used as the agent name with a minimal allow-all policy.
 *
 * **Retry pinning**: when `pinnedArtifactRevisions` is provided, the engine
 * skips approval-state validation for those artifact names and uses the pinned
 * revisions as the consumed-artifact record for this attempt. This allows
 * retries to reuse the same artifact revisions that were consumed in a prior
 * attempt, preventing silent drift when an artifact is updated between attempts.
 *
 * When `pinnedArtifactRevisions` is omitted and a prior attempt exists for
 * this step, the engine automatically pins to the consumed revisions from the
 * most recent prior attempt (default retry reuse behavior).
 *
 * **Integrity verification**: when `artifactDigests` is provided, the engine
 * compares each supplied digest against the stored `integrity.digest` on the
 * corresponding artifact. A mismatch causes `dispatchStep` to return a
 * `policy_decision` error — the engine fails closed. Artifacts without a
 * stored `integrity` field are not checked even if a digest is supplied.
 * Adapters compute digests by reading the artifact file and hashing its
 * contents with SHA-256 before calling `dispatchStep`.
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
  /**
   * Optional workflow execution context.
   *
   * When provided the engine resolves the step from the workflow config,
   * uses `step.agent` as the agent name, renders `step.prompt`, validates
   * declared inputs, and emits a fully-populated `RunAgentEffect`.
   * When omitted the engine uses the step name as the agent name (legacy).
   */
  readonly context?: WorkflowExecutionContext;
  /**
   * Optional explicit artifact revision pins for retry dispatch.
   *
   * When provided, the engine uses these pinned revisions as the consumed-
   * artifact record for this attempt and skips approval-state validation for
   * the pinned artifact names. This allows callers to explicitly override the
   * default retry-reuse behavior.
   *
   * When omitted and a prior attempt exists for this step, the engine
   * automatically pins to the consumed revisions from the most recent prior
   * attempt (default retry reuse). When no prior attempt exists, the engine
   * uses the current latest revisions from the instance.
   */
  readonly pinnedArtifactRevisions?: readonly ConsumedArtifactRecord[];
  /**
   * Optional map of artifact name → current SHA-256 digest for
   * consumption-time integrity verification.
   *
   * When provided, the engine compares each supplied digest against the
   * stored `integrity.digest` on the corresponding artifact. A mismatch
   * causes `dispatchStep` to return a `policy_decision` error — the engine
   * fails closed on tamper detection.
   *
   * Artifacts without a stored `integrity` field are not checked even if a
   * digest is supplied for them. Adapters compute digests by reading the
   * artifact file and hashing its contents with SHA-256 before calling
   * `dispatchStep`.
   *
   * Only lowercase hex-encoded SHA-256 digests (64 characters) are accepted.
   * Supplying a digest with an incorrect format returns a `validation` error.
   */
  readonly artifactDigests?: Readonly<Record<string, string>>;
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
  /**
   * Summary of artifact input validation performed at dispatch time.
   *
   * Present when the step has declared inputs and `input.context` was provided.
   * Absent for legacy dispatch (no context) or steps with no declared inputs.
   *
   * Normative input failures are returned as `not_found` errors before this
   * summary is produced — the summary only appears on successful dispatch.
   */
  readonly artifactInputSummary?: ArtifactInputSummary;
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
 * When `context` is provided and `outcome` is `"success"`:
 * - Output artifacts are validated against the step's declared `outputs`.
 * - Validated artifacts are persisted via `store.instances.addArtifact()`.
 * - The engine auto-advances: if a next step exists it emits a
 *   `dispatch-agent` effect; if this is the final step it transitions the
 *   instance to `completed`, releases the lease, and emits `complete-execution`.
 *
 * When `context` is omitted the engine falls back to legacy behaviour.
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
  /**
   * Optional workflow execution context.
   *
   * When provided and `outcome` is `"success"`, the engine validates output
   * artifacts, persists them, and auto-advances to the next step (or completes
   * the workflow if this is the final step).
   * When omitted the engine uses legacy behaviour (no auto-advance).
   */
  readonly context?: WorkflowExecutionContext;
  /**
   * Optional provider for querying plan file state.
   *
   * Required when the step's completion method is `"plan_created"` or
   * `"plan_complete"`. When absent and one of those methods is used, `completeStep`
   * returns a `policy_decision` error rather than crashing.
   *
   * Adapters should supply `BunFilesystemPlanStateProvider` from `@weave/config`
   * (or a mock in tests).
   */
  readonly planStateProvider?: PlanStateProvider;
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
   * Adapters own the mapping from concrete harness tool names to abstract
   * capabilities — the engine never inspects or hard-codes harness tool names.
   */
  readonly toolCapability:
    | "read"
    | "write"
    | "execute"
    | "delegate"
    | "network";
  /**
   * The harness-specific tool name (for audit/logging only).
   * The engine does NOT use this field for policy decisions — it is opaque.
   * Must not contain raw arguments, credentials, or sensitive data.
   */
  readonly toolName: string;
  /**
   * The fully-resolved effective tool policy for the agent making the call.
   * Supplied by the adapter after evaluating the agent's declared `tool_policy`.
   * The engine reads `effectiveToolPolicy[toolCapability]` to determine the
   * policy decision — it does not re-evaluate or re-derive the policy.
   */
  readonly effectiveToolPolicy: EffectiveToolPolicy;
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
export type ObserveSessionResult = ResultAsync<
  ObserveSessionOutput,
  LifecycleError
>;

/** Result type for `startExecution`. */
export type StartExecutionResult = ResultAsync<
  StartExecutionOutput,
  LifecycleError
>;

/** Result type for `resumeExecution`. */
export type ResumeExecutionResult = ResultAsync<
  ResumeExecutionOutput,
  LifecycleError
>;

/** Result type for `handleUserInterrupt`. */
export type HandleUserInterruptResult = ResultAsync<
  HandleUserInterruptOutput,
  LifecycleError
>;

/** Result type for `dispatchStep`. */
export type DispatchStepResult = ResultAsync<
  DispatchStepOutput,
  LifecycleError
>;

/** Result type for `completeStep`. */
export type CompleteStepResult = ResultAsync<
  CompleteStepOutput,
  LifecycleError
>;

/** Result type for `beforeTool`. */
export type BeforeToolResult = ResultAsync<BeforeToolOutput, LifecycleError>;

/** Result type for `inspectExecution`. */
export type InspectExecutionResult = ResultAsync<
  InspectExecutionOutput,
  LifecycleError
>;

/** Result type for `approveArtifact`. */
export type ApproveArtifactResult = ResultAsync<
  ApproveArtifactOutput,
  LifecycleError
>;

// ---------------------------------------------------------------------------
// 9. approveArtifact — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `approveArtifact`.
 *
 * Adapters call this when a gate agent or user explicitly approves or rejects
 * an artifact produced by a prior step. The engine enforces the self-approval
 * prohibition: an agent may not approve an artifact it produced.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface ApproveArtifactInput {
  /** The workflow instance that owns the artifact. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The active execution lease. */
  readonly leaseId: ExecutionLeaseId;
  /** The stable artifact ID to approve or reject. */
  readonly artifactId: ArtifactId;
  /**
   * The new approval state.
   * - `"approved"` — artifact is explicitly approved; normative consumers may proceed.
   * - `"rejected"` — artifact is explicitly rejected; workflow may pause or fail.
   */
  readonly approvalState: "approved" | "rejected";
  /**
   * The logical name of the agent performing the approval.
   *
   * Used to enforce the self-approval prohibition: if this matches the
   * `producerAgent` on the artifact, the engine returns a `policy_decision`
   * error. When absent, self-approval checks are skipped.
   */
  readonly approverAgent?: string;
  /** Optional structured metadata about the approval event. */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `approveArtifact`.
 *
 * Returns the updated workflow instance after the approval state change.
 */
export interface ApproveArtifactOutput {
  /** The updated workflow instance. */
  readonly instance: WorkflowInstance;
}

// ---------------------------------------------------------------------------
// ExecutionOperationKind — explicit execution operation discriminant
// ---------------------------------------------------------------------------

/**
 * Discriminated union of the explicit execution operation kinds.
 *
 * These are the engine-owned operations that drive durable workflow execution.
 * Each kind maps to one or more lifecycle methods:
 *
 * | Kind      | Lifecycle method(s)                                |
 * |-----------|----------------------------------------------------|
 * | `start`   | `startExecution`                                   |
 * | `resume`  | `resumeExecution`                                  |
 * | `pause`   | `handleUserInterrupt` with `signal: "pause"`       |
 * | `inspect` | `inspectExecution`                                 |
 * | `advance` | `dispatchStep`, `completeStep`                     |
 *
 * **Not included**: `observeSession` and `beforeTool` are NOT execution
 * operations. `observeSession` is a passive observation that records session
 * state without creating instances or acquiring leases. `beforeTool` is a
 * policy evaluation that does not advance execution state.
 *
 * This type is used to document and enforce the boundary between explicit
 * execution operations and chat-side or observation behavior. Adapters must
 * only call `startExecution` in response to an explicit, user-authorized
 * trigger — never in response to ordinary conversation, idle events, or
 * continuation hooks.
 *
 * @see docs/adr/0004-workflow-first-execution-contract.md
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
// ExecutionAuthorizationSource — explicit authorization discriminant
// ---------------------------------------------------------------------------

/**
 * Discriminated union of the authorization sources for execution transitions.
 *
 * Adapters MUST declare the source of authorization when calling
 * `startExecution` or `resumeExecution`. The engine rejects any source that
 * is not `"user"` — enforcing ADR 0004's requirement that durable execution
 * begins only through an explicit, user-authorized transition.
 *
 * ## Valid sources
 *
 * | Source    | Description                                                       |
 * |-----------|-------------------------------------------------------------------|
 * | `"user"`  | Explicit user action: command, skill invocation, UI button, CLI   |
 *
 * ## Rejected sources (policy_decision error)
 *
 * | Source    | Description                                                       |
 * |-----------|-------------------------------------------------------------------|
 * | `"agent"` | Agent-initiated self-start — forbidden by ADR 0004                |
 * | `"hook"`  | Idle hook, continuation hook, or compaction recovery — forbidden  |
 * | `"event"` | Session event, lifecycle event, or timer — forbidden              |
 *
 * ## Why this matters
 *
 * The legacy OpenCode model allowed `session.idle` hooks to silently resume
 * Tapestry, and `/start-work` was the only explicit boundary — an
 * OpenCode-specific boundary not portable to other harnesses. ADR 0004
 * replaces this with an engine-enforced authorization check that works
 * across all adapters.
 *
 * Adapters that call `startExecution` from an idle hook, continuation hook,
 * or agent callback MUST pass `"hook"` or `"agent"` as the source — the
 * engine will reject the call with a `policy_decision` error, preventing
 * implicit execution start regardless of adapter intent.
 *
 * @see docs/adr/0004-workflow-first-execution-contract.md
 */
export type ExecutionAuthorizationSource = "user" | "agent" | "hook" | "event";

/** All valid `ExecutionAuthorizationSource` values as a readonly tuple. */
export const EXECUTION_AUTHORIZATION_SOURCES = [
  "user",
  "agent",
  "hook",
  "event",
] as const satisfies readonly ExecutionAuthorizationSource[];

/**
 * The only authorization source that the engine accepts for execution
 * transitions. All other sources are rejected with a `policy_decision` error.
 */
const AUTHORIZED_EXECUTION_SOURCE: ExecutionAuthorizationSource = "user";

/**
 * Validate that the authorization source is explicitly user-authorized.
 *
 * Returns `ok(undefined)` when `source === "user"`.
 * Returns a typed `policy_decision` error for any other source, with a
 * message that names the forbidden source and references ADR 0004.
 *
 * @param source - The declared authorization source from the adapter.
 * @param operation - The lifecycle operation being attempted (for the error message).
 * @returns `Result<undefined, LifecyclePolicyDecisionError>`
 */
export function validateAuthorizationSource(
  source: ExecutionAuthorizationSource,
  operation: "startExecution" | "resumeExecution",
): Result<undefined, LifecyclePolicyDecisionError> {
  if (source === AUTHORIZED_EXECUTION_SOURCE) return ok(undefined);
  return err(
    lifecyclePolicyDecisionError(
      `${operation} requires explicit user authorization (source: "${source}" is not permitted). ` +
        `Only source: "user" is accepted. Agents, hooks, and events may not self-start durable execution. ` +
        `See docs/adr/0004-workflow-first-execution-contract.md.`,
      "authorizationSource",
    ),
  );
}

// ---------------------------------------------------------------------------
// 8. inspectExecution — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `inspectExecution`.
 *
 * Adapters call this to query the current execution state of a workflow
 * instance without modifying any state. This is a read-only operation —
 * it never creates instances, acquires leases, or emits lifecycle effects.
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 */
export interface InspectExecutionInput {
  /** The workflow instance to inspect. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** Optional structured metadata about the inspect request. */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `inspectExecution`.
 *
 * Returns a read-only snapshot of the workflow instance's current execution
 * state. The snapshot contains only engine-visible, non-sensitive fields.
 *
 * This output is a point-in-time snapshot — it does not guarantee that the
 * state has not changed by the time the caller processes it.
 */
export interface InspectExecutionOutput {
  /** The workflow instance ID. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** Current lifecycle status of the workflow instance. */
  readonly status: import("./runtime/types.js").WorkflowInstanceStatus;
  /** Name of the current step being executed, if any. */
  readonly currentStepName?: string;
  /** Name of the workflow definition being executed. */
  readonly workflowName: string;
  /** Human-readable goal for this execution instance. */
  readonly goal: string;
  /** URL-safe slug for this execution instance. */
  readonly slug: string;
  /** ISO 8601 timestamp when this instance was created. */
  readonly createdAt: string;
  /** ISO 8601 timestamp of the last status update. */
  readonly updatedAt: string;
  /** ISO 8601 timestamp when execution completed (any terminal status). */
  readonly completedAt?: string;
  /** Human-readable error message if status is `failed`. */
  readonly errorMessage?: string;
  /** Artifact references produced by completed steps. */
  readonly artifacts: readonly ArtifactRef[];
  /**
   * Whether an active (unexpired) execution lease exists for this instance.
   * `true` means the instance is actively being driven by a lease holder.
   */
  readonly hasActiveLease: boolean;
}

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
 * ## Execution Boundary Invariant
 *
 * `observeSession` is a **passive observation** — it is NOT an execution
 * operation. It NEVER:
 * - Creates a `WorkflowInstance`
 * - Acquires an `ExecutionLease`
 * - Transitions instance status
 * - Emits `LifecycleEffect` values
 *
 * Adapters MUST NOT call `observeSession` as a substitute for `startExecution`.
 * Ordinary Loom conversation, session idle events, and continuation hooks may
 * call `observeSession` safely — doing so will never implicitly start durable
 * execution. See ADR 0004 for the full rationale.
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
    .mapErr((storeError) =>
      lifecyclePersistenceError(storeError.message, {
        type: storeError.type,
        message: storeError.message,
      }),
    )
    .map((snapshot) => ({ snapshotId: snapshot.id }));
}

// ---------------------------------------------------------------------------
// 2. startExecution — implementation
// ---------------------------------------------------------------------------

/**
 * Validate the workflow execution context and resolve the instance creation
 * fields (`workflowName`, `goal`, `slug`, `currentStepName`).
 *
 * Returns `ok` with the resolved fields, or a typed `LifecycleError` when:
 * - `context.workflowName` is empty → `validation` error
 * - `context.workflowName` is not in `context.workflows` → `not_found` error
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
    // Legacy fallback: use workflowInstanceId as placeholder for all fields.
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
 * Adapters MUST call this only in response to an explicit, user-authorized
 * trigger (e.g. a harness command, skill invocation, UI button, or script).
 * Calling `startExecution` from an idle hook, continuation hook, or session
 * observation is a boundary violation per ADR 0004.
 *
 * When `input.context` is provided the engine validates `context.workflowName`
 * against `context.workflows` before creating any instance. On success the
 * instance is created with the correct `workflowName`, `goal`, `slug`, and
 * `currentStepName` (first step name). An unknown workflow name returns a
 * `not_found` error; a missing `workflowName` returns a `validation` error.
 *
 * When `input.context` is omitted the engine falls back to legacy behaviour:
 * `workflowInstanceId` is used as a placeholder for all three name fields.
 *
 * Creates or updates the `WorkflowInstance` to `running` status and acquires
 * an `ExecutionLease`. Uses one clock source per operation: `input.now` if
 * provided, otherwise `new Date().toISOString()`.
 *
 * @param input - Execution start parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ leaseId, effects: [] })` on success, or a typed `LifecycleError`.
 * @see docs/adr/0004-workflow-first-execution-contract.md
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

  // Enforce explicit user authorization — reject agent-, hook-, and event-initiated
  // self-start paths. When authorizationSource is omitted, default to "user" for
  // backward compatibility with callers that pre-date this field.
  const authSource: ExecutionAuthorizationSource =
    input.authorizationSource ?? "user";
  const authCheck = validateAuthorizationSource(authSource, "startExecution");
  if (authCheck.isErr()) return errAsync(authCheck.error);

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  // Validate workflow context and resolve instance fields before any store I/O.
  const fieldsResult = resolveInstanceFields(
    input.workflowInstanceId,
    input.context,
  );
  if (fieldsResult.isErr()) return errAsync(fieldsResult.error);
  const fields = fieldsResult.value;

  const ownerId = createOwnerId(input.ownerId);

  // Find or create the workflow instance using input.workflowInstanceId as the
  // canonical ID, then update to running, then acquire a lease for that same ID.
  // Invariant: created/updated instance ID === leased workflowInstanceId === output ID.
  return store.instances
    .findById(input.workflowInstanceId)
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
    )
    .andThen((existing) => {
      if (existing === null) {
        return store.instances
          .create({
            id: input.workflowInstanceId,
            workflowName: fields.workflowName,
            goal: fields.goal,
            slug: fields.slug,
          })
          .mapErr(
            (storeError): LifecycleError =>
              lifecyclePersistenceError(storeError.message, {
                type: storeError.type,
                message: storeError.message,
              }),
          )
          .andThen((created) => {
            // Build the update: always set status to running; also set
            // currentStepName when the context provides a first step.
            const updateInput =
              fields.currentStepName !== undefined
                ? {
                    status: "running" as const,
                    currentStepName: fields.currentStepName,
                  }
                : { status: "running" as const };
            return store.instances.update(created.id, updateInput).mapErr(
              (storeError): LifecycleError =>
                lifecyclePersistenceError(storeError.message, {
                  type: storeError.type,
                  message: storeError.message,
                }),
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
      return store.instances.update(existing.id, existingUpdateInput).mapErr(
        (storeError): LifecycleError =>
          lifecyclePersistenceError(storeError.message, {
            type: storeError.type,
            message: storeError.message,
          }),
      );
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
          return lifecyclePersistenceError(storeError.message, {
            type: storeError.type,
            message: storeError.message,
          });
        }),
    )
    .map((lease) => ({
      workflowInstanceId: lease.workflowInstanceId,
      leaseId: lease.id,
      effects: [] as LifecycleEffect[],
    }));
}

// ---------------------------------------------------------------------------
// 4. handleUserInterrupt — implementation
// ---------------------------------------------------------------------------

/**
 * Handle a user-initiated interrupt of an in-progress execution.
 *
 * - `pause` signal: updates instance to `paused` status, returns `PauseExecutionEffect`.
 *   Does NOT set `completedAt` — the instance remains resumable.
 * - `cancel` signal: updates instance to `cancelled` status (terminal), returns
 *   `CompleteExecutionEffect`. The store automatically sets `completedAt` for
 *   terminal statuses.
 *
 * @param input - Interrupt parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ effects })` on success, or a typed `LifecycleError`.
 */
export function handleUserInterrupt(
  input: HandleUserInterruptInput,
  store: RuntimeStore,
): ResultAsync<HandleUserInterruptOutput, LifecycleError> {
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
  if (!input.signal) {
    return errAsync(lifecycleValidationError("signal is required", "signal"));
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  return store.leases
    .findActive()
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
    )
    .andThen((activeLease) => {
      if (activeLease === null) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            "none" as ExecutionLeaseId,
            "No active lease for this workflow instance",
          ),
        );
      }
      if (activeLease.id !== input.leaseId) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            activeLease.id,
            "Provided lease ID does not match the active lease",
          ),
        );
      }
      if (activeLease.workflowInstanceId !== input.workflowInstanceId) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            activeLease.id,
            `Lease ${input.leaseId} belongs to workflow ${activeLease.workflowInstanceId}, not ${input.workflowInstanceId}`,
          ),
        );
      }
      return okAsync(undefined as undefined);
    })
    .andThen(() =>
      store.instances
        .findById(input.workflowInstanceId)
        .mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, {
              type: storeError.type,
              message: storeError.message,
            }),
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

          if (input.signal === "pause") {
            return store.instances
              .update(input.workflowInstanceId, { status: "paused" })
              .mapErr(
                (storeError): LifecycleError =>
                  lifecyclePersistenceError(storeError.message, {
                    type: storeError.type,
                    message: storeError.message,
                  }),
              )
              .map(
                (): HandleUserInterruptOutput => ({
                  effects: [
                    {
                      kind: "pause-execution",
                      workflowInstanceId: input.workflowInstanceId,
                    },
                  ],
                }),
              );
          }

          // signal === "cancel" — terminal status
          return store.instances
            .update(input.workflowInstanceId, { status: "cancelled" })
            .mapErr(
              (storeError): LifecycleError =>
                lifecyclePersistenceError(storeError.message, {
                  type: storeError.type,
                  message: storeError.message,
                }),
            )
            .map(
              (): HandleUserInterruptOutput => ({
                effects: [
                  {
                    kind: "complete-execution",
                    workflowInstanceId: input.workflowInstanceId,
                  },
                ],
              }),
            );
        }),
    );
}

// ---------------------------------------------------------------------------
// 5. dispatchStep — helpers
// ---------------------------------------------------------------------------

/**
 * Allowed template paths for workflow step prompt rendering.
 *
 * These paths are the only ones the engine exposes to step prompts.
 * Adapters may not inject additional paths — the set is engine-owned.
 */
const STEP_PROMPT_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "instance.goal",
  "instance.slug",
  "instance.workflowName",
  "instance.currentStepName",
  "step.name",
  "step.type",
  "step.agent",
  "artifacts",
]);

/**
 * Resolve a `WorkflowStep` from a workflow config by step name.
 *
 * Returns `ok(step)` when found, or a typed `not_found` error.
 */
function resolveWorkflowStep(
  workflowConfig: WorkflowConfig,
  stepName: string,
): Result<WorkflowStep, LifecycleError> {
  const step = workflowConfig.steps.find((s) => s.name === stepName);
  if (step === undefined) {
    return err(
      lifecycleNotFoundError(
        "WorkflowStep",
        stepName,
        `Step "${stepName}" not found in workflow`,
      ),
    );
  }
  return ok(step);
}

/**
 * Classify a declared step input as normative or informational.
 *
 * When `role` is absent on the input declaration, defaults to `"normative"`
 * for backward compatibility with step declarations that predate this field.
 *
 * The `ArtifactDecl` type from `@weave/core` does not carry a `role` field —
 * the engine treats any input without an explicit role as normative. Callers
 * that want informational inputs must use `ArtifactInputDecl` (engine-owned)
 * rather than the core `ArtifactDecl` type.
 */
function inputRole(input: {
  name: string;
  description: string;
  role?: string;
}): "normative" | "informational" {
  if (input.role === "informational") return "informational";
  return "normative";
}

/**
 * Get the most recent artifact revision for a given name from the instance.
 *
 * Returns the last entry in `instance.artifacts` with the given name, or
 * `undefined` if no artifact with that name exists.
 */
function latestArtifactByName(
  instance: WorkflowInstance,
  name: string,
): ArtifactRef | undefined {
  let latest: ArtifactRef | undefined;
  for (const a of instance.artifacts) {
    if (a.name === name) latest = a;
  }
  return latest;
}

/**
 * Check whether a normative artifact's approval has been invalidated.
 *
 * Approval invalidation occurs when:
 * - The artifact has multiple revisions (revision > 1), AND
 * - The latest revision has `approvalState !== "approved"`, AND
 * - A prior revision exists with `approvalState === "approved"`.
 *
 * This detects the case where a previously-approved artifact was superseded
 * by a new revision (which resets approvalState to "pending"), blocking
 * dispatch until the new revision is explicitly re-approved.
 *
 * Returns `true` when approval has been invalidated (dispatch should be blocked).
 * Returns `false` when the artifact is either freshly produced (never approved)
 * or currently approved.
 */
function isApprovalInvalidated(
  instance: WorkflowInstance,
  artifactName: string,
): boolean {
  const revisions = instance.artifacts.filter((a) => a.name === artifactName);
  if (revisions.length <= 1) return false;

  const latest = revisions[revisions.length - 1];
  if (latest.approvalState === "approved") return false;

  // Check if any prior revision was approved
  const hasPriorApproval = revisions
    .slice(0, -1)
    .some((a) => a.approvalState === "approved");
  return hasPriorApproval;
}

// ---------------------------------------------------------------------------
// Consumption-time integrity verification
// ---------------------------------------------------------------------------

/** Lowercase hex SHA-256 digest pattern (exactly 64 hex characters). */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Validate the format of a caller-supplied SHA-256 digest.
 *
 * Returns `ok(digest)` when the format is valid (64 lowercase hex chars).
 * Returns a typed `validation` error for any other format.
 */
function validateDigestFormat(
  artifactName: string,
  digest: string,
): Result<string, LifecycleError> {
  if (SHA256_HEX_RE.test(digest)) return ok(digest);
  return err(
    lifecycleValidationError(
      `artifactDigests["${artifactName}"] is not a valid SHA-256 hex digest — expected 64 lowercase hex characters`,
      `artifactDigests.${artifactName}`,
    ),
  );
}

/**
 * Verify consumption-time integrity for a single artifact.
 *
 * Compares the caller-supplied digest against the stored `integrity.digest`
 * on the artifact. Fails closed on mismatch: returns a `policy_decision`
 * error when the digests differ.
 *
 * When the artifact has no stored `integrity` field, the check is skipped
 * (returns `ok(undefined)`). When no digest is supplied for this artifact
 * name, the check is also skipped.
 *
 * @param artifact - The persisted artifact reference (with optional integrity).
 * @param suppliedDigest - The caller-supplied current digest, or undefined.
 * @returns `ok(undefined)` when the check passes or is skipped.
 * @returns `err(LifecyclePolicyDecisionError)` when digests differ.
 * @returns `err(LifecycleValidationError)` when the supplied digest is malformed.
 */
function verifyArtifactIntegrity(
  artifact: ArtifactRef,
  suppliedDigest: string | undefined,
): Result<undefined, LifecycleError> {
  // No stored integrity metadata — skip check.
  if (artifact.integrity === undefined) return ok(undefined);
  // No digest supplied by caller — skip check (opt-in verification).
  if (suppliedDigest === undefined) return ok(undefined);

  // Validate the format of the supplied digest before comparing.
  const formatCheck = validateDigestFormat(artifact.name, suppliedDigest);
  if (formatCheck.isErr()) return err(formatCheck.error);

  // Constant-time comparison is not strictly necessary here because we are
  // comparing public digests (not secrets), but we use a simple string
  // comparison which is sufficient for tamper detection.
  if (suppliedDigest !== artifact.integrity.digest) {
    return err(
      lifecyclePolicyDecisionError(
        `Integrity verification failed for artifact "${artifact.name}" (revision ${artifact.revision}): ` +
          `supplied digest does not match stored digest. ` +
          `The artifact may have been tampered with or replaced since it was approved. ` +
          `Dispatch is blocked to prevent consumption of a modified artifact.`,
        "artifact_integrity",
      ),
    );
  }

  return ok(undefined);
}

/**
 * Validate declared `step.inputs` artifacts against the instance's persisted
 * artifacts, distinguishing normative (blocking) from informational (advisory)
 * inputs.
 *
 * **Normative inputs** (role: `"normative"` or role absent):
 * - Must be present in the instance's artifact set.
 * - If a prior revision was approved and a new revision has been added
 *   (resetting approvalState to "pending"), dispatch is blocked with a
 *   `policy_decision` error (approval invalidation).
 * - Returns a typed `not_found` error for the first missing normative input.
 * - Dispatch is blocked until all normative inputs are satisfied.
 *
 * **Informational inputs** (role: `"informational"`):
 * - Advisory only — dispatch proceeds even if absent or unapproved.
 * - Absent informational inputs are recorded in the returned summary.
 *
 * **Integrity verification** (when `artifactDigests` is provided):
 * - For each artifact with a stored `integrity.digest`, the supplied digest
 *   is compared. A mismatch returns a `policy_decision` error (fail closed).
 *
 * Returns `ok(ArtifactInputSummary)` when all normative inputs are satisfied.
 * Returns `err(LifecycleError)` when any normative input is missing or has
 * invalidated approval, or when integrity verification fails.
 */
function validateStepInputs(
  step: WorkflowStep,
  instance: WorkflowInstance,
  artifactDigests?: Readonly<Record<string, string>>,
): Result<ArtifactInputSummary, LifecycleError> {
  const emptyResult: ArtifactInputSummary = {
    normativeSatisfied: [],
    informationalPresent: [],
    informationalAbsent: [],
  };

  if (!step.inputs || step.inputs.length === 0) return ok(emptyResult);

  const normativeSatisfied: string[] = [];
  const informationalPresent: string[] = [];
  const informationalAbsent: string[] = [];

  for (const input of step.inputs) {
    const role = inputRole(input as ArtifactInputDecl);
    const latest = latestArtifactByName(instance, input.name);

    if (role === "normative") {
      if (latest === undefined) {
        return err(
          lifecycleNotFoundError(
            "artifact",
            input.name,
            `Required normative input artifact "${input.name}" is missing from workflow instance`,
          ),
        );
      }
      // Approval invalidation: a new revision supersedes a previously-approved
      // revision, resetting approvalState to "pending". Block dispatch until
      // the new revision is explicitly re-approved.
      if (isApprovalInvalidated(instance, input.name)) {
        return err(
          lifecyclePolicyDecisionError(
            `Normative input artifact "${input.name}" (revision ${latest.revision}) has approvalState "${latest.approvalState}" — a new revision invalidated the prior approval. Dispatch is blocked until the new revision is approved.`,
            "artifact_approval",
          ),
        );
      }
      // Consumption-time integrity verification: compare supplied digest
      // against the stored digest. Fails closed on mismatch.
      const integrityCheck = verifyArtifactIntegrity(
        latest,
        artifactDigests?.[input.name],
      );
      if (integrityCheck.isErr()) return err(integrityCheck.error);
      normativeSatisfied.push(input.name);
      continue;
    }

    // informational
    if (latest !== undefined) {
      // Also verify integrity for informational inputs when a digest is supplied.
      const integrityCheck = verifyArtifactIntegrity(
        latest,
        artifactDigests?.[input.name],
      );
      if (integrityCheck.isErr()) return err(integrityCheck.error);
      informationalPresent.push(input.name);
    } else {
      informationalAbsent.push(input.name);
    }
  }

  return ok({ normativeSatisfied, informationalPresent, informationalAbsent });
}

/**
 * Validate declared `step.inputs` with pinned artifact revisions (retry path).
 *
 * For pinned artifacts, approval-state validation is skipped — the revision
 * was already approved when first dispatched. For non-pinned artifacts, the
 * standard approval check applies.
 *
 * Integrity verification is applied to all artifacts (pinned and non-pinned)
 * when `artifactDigests` is provided. A mismatch returns a `policy_decision`
 * error regardless of pin status — integrity is always verified.
 *
 * Returns `ok(ArtifactInputSummary)` when all normative inputs are satisfied.
 * Returns `err(LifecycleError)` when any normative input is missing or when
 * integrity verification fails.
 */
function validateStepInputsWithPins(
  step: WorkflowStep,
  instance: WorkflowInstance,
  pinnedRevisions: readonly ConsumedArtifactRecord[],
  artifactDigests?: Readonly<Record<string, string>>,
): Result<ArtifactInputSummary, LifecycleError> {
  const emptyResult: ArtifactInputSummary = {
    normativeSatisfied: [],
    informationalPresent: [],
    informationalAbsent: [],
  };

  if (!step.inputs || step.inputs.length === 0) return ok(emptyResult);

  // Build a set of pinned artifact names for fast lookup.
  const pinnedNames = new Set(pinnedRevisions.map((p) => p.name));

  const normativeSatisfied: string[] = [];
  const informationalPresent: string[] = [];
  const informationalAbsent: string[] = [];

  for (const input of step.inputs) {
    const role = inputRole(input as ArtifactInputDecl);

    // For pinned artifacts: presence is guaranteed by the pin; skip approval check.
    // Integrity verification still applies — pinning does not bypass tamper detection.
    if (pinnedNames.has(input.name)) {
      const latest = latestArtifactByName(instance, input.name);
      if (latest !== undefined) {
        const integrityCheck = verifyArtifactIntegrity(
          latest,
          artifactDigests?.[input.name],
        );
        if (integrityCheck.isErr()) return err(integrityCheck.error);
      }
      if (role === "normative") {
        normativeSatisfied.push(input.name);
      } else {
        informationalPresent.push(input.name);
      }
      continue;
    }

    // Non-pinned: apply standard validation.
    const latest = latestArtifactByName(instance, input.name);

    if (role === "normative") {
      if (latest === undefined) {
        return err(
          lifecycleNotFoundError(
            "artifact",
            input.name,
            `Required normative input artifact "${input.name}" is missing from workflow instance`,
          ),
        );
      }
      if (isApprovalInvalidated(instance, input.name)) {
        return err(
          lifecyclePolicyDecisionError(
            `Normative input artifact "${input.name}" (revision ${latest.revision}) has approvalState "${latest.approvalState}" — a new revision invalidated the prior approval. Dispatch is blocked until the new revision is approved.`,
            "artifact_approval",
          ),
        );
      }
      // Consumption-time integrity verification for non-pinned normative inputs.
      const integrityCheck = verifyArtifactIntegrity(
        latest,
        artifactDigests?.[input.name],
      );
      if (integrityCheck.isErr()) return err(integrityCheck.error);
      normativeSatisfied.push(input.name);
      continue;
    }

    // informational
    if (latest !== undefined) {
      // Verify integrity for informational inputs when a digest is supplied.
      const integrityCheck = verifyArtifactIntegrity(
        latest,
        artifactDigests?.[input.name],
      );
      if (integrityCheck.isErr()) return err(integrityCheck.error);
      informationalPresent.push(input.name);
    } else {
      informationalAbsent.push(input.name);
    }
  }

  return ok({ normativeSatisfied, informationalPresent, informationalAbsent });
}

/**
 * Build the consumed artifact records for a step dispatch.
 *
 * When `pinnedRevisions` is provided, those are used directly.
 * Otherwise, the current latest revision of each declared input artifact
 * is recorded.
 */
function buildConsumedArtifacts(
  step: WorkflowStep,
  instance: WorkflowInstance,
  pinnedRevisions: readonly ConsumedArtifactRecord[] | undefined,
): readonly ConsumedArtifactRecord[] {
  if (pinnedRevisions !== undefined) return pinnedRevisions;

  if (!step.inputs || step.inputs.length === 0) return [];

  const consumed: ConsumedArtifactRecord[] = [];
  for (const input of step.inputs) {
    const latest = latestArtifactByName(instance, input.name);
    if (latest !== undefined) {
      consumed.push({
        artifactId: latest.id,
        name: latest.name,
        revision: latest.revision,
      });
    }
  }
  return consumed;
}

/**
 * Get the most recent step attempt for a given step name, or undefined.
 */
function latestAttemptForStep(
  instance: WorkflowInstance,
  stepName: string,
): StepAttemptRecord | undefined {
  let latest: StepAttemptRecord | undefined;
  for (const attempt of instance.stepAttempts) {
    if (attempt.stepName === stepName) latest = attempt;
  }
  return latest;
}

/**
 * Build the Mustache template context for a workflow step prompt.
 *
 * Exposes instance fields and artifact references under the allowed paths.
 * Never exposes raw prompt content, credentials, or harness-private data.
 */
function buildStepPromptContext(
  instance: WorkflowInstance,
  step: WorkflowStep,
): TemplateContext {
  // Build artifacts map: { [name]: path } for {{artifacts.plan_path}} etc.
  const artifactsMap: TemplateContext = {};
  for (const artifact of instance.artifacts) {
    artifactsMap[artifact.name] = artifact.path;
  }

  return {
    instance: {
      goal: instance.goal,
      slug: instance.slug,
      workflowName: instance.workflowName,
      currentStepName: instance.currentStepName ?? "",
    },
    step: {
      name: step.name,
      type: step.type,
      agent: step.agent,
    },
    artifacts: artifactsMap,
  };
}

/**
 * Render a step prompt template and return sanitized prompt metadata.
 *
 * The rendered prompt text is NOT stored in the effect — only its byte length
 * is returned as `PromptMetadata`. This preserves the security invariant that
 * raw prompts never appear in lifecycle effects.
 *
 * Artifact names from the instance are added to the allowed paths set as
 * `artifacts.<name>` so that templates like `{{artifacts.plan_path}}` resolve
 * correctly without requiring a static allowlist of artifact names.
 *
 * Maps `RendererError` to a `LifecycleError` with type `validation`.
 */
function renderStepPrompt(
  promptTemplate: string,
  context: TemplateContext,
  artifactNames: readonly string[],
): Result<{ byteLength: number }, LifecycleError> {
  // Build the allowed paths set, adding dynamic artifact paths.
  const allowedPaths = new Set(STEP_PROMPT_ALLOWED_PATHS);
  for (const name of artifactNames) {
    allowedPaths.add(`artifacts.${name}`);
  }

  const renderResult = renderTemplate(promptTemplate, context, {
    allowedPaths,
  });
  if (renderResult.isErr()) {
    const re: RendererError = renderResult.error;
    return err(
      lifecycleValidationError(
        `Step prompt template error: ${re.message}`,
        "step.prompt",
      ),
    );
  }
  const rendered = renderResult.value;
  const byteLength = new TextEncoder().encode(rendered).byteLength;
  return ok({ byteLength });
}

/**
 * Build a legacy (no-context) `RunAgentEffect` using the step name as agent
 * name and a minimal allow-all policy.
 *
 * Preserved for backward compatibility when no `WorkflowExecutionContext` is
 * provided to `dispatchStep`.
 */
function buildLegacyRunAgentEffect(stepName: string): RunAgentEffect {
  const minimalPolicy = evaluateEffectiveToolPolicy({
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "deny",
    network: "ask",
  });
  return {
    kind: "run-agent",
    agentName: stepName,
    agentDescriptor: {
      name: stepName,
      composedPrompt: "",
      models: [],
      mode: "subagent",
      effectiveToolPolicy: minimalPolicy,
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    },
    effectiveToolPolicy: minimalPolicy,
    rawToolPolicy: undefined,
    resolvedSkills: [],
  };
}

/**
 * Build a configured `RunAgentEffect` from a resolved `WorkflowStep`.
 *
 * Uses `step.agent` as the agent name, emits `completionMethod`, `stepType`,
 * `correlationId`, and `promptMetadata`. `composedPrompt` is always `""` —
 * the security invariant is preserved.
 */
function buildConfiguredRunAgentEffect(
  step: WorkflowStep,
  promptMetadata: { byteLength: number },
): RunAgentEffect {
  const effectivePolicy = evaluateEffectiveToolPolicy(undefined);
  return {
    kind: "run-agent",
    agentName: step.agent,
    agentDescriptor: {
      name: step.agent,
      composedPrompt: "",
      models: [],
      mode: "subagent",
      effectiveToolPolicy: effectivePolicy,
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    },
    effectiveToolPolicy: effectivePolicy,
    rawToolPolicy: undefined,
    resolvedSkills: [],
    completionMethod: step.completion.method,
    stepType: step.type,
    correlationId: crypto.randomUUID(),
    promptMetadata,
  };
}

// ---------------------------------------------------------------------------
// 5. dispatchStep — implementation
// ---------------------------------------------------------------------------

/**
 * Dispatch the next (or a specific) workflow step.
 *
 * **With `input.context`** (configured dispatch):
 * 1. Resolves the step from `context.workflows[instance.workflowName].steps`
 *    using `input.stepName`, `instance.currentStepName`, or the first step.
 * 2. Returns `not_found` if the step doesn't exist in the workflow config.
 * 3. Validates declared `step.inputs` artifacts are present in the instance.
 * 4. Renders `step.prompt` with instance context and artifact references.
 * 5. Emits a `DispatchAgentEffect` with `step.agent` as agent name,
 *    `completionMethod`, `stepType`, `correlationId`, and `promptMetadata`.
 *
 * **Without `input.context`** (legacy dispatch):
 * - Uses step name as agent name with a minimal allow-all policy.
 * - `composedPrompt` is always `""` (security invariant).
 *
 * @param input - Dispatch parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ stepName, effects })` on success, or a typed `LifecycleError`.
 */
export function dispatchStep(
  input: DispatchStepInput,
  store: RuntimeStore,
): ResultAsync<DispatchStepOutput, LifecycleError> {
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

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  return store.leases
    .findActive()
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
    )
    .andThen((activeLease) => {
      if (activeLease === null) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            "none" as ExecutionLeaseId,
            "No active lease for this workflow instance",
          ),
        );
      }
      if (activeLease.id !== input.leaseId) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            activeLease.id,
            "Provided lease ID does not match the active lease",
          ),
        );
      }
      if (activeLease.workflowInstanceId !== input.workflowInstanceId) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            activeLease.id,
            `Lease ${input.leaseId} belongs to workflow ${activeLease.workflowInstanceId}, not ${input.workflowInstanceId}`,
          ),
        );
      }
      return okAsync(undefined as undefined);
    })
    .andThen(() =>
      store.instances
        .findById(input.workflowInstanceId)
        .mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, {
              type: storeError.type,
              message: storeError.message,
            }),
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

          const stepName =
            input.stepName ?? existing.currentStepName ?? "default";

          // When no context is provided, use legacy dispatch (step name = agent name).
          if (input.context === undefined) {
            return store.instances
              .update(input.workflowInstanceId, { currentStepName: stepName })
              .mapErr(
                (storeError): LifecycleError =>
                  lifecyclePersistenceError(storeError.message, {
                    type: storeError.type,
                    message: storeError.message,
                  }),
              )
              .map(
                (): DispatchStepOutput => ({
                  stepName,
                  effects: [
                    {
                      kind: "dispatch-agent",
                      runAgent: buildLegacyRunAgentEffect(stepName),
                    },
                  ],
                }),
              );
          }

          // Configured dispatch: resolve step from workflow config.
          const workflowConfig = input.context.workflows[existing.workflowName];

          if (workflowConfig === undefined) {
            return errAsync(
              lifecycleNotFoundError(
                "WorkflowConfig",
                existing.workflowName,
                `Workflow "${existing.workflowName}" not found in provided workflow map`,
              ),
            );
          }

          // Resolve the step — prefer explicit stepName, then currentStepName,
          // then first step in the workflow.
          const resolvedStepName =
            input.stepName ??
            existing.currentStepName ??
            workflowConfig.steps[0]?.name ??
            "default";

          const stepResult = resolveWorkflowStep(
            workflowConfig,
            resolvedStepName,
          );
          if (stepResult.isErr()) return errAsync(stepResult.error);
          const step = stepResult.value;

          // Determine pinned revisions for retry reuse.
          // Priority: explicit pinnedArtifactRevisions > prior attempt revisions > none.
          let effectivePins: readonly ConsumedArtifactRecord[] | undefined =
            input.pinnedArtifactRevisions;
          if (effectivePins === undefined) {
            const priorAttempt = latestAttemptForStep(
              existing,
              resolvedStepName,
            );
            if (
              priorAttempt !== undefined &&
              priorAttempt.consumedArtifacts.length > 0
            ) {
              // Default retry reuse: pin to the same consumed revisions as the prior attempt.
              effectivePins = priorAttempt.consumedArtifacts;
            }
          }

          // Validate declared inputs — normative inputs block dispatch;
          // informational inputs are advisory and produce a summary.
          // When pinned revisions are present, approval-state check is skipped for pinned names.
          // Integrity verification is applied when artifactDigests is provided.
          const inputsCheck =
            effectivePins !== undefined && effectivePins.length > 0
              ? validateStepInputsWithPins(
                  step,
                  existing,
                  effectivePins,
                  input.artifactDigests,
                )
              : validateStepInputs(step, existing, input.artifactDigests);
          if (inputsCheck.isErr()) return errAsync(inputsCheck.error);
          const artifactInputSummary = inputsCheck.value;

          // Build consumed artifact records for this attempt.
          const consumedArtifacts = buildConsumedArtifacts(
            step,
            existing,
            effectivePins,
          );

          // Render the step prompt and compute prompt metadata.
          const promptContext = buildStepPromptContext(existing, step);
          const artifactNames = existing.artifacts.map((a) => a.name);
          const promptResult = renderStepPrompt(
            step.prompt,
            promptContext,
            artifactNames,
          );
          if (promptResult.isErr()) return errAsync(promptResult.error);
          const promptMetadata = promptResult.value;

          // Determine whether to include the summary in the output.
          // Only include when the step has declared inputs (non-empty summary).
          const hasInputs = step.inputs && step.inputs.length > 0;

          // Update currentStepName on the instance.
          return store.instances
            .update(input.workflowInstanceId, {
              currentStepName: resolvedStepName,
            })
            .mapErr(
              (storeError): LifecycleError =>
                lifecyclePersistenceError(storeError.message, {
                  type: storeError.type,
                  message: storeError.message,
                }),
            )
            .andThen(() =>
              // Record the step attempt with consumed artifact revisions.
              store.instances
                .recordStepAttempt(
                  input.workflowInstanceId,
                  resolvedStepName,
                  consumedArtifacts,
                )
                .mapErr(
                  (storeError): LifecycleError =>
                    lifecyclePersistenceError(storeError.message, {
                      type: storeError.type,
                      message: storeError.message,
                    }),
                ),
            )
            .map(
              (): DispatchStepOutput => ({
                stepName: resolvedStepName,
                effects: [
                  {
                    kind: "dispatch-agent",
                    runAgent: buildConfiguredRunAgentEffect(
                      step,
                      promptMetadata,
                    ),
                  },
                ],
                ...(hasInputs ? { artifactInputSummary } : {}),
              }),
            );
        }),
    );
}

// ---------------------------------------------------------------------------
// 6. completeStep — helpers
// ---------------------------------------------------------------------------

/**
 * Validate that the signal's `method` matches the step's declared
 * `completion.method`.
 *
 * Returns `ok(undefined)` when:
 * - `signal.method` is absent (legacy path — skip validation)
 * - `signal.method` matches `step.completion.method`
 *
 * Returns a typed `validation` error when the methods differ.
 */
function validateCompletionMethod(
  signal: StepCompletionSignal,
  step: WorkflowStep,
): Result<undefined, LifecycleError> {
  if (signal.method === undefined) return ok(undefined);
  if (signal.method === step.completion.method) return ok(undefined);
  return err(
    lifecycleValidationError(
      `Completion method mismatch: signal has "${signal.method}" but step "${step.name}" declares "${step.completion.method}"`,
      "completion.method",
    ),
  );
}

/**
 * Render the `plan_name` template from a step's completion config.
 *
 * The `plan_name` field may contain Mustache placeholders (e.g.
 * `{{instance.slug}}`). This function renders it with the instance context
 * and returns the resolved plan name string.
 */
function renderPlanName(
  planNameTemplate: string,
  instance: WorkflowInstance,
): Result<string, LifecycleError> {
  const context: TemplateContext = {
    instance: {
      goal: instance.goal,
      slug: instance.slug,
      workflowName: instance.workflowName,
      currentStepName: instance.currentStepName ?? "",
    },
  };
  const allowedPaths = new Set([
    "instance.goal",
    "instance.slug",
    "instance.workflowName",
    "instance.currentStepName",
  ]);
  const renderResult = renderTemplate(planNameTemplate, context, {
    allowedPaths,
  });
  if (renderResult.isErr()) {
    return err(
      lifecycleValidationError(
        `plan_name template error: ${renderResult.error.message}`,
        "completion.plan_name",
      ),
    );
  }
  return ok(renderResult.value);
}

/**
 * Map a `PlanStateError` from a `PlanStateProvider` to a `LifecycleError`.
 *
 * - `InvalidPlanName` → `validation` error (bad plan name)
 * - `ProviderUnavailable` → `persistence` error (I/O failure)
 */
function mapPlanStateError(
  providerErr: PlanStateError,
  planName: string,
): LifecycleError {
  if (providerErr.type === "InvalidPlanName") {
    return lifecycleValidationError(
      `plan name "${planName}" contains unsafe characters — only alphanumeric characters, hyphens, and underscores are allowed`,
      "plan_name",
    );
  }
  return lifecyclePersistenceError(
    `PlanStateProvider unavailable for plan "${planName}"`,
    { type: "query", message: String(providerErr.cause) },
  );
}

/**
 * Apply the gate rejection policy for a rejected `review_verdict` signal.
 *
 * - `"pause"` — updates instance to `paused`, emits `pause-execution`
 * - `"fail"`  — updates instance to `failed`, releases lease, emits `complete-execution`
 * - `"retry"` — re-dispatches the same gate step with a fresh correlation ID
 *
 * When `on_reject` is undefined, defaults to `"pause"`.
 */
function applyGateRejection(
  store: RuntimeStore,
  workflowInstanceId: WorkflowInstanceId,
  activeLease: ExecutionLease,
  step: WorkflowStep,
  message: string | undefined,
): ResultAsync<readonly LifecycleEffect[], LifecycleError> {
  const policy = step.on_reject ?? "pause";

  if (policy === "pause") {
    return store.instances
      .update(workflowInstanceId, { status: "paused" })
      .mapErr(
        (storeError): LifecycleError =>
          lifecyclePersistenceError(storeError.message, {
            type: storeError.type,
            message: storeError.message,
          }),
      )
      .map((): readonly LifecycleEffect[] => [
        { kind: "pause-execution", workflowInstanceId },
      ]);
  }

  if (policy === "fail") {
    return store.instances
      .update(workflowInstanceId, {
        status: "failed",
        ...(message !== undefined ? { errorMessage: message } : {}),
      })
      .mapErr(
        (storeError): LifecycleError =>
          lifecyclePersistenceError(storeError.message, {
            type: storeError.type,
            message: storeError.message,
          }),
      )
      .andThen(() =>
        store.leases.release(activeLease.id, activeLease.ownerId).mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, {
              type: storeError.type,
              message: storeError.message,
            }),
        ),
      )
      .map((): readonly LifecycleEffect[] => [
        { kind: "complete-execution", workflowInstanceId },
      ]);
  }

  // policy === "retry" — re-dispatch the same gate step with a fresh correlation ID.
  // Fetch the current instance for prompt rendering context.
  return store.instances
    .getById(workflowInstanceId)
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
    )
    .andThen((instance) => {
      const artifactNames = instance.artifacts.map((a) => a.name);
      const promptContext = buildStepPromptContext(instance, step);
      const promptResult = renderStepPrompt(
        step.prompt,
        promptContext,
        artifactNames,
      );
      if (promptResult.isErr()) return errAsync(promptResult.error);
      const promptMetadata = promptResult.value;
      const runAgent = buildConfiguredRunAgentEffect(step, promptMetadata);
      return okAsync([
        { kind: "dispatch-agent" as const, runAgent },
      ] as readonly LifecycleEffect[]);
    });
}

/**
 * Map a step outcome to the corresponding `UpdateWorkflowInstanceInput`.
 * For `"success"` with configured auto-advance the caller overrides status
 * after this call, so `"running"` is the correct interim value.
 */
function buildUpdateInput(
  outcome: StepCompletionSignal["outcome"],
  message: string | undefined,
): import("./runtime/store.js").UpdateWorkflowInstanceInput {
  if (outcome === "success") return { status: "running" };
  if (outcome === "blocked") return { status: "blocked" };
  if (outcome === "failed") {
    return {
      status: "failed",
      ...(message !== undefined ? { errorMessage: message } : {}),
    };
  }
  // outcome === "paused"
  return { status: "paused" };
}

/**
 * Persist a list of artifact references sequentially.
 * Returns `ok(undefined)` when all artifacts are stored, or the first
 * persistence error encountered.
 */
function addArtifactsSequentially(
  store: RuntimeStore,
  workflowInstanceId: WorkflowInstanceId,
  artifacts: readonly ArtifactRefInput[],
): ResultAsync<undefined, LifecycleError> {
  const first = artifacts[0];
  if (!first) return okAsync(undefined);

  return store.instances
    .addArtifact(workflowInstanceId, {
      name: first.name,
      path: first.path,
      ...(first.mimeType ? { mimeType: first.mimeType } : {}),
      ...(first.description ? { description: first.description } : {}),
      ...(first.integrity ? { integrity: first.integrity } : {}),
    })
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
    )
    .andThen(() =>
      addArtifactsSequentially(store, workflowInstanceId, artifacts.slice(1)),
    );
}

/**
 * Validate output artifacts against the step's declared `outputs`.
 *
 * Rules:
 * - When `step.outputs` is empty or undefined: no restriction — any artifacts
 *   (or none) are accepted.
 * - When `step.outputs` is non-empty: every declared output name MUST be
 *   present in `artifacts`. Missing declared outputs return a `validation`
 *   error. Undeclared artifact names also return a `validation` error.
 *
 * This is an all-or-nothing check: no writes occur if validation fails.
 */
function validateOutputArtifacts(
  step: WorkflowStep,
  artifacts: readonly ArtifactRefInput[] | undefined,
): Result<undefined, LifecycleError> {
  // No declared outputs — no restriction.
  if (!step.outputs || step.outputs.length === 0) return ok(undefined);

  const providedNames = new Set((artifacts ?? []).map((a) => a.name));

  // Every declared output must be present in the provided artifacts.
  for (const declared of step.outputs) {
    if (!providedNames.has(declared.name)) {
      return err(
        lifecycleValidationError(
          `Declared output "${declared.name}" is missing from completionSignal.artifacts for step "${step.name}"`,
          "completionSignal.artifacts",
        ),
      );
    }
  }

  // No undeclared artifact names allowed when outputs are declared.
  const declaredNames = new Set(step.outputs.map((o) => o.name));
  for (const artifact of artifacts ?? []) {
    if (!declaredNames.has(artifact.name)) {
      return err(
        lifecycleValidationError(
          `Artifact "${artifact.name}" is not declared in step "${step.name}" outputs`,
          "completionSignal.artifacts",
        ),
      );
    }
  }

  return ok(undefined);
}

/**
 * Build the auto-advance effects for a successful configured step completion.
 *
 * - If a next step exists: updates `currentStepName`, renders the next step's
 *   prompt with the updated instance (including newly persisted artifacts),
 *   and returns a `dispatch-agent` effect.
 * - If this is the final step: updates status to `completed`, releases the
 *   active lease, and returns a `complete-execution` effect.
 */
function buildAutoAdvanceEffects(
  store: RuntimeStore,
  workflowInstanceId: WorkflowInstanceId,
  activeLease: ExecutionLease,
  workflowConfig: WorkflowConfig,
  completedStepName: string,
): ResultAsync<readonly LifecycleEffect[], LifecycleError> {
  const currentIndex = workflowConfig.steps.findIndex(
    (s) => s.name === completedStepName,
  );
  const nextStep =
    currentIndex >= 0 ? workflowConfig.steps[currentIndex + 1] : undefined;

  if (nextStep === undefined) {
    // Final step — complete the workflow and release the lease.
    return store.instances
      .update(workflowInstanceId, { status: "completed" })
      .mapErr(
        (storeError): LifecycleError =>
          lifecyclePersistenceError(storeError.message, {
            type: storeError.type,
            message: storeError.message,
          }),
      )
      .andThen(() =>
        store.leases.release(activeLease.id, activeLease.ownerId).mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, {
              type: storeError.type,
              message: storeError.message,
            }),
        ),
      )
      .map((): readonly LifecycleEffect[] => [
        { kind: "complete-execution", workflowInstanceId },
      ]);
  }

  // Non-final step — validate next step inputs, advance, and emit dispatch-agent effect.
  // Fetch the current instance (with newly persisted artifacts) before advancing.
  return store.instances
    .getById(workflowInstanceId)
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
    )
    .andThen((currentInstance) => {
      // Validate next step's declared inputs are available before advancing.
      const inputsCheck = validateStepInputs(nextStep, currentInstance);
      if (inputsCheck.isErr()) return errAsync(inputsCheck.error);
      return okAsync(currentInstance);
    })
    .andThen((currentInstance) =>
      store.instances
        .update(workflowInstanceId, { currentStepName: nextStep.name })
        .mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, {
              type: storeError.type,
              message: storeError.message,
            }),
        )
        .map(() => currentInstance),
    )
    .andThen((currentInstance) => {
      const artifactNames = currentInstance.artifacts.map((a) => a.name);
      const promptContext = buildStepPromptContext(currentInstance, nextStep);
      const promptResult = renderStepPrompt(
        nextStep.prompt,
        promptContext,
        artifactNames,
      );
      if (promptResult.isErr()) return errAsync(promptResult.error);
      const promptMetadata = promptResult.value;

      const runAgent = buildConfiguredRunAgentEffect(nextStep, promptMetadata);
      return okAsync([
        { kind: "dispatch-agent" as const, runAgent },
      ] as readonly LifecycleEffect[]);
    });
}

// ---------------------------------------------------------------------------
// 6. completeStep — implementation
// ---------------------------------------------------------------------------

/**
 * Record the completion of a workflow step and advance the workflow state.
 *
 * **With `input.context`** and `outcome === "success"`:
 * 1. Validates output artifacts against `step.outputs` (all-or-nothing).
 * 2. Persists validated artifacts via `store.instances.addArtifact()`.
 * 3. Auto-advances:
 *    - Non-final step: updates `currentStepName`, emits `dispatch-agent` for next step.
 *    - Final step: transitions to `completed`, releases lease, emits `complete-execution`.
 *
 * **Without `input.context`** (legacy):
 * - Maps `outcome` to status, persists any provided artifacts, returns legacy effects.
 *
 * Outcome → status mapping:
 * - `"success"` → `"running"` (or `"completed"` for final step with context)
 * - `"blocked"` → `"blocked"`
 * - `"failed"`  → `"failed"` (sets `errorMessage`)
 * - `"paused"`  → `"paused"` (emits `PauseExecutionEffect`)
 *
 * @param input - Step completion parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ effects })` on success, or a typed `LifecycleError`.
 */
export function completeStep(
  input: CompleteStepInput,
  store: RuntimeStore,
): ResultAsync<CompleteStepOutput, LifecycleError> {
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
  if (!input.stepName) {
    return errAsync(
      lifecycleValidationError("stepName is required", "stepName"),
    );
  }
  if (!input.completionSignal) {
    return errAsync(
      lifecycleValidationError(
        "completionSignal is required",
        "completionSignal",
      ),
    );
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  return store.leases
    .findActive()
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
    )
    .andThen((activeLease) => {
      if (activeLease === null) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            "none" as ExecutionLeaseId,
            "No active lease for this workflow instance",
          ),
        );
      }
      if (activeLease.id !== input.leaseId) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            activeLease.id,
            "Provided lease ID does not match the active lease",
          ),
        );
      }
      if (activeLease.workflowInstanceId !== input.workflowInstanceId) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            activeLease.id,
            `Lease ${input.leaseId} belongs to workflow ${activeLease.workflowInstanceId}, not ${input.workflowInstanceId}`,
          ),
        );
      }
      // Thread the active lease through for potential release on final step.
      return okAsync(activeLease);
    })
    .andThen((activeLease) =>
      store.instances
        .findById(input.workflowInstanceId)
        .mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, {
              type: storeError.type,
              message: storeError.message,
            }),
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

          const { outcome, message, artifacts } = input.completionSignal;

          // Configured path: context provided — validate step order, validate method,
          // handle gate logic, run plan checks, persist artifacts, auto-advance.
          if (input.context !== undefined) {
            const workflowConfig =
              input.context.workflows[existing.workflowName];

            if (workflowConfig === undefined) {
              return errAsync(
                lifecycleNotFoundError(
                  "WorkflowConfig",
                  existing.workflowName,
                  `Workflow "${existing.workflowName}" not found in provided workflow map`,
                ),
              );
            }

            const stepConfig = workflowConfig.steps.find(
              (s) => s.name === input.stepName,
            );
            if (stepConfig === undefined) {
              return errAsync(
                lifecycleNotFoundError(
                  "WorkflowStep",
                  input.stepName,
                  `Step "${input.stepName}" not found in workflow`,
                ),
              );
            }

            // Issue 3: Verify step order — input.stepName must match instance.currentStepName.
            // This prevents out-of-order completions from corrupting workflow state.
            if (
              existing.currentStepName !== undefined &&
              existing.currentStepName !== input.stepName
            ) {
              return errAsync(
                lifecycleValidationError(
                  `Out-of-order completion: step "${input.stepName}" cannot be completed while instance is on step "${existing.currentStepName}"`,
                  "stepName",
                ),
              );
            }

            // Validate completion method BEFORE any state changes.
            const methodCheck = validateCompletionMethod(
              input.completionSignal,
              stepConfig,
            );
            if (methodCheck.isErr()) return errAsync(methodCheck.error);

            // Issue 1: When stepConfig.completion.method is review_verdict,
            // require completionSignal.approved to be explicitly set.
            if (stepConfig.completion.method === "review_verdict") {
              if (input.completionSignal.approved === undefined) {
                return errAsync(
                  lifecycleValidationError(
                    `Step "${stepConfig.name}" uses review_verdict completion — completionSignal.approved must be true or false`,
                    "completionSignal.approved",
                  ),
                );
              }
              // Handle gate rejection (approved === false).
              if (input.completionSignal.approved === false) {
                return applyGateRejection(
                  store,
                  input.workflowInstanceId,
                  activeLease,
                  stepConfig,
                  message,
                ).map((effects): CompleteStepOutput => ({ effects }));
              }
              // approved === true falls through to the success path below.
            }

            // For non-success outcomes (blocked, failed, paused) with context:
            // apply status update, persist artifacts, release lease for terminal
            // outcomes (blocked/failed), and emit the appropriate effect.
            if (outcome !== "success") {
              const updateInput = buildUpdateInput(outcome, message);
              return store.instances
                .update(input.workflowInstanceId, updateInput)
                .mapErr(
                  (storeError): LifecycleError =>
                    lifecyclePersistenceError(storeError.message, {
                      type: storeError.type,
                      message: storeError.message,
                    }),
                )
                .andThen(() => {
                  if (!artifacts || artifacts.length === 0) {
                    return okAsync(undefined);
                  }
                  return addArtifactsSequentially(
                    store,
                    input.workflowInstanceId,
                    artifacts,
                  );
                })
                .andThen(
                  (): ResultAsync<
                    readonly LifecycleEffect[],
                    LifecycleError
                  > => {
                    // Paused is resumable — emit pause effect, keep lease held.
                    if (outcome === "paused") {
                      return okAsync([
                        {
                          kind: "pause-execution" as const,
                          workflowInstanceId: input.workflowInstanceId,
                        },
                      ]);
                    }
                    // Blocked/failed are terminal — release lease and emit complete-execution.
                    return store.leases
                      .release(activeLease.id, activeLease.ownerId)
                      .mapErr(
                        (storeError): LifecycleError =>
                          lifecyclePersistenceError(storeError.message, {
                            type: storeError.type,
                            message: storeError.message,
                          }),
                      )
                      .map((): readonly LifecycleEffect[] => [
                        {
                          kind: "complete-execution",
                          workflowInstanceId: input.workflowInstanceId,
                        },
                      ]);
                  },
                )
                .map((effects): CompleteStepOutput => ({ effects }));
            }

            // Success path: run plan checks based on stepConfig.completion.method
            // (Issue 1: always evaluate the step's declared method, not just when
            // signal.method is present).
            const planCheck: ResultAsync<undefined, LifecycleError> = (() => {
              if (stepConfig.completion.method === "plan_created") {
                if (!input.planStateProvider) {
                  return errAsync(
                    lifecyclePolicyDecisionError(
                      "plan completion method requires a planStateProvider",
                      "plan_state_provider",
                    ),
                  );
                }
                const planNameResult = renderPlanName(
                  stepConfig.completion.plan_name,
                  existing,
                );
                if (planNameResult.isErr())
                  return errAsync(planNameResult.error);
                return input.planStateProvider
                  .planExists(planNameResult.value)
                  .mapErr(
                    (providerErr): LifecycleError =>
                      mapPlanStateError(providerErr, planNameResult.value),
                  )
                  .andThen((exists) => {
                    if (!exists) {
                      const planPath = `.weave/plans/${planNameResult.value}.md`;
                      return errAsync(
                        lifecycleNotFoundError(
                          "plan_file",
                          planPath,
                          `Plan file "${planPath}" does not exist`,
                        ),
                      );
                    }
                    return okAsync(undefined);
                  });
              }
              if (stepConfig.completion.method === "plan_complete") {
                if (!input.planStateProvider) {
                  return errAsync(
                    lifecyclePolicyDecisionError(
                      "plan completion method requires a planStateProvider",
                      "plan_state_provider",
                    ),
                  );
                }
                const planNameResult = renderPlanName(
                  stepConfig.completion.plan_name,
                  existing,
                );
                if (planNameResult.isErr())
                  return errAsync(planNameResult.error);
                return input.planStateProvider
                  .isPlanComplete(planNameResult.value)
                  .mapErr(
                    (providerErr): LifecycleError =>
                      mapPlanStateError(providerErr, planNameResult.value),
                  )
                  .andThen((complete) => {
                    if (!complete) {
                      const planPath = `.weave/plans/${planNameResult.value}.md`;
                      return errAsync(
                        lifecycleValidationError(
                          `Plan "${planPath}" has incomplete checkbox(es) — all tasks must be checked off`,
                          "plan_complete",
                        ),
                      );
                    }
                    return okAsync(undefined);
                  });
              }
              return okAsync(undefined);
            })();

            return planCheck
              .andThen(() => {
                // Validate output artifacts before any writes (all-or-nothing).
                const outputCheck = validateOutputArtifacts(
                  stepConfig,
                  artifacts,
                );
                if (outputCheck.isErr()) return errAsync(outputCheck.error);
                return okAsync(undefined);
              })
              .andThen(() =>
                // Update status to running (interim; may be overridden to completed).
                store.instances
                  .update(input.workflowInstanceId, { status: "running" })
                  .mapErr(
                    (storeError): LifecycleError =>
                      lifecyclePersistenceError(storeError.message, {
                        type: storeError.type,
                        message: storeError.message,
                      }),
                  ),
              )
              .andThen(() => {
                if (!artifacts || artifacts.length === 0) {
                  return okAsync(undefined);
                }
                return addArtifactsSequentially(
                  store,
                  input.workflowInstanceId,
                  artifacts,
                );
              })
              .andThen(() =>
                buildAutoAdvanceEffects(
                  store,
                  input.workflowInstanceId,
                  activeLease,
                  workflowConfig,
                  input.stepName,
                ),
              )
              .map((effects): CompleteStepOutput => ({ effects }));
          }

          // Legacy path (no context): update status, persist artifacts, release lease
          // for terminal outcomes (blocked/failed), and return appropriate effects.
          const updateInput = buildUpdateInput(outcome, message);

          return store.instances
            .update(input.workflowInstanceId, updateInput)
            .mapErr(
              (storeError): LifecycleError =>
                lifecyclePersistenceError(storeError.message, {
                  type: storeError.type,
                  message: storeError.message,
                }),
            )
            .andThen(() => {
              if (!artifacts || artifacts.length === 0) {
                return okAsync(undefined);
              }
              return addArtifactsSequentially(
                store,
                input.workflowInstanceId,
                artifacts,
              );
            })
            .andThen(
              (): ResultAsync<readonly LifecycleEffect[], LifecycleError> => {
                // Paused is resumable — emit pause effect, keep lease held.
                if (outcome === "paused") {
                  return okAsync([
                    {
                      kind: "pause-execution" as const,
                      workflowInstanceId: input.workflowInstanceId,
                    },
                  ]);
                }
                // Success is handled by the auto-advance path above; this is the
                // legacy no-context success case — no lease release needed here.
                if (outcome === "success") {
                  return okAsync([]);
                }
                // Blocked/failed are terminal — release lease and emit complete-execution.
                return store.leases
                  .release(activeLease.id, activeLease.ownerId)
                  .mapErr(
                    (storeError): LifecycleError =>
                      lifecyclePersistenceError(storeError.message, {
                        type: storeError.type,
                        message: storeError.message,
                      }),
                  )
                  .map((): readonly LifecycleEffect[] => [
                    {
                      kind: "complete-execution",
                      workflowInstanceId: input.workflowInstanceId,
                    },
                  ]);
              },
            )
            .map((effects): CompleteStepOutput => ({ effects }));
        }),
    );
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

  // Enforce explicit user authorization — reject hook- and event-initiated
  // implicit-resume paths. The legacy workContinuation hook's automatic
  // Tapestry re-injection is superseded by this check (ADR 0004).
  // When authorizationSource is omitted, default to "user" for backward
  // compatibility with callers that pre-date this field.
  const authSource: ExecutionAuthorizationSource =
    input.authorizationSource ?? "user";
  const authCheck = validateAuthorizationSource(authSource, "resumeExecution");
  if (authCheck.isErr()) return errAsync(authCheck.error);

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  const ownerId = createOwnerId(input.ownerId);

  return store.instances
    .findById(input.workflowInstanceId)
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
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
          return lifecyclePersistenceError(storeError.message, {
            type: storeError.type,
            message: storeError.message,
          });
        })
        .andThen((lease) =>
          store.instances
            .update(input.workflowInstanceId, { status: "running" })
            .mapErr(
              (storeError): LifecycleError =>
                lifecyclePersistenceError(storeError.message, {
                  type: storeError.type,
                  message: storeError.message,
                }),
            )
            .map(() => lease),
        );
    })
    .map((lease) => ({
      leaseId: lease.id,
      effects: [] as LifecycleEffect[],
    }));
}

// ---------------------------------------------------------------------------
// 7. beforeTool — implementation
// ---------------------------------------------------------------------------

/**
 * Evaluate the abstract tool policy for a tool call that is about to execute.
 *
 * This is a pure policy evaluation — it does NOT access the Runtime Store.
 * The adapter has already mapped the concrete harness tool name to an abstract
 * capability (`toolCapability`) and supplied the fully-resolved
 * `effectiveToolPolicy`. The engine reads `effectiveToolPolicy[toolCapability]`
 * and returns the corresponding `allow` / `deny` / `ask` decision.
 *
 * ## Adapter / Engine Boundary
 *
 * - **Adapters own** concrete tool-name mapping: the adapter decides which
 *   abstract capability a harness tool corresponds to and passes it as
 *   `toolCapability`. The engine never inspects `toolName` for policy purposes.
 * - **The engine owns** abstract policy decisions: it reads the pre-computed
 *   `EffectiveToolPolicy` and returns the decision for the given capability.
 * - `toolName` in `BeforeToolInput` is for audit/logging only — the engine
 *   does not branch on it.
 *
 * @param input - Tool call context from the adapter.
 * @returns `okAsync({ decision })` on success, or a typed `LifecycleError`.
 */
export function beforeTool(input: BeforeToolInput): BeforeToolResult {
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
  if (!input.toolCapability) {
    return errAsync(
      lifecycleValidationError("toolCapability is required", "toolCapability"),
    );
  }
  if (!input.toolName) {
    return errAsync(
      lifecycleValidationError("toolName is required", "toolName"),
    );
  }
  if (!input.effectiveToolPolicy) {
    return errAsync(
      lifecycleValidationError(
        "effectiveToolPolicy is required",
        "effectiveToolPolicy",
      ),
    );
  }

  if (
    !(ABSTRACT_CAPABILITIES as readonly string[]).includes(input.toolCapability)
  ) {
    return errAsync(
      lifecycleValidationError(
        `toolCapability '${input.toolCapability}' is not a recognized abstract capability`,
        "toolCapability",
      ),
    );
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  const decision = input.effectiveToolPolicy[input.toolCapability];

  return okAsync({ decision });
}

// ---------------------------------------------------------------------------
// 9. approveArtifact — implementation
// ---------------------------------------------------------------------------

/**
 * Approve or reject an artifact produced by a prior workflow step.
 *
 * Enforces the **self-approval prohibition**: if `input.approverAgent` matches
 * the `producerAgent` recorded on the artifact, the engine returns a
 * `policy_decision` error. This prevents a producing agent from approving its
 * own output, which would bypass the gate review intent.
 *
 * The engine updates only the most recent revision of the named artifact
 * (identified by `artifactId`). Approval of an older revision that has been
 * superseded by a newer revision is not blocked at this layer — callers should
 * use `inspectExecution` to verify the current revision before approving.
 *
 * @param input - Approval parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ instance })` on success, or a typed `LifecycleError`.
 */
export function approveArtifact(
  input: ApproveArtifactInput,
  store: RuntimeStore,
): ApproveArtifactResult {
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
  if (!input.artifactId) {
    return errAsync(
      lifecycleValidationError("artifactId is required", "artifactId"),
    );
  }
  if (!input.approvalState) {
    return errAsync(
      lifecycleValidationError("approvalState is required", "approvalState"),
    );
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  return store.instances
    .findById(input.workflowInstanceId)
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
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

      // Find the artifact by ID (last occurrence = most recent revision).
      let artifact: ArtifactRef | undefined;
      for (let i = existing.artifacts.length - 1; i >= 0; i--) {
        if (existing.artifacts[i].id === input.artifactId) {
          artifact = existing.artifacts[i];
          break;
        }
      }

      if (artifact === undefined) {
        return errAsync(
          lifecycleNotFoundError(
            "ArtifactRef",
            input.artifactId as string,
            `Artifact '${input.artifactId}' not found in workflow instance`,
          ),
        );
      }

      // Self-approval prohibition: producer cannot approve their own artifact.
      if (
        input.approverAgent !== undefined &&
        artifact.producerAgent !== undefined &&
        input.approverAgent === artifact.producerAgent
      ) {
        return errAsync(
          lifecyclePolicyDecisionError(
            `Agent "${input.approverAgent}" cannot approve artifact "${artifact.name}" (revision ${artifact.revision}) because it produced that artifact. Self-approval is prohibited.`,
            "self_approval",
          ),
        );
      }

      return store.instances
        .updateArtifactApproval(
          input.workflowInstanceId,
          input.artifactId,
          input.approvalState,
        )
        .mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, {
              type: storeError.type,
              message: storeError.message,
            }),
        )
        .map((instance): ApproveArtifactOutput => ({ instance }));
    });
}

// ---------------------------------------------------------------------------
// 8. inspectExecution — implementation
// ---------------------------------------------------------------------------

/**
 * Inspect the current execution state of a workflow instance.
 *
 * This is a **read-only** operation — it never creates instances, acquires
 * leases, updates status, or emits lifecycle effects. It is the engine-owned
 * "inspect" operation in the `ExecutionOperationKind` vocabulary.
 *
 * Use this when adapters need to query execution state for display, routing,
 * or decision-making without advancing the workflow. Examples:
 * - Rendering a status dashboard
 * - Deciding whether to offer a "resume" affordance
 * - Checking whether an instance is already running before calling `startExecution`
 *
 * **Boundary invariant**: `inspectExecution` does NOT call `startExecution`,
 * `resumeExecution`, `dispatchStep`, or `completeStep`. It is safe to call
 * from any adapter context — including idle hooks, continuation hooks, and
 * session observations — without risking implicit execution start.
 *
 * @param input - Inspect parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok(InspectExecutionOutput)` on success, or a typed `LifecycleError`.
 */
export function inspectExecution(
  input: InspectExecutionInput,
  store: RuntimeStore,
): InspectExecutionResult {
  if (!input.workflowInstanceId) {
    return errAsync(
      lifecycleValidationError(
        "workflowInstanceId is required",
        "workflowInstanceId",
      ),
    );
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  return store.instances
    .findById(input.workflowInstanceId)
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
    )
    .andThen((instance) => {
      if (instance === null) {
        return errAsync(
          lifecycleNotFoundError(
            "WorkflowInstance",
            input.workflowInstanceId as string,
          ),
        );
      }

      // Check for an active lease — read-only, no side effects.
      return store.leases
        .findActive()
        .mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, {
              type: storeError.type,
              message: storeError.message,
            }),
        )
        .map((activeLease): InspectExecutionOutput => {
          const hasActiveLease =
            activeLease !== null &&
            activeLease.workflowInstanceId === instance.id;

          const output: InspectExecutionOutput = {
            workflowInstanceId: instance.id,
            status: instance.status,
            workflowName: instance.workflowName,
            goal: instance.goal,
            slug: instance.slug,
            createdAt: instance.createdAt,
            updatedAt: instance.updatedAt,
            artifacts: instance.artifacts,
            hasActiveLease,
            ...(instance.currentStepName !== undefined
              ? { currentStepName: instance.currentStepName }
              : {}),
            ...(instance.completedAt !== undefined
              ? { completedAt: instance.completedAt }
              : {}),
            ...(instance.errorMessage !== undefined
              ? { errorMessage: instance.errorMessage }
              : {}),
          };

          return output;
        });
    });
}

// ---------------------------------------------------------------------------
// Reconciliation — types, authorization, handler resolution, and enforcement
// ---------------------------------------------------------------------------

/**
 * The authorized source for each reconciliation reason (Spec 22 Unit 3).
 *
 * | Reason                  | Authorized source                                   |
 * |-------------------------|-----------------------------------------------------|
 * | `execution-mismatch`    | `"runtime"` — runtime validation or execution checks |
 * | `user-revision-request` | `"user"` — explicit user action                     |
 * | `review-rejection`      | `"review-gate"` — the review gate step              |
 * | `security-rejection`    | `"security-gate"` — the security gate step          |
 *
 * The engine rejects any source that does not match the authorized source for
 * the given reason with a `policy_decision` error.
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
 * The closed built-in reconciliation reason set (Spec 22 Unit 3).
 *
 * Mirrors `ReconciliationReason` from `@weave/core` for runtime use.
 * Only these four values are accepted at runtime.
 */
export const RECONCILIATION_REASONS = [
  "execution-mismatch",
  "user-revision-request",
  "review-rejection",
  "security-rejection",
] as const satisfies readonly ReconciliationReason[];

/**
 * Map from reconciliation reason to its single authorized source.
 *
 * Used by `validateReconciliationSource` to enforce the closed authorization
 * contract from Spec 22 Unit 3.
 */
const RECONCILIATION_AUTHORIZED_SOURCES: Readonly<
  Record<ReconciliationReason, ReconciliationAuthorizationSource>
> = {
  "execution-mismatch": "runtime",
  "user-revision-request": "user",
  "review-rejection": "review-gate",
  "security-rejection": "security-gate",
};

/**
 * Validate that the reconciliation source is authorized for the given reason.
 *
 * Returns `ok(undefined)` when the source matches the authorized source for
 * the reason. Returns a typed `policy_decision` error otherwise.
 *
 * @param reason - The reconciliation reason being triggered.
 * @param source - The declared authorization source from the adapter.
 * @returns `Result<undefined, LifecyclePolicyDecisionError>`
 */
export function validateReconciliationSource(
  reason: ReconciliationReason,
  source: ReconciliationAuthorizationSource,
): Result<undefined, LifecyclePolicyDecisionError> {
  const authorized = RECONCILIATION_AUTHORIZED_SOURCES[reason];
  if (source === authorized) return ok(undefined);
  return err(
    lifecyclePolicyDecisionError(
      `Reconciliation reason "${reason}" requires source "${authorized}" but received "${source}". ` +
        `Only the authorized source may trigger this reconciliation reason. ` +
        `See docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md Unit 3.`,
      "reconciliationSource",
    ),
  );
}

/**
 * Compute the set of step names that are `before-plan` steps in a workflow.
 *
 * A step is a `before-plan` step when the workflow publishes the `before-plan`
 * extension point (`extension_points.before_plan === true`) AND the step
 * appears before the canonical planning step (`role === "planning"`) in the
 * step list.
 *
 * **v1 rule**: `before-plan` steps do not participate in reconciliation
 * semantics. This function computes the exclusion set so that
 * `resolveReconciliationHandler` can skip them at runtime, providing a
 * defense-in-depth guarantee independent of the schema layer.
 *
 * When the workflow does not publish `before-plan`, the returned set is empty
 * (no steps are excluded).
 *
 * @param workflowConfig - The workflow definition.
 * @returns A `Set<string>` of step names that must be excluded from reconciliation.
 */
function computeBeforePlanExclusionSet(
  workflowConfig: WorkflowConfig,
): ReadonlySet<string> {
  // Only workflows that publish the before-plan extension point have before-plan steps.
  if (!workflowConfig.extension_points?.before_plan) return new Set();

  const planningIndex = workflowConfig.steps.findIndex(
    (s) => s.role === "planning",
  );
  // No planning step found — no before-plan steps to exclude.
  if (planningIndex < 0) return new Set();

  const excluded = new Set<string>();
  for (let i = 0; i < planningIndex; i++) {
    const step = workflowConfig.steps[i];
    if (step !== undefined) excluded.add(step.name);
  }
  return excluded;
}

/**
 * Resolve the nearest explicitly declared upstream handler step for a
 * reconciliation reason, searching backwards from the triggering step.
 *
 * **Algorithm**:
 * 1. Find the index of `triggeringStepName` in the workflow step list.
 * 2. Walk backwards from that index (exclusive) toward the start.
 * 3. Skip any step in the `beforePlanExclusions` set (v1 rule: before-plan
 *    steps do not participate in reconciliation semantics).
 * 4. Return the first step whose `reconciliation_handlers` list contains
 *    an entry with `reason === reconciliationReason`.
 * 5. If no handler is found, return `undefined` (fail-closed path).
 *
 * **`before-plan` exclusion**: steps that appear before the planning step in
 * a workflow that publishes `extension_points.before_plan` are excluded from
 * reconciliation handler resolution at runtime. This is a defense-in-depth
 * guarantee that complements the schema-layer constraint (no
 * `reconciliation_handlers` on before-plan steps). The runtime check ensures
 * the v1 rule holds even after config merge or composition.
 *
 * @param workflowConfig - The workflow definition containing the step list.
 * @param triggeringStepName - The step that triggered reconciliation.
 * @param reconciliationReason - The reason to match against handler declarations.
 * @param beforePlanExclusions - Set of step names excluded from reconciliation (before-plan steps).
 * @returns The nearest upstream handler step, or `undefined` if none exists.
 */
function resolveReconciliationHandler(
  workflowConfig: WorkflowConfig,
  triggeringStepName: string,
  reconciliationReason: ReconciliationReason,
  beforePlanExclusions: ReadonlySet<string>,
): WorkflowStep | undefined {
  const steps = workflowConfig.steps;
  const triggeringIndex = steps.findIndex((s) => s.name === triggeringStepName);

  // If the triggering step is not found, search from the end of the list.
  const searchFrom =
    triggeringIndex >= 0 ? triggeringIndex - 1 : steps.length - 1;

  for (let i = searchFrom; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined) continue;
    // v1 runtime rule: before-plan steps do not participate in reconciliation.
    if (beforePlanExclusions.has(step.name)) continue;
    if (!step.reconciliation_handlers) continue;
    const hasHandler = step.reconciliation_handlers.some(
      (h) => h.reason === reconciliationReason,
    );
    if (hasHandler) return step;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// 10. reconcileExecution — Input / Output
// ---------------------------------------------------------------------------

/**
 * Input for `reconcileExecution`.
 *
 * Adapters call this when a reconciliation event is triggered — a downstream
 * step has encountered a condition that requires routing back to an upstream
 * handler step. The engine enforces:
 *
 * 1. The `reason` must be one of the four closed built-in values.
 * 2. The `authorizationSource` must match the authorized source for the reason.
 * 3. The engine routes to the nearest explicitly declared upstream handler step.
 * 4. When no handler exists, the engine fails closed by pausing the instance.
 *
 * **Authorized sources per reason**:
 * - `execution-mismatch`    → `"runtime"`
 * - `user-revision-request` → `"user"`
 * - `review-rejection`      → `"review-gate"`
 * - `security-rejection`    → `"security-gate"`
 *
 * EXCLUDED: raw prompts, completions, transcripts, credentials, tokens,
 * cookies, authorization headers, raw provider payloads.
 *
 * @see docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md Unit 3
 */
export interface ReconcileExecutionInput {
  /** The workflow instance to reconcile. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The active execution lease. */
  readonly leaseId: ExecutionLeaseId;
  /**
   * The reconciliation reason — must be one of the four closed built-in values.
   *
   * - `execution-mismatch`    — runtime validation or execution checks detected a mismatch.
   * - `user-revision-request` — an explicit user action requested a revision.
   * - `review-rejection`      — the review gate returned a reject verdict.
   * - `security-rejection`    — the security gate returned a reject verdict.
   */
  readonly reason: ReconciliationReason;
  /**
   * The authorization source for this reconciliation event.
   *
   * Must match the authorized source for the given `reason`:
   * - `execution-mismatch`    → `"runtime"`
   * - `user-revision-request` → `"user"`
   * - `review-rejection`      → `"review-gate"`
   * - `security-rejection`    → `"security-gate"`
   *
   * The engine rejects mismatched sources with a `policy_decision` error.
   */
  readonly authorizationSource: ReconciliationAuthorizationSource;
  /**
   * The name of the step that triggered the reconciliation event.
   *
   * Used as the starting point for nearest-upstream handler resolution.
   * When omitted, the engine uses `instance.currentStepName`.
   */
  readonly triggeringStepName?: string;
  /**
   * Optional workflow execution context.
   *
   * When provided, the engine resolves the nearest upstream handler step
   * from the workflow config and emits a `dispatch-agent` effect for it.
   * When omitted, the engine falls back to a `pause-execution` effect
   * (fail-closed behavior without workflow topology).
   */
  readonly context?: WorkflowExecutionContext;
  /**
   * Optional provider for querying plan file state.
   *
   * When provided and the triggering step uses a `plan_complete` or
   * `plan_created` completion method, the engine checks whether the
   * associated plan file is already complete (all checkboxes checked).
   *
   * If the plan is complete, `reconcileExecution` returns a `policy_decision`
   * error — completed `Plan Markdown` tasks are immutable. Corrective work
   * must be expressed as follow-up tasks rather than in-place revisions.
   *
   * When absent, the immutability check is skipped (no plan state is queried).
   *
   * Adapters should supply `BunFilesystemPlanStateProvider` from `@weave/config`
   * (or a mock in tests).
   *
   * @see docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md Unit 3
   */
  readonly planStateProvider?: PlanStateProvider;
  /** Optional structured metadata about the reconciliation event. */
  readonly metadata?: SafeMetadata;
}

/**
 * Output from `reconcileExecution`.
 *
 * Returns the lifecycle effects resulting from the reconciliation routing
 * decision. The primary effect is either:
 * - `dispatch-agent` — routed to the nearest upstream handler step.
 * - `pause-execution` — no handler found; fail-closed pause.
 */
export interface ReconcileExecutionOutput {
  /**
   * The name of the handler step that was routed to, or `undefined` when
   * no handler was found and the engine failed closed with a pause.
   */
  readonly handlerStepName?: string;
  /**
   * Whether the engine found an explicit handler (`true`) or failed closed
   * with a pause because no handler exists (`false`).
   */
  readonly handlerFound: boolean;
  /** Lifecycle effects to apply. */
  readonly effects: readonly LifecycleEffect[];
  /**
   * The name of the gate step that must re-run after the corrective handler
   * completes, or `undefined` when the reconciliation reason is not gate-originated.
   *
   * Populated when `reason` is `"review-rejection"` or `"security-rejection"`.
   * The gate step named here is the step that originally rejected and must
   * re-run once the upstream handler has resolved the issue.
   *
   * Adapters use this field to schedule a re-dispatch of the gate step after
   * the handler step completes successfully. When `handlerFound` is `false`
   * (fail-closed pause), this field is still set so adapters can surface the
   * gate context to the user.
   *
   * @see docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md Unit 3
   */
  readonly gateReRunStepName?: string;
}

/** Result type for `reconcileExecution`. */
export type ReconcileExecutionResult = ResultAsync<
  ReconcileExecutionOutput,
  LifecycleError
>;

// ---------------------------------------------------------------------------
// Immutable completed plan check — helper for reconcileExecution
// ---------------------------------------------------------------------------

/**
 * Check whether the plan associated with the triggering step is already
 * complete, and if so, return a `policy_decision` error.
 *
 * **Immutability rule** (Spec 22 Unit 3):
 * Completed `Plan Markdown` tasks are immutable. Reconciliation must not
 * revise them in place. Corrective work must be expressed as follow-up tasks.
 *
 * This check applies only when:
 * 1. `planStateProvider` is provided.
 * 2. The triggering step's completion method is `"plan_complete"` or
 *    `"plan_created"` (i.e., the step is plan-oriented).
 * 3. The plan file exists and has no incomplete checkboxes.
 *
 * When the plan is complete, returns `err(LifecyclePolicyDecisionError)`.
 * When the plan is not complete, or the check is not applicable, returns
 * `ok(undefined)`.
 *
 * @param triggeringStep - The step that triggered reconciliation.
 * @param instance - The current workflow instance (for plan name rendering).
 * @param planStateProvider - Provider for querying plan file state.
 * @returns `ok(undefined)` when reconciliation may proceed, or a typed error.
 */
function checkCompletedPlanImmutability(
  triggeringStep: WorkflowStep,
  instance: WorkflowInstance,
  planStateProvider: PlanStateProvider,
): ResultAsync<undefined, LifecycleError> {
  const method = triggeringStep.completion.method;

  // Only check plan-oriented steps.
  if (method !== "plan_complete" && method !== "plan_created") {
    return okAsync(undefined);
  }

  const planNameResult = renderPlanName(
    triggeringStep.completion.plan_name,
    instance,
  );
  if (planNameResult.isErr()) return errAsync(planNameResult.error);
  const planName = planNameResult.value;

  return planStateProvider
    .isPlanComplete(planName)
    .mapErr(
      (providerErr): LifecycleError => mapPlanStateError(providerErr, planName),
    )
    .andThen((complete) => {
      if (!complete) return okAsync(undefined);
      const planPath = `.weave/plans/${planName}.md`;
      return errAsync(
        lifecyclePolicyDecisionError(
          `Reconciliation rejected: plan "${planPath}" has all tasks completed. ` +
            `Completed Plan Markdown tasks are immutable — corrective work must be expressed as follow-up tasks, not in-place revisions. ` +
            `See docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md Unit 3.`,
          "completed_plan_immutability",
        ),
      );
    });
}

// ---------------------------------------------------------------------------
// 10. reconcileExecution — implementation
// ---------------------------------------------------------------------------

/**
 * Trigger reconciliation for a workflow instance.
 *
 * Enforces the closed reconciliation reason set, validates the authorization
 * source, routes to the nearest explicitly declared upstream handler step,
 * and fails closed by pausing the instance when no handler exists.
 *
 * **Enforcement rules** (Spec 22 Unit 3):
 * 1. `reason` must be one of the four closed built-in values — validated
 *    at the type level by `ReconciliationReason` from `@weave/core`.
 * 2. `authorizationSource` must match the authorized source for `reason`.
 * 3. The engine walks workflow steps backwards from `triggeringStepName`
 *    and routes to the first step with a matching `reconciliation_handlers`
 *    entry. `before-plan` steps are excluded from this search at runtime.
 * 4. When no handler is found, the engine updates the instance to `paused`
 *    and emits a `pause-execution` effect (fail-closed).
 *
 * **`before-plan` exclusion**: `before-plan` steps do not participate in
 * reconciliation semantics in v1. This is enforced at runtime by
 * `computeBeforePlanExclusionSet` + `resolveReconciliationHandler`, providing
 * a defense-in-depth guarantee independent of the schema layer.
 *
 * **Gate re-run**: when `reason` is `"review-rejection"` or
 * `"security-rejection"`, the output carries `gateReRunStepName` set to the
 * triggering step name. Adapters use this to re-dispatch the gate step after
 * the corrective handler completes successfully (Spec 22 Unit 3).
 *
 * **Immutable completed plan tasks**: when `input.planStateProvider` is
 * provided and the triggering step uses a `plan_complete` or `plan_created`
 * completion method, the engine checks whether the associated plan file is
 * already complete (all checkboxes checked). If complete, `reconcileExecution`
 * returns a `policy_decision` error with rule `"completed_plan_immutability"`.
 * Completed `Plan Markdown` tasks are immutable — corrective work must be
 * expressed as follow-up tasks, not in-place revisions (Spec 22 Unit 3).
 *
 * @param input - Reconciliation parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok(ReconcileExecutionOutput)` on success, or a typed `LifecycleError`.
 */
export function reconcileExecution(
  input: ReconcileExecutionInput,
  store: RuntimeStore,
): ReconcileExecutionResult {
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
  if (!input.reason) {
    return errAsync(lifecycleValidationError("reason is required", "reason"));
  }
  if (!input.authorizationSource) {
    return errAsync(
      lifecycleValidationError(
        "authorizationSource is required",
        "authorizationSource",
      ),
    );
  }

  // Enforce the closed reason set — validate the authorization source.
  const sourceCheck = validateReconciliationSource(
    input.reason,
    input.authorizationSource,
  );
  if (sourceCheck.isErr()) return errAsync(sourceCheck.error);

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  // Verify the active lease matches the provided leaseId.
  return store.leases
    .findActive()
    .mapErr(
      (storeError): LifecycleError =>
        lifecyclePersistenceError(storeError.message, {
          type: storeError.type,
          message: storeError.message,
        }),
    )
    .andThen((activeLease) => {
      if (activeLease === null) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            "none" as ExecutionLeaseId,
            "No active lease for this workflow instance",
          ),
        );
      }
      if (activeLease.id !== input.leaseId) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            activeLease.id,
            "Provided lease ID does not match the active lease",
          ),
        );
      }
      if (activeLease.workflowInstanceId !== input.workflowInstanceId) {
        return errAsync(
          lifecycleLeaseConflictError(
            input.workflowInstanceId,
            activeLease.id,
            `Lease ${input.leaseId} belongs to workflow ${activeLease.workflowInstanceId}, not ${input.workflowInstanceId}`,
          ),
        );
      }
      return okAsync(activeLease);
    })
    .andThen((activeLease) =>
      store.instances
        .findById(input.workflowInstanceId)
        .mapErr(
          (storeError): LifecycleError =>
            lifecyclePersistenceError(storeError.message, {
              type: storeError.type,
              message: storeError.message,
            }),
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

          // Determine the triggering step name.
          const triggeringStepName =
            input.triggeringStepName ?? existing.currentStepName;

          // Determine the gate step that must re-run after corrective routing
          // resolves, when the reconciliation is gate-originated.
          // Spec 22 Unit 3: review and security gates must re-run after
          // reconciliation resolves a review- or security-originated rejection.
          const gateReRunStepName =
            input.reason === "review-rejection" ||
            input.reason === "security-rejection"
              ? (triggeringStepName ?? undefined)
              : undefined;

          // When no context is provided, fail closed immediately — no topology
          // to search, so pause the instance.
          if (input.context === undefined) {
            return store.instances
              .update(input.workflowInstanceId, { status: "paused" })
              .mapErr(
                (storeError): LifecycleError =>
                  lifecyclePersistenceError(storeError.message, {
                    type: storeError.type,
                    message: storeError.message,
                  }),
              )
              .map(
                (): ReconcileExecutionOutput => ({
                  handlerFound: false,
                  ...(gateReRunStepName !== undefined
                    ? { gateReRunStepName }
                    : {}),
                  effects: [
                    {
                      kind: "pause-execution",
                      workflowInstanceId: input.workflowInstanceId,
                      reason: `Reconciliation (${input.reason}): no workflow context provided — failing closed`,
                    },
                  ],
                }),
              );
          }

          // Resolve the workflow config.
          const workflowConfig = input.context.workflows[existing.workflowName];
          if (workflowConfig === undefined) {
            return errAsync(
              lifecycleNotFoundError(
                "WorkflowConfig",
                existing.workflowName,
                `Workflow "${existing.workflowName}" not found in provided workflow map`,
              ),
            );
          }

          // Compute the before-plan exclusion set for this workflow.
          // v1 rule: before-plan steps do not participate in reconciliation.
          const beforePlanExclusions =
            computeBeforePlanExclusionSet(workflowConfig);

          // Immutability check: if a planStateProvider is supplied, verify that
          // the triggering step's plan is not already complete. Completed Plan
          // Markdown tasks are immutable — corrective work must be expressed as
          // follow-up tasks, not in-place revisions (Spec 22 Unit 3).
          const triggeringStepConfig =
            triggeringStepName !== undefined
              ? workflowConfig.steps.find((s) => s.name === triggeringStepName)
              : undefined;

          if (
            input.planStateProvider !== undefined &&
            triggeringStepConfig !== undefined
          ) {
            const immutabilityCheck = checkCompletedPlanImmutability(
              triggeringStepConfig,
              existing,
              input.planStateProvider,
            );
            // We must await the async check before continuing.
            // Use andThen to chain the rest of the logic.
            return immutabilityCheck.andThen(() => {
              // Resolve the nearest upstream handler step, skipping before-plan steps.
              const handlerStep = resolveReconciliationHandler(
                workflowConfig,
                triggeringStepName ?? "",
                input.reason,
                beforePlanExclusions,
              );

              // Fail closed: no handler found — pause the instance.
              if (handlerStep === undefined) {
                return store.instances
                  .update(input.workflowInstanceId, { status: "paused" })
                  .mapErr(
                    (storeError): LifecycleError =>
                      lifecyclePersistenceError(storeError.message, {
                        type: storeError.type,
                        message: storeError.message,
                      }),
                  )
                  .map(
                    (): ReconcileExecutionOutput => ({
                      handlerFound: false,
                      ...(gateReRunStepName !== undefined
                        ? { gateReRunStepName }
                        : {}),
                      effects: [
                        {
                          kind: "pause-execution",
                          workflowInstanceId: input.workflowInstanceId,
                          reason: `Reconciliation (${input.reason}): no upstream handler declared — failing closed`,
                        },
                      ],
                    }),
                  );
              }

              // Handler found — update currentStepName and dispatch the handler step.
              return store.instances
                .update(input.workflowInstanceId, {
                  currentStepName: handlerStep.name,
                  status: "running",
                })
                .mapErr(
                  (storeError): LifecycleError =>
                    lifecyclePersistenceError(storeError.message, {
                      type: storeError.type,
                      message: storeError.message,
                    }),
                )
                .andThen((updatedInstance) => {
                  const artifactNames = updatedInstance.artifacts.map(
                    (a) => a.name,
                  );
                  const promptContext = buildStepPromptContext(
                    updatedInstance,
                    handlerStep,
                  );
                  const promptResult = renderStepPrompt(
                    handlerStep.prompt,
                    promptContext,
                    artifactNames,
                  );
                  if (promptResult.isErr()) return errAsync(promptResult.error);
                  const promptMetadata = promptResult.value;
                  const runAgent = buildConfiguredRunAgentEffect(
                    handlerStep,
                    promptMetadata,
                  );
                  return okAsync<ReconcileExecutionOutput, LifecycleError>({
                    handlerStepName: handlerStep.name,
                    handlerFound: true,
                    ...(gateReRunStepName !== undefined
                      ? { gateReRunStepName }
                      : {}),
                    effects: [{ kind: "dispatch-agent", runAgent }],
                  });
                });
            });
          }

          // Resolve the nearest upstream handler step, skipping before-plan steps.
          const handlerStep = resolveReconciliationHandler(
            workflowConfig,
            triggeringStepName ?? "",
            input.reason,
            beforePlanExclusions,
          );

          // Fail closed: no handler found — pause the instance.
          if (handlerStep === undefined) {
            return store.instances
              .update(input.workflowInstanceId, { status: "paused" })
              .mapErr(
                (storeError): LifecycleError =>
                  lifecyclePersistenceError(storeError.message, {
                    type: storeError.type,
                    message: storeError.message,
                  }),
              )
              .map(
                (): ReconcileExecutionOutput => ({
                  handlerFound: false,
                  ...(gateReRunStepName !== undefined
                    ? { gateReRunStepName }
                    : {}),
                  effects: [
                    {
                      kind: "pause-execution",
                      workflowInstanceId: input.workflowInstanceId,
                      reason: `Reconciliation (${input.reason}): no upstream handler declared — failing closed`,
                    },
                  ],
                }),
              );
          }

          // Handler found — update currentStepName and dispatch the handler step.
          return store.instances
            .update(input.workflowInstanceId, {
              currentStepName: handlerStep.name,
              status: "running",
            })
            .mapErr(
              (storeError): LifecycleError =>
                lifecyclePersistenceError(storeError.message, {
                  type: storeError.type,
                  message: storeError.message,
                }),
            )
            .andThen((updatedInstance) => {
              // Render the handler step prompt.
              const artifactNames = updatedInstance.artifacts.map(
                (a) => a.name,
              );
              const promptContext = buildStepPromptContext(
                updatedInstance,
                handlerStep,
              );
              const promptResult = renderStepPrompt(
                handlerStep.prompt,
                promptContext,
                artifactNames,
              );
              if (promptResult.isErr()) return errAsync(promptResult.error);
              const promptMetadata = promptResult.value;

              const runAgent = buildConfiguredRunAgentEffect(
                handlerStep,
                promptMetadata,
              );

              return okAsync<ReconcileExecutionOutput, LifecycleError>({
                handlerStepName: handlerStep.name,
                handlerFound: true,
                ...(gateReRunStepName !== undefined
                  ? { gateReRunStepName }
                  : {}),
                effects: [{ kind: "dispatch-agent", runAgent }],
              });
            });
        }),
    );
}
