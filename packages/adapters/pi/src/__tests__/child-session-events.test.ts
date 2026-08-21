import { describe, expect, it } from "bun:test";
import fixture from "../__fixtures__/pi-0.84.2-child-ui-events.v1.json";
import {
  isPiAuthoritativeToolEvent,
  type PiChildSessionEvent,
  PiChildSessionEventSchema,
  PiExtensionUiResponseSchema,
  parsePiChildSessionEvent,
  retainedChildSessionEvent,
} from "../child-session-events.js";

describe("Pi child session event protocol", () => {
  it("replays every captured Pi 0.84.2 event through the parser boundary", () => {
    const events = (
      fixture as {
        readonly events: readonly {
          readonly payload: Record<string, unknown>;
        }[];
      }
    ).events;
    expect(events.length).toBeGreaterThan(0);
    const parsedTypes: string[] = [];
    for (const captured of events) {
      const parsed = parsePiChildSessionEvent(captured.payload);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      parsedTypes.push(parsed.data.type);
    }
    expect(parsedTypes).toContain("message_update");
    expect(parsedTypes).toContain("tool_call");
    expect(parsedTypes).toContain("tool_result");
    expect(parsedTypes).toContain("message_end");
  });

  it("rejects a descriptor mutation instead of invoking its accessor", () => {
    let reads = 0;
    const event: Record<string, unknown> = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    };
    Object.defineProperty(event.assistantMessageEvent as object, "delta", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "must not be read";
      },
    });
    const parsed = parsePiChildSessionEvent(event);
    expect(parsed.success).toBe(true);
    expect(reads).toBe(0);
    if (parsed.success) {
      expect(parsed.data).toEqual({ type: "message_update" });
      expect(JSON.stringify(parsed.data)).not.toContain("must not be read");
    }
  });

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

    const nested = parsePiChildSessionEvent({
      type: "tool_execution_end",
      toolName: "bash",
      result: {
        toolCallId: "nested-call",
        stdout: "SENTINEL output",
        stderr: "password=hidden",
      },
      isError: false,
    });
    expect(nested.success).toBe(true);
    if (nested.success) {
      expect(nested.data).toMatchObject({
        type: "tool_result",
        toolCallId: "nested-call",
        result: {
          toolCallId: "nested-call",
          stdout: "[redacted]",
          stderr: "[redacted]",
        },
      });
      expect(isPiAuthoritativeToolEvent(nested.data)).toBe(true);
      expect(JSON.stringify(nested.data)).not.toContain("SENTINEL");
      expect(JSON.stringify(nested.data)).not.toContain("password=hidden");
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
    if (parsed.success) {
      expect(parsed.data).toEqual({
        type: "unknown",
        originalType: "future_event",
        payload: { value: "ok" },
      });
      expect(retainedChildSessionEvent(parsed.data)).toEqual(parsed.data);
    }
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

  it.each([
    "turn_end",
    "agent_end",
  ] as const)("drops raw reasoning from terminal lifecycle events before retention (%s)", (type) => {
    const sentinel = "LIVE-TERMINAL-REASONING";
    const parsed = parsePiChildSessionEvent(
      type === "turn_end"
        ? {
            type,
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: sentinel }],
            },
            toolResults: [],
          }
        : {
            type,
            messages: [
              {
                role: "assistant",
                content: [{ type: "thinking", thinking: sentinel }],
              },
            ],
            willRetry: false,
          },
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The parser deliberately keeps the bounded host payload as an unknown
    // event. The retention boundary, not a sentinel-specific observer,
    // removes this real Pi terminal carrier.
    expect(JSON.stringify(parsed.data).includes(sentinel)).toBe(true);
    expect(retainedChildSessionEvent(parsed.data)).toBeUndefined();
  });

  it("fails closed without invoking an unknown-event originalType accessor", () => {
    let reads = 0;
    const event = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(event, "type", {
      enumerable: true,
      value: "unknown",
    });
    Object.defineProperty(event, "originalType", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "turn_end";
      },
    });

    expect(
      retainedChildSessionEvent(event as unknown as PiChildSessionEvent),
    ).toBeUndefined();
    expect(reads).toBe(0);
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

  it("returns a typed failure for a throwing type getter without invoking it", () => {
    let reads = 0;
    const value = {
      get type(): string {
        reads += 1;
        return throwing("hostile type getter");
      },
    };
    expectTypedFailure(value);
    expect(reads).toBe(0);
  });

  it("reads type once through a descriptor and never invokes a type getter", () => {
    let reads = 0;
    const value = {
      get type(): string {
        reads += 1;
        return "not_a_known_kind";
      },
    };
    expect(() => parsePiChildSessionEvent(value)).not.toThrow();
    const parsed = parsePiChildSessionEvent(value);
    expect(reads).toBe(0);
    expect(parsed.success).toBe(false);
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

  it("never invokes a throwing get trap when descriptors already state a known event", () => {
    let getReads = 0;
    const value = new Proxy(
      { type: "text", text: "bounded" },
      {
        get(): never {
          getReads += 1;
          return throwing("hostile get trap");
        },
      },
    );
    expect(() => parsePiChildSessionEvent(value)).not.toThrow();
    const parsed = parsePiChildSessionEvent(value);
    expect(getReads).toBe(0);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ type: "text", text: "bounded" });
    }
  });

  it("omits a nested message getter and never invokes it", () => {
    let reads = 0;
    const value = {
      type: "message_end",
      get message(): unknown {
        reads += 1;
        return throwing("hostile nested getter");
      },
    };
    expect(() => parsePiChildSessionEvent(value)).not.toThrow();
    const parsed = parsePiChildSessionEvent(value);
    expect(reads).toBe(0);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ type: "message_end" });
      expect("message" in parsed.data).toBe(false);
    }
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

  it("returns a typed failure for hostile symbol traps and omits toJSON accessors", () => {
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

    let toJsonReads = 0;
    let messageReads = 0;
    const accessors = {
      type: "message_end",
      get toJSON(): unknown {
        toJsonReads += 1;
        return throwing("hostile toJSON");
      },
      get message(): unknown {
        messageReads += 1;
        return throwing("hostile toJSON message");
      },
    };
    expect(() => parsePiChildSessionEvent(accessors)).not.toThrow();
    const parsed = parsePiChildSessionEvent(accessors);
    expect(toJsonReads).toBe(0);
    expect(messageReads).toBe(0);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ type: "message_end" });
      expect("message" in parsed.data).toBe(false);
    }
  });

  it("drops a throwing nested tool payload instead of enumerating it", () => {
    // `args` is not plain data, so it is omitted. Normalization then sees only
    // the descriptor-safe call identity.
    const value = {
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
    };
    expect(() => parsePiChildSessionEvent(value)).not.toThrow();
    const parsed = parsePiChildSessionEvent(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "read",
      });
      expect(
        (parsed.data as { arguments?: unknown }).arguments,
      ).toBeUndefined();
    }
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

/**
 * Event-kind dispatch may consult `type` only as an own enumerable data
 * string. A getter, inherited value, or other non-stated kind must not select
 * a known parser or the Pi 0.84 queue normalizer.
 */
describe("Pi child session event type authority", () => {
  const expectNotKnownKind = (value: unknown): void => {
    expect(() => parsePiChildSessionEvent(value)).not.toThrow();
    const parsed = parsePiChildSessionEvent(value);
    if (parsed.success) {
      expect(parsed.data.type).toBe("unknown");
      expect(JSON.stringify(parsed.data)).not.toContain("queue_change");
      expect(JSON.stringify(parsed.data)).not.toContain("tool_call");
    } else {
      expect(parsed.success).toBe(false);
    }
  };

  it("does not invoke a type getter that names queue_update", () => {
    let reads = 0;
    const value: Record<string, unknown> = {
      steering: ["steer"],
      followUp: ["later"],
    };
    Object.defineProperty(value, "type", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return "queue_update";
      },
    });
    expectNotKnownKind(value);
    expect(reads).toBe(0);
  });

  it("does not invoke a type getter that names a known text event", () => {
    let reads = 0;
    const value = {
      get type(): string {
        reads += 1;
        return "text";
      },
      text: "bounded",
    };
    expectNotKnownKind(value);
    expect(reads).toBe(0);
  });

  it("does not accept an inherited queue_update as a queue report", () => {
    const value = Object.create({ type: "queue_update" }) as Record<
      string,
      unknown
    >;
    value.steering = ["steer"];
    value.followUp = ["later"];
    expectNotKnownKind(value);
  });

  it("does not accept an inherited tool_execution_start as a tool call", () => {
    const value = Object.create({
      type: "tool_execution_start",
    }) as Record<string, unknown>;
    value.toolCallId = "call-1";
    value.toolName = "read";
    value.args = { path: "README.md" };
    expectNotKnownKind(value);
  });

  it("does not accept a non-enumerable type as a queue report", () => {
    const value: Record<string, unknown> = {
      steering: ["steer"],
      followUp: ["later"],
    };
    Object.defineProperty(value, "type", {
      enumerable: false,
      configurable: true,
      writable: true,
      value: "queue_update",
    });
    expectNotKnownKind(value);
  });

  it("does not accept a boxed or non-string type as a queue report", () => {
    expectNotKnownKind({
      type: new String("queue_update"),
      steering: ["steer"],
      followUp: ["later"],
    });
    expectNotKnownKind({
      type: 42,
      steering: ["steer"],
      followUp: ["later"],
    });
  });

  it("preserves an overbound type as unknown rather than a known kind", () => {
    const parsed = parsePiChildSessionEvent({
      type: `text${"x".repeat(300)}`,
      text: "bounded",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("unknown");
      if (parsed.data.type === "unknown") {
        expect(parsed.data.originalType).toHaveLength(256);
      }
    }
  });

  it("does not grant known-event authority when a proxy get forges queue_change", () => {
    let getReads = 0;
    const value = new Proxy(
      {
        type: "forged_unknown_kind",
        steering: ["steer"],
        followUp: ["later"],
      },
      {
        get(source, key, receiver) {
          getReads += 1;
          if (key === "type") return "queue_change";
          return Reflect.get(source, key, receiver);
        },
      },
    );
    expect(() => parsePiChildSessionEvent(value)).not.toThrow();
    const parsed = parsePiChildSessionEvent(value);
    expect(getReads).toBe(0);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("unknown");
      expect(JSON.stringify(parsed.data)).not.toContain("queue_change");
    }
  });

  it("does not let Zod read a proxy whose field descriptors diverge from get", () => {
    let getReads = 0;
    const value = new Proxy(
      { type: "text", text: "descriptor-safe" },
      {
        get(source, key, receiver) {
          getReads += 1;
          if (key === "text") return "forged-via-get";
          return Reflect.get(source, key, receiver);
        },
      },
    );
    const parsed = parsePiChildSessionEvent(value);
    expect(getReads).toBe(0);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        type: "text",
        text: "descriptor-safe",
      });
      expect(JSON.stringify(parsed.data)).not.toContain("forged-via-get");
    }
  });

  it("does not let Zod or the queue normalizer read divergent queue fields via get", () => {
    let getReads = 0;
    const queued = new Proxy(
      {
        type: "queue_update",
        steering: ["steer"],
        followUp: ["later"],
      },
      {
        get(source, key, receiver) {
          getReads += 1;
          if (key === "steering") return ["forged-steer"];
          if (key === "followUp") return ["forged-later"];
          if (key === "size") return 99;
          if (key === "queue") return ["forged-queue"];
          return Reflect.get(source, key, receiver);
        },
      },
    );
    const parsed = parsePiChildSessionEvent(queued);
    expect(getReads).toBe(0);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        type: "queue_change",
        size: 2,
        queue: ["steer", "later"],
      });
      expect(JSON.stringify(parsed.data)).not.toContain("forged");
    }

    getReads = 0;
    const change = new Proxy(
      { type: "queue_change", size: 0, queue: [] },
      {
        get(source, key, receiver) {
          getReads += 1;
          if (key === "size") return 99;
          if (key === "queue") return ["forged-queue"];
          return Reflect.get(source, key, receiver);
        },
      },
    );
    const parsedChange = parsePiChildSessionEvent(change);
    expect(getReads).toBe(0);
    expect(parsedChange.success).toBe(true);
    if (parsedChange.success) {
      expect(parsedChange.data).toMatchObject({
        type: "queue_change",
        size: 0,
        queue: [],
      });
      expect(JSON.stringify(parsedChange.data)).not.toContain("forged");
    }
  });

  it("still accepts an own enumerable data type for known and unknown events", () => {
    const text = parsePiChildSessionEvent({ type: "text", text: "hello" });
    expect(text.success).toBe(true);
    if (text.success) expect(text.data.type).toBe("text");

    const queued = parsePiChildSessionEvent({
      type: "queue_update",
      steering: ["steer"],
      followUp: ["later"],
    });
    expect(queued.success).toBe(true);
    if (queued.success) {
      expect(queued.data).toMatchObject({
        type: "queue_change",
        size: 2,
        queue: ["steer", "later"],
      });
    }

    const preserved = parsePiChildSessionEvent({
      type: "brand_new_host_kind",
      detail: "kept",
    });
    expect(preserved.success).toBe(true);
    if (preserved.success) expect(preserved.data.type).toBe("unknown");
  });
});

/**
 * Materialization must not turn `__proto__`, `constructor`, or `prototype`
 * into inherited event authority. Assignment of those keys into `{}` retargets
 * the copy and lets Zod or the tool normalizer read forged `type` / `size` /
 * `queue` / `isError` fields the host never stated as own data.
 */
describe("Pi child session event prototype pollution", () => {
  const POLLUTION_KEYS = ["__proto__", "constructor", "prototype"] as const;

  const expectUnchangedGlobalPrototype = (): void => {
    expect(Object.hasOwn(Object.prototype, "type")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "size")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "queue")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "isError")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "is_error")).toBe(false);
    const sample: Record<string, unknown> = {};
    expect(sample.type).toBeUndefined();
    expect(sample.size).toBeUndefined();
    expect(sample.queue).toBeUndefined();
    expect(sample.isError).toBeUndefined();
    expect(Object.getPrototypeOf(sample)).toBe(Object.prototype);
  };

  const parsePollution = (value: unknown) => {
    expect(() => parsePiChildSessionEvent(value)).not.toThrow();
    const parsed = parsePiChildSessionEvent(value);
    expectUnchangedGlobalPrototype();
    return parsed;
  };

  it("does not grant queue_change authority from a top-level pollution key", () => {
    for (const key of POLLUTION_KEYS) {
      const parsed = parsePollution(
        JSON.parse(
          `{"type":"forged_unknown_kind","${key}":{"type":"queue_change","size":5,"queue":["forged-queue"]}}`,
        ),
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.type).not.toBe("queue_change");
      expect(JSON.stringify(parsed.data)).not.toContain("queue_change");
      expect(JSON.stringify(parsed.data)).not.toContain("forged-queue");
    }

    for (const key of POLLUTION_KEYS) {
      const parsed = parsePollution(
        JSON.parse(
          `{"type":"queue_change","${key}":{"size":5,"queue":["forged-queue"]}}`,
        ),
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data).toMatchObject({ type: "queue_change" });
      expect(parsed.data).not.toMatchObject({
        size: 5,
        queue: ["forged-queue"],
      });
      expect(JSON.stringify(parsed.data)).not.toContain("forged-queue");
    }
  });

  it("does not grant queue_change authority from a nested pollution key", () => {
    for (const key of POLLUTION_KEYS) {
      const parsed = parsePollution(
        JSON.parse(
          `{"type":"queue_change","size":0,"queue":[],"payload":{"kept":true,"${key}":{"type":"queue_change","size":5,"queue":["forged-queue"]}}}`,
        ),
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data).toMatchObject({
        type: "queue_change",
        size: 0,
        queue: [],
      });
      expect(JSON.stringify(parsed.data)).not.toContain("forged-queue");
      if ("payload" in parsed.data) {
        const payload = (parsed.data as { payload?: unknown }).payload;
        expect(payload).toMatchObject({ kept: true });
        expect(payload).not.toMatchObject({
          size: 5,
          queue: ["forged-queue"],
        });
      }
    }
  });

  it("does not grant tool_execution_end isError from a top-level pollution key", () => {
    for (const key of POLLUTION_KEYS) {
      const parsed = parsePollution(
        JSON.parse(
          `{"type":"tool_execution_end","toolCallId":"call-1","toolName":"read","result":{"content":"ok"},"${key}":{"isError":true}}`,
        ),
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.type).toBe("tool_result");
      expect(parsed.data).toMatchObject({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: "ok" },
      });
      expect(JSON.stringify(parsed.data)).not.toContain("tool_error");
    }
  });

  it("does not grant tool_execution_end.result.isError from a nested pollution key", () => {
    for (const key of POLLUTION_KEYS) {
      const parsed = parsePollution(
        JSON.parse(
          `{"type":"tool_execution_end","toolCallId":"call-1","toolName":"read","result":{"content":"ok","${key}":{"isError":true}}}`,
        ),
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.type).toBe("tool_result");
      expect(parsed.data).toMatchObject({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: "ok" },
      });
      expect(JSON.stringify(parsed.data)).not.toContain('"isError":true');
    }
  });

  it("still accepts an explicit own queue zero and an own tool error", () => {
    const queued = parsePollution({
      type: "queue_update",
      steering: [],
      followUp: [],
    });
    expect(queued.success).toBe(true);
    if (queued.success) {
      expect(queued.data).toMatchObject({
        type: "queue_change",
        size: 0,
        queue: [],
      });
    }

    const failed = parsePollution({
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
});
