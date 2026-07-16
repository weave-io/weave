/**
 * Tests for renderer-ready readiness report structures (Task 4.0).
 *
 * Covers:
 * - buildHumanRows: all pass → all PASS status.
 * - buildHumanRows: mixed report → correct FAIL/WARN rows.
 * - buildToonRows: deterministic (same input = same output).
 * - toJson: returns parseable JSON containing profile result.
 * - Deterministic order: required capabilities first, then optional.
 * - No probe re-execution (pure functions).
 * - JSON is machine-readable interchange; TOON is LLM-oriented compact.
 * - Human output is for CLI display.
 * - No harness secrets in renderer output.
 *
 * Note on renderer location:
 * - Engine owns normalized report/result structures and deterministic data
 *   contracts (buildHumanRows, buildToonRows, toJson).
 * - CLI owns concrete terminal presentation when full commands are implemented.
 * - No harness secrets in renderer output.
 */

import { describe, expect, it } from "bun:test";
import type {
  AdapterCapabilityContract,
  CapabilityId,
  SafeAdapterInitInput,
} from "../capability-contract.js";
import {
  ALL_CAPABILITY_IDS,
  buildAdapterHealthReport,
  buildHumanRows,
  buildToonRows,
  OPTIONAL_CAPABILITIES,
  REQUIRED_CAPABILITIES,
  toJson,
} from "../capability-contract.js";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function buildNotes(isRequired: boolean, isOptional: boolean): string {
  if (isRequired) return "Synthetic: required capability native";
  if (isOptional) return "Synthetic: optional capability native";
  return "Synthetic: native";
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function syntheticPassingContract(): AdapterCapabilityContract {
  return {
    capabilities: ALL_CAPABILITY_IDS.map((id) => ({
      id,
      description: `Synthetic display: ${id}`,
      readiness: "native" as const,
      supplier: "synthetic-adapter",
      notes: "Synthetic: native support",
      blockingImpact: undefined,
      remediationHint: undefined,
    })),
  };
}

function syntheticMixedContract(): AdapterCapabilityContract {
  return {
    capabilities: ALL_CAPABILITY_IDS.map((id) => {
      const isRequired = (
        REQUIRED_CAPABILITIES as readonly CapabilityId[]
      ).includes(id);
      const isOptional = (
        OPTIONAL_CAPABILITIES as readonly CapabilityId[]
      ).includes(id);

      // Degrade one required capability
      if (id === "workflow-persistence") {
        return {
          id,
          description: "Synthetic display: workflow-persistence",
          readiness: "degraded" as const,
          supplier: "synthetic-adapter",
          blockingImpact: "Synthetic: workflow state may be lost",
          remediationHint: "Upgrade synthetic-adapter to v2",
        };
      }

      // Make one optional capability unsupported
      if (id === "analytics-dashboard") {
        return {
          id,
          description: "Synthetic display: analytics-dashboard",
          readiness: "unsupported" as const,
          supplier: "synthetic-adapter",
          notes: "Synthetic: analytics not available in this harness version",
        };
      }

      return {
        id,
        description: `Synthetic display: ${id}`,
        readiness: "native" as const,
        supplier: "synthetic-adapter",
        notes: buildNotes(isRequired, isOptional),
      };
    }),
  };
}

function buildPassingReport() {
  const input: SafeAdapterInitInput = {
    harness: "synthetic-adapter",
    capabilityContract: syntheticPassingContract(),
    probeResults: [],
  };
  return buildAdapterHealthReport(input);
}

function buildMixedReport() {
  const input: SafeAdapterInitInput = {
    harness: "synthetic-adapter",
    capabilityContract: syntheticMixedContract(),
    probeResults: [],
  };
  return buildAdapterHealthReport(input);
}

// ---------------------------------------------------------------------------
// § 1 — buildHumanRows: all pass
// ---------------------------------------------------------------------------

describe("buildHumanRows: all pass", () => {
  it("returns 20 rows when all capabilities are declared", () => {
    const report = buildPassingReport();
    const rows = buildHumanRows(report);
    expect(rows).toHaveLength(ALL_CAPABILITY_IDS.length);
  });

  it("all rows have PASS status when all capabilities are native", () => {
    const report = buildPassingReport();
    const rows = buildHumanRows(report);
    for (const row of rows) {
      expect(row.status).toBe("PASS");
    }
  });

  it("all rows have native readiness when all capabilities are native", () => {
    const report = buildPassingReport();
    const rows = buildHumanRows(report);
    for (const row of rows) {
      expect(row.readiness).toBe("native");
    }
  });

  it("rows include capability display names", () => {
    const report = buildPassingReport();
    const rows = buildHumanRows(report);
    for (const row of rows) {
      expect(typeof row.capability).toBe("string");
      expect(row.capability.length).toBeGreaterThan(0);
    }
  });

  it("rows include notes", () => {
    const report = buildPassingReport();
    const rows = buildHumanRows(report);
    for (const row of rows) {
      expect(typeof row.notes).toBe("string");
      expect(row.notes.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// § 2 — buildHumanRows: mixed report
// ---------------------------------------------------------------------------

describe("buildHumanRows: mixed report", () => {
  it("produces a FAIL row for the degraded required capability", () => {
    const report = buildMixedReport();
    const rows = buildHumanRows(report);
    const failRow = rows.find((r) => r.readiness === "degraded");
    expect(failRow).toBeDefined();
    expect(failRow?.status).toBe("FAIL");
  });

  it("produces a WARN row for the unsupported optional capability", () => {
    const report = buildMixedReport();
    const rows = buildHumanRows(report);
    const warnRow = rows.find(
      (r) => r.capability === "Synthetic display: analytics-dashboard",
    );
    expect(warnRow).toBeDefined();
    expect(warnRow?.status).toBe("WARN");
    expect(warnRow?.readiness).toBe("unsupported");
  });

  it("produces PASS rows for all other capabilities", () => {
    const report = buildMixedReport();
    const rows = buildHumanRows(report);
    const passRows = rows.filter((r) => r.status === "PASS");
    // total - 1 FAIL - 1 WARN = rest PASS
    expect(passRows).toHaveLength(ALL_CAPABILITY_IDS.length - 2);
  });

  it("FAIL row for workflow-persistence includes blocking impact in notes", () => {
    const report = buildMixedReport();
    const rows = buildHumanRows(report);
    const failRow = rows.find(
      (r) => r.capability === "Synthetic display: workflow-persistence",
    );
    expect(failRow?.notes).toContain("Synthetic: workflow state may be lost");
  });
});

// ---------------------------------------------------------------------------
// § 3 — buildHumanRows: deterministic order
// ---------------------------------------------------------------------------

describe("buildHumanRows: deterministic order", () => {
  it("required capabilities appear before optional capabilities", () => {
    const report = buildPassingReport();
    const rows = buildHumanRows(report);

    // Find the last required capability row index
    const lastRequiredIdx = rows.reduce((maxIdx, row, idx) => {
      const isRequired = REQUIRED_CAPABILITIES.some(
        (id) => `Synthetic display: ${id}` === row.capability,
      );
      return isRequired ? idx : maxIdx;
    }, -1);

    // Find the first optional capability row index
    const firstOptionalIdx = rows.findIndex((row) =>
      OPTIONAL_CAPABILITIES.some(
        (id) => `Synthetic display: ${id}` === row.capability,
      ),
    );

    expect(lastRequiredIdx).toBeLessThan(firstOptionalIdx);
  });

  it("same input produces same row order on repeated calls", () => {
    const report = buildPassingReport();
    const rows1 = buildHumanRows(report);
    const rows2 = buildHumanRows(report);

    expect(rows1.map((r) => r.capability)).toEqual(
      rows2.map((r) => r.capability),
    );
  });
});

// ---------------------------------------------------------------------------
// § 4 — buildToonRows: deterministic
// ---------------------------------------------------------------------------

describe("buildToonRows: deterministic", () => {
  it("returns 20 rows when all capabilities are declared", () => {
    const report = buildPassingReport();
    const rows = buildToonRows(report);
    expect(rows).toHaveLength(ALL_CAPABILITY_IDS.length);
  });

  it("all rows have P verdict when all capabilities pass", () => {
    const report = buildPassingReport();
    const rows = buildToonRows(report);
    for (const row of rows) {
      expect(row.v).toBe("P");
    }
  });

  it("same input produces identical TOON output on repeated calls", () => {
    const report = buildPassingReport();
    const rows1 = buildToonRows(report);
    const rows2 = buildToonRows(report);

    expect(JSON.stringify(rows1)).toBe(JSON.stringify(rows2));
  });

  it("TOON rows have compact keys: id, v, r", () => {
    const report = buildPassingReport();
    const rows = buildToonRows(report);
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(["P", "F", "W"]).toContain(row.v);
      expect(typeof row.r).toBe("string");
    }
  });

  it("mixed report produces F verdict for degraded required capability", () => {
    const report = buildMixedReport();
    const rows = buildToonRows(report);
    const failRow = rows.find((r) => r.id === "workflow-persistence");
    expect(failRow?.v).toBe("F");
    expect(failRow?.r).toBe("degraded");
  });

  it("mixed report produces W verdict for unsupported optional capability", () => {
    const report = buildMixedReport();
    const rows = buildToonRows(report);
    const warnRow = rows.find((r) => r.id === "analytics-dashboard");
    expect(warnRow?.v).toBe("W");
    expect(warnRow?.r).toBe("unsupported");
  });

  it("TOON rows follow same deterministic order as human rows", () => {
    const report = buildPassingReport();
    const humanRows = buildHumanRows(report);
    const toonRows = buildToonRows(report);

    // Both should have same row count in the same capability order
    expect(toonRows).toHaveLength(humanRows.length);
    for (let i = 0; i < toonRows.length; i++) {
      const toon = toonRows[i];
      const human = humanRows[i];
      if (toon !== undefined && human !== undefined) {
        // TOON id should match the capability ID embedded in the human display name
        expect(human.capability).toContain(toon.id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// § 5 — toJson: machine-readable interchange
// ---------------------------------------------------------------------------

describe("toJson: machine-readable interchange", () => {
  it("returns a parseable JSON string", () => {
    const report = buildPassingReport();
    const json = toJson(report);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("parsed JSON contains profileResult", () => {
    const report = buildPassingReport();
    const json = toJson(report);
    const parsed = JSON.parse(json) as typeof report;
    expect(parsed.profileResult).toBeDefined();
    expect(typeof parsed.profileResult.ready).toBe("boolean");
  });

  it("parsed JSON contains harness name", () => {
    const report = buildPassingReport();
    const json = toJson(report);
    const parsed = JSON.parse(json) as typeof report;
    expect(parsed.harness).toBe("synthetic-adapter");
  });

  it("parsed JSON contains timestamp", () => {
    const report = buildPassingReport();
    const json = toJson(report);
    const parsed = JSON.parse(json) as typeof report;
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.timestamp.length).toBeGreaterThan(0);
  });

  it("parsed JSON contains capability contract", () => {
    const report = buildPassingReport();
    const json = toJson(report);
    const parsed = JSON.parse(json) as typeof report;
    expect(Array.isArray(parsed.capabilityContract.capabilities)).toBe(true);
    expect(parsed.capabilityContract.capabilities).toHaveLength(ALL_CAPABILITY_IDS.length);
  });

  it("parsed JSON contains probe results", () => {
    const report = buildPassingReport();
    const json = toJson(report);
    const parsed = JSON.parse(json) as typeof report;
    expect(Array.isArray(parsed.probeResults)).toBe(true);
  });

  it("JSON output is formatted with 2-space indentation", () => {
    const report = buildPassingReport();
    const json = toJson(report);
    // JSON.stringify with null, 2 produces 2-space indented output
    expect(json).toContain("  ");
    expect(json.split("\n").length).toBeGreaterThan(1);
  });

  it("mixed report JSON contains failures and warnings", () => {
    const report = buildMixedReport();
    const json = toJson(report);
    const parsed = JSON.parse(json) as typeof report;
    expect(parsed.profileResult.ready).toBe(false);
    expect(parsed.profileResult.failures.length).toBeGreaterThan(0);
    expect(parsed.profileResult.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// § 6 — No probe re-execution
// ---------------------------------------------------------------------------

describe("renderer functions: no probe re-execution", () => {
  it("buildHumanRows does not modify the report", () => {
    const report = buildPassingReport();
    const originalReady = report.profileResult.ready;
    const originalPassCount = report.profileResult.passes.length;

    buildHumanRows(report);

    // Report is unchanged after calling buildHumanRows
    expect(report.profileResult.ready).toBe(originalReady);
    expect(report.profileResult.passes).toHaveLength(originalPassCount);
  });

  it("buildToonRows does not modify the report", () => {
    const report = buildPassingReport();
    const originalReady = report.profileResult.ready;

    buildToonRows(report);

    expect(report.profileResult.ready).toBe(originalReady);
  });

  it("toJson does not modify the report", () => {
    const report = buildPassingReport();
    const originalHarness = report.harness;

    toJson(report);

    expect(report.harness).toBe(originalHarness);
  });
});

// ---------------------------------------------------------------------------
// § 7 — Sanitization proof
// ---------------------------------------------------------------------------

describe("sanitization: no credentials or secrets in renderer output", () => {
  it("human rows contain no credentials or local paths", () => {
    const report = buildMixedReport();
    const rows = buildHumanRows(report);
    const serialized = JSON.stringify(rows);

    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("/home/");
  });

  it("TOON rows contain no credentials or local paths", () => {
    const report = buildMixedReport();
    const rows = buildToonRows(report);
    const serialized = JSON.stringify(rows);

    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("/Users/");
  });

  it("JSON output contains no credentials or local paths", () => {
    const report = buildMixedReport();
    const json = toJson(report);

    expect(json).not.toContain("password");
    expect(json).not.toContain("api_key");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("/Users/");
  });
});

// ---------------------------------------------------------------------------
// § 8 — Token-usage applicability example
// ---------------------------------------------------------------------------

describe("token-usage-reporting applicability in renderer output", () => {
  it("token-usage-reporting with documented unsupported reason appears as WARN in human rows", () => {
    const contract: AdapterCapabilityContract = {
      capabilities: ALL_CAPABILITY_IDS.map((id) => {
        if (id === "token-usage-reporting") {
          return {
            id,
            description: "Token usage reporting",
            readiness: "unsupported" as const,
            supplier: "synthetic-adapter",
            notes: "Synthetic: harness does not expose token usage data",
          };
        }
        return {
          id,
          description: `Synthetic display: ${id}`,
          readiness: "native" as const,
          supplier: "synthetic-adapter",
        };
      }),
    };

    const input: SafeAdapterInitInput = {
      harness: "synthetic-adapter",
      capabilityContract: contract,
      probeResults: [],
    };

    const report = buildAdapterHealthReport(input);
    const rows = buildHumanRows(report);
    const tokenRow = rows.find((r) => r.capability === "Token usage reporting");

    expect(tokenRow).toBeDefined();
    expect(tokenRow?.status).toBe("WARN");
    expect(tokenRow?.readiness).toBe("unsupported");

    // Report should still be ready (token-usage downgraded to warning)
    expect(report.profileResult.ready).toBe(true);
  });
});
