import { describe, expect, it } from "bun:test";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { PiDelegationCardFacts } from "../child-card-model.js";
import type { PiChildRefStatus } from "../child-session-refs.js";
import type {
  PiDelegationController,
  PiDelegationRequest,
  PiThreadRunOutcome,
  PiThreadRunRequest,
} from "../delegation-controller.js";
import {
  buildDelegationToolRegistration,
  buildRelayedDelegationToolRegistration,
  CARD_DETAILS_INVALID_CODE,
  CARD_RENDER_FAILED_CODE,
  formatDelegationAgentName,
  type PiDelegationCardDetails,
  type PiDelegationToolDeps,
  WEAVE_DELEGATION_TOOL_NAME,
} from "../delegation-tool.js";
import {
  makeChildResponseMissingFailure,
  makeChildSpawnFailedFailure,
  makeThreadStaleFailure,
  type PiAdapterFailure,
} from "../errors.js";
import { createOpenSessionMutationGate } from "../required-capability-gate.js";
import type { PiChildSettlement } from "../rpc-child.js";
import type {
  PiSessionContext,
  PiToolResult,
  PiUiThemePort,
} from "../types.js";

/** A minimal valid card payload, used where the facts themselves are not the subject. */
function cardDetails(): PiDelegationCardDetails {
  const facts: PiDelegationCardFacts = {
    schemaVersion: 1,
    tool: "weave_delegate",
    agentName: "shuttle",
    run: { number: 1, action: "start", phase: "responding" },
    status: "running",
    tone: "run",
    settled: false,
    assignment: "do it",
    activity: { kind: "say", text: "working", live: true },
    telemetry: {},
    viewport: { rows: [], above: 0, atBottom: true },
  };
  return { kind: "weave-delegation-card", version: 1, facts };
}

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
  // Mirrors the real controller: a thread only exists once a run was actually
  // registered. Defaulting to `undefined` keeps every failure that never got
  // that far reporting no thread handle at all.
  threadStatus?: (threadId: string) =>
    | {
        readonly threadId: string;
        readonly runs: number;
        readonly status: PiChildRefStatus;
        readonly retryable: boolean;
      }
    | undefined,
): PiDelegationController {
  return {
    delegate,
    cancelSubtree:
      cancelSubtree ??
      (() => {
        throw new Error("cancelSubtree should not have been called");
      }),
    threadStatus: threadStatus ?? (() => undefined),
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
      runtimeSessionId: "session-test",
      identitySource: "session-header",
      sessionFile: "/sessions/test.jsonl",
    }),
    // Model a descriptor-safe host so the deep-module coverage below still
    // exercises the delegation path. Production derives this gate from the
    // real health report, where the exact tested host fails it.
    sessionMutationGate: createOpenSessionMutationGate(),
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

    expect(render("pattern")).toBe(
      `${WEAVE_DELEGATION_TOOL_NAME} \u00b7 Pattern`,
    );
    expect(render("shuttle")).toBe(
      `${WEAVE_DELEGATION_TOOL_NAME} \u00b7 Shuttle`,
    );
    expect(render("shuttle-infra")).toBe(
      `${WEAVE_DELEGATION_TOOL_NAME} \u00b7 Infra-Shuttle`,
    );
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

  it("execute: returns an opaque retrieval thread for an incomplete projection", async () => {
    const output = "界".repeat(30_000);
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(() =>
            okAsync({
              outcome: "completed",
              assistantOutput: output,
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
    const value = JSON.parse((result.content[0] as { text: string }).text) as {
      thread: string;
      settlement: {
        finalOutput: string;
        output: { complete: false; byteLength: number };
      };
    };
    expect(value.thread).toBe("child-1");
    expect(value.settlement.output.complete).toBe(false);
    expect(value.settlement.output.byteLength).toBe(
      new TextEncoder().encode(output).byteLength,
    );
    expect(
      new TextEncoder().encode(value.settlement.finalOutput).byteLength,
    ).toBeLessThanOrEqual(64 * 1_024);
  });

  it("execute: pushes card live updates from session events, not tree snapshots", async () => {
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

    const executePromise = registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      (update) => updates.push(update),
      ctx(),
    );
    // Start run publishes the first card payload before delegate resolves and
    // before this call awaits anything.
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const startDetails = updates[0]?.details as PiDelegationCardDetails;
    expect(startDetails?.kind).toBe("weave-delegation-card");
    expect(startDetails?.version).toBe(1);
    expect(startDetails?.facts.agentName).toBe("shuttle");
    expect(startDetails?.facts.run).toMatchObject({
      number: 1,
      action: "start",
    });
    expect(startDetails?.facts.assignment).toBe("do it");
    expect(startDetails?.facts.settled).toBe(false);
    expect(capturedRequest?.onUpdate).toBeUndefined();
    expect(capturedRequest?.onSessionEvent).toBeDefined();

    capturedRequest?.onSessionEvent?.({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Inspecting the adapter",
      },
    } as never);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const live = updates[updates.length - 1];
    const liveDetails = live?.details as PiDelegationCardDetails;
    expect(liveDetails?.kind).toBe("weave-delegation-card");
    expect(liveDetails?.facts.activity.text).toContain(
      "Inspecting the adapter",
    );
    // Model-visible content stays the activity line, never card chrome.
    expect(live?.content[0]?.type).toBe("text");
    expect((live?.content[0] as { text: string }).text).toBe(
      liveDetails.facts.activity.text,
    );
    for (const frame of ["\u256d", "\u2570", "\u2502", "\u2500"]) {
      expect((live?.content[0] as { text: string }).text).not.toContain(frame);
    }

    const result = await executePromise;
    const finalDetails = result.details as PiDelegationCardDetails;
    expect(finalDetails?.kind).toBe("weave-delegation-card");
    expect(finalDetails?.facts.settled).toBe(true);
    expect(finalDetails?.facts.activity.text).toContain("done");
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: true,
      settlement: {
        outcome: "completed",
        finalOutput: "done",
        interventionCount: 0,
      },
    });

    const renderer = registration.renderResult;
    expect(renderer).toBeDefined();
    const theme: PiUiThemePort = {
      fg: (_color, text) => text,
      bold: (text) => text,
    };
    const collapsedLines =
      renderer?.(live!, { expanded: false, isPartial: true }, theme, {
        args: { agent: "shuttle", task: "do it" },
      }).render(80) ?? [];
    expect(collapsedLines[0]?.startsWith("\u256d")).toBe(true);
    expect(collapsedLines.at(-1)?.startsWith("\u2570")).toBe(true);
    expect(collapsedLines.join("\n")).toContain("Inspecting the adapter");

    const expandedLines =
      renderer?.(live!, { expanded: true, isPartial: true }, theme, {
        args: { agent: "shuttle", task: "do it" },
      }).render(80) ?? [];
    expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);

    const call = registration
      .renderCall?.({ agent: "shuttle", task: "do it" }, theme, {
        args: { agent: "shuttle", task: "do it" },
      })
      ?.render(80)
      .join("\n");
    expect(call).toContain("Shuttle");
  });

  it("renderResult: degrades a foreign (older compact) details payload", () => {
    const codes: string[] = [];
    const registration = buildDelegationToolRegistration(
      baseDeps({
        onCompactRenderFailure: (code) => {
          codes.push(code);
        },
      }),
    );
    const theme: PiUiThemePort = {
      fg: (_color, text) => text,
      bold: (text) => text,
    };
    const rendered = registration
      .renderResult?.(
        {
          content: [{ type: "text", text: "legacy" }],
          details: {
            kind: "weave-delegation-compact",
            lines: ["a", "b", "c"],
            expandedCurrentItem: undefined,
            degraded: false,
          },
        },
        { expanded: false, isPartial: true },
        theme,
        { args: { agent: "shuttle" } },
      )
      ?.render(80)
      .join("\n");
    expect(rendered).toContain("delegation card unavailable");
    expect(rendered).toContain("foreign");
    expect(rendered).not.toContain("old snapshot text");
    expect(codes).toEqual([CARD_DETAILS_INVALID_CODE]);
  });

  it("renderResult: degrades when the theme helper throws", () => {
    const codes: string[] = [];
    const registration = buildDelegationToolRegistration(
      baseDeps({
        onCompactRenderFailure: (code) => {
          codes.push(code);
        },
      }),
    );
    const theme: PiUiThemePort = {
      fg: () => {
        throw new Error("/secret/path must not escape");
      },
      bold: (text) => text,
    };
    const rendered = registration
      .renderResult?.(
        {
          content: [{ type: "text", text: "x" }],
          details: cardDetails(),
        },
        { expanded: false, isPartial: false },
        theme,
        { args: {} },
      )
      ?.render(80)
      .join("\n");
    expect(rendered).toContain("delegation card unavailable");
    expect(codes).toEqual([CARD_RENDER_FAILED_CODE]);
    expect(JSON.stringify(codes)).not.toContain("/secret");
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
    expect(rendered?.trim()).toBe(
      `${WEAVE_DELEGATION_TOOL_NAME} \u00b7 Shuttle`,
    );
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

  it("execute: a failed start whose thread the controller registered as retryable reports the thread handle its own `recovery: retry` needs", async () => {
    const statusCalls: string[] = [];
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(
            () =>
              errAsync(
                makeChildResponseMissingFailure("child-1", {
                  reason: "empty",
                  parentId: "root",
                  correlationId: "child-1",
                }),
              ),
            undefined,
            (threadId) => {
              statusCalls.push(threadId);
              return {
                threadId,
                runs: 1,
                status: "failed",
                retryable: true,
              };
            },
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
    // The declared recovery is `retry`, and `retry` is only callable by naming
    // a thread - so the handle must travel with the failure that offers it.
    expect(text.thread).toBe("child-1");
    // A start's own child id is the opaque thread id it asks the controller about.
    expect(statusCalls).toEqual(["child-1"]);
  });

  it("execute: a failed start reports no thread handle when the controller registered no thread", async () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(
            () =>
              errAsync(
                makeChildResponseMissingFailure("child-1", {
                  reason: "empty",
                  parentId: "root",
                }),
              ),
            undefined,
            () => undefined,
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
    // Fails closed: never hand back a handle no later run could resume.
    expect(text.thread).toBeUndefined();
  });

  it("execute: a failed start reports no thread handle when the controller recorded the thread as non-retryable", async () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(
            () =>
              errAsync(makeChildSpawnFailedFailure("child-1", "spawn refused")),
            undefined,
            (threadId) => ({
              threadId,
              runs: 1,
              status: "failed",
              retryable: false,
            }),
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
    expect(text.thread).toBeUndefined();
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
          runtimeSessionId: "session-a",
          identitySource: "session-header",
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

/**
 * Thread lifecycle call forms (Pi adapter contract §9). Parsing is strict: the
 * tool never guesses which of start, retry, or continue a malformed call meant.
 */
describe("weave_delegate thread lifecycle", () => {
  function threadController(
    resume: (
      request: PiThreadRunRequest,
    ) => ResultAsync<PiThreadRunOutcome, PiAdapterFailure>,
  ): PiDelegationController {
    return {
      delegate: () => {
        throw new Error("start path must not run for a thread action");
      },
      resumeThread: resume,
    } as unknown as PiDelegationController;
  }

  async function run(
    args: Record<string, unknown>,
    controller: PiDelegationController,
  ): Promise<Record<string, unknown>> {
    const registration = buildDelegationToolRegistration(
      baseDeps({ getController: () => controller }),
    );
    const result = await registration.execute(
      "call-1",
      args,
      undefined,
      undefined,
      ctx(),
    );
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  it("retries a thread by opaque id and returns only bounded public fields", async () => {
    let seen: PiThreadRunRequest | undefined;
    const text = await run(
      { action: "retry", thread: "thread-1" },
      threadController((request) => {
        seen = request;
        return okAsync({
          threadId: "thread-1",
          run: 2,
          settlement: {
            outcome: "completed",
            assistantOutput: "done",
          } as PiChildSettlement,
        });
      }),
    );
    expect(seen?.action).toBe("retry");
    expect(seen?.instruction).toBeUndefined();
    expect(seen?.initiator).toEqual({
      kind: "owner",
      parentSessionId: "session-test",
    });
    expect(text).toEqual({
      ok: true,
      thread: "thread-1",
      run: 2,
      status: "completed",
      retryable: false,
      response: "done",
    });
  });

  it("passes a retry instruction larger than the former character cap untouched", async () => {
    let seen: PiThreadRunRequest | undefined;
    const instruction = "界".repeat(8_193);
    await run(
      { action: "retry", thread: "thread-1", instruction },
      threadController((request) => {
        seen = request;
        return okAsync({
          threadId: "thread-1",
          run: 3,
          settlement: { outcome: "cancelled" } as PiChildSettlement,
        });
      }),
    );
    expect(seen?.instruction).toBe(instruction);
  });

  it("reports a cancelled thread run as retryable", async () => {
    const text = await run(
      { action: "retry", thread: "thread-1" },
      threadController(() =>
        okAsync({
          threadId: "thread-1",
          run: 2,
          settlement: { outcome: "cancelled" } as PiChildSettlement,
        }),
      ),
    );
    expect(text).toEqual({
      ok: true,
      thread: "thread-1",
      run: 2,
      status: "cancelled",
      retryable: true,
    });
  });

  it("continues a thread with a large caller task unchanged", async () => {
    let seen: PiThreadRunRequest | undefined;
    const task = "x".repeat(8_193);
    await run(
      { action: "continue", thread: "thread-1", task },
      threadController((request) => {
        seen = request;
        return okAsync({
          threadId: "thread-1",
          run: 2,
          settlement: {
            outcome: "completed",
            assistantOutput: "ok",
          } as PiChildSettlement,
        });
      }),
    );
    expect(seen?.action).toBe("continue");
    expect(seen?.instruction).toBe(task);
  });

  it("refuses a continue without a task rather than inventing one", async () => {
    const text = await run(
      { action: "continue", thread: "thread-1" },
      threadController(() => {
        throw new Error("must not reach the controller");
      }),
    );
    expect(text).toEqual({ ok: false, error: "invalid-delegation-call" });
  });

  it("refuses malformed thread calls", async () => {
    const controller = threadController(() => {
      throw new Error("must not reach the controller");
    });
    const rejected = [
      { action: "retry" },
      { thread: "thread-1" },
      { action: "resume", thread: "thread-1" },
      { action: "retry", thread: "thread-1", task: "x" },
      { action: "continue", thread: "thread-1", task: "x", instruction: "y" },
      { action: "retry", thread: "thread-1", agent: "shuttle" },
      { action: "retry", thread: "thread-1", instruction: "   " },
      { agent: "shuttle", task: "do it", instruction: "extra" },
    ];
    for (const args of rejected) {
      expect(await run(args, controller)).toEqual({
        ok: false,
        error: "invalid-delegation-call",
      });
    }
  });

  it("surfaces a refused thread run as a structured, path-free failure", async () => {
    const text = await run(
      { action: "retry", thread: "thread-1" },
      threadController(() =>
        errAsync(makeThreadStaleFailure("thread-1", "session-missing")),
      ),
    );
    expect(text).toEqual({
      ok: false,
      thread: "thread-1",
      error: "ThreadStale",
      message: "That delegated thread no longer has a usable session.",
      reason: "session-missing",
      retryable: false,
      recovery: "none",
    });
    expect(JSON.stringify(text)).not.toContain("/");
  });

  it("keeps a relayed child tool restricted to starting new delegations", async () => {
    const registration = buildRelayedDelegationToolRegistration({
      targets: TARGETS,
      sessionMutationGate: createOpenSessionMutationGate(),
      getRuntime: () => {
        throw new Error("must not relay a thread action");
      },
    });
    const result = await registration.execute(
      "call-1",
      { action: "retry", thread: "thread-1" },
      undefined,
      undefined,
      ctx(),
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: false,
      error: "invalid-delegation-target",
    });
  });

  it("retry/continue: starts compact projection from onRunAssigned run number/action", async () => {
    const updates: PiToolResult[] = [];
    let seen: PiThreadRunRequest | undefined;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          threadController((request) => {
            seen = request;
            request.onRunAssigned?.({
              threadId: request.threadId,
              runNumber: 3,
              action: request.action,
              agentName: "shuttle",
              childId: "child-run-3",
            });
            request.onSessionEvent?.({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "retrying work",
              },
            } as never);
            return okAsync({
              threadId: request.threadId,
              run: 3,
              settlement: {
                outcome: "completed",
                assistantOutput: "retry done",
              } as PiChildSettlement,
            });
          }),
      }),
    );
    const result = await registration.execute(
      "call-1",
      { action: "retry", thread: "thread-opaque" },
      undefined,
      (update) => updates.push(update),
      ctx(),
    );
    expect(seen?.onRunAssigned).toBeDefined();
    expect(seen?.onSessionEvent).toBeDefined();
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const first = updates[0]?.details as PiDelegationCardDetails;
    expect(first?.facts.run).toMatchObject({ number: 3, action: "retry" });
    const firstJson = JSON.stringify(first);
    expect(firstJson).not.toContain("thread-opaque");
    expect(firstJson).not.toContain("child-run-3");
    const details = result.details as PiDelegationCardDetails;
    expect(details.kind).toBe("weave-delegation-card");
    expect(details.facts.settled).toBe(true);
    expect(details.facts.activity.text).toBe("retry done");
    expect(
      JSON.parse((result.content[0] as { text: string }).text),
    ).toMatchObject({
      ok: true,
      thread: "thread-opaque",
      run: 3,
      status: "completed",
    });
  });

  it("nested/relayed: final card parity from structured settlement only", async () => {
    const registration = buildRelayedDelegationToolRegistration({
      targets: TARGETS,
      sessionMutationGate: createOpenSessionMutationGate(),
      getRuntime: () =>
        ({
          requestDelegation: () =>
            okAsync({
              ok: true,
              settlement: {
                outcome: "completed",
                assistantOutput: "nested-final",
              },
            }),
        }) as never,
    });
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "nested" },
      undefined,
      undefined,
      ctx(),
    );
    const details = result.details as PiDelegationCardDetails;
    expect(details.kind).toBe("weave-delegation-card");
    expect(details.version).toBe(1);
    expect(details.facts.agentName).toBe("shuttle");
    expect(details.facts.settled).toBe(true);
    expect(details.facts.status).toBe("completed");
    expect(details.facts.run).toMatchObject({ number: 1, action: "start" });
    expect(details.facts.activity.text).toBe("nested-final");
    expect(JSON.stringify(details)).not.toContain("/sessions");
    // Structured model output unchanged.
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: true,
      settlement: {
        outcome: "completed",
        assistantOutput: "nested-final",
      },
    });
    const theme: PiUiThemePort = {
      fg: (_color, text) => text,
      bold: (text) => text,
    };
    const rendered =
      registration
        .renderResult?.(result, { expanded: false, isPartial: false }, theme, {
          args: { agent: "shuttle" },
        })
        ?.render(80) ?? [];
    expect(rendered[0]?.startsWith("\u256d")).toBe(true);
    expect(rendered.at(-1)?.startsWith("\u2570")).toBe(true);
    expect(rendered.join("\n")).toContain("nested-final");
    expect(registration.renderShell).toBe("self");
  });
});
