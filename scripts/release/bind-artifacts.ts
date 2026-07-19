import { logger } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import { type BindingError, createBindingRecord } from "./artifact-binding.js";
import { validateArtifactManifest } from "./artifact-manifest.js";
import type { FileSystem } from "./filesystem.js";
import type { GitHubClient } from "./github-client.js";
import {
  type ArtifactBindingCliInput,
  ArtifactBindingCliInputSchema,
} from "./input-validation.js";
import type { ArtifactManifest } from "./model.js";
import { bindStableTrain } from "./stable-train.js";

const log = logger.child({ module: "release-artifact-binding" });

export type BindingCliError =
  | { type: "InvalidBindingInput"; issues: readonly string[] }
  | { type: "ManifestReadFailed"; path: string }
  | { type: "BindingWriteFailed"; path: string }
  | { type: "InvalidManifestJson"; path: string }
  | { type: "InvalidManifest"; issues: readonly string[] }
  | { type: "SubjectMismatch"; expected: string; actual: string }
  | BindingError;

export interface BindingCliDependencies {
  files: FileSystem;
  github: GitHubClient;
}

/** Parses the explicit workflow environment without accepting unknown fields. */
export function parseBindingCliInput(
  env: Record<string, string | undefined>,
): Result<ArtifactBindingCliInput, BindingCliError> {
  const parsed = ArtifactBindingCliInputSchema.safeParse({
    repository: env.RELEASE_REPOSITORY,
    repositoryId: env.RELEASE_REPOSITORY_ID,
    workflowPath: env.RELEASE_WORKFLOW_PATH,
    workflowSha: env.RELEASE_WORKFLOW_SHA,
    runId: env.RELEASE_RUN_ID,
    runAttempt: env.RELEASE_RUN_ATTEMPT,
    event: env.RELEASE_EVENT,
    operation: env.RELEASE_OPERATION,
    headRef: env.RELEASE_HEAD_REF,
    headSha: env.RELEASE_HEAD_SHA,
    subjectSha: env.RELEASE_SUBJECT_SHA,
    payload: {
      serverArtifactId: env.RELEASE_PAYLOAD_ARTIFACT_ID,
      uploadDigest: env.RELEASE_PAYLOAD_ARTIFACT_DIGEST,
    },
    control: {
      serverArtifactId: env.RELEASE_CONTROL_ARTIFACT_ID,
      uploadDigest: env.RELEASE_CONTROL_ARTIFACT_DIGEST,
    },
    controlPath: env.RELEASE_CONTROL_PATH,
    manifestPath: env.RELEASE_MANIFEST_PATH,
  });
  if (!parsed.success)
    return err({
      type: "InvalidBindingInput",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}

/** Validates live Actions identity, then persists the content-addressed binding. */
export function bindArtifacts(
  input: ArtifactBindingCliInput,
  dependencies: BindingCliDependencies,
): ResultAsync<void, BindingCliError> {
  return dependencies.files
    .readText(input.manifestPath)
    .mapErr(() => ({
      type: "ManifestReadFailed" as const,
      path: input.manifestPath,
    }))
    .andThen((text) => parseManifest(text, input.manifestPath))
    .andThen(({ manifest, text }) => {
      if (manifest.releaseSubjectSha !== input.subjectSha)
        return errAsync({
          type: "SubjectMismatch" as const,
          expected: input.subjectSha,
          actual: manifest.releaseSubjectSha,
        });
      return dependencies.github
        .getWorkflowRun(input.runId)
        .mapErr(toGitHubError)
        .andThen((run) => {
          const fields: readonly [string, unknown, unknown][] = [
            ["repositoryId", input.repositoryId, run.repositoryId],
            ["runId", input.runId, run.id],
            ["runAttempt", input.runAttempt, run.runAttempt],
            ["event", input.event, run.event],
            ["workflowPath", input.workflowPath, run.workflowPath],
            ["workflowSha", input.workflowSha, run.workflowSha],
            ["headRef", input.headRef, run.headRef],
            ["headSha", input.headSha, run.headSha],
          ];
          for (const [field, expected, actual] of fields)
            if (expected !== actual)
              return errAsync({
                type: "BindingMismatch" as const,
                field,
                expected,
                actual,
              });
          if (dependencies.github.listWorkflowRunJobs === undefined)
            return errAsync({
              type: "GitHubLookupFailed" as const,
              operation: "list workflow jobs",
              message: "job identity lookup unavailable",
            });
          return dependencies.github
            .listWorkflowRunJobs(input.runId)
            .mapErr(toGitHubError)
            .andThen((jobs) => {
              const originBuildJob = jobs.find(
                (job) => job.name === "build" && job.conclusion === "success",
              );
              if (originBuildJob === undefined)
                return errAsync({
                  type: "BindingMismatch" as const,
                  field: "originBuildJob",
                  expected: "completed build job",
                  actual: jobs,
                });
              return dependencies.github
                .getArtifact(input.payload.serverArtifactId)
                .mapErr(toGitHubError)
                .andThen((payload) =>
                  dependencies.github
                    .getArtifact(input.control.serverArtifactId)
                    .mapErr(toGitHubError)
                    .andThen((control) => {
                      const artifacts = [
                        {
                          name: "release-payload",
                          expected: input.payload,
                          actual: payload,
                        },
                        {
                          name: "release-control",
                          expected: input.control,
                          actual: control,
                        },
                      ];
                      for (const artifact of artifacts) {
                        if (artifact.actual.expired)
                          return errAsync({
                            type: "ArtifactExpired" as const,
                            artifactId: artifact.actual.id,
                          });
                        if (artifact.actual.digest === undefined)
                          return errAsync({
                            type: "ArtifactDigestMissing" as const,
                            artifactId: artifact.actual.id,
                          });
                        if (artifact.actual.name !== artifact.name)
                          return errAsync({
                            type: "BindingMismatch" as const,
                            field: "artifactName",
                            expected: artifact.name,
                            actual: artifact.actual.name,
                          });
                        if (
                          artifact.actual.digest !==
                          artifact.expected.uploadDigest
                        )
                          return errAsync({
                            type: "BindingMismatch" as const,
                            field: "artifactDigest",
                            expected: artifact.expected.uploadDigest,
                            actual: artifact.actual.digest,
                          });
                      }
                      return dependencies.files
                        .readBytes(input.controlPath)
                        .mapErr(() => ({
                          type: "ManifestReadFailed" as const,
                          path: input.controlPath,
                        }))
                        .andThen((controlBytes) => {
                          const stableTrain =
                            manifest.stableTrain === undefined
                              ? undefined
                              : bindStableTrain(
                                  manifest.stableTrain as never,
                                  digest(text),
                                  artifacts.map(({ actual }) => actual.id),
                                );
                          if (stableTrain !== undefined && stableTrain.isErr())
                            return errAsync({
                              type: "InvalidManifest" as const,
                              issues: [stableTrain.error.type],
                            });
                          const record = createBindingRecord({
                            repositoryId: input.repositoryId,
                            workflowSha: input.workflowSha,
                            runId: input.runId,
                            runAttempt: input.runAttempt,
                            event: input.event,
                            operation: input.operation,
                            headRef: input.headRef,
                            headSha: input.headSha,
                            originJobConclusion: "success",
                            originJobId: originBuildJob.id,
                            originJobName: "build",
                            artifacts: artifacts.map(({ name, actual }) => ({
                              name,
                              serverArtifactId: actual.id,
                              uploadDigest: actual.digest as string,
                              sizeInBytes: actual.sizeInBytes,
                            })),
                            manifest,
                            manifestDigest: digest(text),
                            stableTrain: stableTrain?.isOk()
                              ? stableTrain.value
                              : undefined,
                            files: [
                              ...manifest.artifacts.map(
                                ({ filename, sha256 }) => ({
                                  filename,
                                  sha256,
                                }),
                              ),
                              {
                                filename: "release-control",
                                sha256: digest(controlBytes),
                              },
                            ],
                          });
                          if (record.isErr()) return errAsync(record.error);
                          return dependencies.files
                            .writeText(
                              ".release/binding.json",
                              `${JSON.stringify(record.value)}\n`,
                            )
                            .mapErr(() => ({
                              type: "BindingWriteFailed" as const,
                              path: ".release/binding.json",
                            }));
                        });
                    }),
                );
            });
        });
    });
}

function parseManifest(
  text: string,
  path: string,
): ResultAsync<{ manifest: ArtifactManifest; text: string }, BindingCliError> {
  const json = Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    () => ({ type: "InvalidManifestJson" as const, path }),
  )();
  if (json.isErr()) return errAsync(json.error);
  const manifest = validateArtifactManifest(json.value);
  if (manifest.isErr())
    return errAsync({ type: "InvalidManifest", issues: manifest.error.issues });
  return okAsync({ manifest: manifest.value, text });
}
function toGitHubError(error: {
  operation: string;
  message: string;
}): BindingError {
  return {
    type: "GitHubLookupFailed",
    operation: error.operation,
    message: error.message,
  };
}
function digest(value: string | Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

if (import.meta.main) {
  const input = parseBindingCliInput(Bun.env);
  if (input.isErr()) {
    log.error({ error: input.error }, "invalid artifact-binding input");
    process.exitCode = 2;
  } else {
    const { BunFileSystem } = await import("./filesystem.js");
    const { GitHubRestClient } = await import("./github-client.js");
    const result = await bindArtifacts(input.value, {
      files: new BunFileSystem(),
      github: new GitHubRestClient(
        input.value.repository,
        Bun.env.GITHUB_TOKEN,
      ),
    });
    if (result.isErr()) {
      log.error({ error: result.error }, "artifact binding failed");
      process.exitCode = 1;
    }
  }
}
