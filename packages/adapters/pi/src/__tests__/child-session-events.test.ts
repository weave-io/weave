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

/**
 * The parser boundary is the only place an untrusted child event is inspected.
 *
 * The value arrives over RPC, from a recorded session file, or straight from a
 * host object, so it can be an exotic object rather than plain data. Each
 * fixture below throws from a different reachable step — the `type` read during
 * normalization, enumeration during unknown-event preservation, descriptor
 * lookup, a nested getter reached only by schema validation, or a symbol
 * conversion invoked inside validation — and every one must come back as the
 * ordinary typed parser failure instead of an exception.
 */
describe("Pi child session event hostile boundary", () => {
  const throwing = (message: string): never => {
    throw new Error(message);
  };

  const expectTypedFailure = (value: unknown): void => {
    expect(() => parsePiChildSessionEvent(value)).not.toThrow();
    const parsed = parsePiChildSessionEvent(value);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // A typed Zod failure, and no hostile prose travels with it.
      expect(Array.isArray(parsed.error.issues)).toBe(true);
      expect(JSON.stringify(parsed.error.issues)).not.toContain("hostile");
    }
  };

  it("returns a typed failure for a throwing type getter", () => {
    expectTypedFailure({
      get type(): string {
        return throwing("hostile type getter");
      },
    });
  });

  it("returns a typed failure for a type getter that throws on a later read", () => {
    let reads = 0;
    expectTypedFailure({
      get type(): string {
        reads += 1;
        // Survives normalization, then throws on the fallback read.
        return reads > 1 ? throwing("hostile second read") : "not_a_known_kind";
      },
    });
  });

  it("returns a typed failure for a throwing ownKeys trap", () => {
    expectTypedFailure(
      new Proxy(
        { type: "definitely_unknown_kind", payload: { a: 1 } },
        {
          ownKeys(): never {
            return throwing("hostile ownKeys trap");
          },
        },
      ),
    );
  });

  it("returns a typed failure for a throwing getOwnPropertyDescriptor trap", () => {
    expectTypedFailure(
      new Proxy(
        { type: "definitely_unknown_kind", payload: { a: 1 } },
        {
          getOwnPropertyDescriptor(): never {
            return throwing("hostile descriptor trap");
          },
        },
      ),
    );
  });

  it("returns a typed failure for a throwing get trap", () => {
    expectTypedFailure(
      new Proxy(
        { type: "text", text: "bounded" },
        {
          get(): never {
            return throwing("hostile get trap");
          },
        },
      ),
    );
  });

  it("returns a typed failure for a nested message getter that throws", () => {
    expectTypedFailure({
      type: "message_end",
      get message(): unknown {
        return throwing("hostile nested getter");
      },
    });
  });

  it("returns a typed failure for a throwing accessor descriptor", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "type", {
      get(): never {
        return throwing("hostile accessor");
      },
      enumerable: true,
    });
    expectTypedFailure(hostile);
  });

  it("returns a typed failure for hostile symbol and toJSON traps", () => {
    const symbolTrap: Record<string | symbol, unknown> = {
      type: "text",
      text: { toString: (): never => throwing("hostile toString") },
    };
    Object.defineProperty(symbolTrap, Symbol.toPrimitive, {
      get(): never {
        return throwing("hostile symbol trap");
      },
    });
    expect(() => parsePiChildSessionEvent(symbolTrap)).not.toThrow();
    expect(parsePiChildSessionEvent(symbolTrap).success).toBe(false);

    expectTypedFailure({
      type: "message_end",
      get toJSON(): unknown {
        return throwing("hostile toJSON");
      },
      get message(): unknown {
        return throwing("hostile toJSON message");
      },
    });
  });

  it("returns a typed failure for a throwing nested tool payload", () => {
    // `tool_execution_start` is normalized, which enumerates `args`.
    expectTypedFailure({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: new Proxy(
        { path: "a" },
        {
          ownKeys(): never {
            return throwing("hostile args ownKeys");
          },
        },
      ),
    });
  });

  it("still parses parser-approved real events unchanged", () => {
    const text = parsePiChildSessionEvent({ type: "text", text: "hello" });
    expect(text.success).toBe(true);
    const normalized = parsePiChildSessionEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ text: "ok" }] },
    });
    expect(normalized.success).toBe(true);
    if (normalized.success) expect(normalized.data.type).toBe("tool_result");
    const preserved = parsePiChildSessionEvent({
      type: "brand_new_host_kind",
      detail: "kept",
    });
    expect(preserved.success).toBe(true);
    if (preserved.success) {
      expect(preserved.data.type).toBe("unknown");
      if (preserved.data.type === "unknown") {
        expect(preserved.data.originalType).toBe("brand_new_host_kind");
      }
    }
  });
});
