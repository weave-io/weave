import { describe, expect, it } from "bun:test";
import { injectControlledReasoningInMemory } from "../../../../../scripts/pi/child-stream-capture.js";
import fixture from "../__fixtures__/pi-0.84.2-child-ui-events.v1.json";
import {
  formatPiLiveReasoningInspectorRows,
  formatPiLiveReasoningParentLine,
  PI_LIVE_REASONING_INSPECTOR_MAX_ROWS,
  PI_LIVE_REASONING_INSPECTOR_ROW_MAX_CODE_POINTS,
  PI_LIVE_REASONING_MAX_BYTES,
  PI_LIVE_REASONING_MAX_INPUT_BYTES,
  PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS,
  PI_LIVE_REASONING_PARENT_PREFIX,
  PI_LIVE_REASONING_TRUNCATION_MARKER,
  PI_LIVE_REASONING_UNPRINTABLE_MARKER,
  PiLiveReasoningProjector,
  PiLiveReasoningRegistry,
  type PiLiveReasoningUpdate,
  piLiveReasoningUtf8Bytes,
  projectPiLiveReasoningUpdate,
} from "../child-live-reasoning.js";
import {
  parsePiChildSessionEvent,
  retainedChildSessionEvent,
} from "../child-session-events.js";
import {
  ChildUiEventDiagnostics,
  type ChildUiEventDiagnosticsSnapshot,
} from "../child-ui-event-diagnostics.js";

const CHILD_ID = "child-live-reasoning";
const GENERATION_ID = "generation-live-reasoning";
const CONTROLLED = "SYNTHETIC-CONTROLLED-REASONING";

type Fixture = {
  readonly events: readonly {
    readonly ordinalId: number;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[];
};

const captured = fixture as Fixture;

function payloadFor(
  phase: "thinking_start" | "thinking_delta" | "thinking_end",
  ordinalId: number,
): Record<string, unknown> {
  const event = captured.events.find(
    (candidate) =>
      candidate.eventType === "message_update" &&
      candidate.payload.assistantMessageEvent !== null &&
      typeof candidate.payload.assistantMessageEvent === "object" &&
      (candidate.payload.assistantMessageEvent as { readonly type?: unknown })
        .type === phase,
  );
  if (event === undefined) throw new Error("fixture phase missing");
  return injectControlledReasoningInMemory({ ...event.payload }, ordinalId);
}

function parsedPayload(payload: Record<string, unknown>) {
  const parsed = parsePiChildSessionEvent(payload);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("fixture event did not parse");
  return parsed.data;
}

function diagnostics(): ChildUiEventDiagnosticsSnapshot {
  return new ChildUiEventDiagnostics().snapshot();
}

describe("PiLiveReasoningProjector", () => {
  it("projects only the captured Pi 0.84.2 thinking lifecycle", () => {
    const updates: string[] = [];
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
      parentCardObserver: (update) => updates.push(update.phase),
    });

    const start = projector.accept(
      parsedPayload(payloadFor("thinking_start", 5)),
    );
    const delta = projector.accept(
      parsedPayload(payloadFor("thinking_delta", 6)),
    );
    const end = projector.accept(parsedPayload(payloadFor("thinking_end", 7)));

    expect(start.isOk()).toBe(true);
    expect(delta.isOk()).toBe(true);
    expect(end.isOk()).toBe(true);
    expect(updates).toEqual(["start", "delta", "end"]);
    expect(projector.snapshot().parentCardLine).toBe(
      `${PI_LIVE_REASONING_PARENT_PREFIX}${CONTROLLED}-5${CONTROLLED}-6${CONTROLLED}-7`,
    );
    expect(projector.snapshot().inspectorRows).toEqual([
      `${CONTROLLED}-5${CONTROLLED}-6${CONTROLLED}-7`,
    ]);
    expect(
      retainedChildSessionEvent(parsedPayload(payloadFor("thinking_end", 7))),
    )?.toMatchObject({
      type: "message_update",
    });
    expect(
      JSON.stringify(
        retainedChildSessionEvent(parsedPayload(payloadFor("thinking_end", 7))),
      ),
    ).not.toContain(CONTROLLED);
  });

  it("keeps the newest 4 KiB of UTF-8 and marks every omitted display", () => {
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
    });
    const start = {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_start",
        contentIndex: 0,
        content: "a".repeat(2_000),
      },
    };
    const delta = {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "🙂".repeat(2_000),
      },
    };
    expect(projector.accept(start).isOk()).toBe(true);
    expect(projector.accept(delta).isOk()).toBe(true);

    const state = projector.snapshot();
    expect(state.retainedBytes).toBeLessThanOrEqual(
      PI_LIVE_REASONING_MAX_BYTES,
    );
    expect(piLiveReasoningUtf8Bytes(state.text)).toBe(state.retainedBytes);
    expect(state.omitted).toBe(true);
    expect(
      state.parentCardText.endsWith(PI_LIVE_REASONING_TRUNCATION_MARKER),
    ).toBe(true);
    expect(
      state.inspectorRows.at(-1)?.endsWith(PI_LIVE_REASONING_TRUNCATION_MARKER),
    ).toBe(true);
  });

  it("bounds high-rate input and both terminal display surfaces", () => {
    let updates = 0;
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
      parentCardObserver: () => {
        updates += 1;
      },
      inspectorObserver: () => {
        updates += 1;
      },
    });
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_start",
            contentIndex: 0,
          },
        })
        .isOk(),
    ).toBe(true);
    for (let index = 0; index < 10_000; index += 1) {
      expect(
        projector
          .accept({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: 0,
              delta: "🙂",
            },
          })
          .isOk(),
      ).toBe(true);
    }
    const snapshot = projector.snapshot();
    // The structural start has no row, so only nonblank deltas reach sinks.
    expect(updates).toBe(20_000);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(
      PI_LIVE_REASONING_MAX_BYTES,
    );
    expect(Array.from(snapshot.parentCardText).length).toBeLessThanOrEqual(
      PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS,
    );
    expect(snapshot.inspectorRows.length).toBeLessThanOrEqual(
      PI_LIVE_REASONING_INSPECTOR_MAX_ROWS,
    );
    for (const row of snapshot.inspectorRows) {
      expect(Array.from(row).length).toBeLessThanOrEqual(
        PI_LIVE_REASONING_INSPECTOR_ROW_MAX_CODE_POINTS,
      );
    }
  });

  it("rejects an oversized parser-approved carrier before any UI fanout", () => {
    let observed = 0;
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
      parentCardObserver: () => {
        observed += 1;
      },
    });
    const rejected = projector.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_start",
        contentIndex: 0,
        content: "x".repeat(PI_LIVE_REASONING_MAX_INPUT_BYTES + 1),
      },
    });
    expect(rejected.isErr()).toBe(true);
    expect(rejected.isErr() && rejected.error.reason).toBe("invalid-text");
    expect(observed).toBe(0);
    expect(projector.snapshot()).toMatchObject({
      text: "",
      retainedBytes: 0,
      active: false,
      inspectorRows: [],
      parentCardLine: "",
    });
  });

  it("uses exact UTF-8 and display bounds and keeps an honest marker", () => {
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
    });
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_start",
            contentIndex: 0,
          },
        })
        .isOk(),
    ).toBe(true);
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "🙂".repeat(2_049),
          },
        })
        .isOk(),
    ).toBe(true);
    const snapshot = projector.snapshot();
    expect(snapshot.retainedBytes).toBe(PI_LIVE_REASONING_MAX_BYTES);
    expect(piLiveReasoningUtf8Bytes(snapshot.text)).toBe(
      PI_LIVE_REASONING_MAX_BYTES,
    );
    expect(snapshot.omitted).toBe(true);
    expect(snapshot.parentCardLine).toBe(
      `${PI_LIVE_REASONING_PARENT_PREFIX}${snapshot.parentCardText}`,
    );
    expect(snapshot.parentCardLine).toEndWith(
      PI_LIVE_REASONING_TRUNCATION_MARKER,
    );
    expect(snapshot.parentCardLine).not.toBe(PI_LIVE_REASONING_PARENT_PREFIX);
    expect(snapshot.inspectorRows.length).toBeLessThanOrEqual(
      PI_LIVE_REASONING_INSPECTOR_MAX_ROWS,
    );
    expect(snapshot.inspectorRows.at(-1)).toEndWith(
      PI_LIVE_REASONING_TRUNCATION_MARKER,
    );
    expect(Array.from(snapshot.parentCardText).length).toBeLessThanOrEqual(
      PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS,
    );
  });

  it("keeps one lifecycle fanout and rejects a second terminal mutation", () => {
    const phases: string[] = [];
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
      parentCardObserver: (update) => phases.push(`parent:${update.phase}`),
      inspectorObserver: (update) => phases.push(`inspector:${update.phase}`),
    });
    const start = projector.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_start",
        contentIndex: 0,
        content: "first",
      },
    });
    const end = projector.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "first",
      },
    });
    const duplicateEnd = projector.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "first again",
      },
    });
    expect(start.isOk()).toBe(true);
    expect(end.isOk()).toBe(true);
    expect(duplicateEnd.isErr()).toBe(true);
    expect(duplicateEnd.isErr() && duplicateEnd.error.reason).toBe(
      "no-active-block",
    );
    expect(phases).toEqual([
      "parent:start",
      "inspector:start",
      "parent:end",
      "inspector:end",
    ]);
  });

  it("projects an update only with a valid lifecycle identity", () => {
    const missingEpoch = projectPiLiveReasoningUpdate(
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "sentinel",
        },
      },
      { childId: CHILD_ID, generationId: GENERATION_ID, lifecycleEpoch: 0 },
    );
    expect(missingEpoch.isErr()).toBe(true);
    expect(missingEpoch.isErr() && missingEpoch.error.reason).toBe(
      "stale-epoch",
    );
  });

  it("reconciles a full end carrier without duplicating deltas", () => {
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
    });
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_start",
            contentIndex: 0,
            content: "plan",
          },
        })
        .isOk(),
    ).toBe(true);
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: " carefully",
          },
        })
        .isOk(),
    ).toBe(true);
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_end",
            contentIndex: 0,
            content: "plan carefully",
          },
        })
        .isOk(),
    ).toBe(true);
    expect(projector.snapshot().text).toBe("plan carefully");
  });

  it("extracts captured thinking-end block arrays without duplicating their text", () => {
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
    });
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_start",
            contentIndex: 0,
          },
        })
        .isOk(),
    ).toBe(true);
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "plan ",
          },
        })
        .isOk(),
    ).toBe(true);
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_end",
            contentIndex: 0,
            content: [
              { type: "thinking", text: "plan carefully" },
              { type: "thinking", text: "" },
            ],
          },
        })
        .isOk(),
    ).toBe(true);
    expect(projector.snapshot().text).toBe("plan carefully");
  });

  it("rejects malformed observer updates without invoking accessors", () => {
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
    });
    let accessed = 0;
    const malformed = {
      childId: CHILD_ID,
      generationId: GENERATION_ID,
      lifecycleEpoch: 1,
      phase: "start",
      contentIndex: 0,
    } as Record<string, unknown>;
    Object.defineProperty(malformed, "text", {
      enumerable: true,
      get: () => {
        accessed += 1;
        return "not read";
      },
    });
    const result = projector.apply(
      malformed as unknown as PiLiveReasoningUpdate,
    );
    expect(result.isErr()).toBe(true);
    expect(accessed).toBe(0);
  });

  it("rejects stale, out-of-order, and out-of-range lifecycle updates", () => {
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
    });
    const beforeStart = projector.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "late",
      },
    });
    expect(beforeStart.isErr() && beforeStart.error.reason).toBe(
      "no-active-block",
    );

    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_start",
            contentIndex: 0,
          },
        })
        .isOk(),
    ).toBe(true);
    const wrongCorrelation = projector.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "wrong block",
      },
    });
    expect(wrongCorrelation.isErr() && wrongCorrelation.error.reason).toBe(
      "out-of-order",
    );
    const update = projector.accept({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "valid",
      },
    });
    expect(update.isOk()).toBe(true);
    if (!update.isOk() || update.value === undefined) {
      throw new Error("valid update rejected");
    }
    const validUpdate = update.value;

    const staleChild = projector.apply({ ...validUpdate, childId: "other" });
    const staleGeneration = projector.apply({
      ...validUpdate,
      generationId: "other-generation",
    });
    const staleEpoch = projector.apply({
      ...validUpdate,
      lifecycleEpoch: validUpdate.lifecycleEpoch - 1,
    });
    const invalidCorrelation = projector.apply({
      ...validUpdate,
      contentIndex: 256,
    });
    expect(staleChild.isErr() && staleChild.error.reason).toBe("stale-child");
    expect(staleGeneration.isErr() && staleGeneration.error.reason).toBe(
      "stale-generation",
    );
    expect(staleEpoch.isErr() && staleEpoch.error.reason).toBe("stale-epoch");
    expect(invalidCorrelation.isErr() && invalidCorrelation.error.reason).toBe(
      "correlation-out-of-bounds",
    );
  });

  it("never invokes accessors or proxy traps and rejects mixed carriers", () => {
    let accessed = 0;
    const assistant = {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "safe",
    } as Record<string, unknown>;
    Object.defineProperty(assistant, "delta", {
      enumerable: true,
      get: () => {
        accessed += 1;
        return "secret";
      },
    });
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
    });
    const accessor = projector.accept({
      type: "message_update",
      assistantMessageEvent: assistant,
    });
    expect(accessor.isErr()).toBe(true);
    expect(accessed).toBe(0);

    const revoked = Proxy.revocable(
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "proxy",
        },
      },
      {},
    );
    revoked.revoke();
    const proxyResult = projector.accept(revoked.proxy);
    expect(proxyResult.isErr()).toBe(true);

    const mixed = projector.accept({
      type: "message_update",
      delta: { text: "answer" },
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "reasoning",
      },
    });
    expect(mixed.isErr()).toBe(true);
    expect(mixed.isErr() && mixed.error.reason).toBe("mixed-carriers");
  });

  it("uses the unprintable marker for control-only input and never emits a blank row", () => {
    const controlOnly = "\u001b[31m\u0000\u001b[0m";
    const observed: string[] = [];
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
      parentCardObserver: (update) => observed.push(update.text),
    });
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: controlOnly,
          },
        })
        .isErr(),
    ).toBe(true);
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_start",
            contentIndex: 0,
          },
        })
        .isOk(),
    ).toBe(true);
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: controlOnly,
          },
        })
        .isOk(),
    ).toBe(true);
    expect(observed.at(-1)).toBe(PI_LIVE_REASONING_UNPRINTABLE_MARKER);

    const parent = formatPiLiveReasoningParentLine(controlOnly);
    const inspector = formatPiLiveReasoningInspectorRows(controlOnly);
    expect(parent).toBe(
      `${PI_LIVE_REASONING_PARENT_PREFIX}${PI_LIVE_REASONING_UNPRINTABLE_MARKER}`,
    );
    expect(inspector).toEqual([PI_LIVE_REASONING_UNPRINTABLE_MARKER]);
    expect(formatPiLiveReasoningParentLine("\u001b[31m\u001b[0m")).not.toBe(
      `${PI_LIVE_REASONING_PARENT_PREFIX}`,
    );
    expect(formatPiLiveReasoningInspectorRows("\n\t")).toEqual([
      PI_LIVE_REASONING_UNPRINTABLE_MARKER,
    ]);
  });

  it("isolates observers and releases every buffer and registry entry", () => {
    const registry = new PiLiveReasoningRegistry();
    const diagnosticsSink = new ChildUiEventDiagnostics();
    const seen: string[] = [];
    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
      registry,
      diagnostics: diagnosticsSink,
      parentCardObserver: () => {
        throw new Error("parent observer failure");
      },
      inspectorObserver: (update) => {
        seen.push(update.text);
      },
    });
    expect(registry.size()).toBe(1);
    expect(
      projector
        .accept({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_start",
            contentIndex: 0,
            content: "kept only in memory",
          },
        })
        .isOk(),
    ).toBe(true);
    expect(seen).toEqual(["kept only in memory"]);
    expect(
      diagnosticsSink
        .snapshot()
        .buckets.some(
          (bucket) =>
            bucket.stage === "fanout" && bucket.reason === "callback-failed",
        ),
    ).toBe(true);

    projector.clear();
    expect(projector.snapshot().text).toBe("");
    expect(projector.snapshot().retainedBytes).toBe(0);
    expect(projector.snapshot().registryEntries).toBe(0);
    expect(registry.size()).toBe(0);
    expect(projector.accept({}).isErr()).toBe(true);
    expect(projector.settle().isOk()).toBe(true);
    expect(projector.dispose().isOk()).toBe(true);

    for (const release of ["clear", "settle", "dispose"] as const) {
      const releaseRegistry = new PiLiveReasoningRegistry();
      const releaseProjector = new PiLiveReasoningProjector({
        childId: `${CHILD_ID}-${release}`,
        generationId: GENERATION_ID,
        registry: releaseRegistry,
      });
      expect(
        releaseProjector
          .accept({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_start",
              contentIndex: 0,
              content: "release me",
            },
          })
          .isOk(),
      ).toBe(true);
      expect(releaseProjector[release]().isOk()).toBe(true);
      expect(releaseProjector.snapshot().text).toBe("");
      expect(releaseProjector.snapshot().retainedBytes).toBe(0);
      expect(releaseRegistry.size()).toBe(0);
    }
  });

  it("keeps structural fixture markers content-free until memory-only injection", () => {
    const structural = payloadFor("thinking_delta", 6);
    const original = captured.events.find((event) => event.ordinalId === 6);
    expect(original).toBeDefined();
    expect(JSON.stringify(original)).not.toContain(CONTROLLED);
    expect(JSON.stringify(structural)).toContain(CONTROLLED);

    const projector = new PiLiveReasoningProjector({
      childId: CHILD_ID,
      generationId: GENERATION_ID,
    });
    const structuralResult = projector.accept(
      parsedPayload(original?.payload as Record<string, unknown>),
    );
    expect(structuralResult.isErr()).toBe(true);
    expect(structuralResult.isErr() && structuralResult.error.reason).toBe(
      "no-active-block",
    );
  });

  it("keeps diagnostic serialization content-free", () => {
    const snapshot = diagnostics();
    expect(JSON.stringify(snapshot)).not.toContain(CONTROLLED);
  });
});
