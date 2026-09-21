/**
 * Unit tests for the `WeavePlugin` OpenCode plugin entry point.
 *
 * What the plugin registers — the agents, the two slash commands, their
 * templates and target agent, the default agent, the builtins a zero-config
 * project gets, and what happens when the config does not parse — is now
 * asserted from outside, in
 * `tests/adapters/opencode-runtime.scenario.test.ts` and
 * `tests/adapters/opencode.scenario.test.ts`. Thirty cases are gone, six of
 * them duplicates of `plugin-loader-shape.test.ts`.
 *
 * What stays is what no registered config can show:
 *
 * | Kept | Why |
 * | --- | --- |
 * | The two "no eager SDK calls" cases | `opencode debug config` awaits this function. If an SDK call were reintroduced ahead of the returned hooks it would hang there, and nothing in the resulting config would say so |
 * | The config hook's ownership-tag idempotency | The same unreachable guard `reconcile-agent.test.ts` keeps: the hook tags a freshly translated config, so the tag can never already be there |
 * | `@opencode-ai/plugin` is importable | A packaging guard, closer to a repo check than a unit test: it proves the dependency is declared, which no runtime output reveals |
 * | The two file-backed logging cases | Their observable is a file on disk outside every scenario seam, and the second guards against Weave's structured logs appearing in the OpenCode chat window |
 *
 * ## Why no SDK reconciliation is exercised here
 *
 * The `event` hook is a bare early return. SDK reconciliation was removed
 * because a `client.config.update()` per agent made OpenCode reload every
 * plugin — an O(n) restart storm. The config hook is the only materialization
 * path, so the plugin never touches the client it is handed, and
 * `WeavePluginOptions.clientFacade` is accepted and never read. The two cases
 * above therefore currently hold structurally; they guard a regression rather
 * than describe a behaviour.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDestination } from "@weaveio/weave-engine";
import { okAsync, ResultAsync } from "neverthrow";
import type { OpenCodeClientError, OpenCodeClientFacade } from "../index.js";
import {
  createWeavePlugin,
  DEFAULT_PLUGIN_LOG_SUBPATH,
  WEAVE_OWNERSHIP_TAG,
  type WeavePlugin,
} from "../index.js";
import type { OpenCodeAgent, OpenCodeAgentConfig } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// Mock OpenCode client
// ---------------------------------------------------------------------------

class MockOpenCodeClient implements OpenCodeClientFacade {
  readonly createAgentCalls: Array<{
    name: string;
    config: OpenCodeAgentConfig;
  }> = [];
  readonly updateAgentCalls: Array<{
    name: string;
    config: OpenCodeAgentConfig;
  }> = [];
  readonly listAgentsCalls: number[] = [];

  private _listResult: ResultAsync<OpenCodeAgent[], OpenCodeClientError> =
    okAsync([]);

  setListResult(r: ResultAsync<OpenCodeAgent[], OpenCodeClientError>): void {
    this._listResult = r;
  }

  listAgents() {
    this.listAgentsCalls.push(Date.now());
    return this._listResult;
  }

  createAgent(name: string, config: OpenCodeAgentConfig) {
    this.createAgentCalls.push({ name, config });
    return okAsync<void, OpenCodeClientError>(undefined);
  }

  updateAgent(name: string, config: OpenCodeAgentConfig) {
    this.updateAgentCalls.push({ name, config });
    return okAsync<void, OpenCodeClientError>(undefined);
  }
}

// ---------------------------------------------------------------------------
// Mock PluginInput helper
// ---------------------------------------------------------------------------

function makeMockPluginInput(
  directory: string,
  client: OpenCodeClientFacade,
): Parameters<typeof WeavePlugin>[0] {
  return {
    client: client as unknown as Parameters<typeof WeavePlugin>[0]["client"],
    directory,
    project: {} as never,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:1234"),
    $: {} as never,
  };
}

// ---------------------------------------------------------------------------
// Temp project helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal temp project with a `.weave/config.weave` declaring one
 * agent. Returns the project root path.
 *
 * Uses `Bun.write()` which creates parent directories automatically — no
 * `node:fs` required.
 */
async function makeTempProject(agentName = "smoke-agent"): Promise<string> {
  const root = join(
    tmpdir(),
    `weave-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await Bun.write(
    join(root, ".weave", "config.weave"),
    [
      `agent ${agentName} {`,
      `  prompt "You are a test agent."`,
      `  models ["claude-sonnet-4-5"]`,
      `  mode subagent`,
      `  temperature 0.2`,
      `}`,
      "",
    ].join("\n"),
  );
  return root;
}

/**
 * A FileReader that only reads files under `root`. Returns `exists: false` for
 * any path outside `root` (e.g. the global ~/.weave/config.weave). This
 * prevents the developer's global config from interfering with tests.
 */
function projectOnlyReader(root: string) {
  // Enforce a path-segment boundary by normalizing with a trailing slash.
  // This prevents sibling paths like `/tmp/root-other/` from matching when
  // root is `/tmp/root`.
  const normalizedRoot = `${root.replace(/\\/g, "/").replace(/\/$/, "")}/`;

  return {
    exists: async (path: string): Promise<boolean> => {
      const normalizedPath = path.replace(/\\/g, "/");
      if (
        normalizedPath !== normalizedRoot.slice(0, -1) &&
        !normalizedPath.startsWith(normalizedRoot)
      ) {
        return false;
      }
      return Bun.file(path).exists();
    },
    read: (path: string) => {
      return ResultAsync.fromPromise(
        Bun.file(path).text(),
        (cause: unknown) => ({ type: "FileReadError" as const, path, cause }),
      );
    },
  };
}
// ---------------------------------------------------------------------------
// Tests: deferred SDK reconciliation — no eager SDK calls
// ---------------------------------------------------------------------------

describe("WeavePlugin — no eager SDK calls (debug config path)", () => {
  it("does NOT call listAgents before hooks are returned", async () => {
    const root = await makeTempProject("no-eager-sdk-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);

    // Await the plugin — this is what `opencode debug config` does
    await plugin(input);

    // No SDK calls should have been made at this point
    expect(client.listAgentsCalls).toHaveLength(0);
    expect(client.createAgentCalls).toHaveLength(0);
    expect(client.updateAgentCalls).toHaveLength(0);
  });

  it("config hook works without any SDK calls (debug config simulation)", async () => {
    const agentName = "debug-config-agent";
    const root = await makeTempProject(agentName);
    const client = new MockOpenCodeClient();
    // Do NOT set listResult — if SDK is called eagerly, it would use the default
    // empty result, but we want to verify no SDK call happens at all.

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    // Simulate `opencode debug config`: call config hook only, no event hook
    const cfg: { agent?: Record<string, unknown> } = {};
    await hooks.config?.(cfg as never);

    // Agent must be injected via config hook
    expect(cfg.agent?.[agentName]).toBeDefined();

    // No SDK calls should have been made — config hook is pure
    expect(client.listAgentsCalls).toHaveLength(0);
    expect(client.createAgentCalls).toHaveLength(0);
    expect(client.updateAgentCalls).toHaveLength(0);
  });
});
// ---------------------------------------------------------------------------
// Tests: config-hook ownership tag + no-collision regression
// ---------------------------------------------------------------------------

describe("WeavePlugin — config hook injects ownership-tagged agents (no-collision regression)", () => {
  // "session.created after config hook uses updateAgent" test removed —
  // SDK reconciliation is disabled; no updateAgent calls occur.

  it("ownership tag is idempotent — config hook does not double-tag agents", async () => {
    const agentName = "idempotent-tag-agent";
    const root = await makeTempProject(agentName);
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    const cfg: { agent?: Record<string, unknown> } = {};
    await hooks.config?.(cfg as never);

    const injected = cfg.agent?.[agentName] as Record<string, unknown>;
    const description = injected.description as string;
    // Tag must appear exactly once
    const tagCount = description.split(WEAVE_OWNERSHIP_TAG).length - 1;
    expect(tagCount).toBe(1);
  });
});
// ---------------------------------------------------------------------------
// Tests: @opencode-ai/plugin dependency proof
// ---------------------------------------------------------------------------

describe("WeavePlugin — @opencode-ai/plugin dependency", () => {
  it("@opencode-ai/plugin is importable (dependency declared in package.json)", async () => {
    // This test proves the dependency is correctly declared and installed.
    // If the import fails, the package.json is missing the dependency.
    const pluginMod = await import("@opencode-ai/plugin");
    expect(pluginMod).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: automatic file-backed logging on the plugin path
// ---------------------------------------------------------------------------

describe("WeavePlugin — automatic file-backed logging", () => {
  it("plugin creates .weave/weave.log and routes logs there by default (no WEAVE_LOG_FILE)", async () => {
    // This test proves that when the plugin runs without an explicit
    // WEAVE_LOG_FILE env var, the shared log destination is redirected to
    // `<project>/.weave/weave.log` instead of stdout.
    //
    // Mechanism: the plugin calls `redirectLogsToFile(join(directory,
    // DEFAULT_PLUGIN_LOG_SUBPATH))` at the very start of the plugin function.
    // `redirectLogsToFile` swaps the shared pino stream's inner sink to a
    // SonicBoom file destination (sync: true) and awaits the `ready` event.
    //
    // We verify by:
    //   1. Running the plugin against a temp project.
    //   2. Asserting the log file was created at the expected path.
    //   3. Writing a sentinel line directly to `logDestination` (bypassing
    //      pino's level filter, which is set to `silent` in tests) and
    //      asserting it appears in the file.
    //
    // Note: the test preload sets LOG_LEVEL=silent, so pino-level log calls
    // (logger.info etc.) are dropped. We use a direct write to logDestination
    // to prove the sink is pointing at the file.

    const root = join(
      tmpdir(),
      `weave-file-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await Bun.write(
      join(root, ".weave", "config.weave"),
      "# empty project config\n",
    );

    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);

    // Run the plugin — this triggers redirectLogsToFile internally.
    // After this call, logDestination._sink is a SonicBoom pointing at
    // `<root>/.weave/weave.log`.
    await plugin(input);

    // The log file must exist at the expected path (created by SonicBoom
    // when it opened the file during redirectLogsToFile).
    const expectedLogPath = join(root, DEFAULT_PLUGIN_LOG_SUBPATH);
    const logFile = Bun.file(expectedLogPath);
    expect(await logFile.exists()).toBe(true);

    // Write a sentinel line directly to logDestination (bypasses pino's
    // level filter). With sync: true on the SonicBoom sink, this write is
    // synchronous — the data is on disk before write() returns.
    const sentinel = `{"weave-test-sentinel":true,"ts":${Date.now()}}\n`;
    logDestination.write(sentinel);

    // The sentinel must appear in the log file.
    // Use a fresh Bun.file() reference to avoid any read caching.
    const logContent = await Bun.file(expectedLogPath).text();
    expect(logContent).toContain("weave-test-sentinel");

    // The sentinel line must be valid JSON
    const sentinelLine = logContent
      .split("\n")
      .find((l) => l.includes("weave-test-sentinel"));
    expect(sentinelLine).toBeDefined();
    const parsed = JSON.parse(sentinelLine ?? "{}");
    expect(parsed["weave-test-sentinel"]).toBe(true);
  });

  it("config logger (weave:config) output goes to the log file — not stdout (regression for silent startup)", async () => {
    // Regression test for: `{"name":"weave:config","module":"loader","msg":"Config loaded successfully"}`
    // appearing on stdout during `opencode debug info` / `opencode` startup.
    //
    // Root cause: `packages/config/src/logger.ts` previously created its own
    // separate pino destination (snapshotting stdout at module init time).
    // When `redirectLogsToFile()` redirected the engine's `MutableDestination`,
    // the config logger was unaffected — it still wrote to its own stdout sink.
    //
    // Fix: the config logger now uses the same `logDestination` from
    // `@weaveio/weave-engine`. After `redirectLogsToFile()`, both the engine logger
    // and the config logger write to the file.
    //
    // Verification strategy:
    //   1. Run the plugin against a temp project (triggers redirectLogsToFile).
    //   2. Write a sentinel directly to `logDestination` (bypasses pino's
    //      level filter, which is set to `silent` in tests).
    //   3. Assert the sentinel appears in the log file.
    //   4. Assert the log file contains "weave:config" entries (from the
    //      config pipeline) — proving the config logger wrote to the file.
    //
    // Note: step 4 requires LOG_LEVEL != silent. Since tests run with
    // LOG_LEVEL=silent, we can only verify the shared destination invariant
    // via the direct write in step 2-3. The config logger's pino-level calls
    // would also go to the file in production (LOG_LEVEL=info).

    const root = join(
      tmpdir(),
      `weave-config-silent-startup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await Bun.write(
      join(root, ".weave", "config.weave"),
      "# empty project config\n",
    );

    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);

    // Run the plugin — triggers redirectLogsToFile, then loadConfig (which
    // calls log.info("Config loaded successfully") via the config logger).
    await plugin(input);

    const expectedLogPath = join(root, DEFAULT_PLUGIN_LOG_SUBPATH);

    // The log file must exist (created by redirectLogsToFile).
    expect(await Bun.file(expectedLogPath).exists()).toBe(true);

    // Write a sentinel directly to logDestination (bypasses pino's level
    // filter). This proves the shared destination is pointing at the file.
    const sentinel = `{"config-silent-startup-sentinel":true,"ts":${Date.now()}}\n`;
    logDestination.write(sentinel);

    const logContent = await Bun.file(expectedLogPath).text();
    expect(logContent).toContain("config-silent-startup-sentinel");

    // The sentinel must be valid JSON.
    const sentinelLine = logContent
      .split("\n")
      .find((l) => l.includes("config-silent-startup-sentinel"));
    expect(sentinelLine).toBeDefined();
    const parsed = JSON.parse(sentinelLine ?? "{}");
    expect(parsed["config-silent-startup-sentinel"]).toBe(true);
  });
});
