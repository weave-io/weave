/**
 * GitHub Copilot delegation prompt adaptation.
 *
 * Copilot's `task` tool only accepts the ids Copilot assigned to each agent.
 * For plugin-contributed agents that id is `<plugin-name>:<agent-name>`
 * (`weave:thread`), but the shared Weave prompt templates name delegation
 * targets by their bare Weave name (`thread`). Copilot also ships built-in
 * subagents (`explore`, `task`, `general-purpose`, ...) that its own system
 * prompt promotes by name. Live-verified against Copilot CLI 1.0.83
 * (2026-09-12): with the unadapted prompt Loom routed 9/9 parallel
 * exploration calls to the built-in `explore`; with qualified references and
 * the replacement section below it routed 9/9 to `weave:thread`.
 *
 * This module adapts an already-composed prompt for Copilot only — the shared
 * templates and the engine are untouched. Only Weave's Loom and Tapestry
 * agents are adapted: the change takes effect only while one of them is the
 * active agent, and every other agent's prompt is emitted unchanged.
 */

import type { DelegationTarget } from "@weaveio/weave-engine";

/** The Weave agents whose prompts are adapted for Copilot delegation. */
const ADAPTED_AGENTS: ReadonlySet<string> = new Set(["loom", "tapestry"]);

/**
 * Copilot built-in subagents replaced by a Weave agent, keyed by the Weave
 * agent name. A built-in is only named in the generated section when its
 * replacement is one of the agent's delegation targets.
 */
const BUILTIN_REPLACEMENTS: ReadonlyArray<{
  weaveAgent: string;
  builtins: readonly string[];
  purpose: string;
}> = [
  {
    weaveAgent: "thread",
    builtins: ["explore"],
    purpose:
      'codebase exploration / "how does X work" / parallel research threads',
  },
  {
    weaveAgent: "spindle",
    builtins: ["research"],
    purpose: "external docs research",
  },
  {
    weaveAgent: "shuttle",
    builtins: ["task", "general-purpose"],
    purpose: "running builds/tests or implementation",
  },
  { weaveAgent: "weft", builtins: ["code-review"], purpose: "review" },
  {
    weaveAgent: "warp",
    builtins: ["security-review"],
    purpose: "security review",
  },
];

export interface CopilotDelegationPromptInput {
  /** The Weave agent name (`descriptor.name`). */
  agentName: string;
  /** The composed prompt produced by the engine. */
  prompt: string;
  /** The agent's delegation targets (empty for agents that cannot delegate). */
  delegationTargets: DelegationTarget[];
  /**
   * Plugin agent id qualifier (see `getPluginAgentIdQualifier` in
   * `adapter.ts`). When omitted, references stay bare, matching the bare
   * frontmatter `name:` emitted in that mode.
   */
  pluginAgentIdQualifier?: string;
}

/**
 * Adapts Loom's and Tapestry's composed prompts so they address Weave agents
 * by their Copilot id and prefer them over Copilot's built-in subagents.
 *
 * - Only `**name**` and `` `name` `` references whose name is one of the
 *   agent's own delegation targets are qualified. Plain prose, the agent's
 *   own name, and names that are not targets (such as the "do not invent
 *   `shuttle-backend`" examples) are left alone.
 * - A "Delegation targets (GitHub Copilot)" section is appended.
 * - Any other agent, and Loom/Tapestry without delegation targets, are
 *   returned unchanged.
 */
export function adaptCopilotDelegationPrompt(
  input: CopilotDelegationPromptInput,
): string {
  const { agentName, prompt, delegationTargets, pluginAgentIdQualifier } =
    input;
  if (!ADAPTED_AGENTS.has(agentName) || delegationTargets.length === 0) {
    return prompt;
  }

  const toId = (name: string): string =>
    pluginAgentIdQualifier ? `${pluginAgentIdQualifier}:${name}` : name;

  let adapted = prompt;
  if (pluginAgentIdQualifier) {
    for (const { name } of delegationTargets) {
      const escaped = escapeRegExp(name);
      adapted = adapted
        .replace(new RegExp(`\\*\\*${escaped}\\*\\*`, "g"), `**${toId(name)}**`)
        .replace(new RegExp(`\`${escaped}\``, "g"), `\`${toId(name)}\``);
    }
  }

  const section = buildDelegationSection(
    new Set(delegationTargets.map((t) => t.name)),
    delegationTargets.some((t) => t.isCategory),
    toId,
    pluginAgentIdQualifier,
  );
  return `${adapted.trimEnd()}\n\n${section}`;
}

function buildDelegationSection(
  targetNames: Set<string>,
  hasCategoryShuttles: boolean,
  toId: (name: string) => string,
  pluginAgentIdQualifier: string | undefined,
): string {
  const lines = ["## Delegation targets (GitHub Copilot)", ""];

  if (pluginAgentIdQualifier) {
    const example = toId([...targetNames][0] ?? "shuttle");
    lines.push(
      `When you call the \`task\` tool, \`agent_type\` MUST be the \`${pluginAgentIdQualifier}:<name>\` id of a Weave agent listed in this prompt (for example \`${example}\`). Bare Weave names are not valid agent types.`,
      "",
    );
  }

  const replacements = BUILTIN_REPLACEMENTS.filter((r) =>
    targetNames.has(r.weaveAgent),
  );
  if (replacements.length > 0) {
    const builtins = replacements
      .flatMap((r) => r.builtins)
      .map((b) => `\`${b}\``)
      .join(", ");
    lines.push(
      `Never use Copilot's built-in agent types ${builtins} — the Weave agent listed below replaces each of them:`,
      "",
    );
    for (const r of replacements) {
      const instead = r.builtins.map((b) => `\`${b}\``).join(" / ");
      const alternatives =
        r.weaveAgent === "shuttle" && hasCategoryShuttles
          ? ` or the matching category shuttle (\`${toId("shuttle-<category>")}\`)`
          : "";
      lines.push(
        `- ${r.purpose} → \`${toId(r.weaveAgent)}\`${alternatives} (instead of ${instead})`,
      );
    }
    if (targetNames.has("thread")) {
      lines.push(
        "",
        `Parallel exploration means several \`${toId("thread")}\` calls in the same turn.`,
      );
    }
  }

  return lines.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
