/**
 * `weave eval reindex` — rebuild every dashboard index from the runs already
 * published in the results repository.
 *
 * Index files under `indexes/v1/` are derived: each is reproducible from the
 * immutable `runs/v1/<runId>/public-report.json` files. A publish regenerates
 * them from the runs on the publishing machine only, so when an index is
 * wrong (for example a trajectory publish that moved `latest.json`, before
 * the indexes were track-aware) the fix is to rebuild them from every
 * published run. This module does that:
 *
 *   1. List the run directories under `runs/v1/` (Contents API).
 *   2. Read each run's `public-report.json` and validate it with
 *      `validatePublicReportBundleCompatibility()`. A run the current schema
 *      cannot read is skipped and reported, never guessed at.
 *   3. Write the readable reports into a local work directory laid out like a
 *      bundle root (`runs/<runId>/public-report.json`) and rebuild the indexes
 *      there with `DashboardIndexWriter`, which keeps the text and trajectory
 *      tracks apart.
 *   4. Unless it is a dry run, upload the index files with
 *      `GitHubContentsPublisher.publishIndexes()`. Only allowlisted index
 *      files are uploaded; run artifacts are never written.
 *
 * The token is read from `EVAL_RESULTS_REPO_TOKEN` and handed to the results
 * repo client, which sends it only in the `Authorization` header.
 */

import { join } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import {
  EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
  RUNS_SUBDIR,
} from "./artifact-bundle.js";
import {
  DashboardIndexWriter,
  indexTrackOf,
  type RunDescriptor,
  validatePublicReportBundleCompatibility,
} from "./dashboard-indexes.js";
import type { PublishIndexesRequest } from "./github-contents-publisher.js";
import type { PublishBundleResult } from "./results-repo.js";
import type { ResultsRepoError } from "./types.js";

/** The results-repository operations a reindex needs. */
export interface ReindexRepository {
  listPublishedRunIds(token: string): ResultAsync<string[], ResultsRepoError>;
  readPublishedRunReport(
    runId: string,
    token: string,
  ): ResultAsync<string, ResultsRepoError>;
  publishIndexes(
    request: PublishIndexesRequest,
  ): ResultAsync<PublishBundleResult, ResultsRepoError>;
}

/** Why a published run was left out of the rebuilt indexes. */
export interface SkippedRun {
  runId: string;
  reason: string;
}

/** What a reindex found and did. */
export interface ReindexSummary {
  /** Every run directory found under `runs/v1/`, sorted. */
  runsFound: string[];
  /** The runs the indexes were rebuilt from, newest-first. */
  runsIndexed: string[];
  /** The runs that could not be read, with the reason. */
  runsSkipped: SkippedRun[];
  /** The run `latest.json` now points at (newest text run), if any. */
  latestRunId: string | null;
  /** The run `latest-trajectory.json` now points at, if any. */
  latestTrajectoryRunId: string | null;
  /** The index file names rebuilt, in upload order. */
  indexFiles: string[];
  /** Index files uploaded; 0 on a dry run. */
  filesPublished: number;
  /** Whether this was a dry run (nothing uploaded). */
  dryRun: boolean;
  /** The local directory the indexes were rebuilt in. */
  workDir: string;
}

/** Typed reindex failures. */
export type ReindexError =
  | { type: "TokenMissing"; envVar: string; message: string }
  | { type: "ReindexFailed"; message: string };

export interface ReindexOptions {
  /** Environment for the token lookup. */
  env: Record<string, string | undefined>;
  /** Rebuild locally and report, but upload nothing. */
  dryRun: boolean;
}

/**
 * Rebuilds the dashboard indexes of the results repository from its
 * published runs.
 */
export class ResultsRepoReindexer {
  constructor(
    private readonly repository: ReindexRepository,
    /** Empty local directory to rebuild in; it is left in place afterwards. */
    private readonly workDir: string,
    /** Fixed `updatedAt` for deterministic output in tests. */
    private readonly updatedAt?: string,
  ) {}

  reindex(options: ReindexOptions): ResultAsync<ReindexSummary, ReindexError> {
    const token = options.env[EVAL_RESULTS_REPO_TOKEN_ENV_VAR]?.trim() ?? "";
    if (token === "") {
      return new ResultAsync(
        Promise.resolve(
          err<ReindexSummary, ReindexError>({
            type: "TokenMissing",
            envVar: EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
            message: `weave eval reindex reads and writes the results repository, so ${EVAL_RESULTS_REPO_TOKEN_ENV_VAR} must be set.`,
          }),
        ),
      );
    }

    return this.repository
      .listPublishedRunIds(token)
      .mapErr(fromRepoError)
      .andThen((runsFound) =>
        ResultAsync.fromSafePromise(this.loadRuns(runsFound, token)).andThen(
          (loaded) => this.rebuild(runsFound, loaded, options),
        ),
      );
  }

  /** Reads and validates every listed run; unreadable runs are recorded. */
  private async loadRuns(
    runIds: string[],
    token: string,
  ): Promise<{ runs: RunDescriptor[]; skipped: SkippedRun[] }> {
    const runs: RunDescriptor[] = [];
    const skipped: SkippedRun[] = [];
    for (const runId of runIds) {
      const loaded = await this.repository
        .readPublishedRunReport(runId, token)
        .mapErr((e) => e.message)
        .andThen((text) => parseReport(text, runId));
      if (loaded.isErr()) {
        skipped.push({ runId, reason: loaded.error });
        continue;
      }
      runs.push({ runId, bundle: loaded.value });
    }
    runs.sort((a, b) =>
      b.bundle.assembledAt.localeCompare(a.bundle.assembledAt),
    );
    return { runs, skipped };
  }

  private rebuild(
    runsFound: string[],
    loaded: { runs: RunDescriptor[]; skipped: SkippedRun[] },
    options: ReindexOptions,
  ): ResultAsync<ReindexSummary, ReindexError> {
    const { runs, skipped } = loaded;
    if (runs.length === 0) {
      return new ResultAsync(
        Promise.resolve(
          err<ReindexSummary, ReindexError>({
            type: "ReindexFailed",
            message: `No published run could be read (${runsFound.length} found), so there is nothing to index.`,
          }),
        ),
      );
    }

    return this.writeLocalRuns(runs)
      .andThen(() =>
        new DashboardIndexWriter(this.workDir, this.updatedAt)
          .rebuildFromRuns()
          .mapErr(
            (e): ReindexError => ({
              type: "ReindexFailed",
              message: `Rebuilding the indexes failed: ${e.message}`,
            }),
          ),
      )
      .andThen(({ filesWritten }) => {
        const summary: ReindexSummary = {
          runsFound,
          runsIndexed: runs.map((r) => r.runId),
          runsSkipped: skipped,
          latestRunId: newestOf(runs, "main"),
          latestTrajectoryRunId: newestOf(runs, "trajectory"),
          indexFiles: filesWritten,
          filesPublished: 0,
          dryRun: options.dryRun,
          workDir: this.workDir,
        };
        if (options.dryRun) {
          return ResultAsync.fromSafePromise<ReindexSummary, ReindexError>(
            Promise.resolve(summary),
          );
        }
        return this.repository
          .publishIndexes({
            localBundleRoot: this.workDir,
            indexFileNames: filesWritten,
            env: options.env,
          })
          .mapErr(fromRepoError)
          .map((published) => ({
            ...summary,
            filesPublished: published.filesPublished,
          }));
      });
  }

  /** Writes each run's report where `DashboardIndexWriter` looks for it. */
  private writeLocalRuns(
    runs: RunDescriptor[],
  ): ResultAsync<void, ReindexError> {
    return ResultAsync.fromPromise(
      Promise.all(
        runs.map((run) =>
          Bun.write(
            join(this.workDir, RUNS_SUBDIR, run.runId, "public-report.json"),
            JSON.stringify(run.bundle, null, 2),
          ),
        ),
      ).then(() => undefined),
      (cause): ReindexError => ({
        type: "ReindexFailed",
        message: `Could not write the published runs to ${this.workDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    );
  }
}

/** Parses and validates one published report; the error is the reason. */
function parseReport(
  text: string,
  runId: string,
): Result<RunDescriptor["bundle"], string> {
  const parsed = Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    () => "public-report.json is not JSON",
  )();
  if (parsed.isErr()) return err(parsed.error);
  const validated = validatePublicReportBundleCompatibility(
    parsed.value,
    runId,
  );
  if (validated.isErr()) return err(validated.error.message);
  return ok(validated.value);
}

/** The newest run of one index track, or `null`. `runs` is newest-first. */
function newestOf(
  runs: RunDescriptor[],
  track: "main" | "trajectory",
): string | null {
  return runs.find((r) => indexTrackOf(r.bundle) === track)?.runId ?? null;
}

function fromRepoError(e: ResultsRepoError): ReindexError {
  if (e.type === "TokenMissing") return e;
  return { type: "ReindexFailed", message: e.message };
}
