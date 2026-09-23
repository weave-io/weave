/**
 * Shared execution of `harness_trajectory` eval cases.
 *
 * Trajectory cases run a real sandboxed harness session instead of a single
 * chat completion, so they bypass a suite's text-only model client and
 * scorer. This module is the one place that turns an `EvalCase` into a
 * `TrajectoryCase`, runs it, and scores the observed event stream, so the
 * loom, shuttle, and tapestry runners behave identically (Spec 33, Spec 35).
 *
 * Real Podman and filesystem dependencies are only reached through the
 * lazily imported `opencode-trajectory-runner-adapter.ts`, never for
 * text-only suites or dry runs.
 */

import { join } from "node:path";
import type {
  TrajectoryCase,
  TrajectoryRunner,
  TrajectoryWorkspace,
} from "@weaveio/weave-core";
import { ok, okAsync, ResultAsync } from "neverthrow";
import { EVALS_ROOT } from "./case-loader.js";
import { buildPublicExplanation } from "./langchain-agent-evals.js";
import { scoreTrajectoryResult } from "./trajectory-scoring.js";
import type {
  CaseResult,
  CaseResultSummary,
  EvalCase,
  EvalRubric,
  NormalizedScoreRecord,
  RawCaseResultArtifact,
  RunnerError,
  ScoringDimension,
} from "./types.js";

/** Directory under the evals root that holds fixture projects (Spec 35). */
export const FIXTURES_DIRECTORY = "fixtures";

export interface TrajectoryCaseExecutorOptions {
  /** Injected runner (tests). When omitted, the production runner is built lazily. */
  trajectoryRunner?: TrajectoryRunner;
  /** Environment used to build the production runner (reads `OPENROUTER_API_KEY`). */
  env: Record<string, string | undefined>;
  /** Evals root used to resolve fixture directories. Defaults to `EVALS_ROOT`. */
  evalsRoot?: string;
  /** Label used in error messages, e.g. `"shuttle-trajectory-runner"`. */
  runnerLabel: string;
}

function isTrajectoryCase(evalCase: EvalCase): boolean {
  return evalCase.expected_outcome.kind === "harness_trajectory";
}

/** True when at least one work item is a `harness_trajectory` case. */
export function hasTrajectoryCases(
  items: ReadonlyArray<{ evalCase: EvalCase }>,
): boolean {
  return items.some((item) => isTrajectoryCase(item.evalCase));
}

function dimensionScoreSummary(
  dimensions: NormalizedScoreRecord["dimensions"],
): CaseResultSummary["dimensionScores"] {
  const summary = {} as CaseResultSummary["dimensionScores"];
  for (const [dimension, score] of Object.entries(dimensions) as Array<
    [ScoringDimension, NormalizedScoreRecord["dimensions"][ScoringDimension]]
  >) {
    summary[dimension] = { score: score.score, applicable: score.applicable };
  }
  return summary;
}

function dimensionRationales(
  dimensions: NormalizedScoreRecord["dimensions"],
): Partial<Record<ScoringDimension, string>> {
  const rationales: Partial<Record<ScoringDimension, string>> = {};
  for (const [dimension, score] of Object.entries(dimensions) as Array<
    [ScoringDimension, NormalizedScoreRecord["dimensions"][ScoringDimension]]
  >) {
    if (score.applicable) {
      rationales[dimension] = score.rationale;
    }
  }
  return rationales;
}

/**
 * Result for a trajectory case that could not run: errored, never scored
 * (see `case-outcomes.ts`). The error type is a bounded label; no raw error
 * text reaches the summary.
 */
function errorResult(
  evalCase: EvalCase,
  modelId: string,
  errorType: string,
  rawArtifacts: boolean,
  localDiagnostic?: string,
): CaseResult {
  const inapplicable = { score: 0, applicable: false };
  const summary: CaseResultSummary = {
    caseId: evalCase.id,
    modelId,
    suite: evalCase.suite,
    passed: false,
    required: true,
    weightedTotal: 0,
    dimensionScores: {
      routingCorrectness: inapplicable,
      delegationCorrectness: inapplicable,
      executionCompleteness: inapplicable,
      rationaleQuality: inapplicable,
    },
    scoredAt: new Date().toISOString(),
    dryRun: false,
    errored: true,
    errorClassification: `trajectory-${errorType}`,
  };
  const rawArtifact: RawCaseResultArtifact | undefined = rawArtifacts
    ? {
        caseId: evalCase.id,
        modelId,
        composedPrompt: "",
        transcript: [],
        rawContent: "",
        dimensionRationales: {},
        errorSummary: {
          errorType,
          classification: `trajectory-${errorType}`,
          localDiagnostic,
        },
      }
    : undefined;
  return { summary, rawArtifact };
}

/**
 * Returns true when `directory` exists and contains at least one file.
 */
async function directoryHasFiles(directory: string): Promise<boolean> {
  const glob = new Bun.Glob("**/*");
  try {
    for await (const _file of glob.scan({
      cwd: directory,
      dot: true,
      onlyFiles: true,
    })) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export class TrajectoryCaseExecutor {
  private readonly injectedRunner: TrajectoryRunner | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly evalsRoot: string;
  private readonly runnerLabel: string;

  constructor(options: TrajectoryCaseExecutorOptions) {
    this.injectedRunner = options.trajectoryRunner;
    this.env = options.env;
    this.evalsRoot = options.evalsRoot ?? EVALS_ROOT;
    this.runnerLabel = options.runnerLabel;
  }

  /**
   * Resolves the runner for a suite run: the injected one, or the production
   * OpenCode runner, imported lazily. `cases` supplies prompt text by id and
   * tells the production runner whether a working-tree plugin bundle is
   * needed (`opencode-local`).
   */
  resolveRunner(
    cases: readonly EvalCase[],
  ): ResultAsync<TrajectoryRunner, RunnerError> {
    if (this.injectedRunner !== undefined) {
      return okAsync(this.injectedRunner);
    }
    return ResultAsync.fromPromise(
      import("./opencode-trajectory-runner-adapter.js").then(
        ({ createProductionTrajectoryRunner }) =>
          createProductionTrajectoryRunner(cases, this.env),
      ),
      (cause): RunnerError => ({
        type: "PromptProviderFailed",
        agentName: this.runnerLabel,
        message: `Trajectory runner construction failed: ${String(cause)}`,
      }),
    );
  }

  /**
   * Resolves a runner only when `items` contain a `harness_trajectory` case,
   * so text-only suite runs never touch the trajectory machinery.
   */
  resolveRunnerIfNeeded(
    items: ReadonlyArray<{ evalCase: EvalCase }>,
    cases: readonly EvalCase[],
  ): ResultAsync<TrajectoryRunner | undefined, RunnerError> {
    if (!hasTrajectoryCases(items)) {
      return okAsync(undefined);
    }
    return this.resolveRunner(cases).map(
      (runner): TrajectoryRunner | undefined => runner,
    );
  }

  /**
   * Runs one `harness_trajectory` case and scores it. Never returns `err`:
   * failures become zero-score results so the suite run continues.
   */
  execute(
    evalCase: EvalCase,
    modelId: string,
    rubrics: readonly EvalRubric[],
    rawArtifacts: boolean,
    runner: TrajectoryRunner | undefined,
  ): ResultAsync<CaseResult, never> {
    const settled = this.executeCase(
      evalCase,
      modelId,
      rubrics,
      rawArtifacts,
      runner,
    );
    return new ResultAsync(settled.then((result) => ok(result)));
  }

  private async executeCase(
    evalCase: EvalCase,
    modelId: string,
    rubrics: readonly EvalRubric[],
    rawArtifacts: boolean,
    runner: TrajectoryRunner | undefined,
  ): Promise<CaseResult> {
    const outcome = evalCase.expected_outcome;
    if (outcome.kind !== "harness_trajectory") {
      return errorResult(evalCase, modelId, "UnknownEvalSuite", rawArtifacts);
    }
    if (runner === undefined) {
      return errorResult(
        evalCase,
        modelId,
        "TrajectoryRunnerUnavailable",
        rawArtifacts,
        "No TrajectoryRunner was resolved for this suite run.",
      );
    }
    const rubric = rubrics.find((r) => r.case_id === evalCase.id);
    if (rubric === undefined) {
      return errorResult(
        evalCase,
        modelId,
        "RubricNotFound",
        rawArtifacts,
        `No rubric found for case "${evalCase.id}".`,
      );
    }

    const fixturePath =
      outcome.fixture !== undefined
        ? join(this.evalsRoot, FIXTURES_DIRECTORY, outcome.fixture)
        : undefined;
    const verifierPath =
      outcome.verifier !== undefined
        ? join(this.evalsRoot, FIXTURES_DIRECTORY, outcome.verifier.fixture)
        : undefined;
    for (const path of [fixturePath, verifierPath]) {
      if (path !== undefined && !(await directoryHasFiles(path))) {
        return errorResult(
          evalCase,
          modelId,
          "FixtureNotFound",
          rawArtifacts,
          `Fixture directory is missing or empty: ${path}`,
        );
      }
    }

    const trajectoryCase: TrajectoryCase = {
      testCaseId: evalCase.id,
      expectedSpawns: outcome.expected_spawns,
      expectedTools: outcome.expected_tools,
      maxDurationSeconds: outcome.max_duration_seconds,
      sandboxProfile: outcome.sandbox_profile,
      ...(fixturePath !== undefined ? { fixturePath } : {}),
      ...(outcome.start_agent !== undefined
        ? { startAgent: outcome.start_agent }
        : {}),
      ...(outcome.verifier !== undefined && verifierPath !== undefined
        ? {
            verifier: {
              fixturePath: verifierPath,
              command: outcome.verifier.command,
            },
          }
        : {}),
    };

    // Placeholder workspace: the production runner builds its own ephemeral
    // workspace through its injected `TrajectoryWorkspaceFactory`.
    const placeholderWorkspace: TrajectoryWorkspace = {
      root: "",
      artifactsDir: "",
    };

    return runner.run(trajectoryCase, modelId, placeholderWorkspace).match(
      (result): CaseResult => {
        const scoreRecord = scoreTrajectoryResult({
          caseId: evalCase.id,
          modelId,
          suite: evalCase.suite,
          events: result.events,
          expectedOutcome: outcome,
          scoring: rubric.scoring,
          ...(result.verifier !== undefined
            ? { verifier: result.verifier }
            : {}),
        });

        const summary: CaseResultSummary = {
          caseId: evalCase.id,
          modelId,
          suite: evalCase.suite,
          passed: scoreRecord.passed,
          required: scoreRecord.required,
          weightedTotal: scoreRecord.weightedTotal,
          dimensionScores: dimensionScoreSummary(scoreRecord.dimensions),
          scoredAt: scoreRecord.scoredAt,
          dryRun: false,
          publicExplanation: buildPublicExplanation(
            scoreRecord,
            evalCase,
            false,
          ),
          trajectorySummary: result.summary,
        };

        // `result.events` (with tool-call detail) and the verifier outcome
        // are LOCAL-ONLY (Spec 33, Spec 35): raw artifact only, never the
        // summary.
        const rawArtifact: RawCaseResultArtifact | undefined = rawArtifacts
          ? {
              caseId: evalCase.id,
              modelId,
              composedPrompt: "",
              transcript: [],
              rawContent: JSON.stringify({
                events: result.events,
                verifier: result.verifier,
              }),
              dimensionRationales: dimensionRationales(scoreRecord.dimensions),
            }
          : undefined;

        return { summary, rawArtifact };
      },
      (error): CaseResult =>
        errorResult(evalCase, modelId, error.type, rawArtifacts),
    );
  }
}
