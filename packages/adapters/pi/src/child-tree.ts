/**
 * Bounded, inspectable child-tree state and the selection/cancel control
 * model (Pi adapter contract). Pure data and a pure reducer - no process, I/O, or
 * Pi dependency - so the tree UI's control semantics can be fully unit
 * tested without a real host.
 */

import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  parsePiChildSessionEvent,
  preserveUnknownChildEvent,
} from "./child-session-events.js";
import {
  EMPTY_PI_CHILD_TRANSCRIPT_STATE,
  PiChildTranscriptReducer,
  type PiChildTranscriptState,
} from "./child-transcript.js";
import type { JsonValue } from "./strict-json.js";

export const ROOT_NODE_ID = "root";

/**
 * Byte bound on any child final output that crosses back into the parent.
 * Owned here because both the artifact provider and recovery clamp to it.
 */
export const MAX_FINAL_OUTPUT_BYTES = 4_096;

/**
 * Shared per-generation child registry. Execution owners keep their own
 * process maps and budgets; this registry is the single topology/inspection
 * view for ordinary, nested, and workflow-step children. Terminal snapshots
 * remain after the process owner disposes the child.
 */
export type PiChildInspectionHistoryError = {
  readonly kind: "history-write-failed";
  readonly operation:
    | "register"
    | "attach"
    | "checkpoint"
    | "interrupted"
    | "terminal"
    | "clear";
  readonly reason: "unavailable" | "corrupt" | "quota" | "invalid";
};

export interface PiChildInspectionHistoryPort {
  readonly register?: (
    registration: PiChildInspectionRegistration,
  ) => ResultAsync<void, PiChildInspectionHistoryError>;
  readonly checkpoint?: (
    id: string,
    event?: unknown,
  ) => ResultAsync<void, PiChildInspectionHistoryError>;
  readonly interrupted?: (
    id: string,
  ) => ResultAsync<void, PiChildInspectionHistoryError>;
  readonly terminal?: (
    id: string,
    snapshot: PiChildTreeNode,
    finalOutput?: string,
  ) => ResultAsync<void, PiChildInspectionHistoryError>;
  readonly clear?: (
    id: string,
  ) => ResultAsync<void, PiChildInspectionHistoryError>;
  readonly clearTerminal?: () => ResultAsync<
    number,
    PiChildInspectionHistoryError
  >;
}

export interface PiChildInspectionRegistration {
  readonly id: string;
  readonly parentId: string;
  readonly name: string;
  readonly kind: "ordinary" | "nested" | "workflow-step";
  readonly snapshot: () => PiChildTreeNode;
  readonly workflowInstanceId?: string;
  readonly stepName?: string;
  /** Concrete model the child was bootstrapped with, when the parent resolved one. */
  readonly model?: string;
  /** Core-owned thinking intent sent alongside the model. */
  readonly thinkingLevel?: string;
  readonly onInterrupted?: () => void;
  readonly onTerminal?: (snapshot: PiChildTreeNode) => void;
}

export class PiChildInspectionRegistry {
  private readonly live = new Map<string, PiChildInspectionRegistration>();
  private readonly records = new Map<string, PiChildTreeNode>();
  private readonly transcriptStates = new Map<
    string,
    PiChildTranscriptReducer
  >();
  private generationOpen = true;
  private transcriptListener: ((childId: string) => void) | undefined;
  private tail: ResultAsync<void, PiChildInspectionHistoryError> =
    okAsync(undefined);
  private firstFailure: PiChildInspectionHistoryError | undefined;

  constructor(private readonly history?: PiChildInspectionHistoryPort) {}

  private enqueue(
    operation: () => ResultAsync<void, PiChildInspectionHistoryError>,
  ): ResultAsync<void, PiChildInspectionHistoryError> {
    // Recover the chain after each failure so one bad write cannot suppress
    // later checkpoints or the terminal/interrupted write. Keep the first
    // typed failure and report it after the queued operation has run.
    const next = this.tail
      .orElse((failure) => {
        this.firstFailure ??= failure;
        return okAsync(undefined);
      })
      .andThen(operation)
      .mapErr((failure) => {
        this.firstFailure ??= failure;
        return failure;
      });
    this.tail = next;
    return next
      .orElse((failure) => {
        this.firstFailure ??= failure;
        return okAsync(undefined);
      })
      .andThen(() =>
        this.firstFailure === undefined
          ? okAsync(undefined)
          : errAsync(this.firstFailure),
      );
  }

  /** Waits for every queued history write, including same-tick checkpoints. */
  drain(): ResultAsync<void, PiChildInspectionHistoryError> {
    return this.tail
      .orElse((failure) => {
        this.firstFailure ??= failure;
        return okAsync(undefined);
      })
      .andThen(() =>
        this.firstFailure === undefined
          ? okAsync(undefined)
          : errAsync(this.firstFailure),
      );
  }

  /** Attach a recovered live process without rewriting its durable record. */
  attachRecovered(
    registration: PiChildInspectionRegistration,
  ): ResultAsync<void, PiChildInspectionHistoryError> {
    if (!this.generationOpen)
      return errAsync({
        kind: "history-write-failed",
        operation: "attach",
        reason: "invalid",
      });
    if (this.live.has(registration.id))
      return errAsync({
        kind: "history-write-failed",
        operation: "attach",
        reason: "invalid",
      });
    // Recovery attaches an already durable record. Do not call register or
    // replace the record: attachment only restores the live in-memory owner.
    this.live.set(registration.id, registration);
    if (!this.records.has(registration.id))
      this.records.set(registration.id, registration.snapshot());
    return okAsync(undefined);
  }

  register(
    registration: PiChildInspectionRegistration,
  ): ResultAsync<void, PiChildInspectionHistoryError> {
    if (!this.generationOpen) return okAsync(undefined);
    return this.enqueue(() =>
      (this.history?.register?.(registration) ?? okAsync(undefined)).map(() => {
        this.live.set(registration.id, registration);
        this.records.set(registration.id, registration.snapshot());
        return undefined;
      }),
    );
  }

  /**
   * Observes transcript growth so a live inspection view can repaint while the
   * child streams. The registry stays the single writer of transcript state.
   */
  onTranscriptUpdate(listener: ((childId: string) => void) | undefined): void {
    this.transcriptListener = listener;
  }

  checkpointEvent(
    id: string,
    event: unknown,
  ): ResultAsync<void, PiChildInspectionHistoryError> {
    if (!this.live.has(id)) return okAsync(undefined);
    const parsed = parsePiChildSessionEvent(event);
    if (parsed.success) {
      const reducer =
        this.transcriptStates.get(id) ?? new PiChildTranscriptReducer();
      reducer.applyEvent(parsed.data);
      this.transcriptStates.set(id, reducer);
      this.transcriptListener?.(id);
    }
    return this.enqueue(() =>
      (this.history?.checkpoint?.(id, event) ?? okAsync(undefined)).map(
        () => undefined,
      ),
    );
  }

  /** Read-only snapshot of the private transcript maintained from child events. */
  getTranscriptState(id: string): PiChildTranscriptState {
    return (
      this.transcriptStates.get(id)?.getState() ??
      EMPTY_PI_CHILD_TRANSCRIPT_STATE
    );
  }

  /** Model and thinking intent the child was bootstrapped with, when known. */
  getChildRuntimeMeta(id: string): {
    readonly model?: string;
    readonly thinkingLevel?: string;
  } {
    const registration = this.live.get(id);
    if (registration === undefined) return {};
    return {
      ...(registration.model === undefined
        ? {}
        : { model: registration.model }),
      ...(registration.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: registration.thinkingLevel }),
    };
  }

  checkpoint(id: string): ResultAsync<void, PiChildInspectionHistoryError> {
    if (!this.live.has(id)) return okAsync(undefined);
    return this.enqueue(() =>
      (this.history?.checkpoint?.(id) ?? okAsync(undefined)).map(() => {
        const registration = this.live.get(id);
        if (registration) this.records.set(id, registration.snapshot());
        return undefined;
      }),
    );
  }

  markInterrupted(
    id: string,
  ): ResultAsync<void, PiChildInspectionHistoryError> {
    const registration = this.live.get(id);
    if (registration === undefined) return okAsync(undefined);
    return this.enqueue(() =>
      (this.history?.interrupted?.(id) ?? okAsync(undefined)).map(() => {
        const snapshot = registration.snapshot();
        this.records.set(id, { ...snapshot, status: "cancelled" });
        registration.onInterrupted?.();
        return undefined;
      }),
    );
  }

  retainTerminal(
    id: string,
    snapshot?: PiChildTreeNode,
    finalOutput?: string,
  ): ResultAsync<void, PiChildInspectionHistoryError> {
    const registration = this.live.get(id);
    const terminal = snapshot ?? registration?.snapshot();
    if (terminal === undefined) return okAsync(undefined);
    return this.enqueue(() =>
      (
        this.history?.terminal?.(id, terminal, finalOutput) ??
        okAsync(undefined)
      ).map(() => {
        this.records.set(id, terminal);
        this.live.delete(id);
        registration?.onTerminal?.(terminal);
        return undefined;
      }),
    );
  }

  /** Live nodes for the execution tree; terminal nodes remain in history. */
  snapshotLive(): readonly PiChildTreeNode[] {
    return [...this.live.keys()]
      .map((id) => this.records.get(id))
      .filter((node): node is PiChildTreeNode => node !== undefined);
  }

  /** Live registration metadata for inspection; never includes private session text. */
  snapshotLiveRegistrations(): readonly {
    readonly registration: PiChildInspectionRegistration;
    readonly snapshot: PiChildTreeNode;
  }[] {
    return [...this.live.values()]
      .map((registration) => ({
        registration,
        snapshot: this.records.get(registration.id),
      }))
      .filter(
        (
          item,
        ): item is {
          registration: PiChildInspectionRegistration;
          snapshot: PiChildTreeNode;
        } => item.snapshot !== undefined,
      );
  }

  snapshotHistory(): readonly PiChildTreeNode[] {
    return [...this.records.values()];
  }

  snapshot(): readonly PiChildTreeNode[] {
    return this.snapshotHistory();
  }

  clearTerminal(
    isCurrent: () => boolean = () => true,
  ): ResultAsync<number, PiChildInspectionHistoryError> {
    if (!isCurrent()) return okAsync(0);
    const terminal = [...this.records.entries()].filter(([, node]) =>
      ["completed", "cancelled", "failed"].includes(node.status),
    );
    const clear = this.history?.clearTerminal;
    if (clear) {
      let clearedCount = 0;
      return this.enqueue(() => {
        if (!isCurrent()) return okAsync(undefined);
        return clear().map((count) => {
          clearedCount = count;
          if (isCurrent()) {
            for (const [id, node] of this.records) {
              if (["completed", "cancelled", "failed"].includes(node.status))
                this.records.delete(id);
            }
          }
          return undefined;
        });
      }).map(() => clearedCount);
    }
    return terminal.reduce<ResultAsync<number, PiChildInspectionHistoryError>>(
      (result, [id]) =>
        result.andThen((count) => {
          if (!isCurrent()) return okAsync(count);
          return this.enqueue(() =>
            (this.history?.clear?.(id) ?? okAsync(undefined)).map(() => {
              if (isCurrent()) this.records.delete(id);
              return undefined;
            }),
          ).map(() => count + 1);
        }),
      okAsync(0),
    );
  }

  closeGeneration(): void {
    this.generationOpen = false;
  }
}

export type PiChildStatus =
  | "queued"
  | "spawning"
  | "handshaking"
  | "bootstrapping"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export interface PiChildUsageAggregate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
}

export const EMPTY_USAGE_AGGREGATE: PiChildUsageAggregate = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

export function addUsage(
  a: PiChildUsageAggregate,
  b: Partial<PiChildUsageAggregate>,
): PiChildUsageAggregate {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: a.cacheWriteTokens + (b.cacheWriteTokens ?? 0),
    cost: a.cost + (b.cost ?? 0),
  };
}

/** One bounded, transient node in the inspectable child tree (Pi adapter contract). Never persisted. */
export interface PiChildTreeNode {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly name: string;
  readonly status: PiChildStatus;
  readonly currentTurn: number;
  readonly currentTool: string | undefined;
  readonly startedAtMs: number;
  readonly elapsedMs: number;
  readonly usage: PiChildUsageAggregate;
  /** Latest streamed output, truncated to \<=4 KiB valid UTF-8 at a code-point boundary. Transient only. */
  readonly latestOutput: string;
}

export const MAX_LATEST_OUTPUT_BYTES = 4 * 1024;

/** Truncates `text` to at most 4 KiB of UTF-8 bytes, never splitting a multi-byte code point. */
export function truncateLatestOutput(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_LATEST_OUTPUT_BYTES) return text;
  let end = MAX_LATEST_OUTPUT_BYTES;
  // Back off while the cut point lands on a UTF-8 continuation byte (10xxxxxx).
  // `end` is always a valid index here (0 <= end < bytes.length), so `?? 0`
  // only satisfies the type checker and never changes the comparison.
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, end));
}

/**
 * Reads a streamed assistant text delta from either supported Pi RPC shape:
 * the legacy `delta.text` object or 0.81.1's
 * `assistantMessageEvent: { type: "text_delta", delta: string }`. Shared by
 * the parent tree preview and child settlement summary.
 */
export function extractAssistantTextDeltaPreview(
  record: Record<string, JsonValue>,
): string | undefined {
  const delta = record.delta;
  if (typeof delta === "object" && delta !== null && !Array.isArray(delta)) {
    const text = (delta as Record<string, JsonValue>).text;
    if (typeof text === "string") return text;
  }

  const assistantEvent = record.assistantMessageEvent;
  if (
    typeof assistantEvent !== "object" ||
    assistantEvent === null ||
    Array.isArray(assistantEvent)
  ) {
    return undefined;
  }
  const eventRecord = assistantEvent as Record<string, JsonValue>;
  if (eventRecord.type !== "text_delta") return undefined;
  return typeof eventRecord.delta === "string" ? eventRecord.delta : undefined;
}

/**
 * Reads a streamed assistant *thinking* delta from a Pi RPC `message_update`
 * record (`assistantMessageEvent: { type: "thinking_delta", delta: string }`).
 *
 * A reasoning model can think for a long time before it emits a single
 * visible text token. Without this, a delegated child looks frozen for that
 * entire stretch: `latestOutput` stays empty and the parent tool renders
 * nothing but a status. Thinking is treated exactly like text - transient,
 * bounded, and never persisted - but is tracked in its own buffer by the
 * caller so real answer text always wins once it starts.
 */
export function extractAssistantThinkingDeltaPreview(
  record: Record<string, JsonValue>,
): string | undefined {
  const assistantEvent = record.assistantMessageEvent;
  if (
    typeof assistantEvent !== "object" ||
    assistantEvent === null ||
    Array.isArray(assistantEvent)
  ) {
    return undefined;
  }
  const eventRecord = assistantEvent as Record<string, JsonValue>;
  if (eventRecord.type !== "thinking_delta") return undefined;
  return typeof eventRecord.delta === "string" ? eventRecord.delta : undefined;
}

/**
 * Reads the terminal `stopReason` of a just-completed assistant message from
 * a `message_end` event record, if present.
 *
 * Limitation (Task 9): Pi's `agent_settled` event carries no
 * payload at all (`{"type":"agent_settled"}` per the pi-coding-agent RPC
 * docs) - it cannot itself tell us whether the run that just settled ended
 * in error. The one observable signal the RPC protocol exposes for this is
 * the last assistant message's `stopReason` (`"stop"`, `"length"`,
 * `"toolUse"`, `"error"`, or `"aborted"`), delivered on `message_end`. A
 * child tracks this value across `message_end` events and consults it when
 * `agent_settled` fires, instead of trusting `agent_settled` to carry an
 * outcome it structurally cannot express.
 */
export function extractAssistantStopReason(
  record: Record<string, JsonValue>,
): string | undefined {
  const message = record.message;
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return undefined;
  }
  const messageRecord = message as Record<string, JsonValue>;
  if (messageRecord.role !== "assistant") return undefined;
  const stopReason = messageRecord.stopReason;
  return typeof stopReason === "string" ? stopReason : undefined;
}

export interface PiChildTreeSnapshot {
  readonly nodes: readonly PiChildTreeNode[];
  readonly selectedId: string;
}

export type PiTreeControlKey =
  | { readonly kind: "select-direct-child"; readonly index: number }
  | { readonly kind: "select-parent" }
  | { readonly kind: "cancel-selected" };

export type PiTreeControlOutcome =
  | { readonly kind: "selected"; readonly nodeId: string }
  | { readonly kind: "cancel-requested"; readonly nodeId: string }
  /** Root preserves normal host editor/Esc behavior - caller must not intercept. */
  | { readonly kind: "host-default" }
  | { readonly kind: "no-target" };

/**
 * Pure reducer implementing Alt+1..Alt+9 (select the Nth direct child of the
 * selected node, ordered by spawn time), Backspace (select parent; a
 * no-parent selection - the root - reports `host-default` so the caller
 * preserves normal editor behavior), and Esc (request cancellation of the
 * selected subtree; at root, reports `host-default` so the caller preserves
 * normal Esc behavior) - Pi adapter contract.
 */
export function applyTreeControlKey(
  nodes: ReadonlyMap<string, PiChildTreeNode>,
  selectedId: string,
  key: PiTreeControlKey,
): PiTreeControlOutcome {
  if (key.kind === "select-direct-child") {
    const directChildren = [...nodes.values()]
      .filter((node) => node.parentId === selectedId)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
    const target = directChildren[key.index - 1];
    if (target === undefined) return { kind: "no-target" };
    return { kind: "selected", nodeId: target.id };
  }
  if (key.kind === "select-parent") {
    const current = nodes.get(selectedId);
    if (current === undefined || current.parentId === undefined) {
      return { kind: "host-default" };
    }
    return { kind: "selected", nodeId: current.parentId };
  }
  if (selectedId === ROOT_NODE_ID) return { kind: "host-default" };
  if (!nodes.has(selectedId)) return { kind: "no-target" };
  return { kind: "cancel-requested", nodeId: selectedId };
}

/** Returns `nodeId` and every descendant id (inclusive), for whole-subtree cancellation/cleanup. */
export function subtreeIds(
  nodes: ReadonlyMap<string, PiChildTreeNode>,
  nodeId: string,
): readonly string[] {
  const result: string[] = [nodeId];
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentId === undefined) continue;
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push(node.id);
    childrenByParent.set(node.parentId, list);
  }
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}
