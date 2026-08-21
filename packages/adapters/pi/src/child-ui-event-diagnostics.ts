import { err, ok, Result } from "neverthrow";

/**
 * Closed stages in the child-event pipeline.  A diagnostic names the first
 * stage that rejected an event; it never names the event or its owner.
 */
export const CHILD_UI_EVENT_DIAGNOSTIC_STAGES = [
  "rpc-parse",
  "live-reasoning-projection",
  "durable-normalization",
  "checkpoint",
  "fanout",
  "card-reduction",
  "tree-projection",
  "overlay-mapping",
  "overlay-reduction",
  "stream-ingest",
  "native-render",
] as const;

export type ChildUiEventDiagnosticStage =
  (typeof CHILD_UI_EVENT_DIAGNOSTIC_STAGES)[number];

/** Normal lifecycle outcomes are kept separate from defects. */
export const CHILD_UI_EVENT_LIFECYCLE_REASONS = [
  "stream-disposed",
  "stale-generation",
  "overlay-closed",
  "unfocused-child",
  "settled",
] as const;

export type ChildUiEventLifecycleReason =
  (typeof CHILD_UI_EVENT_LIFECYCLE_REASONS)[number];

/** Closed invalid-input reasons.  No payload is retained beside these codes. */
export const CHILD_UI_EVENT_INVALID_REASONS = [
  "event-invalid",
  "rpc-response-invalid",
  "mapping-invalid",
  "reducer-input-invalid",
  "render-input-invalid",
  "diagnostic-input-invalid",
] as const;

export type ChildUiEventInvalidReason =
  (typeof CHILD_UI_EVENT_INVALID_REASONS)[number];

/** Closed application-failure reasons. */
export const CHILD_UI_EVENT_FAILURE_REASONS = [
  "parser-failed",
  "normalization-failed",
  "checkpoint-failed",
  "fanout-failed",
  "card-mapping-failed",
  "card-reduction-failed",
  "tree-projection-failed",
  "overlay-mapping-failed",
  "overlay-reduction-failed",
  "stream-apply-failed",
  "native-render-failed",
  "capacity-exceeded",
  "callback-failed",
  "late-response",
  "unknown-response",
  "tool-detail-redacted",
] as const;

export type ChildUiEventFailureReason =
  (typeof CHILD_UI_EVENT_FAILURE_REASONS)[number];

export type ChildUiEventDiagnosticReason =
  | ChildUiEventLifecycleReason
  | ChildUiEventInvalidReason
  | ChildUiEventFailureReason;

export type ChildUiEventDiagnosticClass =
  | "lifecycle-drop"
  | "invalid-input"
  | "application-failure";

export type ChildUiEventDiagnosticDisposition =
  | "dropped"
  | "rejected"
  | "failed";

/** One content-free, closed diagnostic input. */
export interface ChildUiEventDiagnosticOutcome {
  readonly stage: ChildUiEventDiagnosticStage;
  readonly reason: ChildUiEventDiagnosticReason;
  readonly classification: ChildUiEventDiagnosticClass;
  readonly disposition: ChildUiEventDiagnosticDisposition;
  /** Optional event-local outcome label. It is also closed and content-free. */
  readonly outcome?: "applied" | "ignored" | "dropped" | "rejected" | "failed";
  /** Optional caller-supplied time. The sink bounds it before storing it. */
  readonly atMs?: number;
}

/** A serialized aggregate bucket. It contains no identity or content. */
export interface ChildUiEventDiagnosticBucket {
  readonly stage: ChildUiEventDiagnosticStage;
  readonly classification: ChildUiEventDiagnosticClass;
  readonly reason: ChildUiEventDiagnosticReason;
  readonly disposition: ChildUiEventDiagnosticDisposition;
  readonly count: number;
  readonly saturated: boolean;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
}

export interface ChildUiEventDiagnosticsSnapshot {
  readonly schemaVersion: 1;
  readonly buckets: readonly ChildUiEventDiagnosticBucket[];
  readonly omittedBuckets: number;
  readonly serializedBytes: number;
  readonly maxBuckets: number;
  readonly maxSerializedBytes: number;
}

export type ChildUiEventDiagnosticsError =
  | { readonly type: "InvalidDiagnosticStage" }
  | { readonly type: "InvalidDiagnosticReason" }
  | { readonly type: "InvalidDiagnosticClassification" }
  | { readonly type: "InvalidDiagnosticDisposition" }
  | { readonly type: "InvalidDiagnosticOutcome" };

export interface ChildUiEventDiagnosticsSink {
  record(
    outcome: ChildUiEventDiagnosticOutcome,
  ): Result<void, ChildUiEventDiagnosticsError>;
  snapshot(): ChildUiEventDiagnosticsSnapshot;
  clear(): Result<void, never>;
}

export interface ChildUiEventDiagnosticsConfig {
  readonly now?: () => number;
  readonly maxBuckets?: number;
  readonly maxSerializedBytes?: number;
  readonly maxCount?: number;
}

export const CHILD_UI_EVENT_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
export const CHILD_UI_EVENT_DIAGNOSTICS_MAX_BUCKETS = 64;
export const CHILD_UI_EVENT_DIAGNOSTICS_MAX_SERIALIZED_BYTES = 8 * 1024;
export const CHILD_UI_EVENT_DIAGNOSTICS_MAX_COUNT = 0xffff_ffff;
export const CHILD_UI_EVENT_DIAGNOSTICS_MAX_TIME_MS = 8_640_000_000_000_000;

const STAGES = new Set<string>(CHILD_UI_EVENT_DIAGNOSTIC_STAGES);
const LIFECYCLE = new Set<string>(CHILD_UI_EVENT_LIFECYCLE_REASONS);
const INVALID = new Set<string>(CHILD_UI_EVENT_INVALID_REASONS);
const FAILURE = new Set<string>(CHILD_UI_EVENT_FAILURE_REASONS);
const CLASSIFICATIONS = new Set<ChildUiEventDiagnosticClass>([
  "lifecycle-drop",
  "invalid-input",
  "application-failure",
]);
const DISPOSITIONS = new Set<ChildUiEventDiagnosticDisposition>([
  "dropped",
  "rejected",
  "failed",
]);
const OUTCOMES = new Set<NonNullable<ChildUiEventDiagnosticOutcome["outcome"]>>(
  ["applied", "ignored", "dropped", "rejected", "failed"],
);
const SNAPSHOT_KEYS = new Set([
  "schemaVersion",
  "buckets",
  "omittedBuckets",
  "serializedBytes",
  "maxBuckets",
  "maxSerializedBytes",
]);
const BUCKET_KEYS = new Set([
  "stage",
  "classification",
  "reason",
  "disposition",
  "count",
  "saturated",
  "firstAtMs",
  "lastAtMs",
]);

function classifyReason(
  reason: ChildUiEventDiagnosticReason,
): ChildUiEventDiagnosticClass {
  if (LIFECYCLE.has(reason)) return "lifecycle-drop";
  if (INVALID.has(reason)) return "invalid-input";
  return "application-failure";
}

function defaultDisposition(
  classification: ChildUiEventDiagnosticClass,
): ChildUiEventDiagnosticDisposition {
  if (classification === "lifecycle-drop") return "dropped";
  if (classification === "invalid-input") return "rejected";
  return "failed";
}

function boundedTime(value: number | undefined, now: () => number): number {
  const candidate = value ?? Result.fromThrowable(now, () => 0)().unwrapOr(0);
  if (!Number.isFinite(candidate)) return 0;
  return Math.min(
    CHILD_UI_EVENT_DIAGNOSTICS_MAX_TIME_MS,
    Math.max(0, Math.floor(candidate)),
  );
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(CHILD_UI_EVENT_DIAGNOSTICS_MAX_COUNT, value);
}

function bucketKey(outcome: ChildUiEventDiagnosticOutcome): string {
  return `${outcome.stage}\u0000${outcome.classification}\u0000${outcome.reason}\u0000${outcome.disposition}`;
}

function snapshotBytes(
  buckets: readonly ChildUiEventDiagnosticBucket[],
  omittedBuckets: number,
  maxBuckets: number,
  maxSerializedBytes: number,
): number {
  // `serializedBytes` is part of the public envelope, so calculate its byte
  // length to a fixed point. The field is deliberately numeric and bounded;
  // this converges in a few iterations even when its digit count changes.
  let serializedBytes = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = {
      schemaVersion: CHILD_UI_EVENT_DIAGNOSTICS_SCHEMA_VERSION,
      buckets,
      omittedBuckets,
      serializedBytes,
      maxBuckets,
      maxSerializedBytes,
    };
    const next = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (next === serializedBytes) return next;
    serializedBytes = next;
  }
  return serializedBytes;
}

/**
 * An in-memory bounded diagnostic aggregate.  It stores only closed labels,
 * saturated counts, and first/last bounded timestamps.
 */
export class ChildUiEventDiagnostics implements ChildUiEventDiagnosticsSink {
  private readonly buckets = new Map<string, ChildUiEventDiagnosticBucket>();
  private readonly now: () => number;
  private readonly maxBuckets: number;
  private readonly maxSerializedBytes: number;
  private readonly maxCount: number;
  private omittedBuckets = 0;

  constructor(config: ChildUiEventDiagnosticsConfig = {}) {
    this.now = config.now ?? (() => Date.now());
    this.maxBuckets = Math.min(
      CHILD_UI_EVENT_DIAGNOSTICS_MAX_BUCKETS,
      boundedPositiveInteger(
        config.maxBuckets,
        CHILD_UI_EVENT_DIAGNOSTICS_MAX_BUCKETS,
      ),
    );
    const requestedSerializedBytes = Math.min(
      CHILD_UI_EVENT_DIAGNOSTICS_MAX_SERIALIZED_BYTES,
      boundedPositiveInteger(
        config.maxSerializedBytes,
        CHILD_UI_EVENT_DIAGNOSTICS_MAX_SERIALIZED_BYTES,
      ),
    );
    // A snapshot with no buckets still needs room for its fixed envelope. A
    // caller may request a smaller cap, but returning JSON larger than the
    // advertised cap would make the bound dishonest.
    this.maxSerializedBytes = Math.max(
      requestedSerializedBytes,
      snapshotBytes([], 0, this.maxBuckets, requestedSerializedBytes),
    );
    this.maxCount = Math.min(
      CHILD_UI_EVENT_DIAGNOSTICS_MAX_COUNT,
      boundedPositiveInteger(
        config.maxCount,
        CHILD_UI_EVENT_DIAGNOSTICS_MAX_COUNT,
      ),
    );
  }

  record(
    outcome: ChildUiEventDiagnosticOutcome,
  ): Result<void, ChildUiEventDiagnosticsError> {
    if (!STAGES.has(outcome.stage))
      return err({ type: "InvalidDiagnosticStage" });
    if (
      !LIFECYCLE.has(outcome.reason) &&
      !INVALID.has(outcome.reason) &&
      !FAILURE.has(outcome.reason)
    )
      return err({ type: "InvalidDiagnosticReason" });
    if (!CLASSIFICATIONS.has(outcome.classification))
      return err({ type: "InvalidDiagnosticClassification" });
    if (!DISPOSITIONS.has(outcome.disposition))
      return err({ type: "InvalidDiagnosticDisposition" });
    if (outcome.outcome !== undefined && !OUTCOMES.has(outcome.outcome))
      return err({ type: "InvalidDiagnosticOutcome" });
    if (outcome.classification !== classifyReason(outcome.reason))
      return err({ type: "InvalidDiagnosticClassification" });
    if (outcome.disposition !== defaultDisposition(outcome.classification))
      return err({ type: "InvalidDiagnosticDisposition" });

    const key = bucketKey(outcome);
    const atMs = boundedTime(outcome.atMs, this.now);
    const prior = this.buckets.get(key);
    if (prior !== undefined) {
      const count = Math.min(this.maxCount, prior.count + 1);
      this.buckets.set(key, {
        ...prior,
        count,
        saturated: prior.saturated || count === this.maxCount,
        lastAtMs: atMs,
      });
      return ok(undefined);
    }

    if (this.buckets.size >= this.maxBuckets) {
      this.omittedBuckets = Math.min(this.maxCount, this.omittedBuckets + 1);
      return ok(undefined);
    }

    const bucket: ChildUiEventDiagnosticBucket = {
      stage: outcome.stage,
      classification: outcome.classification,
      reason: outcome.reason,
      disposition: outcome.disposition,
      count: 1,
      saturated: this.maxCount === 1,
      firstAtMs: atMs,
      lastAtMs: atMs,
    };
    this.buckets.set(key, bucket);
    return ok(undefined);
  }

  snapshot(): ChildUiEventDiagnosticsSnapshot {
    const ordered = [...this.buckets.values()].sort((left, right) =>
      bucketKey(left).localeCompare(bucketKey(right)),
    );
    const kept = ordered.slice(0, this.maxBuckets);
    let omitted = Math.min(
      this.maxCount,
      this.omittedBuckets + Math.max(0, ordered.length - kept.length),
    );
    // Remove the least stable (last sorted) buckets until the complete JSON
    // envelope fits. Counts and timestamps stay intact; only whole buckets are
    // omitted, so a serialized snapshot can never be truncated mid-value.
    while (
      kept.length > 0 &&
      snapshotBytes(kept, omitted, this.maxBuckets, this.maxSerializedBytes) >
        this.maxSerializedBytes
    ) {
      kept.pop();
      omitted = Math.min(this.maxCount, omitted + 1);
    }
    const bytes = snapshotBytes(
      kept,
      omitted,
      this.maxBuckets,
      this.maxSerializedBytes,
    );
    return {
      schemaVersion: CHILD_UI_EVENT_DIAGNOSTICS_SCHEMA_VERSION,
      buckets: kept,
      omittedBuckets: omitted,
      serializedBytes: bytes,
      maxBuckets: this.maxBuckets,
      maxSerializedBytes: this.maxSerializedBytes,
    };
  }

  clear(): Result<void, never> {
    this.buckets.clear();
    this.omittedBuckets = 0;
    return ok(undefined);
  }
}

export function createChildUiEventDiagnostics(
  config: ChildUiEventDiagnosticsConfig = {},
): ChildUiEventDiagnostics {
  return new ChildUiEventDiagnostics(config);
}

/**
 * Record through an optional sink without allowing a diagnostics sink failure
 * to cancel a child or suppress another UI sink.
 */
export function recordChildUiEventDiagnostic(
  sink: ChildUiEventDiagnosticsSink | undefined,
  outcome: Omit<
    ChildUiEventDiagnosticOutcome,
    "classification" | "disposition"
  > &
    Partial<
      Pick<ChildUiEventDiagnosticOutcome, "classification" | "disposition">
    >,
): void {
  if (sink === undefined) return;
  const classification =
    outcome.classification ?? classifyReason(outcome.reason);
  const disposition = outcome.disposition ?? defaultDisposition(classification);
  Result.fromThrowable(
    () => sink.record({ ...outcome, classification, disposition }),
    () => undefined,
  )().match(
    () => undefined,
    () => undefined,
  );
}

/** Convenient content-free constructors for callers at each first-loss seam. */
export function recordChildUiEventDrop(
  sink: ChildUiEventDiagnosticsSink | undefined,
  stage: ChildUiEventDiagnosticStage,
  reason: ChildUiEventLifecycleReason,
  atMs?: number,
): void {
  recordChildUiEventDiagnostic(sink, {
    stage,
    reason,
    ...(atMs === undefined ? {} : { atMs }),
  });
}

export function recordChildUiEventInvalid(
  sink: ChildUiEventDiagnosticsSink | undefined,
  stage: ChildUiEventDiagnosticStage,
  reason: ChildUiEventInvalidReason,
  atMs?: number,
): void {
  recordChildUiEventDiagnostic(sink, {
    stage,
    reason,
    ...(atMs === undefined ? {} : { atMs }),
  });
}

export function recordChildUiEventFailure(
  sink: ChildUiEventDiagnosticsSink | undefined,
  stage: ChildUiEventDiagnosticStage,
  reason: ChildUiEventFailureReason,
  atMs?: number,
): void {
  recordChildUiEventDiagnostic(sink, {
    stage,
    reason,
    ...(atMs === undefined ? {} : { atMs }),
  });
}

/** Consume a Result while preserving an independent sink's prior value. */
export function childUiEventResultOr<T, E>(
  result: Result<T, E>,
  sink: ChildUiEventDiagnosticsSink | undefined,
  stage: ChildUiEventDiagnosticStage,
  reason: ChildUiEventFailureReason,
  fallback: T,
): T {
  return result.match(
    (value) => value,
    () => {
      recordChildUiEventFailure(sink, stage, reason);
      return fallback;
    },
  );
}

/** Compact diagnostic facade for the overlay's independent projection sinks. */
export interface ChildOverlayUiDiagnostics {
  invalidEvent(): void;
  mappingResultOr<T, E>(result: Result<T, E>, fallback: T): T;
  mappingCallOr<T>(operation: () => T, fallback: T): T;
  reductionResultOr<T, E>(result: Result<T, E>, fallback: T): T;
  capacityExceeded(): void;
  toolDetailLoss(key?: string, scope?: string): void;
}

export function createChildOverlayUiDiagnostics(
  sink: ChildUiEventDiagnosticsSink | undefined,
): ChildOverlayUiDiagnostics {
  const resultOr = <T, E>(
    result: Result<T, E>,
    stage: "overlay-mapping" | "overlay-reduction",
    reason: "overlay-mapping-failed" | "overlay-reduction-failed",
    fallback: T,
  ): T => childUiEventResultOr(result, sink, stage, reason, fallback);
  const mappingFailure = (): void =>
    recordChildUiEventFailure(
      sink,
      "overlay-mapping",
      "overlay-mapping-failed",
    );
  const toolDetailDiagnosticKeys = new Set<string>();
  const toolDetailLoss = (key?: string, scope?: string): void => {
    if (key === undefined) return;
    if (key.length > 0) {
      const scopedKey = `${scope ?? ""}\u0000${key.slice(0, 256)}`;
      if (toolDetailDiagnosticKeys.has(scopedKey)) return;
      if (toolDetailDiagnosticKeys.size >= 256) {
        const oldest = toolDetailDiagnosticKeys.values().next().value;
        if (typeof oldest === "string") toolDetailDiagnosticKeys.delete(oldest);
      }
      toolDetailDiagnosticKeys.add(scopedKey);
    }
    recordChildUiEventFailure(sink, "overlay-mapping", "tool-detail-redacted");
  };
  return {
    invalidEvent: () =>
      recordChildUiEventInvalid(sink, "overlay-mapping", "event-invalid"),
    mappingResultOr: (result, fallback) =>
      resultOr(result, "overlay-mapping", "overlay-mapping-failed", fallback),
    mappingCallOr: (operation, fallback) =>
      Result.fromThrowable(operation, () => undefined)().match(
        (value) => value,
        () => {
          mappingFailure();
          return fallback;
        },
      ),
    reductionResultOr: (result, fallback) =>
      resultOr(
        result,
        "overlay-reduction",
        "overlay-reduction-failed",
        fallback,
      ),
    capacityExceeded: () =>
      recordChildUiEventFailure(sink, "overlay-reduction", "capacity-exceeded"),
    toolDetailLoss,
  };
}

/** A no-op sink for call sites that want a stable object without allocations. */
export const EMPTY_CHILD_UI_EVENT_DIAGNOSTICS: ChildUiEventDiagnosticsSink = {
  record: () => ok(undefined),
  snapshot: () => new ChildUiEventDiagnostics().snapshot(),
  clear: () => ok(undefined),
};

/** Type guard used by verifier/health readers before accepting a snapshot. */
function isChildUiEventDiagnosticsSnapshotUnsafe(
  value: unknown,
): value is ChildUiEventDiagnosticsSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !SNAPSHOT_KEYS.has(key)) ||
    record.schemaVersion !== CHILD_UI_EVENT_DIAGNOSTICS_SCHEMA_VERSION ||
    !Array.isArray(record.buckets) ||
    typeof record.omittedBuckets !== "number" ||
    !Number.isSafeInteger(record.omittedBuckets) ||
    record.omittedBuckets < 0 ||
    record.omittedBuckets > CHILD_UI_EVENT_DIAGNOSTICS_MAX_COUNT ||
    typeof record.maxBuckets !== "number" ||
    !Number.isSafeInteger(record.maxBuckets) ||
    record.maxBuckets < 1 ||
    record.maxBuckets > CHILD_UI_EVENT_DIAGNOSTICS_MAX_BUCKETS ||
    record.buckets.length > record.maxBuckets ||
    typeof record.maxSerializedBytes !== "number" ||
    !Number.isSafeInteger(record.maxSerializedBytes) ||
    record.maxSerializedBytes < 1 ||
    record.maxSerializedBytes >
      CHILD_UI_EVENT_DIAGNOSTICS_MAX_SERIALIZED_BYTES ||
    typeof record.serializedBytes !== "number" ||
    !Number.isSafeInteger(record.serializedBytes) ||
    record.serializedBytes < 0 ||
    record.serializedBytes > record.maxSerializedBytes
  ) {
    return false;
  }

  const buckets = record.buckets as readonly unknown[];
  for (const candidate of buckets) {
    if (typeof candidate !== "object" || candidate === null) return false;
    const bucket = candidate as Record<string, unknown>;
    if (
      Object.keys(bucket).some((key) => !BUCKET_KEYS.has(key)) ||
      !STAGES.has(String(bucket.stage)) ||
      !CLASSIFICATIONS.has(
        bucket.classification as ChildUiEventDiagnosticClass,
      ) ||
      (!LIFECYCLE.has(String(bucket.reason)) &&
        !INVALID.has(String(bucket.reason)) &&
        !FAILURE.has(String(bucket.reason))) ||
      !DISPOSITIONS.has(
        bucket.disposition as ChildUiEventDiagnosticDisposition,
      ) ||
      typeof bucket.count !== "number" ||
      !Number.isSafeInteger(bucket.count) ||
      bucket.count < 1 ||
      bucket.count > CHILD_UI_EVENT_DIAGNOSTICS_MAX_COUNT ||
      typeof bucket.saturated !== "boolean" ||
      typeof bucket.firstAtMs !== "number" ||
      !Number.isSafeInteger(bucket.firstAtMs) ||
      bucket.firstAtMs < 0 ||
      bucket.firstAtMs > CHILD_UI_EVENT_DIAGNOSTICS_MAX_TIME_MS ||
      typeof bucket.lastAtMs !== "number" ||
      !Number.isSafeInteger(bucket.lastAtMs) ||
      bucket.lastAtMs < 0 ||
      bucket.lastAtMs > CHILD_UI_EVENT_DIAGNOSTICS_MAX_TIME_MS
    ) {
      return false;
    }
    const reason = bucket.reason as ChildUiEventDiagnosticReason;
    if (
      bucket.classification !== classifyReason(reason) ||
      bucket.disposition !==
        defaultDisposition(bucket.classification as ChildUiEventDiagnosticClass)
    ) {
      return false;
    }
  }

  return (
    record.serializedBytes ===
    snapshotBytes(
      buckets as readonly ChildUiEventDiagnosticBucket[],
      record.omittedBuckets,
      record.maxBuckets,
      record.maxSerializedBytes,
    )
  );
}

/** A verifier input must fail closed even when hostile getters or proxies are supplied. */
export function isChildUiEventDiagnosticsSnapshot(
  value: unknown,
): value is ChildUiEventDiagnosticsSnapshot {
  return Result.fromThrowable(
    () => isChildUiEventDiagnosticsSnapshotUnsafe(value),
    () => false,
  )().unwrapOr(false);
}

// Keep these helpers in the module so closed labels are checked once at runtime
// even when a caller crosses the adapter boundary with untyped data.
export function diagnosticClassForReason(
  reason: ChildUiEventDiagnosticReason,
): ChildUiEventDiagnosticClass {
  return classifyReason(reason);
}

export function diagnosticDispositionForReason(
  reason: ChildUiEventDiagnosticReason,
): ChildUiEventDiagnosticDisposition {
  return defaultDisposition(classifyReason(reason));
}
