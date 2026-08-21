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
import {
  CHILD_EXTENSION_SELECTION_KEY,
  type ChildExtensionPlan,
  type ChildExtensionSelectionDecodeReason,
  decodeChildExtensionSelection,
  isSafeChildExtensionPath,
  MAX_CHILD_EXTENSION_ENTRIES,
  PI_PREFERENCE_NAMESPACE,
  resolveChildExtensionPlan,
} from "./child-extension-selection.js";
import { getPiExtensionEntryPath } from "./host-module-loader.js";
import {
  collectPiExtensionInventory,
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
import type { PiCommandInfo, PiToolInfo, PiTrustState } from "./types.js";

/** Bound on names read from one directory before the listing is cut short. */
const MAX_SCANNED_DIRECTORY_NAMES = 256;

/**
 * The host accessors this port needs. Each is optional, and each is a plain
 * synchronous call a misbehaving host could still throw from, so every one is
 * invoked defensively.
 */
export interface BunPiExtensionInventoryHost {
  /** `pi.getCommands()`. */
  readonly commands?: () => readonly PiCommandInfo[];
  /** `pi.getAllTools()`, projected to provenance only. */
  readonly tools?: () => readonly PiExtensionInventoryToolInfo[];
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

function callHost<T>(
  call: () => T,
): ResultAsync<T, PiExtensionInventoryPortError> {
  return ResultAsync.fromPromise(
    Promise.resolve().then(call),
    (): PiExtensionInventoryPortError => ({ type: "PortThrew" }),
  );
}

/** ENOENT is an ordinary answer: the directory simply does not exist. */
function classifyFilesystemError(
  cause: unknown,
): PiExtensionInventoryPortError {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { readonly code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR"
    ? { type: "NotFound" }
    : { type: "HostCallFailed" };
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
      .catch(() => undefined);
    if (stat === undefined) continue;
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
        Bun.file(path).json() as Promise<unknown>,
        classifyFilesystemError,
      );
    },
  };
  const {
    commands,
    tools,
    configuredPackages,
    installedPackagePath,
    agentDirectory,
  } = host;
  if (commands !== undefined) port.commands = () => callHost(commands);
  if (tools !== undefined) port.tools = () => callHost(tools);
  if (configuredPackages !== undefined) {
    port.configuredPackages = () =>
      callHost(configuredPackages).andThen((value) =>
        value === undefined
          ? errAsync<never, PiExtensionInventoryPortError>({
              type: "HostCallFailed",
            })
          : okAsync(value),
      );
  }
  if (installedPackagePath !== undefined) {
    port.installedPackagePath = (source, scope) =>
      callHost(() => installedPackagePath(source, scope)).andThen((value) =>
        value === undefined
          ? errAsync<never, PiExtensionInventoryPortError>({ type: "NotFound" })
          : okAsync(value),
      );
  }
  if (agentDirectory !== undefined) {
    port.agentDirectory = () => callHost(agentDirectory);
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

/**
 * The two read-only `PackageManager` members this adapter is allowed to use.
 * Naming only these keeps `resolve`, `install`, `update`, `remove`, and every
 * settings mutation unreachable from this module by construction.
 */
export interface PiReadOnlyPackageManager {
  listConfiguredPackages(): unknown;
  getInstalledPath(source: string, scope: "user" | "project"): unknown;
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
  readonly rootExports?: Readonly<Record<string, unknown>>;
  /** Absolute project root; scopes settings and project package lookups. */
  readonly cwd: string;
  /** Project trust exactly as this generation proved it. */
  readonly trust: PiTrustState;
}

type HostFunction = (...args: readonly unknown[]) => unknown;

/** Reads one callable member from an object or class, prototype included. */
function readHostFunction(
  target: unknown,
  name: string,
): HostFunction | undefined {
  if (target === null) return undefined;
  if (typeof target !== "object" && typeof target !== "function") {
    return undefined;
  }
  const value = (target as Record<string, unknown>)[name];
  return typeof value === "function" ? (value as HostFunction) : undefined;
}

/** Calls a host function once, defensively, and keeps a throw off the stack. */
function callHostFunction(
  target: unknown,
  call: HostFunction,
  args: readonly unknown[],
): unknown {
  return Result.fromThrowable(
    () => call.apply(target, [...args]),
    () => undefined,
  )().unwrapOr(undefined);
}

/**
 * Reads `getAgentDir()` once. The value is needed eagerly for the package
 * manager, so a host that lacks the export or answers with a non-string is
 * reported as an absent surface rather than a failing one.
 */
function readAgentDirectory(
  rootExports: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (rootExports === undefined) return undefined;
  const getAgentDir = readHostFunction(rootExports, PI_AGENT_DIRECTORY_EXPORT);
  if (getAgentDir === undefined) return undefined;
  const value = callHostFunction(rootExports, getAgentDir, []);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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
  readonly rootExports?: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly agentDir: string;
  readonly trust: PiTrustState;
}): PiReadOnlyPackageManager | undefined {
  const rootExports = input.rootExports;
  if (rootExports === undefined) return undefined;
  const settingsManagerClass = rootExports[PI_SETTINGS_MANAGER_EXPORT];
  const create = readHostFunction(settingsManagerClass, "create");
  const packageManagerClass = rootExports[PI_PACKAGE_MANAGER_EXPORT];
  if (create === undefined || typeof packageManagerClass !== "function") {
    return undefined;
  }

  const settingsManager = callHostFunction(settingsManagerClass, create, [
    input.cwd,
    input.agentDir,
    { projectTrusted: input.trust === "trusted" },
  ]);
  if (settingsManager === undefined || settingsManager === null) {
    return undefined;
  }

  const constructed = Result.fromThrowable(
    () =>
      Reflect.construct(
        packageManagerClass as new (
          options: unknown,
        ) => unknown,
        [
          {
            cwd: input.cwd,
            agentDir: input.agentDir,
            settingsManager,
          },
        ],
      ) as unknown,
    () => undefined,
  )();
  if (constructed.isErr()) return undefined;
  const manager = constructed.value;
  const list = readHostFunction(manager, "listConfiguredPackages");
  const installedPath = readHostFunction(manager, "getInstalledPath");
  if (list === undefined || installedPath === undefined) return undefined;
  return {
    listConfiguredPackages: () => list.call(manager),
    getInstalledPath: (source, scope) =>
      installedPath.call(manager, source, scope),
  };
}

/** Projects Pi's `ConfiguredPackage[]`; `undefined` marks an unreadable answer. */
export function projectConfiguredPackages(
  value: unknown,
): readonly PiExtensionInventoryConfiguredPackage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const packages: PiExtensionInventoryConfiguredPackage[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const source = record.source;
    const scope = record.scope;
    if (typeof source !== "string") continue;
    if (scope !== "user" && scope !== "project") continue;
    const installedPath = record.installedPath;
    packages.push({
      source,
      scope,
      ...(typeof installedPath === "string" ? { installedPath } : {}),
    });
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
  const host: {
    commands?: () => readonly PiCommandInfo[];
    tools?: () => readonly PiExtensionInventoryToolInfo[];
    configuredPackages?: () =>
      | readonly PiExtensionInventoryConfiguredPackage[]
      | undefined;
    installedPackagePath?: (
      source: string,
      scope: "user" | "project",
    ) => string | undefined;
    agentDirectory?: () => string;
  } = {};

  const api = input.api;
  const getCommands = api.getCommands;
  if (typeof getCommands === "function") {
    host.commands = () => getCommands.call(api);
  }
  const getAllTools = api.getAllTools;
  if (typeof getAllTools === "function") {
    host.tools = () => getAllTools.call(api);
  }

  const agentDir = readAgentDirectory(input.rootExports);
  if (agentDir !== undefined) host.agentDirectory = () => agentDir;

  const packageManager =
    agentDir === undefined
      ? undefined
      : createPiReadOnlyPackageManager({
          ...(input.rootExports === undefined
            ? {}
            : { rootExports: input.rootExports }),
          cwd: input.cwd,
          agentDir,
          trust: input.trust,
        });
  if (packageManager !== undefined) {
    host.configuredPackages = () =>
      projectConfiguredPackages(packageManager.listConfiguredPackages());
    host.installedPackagePath = (source, scope) => {
      const path = packageManager.getInstalledPath(source, scope);
      return typeof path === "string" ? path : undefined;
    };
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
    .catch(() => undefined);
  if (stat === undefined) return undefined;
  const { dev, ino } = stat;
  if (!Number.isFinite(dev) || !Number.isFinite(ino)) return undefined;
  return `${dev}:${ino}`;
};

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
  if (recorded === undefined) return undefined;
  if (!isSafeChildExtensionPath(recorded)) return undefined;

  const candidates: string[] = [];
  for (const path of input.candidatePaths) {
    if (path === recorded) return recorded;
    if (!isSafeChildExtensionPath(path)) continue;
    if (candidates.includes(path)) continue;
    candidates.push(path);
    if (candidates.length >= MAX_OWN_ENTRY_IDENTITY_PROBES) break;
  }
  if (candidates.length === 0) return recorded;

  const ownIdentity = await input.identify(recorded).catch(() => undefined);
  if (ownIdentity === undefined) return recorded;
  for (const candidate of candidates) {
    const identity = await input.identify(candidate).catch(() => undefined);
    if (identity !== undefined && identity === ownIdentity) return candidate;
  }
  return recorded;
}

function hostCandidatePaths(host: BunPiExtensionInventoryHost): string[] {
  const paths: string[] = [];
  const commands = host.commands;
  if (commands !== undefined) {
    const value = callHostFunction(host, commands, []);
    if (Array.isArray(value)) {
      for (const command of value as readonly PiCommandInfo[]) {
        const path = command?.sourceInfo?.path;
        if (typeof path === "string") paths.push(path);
      }
    }
  }
  const tools = host.tools;
  if (tools !== undefined) {
    const value = callHostFunction(host, tools, []);
    if (Array.isArray(value)) {
      for (const tool of value as readonly PiExtensionInventoryToolInfo[]) {
        const path = tool?.sourceInfo?.path;
        if (typeof path === "string") paths.push(path);
      }
    }
  }
  return paths;
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
export function collectPiExtensionInventoryFromHost(
  input: CollectPiExtensionInventoryFromHostInput,
): ResultAsync<PiExtensionInventory, PiExtensionInventoryDegradation> {
  const host = createPiExtensionInventoryHost(input);
  const port = createBunPiExtensionInventoryPort(host);
  const env = input.env ?? Bun.env;
  const recordedEntryPath = input.ownEntryPath ?? getPiExtensionEntryPath();
  const overrideActive =
    env[WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV] === "1";
  const ownEntryPath = overrideActive
    ? ResultAsync.fromSafePromise(
        resolveOwnExtensionEntryPath({
          ...(recordedEntryPath === undefined ? {} : { recordedEntryPath }),
          candidatePaths: hostCandidatePaths(host),
          identify: input.identify ?? identifyExtensionFile,
        }).catch(() => recordedEntryPath),
      )
    : okAsync(recordedEntryPath);

  return ownEntryPath.andThen((entryPath) =>
    collectPiExtensionInventory(port, {
      trust: input.trust,
      cwd: input.cwd,
      ...(entryPath === undefined ? {} : { ownEntryPath: entryPath }),
      ...(input.env === undefined ? {} : { env: input.env }),
    }),
  );
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

const INHERIT_ALL: ChildExtensionArgsResolution = Object.freeze({
  args: Object.freeze([]) as readonly string[],
});

/** `--no-extensions -e <weave> -e <selected>…`, or nothing for inherit-all. */
export function renderChildExtensionArgs(
  plan: ChildExtensionPlan,
): readonly string[] {
  if (plan.mode === "inherit-all" || plan.paths.length === 0) return [];
  const args: string[] = ["--no-extensions"];
  for (const path of plan.paths) args.push("-e", path);
  return args;
}

function fallbackResolution(
  fallbackChildExtensionPaths: readonly string[] | undefined,
  diagnostics?: ChildExtensionArgsDiagnostics,
): ChildExtensionArgsResolution {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of fallbackChildExtensionPaths ?? []) {
    if (!isSafeChildExtensionPath(path) || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= MAX_CHILD_EXTENSION_ENTRIES + 1) break;
  }
  if (paths.length === 0) {
    return diagnostics === undefined ? INHERIT_ALL : { args: [], diagnostics };
  }
  const args = renderChildExtensionArgs({
    mode: "explicit",
    paths,
    diagnostics: [],
  });
  return diagnostics === undefined ? { args } : { args, diagnostics };
}

/**
 * Derives the parent's explicit extension paths for an isolated child.
 *
 * Pi does not propagate a parent's `--no-extensions -e ...` flags to a child
 * when the child receives an empty extension-argument slice. Keep the loader's
 * own entry first, then carry the other safe absolute `-e` paths that the
 * parent itself received. The child preloader still attests the Weave graph;
 * this function only reconstructs argv and never reads or evaluates a path.
 */
export function deriveChildExtensionFallbackPaths(
  argv: readonly string[],
  ownEntryPath: string | undefined,
): readonly string[] {
  if (
    !argv.includes("--no-extensions") ||
    ownEntryPath === undefined ||
    !isSafeChildExtensionPath(ownEntryPath)
  ) {
    return [];
  }
  const paths: string[] = [ownEntryPath];
  const seen = new Set<string>(paths);
  for (let index = 0; index + 1 < argv.length; index += 1) {
    if (argv[index] !== "-e") continue;
    const path = argv[index + 1];
    if (
      !isSafeChildExtensionPath(path) ||
      seen.has(path) ||
      paths.length >= MAX_CHILD_EXTENSION_ENTRIES + 1
    ) {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

export interface ResolveChildExtensionSpawnArgsInput {
  /** The trusted project's already-open Runtime Store. */
  readonly store: Pick<RuntimeStore, "preferences">;
  /**
   * The loader and other explicit entries when the parent was launched with
   * `--no-extensions`. In that mode Pi cannot inherit the parent's `-e`
   * arguments, so the child must receive these paths explicitly. The loader
   * path is still verified by the pinned preloader in the child; these values
   * only choose the child argv.
   */
  readonly fallbackChildExtensionPaths?: readonly string[];
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

/**
 * Resolves this generation's child-extension argv exactly once.
 *
 * Every step is fail-open: a store failure, undecodable stored text, a
 * degraded inventory, or an underivable Weave entry keeps the safe fallback.
 * Normally that fallback is today's inherit-all argv. When the parent was
 * launched with `--no-extensions`, it is the parent's explicit entry list,
 * with the pinned loader first, passed explicitly so Pi does not start a
 * child without the Weave adapter or the parent's provider seams. The
 * inventory is collected only when an explicit selection is actually stored,
 * so the default still costs exactly one preference read.
 */
export function resolveChildExtensionSpawnArgs(
  input: ResolveChildExtensionSpawnArgsInput,
): ResultAsync<ChildExtensionArgsResolution, never> {
  return input.store.preferences
    .get(PI_PREFERENCE_NAMESPACE, CHILD_EXTENSION_SELECTION_KEY)
    .map((stored): string | null | undefined => stored?.valueJson ?? null)
    .orElse(() => okAsync(undefined))
    .andThen((valueJson) => {
      if (valueJson === undefined) {
        return okAsync(
          fallbackResolution(input.fallbackChildExtensionPaths, {
            fallback: "preference-read-failed" as const,
          }),
        );
      }
      const decoded = decodeChildExtensionSelection(valueJson);
      // Undecodable text always decodes to the inherit-all default, so a
      // decode diagnostic and an explicit record are mutually exclusive.
      if (decoded.record.mode === "inherit-all") {
        const decode = decoded.diagnostic?.reason;
        return okAsync(
          decode === undefined
            ? fallbackResolution(input.fallbackChildExtensionPaths)
            : fallbackResolution(input.fallbackChildExtensionPaths, { decode }),
        );
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
        const degraded =
          gathered.reasons === undefined
            ? {}
            : { inventoryDegraded: gathered.reasons };
        // The Weave adapter is never persisted in the record: it is derived
        // here from live evidence, so a stale stored path can neither disable
        // nor misdirect the adapter in a child.
        const weaveEntry = gathered.inventory.entries.find(
          (entry) => entry.mandatory && isSafeChildExtensionPath(entry.path),
        );
        if (weaveEntry === undefined) {
          return fallbackResolution(input.fallbackChildExtensionPaths, {
            ...degraded,
            fallback: "weave-entry-unresolved" as const,
          });
        }
        const plan = resolveChildExtensionPlan({
          record,
          inventory: gathered.inventory.entries,
          weaveEntry: { id: weaveEntry.id, path: weaveEntry.path },
        });
        const droppedEntries = plan.diagnostics.length;
        const diagnostics: ChildExtensionArgsDiagnostics = {
          ...degraded,
          ...(droppedEntries === 0 ? {} : { droppedEntries }),
        };
        const args = renderChildExtensionArgs(plan);
        return Object.keys(diagnostics).length === 0
          ? { args }
          : { args, diagnostics };
      });
    });
}
