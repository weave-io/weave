/**
 * LangChain AgentEvals scoring adapter for `weave eval`.
 *
 * Wraps LangChain AgentEvals in a small scorer module that consumes model
 * run output (from `ModelRunOutput`) and repo rubrics (from `EvalRubric` /
 * `EvalCase`), then produces normalized `NormalizedScoreRecord` values for
 * four dimensions:
 *
 *   - `routingCorrectness`    — did the model route to the correct agent(s)?
 *   - `delegationCorrectness` — did the delegation chain match the expected
 *                               ordered sequence?
 *   - `executionCompleteness` — did the model complete the task with the
 *                               required artifacts and a completion signal?
 *   - `rationaleQuality`      — is the model's response coherent, relevant,
 *                               and sufficiently detailed?
 *
 * # Architecture
 *
 * The LangChain dependency is isolated at the scoring edge via the
 * `LangChainJudge` interface. The rest of the pipeline only sees Weave-owned
 * types: `ModelRunOutput`, `NormalizedScoreRecord`, and `ScoringError`.
 *
 * Production code should construct a `LangChainAgentEvalsScorer` with a real
 * `LangChainJudge` implementation (`RealLangChainJudge`) that calls the
 * LangChain AgentEvals evaluate API via `openevals/llm`'s `createLLMAsJudge`.
 * Tests substitute `StubAgentEvalsScorer` or a `StubLangChainJudge` to
 * exercise scorer logic without real LangChain or provider calls.
 *
 * # Design decisions
 *
 *   - Rubric lookup failures are typed (`RubricNotFound`, `RubricCaseMismatch`)
 *     so callers can surface actionable error messages.
 *   - Every scoring failure is returned via `ResultAsync` — no exceptions
 *     propagate from the scorer.
 *   - Non-applicable dimensions carry `applicable: false` and a neutral
 *     `score: 1.0` so they do not penalize cases.
 *   - The `PASS_THRESHOLD` constant (0.5) defines the minimum `weightedTotal`
 *     for a case to be considered passing.
 *   - For required cases the primary dimension must also be `score === 1.0`
 *     for the case to pass (hard correctness gate).
 *   - `RealLangChainJudge` uses a dynamic import for `openevals/llm` to
 *     remain compatible with its ESM-only distribution.  The import is
 *     resolved once (lazily, on the first `evaluate()` call) and cached.
 *     Each distinct `rubricDescription` produces its own evaluator because
 *     `createLLMAsJudge` binds the rubric text into the prompt at creation
 *     time — a single cached evaluator would use stale rubric text for all
 *     subsequent dimensions.  See `RealLangChainJudge._evaluatorCache` and
 *     the `_moduleCache` field for the two-level cache design.
 *   - `RealLangChainJudge` accepts an optional `moduleLoader` constructor
 *     parameter so tests can inject a fake `openevals/llm` module and prove
 *     per-rubric evaluator isolation without real LangChain or provider calls.
 *
 * # Dependency note
 *
 * `langchain-agent-evals.ts` is the only file in the eval pipeline that may
 * import from `@langchain/*` or `agentevals` / `openevals` packages. All
 * other files in `evals/` must depend only on Weave-owned types and the
 * `LangChainJudge` interface.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { err, ok, ResultAsync } from "neverthrow";
import type {
  DimensionScore,
  EvalCase,
  EvalRubric,
  ModelRunOutput,
  NormalizedScoreRecord,
  ScoringDimension,
  ScoringError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum `weightedTotal` for a case to be considered passing.
 *
 * Cases with `weightedTotal < PASS_THRESHOLD` are always marked
 * `passed: false`, regardless of the rubric's `required` flag.
 */
export const PASS_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// LangChainJudge interface — the scoring edge
// ---------------------------------------------------------------------------

/**
 * Input to a single LangChain judge call for one dimension.
 *
 * The judge evaluates `response` against `reference` for the given
 * `dimension` and returns a numeric score in `[0, 1]` with a rationale.
 *
 * All fields are plain text / structured data — no LangChain types bleed
 * through this interface into the caller.
 */
export interface JudgeInput {
  /** The scoring dimension being evaluated. */
  dimension: ScoringDimension;
  /**
   * A human-readable description of what correctness means for this
   * dimension and case. Injected into the judge prompt as the rubric.
   */
  rubricDescription: string;
  /**
   * The model's response / action sequence to evaluate.
   * For routing/delegation, this is the serialised agent sequence.
   * For execution, this is a summary of artifacts and completion signal.
   * For rationale quality, this is the raw response text.
   */
  response: string;
  /**
   * The reference (gold standard) for correctness.
   * For routing/delegation, this is the expected agent sequence.
   * For execution, this is a description of required artifacts.
   * For rationale quality, this is a quality description rubric.
   */
  reference: string;
}

/**
 * The normalized output of a single LangChain judge call.
 *
 * The `score` must be in `[0, 1]`. The `rationale` must be non-empty.
 * These are the only constraints the caller enforces — validation happens
 * at the adapter boundary before being placed in `DimensionScore`.
 */
export interface JudgeOutput {
  /**
   * Numeric score in the closed interval `[0, 1]`.
   * Values outside this range are clamped by the scorer before use.
   */
  score: number;
  /** Human-readable explanation of the score. Must be non-empty. */
  rationale: string;
}

/**
 * Narrow interface for calling the LangChain AgentEvals judge.
 *
 * Production implementations call a LangChain `ChatModel` with an
 * evaluation prompt and parse the structured output. Tests substitute
 * `StubLangChainJudge` to exercise scorer logic without LangChain or
 * provider calls.
 *
 * The interface is intentionally minimal — one method, typed I/O —
 * so implementations stay focused and test doubles stay simple.
 */
export interface LangChainJudge {
  /**
   * Evaluate `input.response` against `input.reference` for the given
   * dimension and return a normalized score with rationale.
   *
   * @param input - The evaluation context.
   * @returns `ResultAsync<JudgeOutput, ScoringError>`.
   */
  evaluate(input: JudgeInput): ResultAsync<JudgeOutput, ScoringError>;
}

// ---------------------------------------------------------------------------
// RealLangChainJudge — production adapter to LangChain AgentEvals
// ---------------------------------------------------------------------------

/**
 * Prompt template used when calling `createLLMAsJudge` from `openevals/llm`.
 *
 * Variables injected by the scorer:
 *   - `{rubric}`             — description of what correctness means for this
 *                              dimension; interpolated at evaluator-creation time
 *   - `{outputs}`            — the model's actual output (serialised); filled at
 *                              call time by `createLLMAsJudge` from the `outputs`
 *                              parameter passed to the evaluator
 *   - `{reference_outputs}`  — the expected / gold-standard output (serialised);
 *                              filled at call time from the `reference_outputs`
 *                              parameter (snake_case, as expected by openevals)
 *
 * IMPORTANT: `createLLMAsJudge` uses LangChain's `ChatPromptTemplate.fromTemplate`
 * to render the prompt at call time. Template variables must use the exact names
 * that openevals passes: `outputs` and `reference_outputs` (snake_case). Using
 * `referenceOutputs` (camelCase) or a custom name like `reference` causes a
 * "Missing value for input variable" error.
 *
 * The `{rubric}` placeholder is interpolated manually at evaluator-creation time
 * (not by LangChain) because `createLLMAsJudge` binds the full prompt string at
 * creation, not at call time. Each distinct `rubricDescription` therefore requires
 * its own evaluator. See `RealLangChainJudge._evaluatorCache` for the per-rubric
 * cache.
 */
const JUDGE_PROMPT_TEMPLATE = `You are an expert evaluator for AI agent systems.

<Rubric>
{rubric}
</Rubric>

Grade the following response against the reference. Score 1.0 for fully correct,
0.0 for completely wrong, and a value in between for partial credit.

<reference>
{reference_outputs}
</reference>

<response>
{outputs}
</response>`;

/**
 * Narrow type for the result returned by the wrapped evaluator from
 * `createLLMAsJudge`.
 *
 * The wrapped evaluator returns `EvaluatorResult & Record<string, unknown>`
 * (from `openevals/types`). We only use the `score` and `comment` fields.
 * `comment` carries the `reasoning` string when `useReasoning: true` (the
 * openevals internals name it `reasoning` but expose it as `comment` in the
 * `EvaluatorResult` wrapper).
 *
 * Keeping this narrow avoids importing the full `openevals` type graph at
 * module-load time.
 */
interface OpenEvalsResult {
  score: number | boolean;
  comment?: string;
}

/**
 * The evaluator function returned by `createLLMAsJudge`.
 *
 * The wrapped evaluator (produced by `_runEvaluatorUntyped` inside openevals)
 * accepts a `Record<string, unknown>` and returns `EvaluatorResult & Record<string, unknown>`.
 *
 * When calling the evaluator we must pass:
 *   - `outputs`           — the model's response (string); fills `{outputs}` in the prompt
 *   - `reference_outputs` — the gold-standard reference (string, snake_case); fills
 *                           `{reference_outputs}` in the prompt
 *
 * Both names are snake_case as required by `ChatPromptTemplate.fromTemplate` inside
 * openevals. Passing `referenceOutputs` (camelCase) causes a
 * "Missing value for input variable `reference_outputs`" error.
 */
type OpenEvalsEvaluator = (params: {
  outputs: string;
  reference_outputs?: string;
  [key: string]: unknown;
}) => Promise<OpenEvalsResult>;

/**
 * The shape of the `createLLMAsJudge` factory imported from `openevals/llm`.
 *
 * Typed narrowly so the real dynamic import and test-injected factories share
 * the same interface. Tests inject a `CreateLLMAsJudgeFactory` that records
 * which prompt (and therefore which rubric) was used to create each evaluator,
 * proving per-rubric evaluator isolation without real LangChain calls.
 */
type CreateLLMAsJudgeFactory = (options: {
  prompt: string;
  feedbackKey: string;
  judge: BaseChatModel;
  continuous: boolean;
  useReasoning: boolean;
}) => OpenEvalsEvaluator;

/**
 * The shape of the `openevals/llm` module that `RealLangChainJudge` imports.
 *
 * Using a narrow interface lets tests inject a fake module without importing
 * the full `openevals` package. The real dynamic import resolves to this shape.
 */
interface OpenEvalsLlmModule {
  createLLMAsJudge: CreateLLMAsJudgeFactory;
}

/**
 * Production `LangChainJudge` implementation that uses LangChain AgentEvals
 * (`openevals/llm`'s `createLLMAsJudge`) to evaluate model outputs.
 *
 * ## Why `openevals/llm`?
 *
 * `agentevals` is the higher-level package for agent-specific evaluators
 * (trajectory correctness, tool selection, etc.). However, the LLM-as-judge
 * primitive — `createLLMAsJudge` — lives in the lower-level `openevals/llm`
 * module that `agentevals` itself depends on. Using `openevals/llm` directly
 * gives us the rubric-parameterised, continuous-score judge without pulling
 * in the full agent-trajectory evaluation stack. If `agentevals` exposes
 * a stable `createLLMAsJudge` re-export in a future release, the import
 * path can be changed in this file only.
 *
 * ## Evaluator caching — per rubric, not global
 *
 * `createLLMAsJudge` **binds the full prompt template at creation time**.
 * The rubric text is interpolated into `JUDGE_PROMPT_TEMPLATE` before being
 * passed to `createLLMAsJudge`, so two calls with different `rubricDescription`
 * values must produce two distinct evaluators. A single cached evaluator
 * (the previous implementation) would silently evaluate all subsequent
 * dimensions using the rubric from the first call — a correctness bug.
 *
 * `RealLangChainJudge` therefore maintains a `Map<rubricDescription, evaluator>`
 * so each distinct rubric gets exactly one evaluator (created lazily on first
 * use). The `openevals/llm` module import itself is cached separately via
 * `_moduleCache` so the dynamic import overhead occurs only once per
 * `RealLangChainJudge` instance, regardless of how many distinct rubrics are
 * encountered.
 *
 * ## Import isolation
 *
 * The import of `openevals/llm` is deferred to the first `evaluate()` call
 * via a dynamic `import()` call. This makes `RealLangChainJudge` safe to
 * construct in environments where the ESM package may not be immediately
 * available at module-load time, and keeps the static import graph clean.
 *
 * ## Usage
 *
 * ```ts
 * import { ChatOpenAI } from "@langchain/openai";
 * import { RealLangChainJudge } from "./langchain-agent-evals.js";
 * import { LangChainAgentEvalsScorer } from "./langchain-agent-evals.js";
 *
 * const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
 * const judge = new RealLangChainJudge(model);
 * const scorer = new LangChainAgentEvalsScorer(judge);
 *
 * const result = await scorer.score(run, evalCase, rubrics);
 * ```
 *
 * ## Testability
 *
 * Pass a `moduleLoader` to inject a fake `openevals/llm` module in tests:
 *
 * ```ts
 * const fakeModule = { createLLMAsJudge: (opts) => async (_) => ({ score: 1, comment: "ok" }) };
 * const judge = new RealLangChainJudge(model, () => Promise.resolve(fakeModule));
 * ```
 *
 * This lets tests prove per-rubric evaluator isolation without real LangChain
 * or provider calls.
 */
export class RealLangChainJudge implements LangChainJudge {
  /**
   * Per-rubric evaluator cache.
   *
   * Key: the `rubricDescription` string exactly as passed to `evaluate()`.
   * Value: the evaluator created by `createLLMAsJudge` with that rubric
   *        interpolated into `JUDGE_PROMPT_TEMPLATE`.
   *
   * A new entry is created on the first `evaluate()` call for each distinct
   * rubric. Entries are never evicted (the set of distinct rubrics per eval
   * run is small and bounded by the number of dimensions × cases).
   *
   * @internal — exposed as `readonly` for test introspection only.
   */
  readonly _evaluatorCache: Map<string, OpenEvalsEvaluator> = new Map();

  /**
   * Cached `openevals/llm` module reference.
   *
   * Populated on the first `evaluate()` call. Subsequent calls reuse the
   * cached module without a new dynamic import. Kept separate from
   * `_evaluatorCache` so the import overhead occurs only once regardless of
   * how many distinct rubrics are encountered.
   */
  private _moduleCache: OpenEvalsLlmModule | undefined = undefined;

  /**
   * Optional injected module loader — used in tests to supply a fake
   * `openevals/llm` module without a real dynamic import.
   *
   * When `undefined` (default), the real `import("openevals/llm")` is used.
   */
  private readonly _moduleLoader: () => Promise<OpenEvalsLlmModule>;

  constructor(
    private readonly model: BaseChatModel,
    /**
     * Optional factory that resolves the `openevals/llm` module.
     *
     * Defaults to `() => import("openevals/llm")`. Pass a custom loader in
     * tests to inject a fake module and verify per-rubric evaluator isolation
     * without real LangChain or provider calls.
     */
    moduleLoader?: () => Promise<OpenEvalsLlmModule>,
  ) {
    this._moduleLoader =
      moduleLoader ??
      (() => import("openevals/llm") as Promise<OpenEvalsLlmModule>);
  }

  /**
   * Load the `openevals/llm` module (caching after first load) and return
   * the evaluator for the given `rubricDescription`.
   *
   * Evaluators are cached per `rubricDescription`. If an evaluator for this
   * rubric does not yet exist, `createLLMAsJudge` is called with the rubric
   * interpolated into `JUDGE_PROMPT_TEMPLATE` to create a new one.
   *
   * This ensures each distinct rubric always uses the correct prompt —
   * a cached evaluator from a previous rubric is never reused for a
   * different rubric.
   */
  private loadEvaluator(
    rubricDescription: string,
  ): ResultAsync<OpenEvalsEvaluator, ScoringError> {
    // Fast path: evaluator for this exact rubric already cached.
    const cached = this._evaluatorCache.get(rubricDescription);
    if (cached !== undefined) {
      return ResultAsync.fromSafePromise(Promise.resolve(cached));
    }

    return ResultAsync.fromPromise(
      (async () => {
        // Load the module once; subsequent calls for different rubrics reuse
        // the cached module without a new dynamic import.
        if (this._moduleCache === undefined) {
          this._moduleCache = await this._moduleLoader();
        }

        const { createLLMAsJudge } = this._moduleCache;

        // Interpolate the rubric into the prompt template.
        // createLLMAsJudge binds this at evaluator-creation time, so each
        // distinct rubric produces a separate evaluator with the correct
        // rubric text baked in.
        const prompt = JUDGE_PROMPT_TEMPLATE.replace(
          "{rubric}",
          rubricDescription,
        );

        const evaluator = createLLMAsJudge({
          prompt,
          feedbackKey: "score",
          judge: this.model,
          continuous: true,
          useReasoning: true,
        });

        // Cache by rubric description so subsequent calls for the same
        // rubric do not incur createLLMAsJudge overhead.
        this._evaluatorCache.set(rubricDescription, evaluator);
        return evaluator;
      })(),
      (cause): ScoringError => ({
        type: "ScorerAdapterError",
        caseId: "(unknown — load failure)",
        dimension: "rationaleQuality",
        message:
          `Failed to load openevals/llm via dynamic import: ${String(cause)}. ` +
          `Ensure agentevals and its peer dependencies are installed.`,
      }),
    );
  }

  evaluate(input: JudgeInput): ResultAsync<JudgeOutput, ScoringError> {
    return this.loadEvaluator(input.rubricDescription).andThen((evaluator) =>
      ResultAsync.fromPromise(
        evaluator({
          outputs: input.response,
          // Use snake_case `reference_outputs` — this is the exact parameter name
          // that openevals' `ChatPromptTemplate.fromTemplate` expects to fill
          // the `{reference_outputs}` placeholder in the prompt string.
          // Passing `referenceOutputs` (camelCase) leaves `{reference_outputs}`
          // unfilled and causes "Missing value for input variable" errors.
          reference_outputs: input.reference,
        }),
        (cause): ScoringError => ({
          type: "ScorerAdapterError",
          caseId: "(unknown — evaluate call failure)",
          dimension: input.dimension,
          message:
            `LangChain AgentEvals judge call failed for dimension ` +
            `"${input.dimension}": ${String(cause)}`,
        }),
      ).andThen((result): ResultAsync<JudgeOutput, ScoringError> => {
        // openevals returns score as number | boolean; normalise to number
        let rawScore: number;
        if (typeof result.score === "boolean") {
          rawScore = result.score ? 1.0 : 0.0;
        } else {
          rawScore = result.score;
        }

        const rationale =
          result.comment !== undefined && result.comment.trim() !== ""
            ? result.comment
            : `Score ${rawScore.toFixed(2)} (no rationale provided by judge)`;

        return ResultAsync.fromSafePromise(
          Promise.resolve<JudgeOutput>({ score: rawScore, rationale }),
        );
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Rationale projection — sanitized input for the judge
// ---------------------------------------------------------------------------

/**
 * Maximum character length of the rationale projection sent to the judge.
 *
 * The projection is a strictly structured summary of safe `ModelRunOutput`
 * fields only — it never contains `rawContent`, prompt text, transcript
 * content, tool arguments, or any substring of model output. The limit
 * caps the combined length of all safe structural fields.
 */
export const RATIONALE_PROJECTION_MAX_CHARS = 2000;

/**
 * Produce a strictly structured, allowlisted projection of a model run output
 * suitable for submission to the LLM judge for `rationaleQuality` scoring.
 *
 * **Security contract**: This function MUST NOT include any of the following:
 *   - `run.rawContent` (raw model output text)
 *   - `run.transcript` content (message bodies, tool arguments)
 *   - Any prompt text or system prompt snippets
 *   - Any substring of model-generated content
 *
 * The projection is derived exclusively from the safe structural fields of
 * `ModelRunOutput`:
 *   - `routedAgents`       — ordered list of agent names the model nominated
 *   - `delegationChain`    — ordered delegation chain expressed by the model
 *   - `completionSignalled` — boolean completion flag
 *   - `producedArtifacts`  — list of artifact names (identifiers only)
 *   - Derived counts/lengths for context (never content)
 *
 * Raw prompt text, full transcripts, tool arguments, and `rawContent` are
 * NEVER included — those live in local-only `RawCaseResultArtifact` records.
 *
 * @param run - The model run output to project.
 * @returns A structured, safe string for judge input (never contains rawContent).
 */
export function buildRationaleProjection(run: ModelRunOutput): string {
  const parts: string[] = [];

  // Routing signal — agent names only (identifiers, not content)
  if (run.routedAgents.length > 0) {
    parts.push(`routed_agents: [${run.routedAgents.join(", ")}]`);
  } else {
    parts.push("routed_agents: (none)");
  }

  // Delegation chain — agent names only (identifiers, not content)
  if (run.delegationChain.length > 0) {
    parts.push(`delegation_chain: ${run.delegationChain.join(" → ")}`);
  } else {
    parts.push("delegation_chain: (none)");
  }

  // Completion signal — boolean only
  parts.push(`completion_signalled: ${run.completionSignalled}`);

  // Produced artifacts — artifact names only (identifiers, not content)
  if (run.producedArtifacts.length > 0) {
    parts.push(`produced_artifacts: [${run.producedArtifacts.join(", ")}]`);
  } else {
    parts.push("produced_artifacts: (none)");
  }

  // Transcript message count — count only, never content
  parts.push(`transcript_message_count: ${run.transcript.length}`);

  const projection = parts.join("; ");

  // Cap to maximum to guard against unbounded identifier lists
  if (projection.length > RATIONALE_PROJECTION_MAX_CHARS) {
    return `${projection.slice(0, RATIONALE_PROJECTION_MAX_CHARS)}… [truncated]`;
  }

  return projection;
}

/**
 * Clamp a score value to the closed interval `[0, 1]`.
 *
 * Judge outputs are user-supplied and may be out of range when adapters
 * parse numeric output from free-form LLM text. Clamping ensures the
 * output contract is always satisfied.
 */
function clampScore(score: number): number {
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

/**
 * Build the rubric description string for the routing correctness dimension.
 *
 * The description is injected into the judge prompt as context for what
 * "correct routing" means for this specific case.
 */
function buildRoutingRubric(evalCase: EvalCase): string {
  if (evalCase.expected_outcome.kind !== "agent_routing") {
    return `Not applicable for case kind "${evalCase.expected_outcome.kind}". Routing is not assessed.`;
  }
  const via =
    evalCase.expected_outcome.via.length > 0
      ? ` via [${evalCase.expected_outcome.via.join(" → ")}]`
      : " directly";
  const alternates =
    evalCase.accepted_alternates.length > 0
      ? ` Accepted alternates: [${evalCase.accepted_alternates.join(", ")}].`
      : "";
  return (
    `The model should route to agent "${evalCase.expected_outcome.target_agent}"${via}.` +
    alternates
  );
}

/**
 * Build the rubric description for the delegation correctness dimension.
 */
function buildDelegationRubric(evalCase: EvalCase): string {
  if (evalCase.expected_outcome.kind !== "delegation_chain") {
    return `Not applicable for case kind "${evalCase.expected_outcome.kind}". Delegation chain is not assessed.`;
  }
  const chain = evalCase.expected_outcome.chain.join(" → ");
  return `The model should express the delegation chain: ${chain}.`;
}

/**
 * Build the rubric description for the execution completeness dimension.
 */
function buildExecutionRubric(evalCase: EvalCase): string {
  if (evalCase.expected_outcome.kind !== "task_completion") {
    return `Not applicable for case kind "${evalCase.expected_outcome.kind}". Execution completeness is not assessed.`;
  }
  const artifacts =
    evalCase.expected_outcome.required_artifacts.length > 0
      ? ` Required artifacts: [${evalCase.expected_outcome.required_artifacts.join(", ")}].`
      : " No specific artifacts required.";
  return `The model should complete the task: ${evalCase.expected_outcome.description}.${artifacts}`;
}

/**
 * Build the rubric description for the rationale quality dimension.
 */
function buildRationaleRubric(evalCase: EvalCase, rubric: EvalRubric): string {
  const notes =
    rubric.scoring.notes !== undefined && rubric.scoring.notes.trim() !== ""
      ? ` Reviewer notes: ${rubric.scoring.notes}`
      : "";
  return (
    `Evaluate the quality of the model's rationale for case: ${evalCase.description}.` +
    ` A high-quality rationale is coherent, directly relevant to the task, and sufficiently detailed.${notes}`
  );
}

/**
 * Serialise a model run output's routing signal as a string for the judge.
 */
function serialiseRoutingSignal(run: ModelRunOutput): string {
  if (run.routedAgents.length === 0) {
    return "(no agent routing expressed)";
  }
  return `Routed to: [${run.routedAgents.join(", ")}]`;
}

/**
 * Serialise the routing reference (expected outcome) as a string.
 */
function serialiseRoutingReference(evalCase: EvalCase): string {
  if (evalCase.expected_outcome.kind !== "agent_routing") {
    return "(routing not applicable)";
  }
  const via =
    evalCase.expected_outcome.via.length > 0
      ? ` via [${evalCase.expected_outcome.via.join(" → ")}]`
      : " directly";
  return `Expected: "${evalCase.expected_outcome.target_agent}"${via}`;
}

/**
 * Serialise the delegation chain signal from a model run.
 */
function serialiseDelegationSignal(run: ModelRunOutput): string {
  if (run.delegationChain.length === 0) {
    return "(no delegation chain expressed)";
  }
  return `Delegation chain: ${run.delegationChain.join(" → ")}`;
}

/**
 * Serialise the delegation reference (expected outcome) as a string.
 */
function serialiseDelegationReference(evalCase: EvalCase): string {
  if (evalCase.expected_outcome.kind !== "delegation_chain") {
    return "(delegation chain not applicable)";
  }
  return `Expected chain: ${evalCase.expected_outcome.chain.join(" → ")}`;
}

/**
 * Serialise the execution completeness signal from a model run.
 */
function serialiseExecutionSignal(run: ModelRunOutput): string {
  const completion = run.completionSignalled
    ? "completion signalled"
    : "no completion signal";
  const artifacts =
    run.producedArtifacts.length > 0
      ? `artifacts produced: [${run.producedArtifacts.join(", ")}]`
      : "no artifacts produced";
  return `${completion}; ${artifacts}`;
}

/**
 * Serialise the execution reference (expected outcome) as a string.
 */
function serialiseExecutionReference(evalCase: EvalCase): string {
  if (evalCase.expected_outcome.kind !== "task_completion") {
    return "(execution completeness not applicable)";
  }
  const artifacts =
    evalCase.expected_outcome.required_artifacts.length > 0
      ? `; required artifacts: [${evalCase.expected_outcome.required_artifacts.join(", ")}]`
      : "; no specific artifacts required";
  return `Task: ${evalCase.expected_outcome.description}${artifacts}`;
}

// ---------------------------------------------------------------------------
// Weighted total computation (pure)
// ---------------------------------------------------------------------------

/**
 * Compute the weighted total score from dimension scores and rubric weights.
 *
 * The primary dimension weight comes from `rubric.scoring.outcome_weight`.
 * The rationale quality weight comes from `rubric.scoring.per_expectation_weight`.
 * Non-applicable dimensions are excluded from the weighted average so they
 * do not dilute the score for valid dimensions.
 *
 * When no applicable dimensions exist (degenerate case), returns `0.0`.
 */
function computeWeightedTotal(
  dimensions: Record<ScoringDimension, DimensionScore>,
  outcomeWeight: number,
  perExpectationWeight: number,
): number {
  const primaryDimensions: ScoringDimension[] = [
    "routingCorrectness",
    "delegationCorrectness",
    "executionCompleteness",
  ];

  // Find which primary dimensions are applicable
  const applicablePrimary = primaryDimensions.filter(
    (d) => dimensions[d].applicable,
  );

  // Rationale quality always contributes via per_expectation_weight
  const rationaleApplicable = dimensions.rationaleQuality.applicable;

  // Distribute primary weight evenly across applicable primary dimensions
  let totalWeight = 0;
  let weightedSum = 0;

  if (applicablePrimary.length > 0) {
    const primaryWeightEach = outcomeWeight / applicablePrimary.length;
    for (const dim of applicablePrimary) {
      weightedSum += dimensions[dim].score * primaryWeightEach;
      totalWeight += primaryWeightEach;
    }
  }

  if (rationaleApplicable) {
    weightedSum += dimensions.rationaleQuality.score * perExpectationWeight;
    totalWeight += perExpectationWeight;
  }

  if (totalWeight === 0) {
    return 0;
  }

  // Normalise to [0, 1] even if weights don't sum to 1
  return weightedSum / totalWeight;
}

/**
 * Determine whether a case passes based on the weighted total and rubric.
 *
 * Passing requires:
 *   1. `weightedTotal >= PASS_THRESHOLD`
 *   2. If `required`, at least one applicable primary dimension must be `1.0`
 *      (hard correctness gate for mandatory cases).
 */
function determinePassed(
  dimensions: Record<ScoringDimension, DimensionScore>,
  weightedTotal: number,
  required: boolean,
): boolean {
  if (weightedTotal < PASS_THRESHOLD) {
    return false;
  }

  if (!required) {
    return true;
  }

  // For required cases, the primary applicable dimension must be perfect
  const primaryDimensions: ScoringDimension[] = [
    "routingCorrectness",
    "delegationCorrectness",
    "executionCompleteness",
  ];

  const applicablePrimary = primaryDimensions.filter(
    (d) => dimensions[d].applicable,
  );

  if (applicablePrimary.length === 0) {
    // No primary dimension to gate on — pass on total alone
    return true;
  }

  return applicablePrimary.some((d) => dimensions[d].score === 1.0);
}

// ---------------------------------------------------------------------------
// Non-applicable dimension helper
// ---------------------------------------------------------------------------

/**
 * Build a neutral `DimensionScore` for a dimension that is not applicable
 * to the given case kind.
 *
 * Non-applicable dimensions carry `applicable: false`, `score: 1.0` (neutral —
 * does not penalize), and a rationale explaining why.
 */
function notApplicableDimension(reason: string): DimensionScore {
  return {
    score: 1.0,
    rationale: `Not applicable: ${reason}`,
    applicable: false,
  };
}

// ---------------------------------------------------------------------------
// AgentEvalsScorer — the public scoring interface
// ---------------------------------------------------------------------------

/**
 * Public interface for the AgentEvals scoring adapter.
 *
 * Implementations consume a `ModelRunOutput` alongside the corresponding
 * `EvalCase` and `EvalRubric`, then produce a `NormalizedScoreRecord` for
 * one case × model pair.
 *
 * The interface is the stable boundary between the eval runner and the
 * scoring engine. Adapters (production, stub) implement this interface.
 */
export interface AgentEvalsScorer {
  /**
   * Score a single model run output against the rubric.
   *
   * @param run - The model run output to score.
   * @param evalCase - The eval case fixture for the run.
   * @param rubrics - The full set of rubrics; the scorer looks up the
   *                  matching rubric by `case_id`.
   * @param scoredAt - Optional ISO 8601 timestamp (defaults to now).
   *                   Inject in tests for deterministic output.
   * @returns `ResultAsync<NormalizedScoreRecord, ScoringError>`.
   */
  score(
    run: ModelRunOutput,
    evalCase: EvalCase,
    rubrics: EvalRubric[],
    scoredAt?: string,
  ): ResultAsync<NormalizedScoreRecord, ScoringError>;
}

// ---------------------------------------------------------------------------
// LangChainAgentEvalsScorer — production implementation
// ---------------------------------------------------------------------------

/**
 * Production `AgentEvalsScorer` that delegates dimension scoring to an
 * injected `LangChainJudge`.
 *
 * Each dimension call produces a `JudgeOutput` that is clamped and wrapped
 * in a `DimensionScore`. Non-applicable dimensions are short-circuited
 * without calling the judge.
 *
 * The `LangChainJudge` is the only place where real LangChain or provider
 * API calls should occur. All other logic in this class is pure.
 *
 * ## Usage
 *
 * ```ts
 * const judge = new RealLangChainJudge(model); // from @langchain/*
 * const scorer = new LangChainAgentEvalsScorer(judge);
 * const result = await scorer.score(run, evalCase, rubrics);
 * ```
 */
export class LangChainAgentEvalsScorer implements AgentEvalsScorer {
  constructor(private readonly judge: LangChainJudge) {}

  score(
    run: ModelRunOutput,
    evalCase: EvalCase,
    rubrics: EvalRubric[],
    scoredAt: string = new Date().toISOString(),
  ): ResultAsync<NormalizedScoreRecord, ScoringError> {
    // --- Rubric lookup ---
    const rubric = rubrics.find((r) => r.case_id === run.caseId);
    if (rubric === undefined) {
      return new ResultAsync(
        Promise.resolve(
          err<NormalizedScoreRecord, ScoringError>({
            type: "RubricNotFound",
            caseId: run.caseId,
            message:
              `No rubric found for case "${run.caseId}". ` +
              `Ensure a rubric file exists at evals/rubrics/<suite>/${run.caseId}.json.`,
          }),
        ),
      );
    }

    // Integrity check — rubric must match the evalCase ID
    if (rubric.case_id !== evalCase.id) {
      return new ResultAsync(
        Promise.resolve(
          err<NormalizedScoreRecord, ScoringError>({
            type: "RubricCaseMismatch",
            caseId: run.caseId,
            rubricCaseId: rubric.case_id,
            message:
              `Rubric case_id "${rubric.case_id}" does not match ` +
              `EvalCase.id "${evalCase.id}". ` +
              `Pass matching case and rubric fixtures to the scorer.`,
          }),
        ),
      );
    }

    const outcomeWeight = rubric.scoring.outcome_weight;
    const perExpectationWeight = rubric.scoring.per_expectation_weight;
    const required = rubric.scoring.required;
    const outcomeKind = evalCase.expected_outcome.kind;

    // --- Determine applicability per dimension ---
    const routingApplicable = outcomeKind === "agent_routing";
    const delegationApplicable = outcomeKind === "delegation_chain";
    const executionApplicable = outcomeKind === "task_completion";
    // rationaleQuality is always applicable (quality of text is universal)

    // --- Build judge calls for applicable dimensions ---
    const judgeRoutingAsync: ResultAsync<DimensionScore, ScoringError> =
      routingApplicable
        ? this.judge
            .evaluate({
              dimension: "routingCorrectness",
              rubricDescription: buildRoutingRubric(evalCase),
              response: serialiseRoutingSignal(run),
              reference: serialiseRoutingReference(evalCase),
            })
            .map((output) => ({
              score: clampScore(output.score),
              rationale: output.rationale || "(no rationale provided)",
              applicable: true,
            }))
        : new ResultAsync(
            Promise.resolve(
              ok<DimensionScore, ScoringError>(
                notApplicableDimension(
                  `outcome kind is "${outcomeKind}", not "agent_routing"`,
                ),
              ),
            ),
          );

    const judgeDelegationAsync: ResultAsync<DimensionScore, ScoringError> =
      delegationApplicable
        ? this.judge
            .evaluate({
              dimension: "delegationCorrectness",
              rubricDescription: buildDelegationRubric(evalCase),
              response: serialiseDelegationSignal(run),
              reference: serialiseDelegationReference(evalCase),
            })
            .map((output) => ({
              score: clampScore(output.score),
              rationale: output.rationale || "(no rationale provided)",
              applicable: true,
            }))
        : new ResultAsync(
            Promise.resolve(
              ok<DimensionScore, ScoringError>(
                notApplicableDimension(
                  `outcome kind is "${outcomeKind}", not "delegation_chain"`,
                ),
              ),
            ),
          );

    const judgeExecutionAsync: ResultAsync<DimensionScore, ScoringError> =
      executionApplicable
        ? this.judge
            .evaluate({
              dimension: "executionCompleteness",
              rubricDescription: buildExecutionRubric(evalCase),
              response: serialiseExecutionSignal(run),
              reference: serialiseExecutionReference(evalCase),
            })
            .map((output) => ({
              score: clampScore(output.score),
              rationale: output.rationale || "(no rationale provided)",
              applicable: true,
            }))
        : new ResultAsync(
            Promise.resolve(
              ok<DimensionScore, ScoringError>(
                notApplicableDimension(
                  `outcome kind is "${outcomeKind}", not "task_completion"`,
                ),
              ),
            ),
          );

    const judgeRationaleAsync: ResultAsync<DimensionScore, ScoringError> =
      this.judge
        .evaluate({
          dimension: "rationaleQuality",
          rubricDescription: buildRationaleRubric(evalCase, rubric),
          response: buildRationaleProjection(run),
          reference: `Evaluate quality for: ${evalCase.description}`,
        })
        .map((output) => ({
          score: clampScore(output.score),
          rationale: output.rationale || "(no rationale provided)",
          applicable: true,
        }));

    // --- Settle all four dimension calls in parallel ---
    return new ResultAsync(
      Promise.all([
        judgeRoutingAsync,
        judgeDelegationAsync,
        judgeExecutionAsync,
        judgeRationaleAsync,
      ]).then(
        ([
          routingResult,
          delegationResult,
          executionResult,
          rationaleResult,
        ]) => {
          if (routingResult.isErr()) {
            return err<NormalizedScoreRecord, ScoringError>(
              routingResult.error,
            );
          }
          if (delegationResult.isErr()) {
            return err<NormalizedScoreRecord, ScoringError>(
              delegationResult.error,
            );
          }
          if (executionResult.isErr()) {
            return err<NormalizedScoreRecord, ScoringError>(
              executionResult.error,
            );
          }
          if (rationaleResult.isErr()) {
            return err<NormalizedScoreRecord, ScoringError>(
              rationaleResult.error,
            );
          }

          const dimensions: Record<ScoringDimension, DimensionScore> = {
            routingCorrectness: routingResult.value,
            delegationCorrectness: delegationResult.value,
            executionCompleteness: executionResult.value,
            rationaleQuality: rationaleResult.value,
          };

          const weightedTotal = computeWeightedTotal(
            dimensions,
            outcomeWeight,
            perExpectationWeight,
          );
          const passed = determinePassed(dimensions, weightedTotal, required);

          return ok<NormalizedScoreRecord, ScoringError>({
            caseId: run.caseId,
            modelId: run.modelId,
            suite: evalCase.suite,
            dimensions,
            weightedTotal,
            passed,
            required,
            scoredAt,
          });
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// StubLangChainJudge — test double for the LangChain judge
// ---------------------------------------------------------------------------

/**
 * A configurable `LangChainJudge` stub for use in tests.
 *
 * Allows tests to specify per-call judge outputs without real LangChain or
 * provider calls. Outputs are consumed in FIFO order; after the queue is
 * exhausted the `defaultOutput` is used (or a typed `NotConfigured` error
 * is returned if neither a default output nor a default error is set).
 *
 * ## Usage
 *
 * ```ts
 * const judge = new StubLangChainJudge();
 * judge.enqueueOutput({ score: 1.0, rationale: "Correct routing." });
 * judge.enqueueOutput({ score: 0.5, rationale: "Partial chain." });
 *
 * const scorer = new LangChainAgentEvalsScorer(judge);
 * const result = await scorer.score(run, evalCase, rubrics);
 * ```
 */
export class StubLangChainJudge implements LangChainJudge {
  /**
   * Ordered record of all `evaluate()` calls received.
   * Inspect in tests to assert call count and input payloads.
   */
  readonly calls: JudgeInput[] = [];

  /** @internal */
  private readonly queue: Array<
    { ok: true; output: JudgeOutput } | { ok: false; error: ScoringError }
  > = [];

  /** @internal */
  private defaultEntry:
    | { ok: true; output: JudgeOutput }
    | { ok: false; error: ScoringError }
    | undefined = undefined;

  /**
   * Enqueue a successful judge output. Consumed on the next `evaluate()` call.
   */
  enqueueOutput(output: JudgeOutput): void {
    this.queue.push({ ok: true, output });
  }

  /**
   * Enqueue an error result. Consumed on the next `evaluate()` call.
   */
  enqueueError(error: ScoringError): void {
    this.queue.push({ ok: false, error });
  }

  /**
   * Set the default output used when the queue is exhausted.
   *
   * If not set and the queue is empty, `evaluate()` returns a typed
   * `NotConfigured` error — it never throws.
   */
  setDefaultOutput(output: JudgeOutput): void {
    this.defaultEntry = { ok: true, output };
  }

  /**
   * Set the default error used when the queue is exhausted.
   */
  setDefaultError(error: ScoringError): void {
    this.defaultEntry = { ok: false, error };
  }

  evaluate(input: JudgeInput): ResultAsync<JudgeOutput, ScoringError> {
    this.calls.push(input);

    const entry = this.queue.shift() ?? this.defaultEntry;

    if (entry === undefined) {
      const callIndex = this.calls.length - 1;
      return new ResultAsync(
        Promise.resolve(
          err<JudgeOutput, ScoringError>({
            type: "NotConfigured",
            callIndex,
            message:
              `StubLangChainJudge: no output configured for call ${callIndex + 1}. ` +
              `Use enqueueOutput() / enqueueError() or setDefaultOutput() / setDefaultError().`,
          }),
        ),
      );
    }

    if (entry.ok) {
      return new ResultAsync(Promise.resolve(ok(entry.output)));
    }
    return new ResultAsync(Promise.resolve(err(entry.error)));
  }
}

// ---------------------------------------------------------------------------
// StubAgentEvalsScorer — test double for the full scorer
// ---------------------------------------------------------------------------

/**
 * A configurable `AgentEvalsScorer` stub for use in tests that need to
 * bypass the scorer entirely (e.g. runner-level tests that only care about
 * routing, not scoring details).
 *
 * Analogous to `StubModelClient` — records calls and returns configured
 * results in FIFO order. When the queue is exhausted and no default is set,
 * returns a typed `NotConfigured` error.
 *
 * ## Usage
 *
 * ```ts
 * const scorer = new StubAgentEvalsScorer();
 * scorer.enqueueRecord(makeScoreRecord({ passed: true }));
 *
 * const result = await scorer.score(run, evalCase, rubrics);
 * expect(result.isOk()).toBe(true);
 * ```
 */
export class StubAgentEvalsScorer implements AgentEvalsScorer {
  /**
   * Ordered record of all `score()` calls received.
   */
  readonly calls: Array<{
    run: ModelRunOutput;
    evalCase: EvalCase;
    rubrics: EvalRubric[];
  }> = [];

  /** @internal */
  private readonly queue: Array<
    | { ok: true; record: NormalizedScoreRecord }
    | { ok: false; error: ScoringError }
  > = [];

  /** @internal */
  private defaultEntry:
    | { ok: true; record: NormalizedScoreRecord }
    | { ok: false; error: ScoringError }
    | undefined = undefined;

  /**
   * Enqueue a successful `NormalizedScoreRecord`.
   * Consumed on the next `score()` call.
   */
  enqueueRecord(record: NormalizedScoreRecord): void {
    this.queue.push({ ok: true, record });
  }

  /**
   * Enqueue an error result. Consumed on the next `score()` call.
   */
  enqueueError(error: ScoringError): void {
    this.queue.push({ ok: false, error });
  }

  /**
   * Set the default record used when the queue is exhausted.
   */
  setDefaultRecord(record: NormalizedScoreRecord): void {
    this.defaultEntry = { ok: true, record };
  }

  /**
   * Set the default error used when the queue is exhausted.
   */
  setDefaultError(error: ScoringError): void {
    this.defaultEntry = { ok: false, error };
  }

  score(
    run: ModelRunOutput,
    evalCase: EvalCase,
    rubrics: EvalRubric[],
  ): ResultAsync<NormalizedScoreRecord, ScoringError> {
    this.calls.push({ run, evalCase, rubrics });

    const entry = this.queue.shift() ?? this.defaultEntry;

    if (entry === undefined) {
      const callIndex = this.calls.length - 1;
      return new ResultAsync(
        Promise.resolve(
          err<NormalizedScoreRecord, ScoringError>({
            type: "NotConfigured",
            callIndex,
            message:
              `StubAgentEvalsScorer: no record configured for call ${callIndex + 1}. ` +
              `Use enqueueRecord() / enqueueError() or setDefaultRecord() / setDefaultError().`,
          }),
        ),
      );
    }

    if (entry.ok) {
      return new ResultAsync(Promise.resolve(ok(entry.record)));
    }
    return new ResultAsync(Promise.resolve(err(entry.error)));
  }
}
