/**
 * Bug B — the Plan Rail must show the plan a FOREGROUND execution is working
 * through, not only a durable workflow instance.
 *
 * `/weave:start` and a direct "execute `.weave/plans/<name>.md`" request both
 * run Tapestry in the parent session's own turn. Neither creates a workflow
 * instance, so the resolver had no identity to resolve and the rail printed
 * its agent row alone: no plan name, no task marks, no `┃ now`, no `┗ next`.
 *
 * Everything here is DISPLAY-ONLY state. The tests pin that as hard as they
 * pin the rendering: nothing in this path may start, resume, authorize, or
 * lease an execution, and nothing may be inferred from prose the user did not
 * write.
 */
import { describe, expect, it } from "bun:test";
import type { PlanTaskSnapshot } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import {
  type ActivePlanReadPort,
  resolveActivePlanView,
} from "../active-plan-ui-state.js";
import {
  FOREGROUND_PLAN_ENTRY_TYPE,
  foregroundPlanEntry,
  parseForegroundPlanRequest,
  readForegroundPlanEntry,
} from "../foreground-plan-display.js";
import {
  buildPlanRailFacts,
  renderPlanRailWidgetLines,
} from "../plan-render.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function snapshot(
  planName: string,
  states: readonly ("completed" | "in_progress" | "pending")[] = [
    "completed",
    "in_progress",
    "pending",
  ],
): PlanTaskSnapshot {
  return {
    planName,
    contentRevision: "rev-1",
    format: "markdown",
    totalParentCount: states.length,
    complete: states.every((state) => state === "completed"),
    parents: states.map((state, index) => ({
      id: `${index + 1}`,
      title: `Task ${index + 1}`,
      state,
      children: [],
    })),
  } as unknown as PlanTaskSnapshot;
}

interface PortProbe {
  readonly inspected: string[];
  readonly plansRead: string[];
  pointerReads: number;
}

function makePort(input: {
  readonly currentWorkflowInstanceId?: string;
  readonly foregroundPlanName?: string;
  readonly snapshots?: Readonly<Record<string, PlanTaskSnapshot>>;
  readonly status?: string;
  readonly slug?: string;
}): { port: ActivePlanReadPort; probe: PortProbe } {
  const probe: PortProbe = { inspected: [], plansRead: [], pointerReads: 0 };
  const snapshots = input.snapshots ?? {};
  const port: ActivePlanReadPort = {
    currentWorkflowInstanceId: input.currentWorkflowInstanceId,
    foregroundPlanName: input.foregroundPlanName,
    inspect: (workflowInstanceId) => {
      probe.inspected.push(workflowInstanceId);
      return okAsync({
        slug: input.slug ?? "durable-plan",
        status: input.status ?? "running",
      });
    },
    readPlanSnapshot: (planName) => {
      probe.plansRead.push(planName);
      const found = snapshots[planName];
      return found === undefined ? errAsync(new Error("no")) : okAsync(found);
    },
    readRecoveryPointer: () => {
      probe.pointerReads += 1;
      return okAsync(undefined);
    },
  };
  return { port, probe };
}

// ---------------------------------------------------------------------------
// 1. Strict parsing of a direct, explicit execution request
// ---------------------------------------------------------------------------

describe("Bug B · a direct plan-path request is parsed strictly", () => {
  it("accepts exactly one contained plan path in an explicit execution request", () => {
    const parsed = parseForegroundPlanRequest(
      "please execute .weave/plans/pi-weave-ui-redesign.md end to end",
    );
    expect(parsed.isOk()).toBe(true);
    expect(parsed._unsafeUnwrap()).toBe("pi-weave-ui-redesign");
  });

  it("accepts a backticked path and a leading ./", () => {
    expect(
      parseForegroundPlanRequest(
        "run `./.weave/plans/alpha-1.md`",
      )._unsafeUnwrap(),
    ).toBe("alpha-1");
  });

  it("rejects prose that names no plan path", () => {
    const parsed = parseForegroundPlanRequest(
      "execute the redesign plan we discussed",
    );
    expect(parsed.isErr()).toBe(true);
    expect(parsed._unsafeUnwrapErr()).toBe("no-plan-path");
  });

  it("rejects a plan path with no explicit execution request", () => {
    const parsed = parseForegroundPlanRequest(
      "what does .weave/plans/alpha.md say about task 3?",
    );
    expect(parsed.isErr()).toBe(true);
    expect(parsed._unsafeUnwrapErr()).toBe("no-execution-intent");
  });

  it("rejects two different plans in one message", () => {
    const parsed = parseForegroundPlanRequest(
      "execute .weave/plans/alpha.md then .weave/plans/beta.md",
    );
    expect(parsed.isErr()).toBe(true);
    expect(parsed._unsafeUnwrapErr()).toBe("multiple-plans");
  });

  it("accepts the same plan named twice", () => {
    expect(
      parseForegroundPlanRequest(
        "execute .weave/plans/alpha.md — yes, .weave/plans/alpha.md",
      )._unsafeUnwrap(),
    ).toBe("alpha");
  });

  it("rejects traversal and absolute escapes rather than parsing around them", () => {
    for (const text of [
      "execute .weave/plans/../../etc/passwd.md",
      "execute ../other-worktree/.weave/plans/alpha.md",
      "execute /Users/someone/other/.weave/plans/alpha.md",
      "execute .weave/plans/nested/alpha.md",
      "execute .weave/plans/alpha .md",
    ]) {
      const parsed = parseForegroundPlanRequest(text);
      expect({ text, ok: parsed.isOk() }).toEqual({ text, ok: false });
    }
  });

  it("rejects an unsafe plan basename instead of sanitizing it", () => {
    const parsed = parseForegroundPlanRequest(
      "execute .weave/plans/alpha$(rm -rf).md",
    );
    expect(parsed.isErr()).toBe(true);
  });

  it("rejects input beyond its bound rather than scanning it", () => {
    const parsed = parseForegroundPlanRequest(
      `execute .weave/plans/alpha.md ${"x".repeat(64_000)}`,
    );
    expect(parsed.isErr()).toBe(true);
    expect(parsed._unsafeUnwrapErr()).toBe("input-too-long");
  });
});

// ---------------------------------------------------------------------------
// 2. Reconstruction from the adapter-owned session entry
// ---------------------------------------------------------------------------

describe("Bug B · restart reconstructs only from the adapter-owned entry", () => {
  it("reads the newest valid foreground plan entry", () => {
    const entries = [
      {
        type: "custom",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: foregroundPlanEntry("alpha"),
      },
      {
        type: "message",
        role: "user",
        content: "execute .weave/plans/beta.md",
      },
      {
        type: "custom",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: foregroundPlanEntry("gamma"),
      },
    ];
    expect(readForegroundPlanEntry(entries)).toBe("gamma");
  });

  it("ignores model prose, assistant text and foreign custom entries", () => {
    const entries = [
      {
        type: "message",
        role: "user",
        content: "execute .weave/plans/alpha.md",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "starting .weave/plans/beta.md" }],
      },
      {
        type: "custom",
        customType: "weave.child.thread",
        data: { planName: "gamma" },
      },
    ];
    expect(readForegroundPlanEntry(entries)).toBeUndefined();
  });

  it("ignores a malformed or unsafe payload", () => {
    const entries = [
      {
        type: "custom",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: { v: 1, planName: "../escape" },
      },
      {
        type: "custom",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: { planName: "no-version" },
      },
      {
        type: "custom",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: "not-an-object",
      },
    ];
    expect(readForegroundPlanEntry(entries)).toBeUndefined();
  });

  it("bounds how many entries it will scan", () => {
    const noise = Array.from({ length: 10_000 }, () => ({
      type: "message",
      role: "user",
      content: "noise",
    }));
    const entries = [
      {
        type: "custom",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: foregroundPlanEntry("alpha"),
      },
      ...noise,
    ];
    // The newest entries are what a restart cares about; an ancient selection
    // beyond the scan bound is not reconstructed rather than scanned for.
    expect(readForegroundPlanEntry(entries)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Resolution authority
// ---------------------------------------------------------------------------

describe("Bug B · the foreground plan is the last display-only fallback", () => {
  it("resolves the foreground plan when no workflow and no pointer exist", async () => {
    const { port, probe } = makePort({
      foregroundPlanName: "pi-weave-ui-redesign",
      snapshots: { "pi-weave-ui-redesign": snapshot("pi-weave-ui-redesign") },
    });
    const view = (await resolveActivePlanView(port))._unsafeUnwrap();

    expect(view.kind).toBe("active");
    if (view.kind !== "active") return;
    expect(view.planName).toBe("pi-weave-ui-redesign");
    expect(view.identity.source).toBe("foreground");
    expect(view.activeTask?.taskTitle).toBe("Task 2");
    // Display-only: no workflow was inspected for it.
    expect(probe.inspected).toEqual([]);
  });

  it("keeps a durable workflow above the foreground plan", async () => {
    const { port, probe } = makePort({
      currentWorkflowInstanceId: "wf-1",
      foregroundPlanName: "foreground-plan",
      slug: "durable-plan",
      snapshots: {
        "durable-plan": snapshot("durable-plan"),
        "foreground-plan": snapshot("foreground-plan"),
      },
    });
    const view = (await resolveActivePlanView(port))._unsafeUnwrap();

    expect(view.kind).toBe("active");
    if (view.kind !== "active") return;
    expect(view.planName).toBe("durable-plan");
    expect(view.identity.source).toBe("current");
    expect(probe.plansRead).toEqual(["durable-plan"]);
  });

  it("clears when the foreground plan has no incomplete task left", async () => {
    const { port } = makePort({
      foregroundPlanName: "done-plan",
      snapshots: {
        "done-plan": snapshot("done-plan", ["completed", "completed"]),
      },
    });
    const view = (await resolveActivePlanView(port))._unsafeUnwrap();

    expect(view.kind).toBe("empty");
    if (view.kind !== "empty") return;
    expect(view.reason).toBe("foreground-plan-complete");
  });

  it("shows identity only when the plan cannot be read in this project root", async () => {
    const { port } = makePort({
      foregroundPlanName: "other-worktree-plan",
      snapshots: {},
    });
    const view = (await resolveActivePlanView(port))._unsafeUnwrap();

    expect(view.kind).toBe("empty");
    // The rail then renders the agent row alone rather than reading elsewhere.
    const facts = buildPlanRailFacts({
      agentName: "loom",
      cycleCandidateCount: 3,
      snapshot: undefined,
      activeTask: undefined,
    });
    expect(renderPlanRailWidgetLines(facts, 120)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The rendered rail
// ---------------------------------------------------------------------------

describe("Bug B · the rail renders the prototype tiers from a foreground plan", () => {
  it("renders the header, marks, now and next rows", async () => {
    const { port } = makePort({
      foregroundPlanName: "pi-weave-ui-redesign",
      snapshots: { "pi-weave-ui-redesign": snapshot("pi-weave-ui-redesign") },
    });
    const view = (await resolveActivePlanView(port))._unsafeUnwrap();
    expect(view.kind).toBe("active");
    if (view.kind !== "active") return;

    const rows = renderPlanRailWidgetLines(
      buildPlanRailFacts({
        agentName: "tapestry",
        cycleCandidateCount: 3,
        snapshot: view.snapshot,
        activeTask: view.activeTask,
      }),
      120,
    ).map((row) => row.replace(/\s+$/u, ""));

    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("◆ WEAVE · TAPESTRY");
    expect(rows[0]).toContain("Alt+A cycle");
    expect(rows[0]).toContain("pi-weave-ui-redesign");
    expect(rows[1]).toContain("● ◐ ○");
    expect(rows[1]).toContain("2/3");
    expect(rows[2]).toContain("┃ now   Task 2");
    expect(rows[3]).toContain("┗ next  Task 3");
  });
});
