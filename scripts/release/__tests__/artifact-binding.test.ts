import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  type BindingRecordInput,
  type BindingVerificationContext,
  createBindingRecord,
  verifyBindingRecord,
} from "../artifact-binding.js";
import type {
  ActionsArtifactMetadata,
  GitHubClient,
  WorkflowRunMetadata,
} from "../github-client.js";
import type { ArtifactManifest } from "../model.js";

const bytes = new TextEncoder().encode("payload artifact bytes");
const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
const manifest: ArtifactManifest = {
  schemaVersion: 1 as const,
  releaseSubjectSha: "a".repeat(40),
  channel: "stable" as const,
  packages: ["@weaveio/weave-cli"],
  versions: { "@weaveio/weave-cli": "1.2.3" },
  artifacts: [
    {
      filename: "@weaveio-weave-cli-1.2.3.tgz",
      checksumFilename: "@weaveio-weave-cli-1.2.3.tgz.sha256",
      sizeBytes: 12,
      sha256: digest,
    },
  ],
};
const input: BindingRecordInput = {
  repositoryId: 42,
  workflowSha: "b".repeat(40),
  runId: 77,
  runAttempt: 1,
  event: "workflow_dispatch",
  operation: "stable-cut",
  headRef: "refs/heads/main",
  headSha: "c".repeat(40),
  originJobConclusion: "success",
  artifacts: [
    {
      name: "payload",
      serverArtifactId: 101,
      uploadDigest: digest,
      sizeInBytes: bytes.length,
    },
    {
      name: "control",
      serverArtifactId: 102,
      uploadDigest: digest,
      sizeInBytes: bytes.length,
    },
  ],
  manifest,
  manifestDigest: digest,
  files: [
    { filename: "@weaveio-weave-cli-1.2.3.tgz", sha256: digest },
    { filename: "release-control", sha256: digest },
  ],
};
function record(overrides: Partial<BindingRecordInput> = {}) {
  const created = createBindingRecord({ ...input, ...overrides });
  if (created.isErr()) throw new Error(JSON.stringify(created.error));
  return created.value;
}
class MockGitHub implements GitHubClient {
  constructor(
    readonly run: WorkflowRunMetadata,
    readonly artifacts: readonly ActionsArtifactMetadata[],
  ) {}
  getWorkflowRun() {
    return okAsync(this.run);
  }
  listWorkflowRunJobs() {
    return okAsync([{ id: 1, name: "build", conclusion: "success" }]);
  }
  listRunArtifacts() {
    return okAsync(this.artifacts);
  }
  getArtifact(id: number) {
    const artifact = this.artifacts.find((candidate) => candidate.id === id);
    return artifact === undefined
      ? errAsync({
          type: "GitHubError" as const,
          operation: "artifact",
          status: 404,
          message: "gone",
        })
      : okAsync(artifact);
  }
  downloadArtifact() {
    return okAsync(bytes);
  }
  createRelease() {
    return okAsync();
  }
  createTag() {
    return okAsync();
  }
}
function context(): BindingVerificationContext {
  return {
    expectedWorkflowSha: input.workflowSha,
    expectedRunId: input.runId,
    expectedRunAttempt: input.runAttempt,
    expectedOperation: input.operation,
    expectedHeadRef: input.headRef,
    expectedHeadSha: input.headSha,
    expectedManifest: manifest,
    expectedManifestDigest: digest,
    expectedFiles: input.files,
  };
}
function github(
  overrides: Partial<WorkflowRunMetadata> = {},
  artifacts?: readonly ActionsArtifactMetadata[],
) {
  const run: WorkflowRunMetadata = {
    repositoryId: input.repositoryId,
    id: input.runId,
    runAttempt: input.runAttempt,
    event: input.event,
    headRef: input.headRef,
    headSha: input.headSha,
    conclusion: "success",
    workflowPath: ".github/workflows/publish.yml",
    workflowSha: input.workflowSha,
    ...overrides,
  };
  return new MockGitHub(
    run,
    artifacts ??
      input.artifacts.map((artifact) => ({
        id: artifact.serverArtifactId,
        name: artifact.name,
        digest: artifact.uploadDigest,
        expired: false,
        sizeInBytes: artifact.sizeInBytes,
      })),
  );
}

describe("artifact binding", () => {
  it("creates and verifies a server-bound record", async () => {
    const result = await verifyBindingRecord(record(), context(), github());
    expect(result.isOk()).toBe(true);
  });
  const serverSwaps: {
    name: string;
    client: () => MockGitHub;
    override: Partial<BindingVerificationContext>;
  }[] = [
    {
      name: "repository ID",
      client: () => github({ repositoryId: 9 }),
      override: {},
    },
    {
      name: "workflow path",
      client: () => github({ workflowPath: ".github/workflows/other.yml" }),
      override: {},
    },
    {
      name: "workflow SHA",
      client: () => github({ workflowSha: "d".repeat(40) }),
      override: {},
    },
    { name: "run ID", client: () => github({ id: 78 }), override: {} },
    {
      name: "rerun attempt",
      client: () => github({ runAttempt: 2 }),
      override: {},
    },
    {
      name: "expected run ID",
      client: () => github(),
      override: { expectedRunId: 78 },
    },
    {
      name: "expected run attempt",
      client: () => github(),
      override: { expectedRunAttempt: 2 },
    },
    {
      name: "event",
      client: () => github({ event: "schedule" }),
      override: {},
    },
    {
      name: "operation",
      client: () => github(),
      override: { expectedOperation: "nightly" },
    },
    {
      name: "head ref",
      client: () => github({ headRef: "release/20260101-abcdefabcdef" }),
      override: {},
    },
    {
      name: "head SHA",
      client: () => github({ headSha: "d".repeat(40) }),
      override: {},
    },
    {
      name: "artifact ID",
      client: () =>
        github({}, [
          {
            id: 999,
            name: "payload",
            digest,
            expired: false,
            sizeInBytes: bytes.length,
          },
          {
            id: 102,
            name: "control",
            digest,
            expired: false,
            sizeInBytes: bytes.length,
          },
        ]),
      override: {},
    },
    {
      name: "upload digest",
      client: () =>
        github({}, [
          {
            id: 101,
            name: "payload",
            digest: `sha256:${"e".repeat(64)}`,
            expired: false,
            sizeInBytes: bytes.length,
          },
          {
            id: 102,
            name: "control",
            digest,
            expired: false,
            sizeInBytes: bytes.length,
          },
        ]),
      override: {},
    },
  ];
  it.each(serverSwaps)("rejects swapped $name", async ({
    client,
    override,
  }) => {
    const result = await verifyBindingRecord(
      record(),
      { ...context(), ...override },
      client(),
    );
    expect(result.isErr()).toBe(true);
  });
  it.each<[string, ArtifactManifest]>([
    [
      "package",
      {
        ...manifest,
        packages: ["@weaveio/weave-adapter-opencode"],
        versions: { "@weaveio/weave-adapter-opencode": "1.2.3" },
        artifacts: [
          {
            filename: "@weaveio-weave-adapter-opencode-1.2.3.tgz",
            checksumFilename:
              "@weaveio-weave-adapter-opencode-1.2.3.tgz.sha256",
            sizeBytes: 12,
            sha256: digest,
          },
        ],
      },
    ],
    [
      "version",
      {
        ...manifest,
        versions: { "@weaveio/weave-cli": "9.9.9" },
        artifacts: [
          {
            filename: "@weaveio-weave-cli-9.9.9.tgz",
            checksumFilename: "@weaveio-weave-cli-9.9.9.tgz.sha256",
            sizeBytes: 12,
            sha256: digest,
          },
        ],
      },
    ],
    ["file digest", manifest],
  ])("rejects swapped %s", async (name, changedManifest) => {
    const changedFiles =
      name === "file digest"
        ? [
            {
              filename: input.files[0].filename,
              sha256: `sha256:${"f".repeat(64)}`,
            },
          ]
        : input.files;
    const result = await verifyBindingRecord(
      record({ manifest: changedManifest, files: changedFiles }),
      context(),
      github(),
    );
    expect(result.isErr()).toBe(true);
  });
  it("fails closed for expired, deleted, missing digest, and downloaded digest mismatches", async () => {
    for (const artifacts of [
      [
        {
          id: 101,
          name: "payload",
          digest,
          expired: true,
          sizeInBytes: bytes.length,
        },
      ],
      [
        {
          id: 102,
          name: "control",
          digest,
          expired: false,
          sizeInBytes: bytes.length,
        },
      ],
      [
        { id: 101, name: "payload", expired: false, sizeInBytes: bytes.length },
        {
          id: 102,
          name: "control",
          digest,
          expired: false,
          sizeInBytes: bytes.length,
        },
      ],
    ])
      expect(
        (
          await verifyBindingRecord(record(), context(), github({}, artifacts))
        ).isErr(),
      ).toBe(true);
  });
});
