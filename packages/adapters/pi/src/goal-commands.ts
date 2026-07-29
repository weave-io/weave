import {
  countIncompleteLeaves,
  formatDuration,
  formatTokenCount,
  type PlanTaskSnapshot,
  type SessionGoalController,
  selectActivePlanTask,
} from "@weaveio/weave-engine";
import type { PiAdapterFailure } from "./errors.js";
import { parseWeaveGoalArgs, type WeaveGoalArgs } from "./goal-args.js";
import { resolveGoalPlan } from "./goal-plan-resolver.js";
import { WEAVE_GOAL_STATE_ENTRY_TYPE } from "./goal-session.js";
import { syncWeaveGoalReportToolAvailability } from "./goal-tool.js";
import type { PiPlanCatalogPort } from "./plan-catalog.js";
import type { PiWorkflowCommandUiPort } from "./workflow-commands.js";

export interface WeaveGoalFooterPort {
  refreshFromPlan(): void | Promise<void>;
  clear(): void | Promise<void>;
}

export interface WeaveGoalCommandPiPort {
  appendEntry(type: string, data: unknown): void;
  getActiveTools(): readonly string[];
  setActiveTools(names: readonly string[]): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    },
    options: { triggerTurn: boolean; deliverAs: "steer" | "followUp" },
  ): void | Promise<void>;
}

export interface WeaveGoalCommandDependencies {
  readonly pi: WeaveGoalCommandPiPort;
  readonly controller: Pick<
    SessionGoalController,
    | "current"
    | "elapsedMs"
    | "isPursuing"
    | "start"
    | "pause"
    | "resume"
    | "clear"
    | "serialize"
  >;
  readonly catalog: PiPlanCatalogPort;
  readonly projectRoot: string;
  readonly readSnapshot: (
    planName: string,
  ) => import("neverthrow").ResultAsync<PlanTaskSnapshot, PiAdapterFailure>;
  readonly footer: WeaveGoalFooterPort;
}

function persist(deps: WeaveGoalCommandDependencies, value: unknown): void {
  deps.pi.appendEntry(WEAVE_GOAL_STATE_ENTRY_TYPE, value);
}

function persistController(deps: WeaveGoalCommandDependencies): void {
  persist(deps, deps.controller.serialize());
  syncWeaveGoalReportToolAvailability(deps.pi, deps.controller);
}

async function footerRefresh(
  deps: WeaveGoalCommandDependencies,
  ui: PiWorkflowCommandUiPort,
): Promise<void> {
  try {
    await deps.footer.refreshFromPlan();
  } catch {
    ui.notify("Could not refresh the goal footer.", "warning");
  }
}

async function footerClear(
  deps: WeaveGoalCommandDependencies,
  ui: PiWorkflowCommandUiPort,
): Promise<void> {
  try {
    await deps.footer.clear();
  } catch {
    ui.notify("Could not clear the goal footer.", "warning");
  }
}

function describeStatus(
  state: NonNullable<WeaveGoalCommandDependencies["controller"]["current"]>,
  snapshot: PlanTaskSnapshot | undefined,
  elapsedMs: number,
): string {
  const selected =
    snapshot === undefined ? undefined : selectActivePlanTask(snapshot);
  const taskText =
    selected?.isOk() === true
      ? `${selected.value.taskId}. ${selected.value.taskTitle}`
      : "unavailable";
  const remaining =
    snapshot === undefined
      ? "unavailable"
      : String(countIncompleteLeaves(snapshot.parents));
  const evidence =
    state.evidence === undefined ? "" : `\nEvidence: ${state.evidence}`;
  const reason = state.reason === undefined ? "" : `\nReason: ${state.reason}`;
  return (
    [
      `Goal: ${state.planName} (${state.status})`,
      `Plan: ${state.planName}`,
      `Active task: ${taskText}`,
      `Elapsed: ${formatDuration(elapsedMs)}`,
      `Turns: ${state.turns}`,
      `Tokens: ${formatTokenCount(state.tokens)}`,
      `Remaining leaves: ${remaining}`,
    ].join("\n") +
    evidence +
    reason
  );
}

async function readAuthoritativeSnapshot(
  deps: WeaveGoalCommandDependencies,
  planName: string,
): Promise<PlanTaskSnapshot | undefined> {
  try {
    return await deps.readSnapshot(planName).match(
      (snapshot) => snapshot,
      () => undefined,
    );
  } catch {
    return undefined;
  }
}

function notifyFailure(
  ui: PiWorkflowCommandUiPort,
  prefix: string,
  error: unknown,
): void {
  const message =
    typeof error === "object" && error !== null && "safeMessage" in error
      ? String((error as { safeMessage: unknown }).safeMessage)
      : "The operation could not be completed.";
  ui.notify(`${prefix}: ${message}`, "error");
}

async function send(
  deps: WeaveGoalCommandDependencies,
  customType: string,
  content: string,
  display: boolean,
): Promise<void> {
  await deps.pi.sendMessage(
    { customType, content, display },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

async function controlWordHint(
  deps: WeaveGoalCommandDependencies,
  word: string,
): Promise<string> {
  try {
    const names: readonly string[] = await deps.catalog
      .listPlanNames(deps.projectRoot)
      .match(
        (planNames) => planNames,
        () => [] as readonly string[],
      );
    return names.includes(word)
      ? ` Use /weave:goal -- ${word} to start that plan.`
      : "";
  } catch {
    return "";
  }
}

async function handleStatus(
  ui: PiWorkflowCommandUiPort,
  deps: WeaveGoalCommandDependencies,
  hintWord?: string,
): Promise<void> {
  const state = deps.controller.current;
  if (state === undefined) {
    ui.notify(
      `No goal is set. Use /weave:goal <plan-name>.${hintWord === undefined ? "" : await controlWordHint(deps, hintWord)}`,
      "info",
    );
    return;
  }
  const snapshot = await readAuthoritativeSnapshot(deps, state.planName);
  ui.notify(
    `${describeStatus(state, snapshot, deps.controller.elapsedMs())}${hintWord === undefined ? "" : await controlWordHint(deps, hintWord)}`,
    "info",
  );
}

async function handleStart(
  planName: string,
  ui: PiWorkflowCommandUiPort,
  deps: WeaveGoalCommandDependencies,
): Promise<void> {
  const resolved = await resolveGoalPlan({
    planName,
    catalog: deps.catalog,
    projectRoot: deps.projectRoot,
    readSnapshot: deps.readSnapshot,
  }).match(
    (snapshot) => snapshot,
    (error) => {
      notifyFailure(ui, `Could not start goal "${planName}"`, error);
      return undefined;
    },
  );
  if (resolved === undefined) return;

  const started = deps.controller.start(planName, resolved.contentRevision);
  if (started.isErr()) {
    notifyFailure(ui, "Could not start goal", started.error);
    return;
  }
  try {
    persistController(deps);
    await footerRefresh(deps, ui);
    await send(
      deps,
      "weave-goal-start",
      `Pursue the goal plan "${planName}" and begin with its first actionable task.`,
      true,
    );
    ui.notify(`Started goal "${planName}".`, "info");
  } catch {
    ui.notify(
      "Goal started, but the opening turn could not be sent.",
      "warning",
    );
  }
}

export async function handleWeaveGoal(
  rawArgs: string,
  ui: PiWorkflowCommandUiPort,
  deps: WeaveGoalCommandDependencies,
): Promise<void> {
  const args: WeaveGoalArgs = parseWeaveGoalArgs(rawArgs);

  try {
    if (args.kind === "invalid") {
      ui.notify(`Invalid goal command: ${args.reason}.`, "warning");
      return;
    }
    if (args.kind === "status") {
      const word = rawArgs.trim().toLowerCase();
      return await handleStatus(
        ui,
        deps,
        word === "status" || word === "check" ? word : undefined,
      );
    }
    if (args.kind === "start")
      return await handleStart(args.planName, ui, deps);
    if (args.kind === "pause") {
      const result = deps.controller.pause("Paused by the user.");
      if (result.isErr())
        return notifyFailure(ui, "Could not pause goal", result.error);
      persistController(deps);
      await footerRefresh(deps, ui);
      ui.notify(
        `Goal paused. Use /weave:goal resume to continue.${await controlWordHint(deps, "pause")}`,
        "info",
      );
      return;
    }
    if (args.kind === "clear") {
      const result = deps.controller.clear();
      if (result.isErr())
        return notifyFailure(ui, "Could not clear goal", result.error);
      persist(deps, deps.controller.serialize());
      syncWeaveGoalReportToolAvailability(deps.pi, deps.controller);
      await footerClear(deps, ui);
      const controlToken = rawArgs.trim().toLowerCase();
      ui.notify(
        `Goal cleared.${await controlWordHint(deps, controlToken)}`,
        "info",
      );
      return;
    }

    const current = deps.controller.current;
    if (current === undefined) {
      ui.notify(
        `No paused goal can be resumed.${await controlWordHint(deps, "resume")}`,
        "warning",
      );
      return;
    }
    if (!["paused", "blocked", "budget-limited"].includes(current.status)) {
      ui.notify(
        `Goal is already ${current.status}; nothing changed.${await controlWordHint(deps, "resume")}`,
        "warning",
      );
      return;
    }
    const resumed = deps.controller.resume();
    if (resumed.isErr())
      return notifyFailure(ui, "Could not resume goal", resumed.error);
    persistController(deps);
    await footerRefresh(deps, ui);
    const direction =
      args.direction === undefined ? "" : ` Direction: ${args.direction}.`;
    await send(
      deps,
      "weave-goal-continuation",
      `Continue pursuing the active goal.${direction}`,
      false,
    );
    ui.notify(
      args.direction === undefined
        ? "Goal resumed."
        : "Goal resumed with new direction.",
      "info",
    );
  } catch {
    ui.notify("The goal command could not be completed.", "error");
  }
}
