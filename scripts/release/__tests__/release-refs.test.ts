import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import {
  type ChangelogDocument,
  type ChangelogEntry,
  renderChangelog,
} from "../changelog-format.js";
import type { ChangesetIdentity } from "../changeset-policy.js";
import type { PublicPackageName } from "../constants.js";
import type { GitHubError } from "../errors.js";
import {
  composeReleaseNotes,
  releaseTagName,
  unscopedPackageName,
} from "../notes-wrapper.js";
import {
  PUBLICATION_REPORT_SCHEMA_VERSION,
  type PublicationMember,
  type PublicationReport,
} from "../publish-executor.js";
import {
  assertRefsPublicationGate,
  assertReleasedShaTarget,
  type ExistingGitHubRelease,
  type ExistingGitTag,
  type ReleasePackageVersion,
  ReleaseRefsController,
  type ReleaseRefsGitHub,
  type ReleaseRefsInput,
} from "../release-refs.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const BASE_SHA = "a".repeat(40);
const BUILT_SHA = "b".repeat(40);
const RELEASED_SHA = "c".repeat(40);
const HEAD_SHA = "d".repeat(40);
const OTHER_SHA = "e".repeat(40);

function digest(seed: string): string {
  return new Bun.CryptoHasher("sha256").update(seed).digest("hex");
}

function tarballDigest(seed: string): string {
  return `sha256:${digest(seed)}`;
}

function identity(id: string): ChangesetIdentity {
  return { id, sourceDigest: digest(id) };
}

function entry(prose: string, id: string): ChangelogEntry {
  return { prose, sourceChangesets: [identity(id)] };
}

function changelogFor(
  packageName: PublicPackageName,
  version = "0.1.0",
): string {
  const document: ChangelogDocument = {
    packageName,
    versions: [
      {
        version,
        sections: [
          {
            name: "Added",
            entries: [
              entry(
                `Release ${packageName}.`,
                `${unscopedPackageName(packageName)}-added`,
              ),
            ],
          },
        ],
      },
    ],
  };
  const rendered = renderChangelog(document);
  if (rendered.isErr())
    throw new Error(`Fixture render failed: ${JSON.stringify(rendered.error)}`);
  return rendered.value;
}

function member(
  packageName: PublicPackageName,
  overrides: Partial<PublicationMember> = {},
): PublicationMember {
  return {
    packageName,
    version: "0.1.0",
    tarballSha256: tarballDigest(packageName),
    status: "published",
    verification: "digest-verified",
    ...overrides,
  };
}

function report(
  overrides: Partial<PublicationReport> = {},
  members: readonly PublicationMember[] = [member(CLI), member(OPENCODE)],
): PublicationReport {
  return {
    schemaVersion: PUBLICATION_REPORT_SCHEMA_VERSION,
    channel: "stable",
    tag: "latest",
    releasedSha: RELEASED_SHA,
    members: [...members],
    ...overrides,
  };
}

function versions(): readonly ReleasePackageVersion[] {
  return [
    { packageName: CLI, version: "0.1.0", previousVersion: "0.0.1" },
    { packageName: OPENCODE, version: "0.1.0", previousVersion: "0.0.1" },
  ];
}

function changelogs(): Record<string, string> {
  return {
    [CLI]: changelogFor(CLI),
    [OPENCODE]: changelogFor(OPENCODE),
  };
}

function input(overrides: Partial<ReleaseRefsInput> = {}): ReleaseRefsInput {
  return {
    channel: "stable",
    releasedSha: RELEASED_SHA,
    tagTargetSha: RELEASED_SHA,
    baseSha: BASE_SHA,
    builtSha: BUILT_SHA,
    headSha: HEAD_SHA,
    closure: [CLI, OPENCODE],
    versions: versions(),
    report: report(),
    changelogs: changelogs(),
    ...overrides,
  };
}

function expectOk<T, E>(result: Result<T, E>): T {
  if (result.isErr())
    throw new Error(`Unexpected failure: ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectErr<T, E>(result: Result<T, E>): E {
  if (result.isOk())
    throw new Error(`Unexpected success: ${JSON.stringify(result.value)}`);
  return result.error;
}

async function expectOkAsync<T, E>(result: ResultAsync<T, E>): Promise<T> {
  const settled = await result;
  return expectOk(settled);
}

async function expectErrAsync<T, E>(result: ResultAsync<T, E>): Promise<E> {
  const settled = await result;
  return expectErr(settled);
}

class FakeRefsGitHub implements ReleaseRefsGitHub {
  readonly createdTags: string[] = [];
  readonly createdReleases: string[] = [];
  constructor(
    private readonly tags = new Map<string, ExistingGitTag>(),
    private readonly releases = new Map<string, ExistingGitHubRelease>(),
  ) {}

  seedTag(tag: string, commitSha: string): void {
    this.tags.set(tag, { name: tag, commitSha });
  }

  seedRelease(release: ExistingGitHubRelease): void {
    this.releases.set(release.tag, release);
  }

  release(tag: string): ExistingGitHubRelease | undefined {
    return this.releases.get(tag);
  }

  readTag(tag: string): ResultAsync<ExistingGitTag | null, GitHubError> {
    return okAsync(this.tags.get(tag) ?? null);
  }

  createAnnotatedTag(request: {
    tag: string;
    commitSha: string;
    message: string;
  }): ResultAsync<void, GitHubError> {
    if (this.tags.has(request.tag))
      return errAsync({
        type: "GitHubError",
        operation: "createAnnotatedTag",
        message: "exists",
      });
    this.tags.set(request.tag, {
      name: request.tag,
      commitSha: request.commitSha,
    });
    this.createdTags.push(request.tag);
    return okAsync(undefined);
  }

  readRelease(
    tag: string,
  ): ResultAsync<ExistingGitHubRelease | null, GitHubError> {
    return okAsync(this.releases.get(tag) ?? null);
  }

  createRelease(request: {
    tag: string;
    targetSha: string;
    name: string;
    notes: string;
    prerelease: boolean;
  }): ResultAsync<void, GitHubError> {
    if (this.releases.has(request.tag))
      return errAsync({
        type: "GitHubError",
        operation: "createRelease",
        message: "exists",
      });
    this.releases.set(request.tag, {
      tag: request.tag,
      targetSha: request.targetSha,
      notes: request.notes,
      draft: false,
      prerelease: request.prerelease,
    });
    this.createdReleases.push(request.tag);
    return okAsync(undefined);
  }
}

function expectedNotes(packageName: PublicPackageName): string {
  return expectOk(
    composeReleaseNotes({
      packageName,
      version: "0.1.0",
      previousVersion: "0.0.1",
      releasedSha: RELEASED_SHA,
      tarballSha256: tarballDigest(packageName),
      changelog: changelogFor(packageName),
    }),
  );
}

describe("publication gate", () => {
  it("refuses a partial or unverified report before any ref is created", async () => {
    const github = new FakeRefsGitHub();
    const pending = report({}, [
      member(CLI),
      member(OPENCODE, { status: "pending", verification: "unverified" }),
    ]);
    expect(
      expectErr(
        assertRefsPublicationGate({
          channel: "stable",
          releasedSha: RELEASED_SHA,
          closure: [CLI, OPENCODE],
          report: pending,
        }),
      ).type,
    ).toBe("PublicationReportIncomplete");
    expect(
      (
        await expectErrAsync(
          new ReleaseRefsController(github).apply(input({ report: pending })),
        )
      ).type,
    ).toBe("PublicationReportIncomplete");
    expect(github.createdTags).toEqual([]);
    expect(github.createdReleases).toEqual([]);
  });

  it("accepts already-published exact-digest members", () => {
    expect(
      assertRefsPublicationGate({
        channel: "stable",
        releasedSha: RELEASED_SHA,
        closure: [CLI, OPENCODE],
        report: report({}, [
          member(CLI, { status: "already-published" }),
          member(OPENCODE, { status: "already-published" }),
        ]),
      }).isOk(),
    ).toBe(true);
  });

  it("refuses a report that does not cover the closure", () => {
    expect(
      expectErr(
        assertRefsPublicationGate({
          channel: "stable",
          releasedSha: RELEASED_SHA,
          closure: [CLI, OPENCODE],
          report: report({}, [member(CLI)]),
        }),
      ),
    ).toEqual({
      type: "PublicationClosureMismatch",
      missing: [OPENCODE],
      unexpected: [],
    });
  });
});

describe("released SHA targeting", () => {
  it("requires the tag target to be releasedSha", () => {
    expect(
      expectOk(
        assertReleasedShaTarget({
          releasedSha: RELEASED_SHA,
          tagTargetSha: RELEASED_SHA,
          baseSha: BASE_SHA,
          builtSha: BUILT_SHA,
          headSha: HEAD_SHA,
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects base, build, and head mismatches", () => {
    expect(
      expectErr(
        assertReleasedShaTarget({
          releasedSha: RELEASED_SHA,
          tagTargetSha: BASE_SHA,
          baseSha: BASE_SHA,
          builtSha: BUILT_SHA,
          headSha: HEAD_SHA,
        }),
      ),
    ).toEqual({
      type: "ReleasedShaMismatch",
      field: "baseSha",
      expected: RELEASED_SHA,
      actual: BASE_SHA,
    });
    expect(
      expectErr(
        assertReleasedShaTarget({
          releasedSha: RELEASED_SHA,
          tagTargetSha: BUILT_SHA,
          baseSha: BASE_SHA,
          builtSha: BUILT_SHA,
          headSha: HEAD_SHA,
        }),
      ),
    ).toEqual({
      type: "ReleasedShaMismatch",
      field: "builtSha",
      expected: RELEASED_SHA,
      actual: BUILT_SHA,
    });
    expect(
      expectErr(
        assertReleasedShaTarget({
          releasedSha: RELEASED_SHA,
          tagTargetSha: HEAD_SHA,
          baseSha: BASE_SHA,
          builtSha: BUILT_SHA,
          headSha: HEAD_SHA,
        }),
      ),
    ).toEqual({
      type: "ReleasedShaMismatch",
      field: "headSha",
      expected: RELEASED_SHA,
      actual: HEAD_SHA,
    });
    expect(
      expectErr(
        assertReleasedShaTarget({
          releasedSha: RELEASED_SHA,
          tagTargetSha: OTHER_SHA,
          baseSha: BASE_SHA,
        }),
      ),
    ).toEqual({
      type: "ReleasedShaMismatch",
      field: "tagTarget",
      expected: RELEASED_SHA,
      actual: OTHER_SHA,
    });
  });
});

describe("ReleaseRefsController", () => {
  it("creates annotated tags at releasedSha and matching releases", async () => {
    const github = new FakeRefsGitHub();
    const result = await expectOkAsync(
      new ReleaseRefsController(github).apply(input()),
    );
    expect(result).toEqual({
      status: "applied",
      items: [
        {
          packageName: CLI,
          tag: "weave-cli@0.1.0",
          tagOutcome: "created",
          releaseOutcome: "created",
        },
        {
          packageName: OPENCODE,
          tag: "weave-adapter-opencode@0.1.0",
          tagOutcome: "created",
          releaseOutcome: "created",
        },
      ],
    });
    expect(github.createdTags).toEqual([
      "weave-cli@0.1.0",
      "weave-adapter-opencode@0.1.0",
    ]);
    expect(github.createdReleases).toEqual(github.createdTags);
    expect(releaseTagName(CLI, "0.1.0")).toBe("weave-cli@0.1.0");
  });

  it("skips identical existing refs and resumes only the missing items", async () => {
    const github = new FakeRefsGitHub();
    github.seedTag("weave-cli@0.1.0", RELEASED_SHA);
    github.seedRelease({
      tag: "weave-cli@0.1.0",
      targetSha: RELEASED_SHA,
      notes: expectedNotes(CLI),
      draft: false,
      prerelease: false,
    });
    const result = await expectOkAsync(
      new ReleaseRefsController(github).apply(input()),
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.items).toEqual([
      {
        packageName: CLI,
        tag: "weave-cli@0.1.0",
        tagOutcome: "skipped",
        releaseOutcome: "skipped",
      },
      {
        packageName: OPENCODE,
        tag: "weave-adapter-opencode@0.1.0",
        tagOutcome: "created",
        releaseOutcome: "created",
      },
    ]);
    expect(github.createdTags).toEqual(["weave-adapter-opencode@0.1.0"]);
    expect(github.createdReleases).toEqual(["weave-adapter-opencode@0.1.0"]);
  });

  it("fails typed when an existing tag or release conflicts", async () => {
    const tagConflict = new FakeRefsGitHub();
    tagConflict.seedTag("weave-cli@0.1.0", OTHER_SHA);
    expect(
      await expectErrAsync(
        new ReleaseRefsController(tagConflict).apply(input()),
      ),
    ).toEqual({
      type: "ExistingTagConflict",
      tag: "weave-cli@0.1.0",
      expectedSha: RELEASED_SHA,
      actualSha: OTHER_SHA,
    });
    expect(tagConflict.createdTags).toEqual([]);

    const releaseConflict = new FakeRefsGitHub();
    releaseConflict.seedTag("weave-cli@0.1.0", RELEASED_SHA);
    releaseConflict.seedRelease({
      tag: "weave-cli@0.1.0",
      targetSha: OTHER_SHA,
      notes: expectedNotes(CLI),
      draft: false,
      prerelease: false,
    });
    expect(
      await expectErrAsync(
        new ReleaseRefsController(releaseConflict).apply(input()),
      ),
    ).toEqual({
      type: "ExistingReleaseConflict",
      tag: "weave-cli@0.1.0",
      reason: `target ${OTHER_SHA}`,
    });
    expect(releaseConflict.createdReleases).toEqual([]);
  });

  it("creates no Git refs for nightly", async () => {
    const github = new FakeRefsGitHub();
    const nightly = input({
      channel: "nightly",
      report: report({ channel: "nightly", tag: "nightly" }),
    });
    const result = await expectOkAsync(
      new ReleaseRefsController(github).apply(nightly),
    );
    expect(result).toEqual({
      status: "skipped",
      reason: "nightly",
      items: [],
    });
    expect(github.createdTags).toEqual([]);
    expect(github.createdReleases).toEqual([]);
  });

  it("marks next releases as prereleases", async () => {
    const github = new FakeRefsGitHub();
    const next = input({
      channel: "next",
      report: report({ channel: "next", tag: "next" }),
    });
    await expectOkAsync(new ReleaseRefsController(github).apply(next));
    expect(github.createdReleases).toEqual([
      "weave-cli@0.1.0",
      "weave-adapter-opencode@0.1.0",
    ]);
    expect(github.release("weave-cli@0.1.0")?.prerelease).toBe(true);
  });
});
