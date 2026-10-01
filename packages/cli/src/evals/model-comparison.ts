/**
 * `weave eval compare-models` (Spec 39 task 0.2, gap G2).
 *
 * `eval compare` judges a prompt change: two runs of the same models, and it
 * refuses runs whose model sets differ. Choosing a default model needs the
 * other comparison: two models on the same commit, prompts, judge, config
 * mode and repeats. This module makes it, per suite, and measures each
 * suite against the publication bar of Spec 39
 * (`docs/specs/39-spec-model-recommendations/`).
 *
 * # Inputs
 *
 * One run holding both models (`eval run --models default`), or two runs,
 * one per model. Two runs must match on commit, every composed-prompt hash,
 * judge (when both record one), config mode and case set; anything else is
 * refused with a typed `ModelComparisonError`, never compared.
 *
 * # Per suite
 *
 * - Pass counts and 95% Wilson intervals, on scored attempts (errored ones
 *   left out), as in `eval compare`.
 * - Fisher's exact test (two-sided) on the suite totals, Holm-adjusted
 *   across the suites that could reach significance at their size.
 * - The smallest drop the suite could detect at its size (see
 *   `smallestDetectableDrop`), so a "no significant difference" on a thin
 *   suite reads as the weak evidence it is.
 * - The per-case guard: a case the current model passes on at least 80% of
 *   its scored attempts fails the guard when the candidate passes it on
 *   fewer than 60%.
 * - The mean cost per attempt of each model, model calls and judge calls
 *   apart, and the candidate's difference.
 * - A verdict against the publication bar: PASS or FAIL with the reasons,
 *   and the bar steps this comparison cannot see.
 *
 * Pure functions over `RunSnapshot`s, which `RunBundleReader` reads; no I/O.
 */

import { err, ok, type Result } from "neverthrow";
import {
  bestPossibleP,
  fisherExactTwoSided,
  holmAdjust,
  SIGNIFICANCE_LEVEL,
} from "./binomial-stats.js";
import {
  type ComparedAttempt,
  type ComparedSide,
  describeJudge,
  difference,
  groupBy,
  type JudgeRecord,
  listSome,
  type RunSnapshot,
  type SideCost,
  side,
  sideCost,
} from "./compare.js";
import { configModeApplies, type EvalConfigMode } from "./config-mode.js";
import type { EvalTrack } from "./eval-track.js";

// ---------------------------------------------------------------------------
// The publication bar
// ---------------------------------------------------------------------------

/**
 * The thresholds of the Spec 39 publication bar this comparison checks.
 * Changing one changes what a published recommendation needs: update the
 * spec in the same change.
 */
export const PUBLICATION_BAR = {
  /** Step 2: text cases a suite needs. */
  minTextCases: 12,
  /** Step 3: repeats per case per model. */
  minRepeats: 5,
  /** Step 3, per-case guard: a case at or above this rate on current… */
  guardCurrentAtLeast: 0.8,
  /** …fails the guard when the candidate is below this rate. */
  guardCandidateBelow: 0.6,
} as const;

/**
 * The current model's pass rate the smallest detectable drop is measured
 * from. 95% is what a good default scores on a suite that is not saturated;
 * the eval readiness record's table uses the same reference.
 */
export const DETECTABLE_DROP_REFERENCE_RATE = 0.95;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which two models to compare, and how strictly. */
export interface ModelComparisonOptions {
  /** The model the agent uses today. */
  current: string;
  /** The model that would replace it. */
  candidate: string;
  /**
   * The fewest repeats per case per model to compare at all. Defaults to
   * the bar's 5. A lower value (for development) still compares, and every
   * suite then fails the bar for it.
   */
  minRepeats?: number;
}

/** Why two models could not be compared. */
export type ModelComparisonError =
  | {
      /** Neither one nor two runs were given. */
      type: "RunCount";
      count: number;
      message: string;
    }
  | {
      /** `--current` and `--candidate` name the same model. */
      type: "SameModel";
      modelId: string;
      message: string;
    }
  | {
      /** A dry run scores nothing. */
      type: "DryRunBundle";
      ref: string;
      message: string;
    }
  | {
      /**
       * A run restricted to the trajectory track: the comparison is over
       * text cases, and trajectory cases are a separate bar step.
       */
      type: "TrajectoryTrackRun";
      ref: string;
      message: string;
    }
  | {
      /** A model is in none of the runs. */
      type: "ModelNotFound";
      role: "current" | "candidate";
      modelId: string;
      /** The models the runs hold. */
      available: string[];
      message: string;
    }
  | {
      /** With two runs, a model is in both, so which to use is ambiguous. */
      type: "ModelInSeveralRuns";
      modelId: string;
      message: string;
    }
  | {
      /** Two runs were given, and one of them holds neither model. */
      type: "UnusedRun";
      ref: string;
      message: string;
    }
  | {
      /** The two runs were made on different commits. */
      type: "CommitMismatch";
      current: string;
      candidate: string;
      message: string;
    }
  | {
      /** The two runs composed different prompts for some agents. */
      type: "PromptMismatch";
      agents: string[];
      message: string;
    }
  | {
      /** Both runs record a judge, and they differ. */
      type: "JudgeMismatch";
      current: JudgeRecord;
      candidate: JudgeRecord;
      message: string;
    }
  | {
      /** The runs composed their prompts from different config modes. */
      type: "ConfigModeMismatch";
      current: EvalConfigMode;
      candidate: EvalConfigMode;
      message: string;
    }
  | {
      /** The models ran different cases. */
      type: "CaseSetMismatch";
      onlyOnCurrent: string[];
      onlyOnCandidate: string[];
      message: string;
    }
  | {
      /** Some case ran a different number of times on the two models. */
      type: "RepeatCountMismatch";
      /** `suite/case: current × n, candidate × m`, one per differing case. */
      cases: string[];
      message: string;
    }
  | {
      /** The models ran each case fewer times than the bar needs. */
      type: "TooFewRepeats";
      repeats: number;
      minRepeats: number;
      message: string;
    };

/** One of the two runs a comparison read, by identity only. */
export interface ComparedRun {
  ref: string;
  runId: string;
  gitSha: string;
  track: EvalTrack | null;
}

/** How the judge compares across the models' runs. */
export type ModelJudgeStatus =
  /**
   * One judge scored both models: they come from one run, or from two that
   * record the same judge. `judge` is `null` for one run recording none.
   */
  | { kind: "same"; judge: JudgeRecord | null }
  /** Two runs, at least one recording no judge. */
  | {
      kind: "unknown";
      current: JudgeRecord | null;
      candidate: JudgeRecord | null;
    };

/** The verdict of the suite-level test. */
export type SuiteVerdict =
  | "significantly-worse"
  | "significantly-better"
  | "no-significant-difference"
  /** A side has no scored attempt, or no outcome could reach significance. */
  | "not-testable";

/** The per-case guard on one case. */
export type CaseGuardStatus =
  /** Current is at or above the guard's floor and the candidate kept up. */
  | "pass"
  /** Current is at or above the floor and the candidate fell below. */
  | "fail"
  /** Current is below the floor, so the guard does not apply. */
  | "not-applicable"
  /** A side has no scored attempt (every attempt errored). */
  | "not-scored";

/** One case on both models. */
export interface CaseGuard {
  caseId: string;
  current: ComparedSide;
  candidate: ComparedSide;
  status: CaseGuardStatus;
}

/** Mean cost per attempt of both models and the candidate's difference. */
export interface ModelCostComparison {
  current: SideCost;
  candidate: SideCost;
  /**
   * Candidate minus current mean cost per attempt, in US dollars, or `null`
   * when either mean is unknown.
   */
  difference: { model: number | null; judge: number | null };
}

/** A suite's verdict against the publication bar. */
export interface BarVerdict {
  verdict: "pass" | "fail";
  /** Why it failed, one reason per unmet step; empty on a pass. */
  reasons: string[];
  /** Bar steps this comparison cannot see, to be checked elsewhere. */
  notCheckedHere: string[];
}

/** One suite, both models. */
export interface SuiteModelComparison {
  suite: string;
  /** Cases in the suite (all text cases: see `ModelComparison.track`). */
  caseCount: number;
  current: ComparedSide;
  candidate: ComparedSide;
  /** Candidate minus current pass rate, or `null` when a side is unscored. */
  difference: number | null;
  /** Two-sided Fisher p on the suite totals. */
  pValue: number;
  /** Holm-adjusted across the testable suites; `null` when not tested. */
  adjustedP: number | null;
  verdict: SuiteVerdict;
  /**
   * How many points below a current model at 95% the candidate must fall
   * before Fisher's test can call it a drop at this suite's size, before
   * Holm's adjustment. `null` when no drop could show.
   */
  smallestDetectableDrop: number | null;
  cases: CaseGuard[];
  /** Case IDs that fail the guard. */
  guardFailures: string[];
  cost: ModelCostComparison;
  /** Whether this suite's prompts depend on the config mode. */
  configModeApplies: boolean;
  bar: BarVerdict;
}

/** A full model comparison, ready to print or serialize. */
export interface ModelComparison {
  current: { modelId: string; run: ComparedRun };
  candidate: { modelId: string; run: ComparedRun };
  /** True when both models came from the same run. */
  oneRun: boolean;
  gitSha: string;
  judge: ModelJudgeStatus;
  configMode: EvalConfigMode;
  /**
   * `text` when every run was restricted to the text track; `null` when a
   * run was not, so trajectory attempts may be counted among the cases.
   */
  track: "text" | null;
  /** How many times each case ran per model. */
  repeats: number;
  /** The fewest repeats the comparison accepted (`--min-repeats`). */
  minRepeats: number;
  significanceLevel: number;
  /** Suites tested together under Holm's adjustment. */
  testedSuites: number;
  suites: SuiteModelComparison[];
}

// ---------------------------------------------------------------------------
// Smallest detectable drop
// ---------------------------------------------------------------------------

/**
 * The smallest drop, as a fraction, that Fisher's two-sided test can call
 * significant (p < `SIGNIFICANCE_LEVEL`) when the current model passes
 * `DETECTABLE_DROP_REFERENCE_RATE` of `currentN` attempts and the candidate
 * is scored on `candidateN`. `null` when no outcome could show a drop.
 *
 * At 5 repeats this gives 30 points for a 4-case suite, 13 for 12 cases and
 * 10 for 20, matching the eval readiness record. It treats repeats as
 * independent; they are not, so the real figure is worse.
 */
export function smallestDetectableDrop(
  currentN: number,
  candidateN: number,
): number | null {
  if (currentN <= 0 || candidateN <= 0) return null;
  const currentPassed = Math.round(DETECTABLE_DROP_REFERENCE_RATE * currentN);
  const currentRate = currentPassed / currentN;
  for (let passed = candidateN; passed >= 0; passed -= 1) {
    if (passed / candidateN >= currentRate) continue;
    const p = fisherExactTwoSided(
      currentPassed,
      currentN - currentPassed,
      passed,
      candidateN - passed,
    );
    if (p < SIGNIFICANCE_LEVEL) return currentRate - passed / candidateN;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/** The run each model's attempts came from. */
interface Sources {
  current: RunSnapshot;
  candidate: RunSnapshot;
}

/**
 * Compare `options.candidate` against `options.current` over one or two
 * runs, or refuse with the reason they cannot be compared.
 */
export function compareModels(
  runs: readonly RunSnapshot[],
  options: ModelComparisonOptions,
): Result<ModelComparison, ModelComparisonError> {
  const minRepeats = options.minRepeats ?? PUBLICATION_BAR.minRepeats;
  const runsRefusal = checkRuns(runs, options);
  if (runsRefusal !== null) return err(runsRefusal);

  const sources = findSources(runs, options);
  if (sources.isErr()) return err(sources.error);
  const { current, candidate } = sources.value;

  const pairRefusal = checkPair(current, candidate);
  if (pairRefusal !== null) return err(pairRefusal);

  const currentAttempts = current.attempts.filter(
    (a) => a.modelId === options.current,
  );
  const candidateAttempts = candidate.attempts.filter(
    (a) => a.modelId === options.candidate,
  );

  const caseRefusal = checkCases(currentAttempts, candidateAttempts);
  if (caseRefusal !== null) return err(caseRefusal);

  const repeats = checkRepeats(currentAttempts, candidateAttempts, minRepeats);
  if (repeats.isErr()) return err(repeats.error);

  const judge = judgeStatus(current, candidate);
  const track = bothText(current, candidate) ? "text" : null;
  const drafts = buildSuites(currentAttempts, candidateAttempts, current);
  const testable = drafts.filter((d) => d.testable);
  const adjusted = holmAdjust(testable.map((d) => d.pValue));
  const adjustedBySuite = new Map(
    testable.map((d, i) => [d.suite, adjusted[i] ?? 1]),
  );

  const context: BarContext = {
    repeats: repeats.value,
    judge,
    track,
    configMode: current.configMode,
  };
  return ok({
    current: { modelId: options.current, run: runOf(current) },
    candidate: { modelId: options.candidate, run: runOf(candidate) },
    oneRun: current === candidate,
    gitSha: current.gitSha,
    judge,
    configMode: current.configMode,
    track,
    repeats: repeats.value,
    minRepeats,
    significanceLevel: SIGNIFICANCE_LEVEL,
    testedSuites: testable.length,
    suites: drafts.map((d) =>
      finishSuite(d, adjustedBySuite.get(d.suite), context),
    ),
  });
}

function runOf(run: RunSnapshot): ComparedRun {
  return {
    ref: run.ref,
    runId: run.runId,
    gitSha: run.gitSha,
    track: run.track,
  };
}

function checkRuns(
  runs: readonly RunSnapshot[],
  options: ModelComparisonOptions,
): ModelComparisonError | null {
  if (runs.length < 1 || runs.length > 2) {
    return {
      type: "RunCount",
      count: runs.length,
      message: `A model comparison reads one run holding both models, or two runs, one per model; got ${runs.length}.`,
    };
  }
  if (options.current === options.candidate) {
    return {
      type: "SameModel",
      modelId: options.current,
      message: `--current and --candidate both name ${options.current}. To compare two runs of one model, use weave eval compare.`,
    };
  }
  for (const run of runs) {
    if (run.dryRun) {
      return {
        type: "DryRunBundle",
        ref: run.ref,
        message: `Run ${run.runId} is a dry run: it scored nothing, so it has no pass rate to compare.`,
      };
    }
    if (run.track === "trajectory") {
      return {
        type: "TrajectoryTrackRun",
        ref: run.ref,
        message:
          `Run ${run.runId} ran only the trajectory track. A model comparison is over text cases; ` +
          "re-run with --track text. Trajectory cases are a separate step of the publication bar.",
      };
    }
  }
  return null;
}

function findSources(
  runs: readonly RunSnapshot[],
  options: ModelComparisonOptions,
): Result<Sources, ModelComparisonError> {
  const holding = (modelId: string): RunSnapshot[] =>
    runs.filter((run) => run.attempts.some((a) => a.modelId === modelId));
  const available = [
    ...new Set(runs.flatMap((run) => run.attempts.map((a) => a.modelId))),
  ].sort();

  const found: Partial<Sources> = {};
  for (const role of ["current", "candidate"] as const) {
    const modelId = options[role];
    const holders = holding(modelId);
    if (holders.length === 0) {
      return err({
        type: "ModelNotFound",
        role,
        modelId,
        available,
        message: `The --${role} model ${modelId} is not in ${runs.length === 1 ? "the run" : "either run"}. Models found: ${available.join(", ") || "none"}.`,
      });
    }
    if (holders.length > 1) {
      return err({
        type: "ModelInSeveralRuns",
        modelId,
        message: `${modelId} is in both runs, so it is not clear which to compare. Pass one run holding both models, or two runs with one model each.`,
      });
    }
    found[role] = holders[0];
  }
  const { current, candidate } = found;
  if (current === undefined || candidate === undefined) {
    return err({
      type: "RunCount",
      count: runs.length,
      message: "No run holds the compared models.",
    });
  }
  const unused = runs.find((run) => run !== current && run !== candidate);
  if (unused !== undefined) {
    return err({
      type: "UnusedRun",
      ref: unused.ref,
      message: `Run ${unused.runId} holds neither ${options.current} nor ${options.candidate}. Pass only the runs that hold them.`,
    });
  }
  return ok({ current, candidate });
}

/** Two runs must share commit, prompts, judge and config mode. */
function checkPair(
  current: RunSnapshot,
  candidate: RunSnapshot,
): ModelComparisonError | null {
  if (current === candidate) return null;

  if (current.gitSha !== candidate.gitSha) {
    return {
      type: "CommitMismatch",
      current: current.gitSha,
      candidate: candidate.gitSha,
      message:
        `The current model's run was made on commit ${current.gitSha.slice(0, 7)} and the candidate's on ` +
        `${candidate.gitSha.slice(0, 7)}, so a difference could come from the code, not the model. Run both on one commit.`,
    };
  }

  const agents = [
    ...new Set([
      ...current.promptHashes.keys(),
      ...candidate.promptHashes.keys(),
    ]),
  ]
    .filter(
      (agent) =>
        current.promptHashes.get(agent) !== candidate.promptHashes.get(agent),
    )
    .sort();
  if (agents.length > 0) {
    return {
      type: "PromptMismatch",
      agents,
      message:
        `The runs composed different prompts for ${listSome(agents)}, so a difference could come from the prompts, ` +
        "not the model. Run both with the same config (--config builtin).",
    };
  }

  if (
    current.judge !== null &&
    candidate.judge !== null &&
    (current.judge.id !== candidate.judge.id ||
      current.judge.version !== candidate.judge.version)
  ) {
    return {
      type: "JudgeMismatch",
      current: current.judge,
      candidate: candidate.judge,
      message:
        `The runs were scored by different judges (${describeJudge(current.judge)} and ` +
        `${describeJudge(candidate.judge)}), so their pass rates are not on the same scale.`,
    };
  }

  if (current.configMode !== candidate.configMode && modeMatters(current)) {
    return {
      type: "ConfigModeMismatch",
      current: current.configMode,
      candidate: candidate.configMode,
      message:
        `The current model's run composed its prompts from the ${current.configMode} config and the candidate's ` +
        `from the ${candidate.configMode} config. Run both with --config builtin.`,
    };
  }
  return null;
}

function modeMatters(run: RunSnapshot): boolean {
  return configModeApplies({
    track: run.track,
    suites: [...new Set(run.attempts.map((a) => a.suite))],
  });
}

function caseKey(attempt: ComparedAttempt): string {
  return `${attempt.suite}/${attempt.caseId}`;
}

function checkCases(
  current: readonly ComparedAttempt[],
  candidate: readonly ComparedAttempt[],
): ModelComparisonError | null {
  const cases = difference(current.map(caseKey), candidate.map(caseKey));
  if (cases.onlyInBaseline.length === 0 && cases.onlyInCandidate.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (cases.onlyInBaseline.length > 0) {
    parts.push(`Only on current: ${listSome(cases.onlyInBaseline)}.`);
  }
  if (cases.onlyInCandidate.length > 0) {
    parts.push(`Only on the candidate: ${listSome(cases.onlyInCandidate)}.`);
  }
  return {
    type: "CaseSetMismatch",
    onlyOnCurrent: cases.onlyInBaseline,
    onlyOnCandidate: cases.onlyInCandidate,
    message: `The models ran different cases. ${parts.join(" ")} Run both on the same --agent / --case filters.`,
  };
}

/**
 * Every case must run the same number of times on both models, and as many
 * times as on every other case, at least `minRepeats`. Errored attempts
 * count: they were run.
 */
function checkRepeats(
  current: readonly ComparedAttempt[],
  candidate: readonly ComparedAttempt[],
  minRepeats: number,
): Result<number, ModelComparisonError> {
  const currentCounts = groupBy(current, caseKey);
  const candidateCounts = groupBy(candidate, caseKey);
  const counts = new Set<number>();
  const uneven: string[] = [];
  for (const key of [...currentCounts.keys()].sort()) {
    const n = currentCounts.get(key)?.length ?? 0;
    const m = candidateCounts.get(key)?.length ?? 0;
    counts.add(n);
    counts.add(m);
    if (n !== m) uneven.push(`${key}: current × ${n}, candidate × ${m}`);
  }
  if (uneven.length > 0 || counts.size > 1) {
    return err({
      type: "RepeatCountMismatch",
      cases: uneven,
      message:
        "The models did not run every case the same number of times" +
        (uneven.length > 0 ? ` (${listSome(uneven)})` : "") +
        `, so their pass rates weigh cases differently. Run both with the same --repeat (at least ${PUBLICATION_BAR.minRepeats}).`,
    });
  }
  const repeats = [...counts][0] ?? 0;
  if (repeats < minRepeats) {
    return err({
      type: "TooFewRepeats",
      repeats,
      minRepeats,
      message:
        `Each case ran ${repeats} ${repeats === 1 ? "time" : "times"} per model; the publication bar needs at least ` +
        `${minRepeats}. Re-run both models with --repeat ${minRepeats}.`,
    });
  }
  return ok(repeats);
}

function judgeStatus(
  current: RunSnapshot,
  candidate: RunSnapshot,
): ModelJudgeStatus {
  if (current === candidate) return { kind: "same", judge: current.judge };
  if (current.judge !== null && candidate.judge !== null) {
    return { kind: "same", judge: current.judge };
  }
  return {
    kind: "unknown",
    current: current.judge,
    candidate: candidate.judge,
  };
}

function bothText(current: RunSnapshot, candidate: RunSnapshot): boolean {
  return current.track === "text" && candidate.track === "text";
}

/** A suite before Holm's adjustment and the bar. */
interface DraftSuite {
  suite: string;
  caseCount: number;
  current: ComparedSide;
  candidate: ComparedSide;
  pValue: number;
  testable: boolean;
  unscored: boolean;
  smallestDetectableDrop: number | null;
  cases: CaseGuard[];
  cost: ModelCostComparison;
  configModeApplies: boolean;
}

function buildSuites(
  current: readonly ComparedAttempt[],
  candidate: readonly ComparedAttempt[],
  currentRun: RunSnapshot,
): DraftSuite[] {
  const currentSuites = groupBy(current, (a) => a.suite);
  const candidateSuites = groupBy(candidate, (a) => a.suite);
  return [...currentSuites.keys()].sort().map((suite) => {
    const currentAttempts = currentSuites.get(suite) ?? [];
    const candidateAttempts = candidateSuites.get(suite) ?? [];
    const currentSide = side(currentAttempts);
    const candidateSide = side(candidateAttempts);
    const currentN = currentSide.passed + currentSide.failed;
    const candidateN = candidateSide.passed + candidateSide.failed;
    const unscored = currentN === 0 || candidateN === 0;
    const cases = buildCases(currentAttempts, candidateAttempts);
    return {
      suite,
      caseCount: cases.length,
      current: currentSide,
      candidate: candidateSide,
      pValue: fisherExactTwoSided(
        currentSide.passed,
        currentSide.failed,
        candidateSide.passed,
        candidateSide.failed,
      ),
      testable:
        !unscored && bestPossibleP(currentN, candidateN) < SIGNIFICANCE_LEVEL,
      unscored,
      smallestDetectableDrop: smallestDetectableDrop(currentN, candidateN),
      cases,
      cost: costComparison(currentAttempts, candidateAttempts),
      configModeApplies: configModeApplies({
        track: currentRun.track,
        suites: [suite],
      }),
    };
  });
}

function buildCases(
  current: readonly ComparedAttempt[],
  candidate: readonly ComparedAttempt[],
): CaseGuard[] {
  const currentCases = groupBy(current, (a) => a.caseId);
  const candidateCases = groupBy(candidate, (a) => a.caseId);
  return [...currentCases.keys()].sort().map((caseId) => {
    const currentSide = side(currentCases.get(caseId) ?? []);
    const candidateSide = side(candidateCases.get(caseId) ?? []);
    return {
      caseId,
      current: currentSide,
      candidate: candidateSide,
      status: guardStatus(currentSide, candidateSide),
    };
  });
}

/** The per-case guard of the publication bar, step 3, on rates. */
export function guardStatus(
  current: ComparedSide,
  candidate: ComparedSide,
): CaseGuardStatus {
  if (current.passRate === null || candidate.passRate === null) {
    return "not-scored";
  }
  if (current.passRate < PUBLICATION_BAR.guardCurrentAtLeast) {
    return "not-applicable";
  }
  if (candidate.passRate < PUBLICATION_BAR.guardCandidateBelow) return "fail";
  return "pass";
}

function costComparison(
  current: readonly ComparedAttempt[],
  candidate: readonly ComparedAttempt[],
): ModelCostComparison {
  const currentCost = sideCost(current);
  const candidateCost = sideCost(candidate);
  const delta = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : b - a;
  return {
    current: currentCost,
    candidate: candidateCost,
    difference: {
      model: delta(currentCost.model.meanUsd, candidateCost.model.meanUsd),
      judge: delta(currentCost.judge.meanUsd, candidateCost.judge.meanUsd),
    },
  };
}

/** What every suite's bar verdict shares. */
interface BarContext {
  repeats: number;
  judge: ModelJudgeStatus;
  track: "text" | null;
  configMode: EvalConfigMode;
}

function finishSuite(
  draft: DraftSuite,
  adjustedP: number | undefined,
  context: BarContext,
): SuiteModelComparison {
  const diff =
    draft.current.passRate === null || draft.candidate.passRate === null
      ? null
      : draft.candidate.passRate - draft.current.passRate;
  const verdict = suiteVerdict(draft, adjustedP, diff);
  const guardFailures = draft.cases
    .filter((c) => c.status === "fail")
    .map((c) => c.caseId);
  const suite: Omit<SuiteModelComparison, "bar"> = {
    suite: draft.suite,
    caseCount: draft.caseCount,
    current: draft.current,
    candidate: draft.candidate,
    difference: diff,
    pValue: draft.pValue,
    adjustedP: adjustedP ?? null,
    verdict,
    smallestDetectableDrop: draft.smallestDetectableDrop,
    cases: draft.cases,
    guardFailures,
    cost: draft.cost,
    configModeApplies: draft.configModeApplies,
  };
  return { ...suite, bar: barVerdict(suite, context) };
}

function suiteVerdict(
  draft: DraftSuite,
  adjustedP: number | undefined,
  diff: number | null,
): SuiteVerdict {
  if (draft.unscored || !draft.testable || adjustedP === undefined) {
    return "not-testable";
  }
  if (adjustedP >= SIGNIFICANCE_LEVEL) return "no-significant-difference";
  if (diff !== null && diff > 0) return "significantly-better";
  return "significantly-worse";
}

/**
 * The suite against the publication bar. The comparison checks steps 1, 2,
 * 3 and 7 and the measurable half of 4; steps 5, 6 and 8 need other
 * evidence and are listed as not checked here.
 */
function barVerdict(
  suite: Omit<SuiteModelComparison, "bar">,
  context: BarContext,
): BarVerdict {
  const reasons: string[] = [];
  if (suite.configModeApplies && context.configMode !== "builtin") {
    reasons.push(
      `prompts composed with the ${context.configMode} config, not the shipped builtins (step 1: run with --config builtin)`,
    );
  }
  if (context.track !== "text") {
    reasons.push(
      "a run was not restricted to --track text, so trajectory attempts may be counted as text cases (steps 2 and 3)",
    );
  }
  if (suite.caseCount < PUBLICATION_BAR.minTextCases) {
    reasons.push(
      `${suite.caseCount} ${suite.caseCount === 1 ? "case" : "cases"}; the bar needs at least ${PUBLICATION_BAR.minTextCases} text cases (step 2)`,
    );
  }
  if (context.repeats < PUBLICATION_BAR.minRepeats) {
    reasons.push(
      `${context.repeats} repeats per case; the bar needs at least ${PUBLICATION_BAR.minRepeats} (step 3)`,
    );
  }
  if (context.judge.kind === "unknown") {
    reasons.push(
      "a run records no judge, so both models cannot be shown to share one (step 3)",
    );
  }
  if (suite.verdict === "significantly-worse") {
    reasons.push("the candidate is significantly worse on the suite (step 3)");
  }
  if (suite.verdict === "not-testable") {
    reasons.push(
      "the suite-level test could not run: a model has no scored attempt (step 3)",
    );
  }
  if (suite.guardFailures.length > 0) {
    reasons.push(
      `per-case guard failed on ${suite.guardFailures.join(", ")}: current passes at least ` +
        `${percent(PUBLICATION_BAR.guardCurrentAtLeast)} and the candidate below ${percent(PUBLICATION_BAR.guardCandidateBelow)} (step 3)`,
    );
  }
  const unscored = suite.cases
    .filter((c) => c.status === "not-scored")
    .map((c) => c.caseId);
  if (unscored.length > 0) {
    reasons.push(
      `per-case guard could not check ${unscored.join(", ")}: every attempt errored on a model (step 3)`,
    );
  }
  if (
    suite.cost.current.model.meanUsd === null ||
    suite.cost.candidate.model.meanUsd === null
  ) {
    reasons.push(
      "cost per attempt of the model calls is not recorded for both models (step 7)",
    );
  }

  return {
    verdict: reasons.length === 0 ? "pass" : "fail",
    reasons,
    notCheckedHere: notCheckedHere(suite),
  };
}

function notCheckedHere(suite: Omit<SuiteModelComparison, "bar">): string[] {
  const steps: string[] = [];
  if (suite.verdict !== "significantly-better") {
    steps.push(
      "step 4, a reason to change: the candidate is not significantly better, so the change needs a stated reason " +
        `(availability, cost) and must not raise cost (${costDirection(suite.cost)})`,
    );
  }
  steps.push(
    "step 5, real sessions: the agent's trajectory cases on the candidate",
    "step 6, resolves as intended: weave models check --expect against the catalog fixtures",
    "step 8, published evidence: the run on tryweave.io/evals, linked from the file's evidence field",
  );
  return steps;
}

function costDirection(cost: ModelCostComparison): string {
  const delta = cost.difference.model;
  if (delta === null) return "model cost per attempt not recorded";
  if (delta > 0) return "model calls cost more per attempt";
  if (delta < 0) return "model calls cost less per attempt";
  return "model calls cost the same per attempt";
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
