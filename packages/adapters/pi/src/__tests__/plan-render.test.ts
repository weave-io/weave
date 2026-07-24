import { describe, expect, it } from "bun:test";
import type { PlanTaskNode, PlanTaskSnapshot } from "@weaveio/weave-engine";
import { renderPlanWidgetLines } from "../plan-render.js";

function parent(overrides: Partial<PlanTaskNode> = {}): PlanTaskNode {
  return {
    id: "1",
    title: "First parent",
    state: "pending",
    children: [],
    ...overrides,
  };
}

function snapshot(
  parents: readonly PlanTaskNode[],
  overrides: Partial<PlanTaskSnapshot> = {},
): PlanTaskSnapshot {
  return {
    planName: "my-plan",
    contentRevision: "rev-1",
    format: "canonical",
    parents,
    totalParentCount: parents.length,
    complete: parents.every((p) => p.state === "completed"),
    ...overrides,
  };
}

describe("renderPlanWidgetLines", () => {
  it("returns an empty array (hides the widget) when there is no snapshot", () => {
    expect(renderPlanWidgetLines(undefined)).toEqual([]);
  });

  it("returns an empty array (hides the widget) when the plan has no parent tasks", () => {
    expect(renderPlanWidgetLines(snapshot([]))).toEqual([]);
  });

  it("reports 'Task N of M' for the first in_progress parent", () => {
    const lines = renderPlanWidgetLines(
      snapshot([
        parent({ id: "1", state: "completed" }),
        parent({ id: "2", state: "in_progress" }),
        parent({ id: "3", state: "pending" }),
      ]),
    );
    expect(lines[0]).toContain("Task 2 of 3");
  });

  it("falls back to the first pending parent when none is in_progress", () => {
    const lines = renderPlanWidgetLines(
      snapshot([
        parent({ id: "1", state: "completed" }),
        parent({ id: "2", state: "pending" }),
        parent({ id: "3", state: "pending" }),
      ]),
    );
    expect(lines[0]).toContain("Task 2 of 3");
  });

  it("falls back to the last parent when every parent is completed", () => {
    const lines = renderPlanWidgetLines(
      snapshot([
        parent({ id: "1", state: "completed" }),
        parent({ id: "2", state: "completed" }),
      ]),
    );
    expect(lines[0]).toContain("Task 2 of 2");
  });

  it("renders previous, current, and next parent lines", () => {
    const lines = renderPlanWidgetLines(
      snapshot([
        parent({ id: "1", title: "Alpha", state: "completed" }),
        parent({ id: "2", title: "Bravo", state: "in_progress" }),
        parent({ id: "3", title: "Charlie", state: "pending" }),
      ]),
    );
    expect(
      lines.some((line) => line.includes("prev") && line.includes("1. Alpha")),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes("now") && line.includes("2. Bravo")),
    ).toBe(true);
    expect(
      lines.some(
        (line) => line.includes("next") && line.includes("3. Charlie"),
      ),
    ).toBe(true);
  });

  it("omits the previous line for the first parent and the next line for the last parent", () => {
    const lines = renderPlanWidgetLines(
      snapshot([parent({ id: "1", state: "in_progress" })]),
    );
    expect(lines.some((line) => line.includes("prev"))).toBe(false);
    expect(lines.some((line) => line.includes("next"))).toBe(false);
  });

  it("renders every subtask of the current parent", () => {
    const lines = renderPlanWidgetLines(
      snapshot([
        parent({
          id: "1",
          state: "in_progress",
          children: [
            { id: "1.a", title: "Sub a", state: "completed", children: [] },
            { id: "1.b", title: "Sub b", state: "pending", children: [] },
          ],
        }),
      ]),
    );
    expect(lines.some((line) => line.includes("1.a. Sub a"))).toBe(true);
    expect(lines.some((line) => line.includes("1.b. Sub b"))).toBe(true);
  });

  it("bounds the rendered subtask lines and reports the hidden count", () => {
    const children = Array.from({ length: 25 }, (_, i) => ({
      id: `1.${i}`,
      title: `Sub ${i}`,
      state: "pending" as const,
      children: [],
    }));
    const lines = renderPlanWidgetLines(
      snapshot([parent({ id: "1", state: "in_progress", children })]),
    );
    const subtaskLines = lines.filter((line) => line.includes("Sub "));
    expect(subtaskLines.length).toBe(20);
    expect(lines.some((line) => line.includes("...5 more"))).toBe(true);
  });

  it("badges other in_progress parents, excluding the current one", () => {
    const lines = renderPlanWidgetLines(
      snapshot([
        parent({ id: "1", state: "in_progress" }),
        parent({ id: "2", state: "in_progress" }),
        parent({ id: "3", state: "in_progress" }),
      ]),
    );
    const badgeLine = lines.find((line) => line.includes("also active"));
    expect(badgeLine).toBeDefined();
    expect(badgeLine).toContain("[2]");
    expect(badgeLine).toContain("[3]");
    expect(badgeLine).not.toContain("[1]");
  });

  it("bounds the number of badges rendered", () => {
    const parents = Array.from({ length: 12 }, (_, i) =>
      parent({ id: `${i}`, state: "in_progress" }),
    );
    const lines = renderPlanWidgetLines(snapshot(parents));
    const badgeLine = lines.find((line) => line.includes("also active"));
    expect(badgeLine).toBeDefined();
    const badgeCount = (badgeLine?.match(/\[/g) ?? []).length;
    expect(badgeCount).toBe(8);
  });

  it("omits the badge line entirely when no other parent is active", () => {
    const lines = renderPlanWidgetLines(
      snapshot([
        parent({ id: "1", state: "completed" }),
        parent({ id: "2", state: "in_progress" }),
        parent({ id: "3", state: "pending" }),
      ]),
    );
    expect(lines.some((line) => line.includes("also active"))).toBe(false);
  });
});
