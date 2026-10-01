import type { WeaveConfig } from "@weaveio/weave-core";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import { BUILTIN_PROMPT_CONTENTS, getBuiltinConfig } from "./builtins.js";
import type { ConfigLoadDiagnostic } from "./diagnostics.js";
import {
  bunFileReader,
  discoverAndParse,
  type FileReader,
  globalConfigDir,
} from "./discovery.js";
import type { ConfigLoadError } from "./errors.js";
import { logger } from "./logger.js";
import { mergeConfigsResult } from "./merge.js";
import {
  MODEL_RECOMMENDATIONS_CLIENT_VERSION,
  type RecommendationsHarness,
} from "./model-recommendations.js";
import { resolveModelUpdates } from "./model-recommendations-cache.js";
import { ModelRecommendationsLayerReader } from "./model-recommendations-layer.js";
import { ModelRecommendationsVerifier } from "./model-recommendations-verifier.js";
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
 * The builtin config as `loadConfig` merges it: every builtin prompt inlined,
 * so it composes without reading any file. For callers that merge a single
 * config file onto the builtins themselves, such as `weave validate --path`.
 */
export function getResolvedBuiltinConfig(): Result<
  import("@weaveio/weave-core").WeaveConfig,
  import("@weaveio/weave-core").ConfigError[]
> {
  return getBuiltinConfig().map(inlineBuiltinPrompts);
}

/** Options for `loadConfigDetailed`. Every field is optional. */
export interface LoadConfigOptions {
  /**
   * The harness the caller configures (`opencode2`, `claude-code`, `pi`). It
   * selects that harness's section of the applied model recommendations, or
   * `default`. Without it no recommendations layer is added (Spec 39).
   */
  readonly harness?: RecommendationsHarness;
  /** The current time, for the recommendations' expiry and skew checks. */
  readonly now?: () => Date;
  /**
   * The client version compared with a list's `min_config_version`. Defaults
   * to `MODEL_RECOMMENDATIONS_CLIENT_VERSION`.
   */
  readonly clientVersion?: string;
  /**
   * Ed25519 public keys that may sign recommendations. Defaults to the
   * production keys; tests and local proofs pass their own.
   */
  readonly publicKeys?: readonly string[];
}

/** The merged config and what the loader found along the way. */
export interface LoadedConfig {
  readonly config: WeaveConfig;
  /** Non-fatal findings, such as a skipped recommendations layer. */
  readonly diagnostics: readonly ConfigLoadDiagnostic[];
}

/**
 * Load the final merged `WeaveConfig` for a project.
 *
 * Equivalent to `loadConfigDetailed(projectRoot, fileReader)` without a
 * harness, returning only the config: it never adds a model recommendations
 * layer and never reads the recommendations cache. Callers that configure a
 * harness or report status use `loadConfigDetailed`.
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
): ResultAsync<WeaveConfig, ConfigLoadError[]> {
  return loadConfigDetailed(projectRoot, fileReader).map(
    (loaded) => loaded.config,
  );
}

/**
 * Load the final merged `WeaveConfig` for a project, with diagnostics.
 *
 * 1. **Builtins**: `getBuiltinConfig()`, with every builtin prompt inlined
 *    (`inlineBuiltinPrompts()`, bundle-safe). A failure is a
 *    `BuiltinParseError` and always a Weave bug.
 * 2. **Discover**: `discoverAndParse(projectRoot)` finds and parses the global
 *    (`~/.weave/config.weave`, or `WEAVE_GLOBAL_CONFIG_DIR`) and project
 *    (`<projectRoot>/.weave/config.weave`) layers; user `prompt_file` values
 *    are resolved to absolute paths.
 * 3. **Merge**: `mergeConfigsResult(builtins, global, project)`.
 * 4. **Recommendations** (Spec 39): when the merged
 *    `settings.model_updates.mode` is `notify` or `auto` and the caller passed
 *    a `harness`, read `<global>/cache/model-recommendations/<channel>/applied.json`
 *    through `fileReader`, verify it, and merge its section as a layer of
 *    builtin agents' `models` between the builtins and the global layer:
 *    `builtins → recommendations → global → project`. With `mode off`, no
 *    block, or no harness, the cache is not read and the result is step 3's.
 *    A file that cannot be used never fails the load: the layer is skipped
 *    and a `ModelRecommendationsSkipped` diagnostic says why.
 *
 * @returns `ok({ config, diagnostics })`, or `err(ConfigLoadError[])` when the
 *          builtins, a user config file or the merge fails.
 */
export function loadConfigDetailed(
  projectRoot?: string,
  fileReader: FileReader = bunFileReader,
  options: LoadConfigOptions = {},
): ResultAsync<LoadedConfig, ConfigLoadError[]> {
  const builtinResult = getBuiltinConfig();
  if (builtinResult.isErr()) {
    return errAsync<LoadedConfig, ConfigLoadError[]>([
      { type: "BuiltinParseError", errors: builtinResult.error },
    ]);
  }
  const builtinConfig = builtinResult.value;
  // Resolved now, as discovery resolves it, so both read the same directory.
  const globalDir = globalConfigDir();

  return discoverAndParse(projectRoot, fileReader).andThen((discovered) => {
    // Builtins: inline embedded prompts rather than resolvePromptPaths(); see
    // inlineBuiltinPrompts() for why.
    const resolvedBuiltins = inlineBuiltinPrompts(builtinConfig);
    const resolvedDiscovered = discovered.map(({ config, scope }) =>
      resolvePromptPaths(config, scope),
    );

    const base = mergeLayers(resolvedBuiltins, [], resolvedDiscovered);
    if (base.isErr())
      return errAsync<LoadedConfig, ConfigLoadError[]>(base.error);

    const settings = resolveModelUpdates(base.value.settings.model_updates);
    const harness = options.harness;
    if (settings === undefined || harness === undefined)
      return okAsync<LoadedConfig, ConfigLoadError[]>(loaded(base.value, []));

    const layerReader = new ModelRecommendationsLayerReader({
      reader: fileReader,
      verifier: new ModelRecommendationsVerifier({
        publicKeys: options.publicKeys,
        now: options.now,
      }),
      clientVersion:
        options.clientVersion ?? MODEL_RECOMMENDATIONS_CLIENT_VERSION,
      globalDir,
    });
    return layerReader
      .read({
        settings,
        harness,
        builtinAgents: new Set(Object.keys(builtinConfig.agents)),
      })
      .andThen(({ layer, diagnostic }) => {
        if (layer === undefined)
          return ok<LoadedConfig, ConfigLoadError[]>(
            loaded(base.value, [diagnostic]),
          );
        const recommended = mergeLayers(
          resolvedBuiltins,
          [layer],
          resolvedDiscovered,
        );
        // The layer holds only validated model lists, so this cannot fail in
        // practice; if it ever does, the user keeps the config without it.
        if (recommended.isErr())
          return ok<LoadedConfig, ConfigLoadError[]>(
            loaded(base.value, [
              {
                type: "ModelRecommendationsSkipped",
                channel: settings.channel,
                harness,
                path: diagnostic.path,
                reason: {
                  type: "LayerInvalid",
                  message: "the layer could not be merged",
                },
              },
            ]),
          );
        return ok<LoadedConfig, ConfigLoadError[]>(
          loaded(recommended.value, [diagnostic]),
        );
      });
  });
}

function mergeLayers(
  builtins: WeaveConfig,
  recommended: readonly WeaveConfig[],
  discovered: readonly WeaveConfig[],
): Result<WeaveConfig, ConfigLoadError[]> {
  const merged = mergeConfigsResult(builtins, ...recommended, ...discovered);
  if (merged.isErr())
    return err([{ type: "MergeError", errors: merged.error }]);
  return ok(merged.value);
}

function loaded(
  config: WeaveConfig,
  diagnostics: readonly ConfigLoadDiagnostic[],
): LoadedConfig {
  log.debug({ agentCount: Object.keys(config.agents).length }, "Merged config");
  log.info("Config loaded successfully");
  return { config, diagnostics };
}
