import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weave/core";

import {
  composeAgentDescriptor,
  type MaterializationError,
  type MaterializationInput,
  type MaterializationPlan,
  type MaterializedAgent,
  materializeAgents,
} from "../index.js";

function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function materializeConfig(source: string): Promise<MaterializationPlan> {
  const result = await materializeAgents({ config: cfg(source) });
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function agentNames(plan: MaterializationPlan): string[] {
  return plan.agents.map((agent) => agent.agentName);
}

describe("materialization barrel exports", () => {
  it("exports the public function and types", () => {
    const publicFunction: typeof materializeAgents = materializeAgents;
    const input = {} as MaterializationInput;
    const agent = {} as MaterializedAgent;
    const plan = {} as MaterializationPlan;
    const error = {} as MaterializationError;

    expect(publicFunction).toBe(materializeAgents);
    expect(input).toBeDefined();
    expect(agent).toBeDefined();
    expect(plan).toBeDefined();
    expect(error).toBeDefined();
  });
});

describe("materializeAgents", () => {
  describe("builtin agents", () => {
    it("produces descriptors for builtin-named declared agents", async () => {
      const plan = await materializeConfig(`
        agent loom { prompt "{{agent.name}} builtin." models ["model-loom"] mode primary }
        agent tapestry { prompt "{{agent.name}} builtin." models ["model-tapestry"] mode primary }
        agent shuttle { prompt "{{agent.name}} builtin." models ["model-shuttle"] mode all }
        agent pattern { prompt "{{agent.name}} builtin." models ["model-pattern"] }
        agent thread { prompt "{{agent.name}} builtin." models ["model-thread"] }
        agent spindle { prompt "{{agent.name}} builtin." models ["model-spindle"] }
        agent weft { prompt "{{agent.name}} builtin." models ["model-weft"] }
        agent warp { prompt "{{agent.name}} builtin." models ["model-warp"] }
      `);

      expect(agentNames(plan)).toEqual([
        "loom",
        "tapestry",
        "shuttle",
        "pattern",
        "thread",
        "spindle",
        "weft",
        "warp",
      ]);
      expect(plan.agents.map((agent) => agent.descriptor.name)).toEqual(
        agentNames(plan),
      );
      expect(plan.agents[0]?.descriptor.composedPrompt).toBe("loom builtin.");
    });
  });

  describe("declared agents", () => {
    it("produces a descriptor for a single declared agent", async () => {
      const plan = await materializeConfig(`
        agent custom {
          prompt "Custom agent: {{agent.name}}"
          models ["model-custom"]
          temperature 0.4
        }
      `);

      expect(plan.agents).toHaveLength(1);
      expect(plan.agents[0]?.agentName).toBe("custom");
      expect(plan.agents[0]?.descriptor.name).toBe("custom");
      expect(plan.agents[0]?.descriptor.models).toEqual(["model-custom"]);
      expect(plan.agents[0]?.descriptor.temperature).toBe(0.4);
      expect(plan.agents[0]?.descriptor.composedPrompt).toBe(
        "Custom agent: custom",
      );
    });

    it("produces descriptors for multiple declared agents in config order", async () => {
      const plan = await materializeConfig(`
        agent alpha { prompt "Alpha" models ["model-alpha"] }
        agent beta { prompt "Beta" models ["model-beta"] }
        agent gamma { prompt "Gamma" models ["model-gamma"] }
      `);

      expect(agentNames(plan)).toEqual(["alpha", "beta", "gamma"]);
      expect(
        plan.agents.map((agent) => agent.descriptor.composedPrompt),
      ).toEqual(["Alpha", "Beta", "Gamma"]);
    });
  });

  describe("category shuttles", () => {
    it("includes generated shuttle-{name} agents after declared agents", async () => {
      const plan = await materializeConfig(`
        agent loom { prompt "Loom" models ["model-loom"] mode primary }
        agent shuttle { prompt "Base shuttle" models ["model-shuttle"] mode all }

        category frontend {
          patterns ["src/**/*.tsx"]
          models ["model-frontend"]
        }
      `);

      expect(agentNames(plan)).toEqual(["loom", "shuttle", "shuttle-frontend"]);
      expect(plan.agents[2]?.descriptor.name).toBe("shuttle-frontend");
      expect(plan.agents[2]?.descriptor.mode).toBe("subagent");
    });

    it("multiple categories produce multiple shuttles in stable order", async () => {
      const plan = await materializeConfig(`
        agent shuttle { prompt "Base shuttle" models ["model-shuttle"] mode all }

        category frontend { patterns ["src/**/*.tsx"] models ["model-frontend"] }
        category backend { patterns ["src/**/*.ts"] models ["model-backend"] }
        category docs { patterns ["docs/**/*.md"] models ["model-docs"] }
      `);

      expect(agentNames(plan)).toEqual([
        "shuttle",
        "shuttle-frontend",
        "shuttle-backend",
        "shuttle-docs",
      ]);
    });

    it("category shuttle descriptor carries category models", async () => {
      const plan = await materializeConfig(`
        agent shuttle { prompt "Base shuttle" models ["model-shuttle"] mode all }

        category frontend {
          description "Frontend UI"
          patterns ["src/**/*.tsx"]
          models ["model-frontend-a", "model-frontend-b"]
        }
      `);

      const frontend = plan.agents.find(
        (agent) => agent.agentName === "shuttle-frontend",
      );

      expect(frontend?.descriptor.models).toEqual([
        "model-frontend-a",
        "model-frontend-b",
      ]);
    });

    it("does not mark explicit shuttle-* agents as category shuttles by prefix", async () => {
      const plan = await materializeConfig(`
        agent shuttle-frontend {
          prompt "{{#agent.isCategory}}category{{/agent.isCategory}}{{^agent.isCategory}}not-category{{/agent.isCategory}}|{{#category}}category={{category.name}}{{/category}}{{^category}}no-category{{/category}}"
          models ["model-explicit"]
        }
      `);

      expect(agentNames(plan)).toEqual(["shuttle-frontend"]);
      expect(plan.agents[0]?.descriptor.composedPrompt).toBe(
        "not-category|no-category",
      );
    });

    it("does not mark explicit shuttle-* agents as generated when base shuttle is disabled", async () => {
      const plan = await materializeConfig(`
        agent shuttle { prompt "Base shuttle" models ["model-shuttle"] mode all }
        agent shuttle-frontend {
          prompt "{{#agent.isCategory}}category{{/agent.isCategory}}{{^agent.isCategory}}not-category{{/agent.isCategory}}|{{#category}}category={{category.name}}{{/category}}{{^category}}no-category{{/category}}"
          models ["model-explicit"]
        }

        category frontend {
          patterns ["src/**/*.tsx"]
          models ["model-frontend"]
        }

        disable agents ["shuttle"]
      `);

      expect(agentNames(plan)).toEqual(["shuttle-frontend"]);
      expect(plan.agents[0]?.descriptor.composedPrompt).toBe(
        "not-category|no-category",
      );
    });
  });

  describe("disabled agents", () => {
    it("excludes disabled declared agents from the plan", async () => {
      const plan = await materializeConfig(`
        agent loom { prompt "Loom" models ["model-loom"] }
        agent warp { prompt "Warp" models ["model-warp"] }
        disable agents ["warp"]
      `);

      expect(agentNames(plan)).toEqual(["loom"]);
    });

    it("excludes all shuttle-* when base shuttle is disabled", async () => {
      const plan = await materializeConfig(`
        agent loom { prompt "Loom" models ["model-loom"] }
        agent shuttle { prompt "Base shuttle" models ["model-shuttle"] mode all }

        category frontend { patterns ["src/**/*.tsx"] models ["model-frontend"] }
        category backend { patterns ["src/**/*.ts"] models ["model-backend"] }

        disable agents ["shuttle"]
      `);

      expect(agentNames(plan)).toEqual(["loom"]);
    });

    it("excludes a specific shuttle-{name} when it is in disabled.agents", async () => {
      const plan = await materializeConfig(`
        agent shuttle { prompt "Base shuttle" models ["model-shuttle"] mode all }

        category frontend { patterns ["src/**/*.tsx"] models ["model-frontend"] }
        category backend { patterns ["src/**/*.ts"] models ["model-backend"] }

        disable agents ["shuttle-frontend"]
      `);

      expect(agentNames(plan)).toEqual(["shuttle", "shuttle-backend"]);
    });
  });

  describe("no-adapter-dispatch", () => {
    it("materializeAgents runs without constructing a HarnessAdapter", async () => {
      const result = await materializeAgents({
        config: cfg(`
          agent loom { prompt "Loom" models ["model-loom"] }
        `),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(agentNames(result.value)).toEqual(["loom"]);
    });

    it("materializeAgents returns a plan without requiring a HarnessAdapter", async () => {
      // materializeAgents accepts no HarnessAdapter parameter — the only way to
      // verify it never calls spawnSubagent is to confirm the public API has no
      // adapter parameter and that the returned plan contains the expected agents.
      const result = await materializeAgents({
        config: cfg(`
          agent loom { prompt "Loom" models ["model-loom"] }
          agent shuttle { prompt "Shuttle" models ["model-shuttle"] mode all }
          category frontend { patterns ["src/**/*.tsx"] models ["model-frontend"] }
        `),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Declared agents appear before generated category shuttles.
        expect(agentNames(result.value)).toEqual([
          "loom",
          "shuttle",
          "shuttle-frontend",
        ]);
        // Each entry carries a composed descriptor — no adapter side-effects needed.
        for (const { agentName, descriptor } of result.value.agents) {
          expect(descriptor.name).toBe(agentName);
          expect(descriptor.composedPrompt.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("ordering", () => {
    it("declared agents appear before generated category shuttles", async () => {
      const plan = await materializeConfig(`
        agent alpha { prompt "Alpha" models ["model-alpha"] }
        agent shuttle { prompt "Shuttle" models ["model-shuttle"] mode all }
        agent omega { prompt "Omega" models ["model-omega"] }

        category frontend { patterns ["src/**/*.tsx"] models ["model-frontend"] }
        category backend { patterns ["src/**/*.ts"] models ["model-backend"] }
      `);

      expect(agentNames(plan)).toEqual([
        "alpha",
        "shuttle",
        "omega",
        "shuttle-frontend",
        "shuttle-backend",
      ]);
    });

    it("repeated calls produce the same agent order", async () => {
      const config = cfg(`
        agent alpha { prompt "Alpha" models ["model-alpha"] }
        agent shuttle { prompt "Shuttle" models ["model-shuttle"] mode all }
        agent omega { prompt "Omega" models ["model-omega"] }

        category frontend { patterns ["src/**/*.tsx"] models ["model-frontend"] }
        category backend { patterns ["src/**/*.ts"] models ["model-backend"] }
        category docs { patterns ["docs/**/*.md"] models ["model-docs"] }
      `);

      const first = await materializeAgents({ config });
      const second = await materializeAgents({ config });

      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);
      if (first.isErr() || second.isErr()) return;
      expect(agentNames(first.value)).toEqual(agentNames(second.value));
      expect(agentNames(first.value)).toEqual([
        "alpha",
        "shuttle",
        "omega",
        "shuttle-frontend",
        "shuttle-backend",
        "shuttle-docs",
      ]);
    });
  });

  describe("typed failures", () => {
    it("returns CategoryShuttleConflict error when explicit agent collides with generated shuttle", async () => {
      const result = await materializeAgents({
        config: cfg(`
          agent shuttle { prompt "Base shuttle" models ["model-shuttle"] mode all }
          agent shuttle-frontend { prompt "Explicit frontend" models ["model-explicit"] }

          category frontend { patterns ["src/**/*.tsx"] models ["model-frontend"] }
        `),
      });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error.type).toBe("CategoryShuttleConflict");
      if (result.error.type !== "CategoryShuttleConflict") return;
      expect(result.error.conflict).toEqual({
        type: "CategoryShuttleConflictError",
        shuttleName: "shuttle-frontend",
        categoryName: "frontend",
        message:
          'Agent "shuttle-frontend" is explicitly declared and would also be generated from category "frontend". Remove the explicit agent declaration or rename the category.',
      });
    });

    it("returns DescriptorCompositionFailure when agent has no prompt source", async () => {
      const result = await materializeAgents({
        config: cfg(`
          agent broken { models ["model-broken"] }
        `),
      });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error.type).toBe("DescriptorCompositionFailure");
      if (result.error.type !== "DescriptorCompositionFailure") return;
      expect(result.error.agentName).toBe("broken");
      expect(result.error.cause.type).toBe("PromptSourceMissingError");
      expect(result.error.cause.agentName).toBe("broken");
    });

    it("DescriptorCompositionFailure includes the affected agentName", async () => {
      const result = await materializeAgents({
        config: cfg(`
          agent alpha { prompt "Alpha" models ["model-alpha"] }
          agent broken { models ["model-broken"] }
          agent omega { prompt "Omega" models ["model-omega"] }
        `),
      });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error).toMatchObject({
        type: "DescriptorCompositionFailure",
        agentName: "broken",
        cause: { agentName: "broken" },
      });
    });

    it("does not throw on category shuttle conflict — returns err instead", async () => {
      const result = await materializeAgents({
        config: cfg(`
          agent shuttle { prompt "Base shuttle" models ["model-shuttle"] mode all }
          agent shuttle-frontend { prompt "Explicit frontend" models ["model-explicit"] }

          category frontend { patterns ["src/**/*.tsx"] models ["model-frontend"] }
        `),
      });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error.type).toBe("CategoryShuttleConflict");
    });
  });

  describe("descriptor compatibility", () => {
    it("materialized descriptor fields match direct composeAgentDescriptor output", async () => {
      const config = cfg(`
        agent representative {
          prompt "Representative {{agent.name}} uses {{toolPolicy.effective.read}} reads."
          models ["model-a", "model-b"]
          mode subagent
          temperature 0.2

          tool_policy {
            read allow
            write ask
            execute deny
            delegate deny
          }
        }
      `);

      const materialized = await materializeAgents({ config });
      const direct = await composeAgentDescriptor(
        "representative",
        config.agents.representative!,
        config,
        config.agents,
      );

      expect(materialized.isOk()).toBe(true);
      expect(direct.isOk()).toBe(true);
      if (materialized.isErr() || direct.isErr()) return;

      const descriptor = materialized.value.agents[0]?.descriptor;
      expect(descriptor).toBeDefined();
      expect(descriptor?.name).toBe(direct.value.name);
      expect(descriptor?.models).toEqual(direct.value.models);
      expect(descriptor?.mode).toBe(direct.value.mode);
      expect(descriptor?.composedPrompt).toBe(direct.value.composedPrompt);
      expect(descriptor?.effectiveToolPolicy).toEqual(
        direct.value.effectiveToolPolicy,
      );
    });
  });
});
