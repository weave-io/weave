/**
 * Runtime Health — engine-owned command operation.
 *
 * Implements the `runtime-health` command operation: accepts explicit
 * adapter-supplied health inputs and returns a normalized `RuntimeHealthData`
 * result. This operation is **pure** — it performs no harness I/O, scans no
 * directories, registers no hooks, and mutates no state.
 *
 * ## Design constraints
 *
 * - No OpenCode imports, concrete command names, concrete tool names, or
 *   harness plugin APIs appear in this module.
 * - All fallible operations return `ResultAsync<T, E>` from neverthrow.
 * - The operation is pure: adapters build the `AdapterHealthReport` via
 *   `buildAdapterHealthReport` before calling this function. The engine
 *   never performs harness-specific probes or capability checks itself.
 * - `commandEntrypointsSupported` is derived from the `command-entrypoints`
 *   capability in the health report: `native` or `emulated` → true;
 *   `degraded` or `unsupported` → false.
 * - `degradedOperations` and `unsupportedOperations` are accepted as explicit
 *   adapter-supplied lists. If absent, the engine derives them from the
 *   profile evaluation failures and warnings in the health report.
 *
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 * @see docs/adapter-boundary.md
 * @see packages/engine/src/capability-contract.ts — AdapterHealthReport, buildAdapterHealthReport
 * @see packages/engine/src/runtime-command-operations/types.ts
 */

import { okAsync } from "neverthrow";
import { logger } from "../logger.js";
import type {
  CommandOperationError,
  RuntimeHealthData,
  RuntimeHealthInput,
  RuntimeHealthResult,
} from "./types.js";

const log = logger.child({ module: "runtime-health" });

// ---------------------------------------------------------------------------
// § 1 — deriveCommandEntrypointsSupported — pure helper
// ---------------------------------------------------------------------------

/**
 * Derive whether the `command-entrypoints` capability is satisfied from the
 * adapter health report.
 *
 * Returns `true` when the capability is declared `native` or `emulated`;
 * `false` when it is `degraded`, `unsupported`, or absent.
 *
 * This function is pure and performs no harness I/O.
 */
function deriveCommandEntrypointsSupported(input: RuntimeHealthInput): boolean {
  const entry = input.healthReport.capabilityContract.capabilities.find(
    (c) => c.id === "command-entrypoints",
  );

  if (entry === undefined) return false;
  return entry.readiness === "native" || entry.readiness === "emulated";
}

// ---------------------------------------------------------------------------
// § 2 — deriveDegradedOperations — pure helper
// ---------------------------------------------------------------------------

/**
 * Derive the list of degraded operations from the adapter health report.
 *
 * When the adapter supplies an explicit `degradedOperations` list, that list
 * is returned as-is. Otherwise, the engine derives the list from the profile
 * evaluation warnings in the health report.
 *
 * This function is pure and performs no harness I/O.
 */
function deriveDegradedOperations(
  input: RuntimeHealthInput,
): readonly string[] {
  if (
    input.degradedOperations !== undefined &&
    input.degradedOperations.length > 0
  ) {
    return input.degradedOperations;
  }

  return input.healthReport.profileResult.warnings.map(
    (w) => `${w.capabilityId} (${w.readiness}): ${w.reason}`,
  );
}

// ---------------------------------------------------------------------------
// § 3 — deriveUnsupportedOperations — pure helper
// ---------------------------------------------------------------------------

/**
 * Derive the list of unsupported operations from the adapter health report.
 *
 * When the adapter supplies an explicit `unsupportedOperations` list, that
 * list is returned as-is. Otherwise, the engine derives the list from the
 * profile evaluation failures in the health report.
 *
 * This function is pure and performs no harness I/O.
 */
function deriveUnsupportedOperations(
  input: RuntimeHealthInput,
): readonly string[] {
  if (
    input.unsupportedOperations !== undefined &&
    input.unsupportedOperations.length > 0
  ) {
    return input.unsupportedOperations;
  }

  return input.healthReport.profileResult.failures.map(
    (f) => `${f.capabilityId} (${f.readiness}): ${f.reason}`,
  );
}

// ---------------------------------------------------------------------------
// § 4 — runtimeHealth — command operation entry point
// ---------------------------------------------------------------------------

/**
 * Report adapter readiness, command-entrypoint support, and degraded/unsupported
 * operation details as a normalized `RuntimeHealthData` result.
 *
 * This is the **engine-owned `runtime-health` command operation**. It accepts
 * explicit adapter-supplied health inputs and returns a normalized health
 * report without performing any harness I/O. Adapters build the
 * `AdapterHealthReport` via `buildAdapterHealthReport` before calling this
 * function.
 *
 * ## Derivation rules
 *
 * - `commandEntrypointsSupported`: derived from the `command-entrypoints`
 *   capability in the health report. `native` or `emulated` → `true`;
 *   `degraded`, `unsupported`, or absent → `false`.
 *
 * - `degradedOperations`: if the adapter supplies a non-empty
 *   `degradedOperations` list, it is used as-is. Otherwise, the engine
 *   derives human-readable strings from the profile evaluation warnings.
 *
 * - `unsupportedOperations`: if the adapter supplies a non-empty
 *   `unsupportedOperations` list, it is used as-is. Otherwise, the engine
 *   derives human-readable strings from the profile evaluation failures.
 *
 * ## Sanitization
 *
 * The operation never includes credentials, API keys, local paths beyond
 * workspace-relative references, or harness config contents in the result.
 * Adapters are responsible for sanitizing `runtimeStatus` and `details`
 * fields in the health report before passing it to this function.
 *
 * @param input - Runtime health operation parameters (adapter-supplied).
 * @returns `ok(RuntimeHealthData)` — this operation never fails.
 */
export function runtimeHealth(input: RuntimeHealthInput): RuntimeHealthResult {
  const commandEntrypointsSupported = deriveCommandEntrypointsSupported(input);
  const degradedOperations = deriveDegradedOperations(input);
  const unsupportedOperations = deriveUnsupportedOperations(input);

  log.info(
    {
      harness: input.healthReport.harness,
      ready: input.healthReport.profileResult.ready,
      commandEntrypointsSupported,
      degradedCount: degradedOperations.length,
      unsupportedCount: unsupportedOperations.length,
    },
    "runtime-health operation completed",
  );

  const result: RuntimeHealthData = {
    kind: "runtime-health",
    healthReport: input.healthReport,
    commandEntrypointsSupported,
    degradedOperations,
    unsupportedOperations,
  };

  return okAsync<RuntimeHealthData, CommandOperationError>(result);
}
