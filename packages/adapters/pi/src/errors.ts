import type { PlanStateError } from "@weaveio/weave-engine";
import { z } from "zod";

/**
 * Closed failure contract for the Pi adapter (Pi adapter contract). The full code and
 * phase unions are declared here even though this foundation task only
 * constructs a subset of them, so later tasks extend behavior without
 * widening the taxonomy.
 */
export const PiAdapterFailureCodeSchema = z.enum([
  // host / activation
  "HostIdentityUnknown",
  "HostVersionUnsupported",
  "InteractiveTuiRequired",
  "PersistentParentSessionRequired",
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
  "ChildSchemaInvalid",
  "ChildCheckpointInvalid",
  "ChildNativeRecordTooLarge",
  "ChildControlEnvelopeTooLarge",
  "ChildReplyMissing",
  "ChildReplyDuplicate",
  "ChildReplyLate",
  "ChildExitedUnexpectedly",
  "ChildSettlementMissing",
  "ChildAbortFailed",
  // transfer (chunked payload delivery in either direction)
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
  "ChildExtensionUiRejected",
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
]);
export type PiAdapterFailureCode = z.infer<typeof PiAdapterFailureCodeSchema>;

/**
 * The frozen transport limits for the Pi adapter's private child protocol.
 *
 * Three limits govern three different things and must never be conflated:
 *
 * 1. **Native record cap** (`nativeRecordBytes`) — the largest single native
 *    Pi JSONL record the framer will accept or emit. Pi's own protocol owns
 *    this number; Weave only refuses to buffer past it.
 * 2. **Signed control-body cap** (`signedControlBodyBytes`) — the largest
 *    authenticated Weave control-envelope body. This is a security bound on
 *    what one signature covers and is never raised to fit a payload.
 * 3. **Logical transfer cap** (`transferAggregateBytes`) — the largest
 *    reassembled payload one chunked transfer may carry. A payload larger
 *    than a signed body is split into chunks that each fit inside one, so
 *    this cap grows independently of the other two.
 *
 * The remaining entries parameterize the transfer protocol itself:
 * per-chunk decoded payload bytes, chunk count, concurrent transfers, the
 * bounded ACK wait, the single retry, and the cap on output projected to the
 * parent model.
 *
 * Changing any value here is a protocol change. `__tests__/failure-taxonomy.test.ts`
 * freezes every one of them and proves they agree with `child-framing.ts`,
 * `child-envelope.ts`, and `child-tree.ts`.
 */
export const PI_TRANSPORT_LIMITS = {
  /** Largest native Pi JSONL record (8 MiB). Mirrors `MAX_NATIVE_RECORD_BYTES`. */
  nativeRecordBytes: 8 * 1024 * 1024,
  /** Largest signed control-envelope body (64 KiB). Mirrors `MAX_CONTROL_BODY_BYTES`. */
  signedControlBodyBytes: 64 * 1024,
  /** Decoded payload bytes carried by one transfer chunk (24 KiB). */
  transferChunkPayloadBytes: 24 * 1024,
  /** Largest reassembled logical transfer payload (64 MiB). */
  transferAggregateBytes: 64 * 1024 * 1024,
  /** Largest chunk count for one transfer. */
  transferMaxChunks: 65_536,
  /** Largest number of transfers one assembler tracks at once. */
  maxConcurrentTransfers: 32,
  /** Bounded wait for a transfer ACK or NACK before the sender gives up. */
  transferAckTimeoutMs: 10_000,
  /** Retries after a failed or timed-out transfer, before a typed failure. */
  transferMaxRetries: 1,
  /** Cap on output projected to the parent model. Mirrors `MAX_LATEST_OUTPUT_BYTES`. */
  parentProjectionBytes: 4 * 1024,
} as const;

/** Names the logical channel a transfer failure belongs to, for correlation only. */
export type PiTransferChannel = "prompt" | "delegate-request" | "output";

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

/**
 * The parent Pi session is not persisted (for example, Pi started with
 * `--no-session`), so no delegated child may be created and no child-owning
 * mutation may run: a child session, its parent ref, and its execution lease
 * all need a durable parent identity to belong to.
 *
 * `operation` names the blocked mutation boundary (`delegate`, `steer`,
 * `follow-up`, `retry`, `continue`, `delete`) and `reason` is a closed
 * detection reason - never a session id, path, or any host value.
 */
export function makePersistentParentSessionRequiredFailure(
  operation: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "PersistentParentSessionRequired",
    phase: "child",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage:
      "Weave delegation requires a persistent Pi session. Start or reopen Pi with a persistent session (do not use --no-session), then retry.",
    correlation: {
      operation,
      reason,
      remediation:
        "Start or reopen Pi with a persistent session (do not use --no-session).",
    },
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

export function makeRequiredCapabilityUnavailableFailure(
  capabilityId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "RequiredCapabilityUnavailable",
    phase: "capability",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "health-check",
    safeMessage: "A required adapter capability is unavailable.",
    correlation: { capabilityId, reason },
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

function childScope(childId: string): PiAdapterFailureScope {
  return { kind: "child", id: childId };
}

/**
 * Child/protocol closed-failure factories (Pi adapter contract). Every
 * `correlation` value here is a bounded identifier, count, or closed reason
 * string - never raw RPC/control payload content, prompt text, or secret
 * material (Pi adapter contract).
 */
export function makeChildCapacityExceededFailure(
  childId: string,
  reason: "max_children" | "max_depth",
): PiAdapterFailure {
  return {
    code: "ChildCapacityExceeded",
    phase: "child",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage:
      "Delegation limits do not permit spawning this child right now.",
    correlation: { reason },
  };
}

export function makeChildSpawnFailedFailure(
  childId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ChildSpawnFailed",
    phase: "child",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not start the delegated child process.",
    correlation: { reason },
  };
}

export function makeChildHandshakeMissingFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildHandshakeMissing",
    phase: "child",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage:
      "The delegated child did not complete its authenticated handshake in time.",
  };
}

export function makeChildAuthenticationFailedFailure(
  childId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ChildAuthenticationFailed",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage: "A message from the delegated child failed authentication.",
    correlation: { reason },
  };
}

export function makeChildEnvelopeMalformedFailure(
  childId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ChildEnvelopeMalformed",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage:
      "A private control message from the delegated child was malformed.",
    correlation: { reason },
  };
}

export function makeChildEnvelopeReplayFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildEnvelopeReplay",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage:
      "A private control message from the delegated child was replayed or out of order.",
  };
}

export function makeChildReplyMissingFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildReplyMissing",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage: "The delegated child did not reply in time.",
  };
}

export function makeChildReplyDuplicateFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildReplyDuplicate",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage:
      "The delegated child sent a duplicate reply for an already-settled correlation.",
  };
}

export function makeChildReplyLateFailure(childId: string): PiAdapterFailure {
  return {
    code: "ChildReplyLate",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage:
      "The delegated child sent a reply after its correlation was already settled.",
  };
}

export function makeChildExitedUnexpectedlyFailure(
  childId: string,
  exitCode: number | null,
): PiAdapterFailure {
  return {
    code: "ChildExitedUnexpectedly",
    phase: "child",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage: "The delegated child process exited before settling its work.",
    correlation: { exitCode: exitCode ?? -1 },
  };
}

export function makeChildSettlementMissingFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildSettlementMissing",
    phase: "completion",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage:
      "The delegated child did not send an authenticated settlement.",
  };
}

export function makeChildAbortFailedFailure(
  childId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ChildAbortFailed",
    phase: "cleanup",
    scope: childScope(childId),
    impact: "degraded",
    retryable: true,
    recovery: "retry",
    safeMessage:
      "Weave could not confirm the delegated child stopped cleanly; it was terminated.",
    correlation: { reason },
  };
}

/**
 * Chunked-transfer closed-failure factories. These exist so a delivery
 * problem names its real cause instead of surfacing later as a settlement
 * timeout: a child that never received its prompt must fail with a transfer
 * error, never with `ChildSettlementMissing`.
 *
 * `reason` values are always closed, fixed strings chosen by the transfer
 * module (never raw error text), so correlation stays safe to log.
 */
export function makeChildTransferTimedOutFailure(
  childId: string,
  channel: PiTransferChannel,
): PiAdapterFailure {
  return {
    code: "ChildTransferTimedOut",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage:
      "A chunked transfer to or from the delegated child was not acknowledged in time.",
    correlation: { transfer: channel },
  };
}

export function makeChildTransferRejectedFailure(
  childId: string,
  channel: PiTransferChannel,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ChildTransferRejected",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage:
      "The peer rejected a chunked transfer as malformed, duplicated, or out of range.",
    correlation: { transfer: channel, reason },
  };
}

export function makeChildTransferTooLargeFailure(
  childId: string,
  channel: PiTransferChannel,
  byteLength: number,
): PiAdapterFailure {
  return {
    code: "ChildTransferTooLarge",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    // Retrying an oversized payload reproduces the same rejection.
    retryable: false,
    recovery: "none",
    safeMessage:
      "A chunked transfer exceeded the frozen aggregate transfer limit and was refused.",
    correlation: { transfer: channel, byteLength },
  };
}

export function makeChildDeliveryFailedFailure(
  childId: string,
  channel: PiTransferChannel,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ChildDeliveryFailed",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage:
      "Weave could not deliver a payload to the delegated child after its bounded retry.",
    correlation: { transfer: channel, reason },
  };
}

export function makeRpcBridgeUnavailableFailure(
  reason: string,
): PiAdapterFailure {
  return {
    code: "RpcBridgeUnavailable",
    phase: "child",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "health-check",
    safeMessage: "The private delegation transport is unavailable.",
    correlation: { reason },
  };
}

export function makeChildSchemaInvalidFailure(
  childId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ChildSchemaInvalid",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage: "Private child data failed the adapter schema.",
    correlation: { reason },
  };
}

export function makeChildCheckpointInvalidFailure(
  childId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ChildCheckpointInvalid",
    phase: "persistence",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: "The delegated child checkpoint cannot be restored safely.",
    correlation: { reason },
  };
}

export function makeChildNativeRecordTooLargeFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildNativeRecordTooLarge",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage: "The delegated child sent an oversized native record.",
  };
}

export function makeChildControlEnvelopeTooLargeFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildControlEnvelopeTooLarge",
    phase: "protocol",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage: "The delegated child sent an oversized control envelope.",
  };
}

export function makeChildHistoryCorruptFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildHistoryCorrupt",
    phase: "persistence",
    scope: childScope(childId),
    impact: "degraded",
    retryable: false,
    recovery: "none",
    safeMessage: "The private child history is corrupt and was not opened.",
  };
}

export function makeChildHistoryQuotaExceededFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildHistoryQuotaExceeded",
    phase: "persistence",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: "The private child history quota has been reached.",
  };
}

export function makeChildHistoryQuarantinedFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildHistoryQuarantined",
    phase: "persistence",
    scope: childScope(childId),
    impact: "degraded",
    retryable: false,
    recovery: "none",
    safeMessage: "The private child history was quarantined for safety.",
  };
}

export function makeChildHistoryClearRefusedFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildHistoryClearRefused",
    phase: "persistence",
    scope: childScope(childId),
    impact: "degraded",
    retryable: false,
    recovery: "none",
    safeMessage: "Weave refused to clear the private child history.",
  };
}

export function makeChildRecoveryUnavailableFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildRecoveryUnavailable",
    phase: "child",
    scope: childScope(childId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: "The delegated child cannot be recovered safely.",
  };
}

export function makeChildInteractionUnavailableFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "ChildInteractionUnavailable",
    phase: "protocol",
    scope: childScope(childId),
    impact: "degraded",
    retryable: false,
    recovery: "none",
    safeMessage: "The delegated child cannot accept interaction right now.",
  };
}

export function makeChildExtensionUiRejectedFailure(
  childId: string,
  reason: "stale" | "cross-child" | "not-accepted",
): PiAdapterFailure {
  return {
    code: "ChildExtensionUiRejected",
    phase: "protocol",
    scope: childScope(childId),
    impact: "degraded",
    retryable: false,
    recovery: "abort",
    safeMessage: "The delegated child rejected an extension UI response.",
    correlation: { reason },
  };
}

export function makeUiBridgeUnavailableFailure(
  childId: string,
): PiAdapterFailure {
  return {
    code: "UiBridgeUnavailable",
    phase: "protocol",
    scope: childScope(childId),
    impact: "degraded",
    retryable: true,
    recovery: "retry",
    safeMessage: "The child extension UI bridge is unavailable.",
  };
}

function executionScope(workflowInstanceId: string): PiAdapterFailureScope {
  return { kind: "execution", id: workflowInstanceId };
}

function stepScope(stepName: string): PiAdapterFailureScope {
  return { kind: "step", id: stepName };
}

/**
 * Persistence closed-failure factories (Pi adapter contract). `RuntimeStoreOpenFailed`
 * / `RuntimeStoreMigrationFailed` are health-only (Pi adapter contract): the
 * Runtime Store is authoritative, so an unopenable/unmigratable store must
 * never be silently skipped.
 */
export function makeRuntimeStoreOpenFailedFailure(
  reason: string,
): PiAdapterFailure {
  return {
    code: "RuntimeStoreOpenFailed",
    phase: "persistence",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "health-check",
    safeMessage: "Weave could not open the Runtime Store.",
    correlation: { reason },
  };
}

export function makeRuntimeStoreMigrationFailedFailure(
  reason: string,
): PiAdapterFailure {
  return {
    code: "RuntimeStoreMigrationFailed",
    phase: "persistence",
    scope: ADAPTER_SCOPE,
    impact: "health-only",
    retryable: false,
    recovery: "health-check",
    safeMessage:
      "Weave could not migrate the Runtime Store to the current schema.",
    correlation: { reason },
  };
}

export function makeRuntimeStoreWriteFailedFailure(
  workflowInstanceId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "RuntimeStoreWriteFailed",
    phase: "persistence",
    scope: executionScope(workflowInstanceId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not persist a Runtime Store write.",
    correlation: { reason },
  };
}

/** Execution closed-failure factories (Pi adapter contract). */
export function makeLeaseLostFailure(
  workflowInstanceId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "LeaseLost",
    phase: "lifecycle",
    scope: executionScope(workflowInstanceId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "resume",
    safeMessage:
      "The execution lease is no longer held; explicit resume is required.",
    correlation: { reason },
  };
}

export function makeLifecycleProjectionFailedFailure(
  workflowInstanceId: string,
  operation: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "LifecycleProjectionFailed",
    phase: "lifecycle",
    scope: executionScope(workflowInstanceId),
    impact: "operation-stopped",
    retryable: false,
    recovery: "retry",
    safeMessage: "Weave could not project the requested lifecycle operation.",
    correlation: { operation, reason },
  };
}

export function makeLifecycleEffectFailedFailure(
  workflowInstanceId: string,
  effectKind: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "LifecycleEffectFailed",
    phase: "lifecycle",
    scope: executionScope(workflowInstanceId),
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not apply a returned lifecycle effect.",
    correlation: { effectKind, reason },
  };
}

/**
 * Structured-completion closed-failure factories (Pi adapter contract). Every
 * completion candidate must arrive as one valid `weave_complete_step`
 * invocation settled by `agent_settled` - never free-form prose, process
 * exit, or retried/queued continuation before settlement.
 */
export function makeCompletionSignalMissingFailure(
  stepName: string,
): PiAdapterFailure {
  return {
    code: "CompletionSignalMissing",
    phase: "completion",
    scope: stepScope(stepName),
    impact: "operation-stopped",
    retryable: false,
    recovery: "retry",
    safeMessage:
      "The dispatched step settled without a structured completion candidate.",
  };
}

export function makeCompletionSignalDuplicateFailure(
  stepName: string,
): PiAdapterFailure {
  return {
    code: "CompletionSignalDuplicate",
    phase: "completion",
    scope: stepScope(stepName),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage:
      "The dispatched step reported more than one completion candidate.",
  };
}

export function makeCompletionSignalMalformedFailure(
  stepName: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "CompletionSignalMalformed",
    phase: "completion",
    scope: stepScope(stepName),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage:
      "The reported completion candidate did not match the closed shape.",
    correlation: { reason },
  };
}

export function makeCompletionSignalLateFailure(
  stepName: string,
): PiAdapterFailure {
  return {
    code: "CompletionSignalLate",
    phase: "completion",
    scope: stepScope(stepName),
    impact: "operation-stopped",
    retryable: false,
    recovery: "abort",
    safeMessage:
      "The completion candidate arrived after this step was already settled.",
  };
}

export function makeCompletionRejectedFailure(
  stepName: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "CompletionRejected",
    phase: "completion",
    scope: stepScope(stepName),
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: "The engine rejected the reported step completion.",
    correlation: { reason },
  };
}

/** Plan closed-failure factories (Pi adapter contract). */
export function makePlanMissingFailure(planName: string): PiAdapterFailure {
  return {
    code: "PlanMissing",
    phase: "plan",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: "The requested plan does not exist.",
    correlation: { planName },
  };
}

export function makePlanReadFailedFailure(
  planName: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "PlanReadFailed",
    phase: "plan",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not read the plan file.",
    correlation: { planName, reason },
  };
}

export function makePlanWriteFailedFailure(
  planName: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "PlanWriteFailed",
    phase: "plan",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not write the plan file.",
    correlation: { planName, reason },
  };
}

export function makePlanRevisionStaleFailure(
  planName: string,
  expectedRevision: string,
  actualRevision: string,
): PiAdapterFailure {
  return {
    code: "PlanRevisionStale",
    phase: "plan",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: false,
    recovery: "retry",
    safeMessage: "The plan changed since it was last read; refresh and retry.",
    correlation: { planName, expectedRevision, actualRevision },
  };
}

export function makePlanTreeMalformedFailure(
  planName: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "PlanTreeMalformed",
    phase: "plan",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: "The plan file could not be parsed as a valid task tree.",
    correlation: { planName, reason },
  };
}

export function makeLegacyPlanUnsupportedFailure(
  planName: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "LegacyPlanUnsupported",
    phase: "plan",
    scope: ADAPTER_SCOPE,
    impact: "degraded",
    retryable: false,
    recovery: "none",
    safeMessage:
      "This plan uses a legacy, unambiguous format; it is readable but not transitionable.",
    correlation: { planName, reason },
  };
}

/**
 * Maps the engine's full `PlanStateError` union (plan-state contract) onto the Pi
 * adapter's closed failure taxonomy (Pi adapter contract). Only a read-only
 * passthrough (`PiWorkflowController.readPlanSnapshot`) uses this today, so
 * write/transition-only variants (`PlanWriteFailed`, `PlanRevisionStale`,
 * `UnauthorizedCoordinator`, `InvalidTransition`) are mapped defensively
 * rather than left unreachable - `readSnapshot`'s declared return type is
 * the same shared union as `applyTransition`'s.
 */
export function mapPlanStateErrorToPiFailure(
  error: PlanStateError,
): PiAdapterFailure {
  switch (error.type) {
    case "PlanMissing":
      return makePlanMissingFailure(error.planName);
    case "PlanReadFailed":
      return makePlanReadFailedFailure(error.planName, error.reason);
    case "PlanWriteFailed":
      return makePlanWriteFailedFailure(error.planName, error.reason);
    case "PlanRevisionStale":
      return makePlanRevisionStaleFailure(
        error.planName,
        error.expectedRevision,
        error.actualRevision,
      );
    case "PlanTreeMalformed":
      return makePlanTreeMalformedFailure(error.planName, error.reason);
    case "LegacyPlanUnsupported":
      return makeLegacyPlanUnsupportedFailure(error.planName, error.reason);
    case "InvalidPlanName":
      return makePlanReadFailedFailure(
        error.planName,
        error.reason ?? "invalid-plan-name",
      );
    case "ProviderUnavailable":
      return makePlanReadFailedFailure(
        "unknown",
        error.reason ?? "plan-provider-unavailable",
      );
    case "UnauthorizedCoordinator":
      return makePlanReadFailedFailure(error.planName, error.reason);
    case "InvalidTransition":
      return makePlanReadFailedFailure(error.planName, error.reason);
    case "TaskNotFound":
      return makePlanReadFailedFailure(error.planName, "task-not-found");
    default: {
      const unreachable: never = error;
      return makePlanReadFailedFailure(
        "unknown",
        `unrecognized-plan-error-${String((unreachable as { type?: string }).type)}`,
      );
    }
  }
}

/** Artifact closed-failure factories (Pi adapter contract). */
export function makePlanCatalogUnavailableFailure(
  reason: string,
): PiAdapterFailure {
  return {
    code: "PlanCatalogUnavailable",
    phase: "plan",
    scope: ADAPTER_SCOPE,
    impact: "degraded",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not safely list the project's plan files.",
    correlation: { reason },
  };
}

export function makeArtifactReadFailedFailure(
  _relativePath: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ArtifactReadFailed",
    phase: "artifact",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage:
      "Weave could not safely read the artifact from a verified project-relative path.",
    correlation: { reason },
  };
}

export function makeArtifactDigestFailedFailure(
  _relativePath: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ArtifactDigestFailed",
    phase: "artifact",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: "Weave could not compute the artifact's integrity digest.",
    correlation: { reason },
  };
}

export function makeArtifactApprovalFailedFailure(
  artifactId: string,
  reason: string,
): PiAdapterFailure {
  return {
    code: "ArtifactApprovalFailed",
    phase: "artifact",
    scope: ADAPTER_SCOPE,
    impact: "operation-stopped",
    retryable: false,
    recovery: "none",
    safeMessage: "Weave could not record the artifact approval decision.",
    correlation: { artifactId, reason },
  };
}

/** Telemetry closed-failure factories (Pi adapter contract). All are degraded-only except a strict-journal transaction failure, which the caller maps to "operation-stopped" itself. */
export function makeSessionPointerAppendFailedFailure(
  reason: string,
): PiAdapterFailure {
  return {
    code: "SessionPointerAppendFailed",
    phase: "telemetry",
    scope: ADAPTER_SCOPE,
    impact: "degraded",
    retryable: true,
    recovery: "retry",
    safeMessage:
      "Weave could not append the recovery pointer after an authoritative commit.",
    correlation: { reason },
  };
}

export function makeJournalWriteFailedFailure(
  reason: string,
): PiAdapterFailure {
  return {
    code: "JournalWriteFailed",
    phase: "telemetry",
    scope: ADAPTER_SCOPE,
    impact: "degraded",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not write a Runtime Journal entry.",
    correlation: { reason },
  };
}

export function makeUsageWriteFailedFailure(reason: string): PiAdapterFailure {
  return {
    code: "UsageWriteFailed",
    phase: "telemetry",
    scope: ADAPTER_SCOPE,
    impact: "degraded",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not record a usage observation.",
    correlation: { reason },
  };
}

export function makeLogWriteFailedFailure(reason: string): PiAdapterFailure {
  return {
    code: "LogWriteFailed",
    phase: "telemetry",
    scope: ADAPTER_SCOPE,
    impact: "degraded",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not write to the runtime log sink.",
    correlation: { reason },
  };
}

export function makeRetentionFailedFailure(reason: string): PiAdapterFailure {
  return {
    code: "RetentionFailed",
    phase: "telemetry",
    scope: ADAPTER_SCOPE,
    impact: "degraded",
    retryable: true,
    recovery: "retry",
    safeMessage: "Weave could not complete a retention/pruning pass.",
    correlation: { reason },
  };
}
