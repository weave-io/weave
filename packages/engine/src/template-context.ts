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
 * - Omit `delegation` when no targets exist
 *
 * NOT exported from packages/engine/src/index.ts (internal module).
 * Only `AgentPromptTemplateContext` and `TemplateContextError` are exported.
 */

import type { DelegationTrigger } from "@weaveio/weave-core";
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
 * - `delegation.*` — delegation targets
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

  // Delegation target fields (accessed inside {{#delegation.targets}} sections)
  "delegation.targets.name",
  "delegation.targets.description",
  "delegation.targets.domains",
  "delegation.targets.triggers",
  "delegation.targets.triggers.domain",
  "delegation.targets.triggers.trigger",
  "delegation.targets.isCategory",

  // Fields accessible inside {{#delegation.targets}}{{#isCategory}} sections
  // (validator resolves {{name}} as delegation.targets.isCategory.name)
  "delegation.targets.isCategory.name",
  "delegation.targets.isCategory.description",

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
  /** True when this target is a generated category shuttle agent. */
  isCategory: boolean;
}

/** Delegation context projected into the template context. */
export interface DelegationContextEntry {
  targets: DelegationTargetContextEntry[];
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
    isCategory: target.isCategory,
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
 * - `delegation`: projected targets
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
