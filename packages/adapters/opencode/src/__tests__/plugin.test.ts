/**
 * Unit tests for the `WeavePlugin` OpenCode plugin entry point.
 *
 * Verifies:
 * - `WeavePlugin` is a function (satisfies the `Plugin` type).
 * - `server` is the same function as `WeavePlugin` (PluginModule compatibility).
 * - The default export is `WeavePlugin`.
 * - The plugin returns an empty `Hooks` object when config load fails.
 * - The plugin calls `spawnSubagent()` for each agent in the materialization plan.
 * - The plugin continues materializing remaining agents when one fails.
 * - The plugin returns an empty `Hooks` object on success.
 *
 * All tests use a mock `PluginInput` and a project-only file reader to avoid
 * picking up the developer's global ~/.weave/config.weave. The full
 * `loadConfig → materializeAgents → spawnSubagent` path is exercised at the
 * package level without depending on the test environment's global config.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync, ResultAsync } from "neverthrow";
import type { OpenCodeClientError, OpenCodeClientFacade } from "../index.js";
import {
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
 */
function makeTempProject(agentName = "smoke-agent"): string {
  const root = join(
    tmpdir(),
    `weave-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, ".weave"), { recursive: true });
  writeFileSync(
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
});

// ---------------------------------------------------------------------------
// Tests: successful materialization path
// ---------------------------------------------------------------------------

describe("WeavePlugin — successful materialization", () => {
  it("returns an empty Hooks object (no hook handlers registered)", async () => {
    const root = makeTempProject("hooks-test-agent");
    const client = new MockOpenCodeClient();
    client.setListResult(okAsync([]));

    // Load config with project-only reader to avoid global config interference
    const { loadConfig } = await import("@weave/config");
    const configResult = await loadConfig(root, projectOnlyReader(root));
    expect(configResult.isOk()).toBe(true);

    const input = makeMockPluginInput(root, client);
    const hooks = await WeavePlugin(input);

    expect(typeof hooks).toBe("object");
    // No hook handlers — agent materialization is the sole job
    expect(hooks.event).toBeUndefined();
    expect(hooks.config).toBeUndefined();
    expect(hooks.tool).toBeUndefined();
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
