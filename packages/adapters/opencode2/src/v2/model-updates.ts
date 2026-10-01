/**
 * Model recommendations on OpenCode 2 (Spec 39, item 6).
 *
 * The catalog build only reads `applied.json` (through the source cache, so a
 * promotion is a probed source change). Fetching happens here, outside the
 * build, so a catalog attempt's exact bytes stay deterministic:
 *
 * - `OpenCode2ModelUpdatesTrigger` starts a background `refresh()` after the
 *   first catalog publish and on admitted work. It is single-flight per host
 *   and never awaited by the caller; `ModelRecommendations`' own throttle
 *   makes most calls a read of `state.json` and nothing else.
 * - `recommendedModelChanges()` decides whether a reload changed an agent's
 *   resolved model because a newer list was applied, which is what the
 *   `models.changed` RPC event (and the TUI notice built on it) reports.
 *
 * The normative description is Spec 39 and the OpenCode 2 core guide:
 * docs/specs/39-spec-model-recommendations/39-spec-model-recommendations.md,
 * docs/adapters/opencode2-core.md#model-recommendations
 */

import {
  type RefreshError,
  type RefreshOutcome,
  type RefreshRequest,
  resolveModelUpdates,
} from "@weaveio/weave-config";
import type {
  ModelUpdatesChannel,
  ModelUpdatesMode,
  ModelUpdatesSettings,
} from "@weaveio/weave-core";
import { logger } from "@weaveio/weave-engine";
import { Result, type ResultAsync } from "neverthrow";
import type { OpenCode2CatalogCandidate } from "./catalog.js";

const log = logger.child({ module: "adapter-opencode/v2/model-updates" });

/** What `status` reports about the recommendations layer. */
export type OpenCode2ModelUpdatesState =
  /** No `model_updates` block, or `mode off`: nothing is read or fetched. */
  | "off"
  /** Opted in, nothing applied yet (`ModelRecommendationsPending`). */
  | "pending"
  /** A verified list is merged into the config. */
  | "applied"
  /** `applied.json` is there but could not be used or inspected. */
  | "unavailable";

/** The recommendations layer as one published catalog saw it. */
export interface OpenCode2ModelUpdates {
  /** The merged `settings.model_updates`; `undefined` when there is no block. */
  readonly settings?: ModelUpdatesSettings;
  readonly mode: ModelUpdatesMode;
  readonly channel: ModelUpdatesChannel;
  readonly state: OpenCode2ModelUpdatesState;
  /** `issued` of the applied list, when `state` is `applied`. */
  readonly issued?: string;
  /** Builtin agents whose `models` the applied list set, sorted. */
  readonly agents: readonly string[];
}

/** The part of `ModelRecommendations` the trigger uses. */
export interface OpenCode2ModelRecommendationsRefresher {
  refresh(request: RefreshRequest): ResultAsync<RefreshOutcome, RefreshError>;
}

/**
 * Starts background recommendation refreshes for one host. Never throws and
 * never blocks the caller; at most one refresh runs at a time.
 */
export class OpenCode2ModelUpdatesTrigger {
  private pending?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly refresher: OpenCode2ModelRecommendationsRefresher,
    /** The published catalog's merged `settings.model_updates`. */
    private readonly settings: () => ModelUpdatesSettings | undefined,
  ) {}

  /**
   * Start a refresh unless one is already running, the host is gone, or the
   * published config has model updates off. Returns at once.
   */
  trigger(): void {
    if (this.disposed || this.pending !== undefined) return;
    const settings = this.settings();
    if (resolveModelUpdates(settings) === undefined) return;
    const started = Result.fromThrowable(
      () => this.refresher.refresh({ settings }),
      () => "the model recommendations refresh could not start",
    )();
    if (started.isErr()) {
      log.warn({ code: "model_updates_refresh_failed" }, started.error);
      return;
    }
    const running: Promise<void> = Promise.resolve(started.value)
      .then((result) => this.report(result))
      .finally(() => {
        if (this.pending === running) this.pending = undefined;
      });
    this.pending = running;
  }

  /** Resolves when the refresh in flight, if any, has finished. */
  settled(): Promise<void> {
    return this.pending ?? Promise.resolve();
  }

  /** Stop starting refreshes. One already running finishes on its own. */
  dispose(): void {
    this.disposed = true;
  }

  private report(result: Result<RefreshOutcome, RefreshError>): void {
    if (result.isErr()) {
      // Another process holding the lock is doing this refresh for us.
      if (result.error.type === "Busy") return;
      log.warn(
        { code: "model_updates_refresh_failed", error: result.error.type },
        "Model recommendations could not be refreshed",
      );
      return;
    }
    const outcome = result.value;
    if (outcome.type === "Off" || outcome.type === "Throttled") return;
    if (outcome.promoted === undefined) return;
    log.info(
      {
        channel: outcome.channel,
        issued: outcome.promoted.issued,
        previousIssued: outcome.promoted.previousIssued,
      },
      "Model recommendations promoted; agents reload on the next refresh",
    );
  }
}

/** Most agents one `models.changed` event names. */
export const MAX_MODEL_CHANGE_AGENTS = 64;

/** One agent whose resolved model a newly applied list changed. */
export interface OpenCode2ModelChange {
  /** The agent id. */
  readonly agent: string;
  readonly displayName?: string;
  readonly providerID: string;
  /** The model id within `providerID`. */
  readonly model: string;
}

/** What the `models.changed` RPC event carries. */
export interface OpenCode2ModelChangeNotice {
  /** `issued` of the newly applied list. */
  readonly issued: string;
  readonly agents: readonly OpenCode2ModelChange[];
}

/**
 * The agents whose resolved model changed between two published catalogs
 * because a newer recommendations list was applied, or `undefined` when there
 * are none. A change is attributed to the list only when the new catalog has
 * a different applied `issued` than the old one and the list set that agent's
 * models; a change from a user's own edit, or from a list being skipped, is
 * not reported.
 */
export function recommendedModelChanges(
  previous: OpenCode2CatalogCandidate,
  next: OpenCode2CatalogCandidate,
): OpenCode2ModelChangeNotice | undefined {
  const updates = next.modelUpdates;
  if (updates.state !== "applied" || updates.issued === undefined)
    return undefined;
  if (
    previous.modelUpdates.state === "applied" &&
    previous.modelUpdates.issued === updates.issued
  )
    return undefined;
  const agents: OpenCode2ModelChange[] = [];
  for (const name of updates.agents) {
    const after = next.agents.get(name);
    if (after?.model === undefined) continue;
    const before = previous.agents.get(name)?.model;
    if (
      before?.providerID === after.model.providerID &&
      before?.id === after.model.id &&
      before?.variant === after.model.variant
    )
      continue;
    agents.push({
      agent: name,
      ...(after.displayName === undefined
        ? {}
        : { displayName: after.displayName }),
      providerID: after.model.providerID,
      model: after.model.id,
    });
    if (agents.length === MAX_MODEL_CHANGE_AGENTS) break;
  }
  if (agents.length === 0) return undefined;
  return { issued: updates.issued, agents };
}
