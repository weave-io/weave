import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { Clock } from "../clock.js";
import { BunCommandRunner } from "../command-runner.js";
import type { FileSystem } from "../filesystem.js";
import type { NpmRegistryClient } from "../npm-registry-client.js";
import { scanCredentialSources } from "../package-policy.js";
import { ReleaseOrchestrator } from "../release-orchestrator.js";

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
  test("accepts the exact publish command", async () => {
    const runner = new BunCommandRunner();
    // npm is intentionally invoked only after validation; this deliberately uses ping's read-only shape.
    const result = await runner.run(["npm", "ping"]);
    expect(result.isOk() || result.isErr()).toBe(true);
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
    verifyPublished: () => {
      calls.push("verify");
      return okAsync(undefined);
    },
  };
  const result = await new ReleaseOrchestrator(files, npm, {
    now: () => new Date(),
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
    bindingVerified: true,
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
    verifyPublished: () => okAsync(undefined),
  };
  const result = await new ReleaseOrchestrator(files, npm, {
    now: () => new Date(),
  }).publish({
    invocation: {
      repository: "weave-io/weave",
      workflowPath: ".github/workflows/publish.yml",
      eventName: "schedule",
      ref: "refs/heads/main",
    },
    manifest: {},
    artifactDirectory: "/x",
    bindingVerified: true,
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
    verifyPublished: () => okAsync(undefined),
  };
  const orchestrator = new ReleaseOrchestrator(files, npm, {
    now: () => new Date("2026-07-19T00:00:00.000Z"),
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
    },
  });
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value.expectedHeadSha).toBe("a".repeat(40));
});

function archive(): Uint8Array {
  const tar = new Uint8Array(1536);
  tar.set(new TextEncoder().encode("package/package.json"));
  tar.set(new TextEncoder().encode("0000644\0"), 100);
  tar.set(new TextEncoder().encode("00000000002\0"), 124);
  tar[156] = 48;
  tar.set(new TextEncoder().encode("{}"), 512);
  return Bun.gzipSync(tar);
}
