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
 *   - At most `MAX_DEV_MODELS` models may carry `dev: true`, so the
 *     development subset stays cheap. `resolveModelSet(matrix, "dev")`
 *     returns them; `resolveModelSet(matrix, "default")` is the full default
 *     matrix. A plain `eval run` always means the default set.
 *   - `resolveCaseDefaultModels()` is what a case fixture that omits
 *     `allowed_models` may run on: the default set plus the dev subset, so a
 *     dev-subset run reaches every ordinary case without editing it.
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

/**
 * Maximum number of models that may carry `dev: true`.
 *
 * The development subset exists so that iterating on a prompt, a case or a
 * rubric costs cents rather than dollars (Spec 37, 17.1). A cap in the loader
 * keeps it that way: growing the subset past this is a deliberate edit here,
 * not a quiet addition to the matrix.
 */
export const MAX_DEV_MODELS = 2;

/**
 * The named model sets `--models` selects between.
 *
 * - `default` — every `default: true` entry; what a plain `eval run` runs.
 * - `dev` — every `dev: true` entry; the cheap development subset.
 */
export const MODEL_SET_NAMES = ["default", "dev"] as const;

export type ModelSetName = (typeof MODEL_SET_NAMES)[number];

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

    // Constraint: the dev subset stays small, so it stays cheap
    const devCount = matrix.models.filter((m) => m.dev).length;
    if (devCount > MAX_DEV_MODELS) {
      return err({
        type: "ModelMatrixConstraintViolation" as const,
        file: matrixPath,
        message: `Model matrix may mark at most ${MAX_DEV_MODELS} models dev: true, but found ${devCount} in ${matrixPath}`,
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
 * Return only the models marked `dev: true` in the matrix — the cheap
 * development subset. May be empty when no entry is marked.
 */
export function resolveDevModels(matrix: ModelMatrix): ModelMatrixEntry[] {
  return matrix.models.filter((m) => m.dev);
}

/**
 * Return the models in the named set, in matrix order.
 */
export function resolveModelSet(
  matrix: ModelMatrix,
  set: ModelSetName,
): ModelMatrixEntry[] {
  if (set === "dev") return resolveDevModels(matrix);
  return resolveDefaultModels(matrix);
}

/**
 * Return the models a case fixture that omits `allowed_models` may run on:
 * every `default: true` or `dev: true` entry, in matrix order.
 *
 * Omitting `allowed_models` means "the usual set". The dev subset is a cheap
 * stand-in for that set, so it belongs to it: a `--models dev` run reaches
 * every ordinary case without the case naming the dev models. Which models a
 * run actually executes is still decided by the model set it selects — a
 * plain `eval run` fans out over the default set only.
 */
export function resolveCaseDefaultModels(
  matrix: ModelMatrix,
): ModelMatrixEntry[] {
  return matrix.models.filter((m) => m.default || m.dev);
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
