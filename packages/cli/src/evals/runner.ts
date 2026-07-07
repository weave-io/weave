/**
 * Top-level eval orchestrator for `weave eval run`.
 *
 * Connects all evaluation pipeline components into a single, policy-aware
 * orchestration flow:
 *
 *   1. Validates the environment (API key check via `readEvalEnv`) for live runs.
 *   2. Loads and validates the model matrix; resolves the effective model set.
 *   3. Composes prompt snapshots and derives the provenance manifest.
 *   4. Fans out across all suites in the shared eval registry with the
 *      effective model/case/agent filters.
 *   5. Aggregates per-runner results into a run-level summary with
 *      per-agent and per-model rollups.
 *   6. Writes the publishable bundle via `ArtifactBundleWriter`.
 *   7. Optionally writes local-only raw artifacts via `RawArtifactsWriter`.
 *   8. Records and surfaces run metadata (repo SHA, Bun version, workflow run
 *      ID, selected filters, raw-artifact mode, publish policy) without
 *      exposing secrets or raw config values.
 *
 * # Policy contracts
 *
 *   - Dry-runs skip environment validation, model calls, prompt snapshot
 *     provenance, bundle writes, raw-artifact writes, and external
 *     publication. They still load the real suite fixtures/rubrics through the
 *     shared runner path so fixture-contract drift fails closed.
 *   - Partial failures (per-case errors) surface as typed `CliError` values
 *     in the returned summary — they never cause the orchestrator to throw.
 *   - The orchestrator never publishes unsanitized or raw-default intermediate
 *     data. All publishable artifacts pass through `ArtifactBundleWriter`
 *     which runs through the central allowlist sanitizer.
 *   - Raw artifacts are ONLY written when `EvalRunRequest.rawArtifacts === true`
 *     and are written to a separate `raw/` subdirectory, never to the
 *     publishable bundle path.
 *   - Run metadata fields (Bun version, git SHA, workflow run ID) are
 *     sanitized: they never contain API keys, tokens, or env values.
 *   - Publish mode is token-gated: `ArtifactBundleWriter` enforces
 *     `EVAL_RESULTS_REPO_TOKEN` presence before any external push.
 *
 * # Dependency injection
 *
 * All external dependencies (model client, scorer, prompt provider, git SHA
 * provider, bundle writer) are injected via `EvalOrchestratorOptions` so
 * tests can substitute stubs without triggering real network, git, or
 * file-system calls.
 *
 * The `EvalOrchestrator` class is the single seam between the CLI command
 * handler (`commands/eval.ts`) and the eval pipeline. `commands/eval.ts`
 * constructs an `EvalOrchestrator` with real dependencies when no injected
 * runner is provided, then passes `orchestrator.run` as the injected runner.
 */

import { join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { CliError } from "../errors.js";
import {
  ArtifactBundleWriter,
  type BundleWriteMode,
  type RemoteSequenceReader,
} from "./artifact-bundle.js";
import {
  type EvalEnvError,
  OPENROUTER_API_KEY_ENV_VAR,
  readEvalEnv,
} from "./env.js";
import type { EvalRunRequest } from "./input-validation.js";
import type { AgentEvalsScorer } from "./langchain-agent-evals.js";
import {
  LOOM_ROUTING_SUITE,
  LoomRoutingRunner,
} from "./loom-routing-runner.js";
import {
  filterMatrix,
  loadModelMatrix,
  resolveDefaultModels,
} from "./model-matrix.js";
import type { ModelClient } from "./openrouter-client.js";
import {
  PATTERN_PLANNING_SUITE,
  PatternPlanningRunner,
} from "./pattern-planning-runner.js";
import {
  bunGitShaProvider,
  deriveProvenanceManifest,
  type GitShaProvider,
} from "./provenance.js";
import { RawArtifactsWriter } from "./raw-artifacts.js";
import type { ResultsRepoPublisher } from "./results-repo.js";
import {
  SHUTTLE_EXECUTION_SUITE,
  ShuttleExecutionRunner,
} from "./shuttle-execution-runner.js";
import {
  SPINDLE_TOOLS_SUITE,
  SpindleToolsRunner,
} from "./spindle-tools-runner.js";
import {
  TAPESTRY_EXECUTION_SUITE,
  TapestryExecutionRunner,
} from "./tapestry-execution-runner.js";
import type {
  ModelMatrixEntry,
  PromptProvenanceManifest,
  PromptProvider,
  PromptSnapshot,
  RunnerError,
  RunnerResult,
} from "./types.js";
import { EVAL_SHORT_AGENT_FILTERS, EVAL_SUITE_REGISTRY } from "./types.js";
import {
  WARP_SECURITY_SUITE,
  WarpSecurityRunner,
} from "./warp-security-runner.js";
import { WEFT_REVIEW_SUITE, WeftReviewRunner } from "./weft-review-runner.js";

// ---------------------------------------------------------------------------
// Run metadata — sanitized record embedded in the run summary
// ---------------------------------------------------------------------------

/**
 * Sanitized run metadata recorded for every orchestrator execution.
 *
 * Contains only safe scalar values — no API keys, tokens, env var values,
 * raw error strings, or arbitrary provider responses. All fields are either
 * well-known version strings, git SHAs, structured identifiers, or booleans.
 */
export interface EvalRunMetadata {
  /**
   * The Bun runtime version string (e.g. `"1.2.3"`).
   * Read from `Bun.version` — always a semver string, no secrets.
   */
  bunVersion: string;
  /**
   * Git commit SHA of the repository at run time.
   * `"unknown"` when not inside a git repo or git is unavailable.
   */
  repoSha: string;
  /**
   * CI/CD workflow run identifier, if available.
   *
   * Populated from `GITHUB_RUN_ID` (GitHub Actions) or similar CI variables.
   * `null` when not running in a recognised CI environment.
   * Never contains API keys or secrets — only the numeric workflow run ID.
   * Values containing non-digit characters are rejected to prevent env leakage.
   */
  workflowRunId: string | null;
  /**
   * Effective agent filter applied to this run.
   * `null` when no agent filter was set.
   */
  agentFilter: string | null;
  /**
   * Effective model filter applied to this run.
   * `null` when no model filter was set (default matrix used).
   */
  modelFilter: string | null;
  /**
   * Effective case filter applied to this run.
   * `null` when no case filter was set.
   */
  caseFilter: string | null;
  /**
   * Whether raw artifacts were written for this run.
   * Always `false` unless `EvalRunRequest.rawArtifacts === true`.
   */
  rawArtifactsEnabled: boolean;
  /**
   * The bundle write mode: `"local"` or `"publish"`.
   * Controls whether `ArtifactBundleWriter` attempts an external push.
   */
  publishMode: BundleWriteMode;
  /**
   * ISO 8601 timestamp when the orchestrator run started.
   */
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Per-model rollup
// ---------------------------------------------------------------------------

/**
 * Aggregate pass/fail rollup for a single model across all suites.
 */
export interface ModelRollup {
  /** The model identifier. */
  modelId: string;
  /** Total cases run for this model. */
  totalCases: number;
  /** Passing cases for this model. */
  passedCases: number;
  /** Failing cases for this model. */
  failedCases: number;
  /**
   * Pass rate in [0, 1].
   * `1.0` when all cases passed; `0.0` when all failed.
   * `null` when no cases were run (totalCases === 0).
   */
  passRate: number | null;
}

// ---------------------------------------------------------------------------
// Repeatability diagnostics
// ---------------------------------------------------------------------------

/**
 * Exact filter tuple used to decide whether two runs are comparable for local
 * repeatability diagnostics.
 */
export interface RepeatabilityComparisonKey {
  agentFilter: string | null;
  modelFilter: string | null;
  caseFilter: string | null;
  suites: string[];
}

/**
 * One case result snapshot stored in the local repeatability artifact.
 */
export interface RepeatabilityCaseSnapshot {
  caseId: string;
  passed: boolean;
  required: boolean;
  weightedTotal: number;
  dryRun: boolean;
}

/**
 * One model slice within a suite snapshot stored in the local repeatability
 * artifact.
 */
export interface RepeatabilityModelSnapshot {
  modelId: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number | null;
  cases: RepeatabilityCaseSnapshot[];
}

/**
 * One suite snapshot stored in the local repeatability artifact.
 */
export interface RepeatabilitySuiteSnapshot {
  suite: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  suiteGreen: boolean;
  models: RepeatabilityModelSnapshot[];
}

/**
 * The current run's normalized snapshot used for local rerun comparison.
 */
export interface RepeatabilityRunSnapshot {
  runId: string;
  repoSha: string;
  startedAt: string;
  bundleDir: string;
  suites: RepeatabilitySuiteSnapshot[];
}

/**
 * Per-model comparison summary across comparable reruns.
 */
export interface RepeatabilityModelDriftSummary {
  suite: string;
  modelId: string;
  comparableRunCount: number;
  classification: "single-run" | "consistent" | "drifted";
  passRateRange: {
    min: number | null;
    max: number | null;
  };
  runs: Array<{
    runId: string;
    passedCases: number;
    totalCases: number;
    failedCases: number;
    passRate: number | null;
  }>;
}

/**
 * Per-case, per-model comparison summary across comparable reruns.
 */
export interface RepeatabilityCaseModelDriftSummary {
  suite: string;
  caseId: string;
  modelId: string;
  comparableRunCount: number;
  classification:
    | "single-run"
    | "consistent-pass"
    | "consistent-fail"
    | "mixed";
  weightedTotalRange: {
    min: number;
    max: number;
  };
  runs: Array<{
    runId: string;
    passed: boolean;
    required: boolean;
    weightedTotal: number;
  }>;
}

/**
 * Serialized local-only repeatability artifact written next to a run bundle.
 */
export interface RepeatabilityDiagnosticsArtifact {
  schemaVersion: 1;
  generatedAt: string;
  comparisonKey: RepeatabilityComparisonKey;
  currentRun: RepeatabilityRunSnapshot;
  comparableRunIds: string[];
  comparableRunCount: number;
  driftSummary: {
    models: RepeatabilityModelDriftSummary[];
    caseModels: RepeatabilityCaseModelDriftSummary[];
  };
}

const REPEATABILITY_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;

/**
 * Compact summary reference returned to callers after writing the local
 * repeatability artifact.
 */
export interface RepeatabilityDiagnosticsSummary {
  status: "written";
  filePath: string;
  comparisonKey: RepeatabilityComparisonKey;
  comparableRunIds: string[];
  comparableRunCount: number;
  errors: RepeatabilityDiagnosticsError[];
}

export type RepeatabilityDiagnosticsError =
  | {
      type: "RepeatabilityDiagnosticsScanError";
      bundleRoot: string;
      message: string;
    }
  | {
      type: "RepeatabilityDiagnosticsReadError";
      filePath: string;
      message: string;
    }
  | {
      type: "RepeatabilityDiagnosticsWriteError";
      filePath: string;
      message: string;
    };

export interface RepeatabilityDiagnosticsFailure {
  status: "failed";
  comparisonKey: RepeatabilityComparisonKey;
  errors: RepeatabilityDiagnosticsError[];
}

export type RepeatabilityDiagnosticsResult =
  | RepeatabilityDiagnosticsSummary
  | RepeatabilityDiagnosticsFailure;

// ---------------------------------------------------------------------------
// Per-agent (suite) rollup
// ---------------------------------------------------------------------------

/**
 * Aggregate pass/fail rollup for a single eval suite (agent).
 */
export interface AgentRollup {
  /** The eval suite name (e.g. `"loom-routing"`, `"tapestry-execution"`, `"shuttle-execution"`, `"spindle-tools"`, `"pattern-planning"`, `"weft-review"`, `"warp-security"`). */
  suite: string;
  /** Total cases run in this suite. */
  totalCases: number;
  /** Passing cases in this suite. */
  passedCases: number;
  /** Failing cases in this suite. */
  failedCases: number;
  /** Whether all required cases in this suite passed. */
  suiteGreen: boolean;
}

// ---------------------------------------------------------------------------
// Run-level summary
// ---------------------------------------------------------------------------

/**
 * The complete run-level summary produced by one orchestrator execution.
 *
 * Aggregates results across all suites and models. Contains:
 *   - `metadata`: sanitized run context (SHA, Bun version, filters, policy)
 *   - `agentRollups`: per-suite pass/fail totals
 *   - `modelRollups`: per-model pass/fail totals across all suites
 *   - `totalCases`, `passedCases`, `failedCases`: aggregate counts
 *   - `allSuitesGreen`: overall green/red status
 *   - `bundleDir`: path of the written bundle directory
 *   - `partialFailures`: typed `RunnerError` values for suites that returned
 *     hard errors (e.g. fixture load failure), accumulated and surfaced here
 *
 * No raw prompt text, transcript content, API keys, or tokens appear
 * in this record.
 */
export interface EvalRunSummary {
  /** Sanitized run metadata (Bun version, SHA, filters, policy). */
  metadata: EvalRunMetadata;
  /** Per-suite (agent) rollups. */
  agentRollups: AgentRollup[];
  /** Per-model rollups across all suites. */
  modelRollups: ModelRollup[];
  /** Total cases run across all suites. */
  totalCases: number;
  /** Total passing cases across all suites. */
  passedCases: number;
  /** Total failing cases across all suites. */
  failedCases: number;
  /** `true` when every required case in every suite passed. */
  allSuitesGreen: boolean;
  /** Absolute path of the bundle directory written by the orchestrator. */
  bundleDir: string;
  /**
   * The immutable run ID for this run (e.g. `abc123d-2026-01-15-001`).
   *
   * `null` when no runner results were produced (empty fixture sets) and the
   * bundle write was short-circuited.
   */
  runId: string | null;
  /** Paths of all publishable/internal bundle files written by the bundle writer. */
  filesWritten: string[];
  /** Paths of any local-only raw artifact files written for this run. */
  rawArtifactsWritten: string[];
  /** Summary or failure record for local repeatability diagnostics, when attempted. */
  repeatabilityDiagnostics: RepeatabilityDiagnosticsResult | null;
  /**
   * Typed `RunnerError` values for suites that encountered hard failures
   * (e.g. fixture load errors, prompt provider failures).
   *
   * Per-case execution errors are NOT surfaced here — they are accumulated
   * as zero-score `CaseResult` entries in the runner results. Hard failures
   * that prevent a suite from running at all are surfaced here.
   *
   * These are informational: the orchestrator continues executing remaining
   * suites after recording a partial failure.
   */
  partialFailures: RunnerError[];
}

// ---------------------------------------------------------------------------
// Orchestrator errors
// ---------------------------------------------------------------------------

/**
 * Typed errors that can prevent the orchestrator from running at all.
 *
 * These are distinct from per-case `RunnerError` values — they prevent
 * the orchestrator from starting execution. Callers must surface them and
 * abort before any model calls are made.
 */
export type OrchestratorError =
  | {
      /**
       * The eval environment is not correctly configured.
       *
       * Most commonly `MissingApiKey` — `OPENROUTER_API_KEY` was not set.
       * No model calls were made; the key was not logged or serialized.
       */
      type: "EnvironmentError";
      /** The underlying `EvalEnvError` type (discriminant only). */
      envErrorType: EvalEnvError["type"];
      /** Human-readable description. Does NOT include the key value. */
      message: string;
    }
  | {
      /**
       * The model matrix could not be loaded or failed its constraints.
       *
       * Returned when `loadModelMatrix()` fails. No model calls were made.
       */
      type: "ModelMatrixError";
      /** Human-readable description (no raw file content). */
      message: string;
    }
  | {
      /**
       * The effective model set is empty after applying the `--model` filter.
       *
       * Returned when the supplied model filter does not match any entry in
       * the model matrix. No model calls were made.
       */
      type: "EmptyModelSet";
      /** The filter value that produced an empty set. */
      modelFilter: string;
      /** Human-readable description. */
      message: string;
    }
  | {
      /**
       * The bundle write step failed for all results.
       *
       * Returned when `ArtifactBundleWriter.writeBundle()` returns an error.
       * Runner results were produced but could not be persisted.
       */
      type: "BundleWriteError";
      /** Human-readable description (no raw bundle content). */
      message: string;
    };

// ---------------------------------------------------------------------------
// Snapshot provider — prompt-hash-only snapshot collection for provenance
// ---------------------------------------------------------------------------

/**
 * Abstracts prompt snapshot collection for provenance manifest derivation.
 *
 * The default production implementation calls `composeAgentSnapshots` from
 * `prompt-snapshots.ts`. Tests inject a stub that returns controlled
 * `PromptSnapshot` records without any git, file-system, or engine calls.
 *
 * Returning an empty array is valid (manifests with no records are still
 * produced). Provenance derivation never fails because of a missing snapshot
 * provider — it falls back to an empty manifest when the provider returns an
 * error.
 */
export interface SnapshotProvider {
  /**
   * Retrieve `PromptSnapshot` records for the named agents.
   *
   * @param agentNames - The agent names to snapshot (e.g. `["loom", "tapestry", "shuttle"]`).
   * @returns A promise resolving to the collected snapshots (may be partial
   *          when individual agents fail to compose — errors are not surfaced
   *          here, snapshots for successfully composed agents are returned).
   */
  getSnapshots(agentNames: readonly string[]): Promise<PromptSnapshot[]>;
}

// ---------------------------------------------------------------------------
// Orchestrator options
// ---------------------------------------------------------------------------

/**
 * Options for `EvalOrchestrator`.
 *
 * All external dependencies are injected here so tests can substitute
 * stubs without triggering real network, git, or file-system operations.
 */
export interface EvalOrchestratorOptions {
  /**
   * The model client for inference calls.
   * Inject `StubModelClient` in tests.
   */
  modelClient: ModelClient;
  /**
   * The scorer for evaluating model run outputs.
   * Inject `StubAgentEvalsScorer` in tests.
   */
  scorer: AgentEvalsScorer;
  /**
   * Prompt provider for all eval-covered agents.
   *
   * When set, the provider is passed to all suite runners. When omitted, each runner constructs its
   * own default provider via `composeAgentSnapshots`.
   *
   * Tests always inject a `MockPromptProvider` to avoid git/network/fs calls.
   */
  promptProvider?: PromptProvider;
  /**
   * Prompt snapshot provider for provenance manifest derivation.
   *
   * Called once before suites run to collect `PromptSnapshot` records for
   * all eval-covered agents. These snapshots feed into the provenance
   * manifest so the published bundle contains real prompt hashes — not an
   * empty manifest derived from `[]`.
   *
   * When omitted, the orchestrator calls `composeAgentSnapshots` from
   * `prompt-snapshots.ts` (production path). Tests inject a stub that returns
   * controlled snapshots without any git, file-system, or engine calls.
   *
   * The snapshot provider is separate from `promptProvider` so that:
   *   - The runners can obtain raw prompt text (via `promptProvider`) for
   *     injection into model calls.
   *   - The orchestrator can obtain publishable hash-only snapshots (via this
   *     provider) for provenance without storing raw content.
   */
  snapshotProvider?: SnapshotProvider;
  /**
   * Git SHA provider for run metadata and provenance records.
   * Defaults to `bunGitShaProvider` (shells out to `git rev-parse HEAD`).
   * Inject a stub in tests.
   */
  gitShaProvider?: GitShaProvider;
  /**
   * Root directory under which bundle subdirectories are written.
   * Defaults to `process.cwd()/eval-bundles`.
   * Override in tests to write to a temp directory.
   */
  bundleRoot?: string;
  /**
   * Bundle write mode. Defaults to `"local"`.
   * Set to `"publish"` to enable external repo publication.
   */
  publishMode?: BundleWriteMode;
  /**
   * Optional publisher to call after local bundle write in `"publish"` mode.
   *
   * When `publishMode === "publish"` and this is provided, the publisher is
   * called with the written bundle after all local files are written. The
   * default production publisher is `GitHubContentsPublisher` which writes to
   * `weave-io/weave-agent-evals` via the GitHub REST Contents API.
   *
   * When omitted with `publishMode === "local"` (the default), no external
   * publication occurs.
   *
   * When omitted with `publishMode === "publish"`, the orchestrator lazily
   * imports and instantiates `GitHubContentsPublisher` at run time.
   *
   * Inject `StubResultsRepoPublisher` in tests to avoid real network calls.
   */
  publisher?: ResultsRepoPublisher;
  /**
   * Environment variable map for env reads and token lookup.
   * Defaults to `Bun.env`. Inject in tests.
   */
  env?: Record<string, string | undefined>;
  /**
   * Eval fixture root directory for case and rubric loading.
   * When omitted, the default `EVALS_ROOT` from `case-loader.ts` is used.
   * Override in tests to load fixture stubs.
   */
  evalsRoot?: string;
  /**
   * Optional override for `assembledAt` timestamp in the bundle.
   * When omitted, defaults to `new Date().toISOString()` at write time.
   * Inject in tests for deterministic output.
   */
  assembledAt?: string;
}

// ---------------------------------------------------------------------------
// EvalOrchestrator
// ---------------------------------------------------------------------------

/**
 * Top-level eval orchestration class.
 *
 * Connects all evaluation pipeline components (env validation, model matrix,
 * prompt provenance, suite runners, bundle writer, raw artifact writer) into
 * a single `run()` method that accepts an `EvalRunRequest` and returns a
 * typed `Result<EvalRunSummary, CliError>`.
 *
 * ## Design
 *
 *   - Hard pre-flight failures (missing API key, bad model matrix) are
 *     returned as typed `OrchestratorError` values mapped to `CliError`
 *     before any model calls are made.
 *   - Per-suite hard failures (fixture load errors, prompt provider failures)
 *     are accumulated as `partialFailures` in the summary — the orchestrator
 *     continues with remaining suites.
 *   - Per-case execution errors are embedded in zero-score `CaseResult`
 *     entries by the suite runners. The orchestrator sees only `RunnerResult`.
 *   - No raw prompt text, transcript content, API keys, or env variable values
 *     appear in the returned `EvalRunSummary`. All publishable artifacts
 *     pass through the central allowlist sanitizer in `ArtifactBundleWriter`.
 *
 * ## Usage
 *
 * ```ts
 * // Production: real dependencies
 * const orchestrator = new EvalOrchestrator({
 *   modelClient: new OpenRouterClient(env),
 *   scorer: new LangChainAgentEvalsScorer(judge),
 * });
 *
 * // Tests: inject stubs for isolation
 * const orchestrator = new EvalOrchestrator({
 *   modelClient: new StubModelClient(),
 *   scorer: new StubAgentEvalsScorer(),
 *   promptProvider: new MockPromptProvider("You are Loom..."),
 *   gitShaProvider: { resolveGitSha: () => ok("abc1234") },
 *   bundleRoot: "/tmp/test-bundles",
 *   env: { OPENROUTER_API_KEY: "test-key" },
 *   evalsRoot: "/tmp/test-fixtures",
 * });
 *
 * const result = await orchestrator.run(request);
 * ```
 */
export class EvalOrchestrator {
  private readonly modelClient: ModelClient;
  private readonly scorer: AgentEvalsScorer;
  private readonly promptProvider: PromptProvider | undefined;
  private readonly snapshotProvider: SnapshotProvider;
  private readonly gitShaProvider: GitShaProvider;
  private readonly bundleRoot: string;
  private readonly publishMode: BundleWriteMode;
  private readonly publisher: ResultsRepoPublisher | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly evalsRoot: string | undefined;
  private readonly assembledAt: string | undefined;

  constructor(options: EvalOrchestratorOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.promptProvider = options.promptProvider;
    this.snapshotProvider =
      options.snapshotProvider ?? makeDefaultSnapshotProvider();
    this.gitShaProvider = options.gitShaProvider ?? bunGitShaProvider;
    this.bundleRoot = options.bundleRoot ?? join(process.cwd(), "eval-bundles");
    this.publishMode = options.publishMode ?? "local";
    this.publisher = options.publisher;
    this.env = options.env ?? Bun.env;
    this.evalsRoot = options.evalsRoot;
    this.assembledAt = options.assembledAt;
  }

  /**
   * Execute the full eval orchestration flow for the given request.
   *
   * Returns `ok(EvalRunSummary)` when the orchestration completes — even when
   * individual suites or cases failed. Partial failures are recorded in
   * `EvalRunSummary.partialFailures`.
   *
   * Returns `err(CliError)` only when a hard pre-flight check fails:
   *   - Missing or invalid API key (`EnvironmentError`)
   *   - Model matrix load failure (`ModelMatrixError`)
   *   - Empty model set after filter (`EmptyModelSet`)
   *   - Bundle write failure for all results (`BundleWriteError`)
   *
   * @param request - The validated eval run request from the CLI handler.
   * @returns `ResultAsync<EvalRunSummary, CliError>`.
   */
  run(request: EvalRunRequest): ResultAsync<EvalRunSummary, CliError> {
    const startedAt = new Date().toISOString();

    // Step 1: Validate environment for live runs only.
    //
    // Dry-runs intentionally skip API-key validation because they do not make
    // model calls. They still execute the real suite fixture/rubric loading
    // path via `executeSuites()`.
    if (!request.dryRun) {
      const envResult = readEvalEnv(this.env);
      if (envResult.isErr()) {
        const envErr = envResult.error;
        return new ResultAsync(
          Promise.resolve(
            err<EvalRunSummary, CliError>({
              type: "EvalValidation",
              message: this.sanitizeEnvErrorMessage(envErr),
            }),
          ),
        );
      }
    }

    // Step 2: Load the model matrix and resolve effective model set
    return this.resolveModelSet(request).andThen((modelEntries) => {
      // Step 3: Resolve git SHA for metadata and provenance
      const gitShaResult = this.gitShaProvider.resolveGitSha();
      const repoSha = gitShaResult.isOk() ? gitShaResult.value : "unknown";

      // Step 4: Build run metadata (sanitized — no secrets)
      const metadata = this.buildRunMetadata(request, repoSha, startedAt);

      // Step 5: Execute suites and collect results
      return this.executeSuites(request, modelEntries, repoSha).andThen(
        ({ runnerResults, partialFailures, provenanceManifest }) => {
          if (request.dryRun) {
            return ResultAsync.fromSafePromise(
              Promise.resolve(
                this.assembleRunSummary(
                  metadata,
                  runnerResults,
                  partialFailures,
                  this.bundleRoot,
                  null,
                  [],
                  [],
                  null,
                ),
              ),
            );
          }

          // Step 6: Write the bundle
          return this.writeBundle(
            runnerResults,
            provenanceManifest,
            repoSha,
            request,
          ).andThen((writeResult) => {
            // Step 7: Optionally write raw artifacts
            const rawArtifactResults = request.rawArtifacts
              ? this.writeRawArtifacts(runnerResults, writeResult.bundleDir)
              : Promise.resolve({
                  written: [] as string[],
                  errors: [] as string[],
                });

            return ResultAsync.fromSafePromise(rawArtifactResults).andThen(
              (rawResult) =>
                this.writeRepeatabilityDiagnostics(
                  metadata,
                  runnerResults,
                  writeResult.bundleDir,
                  writeResult.runId,
                )
                  .orElse((failure) =>
                    ResultAsync.fromSafePromise(
                      Promise.resolve<RepeatabilityDiagnosticsResult | null>(
                        failure,
                      ),
                    ),
                  )
                  .map((repeatabilityDiagnostics) => {
                    // Step 8: Assemble run-level summary
                    const summary = this.assembleRunSummary(
                      metadata,
                      runnerResults,
                      partialFailures,
                      writeResult.bundleDir,
                      writeResult.runId,
                      writeResult.filesWritten,
                      rawResult.written,
                      repeatabilityDiagnostics,
                    );
                    return summary;
                  }),
            );
          });
        },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Private: model set resolution
  // ---------------------------------------------------------------------------

  private resolveModelSet(
    request: EvalRunRequest,
  ): ResultAsync<ModelMatrixEntry[], CliError> {
    return loadModelMatrix()
      .mapErr(
        (fixtureErr): CliError => ({
          type: "EvalValidation",
          message: `Model matrix load failed: ${fixtureErr.message}`,
        }),
      )
      .andThen((matrix) => {
        if (request.model !== undefined) {
          const filtered = filterMatrix(matrix, request.model);
          if (filtered.length === 0) {
            const allowlist = matrix.models.map((m) => m.id).join(", ");
            return new ResultAsync(
              Promise.resolve(
                err<ModelMatrixEntry[], CliError>({
                  type: "EvalValidation",
                  message:
                    `Model filter "${request.model}" did not match any model in the matrix. ` +
                    `Allowed model IDs: ${allowlist}`,
                }),
              ),
            );
          }
          return ResultAsync.fromSafePromise(Promise.resolve(filtered));
        }
        const defaultModels = resolveDefaultModels(matrix);
        return ResultAsync.fromSafePromise(Promise.resolve(defaultModels));
      });
  }

  // ---------------------------------------------------------------------------
  // Private: suite fan-out
  // ---------------------------------------------------------------------------

  /**
   * Execute all applicable suites for the request, fanning out across all
   * models in the resolved model set.
   *
   * When an `--agent` filter is set, only the suite for that agent is run.
   * When no agent filter is set, all registered suites run for every model.
   *
   * When a `--model` filter is set, only the matching model runs (the
   * `modelEntries` array has already been filtered to one entry by
   * `resolveModelSet()`). When no `--model` filter is set, every model in
   * the resolved default model matrix is executed — one suite run per model,
   * producing per-agent and per-model rollups across the full matrix.
   *
   * Per-suite hard failures (fixture load, prompt provider) are accumulated
   * as `partialFailures` — the orchestrator continues with remaining suites
   * and remaining models.
   *
   * ## Fan-out strategy
   *
   * For each model in `modelEntries`:
   *   - Run the Loom suite (if not filtered out by agent filter)
   *   - Run the Tapestry suite (if not filtered out by agent filter)
   *   - Run the Shuttle suite (if not filtered out by agent filter)
   *   - Run the Spindle suite (if not filtered out by agent filter)
   *   - Run the Pattern suite (if not filtered out by agent filter)
   *   - Run the Weft suite (if not filtered out by agent filter)
   *   - Run the Warp suite (if not filtered out by agent filter)
   *
   * Results are accumulated sequentially to avoid race conditions on the
   * shared `runnerResults` and `partialFailures` arrays.
   *
   * The final `EvalRunSummary` will contain one runner rollup per executed
   * suite/model combination, and one `ModelRollup` per model across all suites.
   */
  private executeSuites(
    request: EvalRunRequest,
    modelEntries: ModelMatrixEntry[],
    repoSha: string,
  ): ResultAsync<
    {
      runnerResults: RunnerResult[];
      partialFailures: RunnerError[];
      provenanceManifest: PromptProvenanceManifest | null;
    },
    CliError
  > {
    const selectedSuites = EVAL_SUITE_REGISTRY.filter((suite) =>
      this.shouldRunSuite(request.agent, suite.suiteId, suite.shortAgentFilter),
    );

    const runnerResults: RunnerResult[] = [];
    const partialFailures: RunnerError[] = [];

    // Fan out across all selected models.
    //
    // Each model is run through all applicable suites. Results are
    // accumulated sequentially to avoid race conditions.
    //
    // When `request.model` is set, `modelEntries` contains exactly one entry
    // (already filtered by `resolveModelSet()`). When no model filter is set,
    // `modelEntries` contains the full default matrix (≥ 3 models per the
    // model matrix constraint).
    const executeSuites = async (): Promise<void> => {
      for (const modelEntry of modelEntries) {
        const modelFilter = modelEntry.id;

        for (const suite of selectedSuites) {
          const result = await this.runSuiteById(
            suite.suiteId,
            request,
            modelFilter,
          );
          if (result.isOk()) {
            runnerResults.push(result.value);
          } else {
            partialFailures.push(result.error);
          }
        }
      }
    };

    return ResultAsync.fromSafePromise(
      executeSuites().then(async () => {
        if (request.dryRun) {
          return {
            runnerResults,
            partialFailures,
            provenanceManifest: null,
          };
        }

        // Collect prompt snapshots for the shared eval-covered agent surface
        // before deriving provenance.
        // The snapshot provider returns publishable hash-only records — no raw text.
        const snapshots = await this.snapshotProvider.getSnapshots(
          getEvalCoveredPromptAgents(),
        );
        // Derive provenance manifest from the collected snapshots
        const provenanceManifest = this.deriveProvenance(snapshots, repoSha);
        return { runnerResults, partialFailures, provenanceManifest };
      }),
    );
  }

  /**
   * Determine whether a suite should be included in this run.
   *
   * When `agentFilter` is undefined, all suites run.
   * When set, only suites whose `suiteName` or `agentName` match are included.
   */
  private shouldRunSuite(
    agentFilter: string | undefined,
    suiteName: string,
    agentName: string,
  ): boolean {
    if (agentFilter === undefined) return true;
    return agentFilter === agentName || agentFilter === suiteName;
  }

  private runSuiteById(
    suiteId: string,
    request: EvalRunRequest,
    modelFilter: string | undefined,
  ): ResultAsync<RunnerResult, RunnerError> {
    if (suiteId === LOOM_ROUTING_SUITE) {
      return this.runLoomSuite(request, modelFilter);
    }

    if (suiteId === TAPESTRY_EXECUTION_SUITE) {
      return this.runTapestrySuite(request, modelFilter);
    }

    if (suiteId === SHUTTLE_EXECUTION_SUITE) {
      return this.runShuttleSuite(request, modelFilter);
    }

    if (suiteId === SPINDLE_TOOLS_SUITE) {
      return this.runSpindleSuite(request, modelFilter);
    }

    if (suiteId === PATTERN_PLANNING_SUITE) {
      return this.runPatternSuite(request, modelFilter);
    }

    if (suiteId === WEFT_REVIEW_SUITE) {
      return this.runWeftSuite(request, modelFilter);
    }

    if (suiteId === WARP_SECURITY_SUITE) {
      return this.runWarpSuite(request, modelFilter);
    }

    return ResultAsync.fromSafePromise(Promise.resolve(undefined)).andThen(() =>
      err({
        type: "UnknownEvalSuite",
        suite: suiteId,
        message: `Eval suite "${suiteId}" is not registered with the orchestrator.`,
      } satisfies RunnerError),
    );
  }

  // ---------------------------------------------------------------------------
  // Private: individual suite runners
  // ---------------------------------------------------------------------------

  private runLoomSuite(
    request: EvalRunRequest,
    modelFilter: string | undefined,
  ): ResultAsync<RunnerResult, RunnerError> {
    const runner = new LoomRoutingRunner({
      modelClient: this.modelClient,
      scorer: this.scorer,
      promptProvider: this.promptProvider,
      evalsRoot: this.evalsRoot,
    });

    return runner.run({
      caseFilter: request.case,
      modelFilter,
      dryRun: request.dryRun,
      rawArtifacts: request.rawArtifacts,
    });
  }

  private runTapestrySuite(
    request: EvalRunRequest,
    modelFilter: string | undefined,
  ): ResultAsync<RunnerResult, RunnerError> {
    const runner = new TapestryExecutionRunner({
      modelClient: this.modelClient,
      scorer: this.scorer,
      promptProvider: this.promptProvider,
      evalsRoot: this.evalsRoot,
    });

    return runner.run({
      caseFilter: request.case,
      modelFilter,
      dryRun: request.dryRun,
      rawArtifacts: request.rawArtifacts,
    });
  }

  private runPatternSuite(
    request: EvalRunRequest,
    modelFilter: string | undefined,
  ): ResultAsync<RunnerResult, RunnerError> {
    const runner = new PatternPlanningRunner({
      modelClient: this.modelClient,
      scorer: this.scorer,
      promptProvider: this.promptProvider,
      evalsRoot: this.evalsRoot,
    });

    return runner.run({
      caseFilter: request.case,
      modelFilter,
      dryRun: request.dryRun,
      rawArtifacts: request.rawArtifacts,
    });
  }

  private runShuttleSuite(
    request: EvalRunRequest,
    modelFilter: string | undefined,
  ): ResultAsync<RunnerResult, RunnerError> {
    const runner = new ShuttleExecutionRunner({
      modelClient: this.modelClient,
      scorer: this.scorer,
      promptProvider: this.promptProvider,
      evalsRoot: this.evalsRoot,
    });

    return runner.run({
      caseFilter: request.case,
      modelFilter,
      dryRun: request.dryRun,
      rawArtifacts: request.rawArtifacts,
    });
  }

  private runSpindleSuite(
    request: EvalRunRequest,
    modelFilter: string | undefined,
  ): ResultAsync<RunnerResult, RunnerError> {
    const runner = new SpindleToolsRunner({
      modelClient: this.modelClient,
      scorer: this.scorer,
      promptProvider: this.promptProvider,
      evalsRoot: this.evalsRoot,
    });

    return runner.run({
      caseFilter: request.case,
      modelFilter,
      dryRun: request.dryRun,
      rawArtifacts: request.rawArtifacts,
    });
  }

  private runWeftSuite(
    request: EvalRunRequest,
    modelFilter: string | undefined,
  ): ResultAsync<RunnerResult, RunnerError> {
    const runner = new WeftReviewRunner({
      modelClient: this.modelClient,
      scorer: this.scorer,
      promptProvider: this.promptProvider,
      evalsRoot: this.evalsRoot,
    });

    return runner.run({
      caseFilter: request.case,
      modelFilter,
      dryRun: request.dryRun,
      rawArtifacts: request.rawArtifacts,
    });
  }

  private runWarpSuite(
    request: EvalRunRequest,
    modelFilter: string | undefined,
  ): ResultAsync<RunnerResult, RunnerError> {
    const runner = new WarpSecurityRunner({
      modelClient: this.modelClient,
      scorer: this.scorer,
      promptProvider: this.promptProvider,
      evalsRoot: this.evalsRoot,
    });

    return runner.run({
      caseFilter: request.case,
      modelFilter,
      dryRun: request.dryRun,
      rawArtifacts: request.rawArtifacts,
    });
  }

  // ---------------------------------------------------------------------------
  // Private: provenance derivation
  // ---------------------------------------------------------------------------

  /**
   * Derive a sanitized provenance manifest from collected prompt snapshots.
   *
   * The manifest contains stable SHA-256 hashes and source descriptors for
   * each agent's prompt — no raw prompt text. Returns `null` when derivation
   * fails so the bundle can still be written without provenance.
   *
   * In production, `snapshots` is populated by the `SnapshotProvider` which
   * calls `composeAgentSnapshots` to hash all eval-covered prompts.
   * In tests, the snapshot provider is a stub that returns controlled records.
   */
  private deriveProvenance(
    snapshots: PromptSnapshot[],
    repoSha: string,
  ): PromptProvenanceManifest | null {
    const manifestResult = deriveProvenanceManifest(snapshots, {
      gitShaProvider: { resolveGitSha: () => ok(repoSha) },
      capturedAt: this.assembledAt ?? new Date().toISOString(),
    });

    if (manifestResult.isErr()) {
      return null;
    }
    return manifestResult.value;
  }

  // ---------------------------------------------------------------------------
  // Private: bundle write
  // ---------------------------------------------------------------------------

  private writeBundle(
    runnerResults: RunnerResult[],
    provenanceManifest: PromptProvenanceManifest | null,
    gitSha: string,
    request: EvalRunRequest,
  ): ResultAsync<
    { bundleDir: string; runId: string | null; filesWritten: string[] },
    CliError
  > {
    // Skip writing when there are no results to bundle
    if (runnerResults.length === 0) {
      // Return a synthetic empty result — the bundle root is still the configured dir
      return ResultAsync.fromSafePromise(
        Promise.resolve({
          bundleDir: this.bundleRoot,
          runId: null,
          filesWritten: [] as string[],
        }),
      );
    }

    const writer = new ArtifactBundleWriter(this.bundleRoot);

    // Resolve the publisher for publish mode.
    //
    // When `publishMode === "publish"`:
    //   - If a publisher was injected (e.g. StubResultsRepoPublisher in tests),
    //     use that.
    //   - Otherwise, lazily instantiate GitHubContentsPublisher (production path).
    //
    // When `publishMode === "local"` (the default), publisher is undefined —
    // `ArtifactBundleWriter.writeBundle()` skips external publication.
    const resolvePublisher = async (): Promise<
      ResultsRepoPublisher | undefined
    > => {
      if (this.publishMode !== "publish") return undefined;
      if (this.publisher !== undefined) return this.publisher;
      // Lazy import to avoid loading the GitHub publisher module in local mode
      const { GitHubContentsPublisher } = await import(
        "./github-contents-publisher.js"
      );
      return new GitHubContentsPublisher();
    };

    const isRemoteSequenceReader = (
      value: ResultsRepoPublisher | undefined,
    ): value is ResultsRepoPublisher & RemoteSequenceReader => {
      return (
        value !== undefined &&
        "readRemoteRunIds" in value &&
        typeof value.readRemoteRunIds === "function"
      );
    };

    return ResultAsync.fromSafePromise(resolvePublisher()).andThen(
      (publisher) => {
        const remoteSequenceReader = isRemoteSequenceReader(publisher)
          ? publisher
          : undefined;

        return writer
          .writeBundle({
            runnerResults,
            provenanceManifest,
            gitSha,
            assembledAt: this.assembledAt,
            mode: this.publishMode,
            dryRun: request.dryRun,
            env: this.env,
            publisher,
            remoteSequenceReader,
            // Produce the human-readable Markdown report alongside the JSON
            // report for every non-dry-run bundle so all registered suites surface
            // through the same public reporting pipeline.
            writeMarkdown: !request.dryRun,
            // Generate dashboard indexes on every normal (non-dry-run) run so that
            // `weave eval run` always produces dashboard-manifest.json, latest.json,
            // last-N-runs.json, suite history, and model-comparison indexes.
            // Dry-runs are skipped because they produce no real model output.
            generateIndexes: !request.dryRun,
          })
          .map((writeResult) => ({
            bundleDir: writeResult.bundleDir,
            runId: writeResult.runId,
            filesWritten: writeResult.filesWritten,
          }))
          .mapErr(
            (bundleErr): CliError => ({
              type: "EvalValidation",
              message: `Bundle write failed: ${bundleErr.message}`,
            }),
          );
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Private: raw artifact write
  // ---------------------------------------------------------------------------

  /**
   * Write local-only raw artifacts for all case results that have them.
   *
   * Called only when `rawArtifacts` is `true`. Failures are accumulated and
   * returned but do not propagate as hard errors (raw artifacts are optional
   * debug data, not a required output).
   */
  private async writeRawArtifacts(
    runnerResults: RunnerResult[],
    bundleDir: string,
  ): Promise<{ written: string[]; errors: string[] }> {
    const rawWriter = new RawArtifactsWriter(bundleDir, true);
    const timestamp = new Date().toISOString();
    const written: string[] = [];
    const errors: string[] = [];

    for (const runnerResult of runnerResults) {
      for (const caseResult of runnerResult.caseResults) {
        if (caseResult.rawArtifact === undefined) continue;

        const result = await rawWriter.writeCaseResultArtifact(
          caseResult.rawArtifact,
          timestamp,
        );
        if (result.isOk()) {
          written.push(result.value);
        } else {
          // Record the error type (not the raw message — may contain paths)
          errors.push(result.error.type);
        }
      }
    }

    return { written, errors };
  }

  // ---------------------------------------------------------------------------
  // Private: repeatability diagnostics write
  // ---------------------------------------------------------------------------

  /**
   * Write a local-only repeatability artifact for the current run.
   *
   * The artifact is intentionally developer-facing. It stays in the local run
   * directory, is never added to the publishable bundle, and compares the
   * current run only against earlier runs with the exact same filter tuple.
   */
  private writeRepeatabilityDiagnostics(
    metadata: EvalRunMetadata,
    runnerResults: RunnerResult[],
    bundleDir: string,
    runId: string | null,
  ): ResultAsync<
    RepeatabilityDiagnosticsResult | null,
    RepeatabilityDiagnosticsFailure
  > {
    if (runId === null || runnerResults.length === 0) {
      return ResultAsync.fromSafePromise(Promise.resolve(null));
    }

    const comparisonKey = this.buildRepeatabilityComparisonKey(
      metadata,
      runnerResults,
    );
    const currentRun = this.buildRepeatabilityRunSnapshot(
      metadata,
      runnerResults,
      bundleDir,
      runId,
    );

    return this.readComparableRepeatabilityArtifacts(comparisonKey, bundleDir)
      .mapErr(
        (error): RepeatabilityDiagnosticsFailure => ({
          status: "failed",
          comparisonKey,
          errors: [error],
        }),
      )
      .andThen(({ artifacts: previousArtifacts, errors }) => {
        const comparableRuns = [
          ...previousArtifacts.map((item) => item.currentRun),
          currentRun,
        ].sort((a, b) => {
          const timeCompare = a.startedAt.localeCompare(b.startedAt);
          if (timeCompare !== 0) return timeCompare;
          return a.runId.localeCompare(b.runId);
        });

        const artifact: RepeatabilityDiagnosticsArtifact = {
          schemaVersion: REPEATABILITY_DIAGNOSTICS_SCHEMA_VERSION,
          generatedAt: new Date().toISOString(),
          comparisonKey,
          currentRun,
          comparableRunIds: comparableRuns.map((run) => run.runId),
          comparableRunCount: comparableRuns.length,
          driftSummary: {
            models: this.buildRepeatabilityModelDriftSummaries(comparableRuns),
            caseModels:
              this.buildRepeatabilityCaseModelDriftSummaries(comparableRuns),
          },
        };

        const filePath = join(bundleDir, "repeatability-diagnostics.json");
        return this.writeRepeatabilityDiagnosticsArtifact(filePath, artifact)
          .map(
            (): RepeatabilityDiagnosticsSummary => ({
              status: "written",
              filePath,
              comparisonKey,
              comparableRunIds: artifact.comparableRunIds,
              comparableRunCount: artifact.comparableRunCount,
              errors,
            }),
          )
          .mapErr(
            (error): RepeatabilityDiagnosticsFailure => ({
              status: "failed",
              comparisonKey,
              errors: [...errors, error],
            }),
          );
      });
  }

  private readComparableRepeatabilityArtifacts(
    comparisonKey: RepeatabilityComparisonKey,
    currentBundleDir: string,
  ): ResultAsync<
    {
      artifacts: RepeatabilityDiagnosticsArtifact[];
      errors: RepeatabilityDiagnosticsError[];
    },
    RepeatabilityDiagnosticsError
  > {
    return this.listRepeatabilityArtifactPaths(currentBundleDir).andThen(
      (files) =>
        ResultAsync.fromSafePromise(
          (async () => {
            const artifacts: RepeatabilityDiagnosticsArtifact[] = [];
            const errors: RepeatabilityDiagnosticsError[] = [];

            for (const filePath of files) {
              const artifactResult =
                await this.readRepeatabilityArtifact(filePath);

              if (artifactResult.isErr()) {
                errors.push(artifactResult.error);
                continue;
              }

              const artifact = artifactResult.value;
              if (artifact === null) {
                continue;
              }

              if (
                !this.sameRepeatabilityComparisonKey(
                  artifact.comparisonKey,
                  comparisonKey,
                )
              ) {
                continue;
              }

              artifacts.push(artifact);
            }

            return { artifacts, errors };
          })(),
        ),
    );
  }

  private listRepeatabilityArtifactPaths(
    currentBundleDir: string,
  ): ResultAsync<string[], RepeatabilityDiagnosticsError> {
    return ResultAsync.fromPromise(
      (async () => {
        const files: string[] = [];
        const glob = new Bun.Glob(
          `${this.bundleRoot}/runs/*/repeatability-diagnostics.json`,
        );

        for await (const file of glob.scan({ cwd: "/" })) {
          if (file.startsWith(`${currentBundleDir}/`)) {
            continue;
          }
          files.push(file);
        }

        return files;
      })(),
      (cause): RepeatabilityDiagnosticsError => ({
        type: "RepeatabilityDiagnosticsScanError",
        bundleRoot: this.bundleRoot,
        message: this.formatRepeatabilityDiagnosticsCause(cause),
      }),
    );
  }

  private readRepeatabilityArtifact(
    filePath: string,
  ): ResultAsync<
    RepeatabilityDiagnosticsArtifact | null,
    RepeatabilityDiagnosticsError
  > {
    return ResultAsync.fromThrowable(
      () => Bun.file(filePath).json(),
      (cause): RepeatabilityDiagnosticsError => ({
        type: "RepeatabilityDiagnosticsReadError",
        filePath,
        message: this.formatRepeatabilityDiagnosticsCause(cause),
      }),
    )().map((parsed) => {
      if (!this.isCompatibleRepeatabilityArtifact(parsed)) {
        return null;
      }

      return parsed;
    });
  }

  private writeRepeatabilityDiagnosticsArtifact(
    filePath: string,
    artifact: RepeatabilityDiagnosticsArtifact,
  ): ResultAsync<void, RepeatabilityDiagnosticsError> {
    return ResultAsync.fromThrowable(
      () => Bun.write(filePath, JSON.stringify(artifact, null, 2)),
      (cause): RepeatabilityDiagnosticsError => ({
        type: "RepeatabilityDiagnosticsWriteError",
        filePath,
        message: this.formatRepeatabilityDiagnosticsCause(cause),
      }),
    )().map(() => undefined);
  }

  private isCompatibleRepeatabilityArtifact(
    value: unknown,
  ): value is RepeatabilityDiagnosticsArtifact {
    if (typeof value !== "object" || value === null) {
      return false;
    }

    const candidate = value as {
      schemaVersion?: unknown;
      comparisonKey?: unknown;
      currentRun?: unknown;
    };

    if (candidate.schemaVersion !== REPEATABILITY_DIAGNOSTICS_SCHEMA_VERSION) {
      return false;
    }

    if (
      typeof candidate.comparisonKey !== "object" ||
      candidate.comparisonKey === null
    ) {
      return false;
    }

    if (
      typeof candidate.currentRun !== "object" ||
      candidate.currentRun === null
    ) {
      return false;
    }

    return true;
  }

  private buildRepeatabilityComparisonKey(
    metadata: EvalRunMetadata,
    runnerResults: RunnerResult[],
  ): RepeatabilityComparisonKey {
    const suites = [
      ...new Set(runnerResults.map((result) => result.suite)),
    ].sort();

    return {
      agentFilter: metadata.agentFilter,
      modelFilter: metadata.modelFilter,
      caseFilter: metadata.caseFilter,
      suites,
    };
  }

  private sameRepeatabilityComparisonKey(
    left: RepeatabilityComparisonKey,
    right: RepeatabilityComparisonKey,
  ): boolean {
    if (left.agentFilter !== right.agentFilter) return false;
    if (left.modelFilter !== right.modelFilter) return false;
    if (left.caseFilter !== right.caseFilter) return false;
    if (left.suites.length !== right.suites.length) return false;

    for (let index = 0; index < left.suites.length; index += 1) {
      if (left.suites[index] !== right.suites[index]) {
        return false;
      }
    }

    return true;
  }

  private buildRepeatabilityRunSnapshot(
    metadata: EvalRunMetadata,
    runnerResults: RunnerResult[],
    bundleDir: string,
    runId: string,
  ): RepeatabilityRunSnapshot {
    const suites = [...new Set(runnerResults.map((result) => result.suite))]
      .sort((a, b) => a.localeCompare(b))
      .map((suite) => {
        const suiteResults = runnerResults.filter(
          (result) => result.suite === suite,
        );
        const totalCases = suiteResults.reduce(
          (sum, result) => sum + result.totalCases,
          0,
        );
        const passedCases = suiteResults.reduce(
          (sum, result) => sum + result.passedCases,
          0,
        );
        const failedCases = suiteResults.reduce(
          (sum, result) => sum + result.failedCases,
          0,
        );
        const suiteGreen = suiteResults.every((result) => result.suiteGreen);
        const modelGroups = new Map<
          string,
          RepeatabilityModelSnapshot["cases"]
        >();

        for (const result of suiteResults) {
          for (const caseResult of result.caseResults) {
            const modelId = caseResult.summary.modelId;
            const existing = modelGroups.get(modelId) ?? [];
            existing.push({
              caseId: caseResult.summary.caseId,
              passed: caseResult.summary.passed,
              required: caseResult.summary.required,
              weightedTotal: caseResult.summary.weightedTotal,
              dryRun: caseResult.summary.dryRun,
            });
            modelGroups.set(modelId, existing);
          }
        }

        const models = [...modelGroups.entries()]
          .map(([modelId, cases]) => {
            const passedModelCases = cases.filter(
              (caseSnapshot) => caseSnapshot.passed,
            ).length;
            const failedModelCases = cases.length - passedModelCases;

            return {
              modelId,
              totalCases: cases.length,
              passedCases: passedModelCases,
              failedCases: failedModelCases,
              passRate:
                cases.length === 0 ? null : passedModelCases / cases.length,
              cases: [...cases].sort((a, b) =>
                a.caseId.localeCompare(b.caseId),
              ),
            } satisfies RepeatabilityModelSnapshot;
          })
          .sort((a, b) => a.modelId.localeCompare(b.modelId));

        return {
          suite,
          totalCases,
          passedCases,
          failedCases,
          suiteGreen,
          models,
        } satisfies RepeatabilitySuiteSnapshot;
      });

    return {
      runId,
      repoSha: metadata.repoSha,
      startedAt: metadata.startedAt,
      bundleDir,
      suites,
    };
  }

  private buildRepeatabilityModelDriftSummaries(
    comparableRuns: RepeatabilityRunSnapshot[],
  ): RepeatabilityModelDriftSummary[] {
    const groups = new Map<
      string,
      Array<{
        suite: string;
        modelId: string;
        runId: string;
        passedCases: number;
        totalCases: number;
        failedCases: number;
        passRate: number | null;
      }>
    >();

    for (const run of comparableRuns) {
      for (const suite of run.suites) {
        for (const model of suite.models) {
          const key = `${suite.suite}::${model.modelId}`;
          const existing = groups.get(key) ?? [];
          existing.push({
            suite: suite.suite,
            modelId: model.modelId,
            runId: run.runId,
            passedCases: model.passedCases,
            totalCases: model.totalCases,
            failedCases: model.failedCases,
            passRate: model.passRate,
          });
          groups.set(key, existing);
        }
      }
    }

    return [...groups.values()]
      .flatMap((runs) => {
        const firstRun = runs[0];
        if (firstRun === undefined) {
          return [];
        }

        const passRates = runs
          .map((run) => run.passRate)
          .filter((value): value is number => value !== null);
        const minPassRate =
          passRates.length === 0 ? null : Math.min(...passRates);
        const maxPassRate =
          passRates.length === 0 ? null : Math.max(...passRates);
        const classification = this.classifyModelDrift(runs);

        return [
          {
            suite: firstRun.suite,
            modelId: firstRun.modelId,
            comparableRunCount: runs.length,
            classification,
            passRateRange: {
              min: minPassRate,
              max: maxPassRate,
            },
            runs,
          } satisfies RepeatabilityModelDriftSummary,
        ];
      })
      .sort((a, b) => {
        const suiteCompare = a.suite.localeCompare(b.suite);
        if (suiteCompare !== 0) return suiteCompare;
        return a.modelId.localeCompare(b.modelId);
      });
  }

  private classifyModelDrift(
    runs: Array<{
      passedCases: number;
      totalCases: number;
      failedCases: number;
      passRate: number | null;
    }>,
  ): "single-run" | "consistent" | "drifted" {
    if (runs.length <= 1) return "single-run";

    const first = runs[0];
    if (first === undefined) {
      return "single-run";
    }

    const allSame = runs.every(
      (run) =>
        run.passedCases === first.passedCases &&
        run.totalCases === first.totalCases &&
        run.failedCases === first.failedCases &&
        run.passRate === first.passRate,
    );

    return allSame ? "consistent" : "drifted";
  }

  private buildRepeatabilityCaseModelDriftSummaries(
    comparableRuns: RepeatabilityRunSnapshot[],
  ): RepeatabilityCaseModelDriftSummary[] {
    const groups = new Map<
      string,
      Array<{
        suite: string;
        caseId: string;
        modelId: string;
        runId: string;
        passed: boolean;
        required: boolean;
        weightedTotal: number;
      }>
    >();

    for (const run of comparableRuns) {
      for (const suite of run.suites) {
        for (const model of suite.models) {
          for (const caseSnapshot of model.cases) {
            const key = `${suite.suite}::${caseSnapshot.caseId}::${model.modelId}`;
            const existing = groups.get(key) ?? [];
            existing.push({
              suite: suite.suite,
              caseId: caseSnapshot.caseId,
              modelId: model.modelId,
              runId: run.runId,
              passed: caseSnapshot.passed,
              required: caseSnapshot.required,
              weightedTotal: caseSnapshot.weightedTotal,
            });
            groups.set(key, existing);
          }
        }
      }
    }

    return [...groups.values()]
      .flatMap((runs) => {
        const firstRun = runs[0];
        if (firstRun === undefined) {
          return [];
        }

        const weightedTotals = runs.map((run) => run.weightedTotal);
        return [
          {
            suite: firstRun.suite,
            caseId: firstRun.caseId,
            modelId: firstRun.modelId,
            comparableRunCount: runs.length,
            classification: this.classifyCaseModelDrift(runs),
            weightedTotalRange: {
              min: Math.min(...weightedTotals),
              max: Math.max(...weightedTotals),
            },
            runs,
          } satisfies RepeatabilityCaseModelDriftSummary,
        ];
      })
      .sort((a, b) => {
        const suiteCompare = a.suite.localeCompare(b.suite);
        if (suiteCompare !== 0) return suiteCompare;
        const caseCompare = a.caseId.localeCompare(b.caseId);
        if (caseCompare !== 0) return caseCompare;
        return a.modelId.localeCompare(b.modelId);
      });
  }

  private classifyCaseModelDrift(
    runs: Array<{ passed: boolean }>,
  ): "single-run" | "consistent-pass" | "consistent-fail" | "mixed" {
    if (runs.length <= 1) return "single-run";

    const passCount = runs.filter((run) => run.passed).length;
    if (passCount === runs.length) return "consistent-pass";
    if (passCount === 0) return "consistent-fail";
    return "mixed";
  }

  // ---------------------------------------------------------------------------
  // Private: run summary assembly
  // ---------------------------------------------------------------------------

  private assembleRunSummary(
    metadata: EvalRunMetadata,
    runnerResults: RunnerResult[],
    partialFailures: RunnerError[],
    bundleDir: string,
    runId: string | null,
    filesWritten: string[],
    rawArtifactsWritten: string[],
    repeatabilityDiagnostics: RepeatabilityDiagnosticsResult | null,
  ): EvalRunSummary {
    // Aggregate totals
    const totalCases = runnerResults.reduce((s, rr) => s + rr.totalCases, 0);
    const passedCases = runnerResults.reduce((s, rr) => s + rr.passedCases, 0);
    const failedCases = runnerResults.reduce((s, rr) => s + rr.failedCases, 0);
    const allSuitesGreen = runnerResults.every((rr) => rr.suiteGreen);

    // Per-agent rollups (one per suite)
    const agentRollups: AgentRollup[] = runnerResults.map((rr) => ({
      suite: rr.suite,
      totalCases: rr.totalCases,
      passedCases: rr.passedCases,
      failedCases: rr.failedCases,
      suiteGreen: rr.suiteGreen,
    }));

    // Per-model rollups (aggregate across all suites)
    const modelRollups = this.computeModelRollups(runnerResults);

    return {
      metadata,
      agentRollups,
      modelRollups,
      totalCases,
      passedCases,
      failedCases,
      allSuitesGreen,
      bundleDir,
      runId,
      filesWritten,
      rawArtifactsWritten,
      repeatabilityDiagnostics,
      partialFailures,
    };
  }

  /**
   * Compute per-model rollups by aggregating all `CaseResult` entries across
   * all suites, grouped by `modelId`.
   */
  private computeModelRollups(runnerResults: RunnerResult[]): ModelRollup[] {
    const byModel = new Map<string, { total: number; passed: number }>();

    for (const rr of runnerResults) {
      for (const cr of rr.caseResults) {
        const { modelId, passed } = cr.summary;
        const existing = byModel.get(modelId) ?? { total: 0, passed: 0 };
        byModel.set(modelId, {
          total: existing.total + 1,
          passed: existing.passed + (passed ? 1 : 0),
        });
      }
    }

    const rollups: ModelRollup[] = [];
    for (const [modelId, counts] of byModel) {
      const passRate = counts.total === 0 ? null : counts.passed / counts.total;
      rollups.push({
        modelId,
        totalCases: counts.total,
        passedCases: counts.passed,
        failedCases: counts.total - counts.passed,
        passRate,
      });
    }

    // Sort by modelId for deterministic output
    return rollups.sort((a, b) => a.modelId.localeCompare(b.modelId));
  }

  // ---------------------------------------------------------------------------
  // Private: run metadata construction
  // ---------------------------------------------------------------------------

  /**
   * Build sanitized run metadata.
   *
   * Only safe, bounded values are included:
   *   - `Bun.version` — semver string, always safe
   *   - `repoSha` — 40-char hex SHA or `"unknown"`
   *   - `workflowRunId` — digits-only numeric string from CI env or `null`
   *   - Filter values — already validated identifiers from `EvalRunRequest`
   *   - Booleans for policy flags
   *
   * API keys, tokens, and arbitrary env values are NEVER included.
   */
  private buildRunMetadata(
    request: EvalRunRequest,
    repoSha: string,
    startedAt: string,
  ): EvalRunMetadata {
    // Workflow run ID: read from known CI env vars, numeric only, no secrets
    const workflowRunId = this.resolveWorkflowRunId();

    return {
      bunVersion: Bun.version,
      repoSha,
      workflowRunId,
      agentFilter: request.agent ?? null,
      modelFilter: request.model ?? null,
      caseFilter: request.case ?? null,
      rawArtifactsEnabled: request.rawArtifacts,
      publishMode: this.publishMode,
      startedAt,
    };
  }

  /**
   * Resolve the CI workflow run ID from environment variables.
   *
   * Reads `GITHUB_RUN_ID` (GitHub Actions). Only the run ID value is used —
   * no tokens, no secrets, no repo URLs. Returns `null` outside CI.
   *
   * GitHub Actions run IDs are numeric (e.g. `"12345678"`). The value is
   * validated to contain only digits to prevent leaking arbitrary env content.
   * Values with hyphens or other non-digit characters are rejected.
   */
  private resolveWorkflowRunId(): string | null {
    const githubRunId = this.env.GITHUB_RUN_ID;
    if (githubRunId === undefined || githubRunId.trim() === "") {
      return null;
    }
    // Validate: only allow digits (GitHub run IDs are numeric integers)
    const trimmed = githubRunId.trim();
    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private: error message sanitization
  // ---------------------------------------------------------------------------

  /**
   * Produce a safe error message from an `EvalEnvError`.
   *
   * The raw `EvalEnvError.message` from `readEvalEnv()` never contains
   * the key value itself (by design of `env.ts`). We still project through
   * a controlled message here to ensure no future leaks.
   *
   * The error variant (`type`) is included to help callers diagnose the issue.
   */
  private sanitizeEnvErrorMessage(envErr: EvalEnvError): string {
    if (envErr.type === "MissingApiKey") {
      return (
        `Eval environment configuration error (${envErr.type}): ` +
        `${OPENROUTER_API_KEY_ENV_VAR} is required but was not set or is empty. ` +
        `Set it before running weave eval run.`
      );
    }
    // envErr.type === "InvalidBaseUrl"
    // Safe: exposes only the error type, not the raw URL value
    return (
      `Eval environment configuration error (${envErr.type}): ` +
      `the OpenRouter base URL override is not a valid http/https URL. ` +
      `Remove OPENROUTER_BASE_URL to use the default.`
    );
  }

  private formatRepeatabilityDiagnosticsCause(cause: unknown): string {
    if (cause instanceof Error) {
      return cause.message;
    }

    if (typeof cause === "string") {
      return cause;
    }

    return "Unknown repeatability diagnostics failure.";
  }
}

// ---------------------------------------------------------------------------
// Convenience: buildEvalRunner
// ---------------------------------------------------------------------------

/**
 * Build a runner function compatible with `EvalContext.runner` from an
 * `EvalOrchestrator`.
 *
 * This adapts the orchestrator's `run()` return type (`EvalRunSummary`) to
 * the exit-code integer expected by the command handler.
 *
 * Exit codes:
 *   - `0` — orchestration completed and produced a report, even when one or
 *     more eval cases missed their pass threshold (`allSuitesGreen === false`)
 *   - `1` — a hard error occurred or a suite-level partial failure prevented
 *     part of the run from producing results
 *
 * Threshold misses are data in the published bundle, not process failures. The
 * caller may inspect `summary.allSuitesGreen` and `summary.partialFailures` to
 * decide whether to apply a separate quality gate.
 *
 * @param orchestrator - The configured `EvalOrchestrator` instance.
 * @returns A runner function suitable for `EvalContext.runner`.
 */
export function buildEvalRunner(
  orchestrator: EvalOrchestrator,
): (request: EvalRunRequest) => Promise<Result<number, CliError>> {
  return async (request: EvalRunRequest): Promise<Result<number, CliError>> => {
    const result = await orchestrator.run(request);
    if (result.isErr()) {
      return err(result.error);
    }
    const summary = result.value;
    const exitCode = summary.partialFailures.length === 0 ? 0 : 1;
    return ok(exitCode);
  };
}

// ---------------------------------------------------------------------------
// Default SnapshotProvider — production path
// ---------------------------------------------------------------------------

/**
 * Build the default `SnapshotProvider` used when no override is injected.
 *
 * The default provider calls `composeAgentSnapshots` from `prompt-snapshots.ts`
 * to hash all eval-covered prompts using the real `@weaveio/weave-config` and
 * `@weaveio/weave-engine` composition pipeline. Errors during snapshot composition for
 * individual agents are swallowed — the provider returns whatever snapshots it
 * could collect, possibly an empty array. The orchestrator then derives a
 * manifest from whatever snapshots are available.
 *
 * This is the production path; tests always inject a stub `SnapshotProvider`
 * via `EvalOrchestratorOptions.snapshotProvider` to avoid file I/O, git, and
 * engine calls.
 */
function makeDefaultSnapshotProvider(): SnapshotProvider {
  return {
    async getSnapshots(
      agentNames: readonly string[],
    ): Promise<PromptSnapshot[]> {
      try {
        const { composeAgentSnapshots } = await import("./prompt-snapshots.js");
        const result = await composeAgentSnapshots({
          agentNames,
          rawArtifacts: false,
        });
        if (result.isErr()) {
          // Config load failure — return empty; orchestrator continues with no-op manifest
          return [];
        }
        // Return successfully composed snapshots; per-agent errors are already
        // collected in result.value.errors and the provider ignores them (partial
        // provenance is better than no provenance).
        return result.value.snapshots;
      } catch {
        // Dynamic import failed (unlikely in production) — return empty
        return [];
      }
    },
  };
}

export function getEvalCoveredPromptAgents(): readonly string[] {
  return EVAL_SHORT_AGENT_FILTERS;
}
