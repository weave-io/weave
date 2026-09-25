/**
 * Evals scenarios — the text and trajectory tracks keep their own dashboard
 * pointers (weave-io/weave#183).
 *
 * Bucket: Evals. CI runs the eval tracks in two jobs, one after the other:
 * `run-evals` publishes the text run, then `trajectory-evals` publishes the
 * trajectory run. Each job starts from an empty `eval-bundles/` and rebuilds
 * the dashboard indexes from the one run it holds. Before the indexes were
 * track-aware the trajectory job, publishing last, rewrote `latest.json` and
 * the dashboard showed a 20-case, 4-model trajectory run as the main results
 * (workflow run 36075064977).
 *
 * The black box is the results repository: a fake GitHub Contents API behind
 * the publisher's injected `fetch`, holding every file a publish wrote. The
 * promises:
 *
 * - a trajectory publish after a text publish leaves `latest.json`, the
 *   manifest and the histories on the text run, and points
 *   `latest-trajectory.json` and `trajectory-manifest.json` at itself;
 * - run IDs stay unique across the two tracks;
 * - a run published before tracks were recorded is placed by its cases;
 * - `weave eval reindex` rebuilds every index from the published runs, so a
 *   repository whose pointers were overwritten is put right.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  ArtifactBundleWriter,
  type BundleWriteResult,
  EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
  type WriteBundleOptions,
} from "../../packages/cli/src/evals/artifact-bundle.js";
import { DashboardIndexWriter } from "../../packages/cli/src/evals/dashboard-indexes.js";
import { GitHubContentsPublisher } from "../../packages/cli/src/evals/github-contents-publisher.js";
import { ResultsRepoReindexer } from "../../packages/cli/src/evals/reindex.js";
import type { CaseResult } from "../../packages/cli/src/evals/types.js";
import {
  caseResult,
  FIXED_GIT_SHA,
  provenanceManifest,
  runnerResult,
  withBundleRoot,
} from "../support/evals.js";

// ---------------------------------------------------------------------------
// A fake results repository behind the GitHub Contents API
// ---------------------------------------------------------------------------

const TOKEN = "a-results-repo-token";
const TOKEN_ENV = { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: TOKEN };
const CONTENTS_PATH = "/repos/weave-io/weave-agent-evals/contents/";

/**
 * An in-memory `weave-io/weave-agent-evals`. PUT stores a file, GET returns it
 * (base64 JSON, or raw text when asked for `application/vnd.github.raw`), and
 * a GET on a directory lists its children. Every request is recorded.
 */
function fakeResultsRepo(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const requests: string[] = [];

  const fetchImpl = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.replace(CONTENTS_PATH, ""));
    requests.push(`${request.method} ${path}`);

    if (request.method === "PUT") {
      const body = (await request.json()) as { content: string };
      files.set(path, Buffer.from(body.content, "base64").toString("utf-8"));
      return new Response(JSON.stringify({ commit: { sha: "commit-sha" } }), {
        status: 201,
      });
    }

    const text = files.get(path);
    if (text !== undefined) {
      if (request.headers.get("Accept") === "application/vnd.github.raw") {
        return new Response(text, { status: 200 });
      }
      return new Response(
        JSON.stringify({
          sha: `blob-of-${path}`,
          content: Buffer.from(text).toString("base64"),
        }),
        { status: 200 },
      );
    }

    const children = new Map<string, "file" | "dir">();
    for (const key of files.keys()) {
      if (!key.startsWith(`${path}/`)) continue;
      const [name, ...deeper] = key.slice(path.length + 1).split("/");
      if (name !== undefined)
        children.set(name, deeper.length ? "dir" : "file");
    }
    if (children.size > 0) {
      return new Response(
        JSON.stringify([...children].map(([name, type]) => ({ name, type }))),
        { status: 200 },
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  return {
    files,
    requests,
    fetchImpl,
    // biome-ignore lint/suspicious/noExplicitAny: scenarios read published JSON untyped.
    json(path: string): any {
      const text = files.get(path);
      if (text === undefined) return undefined;
      return JSON.parse(text);
    },
    /** The paths PUT since `mark`. */
    putsSince(mark: number): string[] {
      return requests
        .slice(mark)
        .filter((r) => r.startsWith("PUT "))
        .map((r) => r.slice(4));
    },
  };
}

type FakeRepo = ReturnType<typeof fakeResultsRepo>;

// ---------------------------------------------------------------------------
// Runs of each track
// ---------------------------------------------------------------------------

const TEXT_AT = "2026-01-15T12:00:00.000Z";
const TRAJECTORY_AT = "2026-01-15T12:30:00.000Z";

/** A harness trajectory case as the trajectory runner reports it. */
function trajectoryCase(
  caseId: string,
  overrides: Partial<CaseResult["summary"]> = {},
): CaseResult {
  return caseResult({
    caseId,
    trajectorySummary: {
      harnessDelegatedCorrectly: true,
      observedSpawns: ["shuttle"],
      observedToolCalls: 4,
      harnessCompletedWithoutError: true,
    },
    ...overrides,
  });
}

/** The text job's results: two models on two text cases. */
const TEXT_RESULTS = [
  runnerResult({
    caseResults: [
      caseResult({ modelId: "alpha/model" }),
      caseResult({ modelId: "zeta/model" }),
      caseResult({ caseId: "route-to-warp", modelId: "alpha/model" }),
      caseResult({ caseId: "route-to-warp", modelId: "zeta/model" }),
    ],
  }),
];

/**
 * The trajectory job's results: one case ran, one errored because the
 * harness crashed (the errored entry has no trajectory summary).
 */
const TRAJECTORY_RESULTS = [
  runnerResult({
    caseResults: [
      trajectoryCase("delegates-backend-fix-trajectory"),
      trajectoryCase("dispatches-in-parallel-trajectory", {
        passed: false,
        errored: true,
        errorClassification: "trajectory-HarnessCrashed",
        trajectorySummary: undefined,
      }),
    ],
  }),
];

/**
 * One CI job: a fresh `eval-bundles/`, a publish-mode write that numbers the
 * run against the remote, regenerates the indexes from this run alone and
 * uploads them through the GitHub publisher.
 */
async function ciJob(
  repo: FakeRepo,
  options: Partial<WriteBundleOptions>,
): Promise<BundleWriteResult> {
  return withBundleRoot(async (root) => {
    const publisher = new GitHubContentsPublisher(repo.fetchImpl);
    const result = await new ArtifactBundleWriter(root).writeBundle({
      runnerResults: TEXT_RESULTS,
      provenanceManifest: provenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      mode: "publish",
      env: TOKEN_ENV,
      publisher,
      remoteSequenceReader: publisher,
      writeMarkdown: true,
      generateIndexes: true,
      ...options,
    });
    if (result.isErr()) {
      expect(JSON.stringify(result.error)).toBe("job published");
    }
    return result._unsafeUnwrap();
  });
}

const textJob = (repo: FakeRepo, at = TEXT_AT) =>
  ciJob(repo, { track: "text", assembledAt: at });
const trajectoryJob = (repo: FakeRepo, at = TRAJECTORY_AT) =>
  ciJob(repo, {
    track: "trajectory",
    assembledAt: at,
    runnerResults: TRAJECTORY_RESULTS,
  });

const INDEXES = "indexes/v1";

// ===========================================================================

describe("the trajectory job publishes after the text job, as CI runs them", () => {
  async function bothJobs() {
    const repo = fakeResultsRepo();
    const text = await textJob(repo);
    const textIndexes = new Map(
      [...repo.files].filter(([path]) => path.startsWith(`${INDEXES}/`)),
    );
    const mark = repo.requests.length;
    const trajectory = await trajectoryJob(repo);
    return { repo, text, trajectory, textIndexes, mark };
  }

  it("leaves latest.json on the text run, so the dashboard's main results stay the text run", async () => {
    const { repo, text } = await bothJobs();

    expect(repo.json(`${INDEXES}/latest.json`)).toMatchObject({
      runId: text.runId,
      totalCases: 4,
    });
  });

  it("points latest-trajectory.json at the trajectory run, with its errored case counted", async () => {
    const { repo, trajectory } = await bothJobs();

    expect(repo.json(`${INDEXES}/latest-trajectory.json`)).toMatchObject({
      runId: trajectory.runId,
      totalCases: 2,
      passedCases: 1,
      failedCases: 0,
      erroredCases: 1,
    });
  });

  it("lists the trajectory run in its own manifest and keeps it out of the main one", async () => {
    const { repo, text, trajectory } = await bothJobs();
    const ids = (file: string) =>
      repo
        .json(`${INDEXES}/${file}`)
        .runs.map((r: { runId: string }) => r.runId);

    expect(ids("dashboard-manifest.json")).toEqual([text.runId]);
    expect(ids("trajectory-manifest.json")).toEqual([trajectory.runId]);
    expect(
      repo.json(`${INDEXES}/trajectory-manifest.json`).runs[0].bundleReportPath,
    ).toBe(`runs/v1/${trajectory.runId}/public-report.json`);
  });

  it("rewrites none of the text run's index files", async () => {
    const { repo, textIndexes, mark, trajectory } = await bothJobs();

    expect(
      repo
        .putsSince(mark)
        .filter((p) => p.startsWith(INDEXES))
        .sort(),
    ).toEqual(
      [
        `${INDEXES}/latest-trajectory.json`,
        `${INDEXES}/model-comparison-${trajectory.runId}.json`,
        `${INDEXES}/trajectory-manifest.json`,
      ].sort(),
    );
    for (const [path, content] of textIndexes) {
      expect(`${path}: ${repo.files.get(path) === content}`).toBe(
        `${path}: true`,
      );
    }
  });

  it("numbers the trajectory run after the text run, so no run ID is reused", async () => {
    const { text, trajectory } = await bothJobs();

    expect(text.runId).toBe("abc123d-2026-01-15-001");
    expect(trajectory.runId).toBe("abc123d-2026-01-15-002");
  });

  it("numbers the next text run after the trajectory run, although only the trajectory manifest lists it", async () => {
    const { repo } = await bothJobs();
    const next = await textJob(repo, "2026-01-15T13:00:00.000Z");

    expect(next.runId).toBe("abc123d-2026-01-15-003");
    expect(repo.json(`${INDEXES}/latest.json`).runId).toBe(next.runId);
  });

  it("records the track in the published report, so a later rebuild can tell the runs apart", async () => {
    const { repo, text, trajectory } = await bothJobs();

    expect(
      repo.json(`runs/v1/${text.runId}/public-report.json`).runSummary.track,
    ).toBe("text");
    expect(
      repo.json(`runs/v1/${trajectory.runId}/public-report.json`).runSummary
        .track,
    ).toBe("trajectory");
  });
});

describe("a trajectory run is published first, before any text run that day", () => {
  it("writes no latest.json at all, rather than pointing it at the trajectory run", async () => {
    const repo = fakeResultsRepo();
    await trajectoryJob(repo);

    expect(repo.files.has(`${INDEXES}/latest.json`)).toBe(false);
    expect(repo.files.has(`${INDEXES}/dashboard-manifest.json`)).toBe(false);
    expect(repo.files.has(`${INDEXES}/latest-trajectory.json`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runs that did not record a track
// ---------------------------------------------------------------------------

describe("runs published before the track was recorded are rebuilt into the indexes", () => {
  /** Writes runs without a track, then rebuilds the indexes locally. */
  async function rebuildUnrecorded(
    root: string,
    runs: Array<Partial<WriteBundleOptions>>,
  ) {
    for (const run of runs) {
      const written = await new ArtifactBundleWriter(root).writeBundle({
        runnerResults: TEXT_RESULTS,
        provenanceManifest: provenanceManifest(),
        gitSha: FIXED_GIT_SHA,
        ...run,
      });
      expect(written.isOk()).toBe(true);
    }
    const rebuilt = await new DashboardIndexWriter(root).rebuildFromRuns();
    expect(rebuilt.isOk()).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: scenarios read published JSON untyped.
    return async (file: string): Promise<any> =>
      Bun.file(join(root, file)).json();
  }

  it("treats a run of nothing but trajectory cases as the trajectory run", async () => {
    await withBundleRoot(async (root) => {
      const read = await rebuildUnrecorded(root, [
        { assembledAt: TEXT_AT },
        { assembledAt: TRAJECTORY_AT, runnerResults: TRAJECTORY_RESULTS },
      ]);

      expect((await read("latest.json")).runId).toBe("abc123d-2026-01-15-001");
      expect((await read("latest-trajectory.json")).runId).toBe(
        "abc123d-2026-01-15-002",
      );
    });
  });

  it("treats a run of both tracks, as a local run without --track makes, as a main run", async () => {
    await withBundleRoot(async (root) => {
      const read = await rebuildUnrecorded(root, [
        {
          assembledAt: TEXT_AT,
          runnerResults: [
            runnerResult({
              caseResults: [caseResult(), trajectoryCase("edit-trajectory")],
            }),
          ],
        },
      ]);

      expect((await read("latest.json")).runId).toBe("abc123d-2026-01-15-001");
      expect(
        await Bun.file(join(root, "latest-trajectory.json")).exists(),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// weave eval reindex
// ---------------------------------------------------------------------------

describe("a maintainer reindexes a results repository whose pointers a trajectory publish overwrote", () => {
  /**
   * The repository as the bug left it: a text run and a newer trajectory run,
   * neither recording its track, with every main index pointing at the
   * trajectory run — plus a run the current schema cannot read.
   */
  async function overwrittenRepo(): Promise<FakeRepo> {
    const seed: Record<string, string> = {};
    await withBundleRoot(async (root) => {
      const writer = new ArtifactBundleWriter(root);
      const write = async (options: Partial<WriteBundleOptions>) =>
        (
          await writer.writeBundle({
            runnerResults: TEXT_RESULTS,
            provenanceManifest: provenanceManifest(),
            gitSha: FIXED_GIT_SHA,
            ...options,
          })
        )._unsafeUnwrap();
      const text = await write({ assembledAt: TEXT_AT });
      const trajectory = await write({
        assembledAt: TRAJECTORY_AT,
        runnerResults: TRAJECTORY_RESULTS,
      });
      for (const run of [text, trajectory]) {
        seed[`runs/v1/${run.runId}/public-report.json`] = await Bun.file(
          join(run.bundleDir, "public-report.json"),
        ).text();
      }
      seed["runs/v1/abc123d-2026-01-14-001/public-report.json"] =
        JSON.stringify({ schemaVersion: 99 });
      seed[`${INDEXES}/latest.json`] = JSON.stringify({
        schemaVersion: 1,
        runId: trajectory.runId,
      });
    });
    return fakeResultsRepo(seed);
  }

  async function reindex(
    repo: FakeRepo,
    dryRun = false,
    env: Record<string, string | undefined> = TOKEN_ENV,
  ) {
    return withBundleRoot(async (workDir) =>
      new ResultsRepoReindexer(
        new GitHubContentsPublisher(repo.fetchImpl),
        workDir,
        "2026-01-16T00:00:00.000Z",
      ).reindex({ env, dryRun }),
    );
  }

  it("points latest.json back at the text run", async () => {
    const repo = await overwrittenRepo();
    await reindex(repo);

    expect(repo.json(`${INDEXES}/latest.json`)).toMatchObject({
      runId: "abc123d-2026-01-15-001",
      totalCases: 4,
    });
  });

  it("points latest-trajectory.json at the trajectory run", async () => {
    const repo = await overwrittenRepo();
    await reindex(repo);

    expect(repo.json(`${INDEXES}/latest-trajectory.json`).runId).toBe(
      "abc123d-2026-01-15-002",
    );
  });

  it("reports what it found, what it indexed and which run it could not read", async () => {
    const repo = await overwrittenRepo();
    const summary = (await reindex(repo))._unsafeUnwrap();

    expect(summary.runsFound).toEqual([
      "abc123d-2026-01-14-001",
      "abc123d-2026-01-15-001",
      "abc123d-2026-01-15-002",
    ]);
    expect(summary.runsIndexed).toEqual([
      "abc123d-2026-01-15-002",
      "abc123d-2026-01-15-001",
    ]);
    expect(summary.runsSkipped.map((s) => s.runId)).toEqual([
      "abc123d-2026-01-14-001",
    ]);
    expect(summary.latestRunId).toBe("abc123d-2026-01-15-001");
    expect(summary.latestTrajectoryRunId).toBe("abc123d-2026-01-15-002");
    expect(summary.filesPublished).toBe(summary.indexFiles.length);
  });

  it("writes only index files, never a run artifact", async () => {
    const repo = await overwrittenRepo();
    const before = new Map(repo.files);
    await reindex(repo);
    const puts = repo.putsSince(0);

    expect(puts.length).toBeGreaterThan(0);
    expect(puts.filter((p) => !p.startsWith(`${INDEXES}/`))).toEqual([]);
    for (const [path, content] of before) {
      if (!path.startsWith("runs/")) continue;
      expect(repo.files.get(path)).toBe(content);
    }
  });

  it("uploads nothing on a dry run, but still says where the pointers would go", async () => {
    const repo = await overwrittenRepo();
    const summary = (await reindex(repo, true))._unsafeUnwrap();

    expect(repo.putsSince(0)).toEqual([]);
    expect(summary.latestRunId).toBe("abc123d-2026-01-15-001");
    expect(summary.indexFiles).toContain("latest-trajectory.json");
  });

  it("fails, uploading nothing, when one run's report cannot be fetched, rather than indexing without it", async () => {
    const repo = await overwrittenRepo();
    const broken = "runs/v1/abc123d-2026-01-15-001/public-report.json";
    const flaky = {
      ...repo,
      fetchImpl: async (request: Request) =>
        request.url.includes(broken)
          ? new Response("Server Error", { status: 502 })
          : repo.fetchImpl(request),
    };
    const result = await reindex(flaky);

    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "ReindexFailed" });
    expect(result._unsafeUnwrapErr().message).toContain(
      "abc123d-2026-01-15-001",
    );
    expect(repo.putsSince(0)).toEqual([]);
  });

  it("refuses a run listing that reaches the Contents API's 1,000-entry limit, since it may be truncated", async () => {
    const seed: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      seed[
        `runs/v1/abc123d-2026-01-15-${String(i).padStart(4, "0")}/public-report.json`
      ] = "{}";
    }
    const repo = fakeResultsRepo(seed);
    const result = await reindex(repo);

    expect(result._unsafeUnwrapErr().message).toContain("1000 entries");
    expect(repo.putsSince(0)).toEqual([]);
  });

  it("refuses without a results-repo token and reaches the repository not at all", async () => {
    const repo = await overwrittenRepo();
    const result = await reindex(repo, false, {});

    expect(result._unsafeUnwrapErr().type).toBe("TokenMissing");
    expect(repo.requests).toEqual([]);
  });
});
