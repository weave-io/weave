import type { PiSourceInfo } from "./types.js";

/**
 * The twelve `/weave:*` direct commands (Pi adapter contract). Registered once
 * by the extension factory. Each command is generation-gated by the active
 * session before it reaches its handler.
 */
export const WEAVE_INSPECT_COMMAND_NAME = "weave:inspect" as const;
export const WEAVE_CLEAR_CHILDREN_COMMAND_NAME =
  "weave:clear-children" as const;
/** @deprecated Use the canonical entry in WEAVE_COMMAND_NAMES. */
export const WEAVE_RECOVERY_COMMAND_NAME = "weave:recover-children" as const;

export const WEAVE_COMMAND_NAMES = [
  "weave:start",
  "weave:run",
  "weave:status",
  "weave:abort",
  "weave:advance",
  "weave:health",
  "weave:resume",
  "weave:plan",
  "weave:artifact",
  WEAVE_INSPECT_COMMAND_NAME,
  WEAVE_CLEAR_CHILDREN_COMMAND_NAME,
  WEAVE_RECOVERY_COMMAND_NAME,
] as const;
export type WeaveCommandName = (typeof WEAVE_COMMAND_NAMES)[number];

export type WeaveCommandClassification =
  | "mutating"
  | "read-only"
  | "idempotent-cleanup";

/** All valid `WeaveCommandClassification` values as a readonly tuple (Pi adapter contract invalid-state gating). */
export const WEAVE_COMMAND_CLASSIFICATIONS = [
  "mutating",
  "read-only",
  "idempotent-cleanup",
] as const satisfies readonly WeaveCommandClassification[];

const MUTATING_COMMANDS: ReadonlySet<WeaveCommandName> = new Set([
  "weave:start",
  "weave:run",
  "weave:advance",
  "weave:resume",
  "weave:artifact",
  WEAVE_RECOVERY_COMMAND_NAME,
]);

const IDEMPOTENT_CLEANUP_COMMANDS: ReadonlySet<WeaveCommandName> = new Set([
  "weave:abort",
  WEAVE_CLEAR_CHILDREN_COMMAND_NAME,
]);

/**
 * Health-only mode blocks `mutating` commands only. `read-only` (status,
 * health, plan, inspect) and `idempotent-cleanup` (abort, clear-children)
 * remain available (Pi adapter contract).
 */
export function classifyWeaveCommand(
  name: WeaveCommandName,
): WeaveCommandClassification {
  if (MUTATING_COMMANDS.has(name)) return "mutating";
  if (IDEMPOTENT_CLEANUP_COMMANDS.has(name)) return "idempotent-cleanup";
  return "read-only";
}

/** The npm package name used to install this adapter (Pi adapter contract). */
export const ADAPTER_PACKAGE_IDENTITY = "@weaveio/weave-adapter-pi";

/**
 * Extracts the canonical npm package name from a Pi `sourceInfo.source`
 * string, following the same `npm:<name>[@version]` convention Pi's own
 * package manager uses to parse configured package sources (scoped names
 * such as `@weaveio/weave-adapter-pi` are handled). Returns `undefined` for
 * non-npm sources (git, local, or synthetic sources such as `"builtin"` or
 * `"extension"`), which can never prove ownership of an npm-published
 * package resource.
 */
export function parseNpmSourceName(source: string): string | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice("npm:".length).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  return match?.[1];
}

/**
 * Canonical provenance check (Pi adapter contract): ownership of a discovered
 * command or tool MUST be read from `sourceInfo`, never inferred from
 * command/tool names or ad hoc path parsing. A resource is ours only when
 * Pi loaded it from a `package` origin whose configured npm source resolves
 * to this package's name.
 */
export function isOwnSourceInfo(sourceInfo: PiSourceInfo): boolean {
  if (sourceInfo.origin !== "package") return false;
  return parseNpmSourceName(sourceInfo.source) === ADAPTER_PACKAGE_IDENTITY;
}
