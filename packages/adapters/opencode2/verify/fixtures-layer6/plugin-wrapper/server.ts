/**
 * Marker-writing wrapper around the real Weave V2 plugin, used only by
 * `verify/run.sh` layer 6 (real-CLI agent-materialization test).
 *
 * Distinct from `../../fixtures/plugin-wrapper/server.ts` (layer 4) which asserts
 * only that the CLI ran the plugin's `setup()`/cleanup. Layer 6 goes
 * further: after the real adapter's `setup(ctx)` resolves — which is when
 * agents have been materialized via `ctx.agent.transform(...)` — this
 * wrapper calls `ctx.agent.list()` (RPC into the CLI's own host state,
 * unwrap the `{ location, data }` envelope per A4) and writes the result
 * to a marker file the host process (`verify/container-smoke.ts`) reads.
 *
 * Invariant proved: the CLI's own view of `agent.list()` — via the exact
 * `ctx` the real V2 loader delivered to the plugin subprocess — contains
 * a Weave-owned `loom` entry. No embedded `OpenCode.create` host is
 * involved; the observation is strictly CLI-side.
 *
 * Imports the real built adapter via its `./server` subpath export — the
 * same path a user's `opencode.jsonc` would reference — so this exercises
 * the actual `Plugin.define({ id, setup })` entry point, not a stand-in.
 *
 * Constraints:
 *  - No second embedded host is spawned.
 *  - No prompt / LLM response is depended on.
 *  - Only marker files + one `ctx.agent.list()` call are added on top of
 *    the real adapter's own `setup(ctx)` side-effects.
 */
import weavePlugin from "@weaveio/weave-adapter-opencode2/server";

function markerDir(): string {
  return process.env.WEAVE_VERIFY_MARKER_DIR ?? process.cwd();
}

type AgentEntry = { name?: string; description?: string };

const wrapped = {
  ...weavePlugin,
  async setup(ctx: unknown) {
    const cleanup = await (
      weavePlugin as {
        setup: (ctx: unknown) => Promise<(() => Promise<void>) | void>;
      }
    ).setup(ctx);

    await Bun.write(`${markerDir()}/setup.marker`, "1");

    // Introspect the ctx the CLI actually delivered so the learnings can
    // record concretely what `ctx.location.directory` points at inside the
    // CLI's plugin subprocess (spec question in the task brief).
    const location =
      (ctx as { location?: { directory?: unknown } } | null)?.location ?? null;
    const locationDirectory =
      typeof location?.directory === "string" ? location.directory : null;
    await Bun.write(
      `${markerDir()}/location.marker.json`,
      JSON.stringify({ directory: locationDirectory }, null, 2),
    );

    // Observe the CLI's own agent state via the plugin's ctx. A4: RPC list
    // APIs return a `{ location, data }` envelope — unwrap `.data`.
    // Failures here MUST NOT throw out of setup (that would poison the
    // real CLI's plugin activation and mask the layer 4 setup marker); we
    // write whatever we observe and let the host-side smoke assert.
    let agents: AgentEntry[] = [];
    let listError: string | null = null;
    try {
      const rpc = ctx as { agent?: { list?: () => Promise<unknown> } } | null;
      if (typeof rpc?.agent?.list === "function") {
        const envelope = (await rpc.agent.list()) as
          | { data?: AgentEntry[] }
          | AgentEntry[]
          | null;
        if (Array.isArray(envelope)) {
          agents = envelope;
        } else if (envelope && Array.isArray(envelope.data)) {
          agents = envelope.data;
        }
      } else {
        listError = "ctx.agent.list is not a function";
      }
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err);
    }

    await Bun.write(
      `${markerDir()}/agent-list.marker.json`,
      JSON.stringify(
        {
          error: listError,
          count: agents.length,
          agents: agents.map((a) => ({
            name: a?.name ?? null,
            description: a?.description ?? null,
          })),
        },
        null,
        2,
      ),
    );

    return async (): Promise<void> => {
      if (typeof cleanup === "function") await cleanup();
      await Bun.write(`${markerDir()}/cleanup.marker`, "1");
    };
  },
};

export default wrapped;
