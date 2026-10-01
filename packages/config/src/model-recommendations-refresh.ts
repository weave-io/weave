/**
 * Fetching and caching published model recommendations (Spec 39, "Cache" and
 * "Fetching").
 *
 * `ModelRecommendations` owns the per-channel cache under
 * `<global>/cache/model-recommendations/<channel>/`:
 *
 * - `refresh()` downloads the channel's signed envelope at most once per
 *   throttle window, verifies it, writes it to `latest.json`, and in `auto`
 *   mode promotes it to `applied.json`, which the loader merges.
 * - `apply()` promotes a waiting `latest.json` (`weave models apply`).
 * - `status()` is a read-only snapshot for `weave models status`.
 *
 * Every write happens while holding `lock/`, goes to a unique temporary file
 * in the same directory, and is moved into place, so a reader never sees a
 * partial file. Network, clock, files and shell are injected; nothing here
 * throws. Callers (the CLI, adapters) decide when to refresh.
 *
 * The normative description is Spec 39:
 * docs/specs/39-spec-model-recommendations/39-spec-model-recommendations.md
 */

import { posix } from "node:path";
import type {
  ModelUpdatesChannel,
  ModelUpdatesMode,
  ModelUpdatesSettings,
} from "@weaveio/weave-core";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { ModelRecommendationsSkipReason } from "./diagnostics.js";
import { globalConfigDir } from "./discovery.js";
import { logger } from "./logger.js";
import {
  describeModelRecommendationsError,
  MAX_MODEL_RECOMMENDATIONS_BYTES,
  MODEL_RECOMMENDATIONS_CLIENT_VERSION,
  MODEL_RECOMMENDATIONS_SCHEMA_VERSION,
  type ModelRecommendationsError,
  type ModelRecommendationsFile,
} from "./model-recommendations.js";
import {
  DEFAULT_MODEL_UPDATES_CHANNEL,
  type ModelRecommendationsCachePaths,
  modelRecommendationsCachePaths,
  type ResolvedModelUpdates,
  resolveModelUpdates,
} from "./model-recommendations-cache.js";
import {
  BunModelRecommendationsFiles,
  BunModelRecommendationsShell,
  type CacheIoError,
  type ModelRecommendationsFiles,
  type ModelRecommendationsShell,
} from "./model-recommendations-cache-io.js";
import { ModelRecommendationsVerifier } from "./model-recommendations-verifier.js";

const log = logger.child({ module: "model-recommendations" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Where lists are published. */
export const DEFAULT_MODEL_RECOMMENDATIONS_BASE_URL =
  "https://tryweave.io/models";

/** Overrides the base URL, for tests and local proofs. */
export const MODEL_RECOMMENDATIONS_URL_ENV = "WEAVE_MODEL_RECOMMENDATIONS_URL";

/** Wait this long after a successful check before checking again (24 hours). */
export const MODEL_RECOMMENDATIONS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Wait this long after a failed check before trying again (1 hour). */
export const MODEL_RECOMMENDATIONS_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** The whole request, body included, must finish within this (5 seconds). */
export const MODEL_RECOMMENDATIONS_FETCH_TIMEOUT_MS = 5000;

/** A `lock/` older than this is treated as abandoned (60 seconds). */
export const MODEL_RECOMMENDATIONS_LOCK_STALE_MS = 60 * 1000;

/** Longest ETag kept in `state.json`; a longer one is not stored. */
const MAX_ETAG_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The subset of `fetch` the refresh uses. */
export type ModelRecommendationsFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** Injected dependencies. Every field defaults to production behaviour. */
export interface ModelRecommendationsDeps {
  readonly fetch?: ModelRecommendationsFetch;
  /** The current time; also used to age `lock/`. */
  readonly now?: () => Date;
  readonly files?: ModelRecommendationsFiles;
  readonly shell?: ModelRecommendationsShell;
  /** The global config directory. Defaults to `globalConfigDir()` at each call. */
  readonly globalDir?: string;
  /**
   * The base URL lists are fetched from. Defaults, at each call, to
   * `WEAVE_MODEL_RECOMMENDATIONS_URL`, else `https://tryweave.io/models`.
   */
  readonly baseUrl?: string;
  /** Ed25519 public keys that may sign lists. Defaults to the production keys. */
  readonly publicKeys?: readonly string[];
  /** Compared with a list's `min_config_version`. */
  readonly clientVersion?: string;
  /** The builtin models baseline; tests may move it. */
  readonly builtinModelsIssued?: string;
  /** Request timeout. Defaults to `MODEL_RECOMMENDATIONS_FETCH_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** A unique suffix for temporary file names. Defaults to a random UUID. */
  readonly uniqueId?: () => string;
}

/** The merged `settings.model_updates`, as the config holds it. */
export interface ModelRecommendationsRequest {
  readonly settings: ModelUpdatesSettings | undefined;
}

/** A refresh request. `force` skips the throttle (`weave models update`). */
export interface RefreshRequest extends ModelRecommendationsRequest {
  readonly force?: boolean;
}

/** A list that was copied to `applied.json`. */
export interface PromotedList {
  readonly issued: string;
  /** `issued` of the list it replaced, if there was one. */
  readonly previousIssued?: string;
}

/** What a refresh did. `promoted` is set when `applied.json` changed (`auto`). */
export type RefreshOutcome =
  /** Model updates are off: nothing was read, written or fetched. */
  | { readonly type: "Off" }
  /** Checked recently; nothing was fetched or written. */
  | {
      readonly type: "Throttled";
      readonly channel: ModelUpdatesChannel;
      readonly lastCheck: string;
      readonly nextCheckAt: string;
    }
  /** The server's list is the one already downloaded (304). */
  | {
      readonly type: "NotModified";
      readonly channel: ModelUpdatesChannel;
      readonly promoted?: PromotedList;
    }
  /** The server sent the list already held, byte for byte. */
  | {
      readonly type: "Unchanged";
      readonly channel: ModelUpdatesChannel;
      readonly issued: string;
      readonly promoted?: PromotedList;
    }
  /** A newer list was verified and written to `latest.json`. */
  | {
      readonly type: "Downloaded";
      readonly channel: ModelUpdatesChannel;
      readonly issued: string;
      readonly promoted?: PromotedList;
    };

/** Why a check failed. Recorded in `state.json` as `lastError.code`. */
export type RefreshFailure =
  | { readonly type: "Network"; readonly message: string }
  | { readonly type: "Timeout"; readonly timeoutMs: number }
  | { readonly type: "HttpStatus"; readonly status: number }
  /** Size, envelope, signature, schema or freshness; `NotNewer` is a rollback or replay. */
  | ModelRecommendationsError;

/** Why `refresh()` did not complete. `latest` and `applied` are unchanged. */
export type RefreshError =
  /** Another process holds `lock/`; nothing was written. */
  | { readonly type: "Busy"; readonly channel: ModelUpdatesChannel }
  /** The check failed; recorded in `state.json`. */
  | {
      readonly type: "CheckFailed";
      readonly channel: ModelUpdatesChannel;
      readonly failure: RefreshFailure;
    }
  /** The cache could not be read or written. */
  | {
      readonly type: "CacheFailed";
      readonly channel: ModelUpdatesChannel;
      readonly error: CacheIoError;
    }
  /** An injected dependency threw; a bug, reported rather than thrown. */
  | {
      readonly type: "Unexpected";
      readonly channel: ModelUpdatesChannel;
      readonly message: string;
    };

/** What `apply()` did. */
export type ApplyOutcome =
  | {
      readonly type: "Applied";
      readonly channel: ModelUpdatesChannel;
      readonly issued: string;
      readonly previousIssued?: string;
    }
  | {
      readonly type: "NothingToApply";
      readonly channel: ModelUpdatesChannel;
      /** `NoLatest`: nothing downloaded; `NotNewer`: `latest` is already applied or older. */
      readonly reason: "NoLatest" | "NotNewer";
      readonly appliedIssued?: string;
    };

/** Why `apply()` did not complete. `applied` is unchanged. */
export type ApplyError =
  | { readonly type: "Off" }
  | { readonly type: "Busy"; readonly channel: ModelUpdatesChannel }
  /** `latest.json` is there but does not verify now (for example, it expired). */
  | {
      readonly type: "LatestRejected";
      readonly channel: ModelUpdatesChannel;
      readonly error: ModelRecommendationsError;
    }
  | {
      readonly type: "CacheFailed";
      readonly channel: ModelUpdatesChannel;
      readonly error: CacheIoError;
    }
  | {
      readonly type: "Unexpected";
      readonly channel: ModelUpdatesChannel;
      readonly message: string;
    };

/** The parts of a list `weave models status` shows. */
export interface ModelRecommendationsListSummary {
  readonly issued: string;
  readonly expires: string;
  readonly evidence: string;
}

/** The state of `applied.json`. */
export type AppliedListState =
  | { readonly state: "none" }
  | { readonly state: "usable"; readonly list: ModelRecommendationsListSummary }
  | {
      readonly state: "unusable";
      readonly reason: ModelRecommendationsSkipReason;
    };

/** The last check's failure, as `state.json` records it. */
export interface RecordedRefreshError {
  /** A `RefreshFailure` type, or `CacheIoError`. */
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

/** A read-only snapshot of one channel's cache. */
export interface ModelRecommendationsStatus {
  readonly mode: ModelUpdatesMode;
  readonly channel: ModelUpdatesChannel;
  readonly applied: AppliedListState;
  /** A verified `latest.json` newer than the applied list, waiting for `apply`. */
  readonly waiting?: ModelRecommendationsListSummary;
  readonly lastCheck?: string;
  /** When the throttle next lets a refresh check. */
  readonly nextCheckAt?: string;
  /** Set while the last check failed; cleared by the next successful one. */
  readonly lastError?: RecordedRefreshError;
}

// ---------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------

const RefreshStateSchema = z.object({
  version: z.literal(1),
  lastCheck: z.iso.datetime().optional(),
  etag: z.string().max(MAX_ETAG_LENGTH).optional(),
  lastError: z
    .object({
      code: z.string(),
      message: z.string(),
      at: z.iso.datetime(),
    })
    .optional(),
});

type RefreshState = z.infer<typeof RefreshStateSchema>;

const EMPTY_STATE: RefreshState = { version: 1 };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A cached envelope whose signature and schema check out. */
interface CachedList {
  readonly text: string;
  readonly payload: string;
  readonly file: ModelRecommendationsFile;
}

/** One cache slot: nothing, a usable list, or a file that does not verify. */
type CachedSlot =
  | { readonly state: "missing" }
  | { readonly state: "ok"; readonly list: CachedList }
  | { readonly state: "invalid"; readonly error: ModelRecommendationsError };

/** The response, as far as the refresh cares. */
type Download =
  | { readonly type: "NotModified" }
  | { readonly type: "Body"; readonly text: string; readonly etag?: string };

/** What a check under the lock produced, before `state.json` is written. */
interface Checked {
  readonly outcome: RefreshOutcome;
  /** The ETag to store; `undefined` keeps the stored one. */
  readonly etag?: string;
}

/** Why a locked operation did not run, or did not finish. */
type LockFailure =
  | { readonly type: "Busy"; readonly channel: ModelUpdatesChannel }
  | {
      readonly type: "CacheFailed";
      readonly channel: ModelUpdatesChannel;
      readonly error: CacheIoError;
    }
  | {
      readonly type: "Unexpected";
      readonly channel: ModelUpdatesChannel;
      readonly message: string;
    };

/** A failure inside the lock: a check failure or a cache I/O failure. */
type LockedFailure = RefreshFailure | CacheIoError;

const TIMED_OUT = Symbol("timed out");

function cachedOk(slot: CachedSlot): CachedList | undefined {
  return slot.state === "ok" ? slot.list : undefined;
}

function issuedMs(list: CachedList | undefined): number {
  return list === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(list.file.issued);
}

function summary(
  file: ModelRecommendationsFile,
): ModelRecommendationsListSummary {
  return {
    issued: file.issued,
    expires: file.expires,
    evidence: file.evidence,
  };
}

/** A one-line, user-facing reason for a failed check or cache write. */
export function describeRefreshFailure(
  failure: RefreshFailure | CacheIoError,
): string {
  switch (failure.type) {
    case "Network":
      return `the request failed: ${failure.message}`;
    case "Timeout":
      return `the request took longer than ${failure.timeoutMs} ms`;
    case "HttpStatus":
      return `the server answered HTTP ${failure.status}`;
    case "CacheIoError":
      return `the cache could not be updated (${failure.operation} ${failure.path}): ${failure.message}`;
    default:
      return describeModelRecommendationsError(failure);
  }
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// ModelRecommendations
// ---------------------------------------------------------------------------

/**
 * Refreshes, applies and reports the model recommendations cache. Never
 * throws: every failure is a typed error, and `refresh()` with model updates
 * off touches neither the disk nor the network.
 */
export class ModelRecommendations {
  private readonly fetchImpl: ModelRecommendationsFetch;
  private readonly now: () => Date;
  private readonly files: ModelRecommendationsFiles;
  private readonly shell: ModelRecommendationsShell;
  private readonly verifier: ModelRecommendationsVerifier;
  private readonly clientVersion: string;
  private readonly timeoutMs: number;
  private readonly uniqueId: () => string;

  constructor(private readonly deps: ModelRecommendationsDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => new Date());
    this.files = deps.files ?? new BunModelRecommendationsFiles();
    this.shell = deps.shell ?? new BunModelRecommendationsShell(this.files);
    this.verifier = new ModelRecommendationsVerifier({
      publicKeys: deps.publicKeys,
      now: this.now,
      builtinModelsIssued: deps.builtinModelsIssued,
    });
    this.clientVersion =
      deps.clientVersion ?? MODEL_RECOMMENDATIONS_CLIENT_VERSION;
    this.timeoutMs = deps.timeoutMs ?? MODEL_RECOMMENDATIONS_FETCH_TIMEOUT_MS;
    this.uniqueId = deps.uniqueId ?? (() => crypto.randomUUID());
  }

  /**
   * Check the channel for a newer list. Off: nothing at all. Otherwise at most
   * one GET per throttle window (24 hours after a success, 1 hour after a
   * failure) unless `force`. A verified, fresh, newer list is written to
   * `latest.json`, and in `auto` mode to `applied.json`. Every write happens
   * under `lock/`; a process that cannot take it gets `Busy` and writes
   * nothing.
   */
  refresh(request: RefreshRequest): ResultAsync<RefreshOutcome, RefreshError> {
    const settings = resolveModelUpdates(request.settings);
    if (settings === undefined) return okAsync({ type: "Off" });
    const { channel } = settings;
    const paths = this.paths(channel);
    const force = request.force === true;
    return this.guard(() => {
      // An unlocked, read-only look first, so a throttled call (most of them)
      // neither takes the lock nor writes. It is decided again under the lock.
      const precheck: ResultAsync<RefreshOutcome | undefined, RefreshError> =
        force
          ? okAsync(undefined)
          : this.readState(paths).map((state) =>
              this.throttled(state, channel),
            );
      return precheck.andThen((throttled) => {
        if (throttled !== undefined) return okAsync(throttled);
        return this.shell
          .makeDirs(paths.dir)
          .mapErr(
            (error): RefreshError => ({ type: "CacheFailed", channel, error }),
          )
          .andThen(() =>
            this.withLock<RefreshOutcome, RefreshError>(paths, channel, () =>
              this.refreshLocked(settings, paths, force),
            ),
          );
      });
    }, channel);
  }

  /**
   * Promote a verified `latest.json` to `applied.json` when it is newer
   * (`weave models apply`). Runs under `lock/`, and re-reads `applied.json`
   * there, so it never replaces a newer list.
   */
  apply(
    request: ModelRecommendationsRequest,
  ): ResultAsync<ApplyOutcome, ApplyError> {
    const settings = resolveModelUpdates(request.settings);
    if (settings === undefined) return errAsync({ type: "Off" });
    const { channel } = settings;
    const paths = this.paths(channel);
    return this.guard(
      () =>
        this.shell
          .makeDirs(paths.dir)
          .mapErr(
            (error): ApplyError => ({ type: "CacheFailed", channel, error }),
          )
          .andThen(() =>
            this.withLock<ApplyOutcome, ApplyError>(paths, channel, () =>
              this.applyLocked(settings, paths),
            ),
          ),
      channel,
    );
  }

  /** A read-only snapshot of the channel's cache. Never fails and never writes. */
  status(
    request: ModelRecommendationsRequest,
  ): ResultAsync<ModelRecommendationsStatus, never> {
    const mode = request.settings?.mode ?? "off";
    const channel = request.settings?.channel ?? DEFAULT_MODEL_UPDATES_CHANNEL;
    const paths = this.paths(channel);
    const context = { channel, clientVersion: this.clientVersion };

    return this.readState(paths).andThen((state) =>
      this.readVerified(paths.applied, context).andThen((applied) => {
        const appliedIssued =
          applied.state === "usable" ? applied.list.issued : undefined;
        return this.readVerified(paths.latest, {
          ...context,
          appliedIssued,
        }).map((latest): ModelRecommendationsStatus => {
          const next = this.nextCheckAt(state);
          return {
            mode,
            channel,
            applied,
            ...(latest.state === "usable" ? { waiting: latest.list } : {}),
            ...(state.lastCheck === undefined
              ? {}
              : { lastCheck: state.lastCheck }),
            ...(next === undefined
              ? {}
              : { nextCheckAt: new Date(next).toISOString() }),
            ...(state.lastError === undefined
              ? {}
              : { lastError: state.lastError }),
          };
        });
      }),
    );
  }

  // -------------------------------------------------------------------------
  // refresh, under the lock
  // -------------------------------------------------------------------------

  private refreshLocked(
    settings: ResolvedModelUpdates,
    paths: ModelRecommendationsCachePaths,
    force: boolean,
  ): ResultAsync<RefreshOutcome, RefreshError> {
    const { channel } = settings;
    return this.readState(paths).andThen((state) => {
      const throttled = force ? undefined : this.throttled(state, channel);
      if (throttled !== undefined) return okAsync(throttled);
      const checkedAt = this.now().toISOString();
      return this.check(settings, paths, state)
        .orElse((failure) =>
          this.recordFailure(paths, channel, state, checkedAt, failure),
        )
        .andThen((checked) => {
          const etag = checked.etag ?? state.etag;
          return this.writeState(paths, {
            version: 1,
            lastCheck: checkedAt,
            ...(etag === undefined ? {} : { etag }),
          })
            .map(() => checked.outcome)
            .mapErr(
              (error): RefreshError => ({
                type: "CacheFailed",
                channel,
                error,
              }),
            );
        });
    });
  }

  /** One attempt: download, verify, compare with what is held, write. */
  private check(
    settings: ResolvedModelUpdates,
    paths: ModelRecommendationsCachePaths,
    state: RefreshState,
  ): ResultAsync<Checked, LockedFailure> {
    const { channel } = settings;
    return this.download(this.url(channel), state.etag).andThen(
      (download): ResultAsync<Checked, LockedFailure> => {
        if (download.type === "NotModified")
          return this.readHeld(paths)
            .andThen((held) => this.promoteWaiting(settings, paths, held))
            .map((promoted) => ({
              outcome: {
                type: "NotModified",
                channel,
                ...(promoted === undefined ? {} : { promoted }),
              },
            }));
        return this.verifier
          .verifyEnvelope(download.text, {
            channel,
            clientVersion: this.clientVersion,
          })
          .andThen((file) =>
            // Read what is held only now, after the download: another writer
            // may have promoted a newer list while this request was in flight.
            this.readHeld(paths).andThen((held) =>
              this.store(settings, paths, held, download, file),
            ),
          );
      },
    );
  }

  /**
   * Compare a verified download with the newest list held (`applied` or a
   * waiting `latest`) and write it when it is newer.
   */
  private store(
    settings: ResolvedModelUpdates,
    paths: ModelRecommendationsCachePaths,
    held: HeldLists,
    download: Extract<Download, { type: "Body" }>,
    file: ModelRecommendationsFile,
  ): ResultAsync<Checked, LockedFailure> {
    const { channel } = settings;
    const newest =
      issuedMs(held.latest) > issuedMs(held.applied)
        ? held.latest
        : held.applied;
    const payload = this.verifier
      .parseEnvelope(download.text)
      .map((e) => e.payload);
    const served = Date.parse(file.issued);

    if (
      newest !== undefined &&
      served === issuedMs(newest) &&
      payload.isOk() &&
      payload.value === newest.payload
    )
      return this.promoteWaiting(settings, paths, held).map((promoted) => ({
        outcome: {
          type: "Unchanged",
          channel,
          issued: file.issued,
          ...(promoted === undefined ? {} : { promoted }),
        },
        etag: download.etag,
      }));
    // Rollback (older) and replay (same `issued`, different bytes).
    if (newest !== undefined && served <= issuedMs(newest))
      return errAsync({
        type: "NotNewer",
        issued: file.issued,
        appliedIssued: newest.file.issued,
      });

    return this.writeAtomic(paths.latest, download.text).andThen(() => {
      if (settings.mode !== "auto")
        return okAsync<Checked, LockedFailure>({
          outcome: { type: "Downloaded", channel, issued: file.issued },
          etag: download.etag,
        });
      return this.writeAtomic(paths.applied, download.text).map(
        (): Checked => ({
          outcome: {
            type: "Downloaded",
            channel,
            issued: file.issued,
            promoted: this.promotion(file.issued, held.applied),
          },
          etag: download.etag,
        }),
      );
    });
  }

  /**
   * In `auto` mode, promote a `latest.json` that is newer than the applied
   * list (one downloaded in `notify` mode, before the user switched), when it
   * still verifies now.
   */
  private promoteWaiting(
    settings: ResolvedModelUpdates,
    paths: ModelRecommendationsCachePaths,
    held: HeldLists,
  ): ResultAsync<PromotedList | undefined, CacheIoError> {
    const latest = held.latest;
    if (settings.mode !== "auto" || latest === undefined)
      return okAsync(undefined);
    if (issuedMs(latest) <= issuedMs(held.applied)) return okAsync(undefined);
    const fresh = this.verifier.checkFreshness(latest.file, {
      channel: settings.channel,
      clientVersion: this.clientVersion,
      appliedIssued: held.applied?.file.issued,
    });
    if (fresh.isErr()) return okAsync(undefined);
    return this.writeAtomic(paths.applied, latest.text).map(() =>
      this.promotion(latest.file.issued, held.applied),
    );
  }

  private recordFailure(
    paths: ModelRecommendationsCachePaths,
    channel: ModelUpdatesChannel,
    state: RefreshState,
    checkedAt: string,
    failure: LockedFailure,
  ): ResultAsync<Checked, RefreshError> {
    log.warn(
      { channel, code: failure.type, reason: describeRefreshFailure(failure) },
      "Model recommendations check failed",
    );
    const error: RefreshError =
      failure.type === "CacheIoError"
        ? { type: "CacheFailed", channel, error: failure }
        : { type: "CheckFailed", channel, failure };
    const recorded: RefreshState = {
      version: 1,
      lastCheck: checkedAt,
      ...(state.etag === undefined ? {} : { etag: state.etag }),
      lastError: {
        code: failure.type,
        message: describeRefreshFailure(failure),
        at: checkedAt,
      },
    };
    return this.writeState(paths, recorded)
      .orElse((writeError) => {
        log.warn(
          { channel, err: writeError },
          "Could not record the failed check",
        );
        return okAsync(undefined);
      })
      .andThen(() => errAsync(error));
  }

  // -------------------------------------------------------------------------
  // apply, under the lock
  // -------------------------------------------------------------------------

  private applyLocked(
    settings: ResolvedModelUpdates,
    paths: ModelRecommendationsCachePaths,
  ): ResultAsync<ApplyOutcome, ApplyError> {
    const { channel } = settings;
    return this.readSlot(paths.latest)
      .andThen((latest) =>
        this.readSlot(paths.applied).map((applied) => ({ latest, applied })),
      )
      .mapErr((error): ApplyError => ({ type: "CacheFailed", channel, error }))
      .andThen(({ latest, applied }): ResultAsync<ApplyOutcome, ApplyError> => {
        if (latest.state === "missing")
          return okAsync({
            type: "NothingToApply",
            channel,
            reason: "NoLatest",
          });
        if (latest.state === "invalid")
          return errAsync({
            type: "LatestRejected",
            channel,
            error: latest.error,
          });
        const current = cachedOk(applied);
        const fresh = this.verifier.checkFreshness(latest.list.file, {
          channel,
          clientVersion: this.clientVersion,
          appliedIssued: current?.file.issued,
        });
        if (fresh.isErr() && fresh.error.type === "NotNewer")
          return okAsync({
            type: "NothingToApply",
            channel,
            reason: "NotNewer",
            appliedIssued: fresh.error.appliedIssued,
          });
        if (fresh.isErr())
          return errAsync({
            type: "LatestRejected",
            channel,
            error: fresh.error,
          });
        const issued = latest.list.file.issued;
        return this.writeAtomic(paths.applied, latest.list.text)
          .mapErr(
            (error): ApplyError => ({ type: "CacheFailed", channel, error }),
          )
          .map(
            (): ApplyOutcome => ({
              type: "Applied",
              channel,
              ...this.promotion(issued, current),
            }),
          );
      });
  }

  // -------------------------------------------------------------------------
  // The lock
  // -------------------------------------------------------------------------

  /**
   * Run `body` holding `lock/`, and release it afterwards whatever happens.
   * `Busy` when another process holds a lock that is not abandoned.
   */
  private withLock<T, E>(
    paths: ModelRecommendationsCachePaths,
    channel: ModelUpdatesChannel,
    body: () => ResultAsync<T, E>,
  ): ResultAsync<T, E | LockFailure> {
    return this.acquire(paths.lock)
      .mapErr((error): E | LockFailure => ({
        type: "CacheFailed",
        channel,
        error,
      }))
      .andThen((acquired) => {
        if (!acquired)
          return errAsync<T, E | LockFailure>({ type: "Busy", channel });
        return ResultAsync.fromPromise(
          this.holding(paths.lock, body),
          (cause): E | LockFailure => ({
            type: "Unexpected",
            channel,
            message: causeMessage(cause),
          }),
        ).andThen((result): Result<T, E | LockFailure> => result);
      });
  }

  /**
   * `result`, with a rejection (an injected dependency that threw) turned
   * into a typed `Unexpected` error, so callers never see an exception.
   */
  private guard<T, E>(
    run: () => ResultAsync<T, E>,
    channel: ModelUpdatesChannel,
  ): ResultAsync<T, E | LockFailure> {
    // Calling `run` inside `then` catches a dependency that throws while the
    // chain is being built, not only one that rejects later.
    return new ResultAsync(
      Promise.resolve()
        .then(run)
        .then(
          (settled): Result<T, E | LockFailure> => settled,
          (cause: unknown): Result<T, E | LockFailure> => {
            log.error(
              { channel, err: cause },
              "Model recommendations failed unexpectedly",
            );
            return err({
              type: "Unexpected",
              channel,
              message: causeMessage(cause),
            });
          },
        ),
    );
  }

  /** `body`'s result, with the lock released in every case. */
  private async holding<T, E>(
    lock: string,
    body: () => ResultAsync<T, E>,
  ): Promise<Result<T, E>> {
    try {
      return await body();
    } finally {
      const released = await this.shell.remove(lock);
      if (released.isErr())
        log.warn(
          { err: released.error },
          "Could not release the model recommendations lock",
        );
    }
  }

  /**
   * Take `lock/` with an exclusive mkdir. A lock older than
   * `MODEL_RECOMMENDATIONS_LOCK_STALE_MS` was abandoned by a process that
   * died: remove it and try once more. `false` means someone holds it.
   */
  private acquire(lock: string): ResultAsync<boolean, CacheIoError> {
    return this.shell.makeDir(lock).andThen((created) => {
      if (created) return okAsync<boolean, CacheIoError>(true);
      return this.files.modifiedAt(lock).andThen((modified) => {
        // Released between our mkdir and this look: try once more.
        if (modified === undefined) return this.shell.makeDir(lock);
        const age = this.now().getTime() - modified;
        if (age <= MODEL_RECOMMENDATIONS_LOCK_STALE_MS)
          return okAsync<boolean, CacheIoError>(false);
        log.warn(
          { lock, ageMs: age },
          "Removing an abandoned model recommendations lock",
        );
        return this.shell.remove(lock).andThen(() => this.shell.makeDir(lock));
      });
    });
  }

  // -------------------------------------------------------------------------
  // The download
  // -------------------------------------------------------------------------

  /**
   * One GET with `If-None-Match`, a timeout over the whole exchange (body
   * included) and the size cap enforced while the body arrives.
   */
  private download(
    url: string,
    etag: string | undefined,
  ): ResultAsync<Download, RefreshFailure> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, this.timeoutMs);
    });
    const headers: Record<string, string> = {};
    if (etag !== undefined) headers["If-None-Match"] = etag;
    const init: RequestInit = {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error",
    };
    const request = ResultAsync.fromThrowable(
      () => this.fetchImpl(url, init),
      (cause): RefreshFailure =>
        this.transportFailure(cause, controller.signal),
    );
    const attempt = this.race(request(), deadline).andThen((response) =>
      this.readResponse(response, deadline, controller.signal),
    );
    return new ResultAsync(
      Promise.resolve(attempt).then((result) => {
        clearTimeout(timer);
        return result;
      }),
    );
  }

  private readResponse(
    response: Response,
    deadline: Promise<typeof TIMED_OUT>,
    signal: AbortSignal,
  ): ResultAsync<Download, RefreshFailure> {
    if (response.status === 304) {
      this.discard(response);
      return okAsync({ type: "NotModified" });
    }
    if (response.status !== 200) {
      this.discard(response);
      return errAsync({ type: "HttpStatus", status: response.status });
    }
    const declared = Number(
      response.headers.get("content-length") ?? Number.NaN,
    );
    if (
      Number.isFinite(declared) &&
      declared > MAX_MODEL_RECOMMENDATIONS_BYTES
    ) {
      this.discard(response);
      return errAsync({
        type: "TooLarge",
        bytes: declared,
        limit: MAX_MODEL_RECOMMENDATIONS_BYTES,
      });
    }
    const header = response.headers.get("etag") ?? undefined;
    const etag =
      header !== undefined && header.length <= MAX_ETAG_LENGTH
        ? header
        : undefined;
    return this.readCapped(response, deadline, signal).map(
      (text): Download => ({
        type: "Body",
        text,
        ...(etag === undefined ? {} : { etag }),
      }),
    );
  }

  /** Read the body chunk by chunk, stopping as soon as it passes the cap. */
  private readCapped(
    response: Response,
    deadline: Promise<typeof TIMED_OUT>,
    signal: AbortSignal,
  ): ResultAsync<string, RefreshFailure> {
    const body = response.body;
    if (body === null) return okAsync("");
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const next = (): ResultAsync<string, RefreshFailure> =>
      this.race(
        ResultAsync.fromPromise(reader.read(), (cause) =>
          this.transportFailure(cause, signal),
        ),
        deadline,
      ).andThen((chunk): ResultAsync<string, RefreshFailure> => {
        if (chunk.done) {
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const part of chunks) {
            bytes.set(part, offset);
            offset += part.byteLength;
          }
          return okAsync(new TextDecoder().decode(bytes));
        }
        total += chunk.value.byteLength;
        if (total > MAX_MODEL_RECOMMENDATIONS_BYTES)
          return errAsync({
            type: "TooLarge",
            bytes: total,
            limit: MAX_MODEL_RECOMMENDATIONS_BYTES,
          });
        chunks.push(chunk.value);
        return next();
      });
    return next().orElse((failure) => {
      reader.cancel().catch(() => undefined);
      return errAsync(failure);
    });
  }

  /** `step`, unless the deadline passes first. */
  private race<T>(
    step: ResultAsync<T, RefreshFailure>,
    deadline: Promise<typeof TIMED_OUT>,
  ): ResultAsync<T, RefreshFailure> {
    const timedOut: Result<T, RefreshFailure> = err({
      type: "Timeout",
      timeoutMs: this.timeoutMs,
    });
    return new ResultAsync(
      Promise.race([Promise.resolve(step), deadline.then(() => timedOut)]),
    );
  }

  private transportFailure(
    cause: unknown,
    signal: AbortSignal,
  ): RefreshFailure {
    if (signal.aborted) return { type: "Timeout", timeoutMs: this.timeoutMs };
    return { type: "Network", message: causeMessage(cause) };
  }

  private discard(response: Response): void {
    response.body?.cancel().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // The cache files
  // -------------------------------------------------------------------------

  private paths(channel: ModelUpdatesChannel): ModelRecommendationsCachePaths {
    return modelRecommendationsCachePaths(
      channel,
      this.deps.globalDir ?? globalConfigDir(),
    );
  }

  private url(channel: ModelUpdatesChannel): string {
    const base =
      this.deps.baseUrl ??
      process.env[MODEL_RECOMMENDATIONS_URL_ENV] ??
      DEFAULT_MODEL_RECOMMENDATIONS_BASE_URL;
    return `${base.replace(/\/+$/, "")}/${channel}.v${MODEL_RECOMMENDATIONS_SCHEMA_VERSION}.json`;
  }

  /** `Throttled` when the last check is recent enough, else `undefined`. */
  private throttled(
    state: RefreshState,
    channel: ModelUpdatesChannel,
  ): RefreshOutcome | undefined {
    const next = this.nextCheckAt(state);
    if (next === undefined || state.lastCheck === undefined) return undefined;
    if (this.now().getTime() >= next) return undefined;
    return {
      type: "Throttled",
      channel,
      lastCheck: state.lastCheck,
      nextCheckAt: new Date(next).toISOString(),
    };
  }

  /** When the throttle allows the next check, in epoch ms. */
  private nextCheckAt(state: RefreshState): number | undefined {
    if (state.lastCheck === undefined) return undefined;
    const last = Date.parse(state.lastCheck);
    // A last check in the future means the clock moved back; do not trust it.
    if (last > this.now().getTime()) return undefined;
    const window =
      state.lastError === undefined
        ? MODEL_RECOMMENDATIONS_CHECK_INTERVAL_MS
        : MODEL_RECOMMENDATIONS_RETRY_INTERVAL_MS;
    return last + window;
  }

  /** `state.json`, or an empty state when it is missing, unreadable or invalid. */
  private readState(
    paths: ModelRecommendationsCachePaths,
  ): ResultAsync<RefreshState, never> {
    return this.readText(paths.state)
      .map((text) => {
        if (text === undefined) return EMPTY_STATE;
        const json = Result.fromThrowable(
          (): unknown => JSON.parse(text),
          () => undefined,
        )();
        if (json.isErr()) return EMPTY_STATE;
        const parsed = RefreshStateSchema.safeParse(json.value);
        return parsed.success ? parsed.data : EMPTY_STATE;
      })
      .orElse(() => okAsync(EMPTY_STATE));
  }

  private writeState(
    paths: ModelRecommendationsCachePaths,
    state: RefreshState,
  ): ResultAsync<void, CacheIoError> {
    return this.writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  }

  /** A file's text, or `undefined` when there is none. */
  private readText(
    path: string,
  ): ResultAsync<string | undefined, CacheIoError> {
    return this.files.exists(path).andThen((exists) => {
      if (!exists) return okAsync<string | undefined, CacheIoError>(undefined);
      return this.files.read(path);
    });
  }

  /** A cached envelope, checked for signature and schema but not freshness. */
  private readSlot(path: string): ResultAsync<CachedSlot, CacheIoError> {
    return this.readText(path).andThen((text) => {
      if (text === undefined)
        return okAsync<CachedSlot, CacheIoError>({ state: "missing" });
      const envelope = this.verifier.parseEnvelope(text);
      if (envelope.isErr())
        return okAsync<CachedSlot, CacheIoError>({
          state: "invalid",
          error: envelope.error,
        });
      return this.verifier
        .verifySignature(envelope.value)
        .andThen((payload) => this.verifier.parseList(payload))
        .map(
          (file): CachedSlot => ({
            state: "ok",
            list: { text, payload: envelope.value.payload, file },
          }),
        )
        .orElse((error) =>
          okAsync<CachedSlot, CacheIoError>({ state: "invalid", error }),
        );
    });
  }

  /**
   * `applied.json` and `latest.json`, re-read under the lock. A file that does
   * not verify counts as absent, so the next promotion replaces it.
   */
  private readHeld(
    paths: ModelRecommendationsCachePaths,
  ): ResultAsync<HeldLists, CacheIoError> {
    return this.readSlot(paths.applied).andThen((applied) =>
      this.readSlot(paths.latest).map((latest) => ({
        applied: cachedOk(applied),
        latest: cachedOk(latest),
      })),
    );
  }

  /** A list's summary when it fully verifies now, else why not. Read-only. */
  private readVerified(
    path: string,
    context: {
      channel: ModelUpdatesChannel;
      clientVersion: string;
      appliedIssued?: string;
    },
  ): ResultAsync<AppliedListState, never> {
    return this.readText(path)
      .orElse(() => okAsync<string | null | undefined, never>(null))
      .andThen((text): ResultAsync<AppliedListState, never> => {
        if (text === undefined) return okAsync({ state: "none" });
        if (text === null)
          return okAsync({ state: "unusable", reason: { type: "Unreadable" } });
        return this.verifier
          .verifyEnvelope(text, context)
          .map(
            (file): AppliedListState => ({
              state: "usable",
              list: summary(file),
            }),
          )
          .orElse((reason) =>
            okAsync<AppliedListState, never>({ state: "unusable", reason }),
          );
      });
  }

  /** Write to a unique temporary file in the same directory, then move it into place. */
  private writeAtomic(
    path: string,
    text: string,
  ): ResultAsync<void, CacheIoError> {
    const temp = `${posix.dirname(path)}/.${posix.basename(path)}.${this.uniqueId()}.tmp`;
    return this.files
      .write(temp, text)
      .andThen(() => this.shell.move(temp, path))
      .orElse((error) =>
        this.shell
          .remove(temp)
          .orElse(() => okAsync(undefined))
          .andThen(() => errAsync(error)),
      );
  }

  private promotion(
    issued: string,
    previous: CachedList | undefined,
  ): PromotedList {
    return previous === undefined
      ? { issued }
      : { issued, previousIssued: previous.file.issued };
  }
}

/** The lists held in the cache, each only when it verifies. */
interface HeldLists {
  readonly applied?: CachedList;
  readonly latest?: CachedList;
}
