import {
  type ActivePlanTask,
  type PlanActiveTaskError,
  type PlanTaskSnapshot,
  type SessionGoalController,
  selectActivePlanTask,
} from "@weaveio/weave-engine";
import type { PiAdapterFailure } from "./errors.js";
import { renderGoalFooter, WEAVE_GOAL_STATUS_KEY } from "./goal-status.js";
import type { PiUiThemePort } from "./types.js";

export const GOAL_FOOTER_REFRESH_INTERVAL_MS = 60_000;

type CachedActiveTask = ActivePlanTask | PlanActiveTaskError;

export interface PiGoalFooterCache {
  readonly planName: string;
  readonly contentRevision: string;
  readonly activeTask: CachedActiveTask;
  readonly complete: boolean;
}

export interface PiGoalFooterTimerHandle {
  cancel(): void;
  unref(): void;
}

export interface PiGoalFooterTimerPort {
  schedule(callback: () => void, delayMs: number): PiGoalFooterTimerHandle;
}

class SystemGoalFooterTimerPort implements PiGoalFooterTimerPort {
  schedule(callback: () => void, delayMs: number): PiGoalFooterTimerHandle {
    const handle = setTimeout(callback, delayMs);
    return {
      cancel: () => clearTimeout(handle),
      unref: () => handle.unref(),
    };
  }
}

export interface PiGoalFooterControllerDependencies {
  readonly controller: Pick<
    SessionGoalController,
    "current" | "elapsedMs" | "isPursuing"
  >;
  readonly readSnapshot: (
    planName: string,
  ) => import("neverthrow").ResultAsync<PlanTaskSnapshot, PiAdapterFailure>;
  readonly setStatus: (key: string, value: string | undefined) => void;
  readonly theme?: PiUiThemePort | (() => PiUiThemePort | undefined);
  readonly isChildMode: () => boolean;
  readonly timer?: PiGoalFooterTimerPort;
}

/** Owns the cached and periodically refreshed goal status footer. */
export class PiGoalFooterController {
  private cache: PiGoalFooterCache | undefined;
  private timer: PiGoalFooterTimerHandle | undefined;
  private generation = 0;
  private statusInitialized = false;
  private lastStatusText: string | undefined;
  private planUnavailableForPlan: string | undefined;
  private readonly timerPort: PiGoalFooterTimerPort;

  constructor(private readonly deps: PiGoalFooterControllerDependencies) {
    this.timerPort = deps.timer ?? new SystemGoalFooterTimerPort();
  }

  /** Read the authoritative plan, then render its current active task. */
  async refreshFromPlan(): Promise<void> {
    if (this.deps.isChildMode()) return;

    const state = this.deps.controller.current;
    if (state === undefined) {
      this.cache = undefined;
      this.planUnavailableForPlan = undefined;
      this.stopTimer();
      this.paint(undefined);
      return;
    }

    // Keep the unresolved state distinct from a known cold-read failure. A
    // stale cache also cannot stand in for the newly selected plan.
    const hasCurrentCache = this.cache?.planName === state.planName;
    if (!hasCurrentCache) {
      this.paint(this.planUnavailableForPlan === state.planName);
    }

    await this.deps.readSnapshot(state.planName).match(
      (snapshot) => {
        const cached = this.cache;
        const activeTask =
          cached?.planName === snapshot.planName &&
          cached.contentRevision === snapshot.contentRevision
            ? cached.activeTask
            : selectActivePlanTask(snapshot).match(
                (selected) => selected,
                (failure) => failure,
              );
        this.cache = {
          planName: snapshot.planName,
          contentRevision: snapshot.contentRevision,
          activeTask,
          complete: snapshot.complete,
        };
        this.planUnavailableForPlan = undefined;
        this.paint(false);
      },
      () => {
        if (this.cache?.planName === state.planName) {
          // A warm-cache failure retains the last known task and completion.
          this.planUnavailableForPlan = undefined;
          this.paint(false);
        } else {
          this.planUnavailableForPlan = state.planName;
          this.paint(true);
        }
      },
    );
    this.syncTimer();
  }

  /** Render the cache without reading the plan. */
  refreshFromCache(): void {
    if (this.deps.isChildMode()) return;
    const state = this.deps.controller.current;
    if (state === undefined) {
      this.paint(undefined);
    } else if (this.cache?.planName === state.planName) {
      this.paint(this.planUnavailableForPlan === state.planName);
    } else {
      this.paint(this.planUnavailableForPlan === state.planName);
    }
    this.syncTimer();
  }

  /** Repaint after restoring the goal state for the current branch. */
  async restore(): Promise<void> {
    if (this.deps.isChildMode()) return;
    if (this.deps.controller.current === undefined) {
      this.cache = undefined;
      this.planUnavailableForPlan = undefined;
      this.stopTimer();
      this.paint(undefined);
      return;
    }
    await this.refreshFromPlan();
  }

  /** Remove all cached footer state and stop elapsed-time updates. */
  clear(): void {
    if (this.deps.isChildMode()) return;
    this.cache = undefined;
    this.planUnavailableForPlan = undefined;
    this.stopTimer();
    this.paint(undefined);
  }

  private paint(planUnavailable: boolean | undefined): void {
    const state = this.deps.controller.current;
    const cached = this.cache;
    const activeTask =
      state !== undefined && cached?.planName === state.planName
        ? cached.activeTask
        : undefined;
    const text = renderGoalFooter({
      state,
      activeTask,
      planUnavailable: planUnavailable === true,
      planComplete:
        state !== undefined &&
        cached?.planName === state.planName &&
        cached.complete === true,
      elapsedMs: this.deps.controller.elapsedMs(),
      theme:
        typeof this.deps.theme === "function"
          ? this.deps.theme()
          : this.deps.theme,
    });
    if (!this.statusInitialized || this.lastStatusText !== text) {
      this.deps.setStatus(WEAVE_GOAL_STATUS_KEY, text);
      this.lastStatusText = text;
      this.statusInitialized = true;
    }
  }

  private syncTimer(): void {
    if (this.deps.isChildMode()) {
      this.stopTimer();
      return;
    }
    if (this.deps.controller.isPursuing) {
      if (this.timer !== undefined) return;
      const generation = ++this.generation;
      this.timer = this.timerPort.schedule(() => {
        if (generation !== this.generation) return;
        this.timer = undefined;
        this.refreshFromCache();
        if (generation === this.generation) this.syncTimer();
      }, GOAL_FOOTER_REFRESH_INTERVAL_MS);
      this.timer.unref();
      return;
    }
    this.stopTimer();
  }

  private stopTimer(): void {
    this.generation += 1;
    const timer = this.timer;
    this.timer = undefined;
    timer?.cancel();
  }
}
