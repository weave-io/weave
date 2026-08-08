/**
 * Pure, Pi-independent rendering of the bounded compact plan widget (Pi adapter contract
 *). Shows `Task N of M`, the previous/current/next parent task, every
 * subtask of the current parent, and badges for any *other* parent task
 * that is also `in_progress`. Read-only and bounded - never mutates the
 * snapshot, never reimplements plan parsing/CAS logic, and caps both the
 * subtask and badge lists so a pathologically large plan can never grow the
 * widget without limit. The caller (`extension.ts`) hands the resulting
 * `string[]` straight to `ctx.ui.setWidget`, mirroring
 * `renderChildTreeLines`'s contract exactly (`[]` hides the widget).
 *
 * This module knows nothing about *which* plan is active or how to obtain
 * one - callers derive that from `PlanStateProvider.readSnapshot` (which
 * plan file, keyed off the active workflow instance's `slug` as read back
 * from `inspectExecution`/`PiWorkflowController.inspect`) and pass the
 * resulting `PlanTaskSnapshot` straight in.
 */
import {
  type PlanTaskNode,
  type PlanTaskSnapshot,
  selectActivePlanTask,
} from "@weaveio/weave-engine";

/** Bounds the number of current-parent subtask lines rendered - a pathologically large parent can never grow the widget without limit. */
const MAX_SUBTASK_LINES = 20;
/** Bounds the number of "other active parent" badges rendered. */
const MAX_BADGE_IDS = 8;

function taskMarker(state: PlanTaskNode["state"]): string {
  if (state === "completed") return "[x]";
  if (state === "in_progress") return "[~]";
  return "[ ]";
}

function renderParentLine(label: string, parent: PlanTaskNode): string {
  return `  ${label} ${taskMarker(parent.state)} ${parent.id}. ${parent.title}`;
}

/**
 * Renders the compact plan widget. Returns `[]` (hides the widget) when
 * there is no snapshot at all, or the snapshot has no parent tasks.
 */
export function renderPlanWidgetLines(
  snapshot: PlanTaskSnapshot | undefined,
): string[] {
  if (snapshot === undefined) return [];
  const { parents, totalParentCount, planName } = snapshot;
  if (parents.length === 0) return [];

  const currentIndex = selectActivePlanTask(snapshot).match(
    (activeTask) => activeTask.parentIndex,
    () => undefined,
  );
  if (currentIndex === undefined) return [];

  const current = parents[currentIndex];
  if (current === undefined) return [];

  const lines: string[] = [
    `Plan "${planName}" - Task ${currentIndex + 1} of ${totalParentCount}`,
  ];

  const previous = currentIndex > 0 ? parents[currentIndex - 1] : undefined;
  if (previous !== undefined) lines.push(renderParentLine("prev", previous));
  lines.push(renderParentLine("now ", current));
  const next =
    currentIndex + 1 < parents.length ? parents[currentIndex + 1] : undefined;
  if (next !== undefined) lines.push(renderParentLine("next", next));

  const subtasks = current.children.slice(0, MAX_SUBTASK_LINES);
  for (const child of subtasks) {
    lines.push(`    ${taskMarker(child.state)} ${child.id}. ${child.title}`);
  }
  const hiddenSubtaskCount = current.children.length - subtasks.length;
  if (hiddenSubtaskCount > 0) {
    lines.push(`    ...${hiddenSubtaskCount} more`);
  }

  const otherActiveIds = parents
    .filter(
      (parent, index) =>
        index !== currentIndex && parent.state === "in_progress",
    )
    .slice(0, MAX_BADGE_IDS)
    .map((parent) => parent.id);
  if (otherActiveIds.length > 0) {
    lines.push(
      `  also active: ${otherActiveIds.map((id) => `[${id}]`).join(" ")}`,
    );
  }

  return lines;
}
