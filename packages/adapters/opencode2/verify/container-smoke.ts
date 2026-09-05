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

/**
 * Layer 5 — Agent Materialization.
 *
 * Boots the embedded SDK path with `OpenCode.create({ plugins: [weavePlugin] })`
 * against a fixture project directory containing an empty `.weave/config.weave`
 * — enough for `@weaveio/weave-config`'s built-in agents (Loom, Shuttle, ...)
 * to be composed into the materialization plan. `awaitActivation()` forces the
 * plugin's `setup()` to run, which then calls `adapter.spawnSubagent()` for
 * every plan agent.
 *
 * Assertions (via `host.agent.list()`, unwrapped per A4):
 *   1. `data` is non-empty.
 *   2. At least one entry has `name === "loom"`.
 *   3. That entry's `description` starts with the V2-package-local
 *      `WEAVE_OWNERSHIP_MARKER` — imported from the package's `./server`
 *      subpath so this check verifies the exact same constant Weave writes.
 *
 * Never sends a prompt / triggers a real LLM call.
 */
async function runAgentMaterialization(): Promise<number> {
  const fixtureDir =
    process.env.FIXTURE_DIR ??
    `${process.cwd()}/verify/fixtures/agent-materialization`;

  const marker = await Bun.file(`${fixtureDir}/.weave/config.weave`).exists();
  if (!marker) {
    console.error(
      `FAIL: agent-materialization — fixture ${fixtureDir}/.weave/config.weave not found`,
    );
    return 1;
  }

  // The embedded host reads `location.directory` from `process.cwd()` at
  // `OpenCode.create` time. Change into the fixture before creating.
  process.chdir(fixtureDir);

  const { OpenCode } = await import("@opencode-ai/sdk");
  const weavePluginModule = await import(
    "@weaveio/weave-adapter-opencode2/server"
  );
  const weavePlugin = weavePluginModule.default;
  const WEAVE_OWNERSHIP_MARKER =
    weavePluginModule.WEAVE_OWNERSHIP_MARKER as string;

  if (typeof WEAVE_OWNERSHIP_MARKER !== "string" || !WEAVE_OWNERSHIP_MARKER) {
    console.error(
      "FAIL: agent-materialization — WEAVE_OWNERSHIP_MARKER not exported from '@weaveio/weave-adapter-opencode2/server'",
    );
    return 1;
  }

  const host = await OpenCode.create({ plugins: [weavePlugin] });
  try {
    await host.plugin.awaitActivation();

    // A4 finding: `agent.list()` returns `{ location, data }`. Unwrap `.data`.
    const envelope = await host.agent.list();
    const data =
      (
        envelope as unknown as {
          data?: Array<{ name?: string; description?: string }>;
        }
      ).data ?? [];

    if (data.length === 0) {
      console.error(
        "FAIL: agent-materialization — host.agent.list() returned empty data",
      );
      return 1;
    }

    const loom = data.find((entry) => entry.name === "loom");
    if (!loom) {
      console.error(
        `FAIL: agent-materialization — no agent named "loom" found; got: ${data
          .map((e) => e.name)
          .join(", ")}`,
      );
      return 1;
    }

    const description = loom.description ?? "";
    if (!description.startsWith(WEAVE_OWNERSHIP_MARKER)) {
      console.error(
        `FAIL: agent-materialization — loom description does not start with WEAVE_OWNERSHIP_MARKER; got: ${JSON.stringify(description)}`,
      );
      return 1;
    }

    console.log(
      `OK: agent-materialization — host.agent.list() contains ${data.length} agent(s); "loom" is Weave-owned`,
    );
    return 0;
  } finally {
    await host.close();
  }
}

/**
 * Layer 6 — Real-CLI Agent Materialization.
 *
 * Closes the seam left open by layer 4 (which proved the CLI ran the
 * plugin's `setup()`/cleanup via marker files, but never queried the CLI's
 * own view of agents). Layer 5 proved the invariant through the *embedded*
 * `OpenCode.create({ plugins })` path; layer 6 proves it through the *real*
 * `opencode2` CLI, using the exact `ctx` the CLI delivered to the plugin
 * subprocess.
 *
 * Mechanism: the layer-6 fixture's `plugin-wrapper/server.ts` runs the real
 * Weave adapter's `setup(ctx)` first (materializing agents via
 * `ctx.agent.transform`), then calls `ctx.agent.list()`, unwraps the A4
 * `{ location, data }` envelope, and writes the observed agents to
 * `agent-list.marker.json`. This function reads that marker and asserts:
 *
 *   1. `setup.marker` and `cleanup.marker` exist (CLI ran the real plugin
 *      lifecycle — same invariant as layer 4).
 *   2. `agent-list.marker.json.error` is null (the ctx.agent.list RPC
 *      call inside the CLI's plugin subprocess did not throw).
 *   3. `agent-list.marker.json.agents` contains a `loom` entry whose
 *      description starts with the V2-package-local
 *      `WEAVE_OWNERSHIP_MARKER`.
 *
 * The trigger is the same one layer 4 uses (`opencode2 run hi --standalone
 * --print-logs`) — that invocation is the harness's single sanctioned
 * exception documented in `run.sh` and in layer 4's docstring. No
 * assertion below depends on the model's response.
 */
async function runRealCliMaterialization(): Promise<number> {
  const fixtureDir =
    process.env.FIXTURE_DIR ?? `${process.cwd()}/verify/fixtures-layer6`;
  const markerDir =
    process.env.WEAVE_VERIFY_MARKER_DIR ?? "/tmp/weave-verify-markers-layer6";

  // Ensure the marker directory exists before the CLI's plugin subprocess
  // tries to write into it. `Bun.write` creates missing parents.
  await Bun.write(`${markerDir}/.keep`, "");

  // Fixture sanity check — the real V2 loader silently drops entries that
  // resolve to a file (A2), so a broken fixture would fail with no CLI
  // error, only a missing setup.marker. Fail loudly here instead.
  const configExists = await Bun.file(
    `${fixtureDir}/.weave/config.weave`,
  ).exists();
  const opencodeJsoncExists = await Bun.file(
    `${fixtureDir}/opencode.jsonc`,
  ).exists();
  if (!configExists || !opencodeJsoncExists) {
    console.error(
      `FAIL: real-cli-materialization — fixture ${fixtureDir} missing .weave/config.weave or opencode.jsonc`,
    );
    return 1;
  }

  const { WEAVE_OWNERSHIP_MARKER } = (await import(
    "@weaveio/weave-adapter-opencode2/server"
  )) as { WEAVE_OWNERSHIP_MARKER?: string };
  if (typeof WEAVE_OWNERSHIP_MARKER !== "string" || !WEAVE_OWNERSHIP_MARKER) {
    console.error(
      "FAIL: real-cli-materialization — WEAVE_OWNERSHIP_MARKER not exported from '@weaveio/weave-adapter-opencode2/server'",
    );
    return 1;
  }

  // Same trigger + shell-cd rationale as layer 4 — see the comments in
  // runRealLoader() above. `--standalone` resolves to the free
  // `muse-spark-1.3-contributor-free` model; no credentials required.
  const proc = Bun.spawn({
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
  if (proc.exitCode === null) proc.kill();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  console.log(`${stdout}\n${stderr}`);

  const combined = `${stdout}\n${stderr}`;
  if (/@weaveio\/weave-adapter-opencode(?!2)/.test(combined)) {
    console.error(
      "FAIL: real-cli-materialization — output references the V1 adapter package",
    );
    return 1;
  }

  const setupInvoked = await Bun.file(`${markerDir}/setup.marker`).exists();
  const cleanupInvoked = await Bun.file(`${markerDir}/cleanup.marker`).exists();
  if (!setupInvoked) {
    console.error(
      "FAIL: real-cli-materialization — setup.marker not found; plugin setup() did not run",
    );
    return 1;
  }
  if (!cleanupInvoked) {
    console.error(
      "FAIL: real-cli-materialization — cleanup.marker not found; plugin cleanup did not run",
    );
    return 1;
  }

  const listMarkerPath = `${markerDir}/agent-list.marker.json`;
  const listMarker = Bun.file(listMarkerPath);
  if (!(await listMarker.exists())) {
    console.error(
      `FAIL: real-cli-materialization — ${listMarkerPath} not found; plugin-wrapper did not write ctx.agent.list() result`,
    );
    return 1;
  }

  type ListMarker = {
    error: string | null;
    count: number;
    agents: Array<{ name: string | null; description: string | null }>;
  };
  const parsed = (await listMarker.json()) as ListMarker;

  if (parsed.error !== null) {
    console.error(
      `FAIL: real-cli-materialization — ctx.agent.list() failed inside CLI plugin subprocess: ${parsed.error}`,
    );
    return 1;
  }
  if (parsed.count === 0) {
    console.error(
      "FAIL: real-cli-materialization — ctx.agent.list() returned empty data inside CLI plugin subprocess",
    );
    return 1;
  }

  const loom = parsed.agents.find((a) => a.name === "loom");
  if (!loom) {
    console.error(
      `FAIL: real-cli-materialization — no agent named "loom" observed via CLI ctx.agent.list(); got: ${parsed.agents
        .map((a) => a.name)
        .join(", ")}`,
    );
    return 1;
  }

  const description = loom.description ?? "";
  if (!description.startsWith(WEAVE_OWNERSHIP_MARKER)) {
    console.error(
      `FAIL: real-cli-materialization — loom description observed via CLI ctx.agent.list() does not start with WEAVE_OWNERSHIP_MARKER; got: ${JSON.stringify(description)}`,
    );
    return 1;
  }

  // Best-effort: surface the location.directory the CLI's plugin subprocess
  // was handed, purely for the learnings writeup. Not asserted.
  const locationMarker = Bun.file(`${markerDir}/location.marker.json`);
  if (await locationMarker.exists()) {
    const loc = (await locationMarker.json()) as { directory: string | null };
    console.log(
      `INFO: real-cli-materialization — ctx.location.directory inside CLI plugin subprocess = ${JSON.stringify(loc.directory)}`,
    );
  }

  console.log(
    `OK: real-cli-materialization — CLI's own ctx.agent.list() reports ${parsed.count} agent(s); "loom" is Weave-owned`,
  );
  return 0;
}

async function main(): Promise<number> {
  if (mode === "embedded") return runEmbedded();
  if (mode === "real-loader") return runRealLoader();
  if (mode === "agent-materialization") return runAgentMaterialization();
  if (mode === "real-cli-materialization") return runRealCliMaterialization();
  console.error(
    `Unknown mode "${mode}" — expected "embedded", "real-loader", "agent-materialization", or "real-cli-materialization"`,
  );
  return 1;
}

const code = await main();
process.exit(code);
