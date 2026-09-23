/**
 * Eval scenarios — a model gives no usable answer (Spec 37, task 16.5).
 *
 * Bucket: evals. The seam is one `weave eval run` with only the model and the
 * judge stubbed (`runEvalSuite`). The model stub stands in for what
 * `OpenRouterClient` returns when a reasoning model spends its whole token
 * budget reasoning: a typed `EmptyResponse` or `TruncatedResponse`.
 *
 * The promises: such an answer is reported as **errored**, never scored as a
 * model failure; the run asks again a bounded number of times first; and a
 * run in which nothing was scored can never look green or publish anything.
 */

import { describe, expect, it } from "bun:test";
import type { ModelClientError } from "../../packages/cli/src/evals/openrouter-client.js";
import {
  EVAL_MODEL,
  type FixtureSpec,
  runEvalSuite,
  type SuiteRunObservation,
  withEvalFixtures,
} from "../support/evals.js";

const CASE: FixtureSpec = {
  id: "errored-route-to-shuttle",
  suite: "loom-routing",
  description: "Route this backend API task.",
  allowedAgents: ["loom", "shuttle", "pattern", "thread"],
  expectedOutcome: { kind: "agent_routing", target_agent: "shuttle", via: [] },
  tags: ["routing"],
};

const SECOND_CASE: FixtureSpec = {
  ...CASE,
  id: "errored-route-to-shuttle-again",
  description: "Route this other backend API task.",
};

const RIGHT_ROUTE = "→ shuttle for the implementation.";

const EMPTY: ModelClientError = {
  type: "EmptyResponse",
  message: "OpenRouter returned a response with no usable content",
  finishReason: "stop",
};

const TRUNCATED: ModelClientError = {
  type: "TruncatedResponse",
  message: "The model reached its completion-token cap before answering.",
  usage: {
    promptTokens: 1785,
    completionTokens: 2048,
    totalTokens: 3833,
    reasoningTokens: 2048,
  },
};

function runCases(
  fixtures: FixtureSpec[],
  options: Partial<Parameters<typeof runEvalSuite>[0]>,
): Promise<SuiteRunObservation> {
  return withEvalFixtures(fixtures, (evalsRoot) =>
    runEvalSuite({
      evalsRoot,
      agent: "loom-routing",
      model: EVAL_MODEL,
      answers: [RIGHT_ROUTE],
      ...options,
    }),
  );
}

describe("a reasoning model returns an empty answer every time it is asked", () => {
  it("reports the case as errored, not as a failure", async () => {
    const run = await runCases([CASE], { modelError: EMPTY });

    expect(run.stdout).toContain(`ERROR ${CASE.id} on ${EVAL_MODEL}`);
    expect(run.stdout).toContain("Not scored: model-empty-response");
    expect(run.stdout).toContain("1 case, 0 passed, 0 failed, 1 errored");
    expect(run.stdout).not.toContain(`FAIL  ${CASE.id}`);
    expect(run.rollups).toEqual([
      {
        suite: "loom-routing",
        totalCases: 1,
        passedCases: 0,
        failedCases: 0,
        erroredCases: 1,
        suiteGreen: false,
      },
    ]);
  });

  it("asks three times in all before giving up", async () => {
    const run = await runCases([CASE], { modelError: EMPTY });

    expect(run.modelCalls).toHaveLength(3);
  });

  it("exits non-zero and says which suite has unscored cases", async () => {
    const run = await runCases([CASE], { modelError: EMPTY });
    const failure = run.partialFailures[0];

    expect(run.exitCode).toBe(1);
    expect(failure?.type).toBe("CasesErrored");
    expect(failure?.message).toContain('"loom-routing"');
    expect(failure?.message).toContain("model-empty-response ×1");
  });

  it("publishes the case as errored, with its classification, not as a zero score", async () => {
    const run = await runCases([CASE], { modelError: EMPTY });

    expect(run.firstCase).toMatchObject({
      caseId: CASE.id,
      passed: false,
      errored: true,
      errorClassification: "model-empty-response",
    });
    expect(run.publicReport?.suiteSummaries[0]?.cases[0]?.scoreBucket).toBe(
      "skip",
    );
  });
});

describe("a reasoning model runs out of tokens before it answers", () => {
  it("reports the case as errored with the truncation named", async () => {
    const run = await runCases([CASE], { modelError: TRUNCATED });

    expect(run.stdout).toContain("Not scored: model-truncated-response");
    expect(run.stdout).toContain("0 failed, 1 errored");
    expect(run.modelCalls).toHaveLength(3);
  });
});

describe("a reasoning model answers when asked again", () => {
  it("scores the answer that comes back, as if the first attempts never happened", async () => {
    const run = await runCases([CASE], {
      modelErrorsFirst: [EMPTY, TRUNCATED],
    });

    expect(run.modelCalls).toHaveLength(3);
    expect(run.stdout).toContain(`PASS  ${CASE.id} on ${EVAL_MODEL}`);
    expect(run.stdout).toContain("1 case, 1 passed, 0 failed");
    expect(run.stdout).not.toContain("ERROR ");
    expect(run.stdout).not.toMatch(/\d+ errored/);
    expect(run.firstCase?.passed).toBe(true);
    expect(run.firstCase?.errored).toBeUndefined();
    expect(run.exitCode).toBe(0);
  });
});

describe("the request to the model fails outright", () => {
  it("reports the case as errored without asking again", async () => {
    const run = await runCases([CASE], {
      modelError: { type: "NetworkError", message: "connect ECONNREFUSED" },
    });

    expect(run.modelCalls).toHaveLength(1);
    expect(run.stdout).toContain("Not scored: model-network-failure");
  });
});

describe("one case errors and another is scored", () => {
  /** The first case's three attempts come back empty; the second answers. */
  function mixedRun(): Promise<SuiteRunObservation> {
    return runCases([CASE, SECOND_CASE], {
      modelErrorsFirst: [EMPTY, EMPTY, EMPTY],
    });
  }

  it("publishes the errored case beside the scored one, marked and not counted as failed", async () => {
    const run = await mixedRun();
    const errored = run.cases.filter((row) => row.errored === true);
    const scored = run.cases.filter((row) => row.errored !== true);

    expect(run.cases).toHaveLength(2);
    expect(errored).toHaveLength(1);
    expect(errored[0]?.errorClassification).toBe("model-empty-response");
    expect(scored[0]?.passed).toBe(true);
    expect(run.scoreFile?.totals).toEqual({
      totalCases: 2,
      passedCases: 1,
      failedCases: 0,
      erroredCases: 1,
      suiteGreen: false,
    });
  });

  it("keeps the errored case in the public report, bucketed as unscored", async () => {
    const run = await mixedRun();
    const summary = run.publicReport?.suiteSummaries[0];
    const erroredEntry = summary?.cases.find((entry) => entry.errored === true);

    expect(summary?.cases).toHaveLength(2);
    expect(summary?.erroredCases).toBe(1);
    expect(summary?.failedCases).toBe(0);
    expect(erroredEntry?.scoreBucket).toBe("skip");
    expect(erroredEntry?.passed).toBe(false);
    expect(run.publicReport?.runSummary).toMatchObject({
      totalCases: 2,
      passedCases: 1,
      failedCases: 0,
      erroredCases: 1,
      allSuitesGreen: false,
    });
  });

  it("still exits non-zero, because not every case was measured", async () => {
    const run = await mixedRun();

    expect(run.stdout).toContain("2 cases, 1 passed, 0 failed, 1 errored");
    expect(run.exitCode).toBe(1);
  });
});

describe("every case in a local run errors", () => {
  it("cannot look green, and exits non-zero", async () => {
    const run = await runCases([CASE, SECOND_CASE], { modelError: TRUNCATED });

    expect(run.stdout).toContain("2 cases, 0 passed, 0 failed, 2 errored");
    expect(run.rollups.every((rollup) => !rollup.suiteGreen)).toBe(true);
    expect(run.publicReport?.runSummary).toMatchObject({
      passedCases: 0,
      failedCases: 0,
      erroredCases: 2,
      allSuitesGreen: false,
    });
    expect(run.exitCode).toBe(1);
  });

  it("still writes the run locally, every case marked errored, so it can be inspected and compared", async () => {
    const run = await runCases([CASE, SECOND_CASE], {
      modelError: TRUNCATED,
      rawArtifacts: true,
    });

    expect(run.cases.map((row) => row.errorClassification)).toEqual([
      "model-truncated-response",
      "model-truncated-response",
    ]);
    expect(run.rawArtifacts.map((raw) => raw.errorSummary?.errorType)).toEqual([
      "TruncatedResponse",
      "TruncatedResponse",
    ]);
    expect(run.stdout).toMatch(/Raw transcript: \S+\/raw\/case-/);
  });
});

describe("every case in a publish-mode run errors", () => {
  it("publishes nothing and indexes nothing, because nothing was scored", async () => {
    const run = await runCases([CASE, SECOND_CASE], {
      modelError: TRUNCATED,
      publish: true,
    });

    // Positive first: the run executed and reported both cases.
    expect(run.stdout).toContain("2 cases, 0 passed, 0 failed, 2 errored");
    expect(run.stdout).toContain("(no run written)");
    expect(run.published).toBe(0);
    expect(run.files).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it("still publishes a run in which one case was scored", async () => {
    const run = await runCases([CASE, SECOND_CASE], {
      modelErrorsFirst: [EMPTY, EMPTY, EMPTY],
      publish: true,
    });

    expect(run.published).toBe(1);
    expect(run.publicReport?.runSummary.erroredCases).toBe(1);
  });
});
