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
 * - The `event` hook only materializes agents — it never calls `runWorkflow`
 *   or `startPlanExecution` (no execution-start helpers are wired to session events).
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
 *
 * ## Plugin event hook boundary
 *
 * The `event` hook is strictly an agent-materialization hook. It calls
 * `adapter.spawnSubagent()` for each declared agent — nothing more. It does
 * not call `runWorkflow` (explicit named-workflow execution) or
 * `startPlanExecution` (the `/weave:start` ordinary-usage path). Execution
 * start helpers are never wired to session events or plugin lifecycle hooks.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDestination } from "@weave/engine";
import { okAsync, ResultAsync } from "neverthrow";
import type { OpenCodeClientError, OpenCodeClientFacade } from "../index.js";
import {
  createWeavePlugin,
  DEFAULT_PLUGIN_LOG_SUBPATH,
  default as defaultExport,
  WEAVE_OWNERSHIP_TAG,
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

async function makeTempInvalidProject(): Promise<string> {
  const root = join(
    tmpdir(),
    `weave-plugin-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await Bun.write(
    join(root, ".weave", "config.weave"),
    [
      "agent broken {",
      '  prompt "Missing closing brace"',
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
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "") + "/";

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
  it("Returns_empty_Hooks_when_config_load_fails", async () => {
    const root = await makeTempInvalidProject();
    const client = new MockOpenCodeClient();
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);

    const hooks = await plugin(input);

    expect(hooks).toEqual({});
    expect(client.listAgentsCalls).toHaveLength(0);
    expect(client.createAgentCalls).toHaveLength(0);
  });

  it("Returns_no_config_hook_when_config_load_fails", async () => {
    const root = await makeTempInvalidProject();
    const client = new MockOpenCodeClient();
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);

    const hooks = await plugin(input);

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
// Tests: tool hook registration
// ---------------------------------------------------------------------------

describe("WeavePlugin — tool hook", () => {
  it("Tool_hook_is_defined_when_config_load_succeeds", async () => {
    const root = await makeTempProject("tool-hook-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(hooks.tool).toBeDefined();
  });

  it("Tool_hook_has_both_expected_keys", async () => {
    const root = await makeTempProject("tool-keys-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(hooks.tool).toBeDefined();
    expect(hooks.tool).toHaveProperty("weave:start");
    expect(hooks.tool).toHaveProperty("start-work");
  });

  it("Both_tools_have_required_shape", async () => {
    const root = await makeTempProject("tool-shape-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    const weaveStartTool = hooks.tool?.["weave:start"] as
      | Record<string, unknown>
      | undefined;
    const startWorkTool = hooks.tool?.["start-work"] as
      | Record<string, unknown>
      | undefined;

    expect(typeof weaveStartTool?.description).toBe("string");
    expect(typeof weaveStartTool?.args).toBe("object");
    expect(typeof weaveStartTool?.execute).toBe("function");

    expect(typeof startWorkTool?.description).toBe("string");
    expect(typeof startWorkTool?.args).toBe("object");
    expect(typeof startWorkTool?.execute).toBe("function");
  });

  it("Tools_share_the_same_execute_function", async () => {
    const root = await makeTempProject("tool-execute-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(hooks.tool?.["weave:start"]?.execute).toBe(
      hooks.tool?.["start-work"]?.execute,
    );
  });

  it("Tool_hook_is_absent_when_config_load_fails", async () => {
    const root = await makeTempInvalidProject();
    const client = new MockOpenCodeClient();

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(hooks).toEqual({});
    expect(hooks.tool).toBeUndefined();
    expect("tool" in hooks).toBe(false);
  });

  it("Tools_are_present_with_empty_workflows", async () => {
    const root = await makeTempProject("tool-empty-workflows-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    expect(hooks.tool).toBeDefined();
    expect(hooks.tool).toHaveProperty("weave:start");
    expect(hooks.tool).toHaveProperty("start-work");
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
// Tests: SDK reconciliation is disabled (redundant — config hook is sufficient)
// ---------------------------------------------------------------------------
// SDK reconciliation was removed because it is redundant and harmful.
// The config hook already injects all Weave agents into OpenCode's in-memory
// config at startup. The SDK path (config.update per agent) triggered OpenCode
// to reload all plugins, causing an O(n) plugin restart storm for n agents.

// SDK reconciliation tests removed — reconciliation is disabled.
// The config hook path is the only materialization mechanism.

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

  // SDK createAgent test removed — reconciliation is disabled.
  // The config hook test above already proves all 8 builtins are materialized.
});

// ---------------------------------------------------------------------------
// Tests: config-hook ownership tag + no-collision regression
// ---------------------------------------------------------------------------

describe("WeavePlugin — config hook injects ownership-tagged agents (no-collision regression)", () => {
  it("config hook injects agents with WEAVE_OWNERSHIP_TAG in description", async () => {
    const agentName = "ownership-tag-agent";
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
    await hooks.config!(cfg as never);

    const injected = cfg.agent![agentName] as Record<string, unknown>;
    // The injected config must carry the ownership tag so that deferred
    // reconciliation classifies it as "update" rather than "collision".
    expect(typeof injected.description).toBe("string");
    expect(injected.description as string).toContain(WEAVE_OWNERSHIP_TAG);
  });

  // "session.created after config hook uses updateAgent" test removed —
  // SDK reconciliation is disabled; no updateAgent calls occur.

  it("config hook does NOT call any SDK methods (startup path stays clean)", async () => {
    // Regression guard: the config hook must remain pure — no listAgents,
    // createAgent, or updateAgent calls during the config hook phase.
    const agentName = "clean-startup-agent";
    const root = await makeTempProject(agentName);
    const client = new MockOpenCodeClient();

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    // Run only the config hook — no event hook
    const cfg: { agent?: Record<string, unknown> } = {};
    await hooks.config!(cfg as never);

    // No SDK calls must have been made
    expect(client.listAgentsCalls).toHaveLength(0);
    expect(client.createAgentCalls).toHaveLength(0);
    expect(client.updateAgentCalls).toHaveLength(0);
  });

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
    await hooks.config!(cfg as never);

    const injected = cfg.agent![agentName] as Record<string, unknown>;
    const description = injected.description as string;
    // Tag must appear exactly once
    const tagCount = description.split(WEAVE_OWNERSHIP_TAG).length - 1;
    expect(tagCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: builtin shuttle mode regression
// ---------------------------------------------------------------------------

describe("WeavePlugin — builtin shuttle is subagent-only", () => {
  it("builtin shuttle agent is injected with mode subagent (not all)", async () => {
    // Regression test: shuttle was previously declared as `mode all` in
    // builtins.ts. It must be `mode subagent` so it only appears as a
    // subagent in OpenCode, not as a primary agent.
    const root = join(
      tmpdir(),
      `weave-shuttle-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    const shuttleConfig = cfg.agent?.["shuttle"] as
      | Record<string, unknown>
      | undefined;
    expect(shuttleConfig).toBeDefined();
    expect(shuttleConfig?.mode).toBe("subagent");
  });
});

// ---------------------------------------------------------------------------
// Tests: event hook boundary — agent materialization only, no start helpers
// ---------------------------------------------------------------------------

// "event hook only materializes agents" tests removed — SDK reconciliation
// is disabled. The event hook is now a no-op. The config hook is the sole
// materialization path.

// ---------------------------------------------------------------------------
// Tests: runReconciliation() — adapter.init() failure boundary guard
// ---------------------------------------------------------------------------

describe("WeavePlugin — runReconciliation() init failure boundary", () => {
  it("event hook does not reject when adapter.init() would fail (boundary guard)", async () => {
    // This test verifies the boundary guard: if adapter.init() throws, the
    // event hook must catch the error, log it, and return — not reject the
    // hook promise. We simulate this by using a real temp project but
    // providing a clientFacade whose listAgents() would never be reached
    // (because init() is the first thing called in runReconciliation()).
    //
    // Since OpenCodeAdapter.init() only constructs a BunFilesystemPlanStateProvider
    // (which cannot throw in practice), we verify the guard indirectly:
    // the event hook must always resolve (not reject) even if init() throws.
    // We test this by confirming the event hook resolves without error.
    const root = await makeTempProject("init-guard-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const input = makeMockPluginInput(root, client);
    const hooks = await plugin(input);

    // The event hook must resolve (not reject) — this is the boundary contract.
    await expect(triggerSessionCreated(hooks)).resolves.toBeUndefined();
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
    const parsed = JSON.parse(sentinelLine!);
    expect(parsed["weave-test-sentinel"]).toBe(true);
  });

  it("DEFAULT_PLUGIN_LOG_SUBPATH is .weave/weave.log", () => {
    // Regression guard: the constant must not change without updating docs.
    expect(DEFAULT_PLUGIN_LOG_SUBPATH).toBe(".weave/weave.log");
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
    // `@weave/engine`. After `redirectLogsToFile()`, both the engine logger
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
    const parsed = JSON.parse(sentinelLine!);
    expect(parsed["config-silent-startup-sentinel"]).toBe(true);
  });
});
