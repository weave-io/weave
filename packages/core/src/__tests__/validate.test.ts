import { describe, expect, it } from "bun:test";
import { tokenize } from "../lexer.js";
import { parse } from "../parser.js";
import { validate } from "../validate.js";

/** Helper: lex + parse + validate a source string */
function validateSource(src: string) {
  const lexResult = tokenize(src);
  if (lexResult.isErr())
    throw new Error(`Lex errors: ${JSON.stringify(lexResult.error)}`);
  const parseResult = parse(lexResult.value);
  if (parseResult.isErr())
    throw new Error(`Parse errors: ${JSON.stringify(parseResult.error)}`);
  return validate(parseResult.value);
}

describe("validate — valid agent", () => {
  it("valid agent with all fields", () => {
    const src = `agent loom {
  description "Loom (Main Orchestrator)"
  prompt "You are loom."
  models ["claude-sonnet-4-5"]
  mode primary
  temperature 0.1
  skills ["tdd"]
  tool_policy {
    read allow
    write allow
    execute allow
    delegate allow
    network ask
  }
  triggers [
    { domain "Orchestration" trigger "Complex tasks" }
  ]
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.agents.loom).toBeDefined();
    expect(config.agents.loom?.description).toBe("Loom (Main Orchestrator)");
    expect(config.agents.loom?.temperature).toBe(0.1);
    expect(config.agents.loom?.mode).toBe("primary");
    expect(config.agents.loom?.models).toEqual(["claude-sonnet-4-5"]);
    expect(config.agents.loom?.skills).toEqual(["tdd"]);
  });

  it("agent with prompt_file (safe path)", () => {
    const src = `agent shuttle {
  prompt_file "shuttle.md"
  models ["claude-sonnet-4-5"]
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agents.shuttle?.prompt_file).toBe(
      "shuttle.md",
    );
  });
});

describe("validate — valid category", () => {
  it("category with patterns and tool_policy", () => {
    const src = `category backend {
  description "Backend APIs"
  patterns ["src/api/**", "src/db/**"]
  temperature 0.2
  tool_policy {
    read allow
    write allow
    delegate deny
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.categories.backend).toBeDefined();
    expect(config.categories.backend?.patterns).toEqual([
      "src/api/**",
      "src/db/**",
    ]);
    expect(config.categories.backend?.temperature).toBe(0.2);
  });
});

describe("validate — mutual exclusivity errors", () => {
  it("both prompt and prompt_file set → err", () => {
    const src = `agent bad {
  prompt "inline"
  prompt_file "bad.md"
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("mutually exclusive"))).toBe(
      true,
    );
  });
});

describe("validate — prompt_file path safety", () => {
  it("prompt_file with '..' → err", () => {
    const src = `agent bad {
  prompt_file "../secrets.md"
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("relative path"))).toBe(true);
  });

  it("prompt_file with absolute path → err", () => {
    const src = `agent bad {
  prompt_file "/etc/passwd"
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("relative path"))).toBe(true);
  });
});

describe("validate — schema constraint errors", () => {
  it("invalid tool_policy value → err", () => {
    const src = `agent bad {
  tool_policy {
    read maybe
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
  });

  it("temperature above 2.0 → err", () => {
    const src = `agent bad {
  temperature 3.0
  prompt "hi"
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.path.includes("temperature"))).toBe(true);
  });

  it("invalid mode → err", () => {
    const src = `agent bad {
  mode background
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
  });

  it("empty patterns array on category → err", () => {
    const src = `category empty {
  patterns []
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.path.includes("patterns"))).toBe(true);
  });
});

describe("validate — multiple agents, partial errors", () => {
  it("one valid and one invalid agent → err with path", () => {
    const src = `agent good {
  temperature 0.5
  prompt "Good agent"
}

agent bad-agent {
  temperature 3.0
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.path.includes("bad-agent"))).toBe(true);
  });
});

describe("validate — empty source", () => {
  it("empty AST → ok with defaults", () => {
    const result = validate([]);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.agents).toEqual({});
    expect(config.categories).toEqual({});
    expect(config.disabled).toEqual({ agents: [], hooks: [], skills: [] });
  });
});

describe("validate — disable directives", () => {
  it("disable agents is reflected in config.disabled", () => {
    const src = 'disable agents ["warp", "spindle"]';
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.disabled.agents).toEqual(["warp", "spindle"]);
  });
});

describe("validate — workflows", () => {
  it("bare completion identifier (user_confirm) round-trips correctly", () => {
    const src = `workflow quick-fix {
  version 1

  step fix {
    name "Implement the fix"
    type autonomous
    agent shuttle
    prompt "Fix the issue."
    completion user_confirm
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    const wf = config.workflows["quick-fix"];
    expect(wf).toBeDefined();
    expect(wf?.version).toBe(1);
    expect(wf?.steps).toHaveLength(1);
    const step = wf?.steps[0];
    expect(step?.name).toBe("fix");
    expect(step?.display_name).toBe("Implement the fix");
    expect(step?.type).toBe("autonomous");
    expect(step?.agent).toBe("shuttle");
    expect(step?.completion).toEqual({ method: "user_confirm" });
  });

  it("named block completion (plan_created) round-trips correctly", () => {
    const src = `workflow feature {
  version 1

  step plan {
    name "Create plan"
    type autonomous
    agent pattern
    prompt "Plan the feature."
    completion plan_created {
      plan_name "my-plan"
    }
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.feature?.steps[0];
    expect(step?.completion).toEqual({
      method: "plan_created",
      plan_name: "my-plan",
    });
  });

  it("on_reject pause on a gate step is accepted", () => {
    const src = `workflow w {
  version 1

  step review {
    name "Security audit"
    type gate
    agent warp
    prompt "Audit the changes."
    completion review_verdict
    on_reject pause
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.on_reject).toBe("pause");
  });

  it("on_reject on a non-gate step is rejected", () => {
    const src = `workflow w {
  version 1

  step work {
    name "Do work"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
    on_reject pause
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("on_reject"))).toBe(true);
  });

  it("missing required agent field produces clear error path", () => {
    const src = `workflow w {
  version 1

  step work {
    name "Do work"
    type autonomous
    prompt "Do it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.path.includes("agent"))).toBe(true);
  });

  it("inputs and outputs arrays validate correctly", () => {
    const src = `workflow w {
  version 1

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Do the work."
    completion plan_complete {
      plan_name "my-plan"
    }
    inputs [
      { name "plan_path" description "Path to the plan" }
    ]
    outputs [
      { name "result_path" description "Path to the result" }
    ]
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.inputs).toEqual([
      { name: "plan_path", description: "Path to the plan" },
    ]);
    expect(step?.outputs).toEqual([
      { name: "result_path", description: "Path to the result" },
    ]);
  });

  it("step block name maps to name; inner name property maps to display_name", () => {
    const src = `workflow w {
  version 1

  step my-step {
    name "My Display Name"
    type autonomous
    agent shuttle
    prompt "Do work."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.name).toBe("my-step");
    expect(step?.display_name).toBe("My Display Name");
  });

  it("workflow with extends field round-trips correctly", () => {
    const src = `workflow my-ext {
  extends "base-workflow"
  version 1

  step extra {
    name "Extra step"
    type autonomous
    agent shuttle
    prompt "Do extra work."
    completion agent_signal
    insert_after "plan"
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["my-ext"];
    expect(wf).toBeDefined();
    expect(wf?.extends).toBe("base-workflow");
    expect(wf?.steps).toHaveLength(1);
    const step = wf?.steps[0];
    expect(step?.name).toBe("extra");
    expect(step?.insert_after).toBe("plan");
    expect(step?.insert_before).toBeUndefined();
  });

  it("extension workflow with empty steps array is accepted when extends is set", () => {
    const src = `workflow override-only {
  extends "base"
  version 1
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["override-only"];
    expect(wf?.extends).toBe("base");
    expect(wf?.steps).toHaveLength(0);
  });

  it("step with insert_before round-trips correctly", () => {
    const src = `workflow w {
  extends "base"
  version 1

  step security-check {
    name "Security audit"
    type gate
    agent warp
    prompt "Audit."
    completion review_verdict
    insert_before "deploy"
    on_reject pause
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.insert_before).toBe("deploy");
    expect(step?.insert_after).toBeUndefined();
    expect(step?.on_reject).toBe("pause");
  });

  it("step with both insert_before and insert_after is rejected (BothInsertBeforeAndAfter)", () => {
    const src = `workflow w {
  extends "base"
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
    insert_before "review"
    insert_after "plan"
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(
      errors.some((e) => e.message.includes("BothInsertBeforeAndAfter")),
    ).toBe(true);
  });
});

describe("validate — prompt_append_file (agent)", () => {
  it("agent with prompt_append_file → ok and field preserved", () => {
    const src = `agent myagent {
  prompt "You are helpful."
  prompt_append_file "extra.md"
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agents.myagent?.prompt_append_file).toBe(
      "extra.md",
    );
  });

  it("agent with both prompt_append and prompt_append_file → err (mutually exclusive)", () => {
    const src = `agent myagent {
  prompt "You are helpful."
  prompt_append "inline extra"
  prompt_append_file "extra.md"
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("mutually exclusive"))).toBe(
      true,
    );
  });

  it("agent with prompt_append_file '../bad.md' → err (relative path)", () => {
    const src = `agent myagent {
  prompt_append_file "../bad.md"
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("relative path"))).toBe(true);
  });

  it("agent with prompt_append_file '/etc/passwd' → err (relative path)", () => {
    const src = `agent myagent {
  prompt_append_file "/etc/passwd"
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("relative path"))).toBe(true);
  });
});

describe("validate — prompt_append_file (category)", () => {
  it("category with prompt_append_file → ok and field preserved", () => {
    const src = `category frontend {
  patterns ["src/components/**"]
  prompt_append_file "cat-extra.md"
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().categories.frontend?.prompt_append_file).toBe(
      "cat-extra.md",
    );
  });

  it("category with both prompt_append and prompt_append_file → err (mutually exclusive)", () => {
    const src = `category frontend {
  patterns ["src/components/**"]
  prompt_append "inline extra"
  prompt_append_file "cat-extra.md"
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("mutually exclusive"))).toBe(
      true,
    );
  });
});

describe("validate — settings block", () => {
  it("settings { log_level INFO } is accepted and reflected in config", () => {
    const src = `settings {
  log_level INFO
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().settings.log_level).toBe("INFO");
  });

  it("settings { log_level DEBUG } is accepted", () => {
    const src = `settings {
  log_level DEBUG
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().settings.log_level).toBe("DEBUG");
  });

  it("settings block with all valid log levels", () => {
    const levels = [
      "TRACE",
      "DEBUG",
      "INFO",
      "WARN",
      "ERROR",
      "FATAL",
    ] as const;
    for (const level of levels) {
      const result = validateSource(`settings {\n  log_level ${level}\n}`);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().settings.log_level).toBe(level);
    }
  });

  it("settings { runtime { journal { strict true } } } is accepted", () => {
    const src = `settings {
  runtime {
    journal {
      strict true
    }
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().settings.runtime.journal.strict).toBe(true);
  });

  it("default runtime.journal.strict is false when not specified", () => {
    const src = `settings {
  log_level INFO
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().settings.runtime.journal.strict).toBe(false);
  });

  it("default settings when no settings block is present", () => {
    const result = validate([]);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.settings.log_level).toBe("INFO");
    expect(config.settings.runtime.journal.strict).toBe(false);
  });

  it("invalid log_level inside settings block → err", () => {
    const src = `settings {
  log_level verbose
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
  });

  it("top-level log_level → err (must be inside settings block)", () => {
    const result = validateSource("log_level INFO");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(
      errors.some(
        (e) => e.path === "log_level" && e.message.includes("settings"),
      ),
    ).toBe(true);
  });

  it('settings "foo" (non-block) → err with path "settings"', () => {
    const result = validateSource('settings "foo"');
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("settings");
    expect(errors[0]?.message).toBe(
      "settings must be a block: settings { ... }",
    );
  });
});

// ---------------------------------------------------------------------------
// validate — routing block
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// validate — planning step role
// ---------------------------------------------------------------------------

describe("validate — planning step role", () => {
  it("step with role planning round-trips correctly", () => {
    const src = `workflow plan-and-build {
  version 1

  step plan {
    name "Create plan"
    role planning
    type autonomous
    agent pattern
    prompt "Plan the work."
    completion plan_created {
      plan_name "my-plan"
    }
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows["plan-and-build"]?.steps[0];
    expect(step?.role).toBe("planning");
  });

  it("step without role has undefined role", () => {
    const src = `workflow w {
  version 1

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.role).toBeUndefined();
  });

  it("invalid role value is rejected", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad"
    role execution
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
  });

  it("two planning steps in one workflow is rejected (DuplicatePlanningStep)", () => {
    const src = `workflow w {
  version 1

  step plan1 {
    name "Plan 1"
    role planning
    type autonomous
    agent pattern
    prompt "Plan."
    completion plan_created {
      plan_name "p1"
    }
  }

  step plan2 {
    name "Plan 2"
    role planning
    type autonomous
    agent pattern
    prompt "Plan again."
    completion plan_created {
      plan_name "p2"
    }
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(
      errors.some((e) => e.message.includes("DuplicatePlanningStep")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validate — extension_points block
// ---------------------------------------------------------------------------

describe("validate — extension_points block", () => {
  it("workflow with extension_points { before-plan } and planning step is accepted", () => {
    const src = `workflow plan-and-build {
  version 1

  extension_points {
    before-plan
  }

  step plan {
    name "Create plan"
    role planning
    type autonomous
    agent pattern
    prompt "Plan the work."
    completion plan_created {
      plan_name "my-plan"
    }
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["plan-and-build"];
    expect(wf?.extension_points?.before_plan).toBe(true);
    expect(wf?.steps[0]?.role).toBe("planning");
  });

  it("workflow with extension_points { before-plan } but no planning step is rejected (MissingPlanningStep)", () => {
    const src = `workflow plan-and-build {
  version 1

  extension_points {
    before-plan
  }

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Do the work."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("MissingPlanningStep"))).toBe(
      true,
    );
  });

  it("workflow without extension_points has undefined extension_points", () => {
    const src = `workflow w {
  version 1

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(
      result._unsafeUnwrap().workflows.w?.extension_points,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validate — extend before-plan directive
// ---------------------------------------------------------------------------

describe("validate — extend before-plan directive", () => {
  it("extend before-plan directive round-trips into extend_before_plan.steps", () => {
    const src = `extend before-plan ["spec-review", "requirements"]`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.extend_before_plan.steps).toEqual([
      "spec-review",
      "requirements",
    ]);
  });

  it("multiple extend before-plan directives union-merge step lists", () => {
    const src = `extend before-plan ["spec-review"]
extend before-plan ["requirements"]`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.extend_before_plan.steps).toEqual([
      "spec-review",
      "requirements",
    ]);
  });

  it("empty source has extend_before_plan with empty steps", () => {
    const result = validateSource("");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().extend_before_plan).toEqual({ steps: [] });
  });
});

// ---------------------------------------------------------------------------
// validate — before-plan non-reconciling in v1
// ---------------------------------------------------------------------------

describe("validate — before-plan non-reconciling in v1", () => {
  // Spec 22 Unit 2: "before-plan steps do not participate in reconciliation
  // semantics" in v1. As of Task 4.1, `reconciliation_handlers` is a valid
  // schema field. The v1 non-reconciling constraint for before-plan steps is
  // enforced at the engine/runtime layer, not the schema/validate layer.
  // Steps inserted into the before-plan slot via extend before-plan are
  // ordinary WorkflowStep objects; the engine prevents them from acting as
  // reconciliation handlers.

  it("extend before-plan step names carry no reconciliation metadata in validated output", () => {
    const src = `extend before-plan ["spec-review"]`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    // extend_before_plan is a flat object with a steps array — no per-workflow keying.
    // The engine resolves these names to steps at runtime.
    const ebp = config.extend_before_plan;
    expect(ebp.steps).toEqual(["spec-review"]);
    // No reconciliation fields on the ExtendBeforePlan object itself
    expect("reconciliation_handlers" in ebp).toBe(false);
    expect("on_reconcile" in ebp).toBe(false);
  });

  it("workflow with planning step and before-plan slot: planning step has no reconciliation_handlers by default", () => {
    const src = `workflow plan-and-build {
  version 1

  extension_points {
    before-plan
  }

  step plan {
    name "Create plan"
    role planning
    type autonomous
    agent pattern
    prompt "Plan the work."
    completion plan_created {
      plan_name "my-plan"
    }
  }

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Do the work."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["plan-and-build"];
    const planStep = wf?.steps.find((s) => s.role === "planning");
    expect(planStep).toBeDefined();
    // reconciliation_handlers is optional — absent by default
    expect(planStep?.reconciliation_handlers).toBeUndefined();
    // on_reconcile is not a schema field (unknown keys stripped)
    expect("on_reconcile" in (planStep ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validate — reconciliation_handlers on workflow steps
// ---------------------------------------------------------------------------

describe("validate — reconciliation_handlers on workflow steps", () => {
  it("step with reconciliation_handlers declaring execution-mismatch round-trips correctly", () => {
    const src = `workflow w {
  version 1

  step plan {
    name "Create plan"
    type autonomous
    agent pattern
    prompt "Plan the work."
    completion agent_signal
    reconciliation_handlers [
      { reason "execution-mismatch" }
    ]
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.reconciliation_handlers).toHaveLength(1);
    expect(step?.reconciliation_handlers?.[0]?.reason).toBe(
      "execution-mismatch",
    );
  });

  it("step with all four reconciliation reasons round-trips correctly", () => {
    const src = `workflow w {
  version 1

  step handler {
    name "Handler step"
    type autonomous
    agent shuttle
    prompt "Handle reconciliation."
    completion agent_signal
    reconciliation_handlers [
      { reason "execution-mismatch" }
      { reason "user-revision-request" }
      { reason "review-rejection" }
      { reason "security-rejection" }
    ]
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.reconciliation_handlers).toHaveLength(4);
    const reasons = step?.reconciliation_handlers?.map((h) => h.reason) ?? [];
    expect(reasons).toContain("execution-mismatch");
    expect(reasons).toContain("user-revision-request");
    expect(reasons).toContain("review-rejection");
    expect(reasons).toContain("security-rejection");
  });

  it("step without reconciliation_handlers has undefined reconciliation_handlers", () => {
    const src = `workflow w {
  version 1

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.reconciliation_handlers).toBeUndefined();
  });

  it("step with unknown reconciliation reason is rejected", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
    reconciliation_handlers [
      { reason "unknown-reason" }
    ]
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
  });

  it("step with duplicate reconciliation reason is rejected (DuplicateReconciliationReason)", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
    reconciliation_handlers [
      { reason "execution-mismatch" }
      { reason "execution-mismatch" }
    ]
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(
      errors.some((e) => e.message.includes("DuplicateReconciliationReason")),
    ).toBe(true);
  });

  it("step with empty reconciliation_handlers array is rejected", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
    reconciliation_handlers []
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("at least one handler"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// validate — workflow-level prompt_append and prompt_append_file (Spec 22 Unit 4)
// ---------------------------------------------------------------------------

describe("validate — workflow-level prompt_append and prompt_append_file", () => {
  it("workflow with prompt_append round-trips correctly", () => {
    const src = `workflow w {
  version 1
  prompt_append "Always write tests."

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows.w;
    expect(wf?.prompt_append).toBe("Always write tests.");
    expect(wf?.prompt_append_file).toBeUndefined();
  });

  it("workflow with prompt_append_file round-trips correctly", () => {
    const src = `workflow w {
  version 1
  prompt_append_file "workflow-guidance.md"

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows.w;
    expect(wf?.prompt_append_file).toBe("workflow-guidance.md");
    expect(wf?.prompt_append).toBeUndefined();
  });

  it("workflow without prompt_append or prompt_append_file has both undefined", () => {
    const src = `workflow w {
  version 1

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows.w;
    expect(wf?.prompt_append).toBeUndefined();
    expect(wf?.prompt_append_file).toBeUndefined();
  });

  it("workflow with both prompt_append and prompt_append_file → err (mutually exclusive)", () => {
    const src = `workflow w {
  version 1
  prompt_append "Inline guidance."
  prompt_append_file "workflow-guidance.md"

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("mutually exclusive"))).toBe(
      true,
    );
  });

  it("workflow with prompt_append_file '../bad.md' → err (relative path)", () => {
    const src = `workflow w {
  version 1
  prompt_append_file "../bad.md"

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("relative path"))).toBe(true);
  });

  it("workflow with prompt_append_file '/etc/passwd' → err (relative path)", () => {
    const src = `workflow w {
  version 1
  prompt_append_file "/etc/passwd"

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("relative path"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validate — step-level prompt_append and prompt_append_file (Spec 22 Unit 4)
// ---------------------------------------------------------------------------

describe("validate — step-level prompt_append and prompt_append_file", () => {
  it("step with prompt_append round-trips correctly", () => {
    const src = `workflow w {
  version 1

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Do the work."
    prompt_append "Focus on test coverage."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.prompt_append).toBe("Focus on test coverage.");
    expect(step?.prompt_append_file).toBeUndefined();
  });

  it("step with prompt_append_file round-trips correctly", () => {
    const src = `workflow w {
  version 1

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Do the work."
    prompt_append_file "step-guidance.md"
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.prompt_append_file).toBe("step-guidance.md");
    expect(step?.prompt_append).toBeUndefined();
  });

  it("step without prompt_append or prompt_append_file has both undefined", () => {
    const src = `workflow w {
  version 1

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.prompt_append).toBeUndefined();
    expect(step?.prompt_append_file).toBeUndefined();
  });

  it("step with both prompt_append and prompt_append_file → err (mutually exclusive)", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    prompt_append "Inline guidance."
    prompt_append_file "step-guidance.md"
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("mutually exclusive"))).toBe(
      true,
    );
  });

  it("step with prompt_append_file '../bad.md' → err (relative path)", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    prompt_append_file "../bad.md"
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("relative path"))).toBe(true);
  });

  it("step with prompt_append_file '/etc/passwd' → err (relative path)", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    prompt_append_file "/etc/passwd"
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.message.includes("relative path"))).toBe(true);
  });

  it("workflow-level and step-level prompt_append coexist independently", () => {
    const src = `workflow w {
  version 1
  prompt_append "Workflow-wide guidance."

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Do the work."
    prompt_append "Step-local guidance."
    completion agent_signal
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows.w;
    expect(wf?.prompt_append).toBe("Workflow-wide guidance.");
    const step = wf?.steps[0];
    expect(step?.prompt_append).toBe("Step-local guidance.");
  });
});

// ---------------------------------------------------------------------------
// validate — routing block
// ---------------------------------------------------------------------------

describe("validate — routing block", () => {
  it("agent with routing.delegation_exclude round-trips correctly", () => {
    const src = `agent router {
  prompt "You are a router."
  tool_policy {
    delegate allow
  }
  routing {
    delegation_exclude ["warp", "spindle"]
  }
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.agents.router?.routing?.delegation_exclude).toEqual([
      "warp",
      "spindle",
    ]);
  });

  it("agent without routing block has undefined routing", () => {
    const src = `agent loom {
  prompt "You are loom."
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agents.loom?.routing).toBeUndefined();
  });

  it("routing block with unknown key is rejected (strict)", () => {
    const src = `agent bad {
  prompt "You are bad."
  routing {
    delegation_exclude ["warp"]
    unknown_key "value"
  }
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    // Zod strict() reports unknown keys in the message (not path)
    expect(
      errors.some(
        (e) =>
          e.path.includes("routing") ||
          e.message.includes("unknown_key") ||
          e.message.includes("Unrecognized"),
      ),
    ).toBe(true);
  });
});

describe("validate — review_models field", () => {
  it("agent with review_models round-trips correctly", () => {
    const src = `agent weft {
  prompt "You are a reviewer."
  models ["claude-sonnet-4-5"]
  review_models ["claude-opus-4-5", "gpt-4o"]
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.agents.weft?.review_models).toEqual([
      "claude-opus-4-5",
      "gpt-4o",
    ]);
  });

  it("agent without review_models has undefined review_models", () => {
    const src = `agent shuttle {
  prompt "You are shuttle."
  models ["claude-sonnet-4-5"]
}`;
    const result = validateSource(src);
    expect(result.isOk()).toBe(true);
    expect(
      result._unsafeUnwrap().agents.shuttle?.review_models,
    ).toBeUndefined();
  });

  it("review_models with empty array is rejected (min 1)", () => {
    const src = `agent weft {
  prompt "You are a reviewer."
  review_models []
}`;
    const result = validateSource(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.path.includes("review_models"))).toBe(true);
  });
});
