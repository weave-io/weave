import { describe, expect, it } from "bun:test";
import {
  type AdapterPreferenceRecord,
  type AdapterPreferenceRepository,
  queryError,
  type RuntimeStoreError,
} from "@weaveio/weave-engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  CHILD_EXTENSION_SELECTION_KEY,
  type ChildExtensionSelectionRecord,
  encodeChildExtensionSelection,
  PI_PREFERENCE_NAMESPACE,
} from "../child-extension-selection.js";
import {
  getPiExtensionEntryPath,
  recordPiExtensionEntryPath,
} from "../host-module-loader.js";
import type {
  PiExtensionInventory,
  PiExtensionInventoryDegradation,
  PiExtensionInventoryEntry,
} from "../pi-extension-inventory.js";
import {
  collectPiExtensionInventoryFromHost,
  createBunPiExtensionInventoryPort,
  createPiExtensionInventoryHost,
  MAX_OWN_ENTRY_IDENTITY_PROBES,
  projectConfiguredPackages,
  renderChildExtensionArgs,
  resolveChildExtensionSpawnArgs,
  resolveOwnExtensionEntryPath,
} from "../pi-extension-inventory-port.js";
import type { PiCommandInfo, PiToolInfo } from "../types.js";

const WEAVE_PATH = "/opt/weave/dist/extension.js";
const VIM_PATH = "/home/dev/.pi/agent/npm/node_modules/pi-vim";

/**
 * A preference repository with exactly one scripted `get`. Every other member
 * is unreachable in this module and says so rather than pretending to work.
 */
class ScriptedPreferences implements AdapterPreferenceRepository {
  constructor(
    private readonly scripted: ResultAsync<
      AdapterPreferenceRecord | null,
      RuntimeStoreError
    >,
  ) {}
  readonly calls: string[] = [];

  get(
    namespace: string,
    key: string,
  ): ResultAsync<AdapterPreferenceRecord | null, RuntimeStoreError> {
    this.calls.push(`${namespace}/${key}`);
    return this.scripted;
  }
  set(): ResultAsync<AdapterPreferenceRecord, RuntimeStoreError> {
    return errAsync(queryError("test-only repository does not write"));
  }
  list(): ResultAsync<readonly AdapterPreferenceRecord[], RuntimeStoreError> {
    return errAsync(queryError("test-only repository does not list"));
  }
  listAll(): ResultAsync<
    readonly AdapterPreferenceRecord[],
    RuntimeStoreError
  > {
    return errAsync(queryError("test-only repository does not list"));
  }
  remove(): ResultAsync<void, RuntimeStoreError> {
    return errAsync(queryError("test-only repository does not remove"));
  }
}

function storedRecord(valueJson: string): AdapterPreferenceRecord {
  return {
    namespace: PI_PREFERENCE_NAMESPACE,
    key: CHILD_EXTENSION_SELECTION_KEY,
    valueJson,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function explicitRecord(
  entries: ChildExtensionSelectionRecord["entries"],
): string {
  const encoded = encodeChildExtensionSelection({
    schemaVersion: 1,
    mode: "explicit",
    entries,
  });
  if (encoded.isErr()) throw new Error("test setup: record did not encode");
  return encoded.value;
}

function entry(
  overrides: Partial<PiExtensionInventoryEntry> &
    Pick<PiExtensionInventoryEntry, "id" | "path">,
): PiExtensionInventoryEntry {
  return {
    label: overrides.id,
    source: overrides.id,
    origin: "top-level",
    scope: "user",
    evidence: ["loaded"],
    mandatory: false,
    available: true,
    ...overrides,
  };
}

function inventory(
  entries: readonly PiExtensionInventoryEntry[],
): PiExtensionInventory {
  return { entries, truncated: false, projectScanned: true };
}

const WEAVE_ENTRY = entry({
  id: "npm:@weaveio/weave-adapter-pi",
  path: WEAVE_PATH,
  mandatory: true,
});
const VIM_ENTRY = entry({ id: "npm:pi-vim", path: VIM_PATH });

function resolve(input: {
  readonly stored?: AdapterPreferenceRecord | null;
  readonly storeFails?: boolean;
  readonly collected?: PiExtensionInventory;
  readonly degradation?: PiExtensionInventoryDegradation;
}) {
  const preferences = new ScriptedPreferences(
    input.storeFails === true
      ? errAsync(queryError("store unavailable"))
      : okAsync(input.stored ?? null),
  );
  let inventoryCalls = 0;
  const resolved = resolveChildExtensionSpawnArgs({
    store: { preferences },
    collectInventory: () => {
      inventoryCalls += 1;
      if (input.degradation !== undefined) return errAsync(input.degradation);
      return okAsync(input.collected ?? inventory([WEAVE_ENTRY, VIM_ENTRY]));
    },
  });
  return {
    preferences,
    resolved,
    inventoryCalls: () => inventoryCalls,
  };
}

describe("renderChildExtensionArgs", () => {
  it("renders nothing for inherit-all", () => {
    expect(
      renderChildExtensionArgs({
        mode: "inherit-all",
        paths: [],
        diagnostics: [],
      }),
    ).toEqual([]);
  });

  it("renders --no-extensions and one -e per path, in plan order", () => {
    expect(
      renderChildExtensionArgs({
        mode: "explicit",
        paths: [WEAVE_PATH, VIM_PATH],
        diagnostics: [],
      }),
    ).toEqual(["--no-extensions", "-e", WEAVE_PATH, "-e", VIM_PATH]);
  });
});

describe("resolveChildExtensionSpawnArgs", () => {
  it("reads exactly the adapter-owned namespace and key", async () => {
    const run = resolve({});
    await run.resolved;
    expect(run.preferences.calls).toEqual([
      `${PI_PREFERENCE_NAMESPACE}/${CHILD_EXTENSION_SELECTION_KEY}`,
    ]);
  });

  it("inherits all, and never collects an inventory, when nothing is stored", async () => {
    const run = resolve({});
    const resolution = (await run.resolved)._unsafeUnwrap();
    expect(resolution.args).toEqual([]);
    expect(resolution.diagnostics).toBeUndefined();
    expect(run.inventoryCalls()).toBe(0);
  });

  it("inherits all when the preference read fails", async () => {
    const run = resolve({ storeFails: true });
    const resolution = (await run.resolved)._unsafeUnwrap();
    expect(resolution.args).toEqual([]);
    expect(resolution.diagnostics?.fallback).toBe("preference-read-failed");
    expect(run.inventoryCalls()).toBe(0);
  });

  it("inherits all with a decode reason when the stored text is unusable", async () => {
    const run = resolve({ stored: storedRecord("{not json") });
    const resolution = (await run.resolved)._unsafeUnwrap();
    expect(resolution.args).toEqual([]);
    expect(resolution.diagnostics?.decode).toBe("invalid-json");
    expect(run.inventoryCalls()).toBe(0);
  });

  it("emits Weave first, then the live inventory path of each stored entry", async () => {
    const run = resolve({
      stored: storedRecord(
        explicitRecord([
          {
            id: "npm:pi-vim",
            source: "npm:pi-vim",
            // Deliberately stale: the live inventory path must win.
            path: "/old/install/pi-vim",
            label: "pi-vim",
          },
        ]),
      ),
    });
    const resolution = (await run.resolved)._unsafeUnwrap();
    expect(resolution.args).toEqual([
      "--no-extensions",
      "-e",
      WEAVE_PATH,
      "-e",
      VIM_PATH,
    ]);
    expect(resolution.diagnostics).toBeUndefined();
    expect(run.inventoryCalls()).toBe(1);
  });

  it("counts dropped entries without naming them", async () => {
    const run = resolve({
      stored: storedRecord(
        explicitRecord([
          {
            id: "npm:gone",
            source: "npm:gone",
            path: "/gone/extension.js",
            label: "gone",
          },
        ]),
      ),
    });
    const resolution = (await run.resolved)._unsafeUnwrap();
    // Explicit stays explicit: the child loads Weave only.
    expect(resolution.args).toEqual(["--no-extensions", "-e", WEAVE_PATH]);
    expect(resolution.diagnostics?.droppedEntries).toBe(1);
    expect(JSON.stringify(resolution.diagnostics)).not.toContain("npm:gone");
  });

  it("still resolves from a degraded inventory and reports the reasons", async () => {
    const run = resolve({
      stored: storedRecord(
        explicitRecord([
          {
            id: "npm:pi-vim",
            source: "npm:pi-vim",
            path: VIM_PATH,
            label: "pi-vim",
          },
        ]),
      ),
      degradation: {
        inventory: inventory([WEAVE_ENTRY, VIM_ENTRY]),
        reasons: ["tools-unavailable"],
      },
    });
    const resolution = (await run.resolved)._unsafeUnwrap();
    expect(resolution.args).toEqual([
      "--no-extensions",
      "-e",
      WEAVE_PATH,
      "-e",
      VIM_PATH,
    ]);
    expect(resolution.diagnostics?.inventoryDegraded).toEqual([
      "tools-unavailable",
    ]);
  });

  it("degrades to inherit-all rather than spawn a child without Weave", async () => {
    for (const collected of [
      inventory([VIM_ENTRY]),
      // Mandatory, but with a path no spawn would accept.
      inventory([
        entry({ id: "weave", path: "relative/path", mandatory: true }),
      ]),
    ]) {
      const run = resolve({
        stored: storedRecord(
          explicitRecord([
            {
              id: "npm:pi-vim",
              source: "npm:pi-vim",
              path: VIM_PATH,
              label: "pi-vim",
            },
          ]),
        ),
        collected,
      });
      const resolution = (await run.resolved)._unsafeUnwrap();
      expect(resolution.args).toEqual([]);
      expect(resolution.diagnostics?.fallback).toBe("weave-entry-unresolved");
    }
  });
});

describe("createBunPiExtensionInventoryPort", () => {
  const command: PiCommandInfo = {
    name: "weave:health",
    source: "extension",
    sourceInfo: {
      path: WEAVE_PATH,
      source: "npm:@weaveio/weave-adapter-pi",
      scope: "user",
      origin: "package",
    },
  };

  it("omits a member the host does not provide", () => {
    const port = createBunPiExtensionInventoryPort({});
    expect(port.commands).toBeUndefined();
    expect(port.tools).toBeUndefined();
    expect(port.agentDirectory).toBeUndefined();
    expect(port.configuredPackages).toBeUndefined();
    expect(port.installedPackagePath).toBeUndefined();
  });

  it("forwards every host accessor's value", async () => {
    const tool = { name: "weave_delegate", sourceInfo: command.sourceInfo };
    const port = createBunPiExtensionInventoryPort({
      commands: () => [command],
      tools: () => [tool],
      configuredPackages: () => [
        { source: "npm:pi-vim", scope: "user", installedPath: VIM_PATH },
      ],
      installedPackagePath: (source, scope) =>
        source === "npm:pi-vim" && scope === "user" ? VIM_PATH : undefined,
      agentDirectory: () => "/home/dev/.pi/agent",
    });
    const commands = await port.commands?.();
    expect(commands?._unsafeUnwrap()).toEqual([command]);
    const tools = await port.tools?.();
    expect(tools?._unsafeUnwrap()).toEqual([tool]);
    const packages = await port.configuredPackages?.();
    expect(packages?._unsafeUnwrap()).toEqual([
      { source: "npm:pi-vim", scope: "user", installedPath: VIM_PATH },
    ]);
    const installed = await port.installedPackagePath?.("npm:pi-vim", "user");
    expect(installed?._unsafeUnwrap()).toBe(VIM_PATH);
    const agentDir = await port.agentDirectory?.();
    expect(agentDir?._unsafeUnwrap()).toBe("/home/dev/.pi/agent");
  });

  it("separates an uninstalled package from an unreadable package list", async () => {
    const port = createBunPiExtensionInventoryPort({
      configuredPackages: () => undefined,
      installedPackagePath: () => undefined,
    });
    const packages = await port.configuredPackages?.();
    expect(packages?._unsafeUnwrapErr()).toEqual({ type: "HostCallFailed" });
    const installed = await port.installedPackagePath?.("npm:gone", "user");
    expect(installed?._unsafeUnwrapErr()).toEqual({ type: "NotFound" });
  });

  it("turns a throwing host accessor into a typed error, never an exception", async () => {
    const port = createBunPiExtensionInventoryPort({
      commands: () => {
        throw new Error("host exploded");
      },
    });
    const result = await port.commands?.();
    expect(result?.isErr()).toBe(true);
    expect(result?._unsafeUnwrapErr()).toEqual({ type: "PortThrew" });
  });

  it("classifies a missing directory as NotFound, not a failure", async () => {
    const port = createBunPiExtensionInventoryPort({});
    const listing = await port.listDirectory?.(
      "/tmp/weave-pi-inventory-port-absent-directory",
    );
    expect(listing?._unsafeUnwrapErr()).toEqual({ type: "NotFound" });
    const json = await port.readJson?.(
      "/tmp/weave-pi-inventory-port-absent-directory/package.json",
    );
    expect(json?._unsafeUnwrapErr()).toEqual({ type: "NotFound" });
  });
});

// ---------------------------------------------------------------------------
// Production host surfaces
// ---------------------------------------------------------------------------

const AGENT_DIR = "/tmp/weave-inventory-absent-agent-dir";
const PROJECT_DIR = "/tmp/weave-inventory-absent-project";

interface HostCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * Pi's public root exports, faked with the *whole* package-manager surface so
 * a call that installs, updates, removes, resolves, or writes settings is
 * observable — and provably never made.
 */
function fakeRootExports(options?: {
  readonly omitPackageManager?: boolean;
  readonly omitAgentDir?: boolean;
  readonly agentDir?: string;
  readonly throwOnConstruct?: boolean;
  readonly configuredPackages?: unknown;
}) {
  const calls: HostCall[] = [];
  const record = (method: string, args: readonly unknown[]): void => {
    calls.push({ method, args });
  };
  const forbidden = (method: string) => (): never => {
    record(method, []);
    throw new Error(`${method} must never run`);
  };

  class FakePackageManager {
    constructor(constructorOptions: unknown) {
      record("construct", [constructorOptions]);
      if (options?.throwOnConstruct === true) {
        throw new Error("package manager unavailable");
      }
    }
    listConfiguredPackages(): unknown {
      record("listConfiguredPackages", []);
      return (
        options?.configuredPackages ?? [
          {
            source: "npm:pi-vim",
            scope: "user",
            filtered: false,
            installedPath: VIM_PATH,
          },
        ]
      );
    }
    getInstalledPath(source: string, scope: string): unknown {
      record("getInstalledPath", [source, scope]);
      return source === "npm:pi-vim" && scope === "user" ? VIM_PATH : undefined;
    }
    resolve = forbidden("resolve");
    resolveExtensionSources = forbidden("resolveExtensionSources");
    install = forbidden("install");
    installAndPersist = forbidden("installAndPersist");
    update = forbidden("update");
    remove = forbidden("remove");
    removeAndPersist = forbidden("removeAndPersist");
    addSourceToSettings = forbidden("addSourceToSettings");
    removeSourceFromSettings = forbidden("removeSourceFromSettings");
    checkForAvailableUpdates = forbidden("checkForAvailableUpdates");
  }

  const SettingsManager = {
    create(cwd: string, agentDir: string, createOptions: unknown): unknown {
      record("SettingsManager.create", [cwd, agentDir, createOptions]);
      return { settings: "read-only" };
    },
    setProjectTrusted: forbidden("SettingsManager.setProjectTrusted"),
  };

  const rootExports: Record<string, unknown> = {
    ...(options?.omitAgentDir === true
      ? {}
      : { getAgentDir: () => options?.agentDir ?? AGENT_DIR }),
    SettingsManager,
    ...(options?.omitPackageManager === true
      ? {}
      : { DefaultPackageManager: FakePackageManager }),
  };
  return { calls, rootExports };
}

const HOST_COMMAND: PiCommandInfo = {
  name: "weave:health",
  source: "extension",
  sourceInfo: {
    path: `${AGENT_DIR}/extensions/weave-adapter-pi/dist/extension.js`,
    source: "local",
    scope: "user",
    origin: "top-level",
  },
};

const HOST_TOOL: PiToolInfo = {
  name: "weave_delegate",
  sourceInfo: HOST_COMMAND.sourceInfo,
};

describe("createPiExtensionInventoryHost", () => {
  it("wires every public host surface Pi exposes", async () => {
    const { rootExports } = fakeRootExports();
    const host = createPiExtensionInventoryHost({
      api: {
        getCommands: () => [HOST_COMMAND],
        getAllTools: () => [HOST_TOOL],
      },
      rootExports,
      cwd: PROJECT_DIR,
      trust: "trusted",
    });

    expect(host.commands?.()).toEqual([HOST_COMMAND]);
    expect(host.tools?.()).toEqual([HOST_TOOL]);
    expect(host.agentDirectory?.()).toBe(AGENT_DIR);
    expect(host.configuredPackages?.()).toEqual([
      { source: "npm:pi-vim", scope: "user", installedPath: VIM_PATH },
    ]);
    expect(host.installedPackagePath?.("npm:pi-vim", "user")).toBe(VIM_PATH);
    expect(host.installedPackagePath?.("npm:gone", "user")).toBeUndefined();

    const port = createBunPiExtensionInventoryPort(host);
    expect(port.commands).toBeDefined();
    expect(port.tools).toBeDefined();
    expect(port.configuredPackages).toBeDefined();
    expect(port.installedPackagePath).toBeDefined();
    expect(port.agentDirectory).toBeDefined();
    const packages = await port.configuredPackages?.();
    expect(packages?.isOk()).toBe(true);
  });

  it("builds the package manager read-only and never mutates or resolves", () => {
    const { calls, rootExports } = fakeRootExports();
    const host = createPiExtensionInventoryHost({
      api: { getCommands: () => [HOST_COMMAND] },
      rootExports,
      cwd: PROJECT_DIR,
      trust: "trusted",
    });
    host.configuredPackages?.();
    host.installedPackagePath?.("npm:pi-vim", "user");

    expect(calls.map((call) => call.method)).toEqual([
      "SettingsManager.create",
      "construct",
      "listConfiguredPackages",
      "getInstalledPath",
    ]);
    expect(calls[0]?.args).toEqual([
      PROJECT_DIR,
      AGENT_DIR,
      { projectTrusted: true },
    ]);
    expect(calls[1]?.args).toEqual([
      {
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        settingsManager: { settings: "read-only" },
      },
    ]);
  });

  it("passes withheld project trust through to the settings manager", () => {
    const { calls, rootExports } = fakeRootExports();
    createPiExtensionInventoryHost({
      api: {},
      rootExports,
      cwd: PROJECT_DIR,
      trust: "withheld",
    });
    expect(calls[0]?.args[2]).toEqual({ projectTrusted: false });
  });

  it("omits only the surfaces the host does not expose", () => {
    const withoutPackages = createPiExtensionInventoryHost({
      api: { getCommands: () => [HOST_COMMAND] },
      rootExports: fakeRootExports({ omitPackageManager: true }).rootExports,
      cwd: PROJECT_DIR,
      trust: "trusted",
    });
    expect(withoutPackages.agentDirectory?.()).toBe(AGENT_DIR);
    expect(withoutPackages.commands).toBeDefined();
    expect(withoutPackages.tools).toBeUndefined();
    expect(withoutPackages.configuredPackages).toBeUndefined();
    expect(withoutPackages.installedPackagePath).toBeUndefined();

    const withoutAgentDir = createPiExtensionInventoryHost({
      api: {},
      rootExports: fakeRootExports({ omitAgentDir: true }).rootExports,
      cwd: PROJECT_DIR,
      trust: "trusted",
    });
    expect(withoutAgentDir.agentDirectory).toBeUndefined();
    // Without a proven agent directory there is nothing to construct a
    // package manager with, so package evidence degrades rather than guesses.
    expect(withoutAgentDir.configuredPackages).toBeUndefined();

    const bare = createPiExtensionInventoryHost({
      api: {},
      cwd: PROJECT_DIR,
      trust: "trusted",
    });
    expect(bare).toEqual({});
  });

  it("degrades instead of throwing when the host constructor fails", () => {
    const host = createPiExtensionInventoryHost({
      api: {},
      rootExports: fakeRootExports({ throwOnConstruct: true }).rootExports,
      cwd: PROJECT_DIR,
      trust: "trusted",
    });
    expect(host.configuredPackages).toBeUndefined();
    expect(host.installedPackagePath).toBeUndefined();
    expect(host.agentDirectory?.()).toBe(AGENT_DIR);
  });
});

describe("projectConfiguredPackages", () => {
  it("reports an unreadable answer as undefined", () => {
    expect(projectConfiguredPackages(undefined)).toBeUndefined();
    expect(projectConfiguredPackages({ packages: [] })).toBeUndefined();
  });

  it("keeps well-formed entries and drops the rest", () => {
    expect(
      projectConfiguredPackages([
        { source: "npm:pi-vim", scope: "user", installedPath: VIM_PATH },
        { source: "npm:no-path", scope: "project" },
        { source: 42, scope: "user" },
        { source: "npm:bad-scope", scope: "temporary" },
        null,
        { source: "npm:bad-path", scope: "user", installedPath: 7 },
      ]),
    ).toEqual([
      { source: "npm:pi-vim", scope: "user", installedPath: VIM_PATH },
      { source: "npm:no-path", scope: "project" },
      { source: "npm:bad-path", scope: "user" },
    ]);
  });
});

describe("resolveOwnExtensionEntryPath", () => {
  const RECORDED = "/checkout/packages/adapters/pi/dist/extension.js";
  const HOST_REPORTED = `${AGENT_DIR}/extensions/weave-adapter-pi/dist/extension.js`;

  function identifier(map: Readonly<Record<string, string>>) {
    const probes: string[] = [];
    return {
      probes,
      identify: async (path: string): Promise<string | undefined> => {
        probes.push(path);
        return map[path];
      },
    };
  }

  it("returns the recorded path, unprobed, when the host reports it exactly", async () => {
    const { probes, identify } = identifier({});
    const resolved = await resolveOwnExtensionEntryPath({
      recordedEntryPath: RECORDED,
      candidatePaths: [VIM_PATH, RECORDED],
      identify,
    });
    expect(resolved).toBe(RECORDED);
    expect(probes).toEqual([]);
  });

  it("proves a symlinked host path is the same file", async () => {
    const { probes, identify } = identifier({
      [RECORDED]: "16777232:1",
      [HOST_REPORTED]: "16777232:1",
      [VIM_PATH]: "16777232:2",
    });
    const resolved = await resolveOwnExtensionEntryPath({
      recordedEntryPath: RECORDED,
      candidatePaths: [VIM_PATH, HOST_REPORTED, HOST_REPORTED],
      identify,
    });
    expect(resolved).toBe(HOST_REPORTED);
    // Own identity once, then each distinct candidate until one matches.
    expect(probes).toEqual([RECORDED, VIM_PATH, HOST_REPORTED]);
  });

  it("keeps the recorded path when nothing proves identical", async () => {
    const { identify } = identifier({ [RECORDED]: "16777232:1" });
    expect(
      await resolveOwnExtensionEntryPath({
        recordedEntryPath: RECORDED,
        candidatePaths: [VIM_PATH],
        identify,
      }),
    ).toBe(RECORDED);
  });

  it("keeps the recorded path when the filesystem cannot identify it", async () => {
    expect(
      await resolveOwnExtensionEntryPath({
        recordedEntryPath: RECORDED,
        candidatePaths: [HOST_REPORTED],
        identify: () => Promise.reject(new Error("stat failed")),
      }),
    ).toBe(RECORDED);
  });

  it("never invents a path without the loader fact", async () => {
    const { probes, identify } = identifier({});
    expect(
      await resolveOwnExtensionEntryPath({
        candidatePaths: [HOST_REPORTED],
        identify,
      }),
    ).toBeUndefined();
    expect(
      await resolveOwnExtensionEntryPath({
        recordedEntryPath: "relative/dist/extension.js",
        candidatePaths: [HOST_REPORTED],
        identify,
      }),
    ).toBeUndefined();
    expect(probes).toEqual([]);
  });

  it("bounds the number of identity probes", async () => {
    const candidatePaths = Array.from(
      { length: MAX_OWN_ENTRY_IDENTITY_PROBES + 20 },
      (_value, index) => `/opt/extensions/candidate-${index}.js`,
    );
    const { probes, identify } = identifier({ [RECORDED]: "16777232:1" });
    const resolved = await resolveOwnExtensionEntryPath({
      recordedEntryPath: RECORDED,
      candidatePaths,
      identify,
    });
    expect(resolved).toBe(RECORDED);
    expect(probes).toHaveLength(MAX_OWN_ENTRY_IDENTITY_PROBES + 1);
  });
});

describe("collectPiExtensionInventoryFromHost", () => {
  const HOST_REPORTED = HOST_COMMAND.sourceInfo.path;
  const LOADER_ENTRY = "/checkout/packages/adapters/pi/dist/extension.js";
  const OVERRIDE_ENV = { WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE: "1" };
  const SAME_FILE = async (path: string): Promise<string | undefined> =>
    path === HOST_REPORTED || path === LOADER_ENTRY ? "16777232:1" : undefined;

  function collect(input: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly ownEntryPath?: string;
    readonly identify?: (path: string) => Promise<string | undefined>;
  }) {
    const { rootExports } = fakeRootExports();
    return collectPiExtensionInventoryFromHost({
      api: {
        getCommands: () => [HOST_COMMAND],
        getAllTools: () => [HOST_TOOL],
      },
      rootExports,
      cwd: PROJECT_DIR,
      trust: "trusted",
      ...input,
    });
  }

  it("is not degraded when every public host surface answers", async () => {
    // A real installed package directory: this adapter's own, whose manifest
    // declares a `pi.extensions` entry. Read-only, and never loaded.
    const installedPath = Bun.fileURLToPath(
      new URL("../..", import.meta.url),
    ).replace(/\/$/, "");
    const { rootExports } = fakeRootExports({
      configuredPackages: [
        {
          source: "npm:pi-vim",
          scope: "user",
          filtered: false,
          installedPath,
        },
      ],
    });
    const collected = await collectPiExtensionInventoryFromHost({
      api: {
        getCommands: () => [HOST_COMMAND],
        getAllTools: () => [HOST_TOOL],
      },
      rootExports,
      cwd: PROJECT_DIR,
      trust: "trusted",
      env: {},
    });

    expect(collected.isOk()).toBe(true);
    const inventory = collected._unsafeUnwrap();
    expect(inventory.entries.map((item) => item.id)).toEqual([
      HOST_REPORTED,
      "npm:pi-vim",
    ]);
    const packageEntry = inventory.entries.find(
      (item) => item.id === "npm:pi-vim",
    );
    expect(packageEntry?.evidence).toEqual(["configured-package"]);
    expect(packageEntry?.available).toBe(true);
    expect(packageEntry?.path).toBe(installedPath);
    expect(inventory.projectScanned).toBe(true);
  });

  it("marks the loader's own file mandatory through a symlinked host path", async () => {
    const collected = await collect({
      env: OVERRIDE_ENV,
      ownEntryPath: LOADER_ENTRY,
      identify: SAME_FILE,
    });
    const inventory = collected.match(
      (value) => value,
      (degradation) => degradation.inventory,
    );
    const own = inventory.entries.find((item) => item.id === HOST_REPORTED);
    expect(own?.mandatory).toBe(true);
    expect(own?.path).toBe(HOST_REPORTED);
    expect(inventory.entries.filter((item) => item.mandatory)).toHaveLength(1);
  });

  it("marks nothing mandatory without the exact provenance override", async () => {
    for (const env of [
      {},
      { WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE: "0" },
      { WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE: "true" },
    ]) {
      const collected = await collect({
        env,
        ownEntryPath: LOADER_ENTRY,
        identify: SAME_FILE,
      });
      const inventory = collected.match(
        (value) => value,
        (degradation) => degradation.inventory,
      );
      expect(inventory.entries.every((item) => !item.mandatory)).toBe(true);
    }
  });

  it("marks nothing mandatory when no file matches the loader fact", async () => {
    const collected = await collect({
      env: OVERRIDE_ENV,
      ownEntryPath: LOADER_ENTRY,
      identify: async () => undefined,
    });
    const inventory = collected.match(
      (value) => value,
      (degradation) => degradation.inventory,
    );
    expect(inventory.entries.every((item) => !item.mandatory)).toBe(true);
  });

  it("reads the loader fact from the set-once accessor by default", async () => {
    // Latches only if no other suite in this process already did; either way
    // the authoritative value is what production would read.
    recordPiExtensionEntryPath(LOADER_ENTRY);
    const latched = getPiExtensionEntryPath();
    expect(latched).toBeDefined();
    const collected = await collect({
      env: OVERRIDE_ENV,
      identify: async (path) =>
        path === HOST_REPORTED || path === latched ? "16777232:9" : undefined,
    });
    const inventory = collected.match(
      (value) => value,
      (degradation) => degradation.inventory,
    );
    expect(
      inventory.entries.find((item) => item.id === HOST_REPORTED)?.mandatory,
    ).toBe(true);
  });
});
