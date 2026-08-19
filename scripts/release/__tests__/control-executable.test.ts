import { expect, test } from "bun:test";
import { join } from "node:path";
import { createBindingRecord } from "../artifact-binding.js";
import type { ArtifactManifest } from "../model.js";
import { trainRecordDigest } from "../stable-train.js";

test("compiled control is self-contained and digest recorded", async () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const build = Bun.spawn(["bun", "scripts/build-release-control.ts"], {
    cwd: root,
  });
  expect(await build.exited).toBe(0);
  const binary = join(root, "dist-release-control", "release-control");
  const expected = (
    await Bun.file(
      join(root, "dist-release-control", "release-control.sha256"),
    ).text()
  ).split("  ")[0];
  const actual = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(binary).bytes())
    .digest("hex");
  expect(actual).toBe(expected);
  const temp = await mktemp();
  const run = Bun.spawn([binary, "--help"], {
    cwd: temp,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await run.exited).toBe(0);
});

test("compiled control dry-runs publication from a clean directory", async () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const build = Bun.spawn(["bun", "scripts/build-release-control.ts"], {
    cwd: root,
  });
  expect(await build.exited).toBe(0);

  const temp = await mktemp();
  const sourceBinary = join(root, "dist-release-control", "release-control");
  const binary = join(temp, "release-control");
  const binaryBytes = await Bun.file(sourceBinary).bytes();
  const recordedDigest = (
    await Bun.file(
      join(root, "dist-release-control", "release-control.sha256"),
    ).text()
  ).split("  ")[0];
  await Bun.write(binary, binaryBytes);
  const chmod = Bun.spawn(["chmod", "+x", binary]);
  expect(await chmod.exited).toBe(0);

  const artifact = archive();
  const artifactFilename = "@weaveio-weave-cli-1.0.0.tgz";
  const artifactDigest = digest(artifact);
  const trainContent = {
    schemaVersion: 1 as const,
    trainRef: "release/20260719-aaaaaaaaaaaa",
    subjectSha: "a".repeat(40),
    cutAt: "2026-12-19T00:00:00.000Z",
    expiresAt: "2026-12-26T00:00:00.000Z",
    state: "bound" as const,
    packages: ["@weaveio/weave-cli"] as "@weaveio/weave-cli"[],
    versions: { "@weaveio/weave-cli": "1.0.0" },
    artifactManifestDigest: `sha256:${"c".repeat(64)}`,
    artifactIds: [1],
  };
  const stableTrain = {
    ...trainContent,
    recordDigest: trainRecordDigest(trainContent),
  };
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    releaseSubjectSha: "a".repeat(40),
    channel: "stable",
    packages: ["@weaveio/weave-cli"],
    versions: {
      "@weaveio/weave-cli": "1.0.0",
    },
    artifacts: [
      {
        filename: artifactFilename,
        checksumFilename: `${artifactFilename}.sha256`,
        sizeBytes: artifact.byteLength,
        sha256: artifactDigest,
      },
    ],
    stableTrain,
  };
  const manifestText = JSON.stringify(manifest);
  const uploadedBytes = new Uint8Array([1]);
  const uploadedDigest = digest(uploadedBytes);
  const binaryDigest = digest(binaryBytes);
  expect(binaryDigest.replace("sha256:", "")).toBe(recordedDigest);
  const binding = createBindingRecord({
    repositoryId: 1,
    workflowSha: "b".repeat(40),
    runId: 1,
    runAttempt: 1,
    event: "workflow_dispatch",
    operation: "stable-publish",
    headRef: "refs/heads/main",
    headSha: "a".repeat(40),
    originJobConclusion: "success",
    originJobId: 17,
    originJobName: "build",
    artifacts: [
      {
        name: "release-payload",
        serverArtifactId: 1,
        uploadDigest: uploadedDigest,
        sizeInBytes: uploadedBytes.byteLength,
      },
      {
        name: "release-control",
        serverArtifactId: 2,
        uploadDigest: uploadedDigest,
        sizeInBytes: uploadedBytes.byteLength,
      },
    ],
    manifest,
    manifestDigest: digest(manifestText),
    stableTrain,
    files: [
      { filename: artifactFilename, sha256: artifactDigest },
      { filename: "release-control", sha256: binaryDigest },
    ],
  });
  expect(binding.isOk()).toBe(true);
  if (binding.isErr()) return;

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const run = {
        repository: { id: 1 },
        id: 1,
        run_attempt: 1,
        event: "workflow_dispatch",
        head_branch: "refs/heads/main",
        head_sha: "a".repeat(40),
        conclusion: "success",
        path: `.github/workflows/publish.yml@${"b".repeat(40)}`,
      };
      const metadata = (id: number, name: string) => ({
        id,
        name,
        digest: uploadedDigest,
        expired: false,
        size_in_bytes: uploadedBytes.byteLength,
      });
      if (path.endsWith("/actions/runs/1")) return Response.json(run);
      if (path.endsWith("/actions/runs/1/jobs"))
        return Response.json({
          jobs: [{ id: 17, name: "build", conclusion: "success" }],
        });
      if (path.endsWith("/actions/runs/1/artifacts"))
        return Response.json({
          artifacts: [
            metadata(1, "release-payload"),
            metadata(2, "release-control"),
          ],
        });
      const artifactMatch = path.match(/\/actions\/artifacts\/(\d+)(\/zip)?$/);
      if (artifactMatch === null)
        return new Response("unexpected request", { status: 404 });
      if (artifactMatch[2] === "/zip") return new Response(uploadedBytes);
      const id = Number(artifactMatch[1]);
      return Response.json(
        metadata(id, id === 1 ? "release-payload" : "release-control"),
      );
    },
  });
  const invocation = {
    repository: "weave-io/weave",
    workflowPath: ".github/workflows/publish.yml",
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    operation: "stable-publish",
    channel: "stable",
    subjectSha: "a".repeat(40),
    packages: ["@weaveio/weave-cli"],
    versions: manifest.versions,
  };
  const artifacts = join(temp, "artifacts");
  const mkdir = Bun.spawn(["mkdir", "-p", artifacts]);
  expect(await mkdir.exited).toBe(0);
  await Bun.write(join(artifacts, artifactFilename), artifact);
  await Bun.write(join(temp, "invocation.json"), JSON.stringify(invocation));
  await Bun.write(join(temp, "manifest.json"), manifestText);
  await Bun.write(join(temp, "binding.json"), JSON.stringify(binding.value));

  const run = Bun.spawn(
    [binary, "invocation.json", "manifest.json", "artifacts", "binding.json"],
    {
      cwd: temp,
      env: {
        RELEASE_CONTROL_DRY_RUN: "true",
        RELEASE_WORKFLOW_SHA: "b".repeat(40),
        RELEASE_HEAD_REF: "refs/heads/main",
        RELEASE_HEAD_SHA: "a".repeat(40),
        RELEASE_RUN_ID: "1",
        RELEASE_RUN_ATTEMPT: "1",
        RELEASE_GITHUB_API_URL: server.url.toString().replace(/\/$/, ""),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  server.stop();

  expect(exitCode).toBe(0);
  expect(`${stdout}${stderr}`).toContain(
    `npm publish artifacts/${artifactFilename} --access public --tag next`,
  );
  expect(`${stdout}${stderr}`).toContain(
    "npm dist-tag add @weaveio/weave-cli@1.0.0 latest",
  );
  expect(`${stdout}${stderr}`).toContain(
    "npm dist-tag add @weaveio/weave-cli@0.0.0-18 latest",
  );
  expect(await Bun.file(join(temp, "node_modules")).exists()).toBe(false);
  expect(digest(await Bun.file(binary).bytes())).toBe(binaryDigest);
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

function digest(value: string | Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

async function mktemp(): Promise<string> {
  const path = `/tmp/weave-release-control-${crypto.randomUUID()}`;
  const process = Bun.spawn(["mkdir", "-p", path]);
  if ((await process.exited) !== 0) throw new Error("mkdir failed");
  return path;
}
