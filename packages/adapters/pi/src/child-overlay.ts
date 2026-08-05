/**
 * Bounded full-screen child overlay model, source, and native custom component
 * (Spec 33 §7, plan Task 12 phases A–B1).
 *
 * Owns one overlay instance over injected ports: pagination, search, live-tail,
 * per-child LRU view state, input isolation, and typed fallback handoff for the
 * existing custom-editor path. The native component mounts via Pi public
 * `CustomEditor` + transcript factory seams without touching the primary editor
 * or registering extension keybindings (Task 13).
 *
 * Historical pages adapt Task 4 `readSessionEntries` output through
 * {@link mapNativeSessionEntryToOverlay} without copying transcript bytes into
 * adapter storage. Live events use the shared Task 11 parser + compact map /
 * reduce pipeline, then project into the overlay window via the existing
 * child-transcript reducer.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  createChildCompactState,
  mapPiChildSessionEventToCompactInput,
  reduceChildCompactSafe,
  type ChildCompactState,
} from "./child-compact-render.js";
import {
  createPiNativeTranscriptComponentFactory,
  type PiNativeTranscriptComponentDeps,
} from "./child-native-components.js";
import {
  parsePiChildSessionEvent,
  type PiChildSessionEvent,
} from "./child-session-events.js";
import {
  createPiChildTranscriptRenderer,
  createPiChildTranscriptState,
  reducePiChildTranscript,
  type PiChildTranscriptEntry,
  type PiChildTranscriptState,
  type PiTranscriptComponentFactory,
} from "./child-transcript.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const CHILD_OVERLAY_BOUNDS = Object.freeze({
  /** Entries loaded by one page request. */
  defaultPageSize: 50,
  /** Hard ceiling for one page request. */
  maxPageSize: 100,
  /** Maximum entries retained in the in-memory window. */
  defaultWindowCap: 200,
  /** Hard ceiling for the in-memory window. */
  maxWindowCap: 512,
  /** Per-child saved view states retained (LRU). */
  maxLruChildren: 8,
  /** Maximum older pages fetched during one search. */
  maxSearchPages: 4,
  /** Ceiling on opaque cursor characters. */
  maxCursorLength: 512,
  /** Ceiling on draft / search query characters. */
  maxTextLength: 16_384,
  /** Ceiling on child / thread / entry ids. */
  maxIdLength: 256,
  /** Ceiling on run-divider labels. */
  maxLabelLength: 128,
  /** Ceiling on run dividers retained per child descriptor. */
  maxRuns: 64,
  /** Ceiling on nested hierarchy depth reported in descriptors. */
  maxHierarchyDepth: 16,
});

const SCROLL_KEYS = {
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  shiftUp: "\x1b[1;2A",
  shiftDown: "\x1b[1;2B",
  home: "\x1b[H",
  end: "\x1b[F",
} as const;

const SCROLL_PAGE = 10;

// ---------------------------------------------------------------------------
// Schemas (persisted / opaque input)
// ---------------------------------------------------------------------------

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(CHILD_OVERLAY_BOUNDS.maxIdLength)
  .regex(/^[A-Za-z0-9._:-]+$/u);

const OpaqueCursorSchema = z
  .string()
  .min(1)
  .max(CHILD_OVERLAY_BOUNDS.maxCursorLength);

const OverlayTextSchema = z
  .string()
  .max(CHILD_OVERLAY_BOUNDS.maxTextLength);

const RunActionSchema = z.enum(["start", "retry", "continue"]);

export const ChildOverlayRunDividerSchema = z
  .object({
    run: z.number().int().min(1).max(CHILD_OVERLAY_BOUNDS.maxRuns),
    action: RunActionSchema,
    startedAt: z.number().int().nonnegative().optional(),
    priorOutcome: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    initiator: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    model: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    reasoning: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
  })
  .strict();
export type ChildOverlayRunDivider = z.infer<
  typeof ChildOverlayRunDividerSchema
>;

export const ChildOverlayStatusSchema = z.enum(["live", "settled", "orphan"]);
export type ChildOverlayStatus = z.infer<typeof ChildOverlayStatusSchema>;

export const ChildOverlayChildSchema = z
  .object({
    childId: OpaqueIdSchema,
    threadId: OpaqueIdSchema,
    parentChildId: OpaqueIdSchema.optional(),
    status: ChildOverlayStatusSchema,
    title: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    generationId: OpaqueIdSchema.optional(),
    runs: z
      .array(ChildOverlayRunDividerSchema)
      .max(CHILD_OVERLAY_BOUNDS.maxRuns)
      .default([]),
    branchIds: z
      .array(OpaqueIdSchema)
      .max(CHILD_OVERLAY_BOUNDS.maxRuns)
      .default([]),
    /** Nested descendant child ids, shallow and bounded (no paths). */
    descendantChildIds: z
      .array(OpaqueIdSchema)
      .max(CHILD_OVERLAY_BOUNDS.maxHierarchyDepth)
      .default([]),
  })
  .strict();
export type ChildOverlayChild = z.infer<typeof ChildOverlayChildSchema>;

// ---------------------------------------------------------------------------
// Overlay entries (UI-agnostic transcript facts)
// ---------------------------------------------------------------------------

export type ChildOverlayEntryKind =
  | "prompt"
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "error"
  | "retry"
  | "run-divider"
  | "image"
  | "status"
  | "unknown";

export interface ChildOverlayEntry {
  readonly id: string;
  readonly sequence: number;
  readonly kind: ChildOverlayEntryKind;
  /** Searchable, sanitized text projection (never a filesystem path). */
  readonly text: string;
  readonly runNumber?: number;
  readonly branchId?: string;
  readonly expanded: boolean;
}

export interface ChildOverlayPage {
  readonly entries: readonly ChildOverlayEntry[];
  readonly olderCursor: string | undefined;
  readonly newerCursor: string | undefined;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

export type ChildOverlaySourceError =
  | { readonly type: "SourceUnavailable"; readonly operation: string }
  | { readonly type: "SourceCorrupt"; readonly operation: string }
  | { readonly type: "SourceInvalidCursor"; readonly operation: string }
  | { readonly type: "ChildNotFound"; readonly childId: string };

export interface ChildOverlaySourcePort {
  describe(
    childId: string,
  ): ResultAsync<ChildOverlayChild, ChildOverlaySourceError>;
  loadNewest(
    childId: string,
    pageSize: number,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
  loadOlder(
    childId: string,
    cursor: string,
    pageSize: number,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
  loadNewer(
    childId: string,
    cursor: string,
    pageSize: number,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
}

export type ChildOverlayMutationPort = {
  steer(
    childId: string,
    generationId: string,
    text: string,
  ): ResultAsync<void, { readonly type: "MutationFailed" }>;
  followUp(
    childId: string,
    generationId: string,
    text: string,
  ): ResultAsync<void, { readonly type: "MutationFailed" }>;
};

export interface ChildOverlayConfig {
  readonly pageSize?: number;
  readonly windowCap?: number;
  readonly maxLruChildren?: number;
  readonly maxSearchPages?: number;
}

export type ChildOverlayFallbackReason =
  | "source-failed"
  | "render-failed"
  | "describe-failed";

/** Bounded safe metadata for custom-editor handoff — never paths or secrets. */
export interface ChildOverlayFallbackMetadata {
  readonly childId: string;
  readonly threadId: string;
  readonly status: ChildOverlayStatus;
  readonly entryCount: number;
  readonly reason: ChildOverlayFallbackReason;
  readonly readOnly: boolean;
}

export interface ChildOverlayFallbackRequired {
  readonly kind: "fallback-required";
  readonly metadata: ChildOverlayFallbackMetadata;
  readonly transcript: PiChildTranscriptState;
}

export type ChildOverlayError =
  | ChildOverlaySourceError
  | { readonly type: "OverlayNotOpen" }
  | { readonly type: "OverlayInvalidChild"; readonly issues: readonly string[] }
  | { readonly type: "OverlayCapacityExceeded"; readonly operation: string }
  | ChildOverlayFallbackRequired;

export interface ChildOverlayAnchor {
  readonly entryId: string;
  readonly lineOffset: number;
}

export interface ChildOverlayView {
  readonly child: ChildOverlayChild;
  readonly entries: readonly ChildOverlayEntry[];
  readonly draft: string;
  readonly searchQuery: string;
  readonly searchMatches: readonly string[];
  readonly scrollOffset: number;
  readonly liveTail: boolean;
  readonly globalExpanded: boolean;
  readonly activeRun: number | undefined;
  readonly activeBranchId: string | undefined;
  readonly olderCursor: string | undefined;
  readonly newerCursor: string | undefined;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly readOnly: boolean;
  readonly width: number;
  readonly height: number;
  readonly anchor: ChildOverlayAnchor | undefined;
  readonly compact: ChildCompactState;
  readonly transcript: PiChildTranscriptState;
}

export type ChildOverlayInputOutcome =
  | { readonly kind: "consumed" }
  | { readonly kind: "draft-updated"; readonly draft: string }
  | {
      readonly kind: "steer";
      readonly childId: string;
      readonly text: string;
    }
  | {
      readonly kind: "follow-up";
      readonly childId: string;
      readonly text: string;
    }
  | { readonly kind: "scroll"; readonly scrollOffset: number }
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "expanded"; readonly globalExpanded: boolean }
  | {
      readonly kind: "navigate-run";
      readonly activeRun: number | undefined;
    }
  | {
      readonly kind: "navigate-branch";
      readonly activeBranchId: string | undefined;
    }
  | ChildOverlayFallbackRequired;

// ---------------------------------------------------------------------------
// Native entry mapping (Task 4 adapt / child-transcript projection)
// ---------------------------------------------------------------------------

const NativeMessageSchema = z.looseObject({
  type: z.literal("message"),
  id: z.string().min(1).max(CHILD_OVERLAY_BOUNDS.maxIdLength),
  message: z.unknown(),
});

const NativeCustomSchema = z.looseObject({
  type: z.literal("custom"),
  id: z.string().min(1).max(CHILD_OVERLAY_BOUNDS.maxIdLength),
  customType: z.string().max(CHILD_OVERLAY_BOUNDS.maxIdLength).optional(),
  data: z.unknown().optional(),
});

const RunDividerDataSchema = z.looseObject({
  run: z.number().int().min(1).max(CHILD_OVERLAY_BOUNDS.maxRuns).optional(),
  action: RunActionSchema.optional(),
  runNumber: z
    .number()
    .int()
    .min(1)
    .max(CHILD_OVERLAY_BOUNDS.maxRuns)
    .optional(),
});

function boundText(value: string): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  if (clean.length <= CHILD_OVERLAY_BOUNDS.maxTextLength) return clean;
  return [...clean].slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength).join("");
}

function messageText(message: unknown): {
  readonly role: string | undefined;
  readonly text: string;
} {
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return { role: undefined, text: "" };
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : undefined;
  const content = record.content;
  if (typeof content === "string") return { role, text: boundText(content) };
  if (!Array.isArray(content)) return { role, text: "" };
  let text = "";
  for (const block of content) {
    if (typeof block === "string") {
      text += block;
      continue;
    }
    if (typeof block !== "object" || block === null || Array.isArray(block))
      continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") text += b.text;
  }
  return { role, text: boundText(text) };
}

function safeEntryId(value: string, fallback: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return fallback;
}

/**
 * Maps one host native session entry into zero or one overlay facts without
 * retaining the raw host payload. Paths and absolute locations are never
 * copied into the result.
 */
export function mapNativeSessionEntryToOverlay(
  entry: unknown,
  sequence: number,
): Result<ChildOverlayEntry | undefined, never> {
  const message = NativeMessageSchema.safeParse(entry);
  if (message.success) {
    const { role, text } = messageText(message.data.message);
    const id = safeEntryId(message.data.id, `entry-${sequence}`);
    if (role === "user") {
      return ok({
        id,
        sequence,
        kind: sequence === 0 ? "prompt" : "user",
        text,
        expanded: false,
      });
    }
    if (role === "assistant") {
      return ok({
        id,
        sequence,
        kind: "assistant",
        text,
        expanded: false,
      });
    }
    return ok({
      id,
      sequence,
      kind: "unknown",
      text: role ? `message:${role}` : "message",
      expanded: false,
    });
  }

  const custom = NativeCustomSchema.safeParse(entry);
  if (custom.success) {
    const customType = custom.data.customType ?? "";
    const id = safeEntryId(custom.data.id, `custom-${sequence}`);
    if (
      customType === "weave.child.run-divider" ||
      customType === "run-divider" ||
      customType.endsWith(".run-divider")
    ) {
      const data = RunDividerDataSchema.safeParse(custom.data.data);
      const runNumber = data.success
        ? (data.data.run ?? data.data.runNumber)
        : undefined;
      const action = data.success ? data.data.action : undefined;
      return ok({
        id,
        sequence,
        kind: "run-divider",
        text: boundText(
          `run ${runNumber ?? "?"} · ${action ?? "start"}`,
        ),
        runNumber,
        expanded: false,
      });
    }
    if (customType === "weave.child.thread") {
      return ok(undefined);
    }
    return ok({
      id,
      sequence,
      kind: "status",
      text: boundText(customType || "custom"),
      expanded: false,
    });
  }

  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "unknown";
    const id =
      typeof record.id === "string"
        ? safeEntryId(record.id, `entry-${sequence}`)
        : `entry-${sequence}`;
    if (type === "thinking_level_change" || type === "model_change") {
      return ok(undefined);
    }
    return ok({
      id,
      sequence,
      kind: "unknown",
      text: boundText(type),
      expanded: false,
    });
  }
  return ok(undefined);
}

/**
 * Builds a transcript state suitable for custom-editor handoff from overlay
 * entries already loaded in the window. Does not persist anything.
 */
export function transcriptFromOverlayEntries(
  entries: readonly ChildOverlayEntry[],
): PiChildTranscriptState {
  let state = createPiChildTranscriptState();
  for (const entry of entries) {
    if (entry.kind === "prompt" || entry.kind === "user") {
      const next = reducePiChildTranscript(state, {
        kind: "task",
        text: entry.text.slice(0, 64 * 1024),
      });
      if (next.isOk()) state = next.value;
      continue;
    }
    if (entry.kind === "assistant") {
      const messageId = entry.id;
      const start = reducePiChildTranscript(state, {
        kind: "event",
        event: {
          type: "message_start",
          message: { id: messageId, role: "assistant" },
        },
      });
      if (start.isErr()) continue;
      const end = reducePiChildTranscript(start.value, {
        kind: "event",
        event: {
          type: "message_end",
          message: {
            id: messageId,
            role: "assistant",
            content: entry.text,
          },
        },
      });
      if (end.isOk()) state = end.value;
      continue;
    }
    if (entry.kind === "retry" || entry.kind === "run-divider") {
      const next = reducePiChildTranscript(state, {
        kind: "event",
        event: {
          type: "retry",
          attempt: entry.runNumber,
          reason: entry.text,
        },
      });
      if (next.isOk()) state = next.value;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// In-memory source helper (tests + adapters that already hold entry pages)
// ---------------------------------------------------------------------------

export interface MemoryOverlaySourceEntry {
  readonly id: string;
  readonly payload: unknown;
}

export interface MemoryOverlaySourceChild extends ChildOverlayChild {
  readonly entries: readonly MemoryOverlaySourceEntry[];
}

/**
 * Creates a {@link ChildOverlaySourcePort} over an in-memory child catalog.
 * Pagination uses opaque cursors that encode entry ids only (never paths).
 */
export function createMemoryChildOverlaySource(
  children: readonly MemoryOverlaySourceChild[],
): ChildOverlaySourcePort {
  const byId = new Map(children.map((child) => [child.childId, child]));

  const pageFrom = (
    child: MemoryOverlaySourceChild,
    startInclusive: number,
    endExclusive: number,
  ): ChildOverlayPage => {
    const slice = child.entries.slice(startInclusive, endExclusive);
    const mapped: ChildOverlayEntry[] = [];
    for (let i = 0; i < slice.length; i += 1) {
      const item = slice[i];
      if (item === undefined) continue;
      const mappedEntry = mapNativeSessionEntryToOverlay(
        item.payload,
        startInclusive + i,
      ).unwrapOr(undefined);
      if (mappedEntry === undefined) continue;
      mapped.push({ ...mappedEntry, id: item.id });
    }
    const olderCursor =
      startInclusive > 0
        ? child.entries[startInclusive - 1]?.id
        : undefined;
    const newerIndex = endExclusive;
    const newerCursor =
      newerIndex < child.entries.length
        ? child.entries[newerIndex]?.id
        : undefined;
    return {
      entries: mapped,
      olderCursor,
      newerCursor,
      hasOlder: startInclusive > 0,
      hasNewer: endExclusive < child.entries.length,
    };
  };

  const indexOf = (
    child: MemoryOverlaySourceChild,
    cursor: string,
  ): Result<number, ChildOverlaySourceError> => {
    const parsed = OpaqueCursorSchema.safeParse(cursor);
    if (!parsed.success) {
      return err({ type: "SourceInvalidCursor", operation: "page" });
    }
    const index = child.entries.findIndex((entry) => entry.id === parsed.data);
    if (index < 0) {
      return err({ type: "SourceInvalidCursor", operation: "page" });
    }
    return ok(index);
  };

  return {
    describe(childId) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const parsed = ChildOverlayChildSchema.safeParse({
        childId: child.childId,
        threadId: child.threadId,
        parentChildId: child.parentChildId,
        status: child.status,
        title: child.title,
        generationId: child.generationId,
        runs: child.runs,
        branchIds: child.branchIds,
        descendantChildIds: child.descendantChildIds,
      });
      if (!parsed.success) {
        return errAsync({
          type: "SourceCorrupt",
          operation: "describe",
        });
      }
      return okAsync(parsed.data);
    },
    loadNewest(childId, pageSize) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const size = clampPageSize(pageSize);
      const end = child.entries.length;
      const start = Math.max(0, end - size);
      return okAsync(pageFrom(child, start, end));
    },
    loadOlder(childId, cursor, pageSize) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const index = indexOf(child, cursor);
      if (index.isErr()) return errAsync(index.error);
      const size = clampPageSize(pageSize);
      // cursor points at the newest entry already loaded; load strictly older
      const end = index.value;
      const start = Math.max(0, end - size);
      return okAsync(pageFrom(child, start, end));
    },
    loadNewer(childId, cursor, pageSize) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const index = indexOf(child, cursor);
      if (index.isErr()) return errAsync(index.error);
      const size = clampPageSize(pageSize);
      const start = index.value + 1;
      const end = Math.min(child.entries.length, start + size);
      return okAsync(pageFrom(child, start, end));
    },
  };
}

/**
 * Adapts Task 4 `readSessionEntries` into a paginated overlay source.
 *
 * Each page request performs one transient host read and slices only the
 * requested page from the full entry list. Older/newer cursors can therefore
 * reach beyond {@link CHILD_OVERLAY_BOUNDS.maxWindowCap}; the overlay
 * controller still retains only its hard in-memory window. Nothing is cached
 * across calls and no transcript bytes are copied into adapter persistence.
 */
export function createReadSessionEntriesOverlaySource(deps: {
  readonly describe: (
    childId: string,
  ) => ResultAsync<ChildOverlayChild, ChildOverlaySourceError>;
  readonly readEntries: (
    childId: string,
  ) => ResultAsync<readonly unknown[], ChildOverlaySourceError>;
}): ChildOverlaySourcePort {
  const materialize = (
    childId: string,
  ): ResultAsync<readonly MemoryOverlaySourceEntry[], ChildOverlaySourceError> =>
    deps.readEntries(childId).map((entries) =>
      entries.map((payload, index) => {
        const record =
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : undefined;
        const id =
          typeof record?.id === "string" && record.id.length > 0
            ? safeEntryId(record.id, `idx-${index}`)
            : `idx-${index}`;
        return { id, payload };
      }),
    );

  const asChild = (
    childId: string,
    entries: readonly MemoryOverlaySourceEntry[],
  ): MemoryOverlaySourceChild => ({
    childId,
    threadId: childId,
    status: "settled",
    runs: [],
    branchIds: [],
    descendantChildIds: [],
    entries,
  });

  const withSource = (
    childId: string,
    fn: (
      source: ChildOverlaySourcePort,
    ) => ResultAsync<ChildOverlayPage, ChildOverlaySourceError>,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError> =>
    materialize(childId).andThen((entries) =>
      fn(createMemoryChildOverlaySource([asChild(childId, entries)])),
    );

  return {
    describe: deps.describe,
    loadNewest(childId, pageSize) {
      return withSource(childId, (source) =>
        source.loadNewest(childId, pageSize),
      );
    },
    loadOlder(childId, cursor, pageSize) {
      return withSource(childId, (source) =>
        source.loadOlder(childId, cursor, pageSize),
      );
    },
    loadNewer(childId, cursor, pageSize) {
      return withSource(childId, (source) =>
        source.loadNewer(childId, cursor, pageSize),
      );
    },
  };
}

function clampPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return CHILD_OVERLAY_BOUNDS.defaultPageSize;
  return Math.max(
    1,
    Math.min(CHILD_OVERLAY_BOUNDS.maxPageSize, Math.floor(pageSize)),
  );
}

function clampWindowCap(windowCap: number): number {
  if (!Number.isFinite(windowCap)) return CHILD_OVERLAY_BOUNDS.defaultWindowCap;
  return Math.max(
    1,
    Math.min(CHILD_OVERLAY_BOUNDS.maxWindowCap, Math.floor(windowCap)),
  );
}

// ---------------------------------------------------------------------------
// Per-child saved state (LRU)
// ---------------------------------------------------------------------------

interface SavedChildState {
  draft: string;
  searchQuery: string;
  scrollOffset: number;
  liveTail: boolean;
  globalExpanded: boolean;
  activeRun: number | undefined;
  activeBranchId: string | undefined;
  olderCursor: string | undefined;
  newerCursor: string | undefined;
  hasOlderFlag: boolean;
  hasNewerFlag: boolean;
  entries: ChildOverlayEntry[];
  compact: ChildCompactState;
  transcript: PiChildTranscriptState;
  anchor: ChildOverlayAnchor | undefined;
  width: number;
  height: number;
  lastTouched: number;
}

function emptySaved(
  threadId: string,
  touched: number,
): SavedChildState {
  return {
    draft: "",
    searchQuery: "",
    scrollOffset: 0,
    liveTail: true,
    globalExpanded: false,
    activeRun: undefined,
    activeBranchId: undefined,
    olderCursor: undefined,
    newerCursor: undefined,
    hasOlderFlag: false,
    hasNewerFlag: false,
    entries: [],
    compact: createChildCompactState(threadId),
    transcript: createPiChildTranscriptState(),
    anchor: undefined,
    width: 80,
    height: 24,
    lastTouched: touched,
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class ChildOverlayController {
  private readonly source: ChildOverlaySourcePort;
  private readonly mutations: ChildOverlayMutationPort | undefined;
  private readonly pageSize: number;
  private readonly windowCap: number;
  private readonly maxLruChildren: number;
  private readonly maxSearchPages: number;
  private readonly saved = new Map<string, SavedChildState>();
  private openChild: ChildOverlayChild | undefined;
  private clock = 0;

  constructor(
    source: ChildOverlaySourcePort,
    config: ChildOverlayConfig = {},
    mutations?: ChildOverlayMutationPort,
  ) {
    this.source = source;
    this.mutations = mutations;
    this.pageSize = clampPageSize(
      config.pageSize ?? CHILD_OVERLAY_BOUNDS.defaultPageSize,
    );
    this.windowCap = clampWindowCap(
      config.windowCap ?? CHILD_OVERLAY_BOUNDS.defaultWindowCap,
    );
    this.maxLruChildren = Math.max(
      1,
      Math.min(
        CHILD_OVERLAY_BOUNDS.maxLruChildren,
        config.maxLruChildren ?? CHILD_OVERLAY_BOUNDS.maxLruChildren,
      ),
    );
    this.maxSearchPages = Math.max(
      1,
      Math.min(
        CHILD_OVERLAY_BOUNDS.maxSearchPages,
        config.maxSearchPages ?? CHILD_OVERLAY_BOUNDS.maxSearchPages,
      ),
    );
  }

  isOpen(): boolean {
    return this.openChild !== undefined;
  }

  currentChildId(): string | undefined {
    return this.openChild?.childId;
  }

  view(): Result<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return err({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return err({ type: "OverlayNotOpen" });
    return ok(this.toView(child, state));
  }

  open(
    childInput: ChildOverlayChild | string,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const childId =
      typeof childInput === "string" ? childInput : childInput.childId;
    if (this.openChild !== undefined && this.openChild.childId !== childId) {
      this.persistOpen();
    }
    return this.source
      .describe(childId)
      .mapErr(
        (error): ChildOverlayError =>
          error.type === "SourceUnavailable" ||
          error.type === "SourceCorrupt" ||
          error.type === "ChildNotFound"
            ? this.fallbackFromError(childId, "describe-failed", error)
            : error,
      )
      .andThen((described) => {
        const parsed = ChildOverlayChildSchema.safeParse(
          typeof childInput === "string"
            ? described
            : { ...described, ...childInput, childId },
        );
        if (!parsed.success) {
          return errAsync<ChildOverlayView, ChildOverlayError>({
            type: "OverlayInvalidChild",
            issues: parsed.error.issues.map((issue) => issue.path.join(".")),
          });
        }
        const child = parsed.data;
        this.touch(child.childId);
        const existing = this.saved.get(child.childId);
        const state =
          existing ??
          emptySaved(child.threadId, this.clock);
        if (existing === undefined) this.saved.set(child.childId, state);
        this.openChild = child;
        this.evictLru();
        if (state.entries.length > 0) {
          return okAsync(this.toView(child, state));
        }
        return this.source
          .loadNewest(child.childId, this.pageSize)
          .mapErr(
            (error): ChildOverlayError =>
              this.fallbackFromError(child.childId, "source-failed", error),
          )
          .map((page) => {
            this.applyPage(state, page, "replace");
            state.liveTail = true;
            state.scrollOffset = 0;
            state.activeRun =
              child.runs.length > 0
                ? child.runs[child.runs.length - 1]?.run
                : undefined;
            state.activeBranchId = child.branchIds[0];
            state.transcript = transcriptFromOverlayEntries(state.entries);
            return this.toView(child, state);
          });
      });
  }

  close(): Result<void, ChildOverlayError> {
    if (this.openChild === undefined) return err({ type: "OverlayNotOpen" });
    this.persistOpen();
    this.openChild = undefined;
    return ok(undefined);
  }

  loadOlder(): ResultAsync<ChildOverlayView, ChildOverlayError> {
    return this.withOpen((child, state) => {
      if (state.olderCursor === undefined) {
        return okAsync(this.toView(child, state));
      }
      return this.source
        .loadOlder(child.childId, state.olderCursor, this.pageSize)
        .mapErr(
          (error): ChildOverlayError =>
            this.fallbackFromError(child.childId, "source-failed", error),
        )
        .map((page) => {
          this.applyPage(state, page, "prepend");
          return this.toView(child, state);
        });
    });
  }

  loadNewer(): ResultAsync<ChildOverlayView, ChildOverlayError> {
    return this.withOpen((child, state) => {
      if (state.newerCursor === undefined) {
        return okAsync(this.toView(child, state));
      }
      return this.source
        .loadNewer(child.childId, state.newerCursor, this.pageSize)
        .mapErr(
          (error): ChildOverlayError =>
            this.fallbackFromError(child.childId, "source-failed", error),
        )
        .map((page) => {
          this.applyPage(state, page, "append");
          if (state.liveTail) state.scrollOffset = 0;
          return this.toView(child, state);
        });
    });
  }

  search(
    query: string,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const bounded = OverlayTextSchema.safeParse(query);
    const text = bounded.success
      ? bounded.data
      : query.slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength);
    return this.withOpen((child, state) => {
      state.searchQuery = text;
      if (text.length === 0) {
        return okAsync(this.toView(child, state));
      }
      const needle = text.toLowerCase();
      if (
        state.entries.some((entry) =>
          entry.text.toLowerCase().includes(needle),
        )
      ) {
        return okAsync(this.toView(child, state));
      }
      return this.searchFetchPages(child, state, needle, 0);
    });
  }

  private searchFetchPages(
    child: ChildOverlayChild,
    state: SavedChildState,
    needle: string,
    pagesFetched: number,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    if (
      pagesFetched >= this.maxSearchPages ||
      state.olderCursor === undefined ||
      state.entries.some((entry) => entry.text.toLowerCase().includes(needle))
    ) {
      return okAsync(this.toView(child, state));
    }
    return this.source
      .loadOlder(child.childId, state.olderCursor, this.pageSize)
      .mapErr(
        (error): ChildOverlayError =>
          this.fallbackFromError(child.childId, "source-failed", error),
      )
      .andThen((page) => {
        this.applyPage(state, page, "prepend");
        if (!page.hasOlder) return okAsync(this.toView(child, state));
        return this.searchFetchPages(child, state, needle, pagesFetched + 1);
      });
  }

  /**
   * Applies one parser-approved live child event through the Task 11 map /
   * reduce pipeline and projects a window entry when meaningful.
   */
  applyLiveEvent(
    event: unknown,
  ): Result<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return err({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return err({ type: "OverlayNotOpen" });
    if (child.status !== "live") {
      return ok(this.toView(child, state));
    }

    const parsed = parsePiChildSessionEvent(event);
    if (!parsed.success) return ok(this.toView(child, state));
    const sessionEvent = parsed.data;

    const mapped = mapPiChildSessionEventToCompactInput(sessionEvent);
    if (mapped.isOk() && mapped.value !== undefined) {
      state.compact = reduceChildCompactSafe(state.compact, mapped.value);
    }

    const transcriptNext = reducePiChildTranscript(state.transcript, {
      kind: "event",
      event: sessionEvent,
    });
    if (transcriptNext.isOk()) state.transcript = transcriptNext.value;

    const projected = projectLiveEntry(
      sessionEvent,
      state.entries.length,
      state.globalExpanded,
    );
    if (projected !== undefined) {
      this.mergeEntry(state, projected);
    }
    if (state.liveTail) state.scrollOffset = 0;
    return ok(this.toView(child, state));
  }

  setScrollOffset(
    offset: number,
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const max = Math.max(0, state.entries.length);
      const next = Math.min(Math.max(0, Math.floor(offset)), max);
      state.scrollOffset = next;
      state.liveTail = next === 0;
      state.anchor = anchorFromScroll(state);
      return this.toView(child, state);
    });
  }

  scrollBy(delta: number): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const max = Math.max(0, state.entries.length);
      const next = Math.min(
        Math.max(0, state.scrollOffset + Math.trunc(delta)),
        max,
      );
      state.scrollOffset = next;
      state.liveTail = next === 0;
      state.anchor = anchorFromScroll(state);
      return this.toView(child, state);
    });
  }

  resize(
    width: number,
    height: number,
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const anchor = state.anchor ?? anchorFromScroll(state);
      state.width = Math.max(1, Math.floor(width));
      state.height = Math.max(1, Math.floor(height));
      state.anchor = anchor;
      if (anchor !== undefined) {
        const index = state.entries.findIndex(
          (entry) => entry.id === anchor.entryId,
        );
        if (index >= 0) {
          state.scrollOffset = Math.max(0, state.entries.length - 1 - index);
          state.liveTail = state.scrollOffset === 0;
        }
      }
      return this.toView(child, state);
    });
  }

  toggleGlobalExpansion(): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      state.globalExpanded = !state.globalExpanded;
      state.entries = state.entries.map((entry) => ({
        ...entry,
        expanded: state.globalExpanded,
      }));
      return this.toView(child, state);
    });
  }

  navigateRun(
    delta: number,
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const runs = child.runs;
      if (runs.length === 0) return this.toView(child, state);
      const currentIndex = Math.max(
        0,
        runs.findIndex((run) => run.run === state.activeRun),
      );
      const nextIndex = Math.min(
        runs.length - 1,
        Math.max(0, currentIndex + Math.trunc(delta)),
      );
      state.activeRun = runs[nextIndex]?.run;
      return this.toView(child, state);
    });
  }

  navigateBranch(
    delta: number,
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const branches = child.branchIds;
      if (branches.length === 0) return this.toView(child, state);
      const currentIndex = Math.max(
        0,
        branches.findIndex((id) => id === state.activeBranchId),
      );
      const nextIndex = Math.min(
        branches.length - 1,
        Math.max(0, currentIndex + Math.trunc(delta)),
      );
      state.activeBranchId = branches[nextIndex];
      return this.toView(child, state);
    });
  }

  updateDraft(draft: string): Result<ChildOverlayView, ChildOverlayError> {
    const bounded = OverlayTextSchema.safeParse(draft);
    const text = bounded.success
      ? bounded.data
      : draft.slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength);
    return this.mutateOpen((child, state) => {
      if (isReadOnly(child)) return this.toView(child, state);
      state.draft = text;
      return this.toView(child, state);
    });
  }

  /**
   * Consumes every key while mounted. Never routes text or keys to a primary
   * editor. Settled/orphan children are read-only for mutation actions.
   */
  handleInput(
    data: string,
  ): ResultAsync<ChildOverlayInputOutcome, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) {
      return errAsync({ type: "OverlayNotOpen" });
    }
    const state = this.saved.get(child.childId);
    if (state === undefined) {
      return errAsync({ type: "OverlayNotOpen" });
    }

    const scroll = scrollDelta(data);
    if (scroll !== undefined) {
      if (scroll === "oldest") {
        state.scrollOffset = Math.max(0, state.entries.length);
        state.liveTail = false;
      } else if (scroll === "follow") {
        state.scrollOffset = 0;
        state.liveTail = true;
      } else {
        state.scrollOffset = Math.min(
          Math.max(0, state.scrollOffset + scroll),
          Math.max(0, state.entries.length),
        );
        state.liveTail = state.scrollOffset === 0;
      }
      state.anchor = anchorFromScroll(state);
      return okAsync({ kind: "scroll", scrollOffset: state.scrollOffset });
    }

    if (matchesKey(data, "enter")) {
      if (isReadOnly(child) || !child.generationId) {
        return okAsync({ kind: "consumed" });
      }
      const text = state.draft.trim();
      if (text.length === 0) return okAsync({ kind: "consumed" });
      state.draft = "";
      const mutation = this.mutations;
      if (mutation === undefined) {
        return okAsync({
          kind: "steer",
          childId: child.childId,
          text,
        });
      }
      return mutation
        .steer(child.childId, child.generationId, text)
        .map(() => ({
          kind: "steer" as const,
          childId: child.childId,
          text,
        }))
        .mapErr((): ChildOverlayError =>
          this.fallbackFromError(child.childId, "render-failed", {
            type: "SourceUnavailable",
            operation: "steer",
          }),
        );
    }

    if (matchesKey(data, "alt+enter")) {
      if (isReadOnly(child) || !child.generationId) {
        return okAsync({ kind: "consumed" });
      }
      const text = state.draft.trim();
      if (text.length === 0) return okAsync({ kind: "consumed" });
      state.draft = "";
      const mutation = this.mutations;
      if (mutation === undefined) {
        return okAsync({
          kind: "follow-up",
          childId: child.childId,
          text,
        });
      }
      return mutation
        .followUp(child.childId, child.generationId, text)
        .map(() => ({
          kind: "follow-up" as const,
          childId: child.childId,
          text,
        }))
        .mapErr((): ChildOverlayError =>
          this.fallbackFromError(child.childId, "render-failed", {
            type: "SourceUnavailable",
            operation: "follow-up",
          }),
        );
    }

    if (matchesKey(data, "ctrl+e") || data === "\x05") {
      const toggled = this.toggleGlobalExpansion();
      if (toggled.isErr()) return errAsync(toggled.error);
      return okAsync({
        kind: "expanded",
        globalExpanded: toggled.value.globalExpanded,
      });
    }

    if (data === "\x1b[1;3D" || matchesKey(data, "alt+left")) {
      const nav = this.navigateRun(-1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({ kind: "navigate-run", activeRun: nav.value.activeRun });
    }
    if (data === "\x1b[1;3C" || matchesKey(data, "alt+right")) {
      const nav = this.navigateRun(1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({ kind: "navigate-run", activeRun: nav.value.activeRun });
    }
    if (data === "\x1b[1;3A" || matchesKey(data, "alt+up")) {
      const nav = this.navigateBranch(-1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({
        kind: "navigate-branch",
        activeBranchId: nav.value.activeBranchId,
      });
    }
    if (data === "\x1b[1;3B" || matchesKey(data, "alt+down")) {
      const nav = this.navigateBranch(1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({
        kind: "navigate-branch",
        activeBranchId: nav.value.activeBranchId,
      });
    }

    // All other input updates the overlay draft (or is swallowed). Never leak.
    if (!isReadOnly(child) && data.length > 0 && !data.startsWith("\x1b")) {
      if (data === "\x7f" || data === "\b") {
        state.draft = state.draft.slice(0, -1);
      } else if (!data.includes("\x00")) {
        const next = boundText(state.draft + data);
        state.draft = next;
      }
      return okAsync({ kind: "draft-updated", draft: state.draft });
    }

    return okAsync({ kind: "consumed" });
  }

  /**
   * Explicit render-boundary failure used by a later TUI layer. Returns only
   * bounded metadata + transcript model — never exception text or paths.
   */
  requireFallback(
    reason: ChildOverlayFallbackReason = "render-failed",
  ): ChildOverlayFallbackRequired {
    const child = this.openChild;
    const state =
      child !== undefined ? this.saved.get(child.childId) : undefined;
    return {
      kind: "fallback-required",
      metadata: {
        childId: child?.childId ?? "unknown",
        threadId: child?.threadId ?? "unknown",
        status: child?.status ?? "settled",
        entryCount: state?.entries.length ?? 0,
        reason,
        readOnly: child === undefined ? true : isReadOnly(child),
      },
      transcript: state?.transcript ?? createPiChildTranscriptState(),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private withOpen(
    fn: (
      child: ChildOverlayChild,
      state: SavedChildState,
    ) => ResultAsync<ChildOverlayView, ChildOverlayError>,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return errAsync({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return errAsync({ type: "OverlayNotOpen" });
    this.touch(child.childId);
    return fn(child, state);
  }

  private mutateOpen(
    fn: (
      child: ChildOverlayChild,
      state: SavedChildState,
    ) => ChildOverlayView,
  ): Result<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return err({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return err({ type: "OverlayNotOpen" });
    this.touch(child.childId);
    return ok(fn(child, state));
  }

  private persistOpen(): void {
    const child = this.openChild;
    if (child === undefined) return;
    const state = this.saved.get(child.childId);
    if (state !== undefined) state.lastTouched = ++this.clock;
  }

  private touch(childId: string): void {
    const state = this.saved.get(childId);
    if (state !== undefined) state.lastTouched = ++this.clock;
  }

  private evictLru(): void {
    while (this.saved.size > this.maxLruChildren) {
      let victim: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.saved) {
        if (id === this.openChild?.childId) continue;
        if (state.lastTouched < oldest) {
          oldest = state.lastTouched;
          victim = id;
        }
      }
      if (victim === undefined) break;
      this.saved.delete(victim);
    }
  }

  private applyPage(
    state: SavedChildState,
    page: ChildOverlayPage,
    mode: "replace" | "prepend" | "append",
  ): void {
    const incoming = page.entries.map((entry) => ({
      ...entry,
      expanded: state.globalExpanded,
      text: stripPathLike(entry.text),
    }));
    if (mode === "replace") {
      state.entries = dedupEntries(incoming).slice(-this.windowCap);
    } else if (mode === "prepend") {
      state.entries = dedupEntries([...incoming, ...state.entries]).slice(
        -this.windowCap,
      );
    } else {
      state.entries = dedupEntries([...state.entries, ...incoming]).slice(
        -this.windowCap,
      );
    }
    if (mode === "replace") {
      state.olderCursor = page.olderCursor;
      state.newerCursor = page.newerCursor;
      state.hasOlderFlag = page.hasOlder;
      state.hasNewerFlag = page.hasNewer;
      return;
    }
    if (mode === "prepend") {
      state.olderCursor = page.olderCursor;
      state.hasOlderFlag = page.hasOlder;
      return;
    }
    state.newerCursor = page.newerCursor;
    state.hasNewerFlag = page.hasNewer;
  }

  private mergeEntry(state: SavedChildState, entry: ChildOverlayEntry): void {
    const index = state.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      const next = [...state.entries];
      next[index] = { ...entry, expanded: state.globalExpanded };
      state.entries = next;
      return;
    }
    state.entries = dedupEntries([
      ...state.entries,
      { ...entry, expanded: state.globalExpanded },
    ]).slice(-this.windowCap);
  }

  private toView(
    child: ChildOverlayChild,
    state: SavedChildState,
  ): ChildOverlayView {
    const needle = state.searchQuery.trim().toLowerCase();
    const searchMatches =
      needle.length === 0
        ? []
        : state.entries
            .filter((entry) => entry.text.toLowerCase().includes(needle))
            .map((entry) => entry.id);
    return {
      child,
      entries: state.entries,
      draft: state.draft,
      searchQuery: state.searchQuery,
      searchMatches,
      scrollOffset: state.scrollOffset,
      liveTail: state.liveTail,
      globalExpanded: state.globalExpanded,
      activeRun: state.activeRun,
      activeBranchId: state.activeBranchId,
      olderCursor: state.olderCursor,
      newerCursor: state.newerCursor,
      hasOlder: state.hasOlderFlag,
      hasNewer: state.hasNewerFlag,
      readOnly: isReadOnly(child),
      width: state.width,
      height: state.height,
      anchor: state.anchor,
      compact: state.compact,
      transcript: state.transcript,
    };
  }

  private fallbackFromError(
    childId: string,
    reason: ChildOverlayFallbackReason,
    _error: ChildOverlaySourceError,
  ): ChildOverlayFallbackRequired {
    void _error;
    const child = this.openChild;
    const state = this.saved.get(childId);
    const metadata: ChildOverlayFallbackMetadata = {
      childId,
      threadId: child?.threadId ?? childId,
      status: child?.status ?? "settled",
      entryCount: state?.entries.length ?? 0,
      reason,
      readOnly: child === undefined ? true : isReadOnly(child),
    };
    // Ensure no path-like strings leak through error channels.
    return {
      kind: "fallback-required",
      metadata,
      transcript: state?.transcript ?? createPiChildTranscriptState(),
    };
  }
}

function isReadOnly(child: ChildOverlayChild): boolean {
  return child.status === "settled" || child.status === "orphan";
}

function dedupEntries(
  entries: readonly ChildOverlayEntry[],
): ChildOverlayEntry[] {
  const seen = new Set<string>();
  const result: ChildOverlayEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

function stripPathLike(value: string): string {
  // Drop absolute path prefixes that would leak storage locations.
  return boundText(
    value
      .replace(/(?:^|[\s"])(?:\/(?:Users|home|var|tmp|private)\/\S+)/gu, " [path]")
      .replace(/(?:[A-Za-z]:\\[^\s"]+)/gu, " [path]"),
  );
}

function anchorFromScroll(state: SavedChildState): ChildOverlayAnchor | undefined {
  if (state.entries.length === 0) return undefined;
  const index = Math.max(
    0,
    Math.min(
      state.entries.length - 1,
      state.entries.length - 1 - state.scrollOffset,
    ),
  );
  const entry = state.entries[index];
  if (entry === undefined) return undefined;
  return { entryId: entry.id, lineOffset: 0 };
}

function scrollDelta(
  data: string,
): number | "oldest" | "follow" | undefined {
  if (data === SCROLL_KEYS.pageUp) return SCROLL_PAGE;
  if (data === SCROLL_KEYS.pageDown) return -SCROLL_PAGE;
  if (data === SCROLL_KEYS.shiftUp) return 1;
  if (data === SCROLL_KEYS.shiftDown) return -1;
  if (data === SCROLL_KEYS.home) return "oldest";
  if (data === SCROLL_KEYS.end) return "follow";
  return undefined;
}

function projectLiveEntry(
  event: PiChildSessionEvent,
  sequence: number,
  expanded: boolean,
): ChildOverlayEntry | undefined {
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end": {
      const text =
        event.type === "message_end"
          ? messageText(event.message).text
          : event.type === "message_update"
            ? typeof (event as { delta?: { text?: string } }).delta?.text ===
              "string"
              ? boundText(
                  (event as { delta: { text: string } }).delta.text,
                )
              : ""
            : "";
      const id =
        event.type === "message_end" &&
        typeof event.message === "object" &&
        event.message !== null &&
        typeof (event.message as { id?: string }).id === "string"
          ? safeEntryId(
              (event.message as { id: string }).id,
              `live-assistant-${sequence}`,
            )
          : `live-assistant-${sequence}`;
      if (event.type === "message_update" && text.length === 0) return undefined;
      return {
        id,
        sequence,
        kind: "assistant",
        text,
        expanded,
      };
    }
    case "text":
    case "markdown":
      return {
        id: `live-text-${sequence}`,
        sequence,
        kind: "assistant",
        text: boundText(typeof event.text === "string" ? event.text : ""),
        expanded,
      };
    case "thinking":
      return {
        id: `live-thinking-${sequence}`,
        sequence,
        kind: "thinking",
        text: boundText(typeof event.text === "string" ? event.text : ""),
        expanded,
      };
    case "tool_call":
    case "tool_partial_result":
    case "tool_result":
    case "tool_error": {
      const toolId =
        typeof event.toolCallId === "string" && event.toolCallId.length > 0
          ? safeEntryId(event.toolCallId, `live-tool-${sequence}`)
          : `live-tool-${sequence}`;
      return {
        id: toolId,
        sequence,
        kind: event.type === "tool_error" ? "error" : "tool",
        text: boundText(
          typeof event.toolName === "string" ? event.toolName : event.type,
        ),
        expanded,
      };
    }
    case "retry":
      return {
        id: `live-retry-${sequence}`,
        sequence,
        kind: "retry",
        text: boundText(
          `retry ${event.attempt ?? "?"} ${event.reason ?? ""}`.trim(),
        ),
        runNumber:
          typeof event.attempt === "number" ? event.attempt : undefined,
        expanded,
      };
    case "image":
      return {
        id: `live-image-${sequence}`,
        sequence,
        kind: "image",
        text: "image",
        expanded,
      };
    case "status":
      return {
        id: `live-status-${sequence}`,
        sequence,
        kind: "status",
        text: boundText(
          typeof event.status === "string" ? event.status : "status",
        ),
        expanded,
      };
    default:
      return undefined;
  }
}

export function createChildOverlayController(
  source: ChildOverlaySourcePort,
  config?: ChildOverlayConfig,
  mutations?: ChildOverlayMutationPort,
): ChildOverlayController {
  return new ChildOverlayController(source, config, mutations);
}

// ---------------------------------------------------------------------------
// Native custom component (Task 12 phase B1)
// ---------------------------------------------------------------------------

/** Rows Pi keeps for its own footer, status, and padding around the overlay. */
const OVERLAY_RESERVED_HOST_ROWS = 6;

export interface PiChildOverlayCustomComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

function isOverlayFallbackRequired(
  error: ChildOverlayError,
): error is ChildOverlayFallbackRequired {
  return "kind" in error && error.kind === "fallback-required";
}

/**
 * Builds the Spec 33 §7 full-screen overlay as a Pi `ui.custom` component.
 *
 * One component wraps one {@link ChildOverlayController}. Escape closes only
 * this overlay. Renderer/theme/source failures emit typed fallback once and
 * never throw into Pi. Input never reaches a primary-editor callback.
 */
export function createChildOverlayCustomComponent(
  tui: TUI & { readonly width?: number; requestRender(): void },
  theme: EditorTheme,
  keybindings: ConstructorParameters<typeof CustomEditor>[2],
  controller: ChildOverlayController,
  done: () => void,
  onFallback: (fallback: ChildOverlayFallbackRequired) => void,
  nativeDeps?: Omit<PiNativeTranscriptComponentDeps, "tui">,
): PiChildOverlayCustomComponent {
  const draftEditor = new CustomEditor(tui, theme, keybindings);
  const transcriptRenderer = createPiChildTranscriptRenderer();
  let componentFactory: PiTranscriptComponentFactory | undefined;
  let dirty = true;
  let lines: string[] = [];
  let lastWidth = -1;
  let finished = false;
  let fallbackEmitted = false;
  let inputBusy = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    Result.fromThrowable(
      () => {
        done();
      },
      () => "overlay_done_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
  };

  const emitFallback = (
    reason: ChildOverlayFallbackReason | ChildOverlayFallbackRequired,
  ): void => {
    if (fallbackEmitted) return;
    fallbackEmitted = true;
    const payload =
      typeof reason === "string" ? controller.requireFallback(reason) : reason;
    Result.fromThrowable(
      () => {
        onFallback(payload);
      },
      () => "overlay_fallback_callback_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
    finish();
  };

  const factory = (): PiTranscriptComponentFactory => {
    componentFactory ??= createPiNativeTranscriptComponentFactory({
      ...nativeDeps,
      cwd: nativeDeps?.cwd ?? ".",
      tui,
    });
    return componentFactory;
  };

  const visibleHeight = (): number => {
    const rows = Result.fromThrowable(
      () => tui.terminal?.rows,
      () => "terminal_rows_unavailable" as const,
    )().unwrapOr(undefined);
    const usable = typeof rows === "number" && rows > 0 ? rows : 40;
    return Math.max(8, usable - OVERLAY_RESERVED_HOST_ROWS);
  };

  const syncDraftEditor = (view: ChildOverlayView): void => {
    if (view.readOnly) {
      if (draftEditor.getText() !== "") draftEditor.setText("");
      return;
    }
    if (draftEditor.getText() !== view.draft) draftEditor.setText(view.draft);
  };

  const renderEditorLines = (width: number, readOnly: boolean): string[] => {
    if (readOnly) return [];
    const rendered = Result.fromThrowable(
      () => draftEditor.render(width),
      () => "editor_render_failed" as const,
    )().unwrapOr([]);
    return Array.isArray(rendered) && rendered.length > 0
      ? rendered
      : [`> ${draftEditor.getText()}`];
  };

  const headerLines = (view: ChildOverlayView, width: number): string[] => {
    const title = view.child.title ?? view.child.childId;
    const status = view.child.status.toUpperCase();
    const run =
      view.activeRun !== undefined ? `run ${view.activeRun}` : undefined;
    const branch =
      view.activeBranchId !== undefined
        ? `branch ${view.activeBranchId}`
        : undefined;
    const meta = [run, branch].filter((part) => part !== undefined).join(" · ");
    const header = [
      boundText(`◆ ${title} · ${status}`),
      ...(meta.length > 0 ? [boundText(meta)] : []),
    ];
    if (view.readOnly) {
      header.push(
        boundText(
          view.child.status === "orphan"
            ? "Read-only orphan — mutations disabled"
            : "Read-only — settled child",
        ),
      );
    }
    if (view.searchQuery.length > 0) {
      header.push(
        boundText(
          `Search: ${view.searchQuery} (${view.searchMatches.length} match${view.searchMatches.length === 1 ? "" : "es"})`,
        ),
      );
    }
    header.push("─".repeat(Math.min(width, 40)));
    return header;
  };

  const renderTranscriptLines = (
    view: ChildOverlayView,
    width: number,
  ): Result<readonly string[], ChildOverlayFallbackRequired> => {
    return Result.fromThrowable(
      () => {
        const rendered = transcriptRenderer.render(view.transcript, width, {
          componentFactory: factory(),
        });
        if (rendered.lines.length > 0) return rendered.lines;
        // Native factory may suppress bookkeeping rows; fall back to overlay
        // entry text so kinds remain visible in the bounded window.
        return view.entries.map((entry) =>
          boundText(
            entry.expanded || entry.text.length <= 120
              ? `[${entry.kind}] ${entry.text}`
              : `[${entry.kind}] ${entry.text.slice(0, 117)}…`,
          ),
        );
      },
      (): ChildOverlayFallbackRequired =>
        controller.requireFallback("render-failed"),
    )();
  };

  const requestPaint = (): void => {
    dirty = true;
    Result.fromThrowable(
      () => {
        tui.requestRender();
      },
      () => "overlay_request_render_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
  };

  const afterControllerOutcome = (
    outcome: Result<ChildOverlayInputOutcome, ChildOverlayError>,
  ): void => {
    if (outcome.isErr()) {
      if (isOverlayFallbackRequired(outcome.error)) {
        emitFallback(outcome.error);
        return;
      }
      emitFallback("source-failed");
      return;
    }
    if (outcome.value.kind === "fallback-required") {
      emitFallback(outcome.value);
      return;
    }
    const view = controller.view();
    if (view.isOk()) syncDraftEditor(view.value);
    requestPaint();
  };

  const handlePaginationEdge = (
    data: string,
  ): ResultAsync<void, ChildOverlayError> => {
    const viewResult = controller.view();
    if (viewResult.isErr()) return errAsync(viewResult.error);
    const view = viewResult.value;
    if (data === SCROLL_KEYS.pageUp && view.hasOlder) {
      const nearOldest =
        view.scrollOffset >= Math.max(0, view.entries.length - 1);
      if (nearOldest || view.entries.length === 0) {
        return controller.loadOlder().map(() => undefined);
      }
    }
    if (
      (data === SCROLL_KEYS.pageDown || data === SCROLL_KEYS.end) &&
      view.hasNewer &&
      (view.liveTail || view.scrollOffset === 0)
    ) {
      return controller.loadNewer().map(() => undefined);
    }
    return okAsync(undefined);
  };

  return {
    render(width) {
      return Result.fromThrowable(
        (): string[] => {
          if (finished) return lines;
          const resized = controller.resize(width, visibleHeight());
          if (resized.isErr()) {
            if (isOverlayFallbackRequired(resized.error)) {
              emitFallback(resized.error);
            } else if (
              !("type" in resized.error) ||
              resized.error.type !== "OverlayNotOpen"
            ) {
              emitFallback("render-failed");
            }
            return lines;
          }
          const view = resized.value;
          if (dirty || width !== lastWidth) {
            syncDraftEditor(view);
            const header = headerLines(view, width);
            const editorLines = renderEditorLines(width, view.readOnly);
            const transcript = renderTranscriptLines(view, width);
            if (transcript.isErr()) {
              emitFallback(transcript.error);
              return lines;
            }
            const budget = Math.max(
              1,
              visibleHeight() - editorLines.length - header.length - 1,
            );
            const scrollMax = Math.max(0, transcript.value.length - budget);
            const scrollOffset = Math.min(view.scrollOffset, scrollMax);
            const end = transcript.value.length - scrollOffset;
            lines = [
              ...header,
              ...transcript.value.slice(Math.max(0, end - budget), end),
              ...(scrollOffset > 0
                ? [
                    boundText(
                      `${scrollOffset} newer line(s) below — End follows output`,
                    ),
                  ]
                : []),
              ...editorLines,
            ];
            dirty = false;
            lastWidth = width;
          }
          return lines;
        },
        (): string[] => {
          emitFallback("render-failed");
          return lines;
        },
      )().unwrapOr(lines);
    },
    handleInput(data) {
      if (finished || inputBusy) return;
      Result.fromThrowable(
        () => {
          if (
            keybindings.matches(data, "tui.select.cancel") ||
            data === "\x1b"
          ) {
            finish();
            return;
          }
          inputBusy = true;
          void handlePaginationEdge(data)
            .andThen(() => controller.handleInput(data))
            .match(
              (value) => {
                inputBusy = false;
                afterControllerOutcome(ok(value));
              },
              (error) => {
                inputBusy = false;
                afterControllerOutcome(err(error));
              },
            );
        },
        () => "overlay_input_failed" as const,
      )().match(
        () => undefined,
        () => {
          inputBusy = false;
          emitFallback("render-failed");
        },
      );
    },
    invalidate() {
      dirty = true;
    },
  };
}

/** Re-export transcript entry type for handoff consumers. */
export type { PiChildTranscriptEntry, PiChildTranscriptState };
