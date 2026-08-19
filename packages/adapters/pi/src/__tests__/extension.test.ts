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
  renderActiveAgentBadge,
  selectAgentBadgeBg,
} from "../agent-cycle.js";
import { DefaultPiCapabilityProber } from "../capability-prober.js";
import {
  bytesToHex,
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
import type { PiChildRefRecord } from "../child-session-refs.js";
import { createPiChildSessionStorageAuthority } from "../child-session-storage-authority.js";
import { PI_CHILD_TITLE_PROVENANCE } from "../child-title.js";
import { MAX_FINAL_OUTPUT_BYTES } from "../child-tree.js";
import { WEAVE_COMMAND_NAMES } from "../commands.js";
import { PiConfigActivator } from "../config-activator.js";
import {
  PI_CONFIG_REFRESH_DEFERRAL_MESSAGE,
  type PiConfigCatalogState,
} from "../config-refresh.js";
import {
  createPiConfigSourceManifest,
  type PiConfigSourceFsPort,
} from "../config-source-digests.js";
import type {
  PiOverlayChildDescriptor,
  PiThreadCachePort,
  PiThreadRefPort,
  PiThreadSessionPort,
} from "../delegation-controller.js";
import type { PiAdapterFailure } from "../errors.js";
import {
  createPiExtension,
  PI_SHARED_LOG_PATH,
  type PiCodexFastProviderSeam,
  type PiExtensionDeps,
  type PiExtensionInstance,
  parsePiSkillsFromSystemPrompt,
  readOverlaySessionEntryPage,
  resolveDirectStepBadgeAgent,
  resolveWeaveInputDecision,
} from "../extension-impl.js";
import { FOREGROUND_PLAN_ENTRY_TYPE } from "../foreground-plan-display.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PI_HOST_COMPATIBILITY_MATRIX } from "../host-compatibility-matrix.js";
import {
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
  type PiHostSurfaceReader,
} from "../host-inventory.js";
import type { PiHostModuleProvenance } from "../host-module-loader.js";
import { FakePathContainmentPort } from "../path-containment.js";
import { FakePiPlanCatalogPort } from "../plan-catalog.js";
import type { ProviderFastPublicSnapshot } from "../provider-fast-activation.js";
import type {
  PiRecoveryPointerStore,
  PiWeaveRecoveryPointerV1,
} from "../recovery-pointer.js";
import { InMemoryRecoveryPointerStore } from "../recovery-pointer.js";
import type { JsonValue } from "../strict-json.js";
import {
  serializeCompletionCandidate,
  WEAVE_COMPLETE_STEP_TOOL_NAME,
} from "../structured-completion.js";
import {
  createProductionPiThreadSourceFactory,
  type PiThreadSourceFactory,
  type PiThreadSourceFactoryInput,
  type PiThreadSources,
} from "../thread-sources.js";
import type { IdGenerator, PiEnvPort } from "../types.js";
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
import {
  removeRealTempRoot,
  reserveRealTempPath,
} from "./fakes/real-temp-root.js";
import {
  createTestOnlyObservedSessionStorageAuthority,
  TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
} from "./fakes/test-only-session-storage-authority.js";

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

/** A direct step whose agent is deliberately *not* the committed primary. */
const TAPESTRY_DIRECT_STEP_CONFIG = (() => {
  const parsed = parseConfig(`
workflow tapestry-flow {
  description "Direct-step identity fixture"
  version 1

  step run {
    name "Run direct step"
    type autonomous
    agent tapestry
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

const QUICK_FIX_REGRESSION_CONFIG = (() => {
  const parsed = parseConfig(`
workflow quick-fix-regression {
  description "Fix then review"
  version 1

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix the issue"
    completion agent_signal
  }

  step review {
    name "Review"
    type gate
    agent weft
    prompt "Review the fix"
    completion review_verdict
    on_reject pause
  }
}
`);
  if (parsed.isErr()) throw new Error(JSON.stringify(parsed.error));
  return {
    ...EMPTY_CONFIG,
    agents: { loom: {}, shuttle: {}, weft: {} },
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

/**
 * Since ADR 0014 recovery reads the parent session's child-ref ledger. An
 * eligible root is a non-settled ordinary ref with complete native metadata.
 */
function eligibleOrdinaryRecoveryRecord(
  overrides: Partial<PiChildRefRecord> = {},
): PiChildRefRecord {
  return {
    childId: "recover-me",
    threadId: "recover-me",
    nativeSessionId: "native-recover-me",
    sessionRef: "children/recover-me/session.jsonl",
    originParentSessionId: "parent",
    originEntryId: "entry-recover-me",
    title: "loom",
    titleProvenance: PI_CHILD_TITLE_PROVENANCE,
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    runs: [{ run: 1, action: "start", startedAt: 1 }],
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

/**
 * Structural Task 4/5/6 thread sources backing recovery and child-inspection
 * tests. The parent session's ref ledger is authoritative; status changes are
 * lifecycle appends, and a tombstone removes the ref from the live view.
 */
function mutableChildRefSource(
  input:
    | PiChildRefRecord
    | readonly PiChildRefRecord[] = eligibleOrdinaryRecoveryRecord(),
): {
  factory: PiThreadSourceFactory;
  sources: PiThreadSources;
  records: PiChildRefRecord[];
  updates: Array<{
    readonly childId: string;
    readonly status: PiChildRefRecord["status"];
  }>;
  cleared: string[];
  openedParentSessionIds: string[];
} {
  const records = [...(Array.isArray(input) ? input : [input])];
  const updates: Array<{
    readonly childId: string;
    readonly status: PiChildRefRecord["status"];
  }> = [];
  const cleared: string[] = [];
  const openedParentSessionIds: string[] = [];
  let parentSessionId = "parent";
  const indexOf = (childId: string) =>
    records.findIndex((candidate) => candidate.childId === childId);
  const refs = {
    liveParentSessionId: () => parentSessionId,
    readRefs: () =>
      okAsync({
        refs: [...records],
        issues: [],
        counts: {
          scannedEntries: records.length,
          candidateEntries: records.length,
          malformedEntries: 0,
          originMismatchedChildren: 0,
          conflictingChildren: 0,
          duplicateEntries: 0,
          unusableSourceChildren: 0,
          usableRefs: records.length,
        },
      }),
    appendNewChild: (appended: Partial<PiChildRefRecord>) => {
      const record = { ...eligibleOrdinaryRecoveryRecord(), ...appended };
      records.push(record);
      return okAsync(record);
    },
    appendRunDivider: (record: PiChildRefRecord) => okAsync(record),
    appendLifecycle: (
      record: PiChildRefRecord,
      patch: { readonly status: PiChildRefRecord["status"] },
    ) => {
      updates.push({ childId: record.childId, status: patch.status });
      const index = indexOf(record.childId);
      const existing = index >= 0 ? records[index] : record;
      const next = {
        ...(existing as PiChildRefRecord),
        status: patch.status,
        updatedAt: 2,
        ...(patch.status === "running" || patch.status === "queued"
          ? {}
          : { settledAt: 2 }),
      };
      if (patch.status === "tombstoned") {
        if (index >= 0) records.splice(index, 1);
        cleared.push(record.childId);
      } else if (index >= 0) {
        records[index] = next;
      }
      return okAsync(next);
    },
  } as unknown as PiThreadRefPort;
  const sessionRecord = (ref: string, childId: string) => ({
    childId,
    sessionId: `native-${childId}`,
    ref,
    path: `/sessions/${childId}/session.jsonl`,
    parentSession: parentSessionId,
    cwd: "/project",
  });
  const sessions = {
    createChildSession: (created: { readonly childId: string }) =>
      okAsync(
        sessionRecord(
          `children/${created.childId}/session.jsonl`,
          created.childId,
        ),
      ),
    establishThreadLeaf: (ref: string) =>
      okAsync({ record: sessionRecord(ref, "recover-me"), leafId: "leaf-1" }),
    appendTombstone: () => okAsync({ ref: "tombstoned" }),
    openSession: (ref: string) => okAsync(sessionRecord(ref, "recover-me")),
    readThreadMetadata: () => okAsync({ threadId: "recover-me" }),
    readSessionEntries: (ref: string) =>
      okAsync({
        record: sessionRecord(ref, "recover-me"),
        entries: [{ id: "leaf-1" }],
      }),
  } as unknown as PiThreadSessionPort;
  const sources: PiThreadSources = {
    refs,
    sessions,
    cache: { upsertRef: () => ok(undefined) } as PiThreadCachePort,
    cacheMode: "active" as const,
  };
  const factory: PiThreadSourceFactory = (factoryInput) => {
    parentSessionId = factoryInput.parentSessionId;
    openedParentSessionIds.push(factoryInput.parentSessionId);
    return okAsync(sources);
  };
  return {
    factory,
    sources,
    records,
    updates,
    cleared,
    openedParentSessionIds,
  };
}

async function flushBackgroundWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function authenticateDirectChild(
  processPort: FakeChildProcessPort,
  process: FakeSpawnedProcess,
): Promise<(kind: PiControlKind, body: JsonValue) => Promise<void>> {
  const processIndex = processPort.spawnedProcesses.indexOf(process);
  const input = processPort.spawnInputs[processIndex];
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
  process.emitLine({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "GENERATION_LIFECYCLE_PAUSED" }],
    },
  });
  await send("settled", {
    outcome: "completed",
    completionCandidate: serializeCompletionCandidate({
      outcome: "paused",
      method: "review_verdict",
      approved: false,
      message: "GENERATION_LIFECYCLE_PAUSED",
    }),
    interventionCount: 0,
    // The child response contract accepts only parser-approved terminal
    // assistant prose. The structured completion candidate is metadata and
    // cannot stand in for that response.
    assistantOutput: "GENERATION_LIFECYCLE_PAUSED",
  });
}

async function completeDirectChildWithCandidate(
  processPort: FakeChildProcessPort,
  process: FakeSpawnedProcess,
  completionCandidate: object,
  assistantOutput: string,
): Promise<void> {
  const send = await authenticateDirectChild(processPort, process);
  process.emitLine({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: assistantOutput }],
    },
  });
  await send("settled", {
    outcome: "completed",
    completionCandidate: serializeCompletionCandidate(completionCandidate),
    interventionCount: 0,
    assistantOutput,
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
  source: ReturnType<typeof mutableChildRefSource>,
  restoreOrdinaryChild: NonNullable<PiExtensionDeps["restoreOrdinaryChild"]>,
  settings: { readonly recovery_countdown_seconds?: number } = {},
  overrides: Partial<PiExtensionDeps> = {},
) {
  return installExtension(host, "0.81.1", {
    capabilityProber: allOkCapabilityProber(),
    // Legacy custom-editor inspection tests pin this fallback so they keep
    // proving session-editor borrow/restore rather than the Task 12 native
    // overlay path (covered separately below).
    hostSurfaceReader: hostSurfaceReader(["child-overlay-lifecycle"]),
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
    threadSourceFactory: source.factory,
    restoreOrdinaryChild,
    ...overrides,
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
): PiExtensionInstance {
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
    // Stands in for Pi's process-wide keybindings manager, so overlay
    // shortcut registration can be modelled independently of editor
    // ownership. Absent unless a test sets `effectiveKeybindingConfig`.
    hostKeybindings: () => host.hostKeybindingsForTest(),
    // Model a descriptor-safe host by default. The production reader can never
    // report `descriptor-relative-native-session-io` as native, so without an
    // explicit reader every test would collapse into health-only mode and
    // lose its deep-module coverage. Tests that assert real host-surface
    // behaviour override this.
    hostSurfaceReader: hostSurfaceReader(),
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    ...overrides,
  });
  factory(host.api);
  return factory;
}

describe("createPiExtension factory (layer C: compiled extension against a fake host)", () => {
  it("registers commands, the palette shortcut, and lifecycle delegates without a tool-call interceptor", () => {
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
    // No provider request/header/response hook is registered: the adapter
    // sends no acceleration control and reads no provider response.
    expect(host.onCalls.map((call) => call.event).sort()).toEqual([
      "agent_settled",
      "agent_start",
      "before_agent_start",
      "context",
      "input",
      "message_end",
      "message_start",
      "model_select",
      "session_before_fork",
      "session_before_switch",
      "session_before_tree",
      "session_shutdown",
      "session_start",
      // Plan progress is re-read after the tool completions that can write a
      // plan file, so the rail's checkbox marks, `now` and `next` move with
      // the work instead of freezing at the value they were resolved with.
      "tool_execution_end",
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
      sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
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
      // Model a descriptor-safe host: the production reader always reports
      // `descriptor-relative-native-session-io` unavailable, which is a
      // required capability and would force health-only mode.
      hostSurfaceReader: hostSurfaceReader(),
    });
    factory(host.api);
    await host.triggerSessionStart();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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
    const turn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(turn.systemPrompt).toBe("native");
    expect(
      shownAgentBadgeHistory(host).filter(
        (value) => value === "◆ WEAVE · LOOM",
      ),
    ).toHaveLength(0);
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

  it("clears the Plan Rail on session_shutdown (Pi adapter contract) alongside the child-tree widget", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    await host.triggerSessionStart();
    await host.triggerSessionShutdown();
    const planWidgetCalls = host.widgetCalls.filter(
      (call) => call.key === "weave-plan",
    );
    expect(planWidgetCalls.length).toBeGreaterThan(0);
    expect(planWidgetCalls.at(-1)?.value).toBeUndefined();
    // The duplicate `weave-task` footer is gone: the rail is the only owner,
    // so there is no second surface left to clear.
    expect(host.statusCalls.some((call) => call.key === "weave-task")).toBe(
      false,
    );
    expect(shownAgentBadge(host)).toBeUndefined();
  });
});

/** The Plan Rail lines the host last mounted, or `[]` when it was removed. */
function planRailLines(host: RecordingFakePiHost): readonly string[] {
  const value = host.widgetCalls
    .filter((call) => call.key === "weave-plan")
    .at(-1)?.value;
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/** Whether the rail is currently naming an active task at all. */
function planRailShowsTask(host: RecordingFakePiHost): boolean {
  return planRailLines(host).some((line) => line.startsWith("┃ now"));
}

/** SGR escapes, built at runtime so the source carries no control byte. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

/** The `◆ WEAVE · NAME` identity a rail header states, ignoring colour. */
function railHeaderBadge(header: string): string | undefined {
  const parts = header.replace(ANSI, "").split(" · ");
  const mark = parts[0];
  const name = parts[1];
  if (mark === undefined || name === undefined) return undefined;
  return `${mark} · ${name}`;
}

/**
 * The agent identity Weave is showing, wherever it currently owns it.
 *
 * The Plan Rail owns ambient identity while it can mount; the `weave-agent`
 * status line is the fallback for hosts that cannot mount a widget. Asking
 * for the identity rather than for one surface keeps these assertions true to
 * the contract - exactly one owner - instead of naming which owner won.
 */
function shownAgentBadge(host: RecordingFakePiHost): string | undefined {
  const header = planRailLines(host)[0];
  if (header !== undefined) return railHeaderBadge(header);
  return host.statusCalls.filter((call) => call.key === "weave-agent").at(-1)
    ?.value;
}

/** Every agent identity Weave has shown, across both owners, in order. */
function shownAgentBadgeHistory(
  host: RecordingFakePiHost,
): (string | undefined)[] {
  const fromRail = host.widgetCalls
    .filter((call) => call.key === "weave-plan")
    .map((call) =>
      Array.isArray(call.value)
        ? railHeaderBadge((call.value as readonly string[])[0] ?? "")
        : undefined,
    );
  const fromStatus = host.statusCalls
    .filter((call) => call.key === "weave-agent")
    .map((call) => call.value);
  return [...fromRail, ...fromStatus];
}

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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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
    const committedBadge = shownAgentBadge(host);

    const turn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(turn.systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.activationCalls).toEqual(activationCalls);
    expect(shownAgentBadge(host)).toEqual(committedBadge);
  });

  it("appends the committed prompt for a fast primary without changing UI or activation", async () => {
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
              fast: true,
            }),
          },
        ],
        errors: [],
      }),
    });

    await host.triggerSessionStart();
    const turn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(turn.systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
      { kind: "thinking", level: "high" },
    ]);
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
    expect(host.statusCalls).toContainEqual({ key: "weave", value: "ready" });
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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");

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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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
      shownAgentBadgeHistory(host).filter(
        (value) => value === "◆ WEAVE · LOOM",
      ),
    ).toHaveLength(0);

    const turn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(turn.systemPrompt).toBe("native");
    expect(host.activationCalls).toHaveLength(0);
    expect(
      shownAgentBadgeHistory(host).filter(
        (value) => value === "◆ WEAVE · LOOM",
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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");

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
    expect(shownAgentBadge(host)).toEqual(undefined);

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
      shownAgentBadgeHistory(host).filter(
        (value) => value === "◆ WEAVE · TAPESTRY",
      ),
    ).toHaveLength(0);
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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
    const history = mutableChildRefSource([]);
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
      threadSourceFactory: history.factory,
    });

    const staleStartup = host.triggerSessionStart();
    await firstRead.called;

    await host.triggerSessionStart();
    const readyStatus = [...host.statusCalls];
    const readyTools = [...host.registerToolCalls];
    const readyActiveTools = host.getActiveTools();
    const readyBadge = shownAgentBadge(host);

    firstRead.settle(ok(nativeSurface));
    await staleStartup;

    expect(host.statusCalls).toEqual(readyStatus);
    expect(host.registerToolCalls).toEqual(readyTools);
    expect(host.getActiveTools()).toEqual(readyActiveTools);
    expect(shownAgentBadge(host)).toEqual(readyBadge);
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
    expect(shownAgentBadgeHistory(host)).toContain("◆ WEAVE · LOOM");

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
    expect(shownAgentBadge(host)).toEqual(undefined);

    replacementRead.settle(ok(nativeSurface));
    await replacementStartup;

    expect(host.statusCalls).toContainEqual({
      key: "weave",
      value: "ready",
    });
    expect(shownAgentBadgeHistory(host)).toContain("◆ WEAVE · LOOM");
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
    const history = mutableChildRefSource([]);
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
      threadSourceFactory: history.factory,
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
    const staleHistory = mutableChildRefSource([]);
    const currentHistory = mutableChildRefSource([]);
    const staleOpen = deferredResultAsync<PiThreadSources, never>(
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
                  recovery_enabled: false,
                },
              },
            },
          },
        } as unknown as WeaveConfig,
      ),
      runtimeStoreFactory: { open: () => okAsync(runtimeStore) },
      parentSessionId: () => "parent",
      threadSourceFactory: (input) => {
        historyOpenCount += 1;
        return historyOpenCount === 1
          ? staleOpen.start()
          : currentHistory.factory(input);
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

    staleOpen.settle(ok(staleHistory.sources));
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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");

    const replacementStartup = host.triggerSessionStart();
    await replacementRead.called;
    expect(shownAgentBadge(host)).toEqual(undefined);

    directProcess.failStdoutRead("stale generation");
    await workflowRun;
    await flushBackgroundWork();

    expect(shownAgentBadge(host)).toEqual(undefined);

    replacementRead.settle(ok(nativeSurface));
    await replacementStartup;
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
  });
});

describe("createPiExtension: the Plan Rail owns ambient parent context", () => {
  function installRail(
    host: RecordingFakePiHost,
    extra: Partial<Parameters<typeof installExtension>[2]> = {},
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
        ],
        errors: [],
      }),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      ...extra,
    });
  }

  it("mounts above the editor", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installRail(host);
    await host.triggerSessionStart();

    const mounted = host.widgetCalls
      .filter((call) => call.key === "weave-plan" && call.value !== undefined)
      .at(-1);
    expect(mounted?.options?.placement).toBe("aboveEditor");
  });

  it("shows the agent row, and only the agent row, with no active plan", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installRail(host);
    await host.triggerSessionStart();

    // One configured primary means there is nowhere to cycle to, so the rail
    // advertises no key it could not honour.
    expect(planRailLines(host)).toEqual(["◆ WEAVE · LOOM"]);
    expect(planRailShowsTask(host)).toBe(false);
  });

  it("advertises Alt+A, and only Alt+A, once another primary exists", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installForegroundStartTestExtension(host);
    await host.triggerSessionStart();

    const header = planRailLines(host)[0] ?? "";
    expect(header).toBe("◆ WEAVE · LOOM · Alt+A cycle");
    expect(header).not.toContain("Alt+T");
  });

  it("clears the fallback agent status whenever it mounts", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installRail(host);
    await host.triggerSessionStart();

    expect(planRailLines(host)).not.toEqual([]);
    expect(
      host.statusCalls
        .filter((call) => call.key === "weave-agent")
        .map((call) => call.value),
    ).not.toContain("◆ WEAVE · LOOM");
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1)
        ?.value,
    ).toBeUndefined();
  });

  it("removes the widget and the fallback status when no Weave primary is active", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installRail(host, {
      configActivator: fakeConfigActivator({ agents: [], errors: [] }),
    });
    await host.triggerSessionStart();

    expect(planRailLines(host)).toEqual([]);
    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1)
        ?.value,
    ).toBeUndefined();
    expect(shownAgentBadge(host)).toBeUndefined();
  });

  it("mounts no rail at all in a non-interactive session", async () => {
    const host = new RecordingFakePiHost({ mode: "print", trusted: true });
    installRail(host);
    await host.triggerSessionStart();

    // Widgets are a TUI affordance. A print session leaves the rail unmounted
    // and keeps the `weave-agent` status line as its only identity surface.
    expect(planRailLines(host)).toEqual([]);
    expect(
      host.widgetCalls
        .filter((call) => call.key === "weave-plan")
        .every((call) => call.value === undefined),
    ).toBe(true);
  });

  it("names the direct step's own agent while one is active, then the committed primary", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    const processPort = new FakeChildProcessPort();
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
            {
              agentName: "tapestry",
              source: "explicit",
              descriptor: tapestryDescriptor(),
            },
          ],
          errors: [],
        },
        TAPESTRY_DIRECT_STEP_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      processPort,
      childCommand: ["/fake/bin/pi"],
    });

    await host.triggerSessionStart();
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · LOOM");

    const workflowRun = host.invokeCommand("weave:run", "tapestry-flow");
    const directProcess = await processPort.spawnCalled;
    await flushBackgroundWork();
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · TAPESTRY");

    await completeDirectChild(processPort, directProcess);
    await workflowRun;
    await flushBackgroundWork();
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · LOOM");
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

    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · TAPESTRY");
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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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

    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · TAPESTRY");
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

    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
  });

  it("keeps the committed prompt after a failed Alt+A switch in both fast directions", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ fast: true }),
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
    await host.invokeShortcut("alt+a");
    const afterFailedFastSwitch = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(afterFailedFastSwitch.systemPrompt).toContain(
      "You are Loom, the main orchestrator.",
    );
    expect(afterFailedFastSwitch.systemPrompt).not.toContain(
      "You are Tapestry, the workflow orchestrator.",
    );
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
  });

  it("keeps the committed non-fast prompt after a failed switch to a fast ineligible agent", async () => {
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
            descriptor: tapestryDescriptor({ mode: "subagent", fast: true }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    await host.invokeShortcut("alt+a");
    const afterFailedAbsentSwitch = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(afterFailedAbsentSwitch.systemPrompt).toContain(
      "You are Loom, the main orchestrator.",
    );
    expect(afterFailedAbsentSwitch.systemPrompt).not.toContain(
      "You are Tapestry, the workflow orchestrator.",
    );
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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
      shownAgentBadgeHistory(host).filter((value) => value !== undefined),
    ).toEqual([]);
    expect(shownAgentBadge(host)).toEqual(undefined);
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

    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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
    expect(shownAgentBadge(host)).toBeUndefined();
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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");

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
            child_inspection: { recovery_countdown_seconds: 999 },
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
      "settings.adapters.pi.child_inspection.recovery_countdown_seconds",
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
    // Both generations committed Loom. The rail repaints whenever either half
    // of its context changes, so this counts commits, not repaints.
    expect(
      shownAgentBadgeHistory(host).filter((value) => value === "◆ WEAVE · LOOM")
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
  });

  it("uses one trusted parent-session thread identity across replacement generations and separates distinct sessions", async () => {
    const opened: string[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager({ id: "parent-session-a" }),
    });
    installExtension(host, "0.81.1", {
      parentSessionId: () => "parent-session-a",
      threadSourceFactory: (input) => {
        opened.push(input.parentSessionId);
        return errAsync({
          type: "ParentSessionUnavailable" as const,
          reason: "not persisted",
        });
      },
    });
    await host.triggerSessionStart();
    await host.triggerSessionStart();
    expect(opened).toEqual(["parent-session-a", "parent-session-a"]);

    const otherOpened: string[] = [];
    const otherHost = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: persistentFakeSessionManager({ id: "parent-session-b" }),
    });
    installExtension(otherHost, "0.81.1", {
      parentSessionId: () => "parent-session-b",
      threadSourceFactory: (input) => {
        otherOpened.push(input.parentSessionId);
        return errAsync({
          type: "ParentSessionUnavailable" as const,
          reason: "not persisted",
        });
      },
    });
    await otherHost.triggerSessionStart();
    expect(otherOpened).toEqual(["parent-session-b"]);
    expect(opened[0]).not.toBe(otherOpened[0]);
  });

  it("expires startup recovery countdown and restores one eligible root exactly once", async () => {
    const history = mutableChildRefSource();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect(undefined);
    installRecoveryExtension(
      host,
      history,
      () => {
        restores += 1;
        return okAsync({ finalOutput: "done", interventionCount: 1 });
      },
      { recovery_countdown_seconds: 0 },
    );
    await host.triggerSessionStart();
    await flushBackgroundWork();
    expect(restores).toBe(1);
    expect(history.records[0]?.status).toBe("completed");
    expect(history.records[0]?.settledAt).toBeDefined();
    expect(history.updates.map((update) => update.status)).toEqual([
      "running",
      "completed",
    ]);
  });

  it("skips startup recovery for an interrupted ref when session storage is path-only", async () => {
    const interrupted = eligibleOrdinaryRecoveryRecord({
      childId: "legacy-interrupted",
      threadId: "legacy-interrupted",
      nativeSessionId: "native-legacy-interrupted",
      sessionRef: "children/legacy-interrupted/session.jsonl",
      originEntryId: "entry-legacy-interrupted",
      title: "loom",
      status: "running",
    });
    const history = mutableChildRefSource(interrupted);
    const refBytesBefore = JSON.stringify(history.records);
    let restores = 0;
    let refAppends = 0;
    let cacheCalls = 0;
    let sessionMutations = 0;
    const refs = history.sources.refs as {
      appendNewChild: typeof history.sources.refs.appendNewChild;
      appendLifecycle: typeof history.sources.refs.appendLifecycle;
    };
    const originalAppendNew = refs.appendNewChild.bind(history.sources.refs);
    const originalLifecycle = refs.appendLifecycle.bind(history.sources.refs);
    refs.appendNewChild = ((input) => {
      refAppends += 1;
      return originalAppendNew(input);
    }) as typeof refs.appendNewChild;
    refs.appendLifecycle = ((record, patch) => {
      refAppends += 1;
      return originalLifecycle(record, patch);
    }) as typeof refs.appendLifecycle;
    const cache = history.sources.cache as {
      upsertRef: PiThreadCachePort["upsertRef"];
    };
    const originalUpsert = cache.upsertRef.bind(history.sources.cache);
    cache.upsertRef = ((ref, workspaceKey) => {
      cacheCalls += 1;
      return originalUpsert(ref, workspaceKey);
    }) as typeof cache.upsertRef;
    const sessions = history.sources.sessions as {
      createChildSession: PiThreadSessionPort["createChildSession"];
      establishThreadLeaf: PiThreadSessionPort["establishThreadLeaf"];
      appendTombstone: PiThreadSessionPort["appendTombstone"];
    };
    const originalCreate = sessions.createChildSession.bind(
      history.sources.sessions,
    );
    const originalLeaf = sessions.establishThreadLeaf.bind(
      history.sources.sessions,
    );
    const originalTombstone = sessions.appendTombstone.bind(
      history.sources.sessions,
    );
    sessions.createChildSession = ((input) => {
      sessionMutations += 1;
      return originalCreate(input);
    }) as typeof sessions.createChildSession;
    sessions.establishThreadLeaf = ((ref, metadata, expectedParent) => {
      sessionMutations += 1;
      return originalLeaf(ref, metadata, expectedParent);
    }) as typeof sessions.establishThreadLeaf;
    sessions.appendTombstone = ((record) => {
      sessionMutations += 1;
      return originalTombstone(record);
    }) as typeof sessions.appendTombstone;
    const storage = createPiChildSessionStorageAuthority();
    expect(storage.requireNativeSessionAuthority()._unsafeUnwrapErr()).toEqual({
      type: "SessionStorageUnavailable",
      reason: "pi-session-api-unavailable",
    });
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Recover now");
    installRecoveryExtension(
      host,
      history,
      () => {
        restores += 1;
        return okAsync({
          finalOutput: "must-not-restore",
          interventionCount: 0,
        });
      },
      { recovery_countdown_seconds: 0 },
      { sessionStorageAuthority: storage },
    );
    await host.triggerSessionStart();
    await flushBackgroundWork();
    expect(host.selectCalls).toHaveLength(0);
    expect(refAppends).toBe(0);
    expect(history.updates).toHaveLength(0);
    expect(restores).toBe(0);
    expect(sessionMutations).toBe(0);
    expect(cacheCalls).toBe(0);
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(
      host.notifyCalls.some((call) =>
        call.message.includes("Interrupted Weave children"),
      ),
    ).toBe(false);
    expect(
      host.notifyCalls.filter(
        (call) =>
          call.message === "Child recovery is unavailable in this session.",
      ),
    ).toHaveLength(0);
    expect(JSON.stringify(history.records)).toBe(refBytesBefore);
    await flushBackgroundWork();
    expect(cacheCalls).toBe(0);
    expect(refAppends).toBe(0);
    expect(sessionMutations).toBe(0);
    expect(restores).toBe(0);
  });

  it("checks path-only session storage before factory open and skips reconstruct/upsert/recovery", async () => {
    const order: string[] = [];
    const interrupted = eligibleOrdinaryRecoveryRecord({
      childId: "path-only-gated",
      threadId: "path-only-gated",
      nativeSessionId: "native-path-only-gated",
      sessionRef: "children/path-only-gated/session.jsonl",
      originEntryId: "entry-path-only-gated",
      title: "loom",
      status: "running",
    });
    const history = mutableChildRefSource(interrupted);
    let upsertCalls = 0;
    let restores = 0;
    const cache = history.sources.cache as {
      upsertRef: PiThreadCachePort["upsertRef"];
    };
    const originalUpsert = cache.upsertRef.bind(history.sources.cache);
    cache.upsertRef = ((ref, workspaceKey) => {
      upsertCalls += 1;
      order.push("upsert");
      return originalUpsert(ref, workspaceKey);
    }) as typeof cache.upsertRef;
    const storage = await createTestOnlyObservedSessionStorageAuthority({
      granted: false,
      onCheck: () => {
        order.push("authority");
      },
    });
    const factory: PiThreadSourceFactory = (input) => {
      order.push(
        input.readOnly === true ? "factory-readonly" : "factory-mutating",
      );
      return history.factory(input);
    };
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Recover now");
    installRecoveryExtension(
      host,
      history,
      () => {
        restores += 1;
        order.push("spawn");
        return okAsync({
          finalOutput: "must-not-restore",
          interventionCount: 0,
        });
      },
      { recovery_countdown_seconds: 0 },
      {
        sessionStorageAuthority: storage,
        threadSourceFactory: factory,
      },
    );
    await host.triggerSessionStart();
    await flushBackgroundWork();

    expect(order[0]).toBe("authority");
    expect(order).toContain("factory-readonly");
    expect(order.indexOf("authority")).toBeLessThan(
      order.indexOf("factory-readonly"),
    );
    expect(order).not.toContain("factory-mutating");
    expect(order).not.toContain("upsert");
    expect(order).not.toContain("spawn");
    expect(upsertCalls).toBe(0);
    expect(restores).toBe(0);
    expect(host.selectCalls).toHaveLength(0);
  });

  it("retains reconstruction and recovery on a descriptor-safe ready host", async () => {
    const order: string[] = [];
    const interrupted = eligibleOrdinaryRecoveryRecord({
      childId: "ready-reconstruct",
      threadId: "ready-reconstruct",
      nativeSessionId: "native-ready-reconstruct",
      sessionRef: "children/ready-reconstruct/session.jsonl",
      originEntryId: "entry-ready-reconstruct",
      title: "loom",
      status: "running",
    });
    const history = mutableChildRefSource(interrupted);
    let upsertCalls = 0;
    let restores = 0;
    const cache = history.sources.cache as {
      upsertRef: PiThreadCachePort["upsertRef"];
    };
    const originalUpsert = cache.upsertRef.bind(history.sources.cache);
    cache.upsertRef = ((ref, workspaceKey) => {
      upsertCalls += 1;
      order.push("upsert");
      return originalUpsert(ref, workspaceKey);
    }) as typeof cache.upsertRef;
    const storage = await createTestOnlyObservedSessionStorageAuthority({
      granted: true,
      onCheck: () => {
        order.push("authority");
      },
    });
    const factory: PiThreadSourceFactory = (input) => {
      order.push(
        input.readOnly === true ? "factory-readonly" : "factory-mutating",
      );
      // Align fixture origin with the host-probed parent so reconstruction
      // projects into the cache the same way a live ready generation does.
      for (const record of history.records) {
        (record as { originParentSessionId: string }).originParentSessionId =
          input.parentSessionId;
      }
      return history.factory(input);
    };
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Recover now");
    installRecoveryExtension(
      host,
      history,
      () => {
        restores += 1;
        order.push("spawn");
        return okAsync({ finalOutput: "done", interventionCount: 0 });
      },
      { recovery_countdown_seconds: 0 },
      {
        sessionStorageAuthority: storage,
        threadSourceFactory: factory,
      },
    );
    await host.triggerSessionStart();
    await flushBackgroundWork();

    expect(order[0]).toBe("authority");
    expect(order).toContain("factory-mutating");
    expect(order).toContain("upsert");
    expect(order).toContain("spawn");
    expect(order.indexOf("authority")).toBeLessThan(
      order.indexOf("factory-mutating"),
    );
    expect(order.indexOf("factory-mutating")).toBeLessThan(
      order.indexOf("upsert"),
    );
    expect(order.indexOf("upsert")).toBeLessThan(order.indexOf("spawn"));
    expect(upsertCalls).toBeGreaterThan(0);
    expect(restores).toBe(1);
  });

  it("keeps a pristine XDG data root absent after health-only startup surfaces", async () => {
    const xdgBase = await reserveRealTempPath("weave-pi-pristine");
    await Bun.write(`${xdgBase}/.keep`, "");
    await Bun.file(`${xdgBase}/.keep`).delete();
    const envPort: PiEnvPort = {
      read: (name) =>
        name === "XDG_DATA_HOME" || name === "HOME" ? xdgBase : undefined,
      deleteValue: () => undefined,
    };
    const order: string[] = [];
    const storage = await createTestOnlyObservedSessionStorageAuthority({
      granted: false,
      onCheck: () => {
        order.push("authority");
      },
    });
    let openDatabaseCalls = 0;
    const production = createProductionPiThreadSourceFactory();
    const factory: PiThreadSourceFactory = (
      input: PiThreadSourceFactoryInput,
    ) => {
      order.push(
        input.readOnly === true ? "factory-readonly" : "factory-mutating",
      );
      return production({
        ...input,
        openDatabase: () => {
          openDatabaseCalls += 1;
          order.push("openDatabase");
          throw new Error("openDatabase must not run on pristine read-only");
        },
      });
    };
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
      // Health-only: the required Pi session surface is absent.
      hostSurfaceReader: hostSurfaceReader(["session-restore"]),
      envPort,
      sessionStorageAuthority: storage,
      threadSourceFactory: factory,
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
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
    });
    await host.triggerSessionStart();
    await flushBackgroundWork();
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("health-only");
    await host.invokeCommand("weave:status");
    await host.invokeCommand("weave:health");
    await host.invokeCommand("weave:history");
    await host.invokeCommand("weave:doctor");
    await flushBackgroundWork();

    expect(order[0]).toBe("authority");
    expect(order).toContain("factory-readonly");
    expect(order).not.toContain("factory-mutating");
    expect(order).not.toContain("openDatabase");
    expect(openDatabaseCalls).toBe(0);

    const glob = new Bun.Glob("**/*");
    const paths: string[] = [];
    for await (const relative of glob.scan({
      cwd: xdgBase,
      onlyFiles: false,
      dot: true,
    })) {
      paths.push(relative);
    }
    expect(paths).toEqual([]);
    for (const name of [
      "child-metadata.sqlite",
      "child-metadata.sqlite-wal",
      "child-metadata.sqlite-shm",
      "child-metadata.sqlite-journal",
    ]) {
      expect(paths.some((path) => path.endsWith(name))).toBe(false);
    }
    await removeRealTempRoot(xdgBase);
  });

  it("honors exact startup choices: Recover now recovers, while Skip and Inspect preserve eligibility", async () => {
    for (const choice of ["Recover now", "Skip", "Inspect"] as const) {
      const history = mutableChildRefSource();
      let restores = 0;
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      host.scriptSelect(choice);
      installRecoveryExtension(host, history, () => {
        restores += 1;
        return okAsync({ finalOutput: "done", interventionCount: 0 });
      });
      await host.triggerSessionStart();
      await flushBackgroundWork();
      expect(restores).toBe(choice === "Recover now" ? 1 : 0);
      expect(history.records[0]?.settledAt === undefined).toBe(
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
    const history = mutableChildRefSource();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history, () => {
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
    const history = mutableChildRefSource();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Recover now");
    installRecoveryExtension(host, history, () =>
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
    ).toBeLessThanOrEqual(MAX_FINAL_OUTPUT_BYTES + 32);
    expect(sent.options).toEqual({ triggerTurn: false });
    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.generatedTurnCount).toBe(0);
    expect(host.customCalls).toHaveLength(0);
    expect(host.interventionCalls).toHaveLength(0);
    expect(host.widgetCalls).toHaveLength(widgetCallsBeforeSettlement);
  });

  it("turns restore and send failures into one safe notification without a turn or raw canary", async () => {
    for (const failure of ["restore", "send"] as const) {
      const history = mutableChildRefSource();
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      host.scriptSelect("Recover now");
      if (failure === "send") host.poisonSendMessage();
      installRecoveryExtension(host, history, () => {
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
    const history = mutableChildRefSource();
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
      threadSourceFactory: history.factory,
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
    const history = mutableChildRefSource();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: false });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history, () => {
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
    const missingDescriptor = mutableChildRefSource();
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
      threadSourceFactory: missingDescriptor.factory,
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
      threadSourceFactory: () =>
        errAsync({
          type: "ParentSessionUnavailable" as const,
          reason: "/raw/history/store/path",
        }),
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

  it("never auto-recovers tombstoned records, including from the command", async () => {
    const history = mutableChildRefSource(
      eligibleOrdinaryRecoveryRecord({ status: "tombstoned" }),
    );
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Recover now");
    installRecoveryExtension(host, history, () => {
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
    const history = mutableChildRefSource();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const deferred = host.deferNextSelect();
    installRecoveryExtension(host, history, () => {
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
    const history = mutableChildRefSource();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history, () => {
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
      const history = mutableChildRefSource();
      let restores = 0;
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      if (fail === "throw") host.poisonSelect();
      else host.rejectSelect();
      installRecoveryExtension(host, history, () => {
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
    const history = mutableChildRefSource();
    let restores = 0;
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Inspect");
    host.poisonNextNotify();
    installRecoveryExtension(host, history, () => {
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

  it("proves bounded inspect labels and record-free clearing through registered commands", async () => {
    const live = eligibleOrdinaryRecoveryRecord({
      childId: "live-running",
      threadId: "live-running",
      title: "live canary",
      status: "running",
    });
    const interrupted = eligibleOrdinaryRecoveryRecord({
      childId: "ordinary-interrupted",
      threadId: "ordinary-interrupted",
      title: "ordinary canary",
    });
    const workflow = eligibleOrdinaryRecoveryRecord({
      childId: "workflow-interrupted",
      threadId: "workflow-interrupted",
      title: "workflow-canary step-canary",
    });
    const history = mutableChildRefSource([live, interrupted, workflow]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history, () =>
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
      options.some((label) =>
        label.includes("children/live-running/session.jsonl"),
      ),
    ).toBe(false);
    const clearLabel = options
      .filter((label) => label.includes("clear"))
      .at(-1);
    expect(clearLabel).toBeDefined();
    deferred.settle(clearLabel);
    await inspect;
    // Since ADR 0014 the parent session owns the refs, so nothing is deleted.
    expect(history.cleared).toEqual([]);
    expect(history.records.map((record) => record.childId)).toContain(
      "live-running",
    );
    expect(host.notifyCalls.at(-1)).toEqual({
      message: "Child records are managed by Pi's session.",
      level: "info",
    });
    await host.invokeCommand("weave:clear-children");
    expect(history.records).toHaveLength(3);
    expect(host.notifyCalls.at(-1)?.message).toContain("terminal child");
  });

  it("proves recover and stale deferred actions are generation scoped", async () => {
    // The ref title is the descriptor name, so both records name a live agent.
    const ordinary = eligibleOrdinaryRecoveryRecord({
      childId: "ordinary-recover",
      threadId: "ordinary-recover",
      title: "loom",
    });
    const other = eligibleOrdinaryRecoveryRecord({
      childId: "other-child",
      threadId: "other-child",
      title: "loom",
    });
    const history = mutableChildRefSource([ordinary, other]);
    const restores: string[] = [];
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect("Skip");
    installRecoveryExtension(host, history, (input) => {
      restores.push(input.record.childId);
      return okAsync({ finalOutput: "restored", interventionCount: 0 });
    });
    await host.triggerSessionStart();
    const recoverPick = host.deferNextSelect();
    const recover = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const recoverOptions = host.selectCalls.at(-1)?.options ?? [];
    const recoverLabel = recoverOptions.find((label) =>
      label.includes("recover"),
    );
    recoverPick.settle(recoverLabel);
    await recover;
    expect(restores).toEqual(["ordinary-recover"]);
    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.generatedTurnCount).toBe(0);

    const stalePick = host.deferNextSelect();
    const stale = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const staleOptions = host.selectCalls.at(-1)?.options ?? [];
    // The replacement generation skips its own startup prompt, so any later
    // restore could only come from the stale deferred pick.
    host.scriptSelect("Skip");
    await host.triggerSessionStart();
    const staleLabel = staleOptions
      .filter((label) => label.includes("recover"))
      .at(-1);
    stalePick.settle(staleLabel);
    await stale;
    expect(restores).toEqual(["ordinary-recover"]);
    expect(host.sentUserMessages).toHaveLength(0);
    expect(
      host.notifyCalls.filter((call) => call.message.includes("stale")),
    ).toHaveLength(0);
  });

  it("proves the composed editor handles Alt+I and Alt+1 without global shortcut leakage", async () => {
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: "live-child",
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installRecoveryExtension(host, history, () =>
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
    const history = mutableChildRefSource([
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
    installRecoveryExtension(host, history, () =>
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
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: "ordinary-live-child",
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installRecoveryExtension(host, history, () =>
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
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: "ordinary-live-child",
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installRecoveryExtension(host, history, () =>
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
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: "ordinary-live-child",
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installRecoveryExtension(host, history, () =>
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
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: "live-child",
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installRecoveryExtension(host, history, () =>
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
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: "ordinary-live-child",
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const priorFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(priorFactory);
    installRecoveryExtension(host, history, () =>
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

  it("registers every described command once across extension reloads", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host);
    installExtension(host);
    // Two installs × (15 /weave:* commands + /weave palette) = 32 registrations.
    expect(host.registerCommandCalls).toHaveLength(32);
    const directNames = new Set(
      host.registerCommandCalls
        .map((call) => call.name)
        .filter((name) => name !== "weave"),
    );
    expect(directNames).toContain("weave:pi-config");
    expect(directNames.size).toBe(15);
    expect(
      host.registerCommandCalls.every(
        (call) => (call.registration.description ?? "").trim().length > 0,
      ),
    ).toBe(true);
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

  it("wires ctx.sessionManager.getHeader into thread-source origin on resume", async () => {
    // Production session_start passes the live ctx.sessionManager into
    // PiPrimarySession. When the host exposes getHeader(), the persisted
    // header id — not the freshly minted runtime id — must become the
    // parentSessionId handed to thread sources. Without that wiring,
    // historical refs written before restart are origin-mismatched.
    const opened: string[] = [];
    let headerReads = 0;
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: {
        getSessionId: () => "runtime-boot-2",
        getSessionFile: () => "/sessions/a.jsonl",
        isPersisted: () => true,
        getHeader: () => {
          headerReads += 1;
          return { type: "session", id: "header-stable" };
        },
      },
    });
    installExtension(host, "0.81.1", {
      threadSourceFactory: (input) => {
        opened.push(input.parentSessionId);
        return errAsync({
          type: "ParentSessionUnavailable" as const,
          reason: "not persisted",
        });
      },
    });

    await host.triggerSessionStart();

    expect(headerReads).toBeGreaterThan(0);
    expect(opened).toEqual(["header-stable"]);
    expect(opened).not.toContain("runtime-boot-2");
  });
});

describe("createPiExtension: restart and resume read committed fast intent", () => {
  it("re-activates a fast primary from the persisted header session after restart", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: {
        getSessionId: () => "runtime-boot-2",
        getSessionFile: () => "/sessions/a.jsonl",
        isPersisted: () => true,
        getHeader: () => ({ type: "session", id: "header-stable" }),
      },
    });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({ fast: true }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    const turn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(turn.systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
    expect(host.statusCalls).toContainEqual({ key: "weave", value: "ready" });
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
  it("closes each generation-owned Runtime Store exactly once on replacement and repeated shutdown", async () => {
    const firstRuntimeStore = countedRuntimeStore();
    const secondRuntimeStore = countedRuntimeStore();
    const persistedConfig = {
      ...EMPTY_CONFIG,
      settings: {
        adapters: {
          pi: {
            child_inspection: {
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
      parentSessionId: () => "parent",
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    await host.triggerSessionStart();
    await flushBackgroundWork();

    expect(firstRuntimeStore.closeCount).toBe(1);
    expect(secondRuntimeStore.closeCount).toBe(0);

    await host.triggerSessionShutdown();
    await host.triggerSessionShutdown();
    await flushBackgroundWork();

    expect(firstRuntimeStore.closeCount).toBe(1);
    expect(secondRuntimeStore.closeCount).toBe(1);
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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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

    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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
    expect(JSON.stringify(currentPlanWidget?.value)).toContain("Finish task");

    await host.invokeCommand("weave:status");
    const currentWorkflowStatus = host.notifyCalls.at(-1);
    oldPlanResolution.settle(ok(planSnapshotFixture("old-plan")));
    await oldRun;
    await flushBackgroundWork();

    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual(currentPlanWidget);
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
    expect(JSON.stringify(widgetForB?.value)).toContain("Task B");
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
    // The plan is gone; the agent row remains, because the selected agent is
    // ambient context whether or not a plan is running.
    expect(clearedWidget?.value).toEqual(["◆ WEAVE · LOOM · Alt+A cycle"]);
    expect(planRailShowsTask(host)).toBe(false);

    stalePlanResolution.settle(ok(planSnapshotFixture("gated-flow")));
    await staleAltT;
    await flushBackgroundWork();

    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual(clearedWidget);
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

    oldPlanResolution.settle(ok(planSnapshotFixture("old-plan")));
    await oldAltT;
    await flushBackgroundWork();

    expect(host.notifyCalls).toHaveLength(notificationCount);
    expect(host.customCalls).toHaveLength(customOverlayCount);
    expect(
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual(currentPlanWidget);
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
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
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

  it("publishes an in-flight workflow and permits abort after a typed review projection failure", async () => {
    const processPort = new FakeChildProcessPort();
    const runtimeStore = createInMemoryRuntimeStore();
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
        {
          agentName: "weft",
          source: "explicit",
          descriptor: tapestryDescriptor({ name: "weft" }),
        },
      ],
      errors: [],
    };
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator(plan, QUICK_FIX_REGRESSION_CONFIG),
      runtimeStoreFactory: { open: () => okAsync(runtimeStore) },
      processPort,
      childCommand: ["/fake/pi"],
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    await host.triggerSessionStart();
    host.scriptConfirm(true);
    const execution = host.invokeCommand("weave:run", "quick-fix-regression");
    await flushBackgroundWork();

    await completeDirectChildWithCandidate(
      processPort,
      await processPort.spawnCalled,
      { outcome: "success", method: "agent_signal" },
      "fix completed",
    );
    const reviewProcess = await processPort.spawnPromises[1];

    const instancesAtReview = await runtimeStore.instances.list({
      status: "running",
    });
    expect(instancesAtReview.isOk()).toBe(true);
    if (!instancesAtReview.isOk()) return;
    expect(instancesAtReview.value).toHaveLength(1);
    expect(instancesAtReview.value[0]?.currentStepName).toBe("review");
    const leaseAtReview = await runtimeStore.leases.findActive();
    expect(leaseAtReview.isOk()).toBe(true);
    if (!leaseAtReview.isOk()) return;
    expect(leaseAtReview.value).not.toBeNull();

    await host.invokeCommand("weave:abort");
    expect(host.notifyCalls.at(-1)?.message).toBe("Abort cancelled.");

    // Review requires review_verdict. A typed projection failure must leave
    // the durable execution tracked so the user can still cancel it.
    await completeDirectChildWithCandidate(
      processPort,
      reviewProcess,
      { outcome: "success", method: "agent_signal" },
      "review completed with the wrong method",
    );
    await execution;
    await flushBackgroundWork();
    expect(host.notifyCalls.at(-1)?.message).toBe(
      "Could not run workflow: Weave could not project the requested lifecycle operation.",
    );

    host.scriptConfirm(true);
    await host.invokeCommand("weave:abort");
    expect(host.notifyCalls.at(-1)?.message).toBe("Execution cancelled.");
    const cancelledInstances = await runtimeStore.instances.list({
      status: "cancelled",
    });
    expect(cancelledInstances.isOk()).toBe(true);
    if (cancelledInstances.isOk()) {
      expect(cancelledInstances.value).toHaveLength(1);
    }
    const leaseAfterAbort = await runtimeStore.leases.findActive();
    expect(leaseAfterAbort.isOk()).toBe(true);
    if (leaseAfterAbort.isOk()) {
      expect(leaseAfterAbort.value).toBeNull();
    }
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
    expect(JSON.stringify(recoveredWidget?.value)).toContain("Finish task");

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
    const renderedBeforeSettle = host.customRenderedLines.length;
    const spawnsBeforeSettle = processPort.spawnPromises.length;
    deferredSnapshot.settle(ok(namedTaskSnapshot("gated-flow", "Task A")));
    await pendingAltT;
    await flushBackgroundWork();

    // A never paints: not the rail, not the modal.
    expect(
      JSON.stringify(
        host.widgetCalls
          .filter((call) => call.key === "weave-plan")
          .slice(widgetsBeforeSettle),
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
    expect(planRailShowsTask(host)).toBe(false);
    expect(host.statusCalls.some((call) => call.key === "weave-task")).toBe(
      false,
    );
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
    expect(planRailShowsTask(host)).toBe(false);
    expect(host.statusCalls.some((call) => call.key === "weave-task")).toBe(
      false,
    );
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
    expect(JSON.stringify(widgetForB?.value)).toContain("Task B");
    const widgetCountForB = host.widgetCalls.filter(
      (call) => call.key === "weave-plan",
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
      host.widgetCalls.filter((call) => call.key === "weave-plan").at(-1),
    ).toEqual(widgetForB);
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

    expect(planRailShowsTask(host)).toBe(false);
    expect(host.statusCalls.some((call) => call.key === "weave-task")).toBe(
      false,
    );
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

    expect(planRailShowsTask(host)).toBe(false);
    expect(host.statusCalls.some((call) => call.key === "weave-task")).toBe(
      false,
    );
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
    expect(planRailShowsTask(host)).toBe(false);
    expect(host.statusCalls.some((call) => call.key === "weave-task")).toBe(
      false,
    );

    await host.invokeCommand("weave:abort");
    expect(planRailShowsTask(host)).toBe(false);
    expect(host.statusCalls.some((call) => call.key === "weave-task")).toBe(
      false,
    );
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

    // The rail owns identity in a TUI, so the themed status badge is the
    // fallback renderer only: it must be cleared, not painted beside it.
    expect(planRailLines(host)[0]).toContain("<bold>LOOM</bold>");
    expect(
      host.statusCalls.filter((call) => call.key === "weave-agent").at(-1),
    ).toEqual({ key: "weave-agent", value: undefined });
    expect(renderActiveAgentBadge("loom", theme)).toBe(badge("loom"));
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
    expect(planRailLines(host)[0]).toContain("<bold>TAPESTRY</bold>");
    expect(renderActiveAgentBadge("tapestry", theme)).toBe(badge("tapestry"));

    await host.invokeShortcut("alt+a");
    expect(planRailLines(host)[0]).toContain("<bold>LOOM</bold>");
    expect(renderActiveAgentBadge("loom", theme)).toBe(badge("loom"));
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
      shownAgentBadgeHistory(host).filter((value) => typeof value === "string"),
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
      shownAgentBadgeHistory(host).filter(
        (value) => value === "◆ WEAVE · TAPESTRY",
      ),
    ).toHaveLength(0);
  });
});

function pageOverlayEntries(
  entries: readonly unknown[],
  options: {
    readonly direction: "newest" | "older" | "newer";
    readonly cursor?: string;
    readonly limit?: number;
  },
) {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)));
  const parseCursor = (cursor: string | undefined): number => {
    if (cursor === undefined || !cursor.startsWith("idx:")) return -1;
    const value = Number(cursor.slice(4));
    return Number.isSafeInteger(value) ? value : -1;
  };
  if (options.direction === "newest") {
    const start = Math.max(0, entries.length - limit);
    const slice = entries.slice(start);
    return {
      entries: slice.map((value, index) => ({
        kind: "entry" as const,
        offset: start + index,
        value,
      })),
      ...(start > 0 ? { olderCursor: `idx:${start}` } : {}),
      ...(entries.length > 0
        ? { newerCursor: `idx:${entries.length - 1}` }
        : {}),
      bytesRead: slice.length,
      linesScanned: slice.length,
    };
  }
  const cursorIndex = parseCursor(options.cursor);
  if (cursorIndex < 0) {
    return { entries: [], bytesRead: 0, linesScanned: 0 };
  }
  if (options.direction === "older") {
    const end = cursorIndex;
    const start = Math.max(0, end - limit);
    const slice = entries.slice(start, end);
    return {
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
    };
  }
  const start = cursorIndex + 1;
  const end = Math.min(entries.length, start + limit);
  const slice = entries.slice(start, end);
  return {
    entries: slice.map((value, index) => ({
      kind: "entry" as const,
      offset: start + index,
      value,
    })),
    ...(start > 0 && slice.length > 0 ? { olderCursor: `idx:${start}` } : {}),
    ...(end < entries.length ? { newerCursor: `idx:${end - 1}` } : {}),
    bytesRead: slice.length,
    linesScanned: slice.length,
  };
}

describe("createPiExtension: Task 12 native child overlay", () => {
  const OVERLAY_CHILD_ID = "overlay-hist-child";
  const OVERLAY_SESSION_REF = `${OVERLAY_CHILD_ID}/session.jsonl`;

  function overlayThreadFactory(
    options: {
      readonly entries?: readonly unknown[];
      readonly failRead?: boolean;
    } = {},
  ): PiThreadSourceFactory {
    const entries = options.entries ?? [
      {
        type: "message",
        id: "m0",
        message: { role: "user", content: [{ type: "text", text: "prompt" }] },
      },
      {
        type: "message",
        id: "m1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "native-overlay-body" }],
        },
      },
    ];
    const record = {
      childId: OVERLAY_CHILD_ID,
      threadId: OVERLAY_CHILD_ID,
      nativeSessionId: "ns-overlay",
      sessionRef: OVERLAY_SESSION_REF,
      originParentSessionId: "fake-session-1",
      originEntryId: "entry-overlay",
      // A post-fix durable title: trusted agent identity plus the opaque
      // suffix of this row's own thread id, carrying the explicit provenance
      // marker that makes it trustworthy on read.
      title: "loom-istchild",
      titleProvenance: PI_CHILD_TITLE_PROVENANCE,
      status: "completed" as const,
      createdAt: 1,
      updatedAt: 2,
      settledAt: 3,
      runs: [{ run: 1, action: "start" as const, startedAt: 1 }],
    };
    return () =>
      okAsync({
        refs: {
          liveParentSessionId: () => "fake-session-1",
          readRefs: () =>
            okAsync({
              refs: [record],
              issues: [],
              counts: {
                scannedEntries: 1,
                candidateEntries: 1,
                malformedEntries: 0,
                originMismatchedChildren: 0,
                conflictingChildren: 0,
                duplicateEntries: 0,
                unusableSourceChildren: 0,
                usableRefs: 1,
              },
            }),
          appendNewChild: () =>
            errAsync({ type: "ChildRefParentUnavailable" as const }),
          appendRunDivider: () =>
            errAsync({ type: "ChildRefParentUnavailable" as const }),
          appendLifecycle: () =>
            errAsync({ type: "ChildRefParentUnavailable" as const }),
        } as unknown as PiThreadRefPort,
        sessions: {
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
            options.failRead
              ? errAsync({
                  type: "SessionCorrupt" as const,
                  ref: "x",
                  reason: "unreadable" as const,
                })
              : okAsync({
                  record: {
                    ref: OVERLAY_SESSION_REF,
                    childId: OVERLAY_CHILD_ID,
                    sessionId: "ns-overlay",
                    parentSession: "fake-session-1",
                    path: "/ignored",
                  },
                  entries,
                }),
          readSessionEntryPage: (
            _ref: string,
            _parent: string | undefined,
            pageOptions: {
              readonly direction: "newest" | "older" | "newer";
              readonly cursor?: string;
              readonly limit?: number;
            },
          ) =>
            options.failRead
              ? errAsync({
                  type: "SessionCorrupt" as const,
                  ref: "x",
                  reason: "unreadable" as const,
                })
              : okAsync(pageOverlayEntries(entries, pageOptions)),
          readThreadMetadata: () =>
            errAsync({ type: "SessionMissing" as const, ref: "x" }),
        } as unknown as PiThreadSessionPort,
        cache: { upsertRef: () => ok(undefined) },
        cacheMode: "active" as const,
      });
  }

  async function waitForCustomCalls(
    host: RecordingFakePiHost,
    count: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (host.customCalls.length >= count) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  async function openOverlayChild(host: RecordingFakePiHost): Promise<void> {
    const before = host.customCalls.length;
    const picker = host.deferNextSelect();
    const inspect = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const childLabel = host.selectCalls
      .at(-1)
      ?.options.find(
        (label) =>
          label.includes(OVERLAY_CHILD_ID) || label.includes("history: loom"),
      );
    expect(childLabel).toBeDefined();
    picker.settle(childLabel);
    await inspect;
    await waitForCustomCalls(host, before + 1);
  }

  it("registers overlay shortcuts while pi-vim owns the primary editor", async () => {
    // Task 20(b) blocker: overlay shortcuts used to register only when Weave's
    // composed editor factory received a keybindings object. With `pi-vim`
    // owning the primary editor that factory never runs, so no shortcut route
    // to the native overlay existed.
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: OVERLAY_CHILD_ID,
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    // Pi's own bindings claim nothing Weave wants here.
    host.effectiveKeybindingConfig = { "app.interrupt": "ctrl+c" };
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);

    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(),
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
          settings: { adapters: { pi: { child_inspection: {} } } },
        } as unknown as WeaveConfig,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: overlayThreadFactory(),
    });

    await host.triggerSessionStart();
    // Weave yielded the editor, so its composed factory never ran; the
    // shortcuts exist anyway, planned from the host keybindings manager.
    expect(host.editorFactoryCalls.length).toBe(0);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
    const registeredKeys = host.registerShortcutCalls.map(
      (call) => call.shortcut,
    );
    expect(registeredKeys).toContain("alt+i");
    expect(registeredKeys).toContain("alt+1");

    // The registered shortcut reaches the Weave child picker without Weave
    // ever claiming the primary editor.
    const picker = host.deferNextSelect();
    const pressed = host.invokeShortcut("alt+i");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (host.selectCalls.length > 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(host.selectCalls.at(-1)?.title).toBe("Weave children");
    expect(host.selectCalls.at(-1)?.options.length).toBeGreaterThan(0);
    picker.settle(undefined);
    await pressed;
    await flushBackgroundWork();

    // Task 20(b) blocker: a replacement session installs a new generation.
    // Raw keys stay registered exactly once, so the shortcut planned for the
    // first generation must serve the replacement instead of going inert on
    // the generation guard.
    const shortcutCallsBeforeReplacement = host.registerShortcutCalls.length;
    await host.triggerSessionStart();
    expect(host.registerShortcutCalls.length).toBe(
      shortcutCallsBeforeReplacement,
    );

    const selectsBeforeReplacement = host.selectCalls.length;
    const replacementPicker = host.deferNextSelect();
    const replacementPressed = host.invokeShortcut("alt+i");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (host.selectCalls.length > selectsBeforeReplacement) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(host.selectCalls.length).toBe(selectsBeforeReplacement + 1);
    expect(host.selectCalls.at(-1)?.title).toBe("Weave children");
    expect(host.selectCalls.at(-1)?.options.length).toBeGreaterThan(0);
    const replacementChildLabel = host.selectCalls
      .at(-1)
      ?.options.find((label) => label.includes("loom"));
    expect(replacementChildLabel).toBeDefined();
    const replacementCustomCallsBefore = host.customCalls.length;
    replacementPicker.settle(replacementChildLabel);
    await replacementPressed;
    await waitForCustomCalls(host, replacementCustomCallsBefore + 1);
    await flushBackgroundWork();

    expect(host.customCalls.length).toBe(replacementCustomCallsBefore + 1);
    const replacementOverlay =
      host.customRenderedLines.at(-1)?.join("\n") ?? "";
    // Identity on the Session Header, lifecycle on the frame marker.
    expect(replacementOverlay).toContain("loom-istchild");
    // The child's own `completed` settlement is carried through to the frame.
    expect(replacementOverlay).toContain("COMPLETED");
    expect(replacementOverlay).toContain("native-overlay-body");

    expect(host.editorFactoryCalls.length).toBe(0);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("keeps /weave:inspect registered and submits nothing to the primary conversation", async () => {
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: OVERLAY_CHILD_ID,
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = () => ({ handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(),
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
          settings: { adapters: { pi: { child_inspection: {} } } },
        } as unknown as WeaveConfig,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: overlayThreadFactory(),
    });
    await host.triggerSessionStart();

    expect(
      host.registerCommandCalls.some((call) => call.name === "weave:inspect"),
    ).toBe(true);

    // A live child is streaming when the command runs, exactly as in the
    // failed real-harness attempt.
    await host.triggerEvent("agent_start", { reason: "user" });
    await openOverlayChild(host);

    expect(host.customCalls.length).toBeGreaterThan(0);
    // Command input stays isolated: nothing partially reaches the primary
    // conversation as a user turn.
    expect(host.sentUserMessages).toEqual([]);
    expect(host.sendMessageCalls).toEqual([]);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.sentUserMessages).toEqual([]);
  });

  it("opens the native overlay without borrowing the session editor (pi-vim coexistence)", async () => {
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: OVERLAY_CHILD_ID,
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => ({ tui, theme, keybindings, handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(),
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
          settings: { adapters: { pi: { child_inspection: {} } } },
        } as unknown as WeaveConfig,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: overlayThreadFactory(),
    });
    await host.triggerSessionStart();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    await openOverlayChild(host);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
    expect(host.customCalls.length).toBeGreaterThan(0);
    const rendered = host.customRenderedLines.flat().join("\n");
    expect(rendered).toContain("native-overlay-body");
    expect(rendered).not.toContain("/Users/");

    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("swaps one native overlay instance instead of stacking custom promises", async () => {
    const secondId = "overlay-hist-child-2";
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: OVERLAY_CHILD_ID,
        status: "running",
      }),
      eligibleOrdinaryRecoveryRecord({
        childId: secondId,
        status: "running",
        title: "shuttle",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = () => ({ handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    const record2 = {
      childId: secondId,
      threadId: secondId,
      nativeSessionId: "ns-2",
      sessionRef: `${secondId}/session.jsonl`,
      originParentSessionId: "parent",
      originEntryId: "entry-2",
      title: "shuttle",
      titleProvenance: PI_CHILD_TITLE_PROVENANCE,
      status: "completed" as const,
      createdAt: 1,
      updatedAt: 2,
      settledAt: 3,
      runs: [{ run: 1, action: "start" as const, startedAt: 1 }],
    };
    const factory: PiThreadSourceFactory = () =>
      okAsync({
        refs: {
          liveParentSessionId: () => "fake-session-1",
          readRefs: () =>
            okAsync({
              refs: [
                {
                  childId: OVERLAY_CHILD_ID,
                  threadId: OVERLAY_CHILD_ID,
                  nativeSessionId: "ns-overlay",
                  sessionRef: OVERLAY_SESSION_REF,
                  originParentSessionId: "parent",
                  originEntryId: "entry-overlay",
                  title: "loom",
                  titleProvenance: PI_CHILD_TITLE_PROVENANCE,
                  status: "completed" as const,
                  createdAt: 1,
                  updatedAt: 2,
                  settledAt: 3,
                  runs: [{ run: 1, action: "start" as const, startedAt: 1 }],
                },
                record2,
              ],
              issues: [],
              counts: {
                scannedEntries: 2,
                candidateEntries: 2,
                malformedEntries: 0,
                originMismatchedChildren: 0,
                conflictingChildren: 0,
                duplicateEntries: 0,
                unusableSourceChildren: 0,
                usableRefs: 2,
              },
            }),
          appendNewChild: () =>
            errAsync({ type: "ChildRefParentUnavailable" as const }),
          appendRunDivider: () =>
            errAsync({ type: "ChildRefParentUnavailable" as const }),
          appendLifecycle: () =>
            errAsync({ type: "ChildRefParentUnavailable" as const }),
        } as unknown as PiThreadRefPort,
        sessions: {
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
          readSessionEntries: (ref: string) =>
            okAsync({
              record: {
                ref,
                childId: ref.startsWith(secondId) ? secondId : OVERLAY_CHILD_ID,
                sessionId: "ns",
                parentSession: "fake-session-1",
                path: "/ignored",
              },
              entries: [
                {
                  type: "message",
                  id: "x",
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: ref.startsWith(secondId)
                          ? "second-child-body"
                          : "native-overlay-body",
                      },
                    ],
                  },
                },
              ],
            }),
          readSessionEntryPage: (
            ref: string,
            _parent: string | undefined,
            pageOptions: {
              readonly direction: "newest" | "older" | "newer";
              readonly cursor?: string;
              readonly limit?: number;
            },
          ) =>
            okAsync(
              pageOverlayEntries(
                [
                  {
                    type: "message",
                    id: "x",
                    message: {
                      role: "assistant",
                      content: [
                        {
                          type: "text",
                          text: ref.startsWith(secondId)
                            ? "second-child-body"
                            : "native-overlay-body",
                        },
                      ],
                    },
                  },
                ],
                pageOptions,
              ),
            ),
          readThreadMetadata: () =>
            errAsync({ type: "SessionMissing" as const, ref: "x" }),
        } as unknown as PiThreadSessionPort,
        cache: { upsertRef: () => ok(undefined) },
        cacheMode: "active" as const,
      });
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(),
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
        EMPTY_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: factory,
    });
    await host.triggerSessionStart();

    await openOverlayChild(host);
    const firstCustomCount = host.customCalls.length;
    expect(firstCustomCount).toBe(1);

    const picker = host.deferNextSelect();
    const inspect = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const secondLabel = host.selectCalls
      .at(-1)
      ?.options.find(
        (label) => label.includes(secondId) || label.includes("shuttle"),
      );
    picker.settle(secondLabel);
    await inspect;
    await flushBackgroundWork();
    // One mounted custom promise: swap invalidates, does not stack.
    expect(host.customCalls.length).toBe(firstCustomCount);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("uses the custom-editor path when capability selects custom-editor fallback", async () => {
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: OVERLAY_CHILD_ID,
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = () => ({ handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(["child-overlay-lifecycle"]),
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
        EMPTY_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: overlayThreadFactory(),
    });
    await host.triggerSessionStart();
    await openOverlayChild(host);
    // Custom-editor capability still borrows the session editor.
    expect(host.getEditorComponentForTest()).not.toBe(modalFactory);
    expect(host.customCalls.length).toBeGreaterThan(0);
    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("settles the native overlay on session_shutdown and leaves the editor factory untouched", async () => {
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: OVERLAY_CHILD_ID,
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = () => ({ handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(),
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
        EMPTY_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: overlayThreadFactory(),
    });
    await host.triggerSessionStart();
    await openOverlayChild(host);
    expect(host.customCalls.length).toBe(1);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    await host.triggerSessionShutdown();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("hands off to custom-editor inspection when native open returns fallback-required", async () => {
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: OVERLAY_CHILD_ID,
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = () => ({ handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(),
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
        EMPTY_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: overlayThreadFactory({ failRead: true }),
    });
    await host.triggerSessionStart();
    const editorCallsBefore = host.editorFactoryCalls.length;
    await openOverlayChild(host);
    // Source failure settles native and borrows the custom-editor path.
    expect(host.editorFactoryCalls.length).toBeGreaterThan(editorCallsBefore);
    expect(host.getEditorComponentForTest()).not.toBe(modalFactory);
    expect(host.customCalls.length).toBeGreaterThan(0);
    // Task 20(c): the decision to leave the native overlay is recorded as a
    // bounded reason code, so a live run can name the cause from
    // `/weave:health` alone instead of reporting a silent fallback.
    await host.invokeCommand("weave:health");
    const health = host.notifyCalls.at(-1)?.message ?? "";
    expect(health).toContain(
      "overlay: weave overlay fallback: open-source-failed",
    );
    expect(health).not.toContain(OVERLAY_CHILD_ID);
    expect(health).not.toContain("/Users/");
    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("rejects stale-generation overlay activation after session replacement", async () => {
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: OVERLAY_CHILD_ID,
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = () => ({ handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(),
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
        EMPTY_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: overlayThreadFactory(),
    });
    await host.triggerSessionStart();

    const picker = host.deferNextSelect();
    const inspect = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const childLabel = host.selectCalls
      .at(-1)
      ?.options.find(
        (label) =>
          label.includes(OVERLAY_CHILD_ID) || label.includes("history: loom"),
      );
    expect(childLabel).toBeDefined();
    // Replace the generation before the inspect selection resolves.
    await host.triggerSessionStart();
    picker.settle(childLabel);
    await inspect;
    await flushBackgroundWork();
    expect(host.customCalls).toHaveLength(0);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });

  it("keeps primary editor input ownership isolated while the native overlay is mounted", async () => {
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: OVERLAY_CHILD_ID,
        status: "running",
      }),
    ]);
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const modalFactory = () => ({ handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(),
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
        EMPTY_CONFIG,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: overlayThreadFactory(),
    });
    await host.triggerSessionStart();
    const editorCallsBefore = host.editorFactoryCalls.length;
    await openOverlayChild(host);
    expect(host.editorFactoryCalls.length).toBe(editorCallsBefore);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
    host.inputCustom("typed-into-overlay");
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
    expect(host.editorFactoryCalls.length).toBe(editorCallsBefore);
    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });
});

describe("createPiExtension: Task 13 overlay keys and picker", () => {
  const TASK13_CHILD_ID = "overlay-hist-child";

  function installTask13Extension(
    host: RecordingFakePiHost,
    overrides: Partial<PiExtensionDeps> = {},
    config: WeaveConfig = EMPTY_CONFIG,
  ): void {
    const history = mutableChildRefSource([
      eligibleOrdinaryRecoveryRecord({
        childId: TASK13_CHILD_ID,
        status: "running",
      }),
    ]);
    installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      hostSurfaceReader: hostSurfaceReader(),
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
        config,
      ),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      parentSessionId: () => "parent",
      restoreOrdinaryChild: () =>
        okAsync({ finalOutput: "restored", interventionCount: 0 }),
      threadSourceFactory: () =>
        okAsync({
          refs: {
            liveParentSessionId: () => "fake-session-1",
            readRefs: () =>
              okAsync({
                refs: [
                  {
                    childId: TASK13_CHILD_ID,
                    threadId: TASK13_CHILD_ID,
                    nativeSessionId: "ns-overlay",
                    sessionRef: `${TASK13_CHILD_ID}/session.jsonl`,
                    originParentSessionId: "parent",
                    originEntryId: "entry-overlay",
                    title: "loom",
                    status: "completed" as const,
                    createdAt: 1,
                    updatedAt: 2,
                    settledAt: 3,
                    runs: [{ run: 1, action: "start" as const, startedAt: 1 }],
                  },
                ],
                issues: [],
                counts: {
                  scannedEntries: 1,
                  candidateEntries: 1,
                  malformedEntries: 0,
                  originMismatchedChildren: 0,
                  conflictingChildren: 0,
                  duplicateEntries: 0,
                  unusableSourceChildren: 0,
                  usableRefs: 1,
                },
              }),
            appendNewChild: () =>
              errAsync({ type: "ChildRefParentUnavailable" as const }),
            appendRunDivider: () =>
              errAsync({ type: "ChildRefParentUnavailable" as const }),
            appendLifecycle: () =>
              errAsync({ type: "ChildRefParentUnavailable" as const }),
          } as unknown as PiThreadRefPort,
          sessions: {
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
              okAsync({
                header: {
                  type: "session",
                  id: "s",
                  version: 3,
                  parentId: null,
                  timestamp: "t",
                  cwd: "/p",
                },
                entries: [
                  {
                    type: "message",
                    id: "m1",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "body" }],
                    },
                  },
                ],
                tree: [],
              }),
            readSessionEntryPage: (
              _ref: string,
              _parent: string | undefined,
              pageOptions: {
                readonly direction: "newest" | "older" | "newer";
                readonly cursor?: string;
                readonly limit?: number;
              },
            ) =>
              okAsync(
                pageOverlayEntries(
                  [
                    {
                      type: "message",
                      id: "m1",
                      message: {
                        role: "assistant",
                        content: [{ type: "text", text: "body" }],
                      },
                    },
                  ],
                  pageOptions,
                ),
              ),
            readThreadMetadata: () =>
              errAsync({ type: "SessionMissing" as const, ref: "x" }),
          } as unknown as PiThreadSessionPort,
          cache: { upsertRef: () => ok(undefined) },
          cacheMode: "active" as const,
        }),
      ...overrides,
    });
  }

  it("skips shortcut registration without getEffectiveConfig and reports the gap", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installTask13Extension(host);
    await host.triggerSessionStart();
    expect(typeof host.getEditorComponentForTest()).toBe("function");
    host.createEditor({}, {}, {});
    expect(host.registerShortcutCalls.map((call) => call.shortcut)).toEqual([
      "alt+a",
      "alt+t",
    ]);
    await host.invokeCommand("weave:health");
    const health = host.notifyCalls.at(-1)?.message ?? "";
    expect(health).toContain("overlay:");
    expect(health).toContain("registerShortcut takes a key");
    expect(health).toContain("getEffectiveConfig()");
  });

  it("registers overlay shortcuts exactly once and never overwrites conflicts", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.effectiveKeybindingConfig = {
      "tui.app.example": "alt+i",
    };
    installTask13Extension(host);
    await host.triggerSessionStart();
    host.createEditor();
    host.createEditor();
    const shortcuts = host.registerShortcutCalls.map((call) => call.shortcut);
    expect(shortcuts.filter((key) => key === "alt+i")).toHaveLength(0);
    expect(shortcuts.filter((key) => key === "alt+1").length).toBe(1);
    expect(shortcuts.filter((key) => key === "alt+a")).toHaveLength(1);
    await host.invokeCommand("weave:health");
    const health = host.notifyCalls.at(-1)?.message ?? "";
    expect(health).toContain("already bound to tui.app.example");
  });

  it("applies child_inspection.keys overrides when registering", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.effectiveKeybindingConfig = {};
    installTask13Extension(host, {}, {
      ...EMPTY_CONFIG,
      settings: {
        adapters: {
          pi: {
            child_inspection: {
              keys: {
                "weave.child.picker.open": "ctrl+p",
              },
            },
          },
        },
      },
    } as unknown as WeaveConfig);
    await host.triggerSessionStart();
    host.createEditor();
    const shortcuts = host.registerShortcutCalls.map((call) => call.shortcut);
    expect(shortcuts).toContain("ctrl+p");
    expect(shortcuts).not.toContain("alt+i");
  });

  it("one Escape closes the mounted overlay and never confirms a cancel", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.effectiveKeybindingConfig = {};
    const modalFactory = () => ({ handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    installTask13Extension(host);
    await host.triggerSessionStart();
    const before = host.customCalls.length;
    const picker = host.deferNextSelect();
    const inspect = host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const childLabel = host.selectCalls
      .at(-1)
      ?.options.find(
        (label) =>
          label.includes(TASK13_CHILD_ID) || label.includes("history: loom"),
      );
    expect(childLabel).toBeDefined();
    picker.settle(childLabel);
    await inspect;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (host.customCalls.length > before) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(host.customCalls.length).toBeGreaterThan(before);

    const doneBeforeEscape = host.customDoneCalls;
    const selectsBeforeEscape = host.selectCalls.length;
    // One Escape leaves inspection: the overlay closes and the parent resumes.
    host.inputCustom("\u001b");
    await flushBackgroundWork();
    expect(host.customDoneCalls).toBeGreaterThan(doneBeforeEscape);
    // No arming hint is ever shown.
    expect(
      host.notifyCalls.some((call) =>
        call.message.includes("Press Escape again"),
      ),
    ).toBe(false);
    // No cancel confirmation is opened, so the child keeps running.
    expect(host.selectCalls.length).toBe(selectsBeforeEscape);
  });

  it("binds the overlay input listener from the real before_agent_start wiring", async () => {
    // Regression proof at the lifecycle level, not the runtime level: the raw
    // terminal-input route is what carries Alt+I / Alt+1..Alt+9 under a
    // foreign primary editor, and `before_agent_start` is the only recurring
    // event that can install it once the session UI can carry a listener.
    // Removing that registration makes every assertion below fail.
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.effectiveKeybindingConfig = {};
    // Pi hands the extension runner one UI context per session bind.
    host.stableSessionUi = true;
    // Keys are planned while the session UI exposes no input listener at all.
    host.supportsTerminalInput = false;
    installTask13Extension(host);
    await host.triggerSessionStart();
    const altOneRegistrations = () =>
      host.registerShortcutCalls.filter((call) => call.shortcut === "alt+1");
    expect(altOneRegistrations()).toHaveLength(1);
    expect(host.terminalInputListeners).toHaveLength(0);

    // A later bind exposes `ui.onTerminalInput`; the applied plan must acquire
    // the listener it never got, from the real lifecycle handler.
    host.supportsTerminalInput = true;
    host.invalidateSessionUi();
    await host.triggerBeforeAgentStart();
    expect(host.terminalInputListeners).toHaveLength(1);
    const firstListener = host.terminalInputListeners[0];

    // Further turns on the same live host never stack a second listener.
    // The closure itself is replaced on every turn - liveness is proven by
    // installing, because Pi can clear listeners behind an unchanged UI
    // context - but exactly one live listener owns the route.
    await host.triggerBeforeAgentStart();
    await host.triggerBeforeAgentStart();
    expect(host.terminalInputListeners).toHaveLength(1);

    // Pi drops extension listeners silently on session invalidation and hands
    // out a replacement UI context.
    host.invalidateSessionUi();
    expect(host.terminalInputListeners).toHaveLength(0);
    await host.triggerBeforeAgentStart();
    expect(host.terminalInputListeners).toHaveLength(1);
    expect(host.terminalInputListeners[0]).not.toBe(firstListener);
    // The rebind happens exactly once, not once per turn.
    await host.triggerBeforeAgentStart();
    await host.triggerBeforeAgentStart();
    expect(host.terminalInputListeners).toHaveLength(1);
    expect(host.terminalInputListeners[0]).not.toBe(firstListener);

    // Raw shortcut registration stays exactly-once across all of it.
    expect(altOneRegistrations()).toHaveLength(1);

    // The rebound listener is a live route: one Alt+1 frame is consumed and
    // dispatched exactly once, while ordinary input passes through.
    const dispatches = () =>
      host.notifyCalls.filter((call) =>
        call.message.includes("weave overlay key ignored: no matching child"),
      );
    expect(dispatches()).toHaveLength(0);
    expect(host.emitTerminalInput("\u001b1")).toBe(true);
    expect(dispatches()).toHaveLength(1);
    expect(host.emitTerminalInput("hello")).toBe(false);
    expect(host.emitTerminalInput("\u001b")).toBe(false);
    expect(dispatches()).toHaveLength(1);
  });
});

describe("createPiExtension: real-dispatch active-child shortcut", () => {
  it("mounts the native overlay from Alt+1 on a live weave_delegate child without borrowing pi-vim", async () => {
    // Real dispatch has no readable historical native page yet (thread sources
    // are unwired in this fixture). Live open must still take the native
    // ui.custom path instead of the custom-editor fallback that steals the
    // primary editor from pi-vim.
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.effectiveKeybindingConfig = { "app.interrupt": "ctrl+c" };
    const modalFactory = () => ({ handleInput: () => undefined });
    host.setEditorComponentForTest(modalFactory);
    const processPort = new FakeChildProcessPort();
    installDelegationLifecycleExtension(host, processPort, {
      hostSurfaceReader: hostSurfaceReader(),
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
        {
          ...DELEGATION_LIFECYCLE_CONFIG,
          settings: { adapters: { pi: { child_inspection: {} } } },
        } as unknown as WeaveConfig,
      ),
    });

    await host.triggerSessionStart();
    expect(host.editorFactoryCalls.length).toBe(0);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    await spawnLifecycleChild(host, processPort);
    expect(processPort.spawnedProcesses).toHaveLength(1);
    expect(host.registerShortcutCalls.map((call) => call.shortcut)).toContain(
      "alt+1",
    );

    const customBefore = host.customCalls.length;
    const editorCallsBefore = host.editorFactoryCalls.length;
    void host.invokeShortcut("alt+1");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (host.customCalls.length > customBefore) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(host.customCalls.length).toBe(customBefore + 1);
    expect(host.editorFactoryCalls.length).toBe(editorCallsBefore);
    expect(host.getEditorComponentForTest()).toBe(modalFactory);

    const rendered = host.customRenderedLines.at(-1)?.join("\n") ?? "";
    expect(rendered).toContain("LIVE");
    expect(rendered).toMatch(/shuttle/i);
    expect(rendered).not.toContain("/Users/");

    host.inputCustom("\u001b");
    host.finishCustom();
    await flushBackgroundWork();
    expect(host.getEditorComponentForTest()).toBe(modalFactory);
  });
});

describe("readOverlaySessionEntryPage: extension source boundary", () => {
  const pageOptions = { direction: "newest" as const, limit: 10 };

  const descriptor = (
    overrides: Partial<PiOverlayChildDescriptor> = {},
  ): PiOverlayChildDescriptor => ({
    childId: "child-1",
    threadId: "thread-1",
    activeChildId: "child-1",
    status: "live",
    title: "shuttle",
    generationId: "gen-1",
    parentChildId: undefined,
    runs: [{ run: 1, action: "start" }],
    branchIds: ["main"],
    descendantChildIds: [],
    sessionRef: undefined,
    ...overrides,
  });

  const controllerFor = (
    result: ResultAsync<PiOverlayChildDescriptor, PiAdapterFailure>,
  ) => ({ resolveOverlayChild: () => result });

  const unreadable = (ref: string) =>
    ({
      type: "SessionCorrupt",
      ref,
      reason: "unreadable",
    }) as const;

  it("fails closed when no delegation controller owns this generation", async () => {
    // An absent controller is a wiring defect, not the persisted startup gap.
    // Mapping it to `SessionMissing` would let a live child silently open an
    // empty overlay while delegation is broken.
    let sessionsRead = 0;
    const result = await readOverlaySessionEntryPage(
      {
        controller: () => undefined,
        sessions: () => {
          sessionsRead += 1;
          return undefined;
        },
        parentSessionId: () => "parent-1",
      },
      "child-1",
      pageOptions,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(unreadable("child-1"));
    expect(sessionsRead).toBe(0);
  });

  it("fails closed when the controller cannot resolve the overlay child", async () => {
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(
            errAsync({
              kind: "thread-not-found",
              code: "unknown-thread",
            } as unknown as PiAdapterFailure),
          ),
        sessions: () => undefined,
        parentSessionId: () => "parent-1",
      },
      "child-unknown",
      pageOptions,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(unreadable("child-unknown"));
  });

  it("opens the empty native page for a resolved live child with no session ref", async () => {
    // Nothing is persisted yet, so the truthful answer is the empty live-tail
    // page. Session infrastructure must not be consulted at all.
    let sessionsRead = 0;
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(okAsync(descriptor({ sessionRef: undefined }))),
        sessions: () => {
          sessionsRead += 1;
          return undefined;
        },
        parentSessionId: () => "parent-1",
      },
      "child-1",
      pageOptions,
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      entries: [],
      bytesRead: 0,
      linesScanned: 0,
    });
    expect(sessionsRead).toBe(0);
  });

  it("fails closed when a child with a session ref has no session source", async () => {
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(okAsync(descriptor({ sessionRef: "ref-1" }))),
        sessions: () => undefined,
        parentSessionId: () => "parent-1",
      },
      "child-1",
      pageOptions,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(unreadable("ref-1"));
  });

  it("fails closed when a child with a session ref has no page read API", async () => {
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(okAsync(descriptor({ sessionRef: "ref-1" }))),
        sessions: () => ({}),
        parentSessionId: () => "parent-1",
      },
      "child-1",
      pageOptions,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(unreadable("ref-1"));
  });

  it("verifies a persisted session against the live parent session", async () => {
    // The live parent session identity is the expected header `parentSession`.
    // It is passed through unchanged so the native store can enforce parent
    // equality; nothing here may widen it.
    let observedParent: string | undefined = "unset";
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(
            okAsync(
              descriptor({
                status: "settled",
                sessionRef: "ref-1",
              }),
            ),
          ),
        sessions: () => ({
          readSessionEntryPage: (_ref, expectedParentSession) => {
            observedParent = expectedParentSession;
            return okAsync({ entries: [], bytesRead: 0, linesScanned: 0 });
          },
        }),
        parentSessionId: () => "parent-live",
      },
      "child-1",
      pageOptions,
    );
    expect(result.isOk()).toBe(true);
    expect(observedParent).toBe("parent-live");
  });

  it("fails closed when no expected parent session is known", async () => {
    // A persisted session ref always belongs to a parent session. Reading it
    // with an absent expected parent would make the native store skip parent
    // equality entirely, so the read must never reach the store.
    let readAttempted = false;
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(
            okAsync(descriptor({ status: "settled", sessionRef: "ref-1" })),
          ),
        sessions: () => ({
          readSessionEntryPage: () => {
            readAttempted = true;
            return okAsync({ entries: [], bytesRead: 0, linesScanned: 0 });
          },
        }),
        parentSessionId: () => undefined,
      },
      "child-1",
      pageOptions,
    );
    expect(readAttempted).toBe(false);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(unreadable("ref-1"));
  });

  it("fails closed when the expected parent session is empty", async () => {
    // An empty identity is as unverifiable as an absent one.
    let readAttempted = false;
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(
            okAsync(descriptor({ status: "settled", sessionRef: "ref-1" })),
          ),
        sessions: () => ({
          readSessionEntryPage: () => {
            readAttempted = true;
            return okAsync({ entries: [], bytesRead: 0, linesScanned: 0 });
          },
        }),
        parentSessionId: () => "",
      },
      "child-1",
      pageOptions,
    );
    expect(readAttempted).toBe(false);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(unreadable("ref-1"));
  });

  it("returns an empty page without a session ref even with no parent", async () => {
    // Nothing is persisted, so there is no header to verify and no read.
    const result = await readOverlaySessionEntryPage(
      {
        controller: () => controllerFor(okAsync(descriptor())),
        sessions: () => ({
          readSessionEntryPage: () =>
            okAsync({ entries: [], bytesRead: 0, linesScanned: 0 }),
        }),
        parentSessionId: () => undefined,
      },
      "child-1",
      pageOptions,
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().entries).toEqual([]);
  });

  it("preserves an actual SessionMissing for a known session ref", async () => {
    // Only this case is the recoverable startup gap; the controller decides
    // whether the child's live status allows an empty page.
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(okAsync(descriptor({ sessionRef: "ref-1" }))),
        sessions: () => ({
          readSessionEntryPage: () =>
            errAsync({ type: "SessionMissing" as const, ref: "ref-1" }),
        }),
        parentSessionId: () => "parent-1",
      },
      "child-1",
      pageOptions,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionMissing",
      ref: "ref-1",
    });
  });

  it.each([
    [
      "SessionPermissionError",
      { type: "SessionPermissionError" as const, kind: "file" as const },
    ],
    [
      "SessionRootViolation",
      {
        type: "SessionRootViolation" as const,
        reason: "path-escape" as const,
      },
    ],
    [
      "SessionCorrupt/missing-header",
      {
        type: "SessionCorrupt" as const,
        ref: "ref-1",
        reason: "missing-header" as const,
      },
    ],
    [
      "SessionCorrupt/parent-session-mismatch",
      {
        type: "SessionCorrupt" as const,
        ref: "ref-1",
        reason: "parent-session-mismatch" as const,
      },
    ],
  ])("preserves the native %s failure verbatim", async (_label, native) => {
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(okAsync(descriptor({ sessionRef: "ref-1" }))),
        sessions: () => ({ readSessionEntryPage: () => errAsync(native) }),
        parentSessionId: () => "parent-1",
      },
      "child-1",
      pageOptions,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(native);
  });

  it("reads the resolved session ref with the persistent parent session id", async () => {
    const calls: {
      ref: string;
      parent: string | undefined;
      limit: number;
    }[] = [];
    const result = await readOverlaySessionEntryPage(
      {
        controller: () =>
          controllerFor(okAsync(descriptor({ sessionRef: "ref-9" }))),
        sessions: () => ({
          readSessionEntryPage: (ref, parent, options) => {
            calls.push({ ref, parent, limit: options.limit ?? 0 });
            return okAsync({ entries: [], bytesRead: 4, linesScanned: 1 });
          },
        }),
        parentSessionId: () => "parent-7",
      },
      "child-1",
      pageOptions,
    );
    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([{ ref: "ref-9", parent: "parent-7", limit: 10 }]);
  });
});

const PROVIDER_FAST_SECRET = "sk-proj-fast-secret-value-DO-NOT-ECHO-9f3c2a1b";
const PROVIDER_FAST_AUTHORIZATION = `Bearer ${PROVIDER_FAST_SECRET}`;

const UNSUPPORTED_FAST_SNAPSHOT: ProviderFastPublicSnapshot = {
  state: "unsupported",
  evidenceKind: "none",
  evidenceOutcome: "absent",
  reason: "harness-seam-unavailable",
};

function expectSanitizedProviderFast(
  snapshot: ProviderFastPublicSnapshot | undefined,
  expected: ProviderFastPublicSnapshot | undefined,
): void {
  expect(snapshot).toEqual(expected);
  const serialized = JSON.stringify(snapshot);
  expect(serialized).not.toContain(PROVIDER_FAST_SECRET);
  expect(serialized).not.toContain("sk-proj");
  expect(serialized).not.toContain("applied");
  expect(serialized).not.toContain("requested");
  expect(serialized).not.toContain("Authorization");
}

function defineOwnData(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * The hook seam and every non-Codex provider.
 *
 * Exactly one mapping may request acceleration, and it lives in the wrapped
 * `openai-codex` provider (proven in the codex describes below). Everything
 * here is the other side of that line: the public OpenAI API provider, the
 * Anthropic provider, and Pi's request/header hooks. For all of them a
 * declared `fast true` stays inert - no hook is registered, no payload or
 * header changes, and the reported state is the terminal hook-seam
 * `unsupported`.
 */
describe("createPiExtension: provider fast intent", () => {
  const openaiModel = {
    provider: "openai",
    id: "gpt-5.6-sol",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  };
  const anthropicModel = {
    provider: "anthropic",
    id: "claude-opus-5",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
  };

  function installFastPrimary(
    host: RecordingFakePiHost,
    extras: {
      readonly model?: typeof openaiModel;
      readonly fast?: true;
      readonly name?: string;
      readonly second?: {
        readonly name: string;
        readonly model: typeof openaiModel;
        readonly fast?: true;
      };
      readonly overrides?: Partial<PiExtensionDeps>;
    } = {},
  ): PiExtensionInstance {
    const model = extras.model ?? openaiModel;
    const agents = [
      {
        agentName: extras.name ?? "loom",
        source: "explicit" as const,
        descriptor: loomDescriptor({
          name: extras.name ?? "loom",
          models: [`${model.provider}/${model.id}`],
          ...(extras.fast === true ? { fast: true as const } : {}),
        }),
      },
    ];
    if (extras.second !== undefined) {
      agents.push({
        agentName: extras.second.name,
        source: "explicit",
        descriptor: tapestryDescriptor({
          name: extras.second.name,
          models: [`${extras.second.model.provider}/${extras.second.model.id}`],
          ...(extras.second.fast === true ? { fast: true as const } : {}),
        }),
      });
    }
    return installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents,
        errors: [],
      }),
      ...extras.overrides,
    });
  }

  function journalRecordingOverrides(
    sink: unknown[],
  ): Partial<PiExtensionDeps> {
    return {
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      telemetryJournal: {
        write: (entry) => {
          sink.push(entry);
          return okAsync(undefined);
        },
      },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    };
  }

  function providerFastEvents(entries: readonly unknown[]): string[] {
    return entries
      .map((entry) =>
        typeof entry === "object" && entry !== null && "eventType" in entry
          ? String((entry as { eventType?: unknown }).eventType)
          : "",
      )
      .filter((eventType) => eventType.startsWith("provider-fast."));
  }

  it("registers no provider request or header hook at all, on any provider", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    installFastPrimary(host, { fast: true });
    await host.triggerSessionStart();

    // The codex mapping is a provider override, so the hook seam stays empty
    // whether or not an agent declares intent.
    expect(host.registeredEventHandlerCount("before_provider_headers")).toBe(0);
    expect(host.registeredEventHandlerCount("before_provider_request")).toBe(0);
    expect(host.registeredEventHandlerCount("after_provider_response")).toBe(0);
  });

  it.each([
    ["openai", openaiModel],
    ["anthropic", anthropicModel],
  ] as const)("leaves a fast-declaring non-codex %s primary's payload and headers exactly unchanged", async (_provider, model) => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [model],
    });
    const extension = installFastPrimary(host, { model, fast: true });
    // A foreign extension still owns its own edits; Weave adds nothing.
    host.api.on("before_provider_headers", (event) => {
      const headers = (event as { headers: Record<string, string> }).headers;
      headers["x-prior"] = "keep-me";
    });
    await host.triggerSessionStart();

    const headers: Record<string, string> = {
      Authorization: PROVIDER_FAST_AUTHORIZATION,
      "x-request-id": "req-1",
    };
    await host.triggerBeforeProviderHeaders(headers);
    expect(headers).toEqual({
      Authorization: PROVIDER_FAST_AUTHORIZATION,
      "x-request-id": "req-1",
      "x-prior": "keep-me",
    });
    expect(Object.keys(headers)).not.toContain("anthropic-beta");

    const payload = {
      model: model.id,
      messages: [{ role: "user", content: "hi" }],
    };
    const originalPayload = { ...payload };
    const replaced = await host.triggerBeforeProviderRequest(payload);
    // Identity, not just deep equality: no copy, no added field.
    expect(replaced).toBe(payload);
    expect(payload).toEqual(originalPayload);
    expect(Object.keys(payload)).not.toContain("service_tier");
    expect(Object.keys(payload)).not.toContain("speed");

    await host.triggerAfterProviderResponse(200, { "retry-after": "1" });
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
  });

  it("leaves a no-intent primary's payload and headers untouched and emits no state", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    const extension = installFastPrimary(host);
    await host.triggerSessionStart();
    const headers = { Authorization: PROVIDER_FAST_AUTHORIZATION };
    await host.triggerBeforeProviderHeaders(headers);
    const payload = { model: "gpt-5.6-sol" };
    const replaced = await host.triggerBeforeProviderRequest(payload);
    expect(headers).toEqual({ Authorization: PROVIDER_FAST_AUTHORIZATION });
    expect(replaced).toBe(payload);
    expect(extension.providerFastLatestForTest()).toBeUndefined();
  });

  it("cannot be raised out of unsupported by any response event", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    const extension = installFastPrimary(host, { fast: true });
    await host.triggerSessionStart();
    for (const status of [200, 201, 400, 429, 500]) {
      await host.triggerAfterProviderResponse(status, {
        "anthropic-fast-limit": "ok",
      });
      expectSanitizedProviderFast(
        extension.providerFastLatestForTest(),
        UNSUPPORTED_FAST_SNAPSHOT,
      );
    }
  });

  it("ignores hostile provider event descriptors without invoking getters", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    const extension = installFastPrimary(host, { fast: true });
    await host.triggerSessionStart();

    let headerReads = 0;
    const hostileHeaders = {};
    defineOwnData(hostileHeaders, "type", "before_provider_headers");
    Object.defineProperty(hostileHeaders, "headers", {
      enumerable: true,
      configurable: true,
      get: () => {
        headerReads += 1;
        throw new Error("headers getter must not run");
      },
    });
    await host.triggerEvent("before_provider_headers", hostileHeaders);
    expect(headerReads).toBe(0);

    let payloadReads = 0;
    const hostilePayload = {};
    defineOwnData(hostilePayload, "type", "before_provider_request");
    Object.defineProperty(hostilePayload, "payload", {
      enumerable: true,
      configurable: true,
      get: () => {
        payloadReads += 1;
        throw new Error("payload getter must not run");
      },
    });
    await host.triggerEvent("before_provider_request", hostilePayload);
    expect(payloadReads).toBe(0);
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
  });

  it("reports unsupported on the status line for a fast non-codex primary", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    installFastPrimary(host, { fast: true });
    await host.triggerSessionStart();
    await host.invokeCommand("weave:status");
    const message = host.notifyCalls.at(-1)?.message ?? "";
    expect(message).toContain("fast: unsupported (harness-seam-unavailable)");
    expect(message).not.toContain("applied");
    expect(message).not.toContain("fast: requested");
    expect(message).not.toContain("fast: declared");
    expect(message).not.toMatch(/(?<!not-)confirmed/);
    expect(message).not.toContain(PROVIDER_FAST_SECRET);
    expect(message).not.toContain("gpt-5.6-sol");
  });

  it("omits the status fast line when there is no intent", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    installFastPrimary(host);
    await host.triggerSessionStart();
    await host.invokeCommand("weave:status");
    const message = host.notifyCalls.at(-1)?.message ?? "";
    expect(message).toContain("health-only: false");
    expect(message).not.toContain("fast:");
    expect(message).not.toContain("applied");
  });

  it("stops reporting a fast primary's state after switching to a non-fast primary", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel, anthropicModel],
    });
    const extension = installFastPrimary(host, {
      fast: true,
      second: { name: "tapestry", model: anthropicModel },
    });
    await host.triggerSessionStart();
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );

    await host.invokeShortcut("alt+a");
    expect(extension.providerFastLatestForTest()).toBeUndefined();
    await host.invokeCommand("weave:status");
    expect(host.notifyCalls.at(-1)?.message ?? "").not.toContain("fast:");
  });

  it("persists exactly one sanitized terminal unsupported record per session", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    installFastPrimary(host, {
      fast: true,
      overrides: journalRecordingOverrides(journalEntries),
    });
    await host.triggerSessionStart();
    await host.triggerEvent("agent_settled");
    await host.triggerEvent("agent_settled");
    await flushBackgroundWork();

    expect(providerFastEvents(journalEntries)).toEqual([
      "provider-fast.unsupported",
    ]);
    const serialized = JSON.stringify(journalEntries);
    expect(serialized).not.toContain(PROVIDER_FAST_SECRET);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("applied");
    expect(serialized).not.toContain("requested");
    expect(serialized).not.toContain("not-confirmed");
    expect(serialized).not.toContain("gpt-5.6-sol");
  });

  it("persists nothing for a session with no fast intent", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    installFastPrimary(host, {
      overrides: journalRecordingOverrides(journalEntries),
    });
    await host.triggerSessionStart();
    await host.triggerEvent("agent_settled");
    await flushBackgroundWork();
    expect(providerFastEvents(journalEntries)).toEqual([]);
  });

  it("degrades a failing provider-fast journal write without leaking it", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    const extension = installFastPrimary(host, {
      fast: true,
      overrides: {
        runtimeStoreFactory: {
          open: () => okAsync(createInMemoryRuntimeStore()),
        },
        telemetryJournal: {
          write: (entry) => {
            const eventType =
              typeof entry === "object" &&
              entry !== null &&
              "eventType" in entry
                ? String((entry as { eventType?: unknown }).eventType)
                : "";
            if (eventType.startsWith("provider-fast.")) {
              return errAsync({
                type: "journal_write",
                message: PROVIDER_FAST_SECRET,
              } as RuntimeStoreError);
            }
            return okAsync(undefined);
          },
        },
        telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
      },
    });
    await host.triggerSessionStart();
    const payload = { model: "gpt-5.6-sol" };
    expect(await host.triggerBeforeProviderRequest(payload)).toBe(payload);
    await host.triggerEvent("agent_settled");
    await flushBackgroundWork();
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
    expect(JSON.stringify(host.notifyCalls)).not.toContain(
      PROVIDER_FAST_SECRET,
    );
    expect(JSON.stringify(host.notifyCalls)).not.toContain("applied");
  });

  it("records the replacement session's own outcome after a session reset", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [openaiModel],
    });
    const extension = installFastPrimary(host, {
      fast: true,
      overrides: journalRecordingOverrides(journalEntries),
    });
    await host.triggerSessionStart();
    await host.triggerEvent("agent_settled");
    await flushBackgroundWork();
    await host.triggerSessionStart();
    await host.triggerEvent("agent_settled");
    await flushBackgroundWork();

    expect(providerFastEvents(journalEntries)).toEqual([
      "provider-fast.unsupported",
      "provider-fast.unsupported",
    ]);
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
  });
});

// ---------------------------------------------------------------------------
// Bug B — the Plan Rail must name the plan a FOREGROUND execution is running
// ---------------------------------------------------------------------------

/**
 * A session with a real workflow controller, a readable plan, and a plan
 * catalog — i.e. everything a foreground `/weave:start` has in production,
 * except a workflow instance, which a foreground run never creates.
 */
function installForegroundPlanRailExtension(
  host: RecordingFakePiHost,
  provider: MutablePlanStateProvider,
  planNames: readonly string[] = ["foreground-plan"],
): void {
  installExtension(host, "0.81.1", {
    capabilityProber: allOkCapabilityProber(),
    configActivator: fakeConfigActivator({
      agents: [
        { agentName: "loom", source: "explicit", descriptor: loomDescriptor() },
        {
          agentName: "tapestry",
          source: "explicit",
          descriptor: tapestryDescriptor(),
        },
      ],
      errors: [],
    }),
    runtimeStoreFactory: { open: () => okAsync(createInMemoryRuntimeStore()) },
    planStateProviderFactory: () => provider,
    planCatalogPort: new FakePiPlanCatalogPort([...planNames]),
    telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
    telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
  });
}

/** A plan with three parent tasks, the second of which is in progress. */
function foregroundPlanSnapshot(
  planName = "foreground-plan",
  states: readonly ("completed" | "in_progress" | "pending")[] = [
    "completed",
    "in_progress",
    "pending",
  ],
): PlanTaskSnapshot {
  return {
    planName,
    contentRevision: "rev-1",
    format: "canonical",
    totalParentCount: states.length,
    complete: states.every((state) => state === "completed"),
    parents: states.map((state, index) => ({
      id: `${index + 1}`,
      title: `Task ${index + 1}`,
      state,
      children: [],
    })),
  } as PlanTaskSnapshot;
}

/** The ANSI-free lines the Plan Rail last painted. */
function planRailPlainLines(host: RecordingFakePiHost): string[] {
  return planRailLines(host).map((line) =>
    line.replace(ANSI, "").replace(/\s+$/u, ""),
  );
}

/**
 * Lets every fire-and-forget plan resolution finish.
 *
 * Plan resolution is deliberately asynchronous and last-request-wins, so the
 * rail repaints after the turn/tool event that triggered it returns. Yielding
 * both the microtask and the macrotask queue is what makes the assertion see
 * the frame a reader would.
 */
async function settlePlanSurfaces(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await flushBackgroundWork();
    await Bun.sleep(1);
  }
}

/**
 * One interactive submission, exactly as the host delivers it.
 *
 * The `input` event is only the adapter's own decision point. Pi accepts the
 * submission afterwards, and `before_agent_start` - which names the accepted
 * prompt - is the first event it fires only for a turn it actually started.
 * A direct foreground-plan request is adopted at that proof and nowhere else,
 * so every test that expects an adoption has to deliver both halves.
 */
async function submitInteractive(
  host: RecordingFakePiHost,
  text: string,
): Promise<void> {
  await host.triggerEvent("input", {
    type: "input",
    source: "interactive",
    text,
  });
  await host.triggerBeforeAgentStart({ prompt: text });
}

describe("createPiExtension: the Plan Rail follows a foreground plan execution", () => {
  it("names the plan, its marks, now and next after /weave:start", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
    installForegroundPlanRailExtension(host, provider);
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeCommand("weave:start", "foreground-plan");
    await settlePlanSurfaces();

    const rows = planRailPlainLines(host);
    expect(rows[0]).toContain("◆ WEAVE · TAPESTRY");
    expect(rows[0]).toContain("foreground-plan");
    expect(rows[1]).toContain("2/3");
    expect(rows[2]).toBe("┃ now   Task 2");
    expect(rows[3]).toBe("┗ next  Task 3");
    // Display-only: the kickoff turn is the only thing that was started.
    expect(host.sentUserMessages).toHaveLength(1);
  });

  it("records the selection as one bounded adapter-owned session entry", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
    installForegroundPlanRailExtension(host, provider);
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeCommand("weave:start", "foreground-plan");
    await settlePlanSurfaces();

    expect(
      host.appendedEntries.filter(
        (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
      ),
    ).toEqual([
      {
        type: FOREGROUND_PLAN_ENTRY_TYPE,
        data: { v: 1, planName: "foreground-plan" },
      },
    ]);
  });

  it("adopts one explicit direct request naming a contained plan path", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
    installForegroundPlanRailExtension(host, provider);
    await host.triggerSessionStart();

    await submitInteractive(
      host,
      "execute .weave/plans/foreground-plan.md end to end",
    );
    await settlePlanSurfaces();

    const rows = planRailPlainLines(host);
    expect(rows[0]).toContain("foreground-plan");
    expect(rows[2]).toBe("┃ now   Task 2");
  });

  it("ignores prose, traversal, several plans, and non-interactive input", async () => {
    for (const event of [
      {
        source: "interactive",
        text: "execute the foreground plan we discussed",
      },
      {
        source: "interactive",
        text: "what does .weave/plans/foreground-plan.md say?",
      },
      {
        source: "interactive",
        text: "execute .weave/plans/../../etc/passwd.md",
      },
      {
        source: "interactive",
        text: "execute ../other/.weave/plans/foreground-plan.md",
      },
      {
        source: "interactive",
        text: "execute .weave/plans/foreground-plan.md and .weave/plans/other-plan.md",
      },
      {
        source: "extension",
        text: "execute .weave/plans/foreground-plan.md",
      },
    ]) {
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
      installForegroundPlanRailExtension(host, provider, [
        "foreground-plan",
        "other-plan",
      ]);
      await host.triggerSessionStart();

      await host.triggerEvent("input", { type: "input", ...event });
      // A real turn follows every submission; none of these may redeem one.
      await host.triggerBeforeAgentStart({ prompt: event.text });
      await settlePlanSurfaces();

      expect({ text: event.text, task: planRailShowsTask(host) }).toEqual({
        text: event.text,
        task: false,
      });
      expect(
        host.appendedEntries.some(
          (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
        ),
      ).toBe(false);
    }
  });

  it("refuses a plan that is not in this project root's catalog", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const provider = new MutablePlanStateProvider(
      foregroundPlanSnapshot("other-worktree-plan"),
    );
    installForegroundPlanRailExtension(host, provider, ["foreground-plan"]);
    await host.triggerSessionStart();

    await submitInteractive(
      host,
      "execute .weave/plans/other-worktree-plan.md",
    );
    await settlePlanSurfaces();

    expect(planRailShowsTask(host)).toBe(false);
  });

  it("reconstructs the plan on restart from the adapter-owned entry alone", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: {
        getSessionId: () => "fake-session-1",
        getSessionFile: () => "/fake/sessions/fake-session-1.jsonl",
        isPersisted: () => true,
        getHeader: () => ({ id: "fake-session-1" }),
        getEntries: () => [
          {
            type: "message",
            role: "user",
            content: "execute .weave/plans/prose-only-plan.md",
          },
          {
            type: "custom",
            customType: FOREGROUND_PLAN_ENTRY_TYPE,
            data: { v: 1, planName: "foreground-plan" },
          },
        ],
      } as never,
    });
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
    installForegroundPlanRailExtension(host, provider);

    await host.triggerSessionStart();
    await settlePlanSurfaces();

    const rows = planRailPlainLines(host);
    expect(rows[0]).toContain("foreground-plan");
    expect(rows[2]).toBe("┃ now   Task 2");
  });

  it("moves now, next and the marks when a tool edits the plan", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
    installForegroundPlanRailExtension(host, provider);
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    await host.invokeCommand("weave:start", "foreground-plan");
    await settlePlanSurfaces();
    expect(planRailPlainLines(host)[2]).toBe("┃ now   Task 2");

    provider.setSnapshot(
      foregroundPlanSnapshot("foreground-plan", [
        "completed",
        "completed",
        "in_progress",
      ]),
    );
    await host.triggerEvent("tool_execution_end", {
      type: "tool_execution_end",
      toolName: "edit",
      toolCallId: "call-1",
      isError: false,
    });
    await settlePlanSurfaces();

    const rows = planRailPlainLines(host);
    expect(rows[1]).toContain("3/3");
    expect(rows[2]).toBe("┃ now   Task 3");
    expect(rows[3]).toBeUndefined();
  });

  it("clears the rail's plan tiers once the plan has nothing left to do", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
    installForegroundPlanRailExtension(host, provider);
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    await host.invokeCommand("weave:start", "foreground-plan");
    await settlePlanSurfaces();
    expect(planRailShowsTask(host)).toBe(true);

    provider.setSnapshot(
      foregroundPlanSnapshot("foreground-plan", [
        "completed",
        "completed",
        "completed",
      ]),
    );
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await settlePlanSurfaces();

    expect(planRailShowsTask(host)).toBe(false);
    expect(planRailPlainLines(host)[0]).toContain("◆ WEAVE · TAPESTRY");

    // The identity itself is dropped, so a later turn does not resurrect the
    // finished plan when its file is read again.
    provider.setSnapshot(foregroundPlanSnapshot());
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await settlePlanSurfaces();
    expect(planRailShowsTask(host)).toBe(false);
  });

  it("does not start, resume, or lease anything for a display-only plan", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const store = createInMemoryRuntimeStore();
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
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
      runtimeStoreFactory: { open: () => okAsync(store) },
      planStateProviderFactory: () => provider,
      planCatalogPort: new FakePiPlanCatalogPort(["foreground-plan"]),
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });
    await host.triggerSessionStart();

    await submitInteractive(host, "execute .weave/plans/foreground-plan.md");
    await settlePlanSurfaces();
    expect(planRailShowsTask(host)).toBe(true);

    // Nothing executes for a display identity: the store holds no workflow
    // instance and no lease, and the status line says nothing about the plan.
    await host.invokeCommand("weave:status");
    const status = host.notifyCalls.at(-1)?.message ?? "";
    expect(status).toContain("health-only: false");
    expect(status).not.toContain("foreground-plan");
    const instances = await store.instances.list();
    expect(instances.isOk() ? instances.value : ["unreadable"]).toEqual([]);
    const lease = await store.leases.findActive();
    expect(lease.isOk() ? lease.value : "unreadable").toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bug B — every foreground plan observation is guarded by session, root and
// request
// ---------------------------------------------------------------------------

/**
 * A catalog port whose listing is released by the test, one call at a time.
 *
 * Every foreground observation awaits this listing, which is exactly where a
 * newer message, a session switch, or a root replacement can overtake it.
 */
class DeferredPlanCatalogPort {
  readonly pending: (() => void)[] = [];

  constructor(private readonly names: readonly string[]) {}

  listPlanNames(
    _projectRoot: string,
  ): ResultAsync<readonly string[], PiAdapterFailure> {
    return ResultAsync.fromSafePromise(
      new Promise<readonly string[]>((resolve) => {
        this.pending.push(() => resolve([...this.names]));
      }),
    );
  }
}

/** A plan state provider that can answer for more than one plan. */
function multiPlanProvider(
  snapshots: readonly PlanTaskSnapshot[],
): MutablePlanStateProvider {
  const byName = new Map(snapshots.map((snap) => [snap.planName, snap]));
  const provider = new MutablePlanStateProvider(snapshots[0]);
  provider.readSnapshot = (planName: string) => {
    const found = byName.get(planName);
    return found === undefined
      ? (errAsync({ type: "PlanMissing" as const, planName }) as ReturnType<
          MutablePlanStateProvider["readSnapshot"]
        >)
      : (okAsync(found) as ReturnType<
          MutablePlanStateProvider["readSnapshot"]
        >);
  };
  return provider;
}

function installDeferredForegroundExtension(
  host: RecordingFakePiHost,
  provider: MutablePlanStateProvider,
  catalog: DeferredPlanCatalogPort,
): void {
  installExtension(host, "0.81.1", {
    capabilityProber: allOkCapabilityProber(),
    configActivator: fakeConfigActivator({
      agents: [
        { agentName: "loom", source: "explicit", descriptor: loomDescriptor() },
        {
          agentName: "tapestry",
          source: "explicit",
          descriptor: tapestryDescriptor(),
        },
      ],
      errors: [],
    }),
    runtimeStoreFactory: { open: () => okAsync(createInMemoryRuntimeStore()) },
    planStateProviderFactory: () => provider,
    planCatalogPort: catalog as unknown as FakePiPlanCatalogPort,
    telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
    telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
  });
}

describe("createPiExtension: foreground plan observations are race-safe", () => {
  it("lets the newest request win when an older one finishes last", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const catalog = new DeferredPlanCatalogPort(["alpha-plan", "beta-plan"]);
    installDeferredForegroundExtension(
      host,
      multiPlanProvider([
        foregroundPlanSnapshot("alpha-plan"),
        foregroundPlanSnapshot("beta-plan"),
      ]),
      catalog,
    );
    await host.triggerSessionStart();

    await submitInteractive(host, "execute .weave/plans/alpha-plan.md");
    await submitInteractive(host, "execute .weave/plans/beta-plan.md");
    expect(catalog.pending).toHaveLength(2);

    // The NEWER observation completes first, then the older one returns. The
    // older result describes a request the user has already superseded.
    catalog.pending[1]?.();
    await settlePlanSurfaces();
    catalog.pending[0]?.();
    await settlePlanSurfaces();

    const rows = planRailPlainLines(host);
    expect(rows[0]).toContain("beta-plan");
    expect(rows[0]).not.toContain("alpha-plan");
    expect(
      host.appendedEntries.filter(
        (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
      ),
    ).toEqual([
      {
        type: FOREGROUND_PLAN_ENTRY_TYPE,
        data: { v: 1, planName: "beta-plan" },
      },
    ]);
  });

  it("drops an observation whose session was replaced while it awaited", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const catalog = new DeferredPlanCatalogPort(["alpha-plan"]);
    installDeferredForegroundExtension(
      host,
      multiPlanProvider([foregroundPlanSnapshot("alpha-plan")]),
      catalog,
    );
    await host.triggerSessionStart();

    await submitInteractive(host, "execute .weave/plans/alpha-plan.md");
    expect(catalog.pending).toHaveLength(1);

    // A new session starts before the listing returns. The observation belongs
    // to the session that is gone, so it may not paint into its successor.
    await host.triggerSessionStart();
    catalog.pending[0]?.();
    await settlePlanSurfaces();

    expect(planRailShowsTask(host)).toBe(false);
    expect(
      host.appendedEntries.some(
        (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
      ),
    ).toBe(false);
  });

  it("revalidates a reconstructed plan against this root's catalog", async () => {
    // The session entry records a plan this project root does not have: the
    // worktree moved, or the plan was deleted or renamed. A restart shows the
    // agent identity alone rather than a plan that is not there.
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: {
        getSessionId: () => "fake-session-2",
        getSessionFile: () => "/fake/sessions/fake-session-2.jsonl",
        isPersisted: () => true,
        getHeader: () => ({ id: "fake-session-2" }),
        getEntries: () => [
          {
            type: "custom",
            customType: FOREGROUND_PLAN_ENTRY_TYPE,
            data: { v: 1, planName: "other-worktree-plan" },
          },
        ],
      } as never,
    });
    const provider = new MutablePlanStateProvider(
      foregroundPlanSnapshot("other-worktree-plan"),
    );
    installForegroundPlanRailExtension(host, provider, ["foreground-plan"]);

    await host.triggerSessionStart();
    await settlePlanSurfaces();

    expect(planRailShowsTask(host)).toBe(false);
    expect(planRailPlainLines(host)[0]).not.toContain("other-worktree-plan");
  });
});

// ---------------------------------------------------------------------------
// One monotonic observation generation, and adoption only after real routing
// ---------------------------------------------------------------------------

describe("createPiExtension: one monotonic foreground plan observation generation", () => {
  /**
   * Every interactive submission supersedes the pending observation before it,
   * whatever the new text turns out to say. Each case here defers the first
   * (valid) request's catalog listing, sends a second submission, and then
   * lets the first listing return: the older result describes a request the
   * user has already moved past, so it may not reach the rail.
   */
  const supersedingTexts: readonly (readonly [string, string])[] = [
    ["ordinary prose", "actually, let's look at the test failures first"],
    ["an invalid request", "what does .weave/plans/beta-plan.md say?"],
    ["a negated request", "don't run .weave/plans/alpha-plan.md"],
    ["the same plan again", "execute .weave/plans/alpha-plan.md"],
  ];

  for (const [label, superseding] of supersedingTexts) {
    it(`drops a deferred request superseded by ${label}`, async () => {
      const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
      const catalog = new DeferredPlanCatalogPort(["alpha-plan", "beta-plan"]);
      installDeferredForegroundExtension(
        host,
        multiPlanProvider([
          foregroundPlanSnapshot("alpha-plan"),
          foregroundPlanSnapshot("beta-plan"),
        ]),
        catalog,
      );
      await host.triggerSessionStart();

      await submitInteractive(host, "execute .weave/plans/alpha-plan.md");
      expect(catalog.pending).toHaveLength(1);

      await submitInteractive(host, superseding);

      // The first observation's listing returns LAST, after the user has
      // already sent something else.
      catalog.pending[0]?.();
      await settlePlanSurfaces();
      // A same-plan resubmission starts its own observation; release it too so
      // the only difference between the cases is which request wins.
      catalog.pending[1]?.();
      await settlePlanSurfaces();

      const adopted = host.appendedEntries.filter(
        (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
      );
      if (superseding === "execute .weave/plans/alpha-plan.md") {
        // The newest submission is the one that adopted, exactly once.
        expect(adopted).toEqual([
          {
            type: FOREGROUND_PLAN_ENTRY_TYPE,
            data: { v: 1, planName: "alpha-plan" },
          },
        ]);
        return;
      }
      expect(adopted).toEqual([]);
      expect(planRailShowsTask(host)).toBe(false);
    });
  }

  it("lets an authoritative /weave:start supersede an older direct request", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    const catalog = new DeferredPlanCatalogPort(["alpha-plan", "beta-plan"]);
    installDeferredForegroundExtension(
      host,
      multiPlanProvider([
        foregroundPlanSnapshot("alpha-plan"),
        foregroundPlanSnapshot("beta-plan"),
      ]),
      catalog,
    );
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await submitInteractive(host, "execute .weave/plans/alpha-plan.md");
    expect(catalog.pending).toHaveLength(1);

    // The user confirms a DIFFERENT plan through the command instead.
    const started = host.invokeCommand("weave:start", "beta-plan");
    await Bun.sleep(1);
    catalog.pending[1]?.();
    await started;
    await settlePlanSurfaces();
    expect(planRailPlainLines(host)[0]).toContain("beta-plan");

    // Only now does the older direct observation's listing return.
    catalog.pending[0]?.();
    await settlePlanSurfaces();

    expect(planRailPlainLines(host)[0]).toContain("beta-plan");
    expect(planRailPlainLines(host)[0]).not.toContain("alpha-plan");
    expect(
      host.appendedEntries.filter(
        (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
      ),
    ).toEqual([
      {
        type: FOREGROUND_PLAN_ENTRY_TYPE,
        data: { v: 1, planName: "beta-plan" },
      },
    ]);
  });

  it("never reuses an observation token across a session replacement", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const catalog = new DeferredPlanCatalogPort(["alpha-plan"]);
    installDeferredForegroundExtension(
      host,
      multiPlanProvider([foregroundPlanSnapshot("alpha-plan")]),
      catalog,
    );
    await host.triggerSessionStart();

    // Two sessions, each with one pending observation. Neither may adopt into
    // the other, and the second session's own token is a fresh identity even
    // though it is the "first" request of that session.
    await submitInteractive(host, "execute .weave/plans/alpha-plan.md");
    await host.triggerSessionStart();
    await submitInteractive(host, "execute .weave/plans/alpha-plan.md");
    catalog.pending[0]?.();
    await settlePlanSurfaces();

    // The replaced session's observation adopted nothing.
    expect(
      host.appendedEntries.filter(
        (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
      ),
    ).toEqual([]);

    catalog.pending[1]?.();
    await settlePlanSurfaces();
    expect(
      host.appendedEntries.filter(
        (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
      ),
    ).toEqual([
      {
        type: FOREGROUND_PLAN_ENTRY_TYPE,
        data: { v: 1, planName: "alpha-plan" },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Plan Rail refresh coalescing keeps the LATEST queued request
// ---------------------------------------------------------------------------

/**
 * A provider whose snapshot reads are released by the test, one at a time.
 *
 * Every plan refresh awaits this read, which is exactly where a replaced
 * session's own refresh arrives and is queued behind it.
 */
class DeferredPlanStateProvider extends MutablePlanStateProvider {
  readonly pending: (() => void)[] = [];

  override readSnapshot(planName: string) {
    const base = () => super.readSnapshot(planName);
    return ResultAsync.fromSafePromise(
      new Promise<PlanTaskSnapshot>((resolve) => {
        this.pending.push(() => {
          void base().map((snapshot) => {
            resolve(snapshot);
            return undefined;
          });
        });
      }),
    ) as ReturnType<MutablePlanStateProvider["readSnapshot"]>;
  }
}

describe("createPiExtension: plan refreshes coalesce onto the newest request", () => {
  it("paints the replacing session's plan after the replaced session's refresh returns", async () => {
    // Both sessions reconstruct the same adapter-owned selection, so each one
    // asks for a refresh of its OWN session's rail.
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      sessionManager: {
        getSessionId: () => "fake-session-3",
        getSessionFile: () => "/fake/sessions/fake-session-3.jsonl",
        isPersisted: () => true,
        getHeader: () => ({ id: "fake-session-3" }),
        getEntries: () => [
          {
            type: "custom",
            customType: FOREGROUND_PLAN_ENTRY_TYPE,
            data: { v: 1, planName: "foreground-plan" },
          },
        ],
      } as never,
    });
    const provider = new DeferredPlanStateProvider(foregroundPlanSnapshot());
    const catalog = new DeferredPlanCatalogPort(["foreground-plan"]);
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
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      planStateProviderFactory: () => provider,
      planCatalogPort: catalog as unknown as FakePiPlanCatalogPort,
      telemetryJournal: { write: (_entry: unknown) => okAsync(undefined) },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    });

    let releasedReads = 0;
    const releaseReads = async (): Promise<void> => {
      while (releasedReads < provider.pending.length) {
        provider.pending[releasedReads]?.();
        releasedReads += 1;
        await settlePlanSurfaces();
      }
    };

    // Session A reconstructs its selection and paints its rail.
    const sessionA = host.triggerSessionStart();
    await settlePlanSurfaces();
    catalog.pending[0]?.();
    await settlePlanSurfaces();
    await releaseReads();
    await sessionA;
    expect(planRailPlainLines(host)[0]).toContain("foreground-plan");

    // A settled turn starts A's next refresh, and it is still in flight.
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await settlePlanSurfaces();
    const readsWhileAIsRunning = provider.pending.length;
    expect(readsWhileAIsRunning).toBe(releasedReads + 1);

    // Session B replaces A. Its own selection is reconstructed while A's
    // refresh is still running, so B's repaint can only come from the queued
    // refresh: B's startup resolution already ran, with no plan to name.
    await host.triggerSessionStart();
    await settlePlanSurfaces();
    catalog.pending[1]?.();
    await settlePlanSurfaces();
    expect(planRailPlainLines(host)[0]).not.toContain("foreground-plan");
    expect(provider.pending).toHaveLength(readsWhileAIsRunning);

    // A's refresh returns last. It belongs to a session that is gone, so it
    // paints nothing - but it may not drop B's queued work either, which is
    // exactly what a shared dirty bit did: A cleared the bit, found itself
    // stale, and returned, leaving B's rail blank until some unrelated event
    // happened to repaint it.
    provider.pending[releasedReads]?.();
    releasedReads += 1;
    await settlePlanSurfaces();
    expect(provider.pending.length).toBe(readsWhileAIsRunning + 1);

    await releaseReads();

    // No tool completion, no settled turn, no further input: B's own selection
    // painted itself.
    expect(planRailPlainLines(host)[0]).toContain("foreground-plan");
    expect(planRailShowsTask(host)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adoption waits for the host's own turn-start proof
// ---------------------------------------------------------------------------

describe("createPiExtension: a direct request adopts only at a turn-start proof", () => {
  const REQUEST = "execute .weave/plans/foreground-plan.md";

  /** Every adapter-owned foreground-plan entry recorded so far. */
  function adoptedEntries(host: RecordingFakePiHost): unknown[] {
    return host.appendedEntries.filter(
      (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
    );
  }

  async function startedSession(): Promise<{
    host: RecordingFakePiHost;
    provider: MutablePlanStateProvider;
  }> {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
    installForegroundPlanRailExtension(host, provider);
    await host.triggerSessionStart();
    return { host, provider };
  }

  it("holds the parsed request as intent while no turn has started", async () => {
    const { host } = await startedSession();

    await host.triggerEvent("input", {
      type: "input",
      source: "interactive",
      text: REQUEST,
    });
    await settlePlanSurfaces();

    // The adapter let the message through; the host has not said it accepted
    // it. Nothing is adopted, recorded, or painted for a turn that may never
    // exist.
    expect(planRailShowsTask(host)).toBe(false);
    expect(planRailPlainLines(host).join("\n")).not.toContain(
      "foreground-plan",
    );
    expect(adoptedEntries(host)).toEqual([]);
  });

  it("adopts once the host proves the turn started for that prompt", async () => {
    const { host } = await startedSession();

    await host.triggerEvent("input", {
      type: "input",
      source: "interactive",
      text: REQUEST,
    });
    await settlePlanSurfaces();
    expect(adoptedEntries(host)).toEqual([]);

    await host.triggerBeforeAgentStart({ prompt: REQUEST });
    await settlePlanSurfaces();

    expect(planRailPlainLines(host)[0]).toContain("foreground-plan");
    expect(planRailShowsTask(host)).toBe(true);
    expect(adoptedEntries(host)).toEqual([
      {
        type: FOREGROUND_PLAN_ENTRY_TYPE,
        data: { v: 1, planName: "foreground-plan" },
      },
    ]);
  });

  it("adopts nothing when the turn never starts", async () => {
    const { host } = await startedSession();

    await host.triggerEvent("input", {
      type: "input",
      source: "interactive",
      text: REQUEST,
    });
    // The session goes on living - tools finish, turns settle - without the
    // host ever starting a turn for this submission.
    await host.triggerEvent("tool_execution_end", {
      type: "tool_execution_end",
      toolName: "edit",
      toolCallId: "call-1",
      isError: false,
    });
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await settlePlanSurfaces();

    expect(planRailShowsTask(host)).toBe(false);
    expect(adoptedEntries(host)).toEqual([]);
  });

  it("adopts nothing for a turn-start proof naming another prompt", async () => {
    const { host } = await startedSession();

    await host.triggerEvent("input", {
      type: "input",
      source: "interactive",
      text: REQUEST,
    });
    // An unrelated turn starts instead: the submission was handled, expanded,
    // or dropped, and something else is running.
    await host.triggerBeforeAgentStart({ prompt: "what changed in the diff?" });
    await settlePlanSurfaces();
    expect(adoptedEntries(host)).toEqual([]);

    // The intent is spent, not parked: a later turn quoting the original text
    // is not a second chance to adopt it.
    await host.triggerBeforeAgentStart({ prompt: REQUEST });
    await settlePlanSurfaces();

    expect(planRailShowsTask(host)).toBe(false);
    expect(adoptedEntries(host)).toEqual([]);
  });

  it("adopts nothing for a proof with no prompt at all", async () => {
    const { host } = await startedSession();

    await host.triggerEvent("input", {
      type: "input",
      source: "interactive",
      text: REQUEST,
    });
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    await settlePlanSurfaces();

    expect(planRailShowsTask(host)).toBe(false);
    expect(adoptedEntries(host)).toEqual([]);
  });

  it("lets the superseding message win, and only at its own proof", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const provider = multiPlanProvider([
      foregroundPlanSnapshot("alpha-plan"),
      foregroundPlanSnapshot("beta-plan"),
    ]);
    installForegroundPlanRailExtension(host, provider, [
      "alpha-plan",
      "beta-plan",
    ]);
    await host.triggerSessionStart();

    await host.triggerEvent("input", {
      type: "input",
      source: "interactive",
      text: "execute .weave/plans/alpha-plan.md",
    });
    await host.triggerEvent("input", {
      type: "input",
      source: "interactive",
      text: "execute .weave/plans/beta-plan.md",
    });

    // The superseded request's own text no longer redeems anything.
    await host.triggerBeforeAgentStart({
      prompt: "execute .weave/plans/alpha-plan.md",
    });
    await settlePlanSurfaces();
    expect(adoptedEntries(host)).toEqual([]);
    expect(planRailPlainLines(host).join("\n")).not.toContain("alpha-plan");

    await host.triggerEvent("input", {
      type: "input",
      source: "interactive",
      text: "execute .weave/plans/beta-plan.md",
    });
    await host.triggerBeforeAgentStart({
      prompt: "execute .weave/plans/beta-plan.md",
    });
    await settlePlanSurfaces();

    expect(planRailPlainLines(host)[0]).toContain("beta-plan");
    expect(adoptedEntries(host)).toEqual([
      {
        type: FOREGROUND_PLAN_ENTRY_TYPE,
        data: { v: 1, planName: "beta-plan" },
      },
    ]);
  });

  it("adopts nothing when the session was replaced before the proof", async () => {
    const { host } = await startedSession();

    await host.triggerEvent("input", {
      type: "input",
      source: "interactive",
      text: REQUEST,
    });
    // The pending intent belongs to the session that is gone.
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ prompt: REQUEST });
    await settlePlanSurfaces();

    expect(planRailShowsTask(host)).toBe(false);
    expect(adoptedEntries(host)).toEqual([]);
  });
});

describe("resolveWeaveInputDecision: adoption follows real routing", () => {
  it("claims the observation generation before the input is routed", async () => {
    const order: string[] = [];
    await resolveWeaveInputDecision({
      claimObservation: () => {
        order.push("claim");
        return () => order.push("complete");
      },
      routeInput: async () => {
        order.push("route");
        return { action: "continue" };
      },
    });
    expect(order).toEqual(["claim", "route", "complete"]);
  });

  it("runs no observation when the host reports the message handled", async () => {
    const order: string[] = [];
    const decision = await resolveWeaveInputDecision({
      claimObservation: () => {
        order.push("claim");
        return () => order.push("complete");
      },
      routeInput: async () => {
        order.push("route");
        return { action: "handled" };
      },
    });
    // A declined pause confirmation submits nothing, so the rail may not name
    // a plan for a turn that never happened - but the generation still moved.
    expect(order).toEqual(["claim", "route"]);
    expect(decision).toEqual({ action: "handled" });
  });

  it("runs no observation when routing itself fails", async () => {
    const order: string[] = [];
    await expect(
      resolveWeaveInputDecision({
        claimObservation: () => {
          order.push("claim");
          return () => order.push("complete");
        },
        routeInput: () => Promise.reject(new Error("host routing failed")),
      }),
    ).rejects.toThrow("host routing failed");
    expect(order).toEqual(["claim"]);
  });

  it("still routes an input that claimed no observation", async () => {
    const decision = await resolveWeaveInputDecision({
      claimObservation: () => undefined,
      routeInput: async () => ({ action: "continue" }),
    });
    expect(decision).toEqual({ action: "continue" });
  });
});

describe("createPiExtension: /weave:start adopts only a dispatched turn", () => {
  it("records no identity and paints no plan when the dispatch throws", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    host.poisonSendUserMessage();
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
    installForegroundPlanRailExtension(host, provider);
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeCommand("weave:start", "foreground-plan");
    await settlePlanSurfaces();

    // No turn exists, so nothing about a running plan may be stated.
    expect(host.sentUserMessages).toHaveLength(0);
    expect(
      host.appendedEntries.some(
        (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
      ),
    ).toBe(false);
    expect(planRailShowsTask(host)).toBe(false);
    expect(planRailPlainLines(host).join("\n")).not.toContain(
      "foreground-plan",
    );
    // The failure is reported, safely.
    expect(host.notifyCalls.at(-1)?.message).toContain("Could not start plan");
  });

  it("adopts the identity once the dispatch succeeds", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptConfirm(true);
    const provider = new MutablePlanStateProvider(foregroundPlanSnapshot());
    installForegroundPlanRailExtension(host, provider);
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });

    await host.invokeCommand("weave:start", "foreground-plan");
    await settlePlanSurfaces();

    expect(host.sentUserMessages).toHaveLength(1);
    expect(
      host.appendedEntries.filter(
        (entry) => entry.type === FOREGROUND_PLAN_ENTRY_TYPE,
      ),
    ).toEqual([
      {
        type: FOREGROUND_PLAN_ENTRY_TYPE,
        data: { v: 1, planName: "foreground-plan" },
      },
    ]);
    expect(planRailShowsTask(host)).toBe(true);
  });
});

describe("createPiExtension: the generation catalog cell", () => {
  const CATALOG_PROJECT_ROOT = "/fake/project";

  /**
   * Builds a publishable catalog state through the activator's own pipeline.
   * No refresh trigger exists yet, so tests publish directly into the cell.
   */
  async function catalogState(
    plan: MaterializationPlan,
    config: WeaveConfig = EMPTY_CONFIG,
  ): Promise<PiConfigCatalogState> {
    const activated = await fakeConfigActivator(plan, config).activate({
      projectRoot: CATALOG_PROJECT_ROOT,
      trust: "trusted",
    });
    return {
      activation: activated._unsafeUnwrap(),
      manifest: createPiConfigSourceManifest({
        identity: { projectRoot: CATALOG_PROJECT_ROOT, trust: "trusted" },
        globalConfigPath: "/fake/home/.weave/config.weave",
        projectConfigPath: `${CATALOG_PROJECT_ROOT}/.weave/config.weave`,
        promptFilePaths: [],
      }),
      contents: new Map(),
    };
  }

  function installLoomOnly(host: RecordingFakePiHost): PiExtensionInstance {
    return installExtension(host, "0.81.1", {
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
  }

  it("seeds one cell per generation from the boot activation", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installLoomOnly(host);

    expect(extension.catalogCellForTest()).toBeUndefined();

    await host.triggerSessionStart();

    const cell = extension.catalogCellForTest();
    expect(cell?.isLive()).toBe(true);
    expect([...(cell?.descriptors().keys() ?? [])]).toEqual(["loom"]);
    expect(cell?.workflows()).toEqual({});
    // The seed manifest names its sources without having read any of them.
    expect(cell?.manifest()?.files.map((file) => file.kind)).toEqual([
      "global-config",
      "project-config",
    ]);
  });

  it("publishes a whole catalog without disturbing the committed primary", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installLoomOnly(host);
    await host.triggerSessionStart();
    const cell = extension.catalogCellForTest();

    const published = await catalogState(
      {
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({
              composedPrompt: "You are Loom, rewritten by a later publish.",
            }),
          },
          {
            agentName: "tapestry",
            source: "explicit",
            descriptor: tapestryDescriptor(),
          },
        ],
        errors: [],
      },
      DIRECT_STEP_CONFIG,
    );
    expect(cell?.publish(published)).toBe("accepted");

    // Every facet of the catalog moved together, in one swap.
    expect([...(cell?.descriptors().keys() ?? [])]).toEqual([
      "loom",
      "tapestry",
    ]);
    expect(Object.keys(cell?.workflows() ?? {})).toEqual(["direct-flow"]);
    expect(cell?.refreshState()?.activation).toBe(published.activation);

    // The committed primary is pinned: the badge still names the boot
    // primary, and the turn still carries the prompt boot committed.
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · LOOM");
    const turn = await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(turn.systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(turn.systemPrompt).not.toContain(
      "You are Loom, rewritten by a later publish.",
    );
  });

  it("resolves an explicit Alt+A switch against the published catalog", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installLoomOnly(host);
    await host.triggerSessionStart();

    // Boot activated a catalog with a single primary, so there is nowhere to
    // cycle to until something is published.
    await host.invokeShortcut("alt+a");
    expect(host.notifyCalls.at(-1)).toEqual({
      message: "No other Weave primary agent is available.",
      level: "info",
    });

    extension.catalogCellForTest()?.publish(
      await catalogState({
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
    );

    await host.invokeShortcut("alt+a");

    expect(host.notifyCalls.at(-1)).toEqual({
      message: "Switched Weave primary agent to tapestry.",
      level: "info",
    });
    expect(shownAgentBadge(host)).toEqual("◆ WEAVE · TAPESTRY");
    const turn = await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(turn.systemPrompt).toContain(
      "You are Tapestry, the workflow orchestrator.",
    );
  });

  it("invalidates the replaced generation's cell", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installLoomOnly(host);
    await host.triggerSessionStart();
    const stale = extension.catalogCellForTest();
    const staleGenerationId = stale?.generationId;

    await host.triggerSessionStart();

    // A closure that still holds the replaced generation's cell reads
    // nothing usable, and can no longer publish into it.
    expect(stale?.isLive()).toBe(false);
    expect(stale?.activation()).toBeUndefined();
    expect(stale?.descriptors().size).toBe(0);
    expect(stale?.disabledSkills()).toEqual([]);
    expect(stale?.workflows()).toEqual({});
    expect(stale?.refreshState()).toBeUndefined();
    expect(
      stale?.publish(
        await catalogState({
          agents: [
            {
              agentName: "tapestry",
              source: "explicit",
              descriptor: tapestryDescriptor(),
            },
          ],
          errors: [],
        }),
      ),
    ).toBe("stale");

    const current = extension.catalogCellForTest();
    expect(current).not.toBe(stale);
    expect(current?.isLive()).toBe(true);
    expect(current?.generationId).not.toBe(staleGenerationId);
  });

  it("drops the cell when session shutdown revokes the generation", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installLoomOnly(host);
    await host.triggerSessionStart();
    const stale = extension.catalogCellForTest();

    await host.triggerEvent("session_shutdown");
    await flushBackgroundWork();

    expect(extension.catalogCellForTest()).toBeUndefined();
    expect(stale?.isLive()).toBe(false);
  });
});

describe("createPiExtension: the delegation-boundary config refresh", () => {
  const REFRESH_ROOT = "/fake/project";
  const PROJECT_CONFIG_PATH = `${REFRESH_ROOT}/.weave/config.weave`;
  const ALPHA_PROMPT_PATH = `${REFRESH_ROOT}/.weave/prompts/alpha.md`;

  const PROJECT_CONFIG_V1 = `
agent loom {
  description "orchestrator"
  prompt "loom prompt v1"
  models ["m1"]
  mode primary

  tool_policy {
    read allow
    write allow
    execute allow
    network deny
    delegate allow
  }
}

agent alpha {
  description "alpha subagent"
  prompt_file "alpha.md"
  models ["m1"]
  mode subagent
}
`;

  const NESTED_CONFIG_V1 = `${PROJECT_CONFIG_V1.replace(
    "mode primary\n\n  tool_policy",
    'mode primary\n\n  routing { delegation_exclude ["nested-worker"] }\n\n  tool_policy',
  ).replace(
    'agent alpha {\n  description "alpha subagent"',
    'agent alpha {\n  description "alpha subagent"\n  tool_policy { delegate allow }',
  )}`;

  const NESTED_WORKER_BLOCK = `
agent nested-worker {
  description "nested-only worker"
  prompt "nested worker v1"
  models ["m1"]
  mode subagent
}
`;

  const PRIMARY_SWITCH_CONFIG_V1 = `${PROJECT_CONFIG_V1}
disable agents ["tapestry"]

agent scribe {
  description "secondary primary"
  prompt "scribe prompt v1"
  models ["m1"]
  mode primary
  tool_policy { delegate deny }
}
`;

  const BETA_AGENT_BLOCK = `
agent beta {
  description "beta subagent"
  prompt "beta prompt v1"
  models ["m1"]
  mode subagent
}
`;

  const WORKFLOW_CONFIG_V1 = `${PROJECT_CONFIG_V1}
workflow hot-flow {
  description "Refreshable workflow"
  version 1

  step run {
    name "Run refreshed step"
    type autonomous
    agent alpha
    prompt "workflow task v1"
    completion agent_signal
  }
}
`;

  interface RefreshFiles {
    [path: string]: { content: string; mtimeMs: number };
  }

  function refreshFiles(): RefreshFiles {
    return {
      [PROJECT_CONFIG_PATH]: { content: PROJECT_CONFIG_V1, mtimeMs: 2_000 },
      [ALPHA_PROMPT_PATH]: { content: "alpha prompt v1\n", mtimeMs: 3_000 },
    };
  }

  /** In-memory config-source port: no real `.weave` file is ever touched. */
  function memoryConfigSourceFs(files: RefreshFiles): PiConfigSourceFsPort {
    return {
      statFile: (path) => {
        const file = files[path];
        return okAsync(
          file === undefined
            ? undefined
            : { size: file.content.length, mtimeMs: file.mtimeMs },
        );
      },
      readFile: (path) => {
        const file = files[path];
        return file === undefined
          ? errAsync({
              type: "ReadFailed" as const,
              path,
              message: "missing",
            })
          : okAsync(file.content);
      },
    };
  }

  interface RecordingConfigSourceFs extends PiConfigSourceFsPort {
    readonly statCalls: string[];
    readonly readCalls: string[];
    clear(): void;
  }

  function recordingConfigSourceFs(
    files: RefreshFiles,
  ): RecordingConfigSourceFs {
    const source = memoryConfigSourceFs(files);
    const statCalls: string[] = [];
    const readCalls: string[] = [];
    return {
      statCalls,
      readCalls,
      clear: () => {
        statCalls.length = 0;
        readCalls.length = 0;
      },
      statFile: (path) => {
        statCalls.push(path);
        return source.statFile(path);
      },
      readFile: (path) => {
        readCalls.push(path);
        return source.readFile(path);
      },
    };
  }

  function memoryActivator(files: RefreshFiles): PiConfigActivator {
    return new PiConfigActivator({
      fileReader: {
        exists: async (path) => path in files,
        read: (path) => {
          const file = files[path];
          return file === undefined
            ? errAsync({
                type: "FileReadError" as const,
                path,
                cause: new Error("missing"),
              })
            : okAsync(file.content);
        },
      },
      promptFileReader: {
        read: (path) => {
          const file = files[path];
          return file === undefined
            ? errAsync({ message: "missing" })
            : okAsync(file.content);
        },
      },
    });
  }

  function installWithRefresh(
    host: RecordingFakePiHost,
    files: RefreshFiles,
    options: {
      readonly sourceFs?: PiConfigSourceFsPort;
      readonly overrides?: Partial<PiExtensionDeps>;
    } = {},
  ): PiExtensionInstance {
    return installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: memoryActivator(files),
      configSourceFsPort: options.sourceFs ?? memoryConfigSourceFs(files),
      configRefreshMinIntervalMs: 0,
      ...options.overrides,
    });
  }

  function latestDelegateTool(host: RecordingFakePiHost) {
    const registration = host.registerToolCalls
      .filter((tool) => tool.name === "weave_delegate")
      .at(-1);
    if (registration === undefined) {
      throw new Error("test setup: weave_delegate was not registered");
    }
    return registration;
  }

  function bootstrapBodyOf(
    process: FakeSpawnedProcess,
  ): Record<string, unknown> {
    const prefix = "/weave:__control__ ";
    for (const line of process.writtenLines() as Array<{
      readonly type?: unknown;
      readonly message?: unknown;
    }>) {
      if (
        line.type !== "prompt" ||
        typeof line.message !== "string" ||
        !line.message.startsWith(prefix)
      ) {
        continue;
      }
      const envelope = JSON.parse(line.message.slice(prefix.length)) as {
        readonly kind?: unknown;
        readonly body?: unknown;
      };
      if (
        envelope.kind === "bootstrap" &&
        typeof envelope.body === "object" &&
        envelope.body !== null
      ) {
        return envelope.body as Record<string, unknown>;
      }
    }
    throw new Error("test setup: child bootstrap was not written");
  }

  function controlEnvelopesOf(process: FakeSpawnedProcess): Array<{
    readonly kind?: string;
    readonly correlationId?: string;
    readonly body?: Record<string, unknown>;
  }> {
    const prefix = "/weave:__control__ ";
    return (
      process.writtenLines() as Array<{
        readonly type?: unknown;
        readonly message?: unknown;
      }>
    )
      .filter(
        (line): line is { readonly type: "prompt"; readonly message: string } =>
          line.type === "prompt" &&
          typeof line.message === "string" &&
          line.message.startsWith(prefix),
      )
      .map(
        (line) =>
          JSON.parse(line.message.slice(prefix.length)) as {
            readonly kind?: string;
            readonly correlationId?: string;
            readonly body?: Record<string, unknown>;
          },
      );
  }

  function taskPromptsOf(process: FakeSpawnedProcess): string[] {
    const prefix = "/weave:__control__ ";
    return (
      process.writtenLines() as Array<{
        readonly type?: unknown;
        readonly message?: unknown;
      }>
    )
      .filter(
        (line): line is { readonly type: "prompt"; readonly message: string } =>
          line.type === "prompt" &&
          typeof line.message === "string" &&
          !line.message.startsWith(prefix),
      )
      .map((line) => line.message);
  }

  async function waitForTaskPrompt(
    process: FakeSpawnedProcess,
  ): Promise<string[]> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const prompts = taskPromptsOf(process);
      if (prompts.length > 0) return prompts;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return taskPromptsOf(process);
  }

  async function settleAuthenticatedChild(
    process: FakeSpawnedProcess,
    send: (kind: PiControlKind, body: JsonValue) => Promise<void>,
    options: {
      readonly output?: string;
      readonly completionCandidate?: object;
    } = {},
  ): Promise<void> {
    const output = options.output ?? "ok";
    process.emitLine({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: output }],
      },
    });
    await flushBackgroundWork();
    await send("settled", {
      outcome: "completed",
      assistantOutput: output,
      outputByteLength: new TextEncoder().encode(output).byteLength,
      interventionCount: 0,
      ...(options.completionCandidate === undefined
        ? {}
        : {
            completionCandidate: serializeCompletionCandidate(
              options.completionCandidate,
            ),
          }),
    });
    await flushBackgroundWork();
  }

  async function executeRootDelegation(
    host: RecordingFakePiHost,
    processPort: FakeChildProcessPort,
    input: {
      readonly callId: string;
      readonly agent: string;
      readonly task?: string;
    },
  ): Promise<{
    readonly execution: ReturnType<
      ReturnType<typeof latestDelegateTool>["execute"]
    >;
    readonly process: FakeSpawnedProcess;
  }> {
    const processIndex = processPort.spawnedProcesses.length;
    const execution = latestDelegateTool(host).execute(
      input.callId,
      { agent: input.agent, task: input.task ?? "do it" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    const process = await processPort.spawnPromises[processIndex];
    return { execution, process };
  }

  function delegationPayload(
    result: Awaited<
      ReturnType<ReturnType<typeof latestDelegateTool>["execute"]>
    >,
  ): Record<string, unknown> {
    return JSON.parse(
      (result.content[0] as { readonly text: string }).text,
    ) as Record<string, unknown>;
  }

  function composedPromptOf(
    extension: PiExtensionInstance,
    agentName: string,
  ): string {
    return (
      extension.catalogCellForTest()?.descriptors().get(agentName)
        ?.composedPrompt ?? ""
    );
  }

  it("publishes a subagent prompt edit at the next delegation boundary", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    // The seed manifest names its sources without observing them, so the
    // first boundary is what turns them into digests.
    await extension.configRefreshForTest()?.ensureFresh();

    expect(composedPromptOf(extension, "alpha")).toContain("alpha prompt v1");
    files[ALPHA_PROMPT_PATH] = { content: "alpha prompt v2\n", mtimeMs: 9_000 };

    await extension.configRefreshForTest()?.ensureFresh();

    expect(extension.configRefreshForTest()?.lastOutcome()).toEqual({
      kind: "published",
      change: "prompt-only",
      changedPaths: [ALPHA_PROMPT_PATH],
    });
    expect(composedPromptOf(extension, "alpha")).toContain("alpha prompt v2");
    // The committed primary keeps the prompt the harness already received.
    const turn = await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(turn.systemPrompt).toContain("loom prompt v1");
  });

  it("defers an edit to the active primary and keeps serving the current catalog", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    files[PROJECT_CONFIG_PATH] = {
      content: PROJECT_CONFIG_V1.replace(
        '"loom prompt v1"',
        '"loom prompt v2"',
      ),
      mtimeMs: 9_000,
    };

    await extension.configRefreshForTest()?.ensureFresh();

    expect(extension.configRefreshForTest()?.lastOutcome()).toEqual({
      kind: "deferred",
      changedFacets: ["prompt"],
      changedPaths: [PROJECT_CONFIG_PATH],
    });
    expect(composedPromptOf(extension, "loom")).toContain("loom prompt v1");
    const turn = await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(turn.systemPrompt).toContain("loom prompt v1");
    expect(turn.systemPrompt).not.toContain("loom prompt v2");
  });

  it("publishes the deferred edit once an explicit Alt+A switch commits", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    files[PROJECT_CONFIG_PATH] = {
      content: PROJECT_CONFIG_V1.replace(
        '"loom prompt v1"',
        '"loom prompt v2"',
      ),
      mtimeMs: 9_000,
    };
    await extension.configRefreshForTest()?.ensureFresh();
    expect(extension.configRefreshForTest()?.lastOutcome()?.kind).toBe(
      "deferred",
    );

    await host.invokeShortcut("alt+a");

    // The reactivation re-probed, rebuilt, and guarded against the primary
    // that just committed - which the edit leaves untouched.
    expect(extension.configRefreshForTest()?.lastOutcome()?.kind).toBe(
      "published",
    );
    expect(composedPromptOf(extension, "loom")).toContain("loom prompt v2");
    expect(extension.catalogCellForTest()?.deferred()).toBeUndefined();
  });

  it("does not build a coordinator for a health-only generation", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    // One unavailable required capability keeps this generation health-only:
    // it activates a catalog but registers no delegation surface at all.
    const extension = installExtension(host, "0.81.1", {
      capabilityProber: {
        probe: () =>
          ALL_CAPABILITY_IDS.map((capabilityId) => ({
            capabilityId,
            probeStatus:
              capabilityId === "delegated-specialist-execution"
                ? ("unavailable" as const)
                : ("ok" as const),
          })),
      },
      configActivator: memoryActivator(files),
      configSourceFsPort: memoryConfigSourceFs(files),
      configRefreshMinIntervalMs: 0,
    });
    await host.triggerSessionStart();

    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("health-only");
    expect(extension.configRefreshForTest()).toBeUndefined();
  });

  it("does not build a coordinator for an untrusted project", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: false });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();

    expect(extension.configRefreshForTest()).toBeUndefined();
  });

  it("does not build a coordinator when no config-source port is wired", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: memoryActivator(files),
    });
    await host.triggerSessionStart();

    expect(extension.catalogCellForTest()?.isLive()).toBe(true);
    expect(extension.configRefreshForTest()).toBeUndefined();
  });

  it("replaces the coordinator with the generation it belongs to", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    const first = extension.configRefreshForTest();
    files[ALPHA_PROMPT_PATH] = { content: "alpha prompt v2\n", mtimeMs: 9_000 };
    await first?.ensureFresh();
    expect(first?.lastOutcome()?.kind).toBe("published");

    await host.triggerSessionStart();

    const second = extension.configRefreshForTest();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // The replaced generation's coordinator was disposed with its catalog.
    expect(first?.lastOutcome()).toBeUndefined();
    await first?.ensureFresh();
    expect(first?.lastOutcome()).toBeUndefined();
  });

  it("refreshes before a recovery restore spawns its child", async () => {
    const order: string[] = [];
    const files = refreshFiles();
    const sourceFs = memoryConfigSourceFs(files);
    const probingFs: PiConfigSourceFsPort = {
      statFile: (path) => {
        order.push("probe");
        return sourceFs.statFile(path);
      },
      readFile: (path) => sourceFs.readFile(path),
    };
    const history = mutableChildRefSource();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.scriptSelect(undefined);
    installRecoveryExtension(
      host,
      history,
      () => {
        order.push("restore");
        return okAsync({ finalOutput: "done", interventionCount: 1 });
      },
      { recovery_countdown_seconds: 0 },
      { configSourceFsPort: probingFs, configRefreshMinIntervalMs: 0 },
    );
    await host.triggerSessionStart();
    await flushBackgroundWork();

    // The restored child is a new dispatch, so the boundary probe runs first.
    expect(order).toContain("restore");
    expect(order.indexOf("probe")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("probe")).toBeLessThan(order.indexOf("restore"));
  });

  it("drops the coordinator when session shutdown revokes the generation", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installWithRefresh(host, refreshFiles());
    await host.triggerSessionStart();
    expect(extension.configRefreshForTest()).toBeDefined();

    await host.triggerEvent("session_shutdown");
    await flushBackgroundWork();

    expect(extension.configRefreshForTest()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Task 13 scenario matrix: real extension boundaries with fake ports only
  // -------------------------------------------------------------------------

  it("adds and removes a nested-only target without re-registering the stable tool", async () => {
    const files = refreshFiles();
    files[PROJECT_CONFIG_PATH] = {
      content: NESTED_CONFIG_V1,
      mtimeMs: 2_000,
    };
    const sourceFs = recordingConfigSourceFs(files);
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installWithRefresh(host, files, {
      sourceFs,
      overrides: {
        processPort,
        childCommand: ["/fake/pi"],
        runtimeStoreFactory: {
          open: () => okAsync(createInMemoryRuntimeStore()),
        },
      },
    });
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    const registrationCount = host.registerToolCalls.length;

    files[PROJECT_CONFIG_PATH] = {
      content: `${NESTED_CONFIG_V1}${NESTED_WORKER_BLOCK}`,
      mtimeMs: 9_000,
    };
    const added = await executeRootDelegation(host, processPort, {
      callId: "nested-added-root",
      agent: "alpha",
    });
    const sendAddedParent = await authenticateDirectChild(
      processPort,
      added.process,
    );
    expect(extension.configRefreshForTest()?.lastOutcome()?.kind).toBe(
      "published",
    );
    expect(
      extension.catalogCellForTest()?.descriptors().has("nested-worker"),
    ).toBe(true);
    expect(host.registerToolCalls).toHaveLength(registrationCount);

    await sendAddedParent("delegate-request", {
      agentName: "nested-worker",
      task: "nested work",
    });
    const nestedProcess = await processPort.spawnPromises[1];
    const sendNested = await authenticateDirectChild(
      processPort,
      nestedProcess,
    );
    expect(bootstrapBodyOf(nestedProcess).composedPrompt).toContain(
      "nested worker v1",
    );
    await settleAuthenticatedChild(nestedProcess, sendNested);
    await flushBackgroundWork();
    await settleAuthenticatedChild(added.process, sendAddedParent);
    expect(delegationPayload(await added.execution)).toMatchObject({
      ok: true,
    });

    files[PROJECT_CONFIG_PATH] = {
      content: NESTED_CONFIG_V1,
      mtimeMs: 11_000,
    };
    const removed = await executeRootDelegation(host, processPort, {
      callId: "nested-removed-root",
      agent: "alpha",
    });
    const sendRemovedParent = await authenticateDirectChild(
      processPort,
      removed.process,
    );
    expect(
      extension.catalogCellForTest()?.descriptors().has("nested-worker"),
    ).toBe(false);
    expect(host.registerToolCalls).toHaveLength(registrationCount);

    await sendRemovedParent("delegate-request", {
      agentName: "nested-worker",
      task: "must be refused",
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (
        controlEnvelopesOf(removed.process).some(
          (envelope) => envelope.kind === "delegate-response",
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(
      controlEnvelopesOf(removed.process).find(
        (envelope) => envelope.kind === "delegate-response",
      )?.body,
    ).toEqual({ ok: false, error: "invalid-delegation-target" });
    expect(processPort.spawnedProcesses).toHaveLength(3);
    await settleAuthenticatedChild(removed.process, sendRemovedParent);
    expect(delegationPayload(await removed.execution)).toMatchObject({
      ok: true,
    });
    expect(host.registerToolCalls).toHaveLength(registrationCount);
    expect(
      processPort.spawnedProcesses.every((process) => process.killed),
    ).toBe(true);
  });

  it("defers primary prompt and model edits without mutating active surfaces", async () => {
    const files = refreshFiles();
    files[PROJECT_CONFIG_PATH] = {
      content: PRIMARY_SWITCH_CONFIG_V1,
      mtimeMs: 2_000,
    };
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: { provider: "test", id: "m1" },
      availableModels: [
        { provider: "test", id: "m1" },
        { provider: "test", id: "m2" },
      ],
    });
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    const setModelCount = host.setModelCalls.length;

    files[PROJECT_CONFIG_PATH] = {
      content: PRIMARY_SWITCH_CONFIG_V1.replace(
        'prompt "loom prompt v1"',
        'prompt "loom prompt v2"',
      ).replace('models ["m1"]', 'models ["m2"]'),
      mtimeMs: 9_000,
    };
    await extension.configRefreshForTest()?.ensureFresh();

    expect(extension.configRefreshForTest()?.lastOutcome()).toMatchObject({
      kind: "deferred",
      changedFacets: ["prompt", "models"],
    });
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · LOOM");
    expect(host.getCurrentModel()?.id).toBe("m1");
    expect(host.setModelCalls).toHaveLength(setModelCount);
    const pinnedTurn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(pinnedTurn.systemPrompt).toContain("loom prompt v1");
    expect(pinnedTurn.systemPrompt).not.toContain("loom prompt v2");

    await host.invokeShortcut("alt+a");
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · SCRIBE");
    expect(extension.configRefreshForTest()?.lastOutcome()?.kind).toBe(
      "published",
    );
    await host.invokeShortcut("alt+a");
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · LOOM");
    expect(host.getCurrentModel()?.id).toBe("m2");
    const reactivatedTurn = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(reactivatedTurn.systemPrompt).toContain("loom prompt v2");
  });

  it("keeps an added primary target unavailable until reactivation, then dispatches through the same tool", async () => {
    const files = refreshFiles();
    files[PROJECT_CONFIG_PATH] = {
      content: PRIMARY_SWITCH_CONFIG_V1,
      mtimeMs: 2_000,
    };
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installWithRefresh(host, files, {
      overrides: {
        processPort,
        childCommand: ["/fake/pi"],
        runtimeStoreFactory: {
          open: () => okAsync(createInMemoryRuntimeStore()),
        },
      },
    });
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    const stableTool = latestDelegateTool(host);
    const registrationCount = host.registerToolCalls.length;

    files[PROJECT_CONFIG_PATH] = {
      content: `${PRIMARY_SWITCH_CONFIG_V1}${BETA_AGENT_BLOCK}`,
      mtimeMs: 9_000,
    };
    const refused = await stableTool.execute(
      "beta-before-reactivation",
      { agent: "beta", task: "must defer" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    expect(delegationPayload(refused)).toMatchObject({
      ok: false,
      error: "invalid-delegation-target",
    });
    expect(extension.configRefreshForTest()?.lastOutcome()).toMatchObject({
      kind: "deferred",
      changedFacets: ["delegation-targets"],
    });
    expect(processPort.spawnedProcesses).toHaveLength(0);
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · LOOM");
    expect(host.registerToolCalls).toHaveLength(registrationCount);

    await host.invokeShortcut("alt+a");
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · SCRIBE");
    await host.invokeShortcut("alt+a");
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · LOOM");
    expect(host.registerToolCalls).toHaveLength(registrationCount);
    expect(latestDelegateTool(host)).toBe(stableTool);

    const dispatched = await executeRootDelegation(host, processPort, {
      callId: "beta-after-reactivation",
      agent: "beta",
    });
    const send = await authenticateDirectChild(processPort, dispatched.process);
    expect(bootstrapBodyOf(dispatched.process).composedPrompt).toContain(
      "beta prompt v1",
    );
    await settleAuthenticatedChild(dispatched.process, send);
    expect(delegationPayload(await dispatched.execution)).toMatchObject({
      ok: true,
    });
    expect(dispatched.process.killed).toBe(true);
  });

  it("keeps a removed primary target serving until reactivation, then rejects it through the same tool", async () => {
    const files = refreshFiles();
    files[PROJECT_CONFIG_PATH] = {
      content: `${PRIMARY_SWITCH_CONFIG_V1}${BETA_AGENT_BLOCK}`,
      mtimeMs: 2_000,
    };
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installWithRefresh(host, files, {
      overrides: {
        processPort,
        childCommand: ["/fake/pi"],
        runtimeStoreFactory: {
          open: () => okAsync(createInMemoryRuntimeStore()),
        },
      },
    });
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    const stableTool = latestDelegateTool(host);
    const registrationCount = host.registerToolCalls.length;

    files[PROJECT_CONFIG_PATH] = {
      content: PRIMARY_SWITCH_CONFIG_V1,
      mtimeMs: 9_000,
    };
    const pinned = await executeRootDelegation(host, processPort, {
      callId: "beta-still-pinned",
      agent: "beta",
    });
    const sendPinned = await authenticateDirectChild(
      processPort,
      pinned.process,
    );
    expect(extension.configRefreshForTest()?.lastOutcome()).toMatchObject({
      kind: "deferred",
      changedFacets: ["delegation-targets"],
    });
    expect(bootstrapBodyOf(pinned.process).composedPrompt).toContain(
      "beta prompt v1",
    );
    await settleAuthenticatedChild(pinned.process, sendPinned);
    expect(delegationPayload(await pinned.execution)).toMatchObject({
      ok: true,
    });

    await host.invokeShortcut("alt+a");
    await host.invokeShortcut("alt+a");
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · LOOM");
    expect(latestDelegateTool(host)).toBe(stableTool);
    expect(host.registerToolCalls).toHaveLength(registrationCount);

    const processCount = processPort.spawnedProcesses.length;
    const refused = await stableTool.execute(
      "beta-after-removal",
      { agent: "beta", task: "must be gone" },
      undefined,
      undefined,
      host.createSessionContext(),
    );
    expect(delegationPayload(refused)).toMatchObject({
      ok: false,
      error: "invalid-delegation-target",
    });
    expect(processPort.spawnedProcesses).toHaveLength(processCount);
    expect(pinned.process.killed).toBe(true);
  });

  it("single-flights concurrent root refreshes and settles every fake child without leaks", async () => {
    const files = refreshFiles();
    const sourceFs = recordingConfigSourceFs(files);
    const processPort = new FakeChildProcessPort();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installWithRefresh(host, files, {
      sourceFs,
      overrides: {
        processPort,
        childCommand: ["/fake/pi"],
        runtimeStoreFactory: {
          open: () => okAsync(createInMemoryRuntimeStore()),
        },
      },
    });
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    sourceFs.clear();
    const publishCountBefore =
      extension.configRefreshForTest()?.diagnostics().publishCount ?? 0;
    const sourceCount =
      extension.catalogCellForTest()?.manifest()?.files.length ?? 0;
    files[ALPHA_PROMPT_PATH] = {
      content: "alpha prompt concurrent v2\n",
      mtimeMs: 9_000,
    };

    const tool = latestDelegateTool(host);
    const executions = Array.from({ length: 3 }, (_, index) =>
      tool.execute(
        `concurrent-${index}`,
        { agent: "alpha", task: `task ${index}` },
        undefined,
        undefined,
        host.createSessionContext(),
      ),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (processPort.spawnedProcesses.length === 3) break;
      await flushBackgroundWork();
    }
    expect(processPort.spawnedProcesses).toHaveLength(3);

    for (const process of processPort.spawnedProcesses) {
      const send = await authenticateDirectChild(processPort, process);
      expect(bootstrapBodyOf(process).composedPrompt).toContain(
        "alpha prompt concurrent v2",
      );
      await settleAuthenticatedChild(process, send);
    }
    const results = await Promise.all(executions);

    expect(results.map(delegationPayload)).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({ ok: true })),
    );
    expect(sourceFs.statCalls).toHaveLength(sourceCount);
    expect(sourceFs.readCalls).toEqual([ALPHA_PROMPT_PATH]);
    expect(extension.configRefreshForTest()?.diagnostics().publishCount).toBe(
      publishCountBefore + 1,
    );
    expect(
      processPort.spawnedProcesses.every((process) => process.killed),
    ).toBe(true);
  });

  it("keeps an in-flight direct step pinned while the next workflow run uses refreshed workflow and descriptor text", async () => {
    const files = refreshFiles();
    files[PROJECT_CONFIG_PATH] = {
      content: WORKFLOW_CONFIG_V1,
      mtimeMs: 2_000,
    };
    const processPort = new FakeChildProcessPort();
    const runtimeStore = createInMemoryRuntimeStore();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installWithRefresh(host, files, {
      overrides: {
        processPort,
        childCommand: ["/fake/pi"],
        runtimeStoreFactory: { open: () => okAsync(runtimeStore) },
      },
    });
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();

    host.scriptConfirm(true);
    const firstRun = host.invokeCommand("weave:run", "hot-flow");
    const firstProcess = await processPort.spawnPromises[0];
    const sendFirst = await authenticateDirectChild(processPort, firstProcess);
    const firstBootstrap = bootstrapBodyOf(firstProcess);
    expect(firstBootstrap.composedPrompt).toContain("alpha prompt v1");
    expect((await waitForTaskPrompt(firstProcess)).join("\n")).toContain(
      "workflow task v1",
    );

    files[ALPHA_PROMPT_PATH] = {
      content: "alpha prompt v2\n",
      mtimeMs: 9_000,
    };
    files[PROJECT_CONFIG_PATH] = {
      content: WORKFLOW_CONFIG_V1.replace(
        'prompt "workflow task v1"',
        'prompt "workflow task v2"',
      ),
      mtimeMs: 10_000,
    };
    await extension.configRefreshForTest()?.ensureFresh();

    expect(bootstrapBodyOf(firstProcess)).toEqual(firstBootstrap);
    expect(taskPromptsOf(firstProcess).join("\n")).toContain(
      "workflow task v1",
    );
    expect(taskPromptsOf(firstProcess).join("\n")).not.toContain(
      "workflow task v2",
    );
    await settleAuthenticatedChild(firstProcess, sendFirst, {
      completionCandidate: { outcome: "success", method: "agent_signal" },
    });
    await firstRun;
    expect((await runtimeStore.leases.findActive())._unsafeUnwrap()).toBeNull();

    host.scriptConfirm(true);
    const secondRun = host.invokeCommand("weave:run", "hot-flow");
    const secondProcess = await processPort.spawnPromises[1];
    const sendSecond = await authenticateDirectChild(
      processPort,
      secondProcess,
    );
    expect(bootstrapBodyOf(secondProcess).composedPrompt).toContain(
      "alpha prompt v2",
    );
    expect((await waitForTaskPrompt(secondProcess)).join("\n")).toContain(
      "workflow task v2",
    );
    await settleAuthenticatedChild(secondProcess, sendSecond, {
      completionCandidate: { outcome: "success", method: "agent_signal" },
    });
    await secondRun;
    expect((await runtimeStore.leases.findActive())._unsafeUnwrap()).toBeNull();
    expect(
      processPort.spawnedProcesses.every((process) => process.killed),
    ).toBe(true);
  });

  it("restores with the descriptor published while the recovery prompt is open", async () => {
    const files = refreshFiles();
    const sourceFs = recordingConfigSourceFs(files);
    const history = mutableChildRefSource(
      eligibleOrdinaryRecoveryRecord({ title: "alpha" }),
    );
    const restored: unknown[] = [];
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const pendingChoice = host.deferNextSelect();
    const extension = installWithRefresh(host, files, {
      sourceFs,
      overrides: {
        runtimeStoreFactory: {
          open: () => okAsync(createInMemoryRuntimeStore()),
        },
        threadSourceFactory: history.factory,
        parentSessionId: () => "parent",
        restoreOrdinaryChild: (input) => {
          restored.push(input);
          return okAsync({ finalOutput: "restored", interventionCount: 0 });
        },
      },
    });
    await host.triggerSessionStart();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (host.selectCalls.length > 0) break;
      await flushBackgroundWork();
    }
    expect(host.selectCalls).toHaveLength(1);
    await extension.configRefreshForTest()?.ensureFresh();
    files[ALPHA_PROMPT_PATH] = {
      content: "alpha prompt restored v2\n",
      mtimeMs: 9_000,
    };
    await extension.configRefreshForTest()?.ensureFresh();

    pendingChoice.settle("Recover now");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        restored.length > 0 &&
        history.updates.some((update) => update.status === "completed")
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(restored).toHaveLength(1);
    expect(
      (restored[0] as { descriptor: AgentDescriptor }).descriptor
        .composedPrompt,
    ).toContain("alpha prompt restored v2");
    expect(history.updates.map((update) => update.status)).toEqual([
      "running",
      "completed",
    ]);
    expect(history.records[0]?.status).toBe("completed");
  });

  it("discards an in-flight candidate and deferral when session replacement boots authoritative config", async () => {
    const files = refreshFiles();
    const source = memoryConfigSourceFs(files);
    let holdProjectRead = false;
    let releaseProjectRead: ((content: string) => void) | undefined;
    let markProjectReadStarted: (() => void) | undefined;
    const projectReadStarted = new Promise<void>((resolve) => {
      markProjectReadStarted = resolve;
    });
    const delayedFs: PiConfigSourceFsPort = {
      statFile: (path) => source.statFile(path),
      readFile: (path) => {
        if (!holdProjectRead || path !== PROJECT_CONFIG_PATH) {
          return source.readFile(path);
        }
        markProjectReadStarted?.();
        return ResultAsync.fromPromise(
          new Promise<string>((resolve) => {
            releaseProjectRead = resolve;
          }),
          () => ({
            type: "ReadFailed" as const,
            path,
            message: "test gate failed",
          }),
        );
      },
    };
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const extension = installWithRefresh(host, files, {
      sourceFs: delayedFs,
    });
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    const oldCoordinator = extension.configRefreshForTest();
    const oldCell = extension.catalogCellForTest();

    files[PROJECT_CONFIG_PATH] = {
      content: PROJECT_CONFIG_V1.replace(
        'prompt "loom prompt v1"',
        'prompt "loom prompt v2"',
      ),
      mtimeMs: 9_000,
    };
    await oldCoordinator?.ensureFresh();
    expect(oldCell?.deferred()).toBeDefined();

    files[PROJECT_CONFIG_PATH] = {
      content: PROJECT_CONFIG_V1.replace(
        'prompt "loom prompt v1"',
        'prompt "loom prompt v3"',
      ),
      mtimeMs: 11_000,
    };
    holdProjectRead = true;
    const staleRefresh = oldCoordinator?.ensureFresh();
    await projectReadStarted;

    await host.triggerSessionStart();
    const replacementCoordinator = extension.configRefreshForTest();
    const replacementCell = extension.catalogCellForTest();
    releaseProjectRead?.(files[PROJECT_CONFIG_PATH]?.content ?? "");
    await staleRefresh;
    await flushBackgroundWork();

    expect(oldCoordinator?.lastOutcome()).toBeUndefined();
    expect(oldCell?.isLive()).toBe(false);
    expect(oldCell?.deferred()).toBeUndefined();
    expect(replacementCoordinator).not.toBe(oldCoordinator);
    expect(replacementCoordinator?.diagnostics()).toEqual({
      state: { kind: "fresh" },
      publishCount: 0,
    });
    expect(replacementCell?.deferred()).toBeUndefined();
    expect(
      replacementCell?.descriptors().get("loom")?.composedPrompt,
    ).toContain("loom prompt v3");
    const turn = await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(turn.systemPrompt).toContain("loom prompt v3");
    expect(turn.systemPrompt).not.toContain("loom prompt v2");
  });

  // -------------------------------------------------------------------------
  // Bounded diagnostics on the existing status surface
  // -------------------------------------------------------------------------

  /** Everything a rendered refresh diagnostic must never contain. */
  const REFRESH_SENTINELS = [
    PROJECT_CONFIG_PATH,
    ALPHA_PROMPT_PATH,
    ".weave",
    "loom prompt v1",
    "loom prompt v2",
    "alpha prompt v1",
    "UnterminatedString",
    "SourceReadFailed",
    "ConfigParseFailed",
    "PromptSourceDisappeared",
  ] as const;

  function installWithLogger(
    host: RecordingFakePiHost,
    files: RefreshFiles,
    logger: RecordingLogger,
  ): PiExtensionInstance {
    return installExtension(host, "0.81.1", {
      capabilityProber: allOkCapabilityProber(),
      configActivator: memoryActivator(files),
      configSourceFsPort: memoryConfigSourceFs(files),
      configRefreshMinIntervalMs: 0,
      logger,
    });
  }

  /** The one `/weave:status` row this task owns. */
  async function refreshStatusLine(
    host: RecordingFakePiHost,
  ): Promise<string | undefined> {
    await host.invokeCommand("weave:status");
    const message = host.notifyCalls.at(-1)?.message ?? "";
    return message
      .split("\n")
      .find((line) => line.startsWith("config refresh:"));
  }

  function expectBoundedRefreshLine(line: string | undefined): string {
    expect(line).toBeDefined();
    const rendered = line ?? "";
    for (const sentinel of REFRESH_SENTINELS) {
      expect(rendered).not.toContain(sentinel);
    }
    return rendered;
  }

  it("reports a fresh catalog and its publish count on /weave:status", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();

    expect(expectBoundedRefreshLine(await refreshStatusLine(host))).toBe(
      "config refresh: fresh; published 0",
    );

    files[ALPHA_PROMPT_PATH] = { content: "alpha prompt v2\n", mtimeMs: 9_000 };
    await extension.configRefreshForTest()?.ensureFresh();

    expect(expectBoundedRefreshLine(await refreshStatusLine(host))).toBe(
      "config refresh: fresh; published 1",
    );
  });

  it("reports a deferral as primary-affecting with its facet names", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    files[PROJECT_CONFIG_PATH] = {
      content: PROJECT_CONFIG_V1.replace(
        '"loom prompt v1"',
        '"loom prompt v2"',
      ),
      mtimeMs: 9_000,
    };

    await extension.configRefreshForTest()?.ensureFresh();

    expect(expectBoundedRefreshLine(await refreshStatusLine(host))).toBe(
      "config refresh: deferred: primary-affecting; published 1; facets prompt",
    );
  });

  it("reports a refresh failure as a closed reason", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    files[PROJECT_CONFIG_PATH] = {
      content: 'agent loom {\n  description "unterminated',
      mtimeMs: 9_000,
    };

    await extension.configRefreshForTest()?.ensureFresh();

    expect(expectBoundedRefreshLine(await refreshStatusLine(host))).toBe(
      "config refresh: failed: config-invalid; published 1",
    );
    // A missing prompt source is its own closed reason.
    files[PROJECT_CONFIG_PATH] = {
      content: PROJECT_CONFIG_V1,
      mtimeMs: 11_000,
    };
    delete files[ALPHA_PROMPT_PATH];
    await extension.configRefreshForTest()?.ensureFresh();

    expect(expectBoundedRefreshLine(await refreshStatusLine(host))).toBe(
      "config refresh: failed: prompt-unavailable; published 1",
    );
  });

  it("returns to fresh after a failure without leaking the old state", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    files[PROJECT_CONFIG_PATH] = {
      content: 'agent loom {\n  description "unterminated',
      mtimeMs: 9_000,
    };
    await extension.configRefreshForTest()?.ensureFresh();
    expect(await refreshStatusLine(host)).toContain("failed");

    // The operator finished the edit; the next boundary publishes it.
    files[PROJECT_CONFIG_PATH] = {
      content: PROJECT_CONFIG_V1,
      mtimeMs: 11_000,
    };
    await extension.configRefreshForTest()?.ensureFresh();

    const line = expectBoundedRefreshLine(await refreshStatusLine(host));
    expect(line).toBe("config refresh: fresh; published 2");
    expect(line).not.toContain("failed");
    expect(line).not.toContain("config-invalid");
  });

  it("notifies and warns once per distinct failure state", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const logger = new RecordingLogger();
    const extension = installWithLogger(host, files, logger);
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    files[PROJECT_CONFIG_PATH] = {
      content: 'agent loom {\n  description "unterminated',
      mtimeMs: 9_000,
    };

    // Five boundaries, one broken config, one notice.
    for (let index = 0; index < 5; index += 1) {
      await extension.configRefreshForTest()?.ensureFresh();
    }

    const notices = host.notifyCalls.filter((call) =>
      call.message.startsWith("Weave could not apply a configuration change"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe("warning");
    for (const sentinel of REFRESH_SENTINELS) {
      expect(notices[0]?.message).not.toContain(sentinel);
    }

    const warnings = logger.entries.filter(
      (entry) => entry.level === "warn" && entry.obj.refresh === "failed",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toEqual({
      refresh: "failed",
      reason: "config-invalid",
    });
    expect(JSON.stringify(warnings[0])).not.toContain(PROJECT_CONFIG_PATH);
  });

  it("notifies and warns once per distinct deferral state", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const logger = new RecordingLogger();
    const extension = installWithLogger(host, files, logger);
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    files[PROJECT_CONFIG_PATH] = {
      content: PROJECT_CONFIG_V1.replace(
        '"loom prompt v1"',
        '"loom prompt v2"',
      ),
      mtimeMs: 9_000,
    };

    for (let index = 0; index < 4; index += 1) {
      await extension.configRefreshForTest()?.ensureFresh();
    }

    const notices = host.notifyCalls.filter(
      (call) => call.message === PI_CONFIG_REFRESH_DEFERRAL_MESSAGE,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe("warning");
    // Fixed and actionable: what happened, and what to do about it.
    expect(notices[0]?.message).toContain("affects the active primary");
    expect(notices[0]?.message).toContain("switch primary or restart to apply");

    const warnings = logger.entries.filter(
      (entry) => entry.level === "warn" && entry.obj.refresh === "deferred",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toEqual({
      refresh: "deferred",
      facets: "prompt",
    });
  });

  it("keeps delegation working while a refresh keeps failing", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    await extension.configRefreshForTest()?.ensureFresh();
    files[PROJECT_CONFIG_PATH] = {
      content: 'agent loom {\n  description "unterminated',
      mtimeMs: 9_000,
    };

    await extension.configRefreshForTest()?.ensureFresh();

    expect(extension.configRefreshForTest()?.lastOutcome()?.kind).toBe(
      "failed",
    );
    // The last valid catalog still resolves every delegation target.
    expect(composedPromptOf(extension, "alpha")).toContain("alpha prompt v1");
    expect(extension.catalogCellForTest()?.isLive()).toBe(true);
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
  });

  it("omits the refresh row for a generation that never refreshes", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: false });
    const files = refreshFiles();
    const extension = installWithRefresh(host, files);
    await host.triggerSessionStart();
    expect(extension.configRefreshForTest()).toBeUndefined();

    await host.invokeCommand("weave:status");

    expect(host.notifyCalls.at(-1)?.message ?? "").not.toContain(
      "config refresh:",
    );
  });
});
/**
 * Codex subscription fast mode, wired into the running extension.
 *
 * These tests exercise the registration seam and the intent/reporting wiring
 * against the real `piAdapterExtension` function: the host object is a fake,
 * the host version and the pi-ai provider module are injected probes, and the
 * "native" provider is a stand-in that records what the wrapper handed it.
 * Nothing here starts a Pi process, opens a socket, or touches a real module.
 */

/** Never echoed by a log, a status line, a journal entry, or a snapshot. */
const CODEX_IMPORT_SECRET = "sk-proj-codex-import-secret-DO-NOT-ECHO-77aa11bc";

/** Handed to the seam as a hostile provenance "reason"; never renderable. */
const CODEX_PROVENANCE_SECRET =
  "sk-proj-codex-provenance-secret-DO-NOT-ECHO-91ff22de";

/** The other shape a hostile reason takes: an absolute host path. */
const CODEX_PROVENANCE_SECRET_PATH =
  "/Users/fixture/node_modules/@earendil-works/pi-ai/providers/openai-codex.js";

/**
 * The loader's closed provenance reason enum, restated at the assertion site.
 * A token outside this list reaching a log is the boundary failure these
 * tests exist to catch.
 */
const CODEX_FAST_PROVENANCE_REASON_TOKENS: readonly unknown[] = [
  "host-root-unproven",
  "host-package-mismatch",
  "no-local-copy",
  "already-host",
  "local-path-unsafe",
  "plugin-unavailable",
  "redirect-registered",
  "redirect-disabled",
  "outcome-missing",
  "specifier-unknown",
];

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_ELIGIBLE_MODEL_ID = "gpt-5.6-sol";
const CODEX_ELIGIBLE_RULE_ID = "codex-sub-06";
const CODEX_FIRST_PARTY_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_SUPPORTED_HOST_VERSION = "0.84.2";

const codexHostModel = {
  provider: CODEX_PROVIDER_ID,
  id: CODEX_ELIGIBLE_MODEL_ID,
  api: "openai-codex-responses",
};

const nonCodexHostModel = {
  provider: "anthropic",
  id: "claude-opus-5",
  api: "anthropic-messages",
};

/** A ChatGPT-shaped OAuth token whose payload carries the account claim. */
function codexSubscriptionToken(accountId = "acct-extension-fixture"): string {
  const payload = {
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  };
  const body = btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${btoa('{"alg":"none"}')}.${body}.${btoa("sig")}`;
}

const CODEX_SUBSCRIPTION_TOKEN = codexSubscriptionToken();

type RecordedNativeCall = {
  readonly model: unknown;
  readonly options: unknown;
};

type CodexSeamHarness = {
  readonly seam: PiCodexFastProviderSeam;
  readonly registered: unknown[];
  readonly nativeCalls: RecordedNativeCall[];
  readonly factoryCalls: () => number;
  readonly importCalls: () => number;
  readonly provenanceCalls: () => number;
  readonly nativeProviders: () => readonly Record<string, unknown>[];
  /** Attaches `registerProvider` to the fake host, as a real Pi 0.84 host has. */
  readonly attachTo: (host: RecordingFakePiHost) => void;
  /** The single wrapped provider the host was handed, if any. */
  readonly wrapped: () => Record<string, unknown> | undefined;
};

/**
 * Builds the injected host probes plus a native provider stand-in with the
 * same shape pi-ai's codex provider has.
 */
function codexSeamHarness(
  options: {
    readonly hostVersion?: string;
    readonly importProviderModule?: () => Promise<unknown>;
    readonly moduleNamespace?: unknown;
    /**
     * Provenance of the codex provider subpath itself. Defaults to the proven
     * host copy; a test that wants the live blocker's shape passes an
     * `unproven` verdict here while leaving the host version supported.
     */
    readonly providerModuleProvenance?: () => PiHostModuleProvenance;
  } = {},
): CodexSeamHarness {
  const registered: unknown[] = [];
  const nativeCalls: RecordedNativeCall[] = [];
  const nativeProviders: Record<string, unknown>[] = [];
  let factoryCalls = 0;
  let importCalls = 0;
  let provenanceCalls = 0;

  const createNative = (): Record<string, unknown> => {
    const nativeResult = { kind: "native-stream" };
    const provider: Record<string, unknown> = {
      id: CODEX_PROVIDER_ID,
      name: "OpenAI Codex",
      baseUrl: CODEX_FIRST_PARTY_BASE_URL,
      auth: { oauth: { kind: "chatgpt" } },
      stream: (...args: unknown[]) => {
        nativeCalls.push({ model: args[0], options: args[2] });
        return nativeResult;
      },
      streamSimple: (...args: unknown[]) => {
        nativeCalls.push({ model: args[0], options: args[2] });
        return nativeResult;
      },
    };
    nativeProviders.push(provider);
    return provider;
  };

  const defaultNamespace = {
    openaiCodexProvider: () => {
      factoryCalls += 1;
      return createNative();
    },
  };

  const seam: PiCodexFastProviderSeam = {
    readHostVersion: () => options.hostVersion ?? CODEX_SUPPORTED_HOST_VERSION,
    readProviderModuleProvenance: (): PiHostModuleProvenance => {
      provenanceCalls += 1;
      if (options.providerModuleProvenance !== undefined) {
        return options.providerModuleProvenance();
      }
      return { kind: "host", outcome: "redirected" };
    },
    importProviderModule: () => {
      importCalls += 1;
      if (options.importProviderModule !== undefined) {
        return options.importProviderModule();
      }
      return Promise.resolve(options.moduleNamespace ?? defaultNamespace);
    },
  };

  return {
    seam,
    registered,
    nativeCalls,
    factoryCalls: () => factoryCalls,
    importCalls: () => importCalls,
    provenanceCalls: () => provenanceCalls,
    nativeProviders: () => nativeProviders,
    attachTo: (host) => {
      host.api.registerProvider = (provider: unknown) => {
        registered.push(provider);
      };
    },
    wrapped: () => {
      const provider = registered.at(-1);
      return typeof provider === "object" && provider !== null
        ? (provider as Record<string, unknown>)
        : undefined;
    },
  };
}

function encodeChunk(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function codexSseBody(serviceTier: string): ReadableStream<Uint8Array> {
  const chunks = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { service_tier: "auto" },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { service_tier: serviceTier },
    })}\n\n`,
  ].map(encodeChunk);
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[index];
      index += 1;
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
  });
}

async function drainResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
  }
}

/**
 * Drives one stream call through the registered provider exactly as pi-ai's
 * codex api does: run the options' `onPayload` chain, then its `fetch`, then
 * read the response the caller would read.
 */
async function runCodexProviderCall(
  harness: CodexSeamHarness,
  input: {
    readonly modelId?: string;
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly serviceTier?: string;
    readonly requestHeaders?: Record<string, string>;
  } = {},
): Promise<{
  readonly callerOptions: Record<string, unknown>;
  readonly nativeOptions: Record<string, unknown> | undefined;
  readonly sentInit: Record<string, unknown> | undefined;
  readonly payload: Record<string, unknown>;
}> {
  const wrapped = harness.wrapped();
  if (wrapped === undefined) {
    throw new Error("test setup: no provider was registered");
  }
  const modelId = input.modelId ?? CODEX_ELIGIBLE_MODEL_ID;
  const sentInits: Record<string, unknown>[] = [];
  const callerOptions: Record<string, unknown> = {
    apiKey: input.apiKey ?? CODEX_SUBSCRIPTION_TOKEN,
    fetch: async (_url: unknown, init?: unknown): Promise<Response> => {
      sentInits.push((init ?? {}) as Record<string, unknown>);
      return new Response(codexSseBody(input.serviceTier ?? "default"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  };
  const requestModel = {
    id: modelId,
    baseUrl: input.baseUrl ?? CODEX_FIRST_PARTY_BASE_URL,
  };
  const before = harness.nativeCalls.length;
  (wrapped.streamSimple as (...args: unknown[]) => unknown)(
    requestModel,
    { messages: [] },
    callerOptions,
  );
  const recorded = harness.nativeCalls[before];
  const nativeOptions =
    typeof recorded?.options === "object" && recorded.options !== null
      ? (recorded.options as Record<string, unknown>)
      : undefined;
  const payload: Record<string, unknown> = { model: modelId, input: [] };
  const onPayload = nativeOptions?.onPayload;
  if (typeof onPayload === "function") {
    await (onPayload as (p: unknown, m: unknown) => Promise<unknown>)(
      payload,
      requestModel,
    );
  }
  const fetchImpl = nativeOptions?.fetch;
  if (typeof fetchImpl === "function") {
    const response = await (
      fetchImpl as (u: unknown, i: unknown) => Promise<Response>
    )(`${CODEX_FIRST_PARTY_BASE_URL}/codex/responses`, {
      method: "POST",
      headers: input.requestHeaders ?? { "content-type": "application/json" },
    });
    await drainResponseBody(response);
  }
  return {
    callerOptions,
    nativeOptions,
    sentInit: sentInits.at(-1),
    payload,
  };
}

/**
 * Reads one outgoing header regardless of which shape reached the transport:
 * a mapped attempt hands the fetch a `Headers` object, while a passthrough
 * attempt leaves the caller's own plain record exactly as it was. `null` means
 * the header is absent from either shape.
 */
function headerValue(
  init: Record<string, unknown> | undefined,
  name: string,
): string | null {
  const headers = init?.headers;
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (typeof headers !== "object" || headers === null) {
    return null;
  }
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  return key === undefined ? null : String(record[key]);
}

describe("createPiExtension: codex subscription fast provider", () => {
  function installCodexPrimary(
    host: RecordingFakePiHost,
    harness: CodexSeamHarness,
    extras: {
      readonly fast?: true;
      readonly model?: typeof codexHostModel;
      readonly second?: {
        readonly name: string;
        readonly model: typeof codexHostModel | typeof nonCodexHostModel;
        readonly fast?: true;
      };
      readonly overrides?: Partial<PiExtensionDeps>;
      readonly realProber?: boolean;
    } = {},
  ): PiExtensionInstance {
    const model = extras.model ?? codexHostModel;
    const agents = [
      {
        agentName: "loom",
        source: "explicit" as const,
        descriptor: loomDescriptor({
          name: "loom",
          models: [`${model.provider}/${model.id}`],
          ...(extras.fast === true ? { fast: true as const } : {}),
        }),
      },
    ];
    if (extras.second !== undefined) {
      agents.push({
        agentName: extras.second.name,
        source: "explicit",
        descriptor: tapestryDescriptor({
          name: extras.second.name,
          models: [`${extras.second.model.provider}/${extras.second.model.id}`],
          ...(extras.second.fast === true ? { fast: true as const } : {}),
        }),
      });
    }
    return installExtension(host, "0.81.1", {
      ...(extras.realProber === true
        ? {}
        : { capabilityProber: allOkCapabilityProber() }),
      configActivator: fakeConfigActivator({ agents, errors: [] }),
      codexFastProviderSeam: harness.seam,
      ...extras.overrides,
    });
  }

  function codexHost(models = [codexHostModel]): RecordingFakePiHost {
    return new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: models,
    });
  }

  it("registers one wrapped codex provider for a trusted parent generation", async () => {
    const host = codexHost();
    const harness = codexSeamHarness();
    harness.attachTo(host);
    installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();

    expect(harness.registered).toHaveLength(1);
    const wrapped = harness.wrapped();
    const native = harness.nativeProviders()[0];
    expect(wrapped?.id).toBe(CODEX_PROVIDER_ID);
    expect(wrapped?.name).toBe("OpenAI Codex");
    expect(wrapped?.auth).toBe(native?.auth);
    expect(wrapped?.stream).not.toBe(native?.stream);
    expect(wrapped?.streamSimple).not.toBe(native?.streamSimple);
    // The mapping is a provider override, never a request/header hook.
    expect(host.registeredEventHandlerCount("before_provider_headers")).toBe(0);
    expect(host.registeredEventHandlerCount("before_provider_request")).toBe(0);
    expect(host.registeredEventHandlerCount("after_provider_response")).toBe(0);
  });

  it("registers at most once per process and always wraps a fresh native provider", async () => {
    const host = codexHost();
    const harness = codexSeamHarness();
    harness.attachTo(host);
    installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();
    await host.triggerSessionStart();
    await host.triggerSessionStart();

    expect(harness.registered).toHaveLength(1);
    expect(harness.importCalls()).toBe(1);
    expect(harness.factoryCalls()).toBe(1);
    // A wrapper is never built from an already-registered provider.
    expect(harness.nativeProviders()).toHaveLength(1);
    expect(harness.registered[0]).not.toBe(harness.nativeProviders()[0]);
  });

  it("registers nothing when the host version is below the seam floor", async () => {
    const host = codexHost();
    const harness = codexSeamHarness({ hostVersion: "0.82.9" });
    harness.attachTo(host);
    const extension = installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();

    expect(harness.registered).toHaveLength(0);
    expect(harness.importCalls()).toBe(0);
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
  });

  it("registers nothing when the host exposes no registerProvider", async () => {
    const host = codexHost();
    const harness = codexSeamHarness();
    const extension = installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();

    expect(host.api.registerProvider).toBeUndefined();
    expect(harness.registered).toHaveLength(0);
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
  });

  it("registers nothing in health-only mode", async () => {
    const host = codexHost();
    const harness = codexSeamHarness();
    harness.attachTo(host);
    installCodexPrimary(host, harness, { fast: true, realProber: true });
    await host.triggerSessionStart();

    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toContain("health-only");
    expect(harness.registered).toHaveLength(0);
    expect(harness.importCalls()).toBe(0);
  });

  /**
   * The Task 11 live blocker, in one test.
   *
   * The host package was 0.84.2 — comfortably above the seam floor — while
   * `@earendil-works/pi-ai/providers/openai-codex` still resolved to the
   * checkout's pi-ai 0.81.1, whose codex path ignores `options.fetch`. The
   * wrapper therefore mutated the body to `service_tier: "priority"` and could
   * never write the routing pair. Registration must refuse before the import,
   * so no wrapper exists and no `onPayload` of this adapter's can run.
   */
  it("refuses to register when the provider subpath is not the proven host copy", async () => {
    const host = codexHost();
    const harness = codexSeamHarness({
      hostVersion: CODEX_SUPPORTED_HOST_VERSION,
      providerModuleProvenance: () => ({
        kind: "unproven",
        reason: "no-local-copy",
      }),
    });
    harness.attachTo(host);
    const logger = new RecordingLogger();
    const extension = installCodexPrimary(host, harness, {
      fast: true,
      overrides: { logger },
    });
    await host.triggerSessionStart();

    expect(harness.registered).toHaveLength(0);
    expect(harness.wrapped()).toBeUndefined();
    // Refused before the import: the unproven module is never even loaded,
    // so nothing of this adapter's can reach a request body.
    expect(harness.importCalls()).toBe(0);
    expect(harness.factoryCalls()).toBe(0);
    expect(harness.provenanceCalls()).toBe(1);
    const degradations = logger.entries.filter(
      (entry) => entry.obj.reason === "provider-module-unproven",
    );
    expect(degradations).toHaveLength(1);
    expect(degradations[0]?.obj.provenance).toBe("no-local-copy");
    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain("@earendil-works/pi-ai");
    expect(serialized).not.toContain("/node_modules/");
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
  });

  it.each([
    [
      "a bare-package-only proof, which says nothing about the subpath",
      (): PiHostModuleProvenance => ({
        kind: "unproven",
        reason: "specifier-unknown",
      }),
      "specifier-unknown",
    ],
    [
      "a disabled redirect",
      (): PiHostModuleProvenance => ({
        kind: "unproven",
        reason: "redirect-disabled",
      }),
      "redirect-disabled",
    ],
    [
      "a plugin that could not install the override",
      (): PiHostModuleProvenance => ({
        kind: "unproven",
        reason: "plugin-unavailable",
      }),
      "plugin-unavailable",
    ],
    [
      "no recorded host-module outcome at all",
      (): PiHostModuleProvenance => ({
        kind: "unproven",
        reason: "outcome-missing",
      }),
      "outcome-missing",
    ],
    [
      "a probe that throws",
      (): PiHostModuleProvenance => {
        throw new Error(CODEX_IMPORT_SECRET);
      },
      "outcome-missing",
    ],
  ] as const)("registers nothing for %s", async (_label, provenance, expectedToken) => {
    const host = codexHost();
    const harness = codexSeamHarness({
      providerModuleProvenance: provenance,
    });
    harness.attachTo(host);
    const logger = new RecordingLogger();
    installCodexPrimary(host, harness, { fast: true, overrides: { logger } });
    await host.triggerSessionStart();

    expect(harness.registered).toHaveLength(0);
    expect(harness.importCalls()).toBe(0);
    const degradations = logger.entries.filter(
      (entry) => entry.obj.reason === "provider-module-unproven",
    );
    expect(degradations).toHaveLength(1);
    expect(degradations[0]?.obj.provenance).toBe(expectedToken);
    expect(JSON.stringify(logger.entries)).not.toContain(CODEX_IMPORT_SECRET);
  });

  /**
   * The probe's declared return type is a promise, not a proof.
   *
   * `readProviderModuleProvenance` is injected — by `extension-impl`, by a
   * test, and in principle by anything else holding the seam — and its answer
   * becomes the `provenance` field of a bounded failure the caller logs
   * verbatim. So the seam re-checks every answer against the loader's closed
   * reason enum: an unknown string, a secret- or path-shaped string, a
   * non-string, an accessor, a throwing trap, and a malformed `host` verdict
   * all collapse to one of this module's own tokens, and nothing of the
   * caller's text is ever carried through.
   */
  it.each([
    [
      "an invented reason token",
      (): unknown => ({ kind: "unproven", reason: "totally-made-up-reason" }),
      "outcome-missing",
    ],
    [
      "a secret-shaped reason",
      (): unknown => ({ kind: "unproven", reason: CODEX_PROVENANCE_SECRET }),
      "outcome-missing",
    ],
    [
      "a path-shaped reason",
      (): unknown => ({
        kind: "unproven",
        reason: CODEX_PROVENANCE_SECRET_PATH,
      }),
      "outcome-missing",
    ],
    [
      "a reason that is an object with a hostile `toString`",
      (): unknown => ({
        kind: "unproven",
        reason: {
          toString: () => CODEX_PROVENANCE_SECRET,
        },
      }),
      "outcome-missing",
    ],
    [
      "a reason that is not a string at all",
      (): unknown => ({ kind: "unproven", reason: 42 }),
      "outcome-missing",
    ],
    [
      "a reason behind a getter that leaks on read",
      (): unknown => {
        const verdict = { kind: "unproven" };
        Object.defineProperty(verdict, "reason", {
          enumerable: true,
          get: () => CODEX_PROVENANCE_SECRET,
        });
        return verdict;
      },
      "outcome-missing",
    ],
    [
      "a reason behind a getter that throws",
      (): unknown => {
        const verdict = { kind: "unproven" };
        Object.defineProperty(verdict, "reason", {
          enumerable: true,
          get: () => {
            throw new Error(CODEX_PROVENANCE_SECRET);
          },
        });
        return verdict;
      },
      "outcome-missing",
    ],
    [
      "a reason inherited from a prototype rather than stated as data",
      (): unknown =>
        Object.create({ kind: "unproven", reason: "no-local-copy" }) as object,
      "outcome-missing",
    ],
    [
      "a proxy whose traps throw",
      (): unknown =>
        new Proxy(
          { kind: "unproven", reason: "no-local-copy" },
          {
            getOwnPropertyDescriptor: () => {
              throw new Error(CODEX_PROVENANCE_SECRET);
            },
            get: () => {
              throw new Error(CODEX_PROVENANCE_SECRET);
            },
          },
        ),
      "outcome-missing",
    ],
    [
      "a bare string where a verdict belongs",
      (): unknown => CODEX_PROVENANCE_SECRET,
      "outcome-missing",
    ],
    ["a null verdict", (): unknown => null, "outcome-missing"],
    ["an undefined verdict", (): unknown => undefined, "outcome-missing"],
    [
      "a `host` verdict whose outcome is the caller's own string",
      (): unknown => ({ kind: "host", outcome: CODEX_PROVENANCE_SECRET }),
      "specifier-unknown",
    ],
    [
      "a `host` verdict whose outcome hides behind a getter",
      (): unknown => {
        const verdict = { kind: "host" };
        Object.defineProperty(verdict, "outcome", {
          enumerable: true,
          get: () => "redirected",
        });
        return verdict;
      },
      "specifier-unknown",
    ],
    [
      "a `kind` that hides behind a getter claiming the host copy",
      (): unknown => {
        const verdict = { outcome: "redirected", reason: "no-local-copy" };
        Object.defineProperty(verdict, "kind", {
          enumerable: true,
          get: () => "host",
        });
        return verdict;
      },
      "no-local-copy",
    ],
  ] as const)("bounds the logged provenance token for %s", async (_label, verdict, expectedToken) => {
    const host = codexHost();
    const harness = codexSeamHarness({
      providerModuleProvenance:
        verdict as unknown as () => PiHostModuleProvenance,
    });
    harness.attachTo(host);
    const logger = new RecordingLogger();
    const extension = installCodexPrimary(host, harness, {
      fast: true,
      overrides: { logger },
    });
    await host.triggerSessionStart();

    expect(harness.registered).toHaveLength(0);
    expect(harness.wrapped()).toBeUndefined();
    expect(harness.importCalls()).toBe(0);
    expect(harness.factoryCalls()).toBe(0);
    const degradations = logger.entries.filter(
      (entry) => entry.obj.reason === "provider-module-unproven",
    );
    expect(degradations).toHaveLength(1);
    expect(degradations[0]?.obj.provenance).toBe(expectedToken);
    // The token is a member of the loader's closed enum, so a consumer may
    // render it as-is.
    expect(CODEX_FAST_PROVENANCE_REASON_TOKENS).toContain(
      degradations[0]?.obj.provenance,
    );
    const serialized = JSON.stringify([
      logger.entries,
      host.statusCalls,
      extension.providerFastLatestForTest(),
    ]);
    expect(serialized).not.toContain(CODEX_PROVENANCE_SECRET);
    expect(serialized).not.toContain("totally-made-up-reason");
    expect(serialized).not.toContain("/node_modules/");
    expect(serialized).not.toContain("@earendil-works/pi-ai");
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
  });

  it("registers when the subpath is already the host copy, with no redirect", async () => {
    const host = codexHost();
    const harness = codexSeamHarness({
      providerModuleProvenance: () => ({
        kind: "host",
        outcome: "already-host",
      }),
    });
    harness.attachTo(host);
    installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();

    expect(harness.registered).toHaveLength(1);
    expect(harness.wrapped()?.id).toBe(CODEX_PROVIDER_ID);
  });

  it("checks provenance even when the host version passes", async () => {
    const host = codexHost();
    const harness = codexSeamHarness({ hostVersion: "0.82.9" });
    harness.attachTo(host);
    installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();

    // Version is the first gate, so an unsupported host stops before the
    // provenance probe and the reported token stays the version one.
    expect(harness.provenanceCalls()).toBe(0);
  });

  it.each([
    [
      "a rejecting import",
      () =>
        codexSeamHarness({
          importProviderModule: () =>
            Promise.reject(new Error(CODEX_IMPORT_SECRET)),
        }),
      "provider-module-unavailable",
    ],
    [
      "a namespace without the factory",
      () => codexSeamHarness({ moduleNamespace: { other: () => undefined } }),
      "provider-factory-unavailable",
    ],
    [
      "a factory returning a foreign provider",
      () =>
        codexSeamHarness({
          moduleNamespace: {
            openaiCodexProvider: () => ({
              id: "openai",
              stream: () => undefined,
              streamSimple: () => undefined,
            }),
          },
        }),
      "provider-identity-unexpected",
    ],
    [
      "a provider the wrapper cannot copy",
      () =>
        codexSeamHarness({
          moduleNamespace: {
            openaiCodexProvider: () =>
              new Proxy(
                {
                  id: CODEX_PROVIDER_ID,
                  stream: () => undefined,
                  streamSimple: () => undefined,
                },
                {
                  ownKeys: () => {
                    throw new Error("hostile provider");
                  },
                },
              ),
          },
        }),
      "provider-not-wrappable",
    ],
  ] as const)("degrades to native behavior on %s, reporting one bounded token", async (_label, buildHarness, reason) => {
    const host = codexHost();
    const harness = buildHarness();
    harness.attachTo(host);
    const logger = new RecordingLogger();
    const extension = installCodexPrimary(host, harness, {
      fast: true,
      overrides: { logger },
    });
    await host.triggerSessionStart();

    expect(harness.registered).toHaveLength(0);
    const degradations = logger.entries.filter(
      (entry) => entry.obj.reason === reason,
    );
    expect(degradations).toHaveLength(1);
    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain(CODEX_IMPORT_SECRET);
    expect(serialized).not.toContain("@earendil-works/pi-ai");
    // Startup is unaffected: the generation still becomes ready.
    expect(
      host.statusCalls.filter((call) => call.key === "weave").at(-1)?.value,
    ).toBe("ready");
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
  });

  it("maps an eligible parent call and reports requested, then not-confirmed", async () => {
    const host = codexHost();
    const harness = codexSeamHarness();
    harness.attachTo(host);
    const extension = installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();

    const call = await runCodexProviderCall(harness);
    expect(call.nativeOptions).not.toBe(call.callerOptions);
    expect(call.nativeOptions?.transport).toBe("sse");
    expect(call.payload.service_tier).toBe("priority");
    expect(headerValue(call.sentInit, "originator")).toBe("codex_cli_rs");
    expect(headerValue(call.sentInit, "x-codex-routing-hint")).toBe(
      `model=${CODEX_ELIGIBLE_MODEL_ID};tier=priority`,
    );

    expect(extension.providerFastLatestForTest()).toEqual({
      state: "not-confirmed",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "standard",
      reason: "none",
      ruleId: CODEX_ELIGIBLE_RULE_ID,
    });
    await host.invokeCommand("weave:status");
    const message = host.notifyCalls.at(-1)?.message ?? "";
    expect(message).toContain(
      `fast: not-confirmed (${CODEX_ELIGIBLE_RULE_ID}, openai-service-tier=standard)`,
    );
    expect(message).not.toContain(CODEX_SUBSCRIPTION_TOKEN);
    expect(message).not.toContain(CODEX_ELIGIBLE_MODEL_ID);
    expect(message).not.toContain(CODEX_FIRST_PARTY_BASE_URL);
  });

  it("reports applied only from same-attempt confirmed evidence", async () => {
    const host = codexHost();
    const harness = codexSeamHarness();
    harness.attachTo(host);
    const extension = installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();

    await runCodexProviderCall(harness, { serviceTier: "priority" });
    expect(extension.providerFastLatestForTest()).toEqual({
      state: "applied",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "confirmed",
      reason: "none",
      ruleId: CODEX_ELIGIBLE_RULE_ID,
    });
    await host.invokeCommand("weave:status");
    expect(host.notifyCalls.at(-1)?.message ?? "").toContain("fast: applied");
  });

  it("reads intent fresh per call, so a primary switch changes the very next one", async () => {
    const host = codexHost([codexHostModel, nonCodexHostModel]);
    const harness = codexSeamHarness();
    harness.attachTo(host);
    installCodexPrimary(host, harness, {
      fast: true,
      second: { name: "tapestry", model: nonCodexHostModel },
    });
    await host.triggerSessionStart();

    const mapped = await runCodexProviderCall(harness);
    expect(mapped.nativeOptions).not.toBe(mapped.callerOptions);

    await host.invokeShortcut("alt+a");
    const passthrough = await runCodexProviderCall(harness);
    // Referential identity: the native implementation received the caller's
    // own options object, so nothing was added, forced, or observed.
    expect(passthrough.nativeOptions).toBe(passthrough.callerOptions);
    expect(passthrough.payload.service_tier).toBeUndefined();
    expect(headerValue(passthrough.sentInit, "originator")).toBeNull();
  });

  it("leaves an ineligible gateway transport untouched and reports the bounded reason", async () => {
    const host = codexHost();
    const harness = codexSeamHarness();
    harness.attachTo(host);
    const extension = installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();

    const call = await runCodexProviderCall(harness, {
      baseUrl: "http://127.0.0.1:17399/backend-api",
    });
    expect(call.nativeOptions).toBe(call.callerOptions);
    expect(call.payload.service_tier).toBeUndefined();
    expect(extension.providerFastLatestForTest()).toEqual({
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "absent",
      reason: "transport-not-first-party",
    });
  });

  it("journals each distinct mapped outcome once and survives a failing write", async () => {
    const journalEntries: unknown[] = [];
    const host = codexHost();
    const harness = codexSeamHarness();
    harness.attachTo(host);
    installCodexPrimary(host, harness, {
      fast: true,
      overrides: {
        runtimeStoreFactory: {
          open: () => okAsync(createInMemoryRuntimeStore()),
        },
        telemetryJournal: {
          write: (entry) => {
            journalEntries.push(entry);
            return okAsync(undefined);
          },
        },
        telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
      },
    });
    await host.triggerSessionStart();
    await runCodexProviderCall(harness);
    await runCodexProviderCall(harness);
    await flushBackgroundWork();

    const events = journalEntries
      .map((entry) =>
        typeof entry === "object" && entry !== null && "eventType" in entry
          ? String((entry as { eventType?: unknown }).eventType)
          : "",
      )
      .filter((eventType) => eventType.startsWith("provider-fast."));
    expect(events).toEqual([
      "provider-fast.requested",
      "provider-fast.not-confirmed",
    ]);
    const serialized = JSON.stringify(journalEntries);
    expect(serialized).not.toContain(CODEX_SUBSCRIPTION_TOKEN);
    expect(serialized).not.toContain(CODEX_ELIGIBLE_MODEL_ID);
    expect(serialized).not.toContain(CODEX_FIRST_PARTY_BASE_URL);
  });

  it("keeps serving provider calls when the journal write fails", async () => {
    const host = codexHost();
    const harness = codexSeamHarness();
    harness.attachTo(host);
    const extension = installCodexPrimary(host, harness, {
      fast: true,
      overrides: {
        runtimeStoreFactory: {
          open: () => okAsync(createInMemoryRuntimeStore()),
        },
        telemetryJournal: {
          write: () =>
            errAsync({
              type: "journal_write",
              message: CODEX_IMPORT_SECRET,
            } as RuntimeStoreError),
        },
        telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
      },
    });
    await host.triggerSessionStart();
    const call = await runCodexProviderCall(harness);
    await flushBackgroundWork();

    expect(call.payload.service_tier).toBe("priority");
    expect(extension.providerFastLatestForTest()?.state).toBe("not-confirmed");
    expect(JSON.stringify(host.notifyCalls)).not.toContain(CODEX_IMPORT_SECRET);
  });

  it("drops the latest mapped state when the session is replaced", async () => {
    const host = codexHost();
    const harness = codexSeamHarness();
    harness.attachTo(host);
    const extension = installCodexPrimary(host, harness, { fast: true });
    await host.triggerSessionStart();
    await runCodexProviderCall(harness);
    expect(extension.providerFastLatestForTest()?.state).toBe("not-confirmed");

    await host.triggerSessionStart();
    expectSanitizedProviderFast(
      extension.providerFastLatestForTest(),
      UNSUPPORTED_FAST_SNAPSHOT,
    );
  });
});

describe("createPiExtension: codex subscription fast provider in child mode", () => {
  class CodexChildEnvPort implements PiEnvPort {
    constructor(private readonly values: Map<string, string>) {}
    read(name: string): string | undefined {
      return this.values.get(name);
    }
    deleteValue(name: string): void {
      this.values.delete(name);
    }
  }

  class CodexChildOutputPort {
    readonly lines: Record<string, unknown>[] = [];
    writeLine(bytes: Uint8Array): ResultAsync<void, never> {
      for (const line of new TextDecoder().decode(bytes).split("\n")) {
        if (line.length > 0) {
          this.lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
      return okAsync(undefined);
    }
  }

  class CodexChildTimerPort {
    schedule(): { cancel: () => void } {
      return { cancel: () => undefined };
    }
  }

  /**
   * Boots this extension as a private RPC child: the bootstrap secret arrives
   * only through the environment, exactly as a real spawned child receives it.
   */
  async function bootCodexChild(
    harness: CodexSeamHarness,
    options: {
      readonly overrides?: Partial<PiExtensionDeps>;
      readonly withoutChildId?: boolean;
    } = {},
  ): Promise<{
    readonly host: RecordingFakePiHost;
    readonly extension: PiExtensionInstance;
    readonly secretBytes: Uint8Array;
    readonly applyBootstrap: (body: Record<string, unknown>) => Promise<void>;
  }> {
    const randomPort = new WebCryptoRandomPort();
    const hmacPort = new WebCryptoHmacPort();
    const secretBytes = randomPort.randomBytes(32);
    const host = new RecordingFakePiHost({
      mode: "rpc",
      trusted: true,
      availableModels: [codexHostModel],
    });
    harness.attachTo(host);
    const extension = createPiExtension({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: allOkCapabilityProber(),
      idGenerator: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger: new RecordingLogger(),
      configActivator: fakeConfigActivator(),
      pathContainmentPort: new FakePathContainmentPort(
        new Map(),
        ok("/fake/project"),
      ),
      threadSourceFactory: undefined,
      hostSurfaceReader: hostSurfaceReader(),
      sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      codexFastProviderSeam: harness.seam,
      envPort: new CodexChildEnvPort(
        new Map([
          [WEAVE_CHILD_SECRET_ENV, bytesToHex(secretBytes)],
          ...(options.withoutChildId === true
            ? []
            : ([[WEAVE_CHILD_ID_ENV, "child-codex-1"]] as [string, string][])),
          [WEAVE_CONTROLLER_GENERATION_ENV, "gen-codex-1"],
        ]),
      ),
      randomPort,
      hmacPort,
      processPort: new FakeChildProcessPort(),
      childOutputPort: new CodexChildOutputPort(),
      childTimerPort: new CodexChildTimerPort(),
      ...options.overrides,
    });
    extension(host.api);
    await host.triggerSessionStart();

    let sequence = 1;
    const applyBootstrap = async (
      body: Record<string, unknown>,
    ): Promise<void> => {
      const envelope = await signEnvelope(
        {
          childId: "child-codex-1",
          generationId: "gen-codex-1",
          direction: "parent-to-child",
          sequence: sequence++,
          nonce: generateNonceHex(randomPort),
          correlationId: "child-codex-1",
          kind: "bootstrap",
          body: body as unknown as JsonValue,
        },
        secretBytes,
        hmacPort,
      );
      if (envelope.isErr()) {
        throw new Error(`test setup failed to sign: ${envelope.error.type}`);
      }
      await host.invokeCommand(
        "weave:__control__",
        JSON.stringify(envelope.value),
      );
      await flushBackgroundWork();
    };

    return { host, extension, secretBytes, applyBootstrap };
  }

  function childBootstrapBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      mode: "ordinary",
      agentName: "shuttle",
      composedPrompt: "You are Shuttle, a delegated specialist.",
      models: [`${codexHostModel.provider}/${codexHostModel.id}`],
      correlationId: "child-codex-1",
      context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
      resolvedModel: {
        provider: codexHostModel.provider,
        id: codexHostModel.id,
      },
      ...overrides,
    };
  }

  it("registers the wrapped provider in an authenticated child process", async () => {
    const harness = codexSeamHarness();
    await bootCodexChild(harness);

    expect(harness.registered).toHaveLength(1);
    expect(harness.wrapped()?.id).toBe(CODEX_PROVIDER_ID);
  });

  it("registers nothing when the child handshake never authenticated", async () => {
    const harness = codexSeamHarness();
    // A child whose bootstrap environment is incomplete never activates, so
    // the process has no authenticated owner and overrides no provider.
    await bootCodexChild(harness, { withoutChildId: true });

    expect(harness.registered).toHaveLength(0);
    expect(harness.importCalls()).toBe(0);
  });

  it("never activates fast mode before the authenticated bootstrap applies", async () => {
    const harness = codexSeamHarness();
    const { extension, applyBootstrap } = await bootCodexChild(harness);

    // Pending bootstrap: the child owns no intent at all.
    const pending = await runCodexProviderCall(harness);
    expect(pending.nativeOptions).toBe(pending.callerOptions);
    expect(pending.payload.service_tier).toBeUndefined();
    expect(headerValue(pending.sentInit, "originator")).toBeNull();
    expect(extension.providerFastLatestForTest()).toBeUndefined();

    await applyBootstrap(childBootstrapBody({ fast: true }));

    const mapped = await runCodexProviderCall(harness);
    expect(mapped.nativeOptions).not.toBe(mapped.callerOptions);
    expect(mapped.payload.service_tier).toBe("priority");
    expect(headerValue(mapped.sentInit, "x-codex-routing-hint")).toBe(
      `model=${CODEX_ELIGIBLE_MODEL_ID};tier=priority`,
    );
    expect(extension.providerFastLatestForTest()).toEqual({
      state: "not-confirmed",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "standard",
      reason: "none",
      ruleId: CODEX_ELIGIBLE_RULE_ID,
    });
  });

  it("leaves a bootstrapped child without fast intent completely untouched", async () => {
    const harness = codexSeamHarness();
    const { extension, applyBootstrap } = await bootCodexChild(harness);
    await applyBootstrap(childBootstrapBody());

    const call = await runCodexProviderCall(harness);
    expect(call.nativeOptions).toBe(call.callerOptions);
    expect(call.payload.service_tier).toBeUndefined();
    expect(extension.providerFastLatestForTest()).toBeUndefined();
  });

  it("registers and activates for a direct-step child the same way", async () => {
    const harness = codexSeamHarness();
    const { extension, applyBootstrap } = await bootCodexChild(harness);
    expect(harness.registered).toHaveLength(1);

    await applyBootstrap(
      childBootstrapBody({
        mode: "direct-step",
        fast: true,
        workflowInstanceId: "wf-1",
        leaseId: "lease-1",
        stepName: "implement",
        completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
      }),
    );

    const mapped = await runCodexProviderCall(harness);
    expect(mapped.payload.service_tier).toBe("priority");
    expect(headerValue(mapped.sentInit, "originator")).toBe("codex_cli_rs");
    expect(extension.providerFastLatestForTest()?.state).toBe("not-confirmed");
  });
});

describe("createPiExtension: primary model fallback C4a", () => {
  const loomOrigin = {
    provider: "anthropic",
    id: "loom-origin",
    name: "Loom origin",
  };
  const loomFallback = {
    provider: "openai",
    id: "loom-fallback",
    name: "Loom fallback",
  };
  const tapestryOrigin = {
    provider: "google",
    id: "tapestry-origin",
    name: "Tapestry origin",
  };
  const tapestryFallback = {
    provider: "mistral",
    id: "tapestry-fallback",
    name: "Tapestry fallback",
  };
  const manualModel = {
    provider: "manual",
    id: "user-selected",
    name: "User selected",
  };

  function modelFallbackOverrides(
    journalEntries: unknown[],
  ): Partial<PiExtensionDeps> {
    return {
      hostSurfaceReader: hostSurfaceReader(),
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      telemetryJournal: {
        write: (entry) => {
          journalEntries.push(entry);
          return okAsync(undefined);
        },
      },
      telemetryLogFileSystem: new MemoryRuntimeLogFileSystem(),
    };
  }

  function installModelFallbackExtension(
    host: RecordingFakePiHost,
    journalEntries: unknown[],
  ): PiExtensionInstance {
    return installExtension(host, "0.81.1", {
      ...modelFallbackOverrides(journalEntries),
      capabilityProber: allOkCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [
          {
            agentName: "loom",
            source: "explicit",
            descriptor: loomDescriptor({
              fast: true,
              models: [
                `${loomOrigin.provider}/${loomOrigin.id}`,
                `${loomFallback.provider}/${loomFallback.id}`,
              ],
            }),
          },
          {
            agentName: "tapestry",
            source: "explicit",
            descriptor: tapestryDescriptor({
              models: [
                `${tapestryOrigin.provider}/${tapestryOrigin.id}`,
                `${tapestryFallback.provider}/${tapestryFallback.id}`,
              ],
            }),
          },
        ],
        errors: [],
      }),
    });
  }

  function failureEvent(id: string): {
    readonly type: "message_end";
    readonly message: Record<string, unknown>;
  } {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        id,
        stopReason: "error",
        status: 503,
        content: [{ type: "text", text: "bounded provider failure" }],
      },
    };
  }

  function modelFallbackRecords(
    entries: readonly unknown[],
  ): Record<string, unknown>[] {
    return entries.flatMap((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("eventType" in entry) ||
        ((entry as { readonly eventType?: unknown }).eventType !==
          "model-fallback.applied" &&
          (entry as { readonly eventType?: unknown }).eventType !==
            "model-fallback.recovery-confirmed" &&
          (entry as { readonly eventType?: unknown }).eventType !==
            "model-fallback.failed")
      ) {
        return [];
      }
      const data = (entry as { readonly data?: unknown }).data;
      return typeof data === "object" && data !== null
        ? [data as Record<string, unknown>]
        : [];
    });
  }

  async function applyFallbackCandidate(
    host: RecordingFakePiHost,
    expected: typeof loomFallback | typeof tapestryFallback,
    failureId: string,
  ): Promise<void> {
    const deferred = host.deferNextSetModel();
    await host.triggerEvent("message_end", failureEvent(failureId));
    await flushBackgroundWork();
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await deferred.called;
    expect(host.setModelCalls.at(-1)).toBe(expected);

    // Prove the two facts in the conservative order used by the host: the
    // application result arrives first, then the expected native model event.
    deferred.settle(true);
    await flushBackgroundWork();
    expect(host.sendMessageCalls).toHaveLength(0);
    await host.triggerModelSelect(expected, "set");
    await flushBackgroundWork();
    await flushBackgroundWork();
  }

  it("latches an unmatched model selection, keeps the latch across a user turn, and re-arms only on explicit Weave activation", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [
        loomOrigin,
        loomFallback,
        tapestryOrigin,
        tapestryFallback,
        manualModel,
      ],
    });
    installModelFallbackExtension(host, journalEntries);
    await host.triggerSessionStart();
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · LOOM");

    // `source` is not an ownership proof. This unmatched native selection is
    // therefore a conservative manual override of automatic fallback.
    await host.triggerModelSelect(manualModel, "set");
    await host.triggerBeforeAgentStart({ systemPrompt: "ordinary user turn" });
    await host.triggerEvent(
      "message_end",
      failureEvent("manual-latch-failure"),
    );
    await flushBackgroundWork();
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await flushBackgroundWork();
    expect(host.setModelCalls).toEqual([loomOrigin]);

    // Alt+A is an explicit Weave activation. It replaces the frozen scope with
    // Tapestry's ordered candidates rather than clearing the latch for an
    // ordinary turn or reusing Loom's candidates.
    host.poisonSendMessage();
    await host.invokeShortcut("alt+a");
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · TAPESTRY");
    expect(host.setModelCalls).toEqual([loomOrigin, tapestryOrigin]);

    await applyFallbackCandidate(host, tapestryFallback, "rearmed-failure");
    expect(host.setModelCalls).toEqual([
      loomOrigin,
      tapestryOrigin,
      tapestryFallback,
    ]);
    expect(host.getCurrentModel()).toBe(tapestryFallback);
  });

  it("keeps applied model and recomputed provider-fast truth after marker dispatch fails", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [loomOrigin, loomFallback],
    });
    const extension = installModelFallbackExtension(host, journalEntries);
    await host.triggerSessionStart();
    host.poisonSendMessage();

    await applyFallbackCandidate(host, loomFallback, "marker-failure");
    await flushBackgroundWork();

    expect(host.getCurrentModel()).toBe(loomFallback);
    expect(shownAgentBadge(host)).toBe("◆ WEAVE · LOOM");
    expect(extension.providerFastLatestForTest()).toEqual(
      UNSUPPORTED_FAST_SNAPSHOT,
    );
    const records = modelFallbackRecords(journalEntries);
    expect(records).toContainEqual(
      expect.objectContaining({
        outcome: "applied",
        fromProvider: loomOrigin.provider,
        fromId: loomOrigin.id,
        toProvider: loomFallback.provider,
        toId: loomFallback.id,
      }),
    );
    expect(
      records.some((record) => record.outcome === "recovery-confirmed"),
    ).toBe(false);
    expect(
      host.appendedEntries.filter(
        (entry) => entry.type === "weave.model-failover",
      ),
    ).toHaveLength(0);
  });

  it("keeps applied model and recomputed provider-fast truth after context admission fails", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [loomOrigin, loomFallback],
    });
    const extension = installModelFallbackExtension(host, journalEntries);
    await host.triggerSessionStart();

    await applyFallbackCandidate(host, loomFallback, "context-failure");
    const marker = host.sendMessageCalls.at(-1)?.message;
    expect(marker).toMatchObject({
      customType: "weave.model-fallback.recovery-marker",
    });
    await host.triggerEvent("message_start", {
      type: "message_start",
      message: marker,
    });

    // The marker dispatch was proven, but this provider context does not carry
    // the exact failed assistant/marker pair. Admission fails closed without
    // changing the model that Pi already applied.
    await host.triggerEvent("context", [
      { role: "user", content: "unrelated context" },
    ]);
    await flushBackgroundWork();

    expect(host.getCurrentModel()).toBe(loomFallback);
    expect(extension.providerFastLatestForTest()).toEqual(
      UNSUPPORTED_FAST_SNAPSHOT,
    );
    const records = modelFallbackRecords(journalEntries);
    expect(records).toContainEqual(
      expect.objectContaining({
        outcome: "applied",
        toProvider: loomFallback.provider,
        toId: loomFallback.id,
      }),
    );
    expect(
      records.some((record) => record.outcome === "recovery-confirmed"),
    ).toBe(false);
    expect(
      host.appendedEntries.filter(
        (entry) => entry.type === "weave.model-failover",
      ),
    ).toHaveLength(0);
  });

  it("registers the primary model-fallback renderer exactly once", () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [loomOrigin, loomFallback],
    });
    const registrations: string[] = [];
    Object.assign(host.api, {
      registerEntryRenderer: (customType: string) => {
        registrations.push(customType);
      },
    });

    const extension = installModelFallbackExtension(host, []);
    // Pi invokes one compiled extension instance once in normal operation;
    // invoke it a second time here to prove the registration guard is local to
    // the instance rather than a duplicate host callback.
    extension(host.api);

    expect(registrations).toEqual(["weave.model-failover"]);
  });

  it("completes one primary fallback lifecycle with one deferred settlement (C4b)", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [loomOrigin, loomFallback],
    });
    installModelFallbackExtension(host, journalEntries);

    const bootContext = await host.triggerSessionStart();
    const nativeSessionId = bootContext.sessionManager?.getSessionId();
    const setModelCallsAtBoot = host.setModelCalls.length;
    expect(nativeSessionId).toBe("fake-session-1");
    expect(host.beforeAgentStartCalls).toBe(0);

    // The failed assistant is observed first. The payloadless settlement is
    // deferred until the coordinator proves the fallback model application.
    const failedEvent = failureEvent("c4b-failed-assistant");
    const failedAssistant = failedEvent.message;
    const deferred = host.deferNextSetModel();
    await host.triggerEvent("message_end", failedEvent);
    await flushBackgroundWork();
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await deferred.called;

    expect(host.setModelCalls).toHaveLength(setModelCallsAtBoot + 1);
    expect(host.setModelCalls.at(-1)).toBe(loomFallback);
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(
      journalEntries.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "eventType" in entry &&
          String((entry as { readonly eventType?: unknown }).eventType) ===
            "provider-fast.unsupported",
      ),
    ).toBe(false);

    // Apply proof arrives before the expected native model_select proof. The
    // marker is not dispatched until both facts are true.
    deferred.settle(true);
    await flushBackgroundWork();
    expect(host.sendMessageCalls).toHaveLength(0);
    await host.triggerModelSelect(loomFallback, "set");
    await flushBackgroundWork();
    await flushBackgroundWork();

    expect(host.setModelCalls).toHaveLength(setModelCallsAtBoot + 1);
    expect(host.getCurrentModel()).toBe(loomFallback);
    expect(host.sendMessageCalls).toHaveLength(1);
    const markerRecord = host.sendMessageCalls[0];
    expect(markerRecord?.options).toEqual({ triggerTurn: true });
    const marker = markerRecord?.message;
    expect(marker).toMatchObject({
      role: "custom",
      customType: "weave.model-fallback.recovery-marker",
      display: false,
    });
    if (marker === undefined) throw new Error("fallback marker was not sent");

    // Pi's context event is replacement-returning. A later trusted context
    // handler must receive Weave's filtered list. This proves trusted
    // composition, not hostile-extension isolation.
    await host.triggerEvent("message_start", {
      type: "message_start",
      message: marker,
    });
    const userMessage = { role: "user", content: "keep this durable input" };
    const successfulAssistant = {
      role: "assistant",
      id: "c4b-successful-assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "fallback answer" }],
    };
    const durableInput = [
      userMessage,
      failedAssistant,
      marker,
      successfulAssistant,
    ];
    const durableInputSnapshot = [...durableInput];
    const trustedContextInputs: Array<readonly unknown[]> = [];
    host.api.on("context", (messages) => {
      trustedContextInputs.push(messages as readonly unknown[]);
      return undefined;
    });
    host.appendDurableHistory(userMessage);
    host.appendDurableHistory(failedAssistant);
    host.appendSentMessageToDurableHistory();
    const repairedContext = await host.triggerContext(
      durableInput,
      host.createSessionContext(),
    );
    expect(repairedContext).toEqual([userMessage, successfulAssistant]);
    expect(repairedContext).not.toContain(failedAssistant);
    expect(repairedContext).not.toContain(marker);
    expect(repairedContext).toContain(successfulAssistant);
    expect(trustedContextInputs).toEqual([[userMessage, successfulAssistant]]);
    expect(durableInput).toEqual(durableInputSnapshot);
    expect(durableInput).toHaveLength(4);
    host.captureProviderConversion(repairedContext);
    expect(host.providerConversions).toEqual([
      {
        durableHistory: [userMessage, failedAssistant, marker],
        providerMessages: [userMessage, successfulAssistant],
      },
    ]);
    await flushBackgroundWork();

    // The recovery run has its own successful assistant message, but it does
    // not need a before_agent_start event or a new native session/process.
    await host.triggerEvent("agent_start", { type: "agent_start" });
    await host.triggerEvent("message_end", {
      type: "message_end",
      message: successfulAssistant,
    });
    host.appendDurableHistory(successfulAssistant);
    await flushBackgroundWork();
    const modelFallbackEventTypesBeforeFinalSettlement = journalEntries
      .map((entry) =>
        typeof entry === "object" && entry !== null && "eventType" in entry
          ? String((entry as { readonly eventType?: unknown }).eventType)
          : "",
      )
      .filter((eventType) => eventType.startsWith("model-fallback."));
    expect(modelFallbackEventTypesBeforeFinalSettlement).not.toContain(
      "model-fallback.success",
    );

    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await flushBackgroundWork();
    await flushBackgroundWork();

    const modelFallbackEventTypes = journalEntries
      .map((entry) =>
        typeof entry === "object" && entry !== null && "eventType" in entry
          ? String((entry as { readonly eventType?: unknown }).eventType)
          : "",
      )
      .filter((eventType) => eventType.startsWith("model-fallback."));
    expect(modelFallbackEventTypes).toEqual([
      "model-fallback.applied",
      "model-fallback.recovery-confirmed",
      "model-fallback.success",
    ]);
    expect(
      modelFallbackEventTypes.filter(
        (eventType) => eventType === "model-fallback.success",
      ),
    ).toHaveLength(1);

    const providerFastEventTypes = journalEntries
      .map((entry) =>
        typeof entry === "object" && entry !== null && "eventType" in entry
          ? String((entry as { readonly eventType?: unknown }).eventType)
          : "",
      )
      .filter((eventType) => eventType.startsWith("provider-fast."));
    expect(providerFastEventTypes).toEqual(["provider-fast.unsupported"]);

    // One fallback switch occurred in the original primary session. The
    // marker used sendMessage, not a user turn, and Weave never concatenated
    // the failed partial assistant with the successful fallback assistant.
    expect(host.setModelCalls).toHaveLength(setModelCallsAtBoot + 1);
    expect(host.getCurrentModel()).toBe(loomFallback);
    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.generatedTurnCount).toBe(0);
    const fallbackEntries = host.appendedEntries.filter(
      (entry) => entry.type === "weave.model-failover",
    );
    expect(fallbackEntries).toHaveLength(1);
    expect(fallbackEntries[0]?.data).toMatchObject({
      schemaVersion: 1,
      transitionId: expect.any(String),
      from: { provider: loomOrigin.provider, id: loomOrigin.id },
      to: { provider: loomFallback.provider, id: loomFallback.id },
    });
    expect(JSON.stringify(fallbackEntries)).not.toContain("fallback answer");
    expect(JSON.stringify(fallbackEntries)).not.toContain(
      "bounded provider failure",
    );
    expect(host.durableHistory).toEqual([
      userMessage,
      failedAssistant,
      marker,
      successfulAssistant,
    ]);
    expect(host.durableHistory).toContain(failedAssistant);
    expect(host.durableHistory).toContain(marker);
    expect(host.durableHistory.at(-1)).toBe(successfulAssistant);
    expect(host.beforeAgentStartCalls).toBe(0);
    expect(host.createSessionContext().sessionManager?.getSessionId()).toBe(
      nativeSessionId,
    );
    expect(JSON.stringify(journalEntries)).not.toContain("fallback answer");
    expect(JSON.stringify(journalEntries)).not.toContain(
      "bounded provider failure",
    );
  });
  it.each([
    "false",
    "throw",
    "reject",
  ] as const)("settles the primary failure without waiting for an impossible %s model application", async (behavior) => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [loomOrigin, loomFallback],
    });
    installModelFallbackExtension(host, journalEntries);
    await host.triggerSessionStart();

    if (behavior === "false") host.declineNextSetModel();
    if (behavior === "throw") host.poisonSetModel();
    if (behavior === "reject") host.rejectSetModel();

    const rawFailure = `raw-${behavior}-provider-error token=sk-test-secret`;
    await host.triggerEvent("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        id: `primary-impossible-${behavior}`,
        stopReason: "error",
        error: { status: 503, message: rawFailure },
        content: [{ type: "text", text: `failed-${behavior}-content` }],
      },
    });
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await flushBackgroundWork();

    // A false result, synchronous throw, or rejected promise is terminal
    // evidence. None can manufacture a model_select or hidden marker.
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.getCurrentModel()).toBe(loomOrigin);
    const serialized = JSON.stringify({
      journalEntries,
      notifyCalls: host.notifyCalls,
      statusCalls: host.statusCalls,
      sendMessageCalls: host.sendMessageCalls,
    });
    expect(serialized).not.toContain(rawFailure);
    expect(serialized).not.toContain("failed-");
    expect(serialized).not.toContain("sk-test-secret");
    // No model-fallback success/recovery record is emitted without an
    // applied candidate; the terminal primary turn remains a host outcome.
    expect(
      modelFallbackRecords(journalEntries).some(
        (record) => record.outcome === "recovery-confirmed",
      ),
    ).toBe(false);
  });

  it("fails closed when the fallback candidate is absent from the native catalog", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [loomOrigin],
    });
    installModelFallbackExtension(host, journalEntries);
    await host.triggerSessionStart();
    const callsAtBoot = host.setModelCalls.length;

    await host.triggerEvent("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        id: "catalog-miss-failure",
        stopReason: "error",
        error: { status: 503, message: "catalog-miss-raw-secret" },
        content: [{ type: "text", text: "catalog-miss-failed-content" }],
      },
    });
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await flushBackgroundWork();

    expect(host.setModelCalls).toHaveLength(callsAtBoot);
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(host.getCurrentModel()).toBe(loomOrigin);
    expect(JSON.stringify(journalEntries)).not.toContain(
      "catalog-miss-raw-secret",
    );
    expect(JSON.stringify(journalEntries)).not.toContain(
      "catalog-miss-failed-content",
    );
  });

  it("does not consume a real queued input when pending input wins the preflight race", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [loomOrigin, loomFallback],
    });
    installModelFallbackExtension(host, journalEntries);
    await host.triggerSessionStart();
    const callsAtBoot = host.setModelCalls.length;
    host.setPendingMessages(true);

    const failed = {
      role: "assistant",
      id: "pending-race-failure",
      stopReason: "error",
      error: { status: 503, message: "pending-race-provider-secret" },
      content: [{ type: "text", text: "pending-race-failed-content" }],
    };
    await host.triggerEvent("message_end", {
      type: "message_end",
      message: failed,
    });
    await host.triggerEvent("agent_settled", { type: "agent_settled" });
    await flushBackgroundWork();

    expect(host.setModelCalls).toHaveLength(callsAtBoot);
    expect(host.sendMessageCalls).toHaveLength(0);
    const realUser = { role: "user", content: "real input before fallback" };
    const queued = { role: "user", content: "real input during fallback" };
    const providerInput = [realUser, failed, queued];
    expect(await host.triggerContext(providerInput)).toEqual(providerInput);
    expect(providerInput).toEqual([realUser, failed, queued]);
    expect(
      JSON.stringify({ journalEntries, status: host.statusCalls }),
    ).not.toContain("pending-race-provider-secret");
  });

  it("drops a stale primary fallback when a generation is replaced during model application", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [loomOrigin, loomFallback],
    });
    installModelFallbackExtension(host, journalEntries);
    await host.triggerSessionStart();

    const deferred = host.deferNextSetModel();
    await host.triggerEvent("message_end", failureEvent("stale-fallback"));
    const staleSettlement = host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });
    await deferred.called;
    expect(host.setModelCalls.at(-1)).toBe(loomFallback);

    // Replacement revokes the old generation while its host call is still in
    // flight. Resolving that old call must not emit a marker or settle twice.
    const replacement = host.triggerSessionStart();
    deferred.settle(true);
    await staleSettlement;
    await replacement;
    await flushBackgroundWork();

    expect(host.sendMessageCalls).toHaveLength(0);
    expect(host.sentUserMessages).toHaveLength(0);
    expect(
      modelFallbackRecords(journalEntries).some(
        (record) => record.outcome === "recovery-confirmed",
      ),
    ).toBe(false);
  });

  it("closes a primary fallback on shutdown and ignores its late model proof", async () => {
    const journalEntries: unknown[] = [];
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      currentModel: loomOrigin,
      availableModels: [loomOrigin, loomFallback],
    });
    installModelFallbackExtension(host, journalEntries);
    await host.triggerSessionStart();

    const deferred = host.deferNextSetModel();
    await host.triggerEvent("message_end", failureEvent("shutdown-fallback"));
    const staleSettlement = host.triggerEvent("agent_settled", {
      type: "agent_settled",
    });
    await deferred.called;
    await host.triggerSessionShutdown();
    deferred.settle(true);
    await staleSettlement;
    await flushBackgroundWork();

    await host.triggerModelSelect(loomFallback, "set");
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(host.sentUserMessages).toHaveLength(0);
    expect(JSON.stringify(journalEntries)).not.toContain("shutdown-fallback");
  });
});
