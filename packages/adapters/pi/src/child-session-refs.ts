/**
 * Parent custom-entry child refs (Spec 33, ADR 0014, plan Task 5).
 *
 * A *ref* is bounded metadata the adapter appends into the **parent** Pi
 * session through `ExtensionAPI.appendEntry(customType, data)`: an opaque
 * child/thread id, the native child session id, the root-relative session
 * ref, the immutable originating parent session id and originating parent
 * entry id, a title, a status, created/updated/settled timestamps, and a
 * bounded run list.
 *
 * Refs are **observations, never authority**. The authoritative child
 * transcript is the native session file owned by `child-native-sessions.ts`
 * (Task 4). This module therefore:
 *
 * - never carries a prompt, message, assistant response, thinking block,
 *   tool result, or any other transcript content into a parent entry;
 * - never resurrects, repairs, writes, or mutates a child session - it has
 *   no session-mutating port at all;
 * - refuses to return a ref whose authoritative session is missing, corrupt,
 *   unavailable, or tombstoned, reporting it as an informational issue for
 *   doctor instead;
 * - silently excludes refs copied into a forked/cloned parent session, whose
 *   recorded originating parent session id no longer equals the live parent
 *   session id, and never appends an update for such a child.
 *
 * Pi's `appendEntry` returns `void` and yields no entry id, so the origin
 * entry id in the envelope is an adapter-owned opaque id minted here and
 * held immutable across every later update for the same child.
 *
 * Every parsed value goes through a strict, versioned, fully bounded Zod
 * schema with `safeParse`; expected validation failures return typed
 * results and never throw.
 */

import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  type PiNativeSessionError,
  type PiNativeSessionRecord,
  type PiNativeSessionTombstone,
  verifyNativeSessionRef,
} from "./child-native-sessions.js";
import {
  enforceDurableChildTitle,
  enforceDurableChildTitleProvenance,
  PI_CHILD_TITLE_PROVENANCE_VALUES,
} from "./child-title.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Schema version of the parent custom-entry envelope. */
export const PI_CHILD_REF_SCHEMA_VERSION = 1 as const;

/** Custom entry type appended into the parent session. */
export const PI_CHILD_REF_ENTRY_TYPE = "weave.child-ref.v1" as const;

/**
 * Persisted **ordering identity** for ref envelopes.
 *
 * Ordering is deliberately *not* the run count. A run ordinal is a display
 * fact about how many times a thread has been asked to work; envelope
 * ordering is a write-order fact about which persisted record is newest. The
 * two were the same number before, which meant the retained-window ceiling,
 * the cumulative-run ceiling, and the newest-wins tiebreak all shared one
 * saturating counter: past it, appends failed and repeated writes reused a
 * sequence, so a stale record could win a read.
 *
 * The ordering clock is a hybrid logical clock: each append takes
 * `max(previousSequence + 1, wallClockMillis)`. That is strictly monotonic
 * per child (so no value is ever reused), independent of run count (so
 * lifecycle appends never collide with run dividers), and anchored to real
 * time (so a restarted store that has read nothing still outranks every
 * earlier append).
 *
 * `maxSequence` is derived rather than chosen. The clock only exceeds wall
 * time by the number of appends made faster than the clock ticks, and
 * `appendedAt` itself stops being schema-valid past `maxTimestamp`. Doubling
 * the wall-clock ceiling therefore leaves about 4.1e12 spare counter ticks
 * beyond any schema-valid instant: exhausting them needs ~4.1e12 further
 * appends inside a single millisecond, each of which is a separately
 * persisted parent entry. No schema-valid thread lifetime can reach it, so
 * the ceiling exists only to keep the field finite. It still fails closed if
 * it is somehow reached, because emitting a duplicate sequence would silently
 * corrupt newest-wins resolution.
 */
export const PI_CHILD_REF_ORDER = Object.freeze({
  /** Latest schema-valid wall-clock instant carried by a ref (year 2100). */
  maxTimestamp: 4_102_444_800_000,
  /** Derived ceiling on the ordering clock: wall-clock ceiling plus slack. */
  maxSequence: 8_204_889_600_000,
});

/** Hard bounds applied to every string, array, and number in a ref. */
export const PI_CHILD_REF_BOUNDS = Object.freeze({
  maxIdLength: 256,
  maxRefLength: 1_024,
  maxTitleLength: 200,
  maxLabelLength: 128,
  /**
   * Run entries *retained in one ref record*. This is a bounded, newest-last
   * window over the run history, not a ceiling on how many runs a thread may
   * have: `appendRunDivider` trims the oldest entries out of the window and
   * keeps appending. The authoritative count lives in `totalRuns`.
   */
  maxRuns: 64,
  /**
   * Ceiling on a run *ordinal* and on `totalRuns`.
   *
   * Derived from the ordering clock, not chosen: every run divider is one
   * append, and every append advances the clock by at least one, so
   * `run <= totalRuns <= sequence <= PI_CHILD_REF_ORDER.maxSequence` holds for
   * any record this store can write. Bounding the ordinal by the clock
   * ceiling therefore keeps the field finite without introducing a *second*,
   * lower ceiling that a healthy long-lived thread could hit first. Run
   * 1,000,001 is an ordinary value.
   */
  maxRunOrdinal: PI_CHILD_REF_ORDER.maxSequence,
  maxTimestamp: PI_CHILD_REF_ORDER.maxTimestamp,
  /** Parent entries inspected in one scan, independent of caller input. */
  maxScannedEntries: 4_096,
  /** Refs returned by one read, independent of caller input. */
  maxReturnedRefs: 200,
  /** Issues reported by one read, independent of caller input. */
  maxReportedIssues: 200,
});

const textEncoder = new TextEncoder();

const boundedString = (maxCharacters: number) =>
  z
    .string()
    .max(maxCharacters)
    .refine(
      (value) => textEncoder.encode(value).byteLength <= maxCharacters * 4,
      `string exceeds ${maxCharacters * 4} UTF-8 bytes`,
    );

const idSchema = boundedString(PI_CHILD_REF_BOUNDS.maxIdLength).pipe(
  z.string().min(1),
);
const labelSchema = boundedString(PI_CHILD_REF_BOUNDS.maxLabelLength);
const titleSchema = boundedString(PI_CHILD_REF_BOUNDS.maxTitleLength);
const timestampSchema = z
  .number()
  .int()
  .min(0)
  .max(PI_CHILD_REF_BOUNDS.maxTimestamp);
const sessionRefSchema = boundedString(PI_CHILD_REF_BOUNDS.maxRefLength).pipe(
  z
    .string()
    .min(1)
    .refine(
      (value) => verifyNativeSessionRef(value).isOk(),
      "sessionRef must be a contained root-relative session ref",
    ),
);

// ---------------------------------------------------------------------------
// Ref schema
// ---------------------------------------------------------------------------

export const PiChildRefStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "tombstoned",
]);
export type PiChildRefStatus = z.infer<typeof PiChildRefStatusSchema>;

export const PiChildRefRunActionSchema = z.enum(["start", "retry", "continue"]);
export type PiChildRefRunAction = z.infer<typeof PiChildRefRunActionSchema>;

/**
 * One run of a thread. Metadata only: no instruction text, no response, no
 * tool output - only the identity and shape of the run.
 */
export const PiChildRefRunSchema = z
  .object({
    run: z.number().int().min(1).max(PI_CHILD_REF_BOUNDS.maxRunOrdinal),
    action: PiChildRefRunActionSchema,
    startedAt: timestampSchema,
    priorOutcome: PiChildRefStatusSchema.optional(),
    initiator: labelSchema.optional(),
    model: labelSchema.optional(),
    reasoning: labelSchema.optional(),
  })
  .strict();
export type PiChildRefRun = z.infer<typeof PiChildRefRunSchema>;

/** Bounded, metadata-only description of one child thread. */
export const PiChildRefRecordSchema = z
  .object({
    /** Opaque child id. */
    childId: idSchema,
    /** Opaque thread id; equal to the child id for single-thread children. */
    threadId: idSchema,
    /** Native Pi session id of the authoritative child session. */
    nativeSessionId: idSchema,
    /** Root-relative ref into the Weave-owned native session root. */
    sessionRef: sessionRefSchema,
    /** Immutable originating parent session id. */
    originParentSessionId: idSchema,
    /** Immutable adapter-owned opaque originating parent entry id. */
    originEntryId: idSchema,
    title: titleSchema,
    /**
     * Versioned proof that `title` was derived from trusted identity metadata
     * (Task 21 remediation D). Optional so refs written before the marker
     * existed still parse; absent means unproven, and the parse boundary
     * replaces such a title with the identity-only fallback. Unknown values
     * are rejected by the closed enum as invalid data.
     */
    titleProvenance: z.enum(PI_CHILD_TITLE_PROVENANCE_VALUES).optional(),
    status: PiChildRefStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    settledAt: timestampSchema.optional(),
    /**
     * Bounded newest-last *window* over the run history. It is a projection,
     * never the authority on how many runs happened: entries older than
     * `maxRuns` are dropped from the record so the parent entry stays small.
     */
    runs: z.array(PiChildRefRunSchema).max(PI_CHILD_REF_BOUNDS.maxRuns),
    /**
     * Authoritative cumulative run count. Optional so refs written before the
     * field existed still parse; absent means the window *is* the whole
     * history, which was true while the window could not overflow.
     */
    totalRuns: z
      .number()
      .int()
      .min(0)
      .max(PI_CHILD_REF_BOUNDS.maxRunOrdinal)
      .optional(),
  })
  .strict()
  .refine(
    (record) =>
      record.totalRuns === undefined ||
      (record.totalRuns >= record.runs.length &&
        record.totalRuns >= (record.runs.at(-1)?.run ?? 0)),
    {
      error: "totalRuns must cover the retained run window",
      path: ["totalRuns"],
    },
  );
export type PiChildRefRecord = z.infer<typeof PiChildRefRecordSchema>;

/**
 * Cumulative runs a thread has had, independent of the retained window.
 *
 * Older refs carry no `totalRuns`, and for those the window is the history.
 * Newer refs may have dropped the oldest entries, so the stored count and the
 * newest retained ordinal both outrank `runs.length`.
 */
export function childRefTotalRuns(record: PiChildRefRecord): number {
  return Math.max(
    record.totalRuns ?? 0,
    record.runs.at(-1)?.run ?? 0,
    record.runs.length,
  );
}

export const PiChildRefEntryKindSchema = z.enum([
  "new-child",
  "run-divider",
  "lifecycle",
]);
export type PiChildRefEntryKind = z.infer<typeof PiChildRefEntryKindSchema>;

/** Versioned envelope actually written into one parent custom entry. */
export const PiChildRefEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(PI_CHILD_REF_SCHEMA_VERSION),
    entryType: z.literal(PI_CHILD_REF_ENTRY_TYPE),
    kind: PiChildRefEntryKindSchema,
    /**
     * Monotonic per-child ordering clock; higher wins on read. Independent of
     * the run ordinal: see `PI_CHILD_REF_ORDER`.
     */
    sequence: z.number().int().min(1).max(PI_CHILD_REF_ORDER.maxSequence),
    appendedAt: timestampSchema,
    record: PiChildRefRecordSchema,
  })
  .strict();
export type PiChildRefEnvelope = z.infer<typeof PiChildRefEnvelopeSchema>;

/**
 * Tolerant shape of one parent session entry as read back from the host.
 * Unrelated entries simply fail this shape and are skipped without an issue.
 */
const ParentEntryShapeSchema = z.looseObject({
  customType: z.string().max(512).optional(),
  type: z.string().max(512).optional(),
  data: z.unknown(),
});

// ---------------------------------------------------------------------------
// Errors and issues
// ---------------------------------------------------------------------------

/** Authoritative-source state of one child session, as observed for a ref. */
export type PiChildRefSourceState =
  | "available"
  | "missing"
  | "corrupt"
  | "unavailable"
  | "tombstoned";

/** Closed failure set for append and read operations. */
export type PiChildRefError =
  | { readonly type: "ChildRefInvalid"; readonly issues: readonly string[] }
  | { readonly type: "ChildRefOriginMismatch"; readonly childId: string }
  | {
      readonly type: "ChildRefAppendFailed";
      readonly reason: "host-threw";
    }
  | {
      readonly type: "ChildRefSourceUnusable";
      readonly childId: string;
      readonly state: Exclude<PiChildRefSourceState, "available">;
    }
  | { readonly type: "ChildRefParentUnavailable" };

/** Informational, non-fatal observation produced by a read. Doctor-facing. */
export type PiChildRefIssue =
  | { readonly kind: "malformed-entry"; readonly index: number }
  | {
      readonly kind: "invalid-envelope";
      readonly index: number;
      readonly issues: readonly string[];
    }
  | { readonly kind: "origin-mismatch"; readonly childId: string }
  | {
      readonly kind: "conflicting-entry";
      readonly childId: string;
      readonly field:
        | "originParentSessionId"
        | "originEntryId"
        | "sessionRef"
        | "nativeSessionId";
    }
  | { readonly kind: "duplicate-entry"; readonly childId: string }
  | {
      readonly kind: "source-unusable";
      readonly childId: string;
      readonly state: Exclude<PiChildRefSourceState, "available">;
    };

/** Bounded counters a doctor surface can render without further scanning. */
export interface PiChildRefScanCounts {
  readonly scannedEntries: number;
  readonly candidateEntries: number;
  readonly malformedEntries: number;
  readonly originMismatchedChildren: number;
  readonly conflictingChildren: number;
  readonly duplicateEntries: number;
  readonly unusableSourceChildren: number;
  readonly usableRefs: number;
}

/** Result of one bounded parent scan. */
export interface PiChildRefScan {
  /** Valid, origin-matching refs with a usable authoritative session. */
  readonly refs: readonly PiChildRefRecord[];
  readonly issues: readonly PiChildRefIssue[];
  readonly counts: PiChildRefScanCounts;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Append boundary: exactly Pi's `appendEntry(customType, data): void`. */
export interface PiChildRefAppendPort {
  appendEntry(customType: string, data: unknown): void;
}

/** Read boundary: Pi's `get_entries` / native equivalent. */
export interface PiChildRefEntryReadPort {
  getEntries(): readonly unknown[];
}

/**
 * Source-authority boundary over the Task 4 native session store. A ref is
 * only usable when its authoritative session answers `"available"`.
 */
export interface PiChildRefSourceAuthority {
  checkSource(
    sessionRef: string,
    expectedParentSessionId: string,
  ): ResultAsync<PiChildRefSourceState, never>;
}

/** The read-only slice of `PiNativeSessionStore` the authority adapter needs. */
export interface PiChildRefNativeSessionReader {
  openSession(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<PiNativeSessionRecord, PiNativeSessionError>;
  readTombstones(): ResultAsync<
    readonly PiNativeSessionTombstone[],
    PiNativeSessionError
  >;
}

/**
 * Adapts the Task 4 native session store into a source authority. Read-only:
 * it opens and lists, and has no path that creates, repairs, or mutates a
 * child session.
 */
export function createNativeChildRefSourceAuthority(
  store: PiChildRefNativeSessionReader,
): PiChildRefSourceAuthority {
  let tombstoned: ReadonlySet<string> | undefined;

  const loadTombstones = (): ResultAsync<ReadonlySet<string>, never> => {
    if (tombstoned !== undefined) return okAsync(tombstoned);
    return ResultAsync.fromSafePromise(
      store.readTombstones().match(
        (records): ReadonlySet<string> =>
          new Set(records.map((record) => record.ref)),
        (): ReadonlySet<string> => new Set<string>(),
      ),
    ).map((set) => {
      tombstoned = set;
      return set;
    });
  };

  return {
    checkSource(sessionRef, expectedParentSessionId) {
      return loadTombstones().andThen((set) => {
        if (set.has(sessionRef)) {
          return okAsync<PiChildRefSourceState, never>("tombstoned");
        }
        return ResultAsync.fromSafePromise(
          store.openSession(sessionRef, expectedParentSessionId).match(
            (): PiChildRefSourceState => "available",
            (error): PiChildRefSourceState => {
              if (error.type === "SessionMissing") return "missing";
              if (error.type === "SessionCorrupt") return "corrupt";
              return "unavailable";
            },
          ),
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function issuePaths(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => issue.path.join("."));
}

/**
 * Replaces a stored title that cannot be proven to come from trusted identity
 * metadata (Threat Model T6, Warp blocker 1, Task 21 remediation D).
 *
 * Proof is the persisted `titleProvenance` marker, never the shape of the
 * title: refs written before the marker existed stored a bounded first line of
 * the delegated task, and such a line may coincidentally look like a derived
 * identity title. An unmarked or unrecognized row therefore loses its stored
 * title before the record exists as a value, and is re-marked so the safe
 * fallback it now carries is itself proven. Applied on every parse, so both
 * the write path and the read path of this module are covered, and idempotent
 * for records that are already proven.
 */
function withEnforcedTitle(record: PiChildRefRecord): PiChildRefRecord {
  const stored = {
    title: record.title,
    threadId: record.threadId,
    ...(record.titleProvenance === undefined
      ? {}
      : { provenance: record.titleProvenance }),
  };
  const title = enforceDurableChildTitle(stored);
  const titleProvenance = enforceDurableChildTitleProvenance(stored);
  if (title === record.title && titleProvenance === record.titleProvenance) {
    return record;
  }
  return { ...record, title, titleProvenance };
}

/** Validates one ref record. Never throws; validation failures are values. */
export function parseChildRefRecord(
  value: unknown,
): Result<PiChildRefRecord, PiChildRefError> {
  const parsed = PiChildRefRecordSchema.safeParse(value);
  if (parsed.success) return ok(withEnforcedTitle(parsed.data));
  return err({ type: "ChildRefInvalid", issues: issuePaths(parsed.error) });
}

/** Validates one parent custom-entry envelope. Never throws. */
export function parseChildRefEnvelope(
  value: unknown,
): Result<PiChildRefEnvelope, PiChildRefError> {
  const parsed = PiChildRefEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return err({ type: "ChildRefInvalid", issues: issuePaths(parsed.error) });
  }
  const record = withEnforcedTitle(parsed.data.record);
  return ok(
    record === parsed.data.record ? parsed.data : { ...parsed.data, record },
  );
}

/**
 * Extracts the envelope payload of one host entry.
 *
 * `undefined` means "not one of ours" (unrelated entry, skipped silently);
 * a value means "claims to be ours" and must then validate.
 */
function candidatePayload(entry: unknown): unknown | undefined {
  const shape = ParentEntryShapeSchema.safeParse(entry);
  if (!shape.success) return undefined;
  const marker = shape.data.customType ?? shape.data.type;
  if (marker !== PI_CHILD_REF_ENTRY_TYPE) return undefined;
  return shape.data.data;
}

/** Internal shape produced by the synchronous parent-entry scan. */
interface PiChildRefEntryScan {
  readonly latest: readonly PiChildRefEnvelope[];
  readonly issues: PiChildRefIssue[];
  readonly counts: {
    readonly scannedEntries: number;
    readonly candidateEntries: number;
    readonly malformedEntries: number;
    readonly originMismatchedChildren: number;
    readonly conflictingChildren: number;
    readonly duplicateEntries: number;
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface PiChildSessionRefStoreOptions {
  /** Live parent session id. Origin authority is measured against this. */
  readonly parentSessionId: string;
  readonly append: PiChildRefAppendPort;
  readonly read: PiChildRefEntryReadPort;
  readonly authority: PiChildRefSourceAuthority;
  readonly now?: () => number;
  /** Injected opaque origin-entry-id mint; defaults to `crypto.randomUUID`. */
  readonly newEntryId?: () => string;
}

export interface AppendNewChildRefInput {
  readonly childId: string;
  readonly threadId?: string;
  readonly nativeSessionId: string;
  readonly sessionRef: string;
  readonly title: string;
  /**
   * Provenance marker for `title`. Callers that derive the title from
   * trusted identity metadata pass the current marker exported by
   * `child-title.ts`; omitting it makes the ref boundary discard the title in
   * favour of the safe fallback.
   */
  readonly titleProvenance?: string;
  readonly status?: PiChildRefStatus;
  readonly run?: Omit<PiChildRefRun, "run">;
}

export interface AppendChildRefRunInput {
  readonly action: PiChildRefRunAction;
  readonly priorOutcome?: PiChildRefStatus;
  readonly initiator?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly status?: PiChildRefStatus;
}

export interface AppendChildRefLifecycleInput {
  readonly status: PiChildRefStatus;
  readonly title?: string;
  /** Provenance marker for a replacement `title`. */
  readonly titleProvenance?: string;
  readonly settledAt?: number;
}

/**
 * Writes and reads bounded, metadata-only child refs in the live parent
 * session. Refs are observations: nothing here can create, repair, or mutate
 * a child session, and no method returns a ref whose authoritative session is
 * unusable.
 */
export class PiChildSessionRefStore {
  private readonly parentSessionId: string;
  private readonly append: PiChildRefAppendPort;
  private readonly read: PiChildRefEntryReadPort;
  private readonly authority: PiChildRefSourceAuthority;
  private readonly now: () => number;
  private readonly newEntryId: () => string;
  /** Highest ordering clock observed or written per child, seeded by reads. */
  private readonly sequences = new Map<string, number>();

  constructor(options: PiChildSessionRefStoreOptions) {
    this.parentSessionId = options.parentSessionId;
    this.append = options.append;
    this.read = options.read;
    this.authority = options.authority;
    this.now = options.now ?? (() => Date.now());
    this.newEntryId = options.newEntryId ?? (() => crypto.randomUUID());
  }

  /** Live parent session id this store writes and filters against. */
  liveParentSessionId(): string {
    return this.parentSessionId;
  }

  /**
   * Appends the first entry for a new child. The originating parent session
   * id is the live parent, and the originating parent entry id is minted here
   * because Pi's `appendEntry` returns no id. Both are immutable afterwards.
   *
   * The authoritative native session must already exist and belong to this
   * live parent; missing/corrupt/unavailable/tombstoned sources reject with
   * zero writes and never create or resurrect a child session.
   */
  appendNewChild(
    input: AppendNewChildRefInput,
  ): ResultAsync<PiChildRefRecord, PiChildRefError> {
    if (this.parentSessionId.length === 0) {
      return errAsync({ type: "ChildRefParentUnavailable" });
    }
    const at = this.now();
    const runs =
      input.run === undefined
        ? []
        : [{ ...input.run, run: 1, startedAt: input.run.startedAt }];
    const candidate = {
      childId: input.childId,
      threadId: input.threadId ?? input.childId,
      nativeSessionId: input.nativeSessionId,
      sessionRef: input.sessionRef,
      originParentSessionId: this.parentSessionId,
      originEntryId: this.newEntryId(),
      title: input.title,
      ...(input.titleProvenance === undefined
        ? {}
        : { titleProvenance: input.titleProvenance }),
      status: input.status ?? "queued",
      createdAt: at,
      updatedAt: at,
      runs,
      totalRuns: runs.length,
    };
    return parseChildRefRecord(candidate).asyncAndThen((record) =>
      this.write("new-child", record).map(() => record),
    );
  }

  /**
   * Appends run-divider metadata for an existing child: a new run entry plus
   * the resulting status snapshot. Origin ids are carried forward unchanged.
   * Re-checks source authority before every host write.
   */
  appendRunDivider(
    record: PiChildRefRecord,
    input: AppendChildRefRunInput,
  ): ResultAsync<PiChildRefRecord, PiChildRefError> {
    return this.guardOrigin(record).asyncAndThen(() => {
      const at = this.now();
      // The run *ordinal* continues past the retained window: dropping old
      // window entries is a projection concern, and a thread that has already
      // run `maxRuns` times must still be able to run again. The ordinal is
      // also not the envelope ordering identity, so it never has to leave room
      // for lifecycle appends. Only the clock-derived ceiling - unreachable in
      // any schema-valid lifetime - can refuse an append.
      const nextRun = childRefTotalRuns(record) + 1;
      if (nextRun > PI_CHILD_REF_BOUNDS.maxRunOrdinal) {
        return errAsync<PiChildRefRecord, PiChildRefError>({
          type: "ChildRefInvalid",
          issues: ["totalRuns"],
        });
      }
      const run: PiChildRefRun = {
        run: nextRun,
        action: input.action,
        startedAt: at,
        ...(input.priorOutcome === undefined
          ? {}
          : { priorOutcome: input.priorOutcome }),
        ...(input.initiator === undefined
          ? {}
          : { initiator: input.initiator }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.reasoning === undefined
          ? {}
          : { reasoning: input.reasoning }),
      };
      const candidate = {
        ...record,
        status: input.status ?? "running",
        updatedAt: at,
        // Newest-last window: the oldest entries fall out, the count does not.
        runs: [...record.runs, run].slice(-PI_CHILD_REF_BOUNDS.maxRuns),
        totalRuns: nextRun,
      };
      return parseChildRefRecord(candidate).asyncAndThen((next) =>
        this.write("run-divider", next).map(() => next),
      );
    });
  }

  /**
   * Appends a lifecycle/status update for an existing child. Re-checks source
   * authority before every host write.
   */
  appendLifecycle(
    record: PiChildRefRecord,
    input: AppendChildRefLifecycleInput,
  ): ResultAsync<PiChildRefRecord, PiChildRefError> {
    return this.guardOrigin(record).asyncAndThen(() => {
      const at = this.now();
      const settledAt =
        input.settledAt ??
        (input.status === "running" || input.status === "queued"
          ? record.settledAt
          : at);
      // A replacement title carries its own provenance; the previous marker is
      // dropped so a caller cannot relabel arbitrary text as trusted by reusing
      // the record's existing marker.
      const titleProvenance =
        input.title === undefined
          ? record.titleProvenance
          : input.titleProvenance;
      const { titleProvenance: _previous, ...carried } = record;
      const candidate = {
        ...carried,
        title: input.title ?? record.title,
        ...(titleProvenance === undefined ? {} : { titleProvenance }),
        status: input.status,
        updatedAt: at,
        ...(settledAt === undefined ? {} : { settledAt }),
      };
      return parseChildRefRecord(candidate).asyncAndThen((next) =>
        this.write("lifecycle", next).map(() => next),
      );
    });
  }

  /**
   * Scans the parent's custom entries and returns usable refs newest-first.
   *
   * Malformed and unrelated entries are tolerated. Origin-mismatched refs
   * (fork/clone copies) are excluded silently and reported only as
   * informational issues. Children with conflicting immutable fields fail
   * closed. Children whose authoritative native session is missing, corrupt,
   * unavailable, or tombstoned are excluded and reported.
   */
  readRefs(
    options: { readonly limit?: number } = {},
  ): ResultAsync<PiChildRefScan, PiChildRefError> {
    return this.scanEntries().asyncAndThen((scan) =>
      this.applyAuthority(scan, options.limit),
    );
  }

  private guardOrigin(
    record: PiChildRefRecord,
  ): Result<PiChildRefRecord, PiChildRefError> {
    if (this.parentSessionId.length === 0) {
      return err({ type: "ChildRefParentUnavailable" });
    }
    if (record.originParentSessionId !== this.parentSessionId) {
      return err({
        type: "ChildRefOriginMismatch",
        childId: record.childId,
      });
    }
    return ok(record);
  }

  /**
   * Next per-child ordering clock value.
   *
   * Hybrid logical clock: `max(previousSequence + 1, wallClockMillis)`. It is
   * strictly increasing per child, so no value is ever reused and a duplicate
   * can never be emitted; it is seeded from the highest sequence seen in the
   * parent session during a read, so a restarted store continues the same
   * order; and it is anchored to wall time, so even an unseeded store
   * outranks earlier appends. It never derives from the run count, so run
   * dividers and lifecycle updates share one order without colliding.
   *
   * Fails closed rather than clamping: a clamped clock would reuse a value
   * and let a stale record win newest-wins resolution.
   */
  private nextSequence(childId: string): Result<number, PiChildRefError> {
    const previous = this.sequences.get(childId) ?? 0;
    const raw = this.now();
    const wall =
      Number.isSafeInteger(raw) && raw > 0
        ? Math.min(raw, PI_CHILD_REF_ORDER.maxTimestamp)
        : 0;
    const next = Math.max(previous + 1, wall);
    if (next > PI_CHILD_REF_ORDER.maxSequence) {
      return err({ type: "ChildRefInvalid", issues: ["sequence"] });
    }
    this.sequences.set(childId, next);
    return ok(next);
  }

  private write(
    kind: PiChildRefEntryKind,
    record: PiChildRefRecord,
  ): ResultAsync<void, PiChildRefError> {
    return this.authority
      .checkSource(record.sessionRef, this.parentSessionId)
      .andThen((state) => {
        if (state !== "available") {
          return errAsync<void, PiChildRefError>({
            type: "ChildRefSourceUnusable",
            childId: record.childId,
            state,
          });
        }
        const sequence = this.nextSequence(record.childId);
        if (sequence.isErr())
          return errAsync<void, PiChildRefError>(sequence.error);
        const envelope: PiChildRefEnvelope = {
          schemaVersion: PI_CHILD_REF_SCHEMA_VERSION,
          entryType: PI_CHILD_REF_ENTRY_TYPE,
          kind,
          sequence: sequence.value,
          appendedAt: this.now(),
          record,
        };
        const validated = parseChildRefEnvelope(envelope);
        if (validated.isErr()) return errAsync(validated.error);
        const written = Result.fromThrowable(
          () => {
            this.append.appendEntry(PI_CHILD_REF_ENTRY_TYPE, validated.value);
          },
          (): PiChildRefError => ({
            type: "ChildRefAppendFailed",
            reason: "host-threw",
          }),
        )();
        return written.isOk() ? okAsync(undefined) : errAsync(written.error);
      });
  }

  /**
   * Bounded, synchronous entry scan with conflict and origin resolution.
   * Pi `getEntries()` is chronological, so the newest bounded window is kept.
   */
  private scanEntries(): Result<PiChildRefEntryScan, PiChildRefError> {
    const entriesResult = Result.fromThrowable(
      () => this.read.getEntries(),
      (): PiChildRefError => ({ type: "ChildRefParentUnavailable" }),
    )();
    if (entriesResult.isErr()) return err(entriesResult.error);

    const entries = entriesResult.value.slice(
      -PI_CHILD_REF_BOUNDS.maxScannedEntries,
    );
    const issues: PiChildRefIssue[] = [];
    const latest = new Map<string, PiChildRefEnvelope>();
    const conflicting = new Set<string>();
    const mismatched = new Set<string>();
    let candidateEntries = 0;
    let malformedEntries = 0;
    let duplicateEntries = 0;

    for (const [index, entry] of entries.entries()) {
      const payload = candidatePayload(entry);
      if (payload === undefined) continue;
      candidateEntries += 1;
      const parsed = parseChildRefEnvelope(payload);
      if (parsed.isErr()) {
        malformedEntries += 1;
        pushIssue(issues, {
          kind: "invalid-envelope",
          index,
          issues:
            parsed.error.type === "ChildRefInvalid" ? parsed.error.issues : [],
        });
        continue;
      }
      const envelope = parsed.value;
      const record = envelope.record;
      if (record.originParentSessionId !== this.parentSessionId) {
        if (!mismatched.has(record.childId)) {
          mismatched.add(record.childId);
          pushIssue(issues, {
            kind: "origin-mismatch",
            childId: record.childId,
          });
        }
        continue;
      }
      const previous = latest.get(record.childId);
      if (previous === undefined) {
        latest.set(record.childId, envelope);
        continue;
      }
      const conflict = immutableConflict(previous.record, record);
      if (conflict !== undefined) {
        conflicting.add(record.childId);
        pushIssue(issues, {
          kind: "conflicting-entry",
          childId: record.childId,
          field: conflict,
        });
        continue;
      }
      if (envelope.sequence === previous.sequence) {
        duplicateEntries += 1;
        pushIssue(issues, {
          kind: "duplicate-entry",
          childId: record.childId,
        });
        continue;
      }
      if (envelope.sequence > previous.sequence) {
        latest.set(record.childId, envelope);
      }
    }

    for (const childId of conflicting) latest.delete(childId);
    for (const envelope of latest.values()) {
      const childId = envelope.record.childId;
      const known = this.sequences.get(childId) ?? 0;
      this.sequences.set(childId, Math.max(known, envelope.sequence));
    }

    return ok({
      latest: [...latest.values()],
      issues,
      counts: {
        scannedEntries: entries.length,
        candidateEntries,
        malformedEntries,
        originMismatchedChildren: mismatched.size,
        conflictingChildren: conflicting.size,
        duplicateEntries,
      },
    });
  }

  private applyAuthority(
    scan: PiChildRefEntryScan,
    limit: number | undefined,
  ): ResultAsync<PiChildRefScan, PiChildRefError> {
    const ordered = [...scan.latest]
      .map((envelope) => envelope.record)
      .sort(newestFirst);
    const bounded = ordered.slice(
      0,
      Math.max(
        0,
        Math.min(
          limit ?? PI_CHILD_REF_BOUNDS.maxReturnedRefs,
          PI_CHILD_REF_BOUNDS.maxReturnedRefs,
        ),
      ),
    );
    return ResultAsync.fromSafePromise(
      Promise.all(
        bounded.map((record) =>
          this.authority
            .checkSource(record.sessionRef, record.originParentSessionId)
            .match(
              (state) => ({ record, state }),
              (): {
                readonly record: PiChildRefRecord;
                readonly state: PiChildRefSourceState;
              } => ({ record, state: "unavailable" }),
            ),
        ),
      ),
    ).map((checked) => this.collect(scan, checked));
  }

  private collect(
    scan: PiChildRefEntryScan,
    checked: readonly {
      readonly record: PiChildRefRecord;
      readonly state: PiChildRefSourceState;
    }[],
  ): PiChildRefScan {
    const issues = [...scan.issues];
    const refs: PiChildRefRecord[] = [];
    let unusable = 0;
    for (const { record, state } of checked) {
      if (state === "available") {
        refs.push(record);
        continue;
      }
      unusable += 1;
      pushIssue(issues, {
        kind: "source-unusable",
        childId: record.childId,
        state,
      });
    }
    return {
      refs,
      issues,
      counts: {
        scannedEntries: scan.counts.scannedEntries,
        candidateEntries: scan.counts.candidateEntries,
        malformedEntries: scan.counts.malformedEntries,
        originMismatchedChildren: scan.counts.originMismatchedChildren,
        conflictingChildren: scan.counts.conflictingChildren,
        duplicateEntries: scan.counts.duplicateEntries,
        unusableSourceChildren: unusable,
        usableRefs: refs.length,
      },
    };
  }
}

function pushIssue(issues: PiChildRefIssue[], issue: PiChildRefIssue): void {
  if (issues.length >= PI_CHILD_REF_BOUNDS.maxReportedIssues) return;
  issues.push(issue);
}

function immutableConflict(
  previous: PiChildRefRecord,
  next: PiChildRefRecord,
):
  | "originParentSessionId"
  | "originEntryId"
  | "sessionRef"
  | "nativeSessionId"
  | undefined {
  if (previous.originParentSessionId !== next.originParentSessionId)
    return "originParentSessionId";
  if (previous.originEntryId !== next.originEntryId) return "originEntryId";
  if (previous.sessionRef !== next.sessionRef) return "sessionRef";
  if (previous.nativeSessionId !== next.nativeSessionId)
    return "nativeSessionId";
  return undefined;
}

function newestFirst(a: PiChildRefRecord, b: PiChildRefRecord): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
  if (a.childId < b.childId) return -1;
  if (a.childId > b.childId) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Serialization guard
// ---------------------------------------------------------------------------

/** Field names that would indicate transcript content leaking into a ref. */
export const PI_CHILD_REF_FORBIDDEN_FIELDS: readonly string[] = Object.freeze([
  "prompt",
  "message",
  "messages",
  "content",
  "response",
  "assistant",
  "thinking",
  "reasoningText",
  "toolResult",
  "toolResults",
  "transcript",
  "entries",
  "text",
  "output",
  "task",
]);

/**
 * Serializes one envelope exactly as it is appended, for tests and doctor.
 * Deterministic and metadata-only.
 */
export function serializeChildRefEnvelope(
  envelope: PiChildRefEnvelope,
): string {
  return JSON.stringify(envelope);
}

/** True when a serialized ref carries no transcript-like field name. */
export function hasNoTranscriptFields(serialized: string): boolean {
  const parsed = Result.fromThrowable(
    () => JSON.parse(serialized) as unknown,
    () => undefined,
  )();
  if (parsed.isErr()) return false;
  const stack: unknown[] = [parsed.value];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    for (const [key, child] of Object.entries(value)) {
      if (PI_CHILD_REF_FORBIDDEN_FIELDS.includes(key)) return false;
      stack.push(child);
    }
  }
  return true;
}
