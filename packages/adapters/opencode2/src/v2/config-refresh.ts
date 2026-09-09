import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
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
  readonly now?: () => number;
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
    return ok(built.value);
  }
}
