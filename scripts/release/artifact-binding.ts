import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import type {
  ActionsArtifactMetadata,
  GitHubClient,
  WorkflowRunMetadata,
} from "./github-client.js";
import { canonicalizeJson, type JsonValue, validateJsonValue } from "./json.js";
import {
  type ArtifactBindingRecord,
  ArtifactBindingRecordSchema,
  type ArtifactManifest,
} from "./model.js";
import {
  type ReleasePlan,
  type ReleasePlanBinding,
  type ReleasePlanError,
  releasePlanDigest,
  verifyReleasePlanBinding,
  verifyReleasePlanDigest,
} from "./release-plan.js";

export interface UploadedArtifact {
  name: string;
  serverArtifactId: number;
  uploadDigest: string;
  sizeInBytes: number;
}

export interface BindingRecordInput {
  repositoryId: number;
  workflowSha: string;
  runId: number;
  runAttempt: number;
  event: "schedule" | "workflow_dispatch";
  operation: ArtifactBindingRecord["operation"];
  headRef: ArtifactBindingRecord["headRef"];
  headSha: string;
  originJobConclusion: "success";
  originJobId?: number;
  originJobName?: "build";
  artifacts: readonly UploadedArtifact[];
  manifest: ArtifactManifest;
  manifestDigest: string;
  files: readonly { filename: string; sha256: string }[];
}

type BindingCanonicalInput =
  | JsonValue
  | ArtifactBindingRecord
  | Omit<ArtifactBindingRecord, "recordDigest">;

export type BindingError =
  | { type: "InvalidBindingRecord"; issues: readonly string[] }
  | {
      type: "BindingMismatch";
      field: string;
      expected: unknown;
      actual: unknown;
    }
  | { type: "ArtifactExpired"; artifactId: number }
  | { type: "ArtifactDeleted"; artifactId: number }
  | { type: "ArtifactDigestMissing"; artifactId: number }
  | { type: "GitHubLookupFailed"; operation: string; message: string }
  | { type: "CanonicalJsonFailed"; reason: string };

export interface BindingVerificationContext {
  expectedWorkflowSha: string;
  expectedRunId: number;
  expectedRunAttempt: number;
  expectedOperation: ArtifactBindingRecord["operation"];
  expectedHeadRef: ArtifactBindingRecord["headRef"];
  expectedHeadSha: string;
  expectedManifest: ArtifactManifest;
  expectedManifestDigest: string;
  expectedFiles: readonly { filename: string; sha256: string }[];
}

/** Why uploaded artifacts cannot be bound to a plan. */
export type PlanBindingError =
  | ReleasePlanError
  | { type: "InvalidBoundArtifacts"; reason: string };

/**
 * A build's outputs, tied to the plan they were built for.
 *
 * The uploaded artifacts are cache: losing them never blocks publication
 * (Task 14 reconstructs), and holding them never authorizes it. Authority is
 * the plan, and the plan is authoritative only after recomputation.
 */
export interface PlanBoundArtifact {
  /** The digest of the plan these bytes were built for. */
  planDigest: string;
  binding: ReleasePlanBinding;
  artifacts: readonly UploadedArtifact[];
}

/**
 * Attaches uploaded artifacts to the plan their build proved.
 *
 * The binding is accepted only when it was built at the plan's non-null
 * `releasedSha`, so a build from any other commit can never become the bytes a
 * release publishes.
 */
export function bindArtifactsToPlan(input: {
  plan: ReleasePlan;
  binding: JsonValue;
  artifacts: readonly UploadedArtifact[];
}): Result<PlanBoundArtifact, PlanBindingError> {
  return validateUploadedArtifacts(input.artifacts).andThen(() =>
    verifyReleasePlanBinding(input.plan, input.binding).andThen((binding) =>
      releasePlanDigest(input.plan).map((planDigest) => ({
        planDigest,
        binding,
        artifacts: input.artifacts,
      })),
    ),
  );
}

/** Re-proves a cached plan-bound artifact against a recomputed plan. */
export function verifyPlanBoundArtifact(
  bound: PlanBoundArtifact,
  plan: ReleasePlan,
): Result<ReleasePlanBinding, PlanBindingError> {
  return validateUploadedArtifacts(bound.artifacts)
    .andThen(() => verifyReleasePlanDigest(plan, bound.planDigest))
    .andThen(() => verifyReleasePlanBinding(plan, bound.binding));
}

function validateUploadedArtifacts(
  artifacts: readonly UploadedArtifact[],
): Result<readonly UploadedArtifact[], PlanBindingError> {
  if (artifacts.length === 0)
    return err({
      type: "InvalidBoundArtifacts",
      reason: "a build binds at least one uploaded artifact",
    });
  if (
    new Set(artifacts.map((artifact) => artifact.name)).size !==
    artifacts.length
  )
    return err({
      type: "InvalidBoundArtifacts",
      reason: "artifact names must be unique",
    });
  if (
    artifacts.some(
      (artifact) =>
        !Number.isInteger(artifact.serverArtifactId) ||
        artifact.serverArtifactId <= 0,
    )
  )
    return err({
      type: "InvalidBoundArtifacts",
      reason: "every artifact needs a positive server ID",
    });
  return ok(artifacts);
}

/** Creates the content-addressed record only after all upload responses exist. */
export function createBindingRecord(
  input: BindingRecordInput,
): Result<ArtifactBindingRecord, BindingError> {
  const unsigned: Omit<ArtifactBindingRecord, "recordDigest"> = {
    schemaVersion: 1 as const,
    repositoryId: input.repositoryId,
    repository: "weave-io/weave" as const,
    workflowPath: ".github/workflows/publish.yml" as const,
    workflowSha: input.workflowSha,
    runId: input.runId,
    runAttempt: input.runAttempt,
    event: input.event,
    operation: input.operation,
    headRef: input.headRef,
    headSha: input.headSha,
    originJobConclusion: input.originJobConclusion,
    // Pre-existing standalone harness fixtures did not model job identity. Live
    // binding supplies the server job ID; this compatibility default is never
    // used by the workflow path.
    originJobId: input.originJobId ?? 1,
    originJobName: input.originJobName ?? "build",
    artifacts: [...input.artifacts],
    packages: input.manifest.packages,
    versions: input.manifest.versions,
    releaseSubjectSha: input.manifest.releaseSubjectSha,
    manifestDigest: input.manifestDigest,
    files: [...input.files],
  };
  return canonicalJson(unsigned).andThen((canonical) => {
    const record = { ...unsigned, recordDigest: digest(canonical) };
    const parsed = ArtifactBindingRecordSchema.safeParse(record);
    if (!parsed.success)
      return err(invalid(parsed.error.issues.map((issue) => issue.message)));
    return ok(parsed.data);
  });
}

/**
 * Verifies Actions metadata before consumers may request credentials or publish.
 * Artifact retrieval is exclusively by numeric server ID, never a display name.
 */
export function verifyBindingRecord(
  record: ArtifactBindingInput,
  context: BindingVerificationContext,
  github: GitHubClient,
): ResultAsync<ArtifactBindingRecord, BindingError> {
  const parsed = ArtifactBindingRecordSchema.safeParse(record);
  if (!parsed.success)
    return errAsync(invalid(parsed.error.issues.map((issue) => issue.message)));
  const digestCheck = verifyRecordDigest(parsed.data);
  if (digestCheck.isErr()) return errAsync(digestCheck.error);
  return github
    .getWorkflowRun(parsed.data.runId)
    .mapErr((error) => githubError(error))
    .andThen((run) => verifyRun(parsed.data, context, run, github))
    .andThen((bound) => verifyArtifacts(bound, github));
}

function verifyRun(
  record: ArtifactBindingRecord,
  context: BindingVerificationContext,
  run: WorkflowRunMetadata,
  github: GitHubClient,
): ResultAsync<ArtifactBindingRecord, BindingError> {
  const checks: readonly [
    string,
    BindingCanonicalInput,
    BindingCanonicalInput,
  ][] = [
    ["repositoryId", record.repositoryId, run.repositoryId],
    ["runId", record.runId, run.id],
    ["runAttempt", record.runAttempt, run.runAttempt],
    ["event", record.event, run.event],
    ["workflowPath", record.workflowPath, run.workflowPath],
    ["workflowSha", record.workflowSha, run.workflowSha],
    ["protectedWorkflowSha", context.expectedWorkflowSha, run.workflowSha],
    ["expectedRunId", context.expectedRunId, run.id],
    ["expectedRunAttempt", context.expectedRunAttempt, run.runAttempt],
    ["operation", record.operation, context.expectedOperation],
    ["headRef", record.headRef, run.headRef],
    ["expectedHeadRef", context.expectedHeadRef, run.headRef],
    ["headSha", record.headSha, run.headSha],
    ["expectedHeadSha", context.expectedHeadSha, run.headSha],
    ["packages", record.packages, context.expectedManifest.packages],
    ["versions", record.versions, context.expectedManifest.versions],
    [
      "releaseSubjectSha",
      record.releaseSubjectSha,
      context.expectedManifest.releaseSubjectSha,
    ],
    ["manifestDigest", record.manifestDigest, context.expectedManifestDigest],
    [
      "files",
      record.files.map(({ filename, sha256 }) => ({ filename, sha256 })),
      context.expectedFiles.map(({ filename, sha256 }) => ({
        filename,
        sha256,
      })),
    ],
  ];
  for (const [field, expected, actual] of checks) {
    const expectedCanonical = canonicalJson(expected);
    if (expectedCanonical.isErr()) return errAsync(expectedCanonical.error);
    const actualCanonical = canonicalJson(actual);
    if (actualCanonical.isErr()) return errAsync(actualCanonical.error);
    if (expectedCanonical.value !== actualCanonical.value)
      return errAsync({ type: "BindingMismatch", field, expected, actual });
  }
  // The run's conclusion is null while downstream jobs execute.  Bind to the
  // completed, named build job instead; this preserves live identity checks
  // without accepting a failed or substituted origin job.
  if (github.listWorkflowRunJobs === undefined)
    return run.conclusion === "success"
      ? okAsync(record)
      : errAsync({
          type: "BindingMismatch",
          field: "jobConclusion",
          expected: record.originJobConclusion,
          actual: run.conclusion,
        });
  return github
    .listWorkflowRunJobs(record.runId)
    .mapErr(githubError)
    .andThen((jobs) => {
      const job = jobs.find((candidate) => candidate.id === record.originJobId);
      if (job === undefined)
        return errAsync({
          type: "BindingMismatch" as const,
          field: "originJobId",
          expected: record.originJobId,
          actual: undefined,
        });
      if (job.name !== record.originJobName)
        return errAsync({
          type: "BindingMismatch" as const,
          field: "originJobName",
          expected: record.originJobName,
          actual: job.name,
        });
      if (job.conclusion !== record.originJobConclusion)
        return errAsync({
          type: "BindingMismatch" as const,
          field: "jobConclusion",
          expected: record.originJobConclusion,
          actual: job.conclusion,
        });
      return okAsync(record);
    });
}

function verifyArtifacts(
  record: ArtifactBindingRecord,
  github: GitHubClient,
): ResultAsync<ArtifactBindingRecord, BindingError> {
  return github
    .listRunArtifacts(record.runId)
    .mapErr((error) => githubError(error))
    .andThen((runArtifacts) => {
      let result = okAsync<ArtifactBindingRecord, BindingError>(record);
      for (const expected of record.artifacts) {
        const listed = runArtifacts.find(
          (artifact) => artifact.id === expected.serverArtifactId,
        );
        if (listed === undefined)
          return errAsync({
            type: "ArtifactDeleted" as const,
            artifactId: expected.serverArtifactId,
          });
        result = result.andThen(() =>
          github
            .getArtifact(expected.serverArtifactId)
            .mapErr((error) => githubError(error, expected.serverArtifactId))
            .andThen((actual) => verifyArtifact(expected, actual, github))
            .map(() => record),
        );
      }
      return result;
    });
}

function verifyArtifact(
  expected: ArtifactBindingRecord["artifacts"][number],
  actual: ActionsArtifactMetadata,
  github: GitHubClient,
): ResultAsync<void, BindingError> {
  if (actual.id !== expected.serverArtifactId)
    return errAsync(
      mismatch("artifactId", expected.serverArtifactId, actual.id),
    );
  if (actual.expired)
    return errAsync({ type: "ArtifactExpired", artifactId: actual.id });
  if (actual.digest === undefined)
    return errAsync({ type: "ArtifactDigestMissing", artifactId: actual.id });
  const checks: readonly [string, unknown, unknown][] = [
    ["artifactName", expected.name, actual.name],
    ["uploadDigest", expected.uploadDigest, actual.digest],
    ["artifactSizeInBytes", expected.sizeInBytes, actual.sizeInBytes],
  ];
  for (const [field, expectedValue, actualValue] of checks)
    if (expectedValue !== actualValue)
      return errAsync(mismatch(field, expectedValue, actualValue));
  return github
    .downloadArtifact(expected.serverArtifactId)
    .mapErr((error) => githubError(error, expected.serverArtifactId))
    .andThen((bytes) => {
      const downloaded = digest(bytes);
      if (downloaded !== expected.uploadDigest)
        return errAsync(
          mismatch("downloadDigest", expected.uploadDigest, downloaded),
        );
      return okAsync();
    });
}

function verifyRecordDigest(
  record: ArtifactBindingRecord,
): Result<void, BindingError> {
  const { recordDigest, ...unsigned } = record;
  return canonicalJson(unsigned)
    .map((canonical) => digest(canonical))
    .andThen((expected) =>
      recordDigest === expected
        ? ok()
        : err(mismatch("recordDigest", expected, recordDigest)),
    );
}
function digest(value: string | Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}
function canonicalJson(
  value: BindingCanonicalInput,
): Result<string, BindingError> {
  return validateJsonValue(value)
    .andThen((bounded) => canonicalizeJson(bounded))
    .mapErr((error) => ({
      type: "CanonicalJsonFailed" as const,
      reason: error.reason,
    }));
}
function mismatch<T>(field: string, expected: T, actual: T): BindingError {
  return { type: "BindingMismatch", field, expected, actual };
}
type ArtifactBindingInput = Parameters<
  typeof ArtifactBindingRecordSchema.safeParse
>[0];

function invalid(issues: readonly string[]): BindingError {
  return { type: "InvalidBindingRecord", issues };
}
function githubError(
  error: { operation: string; message: string; status?: number },
  artifactId?: number,
): BindingError {
  if (error.status === 404 && artifactId !== undefined)
    return { type: "ArtifactDeleted", artifactId };
  return {
    type: "GitHubLookupFailed",
    operation: error.operation,
    message: error.message,
  };
}
