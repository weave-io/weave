import { describe, expect, it } from "bun:test";
import { okAsync, type ResultAsync } from "neverthrow";
import {
  type BindingCliDependencies,
  bindArtifacts,
  parseBindingCliInput,
} from "../bind-artifacts.js";
import type { FileSystemError, GitHubError } from "../errors.js";
import type { FileSystem } from "../filesystem.js";
import type {
  ActionsArtifactMetadata,
  GitHubClient,
  WorkflowRunMetadata,
} from "../github-client.js";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const manifest = JSON.stringify({
  schemaVersion: 1,
  releaseSubjectSha: sha,
  channel: "nightly",
  packages: ["@weaveio/weave-cli"],
  versions: { "@weaveio/weave-cli": "1.2.3-nightly.20260719.aaaaaaaaaaaa" },
  artifacts: [
    {
      filename: "@weaveio-weave-cli-1.2.3-nightly.20260719.aaaaaaaaaaaa.tgz",
      checksumFilename:
        "@weaveio-weave-cli-1.2.3-nightly.20260719.aaaaaaaaaaaa.tgz.sha256",
      sizeBytes: 12,
      sha256: digest,
    },
  ],
});
const env = {
  RELEASE_REPOSITORY: "weave-io/weave",
  RELEASE_REPOSITORY_ID: "42",
  RELEASE_WORKFLOW_PATH: ".github/workflows/publish.yml",
  RELEASE_WORKFLOW_SHA: "c".repeat(40),
  RELEASE_RUN_ID: "77",
  RELEASE_RUN_ATTEMPT: "1",
  RELEASE_EVENT: "schedule",
  RELEASE_OPERATION: "nightly",
  RELEASE_HEAD_REF: "refs/heads/main",
  RELEASE_HEAD_SHA: sha,
  RELEASE_SUBJECT_SHA: sha,
  RELEASE_PAYLOAD_ARTIFACT_ID: "101",
  RELEASE_PAYLOAD_ARTIFACT_DIGEST: digest,
  RELEASE_CONTROL_ARTIFACT_ID: "102",
  RELEASE_CONTROL_ARTIFACT_DIGEST: digest,
  RELEASE_CONTROL_PATH: "control-metadata/release-control",
  RELEASE_MANIFEST_PATH: "payload-metadata/manifest.json",
};

class MemoryFiles implements FileSystem {
  readonly writes = new Map<string, string>();
  exists(): ResultAsync<boolean, FileSystemError> {
    return okAsync(true);
  }
  readBytes(): ResultAsync<Uint8Array, FileSystemError> {
    return okAsync(new Uint8Array());
  }
  readText(): ResultAsync<string, FileSystemError> {
    return okAsync(manifest);
  }
  writeText(
    path: string,
    contents: string,
  ): ResultAsync<void, FileSystemError> {
    this.writes.set(path, contents);
    return okAsync(void 0);
  }
  delete(): ResultAsync<void, FileSystemError> {
    return okAsync(void 0);
  }
}
class MockGitHub implements GitHubClient {
  listWorkflowRunJobs() {
    return okAsync([{ id: 1, name: "build", conclusion: "success" }]);
  }
  getWorkflowRun(): ResultAsync<WorkflowRunMetadata, GitHubError> {
    return okAsync({
      repositoryId: 42,
      id: 77,
      runAttempt: 1,
      event: "schedule",
      headRef: "refs/heads/main",
      headSha: sha,
      conclusion: null,
      workflowPath: ".github/workflows/publish.yml",
      workflowSha: "c".repeat(40),
    });
  }
  getArtifact(id: number): ResultAsync<ActionsArtifactMetadata, GitHubError> {
    return okAsync({
      id,
      name: id === 101 ? "release-payload" : "release-control",
      digest,
      expired: false,
      sizeInBytes: 10,
    });
  }
  listRunArtifacts() {
    return okAsync([]);
  }
  downloadArtifact() {
    return okAsync(new Uint8Array());
  }
  createRelease() {
    return okAsync(void 0);
  }
  createTag() {
    return okAsync(void 0);
  }
}

describe("bind-artifacts CLI", () => {
  it("validates environment, binds live artifact identities, and writes the record", async () => {
    const input = parseBindingCliInput(env);
    expect(input.isOk()).toBe(true);
    if (input.isErr()) return;
    const files = new MemoryFiles();
    const result = await bindArtifacts(input.value, {
      files,
      github: new MockGitHub(),
    } satisfies BindingCliDependencies);
    expect(result.isOk()).toBe(true);
    const record = JSON.parse(
      files.writes.get(".release/binding.json") ?? "null",
    );
    expect(record.runId).toBe(77);
    expect(record.artifacts).toEqual([
      expect.objectContaining({
        serverArtifactId: 101,
        name: "release-payload",
      }),
      expect.objectContaining({
        serverArtifactId: 102,
        name: "release-control",
      }),
    ]);
  });

  it.each([
    ["missing run ID", { RELEASE_RUN_ID: undefined }],
    ["malformed digest", { RELEASE_PAYLOAD_ARTIFACT_DIGEST: "sha256:nope" }],
  ])("rejects %s environment", (_name, override) => {
    const parsed = parseBindingCliInput({ ...env, ...override });
    expect(parsed.isErr()).toBe(true);
  });
});
