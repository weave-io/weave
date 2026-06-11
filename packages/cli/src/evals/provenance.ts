/**
 * Prompt provenance record derivation for `weave eval`.
 *
 * Converts `PromptSnapshot` records (produced by `prompt-snapshots.ts`) into
 * `PromptProvenanceRecord` and `PromptProvenanceManifest` values that are
 * safe to publish. The key properties of this module:
 *
 *   - **Hash-first**: every record leads with the SHA-256 digest of the
 *     composed prompt so hash changes are immediately visible in diffs.
 *   - **Summary-first**: every record includes a sanitized human-readable
 *     summary of provenance that exposes no raw prompt text.
 *   - **No raw content**: raw prompt material is explicitly excluded from all
 *     records produced here. The `RawPromptArtifact` type lives in
 *     `prompt-snapshots.ts` and is only emitted via an explicit local-only path.
 *   - **Git SHA**: the git commit SHA is injected via a provider interface so
 *     tests never need to shell out to git.
 *
 * Design notes:
 *   - `GitShaProvider` is a thin synchronous interface so test doubles require
 *     no async plumbing.
 *   - The `deriveSummary()` helper is exported so tests can assert its output
 *     independently of the full record derivation pipeline.
 *   - `deriveProvenanceRecord()` is pure and synchronous — no I/O.
 *   - `buildManifest()` collects records into a manifest and is also pure.
 *   - `writeManifest()` performs the only I/O in this module (Bun.write).
 *   - All failures use `neverthrow` `Result`/`ResultAsync` — no exceptions.
 */

import { resolve } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type {
  PromptProvenanceManifest,
  PromptProvenanceRecord,
  PromptSnapshot,
  PromptSourceDescriptor,
  ProvenanceError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Git SHA provider interface
// ---------------------------------------------------------------------------

/**
 * A minimal interface for resolving the current git commit SHA.
 *
 * Injected as a dependency so callers can provide a mock in tests (avoiding
 * any git subprocess calls in the test environment).
 *
 * The default production implementation (`bunGitShaProvider`) shells out to
 * `git rev-parse HEAD` using `Bun.spawnSync`. Tests should always inject a
 * mock that returns a known value immediately.
 */
export interface GitShaProvider {
  /**
   * Resolve the current git commit SHA.
   *
   * @returns `ok(sha)` with a 40-character lowercase hex SHA, or
   *          `ok("unknown")` when the SHA cannot be determined (e.g. in a
   *          detached HEAD state or outside a git repo).
   *          Returns `err(ProvenanceError)` only for unrecoverable failures.
   */
  resolveGitSha(): Result<string, ProvenanceError>;
}

// ---------------------------------------------------------------------------
// Default production git SHA provider
// ---------------------------------------------------------------------------

/**
 * Production `GitShaProvider` that resolves the SHA by running
 * `git rev-parse HEAD` via `Bun.spawnSync`.
 *
 * Falls back to `"unknown"` when the command fails (not in a git repo, no
 * commits, etc.) rather than propagating an error.
 */
export const bunGitShaProvider: GitShaProvider = {
  resolveGitSha(): Result<string, ProvenanceError> {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      return ok("unknown");
    }
    const sha = new TextDecoder().decode(proc.stdout).trim();
    if (sha.length === 0) {
      return ok("unknown");
    }
    return ok(sha);
  },
};

// ---------------------------------------------------------------------------
// Sanitized summary derivation
// ---------------------------------------------------------------------------

/**
 * Derive a sanitized human-readable summary of prompt provenance.
 *
 * The summary describes the agent, its source kinds, and prompt dimensions
 * without exposing any raw prompt content. It is safe to commit, log, and
 * publish.
 *
 * Format example:
 * ```
 * Agent "loom": 2 source(s) [builtin primary, builtin append],
 * hash sha256:abc123…, 4821 chars, 4821 bytes
 * ```
 *
 * @param snapshot - The `PromptSnapshot` to summarize.
 * @returns A sanitized summary string.
 */
export function deriveSummary(snapshot: PromptSnapshot): string {
  const sourceList = snapshot.sources
    .map((s: PromptSourceDescriptor) => `${s.kind} ${s.layer}`)
    .join(", ");

  const sourceCount = snapshot.sources.length;
  const hashPrefix = snapshot.hash.slice(0, 12);

  return (
    `Agent "${snapshot.agentName}": ${sourceCount} source(s) [${sourceList}], ` +
    `hash sha256:${hashPrefix}…, ` +
    `${snapshot.charLength} chars, ${snapshot.byteLength} bytes`
  );
}

// ---------------------------------------------------------------------------
// Provenance record derivation (pure, synchronous)
// ---------------------------------------------------------------------------

/**
 * Derive a `PromptProvenanceRecord` from a `PromptSnapshot` and a git SHA.
 *
 * This function is pure and synchronous — it performs no I/O. All inputs are
 * provided by the caller.
 *
 * @param snapshot - The composed prompt snapshot.
 * @param gitSha - The git commit SHA (40-char hex or `"unknown"`).
 * @param capturedAt - ISO 8601 timestamp string (defaults to `new Date().toISOString()`).
 * @returns A fully populated `PromptProvenanceRecord`.
 */
export function deriveProvenanceRecord(
  snapshot: PromptSnapshot,
  gitSha: string,
  capturedAt: string = new Date().toISOString(),
): PromptProvenanceRecord {
  return {
    agentName: snapshot.agentName,
    hash: snapshot.hash,
    byteLength: snapshot.byteLength,
    charLength: snapshot.charLength,
    sources: snapshot.sources,
    summary: deriveSummary(snapshot),
    gitSha,
    capturedAt,
  };
}

// ---------------------------------------------------------------------------
// Manifest building (pure, synchronous)
// ---------------------------------------------------------------------------

/**
 * Build a `PromptProvenanceManifest` from an ordered list of provenance records.
 *
 * The manifest is a publishable document grouping all records from one eval
 * run. It contains no raw prompt text.
 *
 * @param records - Ordered list of provenance records (one per agent).
 * @param gitSha - Git SHA shared across all records in this manifest.
 * @param producedAt - ISO 8601 timestamp (defaults to `new Date().toISOString()`).
 * @returns A `PromptProvenanceManifest` at schema version 1.
 */
export function buildManifest(
  records: PromptProvenanceRecord[],
  gitSha: string,
  producedAt: string = new Date().toISOString(),
): PromptProvenanceManifest {
  return {
    version: 1,
    producedAt,
    gitSha,
    records,
  };
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

/**
 * Write a `PromptProvenanceManifest` to disk as indented JSON.
 *
 * Uses `Bun.write` for all file I/O. Returns `err(ProvenanceError)` when
 * the write fails.
 *
 * @param manifest - The manifest to serialize and write.
 * @param outputPath - Absolute or relative path of the target JSON file.
 * @returns `ResultAsync<void, ProvenanceError>`.
 */
export function writeManifest(
  manifest: PromptProvenanceManifest,
  outputPath: string,
): ResultAsync<void, ProvenanceError> {
  const json = JSON.stringify(manifest, null, 2);
  return ResultAsync.fromPromise(
    Bun.write(outputPath, json).then(() => undefined),
    (cause): ProvenanceError => ({
      type: "ManifestWriteError",
      path: outputPath,
      message: `Failed to write provenance manifest to "${outputPath}": ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Full pipeline: snapshots → records → manifest
// ---------------------------------------------------------------------------

/**
 * Options for `deriveProvenanceManifest`.
 */
export interface DeriveProvenanceManifestOptions {
  /**
   * Provider for the current git SHA. Defaults to `bunGitShaProvider`.
   * Inject a mock in tests to avoid shelling out to git.
   */
  gitShaProvider?: GitShaProvider;
  /**
   * Optional override for the `capturedAt` / `producedAt` timestamps.
   * Defaults to the current UTC time. Inject in tests for deterministic output.
   */
  capturedAt?: string;
}

/**
 * Derive a `PromptProvenanceManifest` from a list of `PromptSnapshot` records.
 *
 * Combines:
 * 1. Git SHA resolution (via injected `GitShaProvider`)
 * 2. Per-snapshot `PromptProvenanceRecord` derivation
 * 3. Manifest assembly
 *
 * Returns `err(ProvenanceError)` only when git SHA resolution fails with a
 * hard error. Individual snapshot derivation is infallible (pure).
 *
 * @param snapshots - Ordered list of snapshots (one per agent).
 * @param options - Optional provider overrides and timestamp injection.
 * @returns `Result<PromptProvenanceManifest, ProvenanceError>`.
 */
export function deriveProvenanceManifest(
  snapshots: PromptSnapshot[],
  options: DeriveProvenanceManifestOptions = {},
): Result<PromptProvenanceManifest, ProvenanceError> {
  const provider = options.gitShaProvider ?? bunGitShaProvider;
  const capturedAt = options.capturedAt ?? new Date().toISOString();

  const gitShaResult = provider.resolveGitSha();
  if (gitShaResult.isErr()) {
    return err(gitShaResult.error);
  }

  const gitSha = gitShaResult.value;

  const records = snapshots.map((snapshot) =>
    deriveProvenanceRecord(snapshot, gitSha, capturedAt),
  );

  const manifest = buildManifest(records, gitSha, capturedAt);

  return ok(manifest);
}

// ---------------------------------------------------------------------------
// Convenience: derive + write in one call
// ---------------------------------------------------------------------------

/**
 * Options for `deriveAndWriteManifest`.
 */
export interface DeriveAndWriteManifestOptions
  extends DeriveProvenanceManifestOptions {
  /**
   * The path to write the manifest JSON file.
   * Relative paths are resolved from the current working directory.
   */
  outputPath: string;
}

/**
 * Derive a `PromptProvenanceManifest` from snapshots and write it to disk.
 *
 * Combines `deriveProvenanceManifest` and `writeManifest` in a single call.
 * Returns the manifest on success so callers can inspect it without re-reading
 * the file.
 *
 * @param snapshots - Ordered list of prompt snapshots.
 * @param options - Provider overrides, timestamp injection, and output path.
 * @returns `ResultAsync<PromptProvenanceManifest, ProvenanceError>`.
 */
export function deriveAndWriteManifest(
  snapshots: PromptSnapshot[],
  options: DeriveAndWriteManifestOptions,
): ResultAsync<PromptProvenanceManifest, ProvenanceError> {
  const manifestResult = deriveProvenanceManifest(snapshots, options);
  if (manifestResult.isErr()) {
    const captured = manifestResult.error;
    return new ResultAsync(Promise.resolve(err(captured)));
  }

  const manifest = manifestResult.value;
  const resolvedPath = resolve(options.outputPath);

  return writeManifest(manifest, resolvedPath).map(() => manifest);
}
