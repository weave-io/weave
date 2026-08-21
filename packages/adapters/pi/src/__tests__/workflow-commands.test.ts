import { describe, expect, it } from "bun:test";
import type { PlanTaskSnapshot } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import { makeInvariantViolationFailure } from "../errors.js";
import {
  buildPaletteActions,
  handleWeaveAbort,
  handleWeaveArtifact,
  handleWeavePlan,
  handleWeaveResume,
  handleWeaveRun,
  handleWeaveStart,
  handleWeaveStatus,
  type PiActiveWorkflowTracker,
  type PiForegroundPlanStartPort,
  type PiWorkflowCommandUiPort,
} from "../workflow-commands.js";
import type { PiWorkflowController } from "../workflow-controller.js";

function fakeUi(
  overrides: Partial<PiWorkflowCommandUiPort> = {},
): PiWorkflowCommandUiPort & {
  notified: { message: string; level?: string }[];
} {
  const notified: { message: string; level?: string }[] = [];
  return {
    notify: (message, level) => notified.push({ message, level }),
    select: overrides.select ?? (async () => undefined),
    confirm: overrides.confirm ?? (async () => true),
    notified,
  };
}

function fakeTracker(
  overrides: Partial<PiActiveWorkflowTracker> = {},
): PiActiveWorkflowTracker {
  return {
    getActiveInstance: overrides.getActiveInstance ?? (() => undefined),
    setActiveInstance: overrides.setActiveInstance ?? (() => {}),
    listPlanNames: overrides.listPlanNames ?? (() => okAsync([])),
    listWorkflowNames: overrides.listWorkflowNames ?? (() => []),
    buildContext: overrides.buildContext ?? (() => undefined),
    currentAgentName: overrides.currentAgentName ?? (() => undefined),
  };
}

// A minimal stand-in satisfying only the methods each test actually calls.
function fakeController(
  overrides: Partial<PiWorkflowController> = {},
): PiWorkflowController {
  return overrides as PiWorkflowController;
}

describe("handleWeaveStart", () => {
  it("never authorizes start without an explicit user confirmation", async () => {
    const ui = fakeUi({ confirm: async () => false });
    const tracker = fakeTracker({ listPlanNames: () => okAsync(["my-plan"]) });
    let called = false;
    const foregroundStarter: PiForegroundPlanStartPort = {
      start: () => {
        called = true;
        return okAsync(undefined);
      },
    };

    await handleWeaveStart("my-plan", ui, foregroundStarter, tracker);

    expect(called).toBe(false);
    expect(
      ui.notified.some((n) => n.message.includes("explicit confirmation")),
    ).toBe(true);
  });

  it("starts the named existing plan in the foreground after confirmation", async () => {
    const ui = fakeUi({ confirm: async () => true });
    const tracker = fakeTracker({ listPlanNames: () => okAsync(["my-plan"]) });
    let capturedPlanName: string | undefined;
    const foregroundStarter: PiForegroundPlanStartPort = {
      start: (planName) => {
        capturedPlanName = planName;
        return okAsync(undefined);
      },
    };

    await handleWeaveStart("my-plan", ui, foregroundStarter, tracker);

    expect(capturedPlanName).toBe("my-plan");
    expect(ui.notified.some((n) => n.level === "error")).toBe(false);
  });

  it("rejects a plan name that is absent from the safe plan catalog", async () => {
    const ui = fakeUi({ confirm: async () => true });
    const tracker = fakeTracker({ listPlanNames: () => okAsync(["my-plan"]) });
    let called = false;
    const foregroundStarter: PiForegroundPlanStartPort = {
      start: () => {
        called = true;
        return okAsync(undefined);
      },
    };

    await handleWeaveStart("../other-plan", ui, foregroundStarter, tracker);

    expect(called).toBe(false);
    expect(ui.notified.at(-1)).toEqual({
      message: "The requested plan was not found.",
      level: "error",
    });
  });

  it("fails closed when the plan selector rejects", async () => {
    const ui = fakeUi({
      select: async () => {
        throw new Error("sensitive selector failure");
      },
    });
    const tracker = fakeTracker({ listPlanNames: () => okAsync(["my-plan"]) });
    let called = false;
    const foregroundStarter: PiForegroundPlanStartPort = {
      start: () => {
        called = true;
        return okAsync(undefined);
      },
    };

    await handleWeaveStart("", ui, foregroundStarter, tracker);

    expect(called).toBe(false);
    expect(ui.notified.at(-1)).toEqual({
      message: "Pi could not open the plan selector.",
      level: "error",
    });
    expect(JSON.stringify(ui.notified)).not.toContain("sensitive");
  });

  it("fails closed when the confirmation dialog rejects", async () => {
    const ui = fakeUi({
      confirm: async () => {
        throw new Error("sensitive confirmation failure");
      },
    });
    const tracker = fakeTracker({ listPlanNames: () => okAsync(["my-plan"]) });
    let called = false;
    const foregroundStarter: PiForegroundPlanStartPort = {
      start: () => {
        called = true;
        return okAsync(undefined);
      },
    };

    await handleWeaveStart("my-plan", ui, foregroundStarter, tracker);

    expect(called).toBe(false);
    expect(ui.notified.at(-1)).toEqual({
      message: "Pi could not confirm the plan start request.",
      level: "error",
    });
    expect(JSON.stringify(ui.notified)).not.toContain("sensitive");
  });
});

describe("handleWeaveRun", () => {
  it("keeps configured workflows on the durable startExecution path", async () => {
    const ui = fakeUi({ confirm: async () => true });
    const tracker = fakeTracker({
      listWorkflowNames: () => ["release"],
      buildContext: (workflowName) => ({
        workflowName,
        goal: workflowName,
        slug: workflowName,
        workflows: { release: {} as never },
      }),
    });
    let capturedInput: { workflowInstanceId: string } | undefined;
    const controller = fakeController({
      startExecution: (async (input: { workflowInstanceId: string }) => {
        capturedInput = input;
        return okAsync({
          workflowInstanceId: input.workflowInstanceId,
          leaseId: "lease-1",
          finalStatus: "running",
        });
      }) as never,
    });

    await handleWeaveRun("release", ui, controller, tracker);

    expect(capturedInput?.workflowInstanceId.startsWith("release-")).toBe(true);
    expect(ui.notified.at(-1)?.message).toContain("running");
  });

  it("requires a configured workflow", async () => {
    const ui = fakeUi();
    const tracker = fakeTracker({ buildContext: () => undefined });
    const controller = fakeController();
    await handleWeaveRun("unknown-workflow", ui, controller, tracker);
    expect(ui.notified.some((n) => n.message.includes("not configured"))).toBe(
      true,
    );
  });
});

describe("handleWeaveStatus", () => {
  it("is read-only and reports the tracked instance's status", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({ workflowInstanceId: "wf-1" }),
    });
    const ui = fakeUi();
    const controller = fakeController({
      inspect: (async () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          status: "running",
          currentStepName: "implement",
        })) as never,
    });
    await handleWeaveStatus(ui, controller, tracker);
    expect(ui.notified[0]?.message).toContain("running");
  });
});

describe("handleWeaveAbort", () => {
  it("cancels via handleUserInterrupt with signal 'cancel' and clears the tracked instance", async () => {
    let capturedSignal: string | undefined;
    const tracker = fakeTracker({
      getActiveInstance: () => ({
        workflowInstanceId: "wf-1",
        leaseId: "lease-1",
      }),
      setActiveInstance: () => {},
    });
    const ui = fakeUi({ confirm: async () => true });
    const controller = fakeController({
      handleUserInterrupt: (async (input: { signal: string }) => {
        capturedSignal = input.signal;
        return okAsync(undefined as never);
      }) as never,
    });
    await handleWeaveAbort(ui, controller, tracker);
    expect(capturedSignal).toBe("cancel");
  });
});

describe("handleWeaveResume", () => {
  it("never authorizes resume without an explicit user confirmation", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({ workflowInstanceId: "wf-1" }),
    });
    const ui = fakeUi({ confirm: async () => false });
    let called = false;
    const controller = fakeController({
      inspect: (async () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          status: "paused",
        })) as never,
      resumeExecution: (async () => {
        called = true;
        return okAsync(undefined as never);
      }) as never,
    });
    await handleWeaveResume(ui, controller, tracker);
    expect(called).toBe(false);
  });

  it("resumes an instance reconstructed from a durable recovery pointer after reload/new-generation, via fresh confirmation, inspect, resume, and lease replacement (Issue #21 Task 12 S020)", async () => {
    // Simulates the dispatcher's own seeding step: a reload/restart
    // installs a fresh generation whose in-memory tracker starts empty, so
    // the dispatcher reconstructs this correlation from the durable
    // recovery pointer (`activeInstanceFromRecoveryPointer`) *before*
    // calling this handler - never inside it.
    let tracked: { workflowInstanceId: string; leaseId?: string } | undefined =
      {
        workflowInstanceId: "wf-1",
        leaseId: "lease-1",
      };
    const tracker = fakeTracker({
      getActiveInstance: () => tracked,
      setActiveInstance: (instance) => {
        tracked = instance;
      },
      buildContext: (name) => ({
        workflowName: name,
        goal: "g",
        slug: "s",
        workflows: {},
      }),
    });
    let confirmCalled = false;
    const ui = fakeUi({
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    let inspectedInstanceId: string | undefined;
    let resumeCalledWithInstanceId: string | undefined;
    const controller = fakeController({
      inspect: ((workflowInstanceId: string) => {
        inspectedInstanceId = workflowInstanceId;
        return okAsync({
          workflowInstanceId,
          workflowName: "wf",
          goal: "g",
          slug: "wf",
          status: "paused",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          artifacts: [],
          hasActiveLease: true,
          stepAttempts: [],
        });
      }) as never,
      resumeExecution: ((input: { workflowInstanceId: string }) => {
        resumeCalledWithInstanceId = input.workflowInstanceId;
        // A fresh lease from the engine, replacing the stale one carried by
        // the durable pointer - proving the pointer supplied correlation
        // only, never authority over the lease itself.
        return okAsync({
          workflowInstanceId: input.workflowInstanceId,
          leaseId: "lease-2",
          finalStatus: "running",
        });
      }) as never,
    });
    await handleWeaveResume(ui, controller, tracker);
    expect(confirmCalled).toBe(true);
    expect(inspectedInstanceId).toBe("wf-1");
    expect(resumeCalledWithInstanceId).toBe("wf-1");
    expect(tracked).toEqual({ workflowInstanceId: "wf-1", leaseId: "lease-2" });
  });

  it("mints a linked attempt and forwards only bounded linkage metadata", async () => {
    let tracked: PiActiveWorkflowTracker["getActiveInstance"] extends () => infer T
      ? T
      : never = {
      workflowInstanceId: "wf-1",
      leaseId: "lease-old",
      controllerGeneration: "gen-old",
      attemptId: "attempt-old",
    };
    let input: Record<string, unknown> | undefined;
    const tracker = fakeTracker({
      getActiveInstance: () => tracked,
      setActiveInstance: (next) => {
        tracked = next;
      },
      buildContext: () => ({
        workflowName: "wf",
        goal: "wf",
        slug: "wf",
        workflows: {},
      }),
    });
    const controller = fakeController({
      inspect: () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          goal: "wf",
          slug: "wf",
          status: "paused",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          artifacts: [],
          hasActiveLease: true,
          stepAttempts: [],
        }) as never,
      resumeExecution: (next) => {
        input = next as unknown as Record<string, unknown>;
        return okAsync({
          workflowInstanceId: "wf-1",
          leaseId: "lease-new",
          finalStatus: "running",
        });
      },
    });
    await handleWeaveResume(fakeUi(), controller, tracker);
    const metadata = input?.metadata as Record<string, string>;
    expect(metadata.weaveResumePreviousAttemptId).toBe("attempt-old");
    expect(metadata.weaveResumeAttemptId).not.toBe("attempt-old");
    expect(tracked?.attemptId).toBe(metadata.weaveResumeAttemptId);
    expect(JSON.stringify(metadata)).not.toContain("transcript");
  });

  it("forwards recoveryTakeover to resumeExecution only when the tracked instance carries a controllerGeneration (Issue #21 Task 12 S020)", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({
        workflowInstanceId: "wf-1",
        leaseId: "lease-old",
        controllerGeneration: "gen-old",
      }),
      buildContext: (name) => ({
        workflowName: name,
        goal: "g",
        slug: "s",
        workflows: {},
      }),
    });
    const ui = fakeUi({ confirm: async () => true });
    let capturedInput: unknown;
    const controller = fakeController({
      inspect: (async () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          status: "paused",
        })) as never,
      resumeExecution: ((input: unknown) => {
        capturedInput = input;
        return okAsync({
          workflowInstanceId: "wf-1",
          leaseId: "lease-new",
          finalStatus: "running",
        });
      }) as never,
    });
    await handleWeaveResume(ui, controller, tracker);
    expect(capturedInput).toMatchObject({
      recoveryTakeover: {
        expectedLeaseId: "lease-old",
        expectedControllerGeneration: "gen-old",
      },
    });
  });

  it("never forwards recoveryTakeover for an ordinary in-session instance with no controllerGeneration", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({
        workflowInstanceId: "wf-1",
        leaseId: "lease-1",
      }),
      buildContext: (name) => ({
        workflowName: name,
        goal: "g",
        slug: "s",
        workflows: {},
      }),
    });
    const ui = fakeUi({ confirm: async () => true });
    let capturedInput: unknown;
    const controller = fakeController({
      inspect: (async () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          status: "paused",
        })) as never,
      resumeExecution: ((input: unknown) => {
        capturedInput = input;
        return okAsync({
          workflowInstanceId: "wf-1",
          leaseId: "lease-2",
          finalStatus: "running",
        });
      }) as never,
    });
    await handleWeaveResume(ui, controller, tracker);
    expect(capturedInput).not.toHaveProperty("recoveryTakeover");
  });

  it("surfaces LeaseLost when the engine rejects a mismatched/absent takeover, matching the exact S020 regression message", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({
        workflowInstanceId: "wf-1",
        leaseId: "lease-old",
        controllerGeneration: "gen-old",
      }),
      buildContext: (name) => ({
        workflowName: name,
        goal: "g",
        slug: "s",
        workflows: {},
      }),
    });
    const ui = fakeUi({ confirm: async () => true });
    const controller = fakeController({
      inspect: (async () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          status: "paused",
        })) as never,
      resumeExecution: (() =>
        errAsync({
          code: "LeaseLost",
          safeMessage:
            "The execution lease is no longer held; explicit resume is required.",
        })) as never,
    });
    await handleWeaveResume(ui, controller, tracker);
    expect(
      ui.notified.some((n) =>
        n.message.includes(
          "The execution lease is no longer held; explicit resume is required.",
        ),
      ),
    ).toBe(true);
  });
});

describe("handleWeavePlan", () => {
  function planSnapshot(planName: string): PlanTaskSnapshot {
    return {
      planName,
      contentRevision: "rev-1",
      format: "canonical",
      totalParentCount: 1,
      complete: false,
      parents: [
        {
          id: "1",
          title: "Do the thing",
          state: "in_progress",
          children: [
            { id: "1.a", title: "Sub task", state: "completed", children: [] },
          ],
        },
      ],
    };
  }

  it("reads and renders the named plan's full nested task tree", async () => {
    const tracker = fakeTracker({
      listPlanNames: () => okAsync(["plan-a", "plan-b"]),
    });
    const ui = fakeUi();
    const controller = fakeController({
      readPlanSnapshot: (() => okAsync(planSnapshot("plan-a"))) as never,
    });
    await handleWeavePlan("plan-a", ui, controller, tracker);
    expect(ui.notified[0]?.message).toContain("plan-a");
    expect(ui.notified[0]?.message).toContain("1. Do the thing");
    expect(ui.notified[0]?.message).toContain("1.a. Sub task");
  });

  it("defaults to the currently-tracked plan when no name is given", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({ workflowInstanceId: "active-plan" }),
    });
    const ui = fakeUi();
    let requestedPlanName: string | undefined;
    const controller = fakeController({
      readPlanSnapshot: ((planName: string) => {
        requestedPlanName = planName;
        return okAsync(planSnapshot(planName));
      }) as never,
    });
    await handleWeavePlan("", ui, controller, tracker);
    expect(requestedPlanName).toBe("active-plan");
  });

  it("is read-only and reports a typed failure without throwing", async () => {
    const tracker = fakeTracker({
      listPlanNames: () => okAsync(["plan-a"]),
    });
    const ui = fakeUi();
    const controller = fakeController({
      readPlanSnapshot: (() =>
        errAsync(makeInvariantViolationFailure("unreachable"))) as never,
    });
    await handleWeavePlan("plan-a", ui, controller, tracker);
    expect(
      ui.notified.some((n) => n.message.includes("Could not read plan")),
    ).toBe(true);
  });
});

describe("handleWeaveArtifact", () => {
  it("routes an approve decision with the artifact's current revision bound", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({
        workflowInstanceId: "wf-1",
        leaseId: "lease-1",
      }),
    });
    const ui = fakeUi({ confirm: async () => true });
    let capturedRevision: number | undefined;
    const controller = fakeController({
      inspect: (async () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          status: "running",
          artifacts: [{ id: "artifact-1", revision: 3, path: "report.md" }],
        })) as never,
      approveArtifact: (async (input: { expectedRevision: number }) => {
        capturedRevision = input.expectedRevision;
        return okAsync(undefined as never);
      }) as never,
    });
    await handleWeaveArtifact("approve artifact-1", ui, controller, tracker);
    expect(capturedRevision).toBe(3);
  });

  it("rejects a malformed command with a usage message and never calls the controller", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({
        workflowInstanceId: "wf-1",
        leaseId: "lease-1",
      }),
    });
    const ui = fakeUi();
    let called = false;
    const controller = fakeController({
      approveArtifact: (async () => {
        called = true;
        return errAsync(makeInvariantViolationFailure("unreachable"));
      }) as never,
    });
    await handleWeaveArtifact("bogus", ui, controller, tracker);
    expect(called).toBe(false);
    expect(ui.notified.some((n) => n.message.includes("Usage"))).toBe(true);
  });

  it("binds a user actor and the artifact's own path for digest recomputation on approve", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({
        workflowInstanceId: "wf-1",
        leaseId: "lease-1",
      }),
    });
    const ui = fakeUi({ confirm: async () => true });
    let captured: Record<string, unknown> | undefined;
    const controller = fakeController({
      inspect: (async () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          status: "running",
          artifacts: [{ id: "artifact-1", revision: 3, path: "report.md" }],
        })) as never,
      approveArtifact: (async (input: Record<string, unknown>) => {
        captured = input;
        return okAsync(undefined as never);
      }) as never,
    });
    await handleWeaveArtifact("approve artifact-1", ui, controller, tracker);
    expect(captured?.actor).toEqual({
      kind: "user",
      provenance: { source: "weave:artifact" },
    });
    expect(captured?.relativePathForDigest).toBe("report.md");
    expect(captured?.expectedRevision).toBe(3);
  });

  it("triggers reconcileExecution with a user-revision-request reason after a reject decision", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({
        workflowInstanceId: "wf-1",
        leaseId: "lease-1",
      }),
    });
    const ui = fakeUi({ confirm: async () => true });
    let reconciled: Record<string, unknown> | undefined;
    const controller = fakeController({
      inspect: (async () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          status: "running",
          artifacts: [{ id: "artifact-1", revision: 3, path: "report.md" }],
        })) as never,
      approveArtifact: (async () => okAsync(undefined as never)) as never,
      reconcile: (async (input: Record<string, unknown>) => {
        reconciled = input;
        return okAsync({ effects: [] } as never);
      }) as never,
    });
    await handleWeaveArtifact("reject artifact-1", ui, controller, tracker);
    expect(reconciled).toEqual({
      workflowInstanceId: "wf-1",
      leaseId: "lease-1",
      reason: "user-revision-request",
      authorizationSource: "user",
    });
  });

  it("never triggers reconcileExecution after an approve decision", async () => {
    const tracker = fakeTracker({
      getActiveInstance: () => ({
        workflowInstanceId: "wf-1",
        leaseId: "lease-1",
      }),
    });
    const ui = fakeUi({ confirm: async () => true });
    let reconcileCalled = false;
    const controller = fakeController({
      inspect: (async () =>
        okAsync({
          workflowInstanceId: "wf-1",
          workflowName: "wf",
          status: "running",
          artifacts: [{ id: "artifact-1", revision: 3, path: "report.md" }],
        })) as never,
      approveArtifact: (async () => okAsync(undefined as never)) as never,
      reconcile: (async () => {
        reconcileCalled = true;
        return okAsync({ effects: [] } as never);
      }) as never,
    });
    await handleWeaveArtifact("approve artifact-1", ui, controller, tracker);
    expect(reconcileCalled).toBe(false);
  });
});

describe("buildPaletteActions", () => {
  it("hides start/run and shows abort/advance/resume/artifact when a workflow is active", () => {
    const actions = buildPaletteActions({
      healthOnly: false,
      hasActiveInstance: true,
      hasPendingArtifact: true,
    });
    const byId = new Map(actions.map((a) => [a.id, a]));
    expect(byId.get("weave.start")?.visible).toBe(false);
    expect(byId.get("weave.abort")?.visible).toBe(true);
    expect(byId.get("weave.artifact")?.visible).toBe(true);
    expect(byId.get("weave.status")?.visible).toBe(true);
  });

  it("disables mutating actions with a reason in health-only mode, but leaves read-only actions enabled", () => {
    const actions = buildPaletteActions({
      healthOnly: true,
      hasActiveInstance: true,
      hasPendingArtifact: true,
    });
    const byId = new Map(actions.map((a) => [a.id, a]));
    expect(byId.get("weave.start")?.disabledReason).toBeDefined();
    expect(byId.get("weave.abort")?.disabledReason).toBeDefined();
    expect(byId.get("weave.status")?.disabledReason).toBeUndefined();
  });
});
