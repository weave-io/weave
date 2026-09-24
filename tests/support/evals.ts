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
import { err, ok, okAsync, ResultAsync } from "neverthrow";
import { printRunReport } from "../../packages/cli/src/commands/eval.js";
import type { CliError } from "../../packages/cli/src/errors.js";
import type { EvalTrack } from "../../packages/cli/src/evals/eval-track.js";
import type { EvalRunRequest } from "../../packages/cli/src/evals/input-validation.js";
import {
  type FetchLike,
  JevJudge,
} from "../../packages/cli/src/evals/jev-judge.js";
import {
  type JudgeInput,
  type JudgeOutput,
  LangChainAgentEvalsScorer,
  type LangChainJudge,
  StubLangChainJudge,
} from "../../packages/cli/src/evals/langchain-agent-evals.js";
import type {
  ModelClientError,
  ModelRequest,
} from "../../packages/cli/src/evals/openrouter-client.js";
import { StubModelClient } from "../../packages/cli/src/evals/openrouter-client.js";
import type {
  JudgeIdentity,
  PublicReportBundle,
} from "../../packages/cli/src/evals/report-schema.js";
import type { PublishBundleRequest } from "../../packages/cli/src/evals/results-repo.js";
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
import { BufferTerminal } from "../../packages/cli/src/io/terminal.js";
import { ThemeManager } from "../../packages/cli/src/theme/colors.js";

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
    failedCases: caseResults.filter(
      (c) => !c.summary.passed && c.summary.errored !== true,
    ).length,
    erroredCases: caseResults.filter((c) => c.summary.errored === true).length,
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
  /**
   * Omit `allowed_models` from the fixture, so the loader fills it from
   * `evals/model-matrix.json` — the default set plus the dev subset — as it
   * does for every ordinary case in the corpus.
   */
  inheritModels?: boolean;
  /** The rubric's `scoring.required`. Defaults to `true`. */
  required?: boolean;
  /**
   * The rubric's `scoring.outcome_weight` — how much the case's primary
   * structural dimension counts toward the weighted total. Defaults to `0.7`.
   */
  outcomeWeight?: number;
  /**
   * The rubric's `scoring.per_expectation_weight` — how much rationale
   * quality counts toward the weighted total. Defaults to `0.3`.
   */
  perExpectationWeight?: number;
  /**
   * The `case_id` written *inside* the rubric file, when it should differ
   * from the file name. The scorer looks a rubric up by this field, so a
   * value that does not match `id` is how a scenario reaches the
   * no-rubric-for-this-case path with the file still present and valid.
   */
  rubricCaseId?: string;
  /** Writes the case fixture with no rubric file beside it. */
  withoutRubric?: boolean;
  /** The rubric's `scoring.notes` (reviewer notes the judge reads). */
  notes?: string;
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
            ...(spec.inheritModels === true
              ? {}
              : { allowed_models: spec.allowedModels ?? [EVAL_MODEL] }),
            expected_outcome: spec.expectedOutcome,
            accepted_alternates: spec.acceptedAlternates ?? [],
            transcript_expectations: spec.transcriptExpectations ?? [],
            tags: spec.tags ?? [],
          },
          null,
          2,
        ),
      );
      if (spec.withoutRubric === true) {
        continue;
      }
      await Bun.write(
        join(root, "rubrics", spec.suite, `${spec.id}.json`),
        JSON.stringify(
          {
            case_id: spec.rubricCaseId ?? spec.id,
            suite: spec.suite,
            scoring: {
              outcome_weight: spec.outcomeWeight ?? 0.7,
              per_expectation_weight: spec.perExpectationWeight ?? 0.3,
              required: spec.required ?? true,
              ...(spec.notes !== undefined ? { notes: spec.notes } : {}),
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
  /**
   * `--agent`. A suite ID selects exactly one suite; omitted selects every
   * suite (the fixture root decides which have cases).
   */
  agent?: string;
  /** The answers the model gives, in order. The last one repeats. */
  answers?: string[];
  /** Returned by the model instead of an answer. */
  modelError?: ModelClientError;
  /**
   * Returned by the model's first calls, in order, before it gives
   * `answers` (or `modelError`). How a scenario has a model come back empty
   * once and answer when asked again.
   */
  modelErrorsFirst?: ModelClientError[];
  /**
   * Run in publish mode, handing the run to a stub results repository that
   * only records what it receives (see `SuiteRunObservation.published`).
   */
  publish?: boolean;
  /**
   * Put the production judge, `JevJudge`, behind the scorer, with this
   * `fetch` standing in for OpenRouter's decisions endpoint. The run then
   * records `JEV_TEST_JUDGE` as its judge. Takes precedence over every
   * other judge option.
   */
  decisionsEndpoint?: FetchLike;
  /** The judge's verdict on every dimension it is asked to score. */
  judgeOutput?: JudgeOutput;
  /**
   * The judge's verdict per dimension, for a scenario that needs the primary
   * structural dimension and rationale quality scored differently.
   *
   * A dimension with no entry falls back to `judgeOutput`. Dimensions the
   * scorer decides itself — routing on every case, execution on a `judgment`
   * case — never reach the judge, so an entry for one of those is ignored.
   */
  judgeOutputs?: Partial<Record<ScoringDimension, JudgeOutput>>;
  /** Returned by the judge instead of a verdict. */
  judgeError?: ScoringError;
  /**
   * Returned by the judge instead of a verdict, for the named dimensions
   * only. Every other dimension is answered from `judgeOutputs` or
   * `judgeOutput`, so a scenario can fail one of the two questions a case
   * puts to the judge and leave the other answered.
   */
  judgeErrors?: Partial<Record<ScoringDimension, ScoringError>>;
  /** The composed system prompt the runner sends. */
  systemPrompt?: string;
  /** When set, prompt composition fails and no model is ever called. */
  promptProviderFails?: string;
  /** `--case`. */
  caseFilter?: string;
  /** `--model`. Defaults to `EVAL_MODEL`. */
  model?: string;
  /**
   * Omit `--model`, so the run fans out over every default model in
   * `evals/model-matrix.json`. The model still answers as `model`.
   */
  wholeMatrix?: boolean;
  /**
   * `--models <set>`. Like `wholeMatrix`, omits `--model`, so the run fans
   * out over the named set of `evals/model-matrix.json`.
   */
  modelSet?: "default" | "dev";
  /** `--dry-run`. */
  dryRun?: boolean;
  /** `--repeat`. Omitted means each case runs once. */
  repeat?: number;
  /** `--track`. Omitted runs text-only and trajectory cases alike. */
  track?: EvalTrack;
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
    erroredCases: number;
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
  /** The parsed `public-report.json`, or `null` when none was written. */
  publicReport: PublicReportBundle | null;
  /** The parsed `bundle-index.json`, or `null` when none was written. */
  bundleIndex: Record<string, unknown> | null;
  /** The parsed `provenance-manifest.json`, or `null` when none was written. */
  provenanceManifest: Record<string, unknown> | null;
  /** How many runs a publish-mode run handed to the results repository. */
  published: number;
  /** The text of `public-report.md`, or `null` when none was written. */
  markdown: string | null;
  /**
   * The dashboard index files at the bundle root (`dashboard-manifest.json`,
   * `latest.json`, `suite-history-<suite>.json`, …), parsed, keyed by name.
   */
  indexes: Record<string, unknown>;
  /** Raw artifacts, written only under `--raw-artifacts`. */
  rawArtifacts: RawCaseResultArtifact[];
  /** Every request the runner made to the model. */
  modelCalls: ModelRequest[];
  /** Every dimension the runner asked the judge to score. */
  judgeCalls: JudgeInput[];
  /** The concatenated text of every written file. */
  publishedText: string;
  /**
   * What `weave eval run` printed to stdout — the run report, uncoloured.
   * Read before the bundle root is removed, so paths in it can be checked
   * against `files`. `bundleRoot` is where those paths point.
   */
  stdout: string;
  /** The temporary bundle root the run wrote to (removed by now). */
  bundleRoot: string;
}

/** One row of a published `score-<suite>.json`. */
export type PublishedCaseRow = BundleScoreFile["results"][number];

/**
 * A judge that answers differently per dimension.
 *
 * `StubLangChainJudge` answers in call order, which couples a scenario to the
 * order the scorer happens to fire its dimensions in. Keying on the dimension
 * says what the scenario means: "the judge thought the chain was half right
 * and the prose was fine". Like `StubLangChainJudge` it stands in for an
 * external service — the LLM — and never for the scorer under test.
 */
class PerDimensionJudge implements LangChainJudge {
  readonly calls: JudgeInput[] = [];

  constructor(
    private readonly outputs: Partial<Record<ScoringDimension, JudgeOutput>>,
    private readonly errors: Partial<Record<ScoringDimension, ScoringError>>,
    private readonly fallback: JudgeOutput,
  ) {}

  evaluate(input: JudgeInput): ResultAsync<JudgeOutput, ScoringError> {
    this.calls.push(input);
    const failure = this.errors[input.dimension];
    if (failure !== undefined) {
      return new ResultAsync(
        Promise.resolve(err<JudgeOutput, ScoringError>(failure)),
      );
    }
    return ResultAsync.fromSafePromise(
      Promise.resolve(this.outputs[input.dimension] ?? this.fallback),
    );
  }
}

/** The judge a scenario's run records when it runs `JevJudge`. */
export const JEV_TEST_JUDGE: JudgeIdentity = {
  id: "typesafe/jev-1.13",
  version: "typesafe/jev-1.13-20260917",
};

/**
 * Records what the scorer asked, then asks `JevJudge` — the production
 * judge — so a scenario sees both the judge's inputs and the HTTP requests
 * it made to the stubbed decisions endpoint.
 */
class RecordingJevJudge implements LangChainJudge {
  readonly calls: JudgeInput[] = [];
  private readonly inner: JevJudge;

  constructor(fetchImpl: FetchLike) {
    this.inner = new JevJudge({
      apiKey: "test-key",
      judge: JEV_TEST_JUDGE,
      fetch: fetchImpl,
    });
  }

  evaluate(input: JudgeInput): ResultAsync<JudgeOutput, ScoringError> {
    this.calls.push(input);
    return this.inner.evaluate(input);
  }
}

/** The judge a run puts behind the real scorer. */
function buildJudge(
  options: SuiteRunOptions,
): LangChainJudge & { readonly calls: JudgeInput[] } {
  if (options.decisionsEndpoint !== undefined) {
    return new RecordingJevJudge(options.decisionsEndpoint);
  }
  const fallback = options.judgeOutput ?? {
    score: 1,
    rationale: "judge rationale",
  };
  if (options.judgeOutputs !== undefined || options.judgeErrors !== undefined) {
    return new PerDimensionJudge(
      options.judgeOutputs ?? {},
      options.judgeErrors ?? {},
      fallback,
    );
  }
  const judge = new StubLangChainJudge();
  if (options.judgeError !== undefined) {
    judge.setDefaultError(options.judgeError);
    return judge;
  }
  judge.setDefaultOutput(fallback);
  return judge;
}

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
  for (const failure of options.modelErrorsFirst ?? []) {
    modelClient.enqueueError(failure);
  }
  if (options.modelError !== undefined) {
    modelClient.setDefaultError(options.modelError);
  } else {
    const answers = options.answers ?? [""];
    for (const content of answers) {
      modelClient.enqueueResponse({ model, content });
    }
    modelClient.setDefaultResponse({ model, content: answers.at(-1) ?? "" });
  }

  const judge = buildJudge(options);

  const promptProvider: PromptProvider =
    options.promptProviderFails !== undefined
      ? failingPromptProvider(options.promptProviderFails)
      : {
          getPrompt: (agentName: string) =>
            ResultAsync.fromSafePromise<string, ProvenanceError>(
              Promise.resolve(options.systemPrompt ?? `You are ${agentName}.`),
            ),
        };

  // Publish mode hands the run to a stub results repository that only
  // records what it was given; nothing leaves the machine.
  const published: PublishBundleRequest[] = [];
  const publishing =
    options.publish === true
      ? {
          publishMode: "publish" as const,
          publisher: {
            publish(publishRequest: PublishBundleRequest) {
              published.push(publishRequest);
              return okAsync({
                commitSha: null,
                branch: "main",
                filesPublished: publishRequest.fileNames?.length ?? 0,
                simulated: true,
              });
            },
          },
        }
      : {};
  const baseEnv = options.env ?? { OPENROUTER_API_KEY: "test-key" };

  const orchestrator = new EvalOrchestrator({
    modelClient,
    scorer: new LangChainAgentEvalsScorer(judge),
    ...(options.decisionsEndpoint !== undefined
      ? { judge: JEV_TEST_JUDGE }
      : {}),
    promptProvider,
    snapshotProvider: { getSnapshots: () => Promise.resolve([]) },
    gitShaProvider: { resolveGitSha: () => ok(FIXED_GIT_SHA) },
    bundleRoot,
    ...publishing,
    env:
      options.publish === true
        ? { ...baseEnv, EVAL_RESULTS_REPO_TOKEN: "test-repo-token" }
        : baseEnv,
    evalsRoot: options.evalsRoot,
    assembledAt: FIXED_TIMESTAMP,
    // The preflight resolves Loom's composed delegation targets from the
    // developer's own config and validates the real fixture corpus against
    // them. A scenario brings its own corpus, so it is stubbed out here;
    // `loom-delegation-matrix.test.ts` is what covers the preflight itself.
    loomDelegationMatrixPreflight: () =>
      ResultAsync.fromSafePromise(Promise.resolve([])),
  });

  const request: EvalRunRequest = {
    agent: options.agent,
    model:
      options.wholeMatrix === true || options.modelSet !== undefined
        ? undefined
        : model,
    ...(options.modelSet !== undefined ? { modelSet: options.modelSet } : {}),
    case: options.caseFilter,
    ...(options.repeat !== undefined ? { repeat: options.repeat } : {}),
    ...(options.track !== undefined ? { track: options.track } : {}),
    dryRun: options.dryRun ?? false,
    rawArtifacts: options.rawArtifacts ?? false,
  };

  const runResult = await orchestrator.run(request);
  const summary = runResult.isOk() ? runResult.value : null;
  const error = runResult.isErr() ? runResult.error : null;
  const terminal = new BufferTerminal();
  const exitCode = await buildEvalRunnerExitCode(runResult, request, terminal);

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
  const reportPath = absolute.find((path) =>
    path.endsWith("/public-report.json"),
  );
  const markdownPath = absolute.find((path) =>
    path.endsWith("/public-report.md"),
  );
  const publicReport =
    reportPath !== undefined
      ? ((await Bun.file(reportPath).json()) as PublicReportBundle)
      : null;
  const indexPath = absolute.find((path) =>
    path.endsWith("/bundle-index.json"),
  );
  const bundleIndex =
    indexPath !== undefined
      ? ((await Bun.file(indexPath).json()) as Record<string, unknown>)
      : null;
  const manifestPath = absolute.find((path) =>
    path.endsWith("/provenance-manifest.json"),
  );
  const provenanceManifestFile =
    manifestPath !== undefined
      ? ((await Bun.file(manifestPath).json()) as Record<string, unknown>)
      : null;
  const markdown =
    markdownPath !== undefined ? await Bun.file(markdownPath).text() : null;
  const indexes: Record<string, unknown> = {};
  for (const path of absolute) {
    const name = relative(bundleRoot, path);
    if (name.includes("/") || !name.endsWith(".json")) continue;
    indexes[name] = await Bun.file(path).json();
  }

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
    publicReport,
    bundleIndex,
    provenanceManifest: provenanceManifestFile,
    published: published.length,
    markdown,
    indexes,
    rawArtifacts,
    modelCalls: modelClient.calls,
    judgeCalls: judge.calls,
    publishedText,
    stdout: terminal.out.join("\n"),
    bundleRoot,
  };
}

/**
 * The exit code the CLI turns this run into, and what it prints.
 *
 * `buildEvalRunner` is the adapter `commands/eval.ts` wraps the orchestrator
 * in, and its mapping — a partial failure is a non-zero exit, a merely red
 * suite is not — is the promise a CI job depends on. It is handed the same
 * run reporter `commands/eval.ts` gives a live run, writing to `terminal`.
 */
async function buildEvalRunnerExitCode(
  runResult: Awaited<ReturnType<EvalOrchestrator["run"]>>,
  request: EvalRunRequest,
  terminal: BufferTerminal,
): Promise<number> {
  const orchestrator = {
    run: () => new ResultAsync(Promise.resolve(runResult)),
  } as unknown as EvalOrchestrator;
  const plain = new ThemeManager({ isTty: () => false }).getTheme(false);
  const result = await buildEvalRunner(
    orchestrator,
    () => {},
    printRunReport(terminal, plain),
  )(request);
  return result.isOk() ? result.value : 1;
}
