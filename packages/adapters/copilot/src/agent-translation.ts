/**
 * GitHub Copilot agent translation.
 *
 * Translates a Weave `AgentDescriptor` into Copilot's markdown agent format
 * with YAML frontmatter, suitable for writing to `.github/agents/<name>.agent.md`.
 */

import type { AgentDescriptor } from "@weaveio/weave-engine";

export interface AgentTranslationInput {
  /** The full agent descriptor from the engine composition layer. */
  descriptor: AgentDescriptor;
  /** The resolved model string after adapter model resolution (accepted for logging/debugging symmetry with Claude Code; NOT written into frontmatter). */
  resolvedModel: string;
  /** Concrete tool names that are allowed (permission !== "deny"). */
  allowedTools: string[];
  /** Concrete MCP server names configured for this agent. */
  mcpServers: string[];
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
 */
export function translateAgentToCopilotMarkdown(
  input: AgentTranslationInput,
): string {
  const { descriptor, allowedTools, mcpServers } = input;

  const frontmatterLines: string[] = ["---"];

  frontmatterLines.push(`name: ${descriptor.name}`);

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

  return `${frontmatterLines.join("\n")}\n\n${descriptor.composedPrompt}\n`;
}
