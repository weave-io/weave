import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  BunChangesetFileSystem,
  type ChangesetIdentity,
  ChangesetPolicyValidator,
  type ValidatedChangeset,
} from "../changeset-policy.js";
import {
  type ChannelRegistry,
  computeChannelVersions,
  computeNightlyAffectedSet,
  computeNightlyVersions,
  computeWouldBeNextStableVersions,
  renderChannelVersion,
  sourceShaFromNightlyVersion,
} from "../channel-versions.js";
import { PUBLIC_PACKAGES, type PublicPackageName } from "../constants.js";
import {
  EMPTY_CONSUMPTION_LEDGER,
  parseConsumptionLedger,
  renderLedgerBlock,
} from "../consumption-ledger.js";
import type { WorkspaceManifest } from "../selection-closure.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const CLAUDE = "@weaveio/weave-adapter-claude-code";
const PI = "@weaveio/weave-adapter-pi";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const SHORT = SHA.slice(0, 12);
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

function minor(path = "portable.md", target = CLI): ValidatedChangeset {
  return changeset(
    path,
    `---\n"${target}": minor\n---\n\nAdd a release feature.\n`,
  );
}

function ledgerFor(
  identity: ChangesetIdentity,
): typeof EMPTY_CONSUMPTION_LEDGER {
  const rendered = renderLedgerBlock({
    package: CLI,
    version: "0.1.0",
    changesets: [identity],
  });
  if (rendered.isErr()) throw new Error(JSON.stringify(rendered.error));
  const parsed = parseConsumptionLedger([
    {
      packageName: CLI,
      path: "packages/cli/CHANGELOG.md",
      contents: `# ${CLI}\n\n## 0.1.0\n\n${rendered.value}\n`,
    },
  ]);
  if (parsed.isErr()) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
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

describe("channel versions", () => {
  it("renders semver-valid next and nightly versions with the UTC date", () => {
    const atUtcBoundary = new Date("2026-07-20T00:30:00.000Z");
    expect(
      renderChannelVersion({
        stableVersion: "0.1.0",
        channel: "next",
        now: atUtcBoundary,
        sourceSha: SHA,
      })._unsafeUnwrap(),
    ).toBe(`0.1.0-next.20260720.${SHORT}`);
    expect(
      renderChannelVersion({
        stableVersion: "0.1.0",
        channel: "nightly",
        now: new Date("2026-07-19T23:59:59.999Z"),
        sourceSha: SHORT,
      })._unsafeUnwrap(),
    ).toBe(`0.1.0-nightly.20260719.${SHORT}`);
    expect(
      sourceShaFromNightlyVersion(
        `0.1.0-nightly.20260719.${SHORT}`,
      )._unsafeUnwrap(),
    ).toBe(SHORT);
  });

  it("rejects malformed source, dates, and stable versions", () => {
    expect(
      renderChannelVersion({
        stableVersion: "0.1",
        channel: "next",
        now: new Date(),
        sourceSha: SHORT,
      })._unsafeUnwrapErr().type,
    ).toBe("InvalidStableVersion");
    expect(
      renderChannelVersion({
        stableVersion: "0.1.0",
        channel: "next",
        now: new Date("invalid"),
        sourceSha: SHORT,
      })._unsafeUnwrapErr().type,
    ).toBe("InvalidDate");
    expect(
      renderChannelVersion({
        stableVersion: "0.1.0",
        channel: "next",
        now: new Date(),
        sourceSha: "bad",
      })._unsafeUnwrapErr().type,
    ).toBe("InvalidSourceSha");
    expect(
      sourceShaFromNightlyVersion("0.1.0-nightly.bad.bad")._unsafeUnwrapErr()
        .type,
    ).toBe("MalformedNightlyVersion");
  });

  it("subtracts consumed changesets without mutating versions or input", () => {
    const consumed = minor("already.md");
    const pending = minor("pending.md", OPENCODE);
    const before = JSON.stringify(versions);
    const result = computeWouldBeNextStableVersions({
      packageVersions: versions,
      changesets: [consumed, pending],
      ledger: ledgerFor(consumed.identity),
    });
    expect(result._unsafeUnwrap()[CLI]).toBe("0.0.1");
    expect(result._unsafeUnwrap()[OPENCODE]).toBe("0.1.0");
    expect(JSON.stringify(versions)).toBe(before);
  });

  it("detects a registry collision before publication", async () => {
    const result = await computeChannelVersions({
      packageVersions: versions,
      changesets: [minor()],
      ledger: EMPTY_CONSUMPTION_LEDGER,
      channel: "next",
      sourceSha: SHA,
      now: new Date("2026-07-20T00:00:00Z"),
      affected: [CLI],
      registry: new Registry({ [CLI]: [`0.1.0-next.20260720.${SHORT}`] }),
    });
    expect(result._unsafeUnwrapErr().type).toBe("RegistryCollision");
  });

  it("computes affected-since-nightly and applies selection closure", async () => {
    const result = await computeNightlyAffectedSet({
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
    expect(result._unsafeUnwrap().affected).toEqual([OPENCODE, PI]);
  });

  it("returns NothingToPublish for a clean nightly diff", async () => {
    const result = await computeNightlyAffectedSet({
      packageVersions: versions,
      changesets: [],
      ledger: EMPTY_CONSUMPTION_LEDGER,
      sourceSha: SHA,
      registry: registry(),
      manifests,
      changedPathsSince: () => [],
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "NothingToPublish",
      channel: "nightly",
      sourceSha: SHA,
    });
  });

  it("computes nightly versions from the closed affected set", async () => {
    const result = await computeNightlyVersions({
      packageVersions: versions,
      changesets: [minor("pending.md", CLAUDE)],
      ledger: EMPTY_CONSUMPTION_LEDGER,
      sourceSha: SHA,
      registry: registry(),
      manifests,
      changedPathsSince: () => ["packages/adapters/claude-code/src/index.ts"],
      now: new Date("2026-07-20T00:00:00Z"),
    });
    expect(
      result._unsafeUnwrap().packages.map((entry) => entry.packageName),
    ).toEqual([CLAUDE]);
    expect(result._unsafeUnwrap().packages[0]?.version).toBe(
      `0.1.0-nightly.20260720.${SHORT}`,
    );
  });
});
