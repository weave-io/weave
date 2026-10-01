/**
 * Token usage and cost per eval attempt (Spec 39 task 0.6, gap G6).
 *
 * A recommendation that changes a builtin model changes users' bills, so the
 * evidence for it states what the candidate cost per attempt against the
 * current model. Before this module the only cost figure was the OpenRouter
 * credit balance read before and after a whole run, judge included.
 *
 * # How an attempt's usage is collected
 *
 * - `MeteredModelClient` sits under `RetryingModelClient`, so every call the
 *   model answered is recorded in the run's `UsageLedger`, retries included.
 *   An empty or truncated answer is billed, so its usage is recorded too. A
 *   call that failed before the provider answered (network, HTTP or parse
 *   failure) is not counted: nothing is known about it, and OpenRouter does
 *   not bill a request it refused.
 * - `JevJudge` records each judge call it got an answer to, with the usage
 *   the decisions endpoint reported.
 * - Runners execute their cases one after another. When a case finishes, the
 *   runner hands its result to `AttemptUsageMeter.attach()`, which drains the
 *   ledger — every call made since the previous case — and stores the totals
 *   on the case's summary as `usage`.
 * - That drain is only right if nothing else records into the ledger while a
 *   case runs. `EvalOrchestrator` gives each unit of work — one suite on one
 *   model in one repeat — its own ledger, metered model client and judge
 *   (`unitServices`), so units running at once under `--concurrency` never
 *   cost one attempt's calls on another.
 *
 * # Cost
 *
 * Each call's cost is, in order of preference:
 *
 * 1. `provider` — the cost OpenRouter reported in the response (`usage.cost`,
 *    in credits, which are US dollars). It accounts for cache discounts and
 *    the provider that actually served the call.
 * 2. `prices` — the call's token counts at the model's list prices in
 *    `evals/model-matrix.json` (`prices`, USD per million tokens).
 *
 * A call with neither has no cost. Totals are only stated when every call in
 * the attempt has one; otherwise the attempt's cost is absent, never zero,
 * and reports count it as an attempt without a recorded cost.
 *
 * # Where it is stored
 *
 * In the local score files (`score-<suite>.json`), one `usage` object per
 * attempt row. Score files are internal bundle files, never published to the
 * results repository, and the public report (`public-report.json`, Spec 31)
 * is built field by field without `usage`, so its schema is unchanged.
 */

import type { ResultAsync } from "neverthrow";
import type {
  ModelClient,
  ModelClientError,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "./openrouter-client.js";
import type {
  CaseResult,
  EvalCase,
  ModelMatrixEntry,
  ModelPrices,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the meter needs to know about a case: whether a harness ran it. */
export interface MeteredCase {
  expected_outcome: Pick<EvalCase["expected_outcome"], "kind">;
}

/** Who made a call: the evaluated model, or the judge scoring its answer. */
export type CallRole = "model" | "judge";

/** Where a cost came from. `mixed` means some calls from each. */
export const COST_SOURCES = ["provider", "prices", "mixed"] as const;

export type CostSource = (typeof COST_SOURCES)[number];

/** One answered call, as the ledger records it. */
export interface MeteredCall {
  role: CallRole;
  /** The model the call asked for (the matrix id, or the judge version). */
  model: string;
  /** What the response reported; absent when it reported no usage. */
  usage?: ModelUsage;
}

/**
 * The calls of one role in one attempt, totalled.
 *
 * Token counts and cost are present only when every call reported them (or,
 * for cost, could be priced). With no calls at all they are zero, because
 * nothing was spent.
 */
export interface CallsUsage {
  /** Answered calls, retries included. */
  calls: number;
  /** Prompt tokens over all calls; absent when a call reported no usage. */
  promptTokens?: number;
  /** Completion tokens (reasoning included); absent when a call reported none. */
  completionTokens?: number;
  /** Cost in US dollars; absent when any call has no known cost. */
  costUsd?: number;
  /** Where `costUsd` came from; absent with no calls or no cost. */
  costSource?: CostSource;
}

/**
 * One attempt's usage, stored on its score file row.
 *
 * `model` is absent for a harness trajectory attempt: the harness made the
 * model calls through its own provider session, and they cannot be metered
 * here. A row with no `usage` at all — every run before Spec 39 task 0.6 —
 * has no recorded usage.
 */
export interface AttemptUsage {
  model?: CallsUsage;
  judge: CallsUsage;
}

// ---------------------------------------------------------------------------
// Ledger and metered client
// ---------------------------------------------------------------------------

/** Every answered call of one unit of work, in order, until a case drains them. */
export class UsageLedger {
  private calls: MeteredCall[] = [];

  record(call: MeteredCall): void {
    this.calls.push(call);
  }

  /** The calls recorded since the last drain, removing them. */
  drain(): MeteredCall[] {
    const drained = this.calls;
    this.calls = [];
    return drained;
  }
}

/**
 * A `ModelClient` that records the usage of every call the provider
 * answered — answers, empty answers and truncated answers — in a ledger.
 */
export class MeteredModelClient implements ModelClient {
  constructor(
    private readonly inner: ModelClient,
    private readonly ledger: UsageLedger,
  ) {}

  complete(
    request: ModelRequest,
  ): ResultAsync<ModelResponse, ModelClientError> {
    return this.inner
      .complete(request)
      .map((response) => {
        this.record(request.model, response.usage);
        return response;
      })
      .mapErr((error) => {
        if (
          error.type === "EmptyResponse" ||
          error.type === "TruncatedResponse"
        ) {
          this.record(request.model, error.usage);
        }
        return error;
      });
  }

  private record(model: string, usage: ModelUsage | undefined): void {
    this.ledger.record({
      role: "model",
      model,
      ...(usage !== undefined ? { usage } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Pricing and attempt totals
// ---------------------------------------------------------------------------

/** Model id → list prices, from the entries of the model matrix that have them. */
export function priceTable(
  entries: readonly ModelMatrixEntry[],
): ReadonlyMap<string, ModelPrices> {
  const table = new Map<string, ModelPrices>();
  for (const entry of entries) {
    if (entry.prices === undefined) continue;
    table.set(entry.id, entry.prices);
  }
  return table;
}

/** A call's cost and where it came from, or `undefined` when unknown. */
function callCost(
  call: MeteredCall,
  prices: ReadonlyMap<string, ModelPrices>,
): { usd: number; source: "provider" | "prices" } | undefined {
  if (call.usage === undefined) return undefined;
  if (call.usage.costUsd !== undefined) {
    return { usd: call.usage.costUsd, source: "provider" };
  }
  const price = prices.get(call.model);
  if (price === undefined) return undefined;
  const usd =
    (call.usage.promptTokens * price.input_per_million +
      call.usage.completionTokens * price.output_per_million) /
    1_000_000;
  return { usd, source: "prices" };
}

/** Total the calls of one role. */
export function totalCalls(
  calls: readonly MeteredCall[],
  prices: ReadonlyMap<string, ModelPrices>,
): CallsUsage {
  const total: CallsUsage = { calls: calls.length };
  if (calls.length === 0) {
    return { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  }

  const usages = calls.map((call) => call.usage);
  if (usages.every((usage) => usage !== undefined)) {
    total.promptTokens = sum(usages.map((usage) => usage.promptTokens));
    total.completionTokens = sum(usages.map((usage) => usage.completionTokens));
  }

  const costs = calls.map((call) => callCost(call, prices));
  if (costs.every((cost) => cost !== undefined)) {
    total.costUsd = sum(costs.map((cost) => cost.usd));
    total.costSource = combinedSource(costs.map((cost) => cost.source));
  }
  return total;
}

function combinedSource(
  sources: ReadonlyArray<"provider" | "prices">,
): CostSource {
  const distinct = new Set(sources);
  if (distinct.size > 1) return "mixed";
  return sources[0] ?? "provider";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Turns the ledger into per-attempt usage. One per unit of work: it knows the
 * run's prices and drains the unit's ledger.
 */
export class AttemptUsageMeter {
  constructor(
    private readonly ledger: UsageLedger,
    private readonly prices: ReadonlyMap<string, ModelPrices>,
  ) {}

  /**
   * Store the usage of every call since the previous case on `result`'s
   * summary. A dry-run result made no calls and is returned unchanged.
   * A harness trajectory case gets no `model` usage: its model calls were
   * made by the harness, not through the metered client.
   */
  attach(result: CaseResult, evalCase: MeteredCase): CaseResult {
    const calls = this.ledger.drain();
    if (result.summary.dryRun) return result;
    const modelMetered =
      evalCase.expected_outcome.kind !== "harness_trajectory";
    const usage: AttemptUsage = {
      ...(modelMetered
        ? { model: totalCalls(byRole(calls, "model"), this.prices) }
        : {}),
      judge: totalCalls(byRole(calls, "judge"), this.prices),
    };
    return { ...result, summary: { ...result.summary, usage } };
  }
}

function byRole(calls: readonly MeteredCall[], role: CallRole): MeteredCall[] {
  return calls.filter((call) => call.role === role);
}

/** Attach usage when the runner was given a meter; otherwise unchanged. */
export function attachAttemptUsage(
  meter: AttemptUsageMeter | undefined,
  result: CaseResult,
  evalCase: MeteredCase,
): CaseResult {
  if (meter === undefined) return result;
  return meter.attach(result, evalCase);
}

// ---------------------------------------------------------------------------
// Mean cost per attempt, for reports
// ---------------------------------------------------------------------------

/** The mean cost per attempt of one role over a set of attempts. */
export interface CostSummary {
  /** Attempts in the set. */
  attempts: number;
  /** Attempts with a known cost for this role. */
  costed: number;
  /** Mean cost per costed attempt in US dollars; `null` when none is costed. */
  meanUsd: number | null;
  /** Where the costed attempts' costs came from, as one source. */
  source: CostSource | null;
}

/**
 * The mean cost per attempt of `role` over `usages` (one entry per attempt,
 * `undefined` for an attempt with no recorded usage). Errored attempts are
 * included: their calls were billed too. Attempts without a known cost are
 * left out of the mean and counted by `attempts - costed`.
 */
export function summarizeCost(
  usages: ReadonlyArray<AttemptUsage | undefined>,
  role: CallRole,
): CostSummary {
  const costed: Array<{ usd: number; source: CostSource | undefined }> = [];
  for (const usage of usages) {
    const calls = usage?.[role];
    if (calls?.costUsd === undefined) continue;
    costed.push({ usd: calls.costUsd, source: calls.costSource });
  }
  const sources = new Set(
    costed.flatMap((c) => (c.source === undefined ? [] : [c.source])),
  );
  return {
    attempts: usages.length,
    costed: costed.length,
    meanUsd:
      costed.length === 0
        ? null
        : sum(costed.map((c) => c.usd)) / costed.length,
    source: summarySource(sources),
  };
}

function summarySource(sources: ReadonlySet<CostSource>): CostSource | null {
  if (sources.size === 0) return null;
  if (sources.size > 1) return "mixed";
  return [...sources][0] ?? null;
}

/** US dollars, with enough decimals that a small cost does not read as $0.00. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const decimals = Math.min(8, Math.max(2, Math.ceil(-Math.log10(usd)) + 2));
  return `$${usd.toFixed(decimals)}`;
}

/** How a cost source reads in a report. */
export function describeCostSource(source: CostSource): string {
  if (source === "provider") return "(reported by OpenRouter)";
  if (source === "prices") return "(at matrix prices)";
  return "(reported by OpenRouter or at matrix prices)";
}

/** A cost summary in words: the mean and its source, and what is missing. */
export interface DescribedCost {
  /**
   * `$0.0123 (reported by OpenRouter)`, or `not recorded` when no attempt
   * has a cost: none reported usage, or (a harness trajectory) none was
   * metered.
   */
  mean: string;
  /**
   * `no recorded cost for 2 of 12 attempts`, or `null` when every attempt
   * has one. Reports mark it, because the mean then leaves those out.
   */
  missing: string | null;
}

/** Describe a `CostSummary` the way `eval run` and `eval compare` print it. */
export function describeCost(summary: CostSummary): DescribedCost {
  if (summary.meanUsd === null) return { mean: "not recorded", missing: null };
  // At least one attempt is costed here, so a missing one makes two or more.
  const uncosted = summary.attempts - summary.costed;
  const missing =
    uncosted === 0
      ? null
      : `no recorded cost for ${uncosted} of ${summary.attempts} attempts`;
  const source =
    summary.source === null ? "" : ` ${describeCostSource(summary.source)}`;
  return { mean: `${formatUsd(summary.meanUsd)}${source}`, missing };
}
