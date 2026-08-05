import { describe, expect, test } from "bun:test";
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
    expect(state.historyBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_HISTORY_BYTES);
    const lastEntry = state.entries.at(-1);
    expect(lastEntry?.kind).toBe("steering");
    expect(lastEntry && "text" in lastEntry ? lastEntry.text : "").toContain("2999:");

    const history = new PiChildTranscript();
    for (let index = 0; index < 1_000; index += 1) {
      expect(
        history.applyEvent({
          type: "message_update",
          delta: { messageId: "large-message", text: "x".repeat(10_000) },
        }).isOk(),
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
        render: () => ["🙂".repeat(MAX_PI_TRANSCRIPT_RENDER_STRING + 100), ...Array(999).fill("line")],
        invalidate: () => undefined,
      }),
    };
    const rendered = new PiChildTranscriptRenderer({ componentFactory: factory }).render(
      transcript.getState(),
      240,
    );
    expect(rendered.lines.length).toBeLessThanOrEqual(MAX_PI_TRANSCRIPT_RENDER_LINES);
    expect(rendered.lines.every((line) => [...line].length <= 240)).toBe(true);
    expect(rendered.lines[0]).toContain("🙂");
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
