import { describe, expect, it } from "bun:test";
import {
  overlayTranscriptSearchIndex,
  renderOverlayPiNative,
} from "../child-overlay-pi-native.js";
import {
  mapNativeSessionEntryToOverlay,
  projectLiveEntry,
  pushReplayEvent,
  transcriptFromOverlayEntries,
} from "../child-overlay-replay.js";
import { matchingEntryIds } from "../child-overlay-search.js";
import {
  parsePiChildSessionEvent,
  retainedChildSessionEvent,
} from "../child-session-events.js";
import { PI_MODEL_FAILOVER_MARKER_TYPE } from "../model-failover-contract.js";
import { PI_MODEL_FAILOVER_ENTRY_TYPE } from "../model-failover-record.js";
import { plainPaint } from "../ui-paint.js";

const RECORD = {
  schemaVersion: 1,
  transitionId: "123e4567-e89b-42d3-a456-426614174000",
  failureClass: "provider_unavailable",
  from: { provider: "openai", id: "gpt-5.6-sol" },
  to: { provider: "anthropic", id: "claude-sonnet-4-5" },
} as const;

const NATIVE_ENTRY = {
  type: "custom",
  id: "native-fallback-1",
  customType: PI_MODEL_FAILOVER_ENTRY_TYPE,
  data: RECORD,
};

function nativeInput(
  entries: Parameters<typeof transcriptFromOverlayEntries>[0],
) {
  const transcript = transcriptFromOverlayEntries(entries);
  return {
    transcript,
    input: {
      entries: transcript.entries,
      childName: "Shuttle",
      settled: false,
    },
  };
}

describe("model fallback live/replay/search parity", () => {
  it("uses the same strict fact and rows for native restart and live projection", () => {
    const historical = mapNativeSessionEntryToOverlay(NATIVE_ENTRY, 2);
    expect(historical.isOk()).toBe(true);
    const replayEntry = historical._unsafeUnwrap();
    expect(replayEntry).toBeDefined();

    const liveEvent = parsePiChildSessionEvent({
      type: "unknown",
      originalType: PI_MODEL_FAILOVER_ENTRY_TYPE,
      payload: RECORD,
    });
    expect(liveEvent.success).toBe(true);
    if (!liveEvent.success || replayEntry === undefined) {
      throw new Error("fallback fixture was not admitted");
    }
    const liveEntry = projectLiveEntry(liveEvent.data, 2, false);
    expect(liveEntry).toBeDefined();
    if (liveEntry === undefined) throw new Error("fallback was not projected");
    expect(liveEntry.text).toBe(replayEntry.text);
    expect(liveEntry.kind).toBe(replayEntry.kind);

    const replayNative = nativeInput([replayEntry]);
    const replayPane = renderOverlayPiNative(
      plainPaint(),
      replayNative.input,
      100,
    );
    const liveInput = nativeInput([liveEntry]);
    expect(liveInput.transcript.entries).toHaveLength(1);
    const liveTranscriptEntry = liveInput.transcript.entries[0];
    expect(liveTranscriptEntry).toMatchObject({
      kind: "unknown",
      originalType: PI_MODEL_FAILOVER_ENTRY_TYPE,
      payload: RECORD,
    });
    if (liveTranscriptEntry?.kind !== "unknown") {
      throw new Error("fallback transcript entry was not retained");
    }
    const livePane = renderOverlayPiNative(plainPaint(), liveInput.input, 100);
    expect(livePane.plain).toHaveLength(4);
    expect(livePane.plain[0]).toBe("▌ MODEL FALLBACK");
    expect(livePane.plain[1]).toContain("openai/gpt-5.6-sol");
    expect(replayPane.plain).toEqual(livePane.plain);
    expect(replayPane.plain.join("\n")).toContain("MODEL FALLBACK");
    expect(replayPane.plain.join("\n")).toContain("native recovery exhausted");

    const searchIndex = overlayTranscriptSearchIndex(livePane);
    expect(
      matchingEntryIds(
        [{ id: liveEntry.id, text: liveEntry.text }],
        "native recovery exhausted",
        searchIndex,
      ),
    ).toEqual([liveEntry.id]);
  });

  it("keeps the hidden marker out of live, replay, search, and restart paths", () => {
    const markerEntry = {
      type: "custom",
      id: "marker-1",
      customType: PI_MODEL_FAILOVER_MARKER_TYPE,
      data: { display: false },
    };
    const mappedMarker = mapNativeSessionEntryToOverlay(markerEntry, 1);
    expect(mappedMarker.isOk()).toBe(true);
    expect(mappedMarker._unsafeUnwrap()).toBeUndefined();
    const markerMessage = parsePiChildSessionEvent({
      type: "message_start",
      message: {
        role: "custom",
        customType: PI_MODEL_FAILOVER_MARKER_TYPE,
        content: "Weave model fallback recovery.",
        details: {
          schemaVersion: 1,
          token: "123e4567-e89b-42d3-a456-426614174000",
        },
        display: false,
      },
    });
    expect(markerMessage.success).toBe(true);
    if (!markerMessage.success)
      throw new Error("marker message fixture was rejected");
    expect(retainedChildSessionEvent(markerMessage.data)).toBeUndefined();

    const markerEvent = parsePiChildSessionEvent({
      type: "unknown",
      originalType: PI_MODEL_FAILOVER_MARKER_TYPE,
      payload: { display: false },
    });
    expect(markerEvent.success).toBe(true);
    if (!markerEvent.success) throw new Error("marker fixture was rejected");
    expect(projectLiveEntry(markerEvent.data, 1, false)).toBeUndefined();

    const replaySteps: Parameters<typeof pushReplayEvent>[0] = [];
    const replayed = pushReplayEvent(replaySteps, markerEvent.data);
    expect(replayed.isOk()).toBe(true);
    expect(replaySteps).toEqual([]);

    expect(
      matchingEntryIds(
        [
          {
            id: "marker",
            text: "model fallback recovery marker",
            originalType: PI_MODEL_FAILOVER_MARKER_TYPE,
          },
          { id: "ordinary", text: "weave ordinary custom fact" },
        ],
        "marker",
      ),
    ).toEqual([]);
    expect(
      matchingEntryIds(
        [{ id: "ordinary", text: "weave ordinary custom fact" }],
        "ordinary",
      ),
    ).toEqual(["ordinary"]);
  });

  it("does not broadly filter unrelated Weave custom entries", () => {
    const ordinary = mapNativeSessionEntryToOverlay(
      {
        type: "custom",
        id: "ordinary-1",
        customType: "weave.child.operator-note",
        data: { text: "keep this" },
      },
      1,
    );
    expect(ordinary.isOk()).toBe(true);
    expect(ordinary._unsafeUnwrap()?.kind).toBe("status");
  });
});
