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
    search ask
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
    edit allow
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
    edit allow
    delegate allow
    search ask
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
