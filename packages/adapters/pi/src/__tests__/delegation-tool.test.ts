import { describe, expect, it } from "bun:test";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type {
  PiDelegationController,
  PiDelegationRequest,
} from "../delegation-controller.js";
import {
  buildDelegationToolRegistration,
  formatDelegationAgentName,
  type PiDelegationToolDeps,
  WEAVE_DELEGATION_TOOL_NAME,
} from "../delegation-tool.js";
import {
  makeChildResponseMissingFailure,
  makeChildSpawnFailedFailure,
  type PiAdapterFailure,
} from "../errors.js";
import type { PiChildSettlement } from "../rpc-child.js";
import type {
  PiSessionContext,
  PiToolResult,
  PiUiThemePort,
} from "../types.js";

const TARGETS: readonly DelegationTarget[] = [
  {
    name: "shuttle",
    description: "General specialist",
    triggers: [],
    isCategory: false,
  },
  {
    name: "shuttle-backend",
    description: "Backend specialist",
    triggers: [],
    isCategory: true,
  },
];

function fakeController(
  delegate: (
    request: PiDelegationRequest,
  ) => ResultAsync<PiChildSettlement, PiAdapterFailure>,
  cancelSubtree?: (
    nodeId: string,
  ) => ResultAsync<void, readonly PiAdapterFailure[]>,
): PiDelegationController {
  return {
    delegate,
    cancelSubtree:
      cancelSubtree ??
      (() => {
        throw new Error("cancelSubtree should not have been called");
      }),
  } as unknown as PiDelegationController;
}

function baseDeps(
  overrides: Partial<PiDelegationToolDeps> = {},
): PiDelegationToolDeps {
  let counter = 0;
  return {
    targets: TARGETS,
    getController: () => undefined,
    parentId: "root",
    parentDepth: 0,
    parentAgentName: "loom",
    idGenerator: { next: () => `child-${++counter}` },
    buildBootstrap: () => ({}),
    buildEnv: () => ({}),
    getParentSessionState: () => ({
      persistence: "persistent",
      sessionId: "session-test",
      sessionFile: "/sessions/test.jsonl",
    }),
    ...overrides,
  };
}

/**
 * A `delegate()` settlement whose eventual resolution is controlled
 * externally - mirrors the real coupling this tool's abort wiring depends
 * on, where the exact same underlying child settlement promise is what
 * `controller.cancelSubtree()` resolves once it actually cancels the live
 * child (Pi adapter contract), rather than the tool fabricating its own result.
 */
function pendingSettlement(): {
  settlement: ResultAsync<PiChildSettlement, PiAdapterFailure>;
  resolveCancelled: () => void;
} {
  let resolve!: (value: Result<PiChildSettlement, PiAdapterFailure>) => void;
  const promise = new Promise<Result<PiChildSettlement, PiAdapterFailure>>(
    (r) => {
      resolve = r;
    },
  );
  return {
    settlement: new ResultAsync(promise),
    resolveCancelled: () => resolve(ok({ outcome: "cancelled" })),
  };
}

function abortFailure(code: string): PiAdapterFailure {
  return {
    code,
    phase: "child",
    scope: { kind: "child", id: "child-1" },
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: "child cancellation failed",
  } as PiAdapterFailure;
}

function ctx(): PiSessionContext {
  return {
    mode: "tui",
    cwd: "/project",
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      confirm: async () => false,
    },
    hasUI: true,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
}

describe("buildDelegationToolRegistration", () => {
  it("exposes the fixed tool identity and restricts the schema enum to the supplied targets", () => {
    const registration = buildDelegationToolRegistration(baseDeps());
    expect(registration.name).toBe(WEAVE_DELEGATION_TOOL_NAME);
    expect(registration.label).toBe("Delegate to a Weave subagent");
    const parameters = registration.parameters as {
      properties: { agent: { enum: string[]; description: string } };
    };
    expect(parameters.properties.agent.enum.sort()).toEqual([
      "shuttle",
      "shuttle-backend",
    ]);
    expect(parameters.properties.agent.description).toContain(
      "Exact normalized subagent name",
    );
    expect(registration.promptGuidelines).toEqual([
      "Pass the exact normalized subagent name from the `agent` enum; never use a display label, description, or alias.",
    ]);
  });

  it("renders the called subagent name instead of the protocol tool name", () => {
    const registration = buildDelegationToolRegistration(baseDeps());
    const theme: PiUiThemePort = {
      fg: (_color, text) => text,
      bold: (text) => text,
    };
    const renderCall = registration.renderCall;
    expect(renderCall).toBeDefined();
    const render = (agent: string) =>
      renderCall?.({ agent, task: "do it" }, theme, {})
        .render(80)
        .join("\n")
        .trimEnd();

    expect(render("pattern")).toBe("Pattern");
    expect(render("shuttle")).toBe("Shuttle");
    expect(render("shuttle-infra")).toBe("Infra-Shuttle");
    expect(formatDelegationAgentName("shuttle-data-platform")).toBe(
      "Data-Platform-Shuttle",
    );
  });

  it("execute: rejects an ineligible agent with a structured (not thrown) error, never touching the controller", async () => {
    let called = false;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(() => {
            called = true;
            return okAsync({ outcome: "completed", assistantOutput: "x" });
          }),
      }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "nope", task: "x" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({ ok: false, error: "invalid-delegation-target" });
    expect(called).toBe(false);
  });

  it("execute: fails closed when the delegation transport is not yet available", async () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({ getController: () => undefined }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "x" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: false,
      error: "delegation-transport-unavailable",
    });
  });

  it("execute: delegates to the controller and returns its structured settlement, without creating workflow state", async () => {
    let capturedRequest: PiDelegationRequest | undefined;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController((request) => {
            capturedRequest = request;
            return okAsync({
              outcome: "completed",
              assistantOutput: "done",
            } as PiChildSettlement);
          }),
      }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: true,
      settlement: {
        outcome: "completed",
        finalOutput: "done",
        interventionCount: 0,
      },
    });
    expect(capturedRequest?.agentName).toBe("shuttle");
    expect(capturedRequest?.parentId).toBe("root");
    expect(capturedRequest?.cwd).toBe("/project");
  });

  it("execute: pushes bounded child output as a valid partial tool result", async () => {
    let capturedRequest: PiDelegationRequest | undefined;
    const updates: PiToolResult[] = [];
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController((request) => {
            capturedRequest = request;
            return okAsync({ outcome: "completed", assistantOutput: "done" });
          }),
      }),
    );

    await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      (update) => updates.push(update),
      ctx(),
    );
    capturedRequest?.onUpdate?.({
      id: "child-1",
      parentId: "root",
      name: "shuttle",
      status: "running",
      currentTurn: 1,
      currentTool: "read",
      startedAtMs: 0,
      elapsedMs: 10,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      },
      latestOutput: "Inspecting the adapter",
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.content).toEqual([
      { type: "text", text: "Inspecting the adapter" },
    ]);
    const renderer = registration.renderResult;
    expect(renderer).toBeDefined();
    const theme: PiUiThemePort = {
      fg: (_color, text) => text,
      bold: (text) => text,
    };
    const firstUpdate = updates[0];
    expect(firstUpdate).toBeDefined();
    if (firstUpdate === undefined) return;
    const rendered = renderer?.(
      firstUpdate,
      { expanded: true, isPartial: true },
      theme,
      { args: { agent: "shuttle", task: "do it" } },
    )
      .render(80)
      .join("\n");
    expect(rendered).not.toContain("Shuttle");
    expect(rendered).toContain("\u2500");
    expect(rendered).toContain("Inspecting the adapter");

    // The agent, model, and reasoning level belong to the call line.
    const call = registration
      .renderCall?.({ agent: "shuttle", task: "do it" }, theme, {
        args: { agent: "shuttle", task: "do it" },
      })
      ?.render(80)
      .join("\n");
    expect(call).toContain("Shuttle");

    const collapsed = renderer?.(
      firstUpdate,
      { expanded: false, isPartial: true },
      theme,
      { args: { agent: "shuttle", task: "do it" } },
    )
      .render(80)
      .join("\n");
    expect(collapsed).toContain("Inspecting the adapter");
  });

  it("renderCall: names the agent with the model and reasoning level it will run on", () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({
        resolveAgentRuntime: (agentName) =>
          agentName === "shuttle"
            ? { model: "gpt-5.6-terra", reasoningLevel: "high" }
            : {},
      }),
    );
    const theme: PiUiThemePort = {
      fg: (_color, text) => text,
      bold: (text) => text,
    };
    const rendered = registration
      .renderCall?.({ agent: "shuttle", task: "do it" }, theme, {
        args: { agent: "shuttle", task: "do it" },
      })
      ?.render(80)
      .join("\n");
    expect(rendered).toContain("Shuttle gpt-5.6-terra high");
  });

  it("renderCall: names the agent alone when no model is resolved", () => {
    const registration = buildDelegationToolRegistration(baseDeps());
    const theme: PiUiThemePort = {
      fg: (_color, text) => text,
      bold: (text) => text,
    };
    const rendered = registration
      .renderCall?.({ agent: "shuttle", task: "do it" }, theme, {
        args: { agent: "shuttle", task: "do it" },
      })
      ?.render(80)
      .join("\n");
    expect(rendered?.trim()).toBe("Shuttle");
  });

  it("execute: reads the active primary identity and targets after a primary switch", async () => {
    let capturedRequest: PiDelegationRequest | undefined;
    let bootstrapParentAgentName: string | undefined;
    const deps = {
      ...baseDeps({
        getController: () =>
          fakeController((request) => {
            capturedRequest = request;
            return okAsync({ outcome: "completed", assistantOutput: "done" });
          }),
        buildBootstrap: (_target, _task, _childId, _ctx, parentAgentName) => {
          bootstrapParentAgentName = parentAgentName;
          return {};
        },
      }),
      getInvocationContext: () => ({
        parentAgentName: "tapestry",
        targets: [TARGETS[1]],
      }),
    };
    const registration = buildDelegationToolRegistration(deps);

    const accepted = await registration.execute(
      "call-1",
      { agent: "shuttle-backend", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    expect(JSON.parse((accepted.content[0] as { text: string }).text)).toEqual({
      ok: true,
      settlement: {
        outcome: "completed",
        finalOutput: "done",
        interventionCount: 0,
      },
    });
    expect(capturedRequest?.parentAgentName).toBe("tapestry");
    expect(bootstrapParentAgentName).toBe("tapestry");

    const rejected = await registration.execute(
      "call-2",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    expect(JSON.parse((rejected.content[0] as { text: string }).text)).toEqual({
      ok: false,
      error: "invalid-delegation-target",
    });
  });

  it("execute: surfaces a controller failure as a structured error code, never throwing", async () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(() =>
            errAsync({
              code: "ChildCapacityExceeded",
              phase: "child",
              scope: { kind: "child", id: "child-1" },
              impact: "operation-stopped",
              retryable: true,
              recovery: "retry",
              safeMessage: "no capacity",
            } as PiAdapterFailure),
          ),
      }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: false,
      error: "ChildCapacityExceeded",
      message: "no capacity",
      retryable: true,
      recovery: "retry",
    });
  });

  it("execute: a signal already aborted before the child is ever dispatched fails closed, never touching the controller's delegate()", async () => {
    const abortController = new AbortController();
    abortController.abort();
    let delegateCalled = false;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(() => {
            delegateCalled = true;
            return okAsync({ outcome: "completed", assistantOutput: "x" });
          }),
      }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      abortController.signal,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: false,
      error: "ChildAbortFailed",
      message:
        "Weave could not confirm the delegated child stopped cleanly; it was terminated.",
      reason: "aborted-before-dispatch",
      retryable: true,
      recovery: "retry",
    });
    expect(delegateCalled).toBe(false);
  });

  it("execute: aborting mid-flight cancels the exact generated child subtree and resolves with the child's own structured cancelled settlement", async () => {
    const { settlement, resolveCancelled } = pendingSettlement();
    let cancelledChildId: string | undefined;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(
            () => settlement,
            (nodeId) => {
              cancelledChildId = nodeId;
              // Mirrors the real coupling: a successful cancellation is what
              // eventually resolves the same child's own settlement, never
              // the tool itself.
              resolveCancelled();
              return okAsync(undefined);
            },
          ),
      }),
    );
    const abortController = new AbortController();
    const resultPromise = registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      abortController.signal,
      undefined,
      ctx(),
    );
    // The listener is attached synchronously before `execute`'s first
    // `await`, so this is a genuine mid-flight abort race, not a
    // before-dispatch one.
    abortController.abort();
    const result = await resultPromise;
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: true,
      settlement: { outcome: "cancelled" },
    });
    expect(cancelledChildId).toBe("child-1");
  });

  it("execute: an abort whose cancelSubtree() itself fails resolves promptly with the mapped failure, instead of hanging behind an unsettled delegate()", async () => {
    const neverSettles = new ResultAsync<PiChildSettlement, PiAdapterFailure>(
      new Promise(() => {
        // Deliberately never resolves - proves the tool does not hang
        // behind it once cancellation itself has failed.
      }),
    );
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(
            () => neverSettles,
            () => errAsync([abortFailure("ChildExitedUnexpectedly")]),
          ),
      }),
    );
    const abortController = new AbortController();
    const resultPromise = registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      abortController.signal,
      undefined,
      ctx(),
    );
    abortController.abort();
    const result = await resultPromise;
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: false,
      error: "ChildExitedUnexpectedly",
      message: "child cancellation failed",
      retryable: false,
      recovery: "none",
    });
  });

  it("execute: falls back to ChildAbortFailed when cancelSubtree() fails with an empty failure list", async () => {
    const neverSettles = new ResultAsync<PiChildSettlement, PiAdapterFailure>(
      new Promise(() => {}),
    );
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(
            () => neverSettles,
            () => errAsync([]),
          ),
      }),
    );
    const abortController = new AbortController();
    const resultPromise = registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      abortController.signal,
      undefined,
      ctx(),
    );
    abortController.abort();
    const result = await resultPromise;
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: false,
      error: "ChildAbortFailed",
      message:
        "Weave could not confirm the delegated child stopped cleanly; it was terminated.",
      reason: "cancel-subtree-failed",
      retryable: true,
      recovery: "retry",
    });
  });

  it("execute: carries the closed spawn reason so the caller can tell why the child never started", async () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(() =>
            errAsync(
              makeChildSpawnFailedFailure(
                "child-1",
                "invalid session spawn configuration: base command contains a session flag",
              ),
            ),
          ),
      }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.ok).toBe(false);
    expect(text.error).toBe("ChildSpawnFailed");
    expect(text.reason).toBe(
      "invalid session spawn configuration: base command contains a session flag",
    );
    expect(text.message).toBe(
      "Weave could not start the delegated child process.",
    );
  });

  it("execute: surfaces a ChildResponseMissing result failure as retryable structured output, never as transport corruption", async () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(() =>
            errAsync(
              makeChildResponseMissingFailure("child-1", {
                reason: "thinking-only",
                parentId: "root",
                correlationId: "child-1",
              }),
            ),
          ),
      }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.ok).toBe(false);
    expect(text.error).toBe("ChildResponseMissing");
    expect(text.retryable).toBe(true);
    expect(text.recovery).toBe("retry");
    expect(text.reason).toBe("thinking-only");
    expect(text.message).toBe(
      "The delegated child finished without a terminal assistant response.",
    );
    // A missing response is a result failure, never protocol corruption.
    expect(JSON.stringify(text)).not.toContain("ChildEnvelopeMalformed");
    expect(JSON.stringify(text)).not.toContain("ChildSettlementMissing");
  });

  it("execute: a signal that never aborts never touches cancelSubtree, and the once-listener never leaks past the settled call", async () => {
    let cancelSubtreeCalls = 0;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(
            () => okAsync({ outcome: "completed", assistantOutput: "done" }),
            () => {
              cancelSubtreeCalls += 1;
              return okAsync(undefined);
            },
          ),
      }),
    );
    const abortController = new AbortController();
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      abortController.signal,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: true,
      settlement: {
        outcome: "completed",
        finalOutput: "done",
        interventionCount: 0,
      },
    });
    // The tool call already settled successfully; had the abort listener
    // leaked past that point, this would spuriously cancel a subtree that
    // has nothing left to cancel.
    abortController.abort();
    expect(cancelSubtreeCalls).toBe(0);
  });
});

describe("weave_delegate persistent-parent guard", () => {
  it("refuses delegation from a --no-session parent before any child side effect", async () => {
    let idCalls = 0;
    let controllerCalls = 0;
    let bootstrapCalls = 0;
    let envCalls = 0;
    let delegateCalls = 0;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getParentSessionState: () => ({
          persistence: "ephemeral",
          reason: "host-reports-not-persisted",
        }),
        idGenerator: {
          next: () => {
            idCalls += 1;
            return "child-1";
          },
        },
        buildBootstrap: () => {
          bootstrapCalls += 1;
          return {};
        },
        buildEnv: () => {
          envCalls += 1;
          return {};
        },
        getController: () => {
          controllerCalls += 1;
          return fakeController(() => {
            delegateCalls += 1;
            return okAsync({ outcome: "cancelled" } as PiChildSettlement);
          });
        },
      }),
    );

    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );

    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.ok).toBe(false);
    expect(text.error).toBe("PersistentParentSessionRequired");
    expect(text.retryable).toBe(false);
    expect(text.reason).toBe("host-reports-not-persisted");
    expect(text.message).toContain("persistent Pi session");
    // Zero child ids, bootstraps, envs, controller reads, or dispatches: no
    // child process, session file, lease, or parent ref can exist.
    expect([
      idCalls,
      bootstrapCalls,
      envCalls,
      controllerCalls,
      delegateCalls,
    ]).toEqual([0, 0, 0, 0, 0]);
  });

  it("keeps existing delegation behaviour for a persistent parent", async () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getParentSessionState: () => ({
          persistence: "persistent",
          sessionId: "session-a",
          sessionFile: "/sessions/a.jsonl",
        }),
        getController: () =>
          fakeController(() =>
            okAsync({
              outcome: "completed",
              assistantOutput: "done",
            } as PiChildSettlement),
          ),
      }),
    );

    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: true,
      settlement: {
        outcome: "completed",
        finalOutput: "done",
        interventionCount: 0,
      },
    });
  });

  it("refuses delegation when parent persistence is unknown (no probe)", async () => {
    let idCalls = 0;
    let controllerCalls = 0;
    let bootstrapCalls = 0;
    let envCalls = 0;
    let delegateCalls = 0;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getParentSessionState: () => ({
          persistence: "unknown",
          reason: "no-probe",
        }),
        idGenerator: {
          next: () => {
            idCalls += 1;
            return "child-1";
          },
        },
        buildBootstrap: () => {
          bootstrapCalls += 1;
          return {};
        },
        buildEnv: () => {
          envCalls += 1;
          return {};
        },
        getController: () => {
          controllerCalls += 1;
          return fakeController(() => {
            delegateCalls += 1;
            return okAsync({ outcome: "cancelled" } as PiChildSettlement);
          });
        },
      }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.ok).toBe(false);
    expect(text.error).toBe("PersistentParentSessionRequired");
    expect(text.reason).toBe("no-probe");
    expect([
      idCalls,
      bootstrapCalls,
      envCalls,
      controllerCalls,
      delegateCalls,
    ]).toEqual([0, 0, 0, 0, 0]);
  });

  it("refuses delegation when the parent probe failed", async () => {
    let idCalls = 0;
    let controllerCalls = 0;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getParentSessionState: () => ({
          persistence: "unknown",
          reason: "probe-failed",
        }),
        idGenerator: {
          next: () => {
            idCalls += 1;
            return "child-1";
          },
        },
        getController: () => {
          controllerCalls += 1;
          return fakeController(() =>
            okAsync({ outcome: "cancelled" } as PiChildSettlement),
          );
        },
      }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.ok).toBe(false);
    expect(text.error).toBe("PersistentParentSessionRequired");
    expect(text.reason).toBe("probe-failed");
    expect([idCalls, controllerCalls]).toEqual([0, 0]);
  });
});
