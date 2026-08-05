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
  createAdapterCommandRegistry,
  type AdapterCommandRegistry,
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
  PI_CHILD_METADATA_CACHE_BOUNDS,
  type PiChildMetadataCache,
  type PiChildMetadataRecord,
} from "./child-metadata-cache.js";
import {
  nativeSessionDeletionToken,
  type PiNativeSessionStore,
} from "./child-native-sessions.js";

// ---------------------------------------------------------------------------
// Bounds and command names
// ---------------------------------------------------------------------------

/** Hard bounds for Pi adapter CLI/extension command surfaces. */
export const PI_ADAPTER_COMMAND_BOUNDS = Object.freeze({
  /** Newest children returned by `children.list` / `/weave:history`. */
  listPageSize: 50,
  /** Newest entries returned by `children.show`. */
  showEntryPageSize: 100,
  /** Ceiling on opaque payload/result JSON characters. */
  maxJsonCharacters: 256_000,
  /** Ceiling on child/parent identifiers. */
  maxIdLength: 256,
});

export const PI_ADAPTER_COMMAND_NAMES = Object.freeze({
  childrenList: "children.list",
  childrenShow: "children.show",
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

export const PiChildrenListResultSchema = z
  .object({
    kind: z.literal("children.list"),
    workspaceKey: idSchema,
    children: z.array(ChildListItemSchema).max(
      PI_ADAPTER_COMMAND_BOUNDS.listPageSize,
    ),
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
    /** Absolute or root-relative path — present only when diagnostic is on. */
    sessionPath: z.string().max(2_048).optional(),
    sessionRef: z.string().max(1_024).optional(),
  })
  .strict();

export type PiChildrenShowResult = z.infer<typeof PiChildrenShowResultSchema>;

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
      readonly sessionPath?: string;
      readonly sessionRef?: string;
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

function toListItem(record: PiChildMetadataRecord): PiAdapterChildListItem {
  return {
    childId: record.childId,
    threadId: record.threadId,
    title: record.title,
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
  const type =
    parsed.success &&
    parsed.data.type !== undefined &&
    parsed.data.type.length > 0
      ? parsed.data.type
      : parsed.success &&
          parsed.data.role !== undefined &&
          parsed.data.role.length > 0
        ? parsed.data.role
        : "unknown";
  return { index, id, type };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLength));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeEntryCursor(olderThanIndex: number): string {
  return encodeBase64Url(
    textEncoder.encode(JSON.stringify({ v: 1 as const, i: olderThanIndex })),
  );
}

function decodeEntryCursor(cursor: string): number | undefined {
  const parsed = Result.fromThrowable(
    () => JSON.parse(textDecoder.decode(decodeBase64Url(cursor))) as unknown,
    () => undefined as undefined,
  )();
  if (parsed.isErr()) return undefined;
  const shape = z
    .object({ v: z.literal(1), i: z.number().int().nonnegative() })
    .strict()
    .safeParse(parsed.value);
  return shape.success ? shape.data.i : undefined;
}

function summarizeEntries(
  entries: readonly unknown[],
  cursor: string | undefined,
): {
  readonly entries: readonly PiAdapterChildEntrySummary[];
  readonly nextCursor?: string;
} {
  const pageSize = PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize;
  const endExclusive =
    cursor === undefined
      ? entries.length
      : (decodeEntryCursor(cursor) ?? entries.length);
  const end = Math.max(0, Math.min(entries.length, endExclusive));
  const start = Math.max(0, end - pageSize);
  const page = entries.slice(start, end);
  const summaries = page.map((entry, offset) =>
    summarizeEntry(entry, start + offset),
  );
  return {
    entries: summaries,
    ...(start > 0 ? { nextCursor: encodeEntryCursor(start) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Port adapter over Task 4/5/6 stores
// ---------------------------------------------------------------------------

export interface PiChildrenCommandPortOptions {
  readonly cache: Pick<PiChildMetadataCache, "list" | "get" | "tombstone">;
  readonly sessions: Pick<
    PiNativeSessionStore,
    "openSession" | "readSessionEntries" | "deleteSession"
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
        // Cross-session show: list then resolve first matching child id.
        const listed = options.cache.list({
          workspaceKey: input.workspaceKey,
          limit: PI_CHILD_METADATA_CACHE_BOUNDS.maxPageSize,
          includeTombstoned: true,
        });
        if (listed.isErr()) {
          return errAsync({
            type: "Unavailable" as const,
            message: listed.error.type,
          });
        }
        const match = listed.value.records.find(
          (row) => row.childId === input.childId,
        );
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
          readonly sessionPath?: string;
          readonly sessionRef?: string;
        },
        PiAdapterCommandPortError
      > {
        if (record.tombstoned) {
          return okAsync({
            child: toListItem(record),
            entries: [],
            ...(diagnostic ? { sessionRef: record.sessionRef } : {}),
          });
        }
        return options.sessions
          .readSessionEntries(record.sessionRef, record.originParentSessionId)
          .mapErr(
            (error): PiAdapterCommandPortError => ({
              type: "Unavailable",
              message: error.type,
            }),
          )
          .map(({ record: session, entries }) => {
            const page = summarizeEntries(entries, cursor);
            return {
              child: toListItem(record),
              entries: page.entries,
              ...(page.nextCursor === undefined
                ? {}
                : { nextCursor: page.nextCursor }),
              ...(diagnostic
                ? { sessionPath: session.path, sessionRef: record.sessionRef }
                : {}),
            };
          });
      }
    },

    delete(input) {
      if (!input.confirmed) {
        return errAsync({
          type: "ConfirmationRequired" as const,
          message: "delete requires confirmation or --yes",
        });
      }
      return options.cache
        .get(
          {
            workspaceKey: input.workspaceKey,
            parentSessionId: input.parentSessionId,
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
          options.sessions
            .openSession(record.sessionRef, record.originParentSessionId)
            .mapErr(
              (error): PiAdapterCommandPortError => ({
                type: "Unavailable",
                message: error.type,
              }),
            )
            .andThen((session) =>
              options.sessions
                .deleteSession(
                  session,
                  nativeSessionDeletionToken(session.ref),
                )
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
            }),
        );
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
    const diagnostic = payload.value.diagnostic === true;
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
        ...(diagnostic && page.sessionPath !== undefined
          ? { sessionPath: page.sessionPath }
          : {}),
        ...(diagnostic && page.sessionRef !== undefined
          ? { sessionRef: page.sessionRef }
          : {}),
      })),
      diagnostic,
    );
  };

  const childrenDelete: AdapterCommandHandler = (payloadJson) => {
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
