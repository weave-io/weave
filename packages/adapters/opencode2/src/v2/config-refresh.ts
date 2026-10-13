import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type { OpenCode2CatalogCandidate } from "./catalog.js";
import type { OpenCode2Error } from "./errors.js";

export type OpenCode2RefreshState =
  | "initializing"
  | "fresh"
  | "deferred"
  | "failed"
  | "disposed";

export interface OpenCode2RefreshStatus {
  readonly state: OpenCode2RefreshState;
  readonly lastErrorCode?: OpenCode2Error["code"];
}

export interface OpenCode2RefreshDependencies {
  readonly build: () => ResultAsync<OpenCode2CatalogCandidate, OpenCode2Error>;
  readonly changed?: (
    current: OpenCode2CatalogCandidate,
  ) => ResultAsync<boolean, OpenCode2Error>;
  readonly reload: () => Promise<void>;
  /**
   * Called once a new candidate is published: after its registries reloaded,
   * or on a publish that does not reload (the first). `previous` is the
   * candidate it replaced, `undefined` on the first publish. It must not
   * throw; anything slow belongs in the background.
   */
  readonly published?: (
    previous: OpenCode2CatalogCandidate | undefined,
    next: OpenCode2CatalogCandidate,
  ) => void;
  readonly now?: () => number;
}

/**
 * Runs `tick` every `intervalMs` until stopped, starting each wait only once
 * the previous tick has settled, so slow ticks never pile up. The timer does
 * not keep the host process alive.
 *
 * The OpenCode 2 TUI selects a session's model from the host's agent list
 * before it submits a prompt, so an edit noticed only at prompt admission
 * lands one turn late and that session keeps the old model (#309). Probing in
 * the background keeps the agent list current between turns.
 *
 * A failure goes to `warn` once per error code: a broken file probed every
 * interval is reported when it breaks, not on every probe. A tick that
 * reports `fresh` clears that, so the next failure is reported again.
 */
export class OpenCode2BackgroundRefresh {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private active?: Promise<void>;
  private lastFailure?: OpenCode2Error["code"];

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => ResultAsync<
      OpenCode2RefreshState,
      OpenCode2Error
    >,
    private readonly warn: (failure: OpenCode2Error) => void,
  ) {}

  start(): void {
    this.schedule();
  }

  /** Stops scheduling and settles once any tick already running has. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }

  private schedule(): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      const active = this.run();
      this.active = active;
      void active.then(() => {
        if (this.active === active) this.active = undefined;
        this.schedule();
      });
    }, this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  private run(): Promise<void> {
    const unexpected = (): OpenCode2Error => ({
      code: "host_unavailable",
      message: "Weave's background refresh failed unexpectedly",
    });
    // A tick that throws, or whose ResultAsync rejects, is reported like any
    // other failure, so the schedule keeps running.
    const started = Result.fromThrowable(() => this.tick(), unexpected)();
    const tick = started.isOk() ? started.value : errAsync(started.error);
    return tick
      .match(
        (state) => {
          if (state === "fresh") this.lastFailure = undefined;
        },
        (failure) => this.report(failure),
      )
      .then(undefined, () => this.report(unexpected()));
  }

  private report(failure: OpenCode2Error): void {
    if (failure.code === "disposed") return;
    if (failure.code === this.lastFailure) return;
    this.lastFailure = failure.code;
    this.warn(failure);
  }
}

/** Last-valid, single-flight catalog refresh for one OpenCode Location. */
export class OpenCode2CatalogController {
  private current?: OpenCode2CatalogCandidate;
  private pending?: Promise<Result<OpenCode2CatalogCandidate, OpenCode2Error>>;
  private disposed = false;
  private lastProbe = 0;
  private refreshStatus: OpenCode2RefreshStatus = { state: "initializing" };
  private readonly now: () => number;

  constructor(
    private readonly minimumProbeMs: number,
    private readonly dependencies: OpenCode2RefreshDependencies,
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  catalog(): OpenCode2CatalogCandidate | undefined {
    return this.current;
  }

  status(): OpenCode2RefreshStatus {
    return this.refreshStatus;
  }

  initialize(): ResultAsync<OpenCode2CatalogCandidate, OpenCode2Error> {
    return this.refresh(true, false);
  }

  refreshIfDue(): ResultAsync<OpenCode2CatalogCandidate, OpenCode2Error> {
    return this.refresh(false, true);
  }

  /**
   * `refreshIfDue()` for a caller with no turn waiting on it. A failed refresh
   * keeps the last valid catalog and returns it as Ok, recording the failure
   * only in `status()`; this returns that failure, so a background caller can
   * report it.
   */
  refreshInBackground(): ResultAsync<OpenCode2RefreshState, OpenCode2Error> {
    return this.refreshIfDue().andThen(() => {
      const status = this.refreshStatus;
      if (status.state !== "failed") return okAsync(status.state);
      return errAsync<OpenCode2RefreshState, OpenCode2Error>({
        code: status.lastErrorCode ?? "config_unavailable",
        message:
          "Weave sources could not be refreshed; the last valid catalog stays in use",
      });
    });
  }

  /** Rebuild after the host reports a model or skill inventory change. */
  refreshInventory(): ResultAsync<OpenCode2CatalogCandidate, OpenCode2Error> {
    return this.refresh(true, true);
  }

  dispose(): void {
    this.disposed = true;
    this.current = undefined;
    this.refreshStatus = { state: "disposed" };
  }

  private refresh(
    force: boolean,
    reload: boolean,
  ): ResultAsync<OpenCode2CatalogCandidate, OpenCode2Error> {
    if (this.disposed)
      return errAsync({
        code: "disposed",
        message: "catalog controller is disposed",
      });
    if (
      !force &&
      this.current !== undefined &&
      this.now() - this.lastProbe < this.minimumProbeMs
    ) {
      this.refreshStatus = { state: "deferred" };
      return okAsync(this.current);
    }
    if (this.pending !== undefined)
      return ResultAsync.fromSafePromise(this.pending).andThen(
        (result) => result,
      );

    const generation = this.current;
    const operation = this.performRefresh(generation, reload, !force);
    const finalized = operation.finally(() => {
      if (this.pending === finalized) this.pending = undefined;
    });
    this.pending = finalized;
    return ResultAsync.fromSafePromise(finalized).andThen((result) => result);
  }

  private async performRefresh(
    previous: OpenCode2CatalogCandidate | undefined,
    reload: boolean,
    probeSources: boolean,
  ): Promise<Result<OpenCode2CatalogCandidate, OpenCode2Error>> {
    this.lastProbe = this.now();
    if (
      probeSources &&
      previous !== undefined &&
      this.dependencies.changed !== undefined
    ) {
      const changed = await this.dependencies.changed(previous);
      if (this.disposed)
        return err({
          code: "disposed",
          message: "catalog controller is disposed",
        });
      if (changed.isErr()) {
        this.refreshStatus = {
          state: "failed",
          lastErrorCode: changed.error.code,
        };
        return ok(previous);
      }
      if (!changed.value) {
        this.refreshStatus = { state: "fresh" };
        return ok(previous);
      }
    }
    const built = await this.dependencies.build();
    if (this.disposed)
      return err({
        code: "disposed",
        message: "catalog controller is disposed",
      });
    if (built.isErr()) {
      this.refreshStatus = { state: "failed", lastErrorCode: built.error.code };
      return previous === undefined ? err(built.error) : ok(previous);
    }
    if (previous?.revision === built.value.revision) {
      this.refreshStatus = { state: "fresh" };
      return ok(previous);
    }

    this.current = built.value;
    if (reload) {
      const reloaded = await ResultAsync.fromThrowable(
        this.dependencies.reload,
        (): OpenCode2Error => ({
          code: "host_unavailable",
          message: "OpenCode registries could not be reloaded",
        }),
      )();
      if (reloaded.isErr()) {
        this.current = previous;
        await ResultAsync.fromThrowable(
          this.dependencies.reload,
          (): OpenCode2Error => ({
            code: "host_unavailable",
            message: "OpenCode registries could not be restored",
          }),
        )();
        if (this.disposed)
          return err({
            code: "disposed",
            message: "catalog controller is disposed",
          });
        this.refreshStatus = {
          state: "failed",
          lastErrorCode: reloaded.error.code,
        };
        if (previous === undefined) return err(reloaded.error);
        return ok(previous);
      }
    }
    if (this.disposed)
      return err({
        code: "disposed",
        message: "catalog controller is disposed",
      });
    this.refreshStatus = { state: "fresh" };
    this.dependencies.published?.(previous, built.value);
    return ok(built.value);
  }
}
