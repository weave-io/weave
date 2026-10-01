/**
 * Eval scenarios — running attempts concurrently (Spec 39, gap G7).
 *
 * Bucket: evals. The seam is one `weave eval run` (`runEvalSuite`) with the
 * model stubbed to answer each request from the request itself, after a
 * delay that differs per model and agent, so concurrent calls finish in a
 * different order than they started. The judge is the production `JevJudge`
 * behind the real scorer, its decisions endpoint stubbed and reporting usage.
 *
 * `--concurrency` exists so the full default matrix fits in a CI job. It is
 * a promise about wall time only. The promises:
 *
 * - a concurrent run writes the same score files, usage and cost rows,
 *   public report, bundle index and dashboard indexes as a sequential run of
 *   the same answers, and prints the same run report;
 * - each attempt's judge calls are costed on that attempt, not on whichever
 *   attempt happened to finish next;
 * - an attempt that errors leaves every other attempt measured, exactly as a
 *   sequential run would.
 */

import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../packages/cli/src/evals/jev-judge.js";
import type {
  ModelClientError,
  ModelRequest,
  ModelUsage,
} from "../../packages/cli/src/evals/openrouter-client.js";
import {
  type FixtureSpec,
  runEvalSuite,
  type SuiteRunObservation,
  withEvalFixtures,
} from "../support/evals.js";

/** One text case per suite, run on every model of the default matrix. */
const FIXTURES: FixtureSpec[] = [
  {
    id: "concurrency-loom-route",
    suite: "loom-routing",
    description: "Route this backend API task.",
    allowedAgents: ["loom", "shuttle", "thread"],
    expectedOutcome: {
      kind: "agent_routing",
      target_agent: "shuttle",
      via: [],
    },
    tags: ["routing"],
    inheritModels: true,
  },
  {
    id: "concurrency-tapestry-evidence",
    suite: "tapestry-execution",
    description: "Task [1/1]: Add --json output. Report: 2 pass, 0 fail.",
    allowedAgents: ["tapestry"],
    expectedOutcome: {
      kind: "task_completion",
      description: "Mark the task complete and do not re-delegate.",
      required_artifacts: [
        "tapestry_task_completed",
        "tapestry_task_not_redelegated",
      ],
    },
    tags: ["execution", "judgment"],
    inheritModels: true,
  },
  {
    id: "concurrency-weft-approval",
    suite: "weft-review",
    description: "Synthetic review of `packages/cli/src/evals/runner.ts`.",
    allowedAgents: ["weft"],
    expectedOutcome: {
      kind: "task_completion",
      description: "Emit a disciplined approval.",
      required_artifacts: [
        "review_verdict_present",
        "review_verdict_approve",
        "review_blockers_zero",
        "review_file_refs_present",
        "review_approval_disciplined",
      ],
    },
    tags: ["review", "judgment"],
    inheritModels: true,
  },
];

const GOOD: Record<string, string> = {
  loom: "→ shuttle for the implementation.",
  tapestry: [
    "Evidence matches the claim: 2 pass, 0 fail.",
    "- [x] 1/1 Add --json output",
    "TODO: DONE 1/1. No need to re-delegate.",
  ].join("\n"),
  weft: [
    "[APPROVE] The change is structurally sound.",
    "Reviewed files: `packages/cli/src/evals/runner.ts`, `evals/README.md`.",
    "No blocking issues found.",
  ].join("\n"),
};
const POOR = "I am not sure what to do here.";

const MODEL_USAGE: ModelUsage = {
  promptTokens: 1000,
  completionTokens: 200,
  totalTokens: 1200,
  costUsd: 0.0061,
};

/** The agent a request was composed for: the stub prompt is "You are <agent>." */
function agentOf(request: ModelRequest): string {
  const system = request.messages.find((m) => m.role === "system");
  return /You are ([a-z-]+)\./.exec(system?.content ?? "")?.[1] ?? "unknown";
}

/** A small stable number per string, for answers and delays. */
function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) % 9973;
  return value;
}

/** Some models answer well, some poorly; the same request always alike. */
function answerFor(request: ModelRequest): string | ModelClientError {
  const agent = agentOf(request);
  if (hash(`${request.model}:${agent}`) % 3 === 0) return POOR;
  return GOOD[agent] ?? POOR;
}

/** Up to 15 ms, varying per model and agent, so calls finish out of order. */
function answerDelayMs(request: ModelRequest): number {
  return hash(`${agentOf(request)}|${request.model}`) % 16;
}

/**
 * A decisions endpoint that reports usage, whose verdict and token counts
 * depend on the question — so a judge call costed on the wrong attempt
 * changes that attempt's row. It answers after a delay of its own, so other
 * attempts' calls land while an attempt is being judged, as they do live.
 */
function decisionsEndpoint(): FetchLike {
  return async (_url, init) => {
    const text = String(init.body);
    await Bun.sleep(hash(text) % 8);
    const body = JSON.parse(text) as {
      model: string;
      questions: Record<string, unknown>;
    };
    const answers: Record<string, { type: "noul"; noul: number }> = {};
    for (const key of Object.keys(body.questions)) {
      answers[key] = {
        type: "noul",
        noul: text.includes("not sure") ? 0.2 : 0.9,
      };
    }
    const inputTokens = 100 + (hash(text) % 400);
    return Response.json({
      model: body.model,
      answers,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 50,
        cost: inputTokens / 10_000_000,
      },
    });
  };
}

/** Timestamps differ between any two runs; nothing else may. */
function withoutTimestamps<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value).replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g,
      "<time>",
    ),
  );
}

/** What a reader of the run can see, with run-specific paths and times masked. */
function observable(run: SuiteRunObservation) {
  return withoutTimestamps({
    exitCode: run.exitCode,
    partialFailures: run.partialFailures,
    rollups: run.rollups,
    files: [...run.files].sort(),
    scoreFiles: run.scoreFiles,
    publicReport: run.publicReport,
    bundleIndex: run.bundleIndex,
    markdown: run.markdown,
    indexes: run.indexes,
    stdout: run.stdout.split(run.bundleRoot).join("<bundle-root>"),
    modelCalls: run.modelCalls.length,
    judgeCalls: run.judgeCalls.length,
  });
}

function runWith(
  concurrency: number | undefined,
  answer: (request: ModelRequest) => string | ModelClientError = answerFor,
): Promise<SuiteRunObservation> {
  return withEvalFixtures(FIXTURES, (evalsRoot) =>
    runEvalSuite({
      evalsRoot,
      wholeMatrix: true,
      track: "text",
      repeat: 2,
      ...(concurrency !== undefined ? { concurrency } : {}),
      answerFor: answer,
      answerDelayMs,
      modelUsage: MODEL_USAGE,
      decisionsEndpoint: decisionsEndpoint(),
    }),
  );
}

describe("a maintainer runs the text track with several attempts at once", () => {
  it("writes the same bundle, usage rows and run report as a sequential run", async () => {
    const sequential = await runWith(undefined);
    const concurrent = await runWith(6);

    // Positive first: the run measured every attempt, judged and costed.
    const rows = Object.values(concurrent.scoreFiles).flatMap(
      (file) => file.results,
    );
    expect(Object.keys(concurrent.scoreFiles)).toHaveLength(3);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.some((row) => row.passed)).toBe(true);
    expect(rows.some((row) => !row.passed)).toBe(true);
    expect(rows.every((row) => row.usage?.judge.costUsd !== undefined)).toBe(
      true,
    );
    expect(observable(concurrent)).toEqual(observable(sequential));
  });

  it("costs each attempt's judge calls on that attempt", async () => {
    const sequential = await runWith(1);
    const concurrent = await runWith(16);

    const judgeUsage = (run: SuiteRunObservation) =>
      Object.values(run.scoreFiles).flatMap((file) =>
        file.results.map((row) => [row.caseId, row.modelId, row.usage]),
      );
    expect(judgeUsage(concurrent)).toEqual(judgeUsage(sequential));
  });
});

describe("a concurrent run where one model fails on one suite", () => {
  const BROKEN_MODEL_ERROR: ModelClientError = {
    type: "HttpError",
    statusCode: 500,
    message: "OpenRouter returned HTTP 500: Internal Server Error",
  };

  /** The first model in the matrix fails every weft review; all else answers. */
  function brokenWeft(brokenModel: string) {
    return (request: ModelRequest): string | ModelClientError => {
      if (request.model === brokenModel && agentOf(request) === "weft") {
        return BROKEN_MODEL_ERROR;
      }
      return answerFor(request);
    };
  }

  it("measures every other attempt, and records the same errored rows as a sequential run", async () => {
    const probe = await runWith(undefined);
    const firstModel = probe.cases[0]?.modelId;
    expect(firstModel).toBeDefined();
    const broken = brokenWeft(firstModel ?? "");

    const sequential = await runWith(undefined, broken);
    const concurrent = await runWith(6, broken);

    const rows = Object.values(concurrent.scoreFiles).flatMap(
      (file) => file.results,
    );
    const errored = rows.filter((row) => row.errored === true);
    expect(errored).toHaveLength(2);
    expect(errored.every((row) => row.modelId === firstModel)).toBe(true);
    expect(rows.length - errored.length).toBeGreaterThan(30);
    expect(observable(concurrent)).toEqual(observable(sequential));
  });
});
