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
import { err, ok, ResultAsync } from "neverthrow";
import {
  EVAL_SUITE_IDS,
  type EvalCase,
  EvalCaseSchema,
  type EvalRubric,
  EvalRubricSchema,
  type FixtureSchemaError,
  getEvalSuiteMetadata,
  isKnownEvalSuiteId,
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
  caseFixture: EvalCase,
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
  caseFixture: EvalCase,
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

// ---------------------------------------------------------------------------
// Single-file loaders
// ---------------------------------------------------------------------------

/**
 * Load and validate a single case fixture file.
 *
 * Returns `ok(EvalCase)` on success. Validates the file against
 * `EvalCaseSchema` and then checks `allowed_agents` against `KNOWN_AGENTS`.
 */
export function loadCaseFile(
  filePath: string,
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

    return ok(parsed.data);
  });
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

  const loadAll = fileNames.map((name) =>
    loadCaseFile(resolve(casesDir, name)),
  );

  return ResultAsync.fromSafePromise(Promise.resolve(null)).andThen(() => {
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
