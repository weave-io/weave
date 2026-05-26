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
