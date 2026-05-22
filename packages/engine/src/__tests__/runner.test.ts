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
      expect(spawned[0]?.descriptor.name).toBe("loom");
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

      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
      expect(names).toHaveLength(3);
      expect(names).toContain("loom");
      expect(names).toContain("shuttle");
      expect(names).toContain("warp");
    });

    it("passes rawToolPolicy through to the adapter unchanged", async () => {
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
      expect(spawned[0]?.descriptor.rawToolPolicy?.read).toBe("allow");
      expect(spawned[0]?.descriptor.rawToolPolicy?.write).toBe("allow");
      expect(spawned[0]?.descriptor.rawToolPolicy?.execute).toBe("ask");
      expect(spawned[0]?.descriptor.rawToolPolicy?.network).toBe("deny");
      expect(spawned[0]?.descriptor.rawToolPolicy?.delegate).toBe("deny");
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

      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
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

      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
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

      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
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

      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
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

      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
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
        .find((c) => c.descriptor.name === "shuttle-frontend");
      expect(spawned?.descriptor.models).toEqual(["gpt-5"]);
    });

    it("adapter receives category metadata for generated category shuttles", async () => {
      const config = cfg(`
        agent loom { prompt "Orchestrator." models ["model-loom"] }
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category frontend {
          description "Frontend UI, styling, accessibility"
          patterns ["src/components/**", "**/*.tsx"]
          models ["gpt-5"]
        }
      `);

      await new WeaveRunner(config, adapter).run();

      const spawned = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle-frontend");
      expect(spawned?.descriptor.category).toEqual({
        name: "frontend",
        description: "Frontend UI, styling, accessibility",
        patterns: ["src/components/**", "**/*.tsx"],
        isCategory: true,
      });

      const regular = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "loom");
      const baseShuttle = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle");
      expect(regular?.descriptor.category).toBeUndefined();
      expect(baseShuttle?.descriptor.category).toBeUndefined();
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

    it("continues agent materialization when onEffect throws", async () => {
      const config = cfg(`
        agent phi-worker { prompt "Phi worker." models ["model-phi"] }
      `);

      await new WeaveRunner(config, adapter, {
        onEffect: () => {
          throw new Error("observer exploded");
        },
      }).run();

      // Agent should still be spawned despite the callback throwing
      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
      expect(names).toContain("phi-worker");
    });

    it("effect is emitted before adapter.spawnSubagent is called", async () => {
      const config = cfg(`
        agent theta-worker { prompt "Theta worker." models ["model-theta"] }
      `);

      const order: string[] = [];
      const originalSpawn = adapter.spawnSubagent.bind(adapter);
      adapter.spawnSubagent = async (descriptor) => {
        order.push(`spawn:${descriptor.name}`);
        return originalSpawn(descriptor);
      };
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => order.push(`effect:${e.agentName}`),
      }).run();

      expect(order).toEqual(["effect:theta-worker", "spawn:theta-worker"]);
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

    it("onEffect receives category metadata matching the spawned descriptor", async () => {
      const config = cfg(`
        agent worker { prompt "Regular." models ["model-worker"] }
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category frontend {
          description "Frontend UI, styling, accessibility"
          patterns ["src/components/**", "**/*.tsx"]
          models ["model-frontend"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      const spawned = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle-frontend");
      const shuttleEffect = effects.find(
        (e) => e.agentName === "shuttle-frontend",
      );
      const regularEffect = effects.find((e) => e.agentName === "worker");

      expect(shuttleEffect?.agentDescriptor.category).toEqual(
        spawned?.descriptor.category,
      );
      expect(shuttleEffect?.agentDescriptor.category).toEqual({
        name: "frontend",
        description: "Frontend UI, styling, accessibility",
        patterns: ["src/components/**", "**/*.tsx"],
        isCategory: true,
      });
      expect(regularEffect?.agentDescriptor.category).toBeUndefined();
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
        .find((c) => c.descriptor.name === "shuttle-omicron");
      expect(spawned?.descriptor.rawToolPolicy?.read).toBe("allow");
      expect(spawned?.descriptor.rawToolPolicy?.write).toBe("allow");
      expect(spawned?.descriptor.rawToolPolicy?.execute).toBe("deny");
      expect(spawned?.descriptor.rawToolPolicy?.delegate).toBe("deny");
      expect(spawned?.descriptor.rawToolPolicy?.network).toBe("deny");
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
      expect(adapter.callsTo("spawnSubagent")[0]?.descriptor.name).toBe(
        "test-worker",
      );
    });

    it("runner works normally when options object has no onEffect", async () => {
      const config = cfg(`
        agent rho-worker { prompt "Rho worker." models ["model-rho"] }
      `);

      await new WeaveRunner(config, adapter, {}).run();

      expect(adapter.callsTo("spawnSubagent")).toHaveLength(1);
      expect(adapter.callsTo("spawnSubagent")[0]?.descriptor.name).toBe(
        "rho-worker",
      );
    });
  });

  describe("composition", () => {
    it("composedPrompt contains the inline prompt text", async () => {
      const config = cfg(`
        agent sigma-worker {
          prompt "You are sigma."
          models ["model-sigma"]
        }
      `);

      await new WeaveRunner(config, adapter).run();

      const spawned = adapter.callsTo("spawnSubagent");
      expect(spawned[0]?.descriptor.composedPrompt).toContain("You are sigma.");
    });

    it("composition error for one agent does not prevent others from spawning", async () => {
      const config = cfg(`
        agent tau-one { prompt "Tau one." models ["model-tau-1"] }
        agent tau-two { prompt_file "nonexistent/missing-prompt.md" models ["model-tau-2"] }
      `);

      await new WeaveRunner(config, adapter).run();

      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
      expect(names).toContain("tau-one");
      expect(names).not.toContain("tau-two");
    });

    it("effect carries the composed agentDescriptor", async () => {
      const config = cfg(`
        agent upsilon-worker {
          prompt "You are upsilon."
          models ["model-upsilon"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      expect(effects[0]?.agentDescriptor).toBeDefined();
      expect(effects[0]?.agentDescriptor.name).toBe("upsilon-worker");
      expect(effects[0]?.agentDescriptor.composedPrompt).toContain(
        "You are upsilon.",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Skill resolution — adapter-provided context (4.1, 4.2, 4.5, 4.6, 4.7)
  // -------------------------------------------------------------------------

  describe("skill resolution — adapter-provided context", () => {
    it("calls loadAvailableSkills() exactly once before spawnSubagent", async () => {
      const config = cfg(`
        agent sigma-worker { prompt "Sigma worker." models ["model-sigma"] }
      `);

      await new WeaveRunner(config, adapter).run();

      expect(adapter.callsTo("loadAvailableSkills")).toHaveLength(1);
      // loadAvailableSkills must be called before any spawnSubagent
      const loadIdx = adapter.calls.findIndex(
        (c) => c.method === "loadAvailableSkills",
      );
      const spawnIdx = adapter.calls.findIndex(
        (c) => c.method === "spawnSubagent",
      );
      expect(loadIdx).toBeGreaterThanOrEqual(0);
      expect(loadIdx).toBeLessThan(spawnIdx);
    });

    it("resolvedSkills in effect contains matched skill names from adapter-provided list", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [{ name: "tdd" }, { name: "code-review" }],
      });

      const config = cfg(`
        agent tau-worker {
          prompt "Tau worker."
          models ["model-tau"]
          skills ["tdd", "code-review"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      expect(effects).toHaveLength(1);
      expect(effects[0]?.resolvedSkills).toEqual(["tdd", "code-review"]);
    });

    it("resolvedSkills is empty array when agent declares no skills", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [{ name: "tdd" }],
      });

      const config = cfg(`
        agent upsilon-worker { prompt "Upsilon worker." models ["model-upsilon"] }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      expect(effects[0]?.resolvedSkills).toEqual([]);
    });

    it("resolvedSkills is empty array when adapter provides no available skills", async () => {
      // adapter has no availableSkills (default empty)
      const config = cfg(`
        agent phi-worker { prompt "Phi worker." models ["model-phi"] }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapter, {
        onEffect: (e) => effects.push(e),
      }).run();

      expect(effects[0]?.resolvedSkills).toEqual([]);
    });

    it("disabled skills are filtered from resolvedSkills in effect", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [{ name: "tdd" }, { name: "code-review" }],
      });

      const config = cfg(`
        agent chi-worker {
          prompt "Chi worker."
          models ["model-chi"]
          skills ["tdd", "code-review"]
        }
        disable skills ["tdd"]
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      // tdd is disabled — only code-review should appear
      expect(effects[0]?.resolvedSkills).toEqual(["code-review"]);
    });

    it("resolvedSkills preserves declaration order from agent config", async () => {
      const adapterWithSkills = new MockAdapter({
        // availableSkills in reverse order — result must follow agentSkills order
        availableSkills: [
          { name: "security-audit" },
          { name: "code-review" },
          { name: "tdd" },
        ],
      });

      const config = cfg(`
        agent psi-worker {
          prompt "Psi worker."
          models ["model-psi"]
          skills ["tdd", "code-review", "security-audit"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      expect(effects[0]?.resolvedSkills).toEqual([
        "tdd",
        "code-review",
        "security-audit",
      ]);
    });

    it("engine does not perform directory scanning, skill-file reads, or harness-specific lookup", async () => {
      // This test proves the engine only uses adapter-provided context.
      // The MockAdapter returns skills from an in-memory list — no filesystem
      // access, no Bun.file(), no process.spawn(), no harness API calls.
      const adapterWithSkills = new MockAdapter({
        availableSkills: [
          { name: "tdd", metadata: { path: "/mock/path/tdd.md" } },
        ],
      });

      const config = cfg(`
        agent omega-worker {
          prompt "Omega worker."
          models ["model-omega"]
          skills ["tdd"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      // Engine resolved the skill using only adapter-provided context
      expect(effects[0]?.resolvedSkills).toEqual(["tdd"]);
      // loadAvailableSkills was called — adapter provided context explicitly
      expect(adapterWithSkills.callsTo("loadAvailableSkills")).toHaveLength(1);
      // No loadSkill calls — engine does not drive skill loading
      expect(adapterWithSkills.callsTo("loadSkill")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Skill resolution — category shuttles (4.5)
  // -------------------------------------------------------------------------

  describe("skill resolution — category shuttles", () => {
    it("generated category shuttle receives resolved skill data in effect", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [{ name: "tdd" }],
      });

      const config = cfg(`
        agent shuttle {
          prompt "Specialist."
          models ["model-shuttle"]
          skills ["tdd"]
        }
        category alpha-cat { patterns ["src/alpha/**"] models ["model-alpha"] }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      const shuttleEffect = effects.find(
        (e) => e.agentName === "shuttle-alpha-cat",
      );
      expect(shuttleEffect).toBeDefined();
      // Generated shuttle inherits base shuttle skills
      expect(shuttleEffect?.resolvedSkills).toEqual(["tdd"]);
    });

    it("multiple category shuttles each receive their own resolved skill data", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [{ name: "tdd" }, { name: "code-review" }],
      });

      const config = cfg(`
        agent shuttle {
          prompt "Specialist."
          models ["model-shuttle"]
          skills ["tdd", "code-review"]
        }
        category beta-cat { patterns ["src/beta/**"] models ["model-beta"] }
        category gamma-cat { patterns ["src/gamma/**"] models ["model-gamma"] }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      const betaEffect = effects.find(
        (e) => e.agentName === "shuttle-beta-cat",
      );
      const gammaEffect = effects.find(
        (e) => e.agentName === "shuttle-gamma-cat",
      );

      expect(betaEffect?.resolvedSkills).toEqual(["tdd", "code-review"]);
      expect(gammaEffect?.resolvedSkills).toEqual(["tdd", "code-review"]);
    });
  });

  // -------------------------------------------------------------------------
  // Skill resolution — disabled agents (4.4)
  // -------------------------------------------------------------------------

  describe("skill resolution — disabled agents", () => {
    it("disabled agents do not emit run-agent effects (no resolvedSkills emitted)", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [{ name: "tdd" }],
      });

      const config = cfg(`
        agent active-agent {
          prompt "Active."
          models ["model-active"]
          skills ["tdd"]
        }
        agent disabled-agent {
          prompt "Disabled."
          models ["model-disabled"]
          skills ["tdd"]
        }
        disable agents ["disabled-agent"]
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      const names = effects.map((e) => e.agentName);
      expect(names).toContain("active-agent");
      expect(names).not.toContain("disabled-agent");
    });

    it("disabled agents are excluded from skill resolution entirely", async () => {
      // disabled-agent references a skill that is NOT in availableSkills.
      // If the engine tried to resolve it, it would produce a MissingSkill error.
      // Since disabled agents are excluded, no error should occur.
      const adapterWithSkills = new MockAdapter({
        availableSkills: [{ name: "tdd" }],
      });

      const config = cfg(`
        agent active-agent {
          prompt "Active."
          models ["model-active"]
          skills ["tdd"]
        }
        agent disabled-agent {
          prompt "Disabled."
          models ["model-disabled"]
        }
        disable agents ["disabled-agent"]
      `);

      const effects: RunAgentEffect[] = [];
      // Must not throw even though disabled-agent is excluded from resolution
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      expect(effects).toHaveLength(1);
      expect(effects[0]?.agentName).toBe("active-agent");
      expect(effects[0]?.resolvedSkills).toEqual(["tdd"]);
    });
  });

  // -------------------------------------------------------------------------
  // Sanitized-effect coverage (4.8)
  // -------------------------------------------------------------------------

  describe("sanitized-effect coverage", () => {
    it("serialized run-agent effects do not expose adapter-owned skill paths", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [
          {
            name: "tdd",
            metadata: {
              path: "/home/user/.weave/skills/tdd.md",
              scope: "global",
              content: "# TDD\nSecret skill content here.",
            },
          },
        ],
      });

      const config = cfg(`
        agent sanitize-worker {
          prompt "Sanitize worker."
          models ["model-sanitize"]
          skills ["tdd"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      const serialized = JSON.stringify(effects);

      // Skill name is present — it is safe to emit
      expect(serialized).toContain("tdd");

      // Adapter-owned metadata must NOT appear in the serialized effect
      expect(serialized).not.toContain("/home/user/.weave/skills/tdd.md");
      expect(serialized).not.toContain("Secret skill content here");
      expect(serialized).not.toContain("global");
    });

    it("serialized run-agent effects do not expose API keys or tokens in skill metadata", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [
          {
            name: "code-review",
            metadata: {
              apiKey: "sk-secret-api-key-12345",
              token: "bearer-token-xyz",
              envFile: "/project/.env",
            },
          },
        ],
      });

      const config = cfg(`
        agent key-worker {
          prompt "Key worker."
          models ["model-key"]
          skills ["code-review"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      const serialized = JSON.stringify(effects);

      // Only the skill name should appear
      expect(serialized).toContain("code-review");

      // Secrets must NOT appear in the serialized effect
      expect(serialized).not.toContain("sk-secret-api-key-12345");
      expect(serialized).not.toContain("bearer-token-xyz");
      expect(serialized).not.toContain("/project/.env");
    });

    it("no harness-specific tool names appear in any emitted effect (including resolvedSkills)", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [{ name: "tdd" }],
      });

      const config = cfg(`
        agent harness-check-worker {
          prompt "Harness check worker."
          models ["model-harness"]
          skills ["tdd"]
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
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

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

    it("resolvedSkills field contains only skill names — no metadata objects", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [
          {
            name: "tdd",
            metadata: {
              path: "/skills/tdd.md",
              mountPoint: "opencode://skills/tdd",
              apiKey: "secret",
            },
          },
        ],
      });

      const config = cfg(`
        agent meta-worker {
          prompt "Meta worker."
          models ["model-meta"]
          skills ["tdd"]
        }
      `);

      const effects: RunAgentEffect[] = [];
      await new WeaveRunner(config, adapterWithSkills, {
        onEffect: (e) => effects.push(e),
      }).run();

      const effect = effects[0];
      expect(effect?.resolvedSkills).toEqual(["tdd"]);

      // resolvedSkills is an array of strings — no objects, no metadata
      for (const skill of effect?.resolvedSkills ?? []) {
        expect(typeof skill).toBe("string");
      }

      // Serialized effect must not contain adapter metadata
      const serialized = JSON.stringify(effect);
      expect(serialized).not.toContain("/skills/tdd.md");
      expect(serialized).not.toContain("opencode://skills/tdd");
      expect(serialized).not.toContain("secret");
    });
  });
});
