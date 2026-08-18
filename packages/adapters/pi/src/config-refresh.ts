/**
 * Candidate catalog builder for the Pi adapter's config refresh.
 *
 * The digest manifest in `config-source-digests.ts` answers *what changed*.
 * The builder in this module answers *what the catalog would become* — and
 * nothing more. It produces a fully validated {@link PiConfigActivationResult}
 * plus the next manifest and content cache, and hands them back to the caller.
 * It never publishes, never mutates the current catalog, and holds no state
 * between attempts.
 *
 * {@link createPiConfigRefreshCoordinator} is the one caller that decides.
 * It runs probe → classify → build → primary-contract guard → publish at each
 * delegation boundary, single-flight and generation-guarded, and it is total:
 * a delegation never fails because a refresh did.
 *
 * ## Read once, compose from the hashed bytes
 *
 * Every byte the candidate is built from is a byte this refresh already hashed:
 *
 * - Sources the manifest refresh read (changed or newly appeared) arrive in
 *   {@link PiConfigSourceRefresh.reads} and are used verbatim.
 * - Sources that did not change are served from {@link PiConfigCatalogState}'s
 *   content cache, but only when the cached digest still matches the manifest
 *   entry — a cheap identity check that never trusts stale bytes.
 * - Anything still missing (a config file the loader touches that is not
 *   cached, or a prompt file a changed config newly references) is stat'ed,
 *   read, and hashed exactly once per attempt, memoized by path.
 *
 * The caching {@link FileReader} feeds the config loader; the memoized
 * {@link PromptFileReader} feeds engine composition through
 * `PiMaterializerPort.materialize`. Both are per attempt, so bytes from one
 * candidate build never leak into the next.
 *
 * ## Two paths, one contract
 *
 * - `config-changed` runs the whole pipeline once through
 *   {@link PiConfigActivator.activate}: parse, merge, materialize, and
 *   re-resolve the Pi-local lifecycle and inspection settings.
 * - `prompt-only` never calls the config loader. It reuses the current merged
 *   `WeaveConfig` — prompt file bytes cannot change it — re-materializes with
 *   the memoized reader, and carries the current lifecycle and inspection
 *   settings through unchanged.
 * - `unchanged` returns the current activation by reference. Only the
 *   manifest's metadata and the content cache move forward.
 *
 * After either rebuild the prompt references are rediscovered from the
 * resulting config: newly referenced files are read and hashed here, and
 * references the config dropped simply leave the next manifest.
 *
 * ## Failure policy
 *
 * Failures are values of the closed {@link PiConfigRefreshFailure} union, and a
 * failed attempt returns `err` with no candidate at all — the caller keeps
 * serving the last valid catalog. A config left mid-edit (an unterminated
 * `"""` string, say) surfaces as `ConfigParseFailed` like any other diagnostic.
 *
 * One distinction matters. `materializeAgents` *accumulates* per-agent errors
 * instead of failing, and that policy is preserved: a candidate whose plan
 * carries `DescriptorCompositionFailure` entries is still a candidate, and the
 * affected descriptors are simply absent from it, exactly as at activation.
 * What does fail the attempt is this module's own source I/O — a prompt file
 * that cannot be read is `PromptFileMissing`, matching the manifest layer,
 * which already treats a disappeared prompt file as a failed refresh rather
 * than a change.
 *
 * ## Diagnostics
 *
 * Two projections, deliberately different in what they may say. The internal
 * {@link PiConfigRefreshOutcome} names the offending source and carries the
 * port's own message, because it never leaves the adapter. Everything an
 * operator sees goes through {@link PiConfigRefreshPublicState} instead: three
 * kinds, closed reason literals, and facet names from the fixed
 * primary-contract list. The coordinator emits at most one notice per distinct
 * (classification, digest-state), so a config left broken cannot flood the
 * log or the toast area at every delegation boundary.
 *
 * ## Trust
 *
 * Refresh never widens what a trust state may read. With trust withheld the
 * project config is not a manifest source at all, and both readers refuse
 * every path under `<projectRoot>/.weave/` before touching the filesystem —
 * the same boundary `createTrustWithheldFileReader` enforces at activation.
 */

import type { ConfigLoadError, FileReader } from "@weaveio/weave-config";
import type { AgentDescriptor, PromptFileReader } from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { PiCatalogCell } from "./catalog-cell.js";
import {
  buildDescriptorCatalog,
  defaultPiConfigLoaderPort,
  defaultPiMaterializerPort,
  type PiConfigActivationResult,
  PiConfigActivator,
  type PiConfigLoaderPort,
  type PiMaterializerPort,
} from "./config-activator.js";
import {
  createPiConfigSourceManifest,
  discoverPromptSourcePaths,
  hashConfigSourceContent,
  type PiConfigFileSourceKind,
  type PiConfigSourceEntry,
  type PiConfigSourceFailure,
  type PiConfigSourceFileStat,
  type PiConfigSourceFsError,
  type PiConfigSourceFsPort,
  type PiConfigSourceIdentity,
  type PiConfigSourceManifest,
  type PiConfigSourceRefresh,
  refreshConfigSourceManifest,
  resolvePiConfigSourcePaths,
} from "./config-source-digests.js";
import {
  makeConfigRefreshFailedFailure,
  type PiAdapterFailure,
  type PiConfigRefreshFailureReason,
} from "./errors.js";
import { safelyAwaitPortResult } from "./port-safety.js";
import {
  decidePiPrimaryContract,
  type PiPrimaryContractFacet,
  toPiPrimaryContractCandidate,
} from "./primary-contract.js";
import type { PiSkillResolutionPort } from "./primary-session.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Bytes of one source paired with the digest computed over exactly them. */
export interface PiConfigSourceCachedContent {
  readonly content: string;
  readonly sha256: string;
}

/**
 * Content cache keyed by absolute source path.
 *
 * Bounded by the manifest: an entry survives a refresh only while its path is
 * still a known source and its digest still matches that source's manifest
 * entry. Dropping a reference drops its bytes.
 */
export type PiConfigSourceContents = ReadonlyMap<
  string,
  PiConfigSourceCachedContent
>;

/** Everything one published (or candidate) catalog generation is made of. */
export interface PiConfigCatalogState {
  readonly activation: PiConfigActivationResult;
  readonly manifest: PiConfigSourceManifest;
  readonly contents: PiConfigSourceContents;
}

/** Injected ports for one candidate build. */
export interface PiConfigRefreshDeps {
  readonly fs: PiConfigSourceFsPort;
  readonly configLoader?: PiConfigLoaderPort;
  readonly materializer?: PiMaterializerPort;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Why a materialization attempt could not produce a plan at all. */
export type PiConfigRefreshMaterializationReason =
  /** The injected materializer threw or rejected despite its `never` error. */
  | "materialize-threw"
  /** Activation failed for a reason this module cannot attribute further. */
  | "activation-failed";

/**
 * Closed set of candidate-build failures.
 *
 * Every member means the same thing to the caller: there is no candidate, and
 * the currently published catalog and manifest stay exactly as they were.
 */
export type PiConfigRefreshFailure =
  | {
      readonly type: "SourceReadFailed";
      /** `"unknown"` only when a port threw before a source was identified. */
      readonly kind: PiConfigFileSourceKind | "unknown";
      readonly path: string | undefined;
      readonly message: string;
    }
  | {
      readonly type: "ConfigParseFailed";
      readonly errorCount: number;
      /** Deduplicated `ConfigLoadError` discriminants, sorted. */
      readonly errorTypes: readonly ConfigLoadError["type"][];
    }
  | {
      readonly type: "MaterializationFailed";
      readonly reason: PiConfigRefreshMaterializationReason;
    }
  | {
      readonly type: "LifecycleSettingsInvalid";
      readonly issueCount: number;
    }
  | {
      readonly type: "PromptFileMissing";
      readonly path: string;
    };

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/** What a refresh attempt would publish, and why. */
export interface PiConfigRefreshCandidate {
  /**
   * The classification the candidate was built from. For `"unchanged"` the
   * candidate's activation is the *same object* as the current one, so a
   * caller can skip publishing with a reference comparison.
   */
  readonly change: "unchanged" | "prompt-only" | "config-changed";
  /** Source paths whose bytes changed, as classified by the manifest layer. */
  readonly changedPaths: readonly string[];
  /** The unpublished next state. Publishing it is the caller's decision. */
  readonly next: PiConfigCatalogState;
}

// ---------------------------------------------------------------------------
// Internals: closed reason literals
// ---------------------------------------------------------------------------

const LIFECYCLE_INVALID_PREFIX = "child-lifecycle-settings-invalid:";
const CONFIG_LOAD_THREW_REASON = "config-load-threw";
const MATERIALIZE_THREW_REASON = "materialize-threw";
const STAT_PORT_THREW_MESSAGE = "stat-port-threw";
const READ_PORT_THREW_MESSAGE = "read-port-threw";
const SOURCE_PORT_THREW_MESSAGE = "source-port-threw";
const SOURCE_MISSING_MESSAGE = "missing";
const TRUST_WITHHELD_MESSAGE = "project-trust-withheld";

/**
 * Reason handed to the config loader and to engine composition when this
 * module refuses or fails a read.
 *
 * Deliberately a fixed literal: the loader copies it into a `FileReadError`
 * cause and the engine copies it into `PromptFileReadError.fileErrorMessage`,
 * and neither may carry a private path or filesystem detail. The precise,
 * typed reason travels on this module's own `err` channel instead.
 */
const SOURCE_UNAVAILABLE_MESSAGE = "weave-refresh-source-unavailable";

function uniqueSortedErrorTypes(
  errors: readonly ConfigLoadError[],
): readonly ConfigLoadError["type"][] {
  return [...new Set(errors.map((error) => error.type))].sort();
}

function parseTrailingCount(reason: string, prefix: string): number {
  const parsed = Number.parseInt(reason.slice(prefix.length), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Internals: the per-attempt source cache and readers
// ---------------------------------------------------------------------------

interface RefreshAttempt {
  /** Caching config reader handed to `PiConfigActivator`. */
  readonly fileReader: FileReader;
  /** Memoized prompt reader threaded into engine materialization. */
  readonly promptFileReader: PromptFileReader;
  /** Loader port that records the raw `ConfigLoadError[]` before mapping. */
  readonly configLoader: PiConfigLoaderPort;
  readSource(
    kind: PiConfigFileSourceKind,
    path: string,
  ): ResultAsync<PiConfigSourceCachedContent, PiConfigRefreshFailure>;
  cached(path: string): PiConfigSourceCachedContent | undefined;
  statOf(path: string): PiConfigSourceFileStat | undefined;
  /** The first typed I/O failure recorded during this attempt, if any. */
  firstFailure(): PiConfigRefreshFailure | undefined;
  /** The loader's own errors, recorded before the activator sanitized them. */
  loaderErrors(): readonly ConfigLoadError[] | undefined;
}

function createRefreshAttempt(
  current: PiConfigCatalogState,
  refresh: PiConfigSourceRefresh,
  deps: PiConfigRefreshDeps,
): RefreshAttempt {
  const identity = refresh.manifest.identity;
  const withheldPrefix = `${identity.projectRoot}/.weave/`;
  const contents = new Map<string, PiConfigSourceCachedContent>();
  const stats = new Map<string, PiConfigSourceFileStat>();
  const pending = new Map<
    string,
    ResultAsync<PiConfigSourceCachedContent, PiConfigRefreshFailure>
  >();
  const failures: PiConfigRefreshFailure[] = [];
  const kinds = new Map<string, PiConfigFileSourceKind>();
  let recordedLoaderErrors: readonly ConfigLoadError[] | undefined;

  // Seed from the manifest refresh: bytes it just read, plus bytes the caller
  // already held whose digest still matches the source's manifest entry.
  const justRead = new Map(refresh.reads.map((read) => [read.path, read]));
  for (const entry of refresh.manifest.files) {
    kinds.set(entry.path, entry.kind);
    if (entry.size !== undefined && entry.mtimeMs !== undefined) {
      stats.set(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs });
    }
    if (entry.presence !== "present" || entry.sha256 === undefined) continue;

    const read = justRead.get(entry.path);
    if (read !== undefined) {
      contents.set(entry.path, { content: read.content, sha256: read.sha256 });
      continue;
    }
    const carried = current.contents.get(entry.path);
    if (carried !== undefined && carried.sha256 === entry.sha256) {
      contents.set(entry.path, carried);
    }
  }

  const record = (failure: PiConfigRefreshFailure): PiConfigRefreshFailure => {
    failures.push(failure);
    return failure;
  };

  const isWithheld = (path: string): boolean =>
    identity.trust === "withheld" && path.startsWith(withheldPrefix);

  const missingFailure = (
    kind: PiConfigFileSourceKind,
    path: string,
  ): PiConfigRefreshFailure =>
    kind === "prompt-file"
      ? { type: "PromptFileMissing", path }
      : {
          type: "SourceReadFailed",
          kind,
          path,
          message: SOURCE_MISSING_MESSAGE,
        };

  const statSource = (
    path: string,
  ): ResultAsync<PiConfigSourceFileStat | undefined, PiConfigSourceFsError> =>
    safelyAwaitPortResult(
      () => deps.fs.statFile(path),
      (): PiConfigSourceFsError => ({
        type: "StatFailed",
        path,
        message: STAT_PORT_THREW_MESSAGE,
      }),
    );

  const readSource = (
    kind: PiConfigFileSourceKind,
    path: string,
  ): ResultAsync<PiConfigSourceCachedContent, PiConfigRefreshFailure> => {
    const already = contents.get(path);
    if (already !== undefined) return okAsync(already);

    const inFlight = pending.get(path);
    if (inFlight !== undefined) return inFlight;

    kinds.set(path, kind);

    if (isWithheld(path)) {
      return errAsync(
        record({
          type: "SourceReadFailed",
          kind,
          path,
          message: TRUST_WITHHELD_MESSAGE,
        }),
      );
    }

    // Stat before read: if the file changes in between, the stored metadata is
    // the older one, so the next probe sees a mismatch and re-hashes. This
    // module always fails toward hashing.
    const read = statSource(path)
      .mapErr(
        (error): PiConfigRefreshFailure => ({
          type: "SourceReadFailed",
          kind,
          path,
          message: error.message,
        }),
      )
      .andThen((stat) => {
        if (stat === undefined) return errAsync(missingFailure(kind, path));
        stats.set(path, stat);
        return safelyAwaitPortResult(
          () => deps.fs.readFile(path),
          (): PiConfigSourceFsError => ({
            type: "ReadFailed",
            path,
            message: READ_PORT_THREW_MESSAGE,
          }),
        ).mapErr(
          (error): PiConfigRefreshFailure => ({
            type: "SourceReadFailed",
            kind,
            path,
            message: error.message,
          }),
        );
      })
      .map((content): PiConfigSourceCachedContent => {
        const cachedContent = {
          content,
          sha256: hashConfigSourceContent(content),
        };
        contents.set(path, cachedContent);
        return cachedContent;
      })
      .mapErr((failure) => record(failure));

    pending.set(path, read);
    return read;
  };

  const configKindFor = (path: string): PiConfigFileSourceKind => {
    const known = kinds.get(path);
    if (known !== undefined) return known;
    return path.startsWith(`${identity.projectRoot}/`)
      ? "project-config"
      : "global-config";
  };

  const fileReader: FileReader = {
    exists: async (path) => {
      if (contents.has(path)) return true;
      if (isWithheld(path)) return false;

      const stat = await statSource(path);
      return stat.match(
        (value) => {
          if (value !== undefined) stats.set(path, value);
          return value !== undefined;
        },
        (error) => {
          // A source whose existence cannot be established is fail-closed:
          // the loader is told "absent" so it does not throw, and the attempt
          // is failed afterwards on the recorded typed failure.
          record({
            type: "SourceReadFailed",
            kind: configKindFor(path),
            path,
            message: error.message,
          });
          return false;
        },
      );
    },
    read: (path) =>
      readSource(configKindFor(path), path)
        .map((cachedContent) => cachedContent.content)
        .mapErr(
          (): ConfigLoadError => ({
            type: "FileReadError",
            path,
            cause: new Error(SOURCE_UNAVAILABLE_MESSAGE),
          }),
        ),
  };

  const promptFileReader: PromptFileReader = {
    read: (path) =>
      readSource("prompt-file", path)
        .map((cachedContent) => cachedContent.content)
        .mapErr(() => ({ message: SOURCE_UNAVAILABLE_MESSAGE })),
  };

  // The recording wrapper exists only to keep the loader's own typed errors:
  // `PiConfigActivator` collapses them into a closed reason string, which is
  // too coarse for this module's `ConfigParseFailed`.
  const baseLoader = deps.configLoader ?? defaultPiConfigLoaderPort;
  const configLoader: PiConfigLoaderPort = {
    load: (projectRoot, reader) =>
      baseLoader.load(projectRoot, reader).mapErr((errors) => {
        recordedLoaderErrors = errors;
        return errors;
      }),
  };

  return {
    fileReader,
    promptFileReader,
    configLoader,
    readSource,
    cached: (path) => contents.get(path),
    statOf: (path) => stats.get(path),
    firstFailure: () => failures[0],
    loaderErrors: () => recordedLoaderErrors,
  };
}

// ---------------------------------------------------------------------------
// Internals: activation and materialization
// ---------------------------------------------------------------------------

function mapActivationFailure(
  failure: PiAdapterFailure,
  attempt: RefreshAttempt,
): PiConfigRefreshFailure {
  // A recorded I/O failure is the most precise explanation available, and it
  // is the only one that can name the offending source.
  const recorded = attempt.firstFailure();
  if (recorded !== undefined) return recorded;

  const loaderErrors = attempt.loaderErrors();
  if (loaderErrors !== undefined) {
    return {
      type: "ConfigParseFailed",
      errorCount: loaderErrors.length,
      errorTypes: uniqueSortedErrorTypes(loaderErrors),
    };
  }

  const reason = failure.correlation?.reason;
  if (typeof reason === "string") {
    if (reason.startsWith(LIFECYCLE_INVALID_PREFIX)) {
      return {
        type: "LifecycleSettingsInvalid",
        issueCount: parseTrailingCount(reason, LIFECYCLE_INVALID_PREFIX),
      };
    }
    if (reason === CONFIG_LOAD_THREW_REASON) {
      return { type: "ConfigParseFailed", errorCount: 0, errorTypes: [] };
    }
    if (reason === MATERIALIZE_THREW_REASON) {
      return {
        type: "MaterializationFailed",
        reason: "materialize-threw",
      };
    }
  }
  return { type: "MaterializationFailed", reason: "activation-failed" };
}

function reactivate(
  identity: PiConfigSourceIdentity,
  attempt: RefreshAttempt,
  deps: PiConfigRefreshDeps,
): ResultAsync<PiConfigActivationResult, PiConfigRefreshFailure> {
  const activator = new PiConfigActivator({
    fileReader: attempt.fileReader,
    promptFileReader: attempt.promptFileReader,
    configLoader: attempt.configLoader,
    materializer: deps.materializer,
  });

  return activator
    .activate({ projectRoot: identity.projectRoot, trust: identity.trust })
    .mapErr((failure) => mapActivationFailure(failure, attempt));
}

function rematerialize(
  current: PiConfigCatalogState,
  attempt: RefreshAttempt,
  deps: PiConfigRefreshDeps,
): ResultAsync<PiConfigActivationResult, PiConfigRefreshFailure> {
  const materializer = deps.materializer ?? defaultPiMaterializerPort;
  const config = current.activation.config;

  return safelyAwaitPortResult(
    () => materializer.materialize(config, attempt.promptFileReader),
    (): PiConfigRefreshFailure => ({
      type: "MaterializationFailed",
      reason: "materialize-threw",
    }),
  ).map(
    (plan): PiConfigActivationResult => ({
      config,
      plan,
      descriptors: buildDescriptorCatalog(plan),
      trust: current.activation.trust,
      // Prompt bytes cannot reach the settings blocks, so the current
      // resolutions carry through untouched.
      childInspectionSettings: current.activation.childInspectionSettings,
      childLifecycleSettings: current.activation.childLifecycleSettings,
    }),
  );
}

// ---------------------------------------------------------------------------
// Internals: next manifest and content cache
// ---------------------------------------------------------------------------

function configPathsOf(manifest: PiConfigSourceManifest): {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string | undefined;
} {
  const global = manifest.files.find((file) => file.kind === "global-config");
  const project = manifest.files.find((file) => file.kind === "project-config");
  if (global !== undefined) {
    return {
      globalConfigPath: global.path,
      projectConfigPath: project?.path,
    };
  }
  // Defensive: a manifest built by `createPiConfigSourceManifest` always has a
  // global entry. Re-resolve rather than invent a path.
  const resolved = resolvePiConfigSourcePaths({ identity: manifest.identity });
  return {
    globalConfigPath: resolved.globalConfigPath,
    projectConfigPath: project?.path ?? resolved.projectConfigPath,
  };
}

function presentEntry(
  entry: PiConfigSourceEntry,
  cachedContent: PiConfigSourceCachedContent,
  stat: PiConfigSourceFileStat | undefined,
): PiConfigSourceEntry {
  return {
    kind: entry.kind,
    path: entry.path,
    presence: "present",
    // Unknown metadata is `NaN` on purpose: it never compares equal, so the
    // next probe re-hashes instead of assuming the source is unchanged.
    size: stat?.size ?? Number.NaN,
    mtimeMs: stat?.mtimeMs ?? Number.NaN,
    sha256: cachedContent.sha256,
  };
}

function completeManifestEntry(
  entry: PiConfigSourceEntry,
  attempt: RefreshAttempt,
): ResultAsync<PiConfigSourceEntry, PiConfigRefreshFailure> {
  const cachedContent = attempt.cached(entry.path);

  if (cachedContent === undefined) {
    // A prompt path a changed config now references and nothing has read yet:
    // read and hash it here, once, so the manifest is complete before publish.
    if (entry.kind === "prompt-file" && entry.sha256 === undefined) {
      return attempt
        .readSource("prompt-file", entry.path)
        .map((read) => presentEntry(entry, read, attempt.statOf(entry.path)));
    }
    return okAsync(entry);
  }

  if (entry.presence === "present" && entry.sha256 === cachedContent.sha256) {
    return okAsync(entry);
  }
  return okAsync(
    presentEntry(entry, cachedContent, attempt.statOf(entry.path)),
  );
}

function retainContents(
  attempt: RefreshAttempt,
  files: readonly PiConfigSourceEntry[],
): PiConfigSourceContents {
  const next = new Map<string, PiConfigSourceCachedContent>();
  for (const entry of files) {
    if (entry.presence !== "present" || entry.sha256 === undefined) continue;
    const cachedContent = attempt.cached(entry.path);
    if (cachedContent !== undefined && cachedContent.sha256 === entry.sha256) {
      next.set(entry.path, cachedContent);
    }
  }
  return next;
}

function buildNextState(
  activation: PiConfigActivationResult,
  refresh: PiConfigSourceRefresh,
  attempt: RefreshAttempt,
): ResultAsync<PiConfigCatalogState, PiConfigRefreshFailure> {
  const identity = refresh.manifest.identity;
  const paths = configPathsOf(refresh.manifest);
  const base = createPiConfigSourceManifest({
    identity,
    globalConfigPath: paths.globalConfigPath,
    projectConfigPath: paths.projectConfigPath,
    // Rediscovery after the rebuild: dropped references are simply absent from
    // this list and therefore leave the manifest.
    promptFilePaths: discoverPromptSourcePaths(activation.config),
    previous: refresh.manifest,
  });

  return ResultAsync.combine(
    base.files.map((entry) => completeManifestEntry(entry, attempt)),
  ).map((files: readonly PiConfigSourceEntry[]) => ({
    activation,
    manifest: { identity, builtin: base.builtin, files },
    contents: retainContents(attempt, files),
  }));
}

function failOnRecordedFailure(
  attempt: RefreshAttempt,
): ResultAsync<undefined, PiConfigRefreshFailure> {
  const failure = attempt.firstFailure();
  return failure === undefined ? okAsync(undefined) : errAsync(failure);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Distinguishes a manifest-layer failure from a misbehaving injected port. */
type ManifestRefreshError =
  | { readonly kind: "source"; readonly source: PiConfigSourceFailure }
  | { readonly kind: "threw" };

/** Maps a manifest-layer failure into this module's closed union. */
export function toPiConfigRefreshFailure(
  failure: PiConfigSourceFailure,
): PiConfigRefreshFailure {
  if (failure.type === "PromptSourceDisappeared") {
    return { type: "PromptFileMissing", path: failure.path };
  }
  return {
    type: "SourceReadFailed",
    kind: failure.kind,
    path: failure.path,
    message: failure.message,
  };
}

/**
 * Builds the candidate catalog for one already-classified refresh.
 *
 * Side-effect free: it reads sources, composes, and returns. Nothing is
 * published, no current state is mutated, and a failure leaves the caller's
 * catalog and manifest untouched.
 */
export function buildPiConfigRefreshCandidate(
  current: PiConfigCatalogState,
  refresh: PiConfigSourceRefresh,
  deps: PiConfigRefreshDeps,
): ResultAsync<PiConfigRefreshCandidate, PiConfigRefreshFailure> {
  const attempt = createRefreshAttempt(current, refresh, deps);
  const change = refresh.change;

  if (change.kind === "unchanged") {
    return okAsync({
      change: "unchanged",
      changedPaths: [],
      next: {
        activation: current.activation,
        manifest: refresh.manifest,
        contents: retainContents(attempt, refresh.manifest.files),
      },
    });
  }

  const rebuilt =
    change.kind === "prompt-only"
      ? rematerialize(current, attempt, deps)
      : reactivate(refresh.manifest.identity, attempt, deps);

  return rebuilt
    .andThen((activation) =>
      // Materialization accumulates per-agent errors instead of failing, so a
      // source this module could not read can leave a "successful" plan with a
      // silently absent descriptor. Fail the attempt on the recorded typed
      // failure rather than publish a catalog built from bytes that were never
      // obtained.
      failOnRecordedFailure(attempt).map(() => activation),
    )
    .andThen((activation) => buildNextState(activation, refresh, attempt))
    .map(
      (next): PiConfigRefreshCandidate => ({
        change: change.kind,
        changedPaths: change.changedPaths,
        next,
      }),
    );
}

/**
 * Probes, classifies, and builds a candidate in one call.
 *
 * The steady state costs one stat per known source and returns an `unchanged`
 * candidate whose activation is the current one by reference.
 */
export function refreshPiConfigCandidate(
  current: PiConfigCatalogState,
  deps: PiConfigRefreshDeps,
): ResultAsync<PiConfigRefreshCandidate, PiConfigRefreshFailure> {
  return safelyAwaitPortResult(
    () =>
      refreshConfigSourceManifest(current.manifest, deps.fs).mapErr(
        (source): ManifestRefreshError => ({ kind: "source", source }),
      ),
    (): ManifestRefreshError => ({ kind: "threw" }),
  )
    .mapErr(
      (error): PiConfigRefreshFailure =>
        error.kind === "source"
          ? toPiConfigRefreshFailure(error.source)
          : {
              type: "SourceReadFailed",
              kind: "unknown",
              path: undefined,
              message: SOURCE_PORT_THREW_MESSAGE,
            },
    )
    .andThen((refresh) =>
      buildPiConfigRefreshCandidate(current, refresh, deps),
    );
}

// ---------------------------------------------------------------------------
// Delegation-boundary coordinator
// ---------------------------------------------------------------------------

/**
 * The only clock the coordinator reads, used exclusively to space probes.
 *
 * It schedules nothing: the coordinator owns no timer, no interval, and no
 * background watcher, so a generation that stops delegating stops refreshing.
 */
export interface PiConfigRefreshClock {
  now(): number;
}

/** Why a boundary attempt could not even start. */
export type PiConfigRefreshUnavailableReason =
  /** The generation lost authority before the attempt began. */
  | "stale-generation"
  /** This generation carries no source manifest, so refresh cannot run. */
  | "no-source-manifest";

/**
 * What one boundary attempt did.
 *
 * Recorded rather than returned: `ensureFresh` resolves successfully whatever
 * happens, so this is the only place a failure or a deferral is observable.
 * Every member carries facet literals, closed reasons, and source paths only —
 * never config content.
 */
export type PiConfigRefreshOutcome =
  | {
      readonly kind: "unavailable";
      readonly reason: PiConfigRefreshUnavailableReason;
    }
  /** The cheap probe ruled every source out. Nothing was read or published. */
  | { readonly kind: "skipped" }
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "published";
      readonly change: PiConfigRefreshCandidate["change"];
      readonly changedPaths: readonly string[];
    }
  | {
      readonly kind: "deferred";
      readonly changedFacets: readonly PiPrimaryContractFacet[];
      readonly changedPaths: readonly string[];
    }
  /** The generation was revoked while the attempt ran; nothing was written. */
  | { readonly kind: "stale" }
  | { readonly kind: "failed"; readonly failure: PiConfigRefreshFailure };

// ---------------------------------------------------------------------------
// Public diagnostics
// ---------------------------------------------------------------------------

/**
 * What an operator is allowed to learn about the last refresh attempt.
 *
 * {@link PiConfigRefreshOutcome} is the adapter's own record and may name a
 * source path or carry a filesystem message. This is the projection that
 * reaches a log line, a toast, and `/weave:status`: three kinds, closed reason
 * literals, and facet names from the fixed primary-contract facet list — never
 * a path, a raw port message, config content, or prompt text.
 */
export type PiConfigRefreshPublicState =
  /** The published catalog matches what the last probe found on disk. */
  | { readonly kind: "fresh" }
  /** A valid candidate is held back because it would change the primary. */
  | {
      readonly kind: "deferred";
      readonly facets: readonly PiPrimaryContractFacet[];
    }
  /** No candidate could be built; the last valid catalog keeps serving. */
  | {
      readonly kind: "failed";
      readonly reason: PiConfigRefreshFailureReason;
    };

/** The bounded diagnostic state one generation's coordinator maintains. */
export interface PiConfigRefreshDiagnostics {
  readonly state: PiConfigRefreshPublicState;
  /** Catalog publications this generation has performed. */
  readonly publishCount: number;
}

/**
 * One operator-facing notice, emitted at most once per distinct state.
 *
 * A boundary that keeps failing the same way, or keeps re-deriving the same
 * deferral, emits nothing after the first notice: the coordinator compares an
 * internal (classification, digest-state) key and stays silent while it holds.
 */
export interface PiConfigRefreshNotice {
  readonly state: PiConfigRefreshNoticeState;
  /** Fixed, actionable text. Safe to log and to show verbatim. */
  readonly message: string;
}

/** The two states worth telling an operator about. `fresh` is not one. */
export type PiConfigRefreshNoticeState = Exclude<
  PiConfigRefreshPublicState,
  { readonly kind: "fresh" }
>;

/** The only text a primary-affecting deferral ever produces. */
export const PI_CONFIG_REFRESH_DEFERRAL_MESSAGE =
  "Weave config change affects the active primary; switch primary or restart to apply.";

/** How a deferral renders on the status line. */
const DEFERRED_STATUS_REASON = "primary-affecting";

/** Upper bound on facet names rendered on one status line. */
const MAX_RENDERED_REFRESH_FACETS = 4;

/** Upper bound on the internal dedupe key, so no state grows unboundedly. */
const MAX_NOTICE_KEY_LENGTH = 256;

const FRESH_STATE: PiConfigRefreshPublicState = Object.freeze({
  kind: "fresh",
});

/** Projects an internal failure onto the closed public reason set. */
export function toPiConfigRefreshPublicReason(
  failure: PiConfigRefreshFailure,
): PiConfigRefreshFailureReason {
  switch (failure.type) {
    case "SourceReadFailed":
      return "source-unreadable";
    case "ConfigParseFailed":
      return "config-invalid";
    case "PromptFileMissing":
      return "prompt-unavailable";
    case "LifecycleSettingsInvalid":
      return "settings-invalid";
    case "MaterializationFailed":
      return "composition-failed";
  }
}

/**
 * Projects one recorded outcome onto the public state.
 *
 * `undefined` means the attempt taught an operator nothing new: a debounced
 * probe, a generation that lost authority, or a generation with no manifest
 * at all leave the last rendered state exactly as it was.
 */
export function toPiConfigRefreshPublicState(
  outcome: PiConfigRefreshOutcome,
): PiConfigRefreshPublicState | undefined {
  switch (outcome.kind) {
    case "unchanged":
    case "published":
      return FRESH_STATE;
    case "deferred":
      return { kind: "deferred", facets: outcome.changedFacets };
    case "failed":
      return {
        kind: "failed",
        reason: toPiConfigRefreshPublicReason(outcome.failure),
      };
    case "skipped":
    case "stale":
    case "unavailable":
      return undefined;
  }
}

/**
 * One concise `/weave:status` row.
 *
 * Every component is closed or numeric: the outcome kind, a closed reason
 * literal, the generation's publish count, and a hard-capped number of facet
 * names from the fixed contract list. Nothing here can carry a path or any
 * config byte.
 */
export function renderPiConfigRefreshStatusLine(
  diagnostics: PiConfigRefreshDiagnostics,
): string {
  const { state } = diagnostics;
  const suffix = `published ${diagnostics.publishCount}`;
  if (state.kind === "failed") {
    return `config refresh: failed: ${state.reason}; ${suffix}`;
  }
  if (state.kind === "fresh") {
    return `config refresh: fresh; ${suffix}`;
  }
  const shown = state.facets.slice(0, MAX_RENDERED_REFRESH_FACETS);
  const omitted = state.facets.length - shown.length;
  const facets =
    shown.length === 0
      ? ""
      : `; facets ${shown.join(", ")}${omitted > 0 ? ` (+${omitted})` : ""}`;
  return `config refresh: deferred: ${DEFERRED_STATUS_REASON}; ${suffix}${facets}`;
}

/** Everything one generation's coordinator reads. */
export interface PiConfigRefreshCoordinatorDeps {
  /** The generation's catalog cell. The only thing the coordinator writes. */
  readonly catalog: PiCatalogCell;
  /**
   * Whether this generation still holds authority. Consulted before an
   * attempt starts and again immediately before publication, so an attempt
   * that spans a session replacement writes nothing.
   */
  readonly ownsGeneration: () => boolean;
  readonly fs: PiConfigSourceFsPort;
  readonly configLoader?: PiConfigLoaderPort;
  readonly materializer?: PiMaterializerPort;
  /** The committed primary descriptor, or `undefined` before one commits. */
  readonly primary: () => AgentDescriptor | undefined;
  /** The `disabled.skills` the committed primary was rendered with. */
  readonly primaryDisabledSkills: () => readonly string[];
  /** Pi's current skill-discovery snapshot, as activation resolves it. */
  readonly skills: () => PiSkillResolutionPort;
  readonly clock: PiConfigRefreshClock;
  /**
   * Smallest gap between two probes. A burst of parallel delegations inside
   * one window therefore costs one probe. `0` disables spacing entirely,
   * which is what tests use.
   */
  readonly minIntervalMs?: number;
  /** Receives every recorded outcome, for diagnostics surfaces. */
  readonly onOutcome?: (outcome: PiConfigRefreshOutcome) => void;
  /**
   * Receives one notice per distinct failure or deferral state.
   *
   * Called only when the state an operator would act on actually changed, so
   * a boundary that keeps failing identically stays silent after the first
   * notice. Success emits nothing: the rendered state simply returns to
   * `fresh`, and a later failure of the same kind is a new state again.
   */
  readonly onNotice?: (notice: PiConfigRefreshNotice) => void;
}

/**
 * The one refresh orchestrator a generation runs at its delegation boundaries.
 *
 * `ensureFresh` is called before a delegation resolves its target or
 * descriptor: root `weave_delegate`, an authenticated nested relay, a direct
 * workflow step, and a recovery restore. It is *total* — its error type is
 * `never` — because refresh must never fail a delegation. A probe that fails,
 * a config left mid-edit, or a candidate the primary-contract guard holds back
 * all resolve successfully with the last valid catalog still serving; only
 * {@link PiConfigRefreshCoordinator.lastOutcome} records what happened.
 */
export interface PiConfigRefreshCoordinator {
  /**
   * Probes, classifies, builds, guards, and publishes — at most once per
   * concurrent burst. Concurrent callers join the single in-flight attempt
   * rather than starting their own.
   */
  ensureFresh(): ResultAsync<void, never>;
  /**
   * Re-evaluates after an explicit primary reactivation committed.
   *
   * The stored deferred snapshot is dropped rather than published: it was
   * validated against the *previous* primary and may have been built from
   * bytes that have since changed. A fresh probe and rebuild run instead, and
   * the result is guarded against the newly active primary.
   */
  refreshAfterPrimaryReactivation(): ResultAsync<void, never>;
  /** The last recorded attempt outcome, or `undefined` before the first. */
  lastOutcome(): PiConfigRefreshOutcome | undefined;
  /**
   * The bounded state a status surface renders.
   *
   * A generation that has never refreshed reads `fresh` with a publish count
   * of zero: its catalog is exactly what boot activation produced.
   */
  diagnostics(): PiConfigRefreshDiagnostics;
  /**
   * Drops all coordinator state. An attempt still in flight can no longer
   * publish, defer, or record anything.
   */
  dispose(): void;
}

/** Production spacing between probes. Tests pass `0`. */
export const DEFAULT_PI_CONFIG_REFRESH_MIN_INTERVAL_MS = 250;

const REFRESH_THREW_MESSAGE = "refresh-threw";

/**
 * Whether the probe moved any source entry.
 *
 * `refreshChangedSources` returns the *same entry object* for a source it
 * ruled unchanged, so reference equality is exact for the fast path: all
 * entries identical means nothing was read and there is nothing to publish.
 * Any other shape (fresh metadata after a re-hash, an entry that appeared or
 * disappeared) is worth publishing so the next probe stays cheap.
 */
function manifestEntriesMoved(
  current: PiConfigSourceManifest,
  next: PiConfigSourceManifest,
): boolean {
  if (current.files.length !== next.files.length) return true;
  return next.files.some((entry, index) => current.files[index] !== entry);
}

/**
 * The internal half of the dedupe key: what distinguishes *this* failed or
 * deferred boundary from the previous one of the same classification.
 *
 * Coordinator-private and never rendered, logged, or handed to a notice, so
 * it may read the source detail the public projection drops. Bounded by
 * {@link MAX_NOTICE_KEY_LENGTH}: a pathological manifest cannot grow it.
 */
function failureDigestToken(failure: PiConfigRefreshFailure): string {
  switch (failure.type) {
    case "SourceReadFailed":
      return `${failure.kind}|${failure.path ?? ""}|${failure.message}`;
    case "ConfigParseFailed":
      return `${failure.errorCount}|${failure.errorTypes.join(",")}`;
    case "PromptFileMissing":
      return failure.path;
    case "LifecycleSettingsInvalid":
      return String(failure.issueCount);
    case "MaterializationFailed":
      return failure.reason;
  }
}

/**
 * The (classification, digest-state) key one notice is deduped by.
 *
 * A `fresh` state collapses to a single key, so a recovery clears the way for
 * a later identical failure to notify exactly once more.
 */
function noticeKeyOf(
  state: PiConfigRefreshPublicState,
  outcome: PiConfigRefreshOutcome,
): string {
  const classification = classificationKeyOf(state);
  const digest = digestKeyOf(outcome);
  return `${classification}#${digest}`.slice(0, MAX_NOTICE_KEY_LENGTH);
}

function classificationKeyOf(state: PiConfigRefreshPublicState): string {
  if (state.kind === "failed") return `failed:${state.reason}`;
  if (state.kind === "deferred") {
    return `deferred:${[...state.facets].sort().join(",")}`;
  }
  return "fresh";
}

function digestKeyOf(outcome: PiConfigRefreshOutcome): string {
  if (outcome.kind === "failed") return failureDigestToken(outcome.failure);
  if (outcome.kind === "deferred") {
    return [...outcome.changedPaths].sort().join("|");
  }
  return "";
}

/** The fixed text one notice carries. */
function noticeMessageOf(state: PiConfigRefreshNoticeState): string {
  return state.kind === "failed"
    ? makeConfigRefreshFailedFailure(state.reason).safeMessage
    : PI_CONFIG_REFRESH_DEFERRAL_MESSAGE;
}

/**
 * Builds one generation's refresh coordinator.
 *
 * Constructed only by generations that actually register delegation surfaces;
 * health-only and trust-withheld generations have no boundary to trigger it
 * from and never build one.
 */
export function createPiConfigRefreshCoordinator(
  deps: PiConfigRefreshCoordinatorDeps,
): PiConfigRefreshCoordinator {
  const minIntervalMs = deps.minIntervalMs ?? 0;
  const buildDeps: PiConfigRefreshDeps = {
    fs: deps.fs,
    ...(deps.configLoader === undefined
      ? {}
      : { configLoader: deps.configLoader }),
    ...(deps.materializer === undefined
      ? {}
      : { materializer: deps.materializer }),
  };

  let disposed = false;
  let inFlight: Promise<void> | undefined;
  let lastProbeAtMs: number | undefined;
  let outcome: PiConfigRefreshOutcome | undefined;
  let publicState: PiConfigRefreshPublicState = FRESH_STATE;
  let publishCount = 0;
  let noticeKey: string | undefined;

  const owns = (): boolean => !disposed && deps.ownsGeneration();

  const record = (next: PiConfigRefreshOutcome): void => {
    if (disposed) return;
    outcome = next;
    if (next.kind === "published") publishCount += 1;

    // An attempt that taught an operator nothing new (a debounced probe, a
    // revoked generation) leaves both the rendered state and the dedupe key
    // untouched, so it can neither hide nor re-trigger a notice.
    const nextState = toPiConfigRefreshPublicState(next);
    if (nextState !== undefined) {
      publicState = nextState;
      const key = noticeKeyOf(nextState, next);
      if (key !== noticeKey) {
        noticeKey = key;
        if (nextState.kind !== "fresh") {
          deps.onNotice?.({
            state: nextState,
            message: noticeMessageOf(nextState),
          });
        }
      }
    }
    deps.onOutcome?.(next);
  };

  /** Whether enough time has passed since the last probe started. */
  const dueForProbe = (): boolean => {
    if (minIntervalMs <= 0 || lastProbeAtMs === undefined) return true;
    const elapsed = deps.clock.now() - lastProbeAtMs;
    // A clock that moved backwards is never proof that a probe is too recent.
    return !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= minIntervalMs;
  };

  /** Applies one built candidate. Synchronous, so nothing races the guard. */
  const applyCandidate = (
    current: PiConfigCatalogState,
    candidate: PiConfigRefreshCandidate,
  ): PiConfigRefreshOutcome => {
    if (!owns()) return { kind: "stale" };

    if (candidate.change === "unchanged") {
      // The candidate's activation *is* the current one, so there is no
      // contract to guard: only probe metadata can have moved.
      if (!manifestEntriesMoved(current.manifest, candidate.next.manifest)) {
        return { kind: "unchanged" };
      }
      return deps.catalog.publish(candidate.next) === "accepted"
        ? { kind: "published", change: "unchanged", changedPaths: [] }
        : { kind: "stale" };
    }

    const decision = decidePiPrimaryContract({
      primary: deps.primary(),
      disabledSkills: deps.primaryDisabledSkills(),
      candidate: toPiPrimaryContractCandidate(candidate.next.activation),
      skills: deps.skills(),
    });
    if (decision.decision === "primary-affecting") {
      // Held, never applied, and the manifest stays where it is: the next
      // boundary re-probes, so the deferral is re-derived from whatever is on
      // disk then rather than frozen at this attempt.
      return deps.catalog.defer({
        state: candidate.next,
        changedFacets: decision.changedFacets,
        changedPaths: candidate.changedPaths,
      }) === "accepted"
        ? {
            kind: "deferred",
            changedFacets: decision.changedFacets,
            changedPaths: candidate.changedPaths,
          }
        : { kind: "stale" };
    }

    // Re-checked immediately before the write: the generation may have been
    // revoked while the candidate was being built.
    if (!owns()) return { kind: "stale" };
    return deps.catalog.publish(candidate.next) === "accepted"
      ? {
          kind: "published",
          change: candidate.change,
          changedPaths: candidate.changedPaths,
        }
      : { kind: "stale" };
  };

  const attempt = (): Promise<PiConfigRefreshOutcome> => {
    if (!owns()) {
      return Promise.resolve<PiConfigRefreshOutcome>({
        kind: "unavailable",
        reason: "stale-generation",
      });
    }
    const current = deps.catalog.refreshState();
    if (current === undefined) {
      return Promise.resolve<PiConfigRefreshOutcome>({
        kind: "unavailable",
        reason: "no-source-manifest",
      });
    }
    lastProbeAtMs = deps.clock.now();

    return ResultAsync.fromPromise(
      refreshPiConfigCandidate(current, buildDeps).match(
        (candidate) => applyCandidate(current, candidate),
        (failure): PiConfigRefreshOutcome => ({ kind: "failed", failure }),
      ),
      // Defense in depth: every port this module owns is already wrapped, so
      // reaching here means an injected port broke its own contract. The
      // delegation still proceeds on the last valid catalog.
      (): PiConfigRefreshOutcome => ({
        kind: "failed",
        failure: {
          type: "SourceReadFailed",
          kind: "unknown",
          path: undefined,
          message: REFRESH_THREW_MESSAGE,
        },
      }),
    ).match(
      (settled) => settled,
      (failed) => failed,
    );
  };

  const start = (force: boolean): Promise<void> => {
    if (disposed) return Promise.resolve();
    const joined = inFlight;
    if (joined !== undefined) return joined;
    if (!force && !dueForProbe()) {
      record({ kind: "skipped" });
      return Promise.resolve();
    }
    // Assigned synchronously, before any caller can await, so a burst of
    // boundaries in the same tick joins this exact attempt.
    const running = attempt().then((settled) => {
      inFlight = undefined;
      record(settled);
    });
    inFlight = running;
    return running;
  };

  return {
    ensureFresh: () => ResultAsync.fromSafePromise(start(false)),
    refreshAfterPrimaryReactivation: () =>
      ResultAsync.fromSafePromise(
        (async () => {
          // An attempt that started under the previous primary is drained
          // first, so the stored deferral this drops is the final one.
          const pending = inFlight;
          if (pending !== undefined) await pending;
          if (disposed) return;
          deps.catalog.takeDeferred();
          await start(true);
        })(),
      ),
    lastOutcome: () => outcome,
    diagnostics: () => ({ state: publicState, publishCount }),
    dispose: () => {
      disposed = true;
      inFlight = undefined;
      lastProbeAtMs = undefined;
      outcome = undefined;
      publicState = FRESH_STATE;
      publishCount = 0;
      noticeKey = undefined;
    },
  };
}
