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
    ] as const;
    for (const type of kinds) {
      const value = type === "text" ? { type, text: "bounded" } : { type };
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
  });
});
