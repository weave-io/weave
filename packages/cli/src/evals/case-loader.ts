/**
 * Eval case fixture loader for `weave eval run`.
 *
 * Discovers, reads, and validates case fixture files under
 * `evals/cases/<suite>/<case-id>.json` and rubric files under
 * `evals/rubrics/<suite>/<case-id>.json`.
 *
 * All failures are returned as typed `FixtureSchemaError` values — no
 * exceptions propagate. File discovery uses `Bun.Glob` so no Node `fs`
 * is involved.
 *
 * Policy:
 *   - Unknown `suite` names are rejected fail-closed against the shared
 *     suite registry before discovery or model execution.
 *   - Unknown `case` IDs (from a `--case` filter) are validated against
 *     the loaded fixture set and fail with a typed `FixtureValidationFailed`
 *     error that identifies the offending file.
 *   - Unknown `agent` values (from an `allowed_agents` field) are validated
 *     against the closed `KNOWN_AGENTS` allowlist so rogue fixture entries
 *     surface at load time rather than at execution time.
 */

import { resolve } from "node:path";
import { err, ok, okAsync, ResultAsync } from "neverthrow";
import {
  loadModelMatrix,
  resolveCaseDefaultModels,
  resolveDefaultModels,
} from "./model-matrix.js";
import {
  EVAL_SUITE_IDS,
  type EvalCase,
  type EvalCaseFile,
  EvalCaseSchema,
  type EvalRubric,
  EvalRubricSchema,
  type FixtureSchemaError,
  getEvalSuiteMetadata,
  isKnownEvalSuiteId,
  type ModelMatrix,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Root directory for all eval fixtures, relative to the repo root.
 */
export const EVALS_ROOT = resolve(import.meta.dir, "../../../..", "evals");

/**
 * Closed allowlist of known agent names.
 *
 * Fixture entries whose `allowed_agents` reference an unknown name fail
 * with a `FixtureValidationFailed` error at load time. The allowlist is
 * intentionally narrow — add new agents here when they are formally defined
 * in the DSL config.
 *
 * Category shuttle agents follow the `shuttle-<category>` naming convention
 * and are included as prefixed entries.
 */
export const KNOWN_AGENTS = new Set([
  "loom",
  "tapestry",
  "thread",
  "shuttle",
  "shuttle-core",
  "shuttle-engine",
  "shuttle-adapters",
  "shuttle-docs",
  "shuttle-scripts",
  "shuttle-backend",
  "shuttle-backend-api",
  "shuttle-frontend",
  "shuttle-client-frontend",
  "shuttle-client-mobile",
  "shuttle-infra",
  "weft",
  "warp",
  "spindle",
  "pattern",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zodIssuesToPairs(
  issues: { path: PropertyKey[]; message: string }[],
): Array<{ path: string; message: string }> {
  return issues.map((i) => ({
    path: i.path.map(String).join(".") || "(root)",
    message: i.message,
  }));
}

/**
 * Read and JSON-parse a single fixture file. Returns a typed error on
 * file-not-found or JSON parse failures.
 */
function readFixtureFile(
  filePath: string,
): ResultAsync<unknown, FixtureSchemaError> {
  return ResultAsync.fromPromise(
    Bun.file(filePath).json() as Promise<unknown>,
    (cause) => {
      const msg = cause instanceof Error ? cause.message : String(cause);
      if (msg.includes("ENOENT") || msg.includes("No such file")) {
        return {
          type: "FixtureFileNotFound" as const,
          file: filePath,
          message: `Fixture file not found: ${filePath}`,
        } satisfies FixtureSchemaError;
      }
      return {
        type: "FixtureParseError" as const,
        file: filePath,
        message: `Failed to parse fixture as JSON: ${filePath} — ${msg}`,
      } satisfies FixtureSchemaError;
    },
  );
}

/**
 * Validate that all `allowed_agents` in a case are in `KNOWN_AGENTS`.
 */
function validateAllowedAgents(
  caseFixture: EvalCaseFile,
  filePath: string,
): FixtureSchemaError | undefined {
  for (const agent of caseFixture.allowed_agents) {
    if (!KNOWN_AGENTS.has(agent)) {
      return {
        type: "FixtureValidationFailed",
        file: filePath,
        message: `Unknown agent "${agent}" in allowed_agents of case "${caseFixture.id}". Known agents: ${[...KNOWN_AGENTS].join(", ")}`,
        issues: [
          {
            path: "allowed_agents",
            message: `"${agent}" is not in the KNOWN_AGENTS allowlist`,
          },
        ],
      };
    }
  }
  return undefined;
}

function validateKnownSuite(
  suite: string,
  filePath?: string,
): FixtureSchemaError | undefined {
  if (isKnownEvalSuiteId(suite)) {
    return undefined;
  }

  return {
    type: "UnknownEvalSuite",
    suite,
    file: filePath,
    message:
      `Unknown eval suite "${suite}". ` +
      `Known suites: ${EVAL_SUITE_IDS.join(", ")}`,
  };
}

function validateTextEvalContract(
  caseFixture: EvalCaseFile,
  filePath: string,
): FixtureSchemaError | undefined {
  const suiteMetadata = getEvalSuiteMetadata(caseFixture.suite);
  if (suiteMetadata === undefined) {
    return validateKnownSuite(caseFixture.suite, filePath);
  }

  const issues: Array<{ path: string; message: string }> = [];

  if (
    !suiteMetadata.allowedExpectedOutcomeKinds.includes(
      caseFixture.expected_outcome.kind,
    )
  ) {
    issues.push({
      path: "expected_outcome.kind",
      message:
        `Unsupported expected_outcome.kind "${caseFixture.expected_outcome.kind}" for text-only suite ` +
        `"${caseFixture.suite}". Allowed kinds: ${suiteMetadata.allowedExpectedOutcomeKinds.join(", ")}`,
    });
  }

  caseFixture.transcript_expectations.forEach((expectation, index) => {
    if (!suiteMetadata.allowedTranscriptChecks.includes(expectation.check)) {
      issues.push({
        path: `transcript_expectations.${index}.check`,
        message:
          `Unsupported transcript expectation check "${expectation.check}" for text-only suite ` +
          `"${caseFixture.suite}". Allowed checks: ${suiteMetadata.allowedTranscriptChecks.join(", ")}`,
      });
    }

    if (
      expectation.check === "content_contains" &&
      !suiteMetadata.allowedContentRoles.includes(expectation.role)
    ) {
      issues.push({
        path: `transcript_expectations.${index}.role`,
        message:
          `Unsupported transcript role "${expectation.role}" for text-only suite ` +
          `"${caseFixture.suite}". Allowed roles: ${suiteMetadata.allowedContentRoles.join(", ")}`,
      });
    }
  });

  if (issues.length === 0) {
    return undefined;
  }

  return {
    type: "UnsupportedTextEvalAssertion",
    file: filePath,
    suite: caseFixture.suite,
    message:
      `Text-only eval fixture contract rejected unsupported assertions in case ` +
      `"${caseFixture.id}" for suite "${caseFixture.suite}".`,
    issues,
  };
}

/**
 * Agents a trajectory case may start on (Spec 35). OpenCode silently falls
 * back to its default agent when `--agent` names a sub-agent, so allowing
 * one would make a case measure the wrong agent.
 */
export const TRAJECTORY_START_AGENTS: ReadonlySet<string> = new Set([
  "loom",
  "tapestry",
]);

/**
 * Cross-field rules for the Spec 35 `harness_trajectory` fields that the
 * discriminated-union schema cannot express: `start_agent` must be a
 * primary agent, and a verifier needs a fixture to verify.
 */
function validateTrajectoryVerificationFields(
  caseFixture: EvalCaseFile,
  filePath: string,
): FixtureSchemaError | undefined {
  const outcome = caseFixture.expected_outcome;
  if (outcome.kind !== "harness_trajectory") {
    return undefined;
  }

  const issues: Array<{ path: string; message: string }> = [];
  if (
    outcome.start_agent !== undefined &&
    !TRAJECTORY_START_AGENTS.has(outcome.start_agent)
  ) {
    issues.push({
      path: "expected_outcome.start_agent",
      message: `"${outcome.start_agent}" is not a primary agent. Allowed: ${[...TRAJECTORY_START_AGENTS].join(", ")}`,
    });
  }
  if (outcome.verifier !== undefined && outcome.fixture === undefined) {
    issues.push({
      path: "expected_outcome.verifier",
      message: "a verifier requires a fixture to verify",
    });
  }

  if (issues.length === 0) {
    return undefined;
  }
  return {
    type: "FixtureValidationFailed",
    file: filePath,
    message: `Invalid harness_trajectory verification fields in case "${caseFixture.id}".`,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Single-file loaders
// ---------------------------------------------------------------------------

/**
 * The model lists a case fixture's `allowed_models` is resolved against.
 */
export interface CaseModelDefaults {
  /** Every `default: true` model — the full default matrix. */
  readonly defaults: readonly string[];
  /**
   * What an omitted `allowed_models` is filled with: the default matrix plus
   * the `dev: true` development subset (`resolveCaseDefaultModels()`).
   */
  readonly fill: readonly string[];
}

/** The `CaseModelDefaults` a model matrix implies. */
export function caseModelDefaults(matrix: ModelMatrix): CaseModelDefaults {
  return {
    defaults: resolveDefaultModels(matrix).map((entry) => entry.id),
    fill: resolveCaseDefaultModels(matrix).map((entry) => entry.id),
  };
}

/**
 * Load and validate a single case fixture file.
 *
 * Returns `ok(EvalCase)` on success. Validates the file against
 * `EvalCaseSchema` and then checks `allowed_agents` against `KNOWN_AGENTS`.
 */
export function loadCaseFile(
  filePath: string,
  modelDefaults?: CaseModelDefaults,
): ResultAsync<EvalCase, FixtureSchemaError> {
  // Callers that load many cases pass the defaults in, so the matrix is read
  // once. A single-file caller gets the same contract — `allowed_models` always
  // populated — at the cost of reading the matrix here.
  const defaults: ResultAsync<CaseModelDefaults, FixtureSchemaError> =
    modelDefaults !== undefined
      ? okAsync(modelDefaults)
      : loadModelMatrix().map(caseModelDefaults);

  return defaults.andThen((resolvedDefaults) =>
    loadCaseFileWithDefaults(filePath, resolvedDefaults),
  );
}

function loadCaseFileWithDefaults(
  filePath: string,
  modelDefaults: CaseModelDefaults,
): ResultAsync<EvalCase, FixtureSchemaError> {
  return readFixtureFile(filePath).andThen((raw) => {
    const parsed = EvalCaseSchema.safeParse(raw);
    if (!parsed.success) {
      return err({
        type: "FixtureValidationFailed" as const,
        file: filePath,
        message: `Case fixture schema validation failed: ${filePath}`,
        issues: zodIssuesToPairs(parsed.error.issues),
      } satisfies FixtureSchemaError);
    }

    const suiteError = validateKnownSuite(parsed.data.suite, filePath);
    if (suiteError !== undefined) {
      return err(suiteError);
    }

    const agentError = validateAllowedAgents(parsed.data, filePath);
    if (agentError !== undefined) {
      return err(agentError);
    }

    const contractError = validateTextEvalContract(parsed.data, filePath);
    if (contractError !== undefined) {
      return err(contractError);
    }

    const trajectoryError = validateTrajectoryVerificationFields(
      parsed.data,
      filePath,
    );
    if (trajectoryError !== undefined) {
      return err(trajectoryError);
    }

    const modelsError = validateAllowedModels(
      parsed.data,
      filePath,
      modelDefaults,
    );
    if (modelsError !== undefined) {
      return err(modelsError);
    }

    return ok(withResolvedModels(parsed.data, modelDefaults.fill));
  });
}

/**
 * Rejects an explicit `allowed_models` that merely restates the matrix
 * defaults — either the `default: true` set alone, or that set plus the
 * `dev: true` subset an omitted field is filled with.
 *
 * Such a list looks harmless but silently stops tracking the matrix: adding a
 * model would reach every other case and skip this one. Omitting the field is
 * the way to say "the usual set".
 */
function validateAllowedModels(
  parsed: EvalCaseFile,
  filePath: string,
  modelDefaults: CaseModelDefaults,
): FixtureSchemaError | undefined {
  if (parsed.allowed_models === undefined) return undefined;

  const declared = sortedKey(parsed.allowed_models);
  const restates =
    declared === sortedKey(modelDefaults.defaults) ||
    declared === sortedKey(modelDefaults.fill);
  if (!restates) return undefined;

  return {
    type: "FixtureValidationFailed" as const,
    file: filePath,
    message:
      `Case fixture lists allowed_models identical to the model matrix defaults: ${filePath}. ` +
      "Omit the field instead — it is filled from evals/model-matrix.json, so the case keeps " +
      "tracking the matrix when a model is added. Declare it only for a deliberate exception.",
    issues: [
      {
        path: "allowed_models",
        message: "identical to the model matrix defaults",
      },
    ],
  } satisfies FixtureSchemaError;
}

function sortedKey(ids: readonly string[]): string {
  return [...ids].sort().join(",");
}

/**
 * Fills `allowed_models` when the fixture omits it: with the matrix defaults
 * plus the dev subset, so `--models dev` reaches the case too.
 */
function withResolvedModels(
  parsed: EvalCaseFile,
  fillModels: readonly string[],
): EvalCase {
  if (parsed.allowed_models !== undefined) {
    return parsed as EvalCase;
  }
  return { ...parsed, allowed_models: [...fillModels] };
}

/**
 * Load and validate a single rubric file.
 *
 * Returns `ok(EvalRubric)` on success. Validates the file against
 * `EvalRubricSchema`.
 */
export function loadRubricFile(
  filePath: string,
): ResultAsync<EvalRubric, FixtureSchemaError> {
  return readFixtureFile(filePath).andThen((raw) => {
    const parsed = EvalRubricSchema.safeParse(raw);
    if (!parsed.success) {
      return err({
        type: "FixtureValidationFailed" as const,
        file: filePath,
        message: `Rubric fixture schema validation failed: ${filePath}`,
        issues: zodIssuesToPairs(parsed.error.issues),
      } satisfies FixtureSchemaError);
    }
    return ok(parsed.data);
  });
}

// ---------------------------------------------------------------------------
// Suite loader
// ---------------------------------------------------------------------------

/**
 * Load all case fixtures for a given suite (e.g. `"loom-routing"`).
 *
 * Discovers `.json` files under `evals/cases/<suite>/` using `Bun.Glob`.
 * All files in the directory are loaded and validated; the first validation
 * error stops the load and returns that error.
 *
 * Returns `ok(EvalCase[])` — may be empty if the suite has no fixture files.
 */
export function loadSuiteCases(
  suite: string,
  evalsRoot: string = EVALS_ROOT,
): ResultAsync<EvalCase[], FixtureSchemaError> {
  const suiteError = validateKnownSuite(suite);
  if (suiteError !== undefined) {
    return ResultAsync.fromSafePromise(
      Promise.resolve([] as EvalCase[]),
    ).andThen(() => err(suiteError));
  }

  const casesDir = resolve(evalsRoot, "cases", suite);
  const glob = new Bun.Glob("*.json");
  let fileNames: string[];
  try {
    fileNames = Array.from(glob.scanSync(casesDir)).sort();
  } catch {
    // Directory does not exist — return empty list, not an error
    fileNames = [];
  }

  if (fileNames.length === 0) {
    return ResultAsync.fromSafePromise(Promise.resolve([] as EvalCase[]));
  }

  // Load the matrix once, not per case: every fixture that omits
  // `allowed_models` is filled from its `default: true` and `dev: true`
  // entries.
  return loadModelMatrix().andThen((matrix) => {
    const modelDefaults = caseModelDefaults(matrix);
    const loadAll = fileNames.map((name) =>
      loadCaseFile(resolve(casesDir, name), modelDefaults),
    );

    // Chain sequentially so the first error surfaces with its file path intact
    return loadAll.reduce(
      (acc, loader) => acc.andThen((cases) => loader.map((c) => [...cases, c])),
      ResultAsync.fromSafePromise(
        Promise.resolve([] as EvalCase[]),
      ) as ResultAsync<EvalCase[], FixtureSchemaError>,
    );
  });
}

/**
 * Load all rubric files for a given suite (e.g. `"loom-routing"`).
 *
 * Discovers `.json` files under `evals/rubrics/<suite>/` using `Bun.Glob`.
 * Returns `ok(EvalRubric[])` — may be empty.
 */
export function loadSuiteRubrics(
  suite: string,
  evalsRoot: string = EVALS_ROOT,
): ResultAsync<EvalRubric[], FixtureSchemaError> {
  const suiteError = validateKnownSuite(suite);
  if (suiteError !== undefined) {
    return ResultAsync.fromSafePromise(
      Promise.resolve([] as EvalRubric[]),
    ).andThen(() => err(suiteError));
  }

  const rubricsDir = resolve(evalsRoot, "rubrics", suite);
  const glob = new Bun.Glob("*.json");
  let fileNames: string[];
  try {
    fileNames = Array.from(glob.scanSync(rubricsDir)).sort();
  } catch {
    // Directory does not exist — return empty list, not an error
    fileNames = [];
  }

  if (fileNames.length === 0) {
    return ResultAsync.fromSafePromise(Promise.resolve([] as EvalRubric[]));
  }

  const loadAll = fileNames.map((name) =>
    loadRubricFile(resolve(rubricsDir, name)),
  );

  return ResultAsync.fromSafePromise(Promise.resolve(null)).andThen(() => {
    return loadAll.reduce(
      (acc, loader) =>
        acc.andThen((rubrics) => loader.map((r) => [...rubrics, r])),
      ResultAsync.fromSafePromise(
        Promise.resolve([] as EvalRubric[]),
      ) as ResultAsync<EvalRubric[], FixtureSchemaError>,
    );
  });
}

// ---------------------------------------------------------------------------
// Filter validation
// ---------------------------------------------------------------------------

/**
 * Validate a `--case` filter against the loaded case set.
 *
 * Returns the matching `EvalCase` or a `FixtureValidationFailed` error when
 * the case ID is not in the loaded set.
 *
 * The error includes the list of known case IDs so callers can produce a
 * useful error message.
 */
export function validateCaseFilter(
  caseId: string,
  cases: EvalCase[],
): FixtureSchemaError | EvalCase {
  const match = cases.find((c) => c.id === caseId);
  if (match === undefined) {
    const known = cases.map((c) => c.id).join(", ") || "(none)";
    return {
      type: "FixtureValidationFailed",
      file: "(case filter)",
      message: `Case "${caseId}" is not in the fixture allowlist. Known cases: ${known}`,
      issues: [
        {
          path: "case",
          message: `"${caseId}" does not match any loaded case fixture`,
        },
      ],
    };
  }
  return match;
}
