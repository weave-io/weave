import { posix } from "node:path";
import type { WeaveConfig } from "@weave/core";
import { normalizePath } from "./normalize-path.js";
import type { ConfigScope } from "./types.js";

/**
 * Resolve `prompt_file` values in a `WeaveConfig` to absolute paths for the
 * given scope.
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
 * - Agents without `prompt_file` are left unchanged.
 * - Categories are not modified (they use `prompt_append`, not `prompt_file`).
 * - The input `config` is never mutated — a new `WeaveConfig` is returned.
 *
 * @param config - The config whose agent `prompt_file` paths should be resolved.
 * @param scope  - The origin scope; provides the `rootDir` for path construction.
 * @returns A new `WeaveConfig` with all `prompt_file` values replaced by
 *          absolute paths.
 */
export function resolvePromptPaths(
  config: WeaveConfig,
  scope: ConfigScope,
): WeaveConfig {
  const resolvedAgents: WeaveConfig["agents"] = {};

  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.prompt_file === undefined) {
      resolvedAgents[name] = agent;
      continue;
    }

    const absolutePath = normalizePath(
      posix.join(normalizePath(scope.rootDir), "prompts", agent.prompt_file),
    );
    resolvedAgents[name] = { ...agent, prompt_file: absolutePath };
  }

  return { ...config, agents: resolvedAgents };
}
