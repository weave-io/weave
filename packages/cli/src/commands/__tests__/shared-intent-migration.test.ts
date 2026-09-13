import { expect, it } from "bun:test";
import { parseConfig } from "@weaveio/weave-core";
import { convertLegacyJsonc } from "../../migration/legacy-jsonc-converter.js";

it("migrates positive fast intent and exact string triggers across entry kinds", () => {
  const intent = {
    fast: true,
    triggers: [
      'Use for "quoted" work',
      "Literal {{example}}",
      "Literal {{example}}",
    ],
  };
  const result = convertLegacyJsonc(
    JSON.stringify({
      agents: { loom: intent },
      custom_agents: { helper: { prompt: "Help", ...intent } },
      categories: { backend: { description: "Backend work", ...intent } },
    }),
  );
  expect(result.warnings).toEqual([]);
  const config = parseConfig(result.dsl)._unsafeUnwrap();
  for (const entry of [
    config.agents.loom,
    config.agents.helper,
    config.categories.backend,
  ]) {
    expect(entry?.fast).toBe(true);
    expect(entry?.triggers).toEqual(intent.triggers);
  }
});

it("warns about removed patterns and invalid intent without inventing routing", () => {
  const result = convertLegacyJsonc(
    JSON.stringify({
      categories: {
        backend: {
          description: "Backend work",
          patterns: ["src/**"],
          fast: false,
          triggers: [{ domain: "Work", trigger: "Implement" }],
        },
      },
    }),
  );
  expect(result.warnings.map((warning) => warning.field).sort()).toEqual([
    "categories.backend.fast",
    "categories.backend.patterns",
    "categories.backend.triggers",
  ]);
  const category = parseConfig(result.dsl)._unsafeUnwrap().categories.backend;
  expect(category?.fast).toBeUndefined();
  expect(category?.triggers).toBeUndefined();
});
