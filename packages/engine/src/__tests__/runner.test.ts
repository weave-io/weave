import { beforeEach, describe, expect, it } from "bun:test";
import { parseConfig } from "@weave/core";
import { WeaveRunner } from "../runner.js";
import { MockAdapter } from "./mock-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a .weave source string and unwrap — throws on invalid input. */
function cfg(source: string) {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WeaveRunner", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("calls init exactly once before spawning any agent", async () => {
      const config = cfg(`
        agent loom {
          prompt "You are loom."
          models ["claude-sonnet-4-5"]
        }
      `);

      await new WeaveRunner(config, adapter).run();

      const allCalls = adapter.calls.map((c) => c.method);
      expect(allCalls[0]).toBe("init");
      expect(adapter.callsTo("init")).toHaveLength(1);
    });

    it("completes without error on an empty config", async () => {
      await new WeaveRunner(cfg(""), adapter).run();

      expect(adapter.callsTo("init")).toHaveLength(1);
      expect(adapter.callsTo("spawnSubagent")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Agent spawning
  // -------------------------------------------------------------------------

  describe("agent spawning", () => {
    it("spawns a single agent with correct name and descriptor", async () => {
      const config = cfg(`
        agent loom {
          prompt "You are loom."
          models ["claude-sonnet-4-5"]
          temperature 0.1
        }
      `);

      await new WeaveRunner(config, adapter).run();

      const spawned = adapter.callsTo("spawnSubagent");
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.name).toBe("loom");
      expect(spawned[0]?.descriptor.models).toEqual(["claude-sonnet-4-5"]);
      expect(spawned[0]?.descriptor.temperature).toBe(0.1);
    });

    it("spawns all agents in a multi-agent config", async () => {
      const config = cfg(`
        agent loom {
          prompt "Orchestrator."
          models ["claude-sonnet-4-5"]
        }
        agent shuttle {
          prompt "Specialist."
          models ["claude-sonnet-4-5"]
        }
        agent warp {
          prompt "Reviewer."
          models ["claude-sonnet-4-5"]
        }
      `);

      await new WeaveRunner(config, adapter).run();

      const names = adapter.callsTo("spawnSubagent").map((c) => c.name);
      expect(names).toHaveLength(3);
      expect(names).toContain("loom");
      expect(names).toContain("shuttle");
      expect(names).toContain("warp");
    });

    it("passes tool_policy through to the adapter unchanged", async () => {
      const config = cfg(`
        agent shuttle {
          prompt "Specialist."
          models ["claude-sonnet-4-5"]
          tool_policy {
            read  allow
            write allow
            execute ask
            network deny
            delegate deny
          }
        }
      `);

      await new WeaveRunner(config, adapter).run();

      const spawned = adapter.callsTo("spawnSubagent");
      expect(spawned[0]?.descriptor.toolPolicy.read).toBe("allow");
      expect(spawned[0]?.descriptor.toolPolicy.write).toBe("allow");
      expect(spawned[0]?.descriptor.toolPolicy.execute).toBe("ask");
      expect(spawned[0]?.descriptor.toolPolicy.network).toBe("deny");
      expect(spawned[0]?.descriptor.toolPolicy.delegate).toBe("deny");
    });
  });

  // -------------------------------------------------------------------------
  // Disabled agents
  // -------------------------------------------------------------------------

  describe("disabled agents", () => {
    it("does not spawn an agent listed in disable agents", async () => {
      const config = cfg(`
        agent loom   { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
        agent warp   { prompt "Reviewer."     models ["claude-sonnet-4-5"] }
        disable agents ["warp"]
      `);

      await new WeaveRunner(config, adapter).run();

      const names = adapter.callsTo("spawnSubagent").map((c) => c.name);
      expect(names).toContain("loom");
      expect(names).not.toContain("warp");
    });

    it("spawns no agents when all are disabled", async () => {
      const config = cfg(`
        agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
        disable agents ["loom"]
      `);

      await new WeaveRunner(config, adapter).run();

      expect(adapter.callsTo("spawnSubagent")).toHaveLength(0);
    });

    it("still calls init even when all agents are disabled", async () => {
      const config = cfg(`
        agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
        disable agents ["loom"]
      `);

      await new WeaveRunner(config, adapter).run();

      expect(adapter.callsTo("init")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Call ordering
  // -------------------------------------------------------------------------

  describe("call ordering", () => {
    it("init always precedes spawnSubagent calls", async () => {
      const config = cfg(`
        agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
      `);

      await new WeaveRunner(config, adapter).run();

      const initIdx = adapter.calls.findIndex((c) => c.method === "init");
      const spawnIdx = adapter.calls.findIndex(
        (c) => c.method === "spawnSubagent",
      );
      expect(initIdx).toBeLessThan(spawnIdx);
    });
  });

  // -------------------------------------------------------------------------
  // Category shuttle spawning
  // -------------------------------------------------------------------------

  describe("category shuttle spawning", () => {
    it("spawns a generated shuttle-{name} agent when a category is configured", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
      `);

      await new WeaveRunner(config, adapter).run();

      const names = adapter.callsTo("spawnSubagent").map((c) => c.name);
      expect(names).toContain("shuttle");
      expect(names).toContain("shuttle-frontend");
    });

    it("spawns multiple generated shuttles for multiple categories", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
        category backend { patterns ["src/api/**"] models ["gpt-4o"] }
      `);

      await new WeaveRunner(config, adapter).run();

      const names = adapter.callsTo("spawnSubagent").map((c) => c.name);
      expect(names).toContain("shuttle-frontend");
      expect(names).toContain("shuttle-backend");
    });

    it("does not spawn a category shuttle when the base shuttle is disabled", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
        disable agents ["shuttle"]
      `);

      await new WeaveRunner(config, adapter).run();

      const names = adapter.callsTo("spawnSubagent").map((c) => c.name);
      expect(names).not.toContain("shuttle");
      expect(names).not.toContain("shuttle-frontend");
    });

    it("does not spawn a specific category shuttle when its name is in disabled.agents", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
        category backend { patterns ["src/api/**"] models ["gpt-4o"] }
        disable agents ["shuttle-frontend"]
      `);

      await new WeaveRunner(config, adapter).run();

      const names = adapter.callsTo("spawnSubagent").map((c) => c.name);
      expect(names).not.toContain("shuttle-frontend");
      expect(names).toContain("shuttle-backend");
    });

    it("category shuttle descriptor carries category models", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
      `);

      await new WeaveRunner(config, adapter).run();

      const spawned = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.name === "shuttle-frontend");
      expect(spawned?.descriptor.models).toEqual(["gpt-5"]);
    });

    it("throws when a category would generate a name that is already explicitly declared", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["claude-sonnet-4-5"] }
        agent shuttle-frontend { prompt "Explicit." models ["gpt-4o"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
      `);

      await expect(new WeaveRunner(config, adapter).run()).rejects.toThrow(
        /shuttle-frontend.*frontend/,
      );
    });
  });
});
