/**
 * Spec 33 §19 — adapter diagnostics, retention, and usage telemetry.
 *
 * Normalizes Runtime Journal families, records exactly-once usage
 * observations for settled primary/child assistant messages, activates
 * retention pruning at safe boundaries, and wires an engine-scoped rotating
 * pino sink. This module is a thin, injectable seam over the existing
 * engine Task 3 APIs (`RuntimeJournalWriter`, `RuntimeRetentionService`,
 * `createRotatingRuntimeLogSink`) — it never reimplements journal
 * validation, usage idempotency, retention pruning, or log rotation.
 *
 * See docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md §19.
 *
 * Data ban (§19.1): every method here accepts only bounded, closed-set safe
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
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import pino from "pino";
import {
  makeInvariantViolationFailure,
  makeJournalWriteFailedFailure,
  makeLogWriteFailedFailure,
  makeRetentionFailedFailure,
  makeUsageWriteFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { JsonValue } from "./strict-json.js";
import type { Clock, PiAdapterLogger } from "./types.js";

/**
 * Normalized Runtime Journal families this adapter emits (Spec 33 §19.2).
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
] as const;

export type PiJournalFamily = (typeof PI_JOURNAL_FAMILIES)[number];

/** Bounded safe-scalar payload — never raw prompts/output/args/payloads/paths. */
export type PiJournalSafeData = Readonly<
  Record<string, string | number | boolean>
>;

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
  /** Stable Pi message identity — never derived from text (Spec 33 §19.4). */
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
export function extractAssistantUsageFromMessage(
  record: Record<string, JsonValue>,
):
  | { id: string; usage: Omit<PiAssistantUsageInput, "id" | "source"> }
  | undefined {
  const message = record.message;
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return undefined;
  const messageRecord = message as Record<string, JsonValue>;
  if (messageRecord.role !== "assistant") return undefined;
  const id = messageRecord.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  const usageValue = messageRecord.usage;
  if (
    typeof usageValue !== "object" ||
    usageValue === null ||
    Array.isArray(usageValue)
  ) {
    return { id, usage: {} };
  }
  const usageRecord = usageValue as Record<string, JsonValue>;
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
}

function safeNonNegativeNumber(
  value: JsonValue | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  return value;
}

function extractSafeCostTotal(
  value: JsonValue | undefined,
): number | undefined {
  if (typeof value === "number") return safeNonNegativeNumber(value);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return safeNonNegativeNumber((value as Record<string, JsonValue>).total);
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
 * One adapter-side telemetry unit per generation (Spec 33 §19). Constructed
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
   * Activates retention pruning for this generation (Spec 33 §19.3): runs
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
      .orElse(() => okAsync(undefined))
      .andThen(() => this.retention.onActivation())
      .map(() => undefined)
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
    const data: JsonObject = { ...(input.data ?? {}) };
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
      .map(() => undefined)
      .mapErr((cause) =>
        makeJournalWriteFailedFailure(safeStoreErrorType(cause)),
      );
  }

  /**
   * Records exactly one usage observation for a settled primary or child
   * assistant message (Spec 33 §19.4). Identity is the caller-supplied
   * stable Pi message ID, never text. The underlying store is idempotent:
   * the same ID with the same normalized values is a no-op; the same ID
   * with different values is a closed `InvariantViolation` failure.
   */
  recordAssistantUsage(
    input: PiAssistantUsageInput,
  ): ResultAsync<PiUsageRecordOutcome, PiAdapterFailure> {
    const observation: UsageObservation = {
      id: input.id as UsageObservation["id"],
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
          data: {
            source: input.source,
            ...(input.agentName !== undefined
              ? { agentName: input.agentName }
              : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
          },
        })
          .orElse(() => okAsync(undefined))
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
   * correlation ID (Spec 33 §19.2). Exposes exactly one notification per
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
    }).orElse(() => okAsync(undefined));
  }

  /** Stops retention scheduling and releases the rotating log sink. Idempotent. */
  shutdown(): ResultAsync<void, PiAdapterFailure> {
    if (this.shutdownOperation !== undefined) return this.shutdownOperation;
    this.retention.stop();
    this.notified.clear();
    this.usageTimestamps.clear();
    this.shutdownOperation = this.disposeLogSink?.() ?? okAsync(undefined);
    return this.shutdownOperation;
  }
}

function safeStoreErrorType(cause: RuntimeStoreError): string {
  return cause.type;
}

/**
 * Builds the production rotating pino sink for `.weave/runtime/logs/
 * pi-adapter.ndjson` (Spec 33 §19.2), reusing the engine's
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
      return {
        logger: scoped as unknown as PiAdapterLogger,
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
