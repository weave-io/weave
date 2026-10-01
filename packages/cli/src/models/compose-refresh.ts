/**
 * Model recommendations at Claude Code session start (Spec 39, item 6b).
 *
 * The Claude Code bootstrap plugin's `SessionStart` hook runs
 * `weave compose --adapter claude-code`, a short-lived process. Composition
 * reads whatever list is already applied; once the bundle is written, this
 * class checks for a newer one, so a list fetched in one session applies at
 * the next.
 *
 * The check is awaited, with a bound, rather than left running or handed to a
 * detached child:
 *
 * - It starts only after composition has finished and its output is written,
 *   so it never delays or changes the bundle.
 * - Most calls are throttled by `ModelRecommendations` itself and cost one
 *   read of `state.json`. When a check is due (at most once a day, or once an
 *   hour after a failure), compose gives the whole request
 *   `COMPOSE_REFRESH_TIMEOUT_MS` and stops waiting after
 *   `COMPOSE_REFRESH_BUDGET_MS`, well inside the hook's 30 second timeout.
 * - The request is aborted at its own timeout, so nothing is left to keep the
 *   process alive, the cache lock is released by the process that took it,
 *   and no orphaned child outlives the hook.
 * - Every failure is a result: the hook's exit code is compose's, and nothing
 *   is written to stdout, which Claude Code adds to the session's context.
 *
 * The normative description is Spec 39 and the Claude Code adapter guide:
 * docs/specs/39-spec-model-recommendations/39-spec-model-recommendations.md,
 * docs/adapters/claude-code.md#model-recommendations
 */

import {
  describeRefreshFailure,
  type RefreshError,
  type RefreshOutcome,
  type RefreshRequest,
  resolveModelUpdates,
} from "@weaveio/weave-config";
import type { ModelUpdatesSettings } from "@weaveio/weave-core";
import { logger } from "@weaveio/weave-engine";
import { ResultAsync } from "neverthrow";

const log = logger.child({ module: "cli-compose-model-updates" });

/** The whole request, body included, must finish within this (1.5 seconds). */
export const COMPOSE_REFRESH_TIMEOUT_MS = 1500;

/** Compose stops waiting for the refresh after this (2 seconds). */
export const COMPOSE_REFRESH_BUDGET_MS = 2000;

/**
 * What compose lets a caller inject into its `ModelRecommendations`: the
 * parts that the refresh and the config loader can both honour. The cache
 * location (`WEAVE_GLOBAL_CONFIG_DIR`) and the cache file access are not
 * injectable here, because the loader reads `applied.json` through compose's
 * own filesystem; a refresh writing elsewhere would never be applied.
 */
export interface ComposeModelRecommendationsDeps {
  /** The subset of `fetch` the refresh uses. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The current time, for the throttle and for checking list dates. */
  readonly now?: () => Date;
  /** Ed25519 public keys that may sign lists; verifies fetched and applied lists. */
  readonly publicKeys?: readonly string[];
  /** Where lists are fetched from. Defaults as `ModelRecommendations` does. */
  readonly baseUrl?: string;
  /** Request timeout. Defaults to `COMPOSE_REFRESH_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The part of `ModelRecommendations` compose uses. */
export interface ModelRecommendationsRefresher {
  refresh(request: RefreshRequest): ResultAsync<RefreshOutcome, RefreshError>;
}

/** The refresher threw, or its promise rejected: a bug, reported as a value. */
export interface RefreshNotStarted {
  readonly type: "NotStarted";
  readonly message: string;
}

/** What the session-start refresh did. */
export type ComposeRefreshResult =
  /** No `model_updates` block, or `mode off`: `refresh()` was not called. */
  | { readonly type: "Off" }
  | { readonly type: "Refreshed"; readonly outcome: RefreshOutcome }
  | {
      readonly type: "Failed";
      readonly error: RefreshError | RefreshNotStarted;
    }
  /** The budget ran out first; the refresh finishes or times out on its own. */
  | { readonly type: "StillRunning"; readonly budgetMs: number };

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Runs one bounded `refresh()` for a compose. Never throws; with model
 * updates off it does nothing at all.
 */
export class ComposeModelRefresh {
  constructor(
    private readonly refresher: ModelRecommendationsRefresher,
    private readonly budgetMs: number = COMPOSE_REFRESH_BUDGET_MS,
  ) {}

  /** Refresh for the merged `settings.model_updates`, waiting at most the budget. */
  async run(
    settings: ModelUpdatesSettings | undefined,
  ): Promise<ComposeRefreshResult> {
    if (resolveModelUpdates(settings) === undefined) return { type: "Off" };
    // A refresher that throws, or whose promise rejects, is a bug; it comes
    // back as `NotStarted` rather than as an exception.
    const refresh = ResultAsync.fromThrowable(
      async () => this.refresher.refresh({ settings }),
      (cause): RefreshNotStarted => ({
        type: "NotStarted",
        message: causeMessage(cause),
      }),
    );
    const settled: Promise<ComposeRefreshResult> = refresh()
      .andThen((result) => result)
      .match(
        (outcome): ComposeRefreshResult => ({ type: "Refreshed", outcome }),
        (error): ComposeRefreshResult => ({ type: "Failed", error }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<ComposeRefreshResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ type: "StillRunning", budgetMs: this.budgetMs }),
        this.budgetMs,
      );
    });
    const result = await Promise.race([settled, budget]);
    clearTimeout(timer);
    return this.report(result);
  }

  private report(result: ComposeRefreshResult): ComposeRefreshResult {
    if (result.type === "StillRunning") {
      log.warn(
        { code: "model_updates_refresh_pending", budgetMs: result.budgetMs },
        "Model recommendations check is still running; compose is not waiting for it",
      );
      return result;
    }
    if (result.type === "Failed") {
      // Another process holding the lock is doing this refresh for us.
      if (result.error.type === "Busy") return result;
      log.warn(
        { code: "model_updates_refresh_failed", error: result.error.type },
        "Model recommendations could not be refreshed",
      );
      return result;
    }
    if (result.type === "Refreshed" && "promoted" in result.outcome) {
      const promoted = result.outcome.promoted;
      if (promoted !== undefined)
        log.info(
          {
            channel: result.outcome.channel,
            issued: promoted.issued,
            previousIssued: promoted.previousIssued,
          },
          "Model recommendations promoted; the next compose applies them",
        );
    }
    return result;
  }
}

/**
 * A one-line, user-facing note about the refresh, or `undefined` when there is
 * nothing to say (off, throttled, unchanged, or another process refreshing).
 */
export function describeComposeRefresh(
  result: ComposeRefreshResult,
): string | undefined {
  switch (result.type) {
    case "Off":
      return undefined;
    case "StillRunning":
      return `Model recommendations: the check did not finish within ${result.budgetMs} ms; it is retried at a later session.`;
    case "Failed":
      return describeFailure(result.error);
    case "Refreshed":
      return describeOutcome(result.outcome);
  }
}

function describeFailure(
  error: RefreshError | RefreshNotStarted,
): string | undefined {
  switch (error.type) {
    case "Busy":
      return undefined;
    case "CheckFailed":
      return `Model recommendations: the check failed (${describeRefreshFailure(error.failure)}); it is retried within the hour.`;
    case "CacheFailed":
      return `Model recommendations: ${describeRefreshFailure(error.error)}.`;
    case "Unexpected":
    case "NotStarted":
      return `Model recommendations: the check failed unexpectedly: ${error.message}.`;
  }
}

function describeOutcome(outcome: RefreshOutcome): string | undefined {
  if (outcome.type === "Off" || outcome.type === "Throttled") return undefined;
  if (outcome.promoted !== undefined)
    return `Model recommendations issued ${outcome.promoted.issued} were applied; they take effect at the next session.`;
  if (outcome.type === "Downloaded")
    return `Model recommendations issued ${outcome.issued} were downloaded and wait to be applied (mode notify).`;
  return undefined;
}
