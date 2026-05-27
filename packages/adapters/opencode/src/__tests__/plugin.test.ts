/**
 * Unit tests for the `WeavePlugin` OpenCode plugin entry point.
 *
 * Verifies:
 * - `WeavePlugin` is a function (satisfies the `Plugin` type).
 * - `server` is the same function as `WeavePlugin` (PluginModule compatibility).
 * - The default export is `WeavePlugin`.
 * - The plugin returns an empty `Hooks` object when config load fails.
 * - The plugin returns a `Hooks` object with a `config` hook on success.
 * - The `config` hook injects translated agent configs into `cfg.agent`.
 * - The plugin does NOT call SDK eagerly — SDK reconciliation is deferred.
 * - The `event` hook triggers SDK reconciliation on `session.created`.
 * - The `event` hook ignores non-`session.created` events.
 * - The `event` hook runs reconciliation exactly once (idempotent).
 * - The `debug config` path: `hooks.config` works without any SDK calls.
 * - The plugin continues materializing remaining agents when one fails.
 *
 * All tests use a mock `PluginInput` and a project-only file reader to avoid
 * picking up the developer's global ~/.weave/config.weave. The full
 * `loadConfig → materializeAgents → spawnSubagent` path is exercised at the
 * package level without depending on the test environment's global config.
 *
 * ## Deferred SDK reconciliation
 *
 * The plugin now returns `Hooks` immediately after config loading and agent
 * translation (pure computation). SDK-backed reconciliation (`adapter.init()`
 * + `spawnSubagent()`) is deferred to the `event` hook, which fires on the
 * first `session.created` event. This ensures `opencode debug config` never
 * blocks on SDK/DB calls.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync, ResultAsync } from "neverthrow";
import type { OpenCodeClientError, OpenCodeClientFacade } from "../index.js";
import {
  createWeavePlugin,
  default as defaultExport,
  WeavePlugin,
  WeavePluginServer,
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
  return {
    exists: async (path: string): Promise<boolean> => {
      if (!path.startsWith(root)) return false;
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

/**
 * Helper: simulate a `session.created` event via the `event` hook.
 */
async function triggerSessionCreated(
  hooks: Awaited<ReturnType<typeof WeavePlugin>>,
): Promise<void> {
  if (typeof hooks.event !== "function") return;
  await hooks.event({
    event: {
      type: "session.created",
      properties: { info: {} as never },
    },
  });
}

/**
 * Helper: simulate a non-`session.created` event via the `event` hook.
 */
async function triggerOtherEvent(
  hooks: Awaited<ReturnType<typeof WeavePlugin>>,
  type: string,
): Promise<void> {
  if (typeof hooks.event !== "function") return;
  await hooks.event({
    event: { type, properties: {} } as never,
  });
}

// ---------------------------------------------------------------------------
// Tests: module shape
// ---------------------------------------------------------------------------

describe("WeavePlugin — module shape", () => {
  it("WeavePlugin is a function", () => {
    expect(typeof WeavePlugin).toBe("function");
  });

  it("server export (WeavePluginServer) is the same function as WeavePlugin", () => {
    expect(WeavePluginServer).toBe(WeavePlugin);
  });

  it("default export is WeavePlugin", () => {
    expect(defaultExport).toBe(WeavePlugin);
  });

  it("WeavePlugin accepts at least one argument (PluginInput)", () => {
    // Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
    expect(WeavePlugin.length).toBeGreaterThanOrEqual(1);
  });

  it("createWeavePlugin is a function", () => {
    expect(typeof createWeavePlugin).toBe("function");
  });

  it("createWeavePlugin() returns a Plugin function", () => {
    const plugin = createWeavePlugin();
    expect(typeof plugin).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests: PluginModule compatibility
// ---------------------------------------------------------------------------

describe("WeavePlugin — PluginModule compatibility", () => {
  it("can be used as PluginModule.server", () => {
    // PluginModule shape: { id?: string; server: Plugin; tui?: never }
    const pluginModule = { server: WeavePlugin };
    expect(typeof pluginModule.server).toBe("function");
  });

  it("WeavePluginServer satisfies PluginModule.server shape", () => {
    const pluginModule = { server: WeavePluginServer };
    expect(typeof pluginModule.server).toBe("function");
    expect(pluginModule.server).toBe(WeavePlugin);
  });
});

// ---------------------------------------------------------------------------
// Tests: config load failure path
// ---------------------------------------------------------------------------

describe("WeavePlugin — config load failure", () => {
  it("returns empty Hooks when directory has no .weave/config.weave", async () => {
    // Use a non-existent directory — loadConfig will fail to find any config
    const client = new MockOpenCodeClient();
    const input = makeMockPluginInput("/nonexistent-weave-test-dir", client);

    const hooks = await WeavePlugin(input);

    // Plugin must not throw — it returns {} and logs the error
    expect(hooks).toEqual({});
    // No SDK calls should have been made
    expect(client.listAgentsCalls).toHaveLength(0);
    expect(client.createAgentCalls).toHaveLength(0);
  });

  it("returns no config hook when config load fails", async () => {
    const client = new MockOpenCodeClient();
    const input = makeMockPluginInput(
      "/nonexistent-weave-test-dir-fail",
      client,
    );

    const hooks = await WeavePlugin(input);

    // On failure, no config hook is registered
    expect(hooks.config).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: successful materialization path — config hook
// ---------------------------------------------------------------------------

describe("WeavePlugin — config hook", () => {
  it("returns a Hooks object with a config hook on success", async () => {
    const root = await makeTempProject("config-hook-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    // Use projectOnlyReader + clientFacade to avoid global config interference
    // and to avoid needing a real SDK client.
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(typeof hooks).toBe("object");
    // config hook must be present and be a function
    expect(typeof hooks.config).toBe("function");
  });

  it("config hook injects translated agent into cfg.agent", async () => {
    const agentName = "inject-test-agent";
    const root = await makeTempProject(agentName);
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(typeof hooks.config).toBe("function");

    // Simulate OpenCode calling the config hook with an empty config
    const cfg: { agent?: Record<string, unknown> } = {};
    await hooks.config!(cfg as never);

    // The agent should now be present in cfg.agent
    expect(cfg.agent).toBeDefined();
    expect(cfg.agent![agentName]).toBeDefined();

    const injected = cfg.agent![agentName] as Record<string, unknown>;
    // The injected config should have at minimum a prompt and mode
    expect(typeof injected.prompt).toBe("string");
    expect(injected.mode).toBe("subagent");
  });

  it("config hook initialises cfg.agent when it is undefined", async () => {
    const root = await makeTempProject("init-agent-field");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(typeof hooks.config).toBe("function");

    // cfg.agent is explicitly undefined
    const cfg: { agent?: Record<string, unknown> } = { agent: undefined };
    await hooks.config!(cfg as never);

    expect(cfg.agent).toBeDefined();
    expect(typeof cfg.agent).toBe("object");
  });

  it("config hook preserves existing cfg.agent entries", async () => {
    const root = await makeTempProject("preserve-test-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(typeof hooks.config).toBe("function");

    // Pre-populate cfg.agent with an existing entry
    const existingAgent = {
      prompt: "I am an existing agent.",
      mode: "primary",
    };
    const cfg: { agent?: Record<string, unknown> } = {
      agent: { "existing-agent": existingAgent },
    };
    await hooks.config!(cfg as never);

    // Existing entry must be preserved
    expect(cfg.agent!["existing-agent"]).toBe(existingAgent);
    // Weave agent must also be present
    expect(cfg.agent!["preserve-test-agent"]).toBeDefined();
  });
});

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
    await hooks.config!(cfg as never);

    // Agent must be injected via config hook
    expect(cfg.agent![agentName]).toBeDefined();

    // No SDK calls should have been made — config hook is pure
    expect(client.listAgentsCalls).toHaveLength(0);
    expect(client.createAgentCalls).toHaveLength(0);
    expect(client.updateAgentCalls).toHaveLength(0);
  });

  it("returns Hooks immediately — plugin function resolves without SDK blocking", async () => {
    const root = await makeTempProject("immediate-return-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);

    // The plugin must resolve to a Hooks object without blocking on SDK
    const hooks = await plugin(input);

    expect(typeof hooks).toBe("object");
    expect(typeof hooks.config).toBe("function");
    // event hook must be present for deferred reconciliation
    expect(typeof hooks.event).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests: deferred SDK reconciliation — event hook triggers reconciliation
// ---------------------------------------------------------------------------

describe("WeavePlugin — event hook triggers deferred SDK reconciliation", () => {
  it("event hook is present on successful plugin init", async () => {
    const root = await makeTempProject("event-hook-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(typeof hooks.event).toBe("function");
  });

  it("session.created event triggers SDK reconciliation (createAgent called)", async () => {
    const root = await makeTempProject("sdk-reconcile-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    // Before session.created: no SDK calls
    expect(client.createAgentCalls).toHaveLength(0);

    // Trigger session.created
    await triggerSessionCreated(hooks);

    // After session.created: SDK reconciliation must have run
    expect(client.createAgentCalls.length).toBeGreaterThan(0);
    const names = client.createAgentCalls.map((c) => c.name);
    expect(names).toContain("sdk-reconcile-agent");
  });

  it("non-session.created events do NOT trigger SDK reconciliation", async () => {
    const root = await makeTempProject("no-reconcile-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    // Trigger various non-session.created events
    await triggerOtherEvent(hooks, "session.updated");
    await triggerOtherEvent(hooks, "session.deleted");
    await triggerOtherEvent(hooks, "message.updated");
    await triggerOtherEvent(hooks, "server.connected");

    // No SDK calls should have been made
    expect(client.listAgentsCalls).toHaveLength(0);
    expect(client.createAgentCalls).toHaveLength(0);
  });

  it("reconciliation runs exactly once even if session.created fires multiple times", async () => {
    const root = await makeTempProject("idempotent-reconcile-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    // Trigger session.created once and record the SDK call counts
    await triggerSessionCreated(hooks);
    const listCallsAfterFirst = client.listAgentsCalls.length;
    const createCallsAfterFirst = client.createAgentCalls.length;

    // Trigger session.created two more times — reconciliation must NOT repeat
    await triggerSessionCreated(hooks);
    await triggerSessionCreated(hooks);

    // SDK call counts must not have grown after the first reconciliation
    expect(client.listAgentsCalls).toHaveLength(listCallsAfterFirst);
    expect(client.createAgentCalls).toHaveLength(createCallsAfterFirst);
    // At least one agent was created in the first reconciliation
    expect(createCallsAfterFirst).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: successful materialization path — SDK reconciliation (via event hook)
// ---------------------------------------------------------------------------

describe("WeavePlugin — SDK reconciliation (via event hook)", () => {
  it("calls spawnSubagent (createAgent) for each declared agent after session.created", async () => {
    const root = await makeTempProject("sdk-reconcile-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    // Pass clientFacade so the plugin uses the mock directly instead of
    // wrapping input.client in SdkOpenCodeClient (which needs a real SDK).
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    // Trigger the deferred reconciliation
    await triggerSessionCreated(hooks);

    // The SDK client should have been called to create the agent
    expect(client.createAgentCalls.length).toBeGreaterThan(0);
    const names = client.createAgentCalls.map((c) => c.name);
    expect(names).toContain("sdk-reconcile-agent");
  });

  it("plugin returns a Promise<Hooks> (thenable)", async () => {
    const client = new MockOpenCodeClient();
    const input = makeMockPluginInput("/nonexistent-weave-test-dir-2", client);

    const result = WeavePlugin(input);
    expect(result).toBeInstanceOf(Promise);
    const hooks = await result;
    expect(typeof hooks).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// Tests: bundle-safe builtin prompt resolution (regression for import.meta.dir)
// ---------------------------------------------------------------------------

describe("WeavePlugin — bundle-safe builtin prompt resolution", () => {
  /**
   * Regression test for the `import.meta.dir` bundling problem.
   *
   * **Root cause**: When `@weave/config` is bundled into
   * `@weave/adapter-opencode/dist/plugin.js`, `import.meta.dir` in
   * `loader.ts` resolves to the adapter's dist directory instead of
   * `packages/config/`. This caused all 8 builtin prompt-file-backed agents
   * to fail with `DescriptorCompositionFailure` because the resolved path
   * pointed to a non-existent `packages/adapters/opencode/prompts/` directory.
   *
   * **Fix**: `loader.ts` now calls `inlineBuiltinPrompts()` instead of
   * `resolvePromptPaths()` for the builtin layer. `inlineBuiltinPrompts()`
   * replaces `prompt_file` references with embedded inline content from
   * `BUILTIN_PROMPT_CONTENTS` (text-imported at build time in `builtins.ts`).
   * This eliminates the runtime filesystem dependency for builtins entirely.
   *
   * **What this test asserts**: When the plugin runs with only builtin agents
   * (no project config), all 8 builtins are materialized and the config hook
   * injects all 8 into `cfg.agent`. Zero `DescriptorCompositionFailure` errors.
   */
  it("all 8 builtin agents materialize when project config is empty (no DescriptorCompositionFailure)", async () => {
    // Create a project with an empty config — only builtins should be present.
    const root = join(
      tmpdir(),
      `weave-builtin-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    const hooks = await plugin(input);

    // Plugin must return a config hook — if builtins fail to compose, the
    // translatedMap is empty and no config hook is returned.
    expect(typeof hooks.config).toBe("function");

    // Invoke the config hook and collect injected agents.
    const cfg: { agent?: Record<string, unknown> } = {};
    await hooks.config!(cfg as never);

    const injectedNames = Object.keys(cfg.agent ?? {}).sort();

    // All 8 builtins must be present.
    const EXPECTED_BUILTINS = [
      "loom",
      "pattern",
      "shuttle",
      "spindle",
      "tapestry",
      "thread",
      "warp",
      "weft",
    ].sort();

    expect(injectedNames).toEqual(EXPECTED_BUILTINS);
  });

  it("builtin agents have non-empty composed prompts (prompt content was embedded)", async () => {
    const root = join(
      tmpdir(),
      `weave-builtin-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    const hooks = await plugin(input);

    expect(typeof hooks.config).toBe("function");

    const cfg: { agent?: Record<string, unknown> } = {};
    await hooks.config!(cfg as never);

    // Every injected builtin agent must have a non-empty prompt string.
    for (const [name, agentConfig] of Object.entries(cfg.agent ?? {})) {
      const config = agentConfig as Record<string, unknown>;
      expect(
        typeof config.prompt,
        `builtin agent "${name}" must have a string prompt`,
      ).toBe("string");
      expect(
        (config.prompt as string).length,
        `builtin agent "${name}" must have a non-empty prompt`,
      ).toBeGreaterThan(10);
    }
  });

  it("SDK createAgent is called for all 8 builtins after session.created (no silent failures)", async () => {
    const root = join(
      tmpdir(),
      `weave-builtin-sdk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    const hooks = await plugin(input);

    // Trigger deferred reconciliation via session.created
    await triggerSessionCreated(hooks);

    // All 8 builtins must have been passed to createAgent.
    // Before the fix, only 0 builtins were created (all failed with
    // DescriptorCompositionFailure due to the wrong prompt file path).
    const createdNames = client.createAgentCalls.map((c) => c.name).sort();
    const EXPECTED_BUILTINS = [
      "loom",
      "pattern",
      "shuttle",
      "spindle",
      "tapestry",
      "thread",
      "warp",
      "weft",
    ].sort();

    expect(createdNames).toEqual(EXPECTED_BUILTINS);
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

  it("Plugin type is compatible: WeavePlugin returns Promise<Hooks>", async () => {
    // Verify the runtime shape matches the Plugin type contract:
    // Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
    const client = new MockOpenCodeClient();
    const input = makeMockPluginInput("/nonexistent-weave-test-dir-3", client);

    const result = WeavePlugin(input);
    expect(result).toBeInstanceOf(Promise);

    const hooks = await result;
    // Hooks is an object — all fields are optional
    expect(typeof hooks).toBe("object");
    expect(hooks).not.toBeNull();
  });
});
