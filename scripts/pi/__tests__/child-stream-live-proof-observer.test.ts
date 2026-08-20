import { describe, expect, it } from "bun:test";
import { createLiveProofObserver } from "../child-stream-live-proof-observer.js";

const FIXTURE_PATH =
  "packages/adapters/pi/src/__fixtures__/pi-0.84.2-child-ui-events.v1.json";
const READ_TURN = { first: 4, last: 16 } as const;

interface FixtureEvent {
  readonly ordinalId: number;
  readonly payload: Record<string, unknown>;
}

async function fixtureEvents(): Promise<readonly FixtureEvent[]> {
  const fixture = (await Bun.file(FIXTURE_PATH).json()) as {
    readonly events: readonly FixtureEvent[];
  };
  return fixture.events.filter(
    (event) =>
      event.ordinalId < READ_TURN.first || event.ordinalId > READ_TURN.last,
  );
}

function withReasoning(
  event: FixtureEvent,
  reasoning: (ordinal: number) => string,
): Record<string, unknown> {
  const payload = structuredClone(event.payload) as Record<string, unknown>;
  const assistant = payload.assistantMessageEvent;
  if (typeof assistant !== "object" || assistant === null) return payload;
  const carrier = assistant as Record<string, unknown>;
  if (
    typeof carrier.type !== "string" ||
    !carrier.type.startsWith("thinking")
  ) {
    return payload;
  }
  carrier[carrier.type === "thinking_delta" ? "delta" : "content"] = reasoning(
    event.ordinalId,
  );
  return payload;
}

describe("LiveProofObserver", () => {
  it("passes all four lanes on the authoritative capture", async () => {
    const observer = createLiveProofObserver("SENTINEL-ABSENT");
    observer.selectInspector();
    for (const event of await fixtureEvents()) {
      observer.ingest(withReasoning(event, (id) => `LIVE-REASON-${id} `));
    }

    expect(observer.settled()).toBe(true);
    expect(observer.parentReasoningLane().status).toBe("pass");
    expect(observer.inspectorReasoningSignal().status).toBe("pass");
    expect(observer.inspectorToolSignal().status).toBe("pass");
    expect(observer.inspectorAssistantSignal().status).toBe("pass");
    expect(observer.settlement(1)).toMatchObject({
      status: "settled",
      childCount: 1,
      settlementCount: 1,
      toolTerminalCount: 1,
    });
    expect(observer.registrySnapshot().registryEntries).toBe(0);
    expect(observer.diagnosticsSnapshot().status).toBe("clean");
  });

  it("fails the reasoning lanes when the carrier text is blank", async () => {
    const observer = createLiveProofObserver("SENTINEL-ABSENT");
    observer.selectInspector();
    for (const event of await fixtureEvents()) {
      observer.ingest(withReasoning(event, () => ""));
    }

    expect(observer.parentReasoningLane().status).toBe("fail");
    expect(observer.parentReasoningLane().nonBlankObserved).toBe(false);
    expect(observer.inspectorReasoningSignal().status).toBe("fail");
    expect(observer.inspectorToolSignal().status).toBe("pass");
  });

  it("blocks the inspector lanes when no inspector is selected", async () => {
    const observer = createLiveProofObserver("SENTINEL-ABSENT");
    for (const event of await fixtureEvents()) {
      observer.ingest(withReasoning(event, (id) => `LIVE-REASON-${id} `));
    }

    expect(observer.parentReasoningLane().status).toBe("pass");
    expect(observer.inspectorReasoningSignal().status).toBe("fail");
    expect(observer.inspectorReasoningSignal().observationCount).toBe(0);
  });

  it("detects reasoning that reaches a durable or rendered sink", async () => {
    const sentinel = "LIVE-REASON-LEAK";
    const observer = createLiveProofObserver(sentinel);
    observer.selectInspector();
    for (const event of await fixtureEvents()) {
      const payload = withReasoning(event, () => `${sentinel} `);
      // Simulate the defect this lane exists to catch: the same text also
      // arriving on a retained assistant carrier.
      const assistant = payload.assistantMessageEvent;
      if (
        typeof assistant === "object" &&
        assistant !== null &&
        (assistant as { type?: unknown }).type === "text_delta"
      ) {
        (assistant as Record<string, unknown>).delta = `${sentinel} `;
      }
      observer.ingest(payload);
    }

    const isolation = observer.isolation();
    expect(isolation.prohibitedSinkDetected).toBe(true);
    expect(isolation.durableIsolated).toBe(false);
  });

  it("refuses a second inspector selection and selection after settlement", async () => {
    const observer = createLiveProofObserver("SENTINEL-ABSENT");

    expect(observer.selectInspector()).toBe(true);
    expect(observer.selectInspector()).toBe(false);
    for (const event of await fixtureEvents()) observer.ingest(event.payload);
    expect(observer.settled()).toBe(true);
    expect(observer.selectInspector()).toBe(false);
  });
});
