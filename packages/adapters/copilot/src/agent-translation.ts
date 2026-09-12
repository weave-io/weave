/**
 * GitHub Copilot agent translation.
 *
 * Translates a Weave `AgentDescriptor` into Copilot's markdown agent format
 * with YAML frontmatter, suitable for writing to `.github/agents/<name>.agent.md`.
 */

import type { AgentDescriptor } from "@weaveio/weave-engine";
import { adaptCopilotDelegationPrompt } from "./delegation-prompt.js";

export interface AgentTranslationInput {
  /** The full agent descriptor from the engine composition layer. */
  descriptor: AgentDescriptor;
  /** The resolved model string after adapter model resolution (accepted for logging/debugging symmetry with Claude Code; NOT written into frontmatter). */
  resolvedModel: string;
  /** Concrete tool names that are allowed (permission !== "deny"). */
  allowedTools: string[];
  /** Concrete MCP server names configured for this agent. */
  mcpServers: string[];
  /**
   * Plugin agent id qualifier (see `getPluginAgentIdQualifier` in
   * `adapter.ts`). When present, the frontmatter `name:` field is written as
   * `<pluginAgentIdQualifier>:<descriptor.name>` instead of the bare
   * `descriptor.name` — see the module doc comment for why.
   */
  pluginAgentIdQualifier?: string;
}

/**
 * Wraps a YAML scalar value in double quotes if it contains characters that
 * would be misinterpreted by a YAML parser (`:`, `#`, `"`, newlines).
 * Already-safe values are returned as-is.
 */
function escapeYamlScalar(value: string): string {
  if (/[:#"\n\r]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Translates a Weave agent descriptor into Copilot `.agent.md` markdown.
 *
 * Output format:
 * ```md
 * ---
 * name: <agent-name>
 * description: <description>
 * tools:
 *   - Tool1
 * mcp-servers:
 *   - server-1
 * ---
 *
 * <composed prompt content>
 * ```
 *
 * Notes:
 * - `model`, `trust`, and `approved` are never emitted (unsupported/absent per
 *   research in `docs/artifacts/copilot-adapter-research.md`).
 * - `mcp-servers:` is omitted entirely (not emitted as `{}`) when
 *   `mcpServers` is empty, since an empty mapping silently drops the agent.
 * - `name:` is qualified as `<pluginAgentIdQualifier>:<agent-name>` when
 *   `pluginAgentIdQualifier` is supplied — see
 *   [`github/app#3685`](https://github.com/github/app/issues/3685) and
 *   `docs/copilot-adapter.md` ("Plugin agent id qualification") for why.
 *   The filename (`<agent-name>.agent.md`) is never qualified: the CLI
 *   derives an agent's stable id from the file's stem, not from the
 *   frontmatter `name:` field, so this only affects display/selection
 *   through the affected app surfaces.
 * - For Loom and Tapestry, the prompt body is adapted for Copilot's `task`
 *   tool (qualified agent references plus a built-in replacement section) —
 *   see `delegation-prompt.ts`.
 */
export function translateAgentToCopilotMarkdown(
  input: AgentTranslationInput,
): string {
  const { descriptor, allowedTools, mcpServers, pluginAgentIdQualifier } =
    input;

  const frontmatterLines: string[] = ["---"];

  const qualifiedName = pluginAgentIdQualifier
    ? `${pluginAgentIdQualifier}:${descriptor.name}`
    : descriptor.name;
  frontmatterLines.push(`name: ${qualifiedName}`);

  if (descriptor.description) {
    frontmatterLines.push(
      `description: ${escapeYamlScalar(descriptor.description)}`,
    );
  }

  if (allowedTools.length > 0) {
    frontmatterLines.push("tools:");
    for (const tool of allowedTools) {
      frontmatterLines.push(`  - ${tool}`);
    }
  }

  if (mcpServers.length > 0) {
    frontmatterLines.push("mcp-servers:");
    for (const server of mcpServers) {
      frontmatterLines.push(`  - ${server}`);
    }
  }

  frontmatterLines.push("---");

  const body = adaptCopilotDelegationPrompt({
    agentName: descriptor.name,
    prompt: descriptor.composedPrompt,
    delegationTargets: descriptor.delegationTargets,
    pluginAgentIdQualifier,
  });

  return `${frontmatterLines.join("\n")}\n\n${body}\n`;
}
