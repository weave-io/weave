import { describe, expect, it } from "bun:test";
import {
  PiChildSessionEventSchema,
  PiExtensionUiResponseSchema,
  parsePiChildSessionEvent,
} from "../child-session-events.js";

describe("Pi child session event protocol", () => {
  it("parses every specified observed event kind", () => {
    const kinds = [
      "message_start",
      "message_update",
      "message_end",
      "text",
      "thinking",
      "markdown",
      "tool_call",
      "tool_partial_result",
      "tool_result",
      "tool_error",
      "image",
      "usage",
      "queue_change",
      "status",
      "retry",
      "extension_ui_response",
    ] as const;
    for (const type of kinds) {
      let value: Record<string, string> = { type };
      if (type === "text") value = { type, text: "bounded" };
      if (type === "extension_ui_response") {
        value = { type, requestId: "request-1" };
      }
      expect(PiChildSessionEventSchema.safeParse(value).success).toBe(true);
    }
    for (const requestType of ["notification", "widget", "dialog"] as const) {
      expect(
        PiChildSessionEventSchema.safeParse({
          type: "extension_ui_request",
          requestType,
          requestId: "request-1",
        }).success,
      ).toBe(true);
    }
  });

  it("normalizes Pi native tool execution events", () => {
    const started = parsePiChildSessionEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    expect(started.success).toBe(true);
    if (started.success) {
      expect(started.data).toEqual({
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "read",
        arguments: { path: "README.md" },
      });
    }

    const updated = parsePiChildSessionEvent({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "read",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    expect(updated.success).toBe(true);
    if (updated.success) {
      expect(updated.data).toEqual({
        type: "tool_partial_result",
        toolCallId: "call-1",
        toolName: "read",
        partialResult: { content: [{ type: "text", text: "partial" }] },
      });
    }

    const completed = parsePiChildSessionEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    });
    expect(completed.success).toBe(true);
    if (completed.success) {
      expect(completed.data).toEqual({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "done" }] },
      });
    }

    const failed = parsePiChildSessionEvent({
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "bash",
      result: "command failed",
      isError: true,
    });
    expect(failed.success).toBe(true);
    if (failed.success) {
      expect(failed.data).toEqual({
        type: "tool_error",
        toolCallId: "call-2",
        toolName: "bash",
        error: "command failed",
      });
    }
  });

  it("bounds oversized Pi native tool results without losing their event kind", () => {
    const parsed = parsePiChildSessionEvent({
      type: "tool_execution_end",
      toolCallId: "call-large",
      toolName: "read",
      result: {
        content: [{ type: "text", text: "x".repeat(20_000) }],
      },
      isError: false,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("tool_result");
      expect(parsed.data).toEqual({
        type: "tool_result",
        toolCallId: "call-large",
        toolName: "read",
        result: {
          content: [{ type: "text", text: "x".repeat(16_384) }],
        },
      });
    }
  });

  it("preserves unknown kinds as a bounded unknown variant", () => {
    const parsed = parsePiChildSessionEvent({
      type: "future_event",
      value: "ok",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data).toEqual({
        type: "unknown",
        originalType: "future_event",
        payload: { value: "ok" },
      });
  });

  it("keeps known-schema failures closed and bounds unknown payloads", () => {
    const malformedKnown = parsePiChildSessionEvent({ type: "text", text: 42 });
    expect(malformedKnown.success).toBe(false);

    const oversizedUnknown = parsePiChildSessionEvent({
      type: "x".repeat(1_000),
      ...Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`key-${index}`, "value"]),
      ),
    });
    expect(oversizedUnknown.success).toBe(true);
    if (oversizedUnknown.success && oversizedUnknown.data.type === "unknown") {
      expect(oversizedUnknown.data.originalType).toHaveLength(256);
      expect(Object.keys(oversizedUnknown.data.payload ?? {})).toHaveLength(64);
    }
  });

  it("rejects unbounded event strings and validates the UI response envelope", () => {
    expect(
      PiChildSessionEventSchema.safeParse({
        type: "text",
        text: "x".repeat(16_385),
      }).success,
    ).toBe(false);
    expect(
      PiExtensionUiResponseSchema.safeParse({
        type: "extension_ui_response",
        requestId: "request-1",
        cancelled: true,
      }).success,
    ).toBe(true);
    expect(
      parsePiChildSessionEvent({
        type: "extension_ui_response",
        requestId: "request-1",
        response: { accepted: true },
      }).success,
    ).toBe(true);
  });
});
