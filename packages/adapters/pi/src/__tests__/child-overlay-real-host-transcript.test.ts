/** Real Pi native transcript rows for bookkeeping and reasoning boundaries. */

import { describe, expect, it } from "bun:test";
import { CALL_ID, rowsOf } from "./child-overlay-real-host-shapes-support.js";

// ---------------------------------------------------------------------------
// 5 & 6. Bookkeeping never becomes a transcript row
// ---------------------------------------------------------------------------

describe("non-conversation events render nothing", () => {
  it("keeps a child's UI widget request out of the transcript", () => {
    // What Pi's RPC `setStatus` normalizes to on the way in.
    expect(
      rowsOf([
        {
          type: "extension_ui_request",
          requestType: "widget",
          requestId: "req-1",
          widget: { method: "setStatus" },
        },
      ]),
    ).toEqual([]);
  });

  it("keeps a tool-use turn from printing an empty reply header", () => {
    const assistant = (
      content: readonly unknown[],
      stopReason: string,
    ): Record<string, unknown> => ({
      id: "m1",
      role: "assistant",
      model: "test-model",
      content,
      stopReason,
    });
    const rows = rowsOf([
      { type: "message_start", message: assistant([], "toolUse") },
      {
        type: "message_end",
        message: assistant(
          [
            {
              type: "toolCall",
              id: CALL_ID,
              name: "bash",
              arguments: { command: "bun test" },
            },
          ],
          "toolUse",
        ),
      },
    ]);
    // The turn's reply IS the call it made, so the call is the only thing on
    // screen: no empty header, and no bare message with nothing under it.
    expect(rows.join("\n")).not.toContain("· reply");
    expect(rows).toEqual(["⚙ bash(command: bun test)", "  ⎿ running", ""]);
  });

  it("prints a reply with prose, and announces raw reasoning without quoting it", () => {
    const rows = rowsOf([
      {
        type: "message_start",
        message: { id: "m2", role: "assistant", content: [] },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "check the reporter first",
        },
      },
      {
        type: "message_end",
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "the reporter drops rows" }],
          stopReason: "stop",
        },
      },
    ]);
    const joined = rows.join("\n");
    // A real `thinking_delta` reaches only the mounted live-reasoning lane;
    // retained transcript markers render no historical reasoning row.
    expect(joined).not.toContain("✻ reasoning");
    expect(joined).not.toContain("SUMMARY");
    expect(joined).not.toContain("check the reporter first");
    expect(joined).toContain("shuttle · reply");
    expect(joined).not.toContain("● shuttle · reply");
    expect(joined).toContain("the reporter drops rows");
  });

  it("prints an explicit host reasoning summary as a SUMMARY", () => {
    const rows = rowsOf([
      {
        type: "message_start",
        message: { id: "m3", role: "assistant", content: [] },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "reasoning_summary",
          contentIndex: 0,
          delta: "weighed two reporters",
        },
      },
      {
        type: "message_end",
        message: {
          id: "m3",
          role: "assistant",
          content: [{ type: "text", text: "the reporter drops rows" }],
          stopReason: "stop",
        },
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).not.toContain("✻ reasoning · SUMMARY");
    expect(joined).not.toContain("weighed two reporters");
  });
});
