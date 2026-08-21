import { err, ok, Result } from "neverthrow";
import { MAX_LIVE_PROOF_COUNTER } from "./child-stream-live-proof-contract-counters.js";
import {
  LIVE_PROOF_REPORT_BOUNDS,
  LIVE_PROOF_REPORT_KEYS,
  type LiveProofLaneObservation,
  type LiveProofReport,
  type LiveProofReportValidationFailure,
  type LiveProofValidationFailureReason,
  MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH,
  MAX_LIVE_PROOF_REPORT_DEPTH,
  MAX_LIVE_PROOF_REPORT_KEYS,
  MAX_LIVE_PROOF_REPORT_STRING_BYTES,
  MAX_LIVE_PROOF_REPORT_TOTAL_BYTES,
} from "./child-stream-live-proof-contract-report-schema.js";
import {
  LIVE_PROOF_CLEANUP_STATUSES,
  LIVE_PROOF_DIAGNOSTIC_STATUSES,
  LIVE_PROOF_FAILURE_CODES,
  LIVE_PROOF_IDENTITY_CURRENT_RESULTS,
  LIVE_PROOF_IDENTITY_FRESH_RESULTS,
  LIVE_PROOF_ISOLATION_STATUSES,
  LIVE_PROOF_LANE_NAMES,
  LIVE_PROOF_LANE_STATUSES,
  LIVE_PROOF_REGISTRY_STATUSES,
  LIVE_PROOF_SCHEMA_VERSION,
  LIVE_PROOF_SETTLEMENT_STATUSES,
  type LiveProofFailureCode,
  type LiveProofLaneName,
} from "./child-stream-live-proof-contract-types.js";

const textEncoder = new TextEncoder();
const arrayIsArray = Array.isArray;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const hasOwnPropertyFn = Object.prototype.hasOwnProperty;

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isClosedValue<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

interface ValidationBudget {
  keys: number;
}

function validationFailure(
  reason: LiveProofValidationFailureReason,
): LiveProofReportValidationFailure {
  return { reason, evidence: "blocked" };
}

function readDataObject(
  value: unknown,
  allowedKeys: readonly string[],
  depth: number,
  budget: ValidationBudget,
): Result<Readonly<Record<string, unknown>>, LiveProofReportValidationFailure> {
  if (depth > MAX_LIVE_PROOF_REPORT_DEPTH) {
    return err(validationFailure("depth-exceeded"));
  }
  if (value === null || typeof value !== "object" || arrayIsArray(value)) {
    return err(validationFailure("not-object"));
  }

  const reflected = Result.fromThrowable(
    () => ({
      prototype: getPrototypeOf(value),
      keys: reflectOwnKeys(value),
    }),
    (): LiveProofReportValidationFailure =>
      validationFailure("unreadable-input"),
  )();
  if (reflected.isErr()) return err(reflected.error);
  if (
    reflected.value.prototype !== Object.prototype &&
    reflected.value.prototype !== null
  ) {
    return err(validationFailure("unsafe-prototype"));
  }
  if (reflected.value.keys.length > MAX_LIVE_PROOF_REPORT_KEYS) {
    return err(validationFailure("key-limit-exceeded"));
  }
  budget.keys += reflected.value.keys.length;
  if (budget.keys > MAX_LIVE_PROOF_REPORT_KEYS) {
    return err(validationFailure("key-limit-exceeded"));
  }

  const output = Object.create(null) as Record<string, unknown>;
  for (const key of reflected.value.keys) {
    if (typeof key !== "string") {
      return err(validationFailure("unexpected-key"));
    }
    if (utf8ByteLength(key) > MAX_LIVE_PROOF_REPORT_STRING_BYTES) {
      return err(validationFailure("string-limit-exceeded"));
    }
    if (!allowedKeys.includes(key)) {
      return err(validationFailure("unexpected-key"));
    }
    const descriptor = Result.fromThrowable(
      () => getOwnPropertyDescriptor(value, key),
      (): LiveProofReportValidationFailure =>
        validationFailure("unreadable-input"),
    )();
    if (descriptor.isErr()) return err(descriptor.error);
    if (descriptor.value === undefined) {
      return err(validationFailure("missing-field"));
    }
    if (
      descriptor.value.enumerable !== true ||
      !("value" in descriptor.value)
    ) {
      return err(validationFailure("accessor"));
    }
    output[key] = descriptor.value.value;
  }
  return ok(output);
}

function readDataArray(
  value: unknown,
  depth: number,
  budget: ValidationBudget,
): Result<readonly unknown[], LiveProofReportValidationFailure> {
  if (depth > MAX_LIVE_PROOF_REPORT_DEPTH) {
    return err(validationFailure("depth-exceeded"));
  }
  if (!arrayIsArray(value)) return err(validationFailure("wrong-type"));

  const reflected = Result.fromThrowable(
    () => ({
      prototype: getPrototypeOf(value),
      keys: reflectOwnKeys(value),
      length: getOwnPropertyDescriptor(value, "length"),
    }),
    (): LiveProofReportValidationFailure =>
      validationFailure("unreadable-input"),
  )();
  if (reflected.isErr()) return err(reflected.error);
  if (reflected.value.prototype !== Array.prototype) {
    return err(validationFailure("unsafe-prototype"));
  }
  const lengthDescriptor = reflected.value.length;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return err(validationFailure("accessor"));
  }
  const length = lengthDescriptor.value;
  if (length > MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH) {
    return err(validationFailure("array-limit-exceeded"));
  }
  if (reflected.value.keys.length > MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH + 1) {
    return err(validationFailure("array-limit-exceeded"));
  }
  budget.keys += reflected.value.keys.length;
  if (budget.keys > MAX_LIVE_PROOF_REPORT_KEYS) {
    return err(validationFailure("key-limit-exceeded"));
  }

  if (
    reflected.value.keys.length !== length + 1 ||
    !reflected.value.keys.includes("length")
  ) {
    return err(validationFailure("wrong-type"));
  }
  for (let index = 0; index < length; index += 1) {
    if (!reflected.value.keys.includes(String(index))) {
      return err(validationFailure("wrong-type"));
    }
  }
  for (const key of reflected.value.keys) {
    if (key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key))) {
      return err(validationFailure("unexpected-key"));
    }
  }

  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Result.fromThrowable(
      () => getOwnPropertyDescriptor(value, String(index)),
      (): LiveProofReportValidationFailure =>
        validationFailure("unreadable-input"),
    )();
    if (descriptor.isErr()) return err(descriptor.error);
    if (
      descriptor.value === undefined ||
      descriptor.value.enumerable !== true ||
      !("value" in descriptor.value)
    ) {
      return err(validationFailure("accessor"));
    }
    output.push(descriptor.value.value);
  }
  return ok(output);
}

function requiredValue(
  object: Readonly<Record<string, unknown>>,
  key: string,
): Result<unknown, LiveProofReportValidationFailure> {
  if (!hasOwnPropertyFn.call(object, key)) {
    return err(validationFailure("missing-field"));
  }
  return ok(object[key]);
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
): Result<T, LiveProofReportValidationFailure> {
  if (typeof value !== "string") {
    return err(validationFailure("wrong-type"));
  }
  if (utf8ByteLength(value) > MAX_LIVE_PROOF_REPORT_STRING_BYTES) {
    return err(validationFailure("string-limit-exceeded"));
  }
  if (!isClosedValue(values, value)) {
    return err(validationFailure("invalid-enum"));
  }
  return ok(value);
}

function counterValue(
  value: unknown,
): Result<number, LiveProofReportValidationFailure> {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_LIVE_PROOF_COUNTER ||
    Object.is(value, -0)
  ) {
    return err(validationFailure("invalid-counter"));
  }
  return ok(value);
}

function exactNumber(
  value: unknown,
  expected: number,
): Result<number, LiveProofReportValidationFailure> {
  if (value !== expected) return err(validationFailure("invalid-bounds"));
  return ok(expected);
}

function validateReportInternal(
  input: unknown,
): Result<LiveProofReport, LiveProofReportValidationFailure> {
  const budget: ValidationBudget = { keys: 0 };
  const root = readDataObject(input, LIVE_PROOF_REPORT_KEYS, 0, budget);
  if (root.isErr()) return err(root.error);

  const schemaVersion = requiredValue(root.value, "schemaVersion").andThen(
    (value) => exactNumber(value, LIVE_PROOF_SCHEMA_VERSION),
  );
  if (schemaVersion.isErr()) return err(schemaVersion.error);

  const identityInput = requiredValue(root.value, "identity");
  if (identityInput.isErr()) return err(identityInput.error);
  const identityObject = readDataObject(
    identityInput.value,
    ["currentBuild", "freshParent"],
    1,
    budget,
  );
  if (identityObject.isErr()) return err(identityObject.error);
  const currentBuild = requiredValue(
    identityObject.value,
    "currentBuild",
  ).andThen((value) => enumValue(value, LIVE_PROOF_IDENTITY_CURRENT_RESULTS));
  if (currentBuild.isErr()) return err(currentBuild.error);
  const freshParent = requiredValue(
    identityObject.value,
    "freshParent",
  ).andThen((value) => enumValue(value, LIVE_PROOF_IDENTITY_FRESH_RESULTS));
  if (freshParent.isErr()) return err(freshParent.error);

  const lanesInput = requiredValue(root.value, "lanes");
  if (lanesInput.isErr()) return err(lanesInput.error);
  const lanesArray = readDataArray(lanesInput.value, 1, budget);
  if (lanesArray.isErr()) return err(lanesArray.error);
  if (lanesArray.value.length !== LIVE_PROOF_LANE_NAMES.length) {
    return err(validationFailure("lane-set-incomplete"));
  }
  const seenLanes = new Set<LiveProofLaneName>();
  const lanes: LiveProofLaneObservation[] = [];
  for (const laneInput of lanesArray.value) {
    const laneObject = readDataObject(
      laneInput,
      ["name", "status", "observationCount", "reason"],
      2,
      budget,
    );
    if (laneObject.isErr()) return err(laneObject.error);
    const name = requiredValue(laneObject.value, "name").andThen((value) =>
      enumValue(value, LIVE_PROOF_LANE_NAMES),
    );
    if (name.isErr()) return err(name.error);
    if (seenLanes.has(name.value)) {
      return err(validationFailure("duplicate-lane"));
    }
    seenLanes.add(name.value);
    const status = requiredValue(laneObject.value, "status").andThen((value) =>
      enumValue(value, LIVE_PROOF_LANE_STATUSES),
    );
    if (status.isErr()) return err(status.error);
    const observationCount = requiredValue(
      laneObject.value,
      "observationCount",
    ).andThen(counterValue);
    if (observationCount.isErr()) return err(observationCount.error);

    if (status.value === "pass") {
      if (hasOwnPropertyFn.call(laneObject.value, "reason")) {
        return err(validationFailure("unexpected-key"));
      }
      lanes.push({
        name: name.value,
        status: "pass",
        observationCount: observationCount.value,
      });
      continue;
    }

    const reason = requiredValue(laneObject.value, "reason").andThen((value) =>
      enumValue(value, LIVE_PROOF_FAILURE_CODES),
    );
    if (reason.isErr()) return err(reason.error);
    lanes.push({
      name: name.value,
      status: status.value,
      observationCount: observationCount.value,
      reason: reason.value,
    });
  }
  if (seenLanes.size !== LIVE_PROOF_LANE_NAMES.length) {
    return err(validationFailure("lane-set-incomplete"));
  }

  const isolation = requiredValue(root.value, "isolation").andThen((value) =>
    enumValue(value, LIVE_PROOF_ISOLATION_STATUSES),
  );
  if (isolation.isErr()) return err(isolation.error);
  const settlement = requiredValue(root.value, "settlement").andThen((value) =>
    enumValue(value, LIVE_PROOF_SETTLEMENT_STATUSES),
  );
  if (settlement.isErr()) return err(settlement.error);
  const registry = requiredValue(root.value, "registry").andThen((value) =>
    enumValue(value, LIVE_PROOF_REGISTRY_STATUSES),
  );
  if (registry.isErr()) return err(registry.error);
  const diagnostics = requiredValue(root.value, "diagnostics").andThen(
    (value) => enumValue(value, LIVE_PROOF_DIAGNOSTIC_STATUSES),
  );
  if (diagnostics.isErr()) return err(diagnostics.error);
  const cleanup = requiredValue(root.value, "cleanup").andThen((value) =>
    enumValue(value, LIVE_PROOF_CLEANUP_STATUSES),
  );
  if (cleanup.isErr()) return err(cleanup.error);

  const failuresInput = requiredValue(root.value, "failures");
  if (failuresInput.isErr()) return err(failuresInput.error);
  const failuresArray = readDataArray(failuresInput.value, 1, budget);
  if (failuresArray.isErr()) return err(failuresArray.error);
  const failures: LiveProofFailureCode[] = [];
  const seenFailures = new Set<LiveProofFailureCode>();
  for (const failureInput of failuresArray.value) {
    const failure = enumValue(failureInput, LIVE_PROOF_FAILURE_CODES);
    if (failure.isErr()) return err(failure.error);
    if (seenFailures.has(failure.value)) {
      return err(validationFailure("duplicate-failure"));
    }
    seenFailures.add(failure.value);
    failures.push(failure.value);
  }

  const countersInput = requiredValue(root.value, "counters");
  if (countersInput.isErr()) return err(countersInput.error);
  const countersObject = readDataObject(
    countersInput.value,
    ["events", "dropped", "repaints", "diagnostics", "cleanupAttempts"],
    1,
    budget,
  );
  if (countersObject.isErr()) return err(countersObject.error);
  const counterKeys = [
    "events",
    "dropped",
    "repaints",
    "diagnostics",
    "cleanupAttempts",
  ] as const;
  const counterValues: number[] = [];
  for (const key of counterKeys) {
    const counter = requiredValue(countersObject.value, key).andThen(
      counterValue,
    );
    if (counter.isErr()) return err(counter.error);
    counterValues.push(counter.value);
  }

  const boundsInput = requiredValue(root.value, "bounds");
  if (boundsInput.isErr()) return err(boundsInput.error);
  const boundsObject = readDataObject(
    boundsInput.value,
    [
      "maxDepth",
      "maxKeys",
      "maxArrayLength",
      "maxStringBytes",
      "maxTotalBytes",
    ],
    1,
    budget,
  );
  if (boundsObject.isErr()) return err(boundsObject.error);
  const boundKeys = [
    "maxDepth",
    "maxKeys",
    "maxArrayLength",
    "maxStringBytes",
    "maxTotalBytes",
  ] as const;
  const expectedBounds = [
    MAX_LIVE_PROOF_REPORT_DEPTH,
    MAX_LIVE_PROOF_REPORT_KEYS,
    MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH,
    MAX_LIVE_PROOF_REPORT_STRING_BYTES,
    MAX_LIVE_PROOF_REPORT_TOTAL_BYTES,
  ] as const;
  for (let index = 0; index < boundKeys.length; index += 1) {
    const bound = requiredValue(boundsObject.value, boundKeys[index]).andThen(
      (value) => exactNumber(value, expectedBounds[index]),
    );
    if (bound.isErr()) return err(bound.error);
  }

  const normalizedLanes = [...lanes].sort(
    (left, right) =>
      LIVE_PROOF_LANE_NAMES.indexOf(left.name) -
      LIVE_PROOF_LANE_NAMES.indexOf(right.name),
  );
  const report: LiveProofReport = {
    schemaVersion: LIVE_PROOF_SCHEMA_VERSION,
    identity: {
      currentBuild: currentBuild.value,
      freshParent: freshParent.value,
    },
    lanes: normalizedLanes,
    isolation: isolation.value,
    settlement: settlement.value,
    registry: registry.value,
    diagnostics: diagnostics.value,
    cleanup: cleanup.value,
    failures,
    counters: {
      events: counterValues[0] ?? 0,
      dropped: counterValues[1] ?? 0,
      repaints: counterValues[2] ?? 0,
      diagnostics: counterValues[3] ?? 0,
      cleanupAttempts: counterValues[4] ?? 0,
    },
    bounds: LIVE_PROOF_REPORT_BOUNDS,
  };
  return ok(report);
}

/** Validate and normalize a report without invoking accessors or copying input strings. */
export function validateLiveProofReport(
  input: unknown,
): Result<LiveProofReport, LiveProofReportValidationFailure> {
  const guarded = Result.fromThrowable(
    () => validateReportInternal(input),
    (): LiveProofReportValidationFailure =>
      validationFailure("unreadable-input"),
  )();
  if (guarded.isErr()) return err(guarded.error);
  return guarded.value;
}
