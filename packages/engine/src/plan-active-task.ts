import { err, ok, type Result } from "neverthrow";
import type {
  PlanTaskNode,
  PlanTaskSnapshot,
  PlanTaskState,
} from "./plan-state-provider.js";

/** The selected task and its position within the plan. */
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

/** Errors returned when a plan has no selectable task. */
export type PlanActiveTaskError = {
  readonly kind: "NoActivePlanTask";
};

function selectNode(nodes: readonly PlanTaskNode[]): PlanTaskNode {
  const inProgress = nodes.find((node) => node.state === "in_progress");
  if (inProgress !== undefined) return inProgress;

  const pending = nodes.find((node) => node.state === "pending");
  if (pending !== undefined) return pending;

  return nodes[nodes.length - 1] as PlanTaskNode;
}

/** Select the task that is active according to the plan's ordered state. */
export function selectActivePlanTask(
  snapshot: PlanTaskSnapshot,
): Result<ActivePlanTask, PlanActiveTaskError> {
  if (snapshot.parents.length === 0) {
    return err({ kind: "NoActivePlanTask" });
  }

  const parent = selectNode(snapshot.parents);
  const parentIndex = snapshot.parents.indexOf(parent);
  const isChild = parent.children.length > 0;
  const task = isChild ? selectNode(parent.children) : parent;

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
