import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  type BindingVerificationContext,
  createBindingRecord,
} from "../artifact-binding.js";
import type { Clock } from "../clock.js";
import { BunCommandRunner } from "../command-runner.js";
import type { PublicPackageName } from "../constants.js";
import type { FileSystem } from "../filesystem.js";
import type { GitHubClient } from "../github-client.js";
import type { ArtifactManifest, StableTrainRecord } from "../model.js";
import type { NpmRegistryClient } from "../npm-registry-client.js";
import { scanCredentialSources } from "../package-policy.js";
import { ReleaseOrchestrator } from "../release-orchestrator.js";
import { trainRecordDigest, validateStableTrain } from "../stable-train.js";

describe("release command allowlist", () => {
  test("rejects shell injection before spawning", async () => {
    const result = await new BunCommandRunner().run([
      "npm",
      "publish",
      "artifact.tgz;id",
      "--access",
      "public",
      "--tag",
      "nightly",
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("CommandRejected");
  });
  test("rejects a leading-dash tarball before spawning", async () => {
    const result = await new BunCommandRunner().run([
      "npm",
      "publish",
      "-x.tgz",
      "--access",
      "public",
      "--tag",
      "nightly",
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("CommandRejected");
  });
  test("rejects unexpected npm commands and extra flags", async () => {
    expect(
      (await new BunCommandRunner().run(["npm", "install", "x"])).isErr(),
    ).toBe(true);
    expect(
      (
        await new BunCommandRunner().run([
          "npm",
          "publish",
          "x.tgz",
          "--access",
          "public",
          "--tag",
          "nightly",
          "--force",
        ])
      ).isErr(),
    ).toBe(true);
  });
  test("rejects an allowlisted command with unexpected arguments", async () => {
    const runner = new BunCommandRunner();
    const result = await runner.run(["npm", "ping", "--verbose"]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("CommandRejected");
  });
});

test("orchestrates publication with injected filesystem and registry", async () => {
  const bytes = archive();
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  const files: FileSystem = {
    exists: () => okAsync(false),
    readBytes: () => okAsync(bytes),
    readText: () => okAsync(""),
    writeText: () => okAsync(undefined),
    delete: () => okAsync(undefined),
  };
  const calls: string[] = [];
  const npm: NpmRegistryClient = {
    publish: (_path, tag) => {
      calls.push(`publish:${tag}`);
      return okAsync(undefined);
    },
    viewVersion: () => okAsync(""),
    listVersions: () => okAsync([]),
    viewDistTags: () => okAsync({}),
    distTagLs: () => okAsync({}),
    verifyPublished: () => {
      calls.push("verify");
      return okAsync(undefined);
    },
  };
  const result = await new ReleaseOrchestrator(files, npm, {
    now: () => new Date(),
    sleep: () => okAsync(undefined),
  } satisfies Clock).publish({
    invocation: {
      repository: "weave-io/weave",
      workflowPath: ".github/workflows/publish.yml",
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      operation: "nightly",
      channel: "nightly",
      subjectSha: "a".repeat(40),
      packages: ["@weaveio/weave-cli"],
      versions: { "@weaveio/weave-cli": "1.0.0-nightly.20260101.aaaaaaaaaaaa" },
    },
    manifest: {
      schemaVersion: 1,
      releaseSubjectSha: "a".repeat(40),
      channel: "nightly",
      packages: ["@weaveio/weave-cli"],
      versions: { "@weaveio/weave-cli": "1.0.0-nightly.20260101.aaaaaaaaaaaa" },
      artifacts: [
        {
          filename:
            "@weaveio-weave-cli-1.0.0-nightly.20260101.aaaaaaaaaaaa.tgz",
          checksumFilename:
            "@weaveio-weave-cli-1.0.0-nightly.20260101.aaaaaaaaaaaa.tgz.sha256",
          sizeBytes: bytes.byteLength,
          sha256: digest,
        },
      ],
    },
    artifactDirectory: "/artifacts",
    bindingVerification: bindingVerification(),
  });
  expect(result.isOk()).toBe(true);
  expect(calls).toEqual(["publish:nightly", "verify"]);
});

test("credential sources are rejected before any registry use", () => {
  const fixtures = [
    {
      name: "NODE_AUTH_TOKEN",
      input: { environment: { NODE_AUTH_TOKEN: "x" } },
    },
    { name: "NPM_TOKEN", input: { environment: { NPM_TOKEN: "x" } } },
    {
      name: "npm auth config",
      input: { environment: { npm_config__auth: "x" } },
    },
    {
      name: "registry auth config",
      input: {
        environment: { "npm_config_//registry.npmjs.org/:_authToken": "x" },
      },
    },
    {
      name: "userconfig",
      input: { environment: { NPM_CONFIG_USERCONFIG: "/tmp/auth.npmrc" } },
    },
    {
      name: "project npmrc",
      input: {
        environment: {},
        configFiles: [{ path: ".npmrc", contents: "_authToken=x" }],
      },
    },
    {
      name: "user npmrc",
      input: {
        environment: {},
        configFiles: [{ path: "~/.npmrc", contents: "authToken=x" }],
      },
    },
    {
      name: "global npmrc",
      input: {
        environment: {},
        configFiles: [{ path: "/etc/npmrc", contents: "_auth=x" }],
      },
    },
    {
      name: "npm config output",
      input: {
        environment: {},
        npmConfigOutput: "//registry.npmjs.org/:_authToken=x",
      },
    },
    {
      name: "credential helper",
      input: { environment: { NPM_CREDENTIAL_HELPER: "keychain" } },
    },
  ] as const;
  for (const fixture of fixtures)
    expect(scanCredentialSources(fixture.input).isErr(), fixture.name).toBe(
      true,
    );
});

test("binding mismatches block publication before npm", async () => {
  const verification = bindingVerification();
  for (const field of ["runAttempt", "packages", "manifestDigest"] as const) {
    const record = { ...(verification.record as Record<string, unknown>) };
    if (field === "runAttempt") record[field] = 2;
    else if (field === "packages") record[field] = [];
    else record[field] = `sha256:${"0".repeat(64)}`;
    let published = false;
    const npm: NpmRegistryClient = {
      publish: () => {
        published = true;
        return okAsync(undefined);
      },
      viewVersion: () => okAsync(""),
      listVersions: () => okAsync([]),
      viewDistTags: () => okAsync({}),
      distTagLs: () => okAsync({}),
      verifyPublished: () => okAsync(undefined),
    };
    const files: FileSystem = {
      exists: () => okAsync(false),
      readBytes: () => okAsync(archive()),
      readText: () => okAsync(""),
      writeText: () => okAsync(undefined),
      delete: () => okAsync(undefined),
    };
    const result = await new ReleaseOrchestrator(files, npm, {
      now: () => new Date(),
      sleep: () => okAsync(undefined),
    }).publish({
      invocation: {
        repository: "weave-io/weave",
        workflowPath: ".github/workflows/publish.yml",
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        operation: "nightly",
        channel: "nightly",
        subjectSha: "a".repeat(40),
        packages: ["@weaveio/weave-cli"],
        versions: {
          "@weaveio/weave-cli": "1.0.0-nightly.20260101.aaaaaaaaaaaa",
        },
      },
      manifest: verification.context.expectedManifest,
      artifactDirectory: "/artifacts",
      bindingVerification: { ...verification, record },
    });
    expect(result.isErr(), field).toBe(true);
    expect(published, field).toBe(false);
  }
});

test("propagates registry publication failure without retrying", async () => {
  const files: FileSystem = {
    exists: () => okAsync(false),
    readBytes: () => okAsync(archive()),
    readText: () => okAsync(""),
    writeText: () => okAsync(undefined),
    delete: () => okAsync(undefined),
  };
  const npm: NpmRegistryClient = {
    publish: () =>
      errAsync({
        type: "RegistryError",
        operation: "publish",
        message: "denied",
      }),
    viewVersion: () => okAsync(""),
    listVersions: () => okAsync([]),
    viewDistTags: () => okAsync({}),
    distTagLs: () => okAsync({}),
    verifyPublished: () => okAsync(undefined),
  };
  const result = await new ReleaseOrchestrator(files, npm, {
    now: () => new Date(),
    sleep: () => okAsync(undefined),
  }).publish({
    invocation: {
      repository: "weave-io/weave",
      workflowPath: ".github/workflows/publish.yml",
      eventName: "schedule",
      ref: "refs/heads/main",
    },
    manifest: {},
    artifactDirectory: "/x",
    bindingVerification: bindingVerification(),
  });
  expect(result.isErr()).toBe(true);
});

test("routes stable cut planning without performing a ref mutation", async () => {
  const files: FileSystem = {
    exists: () => okAsync(false),
    readBytes: () => okAsync(new Uint8Array()),
    readText: () => okAsync(""),
    writeText: () => okAsync(undefined),
    delete: () => okAsync(undefined),
  };
  const npm: NpmRegistryClient = {
    publish: () => okAsync(undefined),
    viewVersion: () => okAsync(""),
    listVersions: () => okAsync([]),
    viewDistTags: () => okAsync({}),
    distTagLs: () => okAsync({}),
    verifyPublished: () => okAsync(undefined),
  };
  const orchestrator = new ReleaseOrchestrator(files, npm, {
    now: () => new Date("2026-07-19T00:00:00.000Z"),
    sleep: () => okAsync(undefined),
  });
  const result = await orchestrator.planStableCut({
    mainHeadSha: "a".repeat(40),
    serverCutAt: new Date("2026-07-19T00:00:00.000Z"),
    partition: {
      stableFiles: [".changeset/a.md"],
      remainOnMainFiles: [".changeset/claude.md"],
    },
    changesets: [
      {
        path: ".changeset/a.md",
        releases: new Map([["@weaveio/weave-cli", "patch"]]),
      },
    ],
    changesetContents: { ".changeset/a.md": "bytes" },
    packageVersions: {
      "@weaveio/weave-cli": "1.0.0",
      "@weaveio/weave-adapter-opencode": "1.0.0",
      "@weaveio/weave-adapter-claude-code": "1.0.0",
      "@weaveio/weave-adapter-pi": "1.0.0",
    },
  });
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value.expectedHeadSha).toBe("a".repeat(40));
});

describe("manual stable promotion", () => {
  const authorization = {
    schemaVersion: 1 as const,
    operation: "stable-publish" as const,
    state: "awaiting-promotion" as const,
    subjectSha: "a".repeat(40),
    packages: ["@weaveio/weave-cli", "@weaveio/weave-adapter-opencode"],
    versions: {
      "@weaveio/weave-cli": "1.2.3",
      "@weaveio/weave-adapter-opencode": "4.5.6",
    },
    artifactDigests: {
      "@weaveio/weave-cli": `sha256:${"1".repeat(64)}`,
      "@weaveio/weave-adapter-opencode": `sha256:${"2".repeat(64)}`,
    },
    originRunId: 123,
    awaitingPromotionTrain: stableTrain(),
  };
  const priorLatestVersions = {
    "@weaveio/weave-cli": "1.2.2",
    "@weaveio/weave-adapter-opencode": "4.5.5",
  };

  function promotionOrchestrator(tags: Record<string, Record<string, string>>) {
    const npm: NpmRegistryClient = {
      publish: () => okAsync(undefined),
      viewVersion: () => okAsync(""),
      listVersions: () => okAsync([]),
      viewDistTags: () => okAsync({}),
      distTagLs: (packageName) => okAsync(tags[packageName] ?? {}),
      verifyPublished: () => okAsync(undefined),
    };
    const files: FileSystem = {
      exists: () => okAsync(false),
      readBytes: () => okAsync(new Uint8Array()),
      readText: () => okAsync(""),
      writeText: () => okAsync(undefined),
      delete: () => okAsync(undefined),
    };
    return new ReleaseOrchestrator(files, npm, {
      now: () => new Date(),
      sleep: () => okAsync(undefined),
    });
  }

  test("gates exact human-only commands on dual next tags and tarball proofs", async () => {
    const result = await promotionOrchestrator({
      "@weaveio/weave-cli": { next: "1.2.3" },
      "@weaveio/weave-adapter-opencode": { next: "4.5.6" },
    }).generatePromotionCommands({ authorization, priorLatestVersions });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.priorLatestCaptureCommands).toEqual([
        "npm dist-tag ls @weaveio/weave-cli --json",
        "npm dist-tag ls @weaveio/weave-adapter-opencode --json",
      ]);
      expect(result.value.promoteCommands).toEqual([
        "npm dist-tag add @weaveio/weave-cli@1.2.3 latest",
        "npm dist-tag add @weaveio/weave-adapter-opencode@4.5.6 latest",
      ]);
      expect(result.value.rollbackCommands).toEqual([
        "npm dist-tag add @weaveio/weave-cli@1.2.2 latest",
        "npm dist-tag add @weaveio/weave-adapter-opencode@4.5.5 latest",
      ]);
    }
  });

  test("does not emit commands for malformed authorization or a single next match", async () => {
    const missing = await promotionOrchestrator({
      "@weaveio/weave-cli": { next: "1.2.3" },
      "@weaveio/weave-adapter-opencode": { next: "4.5.6" },
    }).generatePromotionCommands({ authorization: {}, priorLatestVersions });
    expect(missing.isErr()).toBe(true);
    const mismatch = await promotionOrchestrator({
      "@weaveio/weave-cli": { next: "1.2.3" },
      "@weaveio/weave-adapter-opencode": { next: "4.5.5" },
    }).generatePromotionCommands({ authorization, priorLatestVersions });
    expect(mismatch.isErr()).toBe(true);
  });

  test("finalize requires both exact latest tags and reports partial promotion", async () => {
    const train = stableTrain();
    const partial = await promotionOrchestrator({
      "@weaveio/weave-cli": { latest: "1.2.3" },
      "@weaveio/weave-adapter-opencode": { latest: "4.5.5" },
    }).stableFinalize(authorization, train);
    expect(partial.isErr()).toBe(true);
    if (partial.isErr()) expect(partial.error.type).toBe("PartialPromotion");
    const finalized = await promotionOrchestrator({
      "@weaveio/weave-cli": { latest: "1.2.3" },
      "@weaveio/weave-adapter-opencode": { latest: "4.5.6" },
    }).stableFinalize(authorization, train);
    expect(finalized.isOk()).toBe(true);
  });

  test("stable-finalize rejects a laundered awaiting-promotion train digest", async () => {
    const train = {
      ...stableTrain(),
      recordDigest: `sha256:${"0".repeat(64)}`,
    };
    const valid = validateStableTrain(train);
    expect(valid.isErr()).toBe(true);
    if (valid.isErr()) expect(valid.error.type).toBe("DigestMismatch");
    const command = Bun.spawn({
      cmd: ["bun", "scripts/release/stable-finalize.ts"],
      cwd: process.cwd(),
      env: {
        PATH: Bun.env.PATH,
        RELEASE_PROMOTION_AUTHORIZATION: JSON.stringify(authorization),
        RELEASE_STABLE_TRAIN: JSON.stringify(train),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await command.exited).toBe(2);
  });

  test("rejects authorization lineage mismatches before a stable transition", async () => {
    const train = stableTrain();
    const cases = [
      {
        name: "subject SHA",
        authorization: { ...authorization, subjectSha: "b".repeat(40) },
        type: "InvalidPromotionAuthorization",
      },
      {
        name: "versions",
        authorization: {
          ...authorization,
          versions: {
            ...authorization.versions,
            "@weaveio/weave-cli": "1.2.4",
          },
        },
        type: "InvalidPromotionAuthorization",
      },
      {
        name: "package set",
        authorization: {
          ...authorization,
          packages: ["@weaveio/weave-cli"],
          versions: { "@weaveio/weave-cli": "1.2.3" },
          artifactDigests: { "@weaveio/weave-cli": `sha256:${"1".repeat(64)}` },
          awaitingPromotionTrain: stableTrain(["@weaveio/weave-cli"]),
        },
        reason: "authorization train differs from finalize input",
        type: "StableTrainStateInvalid",
      },
    ] as const;
    for (const fixture of cases) {
      const result = await promotionOrchestrator({}).stableFinalize(
        fixture.authorization,
        train,
      );
      expect(result.isErr(), fixture.name).toBe(true);
      if (result.isErr()) {
        if (fixture.type === "InvalidPromotionAuthorization")
          expect(result.error.type, fixture.name).toBe(
            "InvalidPromotionAuthorization",
          );
        else {
          expect(result.error.type, fixture.name).toBe(
            "StableTrainStateInvalid",
          );
          if (result.error.type === "StableTrainStateInvalid")
            expect(result.error.reason, fixture.name).toBe(fixture.reason);
        }
      }
    }
  });

  test("promotes matching full and partial package authorization lineage", async () => {
    const cases = [
      { name: "full", authorization, train: stableTrain() },
      {
        name: "CLI only",
        authorization: {
          ...authorization,
          packages: ["@weaveio/weave-cli"],
          versions: { "@weaveio/weave-cli": "1.2.3" },
          artifactDigests: { "@weaveio/weave-cli": `sha256:${"1".repeat(64)}` },
          awaitingPromotionTrain: stableTrain(["@weaveio/weave-cli"]),
        },
        train: stableTrain(["@weaveio/weave-cli"]),
      },
    ];
    for (const fixture of cases) {
      const versions: Record<string, string> = fixture.authorization.versions;
      const result = await promotionOrchestrator(
        Object.fromEntries(
          fixture.authorization.packages.map((packageName) => [
            packageName,
            { latest: versions[packageName] },
          ]),
        ),
      ).stableFinalize(fixture.authorization, fixture.train);
      expect(result.isOk(), fixture.name).toBe(true);
      if (result.isOk())
        expect(result.value.stableTrain.state).toBe("promoted");
    }
  });

  test("rejects partial and full package authorization crossovers", async () => {
    const cliOnlyAuthorization = {
      ...authorization,
      packages: ["@weaveio/weave-cli"],
      versions: { "@weaveio/weave-cli": "1.2.3" },
      artifactDigests: { "@weaveio/weave-cli": `sha256:${"1".repeat(64)}` },
      awaitingPromotionTrain: stableTrain(["@weaveio/weave-cli"]),
    };
    const cases = [
      {
        name: "one-package train and two-package authorization",
        train: stableTrain(["@weaveio/weave-cli"]),
        authorization,
      },
      {
        name: "two-package train and one-package authorization",
        train: stableTrain(),
        authorization: cliOnlyAuthorization,
      },
    ];
    for (const fixture of cases) {
      const result = await promotionOrchestrator({}).stableFinalize(
        fixture.authorization,
        fixture.train,
      );
      expect(result.isErr(), fixture.name).toBe(true);
      if (result.isErr()) {
        expect(result.error.type, fixture.name).toBe("StableTrainStateInvalid");
        if (result.error.type === "StableTrainStateInvalid")
          expect(result.error.reason, fixture.name).toBe(
            "authorization train differs from finalize input",
          );
      }
    }
  });

  test("verifies the human-executed rollback against recorded prior versions", async () => {
    const result = await promotionOrchestrator({
      "@weaveio/weave-cli": { latest: "1.2.2" },
      "@weaveio/weave-adapter-opencode": { latest: "4.5.5" },
    }).verifyPromotionRollback(authorization, priorLatestVersions);
    expect(result.isOk()).toBe(true);
  });
});

function stableTrain(
  packages: readonly PublicPackageName[] = [
    "@weaveio/weave-cli",
    "@weaveio/weave-adapter-opencode",
  ],
): StableTrainRecord {
  const versions: Record<string, string> = Object.fromEntries(
    packages.map((packageName) => [
      packageName,
      packageName === "@weaveio/weave-cli" ? "1.2.3" : "4.5.6",
    ]),
  );
  const content = {
    schemaVersion: 1 as const,
    trainRef: "release/20300101-aaaaaaaaaaaa",
    subjectSha: "a".repeat(40),
    cutAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-08T00:00:00.000Z",
    state: "awaiting-promotion" as const,
    packages: [...packages],
    versions,
    artifactManifestDigest: `sha256:${"b".repeat(64)}`,
    artifactIds: packages.map((_, index) => index + 1),
  };
  return {
    ...content,
    recordDigest: trainRecordDigest(content),
  } as StableTrainRecord;
}

function archive(): Uint8Array {
  const tar = new Uint8Array(1536);
  tar.set(new TextEncoder().encode("package/package.json"));
  tar.set(new TextEncoder().encode("0000644\0"), 100);
  tar.set(new TextEncoder().encode("00000000002\0"), 124);
  tar[156] = 48;
  tar.set(new TextEncoder().encode("{}"), 512);
  return Bun.gzipSync(tar);
}

function bindingVerification(): {
  record: unknown;
  context: BindingVerificationContext;
  github: GitHubClient;
} {
  const bytes = archive();
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  const manifest: ArtifactManifest = {
    schemaVersion: 1 as const,
    releaseSubjectSha: "a".repeat(40),
    channel: "nightly" as const,
    packages: ["@weaveio/weave-cli"],
    versions: { "@weaveio/weave-cli": "1.0.0-nightly.20260101.aaaaaaaaaaaa" },
    artifacts: [
      {
        filename: "@weaveio-weave-cli-1.0.0-nightly.20260101.aaaaaaaaaaaa.tgz",
        checksumFilename:
          "@weaveio-weave-cli-1.0.0-nightly.20260101.aaaaaaaaaaaa.tgz.sha256",
        sizeBytes: bytes.byteLength,
        sha256: digest,
      },
    ],
  };
  const artifactBytes = new Uint8Array([1]);
  const uploadDigest = `sha256:${new Bun.CryptoHasher("sha256").update(artifactBytes).digest("hex")}`;
  const record = createBindingRecord({
    repositoryId: 1,
    workflowSha: "b".repeat(40),
    runId: 1,
    runAttempt: 1,
    event: "workflow_dispatch",
    operation: "nightly",
    headRef: "refs/heads/main",
    headSha: "a".repeat(40),
    originJobConclusion: "success",
    artifacts: [
      {
        name: "release-payload",
        serverArtifactId: 1,
        uploadDigest,
        sizeInBytes: 1,
      },
      {
        name: "release-control",
        serverArtifactId: 2,
        uploadDigest,
        sizeInBytes: 1,
      },
    ],
    manifest,
    manifestDigest: digest,
    files: [
      ...manifest.artifacts.map(({ filename, sha256 }) => ({
        filename,
        sha256,
      })),
      { filename: "release-control", sha256: uploadDigest },
    ],
  });
  if (record.isErr()) throw new Error("fixture binding invalid");
  const metadata = (id: number, name: string) => ({
    id,
    name,
    digest: uploadDigest,
    expired: false,
    sizeInBytes: 1,
  });
  const github: GitHubClient = {
    getWorkflowRun: () =>
      okAsync({
        repositoryId: 1,
        id: 1,
        runAttempt: 1,
        event: "workflow_dispatch",
        headRef: "refs/heads/main",
        headSha: "a".repeat(40),
        conclusion: "success",
        workflowPath: ".github/workflows/publish.yml",
        workflowSha: "b".repeat(40),
      }),
    listRunArtifacts: () =>
      okAsync([metadata(1, "release-payload"), metadata(2, "release-control")]),
    getArtifact: (id) =>
      okAsync(metadata(id, id === 1 ? "release-payload" : "release-control")),
    downloadArtifact: () => okAsync(artifactBytes),
    createRelease: () => okAsync(undefined),
    createTag: () => okAsync(undefined),
  };
  return {
    record: record.value,
    context: {
      expectedWorkflowSha: "b".repeat(40),
      expectedRunId: 1,
      expectedRunAttempt: 1,
      expectedOperation: "nightly",
      expectedHeadRef: "refs/heads/main",
      expectedHeadSha: "a".repeat(40),
      expectedManifest: manifest,
      expectedManifestDigest: digest,
      expectedFiles: [
        ...manifest.artifacts.map(({ filename, sha256 }) => ({
          filename,
          sha256,
        })),
        { filename: "release-control", sha256: uploadDigest },
      ],
    },
    github,
  };
}
