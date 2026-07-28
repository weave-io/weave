import { describe, expect, it } from "bun:test";
import { MAX_CONTROL_BODY_BYTES } from "../child-envelope.js";
import { MAX_NATIVE_RECORD_BYTES } from "../child-framing.js";
import { MAX_LATEST_OUTPUT_BYTES } from "../child-tree.js";
import {
  makeChildDeliveryFailedFailure,
  makeChildTransferRejectedFailure,
  makeChildTransferTimedOutFailure,
  makeChildTransferTooLargeFailure,
  PI_TRANSPORT_LIMITS,
  PiAdapterFailureCodeSchema,
  PiAdapterFailureImpactSchema,
  PiAdapterFailureRecoverySchema,
} from "../errors.js";

/**
 * Schema-lock proof for the Pi adapter's closed failure contract (Pi adapter contract
 *). PI-ERR's acceptance-manifest closed set asserts that every one of
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
  "ChildTransferTimedOut",
  "ChildTransferRejected",
  "ChildTransferTooLarge",
  "ChildDeliveryFailed",
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

describe("PiAdapterFailureCodeSchema closed-set exhaustiveness (Pi adapter contract)", () => {
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

/**
 * The three transport limits are deliberately distinct and must never be
 * conflated (see docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md):
 *
 * 1. `nativeRecordBytes` bounds one native Pi JSONL record on the wire.
 * 2. `signedControlBodyBytes` bounds one signed Weave control envelope body.
 * 3. `transferAggregateBytes` bounds one logical chunked transfer payload.
 *
 * A change to any of these is a protocol change; this block is the freeze.
 */
describe("PI_TRANSPORT_LIMITS frozen transport constants (Pi adapter contract)", () => {
  it("freezes every transport limit at its exact documented value", () => {
    expect(PI_TRANSPORT_LIMITS).toEqual({
      nativeRecordBytes: 8 * 1024 * 1024,
      signedControlBodyBytes: 64 * 1024,
      transferChunkPayloadBytes: 24 * 1024,
      transferAggregateBytes: 64 * 1024 * 1024,
      transferMaxChunks: 65_536,
      maxConcurrentTransfers: 32,
      transferAckTimeoutMs: 10_000,
      transferMaxRetries: 1,
      parentProjectionBytes: 4 * 1024,
    });
  });

  it("keeps the three limits distinct rather than conflated", () => {
    const distinct = new Set([
      PI_TRANSPORT_LIMITS.nativeRecordBytes,
      PI_TRANSPORT_LIMITS.signedControlBodyBytes,
      PI_TRANSPORT_LIMITS.transferAggregateBytes,
    ]);
    expect(distinct.size).toBe(3);
  });

  it("agrees with the framer, the envelope, and the projection cap", () => {
    expect(MAX_NATIVE_RECORD_BYTES).toBe(PI_TRANSPORT_LIMITS.nativeRecordBytes);
    expect(MAX_CONTROL_BODY_BYTES).toBe(
      PI_TRANSPORT_LIMITS.signedControlBodyBytes,
    );
    expect(MAX_LATEST_OUTPUT_BYTES).toBe(
      PI_TRANSPORT_LIMITS.parentProjectionBytes,
    );
  });

  it("keeps one signed chunk payload well inside the control-body cap", () => {
    // Base64 inflates by 4/3; the encoded chunk plus its envelope metadata
    // must still fit one signed control body.
    const encoded = Math.ceil(
      (PI_TRANSPORT_LIMITS.transferChunkPayloadBytes * 4) / 3,
    );
    expect(encoded).toBeLessThan(PI_TRANSPORT_LIMITS.signedControlBodyBytes);
  });

  it("bounds an aggregate transfer by chunk count times chunk payload", () => {
    expect(
      PI_TRANSPORT_LIMITS.transferMaxChunks *
        PI_TRANSPORT_LIMITS.transferChunkPayloadBytes,
    ).toBeGreaterThanOrEqual(PI_TRANSPORT_LIMITS.transferAggregateBytes);
  });
});

describe("transfer failure factories (Pi adapter contract)", () => {
  it("reports a timed-out transfer as a retryable child-phase failure", () => {
    const failure = makeChildTransferTimedOutFailure("child-1", "prompt");
    expect(failure.code).toBe("ChildTransferTimedOut");
    expect(failure.phase).toBe("protocol");
    expect(failure.scope).toEqual({ kind: "child", id: "child-1" });
    expect(failure.retryable).toBe(true);
    expect(failure.safeMessage).not.toContain("child-1");
  });

  it("reports a rejected transfer with its closed NACK reason", () => {
    const failure = makeChildTransferRejectedFailure(
      "child-2",
      "prompt",
      "duplicate-index",
    );
    expect(failure.code).toBe("ChildTransferRejected");
    expect(failure.correlation?.reason).toBe("duplicate-index");
  });

  it("reports an oversized transfer as non-retryable", () => {
    const failure = makeChildTransferTooLargeFailure("child-3", "output", 999);
    expect(failure.code).toBe("ChildTransferTooLarge");
    expect(failure.retryable).toBe(false);
    expect(failure.correlation?.byteLength).toBe(999);
  });

  it("reports a delivery failure that names the transfer, not settlement", () => {
    const failure = makeChildDeliveryFailedFailure(
      "child-4",
      "prompt",
      "write-failed",
    );
    expect(failure.code).toBe("ChildDeliveryFailed");
    expect(failure.code).not.toBe("ChildSettlementMissing");
    expect(failure.correlation?.transfer).toBe("prompt");
  });
});

describe("PiAdapterFailureImpactSchema closed-set exhaustiveness (Pi adapter contract)", () => {
  it("matches the frozen impact list exactly, in both directions", () => {
    const actual = new Set(PiAdapterFailureImpactSchema.options);
    const frozen = new Set(FROZEN_IMPACTS);
    expect(actual).toEqual(frozen);
  });
});

describe("PiAdapterFailureRecoverySchema closed-set exhaustiveness (Pi adapter contract)", () => {
  it("matches the frozen recovery list exactly, in both directions", () => {
    const actual = new Set(PiAdapterFailureRecoverySchema.options);
    const frozen = new Set(FROZEN_RECOVERIES);
    expect(actual).toEqual(frozen);
  });
});
