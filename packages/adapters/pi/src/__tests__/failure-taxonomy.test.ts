import { describe, expect, it } from "bun:test";
import {
  PiAdapterFailureCodeSchema,
  PiAdapterFailureImpactSchema,
  PiAdapterFailureRecoverySchema,
} from "../errors.js";

/**
 * Schema-lock proof for the Pi adapter's closed failure contract (Spec 33
 * §23). PI-ERR's acceptance-manifest closed set asserts that every one of
 * these code/impact/recovery literals appears somewhere in this file's text,
 * so any code silently added to or removed from `PiAdapterFailureCodeSchema`
 * (or the impact/recovery enums) without updating this frozen list fails
 * here first, before the release-gate evidence validator ever runs.
 *
 * This intentionally proves *closed-set exhaustiveness* (every declared
 * code/impact/recovery is accounted for), not that every code has a
 * dedicated behavioral fail-closed test — that per-code behavioral coverage
 * lives in the individual module test files already cited by PI-ERR's
 * `tests` map in scripts/release/acceptance-manifest-data.ts.
 */
const FROZEN_FAILURE_CODES = [
  // host / activation
  "HostIdentityUnknown",
  "HostVersionUnsupported",
  "InteractiveTuiRequired",
  "ActivationFailed",
  "CommandCollision",
  "RequiredCapabilityUnavailable",
  "ControllerGenerationStale",
  "InvariantViolation",
  // persistence
  "RuntimeStoreOpenFailed",
  "RuntimeStoreMigrationFailed",
  "RuntimeStoreWriteFailed",
  // execution
  "LeaseLost",
  "LifecycleProjectionFailed",
  "LifecycleEffectFailed",
  // child / protocol
  "ChildCapacityExceeded",
  "ChildSpawnFailed",
  "ChildHandshakeMissing",
  "ChildAuthenticationFailed",
  "ChildEnvelopeMalformed",
  "ChildEnvelopeReplay",
  "ChildReplyMissing",
  "ChildReplyDuplicate",
  "ChildReplyLate",
  "ChildExitedUnexpectedly",
  "ChildSettlementMissing",
  "ChildAbortFailed",
  "RpcBridgeUnavailable",
  "ChildHistoryCorrupt",
  "ChildHistoryQuotaExceeded",
  "ChildHistoryQuarantined",
  "ChildHistoryClearRefused",
  "ChildRecoveryUnavailable",
  "ChildInteractionUnavailable",
  "UiBridgeUnavailable",
  // completion
  "CompletionSignalMissing",
  "CompletionSignalDuplicate",
  "CompletionSignalMalformed",
  "CompletionSignalLate",
  "CompletionRejected",
  // plan / artifact
  "PlanMissing",
  "PlanReadFailed",
  "PlanWriteFailed",
  "PlanRevisionStale",
  "PlanTreeMalformed",
  "LegacyPlanUnsupported",
  "PlanCatalogUnavailable",
  "ArtifactReadFailed",
  "ArtifactDigestFailed",
  "ArtifactApprovalFailed",
  // telemetry
  "SessionPointerAppendFailed",
  "JournalWriteFailed",
  "UsageWriteFailed",
  "LogWriteFailed",
  "RetentionFailed",
] as const;

const FROZEN_IMPACTS = [
  "health-only",
  "operation-stopped",
  "degraded",
] as const;

const FROZEN_RECOVERIES = [
  "health-check",
  "retry",
  "resume",
  "abort",
  "upgrade",
  "downgrade",
  "none",
] as const;

describe("PiAdapterFailureCodeSchema closed-set exhaustiveness (Spec 33 §23)", () => {
  it("matches the frozen failure-code list exactly, in both directions", () => {
    const actual = new Set(PiAdapterFailureCodeSchema.options);
    const frozen = new Set(FROZEN_FAILURE_CODES);
    expect(actual).toEqual(frozen);
  });

  it("has no duplicate failure codes", () => {
    expect(PiAdapterFailureCodeSchema.options).toHaveLength(
      new Set(PiAdapterFailureCodeSchema.options).size,
    );
  });
});

describe("PiAdapterFailureImpactSchema closed-set exhaustiveness (Spec 33 §23)", () => {
  it("matches the frozen impact list exactly, in both directions", () => {
    const actual = new Set(PiAdapterFailureImpactSchema.options);
    const frozen = new Set(FROZEN_IMPACTS);
    expect(actual).toEqual(frozen);
  });
});

describe("PiAdapterFailureRecoverySchema closed-set exhaustiveness (Spec 33 §23)", () => {
  it("matches the frozen recovery list exactly, in both directions", () => {
    const actual = new Set(PiAdapterFailureRecoverySchema.options);
    const frozen = new Set(FROZEN_RECOVERIES);
    expect(actual).toEqual(frozen);
  });
});
