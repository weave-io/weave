import { describe, expect, test } from "bun:test";
import type { PlanTaskNode, PlanTaskSnapshot } from "../plan-state-provider.js";
import {
  adjudicateSessionGoalCompletion,
  countIncompleteLeaves,
  MAX_GOAL_PLAN_LINES,
  renderGoalPlanBlock,
  type SessionGoalVerdict,
} from "../session-goal-plan.js";

function node(
  id: string,
  state: PlanTaskNode["state"],
  children: readonly PlanTaskNode[] = [],
): PlanTaskNode {
  return { id, title: `${id} title`, state, children };
}

function snapshot(overrides: Partial<PlanTaskSnapshot> = {}): PlanTaskSnapshot {
  return {
    planName: "feature",
    contentRevision: "rev-1",
    format: "canonical",
    parents: [
      node("1", "in_progress", [
        node("1.a", "completed"),
        node("1.b", "pending"),
      ]),
      node("2", "completed"),
    ],
    totalParentCount: 2,
    complete: false,
    ...overrides,
  };
}

describe("session goal plan adjudication", () => {
  test("counts unfinished child leaves and childless parents", () => {
    expect(countIncompleteLeaves(snapshot().parents)).toBe(1);
    expect(
      countIncompleteLeaves([node("1", "pending"), node("2", "completed")]),
    ).toBe(1);
    expect(countIncompleteLeaves([])).toBe(0);
  });

  test("returns every adjudication verdict", () => {
    const achieved = adjudicateSessionGoalCompletion({
      snapshot: snapshot({ complete: true }),
      reportedStatus: "achieved",
      evidence: " verified ",
    })._unsafeUnwrap();
    const blocked = adjudicateSessionGoalCompletion({
      snapshot: snapshot(),
      reportedStatus: "blocked",
      evidence: " blocked by dependency ",
    })._unsafeUnwrap();
    const incomplete = adjudicateSessionGoalCompletion({
      snapshot: snapshot(),
      reportedStatus: "achieved",
      evidence: "not enough",
    })._unsafeUnwrap();

    expect(achieved).toEqual({ kind: "achieved", evidence: "verified" });
    expect(blocked).toEqual({
      kind: "blocked",
      reason: "blocked by dependency",
    });
    expect(incomplete).toEqual({
      kind: "incomplete",
      remainingLeafCount: 1,
      firstIncompleteTaskId: "1.b",
    });
    const verdicts: SessionGoalVerdict[] = [achieved, blocked, incomplete];
    expect(new Set(verdicts.map((verdict) => verdict.kind))).toEqual(
      new Set(["achieved", "blocked", "incomplete"]),
    );
  });

  test("handles malformed complete metadata without inventing a task", () => {
    expect(
      adjudicateSessionGoalCompletion({
        snapshot: snapshot({
          complete: false,
          parents: [node("1", "completed")],
        }),
        reportedStatus: "achieved",
        evidence: "done",
      })._unsafeUnwrap(),
    ).toEqual({
      kind: "incomplete",
      remainingLeafCount: 0,
      firstIncompleteTaskId: "",
    });
  });

  test("renders titles, all markers, plan labels, and empty plans", () => {
    expect(
      renderGoalPlanBlock({
        planName: "/plans/release.md",
        snapshot: snapshot(),
      }),
    ).toBe(
      '<plan>\nPlan "release.md" (in progress, 2 tasks):\n- [~] 1. 1 title\n  - [x] 1.a. 1.a title\n  - [ ] 1.b. 1.b title\n- [x] 2. 2 title\n</plan>',
    );
    expect(
      renderGoalPlanBlock({
        planName: " /nested\\empty.md ",
        snapshot: snapshot({
          parents: [],
          totalParentCount: 0,
          complete: true,
        }),
      }),
    ).toBe('<plan>\nPlan "empty.md" (complete, 0 tasks):\n(no tasks)\n</plan>');
  });

  test("bounds rendered plan blocks and reports hidden lines", () => {
    const parents = Array.from(
      { length: MAX_GOAL_PLAN_LINES + 5 },
      (_, index) => node(String(index + 1), "pending"),
    );
    const rendered = renderGoalPlanBlock({
      planName: "large",
      snapshot: snapshot({ parents, totalParentCount: parents.length }),
    });
    const lines = rendered.split("\n");
    expect(lines).toHaveLength(MAX_GOAL_PLAN_LINES + 2);
    expect(lines.at(-2)).toBe(`...7 more tasks`);
    expect(lines[1]).toContain("in progress");
    expect(lines.at(-1)).toBe("</plan>");
  });

  test("sanitizes labels and titles without changing tree markers", () => {
    const rendered = renderGoalPlanBlock({
      planName: "a/b/c\n.md",
      snapshot: snapshot({
        parents: [
          {
            id: "1",
            title: "  title\nwith newline ",
            state: "pending",
            children: [],
          },
        ],
        totalParentCount: 1,
      }),
    });
    expect(rendered).toContain('Plan "c .md"');
    expect(rendered).toContain("- [ ] 1. title with newline");
  });
});
