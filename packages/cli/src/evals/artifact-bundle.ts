/**
 * Deterministic eval result bundle writer.
 *
 * Assembles publishable eval artifacts into a deterministic directory layout
 * suitable for committing to an external results repository. Every artifact
 * written by this module passes through the central allowlist sanitizer before
 * being serialized to JSON. Publish mode is token-gated.
 *
 * # Bundle layout
 *
 * Each bundle is written to:
 *
 *   `<bundleRoot>/<gitSha>-<YYYY-MM-DD>/`
 *   ├── bundle-index.json          Top-level bundle manifest
 *   ├── run-summary.json           Aggregate pass/fail/counts
 *   ├── score-<suite>.json         Per-suite sanitized score records (all models aggregated)
 *   ├── prompt-hashes.json         Stable prompt hash records (no raw text)
 *   └── provenance-manifest.json   Full sanitized provenance manifest (optional)
 *
 * The directory name is deterministic: `<gitSha[0..7]>-<YYYY-MM-DD>`. The
 * same inputs always produce the same layout and file contents. This makes
 * bundle directories reproducible for content-addressable storage and diff.
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
 */

import { basename, join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
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
}

/**
 * The result of a successful bundle write.
 */
export interface BundleWriteResult {
  /** The bundle that was written. */
  bundle: EvalBundle;
  /** Absolute path of the bundle directory. */
  bundleDir: string;
  /** Paths of all files written. */
  filesWritten: string[];
}

// ---------------------------------------------------------------------------
// Deterministic bundle path computation
// ---------------------------------------------------------------------------

/**
 * Compute the deterministic bundle directory name.
 *
 * Format: `<gitSha[0..7]>-<YYYY-MM-DD>` (e.g. `abc1234-2026-01-15`).
 *
 * When `gitSha === "unknown"`, uses `unknown` as the prefix.
 *
 * @param gitSha - The git SHA (40-char hex or `"unknown"`).
 * @param assembledAt - ISO 8601 timestamp used for the date component.
 * @returns Deterministic directory name segment.
 */
export function computeBundleDirName(
  gitSha: string,
  assembledAt: string,
): string {
  const shortSha = gitSha === "unknown" ? "unknown" : gitSha.slice(0, 7);
  const date = assembledAt.slice(0, 10); // YYYY-MM-DD from ISO 8601
  return `${shortSha}-${date}`;
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
 * Writes sanitized eval result bundles to a deterministic directory layout.
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
 * ## Determinism
 *
 * Bundle directory names are derived from `gitSha[0..7]` and the date
 * component of `assembledAt`. The same inputs always produce the same path.
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
 * });
 * ```
 */
export class ArtifactBundleWriter {
  constructor(
    /**
     * Root directory under which bundle subdirectories are created.
     * Must be an absolute path.
     */
    private readonly bundleRoot: string,
  ) {}

  /**
   * Assemble and write a publishable eval result bundle.
   *
   * Steps:
   * 1. Resolve `assembledAt` and `mode` defaults.
   * 2. For `"publish"` mode: verify `EVAL_RESULTS_REPO_TOKEN` is set.
   * 3. Assemble the `EvalBundle` (pure; runs through sanitizer).
   * 4. Compute the deterministic bundle directory path.
   * 5. Write each artifact file, calling `assertJsonPublishSafe()` on every
   *    JSON string before writing.
   * 6. If `mode === "publish"` and a `publisher` is provided, call it with the
   *    written bundle. Publication failures are surfaced as `BundleError`.
   * 7. Return the `BundleWriteResult`.
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
    const dirName = computeBundleDirName(options.gitSha, assembledAt);
    const bundleDir = join(this.bundleRoot, dirName);

    // Write all bundle files locally first
    return this.writeBundleFiles(
      bundle,
      bundleDir,
      options.provenanceManifest,
    ).andThen((writeResult) => {
      // If mode is not "publish" or no publisher provided, return immediately
      if (effectiveMode !== "publish" || options.publisher === undefined) {
        return ResultAsync.fromSafePromise(Promise.resolve(writeResult));
      }

      // Call the external publisher with the written bundle.
      // Token presence was already verified above (token gate).
      // Publication failures are surfaced as BundleError values.
      return options.publisher
        .publish({
          bundle,
          localBundleDir: bundleDir,
          // Derive relative file names using basename() for separator-agnostic
          // normalization — works correctly on both POSIX (/) and Windows (\) paths.
          fileNames: writeResult.filesWritten.map((fp) => basename(fp)),
          env,
        })
        .map((): BundleWriteResult => writeResult)
        .mapErr(
          (repoErr): BundleError => ({
            type: "BundleWriteError",
            path: bundleDir,
            message: `External publication to results repository failed: ${repoErr.message}`,
          }),
        );
    });
  }

  /**
   * Write all bundle artifact files to `bundleDir`.
   *
   * Each file is sanitized before writing via `assertJsonPublishSafe()`.
   */
  private writeBundleFiles(
    bundle: EvalBundle,
    bundleDir: string,
    provenanceManifest: PromptProvenanceManifest | null,
  ): ResultAsync<BundleWriteResult, BundleError> {
    const filesWritten: string[] = [];

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

    // Write bundle-index.json (top-level manifest without large nested arrays)
    const bundleIndex = {
      version: bundle.version,
      assembledAt: bundle.assembledAt,
      gitSha: bundle.gitSha,
      dryRun: bundle.dryRun,
      runSummary: bundle.runSummary,
      provenanceRef: bundle.provenanceRef,
      scoreFiles: bundle.scoreFiles.map((sf) => sf.suite),
    };

    const writeSequence = writeJson(
      bundleIndex,
      "bundle-index.json",
      "bundle-index",
    )
      .andThen((indexPath) => {
        filesWritten.push(indexPath);
        return writeJson(bundle.runSummary, "run-summary.json", "run-summary");
      })
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
      .map(
        (): BundleWriteResult => ({
          bundle,
          bundleDir,
          filesWritten,
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
