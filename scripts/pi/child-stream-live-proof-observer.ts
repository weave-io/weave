import { Result } from "neverthrow";
import {
  createPiLiveReasoningProjector,
  type PiLiveReasoningProjector,
} from "../../packages/adapters/pi/src/child-live-reasoning-projector.js";
import { createPiLiveReasoningRegistry } from "../../packages/adapters/pi/src/child-live-reasoning-registry.js";
import { PI_LIVE_REASONING_PARENT_PREFIX } from "../../packages/adapters/pi/src/child-live-reasoning-types.js";
import { renderOverlayPiNative } from "../../packages/adapters/pi/src/child-overlay-pi-native.js";
import { redactProviderErrorFromEvent } from "../../packages/adapters/pi/src/child-provider-error.js";
import {
  parsePiChildSessionEvent,
  retainedChildSessionEvent,
} from "../../packages/adapters/pi/src/child-session-events.js";
import {
  createPiChildTranscriptState,
  type PiChildTranscriptState,
  reducePiChildTranscript,
} from "../../packages/adapters/pi/src/child-transcript.js";
import {
  type ChildUiEventDiagnostics,
  createChildUiEventDiagnostics,
} from "../../packages/adapters/pi/src/child-ui-event-diagnostics.js";
import { plainPaint } from "../../packages/adapters/pi/src/ui-paint.js";
import type {
  LiveProofDiagnosticsObservation,
  LiveProofIsolationObservation,
  LiveProofLaneSignal,
  LiveProofRegistryObservation,
  LiveProofSettlementObservation,
} from "./child-stream-live-proof-runner.js";

const RENDER_WIDTH = 96;
const TOOL_ROW = "⚙";
const CONTINUATION_ROW = "⎿";
const CHILD_NAME = "live-proof-child";
const ASSISTANT_HEADER_PREFIX = `${CHILD_NAME} · `;

interface MutableLane {
  prefixObserved: boolean;
  nonBlankObserved: boolean;
  growthObserved: boolean;
  observationCount: number;
  events: number;
  dropped: number;
  repaints: number;
}

function emptyLane(): MutableLane {
  return {
    prefixObserved: false,
    nonBlankObserved: false,
    growthObserved: false,
    observationCount: 0,
    events: 0,
    dropped: 0,
    repaints: 0,
  };
}

function laneSignal(lane: MutableLane): LiveProofLaneSignal {
  const pass =
    lane.prefixObserved &&
    lane.nonBlankObserved &&
    lane.growthObserved &&
    lane.observationCount > 0;
  return {
    status: pass ? "pass" : "fail",
    prefixObserved: lane.prefixObserved,
    nonBlankObserved: lane.nonBlankObserved,
    growthObserved: lane.growthObserved,
    observationCount: lane.observationCount,
    events: lane.events,
    dropped: lane.dropped,
    repaints: lane.repaints,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantEventType(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const event = payload.assistantMessageEvent;
  if (!isRecord(event)) return undefined;
  return typeof event.type === "string" ? event.type : undefined;
}

function safeSerialize(value: unknown): string {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(value) ?? "",
    () => undefined,
  )();
  return serialized.isOk() ? serialized.value : "";
}

/**
 * Content-free live lane observation.
 *
 * Every raw child event is fed through the production reasoning projectors,
 * session parser, transcript reducer, and native overlay renderer. The
 * observer keeps only booleans and saturating counts: no reasoning text,
 * assistant text, tool payload, identifier, or content-derived digest is ever
 * retained, returned, or written. Display strings exist as local values inside
 * one `ingest` call and are dropped when it returns.
 */
export class LiveProofObserver {
  private readonly registry = createPiLiveReasoningRegistry();
  private readonly diagnostics: ChildUiEventDiagnostics;
  private readonly cardProjector: PiLiveReasoningProjector;
  private inspectorProjector: PiLiveReasoningProjector | undefined;
  private transcript: PiChildTranscriptState = createPiChildTranscriptState();

  private readonly parentLane = emptyLane();
  private readonly inspectorReasoningLane = emptyLane();
  private readonly toolLane = emptyLane();
  private readonly assistantLane = emptyLane();

  private events = 0;
  private dropped = 0;
  private settlementCount = 0;
  private toolTerminalCount = 0;
  private settledAt: number | undefined;
  private inspectorSelectedWhileRunning = false;
  private lastParentText = "";
  private lastInspectorText = "";
  private lastToolSignature = "";
  private lastAssistantLength = 0;
  private durableLeak = false;
  private renderLeak = false;

  /**
   * `sentinel` is the controlled reasoning string emitted by this proof's own
   * deterministic provider. It is compared, never stored, so the observer can
   * prove that live reasoning did not reach a durable or rendered sink.
   */
  constructor(private readonly sentinel: string) {
    this.diagnostics = createChildUiEventDiagnostics();
    this.cardProjector = createPiLiveReasoningProjector({
      childId: "live-proof-child",
      generationId: "live-proof-generation",
      registry: this.registry,
      registryKey: "live-proof-card",
      diagnostics: this.diagnostics,
    });
  }

  /** Select the inspector for the running child. Refused after settlement. */
  selectInspector(): boolean {
    if (this.settledAt !== undefined) return false;
    if (this.inspectorProjector !== undefined) return false;
    this.inspectorProjector = createPiLiveReasoningProjector({
      childId: "live-proof-child",
      generationId: "live-proof-generation",
      registry: this.registry,
      registryKey: "live-proof-inspector",
      diagnostics: this.diagnostics,
    });
    this.inspectorSelectedWhileRunning = true;
    return true;
  }

  settled(): boolean {
    return this.settledAt !== undefined;
  }

  ingest(payload: unknown): void {
    if (this.settledAt !== undefined) return;
    this.events += 1;
    this.observeReasoning(payload);
    this.observeTranscript(payload);
    if (isRecord(payload) && payload.type === "agent_settled") {
      this.settlementCount += 1;
      this.settledAt = this.events;
      this.release();
    }
  }

  private observeReasoning(payload: unknown): void {
    const eventType = assistantEventType(payload);
    const isReasoningCarrier =
      eventType === "thinking_start" ||
      eventType === "thinking_delta" ||
      eventType === "thinking_end";
    if (!isReasoningCarrier) return;

    this.parentLane.events += 1;
    const card = this.cardProjector.accept(payload);
    if (card.isErr()) {
      this.parentLane.dropped += 1;
      this.dropped += 1;
    } else if (card.value !== undefined) {
      const snapshot = this.cardProjector.snapshot();
      this.parentLane.repaints += 1;
      if (snapshot.parentCardLine.startsWith(PI_LIVE_REASONING_PARENT_PREFIX)) {
        this.parentLane.prefixObserved = true;
      }
      if (snapshot.parentCardText.trim().length > 0) {
        this.parentLane.nonBlankObserved = true;
        this.parentLane.observationCount += 1;
        if (
          this.lastParentText.length > 0 &&
          snapshot.parentCardText !== this.lastParentText
        ) {
          this.parentLane.growthObserved = true;
        }
        this.lastParentText = snapshot.parentCardText;
      }
    }

    const inspector = this.inspectorProjector;
    if (inspector === undefined) return;
    this.inspectorReasoningLane.events += 1;
    const applied = inspector.accept(payload);
    if (applied.isErr()) {
      this.inspectorReasoningLane.dropped += 1;
      this.dropped += 1;
      return;
    }
    if (applied.value === undefined) return;
    const snapshot = inspector.snapshot();
    this.inspectorReasoningLane.repaints += 1;
    if (snapshot.parentCardLine.startsWith(PI_LIVE_REASONING_PARENT_PREFIX)) {
      this.inspectorReasoningLane.prefixObserved = true;
    }
    const rows = snapshot.inspectorRows.join("\n");
    if (rows.trim().length > 0) {
      this.inspectorReasoningLane.nonBlankObserved = true;
      this.inspectorReasoningLane.observationCount += 1;
      if (
        this.lastInspectorText.length > 0 &&
        rows !== this.lastInspectorText
      ) {
        this.inspectorReasoningLane.growthObserved = true;
      }
      this.lastInspectorText = rows;
    }
  }

  private observeTranscript(payload: unknown): void {
    const parsed = parsePiChildSessionEvent(payload);
    if (!parsed.success) {
      this.dropped += 1;
      return;
    }
    const retained = retainedChildSessionEvent(parsed.data);
    if (retained === undefined) return;
    if (safeSerialize(retained).includes(this.sentinel))
      this.durableLeak = true;

    const next = reducePiChildTranscript(this.transcript, {
      kind: "event",
      event: redactProviderErrorFromEvent(retained),
    });
    if (next.isErr()) {
      this.dropped += 1;
      return;
    }
    this.transcript = next.value;
    if (assistantEventType(payload) === "toolcall_end") {
      this.toolTerminalCount += 1;
    }
    this.observeRenderedRows();
  }

  private observeRenderedRows(): void {
    const rendered = renderOverlayPiNative(
      plainPaint(),
      {
        entries: this.transcript.entries,
        childName: CHILD_NAME,
        settled: false,
      },
      RENDER_WIDTH,
    );
    const rows = rendered.plain.map((line) => line.replace(/\s+$/u, ""));
    if (rows.join("\n").includes(this.sentinel)) this.renderLeak = true;

    const toolRows = rows.filter((row) => row.startsWith(TOOL_ROW));
    const continuationRows = rows.filter((row) =>
      row.trimStart().startsWith(CONTINUATION_ROW),
    );
    if (toolRows.length > 0) {
      this.toolLane.events += 1;
      this.toolLane.prefixObserved = true;
      const detailed = toolRows.some((row) =>
        /\([^)]*[^\s)][^)]*\)/u.test(row),
      );
      if (detailed) this.toolLane.nonBlankObserved = true;
      const resulted = continuationRows.some(
        (row) =>
          row.trimStart().slice(CONTINUATION_ROW.length).trim().length > 0,
      );
      if (detailed && resulted) this.toolLane.growthObserved = true;
      const signature = `${toolRows.length}:${continuationRows.length}`;
      if (signature !== this.lastToolSignature) {
        this.lastToolSignature = signature;
        this.toolLane.observationCount += 1;
        this.toolLane.repaints += 1;
      }
    }

    // The native overlay writes one `<child> · reply` header and indents the
    // incremental assistant body under it. Tool continuations are indented
    // too, so they are excluded explicitly.
    const headerIndex = rows.findIndex((row) =>
      row.startsWith(ASSISTANT_HEADER_PREFIX),
    );
    if (headerIndex < 0) return;
    this.assistantLane.prefixObserved = true;
    const assistantRows = rows
      .slice(headerIndex + 1)
      .filter(
        (row) =>
          row.startsWith("  ") &&
          !row.trimStart().startsWith(CONTINUATION_ROW) &&
          !row.trimStart().startsWith(PI_LIVE_REASONING_PARENT_PREFIX),
      );
    const assistantLength = assistantRows.join("\n").trim().length;
    if (assistantLength > 0) {
      this.assistantLane.events += 1;
      this.assistantLane.nonBlankObserved = true;
      if (assistantLength > this.lastAssistantLength) {
        if (this.lastAssistantLength > 0)
          this.assistantLane.growthObserved = true;
        this.lastAssistantLength = assistantLength;
        this.assistantLane.observationCount += 1;
        this.assistantLane.repaints += 1;
      }
    }
  }

  /** Release both bounded UI buffers, exactly as the production surfaces do. */
  release(): void {
    this.cardProjector.dispose().match(
      () => undefined,
      () => undefined,
    );
    this.inspectorProjector?.dispose().match(
      () => undefined,
      () => undefined,
    );
    this.registry.clear().match(
      () => undefined,
      () => undefined,
    );
  }

  parentReasoningLane(): LiveProofLaneSignal {
    return laneSignal(this.parentLane);
  }

  inspectorReasoningSignal(): LiveProofLaneSignal {
    return laneSignal(this.inspectorReasoningLane);
  }

  inspectorToolSignal(): LiveProofLaneSignal {
    return laneSignal(this.toolLane);
  }

  inspectorAssistantSignal(): LiveProofLaneSignal {
    return laneSignal(this.assistantLane);
  }

  settlement(childCount: number): LiveProofSettlementObservation {
    return {
      status: this.settledAt === undefined ? "unsettled" : "settled",
      childCount,
      settlementCount: this.settlementCount,
      toolTerminalCount: this.toolTerminalCount,
      events: this.events,
      dropped: this.dropped,
      repaints: this.parentLane.repaints,
    };
  }

  isolation(): LiveProofIsolationObservation {
    return {
      parentIsolated: !this.renderLeak && this.parentLane.prefixObserved,
      cardIsolated: !this.renderLeak,
      modelIsolated: !this.durableLeak,
      durableIsolated: !this.durableLeak,
      prohibitedSinkDetected: this.durableLeak || this.renderLeak,
    };
  }

  registrySnapshot(): LiveProofRegistryObservation {
    const entries = this.registry.size();
    const bytes = this.registry.retainedBytes();
    return {
      cardEntries: entries,
      cardBytes: bytes,
      inspectorEntries: entries,
      inspectorBytes: bytes,
      registryEntries: entries,
      registryBytes: bytes,
    };
  }

  diagnosticsSnapshot(): LiveProofDiagnosticsObservation {
    const snapshot = this.diagnostics.snapshot();
    let count = 0;
    let saturated = false;
    for (const bucket of snapshot.buckets) {
      count += bucket.count;
      saturated ||= bucket.saturated;
    }
    return {
      status: count === 0 && this.dropped === 0 ? "clean" : "loss-observed",
      count,
      overflow: saturated || snapshot.omittedBuckets > 0,
    };
  }

  inspectorWasSelectedWhileRunning(): boolean {
    return this.inspectorSelectedWhileRunning;
  }
}

export function createLiveProofObserver(sentinel: string): LiveProofObserver {
  return new LiveProofObserver(sentinel);
}
