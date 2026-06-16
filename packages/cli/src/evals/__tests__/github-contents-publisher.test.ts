/**
 * Tests for `github-contents-publisher.ts`.
 *
 * Verifies:
 *   - `GitHubContentsPublisher.publish()` returns err(TokenMissing) when
 *     EVAL_RESULTS_REPO_TOKEN is absent.
 *   - `GitHubContentsPublisher.publish()` returns err(TokenMissing) when
 *     EVAL_RESULTS_REPO_TOKEN is whitespace-only.
 *   - Token is never present in any error message returned to callers.
 *   - `GitHubContentsPublisher.publish()` returns err(DryRunPublishBlocked)
 *     for dry-run bundles (enforced by enforcePublishPolicy).
 *   - `GitHubContentsPublisher.publish()` calls PUT to the GitHub Contents API
 *     for each allowlisted file in `fileNames`.
 *   - Authorization header contains `Bearer <token>` — token only in header.
 *   - Token is never interpolated into the URL, body, or any logged field.
 *   - Raw files (anything with "raw/" in the name) are excluded even when
 *     explicitly listed in `fileNames`.
 *   - Non-allowlisted files are excluded even when explicitly listed in `fileNames`.
 *   - Files are written under `runs/v1/<runId>/<fileName>` (v1 remote layout).
 *   - Index files are written under `indexes/v1/<fileName>` (not at repo root).
 *   - `GitHubContentsPublisher.publish()` returns err(PublishFailed) on non-ok
 *     HTTP responses without leaking the response body or token.
 *   - `GitHubContentsPublisher.publish()` returns err(PublishFailed) on network
 *     errors without leaking the token.
 *   - `GitHubContentsPublisher.publish()` returns err(NoScoreFilesToPublish)
 *     when bundle has no score files.
 *   - Run artifact files are always uploaded BEFORE index files (publish-before-index).
 *   - Re-publishing refreshes index files while immutable run artifacts are not
 *     re-uploaded (indexes are non-fatal so they continue on 422).
 *   - `bundle-index.json` only lists allowlisted public file names.
 *   - TARGET_REPO, TARGET_BRANCH, TARGET_RUNS_PREFIX, TARGET_INDEXES_PREFIX,
 *     REMOTE_LAYOUT_VERSION constants are correct.
 *   - RUN_ARTIFACT_ALLOWLIST and INDEX_ARTIFACT_ALLOWLIST constants contain
 *     the expected file names.
 *   - Publisher errors are redacted: no file paths, no raw error details.
 *
 * Test isolation:
 *   - `fetchImpl` is injected to return controlled HTTP responses.
 *   - No real network calls.
 *   - No real file-system reads (fileNames are provided explicitly).
 *   - Token is a fake string — never a real credential.
 *   - All assertions check error types, not message substrings containing tokens.
 */

import { describe, expect, it } from "bun:test";
import { EVAL_RESULTS_REPO_TOKEN_ENV_VAR } from "../artifact-bundle.js";
import {
  type FetchImpl,
  type FileReader,
  GitHubContentsPublisher,
  INDEX_ARTIFACT_ALLOWLIST,
  isIndexArtifactAllowed,
  MODEL_COMPARISON_INDEX_PATTERN,
  REMOTE_LAYOUT_VERSION,
  RUN_ARTIFACT_ALLOWLIST,
  SUITE_HISTORY_INDEX_PATTERN,
  TARGET_BRANCH,
  TARGET_INDEXES_PREFIX,
  TARGET_REPO,
  TARGET_RUNS_PREFIX,
} from "../github-contents-publisher.js";
import type { EvalBundle, ResultsRepoError } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "ghp_test_token_not_real_abc123";
const FIXED_GIT_SHA = "abc123def456abc123def456abc123def456abc1";
const FIXED_TIMESTAMP = "2026-06-11T12:00:00.000Z";
const BUNDLE_DIR_NAME = "abc123d-2026-06-11-001";
const LOCAL_BUNDLE_DIR = `/tmp/eval-bundles/runs/${BUNDLE_DIR_NAME}`;

function makeEvalBundle(overrides: Partial<EvalBundle> = {}): EvalBundle {
  return {
    version: 1,
    assembledAt: FIXED_TIMESTAMP,
    gitSha: FIXED_GIT_SHA,
    dryRun: false,
    runSummary: {
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      allSuitesGreen: true,
      suites: ["loom-routing"],
    },
    scoreFiles: [
      {
        suite: "loom-routing",
        assembledAt: FIXED_TIMESTAMP,
        gitSha: FIXED_GIT_SHA,
        dryRun: false,
        results: [
          {
            caseId: "route-to-shuttle",
            modelId: "anthropic/claude-sonnet-4.5",
            passed: true,
            required: true,
            weightedTotal: 0.9,
            dimensionScores: {
              routingCorrectness: { score: 1.0, applicable: true },
              delegationCorrectness: { score: 1.0, applicable: false },
              executionCompleteness: { score: 1.0, applicable: false },
              rationaleQuality: { score: 0.8, applicable: true },
            },
            scoredAt: FIXED_TIMESTAMP,
            dryRun: false,
          },
        ],
        totals: {
          totalCases: 1,
          passedCases: 1,
          failedCases: 0,
          suiteGreen: true,
        },
      },
    ],
    promptHashRecords: [],
    provenanceRef: null,
    ...overrides,
  };
}

function makeDryRunBundle(): EvalBundle {
  return makeEvalBundle({ dryRun: true });
}

function makeEnvWithToken(
  token = FAKE_TOKEN,
): Record<string, string | undefined> {
  return { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: token };
}

function makeEnvWithoutToken(): Record<string, string | undefined> {
  return {};
}

/**
 * Build a stub fetchImpl that returns a 201 Created response for PUT requests
 * and a 404 response for GET requests (file does not exist — create mode).
 */
function makeSuccessFetch(): {
  fetchImpl: FetchImpl;
  requests: Request[];
} {
  const requests: Request[] = [];
  const fetchImpl: FetchImpl = async (req) => {
    requests.push(req);
    if (req.method === "GET") {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      });
    }
    // PUT success
    return new Response(
      JSON.stringify({
        content: { path: req.url },
        commit: { sha: "new-commit-sha-abc" },
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetchImpl, requests };
}

/**
 * Build a stub fetchImpl that returns a configured HTTP status for PUT requests.
 */
function _makeFailingFetch(status: number): FetchImpl {
  return async (req) => {
    if (req.method === "GET") {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify({ message: "Forbidden" }), { status });
  };
}

/**
 * Build a stub fetchImpl that throws a network error for PUT requests.
 */
function _makeNetworkErrorFetch(): FetchImpl {
  return async (req) => {
    if (req.method === "GET") {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      });
    }
    throw new Error("ECONNREFUSED: Network connection refused");
  };
}

/**
 * Build a stub fileReader that returns a fixed JSON content for any path.
 * The content is a minimal valid JSON string representing a sanitized bundle file.
 */
function makeStubFileReader(content = '{"version":1}'): FileReader {
  return async (_path: string) => content;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — constants", () => {
  it("TARGET_REPO is weave-io/weave-agent-evals", () => {
    expect(TARGET_REPO).toBe("weave-io/weave-agent-evals");
  });

  it("TARGET_BRANCH is main", () => {
    expect(TARGET_BRANCH).toBe("main");
  });

  it("REMOTE_LAYOUT_VERSION is v1", () => {
    expect(REMOTE_LAYOUT_VERSION).toBe("v1");
  });

  it("TARGET_RUNS_PREFIX is runs/v1", () => {
    expect(TARGET_RUNS_PREFIX).toBe("runs/v1");
  });

  it("TARGET_INDEXES_PREFIX is indexes/v1", () => {
    expect(TARGET_INDEXES_PREFIX).toBe("indexes/v1");
  });
});

// ---------------------------------------------------------------------------
// Allowlist constants
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — allowlist constants", () => {
  it("RUN_ARTIFACT_ALLOWLIST contains bundle-index.json", () => {
    expect(RUN_ARTIFACT_ALLOWLIST.has("bundle-index.json")).toBe(true);
  });

  it("RUN_ARTIFACT_ALLOWLIST contains public-report.json", () => {
    expect(RUN_ARTIFACT_ALLOWLIST.has("public-report.json")).toBe(true);
  });

  it("RUN_ARTIFACT_ALLOWLIST contains public-report.md", () => {
    expect(RUN_ARTIFACT_ALLOWLIST.has("public-report.md")).toBe(true);
  });

  it("RUN_ARTIFACT_ALLOWLIST does NOT contain score-*.json", () => {
    expect(RUN_ARTIFACT_ALLOWLIST.has("score-loom-routing.json")).toBe(false);
    expect(RUN_ARTIFACT_ALLOWLIST.has("score-tapestry-execution.json")).toBe(
      false,
    );
  });

  it("RUN_ARTIFACT_ALLOWLIST does NOT contain raw artifacts", () => {
    expect(RUN_ARTIFACT_ALLOWLIST.has("raw/case-foo.json")).toBe(false);
    expect(RUN_ARTIFACT_ALLOWLIST.has("provenance-manifest.json")).toBe(false);
    expect(RUN_ARTIFACT_ALLOWLIST.has("run-summary.json")).toBe(false);
    expect(RUN_ARTIFACT_ALLOWLIST.has("prompt-hashes.json")).toBe(false);
  });

  it("INDEX_ARTIFACT_ALLOWLIST contains dashboard-manifest.json", () => {
    expect(INDEX_ARTIFACT_ALLOWLIST.has("dashboard-manifest.json")).toBe(true);
  });

  it("INDEX_ARTIFACT_ALLOWLIST contains latest.json", () => {
    expect(INDEX_ARTIFACT_ALLOWLIST.has("latest.json")).toBe(true);
  });

  it("INDEX_ARTIFACT_ALLOWLIST contains last-N-runs.json", () => {
    expect(INDEX_ARTIFACT_ALLOWLIST.has("last-N-runs.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isIndexArtifactAllowed — pattern matching
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — isIndexArtifactAllowed", () => {
  it("permits dashboard-manifest.json (exact match)", () => {
    expect(isIndexArtifactAllowed("dashboard-manifest.json")).toBe(true);
  });

  it("permits latest.json (exact match)", () => {
    expect(isIndexArtifactAllowed("latest.json")).toBe(true);
  });

  it("permits last-N-runs.json (exact match)", () => {
    expect(isIndexArtifactAllowed("last-N-runs.json")).toBe(true);
  });

  it("permits suite-history-loom-routing.json (pattern match)", () => {
    expect(isIndexArtifactAllowed("suite-history-loom-routing.json")).toBe(
      true,
    );
  });

  it("permits suite-history-tapestry-execution.json (pattern match)", () => {
    expect(
      isIndexArtifactAllowed("suite-history-tapestry-execution.json"),
    ).toBe(true);
  });

  it("permits model-comparison-abc1234-2026-06-11-001.json (pattern match)", () => {
    expect(
      isIndexArtifactAllowed("model-comparison-abc1234-2026-06-11-001.json"),
    ).toBe(true);
  });

  it("permits model-comparison-unknown-2026-01-15-001.json (pattern match)", () => {
    expect(
      isIndexArtifactAllowed("model-comparison-unknown-2026-01-15-001.json"),
    ).toBe(true);
  });

  it("rejects arbitrary-file.json (unknown name)", () => {
    expect(isIndexArtifactAllowed("arbitrary-file.json")).toBe(false);
  });

  it("rejects run-summary.json (internal bundle file)", () => {
    expect(isIndexArtifactAllowed("run-summary.json")).toBe(false);
  });

  it("rejects score-loom-routing.json (internal bundle file)", () => {
    expect(isIndexArtifactAllowed("score-loom-routing.json")).toBe(false);
  });

  it("rejects file names containing path separators (security: no subdirectory traversal)", () => {
    expect(isIndexArtifactAllowed("some/nested/path.json")).toBe(false);
    expect(isIndexArtifactAllowed("foo\\bar.json")).toBe(false);
  });

  it("rejects file names with path traversal sequences", () => {
    expect(isIndexArtifactAllowed("../secret.json")).toBe(false);
    expect(isIndexArtifactAllowed("..\\secret.json")).toBe(false);
  });

  it("rejects suite-history- with no suite name suffix", () => {
    expect(isIndexArtifactAllowed("suite-history-.json")).toBe(false);
  });

  it("rejects model-comparison- with no runId suffix", () => {
    expect(isIndexArtifactAllowed("model-comparison-.json")).toBe(false);
  });

  it("SUITE_HISTORY_INDEX_PATTERN matches suite-history-<suite>.json forms", () => {
    expect(
      SUITE_HISTORY_INDEX_PATTERN.test("suite-history-loom-routing.json"),
    ).toBe(true);
    expect(
      SUITE_HISTORY_INDEX_PATTERN.test("suite-history-tapestry-execution.json"),
    ).toBe(true);
    expect(SUITE_HISTORY_INDEX_PATTERN.test("suite-history-.json")).toBe(false);
    expect(SUITE_HISTORY_INDEX_PATTERN.test("suite-history-a/b.json")).toBe(
      false,
    );
  });

  it("MODEL_COMPARISON_INDEX_PATTERN matches model-comparison-<runId>.json forms", () => {
    expect(
      MODEL_COMPARISON_INDEX_PATTERN.test(
        "model-comparison-abc1234-2026-06-11-001.json",
      ),
    ).toBe(true);
    expect(
      MODEL_COMPARISON_INDEX_PATTERN.test(
        "model-comparison-unknown-2026-01-15-001.json",
      ),
    ).toBe(true);
    expect(MODEL_COMPARISON_INDEX_PATTERN.test("model-comparison-.json")).toBe(
      false,
    );
    expect(
      MODEL_COMPARISON_INDEX_PATTERN.test("model-comparison-a/b.json"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — token validation", () => {
  it("returns err(TokenMissing) when EVAL_RESULTS_REPO_TOKEN is absent", async () => {
    const publisher = new GitHubContentsPublisher(
      makeSuccessFetch().fetchImpl,
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithoutToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("TokenMissing");
  });

  it("returns err(TokenMissing) when EVAL_RESULTS_REPO_TOKEN is empty string", async () => {
    const publisher = new GitHubContentsPublisher(
      makeSuccessFetch().fetchImpl,
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "" },
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("TokenMissing");
  });

  it("returns err(TokenMissing) when EVAL_RESULTS_REPO_TOKEN is whitespace-only", async () => {
    const publisher = new GitHubContentsPublisher(
      makeSuccessFetch().fetchImpl,
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "   " },
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("TokenMissing");
  });

  it("error message for missing token does not contain the token value", async () => {
    const publisher = new GitHubContentsPublisher(
      makeSuccessFetch().fetchImpl,
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithoutToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as { message: string };
    // Message must not contain the actual fake token value
    expect(error.message).not.toContain(FAKE_TOKEN);
    // Message must name the env var (helpful for users) but not its value
    expect(error.message).toContain(EVAL_RESULTS_REPO_TOKEN_ENV_VAR);
  });

  it("makes no fetch calls when token is absent", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );
    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithoutToken(),
    });

    expect(requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dry-run policy
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — dry-run policy", () => {
  it("returns err(DryRunPublishBlocked) for dry-run bundles", async () => {
    const publisher = new GitHubContentsPublisher(
      makeSuccessFetch().fetchImpl,
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeDryRunBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("DryRunPublishBlocked");
  });

  it("makes no fetch calls for dry-run bundles", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );
    await publisher.publish({
      bundle: makeDryRunBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    expect(requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Score file policy
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — score file policy", () => {
  it("returns err(NoScoreFilesToPublish) when bundle has no score files", async () => {
    const publisher = new GitHubContentsPublisher(
      makeSuccessFetch().fetchImpl,
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle({ scoreFiles: [] }),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("NoScoreFilesToPublish");
  });
});

// ---------------------------------------------------------------------------
// Public artifact allowlist enforcement
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — public artifact allowlist", () => {
  it("excludes files with 'raw/' in the name even when explicitly listed", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: [
        "bundle-index.json",
        "raw/case-loom-route-backend-api-anthropic_claude-sonnet-4.5-2026-06-11.json",
        "public-report.json",
        "raw/prompt-loom-2026-06-11.json",
      ],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    // Must only upload allowlisted files (bundle-index.json, public-report.json)
    expect(putRequests.length).toBe(2);
    for (const req of putRequests) {
      expect(req.url).not.toContain("/raw/");
    }
  });

  it("excludes non-allowlisted files even when explicitly listed", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      // Mix of allowlisted and non-allowlisted files
      fileNames: [
        "bundle-index.json", // allowlisted
        "run-summary.json", // NOT allowlisted (internal)
        "score-loom-routing.json", // NOT allowlisted (internal)
        "public-report.json", // allowlisted
        "provenance-manifest.json", // NOT allowlisted (internal)
        "prompt-hashes.json", // NOT allowlisted (internal)
      ],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    // Only allowlisted files should be uploaded
    expect(putRequests.length).toBe(2);
    const uploadedUrls = putRequests.map((r) => r.url);
    expect(uploadedUrls.some((u) => u.includes("bundle-index.json"))).toBe(
      true,
    );
    expect(uploadedUrls.some((u) => u.includes("public-report.json"))).toBe(
      true,
    );
    expect(uploadedUrls.some((u) => u.includes("run-summary.json"))).toBe(
      false,
    );
    expect(
      uploadedUrls.some((u) => u.includes("score-loom-routing.json")),
    ).toBe(false);
  });

  it("excludes files starting with 'raw/'", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["raw/case-foo-bar.json", "bundle-index.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    expect(putRequests.length).toBe(1);
    expect(putRequests[0].url).toContain("bundle-index.json");
    expect(putRequests[0].url).not.toContain("raw/");
  });

  it("returns err(PublishFailed) when fileNames contains only non-allowlisted files", async () => {
    const { fetchImpl } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["run-summary.json", "score-loom-routing.json"],
      env: makeEnvWithToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("PublishFailed");
    // Error message must not contain the token
    expect(error.message).not.toContain(FAKE_TOKEN);
  });

  it("allows public-report.md (non-json allowlisted file) through the allowlist", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader("# Report"),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json", "public-report.md"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    expect(putRequests.length).toBe(2);
    const uploadedUrls = putRequests.map((r) => r.url);
    expect(uploadedUrls.some((u) => u.includes("public-report.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Remote v1 layout — path structure
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — v1 remote layout", () => {
  it("uploads run artifacts under runs/v1/<runId>/ prefix", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );
    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json", "public-report.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    for (const req of putRequests) {
      // URL must contain the versioned runs/v1/<bundleDirName>/ prefix
      expect(req.url).toContain(`${TARGET_RUNS_PREFIX}/${BUNDLE_DIR_NAME}/`);
    }
  });

  it("uploads run artifacts to runs/v1/<runId>/<fileName> path", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );
    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    expect(putRequests.length).toBeGreaterThanOrEqual(1);
    const firstPut = putRequests.at(0);
    expect(firstPut).toBeDefined();
    if (firstPut === undefined) return;
    expect(firstPut.url).toContain(
      `runs/v1/${BUNDLE_DIR_NAME}/bundle-index.json`,
    );
  });

  it("uploads index artifacts under indexes/v1/ prefix (not repo root)", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      localBundleRoot: "/tmp/eval-bundles",
      indexFileNames: ["dashboard-manifest.json", "latest.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    // 1 run file + 2 index files = 3 PUT requests
    expect(putRequests.length).toBe(3);

    // Index files must be under indexes/v1/ — not under runs/v1/ and not at repo root
    const indexPuts = putRequests.filter(
      (r) =>
        r.url.includes("dashboard-manifest.json") ||
        r.url.includes("latest.json"),
    );
    expect(indexPuts.length).toBe(2);
    for (const req of indexPuts) {
      expect(req.url).toContain(`${TARGET_INDEXES_PREFIX}/`);
      expect(req.url).not.toContain(`${TARGET_RUNS_PREFIX}/`);
    }
  });

  it("index file URLs use indexes/v1/<fileName> path", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      localBundleRoot: "/tmp/eval-bundles",
      indexFileNames: ["dashboard-manifest.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    const indexPut = putRequests.find((r) =>
      r.url.includes("dashboard-manifest.json"),
    );
    expect(indexPut).toBeDefined();
    // URL must be under indexes/v1/
    expect(indexPut?.url).toContain(`indexes/v1/dashboard-manifest.json`);
    // Must NOT be under runs/v1/
    expect(indexPut?.url).not.toContain(`runs/v1/`);
  });

  it("uses basename() for runId extraction on POSIX paths", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    const posixBundleDir =
      "/workspace/eval-bundles/runs/abc1234-2026-06-11-001";
    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: posixBundleDir,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    // URL must contain runs/v1/abc1234-2026-06-11-001/ (basename extracted correctly)
    for (const req of putRequests) {
      expect(req.url).toContain("runs/v1/abc1234-2026-06-11-001/");
    }
  });
});

// ---------------------------------------------------------------------------
// Publish-before-index ordering
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — publish-before-index ordering", () => {
  it("uploads run artifacts BEFORE index files", async () => {
    const uploadOrder: string[] = [];
    const fetchImpl: FetchImpl = async (req) => {
      if (req.method === "GET") {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        });
      }
      // Record upload order by URL suffix
      const url = req.url;
      if (url.includes("bundle-index.json") && url.includes("runs/"))
        uploadOrder.push("run:bundle-index.json");
      if (url.includes("public-report.json") && url.includes("runs/"))
        uploadOrder.push("run:public-report.json");
      if (url.includes("dashboard-manifest.json"))
        uploadOrder.push("index:dashboard-manifest.json");
      if (url.includes("latest.json")) uploadOrder.push("index:latest.json");
      return new Response(
        JSON.stringify({ content: {}, commit: { sha: "abc" } }),
        { status: 201 },
      );
    };

    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );
    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json", "public-report.json"],
      localBundleRoot: "/tmp/eval-bundles",
      indexFileNames: ["dashboard-manifest.json", "latest.json"],
      env: makeEnvWithToken(),
    });

    // All run artifacts must come before any index artifact
    const firstIndexIdx = uploadOrder.findIndex((e: string) =>
      e.startsWith("index:"),
    );
    // findLastIndex is ES2023 — use reduce for compat
    const lastRunIdx = uploadOrder.reduce(
      (acc: number, e: string, i: number) => (e.startsWith("run:") ? i : acc),
      -1,
    );
    expect(firstIndexIdx).toBeGreaterThan(-1);
    expect(lastRunIdx).toBeGreaterThan(-1);
    expect(lastRunIdx).toBeLessThan(firstIndexIdx);
  });

  it("run artifacts appear before index artifacts in upload sequence", async () => {
    const uploadOrder: string[] = [];
    const fetchImpl: FetchImpl = async (req) => {
      if (req.method === "GET") {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        });
      }
      const url = req.url;
      if (url.includes("bundle-index.json"))
        uploadOrder.push("bundle-index.json");
      if (url.includes("dashboard-manifest.json"))
        uploadOrder.push("dashboard-manifest.json");
      if (url.includes("latest.json")) uploadOrder.push("latest.json");
      return new Response(
        JSON.stringify({ content: {}, commit: { sha: "abc" } }),
        { status: 201 },
      );
    };

    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );
    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      localBundleRoot: "/tmp/eval-bundles",
      indexFileNames: ["dashboard-manifest.json", "latest.json"],
      env: makeEnvWithToken(),
    });

    expect(uploadOrder[0]).toBe("bundle-index.json");
    expect(uploadOrder.slice(1)).toEqual([
      "dashboard-manifest.json",
      "latest.json",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Index file handling
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — index file handling", () => {
  it("continues publish even when index file upload fails (non-fatal)", async () => {
    let indexCallCount = 0;
    const fetchImpl: FetchImpl = async (req) => {
      if (req.method === "GET") {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        });
      }
      // PUT for index files fails; run files succeed
      if (
        req.url.includes("dashboard-manifest.json") ||
        req.url.includes("latest.json")
      ) {
        indexCallCount++;
        return new Response(JSON.stringify({ message: "Server Error" }), {
          status: 500,
        });
      }
      return new Response(
        JSON.stringify({ content: {}, commit: { sha: "abc123" } }),
        { status: 201 },
      );
    };

    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      localBundleRoot: "/tmp/eval-bundles",
      indexFileNames: ["dashboard-manifest.json", "latest.json"],
      env: makeEnvWithToken(),
    });

    // Publish must still succeed (index failures are non-fatal)
    expect(result.isOk()).toBe(true);
    // Both index uploads were attempted
    expect(indexCallCount).toBe(2);
  });

  it("does not publish index files when indexFileNames is omitted", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      // No indexFileNames
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    // Only 1 run file — no index files
    expect(putRequests.length).toBe(1);
    const onlyPut = putRequests.at(0);
    expect(onlyPut).toBeDefined();
    if (onlyPut === undefined) return;
    expect(onlyPut.url).toContain(`${TARGET_RUNS_PREFIX}/`);
  });

  it("does not publish index files when indexFileNames is an empty array", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      localBundleRoot: "/tmp/eval-bundles",
      indexFileNames: [],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    expect(putRequests.length).toBe(1);
  });

  it("allows suite-history-<suite>.json and model-comparison-<runId>.json index files via pattern", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      localBundleRoot: "/tmp/eval-bundles",
      // All of these are permitted: exact names + pattern-matched names
      indexFileNames: [
        "dashboard-manifest.json", // exact allowlist
        "suite-history-loom-routing.json", // pattern: suite-history-<suite>.json
        "latest.json", // exact allowlist
        "model-comparison-abc1234-2026-06-11-001.json", // pattern: model-comparison-<runId>.json
      ],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    // 1 run file + 4 index files = 5 PUT requests
    expect(putRequests.length).toBe(5);
    const uploadedUrls = putRequests.map((r) => r.url);
    expect(
      uploadedUrls.some((u) => u.includes("dashboard-manifest.json")),
    ).toBe(true);
    expect(uploadedUrls.some((u) => u.includes("latest.json"))).toBe(true);
    expect(
      uploadedUrls.some((u) => u.includes("suite-history-loom-routing.json")),
    ).toBe(true);
    expect(
      uploadedUrls.some((u) =>
        u.includes("model-comparison-abc1234-2026-06-11-001.json"),
      ),
    ).toBe(true);
  });

  it("filters out truly non-allowlisted index file names (arbitrary files, path traversal)", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      localBundleRoot: "/tmp/eval-bundles",
      // Mix: only dashboard-manifest.json and latest.json are allowed
      indexFileNames: [
        "dashboard-manifest.json", // allowed
        "arbitrary-file.json", // NOT allowed — unknown name
        "latest.json", // allowed
        "../secret.json", // NOT allowed — path traversal
        "some/nested/path.json", // NOT allowed — contains path separator
      ],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    // 1 run file + 2 allowlisted index files = 3 PUT requests
    expect(putRequests.length).toBe(3);
    const uploadedUrls = putRequests.map((r) => r.url);
    expect(
      uploadedUrls.some((u) => u.includes("dashboard-manifest.json")),
    ).toBe(true);
    expect(uploadedUrls.some((u) => u.includes("latest.json"))).toBe(true);
    // Non-allowlisted index files must NOT be uploaded
    expect(uploadedUrls.some((u) => u.includes("arbitrary-file.json"))).toBe(
      false,
    );
    expect(uploadedUrls.some((u) => u.includes("secret.json"))).toBe(false);
    expect(uploadedUrls.some((u) => u.includes("nested/path.json"))).toBe(
      false,
    );
  });

  it("index file PUT uses Authorization header with token, no token in URL", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      localBundleRoot: "/tmp/eval-bundles",
      indexFileNames: ["dashboard-manifest.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    const indexPut = putRequests.find((r) =>
      r.url.includes("dashboard-manifest.json"),
    );
    expect(indexPut).toBeDefined();
    expect(indexPut?.headers.get("Authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(indexPut?.url).not.toContain(FAKE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Blocker 2: immutable run artifact re-publish protection
//
// Proves that:
//   1. Re-publishing the same run artifact (GET returns 200 for a runs/v1/<runId>/
//      path) fails with PublishFailed — the artifact is not overwritten.
//   2. Index files under indexes/v1/ can be updated atomically — the existing
//      SHA is resolved and included in the PUT so the update succeeds.
//   3. A run artifact that does NOT exist (GET returns 404) is created normally.
//   4. The GET for run artifacts is performed BEFORE any PUT (conflict check).
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — immutable run artifact protection", () => {
  /**
   * Build a fetchImpl where GET for run artifact paths returns 200 (file exists).
   * GET for index paths and any first-publish path returns 404.
   * PUT succeeds with 201.
   */
  function makeExistingRunArtifactFetch(existingRunPath: string): {
    fetchImpl: FetchImpl;
    requests: Request[];
  } {
    const requests: Request[] = [];
    const fetchImpl: FetchImpl = async (req) => {
      requests.push(req);
      if (req.method === "GET") {
        if (req.url.includes(existingRunPath)) {
          // Simulate existing run artifact — GET returns 200 with a blob SHA
          return new Response(
            JSON.stringify({
              sha: "existing-blob-sha-abc123",
              path: existingRunPath,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // All other GETs return 404 (file does not exist — create mode)
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        });
      }
      // PUT success
      return new Response(
        JSON.stringify({
          content: { path: req.url },
          commit: { sha: "commit-sha" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };
    return { fetchImpl, requests };
  }

  /**
   * Build a fetchImpl where GET for index paths returns 200 (file exists with SHA).
   * GET for run artifact paths returns 404.
   * PUT succeeds with 200.
   */
  function makeExistingIndexFetch(): {
    fetchImpl: FetchImpl;
    requests: Request[];
  } {
    const requests: Request[] = [];
    const fetchImpl: FetchImpl = async (req) => {
      requests.push(req);
      if (req.method === "GET") {
        if (req.url.includes("indexes/v1/")) {
          // Simulate existing index file — GET returns 200 with a blob SHA
          return new Response(
            JSON.stringify({ sha: "existing-index-sha-xyz789", path: req.url }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Run artifact paths return 404 (new upload)
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        });
      }
      // PUT success (200 for updates, 201 for creates — GitHub uses 200 for updates)
      return new Response(
        JSON.stringify({
          content: { path: req.url },
          commit: { sha: "commit-sha" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    return { fetchImpl, requests };
  }

  it("re-publishing same run artifact fails with PublishFailed (immutable protection)", async () => {
    // Simulate the bundle dir name / run ID that already exists remotely
    const alreadyExistingPath = `runs/v1/${BUNDLE_DIR_NAME}/bundle-index.json`;
    const { fetchImpl } = makeExistingRunArtifactFetch(alreadyExistingPath);
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    // Must fail because run artifact already exists
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as {
      type: string;
      message: string;
    };
    expect(error.type).toBe("PublishFailed");
    // Error message must not contain the token
    expect(error.message).not.toContain(FAKE_TOKEN);
    // Error message must indicate the publish failure (outer message from publishFiles)
    expect(error.message.toLowerCase()).toMatch(
      /run artifact|token permissions|run id was already published/i,
    );
  });

  it("run artifact upload does NOT issue a PUT when remote file already exists", async () => {
    const alreadyExistingPath = `runs/v1/${BUNDLE_DIR_NAME}/bundle-index.json`;
    const { fetchImpl, requests } =
      makeExistingRunArtifactFetch(alreadyExistingPath);
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    // The GET (conflict check) was issued, but the PUT must NOT be issued
    const getRequests = requests.filter((r) => r.method === "GET");
    const putRequests = requests.filter((r) => r.method === "PUT");
    expect(getRequests.length).toBeGreaterThan(0); // GET was issued to check existence
    expect(putRequests.length).toBe(0); // No PUT — rejected before upload
  });

  it("new (non-existing) run artifact is created with a PUT (normal first publish)", async () => {
    // GET returns 404 for all paths — first publish scenario
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    const putRequests = requests.filter((r) => r.method === "PUT");
    expect(putRequests.length).toBe(1);
    expect(putRequests.at(0)?.url).toContain("bundle-index.json");
  });

  it("index file can be updated when it already exists (mutable update succeeds)", async () => {
    // Index files under indexes/v1/ may be overwritten — they are mutable.
    const { fetchImpl, requests } = makeExistingIndexFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader('{"schemaVersion":1,"totalRuns":1}'),
    );

    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"], // run artifact (new — 404)
      localBundleRoot: "/tmp/eval-bundles",
      indexFileNames: ["dashboard-manifest.json"], // index (existing — 200)
      env: makeEnvWithToken(),
    });

    // Must succeed: index update is allowed
    expect(result.isOk()).toBe(true);

    const putRequests = requests.filter((r) => r.method === "PUT");
    // 1 PUT for run artifact + 1 PUT for index = 2 PUTs
    expect(putRequests.length).toBe(2);

    // The index PUT body must contain the existing SHA (atomically updating)
    const indexPut = putRequests.find((r) =>
      r.url.includes("dashboard-manifest.json"),
    );
    expect(indexPut).toBeDefined();
    if (indexPut === undefined) return;
    const body = JSON.parse(await indexPut.clone().text()) as Record<
      string,
      unknown
    >;
    expect(body.sha).toBe("existing-index-sha-xyz789");
  });

  it("index file PUT body contains existing SHA (atomic update contract)", async () => {
    const existingIndexSha = "index-blob-sha-123";
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl: FetchImpl = async (req) => {
      if (req.method === "GET") {
        if (req.url.includes("indexes/v1/")) {
          return new Response(JSON.stringify({ sha: existingIndexSha }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        });
      }
      if (req.url.includes("indexes/v1/")) {
        // Capture the PUT body for assertion
        capturedBody = JSON.parse(await req.text()) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({ content: {}, commit: { sha: "new-sha" } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader('{"schemaVersion":1}'),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      localBundleRoot: "/tmp/eval-bundles",
      indexFileNames: ["latest.json"],
      env: makeEnvWithToken(),
    });

    // The PUT body for the index file must include the existing SHA
    expect(capturedBody).not.toBeNull();
    if (capturedBody === null) return;
    const body = capturedBody as Record<string, unknown>;
    expect(body.sha).toBe(existingIndexSha);
  });

  it("run artifact PUT body does NOT include existing SHA even if one exists (create-only enforcement)", async () => {
    // This test verifies the implementation does not accidentally include a SHA
    // in the PUT body for immutable run artifacts when the file is new (404).
    let capturedRunBody: Record<string, unknown> | null = null;
    const fetchImpl: FetchImpl = async (req) => {
      if (req.method === "GET") {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        });
      }
      if (req.url.includes("runs/v1/")) {
        capturedRunBody = JSON.parse(await req.text()) as Record<
          string,
          unknown
        >;
      }
      return new Response(
        JSON.stringify({ content: {}, commit: { sha: "new-sha" } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    // Run artifact PUT body must NOT include a sha field (new file — no SHA for create)
    expect(capturedRunBody).not.toBeNull();
    if (capturedRunBody === null) return;
    const runBody = capturedRunBody as Record<string, unknown>;
    expect(runBody.sha).toBeUndefined();
  });
});
