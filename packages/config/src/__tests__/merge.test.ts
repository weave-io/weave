import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weave/core";
import { parseConfig } from "@weave/core";
import { mergeConfigs, mergeConfigsResult, mergeWorkflow } from "../merge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a .weave source string and unwrap — throws on invalid input. */
function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const emptyConfig = cfg("");

// ---------------------------------------------------------------------------
// Tests — existing mergeConfigs behaviour (backwards compat)
// ---------------------------------------------------------------------------

describe("mergeConfigs", () => {
  // -------------------------------------------------------------------------
  // Scalars
  // -------------------------------------------------------------------------

  it("(a) scalar override: last-defined settings.log_level wins", () => {
    const a = cfg("settings { log_level INFO }");
    const b = cfg("settings { log_level DEBUG }");
    const merged = mergeConfigs(a, b);
    expect(merged.settings.log_level).toBe("DEBUG");
  });

  it("(b) three-layer scalar: only third layer sets settings.log_level → third value wins", () => {
    const a = cfg("");
    const b = cfg("");
    const c = cfg("settings { log_level WARN }");
    const merged = mergeConfigs(a, b, c);
    expect(merged.settings.log_level).toBe("WARN");
  });

  // -------------------------------------------------------------------------
  // Agent deep-merge
  // -------------------------------------------------------------------------

  it("(c) agent deep-merge: partial override preserves unset fields", () => {
    const base = cfg(`
      agent loom {
        prompt_file "loom.md"
        models ["claude-sonnet-4-5"]
        temperature 0.1
      }
    `);
    const override = cfg(`
      agent loom {
        temperature 0.5
      }
    `);
    const merged = mergeConfigs(base, override);
    const loom = merged.agents.loom;
    expect(loom?.temperature).toBe(0.5);
    expect(loom?.prompt_file).toBe("loom.md");
    expect(loom?.models).toEqual(["claude-sonnet-4-5"]);
  });

  it("(d) agent addition: agents from different scopes both present in merged config", () => {
    const base = cfg(
      `agent loom { prompt "I am loom" models ["claude-sonnet-4-5"] }`,
    );
    const addition = cfg(
      `agent my-helper { prompt "I help" models ["gpt-4o"] }`,
    );
    const merged = mergeConfigs(base, addition);
    expect(merged.agents.loom).toBeDefined();
    expect(merged.agents["my-helper"]).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Array union-merge
  // -------------------------------------------------------------------------

  it("(e) array union-merge (models): override entries first, then base", () => {
    const base = cfg(`agent loom { prompt "x" models ["gpt-4o"] }`);
    const override = cfg(
      `agent loom { prompt "x" models ["claude-sonnet-4-5"] }`,
    );
    const merged = mergeConfigs(base, override);
    expect(merged.agents.loom?.models).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
  });

  it("(f) array union-merge (disabled.agents): union across scopes, override first", () => {
    const global = cfg(`disable agents ["warp"]`);
    const project = cfg(`disable agents ["spindle"]`);
    const merged = mergeConfigs(global, project);
    // project is override so spindle comes first
    expect(merged.disabled.agents).toEqual(["spindle", "warp"]);
  });

  it("(g) array union-merge dedup: duplicate model appears exactly once", () => {
    const base = cfg(
      `agent loom { prompt "x" models ["claude-sonnet-4-5", "gpt-4o"] }`,
    );
    const override = cfg(
      `agent loom { prompt "x" models ["claude-sonnet-4-5"] }`,
    );
    const merged = mergeConfigs(base, override);
    const models = merged.agents.loom?.models ?? [];
    const claudeCount = models.filter((m) => m === "claude-sonnet-4-5").length;
    expect(claudeCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("(h) empty config merges: valid empty config returned", () => {
    const merged = mergeConfigs(emptyConfig, emptyConfig);
    expect(merged.agents).toEqual({});
    expect(merged.disabled.agents).toEqual([]);
  });

  it("(i) single config: returns equivalent config", () => {
    const single = cfg(`
      agent shuttle { prompt "I shuttle" models ["claude-sonnet-4-5"] }
    `);
    const merged = mergeConfigs(single);
    expect(merged.agents.shuttle).toBeDefined();
    expect(merged.agents.shuttle?.prompt).toBe("I shuttle");
  });

  it("(j) zero configs: returns default empty WeaveConfig", () => {
    const merged = mergeConfigs();
    expect(merged.agents).toEqual({});
    expect(merged.categories).toEqual({});
    expect(merged.disabled.agents).toEqual([]);
  });

  it("(k) immutability: inputs are not mutated after merge", () => {
    const base = cfg(`
      agent loom {
        prompt_file "loom.md"
        models ["claude-sonnet-4-5"]
        temperature 0.1
      }
    `);
    const override = cfg(`agent loom { temperature 0.5 }`);

    // Snapshot the original values
    const originalBaseTemp = base.agents.loom?.temperature;
    const originalBasePromptFile = base.agents.loom?.prompt_file;

    mergeConfigs(base, override);

    expect(base.agents.loom?.temperature).toBe(originalBaseTemp);
    expect(base.agents.loom?.prompt_file).toBe(originalBasePromptFile);
  });

  it("(m) three-layer agent deep-merge: each layer contributes distinct fields", () => {
    // Builtin: full loom definition
    const builtin = cfg(`
      agent loom {
        prompt_file "loom.md"
        models ["claude-sonnet-4-5"]
        temperature 0.1
        mode primary
        tool_policy { read allow write allow }
      }
    `);
    // Global: overrides models only
    const global = cfg(`agent loom { models ["gpt-4o"] }`);
    // Project: overrides temperature only
    const project = cfg(`agent loom { temperature 0.9 }`);

    const merged = mergeConfigs(builtin, global, project);
    const loom = merged.agents.loom;

    // Project wins on temperature
    expect(loom?.temperature).toBe(0.9);
    // Global adds gpt-4o (project-first union-merge: project has nothing, so global "gpt-4o" first, then builtin)
    expect(loom?.models).toEqual(["gpt-4o", "claude-sonnet-4-5"]);
    // Builtin values preserved for fields neither global nor project touched
    expect(loom?.prompt_file).toBe("loom.md");
    expect(loom?.mode).toBe("primary");
    expect(loom?.tool_policy?.read).toBe("allow");
    expect(loom?.tool_policy?.write).toBe("allow");
  });

  it("(l) tool_policy deep-merge: base policy + extra key from override, all keys present", () => {
    const base = cfg(`
      agent loom {
        prompt "x"
        tool_policy {
          read allow
          write allow
        }
      }
    `);
    const override = cfg(`
      agent loom {
        prompt "x"
        tool_policy {
          network ask
        }
      }
    `);
    const merged = mergeConfigs(base, override);
    const policy = merged.agents.loom?.tool_policy;
    expect(policy?.read).toBe("allow");
    expect(policy?.write).toBe("allow");
    expect(policy?.network).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Tests — workflow backwards compat (no extends)
// ---------------------------------------------------------------------------

describe("mergeConfigs — workflow backwards compat (no extends)", () => {
  it("workflow without extends: override steps union-merge with base steps", () => {
    const base = cfg(`
      workflow quick-fix {
        description "Fix a bug"
        version 1
        step fix {
          name "Implement the fix"
          type autonomous
          agent shuttle
          prompt "Fix the issue"
          completion agent_signal
        }
      }
    `);
    const override = cfg(`
      workflow quick-fix {
        description "Fix a bug (overridden)"
        version 1
        step fix {
          name "Implement the fix"
          type autonomous
          agent shuttle
          prompt "Fix the issue"
          completion agent_signal
        }
        step review {
          name "Code review"
          type gate
          agent weft
          prompt "Review the fix"
          completion review_verdict
          on_reject pause
        }
      }
    `);
    const merged = mergeConfigs(base, override);
    const wf = merged.workflows["quick-fix"];
    expect(wf).toBeDefined();
    // description from override wins
    expect(wf?.description).toBe("Fix a bug (overridden)");
    // steps union-merged (override first, then base entries not already present)
    expect(wf?.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("workflow without extends: new workflow in override is added to merged config", () => {
    const base = cfg(`
      workflow quick-fix {
        version 1
        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it"
          completion agent_signal
        }
      }
    `);
    const override = cfg(`
      workflow new-workflow {
        version 1
        step do-it {
          name "Do it"
          type autonomous
          agent shuttle
          prompt "Do the thing"
          completion agent_signal
        }
      }
    `);
    const merged = mergeConfigs(base, override);
    expect(merged.workflows["quick-fix"]).toBeDefined();
    expect(merged.workflows["new-workflow"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — mergeWorkflow step-aware merge
// ---------------------------------------------------------------------------

describe("mergeWorkflow — step-aware merge", () => {
  // Helper: build a minimal WorkflowConfig from parsed DSL
  function wf(source: string) {
    const result = parseConfig(source);
    if (result.isErr()) throw new Error(JSON.stringify(result.error));
    const workflows = result.value.workflows;
    const keys = Object.keys(workflows);
    if (keys.length === 0) throw new Error("No workflow in source");
    return { name: keys[0] as string, config: workflows[keys[0] as string]! };
  }

  it("insert_before: spec step inserted before plan in plan-and-execute", () => {
    // Simulate the builtin plan-and-execute workflow
    const baseSrc = `
      workflow plan-and-execute {
        description "Research, plan, implement, and review"
        version 1
        step research {
          name "Research the codebase"
          type autonomous
          agent thread
          prompt "Explore the codebase"
          completion agent_signal
        }
        step plan {
          name "Create implementation plan"
          type autonomous
          agent pattern
          prompt "Create a plan"
          completion plan_created { plan_name "{{instance.slug}}" }
          outputs [{ name "plan_path" description "Path to plan" }]
        }
        step implement {
          name "Execute the plan"
          type autonomous
          agent tapestry
          prompt "Execute the plan"
          completion plan_complete { plan_name "{{instance.slug}}" }
          inputs [{ name "plan_path" description "Path to plan" }]
        }
        step review {
          name "Code review"
          type gate
          agent weft
          prompt "Review changes"
          completion review_verdict
          on_reject pause
        }
      }
    `;
    const overrideSrc = `
      workflow plan-and-execute {
        extends "plan-and-execute"
        version 1
        step spec {
          name "Write spec"
          type autonomous
          agent pattern
          prompt "Write a spec for: {{instance.goal}}"
          completion agent_signal
          insert_before "plan"
        }
      }
    `;

    const baseWf = wf(baseSrc);
    const overrideWf = wf(overrideSrc);

    // Build a workflow map that includes the base
    const workflowMap = { "plan-and-execute": baseWf.config };

    const result = mergeWorkflow(
      "plan-and-execute",
      baseWf.config,
      overrideWf.config,
      workflowMap,
    );

    expect(result.isOk()).toBe(true);
    const merged = result._unsafeUnwrap();
    const stepNames = merged.steps.map((s) => s.name);

    // spec should appear immediately before plan
    const specIdx = stepNames.indexOf("spec");
    const planIdx = stepNames.indexOf("plan");
    expect(specIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(specIdx).toBe(planIdx - 1);

    // All original steps still present
    expect(stepNames).toContain("research");
    expect(stepNames).toContain("implement");
    expect(stepNames).toContain("review");
  });

  it("insert_after: step inserted after plan", () => {
    const baseSrc = `
      workflow plan-and-execute {
        version 1
        step plan {
          name "Create plan"
          type autonomous
          agent pattern
          prompt "Plan it"
          completion plan_created { plan_name "{{instance.slug}}" }
        }
        step implement {
          name "Execute"
          type autonomous
          agent tapestry
          prompt "Execute"
          completion plan_complete { plan_name "{{instance.slug}}" }
        }
      }
    `;
    const overrideSrc = `
      workflow plan-and-execute {
        extends "plan-and-execute"
        version 1
        step review-plan {
          name "Review plan"
          type interactive
          agent shuttle
          prompt "Review the plan"
          completion user_confirm
          insert_after "plan"
        }
      }
    `;

    const baseWf = wf(baseSrc);
    const overrideWf = wf(overrideSrc);
    const workflowMap = { "plan-and-execute": baseWf.config };

    const result = mergeWorkflow(
      "plan-and-execute",
      baseWf.config,
      overrideWf.config,
      workflowMap,
    );

    expect(result.isOk()).toBe(true);
    const merged = result._unsafeUnwrap();
    const stepNames = merged.steps.map((s) => s.name);

    const planIdx = stepNames.indexOf("plan");
    const reviewPlanIdx = stepNames.indexOf("review-plan");
    expect(reviewPlanIdx).toBe(planIdx + 1);
  });

  it("same-name replace: implement step prompt is replaced", () => {
    const baseSrc = `
      workflow plan-and-execute {
        version 1
        step plan {
          name "Create plan"
          type autonomous
          agent pattern
          prompt "Plan it"
          completion plan_created { plan_name "{{instance.slug}}" }
        }
        step implement {
          name "Execute the plan"
          type autonomous
          agent tapestry
          prompt "Original prompt"
          completion plan_complete { plan_name "{{instance.slug}}" }
        }
      }
    `;
    const overrideSrc = `
      workflow plan-and-execute {
        extends "plan-and-execute"
        version 1
        step implement {
          name "Execute the plan (overridden)"
          type autonomous
          agent shuttle
          prompt "Overridden prompt"
          completion plan_complete { plan_name "{{instance.slug}}" }
        }
      }
    `;

    const baseWf = wf(baseSrc);
    const overrideWf = wf(overrideSrc);
    const workflowMap = { "plan-and-execute": baseWf.config };

    const result = mergeWorkflow(
      "plan-and-execute",
      baseWf.config,
      overrideWf.config,
      workflowMap,
    );

    expect(result.isOk()).toBe(true);
    const merged = result._unsafeUnwrap();
    const implementStep = merged.steps.find((s) => s.name === "implement");
    expect(implementStep).toBeDefined();
    expect(implementStep?.prompt).toBe("Overridden prompt");
    expect(implementStep?.agent).toBe("shuttle");
    // plan step still present and unchanged
    const planStep = merged.steps.find((s) => s.name === "plan");
    expect(planStep?.prompt).toBe("Plan it");
    // step order preserved: plan before implement
    const stepNames = merged.steps.map((s) => s.name);
    expect(stepNames.indexOf("plan")).toBeLessThan(
      stepNames.indexOf("implement"),
    );
  });

  it("append: step with no anchor and no same-name match is appended", () => {
    const baseSrc = `
      workflow quick-fix {
        version 1
        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it"
          completion agent_signal
        }
      }
    `;
    const overrideSrc = `
      workflow quick-fix {
        extends "quick-fix"
        version 1
        step security {
          name "Security audit"
          type gate
          agent warp
          prompt "Audit it"
          completion review_verdict
          on_reject pause
        }
      }
    `;

    const baseWf = wf(baseSrc);
    const overrideWf = wf(overrideSrc);
    const workflowMap = { "quick-fix": baseWf.config };

    const result = mergeWorkflow(
      "quick-fix",
      baseWf.config,
      overrideWf.config,
      workflowMap,
    );

    expect(result.isOk()).toBe(true);
    const merged = result._unsafeUnwrap();
    const stepNames = merged.steps.map((s) => s.name);
    expect(stepNames).toEqual(["fix", "security"]);
  });

  it("UnknownInsertionAnchor: insert_before names a step that does not exist", () => {
    const baseSrc = `
      workflow quick-fix {
        version 1
        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it"
          completion agent_signal
        }
      }
    `;
    const overrideSrc = `
      workflow quick-fix {
        extends "quick-fix"
        version 1
        step new-step {
          name "New step"
          type autonomous
          agent shuttle
          prompt "New"
          completion agent_signal
          insert_before "nonexistent-step"
        }
      }
    `;

    const baseWf = wf(baseSrc);
    const overrideWf = wf(overrideSrc);
    const workflowMap = { "quick-fix": baseWf.config };

    const result = mergeWorkflow(
      "quick-fix",
      baseWf.config,
      overrideWf.config,
      workflowMap,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("UnknownInsertionAnchor");
    if (error.type === "UnknownInsertionAnchor") {
      expect(error.anchor).toBe("nonexistent-step");
      expect(error.stepName).toBe("new-step");
      expect(error.workflowName).toBe("quick-fix");
    }
  });

  it("UnknownExtendsTarget: extends names a workflow that does not exist", () => {
    const baseSrc = `
      workflow quick-fix {
        version 1
        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it"
          completion agent_signal
        }
      }
    `;
    const overrideSrc = `
      workflow quick-fix {
        extends "nonexistent-workflow"
        version 1
        step extra {
          name "Extra"
          type autonomous
          agent shuttle
          prompt "Extra"
          completion agent_signal
        }
      }
    `;

    const baseWf = wf(baseSrc);
    const overrideWf = wf(overrideSrc);
    // workflowMap does NOT contain "nonexistent-workflow"
    const workflowMap = { "quick-fix": baseWf.config };

    const result = mergeWorkflow(
      "quick-fix",
      baseWf.config,
      overrideWf.config,
      workflowMap,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("UnknownExtendsTarget");
    if (error.type === "UnknownExtendsTarget") {
      expect(error.extendsTarget).toBe("nonexistent-workflow");
      expect(error.workflowName).toBe("quick-fix");
    }
  });

  it("ExtendsCycle: workflow extends a chain that loops back", () => {
    // workflow-a extends workflow-b, workflow-b extends workflow-a → cycle
    const workflowA = wf(`
      workflow workflow-a {
        extends "workflow-b"
        version 1
        step extra {
          name "Extra"
          type autonomous
          agent shuttle
          prompt "Extra"
          completion agent_signal
        }
      }
    `);
    const workflowB = wf(`
      workflow workflow-b {
        extends "workflow-a"
        version 1
        step base {
          name "Base"
          type autonomous
          agent shuttle
          prompt "Base"
          completion agent_signal
        }
      }
    `);

    // workflowMap contains both — the cycle is detectable
    const workflowMap = {
      "workflow-a": workflowA.config,
      "workflow-b": workflowB.config,
    };

    // Merging workflow-a: override extends "workflow-b", which extends "workflow-a" → cycle
    const result = mergeWorkflow(
      "workflow-a",
      workflowA.config,
      workflowA.config,
      workflowMap,
    );

    // Self-reference is NOT a cycle (it uses base steps directly)
    // So we need to test with a different extends target that loops
    // Use a base that has no extends, and an override that extends a workflow
    // that itself extends the current workflow
    const baseSteps = [
      {
        name: "fix",
        display_name: "Fix",
        type: "autonomous" as const,
        agent: "shuttle",
        prompt: "Fix it",
        completion: { method: "agent_signal" as const },
      },
    ];
    const baseWfConfig = {
      version: 1,
      steps: baseSteps,
    };
    const overrideWfConfig = {
      version: 1,
      extends: "workflow-b",
      steps: [],
    };
    // workflow-b extends workflow-a (the current workflow) → cycle
    const wfBConfig = {
      version: 1,
      extends: "workflow-a",
      steps: [],
    };

    const cycleMap = {
      "workflow-a": baseWfConfig,
      "workflow-b": wfBConfig,
    };

    const cycleResult = mergeWorkflow(
      "workflow-a",
      baseWfConfig,
      overrideWfConfig,
      cycleMap,
    );

    expect(cycleResult.isErr()).toBe(true);
    const error = cycleResult._unsafeUnwrapErr();
    expect(error.type).toBe("ExtendsCycle");
    if (error.type === "ExtendsCycle") {
      expect(error.workflowName).toBe("workflow-a");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — mergeConfigsResult
// ---------------------------------------------------------------------------

describe("mergeConfigsResult", () => {
  it("returns ok for configs without workflow extension", () => {
    const a = cfg("settings { log_level INFO }");
    const b = cfg("settings { log_level DEBUG }");
    const result = mergeConfigsResult(a, b);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().settings.log_level).toBe("DEBUG");
  });

  it("returns ok for zero configs", () => {
    const result = mergeConfigsResult();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agents).toEqual({});
  });

  it("returns ok for single config", () => {
    const a = cfg(
      `agent loom { prompt "I am loom" models ["claude-sonnet-4-5"] }`,
    );
    const result = mergeConfigsResult(a);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agents.loom).toBeDefined();
  });

  it("insert_before via mergeConfigsResult: spec step before plan in plan-and-execute", () => {
    const base = cfg(`
      workflow plan-and-execute {
        description "Research, plan, implement, and review"
        version 1
        step research {
          name "Research the codebase and external context"
          type autonomous
          agent thread
          prompt "Explore the codebase to understand the relevant area for: {{instance.goal}}"
          completion agent_signal
        }
        step external-research {
          name "Fetch external documentation if needed"
          type autonomous
          agent spindle
          prompt "Research external APIs, libraries, or standards relevant to: {{instance.goal}}"
          completion agent_signal
        }
        step plan {
          name "Create implementation plan"
          type autonomous
          agent pattern
          prompt "Create a detailed implementation plan for: {{instance.goal}}"
          completion plan_created { plan_name "{{instance.slug}}" }
          outputs [{ name "plan_path" description "Path to the generated plan file" }]
        }
        step implement {
          name "Execute the plan"
          type autonomous
          agent tapestry
          prompt "Execute the plan at {{artifacts.plan_path}} for: {{instance.goal}}"
          completion plan_complete { plan_name "{{instance.slug}}" }
          inputs [{ name "plan_path" description "Path to the plan to execute" }]
        }
        step review {
          name "Code review"
          type gate
          agent weft
          prompt "Review all changes for: {{instance.goal}}"
          completion review_verdict
          on_reject pause
        }
        step security {
          name "Security audit"
          type gate
          agent warp
          prompt "Perform a security audit of all changes for: {{instance.goal}}"
          completion review_verdict
          on_reject pause
        }
      }
    `);

    const project = cfg(`
      workflow plan-and-execute {
        extends "plan-and-execute"
        version 1
        step spec {
          name "Write spec"
          type autonomous
          agent pattern
          prompt "Write a spec for: {{instance.goal}}"
          completion agent_signal
          insert_before "plan"
        }
      }
    `);

    const result = mergeConfigsResult(base, project);
    expect(result.isOk()).toBe(true);

    const merged = result._unsafeUnwrap();
    const wf = merged.workflows["plan-and-execute"];
    expect(wf).toBeDefined();

    const stepNames = wf!.steps.map((s) => s.name);
    const specIdx = stepNames.indexOf("spec");
    const planIdx = stepNames.indexOf("plan");

    expect(specIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(specIdx).toBe(planIdx - 1);

    // All original steps still present
    expect(stepNames).toContain("research");
    expect(stepNames).toContain("external-research");
    expect(stepNames).toContain("implement");
    expect(stepNames).toContain("review");
    expect(stepNames).toContain("security");
  });

  it("same-name replace via mergeConfigsResult: implement step prompt replaced", () => {
    const base = cfg(`
      workflow plan-and-execute {
        version 1
        step plan {
          name "Create implementation plan"
          type autonomous
          agent pattern
          prompt "Create a detailed implementation plan for: {{instance.goal}}"
          completion plan_created { plan_name "{{instance.slug}}" }
        }
        step implement {
          name "Execute the plan"
          type autonomous
          agent tapestry
          prompt "Execute the plan at {{artifacts.plan_path}} for: {{instance.goal}}"
          completion plan_complete { plan_name "{{instance.slug}}" }
        }
      }
    `);

    const project = cfg(`
      workflow plan-and-execute {
        extends "plan-and-execute"
        version 1
        step implement {
          name "Execute the plan (custom)"
          type autonomous
          agent shuttle
          prompt "Custom implementation prompt"
          completion plan_complete { plan_name "{{instance.slug}}" }
        }
      }
    `);

    const result = mergeConfigsResult(base, project);
    expect(result.isOk()).toBe(true);

    const merged = result._unsafeUnwrap();
    const wf = merged.workflows["plan-and-execute"];
    const implementStep = wf?.steps.find((s) => s.name === "implement");
    expect(implementStep?.prompt).toBe("Custom implementation prompt");
    expect(implementStep?.agent).toBe("shuttle");

    // plan step unchanged
    const planStep = wf?.steps.find((s) => s.name === "plan");
    expect(planStep?.prompt).toBe(
      "Create a detailed implementation plan for: {{instance.goal}}",
    );
  });

  it("returns err(MergeError[]) for UnknownInsertionAnchor", () => {
    const base = cfg(`
      workflow quick-fix {
        version 1
        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it"
          completion agent_signal
        }
      }
    `);
    const project = cfg(`
      workflow quick-fix {
        extends "quick-fix"
        version 1
        step new-step {
          name "New step"
          type autonomous
          agent shuttle
          prompt "New"
          completion agent_signal
          insert_before "ghost-step"
        }
      }
    `);

    const result = mergeConfigsResult(base, project);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.type).toBe("WorkflowExtensionError");
    if (errors[0]?.type === "WorkflowExtensionError") {
      expect(errors[0].error.type).toBe("UnknownInsertionAnchor");
    }
  });

  it("returns err(MergeError[]) for UnknownExtendsTarget", () => {
    const base = cfg(`
      workflow quick-fix {
        version 1
        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it"
          completion agent_signal
        }
      }
    `);
    const project = cfg(`
      workflow quick-fix {
        extends "does-not-exist"
        version 1
        step extra {
          name "Extra"
          type autonomous
          agent shuttle
          prompt "Extra"
          completion agent_signal
        }
      }
    `);

    const result = mergeConfigsResult(base, project);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors[0]?.type).toBe("WorkflowExtensionError");
    if (errors[0]?.type === "WorkflowExtensionError") {
      expect(errors[0].error.type).toBe("UnknownExtendsTarget");
    }
  });

  it("returns err(MergeError[]) for ExtendsCycle (A extends B, B extends A)", () => {
    // workflow-a extends workflow-b, workflow-b extends workflow-a → cycle
    // Both configs define both workflows so the cycle is detectable in the map
    const base = cfg(`
      workflow workflow-a {
        version 1
        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it"
          completion agent_signal
        }
      }
      workflow workflow-b {
        version 1
        step base {
          name "Base"
          type autonomous
          agent shuttle
          prompt "Base"
          completion agent_signal
        }
      }
    `);
    // project overrides workflow-a to extend workflow-b,
    // and workflow-b to extend workflow-a → cycle
    const project = cfg(`
      workflow workflow-a {
        extends "workflow-b"
        version 1
        step extra {
          name "Extra"
          type autonomous
          agent shuttle
          prompt "Extra"
          completion agent_signal
        }
      }
      workflow workflow-b {
        extends "workflow-a"
        version 1
        step extra2 {
          name "Extra2"
          type autonomous
          agent shuttle
          prompt "Extra2"
          completion agent_signal
        }
      }
    `);

    const result = mergeConfigsResult(base, project);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors[0]?.type).toBe("WorkflowExtensionError");
    if (errors[0]?.type === "WorkflowExtensionError") {
      expect(errors[0].error.type).toBe("ExtendsCycle");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — mergeConfigs (deprecated wrapper) throws on workflow extension error
// ---------------------------------------------------------------------------

describe("mergeConfigs — deprecated wrapper throws on workflow extension error", () => {
  it("throws MergeError when extends target is unknown", () => {
    const base = cfg(`
      workflow quick-fix {
        version 1
        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it"
          completion agent_signal
        }
      }
    `);
    const project = cfg(`
      workflow quick-fix {
        extends "does-not-exist"
        version 1
        step extra {
          name "Extra"
          type autonomous
          agent shuttle
          prompt "Extra"
          completion agent_signal
        }
      }
    `);

    expect(() => mergeConfigs(base, project)).toThrow();
  });
});
