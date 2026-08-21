import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";
import { generateCategoryShuttles } from "../descriptors.js";

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

describe("generateCategoryShuttles", () => {
  describe("generation", () => {
    it("(a) returns empty object when config has no categories", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
      `);

      expect(result).toEqual({});
    });

    it("(b) returns empty object when base shuttle agent is absent", () => {
      const result = shuttles(`
        category frontend {
          description "Frontend implementation work"
          models ["gpt-5"]
        }
      `);

      expect(result).toEqual({});
    });

    it("(c) produces a shuttle-{name} key for each category", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend { description "Frontend implementation work" models ["gpt-5"] }
        category backend { description "Backend implementation work" models ["gpt-4o"] }
      `);

      expect(Object.keys(result).sort()).toEqual([
        "shuttle-backend",
        "shuttle-frontend",
      ]);
    });

    it("(d) generated descriptor name field matches the key", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend { description "Frontend implementation work" models ["gpt-5"] }
      `);

      expect(result["shuttle-frontend"]?.config.name).toBe("shuttle-frontend");
    });

    it("(e) generated shuttle carries source category metadata", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend {
          description "Frontend UI, styling, accessibility"
          models ["gpt-5"]
        }
      `);

      expect(result["shuttle-frontend"]?.categoryMeta).toEqual({
        name: "frontend",
        description: "Frontend UI, styling, accessibility",
        isCategory: true,
      });
    });

    it("(e) generated shuttle key is associated with source category metadata", () => {
      const config = cfg(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend {
          description "Frontend UI"
          models ["gpt-5"]
        }
      `);
      const result = generateCategoryShuttles(config);
      if (result.isErr()) throw new Error(result.error.message);

      expect(result.value["shuttle-frontend"]?.config.name).toBe(
        "shuttle-frontend",
      );
      expect(config.categories.frontend?.description).toBe("Frontend UI");
      expect("patterns" in (config.categories.frontend ?? {})).toBe(false);
    });
  });

  describe("inheritance", () => {
    it("(a) generated descriptor inherits base shuttle prompt", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle prompt." models ["claude-sonnet-4-5"] }
        category frontend { description "Frontend implementation work" }
      `);

      expect(result["shuttle-frontend"]?.config.prompt).toBe(
        "Base shuttle prompt.",
      );
    });

    it("(b) generated descriptor inherits base shuttle tool_policy when category has none", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          tool_policy {
            read allow
            write allow
            execute deny
          }
        }
        category frontend { description "Frontend implementation work" }
      `);

      expect(result["shuttle-frontend"]?.config.tool_policy).toEqual({
        read: "allow",
        write: "allow",
        execute: "deny",
      });
    });

    it("(c) generated descriptor has mode subagent regardless of base shuttle mode", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          mode all
        }
        category frontend { description "Frontend implementation work" }
      `);

      expect(result["shuttle-frontend"]?.config.mode).toBe("subagent");
    });
  });

  describe("category overrides", () => {
    it("(a) category models replace the inherited models field", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend { description "Frontend implementation work" models ["gpt-5"] }
      `);

      expect(result["shuttle-frontend"]?.config.models).toEqual(["gpt-5"]);
    });

    it("(a2) category description replaces the inherited base shuttle description", () => {
      const result = shuttles(`
        agent shuttle {
          description "Shuttle (Domain Specialist)"
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
        }
        category frontend {
          description "Frontend UI, styling, accessibility"
        }
      `);

      expect(result["shuttle-frontend"]?.config.description).toBe(
        "Frontend UI, styling, accessibility",
      );
      expect(result["shuttle-frontend"]?.categoryMeta.description).toBe(
        "Frontend UI, styling, accessibility",
      );
    });

    it("(b) category temperature overrides base temperature", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          temperature 0.2
        }
        category frontend { description "Frontend implementation work" temperature 0.7 }
      `);

      expect(result["shuttle-frontend"]?.config.temperature).toBe(0.7);
    });

    it("(c) category prompt_append is set on the descriptor", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend {
          description "Frontend implementation work"
          prompt_append "Focus on accessibility."
        }
      `);

      expect(result["shuttle-frontend"]?.config.prompt_append).toBe(
        "Focus on accessibility.",
      );
    });

    it("(d) category tool_policy merges over base: category fields win, unset fields keep base values", () => {
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
        category frontend {
          description "Frontend implementation work"
          tool_policy {
            write allow
            delegate deny
          }
        }
      `);

      expect(result["shuttle-frontend"]?.config.tool_policy).toEqual({
        read: "allow",
        write: "allow",
        execute: "deny",
        delegate: "deny",
      });
    });

    it("(e) category prompt_append composes with base prompt_append", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          prompt_append "Base append."
        }
        category frontend {
          description "Frontend implementation work"
          prompt_append "Focus on accessibility."
        }
      `);

      expect(result["shuttle-frontend"]?.config.prompt_append).toBe(
        "Base append.\nFocus on accessibility.",
      );
    });

    it("(f-file) category prompt_append_file is propagated to the generated shuttle config", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend {
          description "Frontend implementation work"
          prompt_append_file "extra.md"
        }
      `);

      expect(result["shuttle-frontend"]?.config.prompt_append_file).toBe(
        "extra.md",
      );
    });

    it("(f-file-no-base) category prompt_append_file is set when base has no prompt_append", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend {
          description "Frontend implementation work"
          prompt_append_file "category-extra.md"
        }
      `);

      expect(result["shuttle-frontend"]?.config.prompt_append_file).toBe(
        "category-extra.md",
      );
      expect(result["shuttle-frontend"]?.config.prompt_append).toBeUndefined();
    });

    it("(f) base prompt_append is preserved when category has no prompt_append", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          prompt_append "Base append."
        }
        category frontend {
          description "Frontend implementation work"
        }
      `);

      expect(result["shuttle-frontend"]?.config.prompt_append).toBe(
        "Base append.",
      );
    });

    it("(g) fields not set in category (e.g. temperature) keep their base shuttle value", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          temperature 0.2
        }
        category frontend { description "Frontend implementation work" models ["gpt-5"] }
      `);

      expect(result["shuttle-frontend"]?.config.temperature).toBe(0.2);
    });
  });

  describe("disabling", () => {
    it("(a) returns ok({}) when base shuttle is in disabled.agents", () => {
      const result = generateCategoryShuttles(
        cfg(`
          agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
          category frontend { description "Frontend implementation work" models ["gpt-5"] }
          disable agents ["shuttle"]
        `),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({});
    });

    it("(b) skips only the disabled category shuttle; others are still generated", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category frontend { description "Frontend implementation work" models ["gpt-5"] }
        category backend { description "Backend implementation work" models ["gpt-4o"] }
        disable agents ["shuttle-frontend"]
      `);

      expect(Object.keys(result)).toEqual(["shuttle-backend"]);
      expect(result["shuttle-frontend"]?.categoryMeta).toBeUndefined();
      expect(result["shuttle-backend"]?.categoryMeta.name).toBe("backend");
    });

    it("(c) base shuttle disabled suppresses ALL category shuttles", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category frontend { description "Frontend implementation work" models ["gpt-5"] }
        category backend { description "Backend implementation work" models ["gpt-4o"] }
        disable agents ["shuttle"]
      `);

      expect(result).toEqual({});
    });
  });

  describe("conflict detection", () => {
    it("(a) returns err(CategoryShuttleConflictError) when shuttle-{name} is explicitly declared", () => {
      const result = generateCategoryShuttles(
        cfg(`
          agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
          agent shuttle-frontend { prompt "Explicit." models ["gpt-4o"] }
          category frontend { description "Frontend implementation work" models ["gpt-5"] }
        `),
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected conflict");
      expect(result.error.type).toBe("CategoryShuttleConflictError");
    });

    it("(b) error contains the correct shuttleName and categoryName fields", () => {
      const result = generateCategoryShuttles(
        cfg(`
          agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
          agent shuttle-frontend { prompt "Explicit." models ["gpt-4o"] }
          category frontend { description "Frontend implementation work" models ["gpt-5"] }
        `),
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected conflict");
      expect(result.error.shuttleName).toBe("shuttle-frontend");
      expect(result.error.categoryName).toBe("frontend");
    });

    it("(c) error message is human-readable and names both the agent and the category", () => {
      const result = generateCategoryShuttles(
        cfg(`
          agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
          agent shuttle-frontend { prompt "Explicit." models ["gpt-4o"] }
          category frontend { description "Frontend implementation work" models ["gpt-5"] }
        `),
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected conflict");
      expect(result.error.message).toContain("shuttle-frontend");
      expect(result.error.message).toContain("frontend");
      expect(result.error.message).toContain("Remove the explicit agent");
    });

    it("(d) returns ok when shuttle-{name} is in disabled.agents but not explicitly declared", () => {
      const result = generateCategoryShuttles(
        cfg(`
          agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
          category frontend { description "Frontend implementation work" models ["gpt-5"] }
          disable agents ["shuttle-frontend"]
        `),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({});
    });
  });

  describe("category trigger and fast inheritance", () => {
    it("uses the category trigger list and does not inherit base Shuttle triggers", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base."
          models ["claude-sonnet-4-5"]
          triggers ["generic fallback", "repository tooling"]
        }
        category frontend {
          description "Frontend implementation work"
          triggers ["UI work", "accessibility"]
        }
        category backend {
          description "Backend implementation work"
        }
      `);

      expect(result["shuttle-frontend"]?.config.triggers).toEqual([
        "UI work",
        "accessibility",
      ]);
      expect(result["shuttle-backend"]?.config.triggers).toEqual([]);
    });

    it("copies category triggers without sharing the source array", () => {
      const config = cfg(`
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category frontend {
          description "Frontend implementation work"
          triggers ["UI work", "styling"]
        }
      `);
      const source = config.categories.frontend?.triggers;
      expect(source).toEqual(["UI work", "styling"]);

      const result = generateCategoryShuttles(config);
      if (result.isErr()) throw new Error(result.error.message);
      const generated = result.value["shuttle-frontend"]?.config.triggers;
      expect(generated).toEqual(["UI work", "styling"]);
      expect(generated).not.toBe(source);

      source?.push("mutated");
      expect(generated).toEqual(["UI work", "styling"]);
    });

    it("base absent and category absent leaves fast unset", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category frontend { description "Frontend implementation work" }
      `);

      expect(result["shuttle-frontend"]?.config.fast).toBeUndefined();
    });

    it("base true and category absent inherits fast true", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] fast true }
        category frontend { description "Frontend implementation work" }
      `);

      expect(result["shuttle-frontend"]?.config.fast).toBe(true);
    });

    it("base absent and category true sets fast true", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category frontend { description "Frontend implementation work" fast true }
      `);

      expect(result["shuttle-frontend"]?.config.fast).toBe(true);
    });

    it("base true and category true remains fast true", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] fast true }
        category frontend { description "Frontend implementation work" fast true }
      `);

      expect(result["shuttle-frontend"]?.config.fast).toBe(true);
    });
  });

  describe("generated array isolation", () => {
    it("mutating one generated shuttle models/skills/triggers does not mutate base, siblings, or category sources", () => {
      const config = cfg(`
        agent shuttle {
          prompt "Base."
          models ["claude-sonnet-4-5", "gpt-4o"]
          skills ["review", "summarize"]
          review_models ["openai/gpt-5"]
          triggers ["generic fallback"]
          tool_policy { read allow write ask }
          delegation { max_children 4 }
          routing { delegation_exclude ["warp"] }
        }
        category frontend {
          description "Frontend implementation work"
          models ["gpt-5"]
          triggers ["UI work", "styling"]
        }
        category backend {
          description "Backend implementation work"
        }
      `);

      const result = generateCategoryShuttles(config);
      if (result.isErr()) throw new Error(result.error.message);

      const frontend = result.value["shuttle-frontend"]?.config;
      const backend = result.value["shuttle-backend"]?.config;
      const base = config.agents.shuttle;
      if (
        frontend === undefined ||
        backend === undefined ||
        base === undefined
      ) {
        throw new Error("expected generated shuttles and base shuttle");
      }

      expect(frontend.models).toEqual(["gpt-5"]);
      expect(backend.models).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
      expect(frontend.skills).toEqual(["review", "summarize"]);
      expect(backend.skills).toEqual(["review", "summarize"]);
      expect(frontend.triggers).toEqual(["UI work", "styling"]);
      expect(backend.triggers).toEqual([]);

      expect(frontend.models).not.toBe(config.categories.frontend?.models);
      expect(backend.models).not.toBe(base.models);
      expect(frontend.skills).not.toBe(base.skills);
      expect(backend.skills).not.toBe(base.skills);
      expect(frontend.skills).not.toBe(backend.skills);
      expect(frontend.triggers).not.toBe(config.categories.frontend?.triggers);
      expect(frontend.review_models).not.toBe(base.review_models);
      expect(backend.review_models).not.toBe(base.review_models);
      expect(frontend.tool_policy).not.toBe(base.tool_policy);
      expect(backend.tool_policy).not.toBe(base.tool_policy);
      expect(frontend.delegation).not.toBe(base.delegation);
      expect(frontend.routing).not.toBe(base.routing);
      expect(frontend.routing?.delegation_exclude).not.toBe(
        base.routing?.delegation_exclude,
      );

      frontend.models?.push("mutated-frontend-model");
      frontend.skills?.push("mutated-frontend-skill");
      frontend.triggers?.push("mutated-frontend-trigger");
      frontend.review_models?.push("mutated-frontend-review");
      if (frontend.tool_policy !== undefined) {
        frontend.tool_policy.write = "allow";
      }
      if (frontend.delegation !== undefined) {
        frontend.delegation.max_children = 1;
      }
      frontend.routing?.delegation_exclude?.push("mutated-exclude");

      expect(base.models).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
      expect(base.skills).toEqual(["review", "summarize"]);
      expect(base.triggers).toEqual(["generic fallback"]);
      expect(base.review_models).toEqual(["openai/gpt-5"]);
      expect(base.tool_policy).toEqual({ read: "allow", write: "ask" });
      expect(base.delegation).toEqual({ max_children: 4 });
      expect(base.routing?.delegation_exclude).toEqual(["warp"]);

      expect(backend.models).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
      expect(backend.skills).toEqual(["review", "summarize"]);
      expect(backend.triggers).toEqual([]);
      expect(backend.review_models).toEqual(["openai/gpt-5"]);
      expect(backend.tool_policy).toEqual({ read: "allow", write: "ask" });
      expect(backend.delegation).toEqual({ max_children: 4 });
      expect(backend.routing?.delegation_exclude).toEqual(["warp"]);

      expect(config.categories.frontend?.models).toEqual(["gpt-5"]);
      expect(config.categories.frontend?.triggers).toEqual([
        "UI work",
        "styling",
      ]);
    });

    it("mutating a sibling generated shuttle does not leak inherited models or skills", () => {
      const config = cfg(`
        agent shuttle {
          prompt "Base."
          models ["claude-sonnet-4-5"]
          skills ["review"]
        }
        category frontend { description "Frontend implementation work" }
        category backend { description "Backend implementation work" }
      `);
      const result = generateCategoryShuttles(config);
      if (result.isErr()) throw new Error(result.error.message);

      const frontend = result.value["shuttle-frontend"]?.config;
      const backend = result.value["shuttle-backend"]?.config;
      if (frontend === undefined || backend === undefined) {
        throw new Error("expected sibling generated shuttles");
      }

      backend.models?.push("mutated-backend-model");
      backend.skills?.push("mutated-backend-skill");

      expect(frontend.models).toEqual(["claude-sonnet-4-5"]);
      expect(frontend.skills).toEqual(["review"]);
      expect(config.agents.shuttle?.models).toEqual(["claude-sonnet-4-5"]);
      expect(config.agents.shuttle?.skills).toEqual(["review"]);
    });
  });
});
