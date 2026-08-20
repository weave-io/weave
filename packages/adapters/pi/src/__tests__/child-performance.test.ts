import { describe, expect, test } from "bun:test";
import {
  createChildOverlayController,
  createChildOverlayLiveStream,
  createMemoryChildOverlaySource,
} from "../child-overlay.js";
import { CHILD_OVERLAY_BURST_REPAINT_CEILING } from "../child-overlay-stream.js";
import { CHILD_OVERLAY_BOUNDS } from "../child-overlay-types.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import {
  MAX_PI_TRANSCRIPT_RENDER_LINES,
  MAX_PI_TRANSCRIPT_RENDER_STRING,
  MAX_TRANSCRIPT_ENTRIES,
  MAX_TRANSCRIPT_HISTORY_BYTES,
  PiChildTranscript,
  PiChildTranscriptRenderer,
  type PiTranscriptComponentFactory,
} from "../child-transcript.js";
import { FakeClock, FakeIdGenerator } from "./fakes/fake-pi-host.js";

/**
 * These tests deliberately use large synthetic input. They exercise the
 * bounded window, not a live Pi process or the host terminal.
 */
describe("native child transcript performance bounds", () => {
  test("keeps a large transcript inside the reducer history budget", () => {
    const transcript = new PiChildTranscript();
    const text = `large-transcript-window-${"x".repeat(4_000)}`;

    for (let index = 0; index < 3_000; index += 1) {
      const result = transcript.apply({
        kind: index % 2 === 0 ? "task" : "steering",
        text: `${index}:${text}`,
      });
      expect(result.isOk()).toBe(true);
    }

    const state = transcript.getState();
    expect(state.entries.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ENTRIES);
    expect(state.historyBytes).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_HISTORY_BYTES,
    );
    const lastEntry = state.entries.at(-1);
    expect(lastEntry?.kind).toBe("steering");
    expect(lastEntry && "text" in lastEntry ? lastEntry.text : "").toContain(
      "2999:",
    );

    const history = new PiChildTranscript();
    for (let index = 0; index < 1_000; index += 1) {
      expect(
        history
          .applyEvent({
            type: "message_update",
            delta: { messageId: "large-message", text: "x".repeat(10_000) },
          })
          .isOk(),
      ).toBe(true);
    }
    expect(history.getState().historyTrimmedCount).toBeGreaterThan(0);
    expect(history.getState().historyBytes).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_HISTORY_BYTES,
    );
  });

  test("renders a bounded window and caps very large display strings", () => {
    const transcript = new PiChildTranscript();
    expect(transcript.addTask("render me").isOk()).toBe(true);

    const factory: PiTranscriptComponentFactory = {
      create: () => ({
        render: () => [
          "🙂".repeat(MAX_PI_TRANSCRIPT_RENDER_STRING + 100),
          ...Array(999).fill("line"),
        ],
        invalidate: () => undefined,
      }),
    };
    const rendered = new PiChildTranscriptRenderer({
      componentFactory: factory,
    }).render(transcript.getState(), 240);
    expect(rendered.lines.length).toBeLessThanOrEqual(
      MAX_PI_TRANSCRIPT_RENDER_LINES,
    );
    expect(rendered.lines.every((line) => [...line].length <= 240)).toBe(true);
    expect(rendered.lines[0]).toContain("🙂");
  });

  /**
   * The overlay's own burst budget. A live child can emit deltas far faster
   * than a terminal redraws, so the two costs that must stay constant are the
   * retained window and the number of repaints the burst asks for.
   */
  test("keeps a 5,000-event overlay burst inside the window and repaint budgets", async () => {
    const childId = "perf-burst-child";
    const source = createMemoryChildOverlaySource([
      {
        childId,
        threadId: childId,
        status: "live",
        generationId: "generation-1",
        runs: [{ run: 1, action: "start" }],
        branchIds: ["main"],
        descendantChildIds: [],
        entries: [],
      } as never,
    ]);
    const controller = createChildOverlayController(source);
    expect((await controller.open(childId)).isOk()).toBe(true);

    const scheduled: (() => void)[] = [];
    const timer: TimerPort = {
      schedule: (callback: () => void): TimerHandle => {
        let live = true;
        scheduled.push(() => {
          if (live) callback();
        });
        return {
          cancel: () => {
            live = false;
          },
        };
      },
    };
    let repaints = 0;
    const stream = createChildOverlayLiveStream({
      controller,
      repaint: {
        invalidate: () => undefined,
        requestRender: () => {
          repaints += 1;
        },
      },
      timer,
      generationId: "generation-1",
      currentGenerationId: () => "generation-1",
    });

    for (let index = 0; index < 5_000; index += 1) {
      const outcome = stream.ingest(childId, {
        type: "reasoning_summary",
        text: `burst-${index}-${"x".repeat(200)}`,
      });
      expect(outcome.kind).toBe("applied");
    }
    // Close the open refresh window so the trailing frame is counted too.
    for (const tick of scheduled.splice(0, scheduled.length)) tick();

    expect(repaints).toBeLessThanOrEqual(CHILD_OVERLAY_BURST_REPAINT_CEILING);
    const view = controller.view()._unsafeUnwrap();
    expect(view.entries.length).toBeLessThanOrEqual(
      CHILD_OVERLAY_BOUNDS.defaultWindowCap,
    );
    expect(view.transcript.entries.length).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_ENTRIES,
    );
    expect(view.transcript.historyBytes).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_HISTORY_BYTES,
    );
    // The newest fact survives the trim: coalescing costs frames, not facts.
    expect(view.entries.at(-1)?.text).toContain("burst-4999");
    stream.dispose();
  });

  test("uses deterministic injected clock and IDs for a repeatable large window", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const ids = new FakeIdGenerator();
    const first = `${clock.now()}:${ids.next()}`;
    clock.advance(10);
    const second = `${clock.now()}:${ids.next()}`;

    expect(first).toBe("1700000000000:generation-1");
    expect(second).toBe("1700000000010:generation-2");
  });
});
