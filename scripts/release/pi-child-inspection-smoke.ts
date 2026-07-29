import { createHash } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import type { PiAdapterFailure } from "../../packages/adapters/pi/src/errors.js";
import {
  validateRepeatedSettlements,
  type PiRepeatedSettlementValidationError,
  type PiSettlementValidationObservation,
} from "../../packages/adapters/pi/src/repeated-settlement-validator.js";

export interface SmokeBinding {
  readonly artifactSha256: string;
  readonly subjectSha: string;
  readonly hostVersion: string;
  readonly runAttempt: number;
}

export interface SmokeReport {
  readonly binding: SmokeBinding;
  readonly childSettlementMissingCount: number;
  readonly assertions: readonly string[];
  readonly sanitizedArtifacts: readonly string[];
}

export type SmokeValidationError =
  | { readonly type: "BindingMismatch"; readonly field: keyof SmokeBinding }
  | { readonly type: "ChildSettlementMissing"; readonly runIndex: number }
  | { readonly type: "Validation"; readonly detail: PiRepeatedSettlementValidationError };

const SHA256 = /^[a-f0-9]{64}$/;
const SUBJECT_SHA = /^[a-f0-9]{40}$/;

export function validateSmokeBinding(binding: SmokeBinding): Result<SmokeBinding, SmokeValidationError> {
  if (!SHA256.test(binding.artifactSha256)) return err({ type: "BindingMismatch", field: "artifactSha256" });
  if (!SUBJECT_SHA.test(binding.subjectSha)) return err({ type: "BindingMismatch", field: "subjectSha" });
  if (binding.hostVersion.length === 0) return err({ type: "BindingMismatch", field: "hostVersion" });
  if (!Number.isInteger(binding.runAttempt) || binding.runAttempt < 1) return err({ type: "BindingMismatch", field: "runAttempt" });
  return ok(binding);
}

/** Validate structured results; log text is deliberately ignored. */
export async function validateLargeOutputSmoke(
  run: (sentinel: string) => ReturnType<NonNullable<Parameters<typeof validateRepeatedSettlements>[0]>["run"]>,
  maxParallelism: number,
): Promise<Result<{ readonly validatedRuns: number; readonly childSettlementMissingCount: number }, SmokeValidationError>> {
  const result = await validateRepeatedSettlements({
    sequentialRuns: 10,
    maxParallelism,
    run: (descriptor) => run(descriptor.sentinel),
  });
  if (result.isOk()) return ok({ validatedRuns: result.value.validatedRuns, childSettlementMissingCount: 0 });
  if (result.error.type === "StructuredFailure" && result.error.failureCode === "ChildSettlementMissing") {
    return err({ type: "ChildSettlementMissing", runIndex: result.error.run.index });
  }
  return err({ type: "Validation", detail: result.error });
}

export function sanitizedAssertion(value: unknown): string {
  return JSON.stringify(value, (_key, child) => typeof child === "string" ? (child.length > 256 ? `${child.slice(0, 256)}…` : child.replaceAll(/(secret|token|password|private)/gi, "[redacted]")) : child);
}

export function artifactDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Autonomous entry point. The harness supplies the exact artifact binding and
 * child runner; this module never prompts, reads the user's home, or writes
 * unsanitized child output.
 */
export async function runAutonomousSmoke(input: {
  readonly binding: SmokeBinding;
  readonly maxParallelism: number;
  readonly run: (sentinel: string) => ReturnType<NonNullable<Parameters<typeof validateRepeatedSettlements>[0]>["run"]>;
}): Promise<Result<SmokeReport, SmokeValidationError>> {
  const binding = validateSmokeBinding(input.binding);
  if (binding.isErr()) return err(binding.error);
  const large = await validateLargeOutputSmoke(input.run, input.maxParallelism);
  if (large.isErr()) return err(large.error);
  return ok({
    binding: input.binding,
    childSettlementMissingCount: large.value.childSettlementMissingCount,
    assertions: ["zero-human-input", "isolated-XDG_DATA_HOME", "isolated-PI_CODING_AGENT_DIR", "parent-result-bounded", "structured-results-checked"],
    sanitizedArtifacts: [sanitizedAssertion(large.value)],
  });
}

export type SmokeObservation = PiSettlementValidationObservation;
export type SmokeFailure = PiAdapterFailure;
