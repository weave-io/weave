/**
 * Pure, Pi-independent rendering of the durable-workflow current-task footer.
 *
 * The footer has one owner: a durable workflow renders its current task here
 * under a single dedicated status key, so a session can never show two
 * competing "current task" strings.
 *
 * Like `plan-render.ts`, this module knows nothing about *which* plan is
 * active: callers resolve the active workflow instance, `inspect()` it for its
 * `slug`, read that plan's snapshot, and select the active task with the same
 * engine semantics the plan widget uses (`selectActivePlanTask`).
 */
import type { ActivePlanTask } from "@weaveio/weave-engine";
import type { PiUiThemePort } from "./types.js";

/** The dedicated status key for the durable-workflow current-task footer. */
export const WEAVE_WORKFLOW_TASK_STATUS_KEY = "weave-task";

/** Hard cap on the rendered footer so a pathological task title can never grow it without limit. */
export const WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH = 56;

export interface RenderWorkflowTaskFooterInput {
  /** The active task selected by the engine, or `undefined` when there is no workflow/plan/task. */
  readonly activeTask: ActivePlanTask | undefined;
  readonly theme?: PiUiThemePort;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function truncate(value: string, maxWidth: number): string {
  const points = Array.from(value);
  if (points.length <= maxWidth) return value;
  if (maxWidth <= 1) return "…";
  return `${points.slice(0, maxWidth - 1).join("")}…`;
}

/**
 * Renders one bounded `▸ task N/M · <id>. <title>` footer string, or
 * `undefined` to clear the footer entirely when no task is active.
 *
 * The bound applies to the *whole* rendered string, not just the title: a
 * pathological task ID, ordinal or total can never push the footer past
 * `WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH` code points. Exactly one ellipsis is
 * used when content is dropped.
 */
export function renderWorkflowTaskFooter(
  input: RenderWorkflowTaskFooterInput,
): string | undefined {
  const active = input.activeTask;
  if (active === undefined) return undefined;

  const title = normalize(active.taskTitle);
  const id = normalize(active.taskId);
  const head = normalize(
    `▸ task ${active.parentOrdinal}/${active.totalParentCount}`,
  );
  const label = id === "" ? head : `${head} · ${id}`;
  const prefix = id === "" ? `${label} · ` : `${label}. `;
  const text = title === "" ? label : `${prefix}${title}`;

  const bounded = boundFooter({ text, prefix, title });
  return input.theme === undefined
    ? bounded
    : input.theme.fg("accent", bounded);
}

function boundFooter(parts: {
  readonly text: string;
  readonly prefix: string;
  readonly title: string;
}): string {
  if (Array.from(parts.text).length <= WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH) {
    return parts.text;
  }

  // Preferred degradation: keep the whole `▸ task N/M · <id>. ` prefix and
  // spend the remaining budget on the title.
  const budget =
    WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH - Array.from(parts.prefix).length;
  if (parts.title !== "" && budget >= 2) {
    return `${parts.prefix}${truncate(parts.title, budget)}`;
  }

  // The prefix alone exhausts the budget: truncate the whole footer so the
  // leading `▸ task N/M` stays visible and the cap still holds.
  return truncate(parts.text, WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH);
}
