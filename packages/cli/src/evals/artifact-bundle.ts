/**
 * Immutable run artifact bundle writer.
 *
 * Assembles publishable eval artifacts into an immutable, versioned directory
 * layout suitable for committing to an external results repository. Every
 * artifact written by this module passes through the central allowlist
 * sanitizer before being serialized to JSON. Publish mode is token-gated.
 *
 * # Bundle layout
 *
 * Each bundle is written to:
 *
 *   `<bundleRoot>/runs/<runId>/`
 *   ├── bundle-index.json          Top-level bundle manifest
 *   ├── run-summary.json           Aggregate pass/fail/counts
 *   ├── score-<suite>.json         Per-suite sanitized score records (all models aggregated)
 *   ├── prompt-hashes.json         Stable prompt hash records (no raw text)
 *   ├── provenance-manifest.json   Full sanitized provenance manifest (optional)
 *   ├── public-report.json         Public dashboard report (PublicReportBundle schema)
 *   └── public-report.md           Human-readable Markdown report (optional)
 *
 * # Immutable run IDs
 *
 * The run ID has the form `<gitSha[0..7]>-<YYYY-MM-DD>-<NNN>` where `NNN`
 * is a zero-padded three-digit sequence number (001, 002, …) auto-incremented
 * by scanning the existing `runs/` subdirectory at write time.
 *
 * This guarantees that repeat runs on the same commit and same calendar date
 * each receive a unique, immutable directory — no prior run's artifacts are
 * ever overwritten. The `runs/` parent directory organizes all run subdirs.
 *
 * Example:
 *   - First run:  `runs/abc123d-2026-01-15-001/`
 *   - Second run: `runs/abc123d-2026-01-15-002/`
 *   - Next day:   `runs/abc123d-2026-01-16-001/`
 *
 * When `gitSha === "unknown"`, the prefix is `unknown`.
 *
 * # Score file aggregation (multi-model runs)
 *
 * When multiple `RunnerResult`s share the same `suite` name (one per model in
 * a multi-model matrix run), they are **merged into a single score file** per
 * suite. The file name is always `score-<suite>.json` and contains all case
 * result rows from every model that ran against that suite.
 *
 * This ensures that a full 5-model × 2-suite run (10 runner results) produces
 * exactly 2 score files — `score-loom-routing.json` and
 * `score-tapestry-execution.json` — each with all model rows, instead of
 * overwriting on each model pass.
 *
 * # Sanitization contract
 *
 * - All fields are projected through the allowlist sanitizer before write.
 * - `assertPublishSafe()` is called on every top-level object before writing.
 * - `assertJsonPublishSafe()` is called on every serialized JSON string.
 * - Any violation causes the entire bundle write to fail with `BundleError`.
 *
 * # Publish mode
 *
 * Write modes:
 *   - `"local"` — writes to a local directory only; no external push.
 *   - `"publish"` — requires `EVAL_RESULTS_REPO_TOKEN`; writes to local
 *     first, then delegates to `ResultsRepoPublisher` for external push.
 *
 * In `"publish"` mode, the writer verifies the token is present and non-empty
 * before writing any artifacts. Token-missing is a hard failure.
 *
 * Dry-run bundles are always written as local-only even when mode is
 * `"publish"`, because dry-run results contain no real model output.
 *
 * # Remote-aware sequence allocation (publish mode)
 *
 * In `"publish"` mode, `writeBundle()` uses a `RemoteSequenceReader` to look
 * up the highest existing run-ID sequence for the current prefix in the remote
 * results repository before allocating the next local sequence number.  This
 * prevents collisions when a CI rerun produces the same `<sha7>-<date>` prefix
 * that was already published (e.g. re-running the same commit on the same day).
 *
 * The reader fetches `indexes/v1/dashboard-manifest.json` from the remote repo,
 * extracts run IDs that share the current prefix, and returns them alongside
 * the local scan results.  `resolveNextSequence()` then picks `max(local, remote) + 1`.
 *
 * Any failure in the remote read (404, network error, malformed JSON) is
 * treated as "no remote runs found" — the allocation falls back to local-only
 * safely.
 */

import { basename, join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { DashboardIndexWriter } from "./dashboard-indexes.js";
import { assemblePublicReportBundle } from "./report-bundle.js";
import { renderPublicReportBundle } from "./report-markdown.js";
import type { ResultsRepoPublisher } from "./results-repo.js";
import {
  assertJsonPublishSafe,
  assertPublishSafe,
  sanitizeCaseResultSummary,
  sanitizeProvenanceManifest,
} from "./sanitizer.js";
import type {
  BundleError,
  BundlePromptHashRecord,
  BundleProvenanceRef,
  BundleScoreFile,
  EvalBundle,
  PromptProvenanceManifest,
  PromptProvenanceRecord,
  RunnerResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Remote sequence reader interface
// ---------------------------------------------------------------------------

/**
 * Reads run IDs that already exist in the remote results repository for a
 * given prefix, so that `resolveNextSequence()` can allocate a collision-free
 * sequence number even when the same commit+date combination was published
 * previously.
 *
 * Implementations must be fail-safe: any error (network, 404, parse failure,
 * invalid JSON) MUST return `ok([])` rather than propagating an error, so that
 * the allocation can always fall back to local-only.
 *
 * @example
 * ```ts
 * const reader: RemoteSequenceReader = {
 *   readRemoteRunIds: (prefix, token) =>
 *     publisher.readRemoteRunIds(prefix, token),
 * };
 * ```
 */
export interface RemoteSequenceReader {
  /**
   * Return all run IDs in the remote repository that start with `prefix`.
   *
   * Implementations MUST return `ok([])` rather than `err(…)` on any
   * failure — the caller treats absence as "no remote runs".
   *
   * @param prefix - The run ID prefix to match (e.g. `abc123d-2026-01-15`).
   * @param token  - The publish token (passed as Authorization header).
   * @returns `ok(runIds)` on success or `ok([])` on any failure.
   */
  readRemoteRunIds(prefix: string, token: string): ResultAsync<string[], never>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The environment variable name for the external repo publish token.
 * Required when `mode === "publish"`.
 */
export const EVAL_RESULTS_REPO_TOKEN_ENV_VAR = "EVAL_RESULTS_REPO_TOKEN";

/**
 * Bundle schema version. Increment when the bundle layout changes in a
 * backward-incompatible way.
 */
export const BUNDLE_SCHEMA_VERSION = 1;

/**
 * The subdirectory under `bundleRoot` where all immutable run directories live.
 *
 * All run artifacts are written under `<bundleRoot>/runs/<runId>/`.
 * This keeps run artifacts separate from any top-level index files that
 * future publishers may add.
 */
export const RUNS_SUBDIR = "runs";

// ---------------------------------------------------------------------------
// Bundle write options
// ---------------------------------------------------------------------------

/**
 * Write mode for the bundle writer.
 *
 * - `"local"` — write to a local directory; no external push.
 * - `"publish"` — requires `EVAL_RESULTS_REPO_TOKEN`; writes locally then
 *   delegates external publication to the `ResultsRepoPublisher`.
 */
export type BundleWriteMode = "local" | "publish";

/**
 * Options for `ArtifactBundleWriter.writeBundle()`.
 */
export interface WriteBundleOptions {
  /**
   * Runner results to include in the bundle. One or more suite results.
   */
  runnerResults: RunnerResult[];
  /**
   * Prompt provenance manifest (produced by `deriveProvenanceManifest()`).
   * When `null`, the provenance section is omitted from the bundle.
   */
  provenanceManifest: PromptProvenanceManifest | null;
  /**
   * Git SHA to embed in the bundle. Typically the current HEAD SHA.
   * Use `"unknown"` when the SHA cannot be determined.
   */
  gitSha: string;
  /**
   * ISO 8601 timestamp for the bundle assembly time.
   * When omitted, defaults to `new Date().toISOString()`.
   * Inject for deterministic test output.
   */
  assembledAt?: string;
  /**
   * Write mode. Defaults to `"local"`.
   *
   * Set to `"publish"` to require and use `EVAL_RESULTS_REPO_TOKEN`.
   * Dry-run bundles are always local regardless of this setting.
   */
  mode?: BundleWriteMode;
  /**
   * Whether the run was a dry-run (no model calls).
   * Dry-run bundles are always written as local-only.
   */
  dryRun?: boolean;
  /**
   * Environment override for token lookup.
   * Defaults to `Bun.env`. Inject a mock in tests.
   */
  env?: Record<string, string | undefined>;
  /**
   * Optional publisher to call after local file write in `"publish"` mode.
   *
   * When `mode === "publish"` and this is provided, the publisher is called
   * with the written bundle after all local files are written. Publication
   * failures are returned as `BundleError` values — they do not prevent the
   * local write from being reported as successful.
   *
   * When omitted (the default), publish mode writes locally and skips
   * external publication. Inject `GitHubContentsPublisher` in production;
   * inject `StubResultsRepoPublisher` in tests.
   */
  publisher?: ResultsRepoPublisher;
  /**
   * Whether to write a human-readable `public-report.md` alongside
   * `public-report.json`. Defaults to `false`.
   *
   * When `true`, the Markdown report is rendered from `PublicReportBundle`
   * and written to `public-report.md` in the run directory.
   */
  writeMarkdown?: boolean;
  /**
   * Whether to regenerate dashboard index files after the immutable run
   * artifacts are assembled.
   *
   * When `true`, `DashboardIndexWriter.rebuildFromRuns()` is called after
   * all local run artifact files are written. Dashboard indexes are updated
   * only after the immutable run artifacts are fully assembled — never before.
   * Index generation failures are non-fatal (they do not prevent the local
   * bundle write from being reported as successful).
   *
   * Defaults to `false`.
   */
  generateIndexes?: boolean;
  /**
   * Optional remote sequence reader used in `"publish"` mode to discover
   * run IDs that already exist in the remote results repository.
   *
   * When provided and mode is `"publish"`, `writeBundle()` calls
   * `readRemoteRunIds(prefix, token)` before allocating the next local
   * sequence number so that reruns on the same commit+date combination
   * receive `-002`, `-003`, etc., instead of colliding with an already-
   * published `-001`.
   *
   * Any failure in the reader (network error, 404, malformed JSON) is
   * silently treated as "no remote runs" — the allocation falls back to
   * local-only safely.
   *
   * Inject `GitHubContentsPublisher` in production.  Inject a stub in tests.
   * When omitted, remote-aware sequencing is disabled.
   */
  remoteSequenceReader?: RemoteSequenceReader;
}

/**
 * The result of a successful bundle write.
 */
export interface BundleWriteResult {
  /** The bundle that was written. */
  bundle: EvalBundle;
  /** Absolute path of the run directory (`<bundleRoot>/runs/<runId>/`). */
  bundleDir: string;
  /** The immutable run ID (e.g. `abc123d-2026-01-15-001`). */
  runId: string;
  /** Paths of all files written. */
  filesWritten: string[];
  /**
   * Names of dashboard index files written (relative names, not absolute paths).
   * Empty when `generateIndexes` is `false` or when index generation produced
   * no runs (e.g. no readable `public-report.json` found).
   * Index generation failures are silently omitted here — the bundle write
   * result is still `ok` even when index generation fails.
   */
  indexFilesWritten: string[];
}

// ---------------------------------------------------------------------------
// Deterministic run ID computation
// ---------------------------------------------------------------------------

/**
 * Compute the base run ID prefix (without sequence number).
 *
 * Format: `<gitSha[0..7]>-<YYYY-MM-DD>` (e.g. `abc123d-2026-01-15`).
 *
 * When `gitSha === "unknown"`, uses `unknown` as the prefix.
 *
 * @param gitSha - The git SHA (40-char hex or `"unknown"`).
 * @param assembledAt - ISO 8601 timestamp used for the date component.
 * @returns Run ID prefix (without sequence number).
 */
export function computeRunIdPrefix(
  gitSha: string,
  assembledAt: string,
): string {
  const shortSha = gitSha === "unknown" ? "unknown" : gitSha.slice(0, 7);
  const date = assembledAt.slice(0, 10); // YYYY-MM-DD from ISO 8601
  return `${shortSha}-${date}`;
}

/**
 * Compute a complete immutable run ID with a sequence number.
 *
 * Format: `<gitSha[0..7]>-<YYYY-MM-DD>-<NNN>` where NNN is zero-padded
 * to three digits (e.g. `abc123d-2026-01-15-001`).
 *
 * @param prefix - The run ID prefix from `computeRunIdPrefix()`.
 * @param sequence - The one-based sequence number (1, 2, 3, …).
 * @returns The full immutable run ID.
 */
export function computeRunId(prefix: string, sequence: number): string {
  const seq = String(sequence).padStart(3, "0");
  return `${prefix}-${seq}`;
}

/**
 * @deprecated Use `computeRunIdPrefix()` instead.
 *
 * Retained for test compatibility. Returns the same format as the old
 * `<sha7>-<YYYY-MM-DD>` bundle dir name (the prefix without sequence).
 */
export function computeBundleDirName(
  gitSha: string,
  assembledAt: string,
): string {
  return computeRunIdPrefix(gitSha, assembledAt);
}

/**
 * Resolve the next available sequence number for a run ID prefix.
 *
 * Scans the `runs/` directory under `runsDir` for existing subdirectories
 * that match the pattern `<prefix>-<NNN>`. The next sequence number is one
 * greater than the highest existing number (or 1 when none exist).
 *
 * When `remoteRunIds` is supplied (publish mode), the function also scans
 * those IDs for matching entries so that the allocated sequence is higher
 * than both the local and remote maximums.  This prevents collisions when
 * the same commit+date prefix was already published to the remote repo.
 *
 * This is a best-effort scan — race conditions in concurrent processes are
 * not guarded against (eval runs are designed to be sequential).
 *
 * @param runsDir      - The absolute path to the `runs/` parent directory.
 * @param prefix       - The run ID prefix (e.g. `abc123d-2026-01-15`).
 * @param remoteRunIds - Optional list of run IDs already present in the
 *                       remote repository for the same prefix.  Pass an
 *                       empty array or omit for local-only allocation.
 * @returns The next sequence number (1-based).
 */
export async function resolveNextSequence(
  runsDir: string,
  prefix: string,
  remoteRunIds: string[] = [],
): Promise<number> {
  const scanner = new Bun.Glob(`${prefix}-[0-9][0-9][0-9]`);

  let maxSeq = 0;
  try {
    for await (const entry of scanner.scan({
      cwd: runsDir,
      onlyFiles: false,
    })) {
      // entry is just the dir name (no path prefix when scanning with cwd)
      const match = entry.match(/-(\d{3})$/);
      if (match === null) continue;
      const sequenceText = match[1];
      if (sequenceText === undefined) continue;
      const seq = parseInt(sequenceText, 10);
      if (seq > maxSeq) maxSeq = seq;
    }
  } catch {
    // runsDir does not exist yet — first run, start from 0 so we can still
    // factor in the remote maximum below before returning.
  }

  // Factor in remote run IDs for the same prefix.
  // We only look at IDs that exactly match `<prefix>-NNN` where NNN is
  // a three-digit decimal, to avoid false positives from other prefixes.
  const prefixPattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d{3})$`);
  for (const remoteId of remoteRunIds) {
    const match = remoteId.match(prefixPattern);
    if (match === null) continue;
    const sequenceText = match[1];
    if (sequenceText === undefined) continue;
    const seq = parseInt(sequenceText, 10);
    if (seq > maxSeq) maxSeq = seq;
  }

  return maxSeq + 1;
}

/**
 * Escape a string so it can be safely embedded in a `RegExp` pattern.
 * Escapes: `\ ^ $ . | ? * + ( ) [ ] { }`.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Score file assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a sanitized `BundleScoreFile` from a `RunnerResult`.
 *
 * All per-case summaries are projected through `sanitizeCaseResultSummary()`
 * before inclusion. The returned score file contains no raw content.
 *
 * @param runnerResult - The runner result to assemble into a score file.
 * @param gitSha - Git SHA at assembly time.
 * @param assembledAt - ISO 8601 assembly timestamp.
 * @param dryRun - Whether the run was a dry-run.
 * @returns A sanitized `BundleScoreFile`.
 */
export function assembleScoreFile(
  runnerResult: RunnerResult,
  gitSha: string,
  assembledAt: string,
  dryRun: boolean,
): BundleScoreFile {
  const results = runnerResult.caseResults.map((caseResult) =>
    sanitizeCaseResultSummary(caseResult.summary),
  );

  return {
    suite: runnerResult.suite,
    assembledAt,
    gitSha,
    dryRun,
    results,
    totals: {
      totalCases: runnerResult.totalCases,
      passedCases: runnerResult.passedCases,
      failedCases: runnerResult.failedCases,
      suiteGreen: runnerResult.suiteGreen,
    },
  };
}

/**
 * Aggregate multiple `RunnerResult`s that share the same `suite` name into a
 * single `BundleScoreFile`.
 *
 * This is the multi-model scenario: one `RunnerResult` per model per suite.
 * All result rows are merged into a single score file. Totals are recomputed
 * from the merged row set. `suiteGreen` is `true` iff every required,
 * non-dry-run row passed.
 *
 * When `results` contains exactly one entry, this is equivalent to calling
 * `assembleScoreFile()` directly.
 *
 * @param suiteName - The suite name shared by all runner results.
 * @param results - One or more runner results for the same suite.
 * @param gitSha - Git SHA at assembly time.
 * @param assembledAt - ISO 8601 assembly timestamp.
 * @param dryRun - Whether the run was a dry-run.
 * @returns A single merged `BundleScoreFile` with all model rows.
 */
export function aggregateScoreFile(
  suiteName: string,
  results: RunnerResult[],
  gitSha: string,
  assembledAt: string,
  dryRun: boolean,
): BundleScoreFile {
  // Merge all case results from all runner results for this suite
  const allRows = results.flatMap((rr) =>
    rr.caseResults.map((cr) => sanitizeCaseResultSummary(cr.summary)),
  );

  // Recompute aggregate totals from the merged set
  const totalCases = allRows.length;
  const passedCases = allRows.filter((r) => r.passed).length;
  const failedCases = totalCases - passedCases;

  // Suite is green iff all required, non-dry-run rows passed
  const suiteGreen = allRows
    .filter((r) => r.required && !r.dryRun)
    .every((r) => r.passed);

  return {
    suite: suiteName,
    assembledAt,
    gitSha,
    dryRun,
    results: allRows,
    totals: {
      totalCases,
      passedCases,
      failedCases,
      suiteGreen,
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt hash records assembly
// ---------------------------------------------------------------------------

/**
 * Assemble `BundlePromptHashRecord` entries from provenance records.
 *
 * Each record carries only the stable hash, byte/char length, and summary
 * (no raw prompt text). Source descriptors are also projected (file paths
 * are preserved for traceability; no prompt content is included).
 *
 * @param records - Provenance records from a manifest.
 * @returns Array of `BundlePromptHashRecord` values.
 */
export function assemblePromptHashRecords(
  records: PromptProvenanceRecord[],
): BundlePromptHashRecord[] {
  return records.map((record) => ({
    agentName: record.agentName,
    hash: record.hash,
    byteLength: record.byteLength,
    charLength: record.charLength,
    summary: record.summary,
  }));
}

// ---------------------------------------------------------------------------
// Bundle assembly
// ---------------------------------------------------------------------------

/**
 * Assemble an `EvalBundle` from runner results and provenance data.
 *
 * This is a pure function — no I/O. All artifact assembly and sanitization
 * happens here before the bundle is written to disk.
 *
 * Runner results with the same `suite` name are aggregated into a single
 * `BundleScoreFile` (multi-model scenario: one `RunnerResult` per model per
 * suite). This ensures `score-loom-routing.json` contains all model rows
 * rather than being overwritten by each successive model.
 *
 * @param options - Bundle assembly options.
 * @returns `Result<EvalBundle, BundleError>` — the assembled bundle or a
 *          sanitization failure.
 */
export function assembleBundle(options: {
  runnerResults: RunnerResult[];
  provenanceManifest: PromptProvenanceManifest | null;
  gitSha: string;
  assembledAt: string;
  dryRun: boolean;
}): Result<EvalBundle, BundleError> {
  const { runnerResults, provenanceManifest, gitSha, assembledAt, dryRun } =
    options;

  // Group runner results by suite name so multi-model runs (one RunnerResult
  // per model per suite) are merged into one score file per suite.
  const bySuite = new Map<string, RunnerResult[]>();
  for (const rr of runnerResults) {
    const existing = bySuite.get(rr.suite) ?? [];
    existing.push(rr);
    bySuite.set(rr.suite, existing);
  }

  // Assemble one aggregated score file per suite (preserves insertion order)
  const scoreFiles: BundleScoreFile[] = [];
  for (const [suiteName, suiteResults] of bySuite) {
    scoreFiles.push(
      aggregateScoreFile(suiteName, suiteResults, gitSha, assembledAt, dryRun),
    );
  }

  // Assemble prompt hash records from provenance manifest
  const promptHashRecords: BundlePromptHashRecord[] =
    provenanceManifest !== null
      ? assemblePromptHashRecords(provenanceManifest.records)
      : [];

  // Assemble provenance ref (points to provenance-manifest.json in bundle dir)
  const provenanceRef: BundleProvenanceRef | null =
    provenanceManifest !== null
      ? {
          manifestPath: "provenance-manifest.json",
          gitSha: provenanceManifest.gitSha,
          capturedAt: provenanceManifest.producedAt,
          agentCount: provenanceManifest.records.length,
        }
      : null;

  // Aggregate totals across all suites (use original runner results for
  // accurate per-model counts before aggregation)
  const totalCases = runnerResults.reduce((s, rr) => s + rr.totalCases, 0);
  const passedCases = runnerResults.reduce((s, rr) => s + rr.passedCases, 0);
  const failedCases = runnerResults.reduce((s, rr) => s + rr.failedCases, 0);
  const allSuitesGreen = runnerResults.every((rr) => rr.suiteGreen);

  const bundle: EvalBundle = {
    version: BUNDLE_SCHEMA_VERSION,
    assembledAt,
    gitSha,
    dryRun,
    runSummary: {
      totalCases,
      passedCases,
      failedCases,
      allSuitesGreen,
      suites: [...bySuite.keys()],
    },
    scoreFiles,
    promptHashRecords,
    provenanceRef,
  };

  // Validate the assembled bundle passes publish-safety checks
  const bundleCheck = assertPublishSafe(
    bundle as unknown as Record<string, unknown>,
    "EvalBundle",
  );
  if (bundleCheck.isErr()) {
    return err({
      type: "BundleSanitizationError",
      message: bundleCheck.error.message,
      field: "field" in bundleCheck.error ? bundleCheck.error.field : undefined,
    });
  }

  return ok(bundle);
}

// ---------------------------------------------------------------------------
// ArtifactBundleWriter
// ---------------------------------------------------------------------------

/**
 * Writes immutable eval result bundles to a versioned `runs/` directory layout.
 *
 * ## Immutable run directories
 *
 * Each call to `writeBundle()` produces a unique run directory under
 * `<bundleRoot>/runs/<runId>/`. The run ID has the form
 * `<sha7>-<YYYY-MM-DD>-<NNN>` where NNN is auto-incremented by scanning
 * existing sibling directories. This guarantees no prior run's artifacts
 * are ever overwritten, even when the same commit is evaluated twice on the
 * same calendar day.
 *
 * ## Public report
 *
 * In addition to the internal bundle files, `writeBundle()` always assembles
 * and writes `public-report.json` (a `PublicReportBundle` from `report-bundle.ts`).
 * When `writeMarkdown: true` is set, `public-report.md` is also written.
 *
 * When the `PublicReportBundle` assembly fails (e.g. empty score files),
 * the public report files are omitted rather than failing the whole bundle write.
 *
 * ## Sanitization
 *
 * All artifact serialization goes through the central sanitizer:
 *   - `assertPublishSafe()` is called on every assembled object.
 *   - `assertJsonPublishSafe()` is called on every serialized JSON string.
 *   - Any violation causes the write to fail with `BundleError`.
 *
 * ## Publish mode
 *
 * When `mode === "publish"`, the writer verifies `EVAL_RESULTS_REPO_TOKEN`
 * is present before writing any files. Dry-run bundles are always local-only.
 *
 * ## Usage
 *
 * ```ts
 * const writer = new ArtifactBundleWriter("/var/eval-bundles");
 * const result = await writer.writeBundle({
 *   runnerResults: [loomResult, tapestryResult],
 *   provenanceManifest,
 *   gitSha,
 *   mode: "publish",
 *   writeMarkdown: true,
 * });
 * // result.value.runId → "abc123d-2026-01-15-001"
 * // result.value.bundleDir → "/var/eval-bundles/runs/abc123d-2026-01-15-001"
 * ```
 */
export class ArtifactBundleWriter {
  constructor(
    /**
     * Root directory under which the `runs/` subdirectory is created.
     * Must be an absolute path.
     */
    private readonly bundleRoot: string,
  ) {}

  /**
   * Assemble and write an immutable eval result bundle.
   *
   * Steps:
   * 1. Resolve `assembledAt` and `mode` defaults.
   * 2. For `"publish"` mode: verify `EVAL_RESULTS_REPO_TOKEN` is set.
   * 3. Assemble the `EvalBundle` (pure; runs through sanitizer).
   * 4. Compute the run ID prefix and scan for the next sequence number.
   * 5. Create `<bundleRoot>/runs/<runId>/` as the immutable run directory.
   * 6. Write each artifact file, calling `assertJsonPublishSafe()` on every
   *    JSON string before writing.
   * 7. Assemble and write `public-report.json` (and optionally `public-report.md`).
   * 8. If `generateIndexes` is `true`, call `DashboardIndexWriter.rebuildFromRuns()`
   *    AFTER all immutable run artifacts are assembled. Index failures are non-fatal.
   * 9. If `mode === "publish"` and a `publisher` is provided, call it with the
   *    written bundle. Publication failures are surfaced as `BundleError`.
   * 10. Return the `BundleWriteResult` including `runId` and `indexFilesWritten`.
   *
   * @param options - Write options including runner results, provenance, and mode.
   * @returns `ResultAsync<BundleWriteResult, BundleError>`.
   */
  writeBundle(
    options: WriteBundleOptions,
  ): ResultAsync<BundleWriteResult, BundleError> {
    const assembledAt = options.assembledAt ?? new Date().toISOString();
    const mode = options.mode ?? "local";
    const dryRun = options.dryRun ?? false;
    const env = options.env ?? Bun.env;
    const writeMarkdown = options.writeMarkdown ?? false;
    const generateIndexes = options.generateIndexes ?? false;

    // Policy: dry-run bundles are always local-only
    const effectiveMode: BundleWriteMode = dryRun ? "local" : mode;

    // Token gate: publish mode requires EVAL_RESULTS_REPO_TOKEN
    if (effectiveMode === "publish") {
      const token = env[EVAL_RESULTS_REPO_TOKEN_ENV_VAR];
      if (token === undefined || token.trim() === "") {
        return new ResultAsync(
          Promise.resolve(
            err<BundleWriteResult, BundleError>({
              type: "PublishTokenMissing",
              envVar: EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
              message:
                `Publish mode requires ${EVAL_RESULTS_REPO_TOKEN_ENV_VAR} to be set. ` +
                `Set this environment variable to a valid repository token before publishing. ` +
                `For local-only writes, use mode: "local" or omit the mode option.`,
            }),
          ),
        );
      }
    }

    // Assemble the bundle (pure; runs through sanitizer internally)
    const bundleResult = assembleBundle({
      runnerResults: options.runnerResults,
      provenanceManifest: options.provenanceManifest,
      gitSha: options.gitSha,
      assembledAt,
      dryRun,
    });

    if (bundleResult.isErr()) {
      return new ResultAsync(Promise.resolve(err(bundleResult.error)));
    }

    const bundle = bundleResult.value;

    // Compute run ID: resolve prefix then scan for next sequence number.
    // In publish mode, also query the remote repo for existing run IDs so we
    // don't collide with a previously published run on the same commit+date.
    const runsDir = join(this.bundleRoot, RUNS_SUBDIR);
    const prefix = computeRunIdPrefix(options.gitSha, assembledAt);

    // Fetch remote run IDs when a reader is provided and mode is "publish".
    // Any failure in the remote read is swallowed — the result is always
    // ok([]) on failure, so the type is ResultAsync<string[], never>.
    const remoteRunIdsAsync: ResultAsync<string[], never> =
      effectiveMode === "publish" && options.remoteSequenceReader !== undefined
        ? (() => {
            const token = env[EVAL_RESULTS_REPO_TOKEN_ENV_VAR] ?? "";
            return options.remoteSequenceReader.readRemoteRunIds(
              prefix,
              token.trim(),
            );
          })()
        : ResultAsync.fromSafePromise(Promise.resolve([] as string[]));

    return remoteRunIdsAsync.andThen((remoteRunIds) =>
      ResultAsync.fromPromise(
        resolveNextSequence(runsDir, prefix, remoteRunIds),
        (cause): BundleError => ({
          type: "BundleWriteError",
          path: runsDir,
          message:
            `Failed to resolve next run sequence in "${runsDir}": ` +
            `${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      ).andThen((sequence) => {
        const runId = computeRunId(prefix, sequence);
        const bundleDir = join(runsDir, runId);

        // Write all bundle files locally first (immutable run artifacts)
        return this.writeBundleFiles(
          bundle,
          bundleDir,
          runId,
          options.provenanceManifest,
          writeMarkdown,
        ).andThen((writeResult) => {
          // Step 8: Regenerate dashboard indexes AFTER immutable run artifacts
          // are fully assembled. Non-fatal: index failures never block the
          // local bundle write from succeeding.
          //
          // We use a plain Promise (not ResultAsync) here so that the error
          // type stays `never` on the outer chain — index failures are absorbed
          // inside the promise and returned as an empty array.
          const indexPromise: Promise<string[]> = generateIndexes
            ? Promise.resolve(
                new DashboardIndexWriter(this.bundleRoot)
                  .rebuildFromRuns()
                  .then(
                    (r) => (r.isOk() ? r.value.filesWritten : []),
                    () => [] as string[],
                  ),
              ).then((v) => v)
            : Promise.resolve([] as string[]);

          return ResultAsync.fromSafePromise(indexPromise).andThen(
            (indexFilesWritten) => {
              const writeResultWithIndexes: BundleWriteResult = {
                ...writeResult,
                indexFilesWritten,
              };

              // If mode is not "publish" or no publisher provided, return immediately
              if (
                effectiveMode !== "publish" ||
                options.publisher === undefined
              ) {
                return ResultAsync.fromSafePromise(
                  Promise.resolve(writeResultWithIndexes),
                );
              }

              // Call the external publisher with the written bundle.
              // Token presence was already verified above (token gate).
              // Publication failures are surfaced as BundleError values.
              //
              // Pass `localBundleRoot` and `indexFileNames` so the publisher can
              // upload dashboard index files (at repo root level) after the
              // immutable run artifacts. Index filenames come from `indexFilesWritten`
              // which are relative basenames written by `DashboardIndexWriter`.
              return options.publisher
                .publish({
                  bundle,
                  localBundleDir: bundleDir,
                  // Derive relative file names using basename() for separator-agnostic
                  // normalization — works correctly on both POSIX (/) and Windows (\) paths.
                  fileNames: writeResult.filesWritten.map((fp) => basename(fp)),
                  // Provide bundle root and index file names so the publisher can
                  // upload generated indexes at the repository root level (after
                  // the immutable run artifacts). Only set when indexes were generated.
                  localBundleRoot:
                    indexFilesWritten.length > 0 ? this.bundleRoot : undefined,
                  indexFileNames:
                    indexFilesWritten.length > 0
                      ? indexFilesWritten
                      : undefined,
                  env,
                })
                .map((): BundleWriteResult => writeResultWithIndexes)
                .mapErr(
                  (repoErr): BundleError => ({
                    type: "BundleWriteError",
                    path: bundleDir,
                    message: `External publication to results repository failed: ${repoErr.message}`,
                  }),
                );
            },
          );
        });
      }),
    );
  }

  /**
   * Write all bundle artifact files to `bundleDir`.
   *
   * Each file is sanitized before writing via `assertJsonPublishSafe()`.
   * Also assembles and writes `public-report.json` (and optionally
   * `public-report.md`) from the assembled bundle.
   *
   * `bundle-index.json` is written LAST so that its `publicFiles` field can
   * accurately enumerate the allowlisted public files that were actually
   * written to the run directory. Only `bundle-index.json`,
   * `public-report.json`, and `public-report.md` are enumerated in
   * `publicFiles` — internal artifacts (`run-summary.json`, `score-*.json`,
   * `prompt-hashes.json`, `provenance-manifest.json`) are never listed.
   */
  private writeBundleFiles(
    bundle: EvalBundle,
    bundleDir: string,
    runId: string,
    provenanceManifest: PromptProvenanceManifest | null,
    writeMarkdown: boolean,
  ): ResultAsync<BundleWriteResult, BundleError> {
    const filesWritten: string[] = [];

    // Track which public files were actually written (for bundle-index.json publicFiles field)
    const publicFilesWritten: string[] = [];

    // Helper: serialize, safety-check, and write a single JSON file
    const writeJson = (
      obj: unknown,
      fileName: string,
      contextLabel: string,
    ): ResultAsync<string, BundleError> => {
      const json = JSON.stringify(obj, null, 2);

      // Belt-and-suspenders: verify the serialized JSON contains no sensitive fields
      const safetyCheck = assertJsonPublishSafe(json, contextLabel);
      if (safetyCheck.isErr()) {
        return new ResultAsync(
          Promise.resolve(
            err<string, BundleError>({
              type: "BundleSanitizationError",
              message: safetyCheck.error.message,
              field:
                "field" in safetyCheck.error
                  ? safetyCheck.error.field
                  : undefined,
            }),
          ),
        );
      }

      const filePath = join(bundleDir, fileName);
      return ResultAsync.fromPromise(
        Bun.write(filePath, json).then(() => filePath),
        (cause): BundleError => ({
          type: "BundleWriteError",
          path: filePath,
          message:
            `Failed to write bundle file "${filePath}": ` +
            `${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
    };

    // Helper: write a plain text file (no JSON safety check needed — Markdown)
    const writeText = (
      text: string,
      fileName: string,
    ): ResultAsync<string, BundleError> => {
      const filePath = join(bundleDir, fileName);
      return ResultAsync.fromPromise(
        Bun.write(filePath, text).then(() => filePath),
        (cause): BundleError => ({
          type: "BundleWriteError",
          path: filePath,
          message:
            `Failed to write bundle file "${filePath}": ` +
            `${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
    };

    // Write internal artifacts first (before bundle-index.json),
    // then write bundle-index.json last so publicFiles is accurate.

    const writeSequence = writeJson(
      bundle.runSummary,
      "run-summary.json",
      "run-summary",
    )
      .andThen((summaryPath) => {
        filesWritten.push(summaryPath);
        // Write score files for each suite
        return bundle.scoreFiles.reduce(
          (acc, scoreFile) =>
            acc.andThen(() => {
              const fileName = `score-${scoreFile.suite}.json`;
              return writeJson(
                scoreFile,
                fileName,
                `score-${scoreFile.suite}`,
              ).andThen((p) => {
                filesWritten.push(p);
                return ResultAsync.fromSafePromise<void, BundleError>(
                  Promise.resolve(),
                );
              });
            }),
          ResultAsync.fromSafePromise<void, BundleError>(Promise.resolve()),
        );
      })
      .andThen(() => {
        // Write prompt-hashes.json
        if (bundle.promptHashRecords.length === 0) {
          return ResultAsync.fromSafePromise<void, BundleError>(
            Promise.resolve(),
          );
        }
        return writeJson(
          { promptHashes: bundle.promptHashRecords },
          "prompt-hashes.json",
          "prompt-hashes",
        ).andThen((p) => {
          filesWritten.push(p);
          return ResultAsync.fromSafePromise<void, BundleError>(
            Promise.resolve(),
          );
        });
      })
      .andThen(() => {
        // Write provenance-manifest.json when available
        if (provenanceManifest === null) {
          return ResultAsync.fromSafePromise<void, BundleError>(
            Promise.resolve(),
          );
        }
        // Sanitize the manifest before writing
        const sanitized = sanitizeProvenanceManifest(provenanceManifest);
        return writeJson(
          sanitized,
          "provenance-manifest.json",
          "provenance-manifest",
        ).andThen((p) => {
          filesWritten.push(p);
          return ResultAsync.fromSafePromise<void, BundleError>(
            Promise.resolve(),
          );
        });
      })
      .andThen(() => {
        // Assemble and write public-report.json
        // Assembly failures are non-fatal: public-report.json is omitted when
        // the bundle has no score files (e.g. empty dry-run with no cases).
        const reportResult = assemblePublicReportBundle(bundle, runId);
        if (reportResult.isErr()) {
          // Non-fatal: log-level omission, not a hard error
          return ResultAsync.fromSafePromise<void, BundleError>(
            Promise.resolve(),
          );
        }
        const publicReport = reportResult.value;

        return writeJson(
          publicReport,
          "public-report.json",
          "public-report",
        ).andThen((reportPath) => {
          filesWritten.push(reportPath);
          // Track public-report.json as a public file
          publicFilesWritten.push("public-report.json");

          // Optionally write public-report.md
          if (!writeMarkdown) {
            return ResultAsync.fromSafePromise<void, BundleError>(
              Promise.resolve(),
            );
          }
          const markdown = renderPublicReportBundle(publicReport);
          return writeText(markdown, "public-report.md").andThen((mdPath) => {
            filesWritten.push(mdPath);
            // Track public-report.md as a public file
            publicFilesWritten.push("public-report.md");
            return ResultAsync.fromSafePromise<void, BundleError>(
              Promise.resolve(),
            );
          });
        });
      })
      .andThen(() => {
        // Write bundle-index.json LAST so publicFiles accurately enumerates
        // the allowlisted public run artifacts that were actually written.
        // bundle-index.json itself is always a public file (it is the manifest).
        //
        // NEVER list internal artifacts in publicFiles:
        //   - run-summary.json      (internal aggregate, not for public consumption)
        //   - score-*.json          (internal per-suite scores, not for public consumption)
        //   - prompt-hashes.json    (internal, not for public consumption)
        //   - provenance-manifest.json (internal, not for public consumption)
        //
        // Only publicFiles should be fetched by website loaders.
        const publicFiles: string[] = [
          "bundle-index.json",
          ...publicFilesWritten,
        ];

        const bundleIndex = {
          schemaVersion: BUNDLE_SCHEMA_VERSION,
          assembledAt: bundle.assembledAt,
          gitSha: bundle.gitSha,
          dryRun: bundle.dryRun,
          runId,
          runSummary: bundle.runSummary,
          // publicFiles: closed list of allowlisted public artifacts for this run.
          // Website loaders MUST only fetch files listed here — no directory walking.
          publicFiles,
        };

        return writeJson(
          bundleIndex,
          "bundle-index.json",
          "bundle-index",
        ).andThen((indexPath) => {
          filesWritten.push(indexPath);
          return ResultAsync.fromSafePromise<void, BundleError>(
            Promise.resolve(),
          );
        });
      })
      .map(
        (): BundleWriteResult => ({
          bundle,
          bundleDir,
          runId,
          filesWritten,
          indexFilesWritten: [],
        }),
      );

    return writeSequence;
  }
}

// ---------------------------------------------------------------------------
// Policy enforcement: dry-run bundle guard
// ---------------------------------------------------------------------------

/**
 * Verify that a bundle is eligible for external publication.
 *
 * Enforces publish policy:
 *   - Dry-run bundles MUST NOT be published externally.
 *   - A bundle must have at least one score file.
 *
 * @param bundle - The bundle to validate.
 * @returns `ok(undefined)` when eligible; `err(BundleError)` when not.
 */
export function assertBundlePublishEligible(
  bundle: EvalBundle,
): Result<undefined, BundleError> {
  if (bundle.dryRun) {
    return err({
      type: "PublishPolicyViolation",
      message:
        "Dry-run bundles must not be published to external repositories. " +
        "Only bundles produced by real model runs (dryRun: false) may be published.",
    });
  }

  if (bundle.scoreFiles.length === 0) {
    return err({
      type: "PublishPolicyViolation",
      message:
        "Bundle has no score files. A publishable bundle must contain at least one score file.",
    });
  }

  return ok(undefined);
}
