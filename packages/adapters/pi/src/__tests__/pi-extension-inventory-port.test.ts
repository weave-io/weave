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
import type {
  PiExtensionInventory,
  PiExtensionInventoryDegradation,
  PiExtensionInventoryEntry,
} from "../pi-extension-inventory.js";
import {
  createBunPiExtensionInventoryPort,
  renderChildExtensionArgs,
  resolveChildExtensionSpawnArgs,
} from "../pi-extension-inventory-port.js";
import type { PiCommandInfo } from "../types.js";

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
    // Package evidence needs a host `SettingsManager` this extension is never
    // handed, so those members are deliberately never provided.
    expect(port.configuredPackages).toBeUndefined();
    expect(port.installedPackagePath).toBeUndefined();
  });

  it("forwards a host accessor's value", async () => {
    const port = createBunPiExtensionInventoryPort({
      commands: () => [command],
      agentDirectory: () => "/home/dev/.pi/agent",
    });
    const commands = await port.commands?.();
    expect(commands?._unsafeUnwrap()).toEqual([command]);
    const agentDir = await port.agentDirectory?.();
    expect(agentDir?._unsafeUnwrap()).toBe("/home/dev/.pi/agent");
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
