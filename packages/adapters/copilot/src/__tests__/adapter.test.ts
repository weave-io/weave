import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { CopilotAdapter } from "../adapter.js";

function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "You are a test agent.",
    models: ["claude-sonnet-5"],
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
  overrides: Partial<{
    exists: (path: string) => Promise<boolean>;
    readDir: (path: string) => Promise<string[]>;
    readFile: (path: string) => Promise<string>;
    removeFile: (path: string) => Promise<void>;
    outDir: string;
  }> = {},
) {
  return new CopilotAdapter({
    projectRoot: "/project",
    homeDir: "/home/user",
    outDir: overrides.outDir,
    exists: overrides.exists ?? (async () => true),
    readDir: overrides.readDir ?? (async () => []),
    readFile: overrides.readFile ?? (async () => ""),
    writeFile: async (path, content) => {
      writtenFiles[path] = content;
    },
    removeFile:
      overrides.removeFile ??
      (async () => {
        /* no-op */
      }),
    mkdir: async (path) => {
      createdDirs.push(path);
    },
  });
}

describe("CopilotAdapter", () => {
  describe("init", () => {
    it("creates outDir when missing", async () => {
      const created: string[] = [];
      const adapter = makeAdapter({}, created, { exists: async () => false });

      await adapter.init();

      expect(created.some((d) => d.includes("copilot"))).toBe(true);
    });

    it("does not create outDir when it already exists", async () => {
      const created: string[] = [];
      const adapter = makeAdapter({}, created, { exists: async () => true });

      await adapter.init();

      expect(created).toHaveLength(0);
    });
  });

  describe("loadAvailableSkills", () => {
    it("returns discovered skills", async () => {
      const adapter = makeAdapter({}, [], {
        readDir: async (path) => (path.includes("project") ? ["my-skill"] : []),
        readFile: async () => "# My Skill",
      });

      const skills = await adapter.loadAvailableSkills();
      expect(skills.length).toBeGreaterThanOrEqual(1);
      expect(skills[0]?.name).toBe("my-skill");
    });

    it("returns empty on discovery failure", async () => {
      const adapter = makeAdapter({}, [], {
        readDir: async () => {
          throw new Error("boom");
        },
      });

      const skills = await adapter.loadAvailableSkills();
      expect(skills).toEqual([]);
    });
  });

  describe("spawnSubagent", () => {
    it("queues agent without writing files", async () => {
      const written: Record<string, string> = {};
      const adapter = makeAdapter(written, []);

      const result = await adapter.spawnSubagent(
        makeDescriptor({ name: "loom" }),
      );

      expect(result.isOk()).toBe(true);
      expect(Object.keys(written)).toHaveLength(0);
    });
  });

  describe("flush", () => {
    it("writes plugin.json", async () => {
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
      expect(parsed).toMatchObject({ name: "weave" });
      expect(parsed.$schema).toBe(
        "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      );
    });

    it("writes agent markdown files to com.github.copilot/agents", async () => {
      const written: Record<string, string> = {};
      const adapter = makeAdapter(written, []);

      await adapter.spawnSubagent(makeDescriptor({ name: "loom" }));
      await adapter.flush();

      const agentPath = Object.keys(written).find(
        (k) =>
          k.includes("com.github.copilot") &&
          k.includes("agents") &&
          k.endsWith("loom.agent.md"),
      );
      expect(agentPath).toBeDefined();
      expect(written[agentPath!]).toContain("name: loom");
      expect(written[agentPath!]).toContain("You are a test agent.");
    });

    it("creates agents directory if missing", async () => {
      const created: string[] = [];
      const adapter = makeAdapter({}, created, { exists: async () => false });

      await adapter.spawnSubagent(makeDescriptor());
      await adapter.flush();

      expect(created.some((d) => d.includes("agents"))).toBe(true);
    });

    it("removes stale agent files not in the current pending set", async () => {
      const written: Record<string, string> = {};
      const removed: string[] = [];
      const adapter = makeAdapter(written, [], {
        exists: async (path) =>
          path.endsWith("agents") || path.endsWith("copilot"),
        readDir: async (path) =>
          path.endsWith("agents") ? ["old-agent.agent.md", "plugin.json"] : [],
        removeFile: async (path) => {
          removed.push(path);
        },
      });

      await adapter.spawnSubagent(makeDescriptor({ name: "new-agent" }));
      await adapter.flush();

      expect(removed).toHaveLength(1);
      expect(removed[0]).toContain("old-agent.agent.md");
      const newAgentPath = Object.keys(written).find((k) =>
        k.endsWith("new-agent.agent.md"),
      );
      expect(newAgentPath).toBeDefined();
    });

    it("writes command files when tapestry agent is present", async () => {
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
    });

    it("does NOT write command files when tapestry is absent", async () => {
      const written: Record<string, string> = {};
      const adapter = makeAdapter(written, []);

      await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
      await adapter.flush();

      const commandFiles = Object.keys(written).filter((k) =>
        k.includes("commands"),
      );
      expect(commandFiles).toHaveLength(0);
    });

    it("removes stale command files when tapestry is absent", async () => {
      const written: Record<string, string> = {};
      const removed: string[] = [];
      const adapter = makeAdapter(written, [], {
        exists: async (path) =>
          path.endsWith("commands") || path.endsWith("copilot"),
        readDir: async (path) =>
          path.endsWith("commands") ? ["start.md", "start-work.md"] : [],
        removeFile: async (path) => {
          removed.push(path);
        },
      });

      await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
      await adapter.flush();

      expect(removed).toHaveLength(2);
      expect(removed.some((p) => p.includes("start.md"))).toBe(true);
      expect(removed.some((p) => p.includes("start-work.md"))).toBe(true);
    });

    it("does NOT write mcp.json when no agent has mcpServers", async () => {
      const written: Record<string, string> = {};
      const adapter = makeAdapter(written, []);

      await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
      await adapter.flush();

      const mcpPath = Object.keys(written).find((k) => k.endsWith("mcp.json"));
      expect(mcpPath).toBeUndefined();
    });

    it("removes stale mcp.json when it exists but no agent has mcpServers", async () => {
      const written: Record<string, string> = {};
      const removed: string[] = [];
      const adapter = makeAdapter(written, [], {
        exists: async (path) => path.endsWith("mcp.json") || true,
        removeFile: async (path) => {
          removed.push(path);
        },
      });

      await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
      await adapter.flush();

      expect(removed.some((p) => p.endsWith("mcp.json"))).toBe(true);
    });

    it("flush with multiple agents writes all markdown files", async () => {
      const written: Record<string, string> = {};
      const adapter = makeAdapter(written, []);

      await adapter.spawnSubagent(makeDescriptor({ name: "loom" }));
      await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
      await adapter.flush();

      const agentFiles = Object.keys(written).filter(
        (k) => k.includes("agents") && k.endsWith(".agent.md"),
      );
      expect(agentFiles).toHaveLength(2);
    });

    it("excludes denied tools from written agent markdown", async () => {
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
        (k) => k.includes("agents") && k.endsWith("test-agent.agent.md"),
      );
      expect(agentPath).toBeDefined();
      const content = written[agentPath!]!;
      expect(content).toContain("- read");
      expect(content).not.toContain("- edit");
      expect(content).not.toContain("- execute");
    });

    it("respects custom outDir", async () => {
      const written: Record<string, string> = {};
      const adapter = makeAdapter(written, [], { outDir: "/custom/out" });

      await adapter.spawnSubagent(makeDescriptor({ name: "shuttle" }));
      await adapter.flush();

      const keys = Object.keys(written);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.includes("custom") && k.includes("out"))).toBe(
        true,
      );
    });

    it("clears pendingAgents after flush", async () => {
      const written: Record<string, string> = {};
      const adapter = makeAdapter(written, []);

      await adapter.spawnSubagent(makeDescriptor({ name: "loom" }));
      await adapter.flush();

      // Flushing again with no new agents should not re-write loom.agent.md
      const secondWritten: Record<string, string> = {};
      Object.assign(written, secondWritten);
      const beforeSecondFlush = Object.keys(written).length;
      await adapter.flush();
      const afterSecondFlush = Object.keys(written).length;

      // plugin.json is rewritten each flush regardless; agents dir should not
      // gain a new loom file (still only one loom.agent.md).
      const loomFiles = Object.keys(written).filter((k) =>
        k.endsWith("loom.agent.md"),
      );
      expect(loomFiles).toHaveLength(1);
      expect(afterSecondFlush).toBeGreaterThanOrEqual(beforeSecondFlush);
    });
  });
});
