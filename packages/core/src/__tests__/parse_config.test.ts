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

  it("full valid source: agents, categories, disable, log_level", () => {
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

log_level INFO`;

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

    // Log level
    expect(config.log_level).toBe("INFO");
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
