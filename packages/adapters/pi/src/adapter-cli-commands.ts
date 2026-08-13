/**
 * Pi-side handlers for the engine adapter-command dispatch boundary
 * (Spec 33 §15.2–15.3, plan Task 14).
 *
 * Handlers are port-injected over Tasks 4–6 (native sessions, refs/cache) and
 * an injectable doctor (Task 15). Payload semantics stay in this module; the
 * engine never sees Pi types.
 */

import {
  type AdapterCommandHandler,
  type AdapterCommandRegistry,
  createAdapterCommandRegistry,
} from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import {
  jsonEscapedCodePointByteLength,
  jsonStringSerializedByteLength,
} from "./child-diagnostic-projection.js";
import type {
  PiChildMetadataCache,
  PiChildMetadataRecord,
} from "./child-metadata-cache.js";
import {
  nativeSessionDeletionToken,
  PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
  PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
  type PiNativeSessionEntryPage,
  type PiNativeSessionPagedEntry,
  type PiNativeSessionStore,
} from "./child-native-sessions.js";
import { enforceDurableChildTitle } from "./child-title.js";
import {
  type PiSessionMutationGate,
  requireSessionMutationCapability,
  SESSION_MUTATION_REQUIRED_CAPABILITY,
} from "./required-capability-gate.js";

// ---------------------------------------------------------------------------
// Bounds and command names
// ---------------------------------------------------------------------------

/** Hard bounds for Pi adapter CLI/extension command surfaces. */
export const PI_ADAPTER_COMMAND_BOUNDS = Object.freeze({
  /** Newest children returned by `children.list` / `/weave:history`. */
  listPageSize: 50,
  /** Newest entries returned by `children.show`. */
  showEntryPageSize: 100,
  /**
   * Max origin-parent matches returned by `children.resolve` for one child id.
   * Prevents unbounded index scans while allowing duplicate-parent detection.
   */
  resolveMatchCap: 16,
  /** Ceiling on opaque payload/result JSON characters. */
  maxJsonCharacters: 256_000,
  /** Ceiling on child/parent identifiers. */
  maxIdLength: 256,
  /** Per-entry sanitized content page before the command result cap. */
  maxEntryContentBytes: 64 * 1_024,
  /**
   * Entries returned by `children.show` when sanitized content is requested.
   * Smaller than `showEntryPageSize` so a page of per-entry projections stays
   * inside the opaque result-JSON ceiling.
   */
  showContentEntryPageSize: 3,
  /** Opaque content cursor ceiling, including its native record cursor. */
  maxContentCursorLength: 1_024,
  /** Exact authoritative result bytes returned by one `children.result` page. */
  maxResultContentBytes: 128 * 1_024,
  /**
   * Ceiling on the base64 text one `children.result` page carries.
   *
   * Base64 is exactly `4 * ceil(n / 3)` ASCII characters for `n` decoded
   * bytes, so 128 KiB of authoritative bytes is always 174,764 characters -
   * a fixed 1.334x expansion that no content can inflate. Raw JSON string
   * escaping has no such bound: 128 KiB of C0 control bytes serializes to
   * 786,432 characters (`\u0000` is six per byte), which is 3.07x past the
   * engine's 256,000-character opaque result envelope.
   */
  maxResultContentBase64Length: 4 * Math.ceil((128 * 1_024) / 3),
  /** Opaque result-group cursor ceiling. */
  maxResultCursorLength: 512,
  /**
   * Per-entry sanitized content ceiling measured *after* JSON escaping.
   *
   * `maxEntryContentBytes` bounds the source text; this bounds what that
   * text costs on the wire. A sanitized projection has no C0 bytes left, but
   * quotes and backslashes still double, so three 64 KiB entries could reach
   * 384,000 characters - past the same 256,000 envelope - without it.
   */
  maxEntryContentSerializedBytes: 64 * 1_024,
});

export const PI_ADAPTER_COMMAND_NAMES = Object.freeze({
  childrenList: "children.list",
  childrenShow: "children.show",
  childrenResolve: "children.resolve",
  childrenResult: "children.result",
  childrenDelete: "children.delete",
  doctor: "doctor",
} as const);

export const PI_ADAPTER_NAME = "pi" as const;

// ---------------------------------------------------------------------------
// Stable JSON contracts
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(PI_ADAPTER_COMMAND_BOUNDS.maxIdLength);

const ChildListItemSchema = z
  .object({
    childId: idSchema,
    threadId: idSchema,
    title: z.string().max(200),
    status: z.string().min(1).max(64),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    originParentSessionId: idSchema,
    tombstoned: z.boolean(),
    stale: z.boolean(),
  })
  .strict();

export type PiAdapterChildListItem = z.infer<typeof ChildListItemSchema>;

const ChildEntrySummarySchema = z
  .object({
    index: z.number().int().nonnegative(),
    id: z.string().min(1).max(PI_ADAPTER_COMMAND_BOUNDS.maxIdLength),
    type: z.string().min(1).max(64),
    /** Present only when `children.show` was requested with content. */
    content: z.string().optional(),
    /**
     * What `content` is. `children.show` only ever returns a sanitized,
     * display-safe projection: control sequences and path-like tokens are
     * rewritten, so it is not the child's bytes. Byte-exact authoritative
     * result data comes from `children.result`, never from this field.
     */
    contentKind: z.literal("sanitized-projection").optional(),
    /** True when this projection page covered the whole sanitized entry text. */
    contentComplete: z.boolean().optional(),
    /** Original UTF-8 byte length when it can be measured exactly. */
    contentByteLength: z.number().int().nonnegative().optional(),
    /** Opaque native-record and byte cursor for the next content page. */
    contentCursor: z
      .string()
      .max(PI_ADAPTER_COMMAND_BOUNDS.maxContentCursorLength)
      .optional(),
  })
  .strict();

export type PiAdapterChildEntrySummary = z.infer<
  typeof ChildEntrySummarySchema
>;

/**
 * Path-free diagnostic facts for one child session. Deliberately carries no
 * filesystem path and no root-relative session ref: the session ref is a
 * storage locator, and Task 11's review found that exposing either leaked
 * Weave-private layout through `children.show --diagnostic`. What remains is
 * identity (the native session id), lineage (the immutable origin-parent link),
 * header verification, and session health.
 */
const ChildShowDiagnosticsSchema = z
  .object({
    /** Native Pi session id from the verified session header. */
    nativeSessionId: idSchema.optional(),
    /** Immutable origin-parent session link. */
    originParentSessionId: idSchema,
    /** Whether the session header was read and verified for this request. */
    sessionHeader: z.enum(["verified", "unread"]),
    /** Health of the persisted session behind this child. */
    sessionHealth: z.enum(["available", "tombstoned"]),
  })
  .strict();

export type PiAdapterChildShowDiagnostics = z.infer<
  typeof ChildShowDiagnosticsSchema
>;

export const PiChildrenListResultSchema = z
  .object({
    kind: z.literal("children.list"),
    workspaceKey: idSchema,
    children: z
      .array(ChildListItemSchema)
      .max(PI_ADAPTER_COMMAND_BOUNDS.listPageSize),
    nextCursor: z.string().max(512).optional(),
  })
  .strict();

export type PiChildrenListResult = z.infer<typeof PiChildrenListResultSchema>;

export const PiChildrenShowResultSchema = z
  .object({
    kind: z.literal("children.show"),
    child: ChildListItemSchema,
    entries: z
      .array(ChildEntrySummarySchema)
      .max(PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize),
    nextCursor: z.string().max(512).optional(),
    /** Path-free session diagnostics — present only when diagnostic is on. */
    diagnostics: ChildShowDiagnosticsSchema.optional(),
    /** True only when the returned history page and content are complete. */
    complete: z.boolean().optional(),
    /** True when content fields were requested for this page. */
    contentIncluded: z.boolean().optional(),
  })
  .strict();

export type PiChildrenShowResult = z.infer<typeof PiChildrenShowResultSchema>;

/**
 * Byte-exact authoritative result page.
 *
 * Nothing on this shape is sanitized, truncated at a code point, or rewritten
 * for display. `content` is the child's own UTF-8 bytes for the returned chunk
 * window, and it is returned only when the whole group verified against its
 * commit record. A sanitized `children.show` projection can never be mistaken
 * for it: the two live on different commands with different field names and
 * an explicit `exact` marker here.
 */
/**
 * The internal, port-level exact page. `content` here is the child's own
 * decoded UTF-8 text. It is never placed on the wire in this form - see
 * {@link PiChildrenResultResultSchema}, which base64-encodes it so escape-heavy
 * authoritative bytes cannot inflate past the engine's result envelope.
 */
export interface PiChildResultPage {
  readonly exact: true;
  readonly status: "complete" | "incomplete";
  readonly reason?: string;
  readonly resultId?: string;
  readonly total?: number;
  readonly byteLength?: number;
  readonly digest?: string;
  readonly content?: string;
  readonly contentByteOffset?: number;
  readonly nextCursor?: string;
}

/** The only encoding `children.result` ever uses for page bytes. */
export const PI_RESULT_CONTENT_ENCODING = "base64" as const;

export const PiChildrenResultResultSchema = z
  .object({
    kind: z.literal("children.result"),
    childId: idSchema,
    /** Always true: this command never returns a projection. */
    exact: z.literal(true),
    status: z.enum(["complete", "incomplete"]),
    /** Why an unverified group could not be returned exactly. */
    reason: z.string().min(1).max(64).optional(),
    resultId: idSchema.optional(),
    /** Total chunks in the verified group. */
    total: z.number().int().nonnegative().optional(),
    /** Total UTF-8 bytes of the complete authoritative result. */
    byteLength: z.number().int().nonnegative().optional(),
    /** SHA-256 of the complete authoritative result. */
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    /**
     * How `content` is encoded. Closed to one literal, and present exactly
     * when `content` is: a reader that does not understand the field can
     * never mistake base64 text for the child's own bytes.
     */
    contentEncoding: z.literal(PI_RESULT_CONTENT_ENCODING).optional(),
    /**
     * Base64 of the exact bytes of this window; absent when the group is
     * incomplete. Byte-preserving and bounded: `4 * ceil(n / 3)` ASCII
     * characters for `n` decoded bytes, whatever those bytes contain.
     */
    content: z
      .string()
      .max(PI_ADAPTER_COMMAND_BOUNDS.maxResultContentBase64Length)
      .optional(),
    /** UTF-8 byte offset of the decoded `content` inside the complete result. */
    contentByteOffset: z.number().int().nonnegative().optional(),
    /** Decoded UTF-8 byte length of this window. */
    contentByteLength: z.number().int().nonnegative().optional(),
    /** SHA-256 of this window's decoded bytes, so a page verifies on its own. */
    contentDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    /** Opaque continuation for the next exact window. */
    nextCursor: z
      .string()
      .max(PI_ADAPTER_COMMAND_BOUNDS.maxResultCursorLength)
      .optional(),
  })
  .strict();

export type PiChildrenResultResult = z.infer<
  typeof PiChildrenResultResultSchema
>;

/**
 * Encodes bytes as base64 without spreading a whole page onto the call stack.
 * Uses only the Web-standard `btoa`, never a Node buffer surface.
 */
export function encodeResultPageBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let start = 0; start < bytes.byteLength; start += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(start, Math.min(start + CHUNK, bytes.byteLength)),
    );
  }
  return btoa(binary);
}

/** Inverse of {@link encodeResultPageBase64}; used by readers to reconstruct bytes. */
export function decodeResultPageBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Projects one internal exact page onto its wire shape.
 *
 * The only transformation is encoding: not one authoritative byte is
 * sanitized, rewritten, or dropped. `contentByteLength` and `contentDigest`
 * describe the *decoded* window, so a reader can verify a page before it ever
 * concatenates it into a result.
 */
export function toResultWirePage(
  childId: string,
  page: PiChildResultPage,
): PiChildrenResultResult {
  const base = {
    kind: "children.result" as const,
    childId,
    exact: true as const,
    status: page.status,
    ...(page.reason === undefined ? {} : { reason: page.reason }),
    ...(page.resultId === undefined ? {} : { resultId: page.resultId }),
    ...(page.total === undefined ? {} : { total: page.total }),
    ...(page.byteLength === undefined ? {} : { byteLength: page.byteLength }),
    ...(page.digest === undefined ? {} : { digest: page.digest }),
    ...(page.contentByteOffset === undefined
      ? {}
      : { contentByteOffset: page.contentByteOffset }),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
  if (page.content === undefined) return base;
  const bytes = new TextEncoder().encode(page.content);
  return {
    ...base,
    contentEncoding: PI_RESULT_CONTENT_ENCODING,
    content: encodeResultPageBase64(bytes),
    contentByteLength: bytes.byteLength,
    contentDigest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  };
}

export const PiChildrenResolveResultSchema = z
  .object({
    kind: z.literal("children.resolve"),
    workspaceKey: idSchema,
    childId: idSchema,
    matches: z
      .array(ChildListItemSchema)
      .max(PI_ADAPTER_COMMAND_BOUNDS.resolveMatchCap),
  })
  .strict();

export type PiChildrenResolveResult = z.infer<
  typeof PiChildrenResolveResultSchema
>;

export const PiChildrenDeleteResultSchema = z
  .object({
    kind: z.literal("children.delete"),
    childId: idSchema,
    tombstoned: z.literal(true),
    deletedAt: z.string().min(1).max(64),
  })
  .strict();

export type PiChildrenDeleteResult = z.infer<
  typeof PiChildrenDeleteResultSchema
>;

export const PiDoctorResultSchema = z
  .object({
    kind: z.literal("doctor"),
    status: z.enum(["ok", "degraded", "unavailable", "not_implemented"]),
    checks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            status: z.enum(["pass", "fail", "skip"]),
            detail: z.string().max(2_048).optional(),
          })
          .strict(),
      )
      .max(200),
    /** Path-bearing diagnostic fields — only when requested. */
    diagnostics: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type PiDoctorResult = z.infer<typeof PiDoctorResultSchema>;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type PiAdapterCommandPortError = {
  readonly type:
    | "InvalidPayload"
    | "NotFound"
    | "ConfirmationRequired"
    | "Unavailable"
    | "Conflict";
  readonly message: string;
};

/** Lifecycle statuses that may be explicitly deleted. */
const DELETABLE_CHILD_STATUSES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
] as const);

type DeletableChildStatus = (typeof DELETABLE_CHILD_STATUSES)[number];

function isDeletableChildStatus(
  status: string,
): status is DeletableChildStatus {
  return (DELETABLE_CHILD_STATUSES as readonly string[]).includes(status);
}

/**
 * Closed, path-free reasons for refusing `children.delete` before any
 * cache/session mutation. Known non-terminal and already-tombstoned
 * statuses keep their literal; anything else stays a closed class so a
 * malformed or attacker-controlled status string cannot leak.
 */
function childDeletionStatusError(record: {
  readonly status?: unknown;
  readonly tombstoned?: unknown;
}): PiAdapterCommandPortError | undefined {
  if (record.tombstoned === true || record.status === "tombstoned") {
    return {
      type: "Conflict",
      message: "child-already-tombstoned",
    };
  }
  if (typeof record.status !== "string" || record.status.length === 0) {
    return {
      type: "Conflict",
      message: "child-status-missing",
    };
  }
  if (record.status === "queued" || record.status === "running") {
    return {
      type: "Conflict",
      message: `child-not-terminal:${record.status}`,
    };
  }
  if (!isDeletableChildStatus(record.status)) {
    return {
      type: "Conflict",
      message: "child-status-unknown",
    };
  }
  return undefined;
}

export interface PiAdapterChildrenPort {
  list(input: {
    readonly workspaceKey: string;
    readonly cursor?: string;
    readonly includeTombstoned?: boolean;
  }): ResultAsync<
    {
      readonly children: readonly PiAdapterChildListItem[];
      readonly nextCursor?: string;
    },
    PiAdapterCommandPortError
  >;

  show(input: {
    readonly workspaceKey: string;
    readonly childId: string;
    readonly parentSessionId?: string;
    readonly cursor?: string;
    readonly diagnostic?: boolean;
    /** Include bounded, sanitized entry content in the response. */
    readonly content?: boolean;
    readonly contentCursor?: string;
  }): ResultAsync<
    {
      readonly child: PiAdapterChildListItem;
      readonly entries: readonly PiAdapterChildEntrySummary[];
      readonly nextCursor?: string;
      readonly diagnostics?: PiAdapterChildShowDiagnostics;
      readonly complete?: boolean;
      readonly contentIncluded?: boolean;
    },
    PiAdapterCommandPortError
  >;

  /**
   * Byte-exact retrieval of one child's durable authoritative result through
   * bounded pages. Never sanitizes and never truncates mid-result: an
   * unverified group returns a typed incomplete status with no content.
   */
  result(input: {
    readonly workspaceKey: string;
    readonly childId: string;
    readonly parentSessionId?: string;
    readonly cursor?: string;
    readonly maxBytes?: number;
  }): ResultAsync<PiChildResultPage, PiAdapterCommandPortError>;

  /**
   * Bounded authoritative lookup by child id over the metadata index/source.
   * Returns immutable origin-parent matches without transcripts or paths.
   */
  resolve(input: {
    readonly workspaceKey: string;
    readonly childId: string;
    readonly includeTombstoned?: boolean;
  }): ResultAsync<
    {
      readonly matches: readonly PiAdapterChildListItem[];
    },
    PiAdapterCommandPortError
  >;

  delete(input: {
    readonly workspaceKey: string;
    readonly childId: string;
    readonly parentSessionId: string;
    readonly confirmed: boolean;
  }): ResultAsync<
    {
      readonly childId: string;
      readonly tombstoned: true;
      readonly deletedAt: string;
    },
    PiAdapterCommandPortError
  >;
}

export interface PiAdapterDoctorPort {
  run(input: {
    readonly diagnostic?: boolean;
  }): ResultAsync<PiDoctorResult, PiAdapterCommandPortError>;
}

/** Default doctor shell for Task 14; Task 15 replaces the check pipeline. */
export function createPlaceholderDoctorPort(): PiAdapterDoctorPort {
  return {
    run(input) {
      const result: PiDoctorResult = {
        kind: "doctor",
        status: "not_implemented",
        checks: [
          {
            id: "doctor.pipeline",
            status: "skip",
            detail: "Doctor checks land in Task 15",
          },
        ],
        ...(input.diagnostic === true
          ? {
              diagnostics: {
                note: "diagnostic mode enabled; path fields reserved for Task 15",
              },
            }
          : {}),
      };
      return okAsync(result);
    },
  };
}

// ---------------------------------------------------------------------------
// Payload schemas (adapter-owned)
// ---------------------------------------------------------------------------

const ListPayloadSchema = z
  .object({
    workspaceKey: idSchema,
    cursor: z.string().max(512).optional(),
    includeTombstoned: z.boolean().optional(),
  })
  .strict();

const ShowPayloadSchema = z
  .object({
    workspaceKey: idSchema,
    childId: idSchema,
    parentSessionId: idSchema.optional(),
    cursor: z.string().max(512).optional(),
    diagnostic: z.boolean().optional(),
    /** Return bounded sanitized native entry content. */
    content: z.boolean().optional(),
    /** Opaque native-record and UTF-8 byte cursor. */
    contentCursor: z
      .string()
      .max(PI_ADAPTER_COMMAND_BOUNDS.maxContentCursorLength)
      .optional(),
  })
  .strict();

const ResultPayloadSchema = z
  .object({
    workspaceKey: idSchema,
    childId: idSchema,
    parentSessionId: idSchema.optional(),
    cursor: z
      .string()
      .max(PI_ADAPTER_COMMAND_BOUNDS.maxResultCursorLength)
      .optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(PI_ADAPTER_COMMAND_BOUNDS.maxResultContentBytes)
      .optional(),
  })
  .strict();

const ResolvePayloadSchema = z
  .object({
    workspaceKey: idSchema,
    childId: idSchema,
    includeTombstoned: z.boolean().optional(),
  })
  .strict();

const DeletePayloadSchema = z
  .object({
    workspaceKey: idSchema,
    childId: idSchema,
    parentSessionId: idSchema,
    confirmed: z.boolean(),
  })
  .strict();

const DoctorPayloadSchema = z
  .object({
    diagnostic: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Path-free sanitization
// ---------------------------------------------------------------------------

const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'])(?:\/|[A-Za-z]:\\|\\\\)/u;

/** True when a string looks like an absolute filesystem path. */
export function looksLikeFilesystemPath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\\\")) return true;
  if (/^[A-Za-z]:[\\/]/u.test(value)) return true;
  return ABSOLUTE_PATH_PATTERN.test(value);
}

/**
 * Drops absolute filesystem paths from a JSON-compatible value unless
 * `diagnostic` is true. Used as a last-line defense for CLI/extension output.
 */
export function stripPathsUnlessDiagnostic<T>(
  value: T,
  diagnostic: boolean,
): T {
  if (diagnostic) return value;
  return stripPaths(value) as T;
}

function stripPaths(value: unknown): unknown {
  if (typeof value === "string") {
    return looksLikeFilesystemPath(value) ? "[path omitted]" : value;
  }
  if (Array.isArray(value)) {
    return value.map(stripPaths);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (
        (key === "sessionPath" || key === "path" || key === "absolutePath") &&
        typeof nested === "string"
      ) {
        continue;
      }
      out[key] = stripPaths(nested);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Record projection
// ---------------------------------------------------------------------------

/**
 * Projects one cache record onto a CLI list item.
 *
 * The CLI checks title provenance for itself (Threat Model T6, Warp blocker 1,
 * Task 21 remediation D) instead of trusting the cache row it was handed, so
 * `children list`, `children show`, and `children find` cannot print a legacy
 * title that carries no provenance marker even if a row reaches them without
 * passing the cache boundary.
 */
function toListItem(record: PiChildMetadataRecord): PiAdapterChildListItem {
  return {
    childId: record.childId,
    threadId: record.threadId,
    title: enforceDurableChildTitle({
      title: record.title,
      threadId: record.threadId,
      ...(record.titleProvenance === undefined
        ? {}
        : { provenance: record.titleProvenance }),
    }),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    originParentSessionId: record.originParentSessionId,
    tombstoned: record.tombstoned,
    stale: record.stale,
  };
}

function stripControlSequences(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      const next = value.charCodeAt(index + 1);
      if (next === 91) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current >= 64 && current <= 126) break;
          index += 1;
        }
        continue;
      }
      if (next === 93) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current === 7) break;
          if (current === 27 && value.charCodeAt(index + 1) === 92) {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      continue;
    }
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      continue;
    }
    output += value[index] ?? "";
  }
  return output;
}
const FILESYSTEM_PATH_TOKEN_PATTERN =
  /(?:\/(?:[^\s<>"']|\\.)+|[A-Za-z]:[\\/](?:[^\s<>"']|\\.)+|\\\\(?:[^\s<>"']|\\.)+)/gu;
const SESSION_REF_TOKEN_PATTERN =
  /[A-Za-z0-9._-]{1,256}\/(?:session|events?)\.jsonl/gu;

interface EntryContentProjectionOptions {
  readonly includeContent: boolean;
  readonly diagnostic: boolean;
  readonly contentEntryCursor?: string;
  readonly contentOffsetBytes?: number;
}

interface TruncatedText {
  readonly text: string;
  readonly complete: boolean;
  readonly byteLength: number;
  readonly nextOffsetBytes?: number;
}

/**
 * Cuts one display page out of `value` under two budgets at once: source
 * UTF-8 bytes, and the UTF-8 bytes the page costs after JSON escaping.
 *
 * The second budget is what keeps a page of sanitized projections inside the
 * engine's opaque result envelope. Sanitization has already removed every C0
 * byte, but quotes and backslashes still cost two bytes each on the wire, so
 * a source-only cut could still double past the envelope. For text with no
 * escapes the two budgets are equal and the cut is identical to the previous
 * source-only behaviour.
 */
function truncateText(
  value: string,
  limit: number,
  offsetBytes = 0,
  serializedLimit: number = PI_ADAPTER_COMMAND_BOUNDS.maxEntryContentSerializedBytes,
): TruncatedText {
  const bytes = new TextEncoder().encode(value);
  const start = Math.min(offsetBytes, bytes.byteLength);
  let end = Math.min(start + limit, bytes.byteLength);
  while (end > start && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  let text = new TextDecoder().decode(bytes.slice(start, end));
  if (jsonStringSerializedByteLength(text) > serializedLimit) {
    let kept = "";
    let keptBytes = 0;
    let serializedUsed = 2;
    for (const codePoint of text) {
      const cost = jsonEscapedCodePointByteLength(codePoint);
      if (serializedUsed + cost > serializedLimit) break;
      serializedUsed += cost;
      keptBytes += new TextEncoder().encode(codePoint).byteLength;
      kept += codePoint;
    }
    text = kept;
    end = start + keptBytes;
  }
  return {
    text,
    complete: end >= bytes.byteLength,
    byteLength: bytes.byteLength,
    ...(end < bytes.byteLength ? { nextOffsetBytes: end } : {}),
  };
}

function sanitizeEntryText(
  value: string,
  diagnostic: boolean,
  offsetBytes = 0,
): TruncatedText {
  let text = stripControlSequences(value);
  if (!diagnostic) {
    text = text.replace(FILESYSTEM_PATH_TOKEN_PATTERN, "[path]");
    text = text.replace(SESSION_REF_TOKEN_PATTERN, "[session ref]");
  }
  return truncateText(
    text,
    PI_ADAPTER_COMMAND_BOUNDS.maxEntryContentBytes,
    offsetBytes,
  );
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function contentText(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return "";
      }
      const part = contentText(descriptor.value, depth + 1);
      if (part.length > 0) parts.push(part);
    }
    return parts.join("\\n");
  }
  if (value !== null && typeof value === "object") {
    for (const key of ["text", "thinking", "content"]) {
      const nested = dataProperty(value, key);
      if (nested === undefined) continue;
      const text = contentText(nested, depth + 1);
      if (text.length > 0) return text;
    }
  }
  return "";
}

function extractEntryContent(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const messageValue = dataProperty(entry, "message");
  const message =
    messageValue !== null && typeof messageValue === "object"
      ? messageValue
      : undefined;
  const customType = dataProperty(entry, "customType");
  const data = dataProperty(entry, "data");
  const resultChunk =
    customType === PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE &&
    data !== null &&
    typeof data === "object"
      ? dataProperty(data, "content")
      : undefined;
  const candidates = [
    resultChunk,
    message === undefined ? undefined : dataProperty(message, "content"),
    dataProperty(entry, "content"),
    dataProperty(entry, "text"),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const text = contentText(candidate);
    // An explicit empty string is still content. This keeps the response
    // shape stable for message entries that contain an empty body.
    if (typeof candidate === "string" || Array.isArray(candidate)) {
      return text;
    }
    if (text.length > 0) return text;
  }
  return undefined;
}

function customEntryType(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const customType = dataProperty(entry, "customType");
  return typeof customType === "string" ? customType : undefined;
}

function summarizeEntry(
  entry: unknown,
  index: number,
  options: EntryContentProjectionOptions = {
    includeContent: false,
    diagnostic: false,
  },
): PiAdapterChildEntrySummary {
  const parsed = z
    .looseObject({
      id: z.string().optional(),
      type: z.string().optional(),
      role: z.string().optional(),
    })
    .safeParse(entry);
  const id =
    parsed.success && parsed.data.id !== undefined && parsed.data.id.length > 0
      ? parsed.data.id
      : `entry-${index}`;
  let type = "unknown";
  if (
    parsed.success &&
    parsed.data.type !== undefined &&
    parsed.data.type.length > 0
  ) {
    type = parsed.data.type;
  } else if (
    parsed.success &&
    parsed.data.role !== undefined &&
    parsed.data.role.length > 0
  ) {
    type = parsed.data.role;
  }
  const customType = customEntryType(entry);
  if (customType === PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE) {
    type = PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE;
  } else if (customType === PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE) {
    type = PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE;
  }
  if (!options.includeContent) return { index, id, type };
  const content = extractEntryContent(entry);
  if (content === undefined) {
    return {
      index,
      id,
      type,
      content: "",
      contentKind: "sanitized-projection",
      contentComplete: true,
      contentByteLength: 0,
    };
  }
  const projection = sanitizeEntryText(
    content,
    options.diagnostic,
    options.contentEntryCursor === undefined ? 0 : options.contentOffsetBytes,
  );
  return {
    index,
    id,
    type,
    content: projection.text,
    contentKind: "sanitized-projection",
    contentComplete: projection.complete,
    contentByteLength: projection.byteLength,
    ...(projection.nextOffsetBytes === undefined ||
    options.contentEntryCursor === undefined
      ? {}
      : {
          contentCursor: encodeContentCursor(
            options.contentEntryCursor,
            projection.nextOffsetBytes,
          ),
        }),
  };
}

function summarizePagedEntry(
  entry: PiNativeSessionPagedEntry,
  index: number,
  options: EntryContentProjectionOptions,
): PiAdapterChildEntrySummary {
  if (entry.kind === "corrupt") {
    return {
      index,
      id: `corrupt-${entry.offset}`,
      type: "corrupt",
      ...(options.includeContent
        ? {
            content: "",
            contentKind: "sanitized-projection" as const,
            contentComplete: false,
          }
        : {}),
    };
  }
  return summarizeEntry(entry.value, index, {
    ...options,
    contentEntryCursor: entry.cursor,
  });
}

const ContentCursorSchema = z
  .object({
    v: z.literal(1),
    entry: z.string().min(1).max(512),
    offset: z.number().int().nonnegative().safe(),
  })
  .strict();

type ParsedContentCursor = z.infer<typeof ContentCursorSchema>;

function encodeContentCursor(entryCursor: string, offset: number): string {
  return btoa(JSON.stringify({ v: 1, entry: entryCursor, offset }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function parseContentCursor(
  cursor: string | undefined,
): Result<ParsedContentCursor | undefined, PiAdapterCommandPortError> {
  if (cursor === undefined) return ok(undefined);
  const decoded = Result.fromThrowable(
    () => {
      const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
      const padLength = (4 - (padded.length % 4)) % 4;
      return JSON.parse(atob(padded + "=".repeat(padLength))) as unknown;
    },
    () => undefined,
  )();
  if (decoded.isErr()) {
    return err({ type: "InvalidPayload", message: "invalid content cursor" });
  }
  const parsed = ContentCursorSchema.safeParse(decoded.value);
  if (!parsed.success) {
    return err({ type: "InvalidPayload", message: "invalid content cursor" });
  }
  return ok(parsed.data);
}

function pageToShowEntries(
  page: PiNativeSessionEntryPage,
  options: EntryContentProjectionOptions,
): {
  readonly entries: readonly PiAdapterChildEntrySummary[];
  readonly nextCursor?: string;
  readonly complete?: boolean;
  readonly contentIncluded?: boolean;
} {
  // Result-group integrity is deliberately not derived here. One bounded
  // history page cannot see a group larger than itself, so judging a group
  // from the current page would mark every multi-page result incomplete.
  // `children.result` proves groups through the store's paged reader instead.
  const projection = options;
  const entries: PiAdapterChildEntrySummary[] = [];
  for (let index = 0; index < page.entries.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      page.entries,
      String(index),
    );
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      continue;
    }
    entries.push(summarizePagedEntry(descriptor.value, index, projection));
  }
  if (!options.includeContent) {
    return {
      entries,
      ...(page.olderCursor === undefined
        ? {}
        : { nextCursor: page.olderCursor }),
    };
  }
  const allContentComplete = entries.every(
    (entry) => entry.contentComplete === true,
  );
  return {
    entries,
    ...(page.olderCursor === undefined ? {} : { nextCursor: page.olderCursor }),
    complete: page.olderCursor === undefined && allContentComplete,
    contentIncluded: true,
  };
}

// ---------------------------------------------------------------------------
// Port adapter over Task 4/5/6 stores
// ---------------------------------------------------------------------------

export interface PiChildrenCommandPortOptions {
  readonly cache: Pick<
    PiChildMetadataCache,
    "list" | "get" | "findByChildId" | "tombstone"
  >;
  readonly sessions: Pick<
    PiNativeSessionStore,
    "openSession" | "readSessionEntryPage" | "deleteSession"
  > &
    Partial<Pick<PiNativeSessionStore, "readResultGroup">>;
  readonly now?: () => Date;
}

/**
 * Wires Tasks 4–6 stores into the children command port used by CLI and
 * extension handlers.
 */
export function createPiChildrenCommandPort(
  options: PiChildrenCommandPortOptions,
): PiAdapterChildrenPort {
  const now = options.now ?? (() => new Date());

  return {
    list(input) {
      const listed = options.cache.list({
        workspaceKey: input.workspaceKey,
        limit: PI_ADAPTER_COMMAND_BOUNDS.listPageSize,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        includeTombstoned: input.includeTombstoned ?? true,
      });
      if (listed.isErr()) {
        return errAsync({
          type: "Unavailable" as const,
          message: listed.error.type,
        });
      }
      return okAsync({
        children: listed.value.records.map(toListItem),
        ...(listed.value.nextCursor === undefined
          ? {}
          : { nextCursor: listed.value.nextCursor }),
      });
    },

    show(input) {
      const parentSessionId = input.parentSessionId;
      if (parentSessionId === undefined) {
        // Cross-session show: authoritative child-id index lookup (bounded).
        const found = options.cache.findByChildId({
          workspaceKey: input.workspaceKey,
          childId: input.childId,
          limit: PI_ADAPTER_COMMAND_BOUNDS.resolveMatchCap,
          includeTombstoned: true,
        });
        if (found.isErr()) {
          return errAsync({
            type: "Unavailable" as const,
            message: found.error.type,
          });
        }
        const match = found.value[0];
        if (match === undefined) {
          return errAsync({
            type: "NotFound" as const,
            message: `child not found: ${input.childId}`,
          });
        }
        return loadShow(
          match,
          input.cursor,
          input.diagnostic === true,
          input.content === true,
          input.contentCursor,
        );
      }

      return options.cache
        .get(
          {
            workspaceKey: input.workspaceKey,
            parentSessionId,
          },
          input.childId,
        )
        .mapErr(
          (error): PiAdapterCommandPortError =>
            error.type === "CacheEntryMissing"
              ? {
                  type: "NotFound",
                  message: `child not found: ${input.childId}`,
                }
              : { type: "Unavailable", message: error.type },
        )
        .andThen((record) =>
          loadShow(
            record,
            input.cursor,
            input.diagnostic === true,
            input.content === true,
            input.contentCursor,
          ),
        );

      function loadShow(
        record: PiChildMetadataRecord,
        cursor: string | undefined,
        diagnostic: boolean,
        includeContent: boolean,
        contentCursor: string | undefined,
      ): ResultAsync<
        {
          readonly child: PiAdapterChildListItem;
          readonly entries: readonly PiAdapterChildEntrySummary[];
          readonly nextCursor?: string;
          readonly diagnostics?: PiAdapterChildShowDiagnostics;
        },
        PiAdapterCommandPortError
      > {
        if (record.tombstoned) {
          return okAsync({
            child: toListItem(record),
            entries: [],
            ...(diagnostic
              ? {
                  diagnostics: {
                    originParentSessionId: record.originParentSessionId,
                    // A tombstoned child's session is never opened, so no
                    // header is read for it.
                    sessionHeader: "unread" as const,
                    sessionHealth: "tombstoned" as const,
                  },
                }
              : {}),
          });
        }
        const parsedContentCursor = parseContentCursor(contentCursor);
        if (parsedContentCursor.isErr()) {
          return errAsync(parsedContentCursor.error);
        }
        const contentPage = parsedContentCursor.value;
        const nativeCursor = contentPage?.entry ?? cursor;
        let direction: "at" | "newest" | "older" = "newest";
        if (contentPage !== undefined) direction = "at";
        else if (cursor !== undefined) direction = "older";
        return options.sessions
          .readSessionEntryPage(
            record.sessionRef,
            record.originParentSessionId,
            {
              direction,
              ...(nativeCursor === undefined ? {} : { cursor: nativeCursor }),
              limit: includeContent
                ? PI_ADAPTER_COMMAND_BOUNDS.showContentEntryPageSize
                : PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize,
            },
          )
          .mapErr((error): PiAdapterCommandPortError => {
            if (error.type === "SessionCorrupt") {
              if (error.reason === "invalid-cursor") {
                return {
                  type: "InvalidPayload",
                  message: "invalid content cursor",
                };
              }
              if (error.reason === "stale-cursor") {
                return {
                  type: "Conflict",
                  message: "stale content cursor",
                };
              }
            }
            return { type: "Unavailable", message: error.type };
          })
          .andThen((page) => {
            const summarized = pageToShowEntries(page, {
              includeContent,
              diagnostic,
              contentEntryCursor: contentPage?.entry,
              contentOffsetBytes: contentPage?.offset,
            });
            const base = {
              child: toListItem(record),
              entries: summarized.entries,
              ...(summarized.nextCursor === undefined
                ? {}
                : { nextCursor: summarized.nextCursor }),
              ...(summarized.complete === undefined
                ? {}
                : { complete: summarized.complete }),
              ...(summarized.contentIncluded === undefined
                ? {}
                : { contentIncluded: summarized.contentIncluded }),
            };
            if (!diagnostic) return okAsync(base);
            return options.sessions
              .openSession(record.sessionRef, record.originParentSessionId)
              .mapErr(
                (error): PiAdapterCommandPortError => ({
                  type: "Unavailable",
                  message: error.type,
                }),
              )
              .map((session) => ({
                ...base,
                diagnostics: {
                  nativeSessionId: session.sessionId,
                  originParentSessionId: record.originParentSessionId,
                  sessionHeader: "verified" as const,
                  sessionHealth: "available" as const,
                },
              }));
          });
      }
    },

    result(input) {
      const readResultGroup = options.sessions.readResultGroup;
      if (readResultGroup === undefined) {
        return errAsync({
          type: "Unavailable" as const,
          message: "result retrieval unavailable",
        });
      }
      const found = options.cache.findByChildId({
        workspaceKey: input.workspaceKey,
        ...(input.parentSessionId === undefined
          ? {}
          : { parentSessionId: input.parentSessionId }),
        childId: input.childId,
        includeTombstoned: false,
        limit: 1,
      });
      if (found.isErr()) {
        return errAsync({
          type: "Unavailable" as const,
          message: found.error.type,
        });
      }
      const record = found.value[0];
      if (record === undefined) {
        return errAsync({
          type: "NotFound" as const,
          message: `child not found: ${input.childId}`,
        });
      }
      if (record.tombstoned) {
        return errAsync({
          type: "NotFound" as const,
          message: `child not found: ${input.childId}`,
        });
      }
      // Reachability through a valid ref is not authority. The exact child,
      // native session, and origin parent this row names are proven against
      // the session itself and against the commit record, so a sibling child
      // of the same parent can never be served this child's result.
      return readResultGroup
        .call(
          options.sessions,
          record.sessionRef,
          {
            childId: record.childId,
            nativeSessionId: record.nativeSessionId,
            parentSession: record.originParentSessionId,
          },
          {
            content: true,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            maxContentBytes: Math.min(
              input.maxBytes ?? PI_ADAPTER_COMMAND_BOUNDS.maxResultContentBytes,
              PI_ADAPTER_COMMAND_BOUNDS.maxResultContentBytes,
            ),
          },
        )
        .mapErr((error): PiAdapterCommandPortError => {
          if (error.type === "SessionCorrupt") {
            if (error.reason === "invalid-cursor") {
              return {
                type: "InvalidPayload",
                message: "invalid result cursor",
              };
            }
            if (error.reason === "stale-cursor") {
              return { type: "Conflict", message: "stale result cursor" };
            }
            if (error.reason === "identity-mismatch") {
              return { type: "Conflict", message: "result identity mismatch" };
            }
          }
          return { type: "Unavailable", message: error.type };
        })
        .map((group) =>
          group.status === "complete"
            ? {
                exact: true as const,
                status: "complete" as const,
                resultId: group.summary.resultId,
                total: group.summary.total,
                byteLength: group.summary.byteLength,
                digest: group.summary.digest,
                ...(group.content === undefined
                  ? {}
                  : { content: group.content }),
                ...(group.contentByteOffset === undefined
                  ? {}
                  : { contentByteOffset: group.contentByteOffset }),
                ...(group.nextCursor === undefined
                  ? {}
                  : { nextCursor: group.nextCursor }),
              }
            : {
                exact: true as const,
                status: "incomplete" as const,
                reason: group.reason,
                ...(group.resultId === undefined
                  ? {}
                  : { resultId: group.resultId }),
              },
        );
    },

    resolve(input) {
      const found = options.cache.findByChildId({
        workspaceKey: input.workspaceKey,
        childId: input.childId,
        limit: PI_ADAPTER_COMMAND_BOUNDS.resolveMatchCap,
        includeTombstoned: input.includeTombstoned ?? true,
      });
      if (found.isErr()) {
        return errAsync({
          type: "Unavailable" as const,
          message: found.error.type,
        });
      }
      return okAsync({
        matches: found.value.map(toListItem),
      });
    },

    delete(input) {
      // Lookup and status validation run before confirmation and before any
      // writable cache/session effect. `get` can mark a row stale or
      // tombstoned when the source is unusable, so delete uses the read-only
      // index lookup instead.
      const found = options.cache.findByChildId({
        workspaceKey: input.workspaceKey,
        parentSessionId: input.parentSessionId,
        childId: input.childId,
        includeTombstoned: true,
        limit: 1,
      });
      if (found.isErr()) {
        return errAsync({
          type: "Unavailable" as const,
          message: found.error.type,
        });
      }
      const record = found.value[0];
      if (record === undefined) {
        return errAsync({
          type: "NotFound" as const,
          message: `child not found: ${input.childId}`,
        });
      }
      const statusError = childDeletionStatusError(record);
      if (statusError !== undefined) {
        return errAsync(statusError);
      }
      if (!input.confirmed) {
        return errAsync({
          type: "ConfirmationRequired" as const,
          message: "delete requires confirmation or --yes",
        });
      }
      // Retry must not depend on the native leaf still being readable. After a
      // durable intent the file may already be gone; the store resumes from the
      // held, already-validated cache ref and the append-only deletion ledger.
      return options.sessions
        .deleteSession(
          {
            childId: record.childId,
            sessionId: record.nativeSessionId,
            ref: record.sessionRef,
            path: record.sessionRef,
            parentSession: record.originParentSessionId,
            cwd: "",
          },
          nativeSessionDeletionToken(record.sessionRef),
        )
        .mapErr(
          (error): PiAdapterCommandPortError =>
            error.type === "SessionConfirmationRequired"
              ? {
                  type: "ConfirmationRequired",
                  message: "delete confirmation token mismatch",
                }
              : { type: "Unavailable", message: error.type },
        )
        .andThen((tombstone) => {
          const marked = options.cache.tombstone(
            {
              workspaceKey: input.workspaceKey,
              parentSessionId: input.parentSessionId,
            },
            input.childId,
          );
          if (marked.isErr()) {
            return errAsync({
              type: "Unavailable" as const,
              message: marked.error.type,
            });
          }
          return okAsync({
            childId: input.childId,
            tombstoned: true as const,
            deletedAt: tombstone.deletedAt ?? now().toISOString(),
          });
        });
    },
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function parsePayload<T>(
  schema: z.ZodType<T>,
  payloadJson: string,
): Result<T, { readonly message: string }> {
  const jsonResult: Result<unknown, { readonly message: string }> =
    Result.fromThrowable(
      () => JSON.parse(payloadJson) as unknown,
      () => ({ message: "payloadJson is not valid JSON" }),
    )();
  if (jsonResult.isErr()) return err(jsonResult.error);
  const parsed = schema.safeParse(jsonResult.value);
  if (!parsed.success) {
    return err({
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    });
  }
  return ok(parsed.data);
}

/**
 * How one command's payload may be rewritten before it is serialized.
 *
 * `sanitize` runs the path-stripping last line of defense. `authoritative`
 * never rewrites a byte, and is used only by `children.result`, whose whole
 * contract is to return the child's exact result. Making the choice explicit
 * keeps a future route from silently sanitizing authoritative bytes, or from
 * silently exposing Weave-private layout in a display projection.
 */
type CommandOutputMode = "sanitize" | "diagnostic" | "authoritative";

function handlerFromPortResult<T>(
  result: ResultAsync<T, PiAdapterCommandPortError>,
  mode: CommandOutputMode,
): ResultAsync<string, { readonly message: string }> {
  return result
    .mapErr((error) => ({ message: `${error.type}: ${error.message}` }))
    .map((value) =>
      mode === "authoritative"
        ? JSON.stringify(value)
        : JSON.stringify(
            stripPathsUnlessDiagnostic(value, mode === "diagnostic"),
          ),
    );
}

export interface CreatePiAdapterCommandHandlersOptions {
  readonly children: PiAdapterChildrenPort;
  readonly doctor?: PiAdapterDoctorPort;
  /**
   * Required-capability gate for the one mutating CLI route
   * (`children.delete`). Omitting it fails that route closed; the read-only
   * list/show/resolve/doctor routes never consult it.
   */
  readonly sessionMutationGate?: PiSessionMutationGate;
}

/** Builds Pi command handlers for the engine registry. */
export function createPiAdapterCommandHandlers(
  options: CreatePiAdapterCommandHandlersOptions,
): Readonly<Record<string, AdapterCommandHandler>> {
  const doctor = options.doctor ?? createPlaceholderDoctorPort();

  const childrenList: AdapterCommandHandler = (payloadJson) => {
    const payload = parsePayload(ListPayloadSchema, payloadJson);
    if (payload.isErr()) return errAsync(payload.error);
    return handlerFromPortResult(
      options.children.list(payload.value).map((page) => ({
        kind: "children.list" as const,
        workspaceKey: payload.value.workspaceKey,
        children: page.children.slice(
          0,
          PI_ADAPTER_COMMAND_BOUNDS.listPageSize,
        ),
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      })),
      "sanitize",
    );
  };

  const childrenShow: AdapterCommandHandler = (payloadJson) => {
    const payload = parsePayload(ShowPayloadSchema, payloadJson);
    if (payload.isErr()) return errAsync(payload.error);
    return handlerFromPortResult(
      options.children.show(payload.value).map((page) => ({
        kind: "children.show" as const,
        child: page.child,
        entries: page.entries.slice(
          0,
          PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize,
        ),
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
        ...(page.diagnostics === undefined
          ? {}
          : { diagnostics: page.diagnostics }),
        ...(page.complete === undefined ? {} : { complete: page.complete }),
        ...(page.contentIncluded === undefined
          ? {}
          : { contentIncluded: page.contentIncluded }),
      })),
      // `children.show` has no path-bearing field in any mode, so path
      // sanitization stays on even under `--diagnostic`.
      "sanitize",
    );
  };

  const childrenResolve: AdapterCommandHandler = (payloadJson) => {
    const payload = parsePayload(ResolvePayloadSchema, payloadJson);
    if (payload.isErr()) return errAsync(payload.error);
    return handlerFromPortResult(
      options.children.resolve(payload.value).map((resolved) => ({
        kind: "children.resolve" as const,
        workspaceKey: payload.value.workspaceKey,
        childId: payload.value.childId,
        matches: resolved.matches.slice(
          0,
          PI_ADAPTER_COMMAND_BOUNDS.resolveMatchCap,
        ),
      })),
      "sanitize",
    );
  };

  const childrenResult: AdapterCommandHandler = (payloadJson) => {
    const payload = parsePayload(ResultPayloadSchema, payloadJson);
    if (payload.isErr()) return errAsync(payload.error);
    return handlerFromPortResult(
      options.children
        .result(payload.value)
        .map((group) => toResultWirePage(payload.value.childId, group)),
      // Authoritative bytes: never rewritten, never path-stripped, only
      // base64-encoded. The child's own result may legitimately contain
      // path-shaped text, C0 bytes, or control sequences.
      "authoritative",
    );
  };

  const childrenDelete: AdapterCommandHandler = (payloadJson) => {
    const mutationReady = requireSessionMutationCapability(
      options.sessionMutationGate,
    );
    if (mutationReady.isErr())
      return errAsync({
        type: "Unavailable" as const,
        message: `required-capability-unavailable:${SESSION_MUTATION_REQUIRED_CAPABILITY}`,
      });
    const payload = parsePayload(DeletePayloadSchema, payloadJson);
    if (payload.isErr()) return errAsync(payload.error);
    return handlerFromPortResult(
      options.children.delete(payload.value).map((deleted) => ({
        kind: "children.delete" as const,
        childId: deleted.childId,
        tombstoned: true as const,
        deletedAt: deleted.deletedAt,
      })),
      "sanitize",
    );
  };

  const doctorHandler: AdapterCommandHandler = (payloadJson) => {
    const payload = parsePayload(DoctorPayloadSchema, payloadJson);
    if (payload.isErr()) return errAsync(payload.error);
    const diagnostic = payload.value.diagnostic === true;
    return handlerFromPortResult(
      doctor.run(payload.value),
      diagnostic ? "diagnostic" : "sanitize",
    );
  };

  return {
    [PI_ADAPTER_COMMAND_NAMES.childrenList]: childrenList,
    [PI_ADAPTER_COMMAND_NAMES.childrenShow]: childrenShow,
    [PI_ADAPTER_COMMAND_NAMES.childrenResolve]: childrenResolve,
    [PI_ADAPTER_COMMAND_NAMES.childrenResult]: childrenResult,
    [PI_ADAPTER_COMMAND_NAMES.childrenDelete]: childrenDelete,
    [PI_ADAPTER_COMMAND_NAMES.doctor]: doctorHandler,
  };
}

/** Registry containing only the Pi adapter command handlers. */
export function createPiAdapterCommandRegistry(
  options: CreatePiAdapterCommandHandlersOptions,
): AdapterCommandRegistry {
  return createAdapterCommandRegistry({
    [PI_ADAPTER_NAME]: createPiAdapterCommandHandlers(options),
  });
}
