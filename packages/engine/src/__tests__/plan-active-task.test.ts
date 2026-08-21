import { describe, expect, test } from "bun:test";
import { selectActivePlanTask } from "../plan-active-task.js";
import type { PlanTaskNode, PlanTaskSnapshot } from "../plan-state-provider.js";

function node(
  id: string,
  state: PlanTaskNode["state"],
  children: readonly PlanTaskNode[] = [],
): PlanTaskNode {
  return { id, title: `${id} title`, state, children };
}

function snapshot(parents: readonly PlanTaskNode[]): PlanTaskSnapshot {
  return {
    planName: "feature",
    contentRevision: "rev-1",
    format: "canonical",
    parents,
    totalParentCount: parents.length,
    complete: parents.every((parent) =>
      parent.children.length === 0
        ? parent.state === "completed"
        : parent.children.every((child) => child.state === "completed"),
    ),
  };
}

function selected(parents: readonly PlanTaskNode[]) {
  const result = selectActivePlanTask(snapshot(parents));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe("active plan task selection", () => {
  test("rejects empty parent lists", () => {
    expect(selectActivePlanTask(snapshot([]))._unsafeUnwrapErr()).toEqual({
      kind: "NoActivePlanTask",
    });
  });

  test("selects the first in-progress parent", () => {
    expect(
      selected([node("1", "in_progress"), node("2", "in_progress")]),
    ).toMatchObject({
      parentIndex: 0,
      parentOrdinal: 1,
      taskId: "1",
      isChild: false,
    });
  });

  test("falls back to the first pending parent", () => {
    expect(
      selected([node("1", "pending"), node("2", "pending")]),
    ).toMatchObject({
      parentIndex: 0,
      taskId: "1",
    });
  });

  test("selects the last parent when all parents are complete", () => {
    expect(
      selected([node("1", "completed"), node("2", "completed")]),
    ).toMatchObject({
      parentIndex: 1,
      parentOrdinal: 2,
      taskId: "2",
      taskState: "completed",
    });
  });

  test("selects the last child when the selected parent is complete", () => {
    const parent = node("1", "completed", [
      node("1.a", "completed"),
      node("1.b", "completed"),
    ]);
    expect(selected([parent])).toMatchObject({
      parentIndex: 0,
      taskId: "1.b",
      taskTitle: "1.b title",
      taskState: "completed",
      isChild: true,
      parentId: "1",
      parentTitle: "1 title",
    });
  });

  test("selects a childless parent as its own task", () => {
    expect(selected([node("1", "pending")])).toMatchObject({
      taskId: "1",
      taskTitle: "1 title",
      parentId: "1",
      isChild: false,
      totalParentCount: 1,
    });
  });

  test("orders child selection by in-progress, then pending, then last", () => {
    expect(
      selected([
        node("1", "in_progress", [
          node("1.a", "pending"),
          node("1.b", "in_progress"),
        ]),
      ]),
    ).toMatchObject({
      taskId: "1.b",
      taskState: "in_progress",
      isChild: true,
    });
    expect(
      selected([
        node("1", "in_progress", [
          node("1.a", "pending"),
          node("1.b", "pending"),
        ]),
      ]),
    ).toMatchObject({
      taskId: "1.a",
      taskState: "pending",
    });
    expect(
      selected([
        node("1", "in_progress", [
          node("1.a", "completed"),
          node("1.b", "completed"),
        ]),
      ]),
    ).toMatchObject({
      taskId: "1.b",
      taskState: "completed",
    });
  });

  test("prefers an in-progress parent over earlier pending parents", () => {
    expect(
      selected([
        node("1", "pending"),
        node("2", "in_progress"),
        node("3", "pending"),
      ]),
    ).toMatchObject({
      parentIndex: 1,
      parentOrdinal: 2,
      taskId: "2",
    });
  });
});
