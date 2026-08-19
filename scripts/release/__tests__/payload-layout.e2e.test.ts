import { expect, test } from "bun:test";
import { join } from "node:path";
import { okAsync, type ResultAsync } from "neverthrow";

import { validateArtifactManifest } from "../artifact-manifest.js";
import type { ParsedChangeset } from "../changeset-policy.js";
import type { Clock } from "../clock.js";
import type { RegistryError } from "../errors.js";
import { validateReleaseInvocation } from "../input-validation.js";
import { packageArtifactFilename } from "../model.js";
import { NightlyPlanner } from "../nightly-plan.js";
import type { NpmRegistryClient } from "../npm-registry-client.js";
import { PackagePolicyValidator } from "../package-policy.js";
import { BunPackageCommandRunner, PublicPackagePackager } from "../packager.js";
import { archive, digest } from "../release-fixtures.js";
import {
  type StableTrainContent,
  trainRecordDigest,
  validateStableTrain,
} from "../stable-train.js";
import { TarInspector } from "../tar-inspector.js";
import { writeArtifactManifest } from "../write-artifact-manifest.js";

const sha = "abcdef123456".padEnd(40, "a");

function digestTrain(value: StableTrainContent): string {
  const result = trainRecordDigest(value);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const invocation = validateReleaseInvocation({
  repository: "weave-io/weave",
  workflowPath: ".github/workflows/publish.yml",
  eventName: "schedule",
  ref: "refs/heads/main",
});
if (invocation.isErr()) throw new Error("fixture invocation is invalid");

class Registry implements NpmRegistryClient {
  publish(): ResultAsync<void, RegistryError> {
    return okAsync();
  }
  viewVersion(): ResultAsync<string, RegistryError> {
    return okAsync("");
  }
  viewDistTags(): ResultAsync<Record<string, string>, RegistryError> {
    return okAsync({});
  }
  distTagLs(): ResultAsync<Record<string, string>, RegistryError> {
    return okAsync({});
  }
  verifyPublished(): ResultAsync<void, RegistryError> {
    return okAsync();
  }
  listVersions(): ResultAsync<readonly string[], RegistryError> {
    return okAsync(["1.9.0"]);
  }
}

const clock: Clock = {
  now: () => new Date("2026-07-19T12:00:00.000Z"),
  sleep: () => okAsync(),
};

test("nightly payload layout executes plan, subset pack, and control manifest validation", async () => {
  const root = process.cwd();
  const run = `validate-e2e-${crypto.randomUUID()}`;
  const reset = Bun.spawn(["rm", "-rf", join(root, ".release")]);
  expect(await reset.exited).toBe(0);
  try {
    const build = Bun.spawn(["bun", "scripts/build-public-packages.ts"]);
    expect(await build.exited).toBe(0);

    const changesets: readonly ParsedChangeset[] = [
      {
        path: ".changeset/cli.md",
        releases: new Map([["@weaveio/weave-cli", "minor"]]),
      },
    ];
    const plan = await new NightlyPlanner(new Registry(), clock).plan({
      invocation: invocation.value,
      changesets,
      subjectSha: sha,
      packageVersions: {
        "@weaveio/weave-cli": "0.1.0",
        "@weaveio/weave-adapter-opencode": "0.1.0",
        "@weaveio/weave-adapter-claude-code": "0.1.0",
        "@weaveio/weave-adapter-pi": "0.1.0",
      },
    });
    if (plan.isErr() || plan.value.skip !== undefined)
      throw new Error("nightly fixture did not produce a package plan");
    const plannedVersions = Object.fromEntries(
      plan.value.packages.map(({ name, version }) => [name, version]),
    );
    const version = plannedVersions["@weaveio/weave-cli"];
    if (version === undefined) throw new Error("CLI version was not planned");

    const tarballs = await new PublicPackagePackager(
      new BunPackageCommandRunner(),
      new PackagePolicyValidator(),
    ).packAll(join(root, ".release", run), plannedVersions);
    if (tarballs.isErr()) throw new Error(JSON.stringify(tarballs.error));
    expect(tarballs.value).toHaveLength(1);
    const tarballPath = tarballs.value[0];
    if (tarballPath === undefined)
      throw new Error("CLI tarball was not packed");

    const result = await writeArtifactManifest("nightly", sha);
    if (result.isErr()) throw new Error(JSON.stringify(result.error));
    const manifest = await Bun.file(
      join(root, ".release", "manifest.json"),
    ).json();
    const validated = validateArtifactManifest(manifest);
    expect(validated.isOk()).toBe(true);
    if (validated.isErr()) throw new Error(JSON.stringify(validated.error));

    const filename = packageArtifactFilename("@weaveio/weave-cli", version);
    const tarball = await Bun.file(tarballPath).bytes();
    const expectedDigest = digest(tarball);
    expect(validated.value.versions).toEqual(plannedVersions);
    expect(validated.value.artifacts).toEqual([
      {
        filename,
        checksumFilename: `${filename}.sha256`,
        sizeBytes: tarball.byteLength,
        sha256: expectedDigest,
      },
    ]);
    expect(await Bun.file(join(root, ".release", filename)).bytes()).toEqual(
      tarball,
    );
    expect(
      await Bun.file(join(root, ".release", `${filename}.sha256`)).text(),
    ).toBe(`${expectedDigest}\n`);

    const packedManifest = new TarInspector()
      .inspect(tarball)
      .map((entries) =>
        entries.find((entry) => entry.path === "package/package.json"),
      );
    expect(packedManifest.isOk()).toBe(true);
    if (packedManifest.isErr() || packedManifest.value === undefined)
      throw new Error("packed CLI manifest is missing");
    expect(
      JSON.parse(new TextDecoder().decode(packedManifest.value.contents)),
    ).toMatchObject({
      name: "@weaveio/weave-cli",
      version,
    });

    const stableStragglerPlan = {
      ...plannedVersions,
      "@weaveio/weave-cli": "1.10.0",
    };
    const straggler = validateArtifactManifest({
      ...validated.value,
      versions: stableStragglerPlan,
    });
    expect(straggler.isErr()).toBe(true);
    if (straggler.isErr())
      expect(straggler.error.issues).toContain(
        "nightly versions must use the canonical format",
      );
  } finally {
    const cleanup = Bun.spawn(["rm", "-rf", join(root, ".release")]);
    expect(await cleanup.exited).toBe(0);
  }
}, 120_000);

test("stable CLI-only payload layout packs the train-authoritative set", async () => {
  const root = process.cwd();
  const run = `validate-stable-cli-${crypto.randomUUID()}`;
  const version = "1.2.3";
  const trainContent = {
    schemaVersion: 1 as const,
    trainRef: "release/20260719-aaaaaaaaaaaa",
    subjectSha: sha,
    cutAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:00.000Z",
    state: "awaiting-promotion" as const,
    packages: ["@weaveio/weave-cli"] as const,
    versions: { "@weaveio/weave-cli": version },
    artifactManifestDigest: `sha256:${"b".repeat(64)}`,
    artifactIds: [1],
  };
  const train = {
    ...trainContent,
    recordDigest: digestTrain(trainContent),
  };
  const reset = Bun.spawn(["rm", "-rf", join(root, ".release")]);
  expect(await reset.exited).toBe(0);
  try {
    const build = Bun.spawn(["bun", "scripts/build-public-packages.ts"]);
    expect(await build.exited).toBe(0);

    const tarballs = await new PublicPackagePackager(
      new BunPackageCommandRunner(),
      new PackagePolicyValidator(),
    ).packAll(join(root, ".release", run), train.versions);
    expect(tarballs.isOk()).toBe(true);
    if (tarballs.isErr()) throw new Error(JSON.stringify(tarballs.error));
    expect(tarballs.value).toHaveLength(1);
    const tarballPath = tarballs.value[0];
    if (tarballPath === undefined)
      throw new Error("CLI tarball was not packed");

    const result = await writeArtifactManifest(
      "stable-cut",
      sha,
      JSON.stringify(train),
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error(JSON.stringify(result.error));
    const manifest = await Bun.file(
      join(root, ".release", "manifest.json"),
    ).json();
    const validated = validateArtifactManifest(manifest);
    expect(validated.isOk()).toBe(true);
    if (validated.isErr()) throw new Error(JSON.stringify(validated.error));

    const filename = packageArtifactFilename("@weaveio/weave-cli", version);
    const tarball = await Bun.file(tarballPath).bytes();
    const expectedDigest = digest(tarball);
    expect(validated.value.releaseSubjectSha).toBe(train.subjectSha);
    expect(validated.value.packages).toEqual([...train.packages]);
    expect(validated.value.versions).toEqual(train.versions);
    expect(validated.value.stableTrain).toEqual({
      ...train,
      packages: [...train.packages],
    });
    expect(validated.value.artifacts).toEqual([
      {
        filename,
        checksumFilename: `${filename}.sha256`,
        sizeBytes: tarball.byteLength,
        sha256: expectedDigest,
      },
    ]);
    expect(await Bun.file(join(root, ".release", filename)).bytes()).toEqual(
      tarball,
    );
    expect(
      await Bun.file(join(root, ".release", `${filename}.sha256`)).text(),
    ).toBe(`${expectedDigest}\n`);

    const packedManifest = new TarInspector()
      .inspect(tarball)
      .map((entries) =>
        entries.find((entry) => entry.path === "package/package.json"),
      );
    expect(packedManifest.isOk()).toBe(true);
    if (packedManifest.isErr() || packedManifest.value === undefined)
      throw new Error("packed CLI manifest is missing");
    expect(
      JSON.parse(new TextDecoder().decode(packedManifest.value.contents)),
    ).toMatchObject({ name: "@weaveio/weave-cli", version });
  } finally {
    const cleanup = Bun.spawn(["rm", "-rf", join(root, ".release")]);
    expect(await cleanup.exited).toBe(0);
  }
}, 120_000);

test("stable manifests embed a validated train and nightly manifests omit it", async () => {
  const root = process.cwd();
  const run = `validate-train-${crypto.randomUUID()}`;
  const version = "1.2.3";
  const stage = join(root, ".release", run, "staging", "cli");
  const tarballs = join(root, ".release", run, "tarballs");
  const tarball = archive();
  const trainContent: StableTrainContent = {
    schemaVersion: 1,
    trainRef: "release/20260719-aaaaaaaaaaaa",
    subjectSha: "a".repeat(40),
    cutAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:00.000Z",
    state: "prepared",
    packages: ["@weaveio/weave-cli"],
    versions: { "@weaveio/weave-cli": version },
  };
  const trainResult = validateStableTrain({
    ...trainContent,
    recordDigest: digestTrain(trainContent),
  });
  if (trainResult.isErr()) throw new Error(JSON.stringify(trainResult.error));
  const train = trainResult.value;
  const reset = Bun.spawn(["rm", "-rf", join(root, ".release")]);
  expect(await reset.exited).toBe(0);
  await Bun.write(
    join(stage, "package.json"),
    JSON.stringify({
      name: "@weaveio/weave-cli",
      version,
      description: "Weave CLI",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      publishConfig: { access: "public" },
      dependencies: { neverthrow: "^8.2.0" },
    }),
  );
  await Bun.write(join(tarballs, `weaveio-weave-cli-${version}.tgz`), tarball);
  const stable = await writeArtifactManifest(
    "stable-cut",
    "a".repeat(40),
    JSON.stringify(train),
  );
  expect(stable.isOk()).toBe(true);
  const manifest = validateArtifactManifest(
    await Bun.file(join(root, ".release", "manifest.json")).json(),
  );
  expect(manifest.isOk()).toBe(true);
  if (manifest.isErr()) throw new Error(JSON.stringify(manifest.error));
  expect(manifest.value.stableTrain).toEqual({
    ...train,
    packages: [...train.packages],
  });
  const invalid = await writeArtifactManifest(
    "stable-cut",
    "a".repeat(40),
    "{}",
  );
  expect(invalid.isErr() && invalid.error.type).toBe("InvalidInput");
  const cleanup = Bun.spawn(["rm", "-rf", join(root, ".release")]);
  expect(await cleanup.exited).toBe(0);
});
