/**
 * Three UI-boundary contracts, proven at the surfaces a reader actually sees.
 *
 * 1. RAW REASONING STAYS OUT OF DURABLE AND REPLAY SURFACES. A
 *    `thinking_delta`, a `delta.thinking`, a standalone `thinking` event and a
 *    persisted `thinking` content block are all raw chain-of-thought. They may
 *    drive a separate transient renderer, but their text may never reach the
 *    overlay transcript, the delegation card's model-visible activity line,
 *    card details, or the transcript reducer's own state. Only an explicit
 *    `reasoning_summary` — a structurally distinct host surface — may print
 *    prose in the inspector; it is never derived by truncating or relabelling
 *    raw reasoning.
 *
 * 2. THE TERMINAL OUTCOME IS CARRIED, NOT GUESSED. `completed`, `failed` and
 *    `cancelled` travel from the settlement authority through the descriptor
 *    to the frame marker, the rail and the prompt, live and historical. It is
 *    never read from assistant text, from status prose, or from `message_end`.
 *    History with no outcome keeps the generic `SETTLED` wording.
 *
 * 3. AN UNREPORTED QUEUE IS UNKNOWN. `—` when no authority named a depth, and
 *    `0` / `queue empty` only after an authoritative zero.
 */

import { describe, expect, it } from "bun:test";
import {
  applyDelegationCardEvent,
  applyDelegationCardInput,
  createDelegationCardState,
  projectDelegationCardFacts,
} from "../child-card-model.js";
import {
  createChildCompactState,
  mapPiChildSessionEventToCompactInput,
} from "../child-compact-render.js";
import { createMemoryChildOverlaySource } from "../child-overlay.js";
import { createChildOverlayController } from "../child-overlay-controller.js";
import {
  childOverlayPromptFacts,
  childOverlayRailFacts,
  childOverlaySettlementFacts,
  childOverlayTranscriptInput,
} from "../child-overlay-facts.js";
import {
  OVERLAY_UNKNOWN,
  type OverlayRailFacts,
  renderRailStatusMatrix,
} from "../child-overlay-layout.js";
import { nativeMessageParts } from "../child-overlay-native-parts.js";
import { renderOverlayPiNative } from "../child-overlay-pi-native.js";
import { mapNativeSessionEntryToOverlay } from "../child-overlay-replay.js";
import type {
  ChildOverlayChild,
  ChildOverlayOutcome,
  ChildOverlaySourcePort,
  ChildOverlayView,
} from "../child-overlay-types.js";
import {
  MAX_CHILD_EVENT_STRING,
  parsePiChildSessionEvent,
} from "../child-session-events.js";
import {
  createPiChildTranscriptState,
  reducePiChildTranscript,
  renderPiChildTranscript,
} from "../child-transcript.js";
import { plainPaint } from "../ui-paint.js";

const CHILD_ID = "child-ui-contract";
const RAW = "RAW_CHAIN_OF_THOUGHT_SENTINEL";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function child(over: Partial<ChildOverlayChild> = {}): ChildOverlayChild {
  return {
    childId: CHILD_ID,
    threadId: "thread-1",
    status: "live",
    title: "shuttle",
    generationId: "gen-1",
    runs: [],
    branchIds: [],
    descendantChildIds: [],
    agentName: "shuttle",
    ...over,
  };
}

function source(over: Partial<ChildOverlayChild> = {}): ChildOverlaySourcePort {
  return createMemoryChildOverlaySource([{ ...child(over), entries: [] }]);
}

async function openView(
  over: Partial<ChildOverlayChild> = {},
  events: readonly unknown[] = [],
): Promise<ChildOverlayView> {
  const controller = createChildOverlayController(source(over));
  expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
  for (const event of events) {
    expect(controller.applyLiveEvent(event).isOk()).toBe(true);
  }
  return controller.view()._unsafeUnwrap();
}

function overlayRows(view: ChildOverlayView): string {
  return renderOverlayPiNative(
    plainPaint(),
    childOverlayTranscriptInput(view),
    100,
  ).plain.join("\n");
}

/** The transcript state a sequence of host events reduces to. */
function reduceEvents(events: readonly unknown[]) {
  let state = createPiChildTranscriptState();
  for (const event of events) {
    const next = reducePiChildTranscript(state, {
      kind: "event",
      event: event as never,
    });
    expect(next.isOk()).toBe(true);
    state = next._unsafeUnwrap();
  }
  return state;
}

/** The delegation card after one reducer input, as the parent sees it. */
function cardAfter(input: unknown) {
  const clock = () => 1_000;
  const base = createDelegationCardState({
    agentName: "shuttle",
    assignment: "Fix the reporter.",
  });
  const started = applyDelegationCardInput(
    base,
    {
      kind: "start_run",
      threadId: "thread-opaque-1",
      runNumber: 1,
      action: "start",
      agentName: "shuttle",
    },
    clock,
  )._unsafeUnwrap();
  const state = applyDelegationCardInput(started, input, clock)._unsafeUnwrap();
  return { state, facts: projectDelegationCardFacts(state) };
}

// ---------------------------------------------------------------------------
// 1. Raw reasoning never renders
// ---------------------------------------------------------------------------

describe("raw reasoning never reaches a reader-visible or persisted surface", () => {
  const RAW_EVENT_FORMS: readonly (readonly [string, unknown])[] = [
    ["standalone thinking event", { type: "thinking", text: RAW }],
    [
      "0.84 thinking_delta",
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: RAW },
      },
    ],
    [
      "legacy delta.thinking",
      { type: "message_update", delta: { messageId: "m1", thinking: RAW } },
    ],
  ];

  for (const [name, event] of RAW_EVENT_FORMS) {
    it(`keeps ${name} out of transcript state and the overlay`, async () => {
      const state = reduceEvents([
        { type: "message_start", message: { id: "m1", role: "assistant" } },
        event,
      ]);
      expect(JSON.stringify(state)).not.toContain(RAW);

      const fallback = renderPiChildTranscript(state, 100).lines.join("\n");
      expect(fallback).not.toContain(RAW);

      const view = await openView({}, [
        { type: "message_start", message: { id: "m1", role: "assistant" } },
        event,
      ]);
      const rows = overlayRows(view);
      expect(rows).not.toContain(RAW);
      // It is never relabelled as a summary either.
      expect(rows).not.toContain("SUMMARY");
    });

    it(`keeps ${name} off the parent card's line and out of its rows`, () => {
      const mapped = mapPiChildSessionEventToCompactInput(event as never);
      expect(mapped.isOk()).toBe(true);
      expect(JSON.stringify(mapped._unsafeUnwrap())).not.toContain(RAW);

      const { state, facts } = cardAfter(mapped._unsafeUnwrap());
      // The model-visible activity line.
      expect(facts.activity.text).not.toContain(RAW);
      // The persisted card details.
      expect(JSON.stringify(state)).not.toContain(RAW);
      expect(JSON.stringify(facts)).not.toContain(RAW);
    });
  }

  it("counts a persisted raw reasoning block without reading it", () => {
    const parts = nativeMessageParts({
      role: "assistant",
      content: [
        { type: "thinking", thinking: RAW },
        { type: "text", text: "the answer" },
      ],
    })._unsafeUnwrap();
    expect(parts.reasoningBlocks).toBe(1);
    expect(parts.reasoningSummaries).toEqual([]);
    expect(JSON.stringify(parts)).not.toContain(RAW);

    const entry = mapNativeSessionEntryToOverlay(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: RAW },
          { type: "text", text: "the answer" },
        ],
      },
      0,
    )._unsafeUnwrap();
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain(RAW);
  });

  it("renders no rows for an explicit legacy host reasoning summary", async () => {
    const view = await openView({}, [
      { type: "reasoning_summary", text: "weighed two fixes" },
    ]);
    const rows = overlayRows(view);
    expect(rows).not.toContain("reasoning · SUMMARY");
    expect(rows).not.toContain("weighed two fixes");
  });

  it("keeps a host reasoning summary out of the parent card", () => {
    const mapped = mapPiChildSessionEventToCompactInput({
      type: "reasoning_summary",
      text: "weighed two fixes",
    } as never)._unsafeUnwrap();
    const { facts } = cardAfter(mapped);
    expect(facts.activity).toEqual({ kind: "boot", text: "", live: false });
    expect(facts.viewport).toEqual({ rows: [], above: 0, atBottom: true });
    expect(JSON.stringify(facts)).not.toContain("weighed two fixes");
  });

  it("never promotes a raw thinking record to a summary at the parse boundary", () => {
    // A caller (or a corrupted persisted record) that attaches `summary` to a
    // raw thinking input has it dropped rather than honoured.
    const { state, facts } = cardAfter({
      kind: "thinking",
      itemId: "assistant:thinking",
      summary: RAW,
    });
    expect(facts.activity.text).not.toContain(RAW);
    expect(JSON.stringify(state)).not.toContain(RAW);
  });
});

// ---------------------------------------------------------------------------
// 2. The terminal outcome is carried, not guessed
// ---------------------------------------------------------------------------

describe("the authoritative terminal outcome reaches every settled surface", () => {
  const CASES: readonly (readonly [
    ChildOverlayOutcome,
    string,
    OverlayRailFacts["tone"],
  ])[] = [
    ["completed", "COMPLETED", "ok"],
    ["failed", "FAILED", "bad"],
    ["cancelled", "CANCELLED", "warn"],
  ];

  for (const [outcome, word, tone] of CASES) {
    it(`states ${outcome} on a live child that has settled`, async () => {
      const view = await openView({ status: "settled", outcome });
      const settlement = childOverlaySettlementFacts(view);
      expect(settlement.word).toBe(word);
      expect(settlement.tone).toBe(tone);
      expect(settlement.settled).toBe(true);
      expect(childOverlayRailFacts(view).status).toBe(word);
      expect(
        childOverlayPromptFacts(view, { draft: "", confirmingCancel: false })
          .stateWord,
      ).toBe(word);
    });

    it(`states ${outcome} again after a restart reopens the same child`, async () => {
      // A restart describes the child afresh through the source boundary; the
      // strict schema is what admits the outcome.
      const reopened = await openView({ status: "settled", outcome });
      expect(reopened.child.outcome).toBe(outcome);
      expect(childOverlaySettlementFacts(reopened).word).toBe(word);
    });

    it(`states ${outcome} on a replayed transcript with contradicting prose`, async () => {
      // Assistant text and reported status prose are NOT settlement authority.
      const view = await openView({ status: "settled", outcome }, [
        { type: "status", status: "everything is fine" },
        {
          type: "message_end",
          message: {
            id: "m1",
            role: "assistant",
            content: "I have completed the task successfully",
            stopReason: "stop",
          },
        },
      ]);
      expect(childOverlaySettlementFacts(view).word).toBe(word);
    });
  }

  it("keeps the generic settled word when history carries no outcome", async () => {
    const view = await openView({ status: "settled" });
    const settlement = childOverlaySettlementFacts(view);
    expect(view.child.outcome).toBeUndefined();
    expect(settlement.word).toBe("SETTLED");
    expect(settlement.phase).toBe("completed");
    expect(settlement.settled).toBe(true);
  });

  it("never reads an outcome off a live child", async () => {
    const view = await openView({ status: "live" });
    expect(childOverlaySettlementFacts(view).word).toBe("LIVE");
  });
});

// ---------------------------------------------------------------------------
// 3. An unreported queue is unknown
// ---------------------------------------------------------------------------

describe("queue depth stays optional through every boundary", () => {
  const railText = (facts: OverlayRailFacts): string =>
    renderRailStatusMatrix(plainPaint(), facts, 40, 40).join("\n");

  /** A card with one run already started, ready to apply an event to. */
  const startedCard = () =>
    applyDelegationCardInput(
      createDelegationCardState({ agentName: "shuttle", assignment: "probe" }),
      {
        kind: "start_run",
        threadId: "thread-opaque-1",
        runNumber: 1,
        action: "start",
        agentName: "shuttle",
      },
      () => 2_000,
    )._unsafeUnwrap();

  it("reports unknown when no authority named a depth (live)", async () => {
    const view = await openView({ status: "live" });
    const rail = childOverlayRailFacts(view);
    expect(rail.queueCount).toBeUndefined();
    expect(railText(rail)).toContain(OVERLAY_UNKNOWN);
    expect(railText(rail)).not.toContain("queue empty");
    expect(
      childOverlayPromptFacts(view, { draft: "", confirmingCancel: false })
        .queueCount,
    ).toBeUndefined();
  });

  it("reports unknown when no authority named a depth (historical)", async () => {
    const view = await openView({ status: "settled", outcome: "completed" });
    expect(childOverlayRailFacts(view).queueCount).toBeUndefined();
  });

  it("reports unknown for a `queue_update` that names only one queue", async () => {
    // One empty list is a statement about ONE queue. The rail must keep saying
    // `—`: printing `0` here would tell the reader, with the child's own
    // authority, that a steered child has nothing queued.
    for (const partial of [
      { type: "queue_update", steering: [] },
      { type: "queue_update", followUp: [] },
      { type: "queue_update", steering: ["steer"] },
    ]) {
      const view = await openView({ status: "live" }, [partial]);
      const rail = childOverlayRailFacts(view);
      expect(rail.queueCount).toBeUndefined();
      expect(rail.firstQueued).toBeUndefined();
      const text = railText(rail);
      expect(text).toContain(OVERLAY_UNKNOWN);
      expect(text).not.toContain("queue empty");
      expect(text).not.toContain("queue 0");
      expect(
        childOverlayPromptFacts(view, { draft: "", confirmingCancel: false })
          .queueCount,
      ).toBeUndefined();
      expect(overlayRows(view)).not.toContain("queue: 0");
    }
  });

  it("reports unknown for a `queue_update` whose queues cannot be read, without running its accessors", async () => {
    // Descriptor-only reading: a getter is the payload's own code, an
    // overbound entry is a string the host never queued, and a hostile or
    // revoked proxy states nothing at all. None of them may reach the rail.
    let fieldReads = 0;
    let elementReads = 0;

    const accessorField: Record<string, unknown> = {
      type: "queue_update",
      followUp: [],
    };
    Object.defineProperty(accessorField, "steering", {
      enumerable: true,
      configurable: true,
      get: () => {
        fieldReads += 1;
        return ["steer"];
      },
    });

    const accessorIndex: unknown[] = [];
    Object.defineProperty(accessorIndex, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        elementReads += 1;
        return "steer";
      },
    });

    const revocable = Proxy.revocable(["steer"], {});
    revocable.revoke();

    for (const rejected of [
      accessorField,
      { type: "queue_update", steering: accessorIndex, followUp: [] },
      {
        type: "queue_update",
        steering: ["q".repeat(MAX_CHILD_EVENT_STRING + 1)],
        followUp: [],
      },
      { type: "queue_update", steering: revocable.proxy, followUp: [] },
    ]) {
      const view = await openView({ status: "live" }, [rejected]);
      const rail = childOverlayRailFacts(view);
      expect(rail.queueCount).toBeUndefined();
      expect(rail.firstQueued).toBeUndefined();
      const text = railText(rail);
      expect(text).toContain(OVERLAY_UNKNOWN);
      expect(text).not.toContain("queue empty");
      expect(text).not.toContain("queue 0");
      expect(text).not.toContain("queue 1");
      expect(
        childOverlayPromptFacts(view, { draft: "", confirmingCancel: false })
          .queueCount,
      ).toBeUndefined();
      expect(overlayRows(view)).not.toContain("queue: 0");
      expect(overlayRows(view)).not.toContain("queue: 1");

      // The compact render and the card learn nothing either.
      const parsed = parsePiChildSessionEvent(rejected);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error("unreachable");
      expect(
        mapPiChildSessionEventToCompactInput(parsed.data)._unsafeUnwrap()?.kind,
      ).not.toBe("queue");
      const facts = projectDelegationCardFacts(
        applyDelegationCardEvent(
          startedCard(),
          parsed.data,
          () => 2_000,
          "assistant",
        )._unsafeUnwrap(),
      );
      expect(facts.run.phase).not.toBe("steered");
      expect(facts.activity?.kind).not.toBe("queue");
    }

    // Proof the decision never consulted the payload's own code.
    expect(fieldReads).toBe(0);
    expect(elementReads).toBe(0);
  });

  it("preserves the exact strings and size of a valid report on the rail and the card", async () => {
    const exact = "q".repeat(MAX_CHILD_EVENT_STRING);
    const view = await openView({ status: "live" }, [
      { type: "queue_update", steering: ["steer"], followUp: [exact] },
    ]);
    expect(childOverlayRailFacts(view).queueCount).toBe(2);

    const parsed = parsePiChildSessionEvent({
      type: "queue_update",
      steering: ["steer"],
      followUp: [exact],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    expect(parsed.data).toMatchObject({
      type: "queue_change",
      size: 2,
      queue: ["steer", exact],
    });
    const facts = projectDelegationCardFacts(
      applyDelegationCardEvent(
        startedCard(),
        parsed.data,
        () => 2_000,
        "assistant",
      )._unsafeUnwrap(),
    );
    expect(facts.run.phase).toBe("steered");
  });

  it("reports zero for a complete empty `queue_update`", async () => {
    const view = await openView({ status: "live" }, [
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    expect(childOverlayRailFacts(view).queueCount).toBe(0);
  });

  it("keeps a type-getter or inherited queue_update off the rail, card and replay", async () => {
    let reads = 0;
    const accessorType: Record<string, unknown> = {
      steering: ["steer"],
      followUp: ["later"],
    };
    Object.defineProperty(accessorType, "type", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return "queue_update";
      },
    });

    const inherited = Object.create({ type: "queue_update" }) as Record<
      string,
      unknown
    >;
    inherited.steering = ["steer"];
    inherited.followUp = ["later"];

    for (const rejected of [accessorType, inherited]) {
      const view = await openView({ status: "live" }, [rejected]);
      const rail = childOverlayRailFacts(view);
      expect(rail.queueCount).toBeUndefined();
      expect(rail.firstQueued).toBeUndefined();
      const text = railText(rail);
      expect(text).toContain(OVERLAY_UNKNOWN);
      expect(text).not.toContain("queue empty");
      expect(text).not.toContain("queue 0");
      expect(text).not.toContain("queue 2");
      expect(
        childOverlayPromptFacts(view, { draft: "", confirmingCancel: false })
          .queueCount,
      ).toBeUndefined();
      expect(overlayRows(view)).not.toContain("queue: 2");

      const parsed = parsePiChildSessionEvent(rejected);
      expect(() => parsePiChildSessionEvent(rejected)).not.toThrow();
      if (parsed.success) {
        expect(parsed.data.type).not.toBe("queue_change");
        expect(
          mapPiChildSessionEventToCompactInput(parsed.data)._unsafeUnwrap()
            ?.kind,
        ).not.toBe("queue");
        const facts = projectDelegationCardFacts(
          applyDelegationCardEvent(
            startedCard(),
            parsed.data,
            () => 2_000,
            "assistant",
          )._unsafeUnwrap(),
        );
        expect(facts.run.phase).not.toBe("steered");
        expect(facts.activity?.kind).not.toBe("queue");
      } else {
        expect(parsed.success).toBe(false);
      }
    }

    expect(reads).toBe(0);
  });

  it("keeps a descriptor/get divergent proxy off the rail, card and replay", async () => {
    let getReads = 0;
    const forged = new Proxy(
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

    const view = await openView({ status: "live" }, [forged]);
    const rail = childOverlayRailFacts(view);
    expect(rail.queueCount).toBeUndefined();
    expect(rail.firstQueued).toBeUndefined();
    expect(railText(rail)).toContain(OVERLAY_UNKNOWN);
    expect(railText(rail)).not.toContain("queue empty");
    expect(railText(rail)).not.toContain("queue 0");
    expect(railText(rail)).not.toContain("queue 2");
    expect(
      childOverlayPromptFacts(view, { draft: "", confirmingCancel: false })
        .queueCount,
    ).toBeUndefined();
    expect(overlayRows(view)).not.toContain("queue: 2");

    const parsed = parsePiChildSessionEvent(forged);
    expect(() => parsePiChildSessionEvent(forged)).not.toThrow();
    expect(getReads).toBe(0);
    if (parsed.success) {
      expect(parsed.data.type).not.toBe("queue_change");
      expect(
        mapPiChildSessionEventToCompactInput(parsed.data)._unsafeUnwrap()?.kind,
      ).not.toBe("queue");
      const facts = projectDelegationCardFacts(
        applyDelegationCardEvent(
          startedCard(),
          parsed.data,
          () => 2_000,
          "assistant",
        )._unsafeUnwrap(),
      );
      expect(facts.run.phase).not.toBe("steered");
      expect(facts.activity?.kind).not.toBe("queue");
    } else {
      expect(parsed.success).toBe(false);
    }
  });

  it("keeps a partial `queue_update` off the compact render and the card", () => {
    const parsed = parsePiChildSessionEvent({
      type: "queue_update",
      steering: [],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");

    const mapped = mapPiChildSessionEventToCompactInput(
      parsed.data,
    )._unsafeUnwrap();
    expect(mapped?.kind).not.toBe("queue");

    const started = applyDelegationCardInput(
      createDelegationCardState({ agentName: "shuttle", assignment: "probe" }),
      {
        kind: "start_run",
        threadId: "thread-opaque-1",
        runNumber: 1,
        action: "start",
        agentName: "shuttle",
      },
      () => 2_000,
    )._unsafeUnwrap();
    const applied = applyDelegationCardEvent(
      started,
      parsed.data,
      () => 2_000,
      "assistant",
    )._unsafeUnwrap();
    const facts = projectDelegationCardFacts(applied);
    expect(facts.run.phase).not.toBe("steered");
    expect(facts.activity?.kind).not.toBe("queue");
  });

  it("reports zero only after an authoritative zero (live)", async () => {
    const view = await openView({ status: "live" }, [
      { type: "queue_change", size: 0, queue: [] },
    ]);
    const rail = childOverlayRailFacts(view);
    expect(rail.queueCount).toBe(0);
    expect(railText(rail)).toContain("0");
  });

  it("reports zero from an authoritative descriptor depth (historical)", async () => {
    const view = await openView({
      status: "settled",
      outcome: "completed",
      queueDepth: 0,
    });
    expect(childOverlayRailFacts(view).queueCount).toBe(0);
    expect(
      childOverlayPromptFacts(view, { draft: "", confirmingCancel: false })
        .queueCount,
    ).toBe(0);
  });

  it("reports a positive depth from the child's own queue event", async () => {
    const view = await openView({ status: "live" }, [
      { type: "queue_change", size: 3, queue: [] },
    ]);
    expect(childOverlayRailFacts(view).queueCount).toBe(3);
  });

  it("reports a positive descriptor depth for a historical child", async () => {
    const view = await openView({
      status: "settled",
      outcome: "failed",
      queueDepth: 2,
    });
    expect(childOverlayRailFacts(view).queueCount).toBe(2);
  });

  it("keeps a compact-render queue input free of a fabricated size", () => {
    const mapped = mapPiChildSessionEventToCompactInput({
      type: "queue_change",
      queue: [],
    } as never)._unsafeUnwrap();
    expect(mapped).toBeDefined();
    if (mapped !== undefined && mapped.kind === "queue") {
      expect(mapped.size).toBeUndefined();
    }
    expect(JSON.stringify(createChildCompactState("t"))).not.toContain(
      '"size"',
    );
  });
});
