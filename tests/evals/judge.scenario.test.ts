/**
 * Eval scenarios — the judge (Spec 37, task 16.4).
 *
 * Bucket: evals. The seam is one `weave eval run` (`runEvalSuite`) with the
 * production judge, `JevJudge`, behind the real scorer. The one thing
 * stubbed besides the model is the external service the judge calls:
 * OpenRouter's decisions endpoint, replaced by an injected `fetch` that
 * answers like TypeSafe Jev and records every request it receives.
 *
 * The promises:
 *
 * - the judge reads the case's rubric, its reference and the agent's actual
 *   answer, and is asked one question per criterion plus an overall one, of
 *   the pinned version;
 * - its overall answer decides the verdict at 0.5, on a task case and
 *   through the category-routing gate alike;
 * - a judge that fails, answers as another version, or cannot be given the
 *   whole answer leaves the case **errored**, never failed;
 * - the run records which judge scored it, in every file `eval compare`
 *   reads, and publishes nothing the judge said beyond that.
 */

import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../../packages/cli/src/evals/jev-judge.js";
import {
  type FixtureSpec,
  JEV_TEST_JUDGE,
  runEvalSuite,
  type SuiteRunObservation,
  withEvalFixtures,
} from "../support/evals.js";

/** A task case the judge scores (no `judgment` tag). */
const TASK: FixtureSpec = {
  id: "judge-complete-the-task",
  suite: "tapestry-execution",
  description: "Complete the remaining plan task.",
  allowedAgents: ["tapestry", "shuttle"],
  expectedOutcome: {
    kind: "task_completion",
    description: "Implement the feature",
    required_artifacts: ["plan_path"],
  },
  tags: ["execution"],
  notes: "Every command the answer names must be one the case lists.",
};
const ANSWER = "Wrote plan_path and finished. task complete";

/** A category-routing case whose required gate is the judge's verdict. */
const ROUTE: FixtureSpec = {
  id: "judge-route-frontend",
  suite: "tapestry-category-routing",
  description: "Route the settings panel styling change.",
  allowedAgents: ["tapestry", "shuttle", "shuttle-client-frontend"],
  expectedOutcome: {
    kind: "agent_routing",
    target_agent: "shuttle-client-frontend",
    via: [],
  },
  transcriptExpectations: [
    { check: "agent_mentioned", agent_name: "shuttle-client-frontend" },
  ],
  tags: ["routing"],
};
const ROUTED = "→ shuttle-client-frontend for `src/Client/Settings.tsx`.";

interface DecisionsStub {
  fetch: FetchLike;
  /** Every request body the endpoint received, parsed. */
  requests: Array<{
    url: string;
    authorization: string | null;
    body: {
      model: string;
      state: string;
      questions: Record<string, { type: string; instructions: string }>;
    };
  }>;
}

/**
 * A decisions endpoint that answers every question it is asked: `overall`
 * with `overall`, every criterion with `criterion`, as `model`.
 */
function decisions(
  options: {
    overall?: number;
    criterion?: number;
    status?: number;
    model?: string;
    rawBody?: string;
  } = {},
): DecisionsStub {
  const requests: DecisionsStub["requests"] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(
      String(init.body),
    ) as DecisionsStub["requests"][number]["body"];
    const headers = new Headers(init.headers);
    requests.push({ url, authorization: headers.get("Authorization"), body });
    if (options.status !== undefined) {
      return new Response("upstream says no: sk-or-v1-abcdef0123456789", {
        status: options.status,
      });
    }
    if (options.rawBody !== undefined) {
      return new Response(options.rawBody, { status: 200 });
    }
    const answers: Record<string, { type: "noul"; noul: number }> = {};
    for (const key of Object.keys(body.questions)) {
      const value =
        key === "overall"
          ? (options.overall ?? 0.9)
          : (options.criterion ?? 0.9);
      answers[key] = { type: "noul", noul: value };
    }
    return Response.json({
      model: options.model ?? body.model,
      answers,
      usage: { input_tokens: 300, output_tokens: 40, cost: 0.00001 },
    });
  };
  return { fetch, requests };
}

function judged(
  fixture: FixtureSpec,
  answer: string,
  endpoint: DecisionsStub,
  extra: Partial<Parameters<typeof runEvalSuite>[0]> = {},
): Promise<SuiteRunObservation> {
  return withEvalFixtures([fixture], (evalsRoot) =>
    runEvalSuite({
      evalsRoot,
      agent: fixture.suite,
      answers: [answer],
      decisionsEndpoint: endpoint.fetch,
      ...extra,
    }),
  );
}

// ===========================================================================
// What the judge is sent
// ===========================================================================

describe("the judge scores a task case", () => {
  it("is sent the rubric, the reference and the answer itself, as the pinned version", async () => {
    const endpoint = decisions();
    await judged(TASK, ANSWER, endpoint);
    const execution = endpoint.requests.find(
      (r) => "plan_path" in r.body.questions,
    );

    expect(execution?.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(execution?.authorization).toBe("Bearer test-key");
    expect(execution?.body.model).toBe(JEV_TEST_JUDGE.version);
    expect(execution?.body.state).toContain(
      "Case: Complete the remaining plan task.",
    );
    expect(execution?.body.state).toContain(
      "Reviewer notes: Every command the answer names must be one the case lists.",
    );
    expect(execution?.body.state).toContain(
      "Task: Implement the feature; required signals: [plan_path]",
    );
    expect(execution?.body.state).toContain(`# Agent response\n${ANSWER}`);
  });

  it("is asked one yes/no question per required signal, and the overall one", async () => {
    const endpoint = decisions();
    await judged(TASK, ANSWER, endpoint);
    const execution = endpoint.requests.find(
      (r) => "plan_path" in r.body.questions,
    );

    expect(Object.keys(execution?.body.questions ?? {})).toEqual([
      "plan_path",
      "overall",
    ]);
    for (const question of Object.values(execution?.body.questions ?? {})) {
      expect(question.type).toBe("noul");
    }
    expect(execution?.body.questions.overall?.instructions).toContain(
      "Would a careful reviewer applying the rubric accept the agent response as passing this case?",
    );
  });
});

// ===========================================================================
// What its answer decides
// ===========================================================================

describe("the judge's overall answer decides a task case", () => {
  it("passes the case when the overall answer is at least one half", async () => {
    const run = await judged(TASK, ANSWER, decisions({ overall: 0.62 }));

    expect(run.firstCase?.passed).toBe(true);
    expect(run.firstCase?.errored).toBeUndefined();
    expect(
      run.firstCase?.dimensionScores.executionCompleteness.score,
    ).toBeGreaterThanOrEqual(0.95);
  });

  it("fails the case, as scored, when the overall answer is below one half", async () => {
    const run = await judged(TASK, ANSWER, decisions({ overall: 0.41 }));

    expect(run.firstCase?.passed).toBe(false);
    expect(run.firstCase?.errored).toBeUndefined();
    expect(run.firstCase?.dimensionScores.executionCompleteness.score).toBe(
      0.41,
    );
  });

  it("names the criteria that failed in the local rationale, and nothing the judge wrote", async () => {
    const run = await judged(
      TASK,
      ANSWER,
      decisions({ overall: 0.2, criterion: 0.1 }),
      { rawArtifacts: true },
    );
    const rationale =
      run.rawArtifacts[0]?.dimensionRationales.executionCompleteness ?? "";

    expect(rationale).toBe(
      "Judge verdict: fail (overall 0.20 < 0.50). Criteria below 0.50: plan_path (0.10).",
    );
  });
});

describe("the judge's overall answer is the category-routing gate", () => {
  it("passes a correct route the judge accepts, even at an overall answer below the 0.7 gate", async () => {
    const run = await judged(ROUTE, ROUTED, decisions({ overall: 0.6 }));

    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(1);
    expect(run.firstCase?.passed).toBe(true);
  });

  it("fails the same correct route when the judge does not accept it", async () => {
    const run = await judged(ROUTE, ROUTED, decisions({ overall: 0.45 }));

    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(1);
    expect(run.firstCase?.passed).toBe(false);
    expect(run.firstCase?.errored).toBeUndefined();
  });
});

// ===========================================================================
// When the judge cannot give a verdict
// ===========================================================================

describe("the judge cannot give a verdict", () => {
  it("reports the case as errored, not failed, when the endpoint returns an error", async () => {
    const run = await judged(TASK, ANSWER, decisions({ status: 503 }));

    expect(run.firstCase?.errored).toBe(true);
    expect(run.firstCase?.errorClassification).toBe("judge-http-failure");
    expect(run.rollups[0]?.failedCases).toBe(0);
    expect(run.rollups[0]?.erroredCases).toBe(1);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("the request to the judge failed");
    expect(run.publishedText).not.toContain("upstream says no");
    expect(run.publishedText).not.toContain("sk-or-v1-abcdef");
  });

  it("reports a category-routing case with a correct route as errored too", async () => {
    const run = await judged(ROUTE, ROUTED, decisions({ status: 500 }));

    expect(run.firstCase?.errored).toBe(true);
    expect(run.firstCase?.errorClassification).toBe("judge-http-failure");
  });

  it("reports the case as errored when the judge answers as a version other than the pinned one", async () => {
    const run = await judged(
      TASK,
      ANSWER,
      decisions({ model: "typesafe/jev-1.14-20261201" }),
    );

    expect(run.firstCase?.errored).toBe(true);
    expect(run.firstCase?.errorClassification).toBe("judge-response-invalid");
  });

  it("reports the case as errored when the judge's answer is not JSON", async () => {
    const run = await judged(TASK, ANSWER, decisions({ rawBody: "<html>" }));

    expect(run.firstCase?.errored).toBe(true);
    expect(run.firstCase?.errorClassification).toBe("judge-response-invalid");
  });

  it("refuses an answer too long for the judge to read whole, without truncating or sending it", async () => {
    const endpoint = decisions();
    const run = await judged(
      TASK,
      `${ANSWER}\n${"x".repeat(100_000)}`,
      endpoint,
    );

    expect(run.firstCase?.errored).toBe(true);
    expect(run.firstCase?.errorClassification).toBe("judge-input-too-long");
    expect(
      endpoint.requests.some((r) => r.body.state.includes("x".repeat(1000))),
    ).toBe(false);
    expect(run.stdout).toContain("too long for the judge to read whole");
  });
});

// ===========================================================================
// Which judge scored the run
// ===========================================================================

describe("a run records which judge scored it", () => {
  it("writes the judge to bundle-index.json, public-report.json and provenance-manifest.json", async () => {
    const run = await judged(TASK, ANSWER, decisions());

    expect(run.bundleIndex?.judge).toEqual(JEV_TEST_JUDGE);
    expect(run.publicReport?.judge).toEqual(JEV_TEST_JUDGE);
    expect(run.provenanceManifest?.judge).toEqual(JEV_TEST_JUDGE);
  });

  it("names the judge and its version in the Markdown report", async () => {
    const run = await judged(TASK, ANSWER, decisions());

    expect(run.markdown).toContain(
      "**Judge**: `typesafe/jev-1.13` (version `typesafe/jev-1.13-20260917`)",
    );
  });
});
