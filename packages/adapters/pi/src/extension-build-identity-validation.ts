import type {
  ExtensionBuildIdentityManifest,
  ExtensionBuildOutputDigest,
} from "./extension-build-identity-types.js";
import {
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  MAX_EXTENSION_BUILD_INPUTS,
  MAX_EXTENSION_BUILD_OUTPUT_NAME_LENGTH,
  MAX_EXTENSION_BUILD_OUTPUTS,
  MAX_EXTENSION_BUILD_SUBJECT_LENGTH,
} from "./extension-build-identity-types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SUBJECT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_OUTPUT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function isBoundedString(
  value: unknown,
  maxLength: number,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return false;
    }
  }
  return true;
}

export function isGitSubject(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_EXTENSION_BUILD_SUBJECT_LENGTH) &&
    GIT_SUBJECT_PATTERN.test(value)
  );
}

export function isSafeTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function isSafeMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous >= current
    ) {
      return false;
    }
  }
  return true;
}

export function isSafeOutputName(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_EXTENSION_BUILD_OUTPUT_NAME_LENGTH) &&
    SAFE_OUTPUT_NAME_PATTERN.test(value)
  );
}

/** Parse a bounded, sorted list of SHA-256 digests. */
export function parseSha256List(
  value: unknown,
  maxLength = MAX_EXTENSION_BUILD_INPUTS,
): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maxLength ||
    value.some((digest) => !isSha256(digest)) ||
    !isSortedUnique(value)
  ) {
    return undefined;
  }
  return [...value];
}

/** Parse a bounded output digest list without allowing path-shaped names. */
export function parseOutputDigestList(
  value: unknown,
): readonly ExtensionBuildOutputDigest[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_EXTENSION_BUILD_OUTPUTS
  ) {
    return undefined;
  }
  const outputs: ExtensionBuildOutputDigest[] = [];
  const names: string[] = [];
  for (const rawOutput of value) {
    if (
      !isRecord(rawOutput) ||
      !isSafeOutputName(rawOutput.name) ||
      !isSha256(rawOutput.sha256)
    ) {
      return undefined;
    }
    outputs.push({ name: rawOutput.name, sha256: rawOutput.sha256 });
    names.push(rawOutput.name);
  }
  return isSortedUnique(names) ? outputs : undefined;
}

export function outputDigestFromList(
  outputs: readonly ExtensionBuildOutputDigest[] | undefined,
  name: string,
): string | undefined {
  return outputs?.find((output) => output.name === name)?.sha256;
}

export function outputDigest(
  manifest: ExtensionBuildIdentityManifest,
  name: string,
): string | undefined {
  return manifest.outputs.find((output) => output.name === name)?.sha256;
}

export function isCanonicalRuntimeOutputList(
  outputs: readonly ExtensionBuildOutputDigest[],
): boolean {
  return (
    outputs.length === EXTENSION_RUNTIME_OUTPUT_NAMES.length &&
    outputs.every(
      (output, index) =>
        output.name === EXTENSION_RUNTIME_OUTPUT_NAMES[index] &&
        isSha256(output.sha256),
    )
  );
}

export function hasEveryRuntimeOutput(
  outputs: readonly ExtensionBuildOutputDigest[] | undefined,
): outputs is readonly ExtensionBuildOutputDigest[] {
  return (
    outputs !== undefined &&
    EXTENSION_RUNTIME_OUTPUT_NAMES.every(
      (name) => outputDigestFromList(outputs, name) !== undefined,
    )
  );
}
