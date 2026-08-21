/**
 * Usage observation normalization and rollup helpers.
 *
 * Runtime Store contract retention/usage extension + Pi adapter contract:
 * - Same ID + same normalized values → no-op
 * - Same ID + different values → invariant breach
 * - Rollups group by available dimensions and sum each known field independently
 * - Detail pruning never subtracts durable rollups
 */

import { err, ok, Result } from "neverthrow";
import {
  invariantViolationError,
  type RuntimeStoreError,
  validationError,
} from "./errors.js";
import type {
  UsageObservation,
  UsageObservationId,
  UsageRollup,
  UsageTokenCounters,
} from "./types.js";
import { createUsageObservationId } from "./types.js";

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
] as const satisfies readonly (keyof UsageTokenCounters)[];

export type UsageTokenField = (typeof TOKEN_FIELDS)[number];

export { TOKEN_FIELDS };

/**
 * Canonical normalized observation used for equality and persistence.
 * Optional fields are omitted when absent — never coerced to zero/null.
 */
export interface NormalizedUsageObservation {
  readonly id: UsageObservationId;
  readonly timestamp: string;
  readonly sourceKind: "engine" | "adapter";
  readonly sourceName: string;
  readonly workflowInstanceId?: UsageObservation["workflowInstanceId"];
  readonly stepId?: UsageObservation["stepId"];
  readonly agentName?: UsageObservation["agentName"];
  readonly model?: UsageObservation["model"];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
}

type MutableNormalizedUsageObservation = {
  -readonly [K in keyof NormalizedUsageObservation]: NormalizedUsageObservation[K];
};

type MutableUsageObservation = {
  -readonly [K in keyof UsageObservation]: UsageObservation[K];
};

type MutableUsageRollup = {
  -readonly [K in keyof UsageRollup]: UsageRollup[K];
};

type ValueTag =
  | "undefined"
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "other";

function valueTag<T>(value: T): ValueTag {
  if (value === undefined) return "undefined";
  if (Object(value) === value) return "object";
  const tag = Result.fromThrowable(
    () => Object.prototype.toString.call(value),
    () => "[object Other]",
  )();
  if (tag.isErr()) return "other";
  if (tag.value === "[object String]") return "string";
  if (tag.value === "[object Number]") return "number";
  if (tag.value === "[object Boolean]") return "boolean";
  return "other";
}

function isStringValue<T>(value: T): value is T & string {
  return valueTag(value) === "string";
}

function isNumberValue<T>(value: T): value is T & number {
  return valueTag(value) === "number";
}

function isObjectLike<T>(value: T): value is T & object {
  return value !== null && value !== undefined && Object(value) === value;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value);
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Validate and normalize a usage observation input after its owner checks it. */
function normalizeUsageObservationUnsafe(
  input: UsageObservation,
): Result<NormalizedUsageObservation, RuntimeStoreError> {
  if (!isStringValue(input.id) || input.id.length === 0) {
    return err(validationError("usage observation id is required", "id"));
  }
  if (!isStringValue(input.timestamp) || input.timestamp.length === 0) {
    return err(
      validationError("usage observation timestamp is required", "timestamp"),
    );
  }
  if (Number.isNaN(Date.parse(input.timestamp))) {
    return err(
      validationError(
        "usage observation timestamp must be a valid ISO 8601 string",
        "timestamp",
      ),
    );
  }
  if (
    !isObjectLike(input.source) ||
    (input.source.kind !== "engine" && input.source.kind !== "adapter") ||
    !isStringValue(input.source.name) ||
    input.source.name.length === 0
  ) {
    return err(
      validationError(
        "usage observation source must include kind and non-empty name",
        "source",
      ),
    );
  }

  const normalized: MutableNormalizedUsageObservation = {
    id: createUsageObservationId(input.id),
    timestamp: input.timestamp,
    sourceKind: input.source.kind,
    sourceName: input.source.name,
  };

  if (input.workflowInstanceId !== undefined) {
    if (
      !isStringValue(input.workflowInstanceId) ||
      input.workflowInstanceId.length === 0
    ) {
      return err(
        validationError(
          "workflowInstanceId must be a non-empty string when present",
          "workflowInstanceId",
        ),
      );
    }
    normalized.workflowInstanceId = input.workflowInstanceId;
  }
  if (input.stepId !== undefined) {
    if (!isStringValue(input.stepId) || input.stepId.length === 0) {
      return err(
        validationError(
          "stepId must be a non-empty string when present",
          "stepId",
        ),
      );
    }
    normalized.stepId = input.stepId;
  }
  if (input.agentName !== undefined) {
    if (!isStringValue(input.agentName) || input.agentName.length === 0) {
      return err(
        validationError(
          "agentName must be a non-empty string when present",
          "agentName",
        ),
      );
    }
    normalized.agentName = input.agentName;
  }
  if (input.model !== undefined) {
    if (!isStringValue(input.model) || input.model.length === 0) {
      return err(
        validationError(
          "model must be a non-empty string when present",
          "model",
        ),
      );
    }
    normalized.model = input.model;
  }

  for (const field of TOKEN_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (!isNumberValue(value) || !isNonNegativeInteger(value)) {
      return err(
        validationError(
          `${field} must be a non-negative safe integer when present`,
          field,
        ),
      );
    }
    normalized[field] = value;
  }

  if (input.cost !== undefined) {
    if (!isNumberValue(input.cost) || !isNonNegativeFinite(input.cost)) {
      return err(
        validationError(
          "cost must be a non-negative finite number when present",
          "cost",
        ),
      );
    }
    normalized.cost = input.cost;
  }

  return ok(normalized);
}

export function normalizeUsageObservation(
  input: UsageObservation,
): Result<NormalizedUsageObservation, RuntimeStoreError> {
  return Result.fromThrowable(
    () => normalizeUsageObservationUnsafe(input),
    () => validationError("usage observation input is unsafe"),
  )().andThen((result) => result);
}

/** Convert a normalized observation back to the public domain type. */
export function denormalizeUsageObservation(
  normalized: NormalizedUsageObservation,
): UsageObservation {
  const observation: MutableUsageObservation = {
    id: normalized.id,
    timestamp: normalized.timestamp,
    source: { kind: normalized.sourceKind, name: normalized.sourceName },
  };
  if (normalized.workflowInstanceId !== undefined) {
    observation.workflowInstanceId = normalized.workflowInstanceId;
  }
  if (normalized.stepId !== undefined) observation.stepId = normalized.stepId;
  if (normalized.agentName !== undefined) {
    observation.agentName = normalized.agentName;
  }
  if (normalized.model !== undefined) observation.model = normalized.model;
  if (normalized.inputTokens !== undefined) {
    observation.inputTokens = normalized.inputTokens;
  }
  if (normalized.outputTokens !== undefined) {
    observation.outputTokens = normalized.outputTokens;
  }
  if (normalized.cacheReadTokens !== undefined) {
    observation.cacheReadTokens = normalized.cacheReadTokens;
  }
  if (normalized.cacheWriteTokens !== undefined) {
    observation.cacheWriteTokens = normalized.cacheWriteTokens;
  }
  if (normalized.totalTokens !== undefined) {
    observation.totalTokens = normalized.totalTokens;
  }
  if (normalized.cost !== undefined) observation.cost = normalized.cost;
  return observation;
}

/**
 * Compare two normalized observations for idempotent replay equality.
 * Identity is by ID; equality ignores nothing that was normalized.
 */
export function normalizedUsageEqual(
  a: NormalizedUsageObservation,
  b: NormalizedUsageObservation,
): boolean {
  if (a.id !== b.id) return false;
  if (a.timestamp !== b.timestamp) return false;
  if (a.sourceKind !== b.sourceKind) return false;
  if (a.sourceName !== b.sourceName) return false;
  if (a.workflowInstanceId !== b.workflowInstanceId) return false;
  if (a.stepId !== b.stepId) return false;
  if (a.agentName !== b.agentName) return false;
  if (a.model !== b.model) return false;
  for (const field of TOKEN_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  if (a.cost !== b.cost) return false;
  return true;
}

/**
 * Stable rollup grouping key from available dimensions.
 */
export function usageRollupKey(normalized: NormalizedUsageObservation): string {
  return JSON.stringify([
    normalized.workflowInstanceId ?? null,
    normalized.stepId ?? null,
    normalized.agentName ?? null,
    normalized.model ?? null,
    normalized.sourceKind,
    normalized.sourceName,
  ]);
}

/** Empty rollup shell for a grouping key's dimensions. */
export function emptyUsageRollup(
  normalized: NormalizedUsageObservation,
): UsageRollup {
  const rollup: MutableUsageRollup = {
    source: { kind: normalized.sourceKind, name: normalized.sourceName },
    observationCount: 0,
  };
  if (normalized.workflowInstanceId !== undefined) {
    rollup.workflowInstanceId = normalized.workflowInstanceId;
  }
  if (normalized.stepId !== undefined) rollup.stepId = normalized.stepId;
  if (normalized.agentName !== undefined) rollup.agentName = normalized.agentName;
  if (normalized.model !== undefined) rollup.model = normalized.model;
  return rollup;
}

/**
 * Apply one observation's present numeric fields onto a rollup.
 * Absent fields on the observation do not create or change rollup fields.
 */
export function applyObservationToRollup(
  rollup: UsageRollup,
  normalized: NormalizedUsageObservation,
): UsageRollup {
  const next: MutableUsageRollup = {
    ...rollup,
    observationCount: rollup.observationCount + 1,
  };

  const mutable = next;

  for (const field of TOKEN_FIELDS) {
    const value = normalized[field];
    if (value === undefined) continue;
    const prior = rollup[field];
    mutable[field] = (prior ?? 0) + value;
  }

  if (normalized.cost !== undefined) {
    mutable.cost = (rollup.cost ?? 0) + normalized.cost;
  }

  return next;
}

/**
 * Decide insert vs no-op vs invariant breach for an existing observation.
 */
export function reconcileUsageReplay(
  existing: NormalizedUsageObservation,
  incoming: NormalizedUsageObservation,
): Result<"noop", RuntimeStoreError> {
  if (normalizedUsageEqual(existing, incoming)) return ok("noop");
  return err(
    invariantViolationError(
      "UsageObservation",
      "usage observation id reused with different normalized values",
      incoming.id,
    ),
  );
}
