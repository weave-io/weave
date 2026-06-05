/**
 * Runtime Command Projection — OpenCode adapter-owned command handlers and renderers.
 *
 * This module is the OpenCode adapter's projection layer for the six runtime
 * command operations defined in the shared engine:
 *
 * | Command              | Engine operation      | OpenCode label            |
 * |----------------------|-----------------------|---------------------------|
 * | Start plan           | `startPlan`           | `/weave:start`            |
 * | Run named workflow   | `runNamedWorkflow`    | `/weave:run`              |
 * | Inspect status       | `inspectStatus`       | `/weave:status`           |
 * | Abort execution      | `abortExecution`      | `/weave:abort`            |
 * | Advance step         | `advanceStep`         | `/weave:advance`          |
 * | Runtime health       | `runtimeHealth`       | `/weave:health`           |
 *
 * ## Boundary rules
 *
 * - Argument parsing, command labels, and OpenCode-specific messages are
 *   adapter-owned and live here.
 * - Lifecycle state-transition logic is **never duplicated** — all delegated
 *   to the matching engine operation.
 * - Native slash/TUI affordances that are not yet implemented in this slice
 *   are documented as degraded equivalents (see `DEGRADED_AFFORDANCES`).
 * - `/start-work` is out of scope for this module.
 *
 * ## Rendered result shapes
 *
 * Each handler returns a `ProjectionResult<T>` — a discriminated union of
 * `success`, `failure`, and `degraded` outcomes. Adapters format these for
 * slash commands, plugin tools, UI actions, or scripts without duplicating
 * lifecycle logic.
 *
 * @see packages/engine/src/runtime-command-operations/types.ts — engine types
 * @see packages/adapters/opencode/src/start-plan-execution.ts — /weave:start delivery path
 * @see packages/adapters/opencode/src/run-workflow.ts — named-workflow execution
 * @see docs/adapter-boundary.md
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 */

import type {
  AbortExecutionInput,
  AdapterHealthReport,
  AdvanceStepInput,
  CommandOperationError,
  ExecutionAbortedData,
  ExecutionStartedData,
  ExecutionStatusData,
  PlanStateProvider,
  RuntimeHealthData,
  RuntimeStore,
  StepAdvancedData,
} from "@weave/engine";
import {
  abortExecution,
  advanceStep,
  buildAdapterHealthReport,
  inspectStatus,
  logger,
  runNamedWorkflow,
  runtimeHealth,
  startPlan,
} from "@weave/engine";

import type { OpenCodeAdapter } from "./adapter.js";
import { buildProjectEffect } from "./projection-helpers.js";

const log = logger.child({ module: "runtime-command-projection" });

// ---------------------------------------------------------------------------
// § 1 — OpenCode command label constants (adapter-owned)
// ---------------------------------------------------------------------------

/**
 * OpenCode slash-command labels for each projected runtime command.
 *
 * These are adapter-owned identifiers. Core packages must never reference them.
 * `/start-work` is out of scope for this module — see `start-plan-execution.ts`.
 */
export const WEAVE_COMMAND_LABELS = {
  startPlan: "/weave:start",
  runWorkflow: "/weave:run",
  status: "/weave:status",
  abort: "/weave:abort",
  advance: "/weave:advance",
  health: "/weave:health",
} as const satisfies Record<string, string>;

// ---------------------------------------------------------------------------
// § 2 — Degraded affordance documentation
// ---------------------------------------------------------------------------

/**
 * Native slash/TUI affordances that are not yet implemented in this slice.
 *
 * These are documented as degraded equivalents. Adapters that register
 * OpenCode slash commands should surface these notes to users when the
 * native affordance is unavailable.
 */
export const DEGRADED_AFFORDANCES: readonly {
  readonly command: string;
  readonly reason: string;
  readonly equivalent: string;
}[] = [
  {
    command: "/weave:abort",
    reason: "Native TUI abort button not yet wired to abortExecution",
    equivalent: "Call abortExecution via plugin tool or script",
  },
  {
    command: "/weave:advance",
    reason: "Native TUI step-advance UI not yet wired to advanceStep",
    equivalent: "Call advanceStep via plugin tool or script",
  },
] as const;

// ---------------------------------------------------------------------------
// § 3 — Projection result types (adapter-owned rendered shapes)
// ---------------------------------------------------------------------------

/**
 * A successful projection result carrying renderer-ready data.
 */
export interface ProjectionSuccess<T> {
  readonly outcome: "success";
  readonly command: string;
  readonly data: T;
  /** Human-readable summary for OpenCode slash-command output. */
  readonly message: string;
}

/**
 * A failed projection result carrying a typed engine error.
 */
export interface ProjectionFailure {
  readonly outcome: "failure";
  readonly command: string;
  readonly error: CommandOperationError;
  /** Human-readable error message for OpenCode slash-command output. */
  readonly message: string;
}

/**
 * A degraded projection result — the operation partially succeeded or ran
 * with reduced capability.
 */
export interface ProjectionDegraded<T> {
  readonly outcome: "degraded";
  readonly command: string;
  readonly data?: T;
  /** Human-readable degradation reason for OpenCode slash-command output. */
  readonly message: string;
  /** Actionable hint for the user. */
  readonly hint?: string;
}

/**
 * Discriminated union of all projection result variants.
 */
export type ProjectionResult<T> =
  | ProjectionSuccess<T>
  | ProjectionFailure
  | ProjectionDegraded<T>;

// ---------------------------------------------------------------------------
// § 4 — Input types for each projected command (adapter-owned)
// ---------------------------------------------------------------------------

/**
 * Input for the projected start-plan command.
 *
 * Adapter-owned: argument parsing, default values, and OpenCode-specific
 * fields are resolved here before delegating to the engine's `startPlan`.
 */
export interface StartPlanProjectionInput {
  /** Name of the plan file to start. */
  readonly planName: string;
  /** Name of the workflow to use for plan execution. */
  readonly workflowName: string;
  /** Human-readable goal for this execution instance. */
  readonly goal: string;
  /** URL-safe slug for this execution instance. */
  readonly slug: string;
  /** Owner identifier for the execution lease. */
  readonly ownerId: string;
  /** Runtime store for persisting the workflow instance and lease. */
  readonly store: RuntimeStore;
  /** Provider for plan file existence checks. */
  readonly planStateProvider: PlanStateProvider;
  /** Workflow registry — maps workflow names to workflow configs. */
  readonly workflows: Record<string, unknown>;
  /** OpenCode adapter instance — `spawnSubagent` is called for each DispatchAgentEffect. */
  readonly adapter: OpenCodeAdapter;
  /** Optional ISO-8601 timestamp override (for testing). */
  readonly now?: string;
}

/**
 * Input for the projected run-named-workflow command.
 *
 * Adapter-owned: argument parsing, default values, and OpenCode-specific
 * fields are resolved here before delegating to the engine's `runNamedWorkflow`.
 */
export interface RunWorkflowProjectionInput {
  /** Name of the workflow to run. */
  readonly workflowName: string;
  /** Human-readable goal for this execution instance. */
  readonly goal: string;
  /** URL-safe slug for this execution instance. */
  readonly slug: string;
  /** Owner identifier for the execution lease. */
  readonly ownerId: string;
  /** Runtime store for persisting the workflow instance and lease. */
  readonly store: RuntimeStore;
  /** Workflow registry — maps workflow names to workflow configs. */
  readonly workflows: Record<string, unknown>;
  /** OpenCode adapter instance — `spawnSubagent` is called for each DispatchAgentEffect. */
  readonly adapter: OpenCodeAdapter;
  /** Optional plan state provider for plan_created/plan_complete steps. */
  readonly planStateProvider?: PlanStateProvider;
  /** Optional ISO-8601 timestamp override (for testing). */
  readonly now?: string;
}

/**
 * Input for the projected inspect-status command.
 */
export interface InspectStatusProjectionInput {
  /** Workflow instance to inspect. */
  readonly workflowInstanceId: string;
  /** Runtime store for reading the workflow instance. */
  readonly store: RuntimeStore;
}

/**
 * Input for the projected abort-execution command.
 */
export interface AbortExecutionProjectionInput {
  /** Workflow instance to abort. */
  readonly workflowInstanceId: string;
  /** Active lease ID for the execution. */
  readonly leaseId: string;
  /** Abort signal: `"cancel"` terminates; `"pause"` suspends. */
  readonly signal: "cancel" | "pause";
  /** Runtime store for reading/writing the workflow instance. */
  readonly store: RuntimeStore;
}

/**
 * Input for the projected advance-step command.
 */
export interface AdvanceStepProjectionInput {
  /** Workflow instance containing the blocked step. */
  readonly workflowInstanceId: string;
  /** Active lease ID for the execution. */
  readonly leaseId: string;
  /** Name of the step to advance. */
  readonly stepName: string;
  /** Completion signal describing how the step finished. */
  readonly completionSignal: AdvanceStepInput["completionSignal"];
  /** Runtime store for reading/writing the workflow instance. */
  readonly store: RuntimeStore;
  /** Optional plan state provider for plan_created/plan_complete steps. */
  readonly planStateProvider?: PlanStateProvider;
  /** Optional workflow execution context for step completion routing. */
  readonly context?: AdvanceStepInput["context"];
}

/**
 * Input for the projected runtime-health command.
 *
 * Adapters build the `AdapterHealthReport` before calling this handler.
 * The engine never performs harness-specific probes.
 */
export interface RuntimeHealthProjectionInput {
  /** Adapter-supplied health report from the capability contract. */
  readonly healthReport: AdapterHealthReport;
  /** Explicit list of operations the adapter considers degraded. */
  readonly degradedOperations?: readonly string[];
  /** Explicit list of operations the adapter considers unsupported. */
  readonly unsupportedOperations?: readonly string[];
}

// ---------------------------------------------------------------------------
// § 5 — renderCommandError — format engine errors as OpenCode messages
// ---------------------------------------------------------------------------

/**
 * Render a `CommandOperationError` as a human-readable OpenCode message.
 *
 * Adapter-owned: message formatting is OpenCode-specific. The engine never
 * formats user-facing messages.
 */
function renderCommandError(
  command: string,
  error: CommandOperationError,
): string {
  if (error.type === "command_not_found") {
    return `[${command}] Not found: ${error.entity} "${error.name}" — ${error.message}`;
  }

  if (error.type === "command_validation") {
    const field = error.field ? ` (field: ${error.field})` : "";
    return `[${command}] Validation error${field}: ${error.message}`;
  }

  if (error.type === "command_unsupported") {
    return `[${command}] Unsupported: ${error.reason}`;
  }

  if (error.type === "command_degraded") {
    return `[${command}] Degraded: ${error.reason}`;
  }

  // command_lifecycle
  return `[${command}] Lifecycle error (${error.cause.type}): ${
    "message" in error.cause ? error.cause.message : "unknown cause"
  }`;
}

// ---------------------------------------------------------------------------
// § 6 — RuntimeCommandProjection — adapter-owned command handler class
// ---------------------------------------------------------------------------

/**
 * OpenCode adapter-owned projection of the six runtime command operations.
 *
 * Each method:
 * 1. Parses/validates adapter-owned arguments.
 * 2. Delegates to the matching shared engine operation.
 * 3. Renders a typed `ProjectionResult<T>` — success, failure, or degraded.
 *
 * No lifecycle state-transition logic is duplicated here. All lifecycle
 * semantics are owned by the engine operations.
 *
 * ## Usage
 *
 * ```ts
 * const projection = new RuntimeCommandProjection();
 *
 * const result = await projection.handleStartPlan({
 *   planName: "feature-auth",
 *   workflowName: "tapestry-execution",
 *   goal: "Implement authentication",
 *   slug: "implement-authentication",
 *   ownerId: "weave:start",
 *   store,
 *   planStateProvider: adapter.planStateProvider,
 *   workflows: config.workflows,
 *   adapter,
 * });
 *
 * result.match(
 *   (r) => { if (r.outcome === "success") console.log(r.message); },
 *   () => {}, // never — ProjectionResult is always ok
 * );
 * ```
 */
export class RuntimeCommandProjection {
  // -------------------------------------------------------------------------
  // § 6.1 — handleStartPlan
  // -------------------------------------------------------------------------

  /**
   * Handle the `/weave:start` command — start execution of a named plan.
   *
   * Delegates to the engine's `startPlan` operation. Supplies the adapter-owned
   * `projectEffect` callback that calls `adapter.spawnSubagent` for each
   * `DispatchAgentEffect`. Returns a typed `ProjectionResult<ExecutionStartedData>`.
   *
   * No lifecycle state-transition logic is duplicated here.
   *
   * @param input - Start-plan projection parameters.
   * @returns `ProjectionResult<ExecutionStartedData>` — always resolves (never rejects).
   */
  async handleStartPlan(
    input: StartPlanProjectionInput,
  ): Promise<ProjectionResult<ExecutionStartedData>> {
    const command = WEAVE_COMMAND_LABELS.startPlan;

    log.info(
      { planName: input.planName, workflowName: input.workflowName },
      "handleStartPlan — delegating to engine startPlan",
    );

    const projectEffect = buildProjectEffect(input.adapter);

    const result = await startPlan(
      {
        planName: input.planName,
        workflowName: input.workflowName,
        goal: input.goal,
        slug: input.slug,
        ownerId: input.ownerId,
        store: input.store,
        workflows: input.workflows,
        planStateProvider: input.planStateProvider,
        now: input.now,
      },
      projectEffect,
    );

    return result.match(
      (data): ProjectionResult<ExecutionStartedData> => ({
        outcome: "success",
        command,
        data,
        message: `[${command}] Plan "${input.planName}" started — workflow instance ${data.workflowInstanceId} (workflow: ${data.workflowName}, ${data.effects.length} effect(s) applied)`,
      }),
      (error): ProjectionResult<ExecutionStartedData> => ({
        outcome: "failure",
        command,
        error,
        message: renderCommandError(command, error),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // § 6.2 — handleRunWorkflow
  // -------------------------------------------------------------------------

  /**
   * Handle the `/weave:run` command — explicitly run a named workflow.
   *
   * Delegates to the engine's `runNamedWorkflow` operation. Supplies the
   * adapter-owned `projectEffect` callback. Returns a typed
   * `ProjectionResult<ExecutionStartedData>`.
   *
   * Named workflow execution is explicitly separate from ordinary plan
   * execution. `/start-work` is out of scope for this handler.
   *
   * No lifecycle state-transition logic is duplicated here.
   *
   * @param input - Run-workflow projection parameters.
   * @returns `ProjectionResult<ExecutionStartedData>` — always resolves.
   */
  async handleRunWorkflow(
    input: RunWorkflowProjectionInput,
  ): Promise<ProjectionResult<ExecutionStartedData>> {
    const command = WEAVE_COMMAND_LABELS.runWorkflow;

    log.info(
      { workflowName: input.workflowName },
      "handleRunWorkflow — delegating to engine runNamedWorkflow",
    );

    const projectEffect = buildProjectEffect(input.adapter);

    const result = await runNamedWorkflow(
      {
        workflowName: input.workflowName,
        goal: input.goal,
        slug: input.slug,
        ownerId: input.ownerId,
        store: input.store,
        workflows: input.workflows,
        planStateProvider: input.planStateProvider,
        now: input.now,
      },
      projectEffect,
    );

    return result.match(
      (data): ProjectionResult<ExecutionStartedData> => ({
        outcome: "success",
        command,
        data,
        message: `[${command}] Workflow "${input.workflowName}" started — instance ${data.workflowInstanceId} (${data.effects.length} effect(s) applied)`,
      }),
      (error): ProjectionResult<ExecutionStartedData> => ({
        outcome: "failure",
        command,
        error,
        message: renderCommandError(command, error),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // § 6.3 — handleInspectStatus
  // -------------------------------------------------------------------------

  /**
   * Handle the `/weave:status` command — read-only inspection of execution state.
   *
   * Delegates to the engine's `inspectStatus` operation. This is a read-only
   * operation — it never creates instances, acquires leases, or emits effects.
   *
   * No lifecycle state-transition logic is duplicated here.
   *
   * @param input - Inspect-status projection parameters.
   * @returns `ProjectionResult<ExecutionStatusData>` — always resolves.
   */
  async handleInspectStatus(
    input: InspectStatusProjectionInput,
  ): Promise<ProjectionResult<ExecutionStatusData>> {
    const command = WEAVE_COMMAND_LABELS.status;

    log.info(
      { workflowInstanceId: input.workflowInstanceId },
      "handleInspectStatus — delegating to engine inspectStatus",
    );

    const result = await inspectStatus({
      workflowInstanceId: input.workflowInstanceId as Parameters<
        typeof inspectStatus
      >[0]["workflowInstanceId"],
      store: input.store,
    });

    return result.match(
      (data): ProjectionResult<ExecutionStatusData> => ({
        outcome: "success",
        command,
        data,
        message: `[${command}] Instance ${data.workflowInstanceId}: status=${data.status}, workflow=${data.workflowName}, step=${data.currentStepName ?? "none"}, activeLease=${data.hasActiveLease}`,
      }),
      (error): ProjectionResult<ExecutionStatusData> => ({
        outcome: "failure",
        command,
        error,
        message: renderCommandError(command, error),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // § 6.4 — handleAbortExecution
  // -------------------------------------------------------------------------

  /**
   * Handle the `/weave:abort` command — cancel or pause an active execution.
   *
   * Delegates to the engine's `abortExecution` operation. Returns a typed
   * `ProjectionResult<ExecutionAbortedData>`.
   *
   * **Degraded affordance**: the native TUI abort button is not yet wired to
   * this handler. Users can invoke it via plugin tool or script.
   *
   * No lifecycle state-transition logic is duplicated here.
   *
   * @param input - Abort-execution projection parameters.
   * @returns `ProjectionResult<ExecutionAbortedData>` — always resolves.
   */
  async handleAbortExecution(
    input: AbortExecutionProjectionInput,
  ): Promise<ProjectionResult<ExecutionAbortedData>> {
    const command = WEAVE_COMMAND_LABELS.abort;

    log.info(
      {
        workflowInstanceId: input.workflowInstanceId,
        leaseId: input.leaseId,
        signal: input.signal,
      },
      "handleAbortExecution — delegating to engine abortExecution",
    );

    const result = await abortExecution({
      workflowInstanceId:
        input.workflowInstanceId as AbortExecutionInput["workflowInstanceId"],
      leaseId: input.leaseId as AbortExecutionInput["leaseId"],
      signal: input.signal,
      store: input.store,
    });

    return result.match(
      (data): ProjectionResult<ExecutionAbortedData> => ({
        outcome: "success",
        command,
        data,
        message: `[${command}] Instance ${data.workflowInstanceId} aborted (signal: ${data.signal}, ${data.effects.length} effect(s) applied)`,
      }),
      (error): ProjectionResult<ExecutionAbortedData> => ({
        outcome: "failure",
        command,
        error,
        message: renderCommandError(command, error),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // § 6.5 — handleAdvanceStep
  // -------------------------------------------------------------------------

  /**
   * Handle the `/weave:advance` command — advance or complete a blocked step.
   *
   * Delegates to the engine's `advanceStep` operation. Returns a typed
   * `ProjectionResult<StepAdvancedData>`.
   *
   * **Degraded affordance**: the native TUI step-advance UI is not yet wired
   * to this handler. Users can invoke it via plugin tool or script.
   *
   * No lifecycle state-transition logic is duplicated here.
   *
   * @param input - Advance-step projection parameters.
   * @returns `ProjectionResult<StepAdvancedData>` — always resolves.
   */
  async handleAdvanceStep(
    input: AdvanceStepProjectionInput,
  ): Promise<ProjectionResult<StepAdvancedData>> {
    const command = WEAVE_COMMAND_LABELS.advance;

    log.info(
      {
        workflowInstanceId: input.workflowInstanceId,
        leaseId: input.leaseId,
        stepName: input.stepName,
        outcome: input.completionSignal.outcome,
      },
      "handleAdvanceStep — delegating to engine advanceStep",
    );

    const result = await advanceStep({
      workflowInstanceId:
        input.workflowInstanceId as AdvanceStepInput["workflowInstanceId"],
      leaseId: input.leaseId as AdvanceStepInput["leaseId"],
      stepName: input.stepName,
      completionSignal: input.completionSignal,
      store: input.store,
      planStateProvider: input.planStateProvider,
      context: input.context,
    });

    return result.match(
      (data): ProjectionResult<StepAdvancedData> => ({
        outcome: "success",
        command,
        data,
        message: `[${command}] Step "${data.stepName}" advanced in instance ${data.workflowInstanceId} (signal: ${data.completionSignal.outcome}, ${data.effects.length} effect(s) applied)`,
      }),
      (error): ProjectionResult<StepAdvancedData> => ({
        outcome: "failure",
        command,
        error,
        message: renderCommandError(command, error),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // § 6.6 — handleRuntimeHealth
  // -------------------------------------------------------------------------

  /**
   * Handle the `/weave:health` command — report adapter/runtime readiness.
   *
   * Delegates to the engine's `runtimeHealth` operation. This is a pure
   * operation — it performs no harness I/O. Adapters build the
   * `AdapterHealthReport` before calling this handler.
   *
   * Returns a typed `ProjectionResult<RuntimeHealthData>`. The result is
   * always `success` (the engine's `runtimeHealth` never fails), but the
   * data may indicate degraded or unsupported operations.
   *
   * No lifecycle state-transition logic is duplicated here.
   *
   * @param input - Runtime-health projection parameters.
   * @returns `ProjectionResult<RuntimeHealthData>` — always resolves as success.
   */
  async handleRuntimeHealth(
    input: RuntimeHealthProjectionInput,
  ): Promise<ProjectionResult<RuntimeHealthData>> {
    const command = WEAVE_COMMAND_LABELS.health;

    log.info(
      {
        harness: input.healthReport.harness,
        ready: input.healthReport.profileResult.ready,
      },
      "handleRuntimeHealth — delegating to engine runtimeHealth",
    );

    const result = await runtimeHealth({
      healthReport: input.healthReport,
      degradedOperations: input.degradedOperations,
      unsupportedOperations: input.unsupportedOperations,
    });

    return result.match(
      (data): ProjectionResult<RuntimeHealthData> => {
        const ready = data.healthReport.profileResult.ready;
        const degradedCount = data.degradedOperations.length;
        const unsupportedCount = data.unsupportedOperations.length;

        if (!ready || degradedCount > 0 || unsupportedCount > 0) {
          return {
            outcome: "degraded",
            command,
            data,
            message: `[${command}] Adapter "${data.healthReport.harness}" is ${ready ? "ready with degraded capabilities" : "not ready"} — ${degradedCount} degraded, ${unsupportedCount} unsupported`,
            hint: data.degradedOperations[0] ?? data.unsupportedOperations[0],
          };
        }

        return {
          outcome: "success",
          command,
          data,
          message: `[${command}] Adapter "${data.healthReport.harness}" is ready — all capabilities satisfied, command-entrypoints: ${data.commandEntrypointsSupported ? "supported" : "not supported"}`,
        };
      },
      (error): ProjectionResult<RuntimeHealthData> => ({
        outcome: "failure",
        command,
        error,
        message: renderCommandError(command, error),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// § 7 — buildOpenCodeHealthReport — adapter-owned health report builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal `AdapterHealthReport` for the OpenCode adapter.
 *
 * This is a convenience helper for tests and plugin entry points that need
 * to construct a health report without duplicating the capability contract
 * boilerplate. Production callers should build a full capability contract
 * using `buildAdapterHealthReport` from `@weave/engine`.
 *
 * The report declares `command-entrypoints` as `emulated` (OpenCode exposes
 * slash commands as the explicit delivery path) and all other required
 * capabilities as `native` or `emulated` based on the adapter's known
 * implementation state.
 *
 * @param overrides - Optional capability overrides for testing.
 * @returns A normalized `AdapterHealthReport`.
 */
export function buildOpenCodeHealthReport(overrides?: {
  readonly commandEntrypointsReadiness?:
    | "native"
    | "emulated"
    | "degraded"
    | "unsupported";
  readonly degradedOperations?: readonly string[];
  readonly unsupportedOperations?: readonly string[];
}): AdapterHealthReport {
  return buildAdapterHealthReport({
    harness: "opencode",
    capabilityContract: {
      capabilities: [
        {
          id: "config-materialization",
          description: "Load and materialize .weave/config.weave",
          readiness: "native",
          notes: "OpenCode adapter reads config via @weave/config discovery",
        },
        {
          id: "agent-materialization",
          description: "Materialize agents into OpenCode via SDK",
          readiness: "native",
          notes: "OpenCodeAdapter.spawnSubagent calls reconcileAgent via SDK",
        },
        {
          id: "primary-agent-selection",
          description: "Select primary agent (Loom) for user-facing sessions",
          readiness: "native",
          notes: "Plugin registers Loom as the primary agent via OpenCode SDK",
        },
        {
          id: "delegated-specialist-execution",
          description: "Delegate to specialist agents (Shuttle, Weft, Warp)",
          readiness: "native",
          notes: "spawnSubagent materializes specialist agents on demand",
        },
        {
          id: "prompt-composition",
          description: "Compose prompts with Mustache templates",
          readiness: "native",
          notes: "Engine template renderer handles all prompt composition",
        },
        {
          id: "tool-policy-mapping",
          description: "Map Weave tool policies to OpenCode permissions",
          readiness: "native",
          notes: "tool-policy-mapping.ts translates allow/deny/ask to OpenCode",
        },
        {
          id: "workflow-persistence",
          description: "Persist workflow instances and leases",
          readiness: "native",
          notes: "RuntimeStore (InMemory or SQLite) persists execution state",
        },
        {
          id: "workflow-step-dispatch",
          description:
            "Dispatch individual workflow steps via engine lifecycle",
          readiness: "native",
          notes: "runWorkflowLifecycle drives step dispatch through the engine",
        },
        {
          id: "plan-file-compatibility",
          description: "Resolve plan files via BunFilesystemPlanStateProvider",
          readiness: "native",
          notes: "BunFilesystemPlanStateProvider reads .weave/plans/*.md",
        },
        {
          id: "command-entrypoints",
          description: "Expose explicit user-authorized execution triggers",
          readiness: overrides?.commandEntrypointsReadiness ?? "emulated",
          notes:
            "OpenCode slash commands (/weave:start, /weave:run) are the explicit delivery path",
        },
        {
          id: "event-logging",
          description: "Log structured events via pino",
          readiness: "native",
          notes:
            "All adapter modules use the shared pino logger from @weave/engine",
        },
        {
          id: "token-usage-reporting",
          description: "Report token usage from OpenCode sessions",
          readiness: "unsupported",
          notes:
            "OpenCode SDK does not expose per-session token usage in this version",
        },
      ],
    },
    probeResults: [],
  });
}

// ---------------------------------------------------------------------------
// § 8 — createDefaultStore — convenience helper for tests
// ---------------------------------------------------------------------------

/**
 * Create a default `InMemoryRuntimeStore` for use in projection handlers.
 *
 * Convenience re-export for callers that need a store without importing
 * directly from `@weave/engine`.
 */
export { createInMemoryRuntimeStore as createDefaultStore } from "@weave/engine";
