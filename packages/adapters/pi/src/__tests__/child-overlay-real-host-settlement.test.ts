/** Real Pi native settlement and authoritative host-capture parity. */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  readFixtureAndManifest,
  replayFixtureThroughAdapter,
  validateFixtureStructure,
  verifyCaptureManifest,
} from "../../../../../scripts/pi/child-stream-capture.js";
import {
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
} from "../child-overlay.js";
import {
  ChildOverlayController,
  createChildOverlayController,
} from "../child-overlay-controller.js";
import {
  childOverlayPromptFacts,
  childOverlayRailFacts,
  childOverlaySettlementFacts,
  childOverlayTranscriptInput,
} from "../child-overlay-facts.js";
import { renderOverlayPiNative } from "../child-overlay-pi-native.js";
import { createChildOverlayLiveStream } from "../child-overlay-stream.js";
import {
  redactProviderErrorFromEvent,
  TOOL_RESULT_DETAILS_UNAVAILABLE,
  toolDetailProjectionLossKey,
} from "../child-provider-error.js";
import { parsePiChildSessionEvent } from "../child-session-events.js";
import { createChildUiEventDiagnostics } from "../child-ui-event-diagnostics.js";
import { PiDelegationCardStream } from "../delegation-tool.js";
import { plainPaint } from "../ui-paint.js";
import {
  drain,
  ImmediateTimerPort,
  settlingSource,
} from "./child-overlay-real-host-shapes-support.js";

describe("settlement refreshes the mounted overlay from the tree", () => {
  it("makes the frame, the rail, the prompt and the elapsed time agree", async () => {
    const source = settlingSource();
    const controller = createChildOverlayController(source.port);
    (await controller.open("settle-child"))._unsafeUnwrap();

    let painted = 0;
    const timer = new ImmediateTimerPort();
    const stream = createChildOverlayLiveStream({
      controller,
      repaint: {
        invalidate: () => {
          painted += 1;
        },
        requestRender: () => {},
      },
      timer,
      generationId: "gen-1",
      currentGenerationId: () => "gen-1",
      // Exactly the contract `resolveThreadIdForLiveChild` now honours: a
      // thread id for a RUNNING child, and nothing once it settled.
      resolveLiveThreadId: () => (source.live() ? "settle-thread" : undefined),
    });

    // Still running: the tree's own elapsed time reaches the open descriptor.
    source.advance();
    stream.noteTreeChanged();
    await drain();
    expect(
      childOverlayRailFacts(controller.view()._unsafeUnwrap()).elapsed,
    ).toBe("1m 1s");

    source.settle();
    stream.noteTreeChanged();
    await stream.settlementPending();
    await drain();

    const view = controller.view()._unsafeUnwrap();
    const settlement = childOverlaySettlementFacts(view);
    const rail = childOverlayRailFacts(view);
    const prompt = childOverlayPromptFacts(view, {
      draft: "a steering message",
      confirmingCancel: false,
    });
    expect(settlement.phase).toBe("completed");
    expect(settlement.word).toBe("SETTLED");
    expect(rail.status).toBe("SETTLED");
    expect(rail.tone).toBe(settlement.tone);
    // Current, not the value captured when the reader opened the child.
    expect(rail.elapsed).toBe("1m 32s");
    expect(rail.tokensIn).toBe("184.2k");
    expect(rail.live).toBeUndefined();
    // Read-only, caretless, and with no draft carried into a settled child.
    expect(prompt.settled).toBe(true);
    expect(prompt.draft).toBe("");
    expect(String(prompt.turn)).toBe(rail.turn ?? "");
    expect(view.readOnly).toBe(true);
    expect(painted).toBeGreaterThan(0);

    // A late event cannot revert the final frame.
    expect(stream.isSettled()).toBe(true);
    expect(
      stream.ingest("settle-child", { type: "text", text: "too late" }).kind,
    ).toBe("dropped");
    expect(controller.view()._unsafeUnwrap().child.status).toBe("settled");
    stream.dispose();
  });
});

describe("authoritative Pi 0.84.2 capture shape", () => {
  it("keeps thinking, incremental answer, read, and bash ordering replayable", async () => {
    const fixturePath = join(
      import.meta.dir,
      "../__fixtures__/pi-0.84.2-child-ui-events.v1.json",
    );
    const loaded = await readFixtureAndManifest(fixturePath);
    expect(loaded.isOk()).toBe(true);
    if (loaded.isErr()) return;
    const verified = verifyCaptureManifest(
      loaded.value.fixtureText,
      loaded.value.manifestText,
    );
    expect(verified.isOk()).toBe(true);
    if (verified.isErr()) return;
    const structure = validateFixtureStructure(verified.value.fixture);
    expect(structure.isOk()).toBe(true);
    if (structure.isErr()) return;
    expect(structure.value.hasThinkingLifecycle).toBe(true);
    expect(structure.value.textDeltaCount).toBeGreaterThanOrEqual(2);
    expect(structure.value.hasReadTool).toBe(true);
    expect(structure.value.hasBashTool).toBe(true);

    const replay = replayFixtureThroughAdapter(verified.value.fixture, {
      injectControlledReasoningInMemory: true,
    });
    expect(replay.isOk()).toBe(true);
    if (replay.isErr()) return;
    expect(replay.value.syntheticReasoningLeaked).toBe(false);
    expect(replay.value.inspectorToolDetailsLaneAvailable).toBe(true);
    expect(replay.value.inspectorAssistantReplyLaneAvailable).toBe(true);
  });

  it("diagnoses the first live tool-detail loss through both sinks", async () => {
    const fixturePath = join(
      import.meta.dir,
      "../__fixtures__/pi-0.84.2-child-ui-events.v1.json",
    );
    const loaded = await readFixtureAndManifest(fixturePath);
    expect(loaded.isOk()).toBe(true);
    if (loaded.isErr()) return;
    const verified = verifyCaptureManifest(
      loaded.value.fixtureText,
      loaded.value.manifestText,
    );
    expect(verified.isOk()).toBe(true);
    if (verified.isErr()) return;

    const child: MemoryOverlaySourceChild = {
      childId: "fixture-child",
      threadId: "fixture-child",
      status: "live",
      title: "fixture child",
      generationId: "fixture-generation",
      parentChildId: undefined,
      agentName: "shuttle",
      model: "fixture-model",
      runs: [{ run: 1, action: "start" }],
      branchIds: ["main"],
      descendantChildIds: [],
      entries: [],
    };
    const diagnostics = createChildUiEventDiagnostics({
      now: () => 1_700_000_000_000,
    });
    const controller = new ChildOverlayController(
      createMemoryChildOverlaySource([child]),
      {},
      undefined,
      undefined,
      diagnostics,
    );
    const opened = await controller.open(child.childId);
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) return;

    const stream = createChildOverlayLiveStream({
      controller,
      repaint: { invalidate: () => {}, requestRender: () => {} },
      timer: new ImmediateTimerPort(),
      generationId: "fixture-generation",
      currentGenerationId: () => "fixture-generation",
      resolveLiveThreadId: () => child.threadId,
      diagnostics,
    });
    const cardUpdates: Array<{
      readonly content: readonly unknown[];
      readonly details?: unknown;
    }> = [];
    const card = new PiDelegationCardStream({
      threadId: child.threadId,
      agentName: child.agentName ?? "shuttle",
      assignment: "replay the authoritative capture",
      model: child.model,
      timerPort: new ImmediateTimerPort(),
      diagnostics,
      onUpdate: (update) => cardUpdates.push(update),
    });
    card.start();

    const renderRows = (): readonly string[] =>
      renderOverlayPiNative(
        plainPaint(),
        childOverlayTranscriptInput(controller.view()._unsafeUnwrap()),
        96,
      ).plain.map((line) => line.replace(/\s+$/u, ""));
    const toolBuckets = () =>
      diagnostics
        .snapshot()
        .buckets.filter(
          (bucket) =>
            bucket.stage === "overlay-mapping" &&
            bucket.reason === "tool-detail-redacted",
        );

    const event13 = verified.value.fixture.events.find(
      (captured) => captured.ordinalId === 13,
    );
    expect(event13).toBeDefined();
    if (event13 === undefined) return;
    const event13Parsed = parsePiChildSessionEvent(event13.payload);
    expect(event13Parsed.success).toBe(true);
    if (!event13Parsed.success) return;
    // Task 3's red control remains red at the old projection seam: the
    // normalized event is known to carry useful detail, and that projection
    // still replaces it with the closed privacy placeholder.
    const redControl = redactProviderErrorFromEvent(event13Parsed.data);
    expect(toolDetailProjectionLossKey(event13Parsed.data, redControl)).toBe(
      "tool-call-1",
    );
    expect(JSON.stringify(redControl)).not.toContain(
      "weave capture deterministic workspace file",
    );

    let appliedCount = 0;
    for (const captured of verified.value.fixture.events) {
      const parsed = parsePiChildSessionEvent(captured.payload);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;

      // This is the same order as PiDelegationController's observer fanout:
      // checkpoint-approved events reach the focused overlay first, then the
      // independent delegation-card sink. Both sinks receive the same parsed
      // event; neither reads the other's projection.
      const outcome = stream.ingest(child.childId, parsed.data);
      card.applyEvent(parsed.data);
      expect(outcome.kind).toBe("applied");
      if (outcome.kind === "applied") appliedCount += 1;

      const bucket = toolBuckets()[0];

      if (captured.ordinalId === 13) {
        const rows = renderRows().join("\n");
        expect(bucket).toBeUndefined();
        expect(rows).toContain("⚙ read(path: weave-capture-sample.txt)");
        expect(rows).toContain("⎿ weave capture deterministic workspace file");
        expect(rows).not.toContain(TOOL_RESULT_DETAILS_UNAVAILABLE);
      }
      if (captured.ordinalId === 28) {
        const rows = renderRows().join("\n");
        expect(bucket).toBeUndefined();
        expect(rows).toContain("⚙ bash(command: echo weave-capture-ok)");
        expect(rows).toContain("⎿ weave-capture-ok");
      }
      if (captured.ordinalId === 29) {
        const rows = renderRows().join("\n");
        expect(bucket).toBeUndefined();
        expect(rows).toContain("⚙ bash(command: echo weave-capture-ok)");
        expect(rows).toContain("⎿ weave-capture-ok");
        // The update and terminal are one in-place correlated row.
        expect(rows.match(/⚙ bash\(/gu)?.length).toBe(1);
        expect(rows.match(/⎿ weave-capture-ok/gu)?.length).toBe(1);
      }
    }

    const snapshot = diagnostics.snapshot();
    expect(appliedCount).toBe(verified.value.fixture.events.length);
    // The old projection still has a red control above, but the live native
    // path no longer visits it, so no tool-detail-loss bucket is emitted.
    expect(toolBuckets()).toEqual([]);
    // Diagnostic state is a bounded closed-code aggregate, not a transcript.
    const serializedDiagnostics = JSON.stringify(snapshot);
    expect(serializedDiagnostics).not.toContain("weave-capture");
    expect(serializedDiagnostics).not.toContain("<reasoning-omitted>");

    const finalRows = renderRows().join("\n");
    expect(finalRows).toContain("Weave capture deterministic final answer.");
    // The authoritative answer remains in the inspector's settled transcript;
    // the parent card keeps its child-activity boundary content-free.
    expect(card.facts().activity).toEqual({
      kind: "boot",
      text: "",
      live: false,
    });
    const parentCardSurface = JSON.stringify({
      facts: card.facts(),
      details: card.details(),
      updates: cardUpdates,
    });
    expect(parentCardSurface).not.toMatch(
      /read|bash|tool-call-1|tool-call-2|weave-capture-ok|stdout|stderr|83 tests passed/iu,
    );
    expect(parentCardSurface).not.toContain(
      "Weave capture deterministic final answer.",
    );
    stream.dispose();
    card.dispose();
  });
});
