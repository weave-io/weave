import { describe, expect, it } from "bun:test";
import { ok, ResultAsync } from "neverthrow";
import {
  generateNonceHex,
  type HmacError,
  type HmacPort,
  hexToBytes,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import { WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { type PiControlKind, signEnvelope } from "../child-envelope.js";
import { MAX_NATIVE_RECORD_BYTES } from "../child-framing.js";
import { encodeTransferChunks } from "../child-transfer.js";
import type { PiChildTreeNode } from "../child-tree.js";
import {
  encodePromptChunks,
  PROMPT_CHUNK_COMMAND,
  PromptChunkAssembler,
  parsePromptChunk,
} from "../prompt-chunking.js";
import {
  type PiChildSessionObserver,
  type PiExtensionUiResponseInput,
  PiRpcChild,
  type PiRpcChildSpawnInput,
} from "../rpc-child.js";
import type { JsonValue } from "../strict-json.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function baseSpawnInput(
  overrides: Partial<PiRpcChildSpawnInput> = {},
): PiRpcChildSpawnInput {
  return {
    childId: "child-1",
    parentId: "root",
    generationId: "gen-1",
    agentName: "shuttle",
    depth: 1,
    cwd: "/project",
    env: {},
    task: "do the thing",
    ...overrides,
  };
}

/**
 * A schema-valid bootstrap body (Pi adapter contract): every test that
 * exercises `runTask()` beyond the bootstrap-ack wait itself needs one,
 * since `runTask()` now re-parses its own `bootstrap` argument up front
 * and fails closed on anything malformed - these tests are not testing
 * that particular gate, so they get a valid fixture by default.
 */
function validBootstrap(overrides: Record<string, unknown> = {}): JsonValue {
  return {
    mode: "ordinary",
    agentName: "shuttle",
    composedPrompt: "You are Shuttle.",
    models: [],
    correlationId: "child-1",
    context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
    ...overrides,
  } as JsonValue;
}

/** A schema-valid bootstrap-ack body (Pi adapter contract) - `runTask()` validates it against the `bootstrap` it sent before proceeding to task work. */
function validAck(overrides: Record<string, unknown> = {}): JsonValue {
  return { ...overrides } as JsonValue;
}

/**
 * The parent-observed terminal assistant response the child result contract
 * requires (Pi adapter contract §10). A completed settlement without one is
 * `ChildResponseMissing`, so every test whose subject is something else emits
 * this first.
 */
function terminalAssistantMessage(text = "final answer"): JsonValue {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

/** Plays the part of a well-behaved (or malicious, per test) child process. */
class ScriptedChildResponder {
  private sequence = 1;

  constructor(
    private readonly process: FakeSpawnedProcess,
    private readonly childId: string,
    private readonly generationId: string,
  ) {}

  async send(
    kind: PiControlKind,
    correlationId: string,
    body: JsonValue,
    secretBytes: Uint8Array,
    sequenceOverride?: number,
  ) {
    const sequence = sequenceOverride ?? this.sequence++;
    const envelope = await signEnvelope(
      {
        childId: this.childId,
        generationId: this.generationId,
        direction: "child-to-parent",
        sequence,
        nonce: generateNonceHex(randomPort),
        correlationId,
        kind,
        body,
      },
      secretBytes,
      hmacPort,
    );
    if (envelope.isErr())
      throw new Error(`test setup failed to sign: ${envelope.error.type}`);
    this.process.emitLine(envelope.value);
    return envelope.value;
  }
}

/**
 * Wraps a real `HmacPort` but artificially delays only its `signHex`
 * (the parent's own *outbound* signing), leaving `verifyHex` (verifying
 * the child's incoming replies) untouched. Used to construct a
 * deterministic "the child replies faster than our own outbound signing
 * finishes" race, proving the resolver is installed *before* the send
 * rather than after it (install-before-send composition).
 */
class DelayedSignHmacPort implements HmacPort {
  constructor(
    private readonly inner: HmacPort,
    private readonly delayMs: number,
  ) {}

  signHex(key: Uint8Array, data: Uint8Array): ResultAsync<string, HmacError> {
    return new ResultAsync(
      new Promise((resolve) => {
        setTimeout(() => {
          this.inner.signHex(key, data).then(resolve);
        }, this.delayMs);
      }),
    );
  }

  verifyHex(
    key: Uint8Array,
    data: Uint8Array,
    expectedMacHex: string,
  ): ResultAsync<boolean, HmacError> {
    return this.inner.verifyHex(key, data, expectedMacHex);
  }
}

/** Fires only live-reply timers synchronously, exposing map-install races. */
class ImmediateReplyTimerPort {
  schedule(callback: () => void, delayMs: number) {
    if (delayMs === 1) callback();
    return { cancel() {} };
  }
}

function flushMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSecretFromSpawn(port: FakeChildProcessPort): Uint8Array {
  const hex = port.spawnInputs.at(-1)?.env[WEAVE_CHILD_SECRET_ENV];
  if (hex === undefined) throw new Error("test setup: secret env missing");
  const bytes = hexToBytes(hex);
  if (bytes === undefined) throw new Error("test setup: malformed secret hex");
  return bytes;
}

/** Real WebCrypto signing resolves across more than one microtask tick; a macrotask boundary reliably flushes it. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A timer captured from an injected `timerPort`, fired only on demand. */
interface ScheduledTestTimer {
  readonly fire: () => void;
  cancelled: boolean;
}

interface TestDeferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

/**
 * Injected synchronization point for tests that must act at one exact moment
 * in an asynchronous production path. Resolving is idempotent, so a seam that
 * fires more than once still yields the first observation.
 */
function createDeferred<T>(): TestDeferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      const resolver = settle;
      settle = undefined;
      resolver?.(value);
    },
  };
}

/**
 * Awaits the exact observable state an assertion needs instead of guessing a
 * fixed number of `flush()` ticks. Envelope signing and verification use real
 * WebCrypto and outgoing writes are serialized on a send tail, so the number of
 * macrotasks before an effect lands varies with host load; under a loaded CI
 * runner a fixed tick count is a timing race, not a wait. The bound keeps a
 * genuinely stuck path a fast, diagnosable failure rather than a hang.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  description = "asynchronous event",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`test setup: timed out waiting for ${description}`);
    }
    await flushMs(1);
  }
}

function extractControlEnvelopeFromPrompt(line: unknown): JsonValue {
  const record = line as { type: string; message: string };
  expect(record.type).toBe("prompt");
  const prefix = "/weave:__control__ ";
  expect(record.message.startsWith(prefix)).toBe(true);
  return JSON.parse(record.message.slice(prefix.length));
}

type SpawnSession = NonNullable<PiRpcChildSpawnInput["session"]>;

async function startRestoreChild(
  deps: Partial<ConstructorParameters<typeof PiRpcChild>[5]> = {},
  session: SpawnSession = {
    mode: "restore",
    sessionDir: "/tmp/weave-sessions",
    sessionPath: "/tmp/weave-sessions/child-1.jsonl",
    activeLeafId: "leaf-restore",
    checkpointCursor: 42,
  },
): Promise<{
  child: PiRpcChild;
  processPort: FakeChildProcessPort;
  spawned: FakeSpawnedProcess;
  responder: ScriptedChildResponder;
  secretBytes: Uint8Array;
  runPromise: ReturnType<PiRpcChild["runTask"]>;
}> {
  const processPort = new FakeChildProcessPort();
  const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
    ...deps,
    processPort,
    randomPort,
    hmacPort,
    logger: noopLogger(),
  });
  const input = baseSpawnInput({ session });
  const spawnPromise = child.spawnAndHandshake(input);
  await flush();
  const spawned = processPort.spawnedProcesses[0];
  if (spawned === undefined) throw new Error("test setup: child not spawned");
  const secretBytes = extractSecretFromSpawn(processPort);
  const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
  await responder.send("handshake", "child-1", {}, secretBytes);
  expect((await spawnPromise).isOk()).toBe(true);
  const runPromise = child.runTask(input, validBootstrap());
  await flush();
  await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
  await flush();
  return { child, processPort, spawned, responder, secretBytes, runPromise };
}

/** The startup state entries Pi 0.83 appends to a restored session on boot. */
function piStartupSuffixEntries(): readonly Record<string, unknown>[] {
  return [
    {
      type: "model_change",
      id: "startup-model",
      parentId: "leaf-restore",
      timestamp: "2026-08-05T00:00:00.000Z",
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
    },
    {
      type: "thinking_level_change",
      id: "startup-thinking",
      parentId: "startup-model",
      timestamp: "2026-08-05T00:00:01.000Z",
      thinkingLevel: "medium",
    },
  ];
}

/** Drives a restore child to its `get_entries` probe and answers it once. */
async function respondToRestoreVerification(data: {
  readonly entries: readonly unknown[];
  readonly leafId: unknown;
}): Promise<{
  running: Awaited<ReturnType<typeof startRestoreChild>>;
  observed: unknown[];
}> {
  const observed: unknown[] = [];
  const running = await startRestoreChild({
    onRestoreContextVerified: (metadata) => {
      observed.push(metadata);
      return ok(undefined);
    },
  });
  await waitFor(() =>
    running.spawned
      .writtenLines()
      .some((line) => (line as Record<string, unknown>).type === "get_entries"),
  );
  const getEntries = running.spawned.writtenLines().at(-1) as Record<
    string,
    unknown
  >;
  running.spawned.emitLine({
    id: getEntries.id,
    type: "response",
    command: "get_entries",
    success: true,
    data: { entries: data.entries, leafId: data.leafId },
  });
  return { running, observed };
}

async function startRunningChild(
  deps: Partial<ConstructorParameters<typeof PiRpcChild>[5]> = {},
): Promise<{
  child: PiRpcChild;
  processPort: FakeChildProcessPort;
  spawned: FakeSpawnedProcess;
  responder: ScriptedChildResponder;
  secretBytes: Uint8Array;
  runPromise: ReturnType<PiRpcChild["runTask"]>;
}> {
  const processPort = new FakeChildProcessPort();
  const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
    ...deps,
    processPort,
    randomPort,
    hmacPort,
    logger: noopLogger(),
  });
  const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
  await flush();
  const spawned = processPort.spawnedProcesses[0];
  if (spawned === undefined) throw new Error("test setup: child not spawned");
  const secretBytes = extractSecretFromSpawn(processPort);
  const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
  await responder.send("handshake", "child-1", {}, secretBytes);
  expect((await spawnPromise).isOk()).toBe(true);
  const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
  await flush();
  await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
  await flush();
  return { child, processPort, spawned, responder, secretBytes, runPromise };
}

describe("PiRpcChild", () => {
  it("verifies restore context before task content and exposes only bounded metadata", async () => {
    const observed: unknown[] = [];
    const running = await startRestoreChild({
      onRestoreContextVerified: (metadata) => {
        observed.push(metadata);
        return ok(undefined);
      },
    });

    await waitFor(() =>
      running.spawned
        .writtenLines()
        .some(
          (line) => (line as Record<string, unknown>).type === "get_entries",
        ),
    );
    const linesBeforeVerification = running.spawned.writtenLines();
    const getEntriesIndex = linesBeforeVerification.findIndex(
      (line) => (line as Record<string, unknown>).type === "get_entries",
    );
    const getEntries = linesBeforeVerification[getEntriesIndex] as Record<
      string,
      unknown
    >;
    expect(getEntries).toMatchObject({
      type: "get_entries",
      since: "leaf-restore",
    });
    expect(getEntries.since).not.toBe(42);
    expect(
      linesBeforeVerification.some(
        (line) => (line as Record<string, unknown>).message === "do the thing",
      ),
    ).toBe(false);

    running.spawned.emitLine({
      id: getEntries.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: "leaf-restore" },
    });
    await waitFor(() =>
      running.spawned
        .writtenLines()
        .some(
          (line) =>
            (line as Record<string, unknown>).message === "do the thing",
        ),
    );

    expect(observed).toEqual([
      { activeLeafId: "leaf-restore", checkpointCursor: 42 },
    ]);
    expect(observed[0]).not.toHaveProperty("sessionPath");
    expect(JSON.stringify(observed)).not.toContain("/tmp/weave-sessions");
    const taskIndex = running.spawned
      .writtenLines()
      .findIndex(
        (line) => (line as Record<string, unknown>).message === "do the thing",
      );
    expect(taskIndex).toBeGreaterThan(getEntriesIndex);

    running.child.dispose();
    expect((await running.runPromise).isErr()).toBe(true);
  });

  it("fails closed on a restore leaf mismatch without sending task content", async () => {
    const observed: unknown[] = [];
    const running = await startRestoreChild({
      onRestoreContextVerified: (metadata) => {
        observed.push(metadata);
        return ok(undefined);
      },
    });
    await waitFor(() =>
      running.spawned
        .writtenLines()
        .some(
          (line) => (line as Record<string, unknown>).type === "get_entries",
        ),
    );
    const getEntries = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    running.spawned.emitLine({
      id: getEntries.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: "different-leaf" },
    });

    expect((await running.runPromise).isErr()).toBe(true);
    expect(observed).toEqual([]);
    expect(
      running.spawned
        .writtenLines()
        .some(
          (line) =>
            (line as Record<string, unknown>).message === "do the thing",
        ),
    ).toBe(false);
  });

  it("accepts the bounded Pi 0.83 startup state suffix appended after the established leaf", async () => {
    const observed: unknown[] = [];
    const running = await startRestoreChild({
      onRestoreContextVerified: (metadata) => {
        observed.push(metadata);
        return ok(undefined);
      },
    });
    await waitFor(() =>
      running.spawned
        .writtenLines()
        .some(
          (line) => (line as Record<string, unknown>).type === "get_entries",
        ),
    );
    const getEntriesIndex = running.spawned
      .writtenLines()
      .findIndex(
        (line) => (line as Record<string, unknown>).type === "get_entries",
      );
    const getEntries = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    expect(
      running.spawned
        .writtenLines()
        .some(
          (line) =>
            (line as Record<string, unknown>).message === "do the thing",
        ),
    ).toBe(false);

    running.spawned.emitLine({
      id: getEntries.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: {
        entries: piStartupSuffixEntries(),
        leafId: "startup-thinking",
      },
    });

    await waitFor(() =>
      running.spawned
        .writtenLines()
        .some(
          (line) =>
            (line as Record<string, unknown>).message === "do the thing",
        ),
    );
    // The observer still sees the established leaf, never the Pi-owned suffix.
    expect(observed).toEqual([
      { activeLeafId: "leaf-restore", checkpointCursor: 42 },
    ]);
    const taskIndex = running.spawned
      .writtenLines()
      .findIndex(
        (line) => (line as Record<string, unknown>).message === "do the thing",
      );
    expect(taskIndex).toBeGreaterThan(getEntriesIndex);

    running.child.dispose();
    expect((await running.runPromise).isErr()).toBe(true);
  });

  it("accepts a single startup state entry and a retried restore identically", async () => {
    for (const entries of [
      [piStartupSuffixEntries()[0]],
      piStartupSuffixEntries(),
    ]) {
      const leafId = (entries.at(-1) as Record<string, unknown>).id;
      const verified = await respondToRestoreVerification({
        entries,
        leafId,
      });
      await waitFor(() =>
        verified.running.spawned
          .writtenLines()
          .some(
            (line) =>
              (line as Record<string, unknown>).message === "do the thing",
          ),
      );
      expect(verified.observed).toEqual([
        { activeLeafId: "leaf-restore", checkpointCursor: 42 },
      ]);
      verified.running.child.dispose();
      expect((await verified.running.runPromise).isErr()).toBe(true);
    }
  });

  it("accepts the exact four-entry startup suffix observed in the real Pi 0.83 harness", async () => {
    const timestamp = "2026-08-05T00:00:00.000Z";
    // Pane w23:p8Q observed: custom metadata leaf, then model_change,
    // thinking_level_change, model_change, thinking_level_change.
    const entries = [
      {
        type: "model_change",
        id: "startup-model-1",
        parentId: "leaf-restore",
        timestamp,
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
      },
      {
        type: "thinking_level_change",
        id: "startup-thinking-1",
        parentId: "startup-model-1",
        timestamp,
        thinkingLevel: "medium",
      },
      {
        type: "model_change",
        id: "startup-model-2",
        parentId: "startup-thinking-1",
        timestamp,
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
      },
      {
        type: "thinking_level_change",
        id: "startup-thinking-2",
        parentId: "startup-model-2",
        timestamp,
        thinkingLevel: "high",
      },
    ];
    const verified = await respondToRestoreVerification({
      entries,
      leafId: "startup-thinking-2",
    });
    await waitFor(() =>
      verified.running.spawned
        .writtenLines()
        .some(
          (line) =>
            (line as Record<string, unknown>).message === "do the thing",
        ),
    );
    expect(verified.observed).toEqual([
      { activeLeafId: "leaf-restore", checkpointCursor: 42 },
    ]);
    verified.running.child.dispose();
    expect((await verified.running.runPromise).isErr()).toBe(true);
  });

  it("fails closed on forbidden, malformed, disconnected, cyclic, or excessive restore suffixes", async () => {
    const timestamp = "2026-08-05T00:00:00.000Z";
    const cases: readonly {
      readonly name: string;
      readonly entries: readonly unknown[];
      readonly leafId: unknown;
      readonly reason: string;
    }[] = [
      {
        name: "message entry",
        entries: [
          {
            type: "message",
            id: "startup-message",
            parentId: "leaf-restore",
            timestamp,
            message: { role: "user", content: "leaked task" },
          },
        ],
        leafId: "startup-message",
        reason: "restore-startup-suffix-forbidden-kind",
      },
      {
        name: "custom entry",
        entries: [
          {
            type: "custom",
            id: "startup-custom",
            parentId: "leaf-restore",
            timestamp,
            customType: "weave.child.thread",
            data: { spoofed: true },
          },
        ],
        leafId: "startup-custom",
        reason: "restore-startup-suffix-forbidden-kind",
      },
      {
        name: "custom_message entry",
        entries: [
          {
            type: "custom_message",
            id: "startup-custom-message",
            parentId: "leaf-restore",
            timestamp,
            customType: "tool",
            content: "tool output",
            display: true,
          },
        ],
        leafId: "startup-custom-message",
        reason: "restore-startup-suffix-forbidden-kind",
      },
      {
        name: "compaction entry",
        entries: [
          {
            type: "compaction",
            id: "startup-compaction",
            parentId: "leaf-restore",
            timestamp,
            summary: "compacted",
            firstKeptEntryId: "leaf-restore",
            tokensBefore: 10,
          },
        ],
        leafId: "startup-compaction",
        reason: "restore-startup-suffix-forbidden-kind",
      },
      {
        name: "branch_summary entry",
        entries: [
          {
            type: "branch_summary",
            id: "startup-branch",
            parentId: "leaf-restore",
            timestamp,
            fromId: "leaf-restore",
            summary: "branched",
          },
        ],
        leafId: "startup-branch",
        reason: "restore-startup-suffix-forbidden-kind",
      },
      {
        name: "label entry",
        entries: [
          {
            type: "label",
            id: "startup-label",
            parentId: "leaf-restore",
            timestamp,
            targetId: "leaf-restore",
            label: "x",
          },
        ],
        leafId: "startup-label",
        reason: "restore-startup-suffix-forbidden-kind",
      },
      {
        name: "session_info entry",
        entries: [
          {
            type: "session_info",
            id: "startup-session-info",
            parentId: "leaf-restore",
            timestamp,
            name: "child",
          },
        ],
        leafId: "startup-session-info",
        reason: "restore-startup-suffix-forbidden-kind",
      },
      {
        name: "disconnected parent",
        entries: [
          {
            type: "model_change",
            id: "startup-model",
            parentId: "some-other-leaf",
            timestamp,
            provider: "openai-codex",
            modelId: "gpt-5.6-luna",
          },
        ],
        leafId: "startup-model",
        reason: "restore-startup-suffix-disconnected",
      },
      {
        name: "null parent",
        entries: [
          {
            type: "model_change",
            id: "startup-model",
            parentId: null,
            timestamp,
            provider: "openai-codex",
            modelId: "gpt-5.6-luna",
          },
        ],
        leafId: "startup-model",
        reason: "restore-startup-suffix-disconnected",
      },
      {
        name: "broken chain in the middle",
        entries: [
          {
            type: "model_change",
            id: "startup-model",
            parentId: "leaf-restore",
            timestamp,
            provider: "openai-codex",
            modelId: "gpt-5.6-luna",
          },
          {
            type: "thinking_level_change",
            id: "startup-thinking",
            parentId: "leaf-restore",
            timestamp,
            thinkingLevel: "medium",
          },
        ],
        leafId: "startup-thinking",
        reason: "restore-startup-suffix-disconnected",
      },
      {
        name: "cyclic repeated id",
        entries: [
          {
            type: "model_change",
            id: "startup-model",
            parentId: "leaf-restore",
            timestamp,
            provider: "openai-codex",
            modelId: "gpt-5.6-luna",
          },
          {
            type: "thinking_level_change",
            id: "startup-model",
            parentId: "startup-model",
            timestamp,
            thinkingLevel: "medium",
          },
        ],
        leafId: "startup-model",
        reason: "restore-startup-suffix-cycle",
      },
      {
        name: "self-parented established leaf",
        entries: [
          {
            type: "model_change",
            id: "leaf-restore",
            parentId: "leaf-restore",
            timestamp,
            provider: "openai-codex",
            modelId: "gpt-5.6-luna",
          },
        ],
        leafId: "leaf-restore",
        reason: "restore-startup-suffix-cycle",
      },
      {
        name: "excessive suffix",
        entries: Array.from({ length: 7 }, (_unused, index) => ({
          type: "thinking_level_change",
          id: `startup-${index}`,
          parentId: index === 0 ? "leaf-restore" : `startup-${index - 1}`,
          timestamp,
          thinkingLevel: "medium",
        })),
        leafId: "startup-6",
        reason: "restore-startup-suffix-too-large",
      },
      {
        name: "suffix that does not reach the reported leaf",
        entries: piStartupSuffixEntries(),
        leafId: "foreign-leaf",
        reason: "restore-active-leaf-mismatch",
      },
      {
        name: "empty suffix with a moved leaf",
        entries: [],
        leafId: "different-leaf",
        reason: "restore-active-leaf-mismatch",
      },
      {
        name: "null leaf with a suffix",
        entries: piStartupSuffixEntries(),
        leafId: null,
        reason: "restore-active-leaf-mismatch",
      },
    ];

    for (const testCase of cases) {
      const rejected = await respondToRestoreVerification({
        entries: testCase.entries,
        leafId: testCase.leafId,
      });
      const outcome = await rejected.running.runPromise;
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect({
          name: testCase.name,
          code: outcome.error.code,
          reason: outcome.error.correlation?.reason,
        }).toEqual({
          name: testCase.name,
          code: "ChildAuthenticationFailed",
          reason: testCase.reason,
        });
      }
      expect(rejected.observed).toEqual([]);
      expect(
        rejected.running.spawned
          .writtenLines()
          .some(
            (line) =>
              (line as Record<string, unknown>).message === "do the thing",
          ),
      ).toBe(false);
    }
  });

  it("fails closed when the child settles or exits during restore verification", async () => {
    for (const event of ["settled", "exit"] as const) {
      const running = await startRestoreChild();
      await waitFor(() =>
        running.spawned
          .writtenLines()
          .some(
            (line) => (line as Record<string, unknown>).type === "get_entries",
          ),
      );
      if (event === "settled") {
        await running.responder.send(
          "settled",
          "child-1",
          { outcome: "completed", assistantOutput: "done" },
          running.secretBytes,
        );
      } else {
        running.spawned.exit(23);
      }
      expect((await running.runPromise).isErr()).toBe(true);
      expect(
        running.spawned
          .writtenLines()
          .some(
            (line) =>
              (line as Record<string, unknown>).message === "do the thing",
          ),
      ).toBe(false);
    }
  });

  it("fails closed when the restore observer rejects metadata", async () => {
    const running = await startRestoreChild({
      onRestoreContextVerified: () => {
        throw new Error("observer must not expose session content");
      },
    });
    await waitFor(() =>
      running.spawned
        .writtenLines()
        .some(
          (line) => (line as Record<string, unknown>).type === "get_entries",
        ),
    );
    const getEntries = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    running.spawned.emitLine({
      id: getEntries.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: "leaf-restore" },
    });

    expect((await running.runPromise).isErr()).toBe(true);
    expect(
      running.spawned
        .writtenLines()
        .some(
          (line) =>
            (line as Record<string, unknown>).message === "do the thing",
        ),
    ).toBe(false);
  });

  it("fails closed when restore get_entries fails, is malformed, or times out", async () => {
    const cases: readonly {
      response?: Readonly<Record<string, JsonValue>>;
      timeout?: boolean;
    }[] = [
      {
        response: {
          id: "placeholder",
          type: "response",
          command: "get_entries",
          success: false,
          error: "private failure",
        },
      },
      {
        response: {
          id: "placeholder",
          type: "response",
          command: "get_entries",
          success: true,
          data: { entries: "malformed", leafId: "leaf-restore" },
        },
      },
      { timeout: true },
    ];

    for (const testCase of cases) {
      const running = await startRestoreChild({
        replyTimeoutMs: testCase.timeout ? 5 : undefined,
      });
      await waitFor(() =>
        running.spawned
          .writtenLines()
          .some(
            (line) => (line as Record<string, unknown>).type === "get_entries",
          ),
      );
      if (testCase.response !== undefined) {
        const getEntries = running.spawned.writtenLines().at(-1) as Record<
          string,
          unknown
        >;
        running.spawned.emitLine({
          ...testCase.response,
          id: getEntries.id,
        });
      } else {
        await flushMs(20);
      }
      expect((await running.runPromise).isErr()).toBe(true);
      expect(
        running.spawned
          .writtenLines()
          .some(
            (line) =>
              (line as Record<string, unknown>).message === "do the thing",
          ),
      ).toBe(false);
    }
  });

  it("rejects restore input with an unknown active-leaf cursor before spawning", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const result = await child.spawnAndHandshake(
      baseSpawnInput({
        session: {
          mode: "restore",
          sessionDir: "/tmp/weave-sessions",
          sessionPath: "/tmp/weave-sessions/child-1.jsonl",
          activeLeafId: undefined as unknown as string,
        },
      }),
    );
    expect(result.isErr()).toBe(true);
    expect(processPort.spawnInputs).toHaveLength(0);
  });

  it("skips restore verification for ephemeral and new sessions", async () => {
    const sessions: readonly SpawnSession[] = [
      { mode: "ephemeral" },
      { mode: "new", sessionDir: "/tmp/weave-sessions" },
    ];
    for (const session of sessions) {
      const running =
        session.mode === "ephemeral"
          ? await startRunningChild()
          : await startRestoreChild({}, session);
      await flush();
      expect(
        running.spawned
          .writtenLines()
          .some(
            (line) => (line as Record<string, unknown>).type === "get_entries",
          ),
      ).toBe(false);
      expect(
        running.spawned
          .writtenLines()
          .some(
            (line) =>
              (line as Record<string, unknown>).message === "do the thing",
          ),
      ).toBe(true);
      running.spawned.emitLine(terminalAssistantMessage());
      await running.responder.send(
        "settled",
        "child-1",
        { outcome: "completed", assistantOutput: "done" },
        running.secretBytes,
      );
      expect((await running.runPromise).isOk()).toBe(true);
      running.child.dispose();
    }
  });

  it("passes the secret only via environment, never argv/prompt, and completes the handshake before returning", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });

    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    expect(spawned).toBeDefined();
    const spawnInput = processPort.spawnInputs[0];
    expect(spawnInput.command).toEqual(["pi", "--mode", "rpc", "--no-session"]);
    expect(Object.keys(spawnInput.env)).toContain(WEAVE_CHILD_SECRET_ENV);

    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);

    const result = await spawnPromise;
    expect(result.isOk()).toBe(true);
    // Handshake alone does not yet mean "running": the child must still
    // prove it applied the bootstrap descriptor via bootstrap-ack before
    // any work is sent (Pi adapter contract).
    expect(child.snapshot().status).toBe("handshaking");
  });

  it("builds the typed ephemeral, new, and restore session argv slices", async () => {
    const cases = [
      {
        session: { mode: "ephemeral" as const },
        command: ["pi", "--mode", "rpc", "--no-session"],
      },
      {
        session: {
          mode: "new" as const,
          sessionDir: "/tmp/weave-sessions",
        },
        command: [
          "pi",
          "--mode",
          "rpc",
          "--session-dir",
          "/tmp/weave-sessions",
        ],
      },
      {
        session: {
          mode: "restore" as const,
          sessionDir: "/tmp/weave-sessions",
          sessionPath: "/tmp/weave-sessions/child-1.jsonl",
          activeLeafId: "leaf-1",
          checkpointCursor: 7,
        },
        command: [
          "pi",
          "--mode",
          "rpc",
          "--session-dir",
          "/tmp/weave-sessions",
          "--session",
          "/tmp/weave-sessions/child-1.jsonl",
        ],
      },
    ] as const;

    for (const testCase of cases) {
      const processPort = new FakeChildProcessPort();
      const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
        processPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
      });
      const spawnPromise = child.spawnAndHandshake(
        baseSpawnInput({ session: testCase.session }),
      );
      await flush();
      expect(processPort.spawnInputs[0]?.command).toEqual(testCase.command);
      child.dispose();
      expect((await spawnPromise).isErr()).toBe(true);
    }
  });

  it("rejects unsafe session argv inputs before spawning", async () => {
    const invalidSessions: readonly PiRpcChildSpawnInput["session"][] = [
      { mode: "new", sessionDir: "relative/sessions" },
      { mode: "new", sessionDir: "/tmp/weave-sessions\0" },
      { mode: "new", sessionDir: "/tmp/weave-sessions/." },
      { mode: "new", sessionDir: "/tmp/weave-sessions/../other" },
      {
        mode: "restore",
        sessionDir: "/tmp/weave-sessions",
        sessionPath: "/tmp/weave-sessions/child.txt",
        activeLeafId: "leaf-1",
      },
      {
        mode: "restore",
        sessionDir: "/tmp/weave-sessions",
        sessionPath: "child-1.jsonl",
        activeLeafId: "leaf-1",
      },
      {
        mode: "restore",
        sessionDir: "/tmp/weave-sessions",
        sessionPath: "/tmp/weave-sessions-other/child-1.jsonl",
        activeLeafId: "leaf-1",
      },
      {
        mode: "restore",
        sessionDir: "/tmp/weave-sessions",
        sessionPath: "/tmp/weave-sessions/sub/../../child-1.jsonl",
        activeLeafId: "leaf-1",
      },
      {
        mode: "restore",
        sessionDir: "/tmp/weave-sessions",
        sessionPath: "/tmp/weave-sessions/child-1.jsonl",
        activeLeafId: "",
      },
      {
        mode: "restore",
        sessionDir: "/tmp/weave-sessions",
        sessionPath: "/tmp/weave-sessions/child-1.jsonl",
        activeLeafId: "leaf-1",
        checkpointCursor: -1,
      },
    ];

    for (const session of invalidSessions) {
      const processPort = new FakeChildProcessPort();
      const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
        processPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
      });
      const result = await child.spawnAndHandshake(baseSpawnInput({ session }));
      expect(result.isErr()).toBe(true);
      expect(processPort.spawnInputs).toHaveLength(0);
    }
  });

  it("rejects session flags already present in the base command before spawning", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      command: ["pi", "--mode", "rpc", "--resume=latest"],
    });

    const result = await child.spawnAndHandshake(baseSpawnInput());
    expect(result.isErr()).toBe(true);
    expect(processPort.spawnInputs).toHaveLength(0);
  });

  it("sends exact steer/follow_up commands and counts only accepted interventions", async () => {
    const counts: number[] = [];
    const running = await startRunningChild({
      onInterventionCountChanged: (count) => counts.push(count),
    });

    const steer = running.child.steer("child-1", "gen-1", "private steer text");
    await flush();
    const steerLine = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    expect(steerLine).toMatchObject({
      type: "steer",
      message: "private steer text",
      images: [],
    });
    expect(typeof steerLine.id).toBe("string");
    running.spawned.emitLine({
      id: steerLine.id,
      type: "response",
      command: "steer",
      success: true,
    });
    expect((await steer).isOk()).toBe(true);
    expect(running.child.getInterventionCount()).toBe(1);

    const followUp = running.child.followUp(
      "child-1",
      "gen-1",
      "private follow-up text",
    );
    await flush();
    const followLine = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    expect(followLine).toMatchObject({
      type: "follow_up",
      message: "private follow-up text",
      images: [],
    });
    running.spawned.emitLine({
      id: followLine.id,
      type: "response",
      command: "follow_up",
      success: true,
    });
    expect((await followUp).isOk()).toBe(true);
    expect(counts).toEqual([1, 2]);
    expect(JSON.stringify(counts)).not.toContain("private");
    running.child.dispose();
  });

  it("guards live RPCs by identity and running lifecycle, and validates get_entries", async () => {
    const queuedPort = new FakeChildProcessPort();
    const queued = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort: queuedPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    expect((await queued.steer("child-1", "gen-1", "not sent")).isErr()).toBe(
      true,
    );
    expect(queuedPort.spawnedProcesses).toHaveLength(0);

    const running = await startRunningChild();
    const before = running.spawned.writtenLines().length;
    expect(
      (await running.child.steer("wrong-child", "gen-1", "not sent")).isErr(),
    ).toBe(true);
    expect(
      (
        await running.child.followUp("child-1", "stale-generation", "not sent")
      ).isErr(),
    ).toBe(true);
    expect(running.spawned.writtenLines()).toHaveLength(before);

    const entries = running.child.getEntries("child-1", "gen-1", "leaf-1");
    await flush();
    const line = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    expect(line).toEqual({ id: line.id, type: "get_entries", since: "leaf-1" });
    running.spawned.emitLine({
      id: line.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: {
        entries: [
          {
            type: "message",
            id: "entry-1",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: "user", content: "bounded" },
          },
        ],
        leafId: "leaf-2",
      },
    });
    expect((await entries)._unsafeUnwrap()).toEqual({
      entries: [
        {
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "bounded" },
        },
      ],
      leafId: "leaf-2",
    });

    const malformed = running.child.getEntries("child-1", "gen-1");
    await flush();
    const malformedLine = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    running.spawned.emitLine({
      id: malformedLine.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: "not-an-array", leafId: null },
    });
    expect((await malformed).isErr()).toBe(true);
    running.child.dispose();
  });

  it("validates typed get_entries fields and bounds the complete response", async () => {
    const running = await startRunningChild();

    const malformed = running.child.getEntries("child-1", "gen-1");
    await flush();
    const malformedLine = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    running.spawned.emitLine({
      id: malformedLine.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: {
        entries: [
          {
            type: "message",
            id: "entry-1",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
        leafId: null,
      },
    });
    expect((await malformed).isErr()).toBe(true);

    const oversizedField = running.child.getEntries("child-1", "gen-1");
    await flush();
    const oversizedFieldLine = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    running.spawned.emitLine({
      id: oversizedFieldLine.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: {
        entries: [
          {
            type: "custom",
            id: "entry-2",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            customType: "test",
            data: "x".repeat(64 * 1024 + 1),
          },
        ],
        leafId: "entry-2",
      },
    });
    expect((await oversizedField).isErr()).toBe(true);

    const oversizedResponse = running.child.getEntries("child-1", "gen-1");
    await flush();
    const oversizedResponseLine = running.spawned
      .writtenLines()
      .at(-1) as Record<string, unknown>;
    running.spawned.emitLine({
      id: oversizedResponseLine.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: {
        entries: Array.from({ length: 256 }, (_, index) => ({
          type: "custom",
          id: `entry-${index}`,
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          customType: "test",
          data: "x".repeat(2048),
        })),
        leafId: "entry-255",
      },
    });
    expect((await oversizedResponse).isErr()).toBe(true);
    running.child.dispose();
  });

  it("rejects empty and byte-oversized intervention text before writing", async () => {
    const running = await startRunningChild();
    const before = running.spawned.writtenLines().length;

    expect((await running.child.steer("child-1", "gen-1", "")).isErr()).toBe(
      true,
    );
    expect(
      (
        await running.child.followUp("child-1", "gen-1", "💥".repeat(16_385))
      ).isErr(),
    ).toBe(true);
    expect(running.spawned.writtenLines()).toHaveLength(before);
    running.child.dispose();
  });

  it("installs a pending intervention before a synchronous reply timeout", async () => {
    const running = await startRunningChild({
      timerPort: new ImmediateReplyTimerPort(),
      replyTimeoutMs: 1,
    });
    const before = running.spawned.writtenLines().length;

    const result = await running.child.steer(
      "child-1",
      "gen-1",
      "timeout without a write",
    );

    expect(result.isErr()).toBe(true);
    expect(running.spawned.writtenLines()).toHaveLength(before);
    expect(running.child.getInterventionCount()).toBe(0);
    running.child.dispose();
  });

  it("does not count failed, malformed, mismatched, duplicate, or late responses", async () => {
    const counts: number[] = [];
    const running = await startRunningChild({
      onInterventionCountChanged: (count) => counts.push(count),
    });
    const failed = running.child.steer("child-1", "gen-1", "secret text");
    await flush();
    const line = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    running.spawned.emitLine({
      id: line.id,
      type: "response",
      command: "steer",
      success: false,
      error: "secret response error",
    });
    const failedResult = await failed;
    expect(failedResult.isErr()).toBe(true);
    expect(JSON.stringify(failedResult)).not.toContain("secret response error");
    running.spawned.emitLine({
      id: line.id,
      type: "response",
      command: "steer",
      success: true,
    });
    expect(running.child.getInterventionCount()).toBe(0);
    expect(counts).toEqual([]);
    expect(JSON.stringify(counts)).not.toContain("secret");

    const malformed = running.child.followUp(
      "child-1",
      "gen-1",
      "private malformed",
    );
    await flush();
    const malformedLine = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    running.spawned.emitLine({
      id: malformedLine.id,
      type: "response",
      command: "follow_up",
      success: "yes",
      error: "private malformed response",
    });
    const malformedResult = await malformed;
    expect(malformedResult.isErr()).toBe(true);
    expect(JSON.stringify(malformedResult)).not.toContain(
      "private malformed response",
    );
    expect(running.child.getInterventionCount()).toBe(0);

    const failedEntries = running.child.getEntries("child-1", "gen-1");
    await flush();
    const failedEntriesLine = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    running.spawned.emitLine({
      id: failedEntriesLine.id,
      type: "response",
      command: "get_entries",
      success: false,
      error: "private get_entries error",
    });
    const failedEntriesResult = await failedEntries;
    expect(failedEntriesResult.isErr()).toBe(true);
    expect(JSON.stringify(failedEntriesResult)).not.toContain(
      "private get_entries error",
    );

    const mismatchedEntries = running.child.getEntries("child-1", "gen-1");
    await flush();
    const mismatchedEntriesLine = running.spawned
      .writtenLines()
      .at(-1) as Record<string, unknown>;
    running.spawned.emitLine({
      id: mismatchedEntriesLine.id,
      type: "response",
      command: "steer",
      success: true,
    });
    expect((await mismatchedEntries).isErr()).toBe(true);
    running.spawned.emitLine({
      id: mismatchedEntriesLine.id,
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: null },
    });
    expect(running.child.getInterventionCount()).toBe(0);

    const raced = running.child.followUp("child-1", "gen-1", "late text");
    await flush();
    const racedLine = running.spawned.writtenLines().at(-1) as Record<
      string,
      unknown
    >;
    running.spawned.emitLine(terminalAssistantMessage());
    await running.responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      running.secretBytes,
    );
    expect((await running.runPromise).isOk()).toBe(true);
    expect((await raced).isErr()).toBe(true);
    running.spawned.emitLine({
      id: racedLine.id,
      type: "response",
      command: "follow_up",
      success: true,
    });
    expect(running.child.getInterventionCount()).toBe(0);
    expect(counts).toEqual([]);
    expect(JSON.stringify(counts)).not.toContain("private");
    running.child.dispose();
  });

  it("writes only an authenticated normalized extension UI response", async () => {
    const running = await startRunningChild();
    const before = running.spawned.writtenLines().length;
    expect(
      (
        await running.child.sendExtensionUiResponse("wrong-child", "gen-1", {
          type: "extension_ui_response",
          requestId: "req-1",
          response: "no",
        })
      ).isErr(),
    ).toBe(true);
    expect(running.spawned.writtenLines()).toHaveLength(before);

    running.spawned.emitLine({
      type: "extension_ui_request",
      requestType: "dialog",
      requestId: "req-1",
    });
    const beforeCrossChild = running.spawned.writtenLines().length;
    expect(
      (
        await running.child.sendExtensionUiResponse("other-child", "gen-1", {
          type: "extension_ui_response",
          requestId: "req-1",
          response: "cross-child",
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await running.child.sendExtensionUiResponse("child-1", "other-gen", {
          type: "extension_ui_response",
          requestId: "req-1",
          response: "stale-generation",
        })
      ).isErr(),
    ).toBe(true);
    expect(running.spawned.writtenLines()).toHaveLength(beforeCrossChild);
    const result = running.child.sendExtensionUiResponse("child-1", "gen-1", {
      type: "extension_ui_response",
      requestId: "req-1",
      response: { value: "yes" },
      cancelled: false,
    });
    expect((await result).isOk()).toBe(true);
    expect(running.spawned.writtenLines().at(-1)).toEqual({
      type: "extension_ui_response",
      id: "req-1",
      value: "yes",
    });
    const beforeDuplicate = running.spawned.writtenLines().length;
    expect(
      (
        await running.child.sendExtensionUiResponse("child-1", "gen-1", {
          type: "extension_ui_response",
          requestId: "req-1",
          response: "late",
        })
      ).isErr(),
    ).toBe(true);
    expect(running.spawned.writtenLines()).toHaveLength(beforeDuplicate);
    running.child.dispose();
  });

  it("correlates blocking UI requests and maps confirmation safely", async () => {
    const running = await startRunningChild();
    const before = running.spawned.writtenLines().length;

    for (const requestType of ["notification", "widget"] as const) {
      running.spawned.emitLine({
        type: "extension_ui_request",
        requestType,
        requestId: `${requestType}-1`,
      });
      expect(
        (
          await running.child.sendExtensionUiResponse("child-1", "gen-1", {
            type: "extension_ui_response",
            requestId: `${requestType}-1`,
            response: "not blocking",
          })
        ).isErr(),
      ).toBe(true);
    }
    expect(running.spawned.writtenLines()).toHaveLength(before);

    running.spawned.emitLine({
      type: "extension_ui_request",
      requestType: "dialog",
      requestId: "confirm-1",
    });
    expect(
      (
        await running.child.sendExtensionUiResponse("child-1", "gen-1", {
          type: "extension_ui_response",
          requestId: "confirm-1",
          response: true,
        })
      ).isOk(),
    ).toBe(true);
    expect(running.spawned.writtenLines().at(-1)).toEqual({
      type: "extension_ui_response",
      id: "confirm-1",
      confirmed: true,
    });

    running.spawned.emitLine({
      type: "extension_ui_request",
      requestType: "dialog",
      requestId: "cancel-1",
    });
    expect(
      (
        await running.child.sendExtensionUiResponse("child-1", "gen-1", {
          type: "extension_ui_response",
          requestId: "cancel-1",
          cancelled: true,
        })
      ).isOk(),
    ).toBe(true);
    expect(running.spawned.writtenLines().at(-1)).toEqual({
      type: "extension_ui_response",
      id: "cancel-1",
      cancelled: true,
    });

    running.spawned.emitLine({
      type: "extension_ui_request",
      requestType: "dialog",
      requestId: "smuggle-1",
    });
    const beforeMalformed = running.spawned.writtenLines().length;
    const malformed = await running.child.sendExtensionUiResponse(
      "child-1",
      "gen-1",
      {
        type: "extension_ui_response",
        requestId: "smuggle-1",
        response: true,
        id: "attacker-controlled-id",
        extra: "private-payload",
      } as unknown as PiExtensionUiResponseInput,
    );
    expect(malformed.isErr()).toBe(true);
    expect(running.spawned.writtenLines()).toHaveLength(beforeMalformed);
    expect(JSON.stringify(malformed)).not.toContain("private-payload");

    running.child.dispose();
  });

  it("fails closed on UI write errors and clears requests during cleanup", async () => {
    const running = await startRunningChild();
    running.spawned.emitLine({
      type: "extension_ui_request",
      requestType: "dialog",
      requestId: "write-failure-1",
    });
    running.spawned.failNextWrite({
      type: "WriteFailed",
      reason: "private raw write failure",
    });
    const failed = await running.child.sendExtensionUiResponse(
      "child-1",
      "gen-1",
      {
        type: "extension_ui_response",
        requestId: "write-failure-1",
        response: "value",
      },
    );
    expect(failed.isErr()).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("private raw write failure");
    expect(running.child.snapshot().status).toBe("failed");
    expect(running.spawned.forceKilled).toBe(true);

    const disposed = await startRunningChild();
    disposed.spawned.emitLine({
      type: "extension_ui_request",
      requestType: "dialog",
      requestId: "disposed-1",
    });
    const beforeDispose = disposed.spawned.writtenLines().length;
    disposed.child.dispose();
    const late = await disposed.child.sendExtensionUiResponse(
      "child-1",
      "gen-1",
      {
        type: "extension_ui_response",
        requestId: "disposed-1",
        response: "late",
      },
    );
    expect(late.isErr()).toBe(true);
    expect(disposed.spawned.writtenLines()).toHaveLength(beforeDispose);
  });

  it("delivers the bootstrap payload through an ordinary prompt command as a hidden control envelope, never a raw sideband", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await waitFor(() => spawned.writtenLines().length >= 1);
    let lines = spawned.writtenLines();
    const bootstrapEnvelope = extractControlEnvelopeFromPrompt(lines[0]) as {
      kind: string;
    };
    expect(bootstrapEnvelope.kind).toBe("bootstrap");
    // No task work is sent until the child proves it applied the bootstrap.
    expect(lines.length).toBe(1);

    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    lines = spawned.writtenLines();
    const taskLine = lines[1] as { type: string; message: string };
    expect(taskLine).toEqual({ type: "prompt", message: "do the thing" });

    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      secretBytes,
    );
    const settlement = await runPromise;
    expect(settlement.isOk()).toBe(true);
    expect(settlement._unsafeUnwrap()).toEqual({
      outcome: "completed",
      assistantOutput: "final answer",
      interventionCount: 0,
    });
  });

  it("delivers a task larger than one RPC record through prompt chunks", async () => {
    const task = `large-🙂\n${"x".repeat(1_100_000)}`;
    const input = baseSpawnInput({ task });
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(input);
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(input, validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    const expectedChunkCount = encodePromptChunks(task, "count-only").length;
    await waitFor(
      () => spawned.writtenLines().length === expectedChunkCount + 1,
    );

    const assembler = new PromptChunkAssembler();
    let assembled: string | undefined;
    let transferId: string | undefined;
    for (const line of spawned.writtenLines().slice(1)) {
      const record = line as { type: string; message: string };
      expect(record.type).toBe("prompt");
      expect(record.message.startsWith(`${PROMPT_CHUNK_COMMAND} `)).toBe(true);
      const parsed = parsePromptChunk(
        record.message.slice(PROMPT_CHUNK_COMMAND.length + 1),
      );
      expect(parsed.isOk()).toBe(true);
      if (parsed.isOk()) {
        transferId = parsed.value.transferId;
        assembled = assembler.accept(parsed.value)._unsafeUnwrap();
      }
    }
    expect(assembled).toBe(task);
    expect(transferId).toBeDefined();
    await responder.send(
      "transfer-result",
      transferId ?? "missing-transfer-id",
      {
        channel: "prompt",
        transferId: transferId ?? "missing-transfer-id",
        status: "ack",
      },
      secretBytes,
    );

    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      secretBytes,
    );
    expect((await runPromise).isOk()).toBe(true);
  });

  it("reports a dropped prompt transfer as a typed timeout, never missing settlement", async () => {
    const task = `dropped-${"x".repeat(1_100_000)}`;
    const timers: Array<() => void> = [];
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          timers.push(cb);
          return { cancel: () => {} };
        },
      },
    });
    const input = baseSpawnInput({ task });
    const spawnPromise = child.spawnAndHandshake(input);
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(input, validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();

    // The child never ACKs this transfer. The sender waits, retries the full
    // transfer once, waits again, then names the delivery cause. It must not
    // continue to the unrelated settlement timer.
    const firstTransferTimeout = timers.at(-1);
    expect(firstTransferTimeout).toBeDefined();
    firstTransferTimeout?.();
    await flush();
    const secondTransferTimeout = timers.at(-1);
    expect(secondTransferTimeout).toBeDefined();
    secondTransferTimeout?.();

    const result = await runPromise;
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe("ChildTransferTimedOut");
    expect(result.error.code).not.toBe("ChildSettlementMissing");
  });

  it("projects exact-host usage once and deduplicates by responseId", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const usageEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "msg-1",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 1,
          cacheWrite: 0,
          cost: { total: 0.02 },
        },
      },
    };
    spawned.emitLine(usageEvent);
    spawned.emitLine(usageEvent); // duplicate responseId -> no double count
    expect(child.snapshot().usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      cost: 0.02,
    });
  });

  it("times out the handshake when the child never authenticates, without hanging", async () => {
    const processPort = new FakeChildProcessPort();
    let scheduled: (() => void) | undefined;
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          scheduled = cb;
          return { cancel: () => {} };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    expect(scheduled).toBeDefined();
    scheduled?.();
    const result = await spawnPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildHandshakeMissing");
  });

  it("times out settlement when the child never reports completion", async () => {
    const processPort = new FakeChildProcessPort();
    const timers: Array<() => void> = [];
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          timers.push(cb);
          return { cancel: () => {} };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    // Resolve handshake via its own scheduled timer slot (index 0).
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    // Resolve the bootstrap-ack wait first (its own scheduled timer slot),
    // so the child actually reaches the settlement-awaiting phase before we
    // fire the settlement timeout itself.
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    const settlementTimer = timers.at(-1);
    settlementTimer?.();
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildSettlementMissing");
  });

  it("renews the settlement timeout while a running child reports activity", async () => {
    const processPort = new FakeChildProcessPort();
    const timers: Array<{ cancelled: boolean; fire: () => void }> = [];
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (callback) => {
          const timer = {
            cancelled: false,
            fire: () => {
              if (!timer.cancelled) callback();
            },
          };
          timers.push(timer);
          return { cancel: () => (timer.cancelled = true) };
        },
      },
    });
    const input = baseSpawnInput();
    const spawnPromise = child.spawnAndHandshake(input);
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(input, validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    const originalSettlementTimer = timers.at(-1);
    expect(originalSettlementTimer).toBeDefined();

    spawned.emitLine({ type: "turn_start" });
    const sessionEventTimer = timers.at(-1);
    expect(sessionEventTimer).not.toBe(originalSettlementTimer);
    expect(originalSettlementTimer?.cancelled).toBe(true);

    await responder.send(
      "delegate-request",
      "delegation-1",
      { agentName: "shuttle", task: "continue working" },
      secretBytes,
    );
    await flush();
    const authenticatedControlTimer = timers.at(-1);
    expect(authenticatedControlTimer).not.toBe(sessionEventTimer);
    expect(sessionEventTimer?.cancelled).toBe(true);

    originalSettlementTimer?.fire();
    sessionEventTimer?.fire();
    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      secretBytes,
    );
    expect((await runPromise)._unsafeUnwrap()).toEqual({
      outcome: "completed",
      assistantOutput: "final answer",
      interventionCount: 0,
    });
  });

  it("stops the child on a replayed nonce (fail-closed authentication)", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    const handshakeEnvelope = await responder.send(
      "handshake",
      "child-1",
      {},
      secretBytes,
    );
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    // Replays the exact same (already-consumed) envelope again under the guise of settlement sequence 2.
    spawned.emitLine({ ...handshakeEnvelope, kind: "settled", sequence: 2 });
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
  });

  it("rejects a settlement whose sequence is out of order (replay/late/cross-generation fail closed)", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    // Jumps straight to sequence 5 instead of the expected 2.
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "x" },
      secretBytes,
      5,
    );
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
  });

  it("rejects an envelope from a different childId or generationId (cross-child/cross-generation fail closed)", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const foreignResponder = new ScriptedChildResponder(
      spawned,
      "some-other-child",
      "gen-1",
    );
    await foreignResponder.send("handshake", "child-1", {}, secretBytes);
    const result = await spawnPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildEnvelopeMalformed");
  });

  it("treats an unauthenticated (unsigned/garbage) line as ignorable noise, never as an authenticated message", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    spawned.emitLine({ type: "agent_start" }); // ordinary RPC event, not a control envelope
    spawned.emitLine({ garbage: true });
    expect(child.snapshot().status).toBe("handshaking");

    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    const result = await spawnPromise;
    expect(result.isOk()).toBe(true);
  });

  it("cancels via an authenticated envelope plus the ordinary abort command, and cleans up idempotently", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await waitFor(
      () => processPort.spawnedProcesses.length > 0,
      5_000,
      "the child process to spawn",
    );
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const cancelPromise = child.cancel();
    await waitFor(
      () =>
        spawned
          .writtenLines()
          .some((line) => (line as { type: string }).type === "abort"),
      5_000,
      "the ordinary abort command to be written to the child",
    );
    const lines = spawned.writtenLines();
    expect(
      lines.some((line) => (line as { type: string }).type === "abort"),
    ).toBe(true);
    await responder.send("cancelled", "child-1", {}, secretBytes);
    await cancelPromise;

    child.dispose();
    child.dispose(); // idempotent
    expect(spawned.killed).toBe(true);
    // The terminal cleanup path must guarantee termination via the
    // mandatory force-kill, not merely the cooperative default signal.
    expect(spawned.forceKilled).toBe(true);
  });

  it("force-kills the process when the bounded cancellation grace period elapses with no cooperative reply at all (non-cooperative/stopped child), guaranteeing no leaked process", async () => {
    // Reproduces the live exact-host bug (Pi adapter contract, Final4 exact-host
    // smoke): a delegated child was SIGSTOP'd to simulate
    // non-cooperation, selected via the child tree, and Esc-cancelled.
    // Neither an authenticated "cancelled" ack, a racing "settled" report,
    // nor the process actually exiting ever arrived - only the bounded
    // cancellation grace period elapsing. weave_delegate still correctly
    // settled `{ok:true, settlement:{outcome:"cancelled"}}`, but `ps`
    // still showed the child in a stopped `T+` state, because
    // `terminateResources()` only ever called the cooperative default
    // `kill()` (SIGTERM), which a stopped process can leave pending
    // indefinitely instead of acting on. This proves the grace-timeout
    // path now force-kills instead.
    const processPort = new FakeChildProcessPort();
    const timers: Array<() => void> = [];
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          timers.push(cb);
          return { cancel: () => {} };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();

    const cancelPromise = child.cancel();
    await flush();
    const lines = spawned.writtenLines();
    expect(
      lines.some((line) => (line as { type: string }).type === "abort"),
    ).toBe(true);

    // The simulated stopped/non-cooperative child never replies and never
    // exits - only the bounded grace timer, fired directly here
    // (deterministic, no real timers), can conclude the cancellation.
    expect(spawned.killed).toBe(false);
    expect(spawned.forceKilled).toBe(false);
    const graceTimer = timers.at(-1);
    graceTimer?.();

    const result = await runPromise;
    await cancelPromise;

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: "cancelled" });
    expect(child.snapshot().status).toBe("cancelled");
    expect(child.isDisposed()).toBe(true);
    // The mandatory force-kill - never merely the cooperative default
    // signal - is what must actually guarantee the process is gone here.
    expect(spawned.forceKilled).toBe(true);
    expect(spawned.killed).toBe(true);
  });

  it("resolves as a structured cancelled result when the child's own abort-triggered settled report races ahead of its cancelled ack (exact-host cancellation timing)", async () => {
    // Reproduces the live exact-host bug: Backspace, Alt+4, Esc on a
    // delegated child mid-response cancels it, but the child's own
    // extension can report an ordinary "settled" (for the turn the raw RPC
    // "abort" command just ended) before the still-queued hidden-command
    // prompt carrying the authenticated "cancel" envelope is ever
    // dispatched to it, so no "cancelled" envelope is ever sent back at
    // all. weave_delegate previously surfaced this as
    // {ok:false,error:"ChildEnvelopeMalformed"} instead of a structured
    // cancelled result (Pi adapter contract).
    //
    // Synchronization is injected, never timed: the child's bounded grace
    // timer is the observable seam that proves `cancel()` has finished
    // writing the raw abort and registered its bounded wait, so the raced
    // `settled` report is delivered at exactly the contested moment on
    // every run. No real sleeps and no ordering assumption are involved.
    const processPort = new FakeChildProcessPort();
    let cancelRequested = false;
    const graceScheduled = createDeferred<ScheduledTestTimer>();
    const graceCancelled = createDeferred<void>();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          const timer: ScheduledTestTimer = { fire: cb, cancelled: false };
          // Only a timer scheduled after cancellation starts is the bounded
          // grace timer; earlier ones are handshake / bootstrap-ack.
          const isGraceTimer = cancelRequested;
          if (isGraceTimer) graceScheduled.resolve(timer);
          return {
            cancel: () => {
              timer.cancelled = true;
              if (isGraceTimer) graceCancelled.resolve(undefined);
            },
          };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();

    const cancelPromise = child.cancel();
    cancelRequested = true;
    // Deterministic rendezvous: the bounded grace timer is registered only
    // after the authenticated cancel and the raw abort have been written,
    // so awaiting it puts the raced "settled" report at the exact contested
    // point without polling, sleeping, or assuming a tick count.
    const graceTimer = await graceScheduled.promise;
    const lines = spawned.writtenLines();
    expect(
      lines.some((line) => (line as { type: string }).type === "abort"),
    ).toBe(true);
    expect(graceTimer.cancelled).toBe(false);

    // The child's own "cancelled" ack never arrives - only the ordinary
    // "settled" report for the turn the raw abort just ended, exactly as
    // the live smoke evidence shows.
    await responder.send(
      "settled",
      "child-1",
      { outcome: "failed", reason: "assistant stop reason: aborted" },
      secretBytes,
    );
    // The raced report - not the bounded timeout - must conclude the
    // cancellation, so the grace timer is cancelled rather than fired.
    // Awaiting that seam keeps the rendezvous injected instead of timed.
    await graceCancelled.promise;

    const result = await runPromise;
    await cancelPromise;

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: "cancelled" });
    expect(child.snapshot().status).toBe("cancelled");
    expect(spawned.killed).toBe(true);
    expect(spawned.forceKilled).toBe(true);
    // The raced settled report - not the grace timeout - concluded the
    // cancellation, so the bounded timer was cancelled and never fired.
    expect(graceTimer.cancelled).toBe(true);

    child.dispose();
    child.dispose(); // idempotent
  });

  it("clears the secret reference on every terminal path, including spawn failure", async () => {
    const processPort = new FakeChildProcessPort();
    processPort.failNextSpawn({ type: "SpawnFailed", reason: "boom" });
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const result = await child.spawnAndHandshake(baseSpawnInput());
    expect(result.isErr()).toBe(true);
    child.dispose();
    expect(child.isDisposed()).toBe(true);
  });

  it("kills the process and erases the secret when the handshake times out, while preserving the failed status", async () => {
    const processPort = new FakeChildProcessPort();
    let scheduled: (() => void) | undefined;
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          scheduled = cb;
          return { cancel: () => {} };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    scheduled?.();
    const result = await spawnPromise;
    expect(result.isErr()).toBe(true);
    expect(child.snapshot().status).toBe("failed");
    expect(child.isDisposed()).toBe(true);
    expect(spawned.killed).toBe(true);
    expect(spawned.forceKilled).toBe(true);
    // Cleanup must be idempotent and must never clobber the preserved
    // "failed" status back to "cancelled".
    child.dispose();
    expect(child.snapshot().status).toBe("failed");
  });

  it("kills the process and erases the secret when bootstrap-ack times out, while preserving the failed status", async () => {
    const processPort = new FakeChildProcessPort();
    const timers: Array<() => void> = [];
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          timers.push(cb);
          return { cancel: () => {} };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    const bootstrapAckTimer = timers.at(-1);
    bootstrapAckTimer?.();
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildReplyMissing");
    expect(child.snapshot().status).toBe("failed");
    expect(spawned.killed).toBe(true);
    expect(spawned.forceKilled).toBe(true);
    expect(child.isDisposed()).toBe(true);
  });

  it("kills the process and erases the secret on a successful settlement too, not only on failure", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      secretBytes,
    );
    const result = await runPromise;
    expect(result.isOk()).toBe(true);
    expect(spawned.killed).toBe(true);
    expect(spawned.forceKilled).toBe(true);
    expect(child.isDisposed()).toBe(true);
    expect(child.snapshot().status).toBe("completed");
  });

  it("does not drop a bootstrap-ack that wins the race against the parent's own (slower) outbound signing - install-before-send", async () => {
    const processPort = new FakeChildProcessPort();
    const slowHmac = new DelayedSignHmacPort(hmacPort, 75);
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort: slowHmac,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    // The child's own replies are signed with the plain, fast, real port -
    // only the parent's *own* outbound `bootstrap` signing is slow.
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    // Deliver the ack immediately - well before the delayed outbound
    // `bootstrap` signing (75ms) could possibly have finished. Under the
    // old "install the resolver only after the send resolves" ordering,
    // this would be dispatched while no resolver exists yet and fail with
    // ChildReplyLate. Under install-before-send it must always be caught.
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flushMs(150);
    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      secretBytes,
    );
    const result = await runPromise;
    expect(result.isOk()).toBe(true);
  });

  it("does not drop a settlement delivered immediately after bootstrap-ack, with no intervening flush", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    // No extra flush before settlement: the settlement resolver must
    // already be installed by the time the task prompt is sent, since it is
    // installed in the same synchronous step that sends the prompt.
    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      secretBytes,
    );
    const result = await runPromise;
    expect(result.isOk()).toBe(true);
  });

  it("fails closed on an unknown/illegal incoming kind (a parent-to-child-only kind echoed back by a misbehaving child)", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    // "delegate-response" is a parent-to-child-only kind; a child sending
    // it back is always illegal and must fail closed.
    await responder.send(
      "delegate-response",
      "child-1",
      { scope: "once" },
      secretBytes,
    );
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
    expect(child.isDisposed()).toBe(true);
    expect(spawned.killed).toBe(true);
    expect(spawned.forceKilled).toBe(true);
  });

  it("fails closed on a `cancelled` envelope that arrives while no cancellation is in flight", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    const result = await spawnPromise;
    expect(result.isOk()).toBe(true);

    await responder.send("cancelled", "child-1", {}, secretBytes);
    await flush();
    expect(child.snapshot().status).toBe("failed");
    expect(spawned.killed).toBe(true);
    expect(spawned.forceKilled).toBe(true);
  });

  it("clamps negative and non-finite usage fields to zero rather than propagating them", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    spawned.emitLine({
      type: "message_end",
      message: {
        role: "assistant",
        id: "msg-1",
        usage: {
          input: -10,
          output: Number.POSITIVE_INFINITY,
          cacheRead: Number.NaN,
          cacheWrite: -1,
          cost: { total: -5 },
        },
      },
    });
    expect(child.snapshot().usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    });
  });

  it("accumulates streamed message_update deltas and pushes bounded snapshots to its parent", async () => {
    const processPort = new FakeChildProcessPort();
    const streamingUpdates: PiChildTreeNode[] = [];
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      onStreamingUpdate: (snapshot) => streamingUpdates.push(snapshot),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    spawned.emitLine({ type: "message_update", delta: { text: "hello " } });
    spawned.emitLine({ type: "message_update", delta: { text: "world" } });
    expect(child.snapshot().latestOutput).toBe("hello world");
    expect(streamingUpdates.at(-1)?.latestOutput).toBe("hello world");

    // Keep the previous preview visible across a turn boundary. The first
    // delta from the new turn replaces it, avoiding a blank flash while the
    // child starts its next model or tool step.
    spawned.emitLine({ type: "turn_start" });
    expect(child.snapshot().latestOutput).toBe("hello world");
    expect(streamingUpdates.at(-1)?.latestOutput).toBe("hello world");
    spawned.emitLine({
      type: "message_update",
      delta: { text: "second turn" },
    });
    expect(child.snapshot().latestOutput).toBe("second turn");
    expect(streamingUpdates.at(-1)?.latestOutput).toBe("second turn");
  });

  it("streams thinking deltas so a reasoning child never looks frozen, and yields to answer text once it starts", async () => {
    const processPort = new FakeChildProcessPort();
    const streamingUpdates: PiChildTreeNode[] = [];
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      onStreamingUpdate: (snapshot) => streamingUpdates.push(snapshot),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    spawned.emitLine({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "weigh" },
    });
    spawned.emitLine({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "ing it" },
    });
    expect(child.snapshot().latestOutput).toBe("weighing it");
    expect(streamingUpdates.at(-1)?.latestOutput).toBe("weighing it");

    // Real answer text always wins: the reasoning preview is dropped the
    // moment the model actually starts speaking.
    spawned.emitLine({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "answer" },
    });
    expect(child.snapshot().latestOutput).toBe("answer");
    expect(streamingUpdates.at(-1)?.latestOutput).toBe("answer");

    // Once text exists, later thinking never overwrites it.
    spawned.emitLine({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "more" },
    });
    expect(child.snapshot().latestOutput).toBe("answer");

    // A new turn retains the previous preview until its first delta arrives.
    spawned.emitLine({ type: "turn_start" });
    expect(child.snapshot().latestOutput).toBe("answer");
    spawned.emitLine({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "next thought" },
    });
    expect(child.snapshot().latestOutput).toBe("next thought");
  });

  it("settles from the latest completed assistant message, not transient or control text", async () => {
    const running = await startRunningChild();
    running.spawned.emitLine({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "intermediate" }],
      },
    });
    running.spawned.emitLine({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "transient-control-summary",
      },
    });
    running.spawned.emitLine({ type: "thinking", text: "private thinking" });
    running.spawned.emitLine({
      type: "tool_result",
      result: "private tool result",
    });
    running.spawned.emitLine({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private final thinking" },
          { type: "text", text: "final answer" },
          { type: "image", data: "private image" },
          { type: "future_block", value: "private unknown" },
        ],
      },
    });
    await running.responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "control-summary" },
      running.secretBytes,
    );

    expect((await running.runPromise)._unsafeUnwrap()).toEqual({
      outcome: "completed",
      assistantOutput: "final answer",
      interventionCount: 0,
    });
  });

  it("does not let control assistantOutput or completionCandidate alone satisfy the result contract", async () => {
    const cases: ReadonlyArray<JsonValue> = [
      { outcome: "completed", assistantOutput: "control-only summary" },
      {
        outcome: "completed",
        completionCandidate: JSON.stringify({
          outcome: "success",
          message: "candidate-only",
        }),
      },
    ];
    for (const body of cases) {
      const running = await startRunningChild({ responseDrainMs: 1 });
      await running.responder.send(
        "settled",
        "child-1",
        body,
        running.secretBytes,
      );
      const failure = (await running.runPromise)._unsafeUnwrapErr();
      expect(failure.code).toBe("ChildResponseMissing");
      expect(failure.retryable).toBe(true);
      expect(failure.correlation?.reason).toBe("no-response");
      running.child.dispose();
    }
  });

  it("completes from an out-of-order terminal message_end inside the drain window", async () => {
    const running = await startRunningChild({ responseDrainMs: 50 });
    await running.responder.send(
      "settled",
      "child-1",
      {
        outcome: "completed",
        assistantOutput: "ignored-control-summary",
        completionCandidate: JSON.stringify({ outcome: "success" }),
      },
      running.secretBytes,
    );
    expect(running.child.snapshot().status).toBe("running");
    running.spawned.emitLine(terminalAssistantMessage());
    expect((await running.runPromise)._unsafeUnwrap()).toEqual({
      outcome: "completed",
      assistantOutput: "final answer",
      completionCandidate: JSON.stringify({ outcome: "success" }),
      interventionCount: 0,
    });
  });

  it("settles absent, nonassistant, and tool-only messages as ChildResponseMissing", async () => {
    const cases: ReadonlyArray<{
      readonly message: JsonValue;
      readonly reason: string;
    }> = [
      { message: { type: "message_end" }, reason: "no-response" },
      {
        message: {
          type: "message_end",
          message: { role: "user", content: "not assistant text" },
        },
        reason: "no-response",
      },
      {
        message: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "private-tool" }],
          },
        },
        reason: "empty",
      },
    ];

    for (const testCase of cases) {
      const running = await startRunningChild({ responseDrainMs: 1 });
      running.spawned.emitLine(testCase.message);
      await running.responder.send(
        "settled",
        "child-1",
        { outcome: "completed", assistantOutput: "ignored-control-summary" },
        running.secretBytes,
      );
      const failure = (await running.runPromise)._unsafeUnwrapErr();
      expect(failure.code).toBe("ChildResponseMissing");
      expect(failure.retryable).toBe(true);
      expect(failure.correlation?.reason).toBe(testCase.reason);
      running.child.dispose();
    }
  });

  it("freezes interventionCount when settlement resolves", async () => {
    const running = await startRunningChild();
    const first = running.child.steer("child-1", "gen-1", "first");
    await flush();
    const firstLine = running.spawned.writtenLines().at(-1) as {
      id: string;
    };
    running.spawned.emitLine({
      id: firstLine.id,
      type: "response",
      command: "steer",
      success: true,
    });
    expect((await first).isOk()).toBe(true);

    const late = running.child.steer("child-1", "gen-1", "late");
    await flush();
    const lateLine = running.spawned.writtenLines().at(-1) as { id: string };
    running.spawned.emitLine(terminalAssistantMessage());
    await running.responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "ignored-control-summary" },
      running.secretBytes,
    );
    const settlement = (await running.runPromise)._unsafeUnwrap();
    running.spawned.emitLine({
      id: lateLine.id,
      type: "response",
      command: "steer",
      success: true,
    });
    expect(settlement).toEqual({
      outcome: "completed",
      assistantOutput: "final answer",
      interventionCount: 1,
    });
    expect(running.child.getInterventionCount()).toBe(1);
    expect((await late).isErr()).toBe(true);
  });

  it("bounds a terminal assistant message over 1 MiB without leaking its payload", async () => {
    const running = await startRunningChild();
    const payload = "terminal-secret-payload";
    const terminalText = "a".repeat(1_100_000) + payload;
    running.spawned.emitLine({
      type: "message_end",
      message: { role: "assistant", content: terminalText },
    });
    await running.responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "ignored-control-summary" },
      running.secretBytes,
    );

    const result = await running.runPromise;
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.outcome).toBe("completed");
      if (result.value.outcome === "completed") {
        expect(
          new TextEncoder().encode(result.value.assistantOutput).byteLength,
        ).toBe(4096);
        expect(result.value.assistantOutput).toBe("a".repeat(4096));
        expect(JSON.stringify(result.value)).not.toContain(payload);
      }
    }
  });

  it("forwards every bounded session event through the observer in wire order", async () => {
    const processPort = new FakeChildProcessPort();
    const observed: string[] = [];
    const observer: PiChildSessionObserver = {
      onEvent: (event) => {
        observed.push(event.type);
        return ok(undefined);
      },
    };
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      sessionObserver: observer,
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const events: JsonValue[] = [
      { type: "message_update", text: "out of order" },
      { type: "message_start" },
      { type: "message_end" },
      { type: "text", text: "text" },
      { type: "thinking", text: "thinking" },
      { type: "markdown", text: "markdown" },
      { type: "tool_call" },
      { type: "tool_partial_result" },
      { type: "tool_result" },
      { type: "tool_error" },
      {
        type: "tool_execution_start",
        toolCallId: "native-1",
        toolName: "read",
        args: { path: "README.md" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "native-1",
        toolName: "read",
        args: { path: "README.md" },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "native-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      },
      {
        type: "tool_execution_end",
        toolCallId: "native-2",
        toolName: "bash",
        result: "failed",
        isError: true,
      },
      { type: "image" },
      { type: "usage" },
      { type: "queue_change" },
      { type: "status" },
      { type: "retry" },
      {
        type: "extension_ui_request",
        requestType: "notification",
        requestId: "notification-1",
      },
      {
        type: "extension_ui_request",
        requestType: "widget",
        requestId: "widget-1",
      },
      {
        type: "extension_ui_request",
        requestType: "dialog",
        requestId: "dialog-1",
      },
      { type: "future_event", payload: "bounded" },
    ];
    const encoded = new TextEncoder().encode(
      events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    );
    spawned.emit(encoded.slice(0, 37));
    spawned.emit(encoded.slice(37));

    expect(observed).toEqual([
      "message_update",
      "message_start",
      "message_end",
      "text",
      "thinking",
      "markdown",
      "tool_call",
      "tool_partial_result",
      "tool_result",
      "tool_error",
      "tool_call",
      "tool_partial_result",
      "tool_result",
      "tool_error",
      "image",
      "usage",
      "queue_change",
      "status",
      "retry",
      "extension_ui_request",
      "extension_ui_request",
      "extension_ui_request",
      "unknown",
    ]);
  });

  it("accepts a native assistant record over 1 MiB before settlement", async () => {
    const processPort = new FakeChildProcessPort();
    const observed: Array<{ type: string }> = [];
    const logs: Array<Record<string, unknown>> = [];
    const rawPayload = "native-assistant-observer-secret";
    const detail = `${rawPayload}${"x".repeat(16_384 - rawPayload.length)}`;
    const details: Record<string, string> = {};
    for (let index = 0; index < 64; index += 1) {
      details[`detail-${index}`] = detail;
    }
    const nativeEvent: JsonValue = {
      type: "message_end",
      message: {
        role: "assistant",
        id: "large-assistant-message",
        usage: { input: 1, output: 2 },
        details,
      },
    };
    const nativeLine = new TextEncoder().encode(
      `${JSON.stringify(nativeEvent)}\n`,
    );
    expect(nativeLine.byteLength).toBeGreaterThan(1 * 1024 * 1024);
    expect(nativeLine.byteLength).toBeLessThanOrEqual(MAX_NATIVE_RECORD_BYTES);
    const captureLog = (record: Record<string, unknown>) => logs.push(record);
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: {
        debug: captureLog,
        info: captureLog,
        warn: captureLog,
        error: captureLog,
      },
      sessionObserver: {
        onEvent: (event) => {
          observed.push(event);
          return ok(undefined);
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await waitFor(() => child.snapshot().status === "running");

    spawned.emit(nativeLine.slice(0, 4096));
    spawned.emit(nativeLine.slice(4096));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.type).toBe("message_end");
    expect(JSON.stringify(observed)).toContain(rawPayload);

    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      secretBytes,
    );
    const result = await runPromise;
    expect(result.isOk()).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(rawPayload);
    expect(JSON.stringify(result)).not.toContain(rawPayload);
  });

  it("turns observer failures into safe typed child failures without logging payloads", async () => {
    const processPort = new FakeChildProcessPort();
    const logs: Array<Record<string, unknown>> = [];
    const rawPayload = "observer-secret-payload";
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (record) => logs.push(record),
        error: () => undefined,
      },
      sessionObserver: {
        onEvent: () => {
          throw new Error(rawPayload);
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await waitFor(() => child.snapshot().status === "running");
    spawned.emitLine({ type: "text", text: rawPayload });

    const result = await runPromise;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("ChildInteractionUnavailable");
      expect(result.error.safeMessage).not.toContain(rawPayload);
    }
    expect(JSON.stringify(logs)).not.toContain(rawPayload);
    expect(child.snapshot().status).toBe("failed");
    expect(spawned.forceKilled).toBe(true);
  });

  it("keeps full output private while projecting only bounded text and numeric metadata", async () => {
    const privateMarkers = [
      "PRIVATE_TRANSCRIPT",
      "PRIVATE_THINKING",
      "PRIVATE_TOOL_CALL",
      "PRIVATE_TOOL_RESULT",
      "PRIVATE_EXTENSION_UI",
    ];
    const terminalSentinel = "OBSERVED_TERMINAL_SENTINEL";
    const fullOutput = `${"x".repeat(1_100_000)}${privateMarkers.join("|")}`;
    const captures: Array<{ output: string; byteLength: number }> = [];
    const running = await startRunningChild({
      onPrivateOutput: (capture) => {
        captures.push(capture);
        return ok(undefined);
      },
    });
    const transferId = "private-output-transfer";
    const chunks = encodeTransferChunks(fullOutput, transferId);
    expect(chunks.isOk()).toBe(true);
    if (chunks.isErr()) return;
    for (const chunk of chunks.value) {
      await running.responder.send(
        "transfer-chunk",
        transferId,
        { channel: "output", ...chunk },
        running.secretBytes,
      );
    }
    await flush();
    running.spawned.emitLine({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: terminalSentinel }],
      },
    });
    await flush();

    await running.responder.send(
      "settled",
      "child-1",
      {
        outcome: "completed",
        assistantOutput: "bounded parent projection",
        outputTransferId: transferId,
        outputByteLength: new TextEncoder().encode(fullOutput).byteLength,
      },
      running.secretBytes,
    );
    const result = await running.runPromise;
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(captures).toEqual([
      {
        output: fullOutput,
        byteLength: new TextEncoder().encode(fullOutput).byteLength,
      },
    ]);
    if (result.value.outcome !== "completed") return;
    expect(result.value.assistantOutput).toBe(terminalSentinel);
    expect(
      new TextEncoder().encode(result.value.assistantOutput ?? "").byteLength,
    ).toBeLessThanOrEqual(4096);
    expect(result.value.outputByteLength).toBe(
      new TextEncoder().encode(fullOutput).byteLength,
    );
    expect(result.value.interventionCount).toBe(0);
    const projected = JSON.stringify(result.value);
    for (const marker of privateMarkers)
      expect(projected).not.toContain(marker);
  });

  it("degrades a missing output transfer to bounded inline settlement", async () => {
    const captures: Array<{ output: string; byteLength: number }> = [];
    const running = await startRunningChild({
      onPrivateOutput: (capture) => {
        captures.push(capture);
        return ok(undefined);
      },
    });

    running.spawned.emitLine(terminalAssistantMessage());
    await running.responder.send(
      "settled",
      "child-1",
      {
        outcome: "completed",
        assistantOutput: "inline terminal answer",
        outputTransferId: "missing-output-transfer",
        outputByteLength: 999,
      },
      running.secretBytes,
    );
    const result = await running.runPromise;

    expect(result).toEqual(
      ok({
        outcome: "completed",
        assistantOutput: "final answer",
        interventionCount: 0,
      }),
    );
    expect(captures).toEqual([{ output: "final answer", byteLength: 12 }]);
    expect(running.spawned.forceKilled).toBe(true);
  });

  it("accepts the native record boundary and fails closed above it", async () => {
    const input = baseSpawnInput();
    const boundaryProcessPort = new FakeChildProcessPort();
    const boundaryChild = new PiRpcChild(
      "child-1",
      "root",
      "gen-1",
      "shuttle",
      1,
      {
        processPort: boundaryProcessPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
      },
    );
    const boundarySpawnPromise = boundaryChild.spawnAndHandshake(input);
    await flush();
    const boundarySpawned = boundaryProcessPort.spawnedProcesses[0];
    const boundarySecret = extractSecretFromSpawn(boundaryProcessPort);
    const boundaryResponder = new ScriptedChildResponder(
      boundarySpawned,
      "child-1",
      "gen-1",
    );
    await boundaryResponder.send("handshake", "child-1", {}, boundarySecret);
    await boundarySpawnPromise;

    const boundaryRun = boundaryChild.runTask(input, validBootstrap());
    await flush();
    await boundaryResponder.send(
      "bootstrap-ack",
      "child-1",
      validAck(),
      boundarySecret,
    );
    await waitFor(() => boundaryChild.snapshot().status === "running");
    const boundaryFixedOverhead =
      JSON.stringify({ type: "text", text: "" }).length + 1;
    const boundaryLine = `${JSON.stringify({
      type: "text",
      text: "b".repeat(MAX_NATIVE_RECORD_BYTES - boundaryFixedOverhead),
    })}\n`;
    expect(new TextEncoder().encode(boundaryLine).byteLength).toBe(
      MAX_NATIVE_RECORD_BYTES,
    );
    boundarySpawned.emit(new TextEncoder().encode(boundaryLine));
    expect(boundaryChild.snapshot().status).toBe("running");
    boundarySpawned.emitLine(terminalAssistantMessage());
    await boundaryResponder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      boundarySecret,
    );
    const boundaryResult = await boundaryRun;
    expect(boundaryResult.isOk()).toBe(true);
    if (boundaryResult.isOk()) {
      expect(boundaryResult.value).toEqual({
        outcome: "completed",
        assistantOutput: "final answer",
        interventionCount: 0,
      });
    }

    const processPort = new FakeChildProcessPort();
    const logs: Array<Record<string, unknown>> = [];
    const rawPayload = "oversized-rpc-record-secret";
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (record) => logs.push(record),
        error: () => undefined,
      },
    });
    const spawnPromise = child.spawnAndHandshake(input);
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(input, validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await waitFor(() => child.snapshot().status === "running");
    const oversizedLine = `${JSON.stringify({
      type: "text",
      text: `${rawPayload}${"x".repeat(MAX_NATIVE_RECORD_BYTES)}`,
    })}\n`;
    expect(new TextEncoder().encode(oversizedLine).byteLength).toBeGreaterThan(
      MAX_NATIVE_RECORD_BYTES,
    );
    spawned.emit(new TextEncoder().encode(oversizedLine));

    const result = await runPromise;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("ChildEnvelopeMalformed");
      expect(result.error.safeMessage).not.toContain(rawPayload);
      expect(JSON.stringify(result.error)).not.toContain(rawPayload);
    }
    expect(JSON.stringify(logs)).not.toContain(rawPayload);
    expect(child.snapshot().status).toBe("failed");
    expect(spawned.forceKilled).toBe(true);
  });

  it("observes the process's own real exit code rather than relying only on stdout ending", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    const result = await spawnPromise;
    expect(result.isOk()).toBe(true);

    // The process exits with a real, nonzero code without ever ending its
    // stdout stream first - the exit-code observer alone must catch this.
    spawned.exit(17);
    await flush();
    expect(child.snapshot().status).toBe("failed");
    expect(spawned.killed).toBe(true);
    expect(spawned.forceKilled).toBe(true);
  });

  it("fails closed (and does not hang) when the process's stdout read fails", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    spawned.failStdoutRead("child-process-read-failed");
    expect(child.snapshot().status).toBe("failed");
    expect(child.isDisposed()).toBe(true);
  });
});
