/**
 * Maps abstract Weave `EffectiveToolPolicy` capabilities to OpenCode
 * `AgentConfig.permission` and `AgentConfig.tools` fields.
 *
 * Boundary rule: this module is the single place where abstract Weave
 * capability names are translated to concrete OpenCode tool/permission
 * identifiers. No other adapter module should hard-code OpenCode tool names.
 *
 * Mapping rationale:
 * - `read`     → `tools` map (enable/disable read-class tools by name)
 * - `write`    → `permission.edit`
 * - `execute`  → `permission.bash`
 * - `network`  → `permission.webfetch`
 * - `delegate` → `permission.doom_loop`
 *
 * The `read` capability has no dedicated `permission` field in OpenCode; it is
 * enforced by toggling the boolean presence of read-class tool names in the
 * `tools` map. When `read` is `"deny"`, all read-class tools are set to
 * `false`. When `"allow"` or `"ask"`, they are omitted (OpenCode default:
 * enabled). `"ask"` is treated as `"allow"` for read tools because OpenCode
 * has no per-read-tool approval mechanism.
 */

import type { EffectiveToolPolicy } from "@weave/engine";
import type { OpenCodeAgentConfig } from "./sdk-types.js";

// ---------------------------------------------------------------------------
// OpenCode tool permission value type
// ---------------------------------------------------------------------------

/**
 * The three permission values accepted by OpenCode's `permission` fields.
 * Mirrors the literal union used in `AgentConfig.permission.*`.
 */
export type OpenCodePermissionValue = "allow" | "deny" | "ask";

/**
 * The resolved OpenCode permission block produced by `mapToolPolicy`.
 * Matches the shape of `AgentConfig.permission`.
 */
export type OpenCodeToolPermissions = NonNullable<
  OpenCodeAgentConfig["permission"]
>;

// ---------------------------------------------------------------------------
// Read-class tool names
// ---------------------------------------------------------------------------

/**
 * The concrete OpenCode tool identifiers that implement the abstract `read`
 * capability. When `read` is `"deny"`, each of these is set to `false` in
 * `AgentConfig.tools`. When `"allow"` or `"ask"`, they are omitted (OpenCode
 * default is enabled).
 *
 * This list is the single source of truth for read-class tool names in the
 * OpenCode adapter. Update it when OpenCode adds or removes read tools.
 */
export const READ_TOOL_NAMES: readonly string[] = [
  "read",
  "glob",
  "grep",
  "list",
] as const;

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/**
 * Converts a Weave `ToolPermission` value to the equivalent OpenCode
 * permission string.
 *
 * The mapping is 1-to-1: Weave and OpenCode share the same three-value
 * vocabulary (`"allow"`, `"deny"`, `"ask"`).
 */
export function toOpenCodePermission(
  permission: "allow" | "deny" | "ask",
): OpenCodePermissionValue {
  if (permission === "allow") return "allow";
  if (permission === "deny") return "deny";
  return "ask";
}

/**
 * Builds the `AgentConfig.tools` map entry for the `read` capability.
 *
 * Returns `undefined` when `read` is `"allow"` or `"ask"` — OpenCode enables
 * read tools by default, so no explicit entry is needed.
 *
 * Returns a map with all `READ_TOOL_NAMES` set to `false` when `read` is
 * `"deny"`.
 */
export function buildReadToolsEntry(
  readPermission: "allow" | "deny" | "ask",
): Record<string, boolean> | undefined {
  if (readPermission !== "deny") return undefined;

  const tools: Record<string, boolean> = {};
  for (const name of READ_TOOL_NAMES) {
    tools[name] = false;
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Maps a fully-resolved Weave `EffectiveToolPolicy` to the OpenCode
 * `AgentConfig.permission` block and an optional `AgentConfig.tools` patch.
 *
 * @returns An object with:
 *   - `permission` — the `AgentConfig.permission` block to merge into the
 *     translated agent config.
 *   - `tools` — optional `AgentConfig.tools` patch for read-class tools.
 *     `undefined` when no tool overrides are needed.
 */
export function mapToolPolicy(policy: EffectiveToolPolicy): {
  permission: OpenCodeToolPermissions;
  tools: Record<string, boolean> | undefined;
} {
  const permission: OpenCodeToolPermissions = {
    edit: toOpenCodePermission(policy.write),
    bash: toOpenCodePermission(policy.execute),
    webfetch: toOpenCodePermission(policy.network),
    doom_loop: toOpenCodePermission(policy.delegate),
  };

  const tools = buildReadToolsEntry(policy.read);

  return { permission, tools };
}
