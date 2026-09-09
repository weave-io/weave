import { describe, expect, it } from "bun:test";
import {
  selectActivePlanTask,
  selectNextPlanTask,
} from "../plan-active-task.js";
import type { PlanTaskNode, PlanTaskSnapshot } from "../plan-task-snapshot.js";

const node = (
  id: string,
  state: PlanTaskNode["state"],
  children: PlanTaskNode[] = [],
): PlanTaskNode => ({ id, title: id, state, children });
const snapshot = (
  parents: PlanTaskNode[],
  complete = false,
): PlanTaskSnapshot => ({
  planName: "p",
  contentRevision: "a".repeat(64),
  format: "canonical",
  parents,
  totalParentCount: parents.length,
  totalTaskCount: parents.length,
  completedTaskCount: 0,
  complete,
});

describe("plan task selection", () => {
  it("selects in-progress before pending and returns the next pending task", () => {
    const value = snapshot([
      node("1", "pending"),
      node("2", "in_progress"),
      node("3", "pending"),
    ]);
    expect(selectActivePlanTask(value)._unsafeUnwrap().taskId).toBe("2");
    expect(selectNextPlanTask(value)?.taskId).toBe("1");
  });

  it("selects a child and handles completed and empty plans", () => {
    const value = snapshot([
      node("1", "in_progress", [
        node("1.a", "completed"),
        node("1.b", "pending"),
      ]),
    ]);
    expect(selectActivePlanTask(value)._unsafeUnwrap().taskId).toBe("1.b");
    const completed = snapshot([node("1", "completed")], true);
    expect(selectActivePlanTask(completed).isErr()).toBe(true);
    expect(selectNextPlanTask(completed)).toBeUndefined();
    expect(selectActivePlanTask(snapshot([])).isErr()).toBe(true);
  });
});
