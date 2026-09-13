import { describe, expect, it } from "bun:test";
import { parseConfig } from "../parse-config.js";
import { AgentConfigSchema, CategoryConfigSchema } from "../schema.js";

describe("shared routing and fast intent", () => {
  for (const kind of ["agent", "category"] as const) {
    const schema = kind === "agent" ? AgentConfigSchema : CategoryConfigSchema;
    const base = kind === "category" ? { description: "Bounded work" } : {};

    it(`${kind} preserves literal string triggers and fast true`, () => {
      const triggers = ["  Keep this spacing  ", "Literal {{agent.name}}"];
      expect(schema.parse({ ...base, triggers, fast: true })).toMatchObject({
        triggers,
        fast: true,
      });
      const source = `${kind} worker { description "Bounded work" fast true triggers ["First" "Second"] }`;
      const config = parseConfig(source)._unsafeUnwrap();
      const entry =
        kind === "agent" ? config.agents.worker : config.categories.worker;
      expect(entry?.triggers).toEqual(["First", "Second"]);
      expect(entry?.fast).toBe(true);
    });

    it(`${kind} rejects empty and legacy triggers`, () => {
      for (const triggers of [
        [],
        [""],
        ["  "],
        [1],
        [{ domain: "Work", trigger: "Implement" }],
      ]) {
        expect(schema.safeParse({ ...base, triggers }).success).toBe(false);
      }
      expect(
        parseConfig(
          `${kind} worker { description "Work" triggers [{ domain "Work" trigger "Implement" }] }`,
        ).isErr(),
      ).toBe(true);
    });

    it(`${kind} rejects false intent but preserves omission`, () => {
      expect(schema.safeParse({ ...base, fast: false }).success).toBe(false);
      expect(schema.parse(base).fast).toBeUndefined();
      expect(
        parseConfig(`${kind} worker { description "Work" fast false }`).isErr(),
      ).toBe(true);
      expect(
        parseConfig(`${kind} worker { description "Work" fast }`).isErr(),
      ).toBe(true);
      expect(
        parseConfig(
          `${kind} worker { description "Work" triggers [bare] }`,
        ).isErr(),
      ).toBe(true);
    });
  }

  it("requires category descriptions and rejects removed patterns", () => {
    for (const description of [undefined, "", "  "]) {
      expect(CategoryConfigSchema.safeParse({ description }).success).toBe(
        false,
      );
    }
    expect(
      parseConfig(
        'category work { description "Work" patterns ["src/**"] }',
      ).isErr(),
    ).toBe(true);
  });

  it("preserves the OpenCode native variant extension", () => {
    const config = parseConfig(
      'agent worker { fast true variant "high" models ["openai/model#max"] }',
    )._unsafeUnwrap();
    expect(config.agents.worker?.variant).toBe("high");
    expect(config.agents.worker?.models).toEqual(["openai/model#max"]);
  });
});
