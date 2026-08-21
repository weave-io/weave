/** Real Pi native tool lifecycle, correlation, and privacy shapes. */

import { describe, expect, it } from "bun:test";
import { childOverlayRailFacts } from "../child-overlay-facts.js";
import {
  TOOL_ERROR_DETAILS_UNAVAILABLE,
  TOOL_RESULT_DETAILS_UNAVAILABLE,
} from "../child-provider-error.js";
import { parsePiChildSessionEvent } from "../child-session-events.js";
import {
  createPiChildTranscriptState,
  reducePiChildTranscript,
} from "../child-transcript.js";
import {
  CALL_ID,
  rowsOf,
  toolResultMessage,
  transcriptOf,
  viewOf,
} from "./child-overlay-real-host-shapes-support.js";

// ---------------------------------------------------------------------------
// 1. Tool arguments and results never print a shape or a withheld sentence
// ---------------------------------------------------------------------------

describe("real Pi tool payloads reach rows as text, never as shapes", () => {
  it("never prints a content block's keys as a tool result", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "bun test" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "bash",
        isError: false,
        result: toolResultMessage(CALL_ID, "bash", "3 files pass", false),
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⚙ bash(command: bun test)");
    expect(joined).toContain("⎿ 3 files pass");
    // The block's own shape, and the correlation bookkeeping that travels
    // with it, are the two things a reader cannot use.
    expect(joined).not.toContain("type: text");
    expect(joined).not.toContain("text:");
    expect(joined).not.toContain("role: toolResult");
    expect(joined).not.toContain("toolCallId");
    expect(joined).not.toContain("timestamp");
  });

  it("never prints a withheld sentence as an argument or a result", () => {
    // A command carrying a storage location is withheld by the closed
    // reducer projection. That is a privacy outcome, not a fact about the
    // run: printing it made the row read as if the child had literally run
    // `Tool result details unavailable.`
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "ls -la /tmp/example" },
      },
      {
        type: "tool_execution_update",
        toolCallId: CALL_ID,
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "total 8\ndrwx" }] },
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⚙ bash(");
    expect(joined).not.toContain(TOOL_RESULT_DETAILS_UNAVAILABLE);
    expect(joined).not.toContain(TOOL_ERROR_DETAILS_UNAVAILABLE);
    expect(joined).not.toContain("details unavailable");
    expect(joined).not.toContain("type: text");
  });

  it("keeps the same discipline on the rail", () => {
    const state = transcriptOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "ls -la /tmp/example" },
      },
      {
        type: "tool_execution_update",
        toolCallId: CALL_ID,
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "total 8\ndrwx" }] },
      },
    ]);
    const rail = childOverlayRailFacts(viewOf(state));
    for (const value of [rail.args, rail.target, rail.toolOutcome]) {
      expect(value ?? "").not.toContain("type: text");
      expect(value ?? "").not.toContain("details unavailable");
    }
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. A terminal event settles the call it belongs to, exactly once
// ---------------------------------------------------------------------------

describe("real terminal tool events replace the call state", () => {
  it("renders one bounded, useful row for each supported tool shape", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: "read-call",
        toolName: "read",
        args: {
          path: "src/main.ts",
          startLine: 12,
          endLine: 18,
          startColumn: 2,
        },
      },
      {
        type: "tool_execution_update",
        toolCallId: "read-call",
        toolName: "read",
        partialResult: { stdout: "lines 12-18" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "read-call",
        toolName: "read",
        result: { stdout: "lines 12-18" },
        isError: false,
      },
      {
        type: "tool_execution_start",
        toolCallId: "edit-call",
        toolName: "edit",
        args: { path: "src/main.ts", operation: "replace", oldText: "secret" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "edit-call",
        toolName: "edit",
        result: { stdout: "edited 1 occurrence" },
        isError: false,
      },
      {
        type: "tool_execution_start",
        toolCallId: "other-call",
        toolName: "question",
        args: { question: "which check?", options: ["unit", "integration"] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "other-call",
        toolName: "question",
        result: { content: "unit" },
        isError: false,
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain(
      "⚙ read(path: src/main.ts, startLine: 12, endLine: 18",
    );
    expect(joined).toContain("⎿ lines 12-18");
    expect(joined).toContain("⚙ edit(path: src/main.ts, operation: replace)");
    expect(joined).toContain("⎿ edited 1 occurrence");
    expect(joined).toContain("⚙ question(question: which check?");
    expect(joined).toContain("⎿ unit");
    expect(joined).not.toContain("oldText");
    expect(joined).not.toContain("/Users/");
    expect(joined).not.toContain("secret");
  });

  it("renders the controlled bash command and result in one row", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "bun test --filter inspector" },
      },
      {
        type: "tool_execution_update",
        toolCallId: CALL_ID,
        toolName: "bash",
        partialResult: { stdout: "83 tests passed" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "bash",
        result: { stdout: "83 tests passed", stderr: "" },
        isError: false,
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⚙ bash(command: bun test --filter inspector)");
    expect(joined).toContain("⎿ 83 tests passed");
    expect(joined.match(/⚙ bash\(/gu)?.length).toBe(1);
    expect(joined.match(/⎿ 83 tests passed/gu)?.length).toBe(1);
    expect(joined).not.toContain("running");
  });

  it("turns running into a result once the call ends", () => {
    const call = {
      type: "tool_execution_start",
      toolCallId: CALL_ID,
      toolName: "bash",
      args: { command: "bun test" },
    };
    expect(rowsOf([call]).join("\n")).toContain("⎿ running");

    const rows = rowsOf([
      call,
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "bash",
        isError: false,
        result: toolResultMessage(CALL_ID, "bash", "3 files pass", false),
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).not.toContain("running");
    expect(joined.match(/⚙ bash\(/gu)?.length).toBe(1);
    expect(joined.match(/⎿/gu)?.length).toBe(1);
  });

  it("settles a call whose id survives only inside the result message", () => {
    // A host that reports the correlation id on the answer rather than on the
    // envelope still ends the call it belongs to; it never opens a second row.
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "bun test" },
      },
      {
        type: "tool_result",
        result: toolResultMessage(CALL_ID, "bash", "3 files pass", false),
      },
    ]);
    const joined = rows.join("\n");
    expect(joined.match(/⚙ bash\(/gu)?.length).toBe(1);
    expect(joined).toContain("⎿ 3 files pass");
    expect(joined).not.toContain("running");
  });

  it("states an error outcome when only the result message says it failed", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "read",
        args: { file: "missing" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "read",
        result: toolResultMessage(CALL_ID, "read", "no such file", true),
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⎿ no such file");
    expect(joined).not.toContain("running");

    const state = transcriptOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "read",
        args: { file: "missing" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "read",
        result: toolResultMessage(CALL_ID, "read", "no such file", true),
      },
    ]);
    const rail = childOverlayRailFacts(viewOf(state));
    expect(rail.failed).toBe(true);
    expect(rail.toolTone).toBe("bad");
    expect(rail.live).toBe("read failed");
  });

  it("never re-settles a call that already answered", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "bun test" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "bash",
        isError: false,
        result: toolResultMessage(CALL_ID, "bash", "3 files pass", false),
      },
      // A second, un-correlated answer belongs to a different call.
      { type: "tool_result", result: { content: "9 files pass" } },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⎿ 3 files pass");
    expect(joined).toContain("⎿ 9 files pass");
  });

  it("rejects impossible native order and duplicate terminal events once", () => {
    const beforeStart = parsePiChildSessionEvent({
      type: "tool_execution_update",
      toolCallId: CALL_ID,
      toolName: "read",
      partialResult: { content: "too early" },
    });
    expect(beforeStart.success).toBe(true);
    if (!beforeStart.success) return;
    const empty = createPiChildTranscriptState();
    const rejected = reducePiChildTranscript(empty, {
      kind: "event",
      event: beforeStart.data,
    });
    expect(rejected.isErr()).toBe(true);
    if (rejected.isOk()) return;
    expect(rejected.error).toEqual({
      type: "TranscriptToolEventInvalid",
      operation: "tool-event",
      reason: "tool-event-before-start",
    });

    const started = parsePiChildSessionEvent({
      type: "tool_execution_start",
      toolCallId: CALL_ID,
      toolName: "read",
      args: { path: "src/main.ts" },
    });
    const ended = parsePiChildSessionEvent({
      type: "tool_execution_end",
      toolCallId: CALL_ID,
      toolName: "read",
      result: { content: "done" },
      isError: false,
    });
    expect(started.success).toBe(true);
    expect(ended.success).toBe(true);
    if (!started.success || !ended.success) return;
    const afterStart = reducePiChildTranscript(empty, {
      kind: "event",
      event: started.data,
    });
    expect(afterStart.isOk()).toBe(true);
    if (afterStart.isErr()) return;
    const afterEnd = reducePiChildTranscript(afterStart.value, {
      kind: "event",
      event: ended.data,
    });
    expect(afterEnd.isOk()).toBe(true);
    if (afterEnd.isErr()) return;
    const duplicate = reducePiChildTranscript(afterEnd.value, {
      kind: "event",
      event: ended.data,
    });
    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isOk()) return;
    expect(duplicate.error).toEqual({
      type: "TranscriptToolEventInvalid",
      operation: "tool-event",
      reason: "duplicate-terminal",
    });
    expect(
      afterEnd.value.entries.filter((entry) => entry.kind === "tool"),
    ).toHaveLength(1);
  });
});
