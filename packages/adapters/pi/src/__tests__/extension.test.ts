import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import {
  type AgentDescriptor,
  ALL_CAPABILITY_IDS,
  createInMemoryRuntimeStore,
  type MaterializationPlan,
  type PlanTaskSnapshot,
} from "@weaveio/weave-engine";
import { errAsync, ok, okAsync } from "neverthrow";
import { DefaultPiCapabilityProber } from "../capability-prober.js";
import type { PiChildHistoryRecord } from "../child-history-schema.js";
import type { PiChildHistoryStore } from "../child-history-store.js";
import { WEAVE_COMMAND_NAMES } from "../commands.js";
import { PiConfigActivator } from "../config-activator.js";
import {
  createPiExtension,
  PI_SHARED_LOG_PATH,
  type PiExtensionDeps,
} from "../extension.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import {
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
  type PiHostSurfaceReader,
} from "../host-inventory.js";
import { FakePathContainmentPort } from "../path-containment.js";
import { FakePiPlanCatalogPort } from "../plan-catalog.js";
import { MODEL_REGISTRY_THREW_REASON } from "../port-safety.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  RecordingFakePiHost,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";
import { MutablePlanStateProvider } from "./fakes/fake-plan-state-provider.js";

const EMPTY_CONFIG = {
  agents: {},
  disabled: { agents: [], skills: [] },
} as unknown as WeaveConfig;

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
    ]);
    expect(host.onCalls.map((call) => call.event).sort()).toEqual([
      "agent_start",
      "before_agent_start",
      "input",
      "message_end",
      "model_select",
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
    expect(host.statusCalls).toContainEqual({
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
      expect(host.notifyCalls.at(-1)?.message.length).toBeLessThan(1200);
    }
  });

  it("makes each required surface fail closed while rendering loss uses the fallback and stays ready", async () => {
    const required = PI_HOST_SURFACE_IDS.filter(
      (surfaceId) => surfaceId !== "status-rendering",
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

describe("createPiExtension: config activation, materialization consumption, primary activation, prompt append", () => {
  it("materializes config, activates the default primary (loom), and never touches a real developer config file", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
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
    installForegroundStartTestExtension(host, { skills: ["missing"] });
    await host.triggerSessionStart();

    await host.invokeCommand("weave:start", "model-thinking-suffix");

    expect(host.sentUserMessages).toHaveLength(0);
    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    expect(host.notifyCalls.at(-1)).toEqual({
      message:
        "Could not start plan: Tapestry could not activate in this session.",
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

  it("cycles the pending primary before the first turn", async () => {
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

  it("keeps the active primary and badge when the next primary cannot activate", async () => {
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
            descriptor: tapestryDescriptor({ skills: ["missing"] }),
          },
        ],
        errors: [],
      }),
    });
    await host.triggerSessionStart();
    await host.triggerBeforeAgentStart({ systemPrompt: "native", skills: [] });

    await host.invokeShortcut("alt+a");

    expect(host.statusCalls.at(-1)).toEqual({
      key: "weave-agent",
      value: "◆ WEAVE · LOOM",
    });
    expect(host.notifyCalls.at(-1)).toEqual({
      message: "Could not switch Weave primary agent to tapestry.",
      level: "error",
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

    expect(host.setModelCalls).toEqual([catalogModel]);
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
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

    // Non-throwing `false` must be treated exactly like a thrown/rejected
    // setModel: the descriptor still commits (degraded model health), and
    // the host's currentModel is never overwritten as if it had succeeded.
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    expect(host.getCurrentModel()).toBeUndefined();

    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain("warning [model] loom");
  });

  it("fails closed instead of crashing the turn when ctx.modelRegistry.getAvailable() throws", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.poisonGetAvailableModels();
    const logger = new RecordingLogger();
    installExtension(host, "0.81.1", {
      logger,
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

    // The descriptor still activates (model resolution degrades to an
    // empty catalog rather than crashing the turn), and the throw is
    // logged, not swallowed silently.
    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    const warnEntry = logger.entries.find(
      (entry) =>
        entry.level === "warn" &&
        typeof entry.msg === "string" &&
        entry.msg.includes("ctx.modelRegistry.getAvailable() threw"),
    );
    expect(warnEntry).toBeDefined();
    // The logged reason is a fixed, closed-set literal - never the raw
    // thrown message, which cannot be trusted not to contain private
    // paths, environment values, or secrets.
    expect(warnEntry?.obj.reason).toBe(MODEL_REGISTRY_THREW_REASON);
    expect(JSON.stringify(logger.entries)).not.toContain("id_rsa");
    expect(JSON.stringify(logger.entries)).not.toContain("sk-super-secret-123");
  });

  it("never commits or appends a stale descriptor prompt if the controller's generation changed while primary activation was still in flight", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    const deferred = host.deferNextSetModel();
    const logger = new RecordingLogger();
    installExtension(host, "0.81.1", {
      logger,
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

    // Start a before_agent_start turn; its setModel call will hang until we
    // settle it below, simulating an in-flight primary activation.
    const stalePromise = host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    // A session replacement happens while the above is still pending (e.g. a
    // reload/fork/switch/new session_start installs a fresh generation).
    await host.triggerSessionStart();

    // Now let the stale call's setModel settle successfully.
    deferred.settle(true);
    const stale = await stalePromise;

    // The stale call must never return an authoritative, committed prompt
    // for a generation that is no longer current.
    expect(stale.systemPrompt).toBe("native");
    expect(
      logger.entries.some(
        (entry) =>
          entry.level === "warn" &&
          typeof entry.msg === "string" &&
          entry.msg.includes("discarding stale authority"),
      ),
    ).toBe(true);

    // The fresh generation's own before_agent_start still works normally.
    const fresh = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });
    expect(fresh.systemPrompt).toContain(
      "You are Loom, the main orchestrator.",
    );
  });

  it("preserves a native model selected after startup but before the first prompt", async () => {
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

    await host.triggerModelSelect(userModel, "set");
    const first = await host.triggerBeforeAgentStart({
      systemPrompt: "native",
    });

    expect(first.systemPrompt).toContain(
      "You are Loom, the main orchestrator.",
    );
    expect(host.setModelCalls).toHaveLength(0);
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

  it("resolves requested skills from Pi's real before_agent_start skill catalog, exactly", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
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

    const { systemPrompt } = await host.triggerBeforeAgentStart(
      { systemPrompt: "native" },
      [{ name: "tdd", filePath: "/fake/skills/tdd/SKILL.md" }],
    );

    expect(systemPrompt).toContain("You are Loom, the main orchestrator.");
    // Only the skill's name is ever consumed for matching -- never its body.
    expect(systemPrompt).not.toContain("SKILL.md");
  });

  it("disables only the affected descriptor when a requested skill is missing from Pi's catalog, without crashing and without applying a model", async () => {
    const host = new RecordingFakePiHost({
      mode: "tui",
      trusted: true,
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });
    installExtension(host, "0.81.1", {
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

    expect(systemPrompt).toBe("native");
    expect(host.setModelCalls).toHaveLength(0);

    // The failed attempt is not retried on a later turn (no spam), and stays
    // visible via /weave:health rather than only in logs.
    await host.triggerBeforeAgentStart({ systemPrompt: "native" });
    expect(host.setModelCalls).toHaveLength(0);
    await host.invokeCommand("weave:health");
    expect(host.notifyCalls.at(-1)?.message).toContain(
      "primary activation failed: SkillResolutionFailed",
    );
  });

  it("exposes a declared-temperature capability warning through /weave:health, not just a log line", async () => {
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    installExtension(host, "0.81.1", {
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
    const editor = host.createEditor({}, {}, {});
    const picker = host.deferNextSelect();
    await editor.handleInput("\u001bi");
    expect(host.registerShortcutCalls.map((call) => call.shortcut)).toEqual([
      "alt+a",
    ]);
    picker.settle(undefined);
    await host.triggerSessionShutdown();
    expect(host.getEditorComponentForTest()).toBe(priorFactory);
    expect(
      host.editorFactoryCalls.filter((factory) => factory === priorFactory),
    ).toHaveLength(1);
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
