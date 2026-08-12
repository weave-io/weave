import { describe, expect, it } from "bun:test";
import {
  type ChildCompactReducerInput,
  type ChildCompactState,
  childCompactLineCount,
  createChildCompactState,
  degradedChildCompactRender,
  mapPiChildSessionEventToCompactInput,
  PiChildCompactProjection,
  projectChildCompact,
  reduceChildCompact,
  reduceChildCompactSafe,
  renderChildCompact,
  renderChildCompactSafe,
  sanitizeChildCompactText,
} from "../child-compact-render.js";
import { formatPiChildProviderError } from "../child-provider-error-render.js";
import type { PiChildSessionEvent } from "../child-session-events.js";
import type { PiChildSettlement } from "../rpc-child.js";

function start(
  threadId = "thread-opaque-1",
  runNumber = 1,
  action: "start" | "retry" | "continue" = "start",
  agentName = "shuttle",
): ChildCompactReducerInput {
  return { kind: "start_run", threadId, runNumber, action, agentName };
}

function fragment(
  text: string,
  itemId = "assistant",
  dedupKey?: string,
  mode: "append" | "replace" = "append",
): ChildCompactReducerInput {
  return {
    kind: "assistant_fragment",
    itemId,
    dedupKey: dedupKey ?? `${itemId}:${text}`,
    text,
    mode,
  };
}

function mustReduce(
  state: ChildCompactState,
  input: ChildCompactReducerInput,
): ChildCompactState {
  const result = reduceChildCompact(state, input);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function linesOf(state: ChildCompactState, expanded = false) {
  const rendered = renderChildCompactSafe(state, { expanded });
  expect(rendered.degraded).toBe(false);
  expect(childCompactLineCount(rendered)).toBe(3);
  expect(rendered.lines).toHaveLength(3);
  return rendered;
}

describe("child-compact-render", () => {
  it("starts a run with a running 3-line block", () => {
    const state = mustReduce(
      createChildCompactState("thread-opaque-1"),
      start(),
    );
    expect(state.currentRunNumber).toBe(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.status).toBe("running");
    expect(state.runs[0]?.frozen).toBe(false);

    const rendered = linesOf(state);
    expect(rendered.lines[0]).toContain("weave_delegate");
    expect(rendered.lines[0]).toContain("shuttle");
    expect(rendered.lines[0]).toContain("running");
    expect(rendered.lines[1]).toBe("…");
    expect(rendered.lines[2]).toContain("run 1");
    expect(rendered.lines[2]).toContain("start");
  });

  it("adds, replaces, and dedups meaningful assistant fragments", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    state = mustReduce(state, fragment("hello", "assistant", "d1", "append"));
    expect(state.runs[0]?.latestMeaningfulFragment).toBe("hello");

    state = mustReduce(state, fragment("world", "assistant", "d2", "append"));
    expect(state.runs[0]?.latestMeaningfulFragment).toBe("hello world");

    // Dedup: same key ignored
    state = mustReduce(state, fragment("IGNORED", "assistant", "d2", "append"));
    expect(state.runs[0]?.latestMeaningfulFragment).toBe("hello world");

    // Replace overwrites item text
    state = mustReduce(
      state,
      fragment("replaced", "assistant", "d3", "replace"),
    );
    expect(state.runs[0]?.latestMeaningfulFragment).toBe("replaced");

    const rendered = linesOf(state);
    expect(rendered.lines[1]).toBe("replaced");
  });

  it("represents out-of-order end-before-start with a placeholder", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    state = mustReduce(state, {
      kind: "assistant_end",
      itemId: "late-msg",
      text: "arrived early",
    });
    const item = state.runs[0]?.items.find((entry) => entry.id === "late-msg");
    expect(item).toBeDefined();
    expect(item?.isPlaceholder).toBe(true);
    expect(item?.ended).toBe(true);
    expect(item?.text).toBe("arrived early");
    expect(state.runs[0]?.latestMeaningfulFragment).toBe("arrived early");

    // Later fragment upgrades the placeholder
    state = mustReduce(
      state,
      fragment("filled", "late-msg", "late-msg:filled", "replace"),
    );
    const upgraded = state.runs[0]?.items.find(
      (entry) => entry.id === "late-msg",
    );
    expect(upgraded?.isPlaceholder).toBe(false);
    expect(upgraded?.text).toBe("filled");
  });

  it("records thinking/tool/control without selecting them as activity", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    state = mustReduce(state, { kind: "thinking", itemId: "th1" });
    state = mustReduce(state, { kind: "tool", itemId: "tool1" });
    state = mustReduce(state, { kind: "control", itemId: "ctl1" });
    expect(state.runs[0]?.latestMeaningfulFragment).toBeUndefined();
    expect(state.runs[0]?.items.map((item) => item.kind).sort()).toEqual([
      "control",
      "thinking",
      "tool",
    ]);

    const rendered = linesOf(state);
    expect(rendered.lines[1]).toBe("…");
    expect(rendered.lines[1]).not.toContain("thinking");
    expect(rendered.lines[1]).not.toContain("tool");
  });

  it("renders the canonical provider error in the parent compact summary", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    state = mustReduce(state, fragment("raw provider preview"));
    const reason = formatPiChildProviderError({
      class: "rate-limit",
      message: "Provider rate limit exceeded. Retry later.",
      httpStatus: 429,
      code: "rate_limit_error",
    });
    state = mustReduce(state, {
      kind: "settle",
      settlement: { outcome: "failed", reason },
    });

    const rendered = linesOf(state).lines.join("\n");
    expect(rendered).toContain(
      "assistant error · rate limit · HTTP 429 · rate_limit_error · Provider rate limit exceeded. Retry later.",
    );
    expect(rendered).not.toContain("raw provider preview");
    expect(rendered).not.toContain("undefined");
  });

  it("settles success, error, and cancel only from Task 8 settlement", () => {
    const successSettlement: PiChildSettlement = {
      outcome: "completed",
      assistantOutput: "final answer",
    };
    const failSettlement: PiChildSettlement = {
      outcome: "failed",
      reason: "boom",
    };
    const cancelSettlement: PiChildSettlement = { outcome: "cancelled" };

    let okState = mustReduce(createChildCompactState("t1"), start());
    okState = mustReduce(okState, fragment("preview noise"));
    okState = mustReduce(okState, { kind: "thinking", itemId: "th" });
    okState = mustReduce(okState, {
      kind: "settle",
      settlement: successSettlement,
    });
    expect(okState.runs[0]?.status).toBe("completed");
    expect(okState.runs[0]?.finalResponse).toBe("final answer");
    expect(okState.runs[0]?.frozen).toBe(true);
    expect(linesOf(okState).lines[1]).toBe("final answer");
    // Settlement authority: not the running preview when final differs
    expect(okState.runs[0]?.latestMeaningfulFragment).toBe("preview noise");

    let failState = mustReduce(createChildCompactState("t2"), start());
    failState = mustReduce(failState, fragment("still running text"));
    failState = mustReduce(failState, {
      kind: "settle",
      settlement: failSettlement,
    });
    expect(failState.runs[0]?.status).toBe("failed");
    expect(linesOf(failState).lines[1]).toBe("boom");
    expect(linesOf(failState).lines[1]).not.toBe("still running text");

    let cancelState = mustReduce(createChildCompactState("t3"), start());
    cancelState = mustReduce(cancelState, {
      kind: "settle",
      settlement: cancelSettlement,
    });
    expect(cancelState.runs[0]?.status).toBe("cancelled");
    expect(linesOf(cancelState).lines[1]).toBe("cancelled");
  });

  it("freezes the prior run block when a retry starts", () => {
    let state = mustReduce(createChildCompactState("t1"), start("t1", 1));
    state = mustReduce(state, fragment("first run answer"));
    state = mustReduce(state, {
      kind: "settle",
      settlement: { outcome: "failed", reason: "retryable" },
    });
    expect(state.runs[0]?.frozen).toBe(true);
    const frozenFragment = state.runs[0]?.latestMeaningfulFragment;
    const frozenError = state.runs[0]?.errorSummary;

    state = mustReduce(state, start("t1", 2, "retry", "shuttle"));
    expect(state.runs).toHaveLength(2);
    expect(state.runs[0]?.frozen).toBe(true);
    expect(state.runs[0]?.latestMeaningfulFragment).toBe(frozenFragment);
    expect(state.runs[0]?.errorSummary).toBe(frozenError);
    expect(state.runs[1]?.frozen).toBe(false);
    expect(state.runs[1]?.status).toBe("running");
    expect(state.currentRunNumber).toBe(2);

    // Mutating the new run must not alter the frozen prior block
    state = mustReduce(
      state,
      fragment("retry attempt text", "assistant", "r1"),
    );
    expect(state.runs[0]?.latestMeaningfulFragment).toBe(frozenFragment);
    expect(state.runs[0]?.errorSummary).toBe(frozenError);
    expect(state.runs[1]?.latestMeaningfulFragment).toBe("retry attempt text");

    const rendered = linesOf(state);
    expect(rendered.lines[1]).toBe("retry attempt text");
    expect(rendered.lines[2]).toContain("retry");
  });

  it("nested delegation has the same compact render parity", () => {
    const apply = (threadId: string) => {
      let state = mustReduce(
        createChildCompactState(threadId),
        start(threadId),
      );
      state = mustReduce(state, fragment("nested-ok", "assistant", "n1"));
      state = mustReduce(state, {
        kind: "settle",
        settlement: { outcome: "completed", assistantOutput: "nested-ok" },
      });
      return linesOf(state).lines;
    };

    expect(apply("parent-thread")).toEqual(apply("nested-child-thread"));
  });

  it("sanitizes ANSI CSI, OSC, raw C1 OSC, and C0/C1 controls", () => {
    const csi = "\u001b[31mRED\u001b[0m";
    const osc = "\u001b]0;title\u0007secret";
    const c1Osc = "\u009d0;title\u0007visible";
    const c0 = "ok\u0008\u0000\u001f";
    const c1 = "x\u009bA";

    expect(sanitizeChildCompactText(csi)).toBe("RED");
    expect(sanitizeChildCompactText(osc)).toBe("secret");
    expect(sanitizeChildCompactText(c1Osc)).toBe("visible");
    expect(sanitizeChildCompactText(c1Osc)).not.toContain("title");
    expect(sanitizeChildCompactText(c0)).toBe("ok");
    expect(sanitizeChildCompactText(`a${c1}b`).includes("\u009b")).toBe(false);

    let state = mustReduce(createChildCompactState("t1"), start());
    state = mustReduce(
      state,
      fragment(`${csi} hi\n\nthere ${osc}`, "assistant", "ansi1"),
    );
    const rendered = linesOf(state);
    expect(rendered.lines[1]).toBe("RED hi there secret");
    expect(rendered.lines.join("\n")).not.toContain("\u001b");
    expect(rendered.lines.join("\n")).not.toContain("\u0007");
  });

  it("settles completed runs from assistantOutput only, never completionCandidate", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    state = mustReduce(state, fragment("preview"));
    state = mustReduce(state, {
      kind: "settle",
      settlement: {
        outcome: "completed",
        completionCandidate: '{"outcome":"success","secret":"nope"}',
      },
    });
    expect(state.runs[0]?.status).toBe("completed");
    expect(state.runs[0]?.finalResponse).toBeUndefined();
    expect(linesOf(state).lines[1]).toBe("…");
    expect(JSON.stringify(linesOf(state))).not.toContain("completionCandidate");
    expect(JSON.stringify(linesOf(state))).not.toContain("secret");

    let withOutput = mustReduce(createChildCompactState("t2"), start());
    withOutput = mustReduce(withOutput, {
      kind: "settle",
      settlement: {
        outcome: "completed",
        assistantOutput: "authoritative",
        completionCandidate: "ignored-candidate",
      },
    });
    expect(withOutput.runs[0]?.finalResponse).toBe("authoritative");
    expect(linesOf(withOutput).lines[1]).toBe("authoritative");
    expect(linesOf(withOutput).lines[1]).not.toContain("ignored-candidate");
  });

  it("always renders exactly 3 collapsed lines", () => {
    const cases: ChildCompactState[] = [];
    cases.push(createChildCompactState("empty"));
    cases.push(mustReduce(createChildCompactState("t1"), start()));
    let running = mustReduce(createChildCompactState("t2"), start());
    running = mustReduce(running, fragment("x"));
    cases.push(running);
    let settled = mustReduce(createChildCompactState("t3"), start());
    settled = mustReduce(settled, {
      kind: "settle",
      settlement: { outcome: "completed", assistantOutput: "done" },
    });
    cases.push(settled);

    for (const state of cases) {
      const rendered = renderChildCompactSafe(state);
      expect(rendered.lines).toHaveLength(3);
      expect(childCompactLineCount(rendered)).toBe(3);
    }
  });

  it("exposes a bounded expanded current item", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    const long = "word ".repeat(200).trim();
    state = mustReduce(state, fragment(long, "assistant", "long1", "replace"));

    const collapsed = linesOf(state, false);
    expect(collapsed.expandedCurrentItem).toBeUndefined();
    expect(
      collapsed.lines[1].startsWith("…") || collapsed.lines[1].length <= 240,
    ).toBe(true);

    const expanded = linesOf(state, true);
    expect(expanded.expandedCurrentItem).toBeDefined();
    expect(expanded.expandedCurrentItem?.includes("word")).toBe(true);
    expect(
      [...(expanded.expandedCurrentItem ?? "")].length,
    ).toBeLessThanOrEqual(4_096);
  });

  it("does not leak path, session, or native ids in chrome lines", () => {
    const sessionPath = "/Users/jose/.pi/agent/sessions/native-abc123.jsonl";
    const nativeId = "sess_native_9f3c";
    let state = mustReduce(
      createChildCompactState(sessionPath),
      start(sessionPath, 1, "start", "shuttle"),
    );
    state = mustReduce(state, fragment("safe answer", "assistant", "s1"));
    state = mustReduce(state, {
      kind: "settle",
      settlement: {
        outcome: "completed",
        assistantOutput: "safe answer",
      },
    });

    const rendered = linesOf(state);
    const chrome = `${rendered.lines[0]}\n${rendered.lines[2]}`;
    expect(chrome).not.toContain(sessionPath);
    expect(chrome).not.toContain(nativeId);
    expect(chrome).not.toContain("/Users/");
    expect(chrome).not.toContain("sessions/");
    expect(JSON.stringify(rendered)).not.toContain("composedPrompt");
    expect(JSON.stringify(rendered)).not.toContain("reasoning");
  });

  it("isolates invalid reduce/render input as a degraded 3-line block", () => {
    const degraded = renderChildCompactSafe(null);
    expect(degraded.degraded).toBe(true);
    expect(degraded.degradedReason).toBe("invalid_input");
    expect(degraded.lines).toHaveLength(3);
    expect(degraded.lines).toEqual(degradedChildCompactRender().lines);

    const projected = projectChildCompact(createChildCompactState("t1"), {
      kind: "not-a-real-kind",
    });
    expect(projected.degraded).toBe(true);
    expect(projected.lines).toHaveLength(3);

    const unchanged = reduceChildCompactSafe(createChildCompactState("t1"), {
      kind: "settle",
      settlement: { outcome: "weird" },
    });
    expect(unchanged.runs).toHaveLength(0);

    // Render Result path also maps errors to degraded via Safe
    const badState = {
      threadId: "t",
      runs: "not-an-array",
      currentRunNumber: 1,
    };
    const fromBad = renderChildCompactSafe(badState);
    expect(fromBad.degraded).toBe(true);
    expect(fromBad.lines).toHaveLength(3);
  });

  it("maps parser-approved session events without selecting thinking as activity", () => {
    let state = mustReduce(createChildCompactState("t1"), start());

    const update: PiChildSessionEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "streamed" },
    };
    const mapped = mapPiChildSessionEventToCompactInput(update);
    expect(mapped.isOk()).toBe(true);
    const input = mapped._unsafeUnwrap();
    expect(input?.kind).toBe("assistant_fragment");
    if (input?.kind === "assistant_fragment") {
      state = mustReduce(state, input);
    }
    expect(state.runs[0]?.latestMeaningfulFragment).toBe("streamed");

    const thinkingEvent: PiChildSessionEvent = {
      type: "thinking",
      text: "secret chain of thought",
    };
    const thinkingMapped = mapPiChildSessionEventToCompactInput(thinkingEvent);
    expect(thinkingMapped.isOk()).toBe(true);
    const thinkingInput = thinkingMapped._unsafeUnwrap();
    expect(thinkingInput?.kind).toBe("thinking");
    if (thinkingInput !== undefined) {
      state = mustReduce(state, thinkingInput);
    }
    expect(state.runs[0]?.latestMeaningfulFragment).toBe("streamed");
    expect(linesOf(state).lines[1]).toBe("streamed");
    expect(linesOf(state).lines.join("\n")).not.toContain(
      "secret chain of thought",
    );
  });

  it("skips whitespace-only and control-only fragments as activity", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    state = mustReduce(state, fragment("   \n\t  ", "assistant", "ws"));
    expect(state.runs[0]?.latestMeaningfulFragment).toBeUndefined();
    state = mustReduce(
      state,
      fragment("\u001b[31m\u001b[0m", "assistant", "ctrl"),
    );
    expect(state.runs[0]?.latestMeaningfulFragment).toBeUndefined();
    expect(linesOf(state).lines[1]).toBe("…");
  });

  it("renderChildCompact Result path succeeds for valid state", () => {
    const state = mustReduce(createChildCompactState("t1"), start());
    const result = renderChildCompact(state);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().lines).toHaveLength(3);
  });

  it("maps tool events with toolCallId as the stable item id", () => {
    const event: PiChildSessionEvent = {
      type: "tool_call",
      toolCallId: "call-stable-9",
      toolName: "bash",
    };
    const mapped = mapPiChildSessionEventToCompactInput(event);
    expect(mapped.isOk()).toBe(true);
    const input = mapped._unsafeUnwrap();
    expect(input).toEqual({ kind: "tool", itemId: "call-stable-9" });
  });

  describe("PiChildCompactProjection", () => {
    it("correlates message ids across start/update/end and ignores thinking activity", () => {
      const projection = new PiChildCompactProjection({
        threadId: "thread-opaque-proj",
        agentName: "shuttle",
      });
      const started = projection.startRun({ runNumber: 1, action: "start" });
      expect(started.lines).toHaveLength(3);
      expect(started.lines[0]).toContain("running");

      projection.applySessionEvent({
        type: "message_start",
        message: { id: "asst-42", role: "assistant", content: [] },
      });
      projection.applySessionEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "hello",
          messageId: "asst-42",
        },
      });
      projection.applySessionEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "secret thought",
        },
      });
      projection.applySessionEvent({
        type: "tool_call",
        toolCallId: "tool-7",
        toolName: "read",
      });
      const mid = projection.applySessionEvent({
        type: "message_end",
        message: {
          id: "asst-42",
          role: "assistant",
          content: [{ type: "text", text: "hello world" }],
        },
      });
      expect(mid.lines[1]).toContain("hello");
      expect(mid.lines.join("\n")).not.toContain("secret thought");

      const items = projection.getState().runs[0]?.items ?? [];
      expect(items.some((item) => item.id === "asst-42")).toBe(true);
      expect(items.some((item) => item.id === "tool-7")).toBe(true);

      const settled = projection.settle({
        outcome: "completed",
        assistantOutput: "final assembled",
        completionCandidate: "must-not-appear",
      });
      expect(settled.lines[1]).toBe("final assembled");
      expect(settled.lines.join("\n")).not.toContain("must-not-appear");
      expect(settled.degraded).toBe(false);
    });

    it("freezes prior run on retry and keeps render isolation", () => {
      const projection = new PiChildCompactProjection({
        threadId: "t-retry",
        agentName: "shuttle",
      });
      projection.startRun({ runNumber: 1, action: "start" });
      projection.applySessionEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "first" },
      });
      projection.settle({ outcome: "failed", reason: "retryable" });
      const retry = projection.startRun({ runNumber: 2, action: "retry" });
      expect(retry.lines[2]).toContain("retry");
      expect(projection.getState().runs[0]?.frozen).toBe(true);
      expect(projection.getState().runs[0]?.errorSummary).toBe("retryable");

      projection.applySessionEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "second" },
      });
      expect(projection.getState().runs[0]?.latestMeaningfulFragment).toBe(
        "first",
      );
      expect(projection.render().lines[1]).toBe("second");
    });
  });
});
