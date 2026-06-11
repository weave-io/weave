/**
 * Model matrix loader for `weave eval run`.
 *
 * Loads and validates `evals/model-matrix.json` against `ModelMatrixSchema`.
 * Returns a typed `ModelMatrix` on success or a `FixtureSchemaError` on any
 * failure (file not found, JSON parse error, schema violation, constraint
 * violation).
 *
 * Policy:
 *   - The default model matrix must contain at least three models with
 *     `default: true`. This is enforced as a `ModelMatrixConstraintViolation`
 *     so runners can fail fast before attempting any eval execution.
 *   - `resolveDefaultModels()` returns only models with `default: true`.
 *   - `filterMatrix()` returns only entries whose `id` matches the supplied
 *     filter value; an unknown filter value returns an empty array.
 *   - All path resolution is relative to the repo root (`MATRIX_PATH`).
 *     Callers may override the path in tests.
 */

import { resolve } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import {
  type FixtureSchemaError,
  type ModelMatrix,
  type ModelMatrixEntry,
  ModelMatrixSchema,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path to the canonical model matrix fixture, relative to the repo root.
 * Override in tests by passing an explicit path to `loadModelMatrix()`.
 */
export const MATRIX_PATH = resolve(
  import.meta.dir,
  "../../../..",
  "evals/model-matrix.json",
);

/**
 * Minimum number of models that must have `default: true` in the matrix.
 * The acceptance criteria for this task require that the loader returns
 * the default three-model matrix when no model filter is provided.
 */
export const MIN_DEFAULT_MODELS = 3;

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

// ---------------------------------------------------------------------------
// Core loader
// ---------------------------------------------------------------------------

/**
 * Load and validate the model matrix fixture at `matrixPath`.
 *
 * Returns `ok(ModelMatrix)` when the fixture is valid, or a typed
 * `FixtureSchemaError` on any failure. No exceptions propagate.
 */
export function loadModelMatrix(
  matrixPath: string = MATRIX_PATH,
): ResultAsync<ModelMatrix, FixtureSchemaError> {
  const readFile = ResultAsync.fromPromise(
    Bun.file(matrixPath).json() as Promise<unknown>,
    (cause) => {
      const msg = cause instanceof Error ? cause.message : String(cause);
      // Bun throws on missing file with ENOENT; treat other errors as parse errors
      if (msg.includes("ENOENT") || msg.includes("No such file")) {
        return {
          type: "FixtureFileNotFound" as const,
          file: matrixPath,
          message: `Model matrix file not found: ${matrixPath}`,
        } satisfies FixtureSchemaError;
      }
      return {
        type: "FixtureParseError" as const,
        file: matrixPath,
        message: `Failed to parse model matrix as JSON: ${matrixPath} — ${msg}`,
      } satisfies FixtureSchemaError;
    },
  );

  return readFile.andThen((raw) => {
    const parsed = ModelMatrixSchema.safeParse(raw);
    if (!parsed.success) {
      return err({
        type: "FixtureValidationFailed" as const,
        file: matrixPath,
        message: `Model matrix schema validation failed: ${matrixPath}`,
        issues: zodIssuesToPairs(parsed.error.issues),
      } satisfies FixtureSchemaError);
    }

    const matrix = parsed.data;

    // Constraint: at least MIN_DEFAULT_MODELS must have default: true
    const defaultCount = matrix.models.filter((m) => m.default).length;
    if (defaultCount < MIN_DEFAULT_MODELS) {
      return err({
        type: "ModelMatrixConstraintViolation" as const,
        file: matrixPath,
        message: `Model matrix must have at least ${MIN_DEFAULT_MODELS} models with default: true, but found ${defaultCount} in ${matrixPath}`,
      } satisfies FixtureSchemaError);
    }

    return ok(matrix);
  });
}

// ---------------------------------------------------------------------------
// Derived helpers (pure — no I/O)
// ---------------------------------------------------------------------------

/**
 * Return only the models marked `default: true` in the matrix.
 *
 * This is the set used when no `--model` filter is supplied.
 * The result is guaranteed to have at least `MIN_DEFAULT_MODELS` entries
 * because `loadModelMatrix()` enforces that constraint.
 */
export function resolveDefaultModels(matrix: ModelMatrix): ModelMatrixEntry[] {
  return matrix.models.filter((m) => m.default);
}

/**
 * Return the model entries whose `id` matches `filterId` exactly.
 *
 * An unknown `filterId` returns an empty array. The caller is responsible
 * for surfacing an error when an empty result is unexpected.
 */
export function filterMatrix(
  matrix: ModelMatrix,
  filterId: string,
): ModelMatrixEntry[] {
  return matrix.models.filter((m) => m.id === filterId);
}

/**
 * Validate whether a model identifier exists in the matrix.
 *
 * Returns `ok(entry)` when found, or an allowlist error when not found.
 * Used by case-loader to validate the `--model` filter against the matrix.
 */
export function validateModelInMatrix(
  matrix: ModelMatrix,
  modelId: string,
): Result<ModelMatrixEntry, FixtureSchemaError> {
  const match = matrix.models.find((m) => m.id === modelId);
  if (match === undefined) {
    const allowlist = matrix.models.map((m) => m.id).join(", ");
    return err({
      type: "FixtureValidationFailed" as const,
      file: MATRIX_PATH,
      message: `Model "${modelId}" is not in the model matrix allowlist. Allowed models: ${allowlist}`,
      issues: [
        {
          path: "models[].id",
          message: `"${modelId}" is not a known model ID`,
        },
      ],
    });
  }
  return ok(match);
}
