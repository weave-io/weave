import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weave/core";
import { parseConfig } from "@weave/core";
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
          patterns ["src/components/**"]
          models ["gpt-5"]
        }
      `);

      expect(result).toEqual({});
    });

    it("(c) produces a shuttle-{name} key for each category", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
        category backend { patterns ["src/api/**"] models ["gpt-4o"] }
      `);

      expect(Object.keys(result).sort()).toEqual([
        "shuttle-backend",
        "shuttle-frontend",
      ]);
    });

    it("(d) generated descriptor name field matches the key", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
      `);

      expect(result["shuttle-frontend"]?.name).toBe("shuttle-frontend");
    });
  });

  describe("inheritance", () => {
    it("(a) generated descriptor inherits base shuttle prompt", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle prompt." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] }
      `);

      expect(result["shuttle-frontend"]?.prompt).toBe("Base shuttle prompt.");
    });

    it("(b) generated descriptor inherits base shuttle tool_policy when category has none", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          tool_policy {
            read allow
            write allow
            edit deny
          }
        }
        category frontend { patterns ["src/components/**"] }
      `);

      expect(result["shuttle-frontend"]?.tool_policy).toEqual({
        read: "allow",
        write: "allow",
        edit: "deny",
      });
    });

    it("(c) generated descriptor has mode subagent regardless of base shuttle mode", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          mode all
        }
        category frontend { patterns ["src/components/**"] }
      `);

      expect(result["shuttle-frontend"]?.mode).toBe("subagent");
    });
  });

  describe("category overrides", () => {
    it("(a) category models replace the inherited models field", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
      `);

      expect(result["shuttle-frontend"]?.models).toEqual(["gpt-5"]);
    });

    it("(b) category temperature overrides base temperature", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          temperature 0.2
        }
        category frontend { patterns ["src/components/**"] temperature 0.7 }
      `);

      expect(result["shuttle-frontend"]?.temperature).toBe(0.7);
    });

    it("(c) category prompt_append is set on the descriptor", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
        category frontend {
          patterns ["src/components/**"]
          prompt_append "Focus on accessibility."
        }
      `);

      expect(result["shuttle-frontend"]?.prompt_append).toBe(
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
            edit deny
          }
        }
        category frontend {
          patterns ["src/components/**"]
          tool_policy {
            write allow
            delegate deny
          }
        }
      `);

      expect(result["shuttle-frontend"]?.tool_policy).toEqual({
        read: "allow",
        write: "allow",
        edit: "deny",
        delegate: "deny",
      });
    });

    it("(e) fields not set in category (e.g. temperature) keep their base shuttle value", () => {
      const result = shuttles(`
        agent shuttle {
          prompt "Base shuttle."
          models ["claude-sonnet-4-5"]
          temperature 0.2
        }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
      `);

      expect(result["shuttle-frontend"]?.temperature).toBe(0.2);
    });
  });

  describe("disabling", () => {
    it("(a) returns ok({}) when base shuttle is in disabled.agents", () => {
      const result = generateCategoryShuttles(
        cfg(`
          agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
          category frontend { patterns ["src/**"] models ["gpt-5"] }
          disable agents ["shuttle"]
        `),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({});
    });

    it("(b) skips only the disabled category shuttle; others are still generated", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
        category backend { patterns ["src/api/**"] models ["gpt-4o"] }
        disable agents ["shuttle-frontend"]
      `);

      expect(Object.keys(result)).toEqual(["shuttle-backend"]);
    });

    it("(c) base shuttle disabled suppresses ALL category shuttles", () => {
      const result = shuttles(`
        agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
        category frontend { patterns ["src/components/**"] models ["gpt-5"] }
        category backend { patterns ["src/api/**"] models ["gpt-4o"] }
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
          category frontend { patterns ["src/**"] models ["gpt-5"] }
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
          category frontend { patterns ["src/**"] models ["gpt-5"] }
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
          category frontend { patterns ["src/**"] models ["gpt-5"] }
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
          category frontend { patterns ["src/**"] models ["gpt-5"] }
          disable agents ["shuttle-frontend"]
        `),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({});
    });
  });
});
