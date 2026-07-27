/**
 * Serialized retention/pruning service for Runtime Store journal + usage detail.
 *
 * Runtime Store retention contract:
 * - Prune after activation, then after 256 relevant writes or 15 minutes
 * - Age first, then oldest above count
 * - One serialized single-flight task
 * - Failure degrades and retries only at the next safe boundary
 * - `journal.strict=true` only affects correlated journal write transactions,
 *   not this background retention path
 */

import type { RuntimeSettings } from "@weaveio/weave-core";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { logger } from "../logger.js";
import { type RuntimeStoreError, retentionError } from "./errors.js";
import type { RuntimeStore } from "./store.js";
import type { RetentionPruneStats } from "./types.js";

const log = logger.child({ module: "runtime-retention" });

/** Default relevant-write threshold before the next prune attempt. */
export const DEFAULT_RETENTION_WRITE_THRESHOLD = 256;

/** Default wall-clock interval (ms) before the next prune attempt. */
export const DEFAULT_RETENTION_INTERVAL_MS = 15 * 60 * 1000;

export interface RuntimeRetentionServiceOptions {
  readonly store: RuntimeStore;
  readonly settings: RuntimeSettings;
  /** Injected clock for deterministic tests. Default: `() => new Date()`. */
  readonly clock?: () => Date;
  /**
   * Number of relevant writes that schedule a prune at the next safe boundary.
   * Default: 256.
   */
  readonly writeThreshold?: number;
  /**
   * Milliseconds after which a prune is scheduled at the next safe boundary.
   * Default: 15 minutes.
   */
  readonly intervalMs?: number;
  /**
   * Optional timer scheduler for tests. Defaults to `setTimeout`/`clearTimeout`.
   */
  readonly scheduler?: RetentionScheduler;
}

export interface RetentionScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface RetentionRunResult {
  readonly journal: RetentionPruneStats;
  readonly usage: RetentionPruneStats;
  readonly ranAt: string;
}

const defaultScheduler: RetentionScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Coordinates bounded pruning for journal entries and usage detail rows.
 *
 * Stateful coordination lives on this class — no module-level mutable state.
 */
export class RuntimeRetentionService {
  private readonly store: RuntimeStore;
  private readonly settings: RuntimeSettings;
  private readonly clock: () => Date;
  private readonly writeThreshold: number;
  private readonly intervalMs: number;
  private readonly scheduler: RetentionScheduler;

  private writesSinceLastRun = 0;
  private lastRunAtMs: number | null = null;
  private inFlight: ResultAsync<RetentionRunResult, RuntimeStoreError> | null =
    null;
  private pendingSafeBoundary = false;
  private timerHandle: unknown = null;
  private stopped = false;

  constructor(options: RuntimeRetentionServiceOptions) {
    this.store = options.store;
    this.settings = options.settings;
    this.clock = options.clock ?? (() => new Date());
    this.writeThreshold =
      options.writeThreshold ?? DEFAULT_RETENTION_WRITE_THRESHOLD;
    this.intervalMs = options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  /**
   * Run pruning immediately after activation. Also arms the interval timer.
   */
  onActivation(): ResultAsync<RetentionRunResult, RuntimeStoreError> {
    if (this.stopped) {
      return errAsync(retentionError("retention service is stopped"));
    }
    this.armIntervalTimer();
    return this.runSingleFlight();
  }

  /**
   * Record a relevant write. When the write threshold or interval is met,
   * schedules a single-flight prune at this safe boundary.
   */
  onRelevantWrite(): ResultAsync<RetentionRunResult | null, RuntimeStoreError> {
    if (this.stopped) {
      return errAsync(retentionError("retention service is stopped"));
    }

    this.writesSinceLastRun += 1;
    if (this.shouldRunAtSafeBoundary()) {
      return this.runSingleFlight().map((result) => result);
    }
    return okAsync(null);
  }

  /**
   * Force a prune attempt at a caller-defined safe boundary (e.g. after a
   * committed unit of work). No-ops when neither threshold nor interval is due.
   */
  runIfDue(): ResultAsync<RetentionRunResult | null, RuntimeStoreError> {
    if (this.stopped) {
      return errAsync(retentionError("retention service is stopped"));
    }
    if (!this.shouldRunAtSafeBoundary() && !this.pendingSafeBoundary) {
      return okAsync(null);
    }
    return this.runSingleFlight().map((result) => result);
  }

  /** Cancel timers and refuse further work. */
  stop(): void {
    this.stopped = true;
    this.clearIntervalTimer();
  }

  private shouldRunAtSafeBoundary(): boolean {
    if (this.writesSinceLastRun >= this.writeThreshold) return true;
    if (this.lastRunAtMs === null) return true;
    return this.clock().getTime() - this.lastRunAtMs >= this.intervalMs;
  }

  private armIntervalTimer(): void {
    this.clearIntervalTimer();
    if (this.stopped) return;
    this.timerHandle = this.scheduler.schedule(() => {
      this.timerHandle = null;
      if (this.stopped) return;
      this.pendingSafeBoundary = true;
      // Timer firings only mark due; actual prune happens at the next explicit
      // safe boundary (`runIfDue` / `onRelevantWrite` / `onActivation`).
      // If nothing else is running, attempt immediately as a safe boundary.
      void this.runSingleFlight().match(
        () => undefined,
        (error) => {
          log.warn({ err: error }, "scheduled retention prune failed");
        },
      );
      this.armIntervalTimer();
    }, this.intervalMs);
  }

  private clearIntervalTimer(): void {
    if (this.timerHandle === null) return;
    this.scheduler.cancel(this.timerHandle);
    this.timerHandle = null;
  }

  private runSingleFlight(): ResultAsync<
    RetentionRunResult,
    RuntimeStoreError
  > {
    if (this.inFlight) return this.inFlight;

    this.pendingSafeBoundary = false;
    const started = this.executePrune().map((result) => {
      this.writesSinceLastRun = 0;
      this.lastRunAtMs = this.clock().getTime();
      return result;
    });

    // Keep the same ResultAsync instance for single-flight joiners. Clear the
    // slot after settlement so the next safe boundary can retry failures.
    this.inFlight = ResultAsync.fromPromise(
      started.match(
        (value) => value,
        (error) => {
          throw error;
        },
      ),
      (cause) => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "type" in cause &&
          (cause as RuntimeStoreError).type !== undefined
        ) {
          return cause as RuntimeStoreError;
        }
        return retentionError("retention prune failed", cause);
      },
    )
      .map((result) => {
        this.inFlight = null;
        return result;
      })
      .mapErr((error) => {
        this.inFlight = null;
        log.warn({ err: error }, "retention prune degraded; will retry later");
        return error;
      });

    return this.inFlight;
  }

  private executePrune(): ResultAsync<RetentionRunResult, RuntimeStoreError> {
    const now = this.clock();
    const journalOlderThan = ageCutoffIso(
      now,
      this.settings.journal.retention_days,
    );
    const usageOlderThan = ageCutoffIso(
      now,
      this.settings.usage.detail_retention_days,
    );

    return this.store.journal
      .prune({
        olderThan: journalOlderThan,
        maxCount: this.settings.journal.max_entries,
      })
      .andThen((journal) =>
        this.store.usage
          .pruneDetails({
            olderThan: usageOlderThan,
            maxCount: this.settings.usage.max_observations,
          })
          .map((usage) => ({
            journal,
            usage,
            ranAt: now.toISOString(),
          })),
      )
      .mapErr((error) => {
        if (error.type === "retention") return error;
        return retentionError("retention prune failed", error);
      });
  }
}

function ageCutoffIso(now: Date, retentionDays: number): string {
  const ms = retentionDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms).toISOString();
}
