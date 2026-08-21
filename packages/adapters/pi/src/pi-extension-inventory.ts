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
import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
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
  readJson?(
    path: string,
  ): ResultAsync<PiExtensionObservedValue, PiExtensionInventoryPortError>;
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
  entries: Object.freeze([]),
  truncated: false,
  projectScanned: false,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PI_EXTENSION_OBSERVED_VALUE_SCHEMA = z.unknown();
type PiExtensionObservedValue = z.input<
  typeof PI_EXTENSION_OBSERVED_VALUE_SCHEMA
>;

const encoder = new TextEncoder();
const CONTROL_CHARACTER_SOURCE = String.raw`[\u0000-\u001f\u007f]`;
const CONTROL_CHARACTER_PATTERN = new RegExp(CONTROL_CHARACTER_SOURCE);
const PI_EXTENSION_TEXT_SCHEMA = z
  .string()
  .refine(
    (value) =>
      !CONTROL_CHARACTER_PATTERN.test(value) &&
      encoder.encode(value).byteLength <= MAX_CHILD_EXTENSION_FIELD_BYTES,
    "bounded text field",
  );
const PI_EXTENSION_SCOPE_SCHEMA = z.enum(["user", "project", "temporary"]);
const PI_EXTENSION_ORIGIN_SCHEMA = z.enum(["package", "top-level"]);
const PI_EXTENSION_COMMAND_SOURCE_SCHEMA = z.enum([
  "extension",
  "prompt",
  "skill",
]);
const PI_EXTENSION_DIRECTORY_KIND_SCHEMA = z.enum([
  "file",
  "directory",
  "symlink",
  "other",
]);
const PI_EXTENSION_PACKAGE_SCOPE_SCHEMA = z.enum(["user", "project"]);
const PI_EXTENSION_MANIFEST_ENTRY_SCHEMA = z.string();

const PI_EXTENSION_SOURCE_INFO_SCHEMA = z.strictObject({
  path: PI_EXTENSION_TEXT_SCHEMA,
  source: PI_EXTENSION_TEXT_SCHEMA,
  scope: PI_EXTENSION_SCOPE_SCHEMA,
  origin: PI_EXTENSION_ORIGIN_SCHEMA,
  baseDir: PI_EXTENSION_TEXT_SCHEMA.optional(),
});

const PI_EXTENSION_COMMAND_SCHEMA = z.strictObject({
  name: PI_EXTENSION_TEXT_SCHEMA.min(1),
  source: PI_EXTENSION_COMMAND_SOURCE_SCHEMA,
  sourceInfo: PI_EXTENSION_SOURCE_INFO_SCHEMA,
  description: PI_EXTENSION_TEXT_SCHEMA.optional(),
});

const PI_EXTENSION_TOOL_SCHEMA = z.strictObject({
  name: PI_EXTENSION_TEXT_SCHEMA.min(1),
  sourceInfo: PI_EXTENSION_SOURCE_INFO_SCHEMA.optional(),
});

const PI_EXTENSION_CONFIGURED_PACKAGE_SCHEMA = z.strictObject({
  source: PI_EXTENSION_TEXT_SCHEMA,
  scope: PI_EXTENSION_PACKAGE_SCOPE_SCHEMA,
  installedPath: PI_EXTENSION_TEXT_SCHEMA.optional(),
});

const PI_EXTENSION_DIRECTORY_ENTRY_SCHEMA = z.strictObject({
  name: PI_EXTENSION_TEXT_SCHEMA,
  kind: PI_EXTENSION_DIRECTORY_KIND_SCHEMA,
});

interface PiExtensionObjectReference {
  readonly piExtensionObjectMarker?: never;
}

interface PiExtensionArrayReference
  extends ReadonlyArray<PiExtensionObservedValue> {
  readonly piExtensionArrayMarker?: never;
}

/** A hostile value is usable only when it has a plain, non-callable shape. */
const PI_EXTENSION_PLAIN_OBJECT_SCHEMA = z.custom<PiExtensionObjectReference>(
  (value) => {
    const checked = Result.fromThrowable(
      (): boolean => {
        if (
          value === null ||
          Object(value) !== value ||
          Array.isArray(value) ||
          value instanceof Function
        ) {
          return false;
        }
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
      },
      (): boolean => false,
    )();
    return checked.isOk() && checked.value;
  },
);

/** Arrays are copied through descriptors before any item parser sees them. */
const PI_EXTENSION_ARRAY_SCHEMA = z.custom<PiExtensionArrayReference>(
  (value) => {
    const checked = Result.fromThrowable(
      (): boolean =>
        Array.isArray(value) &&
        Object.getPrototypeOf(value) === Array.prototype,
      (): boolean => false,
    )();
    return checked.isOk() && checked.value;
  },
);

const MAX_PI_EXTENSION_OBSERVED_ARRAY_ITEMS = 4_096;

type PiExtensionDataRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: PiExtensionObservedValue };

interface PiExtensionSourceInfoCandidate {
  path: PiExtensionObservedValue;
  source: PiExtensionObservedValue;
  scope: PiExtensionObservedValue;
  origin: PiExtensionObservedValue;
  baseDir?: PiExtensionObservedValue;
}

interface PiExtensionCommandCandidate {
  name: PiExtensionObservedValue;
  source: PiExtensionObservedValue;
  sourceInfo: PiSourceInfo;
  description?: PiExtensionObservedValue;
}

interface PiExtensionToolCandidate {
  name: PiExtensionObservedValue;
  sourceInfo?: PiSourceInfo;
}

interface PiExtensionConfiguredPackageCandidate {
  source: PiExtensionObservedValue;
  scope: PiExtensionObservedValue;
  installedPath?: PiExtensionObservedValue;
}

/**
 * Reads one own enumerable data property without invoking an accessor. The
 * plain-object schema and descriptor check are both required: either one
 * alone would leave a host object with a surprising prototype or getter.
 */
function readOwnDataProperty(
  value: PiExtensionObservedValue,
  key: string,
): PiExtensionDataRead {
  const object = PI_EXTENSION_PLAIN_OBJECT_SCHEMA.safeParse(value);
  if (!object.success) return { kind: "invalid" };
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(object.data, key),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (descriptor.isErr()) return { kind: "invalid" };
  if (descriptor.value === undefined) return { kind: "missing" };
  if (!("value" in descriptor.value) || descriptor.value.enumerable !== true) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: descriptor.value.value };
}

interface BoundedObservedArray {
  readonly values: readonly PiExtensionObservedValue[];
  readonly truncated: boolean;
}

/**
 * Validates an array's own length and indexed descriptors, then copies at most
 * the requested bound. Sparse arrays, accessors, revoked proxies, and exotic
 * array prototypes all fail closed.
 */
function readBoundedObservedArray(
  value: PiExtensionObservedValue,
  maxItems: number,
): BoundedObservedArray | undefined {
  const array = PI_EXTENSION_ARRAY_SCHEMA.safeParse(value);
  if (!array.success) return undefined;
  const lengthDescriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(array.data, "length"),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (lengthDescriptor.isErr() || lengthDescriptor.value === undefined) {
    return undefined;
  }
  if (
    !("value" in lengthDescriptor.value) ||
    lengthDescriptor.value.enumerable !== false
  ) {
    return undefined;
  }
  const parsedLength = z
    .number()
    .int()
    .min(0)
    .max(MAX_PI_EXTENSION_OBSERVED_ARRAY_ITEMS)
    .safeParse(lengthDescriptor.value.value);
  if (!parsedLength.success) return undefined;

  const length = parsedLength.data;
  const count = Math.min(length, maxItems);
  const values: PiExtensionObservedValue[] = [];
  for (let index = 0; index < count; index += 1) {
    const descriptor = Result.fromThrowable(
      () => Object.getOwnPropertyDescriptor(array.data, String(index)),
      (): PropertyDescriptor | undefined => undefined,
    )();
    if (descriptor.isErr() || descriptor.value === undefined) return undefined;
    if (
      !("value" in descriptor.value) ||
      descriptor.value.enumerable !== true
    ) {
      return undefined;
    }
    values.push(descriptor.value.value);
  }
  return { values, truncated: length > maxItems };
}

function isUsableTextField(value: string): boolean {
  if (value.length === 0) return false;
  if (CONTROL_CHARACTER_PATTERN.test(value)) return false;
  return encoder.encode(value).byteLength <= MAX_CHILD_EXTENSION_FIELD_BYTES;
}

function parseHostText(value: PiExtensionObservedValue): string | undefined {
  const parsed = PI_EXTENSION_TEXT_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    return false;
  }
  return EXTENSION_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function isExtensionDirectoryName(name: string): boolean {
  return (
    isUsableTextField(name) &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".."
  );
}

/** A symlink is a file candidate by name and a directory candidate otherwise. */
function isFileLike(entry: PiExtensionInventoryDirectoryEntry): boolean {
  return entry.kind === "file" || entry.kind === "symlink";
}

function isDirectoryLike(entry: PiExtensionInventoryDirectoryEntry): boolean {
  return entry.kind === "directory" || entry.kind === "symlink";
}

function parseSourceInfo(
  value: PiExtensionObservedValue,
): PiSourceInfo | undefined {
  const path = readOwnDataProperty(value, "path");
  const source = readOwnDataProperty(value, "source");
  const scope = readOwnDataProperty(value, "scope");
  const origin = readOwnDataProperty(value, "origin");
  if (
    path.kind !== "value" ||
    source.kind !== "value" ||
    scope.kind !== "value" ||
    origin.kind !== "value"
  ) {
    return undefined;
  }
  const baseDir = readOwnDataProperty(value, "baseDir");
  if (baseDir.kind === "invalid") return undefined;
  const candidate: PiExtensionSourceInfoCandidate = {
    path: path.value,
    source: source.value,
    scope: scope.value,
    origin: origin.value,
  };
  if (baseDir.kind === "value" && baseDir.value !== undefined) {
    candidate.baseDir = baseDir.value;
  }
  const parsed = PI_EXTENSION_SOURCE_INFO_SCHEMA.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function parseCommandInfo(
  value: PiExtensionObservedValue,
): PiCommandInfo | undefined {
  const name = readOwnDataProperty(value, "name");
  const source = readOwnDataProperty(value, "source");
  const sourceInfo = readOwnDataProperty(value, "sourceInfo");
  if (
    name.kind !== "value" ||
    source.kind !== "value" ||
    sourceInfo.kind !== "value"
  ) {
    return undefined;
  }
  const description = readOwnDataProperty(value, "description");
  if (description.kind === "invalid") return undefined;
  const parsedSourceInfo = parseSourceInfo(sourceInfo.value);
  if (parsedSourceInfo === undefined) return undefined;
  const candidate: PiExtensionCommandCandidate = {
    name: name.value,
    source: source.value,
    sourceInfo: parsedSourceInfo,
  };
  if (description.kind === "value" && description.value !== undefined) {
    candidate.description = description.value;
  }
  const parsed = PI_EXTENSION_COMMAND_SCHEMA.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function parseToolInfo(
  value: PiExtensionObservedValue,
): PiExtensionInventoryToolInfo | undefined {
  const name = readOwnDataProperty(value, "name");
  if (name.kind !== "value") return undefined;
  const sourceInfo = readOwnDataProperty(value, "sourceInfo");
  if (sourceInfo.kind === "invalid") return undefined;
  const parsedSourceInfo =
    sourceInfo.kind === "value" && sourceInfo.value !== undefined
      ? parseSourceInfo(sourceInfo.value)
      : undefined;
  if (sourceInfo.kind === "value" && parsedSourceInfo === undefined) {
    return undefined;
  }
  const candidate: PiExtensionToolCandidate = { name: name.value };
  if (parsedSourceInfo !== undefined) {
    candidate.sourceInfo = parsedSourceInfo;
  }
  const parsed = PI_EXTENSION_TOOL_SCHEMA.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function parseConfiguredPackage(
  value: PiExtensionObservedValue,
): PiExtensionInventoryConfiguredPackage | undefined {
  const source = readOwnDataProperty(value, "source");
  const scope = readOwnDataProperty(value, "scope");
  if (source.kind !== "value" || scope.kind !== "value") return undefined;
  const installedPath = readOwnDataProperty(value, "installedPath");
  if (installedPath.kind === "invalid") return undefined;
  const candidate: PiExtensionConfiguredPackageCandidate = {
    source: source.value,
    scope: scope.value,
  };
  if (installedPath.kind === "value" && installedPath.value !== undefined) {
    candidate.installedPath = installedPath.value;
  }
  const parsed = PI_EXTENSION_CONFIGURED_PACKAGE_SCHEMA.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function parseDirectoryEntry(
  value: PiExtensionObservedValue,
): PiExtensionInventoryDirectoryEntry | undefined {
  const name = readOwnDataProperty(value, "name");
  const kind = readOwnDataProperty(value, "kind");
  if (name.kind !== "value" || kind.kind !== "value") return undefined;
  const parsed = PI_EXTENSION_DIRECTORY_ENTRY_SCHEMA.safeParse({
    name: name.value,
    kind: kind.value,
  });
  return parsed.success ? parsed.data : undefined;
}

interface BoundedParsedValues<T> {
  readonly values: readonly T[];
  readonly truncated: boolean;
}

function parseBoundedValues<T>(
  value: PiExtensionObservedValue,
  maxItems: number,
  parse: (item: PiExtensionObservedValue) => T | undefined,
): BoundedParsedValues<T> | undefined {
  const observed = readBoundedObservedArray(value, maxItems);
  if (observed === undefined) return undefined;
  const values: T[] = [];
  for (const item of observed.values) {
    const parsed = parse(item);
    if (parsed === undefined) return undefined;
    values.push(parsed);
  }
  return { values, truncated: observed.truncated };
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
    const parsed = parseBoundedValues(
      result.value,
      MAX_PI_EXTENSION_LOADED_SOURCES,
      parseCommandInfo,
    );
    if (parsed === undefined) {
      this.reasons.add("commands-failed");
      return;
    }
    if (parsed.truncated) this.truncated = true;
    for (const command of parsed.values) {
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
    const parsed = parseBoundedValues(
      result.value,
      MAX_PI_EXTENSION_LOADED_SOURCES,
      parseToolInfo,
    );
    if (parsed === undefined) {
      this.reasons.add("tools-failed");
      return;
    }
    if (parsed.truncated) this.truncated = true;
    for (const tool of parsed.values) {
      this.addLoadedSourceInfo(tool.sourceInfo);
    }
  }

  /**
   * Builtin and SDK resources carry synthetic `<builtin:read>`-style paths and
   * can never be handed to a child, so an identity that cannot be derived is
   * skipped silently rather than reported as degradation.
   */
  private addLoadedSourceInfo(sourceInfo: PiSourceInfo | undefined): void {
    if (sourceInfo === undefined) return;
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
      scope: sourceInfo.scope,
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
    const parsed = parseBoundedValues(
      result.value,
      MAX_PI_EXTENSION_CONFIGURED_PACKAGES,
      parseConfiguredPackage,
    );
    if (parsed === undefined) {
      this.reasons.add("configured-packages-failed");
      return;
    }
    if (parsed.truncated) this.truncated = true;
    for (const configured of parsed.values) {
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
    const installedPath = parseHostText(result.value);
    return installedPath !== undefined &&
      isSafeChildExtensionPath(installedPath)
      ? installedPath
      : undefined;
  }

  // -- evidence: discovered files ------------------------------------------

  private async scanUserExtensions(): Promise<void> {
    const agentDirectoryPort = this.port.agentDirectory?.bind(this.port);
    if (agentDirectoryPort === undefined) {
      this.reasons.add("agent-directory-unavailable");
      return;
    }
    const result = await callPort(agentDirectoryPort);
    if (result.isErr()) {
      this.reasons.add("agent-directory-failed");
      return;
    }
    const agentDirectory = parseHostText(result.value);
    if (
      agentDirectory === undefined ||
      !isSafeChildExtensionPath(agentDirectory)
    ) {
      this.reasons.add("agent-directory-unsafe");
      return;
    }
    await this.scanExtensionsDirectory(
      join(agentDirectory, PI_EXTENSIONS_DIRECTORY),
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
      if (isDirectoryLike(item) && isExtensionDirectoryName(item.name)) {
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
    const parsed = parseBoundedValues(
      result.value,
      MAX_PI_EXTENSION_DIRECTORY_ENTRIES,
      parseDirectoryEntry,
    );
    if (parsed === undefined) {
      this.reasons.add("directory-listing-failed");
      return undefined;
    }
    if (parsed.truncated) this.truncated = true;
    return parsed.values;
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
    manifest: PiExtensionObservedValue,
  ): ManifestOutcome {
    const pi = readOwnDataProperty(manifest, "pi");
    if (pi.kind !== "value") {
      if (pi.kind === "missing") return { kind: "none" };
      this.reasons.add("package-manifest-invalid");
      return { kind: "unknown" };
    }
    if (pi.value === undefined) return { kind: "none" };
    const declared = readOwnDataProperty(pi.value, "extensions");
    if (declared.kind !== "value") {
      if (declared.kind === "missing") return { kind: "none" };
      this.reasons.add("package-manifest-invalid");
      return { kind: "unknown" };
    }
    if (declared.value === undefined) return { kind: "none" };
    const bounded = readBoundedObservedArray(
      declared.value,
      MAX_PI_EXTENSION_MANIFEST_ENTRIES,
    );
    if (bounded === undefined) {
      this.reasons.add("package-manifest-invalid");
      return { kind: "unknown" };
    }
    if (bounded.truncated) this.truncated = true;

    const paths: string[] = [];
    for (const value of bounded.values) {
      const parsedEntry = PI_EXTENSION_MANIFEST_ENTRY_SCHEMA.safeParse(value);
      if (!parsedEntry.success) {
        this.reasons.add("package-manifest-invalid");
        continue;
      }
      const resolved = this.resolveDeclaredEntry(directory, parsedEntry.data);
      if (resolved === undefined) continue;
      paths.push(resolved);
    }
    if (paths.length === 0) return { kind: "none" };
    return { kind: "declared", paths };
  }

  private resolveDeclaredEntry(
    directory: string,
    value: string,
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
  const override = readOwnDataProperty(
    env,
    WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV,
  );
  if (override.kind !== "value" || parseHostText(override.value) !== "1") {
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
