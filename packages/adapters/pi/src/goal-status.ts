import {
  type ActivePlanTask,
  formatDuration as formatElapsed,
  formatTokenCount as formatTokens,
  type PlanActiveTaskError,
  type SessionGoalState,
} from "@weaveio/weave-engine";
import type { PiUiThemePort } from "./types.js";

export const WEAVE_GOAL_STATUS_KEY = "weave-goal";
export const WEAVE_GOAL_STATUS_MAX_WIDTH = 72;

export interface RenderGoalFooterInput {
  readonly state: SessionGoalState | undefined;
  readonly activeTask: ActivePlanTask | PlanActiveTaskError | undefined;
  readonly planUnavailable: boolean;
  readonly planComplete: boolean;
  readonly elapsedMs: number;
  readonly theme?: PiUiThemePort;
}

type FooterParts = {
  readonly marker: "◎" | "◇" | "✓";
  readonly status?: string;
  readonly plan: string;
  readonly taskId?: string;
  readonly taskTitle?: string;
  readonly taskFallback?: string;
  readonly progress?: string;
  readonly metrics: string;
};

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isActiveTask(
  value: ActivePlanTask | PlanActiveTaskError,
): value is ActivePlanTask {
  return !("kind" in value);
}

function codePoints(value: string): readonly string[] {
  return Array.from(value);
}

function width(value: string): number {
  return codePoints(value).length;
}

function truncate(value: string, maxWidth: number): string {
  const points = codePoints(value);
  if (points.length <= maxWidth) return value;
  if (maxWidth <= 1) return "…";
  return `${points.slice(0, maxWidth - 1).join("")}…`;
}

function taskText(parts: FooterParts): string | undefined {
  if (parts.taskId !== undefined && parts.taskTitle !== undefined) {
    return `${parts.taskId}${parts.taskTitle}`;
  }
  return parts.taskFallback;
}

function plainFooter(
  parts: FooterParts,
  includeMetrics: boolean,
  includeProgress: boolean,
): string {
  const prefix =
    parts.status === undefined
      ? `${parts.marker} goal`
      : `${parts.marker} goal ${parts.status}`;
  const fields = [prefix, parts.plan];
  const task = taskText(parts);
  if (task !== undefined) fields.push(task);
  if (includeProgress && parts.progress !== undefined)
    fields.push(parts.progress);
  if (includeMetrics) fields.push(parts.metrics);
  return fields.join(" · ");
}

function fitFooter(parts: FooterParts): { text: string; parts: FooterParts } {
  let includeMetrics = true;
  let includeProgress = parts.progress !== undefined;
  let taskTitle = parts.taskTitle;
  let plan = parts.plan;
  const candidate = () =>
    plainFooter({ ...parts, plan, taskTitle }, includeMetrics, includeProgress);
  const fittedParts = () => ({ ...parts, plan, taskTitle });

  if (width(candidate()) <= WEAVE_GOAL_STATUS_MAX_WIDTH)
    return { text: candidate(), parts: fittedParts() };
  includeMetrics = false;
  if (width(candidate()) <= WEAVE_GOAL_STATUS_MAX_WIDTH)
    return { text: candidate(), parts: fittedParts() };
  includeProgress = false;
  if (width(candidate()) <= WEAVE_GOAL_STATUS_MAX_WIDTH)
    return { text: candidate(), parts: fittedParts() };

  if (parts.taskId !== undefined && taskTitle !== undefined) {
    const originalTitle = taskTitle;
    const titlePoints = codePoints(originalTitle);
    for (let max = titlePoints.length; max >= 9; max -= 1) {
      taskTitle = truncate(originalTitle, max);
      if (width(candidate()) <= WEAVE_GOAL_STATUS_MAX_WIDTH) break;
    }
    if (width(candidate()) <= WEAVE_GOAL_STATUS_MAX_WIDTH)
      return { text: candidate(), parts: fittedParts() };
    taskTitle = truncate(originalTitle, 9);
  }

  plan = truncate(plan, 25);
  return { text: candidate(), parts: fittedParts() };
}

export function renderGoalFooter(
  input: RenderGoalFooterInput,
): string | undefined {
  const state = input.state;
  if (state === undefined) return undefined;

  const plan = normalize(state.planName);
  const activeTask = input.activeTask;
  const noTask =
    activeTask !== undefined &&
    "kind" in activeTask &&
    activeTask.kind === "NoActivePlanTask";
  const active =
    activeTask !== undefined && isActiveTask(activeTask)
      ? activeTask
      : undefined;
  const complete = state.status === "achieved" || input.planComplete;
  let taskId: string | undefined;
  let taskTitle: string | undefined;
  if (!complete && active !== undefined) {
    taskId = `${active.taskId}. `;
    taskTitle = normalize(active.taskTitle);
  }
  let taskFallback: string | undefined;
  if (complete) taskFallback = "complete";
  else if (noTask) taskFallback = "no tasks";
  else if (input.planUnavailable) taskFallback = "plan unavailable";
  else if (activeTask === undefined) taskFallback = "…";

  const warning = state.status !== "pursuing" && state.status !== "achieved";
  let marker: FooterParts["marker"] = "◎";
  if (warning) marker = "◇";
  if (state.status === "achieved") marker = "✓";
  const parts: FooterParts = {
    marker,
    status: warning ? state.status : undefined,
    plan: plan || "…",
    taskId,
    taskTitle,
    taskFallback,
    progress:
      active !== undefined && !input.planUnavailable && !noTask
        ? `${complete ? active.totalParentCount : active.parentOrdinal}/${active.totalParentCount}`
        : undefined,
    metrics: `${formatElapsed(input.elapsedMs)} · ${state.turns}t · ${formatTokens(state.tokens)} tok`,
  };
  const fitted = fitFooter(parts);
  if (input.theme === undefined) return fitted.text;

  let color: "accent" | "warning" | "success" = "accent";
  if (marker === "◇") color = "warning";
  if (marker === "✓") color = "success";
  return input.theme.fg(color, fitted.text);
}
