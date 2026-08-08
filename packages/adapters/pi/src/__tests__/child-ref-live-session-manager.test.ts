import { describe, expect, it } from "bun:test";
import {
  ALL_CAPABILITY_IDS,
  createInMemoryRuntimeStore,
  MemoryRuntimeLogFileSystem,
} from "@weaveio/weave-engine";
import { ok, okAsync, type Result } from "neverthrow";
import {
  FakePiChildMetadataCacheFs,
  openBunChildMetadataDatabase,
} from "../child-metadata-cache.js";
import type {
  PiNativeSessionFsPort,
  PiNativeSessionHandle,
  PiNativeSessionHeader,
  PiNativeSessionHostPort,
  PiNativeSessionStorageUnavailable,
} from "../child-native-sessions.js";
import { PiNativeSessionStore } from "../child-native-sessions.js";
import {
  createNativeChildRefSourceAuthority,
  PiChildSessionRefStore,
} from "../child-session-refs.js";
import { PiConfigActivator } from "../config-activator.js";
import { createPiExtension } from "../extension.js";
import {
  createGenerationSessionCtxCell,
  type PiChildRefEntryReadDegradation,
  PiGenerationResourceOwner,
  readSessionManagerEntries,
} from "../generation-resources.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PI_HOST_SURFACE_IDS } from "../host-inventory.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import { FakePathContainmentPort } from "../path-containment.js";
import { InMemoryRecoveryPointerStore } from "../recovery-pointer.js";
import {
  openPiThreadSources,
  type PiThreadSourceFactoryInput,
} from "../thread-sources.js";
import type { PiSessionContext } from "../types.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  RecordingFakePiHost,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";
import { TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

const PARENT = "parent-session-live-mgr-1";
const CHILD = "live-mgr-child-1";
const SESSION_ROOT = "/data/weave-livemgr/sessions";
const CACHE_ROOT = "/data/weave-livemgr/cache";
const WORKSPACE = "/repo";
const PARENT_SESSION_FILE = "/data/weave-livemgr/parent.jsonl";
const HISTORICAL_ENTRY_COUNT = 69;

const EMPTY_CONFIG = {
  agents: {},
  disabled: { agents: [], skills: [] },
} as never;

function loomDescriptor() {
  return {
    name: "loom",
    composedPrompt: "You are Loom.",
    models: ["claude-sonnet-4-5"],
    mode: "primary" as const,
    effectiveToolPolicy: {
      read: "allow" as const,
      write: "allow" as const,
      execute: "allow" as const,
      delegate: "allow" as const,
      network: "ask" as const,
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
  };
}

async function flushBackgroundWork(ticks = 40): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A Pi session manager whose entries this test drives directly. */
function managerFor(
  entries: () => readonly unknown[],
): Record<string, unknown> {
  return {
    getSessionId: () => PARENT,
    getSessionFile: () => PARENT_SESSION_FILE,
    isPersisted: () => true,
    getEntries: () => entries(),
  };
}

function handleFor(
  file: string | undefined,
  dir: string,
  header: PiNativeSessionHeader | null,
): PiNativeSessionHandle {
  return {
    getSessionId: () => header?.id ?? "",
    getSessionFile: () => file,
    getSessionDir: () => dir,
    getHeader: () => header,
    getEntries: () => [],
    isPersisted: () => true,
    getLeafId: () => "leaf-1",
    appendCustomEntry: () => "entry-1",
  };
}

/**
 * In-memory stand-in for Pi's `SessionManager`. It never starts a harness and
 * never touches a real filesystem: the store writes every byte through the
 * injected {@link MemoryPiNativeSessionFs}.
 */
class MemoryNativeSessionHost implements PiNativeSessionHostPort {
  requireDescriptorSafeSessionIo(): Result<
    void,
    PiNativeSessionStorageUnavailable
  > {
    // Test-only memory host: every byte goes through the injected in-memory
    // no-follow filesystem, so descriptor-safe storage is provable here.
    return ok(undefined);
  }

  create(
    cwd: string,
    sessionDir: string,
    options: { parentSession?: string; id?: string },
  ): PiNativeSessionHandle {
    return handleFor(`${sessionDir}/session.jsonl`, sessionDir, {
      type: "session",
      id: options.id ?? "native-session-1",
      cwd,
      version: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
      parentSession: options.parentSession,
    });
  }

  open(path: string, sessionDir: string): PiNativeSessionHandle {
    return handleFor(path, sessionDir, {
      type: "session",
      id: "native-session-1",
      cwd: WORKSPACE,
      version: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
      parentSession: PARENT,
    });
  }
}

/**
 * Extension-boundary coverage for Spec 33 Task 20 item (c): the long-lived
 * child-ref entry read must follow the *current* generation's session
 * manager, not the one captured when the generation started.
 *
 * Pi replaces `ctx.sessionManager` across a session load, and the extension
 * already tracks the latest context for exactly that reason. The parent ref
 * ledger, however, used to be read through the manager captured at
 * `session_start`, so a picker row resolved before the replacement could no
 * longer be described after it - the live `open-describe-child-not-found`
 * blocker.
 *
 * Every seam here is in memory: no process is spawned, no shell command runs,
 * no temporary directory is made, and no real file is written.
 */
describe("createPiExtension: child refs follow the live session manager", () => {
  /**
   * Seeds one settled child: a native session held entirely in the memory
   * filesystem plus the durable parent ref ledger entries Pi would have
   * persisted for it.
   */
  async function seedSettledChild(): Promise<{
    readonly fs: MemoryPiNativeSessionFs;
    readonly nativeHost: PiNativeSessionHostPort;
    readonly parentEntries: readonly unknown[];
  }> {
    const fs = new MemoryPiNativeSessionFs();
    const nativeHost = new MemoryNativeSessionHost();
    const store = new PiNativeSessionStore({
      root: SESSION_ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host: nativeHost,
    });
    const created = (
      await store.createChildSession({
        childId: CHILD,
        parentSession: PARENT,
        cwd: WORKSPACE,
      })
    )._unsafeUnwrap();
    const directory = (
      await fs.openDirectory(`${SESSION_ROOT}/${CHILD}`, false)
    )._unsafeUnwrap();
    const fileName = created.ref.slice(created.ref.lastIndexOf("/") + 1);
    const lines: string[] = [];
    for (let index = 0; index < HISTORICAL_ENTRY_COUNT; index += 1) {
      lines.push(
        `${JSON.stringify({
          type: "message",
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          timestamp: new Date(1_700_000_000_000 + index).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: `body-${index}` }],
          },
        })}\n`,
      );
    }
    (
      await directory.appendFile(
        fileName,
        new TextEncoder().encode(lines.join("")),
        0o600,
      )
    )._unsafeUnwrap();
    directory.close();

    const parentEntries: { type: string; data: unknown }[] = [];
    const seedRefs = new PiChildSessionRefStore({
      storage: TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY,
      parentSessionId: PARENT,
      append: {
        appendEntry: (type, data) => {
          parentEntries.push({ type, data });
        },
      },
      read: { getEntries: () => parentEntries },
      authority: createNativeChildRefSourceAuthority(store),
    });
    const seeded = (
      await seedRefs.appendNewChild({
        childId: CHILD,
        nativeSessionId: created.sessionId,
        sessionRef: created.ref,
        title: "loom",
        status: "running",
      })
    )._unsafeUnwrap();
    (
      await seedRefs.appendLifecycle(seeded, { status: "completed" })
    )._unsafeUnwrap();

    return { fs, nativeHost, parentEntries };
  }

  type ExtensionTestSeams = {
    telemetryLogFileSystem: MemoryRuntimeLogFileSystem;
    recoveryPointerStoreFactoryCalls: { value: number };
  };

  function installExtension(
    host: RecordingFakePiHost,
    fs: MemoryPiNativeSessionFs,
    nativeHost: PiNativeSessionHostPort,
    logger: RecordingLogger,
  ): ExtensionTestSeams {
    const telemetryLogFileSystem = new MemoryRuntimeLogFileSystem();
    const recoveryPointerStore = new InMemoryRecoveryPointerStore();
    const recoveryPointerStoreFactoryCalls = { value: 0 };
    const factory = createPiExtension({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.83.0",
      }),
      sessionStorageAuthority:
        TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY,
      capabilityProber: {
        probe: () =>
          ALL_CAPABILITY_IDS.map((capabilityId) => ({
            capabilityId,
            probeStatus: "ok" as const,
          })),
      },
      idGenerator: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger,
      configActivator: new PiConfigActivator({
        configLoader: { load: () => okAsync(EMPTY_CONFIG) },
        materializer: {
          materialize: () =>
            okAsync({
              agents: [
                {
                  agentName: "loom",
                  source: "explicit" as const,
                  descriptor: loomDescriptor(),
                },
              ],
              errors: [],
            }),
        },
      } as never),
      pathContainmentPort: new FakePathContainmentPort(
        new Map(),
        ok("/fake/project"),
      ),
      hostSurfaceReader: {
        read: () =>
          okAsync(
            PI_HOST_SURFACE_IDS.map((surfaceId) => ({
              surfaceId,
              status: "native" as const,
              details: `test-${surfaceId}`,
            })),
          ),
      },
      runtimeStoreFactory: {
        open: () => okAsync(createInMemoryRuntimeStore()),
      },
      telemetryLogFileSystem,
      recoveryPointerStoreFactory: () => {
        recoveryPointerStoreFactoryCalls.value += 1;
        return recoveryPointerStore;
      },
      parentSessionId: () => PARENT,
      threadSourceFactory: (input: PiThreadSourceFactoryInput) =>
        openPiThreadSources({
          ...input,
          sessionRoot: SESSION_ROOT,
          fs: fs as unknown as PiNativeSessionFsPort,
          host: nativeHost,
          cacheRoot: CACHE_ROOT,
          cacheFs: new FakePiChildMetadataCacheFs(),
          openDatabase: () => openBunChildMetadataDatabase(":memory:"),
        }),
      hostKeybindings: () => host.hostKeybindingsForTest(),
    } as never);
    factory(host.api);
    return { telemetryLogFileSystem, recoveryPointerStoreFactoryCalls };
  }

  /**
   * Live blocker shape: the picker row resolves while the startup manager is
   * still attached, Pi then replaces the session manager during the next
   * model turn, and the selection is described afterwards. Reading the
   * captured startup manager at that point yields no refs at all.
   */
  it("describes a picked child after Pi replaces the session manager", async () => {
    const { fs, nativeHost, parentEntries } = await seedSettledChild();
    const logger = new RecordingLogger();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.effectiveKeybindingConfig = {};

    // The startup manager is detached once Pi supplies a replacement, which
    // is exactly what a captured `ctx.sessionManager` sees after a load.
    let startupManagerAttached = true;
    host.setSessionManager(
      managerFor(() => (startupManagerAttached ? parentEntries : [])) as never,
    );

    const seams = installExtension(host, fs, nativeHost, logger);
    await host.triggerSessionStart();
    await flushBackgroundWork();

    expect(seams.recoveryPointerStoreFactoryCalls.value).toBeGreaterThan(0);
    expect(
      seams.telemetryLogFileSystem
        .paths()
        .some((path) => path.endsWith("/pi-adapter.ndjson")),
    ).toBe(true);

    const customBefore = host.customCalls.length;
    const editorOwnerBefore = host.getEditorComponentForTest();
    const deferred = host.deferNextSelect();
    void host.invokeCommand("weave:inspect");
    await flushBackgroundWork();

    const label = (host.selectCalls.at(-1)?.options ?? []).find((option) =>
      option.startsWith("history: "),
    );
    expect(label).toBeDefined();

    // Pi replaces the session manager for the next model turn: the startup
    // manager goes stale, and a fresh context carries the live one.
    startupManagerAttached = false;
    host.setSessionManager(managerFor(() => parentEntries) as never);
    await host.triggerBeforeAgentStart();
    await flushBackgroundWork();

    deferred.settle(label);
    await flushBackgroundWork();

    await host.invokeCommand("weave:health");
    const health = host.notifyCalls.at(-1)?.message ?? "";
    expect(health).not.toContain("open-describe-child-not-found");

    expect(host.customCalls.length - customBefore).toBe(1);
    expect(host.getEditorComponentForTest()).toBe(editorOwnerBefore);
    const rendered = host.customRenderedLines.at(-1)?.join("\n") ?? "";
    expect(rendered).toContain("SETTLED");
    expect(rendered).toContain(`body-${HISTORICAL_ENTRY_COUNT - 1}`);
  });

  /**
   * Same-file resume: the startup context has a manager whose entries have
   * not loaded yet, and the durable refs only become readable through the
   * later context Pi supplies for the first turn.
   */
  it("lists a historical child whose refs load after session start", async () => {
    const { fs, nativeHost, parentEntries } = await seedSettledChild();
    const logger = new RecordingLogger();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.effectiveKeybindingConfig = {};
    host.setSessionManager(managerFor(() => []) as never);

    installExtension(host, fs, nativeHost, logger);
    await host.triggerSessionStart();
    await flushBackgroundWork();

    host.setSessionManager(managerFor(() => parentEntries) as never);
    await host.triggerBeforeAgentStart();
    await flushBackgroundWork();

    const deferred = host.deferNextSelect();
    void host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const label = (host.selectCalls.at(-1)?.options ?? []).find((option) =>
      option.startsWith("history: "),
    );
    expect(label).toBeDefined();
    deferred.settle(undefined);
    await flushBackgroundWork();
  });

  /**
   * Command boundary alone: Pi builds a fresh context for every command, so
   * `/weave:inspect` must pick up the live session manager even when no
   * lifecycle callback ran between the replacement and the command.
   */
  it("lists a historical child through the command context alone", async () => {
    const { fs, nativeHost, parentEntries } = await seedSettledChild();
    const logger = new RecordingLogger();
    const host = new RecordingFakePiHost({ mode: "tui", trusted: true });
    host.effectiveKeybindingConfig = {};
    host.setSessionManager(managerFor(() => []) as never);

    installExtension(host, fs, nativeHost, logger);
    await host.triggerSessionStart();
    await flushBackgroundWork();

    // No lifecycle callback after the replacement: only the command context
    // can carry the live manager.
    host.setSessionManager(managerFor(() => parentEntries) as never);

    const deferred = host.deferNextSelect();
    void host.invokeCommand("weave:inspect");
    await flushBackgroundWork();
    const label = (host.selectCalls.at(-1)?.options ?? []).find((option) =>
      option.startsWith("history: "),
    );
    expect(label).toBeDefined();
    deferred.settle(undefined);
    await flushBackgroundWork();
  });
});

/**
 * Unit-level contract for the two primitives the extension boundary relies
 * on. They are the parts that decide *which* session manager a long-lived
 * reader reaches, so their scoping and fail-closed behaviour are pinned here
 * independently of the extension wiring above.
 */
describe("createGenerationSessionCtxCell", () => {
  const ctxWith = (marker: string): PiSessionContext =>
    ({ sessionManager: { marker } }) as never;

  it("reads back the context noted for the same generation", () => {
    const cell = createGenerationSessionCtxCell();
    const ctx = ctxWith("gen-a-startup");
    cell.note("gen-a", ctx);
    expect(cell.read("gen-a")).toBe(ctx);
  });

  it("returns the newest context noted for the generation", () => {
    const cell = createGenerationSessionCtxCell();
    cell.note("gen-a", ctxWith("startup"));
    const live = ctxWith("live");
    cell.note("gen-a", live);
    expect(cell.read("gen-a")).toBe(live);
  });

  it("never leaks a newer generation's context to an older one", () => {
    const cell = createGenerationSessionCtxCell();
    cell.note("gen-a", ctxWith("gen-a"));
    const newer = ctxWith("gen-b");
    cell.note("gen-b", newer);
    // The replaced generation's retained closure must fall back, not read
    // its successor's session manager.
    expect(cell.read("gen-a")).toBeUndefined();
    expect(cell.read("gen-b")).toBe(newer);
  });

  it("clears only while the generation still owns the cell", () => {
    const cell = createGenerationSessionCtxCell();
    cell.note("gen-a", ctxWith("gen-a"));
    cell.clear("gen-b");
    expect(cell.read("gen-a")).toBeDefined();
    cell.clear("gen-a");
    expect(cell.read("gen-a")).toBeUndefined();
  });

  it("keeps the successor's context when the replaced generation disposes late", () => {
    const cell = createGenerationSessionCtxCell();
    cell.note("gen-a", ctxWith("gen-a"));
    const newer = ctxWith("gen-b");
    cell.note("gen-b", newer);
    // Generation A's resource owner disposes after B started: its cleanup
    // must not strip the live generation's context.
    cell.clear("gen-a");
    expect(cell.read("gen-b")).toBe(newer);
  });

  it("reports no context for a generation that never noted one", () => {
    expect(createGenerationSessionCtxCell().read("gen-a")).toBeUndefined();
  });
});

describe("readSessionManagerEntries", () => {
  function recorder(): {
    readonly report: (d: PiChildRefEntryReadDegradation) => void;
    readonly seen: PiChildRefEntryReadDegradation[];
  } {
    const seen: PiChildRefEntryReadDegradation[] = [];
    return { report: (d) => seen.push(d), seen };
  }

  it("returns the manager's entries with no degradation", () => {
    const entries = [{ type: "message" }];
    const { report, seen } = recorder();
    expect(
      readSessionManagerEntries(
        { sessionManager: { getEntries: () => entries } } as never,
        report,
      ),
    ).toBe(entries);
    expect(seen).toEqual([]);
  });

  it("fails closed to no entries when the context is absent", () => {
    const { report, seen } = recorder();
    expect(readSessionManagerEntries(undefined, report)).toEqual([]);
    expect(seen).toEqual(["no-session-manager"]);
  });

  it("fails closed to no entries when the manager is absent", () => {
    const { report, seen } = recorder();
    expect(readSessionManagerEntries({} as never, report)).toEqual([]);
    expect(seen).toEqual(["no-session-manager"]);
  });

  it("fails closed when the manager cannot report entries", () => {
    const { report, seen } = recorder();
    expect(
      readSessionManagerEntries({ sessionManager: {} } as never, report),
    ).toEqual([]);
    expect(seen).toEqual(["no-session-manager"]);
  });

  it("absorbs a throwing getEntries instead of propagating", () => {
    const { report, seen } = recorder();
    expect(
      readSessionManagerEntries(
        {
          sessionManager: {
            getEntries: () => {
              throw new Error("session manager detached");
            },
          },
        } as never,
        report,
      ),
    ).toEqual([]);
    expect(seen).toEqual(["get-entries-failed"]);
  });
});

/**
 * The generation resource owner runs the session-context cleanup. That
 * callback is supplied by the extension, so a defect there must not turn
 * disposal - whose failure type is `never` - into a thrown rejection that
 * would strand the runtime store and telemetry it also owns.
 */
describe("PiGenerationResourceOwner disposal", () => {
  it("absorbs a throwing onDispose and still reports success", async () => {
    let calls = 0;
    const owner = new PiGenerationResourceOwner("gen-a", () => {
      calls += 1;
      throw new Error("cleanup exploded");
    });

    const disposed = await owner.dispose();

    expect(disposed.isOk()).toBe(true);
    expect(disposed._unsafeUnwrap()).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("keeps releasing adopted resources after onDispose throws", async () => {
    let telemetryShutdowns = 0;
    let storeCloses = 0;
    const owner = new PiGenerationResourceOwner("gen-a", () => {
      throw new Error("cleanup exploded");
    });
    owner.adoptTelemetry({
      shutdown: () => {
        telemetryShutdowns += 1;
        return okAsync(undefined);
      },
    } as never);
    owner.adoptRuntimeStore({
      close: () => {
        storeCloses += 1;
        return okAsync(undefined);
      },
    } as never);

    expect((await owner.dispose()).isOk()).toBe(true);
    expect(telemetryShutdowns).toBe(1);
    expect(storeCloses).toBe(1);
  });

  it("stays idempotent when disposed repeatedly after a throwing cleanup", async () => {
    let calls = 0;
    const owner = new PiGenerationResourceOwner("gen-a", () => {
      calls += 1;
      throw new Error("cleanup exploded");
    });

    expect((await owner.dispose()).isOk()).toBe(true);
    expect((await owner.dispose()).isOk()).toBe(true);
    expect((await owner.dispose()).isOk()).toBe(true);
    // Cleanup runs exactly once, no matter how many disposals arrive.
    expect(calls).toBe(1);
  });
});
