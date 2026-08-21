import { describe, expect, it } from "bun:test";
import {
  createReadToolDefinition,
  initTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import type { PiDelegationCardFacts } from "../child-card-model.js";
import {
  createPiNativeTranscriptComponentFactory,
  degradedPiChildCardComponent,
  renderPiChildCardComponent,
} from "../child-native-components.js";
import type { PiChildSessionEvent } from "../child-session-events.js";
import {
  PiChildTranscriptReducer,
  PiChildTranscriptRenderer,
  type PiTranscriptComponentRequest,
} from "../child-transcript.js";
import type { PiUiThemePort } from "../types.js";

/** Pi's components read the process-wide theme; the harness sets it in TUI mode. */
initTheme("default");

const plainTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

/** Pi's tool component only needs a render-request sink here. */
const fakeTui = { requestRender: () => undefined } as unknown as TUI;

const factory = createPiNativeTranscriptComponentFactory({
  tui: fakeTui,
  cwd: "/workspace",
  markdownTheme: plainTheme,
  outputPad: 0,
});

const request = (
  overrides: Partial<PiTranscriptComponentRequest> = {},
): PiTranscriptComponentRequest => ({
  kind: "assistant",
  entryId: "entry",
  factId: "entry:text",
  sequence: 1,
  content: "fallback prose",
  ...overrides,
});

describe("Pi native transcript components", () => {
  it("renders assistant text as markdown rather than fallback prose", () => {
    const component = factory.create(
      request({
        payload: {
          type: "assistant",
          text: "**bold answer**",
          reasoningSummary: "",
          markdown: "",
          streaming: false,
        },
      }),
    );
    expect(component.render(40).join("\n")).toContain("bold answer");
    expect(component.render(40).join("\n")).not.toContain("fallback prose");
    expect(component.render(40).join("\n")).not.toContain("assistant:");
  });

  it("renders a user, task, or steering fact through Pi's user message block", () => {
    for (const kind of ["task", "user", "steering"] as const) {
      const component = factory.create(
        request({
          kind,
          payload: { type: "text", text: "inspect the failing test" },
        }),
      );
      expect(component.render(60).join("\n")).toContain(
        "inspect the failing test",
      );
    }
  });

  it("renders a tool fact through Pi's tool execution block", () => {
    const component = factory.create(
      request({
        kind: "tool",
        factId: "entry:tool",
        toolName: "read",
        payload: {
          type: "tool",
          toolName: "read",
          toolCallId: "call-1",
          state: "result",
          knownTool: true,
          argumentsKnown: true,
          arguments: { path: "src/index.ts" },
          partialResults: [],
          result: { content: [{ type: "text", text: "file body" }] },
        },
      }),
    );
    const output = component.render(80).join("\n");
    expect(output).toContain("read");
    expect(output).not.toContain("state:result");
  });

  it("keeps the host tool definition when rendering a known tool", () => {
    const hostDefinition = {
      ...createReadToolDefinition("/workspace"),
      name: "custom_tool",
      renderCall: () =>
        new UserMessageComponent("host definition", plainTheme, 0),
    };
    const component = factory.create(
      request({
        kind: "tool",
        factId: "entry:tool",
        toolName: "custom_tool",
        knownToolDefinition: hostDefinition,
        payload: {
          type: "tool",
          toolName: "custom_tool",
          toolCallId: "call-host",
          state: "called",
          knownTool: true,
          argumentsKnown: false,
          partialResults: [],
        },
      }),
    );
    expect(component.render(80).join("\n")).toContain("host definition");
  });

  it("keeps an unserializable tool result renderable", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const component = factory.create(
      request({
        kind: "tool",
        factId: "entry:tool",
        toolName: "bash",
        payload: {
          type: "tool",
          toolName: "bash",
          toolCallId: "call-2",
          state: "result",
          knownTool: true,
          argumentsKnown: true,
          partialResults: [],
          result: cyclic,
        },
      }),
    );
    expect(component.render(80).join("\n")).toContain(
      "[unserializable tool result]",
    );
  });

  it("suppresses the bookkeeping facts Pi never shows and empty assistant facts", () => {
    for (const kind of [
      "usage",
      "queue",
      "status",
      "retry",
      "extension_ui",
      "unknown",
    ] as const)
      expect(factory.suppress?.(request({ kind }))).toBe(true);
    expect(
      factory.suppress?.(
        request({
          payload: {
            type: "assistant",
            text: "   ",
            reasoningSummary: "",
            markdown: "",
            streaming: true,
          },
        }),
      ),
    ).toBe(true);
    expect(
      factory.suppress?.(
        request({ kind: "thinking", payload: { type: "text", text: "" } }),
      ),
    ).toBe(true);
    expect(
      factory.suppress?.(
        request({
          kind: "tool",
          factId: "entry:tool",
          payload: { type: "text", text: "x" },
        }),
      ),
    ).toBe(false);
    // A tool entry emits several facts; only the call fact draws the block.
    expect(
      factory.suppress?.(request({ kind: "tool", factId: "entry:result" })),
    ).toBe(true);
    expect(
      factory.suppress?.(request({ kind: "tool", factId: "entry:arguments" })),
    ).toBe(true);
  });

  it("keeps Pi's styling in native output instead of flattening it to plain text", () => {
    const styled = createPiNativeTranscriptComponentFactory({
      tui: fakeTui,
      cwd: "/workspace",
      outputPad: 0,
    });
    const component = styled.create(
      request({
        payload: {
          type: "assistant",
          text: "### Validation",
          reasoningSummary: "",
          markdown: "",
          streaming: false,
        },
      }),
    );
    const output = component.render(80).join("\n");
    expect(output).toContain("Validation");
    expect(output).toContain("\u001b[");
  });

  it("preserves that styling through the transcript renderer", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("styled task").isOk()).toBe(true);
    const styled = createPiNativeTranscriptComponentFactory({
      tui: fakeTui,
      cwd: "/workspace",
    });
    const rendered = new PiChildTranscriptRenderer({
      componentFactory: styled,
    }).render(reducer.getState(), 80);
    expect(rendered.lines.join("\n")).toContain("styled task");
    expect(rendered.lines.some((line) => line.includes("\u001b["))).toBe(true);
  });

  it("renders a streamed child transcript without any fallback event prose", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("plan the fix").isOk()).toBe(true);
    for (const value of [
      {
        type: "extension_ui_request",
        requestType: "widget",
        requestId: "widget-1",
        widget: {},
      },
      { type: "unknown", originalType: "thinking_level_changed" },
      { type: "message_start", message: { id: "m1" } },
      {
        type: "message_update",
        delta: { messageId: "m1", reasoningSummary: "Planning approach" },
      },
      {
        type: "message_update",
        delta: { messageId: "m1", text: "Here is the plan." },
      },
      { type: "status", status: "running" },
    ] as unknown[])
      expect(reducer.applyEvent(value as PiChildSessionEvent).isOk()).toBe(
        true,
      );

    const rendered = new PiChildTranscriptRenderer({
      componentFactory: factory,
    }).render(reducer.getState(), 80);
    const output = rendered.lines.join("\n");

    expect(output).toContain("plan the fix");
    expect(output).toContain("Planning approach");
    expect(output).toContain("Here is the plan.");
    expect(output).not.toContain("extension ui: widget");
    expect(output).not.toContain("unknown event:");
    expect(output).not.toContain("assistant: [empty]");
    expect(output).not.toContain("status:");
  });

  it("never renders fallback content for a thinking fact", () => {
    const thinking = request({
      kind: "thinking",
      content: "private chain of thought /secret/session.jsonl",
    });
    expect(factory.suppress?.(thinking)).toBe(true);
    expect(factory.create(thinking).render(80).join("\n")).not.toContain(
      "private chain of thought",
    );
  });

  it("separates messages with a single blank row", () => {
    const reducer = new PiChildTranscriptReducer();
    for (const value of [
      { type: "reasoning_summary", text: "Planning the fix" },
      { type: "text", text: "Here is the answer" },
    ] as unknown[])
      expect(reducer.applyEvent(value as PiChildSessionEvent).isOk()).toBe(
        true,
      );

    const rendered = new PiChildTranscriptRenderer({
      componentFactory: factory,
    }).render(reducer.getState(), 60);
    const blank = (line: string): boolean => line.trim() === "";

    const thinkingIndex = rendered.lines.findIndex((line) =>
      line.includes("Planning the fix"),
    );
    const answerIndex = rendered.lines.findIndex((line) =>
      line.includes("Here is the answer"),
    );
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(answerIndex).toBeGreaterThan(thinkingIndex);
    expect(
      rendered.lines.slice(thinkingIndex + 1, answerIndex).every(blank),
    ).toBe(true);
    expect(answerIndex - thinkingIndex).toBe(2);
    expect(blank(rendered.lines.at(-1) ?? "x")).toBe(true);
  });
});

function cardFacts(): PiDelegationCardFacts {
  return {
    schemaVersion: 1,
    tool: "weave_delegate",
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
  };
}

describe("renderPiChildCardComponent", () => {
  const theme: PiUiThemePort = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };

  it("re-renders at the caller's width and clips every line to it", () => {
    const component = renderPiChildCardComponent(
      cardFacts(),
      { expanded: false },
      theme,
    );
    expect(component.isOk()).toBe(true);
    const card = component._unsafeUnwrap();
    for (const width of [12, 40, 80, 132]) {
      const lines = card.render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
    }
    // The cached width is re-served, and `invalidate()` clears the cache
    // without changing what the same width draws.
    const before = card.render(80);
    expect(card.render(80)).toEqual(before);
    card.invalidate();
    expect(card.render(80)).toEqual(before);
  });

  it("draws more rows expanded than collapsed", () => {
    const collapsed = renderPiChildCardComponent(
      cardFacts(),
      { expanded: false },
      theme,
    )._unsafeUnwrap();
    const expanded = renderPiChildCardComponent(
      cardFacts(),
      { expanded: true },
      theme,
    )._unsafeUnwrap();
    expect(expanded.render(80).length).toBeGreaterThan(
      collapsed.render(80).length,
    );
  });

  it("returns a stable Err code when the theme throws (no path leakage)", () => {
    const throwing: PiUiThemePort = {
      fg: () => {
        throw new Error("/secret/session.jsonl");
      },
      bold: (text) => text,
    };
    const rendered = renderPiChildCardComponent(
      cardFacts(),
      { expanded: false },
      throwing,
    );
    expect(rendered.isErr()).toBe(true);
    expect(rendered._unsafeUnwrapErr()).toBe("ChildCardRenderFailed");
    expect(JSON.stringify(rendered)).not.toContain("/secret");
  });

  it("degrades to one bounded framed card that claims no outcome", () => {
    const lines = degradedPiChildCardComponent("malformed").render(48);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(48);
    const text = lines.join("\n");
    expect(text).toContain("delegation card unavailable");
    expect(text).toContain("malformed");
    expect(text).not.toContain("completed");
  });
});
