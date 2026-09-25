import { describe, expect, it } from "bun:test";
import {
  builtinAgentDelegations,
  categoryShuttleShare,
  categoryShuttleSuccess,
  configurationFailures,
  delegations,
  planTaskDelegation,
  recoveredFailures,
  transientFailures,
} from "../delegation-metrics.js";
import {
  type AuditDataset,
  OpenCodeV1SessionStore,
  OpenCodeV2SessionStore,
} from "../session-store.js";
import { V1Store, V2Store, WINDOW } from "./store-fixtures.js";

const START_WORK =
  "You are being activated by the /start-work command to execute a Weave plan.";

function read(store: V1Store): AuditDataset {
  return new OpenCodeV1SessionStore(store.db).read(WINDOW)._unsafeUnwrap();
}

describe("delegations", () => {
  it("counts every delegation by status", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "s1" })
        .assistant("s1", "loom", [
          { target: "shuttle" },
          { target: "pattern", status: "error", error: "Task cancelled" },
          { target: "weft", status: "running" },
        ]),
    );
    expect(delegations(dataset)).toEqual({
      total: 3,
      completed: 1,
      error: 1,
      running: 1,
    });
  });
});

describe("configurationFailures", () => {
  it("counts missing models, unknown agents and aborted-free calls without a target", () => {
    const dataset = read(
      new V1Store().session({ id: "s1" }).assistant("s1", "loom", [
        {
          target: "shuttle-api",
          status: "error",
          error: "Model not found: claude-sonnet-4-5/.",
        },
        {
          target: "shuttle-ui",
          status: "error",
          error: "Unknown agent type: shuttle-ui is not a valid agent type",
        },
        { status: "error", error: "Invalid input: subagent_type required" },
        { status: "error", error: "Tool execution aborted" },
        { target: "shuttle", status: "error", error: "Task cancelled" },
        { target: "shuttle" },
      ]),
    );
    expect(configurationFailures(dataset)).toEqual({ count: 3, total: 6 });
  });
});

describe("categoryShuttleSuccess", () => {
  it("divides completed category-shuttle delegations by all of them", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "s1" })
        .assistant("s1", "tapestry", [
          { target: "shuttle-api" },
          { target: "shuttle-ui", status: "error", error: "Model not found" },
          { target: "shuttle" },
        ]),
    );
    expect(categoryShuttleSuccess(dataset)).toEqual({ count: 1, total: 2 });
  });
});

describe("categoryShuttleShare", () => {
  const store = (): V1Store =>
    new V1Store()
      .session({ id: "a", directory: "/home/dev/with-categories" })
      .assistant("a", "loom", [
        { target: "shuttle" },
        { target: "shuttle" },
        { target: "shuttle-api" },
        { target: "pattern" },
      ])
      .session({ id: "b", directory: "/home/dev/plain" })
      .assistant("b", "loom", [{ target: "shuttle" }]);

  it("counts only projects that define categories", () => {
    const share = categoryShuttleShare(
      read(store()),
      (dir) => dir === "/home/dev/with-categories",
    );
    expect(share).toEqual({ count: 1, total: 3, projects: 1 });
  });

  it("treats a project that used a category shuttle as defining categories", () => {
    const share = categoryShuttleShare(read(store()), () => false);
    expect(share).toEqual({ count: 1, total: 3, projects: 1 });
  });

  it("includes a project whose config declares categories it never used", () => {
    const share = categoryShuttleShare(read(store()), () => true);
    expect(share).toEqual({ count: 1, total: 4, projects: 2 });
  });
});

describe("builtinAgentDelegations", () => {
  it("counts delegations to explore and general", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "s1" })
        .assistant("s1", "loom", [
          { target: "explore" },
          { target: "explore" },
          { target: "general" },
          { target: "thread" },
        ]),
    );
    expect(builtinAgentDelegations(dataset)).toEqual({
      total: 3,
      byAgent: { explore: 2, general: 1 },
    });
  });
});

describe("transientFailures", () => {
  const reset = {
    target: "pattern",
    status: "error" as const,
    error: "Subagent failed (task_id: x): Connection reset by server",
  };

  it("counts a failure resent to the same target in the next message as recovered", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "s1" })
        .user("s1", "plan it")
        .assistant("s1", "loom", [reset])
        .assistant("s1", "loom", [{ target: "pattern" }]),
    );
    expect(transientFailures(dataset)).toEqual({ total: 1, recovered: 1 });
  });

  it("counts a resend later in the same message as recovered", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "s1" })
        .assistant("s1", "loom", [reset, { target: "pattern" }]),
    );
    expect(transientFailures(dataset)).toEqual({ total: 1, recovered: 1 });
  });

  it("does not count a resend that failed again", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "s1" })
        .assistant("s1", "loom", [reset])
        .assistant("s1", "loom", [
          { target: "pattern", status: "error", error: "Task cancelled" },
        ]),
    );
    expect(transientFailures(dataset)).toEqual({ total: 1, recovered: 0 });
  });

  it("does not count a delegation to another agent, or one two user turns later", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "s1" })
        .assistant("s1", "loom", [reset])
        .assistant("s1", "loom", [{ target: "shuttle" }])
        .user("s1", "next")
        .assistant("s1", "loom", [])
        .user("s1", "and again")
        .assistant("s1", "loom", [{ target: "pattern" }]),
    );
    expect(transientFailures(dataset)).toEqual({ total: 1, recovered: 0 });
  });

  it("accepts a resend in the turn after the next user message", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "s1" })
        .assistant("s1", "loom", [reset])
        .user("s1", "try again")
        .assistant("s1", "loom", [{ target: "pattern" }]),
    );
    expect(transientFailures(dataset)).toEqual({ total: 1, recovered: 1 });
  });
});

describe("recoveredFailures", () => {
  it("counts configuration failures sent on to shuttle, beside transient ones", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "s1" })
        .assistant("s1", "loom", [
          { target: "shuttle-api", status: "error", error: "Model not found" },
          { target: "weft", status: "error", error: "Subagent failed" },
          { target: "weft", status: "error", error: "Task cancelled" },
        ])
        .assistant("s1", "loom", [{ target: "shuttle" }]),
    );
    expect(recoveredFailures(dataset)).toEqual({
      recovered: 1,
      total: 3,
      transient: { count: 0, total: 1 },
      configuration: { count: 1, total: 1 },
      other: 1,
    });
  });
});

describe("planTaskDelegation", () => {
  it("counts Loom turns and Loom delegations after the plan command", () => {
    const dataset = read(
      new V1Store()
        .session({ id: "plan" })
        .user("plan", "make a plan")
        .assistant("plan", "loom", [{ target: "pattern" }])
        .user("plan", START_WORK)
        .assistant("plan", "tapestry", [{ target: "shuttle" }])
        .user("plan", "how is it going?")
        .assistant("plan", "loom", [{ target: "shuttle" }])
        .assistant("plan", "loom", [])
        .session({ id: "quiet" })
        .user("quiet", START_WORK)
        .assistant("quiet", "tapestry", [{ target: "shuttle" }])
        .session({ id: "no-plan" })
        .assistant("no-plan", "loom", [{ target: "shuttle" }]),
    );
    expect(planTaskDelegation(dataset)).toEqual({
      planSessions: 2,
      sessionsWithLoomTurns: 1,
      loomDelegationMessages: 1,
      sessionsWithLoomDelegation: 1,
    });
  });

  it("reads the same metric from an OpenCode V2 store", () => {
    const store = new V2Store()
      .session({ id: "plan" })
      .user(
        "plan",
        "You are being activated by /weave:start to execute a Weave plan.",
      )
      .assistant("plan", "tapestry", [{ target: "shuttle" }])
      .user("plan", "status?")
      .assistant("plan", "loom", [{ target: "shuttle" }]);
    const dataset = new OpenCodeV2SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(planTaskDelegation(dataset)).toEqual({
      planSessions: 1,
      sessionsWithLoomTurns: 1,
      loomDelegationMessages: 1,
      sessionsWithLoomDelegation: 1,
    });
  });
});
