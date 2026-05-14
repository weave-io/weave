import { posix } from "node:path";
import type { WeaveConfig } from "@weave/core";
import { logger } from "./logger.js";
import { normalizePath } from "./normalize-path.js";
import type { ConfigScope } from "./types.js";

const log = logger.child({ module: "resolve" });

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
  const promptsDir = normalizePath(
    posix.join(normalizePath(scope.rootDir), "prompts"),
  );

  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.prompt_file === undefined) {
      resolvedAgents[name] = agent;
      continue;
    }

    const absolutePath = normalizePath(posix.join(promptsDir, agent.prompt_file));

    if (!absolutePath.startsWith(`${promptsDir}/`) && absolutePath !== promptsDir) {
      log.warn(
        {
          agent: name,
          promptFile: agent.prompt_file,
          promptsDir,
          resolvedPath: absolutePath,
          scope: scope.kind,
        },
        "Skipping prompt_file resolution outside prompts directory",
      );
      resolvedAgents[name] = agent;
      continue;
    }

    resolvedAgents[name] = { ...agent, prompt_file: absolutePath };
  }

  return { ...config, agents: resolvedAgents };
}
