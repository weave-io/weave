// biome-ignore-all lint/suspicious/noConsole: verification CLI writes to stdout/stderr
/**
 * Container-side smoke script for `verify:opencode2` layers 3 and 4.
 *
 * Runs INSIDE the Podman container built from `verify/Containerfile`. Must
 * never import anything from `packages/adapters/opencode/` and must never
 * trigger a real LLM call (no session is created, no prompt is ever sent to
 * a model, in either sub-check).
 *
 * Two sub-checks, selected by `argv[2]`:
 *
 *   embedded   — layer 3: `OpenCode.create({ plugins: [weavePlugin] })`
 *                using the exact pinned `@opencode-ai/sdk`. Forces plugin
 *                activation via the LLM-free `host.plugin.awaitActivation()`
 *                call (see `.weave/learnings/opencode2-adapter.md`, A3),
 *                then tears the host down with `host.close()`. Passes if
 *                neither step throws.
 *
 *   real-loader — layer 4: invokes the real `opencode2` CLI's plugin loader
 *                against `verify/fixtures/opencode.jsonc`, which references
 *                `verify/fixtures/plugin-wrapper/server.ts` — a thin marker
 *                -writing wrapper around the real built adapter (imported
 *                via its `./server` subpath export). Per Task E1's guidance
 *                asserting the plugin's `setup()` fires and its returned
 *                cleanup runs is sufficient to prove the real loader
 *                executes the actual adapter. A minimal `"hi"` message is
 *                sent to `opencode2 run --standalone` only because the real
 *                loader was empirically found to skip project-plugin
 *                loading entirely when no message is given; `--standalone`
 *                resolves to the free, credential-free
 *                `muse-spark-1.3-contributor-free` default model (see
 *                Task E1 / Phase A precedent) — this is the harness's one
 *                sanctioned real-loader exception, and none of the
 *                assertions below depend on the model's response text.
 */

const mode = process.argv[2];

async function runEmbedded(): Promise<number> {
  const { OpenCode } = await import("@opencode-ai/sdk");
  // Resolves through the package's own `exports` map ("./server" ->
  // dist/server.js), the same subpath a real config would reference.
  const weavePluginModule = await import(
    "@weaveio/weave-adapter-opencode2/server"
  );
  const weavePlugin = weavePluginModule.default;

  if (typeof weavePlugin?.setup !== "function") {
    console.error("FAIL: embedded — imported plugin has no setup() function");
    return 1;
  }

  const host = await OpenCode.create({ plugins: [weavePlugin] });
  await host.plugin.awaitActivation();
  console.log(
    "OK: embedded — host.plugin.awaitActivation() completed without throwing",
  );

  await host.close();
  console.log("OK: embedded — host.close() completed without throwing");
  return 0;
}

async function runRealLoader(): Promise<number> {
  const fixtureDir = process.env.FIXTURE_DIR ?? process.cwd();
  const markerDir =
    process.env.WEAVE_VERIFY_MARKER_DIR ?? "/tmp/weave-verify-markers";

  await Bun.write(`${markerDir}/.keep`, "");

  // A minimal chat message is required: the real CLI's plugin loader only
  // runs project plugins while dispatching `opencode2 run` with a message
  // (confirmed empirically — omitting the message causes an early "must
  // provide a message" error before any plugin loads). Per Task E1's
  // explicit guidance and the Phase A feasibility harness's precedent
  // (`.weave/feasibility/opencode2/scripts/proof-loader.sh`), `--standalone`
  // resolves against the built-in free `muse-spark-1.3-contributor-free`
  // model, which requires no credentials or paid provider — this is the
  // one sanctioned exception to "no real LLM calls", scoped to proving the
  // real loader path only. The assertions below never depend on the
  // model's response text — only on the marker files plugin-wrapper writes
  // from inside `setup()`/cleanup.
  const proc = Bun.spawn({
    // Invoked via `bash -c "cd ... && opencode2 ..."` rather than passing
    // `cwd` directly to `Bun.spawn` for the `opencode2` binary: empirically,
    // the compiled `opencode2` CLI binary does not honor a `Bun.spawn`-set
    // `cwd` for its own internal "location"/project-root resolution (it
    // still reported `directory=/work` — the container's WORKDIR — even
    // when `cwd: fixtureDir` was passed directly). A real shell `cd` before
    // invoking the binary does not have this problem.
    cmd: [
      "bash",
      "-c",
      `cd "${fixtureDir}" && exec opencode2 run hi --standalone --print-logs --log-level warn`,
    ],
    env: { ...process.env, WEAVE_VERIFY_MARKER_DIR: markerDir },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = 20_000;
  await Promise.race([
    proc.exited,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  // The CLI errors out ("must provide a message") once plugins have already
  // been loaded and their setup() has run — we don't wait for or depend on
  // its own exit code, only on the marker files plugin-wrapper writes.
  if (proc.exitCode === null) proc.kill();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  console.log(`${stdout}\n${stderr}`);

  const combined = `${stdout}\n${stderr}`;
  if (/@weaveio\/weave-adapter-opencode(?!2)/.test(combined)) {
    console.error(
      "FAIL: real-loader — output references the V1 adapter package",
    );
    return 1;
  }

  const setupInvoked = await Bun.file(`${markerDir}/setup.marker`).exists();
  const cleanupInvoked = await Bun.file(`${markerDir}/cleanup.marker`).exists();

  if (!setupInvoked) {
    console.error(
      "FAIL: real-loader — setup.marker not found; plugin setup() did not run",
    );
    return 1;
  }
  if (!cleanupInvoked) {
    console.error(
      "FAIL: real-loader — cleanup.marker not found; plugin cleanup did not run",
    );
    return 1;
  }

  console.log(
    "OK: real-loader — setup.marker and cleanup.marker both observed, no V1 references",
  );
  return 0;
}

async function main(): Promise<number> {
  if (mode === "embedded") return runEmbedded();
  if (mode === "real-loader") return runRealLoader();
  console.error(
    `Unknown mode "${mode}" — expected "embedded" or "real-loader"`,
  );
  return 1;
}

const code = await main();
process.exit(code);
