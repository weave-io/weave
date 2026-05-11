import type { AgentConfig, WeaveConfig } from "@weave/core";
import { err, ok, type Result } from "neverthrow";

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

/**
 * Generate category shuttle agent descriptors from the merged WeaveConfig.
 *
 * Returns `err(CategoryShuttleConflictError)` when an explicitly declared
 * agent name collides with a would-be generated shuttle name. Callers must
 * handle this error before spawning agents.
 */
export function generateCategoryShuttles(
  config: WeaveConfig,
): Result<Record<string, AgentConfig>, CategoryShuttleConflictError> {
  const base = config.agents.shuttle;
  if (base === undefined) return ok({});
  if (config.disabled.agents.includes("shuttle")) return ok({});

  const result: Record<string, AgentConfig> = {};

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
    if (category.models !== undefined) overrides.models = category.models;
    if (category.temperature !== undefined) {
      overrides.temperature = category.temperature;
    }
    if (category.prompt_append !== undefined) {
      overrides.prompt_append = category.prompt_append;
    }
    if (category.tool_policy !== undefined) {
      overrides.tool_policy = { ...base.tool_policy, ...category.tool_policy };
    }

    result[shuttleName] = {
      ...base,
      name: shuttleName,
      mode: "subagent",
      ...overrides,
    };
  }

  return ok(result);
}
