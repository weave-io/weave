/**
 * Best-effort Pi extension inventory (Pi adapter contract).
 *
 * Answers one question for the child-extension selection UI and the child
 * spawn argv: which extensions could this host hand to a child, what proves
 * each one exists, and which one is the Weave adapter itself.
 *
 * Three independent evidence sources are unioned by the Task 9 identity rule
 * ({@link childExtensionEntryId}):
 *
 * - `loaded` — `sourceInfo` of commands and tools the host already loaded.
 * - `configured-package` — configured packages plus their installed path and
 *   that package's `pi.extensions` manifest field.
 * - `discovered-file` — bounded scans of `<agentDir>/extensions` and, only
 *   when the project is trusted, `<cwd>/.pi/extensions`.
 *
 * The inventory is *read-only evidence*. This module never loads, evaluates,
 * installs, updates, or network-resolves an extension, never calls a package
 * manager `resolve()` that could install, and never runs another extension's
 * factory to see what it registers.
 *
 * Known limits, all deliberate:
 *
 * - An extension that registers no command and no tool and lives outside the
 *   two scanned directories cannot be enumerated at all.
 * - Existence of a manifest-declared entry file is not proven; the manifest is
 *   the host's own contract and a missing entry only means the child loads one
 *   fewer extension.
 * - A configured package is represented by its installed *directory*, because
 *   `-e <dir>` makes Pi resolve exactly the entries it would have loaded
 *   itself. A single package never becomes several inventory entries.
 *
 * Every host surface arrives through {@link PiExtensionInventoryPort}. Each
 * member is optional and fallible, so a host gap or a throwing implementation
 * degrades into a typed reason plus a partial inventory instead of an
 * exception. Degradation reasons are a closed, path-free set: they may be
 * logged, entry ids may not.
 */
import { basename, isAbsolute, join, resolve } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  childExtensionEntryId,
  isSafeChildExtensionPath,
  MAX_CHILD_EXTENSION_FIELD_BYTES,
} from "./child-extension-selection.js";
import { isOwnSourceInfo, parseNpmSourceName } from "./commands.js";
import { safelyAwaitPortResult } from "./port-safety.js";
import type {
  PiCommandInfo,
  PiResourceOrigin,
  PiResourceScope,
  PiSourceInfo,
  PiTrustState,
} from "./types.js";

/** Provenance override honored only at the exact value `1`. */
export const WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV =
  "WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE";

/**
 * Total inventory bound. Task 9 persists at most 64 optional entries, and a
 * host with more than 200 distinct extensions is already past anything the
 * selection UI can render honestly.
 */
export const MAX_PI_EXTENSION_INVENTORY_ENTRIES = 200;

/** Per-directory listing bound; a longer listing truncates. */
export const MAX_PI_EXTENSION_DIRECTORY_ENTRIES = 128;

/**
 * Scan depth bound, counted in listed directories. `1` is the extensions
 * directory itself, `2` is one extension subdirectory. Pi's own discovery
 * does not recurse further, so neither does this.
 */
export const MAX_PI_EXTENSION_DIRECTORY_DEPTH = 2;

/** Bound on `pi.extensions` entries read from one package manifest. */
export const MAX_PI_EXTENSION_MANIFEST_ENTRIES = 16;

/** Bound on configured packages inspected in one collection. */
export const MAX_PI_EXTENSION_CONFIGURED_PACKAGES = 64;

/** Bound on loaded commands/tools scanned for `sourceInfo` evidence. */
export const MAX_PI_EXTENSION_LOADED_SOURCES = 1_024;

/** Pi's project configuration directory name (`piConfig.configDir`). */
export const PI_PROJECT_CONFIG_DIRECTORY = ".pi";

/** Directory Pi scans for extensions inside the agent dir and the project. */
export const PI_EXTENSIONS_DIRECTORY = "extensions";

/** Entry-point file names Pi accepts inside an extension subdirectory. */
const EXTENSION_INDEX_FILENAMES = ["index.ts", "index.js"] as const;

const EXTENSION_FILE_SUFFIXES = [".ts", ".js"] as const;

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * Closed failure set for a port member. `NotFound` is an ordinary answer — a
 * missing directory or an uninstalled package is not a degradation.
 */
export type PiExtensionInventoryPortError =
  | { readonly type: "Unsupported" }
  | { readonly type: "HostCallFailed" }
  | { readonly type: "NotFound" }
  | { readonly type: "PortThrew" };

/** One listed directory child. Symlinks are classified as Pi classifies them. */
export interface PiExtensionInventoryDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}

/** Projection of Pi's `ConfiguredPackage`. */
export interface PiExtensionInventoryConfiguredPackage {
  readonly source: string;
  readonly scope: "user" | "project";
  readonly installedPath?: string;
}

/** Projection of Pi's `ToolInfo`; only provenance is read. */
export interface PiExtensionInventoryToolInfo {
  readonly name: string;
  readonly sourceInfo?: PiSourceInfo;
}

/**
 * Narrow, read-only host surface.
 *
 * Every member is optional so a host that lacks one API still yields a
 * partial inventory, and every member is fallible so a host call that fails
 * becomes a reason instead of an exception. No member may mutate host state.
 */
export interface PiExtensionInventoryPort {
  /** `pi.getCommands()`. */
  commands?(): ResultAsync<
    readonly PiCommandInfo[],
    PiExtensionInventoryPortError
  >;
  /** `ctx.getAllTools()`. */
  tools?(): ResultAsync<
    readonly PiExtensionInventoryToolInfo[],
    PiExtensionInventoryPortError
  >;
  /** `PackageManager.listConfiguredPackages()`. */
  configuredPackages?(): ResultAsync<
    readonly PiExtensionInventoryConfiguredPackage[],
    PiExtensionInventoryPortError
  >;
  /** `PackageManager.getInstalledPath(source, scope)` — never installs. */
  installedPackagePath?(
    source: string,
    scope: "user" | "project",
  ): ResultAsync<string, PiExtensionInventoryPortError>;
  /** `getAgentDir()`. */
  agentDirectory?(): ResultAsync<string, PiExtensionInventoryPortError>;
  /** Non-recursive listing of one directory. */
  listDirectory?(
    path: string,
  ): ResultAsync<
    readonly PiExtensionInventoryDirectoryEntry[],
    PiExtensionInventoryPortError
  >;
  /** Reads and parses one JSON file. */
  readJson?(path: string): ResultAsync<unknown, PiExtensionInventoryPortError>;
}

// ---------------------------------------------------------------------------
// Inventory shape
// ---------------------------------------------------------------------------

/** Canonical evidence order; also the order rendered on an entry. */
export const PI_EXTENSION_EVIDENCE_KINDS = [
  "loaded",
  "configured-package",
  "discovered-file",
] as const;

export type PiExtensionEvidence = (typeof PI_EXTENSION_EVIDENCE_KINDS)[number];

/**
 * One inventory entry. Structurally assignable to Task 9's
 * `ChildExtensionInventoryEntry`, which is how the spawn plan consumes it.
 */
export interface PiExtensionInventoryEntry {
  /** Task 9 identity: package source for a package, else absolute path. */
  readonly id: string;
  readonly label: string;
  readonly source: string;
  /**
   * Absolute path handed to `-e`. A configured package resolves to its
   * installed directory. Empty only when no evidence produced a usable path,
   * in which case `available` is always `false`.
   */
  readonly path: string;
  readonly origin: PiResourceOrigin;
  readonly scope: PiResourceScope;
  readonly evidence: readonly PiExtensionEvidence[];
  /** True only for this adapter, proven by provenance or an explicit fact. */
  readonly mandatory: boolean;
  /** True when evidence proves loadability and the path is usable. */
  readonly available: boolean;
}

export interface PiExtensionInventory {
  /** Mandatory first, then ascending by identity. */
  readonly entries: readonly PiExtensionInventoryEntry[];
  /** True when any bound dropped a candidate. */
  readonly truncated: boolean;
  /**
   * True only when the project extensions directory was actually consulted:
   * the project is trusted, its root is usable, and a listing port exists. A
   * directory that does not exist still counts as consulted.
   */
  readonly projectScanned: boolean;
}

/** Closed, path-free degradation reasons, in canonical report order. */
export const PI_EXTENSION_INVENTORY_DEGRADATION_REASONS = [
  "commands-unavailable",
  "commands-failed",
  "tools-unavailable",
  "tools-failed",
  "configured-packages-unavailable",
  "configured-packages-failed",
  "installed-path-unavailable",
  "installed-path-failed",
  "package-manifest-unreadable",
  "package-manifest-invalid",
  "agent-directory-unavailable",
  "agent-directory-failed",
  "agent-directory-unsafe",
  "directory-listing-unavailable",
  "directory-listing-failed",
  "directory-path-unsafe",
  "json-read-unavailable",
  "collector-failed",
] as const;

export type PiExtensionInventoryDegradationReason =
  (typeof PI_EXTENSION_INVENTORY_DEGRADATION_REASONS)[number];

/** A degraded collection still carries everything it did manage to gather. */
export interface PiExtensionInventoryDegradation {
  readonly inventory: PiExtensionInventory;
  readonly reasons: readonly PiExtensionInventoryDegradationReason[];
}

export interface CollectPiExtensionInventoryOptions {
  /** Project trust; `withheld` skips the project scan entirely. */
  readonly trust: PiTrustState;
  /** Absolute project root. Required for the project scan. */
  readonly cwd?: string;
  /**
   * This loader's own resolved extension entry path. Used for mandatory
   * marking only while the unsafe provenance override is exactly `1`, and
   * never inferred: an absent fact means no override-based marking.
   */
  readonly ownEntryPath?: string;
  /** Isolated environment table. Production reads `Bun.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const EMPTY_INVENTORY: PiExtensionInventory = Object.freeze({
  entries: Object.freeze([]) as readonly PiExtensionInventoryEntry[],
  truncated: false,
  projectScanned: false,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const CONTROL_CHARACTER_SOURCE = String.raw`[\u0000-\u001f\u007f]`;
const CONTROL_CHARACTER_PATTERN = new RegExp(CONTROL_CHARACTER_SOURCE);

/** Non-empty, control-free, and within the persisted per-field byte bound. */
function isUsableTextField(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (CONTROL_CHARACTER_PATTERN.test(value)) return false;
  return encoder.encode(value).byteLength <= MAX_CHILD_EXTENSION_FIELD_BYTES;
}

/**
 * Local lexical containment check. `path-containment.ts` owns the no-follow
 * filesystem proof and imports `bun:ffi`; this module stays free of that
 * dependency because it only reasons about strings.
 */
function isLexicalRelativePath(value: string): boolean {
  if (value.length === 0) return false;
  if (isAbsolute(value)) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  return value
    .split("/")
    .every((segment) => segment !== ".." && segment.length > 0);
}

/** True when `candidate` resolves inside `root`. Both must be absolute. */
function isContainedIn(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isExtensionFileName(name: string): boolean {
  if (!isUsableTextField(name)) return false;
  if (name.includes("/") || name === "." || name === "..") return false;
  return EXTENSION_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** A symlink is a file candidate by name and a directory candidate otherwise. */
function isFileLike(entry: PiExtensionInventoryDirectoryEntry): boolean {
  return entry.kind === "file" || entry.kind === "symlink";
}

function isDirectoryLike(entry: PiExtensionInventoryDirectoryEntry): boolean {
  return entry.kind === "directory" || entry.kind === "symlink";
}

/** Own-property read: a manifest carrying `__proto__` cannot fake a field. */
function readOwnProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  if (!Object.hasOwn(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function isUsableSourceInfo(value: unknown): value is PiSourceInfo {
  if (typeof value !== "object" || value === null) return false;
  const origin = readOwnProperty(value, "origin");
  const source = readOwnProperty(value, "source");
  const path = readOwnProperty(value, "path");
  const scope = readOwnProperty(value, "scope");
  return (
    typeof origin === "string" &&
    typeof source === "string" &&
    typeof path === "string" &&
    typeof scope === "string"
  );
}

function callPort<T>(
  call: () => ResultAsync<T, PiExtensionInventoryPortError>,
): ResultAsync<T, PiExtensionInventoryPortError> {
  return safelyAwaitPortResult(
    call,
    (): PiExtensionInventoryPortError => ({ type: "PortThrew" }),
  );
}

interface EntryCandidate {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly path: string;
  readonly origin: PiResourceOrigin;
  readonly scope: PiResourceScope;
  readonly evidence: PiExtensionEvidence;
  /** Evidence proves the extension exists and can be loaded. */
  readonly proven: boolean;
  /** Higher wins when two evidence sources disagree about the path. */
  readonly pathAuthority: number;
  readonly mandatory: boolean;
}

interface MutableEntry {
  readonly id: string;
  label: string;
  source: string;
  path: string;
  origin: PiResourceOrigin;
  scope: PiResourceScope;
  readonly evidence: Set<PiExtensionEvidence>;
  proven: boolean;
  pathAuthority: number;
  mandatory: boolean;
}

/** No path at all. */
const PATH_AUTHORITY_NONE = 0;
/** A concrete entry file observed as loaded or discovered. */
const PATH_AUTHORITY_FILE = 1;
/** A package's installed directory: Pi resolves every declared entry from it. */
const PATH_AUTHORITY_PACKAGE_DIRECTORY = 2;

type ManifestOutcome =
  | { readonly kind: "declared"; readonly paths: readonly string[] }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

interface CollectionOutcome {
  readonly inventory: PiExtensionInventory;
  readonly reasons: readonly PiExtensionInventoryDegradationReason[];
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/**
 * Gathers evidence from the port and unions it into one bounded inventory.
 * Nothing here throws: every host call is wrapped, and every bound is checked
 * before a candidate is accepted.
 */
class PiExtensionInventoryCollector {
  private readonly entries = new Map<string, MutableEntry>();
  private readonly reasons = new Set<PiExtensionInventoryDegradationReason>();
  private truncated = false;
  private projectScanned = false;
  private readonly overrideEntryPath: string | undefined;

  constructor(
    private readonly port: PiExtensionInventoryPort,
    private readonly options: CollectPiExtensionInventoryOptions,
  ) {
    this.overrideEntryPath = resolveOverrideEntryPath(options);
  }

  async run(): Promise<CollectionOutcome> {
    await this.collectLoadedCommands();
    await this.collectLoadedTools();
    await this.collectConfiguredPackages();
    await this.scanUserExtensions();
    await this.scanProjectExtensions();
    return {
      inventory: this.finalize(),
      reasons: PI_EXTENSION_INVENTORY_DEGRADATION_REASONS.filter((reason) =>
        this.reasons.has(reason),
      ),
    };
  }

  // -- evidence: loaded ----------------------------------------------------

  private async collectLoadedCommands(): Promise<void> {
    const commands = this.port.commands?.bind(this.port);
    if (commands === undefined) {
      this.reasons.add("commands-unavailable");
      return;
    }
    const result = await callPort(commands);
    if (result.isErr()) {
      this.reasons.add("commands-failed");
      return;
    }
    for (const command of this.boundedSources(result.value)) {
      // Prompts and skills are not extensions; only an extension-registered
      // command proves an extension is loaded.
      if (command.source !== "extension") continue;
      this.addLoadedSourceInfo(command.sourceInfo);
    }
  }

  private async collectLoadedTools(): Promise<void> {
    const tools = this.port.tools?.bind(this.port);
    if (tools === undefined) {
      this.reasons.add("tools-unavailable");
      return;
    }
    const result = await callPort(tools);
    if (result.isErr()) {
      this.reasons.add("tools-failed");
      return;
    }
    for (const tool of this.boundedSources(result.value)) {
      this.addLoadedSourceInfo(tool.sourceInfo);
    }
  }

  private boundedSources<T>(values: readonly T[]): readonly T[] {
    if (values.length <= MAX_PI_EXTENSION_LOADED_SOURCES) return values;
    this.truncated = true;
    return values.slice(0, MAX_PI_EXTENSION_LOADED_SOURCES);
  }

  /**
   * Builtin and SDK resources carry synthetic `<builtin:read>`-style paths and
   * can never be handed to a child, so an identity that cannot be derived is
   * skipped silently rather than reported as degradation.
   */
  private addLoadedSourceInfo(sourceInfo: unknown): void {
    if (!isUsableSourceInfo(sourceInfo)) return;
    const identity = childExtensionEntryId(sourceInfo);
    if (identity.isErr()) return;
    const isPackage = sourceInfo.origin === "package";
    const path = isSafeChildExtensionPath(sourceInfo.path)
      ? sourceInfo.path
      : "";
    this.add({
      id: identity.value,
      label: labelFor(sourceInfo.origin, sourceInfo.source, path),
      source: isUsableTextField(sourceInfo.source)
        ? sourceInfo.source
        : "local",
      path,
      origin: isPackage ? "package" : "top-level",
      scope: normalizeScope(sourceInfo.scope),
      evidence: "loaded",
      proven: true,
      pathAuthority:
        path.length === 0 ? PATH_AUTHORITY_NONE : PATH_AUTHORITY_FILE,
      mandatory: isOwnSourceInfo(sourceInfo) || this.matchesOverride(path),
    });
  }

  // -- evidence: configured packages ---------------------------------------

  private async collectConfiguredPackages(): Promise<void> {
    const list = this.port.configuredPackages?.bind(this.port);
    if (list === undefined) {
      this.reasons.add("configured-packages-unavailable");
      return;
    }
    const result = await callPort(list);
    if (result.isErr()) {
      this.reasons.add("configured-packages-failed");
      return;
    }
    const packages = result.value;
    const bounded =
      packages.length <= MAX_PI_EXTENSION_CONFIGURED_PACKAGES
        ? packages
        : packages.slice(0, MAX_PI_EXTENSION_CONFIGURED_PACKAGES);
    if (bounded.length < packages.length) this.truncated = true;
    for (const configured of bounded) {
      await this.collectConfiguredPackage(configured);
    }
  }

  private async collectConfiguredPackage(
    configured: PiExtensionInventoryConfiguredPackage,
  ): Promise<void> {
    const sourceInfo = {
      origin: "package" as const,
      source: configured.source,
      path: "",
      scope: configured.scope,
    };
    const identity = childExtensionEntryId(sourceInfo);
    if (identity.isErr()) return;

    const installedPath = await this.resolveInstalledPath(configured);
    const mandatory = isOwnSourceInfo(sourceInfo);
    if (installedPath === undefined) {
      // Configured but not installed (or filtered): honest, unavailable, and
      // still worth showing so a stale selection can be explained.
      this.add({
        id: identity.value,
        label: labelFor("package", configured.source, ""),
        source: configured.source,
        path: "",
        origin: "package",
        scope: configured.scope,
        evidence: "configured-package",
        proven: false,
        pathAuthority: PATH_AUTHORITY_NONE,
        mandatory,
      });
      return;
    }

    const manifest = await this.readManifestEntries(installedPath);
    const candidate: EntryCandidate = {
      id: identity.value,
      label: labelFor("package", configured.source, installedPath),
      source: configured.source,
      path: installedPath,
      origin: "package",
      scope: configured.scope,
      evidence: "configured-package",
      proven: manifest.kind === "declared",
      pathAuthority: PATH_AUTHORITY_PACKAGE_DIRECTORY,
      mandatory: mandatory || this.matchesOverride(installedPath),
    };
    // A package that declares no extensions provides skills, prompts, or
    // themes only. It joins the inventory solely to correct the path of an
    // identity that loaded evidence already proved.
    this.add(candidate, { existingOnly: manifest.kind === "none" });
  }

  private async resolveInstalledPath(
    configured: PiExtensionInventoryConfiguredPackage,
  ): Promise<string | undefined> {
    const declared = configured.installedPath;
    if (declared !== undefined && isSafeChildExtensionPath(declared)) {
      return declared;
    }
    const lookup = this.port.installedPackagePath?.bind(this.port);
    if (lookup === undefined) {
      this.reasons.add("installed-path-unavailable");
      return undefined;
    }
    const result = await callPort(() =>
      lookup(configured.source, configured.scope),
    );
    if (result.isErr()) {
      if (result.error.type !== "NotFound") {
        this.reasons.add("installed-path-failed");
      }
      return undefined;
    }
    return isSafeChildExtensionPath(result.value) ? result.value : undefined;
  }

  // -- evidence: discovered files ------------------------------------------

  private async scanUserExtensions(): Promise<void> {
    const agentDirectory = this.port.agentDirectory?.bind(this.port);
    if (agentDirectory === undefined) {
      this.reasons.add("agent-directory-unavailable");
      return;
    }
    const result = await callPort(agentDirectory);
    if (result.isErr()) {
      this.reasons.add("agent-directory-failed");
      return;
    }
    if (!isSafeChildExtensionPath(result.value)) {
      this.reasons.add("agent-directory-unsafe");
      return;
    }
    await this.scanExtensionsDirectory(
      join(result.value, PI_EXTENSIONS_DIRECTORY),
      "user",
    );
  }

  private async scanProjectExtensions(): Promise<void> {
    // Trust withheld means the project tree is not read at all. This is an
    // expected state, not a degradation.
    if (this.options.trust !== "trusted") return;
    const cwd = this.options.cwd;
    if (cwd === undefined) return;
    if (!isSafeChildExtensionPath(cwd)) {
      this.reasons.add("directory-path-unsafe");
      return;
    }
    if (this.port.listDirectory === undefined) {
      this.reasons.add("directory-listing-unavailable");
      return;
    }
    this.projectScanned = true;
    await this.scanExtensionsDirectory(
      join(cwd, PI_PROJECT_CONFIG_DIRECTORY, PI_EXTENSIONS_DIRECTORY),
      "project",
    );
  }

  private async scanExtensionsDirectory(
    directory: string,
    scope: PiResourceScope,
  ): Promise<void> {
    const listing = await this.listDirectory(directory, 1);
    if (listing === undefined) return;
    for (const item of listing) {
      if (isFileLike(item) && isExtensionFileName(item.name)) {
        this.addDiscoveredFile(join(directory, item.name), scope);
        continue;
      }
      if (isDirectoryLike(item) && isUsableTextField(item.name)) {
        if (item.name === "." || item.name === "..") continue;
        await this.scanExtensionDirectory(join(directory, item.name), scope);
      }
    }
  }

  /** One extension subdirectory: manifest entries first, then an index file. */
  private async scanExtensionDirectory(
    directory: string,
    scope: PiResourceScope,
  ): Promise<void> {
    const manifest = await this.readManifestEntries(directory);
    if (manifest.kind === "declared") {
      for (const path of manifest.paths) this.addDiscoveredFile(path, scope);
      return;
    }
    const listing = await this.listDirectory(directory, 2);
    if (listing === undefined) return;
    for (const indexName of EXTENSION_INDEX_FILENAMES) {
      const found = listing.some(
        (item) => item.name === indexName && isFileLike(item),
      );
      if (!found) continue;
      this.addDiscoveredFile(join(directory, indexName), scope);
      return;
    }
  }

  private addDiscoveredFile(path: string, scope: PiResourceScope): void {
    if (!isSafeChildExtensionPath(path)) return;
    this.add({
      id: path,
      label: labelFor("top-level", "local", path),
      source: "local",
      path,
      origin: "top-level",
      scope,
      evidence: "discovered-file",
      proven: true,
      pathAuthority: PATH_AUTHORITY_FILE,
      mandatory: this.matchesOverride(path),
    });
  }

  // -- bounded host reads ---------------------------------------------------

  private async listDirectory(
    path: string,
    depth: number,
  ): Promise<readonly PiExtensionInventoryDirectoryEntry[] | undefined> {
    if (depth > MAX_PI_EXTENSION_DIRECTORY_DEPTH) {
      this.truncated = true;
      return undefined;
    }
    const list = this.port.listDirectory?.bind(this.port);
    if (list === undefined) {
      this.reasons.add("directory-listing-unavailable");
      return undefined;
    }
    if (!isSafeChildExtensionPath(path)) {
      this.reasons.add("directory-path-unsafe");
      return undefined;
    }
    const result = await callPort(() => list(path));
    if (result.isErr()) {
      // A missing extensions directory is the common case, not a failure.
      if (result.error.type !== "NotFound") {
        this.reasons.add("directory-listing-failed");
      }
      return undefined;
    }
    const items = result.value;
    if (items.length <= MAX_PI_EXTENSION_DIRECTORY_ENTRIES) return items;
    this.truncated = true;
    return items.slice(0, MAX_PI_EXTENSION_DIRECTORY_ENTRIES);
  }

  /**
   * Reads `<directory>/package.json` and returns the declared `pi.extensions`
   * entry paths, resolved and proven to stay inside the directory.
   */
  private async readManifestEntries(
    directory: string,
  ): Promise<ManifestOutcome> {
    const readJson = this.port.readJson?.bind(this.port);
    if (readJson === undefined) {
      this.reasons.add("json-read-unavailable");
      return { kind: "unknown" };
    }
    const manifestPath = join(directory, "package.json");
    if (!isSafeChildExtensionPath(manifestPath)) {
      this.reasons.add("directory-path-unsafe");
      return { kind: "unknown" };
    }
    const result = await callPort(() => readJson(manifestPath));
    if (result.isErr()) {
      if (result.error.type === "NotFound") return { kind: "none" };
      this.reasons.add("package-manifest-unreadable");
      return { kind: "unknown" };
    }
    return this.readDeclaredExtensions(directory, result.value);
  }

  private readDeclaredExtensions(
    directory: string,
    manifest: unknown,
  ): ManifestOutcome {
    const pi = readOwnProperty(manifest, "pi");
    if (pi === undefined) return { kind: "none" };
    const declared = readOwnProperty(pi, "extensions");
    if (declared === undefined) return { kind: "none" };
    if (!Array.isArray(declared)) {
      this.reasons.add("package-manifest-invalid");
      return { kind: "unknown" };
    }
    const bounded =
      declared.length <= MAX_PI_EXTENSION_MANIFEST_ENTRIES
        ? declared
        : declared.slice(0, MAX_PI_EXTENSION_MANIFEST_ENTRIES);
    if (bounded.length < declared.length) this.truncated = true;

    const paths: string[] = [];
    for (const value of bounded) {
      const resolved = this.resolveDeclaredEntry(directory, value);
      if (resolved === undefined) continue;
      paths.push(resolved);
    }
    if (paths.length === 0) return { kind: "none" };
    return { kind: "declared", paths };
  }

  private resolveDeclaredEntry(
    directory: string,
    value: unknown,
  ): string | undefined {
    if (!isUsableTextField(value) || !isLexicalRelativePath(value)) {
      this.reasons.add("package-manifest-invalid");
      return undefined;
    }
    const resolved = resolve(directory, value);
    if (!isSafeChildExtensionPath(resolved)) {
      this.reasons.add("package-manifest-invalid");
      return undefined;
    }
    if (!isContainedIn(directory, resolved)) {
      this.reasons.add("package-manifest-invalid");
      return undefined;
    }
    return resolved;
  }

  // -- union ----------------------------------------------------------------

  /**
   * Mandatory marking never guesses. Provenance decides on its own; the unsafe
   * override only allows an entry path the caller supplied as a fact, so a
   * moved or stale adapter copy can never claim to be this loader.
   */
  private matchesOverride(path: string): boolean {
    if (this.overrideEntryPath === undefined) return false;
    if (path.length === 0) return false;
    return path === this.overrideEntryPath;
  }

  private add(
    candidate: EntryCandidate,
    options?: { readonly existingOnly?: boolean },
  ): void {
    const existing = this.entries.get(candidate.id);
    if (existing === undefined) {
      if (options?.existingOnly === true) return;
      if (this.entries.size >= MAX_PI_EXTENSION_INVENTORY_ENTRIES) {
        this.truncated = true;
        return;
      }
      this.entries.set(candidate.id, {
        id: candidate.id,
        label: candidate.label,
        source: candidate.source,
        path: candidate.path,
        origin: candidate.origin,
        scope: candidate.scope,
        evidence: new Set([candidate.evidence]),
        proven: candidate.proven,
        pathAuthority: candidate.pathAuthority,
        mandatory: candidate.mandatory,
      });
      return;
    }

    existing.evidence.add(candidate.evidence);
    existing.proven = existing.proven || candidate.proven;
    existing.mandatory = existing.mandatory || candidate.mandatory;
    if (candidate.pathAuthority > existing.pathAuthority) {
      existing.path = candidate.path;
      existing.pathAuthority = candidate.pathAuthority;
      existing.label = candidate.label;
    }
    // Package provenance is stronger than a bare file observation.
    if (existing.origin !== "package" && candidate.origin === "package") {
      existing.origin = "package";
      existing.source = candidate.source;
      existing.scope = candidate.scope;
    }
  }

  private finalize(): PiExtensionInventory {
    const entries = [...this.entries.values()]
      .map(
        (entry): PiExtensionInventoryEntry => ({
          id: entry.id,
          label: entry.label,
          source: entry.source,
          path: entry.path,
          origin: entry.origin,
          scope: entry.scope,
          evidence: PI_EXTENSION_EVIDENCE_KINDS.filter((kind) =>
            entry.evidence.has(kind),
          ),
          mandatory: entry.mandatory,
          available: entry.proven && isSafeChildExtensionPath(entry.path),
        }),
      )
      .sort(compareEntries);
    return {
      entries,
      truncated: this.truncated,
      projectScanned: this.projectScanned,
    };
  }
}

function compareEntries(
  left: PiExtensionInventoryEntry,
  right: PiExtensionInventoryEntry,
): number {
  if (left.mandatory !== right.mandatory) return left.mandatory ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function normalizeScope(scope: string): PiResourceScope {
  if (scope === "user") return "user";
  if (scope === "project") return "project";
  return "temporary";
}

/**
 * A package shows its npm name, a file shows its basename. Both fall back to
 * a value already proven to satisfy the persisted field bounds.
 */
function labelFor(
  origin: PiResourceOrigin,
  source: string,
  path: string,
): string {
  if (origin === "package") {
    const npmName = parseNpmSourceName(source);
    if (npmName !== undefined && isUsableTextField(npmName)) return npmName;
    return isUsableTextField(source) ? source : "package";
  }
  const name = path.length === 0 ? "" : basename(path);
  if (isUsableTextField(name)) return name;
  return isUsableTextField(path) ? path : "extension";
}

function resolveOverrideEntryPath(
  options: CollectPiExtensionInventoryOptions,
): string | undefined {
  const env = options.env ?? Bun.env;
  if (env[WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV] !== "1") {
    return undefined;
  }
  const ownEntryPath = options.ownEntryPath;
  if (ownEntryPath === undefined) return undefined;
  return isSafeChildExtensionPath(ownEntryPath) ? ownEntryPath : undefined;
}

/**
 * Collects the inventory. Resolves `Ok` only when every consulted host surface
 * answered; otherwise resolves `Err` carrying the partial inventory plus the
 * closed reasons, so a caller can still render or spawn from what was proven.
 */
export function collectPiExtensionInventory(
  port: PiExtensionInventoryPort,
  options: CollectPiExtensionInventoryOptions,
): ResultAsync<PiExtensionInventory, PiExtensionInventoryDegradation> {
  const collector = new PiExtensionInventoryCollector(port, options);
  return ResultAsync.fromPromise(
    collector.run(),
    (): CollectionOutcome => ({
      inventory: EMPTY_INVENTORY,
      reasons: ["collector-failed"],
    }),
  )
    .orElse((outcome) => okAsync(outcome))
    .andThen((outcome) =>
      outcome.reasons.length === 0
        ? okAsync(outcome.inventory)
        : errAsync({ inventory: outcome.inventory, reasons: outcome.reasons }),
    );
}
