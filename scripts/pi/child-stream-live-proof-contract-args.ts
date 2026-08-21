import { err, ok, Result } from "neverthrow";
import {
  LIVE_PROOF_COMMAND,
  LIVE_PROOF_LANE_NAMES,
  type LiveProofArgs,
  type LiveProofArgumentFailure,
  type LiveProofLaneName,
} from "./child-stream-live-proof-contract-types.js";

// ---------------------------------------------------------------------------
// Closed live-proof CLI argument contract
// ---------------------------------------------------------------------------

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

const textEncoder = new TextEncoder();
const arrayIsArray = Array.isArray;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const reflectOwnKeys = Reflect.ownKeys;

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function argumentFailure(
  reason: LiveProofArgumentFailure["reason"],
): LiveProofArgumentFailure {
  return { reason, evidence: "blocked" };
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
