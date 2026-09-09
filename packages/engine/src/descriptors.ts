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

    const overrides: Partial<AgentConfig> = {};
    if (category.models !== undefined) overrides.models = [...category.models];
    if (category.temperature !== undefined) {
      overrides.temperature = category.temperature;
    }
    if (category.fast !== undefined) {
      overrides.fast = category.fast;
    }
    if (category.variant !== undefined) {
      overrides.variant = category.variant;
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

    result[shuttleName] = {
      config: {
        ...base,
        models: base.models === undefined ? undefined : [...base.models],
        skills: base.skills === undefined ? undefined : [...base.skills],
        triggers: base.triggers?.map((trigger) => ({ ...trigger })),
        review_models:
          base.review_models === undefined
            ? undefined
            : [...base.review_models],
        tool_policy:
          base.tool_policy === undefined ? undefined : { ...base.tool_policy },
        routing:
          base.routing === undefined
            ? undefined
            : {
                ...base.routing,
                delegation_exclude:
                  base.routing.delegation_exclude === undefined
                    ? undefined
                    : [...base.routing.delegation_exclude],
              },
        name: shuttleName,
        mode: "subagent",
        ...overrides,
      },
      categoryMeta: {
        name: categoryName,
        description: category.description,
        patterns: [...(category.patterns ?? [])],
        isCategory: true,
      },
    };
  }

  return ok(result);
}
