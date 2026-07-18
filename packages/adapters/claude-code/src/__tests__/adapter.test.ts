import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { ClaudeCodeAdapter } from "../adapter.js";

function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "You are a test agent.",
    models: ["claude-sonnet-4-5"],
    mode: "subagent",
    effectiveToolPolicy: {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "deny",
      network: "ask",
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
    ...overrides,
  };
}

function makeAdapter(
  writtenFiles: Record<string, string>,
  createdDirs: string[],
  existsImpl?: (path: string) => Promise<boolean>,
) {
  return new ClaudeCodeAdapter({
    projectRoot: "/project",
    homeDir: "/home/user",
    exists: existsImpl ?? (async () => true),
    readDir: async () => [],
    readFile: async () => "",
    writeFile: async (path, content) => {
      writtenFiles[path] = content;
    },
    mkdir: async (path) => {
      createdDirs.push(path);
    },
  });
}

describe("ClaudeCodeAdapter", () => {
  it("init succeeds when output directory exists", async () => {
    const adapter = makeAdapter({}, []);
    await adapter.init();
  });

  it("init creates output directory when missing", async () => {
    const created: string[] = [];
    const adapter = new ClaudeCodeAdapter({
      projectRoot: "/project",
      homeDir: "/home/user",
      exists: async () => false,
      readDir: async () => [],
      readFile: async () => "",
      writeFile: async () => {},
      mkdir: async (path) => {
        created.push(path);
      },
    });

    await adapter.init();
    expect(created.some((d) => d.includes("claude-code"))).toBe(true);
  });

  it("loadAvailableSkills returns discovered skills", async () => {
    const adapter = new ClaudeCodeAdapter({
      projectRoot: "/project",
      homeDir: "/home/user",
      exists: async () => true,
      readDir: async (path) => {
        if (path.includes("commands")) return ["my-skill.md"];
        return [];
      },
      readFile: async () => "# My Skill\nDoes things.",
      writeFile: async () => {},
      mkdir: async () => {},
    });

    const skills = await adapter.loadAvailableSkills();
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills[0]!.name).toBe("my-skill");
  });

  it("loadAvailableSkills returns empty on discovery failure", async () => {
    const adapter = new ClaudeCodeAdapter({
      projectRoot: "/project",
      homeDir: "/home/user",
      exists: async () => true,
      readDir: async () => {
        throw new Error("boom");
      },
      readFile: async () => "",
      writeFile: async () => {},
      mkdir: async () => {},
    });

    const skills = await adapter.loadAvailableSkills();
    expect(skills).toEqual([]);
  });

  it("spawnSubagent queues agent without writing files", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    const result = await adapter.spawnSubagent(
      makeDescriptor({ name: "loom" }),
    );

    expect(result.isOk()).toBe(true);
    // No files written yet — flush has not been called
    expect(Object.keys(written)).toHaveLength(0);
  });

  it("flush writes plugin.json", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
    const flushResult = await adapter.flush();

    expect(flushResult.isOk()).toBe(true);
    const pluginJsonPath = Object.keys(written).find((k) =>
      k.endsWith("plugin.json"),
    );
    expect(pluginJsonPath).toBeDefined();
    const parsed = JSON.parse(written[pluginJsonPath!]!);
    expect(parsed).toMatchObject({ name: "weave", version: "1.0.0" });
  });

  it("flush writes agent markdown files", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    await adapter.spawnSubagent(makeDescriptor({ name: "loom" }));
    await adapter.flush();

    const agentPath = Object.keys(written).find(
      (k) => k.includes("agents") && k.endsWith("loom.md"),
    );
    expect(agentPath).toBeDefined();
    expect(written[agentPath!]).toContain("name: loom");
    expect(written[agentPath!]).toContain("You are a test agent.");
  });

  it("flush writes settings.json when loom agent is present", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    await adapter.spawnSubagent(makeDescriptor({ name: "loom" }));
    await adapter.flush();

    const settingsPath = Object.keys(written).find((k) =>
      k.endsWith("settings.json"),
    );
    expect(settingsPath).toBeDefined();
    const parsed = JSON.parse(written[settingsPath!]!);
    expect(parsed).toMatchObject({ agent: "loom" });
  });

  it("flush does NOT write settings.json when loom is absent", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
    await adapter.flush();

    const settingsPath = Object.keys(written).find((k) =>
      k.endsWith("settings.json"),
    );
    expect(settingsPath).toBeUndefined();
  });

  it("flush creates agents directory if missing", async () => {
    const created: string[] = [];
    const adapter = new ClaudeCodeAdapter({
      projectRoot: "/project",
      homeDir: "/home/user",
      exists: async () => false,
      readDir: async () => [],
      readFile: async () => "",
      writeFile: async () => {},
      mkdir: async (path) => {
        created.push(path);
      },
    });

    await adapter.spawnSubagent(makeDescriptor());
    await adapter.flush();

    expect(created.some((d) => d.includes("agents"))).toBe(true);
  });

  it("flush respects custom outDir", async () => {
    const written: Record<string, string> = {};
    const adapter = new ClaudeCodeAdapter({
      projectRoot: "/project",
      homeDir: "/home/user",
      outDir: "/custom/out",
      exists: async () => true,
      readDir: async () => [],
      readFile: async () => "",
      writeFile: async (path, content) => {
        written[path] = content;
      },
      mkdir: async () => {},
    });

    await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
    await adapter.flush();

    const keys = Object.keys(written);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.includes("custom") && k.includes("out"))).toBe(
      true,
    );
  });

  it("flush with multiple agents writes all markdown files", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    await adapter.spawnSubagent(makeDescriptor({ name: "loom" }));
    await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
    await adapter.flush();

    const agentFiles = Object.keys(written).filter(
      (k) => k.includes("agents") && k.endsWith(".md"),
    );
    expect(agentFiles).toHaveLength(2);
  });

  it("spawnSubagent excludes denied tools (verified after flush)", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    await adapter.spawnSubagent(
      makeDescriptor({
        name: "test-agent",
        effectiveToolPolicy: {
          read: "allow",
          write: "deny",
          execute: "deny",
          delegate: "deny",
          network: "deny",
        },
      }),
    );
    await adapter.flush();

    const agentPath = Object.keys(written).find(
      (k) => k.includes("agents") && k.endsWith("test-agent.md"),
    );
    expect(agentPath).toBeDefined();
    const content = written[agentPath!]!;
    expect(content).toContain("- Read");
    expect(content).not.toContain("- Write");
    expect(content).not.toContain("- Bash");
    expect(content).not.toContain("- Task");
  });

  it("flush removes stale .md files not in the current pending set", async () => {
    const written: Record<string, string> = {};
    const removed: string[] = [];

    // Simulate agents dir already exists with an old-agent.md stale file
    const adapter = new ClaudeCodeAdapter({
      projectRoot: "/project",
      homeDir: "/home/user",
      exists: async () => true,
      readDir: async (path) =>
        path.endsWith("agents") ? ["old-agent.md", "plugin.json"] : [],
      readFile: async () => "",
      writeFile: async (path, content) => {
        written[path] = content;
      },
      removeFile: async (path) => {
        removed.push(path);
      },
      mkdir: async () => {},
    });

    await adapter.spawnSubagent(makeDescriptor({ name: "new-agent" }));
    await adapter.flush();

    // old-agent.md should be removed; plugin.json (non-.md) should not
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("old-agent.md");
    // new-agent.md should be written
    const newAgentPath = Object.keys(written).find((k) =>
      k.endsWith("new-agent.md"),
    );
    expect(newAgentPath).toBeDefined();
  });

  it("flush writes command files when tapestry agent is present", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    await adapter.spawnSubagent(makeDescriptor({ name: "tapestry" }));
    await adapter.flush();

    const startPath = Object.keys(written).find(
      (k) => k.includes("commands") && k.endsWith("start.md"),
    );
    const startWorkPath = Object.keys(written).find(
      (k) => k.includes("commands") && k.endsWith("start-work.md"),
    );

    expect(startPath).toBeDefined();
    expect(startWorkPath).toBeDefined();
    expect(written[startPath!]).toContain("context: fork");
    expect(written[startPath!]).toContain("agent: weave:tapestry");
    expect(written[startWorkPath!]).toContain("context: fork");
    expect(written[startWorkPath!]).toContain("agent: weave:tapestry");
  });

  it("flush does NOT write command files when tapestry is absent", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
    await adapter.flush();

    const commandFiles = Object.keys(written).filter((k) =>
      k.includes("commands"),
    );
    expect(commandFiles).toHaveLength(0);
  });

  it("flush removes stale command files when tapestry is absent", async () => {
    const written: Record<string, string> = {};
    const removed: string[] = [];

    // Simulate commands dir already exists with stale command files
    const adapter = new ClaudeCodeAdapter({
      projectRoot: "/project",
      homeDir: "/home/user",
      exists: async () => true,
      readDir: async (path) => {
        if (path.endsWith("commands")) return ["start.md", "start-work.md"];
        return [];
      },
      readFile: async () => "",
      writeFile: async (path, content) => {
        written[path] = content;
      },
      removeFile: async (path) => {
        removed.push(path);
      },
      mkdir: async () => {},
    });

    await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
    await adapter.flush();

    // Both command files should be removed when tapestry is not present
    expect(removed).toHaveLength(2);
    expect(removed.some((p) => p.includes("start.md"))).toBe(true);
    expect(removed.some((p) => p.includes("start-work.md"))).toBe(true);
  });

  it("flush removes stale command files not in the current command set", async () => {
    const written: Record<string, string> = {};
    const removed: string[] = [];

    // Simulate commands dir with an extra stale command file
    const adapter = new ClaudeCodeAdapter({
      projectRoot: "/project",
      homeDir: "/home/user",
      exists: async () => true,
      readDir: async (path) => {
        if (path.endsWith("commands"))
          return ["start.md", "start-work.md", "old-command.md"];
        return [];
      },
      readFile: async () => "",
      writeFile: async (path, content) => {
        written[path] = content;
      },
      removeFile: async (path) => {
        removed.push(path);
      },
      mkdir: async () => {},
    });

    await adapter.spawnSubagent(makeDescriptor({ name: "tapestry" }));
    await adapter.flush();

    // old-command.md should be removed; start.md and start-work.md should be written
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("old-command.md");
    const startPath = Object.keys(written).find((k) => k.endsWith("start.md"));
    const startWorkPath = Object.keys(written).find((k) =>
      k.endsWith("start-work.md"),
    );
    expect(startPath).toBeDefined();
    expect(startWorkPath).toBeDefined();
  });
});
