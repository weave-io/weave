/**
 * Tests for `results-repo.ts`.
 *
 * Verifies:
 *   - `validatePublishToken()` returns ok when token is present and non-empty.
 *   - `validatePublishToken()` returns err(TokenMissing) when token is absent.
 *   - `validatePublishToken()` returns err(TokenMissing) when token is whitespace-only.
 *   - `validateRepoConfig()` returns ok for valid HTTPS URLs.
 *   - `validateRepoConfig()` returns err(RepoConfigInvalid) for non-HTTPS URLs.
 *   - `enforcePublishPolicy()` returns err(DryRunPublishBlocked) for dry-run bundles.
 *   - `enforcePublishPolicy()` returns err(UnsanitizedBundleBlocked) when bundle
 *     JSON contains sensitive fields (belt-and-suspenders check).
 *   - `NoOpResultsRepoPublisher.publish()` enforces the same policy as the real publisher.
 *   - `NoOpResultsRepoPublisher.publish()` records all calls.
 *   - `StubResultsRepoPublisher.publish()` returns configured responses in FIFO order.
 *   - `StubResultsRepoPublisher.publish()` returns default result when queue is exhausted.
 *   - `StubResultsRepoPublisher.publish()` returns PublishFailed when nothing is configured.
 *   - `EVAL_RESULTS_REPO_TOKEN_ENV_VAR` is the constant name for the token env var.
 *
 * Test isolation:
 *   - No real git, network, or shell calls.
 *   - All fixtures are constructed inline.
 *   - Injected `env` mocks avoid reading real `Bun.env`.
 */

import { describe, expect, it } from "bun:test";
import { EVAL_RESULTS_REPO_TOKEN_ENV_VAR } from "../artifact-bundle.js";
import {
  enforcePublishPolicy,
  NoOpResultsRepoPublisher,
  type PublishBundleRequest,
  type PublishBundleResult,
  StubResultsRepoPublisher,
  validatePublishToken,
  validateRepoConfig,
} from "../results-repo.js";
import type {
  EvalBundle,
  ResultsRepoConfig,
  ResultsRepoError,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const FIXED_GIT_SHA = "abc123def456abc123def456abc123def456abc1";
const FIXED_TIMESTAMP = "2026-01-15T12:00:00.000Z";

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
    promptHashRecords: [
      {
        agentName: "loom",
        hash: "a".repeat(64),
        byteLength: 4096,
        charLength: 4000,
        summary: 'Agent "loom": 1 source(s)…',
      },
    ],
    provenanceRef: null,
    ...overrides,
  };
}

function makePublishRequest(
  overrides: Partial<PublishBundleRequest> = {},
): PublishBundleRequest {
  return {
    bundle: makeEvalBundle(),
    localBundleDir: "/tmp/local-bundle",
    fileNames: ["bundle-index.json", "score-loom-routing.json"],
    env: { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "test-token-value" },
    ...overrides,
  };
}

function makePublishResult(): PublishBundleResult {
  return {
    commitSha: `def456abc${"0".repeat(31)}`,
    branch: "main",
    filesPublished: 5,
    simulated: false,
  };
}

// ---------------------------------------------------------------------------
// EVAL_RESULTS_REPO_TOKEN_ENV_VAR
// ---------------------------------------------------------------------------

describe("EVAL_RESULTS_REPO_TOKEN_ENV_VAR", () => {
  it("is the expected constant name", () => {
    expect(EVAL_RESULTS_REPO_TOKEN_ENV_VAR).toBe("EVAL_RESULTS_REPO_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// validatePublishToken
// ---------------------------------------------------------------------------

describe("validatePublishToken", () => {
  it("returns ok when token is present and non-empty", async () => {
    const env = { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "my-secret-token" };
    const result = await validatePublishToken(env);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("my-secret-token");
  });

  it("returns err(TokenMissing) when env var is absent", async () => {
    const env: Record<string, string | undefined> = {};
    const result = await validatePublishToken(env);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("TokenMissing");
    if (error.type === "TokenMissing") {
      expect(error.envVar).toBe(EVAL_RESULTS_REPO_TOKEN_ENV_VAR);
    }
  });

  it("returns err(TokenMissing) when env var is empty string", async () => {
    const env = { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "" };
    const result = await validatePublishToken(env);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("TokenMissing");
  });

  it("returns err(TokenMissing) when env var is whitespace-only", async () => {
    const env = { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "   " };
    const result = await validatePublishToken(env);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("TokenMissing");
  });

  it("trims whitespace from token value", async () => {
    const env = { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "  my-token  " };
    const result = await validatePublishToken(env);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("my-token");
  });

  it("error message does not include the token value", async () => {
    const env: Record<string, string | undefined> = {};
    const result = await validatePublishToken(env);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    // Message should reference the env var name, not any token value
    expect(error.message).toContain(EVAL_RESULTS_REPO_TOKEN_ENV_VAR);
  });
});

// ---------------------------------------------------------------------------
// validateRepoConfig
// ---------------------------------------------------------------------------

describe("validateRepoConfig", () => {
  it("returns ok for a valid https:// URL", async () => {
    const config: ResultsRepoConfig = {
      repoUrl: "https://github.com/weave-ai/eval-results",
    };
    const result = await validateRepoConfig(config);
    expect(result.isOk()).toBe(true);
  });

  it("returns err(RepoConfigInvalid) for http:// URL", async () => {
    const config: ResultsRepoConfig = {
      repoUrl: "http://github.com/weave-ai/eval-results",
    };
    const result = await validateRepoConfig(config);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RepoConfigInvalid");
  });

  it("returns err(RepoConfigInvalid) for SSH URL", async () => {
    const config: ResultsRepoConfig = {
      repoUrl: "git@github.com:weave-ai/eval-results.git",
    };
    const result = await validateRepoConfig(config);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RepoConfigInvalid");
  });

  it("returns err(RepoConfigInvalid) for a relative path", async () => {
    const config: ResultsRepoConfig = { repoUrl: "../some/relative/path" };
    const result = await validateRepoConfig(config);
    expect(result.isErr()).toBe(true);
  });

  it("returns err(RepoConfigInvalid) for an empty URL", async () => {
    const config: ResultsRepoConfig = { repoUrl: "" };
    const result = await validateRepoConfig(config);
    expect(result.isErr()).toBe(true);
  });

  it("error message does not include the raw repoUrl value", async () => {
    const config: ResultsRepoConfig = {
      repoUrl: "http://insecure.example.com/repo",
    };
    const result = await validateRepoConfig(config);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    // Must not include any fragment of the raw repoUrl value
    expect(error.message).not.toContain("insecure.example.com");
    expect(error.message).not.toContain("http://insecure");
    // Must reference the field name, not the value
    expect(error.message).toContain("repoUrl");
  });
});

// ---------------------------------------------------------------------------
// enforcePublishPolicy
// ---------------------------------------------------------------------------

describe("enforcePublishPolicy", () => {
  it("returns ok for a valid, non-dry-run bundle with score files", async () => {
    const bundle = makeEvalBundle();
    const result = await enforcePublishPolicy(bundle);
    expect(result.isOk()).toBe(true);
  });

  it("returns err(DryRunPublishBlocked) for a dry-run bundle", async () => {
    const bundle = makeEvalBundle({ dryRun: true });
    const result = await enforcePublishPolicy(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("DryRunPublishBlocked");
  });

  it("returns err(NoScoreFilesToPublish) for a non-dry-run bundle with no score files", async () => {
    const bundle = makeEvalBundle({ scoreFiles: [] });
    const result = await enforcePublishPolicy(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("NoScoreFilesToPublish");
  });

  it("returns err(UnsanitizedBundleBlocked) when bundle contains composedPrompt", async () => {
    // Inject an unsanitized field directly into the bundle object
    const bundle = makeEvalBundle();
    (bundle as unknown as Record<string, unknown>).composedPrompt =
      "You are Loom...";

    const result = await enforcePublishPolicy(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("UnsanitizedBundleBlocked");
    if (error.type === "UnsanitizedBundleBlocked") {
      expect(error.field).toBe("composedPrompt");
    }
  });

  it("returns err(UnsanitizedBundleBlocked) when bundle contains rationale", async () => {
    const bundle = makeEvalBundle();
    (bundle as unknown as Record<string, unknown>).rationale =
      "The model was correct because...";

    const result = await enforcePublishPolicy(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("UnsanitizedBundleBlocked");
  });

  it("returns err(UnsanitizedBundleBlocked) when bundle contains transcript", async () => {
    const bundle = makeEvalBundle();
    (bundle as unknown as Record<string, unknown>).transcript = [];

    const result = await enforcePublishPolicy(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("UnsanitizedBundleBlocked");
  });

  it("dry-run check takes priority over no-score-files check", async () => {
    // A dry-run bundle with no score files should return DryRunPublishBlocked, not NoScoreFilesToPublish
    const bundle = makeEvalBundle({ dryRun: true, scoreFiles: [] });
    const result = await enforcePublishPolicy(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("DryRunPublishBlocked");
  });

  it("NoScoreFilesToPublish error message does not include raw bundle content", async () => {
    const bundle = makeEvalBundle({ scoreFiles: [] });
    const result = await enforcePublishPolicy(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.message).toContain("score file");
    // Must not contain any raw bundle field values (no repoUrl, no token)
    expect(error.message).not.toContain(FIXED_GIT_SHA);
  });

  it("DryRunPublishBlocked error message does not include raw bundle content", async () => {
    const bundle = makeEvalBundle({ dryRun: true });
    const result = await enforcePublishPolicy(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.message).toContain("dry");
    expect(error.message).not.toContain(FIXED_GIT_SHA);
  });
});

// ---------------------------------------------------------------------------
// NoOpResultsRepoPublisher
// ---------------------------------------------------------------------------

describe("NoOpResultsRepoPublisher", () => {
  it("records publish calls", async () => {
    const publisher = new NoOpResultsRepoPublisher();
    const request = makePublishRequest();

    await publisher.publish(request);
    expect(publisher.publishCalls).toHaveLength(1);
    expect(publisher.publishCalls[0]).toBe(request);
  });

  it("returns a simulated publish result", async () => {
    const publisher = new NoOpResultsRepoPublisher();
    const request = makePublishRequest();

    const result = await publisher.publish(request);
    expect(result.isOk()).toBe(true);
    const publishResult = result._unsafeUnwrap();
    expect(publishResult.simulated).toBe(true);
  });

  it("returns err(TokenMissing) when env var is absent", async () => {
    const publisher = new NoOpResultsRepoPublisher();
    const request = makePublishRequest({ env: {} });

    const result = await publisher.publish(request);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("TokenMissing");
  });

  it("returns err when bundle is a dry-run", async () => {
    const publisher = new NoOpResultsRepoPublisher();
    const request = makePublishRequest({
      bundle: makeEvalBundle({ dryRun: true }),
    });

    const result = await publisher.publish(request);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("DryRunPublishBlocked");
  });

  it("result.filesPublished matches request.fileNames.length", async () => {
    const publisher = new NoOpResultsRepoPublisher();
    const request = makePublishRequest({
      fileNames: ["a.json", "b.json", "c.json"],
    });

    const result = await publisher.publish(request);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().filesPublished).toBe(3);
  });

  it("records all calls even when they fail", async () => {
    const publisher = new NoOpResultsRepoPublisher();

    // First call: dry-run bundle (will fail)
    await publisher.publish(
      makePublishRequest({ bundle: makeEvalBundle({ dryRun: true }) }),
    );
    // Second call: valid bundle (will succeed)
    await publisher.publish(makePublishRequest());

    expect(publisher.publishCalls).toHaveLength(2);
  });

  it("returns err(NoScoreFilesToPublish) when bundle has no score files", async () => {
    const publisher = new NoOpResultsRepoPublisher();
    const request = makePublishRequest({
      bundle: makeEvalBundle({ scoreFiles: [] }),
    });

    const result = await publisher.publish(request);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("NoScoreFilesToPublish");
  });
});

// ---------------------------------------------------------------------------
// StubResultsRepoPublisher
// ---------------------------------------------------------------------------

describe("StubResultsRepoPublisher", () => {
  it("returns configured success result from queue", async () => {
    const stub = new StubResultsRepoPublisher();
    const expectedResult = makePublishResult();
    stub.enqueueSuccess(expectedResult);

    const result = await stub.publish(makePublishRequest());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(expectedResult);
  });

  it("returns configured error result from queue", async () => {
    const stub = new StubResultsRepoPublisher();
    const expectedError: ResultsRepoError = {
      type: "PublishFailed",
      message: "Simulated publish failure",
    };
    stub.enqueueError(expectedError);

    const result = await stub.publish(makePublishRequest());
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(expectedError);
  });

  it("consumes queue in FIFO order", async () => {
    const stub = new StubResultsRepoPublisher();
    const r1 = makePublishResult();
    const r2 = { ...makePublishResult(), filesPublished: 99 };
    stub.enqueueSuccess(r1);
    stub.enqueueSuccess(r2);

    const res1 = await stub.publish(makePublishRequest());
    const res2 = await stub.publish(makePublishRequest());

    expect(res1._unsafeUnwrap()).toBe(r1);
    expect(res2._unsafeUnwrap()).toBe(r2);
  });

  it("falls back to defaultSuccess when queue is exhausted", async () => {
    const stub = new StubResultsRepoPublisher();
    const defaultResult = makePublishResult();
    stub.setDefaultSuccess(defaultResult);

    // Queue is empty — uses default
    const result = await stub.publish(makePublishRequest());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(defaultResult);
  });

  it("falls back to defaultError when queue is exhausted", async () => {
    const stub = new StubResultsRepoPublisher();
    const defaultError: ResultsRepoError = {
      type: "PublishFailed",
      message: "default error",
    };
    stub.setDefaultError(defaultError);

    const result = await stub.publish(makePublishRequest());
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(defaultError);
  });

  it("returns PublishFailed when queue is empty and no default is set", async () => {
    const stub = new StubResultsRepoPublisher();

    const result = await stub.publish(makePublishRequest());
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PublishFailed");
  });

  it("records all calls", async () => {
    const stub = new StubResultsRepoPublisher();
    stub.setDefaultSuccess(makePublishResult());

    await stub.publish(makePublishRequest());
    await stub.publish(makePublishRequest());
    await stub.publish(makePublishRequest());

    expect(stub.calls).toHaveLength(3);
  });

  it("records call details", async () => {
    const stub = new StubResultsRepoPublisher();
    stub.setDefaultSuccess(makePublishResult());

    const request = makePublishRequest({ localBundleDir: "/my/local/bundle" });
    await stub.publish(request);

    expect(stub.calls[0]).toBe(request);
  });

  it("queue entry is consumed after use", async () => {
    const stub = new StubResultsRepoPublisher();
    const r1 = makePublishResult();
    stub.enqueueSuccess(r1);
    stub.setDefaultError({
      type: "PublishFailed",
      message: "after queue exhausted",
    });

    const first = await stub.publish(makePublishRequest());
    const second = await stub.publish(makePublishRequest());

    expect(first.isOk()).toBe(true);
    expect(second.isErr()).toBe(true); // falls to default error
  });
});
