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
        models ["gpt-4o"]
      }
    `);

    expect(Object.keys(result)).toContain("shuttle-client-frontend");
  });

  it("(b) generated shuttle name field matches key", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
      category client-frontend {
        description "Client frontend implementation work"
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
        description "Client frontend implementation work"
      }
    `);

    expect(result["shuttle-client-frontend"]?.config.mode).toBe("subagent");
  });

  it("(d) categoryMeta carries correct name and description", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
      category client-frontend {
        description "Client-side frontend layer"
        models ["gpt-4o"]
      }
    `);

    expect(result["shuttle-client-frontend"]?.categoryMeta).toEqual({
      name: "client-frontend",
      description: "Client-side frontend layer",
      isCategory: true,
    });
  });

  it("(e) isCategory flag is true on categoryMeta", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
      category client-frontend {
        description "Client frontend implementation work"
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
        description "Client frontend implementation work"
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
        description "Client frontend implementation work"
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
        description "Client frontend implementation work"
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
        description "Client frontend implementation work"
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
      models ["gpt-4o"]
    }
    category backend-api {
      description "Backend API layer"
      models ["claude-sonnet-4-5"]
    }
    category infrastructure {
      description "Infrastructure and persistence"
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

  it("(b) each generated shuttle carries isolated category metadata", () => {
    const result = shuttles(DSL);

    expect(result["shuttle-client-frontend"]?.categoryMeta).toEqual({
      name: "client-frontend",
      description: "Client UI layer",
      isCategory: true,
    });
    expect(result["shuttle-backend-api"]?.categoryMeta).toEqual({
      name: "backend-api",
      description: "Backend API layer",
      isCategory: true,
    });
    expect(result["shuttle-infrastructure"]?.categoryMeta).toEqual({
      name: "infrastructure",
      description: "Infrastructure and persistence",
      isCategory: true,
    });
    expect(
      "patterns" in (result["shuttle-client-frontend"]?.categoryMeta ?? {}),
    ).toBe(false);
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
      category client-frontend { description "Client frontend implementation work" }
      disable agents ["shuttle-client-frontend"]
    `);

    expect(result).toEqual({});
  });

  it("(b) disabling one shuttle does not affect siblings", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend { description "Client frontend implementation work" }
      category backend-api { description "Backend API implementation work" }
      disable agents ["shuttle-client-frontend"]
    `);

    expect(Object.keys(result)).toEqual(["shuttle-backend-api"]);
    expect(result["shuttle-client-frontend"]).toBeUndefined();
  });

  it("(c) disabling base shuttle suppresses ALL category shuttles", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend { description "Client frontend implementation work" }
      category backend-api { description "Backend API implementation work" }
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
        category client-frontend { description "Client frontend implementation work" }
        category backend-api { description "Backend API implementation work" }
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
          models ["gpt-4o"]
        }
      `,
    );

    expect(desc.name).toBe("shuttle-client-frontend");
    expect(desc.mode).toBe("subagent");
  });

  it("(b) descriptor carries category metadata without patterns", async () => {
    const desc = await descriptor(
      "shuttle-client-frontend",
      `
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category client-frontend {
          description "Client UI"
          models ["gpt-4o"]
        }
      `,
    );

    expect(desc.category).toEqual({
      name: "client-frontend",
      description: "Client UI",
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
          description "Client frontend implementation work"
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
          description "Client frontend implementation work"
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
          description "Client frontend implementation work"
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
          description "Client frontend implementation work"
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
    }
    category backend-api {
      description "Backend API layer"
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
        category client-frontend { description "Client frontend implementation work" }
      `,
    );

    const patternTarget = desc.delegationTargets.find(
      (t) => t.name === "pattern",
    );
    expect(patternTarget?.isCategory).toBe(false);
  });

  it("(d) delegationTargets list contains both generated category shuttles", async () => {
    // Verify normalized metadata directly because this fixture's prompt does not
    // render the delegation.targets loop.
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
// 6. Category metadata isolation
// ---------------------------------------------------------------------------

describe("category metadata isolation", () => {
  it("(a) categoryMeta carries the source category name and description", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend {
        description "Client frontend implementation work"
      }
    `);

    expect(result["shuttle-client-frontend"]?.categoryMeta).toEqual({
      name: "client-frontend",
      description: "Client frontend implementation work",
      isCategory: true,
    });
    expect(
      "patterns" in (result["shuttle-client-frontend"]?.categoryMeta ?? {}),
    ).toBe(false);
  });

  it("(b) a category with only a description still generates isolated metadata", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend {
        description "Frontend with semantic routing only"
      }
    `);

    expect(result["shuttle-client-frontend"]?.categoryMeta).toEqual({
      name: "client-frontend",
      description: "Frontend with semantic routing only",
      isCategory: true,
    });
  });

  it("(c) sibling category metadata does not bleed", () => {
    const result = shuttles(`
      agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
      category client-frontend { description "Client frontend implementation work" }
      category backend-api { description "Backend API implementation work" }
    `);

    expect(result["shuttle-client-frontend"]?.categoryMeta).toEqual({
      name: "client-frontend",
      description: "Client frontend implementation work",
      isCategory: true,
    });
    expect(result["shuttle-backend-api"]?.categoryMeta).toEqual({
      name: "backend-api",
      description: "Backend API implementation work",
      isCategory: true,
    });
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
        }
      `,
    );

    const target = desc.delegationTargets.find(
      (t) => t.name === "shuttle-client-frontend",
    );
    expect(target).toBeDefined();
    expect(target?.isCategory).toBe(true);
  });

  it("(a2) delegation target description uses the category description, not the base shuttle description", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom.\\n{{#delegation.targets}}\\n- **{{name}}** — {{description}}\\n{{/delegation.targets}}"
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        agent shuttle {
          description "Shuttle (Domain Specialist)"
          prompt "Base."
          models ["claude-sonnet-4-5"]
        }
        category mini {
          description "Small, surgical edits in a single file"
        }
        category tests {
          description "Test authoring and coverage work"
        }
      `,
    );

    const mini = desc.delegationTargets.find((t) => t.name === "shuttle-mini");
    const tests = desc.delegationTargets.find(
      (t) => t.name === "shuttle-tests",
    );

    expect(mini?.description).toBe("Small, surgical edits in a single file");
    expect(tests?.description).toBe("Test authoring and coverage work");
    expect(mini?.description).not.toBe("Shuttle (Domain Specialist)");

    // Prompt-level proof: the rendered delegation section shows category text.
    expect(desc.composedPrompt).toContain(
      "Small, surgical edits in a single file",
    );
    expect(desc.composedPrompt).toContain("Test authoring and coverage work");
  });

  it("(a3) category shuttle descriptor description is the category description", async () => {
    const desc = await descriptor(
      "shuttle-mini",
      `
        agent shuttle {
          description "Shuttle (Domain Specialist)"
          prompt "Base."
          models ["claude-sonnet-4-5"]
        }
        category mini {
          description "Small, surgical edits in a single file"
        }
      `,
    );

    expect(desc.description).toBe("Small, surgical edits in a single file");
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
        }
        category backend-api {
          description "Backend API layer"
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
        }
        category backend-api {
          description "Backend API layer"
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
        }
      `,
    );

    // The routing table enrichment has been removed; the heading must not appear.
    expect(desc.composedPrompt).not.toContain("## Category Routing Table");
  });
});

// ---------------------------------------------------------------------------
// 8. Trigger inheritance — generated category shuttles own no triggers
// ---------------------------------------------------------------------------

describe("generated category shuttles do not inherit base shuttle triggers", () => {
  const BASE_WITH_TRIGGERS = `
    agent shuttle {
      description "Shuttle (Domain Specialist)"
      prompt "Base."
      models ["claude-sonnet-4-5"]
      triggers [
        "Use only when no listed category shuttle clearly matches the work"
        "Use for build, script, CI, and manifest files"
      ]
    }
    category mini {
      description "Small, surgical edits in a single file"
    }
    category tests {
      description "Test authoring and coverage work"
    }
  `;

  it("(a) generated shuttle config carries an empty triggers array", () => {
    const result = shuttles(BASE_WITH_TRIGGERS);

    expect(result["shuttle-mini"]?.config.triggers).toEqual([]);
    expect(result["shuttle-tests"]?.config.triggers).toEqual([]);
  });

  it("(b) base shuttle triggers are left untouched by generation", () => {
    const config = cfg(BASE_WITH_TRIGGERS);
    const result = generateCategoryShuttles(config);
    if (result.isErr()) throw new Error(result.error.message);

    expect(config.agents.shuttle?.triggers).toHaveLength(2);
  });

  it("(c) category shuttle delegation targets expose no triggers, generic shuttle keeps its own", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        ${BASE_WITH_TRIGGERS}
      `,
    );

    const mini = desc.delegationTargets.find((t) => t.name === "shuttle-mini");
    const tests = desc.delegationTargets.find(
      (t) => t.name === "shuttle-tests",
    );
    const generic = desc.delegationTargets.find((t) => t.name === "shuttle");

    expect(mini?.triggers).toEqual([]);
    expect(tests?.triggers).toEqual([]);
    expect(generic?.triggers).toHaveLength(2);
  });

  it("(d) Loom's delegation section renders no category trigger bullets when categories omit triggers", async () => {
    // Mirrors the loom.md delegation block: name/description plus one bullet
    // per projected trigger. Task 6 will change that projection; until then
    // object fields stay empty so no category bullets appear.
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "{{#delegation.targets}}\\n- **{{name}}** — {{description}}{{#triggers}}\\n  - {{trigger}}{{/triggers}}\\n{{/delegation.targets}}"
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        ${BASE_WITH_TRIGGERS}
      `,
    );

    const lines = desc.composedPrompt.split("\n");
    const hintsFor = (target: string): string[] => {
      const start = lines.findIndex((l) => l.startsWith(`- **${target}** —`));
      expect(start).toBeGreaterThanOrEqual(0);
      const hints: string[] = [];
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!line.startsWith("  - ")) break;
        hints.push(line);
      }
      return hints;
    };

    expect(hintsFor("shuttle-mini")).toEqual([]);
    expect(hintsFor("shuttle-tests")).toEqual([]);
    expect(hintsFor("shuttle")).toEqual([
      "  - Use only when no listed category shuttle clearly matches the work",
      "  - Use for build, script, CI, and manifest files",
    ]);

    const occurrences =
      desc.composedPrompt.split(
        "Use only when no listed category shuttle clearly matches the work",
      ).length - 1;
    expect(occurrences).toBe(1);
  });

  it("(e) category triggers appear on the generated shuttle and generic shuttle keeps its own", async () => {
    const desc = await descriptor(
      "loom",
      `
        agent loom {
          prompt "I am loom."
          models ["claude-sonnet-4-5"]
          mode primary
          tool_policy { delegate allow }
        }
        agent shuttle {
          description "Shuttle (Domain Specialist)"
          prompt "Base."
          models ["claude-sonnet-4-5"]
          triggers ["generic fallback"]
        }
        category mini {
          description "Small, surgical edits in a single file"
          triggers ["tiny localized change", "single-file fix"]
        }
      `,
    );

    const mini = desc.delegationTargets.find((t) => t.name === "shuttle-mini");
    const generic = desc.delegationTargets.find((t) => t.name === "shuttle");

    expect(mini?.triggers).toEqual([
      "tiny localized change",
      "single-file fix",
    ]);
    expect(generic?.triggers).toEqual(["generic fallback"]);
  });
});
