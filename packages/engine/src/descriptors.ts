import type { AgentConfig, WeaveConfig } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import type { CategoryMetadata } from "./compose.js";

/** Error raised when an explicit agent collides with a generated category shuttle. */
export type CategoryShuttleConflictError = {
  type: "CategoryShuttleConflictError";
  /** The conflicting agent name, e.g. "shuttle-frontend". */
  shuttleName: string;
  /** The category whose generated name collided. */
  categoryName: string;
  /** Human-readable remediation guidance. */
  message: string;
};

export interface GeneratedCategoryShuttle {
  config: AgentConfig;
  categoryMeta: CategoryMetadata;
}

/**
 * Generate category shuttle agent descriptors from the merged WeaveConfig.
 *
 * Returns `err(CategoryShuttleConflictError)` when an explicitly declared
 * agent name collides with a would-be generated shuttle name. Callers must
 * handle this error before materialising agents through an adapter.
 */
export function generateCategoryShuttles(
  config: WeaveConfig,
): Result<
  Record<string, GeneratedCategoryShuttle>,
  CategoryShuttleConflictError
> {
  const base = config.agents.shuttle;
  if (base === undefined) return ok({});
  if (config.disabled.agents.includes("shuttle")) return ok({});

  const result: Record<string, GeneratedCategoryShuttle> = {};

  for (const [categoryName, category] of Object.entries(config.categories)) {
    const shuttleName = `shuttle-${categoryName}`;

    if (config.agents[shuttleName] !== undefined) {
      return err({
        type: "CategoryShuttleConflictError",
        shuttleName,
        categoryName,
        message:
          `Agent "${shuttleName}" is explicitly declared and would also be ` +
          `generated from category "${categoryName}". ` +
          "Remove the explicit agent declaration or rename the category.",
      });
    }

    if (config.disabled.agents.includes(shuttleName)) continue;

    const overrides: Partial<AgentConfig> = {
      // A category description describes the generated shuttle's domain, so it
      // always replaces the base shuttle description everywhere the agent
      // config is read (descriptors, delegation targets, prompts). The DSL
      // requires a non-blank category description, so there is no fallback.
      description: category.description,
    };
    if (category.models !== undefined) overrides.models = [...category.models];
    if (category.temperature !== undefined) {
      overrides.temperature = category.temperature;
    }
    if (category.prompt_append !== undefined) {
      const existing = base.prompt_append;
      overrides.prompt_append = existing
        ? `${existing}\n${category.prompt_append}`
        : category.prompt_append;
    }
    if (category.prompt_append_file !== undefined) {
      overrides.prompt_append_file = category.prompt_append_file;
    }
    if (category.tool_policy !== undefined) {
      overrides.tool_policy = { ...base.tool_policy, ...category.tool_policy };
    }
    if (category.triggers !== undefined) {
      overrides.triggers = [...category.triggers];
    }
    if (category.fast === true || base.fast === true) {
      overrides.fast = true;
    }

    result[shuttleName] = {
      config: {
        ...base,
        name: shuttleName,
        mode: "subagent",
        // Category shuttles never inherit the generic Shuttle trigger list.
        // They are routed by category description, policies, and any category
        // string triggers. An explicit empty array records that omission at
        // generation time so a later spread cannot silently reintroduce the
        // base Shuttle fallback triggers. Config-layer array union-merge does
        // not apply here — generation runs after `mergeConfigs`.
        triggers: [],
        ...overrides,
      },
      categoryMeta: {
        name: categoryName,
        description: category.description,
        isCategory: true,
      },
    };
  }

  return ok(result);
}
