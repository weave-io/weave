// ---------------------------------------------------------------------------
// Closed live-proof command and report vocabulary
// ---------------------------------------------------------------------------

export const LIVE_PROOF_SCHEMA_VERSION = 1 as const;
export const LIVE_PROOF_COMMAND = "live" as const;

/** The live verifier has exactly these four independently reported lanes. */
export const LIVE_PROOF_LANE_NAMES = Object.freeze([
  "parent-raw-reasoning-live",
  "inspector-raw-reasoning-live",
  "inspector-tool-details",
  "inspector-assistant-reply-live",
] as const);

/** Compatibility alias for callers that name the list as required lanes. */
export const REQUIRED_LIVE_PROOF_LANES = LIVE_PROOF_LANE_NAMES;

export type LiveProofLaneName = (typeof LIVE_PROOF_LANE_NAMES)[number];

export const LIVE_PROOF_IDENTITY_CURRENT_RESULTS = Object.freeze([
  "current",
  "stale-on-disk",
  "manifest-mismatch",
  "unverifiable",
] as const);
export type LiveProofIdentityCurrentResult =
  (typeof LIVE_PROOF_IDENTITY_CURRENT_RESULTS)[number];

export const LIVE_PROOF_IDENTITY_FRESH_RESULTS = Object.freeze([
  "fresh",
  "stale",
  "unverifiable",
] as const);
export type LiveProofIdentityFreshResult =
  (typeof LIVE_PROOF_IDENTITY_FRESH_RESULTS)[number];

export const LIVE_PROOF_LANE_STATUSES = Object.freeze([
  "pass",
  "fail",
  "blocked",
] as const);
export type LiveProofLaneStatus = (typeof LIVE_PROOF_LANE_STATUSES)[number];

export const LIVE_PROOF_ISOLATION_STATUSES = Object.freeze([
  "isolated",
  "violated",
  "unverified",
] as const);
export type LiveProofIsolationStatus =
  (typeof LIVE_PROOF_ISOLATION_STATUSES)[number];

export const LIVE_PROOF_SETTLEMENT_STATUSES = Object.freeze([
  "settled",
  "unsettled",
  "unverified",
] as const);
export type LiveProofSettlementStatus =
  (typeof LIVE_PROOF_SETTLEMENT_STATUSES)[number];

export const LIVE_PROOF_REGISTRY_STATUSES = Object.freeze([
  "empty",
  "leaked",
  "unverified",
] as const);
export type LiveProofRegistryStatus =
  (typeof LIVE_PROOF_REGISTRY_STATUSES)[number];

export const LIVE_PROOF_DIAGNOSTIC_STATUSES = Object.freeze([
  "clean",
  "loss-observed",
  "unverified",
] as const);
export type LiveProofDiagnosticStatus =
  (typeof LIVE_PROOF_DIAGNOSTIC_STATUSES)[number];

export const LIVE_PROOF_CLEANUP_STATUSES = Object.freeze([
  "complete",
  "incomplete",
  "unverified",
] as const);
export type LiveProofCleanupStatus =
  (typeof LIVE_PROOF_CLEANUP_STATUSES)[number];

/** Closed reasons only. No host error message or caller text may cross here. */
export const LIVE_PROOF_FAILURE_CODES = Object.freeze([
  "invalid-args",
  "unknown-argument",
  "missing-value",
  "empty-value",
  "duplicate-argument",
  "unsafe-value",
  "unsafe-report-target",
  "screen-capture-forbidden",
  "malformed-lane-list",
  "duplicate-lane",
  "overflow",
  "identity-current-failed",
  "fresh-parent-failed",
  "lane-failed",
  "isolation-failed",
  "settlement-failed",
  "registry-leaked",
  "diagnostics-failed",
  "cleanup-failed",
  "spawn-failed",
  "timeout",
  "report-invalid",
  "report-too-large",
  "serialization-failed",
] as const);
export type LiveProofFailureCode = (typeof LIVE_PROOF_FAILURE_CODES)[number];

export type LiveProofArgumentFailureReason =
  | "invalid-command"
  | "unknown-argument"
  | "missing-value"
  | "empty-value"
  | "duplicate-argument"
  | "unsafe-value"
  | "unsafe-report-target"
  | "screen-capture-forbidden"
  | "malformed-lane-list"
  | "duplicate-lane"
  | "overflow";

export interface LiveProofArgumentFailure {
  readonly reason: LiveProofArgumentFailureReason;
  readonly evidence: "blocked";
}

export interface LiveProofArgs {
  readonly command: typeof LIVE_PROOF_COMMAND;
  readonly pi: string;
  readonly requireFreshParent: true;
  readonly requireCurrentBuild: true;
  readonly proofLanes: readonly LiveProofLaneName[];
  readonly contentFreeReport: string;
  readonly noScreenCapture: true;
}
