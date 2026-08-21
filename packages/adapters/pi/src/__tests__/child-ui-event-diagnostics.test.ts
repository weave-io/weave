import { describe, expect, it } from "bun:test";
import {
  CHILD_UI_EVENT_DIAGNOSTIC_STAGES,
  CHILD_UI_EVENT_DIAGNOSTICS_MAX_COUNT,
  CHILD_UI_EVENT_DIAGNOSTICS_MAX_SERIALIZED_BYTES,
  createChildUiEventDiagnostics,
  diagnosticClassForReason,
  diagnosticDispositionForReason,
  isChildUiEventDiagnosticsSnapshot,
  recordChildUiEventDiagnostic,
  recordChildUiEventDrop,
  recordChildUiEventFailure,
  recordChildUiEventInvalid,
} from "../child-ui-event-diagnostics.js";

describe("ChildUiEventDiagnostics", () => {
  it("keeps the stage, class, and disposition vocabularies closed", () => {
    const diagnostics = createChildUiEventDiagnostics({ now: () => 123 });

    recordChildUiEventDrop(diagnostics, "stream-ingest", "settled");
    recordChildUiEventInvalid(diagnostics, "overlay-mapping", "event-invalid");
    recordChildUiEventFailure(
      diagnostics,
      "card-reduction",
      "card-reduction-failed",
    );

    const snapshot = diagnostics.snapshot();
    expect(snapshot.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "stream-ingest",
          classification: "lifecycle-drop",
          reason: "settled",
          disposition: "dropped",
        }),
        expect.objectContaining({
          stage: "overlay-mapping",
          classification: "invalid-input",
          reason: "event-invalid",
          disposition: "rejected",
        }),
        expect.objectContaining({
          stage: "card-reduction",
          classification: "application-failure",
          reason: "card-reduction-failed",
          disposition: "failed",
        }),
      ]),
    );
    expect(diagnosticClassForReason("stale-generation")).toBe("lifecycle-drop");
    expect(diagnosticDispositionForReason("mapping-invalid")).toBe("rejected");

    const badClassification = diagnostics.record({
      stage: "stream-ingest",
      reason: "settled",
      classification: "invalid-input",
      disposition: "rejected",
    });
    expect(badClassification.isErr()).toBe(true);
    if (badClassification.isErr())
      expect(badClassification.error.type).toBe(
        "InvalidDiagnosticClassification",
      );

    const badDisposition = diagnostics.record({
      stage: "stream-ingest",
      reason: "stream-apply-failed",
      classification: "application-failure",
      disposition: "dropped",
    });
    expect(badDisposition.isErr()).toBe(true);
    if (badDisposition.isErr())
      expect(badDisposition.error.type).toBe("InvalidDiagnosticDisposition");
  });

  it("saturates counts and bounds first and last times", () => {
    let now = 100;
    const diagnostics = createChildUiEventDiagnostics({
      now: () => now,
      maxCount: 2,
    });

    recordChildUiEventFailure(diagnostics, "rpc-parse", "parser-failed");
    now = 200;
    recordChildUiEventFailure(
      diagnostics,
      "rpc-parse",
      "parser-failed",
      Number.POSITIVE_INFINITY,
    );
    now = 300;
    recordChildUiEventFailure(diagnostics, "rpc-parse", "parser-failed", -1);

    const bucket = diagnostics
      .snapshot()
      .buckets.find((candidate) => candidate.reason === "parser-failed");
    expect(bucket).toMatchObject({
      count: 2,
      saturated: true,
      firstAtMs: 100,
      lastAtMs: 0,
    });
    expect(CHILD_UI_EVENT_DIAGNOSTICS_MAX_COUNT).toBeGreaterThan(0);
  });

  it("caps buckets and serialized snapshots without truncating JSON", () => {
    const diagnostics = createChildUiEventDiagnostics({
      maxBuckets: 2,
      maxSerializedBytes: 300,
    });

    for (const stage of CHILD_UI_EVENT_DIAGNOSTIC_STAGES.slice(0, 4)) {
      recordChildUiEventDiagnostic(diagnostics, {
        stage,
        reason: "stream-apply-failed",
      });
    }

    const snapshot = diagnostics.snapshot();
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    expect(snapshot.buckets.length).toBeLessThanOrEqual(2);
    expect(snapshot.omittedBuckets).toBeGreaterThan(0);
    expect(bytes).toBe(snapshot.serializedBytes);
    expect(bytes).toBeLessThanOrEqual(snapshot.maxSerializedBytes);
    expect(snapshot.maxBuckets).toBe(2);
    expect(snapshot.maxSerializedBytes).toBeLessThanOrEqual(
      CHILD_UI_EVENT_DIAGNOSTICS_MAX_SERIALIZED_BYTES,
    );
    expect(isChildUiEventDiagnosticsSnapshot(snapshot)).toBe(true);

    const cleared = diagnostics.clear();
    expect(cleared.isOk()).toBe(true);
    expect(diagnostics.snapshot().buckets).toHaveLength(0);
  });

  it("exports no event, tool, path, prompt, or secret content", () => {
    const diagnostics = createChildUiEventDiagnostics({ now: () => 7 });
    const sentinel =
      "SECRET_SENTINEL /private/workspace prompt text tool payload reasoning";

    recordChildUiEventDiagnostic(diagnostics, {
      stage: "native-render",
      reason: "native-render-failed",
      outcome: "failed",
      atMs: 7,
    });

    const snapshot = diagnostics.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("childId");
    expect(serialized).not.toContain("path");
    expect(Object.keys(snapshot)).toEqual([
      "schemaVersion",
      "buckets",
      "omittedBuckets",
      "serializedBytes",
      "maxBuckets",
      "maxSerializedBytes",
    ]);
    expect(Object.keys(snapshot.buckets[0] ?? {})).toEqual([
      "stage",
      "classification",
      "reason",
      "disposition",
      "count",
      "saturated",
      "firstAtMs",
      "lastAtMs",
    ]);
  });

  it("rejects forged snapshots that exceed the closed bounds", () => {
    const snapshot = createChildUiEventDiagnostics().snapshot();
    expect(isChildUiEventDiagnosticsSnapshot(snapshot)).toBe(true);
    expect(
      isChildUiEventDiagnosticsSnapshot({
        ...snapshot,
        buckets: [
          {
            stage: "stream-ingest",
            classification: "lifecycle-drop",
            reason: "settled",
            disposition: "dropped",
            count: 1,
            saturated: false,
            firstAtMs: 0,
            lastAtMs: 0,
            prompt: "not allowed",
          },
        ],
      }),
    ).toBe(false);
    expect(
      isChildUiEventDiagnosticsSnapshot({
        ...snapshot,
        serializedBytes: snapshot.maxSerializedBytes + 1,
      }),
    ).toBe(false);
    const revocable = Proxy.revocable(snapshot, {});
    revocable.revoke();
    expect(() =>
      isChildUiEventDiagnosticsSnapshot(revocable.proxy),
    ).not.toThrow();
    expect(isChildUiEventDiagnosticsSnapshot(revocable.proxy)).toBe(false);
  });
});
