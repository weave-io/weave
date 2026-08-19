import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { PackagePolicyValidator } from "../package-policy.js";
import {
  BunPackageCommandRunner,
  buildReleaseStagingBinding,
  PublicPackagePackager,
  stageWithChangelogOverride,
  stageWithDependencyRangeOverrides,
  stageWithVersionOverrides,
} from "../packager.js";
import { TarInspector } from "../tar-inspector.js";

const PACKAGE = "@weaveio/weave-adapter-opencode" as const;
const VERSION = "0.2.0-next.20260818.abcdef123456";

function packager(): PublicPackagePackager {
  return new PublicPackagePackager(
    new BunPackageCommandRunner(),
    new PackagePolicyValidator(),
  );
}

async function remove(path: string): Promise<void> {
  const process = Bun.spawn(["rm", "-rf", path]);
  await process.exited;
}

describe("public package staging", () => {
  it("packs the exact inventory and keeps scratch overrides out of source", async () => {
    const root = join(".release", `task10-packager-${crypto.randomUUID()}`);
    const sourceManifest = await Bun.file(
      "packages/adapters/opencode/package.json",
    ).bytes();
    const sourceChangelog = await Bun.file(
      "packages/adapters/opencode/CHANGELOG.md",
    ).bytes();
    try {
      const result = await packager().pack(
        PACKAGE,
        root,
        join(root, "tarballs"),
        VERSION,
        {
          channel: "next",
          dependencyRanges: { neverthrow: "^8.2.1" },
          changelogOverride:
            "# @weaveio/weave-adapter-opencode\n\n## scratch\n\nDeterministic test content.\n",
          canonicalNotesUrl: "https://github.com/weave-io/weave/releases",
        },
      );
      expect(result.isOk()).toBe(true);
      if (result.isErr()) return;
      const archive = await Bun.file(result.value).bytes();
      const inventory = new TarInspector().inspectPublicPackage(
        archive,
        PACKAGE,
      );
      expect(inventory.isOk()).toBe(true);
      if (inventory.isErr()) return;
      expect(inventory.value.files.map((file) => file.path)).toEqual([
        "package/CHANGELOG.md",
        "package/LICENSE",
        "package/README.md",
        "package/dist/index.d.ts",
        "package/dist/index.js",
        "package/dist/plugin.d.ts",
        "package/dist/plugin.js",
        "package/package.json",
      ]);
      const manifest = inventory.value.manifest;
      expect(manifest.version).toBe(VERSION);
      expect((manifest.dependencies as Record<string, string>).neverthrow).toBe(
        "^8.2.1",
      );
      expect(
        await Bun.file("packages/adapters/opencode/package.json").bytes(),
      ).toEqual(sourceManifest);
      expect(
        await Bun.file("packages/adapters/opencode/CHANGELOG.md").bytes(),
      ).toEqual(sourceChangelog);
    } finally {
      await remove(root);
    }
  }, 60_000);

  it("produces stable tarball and file digests for repeated builds", async () => {
    const firstRoot = join(
      ".release",
      `task10-repeat-a-${crypto.randomUUID()}`,
    );
    const secondRoot = join(
      ".release",
      `task10-repeat-b-${crypto.randomUUID()}`,
    );
    try {
      const first = await packager().packDetailed(
        PACKAGE,
        firstRoot,
        join(firstRoot, "tarballs"),
        {
          channel: "next",
          version: VERSION,
          changelogOverride: "# package\n\nDeterministic content.\n",
        },
      );
      const second = await packager().packDetailed(
        PACKAGE,
        secondRoot,
        join(secondRoot, "tarballs"),
        {
          channel: "next",
          version: VERSION,
          changelogOverride: "# package\n\nDeterministic content.\n",
        },
      );
      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);
      if (first.isErr() || second.isErr()) return;
      expect(first.value.tarballSha256).toBe(second.value.tarballSha256);
      expect(first.value.files).toEqual(second.value.files);
      const binding = buildReleaseStagingBinding("a".repeat(40), [first.value]);
      expect(binding.isOk()).toBe(true);
      if (binding.isOk()) {
        expect(binding.value.fileDigests.length).toBeGreaterThan(0);
        expect(binding.value.proofMarkers.attestation.status).toBe("pending");
      }
    } finally {
      await remove(firstRoot);
      await remove(secondRoot);
    }
  }, 60_000);

  it("applies helper overrides only below the staging tree", async () => {
    const root = join(".release", `task10-helper-${crypto.randomUUID()}`);
    try {
      const built = await packager().pack(
        PACKAGE,
        root,
        join(root, "tarballs"),
        "0.3.0-next.20260818.abcdef123456",
        { channel: "next", changelogOverride: "# package\n\nUseful.\n" },
      );
      expect(built.isOk()).toBe(true);
      const version = await stageWithVersionOverrides(root, {
        [PACKAGE]: "0.4.0-next.20260818.abcdef123456",
      });
      expect(version.isOk()).toBe(true);
      const dependency = await stageWithDependencyRangeOverrides(root, {
        [PACKAGE]: { neverthrow: "^8.2.2" },
      });
      expect(dependency.isOk()).toBe(true);
      const changelog = await stageWithChangelogOverride(
        root,
        PACKAGE,
        "# package\n\nChanged only in staging.\n",
      );
      expect(changelog.isOk()).toBe(true);
      const staged = await Bun.file(
        join(root, "staging", "adapters/opencode", "package.json"),
      ).exists();
      expect(staged).toBe(false);
      const manifest = await Bun.file(
        join(root, "staging", "weave-adapter-opencode", "package.json"),
      ).json();
      expect(manifest.version).toBe("0.4.0-next.20260818.abcdef123456");
    } finally {
      await remove(root);
    }
  }, 60_000);

  it("rejects stable staging when the checkout is not the released SHA", async () => {
    const root = join(".release", `task10-stable-sha-${crypto.randomUUID()}`);
    const result = await packager().packStableRelease(
      root,
      {
        status: () => okAsync(""),
        head: () => okAsync("b".repeat(40)),
      },
      "a".repeat(40),
      { packages: [PACKAGE] },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("ReleasedShaMismatch");
  });

  it("seals stable staging with one typed error per override carrier", async () => {
    const root = join(
      ".release",
      `task10-stable-errors-${crypto.randomUUID()}`,
    );
    try {
      const stableVersion = await packager().packDetailed(
        PACKAGE,
        root,
        join(root, "tarballs"),
        {
          channel: "stable",
          version: "0.4.0",
        },
      );
      expect(stableVersion.isErr() && stableVersion.error.type).toBe(
        "StableVersionOverrideRejected",
      );
      const stableDependency = await packager().packDetailed(
        PACKAGE,
        root,
        join(root, "tarballs"),
        {
          channel: "stable",
          dependencyRanges: { neverthrow: "^8.2.2" },
        },
      );
      expect(stableDependency.isErr() && stableDependency.error.type).toBe(
        "StableDependencyRangeOverrideRejected",
      );
      const stableChangelog = await packager().packDetailed(
        PACKAGE,
        root,
        join(root, "tarballs"),
        {
          channel: "stable",
          changelogOverride: "# package\n\nNo.\n",
        },
      );
      expect(stableChangelog.isErr() && stableChangelog.error.type).toBe(
        "StableChangelogOverrideRejected",
      );
      const carrier = await stageWithVersionOverrides(
        root,
        {
          versionOverrides: { [PACKAGE]: "0.4.0" },
          dependencyRangeOverrides: { [PACKAGE]: { neverthrow: "^8.2.2" } },
        },
        { channel: "stable" },
      );
      expect(carrier.isErr() && carrier.error.type).toBe(
        "StableOverrideCarrierRejected",
      );
      const coerced = await packager().packDetailed(
        PACKAGE,
        root,
        join(root, "tarballs"),
        {
          channel: "next",
          version: VERSION,
          releasedSha: "a".repeat(40),
        },
      );
      expect(coerced.isErr() && coerced.error.type).toBe(
        "NonStableCannotCoerceStable",
      );
    } finally {
      await remove(root);
    }
  }, 60_000);
});
