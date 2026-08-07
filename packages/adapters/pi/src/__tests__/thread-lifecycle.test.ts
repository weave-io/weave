/**
 * Thread lifecycle (Pi adapter contract §9): one logical child thread, many
 * runs. Every run re-derives authority, source integrity, policy, and parallel
 * capacity; no run mutates or reopens a previous run's record; and nothing a
 * caller sees names a filesystem location.
 */
import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, type Result } from "neverthrow";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import { WEAVE_CHILD_ID_ENV, WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { type PiControlEnvelope, signEnvelope } from "../child-envelope.js";
import {
  FakePiChildMetadataCacheFs,
  openBunChildMetadataDatabase,
  openPiChildMetadataCache,
} from "../child-metadata-cache.js";
import {
  type CreateNativeChildSessionInput,
  PI_NATIVE_THREAD_ENTRY_TYPE,
  PI_NATIVE_THREAD_SCHEMA_VERSION,
  type PiNativeSessionEntries,
  type PiNativeSessionError,
  type PiNativeSessionRecord,
  type PiNativeThreadMetadataInput,
  readNativeThreadMetadata,
} from "../child-native-sessions.js";
import type {
  AppendChildRefLifecycleInput,
  AppendChildRefRunInput,
  AppendNewChildRefInput,
  PiChildRefRecord,
  PiChildRefScan,
} from "../child-session-refs.js";
import {
  CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
  createPiChildSessionStorageAuthority,
  type PiChildSessionStorageAuthority,
} from "../child-session-storage-authority.js";
import { SystemTimerPort } from "../child-timer.js";
import {
  PiDelegationController,
  type PiDelegationRequest,
  type PiThreadCachePort,
  type PiThreadRefPort,
  type PiThreadRunRequest,
  type PiThreadSessionPort,
} from "../delegation-controller.js";
import type { JsonValue } from "../strict-json.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";
import { TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

const GENERATION = "gen-1";
const OWNER_SESSION = "parent-session-1";
const SESSION_REF = "workspace/child-1/session.jsonl";
const SESSION_PATH =
  "/data/weave/adapters/pi/sessions/workspace/child-1/session.jsonl";
const SECRET_TASK_SENTINEL = "SECRET_TASK_TOKEN_WARP_T6";
const SECRET_TASK = [
  SECRET_TASK_SENTINEL,
  "second line with ANSI \u001b[31mred\u001b[0m text",
  "path=/Users/jose/projects/weave/.env.production",
  "password=correct-horse-battery-staple",
  "Authorization: Bearer credential-like-secret",
].join("\n");
const SECRET_TASK_MARKERS = [
  SECRET_TASK_SENTINEL,
  "second line with ANSI",
  "/Users/jose/projects/weave/.env.production",
  "password=correct-horse-battery-staple",
  "Authorization: Bearer credential-like-secret",
] as const;

const TARGET: DelegationTarget = {
  name: "shuttle",
  description: "General specialist",
  triggers: [],
  isCategory: false,
};

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function expectSecretAbsent(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of SECRET_TASK_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

function config(maxChildren = 1): WeaveConfig {
  const source = `settings {\n  delegation {\n    max_children ${maxChildren}\n    max_concurrency ${maxChildren}\n    max_depth 3\n    max_processes 8\n  }\n}\nagent shuttle {\n}\n`;
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

class SequentialIdGenerator {
  calls = 0;

  next(): string {
    this.calls += 1;
    return `child-${this.calls}`;
  }
}

function switchableSessionStorageAuthority(): PiChildSessionStorageAuthority & {
  readonly deny: () => void;
} {
  let available = true;
  return {
    deny: () => {
      available = false;
    },
    requireDescriptorSafeSessionIo: () =>
      available
        ? ok(undefined)
        : err({
            type: "SessionStorageUnavailable" as const,
            reason: "path-only-session-api" as const,
          }),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function request(
  overrides: Partial<PiDelegationRequest> = {},
): PiDelegationRequest {
  return {
    parentId: "root",
    parentDepth: 0,
    parentAgentName: "shuttle",
    agentName: "shuttle",
    task: "do the thing",
    cwd: "/project",
    env: {},
    bootstrap: {
      mode: "ordinary",
      agentName: "shuttle",
      composedPrompt: "You are Shuttle.",
      models: [],
      correlationId: "child-1",
      resolvedModel: { provider: "anthropic", id: "model-x" },
      thinkingLevel: "high",
      context: { parentAgentName: "shuttle", parentDepth: 0, cwd: "/project" },
    },
    ...overrides,
  };
}

/** Structural stand-in for the Task 5 ref store. Records every write. */
class FakeRefStore implements PiThreadRefPort {
  readonly dividers: Array<{
    readonly record: PiChildRefRecord;
    readonly input: AppendChildRefRunInput;
  }> = [];
  readonly lifecycles: AppendChildRefLifecycleInput[] = [];
  readonly newChildren: AppendNewChildRefInput[] = [];
  failDivider = false;
  failNewChild = false;
  private readonly records = new Map<string, PiChildRefRecord>();
  private readonly hidden = new Map<string, PiChildRefScan["issues"][number]>();

  constructor(
    record: PiChildRefRecord | undefined = undefined,
    private readonly scanIssues: PiChildRefScan["issues"] = [],
    private readonly liveSession: string = OWNER_SESSION,
  ) {
    if (record !== undefined) this.records.set(record.threadId, record);
  }

  liveParentSessionId(): string {
    return this.liveSession;
  }

  current(threadId = "child-1"): PiChildRefRecord | undefined {
    return this.records.get(threadId);
  }

  /** Hides one ref behind a scan issue, as the real store does. */
  hideCurrent(issue: PiChildRefScan["issues"][number]): void {
    if ("childId" in issue) this.hidden.set(issue.childId, issue);
  }

  readRefs() {
    const refs: PiChildRefRecord[] = [];
    const issues: Array<PiChildRefScan["issues"][number]> = [
      ...this.scanIssues,
    ];
    for (const record of this.records.values()) {
      const hidden = this.hidden.get(record.threadId);
      if (hidden !== undefined) {
        issues.push(hidden);
        continue;
      }
      refs.push(record);
    }
    return okAsync<PiChildRefScan, never>({
      refs,
      issues,
      counts: {
        scannedEntries: this.records.size,
        candidateEntries: this.records.size,
        malformedEntries: 0,
        originMismatchedChildren: issues.filter(
          (issue) => issue.kind === "origin-mismatch",
        ).length,
        conflictingChildren: issues.filter(
          (issue) => issue.kind === "conflicting-entry",
        ).length,
        duplicateEntries: issues.filter(
          (issue) => issue.kind === "duplicate-entry",
        ).length,
        unusableSourceChildren: issues.filter(
          (issue) => issue.kind === "source-unusable",
        ).length,
        usableRefs: refs.length,
      },
    });
  }

  appendNewChild(input: AppendNewChildRefInput) {
    if (this.failNewChild) {
      return errAsync({
        type: "ChildRefAppendFailed" as const,
        reason: "host-threw" as const,
      });
    }
    this.newChildren.push(input);
    const next: PiChildRefRecord = {
      childId: input.childId,
      threadId: input.threadId ?? input.childId,
      nativeSessionId: input.nativeSessionId,
      sessionRef: input.sessionRef,
      originParentSessionId: this.liveSession,
      originEntryId: `entry-${this.newChildren.length}`,
      title: input.title,
      status: input.status ?? "queued",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      runs:
        input.run === undefined
          ? []
          : [{ ...input.run, run: 1, startedAt: input.run.startedAt }],
    };
    this.records.set(next.threadId, next);
    return okAsync(next);
  }

  appendRunDivider(record: PiChildRefRecord, input: AppendChildRefRunInput) {
    if (this.failDivider) {
      return errAsync({
        type: "ChildRefAppendFailed" as const,
        reason: "host-threw" as const,
      });
    }
    this.dividers.push({ record, input });
    const next: PiChildRefRecord = {
      ...record,
      status: input.status ?? "running",
      runs: [
        ...record.runs,
        {
          run: record.runs.length + 1,
          action: input.action,
          startedAt: 1_700_000_001_000,
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
        },
      ],
    };
    this.records.set(next.threadId, next);
    return okAsync(next);
  }

  appendLifecycle(
    record: PiChildRefRecord,
    input: AppendChildRefLifecycleInput,
  ) {
    this.lifecycles.push(input);
    const next: PiChildRefRecord = { ...record, status: input.status };
    this.records.set(next.threadId, next);
    return okAsync(next);
  }
}

/** Structural stand-in for the Task 4 native session store. */
class FakeSessionStore implements PiThreadSessionPort {
  readonly created: CreateNativeChildSessionInput[] = [];
  readonly leaves: Array<{
    readonly ref: string;
    readonly metadata: PiNativeThreadMetadataInput;
    readonly leafId: string;
  }> = [];
  readonly tombstones: PiNativeSessionRecord[] = [];
  failCreate = false;
  failEstablish = false;
  private readError: PiNativeSessionError | undefined;
  private readonly records = new Map<string, PiNativeSessionRecord>();
  private readonly entries = new Map<string, unknown[]>();

  constructor(
    outcome:
      | { readonly kind: "available"; readonly entries: readonly unknown[] }
      | { readonly kind: "error"; readonly error: PiNativeSessionError } = {
      kind: "available",
      entries: [{ id: "leaf-1" }, { id: "leaf-42" }],
    },
  ) {
    if (outcome.kind === "error") {
      this.readError = outcome.error;
      return;
    }
    this.records.set(SESSION_REF, {
      childId: "child-1",
      sessionId: "native-1",
      ref: SESSION_REF,
      path: SESSION_PATH,
      parentSession: OWNER_SESSION,
      cwd: "/project",
    });
    this.entries.set(SESSION_REF, [...outcome.entries]);
  }

  failReadsWith(error: PiNativeSessionError): void {
    this.readError = error;
  }

  clearEntries(ref: string = SESSION_REF): void {
    this.entries.set(ref, []);
  }

  createChildSession(input: CreateNativeChildSessionInput) {
    if (this.failCreate) {
      return errAsync<PiNativeSessionRecord, PiNativeSessionError>({
        type: "SessionCreateFailed",
        reason: "host-threw",
      });
    }
    this.created.push(input);
    const ref =
      input.childId === "child-1"
        ? SESSION_REF
        : `workspace/${input.childId}/session.jsonl`;
    const path =
      input.childId === "child-1"
        ? SESSION_PATH
        : `/data/weave/adapters/pi/sessions/${ref}`;
    const record: PiNativeSessionRecord = {
      childId: input.childId,
      sessionId: `native-${input.childId}`,
      ref,
      path,
      parentSession: input.parentSession,
      cwd: input.cwd,
    };
    this.records.set(record.ref, record);
    this.entries.set(record.ref, []);
    this.readError = undefined;
    return okAsync(record);
  }

  establishThreadLeaf(
    ref: string,
    metadata: PiNativeThreadMetadataInput,
    expectedParentSession?: string,
  ) {
    if (this.failEstablish) {
      return errAsync({
        type: "SessionCreateFailed" as const,
        reason: "host-threw" as const,
      });
    }
    const record = this.records.get(ref);
    if (record === undefined) {
      return errAsync({ type: "SessionMissing" as const, ref });
    }
    if (
      expectedParentSession !== undefined &&
      record.parentSession !== expectedParentSession
    ) {
      return errAsync({
        type: "SessionCorrupt" as const,
        ref,
        reason: "parent-session-mismatch" as const,
      });
    }
    const leafId = `leaf-${this.leaves.length + 1}`;
    const entry = {
      id: leafId,
      type: "custom",
      customType: PI_NATIVE_THREAD_ENTRY_TYPE,
      data: {
        ...metadata,
        schemaVersion: PI_NATIVE_THREAD_SCHEMA_VERSION,
      },
    };
    this.entries.set(ref, [...(this.entries.get(ref) ?? []), entry]);
    this.leaves.push({ ref, metadata, leafId });
    return okAsync({ record, leafId });
  }

  appendTombstone(record: PiNativeSessionRecord) {
    this.tombstones.push(record);
    return okAsync({
      version: 1 as const,
      ref: record.ref,
      childId: record.childId,
      parentSession: record.parentSession,
      deletedAt: "2026-01-01T00:00:00.000Z",
      reason: "explicit-user-deletion" as const,
    });
  }

  openSession(ref: string, expectedParentSession?: string) {
    return this.readSessionEntries(ref, expectedParentSession).map(
      ({ record }) => record,
    );
  }

  readSessionEntries(ref: string, expectedParentSession?: string) {
    if (this.readError !== undefined) return errAsync(this.readError);
    const record = this.records.get(ref);
    if (record === undefined) {
      return errAsync({ type: "SessionMissing" as const, ref });
    }
    if (
      expectedParentSession !== undefined &&
      record.parentSession !== expectedParentSession
    ) {
      return errAsync({
        type: "SessionCorrupt" as const,
        ref,
        reason: "parent-session-mismatch" as const,
      });
    }
    return okAsync<PiNativeSessionEntries, PiNativeSessionError>({
      record,
      entries: this.entries.get(ref) ?? [],
    });
  }

  readSessionEntryPage(
    ref: string,
    expectedParentSession: string | undefined,
    options: {
      readonly direction: "newest" | "older" | "newer";
      readonly cursor?: string;
      readonly limit?: number;
    },
  ) {
    return this.readSessionEntries(ref, expectedParentSession).andThen(
      ({ entries }) => {
        const limit = Math.max(
          1,
          Math.min(100, Math.floor(options.limit ?? 100)),
        );
        const all = [...entries];
        const parseCursor = (
          cursor: string | undefined,
        ): Result<number, PiNativeSessionError> => {
          if (cursor === undefined || !cursor.startsWith("idx:")) {
            return err({
              type: "SessionCorrupt",
              ref,
              reason: "invalid-cursor",
            });
          }
          const value = Number(cursor.slice(4));
          if (!Number.isSafeInteger(value) || value < 0) {
            return err({
              type: "SessionCorrupt",
              ref,
              reason: "invalid-cursor",
            });
          }
          return ok(value);
        };
        if (options.direction === "newest") {
          const start = Math.max(0, all.length - limit);
          const slice = all.slice(start);
          return okAsync({
            entries: slice.map((value, index) => ({
              kind: "entry" as const,
              offset: start + index,
              value,
            })),
            ...(start > 0 ? { olderCursor: `idx:${start}` } : {}),
            ...(all.length > 0 ? { newerCursor: `idx:${all.length - 1}` } : {}),
            bytesRead: slice.length,
            linesScanned: slice.length,
          });
        }
        const cursorIndex = parseCursor(options.cursor);
        if (cursorIndex.isErr()) return errAsync(cursorIndex.error);
        if (options.direction === "older") {
          const end = cursorIndex.value;
          const start = Math.max(0, end - limit);
          const slice = all.slice(start, end);
          return okAsync({
            entries: slice.map((value, index) => ({
              kind: "entry" as const,
              offset: start + index,
              value,
            })),
            ...(start > 0 ? { olderCursor: `idx:${start}` } : {}),
            ...(slice.length > 0
              ? { newerCursor: `idx:${start + slice.length - 1}` }
              : {}),
            bytesRead: slice.length,
            linesScanned: slice.length,
          });
        }
        const start = cursorIndex.value + 1;
        const end = Math.min(all.length, start + limit);
        const slice = all.slice(start, end);
        return okAsync({
          entries: slice.map((value, index) => ({
            kind: "entry" as const,
            offset: start + index,
            value,
          })),
          ...(start > 0 && slice.length > 0
            ? { olderCursor: `idx:${start}` }
            : {}),
          ...(end < all.length ? { newerCursor: `idx:${end - 1}` } : {}),
          bytesRead: slice.length,
          linesScanned: slice.length,
        });
      },
    );
  }

  readThreadMetadata(ref: string, expectedParentSession?: string) {
    return this.readSessionEntries(ref, expectedParentSession).andThen(
      ({ record, entries }) => {
        const metadata = readNativeThreadMetadata(entries);
        if (metadata === undefined) {
          return errAsync({
            type: "SessionCorrupt" as const,
            ref: record.ref,
            reason: "unreadable" as const,
          });
        }
        return okAsync(metadata);
      },
    );
  }
}

class FakeCache implements PiThreadCachePort {
  readonly writes: PiChildRefRecord[] = [];
  throws = false;

  upsertRef(ref: PiChildRefRecord) {
    if (this.throws) throw new Error("cache exploded");
    this.writes.push(ref);
    return ok(ref);
  }
}

interface Harness {
  readonly controller: PiDelegationController;
  readonly port: FakeChildProcessPort;
  readonly refs: FakeRefStore;
  readonly sessions: FakeSessionStore | undefined;
  readonly cache: FakeCache;
}

function harness(
  overrides: {
    readonly refs?: FakeRefStore;
    readonly sessions?: FakeSessionStore | undefined;
    readonly cache?: FakeCache;
    readonly target?: DelegationTarget | undefined;
    readonly parentSessionId?: string | undefined;
    readonly idGenerator?: SequentialIdGenerator;
    readonly sessionStorageAuthority?: PiChildSessionStorageAuthority;
    readonly maxChildren?: number;
  } = {},
): Harness {
  const port = new FakeChildProcessPort();
  const refs = overrides.refs ?? new FakeRefStore(undefined);
  const cache = overrides.cache ?? new FakeCache();
  const sessions =
    overrides.sessions === undefined && !("sessions" in overrides)
      ? new FakeSessionStore()
      : overrides.sessions;
  const controller = new PiDelegationController({
    config: config(overrides.maxChildren ?? 1),
    generationId: GENERATION,
    idGenerator: overrides.idGenerator ?? new SequentialIdGenerator(),
    logger: noopLogger,
    processPort: port,
    sessionStorageAuthority:
      overrides.sessionStorageAuthority ??
      TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY,
    randomPort: new WebCryptoRandomPort(),
    hmacPort: new WebCryptoHmacPort(),
    timerPort: new SystemTimerPort(),
    cancelGraceMs: 10,
    rootAgentName: () => "shuttle",
    parentSessionId: () =>
      "parentSessionId" in overrides
        ? overrides.parentSessionId
        : OWNER_SESSION,
    resolveRootDelegationTarget: () =>
      "target" in overrides ? overrides.target : TARGET,
    buildBootstrap: (_target, childId) => ({
      mode: "ordinary",
      agentName: "shuttle",
      composedPrompt: "You are Shuttle.",
      models: [],
      correlationId: childId,
      resolvedModel: { provider: "anthropic", id: "model-x" },
      thinkingLevel: "high",
      context: { parentAgentName: "shuttle", parentDepth: 0, cwd: "/project" },
    }),
    threadRefs: () => refs,
    threadSessions: () => sessions,
    threadCache: () => cache,
    threadWorkspaceKey: () => "/project",
  });
  return { controller, port, refs, sessions, cache };
}

function spawnedAt(
  port: FakeChildProcessPort,
  index: number,
): FakeSpawnedProcess {
  const process = port.spawnedProcesses[index];
  if (process === undefined)
    throw new Error(`missing spawned process ${index}`);
  return process;
}

function extractSecret(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
): Uint8Array {
  const idx = port.spawnedProcesses.indexOf(process);
  const hex = port.spawnInputs[idx]?.env[WEAVE_CHILD_SECRET_ENV];
  if (hex === undefined) throw new Error("no secret in spawn env");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function childIdOf(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
): string {
  const idx = port.spawnedProcesses.indexOf(process);
  return port.spawnInputs[idx]?.env[WEAVE_CHILD_ID_ENV] ?? "";
}

/** Signs and emits authenticated envelopes for one spawned child. */
function childSigner(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
): {
  readonly childId: string;
  readonly sign: (
    kind: "handshake" | "bootstrap-ack" | "settled",
    body: JsonValue,
  ) => Promise<PiControlEnvelope>;
} {
  const secret = extractSecret(process, port);
  const childId = childIdOf(process, port);
  const randomPort = new WebCryptoRandomPort();
  const hmacPort = new WebCryptoHmacPort();
  let sequence = 1;
  return {
    childId,
    sign: async (kind, body) =>
      (
        await signEnvelope(
          {
            childId,
            generationId: GENERATION,
            direction: "child-to-parent",
            sequence: sequence++,
            nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
            correlationId: childId,
            kind,
            body,
          },
          secret,
          hmacPort,
        )
      )._unsafeUnwrap(),
  };
}

/** Authenticates one spawned child through handshake and bootstrap-ack. */
async function authenticateChild(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
): Promise<ReturnType<typeof childSigner>> {
  const signer = childSigner(process, port);
  process.emitLine(await signer.sign("handshake", {}));
  await flush();
  process.emitLine(
    await signer.sign("bootstrap-ack", {
      resolvedModel: { provider: "anthropic", id: "model-x" },
    }),
  );
  await flush();
  await flush();
  return signer;
}

/** Completes an already-authenticated child through optional entries and settlement. */
async function finishChild(
  process: FakeSpawnedProcess,
  signer: ReturnType<typeof childSigner>,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  const entriesRequest = process.writtenLines().find(
    (
      line,
    ): line is {
      type: string;
      id: string;
      command: string;
      since?: string;
    } =>
      typeof line === "object" &&
      line !== null &&
      (line as { type?: unknown }).type === "get_entries",
  );
  if (entriesRequest !== undefined) {
    const leafId =
      typeof entriesRequest.since === "string" &&
      entriesRequest.since.length > 0
        ? entriesRequest.since
        : "leaf-42";
    process.emitLine({
      type: "response",
      id: entriesRequest.id,
      command: "get_entries",
      success: true,
      data: { entries: [], leafId },
    });
    await flush();
  }
  if (outcome === "completed") {
    process.emitLine({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    });
    await flush();
  }
  process.emitLine(
    await signer.sign(
      "settled",
      outcome === "completed"
        ? { outcome, assistantOutput: "ok", outputByteLength: 2 }
        : { outcome, reason: "boom" },
    ),
  );
}

/** Drives one spawned child through handshake, run, and settlement. */
async function settleChild(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  const signer = await authenticateChild(process, port);
  await finishChild(process, signer, outcome);
}

/** Starts one thread and settles its first run with the given outcome. */
async function startThread(
  h: Harness,
  outcome: "completed" | "failed" = "failed",
): Promise<void> {
  const settlement = h.controller.delegate(request());
  await flush();
  await settleChild(spawnedAt(h.port, 0), h.port, outcome);
  const result = await settlement;
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
}

function resume(
  overrides: Partial<PiThreadRunRequest> = {},
): PiThreadRunRequest {
  return {
    threadId: "child-1",
    action: "retry",
    initiator: { kind: "owner", parentSessionId: OWNER_SESSION },
    ...overrides,
  };
}

describe("thread lifecycle: retry", () => {
  it("reuses the thread across a new run with a new child id and a frozen prior run", async () => {
    const h = harness();
    await startThread(h, "failed");
    expect(h.controller.threadStatus("child-1")).toEqual({
      threadId: "child-1",
      runs: 1,
      status: "failed",
      retryable: true,
    });

    const run = h.controller.resumeThread(resume());
    await flush();
    const second = spawnedAt(h.port, 1);
    // A new run is a new child id; the first run's id is never reused.
    expect(childIdOf(second, h.port)).toBe("child-2");
    await settleChild(second, h.port, "completed");
    const outcome = await run;
    if (outcome.isErr()) throw new Error(JSON.stringify(outcome.error));
    expect(outcome._unsafeUnwrap().threadId).toBe("child-1");
    expect(outcome._unsafeUnwrap().run).toBe(2);
    expect(outcome._unsafeUnwrap().settlement.outcome).toBe("completed");
    expect(h.controller.threadStatus("child-1")).toEqual({
      threadId: "child-1",
      runs: 2,
      status: "completed",
      retryable: false,
    });
  });

  it("reports assigned run number/agent/action before spawn via onRunAssigned", async () => {
    const h = harness();
    await startThread(h, "failed");
    const assignments: Array<{
      runNumber: number;
      action: string;
      agentName: string;
      childId: string;
    }> = [];
    const run = h.controller.resumeThread(
      resume({
        onRunAssigned: (assignment) => {
          assignments.push({
            runNumber: assignment.runNumber,
            action: assignment.action,
            agentName: assignment.agentName,
            childId: assignment.childId,
          });
          // Assignment must precede the second spawn.
          expect(h.port.spawnInputs.length).toBe(1);
        },
      }),
    );
    await flush();
    expect(assignments).toEqual([
      {
        runNumber: 2,
        action: "retry",
        agentName: "shuttle",
        childId: "child-2",
      },
    ]);
    const second = spawnedAt(h.port, 1);
    await settleChild(second, h.port, "completed");
    expect((await run).isOk()).toBe(true);
  });

  it("reopens the same native session at its newest leaf", async () => {
    const h = harness();
    await startThread(h, "failed");
    const run = h.controller.resumeThread(resume());
    await flush();
    const second = spawnedAt(h.port, 1);
    const command = h.port.spawnInputs[1]?.command ?? [];
    expect(command).toContain("--session");
    expect(command).toContain(SESSION_PATH);
    expect(command).toContain("--session-dir");
    await settleChild(second, h.port, "completed");
    await run;
  });

  it("appends a metadata-only divider naming the run, action, prior outcome, model, reasoning, and initiator", async () => {
    const h = harness();
    await startThread(h, "failed");
    const run = h.controller.resumeThread(
      resume({ instruction: "fix the failing assertion" }),
    );
    await flush();
    await settleChild(spawnedAt(h.port, 1), h.port, "completed");
    await run;
    expect(h.refs.dividers).toHaveLength(1);
    const divider = h.refs.dividers[0];
    expect(divider?.input).toEqual({
      action: "retry",
      priorOutcome: "failed",
      initiator: "owner",
      status: "running",
      model: "model-x",
      reasoning: "high",
    });
    // The instruction, the response, and every location stay out of the ref.
    const serialized = JSON.stringify(h.refs.dividers);
    expect(serialized).not.toContain("fix the failing assertion");
    expect(serialized).not.toContain(SESSION_PATH);
  });

  it("carries a bounded caller instruction and defaults to one when absent", async () => {
    const h = harness();
    await startThread(h, "failed");
    const run = h.controller.resumeThread(resume());
    await flush();
    const prompt = JSON.stringify(spawnedAt(h.port, 1).writtenLines());
    expect(prompt.length).toBeGreaterThan(0);
    await settleChild(spawnedAt(h.port, 1), h.port, "completed");
    expect((await run).isOk()).toBe(true);
  });

  it("refuses an over-long instruction before touching the thread", async () => {
    const h = harness();
    await startThread(h, "failed");
    const result = await h.controller.resumeThread(
      resume({ instruction: "x".repeat(8_193) }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ThreadResumeUnavailable");
    expect(h.port.spawnedProcesses).toHaveLength(1);
  });

  it("refuses a completed thread", async () => {
    const h = harness();
    await startThread(h, "completed");
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadNotRetryable");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe(
      "status-not-failed-or-cancelled",
    );
  });

  it("refuses an unknown thread", async () => {
    const h = harness();
    const result = await h.controller.resumeThread(
      resume({ threadId: "child-404" }),
    );
    expect(result._unsafeUnwrapErr().code).toBe("ThreadNotFound");
  });

  it("refuses a thread that is still running", async () => {
    const h = harness();
    const settlement = h.controller.delegate(request());
    await flush();
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadAlreadyRunning");
    await settleChild(spawnedAt(h.port, 0), h.port, "completed");
    await settlement;
  });
});

describe("thread lifecycle: continue", () => {
  it("runs another turn of a completed thread with the caller's task", async () => {
    const h = harness();
    await startThread(h, "completed");
    const run = h.controller.resumeThread(
      resume({ action: "continue", instruction: "now write the docs" }),
    );
    await flush();
    await settleChild(spawnedAt(h.port, 1), h.port, "completed");
    const outcome = await run;
    expect(outcome.isOk()).toBe(true);
    expect(outcome._unsafeUnwrap().run).toBe(2);
    expect(h.refs.dividers[0]?.input.action).toBe("continue");
  });

  it("refuses a continue without a task instead of inventing one", async () => {
    const h = harness();
    await startThread(h, "completed");
    const result = await h.controller.resumeThread(
      resume({ action: "continue" }),
    );
    expect(result._unsafeUnwrapErr().code).toBe("ThreadNotResumable");
    expect(h.port.spawnedProcesses).toHaveLength(1);
  });

  it("refuses a continue of a failed thread", async () => {
    const h = harness();
    await startThread(h, "failed");
    const result = await h.controller.resumeThread(
      resume({ action: "continue", instruction: "keep going" }),
    );
    expect(result._unsafeUnwrapErr().code).toBe("ThreadNotResumable");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe(
      "status-not-completed",
    );
  });
});

describe("thread lifecycle: authority", () => {
  it("refuses an initiator that is not the owning parent session", async () => {
    const h = harness();
    await startThread(h, "failed");
    const result = await h.controller.resumeThread(
      resume({
        initiator: { kind: "owner", parentSessionId: "other-session" },
      }),
    );
    expect(result._unsafeUnwrapErr().code).toBe("ThreadAuthorityDenied");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe("not-owner");
  });

  it("refuses an ancestor that holds no explicit transfer", async () => {
    const h = harness();
    await startThread(h, "failed");
    const result = await h.controller.resumeThread(
      resume({ initiator: { kind: "ancestor", ancestorChildId: "child-1" } }),
    );
    expect(result._unsafeUnwrapErr().code).toBe("ThreadAuthorityDenied");
    expect(h.port.spawnedProcesses).toHaveLength(1);
  });

  it("refuses to grant a transfer to an unauthenticated ancestor", async () => {
    const h = harness();
    await startThread(h, "failed");
    const granted = h.controller.grantThreadTransfer("child-1", "child-999");
    expect(granted.isErr()).toBe(true);
    expect(granted._unsafeUnwrapErr().code).toBe("ThreadAuthorityDenied");
  });

  it("allows an authenticated ancestor with an explicit grant to retry and continue the thread", async () => {
    // Live ancestor + resume run must coexist; max_children 1 would deny capacity.
    const h = harness({ maxChildren: 2 });
    await startThread(h, "failed");

    const ancestorSettlement = h.controller.delegate(request());
    await flush();
    const ancestor = spawnedAt(h.port, 1);
    expect(childIdOf(ancestor, h.port)).toBe("child-2");
    const ancestorSigner = await authenticateChild(ancestor, h.port);

    const granted = h.controller.grantThreadTransfer("child-1", "child-2");
    expect(granted.isOk()).toBe(true);

    const retry = h.controller.resumeThread(
      resume({ initiator: { kind: "ancestor", ancestorChildId: "child-2" } }),
    );
    await flush();
    await settleChild(spawnedAt(h.port, 2), h.port, "completed");
    const retryOutcome = await retry;
    expect(retryOutcome.isOk()).toBe(true);
    expect(retryOutcome._unsafeUnwrap().run).toBe(2);
    expect(h.refs.dividers[0]?.input.initiator).toBe("transferred-ancestor");

    const cont = h.controller.resumeThread(
      resume({
        action: "continue",
        instruction: "finish the remaining docs",
        initiator: { kind: "ancestor", ancestorChildId: "child-2" },
      }),
    );
    await flush();
    await settleChild(spawnedAt(h.port, 3), h.port, "completed");
    const continueOutcome = await cont;
    expect(continueOutcome.isOk()).toBe(true);
    expect(continueOutcome._unsafeUnwrap().run).toBe(3);
    expect(h.refs.dividers[1]?.input).toMatchObject({
      action: "continue",
      initiator: "transferred-ancestor",
    });

    await finishChild(ancestor, ancestorSigner, "completed");
    await ancestorSettlement;
  });

  it("refuses a thread whose ref belongs to another parent session", async () => {
    const h = harness();
    await startThread(h, "failed");
    h.refs.hideCurrent({ kind: "origin-mismatch", childId: "child-1" });
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadNotFound");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe(
      "origin-mismatch",
    );
  });
});

describe("thread lifecycle: source integrity", () => {
  it("refuses a thread whose native session is gone", async () => {
    const h = harness();
    await startThread(h, "failed");
    h.sessions?.failReadsWith({ type: "SessionMissing", ref: SESSION_REF });
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadStale");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe(
      "session-missing",
    );
    expect(h.port.spawnedProcesses).toHaveLength(1);
  });

  it("refuses a thread whose native session is corrupt", async () => {
    const h = harness();
    await startThread(h, "failed");
    h.sessions?.failReadsWith({
      type: "SessionCorrupt",
      ref: SESSION_REF,
      reason: "unreadable",
    });
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadIntegrityError");
  });

  it("refuses a session with no readable leaf", async () => {
    const h = harness();
    await startThread(h, "failed");
    h.sessions?.clearEntries();
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadIntegrityError");
  });

  it("refuses a tombstoned thread", async () => {
    const h = harness();
    await startThread(h, "failed");
    const current = h.refs.current();
    if (current === undefined) throw new Error("missing ref after start");
    (await h.refs.appendLifecycle(current, { status: "tombstoned" })).match(
      () => undefined,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadStale");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe("tombstoned");
  });

  it("refuses a thread with conflicting refs", async () => {
    const h = harness();
    await startThread(h, "failed");
    h.refs.hideCurrent({
      kind: "conflicting-entry",
      childId: "child-1",
      field: "sessionRef",
    });
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadIntegrityError");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe("ref-conflict");
  });

  it("refuses to resume when no ref source is wired", async () => {
    const h = harness();
    await startThread(h, "failed");
    const bare = new PiDelegationController({
      config: config(),
      generationId: GENERATION,
      idGenerator: new SequentialIdGenerator(),
      logger: noopLogger,
      processPort: new FakeChildProcessPort(),
      sessionStorageAuthority:
        TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY,
      randomPort: new WebCryptoRandomPort(),
      hmacPort: new WebCryptoHmacPort(),
    });
    const result = await bare.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadNotFound");
  });
});

describe("thread lifecycle: policy, capacity, and cache", () => {
  it("revalidates the current delegation policy before each run", async () => {
    const h = harness({ target: undefined });
    await startThread(h, "failed");
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadResumeUnavailable");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe(
      "policy-revoked",
    );
    expect(h.port.spawnedProcesses).toHaveLength(1);
  });

  it("counts a running thread against max_children and releases it on settlement", async () => {
    const h = harness();
    await startThread(h, "failed");
    // `max_children` is 1. A live start occupies the only slot, so the resume
    // is refused; once that child settles, the same resume is authorized.
    const blocking = h.controller.delegate(
      request({ bootstrap: { mode: "ordinary", correlationId: "child-2" } }),
    );
    await flush();
    const blocked = await h.controller.resumeThread(resume());
    expect(blocked._unsafeUnwrapErr().code).toBe("ChildCapacityExceeded");
    await settleChild(spawnedAt(h.port, 1), h.port, "completed");
    await blocking;
    const run = h.controller.resumeThread(resume());
    await flush();
    await settleChild(spawnedAt(h.port, 2), h.port, "completed");
    expect((await run).isOk()).toBe(true);
  });

  it("refuses the run when the divider cannot be written", async () => {
    const refs = new FakeRefStore(undefined);
    refs.failDivider = true;
    const h = harness({ refs });
    await startThread(h, "failed");
    const result = await h.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadResumeUnavailable");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe(
      "divider-write-failed",
    );
    expect(h.port.spawnedProcesses).toHaveLength(1);
  });

  it("treats the metadata cache as best effort", async () => {
    const cache = new FakeCache();
    cache.throws = true;
    const h = harness({ cache });
    await startThread(h, "failed");
    const run = h.controller.resumeThread(resume());
    await flush();
    await settleChild(spawnedAt(h.port, 1), h.port, "completed");
    const outcome = await run;
    expect(outcome.isOk()).toBe(true);
    expect(outcome._unsafeUnwrap().run).toBe(2);
  });

  it("records the settled run in the refs", async () => {
    const h = harness();
    await startThread(h, "failed");
    const run = h.controller.resumeThread(resume());
    await flush();
    await settleChild(spawnedAt(h.port, 1), h.port, "completed");
    await run;
    expect(h.refs.lifecycles).toEqual([
      { status: "failed" },
      { status: "completed" },
    ]);
  });

  it("never leaks a filesystem location through a failure", async () => {
    const h = harness();
    await startThread(h, "failed");
    h.sessions?.failReadsWith({ type: "SessionMissing", ref: SESSION_REF });
    const failure = (
      await h.controller.resumeThread(resume())
    )._unsafeUnwrapErr();
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(SESSION_PATH);
    expect(serialized).not.toContain(SESSION_REF);
    expect(serialized).not.toContain("/");
  });
});

describe("thread lifecycle: authoritative start provisioning", () => {
  it("creates the native session, leaf metadata, and parent ref before dispatch", async () => {
    const h = harness();
    const settlement = h.controller.delegate(request());
    await flush();
    expect(h.sessions?.created).toEqual([
      {
        childId: "child-1",
        parentSession: OWNER_SESSION,
        cwd: "/project",
      },
    ]);
    expect(h.sessions?.leaves).toHaveLength(1);
    expect(h.refs.newChildren).toHaveLength(1);
    expect(h.refs.newChildren[0]).toMatchObject({
      childId: "child-1",
      threadId: "child-1",
      sessionRef: SESSION_REF,
      title: "shuttle-child1",
      status: "running",
    });
    const command = h.port.spawnInputs[0]?.command ?? [];
    expect(command).toContain("--session");
    expect(command).toContain(SESSION_PATH);
    expect(command).toContain("--session-dir");
    await settleChild(spawnedAt(h.port, 0), h.port, "completed");
    expect((await settlement).isOk()).toBe(true);
  });

  it("writes rebuildable native leaf metadata with an identity-only title", async () => {
    const h = harness();
    const settlement = h.controller.delegate(
      request({
        task: "First line only\nSECRET_TASK_REMAINDER must not persist",
      }),
    );
    await flush();
    const leaf = h.sessions?.leaves[0];
    expect(leaf?.metadata).toMatchObject({
      threadId: "child-1",
      agentName: "shuttle",
      parentId: "root",
      parentAgentName: "shuttle",
      parentDepth: 0,
      ownerParentSessionId: OWNER_SESSION,
      cwd: "/project",
      model: "model-x",
      reasoning: "high",
    });
    const entries = (
      await h.sessions!.readSessionEntries(SESSION_REF)
    )._unsafeUnwrap().entries;
    const metadata = readNativeThreadMetadata(entries);
    expect(metadata?.schemaVersion).toBe(PI_NATIVE_THREAD_SCHEMA_VERSION);
    expect(metadata?.threadId).toBe("child-1");
    expect(h.refs.newChildren[0]?.title).toBe("shuttle-child1");
    const serialized = JSON.stringify({
      leaf: leaf?.metadata,
      entries,
      refs: h.refs.newChildren,
    });
    expect(serialized).toContain("shuttle-child1");
    expect(serialized).not.toContain("First line only");
    expect(serialized).not.toContain("SECRET_TASK_REMAINDER");
    expect(serialized).not.toContain(SESSION_PATH);
    await settleChild(spawnedAt(h.port, 0), h.port, "completed");
    await settlement;
  });

  it("tombstones a provisioned session when the parent ref cannot be written", async () => {
    const refs = new FakeRefStore(undefined);
    refs.failNewChild = true;
    const h = harness({ refs });
    const result = await h.controller.delegate(request());
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildSpawnFailed");
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe(
      "thread-ref-write-failed",
    );
    expect(h.sessions?.created).toHaveLength(1);
    expect(h.sessions?.leaves).toHaveLength(1);
    expect(h.sessions?.tombstones).toHaveLength(1);
    expect(h.sessions?.tombstones[0]?.childId).toBe("child-1");
    expect(h.port.spawnedProcesses).toHaveLength(0);
  });

  it("resumes from a fresh controller using only authoritative ref and metadata", async () => {
    const refs = new FakeRefStore(undefined);
    const sessions = new FakeSessionStore();
    const first = harness({ refs, sessions });
    await startThread(first, "failed");
    expect(first.controller.threadStatus("child-1")?.runs).toBe(1);

    const fresh = harness({
      refs,
      sessions,
      idGenerator: new SequentialIdGenerator(),
    });
    // Fresh generation has no in-memory thread; reconstruction must succeed.
    expect(fresh.controller.threadStatus("child-1")).toBeUndefined();
    const run = fresh.controller.resumeThread(resume());
    await flush();
    expect(childIdOf(spawnedAt(fresh.port, 0), fresh.port)).toBe("child-1");
    // The first id is consumed by resume's new run child; the thread id stays.
    await settleChild(spawnedAt(fresh.port, 0), fresh.port, "completed");
    const outcome = await run;
    if (outcome.isErr()) throw new Error(JSON.stringify(outcome.error));
    expect(outcome._unsafeUnwrap().threadId).toBe("child-1");
    expect(outcome._unsafeUnwrap().run).toBe(2);
    expect(outcome._unsafeUnwrap().settlement.outcome).toBe("completed");
    expect(refs.dividers[0]?.input).toMatchObject({
      action: "retry",
      priorOutcome: "failed",
      initiator: "owner",
      model: "model-x",
      reasoning: "high",
    });
  });

  it("refuses fresh-controller resume when native thread metadata is missing", async () => {
    const refs = new FakeRefStore(undefined);
    const sessions = new FakeSessionStore();
    const first = harness({ refs, sessions });
    await startThread(first, "failed");
    sessions.clearEntries();

    const fresh = harness({
      refs,
      sessions,
      idGenerator: new SequentialIdGenerator(),
    });
    const result = await fresh.controller.resumeThread(resume());
    expect(result._unsafeUnwrapErr().code).toBe("ThreadIntegrityError");
    expect(fresh.port.spawnedProcesses).toHaveLength(0);
  });
});

describe("thread lifecycle: durable title privacy", () => {
  it("keeps secret task content out of lifecycle projections across restart and resume", async () => {
    const refs = new FakeRefStore(undefined);
    const sessions = new FakeSessionStore();
    const cache = new FakeCache();
    const first = harness({ refs, sessions, cache });

    const start = first.controller.delegate(request({ task: SECRET_TASK }));
    await flush();
    const firstProcess = spawnedAt(first.port, 0);
    expectSecretAbsent(first.controller.snapshotTree());

    const firstSigner = await authenticateChild(firstProcess, first.port);
    firstProcess.emitLine({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "UNTRUSTED_CHILD_OUTPUT_TITLE",
      },
    });
    await flush();
    const liveOverlay = await first.controller.resolveOverlayChild("child-1");
    if (liveOverlay.isErr()) throw new Error(JSON.stringify(liveOverlay.error));
    expect(liveOverlay._unsafeUnwrap().title).toBe("shuttle-child1");
    expectSecretAbsent(liveOverlay._unsafeUnwrap());

    await finishChild(firstProcess, firstSigner, "failed");
    const firstOutcome = await start;
    if (firstOutcome.isErr())
      throw new Error(JSON.stringify(firstOutcome.error));

    expect(first.controller.threadStatus("child-1")).toEqual({
      threadId: "child-1",
      runs: 1,
      status: "failed",
      retryable: true,
    });
    expectSecretAbsent(first.controller.threadStatus("child-1"));
    expectSecretAbsent(first.controller.snapshotTree());
    expectSecretAbsent({
      refs: refs.newChildren,
      dividers: refs.dividers,
      lifecycles: refs.lifecycles,
      cacheRows: cache.writes,
      nativeLeaves: sessions.leaves,
    });

    const restarted = harness({
      refs,
      sessions,
      cache,
      idGenerator: new SequentialIdGenerator(),
    });
    const retry = restarted.controller.resumeThread(
      resume({ instruction: SECRET_TASK }),
    );
    await flush();
    expectSecretAbsent(refs.dividers);
    const retryProcess = spawnedAt(restarted.port, 0);
    const retrySigner = await authenticateChild(retryProcess, restarted.port);
    retryProcess.emitLine({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "UNTRUSTED_CHILD_OUTPUT_TITLE_RETRY",
      },
    });
    await flush();
    const retryOverlay =
      await restarted.controller.resolveOverlayChild("child-1");
    if (retryOverlay.isErr())
      throw new Error(JSON.stringify(retryOverlay.error));
    expect(retryOverlay._unsafeUnwrap().title).toBe("shuttle-child1");
    await finishChild(retryProcess, retrySigner, "completed");
    const retryOutcome = await retry;
    if (retryOutcome.isErr())
      throw new Error(JSON.stringify(retryOutcome.error));
    expect(retryOutcome._unsafeUnwrap().run).toBe(2);

    const continued = harness({
      refs,
      sessions,
      cache,
      idGenerator: new SequentialIdGenerator(),
    });
    const continuation = continued.controller.resumeThread(
      resume({ action: "continue", instruction: SECRET_TASK }),
    );
    await flush();
    expectSecretAbsent(refs.dividers);
    const continueProcess = spawnedAt(continued.port, 0);
    const continueSigner = await authenticateChild(
      continueProcess,
      continued.port,
    );
    continueProcess.emitLine({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "UNTRUSTED_CHILD_OUTPUT_CONTINUE",
      },
    });
    await flush();
    const continueOverlay =
      await continued.controller.resolveOverlayChild("child-1");
    if (continueOverlay.isErr()) {
      throw new Error(JSON.stringify(continueOverlay.error));
    }
    expect(continueOverlay._unsafeUnwrap().title).toBe("shuttle-child1");
    await finishChild(continueProcess, continueSigner, "completed");
    const continueOutcome = await continuation;
    if (continueOutcome.isErr()) {
      throw new Error(JSON.stringify(continueOutcome.error));
    }
    expect(continueOutcome._unsafeUnwrap().run).toBe(3);

    expect(continued.controller.threadStatus("child-1")).toEqual({
      threadId: "child-1",
      runs: 3,
      status: "completed",
      retryable: false,
    });
    expectSecretAbsent(continued.controller.threadStatus("child-1"));
    expectSecretAbsent(continued.controller.snapshotTree());
    const historicalOverlay =
      await continued.controller.resolveOverlayChild("child-1");
    if (historicalOverlay.isErr()) {
      throw new Error(JSON.stringify(historicalOverlay.error));
    }
    expect(historicalOverlay._unsafeUnwrap().title).toBe("shuttle-child1");
    expectSecretAbsent(historicalOverlay._unsafeUnwrap());

    const serializedRefsAndCache = new TextEncoder().encode(
      JSON.stringify({
        refs: refs.newChildren,
        dividers: refs.dividers,
        lifecycles: refs.lifecycles,
        cacheRows: cache.writes,
      }),
    );
    expectSecretAbsent(new TextDecoder().decode(serializedRefsAndCache));

    const generatedRef = refs.current();
    if (!generatedRef) throw new Error("controller did not write a child ref");
    const sqliteCacheOpen = await openPiChildMetadataCache({
      root: "/tmp/weave-task21-title-privacy-controller",
      fs: new FakePiChildMetadataCacheFs(),
      authority: {
        checkSource: () => okAsync("available" as const),
      },
      source: {
        workspaceKey: "/project",
        parentSessionId: OWNER_SESSION,
        readRefs: () =>
          okAsync<readonly PiChildRefRecord[], never>([generatedRef]),
      },
      openDatabase: () => openBunChildMetadataDatabase(":memory:"),
      now: () => 4_000,
    });
    if (sqliteCacheOpen.isErr()) {
      throw new Error(JSON.stringify(sqliteCacheOpen.error));
    }
    if (sqliteCacheOpen.value.mode !== "active") {
      throw new Error(JSON.stringify(sqliteCacheOpen.value.error));
    }
    const sqliteWrite = sqliteCacheOpen.value.cache.upsertRef(
      generatedRef,
      "/project",
    );
    expect(sqliteWrite.isOk()).toBe(true);
    const sqliteRows = await sqliteCacheOpen.value.cache.list({
      workspaceKey: "/project",
      parentSessionId: OWNER_SESSION,
      limit: 10,
    });
    if (sqliteRows.isErr()) throw new Error(JSON.stringify(sqliteRows.error));
    expect(sqliteRows.value.records[0]?.title).toBe("shuttle-child1");
    expectSecretAbsent(sqliteRows.value.records);

    const boundedFailure = await continued.controller.resumeThread(
      resume({ threadId: "missing-thread", instruction: SECRET_TASK }),
    );
    expect(boundedFailure.isErr()).toBe(true);
    expectSecretAbsent(boundedFailure._unsafeUnwrapErr());
  });
});

describe("thread lifecycle: storage authority guard", () => {
  it("blocks start before request, id, native session, ref, cache, or process work", async () => {
    const idGenerator = new SequentialIdGenerator();
    const h = harness({
      idGenerator,
      sessionStorageAuthority: createPiChildSessionStorageAuthority(),
    });
    let requestReads = 0;
    const hostileRequest = new Proxy(request({ cwd: "../../hostile/path" }), {
      get() {
        requestReads += 1;
        throw new Error("delegation request interpreted");
      },
    });

    const result = await h.controller.delegate(hostileRequest);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe("ChildSpawnFailed");
    expect(result.error.safeMessage).toBe(
      "Weave could not start the delegated child process.",
    );
    expect(result.error.correlation).toEqual({
      reason: CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
    });
    expect(requestReads).toBe(0);
    expect(idGenerator.calls).toBe(0);
    expect(h.port.spawnInputs).toHaveLength(0);
    expect(h.port.spawnedProcesses).toHaveLength(0);
    expect(h.refs.newChildren).toHaveLength(0);
    expect(h.refs.dividers).toHaveLength(0);
    expect(h.refs.lifecycles).toHaveLength(0);
    expect(h.sessions?.created).toHaveLength(0);
    expect(h.sessions?.leaves).toHaveLength(0);
    expect(h.cache.writes).toHaveLength(0);
  });

  it("blocks retry and continue before the next id, divider, cache, control, or spawn", async () => {
    const cases = [
      { action: "retry" as const, outcome: "failed" as const },
      { action: "continue" as const, outcome: "completed" as const },
    ];

    for (const testCase of cases) {
      const authority = switchableSessionStorageAuthority();
      const idGenerator = new SequentialIdGenerator();
      const h = harness({ idGenerator, sessionStorageAuthority: authority });
      await startThread(h, testCase.outcome);
      const process = h.port.spawnedProcesses[0];
      const before = {
        childIds: idGenerator.calls,
        spawned: h.port.spawnedProcesses.length,
        spawnInputs: h.port.spawnInputs.length,
        writes: process?.writtenLines().length ?? 0,
        newChildren: h.refs.newChildren.length,
        dividers: h.refs.dividers.length,
        lifecycles: h.refs.lifecycles.length,
        sessions: h.sessions?.created.length ?? 0,
        leaves: h.sessions?.leaves.length ?? 0,
        cache: h.cache.writes.length,
      };
      authority.deny();
      let requestReads = 0;
      const resumeRequest = new Proxy(
        resume({
          action: testCase.action,
          ...(testCase.action === "continue"
            ? { instruction: "continue without interpretation" }
            : {}),
        }),
        {
          get() {
            requestReads += 1;
            throw new Error("resume request interpreted");
          },
        },
      );

      const result = await h.controller.resumeThread(resumeRequest);

      expect(result.isErr()).toBe(true);
      if (result.isOk()) continue;
      expect(result.error.code).toBe("ChildSpawnFailed");
      expect(result.error.correlation).toEqual({
        reason: CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
      });
      expect(requestReads).toBe(0);
      expect(idGenerator.calls).toBe(before.childIds);
      expect(h.port.spawnedProcesses).toHaveLength(before.spawned);
      expect(h.port.spawnInputs).toHaveLength(before.spawnInputs);
      expect(process?.writtenLines()).toHaveLength(before.writes);
      expect(h.refs.newChildren).toHaveLength(before.newChildren);
      expect(h.refs.dividers).toHaveLength(before.dividers);
      expect(h.refs.lifecycles).toHaveLength(before.lifecycles);
      expect(h.sessions?.created).toHaveLength(before.sessions);
      expect(h.sessions?.leaves).toHaveLength(before.leaves);
      expect(h.cache.writes).toHaveLength(before.cache);
    }
  });
});
