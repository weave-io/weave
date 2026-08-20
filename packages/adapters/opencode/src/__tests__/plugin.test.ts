/** Tests for the OpenCode config-hook plugin boundary. */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Hooks,
  Config as OpenCodePluginConfig,
  PluginInput,
} from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { logDestination } from "@weaveio/weave-engine";
import { ResultAsync } from "neverthrow";
import {
  createWeavePlugin,
  DEFAULT_PLUGIN_LOG_SUBPATH,
  default as defaultExport,
  WeavePlugin,
  WeavePluginServer,
} from "../index.js";
import type { OpenCodeAgentConfig } from "../sdk-types.js";

type TestPluginConfig = OpenCodePluginConfig & { default_agent?: string };

function makeMockPluginInput(directory: string): PluginInput {
  return {
    client: createOpencodeClient({
      baseUrl: "http://localhost:1234",
      directory,
    }),
    directory,
    project: {
      id: "test-project",
      worktree: directory,
      time: { created: 0 },
    },
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:1234"),
    $: Bun.$,
  };
}

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
    ["agent broken {", '  prompt "Missing closing brace"', ""].join("\n"),
  );
  return root;
}

async function makeTempProjectWithoutLoom(): Promise<string> {
  const root = join(
    tmpdir(),
    `weave-plugin-no-loom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await Bun.write(
    join(root, ".weave", "config.weave"),
    ['disable agents ["loom"]', ""].join("\n"),
  );
  return root;
}

async function makeTempProjectWithoutTapestry(): Promise<string> {
  const root = join(
    tmpdir(),
    `weave-plugin-no-tapestry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await Bun.write(
    join(root, ".weave", "config.weave"),
    ['disable agents ["tapestry"]', ""].join("\n"),
  );
  return root;
}

async function makeTempProjectWithFailedTapestry(): Promise<string> {
  const root = join(
    tmpdir(),
    `weave-plugin-failed-tapestry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await Bun.write(
    join(root, ".weave", "config.weave"),
    [
      "agent tapestry {",
      '  prompt_append_file "missing-tapestry.md"',
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

async function makeTempFastProject(agentName: string): Promise<string> {
  const root = join(
    tmpdir(),
    `weave-plugin-fast-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await Bun.write(
    join(root, ".weave", "config.weave"),
    [
      `agent ${agentName} {`,
      `  prompt "You are a fast-declaring test agent."`,
      `  models ["claude-opus-5"]`,
      `  mode subagent`,
      `  fast true`,
      `}`,
      "",
    ].join("\n"),
  );
  return root;
}

/** A reader that admits only files under one temporary project. */
function projectOnlyReader(root: string) {
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
    read: (path: string) =>
      ResultAsync.fromPromise(Bun.file(path).text(), (cause: unknown) => ({
        type: "FileReadError" as const,
        path,
        cause,
      })),
  };
}

async function applyConfigHook(
  hooks: Hooks,
  config: TestPluginConfig,
): Promise<void> {
  if (hooks.config === undefined) return;
  await hooks.config(config);
}

function pluginFor(root: string) {
  return createWeavePlugin({ fileReader: projectOnlyReader(root) });
}

function agentConfig(
  prompt: string,
  options?: OpenCodeAgentConfig["options"],
): OpenCodeAgentConfig {
  const config: OpenCodeAgentConfig = { prompt, mode: "primary" };
  if (options !== undefined) {
    config.options = options;
  }
  return config;
}

describe("WeavePlugin — module shape", () => {
  it("exports callable plugin entry points", () => {
    expect(WeavePlugin).toBeInstanceOf(Function);
    expect(WeavePluginServer).toBe(WeavePlugin);
    expect(defaultExport).toBe(WeavePlugin);
  });

  it("creates a plugin function", () => {
    expect(createWeavePlugin()).toBeInstanceOf(Function);
  });
});

describe("WeavePlugin — config loading", () => {
  it("returns empty hooks when config loading fails", async () => {
    const root = await makeTempInvalidProject();
    const hooks = await pluginFor(root)(makeMockPluginInput(root));
    expect(hooks).toEqual({});
  });

  it("returns a config hook and no event hook on success", async () => {
    const root = await makeTempProject("config-hook-agent");
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    expect(hooks.config).toBeInstanceOf(Function);
    expect(hooks.event).toBeUndefined();
  });
});

describe("WeavePlugin — config-hook agent materialization", () => {
  it("initializes cfg.agent when OpenCode has not supplied one", async () => {
    const root = await makeTempProject("init-agent-field");
    const hooks = await pluginFor(root)(makeMockPluginInput(root));
    const cfg: TestPluginConfig = { agent: undefined };

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent).toBeDefined();
    expect(cfg.agent?.["init-agent-field"]?.mode).toBe("subagent");
  });

  it("injects a translated agent into cfg.agent", async () => {
    const root = await makeTempProject("inject-test-agent");
    const hooks = await pluginFor(root)(makeMockPluginInput(root));
    const cfg: TestPluginConfig = {};

    await applyConfigHook(hooks, cfg);

    const injected = cfg.agent?.["inject-test-agent"];
    expect(injected).toBeDefined();
    expect(injected?.prompt).toContain("test agent");
    expect(injected?.mode).toBe("subagent");
  });

  it("preserves an existing same-name agent entry and its options", async () => {
    const root = await makeTempProject("existing-agent");
    const existing = agentConfig("user-owned", {
      provider: "custom-provider",
      model: { temperature: 0.4 },
    });
    const cfg: TestPluginConfig = {
      agent: { "existing-agent": existing },
    };
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.["existing-agent"]).toBe(existing);
    expect(cfg.agent?.["existing-agent"]?.prompt).toBe("user-owned");
    expect(cfg.agent?.["existing-agent"]?.options).toEqual({
      provider: "custom-provider",
      model: { temperature: 0.4 },
    });
  });

  it("skips an existing entry with copied Weave metadata", async () => {
    const root = await makeTempProject("copied-metadata");
    const existing = agentConfig("copied metadata must remain", {
      weave: { kind: "weave-agent", version: 1, agentName: "copied-metadata" },
    });
    existing.description = "[weave-managed]";
    const cfg: TestPluginConfig = {
      agent: { "copied-metadata": existing },
    };
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.["copied-metadata"]).toBe(existing);
    expect(cfg.agent?.["copied-metadata"]?.prompt).toBe(
      "copied metadata must remain",
    );
    expect(cfg.agent?.["copied-metadata"]?.options).toEqual({
      weave: { kind: "weave-agent", version: 1, agentName: "copied-metadata" },
    });
  });

  it("does not set default_agent when Loom is skipped", async () => {
    const root = await makeTempProject("loom-collision");
    const existing = agentConfig("existing loom", {
      user: "owned",
    });
    const cfg: TestPluginConfig = {
      agent: { loom: existing },
      default_agent: "build",
    };
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.loom).toBe(existing);
    expect(cfg.default_agent).toBe("build");
  });

  it("sets default_agent only when Loom is injected by this hook", async () => {
    const root = await makeTempProjectWithoutLoom();
    const cfg: TestPluginConfig = {};
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.loom).toBeUndefined();
    expect(cfg.default_agent).toBeUndefined();
  });

  it("sets default_agent to Loom when Loom is safely injected", async () => {
    const root = await makeTempProject("loom-injected");
    const cfg: TestPluginConfig = {};
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.loom).toBeDefined();
    expect(cfg.default_agent).toBe("loom");
  });
});

describe("WeavePlugin — slash command registration", () => {
  it("registers both commands only after safely injecting Tapestry", async () => {
    const root = await makeTempProject("command-agent");
    const cfg: TestPluginConfig = {};
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.tapestry).toBeDefined();
    expect(cfg.command?.["start-work"]).toMatchObject({
      description: "Start executing a Weave plan created by Pattern",
      agent: "tapestry",
    });
    expect(cfg.command?.["weave:start"]).toMatchObject({
      description: "Start executing a Weave plan (preferred command)",
      agent: "tapestry",
    });
    expect(cfg.command?.["start-work"]?.template).toContain(
      "<weave-command-envelope>",
    );
    expect(cfg.command?.["weave:start"]?.template).toContain(
      "<weave-command-envelope>",
    );
  });

  it("preserves colliding Tapestry and both existing command objects", async () => {
    const root = await makeTempProject("command-tapestry-collision");
    const existingTapestry = agentConfig("user-owned Tapestry", {
      nested: { owner: "user", values: ["unchanged"] },
    });
    const existingStartWork = {
      template: "user start-work",
      description: "User start-work",
      agent: "user-agent",
      metadata: { nested: { keep: true } },
    };
    const existingWeaveStart = {
      template: "user weave:start",
      description: "User weave:start",
      agent: "another-user-agent",
      metadata: { nested: { keep: ["all", "fields"] } },
    };
    const existingCommands = {
      "start-work": existingStartWork,
      "weave:start": existingWeaveStart,
    };
    const cfg: TestPluginConfig = {
      agent: { tapestry: existingTapestry },
      command: existingCommands,
    };
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.tapestry).toBe(existingTapestry);
    expect(cfg.command).toBe(existingCommands);
    expect(cfg.command?.["start-work"]).toBe(existingStartWork);
    expect(cfg.command?.["weave:start"]).toBe(existingWeaveStart);
    expect(cfg.command?.["start-work"]).toEqual(existingStartWork);
    expect(cfg.command?.["weave:start"]).toEqual(existingWeaveStart);
    expect(cfg.default_agent).toBe("loom");
  });

  it("does not create commands when Tapestry collides and commands are absent", async () => {
    const root = await makeTempProject("command-tapestry-no-commands");
    const existingTapestry = agentConfig("user-owned Tapestry");
    const cfg: TestPluginConfig = {
      agent: { tapestry: existingTapestry },
    };
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.tapestry).toBe(existingTapestry);
    expect(cfg.command).toBeUndefined();
    expect(cfg.default_agent).toBe("loom");
  });

  it("does not create commands when Tapestry is missing or skipped", async () => {
    const root = await makeTempProjectWithoutTapestry();
    const cfg: TestPluginConfig = {};
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.tapestry).toBeUndefined();
    expect(cfg.command).toBeUndefined();
    expect(cfg.default_agent).toBe("loom");
  });

  it("does not create commands when Tapestry materialization fails", async () => {
    const root = await makeTempProjectWithFailedTapestry();
    const cfg: TestPluginConfig = {};
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.tapestry).toBeUndefined();
    expect(cfg.command).toBeUndefined();
    expect(cfg.default_agent).toBe("loom");
  });

  it("fails closed per command when one command name collides", async () => {
    const root = await makeTempProject("command-one-collision");
    const existingStartWork = {
      template: "user start-work",
      description: "User-owned start-work",
      agent: "user-agent",
      metadata: { nested: { keep: true } },
    };
    const existingCommands = { "start-work": existingStartWork };
    const cfg: TestPluginConfig = { command: existingCommands };
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.command).toBe(existingCommands);
    expect(cfg.command?.["start-work"]).toBe(existingStartWork);
    expect(cfg.command?.["start-work"]).toEqual(existingStartWork);
    expect(cfg.command?.["weave:start"]).toMatchObject({
      description: "Start executing a Weave plan (preferred command)",
      agent: "tapestry",
    });
    expect(cfg.command?.["weave:start"]?.template).toContain(
      "<weave-command-envelope>",
    );
  });

  it("does not register the removed goal command", async () => {
    const root = await makeTempProject("command-no-goal");
    const cfg: TestPluginConfig = {};
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    await applyConfigHook(hooks, cfg);

    expect(cfg.command?.["weave:goal"]).toBeUndefined();
  });
});

describe("WeavePlugin — builtin materialization", () => {
  it("injects all builtin agents with composed prompts", async () => {
    const root = join(
      tmpdir(),
      `weave-builtin-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await Bun.write(join(root, ".weave", "config.weave"), "# empty project\n");
    const hooks = await pluginFor(root)(makeMockPluginInput(root));
    const cfg: TestPluginConfig = {};

    await applyConfigHook(hooks, cfg);

    expect(Object.keys(cfg.agent ?? {}).sort()).toEqual([
      "loom",
      "pattern",
      "shuttle",
      "spindle",
      "tapestry",
      "thread",
      "warp",
      "weft",
    ]);
    for (const config of Object.values(cfg.agent ?? {})) {
      expect(config?.prompt?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("keeps builtin shuttle subagent-only", async () => {
    const root = join(
      tmpdir(),
      `weave-shuttle-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await Bun.write(join(root, ".weave", "config.weave"), "# empty project\n");
    const hooks = await pluginFor(root)(makeMockPluginInput(root));
    const cfg: TestPluginConfig = {};

    await applyConfigHook(hooks, cfg);

    expect(cfg.agent?.shuttle?.mode).toBe("subagent");
  });
});

describe("WeavePlugin — provider acceleration intent", () => {
  it("registers no request-mutation or event hook", async () => {
    const root = await makeTempFastProject("fast-hook-agent");
    const hooks = await pluginFor(root)(makeMockPluginInput(root));

    expect(Object.keys(hooks)).toEqual(["config"]);
    expect(hooks.event).toBeUndefined();
    expect(hooks["chat.params"]).toBeUndefined();
    expect(hooks["chat.headers"]).toBeUndefined();
  });

  it("does not encode acceleration fields in the config", async () => {
    const root = await makeTempFastProject("fast-config-agent");
    const hooks = await pluginFor(root)(makeMockPluginInput(root));
    const cfg: TestPluginConfig = {};

    await applyConfigHook(hooks, cfg);

    const injected = cfg.agent?.["fast-config-agent"];
    expect(injected).toBeDefined();
    for (const field of ["fast", "speed", "service_tier", "priority"]) {
      expect(Object.hasOwn(injected ?? {}, field)).toBe(false);
    }
  });
});

describe("WeavePlugin — logging", () => {
  it("writes the default log destination under .weave", async () => {
    const root = join(
      tmpdir(),
      `weave-file-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await Bun.write(join(root, ".weave", "config.weave"), "# empty\n");

    await WeavePlugin(makeMockPluginInput(root));

    const expectedLogPath = join(root, DEFAULT_PLUGIN_LOG_SUBPATH);
    expect(await Bun.file(expectedLogPath).exists()).toBe(true);

    const sentinel = `{"weave-test-sentinel":true,"ts":${Date.now()}}\n`;
    logDestination.write(sentinel);
    expect(await Bun.file(expectedLogPath).text()).toContain(
      "weave-test-sentinel",
    );
  });

  it("exports the stable default log path", () => {
    expect(DEFAULT_PLUGIN_LOG_SUBPATH).toBe(".weave/weave.log");
  });
});
