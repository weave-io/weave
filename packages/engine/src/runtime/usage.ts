/**
 * Usage observation normalization and rollup helpers.
 *
 * Spec 12 retention/usage extension + Spec 33 §19.4:
 * - Same ID + same normalized values → no-op
 * - Same ID + different values → invariant breach
 * - Rollups group by available dimensions and sum each known field independently
 * - Detail pruning never subtracts durable rollups
 */

import { err, ok, type Result } from "neverthrow";
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
  readonly workflowInstanceId?: string;
  readonly stepId?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value);
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Validate and normalize a usage observation input.
 */
export function normalizeUsageObservation(
  input: UsageObservation,
): Result<NormalizedUsageObservation, RuntimeStoreError> {
  if (typeof input.id !== "string" || input.id.length === 0) {
    return err(validationError("usage observation id is required", "id"));
  }
  if (typeof input.timestamp !== "string" || input.timestamp.length === 0) {
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
    input.source === undefined ||
    (input.source.kind !== "engine" && input.source.kind !== "adapter") ||
    typeof input.source.name !== "string" ||
    input.source.name.length === 0
  ) {
    return err(
      validationError(
        "usage observation source must include kind and non-empty name",
        "source",
      ),
    );
  }

  const normalized: {
    -readonly [K in keyof NormalizedUsageObservation]?: NormalizedUsageObservation[K];
  } = {
    id: createUsageObservationId(input.id),
    timestamp: input.timestamp,
    sourceKind: input.source.kind,
    sourceName: input.source.name,
  };

  if (input.workflowInstanceId !== undefined) {
    if (
      typeof input.workflowInstanceId !== "string" ||
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
    if (typeof input.stepId !== "string" || input.stepId.length === 0) {
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
    if (typeof input.agentName !== "string" || input.agentName.length === 0) {
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
    if (typeof input.model !== "string" || input.model.length === 0) {
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
    if (typeof value !== "number" || !isNonNegativeInteger(value)) {
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
    if (typeof input.cost !== "number" || !isNonNegativeFinite(input.cost)) {
      return err(
        validationError(
          "cost must be a non-negative finite number when present",
          "cost",
        ),
      );
    }
    normalized.cost = input.cost;
  }

  return ok(normalized as NormalizedUsageObservation);
}

/** Convert a normalized observation back to the public domain type. */
export function denormalizeUsageObservation(
  normalized: NormalizedUsageObservation,
): UsageObservation {
  const observation: UsageObservation = {
    id: normalized.id,
    timestamp: normalized.timestamp,
    source: { kind: normalized.sourceKind, name: normalized.sourceName },
  };

  return {
    ...observation,
    ...(normalized.workflowInstanceId !== undefined
      ? {
          workflowInstanceId:
            normalized.workflowInstanceId as UsageObservation["workflowInstanceId"],
        }
      : {}),
    ...(normalized.stepId !== undefined ? { stepId: normalized.stepId } : {}),
    ...(normalized.agentName !== undefined
      ? { agentName: normalized.agentName }
      : {}),
    ...(normalized.model !== undefined ? { model: normalized.model } : {}),
    ...(normalized.inputTokens !== undefined
      ? { inputTokens: normalized.inputTokens }
      : {}),
    ...(normalized.outputTokens !== undefined
      ? { outputTokens: normalized.outputTokens }
      : {}),
    ...(normalized.cacheReadTokens !== undefined
      ? { cacheReadTokens: normalized.cacheReadTokens }
      : {}),
    ...(normalized.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: normalized.cacheWriteTokens }
      : {}),
    ...(normalized.totalTokens !== undefined
      ? { totalTokens: normalized.totalTokens }
      : {}),
    ...(normalized.cost !== undefined ? { cost: normalized.cost } : {}),
  };
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
  return {
    source: { kind: normalized.sourceKind, name: normalized.sourceName },
    observationCount: 0,
    ...(normalized.workflowInstanceId !== undefined
      ? {
          workflowInstanceId:
            normalized.workflowInstanceId as UsageRollup["workflowInstanceId"],
        }
      : {}),
    ...(normalized.stepId !== undefined ? { stepId: normalized.stepId } : {}),
    ...(normalized.agentName !== undefined
      ? { agentName: normalized.agentName }
      : {}),
    ...(normalized.model !== undefined ? { model: normalized.model } : {}),
  };
}

/**
 * Apply one observation's present numeric fields onto a rollup.
 * Absent fields on the observation do not create or change rollup fields.
 */
export function applyObservationToRollup(
  rollup: UsageRollup,
  normalized: NormalizedUsageObservation,
): UsageRollup {
  const next: UsageRollup = {
    ...rollup,
    observationCount: rollup.observationCount + 1,
  };

  const mutable = next as {
    -readonly [K in keyof UsageRollup]?: UsageRollup[K];
  };

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
