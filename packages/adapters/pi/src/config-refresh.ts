/**
 * Candidate catalog builder for the Pi adapter's config refresh.
 *
 * The digest manifest in `config-source-digests.ts` answers *what changed*.
 * This module answers *what the catalog would become* — and nothing more. It
 * builds a fully validated {@link PiConfigActivationResult} plus the next
 * manifest and content cache, and hands them back to the caller. It never
 * publishes, never mutates the current catalog, and holds no state between
 * attempts.
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
 * ## Trust
 *
 * Refresh never widens what a trust state may read. With trust withheld the
 * project config is not a manifest source at all, and both readers refuse
 * every path under `<projectRoot>/.weave/` before touching the filesystem —
 * the same boundary `createTrustWithheldFileReader` enforces at activation.
 */

import type { ConfigLoadError, FileReader } from "@weaveio/weave-config";
import type { PromptFileReader } from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
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
import type { PiAdapterFailure } from "./errors.js";
import { safelyAwaitPortResult } from "./port-safety.js";

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
