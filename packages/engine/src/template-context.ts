/**
 * template-context.ts
 *
 * Bounded Template Context builder for Weave prompt composition.
 *
 * Responsibilities:
 * - Define `AgentPromptTemplateContext` — the shape passed to the template renderer
 * - Define allowed-path metadata covering all safe template references
 * - Build agent context projecting only safe, non-raw fields
 * - Build category context for generated category shuttle agents only
 * - Project resolved effective tool policy (no raw policy exposure)
 * - Project delegation targets with deduplicated domains and trigger details
 * - Generate deterministic Mermaid `flowchart TD` delegation diagrams
 * - Generate canonical `delegation.section` Markdown
 * - Omit `delegation.section` and `delegation.mermaid` when no targets exist
 *
 * NOT exported from packages/engine/src/index.ts (internal module).
 * Only `AgentPromptTemplateContext` and `TemplateContextError` are exported.
 */

import type { DelegationTrigger, WorkflowConfig } from "@weave/core";
import { ok, type Result } from "neverthrow";

import type { DelegationTarget } from "./compose.js";
import { logger } from "./logger.js";
import type { EffectiveToolPolicy } from "./tool-policy.js";

const log = logger.child({ module: "template-context" });

// ---------------------------------------------------------------------------
// Allowed-path metadata
// ---------------------------------------------------------------------------

/**
 * The complete set of allowed template paths for agent prompt templates.
 *
 * These paths are passed to the template renderer as the `allowedPaths` set.
 * Any path not in this set (or whose root segment is not in this set) will
 * be rejected by the renderer with an `UnknownPath` error.
 *
 * Covers:
 * - `agent.*` — agent identity and metadata
 * - `category.*` — category metadata (only for category shuttle agents)
 * - `toolPolicy.effective.*` — resolved tool policy values
 * - `delegation.*` — delegation targets, Mermaid diagram, and section Markdown
 * - `.` — current-item reference in list contexts
 */
export const ALLOWED_TEMPLATE_PATHS: Set<string> = new Set([
  // Agent fields
  "agent",
  "agent.name",
  "agent.description",
  "agent.mode",
  "agent.skills",
  "agent.isCategory",

  // Category fields (only present for category shuttle agents)
  "category",
  "category.name",
  "category.description",

  // Tool policy (resolved effective values only)
  "toolPolicy",
  "toolPolicy.effective",
  "toolPolicy.effective.read",
  "toolPolicy.effective.write",
  "toolPolicy.effective.execute",
  "toolPolicy.effective.delegate",
  "toolPolicy.effective.network",

  // Delegation
  "delegation",
  "delegation.targets",
  "delegation.section",
  "delegation.mermaid",

  // Delegation target fields (accessed inside {{#delegation.targets}} sections)
  "delegation.targets.name",
  "delegation.targets.description",
  "delegation.targets.domains",
  "delegation.targets.triggers",
  "delegation.targets.triggers.domain",
  "delegation.targets.triggers.trigger",

  // Current-item reference in list contexts
  ".",
]);

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** Agent identity and metadata projected into the template context. */
export interface AgentContextEntry {
  name: string;
  description?: string;
  mode: string;
  skills: string[];
  isCategory: boolean;
}

/** Category metadata projected for generated category shuttle agents. */
export interface CategoryContextEntry {
  name: string;
  description?: string;
}

/** Resolved effective tool policy projected into the template context. */
export interface ToolPolicyContextEntry {
  effective: {
    read: string;
    write: string;
    execute: string;
    delegate: string;
    network: string;
  };
}

/** A single delegation target projected into the template context. */
export interface DelegationTargetContextEntry {
  name: string;
  description?: string;
  /** Deduplicated domain strings across all triggers for this target. */
  domains: string[];
  /** Full trigger details. */
  triggers: Array<{ domain: string; trigger: string }>;
}

/** Delegation context projected into the template context. */
export interface DelegationContextEntry {
  targets: DelegationTargetContextEntry[];
  /** Mermaid `flowchart TD` diagram — omitted when no targets. */
  mermaid?: string;
  /** Canonical Markdown section — omitted when no targets. */
  section?: string;
}

/**
 * The bounded template context passed to the Mustache renderer for agent
 * prompt composition.
 *
 * Only safe, projected fields are included. Raw config, model lists,
 * temperature, prompt file paths, and raw tool policy are never exposed.
 */
export interface AgentPromptTemplateContext {
  agent: AgentContextEntry;
  /** Present only for generated category shuttle agents. */
  category?: CategoryContextEntry;
  toolPolicy: ToolPolicyContextEntry;
  delegation: DelegationContextEntry;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Errors that can occur during template context construction.
 *
 * Currently the builder is infallible (returns `ok`), but the Result type
 * is used for forward-compatibility and consistency with the rest of the engine.
 */
export type TemplateContextError = {
  type: "TemplateContextBuildError";
  agentName: string;
  message: string;
};

// ---------------------------------------------------------------------------
// Builder inputs
// ---------------------------------------------------------------------------

/** Inputs for the category context projection. */
export interface CategoryInput {
  name: string;
  description?: string;
  patterns?: string[];
}

/** Inputs for building an `AgentPromptTemplateContext`. */
export interface TemplateContextInput {
  agentName: string;
  description?: string;
  mode: string;
  skills: string[];
  /** Present only for generated category shuttle agents. */
  category?: CategoryInput;
  effectiveToolPolicy: EffectiveToolPolicy;
  delegationTargets: DelegationTarget[];
  /**
   * Workflow definitions to use for generating workflow-sequence Mermaid diagrams.
   * When provided and non-empty, the diagram shows workflow sequences instead of
   * the flat star topology.
   */
  workflows?: Record<string, WorkflowConfig>;
}

// ---------------------------------------------------------------------------
// Mermaid generation
// ---------------------------------------------------------------------------

/**
 * Escape a label string for use inside a Mermaid quoted label.
 *
 * Mermaid uses double-quoted labels. Any `"` inside the label must be
 * replaced with the HTML entity `&quot;` to avoid breaking the diagram.
 */
function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, "&quot;");
}

/**
 * Generate a stable synthetic node ID for a Mermaid node.
 *
 * Uses a simple `A{index}` scheme. The current agent is always `A0`.
 * Delegation targets are `A1`, `A2`, etc. in the order they appear.
 */
function mermaidNodeId(index: number): string {
  return `A${index}`;
}

/**
 * Derive a short uppercase prefix from a workflow name for use in node IDs.
 *
 * Takes the first 2 characters of each hyphen/space-separated word and
 * uppercases them. Examples:
 * - `plan-and-execute` → `PA`
 * - `quick-fix` → `QF`
 * - `tapestry-execution` → `TE`
 */
function workflowPrefix(workflowName: string): string {
  const words = workflowName.split(/[-\s]+/).filter((w) => w.length > 0);
  return words.map((w) => w[0]?.toUpperCase() ?? "").join("");
}

/**
 * Generate a workflow-sequence Mermaid `flowchart TD` diagram.
 *
 * Each workflow is rendered as a labelled subgraph. Steps are connected in
 * order (step[i] → step[i+1]) with the step name as the edge label.
 * Gate steps use hexagon `{{}}` syntax; autonomous/interactive steps use
 * rectangle `[""]` syntax.
 *
 * Only workflows where at least one step's agent matches a delegation target
 * (or is the current agent itself) are included.
 *
 * @param agentName - The name of the current agent
 * @param targets - The delegation targets
 * @param workflows - Workflow definitions to render
 * @returns Mermaid diagram string (without code fence)
 */
function generateWorkflowMermaidDiagram(
  agentName: string,
  targets: DelegationTargetContextEntry[],
  workflows: Record<string, WorkflowConfig>,
): string {
  const targetNames = new Set(targets.map((t) => t.name));
  targetNames.add(agentName);

  const lines: string[] = ["flowchart TD"];

  for (const [wfName, wf] of Object.entries(workflows)) {
    // Filter: only include workflows where at least one step's agent is relevant
    const hasRelevantStep = wf.steps.some((step) =>
      targetNames.has(step.agent),
    );
    if (!hasRelevantStep) continue;

    const prefix = workflowPrefix(wfName);
    const descriptionPart =
      wf.description !== undefined ? `: ${wf.description}` : "";
    const subgraphLabel = escapeMermaidLabel(`${wfName}${descriptionPart}`);

    lines.push(`    subgraph ${wfName}["${subgraphLabel}"]`);

    // Emit node declarations
    for (const step of wf.steps) {
      const nodeId = `${prefix}_${step.agent}`;
      const escapedAgent = escapeMermaidLabel(step.agent);
      if (step.type === "gate") {
        lines.push(`        ${nodeId}{{"${escapedAgent}"}}`);
      } else {
        lines.push(`        ${nodeId}["${escapedAgent}"]`);
      }
    }

    // Emit edges: step[i] → step[i+1] labelled with step[i+1].name
    for (let i = 0; i < wf.steps.length - 1; i++) {
      const fromStep = wf.steps[i];
      const toStep = wf.steps[i + 1];
      const fromId = `${prefix}_${fromStep.agent}`;
      const toId = `${prefix}_${toStep.agent}`;
      const edgeLabel = escapeMermaidLabel(toStep.name ?? toStep.name);
      lines.push(`        ${fromId} -->|"${edgeLabel}"| ${toId}`);
    }

    lines.push("    end");
  }

  return lines.join("\n");
}

/**
 * Generate a deterministic Mermaid `flowchart TD` diagram for the current
 * agent and its delegation targets.
 *
 * When workflows are provided and at least one is relevant to the current
 * agent's delegation targets, generates a workflow-sequence diagram with
 * subgraph blocks. Otherwise falls back to the flat star topology.
 *
 * Flat star layout:
 * - Current agent is the central node (`A0`)
 * - Each delegation target is a leaf node (`A1`, `A2`, …)
 * - Edges from `A0` to each target are labelled with deduplicated domain names
 * - When a target has no triggers, the edge has no label
 *
 * @param agentName - The name of the current agent (central node)
 * @param targets - The delegation targets to include
 * @param workflows - Optional workflow definitions for sequence diagrams
 * @returns Mermaid diagram string (without code fence)
 */
function generateMermaidDiagram(
  agentName: string,
  targets: DelegationTargetContextEntry[],
  workflows?: Record<string, WorkflowConfig>,
): string {
  // Use workflow-sequence diagram when workflows are provided and non-empty
  if (workflows !== undefined && Object.keys(workflows).length > 0) {
    return generateWorkflowMermaidDiagram(agentName, targets, workflows);
  }

  // Flat star fallback
  const lines: string[] = ["flowchart TD"];

  const currentId = mermaidNodeId(0);
  const escapedAgentName = escapeMermaidLabel(agentName);
  lines.push(`    ${currentId}["${escapedAgentName}"]`);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const targetId = mermaidNodeId(i + 1);
    const escapedTargetName = escapeMermaidLabel(target.name);
    lines.push(`    ${targetId}["${escapedTargetName}"]`);
  }

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const targetId = mermaidNodeId(i + 1);

    if (target.domains.length === 0) {
      lines.push(`    ${currentId} --> ${targetId}`);
    } else {
      const domainLabel = escapeMermaidLabel(target.domains.join(", "));
      lines.push(`    ${currentId} -->|"${domainLabel}"| ${targetId}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Delegation section generation
// ---------------------------------------------------------------------------

/**
 * Generate the canonical `delegation.section` Markdown.
 *
 * Format:
 * ```
 * ## Delegation
 *
 * ```mermaid
 * flowchart TD
 *     A0["agent-name"]
 *     A1["target-name"]
 *     A0 -->|"Domain"| A1
 * ```
 *
 * - target-name: optional description
 *   - Domain: trigger text
 * ```
 */
function generateDelegationSection(
  agentName: string,
  targets: DelegationTargetContextEntry[],
  mermaidDiagram: string,
): string {
  const lines: string[] = ["## Delegation", ""];

  lines.push("```mermaid");
  lines.push(mermaidDiagram);
  lines.push("```");
  lines.push("");

  for (const target of targets) {
    let summary = `- ${target.name}`;
    if (target.description !== undefined) {
      summary = `${summary}: ${target.description}`;
    }
    lines.push(summary);

    for (const trigger of target.triggers) {
      lines.push(`  - ${trigger.domain}: ${trigger.trigger}`);
    }
  }

  log.debug(
    { agentName, targetCount: targets.length },
    "Generated delegation section",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Delegation target projection
// ---------------------------------------------------------------------------

/**
 * Project a `DelegationTarget` into a `DelegationTargetContextEntry`.
 *
 * Deduplicates domain strings across all triggers for the target.
 * Preserves trigger order for deterministic output.
 */
function projectDelegationTarget(
  target: DelegationTarget,
): DelegationTargetContextEntry {
  const seenDomains = new Set<string>();
  const domains: string[] = [];

  for (const trigger of target.triggers) {
    if (!seenDomains.has(trigger.domain)) {
      seenDomains.add(trigger.domain);
      domains.push(trigger.domain);
    }
  }

  const triggers: Array<{ domain: string; trigger: string }> =
    target.triggers.map((t: DelegationTrigger) => ({
      domain: t.domain,
      trigger: t.trigger,
    }));

  const entry: DelegationTargetContextEntry = {
    name: target.name,
    domains,
    triggers,
  };

  if (target.description !== undefined) {
    entry.description = target.description;
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build an `AgentPromptTemplateContext` from composition inputs.
 *
 * Projects only safe, non-raw fields:
 * - `agent`: name, optional description, mode, skills, isCategory flag
 * - `category`: name and optional description (only for category shuttle agents)
 * - `toolPolicy.effective`: resolved permission values (no raw policy)
 * - `delegation`: projected targets, optional Mermaid diagram, optional section
 *
 * Raw config, model lists, temperature, prompt file paths, and raw tool policy
 * are never included in the returned context.
 *
 * Returns `Result<AgentPromptTemplateContext, TemplateContextError>` for
 * forward-compatibility. Currently always returns `ok`.
 */
export function buildTemplateContext(
  input: TemplateContextInput,
): Result<AgentPromptTemplateContext, TemplateContextError> {
  const {
    agentName,
    description,
    mode,
    skills,
    category,
    effectiveToolPolicy,
    delegationTargets,
    workflows,
  } = input;

  // Project agent context
  const agentEntry: AgentContextEntry = {
    name: agentName,
    mode,
    skills,
    isCategory: category !== undefined,
  };
  if (description !== undefined) {
    agentEntry.description = description;
  }

  // Project category context (only for category shuttle agents)
  let categoryEntry: CategoryContextEntry | undefined;
  if (category !== undefined) {
    categoryEntry = { name: category.name };
    if (category.description !== undefined) {
      categoryEntry.description = category.description;
    }
  }

  // Project tool policy (resolved effective values only)
  const toolPolicyEntry: ToolPolicyContextEntry = {
    effective: {
      read: effectiveToolPolicy.read,
      write: effectiveToolPolicy.write,
      execute: effectiveToolPolicy.execute,
      delegate: effectiveToolPolicy.delegate,
      network: effectiveToolPolicy.network,
    },
  };

  // Project delegation targets
  const projectedTargets = delegationTargets.map(projectDelegationTarget);

  // Build delegation context
  const delegationEntry: DelegationContextEntry = {
    targets: projectedTargets,
  };

  if (projectedTargets.length > 0) {
    const mermaidDiagram = generateMermaidDiagram(
      agentName,
      projectedTargets,
      workflows,
    );
    const section = generateDelegationSection(
      agentName,
      projectedTargets,
      mermaidDiagram,
    );
    delegationEntry.mermaid = mermaidDiagram;
    delegationEntry.section = section;
  }

  const context: AgentPromptTemplateContext = {
    agent: agentEntry,
    toolPolicy: toolPolicyEntry,
    delegation: delegationEntry,
  };

  if (categoryEntry !== undefined) {
    context.category = categoryEntry;
  }

  log.debug(
    {
      agentName,
      hasCategory: category !== undefined,
      delegationTargetCount: projectedTargets.length,
    },
    "Built template context",
  );

  return ok(context);
}
