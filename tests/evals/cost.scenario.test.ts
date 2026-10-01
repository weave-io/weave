/**
 * Eval scenarios — what each attempt cost (Spec 39 task 0.6, gap G6).
 *
 * Bucket: evals. The seam is one `weave eval run` (`runEvalSuite`) with the
 * model stubbed and the production judge, `JevJudge`, behind the real scorer,
 * its decisions endpoint stubbed. Both stubs report usage the way OpenRouter
 * does, or leave it out.
 *
 * A model recommendation changes users' bills, so the evidence for one states
 * the candidate's cost per attempt against the current model's. The promises:
 *
 * - each attempt's score file row carries the model's prompt and completion
 *   tokens and cost, and the judge's separately;
 * - the cost is the one OpenRouter reported when it reported one, otherwise
 *   the tokens at the model's prices in `evals/model-matrix.json`, and the
 *   row says which;
 * - usage a provider left out is recorded as missing, never as zero;
 * - a retried call is part of the attempt's cost;
 * - the run report prints the mean cost per attempt of the model's calls and
 *   the judge's calls, marking a mean that leaves attempts out;
 * - nothing about usage or cost reaches the public report or the bundle
 *   index, whose schemas are unchanged.
 */

import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../packages/cli/src/evals/jev-judge.js";
import type { ModelUsage } from "../../packages/cli/src/evals/openrouter-client.js";
import {
  EVAL_MODEL,
  type FixtureSpec,
  runEvalSuite,
  type SuiteRunObservation,
  withEvalFixtures,
} from "../support/evals.js";

/** A task case the judge scores. */
const TASK: FixtureSpec = {
  id: "cost-complete-the-task",
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
const ANSWER = "Wrote plan_path and finished. task complete";

/** What OpenRouter charges for one judge call in these scenarios. */
const JUDGE_CALL_COST = 0.00002;

/** A decisions endpoint that passes every question and reports usage. */
function decisions(withUsage = true): { fetch: FetchLike; calls: number } {
  const stub = {
    calls: 0,
    fetch: (async () => undefined) as unknown as FetchLike,
  };
  stub.fetch = async (_url, init) => {
    stub.calls += 1;
    const body = JSON.parse(String(init.body)) as {
      model: string;
      questions: Record<string, unknown>;
    };
    const answers: Record<string, { type: "noul"; noul: number }> = {};
    for (const key of Object.keys(body.questions)) {
      answers[key] = { type: "noul", noul: 0.9 };
    }
    return Response.json({
      model: body.model,
      answers,
      ...(withUsage
        ? {
            usage: {
              input_tokens: 400,
              output_tokens: 50,
              cost: JUDGE_CALL_COST,
            },
          }
        : {}),
    });
  };
  return stub;
}

function costedRun(
  options: {
    modelUsage?: ModelUsage;
    judgeUsage?: boolean;
    extra?: Partial<Parameters<typeof runEvalSuite>[0]>;
  } = {},
): Promise<SuiteRunObservation & { judgeCallsMade: number }> {
  const endpoint = decisions(options.judgeUsage ?? true);
  return withEvalFixtures([TASK], async (evalsRoot) => {
    const observation = await runEvalSuite({
      evalsRoot,
      agent: TASK.suite,
      answers: [ANSWER],
      decisionsEndpoint: endpoint.fetch,
      ...(options.modelUsage !== undefined
        ? { modelUsage: options.modelUsage }
        : {}),
      ...options.extra,
    });
    return { ...observation, judgeCallsMade: endpoint.calls };
  });
}

describe("a run where OpenRouter reports what each call cost", () => {
  const modelUsage: ModelUsage = {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    costUsd: 0.0061,
  };

  it("stores the model's tokens and reported cost on the attempt's score file row", async () => {
    const run = await costedRun({ modelUsage });

    expect(run.firstCase?.usage?.model).toEqual({
      calls: 1,
      promptTokens: 1000,
      completionTokens: 200,
      costUsd: 0.0061,
      costSource: "provider",
    });
  });

  it("stores the judge's calls, tokens and cost separately from the model's", async () => {
    const run = await costedRun({ modelUsage });
    const judge = run.firstCase?.usage?.judge;

    expect(run.judgeCallsMade).toBeGreaterThan(0);
    expect(judge?.calls).toBe(run.judgeCallsMade);
    expect(judge?.promptTokens).toBe(400 * run.judgeCallsMade);
    expect(judge?.completionTokens).toBe(50 * run.judgeCallsMade);
    expect(judge?.costUsd).toBeCloseTo(
      JUDGE_CALL_COST * run.judgeCallsMade,
      12,
    );
    expect(judge?.costSource).toBe("provider");
  });

  it("prints the mean cost per attempt of the model's calls and of the judge's", async () => {
    const run = await costedRun({ modelUsage });

    expect(run.stdout).toContain("Cost per attempt (mean):");
    expect(run.stdout).toContain(EVAL_MODEL);
    expect(run.stdout).toContain(
      "model calls  $0.00610 (reported by OpenRouter)",
    );
    expect(run.stdout).toMatch(
      /judge calls {2}\$0\.0000\d+ \(reported by OpenRouter\)/,
    );
  });

  it("keeps usage and cost out of the public report and the bundle index", async () => {
    const run = await costedRun({ modelUsage });

    // Positive first: the score file carries the cost.
    expect(run.firstCase?.usage?.model?.costUsd).toBe(0.0061);
    for (const published of [run.publicReport, run.bundleIndex]) {
      expect(published).not.toBeNull();
      const text = JSON.stringify(published);
      expect(text).not.toContain("usage");
      expect(text).not.toContain("costUsd");
      expect(text).not.toContain("Tokens");
    }
  });
});

describe("a run where OpenRouter reports tokens but no cost", () => {
  it("costs the attempt at the model's matrix prices, and records that source", async () => {
    // Claude Sonnet 4.5 in evals/model-matrix.json: $3 in, $15 out per million.
    const run = await costedRun({
      modelUsage: {
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
      },
    });

    expect(run.firstCase?.usage?.model?.costSource).toBe("prices");
    expect(run.firstCase?.usage?.model?.costUsd).toBeCloseTo(0.006, 12);
    expect(run.stdout).toContain("model calls  $0.00600 (at matrix prices)");
  });
});

describe("a run where the provider reports no usage at all", () => {
  it("records the model's call without inventing tokens or a cost", async () => {
    const run = await costedRun({ judgeUsage: false });

    expect(run.firstCase?.usage?.model).toEqual({ calls: 1 });
    expect(run.firstCase?.usage?.judge.calls).toBe(run.judgeCallsMade);
    expect(run.firstCase?.usage?.judge).not.toHaveProperty("costUsd");
    expect(run.firstCase?.usage?.judge).not.toHaveProperty("promptTokens");
  });

  it("prints both costs as not recorded rather than as free", async () => {
    const run = await costedRun({ judgeUsage: false });

    expect(run.stdout).toContain("model calls  not recorded");
    expect(run.stdout).toContain("judge calls  not recorded");
    expect(run.stdout).not.toContain("$0 ");
  });
});

describe("a model that comes back empty once and answers when asked again", () => {
  it("counts both calls, the billed empty one included, in the attempt's cost", async () => {
    const run = await costedRun({
      modelUsage: {
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        costUsd: 0.006,
      },
      extra: {
        modelErrorsFirst: [
          {
            type: "EmptyResponse",
            message: "empty",
            usage: {
              promptTokens: 1000,
              completionTokens: 30,
              totalTokens: 1030,
              costUsd: 0.0035,
            },
          },
        ],
      },
    });

    expect(run.firstCase?.usage?.model).toEqual({
      calls: 2,
      promptTokens: 2000,
      completionTokens: 230,
      costUsd: 0.0095,
      costSource: "provider",
    });
  });
});
