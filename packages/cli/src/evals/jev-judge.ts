/**
 * The eval judge: TypeSafe Jev (Spec 37, task 16.4).
 *
 * `JevJudge` implements `LangChainJudge` against OpenRouter's decisions
 * endpoint (`POST https://openrouter.ai/api/alpha/decisions`). Jev reads a
 * `state` text and answers typed questions; it returns probabilities, never
 * free text. The judge acceptance check accepted it (28 of 30 labels agreed,
 * 10 of 12 fails caught; `docs/artifacts/judge-bakeoff-2026-09-23.md`), and
 * it can never be one of the evaluated models, so it never grades itself.
 *
 * # What it is asked
 *
 * The state is the rubric, the reference and the agent's actual response,
 * in that order (`buildJevState`). The questions are one `noul` per
 * criterion the scorer derived from the case (`judge-questions.ts`) and one
 * `overall` noul: "Would a careful reviewer applying the rubric accept the
 * agent response as passing this case?". A `noul` answer is the probability
 * of "yes", in [0, 1].
 *
 * # What it returns
 *
 * - **The verdict is `overall` alone**: pass at `JEV_PASS_THRESHOLD` (0.5),
 *   the fixed threshold of the acceptance check. The per-criterion answers
 *   never change the verdict; they say which checks failed.
 * - **The score** maps that verdict onto the scorer's normalized scale
 *   (`jevScore`): a pass lands in [0.95, 1], so it clears every gate the
 *   scorer and the runners apply (the near-perfect primary gate at 0.95, the
 *   category-routing gate at 0.7); a fail keeps its probability, below 0.5,
 *   so it clears none of them.
 * - **The rationale** is built here, from the question keys that fell below
 *   the threshold and their probabilities. The keys are the case's own
 *   criterion ids, so no judge text exists to leak into any file.
 *
 * # Pinning
 *
 * The request names the dated version (`typesafe/jev-1.13-20260917`), and an
 * answer from any other version is refused (`JudgeResponseInvalid`), so every
 * score in a run comes from the version the run records.
 *
 * # Failures
 *
 * Every failure is a typed `ScoringError`, never a throw, and every runner
 * turns it into an errored case: `JudgeHttpError` (no response, or a non-2xx
 * status), `JudgeResponseInvalid` (not JSON, a missing or out-of-range
 * answer, another version), `JudgeInputTooLong` (the state would not fit
 * Jev's 32k-token context; refused, never truncated) and `JudgeInputInvalid`
 * (a criterion key clashes with another or with `overall`).
 */

import { err, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type {
  JudgeCriterion,
  JudgeInput,
  JudgeOutput,
  LangChainJudge,
} from "./langchain-agent-evals.js";
import { PRIMARY_STRUCTURAL_PASS_THRESHOLD } from "./langchain-agent-evals.js";
import type { JudgeIdentity } from "./report-schema.js";
import type { ScoringDimension, ScoringError } from "./types.js";

/** OpenRouter's decisions endpoint, which serves Jev. */
export const JEV_DECISIONS_ENDPOINT =
  "https://openrouter.ai/api/alpha/decisions";

/** Jev's verdict is a pass when its `overall` answer is at least this. */
export const JEV_PASS_THRESHOLD = 0.5;

/**
 * Jev's context is 32k tokens. A state longer than this many characters is
 * refused, never truncated (about 3.5 characters per token, with headroom
 * for the questions). The longest response the acceptance check saw was
 * about 11,000 characters.
 */
export const JEV_MAX_STATE_CHARS = 100_000;

/** How long one judge call may take before it is abandoned. */
export const JEV_REQUEST_TIMEOUT_MS = 120_000;

/** The question key Jev's verdict is read from. */
export const JEV_OVERALL_KEY = "overall";

const INSTRUCTION_PREFIX =
  "Read the rubric, the reference and the agent response in the state. ";

const OVERALL_QUESTION =
  "Would a careful reviewer applying the rubric accept the agent response as passing this case?";

/** How much of an HTTP error body a local diagnostic keeps. */
const ERROR_BODY_MAX_CHARS = 300;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One `noul` question as the decisions endpoint takes it. */
interface JevNoulQuestion {
  type: "noul";
  instructions: string;
}

/** The request body for one judge call. */
export interface JevRequest {
  model: string;
  state: string;
  questions: Record<string, JevNoulQuestion>;
}

/** What Jev answered, read back. */
export interface JevDecision {
  /** The version Jev answered as. */
  model: string;
  /** The verdict probability. */
  overall: number;
  /** One probability per criterion key. */
  criteria: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The response as the judge sees it. A blank response is shown as an
 * explicit marker so it is judged as empty, not as a rendering gap.
 */
export function displayResponse(response: string): string {
  if (response.trim() === "") return "(empty response)";
  return response;
}

/** The state Jev reads: rubric, reference and response, in that order. */
export function buildJevState(input: JudgeInput): string {
  return [
    "# Rubric",
    input.rubricDescription,
    "",
    "# Reference (expected outcome)",
    input.reference,
    "",
    "# Agent response",
    displayResponse(input.response),
  ].join("\n");
}

/**
 * Keys a question may not use: the judge's own `overall`, and the names that
 * reach `Object.prototype` instead of creating a property (`__proto__` would
 * be dropped from the request by `JSON.stringify`).
 */
const RESERVED_QUESTION_KEYS: ReadonlySet<string> = new Set([
  JEV_OVERALL_KEY,
  "__proto__",
  "constructor",
  "prototype",
]);

function questionKeysValid(
  criteria: readonly JudgeCriterion[],
  dimension: ScoringDimension,
): Result<void, ScoringError> {
  const seen = new Set<string>();
  for (const criterion of criteria) {
    if (RESERVED_QUESTION_KEYS.has(criterion.key) || seen.has(criterion.key)) {
      return err({
        type: "JudgeInputInvalid",
        dimension,
        message: `criterion key "${criterion.key}" is reserved or used twice`,
      });
    }
    seen.add(criterion.key);
  }
  return ok(undefined);
}

/**
 * The request for one judged dimension: the state, one `noul` per criterion
 * and the `overall` noul. Refuses a state too long for Jev's context.
 */
export function buildJevRequest(
  input: JudgeInput,
  model: string,
): Result<JevRequest, ScoringError> {
  const keys = questionKeysValid(input.criteria, input.dimension);
  if (keys.isErr()) return err(keys.error);
  const state = buildJevState(input);
  if (state.length > JEV_MAX_STATE_CHARS) {
    return err({
      type: "JudgeInputTooLong",
      dimension: input.dimension,
      length: state.length,
      limit: JEV_MAX_STATE_CHARS,
      message:
        `The judge's input is ${state.length} characters; Jev reads at most ` +
        `${JEV_MAX_STATE_CHARS}. It was not truncated, so the case is not judged.`,
    });
  }
  // Null prototype: every key is an own property, whatever its name.
  const questions: Record<string, JevNoulQuestion> = Object.create(null);
  for (const criterion of input.criteria) {
    questions[criterion.key] = {
      type: "noul",
      instructions: `${INSTRUCTION_PREFIX}${criterion.question}`,
    };
  }
  questions[JEV_OVERALL_KEY] = {
    type: "noul",
    instructions: `${INSTRUCTION_PREFIX}${OVERALL_QUESTION}`,
  };
  return ok({ model, state, questions });
}

const JevNoulSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});

const JevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
});

/**
 * Read Jev's answer to `input`: the version it answered as must be `model`,
 * and every question asked must have a `noul` answer in [0, 1].
 */
export function parseJevDecision(
  body: unknown,
  input: JudgeInput,
  model: string,
): Result<JevDecision, ScoringError> {
  const invalid = (message: string): Result<JevDecision, ScoringError> =>
    err({ type: "JudgeResponseInvalid", dimension: input.dimension, message });

  const parsed = JevResponseSchema.safeParse(body);
  if (!parsed.success) {
    return invalid("the judge's response is not a decisions answer");
  }
  if (parsed.data.model !== model) {
    return invalid(
      `the judge answered as a model other than the pinned ${model}`,
    );
  }
  const answers = parsed.data.answers;
  const noul = (key: string): number | undefined => {
    if (!Object.hasOwn(answers, key)) return undefined;
    const answer = JevNoulSchema.safeParse(answers[key]);
    return answer.success ? answer.data.noul : undefined;
  };

  const criteria: Record<string, number> = Object.create(null);
  for (const criterion of input.criteria) {
    const value = noul(criterion.key);
    if (value === undefined) {
      return invalid(
        `answer "${criterion.key}" is missing or not a noul in [0, 1]`,
      );
    }
    criteria[criterion.key] = value;
  }
  const overall = noul(JEV_OVERALL_KEY);
  if (overall === undefined) {
    return invalid(
      `answer "${JEV_OVERALL_KEY}" is missing or not a noul in [0, 1]`,
    );
  }
  return ok({ model: parsed.data.model, overall, criteria });
}

/**
 * Jev's `overall` probability on the scorer's normalized scale.
 *
 * A pass (`overall ≥ 0.5`) maps linearly onto [0.95, 1]; a fail keeps its
 * probability, which is below 0.5. The order of scores is preserved, and
 * the verdict decides every gate: a pass clears the scorer's near-perfect
 * primary gate (`PRIMARY_STRUCTURAL_PASS_THRESHOLD`, 0.95) and the
 * category-routing gate (0.7); a fail clears neither, nor `PASS_THRESHOLD`.
 */
export function jevScore(overall: number): number {
  if (overall < JEV_PASS_THRESHOLD) return overall;
  const above = (overall - JEV_PASS_THRESHOLD) / (1 - JEV_PASS_THRESHOLD);
  return (
    PRIMARY_STRUCTURAL_PASS_THRESHOLD +
    (1 - PRIMARY_STRUCTURAL_PASS_THRESHOLD) * above
  );
}

/**
 * The rationale for one decision, built from the question keys that fell
 * below the threshold. Contains criterion ids and numbers only.
 */
export function jevRationale(decision: JevDecision): string {
  const verdict = decision.overall >= JEV_PASS_THRESHOLD ? "pass" : "fail";
  const comparison = verdict === "pass" ? "≥" : "<";
  const failed = Object.entries(decision.criteria)
    .filter(([, value]) => value < JEV_PASS_THRESHOLD)
    .map(([key, value]) => `${key} (${value.toFixed(2)})`);
  const failedText = failed.length > 0 ? failed.join(", ") : "none";
  return (
    `Judge verdict: ${verdict} (overall ${decision.overall.toFixed(2)} ` +
    `${comparison} ${JEV_PASS_THRESHOLD.toFixed(2)}). ` +
    `Criteria below ${JEV_PASS_THRESHOLD.toFixed(2)}: ${failedText}.`
  );
}

// ---------------------------------------------------------------------------
// JevJudge
// ---------------------------------------------------------------------------

export interface JevJudgeOptions {
  /** The OpenRouter API key. Sent only as the `Authorization` header. */
  apiKey: string;
  /**
   * The judge as a run records it: `id` the model, `version` the dated
   * version the request names and every answer must come from.
   */
  judge: JudgeIdentity;
  /** Replaces `fetch`. Inject a stub in tests. */
  fetch?: FetchLike;
  /** Replaces `JEV_DECISIONS_ENDPOINT`. */
  endpoint?: string;
  /** Replaces `JEV_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** The eval judge: one decisions call per judged dimension. */
export class JevJudge implements LangChainJudge {
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: JevJudgeOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.endpoint = options.endpoint ?? JEV_DECISIONS_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? JEV_REQUEST_TIMEOUT_MS;
  }

  /** The judge a run scored by this instance records. */
  identity(): JudgeIdentity {
    return { ...this.options.judge };
  }

  evaluate(input: JudgeInput): ResultAsync<JudgeOutput, ScoringError> {
    const model = this.options.judge.version;
    const request = buildJevRequest(input, model);
    if (request.isErr()) {
      return new ResultAsync(Promise.resolve(err(request.error)));
    }
    return this.post(input.dimension, request.value)
      .andThen((body) => parseJevDecision(body, input, model))
      .map((decision) => ({
        score: jevScore(decision.overall),
        rationale: jevRationale(decision),
      }));
  }

  private post(
    dimension: ScoringDimension,
    request: JevRequest,
  ): ResultAsync<unknown, ScoringError> {
    const httpError = (status: number, message: string): ScoringError => ({
      type: "JudgeHttpError",
      dimension,
      status,
      message,
    });
    // fromThrowable also catches a fetch implementation that throws
    // synchronously, so every transport failure is a typed judge error.
    const send = ResultAsync.fromThrowable(
      () =>
        this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.timeoutMs),
        }),
      (cause) => httpError(0, `judge request failed: ${String(cause)}`),
    );
    return send().andThen((response) =>
      ResultAsync.fromPromise(response.text(), (cause) =>
        httpError(
          response.status,
          `judge response could not be read: ${String(cause)}`,
        ),
      ).andThen((text) => {
        if (!response.ok) {
          return err<unknown, ScoringError>(
            httpError(
              response.status,
              `judge returned HTTP ${response.status}: ${text.slice(0, ERROR_BODY_MAX_CHARS)}`,
            ),
          );
        }
        return Result.fromThrowable(
          () => JSON.parse(text) as unknown,
          (): ScoringError => ({
            type: "JudgeResponseInvalid",
            dimension,
            message: "the judge's response body is not JSON",
          }),
        )();
      }),
    );
  }
}
