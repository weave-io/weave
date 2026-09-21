/**
 * DSL scenarios — category routing.
 *
 * Bucket: DSL. The black box is `.weave` source text. Input is a config a user
 * could have typed; output is the set of agents Weave hands an adapter. No
 * internal module is imported and no harness is involved.
 */

import { describe, expect, it } from "bun:test";
import {
  agent,
  agentNames,
  type MaterializationPlan,
  promptFor,
  whenMaterialized,
  whenMaterializedTwice,
} from "../support/scenario.js";

/**
 * What a router is told about when to route to one target. Triggers are not
 * on the descriptor itself — an agent learns another agent's triggers only
 * through its own delegation list, which is the only place they matter.
 */
function triggersFor(
  plan: MaterializationPlan,
  router: string,
  target: string,
): string[] | undefined {
  return agent(plan, router).descriptor.delegationTargets.find(
    (candidate) => candidate.name === target,
  )?.triggers;
}

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

describe("a category overrides some of what the base shuttle declares", () => {
  /**
   * A category is a diff against the base shuttle: what it states wins, what
   * it leaves out is inherited. This config states a few things for `mini` and
   * nothing at all for `tests`, so one plan shows both halves.
   */
  const config = `
    agent loom {
      prompt "You are Loom."
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy { delegate allow }
    }

    agent shuttle {
      description "Shuttle (Domain Specialist)"
      prompt "You are Shuttle."
      prompt_append "Always run the tests."
      models ["anthropic/claude-sonnet-4-5"]
      mode all
      temperature 0.2
      variant "latest"
      fast true
      skills ["tdd"]

      triggers ["Use when no category matches"]
    }

    category mini {
      description "Small, surgical edits in a single file"
      models ["openai/gpt-5"]
      temperature 0.9
      variant "preview"
      prompt_append "Keep the diff as small as it can be."
      triggers ["tiny localized change", "single-file fix"]
    }

    category tests {
      description "Test authoring and coverage work"
    }
  `;

  it("uses the category's own model, temperature and variant", async () => {
    const plan = await whenMaterialized(config);
    const mini = agent(plan, "shuttle-mini").descriptor;

    expect(mini.models).toEqual(["openai/gpt-5"]);
    expect(mini.temperature).toBe(0.9);
    expect(mini.variant).toBe("preview");
  });

  it("inherits everything the category left out", async () => {
    const plan = await whenMaterialized(config);
    const tests = agent(plan, "shuttle-tests").descriptor;

    expect(tests.models).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(tests.temperature).toBe(0.2);
    expect(tests.variant).toBe("latest");
    expect(tests.fast).toBe(true);
    expect(tests.skills).toEqual(["tdd"]);
  });

  it("keeps the base shuttle's guidance and adds the category's after it", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "shuttle-mini")).toBe(
      "You are Shuttle.\n\nAlways run the tests.\nKeep the diff as small as it can be.",
    );
  });

  it("leaves the base shuttle's guidance alone for a category that adds none", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "shuttle-tests")).toBe(
      "You are Shuttle.\n\nAlways run the tests.",
    );
  });

  it("names the category on the descriptor, so an adapter can label it", async () => {
    const plan = await whenMaterialized(config);

    expect(agent(plan, "shuttle-mini").descriptor.category).toEqual({
      name: "mini",
      description: "Small, surgical edits in a single file",
    });
    expect(agent(plan, "shuttle").descriptor.category).toBeUndefined();
  });

  it("describes each category shuttle with its own category's description", async () => {
    const plan = await whenMaterialized(config);

    expect(agent(plan, "shuttle-mini").descriptor.description).toBe(
      "Small, surgical edits in a single file",
    );
    expect(agent(plan, "shuttle").descriptor.description).toBe(
      "Shuttle (Domain Specialist)",
    );
  });

  it("gives a category shuttle its own triggers and never the base shuttle's fallback", async () => {
    const plan = await whenMaterialized(config);

    expect(triggersFor(plan, "loom", "shuttle-mini")).toEqual([
      "tiny localized change",
      "single-file fix",
    ]);
    expect(triggersFor(plan, "loom", "shuttle-tests")).toEqual([]);
    expect(triggersFor(plan, "loom", "shuttle")).toEqual([
      "Use when no category matches",
    ]);
  });
});

describe("a category keeps its prompt guidance in a file", () => {
  it("appends that file to the base shuttle's prompt", async () => {
    const plan = await whenMaterialized(
      `
        agent shuttle {
          prompt "You are Shuttle."
          models ["anthropic/claude-sonnet-4-5"]
          mode all
        }

        category docs {
          description "Documentation"
          prompt_append_file "docs-style.md"
        }
      `,
      { promptFiles: { "docs-style.md": "Write in the active voice." } },
    );

    expect(promptFor(plan, "shuttle-docs")).toBe(
      "You are Shuttle.\n\nWrite in the active voice.",
    );
  });

  /**
   * Recorded, not endorsed. An inline `prompt_append` and a
   * `prompt_append_file` are mutually exclusive in a single block, but
   * inheritance produces a config holding both: the base shuttle's inline
   * append and the category's file. The inline one wins and the category's
   * file is never read, so guidance the user wrote is dropped with no error
   * and no mention in the plan. The same category's file *is* applied when the
   * base shuttle has no inline append — the case above.
   */
  it("silently loses that file when the base shuttle appends inline guidance", async () => {
    const plan = await whenMaterialized(
      `
        agent shuttle {
          prompt "You are Shuttle."
          prompt_append "Inline base guidance."
          models ["anthropic/claude-sonnet-4-5"]
          mode all
        }

        category docs {
          description "Documentation"
          prompt_append_file "docs-style.md"
        }
      `,
      { promptFiles: { "docs-style.md": "Write in the active voice." } },
    );

    expect(promptFor(plan, "shuttle-docs")).toBe(
      "You are Shuttle.\n\nInline base guidance.",
    );
    expect(plan.errors).toEqual([]);
  });
});

describe("two categories sit side by side", () => {
  it("keeps each one's metadata to itself", async () => {
    const plan = await whenMaterialized(`
      agent shuttle {
        prompt "I work on {{category.name}}: {{category.description}}."
        models ["anthropic/claude-sonnet-4-5"]
        mode all
      }

      category frontend { description "Frontend UI work" }
      category backend { description "Backend service work" }
    `);

    expect(promptFor(plan, "shuttle-frontend")).toBe(
      "I work on frontend: Frontend UI work.",
    );
    expect(promptFor(plan, "shuttle-backend")).toBe(
      "I work on backend: Backend service work.",
    );
  });
});

describe("a user declares categories but no shuttle agent to specialise", () => {
  it("generates nothing rather than inventing an agent", async () => {
    const plan = await whenMaterialized(`
      agent loom {
        prompt "You are Loom."
        models ["anthropic/claude-sonnet-4-5"]
        mode primary
      }

      category frontend { description "Frontend work" }
    `);

    expect(agentNames(plan)).toEqual(["loom"]);
  });
});

describe("an adapter edits the descriptors Weave handed it", () => {
  it("cannot reach another agent's copy by doing so", async () => {
    const plan = await whenMaterialized(`
      agent shuttle {
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode all
        skills ["tdd"]

        tool_policy { read allow }
      }

      category frontend { description "Frontend work" }
      category backend { description "Backend work" }
    `);

    const frontend = agent(plan, "shuttle-frontend").descriptor;
    frontend.models.push("openai/gpt-5");
    frontend.skills.push("code-review");
    if (frontend.rawToolPolicy !== undefined) {
      frontend.rawToolPolicy.read = "deny";
    }

    const backend = agent(plan, "shuttle-backend").descriptor;

    expect(backend.models).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(backend.skills).toEqual(["tdd"]);
    expect(backend.rawToolPolicy).toEqual({ read: "allow" });
    expect(agent(plan, "shuttle").descriptor.models).toEqual([
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("cannot reach the user's own config, so resolving it again gives the same agents", async () => {
    const [first, second] = await whenMaterializedTwice(`
      agent shuttle {
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode all
        skills ["tdd"]

        tool_policy { read allow }
      }
    `);

    const descriptor = agent(first, "shuttle").descriptor;
    descriptor.models.push("openai/gpt-5");
    descriptor.skills.push("code-review");
    if (descriptor.rawToolPolicy !== undefined) {
      descriptor.rawToolPolicy.read = "deny";
    }

    const again = agent(second, "shuttle").descriptor;

    expect(again.models).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(again.skills).toEqual(["tdd"]);
    expect(again.rawToolPolicy).toEqual({ read: "allow" });
    expect(again.effectiveToolPolicy.read).toBe("allow");
  });
});

describe("a user names an agent that collides with a generated shuttle", () => {
  it("tells them which agent and which category collided, and how to fix it", async () => {
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

    expect(plan.errors).toEqual([
      expect.objectContaining({
        type: "CategoryShuttleConflict",
        conflict: expect.objectContaining({
          shuttleName: "shuttle-frontend",
          categoryName: "frontend",
          message: expect.stringContaining("Remove the explicit agent"),
        }),
      }),
    ]);
  });

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
