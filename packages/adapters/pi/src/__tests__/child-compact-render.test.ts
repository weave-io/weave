import { describe, expect, it } from "bun:test";
import {
  type ChildCompactReducerInput,
  type ChildCompactState,
  childCompactChromeIsClean,
  createChildCompactState,
  isChildCompactState,
  mapPiChildSessionEventToCompactInput,
  reduceChildCompact,
  reduceChildCompactSafe,
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
    ...(dedupKey === undefined ? {} : { dedupKey }),
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

/**
 * The one fact both surfaces read off a run: the text a reader would see as the
 * child's current activity. Settlement outranks the running preview.
 */
function activityOf(state: ChildCompactState): string | undefined {
  const run = state.runs.find(
    (candidate) => candidate.runNumber === state.currentRunNumber,
  );
  if (run === undefined) return undefined;
  if (run.status === "completed") return run.finalResponse;
  if (run.status === "failed" || run.status === "cancelled") {
    return run.errorSummary;
  }
  return run.latestMeaningfulFragment;
}

describe("child-compact-render", () => {
  it("starts a run in the running state", () => {
    const state = mustReduce(
      createChildCompactState("thread-opaque-1"),
      start(),
    );
    expect(state.currentRunNumber).toBe(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.status).toBe("running");
    expect(state.runs[0]?.frozen).toBe(false);
    expect(state.runs[0]?.agentName).toBe("shuttle");
    expect(state.runs[0]?.action).toBe("start");
    expect(state.runs[0]?.runNumber).toBe(1);
    // A fresh run has nothing to say yet, and says nothing rather than "".
    expect(activityOf(state)).toBeUndefined();
  });

  it("adds, replaces, and dedups meaningful assistant fragments", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    state = mustReduce(state, fragment("hello ", "assistant", "d1", "append"));
    expect(state.runs[0]?.latestMeaningfulFragment).toBe("hello");

    // Fragments are concatenated EXACTLY, in order. The separator is whatever
    // the child streamed - inventing one turns ["hel", "lo"] into "hel lo".
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
    expect(activityOf(state)).toBe("replaced");
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
    // Recorded, but never promoted to activity.
    expect(activityOf(state)).toBeUndefined();
  });

  it("carries the canonical provider error as the run error summary", () => {
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

    const activity = activityOf(state) ?? "";
    expect(activity).toContain(
      "assistant error · rate limit · HTTP 429 · rate_limit_error · Provider rate limit exceeded. Retry later.",
    );
    expect(activity).not.toContain("raw provider preview");
    expect(activity).not.toContain("undefined");
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
    expect(activityOf(okState)).toBe("final answer");
    // Settlement authority: not the running preview when final differs
    expect(okState.runs[0]?.latestMeaningfulFragment).toBe("preview noise");

    let failState = mustReduce(createChildCompactState("t2"), start());
    failState = mustReduce(failState, fragment("still running text"));
    failState = mustReduce(failState, {
      kind: "settle",
      settlement: failSettlement,
    });
    expect(failState.runs[0]?.status).toBe("failed");
    expect(activityOf(failState)).toBe("boom");
    expect(activityOf(failState)).not.toBe("still running text");

    let cancelState = mustReduce(createChildCompactState("t3"), start());
    cancelState = mustReduce(cancelState, {
      kind: "settle",
      settlement: cancelSettlement,
    });
    expect(cancelState.runs[0]?.status).toBe("cancelled");
    expect(activityOf(cancelState)).toBe("cancelled");
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
    expect(activityOf(state)).toBe("retry attempt text");
    expect(state.runs[1]?.action).toBe("retry");
  });

  it("nested delegation reduces to the same run facts", () => {
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
      return {
        activity: activityOf(state),
        status: state.runs[0]?.status,
        action: state.runs[0]?.action,
      };
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
    const activity = activityOf(state) ?? "";
    expect(activity).toBe("RED hi there secret");
    expect(activity).not.toContain("\u001b");
    expect(activity).not.toContain("\u0007");
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
    expect(activityOf(state)).toBeUndefined();
    expect(JSON.stringify(state.runs[0])).not.toContain("completionCandidate");
    expect(JSON.stringify(state.runs[0])).not.toContain("secret");

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
    expect(activityOf(withOutput)).toBe("authoritative");
    expect(activityOf(withOutput)).not.toContain("ignored-candidate");
  });

  it("bounds a long fragment to the sanitizer's own projection cap", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    const long = "word ".repeat(2_000).trim();
    state = mustReduce(state, fragment(long, "assistant", "long1", "replace"));

    const activity = activityOf(state) ?? "";
    expect(activity.length).toBeGreaterThan(0);
    expect(activity.startsWith("word")).toBe(true);
    // Retained text never exceeds the shared 4 KiB projection.
    expect(Buffer.byteLength(activity, "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("does not leak path, session, or native ids in chrome text", () => {
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

    // The chrome a surface builds from run facts carries no opaque id.
    const run = state.runs[0];
    const chrome = `weave_delegate · ${run?.agentName} · ${run?.status}\nrun ${run?.runNumber} · ${run?.action}`;
    expect(childCompactChromeIsClean(chrome, state)).toBe(true);
    expect(chrome).not.toContain(sessionPath);
    expect(chrome).not.toContain(nativeId);
    expect(chrome).not.toContain("/Users/");
    expect(chrome).not.toContain("sessions/");
    expect(JSON.stringify(run)).not.toContain("composedPrompt");
    expect(JSON.stringify(run)).not.toContain("reasoning");

    // And a surface that *did* echo the opaque id is caught, not painted.
    expect(childCompactChromeIsClean(`run 1 · ${sessionPath}`, state)).toBe(
      false,
    );
  });

  it("isolates invalid reduce input and leaves state untouched", () => {
    const base = mustReduce(createChildCompactState("t1"), start());

    // Unknown kind: typed error, prior state returned unchanged.
    const unknownKind = reduceChildCompactSafe(base, {
      kind: "not-a-real-kind",
    });
    expect(unknownKind).toBe(base);

    const badSettlement = reduceChildCompactSafe(
      createChildCompactState("t1"),
      {
        kind: "settle",
        settlement: { outcome: "weird" },
      },
    );
    expect(badSettlement.runs).toHaveLength(0);

    // Structural guard for state that crossed an untyped boundary.
    expect(isChildCompactState(base)).toBe(true);
    expect(isChildCompactState(null)).toBe(false);
    expect(
      isChildCompactState({
        threadId: "t",
        runs: "not-an-array",
        currentRunNumber: 1,
      }),
    ).toBe(false);
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
    expect(activityOf(state)).toBe("streamed");
    expect(JSON.stringify(state.runs[0])).not.toContain(
      "secret chain of thought",
    );
  });

  it("keeps every repeated streamed delta instead of matching on text", () => {
    // The wire gives a `text_delta` no identity: `toJsonEvent` strips the
    // cumulative `partial`, and `contentIndex` names the content block every
    // delta of one answer shares. Keying on the delta's own words deleted the
    // second `the ` of a sentence and printed an answer the child never gave.
    let state = mustReduce(createChildCompactState("t1"), start());
    const deltas = ["the ", "cat ", "and ", "the ", "hat ", "and ", "the "];
    for (const delta of deltas) {
      const mapped = mapPiChildSessionEventToCompactInput({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta },
      } as unknown as PiChildSessionEvent);
      const input = mapped._unsafeUnwrap();
      expect(input?.kind).toBe("assistant_fragment");
      if (input?.kind === "assistant_fragment") {
        // No key at all, so nothing downstream can suppress it.
        expect(input.dedupKey).toBeUndefined();
        state = mustReduce(state, input);
      }
    }
    expect(activityOf(state)).toBe("the cat and the hat and the");

    // An unkeyed fragment consumes no dedup budget either.
    expect(state.runs[0]?.dedupKeys.size).toBe(0);
  });

  it("still suppresses a repeat of an authoritatively identified fragment", () => {
    // `message_start` is the one fragment the protocol identifies: it happens
    // once per message, and its `replace` of the item text would erase an
    // answer already streamed into it.
    let state = mustReduce(createChildCompactState("t1"), start());
    const startMessage = mapPiChildSessionEventToCompactInput({
      type: "message_start",
      message: { id: "asst-9", role: "assistant", content: [] },
    } as unknown as PiChildSessionEvent)._unsafeUnwrap();
    expect(startMessage?.kind).toBe("assistant_fragment");
    if (startMessage?.kind === "assistant_fragment") {
      expect(startMessage.dedupKey).toBe("assistant:start");
      state = mustReduce(state, startMessage);
      state = mustReduce(state, fragment("answered"));
      expect(activityOf(state)).toBe("answered");
      // The duplicate start changes nothing.
      state = mustReduce(state, startMessage);
    }
    expect(activityOf(state)).toBe("answered");
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
    expect(activityOf(state)).toBeUndefined();
  });

  it("reduceChildCompact Result path succeeds for valid input", () => {
    const result = reduceChildCompact(createChildCompactState("t1"), start());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().runs).toHaveLength(1);
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
    expect(input).toEqual({
      kind: "tool",
      itemId: "call-stable-9",
      phase: "call",
      toolName: "bash",
    });
  });

  it("maps operational events to typed inputs instead of a generic control", () => {
    const mapOne = (
      event: PiChildSessionEvent,
    ): ChildCompactReducerInput | undefined =>
      mapPiChildSessionEventToCompactInput(event, "assistant")._unsafeUnwrap();

    expect(
      mapOne({
        type: "tool_result",
        toolCallId: "call-7",
        content: [{ type: "text", text: "1 replacement" }],
      }),
    ).toEqual({
      kind: "tool",
      itemId: "call-7",
      phase: "result",
      detail: "1 replacement",
    });

    expect(
      mapOne({ type: "tool_error", toolCallId: "call-7", error: "exit 1" }),
    ).toEqual({
      kind: "tool",
      itemId: "call-7",
      phase: "error",
      detail: "exit 1",
    });

    // Raw chain-of-thought maps to a content-free marker: its text is dropped
    // at the mapper, so no downstream surface can print or persist it.
    expect(mapOne({ type: "thinking", text: "weighing options" })).toEqual({
      kind: "thinking",
      itemId: "assistant:thinking",
    });

    // Only the host's explicit reasoning summary carries text.
    expect(
      mapOne({ type: "reasoning_summary", text: "weighed two fixes" }),
    ).toEqual({
      kind: "reasoning_summary",
      itemId: "assistant:reasoning-summary",
      summary: "weighed two fixes",
    });

    expect(
      mapOne({
        type: "usage",
        usage: {
          input: 100,
          output: 20,
          totalTokens: 120,
          cost: { total: 0.5 },
        },
      }),
    ).toEqual({
      kind: "usage",
      itemId: "assistant:control:usage",
      usage: {
        totalTokens: 120,
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.5,
      },
    });

    expect(mapOne({ type: "queue_change", size: 2 })).toEqual({
      kind: "queue",
      itemId: "assistant:control:queue_change",
      size: 2,
    });

    expect(mapOne({ type: "status", status: "tool call" })).toEqual({
      kind: "status",
      itemId: "assistant:control:status",
      status: "tool call",
    });

    expect(mapOne({ type: "retry", attempt: 2, reason: "overloaded" })).toEqual(
      {
        kind: "retry",
        itemId: "assistant:control:retry",
        attempt: 2,
        reason: "overloaded",
      },
    );

    expect(
      mapOne({ type: "unknown", originalType: "host_only", payload: {} }),
    ).toEqual({
      kind: "control",
      itemId: "assistant:control:unknown",
    });
  });

  it("records every operational input as one compact control item", () => {
    let state = mustReduce(createChildCompactState("t1"), start());
    state = mustReduce(state, {
      kind: "usage",
      itemId: "u1",
      usage: { totalTokens: 10 },
    });
    state = mustReduce(state, { kind: "queue", itemId: "q1", size: 1 });
    state = mustReduce(state, { kind: "status", itemId: "s1", status: "tool" });
    state = mustReduce(state, { kind: "retry", itemId: "r1", attempt: 2 });
    expect(state.runs[0]?.items.map((item) => item.kind)).toEqual([
      "control",
      "control",
      "control",
      "control",
    ]);
    // Operational facts never become activity.
    expect(activityOf(state)).toBeUndefined();
  });
});
