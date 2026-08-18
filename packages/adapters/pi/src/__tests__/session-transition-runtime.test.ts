import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  createChildInspectionRegistryCell,
  createChildOverlayCell,
  createChildOverlayKeysCell,
  createChildTreeSelectionCell,
  createDelegationControllerCell,
  createThreadSourcesCell,
} from "../child-inspection-runtime.js";
import { ROOT_NODE_ID } from "../child-tree.js";
import { makeChildAbortFailedFailure } from "../errors.js";
import {
  createModelFailoverCoordinatorCell,
  type PiGenerationModelFailoverPort,
} from "../generation-resources.js";
import {
  buildGenerationRevokePorts,
  createSessionTransitionHandlers,
  createSessionTransitionNoticeCell,
  createSessionTransitionRuntime,
  guardSessionTransition,
  labelSessionBeforeFork,
  labelSessionBeforeSwitch,
  labelSessionBeforeTree,
  notifySessionTransition,
  type PiSessionTransitionControllerPort,
  type PiSessionTransitionRuntimeDeps,
  readTransitionEventString,
  registerSessionTransitionHandlers,
  revokeGenerationAuthority,
  SESSION_TRANSITION_GUARD_FAILED_NOTICE,
  SESSION_TRANSITION_NO_UI_NOTICE,
  SESSION_TRANSITION_PROCEED,
  SESSION_TRANSITION_PROMPT_FAILED_NOTICE,
  SESSION_TRANSITION_STAY,
} from "../session-transition-runtime.js";
import type { PiExtensionApi, PiSessionContext } from "../types.js";

function fakeController(
  overrides: Partial<PiSessionTransitionControllerPort> = {},
): PiSessionTransitionControllerPort {
  return {
    countUnsettledDescendants: () => 0,
    settleForTransition: () => okAsync({ cancelled: 0, settlementsWritten: 0 }),
    shutdownWithinBudget: () =>
      okAsync({
        gracefullyCancelled: 0,
        forceStopped: 0,
        timedOut: false,
      }),
    ...overrides,
  };
}

class TrackedFailover implements PiGenerationModelFailoverPort {
  shutdownCalls = 0;
  private live = true;
  private readonly timers: (() => void)[] = [];
  constructor(private readonly onShutdown?: () => void) {}

  reset(): void {
    this.live = false;
  }

  shutdown(): void {
    this.shutdownCalls += 1;
    this.live = false;
    this.onShutdown?.();
  }

  armTimer(callback: () => void): void {
    this.timers.push(() => {
      if (this.live) callback();
    });
  }

  fireTimers(): void {
    for (const timer of this.timers) timer();
  }
}

function fakeCtx(overrides: {
  hasUI?: boolean;
  select?: () => Promise<string | undefined>;
  notify?: (message: string, level?: string) => void;
}): PiSessionContext {
  return {
    hasUI: overrides.hasUI ?? true,
    ui: {
      notify: overrides.notify ?? (() => undefined),
      select: overrides.select ?? (async () => SESSION_TRANSITION_STAY),
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  } as unknown as PiSessionContext;
}

type TestSessionTransitionRuntimeDeps = PiSessionTransitionRuntimeDeps & {
  readonly modelFailoverCoordinatorCell: NonNullable<
    PiSessionTransitionRuntimeDeps["modelFailoverCoordinatorCell"]
  >;
};

function runtimeDeps(
  overrides: Partial<PiSessionTransitionRuntimeDeps> = {},
): TestSessionTransitionRuntimeDeps {
  return {
    noticeCell: createSessionTransitionNoticeCell(),
    delegationControllerCell: createDelegationControllerCell(),
    threadSourcesCell: createThreadSourcesCell(),
    treeSelectionCell: createChildTreeSelectionCell(),
    inspectionRegistryCell: createChildInspectionRegistryCell(),
    childOverlayCell: createChildOverlayCell(),
    overlayKeysCell: createChildOverlayKeysCell(() => 1),
    workflowControllerCell: { controller: undefined },
    activeWorkflowInstanceCell: { value: undefined },
    recoveryCoordinatorCell: { coordinator: undefined },
    modelFailoverCoordinatorCell: createModelFailoverCoordinatorCell(),
    planStateProviderCell: { value: undefined },
    telemetryCell: { telemetry: undefined },
    generationResourcesCell: { owner: undefined },
    bumpSessionStartSequence: () => undefined,
    closePlanTaskOverlay: () => undefined,
    shutdownExtensionController: () => undefined,
    clearBootActivationFailure: () => undefined,
    takeActiveSession: () => undefined,
    setThreadSourcesRequired: () => undefined,
    clearCurrentWorkflows: () => undefined,
    cancelDirectStep: () => okAsync(undefined),
    clearActivePlanSurfaces: () => undefined,
    restoreEditor: () => undefined,
    disposeChildMode: () => undefined,
    warnObserveFailure: () => undefined,
    ...overrides,
  };
}

describe("session-transition-runtime labels", () => {
  test("readTransitionEventString and surface labels", () => {
    expect(readTransitionEventString({ reason: "resume" }, "reason")).toBe(
      "resume",
    );
    expect(readTransitionEventString(null, "reason")).toBeUndefined();
    expect(labelSessionBeforeSwitch({ reason: "new" })).toBe("new");
    expect(labelSessionBeforeSwitch({})).toBe("new session");
    expect(labelSessionBeforeFork({ position: "at" })).toBe("clone");
    expect(labelSessionBeforeFork({ position: "before" })).toBe("fork");
    expect(labelSessionBeforeTree({})).toBe("tree navigation");
  });
});

describe("session-transition-runtime guard", () => {
  test("fast-path allows when there is no controller or no pending children", async () => {
    const noticeCell = createSessionTransitionNoticeCell();
    expect(
      await guardSessionTransition(
        { noticeCell, currentController: () => undefined },
        "new session",
        fakeCtx({}),
      ),
    ).toBe(true);

    expect(
      await guardSessionTransition(
        {
          noticeCell,
          currentController: () => fakeController(),
        },
        "new session",
        fakeCtx({}),
      ),
    ).toBe(true);
    expect(noticeCell.value).toBeUndefined();
  });

  test("no-UI path vetoes with the fixed notice", async () => {
    const noticeCell = createSessionTransitionNoticeCell();
    const notices: string[] = [];
    const allowed = await guardSessionTransition(
      {
        noticeCell,
        currentController: () =>
          fakeController({ countUnsettledDescendants: () => 2 }),
      },
      "fork",
      fakeCtx({
        hasUI: false,
        notify: (message) => {
          notices.push(message);
        },
      }),
    );
    expect(allowed).toBe(false);
    expect(noticeCell.value).toBe(SESSION_TRANSITION_NO_UI_NOTICE);
    expect(notices).toEqual([SESSION_TRANSITION_NO_UI_NOTICE]);
  });

  test("Stay / undefined select veto without settling", async () => {
    let settled = 0;
    const noticeCell = createSessionTransitionNoticeCell();
    const controller = fakeController({
      countUnsettledDescendants: () => 1,
      settleForTransition: () => {
        settled += 1;
        return okAsync({ cancelled: 1, settlementsWritten: 1 });
      },
    });

    for (const choice of [SESSION_TRANSITION_STAY, undefined] as const) {
      settled = 0;
      const allowed = await guardSessionTransition(
        { noticeCell, currentController: () => controller },
        "new session",
        fakeCtx({ select: async () => choice }),
      );
      expect(allowed).toBe(false);
      expect(settled).toBe(0);
    }
  });

  test("Proceed settles and allows; settlement failure vetoes with bounded notice", async () => {
    const noticeCell = createSessionTransitionNoticeCell();
    const okController = fakeController({
      countUnsettledDescendants: () => 1,
      settleForTransition: () =>
        okAsync({ cancelled: 1, settlementsWritten: 1 }),
    });
    expect(
      await guardSessionTransition(
        { noticeCell, currentController: () => okController },
        "new session",
        fakeCtx({ select: async () => SESSION_TRANSITION_PROCEED }),
      ),
    ).toBe(true);
    expect(noticeCell.value).toBeUndefined();

    const failure = makeChildAbortFailedFailure("c1", "cancel-failed");
    const notices: string[] = [];
    const failController = fakeController({
      countUnsettledDescendants: () => 1,
      settleForTransition: () => errAsync(failure),
    });
    expect(
      await guardSessionTransition(
        { noticeCell, currentController: () => failController },
        "new session",
        fakeCtx({
          select: async () => SESSION_TRANSITION_PROCEED,
          notify: (message) => {
            notices.push(message);
          },
        }),
      ),
    ).toBe(false);
    expect(noticeCell.value).toContain("ChildAbortFailed");
    expect(noticeCell.value?.length ?? 0).toBeLessThanOrEqual(240);
    expect(notices.at(-1)).toBe(noticeCell.value);
  });

  test("prompt rejection uses the fixed prompt-failed notice", async () => {
    const noticeCell = createSessionTransitionNoticeCell();
    const allowed = await guardSessionTransition(
      {
        noticeCell,
        currentController: () =>
          fakeController({ countUnsettledDescendants: () => 1 }),
      },
      "new session",
      fakeCtx({
        select: async () => {
          throw new Error("dialog exploded with secret");
        },
      }),
    );
    expect(allowed).toBe(false);
    expect(noticeCell.value).toBe(SESSION_TRANSITION_PROMPT_FAILED_NOTICE);
  });
});

describe("session-transition-runtime handlers", () => {
  test("register attaches switch/fork/tree handlers", () => {
    const events: string[] = [];
    const api = {
      on: (event: string) => {
        events.push(event);
      },
    } as unknown as PiExtensionApi;
    const handlers = createSessionTransitionHandlers({
      noticeCell: createSessionTransitionNoticeCell(),
      currentController: () => undefined,
    });
    registerSessionTransitionHandlers(api, handlers);
    expect(events).toEqual([
      "session_before_switch",
      "session_before_fork",
      "session_before_tree",
    ]);
  });

  test("guarded hook converts thrown guard failures into cancel", async () => {
    const noticeCell = createSessionTransitionNoticeCell();
    const handlers = createSessionTransitionHandlers({
      noticeCell,
      currentController: () => {
        throw new Error("unexpected");
      },
    });
    // Force pending > 0 path by throwing from count via a controller that
    // throws when counted - currentController itself throwing is caught by
    // the outer fromPromise wrapper.
    const result = await handlers.beforeSwitch({}, fakeCtx({}));
    expect(result).toEqual({ cancel: true });
    expect(noticeCell.value).toBe(SESSION_TRANSITION_GUARD_FAILED_NOTICE);
  });
});

describe("session-transition-runtime shutdown helpers", () => {
  test("revoke clears notice, overlays, and delegation cell", () => {
    let bumped = 0;
    const deps = runtimeDeps({
      bumpSessionStartSequence: () => {
        bumped += 1;
      },
    });
    deps.noticeCell.value = "stale";
    deps.delegationControllerCell.controller = fakeController() as never;
    deps.delegationControllerCell.generationId = "gen-1";
    deps.treeSelectionCell.selectedId = "child-1";
    deps.threadSourcesCell.cacheMode = "active";

    const snapshot = revokeGenerationAuthority(
      deps.noticeCell,
      buildGenerationRevokePorts(deps),
    );

    expect(bumped).toBe(1);
    expect(deps.noticeCell.value).toBeUndefined();
    expect(deps.delegationControllerCell.controller).toBeUndefined();
    expect(deps.delegationControllerCell.generationId).toBeUndefined();
    expect(deps.treeSelectionCell.selectedId).toBe(ROOT_NODE_ID);
    expect(deps.threadSourcesCell.cacheMode).toBeUndefined();
    expect(snapshot.shuttingDelegation).toBeDefined();
  });

  test("revokeForReplacement bumps after overlays and disposes delegation", () => {
    const disposed: string[] = [];
    let sequence = 0;
    const controller = fakeController();
    const deps = runtimeDeps({
      bumpSessionStartSequence: () => {
        sequence += 1;
      },
    });
    deps.delegationControllerCell.controller = controller as never;
    deps.noticeCell.value = "stale";
    const runtime = createSessionTransitionRuntime(deps);
    runtime.revokeForReplacement(() => {
      disposed.push("delegation");
    });
    expect(sequence).toBe(1);
    expect(disposed).toEqual(["delegation"]);
    expect(deps.delegationControllerCell.controller).toBeUndefined();
    expect(deps.noticeCell.value).toBeUndefined();
  });

  test("replacement clears the old coordinator before successor state is published", () => {
    const deps = runtimeDeps();
    const first = new TrackedFailover();
    let staleMutations = 0;
    first.armTimer(() => {
      staleMutations += 1;
      deps.modelFailoverCoordinatorCell.coordinator = undefined;
    });
    deps.modelFailoverCoordinatorCell.coordinator = first;
    deps.modelFailoverCoordinatorCell.generationId = "generation-1";
    deps.delegationControllerCell.controller = fakeController() as never;
    const runtime = createSessionTransitionRuntime(deps);

    runtime.revokeForReplacement(() => undefined);

    expect(first.shutdownCalls).toBe(1);
    expect(deps.modelFailoverCoordinatorCell.coordinator).toBeUndefined();
    expect(deps.modelFailoverCoordinatorCell.generationId).toBeUndefined();
    expect(deps.delegationControllerCell.controller).toBeUndefined();

    const second = new TrackedFailover();
    deps.modelFailoverCoordinatorCell.coordinator = second;
    deps.modelFailoverCoordinatorCell.generationId = "generation-2";
    first.fireTimers();

    expect(staleMutations).toBe(0);
    expect(deps.modelFailoverCoordinatorCell.coordinator).toBe(second);
    expect(deps.modelFailoverCoordinatorCell.generationId).toBe("generation-2");
  });

  test("reload/revoke clears the coordinator without changing snapshot order", () => {
    const deps = runtimeDeps();
    const order: string[] = [];
    const owner = {
      dispose: () => okAsync<void, never>(undefined),
    };
    const controller = fakeController();
    deps.generationResourcesCell.owner = owner;
    deps.delegationControllerCell.controller = controller as never;
    const first = new TrackedFailover(() => {
      order.push(
        deps.generationResourcesCell.owner === undefined
          ? "resources-taken"
          : "resources-held",
      );
      order.push(
        deps.delegationControllerCell.controller === undefined
          ? "delegation-taken"
          : "delegation-held",
      );
    });
    deps.modelFailoverCoordinatorCell.coordinator = first;
    deps.modelFailoverCoordinatorCell.generationId = "generation-1";

    const snapshot = revokeGenerationAuthority(
      deps.noticeCell,
      buildGenerationRevokePorts(deps),
    );

    expect(first.shutdownCalls).toBe(1);
    expect(order).toEqual(["resources-taken", "delegation-held"]);
    expect(snapshot.shuttingResources).toBe(owner);
    expect(snapshot.shuttingDelegation).toBe(controller);
    expect(deps.modelFailoverCoordinatorCell.coordinator).toBeUndefined();
    expect(deps.modelFailoverCoordinatorCell.generationId).toBeUndefined();
  });

  test("runBoundedShutdown shuts down the coordinator before legacy cleanup", async () => {
    const order: string[] = [];
    const deps = runtimeDeps();
    const owner = {
      dispose: () => {
        order.push("resources");
        return okAsync<void, never>(undefined);
      },
    };
    const controller = fakeController({
      shutdownWithinBudget: () => {
        order.push("delegation");
        return okAsync({
          gracefullyCancelled: 1,
          forceStopped: 0,
          timedOut: false,
        });
      },
    });
    const first = new TrackedFailover(() => {
      order.push("coordinator");
    });
    first.armTimer(() => {
      order.push("stale-timer");
      deps.modelFailoverCoordinatorCell.coordinator = undefined;
    });
    deps.modelFailoverCoordinatorCell.coordinator = first;
    deps.modelFailoverCoordinatorCell.generationId = "generation-1";
    deps.delegationControllerCell.controller = controller as never;
    deps.generationResourcesCell.owner = owner;

    const runtime = createSessionTransitionRuntime(deps);
    await runtime.runBoundedShutdown(fakeCtx({}));

    expect(order).toEqual(["coordinator", "delegation", "resources"]);
    expect(first.shutdownCalls).toBe(1);
    expect(deps.modelFailoverCoordinatorCell.coordinator).toBeUndefined();
    expect(deps.modelFailoverCoordinatorCell.generationId).toBeUndefined();

    const second = new TrackedFailover();
    deps.modelFailoverCoordinatorCell.coordinator = second;
    deps.modelFailoverCoordinatorCell.generationId = "generation-2";
    first.fireTimers();
    expect(order).toEqual(["coordinator", "delegation", "resources"]);
    expect(deps.modelFailoverCoordinatorCell.coordinator).toBe(second);
  });

  test("runBoundedShutdown awaits shutdownWithinBudget on the snapshot", async () => {
    let stopped = 0;
    const controller = fakeController({
      shutdownWithinBudget: () => {
        stopped += 1;
        return okAsync({
          gracefullyCancelled: 1,
          forceStopped: 0,
          timedOut: false,
        });
      },
    });
    const deps = runtimeDeps();
    deps.delegationControllerCell.controller = controller as never;
    const runtime = createSessionTransitionRuntime(deps);
    await runtime.runBoundedShutdown(fakeCtx({}));
    expect(stopped).toBe(1);
    expect(deps.delegationControllerCell.controller).toBeUndefined();
  });

  test("notifySessionTransition ignores missing context", () => {
    expect(() =>
      notifySessionTransition(undefined, SESSION_TRANSITION_NO_UI_NOTICE),
    ).not.toThrow();
  });
});
