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
 *     for each file in `fileNames`.
 *   - Authorization header contains `Bearer <token>` — token only in header.
 *   - Token is never interpolated into the URL, body, or any logged field.
 *   - Raw files (anything with "raw/" in the name) are excluded even when
 *     explicitly listed in `fileNames`.
 *   - Files are written under `runs/<bundleDirName>/<fileName>`.
 *   - `GitHubContentsPublisher.publish()` returns err(PublishFailed) on non-ok
 *     HTTP responses without leaking the response body or token.
 *   - `GitHubContentsPublisher.publish()` returns err(PublishFailed) on network
 *     errors without leaking the token.
 *   - `GitHubContentsPublisher.publish()` returns err(NoScoreFilesToPublish)
 *     when bundle has no score files.
 *   - TARGET_REPO, TARGET_BRANCH, TARGET_RUNS_PREFIX constants are correct.
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
  TARGET_BRANCH,
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
const BUNDLE_DIR_NAME = "abc123d-2026-06-11";
const LOCAL_BUNDLE_DIR = `/tmp/eval-bundles/${BUNDLE_DIR_NAME}`;

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
function makeFailingFetch(status: number): FetchImpl {
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
function makeNetworkErrorFetch(): FetchImpl {
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

  it("TARGET_RUNS_PREFIX is runs", () => {
    expect(TARGET_RUNS_PREFIX).toBe("runs");
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
    // Extra precaution: even if a token is partially set, error messages must
    // never include any token value.
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
// Raw file exclusion
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — raw file exclusion", () => {
  it("excludes files with 'raw/' in the name even when explicitly listed", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      // Mix of safe and raw paths — raw ones must be excluded
      fileNames: [
        "bundle-index.json",
        "raw/case-loom-route-backend-api-anthropic_claude-sonnet-4.5-2026-06-11.json",
        "run-summary.json",
        "raw/prompt-loom-2026-06-11.json",
      ],
      env: makeEnvWithToken(),
    });

    // Only PUT requests (for actual uploads) should have been made
    const putRequests = requests.filter((r) => r.method === "PUT");
    // Must only upload safe files (bundle-index.json, run-summary.json)
    expect(putRequests.length).toBe(2);
    for (const req of putRequests) {
      expect(req.url).not.toContain("/raw/");
    }
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
      fileNames: ["raw/case-foo-bar.json", "score-loom-routing.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    expect(putRequests.length).toBe(1);
    expect(putRequests[0].url).toContain("score-loom-routing.json");
    expect(putRequests[0].url).not.toContain("raw/");
  });
});

// ---------------------------------------------------------------------------
// Successful publish — request validation
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — successful publish", () => {
  it("returns ok(PublishBundleResult) for a valid bundle", async () => {
    const publisher = new GitHubContentsPublisher(
      makeSuccessFetch().fetchImpl,
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json", "run-summary.json"],
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.filesPublished).toBe(2);
    expect(value.branch).toBe(TARGET_BRANCH);
    expect(value.simulated).toBe(false);
  });

  it("uses PUT method for file uploads", async () => {
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
  });

  it("uploads files under the correct remote path prefix", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );
    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json", "score-loom-routing.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    for (const req of putRequests) {
      // URL must contain the runs/<bundleDirName>/ prefix
      expect(req.url).toContain(`${TARGET_RUNS_PREFIX}/${BUNDLE_DIR_NAME}/`);
    }
  });

  it("token is present in Authorization header and nowhere else in the request", async () => {
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

    for (const req of putRequests) {
      // Authorization header must contain the token
      expect(req.headers.get("Authorization")).toBe(`Bearer ${FAKE_TOKEN}`);

      // Token must NOT be in the URL
      expect(req.url).not.toContain(FAKE_TOKEN);

      // Token must NOT appear in any other header
      req.headers.forEach((value, name) => {
        if (name.toLowerCase() !== "authorization") {
          expect(value).not.toContain(FAKE_TOKEN);
        }
      });
    }
  });

  it("URL is an https:// GitHub API URL with no token embedded", async () => {
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
    for (const req of putRequests) {
      expect(req.url).toMatch(/^https:\/\/api\.github\.com\//);
      expect(req.url).not.toContain(FAKE_TOKEN);
      expect(req.url).not.toContain("@");
    }
  });

  it("includes the target repo in the request URL", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["score-loom-routing.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    for (const req of putRequests) {
      expect(req.url).toContain(TARGET_REPO);
    }
  });

  it("returns commitSha from the API response", async () => {
    const publisher = new GitHubContentsPublisher(
      makeSuccessFetch().fetchImpl,
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.commitSha).toBe("new-commit-sha-abc");
  });
});

// ---------------------------------------------------------------------------
// HTTP error handling — no token leakage
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — HTTP error handling", () => {
  it("returns err(PublishFailed) on HTTP 403 without leaking token", async () => {
    const publisher = new GitHubContentsPublisher(
      makeFailingFetch(403),
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("PublishFailed");
    // Error message must not contain the token
    expect(error.message).not.toContain(FAKE_TOKEN);
    // Error message should mention the HTTP status for diagnosis
    expect(error.message).toContain("403");
  });

  it("returns err(PublishFailed) on HTTP 422 without leaking token", async () => {
    const publisher = new GitHubContentsPublisher(
      makeFailingFetch(422),
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("PublishFailed");
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(error.message).toContain("422");
  });

  it("returns err(PublishFailed) on network error without leaking token", async () => {
    const publisher = new GitHubContentsPublisher(
      makeNetworkErrorFetch(),
      makeStubFileReader(),
    );
    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("PublishFailed");
    expect(error.message).not.toContain(FAKE_TOKEN);
  });

  it("error message contains no token value for any error type", async () => {
    // Comprehensive sweep: any error returned must not contain the token
    const scenarios: Array<{ fetch: FetchImpl; label: string }> = [
      { fetch: makeFailingFetch(401), label: "HTTP 401" },
      { fetch: makeFailingFetch(403), label: "HTTP 403" },
      { fetch: makeFailingFetch(404), label: "HTTP 404" },
      { fetch: makeFailingFetch(500), label: "HTTP 500" },
      { fetch: makeNetworkErrorFetch(), label: "network error" },
    ];

    for (const { fetch: fetchImpl, label } of scenarios) {
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

      if (result.isErr()) {
        const error = result._unsafeUnwrapErr() as { message: string };
        expect(error.message).not.toContain(FAKE_TOKEN);
      }
      // Suppress unused variable warning for `label`
      void label;
    }
  });
});

// ---------------------------------------------------------------------------
// Empty file list — fail-closed behavior (Issue 3 fix)
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — empty publishable file list", () => {
  it("returns err(PublishFailed) when fileNames contains only raw/ files (all filtered out)", async () => {
    const { fetchImpl } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      // Only raw/ files — all will be filtered out, leaving 0 publishable files
      fileNames: [
        "raw/case-loom-route-backend-api-model-2026-06-11T12-00-00Z.json",
        "raw/prompt-loom-2026-06-11T12-00-00Z.json",
      ],
      env: makeEnvWithToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("PublishFailed");
    // Error message must not contain the token
    expect(error.message).not.toContain(FAKE_TOKEN);
    // Error message should mention no publishable files
    expect(error.message).toContain("No publishable files");
  });

  it("returns err(PublishFailed) when fileNames is an empty array", async () => {
    const { fetchImpl } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    const result = await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: [],
      env: makeEnvWithToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ResultsRepoError;
    expect(error.type).toBe("PublishFailed");
    expect(error.message).not.toContain(FAKE_TOKEN);
  });

  it("makes no fetch calls when all files are filtered out", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: LOCAL_BUNDLE_DIR,
      fileNames: ["raw/only-raw-file.json"],
      env: makeEnvWithToken(),
    });

    // No network calls when there are no publishable files
    const putRequests = requests.filter((r) => r.method === "PUT");
    expect(putRequests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Path separator handling (Issue 4 fix)
// ---------------------------------------------------------------------------

describe("GitHubContentsPublisher — path separator handling", () => {
  it("excludes files with Windows-style 'raw\\' separator", async () => {
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
        "raw\\case-windows-style.json", // Windows-style separator
        "run-summary.json",
        "raw\\prompt-windows-style.json", // Windows-style separator
      ],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    // Only safe files should be uploaded (bundle-index.json, run-summary.json)
    expect(putRequests.length).toBe(2);
    for (const req of putRequests) {
      expect(req.url).not.toContain("raw");
      expect(req.url).not.toContain("windows-style");
    }
  });

  it("uses basename() for bundleDirName extraction on POSIX paths", async () => {
    const { fetchImpl, requests } = makeSuccessFetch();
    const publisher = new GitHubContentsPublisher(
      fetchImpl,
      makeStubFileReader(),
    );

    const posixBundleDir = "/workspace/eval-bundles/abc1234-2026-06-11";
    await publisher.publish({
      bundle: makeEvalBundle(),
      localBundleDir: posixBundleDir,
      fileNames: ["bundle-index.json"],
      env: makeEnvWithToken(),
    });

    const putRequests = requests.filter((r) => r.method === "PUT");
    // URL must contain runs/abc1234-2026-06-11/ (basename extracted correctly)
    for (const req of putRequests) {
      expect(req.url).toContain("runs/abc1234-2026-06-11/");
    }
  });
});
