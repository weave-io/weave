/**
 * Session-transition lifecycle runtime (Pi adapter contract).
 *
 * Owns the awaited, vetoable pre-transition surfaces (`session_before_switch`,
 * `session_before_fork`, `session_before_tree`), the generation-scoped
 * transition notice cell, the Stay/Proceed guard prompt, ResultAsync
 * exception conversion around prompt and settlement, and the bounded
 * quit/reload shutdown orchestration helpers.
 *
 * The extension keeps orchestration only: it registers the handlers this
 * module returns and calls the shutdown helper. Everything here reaches the
 * live controller and UI through explicit ports, never through
 * extension-local closures, so generation isolation stays a property of the
 * ports rather than of accidental capture.
 */
import { okAsync, ResultAsync } from "neverthrow";
import {
  clearChildOverlayGeneration,
  clearThreadSources,
  type PiChildInspectionRegistryCell,
  type PiChildOverlayCell,
  type PiChildOverlayKeysCell,
  type PiChildTreeSelectionCell,
  type PiDelegationControllerCell,
  type PiThreadSourcesCell,
} from "./child-inspection-runtime.js";
import { ROOT_NODE_ID } from "./child-tree.js";
import type {
  PiShutdownReport,
  PiTransitionSettlementReport,
} from "./delegation-controller.js";
import {
  makeChildAbortFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type {
  PiEventHandler,
  PiExtensionApi,
  PiSessionContext,
} from "./types.js";

/**
 * Session-transition prompt options. `Stay` is listed first so it is the
 * pre-selected default, and every non-`Proceed` answer - including cancel and
 * dialog timeout - is treated as `Stay`.
 */
export const SESSION_TRANSITION_STAY = "Stay";
export const SESSION_TRANSITION_PROCEED = "Proceed";
export const SESSION_TRANSITION_NO_UI_NOTICE =
  "Weave: delegated children are still active and no dialog is available; the session transition was refused.";
export const SESSION_TRANSITION_PROMPT_FAILED_NOTICE =
  "Weave: the session-transition prompt failed, so the transition was refused.";
export const SESSION_TRANSITION_GUARD_FAILED_NOTICE =
  "Weave: the session-transition guard failed, so the transition was refused.";

/** Narrow UI port the guard needs: dialog select plus error notify. */
export interface PiSessionTransitionUiPort {
  notify(message: string, level?: "error" | "warning" | "info"): void;
  select(
    title: string,
    options: readonly string[],
  ): Promise<string | undefined>;
}

/** Narrow context port: dialog-capable UI presence and the UI itself. */
export interface PiSessionTransitionContextPort {
  readonly hasUI: boolean;
  readonly ui: PiSessionTransitionUiPort;
}

/**
 * Narrow controller port the transition guard and shutdown path need.
 * Deliberately exposes no spawn/steer surface - only unsettled counting,
 * confirmed transition settlement, and bounded quit/reload stop.
 */
export interface PiSessionTransitionControllerPort {
  countUnsettledDescendants(): number;
  settleForTransition(): ResultAsync<
    PiTransitionSettlementReport,
    PiAdapterFailure
  >;
  shutdownWithinBudget(budgetMs?: number): ResultAsync<PiShutdownReport, never>;
}

/**
 * Last session-transition diagnostic shown to the user. Generation-scoped: a
 * fresh destination session must never inherit an origin session's old-child
 * notice.
 */
export interface PiSessionTransitionNoticeCell {
  value: string | undefined;
}

export function createSessionTransitionNoticeCell(): PiSessionTransitionNoticeCell {
  return { value: undefined };
}

/** Shows one fixed transition notice, ignoring a UI that cannot show it. */
export function notifySessionTransition(
  ctx: PiSessionTransitionContextPort | undefined,
  notice: string,
): void {
  if (ctx === undefined) return;
  void ResultAsync.fromPromise(
    Promise.resolve(ctx.ui.notify(notice, "error")),
    () => undefined,
  );
}

/** Narrows an event payload to a plain record, or `undefined`. Never throws. */
function asJsonRecord(event: unknown): Record<string, unknown> | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return undefined;
  }
  return event as Record<string, unknown>;
}

/** Reads one string field from an event payload, or `undefined`. Never throws. */
export function readTransitionEventString(
  event: unknown,
  field: string,
): string | undefined {
  const record = asJsonRecord(event);
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

/** Labels a `session_before_switch` event for the Stay/Proceed prompt. */
export function labelSessionBeforeSwitch(event: unknown): string {
  return readTransitionEventString(event, "reason") ?? "new session";
}

/**
 * Labels a `session_before_fork` event. Pi uses `position: "at"` for `/clone`
 * and every other position for `/fork`.
 */
export function labelSessionBeforeFork(event: unknown): string {
  return readTransitionEventString(event, "position") === "at"
    ? "clone"
    : "fork";
}

/** Labels a `session_before_tree` event for the Stay/Proceed prompt. */
export function labelSessionBeforeTree(_event: unknown): string {
  return "tree navigation";
}

export type PiSessionTransitionVeto = { readonly cancel: true };
export type PiSessionTransitionHookResult = PiSessionTransitionVeto | undefined;

export interface PiSessionTransitionGuardDeps {
  readonly noticeCell: PiSessionTransitionNoticeCell;
  /** The live controller for the current generation, or none. */
  readonly currentController: () =>
    | PiSessionTransitionControllerPort
    | undefined;
}

/**
 * Guards one awaited, vetoable Pi session-transition surface.
 *
 * Order is fixed and observable: count owned descendants, prompt (default
 * **Stay**), cancel the whole owned subtree, drain final child events, write
 * settlement metadata back to the *origin* parent, and only then allow the
 * transition. Anything that fails vetoes with a bounded, secret-free
 * diagnostic and leaves the destination untouched.
 *
 * Resolves `true` to allow the transition and `false` to veto it.
 */
export async function guardSessionTransition(
  deps: PiSessionTransitionGuardDeps,
  surface: string,
  ctx: PiSessionTransitionContextPort | undefined,
): Promise<boolean> {
  const controller = deps.currentController();
  if (controller === undefined) return true;
  const pending = controller.countUnsettledDescendants();
  // Fast path: nothing owned is running or queued, so the transition is
  // allowed immediately - no prompt, no notice, and nothing copied into
  // the destination session.
  if (pending === 0) return true;
  if (ctx === undefined || !ctx.hasUI) {
    // No dialog-capable UI to ask through. Fail closed: silently killing a
    // live subtree is worse than refusing the transition.
    deps.noticeCell.value = SESSION_TRANSITION_NO_UI_NOTICE;
    notifySessionTransition(ctx, SESSION_TRANSITION_NO_UI_NOTICE);
    return false;
  }
  // `Stay` is listed first so it is the pre-selected default; the prompt
  // text carries the description the two short choices deliberately omit.
  const asked = await ResultAsync.fromPromise(
    Promise.resolve(
      ctx.ui.select(
        `Weave: ${pending} delegated ${pending === 1 ? "child is" : "children are"} still active (${surface}). Proceed cancels them; Stay keeps this session.`,
        [SESSION_TRANSITION_STAY, SESSION_TRANSITION_PROCEED],
      ),
    ),
    () => SESSION_TRANSITION_PROMPT_FAILED_NOTICE,
  );
  if (asked.isErr()) {
    // A rejected prompt is never an approval. Fail closed with a bounded,
    // secret-free notice built from a fixed string, never the rejection.
    deps.noticeCell.value = asked.error;
    notifySessionTransition(ctx, asked.error);
    return false;
  }
  // `select` resolves `undefined` on cancel or timeout. Both mean Stay:
  // Stay is the default and never cancels anything.
  if (asked.value !== SESSION_TRANSITION_PROCEED) return false;
  const settled = await ResultAsync.fromPromise(
    Promise.resolve(controller.settleForTransition()),
    () =>
      // A rejected controller call is a failed settlement, never a silent
      // allow. The rejection value itself never reaches the user.
      makeChildAbortFailedFailure("", "transition-settlement-rejected"),
  ).andThen((result) => result);
  return settled.match(
    () => {
      deps.noticeCell.value = undefined;
      return true;
    },
    (failure) => {
      // `safeMessage` and `code` are the closed, secret-free diagnostic
      // surface of every adapter failure.
      const notice = `Weave: ${failure.safeMessage} (${failure.code})`;
      deps.noticeCell.value = notice;
      notifySessionTransition(ctx, notice);
      return false;
    },
  );
}

/**
 * Wraps one Pi transition pre-hook. A rejection anywhere inside the guard
 * vetoes: an unhandled pre-hook rejection must never be read by Pi as
 * permission to transition.
 */
export function createGuardedTransitionHook(
  deps: PiSessionTransitionGuardDeps,
  surface: (event: unknown) => string,
): PiEventHandler {
  return async (
    event: unknown,
    ctx?: PiSessionContext,
  ): Promise<PiSessionTransitionHookResult> => {
    const guarded = await ResultAsync.fromPromise(
      guardSessionTransition(deps, surface(event), ctx),
      () => SESSION_TRANSITION_GUARD_FAILED_NOTICE,
    );
    if (guarded.isErr()) {
      deps.noticeCell.value = guarded.error;
      notifySessionTransition(ctx, guarded.error);
      return { cancel: true };
    }
    return guarded.value ? undefined : { cancel: true };
  };
}

export interface PiSessionTransitionHandlers {
  readonly beforeSwitch: PiEventHandler;
  readonly beforeFork: PiEventHandler;
  readonly beforeTree: PiEventHandler;
}

/** Builds the three real Pi 0.83 pre-transition handlers from one guard. */
export function createSessionTransitionHandlers(
  deps: PiSessionTransitionGuardDeps,
): PiSessionTransitionHandlers {
  return {
    beforeSwitch: createGuardedTransitionHook(deps, labelSessionBeforeSwitch),
    beforeFork: createGuardedTransitionHook(deps, labelSessionBeforeFork),
    beforeTree: createGuardedTransitionHook(deps, labelSessionBeforeTree),
  };
}

/**
 * Registers every Pi 0.83 session-transition surface that exposes an awaited,
 * vetoable pre-event: `/new` and `/resume` (`session_before_switch`), `/fork`
 * and `/clone` (`session_before_fork`, distinguished by `position`), and
 * `/tree` branch navigation (`session_before_tree`). Pi exposes no other
 * awaited pre-transition event, so no surface is left silently unguarded.
 */
export function registerSessionTransitionHandlers(
  pi: PiExtensionApi,
  handlers: PiSessionTransitionHandlers,
): void {
  pi.on("session_before_switch", handlers.beforeSwitch);
  pi.on("session_before_fork", handlers.beforeFork);
  pi.on("session_before_tree", handlers.beforeTree);
}

/** Snapshot captured before generation authority cells are revoked. */
export interface PiSessionShutdownSnapshot {
  readonly shuttingDelegation: PiSessionTransitionControllerPort | undefined;
  readonly shuttingSession:
    | {
        readonly primaryAgentName: string | undefined;
      }
    | undefined;
  readonly shuttingWorkflowController:
    | PiSessionShutdownWorkflowObservePort
    | undefined;
  readonly shuttingWorkflowInstance:
    | {
        readonly workflowInstanceId: string;
        readonly leaseId: string | undefined;
      }
    | undefined;
  readonly shuttingTelemetry: PiSessionShutdownTelemetryPort | undefined;
  readonly shuttingResources: PiSessionShutdownResourcesPort | undefined;
}

/** Workflow observe seam used only for quit/reload termination. */
export interface PiSessionShutdownWorkflowObservePort {
  observe(input: {
    readonly workflowInstanceId: string;
    readonly leaseId: string;
    readonly harnessName: "pi";
    readonly agentName: string;
    readonly sessionStatus: "terminated";
  }): ResultAsync<{ readonly snapshotId: string }, PiAdapterFailure>;
}

/** Telemetry seams the shutdown path may flush. */
export interface PiSessionShutdownTelemetryPort {
  recordJournalEvent(input: {
    readonly family: "generation";
    readonly event: "shutdown";
    readonly severity: "info";
  }): ResultAsync<unknown, unknown>;
  shutdown(): ResultAsync<unknown, unknown>;
}

/** Generation resource owner dispose seam. */
export interface PiSessionShutdownResourcesPort {
  dispose(): ResultAsync<void, never>;
}

/**
 * Side-effect ports the synchronous revoke step needs. The extension supplies
 * these so the runtime never closes over extension-local bindings.
 */
export interface PiGenerationRevokePorts {
  /** Increments the session-start sequence so in-flight startups abort. */
  readonly bumpSessionStartSequence: () => void;
  /** Settles the Alt+T plan overlay if it is mounted. */
  readonly closePlanTaskOverlay: () => void;
  /** Settles and clears the native child overlay for the generation. */
  readonly clearChildOverlayGeneration: () => void;
  /** Shuts down the extension controller (tool/command authority). */
  readonly shutdownExtensionController: () => void;
  /** Clears the last boot-activation failure diagnostic. */
  readonly clearBootActivationFailure: () => void;
  /** Captures then clears the active parent session. */
  readonly takeActiveSession: () =>
    | {
        readonly primaryAgentName: string | undefined;
      }
    | undefined;
  /**
   * Captures then clears the live delegation controller. The caller decides
   * whether to `disposeAll` (replacement startup) or await
   * `shutdownWithinBudget` (quit/reload).
   */
  readonly takeDelegationController: () =>
    | PiSessionTransitionControllerPort
    | undefined;
  /** Clears thread source ports and the required flag. */
  readonly clearThreadSources: () => void;
  /** Captures then clears the workflow controller. */
  readonly takeWorkflowController: () =>
    | PiSessionShutdownWorkflowObservePort
    | undefined;
  /** Captures then clears the active workflow instance cell. */
  readonly takeWorkflowInstance: () =>
    | {
        readonly workflowInstanceId: string;
        readonly leaseId: string | undefined;
      }
    | undefined;
  /** Clears the recovery coordinator cell. */
  readonly clearRecoveryCoordinator: () => void;
  /** Closes and clears the inspection registry for the generation. */
  readonly closeInspectionRegistry: () => void;
  /** Clears the plan-state provider cell. */
  readonly clearPlanStateProvider: () => void;
  /** Clears the current-workflows projection. */
  readonly clearCurrentWorkflows: () => void;
  /** Resets live child-tree selection to the root. */
  readonly resetTreeSelection: () => void;
  /** Captures then clears generation telemetry. */
  readonly takeTelemetry: () => PiSessionShutdownTelemetryPort | undefined;
  /** Captures then clears the generation resource owner. */
  readonly takeResources: () => PiSessionShutdownResourcesPort | undefined;
  /** Cancels an in-flight direct-step child, if any. */
  readonly cancelDirectStep: () => ResultAsync<unknown, unknown>;
}

/**
 * Synchronously revokes generation authority and clears the transition
 * notice. Everything used after the first await of a shutdown/replacement
 * path must come from the returned snapshot so a replacement startup can
 * publish new state while best-effort cleanup continues.
 */
export function revokeGenerationAuthority(
  noticeCell: PiSessionTransitionNoticeCell,
  ports: PiGenerationRevokePorts,
): PiSessionShutdownSnapshot {
  ports.bumpSessionStartSequence();
  ports.closePlanTaskOverlay();
  ports.clearChildOverlayGeneration();
  ports.shutdownExtensionController();
  ports.clearBootActivationFailure();
  const shuttingSession = ports.takeActiveSession();
  const shuttingWorkflowController = ports.takeWorkflowController();
  const shuttingWorkflowInstance = ports.takeWorkflowInstance();
  const shuttingTelemetry = ports.takeTelemetry();
  const shuttingResources = ports.takeResources();
  ports.closeInspectionRegistry();
  ports.clearRecoveryCoordinator();
  const shuttingDelegation = ports.takeDelegationController();
  ports.clearThreadSources();
  noticeCell.value = undefined;
  ports.clearPlanStateProvider();
  ports.clearCurrentWorkflows();
  ports.resetTreeSelection();
  const cancelDirectStep = ports.cancelDirectStep();
  void cancelDirectStep.match(
    () => undefined,
    () => undefined,
  );
  return {
    shuttingDelegation,
    shuttingSession,
    shuttingWorkflowController,
    shuttingWorkflowInstance,
    shuttingTelemetry,
    shuttingResources,
  };
}

/** UI/status clearing and editor restore for quit/reload shutdown. */
export interface PiSessionShutdownUiPorts {
  readonly clearStatusSurfaces: (ctx: PiSessionContext | undefined) => void;
  readonly restoreEditor: () => void;
  readonly disposeChildMode: () => void;
  readonly warnObserveFailure: (failure: PiAdapterFailure) => void;
}

/**
 * Async half of quit/reload shutdown: bounded graceful-cancel then
 * force-stop of the owned subtree, workflow termination observe, and
 * telemetry/resource dispose. The report is a value; expected stop failures
 * are never thrown.
 */
export function finalizeBoundedShutdown(
  snapshot: PiSessionShutdownSnapshot,
  ui: PiSessionShutdownUiPorts,
): ResultAsync<void, never> {
  return ResultAsync.fromSafePromise(
    (async (): Promise<void> => {
      const shuttingDelegation = snapshot.shuttingDelegation;
      if (shuttingDelegation !== undefined) {
        await shuttingDelegation.shutdownWithinBudget().match(
          () => undefined,
          () => undefined,
        );
      }

      if (
        snapshot.shuttingWorkflowInstance?.leaseId !== undefined &&
        snapshot.shuttingWorkflowController !== undefined
      ) {
        const observed = await snapshot.shuttingWorkflowController.observe({
          workflowInstanceId:
            snapshot.shuttingWorkflowInstance.workflowInstanceId,
          leaseId: snapshot.shuttingWorkflowInstance.leaseId,
          harnessName: "pi",
          agentName:
            snapshot.shuttingSession?.primaryAgentName ?? "workflow-controller",
          sessionStatus: "terminated",
        });
        if (observed.isErr()) {
          ui.warnObserveFailure(observed.error);
        }
      }

      if (snapshot.shuttingTelemetry !== undefined) {
        await snapshot.shuttingTelemetry
          .recordJournalEvent({
            family: "generation",
            event: "shutdown",
            severity: "info",
          })
          .orElse(() => okAsync(undefined));
      }
      if (snapshot.shuttingResources !== undefined) {
        await snapshot.shuttingResources.dispose();
      } else if (snapshot.shuttingTelemetry !== undefined) {
        await snapshot.shuttingTelemetry
          .shutdown()
          .orElse(() => okAsync(undefined));
      }
    })(),
  ).map(() => undefined);
}

/**
 * Full quit/reload shutdown: synchronous revoke, UI clear, then bounded
 * async stop. Extension callers supply ports; this helper owns the order.
 */
export function runBoundedSessionShutdown(
  noticeCell: PiSessionTransitionNoticeCell,
  ctx: PiSessionContext | undefined,
  revokePorts: PiGenerationRevokePorts,
  uiPorts: PiSessionShutdownUiPorts,
): ResultAsync<void, never> {
  const snapshot = revokeGenerationAuthority(noticeCell, revokePorts);
  uiPorts.clearStatusSurfaces(ctx);
  uiPorts.restoreEditor();
  uiPorts.disposeChildMode();
  return finalizeBoundedShutdown(snapshot, uiPorts);
}

/**
 * Replacement-startup revoke. Order matches `session_start`: settle overlays,
 * bump the startup sequence, shut down extension authority, dispose the
 * prior delegation tree immediately, clear generation cells, then
 * fire-and-forget prior resource/telemetry dispose. Distinct from quit/reload
 * {@link revokeGenerationAuthority}, which bumps first and holds the
 * delegation controller for a bounded stop.
 */
export function revokeGenerationForReplacement(
  noticeCell: PiSessionTransitionNoticeCell,
  ports: PiGenerationRevokePorts,
  disposeDelegation: (controller: PiSessionTransitionControllerPort) => void,
): void {
  ports.closePlanTaskOverlay();
  ports.clearChildOverlayGeneration();
  ports.bumpSessionStartSequence();
  ports.shutdownExtensionController();
  ports.clearBootActivationFailure();
  ports.takeActiveSession();
  const shuttingDelegation = ports.takeDelegationController();
  if (shuttingDelegation !== undefined) {
    disposeDelegation(shuttingDelegation);
  }
  ports.clearThreadSources();
  noticeCell.value = undefined;
  ports.takeWorkflowController();
  ports.clearRecoveryCoordinator();
  ports.closeInspectionRegistry();
  ports.clearPlanStateProvider();
  ports.takeWorkflowInstance();
  ports.clearCurrentWorkflows();
  ports.resetTreeSelection();
  const priorResources = ports.takeResources();
  const priorTelemetry = ports.takeTelemetry();
  if (priorResources !== undefined) {
    void priorResources.dispose();
  } else if (priorTelemetry !== undefined) {
    void priorTelemetry.shutdown().match(
      () => undefined,
      () => undefined,
    );
  }
  const cancelDirectStep = ports.cancelDirectStep();
  void cancelDirectStep.match(
    () => undefined,
    () => undefined,
  );
}

/**
 * Generation-scoped cells the shutdown path clears. Kept beside the host
 * hooks so the extension never re-implements revoke ordering.
 */
export interface PiSessionTransitionShutdownCells {
  readonly noticeCell: PiSessionTransitionNoticeCell;
  readonly delegationControllerCell: PiDelegationControllerCell;
  readonly threadSourcesCell: PiThreadSourcesCell;
  readonly treeSelectionCell: PiChildTreeSelectionCell;
  readonly inspectionRegistryCell: PiChildInspectionRegistryCell;
  readonly childOverlayCell: PiChildOverlayCell;
  readonly overlayKeysCell: PiChildOverlayKeysCell;
  readonly workflowControllerCell: {
    controller: PiSessionShutdownWorkflowObservePort | undefined;
  };
  readonly activeWorkflowInstanceCell: {
    value:
      | {
          readonly workflowInstanceId: string;
          readonly leaseId?: string;
        }
      | undefined;
  };
  readonly recoveryCoordinatorCell: { coordinator: unknown };
  readonly planStateProviderCell: { value: unknown };
  readonly telemetryCell: {
    telemetry: PiSessionShutdownTelemetryPort | undefined;
  };
  readonly generationResourcesCell: {
    owner: PiSessionShutdownResourcesPort | undefined;
  };
}

/** Status/widget keys the quit/reload path clears on the parent UI. */
export const SESSION_SHUTDOWN_WEAVE_STATUS_KEY = "weave";
export const SESSION_SHUTDOWN_AGENT_STATUS_KEY = "weave-agent";
export const SESSION_SHUTDOWN_PLAN_WIDGET_KEY = "weave-plan";

/** Host hooks the runtime cannot reach through cells alone. */
export interface PiSessionTransitionShutdownHostHooks {
  readonly bumpSessionStartSequence: () => void;
  readonly closePlanTaskOverlay: () => void;
  readonly shutdownExtensionController: () => void;
  readonly clearBootActivationFailure: () => void;
  readonly takeActiveSession: () =>
    | {
        readonly primaryAgentName: string | undefined;
      }
    | undefined;
  readonly setThreadSourcesRequired: (required: boolean) => void;
  readonly clearCurrentWorkflows: () => void;
  readonly cancelDirectStep: () => ResultAsync<unknown, unknown>;
  /** Clears plan widget/footer surfaces that the extension owns. */
  readonly clearActivePlanSurfaces: (ctx: PiSessionContext | undefined) => void;
  readonly restoreEditor: () => void;
  readonly disposeChildMode: () => void;
  readonly warnObserveFailure: (failure: PiAdapterFailure) => void;
}

export type PiSessionTransitionRuntimeDeps = PiSessionTransitionShutdownCells &
  PiSessionTransitionShutdownHostHooks;

/** Builds revoke ports from the runtime's bound cells and host hooks. */
export function buildGenerationRevokePorts(
  deps: PiSessionTransitionRuntimeDeps,
): PiGenerationRevokePorts {
  return {
    bumpSessionStartSequence: deps.bumpSessionStartSequence,
    closePlanTaskOverlay: deps.closePlanTaskOverlay,
    clearChildOverlayGeneration: () =>
      clearChildOverlayGeneration(deps.childOverlayCell, deps.overlayKeysCell),
    shutdownExtensionController: deps.shutdownExtensionController,
    clearBootActivationFailure: deps.clearBootActivationFailure,
    takeActiveSession: deps.takeActiveSession,
    takeDelegationController: () => {
      // Captured before the cell is revoked: the bounded graceful-cancel and
      // force-stop below runs on this snapshot, so a replacement startup can
      // publish a new controller while the old tree is still being stopped.
      const shutting = deps.delegationControllerCell.controller;
      deps.delegationControllerCell.controller = undefined;
      deps.delegationControllerCell.generationId = undefined;
      return shutting;
    },
    clearThreadSources: () => {
      clearThreadSources(deps.threadSourcesCell);
      deps.setThreadSourcesRequired(false);
    },
    takeWorkflowController: () => {
      const shutting = deps.workflowControllerCell.controller;
      deps.workflowControllerCell.controller = undefined;
      return shutting;
    },
    takeWorkflowInstance: () => {
      const shutting = deps.activeWorkflowInstanceCell.value;
      deps.activeWorkflowInstanceCell.value = undefined;
      if (shutting === undefined) return undefined;
      return {
        workflowInstanceId: shutting.workflowInstanceId,
        leaseId: shutting.leaseId,
      };
    },
    clearRecoveryCoordinator: () => {
      deps.recoveryCoordinatorCell.coordinator = undefined;
    },
    closeInspectionRegistry: () => {
      deps.inspectionRegistryCell.registry?.closeGeneration();
      deps.inspectionRegistryCell.registry = undefined;
    },
    clearPlanStateProvider: () => {
      deps.planStateProviderCell.value = undefined;
    },
    clearCurrentWorkflows: deps.clearCurrentWorkflows,
    resetTreeSelection: () => {
      deps.treeSelectionCell.selectedId = ROOT_NODE_ID;
    },
    takeTelemetry: () => {
      const shutting = deps.telemetryCell.telemetry;
      deps.telemetryCell.telemetry = undefined;
      return shutting;
    },
    takeResources: () => {
      const shutting = deps.generationResourcesCell.owner;
      deps.generationResourcesCell.owner = undefined;
      return shutting;
    },
    cancelDirectStep: deps.cancelDirectStep,
  };
}

export interface PiSessionTransitionRuntime {
  readonly noticeCell: PiSessionTransitionNoticeCell;
  readonly handlers: PiSessionTransitionHandlers;
  /** Registers the three pre-transition handlers on the host API. */
  readonly register: (pi: PiExtensionApi) => void;
  /** Clears the generation-scoped transition notice. */
  readonly clearNotice: () => void;
  /**
   * Synchronously revokes generation authority for quit/reload; see
   * {@link revokeGenerationAuthority}.
   */
  readonly revokeGeneration: () => PiSessionShutdownSnapshot;
  /**
   * Replacement-startup revoke with immediate delegation dispose; see
   * {@link revokeGenerationForReplacement}.
   */
  readonly revokeForReplacement: (
    disposeDelegation: (controller: PiSessionTransitionControllerPort) => void,
  ) => void;
  /**
   * Quit/reload shutdown orchestration: revoke, clear UI, bounded stop.
   * Extension callers only pass the live session context.
   */
  readonly runBoundedShutdown: (
    ctx: PiSessionContext | undefined,
  ) => ResultAsync<void, never>;
}

export function createSessionTransitionRuntime(
  deps: PiSessionTransitionRuntimeDeps,
): PiSessionTransitionRuntime {
  const guardDeps: PiSessionTransitionGuardDeps = {
    noticeCell: deps.noticeCell,
    currentController: () => deps.delegationControllerCell.controller,
  };
  const handlers = createSessionTransitionHandlers(guardDeps);
  const uiPorts: PiSessionShutdownUiPorts = {
    clearStatusSurfaces: (ctx) => {
      ctx?.ui.setStatus(SESSION_SHUTDOWN_WEAVE_STATUS_KEY, undefined);
      ctx?.ui.setStatus(SESSION_SHUTDOWN_AGENT_STATUS_KEY, undefined);
      deps.clearActivePlanSurfaces(ctx);
      ctx?.ui.setWidget(SESSION_SHUTDOWN_PLAN_WIDGET_KEY, undefined);
    },
    restoreEditor: deps.restoreEditor,
    disposeChildMode: deps.disposeChildMode,
    warnObserveFailure: deps.warnObserveFailure,
  };
  return {
    noticeCell: deps.noticeCell,
    handlers,
    register: (pi) => registerSessionTransitionHandlers(pi, handlers),
    clearNotice: () => {
      deps.noticeCell.value = undefined;
    },
    revokeGeneration: () =>
      revokeGenerationAuthority(
        deps.noticeCell,
        buildGenerationRevokePorts(deps),
      ),
    revokeForReplacement: (disposeDelegation) =>
      revokeGenerationForReplacement(
        deps.noticeCell,
        buildGenerationRevokePorts(deps),
        disposeDelegation,
      ),
    runBoundedShutdown: (ctx) =>
      runBoundedSessionShutdown(
        deps.noticeCell,
        ctx,
        buildGenerationRevokePorts(deps),
        uiPorts,
      ),
  };
}
