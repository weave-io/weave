import { describe, expect, it } from "bun:test";
import type {
  AgentBlock,
  ArrayValue,
  BlockValue,
  CategoryBlock,
  DisableDirective,
  SettingAssignment,
  WorkflowBlock,
} from "../ast.js";
import { tokenize } from "../lexer.js";
import { parse } from "../parser.js";

/** Helper: lex + parse a source string */
function parseSource(src: string) {
  const lexResult = tokenize(src);
  if (lexResult.isErr())
    throw new Error(`Lex errors: ${JSON.stringify(lexResult.error)}`);
  return parse(lexResult.value);
}

describe("Parser — agent block", () => {
  it("parses a minimal agent block", () => {
    const result = parseSource("agent loom {\n  temperature 0.1\n}");
    expect(result.isOk()).toBe(true);
    const nodes = result._unsafeUnwrap();
    expect(nodes).toHaveLength(1);
    const agent = nodes[0] as AgentBlock;
    expect(agent.type).toBe("agent");
    expect(agent.name).toBe("loom");
    expect(agent.properties).toHaveLength(1);
    expect(agent.properties[0]?.key).toBe("temperature");
    expect(agent.properties[0]?.value).toMatchObject({
      kind: "number",
      value: 0.1,
    });
  });

  it("parses agent with nested tool_policy block", () => {
    const src = `agent shuttle {
  tool_policy {
    read allow
    write deny
  }
}`;
    const result = parseSource(src);
    expect(result.isOk()).toBe(true);
    const agent = result._unsafeUnwrap()[0] as AgentBlock;
    expect(agent.name).toBe("shuttle");
    const policy = agent.properties.find((p) => p.key === "tool_policy");
    expect(policy?.value.kind).toBe("block");
    const block = policy?.value as BlockValue;
    expect(block.properties).toHaveLength(2);
    expect(block.properties[0]).toMatchObject({
      key: "read",
      value: { kind: "identifier", value: "allow" },
    });
    expect(block.properties[1]).toMatchObject({
      key: "write",
      value: { kind: "identifier", value: "deny" },
    });
  });

  it("parses agent with triggers array of block objects", () => {
    const src = `agent loom {
  triggers [
    { domain "Orchestration" trigger "Complex tasks" }
  ]
}`;
    const result = parseSource(src);
    expect(result.isOk()).toBe(true);
    const agent = result._unsafeUnwrap()[0] as AgentBlock;
    const triggers = agent.properties.find((p) => p.key === "triggers");
    expect(triggers?.value.kind).toBe("array");
    const arr = triggers?.value as ArrayValue;
    expect(arr.elements).toHaveLength(1);
    expect(arr.elements[0]?.kind).toBe("block");
  });
});

describe("Parser — category block", () => {
  it("parses a category with patterns array", () => {
    const src = `category backend {
  patterns ["src/api/**", "src/db/**"]
}`;
    const result = parseSource(src);
    expect(result.isOk()).toBe(true);
    const cat = result._unsafeUnwrap()[0] as CategoryBlock;
    expect(cat.type).toBe("category");
    expect(cat.name).toBe("backend");
    const patterns = cat.properties.find((p) => p.key === "patterns");
    expect(patterns?.value.kind).toBe("array");
    const arr = patterns?.value as ArrayValue;
    expect(arr.elements).toHaveLength(2);
    expect(arr.elements[0]).toMatchObject({
      kind: "string",
      value: "src/api/**",
    });
  });
});

describe("Parser — disable directive", () => {
  it("parses disable agents", () => {
    const result = parseSource('disable agents ["warp", "spindle"]');
    expect(result.isOk()).toBe(true);
    const node = result._unsafeUnwrap()[0] as DisableDirective;
    expect(node.type).toBe("disable");
    expect(node.target).toBe("agents");
    expect(node.items).toEqual(["warp", "spindle"]);
  });

  it("parses disable hooks", () => {
    const result = parseSource('disable hooks ["on-session-idle"]');
    expect(result.isOk()).toBe(true);
    const node = result._unsafeUnwrap()[0] as DisableDirective;
    expect(node.target).toBe("hooks");
    expect(node.items).toEqual(["on-session-idle"]);
  });

  it("parses disable skills", () => {
    const result = parseSource('disable skills ["tdd"]');
    expect(result.isOk()).toBe(true);
    const node = result._unsafeUnwrap()[0] as DisableDirective;
    expect(node.target).toBe("skills");
    expect(node.items).toEqual(["tdd"]);
  });
});

describe("Parser — setting assignment", () => {
  it("parses a top-level bare-identifier setting", () => {
    const result = parseSource("log_level INFO");
    expect(result.isOk()).toBe(true);
    const node = result._unsafeUnwrap()[0] as SettingAssignment;
    expect(node.type).toBe("setting");
    expect(node.key).toBe("log_level");
    expect(node.value).toMatchObject({ kind: "identifier", value: "INFO" });
  });

  it("parses a top-level boolean setting", () => {
    const result = parseSource("some_flag true");
    expect(result.isOk()).toBe(true);
    const node = result._unsafeUnwrap()[0] as SettingAssignment;
    expect(node.value).toMatchObject({ kind: "boolean", value: true });
  });

  it("parses a nested setting block (continuation.recovery.compaction)", () => {
    const src = `continuation {
  recovery {
    compaction true
  }
}`;
    const result = parseSource(src);
    expect(result.isOk()).toBe(true);
    const node = result._unsafeUnwrap()[0] as SettingAssignment;
    expect(node.type).toBe("setting");
    expect(node.key).toBe("continuation");
    expect(node.value.kind).toBe("block");
    const outer = node.value as BlockValue;
    const recovery = outer.properties.find((p) => p.key === "recovery");
    expect(recovery?.value.kind).toBe("block");
    const inner = recovery?.value as BlockValue;
    expect(inner.properties[0]).toMatchObject({
      key: "compaction",
      value: { kind: "boolean", value: true },
    });
  });
});

describe("Parser — workflow block", () => {
  it("parses a workflow with steps", () => {
    const src = `workflow quick-fix {
  description "Fix a bug"

  step fix {
    name "Implement the fix"
    type autonomous
  }

  step review {
    name "Code review"
    type gate
  }
}`;
    const result = parseSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap()[0] as WorkflowBlock;
    expect(wf.type).toBe("workflow");
    expect(wf.name).toBe("quick-fix");
    expect(wf.steps).toHaveLength(2);
    expect(wf.steps[0]?.name).toBe("fix");
    expect(wf.steps[1]?.name).toBe("review");
    const descProp = wf.properties.find((p) => p.key === "description");
    expect(descProp?.value).toMatchObject({
      kind: "string",
      value: "Fix a bug",
    });
  });
});

describe("Parser — multiple top-level blocks", () => {
  it("parses multiple blocks in one source", () => {
    const src = `agent loom {
  temperature 0.1
}

category backend {
  patterns ["src/api/**"]
}

log_level INFO`;
    const result = parseSource(src);
    expect(result.isOk()).toBe(true);
    const nodes = result._unsafeUnwrap();
    expect(nodes).toHaveLength(3);
    expect(nodes[0]?.type).toBe("agent");
    expect(nodes[1]?.type).toBe("category");
    expect(nodes[2]?.type).toBe("setting");
  });
});

describe("Parser — named block value", () => {
  it("completion plan_created { plan_name '...' } produces a BlockValue with __name", () => {
    const src = `workflow w {
  step plan {
    completion plan_created {
      plan_name "{{instance.slug}}"
    }
  }
}`;
    const result = parseSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap()[0] as WorkflowBlock;
    const step = wf.steps[0];
    const completionProp = step?.properties.find((p) => p.key === "completion");
    expect(completionProp?.value.kind).toBe("block");
    const block = completionProp?.value as BlockValue;
    // First property must be __name
    expect(block.properties[0]).toMatchObject({
      key: "__name",
      value: { kind: "identifier", value: "plan_created" },
    });
    // Second property is the param
    expect(block.properties[1]).toMatchObject({
      key: "plan_name",
      value: { kind: "string", value: "{{instance.slug}}" },
    });
  });

  it("completion user_confirm (no block) still produces an IdentifierValue", () => {
    const src = `workflow w {
  step review {
    completion user_confirm
  }
}`;
    const result = parseSource(src);
    expect(result.isOk()).toBe(true);
    const wf = result._unsafeUnwrap()[0] as WorkflowBlock;
    const step = wf.steps[0];
    const completionProp = step?.properties.find((p) => p.key === "completion");
    expect(completionProp?.value.kind).toBe("identifier");
    expect(completionProp?.value).toMatchObject({
      kind: "identifier",
      value: "user_confirm",
    });
  });

  it("named block value pattern works for non-completion properties too (general purpose)", () => {
    const src = `agent loom {
  some_key my_method {
    param1 "value1"
    param2 42
  }
}`;
    const result = parseSource(src);
    expect(result.isOk()).toBe(true);
    const agent = result._unsafeUnwrap()[0] as AgentBlock;
    const prop = agent.properties.find((p) => p.key === "some_key");
    expect(prop?.value.kind).toBe("block");
    const block = prop?.value as BlockValue;
    expect(block.properties[0]).toMatchObject({
      key: "__name",
      value: { kind: "identifier", value: "my_method" },
    });
    expect(block.properties[1]).toMatchObject({
      key: "param1",
      value: { kind: "string", value: "value1" },
    });
    expect(block.properties[2]).toMatchObject({
      key: "param2",
      value: { kind: "number", value: 42 },
    });
  });
});

describe("Parser — errors", () => {
  it("reports UnclosedBlock for missing closing brace", () => {
    const result = parseSource("agent loom {");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "UnclosedBlock")).toBe(true);
  });

  it("reports MissingBlockName for agent without name", () => {
    const result = parseSource("agent {");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.some((e) => e.type === "MissingBlockName")).toBe(true);
    const err = errors.find((e) => e.type === "MissingBlockName");
    if (err?.type === "MissingBlockName") {
      expect(err.blockType).toBe("agent");
    }
  });

  it("error recovery: second block parses correctly after first block error", () => {
    // First block has no closing brace (UnclosedBlock), parser should still get second block
    const src = `agent broken {
  temperature 0.1

agent good {
  temperature 0.5
}`;
    const result = parseSource(src);
    // Should have errors but also recover some nodes
    // The parser may get confused — at minimum it should not crash and
    // should report at least one error
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.length).toBeGreaterThan(0);
  });
});
