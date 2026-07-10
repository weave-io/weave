/**
 * Claude Code concrete tool classification.
 *
 * Maps Claude Code's harness-specific tool names to Weave's abstract
 * capability vocabulary. The engine uses these classifications with
 * `resolveToolDecisions()` to produce per-tool permission decisions.
 */

import type { ConcreteToolClassification } from "@weaveio/weave-engine";

/**
 * Complete classification of Claude Code's known tool surface.
 *
 * Each entry pairs a concrete Claude Code tool identifier with the abstract
 * capability it exercises. This list is the adapter's single source of truth
 * for tool→capability mapping.
 */
export const CLAUDE_CODE_TOOL_CLASSIFICATIONS: readonly ConcreteToolClassification[] =
  [
    { toolId: "Read", capability: "read" },
    { toolId: "Write", capability: "write" },
    { toolId: "Edit", capability: "write" },
    { toolId: "MultiEdit", capability: "write" },
    { toolId: "Bash", capability: "execute" },
    { toolId: "Task", capability: "delegate" },
    { toolId: "WebFetch", capability: "network" },
    { toolId: "WebSearch", capability: "network" },
  ] as const;

/**
 * Returns the full Claude Code tool classification array.
 *
 * Adapters pass this to `resolveToolDecisions()` alongside an agent's
 * effective tool policy to determine per-tool permissions.
 */
export function getClaudeCodeToolClassifications(): readonly ConcreteToolClassification[] {
  return CLAUDE_CODE_TOOL_CLASSIFICATIONS;
}

/**
 * All known Claude Code tool identifiers, derived from the classification list.
 */
export const CLAUDE_CODE_TOOL_IDS: readonly string[] =
  CLAUDE_CODE_TOOL_CLASSIFICATIONS.map((c) => c.toolId);
