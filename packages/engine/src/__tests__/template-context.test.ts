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
 * - Mermaid diagram generation: stable node IDs, escaped labels, domain edge labels
 * - Delegation section Markdown: ## Delegation, Mermaid block, compact bullets
 * - No-target omission: delegation.section and delegation.mermaid absent when no targets
 * - Domain deduplication across triggers
 */

import { describe, expect, it } from "bun:test";

import type { WorkflowConfig } from "@weave/core";
import type { DelegationTarget } from "../compose.js";
import {
  type AgentPromptTemplateContext,
  ALLOWED_TEMPLATE_PATHS,
  buildTemplateContext,
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
  triggers: Array<{ domain: string; trigger: string }> = [],
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
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.section")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.mermaid")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets.name")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets.description")).toBe(
      true,
    );
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets.domains")).toBe(true);
    expect(ALLOWED_TEMPLATE_PATHS.has("delegation.targets.triggers")).toBe(
      true,
    );
    expect(
      ALLOWED_TEMPLATE_PATHS.has("delegation.targets.triggers.domain"),
    ).toBe(true);
    expect(
      ALLOWED_TEMPLATE_PATHS.has("delegation.targets.triggers.trigger"),
    ).toBe(true);
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
    expect(
      (ctx.agent as unknown as Record<string, unknown>).models,
    ).toBeUndefined();
  });

  it("does NOT expose temperature on agent context", () => {
    const ctx = build();
    expect(
      (ctx.agent as unknown as Record<string, unknown>).temperature,
    ).toBeUndefined();
  });

  it("does NOT expose prompt_file on agent context", () => {
    const ctx = build();
    expect(
      (ctx.agent as unknown as Record<string, unknown>).prompt_file,
    ).toBeUndefined();
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
    const ctx = build({ category: { name: "backend" } });
    expect(
      (ctx.category as unknown as Record<string, unknown> | undefined)
        ?.patterns,
    ).toBeUndefined();
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
    expect(
      (ctx.toolPolicy as unknown as Record<string, unknown>).raw,
    ).toBeUndefined();
    expect(
      (ctx.toolPolicy as unknown as Record<string, unknown>).rawToolPolicy,
    ).toBeUndefined();
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

  it("delegation.mermaid is omitted when no targets", () => {
    const ctx = build({ delegationTargets: [] });
    expect(ctx.delegation.mermaid).toBeUndefined();
  });

  it("delegation.section is omitted when no targets", () => {
    const ctx = build({ delegationTargets: [] });
    expect(ctx.delegation.section).toBeUndefined();
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

  it("projects trigger details", () => {
    const ctx = build({
      delegationTargets: [
        makeTarget("shuttle-backend", undefined, [
          { domain: "API", trigger: "REST endpoint changes" },
        ]),
      ],
    });
    expect(ctx.delegation.targets[0]?.triggers).toEqual([
      { domain: "API", trigger: "REST endpoint changes" },
    ]);
  });

  it("deduplicates domains across triggers", () => {
    const ctx = build({
      delegationTargets: [
        makeTarget("shuttle-backend", undefined, [
          { domain: "API", trigger: "REST endpoint changes" },
          { domain: "API", trigger: "GraphQL changes" },
          { domain: "DB", trigger: "Schema migrations" },
        ]),
      ],
    });
    expect(ctx.delegation.targets[0]?.domains).toEqual(["API", "DB"]);
  });

  it("preserves domain order (first occurrence wins)", () => {
    const ctx = build({
      delegationTargets: [
        makeTarget("shuttle-backend", undefined, [
          { domain: "DB", trigger: "Schema changes" },
          { domain: "API", trigger: "REST changes" },
          { domain: "DB", trigger: "Migration" },
        ]),
      ],
    });
    expect(ctx.delegation.targets[0]?.domains).toEqual(["DB", "API"]);
  });

  it("empty domains array when target has no triggers", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.targets[0]?.domains).toEqual([]);
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

  it("delegation.mermaid is present when targets exist", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.mermaid).toBeDefined();
  });

  it("delegation.section is present when targets exist", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.section).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mermaid diagram generation
// ---------------------------------------------------------------------------

describe("buildTemplateContext — Mermaid diagram", () => {
  it("starts with flowchart TD", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle")],
    });
    expect(ctx.delegation.mermaid).toMatch(/^flowchart TD/);
  });

  it("uses stable synthetic node IDs A0 for current agent", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle")],
    });
    expect(ctx.delegation.mermaid).toContain('A0["loom"]');
  });

  it("uses stable synthetic node IDs A1, A2 for targets", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [
        makeTarget("shuttle-backend"),
        makeTarget("shuttle-frontend"),
      ],
    });
    expect(ctx.delegation.mermaid).toContain('A1["shuttle-backend"]');
    expect(ctx.delegation.mermaid).toContain('A2["shuttle-frontend"]');
  });

  it("generates edge from A0 to each target", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [
        makeTarget("shuttle-backend"),
        makeTarget("shuttle-frontend"),
      ],
    });
    expect(ctx.delegation.mermaid).toContain("A0 --> A1");
    expect(ctx.delegation.mermaid).toContain("A0 --> A2");
  });

  it("labels edges with deduplicated domain names", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [
        makeTarget("shuttle-backend", undefined, [
          { domain: "API", trigger: "REST changes" },
          { domain: "DB", trigger: "Schema changes" },
        ]),
      ],
    });
    expect(ctx.delegation.mermaid).toContain('A0 -->|"API, DB"| A1');
  });

  it("generates unlabelled edge when target has no triggers", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.mermaid).toContain("A0 --> A1");
    expect(ctx.delegation.mermaid).not.toContain("A0 -->|");
  });

  it("escapes double quotes in agent name labels", () => {
    const ctx = build({
      agentName: 'agent-with-"quotes"',
      delegationTargets: [makeTarget("shuttle")],
    });
    expect(ctx.delegation.mermaid).toContain(
      'A0["agent-with-&quot;quotes&quot;"]',
    );
  });

  it("escapes double quotes in target name labels", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget('target-"quoted"')],
    });
    expect(ctx.delegation.mermaid).toContain('A1["target-&quot;quoted&quot;"]');
  });

  it("escapes double quotes in domain edge labels", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [
        makeTarget("shuttle", undefined, [
          { domain: 'Domain "X"', trigger: "some trigger" },
        ]),
      ],
    });
    expect(ctx.delegation.mermaid).toContain(
      'A0 -->|"Domain &quot;X&quot;"| A1',
    );
  });

  it("is deterministic across multiple calls with same input", () => {
    const input = makeInput({
      agentName: "loom",
      delegationTargets: [
        makeTarget("shuttle-backend", "Backend", [
          { domain: "API", trigger: "REST" },
        ]),
        makeTarget("shuttle-frontend", "Frontend", [
          { domain: "UI", trigger: "Components" },
        ]),
      ],
    });

    const ctx1 = buildTemplateContext(input);
    const ctx2 = buildTemplateContext(input);

    if (ctx1.isErr() || ctx2.isErr()) throw new Error("build failed");
    expect(ctx1.value.delegation.mermaid).toBe(ctx2.value.delegation.mermaid);
  });
});

// ---------------------------------------------------------------------------
// Delegation section Markdown
// ---------------------------------------------------------------------------

describe("buildTemplateContext — delegation.section Markdown", () => {
  it("starts with ## Delegation heading", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.section).toMatch(/^## Delegation/);
  });

  it("contains a mermaid code block", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.section).toContain("```mermaid");
    expect(ctx.delegation.section).toContain("```");
  });

  it("contains flowchart TD inside the mermaid block", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.section).toContain("flowchart TD");
  });

  it("contains compact bullet for each target", () => {
    const ctx = build({
      delegationTargets: [
        makeTarget("shuttle-backend"),
        makeTarget("shuttle-frontend"),
      ],
    });
    expect(ctx.delegation.section).toContain("- shuttle-backend");
    expect(ctx.delegation.section).toContain("- shuttle-frontend");
  });

  it("includes description in bullet when present", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend", "Backend specialist")],
    });
    expect(ctx.delegation.section).toContain(
      "- shuttle-backend: Backend specialist",
    );
  });

  it("omits description from bullet when absent", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    expect(ctx.delegation.section).toContain("- shuttle-backend");
    expect(ctx.delegation.section).not.toContain("- shuttle-backend:");
  });

  it("includes nested trigger lines under each bullet", () => {
    const ctx = build({
      delegationTargets: [
        makeTarget("shuttle-backend", undefined, [
          { domain: "API", trigger: "REST endpoint changes" },
          { domain: "DB", trigger: "Schema migrations" },
        ]),
      ],
    });
    expect(ctx.delegation.section).toContain("  - API: REST endpoint changes");
    expect(ctx.delegation.section).toContain("  - DB: Schema migrations");
  });

  it("no trigger lines when target has no triggers", () => {
    const ctx = build({
      delegationTargets: [makeTarget("shuttle-backend")],
    });
    // Should have the bullet but no indented sub-bullets
    const lines = ctx.delegation.section?.split("\n") ?? [];
    const triggerLines = lines.filter((l) => l.startsWith("  - "));
    expect(triggerLines).toHaveLength(0);
  });

  it("mermaid block content matches delegation.mermaid", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [
        makeTarget("shuttle-backend", "Backend", [
          { domain: "API", trigger: "REST" },
        ]),
      ],
    });
    expect(ctx.delegation.section).toContain(ctx.delegation.mermaid ?? "");
  });
});

// ---------------------------------------------------------------------------
// No raw config exposure
// ---------------------------------------------------------------------------

describe("buildTemplateContext — no raw config exposure", () => {
  it("context does not contain models field at top level", () => {
    const ctx = build();
    expect((ctx as unknown as Record<string, unknown>).models).toBeUndefined();
  });

  it("context does not contain temperature field at top level", () => {
    const ctx = build();
    expect(
      (ctx as unknown as Record<string, unknown>).temperature,
    ).toBeUndefined();
  });

  it("context does not contain prompt_file field at top level", () => {
    const ctx = build();
    expect(
      (ctx as unknown as Record<string, unknown>).prompt_file,
    ).toBeUndefined();
  });

  it("context does not contain rawToolPolicy field", () => {
    const ctx = build();
    expect(
      (ctx as unknown as Record<string, unknown>).rawToolPolicy,
    ).toBeUndefined();
  });

  it("context does not contain config field", () => {
    const ctx = build();
    expect((ctx as unknown as Record<string, unknown>).config).toBeUndefined();
  });

  it("top-level context keys are only: agent, toolPolicy, delegation (and optional category)", () => {
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

// ---------------------------------------------------------------------------
// Workflow-aware Mermaid diagram generation
// ---------------------------------------------------------------------------

function makeWorkflow(
  description: string,
  steps: Array<{
    name: string;
    displayName?: string;
    type: "autonomous" | "interactive" | "gate";
    agent: string;
  }>,
): WorkflowConfig {
  return {
    description,
    version: 1,
    steps: steps.map((s) => ({
      name: s.name,
      display_name: s.displayName,
      type: s.type,
      agent: s.agent,
      prompt: `Do ${s.name}`,
      completion: { method: "agent_signal" as const },
    })),
  };
}

describe("buildTemplateContext — workflow-aware Mermaid diagram", () => {
  it("uses workflow subgraph diagram when workflows are provided", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle"), makeTarget("weft")],
      workflows: {
        "quick-fix": makeWorkflow("Fix a bug and get it reviewed", [
          { name: "fix", type: "autonomous", agent: "shuttle" },
          { name: "review", type: "gate", agent: "weft" },
        ]),
      },
    });
    expect(ctx.delegation.mermaid).toContain("subgraph");
    expect(ctx.delegation.mermaid).toContain("quick-fix");
  });

  it("gate steps use hexagon {{}} syntax", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle"), makeTarget("weft")],
      workflows: {
        "quick-fix": makeWorkflow("Fix a bug", [
          { name: "fix", type: "autonomous", agent: "shuttle" },
          { name: "review", type: "gate", agent: "weft" },
        ]),
      },
    });
    // Gate steps use {{"agent"}} hexagon syntax
    expect(ctx.delegation.mermaid).toContain('{{"weft"}}');
  });

  it('autonomous steps use rectangle [""] syntax', () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle"), makeTarget("weft")],
      workflows: {
        "quick-fix": makeWorkflow("Fix a bug", [
          { name: "fix", type: "autonomous", agent: "shuttle" },
          { name: "review", type: "gate", agent: "weft" },
        ]),
      },
    });
    // Autonomous steps use ["agent"] rectangle syntax
    expect(ctx.delegation.mermaid).toContain('["shuttle"]');
  });

  it("steps are connected in sequence order with step name as edge label", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [
        makeTarget("shuttle"),
        makeTarget("weft"),
        makeTarget("warp"),
      ],
      workflows: {
        "plan-and-execute": makeWorkflow("Plan and execute", [
          { name: "implement", type: "autonomous", agent: "shuttle" },
          { name: "review", type: "gate", agent: "weft" },
          { name: "security", type: "gate", agent: "warp" },
        ]),
      },
    });
    // step[0] → step[1] labelled with step[1].name
    expect(ctx.delegation.mermaid).toContain('-->|"review"|');
    // step[1] → step[2] labelled with step[2].name
    expect(ctx.delegation.mermaid).toContain('-->|"security"|');
  });

  it("workflow prefix is derived from workflow name words", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle"), makeTarget("weft")],
      workflows: {
        "quick-fix": makeWorkflow("Fix a bug", [
          { name: "fix", type: "autonomous", agent: "shuttle" },
          { name: "review", type: "gate", agent: "weft" },
        ]),
      },
    });
    // quick-fix → QF prefix
    expect(ctx.delegation.mermaid).toContain("QF_shuttle");
    expect(ctx.delegation.mermaid).toContain("QF_weft");
  });

  it("filters out workflows with no relevant steps", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle")],
      workflows: {
        "irrelevant-workflow": makeWorkflow("Irrelevant", [
          { name: "step1", type: "autonomous", agent: "some-other-agent" },
        ]),
        "relevant-workflow": makeWorkflow("Relevant", [
          { name: "step1", type: "autonomous", agent: "shuttle" },
        ]),
      },
    });
    expect(ctx.delegation.mermaid).not.toContain("irrelevant-workflow");
    expect(ctx.delegation.mermaid).toContain("relevant-workflow");
  });

  it("includes workflow where current agent itself appears in a step", () => {
    const ctx = build({
      agentName: "tapestry",
      delegationTargets: [makeTarget("shuttle")],
      workflows: {
        "tapestry-execution": makeWorkflow("Tapestry execution", [
          { name: "execute", type: "autonomous", agent: "tapestry" },
          { name: "review", type: "gate", agent: "shuttle" },
        ]),
      },
    });
    expect(ctx.delegation.mermaid).toContain("tapestry-execution");
  });

  it("falls back to flat star when no workflows provided", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle"), makeTarget("weft")],
      // no workflows field
    });
    // Flat star uses A0, A1, A2 node IDs
    expect(ctx.delegation.mermaid).toContain('A0["loom"]');
    expect(ctx.delegation.mermaid).toContain('A1["shuttle"]');
    expect(ctx.delegation.mermaid).toContain("A0 --> A1");
    expect(ctx.delegation.mermaid).not.toContain("subgraph");
  });

  it("falls back to flat star when empty workflows object provided", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle")],
      workflows: {},
    });
    expect(ctx.delegation.mermaid).toContain('A0["loom"]');
    expect(ctx.delegation.mermaid).not.toContain("subgraph");
  });

  it("workflow diagram starts with flowchart TD", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle")],
      workflows: {
        "quick-fix": makeWorkflow("Fix a bug", [
          { name: "fix", type: "autonomous", agent: "shuttle" },
        ]),
      },
    });
    expect(ctx.delegation.mermaid).toMatch(/^flowchart TD/);
  });

  it("subgraph label includes workflow name and description", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle"), makeTarget("weft")],
      workflows: {
        "quick-fix": makeWorkflow("Fix a bug and get it reviewed", [
          { name: "fix", type: "autonomous", agent: "shuttle" },
          { name: "review", type: "gate", agent: "weft" },
        ]),
      },
    });
    expect(ctx.delegation.mermaid).toContain(
      '"quick-fix: Fix a bug and get it reviewed"',
    );
  });

  it("multiple workflows produce multiple subgraphs", () => {
    const ctx = build({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle"), makeTarget("weft")],
      workflows: {
        "quick-fix": makeWorkflow("Fix a bug", [
          { name: "fix", type: "autonomous", agent: "shuttle" },
          { name: "review", type: "gate", agent: "weft" },
        ]),
        "plan-and-execute": makeWorkflow("Plan and execute", [
          { name: "implement", type: "autonomous", agent: "shuttle" },
          { name: "review", type: "gate", agent: "weft" },
        ]),
      },
    });
    expect(ctx.delegation.mermaid).toContain("subgraph quick-fix");
    expect(ctx.delegation.mermaid).toContain("subgraph plan-and-execute");
  });

  it("is deterministic across multiple calls with same workflow input", () => {
    const input = makeInput({
      agentName: "loom",
      delegationTargets: [makeTarget("shuttle"), makeTarget("weft")],
      workflows: {
        "quick-fix": makeWorkflow("Fix a bug", [
          { name: "fix", type: "autonomous", agent: "shuttle" },
          { name: "review", type: "gate", agent: "weft" },
        ]),
      },
    });

    const ctx1 = buildTemplateContext(input);
    const ctx2 = buildTemplateContext(input);

    if (ctx1.isErr() || ctx2.isErr()) throw new Error("build failed");
    expect(ctx1.value.delegation.mermaid).toBe(ctx2.value.delegation.mermaid);
  });
});
