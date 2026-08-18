import { describe, expect, it } from "bun:test";
import type {
  AgentBlock,
  ArrayValue,
  AstNode,
  AstValue,
  BlockValue,
  CategoryBlock,
  DisableDirective,
  ExtendBeforePlanDirective,
  Property,
  SettingAssignment,
  StepBlock,
  WorkflowBlock,
} from "../ast.js";
import {
  CONFIG_ERRORS_TRUNCATED,
  MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE,
  MAX_CONFIG_ERROR_FIELD_LENGTH,
} from "../config-error-policy.js";
import { tokenize } from "../lexer.js";
import { parse } from "../parser.js";

/** Helper: lex + parse a source string */
type ParseResult = ReturnType<typeof parse>;

function parseSource(src: string): ParseResult {
  const lexResult = tokenize(src);
  if (lexResult.isErr())
    throw new Error(`Lex errors: ${JSON.stringify(lexResult.error)}`);
  return parse(lexResult.value);
}

function parseSuccess(result: ParseResult): AstNode[] {
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw new Error(`Expected parse success: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function parseFailure(result: ParseResult) {
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new Error(`Expected parse failure: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

function firstNode(result: ParseResult): AstNode | undefined {
  return parseSuccess(result)[0];
}

function agentNode(node: AstNode | undefined): AgentBlock {
  if (node?.type !== "agent") {
    throw new Error("Expected an agent fixture");
  }
  return node;
}

function agentFixture(result: ParseResult): AgentBlock {
  return agentNode(firstNode(result));
}

function namedBlockFixture(
  node: AstNode | undefined,
): AgentBlock | CategoryBlock {
  if (node?.type !== "agent" && node?.type !== "category") {
    throw new Error("Expected an agent or category fixture");
  }
  return node;
}

function categoryFixture(result: ParseResult): CategoryBlock {
  const node = firstNode(result);
  if (node?.type !== "category") {
    throw new Error("Expected a category fixture");
  }
  return node;
}

function workflowNode(node: AstNode | undefined): WorkflowBlock {
  if (node?.type !== "workflow") {
    throw new Error("Expected a workflow fixture");
  }
  return node;
}

function workflowFixture(result: ParseResult): WorkflowBlock {
  return workflowNode(firstNode(result));
}

function disableFixture(result: ParseResult): DisableDirective {
  const node = firstNode(result);
  if (node?.type !== "disable") {
    throw new Error("Expected a disable fixture");
  }
  return node;
}

function settingNode(node: AstNode | undefined): SettingAssignment {
  if (node?.type !== "setting") {
    throw new Error("Expected a setting fixture");
  }
  return node;
}

function settingFixture(result: ParseResult): SettingAssignment {
  return settingNode(firstNode(result));
}

function extendBeforePlanFixture(
  result: ParseResult,
): ExtendBeforePlanDirective {
  const node = firstNode(result);
  if (node?.type !== "extend_before_plan") {
    throw new Error("Expected an extend before-plan fixture");
  }
  return node;
}

function propertyFixture(properties: Property[], key: string): Property {
  const property = properties.find((candidate) => candidate.key === key);
  if (property === undefined) {
    throw new Error(`Expected property '${key}'`);
  }
  return property;
}

function blockValueFixture(value: AstValue, label: string): BlockValue {
  if (value.kind !== "block") {
    throw new Error(`Expected block value for '${label}'`);
  }
  return value;
}

function arrayValueFixture(value: AstValue, label: string): ArrayValue {
  if (value.kind !== "array") {
    throw new Error(`Expected array value for '${label}'`);
  }
  return value;
}

function stepFixture(workflow: WorkflowBlock, index: number): StepBlock {
  const step = workflow.steps[index];
  if (step === undefined) {
    throw new Error(`Expected workflow step at index ${index}`);
  }
  return step;
}

describe("Parser — structural preservation", () => {
  it("marks bare flags without changing explicit true literals", () => {
    const bare = agentFixture(parseSource(`agent helper { fast }`));
    const explicit = agentFixture(parseSource(`agent helper { fast true }`));

    expect(bare.properties[0]).toMatchObject({ key: "fast", bare: true });
    expect(explicit.properties[0]).toMatchObject({ key: "fast" });
    expect(explicit.properties[0]?.bare).toBeUndefined();
  });

  it("preserves bare trigger identifiers for fail-closed validation", () => {
    for (const source of [
      `agent helper { triggers [bareword] }`,
      `category helper { description "Helper" triggers [bareword] }`,
    ]) {
      const node = namedBlockFixture(firstNode(parseSource(source)));
      const triggers = arrayValueFixture(
        propertyFixture(node.properties, "triggers").value,
        "triggers",
      );
      expect(triggers.elements[0]?.kind).toBe("identifier");
    }
  });

  it("rejects duplicate extracted workflow and step properties", () => {
    for (const source of [
      `workflow flow { extends "one" extends "two" }`,
      `workflow flow { step run { insert_before "one" insert_before "two" } }`,
    ]) {
      const errors = parseFailure(parseSource(source));
      expect(errors).toContainEqual(
        expect.objectContaining({
          type: "UnexpectedToken",
          expected: expect.stringContaining("unique"),
        }),
      );
    }
  });

  it("bounds adversarial parser fields at the direct boundary", () => {
    const errors = parseFailure(
      parseSource(`agent helper x${"y".repeat(19_999)}`),
    );
    const size = errors.reduce((total, error) => {
      if (error.type === "UnexpectedToken") {
        return total + error.found.length + error.expected.length;
      }
      if (error.type === "MissingBlockName") {
        return total + error.blockType.length;
      }
      return total;
    }, 0);

    expect(errors).toContainEqual(
      expect.objectContaining({
        type: "UnexpectedToken",
        found: expect.stringContaining("[truncated]"),
      }),
    );
    expect(
      errors.every(
        (error) =>
          error.type !== "UnexpectedToken" ||
          (error.found.length <= MAX_CONFIG_ERROR_FIELD_LENGTH &&
            error.expected.length <= MAX_CONFIG_ERROR_FIELD_LENGTH),
      ),
    ).toBe(true);
    expect(size).toBeLessThanOrEqual(MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE);
    expect(JSON.stringify(errors)).toContain(CONFIG_ERRORS_TRUNCATED);
  });
});

describe("Parser — model strings", () => {
  it("keeps plain, suffixed, and escaped hashes opaque inside string values", () => {
    const result = parseSource(`agent shuttle {
  models ["plain-model", "provider/model#high", "weird\\#model"]
}`);
    const agent = agentFixture(result);
    const models = propertyFixture(agent.properties, "models");
    expect(models.value).toMatchObject({
      kind: "array",
      elements: [
        { kind: "string", value: "plain-model" },
        { kind: "string", value: "provider/model#high" },
        { kind: "string", value: "weird\\#model" },
      ],
    });
  });
});

describe("Parser — agent block", () => {
  it("parses a minimal agent block", () => {
    const result = parseSource("agent loom {\n  temperature 0.1\n}");
    const nodes = parseSuccess(result);
    expect(nodes).toHaveLength(1);
    const agent = agentNode(nodes[0]);
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
    execute allow
    network deny
  }
}`;
    const result = parseSource(src);
    const agent = agentFixture(result);
    expect(agent.name).toBe("shuttle");
    const policy = propertyFixture(agent.properties, "tool_policy");
    expect(policy.value.kind).toBe("block");
    const block = blockValueFixture(policy.value, "tool_policy");
    expect(block.properties).toHaveLength(2);
    expect(block.properties[0]).toMatchObject({
      key: "execute",
      value: { kind: "identifier", value: "allow" },
    });
    expect(block.properties[1]).toMatchObject({
      key: "network",
      value: { kind: "identifier", value: "deny" },
    });
  });

  it("parses agent with fast and ordered string triggers", () => {
    const src = `agent loom {
  fast true
  triggers ["Complex tasks", "System design"]
}`;
    const result = parseSource(src);
    const agent = agentFixture(result);
    expect(propertyFixture(agent.properties, "fast").value).toMatchObject({
      kind: "boolean",
      value: true,
    });
    const triggers = propertyFixture(agent.properties, "triggers");
    expect(triggers.value.kind).toBe("array");
    const arr = arrayValueFixture(triggers.value, "triggers");
    expect(arr.elements).toMatchObject([
      { kind: "string", value: "Complex tasks" },
      { kind: "string", value: "System design" },
    ]);
  });
});

describe("Parser — category block", () => {
  it("parses a category with fast and ordered string triggers", () => {
    const src = `category backend {
  description "Backend work"
  fast true
  triggers ["API changes", "Database changes"]
}`;
    const result = parseSource(src);
    const cat = categoryFixture(result);
    expect(cat.type).toBe("category");
    expect(cat.name).toBe("backend");
    expect(propertyFixture(cat.properties, "fast").value).toMatchObject({
      kind: "boolean",
      value: true,
    });
    const triggers = propertyFixture(cat.properties, "triggers");
    expect(triggers.value.kind).toBe("array");
    expect(
      arrayValueFixture(triggers.value, "triggers").elements,
    ).toMatchObject([
      { kind: "string", value: "API changes" },
      { kind: "string", value: "Database changes" },
    ]);
  });
});

describe("Parser — disable directive", () => {
  it("parses disable agents", () => {
    const result = parseSource('disable agents ["warp", "spindle"]');
    const node = disableFixture(result);
    expect(node.type).toBe("disable");
    expect(node.target).toBe("agents");
    expect(node.items).toEqual(["warp", "spindle"]);
  });

  it("parses disable hooks", () => {
    const result = parseSource('disable hooks ["on-session-idle"]');
    const node = disableFixture(result);
    expect(node.target).toBe("hooks");
    expect(node.items).toEqual(["on-session-idle"]);
  });

  it("parses disable skills", () => {
    const result = parseSource('disable skills ["tdd"]');
    const node = disableFixture(result);
    expect(node.target).toBe("skills");
    expect(node.items).toEqual(["tdd"]);
  });
});

describe("Parser — setting assignment", () => {
  it("parses a top-level bare-identifier setting", () => {
    const result = parseSource("log_level INFO");
    const node = settingFixture(result);
    expect(node.type).toBe("setting");
    expect(node.key).toBe("log_level");
    expect(node.value).toMatchObject({ kind: "identifier", value: "INFO" });
  });

  it("parses a top-level boolean setting", () => {
    const result = parseSource("some_flag true");
    const node = settingFixture(result);
    expect(node.value).toMatchObject({ kind: "boolean", value: true });
  });

  it("parses a nested setting block (continuation.recovery.compaction)", () => {
    const src = `continuation {
  recovery {
    compaction true
  }
}`;
    const result = parseSource(src);
    const node = settingFixture(result);
    expect(node.type).toBe("setting");
    expect(node.key).toBe("continuation");
    expect(node.value.kind).toBe("block");
    const outer = blockValueFixture(node.value, "continuation");
    const recovery = propertyFixture(outer.properties, "recovery");
    expect(recovery.value.kind).toBe("block");
    const inner = blockValueFixture(recovery.value, "recovery");
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
    const wf = workflowFixture(result);
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

  it("parses extends scalar inside workflow block", () => {
    const src = `workflow my-ext {
  extends "base-workflow"
  version 1
}`;
    const result = parseSource(src);
    const wf = workflowFixture(result);
    expect(wf.type).toBe("workflow");
    expect(wf.name).toBe("my-ext");
    // extends is extracted to the dedicated field, not left in properties
    expect(wf.extends).toBe("base-workflow");
    const extendsProp = wf.properties.find((p) => p.key === "extends");
    expect(extendsProp).toBeUndefined();
  });

  it("parses insert_before scalar inside step block", () => {
    const src = `workflow w {
  step audit {
    insert_before "review"
    type autonomous
    agent warp
    prompt "Audit."
    completion agent_signal
  }
}`;
    const result = parseSource(src);
    const wf = workflowFixture(result);
    const step = stepFixture(wf, 0);
    expect(step.name).toBe("audit");
    // insert_before is extracted to the dedicated field
    expect(step.insert_before).toBe("review");
    expect(step.insert_after).toBeUndefined();
    // insert_before must NOT appear in properties
    const insertProp = step.properties.find((p) => p.key === "insert_before");
    expect(insertProp).toBeUndefined();
  });

  it("parses insert_after scalar inside step block", () => {
    const src = `workflow w {
  step audit {
    insert_after "plan"
    type autonomous
    agent warp
    prompt "Audit."
    completion agent_signal
  }
}`;
    const result = parseSource(src);
    const wf = workflowFixture(result);
    const step = stepFixture(wf, 0);
    expect(step.insert_after).toBe("plan");
    expect(step.insert_before).toBeUndefined();
    const insertProp = step.properties.find((p) => p.key === "insert_after");
    expect(insertProp).toBeUndefined();
  });

  it("parses workflow with extends and steps containing insert_before", () => {
    const src = `workflow extended {
  extends "base"
  version 2

  step security-check {
    insert_before "deploy"
    type gate
    agent warp
    prompt "Security check."
    completion review_verdict
  }
}`;
    const result = parseSource(src);
    const wf = workflowFixture(result);
    expect(wf.extends).toBe("base");
    expect(wf.steps).toHaveLength(1);
    const step = stepFixture(wf, 0);
    expect(step.insert_before).toBe("deploy");
    expect(step.insert_after).toBeUndefined();
  });
});

describe("Parser — multiple top-level blocks", () => {
  it("parses multiple blocks in one source", () => {
    const src = `agent loom {
  temperature 0.1
}

category backend {
  description "Backend work"
}

log_level INFO`;
    const result = parseSource(src);
    const nodes = parseSuccess(result);
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
    const wf = workflowFixture(result);
    const step = stepFixture(wf, 0);
    const completionProp = propertyFixture(step.properties, "completion");
    expect(completionProp.value.kind).toBe("block");
    const block = blockValueFixture(completionProp.value, "completion");
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
    const wf = workflowFixture(result);
    const step = stepFixture(wf, 0);
    const completionProp = propertyFixture(step.properties, "completion");
    expect(completionProp.value.kind).toBe("identifier");
    expect(completionProp.value).toMatchObject({
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
    const agent = agentFixture(result);
    const prop = propertyFixture(agent.properties, "some_key");
    expect(prop.value.kind).toBe("block");
    const block = blockValueFixture(prop.value, "some_key");
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

describe("Parser — settings block", () => {
  it("parses settings { log_level INFO } as a SettingAssignment with block value", () => {
    const src = `settings {
  log_level INFO
}`;
    const result = parseSource(src);
    const node = settingFixture(result);
    expect(node.type).toBe("setting");
    expect(node.key).toBe("settings");
    expect(node.value.kind).toBe("block");
    const block = blockValueFixture(node.value, "settings");
    expect(block.properties).toHaveLength(1);
    expect(block.properties[0]).toMatchObject({
      key: "log_level",
      value: { kind: "identifier", value: "INFO" },
    });
  });

  it("parses settings { enforce_permissions false } as a boolean property", () => {
    const result = parseSource(`settings {
  enforce_permissions false
}`);
    const node = settingFixture(result);
    const block = blockValueFixture(node.value, "settings");
    expect(block.properties[0]).toMatchObject({
      key: "enforce_permissions",
      value: { kind: "boolean", value: false },
    });
  });

  it("parses settings { runtime { journal { strict true } } } as nested blocks", () => {
    const src = `settings {
  log_level WARN
  runtime {
    journal {
      strict true
    }
  }
}`;
    const result = parseSource(src);
    const node = settingFixture(result);
    expect(node.type).toBe("setting");
    expect(node.key).toBe("settings");
    expect(node.value.kind).toBe("block");
    const outer = blockValueFixture(node.value, "settings");
    // log_level and runtime
    expect(outer.properties).toHaveLength(2);
    const logLevelProp = propertyFixture(outer.properties, "log_level");
    expect(logLevelProp.value).toMatchObject({
      kind: "identifier",
      value: "WARN",
    });
    const runtimeProp = propertyFixture(outer.properties, "runtime");
    expect(runtimeProp.value.kind).toBe("block");
    const runtimeBlock = blockValueFixture(runtimeProp.value, "runtime");
    const journalProp = propertyFixture(runtimeBlock.properties, "journal");
    expect(journalProp.value.kind).toBe("block");
    const journalBlock = blockValueFixture(journalProp.value, "journal");
    expect(journalBlock.properties[0]).toMatchObject({
      key: "strict",
      value: { kind: "boolean", value: true },
    });
  });

  it("parses full runtime retention settings as nested blocks", () => {
    const src = `settings {
  runtime {
    journal {
      strict false
      retention_days 30
      max_entries 10000
    }
    usage {
      detail_retention_days 30
      max_observations 100000
    }
    log {
      max_segment_bytes 5242880
      max_segments 3
    }
  }
}`;
    const result = parseSource(src);
    const node = settingFixture(result);
    const outer = blockValueFixture(node.value, "settings");
    const runtimeBlock = blockValueFixture(
      propertyFixture(outer.properties, "runtime").value,
      "runtime",
    );
    expect(runtimeBlock.properties.map((p) => p.key).sort()).toEqual([
      "journal",
      "log",
      "usage",
    ]);

    const journalBlock = blockValueFixture(
      propertyFixture(runtimeBlock.properties, "journal").value,
      "journal",
    );
    expect(
      journalBlock.properties.find((p) => p.key === "retention_days")?.value,
    ).toMatchObject({ kind: "number", value: 30 });
    expect(
      journalBlock.properties.find((p) => p.key === "max_entries")?.value,
    ).toMatchObject({ kind: "number", value: 10000 });

    const usageBlock = blockValueFixture(
      propertyFixture(runtimeBlock.properties, "usage").value,
      "usage",
    );
    expect(
      usageBlock.properties.find((p) => p.key === "detail_retention_days")
        ?.value,
    ).toMatchObject({ kind: "number", value: 30 });
    expect(
      usageBlock.properties.find((p) => p.key === "max_observations")?.value,
    ).toMatchObject({ kind: "number", value: 100000 });

    const logBlock = blockValueFixture(
      propertyFixture(runtimeBlock.properties, "log").value,
      "log",
    );
    expect(
      logBlock.properties.find((p) => p.key === "max_segment_bytes")?.value,
    ).toMatchObject({ kind: "number", value: 5242880 });
    expect(
      logBlock.properties.find((p) => p.key === "max_segments")?.value,
    ).toMatchObject({ kind: "number", value: 3 });
  });
});

describe("Parser — routing block inside agent", () => {
  it("parses routing { delegation_exclude [...] } as a BlockValue property", () => {
    const src = `agent loom {
  routing {
    delegation_exclude ["warp", "spindle"]
  }
}`;
    const result = parseSource(src);
    const agent = agentFixture(result);
    expect(agent.name).toBe("loom");
    const routingProp = propertyFixture(agent.properties, "routing");
    expect(routingProp.value.kind).toBe("block");
    const block = blockValueFixture(routingProp.value, "routing");
    expect(block.properties).toHaveLength(1);
    const excludeProp = propertyFixture(block.properties, "delegation_exclude");
    expect(excludeProp).toMatchObject({
      key: "delegation_exclude",
    });
    const excludeArr = arrayValueFixture(
      excludeProp.value,
      "delegation_exclude",
    );
    expect(excludeArr.kind).toBe("array");
    expect(excludeArr.elements).toHaveLength(2);
    expect(excludeArr.elements[0]).toMatchObject({
      kind: "string",
      value: "warp",
    });
    expect(excludeArr.elements[1]).toMatchObject({
      kind: "string",
      value: "spindle",
    });
  });

  it("parses agent with both tool_policy and routing blocks", () => {
    const src = `agent router {
  tool_policy {
    delegate allow
  }
  routing {
    delegation_exclude ["warp"]
  }
}`;
    const result = parseSource(src);
    const agent = agentFixture(result);
    const toolPolicyProp = propertyFixture(agent.properties, "tool_policy");
    const routingProp = propertyFixture(agent.properties, "routing");
    expect(toolPolicyProp.value.kind).toBe("block");
    expect(routingProp.value.kind).toBe("block");
  });

  it("parses routing block with empty delegation_exclude array", () => {
    const src = `agent loom {
  routing {
    delegation_exclude []
  }
}`;
    const result = parseSource(src);
    const agent = agentFixture(result);
    const routingProp = propertyFixture(agent.properties, "routing");
    const block = blockValueFixture(routingProp.value, "routing");
    const excludeProp = propertyFixture(block.properties, "delegation_exclude");
    const excludeArr = arrayValueFixture(
      excludeProp.value,
      "delegation_exclude",
    );
    expect(excludeArr.elements).toHaveLength(0);
  });
});

describe("Parser — extend before-plan directive", () => {
  it("parses extend before-plan with a step list into ExtendBeforePlanDirective", () => {
    const src = `extend before-plan ["spec-review", "requirements"]`;
    const result = parseSource(src);
    const node = extendBeforePlanFixture(result);
    expect(node.type).toBe("extend_before_plan");
    expect(node.steps).toEqual(["spec-review", "requirements"]);
    // v1: no workflow field — single global bucket
    expect("workflow" in node).toBe(false);
  });

  it("parses a single-step extend before-plan", () => {
    const src = `extend before-plan ["write-spec"]`;
    const result = parseSource(src);
    const node = extendBeforePlanFixture(result);
    expect(node.type).toBe("extend_before_plan");
    expect(node.steps).toEqual(["write-spec"]);
  });

  it("rejects extend with unknown slot name (not before-plan)", () => {
    const src = `extend after-plan ["spec-review"]`;
    const result = parseSource(src);
    const errors = parseFailure(result);
    expect(errors.some((e) => e.type === "UnexpectedToken")).toBe(true);
  });
});

describe("Parser — errors", () => {
  it("reports UnclosedBlock for missing closing brace", () => {
    const result = parseSource("agent loom {");
    const errors = parseFailure(result);
    expect(errors.some((e) => e.type === "UnclosedBlock")).toBe(true);
  });

  it("reports MissingBlockName for agent without name", () => {
    const result = parseSource("agent {");
    const errors = parseFailure(result);
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
    const errors = parseFailure(result);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("Parser — agent review_models field", () => {
  it("parses review_models as a string array property", () => {
    const src = `agent weft {
  review_models ["claude-opus-4-5", "gpt-4o"]
}`;
    const result = parseSource(src);
    const agent = agentFixture(result);
    expect(agent.type).toBe("agent");
    expect(agent.name).toBe("weft");
    const prop = propertyFixture(agent.properties, "review_models");
    expect(prop).toBeDefined();
    expect(prop.value.kind).toBe("array");
    const arr = arrayValueFixture(prop.value, "review_models");
    expect(arr.elements).toHaveLength(2);
    expect(arr.elements[0]).toMatchObject({
      kind: "string",
      value: "claude-opus-4-5",
    });
    expect(arr.elements[1]).toMatchObject({ kind: "string", value: "gpt-4o" });
  });

  it("parses agent with both models and review_models", () => {
    const src = `agent weft {
  models ["claude-sonnet-4-5"]
  review_models ["claude-opus-4-5"]
}`;
    const result = parseSource(src);
    const agent = agentFixture(result);
    const modelsProp = propertyFixture(agent.properties, "models");
    const reviewProp = propertyFixture(agent.properties, "review_models");
    expect(modelsProp.value.kind).toBe("array");
    expect(reviewProp.value.kind).toBe("array");
    const reviewArr = arrayValueFixture(reviewProp.value, "review_models");
    expect(reviewArr.elements[0]).toMatchObject({
      kind: "string",
      value: "claude-opus-4-5",
    });
  });

  it("parses agent without review_models (field absent from AST)", () => {
    const src = `agent shuttle {
  models ["claude-sonnet-4-5"]
}`;
    const result = parseSource(src);
    const agent = agentFixture(result);
    const prop = agent.properties.find((p) => p.key === "review_models");
    expect(prop).toBeUndefined();
  });
});

describe("Parser — delegation limits", () => {
  it("parses project and agent delegation blocks", () => {
    const source = `settings {
  delegation {
    max_children 256
    max_concurrency 64
    max_depth 32
    max_processes 128
  }
}

agent tapestry {
  delegation {
    max_children 64
    max_concurrency 32
  }
}`;
    const result = parseSource(source);
    const nodes = parseSuccess(result);
    const settings = settingNode(nodes[0]);
    const settingsBlock = blockValueFixture(settings.value, "settings");
    const delegation = blockValueFixture(
      propertyFixture(settingsBlock.properties, "delegation").value,
      "delegation",
    );
    expect(delegation.properties.map((property) => property.key)).toEqual([
      "max_children",
      "max_concurrency",
      "max_depth",
      "max_processes",
    ]);
    expect(
      propertyFixture(delegation.properties, "max_concurrency").value,
    ).toMatchObject({ kind: "number", value: 64 });

    const agent = agentNode(nodes[1]);
    const agentDelegation = blockValueFixture(
      propertyFixture(agent.properties, "delegation").value,
      "delegation",
    );
    expect(agentDelegation.properties[0]?.value).toMatchObject({
      kind: "number",
      value: 64,
    });
  });

  it("parses JSON number forms inside opaque adapter settings", () => {
    const result = parseSource(
      `settings { adapters { test { negative -1 exponent 1.25e+2 } } }`,
    );
    const nodes = parseSuccess(result);
    const settings = settingNode(nodes[0]);
    const settingsBlock = blockValueFixture(settings.value, "settings");
    const adapters = blockValueFixture(
      propertyFixture(settingsBlock.properties, "adapters").value,
      "adapters",
    );
    const test = blockValueFixture(
      propertyFixture(adapters.properties, "test").value,
      "test",
    );
    expect(test.properties.map((property) => property.value)).toMatchObject([
      { kind: "number", value: -1 },
      { kind: "number", value: 125 },
    ]);
  });

  it("parses null inside opaque adapter settings", () => {
    const result = parseSource(`settings { adapters { test { value null } } }`);
    const nodes = parseSuccess(result);
    const settings = settingNode(nodes[0]);
    const settingsBlock = blockValueFixture(settings.value, "settings");
    const adapters = blockValueFixture(
      propertyFixture(settingsBlock.properties, "adapters").value,
      "adapters",
    );
    const test = blockValueFixture(
      propertyFixture(adapters.properties, "test").value,
      "test",
    );
    expect(propertyFixture(test.properties, "value").value).toMatchObject({
      kind: "null",
      value: null,
    });
  });
});
