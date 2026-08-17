/**
 * The impure edge of the child-extension selection stack (Pi adapter
 * contract).
 *
 * Two things live here, and nothing else:
 *
 * - {@link createBunPiExtensionInventoryPort}, the concrete read-only host
 *   port `collectPiExtensionInventory` consumes. It reads loaded command and
 *   tool provenance through injected host accessors and scans the agent and
 *   project extension directories with `Bun.Glob`. It never loads, evaluates,
 *   installs, updates, or network-resolves an extension.
 * - {@link resolveChildExtensionSpawnArgs}, the once-per-generation resolution
 *   that turns the stored preference plus that inventory into the argv slice
 *   `PiRpcChild` appends to a child spawn.
 *
 * The port deliberately omits `configuredPackages`/`installedPackagePath`.
 * Pi's `DefaultPackageManager` is constructible only with a `SettingsManager`
 * instance this extension is never handed, and building a second one would
 * duplicate host state to gain evidence the loaded-source scan already
 * provides for every package extension that registers a command or a tool.
 * The omission surfaces as an ordinary inventory degradation reason, not an
 * error.
 *
 * Everything fallible returns `Result`/`ResultAsync`, nothing throws on an
 * expected path, and nothing here logs: the caller decides what surfaces.
 * Diagnostics carry counts and closed reason codes, never ids or paths.
 */
import { join } from "node:path";
import type { RuntimeStore } from "@weaveio/weave-engine";
import { okAsync, ResultAsync } from "neverthrow";
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
  PiExtensionInventory,
  PiExtensionInventoryDegradation,
  PiExtensionInventoryDegradationReason,
  PiExtensionInventoryDirectoryEntry,
  PiExtensionInventoryPort,
  PiExtensionInventoryPortError,
  PiExtensionInventoryToolInfo,
} from "./pi-extension-inventory.js";
import type { PiCommandInfo } from "./types.js";

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
  /** `ctx.getAllTools()`, projected to provenance only. */
  readonly tools?: () => readonly PiExtensionInventoryToolInfo[];
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
  const { commands, tools, agentDirectory } = host;
  if (commands !== undefined) port.commands = () => callHost(commands);
  if (tools !== undefined) port.tools = () => callHost(tools);
  if (agentDirectory !== undefined) {
    port.agentDirectory = () => callHost(agentDirectory);
  }
  return port;
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
    .orElse(() => okAsync(undefined))
    .andThen((valueJson) => {
      if (valueJson === undefined) {
        return okAsync({
          args: [],
          diagnostics: { fallback: "preference-read-failed" as const },
        });
      }
      const decoded = decodeChildExtensionSelection(valueJson);
      // Undecodable text always decodes to the inherit-all default, so a
      // decode diagnostic and an explicit record are mutually exclusive.
      if (decoded.record.mode === "inherit-all") {
        const decode = decoded.diagnostic?.reason;
        return okAsync(
          decode === undefined
            ? INHERIT_ALL
            : { args: [], diagnostics: { decode } },
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
          return {
            args: [],
            diagnostics: {
              ...degraded,
              fallback: "weave-entry-unresolved" as const,
            },
          };
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
