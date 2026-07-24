import type { PiSourceInfo } from "./types.js";

/**
 * The nine `/weave:*` direct commands (Spec 33 §13). Registered once, as
 * inert shells, by the extension factory. Behavior beyond gating is
 * implemented in later tasks; this foundation only classifies each command
 * so the health-only gate knows what to block.
 */
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
] as const;

export type WeaveCommandName = (typeof WEAVE_COMMAND_NAMES)[number];

export type WeaveCommandClassification =
  | "mutating"
  | "read-only"
  | "idempotent-cleanup";

const MUTATING_COMMANDS: ReadonlySet<WeaveCommandName> = new Set([
  "weave:start",
  "weave:run",
  "weave:advance",
  "weave:resume",
  "weave:artifact",
]);

const IDEMPOTENT_CLEANUP_COMMANDS: ReadonlySet<WeaveCommandName> = new Set([
  "weave:abort",
]);

/**
 * Health-only mode blocks `mutating` commands only. `read-only` (status,
 * health, plan) and `idempotent-cleanup` (abort) remain available (Spec 33
 * §21).
 */
export function classifyWeaveCommand(
  name: WeaveCommandName,
): WeaveCommandClassification {
  if (MUTATING_COMMANDS.has(name)) return "mutating";
  if (IDEMPOTENT_CLEANUP_COMMANDS.has(name)) return "idempotent-cleanup";
  return "read-only";
}

/** The npm package name used to install this adapter (Spec 33 §7.1). */
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
 * Canonical provenance check (Spec 33 §7.1): ownership of a discovered
 * command or tool MUST be read from `sourceInfo`, never inferred from
 * command/tool names or ad hoc path parsing. A resource is ours only when
 * Pi loaded it from a `package` origin whose configured npm source resolves
 * to this package's name.
 */
export function isOwnSourceInfo(sourceInfo: PiSourceInfo): boolean {
  if (sourceInfo.origin !== "package") return false;
  return parseNpmSourceName(sourceInfo.source) === ADAPTER_PACKAGE_IDENTITY;
}
