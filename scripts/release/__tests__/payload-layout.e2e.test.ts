import { expect, test } from "bun:test";
import { join } from "node:path";
import { packageArtifactFilename } from "../model.js";
import { archive, digest } from "../release-fixtures.js";
import { trainRecordDigest } from "../stable-train.js";
import { writeArtifactManifest } from "../write-artifact-manifest.js";

test("nightly payload layout writes canonical archives, checksums, and planned versions", async () => {
  const root = process.cwd();
  const run = `validate-e2e-${crypto.randomUUID()}`;
  const version = "1.10.0-nightly.20260719.abcdef123456";
  const filename = packageArtifactFilename("@weaveio/weave-cli", version);
  const tarball = archive();
  const stage = join(root, ".release", run, "staging", "cli");
  const tarballs = join(root, ".release", run, "tarballs");
  const reset = Bun.spawn(["rm", "-rf", join(root, ".release")]);
  expect(await reset.exited).toBe(0);
  const mkdir = Bun.spawn(["mkdir", "-p", stage, tarballs]);
  expect(await mkdir.exited).toBe(0);
  await Bun.write(
    join(stage, "package.json"),
    JSON.stringify({ name: "@weaveio/weave-cli", version }),
  );
  await Bun.write(join(tarballs, `weaveio-weave-cli-${version}.tgz`), tarball);
  const result = await writeArtifactManifest("nightly", "a".repeat(40));
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  expect(result.isOk()).toBe(true);
  const manifest = (await Bun.file(
    join(root, ".release", "manifest.json"),
  ).json()) as {
    versions: Record<string, string>;
    artifacts: {
      filename: string;
      checksumFilename: string;
      sizeBytes: number;
      sha256: string;
    }[];
  };
  expect(manifest.versions["@weaveio/weave-cli"]).toBe(version);
  expect(manifest.artifacts).toEqual([
    {
      filename,
      checksumFilename: `${filename}.sha256`,
      sizeBytes: tarball.length,
      sha256: digest(tarball),
    },
  ]);
  expect(
    Array.from(await Bun.file(join(root, ".release", filename)).bytes()),
  ).toEqual(Array.from(tarball));
  expect(
    await Bun.file(join(root, ".release", `${filename}.sha256`)).text(),
  ).toBe(`${digest(tarball)}\n`);
  const cleanup = Bun.spawn(["rm", "-rf", join(root, ".release")]);
  expect(await cleanup.exited).toBe(0);
});

test("stable manifests embed a validated train and nightly manifests omit it", async () => {
  const root = process.cwd();
  const run = `validate-train-${crypto.randomUUID()}`;
  const version = "1.2.3";
  const stage = join(root, ".release", run, "staging", "cli");
  const tarballs = join(root, ".release", run, "tarballs");
  const tarball = archive();
  const trainContent = {
    schemaVersion: 1 as const,
    trainRef: "release/20260719-aaaaaaaaaaaa",
    subjectSha: "a".repeat(40),
    cutAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:00.000Z",
    state: "prepared",
    packages: ["@weaveio/weave-cli"],
    versions: { "@weaveio/weave-cli": version },
  };
  const train = {
    ...trainContent,
    recordDigest: trainRecordDigest(trainContent),
  };
  const reset = Bun.spawn(["rm", "-rf", join(root, ".release")]);
  expect(await reset.exited).toBe(0);
  await Bun.write(
    join(stage, "package.json"),
    JSON.stringify({ name: "@weaveio/weave-cli", version }),
  );
  await Bun.write(join(tarballs, `weaveio-weave-cli-${version}.tgz`), tarball);
  const stable = await writeArtifactManifest(
    "stable-cut",
    "a".repeat(40),
    JSON.stringify(train),
  );
  expect(stable.isOk()).toBe(true);
  const manifest = (await Bun.file(
    join(root, ".release", "manifest.json"),
  ).json()) as { stableTrain?: unknown };
  expect(manifest.stableTrain).toEqual(train);
  const invalid = await writeArtifactManifest(
    "stable-cut",
    "a".repeat(40),
    "{}",
  );
  expect(invalid.isErr() && invalid.error.type).toBe("InvalidInput");
  const cleanup = Bun.spawn(["rm", "-rf", join(root, ".release")]);
  expect(await cleanup.exited).toBe(0);
});
