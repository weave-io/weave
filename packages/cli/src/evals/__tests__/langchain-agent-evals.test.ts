/**
 * Unit tests for `langchain-agent-evals.ts` — the parts a user cannot observe.
 *
 * What the scorer promises a maintainer is asserted end to end in
 * [`tests/evals/scoring.scenario.test.ts`](../../../../../tests/evals/scoring.scenario.test.ts),
 * which drives a real `weave eval run` and reads the `score-<suite>.json` back:
 * which dimensions a case kind is graded on, the neutral 1.0 for the ones it is
 * not, the clamping of an out-of-range judge verdict, the rubric's weights, the
 * pass gate and its near-perfect primary rule, the missing-rubric failure, the
 * answer, rubric and criteria the judge is shown, and the explanation
 * published beside the case. The aggregate explanations are asserted against
 * `public-report.json` and the model-comparison index in
 * [`tests/evals/reporting.scenario.test.ts`](../../../../../tests/evals/reporting.scenario.test.ts).
 * A hundred cases that asserted those through direct calls were removed; every
 * scenario replacing one was watched fail against a mutated scorer first — the
 * table is in `docs/testing-strategy.md`.
 *
 * Seven of the hundred were not replaced, because they could not fail. The
 * `RealLangChainJudge — production adapter boundary` block asserted
 * `expect(judge).toBeDefined()` on a `new`, `expect(scorer).toBeDefined()` on
 * another, and `typeof x.then === "function"` twice — the compiler's job, or
 * true of any object. Its remaining two cases named `RealLangChainJudge` and
 * drove `StubLangChainJudge`: one set a default error on the stub and asserted
 * the stub returned it, under the name *"evaluate() returns a typed
 * ScorerAdapterError when openevals dynamic import fails"*. Its comment said
 * the dynamic import could not be intercepted, which the
 * `per-rubric evaluator isolation` block below disproves on the same page —
 * it injects a `moduleLoader` and has covered that failure for real all along.
 * The last of the seven, `satisfies <interface> — returns ResultAsync` on each
 * stub, duplicated the default-fallback case beside it. One honest replacement
 * was added: *"loads openevals on the first evaluate() and not before"*, which
 * an eager import in the constructor turns red.
 *
 * What is left here is deliberately internal. Each survivor, and why a run
 * cannot reach it:
 *
 *   - **`buildJudgmentExecutionDimension()` outside `task_completion`** — the
 *     scorer calls it only after `scoreExecution()` has already established
 *     that the case is a `task_completion` one, so its guard clause is
 *     unreachable from any run. It is exported, so the guard is worth pinning
 *     where a future caller would hit it.
 *   - **`RubricCaseMismatch`** — a runner builds its `ModelRunOutput` with
 *     `evalCase.id` as the `caseId`, and the scorer looks the rubric up by
 *     `run.caseId` and then compares it to `evalCase.id`. The two are the same
 *     string by construction, so the branch cannot fire in production. The
 *     *reachable* half of rubric lookup — no rubric at all — is a scenario.
 *   - **A non-applicable dimension's `rationale`** — `buildDimensionRationales()`
 *     in each runner copies a reason only for the dimensions that counted, so
 *     the scorer's "Not applicable: …" text reaches no file, not even a
 *     `--raw-artifacts` one. The rationale of an *applicable* dimension is a
 *     scenario. The case pinning it asserts the reason names the case kind it
 *     did not apply to; it used to assert `typeof rationale === "string"`,
 *     which no change to the scorer could have broken.
 *   - **An injected `scoredAt`** — the `AgentEvalsScorer` interface takes one,
 *     and no runner passes it; every production call takes the `new Date()`
 *     default. The default is a scenario; the parameter is only exercised here.
 *   - **The dry-run and `skip` branches of `buildCaseExplanation()` /
 *     `buildPublicExplanation()`** — every production caller passes
 *     `dryRun: false`; a dry run takes `buildDryRunResult()`, which builds no
 *     explanation at all. The same goes for `buildModelExplanation()`'s `skip`
 *     bucket.
 *   - **`source: "score_bucket_label"` on a case** — `rationaleQuality` is
 *     applicable on every case the scorer produces, so `applicableDimensions`
 *     is never empty and the branch is dead. The `structured_signal` branch is
 *     a scenario.
 *   - **The three-dimension cap and the `EXPLANATION_MAX_CHARS` truncations** —
 *     at most two dimensions are ever applicable, and the text these builders
 *     produce is a fixed template over integers and enum labels, so neither cap
 *     can be reached with real inputs. They are defence in depth, and these are
 *     the only tests that exercise one.
 *   - **`OutcomeKind` values no fixture can carry** — `tool_call` is rejected
 *     by the text-only fixture contract (`UnsupportedTextEvalAssertion`) and
 *     `harness_trajectory` needs a live harness, so the label mapping for them,
 *     and the behaviour on a kind cast in from outside the union, is only
 *     reachable by calling the function directly.
 *   - **`buildModelExplanation()` with zero cases** — the comparison index is
 *     built by iterating models that have results, so a model row always has at
 *     least one case.
 *   - **`StubLangChainJudge` and `StubAgentEvalsScorer`** — test
 *     infrastructure that happens to ship in `src`. Their FIFO ordering,
 *     default fallback, `NotConfigured` call index and `.calls` recording are a
 *     contract for test authors, not for users, and no scenario can assert
 *     them. `StubLangChainJudge` backs `tests/support/evals.ts`, so a
 *     regression in it would misreport every eval scenario.
 *   - **`RealLangChainJudge`** — the adapter boundary to `openevals/llm`. It is
 *     the judge acceptance harness's chat-model reference (not the judge
 *     `weave eval run` uses since task 16.4), which scenarios never run, so its
 *     laziness, its dynamic-import failure path, its per-rubric evaluator cache
 *     and the exact `{reference_outputs}` placeholder names it must use are
 *     only testable with an injected module loader. Every case that claims to
 *     test it now constructs one.
 *
 * Test isolation: no real LangChain, no network, no file I/O; fixtures inline.
 */

import { describe, expect, it } from "bun:test";
import {
  buildJudgmentExecutionDimension,
  escapeTemplateBraces,
  type JudgeInput,
  LangChainAgentEvalsScorer,
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

describe("buildJudgmentExecutionDimension", () => {
  it("is not applicable outside task_completion", () => {
    const dimension = buildJudgmentExecutionDimension(
      makeRun(),
      makeAgentRoutingCase({ tags: ["judgment"] }),
    );
    expect(dimension.applicable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — rubric lookup errors
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — rubric lookup errors", () => {
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
// LangChainAgentEvalsScorer — NormalizedScoreRecord shape
// ---------------------------------------------------------------------------

describe("LangChainAgentEvalsScorer — NormalizedScoreRecord shape", () => {
  it("says which kind of case a dimension did not apply to", async () => {
    const judge = makePerfectJudge();
    const scorer = new LangChainAgentEvalsScorer(judge);

    const result = await scorer.score(
      makeRun(),
      makeAgentRoutingCase(),
      [makeRubric()],
      SCORED_AT,
    );

    const record = result._unsafeUnwrap();
    expect(record.dimensions.delegationCorrectness.rationale).toBe(
      'Not applicable: outcome kind is "agent_routing", not "delegation_chain"',
    );
    expect(record.dimensions.executionCompleteness.rationale).toBe(
      'Not applicable: outcome kind is "agent_routing", not "task_completion"',
    );
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
      criteria: [],
    };
    const input2: JudgeInput = {
      dimension: "rationaleQuality",
      rubricDescription: "Quality check",
      response: "Good reasoning.",
      reference: "Evaluate quality",
      criteria: [],
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
      criteria: [],
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
      criteria: [],
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
      criteria: [],
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
      criteria: [],
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
      criteria: [],
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
      criteria: [],
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

/**
 * Minimal stand-in for the `BaseChatModel` `RealLangChainJudge` is handed.
 *
 * The judge stores the reference and passes it to `createLLMAsJudge` only when
 * `evaluate()` runs, so nothing here is ever called.
 */
class MockBaseChatModel {
  _modelType(): string {
    return "base_chat_model";
  }
  async invoke(_messages: unknown): Promise<unknown> {
    throw new Error("MockBaseChatModel.invoke should not be called in tests");
  }
}

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

  it("loads openevals on the first evaluate() and not before", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader, moduleLoadCount } = makeFakeModuleLoader();
    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    expect(moduleLoadCount.value).toBe(0);

    await judge.evaluate({
      dimension: "rationaleQuality",
      rubricDescription: "Evaluate the prose.",
      response: "r",
      reference: "ref",
      criteria: [],
    });

    expect(moduleLoadCount.value).toBe(1);
  });

  it("escapes braces and keeps $ sequences literal when a rubric contains code", async () => {
    const mockModel = new MockBaseChatModel();
    const { moduleLoader, factoryCallPrompts } = makeFakeModuleLoader();
    const judge = new RealLangChainJudge(
      mockModel as unknown as ConstructorParameters<
        typeof RealLangChainJudge
      >[0],
      moduleLoader,
    );

    const rubric =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${…}` from case code is the input under test.
      'Case: `if (x) { return err({ type: "NoSamples" }); }` and `${target}` or $\' here.';
    await judge.evaluate({
      dimension: "rationaleQuality",
      rubricDescription: rubric,
      response: "r",
      reference: "ref",
      criteria: [],
    });

    const prompt = factoryCallPrompts[0] ?? "";
    expect(prompt).toContain(escapeTemplateBraces(rubric));
    expect(prompt).toContain("{outputs}");
    expect(prompt).toContain("{reference_outputs}");

    // The escaped prompt must parse and render as a LangChain f-string template.
    const { PromptTemplate } = await import("@langchain/core/prompts");
    const rendered = await PromptTemplate.fromTemplate(prompt).format({
      outputs: "OUT",
      reference_outputs: "REF",
    });
    expect(rendered).toContain(rubric);
    expect(rendered).toContain("OUT");
  });

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
      criteria: [],
    });

    await judge.evaluate({
      dimension: "delegationCorrectness",
      rubricDescription: rubric2,
      response: "tapestry → shuttle",
      reference: "Expected chain: tapestry → shuttle",
      criteria: [],
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
      criteria: [],
    });

    // Second evaluate with rubric2 — must NOT reuse rubric1's evaluator
    const r2 = await judge.evaluate({
      dimension: "rationaleQuality",
      rubricDescription: rubric2,
      response: "response2",
      reference: "ref2",
      criteria: [],
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
      criteria: [],
    });
    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: sameRubric,
      response: "r2",
      reference: "ref",
      criteria: [],
    });
    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: sameRubric,
      response: "r3",
      reference: "ref",
      criteria: [],
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
      criteria: [],
    });
    await judge.evaluate({
      dimension: "delegationCorrectness",
      rubricDescription: "rubric-B",
      response: "rB",
      reference: "refB",
      criteria: [],
    });
    await judge.evaluate({
      dimension: "executionCompleteness",
      rubricDescription: "rubric-C",
      response: "rC",
      reference: "refC",
      criteria: [],
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
      criteria: [],
    });
    await judge.evaluate({
      dimension: "delegationCorrectness",
      rubricDescription: "rubric-Y",
      response: "r",
      reference: "ref",
      criteria: [],
    });
    // Same rubric as first call — must not add a new cache entry
    await judge.evaluate({
      dimension: "routingCorrectness",
      rubricDescription: "rubric-X",
      response: "r2",
      reference: "ref2",
      criteria: [],
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
      criteria: [],
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
      criteria: [],
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
      criteria: [],
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
      criteria: [],
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
      criteria: [],
    });

    const prompt = factoryCallPrompts[0];
    if (!prompt) throw new Error("factoryCallPrompts[0] not found");
    // Camelcase is the wrong variant — would cause LangChain template error
    expect(prompt).not.toContain("{referenceOutputs}");
  });
});

// ---------------------------------------------------------------------------
// buildCaseExplanation — the branches no run reaches
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
      expect(`${name}: ${pattern.test(text)}`).toBe(`${name}: false`);
    }
  });
});

// ---------------------------------------------------------------------------
// buildPublicExplanation — threads explanation into CaseResultSummary field
// ---------------------------------------------------------------------------

describe("buildPublicExplanation — CaseResultSummary.publicExplanation generation", () => {
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
} from "../langchain-agent-evals.js";

describe("buildSuiteExplanation — bounded explanation from aggregate suite signals", () => {
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
        expect(`${name}: ${pattern.test(text)}`).toBe(`${name}: false`);
      }
    }
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
  it("returns a dry-run label when bucket is 'skip' even if dryRun=false", () => {
    const text = buildModelExplanation("skip", 0, 3, false);
    expect(text).toContain("dry-run");
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
        expect(`${name}: ${pattern.test(text)}`).toBe(`${name}: false`);
      }
    }
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
