/**
 * template-context.test.ts
 *
 * Tests for the bounded Template Context builder.
 *
 * Covers:
 * - Context shape: agent, category, toolPolicy, delegation
 * - No raw config/model/temperature/path exposure
 * - Optional category behavior (present for category shuttles, absent otherwise)
 * - Allowed-path metadata completeness
 * - Exact string-trigger projection and bounded context
 */

import { describe, expect, it } from "bun:test";

import type { DelegationTarget } from "../compose.js";
import {
  type AgentPromptTemplateContext,
  ALLOWED_TEMPLATE_PATHS,
  buildTemplateContext,
  type ReviewRoutingContext,
  type TemplateContextInput,
} from "../template-context.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultPolicy: EffectiveToolPolicy = {
  read: "allow",
  write: "deny",
  execute: "ask",
  delegate: "allow",
  network: "deny",
};

function makeInput(
  overrides: Partial<TemplateContextInput> = {},
): TemplateContextInput {
  return {
    agentName: "test-agent",
    mode: "subagent",
    skills: [],
    effectiveToolPolicy: defaultPolicy,
    delegationTargets: [],
    ...overrides,
  };
}

function build(
  overrides: Partial<TemplateContextInput> = {},
): AgentPromptTemplateContext {
  const result = buildTemplateContext(makeInput(overrides));
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function makeTarget(
  name: string,
  description?: string,
  triggers: string[] = [],
  isCategory = false,
): DelegationTarget {
  return { name, description, triggers, isCategory };
}

// ---------------------------------------------------------------------------
// Allowed-path metadata
// ---------------------------------------------------------------------------

describe("ALLOWED_TEMPLATE_PATHS", () => {
  it("contains all agent paths", () => {
    expect(ALLOWED_TEMPLATE_PATHS.has("agent")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("agent.name")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("agent.description")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("agent.mode")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("agent.skills")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("agent.isCategory")).toBe(true);
  });

  it("contains all category paths", () => {
    expect(ALLOWED_TEMPLATE_PATHS.has("category")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("category.name")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("category.description")).toBe(true);
  });

  it("contains all toolPolicy paths", () => {
    expect(ALLOWED_TEMPLATE_PATHS.has("toolPolicy")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("toolPolicy.effective")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("toolPolicy.effective.read")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("toolPolicy.effective.write")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("toolPolicy.effective.execute")).toBe(
      true,
    );
    expect(ALLOWED_TEMPLATE_PATHS.has("toolPolicy.effective.delegate")).toBe(
      true,
    );
    expect(ALLOWED_TEMPLATE_PATHS.has("toolPolicy.effective.network")).toBe(
      true,
    );
  });

  it("contains all delegation paths", () => {
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets.name")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets.description")).toBe(
      true,
    );
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets.triggers")).toBe(
      true,
    );
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets.domains")).toBe(
      false,
    );
    expect(
      ALLOWED_TEMPLATE_PATHS.has("delegation.targets.triggers.domain"),
    ).toBe(false);
    expect(
      ALLOWED_TEMPLATE_PATHS.has("delegation.targets.triggers.trigger"),
    ).toBe(false);
    expect(
      ALLOWED_TEMPLATE_PATHS.has("delegation.targets.triggers.routing_hint"),
    ).toBe(false);
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets.isCategory")).toBe(
      true,
    );
    expect(
      ALLOWED_TEMPLATE_PATHS.has("delegation.targets.isCategory.name"),
    ).toBe(true);
    expect(
      ALLOWED_TEMPLATE_PATHS.has("delegation.targets.isCategory.description"),
    ).toBe(true);
  });

  it("does NOT contain delegation.section or delegation.mermaid", () => {
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.section")).toBe(false);
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.mermaid")).toBe(false);
  });

  it("contains the current-item reference", () => {
    expect(ALLOWED_TEMPLATE_PATHS.has(".")).toBe(true);
  });

  it("does NOT contain raw config paths", () => {
    expect(ALLOWED_TEMPLATE_PATHS.has("models")).toBe(false);
    expect(ALLOWED_TEMPLATE_PATHS.has("temperature")).toBe(false);
    expect(ALLOWED_TEMPLATE_PATHS.has("prompt_file")).toBe(false);
    expect(ALLOWED_TEMPLATE_PATHS.has("rawToolPolicy")).toBe(false);
    expect(ALLOWED_TEMPLATE_PATHS.has("config")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agent context projection
// ---------------------------------------------------------------------------

describe("buildTemplateContext — agent context", () => {
  it("projects agent.name correctly", () => {
    const ctx = build({ agentName: "my-agent" });
    expect(ctx.agent.name).toBe("my-agent");
  });

  it("projects agent.mode correctly", () => {
    const ctx = build({ mode: "primary" });
    expect(ctx.agent.mode).toBe("primary");
  });

  it("projects agent.skills correctly", () => {
    const ctx = build({ skills: ["tdd", "review"] });
    expect(ctx.agent.skills).toEqual(["tdd", "review"]);
  });

  it("projects empty skills array when no skills", () => {
    const ctx = build({ skills: [] });
    expect(ctx.agent.skills).toEqual([]);
  });

  it("includes agent.description when provided", () => {
    const ctx = build({ description: "A helpful agent" });
    expect(ctx.agent.description).toBe("A helpful agent");
  });

  it("omits agent.description when not provided", () => {
    const ctx = build({ description: undefined });
    expect(ctx.agent.description).toBeUndefined();
  });

  it("sets isCategory=false for non-category agents", () => {
    const ctx = build({ category: undefined });
    expect(ctx.agent.isCategory).toBe(false);
  });

  it("sets isCategory=true for category shuttle agents", () => {
    const ctx = build({ category: { name: "frontend" } });
    expect(ctx.agent.isCategory).toBe(true);
  });

  it("does NOT expose models on agent context", () => {
    const ctx = build();
    expect("models" in ctx.agent).toBe(false);
  });

  it("does NOT expose temperature on agent context", () => {
    const ctx = build();
    expect("temperature" in ctx.agent).toBe(false);
  });

  it("does NOT expose prompt_file on agent context", () => {
    const ctx = build();
    expect("prompt_file" in ctx.agent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Category context projection
// ---------------------------------------------------------------------------

describe("buildTemplateContext — category context", () => {
  it("omits category for non-category agents", () => {
    const ctx = build({ category: undefined });
    expect(ctx.category).toBeUndefined();
  });

  it("includes category for category shuttle agents", () => {
    const ctx = build({ category: { name: "frontend" } });
    expect(ctx.category).toBeDefined();
    expect(ctx.category?.name).toBe("frontend");
  });

  it("includes category.description when provided", () => {
    const ctx = build({
      category: { name: "frontend", description: "UI components" },
    });
    expect(ctx.category?.description).toBe("UI components");
  });

  it("omits category.description when not provided", () => {
    const ctx = build({ category: { name: "backend" } });
    expect(ctx.category?.description).toBeUndefined();
  });

  it("does NOT expose category patterns or other raw fields", () => {
    const ctx = build({
      category: {
        name: "backend",
        description: "APIs",
      },
    });
    expect("patterns" in (ctx.category ?? {})).toBe(false);
    expect(Object.keys(ctx.category ?? {}).sort()).toEqual([
      "description",
      "name",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tool policy context projection
// ---------------------------------------------------------------------------

describe("buildTemplateContext — toolPolicy context", () => {
  it("projects all five effective capabilities", () => {
    const ctx = build({
      effectiveToolPolicy: {
        read: "allow",
        write: "deny",
        execute: "ask",
        delegate: "allow",
        network: "deny",
      },
    });

    expect(ctx.toolPolicy.effective.read).toBe("allow");
    expect(ctx.toolPolicy.effective.write).toBe("deny");
    expect(ctx.toolPolicy.effective.execute).toBe("ask");
    expect(ctx.toolPolicy.effective.delegate).toBe("allow");
    expect(ctx.toolPolicy.effective.network).toBe("deny");
  });

  it("does NOT expose raw tool policy", () => {
    const ctx = build();
    expect("raw" in ctx.toolPolicy).toBe(false);
    expect("rawToolPolicy" in ctx.toolPolicy).toBe(false);
  });

  it("only exposes effective sub-object under toolPolicy", () => {
    const ctx = build();
    const keys = Object.keys(ctx.toolPolicy);
    expect(keys).toEqual(["effective"]);
  });
});

// ---------------------------------------------------------------------------
// Delegation context — no targets
// ---------------------------------------------------------------------------

describe("buildTemplateContext — delegation with no targets", () => {
  it("delegation.targets is an empty array", () => {
    const ctx = build({ delegationTargets: [] });
    expect(ctx.delegation.targets).toEqual([]);
  });

  it("delegation has only targets key when no targets", () => {
    const ctx = build({ delegationTargets: [] });
    expect(Object.keys(ctx.delegation)).toEqual(["targets"]);
  });
});

// ---------------------------------------------------------------------------
// Delegation context — with targets
// ---------------------------------------------------------------------------

describe("buildTemplateContext — delegation with targets", () => {
  it("projects target name", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.targets[0]?.name).toBe("shuttle-backend");
  });

  it("projects target description when present", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend", "Backend specialist")],
    });
    expect(ctx.delegation.targets[0]?.description).toBe("Backend specialist");
  });

  it("omits target description when absent", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.targets[0]?.description).toBeUndefined();
  });

  it("projects exact trigger strings in source order", () => {
    const ctx = build({
      delegationTargets: [
        makeTarget("shuttle-backend", undefined, [
          "REST endpoint changes",
          "GraphQL changes",
          "Schema migrations",
        ]),
      ],
    });
    expect(ctx.delegation.targets[0]?.triggers).toEqual([
      "REST endpoint changes",
      "GraphQL changes",
      "Schema migrations",
    ]);
  });

  it("projects an empty trigger array when the target has no triggers", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.targets[0]?.triggers).toEqual([]);
  });

  it("copies trigger arrays so later mutation cannot change the context", () => {
    const triggers = ["review code", "fix tests"];
    const ctx = build({
      delegationTargets: [makeTarget("shuttle", undefined, triggers)],
    });
    triggers.push("do not leak");
    expect(ctx.delegation.targets[0]?.triggers).toEqual([
      "review code",
      "fix tests",
    ]);
    expect(ctx.delegation.targets[0]?.triggers).not.toBe(triggers);
  });

  it("does not invent domains or structured trigger members", () => {
    const ctx = build({
      delegationTargets: [
        makeTarget("shuttle-backend", undefined, ["REST endpoint changes"]),
      ],
    });
    const target = ctx.delegation.targets[0];
    expect(target).toBeDefined();
    if (target === undefined) return;
    expect("domains" in target).toBe(false);
    expect(target.triggers).toEqual(["REST endpoint changes"]);
    expect(Object.keys(target).sort()).toEqual([
      "isCategory",
      "name",
      "triggers",
    ]);
  });

  it("projects isCategory=false for regular agents", () => {
    const ctx = build({
      delegationTargets: [makeTarget("thread", "Codebase explorer", [], false)],
    });
    expect(ctx.delegation.targets[0]?.isCategory).toBe(false);
  });

  it("projects isCategory=true for category shuttle agents", () => {
    const ctx = build({
      delegationTargets: [
        makeTarget("shuttle-frontend", "Frontend specialist", [], true),
      ],
    });
    expect(ctx.delegation.targets[0]?.isCategory).toBe(true);
  });

  it("correctly distinguishes category and non-category targets in same list", () => {
    const ctx = build({
      delegationTargets: [
        makeTarget("thread", "Codebase explorer", [], false),
        makeTarget("shuttle-core", "Core specialist", [], true),
        makeTarget("pattern", "Planner", [], false),
      ],
    });
    expect(ctx.delegation.targets[0]?.isCategory).toBe(false);
    expect(ctx.delegation.targets[1]?.isCategory).toBe(true);
    expect(ctx.delegation.targets[2]?.isCategory).toBe(false);
  });

  it("delegation has only targets key (no mermaid or section)", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(Object.keys(ctx.delegation)).toEqual(["targets"]);
  });
});

// ---------------------------------------------------------------------------
// No raw config exposure
// ---------------------------------------------------------------------------

describe("buildTemplateContext — no raw config exposure", () => {
  it("context does not contain models field at top level", () => {
    const ctx = build();
    expect("models" in ctx).toBe(false);
  });

  it("context does not contain temperature field at top level", () => {
    const ctx = build();
    expect("temperature" in ctx).toBe(false);
  });

  it("context does not contain prompt_file field at top level", () => {
    const ctx = build();
    expect("prompt_file" in ctx).toBe(false);
  });

  it("context does not contain rawToolPolicy field", () => {
    const ctx = build();
    expect("rawToolPolicy" in ctx).toBe(false);
  });

  it("context does not contain config field", () => {
    const ctx = build();
    expect("config" in ctx).toBe(false);
  });

  it("top-level context keys are only: agent, toolPolicy, delegation (and optional category, reviewRouting)", () => {
    const ctxNoCategory = build({ category: undefined });
    const keysNoCategory = Object.keys(ctxNoCategory).sort();
    expect(keysNoCategory).toEqual(["agent", "delegation", "toolPolicy"]);

    const ctxWithCategory = build({ category: { name: "frontend" } });
    const keysWithCategory = Object.keys(ctxWithCategory).sort();
    expect(keysWithCategory).toEqual([
      "agent",
      "category",
      "delegation",
      "toolPolicy",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Review routing context
// ---------------------------------------------------------------------------

describe("ALLOWED_TEMPLATE_PATHS — reviewRouting", () => {
  it("contains all reviewRouting paths", () => {
    expect(ALLOWED_TEMPLATE_PATHS.has("reviewRouting")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("reviewRouting.groups")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("reviewRouting.groups.sourceAgent")).toBe(
      true,
    );
    expect(ALLOWED_TEMPLATE_PATHS.has("reviewRouting.groups.variants")).toBe(
      true,
    );
    expect(
      ALLOWED_TEMPLATE_PATHS.has("reviewRouting.groups.variants.name"),
    ).toBe(true);
    expect(
      ALLOWED_TEMPLATE_PATHS.has("reviewRouting.groups.variants.model"),
    ).toBe(true);
  });
});

describe("buildTemplateContext — reviewRouting", () => {
  const sampleRouting: ReviewRoutingContext = {
    groups: [
      {
        sourceAgent: "weft",
        variants: [
          { name: "weft-openai-gpt-5", model: "openai/gpt-5" },
          { name: "weft-anthropic-claude", model: "anthropic/claude-4" },
        ],
      },
    ],
  };

  it("omits reviewRouting when not provided", () => {
    const ctx = build();
    expect("reviewRouting" in ctx).toBe(false);
  });

  it("passes reviewRouting through when provided", () => {
    const ctx = build({ reviewRouting: sampleRouting });
    expect(ctx.reviewRouting).toEqual(sampleRouting);
  });

  it("projects reviewRouting.groups correctly", () => {
    const ctx = build({ reviewRouting: sampleRouting });
    expect(ctx.reviewRouting?.groups).toHaveLength(1);
    expect(ctx.reviewRouting?.groups[0]?.sourceAgent).toBe("weft");
  });

  it("projects variants correctly", () => {
    const ctx = build({ reviewRouting: sampleRouting });
    const variants = ctx.reviewRouting?.groups[0]?.variants;
    expect(variants).toHaveLength(2);
    expect(variants?.[0]).toEqual({
      name: "weft-openai-gpt-5",
      model: "openai/gpt-5",
    });
  });

  it("includes reviewRouting in top-level keys when provided", () => {
    const ctx = build({ reviewRouting: sampleRouting });
    expect(Object.keys(ctx).sort()).toEqual([
      "agent",
      "delegation",
      "reviewRouting",
      "toolPolicy",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

describe("buildTemplateContext — Result type", () => {
  it("returns ok result for valid input", () => {
    const result = buildTemplateContext(makeInput());
    expect(result.isOk()).toBe(true);
  });

  it("returned value matches AgentPromptTemplateContext shape", () => {
    const result = buildTemplateContext(makeInput());
    if (result.isErr()) throw new Error("expected ok");

    const ctx = result.value;
    expect(ctx).toHaveProperty("agent");
    expect(ctx).toHaveProperty("toolPolicy");
    expect(ctx).toHaveProperty("delegation");
  });
});
