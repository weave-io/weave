/**
 * The card's tool boundary: what `weave_delegate` stores on a result, what it
 * accepts back, what it draws, and what it refuses to draw.
 *
 * These are the assertions that stop the two dangerous regressions this wiring
 * invites: an entry that draws two frames (Pi's shell plus the card, or the
 * call row plus the card), and a card drawn from a payload this adapter cannot
 * vouch for.
 */

import { describe, expect, it } from "bun:test";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { okAsync, ResultAsync } from "neverthrow";
import {
  CARD_AGENT_NAME_MAX,
  CARD_ASSIGNMENT_MAX,
  CARD_MODEL_MAX,
  CARD_ROW_HEAD_MAX,
  CARD_ROW_TEXT_MAX,
  CARD_TELEMETRY_MAX,
  CARD_TERMINAL_TEXT_MAX,
  CARD_VIEWPORT_ROWS,
  type PiDelegationCardFacts,
} from "../child-card-model.js";
import { CARD_MIN_WIDTH } from "../child-card-render.js";
import {
  createPiLiveReasoningRegistry,
  PiLiveReasoningProjector,
} from "../child-live-reasoning.js";
import {
  boundDelegationCardDetails,
  buildDelegationToolRegistration,
  buildRelayedDelegationToolRegistration,
  CARD_DETAILS_INVALID_CODE,
  DELEGATION_CARD_DETAILS_VERSION,
  MAX_DELEGATION_CARD_DETAILS_BYTES,
  type PiDelegationCardDetails,
  type PiDelegationToolDeps,
  parseDelegationCardDetails,
  WEAVE_DELEGATION_TOOL_NAME,
} from "../delegation-tool.js";
import { createOpenSessionMutationGate } from "../required-capability-gate.js";
import type { PiChildSettlement } from "../rpc-child.js";
import type {
  PiSessionContext,
  PiToolRenderContext,
  PiToolResult,
  PiUiThemePort,
} from "../types.js";

const FRAME_GLYPHS = [
  "\u256d",
  "\u256e",
  "\u2570",
  "\u256f",
  "\u2502",
  "\u2500",
];

const THEME: PiUiThemePort = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const TARGETS: readonly DelegationTarget[] = [
  {
    name: "shuttle",
    description: "General specialist",
    triggers: [],
    isCategory: false,
  },
];

function ctx(): PiSessionContext {
  return { cwd: "/repo" } as PiSessionContext;
}

function renderContext(
  overrides: Partial<PiToolRenderContext> = {},
): PiToolRenderContext {
  return {
    args: { agent: "shuttle" },
    toolCallId: "tool-test",
    state: {},
    lastComponent: undefined,
    invalidate: () => undefined,
    ...overrides,
  };
}

function facts(
  overrides: Partial<PiDelegationCardFacts> = {},
): PiDelegationCardFacts {
  return {
    schemaVersion: 1,
    tool: WEAVE_DELEGATION_TOOL_NAME,
    agentName: "shuttle",
    model: "gpt-5.6-terra",
    run: { number: 1, action: "start", phase: "responding" },
    status: "running",
    tone: "run",
    settled: false,
    assignment: "inspect the adapter",
    activity: { kind: "say", text: "reading delegation-tool.ts", live: true },
    telemetry: { elapsed: "12s" },
    viewport: {
      rows: [{ kind: "msg", head: "shuttle", text: "reading" }],
      above: 0,
      atBottom: true,
    },
    ...overrides,
  };
}

function details(
  overrides: Partial<PiDelegationCardFacts> = {},
): PiDelegationCardDetails {
  return {
    kind: "weave-delegation-card",
    version: DELEGATION_CARD_DETAILS_VERSION,
    facts: facts(overrides),
  };
}

function rootDeps(
  overrides: Partial<PiDelegationToolDeps> = {},
): PiDelegationToolDeps {
  return {
    targets: TARGETS,
    parentId: "root",
    parentDepth: 0,
    parentAgentName: "loom",
    idGenerator: { next: () => "child-1" },
    buildBootstrap: () => ({}),
    buildEnv: () => ({}),
    getParentSessionState: () => ({
      persistence: "persistent",
      sessionId: "session-1",
    }),
    sessionMutationGate: createOpenSessionMutationGate(),
    getController: () =>
      ({
        delegate: () =>
          okAsync({
            outcome: "completed",
            assistantOutput: "done",
          } as PiChildSettlement),
        threadStatus: () => undefined,
      }) as never,
    ...overrides,
  } as PiDelegationToolDeps;
}

function render(
  registration: ReturnType<typeof buildDelegationToolRegistration>,
  result: PiToolResult,
  expanded = false,
  theme: PiUiThemePort = THEME,
): string[] {
  return (
    registration
      .renderResult?.(
        result,
        { expanded, isPartial: false },
        theme,
        renderContext(),
      )
      .render(80) ?? []
  );
}

describe("weave_delegate card registration", () => {
  it("hands the whole entry to the tool on both the root and the relayed tool", () => {
    expect(buildDelegationToolRegistration(rootDeps()).renderShell).toBe(
      "self",
    );
    expect(
      buildRelayedDelegationToolRegistration({
        targets: TARGETS,
        getRuntime: () => undefined,
        sessionMutationGate: createOpenSessionMutationGate(),
      }).renderShell,
    ).toBe("self");
  });

  it("registers no keybinding of its own", () => {
    const registration = buildDelegationToolRegistration(rootDeps());
    expect(Object.keys(registration)).not.toContain("keybinding");
    expect(Object.keys(registration)).not.toContain("shortcut");
  });
});

describe("weave_delegate renderCall", () => {
  it("draws one bounded muted row naming the tool and the target", () => {
    const registration = buildDelegationToolRegistration(rootDeps());
    const lines =
      registration
        .renderCall?.(
          { agent: "shuttle", task: "do it" },
          THEME,
          renderContext(),
        )
        .render(80) ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(WEAVE_DELEGATION_TOOL_NAME);
    expect(lines[0]).toContain("Shuttle");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    // The pre-execution row is not a card: it draws no frame.
    for (const frameGlyph of FRAME_GLYPHS)
      expect(lines[0]).not.toContain(frameGlyph);
  });

  it("clips the row to a narrow caller width", () => {
    const registration = buildDelegationToolRegistration(rootDeps());
    const lines =
      registration
        .renderCall?.({ agent: "shuttle" }, THEME, renderContext({ args: {} }))
        .render(10) ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThanOrEqual(10);
  });

  it("returns zero lines once execution started, on root and relayed alike", () => {
    const root = buildDelegationToolRegistration(rootDeps());
    const relayed = buildRelayedDelegationToolRegistration({
      targets: TARGETS,
      getRuntime: () => undefined,
      sessionMutationGate: createOpenSessionMutationGate(),
    });
    for (const registration of [root, relayed]) {
      expect(
        registration
          .renderCall?.(
            { agent: "shuttle" },
            THEME,
            renderContext({ executionStarted: true }),
          )
          .render(80),
      ).toEqual([]);
    }
  });
});

describe("weave_delegate details payload", () => {
  it("accepts its own bounded payload", () => {
    const parsed = parseDelegationCardDetails(details());
    expect(parsed.isOk()).toBe(true);
    expect(parsed._unsafeUnwrap().facts.agentName).toBe("shuttle");
  });

  it("refuses an absent, foreign, older, or malformed payload with a typed error", () => {
    expect(parseDelegationCardDetails(undefined)._unsafeUnwrapErr()).toEqual({
      type: "PiDelegationCardDetailsInvalid",
      reason: "absent",
    });
    expect(
      parseDelegationCardDetails({ kind: "other-extension" })._unsafeUnwrapErr()
        .reason,
    ).toBe("foreign");
    expect(
      parseDelegationCardDetails({
        ...details(),
        version: 0,
      })._unsafeUnwrapErr().reason,
    ).toBe("foreign");
    expect(
      parseDelegationCardDetails({
        kind: "weave-delegation-card",
        version: 1,
        facts: { ...facts(), tone: "sparkle" },
      })._unsafeUnwrapErr().reason,
    ).toBe("malformed");
    expect(parseDelegationCardDetails([])._unsafeUnwrapErr().reason).toBe(
      "malformed",
    );
  });

  it("refuses a payload larger than the documented ceiling", () => {
    const huge = {
      kind: "weave-delegation-card",
      version: 1,
      facts: facts(),
      // Foreign padding: strictly larger than the ceiling, and never rendered.
      padding: "x".repeat(MAX_DELEGATION_CARD_DETAILS_BYTES + 1),
    };
    expect(parseDelegationCardDetails(huge)._unsafeUnwrapErr().reason).toBe(
      "oversized",
    );
    expect(MAX_DELEGATION_CARD_DETAILS_BYTES).toBeLessThanOrEqual(8 * 1_024);
  });

  it("sheds the viewport ring first to stay inside the ceiling", () => {
    // Four-byte code points: bounded by code point, so a legal fact set can
    // still be over the byte ceiling.
    const wide = "\u{1F9F5}".repeat(240);
    const head = "\u{1F9F5}".repeat(48);
    const crowded = facts({
      viewport: {
        rows: Array.from({ length: 9 }, () => ({
          kind: "msg" as const,
          head,
          text: wide,
        })),
        above: 5,
        atBottom: true,
      },
      terminal: {
        outcome: "completed",
        verdict: "COMPLETED",
        glyph: "\u2713",
        headline: wide,
        evidence: wide,
        recovery: wide,
      },
    });
    expect(
      new TextEncoder().encode(JSON.stringify(crowded)).byteLength,
    ).toBeGreaterThan(MAX_DELEGATION_CARD_DETAILS_BYTES);

    const bounded = boundDelegationCardDetails(crowded);
    expect(bounded).toBeDefined();
    const payload = bounded as PiDelegationCardDetails;
    expect(
      new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    ).toBeLessThanOrEqual(MAX_DELEGATION_CARD_DETAILS_BYTES);
    // The ring went first, from the top, and `above` still counts every row
    // the window does not show.
    expect(payload.facts.viewport.rows.length).toBeLessThan(9);
    expect(payload.facts.viewport.above).toBe(
      5 + (9 - payload.facts.viewport.rows.length),
    );
    // The collapsed card's own facts survive the shedding.
    expect(payload.facts.agentName).toBe("shuttle");
    expect(payload.facts.status).toBe("running");
    expect(parseDelegationCardDetails(payload).isOk()).toBe(true);

    // The widest fact set the model can produce — every bounded string at its
    // own documented code-point limit, in four-byte code points — still leaves
    // through the ladder inside the ceiling, so shedding the whole window is a
    // guard rather than a routine cost.
    const telemetryFigure = "\u{1F9F5}".repeat(CARD_TELEMETRY_MAX);
    const widest = boundDelegationCardDetails(
      facts({
        ...crowded,
        agentName: "\u{1F9F5}".repeat(CARD_AGENT_NAME_MAX),
        model: "\u{1F9F5}".repeat(CARD_MODEL_MAX),
        assignment: wide,
        activity: { kind: "say", text: wide, live: true },
        telemetry: {
          elapsed: telemetryFigure,
          tokens: telemetryFigure,
          cost: telemetryFigure,
        },
      }),
    );
    expect(widest).toBeDefined();
    expect(
      new TextEncoder().encode(JSON.stringify(widest)).byteLength,
    ).toBeLessThanOrEqual(MAX_DELEGATION_CARD_DETAILS_BYTES);
  });

  it("keeps the settlement facts when it sheds the whole viewport", () => {
    // A fact set whose window alone cannot fit: shedding must reach zero rows.
    const wide = "\u{1F9F5}".repeat(CARD_ROW_TEXT_MAX);
    const terminal = {
      outcome: "completed" as const,
      verdict: "COMPLETED",
      glyph: "\u2713",
      headline: "\u{1F9F5}".repeat(CARD_TERMINAL_TEXT_MAX),
      evidence: "\u{1F9F5}".repeat(CARD_TERMINAL_TEXT_MAX),
      recovery: "\u{1F9F5}".repeat(CARD_TERMINAL_TEXT_MAX),
    };
    const settledFacts = facts({
      settled: true,
      status: "completed",
      tone: "ok",
      // Wider than this model bounds its own prose to: a replayed payload is
      // still measured, and still sheds, on exactly the same ladder.
      assignment: "\u{1F9F5}".repeat(CARD_ASSIGNMENT_MAX * 2),
      activity: {
        kind: "reply",
        text: "\u{1F9F5}".repeat(CARD_ROW_TEXT_MAX * 2),
        live: false,
      },
      viewport: {
        rows: Array.from({ length: CARD_VIEWPORT_ROWS }, () => ({
          kind: "msg" as const,
          head: "\u{1F9F5}".repeat(CARD_ROW_HEAD_MAX),
          text: wide,
        })),
        above: 7,
        atBottom: true,
      },
      terminal,
    });
    // Even one retained row is too expensive here, so the ladder runs out.
    expect(
      new TextEncoder().encode(
        JSON.stringify({
          ...settledFacts,
          viewport: {
            rows: settledFacts.viewport.rows.slice(-1),
            above: settledFacts.viewport.above + CARD_VIEWPORT_ROWS - 1,
            atBottom: true,
          },
        }),
      ).byteLength,
    ).toBeGreaterThan(MAX_DELEGATION_CARD_DETAILS_BYTES);

    const bounded = boundDelegationCardDetails(settledFacts);
    expect(bounded).toBeDefined();
    const payload = bounded as PiDelegationCardDetails;
    expect(payload.facts.viewport.rows).toHaveLength(0);
    // The window is gone, and `above` still counts every produced row.
    expect(payload.facts.viewport.above).toBe(7 + CARD_VIEWPORT_ROWS);
    // The authoritative settlement record survives the zero-row shed intact:
    // a replayed payload must never show a completed run as unfinished.
    expect(payload.facts.terminal).toEqual(terminal);
    expect(payload.facts.settled).toBe(true);
    expect(payload.facts.status).toBe("completed");
    expect(
      new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    ).toBeLessThanOrEqual(MAX_DELEGATION_CARD_DETAILS_BYTES);
    // These facts are deliberately wider than this model bounds its own prose
    // to, because a fact set this producer builds can always afford at least
    // one row. The payload is therefore asserted for shedding order and
    // settlement survival only; the strict code-point parse is covered above.
  });

  it("publishes nothing when even the zero-row payload is over the ceiling", () => {
    // Facts this model cannot produce, but a replayed or hostile fact set
    // could: with no window left to shed, the payload is withheld rather than
    // truncated into a card that claims facts it no longer carries.
    const bounded = boundDelegationCardDetails(
      facts({
        assignment: "\u{1F9F5}".repeat(MAX_DELEGATION_CARD_DETAILS_BYTES),
        viewport: { rows: [], above: 0, atBottom: true },
      }),
    );
    expect(bounded).toBeUndefined();
  });

  it("keeps every published payload inside the ceiling, viewport ring first", async () => {
    const updates: PiToolResult[] = [];
    const registration = buildDelegationToolRegistration(
      rootDeps({
        getController: () =>
          ({
            delegate: (request: {
              onSessionEvent?: (event: unknown) => void;
            }) => {
              for (let index = 0; index < 40; index += 1) {
                request.onSessionEvent?.({
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "text_delta",
                    delta: `${"z".repeat(400)} step ${index}`,
                  },
                });
              }
              return okAsync({
                outcome: "completed",
                assistantOutput: "y".repeat(4_000),
              } as PiChildSettlement);
            },
            threadStatus: () => undefined,
          }) as never,
      }),
    );
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "x".repeat(4_000) },
      undefined,
      (update) => updates.push(update),
      ctx(),
    );
    expect(updates.length).toBeGreaterThan(1);
    for (const update of [...updates, result]) {
      const bytes = new TextEncoder().encode(
        JSON.stringify(update.details),
      ).byteLength;
      expect(bytes).toBeLessThanOrEqual(MAX_DELEGATION_CARD_DETAILS_BYTES);
      expect(parseDelegationCardDetails(update.details).isOk()).toBe(true);
    }
  });

  it("keeps the model-visible line the bounded activity line, free of card chrome", async () => {
    const updates: PiToolResult[] = [];
    const registration = buildDelegationToolRegistration(rootDeps());
    const result = await registration.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      (update) => updates.push(update),
      ctx(),
    );
    for (const update of updates) {
      const text = (update.content[0] as { text: string }).text;
      const payload = update.details as PiDelegationCardDetails;
      expect(text).toBe("…");
      expect(payload.facts.activity).toEqual({
        kind: "boot",
        text: "",
        live: false,
      });
      expect(payload.facts.viewport.rows).toEqual([]);
      for (const frameGlyph of FRAME_GLYPHS)
        expect(text).not.toContain(frameGlyph);
    }
    // The final result keeps the structured contract, not the card.
    expect(JSON.parse((result.content[0] as { text: string }).text).ok).toBe(
      true,
    );
  });
});

describe("weave_delegate renderResult", () => {
  it("draws one framed card from a valid payload and re-renders at each normalized width", () => {
    const registration = buildDelegationToolRegistration(rootDeps());
    const result: PiToolResult = {
      content: [{ type: "text", text: "reading delegation-tool.ts" }],
      details: details(),
    };
    const component = registration.renderResult?.(
      result,
      { expanded: false, isPartial: true },
      THEME,
      renderContext(),
    );
    expect(component).toBeDefined();
    for (const width of [12, 40, 80, 160]) {
      const lines = component?.render(width) ?? [];
      expect(lines[0]?.startsWith("\u256d")).toBe(true);
      expect(lines.at(-1)?.startsWith("\u2570")).toBe(true);
      // Exactly one frame: no corner glyph inside the card.
      const corners = lines.filter(
        (line) => line.startsWith("\u256d") || line.startsWith("\u2570"),
      );
      expect(corners).toHaveLength(2);
      const normalizedWidth = Math.max(width, CARD_MIN_WIDTH);
      for (const line of lines)
        expect(line.length).toBeLessThanOrEqual(normalizedWidth);
    }
    const rendered = (component?.render(80) ?? []).join("\n");
    expect(rendered).not.toContain("reading delegation-tool.ts");
    expect(rendered).not.toContain("reading");
  });

  it("reads one generation-local projector and registers one invalidation callback per row", () => {
    const registry = createPiLiveReasoningRegistry();
    const projector = new PiLiveReasoningProjector({
      childId: "child-1",
      generationId: "generation-1",
      registry,
      registryKey: "tool-live",
    });
    projector
      .apply({
        childId: "child-1",
        generationId: "generation-1",
        lifecycleEpoch: 1,
        phase: "start",
        contentIndex: 0,
        text: "",
      })
      ._unsafeUnwrap();
    projector
      .apply({
        childId: "child-1",
        generationId: "generation-1",
        lifecycleEpoch: 1,
        phase: "delta",
        contentIndex: 0,
        text: "RAW_REASONING_RENDER_ONLY_SENTINEL",
      })
      ._unsafeUnwrap();

    let invalidations = 0;
    const state: Record<string, unknown> = {};
    const context = renderContext({
      toolCallId: "tool-live",
      state,
      invalidate: () => {
        invalidations += 1;
      },
    });
    const registration = buildDelegationToolRegistration(
      rootDeps({
        liveReasoningRegistry: registry,
        generationId: "generation-1",
      }),
    );
    const result: PiToolResult = {
      content: [{ type: "text", text: "authoritative settled output" }],
      details: details(),
    };
    const first = registration.renderResult?.(
      result,
      { expanded: false, isPartial: true },
      THEME,
      context,
    );
    const second = registration.renderResult?.(
      result,
      { expanded: false, isPartial: true },
      THEME,
      context,
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(
      "RAW_REASONING_RENDER_ONLY_SENTINEL",
    );
    expect(first?.render(100).join("\n")).toContain(
      "↪ reasoning • RAW_REASONING_RENDER_ONLY_SENTINEL",
    );

    projector
      .apply({
        childId: "child-1",
        generationId: "generation-1",
        lifecycleEpoch: 1,
        phase: "delta",
        contentIndex: 0,
        text: " next",
      })
      ._unsafeUnwrap();
    expect(invalidations).toBe(1);

    projector.clear()._unsafeUnwrap();
    expect(invalidations).toBe(2);
    expect(registry.size()).toBe(0);
    expect(registry.retainedBytes()).toBe(0);
    expect(first?.render(100).join("\n")).not.toContain(
      "RAW_REASONING_RENDER_ONLY_SENTINEL",
    );
    expect(second?.render(100).join("\n")).not.toContain(
      "RAW_REASONING_RENDER_ONLY_SENTINEL",
    );
  });

  it("spends more rows when Pi reports the entry expanded", () => {
    const registration = buildDelegationToolRegistration(rootDeps());
    const result: PiToolResult = {
      content: [{ type: "text", text: "x" }],
      details: details(),
    };
    expect(render(registration, result, true).length).toBeGreaterThan(
      render(registration, result, false).length,
    );
  });

  it("degrades a malformed, foreign or oversized payload and reports one code", () => {
    const codes: string[] = [];
    const registration = buildDelegationToolRegistration(
      rootDeps({
        onCompactRenderFailure: (code) => {
          codes.push(code);
        },
      }),
    );
    const payloads: unknown[] = [
      undefined,
      {
        kind: "weave-delegation-card",
        version: 1,
        facts: { schemaVersion: 9 },
      },
      { kind: "some-other-extension", version: 1 },
      {
        kind: "weave-delegation-card",
        version: 1,
        facts: facts(),
        padding: "x".repeat(MAX_DELEGATION_CARD_DETAILS_BYTES + 1),
      },
    ];
    for (const payload of payloads) {
      const lines = render(registration, {
        content: [{ type: "text", text: "x" }],
        details: payload,
      });
      expect(lines[0]?.startsWith("\u256d")).toBe(true);
      expect(lines.join("\n")).toContain("delegation card unavailable");
      // A degraded card claims no state and no outcome.
      expect(lines.join("\n")).not.toContain("completed");
    }
    expect(codes).toEqual(payloads.map(() => CARD_DETAILS_INVALID_CODE));
  });

  it("degrades instead of throwing when the host theme throws", () => {
    const codes: string[] = [];
    const registration = buildDelegationToolRegistration(
      rootDeps({
        onCompactRenderFailure: (code) => {
          codes.push(code);
        },
      }),
    );
    const throwing: PiUiThemePort = {
      fg: () => {
        throw new Error("/secret/session.jsonl");
      },
      bold: (text) => text,
    };
    const lines = render(
      registration,
      { content: [{ type: "text", text: "x" }], details: details() },
      false,
      throwing,
    );
    expect(lines.join("\n")).toContain("delegation card unavailable");
    expect(JSON.stringify(codes)).not.toContain("/secret");
    expect(codes).toEqual(["ChildCardRenderFailed"]);
  });

  it("draws the same card for a relayed (nested) delegation", async () => {
    const relayed = buildRelayedDelegationToolRegistration({
      targets: TARGETS,
      sessionMutationGate: createOpenSessionMutationGate(),
      getRuntime: () =>
        ({
          requestDelegation: () =>
            okAsync({
              ok: true,
              settlement: { outcome: "completed", assistantOutput: "nested" },
            }),
        }) as never,
    });
    const result = await relayed.execute(
      "call-1",
      { agent: "shuttle", task: "nested work" },
      undefined,
      undefined,
      ctx(),
    );
    const parsed = parseDelegationCardDetails(result.details);
    expect(parsed.isOk()).toBe(true);
    const relayedLines =
      relayed
        .renderResult?.(
          result,
          { expanded: false, isPartial: false },
          THEME,
          renderContext(),
        )
        .render(80) ?? [];
    const rootLines = render(
      buildDelegationToolRegistration(rootDeps()),
      result,
    );
    expect(relayedLines).toEqual(rootLines);
    expect(relayedLines.join("\n")).not.toContain("nested-final");
  });
});

describe("weave_delegate relayed updates", () => {
  it("publishes a bounded bootstrap card before the relay request resolves", async () => {
    const updates: PiToolResult[] = [];
    let updatesWhenRequested = -1;
    let release: (() => void) | undefined;
    const reply = new Promise<unknown>((resolve) => {
      release = () =>
        resolve({
          ok: true,
          settlement: { outcome: "completed", assistantOutput: "nested" },
        });
    });
    const relayed = buildRelayedDelegationToolRegistration({
      targets: TARGETS,
      sessionMutationGate: createOpenSessionMutationGate(),
      getRuntime: () =>
        ({
          requestDelegation: () => {
            updatesWhenRequested = updates.length;
            return ResultAsync.fromSafePromise(reply);
          },
        }) as never,
    });

    const pending = relayed.execute(
      "call-1",
      { agent: "shuttle", task: "nested work" },
      undefined,
      (update) => updates.push(update),
      ctx(),
    );
    // The relay has been asked and has not answered: the entry already owns a
    // card, so it is never blank while `renderCall` draws nothing.
    expect(updatesWhenRequested).toBe(1);
    expect(updates).toHaveLength(1);

    const bootstrap = updates[0] as PiToolResult;
    const parsedBootstrap = parseDelegationCardDetails(bootstrap.details);
    expect(parsedBootstrap.isOk()).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(bootstrap.details)).byteLength,
    ).toBeLessThanOrEqual(MAX_DELEGATION_CARD_DETAILS_BYTES);
    const bootstrapFacts = (bootstrap.details as PiDelegationCardDetails).facts;
    expect(bootstrapFacts.agentName).toBe("shuttle");
    expect(bootstrapFacts.assignment).toBe("nested work");
    // A bootstrap card claims no outcome.
    expect(bootstrapFacts.settled).toBe(false);
    expect(bootstrapFacts.terminal).toBeUndefined();
    // Model-visible text is the bounded activity line, with no card chrome.
    const bootstrapText = (bootstrap.content[0] as { text: string }).text;
    expect(bootstrapText).toBe("…");
    expect(bootstrapFacts.activity).toEqual({
      kind: "boot",
      text: "",
      live: false,
    });
    for (const frameGlyph of FRAME_GLYPHS)
      expect(bootstrapText).not.toContain(frameGlyph);

    release?.();
    const result = await pending;
    // The final card settles the same producer the bootstrap update opened:
    // one entry, one run, and the root's own rendering.
    const finalFacts = (result.details as PiDelegationCardDetails).facts;
    expect(parseDelegationCardDetails(result.details).isOk()).toBe(true);
    expect(finalFacts.settled).toBe(true);
    expect(finalFacts.terminal?.outcome).toBe("completed");
    expect(finalFacts.assignment).toBe(bootstrapFacts.assignment);
    expect(finalFacts.run.number).toBe(bootstrapFacts.run.number);
    const relayedLines =
      relayed
        .renderResult?.(
          result,
          { expanded: false, isPartial: false },
          THEME,
          renderContext(),
        )
        .render(80) ?? [];
    expect(relayedLines).toEqual(
      render(buildDelegationToolRegistration(rootDeps()), result),
    );
    expect(relayedLines.join("\n")).not.toContain("nested-final");
  });
});
