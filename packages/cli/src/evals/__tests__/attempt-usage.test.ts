/**
 * Unit tests for `attempt-usage.ts` — per-attempt tokens and cost.
 *
 * What a maintainer sees (score file rows, the run report, `eval compare`)
 * is asserted end to end in `tests/evals/cost.scenario.test.ts` and
 * `tests/evals/compare.scenario.test.ts`. What stays here is the arithmetic
 * and the edges a run does not reach cheaply: mixed cost sources, a model
 * without prices, a failed call, a trajectory case, and the formatting of
 * small amounts.
 *
 * Test isolation: no network; the model client is `StubModelClient`.
 */

import { describe, expect, it } from "bun:test";
import {
  type AttemptUsage,
  AttemptUsageMeter,
  attachAttemptUsage,
  describeCost,
  formatUsd,
  type MeteredCall,
  MeteredModelClient,
  priceTable,
  summarizeCost,
  totalCalls,
  UsageLedger,
} from "../attempt-usage.js";
import { RetryingModelClient, StubModelClient } from "../openrouter-client.js";
import type { CaseResult, ModelMatrixEntry, ModelPrices } from "../types.js";

const MODEL = "openai/gpt-6-luna";
const PRICES: ModelPrices = {
  input_per_million: 2,
  output_per_million: 10,
  as_of: "2026-10-01",
};
const TABLE = new Map([[MODEL, PRICES]]);

const TEXT_CASE = { expected_outcome: { kind: "task_completion" } } as const;
const TRAJECTORY_CASE = {
  expected_outcome: { kind: "harness_trajectory" },
} as const;

function usage(
  promptTokens: number,
  completionTokens: number,
  costUsd?: number,
) {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function call(overrides: Partial<MeteredCall> = {}): MeteredCall {
  return { role: "model", model: MODEL, usage: usage(1000, 100), ...overrides };
}

function result(dryRun = false): CaseResult {
  return {
    summary: {
      caseId: "c",
      modelId: MODEL,
      suite: "weft-review",
      passed: true,
      required: true,
      weightedTotal: 1,
      dimensionScores: {
        routingCorrectness: { score: 1, applicable: false },
        delegationCorrectness: { score: 1, applicable: false },
        executionCompleteness: { score: 1, applicable: true },
        rationaleQuality: { score: 1, applicable: true },
      },
      scoredAt: "2026-10-01T00:00:00.000Z",
      dryRun,
    },
  };
}

describe("MeteredModelClient", () => {
  it("records an answered call with the usage it reported", async () => {
    const ledger = new UsageLedger();
    const stub = new StubModelClient();
    stub.enqueueResponse({
      model: MODEL,
      content: "ok",
      usage: usage(10, 2, 0.001),
    });

    await new MeteredModelClient(stub, ledger).complete({
      model: MODEL,
      messages: [],
    });

    expect(ledger.drain()).toEqual([
      { role: "model", model: MODEL, usage: usage(10, 2, 0.001) },
    ]);
  });

  it("records an answered call that reported no usage, without usage", async () => {
    const ledger = new UsageLedger();
    const stub = new StubModelClient();
    stub.enqueueResponse({ model: MODEL, content: "ok" });

    await new MeteredModelClient(stub, ledger).complete({
      model: MODEL,
      messages: [],
    });

    expect(ledger.drain()).toEqual([{ role: "model", model: MODEL }]);
  });

  it("records a truncated answer, which is billed", async () => {
    const ledger = new UsageLedger();
    const stub = new StubModelClient();
    stub.enqueueError({
      type: "TruncatedResponse",
      message: "cut off",
      usage: usage(10, 2048),
    });

    await new MeteredModelClient(stub, ledger).complete({
      model: MODEL,
      messages: [],
    });

    expect(ledger.drain()).toEqual([
      { role: "model", model: MODEL, usage: usage(10, 2048) },
    ]);
  });

  it("records nothing for a request that failed before the provider answered", async () => {
    const ledger = new UsageLedger();
    const stub = new StubModelClient();
    stub.enqueueError({ type: "NetworkError", message: "down" });
    stub.enqueueError({
      type: "HttpError",
      statusCode: 502,
      message: "bad gateway",
    });

    const client = new MeteredModelClient(stub, ledger);
    await client.complete({ model: MODEL, messages: [] });
    await client.complete({ model: MODEL, messages: [] });

    expect(ledger.drain()).toEqual([]);
  });

  it("records every retry when it sits under RetryingModelClient", async () => {
    const ledger = new UsageLedger();
    const stub = new StubModelClient();
    stub.enqueueError({
      type: "EmptyResponse",
      message: "empty",
      usage: usage(10, 1),
    });
    stub.enqueueResponse({ model: MODEL, content: "ok", usage: usage(10, 5) });

    await new RetryingModelClient(
      new MeteredModelClient(stub, ledger),
    ).complete({
      model: MODEL,
      messages: [],
    });

    expect(ledger.drain()).toHaveLength(2);
  });
});

describe("totalCalls", () => {
  it("sums tokens and prefers the cost the provider reported", () => {
    const total = totalCalls(
      [
        call({ usage: usage(1000, 100, 0.5) }),
        call({ usage: usage(500, 50, 0.25) }),
      ],
      TABLE,
    );

    expect(total).toEqual({
      calls: 2,
      promptTokens: 1500,
      completionTokens: 150,
      costUsd: 0.75,
      costSource: "provider",
    });
  });

  it("prices a call without a reported cost at the matrix prices", () => {
    // 1000 × $2/M + 100 × $10/M = $0.002 + $0.001
    const total = totalCalls([call()], TABLE);

    expect(total.costUsd).toBeCloseTo(0.003, 12);
    expect(total.costSource).toBe("prices");
  });

  it("says mixed when some calls were reported and some priced", () => {
    const total = totalCalls(
      [call({ usage: usage(1, 1, 0.1) }), call()],
      TABLE,
    );

    expect(total.costSource).toBe("mixed");
  });

  it("leaves tokens and cost out when one call reported no usage", () => {
    const total = totalCalls([call(), call({ usage: undefined })], TABLE);

    expect(total).toEqual({ calls: 2 });
  });

  it("leaves the cost out for a model with no price and no reported cost", () => {
    const total = totalCalls([call({ model: "unpriced/model" })], TABLE);

    expect(total).toEqual({
      calls: 1,
      promptTokens: 1000,
      completionTokens: 100,
    });
  });

  it("states zero for no calls at all, because nothing was spent", () => {
    expect(totalCalls([], TABLE)).toEqual({
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    });
  });
});

describe("AttemptUsageMeter", () => {
  it("drains the calls since the previous case onto this case's summary", () => {
    const ledger = new UsageLedger();
    const meter = new AttemptUsageMeter(ledger, TABLE);
    ledger.record(call({ usage: usage(10, 1, 0.01) }));
    ledger.record(
      call({ role: "judge", model: "typesafe/jev", usage: usage(5, 1, 0.001) }),
    );

    const first = meter.attach(result(), TEXT_CASE);
    const second = meter.attach(result(), TEXT_CASE);

    expect(first.summary.usage).toEqual({
      model: {
        calls: 1,
        promptTokens: 10,
        completionTokens: 1,
        costUsd: 0.01,
        costSource: "provider",
      },
      judge: {
        calls: 1,
        promptTokens: 5,
        completionTokens: 1,
        costUsd: 0.001,
        costSource: "provider",
      },
    });
    expect(second.summary.usage?.model?.calls).toBe(0);
  });

  it("gives a harness trajectory case no model usage, because the harness made those calls", () => {
    const meter = new AttemptUsageMeter(new UsageLedger(), TABLE);

    const attached = meter.attach(result(), TRAJECTORY_CASE);

    expect(attached.summary.usage).not.toHaveProperty("model");
    expect(attached.summary.usage?.judge.calls).toBe(0);
  });

  it("leaves a dry-run result unchanged", () => {
    const meter = new AttemptUsageMeter(new UsageLedger(), TABLE);

    expect(meter.attach(result(true), TEXT_CASE).summary.usage).toBeUndefined();
  });

  it("leaves a result unchanged when the runner was given no meter", () => {
    expect(
      attachAttemptUsage(undefined, result(), TEXT_CASE).summary.usage,
    ).toBeUndefined();
  });
});

describe("priceTable", () => {
  it("keeps only the matrix entries that list prices", () => {
    const entries = [
      { id: MODEL, prices: PRICES },
      { id: "other/model" },
    ] as ModelMatrixEntry[];

    expect([...priceTable(entries).keys()]).toEqual([MODEL]);
  });
});

describe("summarizeCost", () => {
  const costed = (
    costUsd: number,
    costSource: "provider" | "prices",
  ): AttemptUsage => ({
    model: { calls: 1, costUsd, costSource },
    judge: { calls: 0, costUsd: 0 },
  });

  it("averages over the attempts with a cost and counts the rest", () => {
    const summary = summarizeCost(
      [
        costed(0.01, "provider"),
        costed(0.03, "provider"),
        { model: { calls: 1 }, judge: { calls: 0 } },
        undefined,
      ],
      "model",
    );

    expect(summary).toEqual({
      attempts: 4,
      costed: 2,
      meanUsd: 0.02,
      source: "provider",
    });
  });

  it("reports no mean when no attempt has a cost", () => {
    expect(summarizeCost([undefined, undefined], "judge")).toEqual({
      attempts: 2,
      costed: 0,
      meanUsd: null,
      source: null,
    });
  });

  it("says mixed when attempts were costed from different sources", () => {
    const summary = summarizeCost(
      [costed(0.01, "provider"), costed(0.01, "prices")],
      "model",
    );

    expect(summary.source).toBe("mixed");
  });

  it("reads a trajectory attempt's missing model usage as no cost", () => {
    const summary = summarizeCost(
      [{ judge: { calls: 0, costUsd: 0 } }],
      "model",
    );

    expect(summary.costed).toBe(0);
  });
});

describe("describeCost", () => {
  it("names the mean, its source, and the attempts it leaves out", () => {
    expect(
      describeCost({
        attempts: 8,
        costed: 6,
        meanUsd: 0.0123,
        source: "prices",
      }),
    ).toEqual({
      mean: "$0.0123 (at matrix prices)",
      missing: "no recorded cost for 2 of 8 attempts",
    });
  });

  it("says not recorded when no attempt has a cost", () => {
    expect(
      describeCost({ attempts: 3, costed: 0, meanUsd: null, source: null }),
    ).toEqual({ mean: "not recorded", missing: null });
  });
});

describe("formatUsd", () => {
  it("keeps three significant figures for amounts under a dollar", () => {
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(0.000412)).toBe("$0.000412");
    expect(formatUsd(0.5)).toBe("$0.500");
  });

  it("uses cents from a dollar up, and $0 for nothing", () => {
    expect(formatUsd(3.41)).toBe("$3.41");
    expect(formatUsd(0)).toBe("$0");
  });
});
