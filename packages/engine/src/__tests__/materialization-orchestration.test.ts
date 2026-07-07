/**
 * Materialization Orchestration Tests
 *
 * Exercises the canonical adapter bootstrap pattern:
 *   adapter.init() → adapter.loadAvailableSkills() → materializeAgents({ config })
 *   → read plan.agents and plan.errors → loop calling adapter.spawnSubagent(descriptor)
 *
 * This replaces the deleted WeaveRunner-based runner.test.ts. All tests use
 * the `orchestrate()` helper defined below — no WeaveRunner anywhere.
 *
 * Per-agent failures (CategoryShuttleConflict, DescriptorCompositionFailure)
 * are read from `plan.errors`, not from a top-level Result rejection.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";
import {
  type MaterializationError,
  type MaterializationPlan,
  type MaterializedAgent,
  materializeAgents,
  resolveSkillsForConfig,
} from "@weaveio/weave-engine";
import { MockAdapter } from "./mock-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a .weave source string and unwrap — throws on invalid input. */
function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/**
 * Canonical adapter bootstrap pattern.
 *
 * Performs:
 *   1. adapter.init()
 *   2. adapter.loadAvailableSkills()
 *   3. materializeAgents({ config })
 *   4. Read plan.agents and plan.errors
 *   5. Loop calling adapter.spawnSubagent(descriptor) for each agent
 *
 * Returns the full MaterializationPlan so tests can inspect plan.errors.
 */
async function orchestrate(
  config: WeaveConfig,
  adapter: MockAdapter,
): Promise<MaterializationPlan> {
  await adapter.init();
  await adapter.loadAvailableSkills();

  // materializeAgents returns ResultAsync<MaterializationPlan, never> —
  // the outer Result never rejects; unwrap unconditionally.
  const plan = (await materializeAgents({ config }))._unsafeUnwrap();

  for (const { descriptor } of plan.agents) {
    await adapter.spawnSubagent(descriptor);
  }

  return plan;
}

/**
 * Respects the adapter lifecycle contract: init() must be called before
 * loadAvailableSkills(). Use this helper in all tests that call
 * loadAvailableSkills() directly (i.e. outside of orchestrate()).
 */
async function initAndLoadAvailableSkills(adapter: MockAdapter) {
  await adapter.init();
  return adapter.loadAvailableSkills();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("materialization orchestration", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  // -------------------------------------------------------------------------
  // Lifecycle ordering
  // -------------------------------------------------------------------------

  describe("lifecycle ordering", () => {
    it("calls init exactly once before spawning any agent", async () => {
      const config = cfg(`
        agent loom {
          prompt "You are loom."
          models ["claude-sonnet-4-5"]
        }
      `);

      await orchestrate(config, adapter);

      const allCalls = adapter.calls.map((c) => c.method);
      expect(allCalls[0]).toBe("init");
      expect(adapter.callsTo("init")).toHaveLength(1);
    });

    it("completes without error on an empty config", async () => {
      await orchestrate(cfg(""), adapter);

      expect(adapter.callsTo("init")).toHaveLength(1);
      expect(adapter.callsTo("spawnSubagent")).toHaveLength(0);
    });

    it("init always precedes spawnSubagent calls", async () => {
      const config = cfg(`
        agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
      `);

      await orchestrate(config, adapter);

      const initIdx = adapter.calls.findIndex((c) => c.method === "init");
      const spawnIdx = adapter.calls.findIndex(
        (c) => c.method === "spawnSubagent",
      );
      expect(initIdx).toBeLessThan(spawnIdx);
    });

    it("loadAvailableSkills is called exactly once before spawnSubagent", async () => {
      const config = cfg(`
        agent sigma-worker { prompt "Sigma worker." models ["model-sigma"] }
      `);

      await orchestrate(config, adapter);

      expect(adapter.callsTo("loadAvailableSkills")).toHaveLength(1);
      const loadIdx = adapter.calls.findIndex(
        (c) => c.method === "loadAvailableSkills",
      );
      const spawnIdx = adapter.calls.findIndex(
        (c) => c.method === "spawnSubagent",
      );
      expect(loadIdx).toBeGreaterThanOrEqual(0);
      expect(loadIdx).toBeLessThan(spawnIdx);
    });

    it("init is called before loadAvailableSkills", async () => {
      const config = cfg(`
        agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
      `);

      await orchestrate(config, adapter);

      const initIdx = adapter.calls.findIndex((c) => c.method === "init");
      const loadIdx = adapter.calls.findIndex(
        (c) => c.method === "loadAvailableSkills",
      );
      expect(initIdx).toBe(0);
      expect(initIdx).toBeLessThan(loadIdx);
    });

    it("still calls init even when all agents are disabled", async () => {
      const config = cfg(`
        agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
        disable agents ["loom"]
      `);

      await orchestrate(config, adapter);

      expect(adapter.callsTo("init")).toHaveLength(1);
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

      await orchestrate(config, adapter);

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

      await orchestrate(config, adapter);

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

      await orchestrate(config, adapter);

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

      await orchestrate(config, adapter);

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

      await orchestrate(config, adapter);

      expect(adapter.callsTo("spawnSubagent")).toHaveLength(0);
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

      await orchestrate(config, adapter);

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

      await orchestrate(config, adapter);

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

      await orchestrate(config, adapter);

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

      await orchestrate(config, adapter);

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

      await orchestrate(config, adapter);

      const spawned = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle-frontend");
      expect(spawned?.descriptor.models).toEqual(["gpt-5"]);
    });

    it("adapter-facing descriptors omit disabled agents and include category metadata only for generated shuttles", async () => {
      const config = cfg(`
        agent loom { prompt "Orchestrator." models ["model-loom"] }
        agent warp { prompt "Reviewer." models ["model-warp"] }
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category frontend {
          description "Frontend UI"
          patterns ["src/components/**", "src/pages/**/*.tsx"]
          models ["model-frontend"]
        }
        category backend {
          description "Backend APIs"
          patterns ["src/api/**"]
          models ["model-backend"]
        }
        disable agents ["warp", "shuttle-backend"]
      `);

      await orchestrate(config, adapter);

      const descriptors = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor);
      const names = descriptors.map((descriptor) => descriptor.name);
      const loom = descriptors.find((descriptor) => descriptor.name === "loom");
      const base = descriptors.find(
        (descriptor) => descriptor.name === "shuttle",
      );
      const frontend = descriptors.find(
        (descriptor) => descriptor.name === "shuttle-frontend",
      );

      expect(names).toContain("loom");
      expect(names).toContain("shuttle");
      expect(names).toContain("shuttle-frontend");
      expect(names).not.toContain("warp");
      expect(names).not.toContain("shuttle-backend");
      expect(loom?.category).toBeUndefined();
      expect(base?.category).toBeUndefined();
      expect(frontend?.category).toEqual({
        name: "frontend",
        description: "Frontend UI",
        patterns: ["src/components/**", "src/pages/**/*.tsx"],
      });
    });

    it("plan.errors contains a CategoryShuttleConflict when a category would generate a name that is already explicitly declared", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["claude-sonnet-4-5"] }
        agent shuttle-frontend { prompt "Explicit." models ["gpt-4o"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
      `);

      const plan = await orchestrate(config, adapter);

      const conflictErrors = plan.errors.filter(
        (
          e,
        ): e is Extract<
          MaterializationError,
          { type: "CategoryShuttleConflict" }
        > => e.type === "CategoryShuttleConflict",
      );
      expect(conflictErrors).toHaveLength(1);
      expect(conflictErrors[0]?.conflict.shuttleName).toBe("shuttle-frontend");
      expect(conflictErrors[0]?.conflict.categoryName).toBe("frontend");
    });
  });

  // -------------------------------------------------------------------------
  // Descriptor fields — effectiveToolPolicy and rawToolPolicy
  // -------------------------------------------------------------------------

  describe("descriptor tool policy", () => {
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

      await orchestrate(config, adapter);

      const spawned = adapter.callsTo("spawnSubagent");
      const descriptor = spawned[0]?.descriptor;
      expect(descriptor?.effectiveToolPolicy.read).toBe("allow");
      expect(descriptor?.effectiveToolPolicy.write).toBe("deny");
      expect(descriptor?.effectiveToolPolicy.execute).toBe("ask");
      expect(descriptor?.effectiveToolPolicy.delegate).toBe("deny");
      expect(descriptor?.effectiveToolPolicy.network).toBe("allow");
    });

    it("rawToolPolicy in descriptor matches the agent's declared tool_policy", async () => {
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

      await orchestrate(config, adapter);

      const descriptor = adapter.callsTo("spawnSubagent")[0]?.descriptor;
      expect(descriptor?.rawToolPolicy?.read).toBe("allow");
      expect(descriptor?.rawToolPolicy?.write).toBe("allow");
      expect(descriptor?.rawToolPolicy?.execute).toBe("deny");
      expect(descriptor?.rawToolPolicy?.delegate).toBe("deny");
      expect(descriptor?.rawToolPolicy?.network).toBe("deny");
    });

    it("agent with no tool_policy: effectiveToolPolicy defaults all capabilities to ask", async () => {
      const config = cfg(`
        agent delta-worker {
          prompt "Delta worker agent."
          models ["model-d"]
        }
      `);

      await orchestrate(config, adapter);

      const descriptor = adapter.callsTo("spawnSubagent")[0]?.descriptor;
      expect(descriptor?.effectiveToolPolicy.read).toBe("ask");
      expect(descriptor?.effectiveToolPolicy.write).toBe("ask");
      expect(descriptor?.effectiveToolPolicy.execute).toBe("ask");
      expect(descriptor?.effectiveToolPolicy.delegate).toBe("ask");
      expect(descriptor?.effectiveToolPolicy.network).toBe("ask");
    });

    it("agent with no tool_policy: rawToolPolicy is undefined", async () => {
      const config = cfg(`
        agent epsilon-worker {
          prompt "Epsilon worker agent."
          models ["model-e"]
        }
      `);

      await orchestrate(config, adapter);

      const descriptor = adapter.callsTo("spawnSubagent")[0]?.descriptor;
      expect(descriptor?.rawToolPolicy).toBeUndefined();
    });

    it("no harness-specific tool names appear in any spawned descriptor", async () => {
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

      await orchestrate(config, adapter);

      const spawned = adapter.callsTo("spawnSubagent");
      const serialized = JSON.stringify(spawned);
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
  // Category shuttle — tool policy
  // -------------------------------------------------------------------------

  describe("category shuttle tool policy", () => {
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

      await orchestrate(config, adapter);

      const shuttleDescriptor = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle-lambda")?.descriptor;
      expect(shuttleDescriptor?.effectiveToolPolicy.read).toBe("allow");
      expect(shuttleDescriptor?.effectiveToolPolicy.write).toBe("deny");
      expect(shuttleDescriptor?.effectiveToolPolicy.execute).toBe("deny");
      expect(shuttleDescriptor?.effectiveToolPolicy.delegate).toBe("deny");
      expect(shuttleDescriptor?.effectiveToolPolicy.network).toBe("deny");
    });

    it("category shuttle with no tool_policy: effectiveToolPolicy defaults all to ask", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category mu { patterns ["src/mu/**"] models ["model-mu"] }
      `);

      await orchestrate(config, adapter);

      const shuttleDescriptor = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle-mu")?.descriptor;
      expect(shuttleDescriptor?.effectiveToolPolicy.read).toBe("ask");
      expect(shuttleDescriptor?.effectiveToolPolicy.write).toBe("ask");
      expect(shuttleDescriptor?.effectiveToolPolicy.execute).toBe("ask");
      expect(shuttleDescriptor?.effectiveToolPolicy.delegate).toBe("ask");
      expect(shuttleDescriptor?.effectiveToolPolicy.network).toBe("ask");
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

      await orchestrate(config, adapter);

      const shuttleDescriptor = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle-nu")?.descriptor;
      expect(shuttleDescriptor?.rawToolPolicy?.read).toBe("allow");
      expect(shuttleDescriptor?.rawToolPolicy?.write).toBe("allow");
      expect(shuttleDescriptor?.rawToolPolicy?.execute).toBe("ask");
      expect(shuttleDescriptor?.rawToolPolicy?.delegate).toBe("deny");
      expect(shuttleDescriptor?.rawToolPolicy?.network).toBe("deny");
    });

    it("category shuttle with no tool_policy: rawToolPolicy is undefined", async () => {
      const config = cfg(`
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category xi { patterns ["src/xi/**"] models ["model-xi"] }
      `);

      await orchestrate(config, adapter);

      const shuttleDescriptor = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle-xi")?.descriptor;
      expect(shuttleDescriptor?.rawToolPolicy).toBeUndefined();
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

      await orchestrate(config, adapter);

      const shuttleDescriptor = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle-omicron")?.descriptor;
      expect(shuttleDescriptor?.rawToolPolicy?.read).toBe("allow");
      expect(shuttleDescriptor?.rawToolPolicy?.write).toBe("allow");
      expect(shuttleDescriptor?.rawToolPolicy?.execute).toBe("deny");
      expect(shuttleDescriptor?.rawToolPolicy?.delegate).toBe("deny");
      expect(shuttleDescriptor?.rawToolPolicy?.network).toBe("deny");
    });

    it("category descriptor carries category metadata", async () => {
      const config = cfg(`
        agent worker { prompt "Regular." models ["model-worker"] }
        agent shuttle { prompt "Specialist." models ["model-shuttle"] }
        category frontend {
          description "Frontend UI, styling, accessibility"
          patterns ["src/components/**", "**/*.tsx"]
          models ["model-frontend"]
        }
      `);

      await orchestrate(config, adapter);

      const shuttleDescriptor = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "shuttle-frontend")?.descriptor;
      const workerDescriptor = adapter
        .callsTo("spawnSubagent")
        .find((c) => c.descriptor.name === "worker")?.descriptor;

      expect(shuttleDescriptor?.category).toEqual({
        name: "frontend",
        description: "Frontend UI, styling, accessibility",
        patterns: ["src/components/**", "**/*.tsx"],
      });
      expect(workerDescriptor?.category).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Prompt composition
  // -------------------------------------------------------------------------

  describe("prompt composition", () => {
    it("composedPrompt contains the inline prompt text", async () => {
      const config = cfg(`
        agent sigma-worker {
          prompt "You are sigma."
          models ["model-sigma"]
        }
      `);

      await orchestrate(config, adapter);

      const spawned = adapter.callsTo("spawnSubagent");
      expect(spawned[0]?.descriptor.composedPrompt).toContain("You are sigma.");
    });

    it("composition error for one agent does not prevent others from spawning", async () => {
      const config = cfg(`
        agent tau-one { prompt "Tau one." models ["model-tau-1"] }
        agent tau-two { prompt_file "nonexistent/missing-prompt.md" models ["model-tau-2"] }
      `);

      const plan = await orchestrate(config, adapter);

      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
      expect(names).toContain("tau-one");
      expect(names).not.toContain("tau-two");

      // Composition failure is recorded in plan.errors
      const compositionErrors = plan.errors.filter(
        (
          e,
        ): e is Extract<
          MaterializationError,
          { type: "DescriptorCompositionFailure" }
        > => e.type === "DescriptorCompositionFailure",
      );
      expect(compositionErrors).toHaveLength(1);
      expect(compositionErrors[0]?.agentName).toBe("tau-two");
    });
  });

  // -------------------------------------------------------------------------
  // Skill resolution — adapter-provided context
  // -------------------------------------------------------------------------

  describe("skill resolution — adapter-provided context", () => {
    it("resolvedSkills contains matched skill names from adapter-provided list", async () => {
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

      await adapterWithSkills.init();
      const availableSkills = await adapterWithSkills.loadAvailableSkills();
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      const resolved = skillResult.value["tau-worker"];
      expect(resolved?.map((s) => s.name)).toEqual(["tdd", "code-review"]);
    });

    it("resolvedSkills is empty array when agent declares no skills", async () => {
      const adapterWithSkills = new MockAdapter({
        availableSkills: [{ name: "tdd" }],
      });

      const config = cfg(`
        agent upsilon-worker { prompt "Upsilon worker." models ["model-upsilon"] }
      `);

      const availableSkills =
        await initAndLoadAvailableSkills(adapterWithSkills);
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      const resolved = skillResult.value["upsilon-worker"];
      expect(resolved).toEqual([]);
    });

    it("resolvedSkills is empty array when adapter provides no available skills", async () => {
      const config = cfg(`
        agent phi-worker { prompt "Phi worker." models ["model-phi"] }
      `);

      const availableSkills = await initAndLoadAvailableSkills(adapter);
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      const resolved = skillResult.value["phi-worker"];
      expect(resolved).toEqual([]);
    });

    it("disabled skills are filtered from resolvedSkills", async () => {
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

      const availableSkills =
        await initAndLoadAvailableSkills(adapterWithSkills);
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      const resolved = skillResult.value["chi-worker"];
      // tdd is disabled — only code-review should appear
      expect(resolved?.map((s) => s.name)).toEqual(["code-review"]);
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

      const availableSkills =
        await initAndLoadAvailableSkills(adapterWithSkills);
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      const resolved = skillResult.value["psi-worker"];
      expect(resolved?.map((s) => s.name)).toEqual([
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

      const availableSkills =
        await initAndLoadAvailableSkills(adapterWithSkills);
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      // Engine resolved the skill using only adapter-provided context
      const resolved = skillResult.value["omega-worker"];
      expect(resolved?.map((s) => s.name)).toEqual(["tdd"]);
      // loadAvailableSkills was called — adapter provided context explicitly
      expect(adapterWithSkills.callsTo("loadAvailableSkills")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Skill resolution — category shuttles
  // -------------------------------------------------------------------------

  describe("skill resolution — category shuttles", () => {
    it("generated category shuttle receives resolved skill data", async () => {
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

      const availableSkills =
        await initAndLoadAvailableSkills(adapterWithSkills);
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      // Generated shuttle inherits base shuttle skills
      const resolved = skillResult.value["shuttle-alpha-cat"];
      expect(resolved?.map((s) => s.name)).toEqual(["tdd"]);
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

      const availableSkills =
        await initAndLoadAvailableSkills(adapterWithSkills);
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      const betaResolved = skillResult.value["shuttle-beta-cat"];
      const gammaResolved = skillResult.value["shuttle-gamma-cat"];

      expect(betaResolved?.map((s) => s.name)).toEqual(["tdd", "code-review"]);
      expect(gammaResolved?.map((s) => s.name)).toEqual(["tdd", "code-review"]);
    });
  });

  // -------------------------------------------------------------------------
  // Skill resolution — disabled agents
  // -------------------------------------------------------------------------

  describe("skill resolution — disabled agents", () => {
    it("disabled agents are excluded from skill resolution entirely", async () => {
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

      const availableSkills =
        await initAndLoadAvailableSkills(adapterWithSkills);
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      // active-agent is resolved
      expect(skillResult.value["active-agent"]?.map((s) => s.name)).toEqual([
        "tdd",
      ]);
      // disabled-agent is excluded from resolution
      expect(skillResult.value["disabled-agent"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Sanitized descriptor coverage
  // -------------------------------------------------------------------------

  describe("sanitized descriptor coverage", () => {
    it("serialized descriptors do not expose adapter-owned skill paths", async () => {
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

      await orchestrate(config, adapterWithSkills);

      const spawned = adapterWithSkills.callsTo("spawnSubagent");
      const serialized = JSON.stringify(spawned);

      // Agent name is present — it is safe to emit
      expect(serialized).toContain("sanitize-worker");

      // Adapter-owned metadata must NOT appear in the serialized descriptor
      expect(serialized).not.toContain("/home/user/.weave/skills/tdd.md");
      expect(serialized).not.toContain("Secret skill content here");
      expect(serialized).not.toContain("global");
    });

    it("serialized descriptors do not expose API keys or tokens in skill metadata", async () => {
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

      await orchestrate(config, adapterWithSkills);

      const spawned = adapterWithSkills.callsTo("spawnSubagent");
      const serialized = JSON.stringify(spawned);

      // Only the agent name should appear
      expect(serialized).toContain("key-worker");

      // Secrets must NOT appear in the serialized descriptor
      expect(serialized).not.toContain("sk-secret-api-key-12345");
      expect(serialized).not.toContain("bearer-token-xyz");
      expect(serialized).not.toContain("/project/.env");
    });

    it("no harness-specific tool names appear in any spawned descriptor (including skills)", async () => {
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

      await orchestrate(config, adapterWithSkills);

      const spawned = adapterWithSkills.callsTo("spawnSubagent");
      const serialized = JSON.stringify(spawned);
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

      const availableSkills =
        await initAndLoadAvailableSkills(adapterWithSkills);
      const skillResult = resolveSkillsForConfig({ config, availableSkills });
      expect(skillResult.isOk()).toBe(true);
      if (!skillResult.isOk()) return;

      const resolved = skillResult.value["meta-worker"];
      expect(resolved?.map((s) => s.name)).toEqual(["tdd"]);

      // resolvedSkills names are strings — no objects, no metadata
      for (const skill of resolved ?? []) {
        expect(typeof skill.name).toBe("string");
      }

      // Serialized skill names must not contain adapter metadata
      const serialized = JSON.stringify(resolved?.map((s) => s.name));
      expect(serialized).not.toContain("/skills/tdd.md");
      expect(serialized).not.toContain("opencode://skills/tdd");
      expect(serialized).not.toContain("secret");
    });
  });

  // -------------------------------------------------------------------------
  // plan.errors — DescriptorCompositionFailure tolerance
  // -------------------------------------------------------------------------

  describe("plan.errors — composition failure tolerance", () => {
    it("plan.errors is empty when all agents compose successfully", async () => {
      const config = cfg(`
        agent loom { prompt "Orchestrator." models ["claude-sonnet-4-5"] }
        agent shuttle { prompt "Specialist." models ["claude-sonnet-4-5"] }
      `);

      const plan = await orchestrate(config, adapter);

      expect(plan.errors).toHaveLength(0);
    });

    it("plan.errors accumulates DescriptorCompositionFailure for agents with missing prompt_file", async () => {
      const config = cfg(`
        agent good-agent { prompt "Good." models ["model-good"] }
        agent bad-agent { prompt_file "nonexistent/missing.md" models ["model-bad"] }
      `);

      const plan = await orchestrate(config, adapter);

      const failures = plan.errors.filter(
        (
          e,
        ): e is Extract<
          MaterializationError,
          { type: "DescriptorCompositionFailure" }
        > => e.type === "DescriptorCompositionFailure",
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.agentName).toBe("bad-agent");
    });

    it("agents with composition failures are not spawned", async () => {
      const config = cfg(`
        agent good-agent { prompt "Good." models ["model-good"] }
        agent bad-agent { prompt_file "nonexistent/missing.md" models ["model-bad"] }
      `);

      await orchestrate(config, adapter);

      const names = adapter
        .callsTo("spawnSubagent")
        .map((c) => c.descriptor.name);
      expect(names).toContain("good-agent");
      expect(names).not.toContain("bad-agent");
    });

    it("plan.errors is empty when config is empty", async () => {
      const plan = await orchestrate(cfg(""), adapter);
      expect(plan.errors).toHaveLength(0);
    });
  });
});
