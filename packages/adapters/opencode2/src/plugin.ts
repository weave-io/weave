/**
 * `Plugin.define` entry point for the OpenCode V2 (`opencode2`) Weave
 * plugin.
 *
 * Implements Spec 34 (`docs/specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md`)
 * task C12, extended in 0.1.1 to actually materialize Weave agents into the
 * running V2 host.
 *
 * ## Shape
 *
 * - `setupWeavePlugin(facade, options?)` — the testable core. Loads Weave
 *   config from the resolved project directory, calls `materializeAgents`
 *   to compose descriptors, constructs an `OpenCode2Adapter` over the given
 *   `PluginContextFacade`, calls `adapter.init()`, and iterates the plan's
 *   agents calling `adapter.spawnSubagent(descriptor)` for each — collecting
 *   per-agent failures without aborting the loop. Then starts a
 *   fire-and-forget event-subscription loop driven by an `AbortController`
 *   so it can be cancelled on teardown, and returns a `V2Cleanup` that
 *   aborts the subscription and disposes the adapter.
 * - The exported default `plugin` wraps `setupWeavePlugin` with
 *   `fromLiveContext(ctx)` and reads the project directory from
 *   `ctx.location.directory` so the real `Plugin.define({ setup(ctx) })`
 *   entry point never touches `PluginContextFacade` construction or engine
 *   dependency wiring directly — that stays testable in isolation via
 *   `MockPluginContext` plus stubbed `loadConfig` / `materializeAgents`.
 *
 * ## Degrade-gracefully behaviour
 *
 * A failing config load MUST NOT crash the session. When `loadConfig`
 * returns `err`, the plugin logs at info-level (config error is expected
 * when no `.weave/` config is present) and continues with the
 * lifecycle-only path — `adapter.init()` still runs (built-in `/weave:*`
 * commands are registered), the event loop still starts, and cleanup still
 * works. This mirrors V1 (`packages/adapters/opencode/src/plugin.ts`) —
 * empty `Hooks` on config-load failure.
 *
 * Individual `spawnSubagent` failures are also collected and never abort
 * the loop; remaining agents still get a materialization attempt. Failures
 * are logged with `{ agent, err }` context.
 *
 * ## Directory-based plugin entry (A2 finding)
 *
 * The real V2 plugin loader requires the plugin entry to be a DIRECTORY
 * containing `server.ts` or `index.ts` — a single `plugin.ts` file is not
 * discoverable on its own. `./server.ts` re-exports this module's default
 * export so the package's `./server` subpath (mapped to `dist/server.js` in
 * `package.json`) satisfies that loader contract.
 *
 * ## Event subscription (A3 finding)
 *
 * `ctx.event.subscribe({ signal })` returns a plain `AsyncIterable<V2Event>`
 * with no `Registration`-style dispose handle — cancellation is only
 * possible by aborting the provided `AbortSignal`. The subscription loop
 * here is intentionally minimal: it idles when no workflow is active. The
 * actual workflow-run trigger is wired through command execution (C10's
 * `registerCommands` / `runWorkflow`), not through this event loop.
 */

import { loadConfig as defaultLoadConfig } from "@weaveio/weave-config";
import {
  materializeAgents as defaultMaterializeAgents,
  logger,
} from "@weaveio/weave-engine";
import { OpenCode2Adapter } from "./adapter.js";
import { fromLiveContext, type PluginContextFacade } from "./plugin-context.js";
import { type V2Cleanup, type V2Context, V2PluginModule } from "./sdk-types.js";

const log = logger.child({ module: "plugin-opencode2" });

/**
 * Injection points for `setupWeavePlugin`. All optional. In production, the
 * real `Plugin.define({ setup })` entry passes only `directory`; tests pass
 * stubbed `loadConfig` / `materializeAgents` to isolate from real I/O.
 */
export interface SetupWeavePluginOptions {
  /**
   * Absolute path to the project root the plugin was activated for. When
   * omitted, falls back to `Bun.env.PWD ?? process.cwd()` — real callers
   * should always pass this from `ctx.location.directory`.
   */
  readonly directory?: string;
  /**
   * Override for `@weaveio/weave-config`'s `loadConfig`. Defaults to the
   * real implementation. Tests inject a stub returning a fixture config.
   */
  readonly loadConfig?: typeof defaultLoadConfig;
  /**
   * Override for `@weaveio/weave-engine`'s `materializeAgents`. Defaults to
   * the real implementation. Tests inject a stub returning a fixed plan.
   */
  readonly materializeAgents?: typeof defaultMaterializeAgents;
}

/**
 * Core, testable setup body shared by the real `Plugin.define({ setup })`
 * entry and unit tests (via `MockPluginContext`).
 *
 * 1. Resolves the project directory (explicit option → `Bun.env.PWD` →
 *    `process.cwd()`).
 * 2. Loads Weave config via `loadConfig(directory)`. On error, logs and
 *    skips materialization — proceeds directly to lifecycle-only setup.
 * 3. On success, calls `materializeAgents({ config })` and unwraps the plan
 *    (the error channel is `never`).
 * 4. Constructs an `OpenCode2Adapter` over `facade`, calls `adapter.init()`
 *    (registers built-in `/weave:*` commands).
 * 5. Iterates `plan.agents` calling `adapter.spawnSubagent(descriptor)` for
 *    each. Individual failures are logged and skipped — the loop always
 *    reaches the end.
 * 6. Starts a fire-and-forget `facade.event.subscribe({ signal })` loop
 *    driven by a fresh `AbortController`.
 * 7. Returns a `V2Cleanup` that aborts the subscription controller and
 *    disposes the adapter (every accumulated `V2Registration`).
 */
export async function setupWeavePlugin(
  facade: PluginContextFacade,
  options: SetupWeavePluginOptions = {},
): Promise<V2Cleanup> {
  const directory = resolveDirectory(options.directory);
  const loadConfigImpl = options.loadConfig ?? defaultLoadConfig;
  const materializeAgentsImpl =
    options.materializeAgents ?? defaultMaterializeAgents;

  const adapter = new OpenCode2Adapter(facade, { projectRoot: directory });
  await adapter.init();

  const { registered, failed } = await materializeAllAgents(
    adapter,
    directory,
    loadConfigImpl,
    materializeAgentsImpl,
  );

  const controller = new AbortController();

  // Fire-and-forget event-driving loop. Idles when no workflow is active;
  // the actual workflow-run trigger is wired through command execution
  // (see module header).
  void (async (): Promise<void> => {
    try {
      for await (const _event of facade.event.subscribe({
        signal: controller.signal,
      })) {
        // Intentionally minimal: no workflow-driving logic yet (C12 scope).
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      log.error({ err: cause }, "Weave plugin event subscription loop failed");
    }
  })();

  log.info(
    { registered, failed, projectRoot: directory },
    "Weave plugin setup complete",
  );

  return async (): Promise<void> => {
    controller.abort();
    const result = await adapter.dispose();
    result.match(
      () => {
        log.info("Weave plugin cleanup completed");
      },
      (error) => {
        log.error({ err: error }, "Weave plugin cleanup encountered an error");
      },
    );
  };
}

/**
 * Load config, run materialization, and spawn every plan agent through the
 * adapter. Never throws — every failure path degrades to a logged warning
 * and returns a partial count.
 */
async function materializeAllAgents(
  adapter: OpenCode2Adapter,
  directory: string,
  loadConfigImpl: typeof defaultLoadConfig,
  materializeAgentsImpl: typeof defaultMaterializeAgents,
): Promise<{ registered: number; failed: number }> {
  const configResult = await loadConfigImpl(directory);
  if (configResult.isErr()) {
    log.info(
      {
        directory,
        errors: configResult.error.map((e) => e.type),
      },
      "Weave config not loaded — no agents will be materialized",
    );
    return { registered: 0, failed: 0 };
  }

  const config = configResult.value;
  const planResult = await materializeAgentsImpl({ config });
  // materializeAgents returns ResultAsync<MaterializationPlan, never>; the
  // never error channel means we can safely unwrap. Matches V1.
  const plan = planResult._unsafeUnwrap();

  if (plan.errors.length > 0) {
    log.warn(
      { errors: plan.errors.map((e) => e.type) },
      "Materialization plan has partial errors — some agents may not be registered",
    );
  }

  let registered = 0;
  let failed = 0;
  for (const { agentName, descriptor } of plan.agents) {
    const result = await adapter.spawnSubagent(descriptor);
    if (result.isErr()) {
      failed += 1;
      log.error(
        { agent: agentName, err: result.error },
        "Failed to materialize agent — continuing with remaining agents",
      );
      continue;
    }
    registered += 1;
  }

  return { registered, failed };
}

function resolveDirectory(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const pwd = Bun.env.PWD;
  if (pwd !== undefined && pwd.length > 0) return pwd;
  log.warn(
    "No project directory provided and Bun.env.PWD is unset — falling back to process.cwd()",
  );
  return process.cwd();
}

/**
 * The `Plugin.define({ id: "weave", setup })` entry point.
 *
 * `setup(ctx)` reads the project directory from `ctx.location.directory`
 * (V2 exposes the resolved absolute path as a branded string there), adapts
 * the real V2 `Context` into a `PluginContextFacade` via `fromLiveContext()`,
 * then delegates to `setupWeavePlugin()`.
 */
const plugin = V2PluginModule.define({
  id: "weave",
  setup: async (ctx: V2Context): Promise<V2Cleanup> => {
    // `ctx.location.directory` is a nominal `Schema.brand<Schema.String,
    // "AbsolutePath">` — structurally a plain string at runtime.
    const directory = ctx.location?.directory as unknown as string | undefined;
    return setupWeavePlugin(fromLiveContext(ctx), { directory });
  },
});

export default plugin;
