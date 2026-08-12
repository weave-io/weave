import { describe, expect, it } from "bun:test";
import {
  type PiChildSessionEvent,
  parsePiChildSessionEvent,
} from "../child-session-events.js";
import {
  MAX_TRANSCRIPT_HISTORY_EVENT_BYTES,
  PiChildTranscriptReducer,
  PiChildTranscriptRenderer,
  type PiTranscriptComponentFactory,
  type PiTranscriptComponentRequest,
  renderPiChildTranscript,
  renderPiChildTranscriptLines,
} from "../child-transcript.js";

const event = (value: unknown): PiChildSessionEvent =>
  value as PiChildSessionEvent;

function applyAll(
  reducer: PiChildTranscriptReducer,
  values: readonly unknown[],
): void {
  for (const value of values)
    expect(reducer.applyEvent(event(value)).isOk()).toBe(true);
}

describe("Pi child transcript reducer", () => {
  it("keeps task, steering, and queued follow-up input in local order", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("inspect this").isOk()).toBe(true);
    expect(reducer.addSteering("use the narrow fix").isOk()).toBe(true);
    expect(reducer.queueFollowUp("then run the focused tests").isOk()).toBe(
      true,
    );

    expect(reducer.getState().entries.map((entry) => entry.kind)).toEqual([
      "task",
      "steering",
      "follow_up",
    ]);
    const followUp = reducer.getState().entries[2];
    expect(followUp?.kind).toBe("follow_up");
    if (followUp?.kind === "follow_up") expect(followUp.queued).toBe(true);
  });

  it("merges streaming updates and creates a placeholder for out-of-order updates", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(
      reducer
        .applyEvent(
          event({
            type: "message_update",
            delta: { messageId: "late-message", text: "hello " },
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      reducer
        .applyEvent(
          event({
            type: "message_start",
            message: { id: "message-1" },
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      reducer
        .applyEvent(
          event({
            type: "message_update",
            delta: {
              messageId: "message-1",
              text: "world",
              thinking: "plan",
              markdown: "**md**",
            },
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      reducer
        .applyEvent(
          event({
            type: "message_end",
            message: {
              id: "message-1",
              text: "hello world",
              stopReason: "end_turn",
            },
          }),
        )
        .isOk(),
    ).toBe(true);

    const entries = reducer
      .getState()
      .entries.filter((entry) => entry.kind === "assistant");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      messageId: "late-message",
      text: "hello ",
    });
    expect(entries[1]).toMatchObject({
      messageId: "message-1",
      text: "hello world",
      thinking: "plan",
      markdown: "**md**",
      streaming: false,
      stopReason: "end_turn",
    });
    expect(
      reducer.getState().historyEvents.map((item) => item.event.type),
    ).toEqual([
      "message_update",
      "message_start",
      "message_update",
      "message_end",
    ]);
  });

  it("tracks every event family, including unknown bounded events", () => {
    const reducer = new PiChildTranscriptReducer();
    applyAll(reducer, [
      { type: "text", text: "text" },
      { type: "thinking", text: "thinking" },
      { type: "markdown", text: "markdown" },
      {
        type: "tool_call",
        toolCallId: "tool-1",
        toolName: "read",
        arguments: { path: "a" },
      },
      {
        type: "tool_partial_result",
        toolCallId: "tool-1",
        partialResult: "part",
      },
      { type: "tool_result", toolCallId: "tool-1", result: "done" },
      { type: "tool_error", toolCallId: "tool-1", error: "failed" },
      { type: "image", data: "data", mimeType: "image/png" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 4 } },
      { type: "queue_change", queue: ["next"], size: 1 },
      { type: "status", status: "running", message: "working" },
      { type: "retry", attempt: 2, reason: "temporary" },
      {
        type: "extension_ui_request",
        requestType: "notification",
        requestId: "ui-1",
        message: "notice",
      },
      {
        type: "unknown",
        originalType: "future_event",
        payload: { safe: true },
      },
    ]);

    expect(reducer.getState().entries.map((entry) => entry.kind)).toEqual([
      "text",
      "thinking",
      "markdown",
      "tool",
      "image",
      "usage",
      "queue",
      "status",
      "retry",
      "extension_ui",
      "unknown",
    ]);
    expect(
      reducer.getState().entries.find((entry) => entry.kind === "tool"),
    ).toMatchObject({
      knownTool: true,
      argumentsKnown: true,
      partialResults: ["part"],
      result: "done",
      error: "failed",
      state: "error",
    });
    expect(reducer.getState().usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(reducer.getState().extensionUi).toHaveLength(1);
  });

  it("keeps unknown tool arguments and merges out-of-order tool results", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(
      reducer
        .applyEvent(
          event({
            type: "tool_result",
            toolCallId: "custom-1",
            result: { value: 1 },
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      reducer
        .applyEvent(
          event({
            type: "tool_call",
            toolCallId: "custom-1",
            toolName: "custom_tool",
            arguments: { arbitrary: true },
          }),
        )
        .isOk(),
    ).toBe(true);
    const tool = reducer
      .getState()
      .entries.find((entry) => entry.kind === "tool");
    expect(tool).toMatchObject({
      toolCallId: "custom-1",
      toolName: "custom_tool",
      knownTool: false,
      argumentsKnown: true,
      arguments: { arbitrary: true },
      result: { value: 1 },
    });
  });

  it("keeps per-entry visibility and selected branch/message state local", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(
      reducer
        .applyEvent(
          event({
            type: "message_start",
            message: { id: "m1", branchId: "branch-a" },
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      reducer
        .applyEvent(
          event({
            type: "message_start",
            message: { id: "m2", branchId: "branch-b" },
          }),
        )
        .isOk(),
    ).toBe(true);
    const first = reducer.getState().entries[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(reducer.toggleEntryExpanded(first.id).isOk()).toBe(true);
    expect(reducer.setThinkingVisible(first.id, false).isOk()).toBe(true);
    expect(reducer.setImagesVisible(first.id, false).isOk()).toBe(true);
    expect(reducer.selectBranch("branch-b").isOk()).toBe(true);
    expect(reducer.selectMessage("m2").isOk()).toBe(true);

    expect(reducer.getState()).toMatchObject({
      selectedBranchId: "branch-b",
      selectedMessageId: "m2",
      branchOrder: [
        { id: "main", order: 0 },
        { id: "branch-a", order: 1 },
        { id: "branch-b", order: 2 },
      ],
    });
    expect(reducer.getState().entries[0]).toMatchObject({
      expanded: true,
      thinkingVisible: false,
      imagesVisible: false,
    });
  });

  it("retains a valid bounded history event larger than one MiB", () => {
    const raw = {
      type: "future_large_event",
      ...Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          `key-${index}`,
          "x".repeat(16_384),
        ]),
      ),
    };
    const parsed = parsePiChildSessionEvent(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const reducer = new PiChildTranscriptReducer();
    const result = reducer.applyEvent(parsed.data);
    expect(result.isOk()).toBe(true);
    const retained = reducer.getState().historyEvents[0];
    expect(retained?.byteLength).toBeGreaterThan(1_024 * 1_024);
    expect(retained?.byteLength).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_HISTORY_EVENT_BYTES,
    );
    expect((retained?.event as { type: string }).type).toBe("unknown");
  });

  it("renders every normalized family as stable, safe fallback rows", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("\u001b[31minspect 界\u001b[0m").isOk()).toBe(true);
    expect(reducer.addSteering("steer").isOk()).toBe(true);
    expect(reducer.queueFollowUp("follow up").isOk()).toBe(true);
    applyAll(reducer, [
      { type: "message_start", message: { id: "assistant-1" } },
      {
        type: "message_update",
        delta: { messageId: "assistant-1", text: "streaming" },
      },
      {
        type: "message_end",
        message: { id: "assistant-1", text: "final", stopReason: "done" },
      },
      { type: "text", text: "plain text" },
      { type: "thinking", text: "private plan" },
      { type: "markdown", text: "**markdown**" },
      {
        type: "tool_call",
        toolCallId: "known-tool",
        toolName: "read",
        arguments: { path: "界" },
      },
      {
        type: "tool_call",
        toolCallId: "unknown-tool",
        toolName: "custom_tool",
      },
      {
        type: "tool_partial_result",
        toolCallId: "known-tool",
        partialResult: { chunk: 1 },
      },
      { type: "tool_result", toolCallId: "known-tool", result: "result" },
      { type: "tool_error", toolCallId: "known-tool", error: "error" },
      { type: "image", data: "SECRET_IMAGE_BYTES", mimeType: "image/png" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 4 } },
      { type: "queue_change", queue: ["next"], size: 1 },
      { type: "status", status: "running", message: "working" },
      { type: "retry", attempt: 2, reason: "temporary" },
      {
        type: "extension_ui_request",
        requestType: "widget",
        requestId: "ui-1",
        widget: { untrusted: "payload" },
        dialog: { another: "payload" },
      },
      {
        type: "unknown",
        originalType: "future_event",
        payload: { untrusted: "payload" },
      },
    ]);

    const thinking = reducer
      .getState()
      .entries.find((entry) => entry.kind === "thinking");
    const image = reducer
      .getState()
      .entries.find((entry) => entry.kind === "image");
    const knownTool = reducer
      .getState()
      .entries.find(
        (entry) => entry.kind === "tool" && entry.toolCallId === "known-tool",
      );
    expect(thinking).toBeDefined();
    expect(image).toBeDefined();
    expect(knownTool).toBeDefined();
    if (thinking)
      expect(reducer.setThinkingVisible(thinking.id, false).isOk()).toBe(true);
    if (image)
      expect(reducer.setImagesVisible(image.id, false).isOk()).toBe(true);
    if (knownTool)
      expect(reducer.toggleEntryExpanded(knownTool.id).isOk()).toBe(true);

    const rendered = renderPiChildTranscript(reducer.getState(), 80);
    const output = rendered.lines.join("\\n");
    for (const label of [
      "task:",
      "steering:",
      "follow_up:",
      "assistant",
      "text:",
      "thinking:",
      "markdown:",
      "tool:",
      "tool arguments:",
      "tool partial",
      "tool result:",
      "tool error:",
      "image",
      "usage:",
      "queue:",
      "status:",
      "retry:",
      "extension ui:",
      "extension widget:",
      "extension dialog:",
      "unknown event:",
    ])
      expect(output).toContain(label);
    expect(output).toContain("thinking: [hidden]");
    expect(output).toContain("image: [hidden]");
    expect(output).toContain("[unavailable]");
    expect(output).not.toContain("SECRET_IMAGE_BYTES");
    expect(output).not.toContain("untrusted:payload");

    const ids = rendered.rows.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      rendered.rows.every(
        (item) => item.entryId.length > 0 && item.factId.length > 0,
      ),
    ).toBe(true);
  });

  it("keeps native fact parity across every normalized input kind", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("task").isOk()).toBe(true);
    expect(reducer.addSteering("steering").isOk()).toBe(true);
    expect(reducer.queueFollowUp("user").isOk()).toBe(true);
    applyAll(reducer, [
      { type: "message_start", message: { id: "assistant-parity" } },
      {
        type: "message_update",
        delta: {
          messageId: "assistant-parity",
          text: "assistant",
          thinking: "thinking",
          markdown: "markdown",
        },
      },
      { type: "text", text: "text" },
      { type: "thinking", text: "private" },
      { type: "markdown", text: "**markdown**" },
      {
        type: "tool_call",
        toolCallId: "known-parity",
        toolName: "read",
        arguments: { path: "file" },
      },
      {
        type: "tool_call",
        toolCallId: "unknown-parity",
        toolName: "custom_tool",
      },
      { type: "image", data: "PRIVATE_IMAGE_BYTES", mimeType: "image/png" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "queue_change", queue: ["next"], size: 1 },
      { type: "status", status: "running" },
      { type: "retry", attempt: 1, reason: "temporary" },
      {
        type: "extension_ui_request",
        requestType: "widget",
        requestId: "ui-parity",
        widget: { private: "payload" },
      },
      {
        type: "unknown",
        originalType: "future",
        payload: { private: "payload" },
      },
    ]);

    const requests: PiTranscriptComponentRequest[] = [];
    const factory: PiTranscriptComponentFactory = {
      create(request) {
        requests.push(request);
        return {
          render: () => request.content.split("\\n"),
          invalidate: () => undefined,
        };
      },
    };
    const state = reducer.getState();
    const fallback = renderPiChildTranscript(state, 80);
    const native = new PiChildTranscriptRenderer({
      componentFactory: factory,
      toolDefinitions: new Map([["read", { name: "read" }]]),
    }).render(state, 80);
    const withoutProvenance = (
      rows: ReadonlyArray<(typeof fallback.rows)[number]>,
    ) => rows.map(({ provenance: _provenance, ...row }) => row);

    expect(withoutProvenance(native.rows)).toEqual(
      withoutProvenance(fallback.rows),
    );
    expect(native.rows.every((row) => row.provenance === "native")).toBe(true);
    expect(new Set(requests.map((request) => request.kind))).toEqual(
      new Set([
        "task",
        "steering",
        "user",
        "assistant",
        "markdown",
        "thinking",
        "tool",
        "image",
        "usage",
        "queue",
        "status",
        "retry",
        "extension_ui",
        "unknown",
      ]),
    );
    expect(
      requests.find(
        (request) =>
          request.kind === "tool" && request.toolName === "custom_tool",
      )?.knownToolDefinition,
    ).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain("PRIVATE_IMAGE_BYTES");
    expect(JSON.stringify(requests)).not.toContain("private:payload");
  });

  it("caches components, keeps native styling, and passes the render width through", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("first").isOk()).toBe(true);
    applyAll(reducer, [
      { type: "message_start", message: { id: "streaming-cache" } },
      {
        type: "message_update",
        delta: { messageId: "streaming-cache", text: "before" },
      },
      {
        type: "tool_call",
        toolCallId: "tool-cache",
        toolName: "read",
        arguments: { path: "file" },
      },
    ]);

    let createCount = 0;
    let invalidateCount = 0;
    const renderedWidths: number[] = [];
    const factory: PiTranscriptComponentFactory = {
      create(request) {
        createCount += 1;
        return {
          render(width) {
            renderedWidths.push(width);
            return [
              `\u001b[31m界界界界界界界界界界 ${request.kind}:${request.content}\u001b[0m`,
            ];
          },
          invalidate() {
            invalidateCount += 1;
          },
        };
      },
    };
    const renderer = new PiChildTranscriptRenderer({
      componentFactory: factory,
      toolDefinitions: new Map([["read", { name: "read", version: 1 }]]),
      theme: "light",
    });
    const state = reducer.getState();
    const first = renderer.render(state, 32);
    renderer.render(state, 32);
    expect(createCount).toBe(first.rows.length);
    expect(invalidateCount).toBe(0);

    renderer.render(state, 7);
    expect(createCount).toBe(first.rows.length);
    expect(renderedWidths).toContain(7);
    expect(
      renderer
        .render(state, 7)
        .lines.every((line) => line.includes("\u001b[31m")),
    ).toBe(true);

    applyAll(reducer, [
      {
        type: "message_update",
        delta: { messageId: "streaming-cache", text: "after" },
      },
    ]);
    renderer.render(reducer.getState(), 7);
    expect(invalidateCount).toBeGreaterThan(0);

    const invalidationsBeforeThemeChange = invalidateCount;
    renderer.render(reducer.getState(), 7, {
      componentFactory: factory,
      toolDefinitions: new Map([["read", { name: "read", version: 2 }]]),
      theme: "dark",
    });
    expect(invalidateCount).toBeGreaterThan(invalidationsBeforeThemeChange);
  });

  it("fits ANSI-free output at narrow widths, including wide Unicode", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(
      reducer.addTask("\u001b[1m界界界界界界界界界界\u001b[0m").isOk(),
    ).toBe(true);
    const displayWidth = (line: string): number => {
      let result = 0;
      for (const character of line) {
        const codePoint = character.codePointAt(0) ?? 0;
        result += codePoint >= 0x1100 && codePoint <= 0x1faff ? 2 : 1;
      }
      return result;
    };
    for (const width of [1, 2, 8, 20, 80]) {
      const lines = renderPiChildTranscriptLines(reducer.getState(), width);
      expect(lines.length).toBeGreaterThan(0);
      expect(
        lines.every(
          (line) => !line.includes("\\u001b") && displayWidth(line) <= width,
        ),
      ).toBe(true);
    }
  });

  it("renders only the canonical provider error and clears it after success", () => {
    const reducer = new PiChildTranscriptReducer();
    applyAll(reducer, [
      { type: "message_start", message: { id: "provider-error" } },
      {
        type: "message_end",
        message: {
          id: "provider-error",
          role: "assistant",
          stopReason: "error",
          errorMessage:
            "429 raw-secret /private/tmp/key https://provider.test/request req_123 authorization: Bearer token",
        },
      },
    ]);

    const wide = renderPiChildTranscriptLines(reducer.getState(), 120).join(
      "\n",
    );
    expect(wide).toContain(
      "assistant error · rate limit · HTTP 429 · Provider rate limit exceeded. Retry later.",
    );
    expect(wide).not.toContain("assistant stop: error");
    for (const sentinel of [
      "raw-secret",
      "/private/tmp/key",
      "https://provider.test/request",
      "req_123",
      "authorization",
      "Bearer token",
    ]) {
      expect(wide).not.toContain(sentinel);
    }

    const narrow = renderPiChildTranscriptLines(reducer.getState(), 40);
    expect(narrow.some((line) => line.startsWith("assistant error"))).toBe(
      true,
    );
    expect(narrow.every((line) => line.length <= 40)).toBe(true);

    applyAll(reducer, [
      {
        type: "message_end",
        message: {
          id: "provider-error",
          role: "assistant",
          stopReason: "stop",
          text: "recovered",
        },
      },
    ]);
    expect(
      renderPiChildTranscriptLines(reducer.getState(), 120).join("\n"),
    ).not.toContain("assistant error");
  });

  it("renders details unavailable when provider evidence is absent", () => {
    const reducer = new PiChildTranscriptReducer();
    applyAll(reducer, [
      { type: "message_start", message: { id: "unknown-error" } },
      {
        type: "message_end",
        message: {
          id: "unknown-error",
          role: "assistant",
          stopReason: "error",
        },
      },
    ]);
    expect(
      renderPiChildTranscriptLines(reducer.getState(), 80).join("\n"),
    ).toContain("assistant error · details unavailable");
  });

  it("summarizes a retained large event without exposing its payload", () => {
    const raw = {
      type: "future_large_event",
      ...Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          `key-${index}`,
          "x".repeat(16_384),
        ]),
      ),
    };
    const parsed = parsePiChildSessionEvent(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.applyEvent(parsed.data).isOk()).toBe(true);
    const rendered = renderPiChildTranscript(reducer.getState(), 20);
    expect(reducer.getState().historyEvents[0]?.byteLength).toBeGreaterThan(
      1_024 * 1_024,
    );
    expect(rendered.lines.join("")).toContain("details omitted");
    expect(rendered.lines.join("\\n")).not.toContain("x".repeat(1_000));
    expect(rendered.lines.every((line) => line.length <= 20)).toBe(true);
  });

  it("returns closed errors instead of throwing for unsafe local operations", () => {
    const reducer = new PiChildTranscriptReducer();
    const tooLarge = reducer.addTask("x".repeat(64 * 1024 + 1));
    expect(tooLarge.isErr()).toBe(true);
    expect(reducer.selectBranch("missing").isErr()).toBe(true);
    expect(reducer.selectMessage("missing").isErr()).toBe(true);
  });

  it("hands native components the structured fact instead of fallback prose", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("first line\nsecond line").isOk()).toBe(true);
    applyAll(reducer, [
      { type: "message_start", message: { id: "payload-message" } },
      {
        type: "message_update",
        delta: {
          messageId: "payload-message",
          text: "visible answer",
          thinking: "reasoning",
        },
      },
      {
        type: "tool_call",
        toolCallId: "payload-tool",
        toolName: "read",
        arguments: { path: "file" },
      },
      {
        type: "tool_result",
        toolCallId: "payload-tool",
        result: { content: [{ type: "text", text: "file body" }] },
      },
    ]);

    const requests: PiTranscriptComponentRequest[] = [];
    const factory: PiTranscriptComponentFactory = {
      create(request) {
        requests.push(request);
        return { render: () => [request.kind], invalidate: () => undefined };
      },
    };
    new PiChildTranscriptRenderer({ componentFactory: factory }).render(
      reducer.getState(),
      80,
    );

    const task = requests.find((request) => request.kind === "task");
    expect(task?.payload).toEqual({
      type: "text",
      text: "first line\nsecond line",
    });
    expect(task?.content).toContain("\n");
    expect(task?.content).not.toContain("\\n");
    const assistant = requests.find(
      (request) =>
        request.kind === "assistant" && request.payload !== undefined,
    );
    expect(assistant?.payload).toMatchObject({
      type: "assistant",
      text: "visible answer",
      thinking: "reasoning",
      streaming: true,
    });
    const tool = requests.find((request) => request.kind === "tool");
    expect(tool?.payload).toMatchObject({
      type: "tool",
      toolName: "read",
      toolCallId: "payload-tool",
      state: "result",
      knownTool: true,
      argumentsKnown: true,
      arguments: { path: "file" },
      result: { content: [{ type: "text", text: "file body" }] },
    });
  });

  it("drops suppressed facts from native rows and lines", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("keep this").isOk()).toBe(true);
    applyAll(reducer, [
      { type: "status", status: "running" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      {
        type: "extension_ui_request",
        requestType: "widget",
        requestId: "suppressed-widget",
        widget: {},
      },
    ]);

    let invalidateCount = 0;
    const factory: PiTranscriptComponentFactory = {
      suppress: (request) =>
        request.kind === "status" ||
        request.kind === "usage" ||
        request.kind === "extension_ui",
      create: (request) => ({
        render: () => [`native:${request.kind}`],
        invalidate: () => {
          invalidateCount += 1;
        },
      }),
    };
    const renderer = new PiChildTranscriptRenderer({
      componentFactory: factory,
    });
    const rendered = renderer.render(reducer.getState(), 80);

    expect(rendered.rows.map((row) => row.kind)).toEqual(["task"]);
    expect(rendered.lines).toEqual(["native:task"]);
    expect(rendered.lines.join("\n")).not.toContain("extension ui");
    expect(invalidateCount).toBe(0);
  });

  it("clips styled native lines to the render width so rows cannot wrap", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("clip me").isOk()).toBe(true);
    const long = `\u001b[31m${"x".repeat(200)}\u001b[0m`;
    const factory: PiTranscriptComponentFactory = {
      create: () => ({
        render: () => [long, `\u001b[1m${"\u754c".repeat(80)}\u001b[0m`],
        invalidate: () => undefined,
      }),
    };
    const rendered = new PiChildTranscriptRenderer({
      componentFactory: factory,
    }).render(reducer.getState(), 40);

    const visible = (line: string): number => {
      let width = 0;
      const ansiCsi = new RegExp(
        `${String.fromCharCode(0x1b)}\\[[0-9;:?]*[ -/]*[@-~]`,
        "g",
      );
      const stripped = line.replace(ansiCsi, "");
      for (const char of stripped) {
        const code = char.codePointAt(0) ?? 0;
        width += code >= 0x1100 && code <= 0x1faff ? 2 : 1;
      }
      return width;
    };
    expect(rendered.lines.length).toBeGreaterThan(0);
    expect(rendered.lines.every((line) => visible(line) <= 40)).toBe(true);
    expect(rendered.lines.some((line) => line.includes("\u001b[31m"))).toBe(
      true,
    );
  });

  it("does not spend visible width on hyperlink targets", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("link").isOk()).toBe(true);
    const link =
      "\u001b]8;;file:///a/very/long/absolute/path/that/exceeds/the/width.ts\u001b\\short.ts\u001b]8;;\u001b\\ done";
    const factory: PiTranscriptComponentFactory = {
      create: () => ({
        render: () => [link],
        invalidate: () => undefined,
      }),
    };
    const rendered = new PiChildTranscriptRenderer({
      componentFactory: factory,
    }).render(reducer.getState(), 30);

    const line = rendered.lines[0] ?? "";
    expect(line).toContain("short.ts");
    expect(line).toContain("done");
    expect(line).toContain("file:///a/very/long");
  });

  it("treats a throwing suppress hook as no suppression", () => {
    const reducer = new PiChildTranscriptReducer();
    expect(reducer.addTask("survives").isOk()).toBe(true);
    const factory: PiTranscriptComponentFactory = {
      suppress: () => {
        throw new Error("suppress exploded");
      },
      create: () => ({
        render: () => ["native"],
        invalidate: () => undefined,
      }),
    };
    const rendered = new PiChildTranscriptRenderer({
      componentFactory: factory,
    }).render(reducer.getState(), 80);
    expect(rendered.lines).toEqual(["native"]);
  });
});
