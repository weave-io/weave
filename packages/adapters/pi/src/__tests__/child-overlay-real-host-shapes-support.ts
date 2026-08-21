import { expect } from "bun:test";
import { okAsync } from "neverthrow";
import { createChildCompactState } from "../child-compact-render.js";
import { renderOverlayPiNative } from "../child-overlay-pi-native.js";
import type {
  ChildOverlayChild,
  ChildOverlayPage,
  ChildOverlaySourceError,
  ChildOverlaySourcePort,
  ChildOverlayView,
} from "../child-overlay-types.js";
import { redactProviderErrorFromEvent } from "../child-provider-error.js";
import {
  isPiAuthoritativeToolEvent,
  parsePiChildSessionEvent,
} from "../child-session-events.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import {
  createPiChildTranscriptState,
  type PiChildTranscriptState,
  reducePiChildTranscript,
} from "../child-transcript.js";
import { plainPaint } from "../ui-paint.js";

/** Lets every already-resolved source answer land before a frame is read. */
export const drain = async (): Promise<void> => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};

/** Repaints run inline, so no frame here can reach the host clock. */
export class ImmediateTimerPort implements TimerPort {
  schedule(callback: () => void, _delayMs: number): TimerHandle {
    let live = true;
    queueMicrotask(() => {
      if (live) callback();
    });
    return {
      cancel: () => {
        live = false;
      },
    };
  }
}

/** One host event through the exact pipeline a live child event travels. */
function ingest(
  state: PiChildTranscriptState,
  hostEvent: unknown,
): PiChildTranscriptState {
  const parsed = parsePiChildSessionEvent(hostEvent);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return state;
  const next = reducePiChildTranscript(state, {
    kind: "event",
    event: isPiAuthoritativeToolEvent(parsed.data)
      ? parsed.data
      : redactProviderErrorFromEvent(parsed.data),
  });
  expect(next.isOk()).toBe(true);
  return next.isOk() ? next.value : state;
}

export function transcriptOf(
  hostEvents: readonly unknown[],
): PiChildTranscriptState {
  let state = createPiChildTranscriptState();
  for (const event of hostEvents) state = ingest(state, event);
  return state;
}

/** The rows a reader actually sees, ANSI-free and right-trimmed. */
export function rowsOf(
  hostEvents: readonly unknown[],
  settled = false,
): readonly string[] {
  return renderOverlayPiNative(
    plainPaint(),
    {
      entries: transcriptOf(hostEvents).entries,
      childName: "shuttle",
      settled,
    },
    96,
  ).plain.map((line) => line.replace(/\s+$/u, ""));
}

/** A pi-ai ToolResultMessage, exactly as tool_execution_end carries it. */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  text: string,
  isError: boolean,
): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 1_700_000_000_000,
  };
}

export const CALL_ID = "toolu01AbCdEfGhIjKlMnOp";

/** A view over one transcript, with only the facts these assertions read. */
export function viewOf(
  transcript: PiChildTranscriptState,
  identity: Partial<NonNullable<ChildOverlayView["identity"]>> = {},
): ChildOverlayView {
  return {
    child: {
      childId: "child-1",
      threadId: "thread-1",
      status: "live",
      generationId: "gen-1",
      runs: [],
      branchIds: [],
      descendantChildIds: [],
    },
    entries: [],
    draft: "",
    searchQuery: "",
    searchMatches: [],
    scrollOffset: 0,
    scrollExtent: 0,
    liveTail: true,
    globalExpanded: false,
    activeRun: undefined,
    activeBranchId: undefined,
    olderCursor: undefined,
    newerCursor: undefined,
    hasOlder: false,
    hasNewer: false,
    readOnly: false,
    width: 96,
    height: 40,
    anchor: undefined,
    compact: createChildCompactState("thread-1"),
    transcript,
    telemetry: undefined,
    identity: { agentName: "shuttle", ...identity },
    planContext: undefined,
  };
}

/**
 * The authoritative source, with a descriptor that moves from live to
 * settled exactly as the delegation tree does.
 */
export function settlingSource(): {
  readonly port: ChildOverlaySourcePort;
  settle(): void;
  advance(): void;
  live(): boolean;
} {
  let descriptor: ChildOverlayChild = {
    childId: "settle-child",
    threadId: "settle-thread",
    status: "live",
    generationId: "gen-1",
    runs: [],
    branchIds: [],
    descendantChildIds: [],
    agentName: "shuttle",
    turn: 1,
    elapsedMs: 4_000,
  };
  const emptyPage = okAsync<ChildOverlayPage, ChildOverlaySourceError>({
    entries: [],
    olderCursor: undefined,
    newerCursor: undefined,
    hasOlder: false,
    hasNewer: false,
  });
  return {
    port: {
      describe: () => okAsync(descriptor),
      loadNewest: () => emptyPage,
      loadOlder: () => emptyPage,
      loadNewer: () => emptyPage,
    },
    advance: () => {
      descriptor = { ...descriptor, elapsedMs: 61_000 };
    },
    settle: () => {
      descriptor = {
        ...descriptor,
        status: "settled",
        turn: 7,
        elapsedMs: 92_000,
        usage: { inputTokens: 184_200, outputTokens: 12_400 },
      };
    },
    live: () => descriptor.status === "live",
  };
}
