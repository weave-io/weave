import { err, errAsync, ok, type ResultAsync } from "neverthrow";
import { BUILTIN_PROMPT_CONTENTS, getBuiltinConfig } from "./builtins.js";
import {
  bunFileReader,
  discoverAndParse,
  type FileReader,
} from "./discovery.js";
import type { ConfigLoadError } from "./errors.js";
import { logger } from "./logger.js";
import { mergeConfigsResult } from "./merge.js";
import { resolvePromptPaths } from "./resolve.js";

const log = logger.child({ module: "loader" });

/**
 * Replace `prompt_file` references in the builtin config with embedded inline
 * `prompt` content from `BUILTIN_PROMPT_CONTENTS`.
 *
 * This is the bundle-safe alternative to `resolvePromptPaths()` for the
 * builtin layer. Instead of resolving `prompt_file` to an absolute filesystem
 * path (which breaks when `@weaveio/weave-config` is bundled into an adapter because
 * `import.meta.dir` points to the adapter's dist directory), we substitute the
 * embedded content directly.
 *
 * **Why not use `resolvePromptPaths` for builtins?**
 *
 * `resolvePromptPaths` sets `prompt_file` to an absolute path derived from
 * `import.meta.dir`. When `@weaveio/weave-config` is bundled into
 * `@weaveio/weave-adapter-opencode/dist/plugin.js`, `import.meta.dir` resolves to the
 * adapter's dist directory (e.g. `packages/adapters/opencode/dist/`), not
 * `packages/config/`. The resolved path then points to a non-existent
 * `packages/adapters/opencode/prompts/` directory, causing all builtin
 * prompt-file-backed agents to fail with `DescriptorCompositionFailure`.
 *
 * By embedding prompt content at build time via Bun's `with { type: "text" }`
 * import assertion (in `builtins.ts`), we eliminate the runtime filesystem
 * dependency for builtins entirely.
 *
 * @param config - The parsed builtin config (from `getBuiltinConfig()`).
 * @returns A new `WeaveConfig` with `prompt_file` replaced by `prompt` for
 *          all builtin agents whose content is available in
 *          `BUILTIN_PROMPT_CONTENTS`. Agents without a matching entry are left
 *          unchanged (they will fail at compose time if they have no prompt).
 */
function inlineBuiltinPrompts(
  config: import("@weaveio/weave-core").WeaveConfig,
): import("@weaveio/weave-core").WeaveConfig {
  const inlinedAgents: import("@weaveio/weave-core").WeaveConfig["agents"] = {};

  for (const [name, agent] of Object.entries(config.agents)) {
    const embeddedContent = BUILTIN_PROMPT_CONTENTS[name];

    // Only inline if the agent uses prompt_file AND we have embedded content.
    // Agents with inline prompt or no prompt are left unchanged.
    if (agent.prompt_file === undefined || embeddedContent === undefined) {
      inlinedAgents[name] = agent;
      continue;
    }

    // Replace prompt_file with inline prompt content.
    // Omit prompt_file so compose.ts uses the inline prompt path.
    const { prompt_file: _removed, ...rest } = agent;
    inlinedAgents[name] = { ...rest, prompt: embeddedContent };
  }

  return { ...config, agents: inlinedAgents };
}

/**
 * Load the final merged `WeaveConfig` for a project.
 *
 * Orchestrates the full config pipeline in five steps:
 *
 * 1. **Builtins**: Call `getBuiltinConfig()` to get the 8 built-in agent
 *    defaults. On error, returns a `BuiltinParseError` (indicates a code bug).
 *
 * 2. **Discover**: Call `discoverAndParse(projectRoot)` to find and parse
 *    `~/.weave/config.weave` (global) and `<projectRoot>/.weave/config.weave`
 *    (project). Missing files are silently skipped.
 *
 * 3. **Resolve paths**: For the builtin layer, inline embedded prompt content
 *    via `inlineBuiltinPrompts()` — this is bundle-safe and does not depend on
 *    `import.meta.dir`. For discovered layers, call `resolvePromptPaths()` as
 *    before so that user-authored `prompt_file` values become absolute paths.
 *
 * 4. **Merge**: Fold all layers left to right:
 *    `mergeConfigs(resolvedBuiltins, ...resolvedDiscovered)`
 *    (builtins first, then global, then project — discovery preserves order).
 *
 * 5. **Return**: Return `ok(mergedConfig)`.
 *
 * @param projectRoot - Absolute path to the project root directory. Defaults
 *   to `process.cwd()`. The project config file is expected at
 *   `<projectRoot>/.weave/config.weave`.
 * @param fileReader - Optional I/O implementation. Defaults to `bunFileReader`.
 *   Pass a mock in tests to avoid real filesystem reads.
 *
 * @returns `ok(WeaveConfig)` with the fully-merged config, or
 *          `err(ConfigLoadError[])` if any step fails.
 */
export function loadConfig(
  projectRoot?: string,
  fileReader: FileReader = bunFileReader,
): ResultAsync<import("@weaveio/weave-core").WeaveConfig, ConfigLoadError[]> {
  // Step 1: Builtins
  const builtinResult = getBuiltinConfig();
  if (builtinResult.isErr()) {
    return errAsync<import("@weaveio/weave-core").WeaveConfig, ConfigLoadError[]>([
      { type: "BuiltinParseError", errors: builtinResult.error },
    ]);
  }

  const builtinConfig = builtinResult.value;

  // Step 2–5: Discover, resolve, merge
  return discoverAndParse(projectRoot, fileReader).andThen((discovered) => {
    // Step 3: Resolve prompt paths for each layer.
    //
    // Builtins: use inlineBuiltinPrompts() instead of resolvePromptPaths().
    // This replaces prompt_file references with embedded content (bundle-safe).
    // See inlineBuiltinPrompts() JSDoc for the full rationale.
    const resolvedBuiltins = inlineBuiltinPrompts(builtinConfig);

    const resolvedDiscovered = discovered.map(({ config, scope }) =>
      resolvePromptPaths(config, scope),
    );

    // Step 4: Merge all layers
    const mergeResult = mergeConfigsResult(
      resolvedBuiltins,
      ...resolvedDiscovered,
    );
    if (mergeResult.isErr()) {
      return err<import("@weaveio/weave-core").WeaveConfig, ConfigLoadError[]>([
        { type: "MergeError", errors: mergeResult.error },
      ]);
    }

    const merged = mergeResult.value;
    const agentCount = Object.keys(merged.agents).length;
    log.debug({ agentCount }, "Merged config");
    log.info("Config loaded successfully");

    return ok(merged);
  });
}
