import { describe, expect, it } from "bun:test";
import { parseConfig } from "../parse-config.js";

describe("parseConfig — valid sources", () => {
  it("minimal valid source: single agent with inline prompt", () => {
    const src = `agent helper {
  prompt "You are a helpful assistant."
  models ["claude-sonnet-4-5"]
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.agents.helper).toBeDefined();
    expect(config.agents.helper?.prompt).toBe("You are a helpful assistant.");
  });

  it("full valid source: agents, categories, disable, settings block", () => {
    const src = `agent loom {
  description "Loom (Main Orchestrator)"
  prompt "You are loom."
  models ["claude-sonnet-4-5"]
  mode primary
  temperature 0.1
  tool_policy {
    read allow
    write allow
    delegate allow
    network ask
  }
  triggers [
    { domain "Orchestration" trigger "Complex multi-step tasks" }
  ]
  skills ["tdd", "code-review"]
}

agent shuttle {
  description "Shuttle (Domain Specialist)"
  prompt_file "shuttle.md"
  models ["claude-sonnet-4-5"]
  mode all
  temperature 0.2
  tool_policy {
    read allow
    write allow
    execute allow
    delegate deny
  }
}

category backend {
  description "Backend APIs, services, persistence"
  models ["claude-sonnet-4-5"]
  patterns ["src/api/**", "src/server/**", "src/db/**"]
  temperature 0.2
  tool_policy {
    read allow
    write allow
    delegate deny
  }
}

category frontend {
  description "Frontend UI, styling"
  patterns ["src/components/**", "src/pages/**"]
}

disable agents ["warp", "spindle"]
disable hooks ["on-session-idle"]
disable skills ["tdd"]

settings {
  log_level INFO
}`;

    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();

    // Agents
    expect(config.agents.loom).toBeDefined();
    expect(config.agents.shuttle).toBeDefined();
    expect(config.agents.loom?.mode).toBe("primary");
    expect(config.agents.shuttle?.mode).toBe("all");

    // Categories
    expect(config.categories.backend).toBeDefined();
    expect(config.categories.frontend).toBeDefined();
    expect(config.categories.backend?.patterns).toContain("src/api/**");

    // Disabled
    expect(config.disabled.agents).toEqual(["warp", "spindle"]);
    expect(config.disabled.hooks).toEqual(["on-session-idle"]);
    expect(config.disabled.skills).toEqual(["tdd"]);

    // Settings
    expect(config.settings.log_level).toBe("INFO");
    expect(config.settings.runtime.journal.strict).toBe(false);
  });

  it("AGENTS.md example: loom agent with tool_policy and triggers", () => {
    const src = `agent loom {
  description "Loom (Main Orchestrator)"
  prompt_file "loom.md"
  models ["claude-sonnet-4-5", "gpt-4o"]
  mode primary
  temperature 0.1

  tool_policy {
    read allow
    write allow
    execute allow
    delegate allow
    network ask
  }

  triggers [
    { domain "Orchestration" trigger "Complex multi-step tasks" }
    { domain "Architecture" trigger "System design and planning" }
  ]

  skills ["tdd", "code-review"]
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const loom = result._unsafeUnwrap().agents.loom;
    expect(loom?.models).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
    expect(loom?.triggers).toHaveLength(2);
    expect(loom?.triggers?.[0]).toEqual({
      domain: "Orchestration",
      trigger: "Complex multi-step tasks",
    });
    expect(loom?.skills).toEqual(["tdd", "code-review"]);
  });

  it("empty source → ok with defaults", () => {
    const result = parseConfig("");
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.agents).toEqual({});
    expect(config.categories).toEqual({});
    expect(config.disabled).toEqual({ agents: [], hooks: [], skills: [] });
  });
});

describe("parseConfig — lex errors", () => {
  it("unterminated string → err with UnterminatedString", () => {
    const result = parseConfig('agent loom { prompt "unterminated }');
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "UnterminatedString")).toBe(true);
  });

  it("unexpected character → err with UnexpectedCharacter", () => {
    const result = parseConfig("agent @loom { }");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "UnexpectedCharacter")).toBe(true);
  });
});

describe("parseConfig — parse errors", () => {
  it("unclosed block → err with UnclosedBlock", () => {
    const result = parseConfig("agent loom {");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "UnclosedBlock")).toBe(true);
  });

  it("missing block name → err with MissingBlockName", () => {
    const result = parseConfig("agent { }");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "MissingBlockName")).toBe(true);
  });
});

describe("parseConfig — validation errors", () => {
  it("both prompt and prompt_file → err with ValidationError", () => {
    const src = `agent bad {
  prompt "inline"
  prompt_file "bad.md"
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });

  it("temperature out of range → err with ValidationError including source info", () => {
    const src = `agent bad {
  temperature 9.9
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });
});

describe("parseConfig — workflows", () => {
  it("secure-feature workflow (4 steps) parses end-to-end with correct typed shape", () => {
    const src = `workflow secure-feature {
  description "Plan, implement, build, and review a feature with security audit"
  version 1

  step plan {
    name "Create implementation plan"
    type autonomous
    agent pattern
    prompt "Create a detailed implementation plan for: {{instance.goal}}"

    completion plan_created {
      plan_name "{{instance.slug}}"
    }

    outputs [
      { name "plan_path" description "Path to the generated plan file" }
    ]
  }

  step review-plan {
    name "Review the plan"
    type interactive
    agent shuttle
    prompt "Review the plan at {{artifacts.plan_path}} for: {{instance.goal}}"
    completion user_confirm
  }

  step implement {
    name "Execute the plan"
    type autonomous
    agent shuttle
    prompt "Execute the plan at {{artifacts.plan_path}} for: {{instance.goal}}"

    completion plan_complete {
      plan_name "{{instance.slug}}"
    }

    inputs [
      { name "plan_path" description "Path to the plan to execute" }
    ]
  }

  step security-review {
    name "Security audit"
    type gate
    agent warp
    prompt "Perform a security audit of all changes for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}`;

    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    const wf = config.workflows["secure-feature"];
    expect(wf).toBeDefined();
    expect(wf?.version).toBe(1);
    expect(wf?.description).toBe(
      "Plan, implement, build, and review a feature with security audit",
    );
    expect(wf?.steps).toHaveLength(4);

    // Step 1: plan
    const stepPlan = wf?.steps[0];
    expect(stepPlan?.name).toBe("plan");
    expect(stepPlan?.display_name).toBe("Create implementation plan");
    expect(stepPlan?.type).toBe("autonomous");
    expect(stepPlan?.agent).toBe("pattern");
    expect(stepPlan?.completion).toEqual({
      method: "plan_created",
      plan_name: "{{instance.slug}}",
    });
    expect(stepPlan?.outputs).toEqual([
      { name: "plan_path", description: "Path to the generated plan file" },
    ]);

    // Step 2: review-plan
    const stepReview = wf?.steps[1];
    expect(stepReview?.name).toBe("review-plan");
    expect(stepReview?.display_name).toBe("Review the plan");
    expect(stepReview?.type).toBe("interactive");
    expect(stepReview?.agent).toBe("shuttle");
    expect(stepReview?.completion).toEqual({ method: "user_confirm" });

    // Step 3: implement
    const stepImpl = wf?.steps[2];
    expect(stepImpl?.name).toBe("implement");
    expect(stepImpl?.display_name).toBe("Execute the plan");
    expect(stepImpl?.completion).toEqual({
      method: "plan_complete",
      plan_name: "{{instance.slug}}",
    });
    expect(stepImpl?.inputs).toEqual([
      { name: "plan_path", description: "Path to the plan to execute" },
    ]);

    // Step 4: security-review
    const stepSec = wf?.steps[3];
    expect(stepSec?.name).toBe("security-review");
    expect(stepSec?.display_name).toBe("Security audit");
    expect(stepSec?.type).toBe("gate");
    expect(stepSec?.agent).toBe("warp");
    expect(stepSec?.completion).toEqual({ method: "review_verdict" });
    expect(stepSec?.on_reject).toBe("pause");
  });

  it("quick-fix workflow (2 steps) parses end-to-end correctly", () => {
    const src = `workflow quick-fix {
  description "Fix a bug and get it reviewed"
  version 1

  step fix {
    name "Implement the fix"
    type autonomous
    agent shuttle
    prompt "Fix the following issue: {{instance.goal}}"
    completion agent_signal
  }

  step review {
    name "Code review"
    type gate
    agent weft
    prompt "Review the fix for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}`;

    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["quick-fix"];
    expect(wf).toBeDefined();
    expect(wf?.steps).toHaveLength(2);

    const stepFix = wf?.steps[0];
    expect(stepFix?.name).toBe("fix");
    expect(stepFix?.completion).toEqual({ method: "agent_signal" });

    const stepReview = wf?.steps[1];
    expect(stepReview?.name).toBe("review");
    expect(stepReview?.type).toBe("gate");
    expect(stepReview?.completion).toEqual({ method: "review_verdict" });
    expect(stepReview?.on_reject).toBe("pause");
  });

  it("invalid step type returns err with ValidationError", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type background
    agent shuttle
    prompt "Do it."
    completion agent_signal
  }
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });

  it("workflow with extends and step-level insert_before parses end-to-end", () => {
    const src = `workflow extended-feature {
  extends "secure-feature"
  description "Extended feature workflow with extra security step"
  version 2

  step pre-audit {
    name "Pre-deployment audit"
    type gate
    agent warp
    prompt "Perform a pre-deployment audit for: {{instance.goal}}"
    completion review_verdict
    insert_before "security-review"
    on_reject pause
  }
}`;

    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    const wf = config.workflows["extended-feature"];
    expect(wf).toBeDefined();
    expect(wf?.extends).toBe("secure-feature");
    expect(wf?.version).toBe(2);
    expect(wf?.steps).toHaveLength(1);

    const step = wf?.steps[0];
    expect(step?.name).toBe("pre-audit");
    expect(step?.display_name).toBe("Pre-deployment audit");
    expect(step?.type).toBe("gate");
    expect(step?.agent).toBe("warp");
    expect(step?.insert_before).toBe("security-review");
    expect(step?.insert_after).toBeUndefined();
    expect(step?.on_reject).toBe("pause");
  });

  it("extension workflow with empty steps (override-only) parses end-to-end", () => {
    const src = `workflow override-only {
  extends "base-workflow"
  version 1
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["override-only"];
    expect(wf?.extends).toBe("base-workflow");
    expect(wf?.steps).toHaveLength(0);
  });

  it("step with insert_after parses end-to-end", () => {
    const src = `workflow w {
  extends "base"
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
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.insert_after).toBe("plan");
    expect(step?.insert_before).toBeUndefined();
  });

  it("step with both insert_before and insert_after returns ValidationError", () => {
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
    expect(
      errors.some(
        (e) =>
          e.type === "ValidationError" &&
          "message" in e &&
          e.message.includes("BothInsertBeforeAndAfter"),
      ),
    ).toBe(true);
  });

  it("step with insert_before: '' (empty string) returns ValidationError", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
    insert_before ""
  }
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });

  it("step with insert_after: '' (empty string) returns ValidationError", () => {
    const src = `workflow w {
  extends "base"
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
    insert_after ""
  }
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });

  it("workflow with extends: '' (empty string) returns ValidationError", () => {
    const src = `workflow w {
  extends ""
  version 1

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
  }
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });

  it("malformed completion block (no method identifier) returns err with ValidationError", () => {
    // `completion { plan_name \"x\" }` — plain block with no leading identifier means __name
    // is absent, so CompletionMethodSchema discriminated union cannot match.
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion {
      plan_name "x"
    }
  }
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });

  it("workflow mixed with agents and categories parses correctly", () => {
    const src = `agent loom {
  prompt "You are loom."
  models ["claude-sonnet-4-5"]
}

category backend {
  patterns ["src/api/**"]
}

workflow quick-fix {
  description "Quick bug fix"
  version 1

  step fix {
    name "Fix the bug"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;

    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.agents.loom).toBeDefined();
    expect(config.categories.backend).toBeDefined();
    expect(config.workflows["quick-fix"]).toBeDefined();
    expect(config.workflows["quick-fix"]?.steps).toHaveLength(1);
  });
});

describe("parseConfig — settings block", () => {
  it("settings { log_level INFO } parses and reflects in config.settings", () => {
    const src = `settings {
  log_level INFO
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.settings.log_level).toBe("INFO");
    expect(config.settings.runtime.journal.strict).toBe(false);
  });

  it("settings { log_level WARN runtime { journal { strict true } } } parses correctly", () => {
    const src = `settings {
  log_level WARN
  runtime {
    journal {
      strict true
    }
  }
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.settings.log_level).toBe("WARN");
    expect(config.settings.runtime.journal.strict).toBe(true);
  });

  it("empty source has default settings (log_level INFO, strict false)", () => {
    const result = parseConfig("");
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.settings.log_level).toBe("INFO");
    expect(config.settings.runtime.journal.strict).toBe(false);
  });

  it("top-level log_level → err with ValidationError", () => {
    const result = parseConfig("log_level INFO");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
    expect(
      errors.some(
        (e) =>
          e.type === "ValidationError" && "path" in e && e.path === "log_level",
      ),
    ).toBe(true);
  });

  it("invalid log_level inside settings block → err with ValidationError", () => {
    const src = `settings {
  log_level verbose
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });
});

describe("parseConfig — prompt_append_file", () => {
  it("agent with prompt_append_file parses successfully and field is present in output", () => {
    const src = `agent myagent {
  prompt "You are helpful."
  models ["claude-sonnet-4-5"]
  prompt_append_file "extra.md"
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.agents.myagent).toBeDefined();
    expect(config.agents.myagent?.prompt_append_file).toBe("extra.md");
  });

  it("category with prompt_append_file parses successfully and field is present in output", () => {
    const src = `category frontend {
  description "Frontend UI"
  patterns ["src/components/**"]
  prompt_append_file "cat-extra.md"
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.categories.frontend).toBeDefined();
    expect(config.categories.frontend?.prompt_append_file).toBe("cat-extra.md");
  });

  it("agent with both prompt_append and prompt_append_file → err (mutually exclusive)", () => {
    const src = `agent bad {
  prompt "You are helpful."
  models ["claude-sonnet-4-5"]
  prompt_append "inline extra"
  prompt_append_file "extra.md"
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });
});

describe("parseConfig — source positions in errors", () => {
  it("errors include line numbers where possible", () => {
    // Lex error on line 2
    const result = parseConfig('agent loom {\n"unterminated');
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    const lexErr = errors[0];
    expect(lexErr).toBeDefined();
    if (lexErr?.type === "UnterminatedString") {
      expect(lexErr.line).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// parseConfig — routing block end-to-end
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parseConfig — planning step role
// ---------------------------------------------------------------------------

describe("parseConfig — planning step role", () => {
  it("step with role planning parses end-to-end correctly", () => {
    const src = `workflow plan-and-build {
  description "Plan-oriented workflow"
  version 1

  step plan {
    name "Create implementation plan"
    role planning
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion plan_created {
      plan_name "{{instance.slug}}"
    }
    outputs [
      { name "plan_path" description "Path to the plan" }
    ]
  }

  step implement {
    name "Execute the plan"
    type autonomous
    agent shuttle
    prompt "Execute the plan at {{artifacts.plan_path}}"
    completion plan_complete {
      plan_name "{{instance.slug}}"
    }
    inputs [
      { name "plan_path" description "Path to the plan to execute" }
    ]
  }
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["plan-and-build"];
    expect(wf).toBeDefined();
    expect(wf?.steps).toHaveLength(2);

    const planStep = wf?.steps[0];
    expect(planStep?.name).toBe("plan");
    expect(planStep?.role).toBe("planning");
    expect(planStep?.type).toBe("autonomous");
    expect(planStep?.agent).toBe("pattern");

    const implStep = wf?.steps[1];
    expect(implStep?.name).toBe("implement");
    expect(implStep?.role).toBeUndefined();
  });

  it("two planning steps in one workflow returns ValidationError (DuplicatePlanningStep)", () => {
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
    expect(
      errors.some(
        (e) =>
          e.type === "ValidationError" &&
          "message" in e &&
          e.message.includes("DuplicatePlanningStep"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — extension_points block
// ---------------------------------------------------------------------------

describe("parseConfig — extension_points block", () => {
  it("workflow with extension_points { before-plan } and planning step parses end-to-end", () => {
    const src = `workflow plan-and-build {
  description "Plan-oriented workflow with before-plan extension"
  version 1

  extension_points {
    before-plan
  }

  step plan {
    name "Create implementation plan"
    role planning
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion plan_created {
      plan_name "{{instance.slug}}"
    }
  }
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["plan-and-build"];
    expect(wf).toBeDefined();
    expect(wf?.extension_points?.before_plan).toBe(true);
    expect(wf?.steps[0]?.role).toBe("planning");
  });

  it("workflow with extension_points { before-plan } but no planning step returns ValidationError (MissingPlanningStep)", () => {
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
    expect(
      errors.some(
        (e) =>
          e.type === "ValidationError" &&
          "message" in e &&
          e.message.includes("MissingPlanningStep"),
      ),
    ).toBe(true);
  });

  it("workflow without extension_points has undefined extension_points in output", () => {
    const src = `workflow quick-fix {
  version 1

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["quick-fix"];
    expect(wf?.extension_points).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseConfig — extend before-plan directive
// ---------------------------------------------------------------------------

describe("parseConfig — extend before-plan directive", () => {
  it("extend before-plan directive parses end-to-end into extend_before_plan.steps", () => {
    const src = `extend before-plan ["spec-review", "requirements"]`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.extend_before_plan.steps).toEqual([
      "spec-review",
      "requirements",
    ]);
  });

  it("extend before-plan combined with a workflow parses correctly", () => {
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
}

extend before-plan ["spec-review"]`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.workflows["plan-and-build"]).toBeDefined();
    expect(
      config.workflows["plan-and-build"]?.extension_points?.before_plan,
    ).toBe(true);
    expect(config.extend_before_plan.steps).toEqual(["spec-review"]);
  });

  it("empty source has extend_before_plan with empty steps", () => {
    const result = parseConfig("");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().extend_before_plan).toEqual({ steps: [] });
  });

  it("invalid extend slot name returns parse error", () => {
    const src = `extend after-plan ["spec-review"]`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — before-plan non-reconciling in v1
// ---------------------------------------------------------------------------

describe("parseConfig — before-plan non-reconciling in v1", () => {
  // Spec 22 Unit 2: "before-plan steps do not participate in reconciliation
  // semantics" in v1. As of Task 4.1, `reconciliation_handlers` is a valid
  // schema field. The v1 non-reconciling constraint for before-plan steps is
  // enforced at the engine/runtime layer, not the schema/validate layer.
  // Steps in the before-plan slot are ordinary WorkflowStep objects; the
  // engine prevents them from acting as reconciliation handlers.

  it("full planning workflow: steps without reconciliation_handlers have undefined field", () => {
    const src = `workflow plan-and-build {
  description "Plan-oriented workflow"
  version 1

  extension_points {
    before-plan
  }

  step plan {
    name "Create implementation plan"
    role planning
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion plan_created {
      plan_name "{{instance.slug}}"
    }
    outputs [
      { name "plan_path" description "Path to the plan" }
    ]
  }

  step implement {
    name "Execute the plan"
    type autonomous
    agent shuttle
    prompt "Execute the plan at {{artifacts.plan_path}}"
    completion plan_complete {
      plan_name "{{instance.slug}}"
    }
    inputs [
      { name "plan_path" description "Path to the plan to execute" }
    ]
  }
}

extend before-plan ["spec-review"]`;

    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();

    const wf = config.workflows["plan-and-build"];
    expect(wf).toBeDefined();
    expect(wf?.extension_points?.before_plan).toBe(true);

    // Steps without reconciliation_handlers have undefined field
    for (const step of wf?.steps ?? []) {
      expect(step.reconciliation_handlers).toBeUndefined();
      // on_reconcile is not a schema field (unknown keys stripped)
      expect("on_reconcile" in step).toBe(false);
    }

    // extend_before_plan is a flat object — no per-workflow keying
    const ebp = config.extend_before_plan;
    expect(ebp.steps).toEqual(["spec-review"]);
    expect("reconciliation_handlers" in ebp).toBe(false);
  });

  it("before-plan steps (via extend before-plan) are ordinary step names with no reconciliation metadata", () => {
    const src = `extend before-plan ["spec-review", "requirements"]`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    const ebp = config.extend_before_plan;
    // Steps are plain string names — no reconciliation handler attached
    expect(ebp.steps).toEqual(["spec-review", "requirements"]);
    expect(Object.keys(ebp).sort()).toEqual(["steps"]);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — reconciliation_handlers on workflow steps
// ---------------------------------------------------------------------------

describe("parseConfig — reconciliation_handlers on workflow steps", () => {
  it("step with reconciliation_handlers declaring execution-mismatch parses end-to-end", () => {
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
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.reconciliation_handlers).toHaveLength(1);
    expect(step?.reconciliation_handlers?.[0]?.reason).toBe(
      "execution-mismatch",
    );
  });

  it("step with all four reconciliation reasons parses end-to-end", () => {
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
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.reconciliation_handlers).toHaveLength(4);
    const reasons = step?.reconciliation_handlers?.map((h) => h.reason) ?? [];
    expect(reasons).toContain("execution-mismatch");
    expect(reasons).toContain("user-revision-request");
    expect(reasons).toContain("review-rejection");
    expect(reasons).toContain("security-rejection");
  });

  it("step without reconciliation_handlers has undefined field in output", () => {
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
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.reconciliation_handlers).toBeUndefined();
  });

  it("step with unknown reconciliation reason returns ValidationError", () => {
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });

  it("step with duplicate reconciliation reason returns ValidationError (DuplicateReconciliationReason)", () => {
    const src = `workflow w {
  version 1

  step bad {
    name "Bad step"
    type autonomous
    agent shuttle
    prompt "Do it."
    completion agent_signal
    reconciliation_handlers [
      { reason "review-rejection" }
      { reason "review-rejection" }
    ]
  }
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
    expect(
      errors.some(
        (e) =>
          e.type === "ValidationError" &&
          "message" in e &&
          e.message.includes("DuplicateReconciliationReason"),
      ),
    ).toBe(true);
  });

  it("step with empty reconciliation_handlers array returns ValidationError", () => {
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });

  it("workflow with handler step and regular steps parses correctly", () => {
    const src = `workflow secure-feature {
  description "Feature with reconciliation handler"
  version 1

  step plan {
    name "Create plan"
    role planning
    type autonomous
    agent pattern
    prompt "Plan the feature."
    completion plan_created {
      plan_name "feature-plan"
    }
    reconciliation_handlers [
      { reason "execution-mismatch" }
      { reason "user-revision-request" }
    ]
  }

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Implement the plan."
    completion plan_complete {
      plan_name "feature-plan"
    }
  }

  step review {
    name "Security review"
    type gate
    agent warp
    prompt "Review the changes."
    completion review_verdict
    on_reject pause
  }
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows["secure-feature"];
    expect(wf).toBeDefined();
    expect(wf?.steps).toHaveLength(3);

    const planStep = wf?.steps[0];
    expect(planStep?.name).toBe("plan");
    expect(planStep?.role).toBe("planning");
    expect(planStep?.reconciliation_handlers).toHaveLength(2);
    expect(planStep?.reconciliation_handlers?.[0]?.reason).toBe(
      "execution-mismatch",
    );
    expect(planStep?.reconciliation_handlers?.[1]?.reason).toBe(
      "user-revision-request",
    );

    const implStep = wf?.steps[1];
    expect(implStep?.reconciliation_handlers).toBeUndefined();

    const reviewStep = wf?.steps[2];
    expect(reviewStep?.on_reject).toBe("pause");
    expect(reviewStep?.reconciliation_handlers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseConfig — workflow-level prompt_append and prompt_append_file (Spec 22 Unit 4)
// ---------------------------------------------------------------------------

describe("parseConfig — workflow-level prompt_append and prompt_append_file", () => {
  it("workflow with prompt_append parses end-to-end and field is present in output", () => {
    const src = `workflow w {
  version 1
  prompt_append "Always write tests for your changes."

  step fix {
    name "Fix"
    type autonomous
    agent shuttle
    prompt "Fix it."
    completion agent_signal
  }
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows.w;
    expect(wf?.prompt_append).toBe("Always write tests for your changes.");
    expect(wf?.prompt_append_file).toBeUndefined();
  });

  it("workflow with prompt_append_file parses end-to-end and field is present in output", () => {
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
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows.w;
    expect(wf?.prompt_append_file).toBe("workflow-guidance.md");
    expect(wf?.prompt_append).toBeUndefined();
  });

  it("workflow without prompt_append or prompt_append_file has both undefined in output", () => {
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
    const result = parseConfig(src);
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
    expect(
      errors.some(
        (e) =>
          e.type === "ValidationError" &&
          "message" in e &&
          e.message.includes("mutually exclusive"),
      ),
    ).toBe(true);
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseConfig — step-level prompt_append and prompt_append_file (Spec 22 Unit 4)
// ---------------------------------------------------------------------------

describe("parseConfig — step-level prompt_append and prompt_append_file", () => {
  it("step with prompt_append parses end-to-end and field is present in output", () => {
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
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.prompt_append).toBe("Focus on test coverage.");
    expect(step?.prompt_append_file).toBeUndefined();
  });

  it("step with prompt_append_file parses end-to-end and field is present in output", () => {
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
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const step = result._unsafeUnwrap().workflows.w?.steps[0];
    expect(step?.prompt_append_file).toBe("step-guidance.md");
    expect(step?.prompt_append).toBeUndefined();
  });

  it("step without prompt_append or prompt_append_file has both undefined in output", () => {
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
    const result = parseConfig(src);
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
    expect(
      errors.some(
        (e) =>
          e.type === "ValidationError" &&
          "message" in e &&
          e.message.includes("mutually exclusive"),
      ),
    ).toBe(true);
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
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });

  it("workflow-level and step-level prompt_append coexist independently end-to-end", () => {
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

  step review {
    name "Review"
    type gate
    agent weft
    prompt "Review the changes."
    completion review_verdict
    on_reject pause
  }
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows.w;
    expect(wf?.prompt_append).toBe("Workflow-wide guidance.");
    expect(wf?.prompt_append_file).toBeUndefined();

    const implStep = wf?.steps[0];
    expect(implStep?.prompt_append).toBe("Step-local guidance.");
    expect(implStep?.prompt_append_file).toBeUndefined();

    const reviewStep = wf?.steps[1];
    expect(reviewStep?.prompt_append).toBeUndefined();
    expect(reviewStep?.prompt_append_file).toBeUndefined();
  });

  it("workflow with prompt_append_file and step with prompt_append_file coexist independently", () => {
    const src = `workflow w {
  version 1
  prompt_append_file "workflow-guidance.md"

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Do the work."
    prompt_append_file "step-guidance.md"
    completion agent_signal
  }
}`;
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap().workflows.w;
    expect(wf?.prompt_append_file).toBe("workflow-guidance.md");
    const step = wf?.steps[0];
    expect(step?.prompt_append_file).toBe("step-guidance.md");
  });
});

// ---------------------------------------------------------------------------
// parseConfig — routing block
// ---------------------------------------------------------------------------

describe("parseConfig — routing block", () => {
  it("agent with routing.delegation_exclude parses end-to-end", () => {
    const src = `agent router {
  prompt "You are a router."
  tool_policy {
    delegate allow
  }
  routing {
    delegation_exclude ["warp", "spindle"]
  }
}`;
    const result = parseConfig(src);
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
    const result = parseConfig(src);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agents.loom?.routing).toBeUndefined();
  });

  it("routing block with unknown key returns ValidationError (strict)", () => {
    const src = `agent bad {
  prompt "You are bad."
  routing {
    delegation_exclude ["warp"]
    typo_key "value"
  }
}`;
    const result = parseConfig(src);
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "ValidationError")).toBe(true);
  });
});
