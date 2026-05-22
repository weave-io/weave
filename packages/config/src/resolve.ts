import { posix } from "node:path";
import type { WeaveConfig } from "@weave/core";
import { normalizePath } from "./normalize-path.js";
import type { ConfigScope } from "./types.js";

/**
 * Resolve `prompt_file` and `prompt_append_file` values in a `WeaveConfig` to
 * absolute paths for the given scope.
 *
 * **Scope-aware resolution:**
 * Each scope has a `rootDir` that points to the directory containing the
 * `prompts/` sub-directory for that layer:
 * - `"builtin"` → `packages/config/` (prompt files ship with this package)
 * - `"global"`  → `~/.weave/`
 * - `"project"` → `<projectRoot>/.weave/`
 *
 * A `prompt_file: "loom.md"` in scope `{ rootDir: "/my/project/.weave" }`
 * resolves to `"/my/project/.weave/prompts/loom.md"`.
 *
 * **Behaviour:**
 * - Agents without `prompt_file` or `prompt_append_file` are left unchanged.
 * - Categories with `prompt_append_file` have that field resolved to an
 *   absolute path; categories without it are left unchanged.
 * - The input `config` is never mutated — a new `WeaveConfig` is returned.
 *
 * @param config - The config whose agent/category prompt path fields should be resolved.
 * @param scope  - The origin scope; provides the `rootDir` for path construction.
 * @returns A new `WeaveConfig` with all `prompt_file` and `prompt_append_file`
 *          values replaced by absolute paths.
 */
export function resolvePromptPaths(
  config: WeaveConfig,
  scope: ConfigScope,
): WeaveConfig {
  const normalizedRoot = normalizePath(scope.rootDir);

  const resolvedAgents: WeaveConfig["agents"] = {};

  for (const [name, agent] of Object.entries(config.agents)) {
    const hasPromptFile = agent.prompt_file !== undefined;
    const hasAppendFile = agent.prompt_append_file !== undefined;

    if (!hasPromptFile && !hasAppendFile) {
      resolvedAgents[name] = agent;
      continue;
    }

    const updated = { ...agent };

    if (agent.prompt_file !== undefined) {
      updated.prompt_file = normalizePath(
        posix.join(normalizedRoot, "prompts", agent.prompt_file),
      );
    }

    if (agent.prompt_append_file !== undefined) {
      updated.prompt_append_file = normalizePath(
        posix.join(normalizedRoot, "prompts", agent.prompt_append_file),
      );
    }

    resolvedAgents[name] = updated;
  }

  const resolvedCategories: WeaveConfig["categories"] = {};

  for (const [name, category] of Object.entries(config.categories ?? {})) {
    if (category.prompt_append_file === undefined) {
      resolvedCategories[name] = category;
      continue;
    }

    resolvedCategories[name] = {
      ...category,
      prompt_append_file: normalizePath(
        posix.join(normalizedRoot, "prompts", category.prompt_append_file),
      ),
    };
  }

  const hasCategories = Object.keys(resolvedCategories).length > 0;

  return {
    ...config,
    agents: resolvedAgents,
    ...(hasCategories ? { categories: resolvedCategories } : {}),
  };
}
