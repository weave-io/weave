/**
 * Tests for the Core Readiness Profile evaluator (Task 2.0).
 *
 * Covers:
 * - Required degraded → fail
 * - Required unsupported → fail
 * - Required emulated → pass
 * - Required native → pass
 * - Optional unsupported → warning only (not failure)
 * - Optional degraded → warning only (not failure)
 * - Missing required → failure
 * - Missing optional → warning only
 * - All required native → ready: true
 * - Mixed required+optional failures/warnings
 * - Token-usage-reporting special case (conditionally required)
 * - Coverage guard: all 20 capability IDs are present in the profile
 * - Sanitized JSON fixture with blocking and warning entries
 */

import { describe, expect, it } from "bun:test";
import type {
  AdapterCapabilityContract,
  CapabilityEntry,
  CapabilityId,
  CapabilityReadiness,
} from "../capability-contract.js";
import {
  ALL_CAPABILITY_IDS,
  evaluateCoreReadinessProfile,
  OPTIONAL_CAPABILITIES,
  REQUIRED_CAPABILITIES,
} from "../capability-contract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a contract with all 12 required capabilities at the given readiness. */
function allRequiredAt(
  readiness: CapabilityReadiness,
): AdapterCapabilityContract {
  return {
    capabilities: REQUIRED_CAPABILITIES.map((id) => ({
      id,
      description: `Synthetic: ${id}`,
      readiness,
      supplier: "synthetic-adapter",
    })),
  };
}

/** Build a contract with all 20 capabilities at the given readiness. */
function allCapabilitiesAt(
  readiness: CapabilityReadiness,
): AdapterCapabilityContract {
  return {
    capabilities: ALL_CAPABILITY_IDS.map((id) => ({
      id,
      description: `Synthetic: ${id}`,
      readiness,
      supplier: "synthetic-adapter",
    })),
  };
}

/** Build a full passing contract (all required native, all optional native). */
function fullPassingContract(): AdapterCapabilityContract {
  return allCapabilitiesAt("native");
}

/** Override a single capability in a contract. */
function withOverride(
  contract: AdapterCapabilityContract,
  id: CapabilityId,
  entry: Partial<CapabilityEntry>,
): AdapterCapabilityContract {
  return {
    capabilities: contract.capabilities.map((c) =>
      c.id === id ? { ...c, ...entry } : c,
    ),
  };
}

// ---------------------------------------------------------------------------
// § 1 — Required capability failures
// ---------------------------------------------------------------------------

describe("required capability: degraded → fail", () => {
  it("fails readiness when a required capability is degraded", () => {
    const contract = withOverride(
      fullPassingContract(),
      "config-materialization",
      {
        readiness: "degraded",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.capabilityId).toBe("config-materialization");
    expect(result.failures[0]?.verdict).toBe("fail");
    expect(result.failures[0]?.readiness).toBe("degraded");
  });

  it("fails readiness when multiple required capabilities are degraded", () => {
    const contract = withOverride(
      withOverride(fullPassingContract(), "agent-materialization", {
        readiness: "degraded",
      }),
      "workflow-persistence",
      { readiness: "degraded" },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(2);
  });
});

describe("required capability: unsupported → fail", () => {
  it("fails readiness when a required capability is unsupported", () => {
    const contract = withOverride(fullPassingContract(), "prompt-composition", {
      readiness: "unsupported",
    });
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    expect(
      result.failures.some((f) => f.capabilityId === "prompt-composition"),
    ).toBe(true);
  });

  it("fails readiness when tool-policy-mapping is unsupported", () => {
    const contract = withOverride(
      fullPassingContract(),
      "tool-policy-mapping",
      {
        readiness: "unsupported",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    expect(
      result.failures.some((f) => f.capabilityId === "tool-policy-mapping"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// § 2 — Required capability passes
// ---------------------------------------------------------------------------

describe("required capability: emulated → pass", () => {
  it("passes readiness when all required capabilities are emulated", () => {
    const contract = allRequiredAt("emulated");
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("passes a single emulated required capability", () => {
    const contract = withOverride(
      fullPassingContract(),
      "agent-materialization",
      {
        readiness: "emulated",
        notes: "Synthetic: emulated via config file generation",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    const pass = result.passes.find(
      (p) => p.capabilityId === "agent-materialization",
    );
    expect(pass).toBeDefined();
    expect(pass?.readiness).toBe("emulated");
  });
});

describe("required capability: native → pass", () => {
  it("passes readiness when all required capabilities are native", () => {
    const contract = allRequiredAt("native");
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.passes).toHaveLength(12);
  });

  it("all required native → ready: true", () => {
    const contract = fullPassingContract();
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// § 3 — Optional capability warnings
// ---------------------------------------------------------------------------

describe("optional capability: unsupported → warning only", () => {
  it("does not fail readiness when an optional capability is unsupported", () => {
    const contract = withOverride(fullPassingContract(), "idle-continuation", {
      readiness: "unsupported",
    });
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(
      result.warnings.some((w) => w.capabilityId === "idle-continuation"),
    ).toBe(true);
  });

  it("produces a warning for each unsupported optional capability", () => {
    let contract = fullPassingContract();
    for (const id of OPTIONAL_CAPABILITIES) {
      contract = withOverride(contract, id, { readiness: "unsupported" });
    }
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.warnings).toHaveLength(OPTIONAL_CAPABILITIES.length);
  });
});

describe("optional capability: degraded → warning only", () => {
  it("does not fail readiness when an optional capability is degraded", () => {
    const contract = withOverride(
      fullPassingContract(),
      "compaction-recovery",
      {
        readiness: "degraded",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(
      result.warnings.some((w) => w.capabilityId === "compaction-recovery"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// § 4 — Missing capabilities
// ---------------------------------------------------------------------------

describe("missing required capability → failure", () => {
  it("fails readiness when a required capability is not declared", () => {
    const contract: AdapterCapabilityContract = {
      capabilities: REQUIRED_CAPABILITIES.filter(
        (id) => id !== "command-entrypoints",
      ).map((id) => ({
        id,
        description: `Synthetic: ${id}`,
        readiness: "native" as const,
        supplier: "synthetic-adapter",
      })),
    };
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    const failure = result.failures.find(
      (f) => f.capabilityId === "command-entrypoints",
    );
    expect(failure).toBeDefined();
    expect(failure?.readiness).toBe("missing");
    expect(failure?.verdict).toBe("fail");
  });

  it("fails readiness when all required capabilities are missing", () => {
    const contract: AdapterCapabilityContract = { capabilities: [] };
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    expect(result.failures).toHaveLength(REQUIRED_CAPABILITIES.length);
  });
});

describe("missing optional capability → warning only", () => {
  it("produces a warning when an optional capability is not declared", () => {
    const contract = allRequiredAt("native");
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    expect(result.warnings).toHaveLength(OPTIONAL_CAPABILITIES.length);
    for (const id of OPTIONAL_CAPABILITIES) {
      expect(result.warnings.some((w) => w.capabilityId === id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// § 5 — Token-usage-reporting special case
// ---------------------------------------------------------------------------

describe("token-usage-reporting: conditionally required", () => {
  it("fails when token-usage-reporting is unsupported without a documented reason", () => {
    const contract = withOverride(
      fullPassingContract(),
      "token-usage-reporting",
      {
        readiness: "unsupported",
        // No notes — harness does not document why
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    expect(
      result.failures.some((f) => f.capabilityId === "token-usage-reporting"),
    ).toBe(true);
  });

  it("downgrades to warning when token-usage-reporting is unsupported with documented reason", () => {
    const contract = withOverride(
      fullPassingContract(),
      "token-usage-reporting",
      {
        readiness: "unsupported",
        notes: "Harness does not expose token usage data",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    expect(
      result.failures.some((f) => f.capabilityId === "token-usage-reporting"),
    ).toBe(false);
    expect(
      result.warnings.some((w) => w.capabilityId === "token-usage-reporting"),
    ).toBe(true);
  });

  it("passes when token-usage-reporting is native", () => {
    const contract = fullPassingContract();
    const result = evaluateCoreReadinessProfile(contract);
    expect(
      result.passes.some((p) => p.capabilityId === "token-usage-reporting"),
    ).toBe(true);
  });

  it("passes when token-usage-reporting is emulated", () => {
    const contract = withOverride(
      fullPassingContract(),
      "token-usage-reporting",
      {
        readiness: "emulated",
        notes: "Synthetic: emulated via request interceptor",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    expect(
      result.passes.some((p) => p.capabilityId === "token-usage-reporting"),
    ).toBe(true);
  });

  it("fails when token-usage-reporting is degraded", () => {
    const contract = withOverride(
      fullPassingContract(),
      "token-usage-reporting",
      {
        readiness: "degraded",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    expect(
      result.failures.some((f) => f.capabilityId === "token-usage-reporting"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// § 6 — Coverage guard
// ---------------------------------------------------------------------------

describe("coverage guard: all spec capabilities are in the profile", () => {
  it("REQUIRED_CAPABILITIES contains exactly the 12 capabilities from the spec", () => {
    const specRequired: CapabilityId[] = [
      "config-materialization",
      "agent-materialization",
      "primary-agent-selection",
      "delegated-specialist-execution",
      "prompt-composition",
      "tool-policy-mapping",
      "workflow-persistence",
      "workflow-step-dispatch",
      "plan-file-compatibility",
      "command-entrypoints",
      "event-logging",
      "token-usage-reporting",
    ];
    expect(new Set(REQUIRED_CAPABILITIES)).toEqual(new Set(specRequired));
    expect(REQUIRED_CAPABILITIES).toHaveLength(12);
  });

  it("OPTIONAL_CAPABILITIES contains exactly the 8 capabilities from the spec", () => {
    const specOptional: CapabilityId[] = [
      "idle-continuation",
      "compaction-recovery",
      "context-window-monitor",
      "analytics-dashboard",
      "eval-integration",
      "static-artifact-generation",
      "multiple-active-workflows",
      "review-fan-out",
    ];
    expect(new Set(OPTIONAL_CAPABILITIES)).toEqual(new Set(specOptional));
    expect(OPTIONAL_CAPABILITIES).toHaveLength(8);
  });

  it("every capability ID appears in exactly one group (required XOR optional)", () => {
    const requiredSet = new Set(REQUIRED_CAPABILITIES);
    const optionalSet = new Set(OPTIONAL_CAPABILITIES);
    for (const id of ALL_CAPABILITY_IDS) {
      const inRequired = requiredSet.has(id);
      const inOptional = optionalSet.has(id);
      expect(inRequired !== inOptional).toBe(true);
    }
  });

  it("evaluation result accounts for all 20 capabilities when all are declared", () => {
    const contract = fullPassingContract();
    const result = evaluateCoreReadinessProfile(contract);
    const total =
      result.passes.length + result.failures.length + result.warnings.length;
    expect(total).toBe(ALL_CAPABILITY_IDS.length);
  });
});

// ---------------------------------------------------------------------------
// § 7 — Mixed required+optional scenario
// ---------------------------------------------------------------------------

describe("mixed required+optional failures and warnings", () => {
  it("correctly separates failures and warnings in a mixed contract", () => {
    let contract = fullPassingContract();
    // Degrade two required capabilities
    contract = withOverride(contract, "workflow-persistence", {
      readiness: "degraded",
      blockingImpact: "Workflow state may be lost",
    });
    contract = withOverride(contract, "event-logging", {
      readiness: "unsupported",
      blockingImpact: "Debug traces unavailable",
    });
    // Degrade two optional capabilities
    contract = withOverride(contract, "analytics-dashboard", {
      readiness: "degraded",
    });
    contract = withOverride(contract, "eval-integration", {
      readiness: "unsupported",
    });

    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.warnings).toHaveLength(2);
    const failureIds = [...result.failures.map((f) => f.capabilityId)].sort();
    const warningIds = [...result.warnings.map((w) => w.capabilityId)].sort();
    expect(failureIds).toEqual(["event-logging", "workflow-persistence"]);
    expect(warningIds).toEqual(["analytics-dashboard", "eval-integration"]);
  });
});

// ---------------------------------------------------------------------------
// § 8 — Sanitized JSON fixture
// ---------------------------------------------------------------------------

describe("sanitized JSON fixture", () => {
  it("evaluation output includes blocking and warning entries in deterministic order", () => {
    let contract = allRequiredAt("native");
    // Add optional capabilities with mixed readiness
    contract = {
      capabilities: [
        ...contract.capabilities,
        {
          id: "idle-continuation",
          description: "Idle continuation",
          readiness: "native",
          supplier: "synthetic-adapter",
        },
        {
          id: "compaction-recovery",
          description: "Compaction recovery",
          readiness: "unsupported",
          supplier: "synthetic-adapter",
          notes: "Synthetic: not implemented in this harness version",
          remediationHint: "Upgrade to synthetic-adapter v3",
        },
        {
          id: "context-window-monitor",
          description: "Context window monitor",
          readiness: "degraded",
          supplier: "synthetic-adapter",
          notes: "Synthetic: partial monitoring only",
        },
      ],
    };

    const result = evaluateCoreReadinessProfile(contract);
    const json = JSON.stringify(result, null, 2);

    // Must be parseable
    const parsed = JSON.parse(json) as typeof result;
    expect(parsed.ready).toBe(true);
    expect(parsed.failures).toHaveLength(0);
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(2);

    // Warnings must include the unsupported and degraded optional capabilities
    const warnIds = parsed.warnings.map(
      (w: { capabilityId: string }) => w.capabilityId,
    );
    expect(warnIds).toContain("compaction-recovery");
    expect(warnIds).toContain("context-window-monitor");

    // No credentials or secrets in output
    expect(json).not.toContain("password");
    expect(json).not.toContain("api_key");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("/Users/");
  });
});

// ---------------------------------------------------------------------------
// § 9 — Spec 22 Unit 4: command-entrypoints as canonical execution-entry
// ---------------------------------------------------------------------------

/**
 * Spec 22 Unit 4 proof: `command-entrypoints` is the canonical execution-entry
 * capability. `workflow-step-dispatch` is supporting execution context — it is
 * NOT a second execution-entry capability.
 *
 * These tests demonstrate:
 * 1. A command harness (native commands) declares `command-entrypoints: native`.
 * 2. A non-command harness (skill/script delivery) declares
 *    `command-entrypoints: emulated` and still passes the Core Readiness Profile.
 * 3. `workflow-step-dispatch` readiness is independent of execution-entry
 *    readiness — a harness with `workflow-step-dispatch: native` but
 *    `command-entrypoints: unsupported` still fails the profile.
 * 4. `workflow-step-dispatch` alone cannot substitute for `command-entrypoints`.
 */

describe("Spec 22 Unit 4: command-entrypoints is the canonical execution-entry capability", () => {
  it("command harness with native command support passes the profile", () => {
    // A harness that exposes literal /run-workflow commands declares native.
    const contract = withOverride(
      fullPassingContract(),
      "command-entrypoints",
      {
        readiness: "native",
        description: "Execution command entrypoints",
        notes:
          "Harness exposes /run-workflow and /resume-workflow commands for explicit user-authorized execution start",
        supplier: "synthetic-command-harness",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    const pass = result.passes.find(
      (p) => p.capabilityId === "command-entrypoints",
    );
    expect(pass).toBeDefined();
    expect(pass?.readiness).toBe("native");
  });

  it("non-command harness with emulated delivery passes the profile", () => {
    // A harness without literal commands (e.g. skill/script/UI delivery)
    // declares emulated — this is the Spec 22 Unit 4 non-OpenCode proof path.
    const contract = withOverride(
      fullPassingContract(),
      "command-entrypoints",
      {
        readiness: "emulated",
        description: "Execution command entrypoints",
        notes:
          "No native command surface; execution is started via an explicit run-workflow skill invocation that the user must trigger deliberately",
        supplier: "synthetic-non-command-harness",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    const pass = result.passes.find(
      (p) => p.capabilityId === "command-entrypoints",
    );
    expect(pass).toBeDefined();
    expect(pass?.readiness).toBe("emulated");
  });

  it("harness with unsupported command-entrypoints fails the profile even if workflow-step-dispatch is native", () => {
    // workflow-step-dispatch is supporting execution context, not an entry point.
    // A harness that can dispatch steps but has no explicit start path still fails.
    let contract = withOverride(fullPassingContract(), "command-entrypoints", {
      readiness: "unsupported",
      description: "Execution command entrypoints",
      notes: "No explicit execution start path available in this harness",
      supplier: "synthetic-no-entry-harness",
    });
    contract = withOverride(contract, "workflow-step-dispatch", {
      readiness: "native",
      description: "Workflow step dispatch",
      notes: "Engine can dispatch steps once execution has started",
      supplier: "synthetic-no-entry-harness",
    });
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    const failure = result.failures.find(
      (f) => f.capabilityId === "command-entrypoints",
    );
    expect(failure).toBeDefined();
    expect(failure?.verdict).toBe("fail");
    // workflow-step-dispatch passes independently — it is supporting context
    const stepDispatchPass = result.passes.find(
      (p) => p.capabilityId === "workflow-step-dispatch",
    );
    expect(stepDispatchPass).toBeDefined();
  });

  it("workflow-step-dispatch readiness is independent of command-entrypoints readiness", () => {
    // Both can be native simultaneously — they model different concerns.
    const contract = fullPassingContract(); // all native
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(true);
    const entryPass = result.passes.find(
      (p) => p.capabilityId === "command-entrypoints",
    );
    const dispatchPass = result.passes.find(
      (p) => p.capabilityId === "workflow-step-dispatch",
    );
    expect(entryPass).toBeDefined();
    expect(dispatchPass).toBeDefined();
    // Both pass independently — neither substitutes for the other.
    expect(entryPass?.capabilityId).toBe("command-entrypoints");
    expect(dispatchPass?.capabilityId).toBe("workflow-step-dispatch");
  });

  it("degraded command-entrypoints fails the profile (incomplete explicit start path)", () => {
    const contract = withOverride(
      fullPassingContract(),
      "command-entrypoints",
      {
        readiness: "degraded",
        description: "Execution command entrypoints",
        notes:
          "Only some workflows are reachable via explicit start; others require manual workarounds",
        blockingImpact:
          "Not all workflows can be started through an explicit user-authorized path",
        supplier: "synthetic-partial-harness",
      },
    );
    const result = evaluateCoreReadinessProfile(contract);
    expect(result.ready).toBe(false);
    const failure = result.failures.find(
      (f) => f.capabilityId === "command-entrypoints",
    );
    expect(failure).toBeDefined();
    expect(failure?.verdict).toBe("fail");
    expect(failure?.readiness).toBe("degraded");
  });
});
