/**
 * Shared harness for the evals scenario bucket.
 *
 * The black box here is the **published bundle**: eval results go in, and the
 * files a reader (or tryweave.io) would find on disk come out. Scenarios assert
 * what those files contain, never how the sanitizer or the assembler got there.
 *
 * Unlike the adapter bucket this writes to a real directory, because
 * `ArtifactBundleWriter` owns its own I/O. It is a per-test temporary directory
 * under the OS temp root — never the developer's config or working tree — and
 * it is removed afterwards.
 */

import { expect } from "bun:test";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { err, ok, ResultAsync } from "neverthrow";
import type { CliError } from "../../packages/cli/src/errors.js";
import {
  type JudgeInput,
  type JudgeOutput,
  LangChainAgentEvalsScorer,
  StubLangChainJudge,
} from "../../packages/cli/src/evals/langchain-agent-evals.js";
import type {
  ModelClientError,
  ModelRequest,
} from "../../packages/cli/src/evals/openrouter-client.js";
import { StubModelClient } from "../../packages/cli/src/evals/openrouter-client.js";
import {
  buildEvalRunner,
  EvalOrchestrator,
} from "../../packages/cli/src/evals/runner.js";
import type {
  BundleScoreFile,
  CaseResult,
  PromptProvenanceManifest,
  PromptProvider,
  ProvenanceError,
  RawCaseResultArtifact,
  RunnerError,
  RunnerResult,
  ScoringDimension,
  ScoringError,
} from "../../packages/cli/src/evals/types.js";

export const FIXED_GIT_SHA = "abc123def456abc123def456abc123def456abc1";
export const FIXED_TIMESTAMP = "2026-01-15T12:00:00.000Z";

/**
 * Every field name the publish guard treats as sensitive, with a value that is
 * unmistakable if it ever reaches a published file.
 *
 * Scenarios feed these in deliberately: the promise is that a bundle assembled
 * from results carrying them still publishes nothing recognisable.
 */
export const LEAK_MARKERS = {
  composedPrompt: "LEAK-composed-prompt-should-never-publish",
  rawContent: "LEAK-raw-content-should-never-publish",
  rawPrompt: "LEAK-raw-prompt-should-never-publish",
  transcript: "LEAK-transcript-should-never-publish",
} as const;

function dimensionScores(
  passed: boolean,
): Record<ScoringDimension, { score: number; applicable: boolean }> {
  return {
    routingCorrectness: { score: passed ? 1 : 0, applicable: true },
    delegationCorrectness: { score: 1, applicable: false },
    executionCompleteness: { score: 1, applicable: false },
    rationaleQuality: { score: 0.8, applicable: true },
  };
}

/** A case result as a runner produces it. */
export function caseResult(
  overrides: Partial<CaseResult["summary"]> = {},
  extra: Partial<CaseResult> = {},
): CaseResult {
  const passed = overrides.passed ?? true;
  return {
    summary: {
      caseId: "route-to-shuttle",
      modelId: "anthropic/claude-sonnet-4.5",
      suite: "loom-routing",
      passed,
      required: true,
      weightedTotal: passed ? 0.9 : 0,
      dimensionScores: dimensionScores(passed),
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
      ...overrides,
    },
    ...extra,
  };
}

/** A suite's worth of results. */
export function runnerResult(
  overrides: Partial<RunnerResult> = {},
): RunnerResult {
  const caseResults = overrides.caseResults ?? [caseResult()];
  return {
    suite: "loom-routing",
    suiteGreen: caseResults.every((c) => c.summary.passed),
    caseResults,
    totalCases: caseResults.length,
    passedCases: caseResults.filter((c) => c.summary.passed).length,
    failedCases: caseResults.filter((c) => !c.summary.passed).length,
    completedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

/** A provenance manifest covering the named agents. */
export function provenanceManifest(
  agents: string[] = ["loom", "tapestry", "shuttle"],
): PromptProvenanceManifest {
  return {
    version: 1,
    producedAt: FIXED_TIMESTAMP,
    gitSha: FIXED_GIT_SHA,
    records: agents.map((agentName) => ({
      agentName,
      hash: "a".repeat(64),
      byteLength: 4096,
      charLength: 4000,
      sources: [{ kind: "builtin" as const, layer: "primary" as const }],
      summary: `Agent "${agentName}": 1 source(s) [builtin primary]`,
      gitSha: FIXED_GIT_SHA,
      capturedAt: FIXED_TIMESTAMP,
    })),
  };
}

/** Runs `body` with a fresh temporary bundle root, removed afterwards. */
/**
 * A unique temporary directory path.
 *
 * `AGENTS.md` forbids the Node `fs` runtime surface, so this does not call
 * `mkdtemp`. `Bun.write()` creates parent directories on demand, so the
 * directory comes into being with the first file written into it — the same
 * pattern the adapters' own tests use.
 */
function tempProjectPath(prefix: string): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return join(tmpdir(), `${prefix}${unique}`);
}

/**
 * Creates a directory, parents included, through Bun's process API.
 *
 * `Bun.write()` makes parents on demand, so this is only needed where a
 * directory must exist *before* anything writes into it — the bundle writer
 * expects its root to be there already.
 */
async function makeDir(dir: string): Promise<void> {
  const proc = Bun.spawn(["mkdir", "-p", dir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/** Removes a directory tree through Bun's process API rather than `node:fs`. */
async function removeTree(dir: string): Promise<void> {
  const proc = Bun.spawn(["rm", "-rf", dir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

export async function withBundleRoot<T>(
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = tempProjectPath("weave-evals-scenario-");
  // The writer expects its root to exist. Create it rather than seeding a file,
  // so `filesUnder()` sees only what the writer actually wrote.
  await makeDir(root);
  try {
    return await body(root);
  } finally {
    await removeTree(root);
  }
}

/** Every file under `dir`, as absolute paths. */
export async function filesUnder(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const found: string[] = [];
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
    found.push(join(dir, rel));
  }
  return found.sort();
}

/** The concatenated text of every file under `dir`. */
export async function allPublishedText(dir: string): Promise<string> {
  const paths = await filesUnder(dir);
  const parts = await Promise.all(paths.map((p) => Bun.file(p).text()));
  return parts.join("\n");
}

/**
 * Fails with the offending file named, rather than a bare boolean, when any
 * published file contains `needle`.
 */
export async function expectNothingPublishedContains(
  dir: string,
  needle: string,
): Promise<void> {
  for (const path of await filesUnder(dir)) {
    const text = await Bun.file(path).text();
    if (text.includes(needle)) {
      expect(`${path} contains ${needle}`).toBe(
        "no published file contains it",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Suite runners — one run of `weave eval run`, start to finish
// ---------------------------------------------------------------------------

/**
 * The model a suite-runner scenario asks for.
 *
 * A fixture naming a single model is a deliberate exception the loader allows;
 * one that restates the matrix defaults is rejected, so scenarios name this.
 */
export const EVAL_MODEL = "anthropic/claude-sonnet-4.5";

/** A case fixture and its rubric, as a scenario declares them. */
export interface FixtureSpec {
  /** Case ID — the fixture file name and the `--case` filter value. */
  id: string;
  /** Suite ID, e.g. `"loom-routing"`. */
  suite: string;
  /** The task text the runner puts to the model. */
  description: string;
  /** Agents the case may name. Checked against `KNOWN_AGENTS` at load. */
  allowedAgents: string[];
  /** The `expected_outcome` block, exactly as a fixture file carries it. */
  expectedOutcome: Record<string, unknown>;
  acceptedAlternates?: string[];
  transcriptExpectations?: Array<Record<string, unknown>>;
  tags?: string[];
  /** Models the case allows. Defaults to `[EVAL_MODEL]`. */
  allowedModels?: string[];
  /** The rubric's `scoring.required`. Defaults to `true`. */
  required?: boolean;
}

/**
 * Runs `body` against a temporary `evals/` root holding exactly `fixtures`.
 *
 * The corpus under `evals/` is repo-owned and changes with the product; a
 * scenario asserting how one answer scores needs a corpus it controls. The
 * model matrix stays the repo's own — `loadModelMatrix()` reads it from a
 * fixed path — so the models a case may run on are the real ones.
 */
export async function withEvalFixtures<T>(
  fixtures: FixtureSpec[],
  body: (evalsRoot: string) => Promise<T>,
): Promise<T> {
  const root = tempProjectPath("weave-evals-fixtures-");
  try {
    for (const spec of fixtures) {
      // No mkdir: `Bun.write()` creates the parent directories for each file
      // below, which is what keeps this off the Node `fs` surface AGENTS.md
      // forbids.
      await Bun.write(
        join(root, "cases", spec.suite, `${spec.id}.json`),
        JSON.stringify(
          {
            id: spec.id,
            description: spec.description,
            suite: spec.suite,
            allowed_agents: spec.allowedAgents,
            allowed_models: spec.allowedModels ?? [EVAL_MODEL],
            expected_outcome: spec.expectedOutcome,
            accepted_alternates: spec.acceptedAlternates ?? [],
            transcript_expectations: spec.transcriptExpectations ?? [],
            tags: spec.tags ?? [],
          },
          null,
          2,
        ),
      );
      await Bun.write(
        join(root, "rubrics", spec.suite, `${spec.id}.json`),
        JSON.stringify(
          {
            case_id: spec.id,
            suite: spec.suite,
            scoring: {
              outcome_weight: 0.7,
              per_expectation_weight: 0.3,
              required: spec.required ?? true,
            },
          },
          null,
          2,
        ),
      );
    }
    return await body(root);
  } finally {
    await removeTree(root);
  }
}

/** What a scenario asks `weave eval run` to do. */
export interface SuiteRunOptions {
  /** The fixture root from `withEvalFixtures`. */
  evalsRoot: string;
  /** `--agent`. A suite ID selects exactly one suite. */
  agent: string;
  /** The answers the model gives, in order. The last one repeats. */
  answers?: string[];
  /** Returned by the model instead of an answer. */
  modelError?: ModelClientError;
  /** The judge's verdict on every dimension it is asked to score. */
  judgeOutput?: JudgeOutput;
  /** Returned by the judge instead of a verdict. */
  judgeError?: ScoringError;
  /** The composed system prompt the runner sends. */
  systemPrompt?: string;
  /** When set, prompt composition fails and no model is ever called. */
  promptProviderFails?: string;
  /** `--case`. */
  caseFilter?: string;
  /** `--model`. Defaults to `EVAL_MODEL`. */
  model?: string;
  /** `--dry-run`. */
  dryRun?: boolean;
  /** `--raw-artifacts`. */
  rawArtifacts?: boolean;
  /** The environment the run reads. Defaults to a fake API key. */
  env?: Record<string, string | undefined>;
}

/** Everything a run left behind, read back before its directory is removed. */
export interface SuiteRunObservation {
  /** The exit code `weave eval run` returns for this run. */
  exitCode: number;
  /** The error the run failed with before producing anything, or `null`. */
  error: CliError | null;
  /** Suites that could not run at all. */
  partialFailures: RunnerError[];
  /** Per-suite totals, as the run summary reports them. */
  rollups: Array<{
    suite: string;
    totalCases: number;
    passedCases: number;
    failedCases: number;
    suiteGreen: boolean;
  }>;
  /** Every file under the bundle root, relative to it. */
  files: string[];
  /** The parsed `score-<suite>.json`, or `null` when none was written. */
  scoreFile: BundleScoreFile | null;
  /**
   * The case summaries the score file carries.
   *
   * This is the published row type, which is looser than `CaseResultSummary`:
   * `BundleScoreFileSchema` does not require `suite` on a row, although every
   * runner puts one there.
   */
  cases: PublishedCaseRow[];
  /** The first case summary — what a single-case scenario asked about. */
  firstCase: PublishedCaseRow | null;
  /** Raw artifacts, written only under `--raw-artifacts`. */
  rawArtifacts: RawCaseResultArtifact[];
  /** Every request the runner made to the model. */
  modelCalls: ModelRequest[];
  /** Every dimension the runner asked the judge to score. */
  judgeCalls: JudgeInput[];
  /** The concatenated text of every written file. */
  publishedText: string;
}

/** One row of a published `score-<suite>.json`. */
export type PublishedCaseRow = BundleScoreFile["results"][number];

/** A prompt provider whose composition always fails, carrying `marker`. */
function failingPromptProvider(marker: string): PromptProvider {
  return {
    getPrompt: (agentName: string) =>
      new ResultAsync<string, ProvenanceError>(
        Promise.resolve(
          err({
            type: "PromptCompositionError" as const,
            agentName,
            message: marker,
          }),
        ),
      ),
  };
}

/**
 * Runs one suite the way `weave eval run` runs it, and returns what it left
 * on disk.
 *
 * The seam is `EvalOrchestrator` + `buildEvalRunner` — what
 * `packages/cli/src/commands/eval.ts` builds once it has an API key. The
 * model and the judge are the two external services, so those are stubbed and
 * nothing else is: fixture loading, signal extraction, scoring, bundle
 * assembly and artifact writing are all the product's own code.
 *
 * The bundle goes to a fresh temporary root, is read back, and is removed, so
 * a scenario asserts on file contents without owning a directory.
 */
export async function runEvalSuite(
  options: SuiteRunOptions,
): Promise<SuiteRunObservation> {
  const model = options.model ?? EVAL_MODEL;
  const bundleRoot = tempProjectPath("weave-evals-run-");
  await makeDir(bundleRoot);

  const modelClient = new StubModelClient();
  if (options.modelError !== undefined) {
    modelClient.setDefaultError(options.modelError);
  } else {
    const answers = options.answers ?? [""];
    for (const content of answers) {
      modelClient.enqueueResponse({ model, content });
    }
    modelClient.setDefaultResponse({ model, content: answers.at(-1) ?? "" });
  }

  const judge = new StubLangChainJudge();
  if (options.judgeError !== undefined) {
    judge.setDefaultError(options.judgeError);
  } else {
    judge.setDefaultOutput(
      options.judgeOutput ?? { score: 1, rationale: "judge rationale" },
    );
  }

  const promptProvider: PromptProvider =
    options.promptProviderFails !== undefined
      ? failingPromptProvider(options.promptProviderFails)
      : {
          getPrompt: (agentName: string) =>
            ResultAsync.fromSafePromise<string, ProvenanceError>(
              Promise.resolve(options.systemPrompt ?? `You are ${agentName}.`),
            ),
        };

  const orchestrator = new EvalOrchestrator({
    modelClient,
    scorer: new LangChainAgentEvalsScorer(judge),
    promptProvider,
    snapshotProvider: { getSnapshots: () => Promise.resolve([]) },
    gitShaProvider: { resolveGitSha: () => ok(FIXED_GIT_SHA) },
    bundleRoot,
    env: options.env ?? { OPENROUTER_API_KEY: "test-key" },
    evalsRoot: options.evalsRoot,
    assembledAt: FIXED_TIMESTAMP,
    // The preflight resolves Loom's composed delegation targets from the
    // developer's own config and validates the real fixture corpus against
    // them. A scenario brings its own corpus, so it is stubbed out here;
    // `loom-delegation-matrix.test.ts` is what covers the preflight itself.
    loomDelegationMatrixPreflight: () =>
      ResultAsync.fromSafePromise(Promise.resolve([])),
  });

  const request = {
    agent: options.agent,
    model,
    case: options.caseFilter,
    dryRun: options.dryRun ?? false,
    rawArtifacts: options.rawArtifacts ?? false,
  };

  const runResult = await orchestrator.run(request);
  const summary = runResult.isOk() ? runResult.value : null;
  const error = runResult.isErr() ? runResult.error : null;
  const exitCode = await buildEvalRunnerExitCode(runResult);

  const absolute = await filesUnder(bundleRoot);
  const files = absolute.map((path) => relative(bundleRoot, path));
  const scorePaths = absolute.filter((path) => /score-[^/]+\.json$/.test(path));
  const rawPaths = absolute.filter((path) => /\/raw\/case-/.test(path));
  const scoreFiles: BundleScoreFile[] = [];
  for (const path of scorePaths) {
    scoreFiles.push((await Bun.file(path).json()) as BundleScoreFile);
  }
  const rawArtifacts: RawCaseResultArtifact[] = [];
  for (const path of rawPaths) {
    rawArtifacts.push((await Bun.file(path).json()) as RawCaseResultArtifact);
  }
  const publishedText = await allPublishedText(bundleRoot);

  await removeTree(bundleRoot);

  const scoreFile = scoreFiles[0] ?? null;
  const cases: PublishedCaseRow[] = scoreFile?.results ?? [];

  return {
    exitCode,
    error,
    partialFailures: summary?.partialFailures ?? [],
    rollups: summary?.agentRollups ?? [],
    files,
    scoreFile,
    cases,
    firstCase: cases[0] ?? null,
    rawArtifacts,
    modelCalls: modelClient.calls,
    judgeCalls: judge.calls,
    publishedText,
  };
}

/**
 * The exit code the CLI turns this run into.
 *
 * `buildEvalRunner` is the adapter `commands/eval.ts` wraps the orchestrator
 * in, and its mapping — a partial failure is a non-zero exit, a merely red
 * suite is not — is the promise a CI job depends on.
 */
async function buildEvalRunnerExitCode(
  runResult: Awaited<ReturnType<EvalOrchestrator["run"]>>,
): Promise<number> {
  const orchestrator = {
    run: () => new ResultAsync(Promise.resolve(runResult)),
  } as unknown as EvalOrchestrator;
  const result = await buildEvalRunner(orchestrator)({
    agent: undefined,
    model: undefined,
    case: undefined,
    dryRun: false,
    rawArtifacts: false,
  });
  return result.isOk() ? result.value : 1;
}
