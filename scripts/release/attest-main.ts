/**
 * Independent artifact-attestation controller.
 *
 * This root is intentionally separate from the npm-trusted publish workflow.
 * It accepts only nonsecret identifiers, verifies the source/plan/tarball
 * tuple again, and reports a digest-bound check result. It has no import path
 * to publish-main or the publication executor.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
  type Result as ResultType,
} from "neverthrow";
import { z } from "zod";
import type { PublicPackageName } from "./constants.js";
import { PUBLIC_PACKAGES, RELEASE_ATTEST_WORKFLOW_PATH } from "./constants.js";
import { DigestSchema, FullShaSchema, PackageNameSchema } from "./model.js";
import {
  ATTESTATION_CHECK_NAME,
  type AttestationCheckResult,
} from "./publish-chain.js";

export const ATTEST_MAIN_SCHEMA_VERSION = 1 as const;
export const ATTESTATION_CHECK_SUMMARY_LIMIT = 4_096 as const;

const PositiveIdSchema = z.number().int().positive();
const TarballDigestSchema = z
  .object({
    packageName: PackageNameSchema,
    sha256: DigestSchema,
  })
  .strict();

export const AttestMainRequestSchema = z
  .object({
    schemaVersion: z.literal(ATTEST_MAIN_SCHEMA_VERSION),
    sourceRunId: PositiveIdSchema,
    artifactId: PositiveIdSchema,
    releasedSha: FullShaSchema,
    planDigest: DigestSchema,
    tarballDigests: z.array(TarballDigestSchema).min(1).max(4),
  })
  .strict()
  .superRefine((request, context) => {
    const packages = request.tarballDigests.map((item) => item.packageName);
    if (new Set(packages).size !== packages.length)
      context.addIssue({
        code: "custom",
        path: ["tarballDigests"],
        message: "tarball packages must be unique",
      });
    const digests = request.tarballDigests.map((item) => item.sha256);
    if (new Set(digests).size !== digests.length)
      context.addIssue({
        code: "custom",
        path: ["tarballDigests"],
        message: "tarball digests must be unique",
      });
  });

export type AttestMainRequest = z.infer<typeof AttestMainRequestSchema>;

export interface AttestationObservedIdentity {
  readonly sourceSha: string;
  readonly planDigest: string;
  readonly tarballDigests: readonly {
    packageName: PublicPackageName;
    sha256: string;
  }[];
}

export type AttestMainError =
  | { type: "InvalidAttestationInput"; issues: readonly string[] }
  | { type: "AttestationInputTooLarge"; bytes: number; limit: number }
  | { type: "AttestationSourceMismatch"; expected: string; actual: string }
  | { type: "AttestationPlanMismatch"; expected: string; actual: string }
  | {
      type: "AttestationTarballMismatch";
      packageName: PublicPackageName;
      expected: string;
      actual: string | null;
    }
  | { type: "AttestationObservedInputInvalid"; reason: string }
  | { type: "AttestationCheckReportFailed"; reason: string }
  | { type: "AttestationFileReadFailed"; path: string; reason: string };

export interface AttestationVerification {
  readonly sourceSha: string;
  readonly planDigest: string;
  readonly tarballDigests: readonly {
    packageName: PublicPackageName;
    sha256: string;
  }[];
}

export interface AttestationSubject {
  readonly packageName: PublicPackageName;
  readonly subjectDigest: string;
  readonly subjectPath: string;
}

export interface AttestationCheckReport {
  readonly check: AttestationCheckResult;
  readonly subjects: readonly AttestationSubject[];
}

export function validateAttestMainRequest(
  input: unknown,
): Result<AttestMainRequest, AttestMainError> {
  const bytes = boundedJsonBytes(input);
  if (bytes > 128 * 1024)
    return err({
      type: "AttestationInputTooLarge",
      bytes,
      limit: 128 * 1024,
    });
  const parsed = AttestMainRequestSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidAttestationInput",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

/**
 * Independent identity check. The observed values come from the checked-out
 * source and downloaded numeric artifact, never from the dispatch payload
 * alone.
 */
export function verifyAttestationIdentity(
  requestInput: unknown,
  observed: unknown,
): Result<AttestationVerification, AttestMainError> {
  return validateAttestMainRequest(requestInput).andThen((request) => {
    const identity = parseObservedIdentity(observed);
    if (identity.isErr()) return err(identity.error);
    if (identity.value.sourceSha !== request.releasedSha)
      return err<AttestationVerification, AttestMainError>({
        type: "AttestationSourceMismatch" as const,
        expected: request.releasedSha,
        actual: identity.value.sourceSha,
      });
    if (identity.value.planDigest !== request.planDigest)
      return err<AttestationVerification, AttestMainError>({
        type: "AttestationPlanMismatch" as const,
        expected: request.planDigest,
        actual: identity.value.planDigest,
      });
    const expected = new Map(
      request.tarballDigests.map((item) => [item.packageName, item.sha256]),
    );
    const actual = new Map(
      identity.value.tarballDigests.map((item) => [
        item.packageName,
        item.sha256,
      ]),
    );
    if (expected.size !== actual.size)
      return err<AttestationVerification, AttestMainError>({
        type: "AttestationTarballMismatch" as const,
        packageName:
          request.tarballDigests[0]?.packageName ?? "@weaveio/weave-cli",
        expected: request.tarballDigests.length.toString(),
        actual: identity.value.tarballDigests.length.toString(),
      });
    for (const [packageName, digest] of expected) {
      const observedDigest = actual.get(packageName) ?? null;
      if (observedDigest !== digest)
        return err<AttestationVerification, AttestMainError>({
          type: "AttestationTarballMismatch" as const,
          packageName,
          expected: digest,
          actual: observedDigest,
        });
    }
    return ok({
      sourceSha: identity.value.sourceSha,
      planDigest: identity.value.planDigest,
      tarballDigests: request.tarballDigests,
    });
  });
}

export function buildAttestationCheck(
  requestInput: unknown,
  verification: AttestationVerification,
  subjectPaths: Readonly<Record<string, string>> = {},
  checkRunId = 1,
): Result<AttestationCheckReport, AttestMainError> {
  const request = validateAttestMainRequest(requestInput);
  if (request.isErr()) return err(request.error);
  if (
    verification.sourceSha !== request.value.releasedSha ||
    verification.planDigest !== request.value.planDigest
  )
    return err({
      type: "AttestationObservedInputInvalid",
      reason: "verification no longer matches the validated request",
    });
  const subjects: AttestationSubject[] = verification.tarballDigests.map(
    (item) => ({
      packageName: item.packageName,
      subjectDigest: item.sha256,
      subjectPath: subjectPaths[item.packageName] ?? `${item.packageName}.tgz`,
    }),
  );
  return ok({
    check: {
      checkRunId,
      name: ATTESTATION_CHECK_NAME,
      status: "completed",
      conclusion: "success",
      releasedSha: verification.sourceSha,
      planDigest: verification.planDigest,
      subjects: subjects.map(({ packageName, subjectDigest }) => ({
        packageName,
        subjectDigest,
      })),
    },
    subjects,
  });
}

export interface AttestFilePort {
  read(path: string): ResultAsyncType<string, AttestMainError>;
  write(path: string, content: string): ResultAsyncType<void, AttestMainError>;
}

export interface AttestMainRunResult {
  readonly request: AttestMainRequest;
  readonly verification: AttestationVerification;
  readonly check: AttestationCheckReport;
}

export function runAttestMain(
  argv: readonly string[],
  files: AttestFilePort = bunAttestFiles(),
): ResultAsyncType<AttestMainRunResult, AttestMainError> {
  const args = parseAttestArgs(argv);
  if (args.isErr()) return errAsync(args.error);
  return files.read(args.value.requestPath).andThen((requestText) => {
    const request = parseJson(requestText, args.value.requestPath);
    if (request.isErr())
      return errAsync<AttestMainRunResult, AttestMainError>(request.error);
    const validatedRequest = validateAttestMainRequest(request.value);
    if (validatedRequest.isErr())
      return errAsync<AttestMainRunResult, AttestMainError>(
        validatedRequest.error,
      );
    const observedInput = args.value.observedPath;
    if (observedInput === undefined)
      return errAsync<AttestMainRunResult, AttestMainError>({
        type: "AttestationObservedInputInvalid" as const,
        reason: "an independent observed identity file is required",
      });
    return files.read(observedInput).andThen((observedText) => {
      const observed = parseJson(observedText, observedInput);
      if (observed.isErr())
        return errAsync<AttestMainRunResult, AttestMainError>(observed.error);
      return verifyAttestationIdentity(
        validatedRequest.value,
        observed.value,
      ).asyncAndThen((verification) =>
        buildAttestationCheck(
          validatedRequest.value,
          verification,
          {},
          Number(args.value.checkRunId ?? "1"),
        ).asyncAndThen((check) => {
          const result: AttestMainRunResult = {
            request: validatedRequest.value,
            verification,
            check,
          };
          if (args.value.outputPath === undefined) return okAsync(result);
          return files
            .write(args.value.outputPath, `${canonicalJson(result)}\n`)
            .map(() => result);
        }),
      );
    });
  });
}

export interface AttestMainArgs {
  requestPath: string;
  observedPath?: string;
  outputPath?: string;
  checkRunId?: string;
}

export type AttestArgsError = {
  type: "InvalidAttestationInput";
  issues: readonly string[];
};

export function parseAttestArgs(
  argv: readonly string[],
): ResultType<AttestMainArgs, AttestArgsError> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined)
      return err({
        type: "InvalidAttestationInput",
        issues: ["usage: attest-main --request <path> --observed <path>"],
      });
    values.set(key.slice(2), value);
    index += 1;
  }
  const requestPath = values.get("request");
  if (requestPath === undefined || requestPath.length === 0)
    return err({
      type: "InvalidAttestationInput",
      issues: ["--request is required"],
    });
  return ok({
    requestPath,
    observedPath: values.get("observed"),
    outputPath: values.get("output"),
    checkRunId: values.get("check-run-id"),
  });
}

function parseObservedIdentity(
  input: unknown,
): ResultType<AttestationObservedIdentity, AttestMainError> {
  const parsed = z
    .object({
      sourceSha: FullShaSchema,
      planDigest: DigestSchema,
      tarballDigests: z.array(TarballDigestSchema).min(1).max(4),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    return err({
      type: "AttestationObservedInputInvalid",
      reason: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
  return ok(parsed.data);
}

function parseJson(
  text: string,
  path: string,
): ResultType<unknown, AttestMainError> {
  return Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    (cause): AttestMainError => ({
      type: "AttestationFileReadFailed",
      path,
      reason: String(cause),
    }),
  )();
}

function bunAttestFiles(): AttestFilePort {
  return {
    read: (path) =>
      ResultAsync.fromThrowable(
        () => Bun.file(path).text(),
        (cause): AttestMainError => ({
          type: "AttestationFileReadFailed",
          path,
          reason: String(cause),
        }),
      )(),
    write: (path, content) =>
      ResultAsync.fromThrowable(
        () => Bun.write(path, content).then(() => undefined),
        (cause): AttestMainError => ({
          type: "AttestationFileReadFailed",
          path,
          reason: String(cause),
        }),
      )(),
  };
}

function boundedJsonBytes(input: unknown): number {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(input) ?? "",
    () => "",
  )();
  if (serialized.isErr()) return Number.MAX_SAFE_INTEGER;
  return new TextEncoder().encode(serialized.value).byteLength;
}

function canonicalJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(input);
}

if (import.meta.main) {
  const result = await runAttestMain(Bun.argv.slice(2));
  if (result.isErr()) process.exitCode = 1;
}

// Keep the catalog import live in generated declaration consumers. This also
// makes the closed package set explicit at the attestation boundary.
export const ATTESTATION_PUBLIC_PACKAGE_COUNT =
  Object.keys(PUBLIC_PACKAGES).length;
export const ATTESTATION_WORKFLOW_PATH = RELEASE_ATTEST_WORKFLOW_PATH;
