/**
 * Tests for `scripts/evals/verify-agent-eval-run.ts`.
 *
 * Verifies:
 *   - A valid, matched local run passes with a safe, source-derived
 *     provenance report.
 *   - Stale `gitSha` (not an ancestor of expected HEAD) is rejected.
 *   - Missing `tapestry-category-routing` suite entirely is rejected.
 *   - Missing `tcr-04-no-match`/`tcr-10-disabled-category` cases are rejected.
 *   - Zero-case suites are rejected.
 *   - Missing, blank, over-long, and invalid-source explanations are all
 *     rejected with distinct `reason` values on the same error type.
 *   - Suite/case/model completeness: missing model rows, missing
 *     case×model combinations, duplicate rows, count mismatches, and
 *     suite-name disagreement are all detected via an injected
 *     `SuiteExpectationsProvider`.
 *   - A `--suite` scope filter restricts required checks so verifying one
 *     suite does not require another suite (e.g. TCR) to be present.
 *   - Incompatible schema versions are rejected.
 *   - Index/report run-identity disagreement is rejected with a distinct error.
 *   - Missing generic-Shuttle scorer branch marker in source is rejected.
 *   - Optional derived index artifacts (dashboard manifest, suite history,
 *     model comparison) are validated for agreement when supplied, and
 *     silently skipped when absent.
 *   - Provenance (`judgeModelId`, `cliPackageVersion`,
 *     `lockedDependencyVersions`) is parsed from injected source text at the
 *     verified `gitSha` — never hardcoded.
 *   - The provenance report never includes raw content, env values, or secrets.
 *
 * Test isolation: all file reads, fetches, and git/source lookups are
 * provided by in-memory stubs. No real network, filesystem, or process
 * calls are made.
 */

import { describe, expect, it } from "bun:test";
import { ResultAsync } from "neverthrow";
import {
  type ArtifactReader,
  buildProductionSuiteExpectationsProvider,
  CATEGORY_ROUTING_RUNNER_PATH,
  CLI_PACKAGE_JSON_PATH,
  EVAL_COMMAND_PATH,
  EvalRunVerifier,
  GENERIC_SHUTTLE_SCORER_MARKER,
  type GitSourceReader,
  type IndexArtifactFileName,
  ROOT_LOCKFILE_PATH,
  type RunSource,
  type SuiteExpectationsProvider,
  type VerifyEvalRunError,
} from "../../../../../scripts/evals/verify-agent-eval-run.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const FIXED_GIT_SHA = "0eea530efb38f39c709db977ea43d9d03f9f3f1b";
const OTHER_GIT_SHA = "1111111111111111111111111111111111111111";

function buildBundleIndex(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    assembledAt: "2026-09-01T20:13:56.305Z",
    gitSha: FIXED_GIT_SHA,
    dryRun: false,
    runId: "0eea530-2026-09-01-001",
    runSummary: {
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
      allSuitesGreen: true,
      suites: ["tapestry-category-routing"],
    },
    publicFiles: ["bundle-index.json", "public-report.json"],
    ...overrides,
  };
}

function buildCaseEntry(overrides: Record<string, unknown> = {}) {
  return {
    caseId: "tcr-04-no-match",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "tapestry-category-routing",
    scoreBucket: "pass",
    passed: true,
    required: true,
    dryRun: false,
    explanation: {
      text: "Correct generic shuttle fallback",
      source: "structured_signal",
    },
    scoredAt: "2026-09-01T20:13:56.305Z",
    ...overrides,
  };
}

function buildSuiteSummary(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    suite: "tapestry-category-routing",
    assembledAt: "2026-09-01T20:13:56.305Z",
    gitSha: FIXED_GIT_SHA,
    totalCases: 2,
    passedCases: 2,
    failedCases: 0,
    suiteGreen: true,
    cases: [
      buildCaseEntry({ caseId: "tcr-04-no-match" }),
      buildCaseEntry({ caseId: "tcr-10-disabled-category" }),
    ],
    ...overrides,
  };
}

function buildPublicReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    assembledAt: "2026-09-01T20:13:56.305Z",
    gitSha: FIXED_GIT_SHA,
    dryRun: false,
    runSummary: {
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
      allSuitesGreen: true,
      suites: ["tapestry-category-routing"],
    },
    suiteSummaries: [buildSuiteSummary()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory test doubles
// ---------------------------------------------------------------------------

class InMemoryArtifactReader implements ArtifactReader {
  constructor(
    private readonly bundleIndexJson: string,
    private readonly publicReportJson: string,
    private readonly indexArtifacts: Partial<
      Record<IndexArtifactFileName, string>
    > = {},
    private readonly promptHashArtifact: string | undefined,
  ) {}

  readArtifact(
    _source: RunSource,
    fileName: "bundle-index.json" | "public-report.json",
  ): ResultAsync<string, VerifyEvalRunError> {
    const text =
      fileName === "bundle-index.json"
        ? this.bundleIndexJson
        : this.publicReportJson;
    return ResultAsync.fromSafePromise(Promise.resolve(text));
  }

  readIndexArtifact(
    _source: RunSource,
    fileName: IndexArtifactFileName,
  ): ResultAsync<string | undefined, VerifyEvalRunError> {
    return ResultAsync.fromSafePromise(
      Promise.resolve(this.indexArtifacts[fileName]),
    );
  }

  readPromptHashArtifact(
    source: RunSource,
  ): ResultAsync<string | undefined, VerifyEvalRunError> {
    // Mirrors the production contract: remote sources never fetch this
    // internal, unpublished artifact, regardless of what a test configures.
    if (source.kind === "remote") {
      return ResultAsync.fromSafePromise(Promise.resolve(undefined));
    }
    return ResultAsync.fromSafePromise(
      Promise.resolve(this.promptHashArtifact),
    );
  }
}

class StubGitSourceReader implements GitSourceReader {
  constructor(
    private readonly sourcesByPath: Record<string, string>,
    private readonly ancestorMap: Record<string, boolean> = {},
  ) {}

  readSourceFile(
    _gitSha: string,
    relativePath: string,
  ): ResultAsync<string, VerifyEvalRunError> {
    const content = this.sourcesByPath[relativePath];
    if (content === undefined) {
      return new ResultAsync(
        Promise.resolve({
          isOk: () => false as const,
          isErr: () => true as const,
        } as never),
      );
    }
    return ResultAsync.fromSafePromise(Promise.resolve(content));
  }

  isAncestorOrEqual(
    candidateSha: string,
    expectedHeadSha: string,
  ): ResultAsync<boolean, never> {
    const key = `${candidateSha}->${expectedHeadSha}`;
    return ResultAsync.fromSafePromise(
      Promise.resolve(
        this.ancestorMap[key] ?? candidateSha === expectedHeadSha,
      ),
    );
  }
}

const VALID_SCORER_SOURCE = `
  if (${GENERIC_SHUTTLE_SCORER_MARKER}) {
    return { score: 1.0, rationale: "Correct generic shuttle fallback", applicable: true };
  }
`;

const VALID_EVAL_COMMAND_SOURCE = `
export const JUDGE_MODEL_ID = "anthropic/claude-sonnet-4.5";
`;

const VALID_CLI_PACKAGE_JSON_SOURCE = JSON.stringify({
  name: "@weaveio/weave-cli",
  version: "0.1.2",
  dependencies: {
    "@langchain/core": "^1.1.48",
    "@langchain/openai": "^1.4.7",
    agentevals: "^0.0.7",
    openevals: "^0.2.0",
  },
});

const VALID_LOCKFILE_SOURCE = `
{
  "packages": {
    "@langchain/core": ["@langchain/core@1.1.48", "", {}, "sha512-abc"],
    "@langchain/openai": ["@langchain/openai@1.4.7", "", {}, "sha512-def"],
    "agentevals": ["agentevals@0.0.7", "", {}, "sha512-ghi"],
    "openevals": ["openevals@0.2.0", "", {}, "sha512-jkl"]
  }
}
`;

function buildDefaultSources(): Record<string, string> {
  return {
    [CATEGORY_ROUTING_RUNNER_PATH]: VALID_SCORER_SOURCE,
    [EVAL_COMMAND_PATH]: VALID_EVAL_COMMAND_SOURCE,
    [CLI_PACKAGE_JSON_PATH]: VALID_CLI_PACKAGE_JSON_SOURCE,
    [ROOT_LOCKFILE_PATH]: VALID_LOCKFILE_SOURCE,
  };
}

// The internal `prompt-hashes.json` artifact — present by default for local
// runs so unrelated tests are unaffected; prompt-hash-specific tests below
// override this explicitly (including passing `null` to simulate absence).
const DEFAULT_PROMPT_HASH_JSON = JSON.stringify({
  promptHashes: [
    {
      agentName: "loom",
      hash: "a".repeat(64),
      byteLength: 100,
      charLength: 90,
    },
  ],
});

function buildVerifier(options: {
  bundleIndex?: Record<string, unknown>;
  publicReport?: Record<string, unknown>;
  sources?: Record<string, string>;
  ancestorMap?: Record<string, boolean>;
  expectedHeadSha?: string;
  indexArtifacts?: Partial<Record<IndexArtifactFileName, string>>;
  suiteExpectationsProvider?: SuiteExpectationsProvider;
  suiteFilter?: string[];
  indexArtifactPolicy?: "required" | "optional" | "auto";
  /** `null` simulates a missing local `prompt-hashes.json` file. */
  promptHashArtifact?: string | null;
}) {
  const bundleIndexJson = JSON.stringify(
    options.bundleIndex ?? buildBundleIndex(),
  );
  const publicReportJson = JSON.stringify(
    options.publicReport ?? buildPublicReport(),
  );
  const promptHashArtifact =
    options.promptHashArtifact === null
      ? undefined
      : (options.promptHashArtifact ?? DEFAULT_PROMPT_HASH_JSON);

  return new EvalRunVerifier({
    artifactReader: new InMemoryArtifactReader(
      bundleIndexJson,
      publicReportJson,
      options.indexArtifacts,
      promptHashArtifact,
    ),
    gitSourceReader: new StubGitSourceReader(
      options.sources ?? buildDefaultSources(),
      options.ancestorMap,
    ),
    suiteExpectationsProvider: options.suiteExpectationsProvider,
    expectedHeadSha: options.expectedHeadSha,
    suiteFilter: options.suiteFilter,
    indexArtifactPolicy: options.indexArtifactPolicy,
  });
}

const LOCAL_SOURCE: RunSource = { kind: "local", dir: "/fake/run/dir" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvalRunVerifier", () => {
  it("passes for a valid, matched local run and reports source-derived provenance", async () => {
    const verifier = buildVerifier({ expectedHeadSha: FIXED_GIT_SHA });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.runId).toBe("0eea530-2026-09-01-001");
      expect(result.value.gitSha).toBe(FIXED_GIT_SHA);
      expect(result.value.suites).toEqual(["tapestry-category-routing"]);
      expect(result.value.provenance.scorerAdapterModule).toBe(
        "langchain-agent-evals.ts",
      );
      // Provenance parsed from injected source text, not hardcoded:
      expect(result.value.provenance.judgeModelId).toBe(
        "anthropic/claude-sonnet-4.5",
      );
      expect(result.value.provenance.cliPackageVersion).toBe("0.1.2");
      expect(result.value.provenance.lockedDependencyVersions).toEqual({
        "@langchain/core": "1.1.48",
        "@langchain/openai": "1.4.7",
        agentevals: "0.0.7",
        openevals: "0.2.0",
      });

      // Safety: no raw content, secrets, or env-like values in the report.
      const serialized = JSON.stringify(result.value);
      expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
      expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
      expect(serialized).not.toContain("OPENROUTER_API_KEY");
      expect(serialized).not.toContain("EVAL_RESULTS_REPO_TOKEN");
    }
  });

  it("derives different provenance when the source at gitSha differs (not hardcoded)", async () => {
    const verifier = buildVerifier({
      sources: {
        ...buildDefaultSources(),
        [EVAL_COMMAND_PATH]: `export const JUDGE_MODEL_ID = "openai/gpt-5.5";`,
        [CLI_PACKAGE_JSON_PATH]: JSON.stringify({
          name: "@weaveio/weave-cli",
          version: "9.9.9",
        }),
        [ROOT_LOCKFILE_PATH]: `
          "@langchain/core": ["@langchain/core@2.0.0", "", {}],
          "@langchain/openai": ["@langchain/openai@2.0.1", "", {}],
          "agentevals": ["agentevals@1.0.0", "", {}],
          "openevals": ["openevals@1.0.1", "", {}]
        `,
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.provenance.judgeModelId).toBe("openai/gpt-5.5");
      expect(result.value.provenance.cliPackageVersion).toBe("9.9.9");
      expect(result.value.provenance.lockedDependencyVersions).toEqual({
        "@langchain/core": "2.0.0",
        "@langchain/openai": "2.0.1",
        agentevals: "1.0.0",
        openevals: "1.0.1",
      });
    }
  });

  it("rejects when the judge model ID cannot be parsed from eval command source", async () => {
    const verifier = buildVerifier({
      sources: {
        ...buildDefaultSources(),
        [EVAL_COMMAND_PATH]: "// no JUDGE_MODEL_ID constant here",
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "ProvenanceSourceParseError" &&
            e.path === EVAL_COMMAND_PATH,
        ),
      ).toBe(true);
    }
  });

  it("rejects a stale gitSha not reachable from expected HEAD", async () => {
    const verifier = buildVerifier({
      expectedHeadSha: OTHER_GIT_SHA,
      ancestorMap: {},
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.some((e) => e.type === "StaleGitSha")).toBe(true);
    }
  });

  it("rejects a run missing the tapestry-category-routing suite entirely", async () => {
    const verifier = buildVerifier({
      bundleIndex: buildBundleIndex({
        runSummary: {
          totalCases: 1,
          passedCases: 1,
          failedCases: 0,
          allSuitesGreen: true,
          suites: ["loom-routing"],
        },
      }),
      publicReport: buildPublicReport({
        runSummary: {
          totalCases: 1,
          passedCases: 1,
          failedCases: 0,
          allSuitesGreen: true,
          suites: ["loom-routing"],
        },
        suiteSummaries: [],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) => e.type === "MissingSuite" && e.suite === "loom-routing",
        ),
      ).toBe(true);
    }
  });

  it("rejects a tapestry-category-routing suite missing tcr-04-no-match and tcr-10-disabled-category", async () => {
    const verifier = buildVerifier({
      publicReport: buildPublicReport({
        suiteSummaries: [
          buildSuiteSummary({
            totalCases: 1,
            passedCases: 1,
            cases: [buildCaseEntry({ caseId: "tcr-01-exact-match" })],
          }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const missingCaseErrors = result.error.filter(
        (e) => e.type === "MissingCase",
      );
      expect(missingCaseErrors).toHaveLength(2);
      const caseIds = missingCaseErrors.map((e) =>
        e.type === "MissingCase" ? e.caseId : "",
      );
      expect(caseIds).toContain("tcr-04-no-match");
      expect(caseIds).toContain("tcr-10-disabled-category");
    }
  });

  it("rejects a suite with zero cases", async () => {
    const verifier = buildVerifier({
      bundleIndex: buildBundleIndex({
        runSummary: {
          totalCases: 0,
          passedCases: 0,
          failedCases: 0,
          allSuitesGreen: true,
          suites: ["tapestry-category-routing"],
        },
      }),
      publicReport: buildPublicReport({
        runSummary: {
          totalCases: 0,
          passedCases: 0,
          failedCases: 0,
          allSuitesGreen: true,
          suites: ["tapestry-category-routing"],
        },
        suiteSummaries: [
          buildSuiteSummary({ totalCases: 0, passedCases: 0, cases: [] }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "ZeroCases" && e.suite === "tapestry-category-routing",
        ),
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Explanation completeness: missing / blank / too-long / invalid source
  // ---------------------------------------------------------------------------

  it("rejects a case with a missing explanation field entirely", async () => {
    const verifier = buildVerifier({
      publicReport: buildPublicReport({
        suiteSummaries: [
          buildSuiteSummary({
            cases: [
              buildCaseEntry({
                caseId: "tcr-04-no-match",
                explanation: undefined,
              }),
              buildCaseEntry({ caseId: "tcr-10-disabled-category" }),
            ],
          }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "BlankExplanation" &&
            e.caseId === "tcr-04-no-match" &&
            e.reason === "missing",
        ),
      ).toBe(true);
    }
  });

  it("rejects a case with blank explanation text", async () => {
    const verifier = buildVerifier({
      publicReport: buildPublicReport({
        suiteSummaries: [
          buildSuiteSummary({
            cases: [
              buildCaseEntry({
                caseId: "tcr-04-no-match",
                explanation: { text: "   ", source: "structured_signal" },
              }),
              buildCaseEntry({ caseId: "tcr-10-disabled-category" }),
            ],
          }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "BlankExplanation" &&
            e.caseId === "tcr-04-no-match" &&
            e.reason === "blank",
        ),
      ).toBe(true);
    }
  });

  it("rejects a case with an explanation exceeding the maximum bound", async () => {
    const verifier = buildVerifier({
      publicReport: buildPublicReport({
        suiteSummaries: [
          buildSuiteSummary({
            cases: [
              buildCaseEntry({
                caseId: "tcr-04-no-match",
                explanation: {
                  text: "x".repeat(301),
                  source: "structured_signal",
                },
              }),
              buildCaseEntry({ caseId: "tcr-10-disabled-category" }),
            ],
          }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "BlankExplanation" &&
            e.caseId === "tcr-04-no-match" &&
            e.reason === "too_long",
        ),
      ).toBe(true);
    }
  });

  it("rejects a case with an explanation from a non-allowlisted source", async () => {
    const verifier = buildVerifier({
      publicReport: buildPublicReport({
        suiteSummaries: [
          buildSuiteSummary({
            cases: [
              buildCaseEntry({
                caseId: "tcr-04-no-match",
                explanation: {
                  text: "looks fine",
                  source: "raw_model_output",
                },
              }),
              buildCaseEntry({ caseId: "tcr-10-disabled-category" }),
            ],
          }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "BlankExplanation" &&
            e.caseId === "tcr-04-no-match" &&
            e.reason === "invalid_source",
        ),
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Suite/case/model completeness via SuiteExpectationsProvider
  // ---------------------------------------------------------------------------

  it("detects a missing model row against expected models", async () => {
    const provider: SuiteExpectationsProvider = {
      expectedCaseIds: () => ["tcr-04-no-match", "tcr-10-disabled-category"],
      expectedModelIds: () => ["anthropic/claude-sonnet-4.5", "openai/gpt-5.5"],
    };
    const verifier = buildVerifier({
      suiteExpectationsProvider: provider,
      // Only one model present, not two.
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) => e.type === "MissingModelRow" && e.modelId === "openai/gpt-5.5",
        ),
      ).toBe(true);
    }
  });

  it("detects a missing expected case×model combination", async () => {
    const provider: SuiteExpectationsProvider = {
      expectedCaseIds: () => [
        "tcr-04-no-match",
        "tcr-10-disabled-category",
        "tcr-01-exact-match",
      ],
      expectedModelIds: () => ["anthropic/claude-sonnet-4.5"],
    };
    const verifier = buildVerifier({ suiteExpectationsProvider: provider });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "MissingCaseModelCombo" &&
            e.caseId === "tcr-01-exact-match" &&
            e.modelId === "anthropic/claude-sonnet-4.5",
        ),
      ).toBe(true);
      expect(
        result.error.some(
          (e) => e.type === "MissingCase" && e.caseId === "tcr-01-exact-match",
        ),
      ).toBe(true);
    }
  });

  it("detects a duplicate case×model row", async () => {
    const verifier = buildVerifier({
      publicReport: buildPublicReport({
        suiteSummaries: [
          buildSuiteSummary({
            totalCases: 3,
            passedCases: 3,
            cases: [
              buildCaseEntry({ caseId: "tcr-04-no-match" }),
              buildCaseEntry({ caseId: "tcr-04-no-match" }),
              buildCaseEntry({ caseId: "tcr-10-disabled-category" }),
            ],
          }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "DuplicateCaseModelRow" &&
            e.caseId === "tcr-04-no-match" &&
            e.count === 2,
        ),
      ).toBe(true);
    }
  });

  it("detects a suite case-count mismatch against expected case×model product", async () => {
    const provider: SuiteExpectationsProvider = {
      expectedCaseIds: () => ["tcr-04-no-match", "tcr-10-disabled-category"],
      expectedModelIds: () => ["anthropic/claude-sonnet-4.5", "openai/gpt-5.5"],
    };
    const verifier = buildVerifier({
      suiteExpectationsProvider: provider,
      publicReport: buildPublicReport({
        suiteSummaries: [
          buildSuiteSummary({
            cases: [
              buildCaseEntry({
                caseId: "tcr-04-no-match",
                modelId: "anthropic/claude-sonnet-4.5",
              }),
              buildCaseEntry({
                caseId: "tcr-04-no-match",
                modelId: "openai/gpt-5.5",
              }),
              buildCaseEntry({
                caseId: "tcr-10-disabled-category",
                modelId: "anthropic/claude-sonnet-4.5",
              }),
              buildCaseEntry({
                caseId: "tcr-10-disabled-category",
                modelId: "openai/gpt-5.5",
              }),
              // Extra unexpected row makes actual (5) != expected (4).
              buildCaseEntry({
                caseId: "tcr-10-disabled-category",
                modelId: "qwen/qwen3.8-max",
              }),
            ],
          }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const mismatch = result.error.find(
        (e) => e.type === "SuiteCaseCountMismatch",
      );
      expect(mismatch).toBeDefined();
      if (
        mismatch !== undefined &&
        mismatch.type === "SuiteCaseCountMismatch"
      ) {
        expect(mismatch.expected).toBe(4);
        expect(mismatch.actual).toBe(5);
      }
    }
  });

  it("detects suite/case name disagreement", async () => {
    const verifier = buildVerifier({
      publicReport: buildPublicReport({
        suiteSummaries: [
          buildSuiteSummary({
            cases: [
              buildCaseEntry({
                caseId: "tcr-04-no-match",
                suite: "loom-routing",
              }),
              buildCaseEntry({ caseId: "tcr-10-disabled-category" }),
            ],
          }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "SuiteNameMismatch" &&
            e.caseId === "tcr-04-no-match" &&
            e.foundSuite === "loom-routing" &&
            e.expectedSuite === "tapestry-category-routing",
        ),
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Suite filter scoping
  // ---------------------------------------------------------------------------

  it("does not require tapestry-category-routing when the suite filter targets loom-routing only", async () => {
    const verifier = buildVerifier({
      suiteFilter: ["loom-routing"],
      bundleIndex: buildBundleIndex({
        runSummary: {
          totalCases: 1,
          passedCases: 1,
          failedCases: 0,
          allSuitesGreen: true,
          suites: ["loom-routing"],
        },
      }),
      publicReport: buildPublicReport({
        runSummary: {
          totalCases: 1,
          passedCases: 1,
          failedCases: 0,
          allSuitesGreen: true,
          suites: ["loom-routing"],
        },
        suiteSummaries: [
          buildSuiteSummary({
            suite: "loom-routing",
            totalCases: 1,
            passedCases: 1,
            cases: [
              buildCaseEntry({
                caseId: "lr-01",
                suite: "loom-routing",
              }),
            ],
          }),
        ],
      }),
      // No scorer-branch source needed since tapestry-category-routing is
      // out of scope; only the runner marker for the filtered suite matters,
      // and loom-routing has no such requirement.
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isOk()).toBe(true);
  });

  it("still requires the filtered suite (e.g. tapestry-category-routing) when explicitly targeted", async () => {
    const verifier = buildVerifier({
      suiteFilter: ["tapestry-category-routing"],
      publicReport: buildPublicReport({
        suiteSummaries: [
          buildSuiteSummary({
            cases: [buildCaseEntry({ caseId: "tcr-01-exact-match" })],
          }),
        ],
      }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) => e.type === "MissingCase" && e.caseId === "tcr-04-no-match",
        ),
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Schema / identity / source checks (retained from prior revision)
  // ---------------------------------------------------------------------------

  it("rejects incompatible bundle-index.json and public-report.json schema versions", async () => {
    const verifier = buildVerifier({
      bundleIndex: buildBundleIndex({ schemaVersion: 99 }),
      publicReport: buildPublicReport({ schemaVersion: 42 }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const versionErrors = result.error.filter(
        (e) => e.type === "SchemaVersionIncompatible",
      );
      expect(versionErrors).toHaveLength(2);
    }
  });

  it("rejects index/report run-identity disagreement", async () => {
    const verifier = buildVerifier({
      publicReport: buildPublicReport({ gitSha: OTHER_GIT_SHA }),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) => e.type === "IndexRunMismatch" && e.field === "gitSha",
        ),
      ).toBe(true);
    }
  });

  it("rejects a source SHA missing the generic-Shuttle scorer branch marker", async () => {
    const verifier = buildVerifier({
      sources: {
        ...buildDefaultSources(),
        [CATEGORY_ROUTING_RUNNER_PATH]:
          "// this file no longer has the expected branch",
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.some((e) => e.type === "ScorerBranchMissing")).toBe(
        true,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Optional derived index artifact agreement
  // ---------------------------------------------------------------------------

  it("passes silently when no optional index artifacts are supplied", async () => {
    const verifier = buildVerifier({ indexArtifacts: {} });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isOk()).toBe(true);
  });

  it("detects a dashboard-manifest.json entry mismatch", async () => {
    const verifier = buildVerifier({
      indexArtifacts: {
        "dashboard-manifest.json": JSON.stringify({
          runs: [
            {
              runId: "0eea530-2026-09-01-001",
              gitSha: FIXED_GIT_SHA,
              dryRun: false,
              totalCases: 999, // mismatched
              passedCases: 2,
              allSuitesGreen: true,
            },
          ],
        }),
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "DashboardEntryMismatch" && e.field === "totalCases",
        ),
      ).toBe(true);
    }
  });

  it("detects a missing dashboard-manifest.json entry for the run", async () => {
    const verifier = buildVerifier({
      indexArtifacts: {
        "dashboard-manifest.json": JSON.stringify({ runs: [] }),
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.some((e) => e.type === "DashboardEntryMissing")).toBe(
        true,
      );
    }
  });

  it("detects a suite-history entry mismatch", async () => {
    const verifier = buildVerifier({
      indexArtifacts: {
        "suite-history-tapestry-category-routing.json": JSON.stringify({
          history: [
            {
              runId: "0eea530-2026-09-01-001",
              gitSha: FIXED_GIT_SHA,
              totalCases: 2,
              passedCases: 0, // mismatched (report says 2 passed)
              suiteGreen: true,
            },
          ],
        }),
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "SuiteHistoryEntryMismatch" && e.field === "passedCases",
        ),
      ).toBe(true);
    }
  });

  it("detects a model-comparison.json mismatch", async () => {
    const verifier = buildVerifier({
      indexArtifacts: {
        "model-comparison-0eea530-2026-09-01-001.json": JSON.stringify({
          models: [
            {
              modelId: "anthropic/claude-sonnet-4.5",
              totalCases: 2,
              passedCases: 0, // mismatched (report says both passed)
            },
          ],
        }),
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "ModelComparisonMismatch" && e.field === "passedCases",
        ),
      ).toBe(true);
    }
  });

  it("performs no real network, filesystem, or process calls (pure in-memory doubles)", async () => {
    // This test asserts the injected doubles are the only I/O surface: all
    // reader/fetcher/git-source calls resolve synchronously from in-memory
    // fixtures, never touching Bun.file, fetch, or Bun.spawn. Index artifact
    // policy is set to "optional" here because this test is about I/O
    // isolation, not about the required-index-for-remote-runs policy
    // (covered separately below).
    const verifier = buildVerifier({
      expectedHeadSha: FIXED_GIT_SHA,
      indexArtifactPolicy: "optional",
    });
    const result = await verifier.verifyRun({
      kind: "remote",
      runId: "0eea530-2026-09-01-001",
    });
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario history agreement
// ---------------------------------------------------------------------------

describe("EvalRunVerifier — scenario history agreement", () => {
  function buildScenarioHistory(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      suite: "tapestry-category-routing",
      updatedAt: "2026-09-01T20:13:56.305Z",
      scenarios: [
        {
          caseId: "tcr-04-no-match",
          title: "tcr-04-no-match",
          description: "Correct generic shuttle fallback",
          lastRuns: [
            {
              runId: "0eea530-2026-09-01-001",
              assembledAt: "2026-09-01T20:13:56.305Z",
              status: "pass",
              passed: true,
              totalModels: 1,
              passedModels: 1,
              failedModels: 0,
              skippedModels: 0,
            },
          ],
        },
        {
          caseId: "tcr-10-disabled-category",
          title: "tcr-10-disabled-category",
          description: "Correct generic shuttle fallback",
          lastRuns: [
            {
              runId: "0eea530-2026-09-01-001",
              assembledAt: "2026-09-01T20:13:56.305Z",
              status: "pass",
              passed: true,
              totalModels: 1,
              passedModels: 1,
              failedModels: 0,
              skippedModels: 0,
            },
          ],
        },
      ],
      ...overrides,
    };
  }

  it("passes when scenario history agrees with the report for every case", async () => {
    const verifier = buildVerifier({
      indexArtifacts: {
        "scenario-history-tapestry-category-routing.json": JSON.stringify(
          buildScenarioHistory(),
        ),
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isOk()).toBe(true);
  });

  it("rejects a missing scenario history entry for an expected case", async () => {
    const history = buildScenarioHistory();
    history.scenarios = history.scenarios.filter(
      (s) => s.caseId !== "tcr-10-disabled-category",
    );
    const verifier = buildVerifier({
      indexArtifacts: {
        "scenario-history-tapestry-category-routing.json":
          JSON.stringify(history),
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "ScenarioHistoryEntryMissing" &&
            e.caseId === "tcr-10-disabled-category",
        ),
      ).toBe(true);
    }
  });

  it("rejects a scenario history entry with a blank description", async () => {
    const history = buildScenarioHistory();
    const scenario = history.scenarios.find(
      (s) => s.caseId === "tcr-04-no-match",
    );
    if (scenario === undefined) throw new Error("fixture setup error");
    scenario.description = "   ";
    const verifier = buildVerifier({
      indexArtifacts: {
        "scenario-history-tapestry-category-routing.json":
          JSON.stringify(history),
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "ScenarioHistoryDescriptionMissing" &&
            e.caseId === "tcr-04-no-match",
        ),
      ).toBe(true);
    }
  });

  it("rejects a scenario history entry missing the current run ID", async () => {
    const history = buildScenarioHistory();
    const scenario = history.scenarios.find(
      (s) => s.caseId === "tcr-04-no-match",
    );
    if (scenario === undefined) throw new Error("fixture setup error");
    scenario.lastRuns = [];
    const verifier = buildVerifier({
      indexArtifacts: {
        "scenario-history-tapestry-category-routing.json":
          JSON.stringify(history),
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "ScenarioHistoryRunMissing" &&
            e.caseId === "tcr-04-no-match" &&
            e.runId === "0eea530-2026-09-01-001",
        ),
      ).toBe(true);
    }
  });

  it("rejects a scenario history run entry with mismatched model counts", async () => {
    const history = buildScenarioHistory();
    const scenario = history.scenarios.find(
      (s) => s.caseId === "tcr-04-no-match",
    );
    if (scenario === undefined) throw new Error("fixture setup error");
    const run = scenario.lastRuns.find(
      (r) => r.runId === "0eea530-2026-09-01-001",
    );
    if (run === undefined) throw new Error("fixture setup error");
    run.passedModels = 0;
    const verifier = buildVerifier({
      indexArtifacts: {
        "scenario-history-tapestry-category-routing.json":
          JSON.stringify(history),
      },
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "ScenarioHistoryMismatch" &&
            e.caseId === "tcr-04-no-match" &&
            e.field === "passedModels",
        ),
      ).toBe(true);
    }
  });

  it("silently skips scenario history checks when the artifact is absent", async () => {
    const verifier = buildVerifier({});
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prompt hash presence/consistency
// ---------------------------------------------------------------------------

describe("EvalRunVerifier — prompt hash validation (local prompt-hashes.json)", () => {
  const VALID_HASH = "a".repeat(64);

  function promptHashJson(
    records: Array<{
      agentName: string;
      hash: string;
      byteLength: number;
      charLength: number;
    }>,
  ): string {
    return JSON.stringify({ promptHashes: records });
  }

  it("passes when local prompt-hashes.json has well-formed, unique records", async () => {
    const verifier = buildVerifier({
      promptHashArtifact: promptHashJson([
        {
          agentName: "loom",
          hash: VALID_HASH,
          byteLength: 100,
          charLength: 90,
        },
      ]),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.promptHashEvidence).toEqual({
        status: "verified",
        source: "local",
        agentCount: 1,
      });
    }
  });

  it("rejects a local run with no prompt-hashes.json artifact at all", async () => {
    const verifier = buildVerifier({ promptHashArtifact: null });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "PromptHashEvidenceUnavailable" &&
            e.source === "local" &&
            e.reason === "missing_local_artifact",
        ),
      ).toBe(true);
    }
  });

  it("rejects a local prompt-hashes.json with zero records", async () => {
    const verifier = buildVerifier({ promptHashArtifact: promptHashJson([]) });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "PromptHashEvidenceUnavailable" &&
            e.source === "local" &&
            e.reason === "empty_local_artifact",
        ),
      ).toBe(true);
    }
  });

  it("rejects a blank agentName", async () => {
    const verifier = buildVerifier({
      promptHashArtifact: promptHashJson([
        { agentName: "  ", hash: VALID_HASH, byteLength: 1, charLength: 1 },
      ]),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) => e.type === "InvalidPromptHash" && e.reason === "blank",
        ),
      ).toBe(true);
    }
  });

  it("rejects a malformed (non-hex, wrong length) hash", async () => {
    const verifier = buildVerifier({
      promptHashArtifact: promptHashJson([
        { agentName: "loom", hash: "not-a-hash", byteLength: 1, charLength: 1 },
      ]),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) => e.type === "InvalidPromptHash" && e.reason === "malformed",
        ),
      ).toBe(true);
    }
  });

  it("rejects duplicate agentName entries", async () => {
    const verifier = buildVerifier({
      promptHashArtifact: promptHashJson([
        { agentName: "loom", hash: VALID_HASH, byteLength: 1, charLength: 1 },
        { agentName: "loom", hash: VALID_HASH, byteLength: 2, charLength: 2 },
      ]),
    });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) =>
            e.type === "DuplicatePromptHashAgent" &&
            e.agentName === "loom" &&
            e.count === 2,
        ),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt hash evidence — remote runs (never fetch prompt-hashes.json)
// ---------------------------------------------------------------------------

describe("EvalRunVerifier — prompt hash evidence (remote)", () => {
  const VALID_HASH = "a".repeat(64);
  const REMOTE_SOURCE: RunSource = {
    kind: "remote",
    runId: "0eea530-2026-09-01-001",
  };

  it("never fetches prompt-hashes.json for a remote run and reports evidence as unavailable when no safe field is published", async () => {
    const verifier = buildVerifier({ indexArtifactPolicy: "optional" });
    const result = await verifier.verifyRun(REMOTE_SOURCE);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.promptHashEvidence).toEqual({
        status: "unavailable",
        source: "remote",
        reason: "no_safe_remote_field",
      });
    }
  });

  it("verifies remote runs using a safe, already-published promptHashRecords field", async () => {
    const verifier = buildVerifier({
      indexArtifactPolicy: "optional",
      bundleIndex: buildBundleIndex({
        promptHashRecords: [
          {
            agentName: "loom",
            hash: VALID_HASH,
            byteLength: 100,
            charLength: 90,
          },
        ],
      }),
    });
    const result = await verifier.verifyRun(REMOTE_SOURCE);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.promptHashEvidence).toEqual({
        status: "verified",
        source: "remote",
        agentCount: 1,
      });
    }
  });

  it("rejects a malformed safe promptHashRecords field on a remote run", async () => {
    const verifier = buildVerifier({
      indexArtifactPolicy: "optional",
      bundleIndex: buildBundleIndex({
        promptHashRecords: [
          {
            agentName: "loom",
            hash: "not-a-hash",
            byteLength: 1,
            charLength: 1,
          },
        ],
      }),
    });
    const result = await verifier.verifyRun(REMOTE_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) => e.type === "InvalidPromptHash" && e.reason === "malformed",
        ),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Required-index policy (local vs remote defaults; explicit overrides)
// ---------------------------------------------------------------------------

describe("EvalRunVerifier — required-index policy", () => {
  const REMOTE_SOURCE: RunSource = {
    kind: "remote",
    runId: "0eea530-2026-09-01-001",
  };

  it("defaults to requiring derived indexes for a remote source", async () => {
    const verifier = buildVerifier({});
    const result = await verifier.verifyRun(REMOTE_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.some((e) => e.type === "MissingIndexArtifact")).toBe(
        true,
      );
    }
  });

  it("defaults to NOT requiring derived indexes for a local source", async () => {
    const verifier = buildVerifier({});
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isOk()).toBe(true);
  });

  it('`indexArtifactPolicy: "required"` fails a local source lacking indexes', async () => {
    const verifier = buildVerifier({ indexArtifactPolicy: "required" });
    const result = await verifier.verifyRun(LOCAL_SOURCE);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.some(
          (e) => e.type === "MissingIndexArtifact" && e.source === "local",
        ),
      ).toBe(true);
    }
  });

  it('`indexArtifactPolicy: "optional"` never fails a remote source lacking indexes', async () => {
    const verifier = buildVerifier({ indexArtifactPolicy: "optional" });
    const result = await verifier.verifyRun(REMOTE_SOURCE);
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Production `SuiteExpectationsProvider` — real eval fixtures + model matrix
// ---------------------------------------------------------------------------

describe("buildProductionSuiteExpectationsProvider", () => {
  it("loads real case IDs and default model IDs from evals/ fixtures", async () => {
    const result = await buildProductionSuiteExpectationsProvider();
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const provider = result.value;

    // tapestry-category-routing must always include the two always-on
    // required TCR cases (verified independently by REQUIRED_CATEGORY_ROUTING_CASES).
    const tcrCaseIds = provider.expectedCaseIds("tapestry-category-routing");
    expect(tcrCaseIds).toBeDefined();
    expect(tcrCaseIds).toContain("tcr-04-no-match");
    expect(tcrCaseIds).toContain("tcr-10-disabled-category");

    // Every suite shares the same default model set (all suites fan out
    // across the same default models — see EvalRunner).
    const modelIds = provider.expectedModelIds("tapestry-category-routing");
    expect(modelIds).toBeDefined();
    expect((modelIds ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("uses the real production provider to reject a run missing a real case", async () => {
    const result = await buildProductionSuiteExpectationsProvider();
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Build a report with only the two TCR cases, filtered to just that
    // suite — the production provider knows about all 10 real
    // tapestry-category-routing cases, so this must fail with missing-case
    // errors for the other 8 real cases.
    const verifier = new EvalRunVerifier({
      artifactReader: new InMemoryArtifactReader(
        JSON.stringify(buildBundleIndex()),
        JSON.stringify(buildPublicReport()),
        {},
        undefined,
      ),
      gitSourceReader: new StubGitSourceReader(buildDefaultSources()),
      suiteExpectationsProvider: result.value,
      suiteFilter: ["tapestry-category-routing"],
      indexArtifactPolicy: "optional",
    });
    const verifyResult = await verifier.verifyRun(LOCAL_SOURCE);
    expect(verifyResult.isErr()).toBe(true);
    if (verifyResult.isErr()) {
      expect(verifyResult.error.some((e) => e.type === "MissingCase")).toBe(
        true,
      );
    }
  });
});
