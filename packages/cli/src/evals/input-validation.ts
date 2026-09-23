/**
 * Input validation for `weave eval run`.
 *
 * Normalizes CLI flags and environment variables into a single trusted
 * `EvalRunRequest` object. All fallible parsing and env validation is
 * behind `Result` / `ResultAsync` — no exceptions propagate to callers.
 *
 * Policy notes:
 *   - `rawArtifacts` is local-only: it is rejected when the request
 *     originates from a CI environment (detected via `CI=true`).
 *   - Filter identifiers (`agent`, `model`, `case`) must be valid
 *     regex-safe strings: non-empty, no control characters, and
 *     must not contain characters that have special meaning in a
 *     regex unless intentionally permitted (we restrict to
 *     `[A-Za-z0-9_.\-/:]` to keep identifiers unambiguous).
 *   - The `agent` filter is additionally validated against a closed
 *     allowlist of known agent/suite names derived from the shared eval
 *     suite registry. Unknown agent values fail closed with a typed
 *     `UnknownAgentFilter` error before any dry-run or live execution is
 *     attempted.
 *   - Duplicate conflicting inputs (same filter key provided twice
 *     via different sources) are rejected with a typed error.
 *   - Empty eval filter environment variables are treated as absent.
 *     GitHub Actions workflow dispatch always projects blank optional
 *     inputs into env, and blank means no filter in that context.
 *   - Unknown `WEAVE_EVAL_*` env vars are rejected, except for known
 *     non-filter eval control vars such as `WEAVE_EVAL_PUBLISH_MODE`.
 *   - `--models <set>` (or `WEAVE_EVAL_MODELS`) selects a named model set
 *     from `MODEL_SET_NAMES`. `dev` names the cheap development subset and
 *     cannot be combined with `--model`, which already names one model.
 *   - `--repeat <n>` (or `WEAVE_EVAL_REPEAT`) runs every selected case `n`
 *     times per model, 1 to `MAX_EVAL_REPEAT`. Omitted means 1, which is
 *     exactly the run `weave eval run` made before repeats existed.
 *   - `--track <text|trajectory>` (or `WEAVE_EVAL_TRACK`) runs only the
 *     text-only cases or only the `harness_trajectory` cases. Omitted runs
 *     both. See `eval-track.ts`.
 */

import { err, ok, type Result } from "neverthrow";
import { EVAL_TRACKS, type EvalTrack } from "./eval-track.js";
import { MODEL_SET_NAMES, type ModelSetName } from "./model-matrix.js";
import { EVAL_AGENT_FILTERS } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Trusted eval run request produced by `parseEvalRunRequest`.
 * All fields have been validated and normalized before being placed here.
 */
export type EvalRunRequest = {
  /** Optional agent name filter (validated identifier). */
  agent: string | undefined;
  /** Optional model identifier filter (validated identifier). */
  model: string | undefined;
  /** Optional case identifier filter (validated identifier). */
  case: string | undefined;
  /**
   * The named model set to run when no `--model` filter is given.
   *
   * `"dev"` selects the `dev: true` development subset of
   * `evals/model-matrix.json`; `"default"` or omitted selects the full
   * default matrix. Never `"dev"` together with `model`.
   */
  modelSet?: ModelSetName;
  /**
   * How many times each selected case runs per model (`--repeat N`).
   * Omitted means 1. Always an integer in `[1, MAX_EVAL_REPEAT]`.
   */
  repeat?: number;
  /**
   * Which eval track to run (`--track`): only the text-only cases, or only
   * the `harness_trajectory` cases. Omitted runs both.
   */
  track?: EvalTrack;
  /**
   * When `true`, skip actual execution and print what would be run.
   * Always safe in any environment.
   */
  dryRun: boolean;
  /**
   * When `true`, emit raw eval artifacts to disk.
   * Rejected in CI environments (see `CI` env var).
   * Must be explicitly opted-in via `--raw-artifacts`; never implicit.
   */
  rawArtifacts: boolean;
};

/**
 * Raw inputs to `parseEvalRunRequest`.
 * Callers supply the parsed CLI flags and the environment map
 * separately so the function can normalize across both sources.
 */
export type EvalRunInputs = {
  /** Filter value from --agent flag. */
  agent?: string;
  /** Filter value from --model flag. */
  model?: string;
  /** Filter value from --case flag. */
  case?: string;
  /** Model set name from --models flag. */
  models?: string;
  /** Repeat count from --repeat flag, as typed. */
  repeat?: string;
  /** Track name from --track flag. */
  track?: string;
  /** Whether --dry-run was passed. */
  dryRun?: boolean;
  /** Whether --raw-artifacts was passed. */
  rawArtifacts?: boolean;
  /**
   * Environment variable map. Defaults to `Bun.env` when omitted.
   * Injected in tests to avoid real env reads.
   */
  env?: Record<string, string | undefined>;
};

export type EvalInputValidationError =
  | {
      type: "EmptyFilterValue";
      filter: string;
      message: string;
    }
  | {
      type: "InvalidFilterIdentifier";
      filter: string;
      value: string;
      message: string;
    }
  | {
      type: "RawArtifactsInCI";
      message: string;
    }
  | {
      type: "DuplicateConflictingInput";
      filter: string;
      message: string;
    }
  | {
      /**
       * The `--agent` filter value is not in the closed allowlist of known
       * agent names and suite identifiers. Unknown agents fail closed to
       * prevent typos from silently running zero cases.
       */
      type: "UnknownAgentFilter";
      /** The unrecognised agent value supplied by the caller. */
      value: string;
      /** The sorted list of permitted agent values. */
      allowedValues: string[];
      message: string;
    }
  | {
      /** The `--models` value is not a known model set name. */
      type: "UnknownModelSet";
      /** The unrecognised value supplied by the caller. */
      value: string;
      /** The permitted model set names. */
      allowedValues: string[];
      message: string;
    }
  | {
      /**
       * The `--repeat` value is not a whole number from 1 to
       * `MAX_EVAL_REPEAT`.
       */
      type: "InvalidRepeatCount";
      /** The value supplied by the caller. */
      value: string;
      message: string;
    }
  | {
      /** The `--track` value is not a known eval track. */
      type: "UnknownEvalTrack";
      /** The unrecognised value supplied by the caller. */
      value: string;
      /** The permitted track names. */
      allowedValues: string[];
      message: string;
    }
  | {
      /**
       * `--models dev` and `--model <id>` were both supplied. One names a
       * set, the other a single model; running both is ambiguous.
       */
      type: "ConflictingModelSelection";
      /** The `--model` value. */
      model: string;
      /** The `--models` value. */
      modelSet: ModelSetName;
      message: string;
    };

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

/**
 * Valid filter identifier pattern.
 * Allows alphanumerics, underscores, hyphens, dots, forward slashes,
 * and colons — the typical character set for agent names, model IDs,
 * and case identifiers. Rejects everything else to keep identifiers
 * unambiguous as regex input.
 */
const VALID_IDENTIFIER_RE = /^[A-Za-z0-9_./:@-]+$/;

/**
 * The most repeats one run may ask for.
 *
 * A cost guard: a run makes `repeat × cases × models` model calls, plus the
 * judge calls of every judge-scored attempt. Twenty repeats already give a
 * 95% interval of roughly ±20 points on one case's pass rate; more is a
 * baseline job, which can run twice.
 */
export const MAX_EVAL_REPEAT = 20;

/**
 * Validate a `--repeat` value: a whole number from 1 to `MAX_EVAL_REPEAT`,
 * written plainly (`3`, not `3.0`, `+3` or `03`).
 */
function validateRepeat(
  value: string,
): Result<number, EvalInputValidationError> {
  const parsed = Number.parseInt(value, 10);
  const plain = String(parsed) === value.trim();
  if (plain && parsed >= 1 && parsed <= MAX_EVAL_REPEAT) return ok(parsed);
  return err({
    type: "InvalidRepeatCount",
    value,
    message: `--repeat "${value}" must be a whole number from 1 to ${MAX_EVAL_REPEAT}`,
  });
}

// ---------------------------------------------------------------------------
// Agent allowlist — closed set of permitted agent/suite filter values
// ---------------------------------------------------------------------------

/**
 * The closed allowlist of agent names and suite identifiers accepted by the
 * `--agent` filter.
 *
 * - Logical agent names (`loom`, `tapestry`) match `shouldRunSuite()` in the
 *   orchestrator's `agentName` branch.
 * - Suite names (`loom-routing`, `tapestry-execution`, `shuttle-execution`,
 *   `spindle-tools`, `pattern-planning`, `weft-review`, `warp-security`)
 *   match the `suiteName` branch.
 *
 * Unknown values fail closed with a typed `UnknownAgentFilter` error so that
 * typos surface immediately rather than silently executing zero cases.
 *
 * Exported for use in tests and workflow sync checks so those surfaces stay
 * aligned with the shared registry instead of maintaining a separate source.
 */
export const KNOWN_EVAL_AGENTS = new Set(EVAL_AGENT_FILTERS);

/** Sorted array of permitted agent filter values (for error messages). */
export const KNOWN_EVAL_AGENTS_SORTED: readonly string[] = [
  ...KNOWN_EVAL_AGENTS,
].sort();

/**
 * Validate the `--agent` filter value against the closed allowlist.
 *
 * Returns `ok(value)` when the agent is known, or `err(UnknownAgentFilter)`
 * when it is not. This check must occur AFTER `validateIdentifier()` so the
 * character-safety guard runs first.
 */
function validateAgentAllowlist(
  value: string,
): Result<string, EvalInputValidationError> {
  if (
    KNOWN_EVAL_AGENTS.has(
      value as Parameters<(typeof KNOWN_EVAL_AGENTS)["has"]>[0],
    )
  ) {
    return ok(value);
  }
  return err({
    type: "UnknownAgentFilter",
    value,
    allowedValues: KNOWN_EVAL_AGENTS_SORTED as string[],
    message:
      `--agent "${value}" is not a recognised eval agent or suite. ` +
      `Allowed values: ${KNOWN_EVAL_AGENTS_SORTED.join(", ")}`,
  });
}

/**
 * Validate a single filter identifier value.
 * Returns an error if the value is empty or contains invalid characters.
 */
function validateIdentifier(
  filter: string,
  value: string,
): Result<string, EvalInputValidationError> {
  if (value.trim() === "") {
    return err({
      type: "EmptyFilterValue",
      filter,
      message: `--${filter} must not be empty`,
    });
  }

  if (!VALID_IDENTIFIER_RE.test(value)) {
    return err({
      type: "InvalidFilterIdentifier",
      filter,
      value,
      message: `--${filter} "${value}" contains invalid characters; only A-Z a-z 0-9 _ . / : @ - are allowed`,
    });
  }

  return ok(value);
}

/**
 * Validate the `--models` value against `MODEL_SET_NAMES`.
 */
function validateModelSet(
  value: string,
): Result<ModelSetName, EvalInputValidationError> {
  const match = MODEL_SET_NAMES.find((name) => name === value);
  if (match !== undefined) return ok(match);
  return err({
    type: "UnknownModelSet",
    value,
    allowedValues: [...MODEL_SET_NAMES],
    message:
      `--models "${value}" is not a known model set. ` +
      `Allowed values: ${MODEL_SET_NAMES.join(", ")}`,
  });
}

/**
 * Validate the `--track` value against `EVAL_TRACKS`.
 */
function validateTrack(
  value: string,
): Result<EvalTrack, EvalInputValidationError> {
  const match = EVAL_TRACKS.find((name) => name === value);
  if (match !== undefined) return ok(match);
  return err({
    type: "UnknownEvalTrack",
    value,
    allowedValues: [...EVAL_TRACKS],
    message:
      `--track "${value}" is not a known eval track. ` +
      `Allowed values: ${EVAL_TRACKS.join(", ")}`,
  });
}

/**
 * Reject `--models dev` combined with `--model <id>`.
 *
 * `--models default` alongside `--model` is accepted: `default` is what a run
 * without `--models` means, and the workflow dispatch form always sends it.
 */
function validateModelSelection(
  model: string | undefined,
  modelSet: ModelSetName | undefined,
): Result<void, EvalInputValidationError> {
  if (model === undefined) return ok(undefined);
  if (modelSet !== "dev") return ok(undefined);
  return err({
    type: "ConflictingModelSelection",
    model,
    modelSet,
    message:
      `--models ${modelSet} and --model "${model}" cannot be combined; ` +
      "use --models dev to run the development subset, or --model to run one model",
  });
}

// ---------------------------------------------------------------------------
// CI detection
// ---------------------------------------------------------------------------

function isCI(env: Record<string, string | undefined>): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}

/**
 * Normalize optional env-backed filter values.
 *
 * CLI flags still reject empty strings, because an explicit `--agent ""` is a
 * caller error. Env vars are different: GitHub Actions writes blank workflow
 * dispatch inputs as empty strings, and in that context blank means no filter.
 */
function normalizeEnvFilterValue(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// Known eval env keys
// ---------------------------------------------------------------------------

const KNOWN_EVAL_ENV_KEYS = new Set([
  "WEAVE_EVAL_AGENT",
  "WEAVE_EVAL_MODEL",
  "WEAVE_EVAL_CASE",
  "WEAVE_EVAL_MODELS",
  "WEAVE_EVAL_REPEAT",
  "WEAVE_EVAL_TRACK",
  "WEAVE_EVAL_PUBLISH_MODE",
]);

/**
 * Guard against unknown WEAVE_EVAL_* env vars supplied via env overrides or
 * future callers. The set of allowed eval env vars is intentionally closed.
 * It includes both filter vars and known non-filter control vars.
 */
function validateEvalEnvKey(
  key: string,
): Result<void, EvalInputValidationError> {
  if (KNOWN_EVAL_ENV_KEYS.has(key)) return ok(undefined);
  return err({
    type: "InvalidFilterIdentifier",
    filter: key,
    value: key,
    message:
      `Unknown eval env var "${key}"; allowed WEAVE_EVAL_* vars are: ` +
      [...KNOWN_EVAL_ENV_KEYS].sort().join(", "),
  });
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Detect duplicate filter values across CLI flags and env variables.
 * A duplicate is defined as the same logical filter key being supplied
 * via both the CLI flag and an env var with a different value.
 *
 * Same-value duplicates are silently collapsed to one (idempotent).
 */
function detectDuplicate(
  filter: string,
  flagValue: string | undefined,
  envValue: string | undefined,
): Result<string | undefined, EvalInputValidationError> {
  if (flagValue === undefined) return ok(envValue);
  if (envValue === undefined) return ok(flagValue);
  if (flagValue === envValue) return ok(flagValue);
  return err({
    type: "DuplicateConflictingInput",
    filter,
    message: `--${filter} was supplied both as a CLI flag ("${flagValue}") and as an environment variable ("${envValue}") with different values; remove one`,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and validate inputs for `weave eval run`.
 *
 * Normalizes CLI flags and environment variable overrides into a single
 * trusted `EvalRunRequest`. Returns a typed error without throwing on
 * any expected failure path.
 */
export function parseEvalRunRequest(
  inputs: EvalRunInputs,
): Result<EvalRunRequest, EvalInputValidationError> {
  const env = inputs.env ?? Bun.env;

  // Validate filter keys present via env (WEAVE_EVAL_AGENT etc.) before
  // processing their values. We only support the three known filter keys.
  const envAgent = normalizeEnvFilterValue(env.WEAVE_EVAL_AGENT);
  const envModel = normalizeEnvFilterValue(env.WEAVE_EVAL_MODEL);
  const envCase = normalizeEnvFilterValue(env.WEAVE_EVAL_CASE);
  const envModels = normalizeEnvFilterValue(env.WEAVE_EVAL_MODELS);
  const envRepeat = normalizeEnvFilterValue(env.WEAVE_EVAL_REPEAT);
  const envTrack = normalizeEnvFilterValue(env.WEAVE_EVAL_TRACK);

  // Resolve agent filter: merge CLI flag + env variable
  const agentMerge = detectDuplicate("agent", inputs.agent, envAgent);
  if (agentMerge.isErr()) return err(agentMerge.error);
  const rawAgent = agentMerge.value;

  const agentValidation =
    rawAgent !== undefined
      ? validateIdentifier("agent", rawAgent)
      : ok(undefined);
  if (agentValidation.isErr()) return err(agentValidation.error);
  const syntaxValidatedAgent = agentValidation.value;

  // Allowlist validation: unknown agent values fail closed before any execution
  const agentAllowlistValidation =
    syntaxValidatedAgent !== undefined
      ? validateAgentAllowlist(syntaxValidatedAgent)
      : ok(undefined);
  if (agentAllowlistValidation.isErr())
    return err(agentAllowlistValidation.error);
  const validatedAgent = agentAllowlistValidation.value;

  // Resolve model filter
  const modelMerge = detectDuplicate("model", inputs.model, envModel);
  if (modelMerge.isErr()) return err(modelMerge.error);
  const rawModel = modelMerge.value;

  const modelValidation =
    rawModel !== undefined
      ? validateIdentifier("model", rawModel)
      : ok(undefined);
  if (modelValidation.isErr()) return err(modelValidation.error);
  const validatedModel = modelValidation.value;

  // Resolve case filter
  const caseMerge = detectDuplicate("case", inputs.case, envCase);
  if (caseMerge.isErr()) return err(caseMerge.error);
  const rawCase = caseMerge.value;

  const caseValidation =
    rawCase !== undefined ? validateIdentifier("case", rawCase) : ok(undefined);
  if (caseValidation.isErr()) return err(caseValidation.error);
  const validatedCase = caseValidation.value;

  // Resolve the named model set
  const modelsMerge = detectDuplicate("models", inputs.models, envModels);
  if (modelsMerge.isErr()) return err(modelsMerge.error);
  const rawModels = modelsMerge.value;

  const modelsSyntax =
    rawModels !== undefined
      ? validateIdentifier("models", rawModels)
      : ok(undefined);
  if (modelsSyntax.isErr()) return err(modelsSyntax.error);
  const syntaxValidatedModels = modelsSyntax.value;

  const modelSetValidation =
    syntaxValidatedModels !== undefined
      ? validateModelSet(syntaxValidatedModels)
      : ok(undefined);
  if (modelSetValidation.isErr()) return err(modelSetValidation.error);
  const validatedModelSet = modelSetValidation.value;

  const selection = validateModelSelection(validatedModel, validatedModelSet);
  if (selection.isErr()) return err(selection.error);

  // Resolve the repeat count
  const repeatMerge = detectDuplicate("repeat", inputs.repeat, envRepeat);
  if (repeatMerge.isErr()) return err(repeatMerge.error);
  const rawRepeat = repeatMerge.value;
  const repeatValidation =
    rawRepeat !== undefined ? validateRepeat(rawRepeat) : ok(undefined);
  if (repeatValidation.isErr()) return err(repeatValidation.error);
  const validatedRepeat = repeatValidation.value;

  // Resolve the eval track
  const trackMerge = detectDuplicate("track", inputs.track, envTrack);
  if (trackMerge.isErr()) return err(trackMerge.error);
  const rawTrack = trackMerge.value;
  const trackValidation =
    rawTrack !== undefined ? validateTrack(rawTrack) : ok(undefined);
  if (trackValidation.isErr()) return err(trackValidation.error);
  const validatedTrack = trackValidation.value;

  // Validate unknown WEAVE_EVAL_* env vars. WEAVE_EVAL_PUBLISH_MODE is a
  // control var, not a filter, but it is part of the eval env contract.
  const evalEnvKeys = Object.keys(env).filter((k) =>
    k.startsWith("WEAVE_EVAL_"),
  );
  for (const envKey of evalEnvKeys) {
    const keyValidation = validateEvalEnvKey(envKey);
    if (keyValidation.isErr()) return err(keyValidation.error);
  }

  // raw-artifacts is local-only; reject in CI
  const rawArtifacts = inputs.rawArtifacts ?? false;
  if (rawArtifacts && isCI(env)) {
    return err({
      type: "RawArtifactsInCI",
      message:
        "--raw-artifacts is a local-only option and cannot be used in CI environments (CI env var is set); remove --raw-artifacts or run outside CI",
    });
  }

  const request: EvalRunRequest = {
    agent: validatedAgent,
    model: validatedModel,
    case: validatedCase,
    dryRun: inputs.dryRun ?? false,
    rawArtifacts,
  };
  if (validatedModelSet !== undefined) request.modelSet = validatedModelSet;
  if (validatedRepeat !== undefined) request.repeat = validatedRepeat;
  if (validatedTrack !== undefined) request.track = validatedTrack;
  return ok(request);
}
