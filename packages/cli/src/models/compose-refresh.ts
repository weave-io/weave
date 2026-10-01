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
import { ok, okAsync, type Result, ResultAsync } from "neverthrow";

const log = logger.child({ module: "cli-compose-model-updates" });

/** The whole request, body included, must finish within this (1.5 seconds). */
export const COMPOSE_REFRESH_TIMEOUT_MS = 1500;

/** Compose stops waiting for the refresh after this (2 seconds). */
export const COMPOSE_REFRESH_BUDGET_MS = 2000;

/** The part of `ModelRecommendations` compose uses. */
export interface ModelRecommendationsRefresher {
  refresh(request: RefreshRequest): ResultAsync<RefreshOutcome, RefreshError>;
}

/** The refresher threw, or its promise rejected: a bug, reported as a value. */
export interface RefreshNotStarted {
  readonly type: "NotStarted";
  readonly message: string;
}

/** What the session-start refresh did, when it did not fail. */
export type ComposeRefreshOutcome =
  /** No `model_updates` block, or `mode off`: `refresh()` was not called. */
  | { readonly type: "Off" }
  | { readonly type: "Refreshed"; readonly outcome: RefreshOutcome }
  /** The budget ran out first; the refresh finishes or times out on its own. */
  | { readonly type: "StillRunning"; readonly budgetMs: number };

/** Why the session-start refresh failed. Compose reports it and carries on. */
export type ComposeRefreshError = RefreshError | RefreshNotStarted;

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
  run(
    settings: ModelUpdatesSettings | undefined,
  ): ResultAsync<ComposeRefreshOutcome, ComposeRefreshError> {
    if (resolveModelUpdates(settings) === undefined)
      return okAsync({ type: "Off" });
    // A refresher that throws, or whose promise rejects, is a bug; it comes
    // back as `NotStarted` rather than as an exception.
    const refresh = ResultAsync.fromThrowable(
      async () => this.refresher.refresh({ settings }),
      (cause): RefreshNotStarted => ({
        type: "NotStarted",
        message: causeMessage(cause),
      }),
    );
    const settled = refresh()
      .andThen((result) => result)
      .map(
        (outcome): ComposeRefreshOutcome => ({ type: "Refreshed", outcome }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<Result<ComposeRefreshOutcome, never>>(
      (resolve) => {
        timer = setTimeout(
          () => resolve(ok({ type: "StillRunning", budgetMs: this.budgetMs })),
          this.budgetMs,
        );
      },
    );
    return new ResultAsync(
      Promise.race([Promise.resolve(settled), budget]).then((result) => {
        clearTimeout(timer);
        return result;
      }),
    )
      .map((outcome) => this.reportOutcome(outcome))
      .mapErr((error) => this.reportError(error));
  }

  private reportOutcome(outcome: ComposeRefreshOutcome): ComposeRefreshOutcome {
    if (outcome.type === "StillRunning") {
      log.warn(
        { code: "model_updates_refresh_pending", budgetMs: outcome.budgetMs },
        "Model recommendations check is still running; compose is not waiting for it",
      );
      return outcome;
    }
    if (outcome.type !== "Refreshed" || !("promoted" in outcome.outcome))
      return outcome;
    const promoted = outcome.outcome.promoted;
    if (promoted === undefined) return outcome;
    log.info(
      {
        channel: outcome.outcome.channel,
        issued: promoted.issued,
        previousIssued: promoted.previousIssued,
      },
      "Model recommendations promoted; the next compose applies them",
    );
    return outcome;
  }

  private reportError(error: ComposeRefreshError): ComposeRefreshError {
    // Another process holding the lock is doing this refresh for us.
    if (error.type === "Busy") return error;
    log.warn(
      { code: "model_updates_refresh_failed", error: error.type },
      "Model recommendations could not be refreshed",
    );
    return error;
  }
}

/**
 * A one-line, user-facing note about the refresh, or `undefined` when there is
 * nothing to say (off, throttled, unchanged, or another process refreshing).
 */
export function describeComposeRefresh(
  result: Result<ComposeRefreshOutcome, ComposeRefreshError>,
): string | undefined {
  if (result.isErr()) return describeFailure(result.error);
  const outcome = result.value;
  switch (outcome.type) {
    case "Off":
      return undefined;
    case "StillRunning":
      return `Model recommendations: the check was still running after ${outcome.budgetMs} ms; compose has finished, and the check completes or times out on its own.`;
    case "Refreshed":
      return describeOutcome(outcome.outcome);
  }
}

function describeFailure(error: ComposeRefreshError): string | undefined {
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
    return `Model recommendations issued ${outcome.issued} were downloaded; run \`weave models apply\` to use them.`;
  return undefined;
}
