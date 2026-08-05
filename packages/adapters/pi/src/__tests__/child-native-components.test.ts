import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import {
  createPiNativeTranscriptComponentFactory,
  renderPiChildCompactComponent,
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
          thinking: "",
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
            thinking: "",
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
          thinking: "",
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
        delta: { messageId: "m1", thinking: "Planning approach" },
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

  it("separates messages with a single blank row", () => {
    const reducer = new PiChildTranscriptReducer();
    for (const value of [
      { type: "thinking", text: "Planning the fix" },
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

describe("renderPiChildCompactComponent", () => {
  const theme: PiUiThemePort = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };

  it("renders exactly three collapsed lines and the expanded item when requested", () => {
    const collapsed = renderPiChildCompactComponent(
      {
        lines: [
          "weave_delegate · shuttle · running",
          "latest fragment",
          "run 1 · start",
        ],
        expandedCurrentItem: "latest fragment expanded",
        degraded: false,
      },
      { expanded: false },
      theme,
    );
    expect(collapsed.isOk()).toBe(true);
    const collapsedText = collapsed._unsafeUnwrap().render(80).join("\n");
    expect(
      collapsedText.split("\n").filter((line) => line.length > 0),
    ).toHaveLength(3);
    expect(collapsedText).not.toContain("expanded");

    const expanded = renderPiChildCompactComponent(
      {
        lines: [
          "weave_delegate · shuttle · running",
          "latest fragment",
          "run 1 · start",
        ],
        expandedCurrentItem: "latest fragment expanded",
        degraded: false,
      },
      { expanded: true },
      theme,
    );
    expect(expanded.isOk()).toBe(true);
    expect(expanded._unsafeUnwrap().render(80).join("\n")).toContain(
      "latest fragment expanded",
    );
  });

  it("returns a stable Err code when theme throws (no path leakage)", () => {
    const throwing: PiUiThemePort = {
      fg: () => {
        throw new Error("/secret/session.jsonl");
      },
      bold: (text) => text,
    };
    const rendered = renderPiChildCompactComponent(
      {
        lines: ["a", "b", "c"],
        expandedCurrentItem: undefined,
        degraded: false,
      },
      { expanded: false },
      throwing,
    );
    expect(rendered.isErr()).toBe(true);
    expect(rendered._unsafeUnwrapErr()).toBe("ChildCompactRenderFailed");
    expect(JSON.stringify(rendered)).not.toContain("/secret");
  });
});
