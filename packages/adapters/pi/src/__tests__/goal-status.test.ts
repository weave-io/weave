import { describe, expect, it } from "bun:test";
import {
  renderGoalFooter,
  WEAVE_GOAL_STATUS_MAX_WIDTH,
} from "../goal-status.js";

const state = (
  status:
    | "pursuing"
    | "paused"
    | "blocked"
    | "achieved"
    | "budget-limited" = "pursuing",
) => ({
  version: 1 as const,
  planName: "roadmap",
  planContentRevision: "r",
  status,
  startedAt: 0,
  elapsedMs: 12_000,
  turns: 3,
  tokens: 456,
  continuations: 1,
});
const task = {
  parentIndex: 0,
  parentOrdinal: 1,
  totalParentCount: 4,
  taskId: "T1",
  taskTitle: "Write tests",
  taskState: "in_progress" as const,
  isChild: false,
  parentId: "p",
  parentTitle: "Write tests",
};
describe("renderGoalFooter", () => {
  it("renders every status, child IDs, completion and fallbacks", () => {
    for (const status of [
      "pursuing",
      "paused",
      "blocked",
      "achieved",
      "budget-limited",
    ] as const)
      expect(
        renderGoalFooter({
          state: state(status),
          activeTask: task,
          planUnavailable: false,
          planComplete: status === "achieved",
          elapsedMs: 12_000,
        }),
      ).toContain(status === "achieved" ? "complete" : "goal");
    expect(
      renderGoalFooter({
        state: state(),
        activeTask: { ...task, isChild: true, taskId: "child" },
        planUnavailable: false,
        planComplete: false,
        elapsedMs: 0,
      }),
    ).toContain("child. ");
    expect(
      renderGoalFooter({
        state: state(),
        activeTask: { kind: "NoActivePlanTask" },
        planUnavailable: false,
        planComplete: false,
        elapsedMs: 0,
      }),
    ).toContain("no tasks");
    expect(
      renderGoalFooter({
        state: state(),
        activeTask: undefined,
        planUnavailable: true,
        planComplete: false,
        elapsedMs: 0,
      }),
    ).toContain("plan unavailable");
    expect(
      renderGoalFooter({
        state: undefined,
        activeTask: undefined,
        planUnavailable: false,
        planComplete: false,
        elapsedMs: 0,
      }),
    ).toBeUndefined();
  });
  it("fits pathological Unicode and punctuation to 72 code points", () => {
    const text = renderGoalFooter({
      state: { ...state(), planName: "!!!".repeat(100), status: "pursuing" },
      activeTask: { ...task, taskTitle: "🚀✨".repeat(100) },
      planUnavailable: false,
      planComplete: false,
      elapsedMs: 999999,
    });
    expect(Array.from(text ?? "").length).toBeLessThanOrEqual(
      WEAVE_GOAL_STATUS_MAX_WIDTH,
    );
    expect(text).toContain("…");
  });
  it("uses theme once and plain output remains equivalent", () => {
    let calls = 0;
    const theme = {
      fg: (v: string) => {
        calls++;
        return `<${v}>`;
      },
      bold: (v: string) => v,
    };
    const themed = renderGoalFooter({
      state: state(),
      activeTask: task,
      planUnavailable: false,
      planComplete: false,
      elapsedMs: 0,
      theme,
    });
    expect(calls).toBe(1);
    expect(themed).toContain("<");
  });
});
