/**
 * Marker-writing wrapper around the real Weave V2 plugin, used only by
 * `verify/run.sh` layer 4 (real `opencode2` plugin-loader test).
 *
 * Per Task E1's guidance and `.weave/learnings/opencode2-adapter.md` (A3),
 * asserting the plugin's `setup()` fires and its returned cleanup function
 * runs is sufficient to prove the real loader executes the actual built
 * adapter — no chat prompt or LLM response is required. This wrapper writes
 * `setup.marker` / `cleanup.marker` files (read back by `verify/run.sh`
 * from the host-visible ephemeral run directory) instead of relying on
 * captured subprocess stdout, since the real `opencode2` CLI runs the
 * plugin inside a separate `serve --stdio` child process whose stdout is
 * consumed by the CLI's JSON-RPC framing and is not reliably observable by
 * the invoking shell.
 *
 * This file imports the real built adapter via the package's `./server`
 * subpath export — the same path a real user's `opencode.jsonc` would
 * reference — so it proves the actual `Plugin.define({ id, setup })` entry
 * point runs, not a stand-in.
 */
import weavePlugin from "@weaveio/weave-adapter-opencode2/server";

function markerDir(): string {
  return process.env.WEAVE_VERIFY_MARKER_DIR ?? process.cwd();
}

const wrapped = {
  ...weavePlugin,
  async setup(ctx: unknown) {
    const cleanup = await (
      weavePlugin as {
        setup: (ctx: unknown) => Promise<(() => Promise<void>) | void>;
      }
    ).setup(ctx);

    await Bun.write(`${markerDir()}/setup.marker`, "1");

    return async (): Promise<void> => {
      if (typeof cleanup === "function") await cleanup();
      await Bun.write(`${markerDir()}/cleanup.marker`, "1");
    };
  },
};

export default wrapped;
