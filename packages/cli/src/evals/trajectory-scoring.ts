/**
 * Pure scoring for `harness_trajectory` eval cases.
 *
 * Turns a `TrajectoryEvent[]` (the normalized event stream produced by a
 * harness adapter — see `@weaveio/weave-core`'s
 * `docs/specs/33-spec-harness-trajectory-evals`) plus the case's
 * `harness_trajectory` expected outcome into a `NormalizedScoreRecord`
 * compatible with the existing four-dimension scoring model used for
 * text-only cases (see `langchain-agent-evals.ts`).
 *
 * Mapping:
 *   - `routingCorrectness`    — did the observed subagent spawns match the
 *                               expected spawn sequence, in order?
 *   - `delegationCorrectness` — did the harness reach `session-completed`
 *                               without a `session-errored` event, and did
 *                               it produce the expected delegate lineage
 *                               (the same ordered spawn sequence)?
 *   - `executionCompleteness` — were all `expected_tools` observed at least
 *                               once (via `tool-call-before` /
 *                               `tool-call-after` events)?
 *   - `rationaleQuality`      — not applicable for trajectory cases (no
 *                               free-text rationale is produced by a real
 *                               harness run); scored neutrally at `1.0` so
 *                               it never drags down the weighted total.
 *
 * The weighted total and pass/fail arithmetic intentionally mirror
 * `computeWeightedTotal` / `determinePassed` in `langchain-agent-evals.ts`
 * so that trajectory and text-only cases are comparable in reports. Those
 * helpers are not exported from that module, so the arithmetic is
 * reproduced here rather than imported; keep the two in sync if either
 * changes.
 *
 * This module performs no I/O and has no side effects — it is a pure
 * function over its inputs.
 */

import type { TrajectoryEvent } from "@weaveio/weave-core";
import type {
  DimensionScore,
  EvalRubric,
  ExpectedOutcome,
  NormalizedScoreRecord,
  ScoringDimension,
} from "./types.js";

/** The `harness_trajectory` variant of `ExpectedOutcome`. */
export type HarnessTrajectoryOutcome = Extract<
  ExpectedOutcome,
  { kind: "harness_trajectory" }
>;

/**
 * Minimum score for a primary structural dimension to be considered
 * "near-perfect" for pass/fail purposes.
 *
 * Mirrors `PRIMARY_STRUCTURAL_PASS_THRESHOLD` in `langchain-agent-evals.ts`.
 */
const PRIMARY_STRUCTURAL_PASS_THRESHOLD = 0.95;

/**
 * Minimum `weightedTotal` for a case to be considered passing.
 *
 * Mirrors `PASS_THRESHOLD` in `langchain-agent-evals.ts`.
 */
export const TRAJECTORY_PASS_THRESHOLD = 0.5;

/** Input to `scoreTrajectoryResult`. */
export interface ScoreTrajectoryInput {
  /** The eval case ID this record scores. */
  caseId: string;
  /** The model identifier used for the run. */
  modelId: string;
  /** The eval suite this case belongs to. */
  suite: string;
  /** The observed trajectory event stream from the harness run. */
  events: TrajectoryEvent[];
  /** The case's `harness_trajectory` expected outcome. */
  expectedOutcome: HarnessTrajectoryOutcome;
  /** The rubric's scoring metadata (weights + required flag). */
  scoring: EvalRubric["scoring"];
}

/**
 * Extract the ordered sequence of child agent names spawned during the run,
 * in the order the `subagent-spawned` events were observed.
 */
function observedSpawns(events: TrajectoryEvent[]): string[] {
  return events
    .filter((event) => event.kind === "subagent-spawned")
    .map((event) => event.childAgentName);
}

/**
 * Extract the set of distinct tool names invoked during the run, derived
 * from both `tool-call-before` and `tool-call-after` events.
 */
function observedToolNames(events: TrajectoryEvent[]): Set<string> {
  const names = new Set<string>();
  for (const event of events) {
    if (event.kind === "tool-call-before" || event.kind === "tool-call-after") {
      names.add(event.toolName);
    }
  }
  return names;
}

function hasSessionCompleted(events: TrajectoryEvent[]): boolean {
  return events.some((event) => event.kind === "session-completed");
}

function hasSessionErrored(events: TrajectoryEvent[]): boolean {
  return events.some((event) => event.kind === "session-errored");
}

function arraysEqualInOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * Score `routingCorrectness`: the observed spawn sequence must match the
 * expected spawn sequence exactly, in order.
 */
function buildRoutingCorrectnessDimension(
  events: TrajectoryEvent[],
  expected: HarnessTrajectoryOutcome,
): DimensionScore {
  const observed = observedSpawns(events);
  const matched = arraysEqualInOrder(observed, expected.expected_spawns);

  if (matched) {
    return {
      score: 1,
      rationale: `Observed spawn sequence matched expected: [${expected.expected_spawns.join(", ")}].`,
      applicable: true,
    };
  }

  return {
    score: 0,
    rationale: `Observed spawn sequence [${observed.join(", ") || "(none)"}] did not match expected [${expected.expected_spawns.join(", ")}].`,
    applicable: true,
  };
}

/**
 * Score `delegationCorrectness`: the harness must reach `session-completed`
 * without a `session-errored` event, and produce the expected delegate
 * lineage (the same ordered spawn sequence as `expected_spawns`).
 */
function buildDelegationCorrectnessDimension(
  events: TrajectoryEvent[],
  expected: HarnessTrajectoryOutcome,
): DimensionScore {
  const completed = hasSessionCompleted(events);
  const errored = hasSessionErrored(events);
  const observed = observedSpawns(events);
  const lineageMatched = arraysEqualInOrder(observed, expected.expected_spawns);

  if (completed && !errored && lineageMatched) {
    return {
      score: 1,
      rationale:
        "Harness reached session-completed without error and produced the expected delegate lineage.",
      applicable: true,
    };
  }

  const reasons: string[] = [];
  if (!completed) reasons.push("no session-completed event observed");
  if (errored) reasons.push("a session-errored event was observed");
  if (!lineageMatched) {
    reasons.push(
      `delegate lineage [${observed.join(", ") || "(none)"}] did not match expected [${expected.expected_spawns.join(", ")}]`,
    );
  }

  return {
    score: 0,
    rationale: `Delegation check failed: ${reasons.join("; ")}.`,
    applicable: true,
  };
}

/**
 * Score `executionCompleteness`: every `expected_tools` entry must have
 * been observed at least once.
 */
function buildExecutionCompletenessDimension(
  events: TrajectoryEvent[],
  expected: HarnessTrajectoryOutcome,
): DimensionScore {
  const observed = observedToolNames(events);
  const missing = expected.expected_tools.filter((tool) => !observed.has(tool));

  if (missing.length === 0) {
    return {
      score: 1,
      rationale:
        expected.expected_tools.length > 0
          ? `All expected tools observed at least once: [${expected.expected_tools.join(", ")}].`
          : "No tools were required for this case.",
      applicable: true,
    };
  }

  return {
    score: 0,
    rationale: `Missing expected tool call(s): [${missing.join(", ")}]. Observed tools: [${[...observed].join(", ") || "(none)"}].`,
    applicable: true,
  };
}

/**
 * `rationaleQuality` is not applicable to trajectory cases — a real harness
 * session does not produce a free-text rationale to judge. Scored
 * neutrally at `1.0` so it never drags down the weighted total.
 */
function buildRationaleQualityDimension(): DimensionScore {
  return {
    score: 1.0,
    rationale:
      "Not applicable: harness_trajectory cases do not score rationale quality.",
    applicable: false,
  };
}

/**
 * Compute the weighted total score from dimension scores and rubric weights.
 *
 * Mirrors `computeWeightedTotal` in `langchain-agent-evals.ts`: the primary
 * dimension weight (`outcome_weight`) is distributed evenly across
 * applicable primary dimensions (`routingCorrectness`,
 * `delegationCorrectness`, `executionCompleteness`); `rationaleQuality`
 * contributes via `per_expectation_weight` only when applicable. For
 * trajectory cases `rationaleQuality` is always inapplicable, so when
 * `per_expectation_weight === 0` the result reproduces the same arithmetic
 * as the text-only case (an average over the applicable primary
 * dimensions).
 */
function computeWeightedTotal(
  dimensions: Record<ScoringDimension, DimensionScore>,
  outcomeWeight: number,
  perExpectationWeight: number,
): number {
  const primaryDimensions: ScoringDimension[] = [
    "routingCorrectness",
    "delegationCorrectness",
    "executionCompleteness",
  ];

  const applicablePrimary = primaryDimensions.filter(
    (d) => dimensions[d].applicable,
  );

  const rationaleApplicable = dimensions.rationaleQuality.applicable;

  let totalWeight = 0;
  let weightedSum = 0;

  if (applicablePrimary.length > 0) {
    const primaryWeightEach = outcomeWeight / applicablePrimary.length;
    for (const dim of applicablePrimary) {
      weightedSum += dimensions[dim].score * primaryWeightEach;
      totalWeight += primaryWeightEach;
    }
  }

  if (rationaleApplicable) {
    weightedSum += dimensions.rationaleQuality.score * perExpectationWeight;
    totalWeight += perExpectationWeight;
  }

  if (totalWeight === 0) {
    return 0;
  }

  return weightedSum / totalWeight;
}

/**
 * Determine whether a case passes based on the weighted total and rubric.
 *
 * Mirrors `determinePassed` in `langchain-agent-evals.ts`.
 */
function determinePassed(
  dimensions: Record<ScoringDimension, DimensionScore>,
  weightedTotal: number,
  required: boolean,
): boolean {
  const primaryDimensions: ScoringDimension[] = [
    "routingCorrectness",
    "delegationCorrectness",
    "executionCompleteness",
  ];

  const applicablePrimary = primaryDimensions.filter(
    (d) => dimensions[d].applicable,
  );

  const hasPassingPrimary = applicablePrimary.some(
    (d) => dimensions[d].score >= PRIMARY_STRUCTURAL_PASS_THRESHOLD,
  );

  if (hasPassingPrimary) {
    return true;
  }

  if (weightedTotal < TRAJECTORY_PASS_THRESHOLD) {
    return false;
  }

  if (!required) {
    return true;
  }

  if (applicablePrimary.length === 0) {
    return true;
  }

  return false;
}

/**
 * Score a `harness_trajectory` eval case's observed event stream against
 * its expected outcome, producing a `NormalizedScoreRecord` compatible
 * with the existing four-dimension scoring model.
 *
 * Pure function: no I/O, no side effects, deterministic given its inputs.
 */
export function scoreTrajectoryResult(
  input: ScoreTrajectoryInput,
): NormalizedScoreRecord {
  const dimensions: Record<ScoringDimension, DimensionScore> = {
    routingCorrectness: buildRoutingCorrectnessDimension(
      input.events,
      input.expectedOutcome,
    ),
    delegationCorrectness: buildDelegationCorrectnessDimension(
      input.events,
      input.expectedOutcome,
    ),
    executionCompleteness: buildExecutionCompletenessDimension(
      input.events,
      input.expectedOutcome,
    ),
    rationaleQuality: buildRationaleQualityDimension(),
  };

  const weightedTotal = computeWeightedTotal(
    dimensions,
    input.scoring.outcome_weight,
    input.scoring.per_expectation_weight,
  );

  const passed = determinePassed(
    dimensions,
    weightedTotal,
    input.scoring.required,
  );

  return {
    caseId: input.caseId,
    modelId: input.modelId,
    suite: input.suite,
    dimensions,
    weightedTotal,
    passed,
    required: input.scoring.required,
    scoredAt: new Date().toISOString(),
  };
}
