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
import type {
  PiChildMetadataCache,
  PiChildMetadataRecord,
} from "./child-metadata-cache.js";
import {
  nativeSessionDeletionToken,
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
});

export const PI_ADAPTER_COMMAND_NAMES = Object.freeze({
  childrenList: "children.list",
  childrenShow: "children.show",
  childrenResolve: "children.resolve",
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
  })
  .strict();

export type PiChildrenShowResult = z.infer<typeof PiChildrenShowResultSchema>;

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
  }): ResultAsync<
    {
      readonly child: PiAdapterChildListItem;
      readonly entries: readonly PiAdapterChildEntrySummary[];
      readonly nextCursor?: string;
      readonly diagnostics?: PiAdapterChildShowDiagnostics;
    },
    PiAdapterCommandPortError
  >;

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

function summarizeEntry(
  entry: unknown,
  index: number,
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
  return { index, id, type };
}

function summarizePagedEntry(
  entry: PiNativeSessionPagedEntry,
  index: number,
): PiAdapterChildEntrySummary {
  if (entry.kind === "corrupt") {
    return {
      index,
      id: `corrupt-${entry.offset}`,
      type: "corrupt",
    };
  }
  return summarizeEntry(entry.value, index);
}

function pageToShowEntries(page: PiNativeSessionEntryPage): {
  readonly entries: readonly PiAdapterChildEntrySummary[];
  readonly nextCursor?: string;
} {
  return {
    entries: page.entries.map((entry, index) =>
      summarizePagedEntry(entry, index),
    ),
    ...(page.olderCursor === undefined ? {} : { nextCursor: page.olderCursor }),
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
  >;
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
        return loadShow(match, input.cursor, input.diagnostic === true);
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
          loadShow(record, input.cursor, input.diagnostic === true),
        );

      function loadShow(
        record: PiChildMetadataRecord,
        cursor: string | undefined,
        diagnostic: boolean,
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
        return options.sessions
          .readSessionEntryPage(
            record.sessionRef,
            record.originParentSessionId,
            {
              direction: cursor === undefined ? "newest" : "older",
              ...(cursor === undefined ? {} : { cursor }),
              limit: PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize,
            },
          )
          .mapErr(
            (error): PiAdapterCommandPortError => ({
              type: "Unavailable",
              message: error.type,
            }),
          )
          .andThen((page) => {
            const summarized = pageToShowEntries(page);
            const base = {
              child: toListItem(record),
              entries: summarized.entries,
              ...(summarized.nextCursor === undefined
                ? {}
                : { nextCursor: summarized.nextCursor }),
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
      return options.sessions
        .openSession(record.sessionRef, record.originParentSessionId)
        .mapErr(
          (error): PiAdapterCommandPortError => ({
            type: "Unavailable",
            message: error.type,
          }),
        )
        .andThen((session) =>
          options.sessions
            .deleteSession(session, nativeSessionDeletionToken(session.ref))
            .mapErr(
              (error): PiAdapterCommandPortError =>
                error.type === "SessionConfirmationRequired"
                  ? {
                      type: "ConfirmationRequired",
                      message: "delete confirmation token mismatch",
                    }
                  : { type: "Unavailable", message: error.type },
            ),
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

function handlerFromPortResult<T>(
  result: ResultAsync<T, PiAdapterCommandPortError>,
  diagnostic: boolean,
): ResultAsync<string, { readonly message: string }> {
  return result
    .mapErr((error) => ({ message: `${error.type}: ${error.message}` }))
    .map((value) =>
      JSON.stringify(stripPathsUnlessDiagnostic(value, diagnostic)),
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
      false,
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
      })),
      // `children.show` has no path-bearing field in any mode, so path
      // sanitization stays on even under `--diagnostic`.
      false,
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
      false,
    );
  };

  const childrenDelete: AdapterCommandHandler = (payloadJson) => {
    // The required-capability gate runs before the payload is parsed and
    // before the children port is touched: deleting a child tombstones a
    // native session, which is a persistent session mutation.
    const capability = requireSessionMutationCapability(
      options.sessionMutationGate,
    );
    if (capability.isErr())
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
      false,
    );
  };

  const doctorHandler: AdapterCommandHandler = (payloadJson) => {
    const payload = parsePayload(DoctorPayloadSchema, payloadJson);
    if (payload.isErr()) return errAsync(payload.error);
    const diagnostic = payload.value.diagnostic === true;
    return handlerFromPortResult(doctor.run(payload.value), diagnostic);
  };

  return {
    [PI_ADAPTER_COMMAND_NAMES.childrenList]: childrenList,
    [PI_ADAPTER_COMMAND_NAMES.childrenShow]: childrenShow,
    [PI_ADAPTER_COMMAND_NAMES.childrenResolve]: childrenResolve,
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
