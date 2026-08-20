import { err, ok, Result } from "neverthrow";

// ---------------------------------------------------------------------------
// Closed live-proof command contract
// ---------------------------------------------------------------------------

export const LIVE_PROOF_SCHEMA_VERSION = 1 as const;
export const LIVE_PROOF_COMMAND = "live" as const;

/** The live verifier has exactly these four independently reported lanes. */
export const LIVE_PROOF_LANE_NAMES = Object.freeze([
  "parent-raw-reasoning-live",
  "inspector-raw-reasoning-live",
  "inspector-tool-details",
  "inspector-assistant-reply-live",
] as const);

/** Compatibility alias for callers that name the list as required lanes. */
export const REQUIRED_LIVE_PROOF_LANES = LIVE_PROOF_LANE_NAMES;

export type LiveProofLaneName = (typeof LIVE_PROOF_LANE_NAMES)[number];

export const LIVE_PROOF_FLAGS = Object.freeze([
  "--pi",
  "--require-fresh-parent",
  "--require-current-build",
  "--proof-lanes",
  "--content-free-report",
  "--no-screen-capture",
] as const);

export const LIVE_PROOF_FORBIDDEN_SCREEN_FLAGS = Object.freeze([
  "--allow-screen-capture",
  "--screen-capture",
] as const);

export const MAX_LIVE_PROOF_ARGUMENTS = 16;
export const MAX_LIVE_PROOF_ARGUMENT_BYTES = 1_024;
export const MAX_LIVE_PROOF_LANE_LIST_BYTES = 512;
export const MAX_LIVE_PROOF_REPORT_TARGET_BYTES = 512;

/**
 * These are limits on the serialized report, not suggestions for callers.
 * The report contains only a few fixed-shape objects, but the limits remain
 * explicit so a future field cannot silently make the output unbounded.
 */
export const MAX_LIVE_PROOF_REPORT_DEPTH = 8;
export const MAX_LIVE_PROOF_REPORT_KEYS = 64;
export const MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH = 8;
export const MAX_LIVE_PROOF_REPORT_STRING_BYTES = 128;
export const MAX_LIVE_PROOF_REPORT_TOTAL_BYTES = 16 * 1024;

export const MAX_LIVE_PROOF_COUNTER = 1_000_000;

export const LIVE_PROOF_REPORT_BOUNDS = Object.freeze({
  maxDepth: MAX_LIVE_PROOF_REPORT_DEPTH,
  maxKeys: MAX_LIVE_PROOF_REPORT_KEYS,
  maxArrayLength: MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH,
  maxStringBytes: MAX_LIVE_PROOF_REPORT_STRING_BYTES,
  maxTotalBytes: MAX_LIVE_PROOF_REPORT_TOTAL_BYTES,
});

export type LiveProofArgumentFailureReason =
  | "invalid-command"
  | "unknown-argument"
  | "missing-value"
  | "empty-value"
  | "duplicate-argument"
  | "unsafe-value"
  | "unsafe-report-target"
  | "screen-capture-forbidden"
  | "malformed-lane-list"
  | "duplicate-lane"
  | "overflow";

export interface LiveProofArgumentFailure {
  readonly reason: LiveProofArgumentFailureReason;
  readonly evidence: "blocked";
}

function argumentFailure(
  reason: LiveProofArgumentFailureReason,
): LiveProofArgumentFailure {
  return { reason, evidence: "blocked" };
}

export interface LiveProofArgs {
  readonly command: typeof LIVE_PROOF_COMMAND;
  readonly pi: string;
  readonly requireFreshParent: true;
  readonly requireCurrentBuild: true;
  readonly proofLanes: readonly LiveProofLaneName[];
  readonly contentFreeReport: string;
  readonly noScreenCapture: true;
}

const textEncoder = new TextEncoder();
const arrayIsArray = Array.isArray;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const hasOwnPropertyFn = Object.prototype.hasOwnProperty;
const jsonStringify = JSON.stringify;
const jsonParse = JSON.parse;

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

function isControlOrWhitespace(value: string): boolean {
  if (/\s/u.test(value)) return true;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function hasTraversalSegment(value: string): boolean {
  return value
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function isSafeTarget(value: string, maxBytes: number): boolean {
  return (
    value.length > 0 &&
    utf8ByteLength(value) <= maxBytes &&
    !isControlOrWhitespace(value) &&
    !value.includes("\\") &&
    !hasTraversalSegment(value) &&
    !value.endsWith("/") &&
    !value.startsWith("-")
  );
}

function isSafeReportTarget(value: string): boolean {
  return (
    isSafeTarget(value, MAX_LIVE_PROOF_REPORT_TARGET_BYTES) &&
    value.toLowerCase().endsWith(".json")
  );
}

function readArgumentVector(
  argv: readonly string[],
): Result<readonly string[], LiveProofArgumentFailure> {
  const reflected = Result.fromThrowable(
    () => {
      const candidate: unknown = argv;
      if (!arrayIsArray(candidate)) return undefined;
      const lengthDescriptor = getOwnPropertyDescriptor(candidate, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return undefined;
      }
      const length = lengthDescriptor.value;
      if (length > MAX_LIVE_PROOF_ARGUMENTS) {
        return "overflow" as const;
      }
      const keys = reflectOwnKeys(candidate);
      if (keys.length > MAX_LIVE_PROOF_ARGUMENTS + 1) {
        return "overflow" as const;
      }
      if (
        keys.length !== length + 1 ||
        !keys.includes("length") ||
        keys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^\d+$/u.test(key) ||
              Number(key) >= length),
        )
      ) {
        return undefined;
      }
      const values: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = getOwnPropertyDescriptor(candidate, String(index));
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor) ||
          typeof descriptor.value !== "string"
        ) {
          return undefined;
        }
        if (utf8ByteLength(descriptor.value) > MAX_LIVE_PROOF_ARGUMENT_BYTES) {
          return "overflow" as const;
        }
        values.push(descriptor.value);
      }
      return values;
    },
    (): undefined => undefined,
  )();

  if (reflected.isErr() || reflected.value === undefined) {
    return err(argumentFailure("unsafe-value"));
  }
  if (reflected.value === "overflow") {
    return err(argumentFailure("overflow"));
  }
  return ok(reflected.value);
}

function parseLaneList(
  value: string,
): Result<readonly LiveProofLaneName[], LiveProofArgumentFailure> {
  if (value.length === 0) return err(argumentFailure("empty-value"));
  if (utf8ByteLength(value) > MAX_LIVE_PROOF_LANE_LIST_BYTES) {
    return err(argumentFailure("overflow"));
  }
  const parts = value.split(",");
  if (parts.length !== LIVE_PROOF_LANE_NAMES.length) {
    return err(argumentFailure("malformed-lane-list"));
  }

  const seen = new Set<LiveProofLaneName>();
  const lanes: LiveProofLaneName[] = [];
  for (const part of parts) {
    if (
      part.length === 0 ||
      part !== part.trim() ||
      !isClosedValue(LIVE_PROOF_LANE_NAMES, part)
    ) {
      return err(argumentFailure("malformed-lane-list"));
    }
    if (seen.has(part)) return err(argumentFailure("duplicate-lane"));
    seen.add(part);
    lanes.push(part);
  }
  if (seen.size !== LIVE_PROOF_LANE_NAMES.length) {
    return err(argumentFailure("malformed-lane-list"));
  }
  return ok(Object.freeze(lanes));
}

/**
 * Parse the documented `verify-child-streaming live` arguments. A leading
 * `live` is accepted for direct use from the command entry point; callers
 * that already consumed the command may pass only the flags.
 */
export function parseLiveProofArgs(
  argv: readonly string[],
): Result<LiveProofArgs, LiveProofArgumentFailure> {
  const values = readArgumentVector(argv);
  if (values.isErr()) return err(values.error);

  const args = values.value;
  let offset = 0;
  if (args[0] === LIVE_PROOF_COMMAND) offset = 1;
  else if (args[0] !== undefined && !args[0].startsWith("--")) {
    return err(argumentFailure("invalid-command"));
  }

  let pi: string | undefined;
  let proofLanes: readonly LiveProofLaneName[] | undefined;
  let contentFreeReport: string | undefined;
  let requireFreshParent = false;
  let requireCurrentBuild = false;
  let noScreenCapture = false;
  const seen = new Set<string>();

  for (let index = offset; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) return err(argumentFailure("unsafe-value"));
    if (seen.has(argument)) return err(argumentFailure("duplicate-argument"));
    seen.add(argument);

    if (
      (LIVE_PROOF_FORBIDDEN_SCREEN_FLAGS as readonly string[]).includes(
        argument,
      )
    ) {
      return err(argumentFailure("screen-capture-forbidden"));
    }
    if (argument === "--require-fresh-parent") {
      requireFreshParent = true;
      continue;
    }
    if (argument === "--require-current-build") {
      requireCurrentBuild = true;
      continue;
    }
    if (argument === "--no-screen-capture") {
      noScreenCapture = true;
      continue;
    }

    if (
      argument !== "--pi" &&
      argument !== "--proof-lanes" &&
      argument !== "--content-free-report"
    ) {
      return err(argumentFailure("unknown-argument"));
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return err(argumentFailure("missing-value"));
    }
    if (value.length === 0) return err(argumentFailure("empty-value"));
    if (utf8ByteLength(value) > MAX_LIVE_PROOF_ARGUMENT_BYTES) {
      return err(argumentFailure("overflow"));
    }
    index += 1;

    if (argument === "--pi") {
      if (!isSafeTarget(value, MAX_LIVE_PROOF_ARGUMENT_BYTES)) {
        return err(argumentFailure("unsafe-value"));
      }
      pi = value;
      continue;
    }
    if (argument === "--content-free-report") {
      if (!isSafeReportTarget(value)) {
        return err(argumentFailure("unsafe-report-target"));
      }
      contentFreeReport = value;
      continue;
    }

    const parsedLanes = parseLaneList(value);
    if (parsedLanes.isErr()) return err(parsedLanes.error);
    proofLanes = parsedLanes.value;
  }

  if (
    pi === undefined ||
    proofLanes === undefined ||
    contentFreeReport === undefined ||
    !requireFreshParent ||
    !requireCurrentBuild ||
    !noScreenCapture
  ) {
    return err(argumentFailure("missing-value"));
  }

  return ok({
    command: LIVE_PROOF_COMMAND,
    pi,
    requireFreshParent: true,
    requireCurrentBuild: true,
    proofLanes,
    contentFreeReport,
    noScreenCapture: true,
  });
}

/** Name used by the verifier entry point once it consumes `live`. */
export const parseVerifyChildStreamingLiveArgs = parseLiveProofArgs;

// ---------------------------------------------------------------------------
// Content-free report schema
// ---------------------------------------------------------------------------

export const LIVE_PROOF_IDENTITY_CURRENT_RESULTS = Object.freeze([
  "current",
  "stale-on-disk",
  "manifest-mismatch",
  "unverifiable",
] as const);
export type LiveProofIdentityCurrentResult =
  (typeof LIVE_PROOF_IDENTITY_CURRENT_RESULTS)[number];

export const LIVE_PROOF_IDENTITY_FRESH_RESULTS = Object.freeze([
  "fresh",
  "stale",
  "unverifiable",
] as const);
export type LiveProofIdentityFreshResult =
  (typeof LIVE_PROOF_IDENTITY_FRESH_RESULTS)[number];

export const LIVE_PROOF_LANE_STATUSES = Object.freeze([
  "pass",
  "fail",
  "blocked",
] as const);
export type LiveProofLaneStatus = (typeof LIVE_PROOF_LANE_STATUSES)[number];

export const LIVE_PROOF_ISOLATION_STATUSES = Object.freeze([
  "isolated",
  "violated",
  "unverified",
] as const);
export type LiveProofIsolationStatus =
  (typeof LIVE_PROOF_ISOLATION_STATUSES)[number];

export const LIVE_PROOF_SETTLEMENT_STATUSES = Object.freeze([
  "settled",
  "unsettled",
  "unverified",
] as const);
export type LiveProofSettlementStatus =
  (typeof LIVE_PROOF_SETTLEMENT_STATUSES)[number];

export const LIVE_PROOF_REGISTRY_STATUSES = Object.freeze([
  "empty",
  "leaked",
  "unverified",
] as const);
export type LiveProofRegistryStatus =
  (typeof LIVE_PROOF_REGISTRY_STATUSES)[number];

export const LIVE_PROOF_DIAGNOSTIC_STATUSES = Object.freeze([
  "clean",
  "loss-observed",
  "unverified",
] as const);
export type LiveProofDiagnosticStatus =
  (typeof LIVE_PROOF_DIAGNOSTIC_STATUSES)[number];

export const LIVE_PROOF_CLEANUP_STATUSES = Object.freeze([
  "complete",
  "incomplete",
  "unverified",
] as const);
export type LiveProofCleanupStatus =
  (typeof LIVE_PROOF_CLEANUP_STATUSES)[number];

/** Closed reasons only. No host error message or caller text may cross here. */
export const LIVE_PROOF_FAILURE_CODES = Object.freeze([
  "invalid-args",
  "unknown-argument",
  "missing-value",
  "empty-value",
  "duplicate-argument",
  "unsafe-value",
  "unsafe-report-target",
  "screen-capture-forbidden",
  "malformed-lane-list",
  "duplicate-lane",
  "overflow",
  "identity-current-failed",
  "fresh-parent-failed",
  "lane-failed",
  "isolation-failed",
  "settlement-failed",
  "registry-leaked",
  "diagnostics-failed",
  "cleanup-failed",
  "spawn-failed",
  "timeout",
  "report-invalid",
  "report-too-large",
  "serialization-failed",
] as const);
export type LiveProofFailureCode = (typeof LIVE_PROOF_FAILURE_CODES)[number];

export interface LiveProofIdentity {
  readonly currentBuild: LiveProofIdentityCurrentResult;
  readonly freshParent: LiveProofIdentityFreshResult;
}

export type LiveProofLaneObservation =
  | {
      readonly name: LiveProofLaneName;
      readonly status: "pass";
      readonly observationCount: number;
    }
  | {
      readonly name: LiveProofLaneName;
      readonly status: "fail" | "blocked";
      readonly observationCount: number;
      readonly reason: LiveProofFailureCode;
    };

export interface LiveProofCounters {
  readonly events: number;
  readonly dropped: number;
  readonly repaints: number;
  readonly diagnostics: number;
  readonly cleanupAttempts: number;
}

export interface LiveProofBounds {
  readonly maxDepth: typeof MAX_LIVE_PROOF_REPORT_DEPTH;
  readonly maxKeys: typeof MAX_LIVE_PROOF_REPORT_KEYS;
  readonly maxArrayLength: typeof MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH;
  readonly maxStringBytes: typeof MAX_LIVE_PROOF_REPORT_STRING_BYTES;
  readonly maxTotalBytes: typeof MAX_LIVE_PROOF_REPORT_TOTAL_BYTES;
}

/**
 * Deliberately closed. In particular, there is no `path`, `content`,
 * `exception`, message, payload, or free-form string field in this type.
 */
export interface LiveProofReport {
  readonly schemaVersion: typeof LIVE_PROOF_SCHEMA_VERSION;
  readonly identity: LiveProofIdentity;
  readonly lanes: readonly LiveProofLaneObservation[];
  readonly isolation: LiveProofIsolationStatus;
  readonly settlement: LiveProofSettlementStatus;
  readonly registry: LiveProofRegistryStatus;
  readonly diagnostics: LiveProofDiagnosticStatus;
  readonly cleanup: LiveProofCleanupStatus;
  readonly failures: readonly LiveProofFailureCode[];
  readonly counters: LiveProofCounters;
  readonly bounds: LiveProofBounds;
}

export const LIVE_PROOF_REPORT_KEYS = Object.freeze([
  "schemaVersion",
  "identity",
  "lanes",
  "isolation",
  "settlement",
  "registry",
  "diagnostics",
  "cleanup",
  "failures",
  "counters",
  "bounds",
] as const);

export const LIVE_PROOF_VALIDATION_FAILURE_REASONS = Object.freeze([
  "not-object",
  "unexpected-key",
  "missing-field",
  "wrong-type",
  "invalid-enum",
  "accessor",
  "unreadable-input",
  "unsafe-prototype",
  "depth-exceeded",
  "key-limit-exceeded",
  "array-limit-exceeded",
  "string-limit-exceeded",
  "byte-limit-exceeded",
  "duplicate-lane",
  "lane-set-incomplete",
  "duplicate-failure",
  "invalid-bounds",
  "invalid-counter",
] as const);
export type LiveProofValidationFailureReason =
  (typeof LIVE_PROOF_VALIDATION_FAILURE_REASONS)[number];

export interface LiveProofReportValidationFailure {
  readonly reason: LiveProofValidationFailureReason;
  readonly evidence: "blocked";
}

export type LiveProofSerializationFailureReason =
  | "invalid-report"
  | "report-too-large"
  | "serialization-failed";

export interface LiveProofSerializationFailure {
  readonly reason: LiveProofSerializationFailureReason;
  readonly evidence: "blocked";
}

export type LiveProofJsonFailureReason =
  | "not-string"
  | "json-too-large"
  | "invalid-json"
  | "invalid-report";

export interface LiveProofJsonFailure {
  readonly reason: LiveProofJsonFailureReason;
  readonly evidence: "blocked";
}

interface ValidationBudget {
  keys: number;
}

function validationFailure(
  reason: LiveProofValidationFailureReason,
): LiveProofReportValidationFailure {
  return { reason, evidence: "blocked" };
}

function serializationFailure(
  reason: LiveProofSerializationFailureReason,
): LiveProofSerializationFailure {
  return { reason, evidence: "blocked" };
}

function jsonFailure(reason: LiveProofJsonFailureReason): LiveProofJsonFailure {
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

/** Saturate one non-negative counter at the report's hard counter bound. */
export function saturatingIncrement(value: number, amount = 1): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    return MAX_LIVE_PROOF_COUNTER;
  }
  if (value >= MAX_LIVE_PROOF_COUNTER) return MAX_LIVE_PROOF_COUNTER;
  if (amount >= MAX_LIVE_PROOF_COUNTER - value) return MAX_LIVE_PROOF_COUNTER;
  return value + amount;
}

export const saturatingAdd = saturatingIncrement;
export const incrementSaturatedCounter = saturatingIncrement;

/** Serialize only a validated, canonical report. No input object is stringified. */
export function serializeLiveProofReport(
  input: unknown,
): Result<string, LiveProofSerializationFailure> {
  const validated = validateLiveProofReport(input);
  if (validated.isErr()) return err(serializationFailure("invalid-report"));

  const serialized = Result.fromThrowable(
    () => jsonStringify(validated.value),
    (): LiveProofSerializationFailure =>
      serializationFailure("serialization-failed"),
  )();
  if (serialized.isErr()) return err(serialized.error);
  if (utf8ByteLength(serialized.value) > MAX_LIVE_PROOF_REPORT_TOTAL_BYTES) {
    return err(serializationFailure("report-too-large"));
  }
  return ok(serialized.value);
}

export const safeSerializeLiveProofReport = serializeLiveProofReport;

/** Parse JSON and then apply the same closed schema as the serializer. */
export function parseLiveProofReportJson(
  input: unknown,
): Result<LiveProofReport, LiveProofJsonFailure> {
  if (typeof input !== "string") return err(jsonFailure("not-string"));
  if (utf8ByteLength(input) > MAX_LIVE_PROOF_REPORT_TOTAL_BYTES) {
    return err(jsonFailure("json-too-large"));
  }
  const parsed = Result.fromThrowable(
    () => jsonParse(input) as unknown,
    (): LiveProofJsonFailure => jsonFailure("invalid-json"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  const validated = validateLiveProofReport(parsed.value);
  if (validated.isErr()) return err(jsonFailure("invalid-report"));
  return ok(validated.value);
}

export const parseSerializedLiveProofReport = parseLiveProofReportJson;
