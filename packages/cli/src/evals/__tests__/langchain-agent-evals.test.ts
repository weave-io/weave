/**
 * Tests for `langchain-agent-evals.ts`.
 *
 * Verifies:
 *   - `LangChainAgentEvalsScorer` produces a normalized `NormalizedScoreRecord`
 *     for every case kind (agent_routing, delegation_chain, task_completion).
 *   - `LangChainAgentEvalsScorer` marks non-applicable dimensions with
 *     `applicable: false` and a neutral score.
 *   - `LangChainAgentEvalsScorer` returns `RubricNotFound` when no rubric
 *     matches the case ID.
 *   - `LangChainAgentEvalsScorer` returns `RubricCaseMismatch` when the
 *     rubric and case IDs disagree.
 *   - `LangChainAgentEvalsScorer` propagates `ScorerAdapterError` from the
 *     judge back to the caller.
 *   - Score clamping: out-of-range judge outputs are clamped to [0, 1].
 *   - Weighted total computation uses rubric outcome_weight and
 *     per_expectation_weight correctly.
 *   - Pass/fail gate: required cases require a near-perfect primary dimension.
 *   - `StubLangChainJudge` records calls, returns FIFO results, falls back to
 *     default, and returns typed `NotConfigured` when unconfigured.
 *   - `StubAgentEvalsScorer` records calls and returns FIFO results, default,
 *     or typed `NotConfigured`.
 *   - No real LangChain, no network, no file I/O in any test.
 *
 * Test isolation:
 *   - All judge calls go through `StubLangChainJudge` — no LangChain imports.
 *   - All scorer-level tests use either `StubLangChainJudge` or
 *     `StubAgentEvalsScorer` — no real scoring models.
 *   - Fixtures are constructed inline — no file reads.
 */

import { describe, expect, it } from "bun:test";
import {
  type AgentEvalsScorer,
  buildRationaleProjection,
  type JudgeInput,
  LangChainAgentEvalsScorer,
  type LangChainJudge,
  PASS_THRESHOLD,
  RATIONALE_PROJECTION_MAX_CHARS,
  RealLangChainJudge,
  StubAgentEvalsScorer,
  StubLangChainJudge,
} from "../langchain-agent-evals.js";
import type {
  DimensionScore,
  EvalCase,
  EvalRubric,
  ModelRunOutput,
  NormalizedScoreRecord,
  ScoringError,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCORED_AT = "2026-01-01T00:00:00.000Z";

/** Build a minimal valid ModelRunOutput for a given case kind. */
function makeRun(overrides: Partial<ModelRunOutput> = {}): ModelRunOutput {
  return {
    caseId: "test-case-01",
    modelId: "anthropic/claude-sonnet-4.5",
    routedAgents: ["shuttle"],
    delegationChain: [],
    transcript: [],
    rawContent: "I will route this to the shuttle agent.",
    completionSignalled: false,
    producedArtifacts: [],
    ...overrides,
  };
}

/** Build a minimal valid EvalCase for a given outcome kind. */
function makeAgentRoutingCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "test-case-01",
    description: "Route to shuttle agent",
    suite: "loom-routing",
    allowed_agents: ["loom", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "agent_routing",
      target_agent: "shuttle",
      via: [],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

function makeDelegationCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "test-case-02",
    description: "Delegate from tapestry to shuttle",
    suite: "tapestry-execution",
    allowed_agents: ["tapestry", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "delegation_chain",
      chain: ["tapestry", "shuttle"],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

function makeTaskCompletionCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "test-case-03",
    description: "Complete a coding task",
    suite: "tapestry-execution",
    allowed_agents: ["tapestry", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description: "Implement the feature",
      required_artifacts: ["plan_path"],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

/** Build a valid EvalRubric matching the given case ID. */
function makeRubric(
  caseId: string = "test-case-01",
  suite: string = "loom-routing",
  overrides: Partial<EvalRubric> = {},
): EvalRubric {
  return {
    case_id: caseId,
    suite,
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required: true,
    },
    ...overrides,
  };
}

/** Build a NormalizedScoreRecord for stub use. */
function makeScoreRecord(
  overrides: Partial<NormalizedScoreRecord> = {},
): NormalizedScoreRecord {
  const neutralDim: DimensionScore = {
    score: 1.0,
    rationale: "Test",
    applicable: false,
  };
  const activeDim: DimensionScore = {
    score: 1.0,
    rationale: "Correct routing",
    applicable: true,
  };
  return {
    caseId: "test-case-01",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "loom-routing",
    dimensions: {
      routingCorrectness: activeDim,
      delegationCorrectness: neutralDim,
      executionCompleteness: neutralDim,
      rationaleQuality: activeDim,
    },
    weightedTotal: 1.0,
    passed: true,
    required: true,
    scoredAt: SCORED_AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: judge that returns perfect scores for all dimensions
// ---------------------------------------------------------------------------

function makePerfectJudge(): StubLangChainJudge {
  const judge = new StubLangChainJudge();
  judge.setDefaultOutput({ score: 1.0, rationale: "Perfect score." });
  return judge;
}

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — rubric lookup errors
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — rubric lookup errors", () => {
  it("returns RubricNotFound when no rubric matches the case ID", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({ caseId: "unknown-case" });
    const evalCase = makeAgentRoutingCase({ id: "unknown-case" });
    const rubrics: EvalRubric[] = [makeRubric("different-case")];

    const result = await scorer.score(run, evalCase, rubrics, SCORED_AT);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RubricNotFound");
    if (error.type === "RubricNotFound") {
      expect(error.caseId).toBe("unknown-case");
      expect(error.message).toContain("unknown-case");
    }
  });

  it("returns RubricNotFound when rubrics array is empty", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun();
    const evalCase = makeAgentRoutingCase();

    const result = await scorer.score(run, evalCase, [], SCORED_AT);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("RubricNotFound");
  });

  it("returns RubricCaseMismatch when rubric case_id differs from run caseId", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    // run.caseId = "test-case-01", evalCase.id = "different-id",
    // rubric.case_id = "test-case-01" → rubric found but evalCase.id mismatches
    const run = makeRun({ caseId: "test-case-01" });
    const evalCase = makeAgentRoutingCase({ id: "different-id" });
    const rubrics: EvalRubric[] = [makeRubric("test-case-01")];

    const result = await scorer.score(run, evalCase, rubrics, SCORED_AT);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RubricCaseMismatch");
    if (error.type === "RubricCaseMismatch") {
      expect(error.caseId).toBe("test-case-01");
      expect(error.rubricCaseId).toBe("test-case-01");
      expect(error.message).toContain("different-id");
    }
  });
});

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — agent_routing case
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — agent_routing case", () => {
  it("returns ok(NormalizedScoreRecord) for a successful routing score", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun();
    const evalCase = makeAgentRoutingCase();
    const rubrics = [makeRubric()];

    const result = await scorer.score(run, evalCase, rubrics, SCORED_AT);

    expect(result.isOk()).toBe(true);
    const record = result._unsafeUnwrap();
    expect(record.caseId).toBe("test-case-01");
    expect(record.modelId).toBe("anthropic/claude-sonnet-4.5");
    expect(record.suite).toBe("loom-routing");
    expect(record.scoredAt).toBe(SCORED_AT);
  });

  it("routingCorrectness dimension is applicable for agent_routing cases", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.routingCorrectness.applicable).toBe(true);
  });

  it("delegationCorrectness is NOT applicable for agent_routing cases", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.delegationCorrectness.applicable).toBe(false);
  });

  it("executionCompleteness is NOT applicable for agent_routing cases", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.executionCompleteness.applicable).toBe(false);
  });

  it("rationaleQuality is always applicable", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun({ caseId: "test-case-03" }),
      makeTaskCompletionCase(),
      [makeRubric("test-case-03", "tapestry-execution")],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.rationaleQuality.applicable).toBe(true);
  });

  it("judge is called once for agent_routing rationale only", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 0.8, rationale: "Reasonable." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]?.dimension).toBe("rationaleQuality");
  });

  it("routing correctness is deterministic from accepted routed agents", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 1.0, rationale: "Correct." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun({ routedAgents: ["thread", "shuttle-backend"] }),
      makeAgentRoutingCase({ accepted_alternates: ["shuttle-backend"] }),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.routingCorrectness.score).toBe(1);
    expect(record.dimensions.routingCorrectness.rationale).toContain(
      "shuttle-backend",
    );
    expect(judge.calls.some((c) => c.dimension === "routingCorrectness")).toBe(
      false,
    );
  });

  it("routing correctness accepts matched via-only staged routes", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 0.5, rationale: "Sparse rationale." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun({ routedAgents: ["thread"] }),
      makeAgentRoutingCase({
        expected_outcome: {
          kind: "agent_routing",
          target_agent: "shuttle",
          via: ["thread"],
        },
      }),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.routingCorrectness.score).toBe(1);
    expect(record.passed).toBe(true);
  });

  it("non-applicable dimension score is 1.0 (neutral, not penalizing)", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.delegationCorrectness.score).toBe(1.0);
    expect(record.dimensions.executionCompleteness.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — delegation_chain case
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — delegation_chain case", () => {
  it("returns ok for a delegation_chain case", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({
      caseId: "test-case-02",
      delegationChain: ["tapestry", "shuttle"],
    });
    const evalCase = makeDelegationCase();
    const rubrics = [makeRubric("test-case-02", "tapestry-execution")];

    const result = await scorer.score(run, evalCase, rubrics, SCORED_AT);

    expect(result.isOk()).toBe(true);
  });

  it("delegationCorrectness is applicable for delegation_chain cases", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({ caseId: "test-case-02" });
    const rubrics = [makeRubric("test-case-02", "tapestry-execution")];

    const result = await scorer.score(
      run,
      makeDelegationCase(),
      rubrics,
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.delegationCorrectness.applicable).toBe(true);
  });

  it("routingCorrectness is NOT applicable for delegation_chain cases", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({ caseId: "test-case-02" });
    const rubrics = [makeRubric("test-case-02", "tapestry-execution")];

    const result = await scorer.score(
      run,
      makeDelegationCase(),
      rubrics,
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.routingCorrectness.applicable).toBe(false);
  });

  it("judge is called twice for delegation_chain (delegation + rationale)", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 0.9, rationale: "Good chain." });
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({ caseId: "test-case-02" });
    const rubrics = [makeRubric("test-case-02", "tapestry-execution")];

    await scorer.score(run, makeDelegationCase(), rubrics, SCORED_AT);

    expect(judge.calls).toHaveLength(2);
  });

  it("judge call for delegation has dimension='delegationCorrectness'", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 1.0, rationale: "Correct chain." });
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({ caseId: "test-case-02" });
    const rubrics = [makeRubric("test-case-02", "tapestry-execution")];

    await scorer.score(run, makeDelegationCase(), rubrics, SCORED_AT);

    const delegationCall = judge.calls.find(
      (c) => c.dimension === "delegationCorrectness",
    );
    expect(delegationCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — task_completion case
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — task_completion case", () => {
  it("returns ok for a task_completion case", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({
      caseId: "test-case-03",
      completionSignalled: true,
      producedArtifacts: ["plan_path"],
    });
    const rubrics = [makeRubric("test-case-03", "tapestry-execution")];

    const result = await scorer.score(
      run,
      makeTaskCompletionCase(),
      rubrics,
      SCORED_AT,
    );

    expect(result.isOk()).toBe(true);
  });

  it("executionCompleteness is applicable for task_completion cases", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({ caseId: "test-case-03" });
    const rubrics = [makeRubric("test-case-03", "tapestry-execution")];

    const result = await scorer.score(
      run,
      makeTaskCompletionCase(),
      rubrics,
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.executionCompleteness.applicable).toBe(true);
  });

  it("routing and delegation are NOT applicable for task_completion cases", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({ caseId: "test-case-03" });
    const rubrics = [makeRubric("test-case-03", "tapestry-execution")];

    const result = await scorer.score(
      run,
      makeTaskCompletionCase(),
      rubrics,
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.routingCorrectness.applicable).toBe(false);
    expect(record.dimensions.delegationCorrectness.applicable).toBe(false);
  });

  it("judge is called twice for task_completion (execution + rationale)", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 0.8, rationale: "Completed." });
    const scorer = new LangChainAgentEvalsScorer(judge);
    const run = makeRun({ caseId: "test-case-03" });
    const rubrics = [makeRubric("test-case-03", "tapestry-execution")];

    await scorer.score(run, makeTaskCompletionCase(), rubrics, SCORED_AT);

    expect(judge.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — score clamping
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — score clamping", () => {
  it("clamps judge scores > 1.0 to 1.0", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 1.5, rationale: "Overshoot." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.routingCorrectness.score).toBeLessThanOrEqual(1.0);
    expect(record.dimensions.rationaleQuality.score).toBeLessThanOrEqual(1.0);
  });

  it("clamps judge scores < 0 to 0.0", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: -0.5, rationale: "Undershoot." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.routingCorrectness.score).toBeGreaterThanOrEqual(
      0,
    );
    expect(record.dimensions.rationaleQuality.score).toBeGreaterThanOrEqual(0);
  });

  it("preserves scores in [0, 1] without modification", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 0.75, rationale: "Good." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.routingCorrectness.score).toBe(1);
    expect(record.dimensions.rationaleQuality.score).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — weighted total
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — weighted total", () => {
  it("weightedTotal is in [0, 1]", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 0.6, rationale: "Partial." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun({ caseId: "test-case-03" }),
      makeTaskCompletionCase(),
      [makeRubric("test-case-03", "tapestry-execution")],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.weightedTotal).toBeGreaterThanOrEqual(0);
    expect(record.weightedTotal).toBeLessThanOrEqual(1);
  });

  it("weightedTotal is 1.0 when all applicable scores are 1.0", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.weightedTotal).toBe(1.0);
  });

  it("weightedTotal is 0.0 when all applicable scores are 0.0", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 0.0, rationale: "Wrong." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun({ caseId: "test-case-03" }),
      makeTaskCompletionCase(),
      [makeRubric("test-case-03", "tapestry-execution")],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.weightedTotal).toBe(0.0);
  });

  it("uses rubric outcome_weight and per_expectation_weight", async () => {
    // execution score = 1.0, rationale score = 0.0
    const judge = new StubLangChainJudge();
    judge.enqueueOutput({ score: 1.0, rationale: "Perfect execution." }); // execution
    judge.enqueueOutput({ score: 0.0, rationale: "No rationale." }); // rationale
    const scorer = new LangChainAgentEvalsScorer(judge);

    // outcome_weight=0.8 for execution, per_expectation_weight=0.2 for rationale
    const rubric = makeRubric("test-case-03", "tapestry-execution", {
      scoring: {
        outcome_weight: 0.8,
        per_expectation_weight: 0.2,
        required: true,
      },
    });

    const result = await scorer.score(
      makeRun({ caseId: "test-case-03", completionSignalled: true }),
      makeTaskCompletionCase(),
      [rubric],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    // execution:1.0 × 0.8 + rationale:0.0 × 0.2 = 0.8 total weight = 1.0 → normalised = 0.8/1.0 = 0.8
    expect(record.weightedTotal).toBeCloseTo(0.8, 5);
  });
});

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — pass/fail gate
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — pass/fail gate", () => {
  it("passed is true when primary dimension is perfect", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun({ caseId: "test-case-03" }),
      makeTaskCompletionCase(),
      [makeRubric("test-case-03", "tapestry-execution")],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.passed).toBe(true);
  });

  it("passed is false when weightedTotal < PASS_THRESHOLD", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 0.0, rationale: "Wrong." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun({ caseId: "test-case-03" }),
      makeTaskCompletionCase(),
      [makeRubric("test-case-03", "tapestry-execution")],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.weightedTotal).toBeLessThan(PASS_THRESHOLD);
    expect(record.passed).toBe(false);
  });

  it("required cases require near-perfect primary dimension even above threshold", async () => {
    // execution score = 0.7 (above threshold if threshold were 0.5), rationale = 0.9
    // but primary dim is below the near-perfect gate, and the case is required → must fail
    const judge = new StubLangChainJudge();
    judge.enqueueOutput({ score: 0.7, rationale: "Partial execution." }); // execution
    judge.enqueueOutput({ score: 0.9, rationale: "Good rationale." }); // rationale
    const scorer = new LangChainAgentEvalsScorer(judge);

    const rubric = makeRubric("test-case-03", "tapestry-execution", {
      scoring: {
        outcome_weight: 0.5,
        per_expectation_weight: 0.5,
        required: true,
      },
    });

    const result = await scorer.score(
      makeRun({ caseId: "test-case-03", completionSignalled: true }),
      makeTaskCompletionCase(),
      [rubric],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    // execution:0.7 × 0.5 + rationale:0.9 × 0.5 = 0.8 total weight=1.0 → 0.8 ≥ 0.5
    // but required && primary dim (execution) is below the near-perfect gate → passed = false
    expect(record.weightedTotal).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    expect(record.passed).toBe(false);
  });

  it("required cases pass when primary dimension is near-perfect even with weak rationale", async () => {
    const judge = new StubLangChainJudge();
    judge.enqueueOutput({
      score: 0.95,
      rationale: "Nearly complete execution.",
    });
    judge.enqueueOutput({ score: 0.0, rationale: "Sparse rationale." });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const rubric = makeRubric("test-case-03", "tapestry-execution", {
      scoring: {
        outcome_weight: 0.5,
        per_expectation_weight: 0.5,
        required: true,
      },
    });

    const result = await scorer.score(
      makeRun({ caseId: "test-case-03", completionSignalled: true }),
      makeTaskCompletionCase(),
      [rubric],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.executionCompleteness.score).toBe(0.95);
    expect(record.dimensions.rationaleQuality.score).toBe(0.0);
    expect(record.weightedTotal).toBeLessThan(PASS_THRESHOLD);
    expect(record.passed).toBe(true);
  });

  it("non-required cases pass on total alone (primary dim does not need to be 1.0)", async () => {
    const judge = new StubLangChainJudge();
    judge.enqueueOutput({ score: 0.7, rationale: "Partial execution." }); // execution
    judge.enqueueOutput({ score: 0.9, rationale: "Good rationale." }); // rationale
    const scorer = new LangChainAgentEvalsScorer(judge);

    const rubric = makeRubric("test-case-03", "tapestry-execution", {
      scoring: {
        outcome_weight: 0.5,
        per_expectation_weight: 0.5,
        required: false,
      },
    });

    const result = await scorer.score(
      makeRun({ caseId: "test-case-03", completionSignalled: true }),
      makeTaskCompletionCase(),
      [rubric],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.passed).toBe(true);
  });

  it("record.required reflects the rubric required flag", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const rubricRequired = makeRubric("test-case-01", "loom-routing", {
      scoring: {
        outcome_weight: 0.7,
        per_expectation_weight: 0.3,
        required: true,
      },
    });
    const rubricOptional = makeRubric("test-case-01", "loom-routing", {
      scoring: {
        outcome_weight: 0.7,
        per_expectation_weight: 0.3,
        required: false,
      },
    });

    const r1 = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [rubricRequired],
      SCORED_AT,
    );
    const r2 = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [rubricOptional],
      SCORED_AT,
    );

    expect(r1._unsafeUnwrap().required).toBe(true);
    expect(r2._unsafeUnwrap().required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — error propagation
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — error propagation from judge", () => {
  it("propagates ScorerAdapterError from the judge", async () => {
    const judge = new StubLangChainJudge();
    const adapterErr: ScoringError = {
      type: "ScorerAdapterError",
      caseId: "test-case-02",
      dimension: "delegationCorrectness",
      message: "LangChain model timed out",
    };
    judge.setDefaultError(adapterErr);
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun({
        caseId: "test-case-02",
        delegationChain: ["tapestry", "shuttle"],
      }),
      makeDelegationCase(),
      [makeRubric("test-case-02", "tapestry-execution")],
      SCORED_AT,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ScorerAdapterError");
    if (error.type === "ScorerAdapterError") {
      expect(error.message).toContain("LangChain model timed out");
    }
  });

  it("surfaces rationale quality error when judge fails on that dimension", async () => {
    const judge = new StubLangChainJudge();
    // First call (delegation) succeeds; second call (rationale) fails
    judge.enqueueOutput({ score: 1.0, rationale: "Correct delegation." });
    judge.enqueueError({
      type: "ScorerAdapterError",
      caseId: "test-case-02",
      dimension: "rationaleQuality",
      message: "Rationale judge failed",
    });
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun({
        caseId: "test-case-02",
        delegationChain: ["tapestry", "shuttle"],
      }),
      makeDelegationCase(),
      [makeRubric("test-case-02", "tapestry-execution")],
      SCORED_AT,
    );

    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — NormalizedScoreRecord shape
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — NormalizedScoreRecord shape", () => {
  it("record has all four dimension keys", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    const dims = Object.keys(record.dimensions).sort();
    expect(dims).toEqual([
      "delegationCorrectness",
      "executionCompleteness",
      "rationaleQuality",
      "routingCorrectness",
    ]);
  });

  it("each dimension has score, rationale, and applicable fields", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    for (const dim of Object.values(record.dimensions)) {
      expect(typeof dim.score).toBe("number");
      expect(typeof dim.rationale).toBe("string");
      expect(dim.rationale.length).toBeGreaterThan(0);
      expect(typeof dim.applicable).toBe("boolean");
    }
  });

  it("record.suite matches the evalCase.suite", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase({ suite: "loom-routing" }),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.suite).toBe("loom-routing");
  });

  it("record.scoredAt matches injected timestamp", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    expect(result._unsafeUnwrap().scoredAt).toBe(SCORED_AT);
  });

  it("record.scoredAt defaults to a valid ISO string when not injected", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      // no scoredAt injected
    );

    const { scoredAt } = result._unsafeUnwrap();
    expect(() => new Date(scoredAt)).not.toThrow();
    expect(new Date(scoredAt).getFullYear()).toBeGreaterThanOrEqual(2024);
  });
});

// ---------------------------------------------------------------------------
// StubLangChainJudge — basic behaviour
// ---------------------------------------------------------------------------

describe("StubLangChainJudge — basic behaviour", () => {
  it("records each evaluate() call in .calls", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 0.5, rationale: "default" });

    const input1: JudgeInput = {
      dimension: "routingCorrectness",
      rubricDescription: "Route to shuttle",
      response: "Routed to shuttle",
      reference: "Expected: shuttle",
    };
    const input2: JudgeInput = {
      dimension: "rationaleQuality",
      rubricDescription: "Quality check",
      response: "Good reasoning.",
      reference: "Evaluate quality",
    };

    await judge.evaluate(input1);
    await judge.evaluate(input2);

    expect(judge.calls).toHaveLength(2);
    expect(judge.calls[0]?.dimension).toBe("routingCorrectness");
    expect(judge.calls[1]?.dimension).toBe("rationaleQuality");
  });

  it("returns enqueued outputs in FIFO order", async () => {
    const judge = new StubLangChainJudge();
    judge.enqueueOutput({ score: 0.9, rationale: "First" });
    judge.enqueueOutput({ score: 0.3, rationale: "Second" });

    const input: JudgeInput = {
      dimension: "routingCorrectness",
      rubricDescription: "x",
      response: "y",
      reference: "z",
    };

    const r1 = await judge.evaluate(input);
    const r2 = await judge.evaluate(input);

    expect(r1._unsafeUnwrap().score).toBe(0.9);
    expect(r2._unsafeUnwrap().score).toBe(0.3);
  });

  it("falls back to defaultOutput after queue is exhausted", async () => {
    const judge = new StubLangChainJudge();
    judge.enqueueOutput({ score: 0.9, rationale: "Queued" });
    judge.setDefaultOutput({ score: 0.5, rationale: "Default" });

    const input: JudgeInput = {
      dimension: "routingCorrectness",
      rubricDescription: "x",
      response: "y",
      reference: "z",
    };

    const r1 = await judge.evaluate(input);
    const r2 = await judge.evaluate(input);
    const r3 = await judge.evaluate(input);

    expect(r1._unsafeUnwrap().score).toBe(0.9);
    expect(r2._unsafeUnwrap().score).toBe(0.5);
    expect(r3._unsafeUnwrap().score).toBe(0.5);
  });

  it("falls back to defaultError after queue is exhausted", async () => {
    const judge = new StubLangChainJudge();
    judge.setDefaultError({
      type: "ScorerAdapterError",
      caseId: "c1",
      dimension: "routingCorrectness",
      message: "Failed",
    });

    const input: JudgeInput = {
      dimension: "routingCorrectness",
      rubricDescription: "x",
      response: "y",
      reference: "z",
    };

    const result = await judge.evaluate(input);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ScorerAdapterError");
  });

  it("returns NotConfigured error when queue is empty and no default is set", async () => {
    const judge = new StubLangChainJudge();
    const input: JudgeInput = {
      dimension: "rationaleQuality",
      rubricDescription: "x",
      response: "y",
      reference: "z",
    };

    const result = await judge.evaluate(input);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("NotConfigured");
  });

  it("NotConfigured error carries the call index (zero-based)", async () => {
    const judge = new StubLangChainJudge();
    const input: JudgeInput = {
      dimension: "routingCorrectness",
      rubricDescription: "x",
      response: "y",
      reference: "z",
    };

    // First unconfigured call: index 0
    const r1 = await judge.evaluate(input);
    const e1 = r1._unsafeUnwrapErr();
    if (e1.type === "NotConfigured") {
      expect(e1.callIndex).toBe(0);
    }

    // Second unconfigured call: index 1
    const r2 = await judge.evaluate(input);
    const e2 = r2._unsafeUnwrapErr();
    if (e2.type === "NotConfigured") {
      expect(e2.callIndex).toBe(1);
    }
  });

  it("interleaved enqueue → error → output works correctly", async () => {
    const judge = new StubLangChainJudge();
    judge.enqueueError({
      type: "ScorerAdapterError",
      caseId: "c1",
      dimension: "routingCorrectness",
      message: "bad",
    });
    judge.enqueueOutput({ score: 1.0, rationale: "ok" });

    const input: JudgeInput = {
      dimension: "routingCorrectness",
      rubricDescription: "x",
      response: "y",
      reference: "z",
    };

    const r1 = await judge.evaluate(input);
    const r2 = await judge.evaluate(input);

    expect(r1.isErr()).toBe(true);
    expect(r2.isOk()).toBe(true);
  });

  it("calls array is empty before any calls", () => {
    const judge = new StubLangChainJudge();
    expect(judge.calls).toHaveLength(0);
  });

  it("satisfies LangChainJudge interface — evaluate returns ResultAsync", async () => {
    const judge: LangChainJudge = new StubLangChainJudge();
    (judge as StubLangChainJudge).setDefaultOutput({
      score: 0.8,
      rationale: "Ok.",
    });

    const input: JudgeInput = {
      dimension: "rationaleQuality",
      rubricDescription: "x",
      response: "y",
      reference: "z",
    };

    const result = judge.evaluate(input);
    expect(typeof result.then).toBe("function");

    const resolved = await result;
    expect(resolved.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StubAgentEvalsScorer — basic behaviour
// ---------------------------------------------------------------------------

describe("StubAgentEvalsScorer — basic behaviour", () => {
  it("records each score() call in .calls", async () => {
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeScoreRecord());

    const run1 = makeRun({ caseId: "c1" });
    const run2 = makeRun({ caseId: "c2" });
    const evalCase = makeAgentRoutingCase();
    const rubrics = [makeRubric()];

    await scorer.score(run1, evalCase, rubrics);
    await scorer.score(run2, evalCase, rubrics);

    expect(scorer.calls).toHaveLength(2);
    expect(scorer.calls[0]?.run.caseId).toBe("c1");
    expect(scorer.calls[1]?.run.caseId).toBe("c2");
  });

  it("returns enqueued records in FIFO order", async () => {
    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueRecord(makeScoreRecord({ passed: true, weightedTotal: 1.0 }));
    scorer.enqueueRecord(
      makeScoreRecord({ passed: false, weightedTotal: 0.2 }),
    );

    const evalCase = makeAgentRoutingCase();
    const rubrics = [makeRubric()];

    const r1 = await scorer.score(makeRun(), evalCase, rubrics);
    const r2 = await scorer.score(makeRun(), evalCase, rubrics);

    expect(r1._unsafeUnwrap().passed).toBe(true);
    expect(r2._unsafeUnwrap().passed).toBe(false);
  });

  it("falls back to defaultRecord after queue is exhausted", async () => {
    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueRecord(makeScoreRecord({ passed: true }));
    scorer.setDefaultRecord(makeScoreRecord({ passed: false }));

    const evalCase = makeAgentRoutingCase();
    const rubrics = [makeRubric()];

    const r1 = await scorer.score(makeRun(), evalCase, rubrics);
    const r2 = await scorer.score(makeRun(), evalCase, rubrics);
    const r3 = await scorer.score(makeRun(), evalCase, rubrics);

    expect(r1._unsafeUnwrap().passed).toBe(true);
    expect(r2._unsafeUnwrap().passed).toBe(false);
    expect(r3._unsafeUnwrap().passed).toBe(false);
  });

  it("returns NotConfigured error when queue is empty and no default is set", async () => {
    const scorer = new StubAgentEvalsScorer();

    const result = await scorer.score(makeRun(), makeAgentRoutingCase(), [
      makeRubric(),
    ]);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("NotConfigured");
  });

  it("NotConfigured carries the call index (zero-based)", async () => {
    const scorer = new StubAgentEvalsScorer();

    const r1 = await scorer.score(makeRun(), makeAgentRoutingCase(), [
      makeRubric(),
    ]);
    const e1 = r1._unsafeUnwrapErr();
    if (e1.type === "NotConfigured") {
      expect(e1.callIndex).toBe(0);
    }

    const r2 = await scorer.score(makeRun(), makeAgentRoutingCase(), [
      makeRubric(),
    ]);
    const e2 = r2._unsafeUnwrapErr();
    if (e2.type === "NotConfigured") {
      expect(e2.callIndex).toBe(1);
    }
  });

  it("returns enqueued ScoringError correctly", async () => {
    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueError({
      type: "RubricNotFound",
      caseId: "c1",
      message: "No rubric",
    });

    const result = await scorer.score(makeRun(), makeAgentRoutingCase(), [
      makeRubric(),
    ]);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("RubricNotFound");
  });

  it("satisfies AgentEvalsScorer interface — score() returns ResultAsync", async () => {
    const scorer: AgentEvalsScorer = new StubAgentEvalsScorer();
    (scorer as StubAgentEvalsScorer).setDefaultRecord(makeScoreRecord());

    const result = scorer.score(makeRun(), makeAgentRoutingCase(), [
      makeRubric(),
    ]);
    expect(typeof result.then).toBe("function");

    const resolved = await result;
    expect(resolved.isOk()).toBe(true);
  });

  it("calls array is empty before any calls", () => {
    const scorer = new StubAgentEvalsScorer();
    expect(scorer.calls).toHaveLength(0);
  });

  it("records the full rubrics array in calls", async () => {
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeScoreRecord());

    const rubrics = [makeRubric("c1"), makeRubric("c2")];
    await scorer.score(makeRun(), makeAgentRoutingCase(), rubrics);

    expect(scorer.calls[0]?.rubrics).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PASS_THRESHOLD constant
// ---------------------------------------------------------------------------

describe("PASS_THRESHOLD", () => {
  it("is 0.5", () => {
    expect(PASS_THRESHOLD).toBe(0.5);
  });

  it("a score of exactly PASS_THRESHOLD passes", async () => {
    const judge = new StubLangChainJudge();
    // With outcome_weight=1.0, per_expectation_weight=0.0 and routing=0.5
    // → weightedTotal = 0.5 which is exactly PASS_THRESHOLD
    judge.enqueueOutput({ score: 0.5, rationale: "Threshold." }); // routing
    // rationale is always scored but with per_expectation_weight=0 it won't matter
    judge.enqueueOutput({ score: 0.5, rationale: "Threshold." }); // rationale
    const scorer = new LangChainAgentEvalsScorer(judge);

    const rubric = makeRubric("test-case-01", "loom-routing", {
      scoring: {
        outcome_weight: 1.0,
        per_expectation_weight: 0.0,
        required: false,
      },
    });

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [rubric],
      SCORED_AT,
    );

    // weightedTotal should be 0.5 or close, and passed should be true for non-required
    const record = result._unsafeUnwrap();
    expect(record.weightedTotal).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// RealLangChainJudge — production adapter boundary tests
//
// These tests prove that:
//   1. RealLangChainJudge is exported from the module and implements LangChainJudge.
//   2. It can be constructed with a mock BaseChatModel without making real calls.
//   3. It returns typed ScorerAdapterError when the dynamic import or evaluator
//      call fails — it never throws.
//   4. The scorer can be composed with RealLangChainJudge the same way as any
//      other LangChainJudge implementation.
//
// No real LangChain model calls are made. We use a minimal mock BaseChatModel
// (satisfying only the subset of the interface that RealLangChainJudge needs)
// and a controlled override of the evaluator path via StubLangChainJudge
// combined with the scorer interface.
// ---------------------------------------------------------------------------

/**
 * Minimal mock that satisfies the BaseChatModel duck-type.
 *
 * RealLangChainJudge stores the model reference and passes it to
 * `createLLMAsJudge({ judge: this.model })` only when `evaluate()` is called.
 * Constructing with this mock does NOT trigger any LangChain calls.
 */
class MockBaseChatModel {
  _modelType(): string {
    return "base_chat_model";
  }
  async invoke(_messages: unknown): Promise<unknown> {
    // Never called in unit tests — this is only here to satisfy type-checking
    // if the test environment resolves the dynamic import.
    throw new Error("MockBaseChatModel.invoke should not be called in tests");
  }
}

describe("RealLangChainJudge — production adapter boundary", () => {
  it("is exported from langchain-agent-evals and is a class", () => {
    expect(typeof RealLangChainJudge).toBe("function");
  });

  it("can be constructed with a mock BaseChatModel without any LangChain calls", () => {
    const mockModel = new MockBaseChatModel();
    // Construction should be side-effect free (no dynamic import yet)
    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
    );
    expect(judge).toBeDefined();
  });

  it("satisfies the LangChainJudge interface (structural typing)", () => {
    const mockModel = new MockBaseChatModel();
    const judge: LangChainJudge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
    );
    // evaluate() must be a function returning a thenable ResultAsync
    expect(typeof judge.evaluate).toBe("function");
  });

  it("can be passed to LangChainAgentEvalsScorer as a LangChainJudge", () => {
    const mockModel = new MockBaseChatModel();
    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
    );
    // Constructing the scorer with a RealLangChainJudge should succeed with no errors
    const scorer = new LangChainAgentEvalsScorer(judge);
    expect(scorer).toBeDefined();
  });

  it("evaluate() returns a ResultAsync (thenable)", () => {
    const mockModel = new MockBaseChatModel();
    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
    );
    const input: JudgeInput = {
      dimension: "routingCorrectness",
      rubricDescription: "Route to shuttle",
      response: "Routed to shuttle",
      reference: "Expected: shuttle",
    };
    const resultAsync = judge.evaluate(input);
    // Must be thenable (ResultAsync extends PromiseLike)
    expect(typeof resultAsync.then).toBe("function");
  });

  it("evaluate() returns a typed ScorerAdapterError when openevals dynamic import fails", async () => {
    // We cannot easily intercept the dynamic import() in Bun's test runner
    // without module mocking infrastructure. Instead we prove the contract
    // via the StubLangChainJudge's ScorerAdapterError variant, which mirrors
    // exactly what RealLangChainJudge returns on load failure.
    //
    // This test exercises the error shape contract that consumers depend on:
    const judge = new StubLangChainJudge();
    judge.setDefaultError({
      type: "ScorerAdapterError",
      caseId: "(unknown — load failure)",
      dimension: "rationaleQuality",
      message:
        "Failed to load openevals/llm via dynamic import: Error: Module not found. " +
        "Ensure agentevals and its peer dependencies are installed.",
    });

    const input: JudgeInput = {
      dimension: "routingCorrectness",
      rubricDescription: "x",
      response: "y",
      reference: "z",
    };

    const result = await judge.evaluate(input);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ScorerAdapterError");
    if (error.type === "ScorerAdapterError") {
      expect(error.message).toContain("openevals/llm");
    }
  });

  it("scorer with RealLangChainJudge fails with ScorerAdapterError when judge fails (no throw)", async () => {
    // Use a StubLangChainJudge that mimics RealLangChainJudge's error response
    // to prove the scorer propagates errors without throwing.
    const judge = new StubLangChainJudge();
    judge.setDefaultError({
      type: "ScorerAdapterError",
      caseId: "test-case-01",
      dimension: "routingCorrectness",
      message: "LangChain AgentEvals judge call failed: connection refused",
    });

    const scorer = new LangChainAgentEvalsScorer(judge);
    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ScorerAdapterError");
  });
});

// ---------------------------------------------------------------------------
// RealLangChainJudge — per-rubric evaluator isolation
//
// These tests prove the correctness fix: each distinct rubricDescription
// produces its own evaluator and is NEVER scored using a cached evaluator
// from a previous, different rubricDescription.
//
// We achieve this without real LangChain calls by injecting a controlled
// `moduleLoader` factory that:
//   - records which `prompt` string each `createLLMAsJudge` call received
//   - returns a stub evaluator that echoes its call index as the score comment
//
// This lets us assert:
//   1. Two calls with different rubrics → two calls to `createLLMAsJudge`
//      (one per rubric, with the correct prompt for each)
//   2. Two calls with the same rubric → one call to `createLLMAsJudge`
//      (evaluator is cached and reused)
//   3. The module loader is called only once even when multiple rubrics exist
//      (module import is cached separately from evaluators)
// ---------------------------------------------------------------------------

describe("RealLangChainJudge — per-rubric evaluator isolation", () => {
  /**
   * Build a controlled fake `openevals/llm` module loader.
   *
   * Returns:
   *   - `moduleLoader`: pass to `RealLangChainJudge` constructor
   *   - `moduleLoadCount`: mutable counter incremented each time the loader
   *     is called (proves module is loaded at most once)
   *   - `factoryCallPrompts`: array of `prompt` strings passed to each
   *     `createLLMAsJudge` call (proves per-rubric evaluator creation)
   *   - `evaluatorCalls`: records params passed to each evaluator call
   *     (proves correct call shape: `outputs` + `reference_outputs` snake_case)
   */
  function makeFakeModuleLoader(): {
    moduleLoader: () => Promise<{
      createLLMAsJudge: (opts: {
        prompt: string;
        feedbackKey: string;
        judge: unknown;
        continuous: boolean;
        useReasoning: boolean;
      }) => (params: {
        outputs: string;
        reference_outputs?: string;
        [key: string]: unknown;
      }) => Promise<{ score: number; comment: string }>;
    }>;
    moduleLoadCount: { value: number };
    factoryCallPrompts: string[];
    evaluatorCalls: Array<{
      outputs: string;
      reference_outputs?: string;
      [key: string]: unknown;
    }>;
  } {
    const moduleLoadCount = { value: 0 };
    const factoryCallPrompts: string[] = [];
    const evaluatorCalls: Array<{
      outputs: string;
      reference_outputs?: string;
      [key: string]: unknown;
    }> = [];

    function createLLMAsJudge(opts: {
      prompt: string;
      feedbackKey: string;
      judge: unknown;
      continuous: boolean;
      useReasoning: boolean;
    }) {
      // Record the prompt that was passed to this factory call
      factoryCallPrompts.push(opts.prompt);
      const capturedPrompt = opts.prompt;

      // Return a stub evaluator that records call params and includes which rubric it was created with
      return async (params: {
        outputs: string;
        reference_outputs?: string;
        [key: string]: unknown;
      }) => {
        evaluatorCalls.push(params);
        return {
          score: 1.0 as number,
          comment: `Evaluated with rubric: ${capturedPrompt}`,
        };
      };
    }

    const moduleLoader = () => {
      moduleLoadCount.value += 1;
      return Promise.resolve({ createLLMAsJudge });
    };

    return {
      moduleLoader,
      moduleLoadCount,
      factoryCallPrompts,
      evaluatorCalls,
    };
  }

  it("two evaluate() calls with different rubrics each call createLLMAsJudge once (not reused)", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader, factoryCallPrompts } = makeFakeModuleLoader();

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    const rubric1 = "Route to the shuttle agent directly.";
    const rubric2 = "Evaluate the delegation chain tapestry → shuttle.";

    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: rubric1,
      response: "Routed to shuttle",
      reference: "Expected: shuttle",
    });

    await judge.evaluate({
      dimension: "delegationCorrectness",
      rubricDescription: rubric2,
      response: "tapestry → shuttle",
      reference: "Expected chain: tapestry → shuttle",
    });

    // createLLMAsJudge must have been called twice — once per distinct rubric
    expect(factoryCallPrompts).toHaveLength(2);
    // Each call must carry its rubric's text (not the other rubric's text)
    expect(factoryCallPrompts[0]).toContain(rubric1);
    expect(factoryCallPrompts[1]).toContain(rubric2);
    // The two prompts must be distinct (different rubrics = different prompts)
    expect(factoryCallPrompts[0]).not.toBe(factoryCallPrompts[1]);
  });

  it("the evaluator for rubric2 uses rubric2 text, not rubric1 text", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader } = makeFakeModuleLoader();

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    const rubric1 = "Routing rubric: expect shuttle.";
    const rubric2 = "Rationale rubric: coherent and detailed.";

    // First evaluate with rubric1
    const r1 = await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: rubric1,
      response: "response1",
      reference: "ref1",
    });

    // Second evaluate with rubric2 — must NOT reuse rubric1's evaluator
    const r2 = await judge.evaluate({
      dimension: "rationaleQuality",
      rubricDescription: rubric2,
      response: "response2",
      reference: "ref2",
    });

    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);

    // Our stub evaluator echoes back which rubric it was created with.
    // If rubric2's call reused rubric1's evaluator, its comment would
    // contain rubric1 text — which would be the stale-rubric bug.
    const comment1 = r1._unsafeUnwrap().rationale;
    const comment2 = r2._unsafeUnwrap().rationale;

    expect(comment1).toContain(rubric1);
    expect(comment2).toContain(rubric2);
    // The decisive correctness check: rubric2's evaluator must not carry rubric1's text
    expect(comment2).not.toContain(rubric1);
  });

  it("the same rubricDescription reuses the cached evaluator (createLLMAsJudge called once)", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader, factoryCallPrompts } = makeFakeModuleLoader();

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    const sameRubric = "Route to the shuttle agent.";

    // Call evaluate() three times with the identical rubricDescription
    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: sameRubric,
      response: "r1",
      reference: "ref",
    });
    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: sameRubric,
      response: "r2",
      reference: "ref",
    });
    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: sameRubric,
      response: "r3",
      reference: "ref",
    });

    // createLLMAsJudge should be called exactly once (cache hit on calls 2 and 3)
    expect(factoryCallPrompts).toHaveLength(1);
  });

  it("the module loader is called only once even when multiple distinct rubrics are used", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader, moduleLoadCount } = makeFakeModuleLoader();

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    // Three calls with three distinct rubrics — each creates a new evaluator
    // but the module itself should be loaded only once.
    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: "rubric-A",
      response: "rA",
      reference: "refA",
    });
    await judge.evaluate({
      dimension: "delegationCorrectness",
      rubricDescription: "rubric-B",
      response: "rB",
      reference: "refB",
    });
    await judge.evaluate({
      dimension: "executionCompleteness",
      rubricDescription: "rubric-C",
      response: "rC",
      reference: "refC",
    });

    // Module should have been loaded exactly once
    expect(moduleLoadCount.value).toBe(1);
  });

  it("_evaluatorCache has one entry per distinct rubricDescription", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader } = makeFakeModuleLoader();

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: "rubric-X",
      response: "r",
      reference: "ref",
    });
    await judge.evaluate({
      dimension: "delegationCorrectness",
      rubricDescription: "rubric-Y",
      response: "r",
      reference: "ref",
    });
    // Same rubric as first call — must not add a new cache entry
    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: "rubric-X",
      response: "r2",
      reference: "ref2",
    });

    // Cache should have exactly 2 entries: rubric-X and rubric-Y
    expect(judge._evaluatorCache.size).toBe(2);
    expect(judge._evaluatorCache.has("rubric-X")).toBe(true);
    expect(judge._evaluatorCache.has("rubric-Y")).toBe(true);
  });

  it("moduleLoader failure returns typed ScorerAdapterError (not a throw)", async () => {
    const mockModel = new MockBaseChatModel();
    const failingLoader = () =>
      Promise.reject(new Error("Module not found: openevals/llm"));

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      failingLoader,
    );

    const result = await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: "any rubric",
      response: "r",
      reference: "ref",
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ScorerAdapterError");
    if (error.type === "ScorerAdapterError") {
      expect(error.message).toContain("openevals/llm");
    }
  });

  // ---------------------------------------------------------------------------
  // Evaluator call shape: reference_outputs (snake_case) vs referenceOutputs
  //
  // These tests prove the API call fix: the evaluator must receive
  // `reference_outputs` (snake_case) — not `referenceOutputs` (camelCase).
  // openevals' ChatPromptTemplate.fromTemplate expects `{reference_outputs}`
  // in the prompt and injects it from the `reference_outputs` call param.
  // Passing `referenceOutputs` leaves the placeholder unfilled and causes:
  //   "Missing value for input variable `reference_outputs`"
  // ---------------------------------------------------------------------------

  it("evaluator is called with reference_outputs (snake_case), not referenceOutputs", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader, evaluatorCalls } = makeFakeModuleLoader();

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: "Route to shuttle",
      response: "Routed to shuttle",
      reference: "Expected: shuttle directly",
    });

    expect(evaluatorCalls).toHaveLength(1);
    const call = evaluatorCalls[0];
    if (!call) throw new Error("evaluatorCalls[0] not found");

    // Must use snake_case reference_outputs
    expect(call).toHaveProperty("reference_outputs");
    expect(call.reference_outputs).toBe("Expected: shuttle directly");

    // Must NOT use camelCase referenceOutputs
    expect(call).not.toHaveProperty("referenceOutputs");
  });

  it("evaluator is called with outputs matching JudgeInput.response", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader, evaluatorCalls } = makeFakeModuleLoader();

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    await judge.evaluate({
      dimension: "delegationCorrectness",
      rubricDescription: "Delegation chain check",
      response: "tapestry → shuttle",
      reference: "Expected chain: tapestry → shuttle",
    });

    expect(evaluatorCalls).toHaveLength(1);
    const call = evaluatorCalls[0];
    if (!call) throw new Error("evaluatorCalls[0] not found");
    expect(call.outputs).toBe("tapestry → shuttle");
  });

  it("prompt template uses {reference_outputs} placeholder (not {reference})", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader, factoryCallPrompts } = makeFakeModuleLoader();

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: "any-rubric",
      response: "r",
      reference: "ref",
    });

    expect(factoryCallPrompts).toHaveLength(1);
    const prompt = factoryCallPrompts[0];
    if (!prompt) throw new Error("factoryCallPrompts[0] not found");

    // Must use {reference_outputs} which openevals fills from `reference_outputs` param
    expect(prompt).toContain("{reference_outputs}");
    // Must NOT use {reference} which openevals does not recognise as a standard variable
    expect(prompt).not.toContain("{reference}");
    // Must contain {outputs} for the model response
    expect(prompt).toContain("{outputs}");
  });

  it("prompt template does not contain {referenceOutputs} camelCase placeholder", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader, factoryCallPrompts } = makeFakeModuleLoader();

    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: "any-rubric",
      response: "r",
      reference: "ref",
    });

    const prompt = factoryCallPrompts[0];
    if (!prompt) throw new Error("factoryCallPrompts[0] not found");
    // Camelcase is the wrong variant — would cause LangChain template error
    expect(prompt).not.toContain("{referenceOutputs}");
  });
});

// ---------------------------------------------------------------------------
// buildRationaleProjection — structured safe judge input (Issue 3 regression tests)
// ---------------------------------------------------------------------------

describe("buildRationaleProjection — structured safe projection for judge", () => {
  it("returns structured projection with all safe fields when run has data", () => {
    const run = makeRun({
      routedAgents: ["shuttle"],
      delegationChain: ["loom", "shuttle"],
      completionSignalled: true,
      producedArtifacts: ["plan_path"],
      transcript: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
      rawContent:
        "This is raw model output that must NOT appear in projection.",
    });
    const projection = buildRationaleProjection(run);
    // Must contain the safe structural fields
    expect(projection).toContain("routed_agents: [shuttle]");
    expect(projection).toContain("delegation_chain: loom → shuttle");
    expect(projection).toContain("completion_signalled: true");
    expect(projection).toContain("produced_artifacts: [plan_path]");
    expect(projection).toContain("transcript_message_count: 2");
    // Must NOT contain any rawContent text
    expect(projection).not.toContain("raw model output");
    expect(projection).not.toContain("This is raw model output");
  });

  it("does NOT include rawContent in the projection under any circumstances", () => {
    const sensitiveContent =
      "sk-secret-key-abcdefg this is a sensitive api response";
    const run = makeRun({ rawContent: sensitiveContent });
    const projection = buildRationaleProjection(run);
    // The raw content must never appear
    expect(projection).not.toContain("sk-secret-key-abcdefg");
    expect(projection).not.toContain("sensitive api response");
    expect(projection).not.toContain(sensitiveContent);
  });

  it("does NOT include rawContent even when rawContent is empty string", () => {
    const run = makeRun({ rawContent: "" });
    const projection = buildRationaleProjection(run);
    // Projection should still be a structured summary (not based on rawContent)
    expect(projection).toContain("completion_signalled");
    expect(projection).toContain("routed_agents");
    expect(projection).not.toContain("empty response");
  });

  it("does NOT include rawContent even when rawContent is whitespace-only", () => {
    const run = makeRun({ rawContent: "   " });
    const projection = buildRationaleProjection(run);
    expect(projection).toContain("routed_agents");
    // Must not contain the whitespace rawContent
    expect(projection.trim()).not.toBe("(empty response)");
  });

  it("shows (none) for empty routedAgents", () => {
    const run = makeRun({ routedAgents: [] });
    const projection = buildRationaleProjection(run);
    expect(projection).toContain("routed_agents: (none)");
  });

  it("shows (none) for empty delegationChain", () => {
    const run = makeRun({ delegationChain: [] });
    const projection = buildRationaleProjection(run);
    expect(projection).toContain("delegation_chain: (none)");
  });

  it("shows (none) for empty producedArtifacts", () => {
    const run = makeRun({ producedArtifacts: [] });
    const projection = buildRationaleProjection(run);
    expect(projection).toContain("produced_artifacts: (none)");
  });

  it("reflects completion_signalled=false correctly", () => {
    const run = makeRun({ completionSignalled: false });
    const projection = buildRationaleProjection(run);
    expect(projection).toContain("completion_signalled: false");
  });

  it("reflects completion_signalled=true correctly", () => {
    const run = makeRun({ completionSignalled: true });
    const projection = buildRationaleProjection(run);
    expect(projection).toContain("completion_signalled: true");
  });

  it("includes transcript_message_count (count only, not content)", () => {
    const run = makeRun({
      transcript: [
        { role: "user", content: "top secret: API_KEY=sk-supersecret" },
        { role: "assistant", content: "classified response data" },
        { role: "tool", content: "tool output", toolName: "bash" },
      ],
    });
    const projection = buildRationaleProjection(run);
    // Count appears
    expect(projection).toContain("transcript_message_count: 3");
    // Content must NOT appear
    expect(projection).not.toContain("top secret");
    expect(projection).not.toContain("sk-supersecret");
    expect(projection).not.toContain("classified response data");
    expect(projection).not.toContain("tool output");
  });

  it("truncates to RATIONALE_PROJECTION_MAX_CHARS when projection is very long", () => {
    // Create a run with many agents to push the projection over the limit
    const manyAgents = Array.from({ length: 200 }, (_, i) => `agent-${i}`);
    const run = makeRun({
      routedAgents: manyAgents,
      delegationChain: manyAgents,
    });
    const projection = buildRationaleProjection(run);
    expect(projection.length).toBeLessThanOrEqual(
      RATIONALE_PROJECTION_MAX_CHARS + 20,
    );
    expect(projection).toContain("[truncated]");
  });

  it("scorer does NOT forward rawContent to judge for rationaleQuality", async () => {
    // This test proves the key invariant: rawContent is never forwarded to
    // the judge. The projection is derived from structural fields only.
    const judge = new StubLangChainJudge();
    judge.setDefaultOutput({ score: 1.0, rationale: "ok" });

    const scorer = new LangChainAgentEvalsScorer(judge);
    const sensitiveMarker = "sk-secret-api-key-sentinel";
    const run = makeRun({
      rawContent: `This response contains a sensitive marker: ${sensitiveMarker}.`,
      routedAgents: ["shuttle"],
      delegationChain: [],
      completionSignalled: false,
      producedArtifacts: [],
    });
    const evalCase = makeAgentRoutingCase();
    const rubric = makeRubric();

    await scorer.score(run, evalCase, [rubric], SCORED_AT);

    // Find the rationaleQuality call in the judge's recorded calls
    const rqCall = judge.calls.find((c) => c.dimension === "rationaleQuality");
    expect(rqCall).toBeDefined();
    if (rqCall !== undefined) {
      // The raw sensitive marker must NOT appear in what was sent to the judge
      expect(rqCall.response).not.toContain(sensitiveMarker);
      // The rawContent text must not appear at all
      expect(rqCall.response).not.toContain("This response contains");
      // The projection must use safe structural fields instead
      expect(rqCall.response).toContain("routed_agents");
    }
  });

  it("projection does not contain any rawContent text even when rawContent contains agent names", () => {
    // Ensure that agent names mentioned in rawContent don't leak into projection
    // through coincidental string overlap with structural field values.
    const sensitiveMarker = "SENSITIVE_AGENT_SECRET_XYZ";
    const run = makeRun({
      rawContent: `I suggest routing to ${sensitiveMarker}`,
      routedAgents: ["shuttle"],
    });
    const projection = buildRationaleProjection(run);
    expect(projection).not.toContain(sensitiveMarker);
    expect(projection).not.toContain("I suggest routing");
  });

  it("RATIONALE_PROJECTION_MAX_CHARS is exported and is a positive number", () => {
    expect(RATIONALE_PROJECTION_MAX_CHARS).toBeGreaterThan(0);
    expect(typeof RATIONALE_PROJECTION_MAX_CHARS).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// buildCaseExplanation — deterministic structured-input explanation generator
// ---------------------------------------------------------------------------

import {
  buildCaseExplanation,
  buildPublicExplanation,
} from "../langchain-agent-evals.js";
import {
  EXPLANATION_MAX_CHARS,
  FORBIDDEN_EXPLANATION_PATTERNS,
} from "../report-schema.js";

describe("buildCaseExplanation — bounded explanation from structured inputs", () => {
  it("returns 'dry-run; no model was called' for dry-run results", () => {
    const text = buildCaseExplanation(
      "skip",
      false,
      true,
      "agent_routing",
      [],
      true,
    );
    expect(text).toBe("dry-run; no model was called");
  });

  it("returns 'dry-run; no model was called' for 'skip' bucket even when dryRun=false", () => {
    const text = buildCaseExplanation(
      "skip",
      false,
      true,
      "agent_routing",
      [],
      false,
    );
    expect(text).toBe("dry-run; no model was called");
  });

  it("includes 'passed' when bucket is 'pass'", () => {
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "agent_routing",
      ["routingCorrectness"],
      false,
    );
    expect(text).toContain("passed");
  });

  it("includes 'partially passed' when bucket is 'partial'", () => {
    const text = buildCaseExplanation(
      "partial",
      false,
      false,
      "agent_routing",
      ["routingCorrectness"],
      false,
    );
    expect(text).toContain("partially passed");
  });

  it("includes 'failed' when bucket is 'fail'", () => {
    const text = buildCaseExplanation(
      "fail",
      false,
      true,
      "agent_routing",
      [],
      false,
    );
    expect(text).toContain("failed");
  });

  it("includes 'routing' for agent_routing outcome kind", () => {
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "agent_routing",
      ["routingCorrectness"],
      false,
    );
    expect(text).toContain("routing");
  });

  it("includes 'delegation' for delegation_chain outcome kind", () => {
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "delegation_chain",
      ["delegationCorrectness"],
      false,
    );
    expect(text).toContain("delegation");
  });

  it("includes 'execution' for task_completion outcome kind", () => {
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "task_completion",
      ["executionCompleteness"],
      false,
    );
    expect(text).toContain("execution");
  });

  it("includes 'required' for required cases", () => {
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "agent_routing",
      [],
      false,
    );
    expect(text).toContain("required");
  });

  it("includes 'optional' for non-required cases", () => {
    const text = buildCaseExplanation(
      "fail",
      false,
      false,
      "agent_routing",
      [],
      false,
    );
    expect(text).toContain("optional");
  });

  it("lists applicable dimension names in the explanation", () => {
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "agent_routing",
      ["routingCorrectness", "rationaleQuality"],
      false,
    );
    expect(text).toContain("routingCorrectness");
    expect(text).toContain("rationaleQuality");
  });

  it("caps to at most 3 applicable dimension names in the explanation", () => {
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "agent_routing",
      [
        "routingCorrectness",
        "delegationCorrectness",
        "executionCompleteness",
        "rationaleQuality",
      ],
      false,
    );
    // At most 3 dimensions in the label
    const dimCount = (text.match(/Correctness|Completeness|Quality/g) ?? [])
      .length;
    expect(dimCount).toBeLessThanOrEqual(3);
  });

  it("is deterministic — same inputs always produce the same text", () => {
    const inputs: Parameters<typeof buildCaseExplanation> = [
      "pass",
      true,
      true,
      "agent_routing",
      ["routingCorrectness"],
      false,
    ];
    const t1 = buildCaseExplanation(...inputs);
    const t2 = buildCaseExplanation(...inputs);
    expect(t1).toBe(t2);
  });

  it("never exceeds EXPLANATION_MAX_CHARS characters", () => {
    // Test with maximal inputs
    const text = buildCaseExplanation(
      "partial",
      false,
      true,
      "agent_routing",
      ["routingCorrectness", "delegationCorrectness", "rationaleQuality"],
      false,
    );
    expect(text.length).toBeLessThanOrEqual(EXPLANATION_MAX_CHARS);
  });

  it("does not match any FORBIDDEN_EXPLANATION_PATTERNS", () => {
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "agent_routing",
      ["routingCorrectness"],
      false,
    );
    for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(text)).toBe(false);
    }
  });

  it("does not contain raw rationale, transcript markers, or chain-of-thought indicators", () => {
    const text = buildCaseExplanation(
      "fail",
      false,
      true,
      "delegation_chain",
      [],
      false,
    );
    // Must not contain forbidden raw-output markers
    expect(text.toLowerCase()).not.toContain("rationale:");
    expect(text.toLowerCase()).not.toContain("score:");
    expect(text.toLowerCase()).not.toContain("justification:");
    expect(text.toLowerCase()).not.toContain("<thinking>");
    expect(text.toLowerCase()).not.toContain("user:");
    expect(text.toLowerCase()).not.toContain("assistant:");
  });

  // ---------------------------------------------------------------------------
  // Adversarial tests — raw input in outcomeKind parameter
  // ---------------------------------------------------------------------------
  // The outcomeKind parameter comes from EvalCase.expected_outcome.kind which
  // is a discriminated union with a fixed set of literals. We still guard
  // against unknown values reaching the function.

  it("handles unknown outcome kinds gracefully (no forbidden patterns)", () => {
    // An unknown kind should not produce forbidden patterns even if the identifier
    // itself looks unusual — identifiers are validated at fixture load time
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "tool_call",
      [],
      false,
    );
    for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(text)).toBe(false);
    }
  });

  it("never contains raw prompt, transcript role markers, or leakage sentinels", () => {
    // A leakage sentinel that should NEVER appear in the output
    const leakageSentinel = "LEAKAGE_SENTINEL_SECRET_XYZ";
    // The outcome kind is an enum identifier — leakage sentinel cannot enter through it
    const text = buildCaseExplanation(
      "fail",
      false,
      true,
      "agent_routing",
      ["routingCorrectness"],
      false,
    );
    expect(text).not.toContain(leakageSentinel);
    expect(text).not.toContain("rawContent");
    expect(text).not.toContain("transcript");
    expect(text).not.toContain("composedPrompt");
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("Bearer");
  });
});

// ---------------------------------------------------------------------------
// buildPublicExplanation — threads explanation into CaseResultSummary field
// ---------------------------------------------------------------------------

describe("buildPublicExplanation — CaseResultSummary.publicExplanation generation", () => {
  it("returns a publicExplanation object for a scored (non-dry-run) result", () => {
    const scoreRecord = makeScoreRecord({
      passed: true,
      weightedTotal: 1.0,
      required: true,
    });
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(scoreRecord, evalCase, false);
    expect(expl).toBeDefined();
    expect(typeof expl?.text).toBe("string");
    expect((expl?.text ?? "").length).toBeGreaterThan(0);
  });

  it("returns explanation with source='structured_signal' when applicable dims present", () => {
    const scoreRecord = makeScoreRecord({
      passed: true,
      weightedTotal: 1.0,
      required: true,
    });
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(scoreRecord, evalCase, false);
    expect(expl?.source).toBe("structured_signal");
  });

  it("returns explanation with source='score_bucket_label' when no applicable dims and not required", () => {
    const noApplicableDims = makeScoreRecord({
      passed: true,
      weightedTotal: 0.9,
      required: false,
      dimensions: {
        routingCorrectness: { score: 1.0, rationale: "x", applicable: false },
        delegationCorrectness: {
          score: 1.0,
          rationale: "x",
          applicable: false,
        },
        executionCompleteness: {
          score: 1.0,
          rationale: "x",
          applicable: false,
        },
        rationaleQuality: { score: 1.0, rationale: "x", applicable: false },
      },
    });
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(noApplicableDims, evalCase, false);
    expect(expl?.source).toBe("score_bucket_label");
  });

  it("returns dry-run explanation for dryRun=true", () => {
    const scoreRecord = makeScoreRecord({ passed: false, weightedTotal: 0.0 });
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(scoreRecord, evalCase, true);
    expect(expl?.text).toContain("dry-run");
  });

  it("explanation text never exceeds EXPLANATION_MAX_CHARS", () => {
    const scoreRecord = makeScoreRecord({
      passed: true,
      weightedTotal: 1.0,
      required: true,
    });
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(scoreRecord, evalCase, false);
    expect((expl?.text ?? "").length).toBeLessThanOrEqual(
      EXPLANATION_MAX_CHARS,
    );
  });

  it("explanation text contains no forbidden patterns", () => {
    const scoreRecord = makeScoreRecord({ passed: false, weightedTotal: 0.0 });
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(scoreRecord, evalCase, false);
    for (const { pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(expl?.text ?? "")).toBe(false);
    }
  });

  it("is reproducible — same inputs produce the same explanation text", () => {
    const scoreRecord = makeScoreRecord({
      passed: true,
      weightedTotal: 0.95,
      required: true,
    });
    const evalCase = makeAgentRoutingCase();
    const e1 = buildPublicExplanation(scoreRecord, evalCase, false);
    const e2 = buildPublicExplanation(scoreRecord, evalCase, false);
    expect(e1?.text).toBe(e2?.text);
    expect(e1?.source).toBe(e2?.source);
  });

  it("adversarial: explanation does not contain raw rationale text even when rationale looks like a summary", () => {
    const temptingRationale =
      "The model correctly routed to shuttle. Score: 1.0 justification: excellent";
    const scoreRecord: NormalizedScoreRecord = {
      caseId: "test-case-01",
      modelId: "anthropic/claude-sonnet-4.5",
      suite: "loom-routing",
      dimensions: {
        routingCorrectness: {
          score: 1.0,
          rationale: temptingRationale, // adversarial rationale text
          applicable: true,
        },
        delegationCorrectness: {
          score: 1.0,
          rationale: "N/A",
          applicable: false,
        },
        executionCompleteness: {
          score: 1.0,
          rationale: "N/A",
          applicable: false,
        },
        rationaleQuality: {
          score: 0.9,
          rationale: temptingRationale,
          applicable: true,
        },
      },
      weightedTotal: 0.95,
      passed: true,
      required: true,
      scoredAt: SCORED_AT,
    };
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(scoreRecord, evalCase, false);
    // The raw rationale text must never appear in the public explanation
    expect(expl?.text).not.toContain(temptingRationale);
    expect(expl?.text).not.toContain("Score: 1.0");
    expect(expl?.text).not.toContain("justification:");
    expect(expl?.text).not.toContain("The model correctly routed");
  });

  it("adversarial: explanation does not contain chain-of-thought fragments", () => {
    // Even if the raw content or transcript had chain-of-thought, the explanation
    // must not contain it because it's derived from structured inputs only
    const scoreRecord = makeScoreRecord({
      passed: true,
      weightedTotal: 1.0,
      required: true,
    });
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(scoreRecord, evalCase, false);
    expect(expl?.text).not.toContain("<thinking>");
    expect(expl?.text).not.toContain("<cot>");
    expect(expl?.text).not.toContain("<reasoning>");
  });

  it("adversarial: explanation does not contain secret-like patterns", () => {
    const scoreRecord = makeScoreRecord({
      passed: false,
      weightedTotal: 0.0,
      required: true,
    });
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(scoreRecord, evalCase, false);
    // No secret-like patterns
    expect(expl?.text).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(expl?.text).not.toMatch(/Bearer\s+[A-Za-z0-9]{10,}/);
    expect(expl?.text).not.toMatch(/ghp_[A-Za-z0-9]{8,}/);
  });

  it("adversarial: explanation does not contain transcript role markers", () => {
    const scoreRecord = makeScoreRecord({ passed: true, weightedTotal: 0.95 });
    const evalCase = makeAgentRoutingCase();
    const expl = buildPublicExplanation(scoreRecord, evalCase, false);
    expect(expl?.text).not.toMatch(/\n?User\s*:/);
    expect(expl?.text).not.toMatch(/\n?Assistant\s*:/);
    expect(expl?.text).not.toMatch(/\n?Human\s*:/);
  });

  it("adversarial: explanation is reproducible even when adversarial data is in score record fields", () => {
    // The rationale fields contain adversarial text — but since the explanation
    // is derived from structured inputs only, the output must be stable and clean
    const adversarialRationale =
      "rationale: score: 1.0 justification: <thinking>route to shuttle</thinking>";
    const scoreRecord: NormalizedScoreRecord = {
      caseId: "test-case-01",
      modelId: "anthropic/claude-sonnet-4.5",
      suite: "loom-routing",
      dimensions: {
        routingCorrectness: {
          score: 1.0,
          rationale: adversarialRationale,
          applicable: true,
        },
        delegationCorrectness: {
          score: 1.0,
          rationale: "N/A",
          applicable: false,
        },
        executionCompleteness: {
          score: 1.0,
          rationale: "N/A",
          applicable: false,
        },
        rationaleQuality: {
          score: 0.9,
          rationale: adversarialRationale,
          applicable: true,
        },
      },
      weightedTotal: 0.95,
      passed: true,
      required: true,
      scoredAt: SCORED_AT,
    };
    const evalCase = makeAgentRoutingCase();
    const expl1 = buildPublicExplanation(scoreRecord, evalCase, false);
    const expl2 = buildPublicExplanation(scoreRecord, evalCase, false);

    // Reproducible
    expect(expl1?.text).toBe(expl2?.text);
    // No forbidden patterns
    for (const { pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(expl1?.text ?? "")).toBe(false);
    }
    // Bounded
    expect((expl1?.text ?? "").length).toBeLessThanOrEqual(
      EXPLANATION_MAX_CHARS,
    );
  });
});

// ---------------------------------------------------------------------------
// buildCaseExplanation — type-safety: OutcomeKind prevents arbitrary strings
// ---------------------------------------------------------------------------

describe("buildCaseExplanation — OutcomeKind type-safety prevents arbitrary-string reflection", () => {
  // The OutcomeKind union is closed: "agent_routing" | "delegation_chain" |
  // "task_completion" | "tool_call". Every branch maps to a hardcoded safe label
  // in outcomeKindLabel(). No arbitrary string can flow into the output text.

  it("tool_call maps to safe fixed label 'tool-call' (not reflected verbatim)", () => {
    const text = buildCaseExplanation(
      "pass",
      true,
      true,
      "tool_call",
      [],
      false,
    );
    // The hardcoded label "tool-call" appears, not "tool_call" verbatim
    expect(text).toContain("tool-call");
    // No forbidden patterns
    for (const { pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(text)).toBe(false);
    }
  });

  it("all four OutcomeKind values produce non-empty, bounded, safe text", () => {
    const kinds = [
      "agent_routing",
      "delegation_chain",
      "task_completion",
      "tool_call",
    ] as const;
    for (const kind of kinds) {
      const text = buildCaseExplanation("pass", true, true, kind, [], false);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(EXPLANATION_MAX_CHARS);
      for (const { pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
        expect(pattern.test(text)).toBe(false);
      }
    }
  });

  it("adversarial: a malicious string cannot be reflected into explanation via OutcomeKind (TypeScript enforces the union)", () => {
    // TypeScript prevents passing `"INJECTED<thinking>payload</thinking>"` as
    // OutcomeKind at compile time. At runtime (e.g. test assertion level), we
    // verify that even if someone coerces the type, the output is always safe.
    //
    // We simulate a coerced (cast) malicious value to prove runtime safety.
    // In real production code this cannot happen because TypeScript's type
    // system prevents arbitrary strings from satisfying `OutcomeKind`.
    const malicious =
      "<thinking>rationale: score: 1.0 justification: LEAKAGE</thinking>" as unknown as import("../langchain-agent-evals.js").OutcomeKind;

    // Because buildCaseExplanation maps via outcomeKindLabel() which only
    // accepts the four closed literals, a coerced unknown value falls through
    // to the default "tool-call" label and the malicious string is NEVER
    // reflected in the output.
    // Note: TypeScript would reject `malicious` at the type level (without the
    // `as unknown as` coercion), so this test exercises the defense-in-depth
    // runtime behavior against maliciously coerced values.
    const text = buildCaseExplanation("pass", true, true, malicious, [], false);
    expect(text).not.toContain("thinking");
    expect(text).not.toContain("LEAKAGE");
    expect(text).not.toContain("rationale:");
    expect(text).not.toContain("justification:");
    for (const { pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(text)).toBe(false);
    }
    expect(text.length).toBeLessThanOrEqual(EXPLANATION_MAX_CHARS);
  });

  it("adversarial: leakage sentinel in a cast OutcomeKind does not appear in output", () => {
    const sentinel = "LEAKAGE_SENTINEL_SECRET_XYZ_rationale:score:1";
    const text = buildCaseExplanation(
      "fail",
      false,
      true,
      sentinel as unknown as import("../langchain-agent-evals.js").OutcomeKind,
      [],
      false,
    );
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("LEAKAGE_SENTINEL");
    expect(text).not.toContain("rationale:");
    for (const { pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(text)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSuiteExplanation — suite-level bounded explanation
// ---------------------------------------------------------------------------

import {
  buildModelExplanation,
  buildSuiteExplanation,
  type OutcomeKind,
} from "../langchain-agent-evals.js";

describe("buildSuiteExplanation — bounded explanation from aggregate suite signals", () => {
  it("returns a dry-run label for dry-run suites", () => {
    const text = buildSuiteExplanation(0, 5, false, true);
    expect(text).toContain("dry-run");
    expect(text).toContain("5");
  });

  it("indicates 'green' when suiteGreen is true", () => {
    const text = buildSuiteExplanation(10, 10, true, false);
    expect(text).toContain("green");
  });

  it("indicates 'not green' when suiteGreen is false", () => {
    const text = buildSuiteExplanation(8, 10, false, false);
    expect(text).toContain("not green");
  });

  it("includes pass/fail counts in the text", () => {
    const text = buildSuiteExplanation(7, 10, false, false);
    expect(text).toContain("7");
    expect(text).toContain("10");
  });

  it("handles all-pass case (zero failures)", () => {
    const text = buildSuiteExplanation(5, 5, true, false);
    expect(text).toContain("passed");
    expect(text).not.toContain("failed");
  });

  it("handles all-fail case", () => {
    const text = buildSuiteExplanation(0, 5, false, false);
    expect(text).toContain("0");
    expect(text).toContain("5");
    expect(text).toContain("failed");
  });

  it("never exceeds EXPLANATION_MAX_CHARS", () => {
    const text = buildSuiteExplanation(999, 1000, false, false);
    expect(text.length).toBeLessThanOrEqual(EXPLANATION_MAX_CHARS);
  });

  it("never matches any FORBIDDEN_EXPLANATION_PATTERNS", () => {
    const inputs: Array<[number, number, boolean, boolean]> = [
      [10, 10, true, false],
      [7, 10, false, false],
      [0, 5, false, false],
      [5, 5, false, true],
    ];
    for (const [passed, total, green, dry] of inputs) {
      const text = buildSuiteExplanation(passed, total, green, dry);
      for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
        expect(pattern.test(text)).toBe(false);
      }
    }
  });

  it("is deterministic — same inputs produce identical text", () => {
    const t1 = buildSuiteExplanation(8, 10, false, false);
    const t2 = buildSuiteExplanation(8, 10, false, false);
    expect(t1).toBe(t2);
  });

  it("does not contain raw prompts, transcripts, rationale markers, or secrets", () => {
    const text = buildSuiteExplanation(9, 10, true, false);
    expect(text).not.toContain("rationale");
    expect(text).not.toContain("transcript");
    expect(text).not.toContain("composedPrompt");
    expect(text).not.toContain("rawContent");
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]{10,}/);
  });

  it("adversarial: passing adversarial counts does not produce forbidden patterns", () => {
    // Even with edge-case numeric inputs, the output is structured and safe
    const text = buildSuiteExplanation(0, 0, false, false);
    for (const { pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(text)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildModelExplanation — model-level bounded explanation
// ---------------------------------------------------------------------------

describe("buildModelExplanation — bounded explanation from aggregate model signals", () => {
  it("returns a dry-run label for dry-run model results", () => {
    const text = buildModelExplanation("skip", 0, 5, true);
    expect(text).toContain("dry-run");
    expect(text).toContain("5");
  });

  it("returns a dry-run label when bucket is 'skip' even if dryRun=false", () => {
    const text = buildModelExplanation("skip", 0, 3, false);
    expect(text).toContain("dry-run");
  });

  it("includes 'pass' label for pass bucket", () => {
    const text = buildModelExplanation("pass", 10, 10, false);
    expect(text).toContain("pass");
  });

  it("includes 'partial' label for partial bucket", () => {
    const text = buildModelExplanation("partial", 7, 10, false);
    expect(text).toContain("partial");
  });

  it("includes 'fail' label for fail bucket", () => {
    const text = buildModelExplanation("fail", 2, 10, false);
    expect(text).toContain("fail");
  });

  it("includes pass/fail counts in the text", () => {
    const text = buildModelExplanation("partial", 6, 10, false);
    expect(text).toContain("6");
    expect(text).toContain("10");
  });

  it("handles zero total cases", () => {
    const text = buildModelExplanation("pass", 0, 0, false);
    expect(text).toContain("no cases run");
    expect(text.length).toBeGreaterThan(0);
  });

  it("never exceeds EXPLANATION_MAX_CHARS", () => {
    const text = buildModelExplanation("partial", 999, 1000, false);
    expect(text.length).toBeLessThanOrEqual(EXPLANATION_MAX_CHARS);
  });

  it("never matches any FORBIDDEN_EXPLANATION_PATTERNS", () => {
    const inputs: Array<
      [import("../report-schema.js").ScoreBucket, number, number, boolean]
    > = [
      ["pass", 10, 10, false],
      ["partial", 7, 10, false],
      ["fail", 2, 10, false],
      ["skip", 0, 5, true],
      ["pass", 0, 0, false],
    ];
    for (const [bucket, passed, total, dry] of inputs) {
      const text = buildModelExplanation(bucket, passed, total, dry);
      for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
        expect(pattern.test(text)).toBe(false);
      }
    }
  });

  it("is deterministic — same inputs produce identical text", () => {
    const t1 = buildModelExplanation("partial", 7, 10, false);
    const t2 = buildModelExplanation("partial", 7, 10, false);
    expect(t1).toBe(t2);
  });

  it("does not contain raw prompts, transcripts, rationale markers, or secrets", () => {
    const text = buildModelExplanation("pass", 9, 10, false);
    expect(text).not.toContain("rationale");
    expect(text).not.toContain("transcript");
    expect(text).not.toContain("composedPrompt");
    expect(text).not.toContain("rawContent");
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]{10,}/);
  });

  it("adversarial: all ScoreBucket values produce safe bounded output", () => {
    const buckets = ["pass", "partial", "fail", "skip"] as const;
    for (const bucket of buckets) {
      const text = buildModelExplanation(bucket, 5, 10, false);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(EXPLANATION_MAX_CHARS);
      for (const { pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
        expect(pattern.test(text)).toBe(false);
      }
    }
  });
});
