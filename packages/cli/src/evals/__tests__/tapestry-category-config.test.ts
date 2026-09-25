import { describe, expect, it } from "bun:test";
import { TapestryCasePromptComposer } from "../tapestry-category-config.js";
import type { EvalCase, EvalCaseCategory } from "../types.js";

function caseWith(categories: EvalCaseCategory[] | undefined): EvalCase {
  return {
    id: "tcr-unit",
    description: "Route this change.",
    suite: "tapestry-category-routing",
    allowed_agents: ["tapestry", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "agent_routing",
      target_agent: "shuttle",
      via: [],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...(categories !== undefined ? { categories } : {}),
  };
}

function shuttleLines(prompt: string): string[] {
  return [...prompt.matchAll(/^- \*\*(shuttle[a-z0-9-]*)\*\* — (.*)$/gm)].map(
    (m) => `${m[1]}: ${m[2]}`,
  );
}

describe("TapestryCasePromptComposer", () => {
  const composer = new TapestryCasePromptComposer();

  it("renders each enabled category into Tapestry's delegation list with its description", async () => {
    const result = await composer.compose(
      caseWith([
        {
          name: "frontend",
          description: "Frontend pages",
          triggers: ["Use for pages"],
          disabled: false,
        },
        { name: "backend", description: "Backend services", disabled: true },
      ]),
    );

    const lines = shuttleLines(result._unsafeUnwrap());
    expect(lines).toContain("shuttle-frontend: Frontend pages");
    expect(lines.some((l) => l.startsWith("shuttle-backend"))).toBe(false);
    expect(lines.some((l) => l.startsWith("shuttle:"))).toBe(true);
  });

  it("composes the builtin Tapestry with no category shuttles when the case declares none", async () => {
    const result = await composer.compose(caseWith(undefined));

    const prompt = result._unsafeUnwrap();
    expect(prompt).toContain("tapestry");
    expect(shuttleLines(prompt).map((l) => l.split(":")[0])).toEqual([
      "shuttle",
    ]);
  });

  it("returns a ConfigLoadError when the Weave schema rejects a declared category", async () => {
    const result = await composer.compose(
      caseWith([{ name: "blank", description: "   ", disabled: false }]),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ConfigLoadError");
  });
});
