/**
 * Parent-local child reconstruction (Pi adapter contract).
 *
 * A Pi session transition (`/new`, `/resume`, `/fork`, `/clone`, `/tree`)
 * revokes the whole generation: the delegation controller, its in-memory child
 * tree, and every derived projection are discarded. Returning to a *source*
 * parent session therefore starts a fresh generation that has never run a
 * child, even though the source parent still owns authoritative child refs in
 * its own entry ledger.
 *
 * `/weave:inspect` already reads those refs directly, which is why the picker
 * and the settled overlay keep working after a return. `/weave:status` counts
 * the live tree, and `/weave:history` reads the derivative metadata cache, so
 * both reported nothing for a parent whose only children belong to an earlier
 * generation.
 *
 * This module closes that gap. It reads the same authoritative, bounded,
 * metadata-only parent-local refs, projects them into the metadata cache, and
 * exposes pure merge helpers the status and history surfaces use. Origin
 * authority is not re-derived here: `readRefs` already excludes refs minted by
 * a different parent session, and this module re-checks the immutable
 * `originParentSessionId` against the live parent as defence in depth, so a
 * clone/fork destination can never surface its source's children and a source
 * can never surface a destination's.
 *
 * Nothing here reads prompts, transcripts, or filesystem paths, and nothing
 * here can create, repair, or resume a child session.
 */

import { errAsync, Result, type ResultAsync } from "neverthrow";
import type {
  PiChildRefError,
  PiChildRefRecord,
  PiChildRefScan,
  PiChildRefStatus,
} from "./child-session-refs.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Hard bounds applied to every reconstruction, independent of caller input. */
export const PI_CHILD_RECONSTRUCTION_BOUNDS = Object.freeze({
  /** Refs consumed by one reconstruction pass. */
  maxRefs: 200,
  /** Children retained in one summary. */
  maxChildren: 200,
  /** Rows one merged history render may contain. */
  maxHistoryRows: 200,
  /** Reconstructed children named in one status render. */
  maxStatusLines: 20,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One reconstructed, parent-local child. Metadata only: exactly the fields the
 * authoritative ref already carries, and never any prompt or transcript text.
 */
export interface PiReconstructedChild {
  readonly childId: string;
  readonly threadId: string;
  readonly title: string;
  readonly status: PiChildRefStatus;
  readonly originParentSessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly settledAt?: number;
}

/** Bounded, secret-free counters one reconstruction produced. */
export interface PiChildReconstructionCounts {
  readonly scannedEntries: number;
  readonly usableRefs: number;
  readonly reconstructedChildren: number;
  readonly originMismatchedChildren: number;
  readonly cachedRows: number;
  readonly skippedRefs: number;
}

/** Result of one reconstruction pass for one live parent session. */
export interface PiChildReconstructionSummary {
  /** The live parent this summary belongs to. Guards stale reuse. */
  readonly parentSessionId: string;
  readonly workspaceKey: string;
  readonly children: readonly PiReconstructedChild[];
  readonly counts: PiChildReconstructionCounts;
}

/** Closed failure set. Every variant is bounded and secret-free. */
export type PiChildReconstructionError =
  | {
      readonly type: "ReconstructionParentUnavailable";
      readonly reason: "empty-parent-session-id" | "empty-workspace-key";
    }
  | {
      readonly type: "ReconstructionRefsUnreadable";
      readonly reason: PiChildRefError["type"];
    };

/** Human-readable, secret-free diagnostic for one reconstruction failure. */
export function describeChildReconstructionError(
  error: PiChildReconstructionError,
): string {
  switch (error.type) {
    case "ReconstructionParentUnavailable":
      return `Weave could not reconstruct this session's children (${error.reason}).`;
    case "ReconstructionRefsUnreadable":
      return `Weave could not read this session's authoritative child refs (${error.reason}).`;
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The read slice of the Task 5 ref store this module needs. Deliberately
 * exposes no append surface: reconstruction observes and never writes refs.
 */
export interface PiChildReconstructionRefPort {
  liveParentSessionId(): string;
  readRefs(input?: {
    readonly limit?: number;
  }): ResultAsync<PiChildRefScan, PiChildRefError>;
}

/**
 * The write slice of the Task 6 metadata cache this module needs. The cache is
 * derivative: an `upsertRef` failure degrades the projection and never fails
 * the reconstruction, because the summary itself is authoritative enough for
 * status and history.
 */
export interface PiChildReconstructionCachePort {
  upsertRef(
    ref: PiChildRefRecord,
    workspaceKey: string,
  ): Result<unknown, unknown>;
}

export interface PiChildReconstructionInput {
  readonly refs: PiChildReconstructionRefPort;
  readonly workspaceKey: string;
  /**
   * The live parent session id. When omitted, the ref port's own live parent
   * is used. A mismatch between the two is treated as origin mismatch, so a
   * destination generation holding a source's ref port reconstructs nothing.
   */
  readonly parentSessionId?: string;
  readonly cache?: PiChildReconstructionCachePort | undefined;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return PI_CHILD_RECONSTRUCTION_BOUNDS.maxRefs;
  }
  const floored = Math.floor(limit);
  if (floored <= 0) return 0;
  return Math.min(floored, PI_CHILD_RECONSTRUCTION_BOUNDS.maxRefs);
}

function reconstructedFromRef(ref: PiChildRefRecord): PiReconstructedChild {
  return {
    childId: ref.childId,
    threadId: ref.threadId,
    title: ref.title,
    status: ref.status,
    originParentSessionId: ref.originParentSessionId,
    createdAt: ref.createdAt,
    updatedAt: ref.updatedAt,
    ...(ref.settledAt === undefined ? {} : { settledAt: ref.settledAt }),
  };
}

/**
 * Reads the live parent's own authoritative refs and projects them into the
 * derivative metadata cache.
 *
 * Idempotent by construction: the ref scan already collapses a child's entry
 * history to its newest record, and the cache upsert is keyed by
 * `(workspace, child, origin parent)`. Running this on every return to the
 * same source parent therefore produces the same summary and the same rows,
 * never duplicates.
 *
 * Fails closed on unreadable refs; a missing or failing cache only degrades
 * the projection.
 */
export function reconstructParentLocalChildren(
  input: PiChildReconstructionInput,
): ResultAsync<PiChildReconstructionSummary, PiChildReconstructionError> {
  const parentSessionId =
    input.parentSessionId ?? input.refs.liveParentSessionId();
  if (parentSessionId.length === 0) {
    return errAsync({
      type: "ReconstructionParentUnavailable",
      reason: "empty-parent-session-id",
    });
  }
  if (input.workspaceKey.length === 0) {
    return errAsync({
      type: "ReconstructionParentUnavailable",
      reason: "empty-workspace-key",
    });
  }
  const limit = boundedLimit(input.limit);
  return input.refs
    .readRefs({ limit })
    .mapErr(
      (error): PiChildReconstructionError => ({
        type: "ReconstructionRefsUnreadable",
        reason: error.type,
      }),
    )
    .map((scan) => collectSummary(scan, parentSessionId, input));
}

function collectSummary(
  scan: PiChildRefScan,
  parentSessionId: string,
  input: PiChildReconstructionInput,
): PiChildReconstructionSummary {
  const children: PiReconstructedChild[] = [];
  const seen = new Set<string>();
  let originMismatchedChildren = scan.counts.originMismatchedChildren;
  let cachedRows = 0;
  let skippedRefs = 0;

  for (const ref of scan.refs) {
    if (children.length >= PI_CHILD_RECONSTRUCTION_BOUNDS.maxChildren) {
      skippedRefs += 1;
      continue;
    }
    // Defence in depth. `readRefs` already excluded refs minted by another
    // parent, but a destination generation must never surface a source's
    // children even if it is handed the wrong ref port.
    if (ref.originParentSessionId !== parentSessionId) {
      originMismatchedChildren += 1;
      skippedRefs += 1;
      continue;
    }
    if (seen.has(ref.childId)) {
      skippedRefs += 1;
      continue;
    }
    seen.add(ref.childId);
    children.push(reconstructedFromRef(ref));
    const cache = input.cache;
    if (cache === undefined) continue;
    // The cache is derivative: a throwing or failing upsert degrades the
    // projection and never fails the reconstruction.
    const written = Result.fromThrowable(
      () => cache.upsertRef(ref, input.workspaceKey),
      () => undefined,
    )();
    const cached = written.match(
      (inner) => inner.isOk(),
      () => false,
    );
    if (cached) cachedRows += 1;
  }

  return {
    parentSessionId,
    workspaceKey: input.workspaceKey,
    children,
    counts: {
      scannedEntries: scan.counts.scannedEntries,
      usableRefs: scan.counts.usableRefs,
      reconstructedChildren: children.length,
      originMismatchedChildren,
      cachedRows,
      skippedRefs,
    },
  };
}

// ---------------------------------------------------------------------------
// Generation-scoped cell
// ---------------------------------------------------------------------------

/**
 * Generation-scoped reconstruction state. A fresh generation must never read
 * an earlier generation's summary, so both the generation and the parent
 * session id are recorded and checked on read.
 */
export interface PiChildReconstructionCell {
  value: PiChildReconstructionSummary | undefined;
  generationId: string | undefined;
}

export function createChildReconstructionCell(): PiChildReconstructionCell {
  return { value: undefined, generationId: undefined };
}

/** Publishes one summary for one generation, replacing any earlier value. */
export function publishChildReconstruction(
  cell: PiChildReconstructionCell,
  generationId: string,
  summary: PiChildReconstructionSummary,
): void {
  cell.value = summary;
  cell.generationId = generationId;
}

/** Clears the cell. Idempotent; safe on every revoke path. */
export function clearChildReconstruction(
  cell: PiChildReconstructionCell,
): void {
  cell.value = undefined;
  cell.generationId = undefined;
}

/**
 * Reads the summary only when it belongs to the asking generation *and* the
 * live parent session. Anything else reads as absent, so a stale callback or a
 * clone/fork destination can never render another parent's children.
 */
export function readChildReconstruction(
  cell: PiChildReconstructionCell,
  generationId: string | undefined,
  parentSessionId: string | undefined,
): PiChildReconstructionSummary | undefined {
  const summary = cell.value;
  if (summary === undefined) return undefined;
  if (generationId === undefined || cell.generationId !== generationId) {
    return undefined;
  }
  if (parentSessionId === undefined) return undefined;
  if (summary.parentSessionId !== parentSessionId) return undefined;
  return summary;
}

// ---------------------------------------------------------------------------
// Status merge
// ---------------------------------------------------------------------------

/** The live-tree slice the status merge needs. */
export interface PiReconstructionTreeNode {
  readonly id: string;
}

/**
 * Reconstructed children the live tree does not already contain, newest
 * first. Live children always win: a child this generation is running must
 * never be double-counted by its own ref.
 */
export function reconstructedChildrenNotLive(
  tree: readonly PiReconstructionTreeNode[],
  summary: PiChildReconstructionSummary | undefined,
): readonly PiReconstructedChild[] {
  if (summary === undefined) return [];
  const live = new Set(tree.map((node) => node.id));
  return summary.children.filter((child) => !live.has(child.childId));
}

/** Total children a parent owns right now: live plus reconstructed. */
export function countParentLocalChildren(
  tree: readonly PiReconstructionTreeNode[],
  summary: PiChildReconstructionSummary | undefined,
): number {
  return tree.length + reconstructedChildrenNotLive(tree, summary).length;
}

/** Bounded, metadata-only status lines for reconstructed children. */
export function renderReconstructedStatusLines(
  tree: readonly PiReconstructionTreeNode[],
  summary: PiChildReconstructionSummary | undefined,
): readonly string[] {
  const pending = reconstructedChildrenNotLive(tree, summary);
  if (pending.length === 0) return [];
  const shown = pending.slice(0, PI_CHILD_RECONSTRUCTION_BOUNDS.maxStatusLines);
  const lines = shown.map(
    (child) => `  ${child.childId}  ${child.status}  ${child.title}`,
  );
  if (pending.length > shown.length) {
    lines.push(`  … ${pending.length - shown.length} more`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// History merge
// ---------------------------------------------------------------------------

/** The history row shape `/weave:history` renders. */
export interface PiHistoryRow {
  readonly childId: string;
  readonly status: string;
  readonly title: string;
  readonly tombstoned: boolean;
}

/**
 * Merges cache-backed history rows with reconstructed parent-local children.
 *
 * Cache rows win on child id, so an active cache stays the rendered truth and
 * a returning source parent still lists a completed child whose derivative row
 * was never written or was lost with an earlier generation.
 */
export function mergeReconstructedHistoryRows(
  cacheRows: readonly PiHistoryRow[],
  summary: PiChildReconstructionSummary | undefined,
): readonly PiHistoryRow[] {
  const seen = new Set(cacheRows.map((row) => row.childId));
  const merged: PiHistoryRow[] = cacheRows.slice(
    0,
    PI_CHILD_RECONSTRUCTION_BOUNDS.maxHistoryRows,
  );
  if (summary === undefined) return merged;
  for (const child of summary.children) {
    if (merged.length >= PI_CHILD_RECONSTRUCTION_BOUNDS.maxHistoryRows) break;
    if (seen.has(child.childId)) continue;
    seen.add(child.childId);
    merged.push({
      childId: child.childId,
      status: child.status,
      title: child.title,
      tombstoned: false,
    });
  }
  return merged;
}
