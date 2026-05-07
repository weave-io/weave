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
    edit allow
    delegate allow
    search ask
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
    const step = result._unsafeUnwrap().workflows["feature"]?.steps[0];
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
    const step = result._unsafeUnwrap().workflows["w"]?.steps[0];
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
    const step = result._unsafeUnwrap().workflows["w"]?.steps[0];
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
    const step = result._unsafeUnwrap().workflows["w"]?.steps[0];
    expect(step?.name).toBe("my-step");
    expect(step?.display_name).toBe("My Display Name");
  });
});

describe("validate — log_level setting", () => {
  it("valid log_level is included in config", () => {
    const result = validateSource("log_level INFO");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().log_level).toBe("INFO");
  });

  it("invalid log_level → err", () => {
    const result = validateSource("log_level verbose");
    expect(result.isErr()).toBe(true);
  });
});
