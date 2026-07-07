/**
 * `weave eval run` command handler.
 *
 * Validates and executes an eval run. All execution paths that could
 * touch the network, git, or shell interpolation are behind the
 * `dryRun` flag or are injected as dependencies (making them testable
 * with mocks).
 *
 * Policy notes:
 *   - `--raw-artifacts` is a local-only opt-in. The CI guard lives in
 *     `input-validation.ts`; this handler trusts the validated request.
 *   - The handler is intentionally stateless: it receives all context
 *     as injected deps so tests can run a full dry-run without touching
 *     real resources.
 *   - When no `runner` is injected, the handler constructs a real
 *     `EvalOrchestrator` with production dependencies and delegates to it.
 *     This is the live production path.
 */

import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { ParsedArgs } from "../args.js";
import { type CliError, formatCliError } from "../errors.js";
import type { BundleWriteMode } from "../evals/artifact-bundle.js";
import { loadSuiteCases } from "../evals/case-loader.js";
import { readEvalEnv } from "../evals/env.js";
import {
  type EvalRunRequest,
  parseEvalRunRequest,
} from "../evals/input-validation.js";
import {
  type AgentEvalsScorer,
  LangChainAgentEvalsScorer,
  RealLangChainJudge,
} from "../evals/langchain-agent-evals.js";
import { filterMatrix, loadModelMatrix } from "../evals/model-matrix.js";
import {
  type ModelClient,
  type ModelClientError,
  type ModelRequest,
  type ModelResponse,
  OpenRouterClient,
} from "../evals/openrouter-client.js";
import { buildEvalRunner, EvalOrchestrator } from "../evals/runner.js";
import type {
  EvalCase,
  EvalRubric,
  ModelRunOutput,
  NormalizedScoreRecord,
  ScoringError,
} from "../evals/types.js";
import {
  EVAL_SHORT_AGENT_FILTERS,
  EVAL_SUITE_IDS,
  EVAL_SUITE_REGISTRY,
} from "../evals/types.js";
import type { TerminalIO } from "../io/terminal.js";
import type { ThemeColors } from "../theme/colors.js";

// ---------------------------------------------------------------------------
// Publish mode env var
// ---------------------------------------------------------------------------

/**
 * Environment variable that controls the eval bundle write mode.
 *
 * - `"local"` (default) — write sanitized bundles to `eval-bundles/` locally;
 *   no external push.
 * - `"publish"` — write locally AND push to `weave-io/weave-agent-evals` via
 *   the GitHub REST Contents API. Requires `EVAL_RESULTS_REPO_TOKEN`.
 *
 * Any value other than `"publish"` is treated as `"local"` (fail-safe).
 */
export const WEAVE_EVAL_PUBLISH_MODE_ENV_VAR = "WEAVE_EVAL_PUBLISH_MODE";

/**
 * Read the effective publish mode from the env map.
 *
 * Returns `"publish"` only when the env var is exactly `"publish"`.
 * All other values (including absent, empty, or unknown strings) return
 * `"local"`. This ensures the default is always safe.
 *
 * @param env - Environment variable map (defaults to `Bun.env`).
 * @returns The effective `BundleWriteMode`.
 */
export function readPublishMode(
  env: Record<string, string | undefined>,
): BundleWriteMode {
  const raw = env[WEAVE_EVAL_PUBLISH_MODE_ENV_VAR];
  if (raw !== undefined && raw.trim() === "publish") {
    return "publish";
  }
  return "local";
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface EvalContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  /**
   * Environment variable map used for input validation.
   * Defaults to `Bun.env` when omitted; inject in tests.
   */
  env?: Record<string, string | undefined>;
  /**
   * Optional runner injection point.
   * When provided, the handler delegates actual eval execution here.
   * When omitted, the handler reports that eval execution is not yet
   * implemented (safe placeholder for future tasks).
   *
   * In tests: supply a mock that records the request without side effects.
   */
  runner?: (request: EvalRunRequest) => Promise<Result<number, CliError>>;
  /**
   * Optional override for the filter allowlist validator.
   *
   * When provided, replaces the default async validation that loads the
   * model matrix and case fixtures to check `--model` and `--case` filters.
   * Inject in tests to avoid real file-system reads.
   *
   * Returns `ok(undefined)` when all filters are valid, or `err(CliError)`
   * when an unknown model or case is supplied.
   */
  validateFilters?: (
    request: EvalRunRequest,
  ) => Promise<Result<undefined, CliError>>;
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

const EVAL_USAGE = [
  "Usage: weave eval <subcommand>",
  "",
  "  weave eval run                        Run all configured evals",
  "  weave eval run --agent <name>         Filter to a specific short agent or suite",
  "  weave eval run --model <id>           Filter to a specific model",
  "  weave eval run --case <id>            Filter to a specific case",
  "  weave eval run --dry-run              Print what would run without executing",
  "  weave eval run --raw-artifacts        Emit raw artifacts to disk (local-only)",
  "",
  `  Short agents: ${EVAL_SHORT_AGENT_FILTERS.join(", ")}`,
  `  Suites: ${EVAL_SUITE_IDS.join(", ")}`,
].join("\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDryRunSummary(
  request: EvalRunRequest,
  theme: ThemeColors,
): string {
  const lines: string[] = [
    "",
    `${theme.boldCyan("Eval dry run")} ${theme.dim("— no execution will occur")}`,
    "",
  ];

  if (request.agent !== undefined) {
    lines.push(`  ${theme.cyan("Agent filter:")}  ${request.agent}`);
  }
  if (request.model !== undefined) {
    lines.push(`  ${theme.cyan("Model filter:")}  ${request.model}`);
  }
  if (request.case !== undefined) {
    lines.push(`  ${theme.cyan("Case filter:")}   ${request.case}`);
  }
  if (!request.agent && !request.model && !request.case) {
    lines.push(`  ${theme.dim("No filters applied — all cases would be run")}`);
  }
  if (request.rawArtifacts) {
    lines.push(`  ${theme.cyan("Raw artifacts:")} enabled (local-only)`);
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand: eval run
// ---------------------------------------------------------------------------

/**
 * Validate model and case filters against their respective allowlists.
 *
 * This validation runs BEFORE the dry-run branch so that unknown model/case
 * values fail closed in both dry-run and live paths.
 *
 * - Model filter: validated against `evals/model-matrix.json`. An unknown
 *   model fails with a user-facing `EvalValidation` error listing allowed IDs.
 * - Case filter: validated against loaded fixture IDs from all suites that
 *   would run (based on the agent filter). An unknown case ID fails with a
 *   user-facing `EvalValidation` error listing known case IDs.
 *
 * When no model or case filter is set, returns `ok(undefined)` immediately
 * without loading any fixtures.
 *
 * @param request - The validated (syntax-safe) eval run request.
 * @param evalsRoot - Optional override for the evals fixture root (tests only).
 * @returns `ok(undefined)` when all filters are valid; `err(CliError)` otherwise.
 */
async function defaultValidateFilters(
  request: EvalRunRequest,
  evalsRoot?: string,
): Promise<Result<undefined, CliError>> {
  // Validate model filter against the model matrix allowlist
  if (request.model !== undefined) {
    const matrixResult = await loadModelMatrix();
    if (matrixResult.isErr()) {
      return err({
        type: "EvalValidation",
        message: `Model matrix load failed: ${matrixResult.error.message}`,
      });
    }
    const matrix = matrixResult.value;
    const matches = filterMatrix(matrix, request.model);
    if (matches.length === 0) {
      const allowlist = matrix.models.map((m) => m.id).join(", ");
      return err({
        type: "EvalValidation",
        message:
          `--model "${request.model}" is not in the model matrix allowlist. ` +
          `Allowed model IDs: ${allowlist}`,
      });
    }
  }

  // Validate case filter against loaded fixture IDs
  if (request.case !== undefined) {
    const caseId = request.case;

    const selectedSuites = EVAL_SUITE_REGISTRY.filter((suite) => {
      if (request.agent === undefined) {
        return true;
      }

      return (
        request.agent === suite.shortAgentFilter ||
        request.agent === suite.suiteId
      );
    });

    // Load cases from all applicable suites
    const allCases: EvalCase[] = [];

    for (const suite of selectedSuites) {
      const suiteResult = await loadSuiteCases(suite.suiteId, evalsRoot);
      if (suiteResult.isErr()) {
        return err({
          type: "EvalValidation",
          message: `Case fixture load failed (${suite.suiteId}): ${suiteResult.error.message}`,
        });
      }
      allCases.push(...suiteResult.value);
    }

    const match = allCases.find((c) => c.id === caseId);
    if (match === undefined) {
      const known =
        allCases.length > 0
          ? allCases.map((c) => c.id).join(", ")
          : "(none loaded)";
      return err({
        type: "EvalValidation",
        message:
          `--case "${caseId}" is not in the fixture allowlist. ` +
          `Known case IDs: ${known}`,
      });
    }
  }

  return ok(undefined);
}

async function runEvalRun(ctx: EvalContext): Promise<Result<number, CliError>> {
  const { flags, env, terminal, theme } = ctx;

  const requestResult = parseEvalRunRequest({
    agent: flags.evalAgent,
    model: flags.evalModel,
    case: flags.evalCase,
    dryRun: flags.dryRun ?? false,
    rawArtifacts: flags.rawArtifacts ?? false,
    env,
  });

  if (requestResult.isErr()) {
    const ve = requestResult.error;
    terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message: ve.message,
      }),
    );
    return ok(1);
  }

  const request = requestResult.value;

  // Validate model and case filters against their allowlists BEFORE the
  // dry-run branch. Unknown model/case values must fail closed in both
  // dry-run and live paths.
  const filterValidator = ctx.validateFilters ?? defaultValidateFilters;
  const filterResult = await filterValidator(request);
  if (filterResult.isErr()) {
    terminal.stderr(formatCliError(filterResult.error));
    return ok(1);
  }

  if (ctx.runner !== undefined) {
    const result = await ctx.runner(request);
    if (result.isErr()) {
      terminal.stderr(formatCliError(result.error));
      return ok(1);
    }
    if (request.dryRun) {
      terminal.stdout(renderDryRunSummary(request, theme));
    }
    return ok(result.value);
  }

  // No injected runner: construct the appropriate production orchestrator.
  // This path uses real external dependencies (OpenRouter, LangChain, git).
  // Dry-runs intentionally use a validation-only runner that exercises the
  // same suite fixture/rubric path without requiring secrets, model calls,
  // or artifact writes.
  const runnerResult = request.dryRun
    ? buildDryRunRunner(ctx.env)
    : await buildLiveRunner(ctx.env);
  if (runnerResult.isErr()) {
    terminal.stderr(formatCliError(runnerResult.error));
    return ok(1);
  }
  const runner = runnerResult.value;
  const executionResult = await runner(request);
  if (executionResult.isErr()) {
    terminal.stderr(formatCliError(executionResult.error));
    return ok(1);
  }
  if (request.dryRun) {
    terminal.stdout(renderDryRunSummary(request, theme));
  }
  return ok(executionResult.value);
}

class DryRunModelClient implements ModelClient {
  complete(
    _request: ModelRequest,
  ): ResultAsync<ModelResponse, ModelClientError> {
    return new ResultAsync(
      Promise.resolve(
        err({
          type: "NotConfigured" as const,
          callIndex: 0,
          message:
            "DryRunModelClient should never be called. Dry-run validation must not make model requests.",
        }),
      ),
    );
  }
}

class DryRunScorer implements AgentEvalsScorer {
  score(
    _run: ModelRunOutput,
    _evalCase: EvalCase,
    _rubrics: EvalRubric[],
    _scoredAt?: string,
  ): ResultAsync<NormalizedScoreRecord, ScoringError> {
    return new ResultAsync(
      Promise.resolve(
        err({
          type: "NotConfigured" as const,
          callIndex: 0,
          message:
            "DryRunScorer should never be called. Dry-run validation must not score model output.",
        }),
      ),
    );
  }
}

function buildDryRunRunner(
  env?: Record<string, string | undefined>,
): Result<
  (request: EvalRunRequest) => Promise<Result<number, CliError>>,
  CliError
> {
  const orchestrator = new EvalOrchestrator({
    modelClient: new DryRunModelClient(),
    scorer: new DryRunScorer(),
    env: env ?? Bun.env,
  });

  return ok(buildEvalRunner(orchestrator));
}

/**
 * Default judge model ID for LangChain AgentEvals scoring via OpenRouter.
 *
 * Uses a capable, cost-effective model for rubric evaluation. The judge model
 * is separate from the eval runner models — it scores the outputs of those
 * models against the eval rubrics.
 *
 * Requirements:
 *   - Must be available on OpenRouter.
 *   - Must support structured JSON output (for score + rationale parsing).
 *   - Lower temperature is preferred for consistent, deterministic scoring.
 */
const JUDGE_MODEL_ID = "anthropic/claude-sonnet-4.5";

/**
 * Build the live production runner from real external dependencies.
 *
 * Constructs an `EvalOrchestrator` with:
 *   - `OpenRouterClient` for model inference
 *   - `LangChainAgentEvalsScorer(RealLangChainJudge)` for scoring via OpenRouter
 *   - The real `env` map for API key and token reads
 *
 * The scorer uses `@langchain/openai`'s `ChatOpenAI` configured to call
 * OpenRouter (via `apiKey` + `configuration.baseURL`). If the
 * `@langchain/openai` package cannot be imported or the environment is
 * invalid, this function returns `err(CliError)` — it never silently falls
 * back to a stub scorer.
 *
 * The API key is validated eagerly here before constructing any clients.
 * Validation errors surface as typed `CliError` values, not thrown exceptions.
 *
 * @param env - Environment variable map. Defaults to `Bun.env`.
 * @returns A `Promise<Result<runner, CliError>>` — err when the environment
 *          is invalid or the scorer cannot be constructed.
 */
async function buildLiveRunner(
  env?: Record<string, string | undefined>,
): Promise<
  Result<
    (request: EvalRunRequest) => Promise<Result<number, CliError>>,
    CliError
  >
> {
  const effectiveEnv = env ?? Bun.env;

  // Eagerly validate the API key so we can surface a typed error immediately
  // without constructing the model client first. This avoids any client
  // construction side effects before we know the env is valid.
  const envResult = readEvalEnv(effectiveEnv);
  if (envResult.isErr()) {
    const envErr = envResult.error;
    const message =
      envErr.type === "MissingApiKey"
        ? `${envErr.envVar} is required to run evals but was not set. ` +
          `Set it in your shell environment before running weave eval run.`
        : `Invalid OpenRouter base URL configuration. ` +
          `Remove OPENROUTER_BASE_URL to use the default.`;
    return err({ type: "EvalValidation", message });
  }

  const evalEnv = envResult.value;
  const modelClient = new OpenRouterClient(evalEnv);

  // Build the LangChain judge model targeting OpenRouter.
  //
  // @langchain/openai's ChatOpenAI accepts `apiKey` and a custom
  // `configuration.baseURL` so it can target any OpenAI-compatible provider
  // including OpenRouter. The judge model is a separate, dedicated model for
  // rubric scoring — distinct from the eval runner models.
  //
  // NOTE: `apiKey` (not the deprecated `openAIApiKey` alias) must be used
  // here. In v1, the `BaseChatOpenAI` constructor reads only `fields.apiKey`.
  //
  // If the import or construction fails for any reason, we fail closed with
  // a typed `EvalValidation` error — we never silently use a stub scorer.
  const scorerResult = await buildLangChainScorer(evalEnv);
  if (scorerResult.isErr()) {
    return err(scorerResult.error);
  }

  const scorer = scorerResult.value;

  // Read the publish mode from the environment.
  //
  // `WEAVE_EVAL_PUBLISH_MODE=publish` enables external publication to
  // `weave-io/weave-agent-evals` via the GitHub REST Contents API.
  // The mode defaults to "local" when the env var is absent or has any
  // value other than "publish". This ensures the default is always safe.
  //
  // When mode is "publish", the orchestrator verifies that
  // EVAL_RESULTS_REPO_TOKEN is set before writing any bundle artifacts.
  // The token is never logged, interpolated into shell commands, or
  // serialized to disk — it is passed only as an HTTP Authorization header
  // by GitHubContentsPublisher.
  const publishMode = readPublishMode(effectiveEnv);

  const orchestrator = new EvalOrchestrator({
    modelClient,
    scorer,
    env: effectiveEnv,
    publishMode,
  });

  return ok(buildEvalRunner(orchestrator));
}

/**
 * The shape of the `@langchain/openai` module that `buildLangChainScorer`
 * dynamically imports.
 *
 * Typed narrowly so tests can inject a fake module via
 * `langchainModuleLoader` without importing the full `@langchain/openai`
 * package. The real dynamic import resolves to (a superset of) this shape.
 */
export interface LangChainOpenAIModule {
  ChatOpenAI: new (fields: {
    model?: string;
    /** @deprecated alias — use `apiKey` in @langchain/openai v1 */
    modelName?: string;
    temperature?: number;
    /**
     * API key passed directly to the underlying OpenAI client.
     *
     * In `@langchain/openai` v1, `BaseChatOpenAI` constructor reads
     * `fields.apiKey` (NOT `fields.openAIApiKey`). Passing
     * `openAIApiKey` is silently ignored by the runtime even though
     * the TypeScript alias still exists on `OpenAIBaseInput`. Always
     * use `apiKey` when targeting OpenRouter or any non-standard endpoint.
     */
    apiKey?: string;
    configuration?: { baseURL?: string; [key: string]: unknown };
  }) => import("@langchain/core/language_models/chat_models").BaseChatModel;
}

/**
 * Construct a `LangChainAgentEvalsScorer` backed by a `RealLangChainJudge`
 * that calls OpenRouter for scoring.
 *
 * Returns `ok(scorer)` when the judge model can be constructed, or
 * `err(CliError)` when the required packages are not available or the env
 * is insufficient for judge model construction.
 *
 * Uses `@langchain/openai`'s `ChatOpenAI` configured for OpenRouter via:
 *   - `apiKey`: the OpenRouter API key from `EvalEnv`
 *     (NOTE: in @langchain/openai v1, `apiKey` is the canonical field name
 *     read by the `BaseChatOpenAI` constructor; the `openAIApiKey` alias
 *     exists only in the TypeScript type — the runtime ignores it, causing
 *     a silent 401. Always use `apiKey`.)
 *   - `configuration.baseURL`: the OpenRouter base URL (typically
 *     `https://openrouter.ai/api/v1`)
 *   - `model`: `JUDGE_MODEL_ID` — a capable model for rubric evaluation
 *   - `temperature`: 0 — deterministic scoring for consistent results
 *
 * Uses ESM dynamic `import()` to load `@langchain/openai` at call time.
 * This is the correct Bun/ESM approach — `require()` is not used.
 *
 * The optional `langchainModuleLoader` parameter lets tests inject a fake
 * module without performing a real dynamic import. Production code always
 * omits this parameter.
 *
 * Failure modes (all returned as typed errors, never thrown):
 *   - `@langchain/openai` is not installed → `EvalValidation` with setup hint
 *   - Any other construction error → `EvalValidation` with description
 *
 * @param evalEnv - The validated eval environment (contains API key + base URL).
 * @param langchainModuleLoader - Optional factory that resolves the
 *   `@langchain/openai` module. Defaults to `import("@langchain/openai")`.
 *   Pass a custom loader in tests to inject a fake module.
 * @returns `Promise<Result<LangChainAgentEvalsScorer, CliError>>`.
 */
export async function buildLangChainScorer(
  evalEnv: { apiKey: string; baseUrl: string },
  langchainModuleLoader?: () => Promise<LangChainOpenAIModule>,
): Promise<Result<LangChainAgentEvalsScorer, CliError>> {
  const loader =
    langchainModuleLoader ??
    (() => import("@langchain/openai") as Promise<LangChainOpenAIModule>);

  return ResultAsync.fromPromise(
    (async () => {
      // ESM dynamic import — the correct Bun-compatible approach.
      // Never use require() in this codebase.
      const { ChatOpenAI } = await loader();

      // IMPORTANT: use `apiKey`, NOT `openAIApiKey`.
      //
      // In @langchain/openai v1, `BaseChatOpenAI` constructor reads only
      // `fields.apiKey` (and `fields.configuration.apiKey`). The
      // `openAIApiKey` TypeScript alias on `OpenAIBaseInput` is NOT read
      // by the runtime constructor — passing it is silently ignored, which
      // causes the client to fall through to OPENAI_API_KEY env var (likely
      // undefined) and receive a 401 "Missing Authentication header" from
      // OpenRouter.
      //
      // Ref: dist/chat_models/base.js constructor line:
      //   this.apiKey = fields?.apiKey ?? configApiKey ?? getEnvironmentVariable("OPENAI_API_KEY")
      const judgeModel = new ChatOpenAI({
        model: JUDGE_MODEL_ID,
        temperature: 0,
        apiKey: evalEnv.apiKey,
        configuration: {
          baseURL: evalEnv.baseUrl,
        },
      });

      const judge = new RealLangChainJudge(judgeModel);
      return new LangChainAgentEvalsScorer(judge);
    })(),
    (cause): CliError => {
      const causeMsg = cause instanceof Error ? cause.message : String(cause);

      // Distinguish between module-not-found and other construction errors
      const isModuleNotFound =
        causeMsg.includes("Cannot find module") ||
        causeMsg.includes("MODULE_NOT_FOUND") ||
        causeMsg.includes("Cannot find package");

      if (isModuleNotFound) {
        return {
          type: "EvalValidation" as const,
          message:
            `The @langchain/openai package is required for LangChain scoring but was not found. ` +
            `Run "bun add @langchain/openai" in the @weaveio/weave-cli package directory and retry. ` +
            `Judge model: ${JUDGE_MODEL_ID}`,
        };
      }

      return {
        type: "EvalValidation" as const,
        message:
          `Failed to construct the LangChain judge model (${JUDGE_MODEL_ID}): ${causeMsg}. ` +
          `Ensure @langchain/openai is installed and OPENROUTER_API_KEY is set correctly.`,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Handle the `weave eval` command.
 */
export async function runEval(
  ctx: EvalContext,
): Promise<Result<number, CliError>> {
  const { terminal, flags } = ctx;

  if (flags.evalSubcommand === undefined) {
    terminal.stderr(EVAL_USAGE);
    return ok(1);
  }

  if (flags.evalSubcommand === "run") {
    return runEvalRun(ctx);
  }

  // Future subcommands would be dispatched here.
  terminal.stderr(
    formatCliError({
      type: "UnknownCommand",
      command: flags.evalSubcommand,
      message: 'Run "weave eval --help" to see available eval subcommands.',
    }),
  );
  return ok(1);
}
