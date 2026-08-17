/**
 * Unit tests for the one adapter-owned active-plan resolver.
 *
 * These drive the resolver through its narrow read port only, so they prove
 * the behaviour every UI surface depends on without any Pi host at all:
 * one identity, one snapshot, safe typed outcomes, no path leakage, and no
 * execution side effect.
 */
import { describe, expect, it } from "bun:test";
import type { PlanTaskSnapshot } from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  type ActivePlanReadPort,
  activePlanWorkflowInstanceId,
  createActivePlanUiState,
  resolveActivePlanIdentity,
  resolveActivePlanView,
} from "../active-plan-ui-state.js";
import type { PiWeaveRecoveryPointerV1 } from "../recovery-pointer.js";

const SECRET_PATH = "/Users/someone/secret-project/.weave/plans/private.md";

function snapshot(planName: string): PlanTaskSnapshot {
  return {
    planName,
    planRevision: 3,
    totalParentCount: 2,
    parents: [
      {
        index: 0,
        id: "1",
        title: "First task",
        state: "completed",
        children: [],
      },
      {
        index: 1,
        id: "2",
        title: "Second task",
        state: "in_progress",
        children: [],
      },
    ],
  } as unknown as PlanTaskSnapshot;
}

function pointer(
  overrides: Partial<PiWeaveRecoveryPointerV1> = {},
): PiWeaveRecoveryPointerV1 {
  return {
    schemaVersion: 1,
    workflowId: "wf-recovered",
    controllerGeneration: "gen-1",
    status: "recoverable",
    observedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as PiWeaveRecoveryPointerV1;
}

interface PortCalls {
  readonly inspected: string[];
  readonly plansRead: string[];
  readonly pointerReads: number;
}

function makePort(input: {
  readonly currentWorkflowInstanceId?: string | undefined;
  readonly pointer?: PiWeaveRecoveryPointerV1 | undefined;
  readonly pointerFails?: boolean;
  readonly inspectFails?: boolean;
  readonly snapshotFails?: boolean;
  readonly slug?: string;
  readonly status?: string;
}): { port: ActivePlanReadPort; calls: PortCalls } {
  const inspected: string[] = [];
  const plansRead: string[] = [];
  const calls = {
    inspected,
    plansRead,
    get pointerReads() {
      return pointerReads;
    },
  };
  let pointerReads = 0;
  const slug = input.slug ?? "plan-a";
  const status = input.status ?? "running";
  const port: ActivePlanReadPort = {
    currentWorkflowInstanceId: input.currentWorkflowInstanceId,
    inspect: (workflowInstanceId) => {
      inspected.push(workflowInstanceId);
      return input.inspectFails === true
        ? errAsync({ type: "Boom", path: SECRET_PATH })
        : okAsync({ slug, status });
    },
    readPlanSnapshot: (planName) => {
      plansRead.push(planName);
      return input.snapshotFails === true
        ? errAsync({ type: "Boom", path: SECRET_PATH })
        : okAsync(snapshot(planName));
    },
    readRecoveryPointer: () => {
      pointerReads += 1;
      return input.pointerFails === true
        ? errAsync({ type: "Boom", path: SECRET_PATH })
        : okAsync(input.pointer);
    },
  };
  return { port, calls: calls as unknown as PortCalls };
}

describe("resolveActivePlanIdentity", () => {
  it("prefers the trusted current controller state and never reads recovery", async () => {
    const { port, calls } = makePort({
      currentWorkflowInstanceId: "wf-current",
      pointer: pointer(),
    });
    const resolved = await resolveActivePlanIdentity(port);
    expect(resolved._unsafeUnwrap()).toEqual({
      workflowInstanceId: "wf-current",
      source: "current",
    });
    expect(calls.pointerReads).toBe(0);
  });

  it("falls back to an eligible recovery pointer when nothing is tracked", async () => {
    const { port } = makePort({ pointer: pointer() });
    const resolved = await resolveActivePlanIdentity(port);
    expect(resolved._unsafeUnwrap()).toEqual({
      workflowInstanceId: "wf-recovered",
      source: "recovery",
    });
  });

  it("treats a terminal, untrusted, or quarantined pointer as nothing to show", async () => {
    for (const ineligible of [
      pointer({ status: "terminal" }),
      pointer({ trusted: false }),
      pointer({ quarantined: true }),
      pointer({ workflowId: undefined }),
    ]) {
      const { port } = makePort({ pointer: ineligible });
      const resolved = await resolveActivePlanIdentity(port);
      expect(resolved._unsafeUnwrap()).toBe("no-eligible-recovery-pointer");
    }
  });

  it("reports no active workflow when there is no pointer at all", async () => {
    const { port } = makePort({ pointer: undefined });
    const resolved = await resolveActivePlanIdentity(port);
    expect(resolved._unsafeUnwrap()).toBe("no-active-workflow");
  });

  it("returns a safe typed error when the recovery read fails", async () => {
    const { port } = makePort({ pointerFails: true });
    const resolved = await resolveActivePlanIdentity(port);
    const error = resolved._unsafeUnwrapErr();
    expect(error.reason).toBe("recovery-unreadable");
    expect(error.safeMessage).not.toContain(SECRET_PATH);
    expect(JSON.stringify(error)).not.toContain("secret-project");
  });
});

describe("resolveActivePlanView", () => {
  it("resolves current and recovered workflows through the identical lookup", async () => {
    const current = makePort({
      currentWorkflowInstanceId: "wf-x",
      slug: "shared-plan",
    });
    const recovered = makePort({
      pointer: pointer({ workflowId: "wf-x" }),
      slug: "shared-plan",
    });
    const fromCurrent = (
      await resolveActivePlanView(current.port)
    )._unsafeUnwrap();
    const fromRecovery = (
      await resolveActivePlanView(recovered.port)
    )._unsafeUnwrap();

    expect(current.calls.inspected).toEqual(["wf-x"]);
    expect(recovered.calls.inspected).toEqual(["wf-x"]);
    expect(current.calls.plansRead).toEqual(["shared-plan"]);
    expect(recovered.calls.plansRead).toEqual(["shared-plan"]);
    if (fromCurrent.kind !== "active" || fromRecovery.kind !== "active") {
      throw new Error("expected both lookups to resolve an active plan");
    }
    expect(fromCurrent.snapshot).toEqual(fromRecovery.snapshot);
    expect(fromCurrent.activeTask).toEqual(fromRecovery.activeTask);
    expect(activePlanWorkflowInstanceId(fromCurrent.identity)).toBe(
      activePlanWorkflowInstanceId(fromRecovery.identity),
    );
    expect(fromCurrent.identity.source).toBe("current");
    expect(fromRecovery.identity.source).toBe("recovery");
  });

  it("reads the plan name from inspect() rather than assuming one", async () => {
    const { port, calls } = makePort({
      currentWorkflowInstanceId: "wf-x",
      slug: "inspected-slug",
    });
    const view = (await resolveActivePlanView(port))._unsafeUnwrap();
    expect(calls.plansRead).toEqual(["inspected-slug"]);
    if (view.kind !== "active") throw new Error("expected an active view");
    expect(view.planName).toBe("inspected-slug");
    expect(view.snapshot.planName).toBe("inspected-slug");
  });

  it("selects the engine's own active task", async () => {
    const { port } = makePort({ currentWorkflowInstanceId: "wf-x" });
    const view = (await resolveActivePlanView(port))._unsafeUnwrap();
    if (view.kind !== "active") throw new Error("expected an active view");
    expect(view.activeTask?.taskId).toBe("2");
  });

  it("returns an empty view without inspecting anything when nothing is active", async () => {
    const { port, calls } = makePort({ pointer: undefined });
    const view = (await resolveActivePlanView(port))._unsafeUnwrap();
    expect(view).toEqual({ kind: "empty", reason: "no-active-workflow" });
    expect(calls.inspected).toEqual([]);
    expect(calls.plansRead).toEqual([]);
  });

  it("returns a safe error and reads no plan when inspect fails", async () => {
    const { port, calls } = makePort({
      currentWorkflowInstanceId: "wf-x",
      inspectFails: true,
    });
    const error = (await resolveActivePlanView(port))._unsafeUnwrapErr();
    expect(error.reason).toBe("workflow-unreadable");
    expect(JSON.stringify(error)).not.toContain("secret-project");
    expect(calls.plansRead).toEqual([]);
  });

  it("returns a safe error when the plan snapshot cannot be read", async () => {
    const { port } = makePort({
      currentWorkflowInstanceId: "wf-x",
      snapshotFails: true,
    });
    const error = (await resolveActivePlanView(port))._unsafeUnwrapErr();
    expect(error.reason).toBe("plan-unreadable");
    expect(error.safeMessage).toBe(
      "Weave could not read the active plan. Use /weave:plan for details.",
    );
    expect(JSON.stringify(error)).not.toContain(SECRET_PATH);
  });

  it("exposes only read methods, so a recoverable plan can be shown but never resumed", async () => {
    const { port } = makePort({ pointer: pointer() });
    expect(Object.keys(port).sort()).toEqual([
      "currentWorkflowInstanceId",
      "inspect",
      "readPlanSnapshot",
      "readRecoveryPointer",
    ]);
    const view = (await resolveActivePlanView(port))._unsafeUnwrap();
    expect(view.kind).toBe("active");
  });
});

describe("createActivePlanUiState", () => {
  it("starts with no retained identity", () => {
    const state = createActivePlanUiState();
    expect(state.identity()).toBeUndefined();
    expect(state.view()).toBeUndefined();
  });

  it("retains one identity and snapshot every caller shares", async () => {
    const state = createActivePlanUiState();
    const { port } = makePort({ currentWorkflowInstanceId: "wf-x" });
    const resolved = (await state.resolve(port))._unsafeUnwrap();
    expect(state.identity()).toEqual({
      workflowInstanceId: "wf-x",
      source: "current",
    });
    expect(resolved.status).toBe("applied");
    expect(state.view()).toBe(
      resolved.status === "applied" ? resolved.view : undefined,
    );
  });

  it("cannot retain the previous workflow across a current/recovery transition", async () => {
    const state = createActivePlanUiState();
    await state.resolve(makePort({ currentWorkflowInstanceId: "wf-old" }).port);
    expect(activePlanWorkflowInstanceId(state.identity())).toBe("wf-old");

    await state.resolve(
      makePort({ pointer: pointer({ workflowId: "wf-new" }) }).port,
    );
    expect(state.identity()).toEqual({
      workflowInstanceId: "wf-new",
      source: "recovery",
    });
  });

  it.each([
    ["no eligible pointer", { pointer: pointer({ status: "terminal" }) }],
    ["no pointer", { pointer: undefined }],
    ["recovery read error", { pointerFails: true }],
    [
      "inspect error",
      { currentWorkflowInstanceId: "wf-x", inspectFails: true },
    ],
    [
      "snapshot read error",
      { currentWorkflowInstanceId: "wf-x", snapshotFails: true },
    ],
  ] as const)("drops the retained identity on %s", async (_label, input) => {
    const state = createActivePlanUiState();
    await state.resolve(makePort({ currentWorkflowInstanceId: "wf-old" }).port);
    expect(activePlanWorkflowInstanceId(state.identity())).toBe("wf-old");

    await state.resolve(makePort(input).port);
    expect(state.identity()).toBeUndefined();
  });

  it("clears on demand and is idempotent", async () => {
    const state = createActivePlanUiState();
    await state.resolve(makePort({ currentWorkflowInstanceId: "wf-x" }).port);
    state.clear();
    state.clear();
    expect(state.identity()).toBeUndefined();
    expect(state.view()).toBeUndefined();
  });

  describe("last request wins", () => {
    /**
     * A port whose `inspect()` blocks until the test releases it, so two
     * resolutions can be interleaved deterministically in one generation.
     */
    function deferredPort(input: {
      readonly currentWorkflowInstanceId?: string | undefined;
      readonly slug?: string;
      readonly status?: string;
      readonly inspectFails?: boolean;
      readonly snapshotFails?: boolean;
    }): { port: ActivePlanReadPort; release: () => void } {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const base = makePort(input).port;
      return {
        port: {
          ...base,
          inspect: (workflowInstanceId) =>
            ResultAsync.fromSafePromise(gate).andThen(() =>
              base.inspect(workflowInstanceId),
            ),
        },
        release: () => {
          release();
        },
      };
    }

    it.each([
      ["an active view", { currentWorkflowInstanceId: "wf-a" }],
      [
        "a terminal empty view",
        { currentWorkflowInstanceId: "wf-a", status: "completed" },
      ],
      [
        "a safe error",
        { currentWorkflowInstanceId: "wf-a", inspectFails: true },
      ],
    ] as const)("reports an older resolution that finishes with %s as superseded", async (_label, input) => {
      const state = createActivePlanUiState();
      const older = deferredPort(input);
      const pendingA = state.resolve(older.port);

      const resolvedB = (
        await state.resolve(
          makePort({
            currentWorkflowInstanceId: "wf-b",
            slug: "plan-b",
          }).port,
        )
      )._unsafeUnwrap();
      expect(resolvedB.status).toBe("applied");
      expect(activePlanWorkflowInstanceId(state.identity())).toBe("wf-b");

      older.release();
      const resolvedA = (await pendingA)._unsafeUnwrap();
      expect(resolvedA).toEqual({ status: "superseded" });
      expect(state.identity()).toEqual({
        workflowInstanceId: "wf-b",
        source: "current",
      });
      const retained = state.view();
      if (retained?.kind !== "active") {
        throw new Error("expected the newer view to stay retained");
      }
      expect(retained.planName).toBe("plan-b");
    });

    it("supersedes a pending resolution when clear() runs first", async () => {
      const state = createActivePlanUiState();
      const older = deferredPort({ currentWorkflowInstanceId: "wf-a" });
      const pendingA = state.resolve(older.port);

      state.clear();
      older.release();

      expect((await pendingA)._unsafeUnwrap()).toEqual({
        status: "superseded",
      });
      expect(state.identity()).toBeUndefined();
      expect(state.view()).toBeUndefined();
    });
  });
});
