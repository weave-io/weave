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
import { compareRuns, RunBundleReader } from "../evals/compare.js";
import { ComparisonReport } from "../evals/compare-report.js";
import { readEvalEnv } from "../evals/env.js";
import {
  type EvalRunRequest,
  parseEvalRunRequest,
} from "../evals/input-validation.js";
import { JevJudge } from "../evals/jev-judge.js";
import {
  type AgentEvalsScorer,
  LangChainAgentEvalsScorer,
} from "../evals/langchain-agent-evals.js";
import { filterMatrix, loadModelMatrix } from "../evals/model-matrix.js";
import {
  type ModelClient,
  type ModelClientError,
  type ModelRequest,
  type ModelResponse,
  OpenRouterClient,
} from "../evals/openrouter-client.js";
import { EvalRunReport } from "../evals/run-report.js";
import {
  buildEvalRunner,
  EvalOrchestrator,
  type EvalRunSummary,
} from "../evals/runner.js";
import type {
  EvalCase,
  EvalRubric,
  ModelRunOutput,
  NormalizedScoreRecord,
  RunnerError,
  ScoringError,
} from "../evals/types.js";
import {
  EVAL_SHORT_AGENT_FILTERS,
  EVAL_SUITE_IDS,
  EVAL_SUITE_REGISTRY,
} from "../evals/types.js";
import { BunFileSystem, type FileSystem } from "../fs/file-system.js";
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
   * File system `weave eval compare` reads run bundles through. Defaults to
   * the real one; inject a `MemoryFileSystem` in tests.
   */
  fs?: FileSystem;
  /**
   * Positional arguments after the subcommand — for `eval compare`, the
   * baseline and candidate runs, in that order.
   */
  rest?: string[];
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
  "  weave eval run --models dev           Run the cheap development subset of models",
  "  weave eval run --case <id>            Filter to a specific case",
  "  weave eval run --repeat <n>           Run each case n times per model and report pass rates",
  "  weave eval run --track <name>         Run only text-only cases (text) or harness cases (trajectory)",
  "  weave eval run --dry-run              Print what would run without executing",
  "  weave eval run --raw-artifacts        Emit raw artifacts to disk (local-only)",
  "  weave eval compare <baseline> <candidate>",
  "                                        Say per suite and model whether pass rates changed beyond the noise",
  "                                        (each run is a run directory or a run ID under eval-bundles/runs/)",
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
  if (request.modelSet !== undefined) {
    lines.push(`  ${theme.cyan("Model set:")}     ${request.modelSet}`);
  }
  if (request.case !== undefined) {
    lines.push(`  ${theme.cyan("Case filter:")}   ${request.case}`);
  }
  if (request.repeat !== undefined && request.repeat > 1) {
    lines.push(
      `  ${theme.cyan("Repeats:")}       each case ${request.repeat} times per model`,
    );
  }
  if (request.track !== undefined) {
    lines.push(`  ${theme.cyan("Track:")}         ${request.track}`);
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

/**
 * The reporter a live `weave eval run` hands to `buildEvalRunner`: it prints
 * each case's verdict, the dimensions that fell short and where the raw
 * transcript was written, to stdout (Spec 37, 17.2).
 */
export function printRunReport(
  terminal: TerminalIO,
  theme: ThemeColors,
): (summary: EvalRunSummary) => void {
  const report = new EvalRunReport(theme);
  return (summary) => terminal.stdout(report.render(summary));
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
    models: flags.evalModels,
    repeat: flags.evalRepeat,
    track: flags.evalTrack,
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
  // A suite that could not run (e.g. `NoCasesFound` when a filter matched no
  // fixture) exits 1; say which one and why, rather than exiting silently.
  const reportPartialFailure = (failure: RunnerError): void => {
    terminal.stderr(
      formatCliError({ type: "EvalValidation", message: failure.message }),
    );
  };
  const runnerResult = request.dryRun
    ? buildDryRunRunner(reportPartialFailure, ctx.env)
    : await buildLiveRunner(
        reportPartialFailure,
        printRunReport(terminal, theme),
        ctx.env,
      );
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
  reportPartialFailure: (failure: RunnerError) => void,
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

  return ok(buildEvalRunner(orchestrator, reportPartialFailure));
}

/**
 * The eval judge: TypeSafe Jev (Spec 37, task 16.4), accepted by the judge
 * acceptance check (`docs/artifacts/judge-bakeoff-2026-09-23.md`). Jev can
 * never be one of the evaluated models, so it never grades itself.
 *
 * `JUDGE_MODEL_ID` is the model; `JUDGE_MODEL_VERSION` the dated version
 * every judge call names and every answer must come from. Both are recorded
 * in each run's bundle, and `weave eval compare` refuses runs whose judges
 * differ, so changing either starts a new baseline. See "The judge" in
 * `docs/agent-evals.md` before changing them.
 *
 * `scripts/evals/verify-agent-eval-run.ts` reads `JUDGE_MODEL_ID` from this
 * file's source as a string literal; keep it one.
 */
const JUDGE_MODEL_ID = "typesafe/jev-1.13";
const JUDGE_MODEL_VERSION = "typesafe/jev-1.13-20260917";

/**
 * Build the live production runner from real external dependencies.
 *
 * Constructs an `EvalOrchestrator` with:
 *   - `OpenRouterClient` for model inference
 *   - `LangChainAgentEvalsScorer(JevJudge)` for scoring via OpenRouter
 *   - The real `env` map for API key and token reads
 *
 * The scorer's judge is `JevJudge`, which calls OpenRouter's decisions
 * endpoint with the same API key. If the environment is invalid, this
 * function returns `err(CliError)` — it never silently falls back to a stub
 * scorer.
 *
 * The API key is validated eagerly here before constructing any clients.
 * Validation errors surface as typed `CliError` values, not thrown exceptions.
 *
 * @param reportPartialFailure - Writes one partial failure to stderr.
 * @param reportRun - Prints the run report after the run.
 * @param env - Environment variable map. Defaults to `Bun.env`.
 * @returns A `Promise<Result<runner, CliError>>` — err when the environment
 *          is invalid.
 */
async function buildLiveRunner(
  reportPartialFailure: (failure: RunnerError) => void,
  reportRun: (summary: EvalRunSummary) => void,
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

  // The judge: TypeSafe Jev on OpenRouter's decisions endpoint, pinned to
  // one dated version. It sees each judged case's rubric, reference and the
  // agent's actual response (`judge-questions.ts`).
  const judge = new JevJudge({
    apiKey: evalEnv.apiKey,
    judge: { id: JUDGE_MODEL_ID, version: JUDGE_MODEL_VERSION },
  });
  const scorer = new LangChainAgentEvalsScorer(judge);

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
    judge: judge.identity(),
    env: effectiveEnv,
    publishMode,
  });

  return ok(buildEvalRunner(orchestrator, reportPartialFailure, reportRun));
}

// ---------------------------------------------------------------------------
// Subcommand: eval compare
// ---------------------------------------------------------------------------

/**
 * `weave eval compare <baseline> <candidate>` (Spec 37, task 18.2).
 *
 * Reads two local run bundles and prints, per suite × model, whether the
 * pass rate changed beyond the noise. Exits 0 when the comparison was made
 * (whatever it found) and 1 when it was refused — runs with different case
 * sets, models, repeat counts or judges, a dry run, or a missing bundle.
 */
async function runEvalCompare(
  ctx: EvalContext,
): Promise<Result<number, CliError>> {
  const { terminal, theme } = ctx;
  const refs = ctx.rest ?? [];
  const [baselineRef, candidateRef] = refs;
  if (
    refs.length !== 2 ||
    baselineRef === undefined ||
    candidateRef === undefined
  ) {
    terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message:
          "weave eval compare needs exactly two runs: weave eval compare <baseline> <candidate>. " +
          "Each is a run directory (eval-bundles/runs/<runId>) or a run ID.",
      }),
    );
    return ok(1);
  }

  const reader = new RunBundleReader(ctx.fs ?? new BunFileSystem());
  const baseline = await reader.read(baselineRef);
  if (baseline.isErr()) {
    return refuse(terminal, baseline.error.message);
  }
  const candidate = await reader.read(candidateRef);
  if (candidate.isErr()) {
    return refuse(terminal, candidate.error.message);
  }

  const comparison = compareRuns(baseline.value, candidate.value);
  if (comparison.isErr()) {
    return refuse(
      terminal,
      `Cannot compare these runs: ${comparison.error.message}`,
    );
  }

  terminal.stdout(new ComparisonReport(theme).render(comparison.value));
  return ok(0);
}

function refuse(
  terminal: TerminalIO,
  message: string,
): Result<number, CliError> {
  terminal.stderr(formatCliError({ type: "EvalValidation", message }));
  return ok(1);
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

  if (flags.evalSubcommand === "compare") {
    return runEvalCompare(ctx);
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
