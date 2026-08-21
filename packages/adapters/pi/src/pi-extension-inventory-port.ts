/**
 * The impure edge of the child-extension selection stack (Pi adapter
 * contract).
 *
 * Three things live here, and nothing else:
 *
 * - {@link createBunPiExtensionInventoryPort}, the concrete read-only host
 *   port `collectPiExtensionInventory` consumes. It forwards loaded command
 *   and tool provenance plus configured-package evidence through injected
 *   host accessors, and scans the agent and project extension directories
 *   with `Bun.Glob`.
 * - {@link collectPiExtensionInventoryFromHost}, the production assembly:
 *   it builds those accessors from Pi's own public surfaces and proves which
 *   inventory path is this loader's own entry file.
 * - {@link resolveChildExtensionSpawnArgs}, the once-per-generation resolution
 *   that turns the stored preference plus that inventory into the argv slice
 *   `PiRpcChild` appends to a child spawn.
 *
 * Package evidence comes from Pi's exported `SettingsManager` and
 * `DefaultPackageManager`, constructed read-only for the current project and
 * used for exactly two calls: `listConfiguredPackages()` and
 * `getInstalledPath()`. Nothing here resolves, installs, updates, removes, or
 * writes settings, and nothing reaches the network. A host that does not
 * export those surfaces simply degrades, as it always did.
 *
 * Nothing here loads or evaluates another extension. Everything fallible
 * returns `Result`/`ResultAsync`, nothing throws on an expected path, and
 * nothing here logs: the caller decides what surfaces. Diagnostics carry
 * counts and closed reason codes, never ids or paths.
 */
import { join } from "node:path";
import type { RuntimeStore } from "@weaveio/weave-engine";
import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  CHILD_EXTENSION_SELECTION_KEY,
  type ChildExtensionPlan,
  type ChildExtensionSelectionDecodeReason,
  decodeChildExtensionSelection,
  isSafeChildExtensionPath,
  PI_PREFERENCE_NAMESPACE,
  resolveChildExtensionPlan,
} from "./child-extension-selection.js";
import type {
  PiHostObservedValue,
  PiHostRootExports,
} from "./host-inventory.js";
import { getPiExtensionEntryPath } from "./host-module-loader.js";
import {
  type CollectPiExtensionInventoryOptions,
  collectPiExtensionInventory,
  MAX_PI_EXTENSION_CONFIGURED_PACKAGES,
  MAX_PI_EXTENSION_LOADED_SOURCES,
  type PiExtensionInventory,
  type PiExtensionInventoryConfiguredPackage,
  type PiExtensionInventoryDegradation,
  type PiExtensionInventoryDegradationReason,
  type PiExtensionInventoryDirectoryEntry,
  type PiExtensionInventoryPort,
  type PiExtensionInventoryPortError,
  type PiExtensionInventoryToolInfo,
  WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV,
} from "./pi-extension-inventory.js";
import type {
  PiCommandInfo,
  PiResourceOrigin,
  PiResourceScope,
  PiSourceInfo,
  PiToolInfo,
  PiTrustState,
} from "./types.js";

/** Bound on names read from one directory before the listing is cut short. */
const MAX_SCANNED_DIRECTORY_NAMES = 256;
const FILESYSTEM_ERROR_CODE_SCHEMA = z.enum(["ENOENT", "ENOTDIR"]);

/**
 * The host accessors this port needs. Each is optional, and each is a plain
 * synchronous call a misbehaving host could still throw from, so every one is
 * invoked defensively.
 */
export interface BunPiExtensionInventoryHost {
  /** `pi.getCommands()`. */
  readonly commands?: () => readonly PiCommandInfo[] | undefined;
  /** `pi.getAllTools()`, projected to provenance only. */
  readonly tools?: () => readonly PiExtensionInventoryToolInfo[] | undefined;
  /**
   * `PackageManager.listConfiguredPackages()`. `undefined` means the host
   * answered with something this adapter cannot read, which is a failure,
   * not an empty list.
   */
  readonly configuredPackages?: () =>
    | readonly PiExtensionInventoryConfiguredPackage[]
    | undefined;
  /**
   * `PackageManager.getInstalledPath(source, scope)`. `undefined` is the
   * ordinary "configured but not installed" answer, never a failure.
   */
  readonly installedPackagePath?: (
    source: string,
    scope: "user" | "project",
  ) => string | undefined;
  /** `getAgentDir()`. */
  readonly agentDirectory?: () => string;
}

/** ENOENT is an ordinary answer: the directory simply does not exist. */
function classifyFilesystemError(
  cause: PiHostObservedValue,
): PiExtensionInventoryPortError {
  const code = readOwnDataProperty(cause, "code");
  if (code.kind === "value") {
    const parsed = FILESYSTEM_ERROR_CODE_SCHEMA.safeParse(code.value);
    if (parsed.success) return { type: "NotFound" };
  }
  return { type: "HostCallFailed" };
}

function parseHostResult<T>(
  result: Result<PiHostObservedValue, void>,
  parse: (value: PiHostObservedValue) => T | undefined,
): T | undefined {
  if (result.isErr()) return void 0;
  const parsed = Result.fromThrowable(
    () => parse(result.value),
    (): void => void 0,
  )();
  return parsed.isOk() ? parsed.value : void 0;
}

function toPortHostResult<T>(
  result: Result<PiHostObservedValue, void>,
  parse: (value: PiHostObservedValue) => T | undefined,
  malformed: PiExtensionInventoryPortError,
): ResultAsync<T, PiExtensionInventoryPortError> {
  if (result.isErr()) {
    return errAsync<T, PiExtensionInventoryPortError>({ type: "PortThrew" });
  }
  const parsed = parseHostResult(result, parse);
  if (parsed === undefined) {
    return errAsync<T, PiExtensionInventoryPortError>(malformed);
  }
  return okAsync<T, PiExtensionInventoryPortError>(parsed);
}

/**
 * Lists one directory's immediate children.
 *
 * `Bun.Glob` discovers names without following symlinks; each name is then
 * classified with a single `stat`, which does follow. A symlinked directory
 * therefore reports `directory`, which is how Pi's own discovery treats it,
 * and the collector accepts either classification for a symlink anyway.
 */
async function listDirectoryEntries(
  path: string,
): Promise<readonly PiExtensionInventoryDirectoryEntry[]> {
  const names: string[] = [];
  const glob = new Bun.Glob("*");
  for await (const name of glob.scan({
    cwd: path,
    onlyFiles: false,
    followSymlinks: false,
    dot: false,
  })) {
    if (name.includes("/")) continue;
    names.push(name);
    if (names.length >= MAX_SCANNED_DIRECTORY_NAMES) break;
  }
  const entries: PiExtensionInventoryDirectoryEntry[] = [];
  for (const name of names) {
    const stat = await Bun.file(join(path, name))
      .stat()
      .catch(() => void 0);
    if (stat === void 0) continue;
    entries.push({ name, kind: stat.isDirectory() ? "directory" : "file" });
  }
  return entries;
}

/** The concrete, read-only inventory port used in production. */
export function createBunPiExtensionInventoryPort(
  host: BunPiExtensionInventoryHost,
): PiExtensionInventoryPort {
  const port: PiExtensionInventoryPort = {
    listDirectory(path) {
      return ResultAsync.fromPromise(
        listDirectoryEntries(path),
        classifyFilesystemError,
      );
    },
    readJson(path) {
      return ResultAsync.fromPromise(
        Bun.file(path).json(),
        classifyFilesystemError,
      );
    },
  };
  const commands = readHostFunction(host, "commands");
  if (commands !== void 0) {
    port.commands = () =>
      toPortHostResult(callHostFunction(host, commands, []), parsePiCommands, {
        type: "HostCallFailed",
      });
  }
  const tools = readHostFunction(host, "tools");
  if (tools !== void 0) {
    port.tools = () =>
      toPortHostResult(callHostFunction(host, tools, []), parsePiTools, {
        type: "HostCallFailed",
      });
  }
  const configuredPackages = readHostFunction(host, "configuredPackages");
  if (configuredPackages !== void 0) {
    port.configuredPackages = () =>
      toPortHostResult(
        callHostFunction(host, configuredPackages, []),
        projectConfiguredPackages,
        { type: "HostCallFailed" },
      );
  }
  const installedPackagePath = readHostFunction(host, "installedPackagePath");
  if (installedPackagePath !== void 0) {
    port.installedPackagePath = (source, scope) =>
      toPortHostResult(
        callHostFunction(host, installedPackagePath, [source, scope]),
        parseHostText,
        { type: "NotFound" },
      );
  }
  const agentDirectory = readHostFunction(host, "agentDirectory");
  if (agentDirectory !== void 0) {
    port.agentDirectory = () =>
      toPortHostResult(
        callHostFunction(host, agentDirectory, []),
        parseHostText,
        { type: "HostCallFailed" },
      );
  }
  return port;
}

// ---------------------------------------------------------------------------
// Production host surfaces
// ---------------------------------------------------------------------------

/** Pi root export names this module reads. Read-only, never invoked blindly. */
const PI_SETTINGS_MANAGER_EXPORT = "SettingsManager";
const PI_PACKAGE_MANAGER_EXPORT = "DefaultPackageManager";
const PI_AGENT_DIRECTORY_EXPORT = "getAgentDir";
type PiRootExportName =
  | typeof PI_SETTINGS_MANAGER_EXPORT
  | typeof PI_PACKAGE_MANAGER_EXPORT
  | typeof PI_AGENT_DIRECTORY_EXPORT;

const HOST_TEXT_SCHEMA = z.string();
const MAX_HOST_ARRAY_ITEMS = 4_096;
const MAX_HOST_MEMBER_DEPTH = 16;

interface HostObjectReference {
  readonly inventoryHostObjectMarker?: never;
}

interface HostArrayReference extends ReadonlyArray<PiHostObservedValue> {
  readonly inventoryHostArrayMarker?: never;
}

interface MutableBunPiExtensionInventoryHost {
  commands?: () => readonly PiCommandInfo[] | undefined;
  tools?: () => readonly PiExtensionInventoryToolInfo[] | undefined;
  configuredPackages?: () =>
    | readonly PiExtensionInventoryConfiguredPackage[]
    | undefined;
  installedPackagePath?: (
    source: string,
    scope: "user" | "project",
  ) => string | undefined;
  agentDirectory?: () => string;
}

const HOST_REFERENCE_SCHEMA = z.custom<HostObjectReference>((value) => {
  const checked = Result.fromThrowable(
    (): boolean =>
      value !== null && Object(value) === value && !Array.isArray(value),
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
});

const HOST_PLAIN_OBJECT_SCHEMA = z.custom<HostObjectReference>((value) => {
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
      if (prototype === Object.prototype || prototype === null) return true;

      // Bun represents an `import * as ...` namespace with a small wrapper
      // prototype (`__esModule`) instead of the spec's null prototype. Accept
      // that wrapper shape without reading its accessor or any host property.
      if (Object.getPrototypeOf(prototype) !== null) return false;
      const esModule = Object.getOwnPropertyDescriptor(prototype, "__esModule");
      if (esModule === undefined) return false;
      if ("value" in esModule && esModule.value !== true) return false;
      const tag = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
      return "value" in (tag ?? {}) && tag?.value === "Module";
    },
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
});

const HOST_INSTANCE_SCHEMA = z.custom<HostObjectReference>((value) => {
  const checked = Result.fromThrowable(
    (): boolean =>
      value !== null &&
      Object(value) === value &&
      !Array.isArray(value) &&
      !(value instanceof Function),
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
});

const HOST_ARRAY_SCHEMA = z.custom<HostArrayReference>((value) => {
  const checked = Result.fromThrowable(
    (): boolean => Array.isArray(value),
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
});

export interface PiReadOnlyPackageManager {
  listConfiguredPackages():
    | readonly PiExtensionInventoryConfiguredPackage[]
    | undefined;
  getInstalledPath(
    source: string,
    scope: "user" | "project",
  ): string | undefined;
}

/** The extension-API members the inventory reads. Both are optional. */
export interface PiInventoryExtensionApi {
  getCommands?: () => readonly PiCommandInfo[];
  getAllTools?: () => readonly PiToolInfo[];
}

export interface PiExtensionInventoryHostInput {
  /** The extension API object Pi handed this extension. */
  readonly api: PiInventoryExtensionApi;
  /** Pi's public root exports (`import * as ...`), read only. */
  readonly rootExports?: PiHostRootExports;
  /** Absolute project root; scopes settings and project package lookups. */
  readonly cwd: string;
  /** Project trust exactly as this generation proved it. */
  readonly trust: PiTrustState;
}

type HostFunction = (
  ...args: readonly PiHostObservedValue[]
) => PiHostObservedValue;

type HostDataRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: PiHostObservedValue };

/** Reads one own data descriptor without invoking a getter. */
function readDataDescriptor(
  target: HostObjectReference,
  name: string,
): HostDataRead {
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(target, name),
    (): PropertyDescriptor | undefined => void 0,
  )();
  if (descriptor.isErr()) return { kind: "invalid" };
  if (descriptor.value === void 0) return { kind: "missing" };
  if (!("value" in descriptor.value)) return { kind: "invalid" };
  return { kind: "value", value: descriptor.value.value };
}

function readOwnDataProperty(
  value: PiHostObservedValue,
  name: string,
): HostDataRead {
  const reference = HOST_REFERENCE_SCHEMA.safeParse(value);
  if (!reference.success) return { kind: "invalid" };
  return readDataDescriptor(reference.data, name);
}

function readEnumerableDataDescriptor(
  target: HostObjectReference,
  name: string,
): HostDataRead {
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(target, name),
    (): PropertyDescriptor | undefined => void 0,
  )();
  if (descriptor.isErr()) return { kind: "invalid" };
  if (descriptor.value === void 0) return { kind: "missing" };
  if (!("value" in descriptor.value) || descriptor.value.enumerable !== true) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: descriptor.value.value };
}

function readPlainDataProperty(
  value: PiHostObservedValue,
  name: string,
): HostDataRead {
  const record = HOST_PLAIN_OBJECT_SCHEMA.safeParse(value);
  if (!record.success) return { kind: "invalid" };
  return readEnumerableDataDescriptor(record.data, name);
}

/** Reads an own or prototype data member, bounded to Pi's class hierarchy. */
function readHostMember(
  value: PiHostObservedValue,
  name: string,
): HostDataRead {
  const first = HOST_REFERENCE_SCHEMA.safeParse(value);
  if (!first.success) return { kind: "invalid" };
  let current: HostObjectReference | undefined = first.data;
  const seen = new Set<HostObjectReference>();
  for (
    let depth = 0;
    current !== undefined && depth < MAX_HOST_MEMBER_DEPTH;
    depth += 1
  ) {
    if (seen.has(current)) return { kind: "invalid" };
    seen.add(current);
    const own = readDataDescriptor(current, name);
    if (own.kind !== "missing") return own;
    const prototype = Result.fromThrowable(
      () => Object.getPrototypeOf(current),
      (): object | null => null,
    )();
    if (prototype.isErr()) return { kind: "invalid" };
    if (prototype.value === null || prototype.value === Object.prototype) {
      return { kind: "missing" };
    }
    const parsedPrototype = HOST_REFERENCE_SCHEMA.safeParse(prototype.value);
    if (!parsedPrototype.success) return { kind: "invalid" };
    current = parsedPrototype.data;
  }
  return current === undefined ? { kind: "missing" } : { kind: "invalid" };
}

const HOST_CALLABLE_SCHEMA = z.custom<HostFunction>((value) => {
  const checked = Result.fromThrowable(
    (): boolean => value instanceof Function,
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
});

function readHostFunction(
  target: PiHostObservedValue,
  name: string,
): HostFunction | undefined {
  const member = readHostMember(target, name);
  if (member.kind !== "value") return void 0;
  const callable = HOST_CALLABLE_SCHEMA.safeParse(member.value);
  return callable.success ? callable.data : void 0;
}

function readOwnHostFunction(
  target: PiHostObservedValue,
  name: string,
): HostFunction | undefined {
  const member = readOwnDataProperty(target, name);
  if (member.kind !== "value") return void 0;
  const callable = HOST_CALLABLE_SCHEMA.safeParse(member.value);
  return callable.success ? callable.data : void 0;
}

/** Calls a host function once, defensively, and keeps a throw off the stack. */
function callHostFunction(
  target: PiHostObservedValue,
  call: HostFunction,
  args: readonly PiHostObservedValue[],
): Result<PiHostObservedValue, void> {
  return Result.fromThrowable(
    () => call.apply(target, [...args]),
    (): void => void 0,
  )();
}

function parseHostText(value: PiHostObservedValue): string | undefined {
  const parsed = HOST_TEXT_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : void 0;
}

function readHostArray(
  value: PiHostObservedValue,
  maxItems: number,
): readonly PiHostObservedValue[] | undefined {
  const array = HOST_ARRAY_SCHEMA.safeParse(value);
  if (!array.success) return void 0;
  const lengthDescriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(array.data, "length"),
    (): PropertyDescriptor | undefined => void 0,
  )();
  if (lengthDescriptor.isErr() || lengthDescriptor.value === void 0) {
    return void 0;
  }
  if (
    !("value" in lengthDescriptor.value) ||
    lengthDescriptor.value.enumerable === true
  ) {
    return void 0;
  }
  const parsedLength = z
    .number()
    .int()
    .min(0)
    .max(MAX_HOST_ARRAY_ITEMS)
    .safeParse(lengthDescriptor.value.value);
  if (!parsedLength.success) return void 0;
  const values: PiHostObservedValue[] = [];
  const limit = Math.min(parsedLength.data, maxItems);
  for (let index = 0; index < limit; index += 1) {
    const descriptor = Result.fromThrowable(
      () => Object.getOwnPropertyDescriptor(array.data, String(index)),
      (): PropertyDescriptor | undefined => void 0,
    )();
    if (descriptor.isErr() || descriptor.value === void 0) return void 0;
    if (
      !("value" in descriptor.value) ||
      descriptor.value.enumerable !== true
    ) {
      return void 0;
    }
    values.push(descriptor.value.value);
  }
  return values;
}

interface MutablePiSourceInfo {
  path: string;
  source: string;
  scope: PiResourceScope;
  origin: PiResourceOrigin;
  baseDir?: string;
}

const PI_RESOURCE_SCOPE_SCHEMA = z.enum(["user", "project", "temporary"]);
const PI_RESOURCE_ORIGIN_SCHEMA = z.enum(["package", "top-level"]);
const PI_COMMAND_SOURCE_SCHEMA = z.enum(["extension", "prompt", "skill"]);

function parsePiSourceInfo(
  value: PiHostObservedValue,
): PiSourceInfo | undefined {
  const path = readPlainDataProperty(value, "path");
  const source = readPlainDataProperty(value, "source");
  const scope = readPlainDataProperty(value, "scope");
  const origin = readPlainDataProperty(value, "origin");
  if (
    path.kind !== "value" ||
    source.kind !== "value" ||
    scope.kind !== "value" ||
    origin.kind !== "value"
  ) {
    return void 0;
  }
  const parsedPath = HOST_TEXT_SCHEMA.safeParse(path.value);
  const parsedSource = HOST_TEXT_SCHEMA.safeParse(source.value);
  const parsedScope = PI_RESOURCE_SCOPE_SCHEMA.safeParse(scope.value);
  const parsedOrigin = PI_RESOURCE_ORIGIN_SCHEMA.safeParse(origin.value);
  if (
    !parsedPath.success ||
    !parsedSource.success ||
    !parsedScope.success ||
    !parsedOrigin.success
  ) {
    return void 0;
  }
  const result: MutablePiSourceInfo = {
    path: parsedPath.data,
    source: parsedSource.data,
    scope: parsedScope.data,
    origin: parsedOrigin.data,
  };
  const baseDir = readPlainDataProperty(value, "baseDir");
  if (baseDir.kind === "invalid") return void 0;
  if (baseDir.kind === "value" && baseDir.value !== void 0) {
    const parsedBaseDir = HOST_TEXT_SCHEMA.safeParse(baseDir.value);
    if (!parsedBaseDir.success) return void 0;
    result.baseDir = parsedBaseDir.data;
  }
  return result;
}

function parsePiCommand(value: PiHostObservedValue): PiCommandInfo | undefined {
  const name = readPlainDataProperty(value, "name");
  const source = readPlainDataProperty(value, "source");
  const sourceInfo = readPlainDataProperty(value, "sourceInfo");
  if (
    name.kind !== "value" ||
    source.kind !== "value" ||
    sourceInfo.kind !== "value"
  ) {
    return void 0;
  }
  const parsedName = HOST_TEXT_SCHEMA.min(1).safeParse(name.value);
  const parsedSource = PI_COMMAND_SOURCE_SCHEMA.safeParse(source.value);
  const parsedSourceInfo = parsePiSourceInfo(sourceInfo.value);
  if (
    !parsedName.success ||
    !parsedSource.success ||
    parsedSourceInfo === undefined
  ) {
    return void 0;
  }
  const command: MutablePiCommandInfo = {
    name: parsedName.data,
    source: parsedSource.data,
    sourceInfo: parsedSourceInfo,
  };
  const description = readPlainDataProperty(value, "description");
  if (description.kind === "invalid") return void 0;
  if (description.kind === "value" && description.value !== void 0) {
    const parsedDescription = HOST_TEXT_SCHEMA.safeParse(description.value);
    if (!parsedDescription.success) return void 0;
    command.description = parsedDescription.data;
  }
  return command;
}

interface MutablePiCommandInfo {
  name: string;
  source: PiCommandInfo["source"];
  sourceInfo: PiSourceInfo;
  description?: string;
}

interface MutablePiToolInfo {
  name: string;
  sourceInfo?: PiSourceInfo;
}

interface MutableConfiguredPackage {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
}

function parsePiTool(
  value: PiHostObservedValue,
): PiExtensionInventoryToolInfo | undefined {
  const name = readPlainDataProperty(value, "name");
  if (name.kind !== "value") return void 0;
  const parsedName = HOST_TEXT_SCHEMA.min(1).safeParse(name.value);
  if (!parsedName.success) return void 0;
  const tool: MutablePiToolInfo = {
    name: parsedName.data,
  };
  const sourceInfo = readPlainDataProperty(value, "sourceInfo");
  if (sourceInfo.kind === "invalid") return void 0;
  if (sourceInfo.kind === "value" && sourceInfo.value !== void 0) {
    const parsedSourceInfo = parsePiSourceInfo(sourceInfo.value);
    if (parsedSourceInfo === undefined) return void 0;
    tool.sourceInfo = parsedSourceInfo;
  }
  return tool;
}

function parsePiCommands(
  value: PiHostObservedValue,
): readonly PiCommandInfo[] | undefined {
  const values = readHostArray(value, MAX_PI_EXTENSION_LOADED_SOURCES + 1);
  if (values === undefined) return void 0;
  const commands: PiCommandInfo[] = [];
  for (const item of values) {
    const command = parsePiCommand(item);
    if (command === undefined) return void 0;
    commands.push(command);
  }
  return commands;
}

function parsePiTools(
  value: PiHostObservedValue,
): readonly PiExtensionInventoryToolInfo[] | undefined {
  const values = readHostArray(value, MAX_PI_EXTENSION_LOADED_SOURCES + 1);
  if (values === undefined) return void 0;
  const tools: PiExtensionInventoryToolInfo[] = [];
  for (const item of values) {
    const tool = parsePiTool(item);
    if (tool === undefined) return void 0;
    tools.push(tool);
  }
  return tools;
}

function readPiRootExport(
  rootExports: PiHostRootExports | undefined,
  name: PiRootExportName,
): PiHostObservedValue | undefined {
  if (rootExports === undefined) return void 0;
  const root = HOST_PLAIN_OBJECT_SCHEMA.safeParse(rootExports);
  if (!root.success) return void 0;
  const member = readEnumerableDataDescriptor(root.data, name);
  return member.kind === "value" ? member.value : void 0;
}

/** Reads `getAgentDir()` once from Pi's exact root export. */
function readAgentDirectory(
  rootExports: PiHostRootExports | undefined,
): string | undefined {
  const exported = readPiRootExport(rootExports, PI_AGENT_DIRECTORY_EXPORT);
  if (exported === undefined) return void 0;
  const callable = HOST_CALLABLE_SCHEMA.safeParse(exported);
  if (!callable.success) return void 0;
  const value = callHostFunction(rootExports, callable.data, []);
  if (value.isErr()) return void 0;
  const parsed = parseHostText(value.value);
  return parsed !== undefined && parsed.length > 0 ? parsed : void 0;
}

interface PiPackageManagerOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly settingsManager: PiHostObservedValue;
}

interface PiPackageManagerInstance {
  listConfiguredPackages(): PiHostObservedValue;
  getInstalledPath(
    source: string,
    scope: "user" | "project",
  ): PiHostObservedValue;
}

type PiPackageManagerConstructor = new (
  options: PiPackageManagerOptions,
) => PiPackageManagerInstance;

const PI_PACKAGE_MANAGER_CONSTRUCTOR_SCHEMA =
  z.custom<PiPackageManagerConstructor>((value) => {
    const checked = Result.fromThrowable(
      (): boolean => {
        if (!(value instanceof Function)) return false;
        const prototype = Object.getOwnPropertyDescriptor(value, "prototype");
        if (prototype === undefined || !("value" in prototype)) return false;
        return HOST_INSTANCE_SCHEMA.safeParse(prototype.value).success;
      },
      (): boolean => false,
    )();
    return checked.isOk() && checked.value;
  });

/**
 * Builds Pi's own package manager for read-only questions.
 *
 * `SettingsManager.create` reads the global and project settings files, and
 * `DefaultPackageManager`'s constructor only stores what it is given, so this
 * duplicates no host lifecycle and mutates nothing. Project trust is passed
 * through unchanged: an untrusted project must not have its settings adopted
 * as trusted here.
 */
export function createPiReadOnlyPackageManager(input: {
  readonly rootExports?: PiHostRootExports;
  readonly cwd: string;
  readonly agentDir: string;
  readonly trust: PiTrustState;
}): PiReadOnlyPackageManager | undefined {
  const settingsManagerValue = readPiRootExport(
    input.rootExports,
    PI_SETTINGS_MANAGER_EXPORT,
  );
  const packageManagerValue = readPiRootExport(
    input.rootExports,
    PI_PACKAGE_MANAGER_EXPORT,
  );
  if (settingsManagerValue === undefined || packageManagerValue === undefined) {
    return void 0;
  }
  const create = readOwnHostFunction(settingsManagerValue, "create");
  if (create === undefined) return void 0;
  const settingsManagerResult = callHostFunction(settingsManagerValue, create, [
    input.cwd,
    input.agentDir,
    { projectTrusted: input.trust === "trusted" },
  ]);
  if (settingsManagerResult.isErr()) return void 0;
  const settingsManager = HOST_INSTANCE_SCHEMA.safeParse(
    settingsManagerResult.value,
  );
  if (!settingsManager.success) return void 0;

  const packageManagerConstructor =
    PI_PACKAGE_MANAGER_CONSTRUCTOR_SCHEMA.safeParse(packageManagerValue);
  if (!packageManagerConstructor.success) return void 0;
  const options: PiPackageManagerOptions = {
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: settingsManager.data,
  };
  const constructed = Result.fromThrowable(
    () => new packageManagerConstructor.data(options),
    (): void => void 0,
  )();
  if (constructed.isErr()) return void 0;
  const manager = constructed.value;
  const list = readHostFunction(manager, "listConfiguredPackages");
  const installedPath = readHostFunction(manager, "getInstalledPath");
  if (list === undefined || installedPath === undefined) return void 0;
  return {
    listConfiguredPackages: () =>
      parseHostResult(
        callHostFunction(manager, list, []),
        projectConfiguredPackages,
      ),
    getInstalledPath: (source, scope) =>
      parseHostResult(
        callHostFunction(manager, installedPath, [source, scope]),
        parseHostText,
      ),
  };
}

/** Projects Pi's `ConfiguredPackage[]`; `undefined` marks an unreadable answer. */
export function projectConfiguredPackages(
  value: PiHostObservedValue,
): readonly PiExtensionInventoryConfiguredPackage[] | undefined {
  const values = readHostArray(value, MAX_PI_EXTENSION_CONFIGURED_PACKAGES + 1);
  if (values === undefined) return void 0;
  const packages: PiExtensionInventoryConfiguredPackage[] = [];
  for (const item of values) {
    const source = readPlainDataProperty(item, "source");
    const scope = readPlainDataProperty(item, "scope");
    if (source.kind !== "value" || scope.kind !== "value") continue;
    const parsedSource = HOST_TEXT_SCHEMA.safeParse(source.value);
    const parsedScope = z.enum(["user", "project"]).safeParse(scope.value);
    if (!parsedSource.success || !parsedScope.success) continue;
    const packageEntry: MutableConfiguredPackage = {
      source: parsedSource.data,
      scope: parsedScope.data,
    };
    const installedPath = readPlainDataProperty(item, "installedPath");
    if (installedPath.kind === "invalid") continue;
    if (installedPath.kind === "value") {
      const parsedPath = HOST_TEXT_SCHEMA.safeParse(installedPath.value);
      if (parsedPath.success) packageEntry.installedPath = parsedPath.data;
    }
    packages.push(packageEntry);
  }
  return packages;
}

/**
 * Builds every host accessor the inventory can have from Pi's public
 * surfaces. A surface Pi does not expose is left out, which the collector
 * reports as an ordinary degradation reason instead of an error.
 */
export function createPiExtensionInventoryHost(
  input: PiExtensionInventoryHostInput,
): BunPiExtensionInventoryHost {
  const host: MutableBunPiExtensionInventoryHost = {};
  const api = input.api;
  const getCommands = readHostFunction(api, "getCommands");
  if (getCommands !== undefined) {
    host.commands = () => {
      const result = callHostFunction(api, getCommands, []);
      return parseHostResult(result, parsePiCommands);
    };
  }
  const getAllTools = readHostFunction(api, "getAllTools");
  if (getAllTools !== undefined) {
    host.tools = () => {
      const result = callHostFunction(api, getAllTools, []);
      return parseHostResult(result, parsePiTools);
    };
  }

  const agentDir = readAgentDirectory(input.rootExports);
  if (agentDir !== undefined) host.agentDirectory = () => agentDir;

  const packageManager =
    agentDir === undefined
      ? undefined
      : createPiReadOnlyPackageManager({
          rootExports: input.rootExports,
          cwd: input.cwd,
          agentDir,
          trust: input.trust,
        });
  if (packageManager !== undefined) {
    host.configuredPackages = () => packageManager.listConfiguredPackages();
    host.installedPackagePath = (source, scope) =>
      packageManager.getInstalledPath(source, scope);
  }

  return host;
}

// ---------------------------------------------------------------------------
// Own-entry identity
// ---------------------------------------------------------------------------

/** Bound on candidate paths probed for filesystem identity in one collection. */
export const MAX_OWN_ENTRY_IDENTITY_PROBES = 64;

/**
 * Opaque filesystem identity of one path, following symlinks. Two paths with
 * the same identity are the same file.
 */
export type PiExtensionFileIdentity = string;

export type PiExtensionFileIdentifier = (
  path: string,
) => Promise<PiExtensionFileIdentity | undefined>;

/** Production identity: device plus inode, resolved through symlinks. */
export const identifyExtensionFile: PiExtensionFileIdentifier = async (
  path,
) => {
  const stat = await Bun.file(path)
    .stat()
    .catch(() => void 0);
  if (stat === undefined) return void 0;
  const { dev, ino } = stat;
  if (!Number.isFinite(dev) || !Number.isFinite(ino)) return void 0;
  return `${dev}:${ino}`;
};

/** Calls the injected identity seam without allowing a sync throw to escape. */
async function identifySafely(
  identify: PiExtensionFileIdentifier,
  path: string,
): Promise<string | undefined> {
  const result = await ResultAsync.fromThrowable(
    () => identify(path),
    (): void => void 0,
  )();
  return result.match(
    (identity) => identity,
    () => void 0,
  );
}

function parseHostStringArray(
  value: PiHostObservedValue,
  maxItems: number,
): readonly string[] | undefined {
  const values = readHostArray(value, maxItems);
  if (values === undefined) return void 0;
  const strings: string[] = [];
  for (const item of values) {
    const parsed = HOST_TEXT_SCHEMA.safeParse(item);
    if (!parsed.success) return void 0;
    strings.push(parsed.data);
  }
  return strings;
}

/**
 * Resolves the loader's own entry path *as the host reports it*.
 *
 * Pi records the path it discovered — under the local development setup that
 * is the symlinked `<agentDir>/extensions/...` path — while the loader knows
 * only the path its own module resolved to. Comparing the two by filesystem
 * identity proves sameness without guessing, so the override-based mandatory
 * mark lands on the entry the inventory actually holds. When nothing is
 * proven, the recorded path is returned unchanged and exact matching applies.
 */
export async function resolveOwnExtensionEntryPath(input: {
  readonly recordedEntryPath?: string;
  readonly candidatePaths: readonly string[];
  readonly identify: PiExtensionFileIdentifier;
}): Promise<string | undefined> {
  const recorded = input.recordedEntryPath;
  if (recorded === undefined) return void 0;
  if (!isSafeChildExtensionPath(recorded)) return void 0;

  const parsedCandidates = parseHostStringArray(
    input.candidatePaths,
    MAX_OWN_ENTRY_IDENTITY_PROBES,
  );
  const candidatePaths = parsedCandidates === undefined ? [] : parsedCandidates;
  const candidates: string[] = [];
  for (const path of candidatePaths) {
    if (path === recorded) return recorded;
    if (!isSafeChildExtensionPath(path)) continue;
    if (candidates.includes(path)) continue;
    candidates.push(path);
    if (candidates.length >= MAX_OWN_ENTRY_IDENTITY_PROBES) break;
  }
  if (candidates.length === 0) return recorded;

  const ownIdentity = await identifySafely(input.identify, recorded);
  if (ownIdentity === undefined) return recorded;
  for (const candidate of candidates) {
    const identity = await identifySafely(input.identify, candidate);
    if (identity !== undefined && identity === ownIdentity) return candidate;
  }
  return recorded;
}

function hostCandidatePaths(host: BunPiExtensionInventoryHost): string[] {
  const paths: string[] = [];
  const commands = readHostFunction(host, "commands");
  if (commands !== undefined) {
    const result = callHostFunction(host, commands, []);
    const parsed = parseHostResult(result, parsePiCommands);
    if (parsed !== undefined) {
      for (const command of parsed) {
        if (command.source === "extension") {
          paths.push(command.sourceInfo.path);
        }
      }
    }
  }
  const tools = readHostFunction(host, "tools");
  if (tools !== undefined) {
    const result = callHostFunction(host, tools, []);
    const parsed = parseHostResult(result, parsePiTools);
    if (parsed !== undefined) {
      for (const tool of parsed) {
        if (tool.sourceInfo !== undefined) paths.push(tool.sourceInfo.path);
      }
    }
  }
  return paths;
}

interface OwnEntryPathInput {
  candidatePaths: readonly string[];
  identify: PiExtensionFileIdentifier;
  recordedEntryPath?: string;
}

export interface CollectPiExtensionInventoryFromHostInput
  extends PiExtensionInventoryHostInput {
  /** Isolated environment table. Production reads `Bun.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam for the loader fact. Production reads the set-once accessor. */
  readonly ownEntryPath?: string;
  /** Test seam for filesystem identity. Production stats the real file. */
  readonly identify?: PiExtensionFileIdentifier;
}

/**
 * The production collection: Pi's public surfaces, this loader's own entry
 * fact, and the bounded read-only scans, assembled once.
 *
 * The identity probes run only while the unsafe provenance override is
 * exactly `1`; with ordinary provenance enforcement the adapter proves itself
 * from `sourceInfo` alone and no path comparison is needed.
 */
type MutableCollectPiExtensionInventoryOptions = {
  trust: PiTrustState;
  cwd: string;
  ownEntryPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

function readEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = readOwnDataProperty(env, name);
  if (value.kind !== "value") return void 0;
  return parseHostText(value.value);
}

export function collectPiExtensionInventoryFromHost(
  input: CollectPiExtensionInventoryFromHostInput,
): ResultAsync<PiExtensionInventory, PiExtensionInventoryDegradation> {
  const host = createPiExtensionInventoryHost(input);
  const port = createBunPiExtensionInventoryPort(host);
  const env = input.env ?? Bun.env;
  const recordedEntryPath = input.ownEntryPath ?? getPiExtensionEntryPath();
  const overrideValue = readEnvironmentValue(
    env,
    WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV,
  );
  const overrideActive = overrideValue === "1";
  let ownEntryPath: ResultAsync<string | undefined, never>;
  if (overrideActive) {
    const ownEntryInput: OwnEntryPathInput = {
      candidatePaths: hostCandidatePaths(host),
      identify: input.identify ?? identifyExtensionFile,
    };
    if (recordedEntryPath !== undefined) {
      ownEntryInput.recordedEntryPath = recordedEntryPath;
    }
    ownEntryPath = ResultAsync.fromSafePromise(
      resolveOwnExtensionEntryPath(ownEntryInput).catch(
        () => recordedEntryPath,
      ),
    );
  } else {
    ownEntryPath = okAsync(recordedEntryPath);
  }

  return ownEntryPath.andThen((entryPath) => {
    const options: MutableCollectPiExtensionInventoryOptions = {
      trust: input.trust,
      cwd: input.cwd,
    };
    if (entryPath !== undefined) options.ownEntryPath = entryPath;
    if (input.env !== undefined) options.env = input.env;
    const collectedOptions: CollectPiExtensionInventoryOptions = options;
    return collectPiExtensionInventory(port, collectedOptions);
  });
}

// ---------------------------------------------------------------------------
// Generation resolution
// ---------------------------------------------------------------------------

/** Why a generation kept the inherit-all default instead of an explicit plan. */
export type ChildExtensionArgsFallbackReason =
  | "preference-read-failed"
  | "weave-entry-unresolved";

/**
 * Bounded, path-free and id-free summary of one generation's resolution. It
 * is safe to log verbatim.
 */
export interface ChildExtensionArgsDiagnostics {
  /** Why stored text could not be used, when text was stored at all. */
  readonly decode?: ChildExtensionSelectionDecodeReason;
  /** Inventory reasons, in the collector's canonical order. */
  readonly inventoryDegraded?: readonly PiExtensionInventoryDegradationReason[];
  /** How many stored entries did not survive resolution. */
  readonly droppedEntries?: number;
  /** Why an explicit selection degraded back to inherit-all. */
  readonly fallback?: ChildExtensionArgsFallbackReason;
}

export interface ChildExtensionArgsResolution {
  /** Argv slice for `PiRpcChild`; empty means inherit-all. */
  readonly args: readonly string[];
  /** Present only when something is worth reporting once per generation. */
  readonly diagnostics?: ChildExtensionArgsDiagnostics;
}

const EMPTY_CHILD_EXTENSION_ARGS: readonly string[] = Object.freeze([]);
const INHERIT_ALL: ChildExtensionArgsResolution = Object.freeze({
  args: EMPTY_CHILD_EXTENSION_ARGS,
});

function fallbackResolution(
  fallback: ChildExtensionArgsFallbackReason,
): ChildExtensionArgsResolution {
  return { args: [], diagnostics: { fallback } };
}

function decodeResolution(
  decode: ChildExtensionSelectionDecodeReason,
): ChildExtensionArgsResolution {
  return { args: [], diagnostics: { decode } };
}

/** `--no-extensions -e <weave> -e <selected>…`, or nothing for inherit-all. */
export function renderChildExtensionArgs(
  plan: ChildExtensionPlan,
): readonly string[] {
  if (plan.mode === "inherit-all" || plan.paths.length === 0) return [];
  const args: string[] = ["--no-extensions"];
  for (const path of plan.paths) args.push("-e", path);
  return args;
}

export interface ResolveChildExtensionSpawnArgsInput {
  /** The trusted project's already-open Runtime Store. */
  readonly store: Pick<RuntimeStore, "preferences">;
  /**
   * Collects the live inventory. Injected so this resolution is testable
   * without a host, and called only when an explicit selection is stored.
   */
  readonly collectInventory: () => ResultAsync<
    PiExtensionInventory,
    PiExtensionInventoryDegradation
  >;
}

interface GatheredInventory {
  readonly inventory: PiExtensionInventory;
  readonly reasons?: readonly PiExtensionInventoryDegradationReason[];
}

interface MutableChildExtensionArgsDiagnostics {
  decode?: ChildExtensionSelectionDecodeReason;
  inventoryDegraded?: readonly PiExtensionInventoryDegradationReason[];
  droppedEntries?: number;
  fallback?: ChildExtensionArgsFallbackReason;
}

/**
 * Resolves this generation's child-extension argv exactly once.
 *
 * Every step is fail-open: a store failure, undecodable stored text, a
 * degraded inventory, or an underivable Weave entry all keep today's
 * inherit-all argv rather than spawning a child that is missing the Weave
 * adapter. The inventory is collected only when an explicit selection is
 * actually stored, so the default costs exactly one preference read.
 */
export function resolveChildExtensionSpawnArgs(
  input: ResolveChildExtensionSpawnArgsInput,
): ResultAsync<ChildExtensionArgsResolution, never> {
  return input.store.preferences
    .get(PI_PREFERENCE_NAMESPACE, CHILD_EXTENSION_SELECTION_KEY)
    .map((stored): string | null | undefined => stored?.valueJson ?? null)
    .orElse(() => okAsync(void 0))
    .andThen((valueJson) => {
      if (valueJson === undefined) {
        return okAsync(fallbackResolution("preference-read-failed"));
      }
      const decoded = decodeChildExtensionSelection(valueJson);
      // Undecodable text always decodes to the inherit-all default, so a
      // decode diagnostic and an explicit record are mutually exclusive.
      if (decoded.record.mode === "inherit-all") {
        const decode = decoded.diagnostic?.reason;
        if (decode === undefined) return okAsync(INHERIT_ALL);
        return okAsync(decodeResolution(decode));
      }
      const record = decoded.record;
      return ResultAsync.fromSafePromise(
        input.collectInventory().match(
          (inventory): GatheredInventory => ({ inventory }),
          (degradation): GatheredInventory => ({
            inventory: degradation.inventory,
            reasons: degradation.reasons,
          }),
        ),
      ).map((gathered) => {
        const degraded: MutableChildExtensionArgsDiagnostics = {};
        if (gathered.reasons !== undefined) {
          degraded.inventoryDegraded = gathered.reasons;
        }
        // The Weave adapter is never persisted in the record: it is derived
        // here from live evidence, so a stale stored path can neither disable
        // nor misdirect the adapter in a child.
        const weaveEntry = gathered.inventory.entries.find(
          (entry) => entry.mandatory && isSafeChildExtensionPath(entry.path),
        );
        if (weaveEntry === undefined) {
          const diagnostics: MutableChildExtensionArgsDiagnostics = {
            ...degraded,
          };
          diagnostics.fallback = "weave-entry-unresolved";
          return { args: [], diagnostics };
        }
        const plan = resolveChildExtensionPlan({
          record,
          inventory: gathered.inventory.entries,
          weaveEntry: { id: weaveEntry.id, path: weaveEntry.path },
        });
        const droppedEntries = plan.diagnostics.length;
        const diagnostics: MutableChildExtensionArgsDiagnostics = {
          ...degraded,
        };
        if (droppedEntries !== 0) diagnostics.droppedEntries = droppedEntries;
        const args = renderChildExtensionArgs(plan);
        if (Object.keys(diagnostics).length === 0) return { args };
        return { args, diagnostics };
      });
    });
}
