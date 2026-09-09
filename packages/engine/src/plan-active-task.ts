import { err, ok, type Result } from "neverthrow";
import type {
  PlanTaskNode,
  PlanTaskSnapshot,
  PlanTaskState,
} from "./plan-task-snapshot.js";

export interface ActivePlanTask {
  readonly parentIndex: number;
  readonly parentOrdinal: number;
  readonly totalParentCount: number;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskState: PlanTaskState;
  readonly isChild: boolean;
  readonly parentId: string;
  readonly parentTitle: string;
}

export type PlanActiveTaskError = { readonly kind: "NoActivePlanTask" };

function selectNode(nodes: readonly PlanTaskNode[]): PlanTaskNode | undefined {
  const inProgress = nodes.find((node) => node.state === "in_progress");
  if (inProgress !== undefined) return inProgress;
  const pending = nodes.find((node) => node.state === "pending");
  return pending;
}

/** Select explicit in-progress work first, then the first pending task. */
export function selectActivePlanTask(
  snapshot: PlanTaskSnapshot,
): Result<ActivePlanTask, PlanActiveTaskError> {
  const parent = selectNode(snapshot.parents);
  if (parent === undefined) return err({ kind: "NoActivePlanTask" });

  const parentIndex = snapshot.parents.indexOf(parent);
  const isChild = parent.children.length > 0;
  const task = isChild ? selectNode(parent.children) : parent;
  if (task === undefined) return err({ kind: "NoActivePlanTask" });

  return ok({
    parentIndex,
    parentOrdinal: parentIndex + 1,
    totalParentCount: snapshot.totalParentCount,
    taskId: task.id,
    taskTitle: task.title,
    taskState: task.state,
    isChild,
    parentId: parent.id,
    parentTitle: parent.title,
  });
}

/** Return the pending task after the selected task, if one exists. */
export function selectNextPlanTask(
  snapshot: PlanTaskSnapshot,
): ActivePlanTask | undefined {
  const active = selectActivePlanTask(snapshot);
  if (active.isErr() || snapshot.complete) return undefined;

  const candidates: ActivePlanTask[] = [];
  for (const [parentIndex, parent] of snapshot.parents.entries()) {
    const tasks = parent.children.length > 0 ? parent.children : [parent];
    for (const task of tasks) {
      if (task.state !== "pending") continue;
      candidates.push({
        parentIndex,
        parentOrdinal: parentIndex + 1,
        totalParentCount: snapshot.totalParentCount,
        taskId: task.id,
        taskTitle: task.title,
        taskState: task.state,
        isChild: task !== parent,
        parentId: parent.id,
        parentTitle: parent.title,
      });
    }
  }

  const activeIndex = candidates.findIndex(
    (candidate) => candidate.taskId === active.value.taskId,
  );
  if (active.value.taskState === "pending" && activeIndex >= 0)
    return candidates[activeIndex + 1];
  return candidates[0];
}
