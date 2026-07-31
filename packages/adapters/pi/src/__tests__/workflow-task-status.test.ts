import { describe, expect, it } from "bun:test";
import type { ActivePlanTask } from "@weaveio/weave-engine";
import {
  renderWorkflowTaskFooter,
  WEAVE_WORKFLOW_TASK_STATUS_KEY,
  WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH,
} from "../workflow-task-status.js";

const task: ActivePlanTask = {
  parentIndex: 0,
  parentOrdinal: 2,
  totalParentCount: 5,
  taskId: "3",
  taskTitle: "Write the adapter tests",
  taskState: "in_progress",
  isChild: false,
  parentId: "3",
  parentTitle: "Write the adapter tests",
};

describe("workflow-task-status (durable workflow current-task footer)", () => {
  it("uses its own dedicated status key", () => {
    expect(WEAVE_WORKFLOW_TASK_STATUS_KEY).toBe("weave-task");
  });

  it("renders the ordinal, total, task ID and title", () => {
    expect(renderWorkflowTaskFooter({ activeTask: task })).toBe(
      "▸ task 2/5 · 3. Write the adapter tests",
    );
  });

  it("clears the footer when no task is active", () => {
    expect(renderWorkflowTaskFooter({ activeTask: undefined })).toBeUndefined();
  });

  it("collapses whitespace in a multi-line task title", () => {
    expect(
      renderWorkflowTaskFooter({
        activeTask: { ...task, taskTitle: "  Write\n\tthe   tests  " },
      }),
    ).toBe("▸ task 2/5 · 3. Write the tests");
  });

  it("keeps a pathological Unicode title within the width cap", () => {
    const text = renderWorkflowTaskFooter({
      activeTask: { ...task, taskTitle: "🚀✨".repeat(200) },
    });
    expect(Array.from(text ?? "")).toHaveLength(
      WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH,
    );
    expect(text).toContain("…");
  });

  it("bounds the whole footer when the task ID itself is enormous", () => {
    const text = renderWorkflowTaskFooter({
      activeTask: {
        ...task,
        taskId: "9".repeat(80),
        taskTitle: "dropped entirely",
      },
    });
    // The prefix alone exhausts the budget, so the footer as a whole is
    // truncated rather than allowed to grow past its cap.
    expect(Array.from(text ?? "")).toHaveLength(
      WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH,
    );
    expect(text).not.toContain("dropped entirely");
    expect(text?.startsWith("▸ task 2/5 · ")).toBe(true);
    expect(text?.endsWith("…")).toBe(true);
    expect(Array.from(text ?? "").filter((c) => c === "…")).toHaveLength(1);
  });

  it("bounds the whole footer when the ordinal and total are pathological", () => {
    const text = renderWorkflowTaskFooter({
      activeTask: {
        ...task,
        parentOrdinal: Number("9".repeat(15)),
        totalParentCount: Number("8".repeat(15)),
        taskId: "7".repeat(60),
        taskTitle: "x".repeat(400),
      },
    });
    expect(Array.from(text ?? "")).toHaveLength(
      WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH,
    );
    expect(Array.from(text ?? "").filter((c) => c === "…")).toHaveLength(1);
    expect(text?.startsWith("▸ task ")).toBe(true);
  });

  it("bounds every pathological combination of ID, counts and title", () => {
    const sizes = [0, 1, 5, 40, 55, 56, 57, 200];
    for (const idSize of sizes) {
      for (const titleSize of sizes) {
        const text = renderWorkflowTaskFooter({
          activeTask: {
            ...task,
            parentOrdinal: 123456789,
            totalParentCount: 987654321,
            taskId: "i".repeat(idSize),
            taskTitle: "t".repeat(titleSize),
          },
        });
        expect(Array.from(text ?? "").length).toBeLessThanOrEqual(
          WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH,
        );
      }
    }
  });

  it("omits the title separator when the title is empty or whitespace", () => {
    expect(
      renderWorkflowTaskFooter({ activeTask: { ...task, taskTitle: "" } }),
    ).toBe("▸ task 2/5 · 3");
    expect(
      renderWorkflowTaskFooter({
        activeTask: { ...task, taskTitle: "  \n\t " },
      }),
    ).toBe("▸ task 2/5 · 3");
  });

  it("drops the ID separator when the task ID is empty or whitespace", () => {
    expect(
      renderWorkflowTaskFooter({ activeTask: { ...task, taskId: "   " } }),
    ).toBe("▸ task 2/5 · Write the adapter tests");
    expect(
      renderWorkflowTaskFooter({
        activeTask: { ...task, taskId: "", taskTitle: "" },
      }),
    ).toBe("▸ task 2/5");
  });

  it("applies the accent foreground exactly once when a theme is supplied", () => {
    let calls = 0;
    const themed = renderWorkflowTaskFooter({
      activeTask: task,
      theme: {
        fg: (token: string, value: string) => {
          calls += 1;
          expect(token).toBe("accent");
          return `<${value}>`;
        },
        bold: (value: string) => value,
      },
    });
    expect(calls).toBe(1);
    expect(themed).toBe("<▸ task 2/5 · 3. Write the adapter tests>");
  });

  it("does not theme a cleared footer", () => {
    let calls = 0;
    expect(
      renderWorkflowTaskFooter({
        activeTask: undefined,
        theme: {
          fg: (_token: string, value: string) => {
            calls += 1;
            return value;
          },
          bold: (value: string) => value,
        },
      }),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });
});
