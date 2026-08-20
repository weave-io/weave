import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { ChildExtensionInventoryEntry } from "../child-extension-selection.js";
import { ADAPTER_PACKAGE_IDENTITY } from "../commands.js";
import {
  type CollectPiExtensionInventoryOptions,
  collectPiExtensionInventory,
  MAX_PI_EXTENSION_CONFIGURED_PACKAGES,
  MAX_PI_EXTENSION_DIRECTORY_ENTRIES,
  MAX_PI_EXTENSION_INVENTORY_ENTRIES,
  MAX_PI_EXTENSION_MANIFEST_ENTRIES,
  PI_EXTENSION_INVENTORY_DEGRADATION_REASONS,
  type PiExtensionInventory,
  type PiExtensionInventoryConfiguredPackage,
  type PiExtensionInventoryDegradation,
  type PiExtensionInventoryDirectoryEntry,
  type PiExtensionInventoryEntry,
  type PiExtensionInventoryPort,
  type PiExtensionInventoryPortError,
  type PiExtensionInventoryToolInfo,
  WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV,
} from "../pi-extension-inventory.js";
import type { PiCommandInfo, PiSourceInfo } from "../types.js";

const AGENT_DIR = "/home/dev/.pi/agent";
const AGENT_EXTENSIONS = `${AGENT_DIR}/extensions`;
const PROJECT_ROOT = "/work/repo";
const PROJECT_EXTENSIONS = `${PROJECT_ROOT}/.pi/extensions`;
const WEAVE_PACKAGE_DIR = `${AGENT_DIR}/npm/node_modules/${ADAPTER_PACKAGE_IDENTITY}`;
const WEAVE_ENTRY = `${WEAVE_PACKAGE_DIR}/dist/extension.js`;
const WEAVE_SOURCE = `npm:${ADAPTER_PACKAGE_IDENTITY}`;

const NO_ENV = {} as const;
const OVERRIDE_ENV = {
  [WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV]: "1",
} as const;

/** Deterministic, fully-scripted port. Performs no I/O and no host calls. */
interface FakePortScript {
  readonly commands?: readonly PiCommandInfo[];
  readonly commandsError?: PiExtensionInventoryPortError;
  readonly tools?: readonly PiExtensionInventoryToolInfo[];
  readonly toolsError?: PiExtensionInventoryPortError;
  readonly configuredPackages?: readonly PiExtensionInventoryConfiguredPackage[];
  readonly configuredPackagesError?: PiExtensionInventoryPortError;
  readonly installedPaths?: Readonly<Record<string, string>>;
  readonly installedPathError?: PiExtensionInventoryPortError;
  readonly agentDirectory?: string;
  readonly agentDirectoryError?: PiExtensionInventoryPortError;
  readonly directories?: Readonly<
    Record<string, readonly PiExtensionInventoryDirectoryEntry[]>
  >;
  readonly jsonFiles?: Readonly<Record<string, unknown>>;
  readonly jsonError?: PiExtensionInventoryPortError;
  /** Members deliberately absent from the port. */
  readonly omit?: readonly (keyof PiExtensionInventoryPort)[];
  /** Members that throw synchronously instead of returning a Result. */
  readonly throwOn?: readonly (keyof PiExtensionInventoryPort)[];
}

function file(name: string): PiExtensionInventoryDirectoryEntry {
  return { name, kind: "file" };
}

function directory(name: string): PiExtensionInventoryDirectoryEntry {
  return { name, kind: "directory" };
}

function sourceInfo(overrides: Partial<PiSourceInfo>): PiSourceInfo {
  return {
    path: "/extensions/example.ts",
    source: "local",
    scope: "user",
    origin: "top-level",
    ...overrides,
  };
}

function extensionCommand(
  name: string,
  info: PiSourceInfo,
  source: PiCommandInfo["source"] = "extension",
): PiCommandInfo {
  return { name, source, sourceInfo: info };
}

function createPort(script: FakePortScript): PiExtensionInventoryPort {
  const omit = new Set(script.omit ?? []);
  const throwOn = new Set(script.throwOn ?? []);
  const port: {
    [K in keyof PiExtensionInventoryPort]: PiExtensionInventoryPort[K];
  } = {};

  if (!omit.has("commands")) {
    port.commands = (): ResultAsync<
      readonly PiCommandInfo[],
      PiExtensionInventoryPortError
    > => {
      if (throwOn.has("commands")) throw new Error("commands exploded");
      if (script.commandsError !== undefined) {
        return errAsync(script.commandsError);
      }
      return okAsync(script.commands ?? []);
    };
  }
  if (!omit.has("tools")) {
    port.tools = (): ResultAsync<
      readonly PiExtensionInventoryToolInfo[],
      PiExtensionInventoryPortError
    > => {
      if (script.toolsError !== undefined) return errAsync(script.toolsError);
      return okAsync(script.tools ?? []);
    };
  }
  if (!omit.has("configuredPackages")) {
    port.configuredPackages = (): ResultAsync<
      readonly PiExtensionInventoryConfiguredPackage[],
      PiExtensionInventoryPortError
    > => {
      if (script.configuredPackagesError !== undefined) {
        return errAsync(script.configuredPackagesError);
      }
      return okAsync(script.configuredPackages ?? []);
    };
  }
  if (!omit.has("installedPackagePath")) {
    port.installedPackagePath = (
      source: string,
    ): ResultAsync<string, PiExtensionInventoryPortError> => {
      if (script.installedPathError !== undefined) {
        return errAsync(script.installedPathError);
      }
      const installed = script.installedPaths?.[source];
      if (installed === undefined) return errAsync({ type: "NotFound" });
      return okAsync(installed);
    };
  }
  if (!omit.has("agentDirectory")) {
    port.agentDirectory = (): ResultAsync<
      string,
      PiExtensionInventoryPortError
    > => {
      if (script.agentDirectoryError !== undefined) {
        return errAsync(script.agentDirectoryError);
      }
      if (script.agentDirectory === undefined) {
        return errAsync({ type: "NotFound" });
      }
      return okAsync(script.agentDirectory);
    };
  }
  if (!omit.has("listDirectory")) {
    port.listDirectory = (
      path: string,
    ): ResultAsync<
      readonly PiExtensionInventoryDirectoryEntry[],
      PiExtensionInventoryPortError
    > => {
      const listing = script.directories?.[path];
      if (listing === undefined) return errAsync({ type: "NotFound" });
      return okAsync(listing);
    };
  }
  if (!omit.has("readJson")) {
    port.readJson = (
      path: string,
    ): ResultAsync<unknown, PiExtensionInventoryPortError> => {
      if (script.jsonError !== undefined) return errAsync(script.jsonError);
      if (script.jsonFiles === undefined) return errAsync({ type: "NotFound" });
      if (!Object.hasOwn(script.jsonFiles, path)) {
        return errAsync({ type: "NotFound" });
      }
      return okAsync(script.jsonFiles[path]);
    };
  }
  return port;
}

const BASE_OPTIONS: CollectPiExtensionInventoryOptions = {
  trust: "trusted",
  cwd: PROJECT_ROOT,
  env: NO_ENV,
};

async function collect(
  script: FakePortScript,
  options: Partial<CollectPiExtensionInventoryOptions> = {},
): Promise<{
  readonly inventory: PiExtensionInventory;
  readonly reasons: readonly string[];
  readonly degraded: boolean;
}> {
  const result = await collectPiExtensionInventory(createPort(script), {
    ...BASE_OPTIONS,
    ...options,
  });
  return result.match(
    (inventory) => ({ inventory, reasons: [], degraded: false }),
    (degradation: PiExtensionInventoryDegradation) => ({
      inventory: degradation.inventory,
      reasons: degradation.reasons,
      degraded: true,
    }),
  );
}

function byId(
  inventory: PiExtensionInventory,
  id: string,
): PiExtensionInventoryEntry | undefined {
  return inventory.entries.find((entry) => entry.id === id);
}

/**
 * Script covering every port member so a successful collection is possible.
 * Individual tests narrow it.
 */
const COMPLETE_SCRIPT: FakePortScript = {
  commands: [],
  tools: [],
  configuredPackages: [],
  agentDirectory: AGENT_DIR,
  directories: {},
  jsonFiles: {},
};

describe("collectPiExtensionInventory bounds", () => {
  it("documents the caps this module enforces", () => {
    expect(MAX_PI_EXTENSION_INVENTORY_ENTRIES).toBe(200);
    expect(MAX_PI_EXTENSION_DIRECTORY_ENTRIES).toBe(128);
    expect(MAX_PI_EXTENSION_MANIFEST_ENTRIES).toBe(16);
    expect(MAX_PI_EXTENSION_CONFIGURED_PACKAGES).toBe(64);
  });

  it("keeps the degradation reason set closed and unique", () => {
    const unique = new Set(PI_EXTENSION_INVENTORY_DEGRADATION_REASONS);
    expect(unique.size).toBe(PI_EXTENSION_INVENTORY_DEGRADATION_REASONS.length);
  });
});

describe("collectPiExtensionInventory evidence union", () => {
  it("unions loaded, configured-package, and discovered-file evidence", async () => {
    const { inventory, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      commands: [
        extensionCommand(
          "vim:mode",
          sourceInfo({
            origin: "package",
            source: "npm:pi-vim",
            scope: "user",
            path: "/home/dev/.pi/agent/npm/node_modules/pi-vim/dist/index.js",
          }),
        ),
      ],
      tools: [
        {
          name: "notes",
          sourceInfo: sourceInfo({ path: `${AGENT_EXTENSIONS}/notes.ts` }),
        },
      ],
      configuredPackages: [{ source: "npm:pi-vim", scope: "user" }],
      installedPaths: {
        "npm:pi-vim": "/home/dev/.pi/agent/npm/node_modules/pi-vim",
      },
      directories: {
        [AGENT_EXTENSIONS]: [file("notes.ts"), file("learn.ts")],
      },
      jsonFiles: {
        "/home/dev/.pi/agent/npm/node_modules/pi-vim/package.json": {
          pi: { extensions: ["./dist/index.js"] },
        },
      },
    });

    expect(degraded).toBe(false);
    expect(inventory.truncated).toBe(false);
    expect(inventory.entries.map((entry) => entry.id)).toEqual([
      `${AGENT_EXTENSIONS}/learn.ts`,
      `${AGENT_EXTENSIONS}/notes.ts`,
      "npm:pi-vim",
    ]);

    const vim = byId(inventory, "npm:pi-vim");
    expect(vim?.evidence).toEqual(["loaded", "configured-package"]);
    // The installed directory outranks the loaded entry file: `-e <dir>` makes
    // Pi resolve exactly the entries it would have loaded itself.
    expect(vim?.path).toBe("/home/dev/.pi/agent/npm/node_modules/pi-vim");
    expect(vim?.origin).toBe("package");
    expect(vim?.label).toBe("pi-vim");
    expect(vim?.available).toBe(true);

    const notes = byId(inventory, `${AGENT_EXTENSIONS}/notes.ts`);
    expect(notes?.evidence).toEqual(["loaded", "discovered-file"]);
    expect(notes?.scope).toBe("user");
    expect(notes?.label).toBe("notes.ts");

    const learn = byId(inventory, `${AGENT_EXTENSIONS}/learn.ts`);
    expect(learn?.evidence).toEqual(["discovered-file"]);
    expect(learn?.available).toBe(true);
  });

  it("deduplicates one identity seen many times", async () => {
    const info = sourceInfo({ path: `${AGENT_EXTENSIONS}/notes.ts` });
    const { inventory } = await collect({
      ...COMPLETE_SCRIPT,
      commands: [
        extensionCommand("notes:add", info),
        extensionCommand("notes:list", info),
      ],
      tools: [{ name: "notes", sourceInfo: info }],
      directories: { [AGENT_EXTENSIONS]: [file("notes.ts")] },
    });

    expect(inventory.entries).toHaveLength(1);
    expect(inventory.entries[0]?.evidence).toEqual([
      "loaded",
      "discovered-file",
    ]);
  });

  it("ignores prompts, skills, and synthetic builtin resources", async () => {
    const { inventory, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      commands: [
        extensionCommand(
          "review",
          sourceInfo({ path: `${AGENT_DIR}/prompts/review.md` }),
          "prompt",
        ),
        extensionCommand(
          "research",
          sourceInfo({ path: `${AGENT_DIR}/skills/research/SKILL.md` }),
          "skill",
        ),
      ],
      tools: [
        {
          name: "read",
          sourceInfo: sourceInfo({
            path: "<builtin:read>",
            source: "builtin",
            scope: "temporary",
          }),
        },
        { name: "orphan" },
      ],
    });

    expect(degraded).toBe(false);
    expect(inventory.entries).toEqual([]);
  });

  it("scans an extension subdirectory through its manifest, then its index", async () => {
    const { inventory, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      directories: {
        [AGENT_EXTENSIONS]: [directory("packaged"), directory("indexed")],
        [`${AGENT_EXTENSIONS}/indexed`]: [file("index.ts"), file("helper.ts")],
      },
      jsonFiles: {
        [`${AGENT_EXTENSIONS}/packaged/package.json`]: {
          pi: { extensions: ["dist/extension.js", "../escape.js"] },
        },
      },
    });

    expect(inventory.entries.map((entry) => entry.id)).toEqual([
      `${AGENT_EXTENSIONS}/indexed/index.ts`,
      `${AGENT_EXTENSIONS}/packaged/dist/extension.js`,
    ]);
    // The escaping manifest entry is refused, and refusal is a degradation.
    expect(degraded).toBe(true);
  });
});

describe("collectPiExtensionInventory mandatory marking", () => {
  it("marks the adapter mandatory from package provenance alone", async () => {
    const { inventory } = await collect({
      ...COMPLETE_SCRIPT,
      commands: [
        extensionCommand(
          "weave:health",
          sourceInfo({
            origin: "package",
            source: WEAVE_SOURCE,
            scope: "user",
            path: WEAVE_ENTRY,
          }),
        ),
      ],
      configuredPackages: [{ source: WEAVE_SOURCE, scope: "user" }],
      installedPaths: { [WEAVE_SOURCE]: WEAVE_PACKAGE_DIR },
      jsonFiles: {
        [`${WEAVE_PACKAGE_DIR}/package.json`]: {
          pi: { extensions: ["./dist/extension.js"] },
        },
      },
    });

    const weave = byId(inventory, WEAVE_SOURCE);
    expect(weave?.mandatory).toBe(true);
    expect(weave?.available).toBe(true);
    expect(inventory.entries[0]?.id).toBe(WEAVE_SOURCE);
  });

  it("marks the supplied loader entry mandatory under the provenance override", async () => {
    const { inventory } = await collect(
      {
        ...COMPLETE_SCRIPT,
        commands: [
          extensionCommand(
            "weave:health",
            sourceInfo({ path: WEAVE_ENTRY, scope: "user" }),
          ),
        ],
      },
      { env: OVERRIDE_ENV, ownEntryPath: WEAVE_ENTRY },
    );

    const weave = byId(inventory, WEAVE_ENTRY);
    expect(weave?.mandatory).toBe(true);
    expect(weave?.origin).toBe("top-level");
  });

  it("never marks a path-loaded adapter mandatory without the override", async () => {
    const { inventory } = await collect(
      {
        ...COMPLETE_SCRIPT,
        commands: [
          extensionCommand(
            "weave:health",
            sourceInfo({ path: WEAVE_ENTRY, scope: "user" }),
          ),
        ],
      },
      { env: NO_ENV, ownEntryPath: WEAVE_ENTRY },
    );

    expect(byId(inventory, WEAVE_ENTRY)?.mandatory).toBe(false);
  });

  it("never infers a mandatory path when the override lacks the loader fact", async () => {
    const { inventory } = await collect(
      {
        ...COMPLETE_SCRIPT,
        commands: [
          extensionCommand(
            "weave:health",
            sourceInfo({ path: WEAVE_ENTRY, scope: "user" }),
          ),
        ],
        directories: {
          [AGENT_EXTENSIONS]: [file("weave-adapter-pi.js")],
        },
      },
      { env: OVERRIDE_ENV },
    );

    expect(inventory.entries.every((entry) => !entry.mandatory)).toBe(true);
  });

  it("ignores a stale override path that no evidence produced", async () => {
    const { inventory } = await collect(
      {
        ...COMPLETE_SCRIPT,
        commands: [
          extensionCommand(
            "weave:health",
            sourceInfo({ path: WEAVE_ENTRY, scope: "user" }),
          ),
        ],
      },
      { env: OVERRIDE_ENV, ownEntryPath: "/moved/away/dist/extension.js" },
    );

    expect(inventory.entries).toHaveLength(1);
    expect(inventory.entries[0]?.mandatory).toBe(false);
  });
});

describe("collectPiExtensionInventory degradation", () => {
  it("returns a partial inventory when host APIs are missing", async () => {
    const { inventory, reasons, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      commands: [
        extensionCommand(
          "notes:add",
          sourceInfo({ path: `${AGENT_EXTENSIONS}/notes.ts` }),
        ),
      ],
      omit: [
        "tools",
        "configuredPackages",
        "agentDirectory",
        "listDirectory",
        "readJson",
      ],
    });

    expect(degraded).toBe(true);
    expect(reasons).toEqual([
      "tools-unavailable",
      "configured-packages-unavailable",
      "agent-directory-unavailable",
      "directory-listing-unavailable",
    ]);
    expect(inventory.entries.map((entry) => entry.id)).toEqual([
      `${AGENT_EXTENSIONS}/notes.ts`,
    ]);
    expect(inventory.projectScanned).toBe(false);
  });

  it("reports failing host calls without losing gathered evidence", async () => {
    const { inventory, reasons, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      commandsError: { type: "HostCallFailed" },
      configuredPackagesError: { type: "Unsupported" },
      agentDirectoryError: { type: "HostCallFailed" },
      tools: [
        {
          name: "notes",
          sourceInfo: sourceInfo({ path: `${AGENT_EXTENSIONS}/notes.ts` }),
        },
      ],
      directories: { [PROJECT_EXTENSIONS]: [file("local.ts")] },
    });

    expect(degraded).toBe(true);
    expect(reasons).toEqual([
      "commands-failed",
      "configured-packages-failed",
      "agent-directory-failed",
    ]);
    expect(inventory.entries.map((entry) => entry.id)).toEqual([
      `${AGENT_EXTENSIONS}/notes.ts`,
      `${PROJECT_EXTENSIONS}/local.ts`,
    ]);
    expect(inventory.projectScanned).toBe(true);
  });

  it("captures a throwing port member instead of propagating it", async () => {
    const { reasons, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      throwOn: ["commands"],
    });

    expect(degraded).toBe(true);
    expect(reasons).toEqual(["commands-failed"]);
  });

  it("treats a missing extensions directory as an ordinary answer", async () => {
    const { inventory, reasons, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      directories: {},
    });

    expect(degraded).toBe(false);
    expect(reasons).toEqual([]);
    expect(inventory.entries).toEqual([]);
  });

  it("treats a manifest without a pi field as declaring nothing", async () => {
    const { reasons, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      directories: {
        [AGENT_EXTENSIONS]: [directory("plain")],
        [`${AGENT_EXTENSIONS}/plain`]: [file("index.js")],
      },
      jsonFiles: {
        [`${AGENT_EXTENSIONS}/plain/package.json`]: { name: "plain" },
      },
    });

    expect(degraded).toBe(false);
    expect(reasons).toEqual([]);
  });

  it("reports an unreadable package manifest", async () => {
    const { inventory, reasons, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      directories: {
        [AGENT_EXTENSIONS]: [directory("broken")],
        [`${AGENT_EXTENSIONS}/broken`]: [file("index.ts")],
      },
      jsonError: { type: "HostCallFailed" },
    });

    expect(degraded).toBe(true);
    expect(reasons).toEqual(["package-manifest-unreadable"]);
    // An unreadable manifest still leaves the index-file fallback usable.
    expect(inventory.entries.map((entry) => entry.id)).toEqual([
      `${AGENT_EXTENSIONS}/broken/index.ts`,
    ]);
  });

  it("reports an invalid pi.extensions field", async () => {
    const { reasons, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      directories: { [AGENT_EXTENSIONS]: [directory("broken")] },
      jsonFiles: {
        [`${AGENT_EXTENSIONS}/broken/package.json`]: {
          pi: { extensions: "dist/extension.js" },
        },
      },
    });

    expect(degraded).toBe(true);
    expect(reasons).toEqual(["package-manifest-invalid"]);
  });

  it("rejects an unsafe agent directory", async () => {
    const { reasons, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      agentDirectory: "relative/agent",
    });

    expect(degraded).toBe(true);
    expect(reasons).toEqual(["agent-directory-unsafe"]);
  });
});

describe("collectPiExtensionInventory package availability", () => {
  it("marks a configured package with no installed path unavailable", async () => {
    const { inventory } = await collect({
      ...COMPLETE_SCRIPT,
      configuredPackages: [{ source: "npm:pi-missing", scope: "user" }],
    });

    const missing = byId(inventory, "npm:pi-missing");
    expect(missing?.available).toBe(false);
    expect(missing?.path).toBe("");
    expect(missing?.evidence).toEqual(["configured-package"]);
    expect(missing?.label).toBe("pi-missing");
  });

  it("marks an installed package with an unreadable manifest unavailable", async () => {
    const { inventory, reasons } = await collect({
      ...COMPLETE_SCRIPT,
      configuredPackages: [
        {
          source: "npm:pi-opaque",
          scope: "project",
          installedPath: "/packages/pi-opaque",
        },
      ],
      omit: ["readJson"],
    });

    const opaque = byId(inventory, "npm:pi-opaque");
    expect(opaque?.available).toBe(false);
    expect(opaque?.path).toBe("/packages/pi-opaque");
    expect(opaque?.scope).toBe("project");
    expect(reasons).toContain("json-read-unavailable");
  });

  it("omits a package that declares no extensions and never loaded", async () => {
    const { inventory, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      configuredPackages: [
        {
          source: "npm:pi-skills",
          scope: "user",
          installedPath: "/packages/pi-skills",
        },
      ],
      jsonFiles: {
        "/packages/pi-skills/package.json": { pi: { skills: ["./skills"] } },
      },
    });

    expect(degraded).toBe(false);
    expect(inventory.entries).toEqual([]);
  });

  it("upgrades a loaded package path to its installed directory", async () => {
    const { inventory } = await collect({
      ...COMPLETE_SCRIPT,
      commands: [
        extensionCommand(
          "indexed:go",
          sourceInfo({
            origin: "package",
            source: "npm:pi-indexed",
            scope: "user",
            path: "/packages/pi-indexed/index.js",
          }),
        ),
      ],
      configuredPackages: [
        {
          source: "npm:pi-indexed",
          scope: "user",
          installedPath: "/packages/pi-indexed",
        },
      ],
      jsonFiles: {
        "/packages/pi-indexed/package.json": { name: "pi-indexed" },
      },
    });

    const indexed = byId(inventory, "npm:pi-indexed");
    expect(indexed?.path).toBe("/packages/pi-indexed");
    expect(indexed?.available).toBe(true);
    expect(indexed?.evidence).toEqual(["loaded", "configured-package"]);
  });

  it("falls back to getInstalledPath when the package omits its path", async () => {
    const { inventory, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      configuredPackages: [{ source: "npm:pi-vim", scope: "user" }],
      installedPaths: { "npm:pi-vim": "/packages/pi-vim" },
      jsonFiles: {
        "/packages/pi-vim/package.json": { pi: { extensions: ["index.js"] } },
      },
    });

    expect(degraded).toBe(false);
    expect(byId(inventory, "npm:pi-vim")?.path).toBe("/packages/pi-vim");
  });

  it("reports a failing installed-path lookup", async () => {
    const { reasons, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      configuredPackages: [{ source: "npm:pi-vim", scope: "user" }],
      installedPathError: { type: "HostCallFailed" },
    });

    expect(degraded).toBe(true);
    expect(reasons).toEqual(["installed-path-failed"]);
  });
});

describe("collectPiExtensionInventory truncation", () => {
  it("caps the inventory across evidence sources and flags truncation", async () => {
    // Two full directory listings exceed the inventory cap together, which
    // the per-directory cap alone cannot reach.
    const listing = (prefix: string) =>
      Array.from({ length: MAX_PI_EXTENSION_DIRECTORY_ENTRIES }, (_, index) =>
        file(`${prefix}-${String(index).padStart(4, "0")}.ts`),
      );
    const { inventory, degraded } = await collect({
      ...COMPLETE_SCRIPT,
      directories: {
        [AGENT_EXTENSIONS]: listing("user"),
        [PROJECT_EXTENSIONS]: listing("project"),
      },
    });

    expect(degraded).toBe(false);
    expect(inventory.entries).toHaveLength(MAX_PI_EXTENSION_INVENTORY_ENTRIES);
    expect(inventory.truncated).toBe(true);
  });

  it("caps one directory listing", async () => {
    const overflow = MAX_PI_EXTENSION_DIRECTORY_ENTRIES + 5;
    const listing = Array.from({ length: overflow }, (_, index) =>
      file(`ext-${String(index).padStart(4, "0")}.ts`),
    );
    const { inventory } = await collect({
      ...COMPLETE_SCRIPT,
      directories: { [AGENT_EXTENSIONS]: listing },
    });

    expect(inventory.entries).toHaveLength(MAX_PI_EXTENSION_DIRECTORY_ENTRIES);
    expect(inventory.truncated).toBe(true);
  });

  it("caps declared manifest entries", async () => {
    const declared = Array.from(
      { length: MAX_PI_EXTENSION_MANIFEST_ENTRIES + 3 },
      (_, index) => `dist/ext-${String(index).padStart(2, "0")}.js`,
    );
    const { inventory } = await collect({
      ...COMPLETE_SCRIPT,
      directories: { [AGENT_EXTENSIONS]: [directory("many")] },
      jsonFiles: {
        [`${AGENT_EXTENSIONS}/many/package.json`]: {
          pi: { extensions: declared },
        },
      },
    });

    expect(inventory.entries).toHaveLength(MAX_PI_EXTENSION_MANIFEST_ENTRIES);
    expect(inventory.truncated).toBe(true);
  });

  it("caps configured packages", async () => {
    const packages = Array.from(
      { length: MAX_PI_EXTENSION_CONFIGURED_PACKAGES + 4 },
      (_, index) => ({
        source: `npm:pkg-${String(index).padStart(3, "0")}`,
        scope: "user" as const,
      }),
    );
    const { inventory } = await collect({
      ...COMPLETE_SCRIPT,
      configuredPackages: packages,
    });

    expect(inventory.entries).toHaveLength(
      MAX_PI_EXTENSION_CONFIGURED_PACKAGES,
    );
    expect(inventory.truncated).toBe(true);
  });
});

describe("collectPiExtensionInventory project trust", () => {
  it("skips the project scan when trust is withheld", async () => {
    const { inventory, degraded } = await collect(
      {
        ...COMPLETE_SCRIPT,
        directories: {
          [AGENT_EXTENSIONS]: [file("user.ts")],
          [PROJECT_EXTENSIONS]: [file("project.ts")],
        },
      },
      { trust: "withheld" },
    );

    expect(degraded).toBe(false);
    expect(inventory.projectScanned).toBe(false);
    expect(inventory.entries.map((entry) => entry.id)).toEqual([
      `${AGENT_EXTENSIONS}/user.ts`,
    ]);
  });

  it("scans the project extensions directory when trusted", async () => {
    const { inventory } = await collect({
      ...COMPLETE_SCRIPT,
      directories: {
        [AGENT_EXTENSIONS]: [file("user.ts")],
        [PROJECT_EXTENSIONS]: [file("project.ts")],
      },
    });

    expect(inventory.projectScanned).toBe(true);
    expect(byId(inventory, `${PROJECT_EXTENSIONS}/project.ts`)?.scope).toBe(
      "project",
    );
  });

  it("skips the project scan when no project root is known", async () => {
    const { inventory, degraded } = await collect(
      { ...COMPLETE_SCRIPT },
      { cwd: undefined },
    );

    expect(degraded).toBe(false);
    expect(inventory.projectScanned).toBe(false);
  });

  it("refuses an unsafe project root", async () => {
    const { reasons, degraded } = await collect(
      { ...COMPLETE_SCRIPT },
      { cwd: "work/repo" },
    );

    expect(degraded).toBe(true);
    expect(reasons).toEqual(["directory-path-unsafe"]);
  });
});

describe("collectPiExtensionInventory contract", () => {
  it("produces entries the child-extension plan can consume", async () => {
    const { inventory } = await collect({
      ...COMPLETE_SCRIPT,
      directories: { [AGENT_EXTENSIONS]: [file("notes.ts")] },
    });

    const entry = inventory.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const planEntry: ChildExtensionInventoryEntry = entry;
    expect(planEntry.id).toBe(`${AGENT_EXTENSIONS}/notes.ts`);
    expect(planEntry.path).toBe(`${AGENT_EXTENSIONS}/notes.ts`);
    expect(planEntry.available).toBe(true);
  });

  it("orders entries deterministically with mandatory first", async () => {
    const script: FakePortScript = {
      ...COMPLETE_SCRIPT,
      commands: [
        extensionCommand(
          "weave:health",
          sourceInfo({
            origin: "package",
            source: WEAVE_SOURCE,
            scope: "user",
            path: WEAVE_ENTRY,
          }),
        ),
      ],
      directories: {
        [AGENT_EXTENSIONS]: [file("zeta.ts"), file("alpha.ts")],
      },
    };
    const first = await collect(script);
    const second = await collect(script);

    expect(first.inventory.entries.map((entry) => entry.id)).toEqual([
      WEAVE_SOURCE,
      `${AGENT_EXTENSIONS}/alpha.ts`,
      `${AGENT_EXTENSIONS}/zeta.ts`,
    ]);
    expect(second.inventory.entries).toEqual(first.inventory.entries);
  });
});
