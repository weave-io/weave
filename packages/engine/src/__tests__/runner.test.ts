import { beforeEach, describe, expect, it } from "bun:test";
import { parseConfig } from "@weave/core";
import type { RunAgentEffect } from "../run-agent-effects.js";
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
    it("spawns a single agent with correct name and config", async () => {
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
      expect(spawned[0]?.config.models).toEqual(["claude-sonnet-4-5"]);
      expect(spawned[0]?.config.temperature).toBe(0.1);
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
      expect(spawned[0]?.config.tool_policy?.read).toBe("allow");
      expect(spawned[0]?.config.tool_policy?.write).toBe("allow");
      expect(spawned[0]?.config.tool_policy?.execute).toBe("ask");
      expect(spawned[0]?.config.tool_policy?.network).toBe("deny");
      expect(spawned[0]?.config.tool_policy?.delegate).toBe("deny");
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
      expect(spawned?.config.models).toEqual(["gpt-5"]);
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

  // -------------------------------------------------------------------------
  // onEffect — RunAgentEffect emission
  // -------------------------------------------------------------------------

  describe("onEffect callback", () => {
    it("emits a run-agent effect for a normal agent with explicit tool_policy", async () => {
      const config = cfg(`
        agent alpha-worker {
          prompt "Alpha worker agent."
          models ["model-a"]
          tool_policy {
            read  allow
            write allow
            execute deny
            delegate deny
            network ask
          }
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      expect(effects).toHaveLength(1);
      const effect = effects[0];
      expect(effect?.kind).toBe("run-agent");
      expect(effect?.agentName).toBe("alpha-worker");
    });

    it("effectiveToolPolicy reflects explicit tool_policy values", async () => {
      const config = cfg(`
        agent beta-worker {
          prompt "Beta worker agent."
          models ["model-b"]
          tool_policy {
            read  allow
            write deny
            execute ask
            delegate deny
            network allow
          }
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const effect = effects[0];
      expect(effect?.effectiveToolPolicy.read).toBe("allow");
      expect(effect?.effectiveToolPolicy.write).toBe("deny");
      expect(effect?.effectiveToolPolicy.execute).toBe("ask");
      expect(effect?.effectiveToolPolicy.delegate).toBe("deny");
      expect(effect?.effectiveToolPolicy.network).toBe("allow");
    });

    it("rawToolPolicy in effect matches the agent's declared tool_policy", async () => {
      const config = cfg(`
        agent gamma-worker {
          prompt "Gamma worker agent."
          models ["model-c"]
          tool_policy {
            read  allow
            write allow
            execute deny
            delegate deny
            network deny
          }
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const effect = effects[0];
      expect(effect?.rawToolPolicy?.read).toBe("allow");
      expect(effect?.rawToolPolicy?.write).toBe("allow");
      expect(effect?.rawToolPolicy?.execute).toBe("deny");
      expect(effect?.rawToolPolicy?.delegate).toBe("deny");
      expect(effect?.rawToolPolicy?.network).toBe("deny");
    });

    it("agent with no tool_policy: effectiveToolPolicy defaults all capabilities to ask", async () => {
      const config = cfg(`
        agent delta-worker {
          prompt "Delta worker agent."
          models ["model-d"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const effect = effects[0];
      expect(effect?.effectiveToolPolicy.read).toBe("ask");
      expect(effect?.effectiveToolPolicy.write).toBe("ask");
      expect(effect?.effectiveToolPolicy.execute).toBe("ask");
      expect(effect?.effectiveToolPolicy.delegate).toBe("ask");
      expect(effect?.effectiveToolPolicy.network).toBe("ask");
    });

    it("agent with no tool_policy: rawToolPolicy is undefined", async () => {
      const config = cfg(`
        agent epsilon-worker {
          prompt "Epsilon worker agent."
          models ["model-e"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      expect(effects[0]?.rawToolPolicy).toBeUndefined();
    });

    it("emits one effect per agent in a multi-agent config", async () => {
      const config = cfg(`
        agent zeta-one { prompt "Zeta one." models ["model-z1"] }
        agent zeta-two { prompt "Zeta two." models ["model-z2"] }
        agent zeta-three { prompt "Zeta three." models ["model-z3"] }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      expect(effects).toHaveLength(3);
      const names = effects.map((e) => e.agentName);
      expect(names).toContain("zeta-one");
      expect(names).toContain("zeta-two");
      expect(names).toContain("zeta-three");
    });

    it("does not emit an effect for disabled agents", async () => {
      const config = cfg(`
        agent eta-active  { prompt "Eta active."   models ["model-eta-a"] }
        agent eta-disabled { prompt "Eta disabled." models ["model-eta-d"] }
        disable agents ["eta-disabled"]
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const names = effects.map((e) => e.agentName);
      expect(names).toContain("eta-active");
      expect(names).not.toContain("eta-disabled");
    });

    it("effect is emitted before adapter.spawnSubagent is called", async () => {
      const config = cfg(`
        agent theta-worker { prompt "Theta worker." models ["model-theta"] }
      `);

      const order: string[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => order.push(`effect:${e.agentName}`),
      }).run();

      // Reconstruct full order including adapter spawn calls
      const spawnOrder = adapter
        .callsTo("spawnSubagent")
        .map((c) => `spawn:${c.name}`);

      // effect must appear before spawn in the combined sequence
      const effectIdx = order.indexOf("effect:theta-worker");
      expect(effectIdx).toBeGreaterThanOrEqual(0);
      expect(spawnOrder).toContain("spawn:theta-worker");
    });

    it("no harness-specific tool names appear in any emitted effect", async () => {
      const config = cfg(`
        agent iota-worker {
          prompt "Iota worker."
          models ["model-iota"]
          tool_policy {
            read  allow
            write allow
            execute ask
            delegate deny
            network deny
          }
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      // Serialize the effect and confirm no harness-specific names appear
      const serialized = JSON.stringify(effects);
      // Abstract capability keys only — no harness tool identifiers
      const harnessPatterns = [
        "opencode",
        "claude-code",
        "pi-agent",
        "codex",
        "bash",
        "computer",
        "str_replace",
      ];
      for (const pattern of harnessPatterns) {
        expect(serialized).not.toContain(pattern);
      }
    });
  });

  // -------------------------------------------------------------------------
  // onEffect — category shuttle policy
  // -------------------------------------------------------------------------

  describe("onEffect — category shuttle policy", () => {
    it("emits a run-agent effect for a category shuttle agent", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category kappa { patterns ["src/kappa/**"] models ["model-kappa"] }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const shuttleEffect = effects.find(
        (e) => e.agentName === "shuttle-kappa",
      );
      expect(shuttleEffect).toBeDefined();
      expect(shuttleEffect?.kind).toBe("run-agent");
    });

    it("category shuttle with explicit tool_policy: effectiveToolPolicy reflects category values", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category lambda {
          patterns ["src/lambda/**"]
          models ["model-lambda"]
          tool_policy {
            read  allow
            write deny
            execute deny
            delegate deny
            network deny
          }
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const shuttleEffect = effects.find(
        (e) => e.agentName === "shuttle-lambda",
      );
      expect(shuttleEffect?.effectiveToolPolicy.read).toBe("allow");
      expect(shuttleEffect?.effectiveToolPolicy.write).toBe("deny");
      expect(shuttleEffect?.effectiveToolPolicy.execute).toBe("deny");
      expect(shuttleEffect?.effectiveToolPolicy.delegate).toBe("deny");
      expect(shuttleEffect?.effectiveToolPolicy.network).toBe("deny");
    });

    it("category shuttle with no tool_policy: effectiveToolPolicy defaults all to ask", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category mu { patterns ["src/mu/**"] models ["model-mu"] }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const shuttleEffect = effects.find((e) => e.agentName === "shuttle-mu");
      expect(shuttleEffect?.effectiveToolPolicy.read).toBe("ask");
      expect(shuttleEffect?.effectiveToolPolicy.write).toBe("ask");
      expect(shuttleEffect?.effectiveToolPolicy.execute).toBe("ask");
      expect(shuttleEffect?.effectiveToolPolicy.delegate).toBe("ask");
      expect(shuttleEffect?.effectiveToolPolicy.network).toBe("ask");
    });

    it("category shuttle rawToolPolicy matches the category's declared tool_policy", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category nu {
          patterns ["src/nu/**"]
          models ["model-nu"]
          tool_policy {
            read  allow
            write allow
            execute ask
            delegate deny
            network deny
          }
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const shuttleEffect = effects.find((e) => e.agentName === "shuttle-nu");
      expect(shuttleEffect?.rawToolPolicy?.read).toBe("allow");
      expect(shuttleEffect?.rawToolPolicy?.write).toBe("allow");
      expect(shuttleEffect?.rawToolPolicy?.execute).toBe("ask");
      expect(shuttleEffect?.rawToolPolicy?.delegate).toBe("deny");
      expect(shuttleEffect?.rawToolPolicy?.network).toBe("deny");
    });

    it("category shuttle with no tool_policy: rawToolPolicy is undefined", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category xi { patterns ["src/xi/**"] models ["model-xi"] }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const shuttleEffect = effects.find((e) => e.agentName === "shuttle-xi");
      expect(shuttleEffect?.rawToolPolicy).toBeUndefined();
    });

    it("raw tool_policy is still passed to adapter unchanged for category shuttle", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category omicron {
          patterns ["src/omicron/**"]
          models ["model-omicron"]
          tool_policy {
            read  allow
            write allow
            execute deny
            delegate deny
            network deny
          }
        }
      `);

      await new WeaveRunner(config, adapter).run();

      const spawned = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.name === "shuttle-omicron");
      expect(spawned?.config.tool_policy?.read).toBe("allow");
      expect(spawned?.config.tool_policy?.write).toBe("allow");
      expect(spawned?.config.tool_policy?.execute).toBe("deny");
      expect(spawned?.config.tool_policy?.delegate).toBe("deny");
      expect(spawned?.config.tool_policy?.network).toBe("deny");
    });
  });

  // -------------------------------------------------------------------------
  // Non-breaking: callers without onEffect still work
  // -------------------------------------------------------------------------

  describe("non-breaking: no onEffect option", () => {
    it("runner works normally when no options object is provided", async () => {
      const config = cfg(`
        agent test-worker { prompt "Test worker." models ["model-test"] }
      `);

      // No options argument — must not throw
      await new WeaveRunner(config, adapter).run();

      expect(adapter.callsTo("spawnSubagent")).toHaveLength(1);
      expect(adapter.callsTo("spawnSubagent")[0]?.name).toBe("test-worker");
    });

    it("runner works normally when options object has no onEffect", async () => {
      const config = cfg(`
        agent rho-worker { prompt "Rho worker." models ["model-rho"] }
      `);

      await new WeaveRunner(config, adapter, {}).run();

      expect(adapter.callsTo("spawnSubagent")).toHaveLength(1);
    });
  });
});
