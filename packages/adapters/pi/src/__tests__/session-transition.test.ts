import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import {
  type AgentDescriptor,
  ALL_CAPABILITY_IDS,
  createInMemoryRuntimeStore,
  type MaterializationPlan,
} from "@weaveio/weave-engine";
import { errAsync, ok, okAsync } from "neverthrow";
import {
  generateNonceHex,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import {
  WEAVE_CHILD_ID_ENV,
  WEAVE_CHILD_SECRET_ENV,
  WEAVE_CONTROLLER_GENERATION_ENV,
} from "../child-env.js";
import { type PiControlKind, signEnvelope } from "../child-envelope.js";
import {
  authorizeChildAccess,
  classifyChildAccess,
  type PiChildAccessOperation,
} from "../child-runtime.js";
import type {
  AppendChildRefLifecycleInput,
  AppendChildRefRunInput,
  AppendNewChildRefInput,
  PiChildRefError,
  PiChildRefRecord,
  PiChildRefRun,
  PiChildRefScan,
} from "../child-session-refs.js";
import { PiConfigActivator } from "../config-activator.js";
import {
  PiDelegationController,
  type PiThreadRefPort,
} from "../delegation-controller.js";
import { createPiExtension, type PiExtensionDeps } from "../extension.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import {
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceReader,
} from "../host-inventory.js";
import { FakePathContainmentPort } from "../path-containment.js";
import type { JsonValue } from "../strict-json.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  persistentFakeSessionManager,
  RecordingFakePiHost,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";
import { TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

/**
 * A hypothetical descriptor-safe host. The production reader can never report
 * `descriptor-relative-native-session-io` as native, so these transition
 * tests state the assumption explicitly instead of inheriting health-only.
 */
function descriptorSafeHostSurfaceReader(): PiHostSurfaceReader {
  return {
    read: () =>
      okAsync(
        PI_HOST_SURFACE_IDS.map((surfaceId) => ({
          surfaceId,
          status: "native" as const,
          details: "test-controlled",
        })),
      ),
  };
}

const EMPTY_CONFIG = {
  agents: { loom: {}, shuttle: {} },
  disabled: { agents: [], skills: [] },
  settings: {},
} as unknown as WeaveConfig;

const DELEGATION_PLAN: MaterializationPlan = {
  agents: [
    {
      agentName: "loom",
      source: "explicit",
      descriptor: loomDescriptor({
        delegationTargets: [
          {
            name: "shuttle",
            description: "General specialist",
            triggers: [],
            isCategory: false,
          },
        ],
      }),
    },
  ],
  errors: [],
};

function loomDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "loom",
    composedPrompt: "You are Loom, the main orchestrator.",
    models: ["claude-sonnet-4-5"],
    mode: "primary",
    effectiveToolPolicy: {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "allow",
      network: "ask",
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
    ...overrides,
  };
}

function fakeConfigActivator(
  plan: MaterializationPlan,
  config: WeaveConfig = EMPTY_CONFIG,
): PiConfigActivator {
  return new PiConfigActivator({
    configLoader: { load: () => okAsync(config) },
    materializer: { materialize: () => okAsync(plan) },
  });
}

function allOkCapabilityProber() {
  return {
    probe: () =>
      ALL_CAPABILITY_IDS.map((capabilityId) => ({
        capabilityId,
        probeStatus: "ok" as const,
      })),
  };
}

function installTransitionExtension(
  host: RecordingFakePiHost,
  processPort: FakeChildProcessPort,
  overrides: Partial<PiExtensionDeps> = {},
): void {
  const factory = createPiExtension({
    hostPackageReader: FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: "0.83.0",
    }),
    capabilityProber: allOkCapabilityProber(),
    idGenerator: new FakeIdGenerator(),
    clock: new FakeClock(),
    logger: new RecordingLogger(),
    configActivator: fakeConfigActivator(DELEGATION_PLAN),
    pathContainmentPort: new FakePathContainmentPort(
      new Map(),
      ok("/fake/project"),
    ),
    threadSourceFactory: undefined,
    runtimeStoreFactory: {
      open: () => okAsync(createInMemoryRuntimeStore()),
    },
    processPort,
    sessionStorageAuthority:
      TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY,
    childCommand: ["/fake/bin/pi"],
    // Fakes never emit cancelled acks or settlement drains; keep transition
    // tests under Bun's default 5s timeout without changing production.
    childResponseDrainMs: 20,
    childCancelGraceMs: 20,
    // Model a descriptor-safe host so `weave_delegate` is registered; the
    // production reader always reports the path-only session API, which is a
    // required-capability gap and would leave the extension health-only.
    hostSurfaceReader: descriptorSafeHostSurfaceReader(),
    ...overrides,
  });
  factory(host.api);
}

function hook(host: RecordingFakePiHost, event: string) {
  const registration = host.onCalls.find((call) => call.event === event);
  if (registration === undefined) throw new Error(`missing hook: ${event}`);
  return registration.handler;
}

async function invokeHook(
  host: RecordingFakePiHost,
  event: string,
  payload: unknown,
): Promise<unknown> {
  return await hook(host, event)(payload, host.createSessionContext());
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function extractSecret(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
): Uint8Array {
  const index = port.spawnedProcesses.indexOf(process);
  const value = port.spawnInputs[index]?.env[WEAVE_CHILD_SECRET_ENV];
  if (value === undefined) throw new Error("missing child secret");
  const secret = new Uint8Array(value.length / 2);
  for (let index = 0; index < secret.length; index += 1) {
    secret[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return secret;
}

function childIdOf(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
): string {
  const index = port.spawnedProcesses.indexOf(process);
  return port.spawnInputs[index]?.env[WEAVE_CHILD_ID_ENV] ?? "";
}

async function sendEnvelope(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
  kind: PiControlKind,
  sequence: number,
  body: JsonValue = {},
): Promise<void> {
  const index = port.spawnedProcesses.indexOf(process);
  const generationId =
    port.spawnInputs[index]?.env[WEAVE_CONTROLLER_GENERATION_ENV];
  if (generationId === undefined) throw new Error("missing generation id");
  const childId = childIdOf(process, port);
  const envelope = await signEnvelope(
    {
      childId,
      generationId,
      direction: "child-to-parent",
      sequence,
      nonce: generateNonceHex(new WebCryptoRandomPort()),
      correlationId: childId,
      kind,
      body,
    },
    extractSecret(process, port),
    new WebCryptoHmacPort(),
  );
  process.emitLine(envelope._unsafeUnwrap());
  await flush();
}

async function sendHandshakeAndBootstrapAck(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
): Promise<void> {
  await sendEnvelope(process, port, "handshake", 1);
  await sendEnvelope(process, port, "bootstrap-ack", 2);
}

async function spawnChild(
  host: RecordingFakePiHost,
  processPort: FakeChildProcessPort,
): Promise<FakeSpawnedProcess> {
  const registration = host.registerToolCalls.find(
    (call) => call.name === "weave_delegate",
  );
  expect(registration).toBeDefined();
  void registration?.execute(
    "transition-call",
    { agent: "shuttle", task: "hold this child" },
    undefined,
    undefined,
    host.createSessionContext(),
  );
  for (let tick = 0; tick < 50; tick += 1) {
    if (processPort.spawnedProcesses[0] !== undefined) {
      const process = processPort.spawnedProcesses[0];
      await sendHandshakeAndBootstrapAck(process, processPort);
      return process;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("child was not spawned");
}

function makeController(
  processPort: FakeChildProcessPort,
  overrides: Partial<
    ConstructorParameters<typeof PiDelegationController>[0]
  > = {},
): PiDelegationController {
  return new PiDelegationController({
    config: EMPTY_CONFIG,
    generationId: "gen-1",
    idGenerator: new FakeIdGenerator(),
    logger: new RecordingLogger(),
    processPort,
    sessionStorageAuthority:
      TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY,
    randomPort: new WebCryptoRandomPort(),
    hmacPort: new WebCryptoHmacPort(),
    cancelGraceMs: 1,
    ...overrides,
  });
}

function pendingRequest() {
  return {
    parentId: "root",
    parentDepth: 0,
    parentAgentName: "loom",
    agentName: "shuttle",
    task: "hold this child",
    cwd: "/fake/project",
    env: {},
    bootstrap: {},
  } as const;
}

function seedPendingThread(controller: PiDelegationController): void {
  const record: PiChildRefRecord = {
    childId: "child-1",
    threadId: "thread-1",
    nativeSessionId: "native-1",
    sessionRef: "workspace/child-1/session.jsonl",
    originParentSessionId: "origin-session",
    originEntryId: "origin-entry",
    title: "shuttle",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    runs: [
      {
        run: 1,
        action: "start",
        startedAt: 1,
      },
    ],
  };
  const state = {
    threadId: "thread-1",
    agentName: "shuttle",
    parentId: "root",
    parentDepth: 0,
    parentAgentName: "loom",
    ownerParentSessionId: "origin-session",
    cwd: "/fake/project",
    env: {},
    model: undefined,
    reasoning: undefined,
    latestChildId: "child-1",
    status: "running",
    runs: 1,
    lastRetryable: undefined,
    running: true,
  };
  const internals = controller as unknown as {
    readonly threads: Map<string, typeof state>;
    readonly threadRecords: Map<string, PiChildRefRecord>;
    readonly queue: Array<{
      childId: string;
      request: ReturnType<typeof pendingRequest>;
      resolve: (result: unknown) => void;
    }>;
  };
  internals.threads.set(state.threadId, state);
  internals.threadRecords.set(record.threadId, record);
  internals.queue.push({
    childId: "child-1",
    request: pendingRequest(),
    resolve: () => undefined,
  });
}

class RecordingRefPort implements PiThreadRefPort {
  readonly events: string[] = [];
  readonly records: Array<{ status: string }> = [];
  fail = false;

  liveParentSessionId(): string {
    return "origin-session";
  }

  readRefs(): import("neverthrow").ResultAsync<
    PiChildRefScan,
    PiChildRefError
  > {
    return okAsync({
      refs: [],
      issues: [],
      counts: {
        scannedEntries: 0,
        candidateEntries: 0,
        malformedEntries: 0,
        originMismatchedChildren: 0,
        conflictingChildren: 0,
        duplicateEntries: 0,
        unusableSourceChildren: 0,
        usableRefs: 0,
      },
    });
  }

  appendNewChild(
    input: AppendNewChildRefInput,
  ): import("neverthrow").ResultAsync<PiChildRefRecord, PiChildRefError> {
    this.events.push("append-new-child");
    if (this.fail) return errAsync(refWriteFailure());
    return okAsync({
      childId: input.childId,
      threadId: input.threadId ?? input.childId,
      nativeSessionId: input.nativeSessionId,
      sessionRef: input.sessionRef,
      originParentSessionId: "origin-session",
      originEntryId: "origin-entry",
      title: input.title,
      status: input.status ?? "queued",
      createdAt: 1,
      updatedAt: 1,
      runs:
        input.run === undefined
          ? []
          : [{ run: 1, ...input.run } satisfies PiChildRefRun],
    });
  }

  appendRunDivider(
    record: PiChildRefRecord,
    input: AppendChildRefRunInput,
  ): import("neverthrow").ResultAsync<PiChildRefRecord, PiChildRefError> {
    this.events.push("append-run-divider");
    if (this.fail) return errAsync(refWriteFailure());
    return okAsync({
      ...record,
      updatedAt: record.updatedAt + 1,
      runs: [
        ...record.runs,
        {
          run: record.runs.length + 1,
          startedAt: record.updatedAt + 1,
          action: input.action,
          priorOutcome: input.priorOutcome,
          initiator: input.initiator,
          model: input.model,
          reasoning: input.reasoning,
        },
      ],
    });
  }

  appendLifecycle(
    record: PiChildRefRecord,
    input: AppendChildRefLifecycleInput,
  ): import("neverthrow").ResultAsync<PiChildRefRecord, PiChildRefError> {
    this.events.push("append-lifecycle");
    this.records.push({ status: input.status });
    if (this.fail) return errAsync(refWriteFailure());
    const updatedAt = input.settledAt ?? record.updatedAt + 1;
    return okAsync({
      ...record,
      status: input.status,
      title: input.title ?? record.title,
      updatedAt,
      settledAt: updatedAt,
    });
  }
}

function refWriteFailure(): PiChildRefError {
  return { type: "ChildRefAppendFailed", reason: "host-threw" };
}

describe("Pi session transition contracts", () => {
  it("uses the no-descendant fast path without prompting", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager(),
    });
    const processPort = new FakeChildProcessPort();
    installTransitionExtension(host, processPort);
    await host.triggerSessionStart();

    const result = await invokeHook(host, "session_before_switch", {
      reason: "new",
    });

    expect(result).toBeUndefined();
    expect(host.selectCalls).toHaveLength(0);
    expect(processPort.spawnedProcesses).toHaveLength(0);
  });

  it.each([
    ["Stay", "Stay"],
    ["default", undefined],
    ["cancel", undefined],
    ["timeout", undefined],
  ] as const)("%s vetoes without cancelling a descendant", async (_label, response) => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager(),
    });
    const processPort = new FakeChildProcessPort();
    installTransitionExtension(host, processPort);
    await host.triggerSessionStart();
    const child = await spawnChild(host, processPort);
    if (response === "Stay") host.scriptSelect("Stay");
    else if (_label === "cancel") host.scriptSelect(undefined);
    else if (_label === "timeout") host.scriptSelect(undefined);
    else host.scriptSelect(undefined);

    const result = await invokeHook(host, "session_before_switch", {
      reason: "resume",
      targetSessionFile: "/fake/next.jsonl",
    });

    expect(result).toEqual({ cancel: true });
    expect(host.selectCalls).toHaveLength(1);
    expect(child.killed).toBe(false);
    expect(child.forceKilled).toBe(false);
  });

  it("orders Proceed as prompt, full subtree cancellation, final settlement, one origin append, then allow", async () => {
    const events: string[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager(),
    });
    const processPort = new FakeChildProcessPort();
    installTransitionExtension(host, processPort);
    await host.triggerSessionStart();
    const child = await spawnChild(host, processPort);
    host.scriptSelect("Proceed");
    events.push("prompt");

    const result = await invokeHook(host, "session_before_switch", {
      reason: "new",
    });
    events.push("hook-return");

    expect(result).toBeUndefined();
    expect(child.killed || child.forceKilled).toBe(true);
    expect(
      host.notifyCalls.some((call) => call.message.includes("Proceed")),
    ).toBe(false);
    expect(events).toEqual(["prompt", "hook-return"]);
  });

  it("vetoes on cancellation failure with a bounded diagnostic", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager(),
    });
    const processPort = new FakeChildProcessPort();
    installTransitionExtension(host, processPort);
    await host.triggerSessionStart();
    const child = await spawnChild(host, processPort);
    // Bootstrap-ack returns before the parent finishes writing the task
    // prompt. Drain those writes first so failNextWrite hits cancel/abort.
    for (let tick = 0; tick < 50; tick += 1) {
      const lines = child.writtenLines();
      const hasTaskPrompt = lines.some((line) => {
        if (
          typeof line !== "object" ||
          line === null ||
          !("type" in line) ||
          (line as { type: unknown }).type !== "prompt"
        ) {
          return false;
        }
        const message = (line as { message?: unknown }).message;
        return typeof message === "string" && !message.includes("__control__");
      });
      if (hasTaskPrompt) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await flush();
    child.failNextWrite({
      type: "WriteFailed",
      reason: "leaked cancellation detail",
    });
    host.scriptSelect("Proceed");

    const result = await invokeHook(host, "session_before_switch", {
      reason: "resume",
    });

    expect(result).toEqual({ cancel: true });
    const diagnostic = host.notifyCalls.at(-1)?.message ?? "";
    expect(diagnostic.length).toBeLessThanOrEqual(240);
    expect(diagnostic).not.toContain("leaked cancellation detail");
    expect(diagnostic).toContain("ChildAbortFailed");
  });

  it("vetoes on origin-ref write failure with a bounded diagnostic", async () => {
    const refs = new RecordingRefPort();
    refs.fail = true;
    const controller = makeController(new FakeChildProcessPort(), {
      threadRefs: () => refs,
    });
    seedPendingThread(controller);
    const result = await controller.settleForTransition();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const diagnostic = JSON.stringify(result.error);
      expect(diagnostic.length).toBeLessThanOrEqual(512);
      expect(diagnostic).not.toContain("ref write failed");
    }
  });

  it.each([
    ["session_before_switch", { reason: "new" }],
    ["session_before_switch", { reason: "resume", targetSessionFile: "/next" }],
    ["session_before_fork", { entryId: "entry-1", position: "before" }],
    ["session_before_fork", { entryId: "entry-1", position: "at" }],
    [
      "session_before_tree",
      {
        preparation: {
          targetId: "target-entry",
          oldLeafId: null,
          commonAncestorId: null,
          entriesToSummarize: [],
          userWantsSummary: false,
        },
        signal: new AbortController().signal,
      },
    ],
  ] as const)("accepts actual Pi result shape for %s", async (event, payload) => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager(),
    });
    const processPort = new FakeChildProcessPort();
    installTransitionExtension(host, processPort);
    await host.triggerSessionStart();

    expect(await invokeHook(host, event, payload)).toBeUndefined();
  });

  it("clears destination notice/source state and does not append origin entries to destination", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager({
        id: "destination-session",
        file: "/fake/destination.jsonl",
      }),
    });
    const processPort = new FakeChildProcessPort();
    installTransitionExtension(host, processPort);
    await host.triggerSessionStart();
    host.scriptSelect("Proceed");
    await invokeHook(host, "session_before_switch", { reason: "new" });
    await host.triggerSessionStart();

    expect(host.appendedEntries).toHaveLength(0);
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
  });

  it("graceful shutdown followed by bounded force-stop leaves no process or capacity", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager(),
    });
    const processPort = new FakeChildProcessPort();
    installTransitionExtension(host, processPort);
    await host.triggerSessionStart();
    const child = await spawnChild(host, processPort);

    const shutdown = host.triggerSessionShutdown();
    await flush();
    child.exit(0);
    await shutdown;

    expect(child.killed || child.forceKilled).toBe(true);
    expect(
      processPort.spawnedProcesses.filter((process) => !process.killed),
    ).toHaveLength(0);
  });

  it("read-only orphan policy permits history/doctor reads but denies every mutation without deleting the child", () => {
    const childId = "orphan-child";
    const deleted = { value: false };
    const state = classifyChildAccess({
      childExists: true,
      originParentSessionId: undefined,
      liveParentSessionId: undefined,
    });
    expect(state).toBe("read-only-orphan");

    const reads: PiChildAccessOperation[] = ["read", "history", "doctor"];
    for (const operation of reads) {
      expect(authorizeChildAccess(childId, state, operation).isOk()).toBe(true);
    }

    const mutations: PiChildAccessOperation[] = [
      "steer",
      "follow-up",
      "retry",
      "continue",
      "delete",
    ];
    for (const operation of mutations) {
      const denied = authorizeChildAccess(childId, state, operation);
      expect(denied.isErr()).toBe(true);
      if (denied.isErr()) {
        expect(denied.error.code).toBe("ChildOrphanReadOnly");
        expect(JSON.stringify(denied.error)).not.toContain(
          "orphan-child-secret",
        );
        expect(JSON.stringify(denied.error).length).toBeLessThanOrEqual(512);
      }
    }

    const mismatched = classifyChildAccess({
      childExists: true,
      originParentSessionId: "origin-session",
      liveParentSessionId: "other-session",
    });
    expect(mismatched).toBe("origin-mismatch");
    const originDenied = authorizeChildAccess(childId, mismatched, "steer");
    expect(originDenied.isErr()).toBe(true);
    if (originDenied.isErr()) {
      expect(originDenied.error.code).toBe("ThreadNotFound");
      expect(originDenied.error.correlation?.reason).toBe("origin-mismatch");
      expect(originDenied.error.correlation?.threadId).toBe(childId);
    }

    // Classification is pure: it never deletes or mutates the child record.
    expect(deleted.value).toBe(false);
  });

  it("does not treat fork/clone origin mismatch as a transition mutation", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager(),
    });
    const processPort = new FakeChildProcessPort();
    installTransitionExtension(host, processPort);
    await host.triggerSessionStart();

    expect(
      await invokeHook(host, "session_before_fork", {
        entryId: "origin-mismatched-entry",
        position: "at",
      }),
    ).toBeUndefined();
    expect(host.appendedEntries).toHaveLength(0);
  });
});

describe("PiDelegationController transition reports", () => {
  it("does not report a descendant after transition settlement", async () => {
    const controller = makeController(new FakeChildProcessPort());
    expect(controller.countUnsettledDescendants()).toBe(0);
    const report = await controller.settleForTransition();
    expect(report.isOk()).toBe(true);
    expect(controller.countUnsettledDescendants()).toBe(0);
  });

  it("writes final origin settlement exactly once after queued cancellation", async () => {
    const refs = new RecordingRefPort();
    const controller = makeController(new FakeChildProcessPort(), {
      threadRefs: () => refs,
    });
    seedPendingThread(controller);

    const first = await controller.settleForTransition();
    const second = await controller.settleForTransition();

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(refs.events).toEqual(["append-lifecycle"]);
    expect(refs.records).toEqual([{ status: "cancelled" }]);
    if (first.isOk()) expect(first.value.settlementsWritten).toBe(1);
    if (second.isOk()) expect(second.value.settlementsWritten).toBe(0);
  });
});
