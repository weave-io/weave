/**
 * DSL scenarios — category routing.
 *
 * Bucket: DSL. The black box is `.weave` source text. Input is a config a user
 * could have typed; output is the set of agents Weave hands an adapter. No
 * internal module is imported and no harness is involved.
 */

import { describe, expect, it } from "bun:test";
import { agent, agentNames, whenMaterialized } from "../support/scenario.js";

describe("a team splits work across frontend and backend categories", () => {
  /**
   * The config a user writes when they want package-specific specialists
   * without declaring an agent for each one by hand.
   */
  const config = `
    agent loom {
      prompt "You are Loom, the orchestrator."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary
    }

    agent shuttle {
      prompt "You are Shuttle, a domain specialist."
      models ["anthropic/claude-sonnet-4-5"]
      mode all
    }

    category frontend {
      description "Frontend UI, styling, accessibility"
      models ["openai/gpt-5"]
      prompt_append "Preserve accessibility and design-system consistency."
    }

    category backend {
      description "Backend APIs, services, persistence"
      models ["anthropic/claude-opus-4-1"]
    }
  `;

  it("gives the user one shuttle per category, after their declared agents", async () => {
    const plan = await whenMaterialized(config);

    expect(agentNames(plan)).toEqual([
      "loom",
      "shuttle",
      "shuttle-frontend",
      "shuttle-backend",
    ]);
  });

  it("routes each category to the model that category declared, not the base shuttle's", async () => {
    const plan = await whenMaterialized(config);

    expect(agent(plan, "shuttle-frontend").descriptor.models).toEqual([
      "openai/gpt-5",
    ]);
    expect(agent(plan, "shuttle-backend").descriptor.models).toEqual([
      "anthropic/claude-opus-4-1",
    ]);
    expect(agent(plan, "shuttle").descriptor.models).toEqual([
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("gives each category shuttle the base shuttle's prompt plus its own guidance", async () => {
    const plan = await whenMaterialized(config);
    const frontend = agent(plan, "shuttle-frontend").descriptor.composedPrompt;

    expect(frontend).toContain("You are Shuttle, a domain specialist.");
    expect(frontend).toContain(
      "Preserve accessibility and design-system consistency.",
    );
  });

  it("makes category shuttles delegatable targets, never primary agents", async () => {
    const plan = await whenMaterialized(config);

    expect(agent(plan, "shuttle-frontend").descriptor.mode).toBe("subagent");
    expect(agent(plan, "shuttle-backend").descriptor.mode).toBe("subagent");
  });
});

describe("a user turns off the shuttle agent entirely", () => {
  it("removes every category shuttle with it, so no orphaned routes remain", async () => {
    const plan = await whenMaterialized(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary
      }

      agent shuttle {
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode all
      }

      category frontend { description "Frontend work" }

      disable agents ["shuttle"]
    `);

    expect(agentNames(plan)).toEqual(["loom"]);
  });
});

describe("a user names an agent that collides with a generated shuttle", () => {
  it("reports the collision but still materializes every other agent", async () => {
    const plan = await whenMaterialized(`
      agent shuttle {
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode all
      }

      agent shuttle-frontend {
        prompt "My hand-written frontend agent."
        models ["openai/gpt-5"]
        mode subagent
      }

      category frontend { description "Frontend work" }
    `);

    expect(plan.errors.map((error) => error.type)).toContain(
      "CategoryShuttleConflict",
    );
    expect(agentNames(plan)).toContain("shuttle");
    expect(agentNames(plan)).toContain("shuttle-frontend");
  });
});
