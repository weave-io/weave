import { describe, expect, it } from "bun:test";
import type { TrajectoryEvent } from "@weaveio/weave-core";
import {
  type HarnessTrajectoryOutcome,
  type ScoreTrajectoryInput,
  scoreTrajectoryResult,
} from "../trajectory-scoring.js";
import type { EvalRubric } from "../types.js";

function event(partial: TrajectoryEvent): TrajectoryEvent {
  return partial;
}

function makeExpectedOutcome(
  overrides: Partial<HarnessTrajectoryOutcome> = {},
): HarnessTrajectoryOutcome {
  return {
    kind: "harness_trajectory",
    expected_spawns: ["shuttle"],
    expected_tools: ["read"],
    max_duration_seconds: 60,
    sandbox_profile: "opencode-default",
    ...overrides,
  };
}

function makeScoring(
  overrides: Partial<EvalRubric["scoring"]> = {},
): EvalRubric["scoring"] {
  return {
    outcome_weight: 1,
    per_expectation_weight: 0,
    required: true,
    ...overrides,
  };
}

const BASE_ENVELOPE = {
  sessionId: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
};

function happyPathEvents(): TrajectoryEvent[] {
  return [
    event({
      ...BASE_ENVELOPE,
      kind: "session-created",
      agentName: "loom",
      model: "anthropic/claude-sonnet-4-5",
    }),
    event({
      ...BASE_ENVELOPE,
      kind: "subagent-spawned",
      parentAgentName: "loom",
      childAgentName: "shuttle",
    }),
    event({
      ...BASE_ENVELOPE,
      kind: "tool-call-before",
      toolName: "read",
      agentName: "shuttle",
    }),
    event({
      ...BASE_ENVELOPE,
      kind: "tool-call-after",
      toolName: "read",
      agentName: "shuttle",
      succeeded: true,
    }),
    event({
      ...BASE_ENVELOPE,
      kind: "session-completed",
      agentName: "loom",
      durationMs: 1000,
    }),
  ];
}

function buildInput(
  overrides: Partial<ScoreTrajectoryInput> = {},
): ScoreTrajectoryInput {
  return {
    caseId: "trajectory-case-1",
    modelId: "anthropic/claude-sonnet-4-5",
    suite: "shuttle-execution",
    events: happyPathEvents(),
    expectedOutcome: makeExpectedOutcome(),
    scoring: makeScoring(),
    ...overrides,
  };
}

describe("scoreTrajectoryResult", () => {
  it("scores all four dimensions and passes when all expectations are met", () => {
    const record = scoreTrajectoryResult(buildInput());

    expect(record.dimensions.routingCorrectness.score).toBe(1);
    expect(record.dimensions.routingCorrectness.applicable).toBe(true);
    expect(record.dimensions.delegationCorrectness.score).toBe(1);
    expect(record.dimensions.delegationCorrectness.applicable).toBe(true);
    expect(record.dimensions.executionCompleteness.score).toBe(1);
    expect(record.dimensions.executionCompleteness.applicable).toBe(true);
    expect(record.dimensions.rationaleQuality.applicable).toBe(false);
    expect(record.dimensions.rationaleQuality.score).toBe(1.0);
    expect(record.weightedTotal).toBe(1);
    expect(record.passed).toBe(true);
  });

  it("fails routingCorrectness when an expected spawn is missing", () => {
    const events = happyPathEvents().filter(
      (e) => e.kind !== "subagent-spawned",
    );
    const record = scoreTrajectoryResult(buildInput({ events }));

    expect(record.dimensions.routingCorrectness.score).toBe(0);
    expect(record.dimensions.routingCorrectness.applicable).toBe(true);
    // delegation also fails: lineage no longer matches expected_spawns
    expect(record.dimensions.delegationCorrectness.score).toBe(0);
    // execution is still met (tool observed) -> a single near-perfect
    // primary dimension is enough to pass, matching text-only semantics.
    expect(record.dimensions.executionCompleteness.score).toBe(1);
    expect(record.passed).toBe(true);
    expect(record.weightedTotal).toBeCloseTo(1 / 3, 10);
  });

  it("fails executionCompleteness when an expected tool call is missing", () => {
    const events = happyPathEvents().filter(
      (e) => e.kind !== "tool-call-before" && e.kind !== "tool-call-after",
    );
    const record = scoreTrajectoryResult(buildInput({ events }));

    expect(record.dimensions.executionCompleteness.score).toBe(0);
    expect(record.dimensions.executionCompleteness.applicable).toBe(true);
    expect(record.dimensions.routingCorrectness.score).toBe(1);
    // routing (and delegation) still near-perfect -> case still passes.
    expect(record.passed).toBe(true);
    expect(record.weightedTotal).toBeCloseTo(2 / 3, 10);
  });

  it("fails delegationCorrectness when the harness errored", () => {
    const events: TrajectoryEvent[] = [
      ...happyPathEvents().filter((e) => e.kind !== "session-completed"),
      event({
        ...BASE_ENVELOPE,
        kind: "session-errored",
        agentName: "loom",
        errorKind: "timeout",
      }),
    ];
    const record = scoreTrajectoryResult(buildInput({ events }));

    expect(record.dimensions.delegationCorrectness.score).toBe(0);
    expect(record.dimensions.delegationCorrectness.applicable).toBe(true);
    // routing and execution are unaffected by the error
    expect(record.dimensions.routingCorrectness.score).toBe(1);
    expect(record.dimensions.executionCompleteness.score).toBe(1);
    // a single near-perfect primary dimension is enough to pass.
    expect(record.passed).toBe(true);
    expect(record.weightedTotal).toBeCloseTo(2 / 3, 10);
  });

  it("fails the case overall when every primary dimension fails", () => {
    const events: TrajectoryEvent[] = [
      event({
        ...BASE_ENVELOPE,
        kind: "session-errored",
        agentName: "loom",
        errorKind: "timeout",
      }),
    ];
    const record = scoreTrajectoryResult(buildInput({ events }));

    expect(record.dimensions.routingCorrectness.score).toBe(0);
    expect(record.dimensions.delegationCorrectness.score).toBe(0);
    expect(record.dimensions.executionCompleteness.score).toBe(0);
    expect(record.passed).toBe(false);
    expect(record.weightedTotal).toBe(0);
  });

  it("marks rationaleQuality as not applicable in every trajectory case", () => {
    const cases: ScoreTrajectoryInput[] = [
      buildInput(),
      buildInput({ events: [] }),
      buildInput({
        expectedOutcome: makeExpectedOutcome({ expected_spawns: [] }),
      }),
    ];

    for (const input of cases) {
      const record = scoreTrajectoryResult(input);
      expect(record.dimensions.rationaleQuality.applicable).toBe(false);
      expect(record.dimensions.rationaleQuality.score).toBe(1.0);
    }
  });

  it("reproduces text-only weightedTotal arithmetic when per_expectation_weight is 0", () => {
    // With per_expectation_weight === 0 and rationaleQuality inapplicable,
    // weightedTotal collapses to the mean of the applicable primary
    // dimension scores — identical to the text-only case's
    // computeWeightedTotal arithmetic (outcome_weight distributed evenly
    // across applicable primary dimensions, rationale excluded).
    const scoring = makeScoring({
      outcome_weight: 0.9,
      per_expectation_weight: 0,
    });
    const record = scoreTrajectoryResult(buildInput({ scoring }));

    // All three primary dimensions score 1 -> mean is 1, independent of
    // the outcome_weight magnitude (normalised by totalWeight).
    expect(record.weightedTotal).toBe(1);

    const eventsMissingTool = happyPathEvents().filter(
      (e) => e.kind !== "tool-call-before" && e.kind !== "tool-call-after",
    );
    const partial = scoreTrajectoryResult(
      buildInput({ events: eventsMissingTool, scoring }),
    );
    // routing=1, delegation=1, execution=0 -> mean = 2/3
    expect(partial.weightedTotal).toBeCloseTo(2 / 3, 10);
  });

  it("is a pure function: repeated calls with the same input produce the same result", () => {
    const input = buildInput();
    const first = scoreTrajectoryResult(input);
    const second = scoreTrajectoryResult(input);

    expect(first.dimensions).toEqual(second.dimensions);
    expect(first.weightedTotal).toEqual(second.weightedTotal);
    expect(first.passed).toEqual(second.passed);
  });
});
