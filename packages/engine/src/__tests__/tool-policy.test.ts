import { describe, expect, it } from "bun:test";
import type { ToolPermission, ToolPolicy } from "@weaveio/weave-core";
import type {
  ConcreteToolClassification,
  EffectiveToolPolicy,
  MappedToolDecision,
  ToolDecision,
  UnmappedToolDecision,
} from "../tool-policy.js";
import {
  ABSTRACT_CAPABILITIES,
  DEFAULT_PERMISSION,
  evaluateEffectiveToolPolicy,
  resolveToolDecisions,
} from "../tool-policy.js";

// ---------------------------------------------------------------------------
// ABSTRACT_CAPABILITIES
// ---------------------------------------------------------------------------

describe("ABSTRACT_CAPABILITIES", () => {
  it("contains exactly the five approved abstract capabilities", () => {
    expect(ABSTRACT_CAPABILITIES).toEqual([
      "read",
      "write",
      "execute",
      "delegate",
      "network",
    ]);
  });

  it("has exactly five entries", () => {
    expect(ABSTRACT_CAPABILITIES).toHaveLength(5);
  });

  it("contains 'read'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("read");
  });

  it("contains 'write'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("write");
  });

  it("contains 'execute'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("execute");
  });

  it("contains 'delegate'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("delegate");
  });

  it("contains 'network'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("network");
  });

  it("is typed as (keyof ToolPolicy)[] — all entries are valid ToolPolicy keys", () => {
    // Compile-time check: ABSTRACT_CAPABILITIES is typed as (keyof ToolPolicy)[].
    // Runtime check: every entry is a valid key of a ToolPolicy object.
    const validKeys: (keyof ToolPolicy)[] = [
      "read",
      "write",
      "execute",
      "delegate",
      "network",
    ];
    for (const cap of ABSTRACT_CAPABILITIES) {
      expect(validKeys).toContain(cap);
    }
  });

  it("does not contain harness-specific tool names", () => {
    // Guard: no OpenCode, Claude Code, Pi, or other harness names
    const harnessNames = [
      "opencode",
      "claude-code",
      "pi",
      "bash",
      "edit",
      "search",
      "glob",
    ];
    for (const name of harnessNames) {
      expect(ABSTRACT_CAPABILITIES).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// EffectiveToolPolicy
// ---------------------------------------------------------------------------

describe("EffectiveToolPolicy", () => {
  it("accepts an object with all five capabilities as required fields", () => {
    // Type-level: if EffectiveToolPolicy required fields are missing, this
    // would be a compile error. Runtime: verify the shape is correct.
    const policy: EffectiveToolPolicy = {
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "deny",
      network: "ask",
    };

    expect(policy.read).toBe("allow");
    expect(policy.write).toBe("deny");
    expect(policy.execute).toBe("ask");
    expect(policy.delegate).toBe("deny");
    expect(policy.network).toBe("ask");
  });

  it("covers all five ABSTRACT_CAPABILITIES as required keys", () => {
    const policy: EffectiveToolPolicy = {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "allow",
      network: "allow",
    };

    for (const cap of ABSTRACT_CAPABILITIES) {
      expect(policy[cap]).toBeDefined();
    }
  });

  it("each capability value is a valid ToolPermission", () => {
    const validPermissions: ToolPermission[] = ["allow", "deny", "ask"];
    const policy: EffectiveToolPolicy = {
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "allow",
      network: "deny",
    };

    for (const cap of ABSTRACT_CAPABILITIES) {
      expect(validPermissions).toContain(policy[cap]);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_PERMISSION
// ---------------------------------------------------------------------------

describe("DEFAULT_PERMISSION", () => {
  it("equals 'ask'", () => {
    expect(DEFAULT_PERMISSION).toBe("ask");
  });

  it("is typed as ToolPermission", () => {
    // Compile-time: DEFAULT_PERMISSION is typed as ToolPermission.
    // Runtime: verify it is one of the three valid values.
    const validPermissions: ToolPermission[] = ["allow", "deny", "ask"];
    expect(validPermissions).toContain(DEFAULT_PERMISSION);
  });

  it("is the safest default (ask requires explicit approval)", () => {
    // Semantic assertion: 'ask' is the most restrictive safe default.
    // 'allow' would be too permissive; 'deny' would break workflows silently.
    expect(DEFAULT_PERMISSION).not.toBe("allow");
    expect(DEFAULT_PERMISSION).not.toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// evaluateEffectiveToolPolicy
// ---------------------------------------------------------------------------

describe("evaluateEffectiveToolPolicy", () => {
  // -------------------------------------------------------------------------
  // undefined policy — all capabilities default to 'ask'
  // -------------------------------------------------------------------------

  it("returns all-ask when policy is undefined", () => {
    const result = evaluateEffectiveToolPolicy(undefined);
    expect(result).toEqual({
      read: "ask",
      write: "ask",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    });
  });

  it("returns a complete object (all five keys) when policy is undefined", () => {
    const result = evaluateEffectiveToolPolicy(undefined);
    for (const cap of ABSTRACT_CAPABILITIES) {
      expect(result).toHaveProperty(cap);
    }
  });

  // -------------------------------------------------------------------------
  // partial policy — omitted fields default to 'ask', configured fields preserved
  // -------------------------------------------------------------------------

  it("preserves read:allow and defaults the rest to ask", () => {
    const result = evaluateEffectiveToolPolicy({ read: "allow" });
    expect(result).toEqual({
      read: "allow",
      write: "ask",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    });
  });

  it("preserves write:deny and defaults the rest to ask", () => {
    const result = evaluateEffectiveToolPolicy({ write: "deny" });
    expect(result).toEqual({
      read: "ask",
      write: "deny",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    });
  });

  it("preserves execute:allow and defaults the rest to ask", () => {
    const result = evaluateEffectiveToolPolicy({ execute: "allow" });
    expect(result).toEqual({
      read: "ask",
      write: "ask",
      execute: "allow",
      delegate: "ask",
      network: "ask",
    });
  });

  it("preserves delegate:deny and defaults the rest to ask", () => {
    const result = evaluateEffectiveToolPolicy({ delegate: "deny" });
    expect(result).toEqual({
      read: "ask",
      write: "ask",
      execute: "ask",
      delegate: "deny",
      network: "ask",
    });
  });

  it("preserves network:allow and defaults the rest to ask", () => {
    const result = evaluateEffectiveToolPolicy({ network: "allow" });
    expect(result).toEqual({
      read: "ask",
      write: "ask",
      execute: "ask",
      delegate: "ask",
      network: "allow",
    });
  });

  // -------------------------------------------------------------------------
  // full policy — all configured values preserved exactly
  // -------------------------------------------------------------------------

  it("preserves all values when full policy is provided", () => {
    const policy: ToolPolicy = {
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "allow",
      network: "deny",
    };
    const result = evaluateEffectiveToolPolicy(policy);
    expect(result).toEqual({
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "allow",
      network: "deny",
    });
  });

  it("preserves all-allow policy", () => {
    const policy: ToolPolicy = {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "allow",
      network: "allow",
    };
    const result = evaluateEffectiveToolPolicy(policy);
    expect(result).toEqual({
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "allow",
      network: "allow",
    });
  });

  it("preserves all-deny policy", () => {
    const policy: ToolPolicy = {
      read: "deny",
      write: "deny",
      execute: "deny",
      delegate: "deny",
      network: "deny",
    };
    const result = evaluateEffectiveToolPolicy(policy);
    expect(result).toEqual({
      read: "deny",
      write: "deny",
      execute: "deny",
      delegate: "deny",
      network: "deny",
    });
  });

  it("preserves all-ask policy", () => {
    const policy: ToolPolicy = {
      read: "ask",
      write: "ask",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    };
    const result = evaluateEffectiveToolPolicy(policy);
    expect(result).toEqual({
      read: "ask",
      write: "ask",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    });
  });

  // -------------------------------------------------------------------------
  // Table-driven: each capability × each permission value
  // -------------------------------------------------------------------------

  const capabilities: (keyof ToolPolicy)[] = [
    "read",
    "write",
    "execute",
    "delegate",
    "network",
  ];
  const permissions: ToolPermission[] = ["allow", "deny", "ask"];

  for (const cap of capabilities) {
    for (const perm of permissions) {
      it(`preserves ${cap}:${perm} when explicitly configured`, () => {
        const policy: ToolPolicy = { [cap]: perm };
        const result = evaluateEffectiveToolPolicy(policy);
        expect(result[cap]).toBe(perm);
      });

      it(`other capabilities default to ask when only ${cap}:${perm} is set`, () => {
        const policy: ToolPolicy = { [cap]: perm };
        const result = evaluateEffectiveToolPolicy(policy);
        for (const other of capabilities) {
          if (other === cap) continue;
          expect(result[other]).toBe("ask");
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // Return type completeness — always returns all five keys
  // -------------------------------------------------------------------------

  it("always returns exactly five keys regardless of input", () => {
    const inputs: Array<ToolPolicy | undefined> = [
      undefined,
      {},
      { read: "allow" },
      { read: "allow", write: "deny" },
      {
        read: "allow",
        write: "deny",
        execute: "ask",
        delegate: "allow",
        network: "deny",
      },
    ];
    for (const input of inputs) {
      const result = evaluateEffectiveToolPolicy(input);
      expect(Object.keys(result)).toHaveLength(5);
      for (const cap of ABSTRACT_CAPABILITIES) {
        expect(result).toHaveProperty(cap);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveToolDecisions — adapter-facing concrete tool classification contract
// ---------------------------------------------------------------------------
//
// All fixtures use synthetic tool identifiers (synthetic.*) only.
// No harness names (opencode, claude-code, pi, bash, etc.) appear here.
// Aligned with Spec 07 `tool-policy-mapping` capability.

describe("resolveToolDecisions", () => {
  // Shared all-allow effective policy for basic classification tests
  const allAllowPolicy: EffectiveToolPolicy = {
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "allow",
    network: "allow",
  };

  // Shared all-deny effective policy for deny tests
  const allDenyPolicy: EffectiveToolPolicy = {
    read: "deny",
    write: "deny",
    execute: "deny",
    delegate: "deny",
    network: "deny",
  };

  // -------------------------------------------------------------------------
  // ConcreteToolClassification type — compile-time shape check
  // -------------------------------------------------------------------------

  it("ConcreteToolClassification accepts a synthetic tool id and abstract capability", () => {
    const entry: ConcreteToolClassification = {
      toolId: "synthetic.read-tool",
      capability: "read",
    };
    expect(entry.toolId).toBe("synthetic.read-tool");
    expect(entry.capability).toBe("read");
  });

  it("ConcreteToolClassification capability is typed as keyof ToolPolicy", () => {
    const validCapabilities: (keyof ToolPolicy)[] = [
      "read",
      "write",
      "execute",
      "delegate",
      "network",
    ];
    const entry: ConcreteToolClassification = {
      toolId: "synthetic.write-tool",
      capability: "write",
    };
    expect(validCapabilities).toContain(entry.capability);
  });

  // -------------------------------------------------------------------------
  // MappedToolDecision — each abstract capability receives matching permission
  // -------------------------------------------------------------------------

  it("tool classified as read with read:allow → mapped decision with permission allow", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.read-tool", capability: "read" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.read-tool"],
      classifications,
      allAllowPolicy,
    );
    expect(results).toHaveLength(1);
    const decision = results[0] as MappedToolDecision;
    expect(decision.kind).toBe("mapped");
    expect(decision.toolId).toBe("synthetic.read-tool");
    expect(decision.capability).toBe("read");
    expect(decision.permission).toBe("allow");
  });

  it("tool classified as write with write:allow → mapped decision with permission allow", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.write-tool", capability: "write" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.write-tool"],
      classifications,
      allAllowPolicy,
    );
    const decision = results[0] as MappedToolDecision;
    expect(decision.kind).toBe("mapped");
    expect(decision.capability).toBe("write");
    expect(decision.permission).toBe("allow");
  });

  it("tool classified as execute with execute:allow → mapped decision with permission allow", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.execute-tool", capability: "execute" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.execute-tool"],
      classifications,
      allAllowPolicy,
    );
    const decision = results[0] as MappedToolDecision;
    expect(decision.kind).toBe("mapped");
    expect(decision.capability).toBe("execute");
    expect(decision.permission).toBe("allow");
  });

  it("tool classified as delegate with delegate:allow → mapped decision with permission allow", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.delegate-tool", capability: "delegate" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.delegate-tool"],
      classifications,
      allAllowPolicy,
    );
    const decision = results[0] as MappedToolDecision;
    expect(decision.kind).toBe("mapped");
    expect(decision.capability).toBe("delegate");
    expect(decision.permission).toBe("allow");
  });

  it("tool classified as network with network:allow → mapped decision with permission allow", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.network-tool", capability: "network" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.network-tool"],
      classifications,
      allAllowPolicy,
    );
    const decision = results[0] as MappedToolDecision;
    expect(decision.kind).toBe("mapped");
    expect(decision.capability).toBe("network");
    expect(decision.permission).toBe("allow");
  });

  // -------------------------------------------------------------------------
  // Deny permission propagation
  // -------------------------------------------------------------------------

  it("tool classified as network with network:deny → mapped decision with permission deny", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.network-tool", capability: "network" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.network-tool"],
      classifications,
      allDenyPolicy,
    );
    const decision = results[0] as MappedToolDecision;
    expect(decision.kind).toBe("mapped");
    expect(decision.capability).toBe("network");
    expect(decision.permission).toBe("deny");
  });

  it("tool classified as read with read:deny → mapped decision with permission deny", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.read-tool", capability: "read" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.read-tool"],
      classifications,
      allDenyPolicy,
    );
    const decision = results[0] as MappedToolDecision;
    expect(decision.kind).toBe("mapped");
    expect(decision.permission).toBe("deny");
  });

  // -------------------------------------------------------------------------
  // Ask permission propagation
  // -------------------------------------------------------------------------

  it("tool classified as execute with execute:ask → mapped decision with permission ask", () => {
    const askPolicy: EffectiveToolPolicy = {
      read: "ask",
      write: "ask",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    };
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.execute-tool", capability: "execute" },
    ];
    const results = resolveToolDecisions(
      ["synthetic.execute-tool"],
      classifications,
      askPolicy,
    );
    const decision = results[0] as MappedToolDecision;
    expect(decision.kind).toBe("mapped");
    expect(decision.permission).toBe("ask");
  });

  // -------------------------------------------------------------------------
  // UnmappedToolDecision — unknown/unclassified tool id
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Mixed batch — mapped and unmapped in same call
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Order preservation
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Empty toolIds — returns empty array
  // -------------------------------------------------------------------------

  it("empty toolIds list → returns empty array", () => {
    const results = resolveToolDecisions([], [], allAllowPolicy);
    expect(results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Purity — no harness names in fixtures
  // -------------------------------------------------------------------------

  it("fixture guard: no harness-specific tool names appear in test identifiers", () => {
    // All synthetic.* identifiers used in this describe block are opaque to
    // the engine. This test documents the invariant explicitly.
    const syntheticIds = [
      "synthetic.read-tool",
      "synthetic.write-tool",
      "synthetic.execute-tool",
      "synthetic.delegate-tool",
      "synthetic.network-tool",
      "synthetic.unknown-tool",
    ];
    const harnessNames = [
      "opencode",
      "claude-code",
      "pi",
      "bash",
      "edit",
      "search",
      "glob",
    ];
    for (const id of syntheticIds) {
      for (const harness of harnessNames) {
        expect(id).not.toContain(harness);
      }
    }
  });

  // -------------------------------------------------------------------------
  // ToolDecision union — type discriminant completeness
  // -------------------------------------------------------------------------

  it("ToolDecision kind is either 'mapped' or 'unmapped' — no other values", () => {
    const classifications: ConcreteToolClassification[] = [
      { toolId: "synthetic.read-tool", capability: "read" },
    ];
    const results: ToolDecision[] = resolveToolDecisions(
      ["synthetic.read-tool", "synthetic.unknown-tool"],
      classifications,
      allAllowPolicy,
    );
    const validKinds = ["mapped", "unmapped"];
    for (const decision of results) {
      expect(validKinds).toContain(decision.kind);
    }
  });
});
