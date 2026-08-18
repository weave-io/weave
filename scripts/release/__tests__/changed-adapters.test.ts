import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  ADAPTER_PACKAGE_NAMES,
  adaptersInPublishSet,
  isAdapterPackage,
  resolveChangedAdapters,
  resolveNextChangedAdapters,
  resolveNightlyChangedAdapters,
  resolveStableChangedAdapters,
} from "../changed-adapters.js";
import {
  BunChangesetFileSystem,
  ChangesetPolicyValidator,
  type ValidatedChangeset,
} from "../changeset-policy.js";
import type { ChannelRegistry } from "../channel-versions.js";
import { PUBLIC_PACKAGES, type PublicPackageName } from "../constants.js";
import { EMPTY_CONSUMPTION_LEDGER } from "../consumption-ledger.js";
import type { WorkspaceManifest } from "../selection-closure.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const CLAUDE = "@weaveio/weave-adapter-claude-code";
const PI = "@weaveio/weave-adapter-pi";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const packages = Object.keys(PUBLIC_PACKAGES) as PublicPackageName[];
const versions = Object.fromEntries(
  packages.map((name) => [name, "0.0.1"]),
) as Record<PublicPackageName, string>;
const manifests: readonly WorkspaceManifest[] = packages.map((name) => ({
  name,
  dependencies: [],
}));

function changeset(path: string, source: string): ValidatedChangeset {
  const result = new ChangesetPolicyValidator(
    new BunChangesetFileSystem(),
  ).validateFile(path, new TextEncoder().encode(source));
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function minor(path = "pending.md", target = OPENCODE): ValidatedChangeset {
  return changeset(
    path,
    `---\n"${target}": minor\n---\n\nAdd a release feature.\n`,
  );
}

class Registry implements ChannelRegistry {
  constructor(
    private readonly values: Readonly<Record<string, readonly string[]>>,
  ) {}
  listVersions(packageName: string) {
    return this.values[packageName] === undefined
      ? errAsync({
          type: "RegistryError" as const,
          operation: "listVersions",
          message: "missing fixture",
        })
      : okAsync(this.values[packageName]);
  }
}

function registry(nightly = "0.1.0-nightly.20260719.111111111111"): Registry {
  return new Registry(
    Object.fromEntries(packages.map((name) => [name, [nightly]])),
  );
}

describe("changed adapter catalog", () => {
  it("names exactly the three publishing adapters", () => {
    expect(ADAPTER_PACKAGE_NAMES).toEqual([OPENCODE, CLAUDE, PI]);
    expect(isAdapterPackage(OPENCODE)).toBe(true);
    expect(isAdapterPackage(CLI)).toBe(false);
  });

  it("treats every adapter in a publish set as changed", () => {
    expect(adaptersInPublishSet([CLI, OPENCODE, PI])).toEqual([OPENCODE, PI]);
    expect(adaptersInPublishSet([CLI])).toEqual([]);
  });
});

describe("stable changed adapters", () => {
  it("are the adapter members of the merged plan closure", () => {
    const result = resolveStableChangedAdapters({
      selected: [CLI, OPENCODE, CLAUDE],
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual({
      channel: "stable",
      publishSet: [CLI, OPENCODE, CLAUDE],
      adapters: [OPENCODE, CLAUDE],
    });
  });

  it("requires proof for a closure-added adapter", () => {
    const result = resolveChangedAdapters({
      channel: "stable",
      closure: { selected: [OPENCODE, PI] },
    });
    expect(result._unsafeUnwrap().adapters).toEqual([OPENCODE, PI]);
  });
});

describe("next changed adapters", () => {
  it("are the adapter members of the maintainer-selection closure", () => {
    const result = resolveNextChangedAdapters({
      selected: [PI],
    });
    expect(result._unsafeUnwrap()).toEqual({
      channel: "next",
      publishSet: [PI],
      adapters: [PI],
    });
  });
});

describe("nightly changed adapters", () => {
  it("are the adapter members of the affected-since-last-nightly closure", async () => {
    const result = await resolveNightlyChangedAdapters({
      packageVersions: versions,
      changesets: [minor("pending.md", OPENCODE)],
      ledger: EMPTY_CONSUMPTION_LEDGER,
      sourceSha: SHA,
      registry: registry(),
      manifests,
      changedPathsSince: (from, to) => {
        expect(from).toBe("111111111111");
        expect(to).toBe(SHA);
        return okAsync(["packages/adapters/pi/src/index.ts"]);
      },
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.channel).toBe("nightly");
    expect(result.value.publishSet).toEqual([OPENCODE, PI]);
    expect(result.value.adapters).toEqual([OPENCODE, PI]);
  });

  it("wraps Task 13 NothingToPublish as a typed nightly failure", async () => {
    const result = await resolveNightlyChangedAdapters({
      packageVersions: versions,
      changesets: [],
      ledger: EMPTY_CONSUMPTION_LEDGER,
      sourceSha: SHA,
      registry: registry(),
      manifests,
      changedPathsSince: () => [],
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "NightlyAffectedSetFailed",
      error: {
        type: "NothingToPublish",
        channel: "nightly",
        sourceSha: SHA,
      },
    });
  });
});

describe("changed adapter validation", () => {
  it("rejects an empty publish set", () => {
    expect(
      resolveStableChangedAdapters({ selected: [] })._unsafeUnwrapErr(),
    ).toEqual({ type: "EmptyPublishSet", channel: "stable" });
  });

  it("rejects a package outside the catalog", () => {
    expect(
      resolveNextChangedAdapters({
        selected: ["@weaveio/weave-core" as PublicPackageName],
      })._unsafeUnwrapErr(),
    ).toEqual({
      type: "UnknownPublishPackage",
      packageName: "@weaveio/weave-core",
    });
  });

  it("rejects a duplicated publish-set member", () => {
    expect(
      resolveChangedAdapters({
        channel: "stable",
        closure: { selected: [OPENCODE, OPENCODE] },
      })._unsafeUnwrapErr(),
    ).toEqual({ type: "DuplicatePublishPackage", packageName: OPENCODE });
  });

  it("orders the publish set by the catalog", () => {
    expect(
      resolveStableChangedAdapters({
        selected: [PI, CLI, CLAUDE],
      })._unsafeUnwrap().publishSet,
    ).toEqual([CLI, CLAUDE, PI]);
  });
});
