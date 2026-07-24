import { z } from "zod";

/**
 * Closed failure contract for the Pi adapter (Spec 33 §23). The full code and
 * phase unions are declared here even though this foundation task only
 * constructs a subset of them, so later tasks extend behavior without
 * widening the taxonomy.
 */
export const PiAdapterFailureCodeSchema = z.enum([
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
  "UiBridgeFailed",
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
  "ArtifactReadFailed",
  "ArtifactDigestFailed",
  "ArtifactApprovalFailed",
  // telemetry
  "SessionPointerAppendFailed",
  "JournalWriteFailed",
  "UsageWriteFailed",
  "LogWriteFailed",
  "RetentionFailed",
]);
export type PiAdapterFailureCode = z.infer<typeof PiAdapterFailureCodeSchema>;

export const PiAdapterFailurePhaseSchema = z.enum([
  "safe-init",
  "activation",
  "persistence",
  "capability",
  "child",
  "protocol",
  "lifecycle",
  "completion",
  "plan",
  "artifact",
  "telemetry",
  "cleanup",
]);
export type PiAdapterFailurePhase = z.infer<typeof PiAdapterFailurePhaseSchema>;

export const PiAdapterFailureImpactSchema = z.enum([
  "health-only",
  "operation-stopped",
  "degraded",
]);
export type PiAdapterFailureImpact = z.infer<
  typeof PiAdapterFailureImpactSchema
>;

export const PiAdapterFailureRecoverySchema = z.enum([
  "health-check",
  "retry",
  "resume",
  "abort",
  "upgrade",
  "downgrade",
  "none",
]);
export type PiAdapterFailureRecovery = z.infer<
  typeof PiAdapterFailureRecoverySchema
>;

export type PiAdapterFailureScope =
  | { readonly kind: "adapter" }
  | { readonly kind: "execution"; readonly id: string }
  | { readonly kind: "step"; readonly id: string }
  | { readonly kind: "child"; readonly id: string };

export interface PiAdapterFailure {
  readonly code: PiAdapterFailureCode;
  readonly phase: PiAdapterFailurePhase;
  readonly scope: PiAdapterFailureScope;
  readonly impact: PiAdapterFailureImpact;
  readonly retryable: boolean;
  readonly recovery: PiAdapterFailureRecovery;
  readonly safeMessage: string;
  readonly correlation?: Readonly<Record<string, string | number | boolean>>;
}

const ADAPTER_SCOPE: PiAdapterFailureScope = { kind: "adapter" };

export function makeHostIdentityUnknownFailure(
  reason: string,
): PiAdapterFailure {
  return {
    code: "HostIdentityUnknown",
    phase: "safe-init",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "health-check",
    safeMessage: "Weave could not confirm the installed host package identity.",
    correlation: { reason },
  };
}

export function makeHostVersionUnsupportedFailure(
  version: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "HostVersionUnsupported",
    phase: "safe-init",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "upgrade",
    safeMessage: "The installed host version is outside the supported range.",
    correlation: { version, reason },
  };
}

export function makeInteractiveTuiRequiredFailure(
  mode: string,
): PiAdapterFailure {
  return {
    code: "InteractiveTuiRequired",
    phase: "safe-init",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "none",
    safeMessage: "Weave only activates in the interactive TUI mode.",
    correlation: { mode },
  };
}

export function makeActivationFailedFailure(reason: string): PiAdapterFailure {
  return {
    code: "ActivationFailed",
    phase: "activation",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "health-check",
    safeMessage: "Weave activation could not complete.",
    correlation: { reason },
  };
}

export function makeCommandCollisionFailure(
  commandName: string,
): PiAdapterFailure {
  return {
    code: "CommandCollision",
    phase: "activation",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "health-check",
    safeMessage: `A required Weave command is not exclusively owned: ${commandName}.`,
    correlation: { commandName },
  };
}

export function makeControllerGenerationStaleFailure(
  generationId: string,
): PiAdapterFailure {
  return {
    code: "ControllerGenerationStale",
    phase: "lifecycle",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: false,
    recovery: "retry",
    safeMessage: "This operation belongs to a replaced Weave generation.",
    correlation: { generationId },
  };
}

export function makeInvariantViolationFailure(
  detail: string,
): PiAdapterFailure {
  return {
    code: "InvariantViolation",
    phase: "safe-init",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "health-check",
    safeMessage: "Weave detected an internal invariant violation.",
    correlation: { detail },
  };
}
