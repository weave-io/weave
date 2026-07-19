import { errAsync, okAsync } from "neverthrow";
import {
  type BindingVerificationContext,
  createBindingRecord,
} from "./artifact-binding.js";
import type {
  ActionsArtifactMetadata,
  GitHubClient,
  WorkflowRunMetadata,
} from "./github-client.js";
import { type ArtifactManifest, packageArtifactFilename } from "./model.js";

export const FIXTURE_SHA = "abcdef123456".padEnd(40, "a");
export const FIXTURE_WORKFLOW_SHA = "b".repeat(40);
export const FIXTURE_BYTES = archive();
export const digest = (value: Uint8Array | string) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;

export function archive(): Uint8Array {
  const tar = new Uint8Array(1536);
  tar.set(new TextEncoder().encode("package/package.json"));
  tar.set(new TextEncoder().encode("0000644\0"), 100);
  tar.set(new TextEncoder().encode("00000000002\0"), 124);
  tar[156] = 48;
  tar.set(new TextEncoder().encode("{}"), 512);
  return Bun.gzipSync(tar);
}

export function nightlyFixture() {
  const version = "1.0.0-nightly.20260101.aaaaaaaaaaaa";
  const filename = packageArtifactFilename("@weaveio/weave-cli", version);
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    releaseSubjectSha: FIXTURE_SHA,
    channel: "nightly",
    packages: ["@weaveio/weave-cli"],
    versions: { "@weaveio/weave-cli": version },
    artifacts: [
      {
        filename,
        checksumFilename: `${filename}.sha256`,
        sizeBytes: FIXTURE_BYTES.length,
        sha256: digest(FIXTURE_BYTES),
      },
    ],
  };
  const uploadedDigest = digest(FIXTURE_BYTES);
  const input = {
    repositoryId: 1,
    workflowSha: FIXTURE_WORKFLOW_SHA,
    runId: 1,
    runAttempt: 1,
    event: "workflow_dispatch" as const,
    operation: "nightly" as const,
    headRef: "refs/heads/main" as const,
    headSha: FIXTURE_SHA,
    originJobConclusion: "success" as const,
    originJobId: 17,
    originJobName: "build" as const,
    artifacts: [
      {
        name: "release-payload",
        serverArtifactId: 1,
        uploadDigest: uploadedDigest,
        sizeInBytes: FIXTURE_BYTES.length,
      },
      {
        name: "release-control",
        serverArtifactId: 2,
        uploadDigest: uploadedDigest,
        sizeInBytes: FIXTURE_BYTES.length,
      },
    ],
    manifest,
    manifestDigest: digest(JSON.stringify(manifest)),
    files: [
      { filename, sha256: digest(FIXTURE_BYTES) },
      { filename: "release-control", sha256: digest(FIXTURE_BYTES) },
    ],
  };
  const record = createBindingRecord(input);
  if (record.isErr())
    throw new Error(`fixture binding invalid: ${record.error.type}`);
  const context: BindingVerificationContext = {
    expectedWorkflowSha: input.workflowSha,
    expectedRunId: input.runId,
    expectedRunAttempt: input.runAttempt,
    expectedOperation: input.operation,
    expectedHeadRef: input.headRef,
    expectedHeadSha: input.headSha,
    expectedManifest: manifest,
    expectedManifestDigest: input.manifestDigest,
    expectedFiles: input.files,
  };
  return { ...input, record: record.value, context, filename };
}

export class FixtureGitHub implements GitHubClient {
  constructor(
    private readonly fixture: ReturnType<typeof nightlyFixture>,
    private readonly overrides: Partial<WorkflowRunMetadata> = {},
    private readonly downloadedBytes = FIXTURE_BYTES,
    private readonly jobConclusion: "success" | "failure" | null = "success",
  ) {}
  getWorkflowRun() {
    return okAsync({
      repositoryId: this.fixture.repositoryId,
      id: this.fixture.runId,
      runAttempt: this.fixture.runAttempt,
      event: this.fixture.event,
      workflowPath: ".github/workflows/publish.yml",
      workflowSha: this.fixture.workflowSha,
      headRef: this.fixture.headRef,
      headSha: this.fixture.headSha,
      conclusion: "success" as const,
      ...this.overrides,
    });
  }
  listWorkflowRunJobs() {
    return okAsync([{ id: 17, name: "build", conclusion: this.jobConclusion }]);
  }
  listRunArtifacts() {
    return okAsync(this.artifacts());
  }
  getArtifact(id: number) {
    const artifact = this.artifacts().find((entry) => entry.id === id);
    return artifact === undefined
      ? errAsync({
          type: "GitHubError" as const,
          operation: "artifact",
          status: 404,
          message: "missing",
        })
      : okAsync(artifact);
  }
  downloadArtifact() {
    return okAsync(this.downloadedBytes);
  }
  createRelease() {
    return okAsync(undefined);
  }
  createTag() {
    return okAsync(undefined);
  }
  private artifacts(): ActionsArtifactMetadata[] {
    return this.fixture.artifacts.map((artifact) => ({
      id: artifact.serverArtifactId,
      name: artifact.name,
      digest: artifact.uploadDigest,
      expired: false,
      sizeInBytes: artifact.sizeInBytes,
    }));
  }
}
