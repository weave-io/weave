/**
 * Claude Code agent translation.
 *
 * Translates a Weave `AgentDescriptor` into Claude Code's markdown agent
 * format with YAML frontmatter, suitable for writing to `.claude/agents/<name>.md`.
 */

import type { AgentDescriptor } from "@weaveio/weave-engine";

const MODEL_ALIAS_MAP: Record<string, string> = {
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-20250514": "sonnet",
  "claude-sonnet-4-5-20250514": "sonnet",
  "claude-opus-4": "opus",
  "claude-opus-4-20250918": "opus",
  "claude-opus-4-5": "opus",
  "claude-haiku-3-5": "haiku",
  "claude-haiku-3-5-20241022": "haiku",
};

function toClaudeCodeModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return MODEL_ALIAS_MAP[model] ?? model;
}

export interface AgentTranslationInput {
  /** The full agent descriptor from the engine composition layer. */
  descriptor: AgentDescriptor;
  /** The resolved model string after adapter model resolution. */
  resolvedModel: string;
  /** Concrete tool names that are allowed (permission !== "deny"). */
  allowedTools: string[];
}

/**
 * Translates a Weave agent descriptor into Claude Code agent markdown.
 *
 * Output format:
 * ```md
 * ---
 * name: <agent-name>
 * description: <description>
 * model: <resolved-model>
 * tools:
 *   - Tool1
 *   - Tool2
 * ---
 *
 * <composed prompt content>
 * ```
 */
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

export function translateAgentToMarkdown(input: AgentTranslationInput): string {
  const { descriptor, resolvedModel, allowedTools } = input;

  const frontmatterLines: string[] = ["---"];

  frontmatterLines.push(`name: ${descriptor.name}`);

  if (descriptor.description) {
    frontmatterLines.push(`description: ${escapeYamlScalar(descriptor.description)}`);
  }

  frontmatterLines.push(`model: ${toClaudeCodeModel(resolvedModel) ?? resolvedModel}`);

  if (allowedTools.length > 0) {
    frontmatterLines.push("tools:");
    for (const tool of allowedTools) {
      frontmatterLines.push(`  - ${tool}`);
    }
  }

  frontmatterLines.push("---");

  return `${frontmatterLines.join("\n")}\n\n${descriptor.composedPrompt}\n`;
}
