/**
 * Per-source digest manifest for the Pi adapter's config source graph.
 *
 * The adapter refreshes its catalog at delegation boundaries. The steady state
 * — nothing on disk changed — must cost only cheap metadata probes, so this
 * module separates three concerns:
 *
 * 1. {@link probeConfigSources} stats every known file source and classifies it
 *    as `unchanged`, `absent-unchanged`, `maybe-changed`, `appeared`, or
 *    `disappeared`. No file is read.
 * 2. {@link refreshChangedSources} reads and hashes only the sources a probe
 *    could not rule out, and returns the exact bytes it read so the caller
 *    parses/composes from the same bytes that were hashed.
 * 3. {@link classifyConfigSourceChange} folds the per-source results into one
 *    overall outcome.
 *
 * ## Digest semantics
 *
 * Every file source keeps its **own** SHA-256; digests are never taken over a
 * concatenation of several files. The digest covers the **raw bytes as read**:
 * DSL-level normalization (CRLF handling inside the lexer, dedent of
 * triple-quoted strings) happens after hashing, so two byte-different encodings
 * of the same logical prompt are two different digests. That is intentional —
 * change detection is byte-level, and a spurious "changed" verdict only costs
 * one candidate rebuild, while a missed change would serve stale config.
 *
 * The builtin layer is the one exception to "one digest per file": builtins
 * ship inside the process as a DSL string plus embedded prompt contents, so
 * they form a single immutable source with a single, length-framed digest that
 * is computed once per process and never re-probed.
 *
 * ## Detection bound: same-size, same-mtime rewrites
 *
 * The cheap path compares `size` and `mtimeMs` only. A rewrite that preserves
 * both — same byte length, and an mtime that lands in the same filesystem
 * timestamp tick (some filesystems expose 1s or 1ms granularity) — is invisible
 * to the probe and is reported as `unchanged`. Size participates in the
 * comparison to narrow that window, but it does not close it. Callers that need
 * an unconditional guarantee must re-hash, not re-probe. Conversely, whenever
 * metadata is unreliable the production port reports `Number.NaN`, which never
 * compares equal and therefore forces a re-hash: this module always fails
 * toward hashing, never toward assuming a source is unchanged.
 *
 * ## Overall classification
 *
 * The four outcomes named by {@link PiConfigSourceChangeKind} are
 * `unchanged`, `prompt-only`, `config-changed`, and `failed`. The first three
 * are values of {@link PiConfigSourceChange}; `failed` is the `err` channel —
 * a typed {@link PiConfigSourceFailure} carrying the stat/read failure or the
 * deletion of a known prompt file. A deleted prompt file is a failure, not a
 * change: composition would break, so the caller must keep the last valid
 * catalog. A global or project config file that appears or disappears is a
 * normal config change; either absence is a valid state.
 */

import { homedir } from "node:os";
import {
  BUILTIN_PROMPT_CONTENTS,
  BUILTIN_WEAVE_SOURCE,
  normalizePath,
} from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { PiTrustState } from "./types.js";

// ---------------------------------------------------------------------------
// Source model
// ---------------------------------------------------------------------------

/** Every kind of source the adapter's catalog is derived from. */
export type PiConfigSourceKind =
  | "builtin"
  | "global-config"
  | "project-config"
  | "prompt-file";

/** The source kinds that live in a file and therefore carry file metadata. */
export type PiConfigFileSourceKind = Exclude<PiConfigSourceKind, "builtin">;

/** Whether a known file source existed at the last successful probe. */
export type PiConfigSourcePresence = "present" | "absent";

/**
 * Identity inputs that decide *which* sources exist at all.
 *
 * A change to either input invalidates the whole manifest — it is a different
 * source graph, not a changed source — and is handled by session replacement,
 * never by refresh.
 */
export interface PiConfigSourceIdentity {
  readonly projectRoot: string;
  readonly trust: PiTrustState;
}

/**
 * One known file source and what the last successful probe/read observed.
 *
 * `size`, `mtimeMs`, and `sha256` are `undefined` exactly when `presence` is
 * `"absent"` — an absent file has no metadata and no digest, and is never
 * conflated with an empty file (which has presence `"present"` and the SHA-256
 * of the empty string).
 */
export interface PiConfigSourceEntry {
  readonly kind: PiConfigFileSourceKind;
  readonly path: string;
  readonly presence: PiConfigSourcePresence;
  /** Byte size observed at the last probe; `undefined` while absent. */
  readonly size: number | undefined;
  /** Modification time in ms at the last probe; `undefined` while absent. */
  readonly mtimeMs: number | undefined;
  /** 64-hex SHA-256 of the exact bytes last read; `undefined` while absent. */
  readonly sha256: string | undefined;
}

/** The immutable in-process builtin layer and its process-stable digest. */
export interface PiBuiltinSourceEntry {
  readonly kind: "builtin";
  readonly sha256: string;
}

/** The full config source graph with the last observed state of each source. */
export interface PiConfigSourceManifest {
  readonly identity: PiConfigSourceIdentity;
  readonly builtin: PiBuiltinSourceEntry;
  /** File sources in deterministic order: global, project, then prompts. */
  readonly files: readonly PiConfigSourceEntry[];
}

// ---------------------------------------------------------------------------
// Filesystem port
// ---------------------------------------------------------------------------

/** The metadata the cheap probe compares. */
export interface PiConfigSourceFileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

/** Typed failure raised by a {@link PiConfigSourceFsPort} operation. */
export type PiConfigSourceFsError =
  | {
      readonly type: "StatFailed";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly type: "ReadFailed";
      readonly path: string;
      readonly message: string;
    };

/**
 * Injectable filesystem seam. Adapter tests supply a fake; production uses
 * {@link defaultPiConfigSourceFsPort}.
 */
export interface PiConfigSourceFsPort {
  /** Resolves `undefined` when the file does not exist (a valid state). */
  statFile(
    path: string,
  ): ResultAsync<PiConfigSourceFileStat | undefined, PiConfigSourceFsError>;
  /** Reads the file's full text content. */
  readFile(path: string): ResultAsync<string, PiConfigSourceFsError>;
}

/** The subset of `BunFile` this module uses, so the opener can be faked. */
export interface PiConfigSourceFileHandle {
  stat(): Promise<{
    readonly size: number;
    readonly mtimeMs: number;
    isFile(): boolean;
  }>;
  text(): Promise<string>;
}

/** Opens a path for stat/read. Defaults to `Bun.file`. */
export type PiConfigSourceFileOpener = (
  path: string,
) => PiConfigSourceFileHandle;

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

const MISSING_FILE_CODE_SCHEMA = z.enum(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);
interface MissingFileCauseObject {
  readonly missingFileCauseObjectMarker?: never;
}
const MISSING_FILE_CAUSE_OBJECT_SCHEMA = z.custom<MissingFileCauseObject>(
  (value) =>
    Result.fromThrowable(
      () =>
        value !== null &&
        Object(value) === value &&
        !Array.isArray(value) &&
        !(value instanceof Function),
      (): boolean => false,
    )().unwrapOr(false),
);

function isMissingFileCause(cause: unknown): boolean {
  const parsedCause = MISSING_FILE_CAUSE_OBJECT_SCHEMA.safeParse(cause);
  if (!parsedCause.success) return false;
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(parsedCause.data, "code"),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (descriptor.isErr() || descriptor.value === undefined) return false;
  if (!("value" in descriptor.value)) return false;
  return MISSING_FILE_CODE_SCHEMA.safeParse(descriptor.value.value).success;
}

/**
 * Converts raw stat metadata into comparable metadata, substituting
 * `Number.NaN` for any value that is not a finite number.
 *
 * `NaN !== NaN`, so an unreliable value degrades the source to `maybe-changed`
 * on every probe and forces a re-hash. Nothing is ever assumed unchanged
 * because its metadata was unreadable.
 */
function toComparableStat(stat: {
  readonly size: number;
  readonly mtimeMs: number;
}): PiConfigSourceFileStat {
  const size =
    Number.isFinite(stat.size) && stat.size >= 0 ? stat.size : Number.NaN;
  const mtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Number.NaN;
  return { size, mtimeMs };
}

/**
 * Builds the production filesystem port.
 *
 * `open` exists so tests can exercise this port's own error mapping without
 * touching the real filesystem. Production callers use the default.
 */
export function createPiConfigSourceFsPort(
  open: PiConfigSourceFileOpener = (path) => Bun.file(path),
): PiConfigSourceFsPort {
  return {
    statFile: (path) =>
      ResultAsync.fromPromise(
        Promise.resolve().then(() => open(path).stat()),
        (cause) => cause,
      )
        .andThen((stat) => {
          if (!stat.isFile()) {
            return errAsync<PiConfigSourceFileStat | undefined, unknown>(
              new Error("not a regular file"),
            );
          }
          return okAsync<PiConfigSourceFileStat | undefined, unknown>(
            toComparableStat(stat),
          );
        })
        .orElse((cause) => {
          if (isMissingFileCause(cause)) {
            return okAsync<
              PiConfigSourceFileStat | undefined,
              PiConfigSourceFsError
            >(void 0);
          }
          return errAsync<
            PiConfigSourceFileStat | undefined,
            PiConfigSourceFsError
          >({
            type: "StatFailed",
            path,
            message: describeCause(cause),
          });
        }),
    readFile: (path) =>
      ResultAsync.fromPromise(
        Promise.resolve().then(() => open(path).text()),
        (cause): PiConfigSourceFsError => ({
          type: "ReadFailed",
          path,
          message: describeCause(cause),
        }),
      ),
  };
}

/** Production filesystem port, backed by `Bun.file`. */
export const defaultPiConfigSourceFsPort: PiConfigSourceFsPort =
  createPiConfigSourceFsPort();

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/** Matches a lowercase 64-hex SHA-256 digest. */
export const PI_CONFIG_SOURCE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** SHA-256 of `content`'s UTF-8 bytes as lowercase 64-hex. */
export function hashConfigSourceContent(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content, "utf8").digest("hex");
}

let cachedBuiltinDigest: string | undefined;

function computeBuiltinSourceDigest(): string {
  const hasher = new Bun.CryptoHasher("sha256");
  // Length framing keeps the digest unambiguous: no rearrangement of the DSL
  // source and the embedded prompts can produce the same byte stream.
  hasher.update(
    `weave-builtin-source:${BUILTIN_WEAVE_SOURCE.length}\n`,
    "utf8",
  );
  hasher.update(BUILTIN_WEAVE_SOURCE, "utf8");
  for (const name of Object.keys(BUILTIN_PROMPT_CONTENTS).sort()) {
    const content = BUILTIN_PROMPT_CONTENTS[name] ?? "";
    hasher.update(`prompt:${name}:${content.length}\n`, "utf8");
    hasher.update(content, "utf8");
  }
  return hasher.digest("hex");
}

/**
 * The builtin layer's digest, computed once per process.
 *
 * Builtins ship inside the bundle: they cannot change while the process runs,
 * so they are never stat'ed, never read, and never re-probed.
 */
export function getPiBuiltinSourceDigest(): string {
  if (cachedBuiltinDigest === undefined) {
    cachedBuiltinDigest = computeBuiltinSourceDigest();
  }
  return cachedBuiltinDigest;
}

// ---------------------------------------------------------------------------
// Manifest construction
// ---------------------------------------------------------------------------

/** Canonical config file locations for one activation identity. */
export interface PiConfigSourcePaths {
  readonly globalConfigPath: string;
  /** `undefined` when project trust is withheld: the file is not a source. */
  readonly projectConfigPath: string | undefined;
}

/**
 * Resolves the config file locations `@weaveio/weave-config` discovery uses.
 *
 * Mirrors `discoverAndParse`'s home resolution (`HOME`, then `USERPROFILE`,
 * then `os.homedir()`) so the manifest tracks exactly the files the loader
 * reads. When trust is withheld the project config is not a source at all,
 * matching `createTrustWithheldFileReader`: refresh never widens what a trust
 * state may read.
 */
export function resolvePiConfigSourcePaths(input: {
  readonly identity: PiConfigSourceIdentity;
  readonly homeDir?: string;
}): PiConfigSourcePaths {
  const home =
    input.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return {
    globalConfigPath: normalizePath(`${home}/.weave/config.weave`),
    projectConfigPath:
      input.identity.trust === "withheld"
        ? undefined
        : normalizePath(`${input.identity.projectRoot}/.weave/config.weave`),
  };
}

function unknownEntry(
  kind: PiConfigFileSourceKind,
  path: string,
): PiConfigSourceEntry {
  return {
    kind,
    path,
    presence: "absent",
    size: undefined,
    mtimeMs: undefined,
    sha256: undefined,
  };
}

export interface PiConfigSourceManifestInput {
  readonly identity: PiConfigSourceIdentity;
  readonly globalConfigPath: string;
  readonly projectConfigPath: string | undefined;
  readonly promptFilePaths: readonly string[];
  /**
   * Optional prior manifest. Entries for paths that survive are carried over
   * with their metadata and digest, so a rebuild after a config change does not
   * discard what is already known about unchanged prompt files.
   */
  readonly previous?: PiConfigSourceManifest;
}

/**
 * Builds a manifest for one source graph.
 *
 * A path with no carried-over entry starts as `absent` with no digest. The next
 * probe therefore reports `appeared` for a file that exists, which reads and
 * hashes it — never a silent "assume unchanged".
 */
export function createPiConfigSourceManifest(
  input: PiConfigSourceManifestInput,
): PiConfigSourceManifest {
  const carried = new Map<string, PiConfigSourceEntry>();
  for (const entry of input.previous?.files ?? []) {
    carried.set(entry.path, entry);
  }

  const files: PiConfigSourceEntry[] = [];
  const seen = new Set<string>();

  const push = (kind: PiConfigFileSourceKind, path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const previous = carried.get(path);
    files.push(
      previous !== undefined && previous.kind === kind
        ? previous
        : unknownEntry(kind, path),
    );
  };

  push("global-config", input.globalConfigPath);
  if (input.projectConfigPath !== undefined) {
    push("project-config", input.projectConfigPath);
  }
  for (const path of [...input.promptFilePaths].sort()) {
    push("prompt-file", path);
  }

  return {
    identity: input.identity,
    builtin: { kind: "builtin", sha256: getPiBuiltinSourceDigest() },
    files,
  };
}

// ---------------------------------------------------------------------------
// Prompt reference discovery
// ---------------------------------------------------------------------------

/**
 * Every prompt-file path a merged `WeaveConfig` references, sorted and
 * deduplicated.
 *
 * Covers all reference sites the schema supports: agent `prompt_file` and
 * `prompt_append_file`, category `prompt_append_file`, workflow
 * `prompt_append_file`, and workflow-step `prompt_append_file`. Inline prompts
 * — single-line or triple-quoted multiline — get no entry: they are bytes of
 * their owning config file and are covered by that file's digest.
 *
 * Paths are taken verbatim, exactly as composition will pass them to the
 * filesystem. `resolvePromptPaths` has already made global- and project-scope
 * paths absolute, and builtin prompts are inlined before merge.
 */
export function discoverPromptSourcePaths(
  config: WeaveConfig,
): readonly string[] {
  const paths = new Set<string>();
  const add = (path: string | undefined): void => {
    if (path !== undefined && path.length > 0) paths.add(path);
  };

  for (const agent of Object.values(config.agents)) {
    add(agent.prompt_file);
    add(agent.prompt_append_file);
  }
  for (const category of Object.values(config.categories ?? {})) {
    add(category.prompt_append_file);
  }
  for (const workflow of Object.values(config.workflows ?? {})) {
    add(workflow.prompt_append_file);
    for (const step of workflow.steps ?? []) {
      add(step.prompt_append_file);
    }
  }

  return [...paths].sort();
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/** Per-source verdict of the cheap metadata probe. */
export type PiConfigSourceProbeStatus =
  | "unchanged"
  | "absent-unchanged"
  | "maybe-changed"
  | "appeared"
  | "disappeared";

/** One probed source: its cached entry, the fresh metadata, and the verdict. */
export interface PiConfigSourceProbe {
  readonly entry: PiConfigSourceEntry;
  readonly status: PiConfigSourceProbeStatus;
  /** Fresh metadata; `undefined` when the file does not exist. */
  readonly stat: PiConfigSourceFileStat | undefined;
}

/** The `failed` classification: why a refresh could not be completed. */
export type PiConfigSourceFailure =
  | {
      readonly type: "SourceStatFailed";
      readonly kind: PiConfigFileSourceKind;
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly type: "SourceReadFailed";
      readonly kind: PiConfigFileSourceKind;
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly type: "PromptSourceDisappeared";
      readonly kind: "prompt-file";
      readonly path: string;
    };

function statusFor(
  entry: PiConfigSourceEntry,
  stat: PiConfigSourceFileStat | undefined,
): PiConfigSourceProbeStatus {
  if (stat === undefined) {
    return entry.presence === "absent" ? "absent-unchanged" : "disappeared";
  }
  if (entry.presence === "absent" || entry.sha256 === undefined) {
    return "appeared";
  }
  // NaN metadata (unreliable stat, either cached or fresh) never compares
  // equal, so the source degrades to `maybe-changed` and gets re-hashed.
  return entry.size === stat.size && entry.mtimeMs === stat.mtimeMs
    ? "unchanged"
    : "maybe-changed";
}

/**
 * Stats every known file source. Reads nothing.
 *
 * A stat failure that is not "file missing" is a typed failure: the refresh
 * cannot prove the source is unchanged, and guessing is not allowed.
 */
export function probeConfigSources(
  manifest: PiConfigSourceManifest,
  fs: PiConfigSourceFsPort,
): ResultAsync<readonly PiConfigSourceProbe[], PiConfigSourceFailure> {
  const probes = manifest.files.map((entry) =>
    fs
      .statFile(entry.path)
      .map(
        (stat): PiConfigSourceProbe => ({
          entry,
          status: statusFor(entry, stat),
          stat,
        }),
      )
      .mapErr(
        (error): PiConfigSourceFailure => ({
          type: "SourceStatFailed",
          kind: entry.kind,
          path: entry.path,
          message: error.message,
        }),
      ),
  );

  return ResultAsync.combine(probes).map(
    (settled): readonly PiConfigSourceProbe[] => settled,
  );
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** Bytes read during a refresh, with the digest computed over those bytes. */
export interface PiConfigSourceRead {
  readonly kind: PiConfigFileSourceKind;
  readonly path: string;
  /** The exact content that was hashed. Callers parse/compose from this. */
  readonly content: string;
  readonly sha256: string;
  /** `false` when the bytes hashed to the digest already cached. */
  readonly contentChanged: boolean;
}

/** The three non-failure outcomes of a refresh. */
export type PiConfigSourceChange =
  | { readonly kind: "unchanged" }
  | { readonly kind: "prompt-only"; readonly changedPaths: readonly string[] }
  | {
      readonly kind: "config-changed";
      readonly changedPaths: readonly string[];
    };

/**
 * All four overall outcomes. `failed` is not a {@link PiConfigSourceChange}
 * value — it is the `err` channel, a typed {@link PiConfigSourceFailure}.
 */
export type PiConfigSourceChangeKind = PiConfigSourceChange["kind"] | "failed";

/** A completed refresh: the next manifest, the bytes read, and the verdict. */
export interface PiConfigSourceRefresh {
  readonly manifest: PiConfigSourceManifest;
  readonly reads: readonly PiConfigSourceRead[];
  readonly change: PiConfigSourceChange;
}

/**
 * One source after refresh: its next entry, the bytes read (if any), and
 * whether a config file that used to exist is now gone.
 */
export interface PiConfigSourceRefreshedSource {
  readonly entry: PiConfigSourceEntry;
  readonly read: PiConfigSourceRead | undefined;
  readonly disappeared: boolean;
}

function absentEntry(entry: PiConfigSourceEntry): PiConfigSourceEntry {
  return {
    kind: entry.kind,
    path: entry.path,
    presence: "absent",
    size: undefined,
    mtimeMs: undefined,
    sha256: undefined,
  };
}

function refreshOne(
  probe: PiConfigSourceProbe,
  fs: PiConfigSourceFsPort,
  onHashComputation: (() => void) | undefined,
): ResultAsync<PiConfigSourceRefreshedSource, PiConfigSourceFailure> {
  const { entry, status, stat } = probe;

  if (status === "unchanged" || status === "absent-unchanged") {
    return okAsync({ entry, read: undefined, disappeared: false });
  }

  if (status === "disappeared") {
    if (entry.kind === "prompt-file") {
      // Composition would fail on the next materialization, so the refresh
      // fails and the last valid catalog keeps serving.
      return errAsync<PiConfigSourceRefreshedSource, PiConfigSourceFailure>({
        type: "PromptSourceDisappeared",
        kind: "prompt-file",
        path: entry.path,
      });
    }
    return okAsync({
      entry: absentEntry(entry),
      read: undefined,
      disappeared: true,
    });
  }

  // `maybe-changed` and `appeared`: the only paths that read bytes.
  return fs
    .readFile(entry.path)
    .mapErr(
      (error): PiConfigSourceFailure => ({
        type: "SourceReadFailed",
        kind: entry.kind,
        path: entry.path,
        message: error.message,
      }),
    )
    .map((content): PiConfigSourceRefreshedSource => {
      onHashComputation?.();
      const sha256 = hashConfigSourceContent(content);
      const contentChanged = sha256 !== entry.sha256;
      return {
        entry: {
          kind: entry.kind,
          path: entry.path,
          presence: "present",
          // A read always follows a successful stat, so `stat` is defined here;
          // fall back to the hashed length rather than inventing metadata.
          size: stat?.size ?? content.length,
          mtimeMs: stat?.mtimeMs ?? Number.NaN,
          sha256,
        },
        read: {
          kind: entry.kind,
          path: entry.path,
          content,
          sha256,
          contentChanged,
        },
        disappeared: false,
      };
    });
}

/**
 * Folds probes and reads into the overall classification.
 *
 * Pure and total: every way a refresh can fail has already been reported on the
 * `err` channel before this runs.
 */
export function classifyConfigSourceChange(
  refreshed: readonly PiConfigSourceRefreshedSource[],
): PiConfigSourceChange {
  const configPaths: string[] = [];
  const promptPaths: string[] = [];

  for (const source of refreshed) {
    const changed = source.disappeared || source.read?.contentChanged === true;
    if (!changed) continue;
    if (source.entry.kind === "prompt-file")
      promptPaths.push(source.entry.path);
    else configPaths.push(source.entry.path);
  }

  if (configPaths.length > 0) {
    // A config change can add, drop, or repoint prompt references, so the
    // caller must rediscover prompt files — prompt digests alone say nothing.
    return {
      kind: "config-changed",
      changedPaths: [...configPaths, ...promptPaths].sort(),
    };
  }
  if (promptPaths.length > 0) {
    return { kind: "prompt-only", changedPaths: promptPaths.sort() };
  }
  return { kind: "unchanged" };
}

/**
 * Reads and hashes only the sources a probe could not rule out.
 *
 * A source whose metadata moved but whose bytes hash to the cached digest is
 * *not* a change: its entry is updated with the fresh metadata (so the next
 * probe is cheap again) and it contributes nothing to the classification.
 * `onHashComputation` observes operation counts only; SHA-256 remains fixed.
 */
export function refreshChangedSources(
  manifest: PiConfigSourceManifest,
  probes: readonly PiConfigSourceProbe[],
  fs: PiConfigSourceFsPort,
  onHashComputation?: () => void,
): ResultAsync<PiConfigSourceRefresh, PiConfigSourceFailure> {
  return ResultAsync.combine(
    probes.map((probe) => refreshOne(probe, fs, onHashComputation)),
  ).map((refreshed): PiConfigSourceRefresh => {
    const reads = refreshed
      .map((source) => source.read)
      .filter((read): read is PiConfigSourceRead => read !== undefined);

    return {
      manifest: {
        identity: manifest.identity,
        builtin: manifest.builtin,
        files: refreshed.map((source) => source.entry),
      },
      reads,
      change: classifyConfigSourceChange(refreshed),
    };
  });
}

/**
 * Probe, refresh, and classify in one call — the delegation-boundary entry
 * point.
 *
 * When nothing changed this performs one stat per known file and zero reads.
 */
export function refreshConfigSourceManifest(
  manifest: PiConfigSourceManifest,
  fs: PiConfigSourceFsPort,
  onHashComputation?: () => void,
): ResultAsync<PiConfigSourceRefresh, PiConfigSourceFailure> {
  return probeConfigSources(manifest, fs).andThen((probes) =>
    refreshChangedSources(manifest, probes, fs, onHashComputation),
  );
}
