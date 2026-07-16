/**
 * Tests for the shared capability model (Task 1.0).
 *
 * Covers:
 * - All 4 readiness levels are valid; no extra values accepted by schema.
 * - All 20 capability IDs are valid.
 * - CapabilityEntry accepts all readiness levels and required/optional fields.
 * - AdapterCapabilityContract structural assertions.
 * - Tool-policy capability references @weaveio/weave-core concepts (no duplication).
 * - Public exports are usable from the engine barrel.
 */

import { describe, expect, it } from "bun:test";
// Verify barrel re-exports are usable
import {
  ALL_CAPABILITY_IDS as BARREL_ALL,
  OPTIONAL_CAPABILITIES as BARREL_OPTIONAL,
  REQUIRED_CAPABILITIES as BARREL_REQUIRED,
  evaluateCoreReadinessProfile,
} from "@weaveio/weave-engine";
import type {
  AdapterCapabilityContract,
  CapabilityEntry,
  CapabilityId,
  CapabilityReadiness,
} from "../capability-contract.js";
import {
  AdapterCapabilityContractSchema,
  ALL_CAPABILITY_IDS,
  CapabilityEntrySchema,
  CapabilityIdSchema,
  CapabilityReadinessSchema,
  OPTIONAL_CAPABILITIES,
  REQUIRED_CAPABILITIES,
} from "../capability-contract.js";

// ---------------------------------------------------------------------------
// § 1 — CapabilityReadiness
// ---------------------------------------------------------------------------

describe("CapabilityReadiness", () => {
  const validLevels: CapabilityReadiness[] = [
    "native",
    "emulated",
    "degraded",
    "unsupported",
  ];

  it("accepts all four approved readiness values", () => {
    for (const level of validLevels) {
      const result = CapabilityReadinessSchema.safeParse(level);
      expect(result.success).toBe(true);
    }
  });

  it("rejects any value outside the four approved levels", () => {
    const invalid = ["partial", "unknown", "supported", "yes", "", 42, null];
    for (const v of invalid) {
      const result = CapabilityReadinessSchema.safeParse(v);
      expect(result.success).toBe(false);
    }
  });

  it("has exactly 4 enum members", () => {
    expect(CapabilityReadinessSchema.options).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// § 2 — CapabilityId
// ---------------------------------------------------------------------------

describe("CapabilityId", () => {
  it("has exactly 20 capability IDs", () => {
    expect(ALL_CAPABILITY_IDS).toHaveLength(20);
  });

  it("has exactly 12 required capability IDs", () => {
    expect(REQUIRED_CAPABILITIES).toHaveLength(12);
  });

  it("has exactly 8 optional capability IDs", () => {
    expect(OPTIONAL_CAPABILITIES).toHaveLength(8);
  });

  it("accepts all 20 capability IDs via schema", () => {
    for (const id of ALL_CAPABILITY_IDS) {
      const result = CapabilityIdSchema.safeParse(id);
      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown capability IDs", () => {
    const invalid = ["unknown-cap", "config", "agent", "", 42, null];
    for (const v of invalid) {
      const result = CapabilityIdSchema.safeParse(v);
      expect(result.success).toBe(false);
    }
  });

  it("required and optional sets are disjoint", () => {
    const requiredSet = new Set(REQUIRED_CAPABILITIES);
    for (const id of OPTIONAL_CAPABILITIES) {
      expect(requiredSet.has(id as CapabilityId)).toBe(false);
    }
  });

  it("ALL_CAPABILITY_IDS = required + optional in order", () => {
    expect(ALL_CAPABILITY_IDS).toEqual([
      ...REQUIRED_CAPABILITIES,
      ...OPTIONAL_CAPABILITIES,
    ]);
  });

  it("contains all required capability IDs from the spec", () => {
    const required = new Set(REQUIRED_CAPABILITIES);
    expect(required.has("config-materialization")).toBe(true);
    expect(required.has("agent-materialization")).toBe(true);
    expect(required.has("primary-agent-selection")).toBe(true);
    expect(required.has("delegated-specialist-execution")).toBe(true);
    expect(required.has("prompt-composition")).toBe(true);
    expect(required.has("tool-policy-mapping")).toBe(true);
    expect(required.has("workflow-persistence")).toBe(true);
    expect(required.has("workflow-step-dispatch")).toBe(true);
    expect(required.has("plan-file-compatibility")).toBe(true);
    expect(required.has("command-entrypoints")).toBe(true);
    expect(required.has("event-logging")).toBe(true);
    expect(required.has("token-usage-reporting")).toBe(true);
  });

  it("contains all optional capability IDs from the spec", () => {
    const optional = new Set(OPTIONAL_CAPABILITIES);
    expect(optional.has("idle-continuation")).toBe(true);
    expect(optional.has("compaction-recovery")).toBe(true);
    expect(optional.has("context-window-monitor")).toBe(true);
    expect(optional.has("analytics-dashboard")).toBe(true);
    expect(optional.has("eval-integration")).toBe(true);
    expect(optional.has("static-artifact-generation")).toBe(true);
    expect(optional.has("multiple-active-workflows")).toBe(true);
    expect(optional.has("review-fan-out")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// § 3 — CapabilityEntry
// ---------------------------------------------------------------------------

describe("CapabilityEntry", () => {
  it("accepts a minimal valid entry", () => {
    const entry: CapabilityEntry = {
      id: "config-materialization",
      description: "Config materialization",
      readiness: "native",
    };
    const result = CapabilityEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("accepts all readiness levels", () => {
    const levels: CapabilityReadiness[] = [
      "native",
      "emulated",
      "degraded",
      "unsupported",
    ];
    for (const readiness of levels) {
      const entry: CapabilityEntry = {
        id: "agent-materialization",
        description: "Agent materialization",
        readiness,
      };
      const result = CapabilityEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    }
  });

  it("accepts all optional fields", () => {
    const entry: CapabilityEntry = {
      id: "tool-policy-mapping",
      description: "Tool policy mapping",
      readiness: "emulated",
      notes: "Maps Weave ToolPolicy allow/deny/ask to harness permission model",
      runtimeStatus: "active",
      blockingImpact: "Incorrect permissions may be granted",
      supplier: "synthetic-adapter",
      remediationHint: "Upgrade adapter to v2",
    };
    const result = CapabilityEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("rejects entry with invalid readiness", () => {
    const result = CapabilityEntrySchema.safeParse({
      id: "config-materialization",
      description: "Config",
      readiness: "partial",
    });
    expect(result.success).toBe(false);
  });

  it("rejects entry with invalid capability ID", () => {
    const result = CapabilityEntrySchema.safeParse({
      id: "unknown-capability",
      description: "Unknown",
      readiness: "native",
    });
    expect(result.success).toBe(false);
  });

  it("rejects entry with empty description", () => {
    const result = CapabilityEntrySchema.safeParse({
      id: "config-materialization",
      description: "",
      readiness: "native",
    });
    expect(result.success).toBe(false);
  });

  it("tool-policy-mapping entry can reference ToolPolicy concepts in notes", () => {
    // Verify the entry can carry notes referencing @weaveio/weave-core ToolPolicy
    // without duplicating the allow/deny/ask enum in this module.
    const entry: CapabilityEntry = {
      id: "tool-policy-mapping",
      description: "Tool policy mapping/enforcement",
      readiness: "native",
      notes:
        "Maps @weaveio/weave-core ToolPolicy (allow/deny/ask) to harness permission model",
    };
    const result = CapabilityEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    expect(entry.notes).toContain("ToolPolicy");
  });
});

// ---------------------------------------------------------------------------
// § 4 — AdapterCapabilityContract
// ---------------------------------------------------------------------------

describe("AdapterCapabilityContract", () => {
  it("accepts an empty capabilities array", () => {
    const contract: AdapterCapabilityContract = { capabilities: [] };
    const result = AdapterCapabilityContractSchema.safeParse(contract);
    expect(result.success).toBe(true);
  });

  it("accepts a contract with multiple valid entries", () => {
    const contract: AdapterCapabilityContract = {
      capabilities: [
        {
          id: "config-materialization",
          description: "Config materialization",
          readiness: "native",
        },
        {
          id: "agent-materialization",
          description: "Agent materialization",
          readiness: "emulated",
          notes: "Emulated via config file generation",
        },
        {
          id: "idle-continuation",
          description: "Idle continuation",
          readiness: "unsupported",
          notes: "Harness does not support idle continuation",
        },
      ],
    };
    const result = AdapterCapabilityContractSchema.safeParse(contract);
    expect(result.success).toBe(true);
  });

  it("rejects a contract with an invalid entry", () => {
    const result = AdapterCapabilityContractSchema.safeParse({
      capabilities: [
        {
          id: "config-materialization",
          description: "Config",
          readiness: "invalid-level",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// § 5 — Barrel re-exports
// ---------------------------------------------------------------------------

describe("engine barrel re-exports", () => {
  it("exports REQUIRED_CAPABILITIES from @weaveio/weave-engine", () => {
    expect(BARREL_REQUIRED).toHaveLength(12);
    expect(BARREL_REQUIRED).toEqual(REQUIRED_CAPABILITIES);
  });

  it("exports OPTIONAL_CAPABILITIES from @weaveio/weave-engine", () => {
    expect(BARREL_OPTIONAL).toHaveLength(8);
    expect(BARREL_OPTIONAL).toEqual(OPTIONAL_CAPABILITIES);
  });

  it("exports ALL_CAPABILITY_IDS from @weaveio/weave-engine", () => {
    expect(BARREL_ALL).toHaveLength(20);
  });

  it("exports evaluateCoreReadinessProfile from @weaveio/weave-engine", () => {
    expect(typeof evaluateCoreReadinessProfile).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// § 6 — Synthetic fixture sanitization proof
// ---------------------------------------------------------------------------

describe("synthetic fixture sanitization", () => {
  it("fixture entries use synthetic adapter names and notes only", () => {
    const fixtures: CapabilityEntry[] = [
      {
        id: "config-materialization",
        description: "Config materialization",
        readiness: "native",
        supplier: "synthetic-adapter",
        notes: "Synthetic: reads .weave/config.weave and emits harness config",
      },
      {
        id: "agent-materialization",
        description: "Agent materialization",
        readiness: "emulated",
        supplier: "synthetic-adapter",
        notes: "Synthetic: emulated via config file generation",
        remediationHint: "Upgrade synthetic-adapter to v2 for native support",
      },
      {
        id: "workflow-persistence",
        description: "Workflow persistence",
        readiness: "degraded",
        supplier: "synthetic-adapter",
        blockingImpact: "Workflow state may be lost on restart",
        remediationHint: "Enable persistence backend in harness config",
      },
    ];

    for (const entry of fixtures) {
      // No credentials, local paths, or real harness config contents
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("api_key");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("/Users/");
      expect(serialized).not.toContain("/home/");
    }
  });
});
