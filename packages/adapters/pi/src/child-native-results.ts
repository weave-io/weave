/**
 * The durable child-result protocol: its wire schemas, its identity rules, its
 * encoded budgets, and the bounded scanner that proves one committed group.
 *
 * A child's authoritative output is never copied into the Runtime Store. It is
 * written into the child's own native session as a group of `result-chunk`
 * custom entries followed by exactly one `result-commit` entry, and it is read
 * back by streaming that group through bounded pages.
 *
 * This module owns that protocol end to end and owns no storage. It never
 * opens a path, never resolves a name, and never holds a descriptor: the
 * session store (`child-native-sessions.ts`) does all of that and hands the
 * scanner one already-authorized {@link PiNativeResultScanSource} bound to a
 * single held no-follow descriptor. The split is what keeps the security
 * argument checkable in one place: everything this module returns is derived
 * from lines that source produced, and every limit it charges is declared
 * here, once.
 *
 * Acceptance is bound to identity, never to reachability. A group is complete
 * only when its commit record names the exact child, native session, origin
 * parent, *and* storage leaf being read, and only when the streamed chunks
 * match that commit's count, order, byte total, and SHA-256 digest.
 */

import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import type {
  PiNativeSessionError,
  PiNativeSessionHandle,
  PiNativeSessionRecord,
} from "./child-native-session-contracts.js";
import {
  PiNativeBoundedNameSchema as BOUNDED_NAME,
  decodeNativeSessionBase64Url,
  encodeNativeSessionBase64Url,
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS,
  PI_NATIVE_SESSION_MAX_RANGE_LENGTH,
} from "./child-native-session-contracts.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Durable, paged full-output chunks. Never copied into Runtime Store. */
export const PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE = "weave.child.result-chunk";
/** Final commit marker for one durable result-chunk group. */
export const PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE = "weave.child.result-commit";
const PI_NATIVE_RESULT_CHUNK_BYTES = 48 * 1_024;
/**
 * Retained aggregate ceiling for one durable authoritative result.
 *
 * This ceiling is deliberately larger than
 * {@link PI_NATIVE_SESSION_MAX_FILE_BYTES}, which bounds one *whole-session*
 * descriptor read. The two are not in conflict because a result group is
 * never validated or retrieved through a whole-session read: it is verified
 * and reconstructed only through {@link PiNativeSessionStore.readResultGroup},
 * which pages the session and holds at most one bounded window in memory.
 */
const PI_NATIVE_RESULT_MAX_BYTES = 64 * 1_024 * 1_024;
const PI_NATIVE_RESULT_ID_SCHEMA = z.string().uuid();
const PI_NATIVE_RESULT_DIGEST_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/);
/**
 * Schema version of one result-chunk or result-commit custom entry.
 *
 * Version 2 makes the commit record carry the immutable storage identity it
 * was authorized against. A version 1 commit is not decodable here, so a
 * result written by an older build is reported as absent rather than accepted
 * on weaker evidence.
 */
export const PI_NATIVE_RESULT_SCHEMA_VERSION = 2;
const NativeCustomEntryShapeSchema = z.looseObject({
  customType: z.string().optional(),
  data: z.unknown(),
});
export const PiNativeResultChunkSchema = z
  .object({
    schemaVersion: z.literal(PI_NATIVE_RESULT_SCHEMA_VERSION),
    resultId: PI_NATIVE_RESULT_ID_SCHEMA,
    index: z.number().int().nonnegative().safe(),
    total: z.number().int().positive().safe(),
    byteLength: z.number().int().nonnegative().max(PI_NATIVE_RESULT_MAX_BYTES),
    digest: PI_NATIVE_RESULT_DIGEST_SCHEMA,
    content: z.string(),
  })
  .strict();

export type PiNativeResultChunk = z.infer<typeof PiNativeResultChunkSchema>;

/**
 * The immutable identity one commit record is bound to.
 *
 * `childId`, `nativeSessionId`, and `parentSession` are the logical identity
 * the writer was authorized for. `leafDev`/`leafIno` are the *storage*
 * identity of the exact file the writer proved it was appending into,
 * observed under the held no-follow directory before the first chunk landed.
 *
 * A reader recomputes both. A commit that reached a different leaf than the
 * one it names is therefore never acceptable, which is what makes acceptance
 * contingent on immutable storage identity rather than on a post-write path
 * comparison the writer alone performs.
 */
export const PiNativeResultCommitIdentitySchema = z
  .object({
    childId: BOUNDED_NAME,
    nativeSessionId: BOUNDED_NAME,
    parentSession: BOUNDED_NAME,
    leafDev: z.number().int().safe(),
    leafIno: z.number().int().nonnegative().safe(),
  })
  .strict();

export type PiNativeResultCommitIdentity = z.infer<
  typeof PiNativeResultCommitIdentitySchema
>;

export const PiNativeResultCommitSchema = z
  .object({
    schemaVersion: z.literal(PI_NATIVE_RESULT_SCHEMA_VERSION),
    resultId: PI_NATIVE_RESULT_ID_SCHEMA,
    total: z.number().int().positive().safe(),
    byteLength: z.number().int().nonnegative().max(PI_NATIVE_RESULT_MAX_BYTES),
    digest: PI_NATIVE_RESULT_DIGEST_SCHEMA,
    identity: PiNativeResultCommitIdentitySchema,
  })
  .strict();

export type PiNativeResultCommit = z.infer<typeof PiNativeResultCommitSchema>;

export type PiNativeResultGroupState =
  | {
      readonly status: "complete";
      readonly resultId: string;
      readonly total: number;
      readonly byteLength: number;
      readonly digest: string;
      readonly chunks: readonly PiNativeResultChunk[];
    }
  | {
      readonly status: "incomplete";
      readonly resultId?: string;
      readonly reason: PiNativeResultGroupIncompleteReason;
    };

/** Why a durable result group is not exactly reconstructable. */
export type PiNativeResultGroupIncompleteReason =
  | "missing-commit"
  | "missing-chunks"
  | "duplicate-index"
  | "out-of-order"
  | "count-mismatch"
  | "byte-mismatch"
  | "digest-mismatch"
  | "metadata-mismatch"
  /**
   * The commit record names a different child, native session, origin parent,
   * or storage leaf than the one being read.
   */
  | "identity-mismatch"
  /** The bounded scan budget ran out before the group could be proven. */
  | "scan-exhausted";

/**
 * Worst-case JSON expansion of one payload byte inside a JSONL string.
 * A C0 control byte such as `U+0001` encodes as the six bytes `\u0001`, and
 * no shorter-input/longer-output case exists, so six is the exact ceiling.
 */
const RESULT_ENTRY_JSON_ESCAPE_FACTOR = 6;
/**
 * Bounded JSONL envelope charged to every result entry line: the `type`,
 * `customType`, `data` keys, the fixed metadata fields, and the newline.
 * Comfortably above the real envelope, which is well under 512 bytes.
 */
const RESULT_ENTRY_ENVELOPE_BYTES = 1_024;
/** Session bytes one pass may traverse outside the group it is proving. */
const RESULT_SCAN_SLACK_BYTES = 32 * 1_024 * 1_024;
/** Session entries one pass may traverse outside the group it is proving. */
const RESULT_SCAN_SLACK_ENTRIES = 8_192;

/** Highest chunk count a group at the retained ceiling can declare. */
const RESULT_GROUP_MAX_CHUNKS = Math.ceil(
  PI_NATIVE_RESULT_MAX_BYTES / PI_NATIVE_RESULT_CHUNK_BYTES,
);

/**
 * Encoded ceiling of one result entry line: a full chunk payload where every
 * byte takes its worst-case JSON escape, plus the bounded envelope. Kept
 * below {@link PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes} so even a
 * fully escaped chunk is still readable inside one page budget.
 */
export const PI_NATIVE_RESULT_MAX_ENCODED_ENTRY_BYTES =
  PI_NATIVE_RESULT_CHUNK_BYTES * RESULT_ENTRY_JSON_ESCAPE_FACTOR +
  RESULT_ENTRY_ENVELOPE_BYTES;

/**
 * Encoded ceiling of one whole result group at the retained aggregate cap:
 * every chunk fully escaped, plus the commit line. This is the number a scan
 * budget must clear, not the 64 MiB decoded cap, because the scan reads the
 * session's *encoded* bytes.
 */
export const PI_NATIVE_RESULT_MAX_ENCODED_GROUP_BYTES =
  (RESULT_GROUP_MAX_CHUNKS + 1) * PI_NATIVE_RESULT_MAX_ENCODED_ENTRY_BYTES;

/** Entries one scan page asks for. */
const RESULT_SCAN_PAGE_SIZE = 100;

/**
 * Whole session region one pass may have to traverse: the encoded group at
 * the retained cap plus the unrelated entries that may sit around it.
 */
const RESULT_SCAN_REGION_BYTES =
  PI_NATIVE_RESULT_MAX_ENCODED_GROUP_BYTES + RESULT_SCAN_SLACK_BYTES;

/** Entries one pass may have to traverse across that same region. */
const RESULT_SCAN_REGION_ENTRIES =
  RESULT_GROUP_MAX_CHUNKS + 1 + RESULT_SCAN_SLACK_ENTRIES;

/**
 * Bytes one page may read without turning them into a returned line, and
 * which the next page therefore reads again.
 *
 * A page stops on its own byte ceiling, its line ceiling, or the caller's
 * entry limit. Stopping mid-line leaves that partial line to be re-read
 * (`maxLineBytes`); stopping on a line count leaves the tail of the range
 * chunk already pulled from the descriptor (`PI_NATIVE_SESSION_MAX_RANGE_LENGTH`).
 * Charging both together covers either stop, in both scan directions.
 */
const RESULT_SCAN_PAGE_REREAD_BYTES =
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes +
  PI_NATIVE_SESSION_MAX_RANGE_LENGTH;

/**
 * Region bytes one page is guaranteed to consume when it stops on its byte
 * ceiling. Positive because a page ceiling is strictly larger than the
 * re-read above, which is what makes the page count below finite.
 */
const RESULT_SCAN_PAGE_PROGRESS_FLOOR_BYTES =
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned -
  RESULT_SCAN_PAGE_REREAD_BYTES;

/**
 * Pages one pass may need over the region above.
 *
 * Every page ends one of three ways: on its byte ceiling, which consumes at
 * least {@link RESULT_SCAN_PAGE_PROGRESS_FLOOR_BYTES}; on its entry limit,
 * which consumes {@link RESULT_SCAN_PAGE_SIZE} entries; or at the end of the
 * scan. Two spare pages cover the partial first and last page.
 */
const RESULT_SCAN_MAX_PAGES_PER_PASS =
  Math.ceil(RESULT_SCAN_REGION_BYTES / RESULT_SCAN_PAGE_PROGRESS_FLOOR_BYTES) +
  Math.ceil(RESULT_SCAN_REGION_ENTRIES / RESULT_SCAN_PAGE_SIZE) +
  2;

/**
 * Bytes one pass may read: every region byte once, plus the bounded re-read
 * each page boundary costs. This is paging I/O, not allocation - a page never
 * holds more than {@link PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned}.
 */
const RESULT_SCAN_MAX_BYTES_PER_PASS =
  RESULT_SCAN_REGION_BYTES +
  RESULT_SCAN_MAX_PAGES_PER_PASS * RESULT_SCAN_PAGE_REREAD_BYTES;

/**
 * Hard bounds for one bounded, paged result-group read. Independent of the
 * session's total size: a scan never allocates the whole result and never
 * reads without a step and byte ceiling.
 *
 * The byte and page ceilings are *per pass*, and each pass starts from a
 * fresh budget. A shared total would have to be divided among the passes,
 * and a group at the retained cap would then exhaust it before the last pass
 * finished.
 *
 * Both ceilings are derived from what paging actually costs, not from the
 * group size alone: a scan pays for the encoded region once *and* for the
 * bounded bytes each page boundary re-reads. Deriving the budget from the
 * region alone under-counts a fully escaped group, whose entry lines are
 * large enough that only a few fit in one page.
 */
export const PI_NATIVE_RESULT_GROUP_BOUNDS = Object.freeze({
  /** Highest chunk count a single group may declare. */
  maxChunks: RESULT_GROUP_MAX_CHUNKS,
  /** Entries requested per scan page. */
  scanPageSize: RESULT_SCAN_PAGE_SIZE,
  /**
   * Passes one bounded read makes over the session: one backward pass that
   * locates the newest commit and its index-0 chunk, and one forward pass
   * that verifies and projects the group.
   */
  scanPasses: 2,
  /** Highest number of entry pages one pass may read. */
  maxScanPagesPerPass: RESULT_SCAN_MAX_PAGES_PER_PASS,
  /** Highest number of session bytes one pass may read. */
  maxScanBytesPerPass: RESULT_SCAN_MAX_BYTES_PER_PASS,
  /** Bytes one page may read but not consume, re-read by the next page. */
  scanPageRereadBytes: RESULT_SCAN_PAGE_REREAD_BYTES,
  /** Region bytes a byte-ceiling page is guaranteed to consume. */
  scanPageProgressFloorBytes: RESULT_SCAN_PAGE_PROGRESS_FLOOR_BYTES,
  /** Highest number of exact UTF-8 bytes one content window returns. */
  maxContentPageBytes: 256 * 1_024,
});

/** Verified identity and size of one durable result group. */
export interface PiNativeResultGroupSummary {
  readonly resultId: string;
  readonly total: number;
  readonly byteLength: number;
  readonly digest: string;
}

/**
 * One bounded read of a durable result group.
 *
 * `status: "complete"` is returned only after the whole group was streamed and
 * its chunk count, order, byte total, and SHA-256 digest all matched the
 * commit record. `content`, when requested, is the exact authoritative UTF-8
 * bytes of the requested chunk window - never a sanitized projection.
 */
export type PiNativeResultGroupRead =
  | {
      readonly status: "complete";
      readonly summary: PiNativeResultGroupSummary;
      /** Exact bytes of the requested window; absent when content was not requested. */
      readonly content?: string;
      /** UTF-8 byte offset of `content` inside the complete result. */
      readonly contentByteOffset?: number;
      /** Opaque continuation for the next exact window. */
      readonly nextCursor?: string;
    }
  | {
      readonly status: "incomplete";
      readonly reason: PiNativeResultGroupIncompleteReason;
      readonly resultId?: string;
    };

/** Options for one bounded {@link PiNativeSessionStore.readResultGroup} call. */
export interface PiNativeResultGroupReadOptions {
  /** Return the exact authoritative bytes of one bounded chunk window. */
  readonly content?: boolean;
  /** Opaque continuation from a prior call's `nextCursor`. */
  readonly cursor?: string;
  /** Ceiling on returned exact bytes; clamped to the module bound. */
  readonly maxContentBytes?: number;
}

/**
 * Opaque exact-content continuation for one result group.
 *
 * A cursor is bound to the child identity it was issued for *and* to the
 * exact commit it was issued against. A cursor from another child, another
 * native session, another origin parent, another result, or a result whose
 * bytes changed can therefore never be resumed against this group: it fails
 * typed instead of silently paging unrelated content.
 */
const ResultGroupCursorSchema = z
  .object({
    v: z.literal(2),
    childId: BOUNDED_NAME,
    nativeSessionId: BOUNDED_NAME,
    parentSession: BOUNDED_NAME,
    resultId: PI_NATIVE_RESULT_ID_SCHEMA,
    digest: PI_NATIVE_RESULT_DIGEST_SCHEMA,
    chunkIndex: z.number().int().nonnegative().safe(),
  })
  .strict();

/** Encodes an opaque exact-content continuation for one result group. */
function encodeResultGroupCursor(
  identity: PiNativeResultIdentity,
  commit: PiNativeResultCommit,
  chunkIndex: number,
): string {
  return encodeNativeSessionBase64Url(
    textEncoder.encode(
      JSON.stringify({
        v: 2,
        childId: identity.childId,
        nativeSessionId: identity.nativeSessionId,
        parentSession: identity.parentSession,
        resultId: commit.resultId,
        digest: commit.digest,
        chunkIndex,
      }),
    ),
  );
}

function decodeResultGroupCursor(
  cursor: string,
  ref: string,
): Result<z.infer<typeof ResultGroupCursorSchema>, PiNativeSessionError> {
  const bytes = decodeNativeSessionBase64Url(cursor);
  if (bytes.isErr()) {
    return err({ type: "SessionCorrupt", ref, reason: "invalid-cursor" });
  }
  const json = Result.fromThrowable(
    () => JSON.parse(textDecoder.decode(bytes.value)) as unknown,
    () => undefined,
  )();
  if (json.isErr()) {
    return err({ type: "SessionCorrupt", ref, reason: "invalid-cursor" });
  }
  const parsed = ResultGroupCursorSchema.safeParse(json.value);
  if (!parsed.success) {
    return err({ type: "SessionCorrupt", ref, reason: "invalid-cursor" });
  }
  return ok(parsed.data);
}

/**
 * Immutable identity a durable result append or read is bound to.
 *
 * Reachability through a valid ref is never enough on either side. A writer
 * must still be writing into exactly this child's session, and a reader must
 * be reading exactly the child's result it asked for, so a sibling child of
 * the same parent can neither receive nor return another child's result.
 */
export interface PiNativeResultIdentity {
  /** Ref-derived child component of the session that owns this result. */
  readonly childId: string;
  /** Native Pi session id captured when the child session was provisioned. */
  readonly nativeSessionId: string;
  /** Immutable origin parent session id. */
  readonly parentSession: string;
}

/** Identity a durable result append must still be writing into. */
export type PiNativeResultAppendIdentity = PiNativeResultIdentity;

/** Identity a durable result read must be proven against. */
export type PiNativeResultReadIdentity = PiNativeResultIdentity;

/** Everything a committed result group must still name to be acceptable. */
export interface PiNativeResultGroupAcceptance {
  readonly identity: PiNativeResultIdentity;
  /** Storage identity of the leaf the entries were actually read from. */
  readonly leaf: PiNativeResultLeafIdentity;
}

/** The storage half of a committed result's identity. */
export interface PiNativeResultLeafIdentity {
  readonly dev: number;
  readonly ino: number;
}
function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function parseNativeCustomEntry(
  entry: unknown,
): { readonly customType: string; readonly data: unknown } | undefined {
  const shape = NativeCustomEntryShapeSchema.safeParse(entry);
  if (!shape.success) return undefined;
  if (typeof shape.data.customType !== "string") return undefined;
  return { customType: shape.data.customType, data: shape.data.data };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Parses one result-chunk custom entry, or `undefined` when it is not one. */
function parseResultChunkEntry(
  entry: unknown,
): PiNativeResultChunk | undefined {
  const custom = parseNativeCustomEntry(entry);
  if (custom?.customType !== PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE)
    return undefined;
  const parsed = PiNativeResultChunkSchema.safeParse(custom.data);
  return parsed.success ? parsed.data : undefined;
}

/** Parses one result-commit custom entry, or `undefined` when it is not one. */
function parseResultCommitEntry(
  entry: unknown,
): PiNativeResultCommit | undefined {
  const custom = parseNativeCustomEntry(entry);
  if (custom?.customType !== PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE)
    return undefined;
  const parsed = PiNativeResultCommitSchema.safeParse(custom.data);
  return parsed.success ? parsed.data : undefined;
}

/** Page/byte budget for exactly one pass of a bounded result-group read. */
interface ResultGroupScanBudget {
  pages: number;
  bytes: number;
}

function exceedsScanBudget(budget: ResultGroupScanBudget): boolean {
  return (
    budget.pages >= PI_NATIVE_RESULT_GROUP_BOUNDS.maxScanPagesPerPass ||
    budget.bytes >= PI_NATIVE_RESULT_GROUP_BOUNDS.maxScanBytesPerPass
  );
}

/** What one backward pass found: the newest commit and its first chunk. */
interface ResultGroupAnchor {
  readonly commit?: PiNativeResultCommit;
  /**
   * Byte offset of the group's index-0 chunk line inside the authorized leaf.
   * A plain offset, not an opaque cursor: the forward pass reads from the
   * same open descriptor, so there is nothing to re-resolve or re-anchor.
   */
  readonly firstChunkOffset?: number;
  readonly reason?: PiNativeResultGroupIncompleteReason;
}

/** Streaming verification state; never holds more than one content window. */
interface ResultGroupStreamState {
  nextIndex: number;
  bytes: number;
  hasher: Bun.CryptoHasher;
  windowParts: string[];
  windowBytes: number;
  windowByteOffset: number;
  nextCursorIndex: number | undefined;
}

/**
 * Proves the reopened session is the exact session the caller provisioned.
 * Reachability through a valid ref under the same parent is not enough: a
 * sibling child of the same parent must never receive this result.
 */
function requireResultAppendIdentity(
  record: PiNativeSessionRecord,
  expected: PiNativeResultIdentity,
  ref: string,
): Result<void, PiNativeSessionError> {
  if (
    record.childId !== expected.childId ||
    record.sessionId !== expected.nativeSessionId ||
    record.parentSession !== expected.parentSession
  ) {
    return err({ type: "SessionCorrupt", ref, reason: "identity-mismatch" });
  }
  return ok(undefined);
}

/** Re-reads the live handle's header and proves it is still the same session. */
function requireLiveSessionIdentity(
  handle: PiNativeSessionHandle,
  expected: PiNativeResultIdentity,
  ref: string,
): ResultAsync<void, PiNativeSessionError> {
  const header = Result.fromThrowable(
    () => handle.getHeader(),
    (): PiNativeSessionError => ({
      type: "SessionCorrupt",
      ref,
      reason: "unreadable",
    }),
  )();
  if (header.isErr()) return errAsync(header.error);
  const value = header.value;
  if (
    value === null ||
    value.id !== expected.nativeSessionId ||
    value.parentSession !== expected.parentSession
  ) {
    return errAsync({
      type: "SessionCorrupt",
      ref,
      reason: "identity-mismatch",
    });
  }
  return okAsync(undefined);
}

/**
 * Reconstructs one committed result group from native custom entries.
 * Partial or corrupt groups stay incomplete; only a matching commit plus
 * exact count, order, bytes, and digest become complete.
 *
 * Acceptance is bound to identity, not to reachability. The caller states the
 * child identity and the storage leaf it is reading, and a commit that names
 * anything else is refused, so a group whose commit landed in a replaced leaf
 * is never complete.
 *
 * This whole-array form is for callers that already hold every entry of a
 * small session. Callers that must prove a group larger than one bounded page
 * use {@link PiNativeSessionStore.readResultGroup} instead.
 */
export function readNativeResultGroup(
  expected: PiNativeResultGroupAcceptance,
  entries: readonly unknown[],
): PiNativeResultGroupState {
  const chunksById = new Map<string, PiNativeResultChunk[]>();
  const commits: PiNativeResultCommit[] = [];
  for (const entry of entries) {
    const custom = parseNativeCustomEntry(entry);
    if (custom === undefined) continue;
    if (custom.customType === PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE) {
      const parsed = PiNativeResultChunkSchema.safeParse(custom.data);
      if (!parsed.success) {
        return { status: "incomplete", reason: "metadata-mismatch" };
      }
      const existing = chunksById.get(parsed.data.resultId) ?? [];
      existing.push(parsed.data);
      chunksById.set(parsed.data.resultId, existing);
      continue;
    }
    if (custom.customType === PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE) {
      const parsed = PiNativeResultCommitSchema.safeParse(custom.data);
      if (!parsed.success) {
        return { status: "incomplete", reason: "metadata-mismatch" };
      }
      commits.push(parsed.data);
    }
  }
  const commit = commits[commits.length - 1];
  if (commit === undefined) {
    return { status: "incomplete", reason: "missing-commit" };
  }
  if (!commitIdentityMatches(commit, expected.identity, expected.leaf)) {
    return {
      status: "incomplete",
      resultId: commit.resultId,
      reason: "identity-mismatch",
    };
  }
  const chunks = chunksById.get(commit.resultId) ?? [];
  if (chunks.length === 0) {
    return {
      status: "incomplete",
      resultId: commit.resultId,
      reason: "missing-chunks",
    };
  }
  const seen = new Set<number>();
  for (const chunk of chunks) {
    if (seen.has(chunk.index)) {
      return {
        status: "incomplete",
        resultId: commit.resultId,
        reason: "duplicate-index",
      };
    }
    seen.add(chunk.index);
  }
  const ordered = [...chunks].sort((left, right) => left.index - right.index);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]?.index !== index) {
      return {
        status: "incomplete",
        resultId: commit.resultId,
        reason: "out-of-order",
      };
    }
  }
  if (ordered.length !== commit.total) {
    return {
      status: "incomplete",
      resultId: commit.resultId,
      reason: "count-mismatch",
    };
  }
  let reconstructedBytes = 0;
  for (const chunk of ordered) {
    if (
      chunk.total !== commit.total ||
      chunk.byteLength !== commit.byteLength ||
      chunk.digest !== commit.digest
    ) {
      return {
        status: "incomplete",
        resultId: commit.resultId,
        reason: "metadata-mismatch",
      };
    }
    reconstructedBytes += utf8ByteLength(chunk.content);
  }
  if (reconstructedBytes !== commit.byteLength) {
    return {
      status: "incomplete",
      resultId: commit.resultId,
      reason: "byte-mismatch",
    };
  }
  const digest = sha256Hex(
    new TextEncoder().encode(ordered.map((chunk) => chunk.content).join("")),
  );
  if (digest !== commit.digest) {
    return {
      status: "incomplete",
      resultId: commit.resultId,
      reason: "digest-mismatch",
    };
  }
  return {
    status: "complete",
    resultId: commit.resultId,
    total: commit.total,
    byteLength: commit.byteLength,
    digest: commit.digest,
    chunks: ordered,
  };
}

function splitResultOutputChunks(
  bytes: Uint8Array,
): Result<readonly string[], PiNativeSessionError> {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.byteLength; ) {
    let end = Math.min(start + PI_NATIVE_RESULT_CHUNK_BYTES, bytes.byteLength);
    while (end > start && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
      end -= 1;
    }
    if (end === start) {
      return err({ type: "SessionCreateFailed", reason: "io" });
    }
    chunks.push(new TextDecoder().decode(bytes.slice(start, end)));
    start = end;
  }
  if (chunks.length === 0) chunks.push("");
  return ok(chunks);
}

/** Identity and size facts shared by every entry of one result group. */
interface ResultGroupWriteMeta {
  readonly resultId: string;
  readonly total: number;
  readonly byteLength: number;
  readonly digest: string;
  /** The exact identity this group's commit is bound to. */
  readonly identity: PiNativeResultCommitIdentity;
}

/**
 * Whether a commit record still names the identity and the exact storage leaf
 * it is being read from. Either half failing means the commit did not reach
 * the file it claims, so nothing in the group is acceptable.
 */
function commitIdentityMatches(
  commit: PiNativeResultCommit,
  expected: PiNativeResultIdentity,
  leaf: PiNativeResultLeafIdentity,
): boolean {
  return (
    commit.identity.childId === expected.childId &&
    commit.identity.nativeSessionId === expected.nativeSessionId &&
    commit.identity.parentSession === expected.parentSession &&
    commit.identity.leafDev === leaf.dev &&
    commit.identity.leafIno === leaf.ino
  );
}

function resultAppendSurface(
  handle: PiNativeSessionHandle,
): Result<
  (type: string, data: Record<string, unknown>) => unknown,
  PiNativeSessionError
> {
  const append = handle.appendCustomEntry?.bind(handle);
  if (append === undefined) {
    return err({ type: "SessionCreateFailed", reason: "host-threw" });
  }
  return ok(append);
}

/**
 * Appends only the chunk entries of one group. Until the matching commit
 * entry lands, no reader accepts these bytes as a result, so an interrupted
 * or refused append leaves no partially accepted output behind.
 */
function appendResultChunkEntries(
  handle: PiNativeSessionHandle,
  chunks: readonly string[],
  meta: ResultGroupWriteMeta,
): ResultAsync<void, PiNativeSessionError> {
  const append = resultAppendSurface(handle);
  if (append.isErr()) return errAsync(append.error);
  const write = append.value;
  return Result.fromThrowable(
    () => {
      for (let index = 0; index < chunks.length; index += 1) {
        write(PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE, {
          schemaVersion: PI_NATIVE_RESULT_SCHEMA_VERSION,
          resultId: meta.resultId,
          index,
          total: meta.total,
          byteLength: meta.byteLength,
          digest: meta.digest,
          content: chunks[index] ?? "",
        });
      }
    },
    (): PiNativeSessionError => ({
      type: "SessionCreateFailed",
      reason: "host-threw",
    }),
  )().asyncAndThen(() => okAsync<void, PiNativeSessionError>(undefined));
}

/** Appends the commit entry that makes an already-written group acceptable. */
function appendResultCommitEntry(
  handle: PiNativeSessionHandle,
  meta: ResultGroupWriteMeta,
): ResultAsync<void, PiNativeSessionError> {
  const append = resultAppendSurface(handle);
  if (append.isErr()) return errAsync(append.error);
  const write = append.value;
  return Result.fromThrowable(
    () =>
      write(PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE, {
        schemaVersion: PI_NATIVE_RESULT_SCHEMA_VERSION,
        resultId: meta.resultId,
        total: meta.total,
        byteLength: meta.byteLength,
        digest: meta.digest,
        identity: meta.identity,
      }),
    (): PiNativeSessionError => ({
      type: "SessionCreateFailed",
      reason: "host-threw",
    }),
  )().asyncAndThen(() => okAsync<void, PiNativeSessionError>(undefined));
}

// ---------------------------------------------------------------------------
// Write plan
// ---------------------------------------------------------------------------

/** Identity and size facts shared by every entry of one result group. */
export type PiNativeResultGroupWriteMeta = ResultGroupWriteMeta;

/**
 * One group's chunking and integrity facts, computed before any storage is
 * touched. A plan is not yet bound to a leaf: the writer binds it with
 * {@link bindResultGroupWriteMeta} once it has observed the exact leaf it is
 * about to append into.
 */
export interface PiNativeResultWritePlan {
  readonly chunks: readonly string[];
  readonly resultId: string;
  readonly total: number;
  readonly byteLength: number;
  readonly digest: string;
}

/**
 * Splits one authoritative output into chunk payloads and computes the group
 * identity and digest. Output above the retained aggregate ceiling is refused
 * here, before any session file is opened.
 */
export function planResultGroupWrite(
  output: string,
): Result<PiNativeResultWritePlan, PiNativeSessionError> {
  const bytes = textEncoder.encode(output);
  if (bytes.byteLength > PI_NATIVE_RESULT_MAX_BYTES) {
    return err({ type: "SessionCreateFailed", reason: "io" });
  }
  return splitResultOutputChunks(bytes).map((chunks) => ({
    chunks,
    resultId: crypto.randomUUID(),
    total: chunks.length,
    byteLength: bytes.byteLength,
    digest: sha256Hex(bytes),
  }));
}

/**
 * Binds a plan to the exact storage leaf the writer proved it was appending
 * into. Every reader recomputes this binding, so a commit that reached some
 * other leaf names a leaf it is not in and is never acceptable.
 */
export function bindResultGroupWriteMeta(
  plan: PiNativeResultWritePlan,
  identity: PiNativeResultIdentity,
  leaf: PiNativeResultLeafIdentity,
): PiNativeResultGroupWriteMeta {
  return {
    resultId: plan.resultId,
    total: plan.total,
    byteLength: plan.byteLength,
    digest: plan.digest,
    identity: {
      childId: identity.childId,
      nativeSessionId: identity.nativeSessionId,
      parentSession: identity.parentSession,
      leafDev: leaf.dev,
      leafIno: leaf.ino,
    },
  };
}

/**
 * Storage checks the append sequence interleaves with its own writes. The
 * result protocol decides *when* each check runs; the session store decides
 * *what* a check proves, because only it holds the directory and the leaf.
 */
export interface PiNativeResultAppendGuards {
  /** Runs after identity is proven and before the first chunk is written. */
  beforeChunks(): ResultAsync<void, PiNativeSessionError>;
  /** Runs after the chunks are on disk and before the commit is written. */
  beforeCommit(): ResultAsync<void, PiNativeSessionError>;
  /** Runs after the commit is written. */
  afterCommit(): ResultAsync<void, PiNativeSessionError>;
}

/**
 * Writes one durable result group and fails closed as early as it can.
 *
 * The order is the security property: prove the reopened session is the
 * authorized one, prove the leaf, write every chunk, prove the same leaf and
 * the same live session, write the commit, prove the leaf once more. Until the
 * commit lands no reader accepts the chunks, so an interrupted or refused
 * append leaves no partially accepted output behind.
 */
export function appendResultGroup(input: {
  readonly handle: PiNativeSessionHandle;
  readonly record: PiNativeSessionRecord;
  readonly expected: PiNativeResultAppendIdentity;
  readonly chunks: readonly string[];
  readonly meta: PiNativeResultGroupWriteMeta;
  readonly guards: PiNativeResultAppendGuards;
  readonly ref: string;
}): ResultAsync<void, PiNativeSessionError> {
  const { handle, expected, guards, meta, ref } = input;
  return requireResultAppendIdentity(input.record, expected, ref)
    .asyncAndThen(() => guards.beforeChunks())
    .andThen(() => appendResultChunkEntries(handle, input.chunks, meta))
    .andThen(() => guards.beforeCommit())
    .andThen(() => requireLiveSessionIdentity(handle, expected, ref))
    .andThen(() => appendResultCommitEntry(handle, meta))
    .andThen(() => guards.afterCommit());
}

// ---------------------------------------------------------------------------
// Bounded scan
// ---------------------------------------------------------------------------

/** Decoded continuation payload for one exact-content read. */
export type PiNativeResultGroupCursor = z.infer<typeof ResultGroupCursorSchema>;

/** What one bounded read intends to do, once its options are validated. */
export interface PiNativeResultGroupReadPlan {
  /** Validated continuation, absent on a first page. */
  readonly cursor?: PiNativeResultGroupCursor;
  /** Exact-content window request, absent when only a summary was asked for. */
  readonly content?: {
    readonly startChunkIndex: number;
    readonly maxContentBytes: number;
  };
}

/**
 * Validates one read's options against the identity it claims.
 *
 * A cursor issued for another child, native session, or origin parent is not
 * a stale continuation of this group; it is a different subject entirely, and
 * it fails typed rather than paging unrelated content.
 */
export function prepareResultGroupRead(
  options: PiNativeResultGroupReadOptions,
  expected: PiNativeResultReadIdentity,
  ref: string,
): Result<PiNativeResultGroupReadPlan, PiNativeSessionError> {
  let cursor: PiNativeResultGroupCursor | undefined;
  if (options.cursor !== undefined) {
    const decoded = decodeResultGroupCursor(options.cursor, ref);
    if (decoded.isErr()) return err(decoded.error);
    if (
      decoded.value.childId !== expected.childId ||
      decoded.value.nativeSessionId !== expected.nativeSessionId ||
      decoded.value.parentSession !== expected.parentSession
    ) {
      return err({ type: "SessionCorrupt", ref, reason: "identity-mismatch" });
    }
    cursor = decoded.value;
  }
  if (options.content !== true) {
    return ok(cursor === undefined ? {} : { cursor });
  }
  const maxContentBytes = Math.max(
    0,
    Math.min(
      options.maxContentBytes ??
        PI_NATIVE_RESULT_GROUP_BOUNDS.maxContentPageBytes,
      PI_NATIVE_RESULT_GROUP_BOUNDS.maxContentPageBytes,
    ),
  );
  const content = {
    startChunkIndex: cursor?.chunkIndex ?? 0,
    maxContentBytes,
  };
  return ok(cursor === undefined ? { content } : { cursor, content });
}

/** One JSONL line the scan traversed, with its decoded body when it has one. */
export interface PiNativeResultScanLine {
  /** Absolute byte offset of the line's first byte. */
  readonly offset: number;
  /** Absolute byte offset one past the line's last byte, before its newline. */
  readonly endOffset: number;
  /** Decoded body object, absent when the line is a header or is corrupt. */
  readonly entry?: unknown;
}

/** One bounded scan page plus the bytes the storage layer actually read. */
export interface PiNativeResultScanPage {
  /** Ascending for forward reads, newest-first for backward reads. */
  readonly lines: readonly PiNativeResultScanLine[];
  readonly bytesRead: number;
}

/**
 * The narrow storage surface a bounded result scan runs on.
 *
 * A source is already authorized: the store resolved the name once through a
 * held no-follow directory, opened one descriptor, and proved the header's
 * identity before constructing it. The scanner therefore never resolves,
 * reopens, or re-anchors anything - it only walks lines the source produces,
 * which is what makes "every returned byte came from one proven leaf" a
 * property of the type rather than of the call sites.
 */
export interface PiNativeResultScanSource {
  /** Verified ref, used only for typed failures. */
  readonly ref: string;
  /** Size of the authorized descriptor; the scan never reads past it. */
  readonly size: number;
  /** First body byte offset; the backward walk never goes below it. */
  readonly headerEnd: number;
  /** Storage identity the commit record must name. */
  readonly leaf: PiNativeResultLeafIdentity;
  /** Reads up to `limit` whole lines ending strictly before `endExclusive`. */
  readBackward(
    endExclusive: number,
    limit: number,
  ): ResultAsync<PiNativeResultScanPage, PiNativeSessionError>;
  /** Reads up to `limit` whole lines starting at `offset`. */
  readForward(
    offset: number,
    limit: number,
  ): ResultAsync<PiNativeResultScanPage, PiNativeSessionError>;
}

/**
 * One backward pass that finds the newest result commit and the byte offset
 * of its group's index-0 chunk.
 *
 * Merging the two lookups matters: the commit and its first chunk live in
 * the same trailing region, so two separate backward walks would read that
 * region twice and charge a scan budget twice for one fact.
 *
 * Each page resumes at the offset of the oldest line the previous page
 * returned, which is strictly smaller, so the walk terminates. No line is
 * read to establish where the next page starts.
 */
function findResultGroupAnchor(
  source: PiNativeResultScanSource,
): ResultAsync<ResultGroupAnchor, PiNativeSessionError> {
  const budget: ResultGroupScanBudget = { pages: 0, bytes: 0 };
  const ended = (
    commit: PiNativeResultCommit | undefined,
    reason: PiNativeResultGroupIncompleteReason,
  ): ResultGroupAnchor =>
    commit === undefined ? { reason } : { commit, reason };

  const step = (
    endExclusive: number,
    found: PiNativeResultCommit | undefined,
  ): ResultAsync<ResultGroupAnchor, PiNativeSessionError> => {
    if (endExclusive <= source.headerEnd) {
      return okAsync(
        ended(found, found === undefined ? "missing-commit" : "missing-chunks"),
      );
    }
    if (exceedsScanBudget(budget)) {
      return okAsync(ended(found, "scan-exhausted"));
    }
    budget.pages += 1;
    return source
      .readBackward(endExclusive, PI_NATIVE_RESULT_GROUP_BOUNDS.scanPageSize)
      .andThen((page) => {
        budget.bytes += page.bytesRead;
        let commit = found;
        let oldestOffset: number | undefined;
        for (const line of page.lines) {
          oldestOffset = line.offset;
          if (line.entry === undefined) continue;
          if (commit === undefined) {
            const seen = parseResultCommitEntry(line.entry);
            if (seen !== undefined) commit = seen;
            // A commit never precedes its own chunks, so the same record can
            // not also be this group's index-0 chunk.
            continue;
          }
          const chunk = parseResultChunkEntry(line.entry);
          if (chunk === undefined) continue;
          if (chunk.resultId !== commit.resultId || chunk.index !== 0) continue;
          return okAsync<ResultGroupAnchor, PiNativeSessionError>({
            commit,
            firstChunkOffset: line.offset,
          });
        }
        if (oldestOffset === undefined) {
          // The page budget closed before a whole line could be read, so the
          // walk cannot advance. Report exhaustion rather than looping.
          return okAsync(ended(commit, "scan-exhausted"));
        }
        return step(oldestOffset, commit);
      });
  };
  return step(source.size, undefined);
}

/**
 * Forward pass from the group's first chunk. Verifies strict ascending
 * indexes, per-chunk metadata agreement, the exact byte total, and the
 * SHA-256 digest, holding at most one page plus the requested exact window.
 *
 * Paging is sequential on the authorized source: each page starts at the byte
 * immediately after the last line the previous page consumed. No page re-reads
 * a cursor anchor line to find its start, so a group costs its own bytes once
 * plus the bounded partial line each page boundary re-reads.
 */
function streamResultGroup(
  source: PiNativeResultScanSource,
  expected: PiNativeResultReadIdentity,
  commit: PiNativeResultCommit,
  firstChunkOffset: number,
  content: PiNativeResultGroupReadPlan["content"],
): ResultAsync<PiNativeResultGroupRead, PiNativeSessionError> {
  const budget: ResultGroupScanBudget = { pages: 0, bytes: 0 };
  const state: ResultGroupStreamState = {
    nextIndex: 0,
    bytes: 0,
    hasher: new Bun.CryptoHasher("sha256"),
    windowParts: [],
    windowBytes: 0,
    windowByteOffset: 0,
    nextCursorIndex: undefined,
  };
  const incomplete = (
    reason: PiNativeResultGroupIncompleteReason,
  ): PiNativeResultGroupRead => ({
    status: "incomplete",
    resultId: commit.resultId,
    reason,
  });

  const consume = (
    value: unknown,
  ): "continue" | "done" | PiNativeResultGroupIncompleteReason => {
    const chunk = parseResultChunkEntry(value);
    if (chunk !== undefined && chunk.resultId === commit.resultId) {
      if (state.nextIndex >= commit.total) return "duplicate-index";
      if (chunk.index !== state.nextIndex) {
        return chunk.index < state.nextIndex
          ? "duplicate-index"
          : "out-of-order";
      }
      if (
        chunk.total !== commit.total ||
        chunk.byteLength !== commit.byteLength ||
        chunk.digest !== commit.digest
      ) {
        return "metadata-mismatch";
      }
      const chunkBytes = textEncoder.encode(chunk.content);
      state.bytes += chunkBytes.byteLength;
      if (state.bytes > commit.byteLength) return "byte-mismatch";
      state.hasher.update(chunkBytes);
      if (content !== undefined) {
        if (chunk.index < content.startChunkIndex) {
          state.windowByteOffset += chunkBytes.byteLength;
        } else if (
          state.nextCursorIndex === undefined &&
          (state.windowBytes === 0 ||
            state.windowBytes + chunkBytes.byteLength <=
              content.maxContentBytes)
        ) {
          state.windowParts.push(chunk.content);
          state.windowBytes += chunkBytes.byteLength;
        } else if (state.nextCursorIndex === undefined) {
          state.nextCursorIndex = chunk.index;
        }
      }
      state.nextIndex += 1;
      return "continue";
    }
    const seen = parseResultCommitEntry(value);
    if (seen !== undefined && seen.resultId === commit.resultId) {
      if (
        seen.total !== commit.total ||
        seen.byteLength !== commit.byteLength ||
        seen.digest !== commit.digest
      ) {
        return "metadata-mismatch";
      }
      return "done";
    }
    return "continue";
  };

  const finish = (): PiNativeResultGroupRead => {
    if (state.nextIndex !== commit.total) return incomplete("count-mismatch");
    if (state.bytes !== commit.byteLength) return incomplete("byte-mismatch");
    if (state.hasher.digest("hex") !== commit.digest) {
      return incomplete("digest-mismatch");
    }
    const summary: PiNativeResultGroupSummary = {
      resultId: commit.resultId,
      total: commit.total,
      byteLength: commit.byteLength,
      digest: commit.digest,
    };
    if (content === undefined) return { status: "complete", summary };
    if (content.startChunkIndex >= commit.total && commit.total > 0) {
      return incomplete("out-of-order");
    }
    return {
      status: "complete",
      summary,
      content: state.windowParts.join(""),
      contentByteOffset: state.windowByteOffset,
      ...(state.nextCursorIndex === undefined
        ? {}
        : {
            nextCursor: encodeResultGroupCursor(
              expected,
              commit,
              state.nextCursorIndex,
            ),
          }),
    };
  };

  const step = (
    offset: number,
  ): ResultAsync<PiNativeResultGroupRead, PiNativeSessionError> => {
    if (offset >= source.size) return okAsync(incomplete("missing-commit"));
    if (exceedsScanBudget(budget)) {
      return okAsync(incomplete("scan-exhausted"));
    }
    budget.pages += 1;
    return source
      .readForward(offset, PI_NATIVE_RESULT_GROUP_BOUNDS.scanPageSize)
      .andThen((page) => {
        budget.bytes += page.bytesRead;
        let next = offset;
        for (const line of page.lines) {
          next = line.endOffset + (line.endOffset < source.size ? 1 : 0);
          if (line.entry === undefined) continue;
          const outcome = consume(line.entry);
          if (outcome === "done") return okAsync(finish());
          if (outcome !== "continue") return okAsync(incomplete(outcome));
        }
        // A page that consumed nothing cannot advance the scan.
        if (next <= offset) return okAsync(incomplete("missing-commit"));
        return step(next);
      });
  };

  return step(firstChunkOffset);
}

/**
 * Proves one durable result group over an authorized, already-identity-checked
 * source, in exactly {@link PI_NATIVE_RESULT_GROUP_BOUNDS.scanPasses} passes.
 *
 * Each pass starts from a fresh page/byte budget. A shared total would have to
 * be divided among the passes, and a group at the retained cap would then
 * exhaust it before the last pass finished.
 *
 * Nothing is allocated whole: the group is streamed in ascending chunk order,
 * hashed incrementally, and only the optionally requested exact content window
 * is retained.
 */
export function scanResultGroup(
  source: PiNativeResultScanSource,
  expected: PiNativeResultReadIdentity,
  plan: PiNativeResultGroupReadPlan,
): ResultAsync<PiNativeResultGroupRead, PiNativeSessionError> {
  return findResultGroupAnchor(source).andThen((locatedGroup) => {
    if (locatedGroup.commit === undefined) {
      return okAsync<PiNativeResultGroupRead, PiNativeSessionError>({
        status: "incomplete",
        reason: locatedGroup.reason ?? "missing-commit",
      });
    }
    const commit = locatedGroup.commit;
    if (!commitIdentityMatches(commit, expected, source.leaf)) {
      return okAsync<PiNativeResultGroupRead, PiNativeSessionError>({
        status: "incomplete",
        resultId: commit.resultId,
        reason: "identity-mismatch",
      });
    }
    if (
      plan.cursor !== undefined &&
      (plan.cursor.resultId !== commit.resultId ||
        plan.cursor.digest !== commit.digest)
    ) {
      return errAsync<PiNativeResultGroupRead, PiNativeSessionError>({
        type: "SessionCorrupt",
        ref: source.ref,
        reason: "stale-cursor",
      });
    }
    if (commit.total > PI_NATIVE_RESULT_GROUP_BOUNDS.maxChunks) {
      return okAsync<PiNativeResultGroupRead, PiNativeSessionError>({
        status: "incomplete",
        resultId: commit.resultId,
        reason: "count-mismatch",
      });
    }
    if (locatedGroup.firstChunkOffset === undefined) {
      return okAsync<PiNativeResultGroupRead, PiNativeSessionError>({
        status: "incomplete",
        resultId: commit.resultId,
        reason: locatedGroup.reason ?? "missing-chunks",
      });
    }
    return streamResultGroup(
      source,
      expected,
      commit,
      locatedGroup.firstChunkOffset,
      plan.content,
    );
  });
}

/**
 * Page/byte budget for one bounded pass. Exported because the session store
 * charges the same ceilings for its own bounded metadata scans, and the two
 * must not drift apart.
 */
export type PiNativeResultScanBudget = ResultGroupScanBudget;

export { exceedsScanBudget as exceedsResultScanBudget };
