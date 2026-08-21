import { err, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import { enforceDurableChildTitle } from "./child-title.js";

export type PiChildPickerKind =
  | "root"
  | "ordinary"
  | "nested"
  | "workflow-step"
  | "history";
export interface PiChildPickerNode {
  readonly childId: string;
  readonly name: string;
  readonly kind: PiChildPickerKind;
  readonly parentId?: string;
  readonly status: string;
  /**
   * A short, user-visible activity line.
   *
   * It carries the child's own ANSWER text or a canonical activity fact, never
   * raw chain-of-thought. Build it with {@link childPickerPreview} rather than
   * from a reasoning buffer.
   */
  readonly preview?: string;
  readonly live: boolean;
  readonly recoverable?: boolean;
  readonly resumable?: boolean;
  readonly currentTool?: string;
  readonly generationId?: string;
  readonly workflowInstanceId?: string;
  readonly stepName?: string;
}
export interface PiChildPickerEntry {
  readonly id: string;
  readonly label: string;
  readonly preview: string;
  readonly depth: number;
  readonly node?: PiChildPickerNode;
  readonly action?: "recover" | "resume" | "clear";
}
export interface PiChildPickerInput {
  readonly rootLabel?: string;
  readonly live: readonly PiChildPickerNode[];
  readonly history?: readonly PiChildPickerNode[];
}
export type PiChildPickerError = {
  readonly type: "invalid-picker-input";
  readonly detail: string;
};

/** Hard bounds for the Spec 33 §8.2 metadata picker. */
export const PI_CHILD_PICKER_BOUNDS = Object.freeze({
  maxCandidates: 200,
  maxResults: 200,
  maxIdLength: 256,
  maxTitleLength: 200,
  maxLabelLength: 128,
  maxTimestamp: 4_102_444_800_000,
});

/**
 * Every status the metadata picker accepts. Matches Task 6 / Spec 33 planned
 * child statuses plus the historical inspection statuses the legacy picker
 * already surfaces.
 */
export const PI_CHILD_PICKER_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "settled",
  "interrupted",
  "quarantined",
  "cleared",
  "tombstoned",
] as const);

export type PiChildPickerStatus = (typeof PI_CHILD_PICKER_STATUSES)[number];

const PICKER_STATUS_SET: ReadonlySet<string> = new Set(
  PI_CHILD_PICKER_STATUSES,
);

/** Authoritative-source availability for one picker candidate. */
export type PiChildPickerSourceState =
  | "available"
  | "stale"
  | "unavailable"
  | "orphan";

export interface PiChildPickerCandidate {
  readonly childId: string;
  readonly threadId: string;
  readonly parentId?: string;
  readonly status: PiChildPickerStatus;
  readonly explicitTitle?: string;
  readonly workflowStep?: string;
  readonly agent: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly active: boolean;
  /** Stable tree order among active siblings/lineage. */
  readonly treeOrder: number;
  readonly sourceState: PiChildPickerSourceState;
}

export interface PiChildPickerMetadataEntry {
  readonly childId: string;
  readonly threadId: string;
  readonly parentId?: string;
  readonly status: PiChildPickerStatus;
  /** Bounded display title after precedence resolution. */
  readonly title: string;
  /** Local list timestamp from the injected formatter. */
  readonly timestampLabel: string;
  readonly active: boolean;
  readonly treeOrder: number;
  readonly agent: string;
  /** Orphan rows are listed read-only; mutations stay disabled. */
  readonly readOnly: boolean;
  readonly sourceState: "available" | "orphan";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PiChildPickerMetadataInput {
  readonly candidates: readonly PiChildPickerCandidate[];
  /** Injected local-locale formatter — never `Date#toLocaleString` in tests. */
  readonly formatTimestamp: (epochMs: number) => string;
}

const MAX_PICKER_PREVIEW_LENGTH = 240;
// Built from named sources rather than inline literals: a regex literal here
// would carry control characters, which the repo lint forbids.
const ANSI_ESCAPE_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)`;
const CONTROL_CHARACTER_SOURCE = String.raw`[\u0000-\u001f\u007f]`;
const ANSI_ESCAPE_PATTERN = new RegExp(ANSI_ESCAPE_SOURCE, "g");
const CONTROL_CHARACTER_PATTERN = new RegExp(CONTROL_CHARACTER_SOURCE, "g");
function sanitize(value: string | undefined): string {
  if (!value) return "";
  const clean = value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > MAX_PICKER_PREVIEW_LENGTH
    ? `${clean.slice(0, MAX_PICKER_PREVIEW_LENGTH - 1)}…`
    : clean;
}

function boundLabel(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Title precedence: explicit title → workflow step → agent.
 *
 * Spec 33 §4.2/§13 and Threat Model T6: no branch of this function may read
 * task text, prompt text, tool input, child output or transcript content. The
 * `explicitTitle` here is a stored durable title that was itself derived from
 * trusted identity metadata (see `child-title.ts`), never a caller free-text.
 */
export function resolveChildPickerTitle(
  candidate: Pick<
    PiChildPickerCandidate,
    "explicitTitle" | "workflowStep" | "agent"
  >,
): string {
  const explicit = boundLabel(
    sanitize(candidate.explicitTitle),
    PI_CHILD_PICKER_BOUNDS.maxTitleLength,
  );
  if (explicit.length > 0) return explicit;
  const step = boundLabel(
    sanitize(candidate.workflowStep),
    PI_CHILD_PICKER_BOUNDS.maxLabelLength,
  );
  if (step.length > 0) return step;
  return boundLabel(
    sanitize(candidate.agent) || "child",
    PI_CHILD_PICKER_BOUNDS.maxLabelLength,
  );
}

function isExcludedSourceState(
  state: PiChildPickerSourceState,
): state is "stale" | "unavailable" {
  return state === "stale" || state === "unavailable";
}

function compareMetadataCandidates(
  a: PiChildPickerCandidate,
  b: PiChildPickerCandidate,
): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.active && b.active) {
    if (a.treeOrder !== b.treeOrder) return a.treeOrder - b.treeOrder;
    if (a.childId < b.childId) return -1;
    if (a.childId > b.childId) return 1;
    return 0;
  }
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.childId < b.childId) return -1;
  if (a.childId > b.childId) return 1;
  return 0;
}

function validateMetadataCandidate(
  candidate: PiChildPickerCandidate,
): Result<PiChildPickerCandidate, PiChildPickerError> {
  if (
    !candidate.childId ||
    candidate.childId.length > PI_CHILD_PICKER_BOUNDS.maxIdLength
  ) {
    return err({
      type: "invalid-picker-input",
      detail: "child ids must be unique and non-empty",
    });
  }
  if (
    !candidate.threadId ||
    candidate.threadId.length > PI_CHILD_PICKER_BOUNDS.maxIdLength
  ) {
    return err({
      type: "invalid-picker-input",
      detail: "thread ids must be non-empty",
    });
  }
  if (
    candidate.parentId !== undefined &&
    (candidate.parentId.length === 0 ||
      candidate.parentId.length > PI_CHILD_PICKER_BOUNDS.maxIdLength)
  ) {
    return err({
      type: "invalid-picker-input",
      detail: "parent ids must be non-empty when set",
    });
  }
  if (!PICKER_STATUS_SET.has(candidate.status)) {
    return err({
      type: "invalid-picker-input",
      detail: `unknown status ${candidate.status}`,
    });
  }
  if (
    !Number.isFinite(candidate.createdAt) ||
    !Number.isFinite(candidate.updatedAt) ||
    candidate.createdAt < 0 ||
    candidate.updatedAt < 0 ||
    candidate.createdAt > PI_CHILD_PICKER_BOUNDS.maxTimestamp ||
    candidate.updatedAt > PI_CHILD_PICKER_BOUNDS.maxTimestamp
  ) {
    return err({
      type: "invalid-picker-input",
      detail: "timestamps must be bounded non-negative numbers",
    });
  }
  if (!Number.isFinite(candidate.treeOrder)) {
    return err({
      type: "invalid-picker-input",
      detail: "treeOrder must be a finite number",
    });
  }
  if (
    !candidate.agent ||
    candidate.agent.length > PI_CHILD_PICKER_BOUNDS.maxLabelLength
  ) {
    return err({
      type: "invalid-picker-input",
      detail: "agent must be a non-empty bounded label",
    });
  }
  return ok(candidate);
}

/**
 * Spec 33 §8.2 metadata picker: bounded candidates, title precedence, active
 * first then newest settled, orphan read-only, stale/unavailable excluded.
 */
export function buildChildPickerMetadataEntries(
  input: PiChildPickerMetadataInput,
): Result<readonly PiChildPickerMetadataEntry[], PiChildPickerError> {
  if (typeof input.formatTimestamp !== "function") {
    return err({
      type: "invalid-picker-input",
      detail: "formatTimestamp is required",
    });
  }
  if (input.candidates.length > PI_CHILD_PICKER_BOUNDS.maxCandidates) {
    return err({
      type: "invalid-picker-input",
      detail: `at most ${PI_CHILD_PICKER_BOUNDS.maxCandidates} candidates`,
    });
  }

  const seen = new Set<string>();
  const included: PiChildPickerCandidate[] = [];
  for (const candidate of input.candidates) {
    const validated = validateMetadataCandidate(candidate);
    if (validated.isErr()) return err(validated.error);
    if (seen.has(candidate.childId)) {
      return err({
        type: "invalid-picker-input",
        detail: "child ids must be unique and non-empty",
      });
    }
    seen.add(candidate.childId);
    if (isExcludedSourceState(candidate.sourceState)) continue;
    included.push(candidate);
  }

  included.sort(compareMetadataCandidates);
  const bounded = included.slice(0, PI_CHILD_PICKER_BOUNDS.maxResults);
  const entries: PiChildPickerMetadataEntry[] = bounded.map((candidate) => {
    const orphan = candidate.sourceState === "orphan";
    return {
      childId: candidate.childId,
      threadId: candidate.threadId,
      ...(candidate.parentId === undefined
        ? {}
        : { parentId: candidate.parentId }),
      status: candidate.status,
      title: resolveChildPickerTitle(candidate),
      timestampLabel: input.formatTimestamp(candidate.updatedAt),
      active: candidate.active,
      treeOrder: candidate.treeOrder,
      agent: boundLabel(
        sanitize(candidate.agent),
        PI_CHILD_PICKER_BOUNDS.maxLabelLength,
      ),
      readOnly: orphan,
      sourceState: orphan ? "orphan" : "available",
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    };
  });
  return ok(Object.freeze(entries));
}

export const createChildPickerMetadataEntries = buildChildPickerMetadataEntries;

// ---------------------------------------------------------------------------
// Candidate collection (active tree + Task 6 cache, Task 5 refs on degrade)
// ---------------------------------------------------------------------------

/**
 * One live child as the delegation controller / inspection registry sees it.
 * Active rows are authoritative on their own: they are running in this very
 * process, so they never need a cache or source round-trip.
 */
export interface PiChildPickerActiveChild {
  readonly childId: string;
  readonly threadId: string;
  readonly parentId?: string;
  readonly status: PiChildPickerStatus;
  readonly explicitTitle?: string;
  readonly workflowStep?: string;
  readonly agent: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Position in the stable active tree order. */
  readonly treeOrder: number;
}

/** The bounded slice of one Task 6 cache record the picker reads. */
export interface PiChildPickerCacheRecord {
  readonly childId: string;
  readonly threadId: string;
  readonly title: string;
  /** Versioned proof that `title` came from trusted identity metadata. */
  readonly titleProvenance?: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly originParentSessionId: string;
  readonly stale: boolean;
  readonly tombstoned: boolean;
}

export interface PiChildPickerCachePage {
  readonly records: readonly PiChildPickerCacheRecord[];
}

/** The bounded slice of one Task 5 ref the degraded fallback reads. */
export interface PiChildPickerRefRecord {
  readonly childId: string;
  readonly threadId: string;
  readonly title: string;
  /** Versioned proof that `title` came from trusted identity metadata. */
  readonly titleProvenance?: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly originParentSessionId: string;
}

/**
 * Cache read surface. `list` is the bounded page; `validate` re-checks one
 * specific row against the authoritative session before it is offered.
 */
export interface PiChildPickerCachePort {
  list(input: {
    readonly workspaceKey: string;
    readonly parentSessionId?: string;
    readonly limit: number;
  }): ResultAsync<PiChildPickerCachePage, unknown>;
  /**
   * Resolves to the source state of one row. Implementations wrap the Task 6
   * `get`, whose failure already carries the unusable state.
   */
  validate(childId: string): ResultAsync<PiChildPickerSourceState, never>;
}

/** Bounded current-parent ref scan, used only when the cache is degraded. */
export interface PiChildPickerRefPort {
  readRefs(input: {
    readonly limit: number;
  }): ResultAsync<readonly PiChildPickerRefRecord[], unknown>;
}

export interface PiChildPickerCandidateInput {
  readonly active: readonly PiChildPickerActiveChild[];
  readonly workspaceKey: string;
  /** The current parent session; also decides which rows are orphans. */
  readonly parentSessionId: string;
  readonly cache?: PiChildPickerCachePort;
  /** Set when the Task 6 cache is degraded and the ref fallback must be used. */
  readonly cacheDegraded?: boolean;
  readonly refs?: PiChildPickerRefPort;
  readonly limit?: number;
}

function coerceStatus(value: string): PiChildPickerStatus | undefined {
  return PICKER_STATUS_SET.has(value)
    ? (value as PiChildPickerStatus)
    : undefined;
}

function clampCandidateLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return PI_CHILD_PICKER_BOUNDS.maxCandidates;
  }
  return Math.max(
    1,
    Math.min(Math.floor(limit), PI_CHILD_PICKER_BOUNDS.maxCandidates),
  );
}

function activeCandidate(
  child: PiChildPickerActiveChild,
): PiChildPickerCandidate {
  return {
    childId: child.childId,
    threadId: child.threadId,
    ...(child.parentId === undefined ? {} : { parentId: child.parentId }),
    status: child.status,
    ...(child.explicitTitle === undefined
      ? {}
      : { explicitTitle: child.explicitTitle }),
    ...(child.workflowStep === undefined
      ? {}
      : { workflowStep: child.workflowStep }),
    agent: child.agent,
    createdAt: child.createdAt,
    updatedAt: child.updatedAt,
    active: true,
    treeOrder: child.treeOrder,
    sourceState: "available",
  };
}

/**
 * A settled row's stored title is offered as the explicit title and never
 * re-derived from a task string the picker does not (and must not) have. The
 * derived agent label is bounded here, because a stored title may legitimately
 * be longer than a label.
 *
 * The picker also checks title provenance for itself (Threat Model T6, Warp
 * blocker 1, Task 21 remediation D) rather than trusting the ref or cache layer
 * it was handed: proof is the row's persisted provenance marker, never the
 * shape of the title, so a row without a marker — every legacy row — falls back
 * to identity-only text for both the displayed title and the derived agent
 * label.
 */
function settledCandidate(
  row: PiChildPickerCacheRecord | PiChildPickerRefRecord,
  sourceState: PiChildPickerSourceState,
): PiChildPickerCandidate | undefined {
  const status = coerceStatus(row.status);
  if (status === undefined) return undefined;
  const title = enforceDurableChildTitle({
    title: row.title,
    threadId: row.threadId,
    ...(row.titleProvenance === undefined
      ? {}
      : { provenance: row.titleProvenance }),
  });
  const agent = boundLabel(
    sanitize(title),
    PI_CHILD_PICKER_BOUNDS.maxLabelLength,
  );
  return {
    childId: row.childId,
    threadId: row.threadId,
    status,
    ...(title.length === 0 ? {} : { explicitTitle: title }),
    agent: agent.length === 0 ? "child" : agent,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    active: false,
    treeOrder: 0,
    sourceState,
  };
}

/**
 * Collects picker candidates: every active child from the live tree, plus one
 * bounded page of settled children from the Task 6 cache with each specific
 * row revalidated against its authoritative session. When the cache is
 * degraded or absent, the bounded current-parent Task 5 ref scan is used
 * instead. Rows from another parent session are kept as read-only orphans;
 * stale and unavailable rows are dropped here and never reach the list.
 *
 * Active children are authoritative on their own: they are running in this
 * very process. An unusable cache or ref scan therefore only removes settled
 * rows; it never removes the live children, and never fails the collection.
 */
export function collectChildPickerCandidates(
  input: PiChildPickerCandidateInput,
): ResultAsync<readonly PiChildPickerCandidate[], PiChildPickerError> {
  const limit = clampCandidateLimit(input.limit);
  const seen = new Set<string>();
  const candidates: PiChildPickerCandidate[] = [];
  for (const child of input.active.slice(0, limit)) {
    if (seen.has(child.childId)) continue;
    seen.add(child.childId);
    candidates.push(activeCandidate(child));
  }

  const remaining = Math.max(0, limit - candidates.length);
  if (remaining === 0) return okAsync(Object.freeze(candidates));

  const orphanOf = (originParentSessionId: string): PiChildPickerSourceState =>
    originParentSessionId === input.parentSessionId ? "available" : "orphan";

  const fromRefs = (): ResultAsync<
    readonly PiChildPickerCandidate[],
    PiChildPickerError
  > => {
    const refs = input.refs;
    if (refs === undefined) return okAsync(Object.freeze(candidates));
    return (
      refs
        .readRefs({ limit: remaining })
        .map((rows) => {
          for (const row of rows.slice(0, remaining)) {
            if (seen.has(row.childId)) continue;
            const candidate = settledCandidate(
              row,
              orphanOf(row.originParentSessionId),
            );
            if (candidate === undefined) continue;
            seen.add(row.childId);
            candidates.push(candidate);
          }
          return Object.freeze(candidates) as readonly PiChildPickerCandidate[];
        })
        // An unusable ref scan is a missing settled history, not a broken
        // picker: the already-collected live children stay listable.
        .orElse(() =>
          okAsync(
            Object.freeze(candidates) as readonly PiChildPickerCandidate[],
          ),
        )
    );
  };

  const cache = input.cache;
  if (cache === undefined || input.cacheDegraded === true) return fromRefs();

  return cache
    .list({
      workspaceKey: input.workspaceKey,
      parentSessionId: input.parentSessionId,
      limit: remaining,
    })
    .mapErr(
      (): PiChildPickerError => ({
        type: "invalid-picker-input",
        detail: "cache list unavailable",
      }),
    )
    .andThen((page) => {
      const rows = page.records
        .filter((row) => !seen.has(row.childId) && !row.tombstoned)
        .slice(0, remaining);
      // Each specific row is revalidated against the authoritative source
      // before it is offered; a cached row alone is never trusted.
      return ResultAsync.combine(
        rows.map((row) =>
          cache.validate(row.childId).map((state) => ({ row, state }) as const),
        ),
      )
        .mapErr(
          (): PiChildPickerError => ({
            type: "invalid-picker-input",
            detail: "cache validation unavailable",
          }),
        )
        .map((checked) => {
          for (const { row, state } of checked) {
            if (isExcludedSourceState(state) || row.stale) continue;
            const candidate = settledCandidate(
              row,
              state === "orphan"
                ? "orphan"
                : orphanOf(row.originParentSessionId),
            );
            if (candidate === undefined) continue;
            seen.add(row.childId);
            candidates.push(candidate);
          }
          return Object.freeze(candidates) as readonly PiChildPickerCandidate[];
        });
    })
    .orElse(() => fromRefs());
}

function pathDepth(
  node: PiChildPickerNode,
  nodes: readonly PiChildPickerNode[],
): number {
  let depth = 0;
  let parent = node.parentId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    parent = nodes.find((n) => n.childId === parent)?.parentId;
  }
  return depth;
}
export function buildChildPickerEntries(
  input: PiChildPickerInput,
): Result<readonly PiChildPickerEntry[], PiChildPickerError> {
  const all = [...input.live, ...(input.history ?? [])];
  const ids = new Set<string>();
  for (const node of all) {
    if (!node.childId || ids.has(node.childId))
      return err({
        type: "invalid-picker-input",
        detail: "child ids must be unique and non-empty",
      });
    if (
      node.parentId !== undefined &&
      node.parentId !== "root" &&
      !all.some((candidate) => candidate.childId === node.parentId)
    ) {
      return err({
        type: "invalid-picker-input",
        detail: `unknown parent ${node.parentId}`,
      });
    }
    ids.add(node.childId);
  }
  const entries: PiChildPickerEntry[] = [
    { id: "root", label: input.rootLabel ?? "root", preview: "", depth: 0 },
  ];
  for (const node of all) {
    const history = !node.live;
    const status = sanitize(node.status);
    const breadcrumb = [node.workflowInstanceId, node.stepName]
      .filter(
        (value): value is string => value !== undefined && value.length > 0,
      )
      .map(sanitize)
      .join(" / ");
    const label = `${history ? "history: " : ""}${sanitize(node.name) || node.childId}${breadcrumb ? ` (${breadcrumb})` : ""} [${status}]`;
    entries.push({
      id: node.childId,
      label,
      preview: sanitize(node.preview),
      depth: pathDepth(node, all),
      node,
    });
    if (node.recoverable)
      entries.push({
        id: `${node.childId}:recover`,
        label: "  ↻ recover",
        preview: "",
        depth: pathDepth(node, all) + 1,
        node,
        action: "recover",
      });
    if (node.resumable)
      entries.push({
        id: `${node.childId}:resume`,
        label: "  ▶ resume",
        preview: "",
        depth: pathDepth(node, all) + 1,
        node,
        action: "resume",
      });
    if (
      history &&
      [
        "settled",
        "interrupted",
        "quarantined",
        "cleared",
        "completed",
        "cancelled",
        "failed",
      ].includes(node.status)
    ) {
      entries.push({
        id: `${node.childId}:clear`,
        label: "  × clear history",
        preview: "",
        depth: pathDepth(node, all) + 1,
        node,
        action: "clear",
      });
    }
  }
  return ok(entries);
}
export const createChildPickerEntries = buildChildPickerEntries;
export function sanitizeChildPickerPreview(value: string | undefined): string {
  return sanitize(value);
}

/** The bounded facts a live child snapshot may contribute to its preview. */
export interface PiChildPickerPreviewSource {
  readonly latestOutput?: string;
  readonly currentTool?: string;
  readonly reasoningObserved?: boolean;
}

/**
 * The safe preview for one live child, in priority order.
 *
 * Answer text first, then the canonical activity fact of the tool the child is
 * running, then the content-free statement that it is reasoning. Raw
 * chain-of-thought has no rank here at all: the picker is a user-visible
 * surface, and a reasoning buffer projected into it would publish the model's
 * private reasoning to every reader of the list.
 */
export function childPickerPreview(source: PiChildPickerPreviewSource): string {
  const output = sanitize(source.latestOutput);
  if (output.length > 0) return output;
  const tool = sanitize(source.currentTool);
  if (tool.length > 0) return `running ${tool}`;
  return source.reasoningObserved === true ? "reasoning" : "";
}

export interface PiChildPickerState {
  readonly entries: readonly PiChildPickerEntry[];
  readonly selected: number;
}
export function moveChildPicker(
  state: PiChildPickerState,
  delta: number,
): PiChildPickerState {
  if (!state.entries.length) return state;
  const selected = Math.max(
    0,
    Math.min(state.entries.length - 1, state.selected + delta),
  );
  return { ...state, selected };
}
export function selectedChildPickerEntry(
  state: PiChildPickerState,
): PiChildPickerEntry | undefined {
  return state.entries[state.selected];
}
