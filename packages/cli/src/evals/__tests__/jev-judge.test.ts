/**
 * Unit tests for `jev-judge.ts` — the parts a run cannot reach.
 *
 * What the judge promises a maintainer — what it is sent, that its overall
 * answer decides the verdict at 0.5, that an HTTP error, another version,
 * a non-JSON body or an over-length answer leave the case errored, and that
 * the run records the judge — is asserted end to end in
 * [`tests/evals/judge.scenario.test.ts`](../../../../../tests/evals/judge.scenario.test.ts)
 * against a stubbed decisions endpoint.
 *
 * What stays here, and why a run cannot reach it:
 *
 *   - **`jevScore()` at its boundaries** — a scenario shows one pass and one
 *     fail; the exact mapping (0.5 → 0.95, 1 → 1, order kept) is arithmetic.
 *   - **Clashing criterion keys** — no fixture in the corpus names a signal
 *     `overall` or repeats one, so `JudgeInputInvalid` is a guard for a future
 *     fixture.
 *   - **A malformed answer** — a missing criterion answer or an out-of-range
 *     `noul` needs a hand-built response body.
 *   - **A `fetch` that throws synchronously** — the typed error must still
 *     come back as a `Result`, never as a throw.
 *
 * Test isolation: no network; `fetch` is injected.
 */

import { describe, expect, it } from "bun:test";
import {
  buildJevRequest,
  type FetchLike,
  JEV_MAX_STATE_CHARS,
  JevJudge,
  jevRationale,
  jevScore,
  parseJevDecision,
} from "../jev-judge.js";
import type { JudgeInput } from "../langchain-agent-evals.js";

const JUDGE = {
  id: "typesafe/jev-1.13",
  version: "typesafe/jev-1.13-20260917",
};

function input(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    dimension: "executionCompleteness",
    rubricDescription: "Case: do the thing",
    reference: "Task: do the thing; required signals: [a, b]",
    response: "I did the thing.",
    criteria: [
      { key: "a", question: "Is a done?" },
      { key: "b", question: "Is b done?" },
    ],
    ...overrides,
  };
}

function answers(values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = { type: "noul", noul: value };
  }
  return out;
}

describe("jevScore", () => {
  it.each([
    [0, 0],
    [0.49, 0.49],
    [0.5, 0.95],
    [0.75, 0.975],
    [1, 1],
  ])("maps overall %p to %p", (overall, score) => {
    expect(jevScore(overall)).toBeCloseTo(score, 10);
  });

  it("keeps the order of overall answers", () => {
    const overalls = [0, 0.2, 0.49, 0.5, 0.51, 0.9, 1];
    const scores = overalls.map(jevScore);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
  });
});

describe("buildJevRequest", () => {
  it("refuses a criterion keyed `overall`, the judge's own question", () => {
    const result = buildJevRequest(
      input({ criteria: [{ key: "overall", question: "?" }] }),
      JUDGE.version,
    );
    expect(result._unsafeUnwrapErr().type).toBe("JudgeInputInvalid");
  });

  it("refuses two criteria with the same key", () => {
    const result = buildJevRequest(
      input({
        criteria: [
          { key: "a", question: "?" },
          { key: "a", question: "again?" },
        ],
      }),
      JUDGE.version,
    );
    expect(result._unsafeUnwrapErr().type).toBe("JudgeInputInvalid");
  });

  it("accepts a state of exactly the limit and refuses one character more", () => {
    const base = buildJevRequest(input({ response: "" }), JUDGE.version);
    const overhead =
      base._unsafeUnwrap().state.length - "(empty response)".length;
    const fits = "y".repeat(JEV_MAX_STATE_CHARS - overhead);

    expect(
      buildJevRequest(input({ response: fits }), JUDGE.version).isOk(),
    ).toBe(true);
    const over = buildJevRequest(
      input({ response: `${fits}y` }),
      JUDGE.version,
    );
    expect(over._unsafeUnwrapErr()).toMatchObject({
      type: "JudgeInputTooLong",
      length: JEV_MAX_STATE_CHARS + 1,
      limit: JEV_MAX_STATE_CHARS,
    });
  });

  it("shows a blank answer as an explicit marker", () => {
    const request = buildJevRequest(input({ response: "  " }), JUDGE.version);
    expect(request._unsafeUnwrap().state).toEndWith(
      "# Agent response\n(empty response)",
    );
  });
});

describe("parseJevDecision", () => {
  it("refuses an answer with a criterion missing", () => {
    const result = parseJevDecision(
      { model: JUDGE.version, answers: answers({ a: 0.9, overall: 0.9 }) },
      input(),
      JUDGE.version,
    );
    expect(result._unsafeUnwrapErr().type).toBe("JudgeResponseInvalid");
  });

  it("refuses a noul outside [0, 1]", () => {
    const result = parseJevDecision(
      {
        model: JUDGE.version,
        answers: answers({ a: 0.9, b: 0.9, overall: 1.2 }),
      },
      input(),
      JUDGE.version,
    );
    expect(result._unsafeUnwrapErr().type).toBe("JudgeResponseInvalid");
  });

  it("reads every answer it asked for", () => {
    const result = parseJevDecision(
      {
        model: JUDGE.version,
        answers: answers({ a: 0.9, b: 0.3, overall: 0.7 }),
      },
      input(),
      JUDGE.version,
    );
    expect(result._unsafeUnwrap()).toEqual({
      model: JUDGE.version,
      overall: 0.7,
      criteria: { a: 0.9, b: 0.3 },
    });
  });
});

describe("jevRationale", () => {
  it("names the criteria below the threshold on a pass", () => {
    expect(
      jevRationale({
        model: JUDGE.version,
        overall: 0.7,
        criteria: { a: 0.9, b: 0.3 },
      }),
    ).toBe(
      "Judge verdict: pass (overall 0.70 ≥ 0.50). Criteria below 0.50: b (0.30).",
    );
  });

  it("says none when every criterion held", () => {
    expect(
      jevRationale({
        model: JUDGE.version,
        overall: 0.4,
        criteria: { a: 0.9 },
      }),
    ).toBe(
      "Judge verdict: fail (overall 0.40 < 0.50). Criteria below 0.50: none.",
    );
  });
});

describe("JevJudge", () => {
  it("returns a typed error when fetch throws before returning a promise", async () => {
    const throwing: FetchLike = () => {
      throw new Error("no network");
    };
    const judge = new JevJudge({ apiKey: "k", judge: JUDGE, fetch: throwing });

    const result = await judge.evaluate(input());
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "JudgeHttpError",
      status: 0,
      dimension: "executionCompleteness",
    });
  });

  it("returns a typed error when fetch rejects", async () => {
    const rejecting: FetchLike = () => Promise.reject(new Error("timeout"));
    const judge = new JevJudge({ apiKey: "k", judge: JUDGE, fetch: rejecting });

    const result = await judge.evaluate(input());
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "JudgeHttpError",
      status: 0,
    });
  });

  it("sends a timeout signal with every request", async () => {
    let signal: AbortSignal | null | undefined;
    const recording: FetchLike = async (_url, init) => {
      signal = init.signal;
      return Response.json({
        model: JUDGE.version,
        answers: answers({ a: 1, b: 1, overall: 1 }),
      });
    };
    const judge = new JevJudge({ apiKey: "k", judge: JUDGE, fetch: recording });

    const result = await judge.evaluate(input());
    expect(result._unsafeUnwrap().score).toBe(1);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("reports the judge it is pinned to", () => {
    const judge = new JevJudge({ apiKey: "k", judge: JUDGE });
    expect(judge.identity()).toEqual(JUDGE);
  });
});
