/**
 * Evals scenarios — how a run turns an answer into a score.
 *
 * Bucket: Evals. The black box is **one `weave eval run` of one suite**, the
 * same seam [`suite-runners.scenario.test.ts`](suite-runners.scenario.test.ts)
 * uses. That file asks what a runner reads out of an answer; this one asks
 * what the scorer then does with it — which dimensions counted, what the
 * rubric's weights made of them, whether the case passed, and what the score
 * file says about it afterwards.
 *
 * Two things are stubbed because they are external services: the model and the
 * LLM judge. `LangChainAgentEvalsScorer` itself runs for real, so everything
 * below is the product's own arithmetic.
 *
 * ## What the seam makes observable
 *
 * - **`firstCase`** — one row of the `score-<suite>.json` a maintainer opens:
 *   `dimensionScores.<dim>.{score, applicable}`, `weightedTotal`, `passed`,
 *   `required`, `scoredAt`, and the `publicExplanation` a report renders.
 * - **`judgeCalls`** — every question the run put to the judge, with the
 *   rubric text, the answer itself, the reference and the criteria. This is what
 *   makes the scorer's *inputs* observable and not just its outputs: whether a
 *   dimension reached the judge at all, and what the judge was shown.
 * - **`rawArtifacts`** — under `--raw-artifacts`, the local-only diagnostic a
 *   scoring failure leaves behind.
 *
 * ## Which suite a scenario runs on, and why
 *
 * The scorer's behaviour depends on the case's `expected_outcome.kind`, and
 * the text-only fixture contract restricts which kinds a suite will accept:
 *
 * - `agent_routing` — `loom-routing`. Chosen over `tapestry-category-routing`
 *   because that suite's `mergeWithScorerDimensions()` overwrites the scorer's
 *   routing verdict with its own, so it would not be the scorer under test.
 * - `delegation_chain` and `task_completion` — `tapestry-execution`, the one
 *   text-only suite that accepts both, and which publishes the scorer's record
 *   unaltered.
 * - `tool_call` is rejected outright by the fixture contract
 *   (`UnsupportedTextEvalAssertion`), so no run can reach it.
 *
 * ## Absence assertions
 *
 * Every "this never appears" assertion here is paired with a positive one
 * showing the case was still scored and published — a run that fails to
 * assemble writes nothing at all and would satisfy the absence for the wrong
 * reason. See `docs/testing-strategy.md`, "A scenario can pass without testing
 * anything".
 */

import { describe, expect, it } from "bun:test";
import { FORBIDDEN_EXPLANATION_PATTERNS } from "../../packages/cli/src/evals/report-schema.js";
import {
  EVAL_MODEL,
  type FixtureSpec,
  runEvalSuite,
  type SuiteRunObservation,
  withEvalFixtures,
} from "../support/evals.js";

// ---------------------------------------------------------------------------
// One case of each kind, and the answer that satisfies it
// ---------------------------------------------------------------------------

/** A routing case, and an answer that routes where it asks. */
const ROUTING: FixtureSpec = {
  id: "scoring-route-to-shuttle",
  suite: "loom-routing",
  description: "Route this backend API task.",
  allowedAgents: ["loom", "shuttle", "thread"],
  expectedOutcome: { kind: "agent_routing", target_agent: "shuttle", via: [] },
  tags: ["routing"],
};
const ROUTED = "→ shuttle for the implementation.";

/** A delegation case, and an answer that expresses the chain it asks for. */
const DELEGATION: FixtureSpec = {
  id: "scoring-delegate-to-shuttle",
  suite: "tapestry-execution",
  description: "Delegate the remaining plan task.",
  allowedAgents: ["tapestry", "shuttle"],
  expectedOutcome: { kind: "delegation_chain", chain: ["tapestry", "shuttle"] },
  tags: ["execution"],
};
const DELEGATED = "Delegating now: tapestry → shuttle for this work.";

/** A task case the judge scores, and an answer that finishes the task. */
const TASK: FixtureSpec = {
  id: "scoring-complete-the-task",
  suite: "tapestry-execution",
  description: "Complete the remaining plan task.",
  allowedAgents: ["tapestry", "shuttle"],
  expectedOutcome: {
    kind: "task_completion",
    description: "Implement the feature",
    required_artifacts: ["plan_path"],
  },
  tags: ["execution"],
};
const COMPLETED = "Wrote plan_path and finished. task complete";

/** The `--agent` value that selects exactly the suite a fixture belongs to. */
function suiteOf(fixture: FixtureSpec): string {
  return fixture.suite;
}

/** Runs one fixture against one answer and reads the score file back. */
async function score(
  fixture: FixtureSpec,
  answer: string,
  options: Partial<Parameters<typeof runEvalSuite>[0]> = {},
): Promise<SuiteRunObservation> {
  return withEvalFixtures([fixture], (evalsRoot) =>
    runEvalSuite({
      evalsRoot,
      agent: suiteOf(fixture),
      answers: [answer],
      ...options,
    }),
  );
}

/** `[what the case expects, the fixture, the answer that satisfies it]`. */
const CASE_KINDS: Array<[string, FixtureSpec, string]> = [
  ["a route to one agent", ROUTING, ROUTED],
  ["a delegation chain", DELEGATION, DELEGATED],
  ["a finished task", TASK, COMPLETED],
];

// ===========================================================================
// Which dimensions a case is graded on
// ===========================================================================

describe("a case declares which kind of outcome it expects", () => {
  /** `[what the case expects, the one dimension that grades it]`. */
  const PRIMARY = {
    "a route to one agent": "routingCorrectness",
    "a delegation chain": "delegationCorrectness",
    "a finished task": "executionCompleteness",
  } as const;

  it.each(
    CASE_KINDS,
  )("grades %s on that dimension and no other structural one", async (kind, fixture, answer) => {
    const run = await score(fixture, answer);
    const scores = run.firstCase?.dimensionScores;
    const primary = PRIMARY[kind as keyof typeof PRIMARY];

    expect(scores?.[primary]?.applicable).toBe(true);
    for (const other of [
      "routingCorrectness",
      "delegationCorrectness",
      "executionCompleteness",
    ]) {
      if (other === primary) continue;
      expect(scores?.[other]?.applicable).toBe(false);
    }
  });

  it.each(
    CASE_KINDS,
  )("still grades the prose on %s, because every case has a rationale", async (_kind, fixture, answer) => {
    const run = await score(fixture, answer);

    expect(run.firstCase?.dimensionScores.rationaleQuality.applicable).toBe(
      true,
    );
  });

  it.each(
    CASE_KINDS,
  )("scores each dimension %s does not use 1.0, so an unused one never drags the total down", async (kind, fixture, answer) => {
    const run = await score(fixture, answer);
    const scores = run.firstCase?.dimensionScores;
    const primary = PRIMARY[kind as keyof typeof PRIMARY];

    for (const other of [
      "routingCorrectness",
      "delegationCorrectness",
      "executionCompleteness",
    ]) {
      if (other === primary) continue;
      expect(scores?.[other]).toEqual({ score: 1, applicable: false });
    }
  });

  it("publishes a score for all four dimensions whatever the case asked for", async () => {
    const run = await score(ROUTING, ROUTED);

    expect(Object.keys(run.firstCase?.dimensionScores ?? {}).sort()).toEqual([
      "delegationCorrectness",
      "executionCompleteness",
      "rationaleQuality",
      "routingCorrectness",
    ]);
  });
});

// ===========================================================================
// What the run asks the judge, and what it decides for itself
// ===========================================================================

describe("a scored case decides how much of the verdict the judge gets to set", () => {
  it("reads the route out of the answer itself, and asks the judge only about the prose", async () => {
    const run = await score(ROUTING, ROUTED);

    expect(run.judgeCalls.map((call) => call.dimension)).toEqual([
      "rationaleQuality",
    ]);
    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(1);
  });

  it("asks the judge about the chain as well, on a case that expects one", async () => {
    const run = await score(DELEGATION, DELEGATED);

    expect(run.judgeCalls.map((call) => call.dimension).sort()).toEqual([
      "delegationCorrectness",
      "rationaleQuality",
    ]);
  });

  it("asks the judge about the work as well, on a case that expects a finished task", async () => {
    const run = await score(TASK, COMPLETED);

    expect(run.judgeCalls.map((call) => call.dimension).sort()).toEqual([
      "executionCompleteness",
      "rationaleQuality",
    ]);
  });

  it("puts the expected chain to the judge as the reference, not as the answer", async () => {
    const run = await score(DELEGATION, DELEGATED);
    const call = run.judgeCalls.find(
      (c) => c.dimension === "delegationCorrectness",
    );

    expect(call?.reference).toBe("Expected chain: tapestry → shuttle");
    expect(call?.rubricDescription).toContain(
      "Expected delegation chain: tapestry → shuttle",
    );
    expect(call?.response).toBe(DELEGATED);
  });

  const OTHER_AGENT = "→ pattern should plan this one first.";

  it("gives a case full marks for an agent the fixture named as an accepted alternate", async () => {
    const run = await score(
      {
        ...ROUTING,
        id: "scoring-route-to-an-alternate",
        allowedAgents: ["loom", "shuttle", "pattern", "thread"],
        acceptedAlternates: ["pattern"],
      },
      OTHER_AGENT,
    );

    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(1);
    expect(run.firstCase?.passed).toBe(true);
  });

  it("scores the same answer zero when the fixture never accepted that agent", async () => {
    const run = await score(
      {
        ...ROUTING,
        id: "scoring-route-to-an-unaccepted-agent",
        allowedAgents: ["loom", "shuttle", "pattern", "thread"],
      },
      OTHER_AGENT,
    );

    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(0);
    expect(run.firstCase?.passed).toBe(false);
  });

  it("accepts a stop the case declared on the way, without the final target yet", async () => {
    const run = await score(
      {
        ...ROUTING,
        id: "scoring-route-through-a-declared-stop",
        expectedOutcome: {
          kind: "agent_routing",
          target_agent: "shuttle",
          via: ["thread"],
        },
      },
      "→ thread to gather the evidence first.",
    );

    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(1);
    expect(run.firstCase?.passed).toBe(true);
  });

  it("names the required artifacts to the judge on a task case", async () => {
    const run = await score(TASK, COMPLETED);
    const call = run.judgeCalls.find(
      (c) => c.dimension === "executionCompleteness",
    );

    expect(call?.reference).toBe(
      "Task: Implement the feature; required signals: [plan_path]",
    );
    expect(call?.criteria.map((c) => c.key)).toEqual(["plan_path"]);
    expect(call?.response).toBe(COMPLETED);
  });
});

// ===========================================================================
// Judgment cases: the run decides, the judge is not consulted
// ===========================================================================

describe("a case is tagged judgment, so the signals decide it rather than the judge", () => {
  const JUDGMENT: FixtureSpec = {
    ...TASK,
    id: "scoring-judgment-case",
    expectedOutcome: {
      kind: "task_completion",
      description: "Mark the task complete and do not re-delegate.",
      required_artifacts: [
        "tapestry_task_completed",
        "tapestry_task_not_redelegated",
      ],
    },
    tags: ["execution", "judgment"],
  };

  const BOTH_SIGNALS = [
    "Evidence matches the claim: 2 pass, 0 fail.",
    "- [x] 1/1 Add --json output",
    "TODO: DONE 1/1. No need to re-delegate.",
  ].join("\n");

  const ONE_SIGNAL = [
    "Evidence matches the claim: 2 pass, 0 fail.",
    "- [x] 1/1 Add --json output",
    "TODO: DONE 1/1. Re-delegating to shuttle to double-check the JSON shape.",
  ].join("\n");

  it("never asks the judge about the work, only about the prose", async () => {
    const run = await score(JUDGMENT, BOTH_SIGNALS);

    expect(run.judgeCalls.map((call) => call.dimension)).toEqual([
      "rationaleQuality",
    ]);
    expect(run.firstCase?.dimensionScores.executionCompleteness).toEqual({
      score: 1,
      applicable: true,
    });
  });

  it("gives partial credit for the fraction of the signals it did detect", async () => {
    const run = await score(JUDGMENT, ONE_SIGNAL);

    expect(run.firstCase?.dimensionScores.executionCompleteness.score).toBe(
      0.5,
    );
    expect(run.firstCase?.passed).toBe(false);
  });

  it("leaves the judge in charge on a task case that is not a judgment call", async () => {
    const run = await score(TASK, COMPLETED);

    expect(run.judgeCalls.map((call) => call.dimension)).toContain(
      "executionCompleteness",
    );
  });
});

// ===========================================================================
// A judge that answers outside the range it promised
// ===========================================================================

describe("the judge returns a score outside the range it promised", () => {
  it("publishes a score above one as one", async () => {
    const run = await score(ROUTING, ROUTED, {
      judgeOutput: { score: 1.5, rationale: "overshoot" },
    });

    expect(run.firstCase?.dimensionScores.rationaleQuality.score).toBe(1);
    expect(run.firstCase?.weightedTotal).toBe(1);
  });

  it("publishes a negative score as zero", async () => {
    const run = await score(ROUTING, ROUTED, {
      judgeOutput: { score: -0.5, rationale: "undershoot" },
    });

    expect(run.firstCase?.dimensionScores.rationaleQuality.score).toBe(0);
  });

  it("publishes a score already inside the range unchanged", async () => {
    const run = await score(ROUTING, ROUTED, {
      judgeOutput: { score: 0.75, rationale: "good" },
    });

    expect(run.firstCase?.dimensionScores.rationaleQuality.score).toBe(0.75);
  });
});

// ===========================================================================
// What the rubric's weights make of the dimension scores
// ===========================================================================

describe("a rubric decides how much the structural verdict counts", () => {
  it("scores a case one when everything that counted was perfect", async () => {
    const run = await score(ROUTING, ROUTED);

    expect(run.firstCase?.weightedTotal).toBe(1);
  });

  it("scores a case zero when everything that counted was wrong", async () => {
    const run = await score(TASK, "I could not work out what to do.", {
      judgeOutput: { score: 0, rationale: "nothing here" },
    });

    expect(run.firstCase?.weightedTotal).toBe(0);
  });

  it("weights the structural verdict and the prose as the rubric says", async () => {
    const run = await score(
      { ...TASK, outcomeWeight: 0.8, perExpectationWeight: 0.2 },
      COMPLETED,
      {
        judgeOutputs: {
          executionCompleteness: { score: 1, rationale: "done" },
          rationaleQuality: { score: 0, rationale: "terse" },
        },
      },
    );

    expect(run.firstCase?.weightedTotal).toBeCloseTo(0.8, 5);
  });

  it("reweights the same two scores when the rubric shifts the balance", async () => {
    const run = await score(
      { ...TASK, outcomeWeight: 0.2, perExpectationWeight: 0.8 },
      COMPLETED,
      {
        judgeOutputs: {
          executionCompleteness: { score: 1, rationale: "done" },
          rationaleQuality: { score: 0, rationale: "terse" },
        },
      },
    );

    expect(run.firstCase?.weightedTotal).toBeCloseTo(0.2, 5);
  });

  it.each(
    CASE_KINDS,
  )("keeps the total for %s inside [0, 1] even on a middling verdict", async (_kind, fixture, answer) => {
    const run = await score(fixture, answer, {
      judgeOutput: { score: 0.6, rationale: "partial" },
    });

    expect(run.firstCase?.weightedTotal).toBeGreaterThanOrEqual(0);
    expect(run.firstCase?.weightedTotal).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// The pass/fail gate
// ===========================================================================

describe("a required case is graded on its structural verdict, not on how it reads", () => {
  /** A task case whose two halves are weighted equally. */
  const EVEN: FixtureSpec = {
    ...TASK,
    id: "scoring-evenly-weighted",
    outcomeWeight: 0.5,
    perExpectationWeight: 0.5,
  };

  it("passes a case whose work was near-perfect even when the judge disliked the prose", async () => {
    const run = await score(EVEN, COMPLETED, {
      judgeOutputs: {
        executionCompleteness: { score: 0.95, rationale: "nearly there" },
        rationaleQuality: { score: 0, rationale: "unreadable" },
      },
    });

    expect(run.firstCase?.weightedTotal).toBeLessThan(0.5);
    expect(run.firstCase?.passed).toBe(true);
  });

  it("fails a case whose work was merely good, however well it reads", async () => {
    const run = await score(EVEN, COMPLETED, {
      judgeOutputs: {
        executionCompleteness: { score: 0.7, rationale: "partly done" },
        rationaleQuality: { score: 0.9, rationale: "reads well" },
      },
    });

    expect(run.firstCase?.weightedTotal).toBeGreaterThanOrEqual(0.5);
    expect(run.firstCase?.passed).toBe(false);
  });

  it("passes that same case once the rubric stops requiring it", async () => {
    const run = await score({ ...EVEN, required: false }, COMPLETED, {
      judgeOutputs: {
        executionCompleteness: { score: 0.7, rationale: "partly done" },
        rationaleQuality: { score: 0.9, rationale: "reads well" },
      },
    });

    expect(run.firstCase?.passed).toBe(true);
  });

  it("fails any case whose total falls below the pass mark, required or not", async () => {
    const run = await score({ ...TASK, required: false }, COMPLETED, {
      judgeOutput: { score: 0.2, rationale: "weak" },
    });

    expect(run.firstCase?.weightedTotal).toBeLessThan(0.5);
    expect(run.firstCase?.passed).toBe(false);
  });

  it("passes a case that lands exactly on the pass mark, when nothing requires it", async () => {
    const run = await score(
      {
        ...TASK,
        id: "scoring-exactly-on-the-mark",
        outcomeWeight: 1,
        perExpectationWeight: 0,
        required: false,
      },
      COMPLETED,
      {
        judgeOutputs: {
          executionCompleteness: { score: 0.5, rationale: "half" },
          rationaleQuality: { score: 0, rationale: "ignored" },
        },
      },
    );

    expect(run.firstCase?.weightedTotal).toBe(0.5);
    expect(run.firstCase?.passed).toBe(true);
  });

  it("fails the same case on the same mark once the rubric requires it", async () => {
    const run = await score(
      {
        ...TASK,
        id: "scoring-exactly-on-the-mark",
        outcomeWeight: 1,
        perExpectationWeight: 0,
        required: true,
      },
      COMPLETED,
      {
        judgeOutputs: {
          executionCompleteness: { score: 0.5, rationale: "half" },
          rationaleQuality: { score: 0, rationale: "ignored" },
        },
      },
    );

    expect(run.firstCase?.weightedTotal).toBe(0.5);
    expect(run.firstCase?.passed).toBe(false);
  });

  it.each([
    ["requires the case", true],
    ["does not require the case", false],
  ])("publishes that the rubric %s", async (_label, required) => {
    const run = await score({ ...ROUTING, required }, ROUTED);

    expect(run.firstCase?.required).toBe(required);
  });
});

// ===========================================================================
// The rubric a case is scored against is missing
// ===========================================================================

describe("a case has no rubric to be scored against", () => {
  const ORPHAN: FixtureSpec = {
    ...ROUTING,
    id: "scoring-case-without-a-rubric",
    withoutRubric: true,
  };

  it("reports the case as errored, not failed, rather than dropping it from the run", async () => {
    const run = await score(ORPHAN, ROUTED);

    expect(run.stdout).toContain(
      `ERROR scoring-case-without-a-rubric on ${EVAL_MODEL}`,
    );
    expect(run.stdout).toContain("Not scored: scoring-rubric-missing");
    expect(run.stdout).toContain("1 case, 0 passed, 0 failed, 1 errored");
    expect(run.exitCode).toBe(1);
  });

  it("publishes it beside the scored cases as errored, with every dimension inapplicable", async () => {
    const run = await withEvalFixtures([ORPHAN, ROUTING], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: [ROUTED],
      }),
    );
    const orphan = run.cases.find(
      (row) => row.caseId === "scoring-case-without-a-rubric",
    );

    expect(orphan?.errored).toBe(true);
    expect(orphan?.errorClassification).toBe("scoring-rubric-missing");
    expect(orphan?.passed).toBe(false);
    expect(orphan?.dimensionScores.routingCorrectness).toEqual({
      score: 0,
      applicable: false,
    });
    expect(orphan?.dimensionScores.rationaleQuality).toEqual({
      score: 0,
      applicable: false,
    });
    expect(run.scoreFile?.totals).toMatchObject({
      totalCases: 2,
      passedCases: 1,
      failedCases: 0,
      erroredCases: 1,
      suiteGreen: false,
    });
  });

  it("tells a maintainer which rubric file is missing, in the local diagnostic", async () => {
    const run = await score(ORPHAN, ROUTED, { rawArtifacts: true });
    const errorSummary = run.rawArtifacts[0]?.errorSummary;

    expect(errorSummary?.errorType).toBe("RubricNotFound");
    expect(errorSummary?.classification).toBe("scoring-rubric-missing");
    expect(errorSummary?.localDiagnostic).toContain(
      "scoring-case-without-a-rubric",
    );
  });

  it("scores the same case normally once a rubric names it", async () => {
    const run = await score(
      { ...ORPHAN, withoutRubric: false, rubricCaseId: ORPHAN.id },
      ROUTED,
    );

    expect(run.firstCase?.passed).toBe(true);
    expect(run.firstCase?.dimensionScores.routingCorrectness.applicable).toBe(
      true,
    );
  });

  it("does not match a rubric that names a different case", async () => {
    const run = await score(
      { ...ORPHAN, withoutRubric: false, rubricCaseId: "some-other-case" },
      ROUTED,
      { rawArtifacts: true },
    );

    expect(run.rawArtifacts[0]?.errorSummary?.errorType).toBe("RubricNotFound");
  });
});

// ===========================================================================
// One of the two questions to the judge fails
// ===========================================================================

describe("the judge answers one question and fails the other", () => {
  const JUDGE_FAILED = {
    type: "ScorerAdapterError" as const,
    caseId: "scoring-delegate-to-shuttle",
    dimension: "rationaleQuality" as const,
    message: "judge transport failed",
  };

  it("reports the whole case as errored rather than publishing the half it did get", async () => {
    const run = await score(DELEGATION, DELEGATED, {
      judgeOutputs: {
        delegationCorrectness: { score: 1, rationale: "chain is right" },
      },
      judgeErrors: { rationaleQuality: JUDGE_FAILED },
    });

    expect(run.stdout).toContain(`ERROR scoring-delegate-to-shuttle`);
    expect(run.stdout).toContain("Not scored: scoring-adapter-failure");
    expect(run.stdout).not.toContain("delegationCorrectness");
    expect(run.exitCode).toBe(1);
  });

  it("scores the same case normally when both questions are answered", async () => {
    const run = await score(DELEGATION, DELEGATED, {
      judgeOutputs: {
        delegationCorrectness: { score: 1, rationale: "chain is right" },
      },
    });

    expect(run.firstCase?.passed).toBe(true);
    expect(
      run.firstCase?.dimensionScores.delegationCorrectness.applicable,
    ).toBe(true);
  });
});

// ===========================================================================
// What the judge is shown of the answer
// ===========================================================================

/**
 * Since Spec 37 task 16.4 the judge reads the agent's actual answer, with the
 * rubric, the reference and the yes/no criteria derived from the case. Before
 * it, the judge saw only a summary of which runner signals fired, so it could
 * not check anything the signals did not already say.
 */
describe("the judge reads the answer itself", () => {
  const SECRET = "sk-secret-api-key-sentinel";

  /** The question a run put to the judge about the prose. */
  function proseQuestion(run: SuiteRunObservation) {
    return run.judgeCalls.find((call) => call.dimension === "rationaleQuality");
  }

  it("shows it the answer word for word, on every dimension it judges", async () => {
    const run = await score(TASK, COMPLETED);

    expect(run.judgeCalls.length).toBe(2);
    for (const call of run.judgeCalls) {
      expect(call.response).toBe(COMPLETED);
    }
  });

  it("gives it the case's reviewer notes in the rubric it reads", async () => {
    const run = await score(
      {
        ...TASK,
        id: "scoring-task-with-notes",
        notes: "Every command the plan names must be one the case lists.",
      },
      COMPLETED,
    );

    for (const call of run.judgeCalls) {
      expect(call.rubricDescription).toContain(
        "Reviewer notes: Every command the plan names must be one the case lists.",
      );
      expect(call.rubricDescription).toContain(
        "Case: Complete the remaining plan task.",
      );
    }
  });

  it("asks a routing case whether it routed to an accepted target and justified it", async () => {
    const run = await score(ROUTING, ROUTED);
    const question = proseQuestion(run);

    expect(question?.criteria.map((c) => c.key)).toEqual([
      "routes_to_accepted_target",
      "justifies_routing",
    ]);
    expect(question?.criteria[0]?.question).toBe(
      'Does the response make a clear routing decision to one of: "shuttle"?',
    );
    expect(question?.reference).toBe('Expected: route to "shuttle"');
  });

  it("asks any other case whether the answer is coherent, relevant and detailed", async () => {
    const question = proseQuestion(await score(TASK, COMPLETED));

    expect(question?.criteria.map((c) => c.key)).toEqual([
      "rationale_coherent",
      "rationale_relevant",
      "rationale_detailed",
    ]);
    expect(question?.reference).toBe(
      "Evaluate quality for: Complete the remaining plan task.",
    );
  });

  it("keeps what the judge was shown out of every published file", async () => {
    const answer = `→ shuttle. My key is ${SECRET} and here is my reasoning.`;
    const run = await score(ROUTING, answer);

    // Positive first: the judge really was shown the answer, and the case
    // was scored and published, so the absence below is about publishing.
    expect(proseQuestion(run)?.response).toBe(answer);
    expect(run.firstCase?.dimensionScores.rationaleQuality.applicable).toBe(
      true,
    );
    expect(run.publishedText).not.toContain(SECRET);
    expect(run.publishedText).not.toContain("here is my reasoning");
  });
});

// ===========================================================================
// The explanation published beside a case
// ===========================================================================

describe("a reader opens the score file and wants to know why a case scored what it did", () => {
  it.each([
    ["a route to one agent", ROUTING, ROUTED, "routing", "routingCorrectness"],
    [
      "a delegation chain",
      DELEGATION,
      DELEGATED,
      "delegation",
      "delegationCorrectness",
    ],
    ["a finished task", TASK, COMPLETED, "execution", "executionCompleteness"],
  ])("names what %s was about, and which dimensions counted", async (_kind, fixture, answer, label, dimension) => {
    const run = await score(fixture as FixtureSpec, answer as string);
    const text = run.firstCase?.publicExplanation?.text;

    expect(text).toContain(`${label} case`);
    expect(text).toContain(dimension);
    expect(text).toContain("rationaleQuality");
  });

  it.each([
    [
      "passed",
      1,
      "required execution case passed; dimensions: executionCompleteness, rationaleQuality",
    ],
    [
      "partially passed",
      0.6,
      "required execution case partially passed; dimensions: executionCompleteness, rationaleQuality",
    ],
    [
      "failed",
      0,
      "required execution case failed; dimensions: executionCompleteness, rationaleQuality",
    ],
  ])("says a case that %s did so, in full", async (_label, judgeScore, expected) => {
    const run = await score(TASK, COMPLETED, {
      judgeOutput: { score: judgeScore as number, rationale: "verdict" },
    });

    expect(run.firstCase?.publicExplanation?.text).toBe(expected as string);
  });

  it.each([
    ["required", true, "required"],
    ["optional", false, "optional"],
  ])("says the case was %s", async (_label, required, word) => {
    const run = await score(
      { ...ROUTING, required: required as boolean },
      ROUTED,
    );

    expect(run.firstCase?.publicExplanation?.text).toContain(word as string);
  });

  it("declares the explanation was built from structured signals", async () => {
    const run = await score(ROUTING, ROUTED);

    expect(run.firstCase?.publicExplanation?.source).toBe("structured_signal");
  });

  it("writes the same explanation for the same case twice running", async () => {
    const first = await score(ROUTING, ROUTED);
    const second = await score(ROUTING, ROUTED);

    expect(first.firstCase?.publicExplanation?.text).toBe(
      second.firstCase?.publicExplanation?.text as string,
    );
  });

  it("quotes neither the answer nor the judge's rationale", async () => {
    const run = await score(
      ROUTING,
      "→ shuttle. <thinking>ANSWER-LEAK</thinking> My key is sk-leak-0123456789.",
      {
        judgeOutput: { score: 1, rationale: "RATIONALE-LEAK: it routed well" },
      },
    );
    const text = run.firstCase?.publicExplanation?.text ?? "";

    // Positive first — the explanation exists at all, so the absences below
    // are about what it withheld.
    expect(text).toContain("routing case");
    expect(text).not.toContain("ANSWER-LEAK");
    expect(text).not.toContain("RATIONALE-LEAK");
    expect(text).not.toContain("sk-leak-0123456789");
    for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(`${name}:${pattern.test(text)}`).toBe(`${name}:false`);
    }
  });
});

// ===========================================================================
// When the case was scored
// ===========================================================================

describe("a maintainer wants to know when a case was scored", () => {
  it("stamps every case with a readable time", async () => {
    const before = Date.now();
    const run = await score(ROUTING, ROUTED);
    const stamped = new Date(run.firstCase?.scoredAt ?? "").getTime();

    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
  });

  /**
   * `buildDimensionRationales()` copies a reason only for the dimensions that
   * counted, so the artifact carries two on a routing case. The reason the
   * scorer writes for a dimension that did *not* count ("Not applicable: …")
   * reaches no file, which is why `langchain-agent-evals.test.ts` still pins
   * it directly.
   */
  it("keeps the reason behind every dimension that counted, in the local artifact", async () => {
    const run = await score(ROUTING, ROUTED, { rawArtifacts: true });
    const rationales = run.rawArtifacts[0]?.dimensionRationales ?? {};

    expect(Object.keys(rationales).sort()).toEqual([
      "rationaleQuality",
      "routingCorrectness",
    ]);
    expect(rationales.routingCorrectness).toContain("shuttle");
    expect(rationales.rationaleQuality).toBe("judge rationale");
  });

  it("names the case, the model and the suite alongside it", async () => {
    const run = await score(ROUTING, ROUTED);

    expect(run.firstCase?.caseId).toBe("scoring-route-to-shuttle");
    expect(run.firstCase?.modelId).toBe("anthropic/claude-sonnet-4.5");
    expect(run.scoreFile?.suite).toBe("loom-routing");
  });
});
