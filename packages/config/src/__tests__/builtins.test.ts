import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weave/core";
import { BUILTIN_WEAVE_SOURCE, getBuiltinConfig } from "../builtins.js";

describe("getBuiltinConfig", () => {
  it("(a) returns ok — not err", () => {
    const result = getBuiltinConfig();
    expect(result.isOk()).toBe(true);
  });

  it("(b) result contains exactly 8 agents", () => {
    const result = getBuiltinConfig();
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    const names = Object.keys(config.agents).sort();
    expect(names).toEqual(
      [
        "loom",
        "tapestry",
        "shuttle",
        "pattern",
        "thread",
        "spindle",
        "weft",
        "warp",
      ].sort(),
    );
    expect(names).toHaveLength(8);
  });

  it("(c) loom has temperature 0.1 and prompt_file loom.md", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const loom = config.agents.loom;
    expect(loom).toBeDefined();
    expect(loom?.temperature).toBe(0.1);
    expect(loom?.prompt_file).toBe("loom.md");
  });

  it("(d) shuttle has temperature 0.2 and prompt_file shuttle.md", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const shuttle = config.agents.shuttle;
    expect(shuttle).toBeDefined();
    expect(shuttle?.temperature).toBe(0.2);
    expect(shuttle?.prompt_file).toBe("shuttle.md");
  });

  it("(d2) shuttle has mode subagent (not all — shuttle is a subagent-only specialist)", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const shuttle = config.agents.shuttle;
    expect(shuttle).toBeDefined();
    expect(shuttle?.mode).toBe("subagent");
  });

  it("(e) thread has temperature 0.0", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const thread = config.agents.thread;
    expect(thread).toBeDefined();
    expect(thread?.temperature).toBe(0);
  });

  it("(f) pattern has temperature 0.3", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const pattern = config.agents.pattern;
    expect(pattern).toBeDefined();
    expect(pattern?.temperature).toBe(0.3);
  });

  it("(g) builtin config has no categories or disabled entries", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    expect(Object.keys(config.categories)).toHaveLength(0);
    expect(config.disabled.agents).toHaveLength(0);
    expect(config.disabled.hooks).toHaveLength(0);
    expect(config.disabled.skills).toHaveLength(0);
  });

  it("(g2) builtin config has 3 standard workflows", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    expect(Object.keys(config.workflows)).toHaveLength(3);
    expect(config.workflows["plan-and-execute"]).toBeDefined();
    expect(config.workflows["quick-fix"]).toBeDefined();
    expect(config.workflows["tapestry-execution"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Planning workflow defaults
  // ---------------------------------------------------------------------------

  it("(g3) plan-and-execute publishes extension_points.before_plan: true", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const wf = config.workflows["plan-and-execute"];
    expect(wf).toBeDefined();
    expect(wf?.extension_points?.before_plan).toBe(true);
  });

  it("(g4) plan-and-execute has exactly one planning step with role: planning on the 'plan' step", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const wf = config.workflows["plan-and-execute"];
    expect(wf).toBeDefined();
    const planningSteps = wf?.steps.filter((s) => s.role === "planning") ?? [];
    expect(planningSteps).toHaveLength(1);
    expect(planningSteps[0]?.name).toBe("plan");
  });

  it("(g5) quick-fix does NOT publish extension_points.before_plan", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const wf = config.workflows["quick-fix"];
    expect(wf).toBeDefined();
    expect(wf?.extension_points?.before_plan).toBeUndefined();
  });

  it("(g6) tapestry-execution does NOT publish extension_points.before_plan", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const wf = config.workflows["tapestry-execution"];
    expect(wf).toBeDefined();
    expect(wf?.extension_points?.before_plan).toBeUndefined();
  });

  it("(g7) plan-and-execute planning step uses plan_created completion with plan_name template", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const wf = config.workflows["plan-and-execute"];
    const planStep = wf?.steps.find((s) => s.role === "planning");
    expect(planStep).toBeDefined();
    expect(planStep?.completion.method).toBe("plan_created");
    if (planStep?.completion.method === "plan_created") {
      expect(planStep.completion.plan_name).toBeTruthy();
    }
  });

  // ---------------------------------------------------------------------------
  // tapestry-execution: existing-plan execution contract
  // ---------------------------------------------------------------------------

  it("(g8) tapestry-execution has no planning step (role: planning)", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const wf = config.workflows["tapestry-execution"];
    expect(wf).toBeDefined();
    const planningSteps = wf?.steps.filter((s) => s.role === "planning") ?? [];
    expect(planningSteps).toHaveLength(0);
  });

  it("(g9) tapestry-execution first step uses plan_complete completion (not plan_created or agent_signal)", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const wf = config.workflows["tapestry-execution"];
    expect(wf).toBeDefined();
    const firstStep = wf?.steps[0];
    expect(firstStep).toBeDefined();
    expect(firstStep?.completion.method).toBe("plan_complete");
    if (firstStep?.completion.method === "plan_complete") {
      expect(firstStep.completion.plan_name).toBeTruthy();
    }
  });

  it("(g10) tapestry-execution first step prompt references {{instance.slug}} (existing plan)", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const wf = config.workflows["tapestry-execution"];
    expect(wf).toBeDefined();
    const firstStep = wf?.steps[0];
    expect(firstStep).toBeDefined();
    expect(firstStep?.prompt).toContain("{{instance.slug}}");
  });

  it("(g11) builtin config has no default_workflow selector — settings has no default_workflow field", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    // settings should not have a default_workflow field
    expect(
      (config.settings as Record<string, unknown>)["default_workflow"],
    ).toBeUndefined();
  });

  it("(g12) plan-and-execute remains available as an explicit named workflow", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    expect(config.workflows["plan-and-execute"]).toBeDefined();
    // It should have a planning step (plan_created semantics)
    const wf = config.workflows["plan-and-execute"];
    const planStep = wf?.steps.find((s) => s.role === "planning");
    expect(planStep).toBeDefined();
    expect(planStep?.completion.method).toBe("plan_created");
  });

  it("(h) BUILTIN_WEAVE_SOURCE is valid DSL — parseConfig returns no errors", () => {
    const result = parseConfig(BUILTIN_WEAVE_SOURCE);
    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Trigger assertions
  // ---------------------------------------------------------------------------

  const SPECIALIST_AGENTS = [
    "shuttle",
    "pattern",
    "thread",
    "spindle",
    "weft",
    "warp",
  ] as const;

  const ORCHESTRATOR_AGENTS = ["loom", "tapestry"] as const;

  it("(i) specialist agents (shuttle, pattern, thread, spindle, weft, warp) each have at least one trigger", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    for (const name of SPECIALIST_AGENTS) {
      const agent = config.agents[name];
      expect(agent).toBeDefined();
      expect(agent?.triggers).toBeDefined();
      expect(agent?.triggers?.length).toBeGreaterThan(0);
    }
  });

  it("(j) orchestrator agents (loom, tapestry) do NOT have triggers", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    for (const name of ORCHESTRATOR_AGENTS) {
      const agent = config.agents[name];
      expect(agent).toBeDefined();
      // triggers should be undefined or empty for orchestrators
      const hasTriggers =
        agent?.triggers !== undefined && agent.triggers.length > 0;
      expect(hasTriggers).toBe(false);
    }
  });

  it("(k) each specialist trigger has non-empty domain and trigger strings", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    for (const name of SPECIALIST_AGENTS) {
      const agent = config.agents[name];
      expect(agent).toBeDefined();
      const triggers = agent?.triggers ?? [];
      expect(triggers.length).toBeGreaterThan(0);
      for (const t of triggers) {
        expect(t.domain.trim().length).toBeGreaterThan(0);
        expect(t.trigger.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
