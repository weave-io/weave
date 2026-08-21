import type {
  LIVE_PROOF_SCHEMA_VERSION,
  LiveProofCleanupStatus,
  LiveProofDiagnosticStatus,
  LiveProofFailureCode,
  LiveProofIdentityCurrentResult,
  LiveProofIdentityFreshResult,
  LiveProofIsolationStatus,
  LiveProofLaneName,
  LiveProofRegistryStatus,
  LiveProofSettlementStatus,
} from "./child-stream-live-proof-contract-types.js";

// ---------------------------------------------------------------------------
// Closed content-free report schema and bounds
// ---------------------------------------------------------------------------

/**
 * These are limits on the serialized report, not suggestions for callers.
 * The report contains only a few fixed-shape objects, but the limits remain
 * explicit so a future field cannot silently make the output unbounded.
 */
export const MAX_LIVE_PROOF_REPORT_DEPTH = 8;
export const MAX_LIVE_PROOF_REPORT_KEYS = 64;
export const MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH = 8;
export const MAX_LIVE_PROOF_REPORT_STRING_BYTES = 128;
export const MAX_LIVE_PROOF_REPORT_TOTAL_BYTES = 16 * 1024;

/** The canonical bounds object emitted by every valid report. */
export const LIVE_PROOF_REPORT_BOUNDS = Object.freeze({
  maxDepth: MAX_LIVE_PROOF_REPORT_DEPTH,
  maxKeys: MAX_LIVE_PROOF_REPORT_KEYS,
  maxArrayLength: MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH,
  maxStringBytes: MAX_LIVE_PROOF_REPORT_STRING_BYTES,
  maxTotalBytes: MAX_LIVE_PROOF_REPORT_TOTAL_BYTES,
});

export interface LiveProofIdentity {
  readonly currentBuild: LiveProofIdentityCurrentResult;
  readonly freshParent: LiveProofIdentityFreshResult;
}

export type LiveProofLaneObservation =
  | {
      readonly name: LiveProofLaneName;
      readonly status: "pass";
      readonly observationCount: number;
    }
  | {
      readonly name: LiveProofLaneName;
      readonly status: "fail" | "blocked";
      readonly observationCount: number;
      readonly reason: LiveProofFailureCode;
    };

export interface LiveProofCounters {
  readonly events: number;
  readonly dropped: number;
  readonly repaints: number;
  readonly diagnostics: number;
  readonly cleanupAttempts: number;
}

export interface LiveProofBounds {
  readonly maxDepth: typeof MAX_LIVE_PROOF_REPORT_DEPTH;
  readonly maxKeys: typeof MAX_LIVE_PROOF_REPORT_KEYS;
  readonly maxArrayLength: typeof MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH;
  readonly maxStringBytes: typeof MAX_LIVE_PROOF_REPORT_STRING_BYTES;
  readonly maxTotalBytes: typeof MAX_LIVE_PROOF_REPORT_TOTAL_BYTES;
}

/**
 * Deliberately closed. In particular, there is no `path`, `content`,
 * `exception`, message, payload, or free-form string field in this type.
 */
export interface LiveProofReport {
  readonly schemaVersion: typeof LIVE_PROOF_SCHEMA_VERSION;
  readonly identity: LiveProofIdentity;
  readonly lanes: readonly LiveProofLaneObservation[];
  readonly isolation: LiveProofIsolationStatus;
  readonly settlement: LiveProofSettlementStatus;
  readonly registry: LiveProofRegistryStatus;
  readonly diagnostics: LiveProofDiagnosticStatus;
  readonly cleanup: LiveProofCleanupStatus;
  readonly failures: readonly LiveProofFailureCode[];
  readonly counters: LiveProofCounters;
  readonly bounds: LiveProofBounds;
}

export const LIVE_PROOF_REPORT_KEYS = Object.freeze([
  "schemaVersion",
  "identity",
  "lanes",
  "isolation",
  "settlement",
  "registry",
  "diagnostics",
  "cleanup",
  "failures",
  "counters",
  "bounds",
] as const);

export const LIVE_PROOF_VALIDATION_FAILURE_REASONS = Object.freeze([
  "not-object",
  "unexpected-key",
  "missing-field",
  "wrong-type",
  "invalid-enum",
  "accessor",
  "unreadable-input",
  "unsafe-prototype",
  "depth-exceeded",
  "key-limit-exceeded",
  "array-limit-exceeded",
  "string-limit-exceeded",
  "byte-limit-exceeded",
  "duplicate-lane",
  "lane-set-incomplete",
  "duplicate-failure",
  "invalid-bounds",
  "invalid-counter",
] as const);
export type LiveProofValidationFailureReason =
  (typeof LIVE_PROOF_VALIDATION_FAILURE_REASONS)[number];

export interface LiveProofReportValidationFailure {
  readonly reason: LiveProofValidationFailureReason;
  readonly evidence: "blocked";
}

export type LiveProofSerializationFailureReason =
  | "invalid-report"
  | "report-too-large"
  | "serialization-failed";

export interface LiveProofSerializationFailure {
  readonly reason: LiveProofSerializationFailureReason;
  readonly evidence: "blocked";
}

export type LiveProofJsonFailureReason =
  | "not-string"
  | "json-too-large"
  | "invalid-json"
  | "invalid-report";

export interface LiveProofJsonFailure {
  readonly reason: LiveProofJsonFailureReason;
  readonly evidence: "blocked";
}
