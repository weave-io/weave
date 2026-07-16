/**
 * OpenCode plugin entry point for `@weaveio/weave-adapter-opencode`.
 *
 * This module exports the `Plugin` function that OpenCode loads at startup
 * when `@weaveio/weave-adapter-opencode` is listed in the `plugin` array of
 * `opencode.json`. It is the primary runtime integration surface between
 * Weave and OpenCode.
 *
 * ## How it works
 *
 * 1. OpenCode calls the exported `server` function (the `Plugin`) with a
 *    `PluginInput` context that includes a pre-constructed SDK client and the
 *    project directory.
 * 2. The plugin loads the Weave config from `input.directory` via
 *    `loadConfig()`.
 * 3. It calls `materializeAgents()` to compose all agent descriptors from the
 *    resolved config.
 * 4. It translates each descriptor into an `OpenCodeAgentConfig` via
 *    `translateAgent()` and collects the results into a `translatedMap`.
 * 5. It returns a `Hooks` object **immediately** with two hooks:
 *    a. **`config` hook** — injects all translated agent configs (including
 *       generated review variant agents) into `cfg.agent` so that
 *       `opencode debug config` reflects all Weave-managed agents. This runs
 *       once at startup before OpenCode finalises its config.
 *    b. **`chat.message` hook** — inspects each completed assistant message.
 *       When the responding agent has `review_models` declared, it triggers
 *       direct adversarial review via `adapter.executeDirectReview()` and
 *       replaces the output with a review summary (or a fail-closed blocking
 *       message on error).
 *
 * ## Config hook and agent injection
 *
 * `opencode debug config` calls the plugin function and waits for `Hooks` to
 * be returned. Config loading and agent translation are pure computation (no
 * SDK calls), so `Hooks` is returned immediately. The `config` hook injects
 * all Weave-managed agents — base agents plus any generated review variant
 * agents — into `cfg.agent` at startup time.
 *
 * ## Direct review via chat.message
 *
 * When a user or delegation invokes a reviewer agent directly (not via a
 * workflow gate step), the `chat.message` hook intercepts the completed
 * assistant output and calls `executeDirectReview()`. This bypasses
 * `ReviewFanOutIntent` entirely — the adapter calls `ReviewOrchestrator.fanOut`
 * directly rather than routing through the engine effect system. The hook is
 * fail-closed: if review fan-out fails, the original output is replaced with a
 * blocking failure message so configured `review_models` never silently degrade.
 *
 * ## Installation
 *
 * Add `@weaveio/weave-adapter-opencode` to the `plugin` array in `opencode.json`:
 *
 * ```jsonc
 * // opencode.json
 * {
 *   "plugin": ["@weaveio/weave-adapter-opencode"]
 * }
 * ```
 *
 * OpenCode resolves the `./server` subpath export from `package.json`, which
 * points to this module (`dist/plugin.js`). The bare package name works because
 * the `./server` export is defined alongside the main entry point.
 *
 * Restart OpenCode after adding the plugin. The plugin entry point receives
 * the runtime context, constructs an `OpenCodeAdapter` with the injected SDK
 * client, and materializes all agents declared in `.weave/config.weave`.
 *
 * ## Boundary rules
 *
 * - The plugin entry point is the only place that imports from
 *   `@opencode-ai/plugin`. All other adapter modules remain plugin-agnostic.
 * - The `PluginInput.client` is injected into `SdkOpenCodeClient` — the
 *   adapter never constructs its own SDK client.
 * - Config loading and agent materialization follow the same path as any
 *   other adapter consumer: `loadConfig → materializeAgents → spawnSubagent`.
 */

import { join } from "node:path";
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { type FileReader, loadConfig } from "@weaveio/weave-config";
import {
  type AgentDescriptor,
  composeAgentDescriptor,
  env,
  generateReviewVariants,
  logger,
  materializeAgents,
  redirectLogsToFile,
} from "@weaveio/weave-engine";

import { OpenCodeAdapter } from "./adapter.js";
import {
  START_WORK_COMMAND_TEMPLATE,
  WEAVE_START_COMMAND_TEMPLATE,
} from "./command-templates.js";
import { resolveModelForAgent } from "./model-resolution.js";
import {
  type OpenCodeClientFacade,
  SdkOpenCodeClient,
} from "./opencode-client.js";
import { tagWithOwnership } from "./reconcile-agent.js";
import type { OpenCodeAgentConfig, Part } from "./sdk-types.js";
import { translateAgent } from "./translate-agent.js";

const log = logger.child({ module: "adapter-opencode/plugin" });

// ---------------------------------------------------------------------------
// chat.message hook helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from an SDK `Part[]` by joining all text parts.
 */
function extractTextFromParts(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Resolve the reviewer agent name to use for direct review.
 *
 * Resolution order:
 * 1. `inputAgent` — the active agent name from the hook input (if truthy).
 * 2. First `@agent-name` mention found in `text`.
 *
 * Returns `undefined` when neither source yields a name.
 */
function resolveReviewerAgentName(
  inputAgent: string | undefined,
  text: string,
): string | undefined {
  if (inputAgent) return inputAgent;
  const match = /@([a-zA-Z0-9_-]+)/.exec(text);
  return match?.[1];
}

/**
 * Return `true` when `agentName` refers to a generated review variant.
 * Uses exact membership in a Set built from the generated variant names
 * to avoid false positives from substring matching.
 */
function buildReviewVariantSet(entries: Array<[string, unknown]>): Set<string> {
  return new Set(entries.map(([name]) => name));
}

function isGeneratedReviewVariant(
  agentName: string,
  reviewVariantNames: Set<string>,
): boolean {
  return reviewVariantNames.has(agentName);
}

/**
 * Default log file path relative to the project directory.
 *
 * When the OpenCode plugin runs without an explicit `WEAVE_LOG_FILE` env var,
 * Weave logs are written to this path under the project root. The `.weave/`
 * directory is already the conventional home for Weave project state, so
 * placing the log file there keeps everything in one place.
 *
 * Example: `/path/to/project/.weave/weave.log`
 *
 * Not exported from `plugin.ts` — the plugin entry point must export only
 * functions to satisfy OpenCode's `getLegacyPlugins` loader. This constant
 * is exported from the barrel `index.ts` as a standalone export.
 */
const DEFAULT_PLUGIN_LOG_SUBPATH = ".weave/weave.log";

/**
 * Options for `createWeavePlugin`.
 *
 * All fields are optional. In production, the defaults are used. In tests,
 * pass a custom `fileReader` and/or `clientFacade` to isolate the test from
 * the developer's environment.
 */
export interface WeavePluginOptions {
  /**
   * Custom file reader for config loading.
   *
   * In production, the default `bunFileReader` is used. In tests, pass a
   * `projectOnlyReader` to prevent the developer's global config from
   * interfering with test results.
   *
   * @example
   * ```ts
   * const plugin = createWeavePlugin({ fileReader: projectOnlyReader(root) });
   * const hooks = await plugin(input);
   * ```
   */
  readonly fileReader?: FileReader;

  /**
   * Pre-constructed `OpenCodeClientFacade` to use instead of wrapping
   * `input.client` in `SdkOpenCodeClient`.
   *
   * In production, this is always `undefined` — the plugin wraps `input.client`
   * (the raw SDK client) in `SdkOpenCodeClient`. In tests, pass a
   * `MockOpenCodeClient` here to avoid needing a real SDK client.
   *
   * @example
   * ```ts
   * const mockClient = new MockOpenCodeClient();
   * const plugin = createWeavePlugin({ clientFacade: mockClient });
   * const hooks = await plugin(input);
   * ```
   */
  readonly clientFacade?: OpenCodeClientFacade;
}

/**
 * Creates a Weave OpenCode plugin with optional configuration.
 *
 * Returns a `Plugin` function that OpenCode can load at startup. In
 * production, call `createWeavePlugin()` with no arguments (or use the
 * pre-built `WeavePlugin` export). In tests, pass a custom `fileReader` to
 * isolate the test from the developer's global `~/.weave/config.weave`.
 *
 * The returned plugin function:
 * 1. Loads Weave config and translates agent descriptors (pure computation).
 * 2. Returns `Hooks` **immediately** — never blocks on SDK/DB calls.
 * 3. Defers `adapter.init()` + `spawnSubagent()` to the `event` hook, which
 *    fires on the first `session.created` event during a real OpenCode session.
 *
 * This design ensures `opencode debug config` returns quickly because it only
 * exercises the `config` hook path, never the deferred SDK reconciliation path.
 *
 * @param options - Optional plugin configuration.
 * @returns A `Plugin` function compatible with `@opencode-ai/plugin`.
 */
export function createWeavePlugin(options: WeavePluginOptions = {}): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const { client: sdkClient, directory } = input;

    // Redirect logs to a project-local file before any log calls.
    //
    // When running as an OpenCode plugin, stdout is read by the OpenCode UI.
    // Writing structured JSON logs to stdout would surface raw log lines in
    // the chat interface, which is confusing for users.
    //
    // `redirectLogsToFile` is a no-op when `WEAVE_LOG_FILE` is already set
    // (the env var is the explicit override). Otherwise it redirects the
    // shared pino stream to `.weave/weave.log` under the project directory.
    // All existing child loggers share the same stream and automatically write
    // to the new destination after this call.
    //
    // We only redirect when the project directory exists. If it doesn't (e.g.
    // in tests using a non-existent path), we skip the redirect and let logs
    // fall through to stdout — the config load will fail anyway.
    if (!env.WEAVE_LOG_FILE) {
      // Check if the project directory exists before redirecting. If it
      // doesn't (e.g. in tests using a non-existent path), skip the redirect
      // and let logs fall through to stdout — the config load will fail anyway.
      // Note: Bun.file().exists() returns false for directories; use stat().
      const dirExists = await Bun.file(directory)
        .stat()
        .then(() => true)
        .catch(() => false);
      if (dirExists) {
        await redirectLogsToFile(join(directory, DEFAULT_PLUGIN_LOG_SUBPATH));
      }
    }

    log.info({ directory }, "Weave plugin starting");

    // Load Weave config from the project directory.
    const configResult = await loadConfig(directory, options.fileReader);
    if (configResult.isErr()) {
      const errors = configResult.error;
      log.error(
        { errors },
        "Failed to load Weave config — no agents will be materialized",
      );
      // Return empty hooks rather than throwing — a config load failure should
      // not crash the entire OpenCode session. The error is logged for diagnosis.
      return {};
    }

    const config = configResult.value;

    // Compose all agent descriptors from the resolved config.
    const planResult = await materializeAgents({ config });

    // materializeAgents returns ResultAsync<MaterializationPlan, never> — it
    // always resolves to ok(). The never error type means we can safely unwrap.
    const plan = planResult._unsafeUnwrap();

    if (plan.errors.length > 0) {
      log.warn(
        { errors: plan.errors.map((e: { type: string }) => e.type) },
        "Materialization plan has partial errors — some agents may not be registered",
      );
    }

    // Generate review variant agent configs and compose descriptors.
    // These are produced by agents that declare `review_models` and must be
    // materialized alongside explicit agents so that direct invocation via
    // executeReviewVariants can find them by name.
    const reviewVariantsResult = generateReviewVariants(config);
    if (reviewVariantsResult.isErr()) {
      log.warn(
        {
          variantName: reviewVariantsResult.error.variantName,
          agentName: reviewVariantsResult.error.agentName,
          message: reviewVariantsResult.error.message,
        },
        "Review variant conflict detected — generated review variants will not be registered",
      );
    }

    const reviewVariantEntries = reviewVariantsResult.isOk()
      ? Object.entries(reviewVariantsResult.value)
      : [];

    // Build a Set of generated review variant names for exact-match guarding
    // in the chat.message hook. This avoids false positives from substring
    // matching (e.g. an agent legitimately named "pre-review-ops").
    const reviewVariantNames = buildReviewVariantSet(reviewVariantEntries);

    // Translate each descriptor into an OpenCodeAgentConfig and collect into a
    // map. This map is used by the config hook to inject agents into cfg.agent.
    // Translation is performed here (before the config hook is returned) so that
    // any translation errors are surfaced at startup, not deferred to hook time.
    const translatedMap = new Map<string, OpenCodeAgentConfig>();

    for (const { agentName, descriptor } of plan.agents) {
      // Resolve model using an empty context (no harness model context available
      // at config-hook time — the hook runs before the harness is fully started).
      const modelResult = resolveModelForAgent(descriptor, {});

      if (modelResult.isErr()) {
        log.warn(
          {
            agent: agentName,
            errorType: modelResult.error.type,
            message: modelResult.error.message,
          },
          "Model resolution failed for agent — skipping config hook injection for this agent",
        );
        continue;
      }

      const translateResult = translateAgent(descriptor, modelResult.value);

      if (translateResult.isErr()) {
        log.warn(
          {
            agent: agentName,
            error: translateResult.error.type,
            message: translateResult.error.message,
          },
          "Translation failed for agent — skipping config hook injection for this agent",
        );
        continue;
      }

      translatedMap.set(agentName, translateResult.value);
      log.debug({ agent: agentName }, "Agent translated for config hook");
    }

    // Translate generated review variant agents into the config hook map and
    // the deferred reconciliation descriptor list. Review variants must be
    // registered so that `executeReviewVariants` can invoke them by name.
    const reviewVariantDescriptors: Array<{
      agentName: string;
      descriptor: AgentDescriptor;
    }> = [];

    for (const [variantName, generatedVariant] of reviewVariantEntries) {
      // Compose a proper AgentDescriptor via the engine's compose function.
      // This ensures prompt rendering, tool policy evaluation, and template
      // context are all handled consistently with explicit agents.
      const composeResult = await composeAgentDescriptor(
        variantName,
        generatedVariant.config,
        config,
        {},
        undefined,
      );

      if (composeResult.isErr()) {
        log.warn(
          { agent: variantName, cause: composeResult.error.type },
          "Descriptor composition failed for review variant — skipping registration",
        );
        continue;
      }

      const variantDescriptor = composeResult.value;
      const variantModelResult = resolveModelForAgent(variantDescriptor, {});

      if (variantModelResult.isErr()) {
        log.warn(
          {
            agent: variantName,
            errorType: variantModelResult.error.type,
            message: variantModelResult.error.message,
          },
          "Model resolution failed for review variant — skipping config hook injection",
        );
        continue;
      }

      const variantTranslateResult = translateAgent(
        variantDescriptor,
        variantModelResult.value,
      );

      if (variantTranslateResult.isErr()) {
        log.warn(
          {
            agent: variantName,
            error: variantTranslateResult.error.type,
            message: variantTranslateResult.error.message,
          },
          "Translation failed for review variant — skipping config hook injection",
        );
        continue;
      }

      translatedMap.set(variantName, variantTranslateResult.value);
      reviewVariantDescriptors.push({
        agentName: variantName,
        descriptor: variantDescriptor,
      });
      log.debug(
        { agent: variantName },
        "Review variant agent translated for config hook",
      );
    }

    log.info(
      { agentCount: translatedMap.size },
      "Agents translated for config hook injection",
    );

    // Build the client facade once. In production, wrap the raw SDK client in
    // SdkOpenCodeClient. In tests, use the pre-constructed clientFacade directly
    // (bypasses SdkOpenCodeClient wrapping so mock clients work without a live SDK).
    const clientFacade: OpenCodeClientFacade =
      options.clientFacade ?? new SdkOpenCodeClient(sdkClient);

    log.info("Weave plugin hooks ready — returning immediately");

    // Return hooks immediately. The config hook injects all Weave agents into
    // the OpenCode in-memory config. The event hook is kept for interface
    // compliance but does no work — agent materialization is config-hook based.
    return {
      config: async (cfg) => {
        // --- Agent injection ---
        if (translatedMap.size > 0) {
          if (cfg.agent === undefined) {
            cfg.agent = {};
          }

          for (const [agentName, agentConfig] of translatedMap) {
            // Tag with ownership before injecting so the config store can
            // classify these agents as Weave-managed for future reference.
            cfg.agent[agentName] = tagWithOwnership(agentConfig);
            log.debug({ agent: agentName }, "Agent injected into config hook");
          }

          log.info(
            { agentCount: translatedMap.size },
            "Weave agents injected into OpenCode config",
          );
        }

        // --- Default agent configuration ---
        // Set Loom as the default agent so new sessions start with the
        // orchestrator rather than OpenCode's built-in 'build' agent.
        // Type assertion needed: OpenCode supports `default_agent` but the
        // @opencode-ai/plugin type definitions may lag behind the runtime.
        if (translatedMap.has("loom")) {
          (cfg as Record<string, unknown>).default_agent = "loom";
          log.info("Set default_agent to 'loom'");
        }

        // --- Command injection ---
        // Register /start-work and /weave:start as OpenCode slash commands.
        // These are prompt-based commands (not LLM tools) — they inject the
        // Tapestry execution template into the conversation when the user
        // types the command in the TUI.
        if (cfg.command === undefined) {
          cfg.command = {};
        }

        cfg.command["start-work"] = {
          template: START_WORK_COMMAND_TEMPLATE,
          description: "Start executing a Weave plan created by Pattern",
          agent: "tapestry",
        };

        cfg.command["weave:start"] = {
          template: WEAVE_START_COMMAND_TEMPLATE,
          description: "Start executing a Weave plan (preferred command)",
          agent: "tapestry",
        };

        log.info(
          { commands: ["start-work", "weave:start"] },
          "Weave slash commands registered",
        );
      },

      // event hook is retained as a no-op placeholder for future lifecycle
      // needs (e.g. session-scoped setup). It does not perform SDK
      // reconciliation — agent injection is handled entirely by the config hook.
      event: async ({ event: _event }) => {
        // no-op
      },

      "chat.message": async (input, output) => {
        // Extract text from the incoming message parts.
        const text = extractTextFromParts(output.parts);

        // Resolve the candidate reviewer agent name.
        const agentName = resolveReviewerAgentName(input.agent, text);
        if (!agentName) return;

        // Guard: skip generated review variant agent names.
        if (isGeneratedReviewVariant(agentName, reviewVariantNames)) return;

        // Guard: only proceed when the agent has review_models declared.
        const agentConfig = config.agents[agentName];
        if (!agentConfig?.review_models?.length) return;

        log.info(
          { agent: agentName },
          "Direct review triggered via chat.message hook",
        );

        const adapter = new OpenCodeAdapter({
          projectRoot: directory,
          client: clientFacade,
          config,
        });

        const reviewResult = await adapter.executeDirectReview(agentName, text);

        if (reviewResult.isErr()) {
          const sanitizedReason =
            reviewResult.error.message ?? reviewResult.error.type;
          const failureText = `Direct adversarial review failed for ${agentName}; no single-model review was run. ${sanitizedReason}`;
          log.warn(
            { agent: agentName, errorType: reviewResult.error.type },
            "Direct review failed — replacing output with blocking failure message",
          );

          // Fail-closed: replace ALL text parts with a blocking failure summary
          // so that configured review_models do not silently degrade. Keep
          // non-text parts (tool calls, images, etc.) intact.
          const hasTextParts = output.parts.some((p) => p.type === "text");
          if (hasTextParts) {
            // Grab metadata from the first text part for the replacement.
            const firstText = output.parts.find(
              (p): p is Extract<Part, { type: "text" }> => p.type === "text",
            ) as Extract<Part, { type: "text" }>;
            const replacement: Extract<Part, { type: "text" }> = {
              ...firstText,
              text: failureText,
            };
            // Remove all text parts, then prepend the single blocking message.
            output.parts = output.parts.filter((p) => p.type !== "text");
            output.parts.unshift(replacement);
          } else {
            const synthetic: Extract<Part, { type: "text" }> = {
              id: `weave-direct-review-fail-${Date.now()}`,
              sessionID: input.sessionID,
              messageID: input.messageID ?? `weave-msg-${Date.now()}`,
              type: "text",
              text: failureText,
              synthetic: true,
            };
            output.parts.push(synthetic);
          }
          return;
        }

        const { formattedSummary } = reviewResult.value;
        const instruction = `Direct adversarial review completed. Return the following review summary to the user without re-running the review:\n\n${formattedSummary}`;

        // Replace ALL existing text parts with the review instruction, keeping
        // non-text parts (tool calls, images, etc.) intact. If no text parts
        // are present, append a synthetic one.
        const hasTextParts = output.parts.some((p) => p.type === "text");
        if (hasTextParts) {
          const firstText = output.parts.find(
            (p): p is Extract<Part, { type: "text" }> => p.type === "text",
          ) as Extract<Part, { type: "text" }>;
          const replacement: Extract<Part, { type: "text" }> = {
            ...firstText,
            text: instruction,
          };
          output.parts = output.parts.filter((p) => p.type !== "text");
          output.parts.unshift(replacement);
        } else {
          // No text parts — append a synthetic one using the hook's IDs.
          const synthetic: Extract<Part, { type: "text" }> = {
            id: `weave-direct-review-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: input.messageID ?? `weave-msg-${Date.now()}`,
            type: "text",
            text: instruction,
            synthetic: true,
          };
          output.parts.push(synthetic);
        }

        log.info(
          { agent: agentName },
          "Direct review summary surfaced via chat.message hook",
        );
      },
    };
  };
}

/**
 * Weave OpenCode plugin.
 *
 * Loaded by OpenCode at startup when `@weaveio/weave-adapter-opencode` is listed in
 * the `plugin` array of `opencode.json`. Materializes all agents declared in
 * `.weave/config.weave` into the running OpenCode instance.
 *
 * Returns a `Hooks` object **immediately** with:
 * - `config` hook — injects translated agent configs into `cfg.agent` so that
 *   `opencode debug config` shows all Weave-managed agents.
 * - `event` hook — defers SDK-backed reconciliation (`spawnSubagent`) to the
 *   first `session.created` event, ensuring `opencode debug config` never
 *   blocks on SDK/DB calls.
 *
 * @param input - Runtime context provided by OpenCode, including the SDK
 *   client and the project directory.
 * @returns A `Hooks` object with `config` and `event` hooks on success, or an
 *   empty `Hooks` object when config loading fails.
 */
export const WeavePlugin: Plugin = createWeavePlugin();

/**
 * Named `server` export for `PluginModule` compatibility.
 *
 * OpenCode resolves plugins as `PluginModule` objects with a `server` property.
 * When the module's default export is a function, OpenCode also accepts it
 * directly as the plugin. Both forms are exported here for maximum
 * compatibility.
 */
export const server = WeavePlugin;

export default WeavePlugin;
