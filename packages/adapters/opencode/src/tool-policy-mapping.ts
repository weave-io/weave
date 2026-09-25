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
 * - agent `mode` → `permission.question` (see `buildQuestionPermission`)
 * - Loom and Tapestry → `permission.task` denying OpenCode's built-in
 *   subagents (see `buildBuiltinSubagentTaskPermission`)
 *
 * The `read` capability has no dedicated `permission` field in OpenCode; it is
 * enforced by toggling the boolean presence of read-class tool names in the
 * `tools` map. When `read` is `"deny"`, all read-class tools are set to
 * `false`. When `"allow"` or `"ask"`, they are omitted (OpenCode default:
 * enabled). `"ask"` is treated as `"allow"` for read tools because OpenCode
 * has no per-read-tool approval mechanism.
 */

import type {
  AgentDescriptor,
  EffectiveToolPolicy,
} from "@weaveio/weave-engine";
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
 * The resolved OpenCode permission block produced by `mapToolPolicy`,
 * `buildQuestionPermission` and `buildBuiltinSubagentTaskPermission`. Matches
 * the shape of `AgentConfig.permission`, plus `question` and `task`: OpenCode
 * accepts both, but the pinned SDK type predates them. `task` maps a subagent
 * name pattern to the permission for delegating to it.
 */
export type OpenCodeToolPermissions = NonNullable<
  OpenCodeAgentConfig["permission"]
> & {
  question?: OpenCodePermissionValue;
  task?: Record<string, OpenCodePermissionValue>;
};

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

/**
 * Builds the `AgentConfig.permission.question` entry from the agent's mode.
 *
 * OpenCode's `question` tool pauses the session until the user answers. A
 * subagent runs inside a delegation, so a question there stalls the whole
 * run while the user is watching the parent session.
 *
 * The entry is always explicit. OpenCode denies `question` to custom agents
 * by default, but a global `permission: "allow"` (or `"*": "allow"`) is
 * applied after that default and wins. The agent's own entry is applied
 * last, so only an explicit value here holds in both cases.
 *
 * - `subagent` → `deny`
 * - `primary` / `all` → `allow` (these can be selected by the user directly)
 */
export function buildQuestionPermission(
  mode: AgentDescriptor["mode"],
): Pick<OpenCodeToolPermissions, "question"> {
  return { question: mode === "subagent" ? "deny" : "allow" };
}

// ---------------------------------------------------------------------------
// OpenCode's built-in subagents
// ---------------------------------------------------------------------------

/**
 * The subagents OpenCode itself ships (`opencode agent list` on OpenCode
 * 1.18.31, 25 Sep 2026: `explore` and `general`). Its other built-ins
 * (`build`, `plan`, `compaction`, `summary`, `title`) are primary agents,
 * which the `task` tool does not spawn. Update this list when OpenCode adds or
 * removes a built-in subagent.
 */
export const OPENCODE_BUILTIN_SUBAGENTS: readonly string[] = [
  "explore",
  "general",
] as const;

/**
 * The Weave agents kept away from OpenCode's built-in subagents: the two
 * orchestrators, whose prompts route work to Weave's own specialists. This is
 * the scope Copilot's delegation-prompt adaptation uses too.
 */
export const BUILTIN_SUBAGENT_DENIED_AGENTS: ReadonlySet<string> = new Set([
  "loom",
  "tapestry",
]);

/**
 * Builds the `AgentConfig.permission.task` entry that stops Loom and
 * Tapestry from spawning OpenCode's built-in subagents.
 *
 * OpenCode evaluates `task` per subagent name. A denied subagent is left out
 * of the `task` tool's list of agents for that caller, and a call naming it
 * is refused. Only the built-ins are named, so every other subagent — Weave's
 * own and any the user defines outside Weave — keeps what the global config
 * grants. The entry sits on Loom's and Tapestry's own agent config, so a
 * session whose active agent is anything else is unchanged.
 *
 * A built-in name that is also one of the agent's delegation targets is not
 * denied: a Weave agent registered under that name (a user's own `explore`
 * agent, say) replaced the built-in, and the prompt offers it.
 *
 * Returns `{}` for every other agent.
 */
export function buildBuiltinSubagentTaskPermission(
  descriptor: Pick<AgentDescriptor, "name" | "delegationTargets">,
): Pick<OpenCodeToolPermissions, "task"> {
  if (!BUILTIN_SUBAGENT_DENIED_AGENTS.has(descriptor.name)) return {};

  const offered = new Set(
    descriptor.delegationTargets.map((target) => target.name),
  );
  const task: Record<string, OpenCodePermissionValue> = {};
  for (const builtin of OPENCODE_BUILTIN_SUBAGENTS) {
    if (offered.has(builtin)) continue;
    task[builtin] = "deny";
  }
  if (Object.keys(task).length === 0) return {};
  return { task };
}
