import type { Result, ResultAsync } from "neverthrow";
import type { EffectiveToolPolicy } from "../tool-policy.js";

export type PermissionCapability =
  | "read"
  | "write"
  | "execute"
  | "delegate"
  | "network";
export type PermissionDecision = "allow" | "deny" | "ask";
export type PermissionPolicy = EffectiveToolPolicy;
export type GrantScope = "once" | "session" | "durable";
export type OpaqueId = string;
export type ChallengeId = OpaqueId;
export type PermitId = OpaqueId;
export type RequestId = OpaqueId;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Deep-frozen call snapshot returned by successful permit consumption.
 * Adapters MUST execute only this value — never the caller-owned call object.
 */
export type PermissionExecutionSnapshot = JsonValue;

export type PermissionError =
  | { readonly type: "invalid_registration"; readonly message?: string }
  | {
      readonly type: "duplicate_registration";
      readonly toolIdentity: string;
      readonly message?: string;
    }
  | { readonly type: "invalid_registry"; readonly message?: string }
  | { readonly type: "invalid_registry_transition"; readonly message?: string }
  | { readonly type: "non_idle_replacement"; readonly message?: string }
  | { readonly type: "resolver_returned_error"; readonly message?: string }
  | { readonly type: "resolver_threw"; readonly message?: string }
  | {
      readonly type: "unsafe_input";
      readonly path: string;
      readonly message?: string;
    }
  | { readonly type: "invalid_output"; readonly message?: string }
  | { readonly type: "empty_output"; readonly message?: string }
  | { readonly type: "repository_failure"; readonly message?: string }
  | { readonly type: "unknown_grant"; readonly message?: string }
  | { readonly type: "challenge_capacity_exceeded"; readonly message?: string }
  | { readonly type: "permit_capacity_exceeded"; readonly message?: string }
  | {
      readonly type:
        | "unknown_challenge"
        | "stale_challenge"
        | "expired_challenge"
        | "consumed_challenge";
      readonly message?: string;
    }
  | {
      readonly type:
        | "unknown_permit"
        | "stale_permit"
        | "expired_permit"
        | "consumed_permit";
      readonly message?: string;
    }
  | {
      readonly type: "invalid_scope" | "invalid_response";
      readonly message?: string;
    }
  | {
      readonly type: "closed_session" | "mismatched_session";
      readonly message?: string;
    }
  | { readonly type: "unresolved_ui_unavailable"; readonly message?: string }
  | { readonly type: "unknown_agent"; readonly message?: string }
  | { readonly type: "stale_permission_state"; readonly message?: string };

export interface PermissionTarget {
  readonly kind: string;
  readonly identifier: string;
}
export interface PermissionDisplay {
  readonly summary: string;
  readonly details?: string;
}
export interface GrantablePermissionRequest {
  readonly unresolved: false;
  readonly capability: PermissionCapability;
  readonly operation: string;
  readonly target: PermissionTarget;
  readonly display: PermissionDisplay;
  readonly constraints?: JsonValue;
}
export interface UnresolvedPermissionRequest {
  readonly unresolved: true;
  readonly display: PermissionDisplay;
}
export type PermissionRequest =
  | GrantablePermissionRequest
  | UnresolvedPermissionRequest;

export interface PermissionCallInput {
  readonly project: string;
  readonly session: string;
  readonly agentName: string;
  readonly toolIdentity: string;
  readonly registryGeneration: string;
  readonly call: unknown;
  readonly approvalUiAvailable: boolean;
}
export interface PermissionRegistrationContext {
  readonly toolIdentity: string;
  readonly owner: string;
  readonly revision: string;
}
export type PermissionResolver = (
  input: Readonly<{ call: JsonValue; context: PermissionRegistrationContext }>,
) => Result<readonly PermissionRequest[], PermissionError>;
export interface PermissionRegistration {
  readonly toolIdentity: string;
  readonly owner: string;
  readonly revision: string;
  readonly summary: string;
  readonly details?: string;
  readonly resolver: PermissionResolver;
}
export interface PermissionRegistrationMetadata {
  readonly toolIdentity: string;
  readonly owner: string;
  readonly revision: string;
  readonly summary: string;
  readonly details?: string;
}
export interface PermissionRegistryInventory {
  readonly generation: string;
  readonly registrations: readonly PermissionRegistrationMetadata[];
}
export interface PermissionRegistryGenerationMetadata {
  readonly identity: string;
  readonly generation: string;
  readonly inventory: PermissionRegistryInventory;
}

/**
 * Effective evaluation decision retained on each pending request view.
 * Pending views are only produced for `ask` evaluation — policy `deny` is a
 * separate outcome and policy `allow` never becomes pending.
 */
export type PendingPermissionDecision = "ask";
/**
 * Origin of a pending request (Spec 34 §6).
 * - `policy`: grantable request under effective capability policy `ask`
 *   without a matching grant
 * - `resolver`: explicit unresolved mapping that always requires approval
 */
export type PendingPermissionSource = "policy" | "resolver";
/**
 * Bounded closed reason retained on each pending request view.
 * - `policy_ask_without_grant`: capability policy is `ask` and no grant matched
 * - `unresolved_request`: resolver could not map input to a grantable request
 */
export type PendingPermissionReason =
  | "policy_ask_without_grant"
  | "unresolved_request";

/**
 * Per-request evaluation fields required on every pending request view so UI
 * grouping cannot collapse distinct identity/decision/source/reason tuples.
 */
export interface PendingPermissionEvaluation {
  readonly decision: PendingPermissionDecision;
  readonly source: PendingPermissionSource;
  readonly reason: PendingPermissionReason;
}

export interface GrantablePermissionRequestView
  extends PendingPermissionEvaluation {
  readonly requestId: RequestId;
  readonly capability: PermissionCapability;
  readonly operation: string;
  readonly target: PermissionTarget;
  readonly display: PermissionDisplay;
}
export interface UnresolvedPermissionRequestView
  extends PendingPermissionEvaluation {
  readonly requestId: RequestId;
  readonly display: PermissionDisplay;
}
export type PendingPermissionRequestView =
  | GrantablePermissionRequestView
  | UnresolvedPermissionRequestView;
/** Denied outcome views are presentation-only; they are not pending challenges. */
export interface DeniedGrantablePermissionRequestView {
  readonly capability: PermissionCapability;
  readonly operation: string;
  readonly target: PermissionTarget;
  readonly display: PermissionDisplay;
}
export interface DeniedUnresolvedPermissionRequestView {
  readonly display: PermissionDisplay;
}
export type DeniedPermissionRequestView =
  | DeniedGrantablePermissionRequestView
  | DeniedUnresolvedPermissionRequestView;
export interface PermissionApprovalChoice {
  readonly requestId: RequestId;
  readonly decision: "allow" | "deny";
  readonly scope?: GrantScope;
  readonly expiresAt?: number;
}
export interface PermissionApprovalResponse {
  readonly challenge: ChallengeId;
  readonly choices: readonly PermissionApprovalChoice[];
}
export type ApprovalResponse = PermissionApprovalResponse;
export type PermissionOutcome =
  | { readonly kind: "unmanaged" }
  | {
      readonly kind: "denied";
      readonly requests: readonly DeniedPermissionRequestView[];
    }
  | {
      readonly kind: "approval_required";
      readonly challenge: ChallengeId;
      readonly requests: readonly PendingPermissionRequestView[];
    }
  | { readonly kind: "authorized"; readonly permit: PermitId };

export interface PermissionChallengeConsumeInput {
  readonly challenge: ChallengeId;
  readonly project: string;
  readonly session: string;
  readonly agentName: string;
  readonly toolIdentity: string;
  readonly registryGeneration: string;
}
export interface PermissionPermitConsumeInput {
  readonly permit: PermitId;
  readonly project: string;
  readonly session: string;
  readonly agentName: string;
  readonly toolIdentity: string;
  readonly registryGeneration: string;
  readonly call: unknown;
}
export interface GrantIdentityEnvelope {
  readonly projectIdentity: string;
  readonly agentName: string;
  readonly registrationOwner: string;
  readonly toolIdentity: string;
  readonly registrationRevision: string;
  readonly policyFingerprint: string;
  readonly requestSchemaVersion: string;
  readonly requestDigest: string;
}
export interface DurablePermissionGrantRecord {
  readonly grantId: OpaqueId;
  readonly identity: GrantIdentityEnvelope;
  readonly scope: "durable";
  readonly display: PermissionDisplay;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
  readonly state: "active" | "revoked";
}
export interface PermissionGrantSummary {
  readonly project: string;
  readonly grantId: OpaqueId;
  readonly agentName: string;
  readonly toolIdentity: string;
  readonly scope: "durable";
  readonly display: PermissionDisplay;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
  readonly state: "active" | "revoked";
}
export interface PermissionApprovalRepository {
  readonly saveMany: (
    records: readonly DurablePermissionGrantRecord[],
  ) => ResultAsync<readonly DurablePermissionGrantRecord[], PermissionError>;
  readonly list: (
    project: string,
    now?: number,
  ) => ResultAsync<readonly PermissionGrantSummary[], PermissionError>;
  readonly revoke: (
    project: string,
    grantId: OpaqueId,
  ) => ResultAsync<void, PermissionError>;
  readonly match: (
    identity: GrantIdentityEnvelope,
    now?: number,
  ) => ResultAsync<PermissionGrantSummary | undefined, PermissionError>;
}
export type PermissionAuditEvent =
  | {
      readonly type: "authorization_denied";
      readonly project: string;
      readonly agentName: string;
      readonly toolIdentity?: string;
      readonly count?: number;
      readonly errorCategory: PermissionError["type"];
      readonly timestamp: number;
    }
  | {
      readonly type: "authorization_denied";
      readonly project: string;
      readonly agentName: string;
      readonly toolIdentity?: string;
      readonly count?: number;
      readonly outcome: "policy_denied";
      readonly timestamp: number;
    }
  | {
      readonly type: "approval_requested";
      readonly project: string;
      readonly agentName: string;
      readonly toolIdentity: string;
      readonly count: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "approval_answered";
      readonly project: string;
      readonly agentName: string;
      readonly toolIdentity: string;
      readonly count: number;
      readonly outcome: "approved" | "rejected";
      readonly timestamp: number;
    }
  | {
      readonly type: "permit_issued" | "permit_consumed";
      readonly project: string;
      readonly agentName: string;
      readonly toolIdentity: string;
      readonly timestamp: number;
    }
  | {
      readonly type: "grant_revoked" | "registry_replaced" | "session_closed";
      readonly project: string;
      readonly agentName: string;
      readonly toolIdentity?: string;
      readonly timestamp: number;
    };
export type Clock = () => number;
export type IdSource = () => string;

/** Engine-owned clocks for permission sessions. */
export interface PermissionClocks {
  /**
   * Nondecreasing monotonic source for challenge (5m) and permit (30s)
   * deadlines. Production uses a steady performance clock.
   */
  readonly monotonic: Clock;
  /**
   * Wall-clock source for audit timestamps and durable grant createdAt/
   * expiresAt comparisons. Subject to high-water clamping so rollback cannot
   * extend or resurrect authority.
   */
  readonly wall: Clock;
}
