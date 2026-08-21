/** Real Pi native prompt, rail, usage, and transcript-fact parity. */

import { describe, expect, it } from "bun:test";
import { createChildOverlayController } from "../child-overlay-controller.js";
import {
  childOverlayPromptFacts,
  childOverlayRailFacts,
  childOverlayTranscriptInput,
} from "../child-overlay-facts.js";
import { createPiChildTranscriptState } from "../child-transcript.js";
import {
  settlingSource,
  transcriptOf,
  viewOf,
} from "./child-overlay-real-host-shapes-support.js";

// ---------------------------------------------------------------------------
// 7 & 8. One turn, one spend authority
// ---------------------------------------------------------------------------

describe("the prompt and the rail state the same live facts", () => {
  it("agrees on the turn in one frame", () => {
    const state = transcriptOf(
      [1, 2, 3, 4].flatMap((index) => [
        {
          type: "message_start",
          message: { id: `m${index}`, role: "assistant", content: [] },
        },
        {
          type: "message_end",
          message: {
            id: `m${index}`,
            role: "assistant",
            content: [{ type: "text", text: `answer ${index}` }],
            stopReason: "stop",
          },
        },
      ]),
    );
    // The descriptor snapshot is older than the stream, exactly as a real one
    // taken when the reader opened the child is.
    const view = viewOf(state, { turn: 3 });
    const rail = childOverlayRailFacts(view);
    const prompt = childOverlayPromptFacts(view, {
      draft: "",
      confirmingCancel: false,
    });
    expect(rail.turn).toBe("4");
    expect(String(prompt.turn)).toBe(rail.turn ?? "");
  });

  it("states the latest host report as the run's spend", async () => {
    // Real Pi carries `usage` on every terminal assistant message, and each
    // turn re-sends the whole context, so a report is the run SO FAR priced
    // again — not a slice that could be added up. The latest one is therefore
    // the run's own figure, and summing them would count the context once per
    // turn. This runs through the controller, because that is where the latest
    // usage report is retained and turned into view telemetry.
    const source = settlingSource();
    const controller = createChildOverlayController(source.port);
    (await controller.open("settle-child"))._unsafeUnwrap();
    for (const event of [
      {
        type: "message_start",
        message: { id: "m1", role: "assistant", content: [] },
      },
      {
        type: "message_end",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: {
            input: 2,
            output: 101,
            cacheRead: 4_000,
            totalTokens: 4_103,
            cost: { total: 0.0205 },
          },
        },
      },
    ]) {
      controller.applyLiveEvent(event)._unsafeUnwrap();
    }
    const view = controller.view()._unsafeUnwrap();
    expect(view.telemetry?.inputTokens).toBe(2);
    const rail = childOverlayRailFacts(view);
    // The input side carries the host's cache accounting, so the two printed
    // figures add back up to the host's own `totalTokens`.
    expect(rail.tokensIn).toBe("4k");
    expect(rail.tokensOut).toBe("101");
    expect(rail.cost).toBe("$0.0205");
  });

  it("falls back to the delegation tree's aggregate when no report exists", () => {
    // The aggregate the parent's delegation card prints, on the rail beside a
    // transcript whose own turns reported no usage at all.
    const state = transcriptOf([
      {
        type: "message_start",
        message: { id: "m1", role: "assistant", content: [] },
      },
      {
        type: "message_end",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      },
    ]);
    const rail = childOverlayRailFacts(
      viewOf(state, {
        usage: { inputTokens: 184_200, outputTokens: 12_400, cost: 0.42 },
      }),
    );
    expect(rail.tokensIn).toBe("184.2k");
    expect(rail.tokensOut).toBe("12.4k");
    expect(rail.cost).toBe("$0.4200");
  });
});

// The transcript input projection is shared by the row assertions.
// The transcript input projection is shared by every row assertion above, so
// it is exercised once here rather than repeated in each case.
describe("the pane and the facts describe the same child", () => {
  it("projects one transcript input from the view", () => {
    const view = viewOf(createPiChildTranscriptState());
    expect(childOverlayTranscriptInput(view).childName).toBe("shuttle");
    expect(childOverlayTranscriptInput(view).settled).toBe(false);
  });
});
