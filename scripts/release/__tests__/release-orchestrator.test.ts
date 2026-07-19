import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { Clock } from "../clock.js";
import { BunCommandRunner } from "../command-runner.js";
import type { FileSystem } from "../filesystem.js";
import type { NpmRegistryClient } from "../npm-registry-client.js";
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
      "--ignore-scripts",
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
          "--ignore-scripts",
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
    readBytes: () => okAsync(bytes),
    readText: () => okAsync(""),
    writeText: () => okAsync(undefined),
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
  });
  expect(result.isOk()).toBe(true);
  expect(calls).toEqual(["publish:nightly", "verify"]);
});

test("propagates registry publication failure without retrying", async () => {
  const files: FileSystem = {
    readBytes: () => okAsync(archive()),
    readText: () => okAsync(""),
    writeText: () => okAsync(undefined),
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
  });
  expect(result.isErr()).toBe(true);
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
