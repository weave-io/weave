import { describe, expect, it } from "bun:test";
import {
  MAX_PLAN_TASKS,
  MAX_PLAN_TITLE_LENGTH,
  parsePlanTasks,
} from "../plan-task-parser.js";

const parse = (markdown: string) =>
  parsePlanTasks({
    planName: "release",
    contentRevision: "a".repeat(64),
    markdown,
  });

describe("parsePlanTasks", () => {
  it("parses canonical flat and two-level plans in source order", () => {
    const result = parse(
      "- [x] 1. Done\n- [ ] 2. Parent\n  - [-] a. Active\n  - [ ] b. Next",
    )._unsafeUnwrap();
    expect(result.parents.map((task) => task.id)).toEqual(["1", "2"]);
    expect(result.parents[1]?.children.map((task) => task.id)).toEqual([
      "2.a",
      "2.b",
    ]);
    expect(result.completedTaskCount).toBe(1);
  });

  it("parses heading and legacy forms while ignoring fenced examples and field prose", () => {
    const heading = parse(
      "```md\n- [ ] 1. Fake\n```\n### Task 1 — Build\n- [x] **What**: done\n### Task 2: Ship\n- [ ] **What**: pending",
    )._unsafeUnwrap();
    expect(heading.parents.map((task) => task.title)).toEqual([
      "Build",
      "Ship",
    ]);
    expect(heading.parents[0]?.state).toBe("completed");
    const legacy = parse("- [-] Parent\n  - [x] Child")._unsafeUnwrap();
    expect(legacy.format).toBe("legacy");
    expect(legacy.parents[0]?.children[0]?.title).toBe("Child");
  });

  it("rejects malformed IDs, excessive titles, and excessive task counts", () => {
    expect(parse("- [ ] 2. Wrong")._unsafeUnwrapErr().type).toBe(
      "PlanMalformed",
    );
    expect(
      parse(
        `- [ ] 1. ${"x".repeat(MAX_PLAN_TITLE_LENGTH + 1)}`,
      )._unsafeUnwrapErr().type,
    ).toBe("PlanLimitExceeded");
    expect(parse("- [ ] 1. unsafe\u001b[31m")._unsafeUnwrapErr().type).toBe(
      "PlanMalformed",
    );
    const tasks = Array.from(
      { length: MAX_PLAN_TASKS + 1 },
      (_, index) => `- [ ] ${index + 1}. Task`,
    ).join("\n");
    expect(parse(tasks)._unsafeUnwrapErr().type).toBe("PlanLimitExceeded");
  });

  it("returns a complete empty snapshot without mutating source", () => {
    const source = "No tasks here.";
    const result = parse(source)._unsafeUnwrap();
    expect(result.parents).toEqual([]);
    expect(result.complete).toBe(true);
    expect(source).toBe("No tasks here.");
  });
});
