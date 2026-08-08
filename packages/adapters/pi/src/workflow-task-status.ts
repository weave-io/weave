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
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivePlanTask } from "@weaveio/weave-engine";
import type { PiUiThemePort } from "./types.js";

/** The dedicated status key for the durable-workflow current-task footer. */
export const WEAVE_WORKFLOW_TASK_STATUS_KEY = "weave-task";

/** Hard cap, in terminal display columns, on the rendered footer so a pathological task title can never grow it without limit. */
export const WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH = 56;

export interface RenderWorkflowTaskFooterInput {
  /** The active task selected by the engine, or `undefined` when there is no workflow/plan/task. */
  readonly activeTask: ActivePlanTask | undefined;
  readonly theme?: PiUiThemePort;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/**
 * Truncates to a *display-column* budget rather than a code-point count, so a
 * wide emoji or CJK glyph costs the two columns the terminal actually spends
 * on it. Exactly one ellipsis is appended when content is dropped, and the
 * ellipsis itself is paid for out of the budget.
 *
 * `truncateToWidth` is asked for a plain cut (empty ellipsis) so the visible
 * ellipsis stays the final character of the string; the helper still emits a
 * trailing ANSI reset, which costs zero display columns.
 */
function truncateToDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(value) <= maxWidth) return value;
  if (maxWidth === 1) return "…";
  return `${truncateToWidth(value, maxWidth - 1, "")}…`;
}

/**
 * Renders one bounded `▸ task N/M · <id>. <title>` footer string, or
 * `undefined` to clear the footer entirely when no task is active.
 *
 * The bound applies to the *whole* rendered string, not just the title: a
 * pathological task ID, ordinal or total can never push the footer past
 * `WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH` *display columns*. Exactly one
 * ellipsis is used when content is dropped.
 *
 * The cap holds for the themed string too: a theme is applied once, after the
 * logical bound, and the result is re-measured with `visibleWidth` so a theme
 * that adds visible characters cannot widen the footer either.
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
  if (input.theme === undefined) return bounded;

  // One theme call, after the logical bound. Styling is normally
  // width-invisible, but the final ANSI-aware truncation keeps the contract
  // true even for a theme that inserts visible characters.
  const themed = input.theme.fg("accent", bounded);
  return visibleWidth(themed) <= WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH
    ? themed
    : truncateToWidth(themed, WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH, "…");
}

function boundFooter(parts: {
  readonly text: string;
  readonly prefix: string;
  readonly title: string;
}): string {
  if (visibleWidth(parts.text) <= WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH) {
    return parts.text;
  }

  // Preferred degradation: keep the whole `▸ task N/M · <id>. ` prefix and
  // spend the remaining display columns on the title.
  const budget =
    WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH - visibleWidth(parts.prefix);
  if (parts.title !== "" && budget >= 2) {
    return `${parts.prefix}${truncateToDisplayWidth(parts.title, budget)}`;
  }

  // The prefix alone exhausts the budget: truncate the whole footer so the
  // leading `▸ task N/M` stays visible and the cap still holds.
  return truncateToDisplayWidth(
    parts.text,
    WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH,
  );
}
