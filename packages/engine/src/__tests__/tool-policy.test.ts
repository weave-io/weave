/**
 * tool-policy.test.ts
 *
 * `evaluateEffectiveToolPolicy` and the abstract capability list are asserted
 * where a user meets them: `tests/dsl/tool-policy.scenario.test.ts` resolves
 * every capability against every permission from `.weave` source, and
 * `tests/adapters/` shows the mapped decisions reaching a harness as concrete
 * tool names.
 *
 * What is left is the **unmapped** half of `resolveToolDecisions`. Both
 * adapters derive their `*_TOOL_IDS` from their own classification list
 * (`CLAUDE_CODE_TOOL_IDS`, `COPILOT_TOOL_IDS`), so every id they resolve is
 * classified and no generated file can contain an unmapped decision. The
 * branch exists for a future adapter that passes a harness-supplied tool list,
 * and it is the explicit refusal to treat an unclassified tool as allowed —
 * see the no-caller findings in `docs/testing-strategy.md`.
 */

import { describe, expect, it } from "bun:test";
import type {
  ConcreteToolClassification,
  EffectiveToolPolicy,
  MappedToolDecision,
  UnmappedToolDecision,
} from "../tool-policy.js";
import { resolveToolDecisions } from "../tool-policy.js";

describe("resolveToolDecisions", () => {
  const allAllowPolicy: EffectiveToolPolicy = {
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "allow",
    network: "allow",
  };

  it("unknown synthetic tool id → explicit unmapped outcome (kind: unmapped)", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.read-tool", capability: "read" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.unknown-tool"],
      classifications,
      allAllowPolicy,
    );
    expect(results).toHaveLength(1);
    const decision = results[0] as UnmappedToolDecision;
    expect(decision.kind).toBe("unmapped");
    expect(decision.toolId).toBe("synthetic.unknown-tool");
  });

  it("unmapped decision has no permission field", () => {
    const results = resolveToolDecisions(
      ["synthetic.unknown-tool"],
      [],
      allAllowPolicy,
    );
    const decision = results[0] as UnmappedToolDecision;
    expect(decision.kind).toBe("unmapped");
    // Compile-time: UnmappedToolDecision has no `permission` field.
    // Runtime: the object must not have a permission property.
    expect(Object.hasOwn(decision, "permission")).toBe(false);
  });

  it("unmapped decision kind discriminant differs from mapped", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.read-tool", capability: "read" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.read-tool", "synthetic.unknown-tool"],
      classifications,
      allAllowPolicy,
    );
    expect(results[0].kind).toBe("mapped");
    expect(results[1].kind).toBe("unmapped");
  });

  it("empty classifications list → all tool ids produce unmapped outcomes", () => {
    const toolIds = [
      "synthetic.read-tool",
      "synthetic.write-tool",
      "synthetic.unknown-tool",
    ];
    const results = resolveToolDecisions(toolIds, [], allAllowPolicy);
    for (const decision of results) {
      expect(decision.kind).toBe("unmapped");
    }
  });

  it("mixed batch: classified tools are mapped, unclassified are unmapped", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.read-tool", capability: "read" },
      { toolId: "synthetic.write-tool", capability: "write" },
      { toolId: "synthetic.execute-tool", capability: "execute" },
      { toolId: "synthetic.delegate-tool", capability: "delegate" },
      { toolId: "synthetic.network-tool", capability: "network" },
    ];
    const toolIds = [
      "synthetic.read-tool",
      "synthetic.write-tool",
      "synthetic.execute-tool",
      "synthetic.delegate-tool",
      "synthetic.network-tool",
      "synthetic.unknown-tool",
    ];
    const results = resolveToolDecisions(
      toolIds,
      classifications,
      allAllowPolicy,
    );

    expect(results).toHaveLength(6);

    // All five classified tools are mapped with allow
    for (let i = 0; i < 5; i++) {
      const d = results[i] as MappedToolDecision;
      expect(d.kind).toBe("mapped");
      expect(d.permission).toBe("allow");
    }

    // The unknown tool is unmapped
    const unknown = results[5] as UnmappedToolDecision;
    expect(unknown.kind).toBe("unmapped");
    expect(unknown.toolId).toBe("synthetic.unknown-tool");
  });

  it("returns decisions in the same order as toolIds", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.network-tool", capability: "network" },
      { toolId: "synthetic.read-tool", capability: "read" },
    ];
    const toolIds = [
      "synthetic.read-tool",
      "synthetic.unknown-tool",
      "synthetic.network-tool",
    ];
    const results = resolveToolDecisions(
      toolIds,
      classifications,
      allAllowPolicy,
    );

    expect(results[0].toolId).toBe("synthetic.read-tool");
    expect(results[0].kind).toBe("mapped");
    expect(results[1].toolId).toBe("synthetic.unknown-tool");
    expect(results[1].kind).toBe("unmapped");
    expect(results[2].toolId).toBe("synthetic.network-tool");
    expect(results[2].kind).toBe("mapped");
  });

  it("empty toolIds list → returns empty array", () => {
    const results = resolveToolDecisions([], [], allAllowPolicy);
    expect(results).toHaveLength(0);
  });
});
