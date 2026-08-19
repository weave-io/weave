import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type Result } from "neverthrow";
import type { PublicPackageName } from "../constants.js";
import { releaseTagName } from "../notes-wrapper.js";
import type { ReleasePrOwnership } from "../release-pr-contract.js";
import {
  blocksPreparation,
  classifyPostMergeState,
  createReleaseCompletionPort,
  discoverIncompleteReleases,
  discoveryCaseFor,
  isDiscoverable,
  isTerminalPrimaryState,
  type MergedDiscoveryCase,
  type PackageMemberAuthority,
  type PrimaryReleaseState,
  type ReleaseAuthority,
  type ReleaseStatePorts,
} from "../release-state.js";

const CLI = "@weaveio/weave-cli" as const;
const OPENCODE = "@weaveio/weave-adapter-opencode" as const;
const RELEASED = "c".repeat(40);
const MARKER = "d".repeat(40);
const REGISTRY = digest("registry");
const REBUILT_OK = REGISTRY;
const REBUILT_BAD = digest("rebuilt-mismatch");

function digest(seed: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(seed).digest("hex")}`;
}

function expectOk<T, E>(result: Result<T, E>): T {
  if (result.isErr())
    throw new Error(`Unexpected failure: ${JSON.stringify(result.error)}`);
  return result.value;
}

function member(
  packageName: PublicPackageName,
  overrides: Partial<PackageMemberAuthority> = {},
): PackageMemberAuthority {
  return {
    packageName,
    version: "0.1.0",
    published: true,
    registryDigest: REGISTRY,
    provenanceSubjectDigest: REGISTRY,
    recordedDigest: REGISTRY,
    deprecated: null,
    cacheDigest: REGISTRY,
    cacheValid: true,
    rebuiltDigest: REBUILT_OK,
    proofChainComplete: true,
    registryVerified: true,
    ...overrides,
  };
}

function refsFor(
  packages: readonly PublicPackageName[],
  releasedSha = RELEASED,
  notice = "",
) {
  const tags: Record<string, { commitSha: string }> = {};
  const releases: Record<string, { targetSha: string; notes: string }> = {};
  for (const packageName of packages) {
    const tag = releaseTagName(packageName, "0.1.0");
    tags[tag] = { commitSha: releasedSha };
    releases[tag] = { targetSha: releasedSha, notes: notice || "release" };
  }
  return { tags, releases };
}

function authority(
  overrides: Partial<ReleaseAuthority> = {},
): ReleaseAuthority {
  const members = overrides.members ?? [member(CLI), member(OPENCODE)];
  const packages = members.map((item) => item.packageName);
  const refs = refsFor(packages);
  return {
    pullRequest: {
      number: 140,
      url: "https://github.com/weave-io/weave/pull/140",
      merged: true,
      closed: true,
      mergeCommitSha: RELEASED,
      headRef: "release-pr/stable",
    },
    releasedSha: RELEASED,
    channel: "stable",
    members,
    tags: refs.tags,
    releases: refs.releases,
    cleanupMerged: true,
    cleanupRequired: true,
    markerPresent: false,
    markerSha: null,
    associatedPullRequestSettled: true,
    incident: null,
    comments: [],
    ...overrides,
  };
}

const INCIDENT_MESSAGE = `Weave integrity incident at ${RELEASED}: published bytes are unreproducible from merged source. Do not install this version. Await the fix-forward release.`;

function incidentAuthority(
  overrides: Partial<ReleaseAuthority> = {},
): ReleaseAuthority {
  const members = [
    member(CLI, { rebuiltDigest: REBUILT_BAD }),
    member(OPENCODE, { rebuiltDigest: REBUILT_BAD }),
  ];
  const packages = [CLI, OPENCODE] as const;
  const refs = refsFor(packages, RELEASED, INCIDENT_MESSAGE);
  return authority({
    members,
    tags: refs.tags,
    releases: refs.releases,
    incident: {
      requiredMessage: INCIDENT_MESSAGE,
      affected: [
        { packageName: CLI, version: "0.1.0", digest: REGISTRY },
        { packageName: OPENCODE, version: "0.1.0", digest: REGISTRY },
      ],
      checkRunAtReleasedSha: false,
      releasesCarryNotice: false,
      deprecationsMatch: false,
    },
    ...overrides,
  });
}

describe("classifyPostMergeState", () => {
  const rows: readonly {
    name: string;
    primary: PrimaryReleaseState;
    authority: ReleaseAuthority;
  }[] = [
    {
      name: "PendingArtifactsOrProof",
      primary: "PendingArtifactsOrProof",
      authority: authority({
        members: [
          member(CLI, {
            published: false,
            registryDigest: null,
            provenanceSubjectDigest: null,
            cacheValid: false,
            proofChainComplete: false,
            registryVerified: false,
          }),
        ],
      }),
    },
    {
      name: "PendingNpm",
      primary: "PendingNpm",
      authority: authority({
        members: [
          member(CLI, {
            published: false,
            registryDigest: null,
            provenanceSubjectDigest: null,
            cacheValid: true,
            proofChainComplete: true,
            registryVerified: false,
          }),
          member(OPENCODE),
        ],
      }),
    },
    {
      name: "PendingRegistryVerification",
      primary: "PendingRegistryVerification",
      authority: authority({
        members: [member(CLI, { registryVerified: false }), member(OPENCODE)],
      }),
    },
    {
      name: "PendingTagsOrReleases failed tags",
      primary: "PendingTagsOrReleases",
      authority: authority({ tags: {} }),
    },
    {
      name: "PendingTagsOrReleases failed GitHub release",
      primary: "PendingTagsOrReleases",
      authority: authority({ releases: {} }),
    },
    {
      name: "PendingChangesetCleanup",
      primary: "PendingChangesetCleanup",
      authority: authority({ cleanupMerged: false }),
    },
    {
      name: "Complete",
      primary: "Complete",
      authority: authority(),
    },
    {
      name: "IntegrityIncident",
      primary: "IntegrityIncident",
      authority: incidentAuthority(),
    },
    {
      name: "CompleteWithIncident",
      primary: "CompleteWithIncident",
      authority: incidentAuthority({
        members: [
          member(CLI, {
            rebuiltDigest: REBUILT_BAD,
            deprecated: INCIDENT_MESSAGE,
          }),
          member(OPENCODE, {
            rebuiltDigest: REBUILT_BAD,
            deprecated: INCIDENT_MESSAGE,
          }),
        ],
        incident: {
          requiredMessage: INCIDENT_MESSAGE,
          affected: [
            { packageName: CLI, version: "0.1.0", digest: REGISTRY },
            { packageName: OPENCODE, version: "0.1.0", digest: REGISTRY },
          ],
          checkRunAtReleasedSha: true,
          releasesCarryNotice: true,
          deprecationsMatch: true,
        },
      }),
    },
  ];

  it("classifies every primary state from authority", () => {
    for (const row of rows) {
      const state = expectOk(classifyPostMergeState(row.authority));
      expect(state.primary).toBe(row.primary);
      expect(state.releasedSha).toBe(RELEASED);
    }
  });

  it("ignores a synthetic completion comment when refs are incomplete", () => {
    const state = expectOk(
      classifyPostMergeState(
        authority({
          tags: {},
          comments: ["release complete"],
        }),
      ),
    );
    expect(state.primary).toBe("PendingTagsOrReleases");
  });

  it("blocks preparation for every non-terminal state and releases it at both terminals", () => {
    for (const row of rows) {
      expect(blocksPreparation(row.primary)).toBe(
        !isTerminalPrimaryState(row.primary),
      );
    }
    expect(blocksPreparation("Complete")).toBe(false);
    expect(blocksPreparation("CompleteWithIncident")).toBe(false);
    expect(blocksPreparation("IntegrityIncident")).toBe(true);
  });

  it("sets MarkerCleanupPending only after merged or closed proof", () => {
    expect(
      expectOk(
        classifyPostMergeState(
          authority({
            markerPresent: true,
            markerSha: MARKER,
            associatedPullRequestSettled: true,
          }),
        ),
      ).markerCleanupPending,
    ).toBe(true);
    expect(
      expectOk(
        classifyPostMergeState(
          authority({
            markerPresent: true,
            markerSha: MARKER,
            associatedPullRequestSettled: false,
          }),
        ),
      ).markerCleanupPending,
    ).toBe(false);
  });

  it("transitions rebuilt mismatch into IntegrityIncident", () => {
    const state = expectOk(
      classifyPostMergeState(
        authority({
          members: [member(CLI, { rebuiltDigest: REBUILT_BAD })],
        }),
      ),
    );
    expect(state.primary).toBe("IntegrityIncident");
    expect(state.unreproducible).toEqual([
      {
        packageName: CLI,
        version: "0.1.0",
        registryDigest: REGISTRY,
        rebuiltDigest: REBUILT_BAD,
      },
    ]);
  });

  it("does not treat CompleteWithIncident as blessed bytes", () => {
    const resolved = rows.find((row) => row.primary === "CompleteWithIncident");
    if (resolved === undefined) throw new Error("missing CompleteWithIncident");
    const state = expectOk(classifyPostMergeState(resolved.authority));
    expect(state.unreproducible.length).toBeGreaterThan(0);
    expect(state.primary).toBe("CompleteWithIncident");
  });
});

describe("discovery", () => {
  const ownership: ReleasePrOwnership = {
    ref: "release-pr/stable",
    ownerGeneration: "a".repeat(64),
    expectedMarkerSha: MARKER,
    plannedBaseSha: "b".repeat(40),
  };

  function ports(input: {
    merged?: ReleaseAuthority[];
    open?: { number: number; url: string } | null;
    marker?: { sha: string } | null;
    ownership?: ReleasePrOwnership | null;
  }): ReleaseStatePorts {
    const merged = input.merged ?? [];
    return {
      listMergedStableReleasePullRequests: () =>
        okAsync(merged.map((item) => item.pullRequest)),
      readMarkerRef: () => okAsync(input.marker ?? null),
      readOpenStableReleasePullRequest: () => okAsync(input.open ?? null),
      readCreationCleanupIdentity: () => okAsync(input.ownership ?? null),
      readAuthority: (pullRequest) => {
        const match = merged.find(
          (item) => item.pullRequest.number === pullRequest.number,
        );
        return match === undefined
          ? errAsync({
              type: "GitHubError",
              operation: "readAuthority",
              message: "missing",
            })
          : okAsync(match);
      },
      recomputePlan: () =>
        errAsync({ type: "InvalidRecomputeRef", ref: RELEASED }),
    };
  }

  const seven: readonly {
    case: MergedDiscoveryCase;
    authority: ReleaseAuthority;
  }[] = [
    {
      case: "no-packages-published",
      authority: authority({
        members: [
          member(CLI, {
            published: false,
            registryDigest: null,
            provenanceSubjectDigest: null,
            cacheValid: false,
            proofChainComplete: false,
            registryVerified: false,
          }),
        ],
      }),
    },
    {
      case: "partial-npm",
      authority: authority({
        members: [
          member(CLI, {
            published: false,
            registryDigest: null,
            provenanceSubjectDigest: null,
            cacheValid: true,
            proofChainComplete: true,
            registryVerified: false,
          }),
          member(OPENCODE),
        ],
      }),
    },
    {
      case: "registry-verification-incomplete",
      authority: authority({
        members: [member(CLI, { registryVerified: false }), member(OPENCODE)],
      }),
    },
    {
      case: "tags-or-releases-incomplete",
      authority: authority({ tags: {} }),
    },
    {
      case: "changeset-cleanup-incomplete",
      authority: authority({ cleanupMerged: false }),
    },
    {
      case: "marker-cleanup-pending",
      authority: authority({
        markerPresent: true,
        markerSha: MARKER,
        associatedPullRequestSettled: true,
      }),
    },
    {
      case: "integrity-incident",
      authority: incidentAuthority(),
    },
  ];

  it("discovers all seven incomplete, incident, and marker cases", async () => {
    for (const row of seven) {
      const found = await discoverIncompleteReleases(
        ports({ merged: [row.authority] }),
      );
      const value = found._unsafeUnwrap();
      expect(value).toHaveLength(1);
      if (value[0]?.kind !== "merged-release")
        throw new Error("expected merged-release");
      expect(value[0].case).toBe(row.case);
    }
  });

  it("keeps a terminal release discoverable only while marker cleanup is pending", async () => {
    const complete = authority();
    const classified = expectOk(classifyPostMergeState(complete));
    expect(isDiscoverable(classified)).toBe(false);
    expect(discoveryCaseFor(classified, complete)).toBeNull();
    const none = await discoverIncompleteReleases(
      ports({ merged: [complete] }),
    );
    expect(none._unsafeUnwrap()).toEqual([]);

    const pending = authority({
      markerPresent: true,
      markerSha: MARKER,
      associatedPullRequestSettled: true,
    });
    const found = await discoverIncompleteReleases(
      ports({ merged: [pending] }),
    );
    const first = found._unsafeUnwrap()[0];
    expect(first?.kind).toBe("merged-release");
    if (first?.kind === "merged-release")
      expect(first.case).toBe("marker-cleanup-pending");
  });

  it("surfaces standalone CreationCleanupPending when no release PR exists", async () => {
    const found = await discoverIncompleteReleases(
      ports({
        marker: { sha: MARKER },
        open: null,
        ownership,
      }),
    );
    expect(found._unsafeUnwrap()).toEqual([
      { kind: "creation-cleanup-pending", ownership },
    ]);
  });

  it("implements the Task 9 completion port from recomputed authority", async () => {
    const snapshot = authority({ cleanupMerged: false });
    const port = createReleaseCompletionPort(ports({ merged: [snapshot] }));
    const observed = await port.readMergedReleaseCompletion();
    expect(observed._unsafeUnwrap()).toEqual({
      url: snapshot.pullRequest.url,
      state: "PendingChangesetCleanup",
      markerCleanupPending: false,
    });
  });
});
