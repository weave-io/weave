/**
 * Pi adapter contract — adapter diagnostics, retention, and usage telemetry.
 *
 * Normalizes Runtime Journal families, records exactly-once usage
 * observations for settled primary/child assistant messages, activates
 * retention pruning at safe boundaries, and wires an engine-scoped rotating
 * pino sink. This module is a thin, injectable seam over the existing
 * engine APIs (`RuntimeJournalWriter`, `RuntimeRetentionService`,
 * `createRotatingRuntimeLogSink`) — it never reimplements journal
 * validation, usage idempotency, retention pruning, or log rotation.
 *
 * See docs/adapters/pi.md.
 *
 * Data ban: every method here accepts only bounded, closed-set safe
 * scalars (IDs, event-type names, enum values, counts, costs, timestamps).
 * Callers MUST NOT pass raw prompts, completions, transcripts, tool
 * arguments, RPC/provider payloads, plan/artifact contents, secrets,
 * private paths, or command/environment values into any method here.
 */

import type { RuntimeSettings } from "@weaveio/weave-core";
import {
  asPinoDestination,
  BunRuntimeLogFileSystem,
  createExecutionLeaseId,
  createRotatingRuntimeLogSink,
  createUsageObservationId,
  createWorkflowInstanceId,
  type JournalSeverity,
  type JsonObject,
  RuntimeJournalWriter,
  type RuntimeLogFileSystem,
  RuntimeRetentionService,
  type RuntimeStore,
  type RuntimeStoreError,
  type UsageObservation,
} from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import pino from "pino";
import { z } from "zod";
import {
  makeInvariantViolationFailure,
  makeJournalWriteFailedFailure,
  makeLogWriteFailedFailure,
  makeRetentionFailedFailure,
  makeUsageWriteFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  isProviderFastRuleId,
  PROVIDER_FAST_EVIDENCE_KINDS,
  PROVIDER_FAST_EVIDENCE_OUTCOMES,
  PROVIDER_FAST_REASONS,
  PROVIDER_FAST_STATES,
  type ProviderFastEvidenceKind,
  type ProviderFastEvidenceOutcome,
  type ProviderFastPublicSnapshot,
  type ProviderFastReason,
  type ProviderFastRuleId,
  type ProviderFastState,
} from "./provider-fast-activation.js";
import type { JsonValue } from "./strict-json.js";
import type { Clock, PiAdapterLogger } from "./types.js";

/**
 * Normalized Runtime Journal families this adapter emits (Pi adapter contract).
 * Every journal entry is tagged with exactly one family via its
 * `eventType` prefix (`"<family>.<event>"`), so downstream consumers can
 * filter deterministically without parsing free-text.
 */
export const PI_JOURNAL_FAMILIES = [
  "activation-health",
  "generation",
  "probe",
  "workflow-recovery",
  "lease",
  "effect",
  "plan",
  "completion",
  "artifact",
  "child-lifecycle",
  "child-protocol",
  "delegation",
  "ui-bridge",
  "usage",
  "retention",
  "telemetry-degradation",
  "provider-fast",
] as const;

export type PiJournalFamily = (typeof PI_JOURNAL_FAMILIES)[number];

/** Bounded safe-scalar payload — never raw prompts/output/args/payloads/paths. */
export type PiJournalSafeData = Readonly<
  Record<string, string | number | boolean>
>;

/**
 * One journal event per neutral runtime state. The event name *is* the state,
 * so a consumer can filter `provider-fast.applied` from
 * `provider-fast.not-confirmed` without parsing data.
 */
export const PI_PROVIDER_FAST_JOURNAL_EVENTS = PROVIDER_FAST_STATES;

export type PiProviderFastJournalEvent = ProviderFastState;

/**
 * Every key a provider-fast journal entry may carry. `ruleId` is the only
 * optional one, present exactly when an allowlist entry matched.
 */
export const PI_PROVIDER_FAST_JOURNAL_DATA_KEYS = [
  "state",
  "evidenceKind",
  "evidenceOutcome",
  "reason",
  "ruleId",
] as const;

export type PiProviderFastJournalDataKey =
  (typeof PI_PROVIDER_FAST_JOURNAL_DATA_KEYS)[number];

/** The keys every entry must carry. */
export const PI_PROVIDER_FAST_JOURNAL_REQUIRED_DATA_KEYS = [
  "state",
  "evidenceKind",
  "evidenceOutcome",
  "reason",
] as const;

export type PiProviderFastJournalData = {
  readonly state: ProviderFastState;
  readonly evidenceKind: ProviderFastEvidenceKind;
  readonly evidenceOutcome: ProviderFastEvidenceOutcome;
  readonly reason: ProviderFastReason;
  readonly ruleId?: ProviderFastRuleId;
};

export type PiProviderFastJournalRecordOutcome = "recorded" | "duplicate";

/** Bound for the in-memory terminal-outcome dedupe window. */
export const PI_PROVIDER_FAST_DEDUPE_LIMIT = 64;

/**
 * Severity per state. A reached or requested acceleration is ordinary
 * information; an intent that could not be proven is the case an operator may
 * want to notice, so it is a warning.
 */
const PI_PROVIDER_FAST_SEVERITY: Readonly<
  Record<ProviderFastState, JournalSeverity>
> = Object.freeze({
  declared: "info",
  requested: "info",
  applied: "info",
  "not-confirmed": "warn",
  unsupported: "warn",
});

const ProviderFastStateSchema = z.enum(PROVIDER_FAST_STATES);
const ProviderFastEvidenceKindSchema = z.enum(PROVIDER_FAST_EVIDENCE_KINDS);
const ProviderFastEvidenceOutcomeSchema = z.enum(
  PROVIDER_FAST_EVIDENCE_OUTCOMES,
);
const ProviderFastReasonSchema = z.enum(PROVIDER_FAST_REASONS);
const ProviderFastRuleIdSchema = z
  .string()
  .refine((value): value is ProviderFastRuleId => isProviderFastRuleId(value));
const ProviderFastJournalDataKeySchema = z.enum(
  PI_PROVIDER_FAST_JOURNAL_DATA_KEYS,
);
const ProviderFastJournalDataValueSchema = z.union([
  ProviderFastStateSchema,
  ProviderFastEvidenceKindSchema,
  ProviderFastEvidenceOutcomeSchema,
  ProviderFastReasonSchema,
  ProviderFastRuleIdSchema,
]);
type ProviderFastJournalDataValue = z.infer<
  typeof ProviderFastJournalDataValueSchema
>;

function invalidProviderFastState(): Result<
  PiProviderFastJournalData,
  PiAdapterFailure
> {
  return err(makeJournalWriteFailedFailure("invalid-provider-fast-state"));
}

function readProviderFastField(
  record: ProviderFastPublicSnapshot,
  key: PiProviderFastJournalDataKey,
): Result<ProviderFastJournalDataValue, PiAdapterFailure> {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== true
  ) {
    return err(makeJournalWriteFailedFailure("invalid-provider-fast-state"));
  }
  const parsed = ProviderFastJournalDataValueSchema.safeParse(descriptor.value);
  return parsed.success
    ? ok(parsed.data)
    : err(makeJournalWriteFailedFailure("invalid-provider-fast-state"));
}

const inspectProviderFastPublicState = Result.fromThrowable(
  (
    input: ProviderFastPublicSnapshot,
  ): Result<PiProviderFastJournalData, PiAdapterFailure> => {
    if (Array.isArray(input)) return invalidProviderFastState();

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidProviderFastState();
    }
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length < PI_PROVIDER_FAST_JOURNAL_REQUIRED_DATA_KEYS.length ||
      ownKeys.length > PI_PROVIDER_FAST_JOURNAL_DATA_KEYS.length
    ) {
      return invalidProviderFastState();
    }
    const parsedKeys = ownKeys.map((key) =>
      ProviderFastJournalDataKeySchema.safeParse(key),
    );
    if (parsedKeys.some((parsed) => !parsed.success)) {
      return invalidProviderFastState();
    }

    const state = readProviderFastField(input, "state");
    const evidenceKind = readProviderFastField(input, "evidenceKind");
    const evidenceOutcome = readProviderFastField(input, "evidenceOutcome");
    const reason = readProviderFastField(input, "reason");
    if (
      state.isErr() ||
      evidenceKind.isErr() ||
      evidenceOutcome.isErr() ||
      reason.isErr()
    ) {
      return invalidProviderFastState();
    }
    const parsedState = ProviderFastStateSchema.safeParse(state.value);
    const parsedEvidenceKind = ProviderFastEvidenceKindSchema.safeParse(
      evidenceKind.value,
    );
    const parsedEvidenceOutcome = ProviderFastEvidenceOutcomeSchema.safeParse(
      evidenceOutcome.value,
    );
    const parsedReason = ProviderFastReasonSchema.safeParse(reason.value);
    if (
      !parsedState.success ||
      !parsedEvidenceKind.success ||
      !parsedEvidenceOutcome.success ||
      !parsedReason.success
    ) {
      return invalidProviderFastState();
    }
    const carriesRuleId = ownKeys.includes("ruleId");
    if (!carriesRuleId) {
      return ok(
        Object.freeze({
          state: parsedState.data,
          evidenceKind: parsedEvidenceKind.data,
          evidenceOutcome: parsedEvidenceOutcome.data,
          reason: parsedReason.data,
        }),
      );
    }
    const ruleId = readProviderFastField(input, "ruleId");
    if (ruleId.isErr()) return invalidProviderFastState();
    const parsedRuleId = ProviderFastRuleIdSchema.safeParse(ruleId.value);
    if (!parsedRuleId.success) return invalidProviderFastState();
    return ok(
      Object.freeze({
        state: parsedState.data,
        evidenceKind: parsedEvidenceKind.data,
        evidenceOutcome: parsedEvidenceOutcome.data,
        reason: parsedReason.data,
        ruleId: parsedRuleId.data,
      }),
    );
  },
  () => makeJournalWriteFailedFailure("invalid-provider-fast-state"),
);

/**
 * Copy only the closed sanitized provider-fast public snapshot. Extra keys,
 * raw provider/model strings, and secret-shaped fields never enter the copy.
 */
export function projectProviderFastJournalData(
  snapshot: ProviderFastPublicSnapshot,
): Result<PiProviderFastJournalData, PiAdapterFailure> {
  return inspectProviderFastPublicState(snapshot).andThen((copied) => copied);
}

/**
 * The durable identity of one outcome. Evidence outcome is part of it because
 * `not-confirmed` for standard-tier evidence and `not-confirmed` for evidence
 * that could not be read are different facts an operator needs to tell apart.
 */
function providerFastDedupeKey(data: PiProviderFastJournalData): string {
  return `${data.state}:${data.reason}:${data.evidenceOutcome}`;
}

/**
 * Render the optional `/weave:status` fast line from sanitized public state.
 *
 * No declared intent produces no line. The state always leads, so the five
 * neutral states are distinguishable at a glance, and the parenthesized detail
 * is built from bounded tokens only: the allowlist rule id when one matched,
 * the bounded reason when there is something to explain, and the evidence kind
 * and outcome when a request actually carried controls. No model text,
 * provider string, URL, header name, or header value can reach this line,
 * because the projection would have rejected the snapshot first.
 */
export function renderProviderFastStatusLine(
  snapshot: ProviderFastPublicSnapshot | undefined,
): Result<string | undefined, PiAdapterFailure> {
  if (snapshot === undefined) {
    return ok(void 0);
  }
  return projectProviderFastJournalData(snapshot).map((data) => {
    const details: string[] = [];
    if (data.ruleId !== undefined) {
      details.push(data.ruleId);
    }
    if (data.reason !== "none") {
      details.push(data.reason);
    }
    if (data.evidenceKind !== "none") {
      details.push(`${data.evidenceKind}=${data.evidenceOutcome}`);
    }
    return details.length === 0
      ? `fast: ${data.state}`
      : `fast: ${data.state} (${details.join(", ")})`;
  });
}

/**
 * Field names that must never appear in doctor / journal-adjacent diagnostic
 * payloads. Matching is case-insensitive on the final path segment.
 */
const DIAGNOSTIC_FORBIDDEN_FIELD_PATTERN =
  /^(prompt|prompts|transcript|transcripts|message|messages|content|contents|assistant|thinking|reasoningtext|tool|tools|toolresult|toolresults|task|output|text|path|absolutepath|sessionpath)$/iu;

const ABSOLUTE_PATH_LIKE = /(?:^|[\s"'])(?:\/|[A-Za-z]:\\|\\\\)/u;
const PiDiagnosticJsonSchema: z.ZodType<JsonValue> = z.json();

/**
 * Recursively strips transcript-like keys and absolute filesystem path strings
 * from a diagnostic value. Used by the child doctor report assembler.
 */
function sanitizeParsedDiagnosticValue(value: JsonValue): JsonValue {
  const stringValue = z.string().safeParse(value);
  if (stringValue.success) {
    if (
      stringValue.data.startsWith("/") ||
      stringValue.data.startsWith("\\\\") ||
      /^[A-Za-z]:[\\/]/u.test(stringValue.data) ||
      ABSOLUTE_PATH_LIKE.test(stringValue.data)
    ) {
      return "[omitted]";
    }
    return stringValue.data;
  }

  const arrayValue = z.array(PiDiagnosticJsonSchema).safeParse(value);
  if (arrayValue.success) {
    return arrayValue.data.map((entry) => sanitizeParsedDiagnosticValue(entry));
  }

  const objectValue = z
    .record(z.string(), PiDiagnosticJsonSchema)
    .safeParse(value);
  if (objectValue.success) {
    const out: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(objectValue.data)) {
      if (DIAGNOSTIC_FORBIDDEN_FIELD_PATTERN.test(key)) continue;
      out[key] = sanitizeParsedDiagnosticValue(nested);
    }
    return out;
  }

  return value;
}

const parseDiagnosticValue = Result.fromThrowable(
  (value: JsonValue | undefined): JsonValue | undefined => {
    const parsed = PiDiagnosticJsonSchema.safeParse(value);
    return parsed.success
      ? sanitizeParsedDiagnosticValue(parsed.data)
      : undefined;
  },
  () => void 0,
);

export function sanitizeDiagnosticValue(
  value: JsonValue | undefined,
): JsonValue | undefined {
  return parseDiagnosticValue(value).unwrapOr(void 0);
}

export interface PiJournalEventInput {
  readonly family: PiJournalFamily;
  /** Event name within the family, e.g. "activated", "settled". */
  readonly event: string;
  readonly severity: JournalSeverity;
  readonly workflowInstanceId?: string;
  readonly executionId?: string;
  readonly stepId?: string;
  readonly data?: PiJournalSafeData;
}

export type PiAssistantUsageSource = "primary" | "child";

export interface PiAssistantUsageInput {
  /** Stable Pi message identity — never derived from text (Pi adapter contract). */
  readonly id: string;
  readonly source: PiAssistantUsageSource;
  readonly workflowInstanceId?: string;
  readonly stepId?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
  /** Optional stable event timestamp (ISO8601). Defaults to a per-id timestamp retained by this generation for retry-safe exact-once comparison. */
  readonly timestamp?: string;
}

export type PiUsageRecordOutcome = "inserted" | "noop";

type PiUsageJournalData = {
  source: PiAssistantUsageSource;
  agentName?: string;
  model?: string;
};

/** Injected journal-write seam. Satisfied by `RuntimeJournalWriter.write`. */
export type PiJournalPort = Pick<RuntimeJournalWriter, "write">;

/** Injected usage-ledger seam. Satisfied by `RuntimeStore["usage"]`. */
export type PiUsagePort = Pick<RuntimeStore["usage"], "recordObservation">;

/** Injected retention seam. Satisfied by `RuntimeRetentionService`. */
export type PiRetentionPort = Pick<
  RuntimeRetentionService,
  "onActivation" | "onRelevantWrite" | "stop"
>;

/** Minimal TUI diagnostics port — one `notify` call, no host coupling. */
export interface PiTelemetryUiPort {
  notify(message: string, level: "info" | "warning" | "error"): void;
}

/** Narrow usage-recording surface consumed by delegation/primary wiring. */
export interface PiTelemetryUsageSink {
  recordAssistantUsage(
    input: PiAssistantUsageInput,
  ): ResultAsync<PiUsageRecordOutcome, PiAdapterFailure>;
}

function impactToLevel(
  impact: PiAdapterFailure["impact"],
): "info" | "warning" | "error" {
  if (impact === "degraded") return "warning";
  if (impact === "operation-stopped") return "warning";
  return "error";
}

function failureScopeKey(failure: PiAdapterFailure): string {
  const scope = failure.scope;
  const scopeId = scope.kind === "adapter" ? "adapter" : scope.id;
  const correlationId =
    failure.correlation !== undefined
      ? String(
          failure.correlation.correlationId ?? failure.correlation.reason ?? "",
        )
      : "";
  return `${failure.code}:${scope.kind}:${scopeId}:${correlationId}`;
}

/**
 * Extracts the safe usage fields from a settled assistant message's RPC
 * envelope. Mirrors the shape Pi's `message_end`/`agent_settled` events
 * carry (`message.role === "assistant"`, `message.usage.{input,output,
 * cacheRead,cacheWrite}`, `message.usage.cost.total`) without ever
 * returning the message text itself.
 */
const PiObservedJsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z
      .number()
      .or(z.literal(Number.POSITIVE_INFINITY))
      .or(z.literal(Number.NEGATIVE_INFINITY))
      .or(z.nan()),
    z.boolean(),
    z.null(),
    z.array(PiObservedJsonSchema),
    z.record(z.string(), PiObservedJsonSchema),
  ]),
);
const PiObservedRecordSchema = z.record(z.string(), PiObservedJsonSchema);
const NonNegativeFiniteNumberSchema = z.number().finite().nonnegative();

const parseAssistantUsageRecord = Result.fromThrowable(
  (
    record: Record<string, JsonValue>,
  ):
    | { id: string; usage: Omit<PiAssistantUsageInput, "id" | "source"> }
    | undefined => {
    const messageResult = PiObservedRecordSchema.safeParse(record.message);
    if (!messageResult.success) return undefined;
    const messageRecord = messageResult.data;
    if (!z.literal("assistant").safeParse(messageRecord.role).success) {
      return undefined;
    }
    const idResult = z
      .string()
      .min(1)
      .safeParse(messageRecord.id ?? messageRecord.responseId);
    if (!idResult.success) return undefined;
    const id = idResult.data;
    const usageResult = PiObservedRecordSchema.safeParse(messageRecord.usage);
    if (!usageResult.success) return { id, usage: {} };
    const usageRecord = usageResult.data;
    return {
      id,
      usage: {
        inputTokens: safeNonNegativeNumber(usageRecord.input),
        outputTokens: safeNonNegativeNumber(usageRecord.output),
        cacheReadTokens: safeNonNegativeNumber(usageRecord.cacheRead),
        cacheWriteTokens: safeNonNegativeNumber(usageRecord.cacheWrite),
        cost: extractSafeCostTotal(usageRecord.cost),
      },
    };
  },
  () => void 0,
);

export function extractAssistantUsageFromMessage(
  record: Record<string, JsonValue>,
):
  | { id: string; usage: Omit<PiAssistantUsageInput, "id" | "source"> }
  | undefined {
  return parseAssistantUsageRecord(record).unwrapOr(void 0);
}

function safeNonNegativeNumber(
  value: JsonValue | undefined,
): number | undefined {
  const parsed = NonNegativeFiniteNumberSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function extractSafeCostTotal(
  value: JsonValue | undefined,
): number | undefined {
  const direct = safeNonNegativeNumber(value);
  if (direct !== undefined) return direct;
  const objectResult = PiObservedRecordSchema.safeParse(value);
  return objectResult.success
    ? safeNonNegativeNumber(objectResult.data.total)
    : undefined;
}

export interface PiTelemetryOptions {
  readonly store: RuntimeStore;
  readonly settings: RuntimeSettings;
  readonly projectRoot: string;
  readonly clock: Clock;
  /** Fallback logger used when the rotating sink cannot be constructed. */
  readonly fallbackLogger: PiAdapterLogger;
  /** Injectable log filesystem seam (defaults to Bun no-follow production impl). */
  readonly logFileSystem?: RuntimeLogFileSystem;
  /** Injectable journal seam (defaults to a real `RuntimeJournalWriter`). */
  readonly journal?: PiJournalPort;
  /** Injectable usage seam (defaults to `store.usage`). */
  readonly usage?: PiUsagePort;
  /** Injectable retention seam (defaults to a real `RuntimeRetentionService`). */
  readonly retention?: PiRetentionPort;
}

/**
 * One adapter-side telemetry unit per generation (Pi adapter contract). Constructed
 * once activation is confirmed trusted and healthy; disposed on shutdown.
 */
export class PiTelemetry implements PiTelemetryUsageSink {
  private readonly journal: PiJournalPort;
  private readonly usage: PiUsagePort;
  private readonly retention: PiRetentionPort;
  private readonly logger: PiAdapterLogger;
  private readonly clock: Clock;
  private readonly maxTrackedUsageIds: number;
  private readonly notified = new Set<string>();
  private readonly usageTimestamps = new Map<string, string>();
  /** Bounded FIFO of recorded terminal outcome keys; oldest entries evict. */
  private readonly providerFastReported = new Set<string>();
  private readonly disposeLogSink:
    | (() => ResultAsync<void, PiAdapterFailure>)
    | undefined;
  private shutdownOperation: ResultAsync<void, PiAdapterFailure> | undefined;

  constructor(deps: {
    readonly journal: PiJournalPort;
    readonly usage: PiUsagePort;
    readonly retention: PiRetentionPort;
    readonly logger: PiAdapterLogger;
    readonly clock: Clock;
    readonly maxTrackedUsageIds: number;
    readonly disposeLogSink?: () => ResultAsync<void, PiAdapterFailure>;
  }) {
    this.journal = deps.journal;
    this.usage = deps.usage;
    this.retention = deps.retention;
    this.logger = deps.logger;
    this.clock = deps.clock;
    this.maxTrackedUsageIds = deps.maxTrackedUsageIds;
    this.disposeLogSink = deps.disposeLogSink;
  }

  /** Scoped logger for adapter code that wants the rotating sink directly. */
  getLogger(): PiAdapterLogger {
    return this.logger;
  }

  /**
   * Persist one sanitized provider-fast outcome.
   *
   * Each distinct `(state, reason, evidenceOutcome)` tuple persists once per
   * session, so a session that reaches `requested` and then settles at
   * `not-confirmed` keeps both facts, while a hundred repeats of either keep
   * one record each. `requested` is journaled as exactly that: the dedupe key
   * and the event name both carry the state, so a transient request can never
   * be read back as an application. The dedupe window itself is bounded.
   */
  recordProviderFastTransition(
    snapshot: ProviderFastPublicSnapshot,
  ): ResultAsync<PiProviderFastJournalRecordOutcome, PiAdapterFailure> {
    const projected = projectProviderFastJournalData(snapshot);
    if (projected.isErr()) {
      return errAsync(projected.error);
    }
    const data = projected.value;
    const key = providerFastDedupeKey(data);
    if (this.providerFastReported.has(key)) {
      return okAsync("duplicate");
    }
    // Claim the key before the write starts. Two settled turns can call this
    // before the first write resolves, and a claim made only on success
    // would let both of them persist the same outcome.
    this.rememberProviderFastKey(key);
    return this.recordJournalEvent({
      family: "provider-fast",
      event: data.state,
      severity: PI_PROVIDER_FAST_SEVERITY[data.state],
      data,
    })
      .map(() => "recorded" as const)
      .mapErr((failure) => {
        // Nothing was persisted, so a later attempt may try again.
        this.providerFastReported.delete(key);
        return failure;
      });
  }

  private rememberProviderFastKey(key: string): void {
    this.providerFastReported.add(key);
    while (this.providerFastReported.size > PI_PROVIDER_FAST_DEDUPE_LIMIT) {
      const oldest = this.providerFastReported.values().next();
      if (oldest.done === true) {
        return;
      }
      this.providerFastReported.delete(oldest.value);
    }
  }

  /**
   * Clear in-memory provider-fast reporting dedupe after session replacement.
   * Durable journal events stay as bounded audit facts.
   */
  resetProviderFastReporting(): void {
    this.providerFastReported.clear();
  }

  /**
   * Activates retention pruning for this generation (Pi adapter contract): runs
   * an immediate pass and arms the interval/threshold-based scheduler.
   * Never blocks adapter activation — a failure degrades and is reported
   * via the returned `err`, but callers must not treat it as fatal.
   */
  activate(): ResultAsync<void, PiAdapterFailure> {
    return this.recordJournalEvent({
      family: "activation-health",
      event: "telemetry-activated",
      severity: "info",
    })
      .orElse(() => okAsync(void 0))
      .andThen(() => this.retention.onActivation())
      .andThen(() => okAsync(void 0))
      .mapErr((cause) => makeRetentionFailedFailure(safeStoreErrorType(cause)));
  }

  /**
   * Writes one normalized Runtime Journal entry and, on success, notifies
   * the retention service of a relevant write (best-effort — a retention
   * failure here is logged but never returned as this call's error, since
   * the journal write itself already durably succeeded).
   */
  recordJournalEvent(
    input: PiJournalEventInput,
  ): ResultAsync<void, PiAdapterFailure> {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.event)) {
      return errAsync(makeJournalWriteFailedFailure("invalid-event-name"));
    }
    const data: JsonObject = input.data === undefined ? {} : { ...input.data };
    return this.journal
      .write({
        source: { kind: "adapter", name: "pi" },
        eventType: `${input.family}.${input.event}`,
        severity: input.severity,
        executionId:
          input.executionId !== undefined
            ? createExecutionLeaseId(input.executionId)
            : undefined,
        workflowInstanceId:
          input.workflowInstanceId !== undefined
            ? createWorkflowInstanceId(input.workflowInstanceId)
            : undefined,
        stepId: input.stepId,
        data,
      })
      .andThen(() =>
        this.retention.onRelevantWrite().orElse((cause) => {
          this.logger.warn(
            { reason: safeStoreErrorType(cause) },
            "retention onRelevantWrite degraded after journal write",
          );
          return okAsync(null);
        }),
      )
      .andThen(() => okAsync(void 0))
      .mapErr((cause) =>
        makeJournalWriteFailedFailure(safeStoreErrorType(cause)),
      );
  }

  /**
   * Records exactly one usage observation for a settled primary or child
   * assistant message (Pi adapter contract). Identity is the caller-supplied
   * stable Pi message ID, never text. The underlying store is idempotent:
   * the same ID with the same normalized values is a no-op; the same ID
   * with different values is a closed `InvariantViolation` failure.
   */
  recordAssistantUsage(
    input: PiAssistantUsageInput,
  ): ResultAsync<PiUsageRecordOutcome, PiAdapterFailure> {
    const observation: UsageObservation = {
      id: createUsageObservationId(input.id),
      timestamp: this.resolveUsageTimestamp(input.id, input.timestamp),
      source: {
        kind: "adapter",
        name: input.source === "primary" ? "pi-primary" : "pi-child",
      },
      workflowInstanceId:
        input.workflowInstanceId !== undefined
          ? createWorkflowInstanceId(input.workflowInstanceId)
          : undefined,
      stepId: input.stepId,
      agentName: input.agentName,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      totalTokens: input.totalTokens,
      cost: input.cost,
    };
    return this.usage
      .recordObservation(observation)
      .andThen((result) => {
        if (result.kind === "noop") return okAsync("noop" as const);
        return this.recordJournalEvent({
          family: "usage",
          event: "observation-recorded",
          severity: "info",
          workflowInstanceId: input.workflowInstanceId,
          stepId: input.stepId,
          data: (() => {
            const data: PiUsageJournalData = { source: input.source };
            if (input.agentName !== undefined) {
              data.agentName = input.agentName;
            }
            if (input.model !== undefined) {
              data.model = input.model;
            }
            return data;
          })(),
        })
          .orElse(() => okAsync(void 0))
          .map(() => "inserted" as const);
      })
      .mapErr((cause: RuntimeStoreError) => {
        if (cause.type === "invariant_violation") {
          return makeInvariantViolationFailure(
            "usage-observation-id-reused-with-different-values",
          );
        }
        return makeUsageWriteFailedFailure(cause.type);
      });
  }

  /**
   * Deduplicates a TUI diagnostic by failure code, scope, and safe
   * correlation ID (Pi adapter contract). Exposes exactly one notification per
   * unique identity — repeat calls for the same identity are no-ops.
   */
  notifyFailureOnce(ui: PiTelemetryUiPort, failure: PiAdapterFailure): void {
    const key = failureScopeKey(failure);
    if (this.notified.has(key)) return;
    this.notified.add(key);
    ui.notify(
      `${failure.safeMessage} (${failure.recovery})`,
      impactToLevel(failure.impact),
    );
  }

  private resolveUsageTimestamp(
    id: string,
    supplied: string | undefined,
  ): string {
    const existing = this.usageTimestamps.get(id);
    if (supplied === undefined && existing !== undefined) return existing;

    const timestamp = supplied ?? new Date(this.clock.now()).toISOString();
    if (existing === undefined) {
      if (this.usageTimestamps.size >= this.maxTrackedUsageIds) {
        const oldest = this.usageTimestamps.keys().next().value;
        if (oldest !== undefined) this.usageTimestamps.delete(oldest);
      }
      this.usageTimestamps.set(id, timestamp);
    }
    return timestamp;
  }

  /** Records a telemetry-degradation journal entry and always logs, without recursing through a failed sink. */
  recordDegradation(failure: PiAdapterFailure): void {
    this.logger.warn(
      { code: failure.code, phase: failure.phase, impact: failure.impact },
      "telemetry degraded",
    );
    void this.recordJournalEvent({
      family: "telemetry-degradation",
      event: "degraded",
      severity: "warn",
      data: {
        code: failure.code,
        phase: failure.phase,
        impact: failure.impact,
      },
    }).orElse(() => okAsync(void 0));
  }

  /** Stops retention scheduling and releases the rotating log sink. Idempotent. */
  shutdown(): ResultAsync<void, PiAdapterFailure> {
    if (this.shutdownOperation !== undefined) return this.shutdownOperation;
    this.retention.stop();
    this.notified.clear();
    this.usageTimestamps.clear();
    this.providerFastReported.clear();
    this.shutdownOperation = this.disposeLogSink?.() ?? okAsync(void 0);
    return this.shutdownOperation;
  }
}

function safeStoreErrorType(cause: RuntimeStoreError): string {
  return cause.type;
}

/**
 * Builds the production rotating pino sink for `.weave/runtime/logs/
 * pi-adapter.ndjson` (Pi adapter contract), reusing the engine's
 * `createRotatingRuntimeLogSink` (no-follow identities, atomic rotation,
 * serialized rotation/pruning). On failure, degrades to `fallbackLogger`
 * rather than blocking activation — the caller decides whether to surface
 * the returned failure as a visible degradation.
 */
export function createPiTelemetryLogger(options: {
  readonly projectRoot: string;
  readonly settings: RuntimeSettings["log"];
  readonly fallbackLogger: PiAdapterLogger;
  readonly fs?: RuntimeLogFileSystem;
}): ResultAsync<
  {
    logger: PiAdapterLogger;
    dispose: () => ResultAsync<void, PiAdapterFailure>;
  },
  PiAdapterFailure
> {
  return createRotatingRuntimeLogSink({
    projectRoot: options.projectRoot,
    fileName: "pi-adapter.ndjson",
    settings: options.settings,
    fs: options.fs ?? new BunRuntimeLogFileSystem(),
  })
    .map((sink) => {
      const destination = asPinoDestination(sink);
      const root = pino({ name: "weave", level: "info" }, destination);
      const scoped = root.child({ module: "adapter-pi" });
      const logger: PiAdapterLogger = {
        debug: (obj, msg) => scoped.debug(obj, msg),
        info: (obj, msg) => scoped.info(obj, msg),
        warn: (obj, msg) => scoped.warn(obj, msg),
        error: (obj, msg) => scoped.error(obj, msg),
      };
      return {
        logger,
        dispose: () =>
          sink.close().mapErr((cause) => makeLogWriteFailedFailure(cause.type)),
      };
    })
    .mapErr((cause) => makeLogWriteFailedFailure(cause.type));
}

/**
 * Builds a `PiTelemetry` instance for a freshly activated, trusted, healthy
 * generation. Never fails outright: a rotating-log-sink failure degrades to
 * `deps.fallbackLogger` (surfaced via the returned `logDegradation`, which
 * the caller should route through `recordDegradation`/`notifyFailureOnce`).
 */
export function createPiTelemetry(
  options: PiTelemetryOptions,
): ResultAsync<
  { telemetry: PiTelemetry; logDegradation?: PiAdapterFailure },
  never
> {
  const journal =
    options.journal ??
    new RuntimeJournalWriter(options.store.journal, {
      strictMode: options.settings.journal.strict,
    });
  const usage = options.usage ?? options.store.usage;
  const retention =
    options.retention ??
    new RuntimeRetentionService({
      store: options.store,
      settings: options.settings,
      clock: () => new Date(options.clock.now()),
    });

  const resultPromise = createPiTelemetryLogger({
    projectRoot: options.projectRoot,
    settings: options.settings.log,
    fallbackLogger: options.fallbackLogger,
    fs: options.logFileSystem,
  }).match(
    ({ logger, dispose }) => ({
      telemetry: new PiTelemetry({
        journal,
        usage,
        retention,
        logger,
        clock: options.clock,
        maxTrackedUsageIds: options.settings.usage.max_observations,
        disposeLogSink: dispose,
      }),
    }),
    (logDegradation) => ({
      telemetry: new PiTelemetry({
        journal,
        usage,
        retention,
        logger: options.fallbackLogger,
        clock: options.clock,
        maxTrackedUsageIds: options.settings.usage.max_observations,
      }),
      logDegradation,
    }),
  );

  return ResultAsync.fromSafePromise(resultPromise);
}
