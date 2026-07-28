/**
 * Bounded, inspectable child-tree state and the selection/cancel control
 * model (Pi adapter contract). Pure data and a pure reducer - no process, I/O, or
 * Pi dependency - so the tree UI's control semantics can be fully unit
 * tested without a real host.
 */

import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { PiChildHistoryRecord } from "./child-history-schema.js";
import type {
  PiChildHistoryStore,
  PiChildHistoryStoreError,
} from "./child-history-store.js";
import { preserveUnknownChildEvent } from "./child-session-events.js";
import type { JsonValue } from "./strict-json.js";

export const ROOT_NODE_ID = "root";

/**
 * Shared per-generation child registry. Execution owners keep their own
 * process maps and budgets; this registry is the single topology/inspection
 * view for ordinary, nested, and workflow-step children. Terminal snapshots
 * remain after the process owner disposes the child.
 */
export type PiChildInspectionHistoryError = {
  readonly kind: "history-write-failed";
  readonly operation: "register" | "checkpoint" | "interrupted" | "terminal";
  readonly reason: "unavailable" | "corrupt" | "quota" | "invalid";
};

function statusForSnapshot(
  snapshot: PiChildTreeNode,
):
  | "queued"
  | "running"
  | "settled"
  | "interrupted"
  | "quarantined"
  | "cleared" {
  if (snapshot.status === "cancelled") return "interrupted";
  if (snapshot.status === "completed") return "settled";
  return "running";
}

function mapHistoryError(
  operation: PiChildInspectionHistoryError["operation"],
  error: PiChildHistoryStoreError,
): PiChildInspectionHistoryError {
  let reason: PiChildInspectionHistoryError["reason"];
  if (error.type === "quota-exceeded") reason = "quota";
  else if (error.type === "history-disabled") reason = "unavailable";
  else if (
    error.type === "history-json" ||
    error.type === "history-schema" ||
    error.type === "history-quarantined"
  )
    reason = "corrupt";
  else reason = "invalid";
  return { kind: "history-write-failed", operation, reason };
}

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
}

/** Adapts the persistent Task 5 store without leaking store details into controllers. */
export function createPiChildHistoryPort(
  store: PiChildHistoryStore,
  now: () => number = Date.now,
): PiChildInspectionHistoryPort {
  const base = (
    registration: PiChildInspectionRegistration,
    snapshot: PiChildTreeNode,
  ): PiChildHistoryRecord => ({
    childId: registration.id,
    parentSessionId: store.parentSessionId,
    parentChildId:
      registration.parentId === ROOT_NODE_ID
        ? undefined
        : registration.parentId,
    kind: registration.kind,
    status: statusForSnapshot(snapshot),
    workflow: {
      workflow: registration.workflowInstanceId,
      step: registration.stepName,
    },
    sessionPath: `children/${registration.id}/session.jsonl`,
    checkpointCursor: 0,
    branchAncestry: [],
    interventionCount: 0,
    finalOutput: "",
    trim: { trimmed: false, markerCount: 0 },
    quarantine: { quarantined: false },
    clear: { cleared: false },
    recovery: { eligible: false, count: 0 },
    bytes: { session: 0, checkpoint: 0, total: 0 },
    createdAt: now(),
    updatedAt: now(),
  });
  const registrations = new Map<string, PiChildInspectionRegistration>();
  let checkpointSequence = 0;
  const nextCheckpointId = (id: string) =>
    `${id}-${now()}-${checkpointSequence++}`;
  const mapped = <T>(
    operation: PiChildInspectionHistoryError["operation"],
    result: ResultAsync<T, PiChildHistoryStoreError>,
  ) => result.mapErr((error) => mapHistoryError(operation, error));
  return {
    register: (registration) =>
      mapped(
        "register",
        store
          .upsertRecord(base(registration, registration.snapshot()))
          .map(() => {
            registrations.set(registration.id, registration);
            return undefined;
          }),
      ),
    checkpoint: (id, event) => {
      const registration = registrations.get(id);
      if (!registration) return okAsync(undefined);
      const checkpoint =
        event === undefined
          ? store.updateRecord(id, {})
          : (() => {
              const normalized = preserveUnknownChildEvent(event);
              return store
                .appendSessionEvent(id, normalized)
                .andThen(() =>
                  store.appendCheckpoint(id, [
                    {
                      id: nextCheckpointId(id),
                      kind: "session-event",
                      payload: normalized as unknown as JsonValue,
                    },
                  ]),
                )
                .map(() => undefined);
            })();
      return mapped("checkpoint", checkpoint);
    },
    interrupted: (id) =>
      mapped("interrupted", store.updateRecord(id, { status: "interrupted" })),
    terminal: (id, snapshot, finalOutput) =>
      mapped(
        "terminal",
        store.updateRecord(id, {
          status: snapshot.status === "completed" ? "settled" : "interrupted",
          ...(finalOutput === undefined ? {} : { finalOutput }),
        }),
      ),
  };
}
export interface PiChildInspectionRegistration {
  readonly id: string;
  readonly parentId: string;
  readonly name: string;
  readonly kind: "ordinary" | "nested" | "workflow-step";
  readonly snapshot: () => PiChildTreeNode;
  readonly workflowInstanceId?: string;
  readonly stepName?: string;
  readonly onInterrupted?: () => void;
  readonly onTerminal?: (snapshot: PiChildTreeNode) => void;
}

export class PiChildInspectionRegistry {
  private readonly live = new Map<string, PiChildInspectionRegistration>();
  private readonly records = new Map<string, PiChildTreeNode>();
  private generationOpen = true;
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

  checkpointEvent(
    id: string,
    event: unknown,
  ): ResultAsync<void, PiChildInspectionHistoryError> {
    if (!this.live.has(id)) return okAsync(undefined);
    return this.enqueue(() =>
      (this.history?.checkpoint?.(id, event) ?? okAsync(undefined)).map(
        () => undefined,
      ),
    );
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

  snapshotHistory(): readonly PiChildTreeNode[] {
    return [...this.records.values()];
  }

  snapshot(): readonly PiChildTreeNode[] {
    return this.snapshotHistory();
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
