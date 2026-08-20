/**
 * The single, adapter-owned resolution path for "which plan task is active
 * right now" in Pi's UI.
 *
 * Before this module the compact plan widget, the durable current-task footer,
 * and the Alt+T plan popup each resolved the active workflow themselves. Three
 * lookups meant three chances to disagree: a widget could keep painting a
 * workflow the footer had already dropped, and a recovered workflow could be
 * resolved from a pointer the rest of the session never saw.
 *
 * Everything here is read-only. The resolver may *observe* an eligible
 * recoverable pointer so the surfaces can show a paused plan, but it never
 * starts, resumes, reacquires, or authorizes anything - only `/weave:resume`
 * (with its own fresh confirmation and lease recheck) may do that.
 *
 * Failures never leak: every error outcome carries a fixed, path-free message
 * that is safe to show in the UI. The underlying failure is deliberately not
 * part of the outcome, so no filesystem path or raw adapter error can reach a
 * status line, widget, or popup through this module.
 */
import {
  type ActivePlanTask,
  type PlanTaskSnapshot,
  selectActivePlanTask,
} from "@weaveio/weave-engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  isPointerEligibleForExplicitResume,
  type PiWeaveRecoveryPointerV1,
} from "./recovery-pointer.js";

/**
 * Where the resolved plan identity came from, in descending authority.
 *
 * `current` is the session's own trusted controller state. `recovery` is an
 * eligible recoverable pointer observed at startup - shown, never resumed.
 * `foreground` is the DISPLAY-ONLY identity of a plan the user authorized this
 * session to work through in its own turn (`/weave:start`, or one explicit
 * request naming a contained plan path). It carries no workflow instance
 * because there is none, and it is resolved last so it can only fill a gap.
 */
export type ActivePlanIdentitySource = "current" | "recovery" | "foreground";

export type ActivePlanIdentity =
  | {
      readonly source: "current" | "recovery";
      readonly workflowInstanceId: string;
    }
  | { readonly source: "foreground"; readonly planName: string };

/**
 * The workflow instance an identity names, or `undefined` when it names none.
 *
 * A foreground identity is display-only and structurally has no instance, so
 * callers ask through this accessor rather than reading a field that may not
 * be there.
 */
export function activePlanWorkflowInstanceId(
  identity: ActivePlanIdentity | undefined,
): string | undefined {
  return identity !== undefined && identity.source !== "foreground"
    ? identity.workflowInstanceId
    : undefined;
}

/** Why there is nothing to show. Not a failure - the UI simply clears. */
export type ActivePlanEmptyReason =
  | "no-controller"
  | "no-active-workflow"
  | "no-eligible-recovery-pointer"
  | "workflow-terminal"
  | "foreground-plan-complete"
  | "foreground-plan-unavailable";

/**
 * Statuses that end an execution. A settled workflow is not "the active plan"
 * for any surface, so resolving one is the same as resolving nothing - which
 * is what makes a completed/cancelled/failed settlement clear the UI instead of
 * freezing its last snapshot on screen.
 */
const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** True when this status means the execution has settled for good. */
export function isTerminalWorkflowStatus(status: string): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

/** Why a lookup failed. Each maps to one fixed, path-free message. */
export type ActivePlanErrorReason =
  | "recovery-unreadable"
  | "workflow-unreadable"
  | "plan-unreadable";

export interface ActivePlanUiError {
  readonly reason: ActivePlanErrorReason;
  readonly safeMessage: string;
}

/** The resolved, successful outcome: either an active plan or nothing at all. */
export type ActivePlanView =
  | {
      readonly kind: "active";
      readonly identity: ActivePlanIdentity;
      readonly planName: string;
      readonly snapshot: PlanTaskSnapshot;
      /** `undefined` when the plan exists but has no selectable active task. */
      readonly activeTask: ActivePlanTask | undefined;
    }
  | { readonly kind: "empty"; readonly reason: ActivePlanEmptyReason };

/**
 * The narrow read-only port the resolver needs. Deliberately structural and
 * free of Pi and controller types so it can be driven directly in tests, and
 * deliberately without any method that could mutate execution state.
 */
export interface ActivePlanReadPort {
  /** The workflow instance this session currently tracks, if any. */
  readonly currentWorkflowInstanceId: string | undefined;
  /**
   * The DISPLAY-ONLY plan this session was authorized to work through in the
   * foreground, if any.
   *
   * Read last and never turned into execution: it names a plan to paint, and
   * the resolver's only use for it is one `readPlanSnapshot` call in this
   * project root.
   */
  readonly foregroundPlanName?: string | undefined;
  readonly inspect: (
    workflowInstanceId: string,
  ) => ResultAsync<{ readonly slug: string; readonly status: string }, unknown>;
  readonly readPlanSnapshot: (
    planName: string,
  ) => ResultAsync<PlanTaskSnapshot, unknown>;
  readonly readRecoveryPointer: () => ResultAsync<
    PiWeaveRecoveryPointerV1 | undefined,
    unknown
  >;
}

const SAFE_MESSAGES: Readonly<Record<ActivePlanErrorReason, string>> = {
  "recovery-unreadable":
    "Weave could not read its recovery state. Use /weave:status for details.",
  "workflow-unreadable":
    "Weave could not read the active workflow. Use /weave:status for details.",
  "plan-unreadable":
    "Weave could not read the active plan. Use /weave:plan for details.",
};

function fail(reason: ActivePlanErrorReason): ActivePlanUiError {
  return { reason, safeMessage: SAFE_MESSAGES[reason] };
}

const EMPTY = (reason: ActivePlanEmptyReason): ActivePlanView => ({
  kind: "empty",
  reason,
});

/**
 * Resolves the one workflow identity the whole UI should agree on.
 *
 * Trusted current controller state always wins. Only when nothing is tracked
 * does the resolver fall back to an eligible recoverable pointer, and only to
 * *display* it: terminal, untrusted, quarantined, and workflow-id-less
 * pointers are all treated as nothing to show.
 */
export function resolveActivePlanIdentity(
  port: ActivePlanReadPort,
): ResultAsync<ActivePlanIdentity | ActivePlanEmptyReason, ActivePlanUiError> {
  const current = port.currentWorkflowInstanceId;
  if (current !== undefined && current.length > 0) {
    return okAsync({ workflowInstanceId: current, source: "current" as const });
  }
  const foreground = (
    reason: ActivePlanEmptyReason,
  ): ActivePlanIdentity | ActivePlanEmptyReason => {
    const planName = port.foregroundPlanName;
    return planName !== undefined && planName.length > 0
      ? { source: "foreground" as const, planName }
      : reason;
  };
  return port
    .readRecoveryPointer()
    .mapErr(() => fail("recovery-unreadable"))
    .andThen((pointer) => {
      if (pointer === undefined) {
        return okAsync(foreground("no-active-workflow"));
      }
      if (
        !isPointerEligibleForExplicitResume(pointer) ||
        pointer.workflowId === undefined
      ) {
        return okAsync(foreground("no-eligible-recovery-pointer"));
      }
      return okAsync({
        workflowInstanceId: pointer.workflowId,
        source: "recovery" as const,
      });
    });
}

/**
 * The one lookup: identity -> `inspect()` -> `slug` -> `readPlanSnapshot()` ->
 * the engine's own `selectActivePlanTask`. Every caller that shows plan state
 * goes through this, so widget, footer, and popup cannot disagree.
 */
export function resolveActivePlanView(
  port: ActivePlanReadPort,
): ResultAsync<ActivePlanView, ActivePlanUiError> {
  return resolveActivePlanIdentity(port).andThen((resolved) => {
    if (typeof resolved === "string") return okAsync(EMPTY(resolved));
    // A foreground plan has no workflow instance to inspect, by construction.
    // The plan file in THIS project root is the whole of its state, and a plan
    // with nothing left to do clears the rail exactly as a settled workflow
    // does - display-only state may not outlive the work it describes.
    if (resolved.source === "foreground") {
      return (
        port
          .readPlanSnapshot(resolved.planName)
          // A plan this project root cannot read is NOT an error here, and the
          // resolver never looks for it anywhere else: display-only state that
          // has nothing to display simply shows the agent identity alone. A plan
          // living in another worktree therefore stays invisible rather than
          // being read across roots or reported as a failure on every repaint.
          .orElse(() => okAsync(EMPTY("foreground-plan-unavailable")))
          .map((snapshot): ActivePlanView => {
            if ("kind" in snapshot) return snapshot;
            const activeTask = selectActivePlanTask(snapshot).match(
              (task) => task,
              () => undefined,
            );
            if (activeTask === undefined || snapshot.complete) {
              return EMPTY("foreground-plan-complete");
            }
            return {
              kind: "active",
              identity: resolved,
              planName: resolved.planName,
              snapshot,
              activeTask,
            };
          })
      );
    }
    return port
      .inspect(resolved.workflowInstanceId)
      .mapErr(() => fail("workflow-unreadable"))
      .andThen((inspected) => {
        // A settled execution is authoritative evidence that there is nothing
        // active to paint, whether it settled under this session's own tracker
        // or was named by a recovery pointer that has since gone terminal.
        if (isTerminalWorkflowStatus(inspected.status)) {
          return okAsync(EMPTY("workflow-terminal"));
        }
        return port
          .readPlanSnapshot(inspected.slug)
          .mapErr(() => fail("plan-unreadable"))
          .map((snapshot): ActivePlanView => {
            const activeTask = selectActivePlanTask(snapshot).match(
              (task) => task,
              () => undefined,
            );
            return {
              kind: "active",
              identity: resolved,
              planName: inspected.slug,
              snapshot,
              activeTask,
            };
          });
      });
  });
}

/**
 * What happened to one `resolve()` call by the time it finished.
 *
 * Resolution is asynchronous and callers are fire-and-forget, so two lookups
 * started in the same generation can overlap. `superseded` says "a newer
 * lookup (or a `clear()`) took over while this one was in flight": its result
 * is stale by construction and must be discarded, not painted. Only `applied`
 * carries a view that is still the latest word on the active plan.
 *
 * A superseded failure is reported on the *success* channel deliberately: a
 * stale error must clear nothing and say nothing, exactly like a stale view.
 */
export type ActivePlanResolution =
  | { readonly status: "applied"; readonly view: ActivePlanView }
  | { readonly status: "superseded" };

const SUPERSEDED: ActivePlanResolution = { status: "superseded" };

/**
 * The session-scoped holder of the resolved identity and snapshot.
 *
 * `resolve()` clears the retained identity *before* it looks anything up, so a
 * stale workflow can never survive a current/recovery transition, a failed
 * lookup, a terminal settlement, or a generation change: the only way to hold
 * an identity is to have just resolved it successfully.
 *
 * Every `resolve()` and every `clear()` takes a fresh monotonic token and so
 * invalidates whatever was already in flight. That makes resolution
 * last-request-wins: an older lookup that finishes after a newer one can no
 * longer overwrite the newer retained view with its own active, empty, or
 * failed outcome.
 */
export interface ActivePlanUiState {
  /** The last successfully resolved identity, or `undefined`. */
  readonly identity: () => ActivePlanIdentity | undefined;
  /** The last successfully resolved view, or `undefined` once cleared. */
  readonly view: () => ActivePlanView | undefined;
  /** Drops every retained identity and snapshot. Idempotent. */
  readonly clear: () => void;
  readonly resolve: (
    port: ActivePlanReadPort,
  ) => ResultAsync<ActivePlanResolution, ActivePlanUiError>;
}

export function createActivePlanUiState(): ActivePlanUiState {
  let retained: ActivePlanView | undefined;
  // Monotonic and never reused: the only token that may write retained state
  // is the one taken by the most recent `resolve()`/`clear()`.
  let latestToken = 0;
  const nextToken = (): number => {
    latestToken += 1;
    return latestToken;
  };
  const clear = (): void => {
    nextToken();
    retained = undefined;
  };
  return {
    identity: () =>
      retained !== undefined && retained.kind === "active"
        ? retained.identity
        : undefined,
    view: () => retained,
    clear,
    resolve: (port) => {
      // Clear first: an in-flight lookup must never leave the previous
      // workflow visible if it fails or resolves to nothing. Taking the token
      // here is what invalidates any lookup already in flight.
      const token = nextToken();
      retained = undefined;
      const isLatest = (): boolean => token === latestToken;
      return resolveActivePlanView(port)
        .andThen(
          (view): ResultAsync<ActivePlanResolution, ActivePlanUiError> => {
            if (!isLatest()) return okAsync(SUPERSEDED);
            retained = view;
            return okAsync({ status: "applied", view });
          },
        )
        .orElse(
          (error): ResultAsync<ActivePlanResolution, ActivePlanUiError> => {
            if (!isLatest()) return okAsync(SUPERSEDED);
            retained = undefined;
            return errAsync(error);
          },
        );
    },
  };
}
