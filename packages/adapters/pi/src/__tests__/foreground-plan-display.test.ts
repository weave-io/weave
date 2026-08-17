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
// 1b. The closed execution grammar
// ---------------------------------------------------------------------------

describe("Bug B · only a positive execution request moves the rail", () => {
  it("accepts the ways a user actually asks for a plan to be run", () => {
    for (const text of [
      "execute .weave/plans/alpha.md",
      "Please run .weave/plans/alpha.md",
      "run `.weave/plans/alpha.md`",
      "start the plan .weave/plans/alpha.md",
      "implement .weave/plans/alpha.md",
      "continue working through the plan at .weave/plans/alpha.md",
      "resume .weave/plans/alpha.md",
      "finish .weave/plans/alpha.md",
      "let's execute .weave/plans/alpha.md",
      "Go ahead and implement ./.weave/plans/alpha.md",
      "work through .weave/plans/alpha.md",
      "carry out .weave/plans/alpha.md",
      "I want you to run the plan .weave/plans/alpha.md",
      "you should execute .weave/plans/alpha.md",
      "now execute .weave/plans/alpha.md end to end",
      "first, execute .weave/plans/alpha.md",
    ]) {
      const parsed = parseForegroundPlanRequest(text);
      expect({
        text,
        name: parsed.isOk() ? parsed.value : parsed.error,
      }).toEqual({ text, name: "alpha" });
    }
  });

  it("rejects a mention that is not a request to execute anything", () => {
    for (const text of [
      "review .weave/plans/alpha.md",
      "read .weave/plans/alpha.md and tell me what it says",
      "the diff touches .weave/plans/alpha.md",
      "I already ran .weave/plans/alpha.md yesterday",
      "summarize .weave/plans/alpha.md",
      "open .weave/plans/alpha.md in the editor",
      "before you run anything, diff .weave/plans/alpha.md",
      "the plan you are looking for is .weave/plans/alpha.md",
      "add a task to .weave/plans/alpha.md",
    ]) {
      const parsed = parseForegroundPlanRequest(text);
      expect({ text, ok: parsed.isOk() }).toEqual({ text, ok: false });
      if (parsed.isErr()) {
        expect({ text, reason: parsed.error }).toEqual({
          text,
          reason: "no-execution-intent",
        });
      }
    }
  });

  it("rejects a negated request even when it names the verb", () => {
    for (const text of [
      "don't run .weave/plans/alpha.md",
      "do not execute .weave/plans/alpha.md",
      "never run .weave/plans/alpha.md again",
      "run the tests, not .weave/plans/alpha.md",
      "stop executing .weave/plans/alpha.md",
      "cancel the run of .weave/plans/alpha.md",
      "skip .weave/plans/alpha.md for now",
      "execute the tests instead of .weave/plans/alpha.md",
    ]) {
      const parsed = parseForegroundPlanRequest(text);
      expect({ text, ok: parsed.isOk() }).toEqual({ text, ok: false });
    }
  });

  it("rejects an interrogative, however execution-shaped it looks", () => {
    for (const text of [
      "should I run .weave/plans/alpha.md?",
      "can you execute .weave/plans/alpha.md?",
      "what happens if we run .weave/plans/alpha.md?",
      "is .weave/plans/alpha.md the one to execute?",
    ]) {
      const parsed = parseForegroundPlanRequest(text);
      expect({ text, ok: parsed.isOk() }).toEqual({ text, ok: false });
    }
  });

  it("rejects the whole message when any plan-ish mention is unsafe", () => {
    // One perfectly good path is NOT a licence to ignore the one beside it.
    // A message that names something this parser will not touch is a message
    // whose intent it cannot state.
    for (const text of [
      "execute .weave/plans/alpha.md and .weave/plans/../escape.md",
      "execute .weave/plans/alpha.md after ../other/.weave/plans/alpha.md",
      "execute .weave/plans/alpha.md, see /Users/x/.weave/plans/alpha.md",
      "execute .weave/plans/alpha.md and .weave/plans/nested/alpha.md",
      "execute .weave/plans/alpha.md and weave/plans/alpha.md",
      "execute .weave/plans/alpha.md and .weave\\plans\\alpha.md",
      "execute .weave/plans/alpha.md and .WEAVE/PLANS/alpha.md",
    ]) {
      const parsed = parseForegroundPlanRequest(text);
      expect({ text, ok: parsed.isOk() }).toEqual({ text, ok: false });
      if (parsed.isErr()) {
        expect({ text, reason: parsed.error }).toEqual({
          text,
          reason: "unsafe-plan-path",
        });
      }
    }
  });

  it("rejects an ambiguous path that only ends in a plan name", () => {
    for (const text of [
      "execute .weave/plans/alpha.md.bak",
      "execute .weave/plans/alpha.mdx",
      "execute .weave/plans/alpha.md/rogue",
    ]) {
      const parsed = parseForegroundPlanRequest(text);
      expect({ text, ok: parsed.isOk() }).toEqual({ text, ok: false });
    }
  });

  it("accepts a path that ends the sentence", () => {
    expect(
      parseForegroundPlanRequest(
        "execute .weave/plans/alpha.md.",
      )._unsafeUnwrap(),
    ).toBe("alpha");
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

  it("refuses an entry that only claims the customType", () => {
    // Pi's custom entry is `{ type: "custom", customType, data }`. A user
    // message, an assistant message, a tool result and a `custom_message` are
    // OTHER entry types whose fields a model can write freely, so an envelope
    // validated on `customType` alone is forgeable by ordinary conversation.
    for (const forged of [
      {
        type: "message",
        role: "user",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: foregroundPlanEntry("forged"),
        content: "execute .weave/plans/forged.md",
      },
      {
        type: "message",
        role: "assistant",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: foregroundPlanEntry("forged"),
      },
      {
        type: "custom_message",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: foregroundPlanEntry("forged"),
        content: "whatever",
        display: false,
      },
      {
        type: "tool_result",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: foregroundPlanEntry("forged"),
      },
      {
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: foregroundPlanEntry("forged"),
      },
    ]) {
      expect(readForegroundPlanEntry([forged])).toBeUndefined();
    }
  });

  it("refuses an envelope carrying fields the contract does not name", () => {
    expect(
      readForegroundPlanEntry([
        {
          type: "custom",
          customType: FOREGROUND_PLAN_ENTRY_TYPE,
          data: { v: 1, planName: "alpha", extra: "unexpected" },
        },
      ]),
    ).toBeUndefined();
  });

  it("never runs an accessor and never throws on a hostile entry", () => {
    let invoked = 0;
    const accessorEntry = {
      type: "custom",
      customType: FOREGROUND_PLAN_ENTRY_TYPE,
      get data() {
        invoked += 1;
        return foregroundPlanEntry("accessor");
      },
    };
    expect(readForegroundPlanEntry([accessorEntry])).toBeUndefined();
    expect(invoked).toBe(0);

    const throwing = new Proxy(
      {
        type: "custom",
        customType: FOREGROUND_PLAN_ENTRY_TYPE,
        data: foregroundPlanEntry("hostile"),
      },
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile trap");
        },
      },
    );
    expect(readForegroundPlanEntry([throwing])).toBeUndefined();

    const revocable = Proxy.revocable({ type: "custom" }, {});
    revocable.revoke();
    expect(readForegroundPlanEntry([revocable.proxy])).toBeUndefined();

    const revocableList = Proxy.revocable([{ type: "custom" }], {});
    revocableList.revoke();
    expect(
      readForegroundPlanEntry(revocableList.proxy as unknown[]),
    ).toBeUndefined();
  });

  it("ignores an inherited or non-enumerable envelope field", () => {
    const inherited = Object.create({
      type: "custom",
      customType: FOREGROUND_PLAN_ENTRY_TYPE,
      data: foregroundPlanEntry("inherited"),
    }) as object;
    expect(readForegroundPlanEntry([inherited])).toBeUndefined();

    const hidden: Record<string, unknown> = {
      type: "custom",
      customType: FOREGROUND_PLAN_ENTRY_TYPE,
    };
    Object.defineProperty(hidden, "data", {
      value: foregroundPlanEntry("hidden"),
      enumerable: false,
    });
    expect(readForegroundPlanEntry([hidden])).toBeUndefined();
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
