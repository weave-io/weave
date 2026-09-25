import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  OpenCodeV1SessionStore,
  OpenCodeV2SessionStore,
} from "../session-store.js";
import { DAY, HOUR, V1Store, V2Store, WINDOW } from "./store-fixtures.js";

describe("OpenCode V1 session store", () => {
  it("reads task parts as delegations with target, status and error", () => {
    const store = new V1Store()
      .session({ id: "s1" })
      .user("s1", "hello")
      .assistant("s1", "loom", [
        { target: "shuttle" },
        {
          target: "shuttle-api",
          status: "error",
          error: "Model not found: x/.",
        },
      ]);
    const dataset = new OpenCodeV1SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(
      dataset.delegations.map(({ target, status, error, index }) => ({
        target,
        status,
        error,
        index,
      })),
    ).toEqual([
      { target: "shuttle", status: "completed", error: null, index: 0 },
      {
        target: "shuttle-api",
        status: "error",
        error: "Model not found: x/.",
        index: 1,
      },
    ]);
    expect(dataset.messages.map((m) => [m.role, m.agent])).toEqual([
      ["user", "loom"],
      ["assistant", "loom"],
    ]);
  });

  it("excludes sessions under /tmp/ and counts them", () => {
    const store = new V1Store()
      .session({ id: "kept" })
      .session({ id: "tmp", directory: "/tmp/fleet-test" })
      .assistant("tmp", "loom", [{ target: "shuttle" }]);
    const dataset = new OpenCodeV1SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(dataset.sessions.map((s) => s.id)).toEqual(["kept"]);
    expect(dataset.delegations).toEqual([]);
    expect(dataset.excludedTmpSessions).toBe(1);
  });

  it("selects sessions by creation time, since inclusive and until exclusive", () => {
    const store = new V1Store()
      .session({ id: "at-since", time: WINDOW.since })
      .session({ id: "at-until", time: WINDOW.until })
      .session({ id: "before", time: WINDOW.since - HOUR });
    const dataset = new OpenCodeV1SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(dataset.sessions.map((s) => s.id)).toEqual(["at-since"]);
  });

  it("keeps only sessions in or below the --project directory", () => {
    const store = new V1Store()
      .session({ id: "root", directory: "/home/dev/app" })
      .session({ id: "sub", directory: "/home/dev/app/packages/api" })
      .session({ id: "sibling", directory: "/home/dev/app-two" });
    const dataset = new OpenCodeV1SessionStore(store.db)
      .read({ ...WINDOW, project: "/home/dev/app" })
      ._unsafeUnwrap();
    expect(dataset.sessions.map((s) => s.id).sort()).toEqual(["root", "sub"]);
  });

  it("keeps every session when --project is the filesystem root", () => {
    const store = new V1Store()
      .session({ id: "a", directory: "/home/dev/app" })
      .session({ id: "b", directory: "/srv/other" });
    const dataset = new OpenCodeV1SessionStore(store.db)
      .read({ ...WINDOW, project: "/" })
      ._unsafeUnwrap();
    expect(dataset.sessions.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("uses the project worktree as the project directory, except the global '/'", () => {
    const store = new V1Store()
      .project("p1", "/home/dev/app")
      .session({ id: "s1", projectId: "p1", directory: "/home/dev/app/sub" })
      .session({ id: "s2", directory: "/home/dev/other" });
    const dataset = new OpenCodeV1SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(
      Object.fromEntries(dataset.sessions.map((s) => [s.id, s.projectDir])),
    ).toEqual({ s1: "/home/dev/app", s2: "/home/dev/other" });
  });

  it("marks user messages that start a plan with /start-work or /weave:start", () => {
    const store = new V1Store()
      .session({ id: "s1" })
      .user(
        "s1",
        "You are being activated by the /start-work command to execute a Weave plan.",
      )
      .user("s1", "what does the plan do?");
    const dataset = new OpenCodeV1SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(dataset.messages.map((m) => m.planMarker)).toEqual([true, false]);
  });

  it("returns no message text, prompts or tool output", () => {
    const store = new V1Store()
      .session({ id: "s1" })
      .user("s1", "private user text")
      .assistant("s1", "loom", [{ target: "shuttle" }]);
    const dataset = new OpenCodeV1SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(JSON.stringify(dataset)).not.toContain("private");
  });

  it("rejects a database without the V1 tables", () => {
    const result = new OpenCodeV1SessionStore(new Database(":memory:")).read(
      WINDOW,
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "UnsupportedSchema",
      harness: "opencode",
      missing: ["session", "message", "part"],
    });
  });
});

describe("OpenCode V2 session store", () => {
  it("reads subagent tool items as delegations", () => {
    const store = new V2Store()
      .session({ id: "s1" })
      .user("s1", "hello")
      .assistant("s1", "loom", [
        { target: "shuttle" },
        { target: "shuttle-api", status: "error", error: "Unknown agent" },
        { status: "running" },
      ]);
    const dataset = new OpenCodeV2SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(
      dataset.delegations.map(({ target, status, error, index }) => ({
        target,
        status,
        error,
        index,
      })),
    ).toEqual([
      { target: "shuttle", status: "completed", error: null, index: 0 },
      {
        target: "shuttle-api",
        status: "error",
        error: "tool Unknown agent",
        index: 1,
      },
      { target: null, status: "running", error: null, index: 2 },
    ]);
    expect(dataset.messages.map((m) => [m.role, m.agent])).toEqual([
      ["user", null],
      ["assistant", "loom"],
    ]);
  });

  it("marks /weave:start in user and synthetic messages", () => {
    const store = new V2Store()
      .session({ id: "s1" })
      .user(
        "s1",
        "You are being activated by /weave:start to execute a Weave plan.",
      )
      .user(
        "s1",
        'You are being activated to execute the Weave plan "p".',
        "synthetic",
      )
      .user("s1", "follow-up");
    const dataset = new OpenCodeV2SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(dataset.messages.map((m) => m.planMarker)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("excludes /tmp/ sessions and sessions outside the window", () => {
    const store = new V2Store()
      .session({ id: "kept" })
      .session({ id: "tmp", directory: "/tmp/x" })
      .session({ id: "old", time: DAY - 48 * HOUR });
    const dataset = new OpenCodeV2SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(dataset.sessions.map((s) => s.id)).toEqual(["kept"]);
    expect(dataset.excludedTmpSessions).toBe(1);
  });

  it("returns no message text, prompts or tool output", () => {
    const store = new V2Store()
      .session({ id: "s1" })
      .user("s1", "private user text")
      .assistant("s1", "loom", [{ target: "shuttle" }]);
    const dataset = new OpenCodeV2SessionStore(store.db)
      .read(WINDOW)
      ._unsafeUnwrap();
    expect(JSON.stringify(dataset)).not.toContain("private");
  });

  it("rejects a V1 database", () => {
    const result = new OpenCodeV2SessionStore(new V1Store().db).read(WINDOW);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "UnsupportedSchema",
      harness: "opencode2",
      missing: ["session_v2", "session_message"],
    });
  });
});
