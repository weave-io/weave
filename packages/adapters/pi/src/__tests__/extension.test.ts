import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import {
  type AgentDescriptor,
  ALL_CAPABILITY_IDS,
  createInMemoryRuntimeStore,
  type MaterializationPlan,
  MemoryRuntimeLogFileSystem,
  type PlanTaskSnapshot,
  queryError,
  type RuntimeStoreError,
} from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import {
  PI_AGENT_BADGE_BG_TOKENS,
  selectAgentBadgeBg,
} from "../agent-cycle.js";
import { DefaultPiCapabilityProber } from "../capability-prober.js";
import {
  generateNonceHex,
  hexToBytes,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import {
  WEAVE_CHILD_ID_ENV,
  WEAVE_CHILD_SECRET_ENV,
  WEAVE_CONTROLLER_GENERATION_ENV,
} from "../child-env.js";
import { type PiControlKind, signEnvelope } from "../child-envelope.js";
import type { PiChildHistoryRecord } from "../child-history-schema.js";
import type { PiChildHistoryStore } from "../child-history-store.js";
import { WEAVE_COMMAND_NAMES } from "../commands.js";
import { PiConfigActivator } from "../config-activator.js";
import type {
  PiThreadCachePort,
  PiThreadRefPort,
  PiThreadSessionPort,
} from "../delegation-controller.js";
import type { PiAdapterFailure } from "../errors.js";
import {
  createPiExtension,
  PI_SHARED_LOG_PATH,
  type PiExtensionDeps,
  parsePiSkillsFromSystemPrompt,
  resolveDirectStepBadgeAgent,
} from "../extension.js";
import type {
  PiThreadSourceFactory,
  PiThreadSources,
} from "../thread-sources.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PI_HOST_COMPATIBILITY_MATRIX } from "../host-compatibility-matrix.js";
import {
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
  type PiHostSurfaceReader,
} from "../host-inventory.js";
import { FakePathContainmentPort } from "../path-containment.js";
import { FakePiPlanCatalogPort } from "../plan-catalog.js";
import type {
  PiRecoveryPointerStore,
  PiWeaveRecoveryPointerV1,
} from "../recovery-pointer.js";
import { InMemoryRecoveryPointerStore } from "../recovery-pointer.js";
import type { JsonValue } from "../strict-json.js";
import { serializeCompletionCandidate } from "../structured-completion.js";
import type { IdGenerator } from "../types.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  ephemeralFakeSessionManager,
  FakeClock,
  FakeIdGenerator,
  persistentFakeSessionManager,
  RecordingFakePiHost,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";
import { MutablePlanStateProvider } from "./fakes/fake-plan-state-provider.js";

const EMPTY_CONFIG = {
  agents: {},
  disabled: { agents: [], skills: [] },
} as unknown as WeaveConfig;

const DIRECT_STEP_CONFIG = (() => {
  const parsed = parseConfig(`
workflow direct-flow {
  description "Direct-step race fixture"
  version 1

  step run {
    name "Run direct step"
    type autonomous
    agent loom
    prompt "Run the direct step"
    completion agent_signal
  }
}
`);
  if (parsed.isErr()) throw new Error(JSON.stringify(parsed.error));
  return {
    ...EMPTY_CONFIG,
    workflows: parsed.value.workflows,
    settings: {},
  } as unknown as WeaveConfig;
})();

const GATED_WORKFLOW_CONFIG = (() => {
  const parsed = parseConfig(`
workflow gated-flow {
  description "Generation lifecycle race fixture"
  version 1

  step review-gate {
    name "Review gate"
    type gate
    agent loom
    prompt "Review the artifact"
    completion review_verdict
  }
}
`);
  if (parsed.isErr()) throw new Error(JSON.stringify(parsed.error));
  return {
    ...EMPTY_CONFIG,
    agents: { loom: {}, shuttle: {} },
    workflows: parsed.value.workflows,
    settings: {},
  } as unknown as WeaveConfig;
})();

/** The two-agent materialization plan the recovery race tests install. */
function recoveryRacePlan(): MaterializationPlan {
  return {
    agents: [
      { agentName: "loom", source: "explicit", descriptor: loomDescriptor() },
      {
        agentName: "shuttle",
        source: "explicit",
        descriptor: tapestryDescriptor({ name: "shuttle" }),
      },
    ],
    errors: [],
  };
}

/**
 * A one-task plan snapshot whose title names the plan it came from, so a test
 * can tell which workflow actually painted a surface.
 */
function namedTaskSnapshot(
  planName: string,
  title = `Task ${planName}`,
): PlanTaskSnapshot {
  return {
    planName,
    contentRevision: "test-revision",
    format: "canonical",
    parents: [{ id: "task-1", title, state: "pending", children: [] }],
    totalParentCount: 1,
    complete: false,
  };
}

/**
 * An in-memory pointer store whose next read can be held open, so a test can
 * park a resolution inside its final recovery-pointer recheck.
 */
class DeferrableRecoveryPointerStore implements PiRecoveryPointerStore {
  private readonly inner = new InMemoryRecoveryPointerStore();
  deferNextRead:
    | (() => ResultAsync<
        PiWeaveRecoveryPointerV1 | undefined,
        PiAdapterFailure
      >)
    | undefined;

  appendPointer(
    pointer: PiWeaveRecoveryPointerV1,
  ): ResultAsync<void, PiAdapterFailure> {
    return this.inner.appendPointer(pointer);
  }

  readLatestPointer(): ResultAsync<
    PiWeaveRecoveryPointerV1 | undefined,
    PiAdapterFailure
  > {
    const deferred = this.deferNextRead;
    if (deferred !== undefined) {
      this.deferNextRead = undefined;
      return deferred();
    }
    return this.inner.readLatestPointer();
  }

  all(): readonly PiWeaveRecoveryPointerV1[] {
    return this.inner.all();
  }
}

/**
 * A `PiConfigActivator` wired to fully in-memory fake ports so extension
 * tests never touch the real filesystem (no real `.weave/config.weave`,
 * global or project, is ever read). `plan` defaults to no descriptors at
 * all, matching the pre-task-7 test fixtures' expectations exactly.
 */
function fakeConfigActivator(
  plan: MaterializationPlan = { agents: [], errors: [] },
  config: WeaveConfig | (() => WeaveConfig) = EMPTY_CONFIG,
): PiConfigActivator {
  return new PiConfigActivator({
    configLoader: {
      load: () => okAsync(typeof config === "function" ? config() : config),
    },
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

function hostSurfaceReader(
  unavailable: readonly PiHostSurfaceId[] = [],
  renderingUnavailable = false,
): PiHostSurfaceReader {
  const unavailableSet = new Set(unavailable);
  return {
    read: () =>
      okAsync(
        PI_HOST_SURFACE_IDS.map((surfaceId) => ({
          surfaceId,
          status:
            unavailableSet.has(surfaceId) ||
            (renderingUnavailable && surfaceId === "status-rendering")
              ? "unavailable"
              : "native",
          details: `test-${surfaceId}`,
        })),
      ),
  };
}

function allNativeWithRenderingFallback(): PiHostSurfaceReader {
  return {
    read: () =>
      okAsync(
        PI_HOST_SURFACE_IDS.map((surfaceId) => ({
          surfaceId,
          status: surfaceId === "status-rendering" ? "fallback" : "native",
          details: "test-controlled",
        })),
      ),
  };
}

function eligibleOrdinaryRecoveryRecord(
  overrides: Partial<PiChildHistoryRecord> = {},
): PiChildHistoryRecord {
  return {
    childId: "recover-me",
    parentSessionId: "parent",
    kind: "ordinary",
    status: "interrupted",
    workflow: {},
    descriptorName: "loom",
    sessionPath: "children/recover-me/session.jsonl",
    activeLeaf: "leaf-1",
    checkpointCursor: 1,
    branchAncestry: [],
    interventionCount: 0,
    finalOutput: "",
    trim: { trimmed: false, markerCount: 0 },
    quarantine: { quarantined: false },
    clear: { cleared: false },
    recovery: { eligible: true, count: 0 },
    bytes: { session: 1, checkpoint: 1, total: 2 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function countedRuntimeStore() {
  const store = createInMemoryRuntimeStore();
  let closeCount = 0;
  const close = store.close.bind(store);
  store.close = () => {
    closeCount += 1;
    return close();
  };
  return {
    store,
    get closeCount() {
      return closeCount;
    },
  };
}

function countedChildHistoryStore(
  input: PiChildHistoryRecord | readonly PiChildHistoryRecord[] = [],
) {
  const history = mutableChildHistoryStore(input);
  let closeCount = 0;
  const store = history.store as PiChildHistoryStore & {
    close: () => ResultAsync<void, never>;
  };
  store.close = () => {
    closeCount += 1;
    return okAsync(undefined);
  };
  return {
    ...history,
    get closeCount() {
      return closeCount;
    },
  };
}

function mutableChildHistoryStore(
  input:
    | PiChildHistoryRecord
    | readonly PiChildHistoryRecord[] = eligibleOrdinaryRecoveryRecord(),
): {
  store: PiChildHistoryStore;
  records: PiChildHistoryRecord[];
  updates: Partial<PiChildHistoryRecord>[];
  cleared: string[];
} {
  const records = [...(Array.isArray(input) ? input : [input])];
  const updates: Partial<PiChildHistoryRecord>[] = [];
  const cleared: string[] = [];
  const clear = (childId: string) => {
    const index = records.findIndex(
      (candidate) => candidate.childId === childId,
    );
    if (index >= 0) {
      records.splice(index, 1);
      cleared.push(childId);
    }
    return okAsync(undefined);
  };
  const store = {
    getIndex: () => ({ records }),
    clear,
    clearTerminal: () => {
      const terminal = records.filter((record) =>
        ["settled", "interrupted", "quarantined", "cleared"].includes(
          record.status,
        ),
      );
      for (const record of terminal) void clear(record.childId);
      return okAsync(terminal.length);
    },
    updateRecord: (childId: string, patch: Partial<PiChildHistoryRecord>) => {
      updates.push(patch);
      const index = records.findIndex(
        (candidate) => candidate.childId === childId,
      );
      const existing = records[index];
      if (existing !== undefined) records[index] = { ...existing, ...patch };
      return okAsync(undefined);
    },
  } as unknown as PiChildHistoryStore;
  return { store, records, updates, cleared };
}

async function flushBackgroundWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function authenticateDirectChild(
  processPort: FakeChildProcessPort,
  process: FakeSpawnedProcess,
): Promise<(kind: PiControlKind, body: JsonValue) => Promise<void>> {
  const input = processPort.spawnInputs.at(-1);
  const childId = input?.env[WEAVE_CHILD_ID_ENV];
  const generationId = input?.env[WEAVE_CONTROLLER_GENERATION_ENV];
  const secretHex = input?.env[WEAVE_CHILD_SECRET_ENV];
  if (
    childId === undefined ||
    generationId === undefined ||
    secretHex === undefined
  ) {
    throw new Error(
      "test setup: direct child bootstrap environment is incomplete",
    );
  }
  const secretBytes = hexToBytes(secretHex);
  if (secretBytes === undefined) {
    throw new Error("test setup: direct child secret is malformed");
  }
  const randomPort = new WebCryptoRandomPort();
  const hmacPort = new WebCryptoHmacPort();
  let sequence = 1;
  const send = async (kind: PiControlKind, body: JsonValue): Promise<void> => {
    const envelope = await signEnvelope(
      {
        childId,
        generationId,
        direction: "child-to-parent",
        sequence: sequence++,
        nonce: generateNonceHex(randomPort),
        correlationId: childId,
        kind,
        body,
      },
      secretBytes,
      hmacPort,
    );
    if (envelope.isErr()) {
      throw new Error(`test setup failed to sign: ${envelope.error.type}`);
    }
    process.emitLine(envelope.value);
  };

  await flushBackgroundWork();
  await send("handshake", {});
  await process.writeCalled;
  const prompt = process.writtenLines()[0] as
    | {
        readonly type: string;
        readonly message: string;
      }
    | undefined;
  if (prompt?.type !== "prompt") {
    throw new Error("test setup: direct child bootstrap prompt is missing");
  }
  const bootstrap = JSON.parse(
    prompt.message.slice("/weave:__control__ ".length),
  ) as { readonly body: { readonly resolvedModel?: string } };
  const resolvedModel = bootstrap.body.resolvedModel;
  await send(
    "bootstrap-ack",
    resolvedModel === undefined ? {} : { resolvedModel },
  );
  await flushBackgroundWork();
  return send;
}

async function completeDirectChild(
  processPort: FakeChildProcessPort,
  process: FakeSpawnedProcess,
): Promise<void> {
  const send = await authenticateDirectChild(processPort, process);
  await send("settled", {
    outcome: "completed",
    completionCandidate: serializeCompletionCandidate({
      outcome: "paused",
      method: "review_verdict",
      approved: false,
      message: "GENERATION_LIFECYCLE_PAUSED",
    }),
    interventionCount: 0,
    assistantOutput: "",
  });
}

function deferredResultAsync<T, E>(
  fallbackError: E,
): {
  readonly called: Promise<void>;
  readonly start: () => ResultAsync<T, E>;
  readonly settle: (result: Result<T, E>) => void;
} {
  let resolveCalled!: () => void;
  let resolveResult!: (result: Result<T, E>) => void;
  let result: ResultAsync<T, E> | undefined;
  const called = new Promise<void>((resolve) => {
    resolveCalled = resolve;
  });

  return {
    called,
    start: () => {
      if (result !== undefined) return result;
      result = ResultAsync.fromPromise(
        new Promise<Result<T, E>>((resolve) => {
          resolveResult = resolve;
        }),
        () => fallbackError,
      ).andThen((settled) => settled);
      resolveCalled();
      return result;
    },
    settle: (settled) => resolveResult(settled),
  };
}

function installRecoveryExtension(
  host: RecordingFakePiHost,
  store: PiChildHistoryStore,
  restoreOrdinaryChild: NonNullable<PiExtensionDeps["restoreOrdinaryChild"]>,
  settings: { readonly recovery_countdown_seconds?: number } = {},
) {
  return installExtension(host, "0.81.1", {
    capabilityProber: allOkCapabilityProber(),
    configActivator: fakeConfigActivator(
      {
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      },
      {
        ...EMPTY_CONFIG,
        settings: { adapters: { pi: { child_inspection: { ...settings } } } },
      } as unknown as WeaveConfig,
    ),
    runtimeStoreFactory: { open: () => okAsync(createInMemoryRuntimeStore()) },
    parentSessionId: () => "parent",
    childHistoryStoreFactory: () => okAsync(store),
    restoreOrdinaryChild,
  });
}

function planSnapshotFixture(
  planName = "weave-plan-command",
  complete = false,
): PlanTaskSnapshot {
  return {
    planName,
    contentRevision: "test-revision",
    format: "canonical",
    parents: [
      {
        id: "task-1",
        title: "Finish task",
        state: complete ? "completed" : "pending",
        children: [],
      },
    ],
    totalParentCount: 1,
    complete,
  };
}

function installExtension(
  host: RecordingFakePiHost,
  hostVersion = "0.81.1",
  overrides: Partial<PiExtensionDeps> = {},
) {
  const factory = createPiExtension({
    hostPackageReader: FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: hostVersion,
    }),
    capabilityProber: new DefaultPiCapabilityProber(),
    idGenerator: new FakeIdGenerator(),
    clock: new FakeClock(),
    logger: new RecordingLogger(),
    planStateProviderFactory: () =>
      new MutablePlanStateProvider(planSnapshotFixture()),
    configActivator: fakeConfigActivator(),
    // Real `BunPathContainmentPort` spawns a genuine subprocess (Pi adapter contract
    // forbids this in tests); this fake host's `cwd` is a
    // nonexistent path anyway, so any real spawn would fail closed and
    // wrongly flip workflow-persistence/etc. to unavailable for reasons
    // unrelated to what any given test actually exercises. Reports every
    // containment check as safe instead.
    pathContainmentPort: new FakePathContainmentPort(
      new Map(),
      ok("/fake/project"),
    ),
    // Opt out of production Task 4/5/6 source opening (real XDG + SessionManager).
    // Thread-source wiring tests inject an explicit factory via overrides.
    threadSourceFactory: undefined,
    ...overrides,
  });
  factory(host.api);
  return factory;
}

describe("createPiExtension factory (layer C: compiled extension against a fake host)", () => {
  it("registers commands, the palette shortcut, and six lifecycle delegates without a tool-call interceptor", () => {
    const host = new RecordingFakePiHost();
    installExtension(host);
    expect(host.registerCommandCalls.map((call) => call.name).sort()).toEqual(
      [...WEAVE_COMMAND_NAMES, "weave"].sort(),
    );
    expect(host.registerShortcutCalls).toEqual([
      {
        shortcut: "alt+a",
        registration: {
          description: "Cycle Weave primary agent",
          handler: expect.any(Function),
        },
      },
      {
        shortcut: "alt+t",
        registration: {
          description: "Show Weave plan tasks",
          handler: expect.any(Function),
        },
      },
    ]);
    expect(host.onCalls.map((call) => call.event).sort()).toEqual([
      "agent_start",
      "before_agent_start",
      "input",
      "message_end",
      "session_before_fork",
      "session_before_switch",
      "session_before_tree",
      "session_shutdown",
      "session_start",
    ]);
  });

  it("performs no work before session_start: no notify/status/widget calls happen at factory time", () => {
    const host = new RecordingFakePiHost();
    installExtension(host);
    expect(host.notifyCalls).toHaveLength(0);
    expect(host.statusCalls).toHaveLength(0);
    expect(host.widgetCalls).toHaveLength(0);
  });

  it("redirects shared logs before session activation when a redirector is supplied", async () => {
    const redirectedPaths: string[] = [];
    const host = new RecordingFakePiHost({ cwd: "/fake/project" });
    installExtension(host, "0.81.1", {
      logRedirector: {
        redirect: (filePath) => {
          redirectedPaths.push(filePath);
          return okAsync(undefined);
        },
      },
    });

    await host.triggerSessionStart();

    expect(redirectedPaths).toEqual([`/fake/project/${PI_SHARED_LOG_PATH}`]);
  });

  it("does not touch timers or spawn processes at factory time", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalSpawn = Bun.spawn;
    let timerCalls = 0;
    let spawnCalls = 0;
    const spySetTimeout = ((
      ...args: Parameters<typeof setTimeout>
    ): ReturnType<typeof setTimeout> => {
      timerCalls += 1;
      return originalSetTimeout(...args);
    }) as typeof setTimeout;
    const spySpawn = ((
      ...args: Parameters<typeof Bun.spawn>
    ): ReturnType<typeof Bun.spawn> => {
      spawnCalls += 1;
      return originalSpawn(...(args as Parameters<typeof originalSpawn>));
    }) as typeof Bun.spawn;
    globalThis.setTimeout = spySetTimeout;
    Bun.spawn = spySpawn;
    try {
      const host = new RecordingFakePiHost();
      installExtension(host);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      Bun.spawn = originalSpawn;
    }
    expect(timerCalls).toBe(0);
    expect(spawnCalls).toBe(0);
  });

  it("becomes ready (health-only false is possible) when every probe is fully controlled to ok via the injected prober", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const factory = createPiExtension({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: allOkCapabilityProber(),
      idGenerator: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger: new RecordingLogger(),
      // A real project always materializes at least one agent, so this
      // fixture includes one to reach a healthy ready outcome.
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
      pathContainmentPort: new FakePathContainmentPort(
        new Map(),
        ok("/fake/project"),
      ),
    });
    factory(host.api);
    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
  });

  it("accepts injected rendering fallback and all required native surfaces through the real session lifecycle", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    let readerCalls = 0;
    const reader = allNativeWithRenderingFallback();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: {
        read: (input) => {
          readerCalls += 1;
          return reader.read(input);
        },
      },
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
    });
    expect(readerCalls).toBe(0);
    await host.triggerSessionStart();
    expect(readerCalls).toBe(1);
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
  });

  it("fails closed for every host reader failure without writes or an unbounded notification", async () => {
    const readers: readonly PiHostSurfaceReader[] = [
      {
        read: () => {
          throw new Error("secret-reader-path");
        },
      },
      { read: () => Promise.reject(new Error("secret-rejection")) as never },
      { read: () => errAsync({ type: "ReaderRejected" }) },
      { read: () => okAsync("not-an-array" as unknown as readonly unknown[]) },
    ];
    for (const reader of readers) {
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      let runtimeWrites = 0;
      let historyWrites = 0;
      let processWrites = 0;
      installExtension(host, "0.81.1", {
        capabilityProber: allOkCapabilityProber(),
        hostSurfaceReader: reader,
        runtimeStoreFactory: {
          open: () => {
            runtimeWrites += 1;
            return okAsync(createInMemoryRuntimeStore());
          },
        },
        childHistoryStoreFactory: () => {
          historyWrites += 1;
          return okAsync(undefined as never);
        },
        processPort: {
          spawn: () => {
            processWrites += 1;
            return errAsync({ type: "spawn-failed" });
          },
        } as unknown as PiExtensionDeps["processPort"],
      });
      await host.triggerSessionStart();
      const weaveStatuses = host.statusCalls.filter(
        (call) => call.key === "weave",
      );
      expect(weaveStatuses.at(-1)?.value).toContain("health-only");
      expect(
        weaveStatuses.filter((call) => call.value?.includes("health-only"))
          .length,
      ).toBeLessThanOrEqual(2);
      expect(runtimeWrites).toBe(0);
      expect(historyWrites).toBe(0);
      expect(processWrites).toBe(0);
      expect(
        host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value
          ?.length ?? 0,
      ).toBeLessThan(120);
      await host.invokeCommand("weave:health");
      expect(host.notifyCalls.at(-1)?.message).toContain("health-only");
      // The health report now names every missing host surface with the full
      // six-field Spec 33 §16 diagnostic, so the bound covers the declared
      // maximum: MAX_RENDERED_HOST_SURFACE_GAPS diagnostics of bounded length
      // plus the capability lines. It is still a fixed ceiling, not host data.
      expect(host.notifyCalls.at(-1)?.message.length).toBeLessThan(6000);
    }
  });

  it("makes each required surface fail closed while rendering loss uses the fallback and stays ready", async () => {
    const required = PI_HOST_SURFACE_IDS.filter((surfaceId) =>
      PI_HOST_COMPATIBILITY_MATRIX.surfaces.some(
        (surface) => surface.id === surfaceId && surface.required,
      ),
    ).slice(-6);
    for (const surfaceId of required) {
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      installExtension(host, "0.81.1", {
        capabilityProber: allOkCapabilityProber(),
        hostSurfaceReader: hostSurfaceReader([surfaceId]),
      });
      await host.triggerSessionStart();
      expect(
        host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
      ).toContain("health-only");
    }
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader([], true),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
    });
    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
  });

  it("renders every missing required surface in /weave:health with all six diagnostic fields", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(["rpc-session-tree-read"]),
    });
    await host.triggerSessionStart();
    await host.invokeCommand("weave:health");

    const message = host.notifyCalls.at(-1)?.message ?? "";
    expect(message).toContain("Weave adapter mode: health-only");
    // All six Spec 33 §16 strong-debug fields reach active health reporting.
    expect(message).toContain("host surface gap:");
    expect(message).toContain("capability: rpc-session-tree-read");
    expect(message).toContain("host version:");
    expect(message).toContain("contract:");
    expect(message).toContain("probe:");
    expect(message).toContain("mode: health-only");
    expect(message).toContain("remediation:");
    // The fallback decision Task 12 consumes is reported too.
    expect(message).toContain("child inspection: native-overlay");
    expect(message.length).toBeLessThan(6000);
  });

  it("reports the custom-editor fallback in /weave:health without entering health-only", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(["child-overlay-lifecycle"]),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
    });
    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");

    await host.invokeCommand("weave:health");
    const message = host.notifyCalls.at(-1)?.message ?? "";
    expect(message).toContain("Weave adapter mode: ready");
    expect(message).toContain("capability: child-overlay-lifecycle");
    expect(message).toContain("mode: custom-editor-fallback");
    expect(message).toContain("child inspection: custom-editor");
  });

  it("reads once per session generation and keeps each normalized report immutable", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    let calls = 0;
    const firstRows = PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: "native",
      details: "first",
    }));
    const secondRows = PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: surfaceId === "editor-composition" ? "unavailable" : "native",
      details: "second",
    }));
    const reader: PiHostSurfaceReader = {
      read: () => okAsync(++calls === 1 ? firstRows : secondRows),
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: reader,
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
    });
    expect(calls).toBe(0);
    await host.triggerSessionStart();
    expect(calls).toBe(1);
    const firstGeneration = host.statusCalls
      .filter((call) => call.key === "weave")
      .at(-1)?.value;
    await host.triggerSessionStart();
    expect(calls).toBe(2);
    const secondGeneration = host.statusCalls
      .filter((call) => call.key === "weave")
      .at(-1)?.value;
    expect(secondGeneration).toContain("health-only");
    expect(secondGeneration).not.toBe(firstGeneration);
    const firstRow = firstRows[0];
    expect(firstRow).toBeDefined();
    if (firstRow) firstRow.details = "mutated-after-session";
    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).not.toContain(
      "mutated-after-session",
    );
  });

  it("enters health-only mode (real prober) on a fresh trusted TUI session, since later subsystems are not implemented yet, and blocks mutating commands", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("health-only");
    expect(host.registerToolCalls).toEqual([]);
    const ctx = await host.invokeCommand("weave:start");
    expect(host.notifyCalls.at(-1)?.message).toContain("health-only mode");
    expect(ctx.mode).toBe("tui");
  });

  it("still allows weave:health and weave:status and weave:abort while in health-only mode", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "Weave adapter mode: health-only",
    );
    await host.invokeCommand("weave:status");
    expect(host.notifyCalls.at(-1)?.message).toContain("health-only: true");
    await host.invokeCommand("weave:abort");
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "No active Weave execution",
    );
  });

  it("blocks activation into a wrong mode as health-only", async () => {
    const host = new RecordingFakePiHost({ mode: "print", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("health-only");
  });

  it("blocks activation on an unsupported host version", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.80.0");
    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("health-only");
  });

  it("detects a command collision from a rival extension and reports command-entrypoints as unavailable via /weave:health", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    host.renameOwnCommand("weave:health", "weave:health:2");
    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("health-only");
    // The rename simulates what Pi's inventory (`getCommands()`) reports after a
    // collision; our own registered handler is still invoked under its original
    // name -- `/weave:health` remains read-only and available in health-only mode.
    await host.invokeCommand("weave:health");
    const message = host.notifyCalls.at(-1)?.message;
    expect(message).toContain("Weave adapter mode: health-only");
    expect(message).toContain(
      "command-entrypoints: unsupported (declared native)",
    );
    const status = await host.invokeCommand("weave:status");
    expect(status).toBeDefined();
  });

  it("detects a command collision even when a rival extension's suffixed entry collides on our base name while we keep it", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    host.injectForeignCommand("weave:health:1");
    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("health-only");
    await host.invokeCommand("weave:health");
    const message = host.notifyCalls.at(-1)?.message;
    expect(message).toContain(
      "command-entrypoints: unsupported (declared native)",
    );
  });

  it("surfaces a poisoned getCommands() host failure as a notification rather than throwing", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    host.poisonGetCommands();
    await host.triggerSessionStart();
    expect(host.notifyCalls.some((call) => call.level === "error")).toBe(true);
  });

  it("surfaces a malformed getCommands() payload as a notification rather than throwing", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    host.returnMalformedCommands();
    await host.triggerSessionStart();
    expect(host.notifyCalls.some((call) => call.level === "error")).toBe(true);
  });

  it("shuts down idempotently on repeated session_shutdown events", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    await host.triggerSessionShutdown();
    await host.triggerSessionShutdown();
    // No throw means the idempotent cleanup path held.
    expect(
      host.onCalls.filter((call) => call.event === "session_shutdown"),
    ).toHaveLength(1);
  });

  it("gives each generation a fresh session context object, never a shared reference", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    const ctxA = await host.triggerSessionStart();
    const ctxB = await host.triggerSessionStart();
    expect(ctxA).not.toBe(ctxB);
  });

  it("clears the compact plan widget on session_shutdown (Pi adapter contract) alongside the child-tree widget", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    await host.triggerSessionShutdown();
    const planWidgetCalls = host.widgetCalls.filter(
      (call) => call.key === "weave-plan",
    );
    expect(planWidgetCalls.length).toBeGreaterThan(0);
    expect(planWidgetCalls.at(-1)?.value).toBeUndefined();
    const taskFooterCalls = host.statusCalls.filter(
      (call) => call.key === "weave-task",
    );
    expect(taskFooterCalls.length).toBeGreaterThan(0);
    expect(taskFooterCalls.at(-1)).toEqual({
      key: "weave-task",
      value: undefined,
    });
  });
});

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

function tapestryDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return loomDescriptor({
    name: "tapestry",
    composedPrompt: "You are Tapestry, the workflow orchestrator.",
    ...overrides,
  });
}

function installForegroundStartTestExtension(
  host: RecordingFakePiHost,
  tapestryOverrides: Partial<AgentDescriptor> = {},
): void {
  installExtension(host, "0.81.1", {
    capabilityProber: allOkCapabilityProber(),
    configActivator: fakeConfigActivator({
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "tapestry",
          source: "explicit",
          descriptor: tapestryDescriptor(tapestryOverrides),
        },
      ],
      errors: [],
    }),
    planCatalogPort: new FakePiPlanCatalogPort(["model-thinking-suffix"]),
    runtimeStoreFactory: {
      open: () =>
        errAsync({
          code: "RuntimeStoreOpenFailed",
          phase: "persistence",
          scope: { kind: "adapter" },
          impact: "health-only",
          retryable: true,
          recovery: "retry",
          safeMessage: "The runtime store is unavailable in this test.",
        }),
    },
  });
}

describe("strict boot primary activation", () => {
  it("fully commits default Loom during session_start before returning", async () => {
    const catalogModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [catalogModel],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({
              models: ["anthropic/claude-sonnet-4-5#high"],
            }),
          },
        ],
        errors: [],
      }),
    });

    await host.triggerSessionStart();

    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
      { kind: "thinking", level: "high" },
    ]);
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    expect(host.statusCalls).toContainEqual({ key: "weave", value: "ready" });
    expect(host.beforeAgentStartCalls).toBe(0);
    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.sendMessageCalls).toHaveLength(0);
  });

  it("only appends the committed prompt on a subsequent before_agent_start", async () => {
    const catalogModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [catalogModel],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({
              models: ["anthropic/claude-sonnet-4-5#high"],
            }),
          },
        ],
        errors: [],
      }),
    });

    await host.triggerSessionStart();
    const activationCalls = [...host.activationCalls];
    const committedBadge = host.statusCalls
      .filter((call) => call.key === "weave-agent")
      .at(-1);

    const turn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(turn.systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.activationCalls).toEqual(activationCalls);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual(committedBadge);
  });

  it("reads the boot skill catalog from the session context and resolves skills before the first turn", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [
        { name: "tdd", filePath: "/fake/skills/tdd/SKILL.md" },
      ],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ models: [], skills: ["tdd"] }),
          },
        ],
        errors: [],
      }),
    });

    await host.triggerSessionStart();

    expect(host.getSystemPromptOptionsCalls).toBeGreaterThan(0);
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });

    const turn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(turn.systemPrompt).toContain("You are Loom, the main orchestrator.");
  });

  it("loads boot skills from Pi's host-owned system prompt when command options are unavailable", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptOptionsAvailable: false,
      systemPromptSkills: [
        { name: "tdd", filePath: "/fake/skills/tdd/SKILL.md" },
      ],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ models: [], skills: ["tdd"] }),
          },
        ],
        errors: [],
      }),
    });

    await host.triggerSessionStart();

    expect(host.getSystemPromptOptionsCalls).toBe(0);
    expect(host.getSystemPromptCalls).toBeGreaterThan(0);
    expect(host.statusCalls).toContainEqual({
      key: "weave",
      value: "ready",
    });
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    expect(host.beforeAgentStartCalls).toBe(0);
  });

  it("parses Pi's escaped host skill catalog and rejects malformed XML", () => {
    expect(
      parsePiSkillsFromSystemPrompt(`native
<available_skills>
  <skill>
    <name>test&amp;verify</name>
    <description>ignored</description>
    <location>/tmp/a&amp;b/SKILL.md</location>
  </skill>
</available_skills>`),
    ).toEqual(
      ok([
        {
          name: "test&verify",
          filePath: "/tmp/a&b/SKILL.md",
        },
      ]),
    );
    expect(
      parsePiSkillsFromSystemPrompt(
        "<available_skills><skill><name>broken</name></skill></available_skills>",
      ).isErr(),
    ).toBe(true);
  });

  it("ignores prose references before Pi's skill catalog", () => {
    expect(
      parsePiSkillsFromSystemPrompt(`Skills are listed in the <available_skills> catalog.
After loading a skill, follow its instructions.
<available_skills>
  <skill>
    <name>diagnose</name>
    <description>ignored</description>
    <location>/skills/diagnose/SKILL.md</location>
  </skill>
</available_skills>`),
    ).toEqual(
      ok([
        {
          name: "diagnose",
          filePath: "/skills/diagnose/SKILL.md",
        },
      ]),
    );
  });

  it("rejects ambiguous, unsupported, duplicate, and unbounded skill catalogs", () => {
    const catalog = (body: string): string =>
      `<available_skills>${body}</available_skills>`;
    const skill = (
      name: string,
      description = "description",
      location = `/skills/${name}/SKILL.md`,
    ): string =>
      `<skill><name>${name}</name><description>${description}</description><location>${location}</location></skill>`;

    const invalidCatalogs = [
      "<available_skills>",
      "</available_skills>",
      catalog("stray"),
      catalog("<skill><name>unclosed</name>"),
      catalog(
        "<skill><location>/x</location><description>d</description><name>reversed</name></skill>",
      ),
      catalog(
        "<skill><name>stray-field</name><description>d</description><extra>x</extra><location>/x</location></skill>",
      ),
      catalog(
        "<skill><name>one</name><name>two</name><description>d</description><location>/x</location></skill>",
      ),
      catalog(
        "<skill><name>duplicate-description</name><description>one</description><description>two</description><location>/x</location></skill>",
      ),
      catalog(
        "<skill><name>duplicate-location</name><description>d</description><location>/one</location><location>/two</location></skill>",
      ),
      catalog(skill("")),
      catalog(skill("empty-location", "description", "")),
      catalog(skill("duplicate") + skill("duplicate")),
      catalog(skill("unsupported&copy;")),
      `${catalog(skill("one"))}${catalog(skill("two"))}`,
      catalog(skill("n".repeat(257))),
      catalog(skill("name", "d".repeat(64 * 1024 + 1))),
      catalog(skill("name", "description", `/${"x".repeat(16 * 1024)}`)),
      "x".repeat(4 * 1024 * 1024 + 1),
      catalog(
        Array.from({ length: 2_049 }, (_, index) => skill(`s-${index}`)).join(
          "",
        ),
      ),
    ];

    for (const prompt of invalidCatalogs) {
      expect(parsePiSkillsFromSystemPrompt(prompt).isErr()).toBe(true);
    }
  });

  it("does not report ready or retry after boot activation fails", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ mode: "subagent" }),
          },
        ],
        errors: [],
      }),
    });

    await host.triggerSessionStart();

    await host.invokeCommand("weave:health");
    const healthMessage = host.notifyCalls.at(-1)?.message ?? "";
    expect(healthMessage).not.toContain("ready");

    await host.invokeCommand("weave:start");
    expect(host.notifyCalls.at(-1)?.message).toBe(
      "Weave activation could not complete.",
    );
    expect(host.registerToolCalls).toHaveLength(0);
    expect(host.getActiveTools()).toEqual([]);

    expect(
      host.statusCalls.some(
        (call) => call.key === "weave" && call.value === "ready",
      ),
    ).toBe(false);
    expect(
      host.statusCalls.filter(
        (call) => call.key === "weave-agent" && call.value === "◆ WEAVE · LOOM",
      ),
    ).toHaveLength(0);

    const turn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(turn.systemPrompt).toBe("native");
    expect(host.activationCalls).toHaveLength(0);
    expect(
      host.statusCalls.filter(
        (call) => call.key === "weave-agent" && call.value === "◆ WEAVE · LOOM",
      ),
    ).toHaveLength(0);
  });

  it("ignores a stale boot activation after a replacement session_start", async () => {
    const catalogModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    };
    const replacementModel = {
      provider: "openai",
      id: "gpt-5.2-codex",
    };
    let plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor({
            models: ["anthropic/claude-sonnet-4-5#high"],
          }),
        },
      ],
      errors: [],
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [catalogModel, replacementModel],
    });
    const deferred = host.deferNextSetModel();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: new PiConfigActivator({
        configLoader: { load: () => okAsync(EMPTY_CONFIG) },
        materializer: { materialize: () => okAsync(plan) },
      }),
    });

    const staleStart = host.triggerSessionStart();
    await deferred.called;
    expect(host.setModelCalls).toHaveLength(1);
    expect(
      host.statusCalls.some(
        (call) => call.key === "weave" && call.value === "ready",
      ),
    ).toBe(false);
    expect(host.registerToolCalls).toHaveLength(0);
    expect(host.getActiveTools()).toEqual([]);

    plan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor({
            models: ["openai/gpt-5.2-codex#high"],
          }),
        },
      ],
      errors: [],
    };
    const replacementStart = host.triggerSessionStart();
    deferred.settle(true);
    await staleStart;
    await replacementStart;
    const statusAfterReplacement = [...host.statusCalls];
    const toolCountAfterReplacement = host.registerToolCalls.length;
    const activeToolsAfterReplacement = host.getActiveTools();

    expect(host.statusCalls).toEqual(statusAfterReplacement);
    expect(host.registerToolCalls).toHaveLength(toolCountAfterReplacement);
    expect(host.getActiveTools()).toEqual(activeToolsAfterReplacement);
    expect(host.setModelCalls).toEqual([catalogModel, replacementModel]);
    expect(host.getCurrentModel()).toEqual(replacementModel);
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
  });

  it("serializes an explicit Alt+A switch ahead of replacement boot model activation", async () => {
    const bootModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    };
    const switchModel = {
      provider: "openai",
      id: "gpt-5.2-codex",
    };
    const replacementModel = {
      provider: "google",
      id: "gemini-2.5-pro",
    };
    let plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor({
            models: ["anthropic/claude-sonnet-4-5#high"],
          }),
        },
        {
          agentName: "tapestry",
          source: "explicit",
          descriptor: tapestryDescriptor({
            models: ["openai/gpt-5.2-codex#high"],
          }),
        },
      ],
      errors: [],
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [bootModel, switchModel, replacementModel],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: new PiConfigActivator({
        configLoader: { load: () => okAsync(EMPTY_CONFIG) },
        materializer: { materialize: () => okAsync(plan) },
      }),
    });

    await host.triggerSessionStart();
    const deferred = host.deferNextSetModel();
    const staleSwitch = host.invokeShortcut("alt+a");
    await deferred.called;

    expect(host.setModelCalls).toEqual([bootModel, switchModel]);
    expect(host.getCurrentModel()).toEqual(bootModel);
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });

    plan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor({
            models: ["google/gemini-2.5-pro#high"],
          }),
        },
      ],
      errors: [],
    };
    const replacementStart = host.triggerSessionStart();
    await flushBackgroundWork();

    // The replacement has revoked the old generation, but boot cannot mutate
    // the host model until the stale switch releases its serialized slot.
    expect(host.setModelCalls).toEqual([bootModel, switchModel]);
    expect(host.getCurrentModel()).toEqual(bootModel);
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: undefined,
    });

    deferred.settle(true);
    await staleSwitch;
    await replacementStart;

    expect(host.setModelCalls).toEqual([
      bootModel,
      switchModel,
      replacementModel,
    ]);
    expect(host.getCurrentModel()).toEqual(replacementModel);
    expect(
      host.statusCalls.filter(
        (call) =>
          call.key === "weave-agent" && call.value === "◆ WEAVE · TAPESTRY",
      ),
    ).toHaveLength(0);
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    expect(
      host.notifyCalls.some(
        (call) => call.message === "Switched Weave primary agent to tapestry.",
      ),
    ).toBe(false);
  });
});

describe("createPiExtension: startup generation races", () => {
  it("does not let a stale preflight overwrite the ready generation", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const nativeSurface = PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: "native" as const,
      details: `test-${surfaceId}`,
    }));
    const firstRead = deferredResultAsync<typeof nativeSurface, never>(
      undefined as never,
    );
    let readCount = 0;
    const history = mutableChildHistoryStore([]);
    const runtimeStore = createInMemoryRuntimeStore();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: {
        read: () => {
          readCount += 1;
          return readCount === 1 ? firstRead.start() : okAsync(nativeSurface);
        },
      },
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
      runtimeStoreFactory: { open: () => okAsync(runtimeStore) },
      childHistoryStoreFactory: () => okAsync(history.store),
    });

    const staleStartup = host.triggerSessionStart();
    await firstRead.called;

    await host.triggerSessionStart();
    const readyStatus = [...host.statusCalls];
    const readyTools = [...host.registerToolCalls];
    const readyActiveTools = host.getActiveTools();
    const readyBadge = host.statusCalls
      .filter((call) => call.key === "weave-agent")
      .at(-1);

    firstRead.settle(ok(nativeSurface));
    await staleStartup;

    expect(host.statusCalls).toEqual(readyStatus);
    expect(host.registerToolCalls).toEqual(readyTools);
    expect(host.getActiveTools()).toEqual(readyActiveTools);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual(readyBadge);
    expect(host.statusCalls).toContainEqual({
      key: "weave",
      value: "ready",
    });
  });

  it("revokes old delegation authority before a blocked replacement preflight settles", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const processPort = new FakeChildProcessPort();
    const nativeSurface = PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: "native" as const,
      details: `test-${surfaceId}`,
    }));
    const replacementRead = deferredResultAsync<typeof nativeSurface, never>(
      undefined as never,
    );
    let readCount = 0;
    installDelegationLifecycleExtension(host, processPort, {
      hostSurfaceReader: {
        read: () => {
          readCount += 1;
          return readCount === 2
            ? replacementRead.start()
            : okAsync(nativeSurface);
        },
      },
    });

    await host.triggerSessionStart();
    const registration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    expect(registration).toBeDefined();
    expect(host.statusCalls).toContainEqual({
      key: "weave",
      value: "ready",
    });
    expect(host.statusCalls).toContainEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });

    const replacementStartup = host.triggerSessionStart();
    await replacementRead.called;

    const revokedResult = await registration?.execute(
      "call-revoked",
      { agent: "shuttle", task: "must fail closed" },
      undefined,
      undefined,
      host.createSessionContext(),
    );

    const revokedText = JSON.parse(
      (revokedResult?.content[0] as { text: string } | undefined)?.text ?? "{}",
    );
    expect(revokedText.ok).toBe(false);
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1),
    ).not.toEqual({ key: "weave", value: "ready" });
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({ key: "weave-agent", value: undefined });

    replacementRead.settle(ok(nativeSurface));
    await replacementStartup;

    expect(host.statusCalls).toContainEqual({
      key: "weave",
      value: "ready",
    });
    expect(host.statusCalls).toContainEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
  });

  it("closes a stale runtime store and keeps the newer runtime generation current", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const nativeSurface = PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: "native" as const,
      details: `test-${surfaceId}`,
    }));
    const staleStore = createInMemoryRuntimeStore();
    const staleClose = staleStore.close.bind(staleStore);
    let staleCloseCount = 0;
    staleStore.close = () => {
      staleCloseCount += 1;
      return staleClose();
    };
    const staleOpen = deferredResultAsync<typeof staleStore, never>(
      undefined as never,
    );
    const currentStore = createInMemoryRuntimeStore();
    const history = mutableChildHistoryStore([]);
    let openCount = 0;
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: { read: () => okAsync(nativeSurface) },
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
      runtimeStoreFactory: {
        open: () => {
          openCount += 1;
          return openCount === 1 ? staleOpen.start() : okAsync(currentStore);
        },
      },
      childHistoryStoreFactory: () => okAsync(history.store),
    });

    const staleStartup = host.triggerSessionStart();
    await staleOpen.called;

    await host.triggerSessionStart();
    const currentStatus = [...host.statusCalls];
    const currentTools = [...host.registerToolCalls];
    const currentActiveTools = host.getActiveTools();

    staleOpen.settle(ok(staleStore));
    await staleStartup;

    expect(staleCloseCount).toBe(1);
    expect(host.statusCalls).toEqual(currentStatus);
    expect(host.registerToolCalls).toEqual(currentTools);
    expect(host.getActiveTools()).toEqual(currentActiveTools);
    expect(currentStore).not.toBe(staleStore);
    expect(host.statusCalls).toContainEqual({
      key: "weave",
      value: "ready",
    });
  });

  it("does not publish stale history, recovery, or inspection state", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const nativeSurface = PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: "native" as const,
      details: `test-${surfaceId}`,
    }));
    const staleHistory = mutableChildHistoryStore([]);
    const currentHistory = mutableChildHistoryStore([]);
    const staleOpen = deferredResultAsync<PiChildHistoryStore, never>(
      undefined as never,
    );
    let historyOpenCount = 0;
    const runtimeStore = createInMemoryRuntimeStore();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: { read: () => okAsync(nativeSurface) },
      configActivator: fakeConfigActivator(
        {
          agents: [
            {
              agentName: "loom",
              source: "explicit",
              descriptor: loomDescriptor(),
            },
          ],
          errors: [],
        },
        {
          ...EMPTY_CONFIG,
          settings: {
            adapters: {
              pi: {
                child_inspection: {
                  persist_history: true,
                  recovery_enabled: false,
                },
              },
            },
          },
        } as unknown as WeaveConfig,
      ),
      runtimeStoreFactory: { open: () => okAsync(runtimeStore) },
      parentSessionId: () => "parent",
      childHistoryStoreFactory: () => {
        historyOpenCount += 1;
        return historyOpenCount === 1
          ? staleOpen.start()
          : okAsync(currentHistory.store);
      },
    });

    const staleStartup = host.triggerSessionStart();
    await staleOpen.called;

    await host.triggerSessionStart();
    const currentStatus = [...host.statusCalls];
    const currentTools = [...host.registerToolCalls];
    const currentActiveTools = host.getActiveTools();
    const currentUpdates = [...currentHistory.updates];
    const currentCleared = [...currentHistory.cleared];

    staleOpen.settle(ok(staleHistory.store));
    await staleStartup;

    expect(host.statusCalls).toEqual(currentStatus);
    expect(host.registerToolCalls).toEqual(currentTools);
    expect(host.getActiveTools()).toEqual(currentActiveTools);
    expect(currentHistory.updates).toEqual(currentUpdates);
    expect(currentHistory.cleared).toEqual(currentCleared);
    expect(host.statusCalls).toContainEqual({
      key: "weave",
      value: "ready",
    });
  });

  it("ignores a direct-step callback from the replaced generation", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    const processPort = new FakeChildProcessPort();
    const nativeSurface = PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: "native" as const,
      details: `test-${surfaceId}`,
    }));
    const replacementRead = deferredResultAsync<typeof nativeSurface, never>(
      undefined as never,
    );
    let readCount = 0;
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: {
        read: () => {
          readCount += 1;
          return readCount === 2
            ? replacementRead.start()
            : okAsync(nativeSurface);
        },
      },
      configActivator: fakeConfigActivator(
        {
          agents: [
            {
              agentName: "loom",
              source: "explicit",
              descriptor: loomDescriptor(),
            },
          ],
          errors: [],
        },
        DIRECT_STEP_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      processPort,
      childCommand: ["/fake/bin/pi"],
    });

    await host.triggerSessionStart();
    const workflowRun = host.invokeCommand("weave:run", "direct-flow");
    const directProcess = await processPort.spawnCalled;
    await flushBackgroundWork();
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });

    const replacementStartup = host.triggerSessionStart();
    await replacementRead.called;
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({
      key: "weave-agent",
      value: undefined,
    });

    directProcess.failStdoutRead("stale generation");
    await workflowRun;
    await flushBackgroundWork();

    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({
      key: "weave-agent",
      value: undefined,
    });

    replacementRead.settle(ok(nativeSurface));
    await replacementStartup;
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
  });
});

describe("createPiExtension: config activation, materialization consumption, primary activation, prompt append", () => {
  it("materializes config, activates the default primary (loom), and never touches a real developer config file", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "Pi's native system prompt.",
    });

    expect(systemPrompt).toContain("Pi's native system prompt.");
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(systemPrompt).toContain('name="loom"');
  });

  it("starts an existing plan by switching the parent session to Tapestry and sending its kickoff as a user message", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    installForegroundStartTestExtension(host);
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeCommand("weave:start", "model-thinking-suffix");

    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · TAPESTRY",
    });
    expect(host.sentUserMessages).toEqual([
      {
        content:
          "Execute the existing Weave plan at `.weave/plans/model-thinking-suffix.md`. Begin with the first unchecked task and continue until every task is complete.",
      },
    ]);
    const nextTurn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(nextTurn.systemPrompt).toContain(
      "You are Tapestry, the workflow orchestrator.",
    );
    expect(nextTurn.systemPrompt).not.toContain(
      "You are Loom, the main orchestrator.",
    );
  });

  it("does not submit a first-turn kickoff when Tapestry cannot activate", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    installForegroundStartTestExtension(host, { mode: "subagent" });
    await host.triggerSessionStart();

    await host.invokeCommand("weave:start", "model-thinking-suffix");

    expect(host.sentUserMessages).toHaveLength(0);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    expect(host.notifyCalls.at(-1)).toEqual({
      message:
        "Could not start plan: The configured Tapestry agent cannot run as a primary agent.",
      level: "error",
    });
  });

  it("does not submit the kickoff when the parent session becomes busy during confirmation", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const confirmation = host.deferNextConfirm();
    installForegroundStartTestExtension(host);
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    const starting = host.invokeCommand("weave:start", "model-thinking-suffix");
    await Bun.sleep(0);
    host.setIdle(false);
    confirmation.settle(true);
    await starting;

    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.notifyCalls.at(-1)).toEqual({
      message:
        "Could not start plan: Wait for the current turn to finish before starting a plan.",
      level: "error",
    });
  });

  it("does not submit the kickoff after session replacement during confirmation", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const confirmation = host.deferNextConfirm();
    installForegroundStartTestExtension(host);
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    const starting = host.invokeCommand("weave:start", "model-thinking-suffix");
    await Bun.sleep(0);
    await host.triggerSessionStart();
    confirmation.settle(true);
    await starting;

    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.notifyCalls.at(-1)).toEqual({
      message:
        "Could not start plan: The Pi session changed before the plan could start.",
      level: "error",
    });
  });

  it("cycles active primary agents with Alt+A, skips subagents, and updates the badge and prompt", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
          {
            agentName: "shuttle",
            source: "explicit",
            descriptor: loomDescriptor({
              name: "shuttle",
              mode: "subagent",
            }),
          },
          {
            agentName: "tapestry",
            source: "explicit",
            descriptor: tapestryDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeShortcut("alt+a");

    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · TAPESTRY",
    });
    expect(host.notifyCalls.at(-1)).toEqual({
      message: "Switched Weave primary agent to tapestry.",
      level: "info",
    });
    const tapestryTurn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(tapestryTurn.systemPrompt).toContain(
      "You are Tapestry, the workflow orchestrator.",
    );
    expect(tapestryTurn.systemPrompt).not.toContain(
      "You are Loom, the main orchestrator.",
    );

    await host.invokeShortcut("alt+a");

    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
  });

  it("never shows a primary badge when the first activation fails", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ mode: "subagent" }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const turn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(turn.systemPrompt).not.toContain(
      "You are Loom, the main orchestrator.",
    );
    expect(
      host.statusCalls.filter(
        (call) => call.key === "weave-agent" && call.value !== undefined,
      ),
    ).toEqual([]);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({ key: "weave-agent", value: undefined });
  });

  it("cycles the committed primary after boot", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
          {
            agentName: "tapestry",
            source: "explicit",
            descriptor: tapestryDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    await host.invokeShortcut("alt+a");

    const firstTurn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(firstTurn.systemPrompt).toContain(
      "You are Tapestry, the workflow orchestrator.",
    );
    expect(firstTurn.systemPrompt).not.toContain(
      "You are Loom, the main orchestrator.",
    );
  });

  it("keeps the active primary and badge when no other primary is eligible", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
          {
            agentName: "tapestry",
            source: "explicit",
            descriptor: tapestryDescriptor({ mode: "subagent" }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeShortcut("alt+a");

    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    expect(host.notifyCalls.at(-1)).toEqual({
      message: "No other Weave primary agent is available.",
      level: "info",
    });
    const nextTurn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(nextTurn.systemPrompt).toContain(
      "You are Loom, the main orchestrator.",
    );
    expect(nextTurn.systemPrompt).not.toContain(
      "You are Tapestry, the workflow orchestrator.",
    );
  });

  it("appends nothing extra when the same descriptor's before_agent_start fires twice", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const first = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    const rerun = await host.triggerBeforeAgentStart({
      systemPrompt: first.systemPrompt,
    });

    expect(rerun.systemPrompt).toBe(first.systemPrompt);
  });

  it("does not append anything when the default primary (loom) is missing from the materialization plan", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({ agents: [], errors: [] }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "Pi's native system prompt.",
    });

    expect(systemPrompt).toBe("Pi's native system prompt.");
  });

  it("consumes ctx.modelRegistry.getAvailable()/ctx.model as the real Pi model discovery context and applies the resolved model via pi.setModel", async () => {
    const catalogModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [catalogModel],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    expect(host.setModelCalls).toEqual([catalogModel]);

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.setModelCalls).toEqual([catalogModel]);
  });

  it("applies a requested thinking level after the model through pi.setThinkingLevel", async () => {
    const catalogModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [catalogModel],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({
              models: ["anthropic/claude-sonnet-4-5#high"],
            }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
      { kind: "thinking", level: "high" },
    ]);

    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
      { kind: "thinking", level: "high" },
    ]);
    expect(host.getCurrentModel()).toBe(catalogModel);
  });

  it("does not report a model failure when pi.setThinkingLevel throws", async () => {
    const catalogModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [catalogModel],
    });
    host.poisonSetThinkingLevel();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ models: ["claude-sonnet-4-5#high"] }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
      { kind: "thinking", level: "high" },
    ]);

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    await host.invokeCommand("weave:health");

    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.getCurrentModel()).toBe(catalogModel);
    expect(host.notifyCalls.at(-1)?.message ?? "").not.toContain(
      "warning [model] loom",
    );
  });

  it("does not report a model failure when pi.setThinkingLevel rejects", async () => {
    const catalogModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [catalogModel],
    });
    host.rejectSetThinkingLevel();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ models: ["claude-sonnet-4-5#high"] }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
      { kind: "thinking", level: "high" },
    ]);

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    await host.invokeCommand("weave:health");

    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.getCurrentModel()).toBe(catalogModel);
    expect(host.notifyCalls.at(-1)?.message ?? "").not.toContain(
      "warning [model] loom",
    );
  });

  it("keeps the current authenticated model and surfaces a visible, deduplicated degraded-model warning when pi.setModel rejects", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    host.poisonSetModel();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    expect(host.setModelCalls).toHaveLength(1);

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    // A degraded model is an accepted terminal state (Pi adapter contract) --
    // the descriptor still activates and its prompt still gets appended.
    // The call was attempted (recorded) even though it threw and never took
    // effect (currentModel stays whatever it was before).
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.setModelCalls).toHaveLength(1);

    const health = await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain("warning [model] loom");
    expect(health).toBeDefined();
  });

  it("treats a resolved false from pi.setModel as a failed application, not success (distinct from a thrown/rejected setModel)", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    host.declineNextSetModel();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    expect(host.setModelCalls).toHaveLength(1);

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    // Non-throwing `false` must be treated exactly like a thrown/rejected
    // setModel: the descriptor still commits (degraded model health), and
    // the host's currentModel is never overwritten as if it had succeeded.
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.getCurrentModel()).toBeUndefined();

    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain("warning [model] loom");
  });

  it("fails closed at boot when ctx.modelRegistry.getAvailable() throws", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.poisonGetAvailableModels();
    const logger = new RecordingLogger();
    installExtension(host, "0.81.1", {
      logger,
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(systemPrompt).toBe("native");
    expect(host.setModelCalls).toHaveLength(0);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1)
        ?.value,
    ).toBeUndefined();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("unavailable");
    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "primary activation failed: PrimaryModelCatalogUnavailable",
    );

    // The failure is represented through the bounded health/status surface;
    // any log record must not contain the raw thrown message.
    expect(JSON.stringify(logger.entries)).not.toContain(
      "ctx.modelRegistry.getAvailable() threw",
    );
    expect(JSON.stringify(logger.entries)).not.toContain("id_rsa");
    expect(JSON.stringify(logger.entries)).not.toContain("sk-super-secret-123");
  });

  it("resolves direct-step badge activity from the active step or committed primary only", () => {
    const committedPrimary = {
      getCurrent: () => ({ descriptor: { name: "loom" } }),
    };
    const pendingPrimary = {
      getCurrent: () => undefined,
    };

    expect(
      resolveDirectStepBadgeAgent(true, "tapestry", committedPrimary),
    ).toBe("tapestry");
    expect(
      resolveDirectStepBadgeAgent(false, "tapestry", committedPrimary),
    ).toBe("loom");
    expect(
      resolveDirectStepBadgeAgent(false, "loom", pendingPrimary),
    ).toBeUndefined();
  });

  it("preserves a native model selected after boot", async () => {
    const weaveModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    };
    const userModel = {
      provider: "openai",
      id: "gpt-5",
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: weaveModel,
      availableModels: [weaveModel, userModel],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });

    await host.triggerModelSelect(userModel, "set");
    const first = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(first.systemPrompt).toContain(
      "You are Loom, the main orchestrator.",
    );
    expect(host.setModelCalls).toHaveLength(1);
    expect(host.getCurrentModel()).toBe(userModel);
    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message ?? "").not.toContain(
      "warning [model] loom",
    );
  });

  it("preserves a native user model change: does not re-apply pi.setModel on a later turn once a primary is already active", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const first = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(host.setModelCalls).toHaveLength(1);

    await host.triggerBeforeAgentStart({ systemPrompt: first.systemPrompt });
    expect(host.setModelCalls).toHaveLength(1);
  });

  it("resolves requested skills from Pi's boot skill catalog, exactly", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [
        { name: "tdd", filePath: "/fake/skills/tdd/SKILL.md" },
      ],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ skills: ["tdd"] }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    // Only the skill's name is ever consumed for matching -- never its body.
    expect(systemPrompt).not.toContain("SKILL.md");
  });

  it("warns and stays ready when a requested skill is missing from Pi's catalog", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
      systemPromptSkills: [],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ skills: ["nonexistent-skill"] }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(systemPrompt).not.toContain(
      'Required skill names to load before work: ["nonexistent-skill"]',
    );
    expect(host.setModelCalls).toHaveLength(1);

    await host.invokeCommand("weave:health");
    const healthMessage = host.notifyCalls.at(-1)?.message ?? "";
    expect(healthMessage).toContain("Weave adapter mode: ready");
    expect(healthMessage).toContain(
      'warning [skill] loom: required skill "nonexistent-skill" is unavailable in Pi; continuing without it',
    );
  });

  it("exposes a declared-temperature capability warning through /weave:health, not just a log line", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ temperature: 0.7 }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "warning [temperature] loom",
    );
  });

  it("never loads or materializes config when the mode is unsupported (Pi adapter contract wrong-mode -> health-only)", async () => {
    let activateCalls = 0;
    const host = new RecordingFakePiHost({ mode: "print", trusted: true });
    installExtension(host, "0.81.1", {
      configActivator: new PiConfigActivator({
        configLoader: {
          load: () => {
            activateCalls += 1;
            return okAsync(EMPTY_CONFIG);
          },
        },
      }),
    });
    await host.triggerSessionStart();
    expect(activateCalls).toBe(0);
    const { systemPrompt } = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(systemPrompt).toBe("native");
  });

  it("never loads or materializes config on an unsupported host version (Pi adapter contract wrong-host -> health-only)", async () => {
    let activateCalls = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.80.0", {
      configActivator: new PiConfigActivator({
        configLoader: {
          load: () => {
            activateCalls += 1;
            return okAsync(EMPTY_CONFIG);
          },
        },
      }),
    });
    await host.triggerSessionStart();
    expect(activateCalls).toBe(0);
  });

  it("logs every MaterializationPlan error without crashing session_start", async () => {
    const logger = new RecordingLogger();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      logger,
      configActivator: fakeConfigActivator({
        agents: [],
        errors: [
          {
            type: "DescriptorCompositionFailure",
            agentName: "broken",
            cause: {
              type: "PromptSourceMissingError",
              agentName: "broken",
              message: "missing prompt",
            },
          },
        ],
      }),
    });

    await host.triggerSessionStart();

    expect(
      logger.entries.some(
        (entry) => entry.level === "warn" && entry.obj.agentName === "broken",
      ),
    ).toBe(true);
  });

  it("shows one no-timeout two-choice settings popup and enters health-only without runtime writes", async () => {
    const invalidConfig = {
      ...EMPTY_CONFIG,
      settings: {
        adapters: {
          pi: {
            child_inspection: { max_bytes_per_child: 1 },
          },
        },
      },
    } as unknown as WeaveConfig;
    let runtimeStoreOpenCalls = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSettingsChoice("Enter health-only mode");
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(
        {
          agents: [
            {
              agentName: "loom",
              source: "explicit",
              descriptor: loomDescriptor(),
            },
          ],
          errors: [],
        },
        invalidConfig,
      ),
      runtimeStoreFactory: {
        open: () => {
          runtimeStoreOpenCalls += 1;
          return errAsync({
            code: "RuntimeStoreOpenFailed",
            phase: "persistence",
            scope: { kind: "adapter" },
            impact: "health-only",
            retryable: true,
            recovery: "retry",
            safeMessage: "The runtime store must not open in health-only mode.",
          });
        },
      },
    });

    await host.triggerSessionStart();

    expect(host.settingsPopupCalls).toHaveLength(1);
    expect(host.settingsPopupCalls[0]).toMatchObject({
      options: ["Use defaults", "Enter health-only mode"],
      opts: undefined,
    });
    expect(host.settingsPopupCalls[0]?.title).toContain(
      "settings.adapters.pi.child_inspection.max_bytes_per_child",
    );
    expect(host.registerToolCalls).toHaveLength(0);
    expect(runtimeStoreOpenCalls).toBe(0);
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("health-only");
  });

  it("applies defaults only after the explicit choice and recovers on a fixed reload", async () => {
    let config: WeaveConfig = {
      ...EMPTY_CONFIG,
      settings: {
        adapters: {
          pi: {
            child_inspection: { max_bytes_total: 1 },
          },
        },
      },
    } as unknown as WeaveConfig;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSettingsChoice("Use defaults");
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(
        {
          agents: [
            {
              agentName: "loom",
              source: "explicit",
              descriptor: loomDescriptor(),
            },
          ],
          errors: [],
        },
        () => config,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
    });

    await host.triggerSessionStart();
    expect(host.settingsPopupCalls).toHaveLength(1);
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");

    config = {
      ...EMPTY_CONFIG,
      settings: {
        adapters: {
          pi: { child_inspection: {} },
        },
      },
    } as unknown as WeaveConfig;
    await host.triggerSessionStart();

    expect(host.settingsPopupCalls).toHaveLength(1);
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
    expect(
      host.statusCalls.filter(
        (call) => call.key === "weave-agent" && call.value === "◆ WEAVE · LOOM",
      ),
    ).toHaveLength(2);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
  });

  it("uses one trusted parent-session history identity across replacement generations and separates distinct sessions", async () => {
    const opened: string[] = [];
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      parentSessionId: () => "parent-session-a",
      childHistoryStoreFactory: (id) => {
        opened.push(id);
        return errAsync("not persisted" as unknown);
      },
    });
    await host.triggerSessionStart();
    await host.triggerSessionStart();
    expect(opened).toEqual(["parent-session-a", "parent-session-a"]);

    const otherOpened: string[] = [];
    const otherHost = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(otherHost, "0.81.1", {
      parentSessionId: () => "parent-session-b",
      childHistoryStoreFactory: (id) => {
        otherOpened.push(id);
        return errAsync("not persisted" as unknown);
      },
    });
    await otherHost.triggerSessionStart();
    expect(otherOpened).toEqual(["parent-session-b"]);
    expect(opened[0]).not.toBe(otherOpened[0]);
  });

  it("expires startup recovery countdown and restores one eligible root exactly once", async () => {
    const history = mutableChildHistoryStore();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect(undefined);
    installRecoveryExtension(
      host,
      history.store,
      () => {
        restores += 1;
        return okAsync({ finalOutput: "done", interventionCount: 1 });
      },
      { recovery_countdown_seconds: 0 },
    );
    await host.triggerSessionStart();
    await flushBackgroundWork();
    expect(restores).toBe(1);
    expect(history.records[0]?.status).toBe("settled");
    expect(history.records[0]?.recovery.eligible).toBe(false);
  });

  it("honors exact startup choices: Recover now recovers, while Skip and Inspect preserve eligibility", async () => {
    for (const choice of ["Recover now", "Skip", "Inspect"] as const) {
      const history = mutableChildHistoryStore();
      let restores = 0;
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      host.scriptSelect(choice);
      installRecoveryExtension(host, history.store, () => {
        restores += 1;
        return okAsync({ finalOutput: "done", interventionCount: 0 });
      });
      await host.triggerSessionStart();
      await flushBackgroundWork();
      expect(restores).toBe(choice === "Recover now" ? 1 : 0);
      expect(history.records[0]?.recovery.eligible).toBe(
        choice !== "Recover now",
      );
      if (choice === "Inspect") {
        expect(host.notifyCalls).toContainEqual({
          message: "Interrupted child recover-me is available for inspection.",
          level: "info",
        });
      }
    }
  });

  it("recovers skipped children on the command and registers that command only once across reloads", async () => {
    const history = mutableChildHistoryStore();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history.store, () => {
      restores += 1;
      return okAsync({ finalOutput: "done", interventionCount: 0 });
    });
    await host.triggerSessionStart();
    await flushBackgroundWork();
    await host.invokeCommand("weave:recover-children");
    await host.triggerSessionStart();
    await flushBackgroundWork();
    expect(restores).toBe(1);
    expect(
      host.registerCommandCalls.filter(
        (call) => call.name === "weave:recover-children",
      ),
    ).toHaveLength(1);
  });

  it("projects one bounded settlement message without creating a turn or leaking canaries", async () => {
    const history = mutableChildHistoryStore();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Recover now");
    installRecoveryExtension(host, history.store, () =>
      okAsync({ finalOutput: "x".repeat(20_000), interventionCount: 7 }),
    );
    await host.triggerSessionStart();
    const widgetCallsBeforeSettlement = host.widgetCalls.length;
    await flushBackgroundWork();
    expect(host.sendMessageCalls).toHaveLength(1);
    const sent = host.sendMessageCalls[0];
    if (sent === undefined) throw new Error("expected a recovery message");
    expect(sent.message.customType).toBe("weave-child-recovery");
    expect(sent.message.content).toContain("Interventions: 7");
    expect(
      new TextEncoder().encode(sent.message.content).byteLength,
    ).toBeLessThanOrEqual(16_384 + 32);
    expect(sent.options).toEqual({ triggerTurn: false });
    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.generatedTurnCount).toBe(0);
    expect(host.customCalls).toHaveLength(0);
    expect(host.interventionCalls).toHaveLength(0);
    expect(host.widgetCalls).toHaveLength(widgetCallsBeforeSettlement);
  });

  it("turns restore and send failures into one safe notification without a turn or raw canary", async () => {
    for (const failure of ["restore", "send"] as const) {
      const history = mutableChildHistoryStore();
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      host.scriptSelect("Recover now");
      if (failure === "send") host.poisonSendMessage();
      installRecoveryExtension(host, history.store, () => {
        if (failure === "restore") throw new Error("raw restore secret");
        return okAsync({ finalOutput: "safe", interventionCount: 0 });
      });
      await host.triggerSessionStart();
      await flushBackgroundWork();
      expect(
        host.notifyCalls.filter(
          (call) =>
            call.message === "Child recovery is unavailable in this session.",
        ),
      ).toHaveLength(1);
      expect(host.sentUserMessages).toHaveLength(0);
      expect(host.generatedTurnCount).toBe(0);
      expect(host.customCalls).toHaveLength(0);
      expect(host.interventionCalls).toHaveLength(0);
      expect(
        host.notifyCalls.some((call) =>
          call.message.includes("raw restore secret"),
        ),
      ).toBe(false);
    }
  });

  it("fails closed when recovery is disabled, with no startup or command spawn", async () => {
    const history = mutableChildHistoryStore();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(
        {
          agents: [
            {
              agentName: "loom",
              source: "explicit",
              descriptor: loomDescriptor(),
            },
          ],
          errors: [],
        },
        {
          ...EMPTY_CONFIG,
          settings: {
            adapters: { pi: { child_inspection: { recovery_enabled: false } } },
          },
        } as unknown as WeaveConfig,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      childHistoryStoreFactory: () => okAsync(history.store),
      restoreOrdinaryChild: () => {
        restores += 1;
        return okAsync({ finalOutput: "leak", interventionCount: 0 });
      },
    });
    await host.triggerSessionStart();
    await flushBackgroundWork();
    host.notifyCalls.length = 0;
    await host.invokeCommand("weave:recover-children");
    expect(restores).toBe(0);
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(host.notifyCalls).toHaveLength(1);
    expect(host.notifyCalls[0]?.message).toBe(
      "No interrupted children are recoverable.",
    );
  });

  it("does not recover from an untrusted project and gives one safe command message", async () => {
    const history = mutableChildHistoryStore();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: false });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history.store, () => {
      restores += 1;
      return okAsync({ finalOutput: "leak", interventionCount: 0 });
    });
    await host.triggerSessionStart();
    await flushBackgroundWork();
    host.notifyCalls.length = 0;
    await host.invokeCommand("weave:recover-children");
    expect(restores).toBe(0);
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(host.notifyCalls).toEqual([
      {
        message: "Child recovery is unavailable in this session.",
        level: "info",
      },
    ]);
  });

  it("fails closed for missing descriptors and history stores without leaking paths", async () => {
    const missingDescriptor = mutableChildHistoryStore();
    let restores = 0;
    const descriptorHost = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
    });
    installExtension(descriptorHost, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({ agents: [], errors: [] }),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      childHistoryStoreFactory: () => okAsync(missingDescriptor.store),
      restoreOrdinaryChild: () => {
        restores += 1;
        return okAsync({
          finalOutput: "/raw/descriptor/path",
          interventionCount: 0,
        });
      },
    });
    await descriptorHost.triggerSessionStart();
    descriptorHost.notifyCalls.length = 0;
    await descriptorHost.invokeCommand("weave:recover-children");
    expect(restores).toBe(0);
    expect(descriptorHost.sendMessageCalls).toHaveLength(0);
    expect(descriptorHost.notifyCalls).toHaveLength(1);
    expect(descriptorHost.notifyCalls[0]?.message).toBe(
      "Child recovery is unavailable in this session.",
    );
    expect(descriptorHost.notifyCalls[0]?.message).not.toContain("recover-me");

    const missingStoreHost = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
    });
    installExtension(missingStoreHost, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      childHistoryStoreFactory: () =>
        errAsync("/raw/history/store/path" as unknown),
    });
    await missingStoreHost.triggerSessionStart();
    missingStoreHost.notifyCalls.length = 0;
    await missingStoreHost.invokeCommand("weave:recover-children");
    expect(missingStoreHost.notifyCalls).toEqual([
      {
        message: "Child recovery is unavailable in this session.",
        level: "info",
      },
    ]);
    expect(missingStoreHost.notifyCalls[0]?.message).not.toContain("/raw/");
  });

  it("never auto-recovers quarantined records, including from the command", async () => {
    const history = mutableChildHistoryStore(
      eligibleOrdinaryRecoveryRecord({
        quarantine: { quarantined: true, reasonClass: "raw" },
      }),
    );
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Recover now");
    installRecoveryExtension(host, history.store, () => {
      restores += 1;
      return okAsync({ finalOutput: "leak", interventionCount: 0 });
    });
    await host.triggerSessionStart();
    await flushBackgroundWork();
    await host.invokeCommand("weave:recover-children");
    expect(restores).toBe(0);
    expect(host.sendMessageCalls).toHaveLength(0);
  });

  it("does not let a stale deferred startup recover or inject after a new generation starts", async () => {
    const history = mutableChildHistoryStore();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const deferred = host.deferNextSelect();
    installRecoveryExtension(host, history.store, () => {
      restores += 1;
      return okAsync({ finalOutput: "stale canary", interventionCount: 0 });
    });
    await host.triggerSessionStart();
    host.scriptSelect("Skip");
    await host.triggerSessionStart();
    await flushBackgroundWork();
    deferred.settle("Recover now");
    await flushBackgroundWork();
    expect(restores).toBe(0);
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(host.sentUserMessages).toHaveLength(0);
  });

  it("clears recovery on shutdown after Skip", async () => {
    const history = mutableChildHistoryStore();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history.store, () => {
      restores += 1;
      return okAsync({ finalOutput: "leak", interventionCount: 0 });
    });
    await host.triggerSessionStart();
    await flushBackgroundWork();
    await host.triggerSessionShutdown();
    await host.invokeCommand("weave:recover-children");
    expect(restores).toBe(0);
    expect(host.notifyCalls.at(-1)).toEqual({
      message: "Child recovery is unavailable in this session.",
      level: "info",
    });
  });

  it("turns selection failures into one safe notification without restore or raw canaries", async () => {
    for (const fail of ["throw", "reject"] as const) {
      const history = mutableChildHistoryStore();
      let restores = 0;
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      if (fail === "throw") host.poisonSelect();
      else host.rejectSelect();
      installRecoveryExtension(host, history.store, () => {
        restores += 1;
        return okAsync({
          finalOutput: "raw turn canary",
          interventionCount: 0,
        });
      });
      await host.triggerSessionStart();
      await flushBackgroundWork();
      expect(restores).toBe(0);
      expect(host.sendMessageCalls).toHaveLength(0);
      expect(host.generatedTurnCount).toBe(0);
      expect(
        host.notifyCalls.filter(
          (call) =>
            call.message === "Child recovery is unavailable in this session.",
        ),
      ).toHaveLength(1);
      expect(
        host.notifyCalls.some(
          (call) =>
            call.message.includes("raw") ||
            call.message.includes("token=") ||
            call.message.includes("/Users/"),
        ),
      ).toBe(false);
    }
  });

  it("turns inspection failures into one safe notification without restore or raw canaries", async () => {
    const history = mutableChildHistoryStore();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Inspect");
    host.poisonNextNotify();
    installRecoveryExtension(host, history.store, () => {
      restores += 1;
      return okAsync({
        finalOutput: "raw inspection canary",
        interventionCount: 0,
      });
    });
    await host.triggerSessionStart();
    await flushBackgroundWork();
    expect(restores).toBe(0);
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(host.generatedTurnCount).toBe(0);
    const safeNotifications = host.notifyCalls.filter(
      (call) =>
        call.message === "Child recovery is unavailable in this session.",
    );
    expect(safeNotifications).toHaveLength(1);
    expect(safeNotifications[0]?.message).not.toContain("/Users/");
  });

  it("proves inspect labels, terminal clearing, and bounded child clearing through registered commands", async () => {
    const live = eligibleOrdinaryRecoveryRecord({
      childId: "live-running",
      status: "running",
      recovery: { eligible: false, count: 0 },
    });
    const interrupted = eligibleOrdinaryRecoveryRecord({
      childId: "ordinary-interrupted",
    });
    const workflow = eligibleOrdinaryRecoveryRecord({
      childId: "workflow-interrupted",
      kind: "workflow-step",
      workflow: { workflow: "workflow-canary", step: "step-canary" },
    });
    const history = mutableChildHistoryStore([live, interrupted, workflow]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history.store, () =>
      okAsync({ finalOutput: "restored", interventionCount: 0 }),
    );
    await host.triggerSessionStart();
    const deferred = host.deferNextSelect();
    const inspect = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const options = host.selectCalls.at(-1)?.options ?? [];
    expect(
      options.some(
        (label) =>
          label.includes("workflow-canary") && label.includes("step-canary"),
      ),
    ).toBe(true);
    expect(
      options.some(
        (label) =>
          label.includes("children/live-running/session.jsonl") ||
          label.includes("ordinary-interrupted"),
      ),
    ).toBe(false);
    const clearLabel = options
      .filter((label) => label.includes("clear history"))
      .at(-1);
    expect(clearLabel).toBeDefined();
    deferred.settle(clearLabel);
    await inspect;
    expect(history.cleared).toEqual(["ordinary-interrupted"]);
    expect(history.records.map((record) => record.childId)).toContain(
      "live-running",
    );
    await host.invokeCommand("weave:clear-children");
    expect(history.records.map((record) => record.childId)).toEqual([
      "live-running",
    ]);
    expect(host.notifyCalls.at(-1)?.message).toContain("1");
  });

  it("proves recover, workflow resume, and stale deferred actions are generation scoped", async () => {
    const ordinary = eligibleOrdinaryRecoveryRecord({
      childId: "ordinary-recover",
    });
    const workflow = eligibleOrdinaryRecoveryRecord({
      childId: "workflow-resume",
      kind: "workflow-step",
      workflow: { workflow: "workflow", step: "step" },
    });
    const history = mutableChildHistoryStore([ordinary, workflow]);
    const restores: string[] = [];
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history.store, (input) => {
      restores.push(input.record.childId);
      return okAsync({ finalOutput: "restored", interventionCount: 0 });
    });
    await host.triggerSessionStart();
    const recoverPick = host.deferNextSelect();
    const recover = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const recoverLabel = host.selectCalls
      .at(-1)
      ?.options.filter((label) => label.includes("recover"))
      .at(-1);
    recoverPick.settle(recoverLabel);
    await recover;
    expect(restores).toEqual(["ordinary-recover"]);

    const resumePick = host.deferNextSelect();
    const resume = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const resumeLabel = host.selectCalls
      .at(-1)
      ?.options.filter((label) => label.includes("resume"))
      .at(-1);
    resumePick.settle(resumeLabel);
    await resume;
    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.generatedTurnCount).toBe(0);

    const stalePick = host.deferNextSelect();
    const stale = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    await host.triggerSessionStart();
    const staleLabel = host.selectCalls
      .at(-2)
      ?.options.find((label) => label.includes("workflow-resume"));
    stalePick.settle(staleLabel);
    await stale;
    expect(restores).toEqual(["ordinary-recover"]);
    expect(host.sentUserMessages).toHaveLength(0);
    expect(
      host.notifyCalls.filter((call) => call.message.includes("stale")),
    ).toHaveLength(0);
  });

  it("proves the composed editor handles Alt+I and Alt+1 without global shortcut leakage", async () => {
    const history = mutableChildHistoryStore([
      eligibleOrdinaryRecoveryRecord({
        childId: "live-child",
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installRecoveryExtension(host, history.store, () =>
      okAsync({ finalOutput: "restored", interventionCount: 0 }),
    );
    await host.triggerSessionStart();
    const weaveFactory = host.getEditorComponentForTest();
    expect(typeof weaveFactory).toBe("function");

    // Pi itself can drop back to its default editor between turns. With no
    // other owner, Weave may reclaim it to restore child-inspection keys.
    host.setEditorComponentForTest(undefined);
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(host.getEditorComponentForTest()).toBe(weaveFactory);

    host.setEditorComponentForTest(undefined);
    await host.triggerEvent("agent_start");
    expect(host.getEditorComponentForTest()).toBe(weaveFactory);

    const editor = host.createEditor({}, {}, {});
    const picker = host.deferNextSelect();
    await editor.handleInput("\u001bi");
    expect(host.registerShortcutCalls.map((call) => call.shortcut)).toEqual([
      "alt+a",
      "alt+t",
    ]);
    picker.settle(undefined);
    await host.triggerSessionShutdown();
    expect(host.getEditorComponentForTest()).toBeUndefined();
  });

  it("leaves a foreign session editor installed across session_start and agent lifecycle events", async () => {
    const history = mutableChildHistoryStore([
      eligibleOrdinaryRecoveryRecord({
        childId: "live-child",
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    // Stands in for `pi-vim`'s `ModalEditor`: another extension already owns
    // the single session editor surface before Weave activates.
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installRecoveryExtension(host, history.store, () =>
      okAsync({ finalOutput: "restored", interventionCount: 0 }),
    );
    await host.triggerSessionStart();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    await host.triggerEvent("agent_start");
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    await host.triggerSessionShutdown();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("borrows the session editor for child inspection and hands it back to the foreign owner", async () => {
    const history = mutableChildHistoryStore([
      eligibleOrdinaryRecoveryRecord({
        childId: "ordinary-live-child",
        status: "interrupted",
        recovery: { eligible: false, count: 0 },
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installRecoveryExtension(host, history.store, () =>
      okAsync({ finalOutput: "restored", interventionCount: 0 }),
    );
    await host.triggerSessionStart();
    await host.triggerEvent("agent_start");
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    const picker = host.deferNextSelect();
    const inspect = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const childLabel = host.selectCalls
      .at(-1)
      ?.options.find((label) => label.includes("history: loom"));
    expect(childLabel).toBeDefined();
    picker.settle(childLabel);
    await inspect;

    // Child inspection still works: Weave owns the editor while the view is
    // mounted, and the transcript overlay opened.
    expect(host.getEditorComponentForTest()).not.toBe(modalFactory);
    expect(host.customCalls.length).toBeGreaterThan(0);

    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("settles child inspection before opening its nested picker and can reopen cleanly", async () => {
    const history = mutableChildHistoryStore([
      eligibleOrdinaryRecoveryRecord({
        childId: "ordinary-live-child",
        status: "interrupted",
        recovery: { eligible: false, count: 0 },
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installRecoveryExtension(host, history.store, () =>
      okAsync({ finalOutput: "restored", interventionCount: 0 }),
    );
    await host.triggerSessionStart();
    await host.triggerEvent("agent_start");

    const firstPicker = host.deferNextSelect();
    const firstInspect = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const childLabel = host.selectCalls
      .at(-1)
      ?.options.find((label) => label.includes("history: loom"));
    expect(childLabel).toBeDefined();
    firstPicker.settle(childLabel);
    await firstInspect;
    expect(host.getEditorComponentForTest()).not.toBe(modalFactory);
    const initialCustomCount = host.customCalls.length;

    const nestedPicker = host.deferNextSelect();
    host.inputCustom("\x1bi");
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
    nestedPicker.settle(undefined);
    await flushBackgroundWork();

    const reopenPicker = host.deferNextSelect();
    const reopen = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const reopenedChildLabel = host.selectCalls
      .at(-1)
      ?.options.find((label) => label.includes("history: loom"));
    expect(reopenedChildLabel).toBeDefined();
    reopenPicker.settle(reopenedChildLabel);
    await reopen;
    expect(host.customCalls).toHaveLength(initialCustomCount + 1);
    expect(host.getEditorComponentForTest()).not.toBe(modalFactory);

    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("does not clobber a foreign editor installed while inspection is open", async () => {
    const history = mutableChildHistoryStore([
      eligibleOrdinaryRecoveryRecord({
        childId: "ordinary-live-child",
        status: "interrupted",
        recovery: { eligible: false, count: 0 },
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installRecoveryExtension(host, history.store, () =>
      okAsync({ finalOutput: "restored", interventionCount: 0 }),
    );
    await host.triggerSessionStart();
    await host.triggerEvent("agent_start");

    const picker = host.deferNextSelect();
    const inspect = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const childLabel = host.selectCalls
      .at(-1)
      ?.options.find((label) => label.includes("history: loom"));
    expect(childLabel).toBeDefined();
    picker.settle(childLabel);
    await inspect;
    expect(host.getEditorComponentForTest()).not.toBe(modalFactory);

    const replacementFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(replacementFactory);
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(replacementFactory);

    const reopenPicker = host.deferNextSelect();
    const reopen = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const reopenedChildLabel = host.selectCalls
      .at(-1)
      ?.options.find((label) => label.includes("history: loom"));
    expect(reopenedChildLabel).toBeDefined();
    reopenPicker.settle(reopenedChildLabel);
    await reopen;
    expect(host.getEditorComponentForTest()).not.toBe(replacementFactory);

    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(replacementFactory);
  });

  it("never reclaims a session editor a foreign extension installs after Weave activates", async () => {
    const history = mutableChildHistoryStore([
      eligibleOrdinaryRecoveryRecord({
        childId: "live-child",
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installRecoveryExtension(host, history.store, () =>
      okAsync({ finalOutput: "restored", interventionCount: 0 }),
    );
    // Load order is not guaranteed: Weave may activate before `pi-vim`
    // installs its modal editor. Whatever Weave took while the surface was
    // free must not be taken back once a foreign owner appears.
    await host.triggerSessionStart();
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);

    await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    await host.triggerEvent("agent_start");
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    await host.triggerSessionShutdown();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("reproduces live child inspection no-op at the extension seam", async () => {
    const history = mutableChildHistoryStore([
      eligibleOrdinaryRecoveryRecord({
        childId: "ordinary-live-child",
        status: "interrupted",
        recovery: { eligible: false, count: 0 },
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const priorFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(priorFactory);
    installRecoveryExtension(host, history.store, () =>
      okAsync({ finalOutput: "restored", interventionCount: 0 }),
    );
    await host.triggerSessionStart();

    const initialEditorFactoryCount = host.editorFactoryCalls.length;
    const picker = host.deferNextSelect();
    const inspect = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const childLabel = host.selectCalls
      .at(-1)
      ?.options.find((label) => label.includes("history: loom"));
    expect(childLabel).toBeDefined();
    picker.settle(childLabel);
    await inspect;

    const selectedEditorFactoryCount = host.editorFactoryCalls.length;
    const pickerActivatedTranscript = host.customCalls.length;
    const renderedChildTranscript = host.customRenderedLines.flat().join("\\n");
    const legacyFooterVisible = host.widgetCalls.some(
      (call) => call.key === "weave-children",
    );

    const editor = host.createEditor({}, {}, { matches: () => false });
    await editor.handleInput("\u001b1");
    const altSlotActivatedTranscript = host.customCalls.length;

    // Expected contract versus the observed live behavior. Keeping these in
    // one assertion makes both broken paths visible in the failure output.
    expect({
      pickerActivatedTranscript,
      renderedChildTranscript,
      editorFactoryDelta:
        selectedEditorFactoryCount - initialEditorFactoryCount,
      legacyFooterVisible,
      altSlotActivatedTranscript,
    }).toEqual({
      pickerActivatedTranscript: 1,
      renderedChildTranscript: expect.stringContaining("ordinary-live-child"),
      editorFactoryDelta: 1,
      legacyFooterVisible: false,
      altSlotActivatedTranscript: 1,
    });
  });

  it("registers twelve described commands once across extension reloads", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    installExtension(host);
    expect(host.registerCommandCalls).toHaveLength(26);
    const directNames = new Set(
      host.registerCommandCalls
        .map((call) => call.name)
        .filter((name) => name !== "weave"),
    );
    expect(directNames.size).toBe(12);
    expect(
      host.registerCommandCalls.every(
        (call) => (call.registration.description ?? "").trim().length > 0,
      ),
    ).toBe(true);
  });

  it("keeps persist_history=false write-free and never lets a fake host touch user data", async () => {
    let writes = 0;
    const fakeStore = {
      upsertRecord: () => {
        writes += 1;
        return okAsync(undefined);
      },
      updateRecord: () => {
        writes += 1;
        return okAsync(undefined);
      },
      appendSessionEvent: () => {
        writes += 1;
        return okAsync(undefined);
      },
      clear: () => {
        writes += 1;
        return okAsync(undefined);
      },
    } as unknown as PiChildHistoryStore;
    const config = {
      ...EMPTY_CONFIG,
      settings: {
        adapters: { pi: { child_inspection: { persist_history: false } } },
      },
    } as unknown as WeaveConfig;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      configActivator: fakeConfigActivator(undefined, config),
      parentSessionId: () => "fake-parent",
      childHistoryStoreFactory: () => okAsync(fakeStore),
    });
    await host.triggerSessionStart();
    expect(writes).toBe(0);
    expect(
      host.notifyCalls.some((call) => String(call.message).includes("/Users/")),
    ).toBe(false);
  });
});

/**
 * The delegation controller resolves portable delegation limits from
 * `config.settings.delegation`, so a lifecycle fixture must carry a real
 * `settings` object rather than the bare descriptor-only `EMPTY_CONFIG`.
 */
const DELEGATION_LIFECYCLE_CONFIG = {
  ...EMPTY_CONFIG,
  agents: { loom: {}, shuttle: {} },
  settings: {},
} as unknown as WeaveConfig;

/**
 * Installs the extension with a delegation-capable primary and a fake child
 * process port, so a generation can genuinely spawn a child and a later
 * generation's controller cleanup becomes observable as a killed process.
 */
function installDelegationLifecycleExtension(
  host: RecordingFakePiHost,
  processPort: FakeChildProcessPort,
  overrides: Partial<PiExtensionDeps> = {},
): void {
  installExtension(host, "0.81.1", {
    capabilityProber: allOkCapabilityProber(),
    configActivator: fakeConfigActivator(
      {
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
      },
      DELEGATION_LIFECYCLE_CONFIG,
    ),
    runtimeStoreFactory: { open: () => okAsync(createInMemoryRuntimeStore()) },
    processPort,
    childCommand: ["/fake/bin/pi"],
    ...overrides,
  });
}

/**
 * Fires the registered `weave_delegate` tool without awaiting its settlement
 * (a real delegation only settles once the child finishes), and resolves once
 * the controller has actually spawned the child process.
 */
async function spawnLifecycleChild(
  host: RecordingFakePiHost,
  processPort: FakeChildProcessPort,
): Promise<void> {
  const registration = host.registerToolCalls.find(
    (tool) => tool.name === "weave_delegate",
  );
  expect(registration).toBeDefined();
  void registration
    ?.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      host.createSessionContext(),
    )
    .catch(() => undefined);
  for (let tick = 0; tick < 50; tick += 1) {
    if (processPort.spawnedProcesses.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Disposal is deliberately downstream of inspection persistence, so the kill
 * lands a microtask after `session_start` returns. Polls instead of asserting
 * synchronously, without ever holding the test open on a real timer.
 */
async function waitForKilled(
  process: { readonly killed: boolean } | undefined,
): Promise<boolean> {
  for (let tick = 0; tick < 50; tick += 1) {
    if (process?.killed === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return process?.killed === true;
}

class TrackingIdGenerator implements IdGenerator {
  calls = 0;
  private readonly inner = new FakeIdGenerator();
  next(): string {
    this.calls += 1;
    return this.inner.next();
  }
}

describe("createPiExtension: persistent-parent guard on production weave_delegate", () => {
  it("refuses weave_delegate from a host-reported ephemeral sessionManager before any child side effect", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: ephemeralFakeSessionManager(),
    });
    const processPort = new FakeChildProcessPort();
    const idGenerator = new TrackingIdGenerator();
    installDelegationLifecycleExtension(host, processPort, { idGenerator });

    await host.triggerSessionStart();
    const idCallsAfterStart = idGenerator.calls;
    const registration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    expect(registration).toBeDefined();

    const result = await registration?.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("missing tool result");
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.ok).toBe(false);
    expect(text.error).toBe("PersistentParentSessionRequired");
    expect(text.reason).toBe("host-reports-not-persisted");
    expect(text.retryable).toBe(false);
    expect(text.message).toContain("persistent Pi session");
    expect(JSON.stringify(text)).not.toContain("ephemeral-session");
    expect(idGenerator.calls).toBe(idCallsAfterStart);
    expect(processPort.spawnedProcesses).toHaveLength(0);
  });

  it("delegates normally when the host reports a persistent sessionManager", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager(),
    });
    const processPort = new FakeChildProcessPort();
    installDelegationLifecycleExtension(host, processPort);

    await host.triggerSessionStart();
    await spawnLifecycleChild(host, processPort);
    expect(processPort.spawnedProcesses).toHaveLength(1);
  });

  it("fails closed when ctx.sessionManager is absent (no-probe)", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: null,
    });
    const processPort = new FakeChildProcessPort();
    const idGenerator = new TrackingIdGenerator();
    installDelegationLifecycleExtension(host, processPort, { idGenerator });

    await host.triggerSessionStart();
    const idCallsAfterStart = idGenerator.calls;
    const registration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    expect(registration).toBeDefined();

    const result = await registration?.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("missing tool result");
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.ok).toBe(false);
    expect(text.error).toBe("PersistentParentSessionRequired");
    expect(text.reason).toBe("no-probe");
    expect(idGenerator.calls).toBe(idCallsAfterStart);
    expect(processPort.spawnedProcesses).toHaveLength(0);
  });

  it("fails closed when the host sessionManager probe throws (probe-failed)", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: {
        getSessionId: () => "session-throw",
        getSessionFile: () => "/sessions/throw.jsonl",
        isPersisted: () => {
          throw new Error("host probe exploded");
        },
      },
    });
    const processPort = new FakeChildProcessPort();
    const idGenerator = new TrackingIdGenerator();
    installDelegationLifecycleExtension(host, processPort, { idGenerator });

    await host.triggerSessionStart();
    const idCallsAfterStart = idGenerator.calls;
    const registration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    expect(registration).toBeDefined();

    const result = await registration?.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("missing tool result");
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.ok).toBe(false);
    expect(text.error).toBe("PersistentParentSessionRequired");
    expect(text.reason).toBe("probe-failed");
    expect(JSON.stringify(text)).not.toContain("host probe exploded");
    expect(idGenerator.calls).toBe(idCallsAfterStart);
    expect(processPort.spawnedProcesses).toHaveLength(0);
  });
});

describe("createPiExtension: Task 9 thread source factory wiring", () => {
  function trackingFactory(
    outcome:
      | { readonly kind: "ok"; readonly sources?: Partial<PiThreadSources> }
      | { readonly kind: "err" },
  ): {
    readonly factory: PiThreadSourceFactory;
    readonly calls: number[];
    readonly lastSources: PiThreadSources | undefined;
  } {
    const calls: number[] = [];
    let lastSources: PiThreadSources | undefined;
    const emptyCache: PiThreadCachePort = {
      upsertRef: () => ok(undefined),
    };
    const emptyRefs = {
      liveParentSessionId: () => "fake-session-1",
      readRefs: () =>
        okAsync({
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
        }),
      appendNewChild: () =>
        errAsync({ type: "ChildRefParentUnavailable" as const }),
      appendRunDivider: () =>
        errAsync({ type: "ChildRefParentUnavailable" as const }),
      appendLifecycle: () =>
        errAsync({ type: "ChildRefParentUnavailable" as const }),
    } as unknown as PiThreadRefPort;
    const emptySessions = {
      createChildSession: () =>
        errAsync({
          type: "SessionCreateFailed" as const,
          reason: "host-threw" as const,
        }),
      establishThreadLeaf: () =>
        errAsync({
          type: "SessionCreateFailed" as const,
          reason: "host-threw" as const,
        }),
      appendTombstone: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      openSession: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      readSessionEntries: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      readThreadMetadata: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
    } as unknown as PiThreadSessionPort;
    const factory: PiThreadSourceFactory = () => {
      calls.push(Date.now());
      if (outcome.kind === "err") {
        return errAsync({
          type: "SessionRootUnavailable",
          reason: "test-forced-failure",
        });
      }
      lastSources = {
        refs: outcome.sources?.refs ?? emptyRefs,
        sessions: outcome.sources?.sessions ?? emptySessions,
        cache: outcome.sources?.cache ?? emptyCache,
        cacheMode: outcome.sources?.cacheMode ?? "active",
      };
      return okAsync(lastSources);
    };
    return {
      factory,
      calls,
      get lastSources() {
        return lastSources;
      },
    };
  }

  it("populates thread source cells from a successful factory before delegation", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const processPort = new FakeChildProcessPort();
    const created: string[] = [];
    const sessions = {
      createChildSession: (input: { childId: string }) => {
        created.push(input.childId);
        return errAsync({
          type: "SessionCreateFailed" as const,
          reason: "host-threw" as const,
        });
      },
      establishThreadLeaf: () =>
        errAsync({
          type: "SessionCreateFailed" as const,
          reason: "host-threw" as const,
        }),
      appendTombstone: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      openSession: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      readSessionEntries: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      readThreadMetadata: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
    } as unknown as PiThreadSessionPort;
    const tracked = trackingFactory({
      kind: "ok",
      sources: { sessions, cacheMode: "active" },
    });
    installDelegationLifecycleExtension(host, processPort, {
      threadSourceFactory: tracked.factory,
    });

    await host.triggerSessionStart();
    expect(tracked.calls).toHaveLength(1);
    expect(tracked.lastSources?.sessions).toBe(sessions);

    const registration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    expect(registration).toBeDefined();
    void registration
      ?.execute(
        "call-1",
        { agent: "shuttle", task: "do it" },
        undefined,
        undefined,
        host.createSessionContext(),
      )
      .catch(() => undefined);
    for (let tick = 0; tick < 50; tick += 1) {
      if (created.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Factory-populated sessions are consulted before any child process spawn.
    expect(created.length).toBeGreaterThan(0);
    expect(processPort.spawnedProcesses).toHaveLength(0);
  });

  it("allows a degraded cache outcome and still constructs the controller", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const processPort = new FakeChildProcessPort();
    const tracked = trackingFactory({
      kind: "ok",
      sources: { cacheMode: "degraded" },
    });
    installDelegationLifecycleExtension(host, processPort, {
      threadSourceFactory: tracked.factory,
    });

    await host.triggerSessionStart();
    expect(tracked.calls).toHaveLength(1);
    expect(tracked.lastSources?.cacheMode).toBe("degraded");
    // Degraded cache must not block controller construction.
    const registration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    expect(registration).toBeDefined();
    const result = await registration?.execute(
      "call-degraded",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    // Session stubs refuse create, so the tool fails — but a controller ran.
    const text = JSON.parse(
      (result?.content[0] as { text: string } | undefined)?.text ?? "{}",
    );
    expect(text.ok).toBe(false);
    expect(text.error).not.toBe("delegation-transport-unavailable");
  });

  it("fails closed when the factory rejects authoritative sources (no controller / no spawn)", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const processPort = new FakeChildProcessPort();
    const tracked = trackingFactory({ kind: "err" });
    installDelegationLifecycleExtension(host, processPort, {
      threadSourceFactory: tracked.factory,
    });

    await host.triggerSessionStart();
    expect(tracked.calls).toHaveLength(1);
    expect(
      host.notifyCalls.some((call) =>
        String(call.message).includes("native child session sources"),
      ),
    ).toBe(true);

    const registration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    expect(registration).toBeDefined();
    const result = await registration?.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    const text = JSON.parse(
      (result?.content[0] as { text: string } | undefined)?.text ?? "{}",
    );
    expect(text.ok).toBe(false);
    expect(text.error).toBe("delegation-transport-unavailable");
    expect(processPort.spawnedProcesses).toHaveLength(0);
  });

  it("clears stale thread sources on session_start replacement and session_shutdown", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const processPort = new FakeChildProcessPort();
    const firstSessions = {
      id: "first",
      createChildSession: () =>
        errAsync({
          type: "SessionCreateFailed" as const,
          reason: "host-threw" as const,
        }),
      establishThreadLeaf: () =>
        errAsync({
          type: "SessionCreateFailed" as const,
          reason: "host-threw" as const,
        }),
      appendTombstone: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      openSession: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      readSessionEntries: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      readThreadMetadata: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
    } as unknown as PiThreadSessionPort & { id: string };
    const secondSessions = {
      id: "second",
      createChildSession: () =>
        errAsync({
          type: "SessionCreateFailed" as const,
          reason: "host-threw" as const,
        }),
      establishThreadLeaf: () =>
        errAsync({
          type: "SessionCreateFailed" as const,
          reason: "host-threw" as const,
        }),
      appendTombstone: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      openSession: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      readSessionEntries: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
      readThreadMetadata: () =>
        errAsync({ type: "SessionMissing" as const, ref: "x" }),
    } as unknown as PiThreadSessionPort & { id: string };
    const opened: PiThreadSessionPort[] = [];
    const factory: PiThreadSourceFactory = () => {
      const sessions = opened.length === 0 ? firstSessions : secondSessions;
      opened.push(sessions);
      return okAsync({
        refs: {
          liveParentSessionId: () => "fake-session-1",
          readRefs: () =>
            okAsync({
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
            }),
          appendNewChild: () =>
            errAsync({ type: "ChildRefParentUnavailable" as const }),
          appendRunDivider: () =>
            errAsync({ type: "ChildRefParentUnavailable" as const }),
          appendLifecycle: () =>
            errAsync({ type: "ChildRefParentUnavailable" as const }),
        } as unknown as PiThreadRefPort,
        sessions,
        cache: { upsertRef: () => ok(undefined) },
        cacheMode: "active" as const,
      });
    };
    installDelegationLifecycleExtension(host, processPort, {
      threadSourceFactory: factory,
    });

    await host.triggerSessionStart();
    expect(opened).toHaveLength(1);
    expect((opened[0] as unknown as { id: string }).id).toBe("first");

    await host.triggerSessionStart();
    expect(opened).toHaveLength(2);
    expect((opened[1] as unknown as { id: string }).id).toBe("second");

    await host.triggerSessionShutdown();
    // A post-shutdown delegate must not revive the prior generation's sources.
    const registration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    const result = await registration?.execute(
      "call-after-shutdown",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    const text = JSON.parse(
      (result?.content[0] as { text: string } | undefined)?.text ?? "{}",
    );
    expect(text.ok).toBe(false);
    expect(processPort.spawnedProcesses).toHaveLength(0);
  });
});

describe("createPiExtension: delegation controller lifecycle across generations", () => {
  it("kills the previous generation's live children as soon as a trust-withheld generation takes authority, even though that generation returns before ever building a controller", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const processPort = new FakeChildProcessPort();
    installDelegationLifecycleExtension(host, processPort);

    await host.triggerSessionStart();
    await spawnLifecycleChild(host, processPort);
    expect(processPort.spawnedProcesses).toHaveLength(1);
    expect(processPort.spawnedProcesses[0]?.killed).toBe(false);

    host.setTrusted(false);
    await host.triggerSessionStart();

    expect(await waitForKilled(processPort.spawnedProcesses[0])).toBe(true);
  });

  it("kills the previous generation's live children when the new generation returns early on config activation failure", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const processPort = new FakeChildProcessPort();
    let activations = 0;
    installDelegationLifecycleExtension(host, processPort, {
      configActivator: new PiConfigActivator({
        configLoader: {
          load: () => {
            activations += 1;
            return activations === 1
              ? okAsync(DELEGATION_LIFECYCLE_CONFIG)
              : errAsync({
                  code: "config-load-failed",
                  phase: "activation",
                  scope: { kind: "session" },
                  impact: "feature-unavailable",
                  retryable: false,
                  recovery: "none",
                  safeMessage: "config load failed",
                } as never);
          },
        },
        materializer: {
          materialize: () =>
            okAsync({
              agents: [
                {
                  agentName: "loom",
                  source: "explicit" as const,
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
            }),
        },
      }),
    });

    await host.triggerSessionStart();
    await spawnLifecycleChild(host, processPort);
    expect(processPort.spawnedProcesses).toHaveLength(1);

    await host.triggerSessionStart();

    expect(activations).toBeGreaterThan(1);
    expect(await waitForKilled(processPort.spawnedProcesses[0])).toBe(true);
  });

  it("kills the previous generation's live children when the new generation returns early because its mode is unsupported", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const processPort = new FakeChildProcessPort();
    installDelegationLifecycleExtension(host, processPort);

    await host.triggerSessionStart();
    await spawnLifecycleChild(host, processPort);
    expect(processPort.spawnedProcesses).toHaveLength(1);

    host.setMode("print");
    await host.triggerSessionStart();

    expect(await waitForKilled(processPort.spawnedProcesses[0])).toBe(true);
  });

  it("leaves no controller behind for the stale generation's delegate tool to reuse after a trust-withheld takeover", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const processPort = new FakeChildProcessPort();
    installDelegationLifecycleExtension(host, processPort);

    await host.triggerSessionStart();
    const registration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    expect(registration).toBeDefined();

    host.setTrusted(false);
    await host.triggerSessionStart();

    const result = await registration?.execute(
      "call-stale",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    const text = JSON.parse(
      (result?.content[0] as { text: string } | undefined)?.text ?? "{}",
    );
    expect(text.ok).toBe(false);
    expect(processPort.spawnedProcesses).toHaveLength(0);
  });
});

describe("strict generation ownership and stale async cleanup", () => {
  it("closes each generation-owned store exactly once on replacement and repeated shutdown", async () => {
    const firstRuntimeStore = countedRuntimeStore();
    const secondRuntimeStore = countedRuntimeStore();
    const firstHistoryStore = countedChildHistoryStore();
    const secondHistoryStore = countedChildHistoryStore();
    const persistedConfig = {
      ...EMPTY_CONFIG,
      settings: {
        adapters: {
          pi: {
            child_inspection: {
              persist_history: true,
              recovery_enabled: false,
            },
          },
        },
      },
    } as unknown as WeaveConfig;
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    let runtimeStoreOpenCount = 0;
    let historyStoreOpenCount = 0;
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(
        {
          agents: [
            {
              agentName: "loom",
              source: "explicit",
              descriptor: loomDescriptor(),
            },
          ],
          errors: [],
        },
        persistedConfig,
      ),
      runtimeStoreFactory: {
        open: () => {
          runtimeStoreOpenCount += 1;
          return okAsync(
            runtimeStoreOpenCount === 1
              ? firstRuntimeStore.store
              : secondRuntimeStore.store,
          );
        },
      },
      childHistoryStoreFactory: () => {
        historyStoreOpenCount += 1;
        return okAsync(
          historyStoreOpenCount === 1
            ? firstHistoryStore.store
            : secondHistoryStore.store,
        );
      },
      parentSessionId: () => "parent",
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    await host.triggerSessionStart();
    await flushBackgroundWork();

    expect(firstRuntimeStore.closeCount).toBe(1);
    expect(firstHistoryStore.closeCount).toBe(1);
    expect(secondRuntimeStore.closeCount).toBe(0);
    expect(secondHistoryStore.closeCount).toBe(0);

    await host.triggerSessionShutdown();
    await host.triggerSessionShutdown();
    await flushBackgroundWork();

    expect(firstRuntimeStore.closeCount).toBe(1);
    expect(firstHistoryStore.closeCount).toBe(1);
    expect(secondRuntimeStore.closeCount).toBe(1);
    expect(secondHistoryStore.closeCount).toBe(1);
  });

  it("closes an opened Runtime Store when primary activation fails during boot", async () => {
    const runtimeStore = countedRuntimeStore();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ mode: "subagent" }),
          },
        ],
        errors: [],
      }),
      runtimeStoreFactory: { open: () => okAsync(runtimeStore.store) },
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    await flushBackgroundWork();

    expect(runtimeStore.closeCount).toBe(1);
    expect(
      host.statusCalls.some(
        (call) => call.key === "weave" && call.value === "ready",
      ),
    ).toBe(false);
  });

  it("does not let a blocked old shutdown clear the replacement generation", async () => {
    const firstRuntimeStore = countedRuntimeStore();
    const secondRuntimeStore = countedRuntimeStore();
    const shutdownJournal = deferredResultAsync<undefined, never>(
      undefined as never,
    );
    const journalEvents: unknown[] = [];
    const telemetryJournal: NonNullable<PiExtensionDeps["telemetryJournal"]> = {
      write: (entry: unknown) => {
        const eventType =
          typeof entry === "object" && entry !== null && "eventType" in entry
            ? (entry as { eventType?: unknown }).eventType
            : undefined;
        journalEvents.push(eventType);
        return eventType === "generation.shutdown"
          ? shutdownJournal.start()
          : okAsync(undefined as undefined);
      },
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const delegationWorkflowPlan: MaterializationPlan = {
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
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    let runtimeStoreOpenCount = 0;
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(
        delegationWorkflowPlan,
        GATED_WORKFLOW_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => {
          runtimeStoreOpenCount += 1;
          return okAsync(
            runtimeStoreOpenCount === 1
              ? firstRuntimeStore.store
              : secondRuntimeStore.store,
          );
        },
      },
      telemetryJournal,
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    const oldShutdown = host.triggerSessionShutdown();
    await flushBackgroundWork();
    expect(journalEvents).toContain("generation.shutdown");
    await shutdownJournal.called;

    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    const replacementActiveTools = host.getActiveTools();
    expect(secondRuntimeStore.closeCount).toBe(0);

    await host.invokeCommand("weave:status");
    const workflowStatusBeforeOldShutdown = host.notifyCalls.at(-1);
    expect(workflowStatusBeforeOldShutdown?.message).toContain(
      "generation: generation-2",
    );

    const currentDelegate = host.registerToolCalls
      .filter((call) => call.name === "weave_delegate")
      .at(-1);
    expect(currentDelegate).toBeDefined();

    shutdownJournal.settle(ok(undefined));
    await oldShutdown;
    await flushBackgroundWork();

    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    expect(host.getActiveTools()).toEqual(replacementActiveTools);
    expect(secondRuntimeStore.closeCount).toBe(0);
    await host.invokeCommand("weave:status");
    expect(host.notifyCalls.at(-1)).toEqual(workflowStatusBeforeOldShutdown);
  });

  it("ignores a deferred active-plan result from an old generation", async () => {
    const oldPlanResolution = deferredResultAsync<PlanTaskSnapshot, never>(
      undefined as never,
    );
    let providerCount = 0;
    const oldProvider = new MutablePlanStateProvider(
      planSnapshotFixture("old-plan"),
    );
    const newProvider = new MutablePlanStateProvider(
      planSnapshotFixture("new-plan"),
    );
    newProvider.readSnapshot = (planName) =>
      okAsync(planSnapshotFixture(planName)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => {
        providerCount += 1;
        return providerCount === 1 ? oldProvider : newProvider;
      },
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    expect(
      host.statusCalls.some(
        (call) => call.key === "weave" && call.value === "ready",
      ),
    ).toBe(true);
    oldProvider.readSnapshot = () => oldPlanResolution.start();
    host.scriptConfirm(true);
    const oldRun = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    const oldProcess = await processPort.spawnCalled;
    await completeDirectChild(processPort, oldProcess);
    await oldPlanResolution.called;

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const newRun = host.invokeCommand("weave:run", "gated-flow");
    const newProcess = await processPort.spawnPromises[1];
    await completeDirectChild(processPort, newProcess);
    await newRun;
    const currentPlanWidget = host.widgetCalls
      .filter((call) => call.key === "weave-plan")
      .at(-1);
    const currentTaskFooter = host.statusCalls
      .filter((call) => call.key === "weave-task")
      .at(-1);
    expect(JSON.stringify(currentPlanWidget?.value)).toContain("Finish task");
    expect(JSON.stringify(currentTaskFooter?.value)).toContain("Finish task");

    await host.invokeCommand("weave:status");
    const currentWorkflowStatus = host.notifyCalls.at(-1);
    oldPlanResolution.settle(ok(planSnapshotFixture("old-plan")));
    await oldRun;
    await flushBackgroundWork();

    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual(currentPlanWidget);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual(currentTaskFooter);
    await host.invokeCommand("weave:status");
    expect(host.notifyCalls.at(-1)).toEqual(currentWorkflowStatus);
  });

  it("ignores a deferred active-plan result overtaken inside one generation", async () => {
    const stalePlanResolution = deferredResultAsync<PlanTaskSnapshot, never>(
      undefined as never,
    );
    const titledSnapshot = (
      planName: string,
      title: string,
    ): PlanTaskSnapshot => ({
      planName,
      contentRevision: "test-revision",
      format: "canonical",
      parents: [{ id: "task-1", title, state: "pending", children: [] }],
      totalParentCount: 1,
      complete: false,
    });
    const provider = new MutablePlanStateProvider();
    let deferNextRead = false;
    let title = "Task A";
    provider.readSnapshot = (planName) => {
      if (deferNextRead) {
        deferNextRead = false;
        return stalePlanResolution.start();
      }
      return okAsync(titledSnapshot(planName, title)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    };
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        { agentName: "loom", source: "explicit", descriptor: loomDescriptor() },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    await completeDirectChild(processPort, await processPort.spawnCalled);
    await execution;
    await flushBackgroundWork();
    expect(
      JSON.stringify(
        host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1)
          ?.value,
      ),
    ).toContain("Task A");

    // Resolution A starts and blocks inside its plan read. Nothing here
    // changes the controller generation, so generation ownership alone cannot
    // tell this result apart from a current one.
    deferNextRead = true;
    const staleAltT = host.invokeShortcut("alt+t");
    await stalePlanResolution.called;

    // Resolution B starts later, finishes first, and is the latest word on the
    // active plan: it paints the widget, the durable footer, and the modal.
    title = "Task B";
    const customCalledForB = host.waitForNextCustomCall();
    const altTForB = host.invokeShortcut("alt+t");
    await customCalledForB;
    expect(
      (host.customRenderedLines.at(-1) ?? []).some((line) =>
        line.includes("Task B"),
      ),
    ).toBe(true);
    host.inputCustom("\u001b");
    await altTForB;
    await flushBackgroundWork();

    const widgetForB = host.widgetCalls
      .filter((call) => call.key === "weave-plan")
      .at(-1);
    const footerForB = host.statusCalls
      .filter((call) => call.key === "weave-task")
      .at(-1);
    expect(JSON.stringify(widgetForB?.value)).toContain("Task B");
    expect(JSON.stringify(footerForB?.value)).toContain("Task B");
    await host.invokeCommand("weave:status");
    const statusForB = host.notifyCalls.at(-1);
    const planWidgetCountForB = host.widgetCalls.filter(
      (call) => call.key === "weave-plan",
    ).length;

    // A finishes last with a perfectly valid - but stale - active view. It
    // must repaint nothing and clear nothing.
    stalePlanResolution.settle(ok(titledSnapshot("gated-flow", "Task A")));
    await staleAltT;
    await flushBackgroundWork();

    const planWidgets = host.widgetCalls.filter(
      (call) => call.key === "weave-plan",
    );
    expect(planWidgets).toHaveLength(planWidgetCountForB);
    expect(planWidgets.at(-1)).toEqual(widgetForB);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual(footerForB);

    // The tracker still holds B's workflow, so a fresh modal and
    // /weave:status both describe B rather than the stale resolution.
    const customCalled = host.waitForNextCustomCall();
    const freshAltT = host.invokeShortcut("alt+t");
    await customCalled;
    const opened = host.customRenderedLines.at(-1) ?? [];
    expect(opened.some((line) => line.includes("Task B"))).toBe(true);
    expect(opened.some((line) => line.includes("Task A"))).toBe(false);
    host.inputCustom("\u001b");
    await freshAltT;

    await host.invokeCommand("weave:status");
    expect(host.notifyCalls.at(-1)).toEqual(statusForB);
  });

  it("keeps a stale active-plan result from repainting a tracker that has moved on", async () => {
    const stalePlanResolution = deferredResultAsync<PlanTaskSnapshot, never>(
      undefined as never,
    );
    const provider = new MutablePlanStateProvider();
    let deferNextRead = false;
    provider.readSnapshot = (planName) => {
      if (deferNextRead) {
        deferNextRead = false;
        return stalePlanResolution.start();
      }
      return okAsync(planSnapshotFixture(planName)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    };
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        { agentName: "loom", source: "explicit", descriptor: loomDescriptor() },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    await completeDirectChild(processPort, await processPort.spawnCalled);
    await execution;
    await flushBackgroundWork();

    deferNextRead = true;
    const staleAltT = host.invokeShortcut("alt+t");
    await stalePlanResolution.called;

    // The tracked instance the stale resolution was started for is gone.
    host.scriptConfirm(true);
    await host.invokeCommand("weave:abort");
    await flushBackgroundWork();
    const clearedWidget = host.widgetCalls
      .filter((call) => call.key === "weave-plan")
      .at(-1);
    const clearedFooter = host.statusCalls
      .filter((call) => call.key === "weave-task")
      .at(-1);
    expect(clearedWidget?.value).toBeUndefined();
    expect(clearedFooter?.value).toBeUndefined();

    stalePlanResolution.settle(ok(planSnapshotFixture("gated-flow")));
    await staleAltT;
    await flushBackgroundWork();

    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual(clearedWidget);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual(clearedFooter);
    await host.invokeCommand("weave:status");
    expect(JSON.stringify(host.notifyCalls.at(-1))).not.toContain(
      "Finish task",
    );
  });

  it("ignores a deferred Alt+T plan result from an old generation", async () => {
    const oldPlanResolution = deferredResultAsync<PlanTaskSnapshot, never>(
      undefined as never,
    );
    let providerCount = 0;
    const oldProvider = new MutablePlanStateProvider(
      planSnapshotFixture("old-plan"),
    );
    const newProvider = new MutablePlanStateProvider(
      planSnapshotFixture("new-plan"),
    );
    newProvider.readSnapshot = (planName) =>
      okAsync(planSnapshotFixture(planName)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => {
        providerCount += 1;
        return providerCount === 1 ? oldProvider : newProvider;
      },
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const oldRun = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    const oldProcess = await processPort.spawnCalled;
    await completeDirectChild(processPort, oldProcess);
    await oldRun;
    await flushBackgroundWork();

    oldProvider.readSnapshot = () => oldPlanResolution.start();
    const oldAltT = host.invokeShortcut("alt+t");
    await oldPlanResolution.called;

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const newRun = host.invokeCommand("weave:run", "gated-flow");
    const newProcess = await processPort.spawnPromises[1];
    await completeDirectChild(processPort, newProcess);
    await newRun;
    await flushBackgroundWork();

    const notificationCount = host.notifyCalls.length;
    const customOverlayCount = host.customCalls.length;
    const currentPlanWidget = host.widgetCalls
      .filter((call) => call.key === "weave-plan")
      .at(-1);
    const currentTaskFooter = host.statusCalls
      .filter((call) => call.key === "weave-task")
      .at(-1);

    oldPlanResolution.settle(ok(planSnapshotFixture("old-plan")));
    await oldAltT;
    await flushBackgroundWork();

    expect(host.notifyCalls).toHaveLength(notificationCount);
    expect(host.customCalls).toHaveLength(customOverlayCount);
    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual(currentPlanWidget);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual(currentTaskFooter);
  });

  it("fails closed for retained Alt+T callbacks after replacement", async () => {
    const overlayPlanResolution = deferredResultAsync<PlanTaskSnapshot, never>(
      undefined as never,
    );
    let providerCount = 0;
    const oldProvider = new MutablePlanStateProvider(
      planSnapshotFixture("old-plan"),
    );
    const newProvider = new MutablePlanStateProvider(
      planSnapshotFixture("new-plan"),
    );
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => {
        providerCount += 1;
        return providerCount === 1 ? oldProvider : newProvider;
      },
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const oldRun = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    const oldProcess = await processPort.spawnCalled;
    await completeDirectChild(processPort, oldProcess);
    await oldRun;
    await flushBackgroundWork();

    oldProvider.readSnapshot = () => overlayPlanResolution.start();
    const customCalled = host.waitForNextCustomCall();
    const oldAltT = host.invokeShortcut("alt+t");
    await overlayPlanResolution.called;
    overlayPlanResolution.settle(ok(planSnapshotFixture("gated-flow")));
    await customCalled;
    expect(host.customCalls).toHaveLength(1);
    const oldComponent = host.customComponents.at(-1);
    expect(oldComponent).toBeDefined();
    if (oldComponent === undefined)
      throw new Error("old Alt+T overlay missing");
    expect(
      host.customRenderedLines
        .at(-1)
        ?.some((line) => line.includes('Plan "gated-flow"')),
    ).toBe(true);

    const statusBeforeReplacement = [...host.statusCalls];
    const doneCallsBeforeReplacement = host.customDoneCalls;

    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    expect(statusBeforeReplacement.length).toBeGreaterThan(0);

    // Replacement settles the retained overlay itself: the awaited
    // `ctx.ui.custom()` promise resolves without any test-only escape hatch,
    // and it resolves exactly once.
    expect(host.customDoneCalls).toBe(doneCallsBeforeReplacement + 1);
    await oldAltT;
    await flushBackgroundWork();

    const statusAfterReplacement = [...host.statusCalls];
    const widgetsAfterReplacement = [...host.widgetCalls];
    const notificationsAfterReplacement = host.notifyCalls.length;
    const customOverlaysAfterReplacement = host.customCalls.length;
    const requestRendersAfterReplacement = host.customRequestRenderCalls;
    const doneCallsAfterReplacement = host.customDoneCalls;

    expect(oldComponent.render(80)).toEqual([]);
    oldComponent.handleInput("j");
    oldComponent.handleInput("\u001b");

    expect(host.statusCalls).toEqual(statusAfterReplacement);
    expect(host.widgetCalls).toEqual(widgetsAfterReplacement);
    expect(host.notifyCalls).toHaveLength(notificationsAfterReplacement);
    expect(host.customCalls).toHaveLength(customOverlaysAfterReplacement);
    expect(host.customRequestRenderCalls).toBe(requestRendersAfterReplacement);
    // Stale callbacks after the lifecycle close are inert: no second
    // settlement, no repaint, no notification.
    expect(host.customDoneCalls).toBe(doneCallsAfterReplacement);

    // The new generation still owns a working Alt+T: the closed overlay left
    // no handle behind that would block or hijack the next one.
    newProvider.setSnapshot(planSnapshotFixture("gated-flow"));
    host.scriptConfirm(true);
    const newRun = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    await completeDirectChild(processPort, await processPort.spawnPromises[1]);
    await newRun;
    await flushBackgroundWork();

    const freshCustomCalled = host.waitForNextCustomCall();
    const freshAltT = host.invokeShortcut("alt+t");
    await freshCustomCalled;
    expect(host.customCalls).toHaveLength(customOverlaysAfterReplacement + 1);
    expect(
      host.customRenderedLines
        .at(-1)
        ?.some((line) => line.includes('Plan "gated-flow"')),
    ).toBe(true);
    host.inputCustom("\u001b");
    await freshAltT;
    expect(host.customDoneCalls).toBe(doneCallsAfterReplacement + 1);
  });

  it("closes an open Alt+T overlay when the session shuts down", async () => {
    const provider = new MutablePlanStateProvider(
      planSnapshotFixture("gated-flow"),
    );
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const run = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    await completeDirectChild(processPort, await processPort.spawnCalled);
    await run;
    await flushBackgroundWork();

    const customCalled = host.waitForNextCustomCall();
    const altT = host.invokeShortcut("alt+t");
    await customCalled;
    const component = host.customComponents.at(-1);
    if (component === undefined) throw new Error("Alt+T overlay missing");
    const doneCallsBeforeShutdown = host.customDoneCalls;

    await host.triggerSessionShutdown();

    // Shutdown settles the overlay itself; the awaited promise resolves with
    // no test-only completion and with exactly one settlement.
    expect(host.customDoneCalls).toBe(doneCallsBeforeShutdown + 1);
    await altT;
    await flushBackgroundWork();

    // Callbacks retained by the closed overlay stay inert.
    expect(component.render(80)).toEqual([]);
    component.handleInput("\u001b");
    expect(host.customDoneCalls).toBe(doneCallsBeforeShutdown + 1);
  });

  it("settles an Alt+T overlay once across cancel, replacement, and shutdown", async () => {
    const provider = new MutablePlanStateProvider(
      planSnapshotFixture("gated-flow"),
    );
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const run = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    await completeDirectChild(processPort, await processPort.spawnCalled);
    await run;
    await flushBackgroundWork();

    const customCalled = host.waitForNextCustomCall();
    const altT = host.invokeShortcut("alt+t");
    await customCalled;
    const component = host.customComponents.at(-1);
    if (component === undefined) throw new Error("Alt+T overlay missing");
    const doneCallsBeforeCancel = host.customDoneCalls;

    // The configured cancel key still settles the overlay exactly once.
    host.inputCustom("\u001b");
    await altT;
    await flushBackgroundWork();
    expect(host.customDoneCalls).toBe(doneCallsBeforeCancel + 1);

    // Repeated cancel, replacement, shutdown, and stale input after a normal
    // close are all harmless: none of them settles the promise a second time.
    host.inputCustom("\u001b");
    await host.triggerSessionStart();
    component.handleInput("\u001b");
    component.render(80);
    await host.triggerSessionShutdown();
    await flushBackgroundWork();
    expect(host.customDoneCalls).toBe(doneCallsBeforeCancel + 1);
  });

  it("fails closed for stale primary telemetry after replacement", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const journalEntries: unknown[] = [];
    const staleUsageFailure = queryError("old-generation usage write failed");
    const deferredUsage = deferredResultAsync<never, RuntimeStoreError>(
      staleUsageFailure,
    );
    let usageWrites = 0;
    const telemetryUsage: NonNullable<PiExtensionDeps["telemetryUsage"]> = {
      recordObservation: () => {
        usageWrites += 1;
        if (usageWrites === 1) return deferredUsage.start();
        return errAsync(
          queryError("current-generation usage write failed"),
        ) as ResultAsync<never, RuntimeStoreError>;
      },
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      telemetryUsage,
      telemetryJournal: {
        write: (entry: unknown) => {
          journalEntries.push(entry);
          return okAsync(undefined);
        },
      },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    const oldContext = host.createSessionContext();
    const oldMessageEnd = host.triggerEvent(
      "message_end",
      {
        message: {
          role: "assistant",
          id: "old-primary-message",
          usage: { input: 1, output: 2 },
        },
      },
      oldContext,
    );
    await deferredUsage.called;
    expect(usageWrites).toBe(1);

    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
    const replacementNotificationCount = host.notifyCalls.length;
    const replacementDegradationCount = journalEntries.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { eventType?: unknown }).eventType ===
          "telemetry-degradation.degraded",
    ).length;

    deferredUsage.settle(err(staleUsageFailure));
    await oldMessageEnd;
    await flushBackgroundWork();

    expect(host.notifyCalls).toHaveLength(replacementNotificationCount);
    expect(
      journalEntries.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { eventType?: unknown }).eventType ===
            "telemetry-degradation.degraded",
      ),
    ).toHaveLength(replacementDegradationCount);

    await host.triggerEvent("message_end", {
      message: {
        role: "assistant",
        id: "current-primary-message",
        usage: { input: 3, output: 4 },
      },
    });
    await flushBackgroundWork();

    expect(usageWrites).toBe(2);
    expect(host.notifyCalls).toHaveLength(replacementNotificationCount + 1);
    expect(
      journalEntries.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { eventType?: unknown }).eventType ===
            "telemetry-degradation.degraded",
      ),
    ).toHaveLength(replacementDegradationCount + 1);
  });

  it("fails closed for an old delegation telemetry callback after replacement", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const processPort = new FakeChildProcessPort();
    const usageObservations: unknown[] = [];
    const telemetryUsage: NonNullable<PiExtensionDeps["telemetryUsage"]> = {
      recordObservation: (observation) => {
        usageObservations.push(observation);
        return okAsync({ kind: "inserted", observation } as never);
      },
    };
    installDelegationLifecycleExtension(host, processPort, {
      telemetryUsage,
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    const oldRegistration = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    expect(oldRegistration).toBeDefined();
    if (oldRegistration === undefined) throw new Error("delegate tool missing");
    const oldExecution = oldRegistration.execute(
      "old-call",
      { agent: "shuttle", task: "old task" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    void oldExecution.catch(() => undefined);
    const oldProcess = await processPort.spawnCalled;
    await authenticateDirectChild(processPort, oldProcess);

    await host.triggerSessionStart();
    const newRegistration = host.registerToolCalls.at(-1);
    expect(newRegistration?.name).toBe("weave_delegate");
    if (newRegistration === undefined)
      throw new Error("new delegate tool missing");
    const newExecution = newRegistration.execute(
      "new-call",
      { agent: "shuttle", task: "new task" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    void newExecution.catch(() => undefined);
    const newProcess = await processPort.spawnPromises[1];
    await authenticateDirectChild(processPort, newProcess);

    newProcess.emitLine({
      type: "message_end",
      message: {
        role: "assistant",
        id: "new-message",
        usage: { input: 3, output: 5 },
      },
    });
    await flushBackgroundWork();
    expect(usageObservations).toHaveLength(1);

    oldProcess.emitLine({
      type: "message_end",
      message: {
        role: "assistant",
        id: "old-message",
        usage: { input: 7, output: 11 },
      },
    });
    await flushBackgroundWork();

    expect(usageObservations).toHaveLength(1);
  });

  it("opens, scrolls, and cancels the Alt+T plan list for the current plan", async () => {
    const processPort = new FakeChildProcessPort();
    const provider = new MutablePlanStateProvider();
    const longPlan = (planName: string): PlanTaskSnapshot => ({
      planName,
      contentRevision: "test-revision",
      format: "canonical",
      parents: Array.from({ length: 30 }, (_unused, index) => ({
        id: `task-${index + 1}`,
        title: `Finish task ${index + 1}`,
        state: "pending" as const,
        children: [],
      })),
      totalParentCount: 30,
      complete: false,
    });
    provider.readSnapshot = (planName) =>
      okAsync(longPlan(planName)) as ResultAsync<PlanTaskSnapshot, never>;
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        { agentName: "loom", source: "explicit", descriptor: loomDescriptor() },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    const process = await processPort.spawnCalled;
    await completeDirectChild(processPort, process);
    await execution;
    await flushBackgroundWork();

    const spawnsBeforePopup = processPort.spawnPromises.length;
    const customCalled = host.waitForNextCustomCall();
    const altT = host.invokeShortcut("alt+t");
    await customCalled;

    // Opens on the first window, bounded by the host's reported terminal rows.
    const opened = host.customRenderedLines.at(-1) ?? [];
    expect(opened[0]).toContain('Plan "gated-flow"');
    expect(opened.some((line) => line.includes("Finish task 1"))).toBe(true);
    expect(opened.some((line) => line.includes("Finish task 30"))).toBe(false);
    for (const line of opened) {
      expect(line.length).toBeLessThanOrEqual(80);
    }

    // Down scrolls through the host's configured tui.select.down binding.
    host.inputCustom("\u001b[B");
    const scrolled = host.customRenderedLines.at(-1) ?? [];
    expect(scrolled.some((line) => line.includes("Finish task 1."))).toBe(
      false,
    );
    expect(scrolled.some((line) => line.includes("Finish task 2"))).toBe(true);
    expect(host.customRequestRenderCalls).toBeGreaterThan(0);

    // Up clamps at the top rather than underflowing.
    host.inputCustom("\u001b[A");
    host.inputCustom("\u001b[A");
    expect(host.customRenderedLines.at(-1)).toEqual(opened);

    // Cancel closes exactly once and starts nothing.
    host.inputCustom("\u001b");
    await altT;
    expect(host.customDoneCalls).toBe(1);
    expect(processPort.spawnPromises).toHaveLength(spawnsBeforePopup);
  });

  it("notifies instead of opening a stale Alt+T modal when no workflow is active", async () => {
    const processPort = new FakeChildProcessPort();
    const provider = new MutablePlanStateProvider();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        { agentName: "loom", source: "explicit", descriptor: loomDescriptor() },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    await flushBackgroundWork();

    await host.invokeShortcut("alt+t");
    expect(host.customCalls).toHaveLength(0);
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "No Weave workflow is active",
    );
  });

  it("renders a recovered plan through the shared widget, footer, and Alt+T resolver without resuming", async () => {
    const processPort = new FakeChildProcessPort();
    const runtimeStore = createInMemoryRuntimeStore();
    const recoveryStore = new InMemoryRecoveryPointerStore();
    const provider = new MutablePlanStateProvider();
    provider.readSnapshot = (planName) =>
      okAsync(planSnapshotFixture(planName)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(runtimeStore),
      },
      recoveryPointerStoreFactory: () => recoveryStore,
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    const process = await processPort.spawnCalled;
    await completeDirectChild(processPort, process);
    await execution;
    await flushBackgroundWork();

    const spawnCountBeforeRecovery = processPort.spawnPromises.length;
    await host.triggerSessionStart();
    await flushBackgroundWork();

    const recoveredWidget = host.widgetCalls
      .filter((call) => call.key === "weave-plan")
      .at(-1);
    const recoveredTaskFooter = host.statusCalls
      .filter((call) => call.key === "weave-task")
      .at(-1);
    expect(JSON.stringify(recoveredWidget?.value)).toContain("Finish task");
    expect(JSON.stringify(recoveredTaskFooter?.value)).toContain("Finish task");

    const customCalled = host.waitForNextCustomCall();
    const altT = host.invokeShortcut("alt+t");
    await customCalled;
    expect(
      host.customRenderedLines
        .at(-1)
        ?.some((line) => line.includes("Finish task")),
    ).toBe(true);
    // The overlay closes through its own configured cancel key, not through a
    // test-only completion hook.
    host.inputCustom("\u001b");
    await altT;
    expect(processPort.spawnPromises).toHaveLength(spawnCountBeforeRecovery);
  });

  it("re-resolves a recovery pointer that moved to another workflow while a read was pending", async () => {
    const deferredSnapshot = deferredResultAsync<PlanTaskSnapshot, never>(
      undefined as never,
    );
    const provider = new MutablePlanStateProvider();
    let deferNextRead = false;
    provider.readSnapshot = (planName) => {
      if (deferNextRead) {
        deferNextRead = false;
        return deferredSnapshot.start();
      }
      return okAsync(namedTaskSnapshot(planName, "Task A")) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    };
    const processPort = new FakeChildProcessPort();
    const runtimeStore = createInMemoryRuntimeStore();
    const recoveryStore = new InMemoryRecoveryPointerStore();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(
        recoveryRacePlan(),
        GATED_WORKFLOW_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(runtimeStore),
      },
      recoveryPointerStoreFactory: () => recoveryStore,
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    // The workflow pauses at its gate, so pointer A names workflow A: a
    // recoverable, still inspectable instance.
    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    await completeDirectChild(processPort, await processPort.spawnCalled);
    await execution;
    await flushBackgroundWork();
    const pointerA = recoveryStore.all().at(-1);
    expect(pointerA?.status).toBe("recoverable");
    if (pointerA === undefined) throw new Error("missing pointer A");

    // A fresh session resolves workflow A from that pointer. Recovery-sourced
    // identity leaves the tracker empty, so nothing but the pointer itself can
    // tell workflow A apart from another workflow.
    await host.triggerSessionStart();
    await flushBackgroundWork();

    // Resolution A begins and blocks inside its plan read.
    deferNextRead = true;
    const pendingAltT = host.invokeShortcut("alt+t");
    await deferredSnapshot.called;

    // The pointer moves to workflow B while A's read is still pending.
    expect(
      (
        await recoveryStore.appendPointer({
          ...pointerA,
          workflowId: "workflow-b-instance",
          observedAt: "2026-01-01T00:00:00.000Z",
        })
      ).isOk(),
    ).toBe(true);

    const widgetsBeforeSettle = host.widgetCalls.filter(
      (call) => call.key === "weave-plan",
    ).length;
    const footersBeforeSettle = host.statusCalls.filter(
      (call) => call.key === "weave-task",
    ).length;
    const renderedBeforeSettle = host.customRenderedLines.length;
    const spawnsBeforeSettle = processPort.spawnPromises.length;
    deferredSnapshot.settle(ok(namedTaskSnapshot("gated-flow", "Task A")));
    await pendingAltT;
    await flushBackgroundWork();

    // A never paints: not the widget, not the durable footer, not the modal.
    expect(
      JSON.stringify(
        host.widgetCalls
          .filter((call) => call.key === "weave-plan")
          .slice(widgetsBeforeSettle),
      ),
    ).not.toContain("Task A");
    expect(
      JSON.stringify(
        host.statusCalls
          .filter((call) => call.key === "weave-task")
          .slice(footersBeforeSettle),
      ),
    ).not.toContain("Task A");
    expect(
      host.customRenderedLines
        .slice(renderedBeforeSettle)
        .some((lines) => lines.some((line) => line.includes("Task A"))),
    ).toBe(false);

    // Workflow B is resolved fresh, exactly once. This session never tracked
    // it, so the lookup fails closed: both surfaces end up clear and the user
    // sees one safe, path-free message instead of workflow A's stale plan.
    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual({ key: "weave-plan", value: undefined });
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual({ key: "weave-task", value: undefined });
    expect(host.notifyCalls.at(-1)?.message).toBe(
      "Weave could not read the active workflow. Use /weave:status for details.",
    );
    // The recheck and its single retry read state only: no child was spawned.
    expect(processPort.spawnPromises).toHaveLength(spawnsBeforeSettle);
  });

  it("never paints a recovery result whose pointer went terminal while pending", async () => {
    const deferredSnapshot = deferredResultAsync<PlanTaskSnapshot, never>(
      undefined as never,
    );
    const provider = new MutablePlanStateProvider();
    let deferNextRead = false;
    provider.readSnapshot = (planName) => {
      if (deferNextRead) {
        deferNextRead = false;
        return deferredSnapshot.start();
      }
      return okAsync(namedTaskSnapshot(planName)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    };
    const processPort = new FakeChildProcessPort();
    const runtimeStore = createInMemoryRuntimeStore();
    const recoveryStore = new InMemoryRecoveryPointerStore();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(
        recoveryRacePlan(),
        GATED_WORKFLOW_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(runtimeStore),
      },
      recoveryPointerStoreFactory: () => recoveryStore,
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    await completeDirectChild(processPort, await processPort.spawnCalled);
    await execution;
    await flushBackgroundWork();
    const pointer = recoveryStore.all().at(-1);
    expect(pointer).toBeDefined();
    if (pointer === undefined) throw new Error("missing recovery pointer");

    // A fresh session resolves the recovered plan, then the pending read is
    // held open while the pointer settles.
    await host.triggerSessionStart();
    await flushBackgroundWork();
    deferNextRead = true;
    const pendingAltT = host.invokeShortcut("alt+t");
    await deferredSnapshot.called;
    expect(
      (
        await recoveryStore.appendPointer({
          ...pointer,
          status: "terminal",
          observedAt: "2026-01-01T00:00:00.000Z",
        })
      ).isOk(),
    ).toBe(true);

    const notifyCountBeforeSettle = host.notifyCalls.length;
    deferredSnapshot.settle(ok(namedTaskSnapshot("gated-flow")));
    await pendingAltT;
    await flushBackgroundWork();

    // The settled pointer is not eligible, so the pending result clears
    // instead of painting, and the modal never opens on it.
    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual({ key: "weave-plan", value: undefined });
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual({ key: "weave-task", value: undefined });
    expect(
      host.customRenderedLines.some((lines) =>
        lines.some((line) => line.includes("Task gated-flow")),
      ),
    ).toBe(false);
    // The user is told, with a safe path-free message, that nothing is active.
    expect(host.notifyCalls.length).toBeGreaterThan(notifyCountBeforeSettle);
    expect(host.notifyCalls.at(-1)?.message).toBe(
      "No Weave workflow is active, so there is no plan to show.",
    );
  });

  it("lets a newer resolution keep ownership during a recovery pointer recheck", async () => {
    const deferredSnapshot = deferredResultAsync<PlanTaskSnapshot, never>(
      undefined as never,
    );
    const deferredPointer = deferredResultAsync<
      PiWeaveRecoveryPointerV1 | undefined,
      PiAdapterFailure
    >(undefined as unknown as PiAdapterFailure);
    const provider = new MutablePlanStateProvider();
    let deferNextRead = false;
    let title = "Task A";
    provider.readSnapshot = (planName) => {
      if (deferNextRead) {
        deferNextRead = false;
        return deferredSnapshot.start();
      }
      return okAsync(namedTaskSnapshot(planName, title)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    };
    const processPort = new FakeChildProcessPort();
    const runtimeStore = createInMemoryRuntimeStore();
    const recoveryStore = new DeferrableRecoveryPointerStore();
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(
        recoveryRacePlan(),
        GATED_WORKFLOW_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(runtimeStore),
      },
      recoveryPointerStoreFactory: () => recoveryStore,
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    await completeDirectChild(processPort, await processPort.spawnCalled);
    await execution;
    await flushBackgroundWork();
    await host.triggerSessionStart();
    await flushBackgroundWork();

    // Resolution A blocks in its plan read, then in its pointer recheck.
    deferNextRead = true;
    const pendingAltT = host.invokeShortcut("alt+t");
    await deferredSnapshot.called;
    recoveryStore.deferNextRead = () => deferredPointer.start();
    deferredSnapshot.settle(ok(namedTaskSnapshot("gated-flow", "Task A")));
    await deferredPointer.called;

    // Resolution B runs to completion while A waits on its recheck, so B owns
    // the retained view and both surfaces.
    title = "Task B";
    const customCalledForB = host.waitForNextCustomCall();
    const altTForB = host.invokeShortcut("alt+t");
    await customCalledForB;
    host.inputCustom("\u001b");
    await altTForB;
    await flushBackgroundWork();
    const widgetForB = host.widgetCalls
      .filter((call) => call.key === "weave-plan")
      .at(-1);
    const footerForB = host.statusCalls
      .filter((call) => call.key === "weave-task")
      .at(-1);
    expect(JSON.stringify(widgetForB?.value)).toContain("Task B");
    expect(JSON.stringify(footerForB?.value)).toContain("Task B");
    const widgetCountForB = host.widgetCalls.filter(
      (call) => call.key === "weave-plan",
    ).length;
    const footerCountForB = host.statusCalls.filter(
      (call) => call.key === "weave-task",
    ).length;
    const overlayCountForB = host.customCalls.length;

    // A's recheck now finishes, and even though the pointer still confirms A's
    // workflow, A has lost ownership: it may neither paint nor clear.
    deferredPointer.settle(ok(recoveryStore.all().at(-1)));
    await pendingAltT;
    await flushBackgroundWork();

    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan"),
    ).toHaveLength(widgetCountForB);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task"),
    ).toHaveLength(footerCountForB);
    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual(widgetForB);
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual(footerForB);
    expect(host.customCalls).toHaveLength(overlayCountForB);
    expect(
      host.customRenderedLines.some((lines) =>
        lines.some((line) => line.includes("Task A")),
      ),
    ).toBe(false);
  });

  it("clears active-plan surfaces before an early startup return", async () => {
    const processPort = new FakeChildProcessPort();
    const provider = new MutablePlanStateProvider();
    provider.readSnapshot = (planName) =>
      okAsync(planSnapshotFixture(planName)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    const process = await processPort.spawnCalled;
    await completeDirectChild(processPort, process);
    await execution;
    await flushBackgroundWork();
    expect(
      JSON.stringify(
        host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1)
          ?.value,
      ),
    ).toContain("Finish task");

    host.setMode("print");
    await host.triggerSessionStart();

    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual({ key: "weave-plan", value: undefined });
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual({ key: "weave-task", value: undefined });
  });

  it("clears active-plan surfaces when a read fails through Alt+T", async () => {
    const processPort = new FakeChildProcessPort();
    const provider = new MutablePlanStateProvider();
    provider.readSnapshot = (planName) =>
      okAsync(planSnapshotFixture(planName)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    const process = await processPort.spawnCalled;
    await completeDirectChild(processPort, process);
    await execution;
    await flushBackgroundWork();
    const customCount = host.customCalls.length;

    provider.readSnapshot = () =>
      errAsync({ type: "PlanStateUnavailable" }) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    await host.invokeShortcut("alt+t");
    await flushBackgroundWork();

    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual({ key: "weave-plan", value: undefined });
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual({ key: "weave-task", value: undefined });
    expect(host.customCalls).toHaveLength(customCount);
  });

  it("clears active-plan surfaces on terminal abort and remains clear with no active workflow", async () => {
    const processPort = new FakeChildProcessPort();
    const provider = new MutablePlanStateProvider();
    provider.readSnapshot = (planName) =>
      okAsync(planSnapshotFixture(planName)) as ResultAsync<
        PlanTaskSnapshot,
        never
      >;
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      systemPromptSkills: [],
    });
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: loomDescriptor(),
        },
        {
          agentName: "shuttle",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "shuttle" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, GATED_WORKFLOW_CONFIG),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "gated-flow");
    await flushBackgroundWork();
    const process = await processPort.spawnCalled;
    await completeDirectChild(processPort, process);
    await execution;
    await flushBackgroundWork();
    expect(
      JSON.stringify(
        host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1)
          ?.value,
      ),
    ).toContain("Finish task");

    host.scriptConfirm(true);
    await host.invokeCommand("weave:abort");
    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual({ key: "weave-plan", value: undefined });
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual({ key: "weave-task", value: undefined });

    await host.invokeCommand("weave:abort");
    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual({ key: "weave-plan", value: undefined });
    expect(
      host.statusCalls.filter((call) => call.key === "weave-task").at(-1),
    ).toEqual({ key: "weave-task", value: undefined });
  });
});

describe("createPiExtension: themed active-agent badge", () => {
  /** Renders Pi theme calls as inspectable tags so exact nesting is assertable. */
  const theme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<bold>${text}</bold>`,
    bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  } as const;

  function badge(agentName: string): string {
    const label = agentName.toUpperCase();
    return `<accent>◆</accent> <bold>WEAVE</bold> <muted>·</muted> <${selectAgentBadgeBg(
      agentName,
    )}><accent><bold>${label}</bold></accent></${selectAgentBadgeBg(
      agentName,
    )}>`;
  }

  function themedHost(): RecordingFakePiHost {
    return new RecordingFakePiHost({ mode: "tui", trusted: true, theme });
  }

  it("paints the committed boot primary with its own supported background token", async () => {
    const host = themedHost();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
        ],
        errors: [],
      }),
    });

    await host.triggerSessionStart();

    const painted = host.statusCalls
      .filter((call) => call.key === "weave-agent")
      .at(-1);
    expect(painted).toEqual({ key: "weave-agent", value: badge("loom") });
    expect(PI_AGENT_BADGE_BG_TOKENS).toContain(selectAgentBadgeBg("loom"));
  });

  it("repaints with the switched agent's own token on Alt+A and restores the same badge back", async () => {
    const host = themedHost();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor(),
          },
          {
            agentName: "tapestry",
            source: "explicit",
            descriptor: tapestryDescriptor(),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeShortcut("alt+a");
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: badge("tapestry"),
    });

    await host.invokeShortcut("alt+a");
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: badge("loom"),
    });
  });

  it("commits no colored badge when the only primary fails to activate", async () => {
    const host = themedHost();
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ mode: "subagent" }),
          },
        ],
        errors: [],
      }),
    });

    await host.triggerSessionStart();

    expect(
      host.statusCalls.filter(
        (call) => call.key === "weave-agent" && typeof call.value === "string",
      ),
    ).toEqual([]);
  });

  it("never repaints a colored badge for a stale primary switch", async () => {
    const bootModel = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const switchModel = { provider: "openai", id: "gpt-5.2-codex" };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      theme,
      availableModels: [bootModel, switchModel],
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({
              models: ["anthropic/claude-sonnet-4-5#high"],
            }),
          },
          {
            agentName: "tapestry",
            source: "explicit",
            descriptor: tapestryDescriptor({
              models: ["openai/gpt-5.2-codex#high"],
            }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();

    const deferred = host.deferNextSetModel();
    const staleSwitch = host.invokeShortcut("alt+a");
    await deferred.called;
    const replacementStart = host.triggerSessionStart();
    await flushBackgroundWork();
    deferred.settle(true);
    await staleSwitch;
    await replacementStart;

    expect(
      host.statusCalls.filter(
        (call) =>
          call.key === "weave-agent" && call.value === badge("tapestry"),
      ),
    ).toHaveLength(0);
  });
});
