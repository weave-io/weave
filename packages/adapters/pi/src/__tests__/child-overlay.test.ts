import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS,
  type PiNativeSessionEntryPage,
  type PiNativeSessionEntryPageOptions,
  type PiNativeSessionError,
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  type PiNativeSessionHostPort,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import {
  CHILD_OVERLAY_BOUNDS,
  type ChildOverlayChild,
  type ChildOverlayEntry,
  type ChildOverlayFallbackRequired,
  type ChildOverlayMutationPort,
  type ChildOverlayReplayStep,
  type ChildOverlaySourceError,
  type ChildOverlaySourcePort,
  type ChildOverlayView,
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createMemoryChildOverlaySource,
  createReadSessionEntryPageOverlaySource,
  type MemoryOverlaySourceChild,
  type MemoryOverlaySourceEntry,
  mapNativeSessionEntryToOverlay,
  mapPiDelegationFailureToOverlaySourceError,
  mergeChildOverlayReplaySteps,
  transcriptFromOverlayEntries,
} from "../child-overlay.js";
import { boundText } from "../child-overlay-replay.js";
import { parsePiChildSessionEvent } from "../child-session-events.js";
import {
  makeThreadAuthorityDeniedFailure,
  makeThreadIntegrityFailure,
  makeThreadNotFoundFailure,
} from "../errors.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";

/** Pi native components read the process-wide theme. */
initTheme("default");

const ESCAPE = "\x1b";
const ENTER = "\r";
const ALT_ENTER = "\x1b\r";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const END = "\x1b[F";
const CTRL_E = "\x05";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content },
  };
}

function runDivider(
  id: string,
  run: number,
  action: "start" | "retry" | "continue",
): unknown {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "weave.child.run-divider",
    data: { run, action },
  };
}

function assistantMessage(id: string, content: readonly unknown[]): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", content },
  };
}

function userMessage(id: string, content: readonly unknown[]): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content },
  };
}

function toolResultMessage(
  id: string,
  toolCallId: string,
  content: readonly unknown[],
  isError = false,
): unknown {
  return userMessage(id, [
    { type: "toolResult", toolCallId, isError, content },
  ]);
}

/**
 * One native page covering every entry family the overlay must survive:
 * prompt, assistant text + reasoning + tool calls, a tool result, a tool
 * error, a standalone image and a run divider.
 */
function nativeConversation(): readonly unknown[] {
  return [
    message("n0", "user", "inspect the repo"),
    assistantMessage("n1", [
      { type: "thinking", thinking: "weighing the options" },
      { type: "text", text: "reading two files" },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "src/index.ts" },
      },
      {
        type: "toolCall",
        id: "call-2",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]),
    toolResultMessage("n2", "call-1", [
      { type: "text", text: "file contents here" },
    ]),
    toolResultMessage("n3", "call-2", [{ type: "text", text: "boom" }], true),
    userMessage("n4", [
      { type: "image", data: "ignored-bytes", mimeType: "image/png" },
    ]),
    runDivider("n5", 2, "continue"),
  ];
}

function mapNative(native: readonly unknown[]): ChildOverlayEntry[] {
  const mapped: ChildOverlayEntry[] = [];
  for (let index = 0; index < native.length; index += 1) {
    const result = mapNativeSessionEntryToOverlay(native[index], index);
    expect(result.isOk()).toBe(true);
    const entry = result._unsafeUnwrap();
    if (entry !== undefined) mapped.push(entry);
  }
  return mapped;
}

function entries(count: number, prefix = "e"): MemoryOverlaySourceEntry[] {
  const result: MemoryOverlaySourceEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `${prefix}${i}`;
    let role: "user" | "assistant";
    if (i === 0 || i % 2 === 0) {
      role = "user";
    } else {
      role = "assistant";
    }
    result.push({
      id,
      payload: message(id, role, `${prefix}-text-${i}`),
    });
  }
  return result;
}

function child(
  partial: Partial<MemoryOverlaySourceChild> &
    Pick<MemoryOverlaySourceChild, "childId" | "entries">,
): MemoryOverlaySourceChild {
  return {
    threadId: partial.threadId ?? partial.childId,
    status: partial.status ?? "settled",
    title: partial.title,
    generationId: partial.generationId,
    parentChildId: partial.parentChildId,
    runs: partial.runs ?? [{ run: 1, action: "start" }],
    branchIds: partial.branchIds ?? ["main"],
    descendantChildIds: partial.descendantChildIds ?? [],
    childId: partial.childId,
    entries: partial.entries,
  };
}

async function mustOpen(
  controller: ReturnType<typeof createChildOverlayController>,
  target: ChildOverlayChild | string,
): Promise<ChildOverlayView> {
  const result = await controller.open(target);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

/**
 * Describe succeeds, but the initial historical newest-page read fails with a
 * caller-chosen source error. Models both the transient live startup gap and
 * the hard failures that must stay fail-closed.
 */
function failingNewestSource(
  children: readonly MemoryOverlaySourceChild[],
  error: ChildOverlaySourceError,
): ChildOverlaySourcePort {
  const memory = createMemoryChildOverlaySource(children);
  return {
    describe: (childId) => memory.describe(childId),
    loadNewest: () => errAsync(error),
    loadOlder: (childId, cursor, pageSize) =>
      memory.loadOlder(childId, cursor, pageSize),
    loadNewer: (childId, cursor, pageSize) =>
      memory.loadNewer(childId, cursor, pageSize),
  };
}

/** In-memory native page adapter for overlay source unit tests. */
function pageMemoryEntries(
  entries: readonly unknown[],
  options: PiNativeSessionEntryPageOptions,
): PiNativeSessionEntryPage {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)));
  const parseCursor = (cursor: string | undefined): number => {
    if (cursor === undefined || !cursor.startsWith("idx:")) return -1;
    const value = Number(cursor.slice(4));
    return Number.isSafeInteger(value) ? value : -1;
  };
  if (options.direction === "newest") {
    const start = Math.max(0, entries.length - limit);
    const slice = entries.slice(start);
    return {
      entries: slice.map((value, index) => ({
        kind: "entry" as const,
        offset: start + index,
        value,
      })),
      ...(start > 0 ? { olderCursor: `idx:${start}` } : {}),
      ...(entries.length > 0
        ? { newerCursor: `idx:${entries.length - 1}` }
        : {}),
      bytesRead: slice.length,
      linesScanned: slice.length,
    };
  }
  const cursorIndex = parseCursor(options.cursor);
  if (cursorIndex < 0) {
    return { entries: [], bytesRead: 0, linesScanned: 0 };
  }
  if (options.direction === "older") {
    const end = cursorIndex;
    const start = Math.max(0, end - limit);
    const slice = entries.slice(start, end);
    return {
      entries: slice.map((value, index) => ({
        kind: "entry" as const,
        offset: start + index,
        value,
      })),
      ...(start > 0 ? { olderCursor: `idx:${start}` } : {}),
      ...(slice.length > 0
        ? { newerCursor: `idx:${start + slice.length - 1}` }
        : {}),
      bytesRead: slice.length,
      linesScanned: slice.length,
    };
  }
  const start = cursorIndex + 1;
  const end = Math.min(entries.length, start + limit);
  const slice = entries.slice(start, end);
  return {
    entries: slice.map((value, index) => ({
      kind: "entry" as const,
      offset: start + index,
      value,
    })),
    ...(start > 0 && slice.length > 0 ? { olderCursor: `idx:${start}` } : {}),
    ...(end < entries.length ? { newerCursor: `idx:${end - 1}` } : {}),
    bytesRead: slice.length,
    linesScanned: slice.length,
  };
}

describe("boundText", () => {
  it("strips C0 controls in U+0000–U+0008, VT, FF, U+000E–U+001F, and DEL", () => {
    const nulThroughBs = Array.from({ length: 9 }, (_, i) =>
      String.fromCodePoint(i),
    ).join("");
    const soThroughUs = Array.from({ length: 0x1f - 0x0e + 1 }, (_, i) =>
      String.fromCodePoint(0x0e + i),
    ).join("");
    const dirty = `keep${nulThroughBs}\u000b\u000c${soThroughUs}\u007ftext`;

    const cleaned = boundText(dirty);
    expect(cleaned).toBe("keeptext");
    for (const ch of cleaned) {
      const cp = ch.codePointAt(0) ?? -1;
      const stripped =
        (cp >= 0x00 && cp <= 0x08) ||
        cp === 0x0b ||
        cp === 0x0c ||
        (cp >= 0x0e && cp <= 0x1f) ||
        cp === 0x7f;
      expect(stripped).toBe(false);
    }
  });

  it("preserves TAB, LF, and CR while still stripping neighboring C0 controls", () => {
    const value = "a\u0008\t\nb\u000c\rc\u001b[31md\u007f";
    expect(boundText(value)).toBe("a\t\nb\rc[31md");
  });

  it("strips all C1 controls including CSI U+009B and OSC U+009D", () => {
    const allC1 = Array.from({ length: 0x9f - 0x80 + 1 }, (_, i) =>
      String.fromCodePoint(0x80 + i),
    ).join("");
    expect(boundText(`keep${allC1}text`)).toBe("keeptext");
    // Terminal-like CSI payload: C1 CSI + params/intermediates + final byte
    expect(boundText("a\u009b31mb")).toBe("a31mb");
    // Raw C1 OSC introducer with payload fragment
    expect(boundText("x\u009d8;https://evil.example\u009cz")).toBe(
      "x8;https://evil.examplez",
    );
    expect(boundText("x\u0080y\u009fz")).toBe("xyz");
  });

  it("bounds length after control sanitization", () => {
    const max = CHILD_OVERLAY_BOUNDS.maxTextLength;
    const padded = `${"\u0000".repeat(8)}${"x".repeat(max + 10)}`;
    expect(boundText(padded)).toBe("x".repeat(max));
  });
});

describe("mapNativeSessionEntryToOverlay", () => {
  it("maps user/assistant messages and run dividers without retaining paths", () => {
    const prompt = mapNativeSessionEntryToOverlay(
      message("m0", "user", "do the work"),
      0,
    )._unsafeUnwrap();
    expect(prompt?.kind).toBe("prompt");
    expect(prompt?.text).toBe("do the work");

    const assistant = mapNativeSessionEntryToOverlay(
      message("m1", "assistant", "done"),
      1,
    )._unsafeUnwrap();
    expect(assistant?.kind).toBe("assistant");

    const divider = mapNativeSessionEntryToOverlay(
      runDivider("r2", 2, "retry"),
      2,
    )._unsafeUnwrap();
    expect(divider?.kind).toBe("run-divider");
    expect(divider?.runNumber).toBe(2);
    expect(divider?.text).not.toContain("/Users/");
  });

  it("builds a transcript handoff model from overlay entries", () => {
    const mapped = [
      mapNativeSessionEntryToOverlay(
        message("a", "user", "task"),
        0,
      )._unsafeUnwrap(),
      mapNativeSessionEntryToOverlay(
        message("b", "assistant", "ok"),
        1,
      )._unsafeUnwrap(),
    ].filter(
      (entry): entry is NonNullable<typeof entry> => entry !== undefined,
    );
    const transcript = transcriptFromOverlayEntries(mapped);
    expect(transcript.entries.some((entry) => entry.kind === "task")).toBe(
      true,
    );
    expect(transcript.entries.some((entry) => entry.kind === "assistant")).toBe(
      true,
    );
  });
  it("preserves assistant thinking, tool calls, tool results, errors and images", () => {
    const mapped = mapNative(nativeConversation());
    const kinds = mapped.map((entry) => entry.kind);
    // No native fact collapses into an opaque `unknown` overlay fact.
    expect(kinds).not.toContain("unknown");
    expect(kinds).toEqual([
      "prompt",
      "assistant",
      "tool",
      "error",
      "image",
      "run-divider",
    ]);
    // Tool result text stays searchable rather than being flattened away.
    expect(mapped[2]?.text).toContain("file contents");
    expect(mapped[3]?.text).toContain("boom");

    const transcript = transcriptFromOverlayEntries(mapped);
    const byKind = (kind: string) =>
      transcript.entries.filter((entry) => entry.kind === kind);
    expect(byKind("task").length).toBe(1);
    expect(byKind("assistant").length).toBe(1);
    expect(byKind("thinking").length).toBe(1);
    expect(byKind("image").length).toBe(1);
    expect(transcript.entries.some((entry) => entry.kind === "unknown")).toBe(
      false,
    );

    const tools = transcript.entries.filter((entry) => entry.kind === "tool");
    expect(tools.length).toBe(2);
    const read = tools.find(
      (entry) => "toolCallId" in entry && entry.toolCallId === "call-1",
    );
    const failing = tools.find(
      (entry) => "toolCallId" in entry && entry.toolCallId === "call-2",
    );
    expect(read && "toolName" in read ? read.toolName : undefined).toBe("read");
    expect(read && "state" in read ? read.state : undefined).toBe("result");
    expect(failing && "state" in failing ? failing.state : undefined).toBe(
      "error",
    );

    // Ordering matches the native entry order.
    const order = transcript.entries.map((entry) => entry.kind);
    expect(order.indexOf("task")).toBeLessThan(order.indexOf("thinking"));
    expect(order.indexOf("thinking")).toBeLessThan(order.indexOf("tool"));
  });

  it("reconstructs an image tool result without retaining image bytes", () => {
    const [entry] = mapNative([
      toolResultMessage("tr", "call-9", [
        { type: "image", data: "A".repeat(64), mimeType: "image/png" },
      ]),
    ]);
    expect(entry?.kind).toBe("tool");
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("A".repeat(64));
    expect(serialized).toContain("image/png");
    const transcript = transcriptFromOverlayEntries(
      entry === undefined ? [] : [entry],
    );
    const tool = transcript.entries.find((item) => item.kind === "tool");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool)).toContain("image");
  });

  it("derives replay steps large enough for every admitted content block plus framing", () => {
    expect(CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps).toBe(
      CHILD_OVERLAY_BOUNDS.maxEntryContentBlocks + 3,
    );
  });

  it("reconstructs 15 tool calls/results plus final text/image with streaming=false", () => {
    const toolCount = 15;
    const assistantContent: unknown[] = [];
    for (let i = 0; i < toolCount; i += 1) {
      assistantContent.push({
        type: "toolCall",
        id: `call-${i}`,
        name: `tool-${i}`,
        arguments: { i },
      });
    }
    assistantContent.push({ type: "text", text: "final answer" });
    assistantContent.push({
      type: "image",
      mimeType: "image/webp",
    });

    const native: unknown[] = [
      assistantMessage("bound-asst", assistantContent),
    ];
    for (let i = 0; i < toolCount; i += 1) {
      native.push(
        toolResultMessage(`tr-${i}`, `call-${i}`, [
          { type: "text", text: `result-${i}` },
        ]),
      );
    }

    const mapped = mapNative(native);
    const assistant = mapped[0];
    expect(assistant?.kind).toBe("assistant");
    expect(assistant?.text).toContain("final answer");
    expect(
      (assistant?.replay ?? []).some(
        (step) => step.kind === "event" && step.event.type === "message_end",
      ),
    ).toBe(true);

    const transcript = transcriptFromOverlayEntries(mapped);
    const tools = transcript.entries.filter((entry) => entry.kind === "tool");
    expect(tools.length).toBe(toolCount);
    for (let i = 0; i < toolCount; i += 1) {
      const tool = tools.find(
        (entry) => "toolCallId" in entry && entry.toolCallId === `call-${i}`,
      );
      expect(tool).toBeDefined();
      expect(tool && "state" in tool ? tool.state : undefined).toBe("result");
      expect(tool && "toolName" in tool ? tool.toolName : undefined).toBe(
        `tool-${i}`,
      );
    }
    const asst = transcript.entries.find((entry) => entry.kind === "assistant");
    expect(asst).toBeDefined();
    expect(asst && "text" in asst ? asst.text : undefined).toBe("final answer");
    expect(asst && "streaming" in asst ? asst.streaming : undefined).toBe(
      false,
    );
    expect(transcript.entries.some((entry) => entry.kind === "image")).toBe(
      true,
    );
  });

  it("reconstructs an assistant at the content-block bound with streaming=false", () => {
    const bound = CHILD_OVERLAY_BOUNDS.maxEntryContentBlocks;
    const content: unknown[] = [];
    for (let i = 0; i < bound - 2; i += 1) {
      content.push({
        type: "toolCall",
        id: `bound-call-${i}`,
        name: `bound-tool-${i}`,
        arguments: {},
      });
    }
    content.push({ type: "text", text: "bound terminal" });
    content.push({ type: "image", mimeType: "image/png" });
    expect(content.length).toBe(bound);

    const mapped = mapNativeSessionEntryToOverlay(
      assistantMessage("bound-max", content),
      0,
    );
    expect(mapped.isOk()).toBe(true);
    const entry = mapped._unsafeUnwrap();
    expect(entry?.replay?.length).toBeLessThanOrEqual(
      CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps,
    );
    expect(
      (entry?.replay ?? []).some(
        (step) => step.kind === "event" && step.event.type === "message_end",
      ),
    ).toBe(true);

    const transcript = transcriptFromOverlayEntries(
      entry === undefined ? [] : [entry],
    );
    const tools = transcript.entries.filter((item) => item.kind === "tool");
    expect(tools.length).toBe(bound - 2);
    const asst = transcript.entries.find((item) => item.kind === "assistant");
    expect(asst && "streaming" in asst ? asst.streaming : undefined).toBe(
      false,
    );
    expect(asst && "text" in asst ? asst.text : undefined).toBe(
      "bound terminal",
    );
    expect(transcript.entries.some((item) => item.kind === "image")).toBe(true);
  });

  it("rejects max+1 content blocks with a typed capacity error", () => {
    const overflow = CHILD_OVERLAY_BOUNDS.maxEntryContentBlocks + 1;
    const content: unknown[] = [];
    for (let i = 0; i < overflow; i += 1) {
      content.push({
        type: "toolCall",
        id: `overflow-${i}`,
        name: "read",
        arguments: {},
      });
    }
    const mapped = mapNativeSessionEntryToOverlay(
      assistantMessage("overflow", content),
      0,
    );
    expect(mapped.isErr()).toBe(true);
    expect(mapped._unsafeUnwrapErr()).toEqual({
      type: "OverlayCapacityExceeded",
      operation: "entry-content-blocks",
    });
  });
});

describe("ChildOverlayController", () => {
  it("opens a historical child with the newest bounded page", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "hist-1", status: "settled", entries: entries(80) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    const view = await mustOpen(overlay, "hist-1");
    expect(view.child.status).toBe("settled");
    expect(view.readOnly).toBe(true);
    expect(view.entries.length).toBe(20);
    expect(view.entries.at(-1)?.id).toBe("e79");
    expect(view.hasOlder).toBe(true);
    expect(view.hasNewer).toBe(false);
    expect(view.liveTail).toBe(true);
  });

  it("opens a live child and applies Task 11 parser/reducer live events", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "live-1",
        status: "live",
        generationId: "gen-1",
        entries: entries(5, "live"),
        runs: [
          { run: 1, action: "start" },
          { run: 2, action: "continue" },
        ],
      }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const opened = await mustOpen(overlay, "live-1");
    expect(opened.child.status).toBe("live");
    expect(opened.readOnly).toBe(false);
    expect(opened.activeRun).toBe(2);

    const after = overlay.applyLiveEvent({
      type: "message_update",
      delta: { messageId: "msg-live", text: "streaming fragment" },
    });
    expect(after.isOk()).toBe(true);
    const view = after._unsafeUnwrap();
    expect(view.entries.some((entry) => entry.text.includes("streaming"))).toBe(
      true,
    );
    expect(view.compact.runs.length).toBeGreaterThanOrEqual(0);
  });

  it("rebuilds a trimmed live window into the same transcript the reducer built", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "live-fidelity",
        status: "live",
        generationId: "gen-1",
        entries: [],
      }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      windowCap: 64,
    });
    await mustOpen(overlay, "live-fidelity");

    const liveEvents: readonly unknown[] = [
      { type: "message_start", message: { id: "msg-1", role: "assistant" } },
      { type: "thinking", text: "considering the plan" },
      { type: "tool_call", toolCallId: "call-1", toolName: "read" },
      {
        type: "tool_result",
        toolCallId: "call-1",
        result: { content: [{ type: "text", text: "file contents here" }] },
      },
      { type: "tool_call", toolCallId: "call-2", toolName: "bash" },
      { type: "tool_error", toolCallId: "call-2", error: "boom" },
      { type: "image", mimeType: "image/png" },
      {
        type: "message_end",
        message: { id: "msg-1", role: "assistant", content: "all done" },
      },
    ];
    let view = overlay.view()._unsafeUnwrap();
    for (const event of liveEvents) {
      view = overlay.applyLiveEvent(event)._unsafeUnwrap();
    }

    const summarize = (
      transcript: ChildOverlayView["transcript"],
    ): readonly string[] =>
      transcript.entries.map((entry) => {
        if (entry.kind === "tool")
          return `tool:${entry.toolCallId}:${entry.toolName}:${entry.state}`;
        if (entry.kind === "assistant")
          return `assistant:${entry.messageId}:${entry.text}`;
        if ("text" in entry && typeof entry.text === "string")
          return `${entry.kind}:${entry.text}`;
        return entry.kind;
      });

    const live = summarize(view.transcript);
    // Live reducer fidelity: every kind survives with its own entry.
    expect(live).toContain("thinking:considering the plan");
    expect(live).toContain("tool:call-1:read:result");
    expect(live).toContain("tool:call-2:bash:error");
    expect(live).toContain("assistant:msg-1:all done");
    expect(live.some((item) => item.startsWith("image"))).toBe(true);

    // The window rebuild (what page merges and trims use) must reproduce it.
    const rebuilt = summarize(transcriptFromOverlayEntries(view.entries));
    expect(rebuilt).toEqual(live);
  });

  it("keeps live tool results and thinking after a window trim rebuild", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "live-trim",
        status: "live",
        generationId: "gen-1",
        entries: [],
      }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 4,
      windowCap: 4,
    });
    await mustOpen(overlay, "live-trim");
    for (const event of [
      { type: "thinking", text: "first thought" },
      { type: "tool_call", toolCallId: "call-x", toolName: "grep" },
      {
        type: "tool_result",
        toolCallId: "call-x",
        result: { content: [{ type: "text", text: "match found" }] },
      },
      { type: "thinking", text: "second thought" },
      { type: "image", mimeType: "image/png" },
      { type: "text", text: "summary" },
    ]) {
      overlay.applyLiveEvent(event)._unsafeUnwrap();
    }
    // Force the trim rebuild path by expanding, which re-projects the window.
    const view = overlay.toggleGlobalExpansion()._unsafeUnwrap();
    expect(view.entries.length).toBeLessThanOrEqual(4);

    const rebuilt = transcriptFromOverlayEntries(view.entries);
    const kinds = rebuilt.entries.map((entry) => entry.kind);
    // Retained window facts keep their kinds instead of degrading to unknown.
    for (const entry of view.entries) {
      if (entry.kind === "tool") expect(kinds).toContain("tool");
      if (entry.kind === "thinking") expect(kinds).toContain("thinking");
      if (entry.kind === "image") expect(kinds).toContain("image");
    }
    expect(kinds).not.toContain("unknown");
    // Expansion state survives the rebuild for every retained entry.
    expect(view.transcript.entries.every((entry) => entry.expanded)).toBe(true);
  });

  it("preserves live merge start/end terminals at the replay bound without false streaming", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "live-merge-bound",
        status: "live",
        generationId: "gen-1",
        entries: [],
      }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      windowCap: 64,
    });
    await mustOpen(overlay, "live-merge-bound");

    // Real Pi 0.84 emits the pi-ai `AssistantMessage` directly, and that type
    // has no `id`. Lifecycle identity is the controller-allocated overlay id.
    overlay
      .applyLiveEvent({
        type: "message_start",
        message: { role: "assistant", model: "test-model", content: [] },
      })
      ._unsafeUnwrap();

    const toolCount = 15;
    for (let i = 0; i < toolCount; i += 1) {
      overlay
        .applyLiveEvent({
          type: "tool_call",
          toolCallId: `live-call-${i}`,
          toolName: `live-tool-${i}`,
        })
        ._unsafeUnwrap();
      overlay
        .applyLiveEvent({
          type: "tool_result",
          toolCallId: `live-call-${i}`,
          result: { content: [{ type: "text", text: `live-result-${i}` }] },
        })
        ._unsafeUnwrap();
    }
    overlay
      .applyLiveEvent({ type: "image", mimeType: "image/png" })
      ._unsafeUnwrap();
    const view = overlay
      .applyLiveEvent({
        type: "message_end",
        message: {
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "live final" }],
        },
      })
      ._unsafeUnwrap();

    // One assistant window entry for the whole lifecycle, under the id the
    // controller allocated at `message_start`.
    const assistantEntries = view.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(assistantEntries.length).toBe(1);
    const assistantEntry = assistantEntries[0];
    expect(assistantEntry?.id).toBe("live-assistant-0");
    const replay = assistantEntry?.replay ?? [];
    expect(replay.length).toBeLessThanOrEqual(
      CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps,
    );
    expect(
      replay.some(
        (step) => step.kind === "event" && step.event.type === "message_start",
      ),
    ).toBe(true);
    expect(
      replay.some(
        (step) => step.kind === "event" && step.event.type === "message_end",
      ),
    ).toBe(true);

    const asst = view.transcript.entries.find(
      (entry) => entry.kind === "assistant",
    );
    expect(asst?.overlayEntryId).toBe("live-assistant-0");
    expect(asst && "streaming" in asst ? asst.streaming : undefined).toBe(
      false,
    );
    expect(asst && "text" in asst ? asst.text : undefined).toBe("live final");

    const tools = view.transcript.entries.filter(
      (entry) => entry.kind === "tool",
    );
    expect(tools.length).toBe(toolCount);
    for (let i = 0; i < toolCount; i += 1) {
      expect(
        tools.some(
          (entry) =>
            "toolCallId" in entry && entry.toolCallId === `live-call-${i}`,
        ),
      ).toBe(true);
    }

    // Rebuild from the window must keep the terminal (no false streaming).
    const rebuilt = transcriptFromOverlayEntries(view.entries);
    const rebuiltAsst = rebuilt.entries.find(
      (entry) => entry.kind === "assistant",
    );
    expect(
      rebuiltAsst && "streaming" in rebuiltAsst
        ? rebuiltAsst.streaming
        : undefined,
    ).toBe(false);
    expect(
      rebuiltAsst && "text" in rebuiltAsst ? rebuiltAsst.text : undefined,
    ).toBe("live final");
  });

  it("compacts tool partial overflow and rebuilds call args plus terminal result", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "live-merge-overflow",
        status: "live",
        generationId: "gen-1",
        entries: [],
      }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      windowCap: 256,
    });
    await mustOpen(overlay, "live-merge-overflow");

    const toolCallId = "merge-tool";
    const toolArgs = { path: "src/index.ts", mode: "full" };
    overlay
      .applyLiveEvent({
        type: "message_start",
        message: { role: "assistant", model: "test-model", content: [] },
      })
      ._unsafeUnwrap();
    overlay
      .applyLiveEvent({
        type: "tool_call",
        toolCallId,
        toolName: "read",
        arguments: toolArgs,
      })
      ._unsafeUnwrap();

    const overfill = CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps + 4;
    for (let i = 0; i < overfill; i += 1) {
      overlay
        .applyLiveEvent({
          type: "tool_partial_result",
          toolCallId,
          toolName: "read",
          partialResult: { content: [{ type: "text", text: `partial-${i}` }] },
        })
        ._unsafeUnwrap();
    }
    overlay
      .applyLiveEvent({
        type: "tool_result",
        toolCallId,
        result: { content: [{ type: "text", text: "done" }] },
      })
      ._unsafeUnwrap();

    const view = overlay
      .applyLiveEvent({
        type: "message_end",
        message: {
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "overflow ok" }],
        },
      })
      ._unsafeUnwrap();

    const toolEntry = view.entries.find((entry) => entry.id === toolCallId);
    expect(toolEntry).toBeDefined();
    expect((toolEntry?.replay ?? []).length).toBeLessThanOrEqual(
      CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps,
    );
    expect(
      (toolEntry?.replay ?? []).some(
        (step) =>
          step.kind === "event" &&
          step.event.type === "tool_call" &&
          "arguments" in step.event &&
          JSON.stringify(step.event.arguments) === JSON.stringify(toolArgs),
      ),
    ).toBe(true);
    expect(
      (toolEntry?.replay ?? []).some(
        (step) => step.kind === "event" && step.event.type === "tool_result",
      ),
    ).toBe(true);
    // Semantic compaction keeps one partial stage, not every streaming chunk.
    expect(
      (toolEntry?.replay ?? []).filter(
        (step) =>
          step.kind === "event" && step.event.type === "tool_partial_result",
      ).length,
    ).toBeLessThanOrEqual(1);

    const assistantEntries = view.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(assistantEntries.length).toBe(1);
    const assistantEntry = assistantEntries[0];
    expect(assistantEntry?.id).toBe("live-assistant-0");
    expect(
      (assistantEntry?.replay ?? []).some(
        (step) => step.kind === "event" && step.event.type === "message_end",
      ),
    ).toBe(true);

    const asst = view.transcript.entries.find(
      (entry) => entry.kind === "assistant",
    );
    expect(asst?.overlayEntryId).toBe("live-assistant-0");
    expect(asst && "streaming" in asst ? asst.streaming : undefined).toBe(
      false,
    );

    const rebuilt = transcriptFromOverlayEntries(view.entries);
    const rebuiltTool = rebuilt.entries.find(
      (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
    );
    expect(rebuiltTool).toBeDefined();
    expect(
      rebuiltTool && "state" in rebuiltTool ? rebuiltTool.state : undefined,
    ).toBe("result");
    expect(
      rebuiltTool && "arguments" in rebuiltTool
        ? rebuiltTool.arguments
        : undefined,
    ).toEqual(toolArgs);
    expect(
      rebuiltTool && "result" in rebuiltTool
        ? JSON.stringify(rebuiltTool.result)
        : undefined,
    ).toContain("done");

    const rebuiltAsst = rebuilt.entries.find(
      (entry) => entry.kind === "assistant",
    );
    expect(
      rebuiltAsst && "streaming" in rebuiltAsst
        ? rebuiltAsst.streaming
        : undefined,
    ).toBe(false);
    expect(
      rebuiltAsst && "text" in rebuiltAsst ? rebuiltAsst.text : undefined,
    ).toBe("overflow ok");
  });

  it("compacts tool partial overflow and rebuilds call args plus terminal error", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "live-merge-error",
        status: "live",
        generationId: "gen-1",
        entries: [],
      }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      windowCap: 256,
    });
    await mustOpen(overlay, "live-merge-error");

    const toolCallId = "err-tool";
    const toolArgs = { cmd: "false" };
    overlay
      .applyLiveEvent({
        type: "tool_call",
        toolCallId,
        toolName: "bash",
        arguments: toolArgs,
      })
      ._unsafeUnwrap();
    const overfill = CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps + 4;
    for (let i = 0; i < overfill; i += 1) {
      overlay
        .applyLiveEvent({
          type: "tool_partial_result",
          toolCallId,
          partialResult: { content: [{ type: "text", text: `chunk-${i}` }] },
        })
        ._unsafeUnwrap();
    }
    const view = overlay
      .applyLiveEvent({
        type: "tool_error",
        toolCallId,
        error: "exit 1",
      })
      ._unsafeUnwrap();

    const rebuilt = transcriptFromOverlayEntries(view.entries);
    const tool = rebuilt.entries.find(
      (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
    );
    expect(tool && "state" in tool ? tool.state : undefined).toBe("error");
    expect(tool && "arguments" in tool ? tool.arguments : undefined).toEqual(
      toolArgs,
    );
    expect(tool && "error" in tool ? tool.error : undefined).toBe("exit 1");
  });

  it("rebuilds an assistant that contains tools with call, terminal, and message_end", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "live-asst-tools",
        status: "live",
        generationId: "gen-1",
        entries: [],
      }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      windowCap: 256,
    });
    await mustOpen(overlay, "live-asst-tools");

    const events: readonly unknown[] = [
      // Real Pi 0.84 lifecycle framing: no message id on either terminal.
      {
        type: "message_start",
        message: { role: "assistant", model: "test-model", content: [] },
      },
      {
        type: "tool_call",
        toolCallId: "call-a",
        toolName: "read",
        arguments: { path: "a.ts" },
      },
      {
        type: "tool_result",
        toolCallId: "call-a",
        result: { content: [{ type: "text", text: "a-ok" }] },
      },
      {
        type: "tool_call",
        toolCallId: "call-b",
        toolName: "bash",
        arguments: { cmd: "ls" },
      },
      { type: "tool_error", toolCallId: "call-b", error: "denied" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "wrapped up" }],
        },
      },
    ];
    let view = overlay.view()._unsafeUnwrap();
    for (const event of events) {
      view = overlay.applyLiveEvent(event)._unsafeUnwrap();
    }

    const rebuilt = transcriptFromOverlayEntries(view.entries);
    const toolA = rebuilt.entries.find(
      (entry) => entry.kind === "tool" && entry.toolCallId === "call-a",
    );
    const toolB = rebuilt.entries.find(
      (entry) => entry.kind === "tool" && entry.toolCallId === "call-b",
    );
    const asst = rebuilt.entries.find((entry) => entry.kind === "assistant");
    expect(toolA && "state" in toolA ? toolA.state : undefined).toBe("result");
    expect(toolA && "arguments" in toolA ? toolA.arguments : undefined).toEqual(
      { path: "a.ts" },
    );
    expect(toolB && "state" in toolB ? toolB.state : undefined).toBe("error");
    expect(toolB && "arguments" in toolB ? toolB.arguments : undefined).toEqual(
      { cmd: "ls" },
    );
    expect(asst && "streaming" in asst ? asst.streaming : undefined).toBe(
      false,
    );
    expect(asst && "text" in asst ? asst.text : undefined).toBe("wrapped up");

    const assistantEntries = view.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(assistantEntries.length).toBe(1);
    const assistantEntry = assistantEntries[0];
    expect(assistantEntry?.id).toBe("live-assistant-0");
    expect(
      (assistantEntry?.replay ?? []).some(
        (step) => step.kind === "event" && step.event.type === "message_start",
      ),
    ).toBe(true);
    expect(
      (assistantEntry?.replay ?? []).some(
        (step) => step.kind === "event" && step.event.type === "message_end",
      ),
    ).toBe(true);
  });

  it("returns typed capacity when essential replay frames exceed the bound", () => {
    const eventStep = (candidate: unknown): ChildOverlayReplayStep => {
      const parsed = parsePiChildSessionEvent(candidate);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error("expected session event");
      }
      return { kind: "event", event: parsed.data };
    };

    const essentials: ChildOverlayReplayStep[] = [
      eventStep({
        type: "message_start",
        message: { id: "cap-msg", role: "assistant" },
      }),
    ];
    const toolCount = CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps;
    for (let i = 0; i < toolCount; i += 1) {
      essentials.push(
        eventStep({
          type: "tool_call",
          toolCallId: `cap-${i}`,
          toolName: "read",
          arguments: { i },
        }),
        eventStep({
          type: "tool_result",
          toolCallId: `cap-${i}`,
          result: { content: [{ type: "text", text: `r-${i}` }] },
        }),
      );
    }
    essentials.push(
      eventStep({
        type: "message_end",
        message: { id: "cap-msg", role: "assistant", content: "done" },
      }),
    );

    const merged = mergeChildOverlayReplaySteps([], essentials);
    expect(merged.isErr()).toBe(true);
    expect(merged._unsafeUnwrapErr()).toEqual({
      type: "OverlayCapacityExceeded",
      operation: "entry-replay-steps",
    });
  });

  it("pages historical native entries without losing kinds or expansion", async () => {
    const native = nativeConversation();
    const source = createMemoryChildOverlaySource([
      child({
        childId: "hist-native",
        status: "settled",
        entries: native.map((payload, index) => ({
          id: `h${index}`,
          payload,
        })),
      }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 3,
      windowCap: 16,
    });
    const newest = await mustOpen(overlay, "hist-native");
    expect(newest.entries.map((entry) => entry.kind)).toEqual([
      "error",
      "image",
      "run-divider",
    ]);

    const older = (await overlay.loadOlder())._unsafeUnwrap();
    expect(older.entries.map((entry) => entry.kind)).toEqual([
      "prompt",
      "assistant",
      "tool",
      "error",
      "image",
      "run-divider",
    ]);
    const kinds = older.transcript.entries.map((entry) => entry.kind);
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("image");
    expect(kinds).not.toContain("unknown");
    const tools = older.transcript.entries.filter(
      (entry) => entry.kind === "tool",
    );
    expect(tools.length).toBe(2);
    expect(
      tools.map((entry) => ("state" in entry ? entry.state : "")).sort(),
    ).toEqual(["error", "result"]);

    // Expansion applies to the rebuilt transcript, not only the window.
    const expanded = overlay.toggleGlobalExpansion()._unsafeUnwrap();
    expect(expanded.entries.every((entry) => entry.expanded)).toBe(true);
    expect(expanded.transcript.entries.every((entry) => entry.expanded)).toBe(
      true,
    );
    // Searching a tool result still matches its text after paging.
    const searched = (await overlay.search("file contents"))._unsafeUnwrap();
    expect(searched.searchMatches.length).toBeGreaterThan(0);
  });

  it("paginates older and newer without exceeding the window cap", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "page-1", entries: entries(120) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 20,
      windowCap: 45,
    });
    await mustOpen(overlay, "page-1");
    const older = (await overlay.loadOlder())._unsafeUnwrap();
    expect(older.entries.length).toBeLessThanOrEqual(45);
    expect(older.hasOlder).toBe(true);
    const oldestId = older.entries[0]?.id;

    // Drop some newest by loading older until window trims, then load newer.
    await overlay.loadOlder();
    const afterTrim = (await overlay.loadOlder())._unsafeUnwrap();
    expect(afterTrim.entries.length).toBeLessThanOrEqual(45);
    expect(afterTrim.entries.every((entry) => entry.id.length > 0)).toBe(true);

    if (afterTrim.newerCursor !== undefined) {
      const newer = (await overlay.loadNewer())._unsafeUnwrap();
      expect(newer.entries.length).toBeLessThanOrEqual(45);
      expect(newer.entries.some((entry) => entry.id === oldestId)).toBe(true);
    }
  });

  it("keeps rendered transcript in sync across older/newer/search page merges", async () => {
    const transcriptMarkers = (view: ChildOverlayView): string[] => {
      const markers: string[] = [];
      for (const entry of view.transcript.entries) {
        if ("messageId" in entry && typeof entry.messageId === "string") {
          markers.push(entry.messageId);
        }
        if ("text" in entry && typeof entry.text === "string") {
          markers.push(entry.text);
        }
      }
      return markers;
    };
    const assertNoDuplicateTranscriptIds = (view: ChildOverlayView): void => {
      const ids = view.transcript.entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    };
    const assertTranscriptCoversWindow = (view: ChildOverlayView): void => {
      const markers = transcriptMarkers(view);
      for (const entry of view.entries) {
        const covered =
          markers.includes(entry.id) || markers.includes(entry.text);
        expect(covered).toBe(true);
      }
      assertNoDuplicateTranscriptIds(view);
    };
    const markerFor = (id: string): ((marker: string) => boolean) => {
      const text = `e-text-${id.slice(1)}`;
      return (marker) => marker === id || marker.includes(text);
    };

    const source = createMemoryChildOverlaySource([
      child({ childId: "render-page-1", entries: entries(6) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 2,
      windowCap: 4,
    });

    // Open newest page: e4–e5.
    const opened = await mustOpen(overlay, "render-page-1");
    expect(opened.entries.map((entry) => entry.id)).toEqual(["e4", "e5"]);
    assertTranscriptCoversWindow(opened);
    expect(transcriptMarkers(opened).some(markerFor("e4"))).toBe(true);
    expect(transcriptMarkers(opened).some(markerFor("e5"))).toBe(true);
    expect(transcriptMarkers(opened).some(markerFor("e2"))).toBe(false);

    // Load older page e2–e3; retained window + transcript must be e2–e5.
    const afterOlder = (await overlay.loadOlder())._unsafeUnwrap();
    expect(afterOlder.entries.map((entry) => entry.id)).toEqual([
      "e2",
      "e3",
      "e4",
      "e5",
    ]);
    assertTranscriptCoversWindow(afterOlder);
    for (const id of ["e2", "e3", "e4", "e5"]) {
      expect(transcriptMarkers(afterOlder).some(markerFor(id))).toBe(true);
    }

    // Overflow trim (another older page) drops the tip; transcript must drop
    // stale e4/e5 rows and keep only the retained window without dupes.
    const afterOverflow = (await overlay.loadOlder())._unsafeUnwrap();
    expect(afterOverflow.entries.map((entry) => entry.id)).toEqual([
      "e0",
      "e1",
      "e2",
      "e3",
    ]);
    assertTranscriptCoversWindow(afterOverflow);
    expect(transcriptMarkers(afterOverflow).some(markerFor("e5"))).toBe(false);
    expect(transcriptMarkers(afterOverflow).some(markerFor("e4"))).toBe(false);

    // Newer merges walk the opaque cursor back to the tip; transcript follows.
    let afterNewer = afterOverflow;
    let newerGuard = 0;
    while (
      afterNewer.hasNewer &&
      afterNewer.newerCursor !== undefined &&
      newerGuard < 4
    ) {
      afterNewer = (await overlay.loadNewer())._unsafeUnwrap();
      assertTranscriptCoversWindow(afterNewer);
      newerGuard += 1;
    }
    expect(afterNewer.entries.map((entry) => entry.id)).toEqual([
      "e2",
      "e3",
      "e4",
      "e5",
    ]);
    expect(transcriptMarkers(afterNewer).some(markerFor("e5"))).toBe(true);
    expect(transcriptMarkers(afterNewer).some(markerFor("e0"))).toBe(false);

    // Search merge from a tip-only open pulls older pages; transcript follows.
    const searchOverlay = createChildOverlayController(source, {
      pageSize: 2,
      windowCap: 4,
      maxSearchPages: 3,
    });
    await mustOpen(searchOverlay, "render-page-1");
    const afterSearch = (
      await searchOverlay.search("e-text-0")
    )._unsafeUnwrap();
    expect(afterSearch.entries.some((entry) => entry.id === "e0")).toBe(true);
    expect(afterSearch.searchMatches.length).toBeGreaterThan(0);
    assertTranscriptCoversWindow(afterSearch);
    expect(transcriptMarkers(afterSearch).some(markerFor("e0"))).toBe(true);
  });

  it("retains fetched older pages at the window cap without gaps or dupes", async () => {
    const total = 200;
    const pageSize = 20;
    const windowCap = 50;
    const source = createMemoryChildOverlaySource([
      child({ childId: "overflow-1", entries: entries(total) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize,
      windowCap,
    });
    const opened = await mustOpen(overlay, "overflow-1");
    expect(opened.entries.map((entry) => entry.id)).toEqual(
      Array.from({ length: pageSize }, (_, i) => `e${total - pageSize + i}`),
    );

    // Scroll to the oldest loaded edge so the logical anchor is stable there.
    overlay.setScrollOffset(opened.entries.length - 1)._unsafeUnwrap();
    const anchorBefore = overlay.view()._unsafeUnwrap().anchor?.entryId;
    expect(anchorBefore).toBe(opened.entries[0]?.id);

    const seenOldestIds: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      const view = (await overlay.loadOlder())._unsafeUnwrap();
      expect(view.entries.length).toBeLessThanOrEqual(windowCap);
      const ids = view.entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Contiguous numeric ids — no history gap inside the window.
      for (let i = 1; i < ids.length; i += 1) {
        const prev = Number(ids[i - 1]?.slice(1));
        const next = Number(ids[i]?.slice(1));
        expect(next).toBe(prev + 1);
      }
      const oldest = ids[0];
      if (oldest !== undefined) seenOldestIds.push(oldest);
      // Fetched older edge must remain in the window (trim newest, not oldest).
      expect(view.entries[0]?.id).toBe(oldest);
    }

    // Multiple older pages remain reachable — oldest edge keeps moving back.
    expect(seenOldestIds.length).toBeGreaterThan(1);
    expect(seenOldestIds.at(-1)).not.toBe(seenOldestIds[0]);
    const afterOlder = overlay.view()._unsafeUnwrap();
    expect(afterOlder.entries.length).toBe(windowCap);
    expect(afterOlder.hasNewer).toBe(true);
    expect(afterOlder.newerCursor).toBeDefined();
    expect(afterOlder.liveTail).toBe(false);
    // Anchor from the first page's oldest edge stays when still retained, else
    // the viewport stays on a retained entry (no jump to live tip).
    expect(afterOlder.liveTail).toBe(false);
    expect(afterOlder.scrollOffset).toBeGreaterThan(0);

    // Walk newer pages back toward the tip without dupes/gaps; live-tail
    // resumes only once the true newest edge is restored.
    let guard = 0;
    let tip = afterOlder;
    while (tip.hasNewer && tip.newerCursor !== undefined && guard < 20) {
      tip = (await overlay.loadNewer())._unsafeUnwrap();
      guard += 1;
      const ids = tip.entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (let i = 1; i < ids.length; i += 1) {
        const prev = Number(ids[i - 1]?.slice(1));
        const next = Number(ids[i]?.slice(1));
        expect(next).toBe(prev + 1);
      }
      expect(tip.entries.length).toBeLessThanOrEqual(windowCap);
    }
    expect(tip.hasNewer).toBe(false);
    expect(tip.entries.at(-1)?.id).toBe(`e${total - 1}`);
    // End / live-tail path: follow output at the newest edge.
    const followed = overlay.setScrollOffset(0)._unsafeUnwrap();
    expect(followed.liveTail).toBe(true);
    expect(followed.scrollOffset).toBe(0);
  });

  it("keeps a scroll anchor stable across older-page overflow", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "anchor-1", entries: entries(160) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 25,
      windowCap: 60,
    });
    await mustOpen(overlay, "anchor-1");
    // Fill toward the cap, then pin near the oldest edge (survives newest trim).
    await overlay.loadOlder();
    await overlay.loadOlder();
    const filled = overlay.view()._unsafeUnwrap();
    expect(filled.entries.length).toBe(60);
    const pinned = overlay
      .setScrollOffset(filled.entries.length - 5)
      ._unsafeUnwrap();
    const anchorId = pinned.anchor?.entryId;
    expect(anchorId).toBeDefined();
    expect(pinned.liveTail).toBe(false);

    // One more older page overflows the cap by trimming the newest tail only.
    const after = (await overlay.loadOlder())._unsafeUnwrap();
    expect(after.entries.length).toBe(60);
    expect(after.entries.some((entry) => entry.id === anchorId)).toBe(true);
    expect(after.anchor?.entryId).toBe(anchorId);
    expect(after.liveTail).toBe(false);
    expect(after.hasNewer).toBe(true);
    // Window slid older: first id is below the previous oldest edge.
    expect(Number(after.entries[0]?.id.slice(1))).toBeLessThan(
      Number(filled.entries[0]?.id.slice(1)),
    );
  });

  it("hard-caps the retained window and dedups stable entry ids", async () => {
    const duplicated = entries(30);
    duplicated.push({
      id: "e29",
      payload: message("e29", "assistant", "duplicate"),
    });
    const source = createMemoryChildOverlaySource([
      child({ childId: "cap-1", entries: duplicated }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 40,
      windowCap: 25,
    });
    const view = await mustOpen(overlay, "cap-1");
    expect(view.entries.length).toBeLessThanOrEqual(25);
    const ids = view.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("merges matches from every scanned page, not just the first page with a hit", async () => {
    // Markers sit on the newest page and on two older pages. Stopping at the
    // first page that contains a hit reported only the newest-page match and
    // made `n` / `N` navigation skip every older one.
    const marked = entries(100).map((entry, index) =>
      index === 95 || index === 85 || index === 62
        ? { id: entry.id, payload: message(entry.id, "user", "needle-token") }
        : entry,
    );
    const source = createMemoryChildOverlaySource([
      child({ childId: "search-pages", entries: marked }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      maxSearchPages: 3,
      windowCap: 25,
    });
    const opened = await mustOpen(overlay, "search-pages");
    // The newest page (e90..e99) holds exactly one marker.
    expect(
      opened.entries.filter((entry) => entry.text.includes("needle-token"))
        .length,
    ).toBe(1);

    const found = (await overlay.search("needle-token"))._unsafeUnwrap();
    // Three older pages reach e60..e89, so e85 and e62 join e95.
    expect(found.searchMatches).toEqual(["e62", "e85", "e95"]);
    expect(new Set(found.searchMatches).size).toBe(found.searchMatches.length);
    // The window cap trimmed the newest entries, but trimmed matches still
    // count: the reported total is the real total, not the visible one.
    expect(found.entries.length).toBeLessThanOrEqual(25);
    expect(
      found.entries.filter((entry) => entry.text.includes("needle-token"))
        .length,
    ).toBeLessThan(found.searchMatches.length);
  });

  it("searches loaded entries and fetches a bounded number of older pages", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "search-1", entries: entries(100) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      maxSearchPages: 3,
    });
    await mustOpen(overlay, "search-1");
    // Needle must sit within maxSearchPages of the newest page (contiguous).
    const found = (await overlay.search("e-text-65"))._unsafeUnwrap();
    expect(found.searchQuery).toBe("e-text-65");
    expect(found.searchMatches.length).toBeGreaterThan(0);
    expect(found.entries.length).toBeLessThanOrEqual(10 + 10 * 3);

    const beforeMiss = found.entries.length;
    const miss = (
      await overlay.search("never-present-token-zz")
    )._unsafeUnwrap();
    expect(miss.searchMatches).toEqual([]);
    // One search call fetches at most maxSearchPages additional older pages.
    expect(miss.entries.length).toBeLessThanOrEqual(beforeMiss + 10 * 3);
    expect(miss.entries.length).toBeLessThanOrEqual(
      CHILD_OVERLAY_BOUNDS.maxWindowCap,
    );
  });

  it("disables live-tail on manual scroll and re-enables at the bottom", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "tail-1",
        status: "live",
        generationId: "g1",
        entries: entries(30),
      }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    await mustOpen(overlay, "tail-1");
    const scrolled = overlay.setScrollOffset(5)._unsafeUnwrap();
    expect(scrolled.liveTail).toBe(false);
    const bottom = overlay.setScrollOffset(0)._unsafeUnwrap();
    expect(bottom.liveTail).toBe(true);

    await overlay.handleInput("\x1b[5~"); // page up
    expect(overlay.view()._unsafeUnwrap().liveTail).toBe(false);
    await overlay.handleInput("\x1b[F"); // end
    expect(overlay.view()._unsafeUnwrap().liveTail).toBe(true);
  });

  it("preserves a logical anchor across resize", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "resize-1", entries: entries(40) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    await mustOpen(overlay, "resize-1");
    overlay.setScrollOffset(4)._unsafeUnwrap();
    const before = overlay.view()._unsafeUnwrap();
    const anchorId = before.anchor?.entryId;
    expect(anchorId).toBeDefined();
    const resized = overlay.resize(120, 40)._unsafeUnwrap();
    expect(resized.anchor?.entryId).toBe(anchorId);
    expect(resized.width).toBe(120);
    expect(resized.height).toBe(40);
  });

  it("toggles global expansion across all loaded entries", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "exp-1", entries: entries(12) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 12 });
    await mustOpen(overlay, "exp-1");
    const expanded = overlay.toggleGlobalExpansion()._unsafeUnwrap();
    expect(expanded.globalExpanded).toBe(true);
    expect(expanded.entries.every((entry) => entry.expanded)).toBe(true);
    const collapsed = overlay.toggleGlobalExpansion()._unsafeUnwrap();
    expect(collapsed.globalExpanded).toBe(false);
    expect(collapsed.entries.every((entry) => !entry.expanded)).toBe(true);
  });

  it("navigates runs and branches from divider metadata", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "nav-1",
        entries: entries(8),
        runs: [
          { run: 1, action: "start" },
          { run: 2, action: "retry" },
          { run: 3, action: "continue" },
        ],
        branchIds: ["main", "alt"],
      }),
    ]);
    const overlay = createChildOverlayController(source);
    await mustOpen(overlay, "nav-1");
    expect(overlay.view()._unsafeUnwrap().activeRun).toBe(3);
    expect(overlay.navigateRun(-1)._unsafeUnwrap().activeRun).toBe(2);
    expect(overlay.navigateBranch(1)._unsafeUnwrap().activeBranchId).toBe(
      "alt",
    );
  });

  it("emits steer and follow-up only for an active live child", async () => {
    const steers: string[] = [];
    const followUps: string[] = [];
    const mutations: ChildOverlayMutationPort = {
      steer: (childId, _generationId, text) => {
        steers.push(`${childId}:${text}`);
        return okAsync(undefined);
      },
      followUp: (childId, _generationId, text) => {
        followUps.push(`${childId}:${text}`);
        return okAsync(undefined);
      },
    };
    const source = createMemoryChildOverlaySource([
      child({
        childId: "active-1",
        status: "live",
        generationId: "gen-a",
        entries: entries(4),
      }),
    ]);
    const overlay = createChildOverlayController(source, {}, mutations);
    await mustOpen(overlay, "active-1");
    overlay.updateDraft("steer please")._unsafeUnwrap();
    const steered = (await overlay.handleInput("\r"))._unsafeUnwrap();
    expect(steered.kind).toBe("steer");
    expect(steers).toEqual(["active-1:steer please"]);

    overlay.updateDraft("follow later")._unsafeUnwrap();
    const follow = (await overlay.handleInput("\x1b\r"))._unsafeUnwrap();
    expect(follow.kind).toBe("follow-up");
    expect(followUps).toEqual(["active-1:follow later"]);
  });

  it("treats settled and orphan children as read-only with no mutations", async () => {
    const steers: string[] = [];
    const mutations: ChildOverlayMutationPort = {
      steer: (_c, _g, text) => {
        steers.push(text);
        return okAsync(undefined);
      },
      followUp: (_c, _g, text) => {
        steers.push(text);
        return okAsync(undefined);
      },
    };
    const source = createMemoryChildOverlaySource([
      child({
        childId: "settled-1",
        status: "settled",
        generationId: "gen-s",
        entries: entries(3),
      }),
      child({
        childId: "orphan-1",
        status: "orphan",
        generationId: "gen-o",
        entries: entries(3, "o"),
      }),
    ]);
    const overlay = createChildOverlayController(source, {}, mutations);
    await mustOpen(overlay, "settled-1");
    overlay.updateDraft("nope")._unsafeUnwrap();
    expect(overlay.view()._unsafeUnwrap().draft).toBe("");
    const settledEnter = (await overlay.handleInput("\r"))._unsafeUnwrap();
    expect(settledEnter.kind).toBe("consumed");
    expect(steers).toEqual([]);

    await mustOpen(overlay, "orphan-1");
    expect(overlay.view()._unsafeUnwrap().readOnly).toBe(true);
    const orphanEnter = (await overlay.handleInput("\r"))._unsafeUnwrap();
    expect(orphanEnter.kind).toBe("consumed");
    expect(steers).toEqual([]);
  });

  it("consumes all keys while mounted and never routes to a primary editor", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "keys-1",
        status: "live",
        generationId: "gen-k",
        entries: entries(5),
      }),
    ]);
    const overlay = createChildOverlayController(source);
    await mustOpen(overlay, "keys-1");
    const outcomes = [];
    for (const key of ["a", "b", "\x1b[A", "\x1b", "/", "hello"]) {
      outcomes.push((await overlay.handleInput(key))._unsafeUnwrap().kind);
    }
    expect(outcomes.every((kind) => kind !== undefined)).toBe(true);
    // No outcome kind exists for primary-editor forwarding.
    expect(outcomes.every((kind) => kind !== "host-default")).toBe(true);
    expect(JSON.stringify(outcomes)).not.toContain("primary");
  });

  it("preserves draft and scroll per child across one-instance swaps", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "a",
        status: "live",
        generationId: "ga",
        entries: entries(20, "a"),
      }),
      child({
        childId: "b",
        status: "live",
        generationId: "gb",
        entries: entries(20, "b"),
      }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    await mustOpen(overlay, "a");
    overlay.updateDraft("draft-a")._unsafeUnwrap();
    overlay.setScrollOffset(3)._unsafeUnwrap();

    await mustOpen(overlay, "b");
    expect(overlay.currentChildId()).toBe("b");
    expect(overlay.isOpen()).toBe(true);
    expect(overlay.view()._unsafeUnwrap().draft).toBe("");

    await mustOpen(overlay, "a");
    const restored = overlay.view()._unsafeUnwrap();
    expect(restored.draft).toBe("draft-a");
    expect(restored.scrollOffset).toBe(3);
  });

  it("evicts least-recently-used child state beyond the LRU bound", async () => {
    const children = Array.from({ length: 10 }, (_, i) =>
      child({
        childId: `c${i}`,
        status: "live",
        generationId: `g${i}`,
        entries: entries(4, `c${i}`),
      }),
    );
    const source = createMemoryChildOverlaySource(children);
    const overlay = createChildOverlayController(source, {
      maxLruChildren: 3,
      pageSize: 4,
    });
    for (const item of children.slice(0, 3)) {
      await mustOpen(overlay, item.childId);
      overlay.updateDraft(`draft-${item.childId}`)._unsafeUnwrap();
    }
    // Opening c3..c5 should evict c0 (LRU capacity 3).
    for (const item of children.slice(3, 6)) {
      await mustOpen(overlay, item.childId);
      overlay.updateDraft(`draft-${item.childId}`)._unsafeUnwrap();
    }
    await mustOpen(overlay, "c0");
    expect(overlay.view()._unsafeUnwrap().draft).toBe("");
    await mustOpen(overlay, "c5");
    expect(overlay.view()._unsafeUnwrap().draft).toBe("draft-c5");
  });

  it("reports nested hierarchy metadata on the open child", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "parent",
        entries: entries(3, "p"),
        descendantChildIds: ["child", "grandchild"],
      }),
      child({
        childId: "child",
        parentChildId: "parent",
        entries: entries(3, "c"),
        descendantChildIds: ["grandchild"],
      }),
    ]);
    const overlay = createChildOverlayController(source);
    const view = await mustOpen(overlay, "child");
    expect(view.child.parentChildId).toBe("parent");
    expect(view.child.descendantChildIds).toContain("grandchild");
  });

  it("returns fallback-required with bounded metadata and no path leakage", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "fb-1", entries: entries(5) }),
    ]);
    const overlay = createChildOverlayController(source);
    await mustOpen(overlay, "fb-1");
    const fallback = overlay.requireFallback("render-failed");
    expect(fallback.kind).toBe("fallback-required");
    expect(fallback.metadata.childId).toBe("fb-1");
    expect(fallback.metadata.reason).toBe("render-failed");
    expect(fallback.transcript.entries.length).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(fallback);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("session.jsonl");
    expect(serialized).not.toContain("Error:");
  });

  it("triggers fallback-required when the source fails on open", async () => {
    const source = createMemoryChildOverlaySource([]);
    const overlay = createChildOverlayController(source);
    const result = await overlay.open("missing-child");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ChildOverlayFallbackRequired;
    expect(error.kind).toBe("fallback-required");
    expect(error.metadata.reason).toBe("describe-failed");
    // Task 20(c): the fallback must also name which source error caused it,
    // so a live run can distinguish an unknown child from an absent source.
    expect(error.metadata.sourceErrorType).toBe("ChildNotFound");
    expect(JSON.stringify(error)).not.toContain("/Users/");
  });

  it.each([
    ["SourceUnavailable"],
    ["SourceCorrupt"],
    ["SourceStartupNotReady"],
  ] as const)("carries the %s describe failure into bounded fallback metadata", async (type) => {
    const source: ChildOverlaySourcePort = {
      describe: () => errAsync({ type, operation: "describe" }),
      loadNewest: () => errAsync({ type, operation: "loadNewest" }),
      loadOlder: () => errAsync({ type, operation: "loadOlder" }),
      loadNewer: () => errAsync({ type, operation: "loadNewer" }),
    };
    const overlay = createChildOverlayController(source);
    const result = await overlay.open("describe-failure");
    const error = result._unsafeUnwrapErr() as ChildOverlayFallbackRequired;
    expect(error.kind).toBe("fallback-required");
    expect(error.metadata.reason).toBe("describe-failed");
    expect(error.metadata.sourceErrorType).toBe(type);
    // Only the discriminant crosses over: never `operation` or a path.
    expect(JSON.stringify(error)).not.toContain('describe"');
    expect(JSON.stringify(error)).not.toContain("/Users/");
  });

  it("opens a live child on an empty native page while its source is still starting up", async () => {
    const source = failingNewestSource(
      [
        child({
          childId: "live-starting",
          status: "live",
          generationId: "gen-live",
          entries: entries(4, "hist"),
        }),
      ],
      { type: "SourceStartupNotReady", operation: "loadNewest" },
    );
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const opened = await mustOpen(overlay, "live-starting");
    expect(opened.child.status).toBe("live");
    expect(opened.readOnly).toBe(false);
    expect(opened.entries).toEqual([]);
    expect(opened.liveTail).toBe(true);
    expect(opened.hasOlder).toBe(false);
    expect(opened.hasNewer).toBe(false);

    const after = overlay.applyLiveEvent({
      type: "message_update",
      delta: {
        messageId: "msg-live-empty",
        text: "live-tail-after-empty-open",
      },
    });
    expect(after.isOk()).toBe(true);
    const view = after._unsafeUnwrap();
    expect(
      view.entries.some((entry) =>
        entry.text.includes("live-tail-after-empty-open"),
      ),
    ).toBe(true);
    expect(view.liveTail).toBe(true);
  });

  it.each([
    ["SourceCorrupt", { type: "SourceCorrupt", operation: "loadNewest" }],
    [
      "SourceUnavailable",
      { type: "SourceUnavailable", operation: "loadNewest" },
    ],
    [
      "SourceInvalidCursor",
      { type: "SourceInvalidCursor", operation: "loadNewest" },
    ],
    ["ChildNotFound", { type: "ChildNotFound", childId: "live-hard-failure" }],
  ] as const)("keeps a live child fail-closed when the initial source fails with %s", async (_label, sourceError) => {
    // Permission errors, root violations, malformed headers, parent
    // mismatch, and corruption all reach the controller as one of these
    // errors. None of them is a startup race, so none may open an empty
    // page.
    const source = failingNewestSource(
      [
        child({
          childId: "live-hard-failure",
          status: "live",
          generationId: "gen-live",
          entries: entries(3, "hist"),
        }),
      ],
      sourceError,
    );
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const result = await overlay.open("live-hard-failure");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ChildOverlayFallbackRequired;
    expect(error.kind).toBe("fallback-required");
    expect(error.metadata.reason).toBe("source-failed");
    expect(error.metadata.childId).toBe("live-hard-failure");
    expect(JSON.stringify(error)).not.toContain("/Users/");
  });

  it.each([
    "settled",
    "orphan",
  ] as const)("keeps a %s child fail-closed even when its source is startup-not-ready", async (status) => {
    const source = failingNewestSource(
      [
        child({
          childId: "non-live-starting",
          status,
          entries: entries(3, "s"),
        }),
      ],
      { type: "SourceStartupNotReady", operation: "loadNewest" },
    );
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const result = await overlay.open("non-live-starting");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ChildOverlayFallbackRequired;
    expect(error.kind).toBe("fallback-required");
    // `settled` fails at the page read; `orphaned`/`unknown` are rejected
    // earlier by the memory source's describe. Both stay fail-closed.
    expect(["source-failed", "describe-failed"]).toContain(
      error.metadata.reason,
    );
    expect(error.metadata.childId).toBe("non-live-starting");
    expect(JSON.stringify(error)).not.toContain("/Users/");
  });

  it("keeps settled children fail-closed when the initial source is unreadable", async () => {
    const source = failingNewestSource(
      [
        child({
          childId: "settled-unreadable",
          status: "settled",
          entries: entries(3, "s"),
        }),
      ],
      { type: "SourceCorrupt", operation: "loadNewest" },
    );
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const result = await overlay.open("settled-unreadable");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ChildOverlayFallbackRequired;
    expect(error.kind).toBe("fallback-required");
    expect(error.metadata.reason).toBe("source-failed");
    expect(error.metadata.childId).toBe("settled-unreadable");
    expect(JSON.stringify(error)).not.toContain("/Users/");
  });

  it("adapts Task 4 readSessionEntryPage through the paged source helper", async () => {
    const hostEntries = Object.freeze([
      message("n0", "user", "from-native"),
      message("n1", "assistant", "reply"),
      runDivider("n2", 2, "continue"),
    ]);
    const source = createReadSessionEntryPageOverlaySource({
      describe: (childId) =>
        okAsync({
          childId,
          threadId: childId,
          status: "settled" as const,
          runs: [{ run: 1, action: "start" as const }],
          branchIds: ["main"],
          descendantChildIds: [],
        }),
      readSessionEntryPage: (_childId, options) =>
        okAsync(pageMemoryEntries(hostEntries, options)),
    });
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const view = await mustOpen(overlay, "native-1");
    expect(view.entries.some((entry) => entry.text === "from-native")).toBe(
      true,
    );
    expect(view.entries.some((entry) => entry.kind === "run-divider")).toBe(
      true,
    );
  });

  it("maps a missing native session to a startup-not-ready source error", async () => {
    const source = createReadSessionEntryPageOverlaySource({
      describe: (childId) =>
        okAsync({
          childId,
          threadId: childId,
          status: "live" as const,
          runs: [{ run: 1, action: "start" as const }],
          branchIds: ["main"],
          descendantChildIds: [],
        }),
      readSessionEntryPage: (childId) =>
        errAsync({ type: "SessionMissing" as const, ref: childId }),
    });
    const page = await source.loadNewest("native-missing", 10);
    expect(page.isErr()).toBe(true);
    expect(page._unsafeUnwrapErr()).toEqual({
      type: "SourceStartupNotReady",
      operation: "loadNewest",
    });
  });

  it.each([
    [
      "SessionPermissionError",
      { type: "SessionPermissionError", kind: "file" },
    ],
    [
      "SessionRootViolation",
      { type: "SessionRootViolation", reason: "path-escape" },
    ],
    [
      "SessionCorrupt/missing-header",
      {
        type: "SessionCorrupt",
        ref: "native-hard",
        reason: "missing-header",
      },
    ],
    [
      "SessionCorrupt/parent-session-mismatch",
      {
        type: "SessionCorrupt",
        ref: "native-hard",
        reason: "parent-session-mismatch",
      },
    ],
    [
      "SessionCorrupt/unreadable",
      { type: "SessionCorrupt", ref: "native-hard", reason: "unreadable" },
    ],
  ] as const)("maps native %s to a fail-closed corrupt source error", async (_label, nativeError) => {
    const source = createReadSessionEntryPageOverlaySource({
      describe: (childId) =>
        okAsync({
          childId,
          threadId: childId,
          status: "live" as const,
          runs: [{ run: 1, action: "start" as const }],
          branchIds: ["main"],
          descendantChildIds: [],
        }),
      readSessionEntryPage: () =>
        errAsync<PiNativeSessionEntryPage, PiNativeSessionError>(nativeError),
    });
    const page = await source.loadNewest("native-hard", 10);
    expect(page.isErr()).toBe(true);
    expect(page._unsafeUnwrapErr()).toEqual({
      type: "SourceCorrupt",
      operation: "loadNewest",
    });
  });

  it("pages >10k native source with bounded metrics and no full materialization", async () => {
    const entryCount = 10_500;
    const ROOT = "/data/weave/adapters/pi/sessions";
    const PARENT = "parent-session-1";
    const REF = "child-1/session.jsonl";
    const DIR = `${ROOT}/child-1`;
    const FILE = "session.jsonl";
    const textEncoder = new TextEncoder();
    const fs = new MemoryPiNativeSessionFs();
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "native-session-1",
        cwd: "/repo",
        parentSession: PARENT,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ];
    for (let index = 0; index < entryCount; index += 1) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "assistant", content: `n=${index}` },
        }),
      );
    }
    const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
    (
      await directory.appendFile(
        FILE,
        textEncoder.encode(`${lines.join("\n")}\n`),
        0o600,
      )
    )._unsafeUnwrap();
    directory.close();

    class ForbiddenHost implements PiNativeSessionHostPort {
      create(): PiNativeSessionHandle {
        throw new Error("host.create must not be called");
      }
      open(): PiNativeSessionHandle {
        throw new Error("host.open must not be called");
      }
    }
    const store = new PiNativeSessionStore({
      root: ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host: new ForbiddenHost(),
    });

    const metrics: Array<{
      readonly entries: number;
      readonly bytesRead: number;
      readonly linesScanned: number;
    }> = [];
    let maxEntriesReturned = 0;
    const source = createReadSessionEntryPageOverlaySource({
      describe: (childId) =>
        okAsync({
          childId,
          threadId: childId,
          status: "settled" as const,
          runs: [],
          branchIds: [],
          descendantChildIds: [],
        }),
      readSessionEntryPage: (_childId, options) =>
        store.readSessionEntryPage(REF, PARENT, options).map((page) => {
          metrics.push({
            entries: page.entries.length,
            bytesRead: page.bytesRead,
            linesScanned: page.linesScanned,
          });
          maxEntriesReturned = Math.max(
            maxEntriesReturned,
            page.entries.length,
          );
          return page;
        }),
    });

    const newest = (await source.loadNewest("big-hist", 40))._unsafeUnwrap();
    expect(newest.entries.length).toBeLessThanOrEqual(40);
    expect(newest.hasOlder).toBe(true);
    expect(
      newest.entries.some((entry) => entry.text === `n=${entryCount - 1}`),
    ).toBe(true);

    let cursor = newest.olderCursor;
    let sawOlderWindow = false;
    const targetOlder = `n=${entryCount - 200}`;
    for (let step = 0; step < 8 && cursor !== undefined; step += 1) {
      const page = (
        await source.loadOlder("big-hist", cursor, 40)
      )._unsafeUnwrap();
      expect(page.entries.length).toBeLessThanOrEqual(40);
      if (page.entries.some((entry) => entry.text === targetOlder)) {
        sawOlderWindow = true;
      }
      if (page.newerCursor !== undefined) {
        const newer = (
          await source.loadNewer("big-hist", page.newerCursor, 40)
        )._unsafeUnwrap();
        expect(newer.entries.length).toBeLessThanOrEqual(40);
      }
      cursor = page.olderCursor;
    }
    expect(sawOlderWindow).toBe(true);

    const overlay = createChildOverlayController(source, {
      pageSize: 40,
      windowCap: 120,
      maxSearchPages: 3,
    });
    await mustOpen(overlay, "big-hist");
    const beforeSearch = metrics.length;
    await overlay.search("n=5");
    const searchCalls = metrics.length - beforeSearch;
    expect(searchCalls).toBeLessThanOrEqual(3);

    expect(maxEntriesReturned).toBeLessThanOrEqual(
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLimit,
    );
    for (const sample of metrics) {
      expect(sample.entries).toBeLessThanOrEqual(
        PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLimit,
      );
      expect(sample.bytesRead).toBeLessThanOrEqual(
        PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned,
      );
      expect(sample.linesScanned).toBeLessThanOrEqual(
        PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLinesScanned,
      );
      // Never materializes the full >10k source in one page.
      expect(sample.entries).toBeLessThan(entryCount);
    }
    expect(overlay.view()._unsafeUnwrap().entries.length).toBeLessThanOrEqual(
      120,
    );
    expect(
      JSON.stringify(
        overlay
          .view()
          ._unsafeUnwrap()
          .entries.map((e) => e.id),
      ),
    ).not.toContain("/Users/");
  });

  it("rejects invalid overlay cursors without a full read", async () => {
    let calls = 0;
    const source = createReadSessionEntryPageOverlaySource({
      describe: (childId) =>
        okAsync({
          childId,
          threadId: childId,
          status: "settled" as const,
          runs: [],
          branchIds: [],
          descendantChildIds: [],
        }),
      readSessionEntryPage: () => {
        calls += 1;
        return errAsync({
          type: "SessionCorrupt",
          ref: "x",
          reason: "invalid-cursor",
        } satisfies PiNativeSessionError);
      },
    });
    const older = await source.loadOlder("c1", "", 10);
    expect(older.isErr()).toBe(true);
    expect(older._unsafeUnwrapErr().type).toBe("SourceInvalidCursor");
    expect(calls).toBe(0);
  });

  it("preserves Task 4 opaque cursors across overlay window trimming both ways", async () => {
    const entryCount = 120;
    const pageSize = 20;
    const windowCap = 50;
    const ROOT = "/data/weave/adapters/pi/sessions";
    const PARENT = "parent-session-trim";
    const REF = "child-trim/session.jsonl";
    const DIR = `${ROOT}/child-trim`;
    const FILE = "session.jsonl";
    const textEncoder = new TextEncoder();
    const fs = new MemoryPiNativeSessionFs();
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "native-session-trim",
        cwd: "/repo",
        parentSession: PARENT,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ];
    for (let index = 0; index < entryCount; index += 1) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "assistant", content: `n=${index}` },
        }),
      );
    }
    const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
    (
      await directory.appendFile(
        FILE,
        textEncoder.encode(`${lines.join("\n")}\n`),
        0o600,
      )
    )._unsafeUnwrap();
    directory.close();

    class ForbiddenHost implements PiNativeSessionHostPort {
      create(): PiNativeSessionHandle {
        throw new Error("host.create must not be called");
      }
      open(): PiNativeSessionHandle {
        throw new Error("host.open must not be called");
      }
    }
    const store = new PiNativeSessionStore({
      root: ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host: new ForbiddenHost(),
    });

    const source = createReadSessionEntryPageOverlaySource({
      describe: (childId) =>
        okAsync({
          childId,
          threadId: childId,
          status: "settled" as const,
          runs: [],
          branchIds: ["main"],
          descendantChildIds: [],
        }),
      readSessionEntryPage: (_childId, options) =>
        store.readSessionEntryPage(REF, PARENT, options),
    });

    const assertContiguousNoGapsOrDups = (view: ChildOverlayView): void => {
      const ids = view.entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
      const indexes = ids.map((id) => {
        expect(id.startsWith("entry-")).toBe(true);
        return Number(id.slice("entry-".length));
      });
      for (let i = 1; i < indexes.length; i += 1) {
        expect(indexes[i]).toBe((indexes[i - 1] ?? 0) + 1);
      }
    };

    const assertOpaqueCursor = (
      cursor: string | undefined,
      retainedIds: readonly string[],
    ): void => {
      expect(cursor).toBeDefined();
      expect(typeof cursor).toBe("string");
      expect(retainedIds.includes(cursor as string)).toBe(false);
    };

    // --- older trim then load newer back ---
    const overlayOlder = createChildOverlayController(source, {
      pageSize,
      windowCap,
    });
    await mustOpen(overlayOlder, "trim-older");
    // Fill the window to the cap with contiguous older pages.
    for (let step = 0; step < 4; step += 1) {
      const filled = (await overlayOlder.loadOlder())._unsafeUnwrap();
      expect(filled.entries.length).toBeLessThanOrEqual(windowCap);
      assertContiguousNoGapsOrDups(filled);
    }
    const atCap = overlayOlder.view()._unsafeUnwrap();
    expect(atCap.entries.length).toBe(windowCap);
    overlayOlder
      .setScrollOffset(Math.max(0, atCap.entries.length - 3))
      ._unsafeUnwrap();
    const pinnedOlder = overlayOlder.view()._unsafeUnwrap();
    const anchorOlder = pinnedOlder.anchor?.entryId;
    expect(anchorOlder).toBeDefined();

    const afterOlderTrim = (await overlayOlder.loadOlder())._unsafeUnwrap();
    expect(afterOlderTrim.entries.length).toBe(windowCap);
    expect(afterOlderTrim.hasNewer).toBe(true);
    assertOpaqueCursor(
      afterOlderTrim.newerCursor,
      afterOlderTrim.entries.map((entry) => entry.id),
    );
    expect(afterOlderTrim.anchor?.entryId).toBe(anchorOlder);
    assertContiguousNoGapsOrDups(afterOlderTrim);

    let newerWalk = afterOlderTrim;
    let newerGuard = 0;
    const tipText = `n=${entryCount - 1}`;
    while (
      newerWalk.hasNewer &&
      newerWalk.newerCursor !== undefined &&
      newerGuard < 30
    ) {
      const next = await overlayOlder.loadNewer();
      expect(next.isOk()).toBe(true);
      newerWalk = next._unsafeUnwrap();
      assertContiguousNoGapsOrDups(newerWalk);
      expect(newerWalk.entries.length).toBeLessThanOrEqual(windowCap);
      newerGuard += 1;
    }
    expect(newerWalk.entries.some((entry) => entry.text === tipText)).toBe(
      true,
    );

    // --- inverse: newer trim then load older back ---
    const overlayNewer = createChildOverlayController(source, {
      pageSize,
      windowCap,
    });
    await mustOpen(overlayNewer, "trim-newer");
    // Walk to the oldest edge first so append+trim has older content to drop.
    for (let step = 0; step < 8; step += 1) {
      const view = overlayNewer.view()._unsafeUnwrap();
      if (!view.hasOlder || view.olderCursor === undefined) break;
      (await overlayNewer.loadOlder())._unsafeUnwrap();
    }
    const oldestEdge = overlayNewer.view()._unsafeUnwrap();
    expect(oldestEdge.hasNewer).toBe(true);
    // Pin near the newest retained edge so append+oldest trim keeps the anchor.
    overlayNewer.setScrollOffset(2)._unsafeUnwrap();
    const pinnedNewer = overlayNewer.view()._unsafeUnwrap();
    const anchorNewer = pinnedNewer.anchor?.entryId;
    expect(anchorNewer).toBeDefined();

    // Load newer until the window trims oldest entries.
    let afterNewerTrim = pinnedNewer;
    let trimmedOldest = false;
    for (let step = 0; step < 12; step += 1) {
      if (
        !afterNewerTrim.hasNewer ||
        afterNewerTrim.newerCursor === undefined
      ) {
        break;
      }
      const beforeOldest = afterNewerTrim.entries[0]?.id;
      const next = await overlayNewer.loadNewer();
      expect(next.isOk()).toBe(true);
      afterNewerTrim = next._unsafeUnwrap();
      assertContiguousNoGapsOrDups(afterNewerTrim);
      expect(afterNewerTrim.entries.length).toBeLessThanOrEqual(windowCap);
      if (
        beforeOldest !== undefined &&
        !afterNewerTrim.entries.some((entry) => entry.id === beforeOldest)
      ) {
        trimmedOldest = true;
        assertOpaqueCursor(
          afterNewerTrim.olderCursor,
          afterNewerTrim.entries.map((entry) => entry.id),
        );
        expect(afterNewerTrim.hasOlder).toBe(true);
        break;
      }
    }
    expect(trimmedOldest).toBe(true);
    expect(
      afterNewerTrim.entries.some((entry) => entry.id === anchorNewer),
    ).toBe(true);
    expect(afterNewerTrim.anchor?.entryId).toBe(anchorNewer);

    let olderWalk = afterNewerTrim;
    let olderGuard = 0;
    const oldestSeen = new Set<string>();
    while (
      olderWalk.hasOlder &&
      olderWalk.olderCursor !== undefined &&
      olderGuard < 30
    ) {
      const next = await overlayNewer.loadOlder();
      expect(next.isOk()).toBe(true);
      olderWalk = next._unsafeUnwrap();
      assertContiguousNoGapsOrDups(olderWalk);
      expect(olderWalk.entries.length).toBeLessThanOrEqual(windowCap);
      const oldest = olderWalk.entries[0]?.id;
      if (oldest !== undefined) oldestSeen.add(oldest);
      olderGuard += 1;
    }
    expect(oldestSeen.size).toBeGreaterThan(0);
    expect(olderWalk.entries.some((entry) => entry.text === "n=0")).toBe(true);
  });

  it("preserves opposite overlay cursors when a page does not trim", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "no-trim", entries: entries(80) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      windowCap: 60,
    });
    const opened = await mustOpen(overlay, "no-trim");
    const newerBeforeOlder = opened.newerCursor;
    const olderBeforeOlder = opened.olderCursor;
    const afterOlder = (await overlay.loadOlder())._unsafeUnwrap();
    // Window still under cap — newer cursor must stay untouched.
    expect(afterOlder.entries.length).toBe(20);
    expect(afterOlder.newerCursor).toBe(newerBeforeOlder);
    expect(afterOlder.olderCursor).not.toBe(olderBeforeOlder);

    // Reach the tip again with room remaining, then append without trimming:
    // older cursor must stay when the newest page fits under the cap.
    const wide = createChildOverlayController(source, {
      pageSize: 15,
      windowCap: 40,
    });
    await mustOpen(wide, "no-trim");
    (await wide.loadOlder())._unsafeUnwrap();
    (await wide.loadOlder())._unsafeUnwrap();
    const trimmed = (await wide.loadOlder())._unsafeUnwrap();
    expect(trimmed.entries.length).toBe(40);
    expect(trimmed.hasNewer).toBe(true);
    // Grow capacity by opening a fresh controller that starts near the tip with
    // spare room, then append a small newer page that does not drop oldest.
    const spare = createChildOverlayController(source, {
      pageSize: 10,
      windowCap: 50,
    });
    await mustOpen(spare, "no-trim");
    const afterOneOlder = (await spare.loadOlder())._unsafeUnwrap();
    expect(afterOneOlder.entries.length).toBe(20);
    const olderBeforeAppend = afterOneOlder.olderCursor;
    // Still holding the tip — no newer page to append; older cursor stays put.
    expect(afterOneOlder.hasNewer).toBe(false);
    const afterNoopNewer = (await spare.loadNewer())._unsafeUnwrap();
    expect(afterNoopNewer.olderCursor).toBe(olderBeforeAppend);
    expect(afterNoopNewer.newerCursor).toBe(afterOneOlder.newerCursor);
  });

  it("keeps production overlay/extension free of full-read overlay sources", async () => {
    const overlaySrc = await Bun.file(
      new URL("../child-overlay.ts", import.meta.url),
    ).text();
    const extensionSrc = await Bun.file(
      new URL("../extension.ts", import.meta.url),
    ).text();
    expect(overlaySrc).not.toContain("createReadSessionEntriesOverlaySource");
    expect(extensionSrc).not.toContain("createReadSessionEntriesOverlaySource");
    expect(overlaySrc).toContain("createReadSessionEntryPageOverlaySource");
    expect(extensionSrc).toContain("createReadSessionEntryPageOverlaySource");
    expect(extensionSrc).toContain("readSessionEntryPage");
    // Overlay controller wiring must not call the full-read host path.
    const overlayWire = extensionSrc.slice(
      extensionSrc.indexOf("createChildOverlayController("),
      extensionSrc.indexOf("createChildOverlayController(") + 2_500,
    );
    expect(overlayWire).not.toContain("readSessionEntries");
    expect(overlayWire).toContain("readSessionEntryPage");
  });

  it("keeps one instance: open swaps content instead of stacking", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "one", entries: entries(5, "one") }),
      child({ childId: "two", entries: entries(5, "two") }),
    ]);
    const overlay = createChildOverlayController(source);
    await mustOpen(overlay, "one");
    await mustOpen(overlay, "two");
    expect(overlay.isOpen()).toBe(true);
    expect(overlay.currentChildId()).toBe("two");
    expect(
      overlay.view()._unsafeUnwrap().entries[0]?.id.startsWith("two"),
    ).toBe(true);
  });

  it("holds the manually scrolled viewport as live events extend the tail", async () => {
    // Offsets count rendered rows up from the newest row, so rows appended at
    // the tail push the anchored rows further up. Without a compensating
    // adjustment the viewport slid toward the tail and the read content left
    // the screen while the newer-lines cue stayed flat.
    const source = createMemoryChildOverlaySource([
      child({ childId: "tail", status: "live", entries: entries(30) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 30 });
    await mustOpen(overlay, "tail");
    // First render measures the rendered-row extent.
    overlay.setScrollExtent(60)._unsafeUnwrap();
    overlay.setScrollOffset(20)._unsafeUnwrap();
    const parked = overlay.view()._unsafeUnwrap();
    expect(parked.liveTail).toBe(false);
    expect(parked.scrollOffset).toBe(20);
    const anchored = parked.anchor?.entryId;
    expect(anchored).toBeDefined();

    overlay
      .applyLiveEvent({ type: "thinking", text: "new tail row" })
      ._unsafeUnwrap();
    // The controller cannot measure rows; the offset only moves once the
    // component reports the new extent.
    expect(overlay.view()._unsafeUnwrap().scrollOffset).toBe(20);

    const after = overlay.setScrollExtent(63)._unsafeUnwrap();
    // Three new rendered rows arrived below the viewport, so the offset grows
    // by the same three rows and the visible body stays put.
    expect(after.scrollOffset).toBe(23);
    expect(after.liveTail).toBe(false);
    // The anchor is refreshed for the new row offset. It is a coarse
    // entry-index projection of a row offset, so it tracks the viewport rather
    // than pinning an entry id; the component test proves the body is stable.
    expect(after.anchor?.entryId).toBeDefined();
  });

  it("coalesces many live events into one extent-delta adjustment", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "coalesce", status: "live", entries: entries(30) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 30 });
    await mustOpen(overlay, "coalesce");
    overlay.setScrollExtent(60)._unsafeUnwrap();
    overlay.setScrollOffset(20)._unsafeUnwrap();

    for (let i = 0; i < 5; i += 1) {
      overlay
        .applyLiveEvent({ type: "thinking", text: `burst-${i}` })
        ._unsafeUnwrap();
    }
    // One render, one adjustment: the delta already covers every event.
    const after = overlay.setScrollExtent(75)._unsafeUnwrap();
    expect(after.scrollOffset).toBe(35);
    // A second measurement with no new content must not move again.
    const stable = overlay.setScrollExtent(75)._unsafeUnwrap();
    expect(stable.scrollOffset).toBe(35);
    const grown = overlay.setScrollExtent(80)._unsafeUnwrap();
    expect(grown.scrollOffset).toBe(35);
  });

  it("keeps following the tail when live growth arrives at offset zero", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "follow", status: "live", entries: entries(30) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 30 });
    await mustOpen(overlay, "follow");
    overlay.setScrollExtent(60)._unsafeUnwrap();
    expect(overlay.view()._unsafeUnwrap().liveTail).toBe(true);
    overlay
      .applyLiveEvent({ type: "thinking", text: "still following" })
      ._unsafeUnwrap();
    const after = overlay.setScrollExtent(64)._unsafeUnwrap();
    expect(after.scrollOffset).toBe(0);
    expect(after.liveTail).toBe(true);
  });

  it("applies the signed delta when a live replacement shrinks the tail", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "shrink", status: "live", entries: entries(30) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 30 });
    await mustOpen(overlay, "shrink");
    overlay.setScrollExtent(60)._unsafeUnwrap();
    overlay.setScrollOffset(5)._unsafeUnwrap();
    overlay
      .applyLiveEvent({ type: "thinking", text: "replaced" })
      ._unsafeUnwrap();
    const shrunk = overlay.setScrollExtent(57)._unsafeUnwrap();
    expect(shrunk.scrollOffset).toBe(2);
    expect(shrunk.liveTail).toBe(false);

    // A shrink larger than the offset clamps at the tail and resumes follow.
    overlay
      .applyLiveEvent({ type: "thinking", text: "replaced again" })
      ._unsafeUnwrap();
    const clamped = overlay.setScrollExtent(50)._unsafeUnwrap();
    expect(clamped.scrollOffset).toBe(0);
    expect(clamped.liveTail).toBe(true);
  });

  it("does not tail-adjust for older prepends, search, or resize", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "prepend", entries: entries(80) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      windowCap: 60,
    });
    await mustOpen(overlay, "prepend");
    overlay.setScrollExtent(40)._unsafeUnwrap();
    overlay.setScrollOffset(6)._unsafeUnwrap();

    // Older page: rows land above the viewport, so the offset must not move.
    (await overlay.loadOlder())._unsafeUnwrap();
    expect(overlay.setScrollExtent(70)._unsafeUnwrap().scrollOffset).toBe(6);

    // Historical search prepends pages the same way.
    (await overlay.search("prepend-text-3"))._unsafeUnwrap();
    expect(overlay.setScrollExtent(120)._unsafeUnwrap().scrollOffset).toBe(6);

    // Re-wrap after resize changes rows everywhere; not tail growth.
    overlay.resize(40, 24)._unsafeUnwrap();
    expect(overlay.setScrollExtent(200)._unsafeUnwrap().scrollOffset).toBe(6);
  });

  it("drops a pending tail adjustment when a resize intervenes", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "resize-drop", status: "live", entries: entries(30) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 30 });
    await mustOpen(overlay, "resize-drop");
    overlay.setScrollExtent(60)._unsafeUnwrap();
    overlay.setScrollOffset(10)._unsafeUnwrap();
    overlay
      .applyLiveEvent({ type: "thinking", text: "pending" })
      ._unsafeUnwrap();
    overlay.resize(40, 24)._unsafeUnwrap();
    expect(overlay.setScrollExtent(140)._unsafeUnwrap().scrollOffset).toBe(10);
  });

  it("preserves the visible body when a newer page appends below", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "newer", entries: entries(200) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 20,
      windowCap: 50,
    });
    await mustOpen(overlay, "newer");
    // Walk back far enough that the window trims the newest side and a newer
    // page becomes fetchable again.
    for (let page = 0; page < 6; page += 1) {
      (await overlay.loadOlder())._unsafeUnwrap();
    }
    const parked = overlay.view()._unsafeUnwrap();
    expect(parked.hasNewer).toBe(true);
    overlay.setScrollExtent(60)._unsafeUnwrap();
    overlay.setScrollOffset(12)._unsafeUnwrap();

    const beforeNewestId = parked.entries.at(-1)?.id;
    let appended = parked;
    for (let step = 0; step < 6; step += 1) {
      appended = (await overlay.loadNewer())._unsafeUnwrap();
      if (appended.entries.at(-1)?.id !== beforeNewestId) break;
    }
    // The newer page really did add content below the viewport.
    expect(appended.entries.at(-1)?.id).not.toBe(beforeNewestId);
    // No measurement yet, so the offset must not have moved on its own.
    expect(overlay.view()._unsafeUnwrap().scrollOffset).toBe(12);

    const measured = overlay.setScrollExtent(70)._unsafeUnwrap();
    expect(measured.scrollOffset).toBe(22);
    expect(measured.liveTail).toBe(false);
  });

  it("exposes bounded defaults used by the controller", () => {
    expect(CHILD_OVERLAY_BOUNDS.defaultPageSize).toBe(50);
    expect(CHILD_OVERLAY_BOUNDS.defaultWindowCap).toBe(200);
    expect(CHILD_OVERLAY_BOUNDS.maxLruChildren).toBe(8);
    expect(CHILD_OVERLAY_BOUNDS.maxSearchPages).toBe(4);
  });
});

describe("createChildOverlayCustomComponent", () => {
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const mount = async (
    options: {
      readonly status?: "live" | "settled" | "orphan";
      readonly entryCount?: number;
      readonly pageSize?: number;
      readonly sourceEntries?: readonly MemoryOverlaySourceEntry[];
      readonly mutations?: ChildOverlayMutationPort;
      readonly onFallback?: (fallback: ChildOverlayFallbackRequired) => void;
    } = {},
  ) => {
    const status = options.status ?? "live";
    const source = createMemoryChildOverlaySource([
      child({
        childId: "overlay-1",
        status,
        generationId: "gen-1",
        entries: options.sourceEntries ?? entries(options.entryCount ?? 12),
        runs: [
          { run: 1, action: "start" },
          { run: 2, action: "continue" },
        ],
      }),
    ]);
    const controller = createChildOverlayController(
      source,
      { pageSize: options.pageSize ?? 10 },
      options.mutations,
    );
    await mustOpen(controller, "overlay-1");
    let closed = 0;
    const fallbacks: ChildOverlayFallbackRequired[] = [];
    let renders = 0;
    const component = createChildOverlayCustomComponent(
      {
        requestRender: () => {
          renders += 1;
        },
      } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => {
        closed += 1;
      },
      (fallback) => {
        fallbacks.push(fallback);
        options.onFallback?.(fallback);
      },
      { cwd: "/workspace" },
    );
    return {
      component,
      controller,
      closed: () => closed,
      fallbacks: () => fallbacks,
      renders: () => renders,
    };
  };

  it("renders native entry kinds with a bounded header for a live child", async () => {
    const { component, controller } = await mount({ status: "live" });
    controller.applyLiveEvent({
      type: "thinking",
      text: "pondering",
    });
    controller.applyLiveEvent({
      type: "tool_call",
      toolCallId: "tool-1",
      toolName: "read",
    });
    const lines = component.render(80);
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("LIVE");
    // Native components render content (not kind labels): thinking text + tool name.
    expect(joined).toContain("pondering");
    expect(joined).toContain("read");
    expect(joined).toContain("e-text-");
    expect(joined).not.toContain("/Users/");
  });

  it("calls resize and preserves the logical anchor across widths", async () => {
    const { component, controller } = await mount({ entryCount: 40 });
    // Scroll offsets are rendered rows, so measure the extent before scrolling.
    component.render(100);
    const extent = controller.view()._unsafeUnwrap().scrollExtent;
    controller.setScrollOffset(Math.min(4, extent))._unsafeUnwrap();
    const before = controller.view()._unsafeUnwrap().anchor?.entryId;
    expect(before).toBeDefined();
    component.render(100);
    const after = controller.view()._unsafeUnwrap();
    expect(after.anchor?.entryId).toBe(before);
    expect(after.width).toBe(98);
  });

  it("scrolls the viewport by rendered rows, not by entry count", async () => {
    // Twelve multi-line entries render far more rows than entries. Clamping the
    // offset by entry count pinned the viewport near the tail, so the oldest
    // rows stayed unreachable no matter how often PageUp was pressed.
    const tall = Array.from({ length: 12 }, (_, index) => ({
      id: `e${index}`,
      payload: message(
        `e${index}`,
        index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        Array.from(
          { length: 8 },
          (_line, line) => `entry-${index}-line-${line}`,
        ).join("\n"),
      ),
    }));
    const { component, controller } = await mount({
      status: "live",
      pageSize: 50,
      sourceEntries: tall,
    });

    const firstFrame = component.render(80).join("\n");
    expect(firstFrame).toContain("entry-11-line-7");
    expect(firstFrame).not.toContain("entry-0-line-0");
    expect(controller.view()._unsafeUnwrap().scrollExtent).toBeGreaterThan(12);

    let topFrame = "";
    for (let press = 0; press < 30; press += 1) {
      component.handleInput(PAGE_UP);
      await flush();
      topFrame = component.render(80).join("\n");
    }
    // Oldest rendered row is reachable, and the cue counts hidden rows.
    expect(topFrame).toContain("entry-0-line-0");
    const scrolled = controller.view()._unsafeUnwrap();
    expect(scrolled.liveTail).toBe(false);
    expect(scrolled.scrollOffset).toBe(scrolled.scrollExtent);
    expect(scrolled.scrollOffset).toBeGreaterThan(12);
    expect(topFrame).toContain(`${scrolled.scrollOffset} newer line(s) below`);

    // Manual scrolling holds its position across renders.
    component.render(80);
    expect(controller.view()._unsafeUnwrap().scrollOffset).toBe(
      scrolled.scrollOffset,
    );

    component.handleInput(PAGE_DOWN);
    await flush();
    const paged = component.render(80).join("\n");
    const afterPageDown = controller.view()._unsafeUnwrap();
    expect(afterPageDown.scrollOffset).toBeLessThan(scrolled.scrollOffset);
    expect(paged).toContain(
      `${afterPageDown.scrollOffset} newer line(s) below`,
    );

    for (let press = 0; press < 30; press += 1) {
      component.handleInput(PAGE_DOWN);
      await flush();
    }
    const bottomFrame = component.render(80).join("\n");
    const bottom = controller.view()._unsafeUnwrap();
    expect(bottom.scrollOffset).toBe(0);
    expect(bottom.liveTail).toBe(true);
    expect(bottomFrame).toContain("entry-11-line-7");
    expect(bottomFrame).not.toContain("newer line(s) below");

    // End returns to the live tail from anywhere in the scrollback.
    component.handleInput(PAGE_UP);
    await flush();
    expect(controller.view()._unsafeUnwrap().liveTail).toBe(false);
    component.handleInput(END);
    await flush();
    const followed = controller.view()._unsafeUnwrap();
    expect(followed.scrollOffset).toBe(0);
    expect(followed.liveTail).toBe(true);
    expect(component.render(80).join("\n")).not.toContain(
      "newer line(s) below",
    );
  });

  it("normalizes Kitty scroll presses and ignores release frames", async () => {
    const { component, controller } = await mount({
      status: "live",
      entryCount: 80,
    });
    const initial = component.render(100).join("\n");
    expect(initial).toContain("mouse wheel unavailable");

    component.handleInput("\x1b[1;2:1A");
    await flush();
    component.render(100);
    const afterPress = controller.view()._unsafeUnwrap().scrollOffset;
    expect(afterPress).toBeGreaterThan(0);

    component.handleInput("\x1b[1;2:3A");
    await flush();
    component.render(100);
    expect(controller.view()._unsafeUnwrap().scrollOffset).toBe(afterPress);

    component.handleInput("\x1b[1;2:1B");
    await flush();
    component.render(100);
    expect(controller.view()._unsafeUnwrap().scrollOffset).toBeLessThan(
      afterPress,
    );
  });

  it("keeps the rendered body stable while live rows extend the tail", async () => {
    // Manual scrollback is only useful if it holds still. Before the tail
    // adjustment, every live event grew the rendered extent while the offset
    // stayed put, so the viewport slid toward the tail and the rows the reader
    // had parked on left the screen while the newer-lines cue stayed flat.
    const tall = Array.from({ length: 14 }, (_, index) => ({
      id: `e${index}`,
      payload: message(
        `e${index}`,
        index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        Array.from(
          { length: 6 },
          (_line, line) => `entry-${index}-line-${line}`,
        ).join("\n"),
      ),
    }));
    const { component, controller } = await mount({
      status: "live",
      pageSize: 50,
      sourceEntries: tall,
    });
    const bodyRows = (frame: readonly string[]): string[] =>
      frame.filter((line) => line.includes("entry-"));

    component.render(80);
    for (let press = 0; press < 4; press += 1) {
      component.handleInput(PAGE_UP);
      await flush();
      component.render(80);
    }
    const parkedFrame = component.render(80);
    const parkedBody = bodyRows(parkedFrame);
    expect(parkedBody.length).toBeGreaterThan(0);
    const parkedView = controller.view()._unsafeUnwrap();
    expect(parkedView.liveTail).toBe(false);
    const parkedCue = parkedView.scrollOffset;
    expect(parkedCue).toBeGreaterThan(0);
    expect(parkedFrame.join("\n")).toContain(
      `${parkedCue} newer line(s) below`,
    );

    // Several live events land below the viewport before the next render.
    for (let step = 0; step < 3; step += 1) {
      controller
        .applyLiveEvent({ type: "thinking", text: `live-tail-row-${step}` })
        ._unsafeUnwrap();
    }
    component.invalidate();
    const grownFrame = component.render(80);
    const grownView = controller.view()._unsafeUnwrap();

    // The parked body is byte-identical and the cue counts the new rows.
    expect(bodyRows(grownFrame)).toEqual(parkedBody);
    expect(grownView.liveTail).toBe(false);
    expect(grownView.scrollOffset).toBeGreaterThan(parkedCue);
    expect(grownView.scrollOffset).toBe(
      parkedCue +
        ((grownView.scrollExtent ?? 0) - (parkedView.scrollExtent ?? 0)),
    );
    expect(grownFrame.join("\n")).toContain(
      `${grownView.scrollOffset} newer line(s) below`,
    );
    // The new rows are off-screen below, not painted over the parked body.
    expect(grownFrame.join("\n")).not.toContain("live-tail-row-2");

    // Returning to the tail exposes them.
    component.handleInput(END);
    await flush();
    const tailFrame = component.render(80).join("\n");
    expect(controller.view()._unsafeUnwrap().liveTail).toBe(true);
    expect(tailFrame).toContain("live-tail-row-2");
  });

  it("requests older and newer pages at pagination edges", async () => {
    const { component, controller } = await mount({
      entryCount: 80,
      pageSize: 10,
    });
    // Scroll to the oldest loaded edge, then page-up should fetch older.
    controller
      .setScrollOffset(controller.view()._unsafeUnwrap().entries.length)
      ._unsafeUnwrap();
    const beforeOlder = controller.view()._unsafeUnwrap().entries.length;
    component.handleInput(PAGE_UP);
    await flush();
    expect(controller.view()._unsafeUnwrap().entries.length).toBeGreaterThan(
      beforeOlder,
    );

    // Return to live-tail and page-down/end may fetch newer when available.
    component.handleInput(END);
    await flush();
    component.handleInput(PAGE_DOWN);
    await flush();
    expect(controller.isOpen()).toBe(true);
  });

  it("awaits Enter steer and Alt+Enter follow-up for an active child", async () => {
    const steers: string[] = [];
    const followUps: string[] = [];
    const { component, controller } = await mount({
      status: "live",
      mutations: {
        steer: (_c, _g, text) => {
          steers.push(text);
          return okAsync(undefined);
        },
        followUp: (_c, _g, text) => {
          followUps.push(text);
          return okAsync(undefined);
        },
      },
    });
    component.handleInput("steer please");
    component.handleInput(ENTER);
    await flush();
    expect(steers).toEqual(["steer please"]);

    component.handleInput("follow later");
    component.handleInput(ALT_ENTER);
    await flush();
    expect(followUps).toEqual(["follow later"]);
  });

  it("shows a read-only banner and no draft editor for settled/orphan children", async () => {
    for (const status of ["settled", "orphan"] as const) {
      const steers: string[] = [];
      const { component, controller } = await mount({
        status,
        mutations: {
          steer: (_c, _g, text) => {
            steers.push(text);
            return okAsync(undefined);
          },
          followUp: (_c, _g, text) => {
            steers.push(text);
            return okAsync(undefined);
          },
        },
      });
      const joined = component.render(80).join("\n");
      expect(joined.toLowerCase()).toContain("read-only");
      expect(joined).not.toMatch(/^>/m);
      controller.updateDraft("nope")._unsafeUnwrap();
      component.handleInput(ENTER);
      await flush();
      expect(steers).toEqual([]);
      expect(controller.view()._unsafeUnwrap().draft).toBe("");
    }
  });

  it("preserves native cursor, backspace, and multiline editing", async () => {
    const { component, controller } = await mount({ status: "live" });
    component.handleInput("abc");
    component.handleInput("\x1b[D");
    component.handleInput("\x7f");
    expect(controller.view()._unsafeUnwrap().draft).toBe("ac");

    component.handleInput("\x1b[13;2u");
    component.handleInput("second");
    expect(controller.view()._unsafeUnwrap().draft).toBe("a\nsecondc");
  });

  it("consumes input without primary-editor leakage and closes once on Escape", async () => {
    const { component, closed, controller } = await mount({ status: "live" });
    component.handleInput("a");
    await flush();
    component.handleInput("b");
    await flush();
    expect(controller.view()._unsafeUnwrap().draft).toContain("a");
    component.handleInput(CTRL_E);
    await flush();
    expect(controller.view()._unsafeUnwrap().globalExpanded).toBe(true);
    component.handleInput(ESCAPE);
    expect(closed()).toBe(1);
    component.handleInput(ESCAPE);
    expect(closed()).toBe(1);
  });

  it("emits typed fallback once on render failure and never throws into Pi", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "fb",
        status: "live",
        generationId: "g",
        entries: entries(3),
      }),
    ]);
    const controller = createChildOverlayController(source);
    await mustOpen(controller, "fb");
    const fallbacks: ChildOverlayFallbackRequired[] = [];
    let closed = 0;
    const component = createChildOverlayCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      { matches: () => false } as never,
      controller,
      () => {
        closed += 1;
      },
      (fallback) => {
        fallbacks.push(fallback);
      },
      { cwd: "/workspace" },
    );
    controller.resize = () =>
      ({
        isErr: () => true,
        isOk: () => false,
        error: controller.requireFallback("render-failed"),
      }) as never;
    expect(() => component.render(40)).not.toThrow();
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0]?.kind).toBe("fallback-required");
    expect(fallbacks[0]?.metadata.reason).toBe("render-failed");
    expect(closed).toBe(1);
    expect(() => component.render(40)).not.toThrow();
    expect(fallbacks.length).toBe(1);
    expect(JSON.stringify(fallbacks)).not.toContain("/Users/");
    expect(JSON.stringify(fallbacks)).not.toContain("Error:");
  });

  it("keeps a single component/controller instance across child swaps", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "one",
        status: "live",
        generationId: "g1",
        entries: entries(5, "one"),
      }),
      child({
        childId: "two",
        status: "live",
        generationId: "g2",
        entries: entries(5, "two"),
      }),
    ]);
    const controller = createChildOverlayController(source);
    await mustOpen(controller, "one");
    let instances = 0;
    const component = createChildOverlayCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => undefined,
      () => undefined,
      { cwd: "/workspace" },
    );
    instances += 1;
    component.render(60);
    await mustOpen(controller, "two");
    component.invalidate();
    const joined = component.render(60).join("\n");
    expect(instances).toBe(1);
    expect(controller.currentChildId()).toBe("two");
    expect(joined).toContain("two");
  });

  it("searches the transcript from ctrl+f and navigates matches", async () => {
    const { component, controller } = await mount({
      status: "settled",
      entryCount: 40,
      pageSize: 40,
    });
    component.render(80);
    component.handleInput("\x06");
    expect(component.render(80).join("\n")).toContain("Search: ");
    for (const key of "e-text-1") component.handleInput(key);
    expect(component.render(80).join("\n")).toContain("Search: e-text-1");
    component.handleInput("\r");
    await flush();
    const view = controller.view()._unsafeUnwrap();
    expect(view.searchQuery).toBe("e-text-1");
    // e-text-1 plus e-text-10..e-text-19 in a 40-entry window.
    expect(view.searchMatches.length).toBe(11);
    const header = component.render(80).join("\n");
    expect(header).toContain("1/11 matches");
    const firstOffset = controller.view()._unsafeUnwrap().scrollOffset;
    component.handleInput("n");
    await flush();
    expect(component.render(80).join("\n")).toContain("2/11 matches");
    expect(controller.view()._unsafeUnwrap().scrollOffset).not.toBe(
      firstOffset,
    );
    component.handleInput("N");
    await flush();
    expect(component.render(80).join("\n")).toContain("1/11 matches");
    expect(controller.view()._unsafeUnwrap().scrollOffset).toBe(firstOffset);
  });

  it("navigates matches that span more than one fetched page", async () => {
    // Markers on the newest page and on two older pages. Search must fetch and
    // merge them all before navigation, so `n` walks the full match set.
    const marked = entries(60).map((entry, index) =>
      index === 55 || index === 42 || index === 21
        ? { id: entry.id, payload: message(entry.id, "user", "needle-token") }
        : entry,
    );
    const { component, controller } = await mount({
      status: "settled",
      pageSize: 10,
      sourceEntries: marked,
    });
    component.render(80);
    // Only the newest page is loaded, so only one marker is visible up front.
    expect(
      controller
        .view()
        ._unsafeUnwrap()
        .entries.filter((entry) => entry.text.includes("needle-token")).length,
    ).toBe(1);

    component.handleInput("\x06");
    for (const key of "needle-token") component.handleInput(key);
    component.handleInput("\r");
    await flush();
    const view = controller.view()._unsafeUnwrap();
    expect(view.searchMatches).toEqual(["e21", "e42", "e55"]);
    expect(component.render(80).join("\n")).toContain("1/3 matches");
    const firstOffset = controller.view()._unsafeUnwrap().scrollOffset;
    component.handleInput("n");
    await flush();
    expect(component.render(80).join("\n")).toContain("2/3 matches");
    const secondOffset = controller.view()._unsafeUnwrap().scrollOffset;
    expect(secondOffset).not.toBe(firstOffset);
    component.handleInput("n");
    await flush();
    expect(component.render(80).join("\n")).toContain("3/3 matches");
    component.handleInput("N");
    await flush();
    expect(component.render(80).join("\n")).toContain("2/3 matches");
    expect(controller.view()._unsafeUnwrap().scrollOffset).toBe(secondOffset);
  });

  it("exits search on Escape without closing the overlay or leaking input", async () => {
    const state = await mount({ status: "settled", entryCount: 20 });
    state.component.render(80);
    state.component.handleInput("\x06");
    for (const key of "e-text-3") state.component.handleInput(key);
    state.component.handleInput("\r");
    await flush();
    expect(state.controller.view()._unsafeUnwrap().searchQuery).toBe(
      "e-text-3",
    );
    state.component.handleInput("\x1b");
    await flush();
    // Escape leaves search only: the overlay stays mounted and the query clears.
    expect(state.closed()).toBe(0);
    expect(state.controller.view()._unsafeUnwrap().searchQuery).toBe("");
    expect(state.component.render(80).join("\n")).not.toContain("Search:");
    // A second Escape now has its ordinary meaning again.
    state.component.handleInput("\x1b");
    await flush();
    expect(state.closed()).toBe(1);
  });

  it("keeps a settled overlay read-only while search is open", async () => {
    const steered: string[] = [];
    const state = await mount({
      status: "settled",
      entryCount: 12,
      mutations: {
        steer: (_childId, _generationId, text) => {
          steered.push(text);
          return okAsync(undefined);
        },
        followUp: (_childId, _generationId, text) => {
          steered.push(text);
          return okAsync(undefined);
        },
      },
    });
    state.component.render(80);
    state.component.handleInput("\x06");
    for (const key of "hello") state.component.handleInput(key);
    state.component.handleInput("\r");
    await flush();
    // Enter inside search runs the query; it can never steer or follow up.
    expect(steered).toEqual([]);
    expect(state.controller.view()._unsafeUnwrap().draft).toBe("");
  });

  it("leaves the key alone when the host already binds it", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "overlay-1",
        status: "settled",
        generationId: "gen-1",
        entries: entries(8),
      }),
    ]);
    const controller = createChildOverlayController(source);
    await mustOpen(controller, "overlay-1");
    let closed = 0;
    const component = createChildOverlayCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => {
        closed += 1;
      },
      () => undefined,
      { cwd: "/workspace" },
      undefined,
      { trigger: undefined },
    );
    component.render(80);
    component.handleInput("\x06");
    await flush();
    // No prompt opened, so the key kept its host meaning and Escape still closes.
    expect(component.render(80).join("\n")).not.toContain("Search:");
    component.handleInput("\x1b");
    expect(closed).toBe(1);
  });

  it("keeps the newly focused child's draft when a pending submission settles after a child switch", async () => {
    // The draft editor is shared by every child. A steer that settles after the
    // controller moved focus must not clear or mirror the previous child's text
    // onto the child the reader is now looking at.
    let releaseSteer: (() => void) | undefined;
    const steerCalls: string[] = [];
    const mutations: ChildOverlayMutationPort = {
      steer: (childId, _generationId, text) => {
        steerCalls.push(`${childId}:${text}`);
        return ResultAsync.fromSafePromise(
          new Promise<void>((resolve) => {
            releaseSteer = () => resolve();
          }),
        );
      },
      followUp: () => okAsync(undefined),
    };
    const source = createMemoryChildOverlaySource([
      child({
        childId: "overlay-a",
        status: "live",
        generationId: "gen-a",
        entries: entries(4),
      }),
      child({
        childId: "overlay-b",
        status: "live",
        generationId: "gen-b",
        entries: entries(4),
      }),
    ]);
    const controller = createChildOverlayController(
      source,
      { pageSize: 10 },
      mutations,
    );
    await mustOpen(controller, "overlay-a");
    const component = createChildOverlayCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => undefined,
      () => undefined,
      { cwd: "/workspace" },
    );
    controller.updateDraft("alpha draft")._unsafeUnwrap();
    // First render syncs the shared editor with the focused child's draft.
    expect(component.render(80).join("\n")).toContain("alpha draft");

    component.handleInput(ENTER);
    await flush();
    expect(steerCalls).toEqual(["overlay-a:alpha draft"]);
    expect(releaseSteer).toBeDefined();

    // Focus moves while the mutation is still in flight, and no render happens
    // in between, so the shared editor still holds the submitted text.
    await mustOpen(controller, "overlay-b");
    controller.updateDraft("bravo draft")._unsafeUnwrap();

    releaseSteer?.();
    await flush();

    // The newly focused child keeps its own draft, saved and rendered.
    const settled = controller.view()._unsafeUnwrap();
    expect(settled.child.childId).toBe("overlay-b");
    expect(settled.draft).toBe("bravo draft");
    const frame = component.render(80).join("\n");
    expect(frame).toContain("bravo draft");
    expect(frame).not.toContain("alpha draft");
    // The submitted child's own draft was still cleared by the controller.
    expect((await controller.open("overlay-a"))._unsafeUnwrap().draft).toBe("");
  });
});

describe("mapPiDelegationFailureToOverlaySourceError", () => {
  // Task 20(c): production `describe` used to collapse every delegation
  // failure into `ChildNotFound`, so a live `open-describe-failed` fallback
  // could not name its cause. Each failure now keeps its own source error
  // while staying inside the fallback-classified set, so the overlay still
  // falls back exactly as before.
  it("keeps an unknown or origin-mismatched thread as a missing child", () => {
    for (const reason of ["unknown-thread", "origin-mismatch"] as const) {
      expect(
        mapPiDelegationFailureToOverlaySourceError(
          makeThreadNotFoundFailure("thread-a", reason),
          "child-a",
        ),
      ).toEqual({ type: "ChildNotFound", childId: "child-a" });
    }
  });

  it("reports an unreadable ref source as unavailable, not as a missing child", () => {
    expect(
      mapPiDelegationFailureToOverlaySourceError(
        makeThreadNotFoundFailure("thread-a", "refs-unavailable"),
        "child-a",
      ),
    ).toEqual({ type: "SourceUnavailable", operation: "describe" });
  });

  it("reports a thread integrity failure as a corrupt source", () => {
    expect(
      mapPiDelegationFailureToOverlaySourceError(
        makeThreadIntegrityFailure("thread-a", "ref-conflict"),
        "child-a",
      ),
    ).toEqual({ type: "SourceCorrupt", operation: "describe" });
  });

  it("reports any other controller failure as an unavailable source", () => {
    expect(
      mapPiDelegationFailureToOverlaySourceError(
        makeThreadAuthorityDeniedFailure("thread-a", "not-owner"),
        "child-a",
      ),
    ).toEqual({ type: "SourceUnavailable", operation: "describe" });
  });

  it("never copies a thread id or free-form failure text into the error", () => {
    const mapped = mapPiDelegationFailureToOverlaySourceError(
      makeThreadNotFoundFailure(
        "thread-/Users/someone/secret",
        "unknown-thread",
      ),
      "child-a",
    );
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("thread-");
    expect(serialized).not.toContain("No delegated thread");
  });
});

// ---------------------------------------------------------------------------
// Compact view mode (Task 7)
// ---------------------------------------------------------------------------

const CTRL_O = "\x0f";

describe("child overlay compact view mode", () => {
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const mountCompact = async (
    options: {
      readonly disableViewModeRoute?: boolean;
      readonly entryCount?: number;
      readonly status?: "live" | "settled" | "orphan";
    } = {},
  ) => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "vm-mount",
        status: options.status ?? "live",
        generationId: "gen-1",
        title: "compact-child",
        entries: entries(options.entryCount ?? 6),
      }),
    ]);
    const controller = createChildOverlayController(source, { pageSize: 10 });
    await mustOpen(controller, "vm-mount");
    const component = createChildOverlayCustomComponent(
      { requestRender: () => {} } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => {},
      () => {},
      { cwd: "/workspace" },
      undefined,
      { trigger: undefined },
      { trigger: options.disableViewModeRoute === true ? undefined : CTRL_O },
    );
    return { component, controller };
  };

  it("defaults to full and toggles full → compact → full", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "vm-1", entries: entries(6) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const opened = await mustOpen(overlay, "vm-1");
    expect(opened.viewMode).toBe("full");
    expect(overlay.toggleViewMode()._unsafeUnwrap().viewMode).toBe("compact");
    expect(overlay.toggleViewMode()._unsafeUnwrap().viewMode).toBe("full");
  });

  it("toggles from the non-printable ctrl+o key through handleInput", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "vm-key",
        status: "live",
        generationId: "gen-1",
        entries: entries(4),
      }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    await mustOpen(overlay, "vm-key");
    const outcome = (await overlay.handleInput(CTRL_O))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: "view-mode", viewMode: "compact" });
    expect(overlay.view()._unsafeUnwrap().viewMode).toBe("compact");
    // The toggle key is never treated as draft text.
    expect(overlay.view()._unsafeUnwrap().draft).toBe("");
  });

  it("keeps view mode per child and across focus switches", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "vm-a", entries: entries(4) }),
      child({ childId: "vm-b", entries: entries(4, "b") }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    await mustOpen(overlay, "vm-a");
    overlay.toggleViewMode()._unsafeUnwrap();
    expect(overlay.view()._unsafeUnwrap().viewMode).toBe("compact");

    // Isolation: the second child keeps the default.
    const b = await mustOpen(overlay, "vm-b");
    expect(b.viewMode).toBe("full");

    // Persistence: returning to the first child restores compact.
    const backToA = await mustOpen(overlay, "vm-a");
    expect(backToA.viewMode).toBe("compact");
    expect((await mustOpen(overlay, "vm-b")).viewMode).toBe("full");
  });

  it("resets to full on a new controller (teardown drops saved view modes)", async () => {
    const children = [child({ childId: "vm-t", entries: entries(4) })];
    const first = createChildOverlayController(
      createMemoryChildOverlaySource(children),
      { pageSize: 10 },
    );
    await mustOpen(first, "vm-t");
    first.toggleViewMode()._unsafeUnwrap();
    expect(first.view()._unsafeUnwrap().viewMode).toBe("compact");
    first.close()._unsafeUnwrap();

    const second = createChildOverlayController(
      createMemoryChildOverlaySource(children),
      { pageSize: 10 },
    );
    expect((await mustOpen(second, "vm-t")).viewMode).toBe("full");
  });

  it("does not fork entry state: entries are identical across a round trip", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "vm-entries", entries: entries(6) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const before = (await mustOpen(overlay, "vm-entries")).entries;
    const compact = overlay.toggleViewMode()._unsafeUnwrap().entries;
    const after = overlay.toggleViewMode()._unsafeUnwrap().entries;
    expect(compact.map((entry) => entry.id)).toEqual(
      before.map((entry) => entry.id),
    );
    expect(after).toEqual(before);
  });

  it("preserves the draft across a compact round trip", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "vm-draft",
        status: "live",
        generationId: "gen-1",
        entries: entries(4),
      }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    await mustOpen(overlay, "vm-draft");
    overlay.updateDraft("keep me")._unsafeUnwrap();
    expect(overlay.toggleViewMode()._unsafeUnwrap().draft).toBe("keep me");
    expect(overlay.toggleViewMode()._unsafeUnwrap().draft).toBe("keep me");
  });

  it("preserves search query and matches across a compact round trip", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "vm-search", entries: entries(8) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    await mustOpen(overlay, "vm-search");
    const searched = (await overlay.search("e-text-3"))._unsafeUnwrap();
    expect(searched.searchMatches.length).toBeGreaterThan(0);
    const compact = overlay.toggleViewMode()._unsafeUnwrap();
    expect(compact.searchQuery).toBe("e-text-3");
    expect(compact.searchMatches).toEqual(searched.searchMatches);
    const full = overlay.toggleViewMode()._unsafeUnwrap();
    expect(full.searchQuery).toBe("e-text-3");
    expect(full.searchMatches).toEqual(searched.searchMatches);
  });

  it("still searches the whole loaded window while compact", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "vm-search-2", entries: entries(8) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    await mustOpen(overlay, "vm-search-2");
    overlay.toggleViewMode()._unsafeUnwrap();
    const searched = (await overlay.search("e-text-"))._unsafeUnwrap();
    expect(searched.viewMode).toBe("compact");
    expect(searched.searchMatches.length).toBe(searched.entries.length);
  });

  it("discards the measured extent on toggle so the next render re-measures", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "vm-extent", entries: entries(20) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    await mustOpen(overlay, "vm-extent");
    overlay.setScrollExtent(120)._unsafeUnwrap();
    expect(overlay.view()._unsafeUnwrap().scrollExtent).toBe(120);
    const toggled = overlay.toggleViewMode()._unsafeUnwrap();
    // Rows-per-entry changes everywhere, so the stale row extent is dropped and
    // the entry count is the only bound until the component measures again.
    expect(toggled.scrollExtent).toBe(toggled.entries.length);
    expect(overlay.setScrollExtent(19)._unsafeUnwrap().scrollExtent).toBe(19);
  });

  it("keeps the viewport anchor stable across a large row-count change", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "vm-anchor", entries: entries(20) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    await mustOpen(overlay, "vm-anchor");
    overlay.setScrollExtent(200)._unsafeUnwrap();
    overlay.setScrollOffset(8)._unsafeUnwrap();
    const before = overlay.view()._unsafeUnwrap();
    expect(before.anchor?.entryId).toBeDefined();

    const compact = overlay.toggleViewMode()._unsafeUnwrap();
    expect(compact.anchor?.entryId).toBe(before.anchor?.entryId);
    // The offset never scales with the row-count change; it only clamps.
    expect(compact.scrollOffset).toBeLessThanOrEqual(before.scrollOffset);
    expect(compact.liveTail).toBe(false);

    const full = overlay.toggleViewMode()._unsafeUnwrap();
    expect(full.anchor?.entryId).toBe(before.anchor?.entryId);
  });

  it("keeps following the tail across a toggle when the viewport is live", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "vm-tail", entries: entries(10) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    await mustOpen(overlay, "vm-tail");
    const compact = overlay.toggleViewMode()._unsafeUnwrap();
    expect(compact.scrollOffset).toBe(0);
    expect(compact.liveTail).toBe(true);
  });

  it("renders one summary row per entry with the compact badge and help", async () => {
    const { component, controller } = await mountCompact({ entryCount: 6 });
    const fullLines = component.render(80).join("\n");
    expect(fullLines).not.toContain("COMPACT");
    expect(fullLines).toContain("Ctrl+O toggles compact view (now full)");

    component.handleInput(CTRL_O);
    await flush();
    expect(controller.view()._unsafeUnwrap().viewMode).toBe("compact");
    const compactLines = component.render(80);
    const joined = compactLines.join("\n");
    expect(joined).toContain("COMPACT");
    expect(joined).toContain("Ctrl+O toggles compact view (now compact)");
    expect(joined).toContain("e-text-0");
    expect(joined).not.toContain("/Users/");
    // Compact rows never wrap, so each admitted entry costs exactly one row.
    for (const entry of controller.view()._unsafeUnwrap().entries) {
      expect(
        compactLines.some((line) =>
          line.includes(`e-text-${entry.id.slice(1)}`),
        ),
      ).toBe(true);
    }
  });

  it("leaves the toggle key to the host when the route is disabled", async () => {
    const { component, controller } = await mountCompact({
      disableViewModeRoute: true,
    });
    const rendered = component.render(80).join("\n");
    expect(rendered).not.toContain("Ctrl+O toggles compact view");
    component.handleInput(CTRL_O);
    await flush();
    // Not routed to the controller: the child stays in full view.
    expect(controller.view()._unsafeUnwrap().viewMode).toBe("full");
  });
});
