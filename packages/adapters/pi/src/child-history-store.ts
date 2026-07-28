import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  appendUnseenCheckpointEntries,
  decodePiChildSessionCheckpoint,
  encodePiChildSessionCheckpoint,
  createEmptyPiChildSessionCheckpoint,
  type PiChildSessionCheckpoint,
  type PiChildSessionCheckpointEntry,
} from "./child-session-checkpoint.js";
import {
  MAX_FINAL_OUTPUT_BYTES,
  PI_CHILD_HISTORY_LAYOUT,
  PI_CHILD_HISTORY_SCHEMA_VERSION,
  parsePiChildHistoryIndex,
  type PiChildHistoryIndexV1,
  type PiChildHistoryRecord,
  type PiChildHistoryStatus,
} from "./child-history-schema.js";
import { parsePiChildSessionEvent, type PiChildSessionEvent } from "./child-session-events.js";
import {
  safeChildHistoryComponent,
  resolvePiChildHistoryRoot,
  type PiChildHistoryDirectory,
  type PiChildHistoryFsError,
  type PiChildHistoryFsPort,
  type HistoryIdentity,
  MemoryPiChildHistoryFs,
  BunPiChildHistoryFs,
} from "./child-history-fs.js";
import type { PiChildInspectionEffectiveSettings, PiChildInspectionSettings } from "./child-inspection-settings.js";

const INDEX_TEMP = "index.v1.json.tmp";
const MAX_INDEX_BYTES = 1_048_576;
const MAX_JSONL_LINE_BYTES = 1_048_576;
const terminal = new Set<PiChildHistoryStatus>(["settled", "interrupted", "quarantined", "cleared"]);

type StoreAction = "open" | "read" | "write" | "append" | "checkpoint" | "clear" | "quarantine" | "quota" | "prune";
type HistorySettings = Pick<PiChildInspectionSettings, "persist_history" | "max_bytes_per_child" | "max_bytes_total" | "orphan_retention_days">;
type PersistedBytes = { readonly session: number; readonly checkpoint: number; readonly total: number };

function historySettings(value: PiChildInspectionEffectiveSettings | HistorySettings): HistorySettings {
  return "settings" in value ? value.settings : value;
}

function isFsError(value: unknown): value is PiChildHistoryFsError {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string" && ["unavailable", "unsafe-path", "identity-changed", "symlink-rejected", "permissive-mode", "wrong-kind", "missing", "io"].includes((value as { type: string }).type);
}

function asStoreError(value: PiChildHistoryFsError | PiChildHistoryStoreError, action: StoreAction): PiChildHistoryStoreError {
  return isFsError(value) ? mapFs(value, action) : value;
}

function toAsync<T, E>(value: Result<T, E>): ResultAsync<T, E> {
  return ResultAsync.fromPromise(Promise.resolve(value), () => undefined as E).andThen((result) => result);
}

export type PiChildHistoryStoreError =
  | { readonly type: "history-fs"; readonly action: StoreAction; readonly cause: PiChildHistoryFsError }
  | { readonly type: "history-json"; readonly action: "index" | "session"; readonly reason: "malformed" | "oversized" }
  | { readonly type: "history-schema"; readonly reason: "invalid" | "unsupported-version" }
  | { readonly type: "history-quarantined"; readonly reason: "index" | "session" | "checkpoint" }
  | { readonly type: "clear-refused"; readonly status: "running" | "queued" | "missing" }
  | { readonly type: "child-not-found" }
  | { readonly type: "quota-exceeded"; readonly scope: "child" | "total" }
  | { readonly type: "history-disabled" };

export interface PiChildHistoryStoreOptions {
  readonly fs?: PiChildHistoryFsPort;
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** Current parent session. Used to distinguish orphan records. */
  readonly activeParentSessionId?: string;
  readonly activeChildId?: string;
  readonly inspectedChildId?: string;
}

export interface PiChildHistoryOpenOptions extends PiChildHistoryStoreOptions {}

function safeJson(value: unknown, action: "index" | "session"): Result<Uint8Array, PiChildHistoryStoreError> {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(value),
    () => ({ type: "history-json", action, reason: "malformed" } as const),
  )();
  if (serialized.isErr() || serialized.value === undefined) return err(serialized.isErr() ? serialized.error : { type: "history-json", action, reason: "malformed" });
  const bytes = new TextEncoder().encode(serialized.value);
  if (bytes.byteLength > (action === "index" ? MAX_INDEX_BYTES : MAX_JSONL_LINE_BYTES)) {
    return err({ type: "history-json", action, reason: "oversized" });
  }
  return ok(bytes);
}

function decodeJson(bytes: Uint8Array): Result<unknown, PiChildHistoryStoreError> {
  const decoded = Result.fromThrowable(
    () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    () => ({ type: "history-json", action: "index", reason: "malformed" } as const),
  )();
  return decoded.isErr() ? err(decoded.error) : ok(decoded.value);
}

function mapFs(cause: PiChildHistoryFsError, action: StoreAction): PiChildHistoryStoreError {
  return { type: "history-fs", action, cause };
}

function boundedFinalOutput(value: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(value).slice(0, MAX_FINAL_OUTPUT_BYTES));
}

function canonicalChildPath(childId: string): string {
  const safe = safeChildHistoryComponent(childId).unwrapOr("child-invalid");
  return `${PI_CHILD_HISTORY_LAYOUT.childDirectory}/${safe}/${PI_CHILD_HISTORY_LAYOUT.sessionFile}`;
}

function canonicalRecord(record: PiChildHistoryRecord, parentSessionId: string, now: number): PiChildHistoryRecord {
  return {
    ...record,
    parentSessionId,
    sessionPath: canonicalChildPath(record.childId),
    finalOutput: boundedFinalOutput(record.finalOutput),
    updatedAt: now,
    bytes: {
      session: Math.max(0, record.bytes.session),
      checkpoint: Math.max(0, record.bytes.checkpoint),
      total: Math.max(0, record.bytes.session) + Math.max(0, record.bytes.checkpoint),
    },
  };
}

function emptyIndex(parentSessionId: string, now: number): PiChildHistoryIndexV1 {
  return { schemaVersion: PI_CHILD_HISTORY_SCHEMA_VERSION, parentSessionId, records: [], updatedAt: now };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function migrateV0(value: unknown, parentSessionId: string, now: number): Result<PiChildHistoryIndexV1, PiChildHistoryStoreError> {
  if (!isRecord(value)) return err({ type: "history-schema", reason: "invalid" });
  const source = Array.isArray(value.records) ? value.records : [];
  const records: PiChildHistoryRecord[] = [];
  for (const raw of source) {
    if (!isRecord(raw) || typeof raw.childId !== "string" || raw.childId.length === 0) {
      return err({ type: "history-schema", reason: "invalid" });
    }
    const status: PiChildHistoryStatus = raw.status === "running" || raw.status === "queued" || raw.status === "interrupted" || raw.status === "quarantined" || raw.status === "cleared" ? raw.status : "settled";
    const kind = raw.kind === "nested" || raw.kind === "workflow-step" ? raw.kind : "ordinary";
    const createdAt = typeof raw.createdAt === "number" && Number.isSafeInteger(raw.createdAt) && raw.createdAt >= 0 ? raw.createdAt : now;
    const finalOutput = typeof raw.finalOutput === "string" ? raw.finalOutput : "";
    const migrated: PiChildHistoryRecord = {
      childId: raw.childId,
      parentSessionId,
      parentChildId: typeof raw.parentChildId === "string" ? raw.parentChildId : undefined,
      kind,
      status,
      workflow: isRecord(raw.workflow) ? {
        ...(typeof raw.workflow.workflow === "string" ? { workflow: raw.workflow.workflow } : {}),
        ...(typeof raw.workflow.step === "string" ? { step: raw.workflow.step } : {}),
      } : {},
      sessionPath: canonicalChildPath(raw.childId),
      activeLeaf: typeof raw.activeLeaf === "string" ? raw.activeLeaf : undefined,
      checkpointCursor: typeof raw.checkpointCursor === "number" && raw.checkpointCursor >= 0 ? Math.floor(raw.checkpointCursor) : 0,
      branchAncestry: Array.isArray(raw.branchAncestry) ? raw.branchAncestry.filter(isRecord).flatMap((branch) => typeof branch.childId === "string" && typeof branch.checkpoint === "number" ? [{ childId: branch.childId, ...(typeof branch.parentChildId === "string" ? { parentChildId: branch.parentChildId } : {}), checkpoint: Math.max(0, Math.floor(branch.checkpoint)) }] : []) : [],
      interventionCount: typeof raw.interventionCount === "number" && raw.interventionCount >= 0 ? Math.floor(raw.interventionCount) : 0,
      finalOutput: boundedFinalOutput(finalOutput),
      trim: { trimmed: false, markerCount: 0 },
      quarantine: { quarantined: false },
      clear: { cleared: false },
      recovery: { eligible: status === "interrupted", count: 0 },
      bytes: { session: 0, checkpoint: 0, total: 0 },
      createdAt,
      updatedAt: now,
    };
    const checked = parsePiChildHistoryIndex({ schemaVersion: 1, parentSessionId, records: [migrated], updatedAt: now });
    if (checked.isErr()) return err({ type: "history-schema", reason: "invalid" });
    records.push(checked.value.records[0]!);
  }
  return parsePiChildHistoryIndex({ schemaVersion: 1, parentSessionId, records, updatedAt: now }).mapErr(() => ({ type: "history-schema", reason: "invalid" }));
}

export class PiChildHistoryStore {
  private constructor(
    readonly parentSessionId: string,
    private readonly settings: HistorySettings,
    private readonly fs: PiChildHistoryFsPort,
    private readonly root: PiChildHistoryDirectory,
    private readonly children: PiChildHistoryDirectory,
    private readonly now: () => number,
    private index: PiChildHistoryIndexV1,
    private readonly activeParentSessionId: string,
    private readonly activeChildId: string | undefined,
    private readonly inspectedChildId: string | undefined,
    private readonly disabled: boolean,
  ) {}

  static open(
    parentSessionId: string,
    settings: PiChildInspectionEffectiveSettings | HistorySettings,
    options: PiChildHistoryOpenOptions = {},
  ): ResultAsync<PiChildHistoryStore, PiChildHistoryStoreError> {
    const now = options.now ?? (() => Date.now());
    const effectiveSettings = historySettings(settings);
    const fs = options.fs ?? new BunPiChildHistoryFs();
    const activeParentSessionId = options.activeParentSessionId ?? parentSessionId;
    if (!effectiveSettings.persist_history) {
      const memory = new MemoryPiChildHistoryFs();
      const path = resolvePiChildHistoryRoot(parentSessionId, options.env, options.home);
      if (path.isErr()) return errAsync(mapFs(path.error, "open"));
      return memory.openDirectory(`${path.value}/disabled`, true)
        .andThen((root) => memory.openDirectory(`${path.value}/disabled/children`, true)
          .map((children) => new PiChildHistoryStore(parentSessionId, effectiveSettings, memory, root, children, now, emptyIndex(parentSessionId, now()), activeParentSessionId, options.activeChildId, options.inspectedChildId, true))
          .mapErr((cause) => { root.close(); return cause; }))
        .mapErr((cause) => mapFs(cause, "open"));
    }
    const rootPath = resolvePiChildHistoryRoot(parentSessionId, options.env, options.home);
    if (rootPath.isErr()) return errAsync(mapFs(rootPath.error, "open"));
    const rootPathValue = rootPath.value;
    const fsResult = fs.openDirectory(rootPathValue, true).andThen((root) =>
      fs.openDirectory(`${rootPathValue}/${PI_CHILD_HISTORY_LAYOUT.childDirectory}`, true)
        .map((children) => ({ root, children }))
        .mapErr((cause) => { root.close(); return cause; }),
    );
    return fsResult
      .andThen(({ root, children }) =>
        readIndex(root, parentSessionId, now()).map((index) => new PiChildHistoryStore(parentSessionId, effectiveSettings, fs, root, children, now, index, activeParentSessionId, options.activeChildId, options.inspectedChildId, false))
          .mapErr((error) => { root.close(); children.close(); return error; }),
      )
      .mapErr((error) => asStoreError(error, "open"));
  }

  getIndex(): PiChildHistoryIndexV1 { return this.index; }
  getRootPath(): string { return this.root.path; }
  isPersistenceDisabled(): boolean { return this.disabled; }

  private rootIdentity(action: StoreAction): ResultAsync<HistoryIdentity, PiChildHistoryStoreError> {
    return this.root.identity().mapErr((cause) => mapFs(cause, action));
  }

  private childDirectory(childId: string, create = true, action: StoreAction = "read"): ResultAsync<PiChildHistoryDirectory, PiChildHistoryStoreError> {
    const component = safeChildHistoryComponent(childId);
    if (component.isErr()) return errAsync(mapFs(component.error, action));
    return this.children.identity().mapErr((cause) => mapFs(cause, action)).andThen(() => this.fs.openDirectory(`${this.children.path}/${component.value}`, create)
      .mapErr((cause) => mapFs(cause, action)));
  }

  /** Run one operation with a child directory handle and always release it. */
  private withChildDirectory<T>(
    childId: string,
    create: boolean,
    action: StoreAction,
    operation: (directory: PiChildHistoryDirectory) => ResultAsync<T, PiChildHistoryStoreError>,
  ): ResultAsync<T, PiChildHistoryStoreError> {
    return this.childDirectory(childId, create, action).andThen((directory) =>
      ResultAsync.fromThrowable(
        async () => {
          try {
            return await operation(directory);
          } finally {
            directory.close();
          }
        },
        () => ({ type: "history-fs", action, cause: { type: "io" } } as const),
      )().andThen((result) => result),
    );
  }

  private persistIndex(action: StoreAction = "write"): ResultAsync<void, PiChildHistoryStoreError> {
    if (this.disabled) return okAsync(undefined);
    return this.rootIdentity(action).andThen(() => {
      const encoded = safeJson(this.index, "index");
      if (encoded.isErr()) return errAsync(encoded.error);
      return this.root.writeFileAtomic(INDEX_TEMP, encoded.value, PI_CHILD_HISTORY_LAYOUT.fileMode)
        .andThen(() => this.root.writeFileAtomic(PI_CHILD_HISTORY_LAYOUT.indexFile, encoded.value, PI_CHILD_HISTORY_LAYOUT.fileMode))
        .andThen(() => this.root.deleteFile(INDEX_TEMP))
        .mapErr((cause) => mapFs(cause, action));
    });
  }

  upsertRecord(input: PiChildHistoryRecord): ResultAsync<void, PiChildHistoryStoreError> {
    if (this.disabled) return okAsync(undefined);
    const now = this.now();
    const normalized = canonicalRecord(input, this.parentSessionId, now);
    const checked = parsePiChildHistoryIndex({ ...this.index, records: [normalized], updatedAt: now });
    if (checked.isErr()) return errAsync({ type: "history-schema", reason: "invalid" });
    const found = this.index.records.findIndex((record) => record.childId === normalized.childId);
    const records = [...this.index.records];
    if (found >= 0) records[found] = normalized; else records.push(normalized);
    const parsed = parsePiChildHistoryIndex({ schemaVersion: 1, parentSessionId: this.parentSessionId, records, updatedAt: now });
    if (parsed.isErr()) return errAsync({ type: "history-schema", reason: "invalid" });
    this.index = parsed.value;
    return this.enforceQuotas().andThen(() => this.persistIndex());
  }

  updateRecord(childId: string, patch: Partial<Omit<PiChildHistoryRecord, "childId" | "parentSessionId" | "sessionPath">>): ResultAsync<void, PiChildHistoryStoreError> {
    const current = this.index.records.find((record) => record.childId === childId);
    if (!current) return errAsync({ type: "child-not-found" });
    return this.upsertRecord({ ...current, ...patch, childId, parentSessionId: this.parentSessionId, sessionPath: current.sessionPath });
  }

  appendCheckpoint(
    childId: string,
    entries: readonly PiChildSessionCheckpointEntry[],
    activeLeaf?: string,
  ): ResultAsync<PiChildSessionCheckpoint, PiChildHistoryStoreError> {
    if (this.disabled) return errAsync({ type: "history-disabled" });
    const now = this.now();
    return this.withChildDirectory(childId, true, "checkpoint", (directory) =>
      directory.readFile(PI_CHILD_HISTORY_LAYOUT.checkpointFile)
        .mapErr((cause) => mapFs(cause, "checkpoint"))
        .andThen((bytes) => {
          const current = bytes === undefined
            ? okAsync<PiChildSessionCheckpoint, PiChildHistoryStoreError>(createEmptyPiChildSessionCheckpoint(now))
            : toAsync(decodePiChildSessionCheckpoint(bytes)).orElse(() => directory.quarantineFile(PI_CHILD_HISTORY_LAYOUT.checkpointFile, "malformed")
              .mapErr((cause) => mapFs(cause, "quarantine"))
              .andThen(() => errAsync<PiChildSessionCheckpoint, PiChildHistoryStoreError>({ type: "history-quarantined", reason: "checkpoint" })));
          return current
            .andThen((checkpoint) => toAsync(appendUnseenCheckpointEntries(checkpoint, entries, activeLeaf, now)
              .mapErr(() => ({ type: "history-json", action: "session", reason: "oversized" } as PiChildHistoryStoreError))))
            .andThen((checkpoint) => toAsync(encodePiChildSessionCheckpoint(checkpoint)
              .mapErr(() => ({ type: "history-json", action: "session", reason: "oversized" } as PiChildHistoryStoreError))))
            .andThen((encoded) => {
              const decoded = decodePiChildSessionCheckpoint(encoded).unwrapOr(createEmptyPiChildSessionCheckpoint(now));
              return directory.writeFileAtomic(PI_CHILD_HISTORY_LAYOUT.checkpointFile, encoded, PI_CHILD_HISTORY_LAYOUT.fileMode)
                .mapErr((cause) => mapFs(cause, "checkpoint"))
                .andThen(() => this.refreshBytes(childId, directory))
                .andThen(() => this.updateRecord(childId, {
                  activeLeaf: decoded.activeLeaf,
                  checkpointCursor: decoded.entries.length,
                }))
                .map(() => decoded);
            });
        }),
    );
  }

  readCheckpointFor(childId: string): ResultAsync<PiChildSessionCheckpoint, PiChildHistoryStoreError> {
    if (this.disabled) return errAsync({ type: "history-disabled" });
    return this.withChildDirectory(childId, false, "read", (directory) => directory.readFile(PI_CHILD_HISTORY_LAYOUT.checkpointFile)
      .mapErr((cause) => mapFs(cause, "read"))
      .andThen((bytes) => bytes === undefined
        ? okAsync(createEmptyPiChildSessionCheckpoint(this.now()))
        : toAsync(decodePiChildSessionCheckpoint(bytes)).orElse(() => directory.quarantineFile(PI_CHILD_HISTORY_LAYOUT.checkpointFile, "malformed")
          .mapErr((cause) => mapFs(cause, "quarantine"))
          .andThen(() => errAsync<PiChildSessionCheckpoint, PiChildHistoryStoreError>({ type: "history-quarantined", reason: "checkpoint" })))));
  }

  appendSessionEvent(childId: string, event: PiChildSessionEvent): ResultAsync<void, PiChildHistoryStoreError> {
    if (this.disabled) return errAsync({ type: "history-disabled" });
    const parsed = parsePiChildSessionEvent(event);
    if (!parsed.success) return errAsync({ type: "history-json", action: "session", reason: "malformed" });
    const line = safeJson(parsed.data, "session");
    if (line.isErr()) return errAsync(line.error);
    const record = this.index.records.find((item) => item.childId === childId);
    if (!record) return errAsync({ type: "child-not-found" });
    const lineBytes = new Uint8Array([...line.value, 10]);
    return this.withChildDirectory(childId, true, "append", (directory) => directory.readFile(PI_CHILD_HISTORY_LAYOUT.sessionFile)
      .mapErr((cause) => mapFs(cause, "append"))
      .andThen((existing) => this.validateSessionBytes(directory, existing))
      .andThen(() => directory.appendFile(PI_CHILD_HISTORY_LAYOUT.sessionFile, lineBytes, PI_CHILD_HISTORY_LAYOUT.fileMode)
        .mapErr((cause) => mapFs(cause, "append"))
        .andThen(() => this.refreshBytes(childId, directory).andThen(() => this.enforceQuotas()).andThen(() => this.persistIndex()))));
  }

  /** Validate every JSONL line before exposing or extending a session. */
  readSessionEvents(childId: string): ResultAsync<readonly PiChildSessionEvent[], PiChildHistoryStoreError> {
    if (this.disabled) return errAsync({ type: "history-disabled" });
    return this.withChildDirectory(childId, false, "read", (directory) => directory.readFile(PI_CHILD_HISTORY_LAYOUT.sessionFile)
      .mapErr((cause) => mapFs(cause, "read"))
      .andThen((bytes) => this.validateSessionBytes(directory, bytes)));
  }

  clear(childId: string): ResultAsync<void, PiChildHistoryStoreError> {
    if (this.disabled) return errAsync({ type: "history-disabled" });
    const index = this.index.records.findIndex((record) => record.childId === childId);
    if (index < 0) return errAsync({ type: "clear-refused", status: "missing" });
    const record = this.index.records[index]!;
    if (record.status === "running" || record.status === "queued") return errAsync({ type: "clear-refused", status: record.status });
    return this.withChildDirectory(childId, false, "clear", (directory) => directory.deleteFile(PI_CHILD_HISTORY_LAYOUT.sessionFile)
      .andThen(() => directory.deleteFile(PI_CHILD_HISTORY_LAYOUT.checkpointFile))
      .mapErr((cause) => mapFs(cause, "clear")))
      .orElse((error) => error.type === "history-fs" && error.cause.type === "missing" ? okAsync(undefined) : errAsync(error))
      .andThen(() => {
        this.index = { ...this.index, records: this.index.records.filter((item) => item.childId !== childId), updatedAt: this.now() };
        return this.persistIndex("clear");
      });
  }

  pruneOrphans(now = this.now()): ResultAsync<number, PiChildHistoryStoreError> {
    if (this.disabled) return okAsync(0);
    const cutoff = now - this.settings.orphan_retention_days * 86_400_000;
    const orphaned = this.index.records.filter((record) => record.parentSessionId !== this.activeParentSessionId && record.updatedAt < cutoff && terminal.has(record.status));
    if (orphaned.length === 0) return okAsync(0);
    return this.deleteMany(orphaned, "prune")
      .andThen(() => {
        const ids = new Set(orphaned.map((record) => record.childId));
        this.index = { ...this.index, records: this.index.records.filter((record) => !ids.has(record.childId)), updatedAt: now };
        return this.persistIndex("prune").map(() => orphaned.length);
      });
  }

  enforceQuotas(): ResultAsync<void, PiChildHistoryStoreError> {
    if (this.disabled) return okAsync(undefined);
    return this.refreshAllBytes()
      .andThen(() => {
        const overChildLimit = this.index.records.filter(
          (record) => record.bytes.total > this.settings.max_bytes_per_child,
        );
        if (overChildLimit.length === 0) return okAsync(undefined);
        return this.deleteMany(overChildLimit, "quota").andThen(() => {
          this.markTrimmed(new Set(overChildLimit.map((record) => record.childId)));
          return this.refreshAllBytes();
        });
      })
      .andThen(() => this.trimToTotal(this.index.records));
  }

  close(): void {
    this.root.close();
    this.children.close();
  }

  private validateSessionBytes(
    directory: PiChildHistoryDirectory,
    bytes: Uint8Array | undefined,
  ): ResultAsync<readonly PiChildSessionEvent[], PiChildHistoryStoreError> {
    if (bytes === undefined || bytes.length === 0) return okAsync([]);
    const quarantine = (suffix: "oversized" | "malformed" | "invalid") => directory.quarantineFile(PI_CHILD_HISTORY_LAYOUT.sessionFile, suffix)
      .mapErr((cause) => mapFs(cause, "quarantine"))
      .andThen(() => errAsync<readonly PiChildSessionEvent[], PiChildHistoryStoreError>({ type: "history-quarantined", reason: "session" }));
    if (bytes.length > this.settings.max_bytes_per_child) return quarantine("oversized");
    const decoded = Result.fromThrowable(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes), () => undefined)();
    if (decoded.isErr()) return quarantine("malformed");
    const events: PiChildSessionEvent[] = [];
    for (const line of decoded.value.split("\n")) {
      if (line.trim() === "") continue;
      if (new TextEncoder().encode(line).length > MAX_JSONL_LINE_BYTES) return quarantine("oversized");
      const value = Result.fromThrowable(() => JSON.parse(line) as unknown, () => undefined)();
      if (value.isErr()) return quarantine("malformed");
      const parsed = parsePiChildSessionEvent(value.value);
      if (!parsed.success) return quarantine("invalid");
      events.push(parsed.data);
    }
    return okAsync(events);
  }

  private readPersistedBytes(record: PiChildHistoryRecord): ResultAsync<PersistedBytes, PiChildHistoryStoreError> {
    return this.withChildDirectory(record.childId, false, "quota", (directory) =>
      directory.readFile(PI_CHILD_HISTORY_LAYOUT.sessionFile)
        .mapErr((cause) => mapFs(cause, "quota"))
        .andThen((session) => directory.readFile(PI_CHILD_HISTORY_LAYOUT.checkpointFile)
          .mapErr((cause) => mapFs(cause, "quota"))
          .map((checkpoint) => ({
            session: session?.byteLength ?? 0,
            checkpoint: checkpoint?.byteLength ?? 0,
            total: (session?.byteLength ?? 0) + (checkpoint?.byteLength ?? 0),
          }))),
    ).orElse((error) => error.type === "history-fs" && (error.cause.type === "missing" || (error.cause.type === "unavailable" && error.cause.operation === "open"))
      ? okAsync({ session: 0, checkpoint: 0, total: 0 })
      : errAsync(error));
  }

  private refreshAllBytes(): ResultAsync<void, PiChildHistoryStoreError> {
    let result: ResultAsync<readonly { readonly childId: string; readonly bytes: PersistedBytes }[], PiChildHistoryStoreError> = okAsync([]);
    for (const record of this.index.records) {
      result = result.andThen((values) => this.readPersistedBytes(record).map((bytes) => [...values, { childId: record.childId, bytes }]));
    }
    return result.map((values) => {
      const byChildId = new Map(values.map((value) => [value.childId, value.bytes]));
      this.index = {
        ...this.index,
        records: this.index.records.map((record) => {
          const bytes = byChildId.get(record.childId);
          return bytes === undefined ? record : { ...record, bytes };
        }),
        updatedAt: this.now(),
      };
      return undefined;
    });
  }

  private markTrimmed(ids: ReadonlySet<string>): void {
    const trimmedAt = this.now();
    this.index = {
      ...this.index,
      records: this.index.records.map((record) => ids.has(record.childId)
        ? {
            ...record,
            bytes: { session: 0, checkpoint: 0, total: 0 },
            trim: {
              trimmed: true,
              markerCount: record.trim.markerCount + 1,
              lastTrimmedAt: trimmedAt,
            },
          }
        : record),
      updatedAt: trimmedAt,
    };
  }

  private refreshBytes(childId: string, directory: PiChildHistoryDirectory, checkpoint?: PiChildSessionCheckpoint): ResultAsync<void, PiChildHistoryStoreError> {
    return directory.readFile(PI_CHILD_HISTORY_LAYOUT.sessionFile).mapErr((cause) => mapFs(cause, "read")).andThen((session) => directory.readFile(PI_CHILD_HISTORY_LAYOUT.checkpointFile).mapErr((cause) => mapFs(cause, "read")).andThen((checkpointBytes) => {
      const index = this.index.records.findIndex((record) => record.childId === childId);
      if (index < 0) return errAsync({ type: "child-not-found" } as PiChildHistoryStoreError);
      const next = { ...this.index.records[index]!, bytes: { session: session?.length ?? 0, checkpoint: checkpointBytes?.length ?? (checkpoint ? JSON.stringify(checkpoint).length : 0), total: (session?.length ?? 0) + (checkpointBytes?.length ?? 0) }, updatedAt: this.now() };
      const records = [...this.index.records];
      records[index] = next;
      this.index = { ...this.index, records, updatedAt: this.now() };
      return okAsync(undefined);
    }).mapErr((cause) => isFsError(cause) ? mapFs(cause, "read") : cause));
  }

  private deleteTerminalBytes(record: PiChildHistoryRecord, action: StoreAction = "prune"): ResultAsync<void, PiChildHistoryStoreError> {
    return this.withChildDirectory(record.childId, false, action, (directory) => directory.deleteFile(PI_CHILD_HISTORY_LAYOUT.sessionFile)
      .andThen(() => directory.deleteFile(PI_CHILD_HISTORY_LAYOUT.checkpointFile))
      .mapErr((cause) => mapFs(cause, action)))
      .orElse((error) => error.type === "history-fs" && (error.cause.type === "missing" || (error.cause.type === "unavailable" && error.cause.operation === "open"))
        ? okAsync(undefined)
        : errAsync(error));
  }

  private deleteMany(records: readonly PiChildHistoryRecord[], action: StoreAction): ResultAsync<void, PiChildHistoryStoreError> {
    let result: ResultAsync<void, PiChildHistoryStoreError> = okAsync(undefined);
    for (const record of records) result = result.andThen(() => this.deleteTerminalBytes(record, action));
    return result;
  }

  private trimToTotal(records: readonly PiChildHistoryRecord[]): ResultAsync<void, PiChildHistoryStoreError> {
    const protectedIds = new Set<string>();
    const byId = new Map(records.map((record) => [record.childId, record]));
    const protectBranch = (childId: string): void => {
      let current = byId.get(childId);
      const visited = new Set<string>();
      while (current !== undefined && !visited.has(current.childId)) {
        visited.add(current.childId);
        protectedIds.add(current.childId);
        for (const branch of current.branchAncestry) protectedIds.add(branch.childId);
        current = current.parentChildId === undefined ? undefined : byId.get(current.parentChildId);
      }
    };

    for (const id of [this.activeChildId, this.inspectedChildId]) {
      if (id !== undefined) protectBranch(id);
    }
    for (const record of records) {
      if (record.status === "running" || record.status === "queued") protectBranch(record.childId);
    }

    const candidates = records
      .filter((record) => terminal.has(record.status) && !protectedIds.has(record.childId) && record.bytes.total > 0)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt || a.childId.localeCompare(b.childId));
    let total = records.reduce((sum, record) => sum + record.bytes.total, 0);
    const victims: PiChildHistoryRecord[] = [];
    for (const candidate of candidates) {
      if (total <= this.settings.max_bytes_total) break;
      total -= candidate.bytes.total;
      victims.push(candidate);
    }

    if (victims.length === 0) {
      return this.persistIndex("quota").andThen(() => total <= this.settings.max_bytes_total
        ? okAsync(undefined)
        : errAsync({ type: "quota-exceeded", scope: "total" } as PiChildHistoryStoreError));
    }

    const victimIds = new Set(victims.map((record) => record.childId));
    return this.deleteMany(victims, "quota")
      .andThen(() => {
        this.markTrimmed(victimIds);
        return this.refreshAllBytes();
      })
      .andThen(() => {
        const finalTotal = this.index.records.reduce((sum, record) => sum + record.bytes.total, 0);
        return this.persistIndex("quota").andThen(() => finalTotal <= this.settings.max_bytes_total
          ? okAsync(undefined)
          : errAsync({ type: "quota-exceeded", scope: "total" } as PiChildHistoryStoreError));
      });
  }
}

function readIndex(root: PiChildHistoryDirectory, parentSessionId: string, now: number): ResultAsync<PiChildHistoryIndexV1, PiChildHistoryStoreError> {
  return root.readFile(PI_CHILD_HISTORY_LAYOUT.indexFile)
    .andThen((indexBytes) => root.readFile(INDEX_TEMP).map((tempBytes) => ({ indexBytes, tempBytes })))
    .mapErr((cause) => mapFs(cause, "read"))
    .andThen(({ indexBytes, tempBytes }) => {
      if (indexBytes === undefined && tempBytes === undefined) return okAsync(emptyIndex(parentSessionId, now));
      const candidates = [
        ...(indexBytes === undefined ? [] : [{ file: PI_CHILD_HISTORY_LAYOUT.indexFile, bytes: indexBytes }]),
        ...(tempBytes === undefined ? [] : [{ file: INDEX_TEMP, bytes: tempBytes }]),
      ];
      let firstFailure: "oversized" | "malformed" | "unsupported" | "invalid" = "malformed";
      for (const candidate of candidates) {
        if (candidate.bytes.length > MAX_INDEX_BYTES) { firstFailure = "oversized"; continue; }
        const decoded = decodeJson(candidate.bytes);
        if (decoded.isErr()) { firstFailure = "malformed"; continue; }
        const parsed = parsePiChildHistoryIndex(decoded.value);
        if (parsed.isOk()) {
          return recoverIndexCandidate(root, candidates, candidate.file, parsed.value);
        }
        if (isRecord(decoded.value) && decoded.value.schemaVersion === 0) {
          return toAsync(migrateV0(decoded.value, parentSessionId, now))
            .andThen((index) => recoverIndexCandidate(root, candidates, candidate.file, index));
        }
        firstFailure = parsed.error.type === "ChildHistoryVersionUnsupported" ? "unsupported" : "invalid";
      }
      return quarantineIndexFiles(root, candidates.map((candidate) => candidate.file), firstFailure);
    });
}

function recoverIndexCandidate(
  root: PiChildHistoryDirectory,
  candidates: readonly { file: string; bytes: Uint8Array }[],
  selected: string,
  index: PiChildHistoryIndexV1,
): ResultAsync<PiChildHistoryIndexV1, PiChildHistoryStoreError> {
  const encoded = safeJson(index, "index");
  if (encoded.isErr()) return errAsync(encoded.error);
  let result: ResultAsync<void, PiChildHistoryStoreError> = okAsync(undefined);
  for (const candidate of candidates) {
    if (candidate.file !== selected) result = result.andThen(() => quarantineOneIndex(root, candidate.file));
  }
  return result
    .andThen(() => root.writeFileAtomic(INDEX_TEMP, encoded.value, PI_CHILD_HISTORY_LAYOUT.fileMode).mapErr((cause) => mapFs(cause, "write")))
    .andThen(() => root.writeFileAtomic(PI_CHILD_HISTORY_LAYOUT.indexFile, encoded.value, PI_CHILD_HISTORY_LAYOUT.fileMode).mapErr((cause) => mapFs(cause, "write")))
    .andThen(() => root.deleteFile(INDEX_TEMP).mapErr((cause) => mapFs(cause, "write")))
    .map(() => index);
}

function quarantineOneIndex(root: PiChildHistoryDirectory, file: string): ResultAsync<void, PiChildHistoryStoreError> {
  return root.quarantineFile(file, "corrupt")
    .mapErr((cause) => mapFs(cause, "quarantine"));
}

function quarantineIndexFiles(
  root: PiChildHistoryDirectory,
  files: readonly string[],
  _reason: string,
): ResultAsync<PiChildHistoryIndexV1, PiChildHistoryStoreError> {
  let result: ResultAsync<void, PiChildHistoryStoreError> = okAsync(undefined);
  for (const file of files) result = result.andThen(() => quarantineOneIndex(root, file));
  return result.andThen(() => errAsync({ type: "history-quarantined", reason: "index" } as PiChildHistoryStoreError));
}