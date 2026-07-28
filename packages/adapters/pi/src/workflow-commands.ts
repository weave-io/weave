/**
 * Native `/weave:*` command handlers and palette actions (Pi adapter contract).
 * Pure builder functions: given a {@link PiWorkflowController} and the
 * active session's UI port, they return real handlers - never the inert
 * `"not yet implemented"` shells. Only this module's run/resume handlers
 * are allowed to mint an {@link AuthorizedByUser} token, and only from a
 * real `ctx.ui.confirm(...)`/`ctx.ui.select(...)` result - never from
 * prompt text, delegation, tools, idle/session events, or continuation
 * banners.
 */
import type {
  PlanTaskNode,
  PlanTaskSnapshot,
  WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import { okAsync, ResultAsync } from "neverthrow";
import type { PiAdapterFailure } from "./errors.js";
import {
  authorizeByExplicitUser,
  type PiReconciliationReason,
  type PiRunResult,
  type PiWorkflowController,
} from "./workflow-controller.js";

export interface PiWorkflowCommandUiPort {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  select(
    title: string,
    options: readonly string[],
  ): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

/** Adapter-supplied lookup for the currently-tracked workflow instance/lease and available plans/workflows - Pi adapter contract keeps "multiple active workflows" out of scope, so there is at most one tracked instance per generation. */
export interface PiActiveWorkflowTracker {
  getActiveInstance():
    | {
        workflowInstanceId: string;
        leaseId?: string;
        /**
         * Set only when this instance was reconstructed from a durable
         * recovery pointer (Issue #21 S020), never for an
         * ordinarily tracked in-session instance. Carries the exact
         * pre-reload owner (controller generation) the pointer's lease
         * was acquired under, so `handleWeaveResume` can build an explicit
         * takeover correlation for `resumeExecution`.
         */
        controllerGeneration?: string;
      }
    | undefined;
  setActiveInstance(
    instance:
      | {
          workflowInstanceId: string;
          leaseId?: string;
          controllerGeneration?: string;
        }
      | undefined,
  ): void;
  /**
   * Lists safe plan basenames under `.weave/plans` (Pi adapter contract) - backs
   * both `/weave:start`'s selection prompt and `/weave:plan`'s picker.
   * Async because production wiring proves no-follow containment through a
   * real file descriptor chain, not a synchronous cache.
   */
  listPlanNames(): ResultAsync<readonly string[], PiAdapterFailure>;
  listWorkflowNames(): readonly string[];
  buildContext(workflowName: string): WorkflowExecutionContext | undefined;
  /** The producing agent's own name, when known, for self-approval prevention on the caller side (engine also enforces this). */
  currentAgentName(): string | undefined;
}

export type PiForegroundPlanStartFailure =
  | {
      readonly type: "PrimarySwitchFailed";
      readonly safeMessage: string;
    }
  | {
      readonly type: "MessageDispatchFailed";
      readonly safeMessage: string;
    }
  | {
      readonly type: "SessionUnavailable";
      readonly safeMessage: string;
    };

/** Adapter-owned foreground start seam for the parent Pi session. */
export interface PiForegroundPlanStartPort {
  start(planName: string): ResultAsync<void, PiForegroundPlanStartFailure>;
}

type PiWorkflowCommandUiFailure = {
  readonly type: "UiInteractionFailed";
  readonly safeMessage: string;
};

function describeRunResult(result: PiRunResult): string {
  return `Workflow ${result.workflowInstanceId} is now ${result.finalStatus}${
    result.currentStepName !== undefined
      ? ` at step ${result.currentStepName}`
      : ""
  }.`;
}

/** `/weave:start [plan]` - select or name an existing plan, switch the parent session to Tapestry, and submit its foreground kickoff turn. */
export async function handleWeaveStart(
  rawArgs: string,
  ui: PiWorkflowCommandUiPort,
  foregroundStarter: PiForegroundPlanStartPort,
  tracker: PiActiveWorkflowTracker,
): Promise<void> {
  const listed = await tracker.listPlanNames();
  if (listed.isErr()) {
    ui.notify(`Could not list plans: ${listed.error.safeMessage}`, "error");
    return;
  }

  const requested = rawArgs.trim();
  let planName: string | undefined =
    requested.length > 0 ? requested : undefined;
  if (planName === undefined) {
    const selected = await selectListedPlanName(ui, listed.value);
    if (selected.isErr()) {
      ui.notify(selected.error.safeMessage, "error");
      return;
    }
    planName = selected.value;
  }
  if (planName === undefined || planName.length === 0) {
    ui.notify("No plan selected; nothing started.", "info");
    return;
  }
  if (!listed.value.includes(planName)) {
    ui.notify("The requested plan was not found.", "error");
    return;
  }

  const confirmStart = ResultAsync.fromThrowable(
    () =>
      ui.confirm(
        "Start plan",
        `Start plan "${planName}" with Tapestry in this session?`,
      ),
    (): PiWorkflowCommandUiFailure => ({
      type: "UiInteractionFailed",
      safeMessage: "Pi could not confirm the plan start request.",
    }),
  );
  const confirmed = await confirmStart();
  if (confirmed.isErr()) {
    ui.notify(confirmed.error.safeMessage, "error");
    return;
  }
  if (!confirmed.value) {
    ui.notify(
      "Start cancelled; plan execution requires explicit confirmation.",
      "info",
    );
    return;
  }

  const result = await foregroundStarter.start(planName);
  result.match(
    () => {},
    (failure) =>
      ui.notify(`Could not start plan: ${failure.safeMessage}`, "error"),
  );
}

/** `/weave:run [workflow]` - select or name a configured workflow, then explicitly start it (distinct from the plan-first `/weave:start` path). */
export async function handleWeaveRun(
  rawArgs: string,
  ui: PiWorkflowCommandUiPort,
  controller: PiWorkflowController,
  tracker: PiActiveWorkflowTracker,
): Promise<void> {
  const workflowNames = tracker.listWorkflowNames();
  const requested = rawArgs.trim();
  const workflowName =
    requested.length > 0
      ? requested
      : await ui.select("Select a workflow to run", workflowNames);
  if (workflowName === undefined || workflowName.length === 0) {
    ui.notify("No workflow selected; nothing started.", "info");
    return;
  }
  const confirmed = await ui.confirm(
    "Run workflow",
    `Run workflow "${workflowName}" now? This begins durable execution.`,
  );
  const authorization = authorizeByExplicitUser(confirmed);
  if (authorization.isErr()) {
    ui.notify(
      "Run cancelled; workflow execution requires explicit confirmation.",
      "info",
    );
    return;
  }
  const context = tracker.buildContext(workflowName);
  if (context === undefined) {
    ui.notify(`Workflow "${workflowName}" is not configured.`, "error");
    return;
  }
  const instanceId = `${workflowName}-${Date.now()}`;
  const result = await controller.startExecution(
    { workflowInstanceId: instanceId, context },
    authorization.value,
  );
  result.match(
    (started) => {
      tracker.setActiveInstance({
        workflowInstanceId: started.workflowInstanceId,
        leaseId: started.leaseId,
      });
      ui.notify(describeRunResult(started), "info");
    },
    (failure) =>
      ui.notify(`Could not run workflow: ${failure.safeMessage}`, "error"),
  );
}

/** `/weave:status` - read-only execution and child status. */
export async function handleWeaveStatus(
  ui: PiWorkflowCommandUiPort,
  controller: PiWorkflowController,
  tracker: PiActiveWorkflowTracker,
): Promise<void> {
  const active = tracker.getActiveInstance();
  if (active === undefined) {
    ui.notify("No tracked Weave execution for this session.", "info");
    return;
  }
  const result = await controller.inspect(active.workflowInstanceId);
  result.match(
    (snapshot) =>
      ui.notify(
        `${snapshot.workflowName} (${snapshot.workflowInstanceId}): ${snapshot.status}${
          snapshot.currentStepName !== undefined
            ? ` at ${snapshot.currentStepName}`
            : ""
        }`,
        "info",
      ),
    (failure) =>
      ui.notify(`Could not read status: ${failure.safeMessage}`, "error"),
  );
}

/** `/weave:abort` - confirm, then cancel the whole execution (and, separately, the full owned child tree via the extension's delegation-tree cancellation). */
export async function handleWeaveAbort(
  ui: PiWorkflowCommandUiPort,
  controller: PiWorkflowController,
  tracker: PiActiveWorkflowTracker,
): Promise<void> {
  const active = tracker.getActiveInstance();
  if (active === undefined || active.leaseId === undefined) {
    ui.notify("No active Weave execution to abort.", "info");
    return;
  }
  const confirmed = await ui.confirm(
    "Abort execution",
    "Cancel the active Weave execution now?",
  );
  if (!confirmed) {
    ui.notify("Abort cancelled.", "info");
    return;
  }
  const result = await controller.handleUserInterrupt({
    workflowInstanceId: active.workflowInstanceId,
    leaseId: active.leaseId,
    signal: "cancel",
  });
  result.match(
    () => {
      tracker.setActiveInstance(undefined);
      ui.notify("Execution cancelled.", "info");
    },
    (failure) => ui.notify(`Could not abort: ${failure.safeMessage}`, "error"),
  );
}

/** `/weave:advance` - apply explicit user confirmation only when the current step allows it (routed through `handleUserInterrupt`'s pause path is NOT used here; advance is a completion/confirmation act, delivered by re-running the dispatch loop after an interactive step's user_confirm gate - this command simply re-inspects and reports, since the actual advance happens through the dispatch loop's own completion call once the interactive step's own confirmation UI is satisfied). */
export async function handleWeaveAdvance(
  ui: PiWorkflowCommandUiPort,
  controller: PiWorkflowController,
  tracker: PiActiveWorkflowTracker,
): Promise<void> {
  const active = tracker.getActiveInstance();
  if (active === undefined || active.leaseId === undefined) {
    ui.notify("No active Weave execution to advance.", "info");
    return;
  }
  const confirmed = await ui.confirm(
    "Advance step",
    "Confirm the current interactive step is complete?",
  );
  // Explicit user confirmation only - never inferred from prompt text,
  // delegation, tools, idle/session events, or continuation/recovery
  // banners (Pi adapter contract). `confirmStep` itself fails closed with a
  // typed error when no step is actually awaiting this confirmation, so
  // this command never silently no-ops on a step that doesn't allow it.
  const authorization = authorizeByExplicitUser(confirmed);
  if (authorization.isErr()) {
    ui.notify("Advance cancelled.", "info");
    return;
  }
  const result = await controller.confirmStep(
    { workflowInstanceId: active.workflowInstanceId, leaseId: active.leaseId },
    authorization.value,
  );
  result.match(
    (runResult) => ui.notify(describeRunResult(runResult), "info"),
    (failure) =>
      ui.notify(`Could not advance: ${failure.safeMessage}`, "error"),
  );
}

/** `/weave:resume` - explicitly recover a paused/recoverable execution. */
export async function handleWeaveResume(
  ui: PiWorkflowCommandUiPort,
  controller: PiWorkflowController,
  tracker: PiActiveWorkflowTracker,
): Promise<void> {
  const active = tracker.getActiveInstance();
  if (active === undefined) {
    ui.notify(
      "No recoverable Weave execution tracked for this session.",
      "info",
    );
    return;
  }
  const confirmed = await ui.confirm(
    "Resume execution",
    "Resume the paused/recoverable Weave execution now?",
  );
  const authorization = authorizeByExplicitUser(confirmed);
  if (authorization.isErr()) {
    ui.notify(
      "Resume cancelled; resuming requires explicit confirmation.",
      "info",
    );
    return;
  }
  const inspected = await controller.inspect(active.workflowInstanceId);
  if (inspected.isErr()) {
    ui.notify(`Could not resume: ${inspected.error.safeMessage}`, "error");
    return;
  }
  const context = tracker.buildContext(inspected.value.workflowName);
  if (context === undefined) {
    ui.notify(
      `Workflow "${inspected.value.workflowName}" is not configured.`,
      "error",
    );
    return;
  }
  const result = await controller.resumeExecution(
    {
      workflowInstanceId: active.workflowInstanceId,
      context,
      // Issue #21 S020: only present when this instance was
      // reconstructed from a durable recovery pointer, and only reaches
      // the engine now that the user has freshly confirmed above.
      ...(active.leaseId !== undefined &&
      active.controllerGeneration !== undefined
        ? {
            recoveryTakeover: {
              expectedLeaseId: active.leaseId,
              expectedControllerGeneration: active.controllerGeneration,
            },
          }
        : {}),
    },
    authorization.value,
  );
  result.match(
    (resumed) => {
      tracker.setActiveInstance({
        workflowInstanceId: resumed.workflowInstanceId,
        leaseId: resumed.leaseId,
      });
      ui.notify(describeRunResult(resumed), "info");
    },
    (failure) => ui.notify(`Could not resume: ${failure.safeMessage}`, "error"),
  );
}

function selectListedPlanName(
  ui: PiWorkflowCommandUiPort,
  planNames: readonly string[],
  title = "Select a plan to start",
): ResultAsync<string | undefined, PiWorkflowCommandUiFailure> {
  if (planNames.length === 0) {
    ui.notify("No plans found for this project.", "info");
    return okAsync(undefined);
  }
  const selectPlan = ResultAsync.fromThrowable(
    () => ui.select(title, planNames),
    (): PiWorkflowCommandUiFailure => ({
      type: "UiInteractionFailed",
      safeMessage: "Pi could not open the plan selector.",
    }),
  );
  return selectPlan();
}

/**
 * Resolves the plan name a caller with no explicit `rawArgs` should list/
 * start: lists the catalog and prompts, notifying and returning `undefined`
 * on an empty catalog or a listing failure. Read-only - never mutates.
 */
async function selectPlanName(
  ui: PiWorkflowCommandUiPort,
  tracker: PiActiveWorkflowTracker,
  title = "Select a plan to start",
): Promise<string | undefined> {
  const listed = await tracker.listPlanNames();
  if (listed.isErr()) {
    ui.notify(`Could not list plans: ${listed.error.safeMessage}`, "error");
    return undefined;
  }
  const selected = await selectListedPlanName(ui, listed.value, title);
  if (selected.isErr()) {
    ui.notify(selected.error.safeMessage, "error");
    return undefined;
  }
  return selected.value;
}

function planTaskMarker(node: PlanTaskNode): string {
  if (node.state === "completed") return "[x]";
  if (node.state === "in_progress") return "[~]";
  return "[ ]";
}

function renderPlanTaskNode(node: PlanTaskNode, indent: string): string {
  const lines = [
    `${indent}- ${planTaskMarker(node)} ${node.id}. ${node.title}`,
  ];
  for (const child of node.children) {
    lines.push(renderPlanTaskNode(child, `${indent}  `));
  }
  return lines.join("\n");
}

/** Renders the full bounded nested task tree (parents plus, at most, one level of children) - never just the plan's name. */
function renderPlanTree(snapshot: PlanTaskSnapshot): string {
  const header = `Plan "${snapshot.planName}" (${
    snapshot.complete ? "complete" : "in progress"
  }, ${snapshot.totalParentCount} task${
    snapshot.totalParentCount === 1 ? "" : "s"
  }):`;
  if (snapshot.parents.length === 0) return `${header}\n(no tasks)`;
  const body = snapshot.parents
    .map((parent) => renderPlanTaskNode(parent, ""))
    .join("\n");
  return `${header}\n${body}`;
}

/**
 * `/weave:plan [plan]` - full read-only nested task tree for the named
 * plan, the currently-tracked plan (when no name is given and an instance
 * is active), or a selected plan from the catalog. Never mutates anything;
 * always reads through {@link PiWorkflowController.readPlanSnapshot}, never
 * a raw file read of its own.
 */
export async function handleWeavePlan(
  rawArgs: string,
  ui: PiWorkflowCommandUiPort,
  controller: PiWorkflowController,
  tracker: PiActiveWorkflowTracker,
): Promise<void> {
  const requested = rawArgs.trim();
  const active = tracker.getActiveInstance();
  const planName =
    requested.length > 0
      ? requested
      : (active?.workflowInstanceId ??
        (await selectPlanName(ui, tracker, "Select a plan to view")));
  if (planName === undefined || planName.length === 0) return;
  const snapshot = await controller.readPlanSnapshot(planName);
  snapshot.match(
    (value) => ui.notify(renderPlanTree(value), "info"),
    (failure) =>
      ui.notify(`Could not read plan: ${failure.safeMessage}`, "error"),
  );
}

/** `/weave:artifact [approve|reject] [artifact]` - decide a pending artifact revision as the explicit user. */
export async function handleWeaveArtifact(
  rawArgs: string,
  ui: PiWorkflowCommandUiPort,
  controller: PiWorkflowController,
  tracker: PiActiveWorkflowTracker,
): Promise<void> {
  const active = tracker.getActiveInstance();
  if (active === undefined || active.leaseId === undefined) {
    ui.notify("No active Weave execution with pending artifacts.", "info");
    return;
  }
  const [decisionRaw, artifactId] = rawArgs.trim().split(/\s+/, 2);
  const decision =
    decisionRaw === "approve" || decisionRaw === "reject"
      ? decisionRaw
      : undefined;
  if (
    decision === undefined ||
    artifactId === undefined ||
    artifactId.length === 0
  ) {
    ui.notify("Usage: /weave:artifact approve|reject <artifactId>", "info");
    return;
  }
  const confirmed = await ui.confirm(
    "Artifact decision",
    `${decision === "approve" ? "Approve" : "Reject"} artifact ${artifactId}?`,
  );
  if (!confirmed) {
    ui.notify("Artifact decision cancelled.", "info");
    return;
  }
  const inspected = await controller.inspect(active.workflowInstanceId);
  if (inspected.isErr()) {
    ui.notify(
      `Could not decide artifact: ${inspected.error.safeMessage}`,
      "error",
    );
    return;
  }
  const artifact = inspected.value.artifacts.find(
    (candidate) => candidate.id === artifactId,
  );
  if (artifact === undefined) {
    ui.notify(
      `Artifact ${artifactId} was not found on this execution.`,
      "error",
    );
    return;
  }
  const result = await controller.approveArtifact({
    workflowInstanceId: active.workflowInstanceId,
    leaseId: active.leaseId,
    artifactId,
    approvalState: decision === "approve" ? "approved" : "rejected",
    actor: { kind: "user", provenance: { source: "weave:artifact" } },
    expectedRevision: artifact.revision,
    relativePathForDigest: artifact.path,
  });
  if (result.isErr()) {
    ui.notify(
      `Could not decide artifact: ${result.error.safeMessage}`,
      "error",
    );
    return;
  }
  ui.notify(
    `Artifact ${artifactId} ${decision === "approve" ? "approved" : "rejected"}.`,
    "info",
  );
  // A user-driven rejection is an explicit revision request under the Pi adapter contract.
  // Reconcile it under the fixed `user-revision-request` reason so
  // any step's declared `reconciliation_handlers` entry can redirect
  // execution, mirroring the review/security gate pattern.
  if (decision !== "reject") return;
  const reconciled = await controller.reconcile({
    workflowInstanceId: active.workflowInstanceId,
    leaseId: active.leaseId,
    reason: "user-revision-request",
    authorizationSource: "user",
  });
  reconciled.match(
    () => {},
    (failure) =>
      ui.notify(`Reconciliation failed: ${failure.safeMessage}`, "error"),
  );
}

/** Explicit-reconciliation entry used by the extension when the dispatch loop reports an execution-mismatch/rejection - never invoked automatically from prose. */
export async function handleReconciliation(
  ui: PiWorkflowCommandUiPort,
  controller: PiWorkflowController,
  tracker: PiActiveWorkflowTracker,
  reason: PiReconciliationReason,
  authorizationSource: "user" | "runtime" | "review-gate" | "security-gate",
): Promise<void> {
  const active = tracker.getActiveInstance();
  if (active === undefined || active.leaseId === undefined) return;
  const result = await controller.reconcile({
    workflowInstanceId: active.workflowInstanceId,
    leaseId: active.leaseId,
    reason,
    authorizationSource,
  });
  result.match(
    () => ui.notify(`Reconciliation applied for ${reason}.`, "info"),
    (failure) =>
      ui.notify(`Reconciliation failed: ${failure.safeMessage}`, "error"),
  );
}

export type PiPaletteActionId =
  | "weave.start"
  | "weave.run"
  | "weave.status"
  | "weave.abort"
  | "weave.advance"
  | "weave.health"
  | "weave.resume"
  | "weave.plan"
  | "weave.artifact";

export interface PiPaletteAction {
  readonly id: PiPaletteActionId;
  readonly label: string;
  readonly visible: boolean;
  readonly disabledReason?: string;
}

/** Palette exposes the same nine actions as the commands, hidden/disabled with a reason when invalid (Pi adapter contract). */
export function buildPaletteActions(input: {
  readonly healthOnly: boolean;
  readonly hasActiveInstance: boolean;
  readonly hasPendingArtifact: boolean;
}): readonly PiPaletteAction[] {
  const disabledReason = input.healthOnly
    ? "Weave is in health-only mode; run /weave:health."
    : undefined;
  return [
    {
      id: "weave.start",
      label: "Weave: Start Plan",
      visible: !input.hasActiveInstance,
      disabledReason,
    },
    {
      id: "weave.run",
      label: "Weave: Run Workflow",
      visible: !input.hasActiveInstance,
      disabledReason,
    },
    { id: "weave.status", label: "Weave: Status", visible: true },
    {
      id: "weave.abort",
      label: "Weave: Abort",
      visible: input.hasActiveInstance,
      disabledReason,
    },
    {
      id: "weave.advance",
      label: "Weave: Advance Step",
      visible: input.hasActiveInstance,
      disabledReason,
    },
    { id: "weave.health", label: "Weave: Health", visible: true },
    {
      id: "weave.resume",
      label: "Weave: Resume",
      visible: input.hasActiveInstance,
      disabledReason,
    },
    { id: "weave.plan", label: "Weave: Show Plan", visible: true },
    {
      id: "weave.artifact",
      label: "Weave: Decide Artifact",
      visible: input.hasPendingArtifact,
      disabledReason,
    },
  ];
}
