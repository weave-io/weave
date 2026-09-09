/**
 * Run Workflow — the V2 adapter's engine-driven workflow runner.
 *
 * Drives a named workflow through `@weaveio/weave-engine`'s
 * `runWorkflowLifecycle` (engine-owned lifecycle state machine), supplying an
 * adapter-owned `projectEffect` callback that:
 *
 * 1. Composes the step's delegated prompt (`composeDelegatedPrompt`).
 * 2. Delivers it via `facade.session.prompt(...)`.
 * 3. Waits for step completion by subscribing to `facade.event.subscribe({ signal })`
 *    — an `AsyncIterable<V2Event>` — until a settlement event for the target
 *    session is observed (A4 finding: cancellation is `AbortSignal`-only, no
 *    `Registration` handle for event subscriptions).
 * 4. Confirms drain via `facade.session.wait(...)`.
 *
 * This module never re-implements workflow step-progression logic itself —
 * `runWorkflowLifecycle` (imported unchanged from `@weaveio/weave-engine`) owns
 * the state machine. This module is a thin driver that bridges V2 session/event
 * primitives into the engine's `projectEffect` seam.
 *
 * On completion (success, pause, or error) or external abort, any
 * `V2Registration`s supplied via `registrations` are disposed.
 *
 * This module MUST NOT import from `packages/adapters/opencode/` (the V1
 * adapter) — see `./errors.ts` header for the independent V2 error union
 * rationale.
 */

import type { WorkflowConfig } from "@weaveio/weave-core";
import type {
  DispatchAgentEffect,
  PlanStateProvider,
  RuntimeStore,
  WorkflowRunnerError,
  WorkflowRunnerOutput,
} from "@weaveio/weave-engine";
import { logger, runWorkflowLifecycle } from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  eventSubscriptionError,
  type OpenCode2AdapterError,
  registrationDisposeError,
  sessionOperationError,
} from "./errors.js";
import type { PluginContextFacade } from "./plugin-context.js";
import { composeDelegatedPrompt } from "./projection-helpers.js";
import type { V2Event, V2Registration } from "./sdk-types.js";

const log = logger.child({ module: "run-workflow" });

// ---------------------------------------------------------------------------
// § 1 — Settlement event detection
// ---------------------------------------------------------------------------

/** Event types that indicate a session has finished (or failed) its current step. */
const SETTLEMENT_EVENT_TYPES = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.idle",
]);

/**
 * True iff `event` is a settlement event for `sessionID`.
 *
 * Narrows via a structural check (`type` + `data.sessionID`) rather than a
 * discriminated-union switch, because `V2Event` is a large sealed-boundary
 * union re-exported opaquely from `./sdk-types` — this module only needs to
 * detect the small subset of session-lifecycle event shapes it cares about.
 */
function isSettlementEventFor(event: V2Event, sessionID: string): boolean {
  const candidate = event as unknown as {
    type?: string;
    data?: { sessionID?: string };
  };
  if (candidate.type === undefined) return false;
  if (!SETTLEMENT_EVENT_TYPES.has(candidate.type)) return false;
  return candidate.data?.sessionID === sessionID;
}

// ---------------------------------------------------------------------------
// § 2 — waitForStepSettlement — event.subscribe-driven step wait
// ---------------------------------------------------------------------------

/**
 * Subscribe to `facade.event.subscribe({ signal })` and iterate until a
 * settlement event for `sessionID` is observed, the iterable ends (queue
 * drained with no further events), or `signal` is aborted.
 *
 * Returns `ok("settled")` when a settlement event was observed, or
 * `ok("aborted")` when the signal was aborted or the iterable ended without a
 * settlement event (treated as a clean, non-throwing abort path — the caller
 * decides whether to continue or halt).
 */
function waitForStepSettlement(
  facade: PluginContextFacade,
  sessionID: string,
  signal: AbortSignal,
): ResultAsync<"settled" | "aborted", OpenCode2AdapterError> {
  return ResultAsync.fromPromise(
    (async (): Promise<"settled" | "aborted"> => {
      const events = facade.event.subscribe({ signal });
      for await (const event of events) {
        if (signal.aborted) return "aborted";
        if (isSettlementEventFor(event, sessionID)) return "settled";
      }
      return signal.aborted ? "aborted" : "settled";
    })(),
    (cause) => eventSubscriptionError(cause),
  );
}

// ---------------------------------------------------------------------------
// § 3 — buildProjectEffect — DispatchAgentEffect → session.prompt + wait
// ---------------------------------------------------------------------------

/**
 * Build the adapter-owned `projectEffect` callback required by
 * `runWorkflowLifecycle`.
 *
 * For each `DispatchAgentEffect`:
 * 1. Compose the delegated prompt and deliver via `facade.session.prompt(...)`.
 * 2. Wait for step settlement via `waitForStepSettlement` (event-driven).
 * 3. Confirm drain via `facade.session.wait(...)`.
 *
 * On abort (detected by `waitForStepSettlement` returning `"aborted"`),
 * returns `err({ type: "projection_error", ... })` so the engine's
 * `runWorkflowLifecycle` loop halts cleanly without throwing.
 */
export function buildProjectEffect(
  facade: PluginContextFacade,
  sessionID: string,
  signal: AbortSignal,
): (effect: DispatchAgentEffect) => ResultAsync<void, WorkflowRunnerError> {
  return (effect: DispatchAgentEffect) => {
    const text = composeDelegatedPrompt(effect);

    log.info(
      { agentName: effect.runAgent.agentName, sessionID },
      "Delivering delegated prompt via facade.session.prompt",
    );

    return ResultAsync.fromPromise(
      facade.session.prompt({
        sessionID,
        text,
        delivery: "queue",
      } as Parameters<PluginContextFacade["session"]["prompt"]>[0]),
      (cause): WorkflowRunnerError => ({
        type: "projection_error" as const,
        message: `session.prompt failed for agent "${effect.runAgent.agentName}"`,
        cause,
      }),
    )
      .andThen(() =>
        waitForStepSettlement(facade, sessionID, signal).mapErr(
          (cause): WorkflowRunnerError => ({
            type: "projection_error" as const,
            message: `event subscription failed while awaiting step settlement for agent "${effect.runAgent.agentName}"`,
            cause,
          }),
        ),
      )
      .andThen((settlement) => {
        if (settlement === "aborted") {
          log.warn(
            { agentName: effect.runAgent.agentName, sessionID },
            "Workflow run aborted while awaiting step settlement",
          );
          return errAsync<void, WorkflowRunnerError>({
            type: "projection_error" as const,
            message: "Workflow run aborted",
          });
        }

        return ResultAsync.fromPromise(
          facade.session.wait({ sessionID } as Parameters<
            PluginContextFacade["session"]["wait"]
          >[0]),
          (cause): WorkflowRunnerError => ({
            type: "projection_error" as const,
            message: `session.wait failed for agent "${effect.runAgent.agentName}"`,
            cause,
          }),
        );
      });
  };
}

// ---------------------------------------------------------------------------
// § 4 — disposeRegistrations — best-effort teardown
// ---------------------------------------------------------------------------

/**
 * Dispose every captured `V2Registration` in order. Collects (rather than
 * short-circuits on) individual dispose failures so a single failing
 * registration does not prevent the others from being disposed.
 */
function disposeRegistrations(
  registrations: readonly V2Registration[],
): ResultAsync<void, OpenCode2AdapterError> {
  return ResultAsync.fromSafePromise(
    Promise.allSettled(registrations.map((r) => r.dispose())),
  ).andThen((results) => {
    const failure = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failure !== undefined) {
      return errAsync(registrationDisposeError("command", failure.reason));
    }
    return okAsync(undefined);
  });
}

// ---------------------------------------------------------------------------
// § 5 — runWorkflow — main entry point
// ---------------------------------------------------------------------------

/** Input for `runWorkflow`. */
export interface RunWorkflowInput {
  /** Name of the workflow to run (must exist in `workflows`). */
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
  readonly workflows: Record<string, WorkflowConfig>;
  /** Target session that receives each step's delegated prompt. */
  readonly sessionID: string;
  /** Optional plan state provider for plan_created/plan_complete steps. */
  readonly planStateProvider?: PlanStateProvider;
  /** Safety cap on the number of steps dispatched. Defaults to 100. */
  readonly maxSteps?: number;
  /** Optional ISO-8601 timestamp override (for testing). */
  readonly now?: string;
  /**
   * `V2Registration`s (e.g. from `registerCommands`) to dispose once the
   * workflow run completes, pauses, errors, or is aborted.
   */
  readonly registrations?: readonly V2Registration[];
}

/**
 * Drive a named workflow through the engine's `runWorkflowLifecycle`,
 * bridging V2 session/event primitives into the engine-owned lifecycle state
 * machine via `buildProjectEffect`.
 *
 * An internal `AbortController` is created and chained to `abortSignal` (if
 * supplied) so callers can cancel an in-progress run; the chained signal is
 * passed to every `facade.event.subscribe({ signal })` call.
 *
 * Every entry in `input.registrations` is disposed on completion, whether the
 * run succeeds, pauses, errors, or is aborted.
 *
 * @param facade - Narrow facade over the V2 plugin context.
 * @param input - Workflow run parameters.
 * @param abortSignal - Optional external abort signal.
 * @returns `ok(WorkflowRunnerOutput)` on success, or
 *   `err(OpenCode2AdapterError)` on failure.
 */
export function runWorkflow(
  facade: PluginContextFacade,
  input: RunWorkflowInput,
  abortSignal?: AbortSignal,
): ResultAsync<WorkflowRunnerOutput, OpenCode2AdapterError> {
  const controller = new AbortController();
  if (abortSignal !== undefined) {
    if (abortSignal.aborted) controller.abort();
    else abortSignal.addEventListener("abort", () => controller.abort());
  }

  const registrations = input.registrations ?? [];
  const projectEffect = buildProjectEffect(
    facade,
    input.sessionID,
    controller.signal,
  );

  log.info(
    { workflowName: input.workflowName, sessionID: input.sessionID },
    "runWorkflow — delegating to engine runWorkflowLifecycle",
  );

  return runWorkflowLifecycle({
    workflowName: input.workflowName,
    goal: input.goal,
    slug: input.slug,
    ownerId: input.ownerId,
    store: input.store,
    workflows: input.workflows,
    projectEffect: (effect) =>
      projectEffect(effect).mapErr((error) => {
        // Map the adapter's own OpenCode2AdapterError-wrapped causes back to
        // a plain WorkflowRunnerError shape expected by runWorkflowLifecycle.
        return error;
      }),
    planStateProvider: input.planStateProvider,
    maxSteps: input.maxSteps,
    now: input.now,
  })
    .mapErr(
      (error): OpenCode2AdapterError =>
        sessionOperationError("prompt", input.sessionID, error),
    )
    .andThen((output) => disposeRegistrations(registrations).map(() => output))
    .orElse((error) =>
      disposeRegistrations(registrations).andThen(() => errAsync(error)),
    );
}
