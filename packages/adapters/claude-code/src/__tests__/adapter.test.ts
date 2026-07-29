import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { ClaudeCodeAdapter } from "../adapter.js";
import { CC_WEAVE_GOAL_COMMAND } from "../command-templates.js";

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
    expect(skills[0]?.name).toBe("my-skill");
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
    const pluginJson = pluginJsonPath ? written[pluginJsonPath] : undefined;
    expect(pluginJson).toBeDefined();
    const parsed = JSON.parse(pluginJson ?? "");
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
    const agent = agentPath ? written[agentPath] : undefined;
    expect(agent).toBeDefined();
    expect(agent).toContain("name: loom");
    expect(agent).toContain("You are a test agent.");
  });

  it("flush writes settings.json when loom agent is present", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written, []);

    await adapter.spawnSubagent(makeDescriptor({ name: "loom" }));
    await adapter.flush();

    const settingsPath = Object.keys(written).find((k) =>
      k.endsWith("settings.json"),
    );
    const settings =
      settingsPath === undefined ? undefined : written[settingsPath];
    expect(settings).toBeDefined();
    const parsed = JSON.parse(settings ?? "{}");
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
    const content = agentPath === undefined ? undefined : written[agentPath];
    expect(content).toBeDefined();
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
    const goalPath = Object.keys(written).find(
      (k) => k.includes("commands") && k.endsWith("goal.md"),
    );

    expect(startPath).toBeDefined();
    expect(startWorkPath).toBeDefined();
    expect(goalPath).toBeDefined();
    const start = startPath === undefined ? undefined : written[startPath];
    const startWork =
      startWorkPath === undefined ? undefined : written[startWorkPath];
    const goal = goalPath === undefined ? undefined : written[goalPath];
    expect(goal).toBe(CC_WEAVE_GOAL_COMMAND);
    expect(start).toContain("context: fork");
    expect(start).toContain("agent: weave:tapestry");
    expect(startWork).toContain("context: fork");
    expect(startWork).toContain("agent: weave:tapestry");
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
        if (path.endsWith("commands")) {
          return ["start.md", "start-work.md", "goal.md"];
        }
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

    // All command files should be removed when tapestry is not present
    expect(removed).toHaveLength(3);
    expect(removed.some((p) => p.includes("start.md"))).toBe(true);
    expect(removed.some((p) => p.includes("start-work.md"))).toBe(true);
    expect(removed.some((p) => p.includes("goal.md"))).toBe(true);
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
          return ["start.md", "start-work.md", "goal.md", "other.md"];
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

    // other.md should be removed; all three supported commands should survive.
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("other.md");
    const commandWrites = Object.keys(written)
      .filter((path) => path.includes("/commands/"))
      .map((path) => path.split("/").at(-1))
      .sort();
    expect(commandWrites).toEqual(["goal.md", "start-work.md", "start.md"]);
    expect(removed.some((path) => path.endsWith("goal.md"))).toBe(false);
  });

  it("goal command preserves its exact Claude Code template contract", () => {
    const [frontmatter, body] = CC_WEAVE_GOAL_COMMAND.split("\n---\n");
    expect(frontmatter).toBe(
      '---\ncontext: fork\nagent: weave:tapestry\ndisable-model-invocation: true\ndescription: "Work toward completing a Weave plan"\nargument-hint: "[plan-name]"',
    );
    expect(body).toContain(".weave/plans/$ARGUMENTS.md");
    expect(body.match(/\$ARGUMENTS/g)).toHaveLength(1);
    expect(body).toContain("weave:shuttle");
    expect(body).toContain("Agent tool");
    expect(body).toContain("re-read the plan between tasks");
    expect(body).toContain(
      "mark the task's checkbox completed only after verification",
    );
    expect(body).toContain("Stop only when all tasks are complete");
    expect(body).toContain("user explicitly tells you to stop");
  });
});
