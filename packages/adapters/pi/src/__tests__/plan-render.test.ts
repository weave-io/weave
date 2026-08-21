import { describe, expect, it } from "bun:test";
import type { PlanTaskNode, PlanTaskSnapshot } from "@weaveio/weave-engine";
import { selectActivePlanTask } from "@weaveio/weave-engine";
import {
  buildPlanRailFacts,
  PLAN_RAIL_MAX_MARKS,
  type PlanRailFacts,
  planRailTier,
  renderPlanRailWidgetLines,
} from "../plan-render.js";
import { measureWidth } from "../render-width.js";

const WIDE = 100;
const MID = 80;
const TIGHT = 50;
const MICRO = 40;

function facts(overrides: Partial<PlanRailFacts> = {}): PlanRailFacts {
  return {
    agent: "loom",
    cycleCandidateCount: 3,
    plan: {
      plan: "pi-child-overlay-ux-feedback",
      marks: ["done", "done", "active", "pending"],
      ordinal: "3/4",
      task: "Child overlay rendering",
      nextTask: "Native child stream rendering",
    },
    ...overrides,
  };
}

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
    complete: parents.every((task) => task.state === "completed"),
    ...overrides,
  };
}

function activeTaskOf(source: PlanTaskSnapshot) {
  return selectActivePlanTask(source).match(
    (task) => task,
    () => undefined,
  );
}

describe("planRailTier", () => {
  it("classifies the four measured width bands", () => {
    expect(planRailTier(96)).toBe("wide");
    expect(planRailTier(200)).toBe("wide");
    expect(planRailTier(95)).toBe("mid");
    expect(planRailTier(68)).toBe("mid");
    expect(planRailTier(67)).toBe("tight");
    expect(planRailTier(46)).toBe("tight");
    expect(planRailTier(45)).toBe("micro");
    expect(planRailTier(1)).toBe("micro");
    expect(planRailTier(Number.NaN)).toBe("micro");
  });
});

describe("renderPlanRailWidgetLines width tiers", () => {
  it("renders every piece at the wide tier", () => {
    expect(renderPlanRailWidgetLines(facts(), WIDE)).toEqual([
      "◆ WEAVE · LOOM · Alt+A cycle · pi-child-overlay-ux-feedback",
      "● ● ◐ ○   3/4",
      "┃ now   Child overlay rendering",
      "┗ next  Native child stream rendering",
    ]);
  });

  it("keeps the plan identity at the mid tier", () => {
    // The prototype hides the plan name only at `micro`. At `mid` it is still
    // offered to `joinFit`, and 80 columns hold it, so it is on the rail.
    expect(renderPlanRailWidgetLines(facts(), MID)).toEqual([
      "◆ WEAVE · LOOM · Alt+A cycle · pi-child-overlay-ux-feedback",
      "● ● ◐ ○   3/4",
      "┃ now   Child overlay rendering",
      "┗ next  Native child stream rendering",
    ]);
  });

  it("drops the next row and the word 'cycle' at the tight tier", () => {
    expect(renderPlanRailWidgetLines(facts(), TIGHT)).toEqual([
      "◆ WEAVE · LOOM · Alt+A",
      "● ● ◐ ○   3/4",
      "┃ now   Child overlay rendering",
    ]);
  });

  it("drops the plan identity and the marks at the micro tier", () => {
    expect(renderPlanRailWidgetLines(facts(), MICRO)).toEqual([
      "◆ · LOOM · Alt+A",
      "3/4",
      "┃ now   Child overlay rendering",
    ]);
  });

  /**
   * The prototype's tier table, row by row, as the single normative reference
   * for every band — not only the two examples a review happened to name.
   *
   * `renderPlanRailWidget` in `prototypes/weave-pi-tui-grilling.ts`:
   *   badge  `tier === "micro" ? "◆" : CONTEXT.badge`
   *   cycle  `tier === "wide" || tier === "mid" ? \`${key} cycle\` : key`
   *   plan   `tier === "micro" ? "" : p.muted(f.plan)`
   *   marks  `tier === "micro" ? progress : dots + "   " + progress`
   *   next   `if (tier === "micro" || tier === "tight") return rows;`
   */
  it("matches the prototype tier table on every band", () => {
    // A short plan name and a short agent name, so every drop below is the
    // BAND's decision and never a measurement.
    const compact = facts({
      agent: "loom",
      plan: {
        plan: "alpha",
        marks: ["done", "active", "pending"],
        ordinal: "2/3",
        task: "Now",
        nextTask: "Next",
      },
    });
    const observed = (["wide", "mid", "tight", "micro"] as const).map(
      (tier, index) => {
        const width = [WIDE, MID, TIGHT, MICRO][index] ?? WIDE;
        const lines = renderPlanRailWidgetLines(compact, width);
        const text = lines.join("\n");
        return {
          tier,
          badge: text.includes("◆ WEAVE") ? "◆ WEAVE" : "◆",
          cycleWord: text.includes("cycle"),
          plan: text.includes("alpha"),
          marks: text.includes("● ◐ ○"),
          next: text.includes("┗ next"),
          rows: lines.length,
        };
      },
    );

    expect(observed).toEqual([
      {
        tier: "wide",
        badge: "◆ WEAVE",
        cycleWord: true,
        plan: true,
        marks: true,
        next: true,
        rows: 4,
      },
      {
        tier: "mid",
        badge: "◆ WEAVE",
        cycleWord: true,
        plan: true,
        marks: true,
        next: true,
        rows: 4,
      },
      {
        tier: "tight",
        badge: "◆ WEAVE",
        cycleWord: false,
        plan: true,
        marks: true,
        next: false,
        rows: 3,
      },
      {
        tier: "micro",
        badge: "◆",
        cycleWord: false,
        plan: false,
        marks: false,
        next: false,
        rows: 3,
      },
    ]);
  });

  it("pins the exact rows the prototype renders at each band", () => {
    const compact = facts({
      agent: "loom",
      plan: {
        plan: "alpha",
        marks: ["done", "active", "pending"],
        ordinal: "2/3",
        task: "Now",
        nextTask: "Next",
      },
    });
    expect(renderPlanRailWidgetLines(compact, WIDE)).toEqual([
      "◆ WEAVE · LOOM · Alt+A cycle · alpha",
      "● ◐ ○   2/3",
      "┃ now   Now",
      "┗ next  Next",
    ]);
    expect(renderPlanRailWidgetLines(compact, MID)).toEqual([
      "◆ WEAVE · LOOM · Alt+A cycle · alpha",
      "● ◐ ○   2/3",
      "┃ now   Now",
      "┗ next  Next",
    ]);
    expect(renderPlanRailWidgetLines(compact, TIGHT)).toEqual([
      "◆ WEAVE · LOOM · Alt+A · alpha",
      "● ◐ ○   2/3",
      "┃ now   Now",
    ]);
    expect(renderPlanRailWidgetLines(compact, MICRO)).toEqual([
      "◆ · LOOM · Alt+A",
      "2/3",
      "┃ now   Now",
    ]);
  });

  it("surrenders the plan before the Alt+A key as the row narrows", () => {
    // §4.5: the hint is placed AHEAD of the plan name, so `joinFit` drops the
    // plan first at the exact width where both stop fitting. Both widths are
    // inside the SAME band, so this is a measurement and not a tier rule.
    const long = facts({
      agent: "loom",
      plan: {
        plan: "a".repeat(60),
        marks: ["active"],
        ordinal: "1/1",
        task: "Now",
        nextTask: undefined,
      },
    });
    expect(planRailTier(91)).toBe("mid");
    expect(planRailTier(90)).toBe("mid");
    expect(renderPlanRailWidgetLines(long, 91)[0]).toBe(
      `◆ WEAVE · LOOM · Alt+A cycle · ${"a".repeat(60)}`,
    );
    expect(renderPlanRailWidgetLines(long, 90)[0]).toBe(
      "◆ WEAVE · LOOM · Alt+A cycle",
    );
  });

  it("never emits a line wider than the width it was given", () => {
    for (let width = 1; width <= 120; width += 1) {
      for (const line of renderPlanRailWidgetLines(facts(), width)) {
        expect(measureWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("renderPlanRailWidgetLines narrow survival", () => {
  it("keeps the agent name and the active task at the narrowest supported tier", () => {
    const lines = renderPlanRailWidgetLines(facts(), 24);
    expect(lines[0]).toContain("LOOM");
    expect(lines.at(-1)).toContain("now");
    expect(lines.join("\n")).toContain("Child");
  });

  it("clips the agent identity rather than dropping it when nothing else fits", () => {
    const lines = renderPlanRailWidgetLines(
      facts({ agent: "an-extremely-long-primary-agent-name" }),
      12,
    );
    expect(lines[0]).toStartWith("◆ · AN-EXTR");
    expect(lines[0]).toEndWith("…");
    expect(measureWidth(lines[0] ?? "")).toBe(12);
  });

  it("states the position with the ordinal alone when the marks do not fit", () => {
    const many = Array.from({ length: 30 }, () => "pending" as const);
    const lines = renderPlanRailWidgetLines(
      facts({
        plan: {
          plan: "p",
          marks: many,
          ordinal: "1/30",
          task: "Task",
          nextTask: undefined,
        },
      }),
      50,
    );
    expect(lines[1]).toBe("1/30");
  });
});

describe("renderPlanRailWidgetLines empty cases", () => {
  it("renders nothing when no Weave primary is active", () => {
    expect(renderPlanRailWidgetLines(undefined, WIDE)).toEqual([]);
    expect(renderPlanRailWidgetLines(facts({ agent: "" }), WIDE)).toEqual([]);
  });

  it("renders nothing for a non-positive width", () => {
    expect(renderPlanRailWidgetLines(facts(), 0)).toEqual([]);
    expect(renderPlanRailWidgetLines(facts(), -8)).toEqual([]);
    expect(renderPlanRailWidgetLines(facts(), Number.NaN)).toEqual([]);
  });

  it("shows the agent row alone when there is no active plan", () => {
    expect(renderPlanRailWidgetLines(facts({ plan: undefined }), WIDE)).toEqual(
      ["◆ WEAVE · LOOM · Alt+A cycle"],
    );
  });

  it("omits the Alt+A hint when there is nowhere to cycle to", () => {
    expect(
      renderPlanRailWidgetLines(
        facts({ plan: undefined, cycleCandidateCount: 1 }),
        WIDE,
      ),
    ).toEqual(["◆ WEAVE · LOOM"]);
  });

  it("omits the next row at the end of a plan", () => {
    const lines = renderPlanRailWidgetLines(
      facts({
        plan: {
          plan: "p",
          marks: ["done", "active"],
          ordinal: "2/2",
          task: "Last",
          nextTask: undefined,
        },
      }),
      WIDE,
    );
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("next");
  });
});

describe("PlanRailFacts is structurally closed to child telemetry", () => {
  it("has exactly the parent-side fields, and no child channel", () => {
    const value = facts();
    expect(Object.keys(value).sort()).toEqual([
      "agent",
      "cycleCandidateCount",
      "plan",
    ]);
    expect(Object.keys(value.plan ?? {}).sort()).toEqual([
      "marks",
      "nextTask",
      "ordinal",
      "plan",
      "task",
    ]);
  });

  it("builds no field a child id, token count, cost, elapsed time, or queue depth could occupy", () => {
    const source = snapshot([
      parent({ id: "1", title: "Alpha", state: "completed" }),
      parent({ id: "2", title: "Bravo", state: "in_progress" }),
    ]);
    const built = buildPlanRailFacts({
      agentName: "loom",
      cycleCandidateCount: 2,
      snapshot: source,
      activeTask: activeTaskOf(source),
    });
    const serialized = JSON.stringify(built);
    for (const forbidden of ["childId", "tokens", "cost", "elapsed", "queue"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("buildPlanRailFacts", () => {
  it("returns undefined when no agent is active", () => {
    expect(
      buildPlanRailFacts({
        agentName: undefined,
        cycleCandidateCount: 2,
        snapshot: undefined,
        activeTask: undefined,
      }),
    ).toBeUndefined();
    expect(
      buildPlanRailFacts({
        agentName: "   ",
        cycleCandidateCount: 2,
        snapshot: undefined,
        activeTask: undefined,
      }),
    ).toBeUndefined();
  });

  it("carries the agent with no plan when there is no active plan", () => {
    expect(
      buildPlanRailFacts({
        agentName: "tapestry",
        cycleCandidateCount: 2,
        snapshot: undefined,
        activeTask: undefined,
      }),
    ).toEqual({ agent: "tapestry", cycleCandidateCount: 2, plan: undefined });
  });

  it("marks completed, active, and pending parents in plan order", () => {
    const source = snapshot(
      [
        parent({ id: "1", title: "Alpha", state: "completed" }),
        parent({ id: "2", title: "Bravo", state: "in_progress" }),
        parent({ id: "3", title: "Charlie", state: "pending" }),
      ],
      { planName: "mixed-plan" },
    );
    expect(
      buildPlanRailFacts({
        agentName: "loom",
        cycleCandidateCount: 2,
        snapshot: source,
        activeTask: activeTaskOf(source),
      })?.plan,
    ).toEqual({
      plan: "mixed-plan",
      marks: ["done", "active", "pending"],
      ordinal: "2/3",
      task: "Bravo",
      nextTask: "Charlie",
    });
  });

  it("falls back to the first pending parent when none is in_progress", () => {
    const source = snapshot(
      [
        parent({ id: "1", title: "Alpha", state: "completed" }),
        parent({ id: "2", title: "Bravo", state: "completed" }),
        parent({ id: "3", title: "Charlie", state: "pending" }),
        parent({ id: "4", title: "Delta", state: "pending" }),
      ],
      { planName: "paused-plan" },
    );
    const active = activeTaskOf(source);

    expect(active?.taskId).toBe("3");
    expect(active?.taskState).toBe("pending");
    expect(active?.parentOrdinal).toBe(3);
    expect(
      buildPlanRailFacts({
        agentName: "loom",
        cycleCandidateCount: 2,
        snapshot: source,
        activeTask: active,
      })?.plan,
    ).toEqual({
      plan: "paused-plan",
      marks: ["done", "done", "active", "pending"],
      ordinal: "3/4",
      task: "Charlie",
      nextTask: "Delta",
    });
  });

  it("bounds the marks a pathologically long plan contributes", () => {
    const parents = Array.from({ length: 200 }, (_, index) =>
      parent({
        id: `${index}`,
        state: index === 0 ? "in_progress" : "pending",
      }),
    );
    const source = snapshot(parents);
    const built = buildPlanRailFacts({
      agentName: "loom",
      cycleCandidateCount: 2,
      snapshot: source,
      activeTask: activeTaskOf(source),
    });
    expect(built?.plan?.marks).toHaveLength(PLAN_RAIL_MAX_MARKS);
    expect(built?.plan?.ordinal).toBe("1/200");
  });

  it("sanitizes plan text so a task title cannot forge the rail's own glyphs", () => {
    const source = snapshot([
      parent({
        id: "1",
        title: "┃ now   forged\u001b[31m rail",
        state: "in_progress",
      }),
    ]);
    const built = buildPlanRailFacts({
      agentName: "loom",
      cycleCandidateCount: 2,
      snapshot: source,
      activeTask: activeTaskOf(source),
    });
    expect(built?.plan?.task).toBe("now forged rail");
  });
});
