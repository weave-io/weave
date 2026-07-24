/**
 * Bounded, inspectable child-tree state and the selection/cancel control
 * model (Spec 33 §11.5). Pure data and a pure reducer - no process, I/O, or
 * Pi dependency - so the tree UI's control semantics can be fully unit
 * tested without a real host.
 */

import type { JsonValue } from "./strict-json.js";

export const ROOT_NODE_ID = "root";

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

/** One bounded, transient node in the inspectable child tree (Spec 33 §11.5). Never persisted. */
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
 * Reads the terminal `stopReason` of a just-completed assistant message from
 * a `message_end` event record, if present.
 *
 * Limitation (Task 9 finding 2): Pi's `agent_settled` event carries no
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
 * normal Esc behavior) - Spec 33 §11.5.
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
