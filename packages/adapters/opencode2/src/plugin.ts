/**
 * `Plugin.define` entry point for the OpenCode V2 (`opencode2`) Weave
 * plugin.
 *
 * Implements Spec 34 (`docs/specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md`)
 * task C12. Wires together every prior Phase C module into the single
 * `Plugin.define({ id, setup })` shape the real V2 loader expects:
 *
 * - `setupWeavePlugin(facade)` — the testable core. Constructs an
 *   `OpenCode2Adapter` over the given `PluginContextFacade`, calls
 *   `adapter.init()`, starts a fire-and-forget event-subscription loop
 *   (driven by an `AbortController` so it can be cancelled on teardown),
 *   and returns a `V2Cleanup` that aborts the subscription and disposes the
 *   adapter.
 * - The exported default `plugin` wraps `setupWeavePlugin` with
 *   `fromLiveContext(ctx)` so the real `Plugin.define({ setup(ctx) })` entry
 *   point never touches `PluginContextFacade` construction directly — that
 *   stays testable in isolation via `MockPluginContext`.
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

import { logger } from "@weaveio/weave-engine";
import { OpenCode2Adapter } from "./adapter.js";
import { fromLiveContext, type PluginContextFacade } from "./plugin-context.js";
import { type V2Cleanup, type V2Context, V2PluginModule } from "./sdk-types.js";

const log = logger.child({ module: "plugin-opencode2" });

/**
 * Core, testable setup body shared by the real `Plugin.define({ setup })`
 * entry and unit tests (via `MockPluginContext`).
 *
 * 1. Constructs an `OpenCode2Adapter` over `facade`.
 * 2. Calls `adapter.init()` (registers built-in `/weave:*` commands).
 * 3. Starts a fire-and-forget `facade.event.subscribe({ signal })` loop
 *    driven by a fresh `AbortController` — kept minimal per module header.
 * 4. Returns a `V2Cleanup` that aborts the subscription controller and
 *    disposes the adapter (every accumulated `V2Registration`).
 */
export async function setupWeavePlugin(
  facade: PluginContextFacade,
): Promise<V2Cleanup> {
  const adapter = new OpenCode2Adapter(facade);
  await adapter.init();

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
 * The `Plugin.define({ id: "weave", setup })` entry point.
 *
 * `setup(ctx)` adapts the real V2 `Context` into a `PluginContextFacade`
 * via `fromLiveContext()`, then delegates to `setupWeavePlugin()`.
 */
const plugin = V2PluginModule.define({
  id: "weave",
  setup: async (ctx: V2Context): Promise<V2Cleanup> =>
    setupWeavePlugin(fromLiveContext(ctx)),
});

export default plugin;
