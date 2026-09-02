/**
 * Repeatable run-provenance and artifact verifier for agent eval runs.
 *
 * Validates `bundle-index.json` and `public-report.json` for a single eval
 * run — either a local run directory (`<bundleRoot>/runs/<runId>/`) or a
 * remote run ID published to the external results repository — and reports
 * safe, non-sensitive provenance about the runner/scorer/judge/dependency
 * stack that produced it.
 *
 * # What this verifies
 *
 *   - `bundle-index.json` and `public-report.json` parse as JSON and satisfy
 *     minimal structural schemas (schema version, run identity, suite/case
 *     shape).
 *   - The immutable `bundle-index.json` run identity (`runId`, `gitSha`,
 *     `dryRun`, `runSummary`) agrees exactly with `public-report.json`.
 *   - Every in-scope suite declares at least one case (`totalCases > 0`).
 *   - `tapestry-category-routing` (when in scope) includes both
 *     `tcr-04-no-match` and `tcr-10-disabled-category`.
 *   - Suite/case/model completeness against caller-injected expectations
 *     (`SuiteExpectationsProvider`): every expected case×model combination
 *     is present exactly once (no missing rows, no duplicates, no missing
 *     model rows), suite case counts match, and case `suite` fields agree
 *     with the enclosing suite summary's name.
 *   - Every case has a non-blank, bounded, closed-source `explanation.text`
 *     — a missing explanation, a blank/whitespace-only explanation, an
 *     over-long explanation, or an explanation from an unrecognised source
 *     are all rejected.
 *   - The `gitSha` is not stale: it must be reachable (an ancestor of, or
 *     equal to) the caller-supplied `expectedHeadSha`, when provided.
 *   - The source tree at `gitSha` contains the Tapestry generic-Shuttle
 *     scorer branch marker (`expectedTarget === GENERIC_SHUTTLE`) in
 *     `tapestry-category-routing-runner.ts`, when that suite is in scope.
 *   - Optional derived remote index artifacts (`dashboard-manifest.json`,
 *     `suite-history-<suite>.json`, `scenario-history-<suite>.json`,
 *     `model-comparison-<runId>.json`), when supplied by the injected
 *     `ArtifactReader`, agree with the immutable run artifacts.
 *
 * # Prompt hash evidence (local vs. remote)
 *
 * Prompt hashes are written locally to the internal `prompt-hashes.json`
 * artifact (never part of `publicFiles`, never uploaded to the public
 * results repository). This verifier never fetches that file for a remote
 * source — doing so would require publishing an internal artifact just to
 * satisfy verification, which is exactly the trade-off this contract avoids.
 *
 *   - **Local** sources are expected to have local/internal artifacts
 *     available: `prompt-hashes.json` MUST be present, parse, and contain at
 *     least one well-formed, unique-per-agent record, or verification fails
 *     with a fatal `PromptHashEvidenceUnavailable` (or `InvalidPromptHash` /
 *     `DuplicatePromptHashAgent` for malformed content).
 *   - **Remote** sources never read `prompt-hashes.json`. If `bundle-index.json`
 *     exposes an already-publishable `promptHashRecords` field (a safe,
 *     hash-only commitment — never raw prompt text), it is validated the
 *     same way. When that safe field is absent, this is NOT an error: the
 *     verifier reports `promptHashEvidence: { status: "unavailable", ... }`
 *     in the successful `VerifyReport`, which callers MUST treat as "cannot
 *     claim full provenance" rather than silently accepting the run as fully
 *     verified.
 *
 * # What this reports (safe provenance only)
 *
 *   - The scorer adapter module name (a fixed, non-sensitive constant).
 *   - The configured judge model ID (a model slug, not a secret) — parsed
 *     from `packages/cli/src/commands/eval.ts` source text at the verified
 *     `gitSha` via the injected `GitSourceReader`. Never read from an
 *     environment variable.
 *   - The CLI package version — parsed from `packages/cli/package.json`
 *     source text at the verified `gitSha`.
 *   - Locked evaluator dependency versions (`@langchain/core`,
 *     `@langchain/openai`, `agentevals`, `openevals`) — parsed from the root
 *     `bun.lock` source text at the verified `gitSha`.
 *
 * All provenance facts are derived from the same `gitSha` that produced the
 * run, not from the machine currently running this script — this is what
 * makes the report a faithful record of *that run's* provenance rather than
 * whatever happens to be installed locally.
 *
 * This module NEVER reads or prints environment variables, secrets, tokens,
 * raw prompt/transcript content, or rationale strings. All I/O (file reads,
 * `fetch`, git/source lookups) is performed through injected interfaces so
 * tests can run with zero real network/filesystem/process access.
 */

import { join } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { loadSuiteCases } from "../../packages/cli/src/evals/case-loader.js";
import {
  loadModelMatrix,
  resolveDefaultModels,
} from "../../packages/cli/src/evals/model-matrix.js";
import { EVAL_SUITE_IDS } from "../../packages/cli/src/evals/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Suite name that requires the generic-Shuttle scorer branch check. */
export const CATEGORY_ROUTING_SUITE = "tapestry-category-routing";

/** Case IDs that must always be present in `tapestry-category-routing` runs. */
export const REQUIRED_CATEGORY_ROUTING_CASES: readonly string[] = [
  "tcr-04-no-match",
  "tcr-10-disabled-category",
];

/** Relative path (from repo root) of the runner file containing the scorer branch. */
export const CATEGORY_ROUTING_RUNNER_PATH =
  "packages/cli/src/evals/tapestry-category-routing-runner.ts";

/**
 * The exact source marker that must be present in
 * `tapestry-category-routing-runner.ts` at the verified `gitSha` — the
 * generic-Shuttle fallback branch of `scoreRoutingCorrectness()`.
 */
export const GENERIC_SHUTTLE_SCORER_MARKER =
  "analysis.expectedTarget === GENERIC_SHUTTLE";

/** Relative path (from repo root) of the eval command source (judge model ID). */
export const EVAL_COMMAND_PATH = "packages/cli/src/commands/eval.ts";

/** Relative path (from repo root) of the CLI package manifest. */
export const CLI_PACKAGE_JSON_PATH = "packages/cli/package.json";

/** Relative path (from repo root) of the root lockfile. */
export const ROOT_LOCKFILE_PATH = "bun.lock";

/** Fixed, non-sensitive scorer adapter module name reported in provenance. */
export const SCORER_ADAPTER_MODULE = "langchain-agent-evals.ts";

/** Dependency names whose locked versions are resolved from the lockfile. */
export const LOCKED_DEPENDENCY_NAMES: readonly string[] = [
  "@langchain/core",
  "@langchain/openai",
  "agentevals",
  "openevals",
];

/** Expected `schemaVersion` for `bundle-index.json`. */
export const EXPECTED_BUNDLE_INDEX_SCHEMA_VERSION = 1;

/** Expected `schemaVersion` for `public-report.json`. */
export const EXPECTED_PUBLIC_REPORT_SCHEMA_VERSION = 1;

/** Maximum character length for any case explanation (mirrors `report-schema.ts`). */
export const EXPLANATION_MAX_CHARS = 300;

/** Closed allowlist of permitted explanation sources (mirrors `report-schema.ts`). */
export const ALLOWED_EXPLANATION_SOURCES: ReadonlySet<string> = new Set([
  "rubric_template",
  "score_bucket_label",
  "structured_signal",
  "operator_note",
]);

/** Full 40-char lowercase hex git SHA pattern. */
const FULL_SHA_RE = /^[a-f0-9]{40}$/;

/** SHA-256 hex digest pattern (64 lowercase hex chars). */
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export type VerifyEvalRunError =
  | { type: "FetchNetworkError"; path: string; message: string }
  | { type: "FetchHttpError"; path: string; status: number; message: string }
  | { type: "FileReadError"; path: string; message: string }
  | { type: "JsonParseError"; path: string; message: string }
  | {
      type: "SchemaValidationFailed";
      artifact: string;
      message: string;
    }
  | {
      type: "SchemaVersionIncompatible";
      artifact: "bundle-index.json" | "public-report.json";
      found: number;
      expected: number;
    }
  | { type: "StaleGitSha"; found: string; expectedHead: string }
  | { type: "MissingSuite"; suite: string }
  | { type: "MissingCase"; suite: string; caseId: string }
  | { type: "ZeroCases"; suite: string }
  | {
      type: "BlankExplanation";
      suite: string;
      caseId: string;
      modelId: string;
      reason: "missing" | "blank" | "too_long" | "invalid_source";
    }
  | {
      type: "IndexRunMismatch";
      field: string;
      indexValue: string;
      reportValue: string;
    }
  | {
      type: "MissingModelRow";
      suite: string;
      modelId: string;
    }
  | {
      type: "MissingCaseModelCombo";
      suite: string;
      caseId: string;
      modelId: string;
    }
  | {
      type: "DuplicateCaseModelRow";
      suite: string;
      caseId: string;
      modelId: string;
      count: number;
    }
  | {
      type: "SuiteCaseCountMismatch";
      suite: string;
      expected: number;
      actual: number;
    }
  | {
      type: "SuiteNameMismatch";
      expectedSuite: string;
      foundSuite: string;
      caseId: string;
    }
  | {
      type: "DashboardEntryMissing";
      runId: string;
    }
  | {
      type: "DashboardEntryMismatch";
      field: string;
      indexValue: string;
      dashboardValue: string;
    }
  | {
      type: "SuiteHistoryEntryMissing";
      suite: string;
      runId: string;
    }
  | {
      type: "SuiteHistoryEntryMismatch";
      suite: string;
      field: string;
      reportValue: string;
      historyValue: string;
    }
  | {
      type: "ModelComparisonEntryMissing";
      modelId: string;
    }
  | {
      type: "ModelComparisonMismatch";
      modelId: string;
      field: string;
      reportValue: string;
      comparisonValue: string;
    }
  | {
      type: "SourceReadError";
      path: string;
      gitSha: string;
      message: string;
    }
  | {
      type: "ScorerBranchMissing";
      path: string;
      gitSha: string;
      marker: string;
    }
  | {
      type: "ProvenanceSourceParseError";
      path: string;
      message: string;
    }
  | {
      type: "InvalidPromptHash";
      agentName: string;
      reason: "blank" | "malformed";
    }
  | {
      type: "DuplicatePromptHashAgent";
      agentName: string;
      count: number;
    }
  | {
      type: "PromptHashEvidenceUnavailable";
      source: "local" | "remote";
      reason:
        | "missing_local_artifact"
        | "empty_local_artifact"
        | "no_safe_remote_field";
    }
  | {
      type: "ScenarioHistoryEntryMissing";
      suite: string;
      caseId: string;
    }
  | {
      type: "ScenarioHistoryRunMissing";
      suite: string;
      caseId: string;
      runId: string;
    }
  | {
      type: "ScenarioHistoryDescriptionMissing";
      suite: string;
      caseId: string;
    }
  | {
      type: "ScenarioHistoryMismatch";
      suite: string;
      caseId: string;
      field: string;
      reportValue: string;
      historyValue: string;
    }
  | {
      type: "MissingIndexArtifact";
      source: "local" | "remote";
      fileName: string;
    }
  | {
      type: "SuiteExpectationsLoadError";
      message: string;
    };

// ---------------------------------------------------------------------------
// Minimal structural shapes (only the fields this verifier depends on)
// ---------------------------------------------------------------------------

interface BundleIndexShape {
  schemaVersion: number;
  assembledAt: string;
  gitSha: string;
  dryRun: boolean;
  runId: string;
  runSummary: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
    allSuitesGreen: boolean;
    suites: string[];
  };
  publicFiles: string[];
  /**
   * Optional prompt hash records — only present when the artifact schema
   * that produced `bundle-index.json` exposes them. Absent in current
   * production output (prompt hashes are internal-only today); validated
   * only when present so this stays forward-compatible.
   */
  promptHashRecords?: PromptHashRecordShape[];
}

interface PromptHashRecordShape {
  agentName: string;
  hash: string;
  byteLength: number;
  charLength: number;
}

interface PublicCaseEntryShape {
  caseId: string;
  modelId: string;
  suite: string;
  scoreBucket: string;
  passed: boolean;
  required: boolean;
  dryRun: boolean;
  explanation?: { text: string; source: string };
  scoredAt: string;
}

interface SuiteSummaryShape {
  schemaVersion: number;
  suite: string;
  assembledAt: string;
  gitSha: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  suiteGreen: boolean;
  cases: PublicCaseEntryShape[];
}

interface PublicReportShape {
  schemaVersion: number;
  assembledAt: string;
  gitSha: string;
  dryRun: boolean;
  runSummary: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
    allSuitesGreen: boolean;
    suites: string[];
  };
  suiteSummaries: SuiteSummaryShape[];
}

// ---------------------------------------------------------------------------
// JSON parsing (Result.fromThrowable — no hand-written try/catch)
// ---------------------------------------------------------------------------

function parseJson(
  raw: string,
  path: string,
): Result<unknown, VerifyEvalRunError> {
  const parser = Result.fromThrowable(
    () => JSON.parse(raw) as unknown,
    (cause): VerifyEvalRunError => ({
      type: "JsonParseError",
      path,
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  );
  return parser();
}

// ---------------------------------------------------------------------------
// Structural validation helpers (no external schema dependency)
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function validateBundleIndex(
  raw: unknown,
): Result<BundleIndexShape, VerifyEvalRunError> {
  const fail = (message: string) =>
    err<BundleIndexShape, VerifyEvalRunError>({
      type: "SchemaValidationFailed",
      artifact: "bundle-index.json",
      message,
    });

  if (typeof raw !== "object" || raw === null) {
    return fail("bundle-index.json must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (!isNumber(o.schemaVersion)) return fail("schemaVersion must be a number");
  if (!isString(o.assembledAt)) return fail("assembledAt must be a string");
  if (!isString(o.gitSha)) return fail("gitSha must be a string");
  if (!isBoolean(o.dryRun)) return fail("dryRun must be a boolean");
  if (!isString(o.runId)) return fail("runId must be a string");
  if (typeof o.runSummary !== "object" || o.runSummary === null) {
    return fail("runSummary must be an object");
  }
  const rs = o.runSummary as Record<string, unknown>;
  if (!isNumber(rs.totalCases))
    return fail("runSummary.totalCases must be a number");
  if (!isNumber(rs.passedCases))
    return fail("runSummary.passedCases must be a number");
  if (!isNumber(rs.failedCases))
    return fail("runSummary.failedCases must be a number");
  if (!isBoolean(rs.allSuitesGreen))
    return fail("runSummary.allSuitesGreen must be a boolean");
  if (!isStringArray(rs.suites))
    return fail("runSummary.suites must be a string array");
  if (!isStringArray(o.publicFiles))
    return fail("publicFiles must be a string array");

  let promptHashRecords: PromptHashRecordShape[] | undefined;
  if (o.promptHashRecords !== undefined) {
    if (!Array.isArray(o.promptHashRecords)) {
      return fail("promptHashRecords must be an array when present");
    }
    const records: PromptHashRecordShape[] = [];
    for (const raw of o.promptHashRecords) {
      if (typeof raw !== "object" || raw === null) {
        return fail("promptHashRecords entries must be objects");
      }
      const r = raw as Record<string, unknown>;
      if (!isString(r.agentName))
        return fail("promptHashRecords[].agentName must be a string");
      if (!isString(r.hash))
        return fail("promptHashRecords[].hash must be a string");
      if (!isNumber(r.byteLength))
        return fail("promptHashRecords[].byteLength must be a number");
      if (!isNumber(r.charLength))
        return fail("promptHashRecords[].charLength must be a number");
      records.push({
        agentName: r.agentName,
        hash: r.hash,
        byteLength: r.byteLength,
        charLength: r.charLength,
      });
    }
    promptHashRecords = records;
  }

  return ok({
    schemaVersion: o.schemaVersion,
    assembledAt: o.assembledAt,
    gitSha: o.gitSha,
    dryRun: o.dryRun,
    runId: o.runId,
    runSummary: {
      totalCases: rs.totalCases,
      passedCases: rs.passedCases,
      failedCases: rs.failedCases,
      allSuitesGreen: rs.allSuitesGreen,
      suites: rs.suites,
    },
    publicFiles: o.publicFiles,
    promptHashRecords,
  });
}

function validateCaseEntry(
  raw: unknown,
  suite: string,
): Result<PublicCaseEntryShape, VerifyEvalRunError> {
  const fail = (message: string) =>
    err<PublicCaseEntryShape, VerifyEvalRunError>({
      type: "SchemaValidationFailed",
      artifact: "public-report.json",
      message: `case in suite "${suite}": ${message}`,
    });
  if (typeof raw !== "object" || raw === null)
    return fail("case entry must be an object");
  const o = raw as Record<string, unknown>;
  if (!isString(o.caseId)) return fail("caseId must be a string");
  if (!isString(o.modelId)) return fail("modelId must be a string");
  if (!isString(o.suite)) return fail("suite must be a string");
  if (!isString(o.scoreBucket)) return fail("scoreBucket must be a string");
  if (!isBoolean(o.passed)) return fail("passed must be a boolean");
  if (!isBoolean(o.required)) return fail("required must be a boolean");
  if (!isBoolean(o.dryRun)) return fail("dryRun must be a boolean");
  if (!isString(o.scoredAt)) return fail("scoredAt must be a string");

  let explanation: { text: string; source: string } | undefined;
  if (o.explanation !== undefined) {
    if (typeof o.explanation !== "object" || o.explanation === null) {
      return fail("explanation must be an object when present");
    }
    const e = o.explanation as Record<string, unknown>;
    if (!isString(e.text)) return fail("explanation.text must be a string");
    if (!isString(e.source)) return fail("explanation.source must be a string");
    explanation = { text: e.text, source: e.source };
  }

  return ok({
    caseId: o.caseId,
    modelId: o.modelId,
    suite: o.suite,
    scoreBucket: o.scoreBucket,
    passed: o.passed,
    required: o.required,
    dryRun: o.dryRun,
    explanation,
    scoredAt: o.scoredAt,
  });
}

function validateSuiteSummary(
  raw: unknown,
): Result<SuiteSummaryShape, VerifyEvalRunError> {
  const fail = (message: string) =>
    err<SuiteSummaryShape, VerifyEvalRunError>({
      type: "SchemaValidationFailed",
      artifact: "public-report.json",
      message,
    });
  if (typeof raw !== "object" || raw === null)
    return fail("suite summary must be an object");
  const o = raw as Record<string, unknown>;
  if (!isNumber(o.schemaVersion))
    return fail("suiteSummary.schemaVersion must be a number");
  if (!isString(o.suite)) return fail("suiteSummary.suite must be a string");
  if (!isString(o.assembledAt))
    return fail("suiteSummary.assembledAt must be a string");
  if (!isString(o.gitSha)) return fail("suiteSummary.gitSha must be a string");
  if (!isNumber(o.totalCases))
    return fail("suiteSummary.totalCases must be a number");
  if (!isNumber(o.passedCases))
    return fail("suiteSummary.passedCases must be a number");
  if (!isNumber(o.failedCases))
    return fail("suiteSummary.failedCases must be a number");
  if (!isBoolean(o.suiteGreen))
    return fail("suiteSummary.suiteGreen must be a boolean");
  if (!Array.isArray(o.cases))
    return fail("suiteSummary.cases must be an array");

  const cases: PublicCaseEntryShape[] = [];
  for (const c of o.cases) {
    const result = validateCaseEntry(c, o.suite);
    if (result.isErr()) return err(result.error);
    cases.push(result.value);
  }

  return ok({
    schemaVersion: o.schemaVersion,
    suite: o.suite,
    assembledAt: o.assembledAt,
    gitSha: o.gitSha,
    totalCases: o.totalCases,
    passedCases: o.passedCases,
    failedCases: o.failedCases,
    suiteGreen: o.suiteGreen,
    cases,
  });
}

function validatePublicReport(
  raw: unknown,
): Result<PublicReportShape, VerifyEvalRunError> {
  const fail = (message: string) =>
    err<PublicReportShape, VerifyEvalRunError>({
      type: "SchemaValidationFailed",
      artifact: "public-report.json",
      message,
    });
  if (typeof raw !== "object" || raw === null) {
    return fail("public-report.json must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (!isNumber(o.schemaVersion)) return fail("schemaVersion must be a number");
  if (!isString(o.assembledAt)) return fail("assembledAt must be a string");
  if (!isString(o.gitSha)) return fail("gitSha must be a string");
  if (!isBoolean(o.dryRun)) return fail("dryRun must be a boolean");
  if (typeof o.runSummary !== "object" || o.runSummary === null) {
    return fail("runSummary must be an object");
  }
  const rs = o.runSummary as Record<string, unknown>;
  if (!isNumber(rs.totalCases))
    return fail("runSummary.totalCases must be a number");
  if (!isNumber(rs.passedCases))
    return fail("runSummary.passedCases must be a number");
  if (!isNumber(rs.failedCases))
    return fail("runSummary.failedCases must be a number");
  if (!isBoolean(rs.allSuitesGreen))
    return fail("runSummary.allSuitesGreen must be a boolean");
  if (!isStringArray(rs.suites))
    return fail("runSummary.suites must be a string array");
  if (!Array.isArray(o.suiteSummaries))
    return fail("suiteSummaries must be an array");

  const suiteSummaries: SuiteSummaryShape[] = [];
  for (const s of o.suiteSummaries) {
    const result = validateSuiteSummary(s);
    if (result.isErr()) return err(result.error);
    suiteSummaries.push(result.value);
  }

  return ok({
    schemaVersion: o.schemaVersion,
    assembledAt: o.assembledAt,
    gitSha: o.gitSha,
    dryRun: o.dryRun,
    runSummary: {
      totalCases: rs.totalCases,
      passedCases: rs.passedCases,
      failedCases: rs.failedCases,
      allSuitesGreen: rs.allSuitesGreen,
      suites: rs.suites,
    },
    suiteSummaries,
  });
}

// ---------------------------------------------------------------------------
// Index artifact shapes (optional; used only when supplied)
// ---------------------------------------------------------------------------

interface DashboardManifestEntryShape {
  runId: string;
  gitSha: string;
  dryRun: boolean;
  totalCases: number;
  passedCases: number;
  allSuitesGreen: boolean;
}

interface SuiteHistoryEntryShape {
  runId: string;
  gitSha: string;
  totalCases: number;
  passedCases: number;
  suiteGreen: boolean;
}

interface ModelComparisonEntryShape {
  modelId: string;
  totalCases: number;
  passedCases: number;
}

function readOptionalObjectArray(
  raw: unknown,
  arrayField: string,
): Record<string, unknown>[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const arr = (raw as Record<string, unknown>)[arrayField];
  if (!Array.isArray(arr)) return undefined;
  return arr.filter(
    (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
  );
}

function toDashboardEntries(
  raw: unknown,
): DashboardManifestEntryShape[] | undefined {
  const entries = readOptionalObjectArray(raw, "runs");
  if (entries === undefined) return undefined;
  const result: DashboardManifestEntryShape[] = [];
  for (const e of entries) {
    if (
      isString(e.runId) &&
      isString(e.gitSha) &&
      isBoolean(e.dryRun) &&
      isNumber(e.totalCases) &&
      isNumber(e.passedCases) &&
      isBoolean(e.allSuitesGreen)
    ) {
      result.push({
        runId: e.runId,
        gitSha: e.gitSha,
        dryRun: e.dryRun,
        totalCases: e.totalCases,
        passedCases: e.passedCases,
        allSuitesGreen: e.allSuitesGreen,
      });
    }
  }
  return result;
}

function toSuiteHistoryEntries(
  raw: unknown,
): SuiteHistoryEntryShape[] | undefined {
  const entries = readOptionalObjectArray(raw, "history");
  if (entries === undefined) return undefined;
  const result: SuiteHistoryEntryShape[] = [];
  for (const e of entries) {
    if (
      isString(e.runId) &&
      isString(e.gitSha) &&
      isNumber(e.totalCases) &&
      isNumber(e.passedCases) &&
      isBoolean(e.suiteGreen)
    ) {
      result.push({
        runId: e.runId,
        gitSha: e.gitSha,
        totalCases: e.totalCases,
        passedCases: e.passedCases,
        suiteGreen: e.suiteGreen,
      });
    }
  }
  return result;
}

function toModelComparisonEntries(
  raw: unknown,
): ModelComparisonEntryShape[] | undefined {
  const entries = readOptionalObjectArray(raw, "models");
  if (entries === undefined) return undefined;
  const result: ModelComparisonEntryShape[] = [];
  for (const e of entries) {
    if (
      isString(e.modelId) &&
      isNumber(e.totalCases) &&
      isNumber(e.passedCases)
    ) {
      result.push({
        modelId: e.modelId,
        totalCases: e.totalCases,
        passedCases: e.passedCases,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scenario history index shape (optional; used only when supplied)
// ---------------------------------------------------------------------------

interface ScenarioRunHistoryEntryShape {
  runId: string;
  totalModels: number;
  passedModels: number;
}

interface ScenarioHistoryEntryShape {
  caseId: string;
  description?: string;
  lastRuns: ScenarioRunHistoryEntryShape[];
}

interface ScenarioHistoryIndexShape {
  suite: string;
  scenarios: ScenarioHistoryEntryShape[];
}

function toScenarioHistoryIndex(
  raw: unknown,
): ScenarioHistoryIndexShape | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (!isString(o.suite)) return undefined;
  if (!Array.isArray(o.scenarios)) return undefined;

  const scenarios: ScenarioHistoryEntryShape[] = [];
  for (const s of o.scenarios) {
    if (typeof s !== "object" || s === null) continue;
    const so = s as Record<string, unknown>;
    if (!isString(so.caseId)) continue;
    if (!Array.isArray(so.lastRuns)) continue;

    const lastRuns: ScenarioRunHistoryEntryShape[] = [];
    for (const r of so.lastRuns) {
      if (typeof r !== "object" || r === null) continue;
      const ro = r as Record<string, unknown>;
      if (
        isString(ro.runId) &&
        isNumber(ro.totalModels) &&
        isNumber(ro.passedModels)
      ) {
        lastRuns.push({
          runId: ro.runId,
          totalModels: ro.totalModels,
          passedModels: ro.passedModels,
        });
      }
    }

    scenarios.push({
      caseId: so.caseId,
      description: isString(so.description) ? so.description : undefined,
      lastRuns,
    });
  }

  return { suite: o.suite, scenarios };
}

// ---------------------------------------------------------------------------
// Prompt hash records — shared shape validation (local file OR remote field)
// ---------------------------------------------------------------------------

/**
 * Parses the internal `prompt-hashes.json` artifact, written by
 * `ArtifactBundleWriter` as `{ promptHashes: BundlePromptHashRecord[] }`.
 */
function parsePromptHashFile(
  raw: string,
): Result<PromptHashRecordShape[], VerifyEvalRunError> {
  return parseJson(raw, "prompt-hashes.json").andThen(
    (json): Result<PromptHashRecordShape[], VerifyEvalRunError> => {
      const fail = (message: string) =>
        err<PromptHashRecordShape[], VerifyEvalRunError>({
          type: "SchemaValidationFailed",
          artifact: "prompt-hashes.json",
          message,
        });
      if (typeof json !== "object" || json === null) {
        return fail("prompt-hashes.json must be a JSON object");
      }
      const arr = (json as Record<string, unknown>).promptHashes;
      if (!Array.isArray(arr)) {
        return fail("prompt-hashes.json must contain a promptHashes array");
      }
      const records: PromptHashRecordShape[] = [];
      for (const entry of arr) {
        if (typeof entry !== "object" || entry === null) {
          return fail("promptHashes entries must be objects");
        }
        const r = entry as Record<string, unknown>;
        if (
          !isString(r.agentName) ||
          !isString(r.hash) ||
          !isNumber(r.byteLength) ||
          !isNumber(r.charLength)
        ) {
          return fail(
            "promptHashes entry is missing agentName/hash/byteLength/charLength",
          );
        }
        records.push({
          agentName: r.agentName,
          hash: r.hash,
          byteLength: r.byteLength,
          charLength: r.charLength,
        });
      }
      return ok(records);
    },
  );
}

/**
 * Validates prompt hash record content: non-blank agent names, well-formed
 * SHA-256 hex hashes, and no duplicate agent names. Shared by both the local
 * `prompt-hashes.json` path and the remote safe-field path.
 */
function validatePromptHashRecords(
  records: PromptHashRecordShape[],
): VerifyEvalRunError[] {
  const errors: VerifyEvalRunError[] = [];
  const seen = new Map<string, number>();

  for (const record of records) {
    if (record.agentName.trim() === "") {
      errors.push({
        type: "InvalidPromptHash",
        agentName: record.agentName,
        reason: "blank",
      });
      continue;
    }
    if (record.hash.trim() === "" || !SHA256_HEX_RE.test(record.hash)) {
      errors.push({
        type: "InvalidPromptHash",
        agentName: record.agentName,
        reason: "malformed",
      });
    }
    seen.set(record.agentName, (seen.get(record.agentName) ?? 0) + 1);
  }

  for (const [agentName, count] of seen) {
    if (count > 1) {
      errors.push({ type: "DuplicatePromptHashAgent", agentName, count });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Injected dependency interfaces
// ---------------------------------------------------------------------------

/** The set of well-known optional derived index artifact file names. */
export type IndexArtifactFileName =
  | "dashboard-manifest.json"
  | `suite-history-${string}.json`
  | `scenario-history-${string}.json`
  | `model-comparison-${string}.json`;

/**
 * Reads a named artifact file for either a local run directory or a remote
 * run ID. Implementations must never leak filesystem/network internals in
 * error messages beyond a bounded diagnostic string.
 */
export interface ArtifactReader {
  /**
   * @param source - Where to read from.
   * @param fileName - `"bundle-index.json"` or `"public-report.json"`.
   * @returns `ok(rawJsonText)` or `err(VerifyEvalRunError)`.
   */
  readArtifact(
    source: RunSource,
    fileName: "bundle-index.json" | "public-report.json",
  ): ResultAsync<string, VerifyEvalRunError>;

  /**
   * Reads an optional derived index artifact (dashboard manifest, suite
   * history, model comparison). Returns `ok(undefined)` when the artifact
   * was not supplied/does not exist — these checks are always non-fatal
   * when the artifact is absent. Only returns `err` for a genuine read
   * failure the caller wants surfaced (rare; most implementations should
   * prefer `ok(undefined)` on any absence).
   */
  readIndexArtifact(
    source: RunSource,
    fileName: IndexArtifactFileName,
  ): ResultAsync<string | undefined, VerifyEvalRunError>;

  /**
   * Reads the internal `prompt-hashes.json` artifact — LOCAL sources only.
   * Implementations MUST return `ok(undefined)` unconditionally for
   * `{ kind: "remote" }` sources without performing any fetch: this file is
   * never published, and this verifier must never attempt to retrieve it
   * from a public location. Returns `ok(undefined)` for a local source when
   * the file does not exist (the caller distinguishes "absent" from
   * "malformed" and reports `PromptHashEvidenceUnavailable` accordingly).
   */
  readPromptHashArtifact(
    source: RunSource,
  ): ResultAsync<string | undefined, VerifyEvalRunError>;
}

/**
 * Resolves source file content at a specific git SHA — used to confirm the
 * presence of the generic-Shuttle scorer branch marker and to derive safe
 * provenance facts (judge model ID, CLI version, locked dependency
 * versions). Never returns full file diffs, secrets, or unrelated content
 * in error messages.
 */
export interface GitSourceReader {
  /**
   * @returns `ok(fileContent)` or `err(VerifyEvalRunError)` (SourceReadError).
   */
  readSourceFile(
    gitSha: string,
    relativePath: string,
  ): ResultAsync<string, VerifyEvalRunError>;

  /**
   * Determine whether `candidateSha` is reachable from (is an ancestor of,
   * or equal to) `expectedHeadSha`. Used to reject stale published SHAs.
   *
   * @returns `ok(true/false)` — never fails; unknown ancestry defaults to
   *          `ok(false)` (fail-closed) so callers surface `StaleGitSha`.
   */
  isAncestorOrEqual(
    candidateSha: string,
    expectedHeadSha: string,
  ): ResultAsync<boolean, never>;
}

/**
 * Supplies expected suite/case/model completeness data so the verifier can
 * detect missing case×model rows, missing model rows, and duplicates.
 *
 * Both methods return `undefined` to skip the corresponding completeness
 * check for a suite (e.g. when the caller has no static expectation for it).
 * `tapestry-category-routing`'s `tcr-04`/`tcr-10` requirement is enforced
 * unconditionally regardless of this provider.
 */
export interface SuiteExpectationsProvider {
  /** Expected case IDs for `suite`, or `undefined` to skip the check. */
  expectedCaseIds(suite: string): string[] | undefined;
  /** Expected model IDs for `suite`, or `undefined` to skip the check. */
  expectedModelIds(suite: string): string[] | undefined;
}

/** Local run directory or remote run ID. */
export type RunSource =
  | { kind: "local"; dir: string }
  | { kind: "remote"; runId: string };

// ---------------------------------------------------------------------------
// Default production implementations (not used by tests)
// ---------------------------------------------------------------------------

/** Default `ArtifactReader` — reads local files via `Bun.file`, remote via `fetch`. */
export class DefaultArtifactReader implements ArtifactReader {
  constructor(
    private readonly remoteRunsBaseUrl = "https://raw.githubusercontent.com/weave-io/weave-agent-evals/main/runs/v1",
    private readonly remoteIndexesBaseUrl = "https://raw.githubusercontent.com/weave-io/weave-agent-evals/main/indexes/v1",
    private readonly fetchImpl: (url: string) => Promise<Response> = (url) =>
      fetch(url),
  ) {}

  readArtifact(
    source: RunSource,
    fileName: "bundle-index.json" | "public-report.json",
  ): ResultAsync<string, VerifyEvalRunError> {
    if (source.kind === "local") {
      const path = join(source.dir, fileName);
      return ResultAsync.fromPromise(
        Bun.file(path).text(),
        (cause): VerifyEvalRunError => ({
          type: "FileReadError",
          path,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    const url = `${this.remoteRunsBaseUrl}/${source.runId}/${fileName}`;
    return this.fetchText(url);
  }

  readIndexArtifact(
    source: RunSource,
    fileName: IndexArtifactFileName,
  ): ResultAsync<string | undefined, VerifyEvalRunError> {
    if (source.kind === "local") {
      const path = join(source.dir, "..", "..", "indexes", fileName);
      const readOrUndefined = Bun.file(path)
        .text()
        .then(
          (text): string | undefined => text,
          (): string | undefined => undefined,
        );
      return ResultAsync.fromSafePromise(readOrUndefined);
    }

    const url = `${this.remoteIndexesBaseUrl}/${fileName}`;
    const textOrUndefined: Promise<string | undefined> = this.fetchText(
      url,
    ).match(
      (value) => value,
      () => undefined,
    );
    return ResultAsync.fromSafePromise(textOrUndefined);
  }

  readPromptHashArtifact(
    source: RunSource,
  ): ResultAsync<string | undefined, VerifyEvalRunError> {
    // Remote sources MUST NEVER fetch this internal, unpublished artifact.
    if (source.kind === "remote") {
      return ResultAsync.fromSafePromise(Promise.resolve(undefined));
    }
    const path = join(source.dir, "prompt-hashes.json");
    const readOrUndefined = Bun.file(path)
      .text()
      .then(
        (text): string | undefined => text,
        (): string | undefined => undefined,
      );
    return ResultAsync.fromSafePromise(readOrUndefined);
  }

  private fetchText(url: string): ResultAsync<string, VerifyEvalRunError> {
    return ResultAsync.fromPromise(
      this.fetchImpl(url),
      (cause): VerifyEvalRunError => ({
        type: "FetchNetworkError",
        path: url,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    ).andThen((response) => {
      if (!response.ok) {
        return new ResultAsync(
          Promise.resolve(
            err<string, VerifyEvalRunError>({
              type: "FetchHttpError",
              path: url,
              status: response.status,
              message: `HTTP ${response.status} fetching ${url}`,
            }),
          ),
        );
      }
      return ResultAsync.fromPromise(
        response.text(),
        (cause): VerifyEvalRunError => ({
          type: "FetchNetworkError",
          path: url,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    });
  }
}

/** Default `SuiteExpectationsProvider` — no expectations (all checks skipped except TCR). */
export const NO_SUITE_EXPECTATIONS: SuiteExpectationsProvider = {
  expectedCaseIds: () => undefined,
  expectedModelIds: () => undefined,
};

/**
 * Builds a `SuiteExpectationsProvider` backed by the real eval fixture
 * files (`evals/cases/<suite>/*.json`) and the real model matrix
 * (`evals/model-matrix.json`), via the existing `@weaveio/weave-cli` loaders.
 *
 * Every registered suite's case IDs are loaded from disk, and the model
 * matrix's `default: true` models are used as the expected model set for
 * every suite (all suites currently fan out across the same default model
 * set — see `EvalRunner`). This is the provider production callers (the CLI
 * entrypoint below) must use instead of `NO_SUITE_EXPECTATIONS`, so that
 * case/model completeness is actually enforced against real fixtures.
 */
export function buildProductionSuiteExpectationsProvider(): ResultAsync<
  SuiteExpectationsProvider,
  VerifyEvalRunError[]
> {
  const toVerifyError = (cause: { message: string }): VerifyEvalRunError[] => [
    { type: "SuiteExpectationsLoadError", message: cause.message },
  ];

  const modelIdsLoad = loadModelMatrix()
    .mapErr(toVerifyError)
    .map((matrix) => resolveDefaultModels(matrix).map((m) => m.id));

  const caseIdsLoad = ResultAsync.combine(
    EVAL_SUITE_IDS.map((suite) =>
      loadSuiteCases(suite)
        .mapErr(toVerifyError)
        .map((cases) => [suite, cases.map((c) => c.id)] as const),
    ),
  ).map((entries) => new Map(entries));

  return ResultAsync.combine([modelIdsLoad, caseIdsLoad]).map(
    ([modelIds, caseIdsBySuite]): SuiteExpectationsProvider => ({
      expectedCaseIds: (suite) => caseIdsBySuite.get(suite),
      expectedModelIds: () => modelIds,
    }),
  );
}

// ---------------------------------------------------------------------------
// Verification report
// ---------------------------------------------------------------------------

export interface DerivedProvenance {
  scorerAdapterModule: string;
  judgeModelId: string;
  cliPackageVersion: string;
  lockedDependencyVersions: Readonly<Record<string, string>>;
}

/**
 * Trustworthy-but-bounded prompt hash evidence result. `"verified"` means
 * either the local `prompt-hashes.json` artifact, or (remote-only) an
 * already-publishable safe commitment field, was present and well-formed.
 * `"unavailable"` is only reachable for remote sources without a safe
 * field — callers MUST NOT treat an `"unavailable"` result as equivalent to
 * `"verified"` full provenance.
 */
export type PromptHashEvidence =
  | { status: "verified"; source: "local" | "remote"; agentCount: number }
  | {
      status: "unavailable";
      source: "remote";
      reason: "no_safe_remote_field";
    };

export interface VerifyReport {
  runId: string;
  gitSha: string;
  dryRun: boolean;
  suites: string[];
  totalCases: number;
  passedCases: number;
  failedCases: number;
  allSuitesGreen: boolean;
  provenance: DerivedProvenance;
  promptHashEvidence: PromptHashEvidence;
}

// ---------------------------------------------------------------------------
// Provenance derivation (from source at gitSha — never hardcoded)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/**
 * Parse the judge model ID from `packages/cli/src/commands/eval.ts` source
 * text. Looks for `JUDGE_MODEL_ID = "<slug>"` (single/double/backtick quotes).
 */
export function parseJudgeModelId(
  sourceText: string,
): Result<string, VerifyEvalRunError> {
  const match = /JUDGE_MODEL_ID\s*=\s*["'`]([^"'`]+)["'`]/.exec(sourceText);
  if (match === null || match[1] === undefined) {
    return err({
      type: "ProvenanceSourceParseError",
      path: EVAL_COMMAND_PATH,
      message: "JUDGE_MODEL_ID constant not found in eval command source",
    });
  }
  return ok(match[1]);
}

/**
 * Parse the CLI package version from `packages/cli/package.json` source text.
 */
export function parseCliPackageVersion(
  sourceText: string,
): Result<string, VerifyEvalRunError> {
  return parseJson(sourceText, CLI_PACKAGE_JSON_PATH).andThen(
    (raw): Result<string, VerifyEvalRunError> => {
      if (typeof raw !== "object" || raw === null) {
        return err({
          type: "ProvenanceSourceParseError",
          path: CLI_PACKAGE_JSON_PATH,
          message: "package.json did not parse to an object",
        });
      }
      const version = (raw as Record<string, unknown>).version;
      if (typeof version !== "string" || version.length === 0) {
        return err({
          type: "ProvenanceSourceParseError",
          path: CLI_PACKAGE_JSON_PATH,
          message: "package.json is missing a string version field",
        });
      }
      return ok(version);
    },
  );
}

/**
 * Parse locked dependency versions for `LOCKED_DEPENDENCY_NAMES` from a
 * `bun.lock` source text using the `"<name>": ["<name>@<version>"` pattern.
 */
export function parseLockedDependencyVersions(
  sourceText: string,
): Result<Record<string, string>, VerifyEvalRunError> {
  const versions: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of LOCKED_DEPENDENCY_NAMES) {
    const escaped = escapeRegExp(name);
    const pattern = new RegExp(`"${escaped}":\\s*\\[\\s*"${escaped}@([^"]+)"`);
    const match = pattern.exec(sourceText);
    if (match === undefined || match === null || match[1] === undefined) {
      missing.push(name);
      continue;
    }
    versions[name] = match[1];
  }
  if (missing.length > 0) {
    return err({
      type: "ProvenanceSourceParseError",
      path: ROOT_LOCKFILE_PATH,
      message: `Could not resolve locked version(s) for: ${missing.join(", ")}`,
    });
  }
  return ok(versions);
}

/**
 * Derive `DerivedProvenance` by reading `EVAL_COMMAND_PATH`,
 * `CLI_PACKAGE_JSON_PATH`, and `ROOT_LOCKFILE_PATH` source text at `gitSha`
 * through the injected `GitSourceReader`. Every value is sourced from the
 * commit that actually produced the run — never from the local machine's
 * currently-installed dependencies or environment.
 */
export function deriveProvenance(
  gitSha: string,
  gitSourceReader: GitSourceReader,
): ResultAsync<DerivedProvenance, VerifyEvalRunError[]> {
  return ResultAsync.combine([
    gitSourceReader
      .readSourceFile(gitSha, EVAL_COMMAND_PATH)
      .mapErr((e) => [e]),
    gitSourceReader
      .readSourceFile(gitSha, CLI_PACKAGE_JSON_PATH)
      .mapErr((e) => [e]),
    gitSourceReader
      .readSourceFile(gitSha, ROOT_LOCKFILE_PATH)
      .mapErr((e) => [e]),
  ]).andThen(([evalCommandSource, cliPackageJsonSource, lockfileSource]) => {
    const judgeModelId = parseJudgeModelId(evalCommandSource);
    if (judgeModelId.isErr()) return err([judgeModelId.error]);

    const cliPackageVersion = parseCliPackageVersion(cliPackageJsonSource);
    if (cliPackageVersion.isErr()) return err([cliPackageVersion.error]);

    const lockedDependencyVersions =
      parseLockedDependencyVersions(lockfileSource);
    if (lockedDependencyVersions.isErr())
      return err([lockedDependencyVersions.error]);

    return ok({
      scorerAdapterModule: SCORER_ADAPTER_MODULE,
      judgeModelId: judgeModelId.value,
      cliPackageVersion: cliPackageVersion.value,
      lockedDependencyVersions: lockedDependencyVersions.value,
    });
  });
}

// ---------------------------------------------------------------------------
// EvalRunVerifier
// ---------------------------------------------------------------------------

export interface EvalRunVerifierOptions {
  artifactReader: ArtifactReader;
  gitSourceReader: GitSourceReader;
  /**
   * Supplies expected suite/case/model completeness data. Defaults to
   * `NO_SUITE_EXPECTATIONS` (only the always-on TCR 04/10 check applies).
   */
  suiteExpectationsProvider?: SuiteExpectationsProvider;
  /**
   * Expected HEAD SHA to validate `gitSha` freshness against.
   * When omitted, the stale-SHA check is skipped (no `expectedHead` to compare).
   */
  expectedHeadSha?: string;
  /**
   * Restricts required completeness checks (suite presence, TCR 04/10,
   * case×model expectations, zero-case rejection) to the named suites.
   * Suites present in the report but outside this filter are ignored
   * entirely — their absence or defects are never reported. When omitted,
   * all suites declared in `bundle-index.json`'s `runSummary.suites` are
   * required, matching prior (unfiltered) behavior.
   */
  suiteFilter?: string[];
  /**
   * Controls whether missing optional derived index artifacts (dashboard
   * manifest, suite history, scenario history, model comparison) are
   * treated as fatal (`MissingIndexArtifact`) or silently skipped.
   *
   *   - `"required"` — always fatal when an index artifact is absent.
   *   - `"optional"` — never fatal; absence is always silently skipped.
   *   - `"auto"` (default) — fatal for `{ kind: "remote" }` sources (a
   *     published run is expected to have rebuilt indexes), silently
   *     skipped for `{ kind: "local" }` sources (a local run directory
   *     commonly has no sibling `indexes/` directory during development).
   */
  indexArtifactPolicy?: "required" | "optional" | "auto";
}

/**
 * Verifies a single eval run's published artifacts for structural integrity,
 * run-identity agreement, completeness, source provenance, and (optionally)
 * derived index agreement — all through injected dependencies so no real
 * I/O occurs unless a caller supplies production implementations.
 */
export class EvalRunVerifier {
  constructor(private readonly options: EvalRunVerifierOptions) {}

  verifyRun(
    source: RunSource,
  ): ResultAsync<VerifyReport, VerifyEvalRunError[]> {
    const { artifactReader } = this.options;

    return ResultAsync.combine([
      artifactReader
        .readArtifact(source, "bundle-index.json")
        .mapErr((e) => [e]),
      artifactReader
        .readArtifact(source, "public-report.json")
        .mapErr((e) => [e]),
    ]).andThen(([indexRaw, reportRaw]) => {
      const parsedResult = this.parseAndValidate(indexRaw, reportRaw);
      if (parsedResult.isErr()) {
        return new ResultAsync(Promise.resolve(err(parsedResult.error)));
      }
      const { index, report } = parsedResult.value;

      const scopedSuites = this.scopedSuiteNames(index, report);

      const structuralErrors = this.checkStructural(
        index,
        report,
        scopedSuites,
      );
      if (structuralErrors.length > 0) {
        return new ResultAsync(Promise.resolve(err(structuralErrors)));
      }

      return this.checkSourceProvenance(index.gitSha, report, scopedSuites)
        .andThen(() =>
          this.checkIndexAgreement(source, index, report, scopedSuites),
        )
        .andThen(() => this.checkPromptHashEvidence(source, index))
        .andThen((promptHashEvidence) =>
          deriveProvenance(index.gitSha, this.options.gitSourceReader).map(
            (provenance): VerifyReport => ({
              runId: index.runId,
              gitSha: index.gitSha,
              dryRun: index.dryRun,
              suites: index.runSummary.suites,
              totalCases: index.runSummary.totalCases,
              passedCases: index.runSummary.passedCases,
              failedCases: index.runSummary.failedCases,
              allSuitesGreen: index.runSummary.allSuitesGreen,
              provenance,
              promptHashEvidence,
            }),
          ),
        );
    });
  }

  // -------------------------------------------------------------------------
  // Suite scoping
  // -------------------------------------------------------------------------

  /**
   * The set of suite names that required checks apply to: the caller's
   * `suiteFilter` when supplied, otherwise every suite declared in
   * `bundle-index.json`.
   */
  private scopedSuiteNames(
    index: BundleIndexShape,
    _report: PublicReportShape,
  ): Set<string> {
    if (this.options.suiteFilter !== undefined) {
      return new Set(this.options.suiteFilter);
    }
    return new Set(index.runSummary.suites);
  }

  // -------------------------------------------------------------------------
  // Parsing + schema validation
  // -------------------------------------------------------------------------

  private parseAndValidate(
    indexRaw: string,
    reportRaw: string,
  ): Result<
    { index: BundleIndexShape; report: PublicReportShape },
    VerifyEvalRunError[]
  > {
    const indexJson = parseJson(indexRaw, "bundle-index.json");
    if (indexJson.isErr()) return err([indexJson.error]);

    const reportJson = parseJson(reportRaw, "public-report.json");
    if (reportJson.isErr()) return err([reportJson.error]);

    const index = validateBundleIndex(indexJson.value);
    if (index.isErr()) return err([index.error]);

    const report = validatePublicReport(reportJson.value);
    if (report.isErr()) return err([report.error]);

    const errors: VerifyEvalRunError[] = [];
    if (index.value.schemaVersion !== EXPECTED_BUNDLE_INDEX_SCHEMA_VERSION) {
      errors.push({
        type: "SchemaVersionIncompatible",
        artifact: "bundle-index.json",
        found: index.value.schemaVersion,
        expected: EXPECTED_BUNDLE_INDEX_SCHEMA_VERSION,
      });
    }
    if (report.value.schemaVersion !== EXPECTED_PUBLIC_REPORT_SCHEMA_VERSION) {
      errors.push({
        type: "SchemaVersionIncompatible",
        artifact: "public-report.json",
        found: report.value.schemaVersion,
        expected: EXPECTED_PUBLIC_REPORT_SCHEMA_VERSION,
      });
    }
    if (errors.length > 0) return err(errors);

    return ok({ index: index.value, report: report.value });
  }

  // -------------------------------------------------------------------------
  // Explanation validation (missing / blank / too-long / bad source)
  // -------------------------------------------------------------------------

  private validateExplanation(
    c: PublicCaseEntryShape,
    suite: string,
  ): VerifyEvalRunError | undefined {
    if (c.explanation === undefined) {
      return {
        type: "BlankExplanation",
        suite,
        caseId: c.caseId,
        modelId: c.modelId,
        reason: "missing",
      };
    }
    if (c.explanation.text.trim() === "") {
      return {
        type: "BlankExplanation",
        suite,
        caseId: c.caseId,
        modelId: c.modelId,
        reason: "blank",
      };
    }
    if (c.explanation.text.length > EXPLANATION_MAX_CHARS) {
      return {
        type: "BlankExplanation",
        suite,
        caseId: c.caseId,
        modelId: c.modelId,
        reason: "too_long",
      };
    }
    if (!ALLOWED_EXPLANATION_SOURCES.has(c.explanation.source)) {
      return {
        type: "BlankExplanation",
        suite,
        caseId: c.caseId,
        modelId: c.modelId,
        reason: "invalid_source",
      };
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Suite/case/model completeness against injected expectations
  // -------------------------------------------------------------------------

  private checkSuiteCompleteness(
    suite: SuiteSummaryShape,
  ): VerifyEvalRunError[] {
    const errors: VerifyEvalRunError[] = [];
    const provider =
      this.options.suiteExpectationsProvider ?? NO_SUITE_EXPECTATIONS;

    // Suite/case name agreement: every case's `suite` field must match the
    // enclosing suite summary's name.
    for (const c of suite.cases) {
      if (c.suite !== suite.suite) {
        errors.push({
          type: "SuiteNameMismatch",
          expectedSuite: suite.suite,
          foundSuite: c.suite,
          caseId: c.caseId,
        });
      }
    }

    // Duplicate case×model rows.
    const rowCounts = new Map<string, number>();
    for (const c of suite.cases) {
      const key = `${c.caseId}::${c.modelId}`;
      rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of rowCounts) {
      if (count > 1) {
        const [caseId, modelId] = key.split("::");
        errors.push({
          type: "DuplicateCaseModelRow",
          suite: suite.suite,
          caseId: caseId ?? "",
          modelId: modelId ?? "",
          count,
        });
      }
    }

    // Always-on TCR 04/10 requirement (independent of expectations provider).
    if (suite.suite === CATEGORY_ROUTING_SUITE) {
      const presentCaseIds = new Set(suite.cases.map((c) => c.caseId));
      for (const requiredCaseId of REQUIRED_CATEGORY_ROUTING_CASES) {
        if (!presentCaseIds.has(requiredCaseId)) {
          errors.push({
            type: "MissingCase",
            suite: suite.suite,
            caseId: requiredCaseId,
          });
        }
      }
    }

    // Injected expectations: expected case IDs and model IDs.
    const expectedCaseIds = provider.expectedCaseIds(suite.suite);
    const expectedModelIds = provider.expectedModelIds(suite.suite);

    if (expectedModelIds !== undefined) {
      const presentModelIds = new Set(suite.cases.map((c) => c.modelId));
      for (const modelId of expectedModelIds) {
        if (!presentModelIds.has(modelId)) {
          errors.push({
            type: "MissingModelRow",
            suite: suite.suite,
            modelId,
          });
        }
      }
    }

    if (expectedCaseIds !== undefined) {
      const presentCaseIds = new Set(suite.cases.map((c) => c.caseId));
      for (const caseId of expectedCaseIds) {
        if (!presentCaseIds.has(caseId)) {
          errors.push({
            type: "MissingCase",
            suite: suite.suite,
            caseId,
          });
        }
      }

      if (expectedModelIds !== undefined) {
        const presentCombos = new Set(
          suite.cases.map((c) => `${c.caseId}::${c.modelId}`),
        );
        for (const caseId of expectedCaseIds) {
          for (const modelId of expectedModelIds) {
            if (!presentCombos.has(`${caseId}::${modelId}`)) {
              errors.push({
                type: "MissingCaseModelCombo",
                suite: suite.suite,
                caseId,
                modelId,
              });
            }
          }
        }

        const expectedCount = expectedCaseIds.length * expectedModelIds.length;
        if (expectedCount !== suite.cases.length) {
          errors.push({
            type: "SuiteCaseCountMismatch",
            suite: suite.suite,
            expected: expectedCount,
            actual: suite.cases.length,
          });
        }
      }
    }

    return errors;
  }

  // -------------------------------------------------------------------------
  // Structural / completeness / agreement checks
  // -------------------------------------------------------------------------

  private checkStructural(
    index: BundleIndexShape,
    report: PublicReportShape,
    scopedSuites: Set<string>,
  ): VerifyEvalRunError[] {
    const errors: VerifyEvalRunError[] = [];

    // Index/report run-identity agreement (whole-run scope; not suite-filtered
    // — these fields describe the immutable run artifacts as a whole).
    if (index.gitSha !== report.gitSha) {
      errors.push({
        type: "IndexRunMismatch",
        field: "gitSha",
        indexValue: index.gitSha,
        reportValue: report.gitSha,
      });
    }
    if (index.dryRun !== report.dryRun) {
      errors.push({
        type: "IndexRunMismatch",
        field: "dryRun",
        indexValue: String(index.dryRun),
        reportValue: String(report.dryRun),
      });
    }
    if (index.runSummary.totalCases !== report.runSummary.totalCases) {
      errors.push({
        type: "IndexRunMismatch",
        field: "runSummary.totalCases",
        indexValue: String(index.runSummary.totalCases),
        reportValue: String(report.runSummary.totalCases),
      });
    }
    if (index.runSummary.passedCases !== report.runSummary.passedCases) {
      errors.push({
        type: "IndexRunMismatch",
        field: "runSummary.passedCases",
        indexValue: String(index.runSummary.passedCases),
        reportValue: String(report.runSummary.passedCases),
      });
    }
    if (index.runSummary.allSuitesGreen !== report.runSummary.allSuitesGreen) {
      errors.push({
        type: "IndexRunMismatch",
        field: "runSummary.allSuitesGreen",
        indexValue: String(index.runSummary.allSuitesGreen),
        reportValue: String(report.runSummary.allSuitesGreen),
      });
    }
    const indexSuites = [...index.runSummary.suites].sort();
    const reportSuites = [...report.runSummary.suites].sort();
    if (JSON.stringify(indexSuites) !== JSON.stringify(reportSuites)) {
      errors.push({
        type: "IndexRunMismatch",
        field: "runSummary.suites",
        indexValue: indexSuites.join(","),
        reportValue: reportSuites.join(","),
      });
    }

    // Stale SHA shape pre-check (the reachability check itself is async —
    // see checkSourceProvenance).
    if (this.options.expectedHeadSha !== undefined) {
      if (!FULL_SHA_RE.test(index.gitSha) && index.gitSha !== "unknown") {
        errors.push({
          type: "SchemaValidationFailed",
          artifact: "bundle-index.json",
          message: `gitSha "${index.gitSha}" is not a valid 40-char hex SHA`,
        });
      }
    }

    // Suite completeness — scoped to the suite filter (or all declared
    // suites when no filter is given).
    for (const suite of report.suiteSummaries) {
      if (!scopedSuites.has(suite.suite)) continue;

      if (suite.totalCases === 0 || suite.cases.length === 0) {
        errors.push({ type: "ZeroCases", suite: suite.suite });
        continue;
      }

      errors.push(...this.checkSuiteCompleteness(suite));

      for (const c of suite.cases) {
        const explanationError = this.validateExplanation(c, suite.suite);
        if (explanationError !== undefined) errors.push(explanationError);
      }
    }

    // Missing suite: a required (scoped) suite has no summary in the report.
    const reportSuiteNames = new Set(report.suiteSummaries.map((s) => s.suite));
    for (const suiteName of scopedSuites) {
      if (!reportSuiteNames.has(suiteName)) {
        errors.push({ type: "MissingSuite", suite: suiteName });
      }
    }

    return errors;
  }

  // -------------------------------------------------------------------------
  // Prompt hash evidence (local prompt-hashes.json OR remote safe field)
  // -------------------------------------------------------------------------

  /**
   * Verifies prompt hash evidence per the local/remote contract:
   *
   *   - Local: `prompt-hashes.json` MUST be present and well-formed —
   *     absence or empty content is a fatal `PromptHashEvidenceUnavailable`.
   *   - Remote: `prompt-hashes.json` is NEVER fetched. An already-safe
   *     `promptHashRecords` field on `bundle-index.json` is validated when
   *     present; when absent this is non-fatal — the returned
   *     `PromptHashEvidence` is `"unavailable"` and the caller must not
   *     treat the run as having full provenance.
   */
  private checkPromptHashEvidence(
    source: RunSource,
    index: BundleIndexShape,
  ): ResultAsync<PromptHashEvidence, VerifyEvalRunError[]> {
    return this.options.artifactReader
      .readPromptHashArtifact(source)
      .mapErr((e) => [e])
      .andThen((raw): ResultAsync<PromptHashEvidence, VerifyEvalRunError[]> => {
        if (source.kind === "remote") {
          return this.checkRemotePromptHashSafeField(index);
        }

        if (raw === undefined) {
          return new ResultAsync(
            Promise.resolve(
              err([
                {
                  type: "PromptHashEvidenceUnavailable" as const,
                  source: "local" as const,
                  reason: "missing_local_artifact" as const,
                },
              ]),
            ),
          );
        }

        const parsed = parsePromptHashFile(raw);
        if (parsed.isErr()) {
          return new ResultAsync(Promise.resolve(err([parsed.error])));
        }
        if (parsed.value.length === 0) {
          return new ResultAsync(
            Promise.resolve(
              err([
                {
                  type: "PromptHashEvidenceUnavailable" as const,
                  source: "local" as const,
                  reason: "empty_local_artifact" as const,
                },
              ]),
            ),
          );
        }
        const validationErrors = validatePromptHashRecords(parsed.value);
        if (validationErrors.length > 0) {
          return new ResultAsync(Promise.resolve(err(validationErrors)));
        }
        return ResultAsync.fromSafePromise(
          Promise.resolve<PromptHashEvidence>({
            status: "verified",
            source: "local",
            agentCount: parsed.value.length,
          }),
        );
      });
  }

  private checkRemotePromptHashSafeField(
    index: BundleIndexShape,
  ): ResultAsync<PromptHashEvidence, VerifyEvalRunError[]> {
    if (index.promptHashRecords === undefined) {
      return ResultAsync.fromSafePromise(
        Promise.resolve<PromptHashEvidence>({
          status: "unavailable",
          source: "remote",
          reason: "no_safe_remote_field",
        }),
      );
    }
    const validationErrors = validatePromptHashRecords(index.promptHashRecords);
    if (validationErrors.length > 0) {
      return new ResultAsync(Promise.resolve(err(validationErrors)));
    }
    return ResultAsync.fromSafePromise(
      Promise.resolve<PromptHashEvidence>({
        status: "verified",
        source: "remote",
        agentCount: index.promptHashRecords.length,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Source provenance: stale SHA + generic-Shuttle scorer branch presence
  // -------------------------------------------------------------------------

  private checkSourceProvenance(
    gitSha: string,
    report: PublicReportShape,
    scopedSuites: Set<string>,
  ): ResultAsync<void, VerifyEvalRunError[]> {
    const { expectedHeadSha, gitSourceReader } = this.options;

    const staleCheck: ResultAsync<void, VerifyEvalRunError[]> =
      expectedHeadSha === undefined
        ? ResultAsync.fromSafePromise(Promise.resolve(undefined))
        : gitSourceReader
            .isAncestorOrEqual(gitSha, expectedHeadSha)
            .andThen((isAncestor) => {
              if (!isAncestor) {
                return new ResultAsync<void, VerifyEvalRunError[]>(
                  Promise.resolve(
                    err([
                      {
                        type: "StaleGitSha" as const,
                        found: gitSha,
                        expectedHead: expectedHeadSha,
                      },
                    ]),
                  ),
                );
              }
              return ResultAsync.fromSafePromise(Promise.resolve(undefined));
            });

    const hasCategoryRoutingSuite =
      scopedSuites.has(CATEGORY_ROUTING_SUITE) &&
      report.suiteSummaries.some((s) => s.suite === CATEGORY_ROUTING_SUITE);

    const branchCheck: ResultAsync<void, VerifyEvalRunError[]> =
      !hasCategoryRoutingSuite
        ? ResultAsync.fromSafePromise(Promise.resolve(undefined))
        : gitSourceReader
            .readSourceFile(gitSha, CATEGORY_ROUTING_RUNNER_PATH)
            .mapErr((e) => [e])
            .andThen((content) => {
              if (!content.includes(GENERIC_SHUTTLE_SCORER_MARKER)) {
                return new ResultAsync<void, VerifyEvalRunError[]>(
                  Promise.resolve(
                    err([
                      {
                        type: "ScorerBranchMissing" as const,
                        path: CATEGORY_ROUTING_RUNNER_PATH,
                        gitSha,
                        marker: GENERIC_SHUTTLE_SCORER_MARKER,
                      },
                    ]),
                  ),
                );
              }
              return ResultAsync.fromSafePromise(Promise.resolve(undefined));
            });

    return ResultAsync.combine([staleCheck, branchCheck]).map(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Optional derived index artifact agreement
  // -------------------------------------------------------------------------

  private checkIndexAgreement(
    source: RunSource,
    index: BundleIndexShape,
    report: PublicReportShape,
    scopedSuites: Set<string>,
  ): ResultAsync<void, VerifyEvalRunError[]> {
    const { artifactReader } = this.options;
    const policy = this.options.indexArtifactPolicy ?? "auto";
    const indexArtifactsRequired =
      policy === "required" || (policy === "auto" && source.kind === "remote");

    const missingIndexError = (fileName: string): VerifyEvalRunError[] => [
      {
        type: "MissingIndexArtifact",
        source: source.kind,
        fileName,
      },
    ];

    const dashboardCheck = artifactReader
      .readIndexArtifact(source, "dashboard-manifest.json")
      .mapErr((e) => [e])
      .andThen((raw) => {
        if (raw === undefined) {
          if (indexArtifactsRequired) {
            return new ResultAsync<void, VerifyEvalRunError[]>(
              Promise.resolve(
                err(missingIndexError("dashboard-manifest.json")),
              ),
            );
          }
          return ResultAsync.fromSafePromise<void, VerifyEvalRunError[]>(
            Promise.resolve(undefined),
          );
        }
        return this.verifyDashboardManifest(raw, index);
      });

    const suiteHistoryChecks = report.suiteSummaries
      .filter((s) => scopedSuites.has(s.suite))
      .map((suiteSummary) =>
        artifactReader
          .readIndexArtifact(source, `suite-history-${suiteSummary.suite}.json`)
          .mapErr((e) => [e])
          .andThen((raw) => {
            if (raw === undefined) {
              if (indexArtifactsRequired) {
                return new ResultAsync<void, VerifyEvalRunError[]>(
                  Promise.resolve(
                    err(
                      missingIndexError(
                        `suite-history-${suiteSummary.suite}.json`,
                      ),
                    ),
                  ),
                );
              }
              return ResultAsync.fromSafePromise<void, VerifyEvalRunError[]>(
                Promise.resolve(undefined),
              );
            }
            return this.verifySuiteHistory(raw, index.runId, suiteSummary);
          }),
      );

    const scenarioHistoryChecks = report.suiteSummaries
      .filter((s) => scopedSuites.has(s.suite))
      .map((suiteSummary) =>
        artifactReader
          .readIndexArtifact(
            source,
            `scenario-history-${suiteSummary.suite}.json`,
          )
          .mapErr((e) => [e])
          .andThen((raw) => {
            if (raw === undefined) {
              if (indexArtifactsRequired) {
                return new ResultAsync<void, VerifyEvalRunError[]>(
                  Promise.resolve(
                    err(
                      missingIndexError(
                        `scenario-history-${suiteSummary.suite}.json`,
                      ),
                    ),
                  ),
                );
              }
              return ResultAsync.fromSafePromise<void, VerifyEvalRunError[]>(
                Promise.resolve(undefined),
              );
            }
            return this.verifyScenarioHistory(raw, index.runId, suiteSummary);
          }),
      );

    const modelComparisonCheck = artifactReader
      .readIndexArtifact(source, `model-comparison-${index.runId}.json`)
      .mapErr((e) => [e])
      .andThen((raw) => {
        if (raw === undefined) {
          if (indexArtifactsRequired) {
            return new ResultAsync<void, VerifyEvalRunError[]>(
              Promise.resolve(
                err(missingIndexError(`model-comparison-${index.runId}.json`)),
              ),
            );
          }
          return ResultAsync.fromSafePromise<void, VerifyEvalRunError[]>(
            Promise.resolve(undefined),
          );
        }
        return this.verifyModelComparison(raw, report, scopedSuites);
      });

    return ResultAsync.combine([
      dashboardCheck,
      ...suiteHistoryChecks,
      ...scenarioHistoryChecks,
      modelComparisonCheck,
    ]).map(() => undefined);
  }

  private verifyDashboardManifest(
    raw: string,
    index: BundleIndexShape,
  ): ResultAsync<void, VerifyEvalRunError[]> {
    const parsedJson = parseJson(raw, "dashboard-manifest.json");
    if (parsedJson.isErr()) {
      return new ResultAsync(Promise.resolve(err([parsedJson.error])));
    }
    const entries = toDashboardEntries(parsedJson.value);
    if (entries === undefined) {
      return new ResultAsync(
        Promise.resolve(
          err([
            {
              type: "SchemaValidationFailed" as const,
              artifact: "dashboard-manifest.json",
              message: "dashboard-manifest.json is missing a valid runs array",
            },
          ]),
        ),
      );
    }
    const entry = entries.find((e) => e.runId === index.runId);
    if (entry === undefined) {
      return new ResultAsync(
        Promise.resolve(
          err([{ type: "DashboardEntryMissing" as const, runId: index.runId }]),
        ),
      );
    }

    const errors: VerifyEvalRunError[] = [];
    if (entry.gitSha !== index.gitSha) {
      errors.push({
        type: "DashboardEntryMismatch",
        field: "gitSha",
        indexValue: index.gitSha,
        dashboardValue: entry.gitSha,
      });
    }
    if (entry.dryRun !== index.dryRun) {
      errors.push({
        type: "DashboardEntryMismatch",
        field: "dryRun",
        indexValue: String(index.dryRun),
        dashboardValue: String(entry.dryRun),
      });
    }
    if (entry.totalCases !== index.runSummary.totalCases) {
      errors.push({
        type: "DashboardEntryMismatch",
        field: "totalCases",
        indexValue: String(index.runSummary.totalCases),
        dashboardValue: String(entry.totalCases),
      });
    }
    if (entry.passedCases !== index.runSummary.passedCases) {
      errors.push({
        type: "DashboardEntryMismatch",
        field: "passedCases",
        indexValue: String(index.runSummary.passedCases),
        dashboardValue: String(entry.passedCases),
      });
    }
    if (entry.allSuitesGreen !== index.runSummary.allSuitesGreen) {
      errors.push({
        type: "DashboardEntryMismatch",
        field: "allSuitesGreen",
        indexValue: String(index.runSummary.allSuitesGreen),
        dashboardValue: String(entry.allSuitesGreen),
      });
    }

    if (errors.length > 0) {
      return new ResultAsync(Promise.resolve(err(errors)));
    }
    return ResultAsync.fromSafePromise(Promise.resolve(undefined));
  }

  private verifySuiteHistory(
    raw: string,
    runId: string,
    suiteSummary: SuiteSummaryShape,
  ): ResultAsync<void, VerifyEvalRunError[]> {
    const parsedJson = parseJson(
      raw,
      `suite-history-${suiteSummary.suite}.json`,
    );
    if (parsedJson.isErr()) {
      return new ResultAsync(Promise.resolve(err([parsedJson.error])));
    }
    const entries = toSuiteHistoryEntries(parsedJson.value);
    if (entries === undefined) {
      return new ResultAsync(
        Promise.resolve(
          err([
            {
              type: "SchemaValidationFailed" as const,
              artifact: `suite-history-${suiteSummary.suite}.json`,
              message: "suite-history file is missing a valid history array",
            },
          ]),
        ),
      );
    }
    const entry = entries.find((e) => e.runId === runId);
    if (entry === undefined) {
      return new ResultAsync(
        Promise.resolve(
          err([
            {
              type: "SuiteHistoryEntryMissing" as const,
              suite: suiteSummary.suite,
              runId,
            },
          ]),
        ),
      );
    }

    const errors: VerifyEvalRunError[] = [];
    if (entry.gitSha !== suiteSummary.gitSha) {
      errors.push({
        type: "SuiteHistoryEntryMismatch",
        suite: suiteSummary.suite,
        field: "gitSha",
        reportValue: suiteSummary.gitSha,
        historyValue: entry.gitSha,
      });
    }
    if (entry.totalCases !== suiteSummary.totalCases) {
      errors.push({
        type: "SuiteHistoryEntryMismatch",
        suite: suiteSummary.suite,
        field: "totalCases",
        reportValue: String(suiteSummary.totalCases),
        historyValue: String(entry.totalCases),
      });
    }
    if (entry.passedCases !== suiteSummary.passedCases) {
      errors.push({
        type: "SuiteHistoryEntryMismatch",
        suite: suiteSummary.suite,
        field: "passedCases",
        reportValue: String(suiteSummary.passedCases),
        historyValue: String(entry.passedCases),
      });
    }
    if (entry.suiteGreen !== suiteSummary.suiteGreen) {
      errors.push({
        type: "SuiteHistoryEntryMismatch",
        suite: suiteSummary.suite,
        field: "suiteGreen",
        reportValue: String(suiteSummary.suiteGreen),
        historyValue: String(entry.suiteGreen),
      });
    }

    if (errors.length > 0) {
      return new ResultAsync(Promise.resolve(err(errors)));
    }
    return ResultAsync.fromSafePromise(Promise.resolve(undefined));
  }

  // -------------------------------------------------------------------------
  // Scenario history agreement: every expected case is present, has a
  // non-empty description, and its lastRuns entry for this run agrees on
  // model counts/pass counts (run ID identity is the lookup key itself).
  // -------------------------------------------------------------------------

  private verifyScenarioHistory(
    raw: string,
    runId: string,
    suiteSummary: SuiteSummaryShape,
  ): ResultAsync<void, VerifyEvalRunError[]> {
    const parsedJson = parseJson(
      raw,
      `scenario-history-${suiteSummary.suite}.json`,
    );
    if (parsedJson.isErr()) {
      return new ResultAsync(Promise.resolve(err([parsedJson.error])));
    }
    const scenarioHistory = toScenarioHistoryIndex(parsedJson.value);
    if (scenarioHistory === undefined) {
      return new ResultAsync(
        Promise.resolve(
          err([
            {
              type: "SchemaValidationFailed" as const,
              artifact: `scenario-history-${suiteSummary.suite}.json`,
              message:
                "scenario-history file is missing a valid scenarios array",
            },
          ]),
        ),
      );
    }

    const provider =
      this.options.suiteExpectationsProvider ?? NO_SUITE_EXPECTATIONS;
    const expectedCaseIds = provider.expectedCaseIds(suiteSummary.suite) ?? [
      ...new Set(suiteSummary.cases.map((c) => c.caseId)),
    ];

    // Compute considered per-case model counts from the report ("considered"
    // == !dryRun && scoreBucket !== "skip", mirroring ScenarioRunHistoryEntry).
    const perCase = new Map<
      string,
      { totalModels: number; passedModels: number }
    >();
    for (const c of suiteSummary.cases) {
      if (c.dryRun || c.scoreBucket === "skip") continue;
      const stats = perCase.get(c.caseId) ?? {
        totalModels: 0,
        passedModels: 0,
      };
      stats.totalModels += 1;
      if (c.passed) stats.passedModels += 1;
      perCase.set(c.caseId, stats);
    }

    const errors: VerifyEvalRunError[] = [];
    for (const caseId of expectedCaseIds) {
      const entry = scenarioHistory.scenarios.find((s) => s.caseId === caseId);
      if (entry === undefined) {
        errors.push({
          type: "ScenarioHistoryEntryMissing",
          suite: suiteSummary.suite,
          caseId,
        });
        continue;
      }

      if (entry.description === undefined || entry.description.trim() === "") {
        errors.push({
          type: "ScenarioHistoryDescriptionMissing",
          suite: suiteSummary.suite,
          caseId,
        });
      }

      const lastRun = entry.lastRuns.find((r) => r.runId === runId);
      if (lastRun === undefined) {
        errors.push({
          type: "ScenarioHistoryRunMissing",
          suite: suiteSummary.suite,
          caseId,
          runId,
        });
        continue;
      }

      const expectedStats = perCase.get(caseId) ?? {
        totalModels: 0,
        passedModels: 0,
      };
      if (lastRun.totalModels !== expectedStats.totalModels) {
        errors.push({
          type: "ScenarioHistoryMismatch",
          suite: suiteSummary.suite,
          caseId,
          field: "totalModels",
          reportValue: String(expectedStats.totalModels),
          historyValue: String(lastRun.totalModels),
        });
      }
      if (lastRun.passedModels !== expectedStats.passedModels) {
        errors.push({
          type: "ScenarioHistoryMismatch",
          suite: suiteSummary.suite,
          caseId,
          field: "passedModels",
          reportValue: String(expectedStats.passedModels),
          historyValue: String(lastRun.passedModels),
        });
      }
    }

    if (errors.length > 0) {
      return new ResultAsync(Promise.resolve(err(errors)));
    }
    return ResultAsync.fromSafePromise(Promise.resolve(undefined));
  }

  private verifyModelComparison(
    raw: string,
    report: PublicReportShape,
    scopedSuites: Set<string>,
  ): ResultAsync<void, VerifyEvalRunError[]> {
    const parsedJson = parseJson(raw, "model-comparison.json");
    if (parsedJson.isErr()) {
      return new ResultAsync(Promise.resolve(err([parsedJson.error])));
    }
    const entries = toModelComparisonEntries(parsedJson.value);
    if (entries === undefined) {
      return new ResultAsync(
        Promise.resolve(
          err([
            {
              type: "SchemaValidationFailed" as const,
              artifact: "model-comparison.json",
              message: "model-comparison file is missing a valid models array",
            },
          ]),
        ),
      );
    }

    // Aggregate expected per-model totals from in-scope suites only.
    const expected = new Map<string, { total: number; passed: number }>();
    for (const suite of report.suiteSummaries) {
      if (!scopedSuites.has(suite.suite)) continue;
      for (const c of suite.cases) {
        const stats = expected.get(c.modelId) ?? { total: 0, passed: 0 };
        stats.total += 1;
        if (c.passed) stats.passed += 1;
        expected.set(c.modelId, stats);
      }
    }

    const errors: VerifyEvalRunError[] = [];
    for (const [modelId, stats] of expected) {
      const entry = entries.find((e) => e.modelId === modelId);
      if (entry === undefined) {
        errors.push({ type: "ModelComparisonEntryMissing", modelId });
        continue;
      }
      if (entry.totalCases !== stats.total) {
        errors.push({
          type: "ModelComparisonMismatch",
          modelId,
          field: "totalCases",
          reportValue: String(stats.total),
          comparisonValue: String(entry.totalCases),
        });
      }
      if (entry.passedCases !== stats.passed) {
        errors.push({
          type: "ModelComparisonMismatch",
          modelId,
          field: "passedCases",
          reportValue: String(stats.passed),
          comparisonValue: String(entry.passedCases),
        });
      }
    }

    if (errors.length > 0) {
      return new ResultAsync(Promise.resolve(err(errors)));
    }
    return ResultAsync.fromSafePromise(Promise.resolve(undefined));
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

interface ParsedArgs {
  source: RunSource;
  suiteFilter?: string[];
  /** `--require-indexes` forces `indexArtifactPolicy: "required"` even for local runs. */
  requireIndexes: boolean;
  /** `--expected-head-sha <sha>` validates `gitSha` freshness against a specific HEAD. */
  expectedHeadSha?: string;
}

function firstFlag(argv: string[], flags: string[]): string | undefined {
  for (const flag of flags) {
    const i = argv.indexOf(flag);
    if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  }
  return undefined;
}

/**
 * Parses CLI arguments. Primary syntax: `--local <dir> --suite <suite>` or
 * `--remote <runId> --suite <suite>`. Aliases `--dir` and `--run-id` are
 * accepted for backward compatibility. `--suite` may be repeated or given as
 * a single comma-separated value. `--require-indexes` forces derived index
 * artifacts to be treated as required even for a local run directory (which
 * defaults to optional since local runs commonly lack a sibling `indexes/`
 * directory during development) — verifying a published/remote run always
 * requires indexes regardless of this flag.
 */
function parseArgs(argv: string[]): ParsedArgs | null {
  const localDir = firstFlag(argv, ["--local", "--dir"]);
  const remoteRunId = firstFlag(argv, ["--remote", "--run-id"]);
  const expectedHeadSha = firstFlag(argv, ["--expected-head-sha"]);

  const suiteValues: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--suite" && argv[i + 1] !== undefined) {
      suiteValues.push(...(argv[i + 1] as string).split(","));
    }
  }
  const suiteFilter = suiteValues.length > 0 ? suiteValues : undefined;
  const requireIndexes = argv.includes("--require-indexes");

  if (localDir !== undefined) {
    return {
      source: { kind: "local", dir: localDir },
      suiteFilter,
      requireIndexes,
      expectedHeadSha,
    };
  }
  if (remoteRunId !== undefined) {
    return {
      source: { kind: "remote", runId: remoteRunId },
      suiteFilter,
      requireIndexes,
      expectedHeadSha,
    };
  }
  return null;
}

if (import.meta.main) {
  const { logger } = await import("@weaveio/weave-engine");
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    logger.error(
      {},
      "Usage: bun scripts/evals/verify-agent-eval-run.ts --local <dir> [--suite <suite>[,<suite>...]] [--require-indexes] | --remote <runId> [--suite <suite>[,<suite>...]] [--expected-head-sha <sha>]",
    );
    process.exitCode = 1;
  } else {
    const suiteExpectationsResult =
      await buildProductionSuiteExpectationsProvider();
    if (suiteExpectationsResult.isErr()) {
      logger.error(
        { errors: suiteExpectationsResult.error },
        "Failed to load suite expectations from eval fixtures/model matrix",
      );
      process.exitCode = 1;
    } else {
      const verifier = new EvalRunVerifier({
        artifactReader: new DefaultArtifactReader(),
        gitSourceReader: {
          readSourceFile: (gitSha, relativePath) =>
            ResultAsync.fromPromise(
              Bun.$`git show ${gitSha}:${relativePath}`.text(),
              (cause): VerifyEvalRunError => ({
                type: "SourceReadError",
                path: relativePath,
                gitSha,
                message: cause instanceof Error ? cause.message : String(cause),
              }),
            ),
          isAncestorOrEqual: (candidateSha, expectedHeadSha) => {
            const safePromise =
              Bun.$`git merge-base --is-ancestor ${candidateSha} ${expectedHeadSha}`
                .quiet()
                .then(
                  () => true,
                  () => false,
                );
            return ResultAsync.fromSafePromise(safePromise);
          },
        },
        suiteExpectationsProvider: suiteExpectationsResult.value,
        suiteFilter: parsed.suiteFilter,
        expectedHeadSha: parsed.expectedHeadSha,
        indexArtifactPolicy: parsed.requireIndexes ? "required" : "auto",
      });

      const result = await verifier.verifyRun(parsed.source);
      result.match(
        (report) => {
          logger.info({ report }, "Eval run verification passed");
        },
        (errors) => {
          logger.error({ errors }, "Eval run verification failed");
          process.exitCode = 1;
        },
      );
    }
  }
}
