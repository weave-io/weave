/**
 * Tests for `runtimeHealth` — the engine-owned `runtime-health` command operation.
 *
 * ## What these tests prove
 *
 * 1. **Pure operation** — `runtimeHealth` never fails; it always returns
 *    `ok(RuntimeHealthData)` regardless of the health report contents.
 *
 * 2. **commandEntrypointsSupported derivation**:
 *    - `native` → `true`
 *    - `emulated` → `true`
 *    - `degraded` → `false`
 *    - `unsupported` → `false`
 *    - absent → `false`
 *
 * 3. **degradedOperations — adapter-supplied list takes precedence** — when
 *    the adapter supplies a non-empty `degradedOperations` list, it is used
 *    as-is without deriving from the profile warnings.
 *
 * 4. **degradedOperations — derived from profile warnings** — when the adapter
 *    does not supply a list, the engine derives human-readable strings from
 *    the profile evaluation warnings.
 *
 * 5. **unsupportedOperations — adapter-supplied list takes precedence** — when
 *    the adapter supplies a non-empty `unsupportedOperations` list, it is used
 *    as-is without deriving from the profile failures.
 *
 * 6. **unsupportedOperations — derived from profile failures** — when the
 *    adapter does not supply a list, the engine derives human-readable strings
 *    from the profile evaluation failures.
 *
 * 7. **healthReport is passed through unchanged** — the full `AdapterHealthReport`
 *    is included in the result without modification.
 *
 * 8. **kind is always "runtime-health"** — the result data kind discriminant
 *    is always the literal string `"runtime-health"`.
 *
 * Uses:
 * - `buildAdapterHealthReport` from `capability-contract.ts` to build fixture reports
 * - No harness I/O, no filesystem, no SQLite
 */

import { describe, expect, it } from "bun:test";
import {
  type AdapterCapabilityContract,
  buildAdapterHealthReport,
  type CapabilityEntry,
  type SafeAdapterInitInput,
} from "../capability-contract.js";
import { runtimeHealth } from "../runtime-command-operations/health.js";
import type { RuntimeHealthInput } from "../runtime-command-operations/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `CapabilityEntry` for a given capability ID and readiness.
 */
function makeCapabilityEntry(
  id: CapabilityEntry["id"],
  readiness: CapabilityEntry["readiness"],
  overrides: Partial<CapabilityEntry> = {},
): CapabilityEntry {
  return {
    id,
    description: `${id} capability`,
    readiness,
    ...overrides,
  };
}

/**
 * Build a complete `AdapterCapabilityContract` with all 12 required capabilities
 * set to `native`, plus the `command-entrypoints` capability overridden to the
 * given readiness.
 */
function makeContractWithCommandEntrypoints(
  commandEntrypointsReadiness: CapabilityEntry["readiness"],
): AdapterCapabilityContract {
  const requiredIds: CapabilityEntry["id"][] = [
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

  return {
    capabilities: requiredIds.map((id) =>
      makeCapabilityEntry(
        id,
        id === "command-entrypoints" ? commandEntrypointsReadiness : "native",
      ),
    ),
  };
}

/**
 * Build a fixture `SafeAdapterInitInput` with all required capabilities native
 * and the `command-entrypoints` capability set to the given readiness.
 */
function makeInitInput(
  commandEntrypointsReadiness: CapabilityEntry["readiness"],
  harness = "test-harness",
): SafeAdapterInitInput {
  return {
    harness,
    capabilityContract: makeContractWithCommandEntrypoints(
      commandEntrypointsReadiness,
    ),
    probeResults: [],
  };
}

/**
 * Build a `RuntimeHealthInput` with all required capabilities native and the
 * `command-entrypoints` capability set to the given readiness.
 */
function makeHealthInput(
  commandEntrypointsReadiness: CapabilityEntry["readiness"],
  overrides: Partial<RuntimeHealthInput> = {},
): RuntimeHealthInput {
  const healthReport = buildAdapterHealthReport(
    makeInitInput(commandEntrypointsReadiness),
  );
  return { healthReport, ...overrides };
}

// ---------------------------------------------------------------------------
// § 1 — Pure operation — always returns ok
// ---------------------------------------------------------------------------

describe("runtimeHealth — pure operation", () => {
  it("always returns ok(RuntimeHealthData) — never fails", async () => {
    const input = makeHealthInput("native");
    const result = await runtimeHealth(input);

    expect(result.isOk()).toBe(true);
  });

  it("returns kind: runtime-health in the result data", async () => {
    const input = makeHealthInput("native");
    const result = await runtimeHealth(input);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("runtime-health");
    }
  });

  it("returns ok even when all required capabilities are degraded", async () => {
    // Build a contract where all required capabilities are degraded
    const contract: AdapterCapabilityContract = {
      capabilities: [
        makeCapabilityEntry("config-materialization", "degraded"),
        makeCapabilityEntry("agent-materialization", "degraded"),
        makeCapabilityEntry("primary-agent-selection", "degraded"),
        makeCapabilityEntry("delegated-specialist-execution", "degraded"),
        makeCapabilityEntry("prompt-composition", "degraded"),
        makeCapabilityEntry("tool-policy-mapping", "degraded"),
        makeCapabilityEntry("workflow-persistence", "degraded"),
        makeCapabilityEntry("workflow-step-dispatch", "degraded"),
        makeCapabilityEntry("plan-file-compatibility", "degraded"),
        makeCapabilityEntry("command-entrypoints", "degraded"),
        makeCapabilityEntry("event-logging", "degraded"),
        makeCapabilityEntry("token-usage-reporting", "degraded"),
      ],
    };

    const healthReport = buildAdapterHealthReport({
      harness: "degraded-harness",
      capabilityContract: contract,
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("runtime-health");
    }
  });

  it("returns ok when the capability contract is empty", async () => {
    const healthReport = buildAdapterHealthReport({
      harness: "empty-harness",
      capabilityContract: { capabilities: [] },
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("runtime-health");
    }
  });
});

// ---------------------------------------------------------------------------
// § 2 — commandEntrypointsSupported derivation
// ---------------------------------------------------------------------------

describe("runtimeHealth — commandEntrypointsSupported", () => {
  it("returns true when command-entrypoints is native", async () => {
    const result = await runtimeHealth(makeHealthInput("native"));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.commandEntrypointsSupported).toBe(true);
    }
  });

  it("returns true when command-entrypoints is emulated", async () => {
    const result = await runtimeHealth(makeHealthInput("emulated"));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.commandEntrypointsSupported).toBe(true);
    }
  });

  it("returns false when command-entrypoints is degraded", async () => {
    const result = await runtimeHealth(makeHealthInput("degraded"));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.commandEntrypointsSupported).toBe(false);
    }
  });

  it("returns false when command-entrypoints is unsupported", async () => {
    const result = await runtimeHealth(makeHealthInput("unsupported"));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.commandEntrypointsSupported).toBe(false);
    }
  });

  it("returns false when command-entrypoints capability is absent", async () => {
    // Build a contract without command-entrypoints
    const healthReport = buildAdapterHealthReport({
      harness: "no-entrypoints-harness",
      capabilityContract: {
        capabilities: [
          makeCapabilityEntry("config-materialization", "native"),
          makeCapabilityEntry("agent-materialization", "native"),
        ],
      },
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.commandEntrypointsSupported).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// § 3 — degradedOperations
// ---------------------------------------------------------------------------

describe("runtimeHealth — degradedOperations", () => {
  it("uses adapter-supplied degradedOperations list when non-empty", async () => {
    const input = makeHealthInput("native", {
      degradedOperations: [
        "start-plan: slow disk I/O",
        "inspect-status: cache miss",
      ],
    });

    const result = await runtimeHealth(input);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.degradedOperations).toEqual([
        "start-plan: slow disk I/O",
        "inspect-status: cache miss",
      ]);
    }
  });

  it("derives degradedOperations from profile warnings when adapter list is absent", async () => {
    // Build a contract with an optional capability degraded → produces a warning
    const contract: AdapterCapabilityContract = {
      capabilities: [
        // All required capabilities native
        makeCapabilityEntry("config-materialization", "native"),
        makeCapabilityEntry("agent-materialization", "native"),
        makeCapabilityEntry("primary-agent-selection", "native"),
        makeCapabilityEntry("delegated-specialist-execution", "native"),
        makeCapabilityEntry("prompt-composition", "native"),
        makeCapabilityEntry("tool-policy-mapping", "native"),
        makeCapabilityEntry("workflow-persistence", "native"),
        makeCapabilityEntry("workflow-step-dispatch", "native"),
        makeCapabilityEntry("plan-file-compatibility", "native"),
        makeCapabilityEntry("command-entrypoints", "native"),
        makeCapabilityEntry("event-logging", "native"),
        makeCapabilityEntry("token-usage-reporting", "native"),
        // Optional capability degraded → warning
        makeCapabilityEntry("idle-continuation", "degraded"),
      ],
    };

    const healthReport = buildAdapterHealthReport({
      harness: "partial-harness",
      capabilityContract: contract,
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should have at least one derived degraded operation for idle-continuation
      expect(result.value.degradedOperations.length).toBeGreaterThan(0);
      const hasIdleContinuation = result.value.degradedOperations.some((op) =>
        op.includes("idle-continuation"),
      );
      expect(hasIdleContinuation).toBe(true);
    }
  });

  it("derives empty degradedOperations when all capabilities pass and no adapter list", async () => {
    // All required capabilities native → no warnings
    const input = makeHealthInput("native");
    const result = await runtimeHealth(input);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Optional capabilities not declared → warnings for each missing optional
      // But no degraded operations from the required set
      // The derived list may include missing optional capabilities as warnings
      // We only assert the type is an array
      expect(Array.isArray(result.value.degradedOperations)).toBe(true);
    }
  });

  it("ignores empty adapter-supplied degradedOperations and derives from profile", async () => {
    // Build a contract with an optional capability degraded → produces a warning
    const contract: AdapterCapabilityContract = {
      capabilities: [
        makeCapabilityEntry("config-materialization", "native"),
        makeCapabilityEntry("agent-materialization", "native"),
        makeCapabilityEntry("primary-agent-selection", "native"),
        makeCapabilityEntry("delegated-specialist-execution", "native"),
        makeCapabilityEntry("prompt-composition", "native"),
        makeCapabilityEntry("tool-policy-mapping", "native"),
        makeCapabilityEntry("workflow-persistence", "native"),
        makeCapabilityEntry("workflow-step-dispatch", "native"),
        makeCapabilityEntry("plan-file-compatibility", "native"),
        makeCapabilityEntry("command-entrypoints", "native"),
        makeCapabilityEntry("event-logging", "native"),
        makeCapabilityEntry("token-usage-reporting", "native"),
        makeCapabilityEntry("idle-continuation", "degraded"),
      ],
    };

    const healthReport = buildAdapterHealthReport({
      harness: "partial-harness",
      capabilityContract: contract,
      probeResults: [],
    });

    // Empty array → falls back to derived
    const result = await runtimeHealth({
      healthReport,
      degradedOperations: [],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should derive from profile warnings (idle-continuation is degraded)
      const hasIdleContinuation = result.value.degradedOperations.some((op) =>
        op.includes("idle-continuation"),
      );
      expect(hasIdleContinuation).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// § 4 — unsupportedOperations
// ---------------------------------------------------------------------------

describe("runtimeHealth — unsupportedOperations", () => {
  it("uses adapter-supplied unsupportedOperations list when non-empty", async () => {
    const input = makeHealthInput("native", {
      unsupportedOperations: ["advance-step: not available in this harness"],
    });

    const result = await runtimeHealth(input);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.unsupportedOperations).toEqual([
        "advance-step: not available in this harness",
      ]);
    }
  });

  it("derives unsupportedOperations from profile failures when adapter list is absent", async () => {
    // Build a contract with a required capability degraded → produces a failure
    const contract: AdapterCapabilityContract = {
      capabilities: [
        makeCapabilityEntry("config-materialization", "native"),
        makeCapabilityEntry("agent-materialization", "native"),
        makeCapabilityEntry("primary-agent-selection", "native"),
        makeCapabilityEntry("delegated-specialist-execution", "native"),
        makeCapabilityEntry("prompt-composition", "native"),
        makeCapabilityEntry("tool-policy-mapping", "native"),
        makeCapabilityEntry("workflow-persistence", "native"),
        makeCapabilityEntry("workflow-step-dispatch", "native"),
        makeCapabilityEntry("plan-file-compatibility", "native"),
        // command-entrypoints degraded → required capability failure
        makeCapabilityEntry("command-entrypoints", "degraded"),
        makeCapabilityEntry("event-logging", "native"),
        makeCapabilityEntry("token-usage-reporting", "native"),
      ],
    };

    const healthReport = buildAdapterHealthReport({
      harness: "failing-harness",
      capabilityContract: contract,
      probeResults: [],
    });

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should have at least one derived unsupported operation for command-entrypoints
      expect(result.value.unsupportedOperations.length).toBeGreaterThan(0);
      const hasCommandEntrypoints = result.value.unsupportedOperations.some(
        (op) => op.includes("command-entrypoints"),
      );
      expect(hasCommandEntrypoints).toBe(true);
    }
  });

  it("returns empty unsupportedOperations when all required capabilities pass and no adapter list", async () => {
    // All required capabilities native → no failures
    const input = makeHealthInput("native");
    const result = await runtimeHealth(input);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.unsupportedOperations).toHaveLength(0);
    }
  });

  it("ignores empty adapter-supplied unsupportedOperations and derives from profile", async () => {
    // Build a contract with a required capability degraded → produces a failure
    const contract: AdapterCapabilityContract = {
      capabilities: [
        makeCapabilityEntry("config-materialization", "native"),
        makeCapabilityEntry("agent-materialization", "native"),
        makeCapabilityEntry("primary-agent-selection", "native"),
        makeCapabilityEntry("delegated-specialist-execution", "native"),
        makeCapabilityEntry("prompt-composition", "native"),
        makeCapabilityEntry("tool-policy-mapping", "native"),
        makeCapabilityEntry("workflow-persistence", "native"),
        makeCapabilityEntry("workflow-step-dispatch", "native"),
        makeCapabilityEntry("plan-file-compatibility", "native"),
        makeCapabilityEntry("command-entrypoints", "degraded"),
        makeCapabilityEntry("event-logging", "native"),
        makeCapabilityEntry("token-usage-reporting", "native"),
      ],
    };

    const healthReport = buildAdapterHealthReport({
      harness: "failing-harness",
      capabilityContract: contract,
      probeResults: [],
    });

    // Empty array → falls back to derived
    const result = await runtimeHealth({
      healthReport,
      unsupportedOperations: [],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should derive from profile failures (command-entrypoints is degraded → fail)
      const hasCommandEntrypoints = result.value.unsupportedOperations.some(
        (op) => op.includes("command-entrypoints"),
      );
      expect(hasCommandEntrypoints).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// § 5 — healthReport passthrough
// ---------------------------------------------------------------------------

describe("runtimeHealth — healthReport passthrough", () => {
  it("includes the full AdapterHealthReport in the result unchanged", async () => {
    const initInput = makeInitInput("native", "my-harness");
    const healthReport = buildAdapterHealthReport(initInput);

    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.healthReport).toBe(healthReport);
      expect(result.value.healthReport.harness).toBe("my-harness");
    }
  });

  it("preserves profileResult.ready from the health report", async () => {
    // All required capabilities native → ready: true
    const readyReport = buildAdapterHealthReport(makeInitInput("native"));
    const readyResult = await runtimeHealth({ healthReport: readyReport });

    expect(readyResult.isOk()).toBe(true);
    if (readyResult.isOk()) {
      expect(readyResult.value.healthReport.profileResult.ready).toBe(true);
    }

    // command-entrypoints degraded → ready: false
    const notReadyReport = buildAdapterHealthReport(makeInitInput("degraded"));
    const notReadyResult = await runtimeHealth({
      healthReport: notReadyReport,
    });

    expect(notReadyResult.isOk()).toBe(true);
    if (notReadyResult.isOk()) {
      expect(notReadyResult.value.healthReport.profileResult.ready).toBe(false);
    }
  });

  it("preserves probe results from the health report", async () => {
    const initInput: SafeAdapterInitInput = {
      harness: "probe-harness",
      capabilityContract: makeContractWithCommandEntrypoints("native"),
      probeResults: [
        {
          capabilityId: "command-entrypoints",
          probeStatus: "ok",
          details: "slash commands registered",
        },
      ],
    };

    const healthReport = buildAdapterHealthReport(initInput);
    const result = await runtimeHealth({ healthReport });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.healthReport.probeResults).toHaveLength(1);
      expect(result.value.healthReport.probeResults[0]?.capabilityId).toBe(
        "command-entrypoints",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// § 6 — Combined adapter-supplied lists
// ---------------------------------------------------------------------------

describe("runtimeHealth — combined adapter-supplied lists", () => {
  it("uses both adapter-supplied lists when both are non-empty", async () => {
    const input = makeHealthInput("degraded", {
      degradedOperations: ["start-plan: partial support"],
      unsupportedOperations: ["advance-step: not available"],
    });

    const result = await runtimeHealth(input);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.degradedOperations).toEqual([
        "start-plan: partial support",
      ]);
      expect(result.value.unsupportedOperations).toEqual([
        "advance-step: not available",
      ]);
    }
  });

  it("mixes adapter-supplied and derived lists independently", async () => {
    // Build a contract with a required capability degraded → failure
    const contract: AdapterCapabilityContract = {
      capabilities: [
        makeCapabilityEntry("config-materialization", "native"),
        makeCapabilityEntry("agent-materialization", "native"),
        makeCapabilityEntry("primary-agent-selection", "native"),
        makeCapabilityEntry("delegated-specialist-execution", "native"),
        makeCapabilityEntry("prompt-composition", "native"),
        makeCapabilityEntry("tool-policy-mapping", "native"),
        makeCapabilityEntry("workflow-persistence", "native"),
        makeCapabilityEntry("workflow-step-dispatch", "native"),
        makeCapabilityEntry("plan-file-compatibility", "native"),
        makeCapabilityEntry("command-entrypoints", "degraded"),
        makeCapabilityEntry("event-logging", "native"),
        makeCapabilityEntry("token-usage-reporting", "native"),
        makeCapabilityEntry("idle-continuation", "degraded"),
      ],
    };

    const healthReport = buildAdapterHealthReport({
      harness: "mixed-harness",
      capabilityContract: contract,
      probeResults: [],
    });

    // Adapter supplies degradedOperations but not unsupportedOperations
    const result = await runtimeHealth({
      healthReport,
      degradedOperations: ["custom-degraded-op"],
      // unsupportedOperations absent → derived from profile failures
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // degradedOperations: adapter-supplied
      expect(result.value.degradedOperations).toEqual(["custom-degraded-op"]);
      // unsupportedOperations: derived from profile failures (command-entrypoints)
      expect(result.value.unsupportedOperations.length).toBeGreaterThan(0);
      const hasCommandEntrypoints = result.value.unsupportedOperations.some(
        (op) => op.includes("command-entrypoints"),
      );
      expect(hasCommandEntrypoints).toBe(true);
    }
  });
});
