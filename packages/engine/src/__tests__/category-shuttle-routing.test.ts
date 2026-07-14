/**
 * Deterministic unit coverage for:
 *   category config → shuttle generation → delegation targets in composed descriptor
 *
 * All tests use inline DSL fixtures parsed by parseConfig. No file I/O.
 */

import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import { composeAgentDescriptor } from "../compose.js";
import { generateCategoryShuttles } from "../descriptors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function shuttles(source: string) {
  const result = generateCategoryShuttles(cfg(source));
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

async function descriptor(
  agentName: string,
  source: string,
  extraAllAgents?: Record<string, import("@weaveio/weave-core").AgentConfig>,
) {
  const config = cfg(source);
  const shuttleMap = generateCategoryShuttles(config);
  if (shuttleMap.isErr()) throw new Error(shuttleMap.error.message);

  // Build allAgents: declared agents + generated category shuttles
  const allAgents: Record<string, import("@weaveio/weave-core").AgentConfig> = {
    ...config.agents,
    ...Object.fromEntries(
      Object.entries(shuttleMap.value).map(([k, v]) => [k, v.config]),
    ),
    ...(extraAllAgents ?? {}),
  };

  const agentConfig = allAgents[agentName];
  if (agentConfig === undefined)
    throw new Error(`Agent "${agentName}" not found`);

  const generated = shuttleMap.value[agentName];
  const categoryMeta = generated?.categoryMeta;

  const result = await composeAgentDescriptor(
    agentName,
    agentConfig,
    config,
    allAgents,
    categoryMeta,
  );

  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// ---------------------------------------------------------------------------
// 1. Single category → shuttle-{name} generation
// ---------------------------------------------------------------------------

describe("single category → shuttle generation", () => {
  it("(a) generates shuttle-client-frontend for category client-frontend", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
      category client-frontend {
        description "Client-side frontend layer"
        patterns ["src/4.Presentation/DST.Client/**"]
        models ["gpt-4o"]
      }
    `);

    expect(Object.keys(result)).toContain("shuttle-client-frontend");
  });

  it("(b) generated shuttle name field matches key", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
      category client-frontend {
        patterns ["src/4.Presentation/DST.Client/**"]
      }
    `);

    expect(result["shuttle-client-frontend"]?.config.name).toBe(
      "shuttle-client-frontend",
    );
  });

  it("(c) mode is always subagent", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] mode all }
      category client-frontend {
        patterns ["src/4.Presentation/DST.Client/**"]
      }
    `);

    expect(result["shuttle-client-frontend"]?.config.mode).toBe("subagent");
  });

  it("(d) categoryMeta carries correct name, description, and patterns", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
      category client-frontend {
        description "Client-side frontend layer"
        patterns ["src/4.Presentation/DST.Client/**", "**/*.tsx"]
        models ["gpt-4o"]
      }
    `);

    expect(result["shuttle-client-frontend"]?.categoryMeta).toEqual({
      name: "client-frontend",
      description: "Client-side frontend layer",
      patterns: ["src/4.Presentation/DST.Client/**", "**/*.tsx"],
      isCategory: true,
    });
  });

  it("(e) isCategory flag is true on categoryMeta", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
      category client-frontend {
        patterns ["src/4.Presentation/DST.Client/**"]
      }
    `);

    expect(result["shuttle-client-frontend"]?.categoryMeta.isCategory).toBe(
      true,
    );
  });

  it("(f) inherits base shuttle prompt when category has no override", () => {
    const result = shuttles(`
      agent shuttle { prompt "I am the base shuttle." models ["claude-sonnet-4-5"] }
      category client-frontend {
        patterns ["src/4.Presentation/DST.Client/**"]
      }
    `);

    expect(result["shuttle-client-frontend"]?.config.prompt).toBe(
      "I am the base shuttle.",
    );
  });

  it("(g) category models override base shuttle models", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
      category client-frontend {
        patterns ["src/4.Presentation/DST.Client/**"]
        models ["gpt-4o"]
      }
    `);

    expect(result["shuttle-client-frontend"]?.config.models).toEqual([
      "gpt-4o",
    ]);
  });

  it("(h) tool_policy is inherited from base shuttle when category has none", () => {
    const result = shuttles(`
      agent shuttle {
        prompt "Base shuttle."
        models ["claude-sonnet-4-5"]
        tool_policy {
          read allow
          write allow
          execute deny
          delegate deny
        }
      }
      category client-frontend {
        patterns ["src/4.Presentation/DST.Client/**"]
      }
    `);

    expect(result["shuttle-client-frontend"]?.config.tool_policy).toEqual({
      read: "allow",
      write: "allow",
      execute: "deny",
      delegate: "deny",
    });
  });

  it("(i) category tool_policy merges over base: category fields win, others kept", () => {
    const result = shuttles(`
      agent shuttle {
        prompt "Base shuttle."
        models ["claude-sonnet-4-5"]
        tool_policy {
          read allow
          write ask
          execute deny
        }
      }
      category client-frontend {
        patterns ["src/4.Presentation/DST.Client/**"]
        tool_policy {
          write allow
          delegate deny
        }
      }
    `);

    expect(result["shuttle-client-frontend"]?.config.tool_policy).toEqual({
      read: "allow",
      write: "allow",
      execute: "deny",
      delegate: "deny",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Multiple categories
// ---------------------------------------------------------------------------

describe("multiple categories → multiple shuttles", () => {
  const DSL = `
    agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
    category client-frontend {
      description "Client UI layer"
      patterns ["src/4.Presentation/DST.Client/**"]
      models ["gpt-4o"]
    }
    category backend-api {
      description "Backend API layer"
      patterns ["src/2.Application/**", "src/3.Domain/**"]
      models ["claude-sonnet-4-5"]
    }
    category infrastructure {
      description "Infrastructure and persistence"
      patterns ["src/1.Infrastructure/**"]
    }
  `;

  it("(a) produces one shuttle per category", () => {
    const result = shuttles(DSL);
    expect(Object.keys(result).sort()).toEqual([
      "shuttle-backend-api",
      "shuttle-client-frontend",
      "shuttle-infrastructure",
    ]);
  });

  it("(b) each generated shuttle has the correct patterns for its category", () => {
    const result = shuttles(DSL);

    expect(result["shuttle-client-frontend"]?.categoryMeta.patterns).toEqual([
      "src/4.Presentation/DST.Client/**",
    ]);
    expect(result["shuttle-backend-api"]?.categoryMeta.patterns).toEqual([
      "src/2.Application/**",
      "src/3.Domain/**",
    ]);
    expect(result["shuttle-infrastructure"]?.categoryMeta.patterns).toEqual([
      "src/1.Infrastructure/**",
    ]);
  });

  it("(c) each shuttle carries isCategory: true", () => {
    const result = shuttles(DSL);

    for (const [, shuttle] of Object.entries(result)) {
      expect(shuttle.categoryMeta.isCategory).toBe(true);
    }
  });

  it("(d) category-specific models are applied independently", () => {
    const result = shuttles(DSL);

    expect(result["shuttle-client-frontend"]?.config.models).toEqual([
      "gpt-4o",
    ]);
    expect(result["shuttle-backend-api"]?.config.models).toEqual([
      "claude-sonnet-4-5",
    ]);
    // infrastructure has no override → inherits base shuttle models
    expect(result["shuttle-infrastructure"]?.config.models).toEqual([
      "claude-sonnet-4-5",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Disabled shuttle exclusion
// ---------------------------------------------------------------------------

describe("disabled category shuttle exclusion", () => {
  it("(a) disabled shuttle-{name} is excluded from generation", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend { patterns ["src/4.Presentation/DST.Client/**"] }
      disable agents ["shuttle-client-frontend"]
    `);

    expect(result).toEqual({});
  });

  it("(b) disabling one shuttle does not affect siblings", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend { patterns ["src/4.Presentation/DST.Client/**"] }
      category backend-api { patterns ["src/2.Application/**"] }
      disable agents ["shuttle-client-frontend"]
    `);

    expect(Object.keys(result)).toEqual(["shuttle-backend-api"]);
    expect(result["shuttle-client-frontend"]).toBeUndefined();
  });

  it("(c) disabling base shuttle suppresses ALL category shuttles", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend { patterns ["src/4.Presentation/DST.Client/**"] }
      category backend-api { patterns ["src/2.Application/**"] }
      disable agents ["shuttle"]
    `);

    expect(result).toEqual({});
  });

  it("(d) disabled shuttle absent from delegation targets of loom", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category client-frontend { patterns ["src/4.Presentation/DST.Client/**"] }
        category backend-api { patterns ["src/2.Application/**"] }
        disable agents ["shuttle-client-frontend"]
      `,
    );

    const targetNames = desc.delegationTargets.map((t) => t.name);
    expect(targetNames).not.toContain("shuttle-client-frontend");
    expect(targetNames).toContain("shuttle-backend-api");
  });
});

// ---------------------------------------------------------------------------
// 4. AgentDescriptor via composeAgentDescriptor
// ---------------------------------------------------------------------------

describe("composeAgentDescriptor for category shuttle", () => {
  it("(a) descriptor name and mode are correct", async () => {
    const desc = await descriptor(
      "shuttle-client-frontend",
      `
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category client-frontend {
          description "Client UI"
          patterns ["src/4.Presentation/DST.Client/**"]
          models ["gpt-4o"]
        }
      `,
    );

    expect(desc.name).toBe("shuttle-client-frontend");
    expect(desc.mode).toBe("subagent");
  });

  it("(b) descriptor carries category metadata with correct patterns", async () => {
    const desc = await descriptor(
      "shuttle-client-frontend",
      `
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category client-frontend {
          description "Client UI"
          patterns ["src/4.Presentation/DST.Client/**", "**/*.tsx"]
          models ["gpt-4o"]
        }
      `,
    );

    expect(desc.category).toEqual({
      name: "client-frontend",
      description: "Client UI",
      patterns: ["src/4.Presentation/DST.Client/**", "**/*.tsx"],
    });
  });

  it("(c) effectiveToolPolicy reflects base shuttle tool_policy", async () => {
    const desc = await descriptor(
      "shuttle-client-frontend",
      `
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          tool_policy {
            read allow
            write allow
            execute deny
            delegate deny
          }
        }
        category client-frontend {
          patterns ["src/4.Presentation/DST.Client/**"]
        }
      `,
    );

    expect(desc.effectiveToolPolicy.read).toBe("allow");
    expect(desc.effectiveToolPolicy.write).toBe("allow");
    expect(desc.effectiveToolPolicy.execute).toBe("deny");
    expect(desc.effectiveToolPolicy.delegate).toBe("deny");
  });

  it("(d) composedPrompt contains rendered base prompt", async () => {
    const desc = await descriptor(
      "shuttle-client-frontend",
      `
        agent shuttle { prompt "You are the base shuttle." models ["claude-sonnet-4-5"] }
        category client-frontend {
          patterns ["src/4.Presentation/DST.Client/**"]
        }
      `,
    );

    expect(desc.composedPrompt).toContain("You are the base shuttle.");
  });

  it("(e) composedPrompt appends category prompt_append", async () => {
    const desc = await descriptor(
      "shuttle-client-frontend",
      `
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category client-frontend {
          patterns ["src/4.Presentation/DST.Client/**"]
          prompt_append "Focus on the Blazor component architecture."
        }
      `,
    );

    expect(desc.composedPrompt).toContain("Base shuttle.");
    expect(desc.composedPrompt).toContain(
      "Focus on the Blazor component architecture.",
    );
  });

  it("(f) models on descriptor match category models override", async () => {
    const desc = await descriptor(
      "shuttle-client-frontend",
      `
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category client-frontend {
          patterns ["src/4.Presentation/DST.Client/**"]
          models ["gpt-4o"]
        }
      `,
    );

    expect(desc.models).toEqual(["gpt-4o"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Delegation targets — isCategory flag and routing table
// ---------------------------------------------------------------------------

describe("delegation targets include category shuttles with isCategory: true", () => {
  const LOOM_DSL = `
    agent loom {
      prompt "I am loom."
      models ["claude-sonnet-4-5"]
      mode primary
      tool_policy { delegate allow }
    }
    agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
    category client-frontend {
      description "Client UI layer"
      patterns ["src/4.Presentation/DST.Client/**"]
    }
    category backend-api {
      description "Backend API layer"
      patterns ["src/2.Application/**"]
    }
  `;

  it("(a) loom delegation targets include shuttle-client-frontend and shuttle-backend-api", async () => {
    const desc = await descriptor("loom", LOOM_DSL);

    const targetNames = desc.delegationTargets.map((t) => t.name);
    expect(targetNames).toContain("shuttle-client-frontend");
    expect(targetNames).toContain("shuttle-backend-api");
  });

  it("(b) category shuttle delegation targets have isCategory: true", async () => {
    const desc = await descriptor("loom", LOOM_DSL);

    const cf = desc.delegationTargets.find(
      (t) => t.name === "shuttle-client-frontend",
    );
    const ba = desc.delegationTargets.find(
      (t) => t.name === "shuttle-backend-api",
    );

    expect(cf?.isCategory).toBe(true);
    expect(ba?.isCategory).toBe(true);
  });

  it("(c) non-category agents have isCategory: false", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        agent pattern {
          prompt "I am pattern."
          models ["claude-sonnet-4-5"]
          mode subagent
        }
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category client-frontend { patterns ["src/4.Presentation/DST.Client/**"] }
      `,
    );

    const patternTarget = desc.delegationTargets.find(
      (t) => t.name === "pattern",
    );
    expect(patternTarget?.isCategory).toBe(false);
  });

  it("(d) delegationTargets list contains both generated category shuttles", async () => {
    // Verify via delegationTargets rather than composedPrompt template rendering,
    // since {{{delegation.section}}} is a computed context path not valid in
    // inline prompts (only available through buildTemplateContext post-composition).
    const desc = await descriptor("loom", LOOM_DSL);

    const targetNames = desc.delegationTargets.map((t) => t.name);
    expect(targetNames).toContain("shuttle-client-frontend");
    expect(targetNames).toContain("shuttle-backend-api");

    // Confirm each is marked as a category shuttle
    const cfTarget = desc.delegationTargets.find(
      (t) => t.name === "shuttle-client-frontend",
    );
    const baTarget = desc.delegationTargets.find(
      (t) => t.name === "shuttle-backend-api",
    );
    expect(cfTarget?.isCategory).toBe(true);
    expect(baTarget?.isCategory).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Pattern inheritance integrity
// ---------------------------------------------------------------------------

describe("pattern inheritance", () => {
  it("(a) patterns from category are carried verbatim to categoryMeta", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend {
        patterns [
          "src/4.Presentation/DST.Client/**",
          "src/4.Presentation/DST.Client.Tests/**",
          "**/*.razor",
          "**/*.razor.cs"
        ]
      }
    `);

    expect(result["shuttle-client-frontend"]?.categoryMeta.patterns).toEqual([
      "src/4.Presentation/DST.Client/**",
      "src/4.Presentation/DST.Client.Tests/**",
      "**/*.razor",
      "**/*.razor.cs",
    ]);
  });

  it("(b) category patterns are carried verbatim — schema requires at least one entry", () => {
    // The DSL schema enforces at least one pattern per category.
    // Verify a single-pattern category is reflected exactly in categoryMeta.patterns.
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend {
        description "Frontend with minimal pattern"
        patterns ["src/4.Presentation/**"]
      }
    `);

    expect(result["shuttle-client-frontend"]?.categoryMeta.patterns).toEqual([
      "src/4.Presentation/**",
    ]);
  });

  it("(c) patterns do not bleed between sibling categories", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend { patterns ["src/4.Presentation/DST.Client/**"] }
      category backend-api { patterns ["src/2.Application/**", "src/3.Domain/**"] }
    `);

    expect(result["shuttle-client-frontend"]?.categoryMeta.patterns).toEqual([
      "src/4.Presentation/DST.Client/**",
    ]);
    expect(result["shuttle-backend-api"]?.categoryMeta.patterns).toEqual([
      "src/2.Application/**",
      "src/3.Domain/**",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. Category shuttle delegation targets in composed descriptor
// ---------------------------------------------------------------------------

describe("category shuttle delegation targets in composed descriptor", () => {
  it("(a) delegationTargets includes category shuttle when categories exist", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category client-frontend {
          description "Frontend UI"
          patterns ["src/4.Presentation/DST.Client/**"]
        }
      `,
    );

    const target = desc.delegationTargets.find(
      (t) => t.name === "shuttle-client-frontend",
    );
    expect(target).toBeDefined();
    expect(target?.isCategory).toBe(true);
  });

  it("(b) delegation targets include all category shuttles for multiple categories", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category client-frontend {
          description "Client UI layer"
          patterns ["src/4.Presentation/DST.Client/**"]
        }
        category backend-api {
          description "Backend API layer"
          patterns ["src/2.Application/**", "src/3.Domain/**"]
        }
      `,
    );

    const frontend = desc.delegationTargets.find(
      (t) => t.name === "shuttle-client-frontend",
    );
    const backend = desc.delegationTargets.find(
      (t) => t.name === "shuttle-backend-api",
    );
    expect(frontend).toBeDefined();
    expect(frontend?.isCategory).toBe(true);
    expect(backend).toBeDefined();
    expect(backend?.isCategory).toBe(true);
  });

  it("(c) no category delegation targets when no categories exist", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      `,
    );

    const categoryTargets = desc.delegationTargets.filter((t) => t.isCategory);
    expect(categoryTargets).toHaveLength(0);
  });

  it("(d) disabled category shuttle is excluded from delegation targets", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category client-frontend {
          description "Frontend UI"
          patterns ["src/4.Presentation/DST.Client/**"]
        }
        category backend-api {
          description "Backend API layer"
          patterns ["src/2.Application/**"]
        }
        disable agents ["shuttle-client-frontend"]
      `,
    );

    const frontend = desc.delegationTargets.find(
      (t) => t.name === "shuttle-client-frontend",
    );
    const backend = desc.delegationTargets.find(
      (t) => t.name === "shuttle-backend-api",
    );
    expect(frontend).toBeUndefined();
    expect(backend).toBeDefined();
    expect(backend?.isCategory).toBe(true);
  });

  it("(e) no delegation targets when delegate is not allowed", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate deny }
        }
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category client-frontend {
          description "Frontend UI"
          patterns ["src/4.Presentation/DST.Client/**"]
        }
      `,
    );

    expect(desc.delegationTargets).toHaveLength(0);
  });

  it("(f) composed prompt does not contain routing table heading", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category client-frontend {
          description "Frontend UI"
          patterns ["src/4.Presentation/DST.Client/**"]
        }
      `,
    );

    // The routing table enrichment has been removed; the heading must not appear.
    expect(desc.composedPrompt).not.toContain("## Category Routing Table");
  });
});
