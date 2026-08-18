import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type Result } from "neverthrow";
import {
  RELEASE_PLAN_SCHEMA_VERSION,
  type ReleasePlanBinding,
} from "../release-plan.js";
import type { ReleasePrOwnership } from "../release-pr-contract.js";
import {
  classifyPostMergeState,
  type PackageMemberAuthority,
  type ReleaseAuthority,
} from "../release-state.js";
import {
  acquireArtifacts,
  creationCleanupOwnershipMatches,
  type ResumeTransitionPorts,
  remainingTransitions,
  resumeRelease,
} from "../resume.js";

const CLI = "@weaveio/weave-cli" as const;
const RELEASED = "c".repeat(40);
const REGISTRY = digest("registry");
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
  overrides: Partial<PackageMemberAuthority> = {},
): PackageMemberAuthority {
  return {
    packageName: CLI,
    version: "0.1.0",
    published: true,
    registryDigest: REGISTRY,
    provenanceSubjectDigest: REGISTRY,
    recordedDigest: REGISTRY,
    deprecated: null,
    cacheDigest: REGISTRY,
    cacheValid: true,
    rebuiltDigest: REGISTRY,
    proofChainComplete: true,
    registryVerified: true,
    ...overrides,
  };
}

function binding(): ReleasePlanBinding {
  return {
    schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
    builtSha: RELEASED,
    tarballs: [
      {
        packageName: CLI,
        version: "0.1.0",
        path: "cli.tgz",
        sha256: REGISTRY,
      },
    ],
    manifestDigests: [
      {
        packageName: CLI,
        stagedManifestDigest: REGISTRY,
        publicManifestDigest: REGISTRY,
      },
    ],
    changelogDigests: [
      { packageName: CLI, version: "0.1.0", documentDigest: REGISTRY },
    ],
    entryPointDigests: [
      { packageName: CLI, entryPoint: "dist/index.js", digest: REGISTRY },
    ],
    proofMarkers: {
      attestation: { status: "recorded", digest: REGISTRY },
      cleanConsumer: { status: "recorded", digest: REGISTRY },
      harnessProof: { status: "pending" },
      registryVerification: { status: "recorded", digest: REGISTRY },
    },
  };
}

function authority(
  overrides: Partial<ReleaseAuthority> = {},
): ReleaseAuthority {
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
    members: [member()],
    tags: { "weave-cli@0.1.0": { commitSha: RELEASED } },
    releases: {
      "weave-cli@0.1.0": { targetSha: RELEASED, notes: "ok" },
    },
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

function ports(
  live: () => ReleaseAuthority,
  options: {
    cache?: {
      binding: ReleasePlanBinding;
      digestValid: boolean;
      expired: boolean;
    } | null;
    rebuildDigest?: string;
    abort?: (
      ownership: ReleasePrOwnership,
    ) => "deleted" | "visible" | "mismatch";
    deletes?: string[];
    publishes?: number;
  } = {},
): ResumeTransitionPorts {
  const deletes = options.deletes ?? [];
  return {
    rereadAuthority: () => okAsync(live()),
    readCache: () =>
      okAsync(
        options.cache === undefined
          ? { binding: binding(), digestValid: true, expired: false }
          : options.cache,
      ),
    rebuildAt: () =>
      okAsync({
        members: [
          {
            packageName: CLI,
            version: "0.1.0",
            digest: options.rebuildDigest ?? REGISTRY,
          },
        ],
        binding: binding(),
      }),
    publishRemaining: () => {
      options.publishes = (options.publishes ?? 0) + 1;
      return okAsync({
        schemaVersion: 1,
        channel: "stable",
        tag: "latest",
        releasedSha: RELEASED,
        members: [
          {
            packageName: CLI,
            version: "0.1.0",
            tarballSha256: REGISTRY,
            status: "already-published",
            verification: "digest-verified",
          },
        ],
      });
    },
    verifyRegistry: () => okAsync(undefined),
    applyRefs: () => okAsync({ status: "applied", items: [] }),
    applyCleanup: () => okAsync({ status: "skipped", reason: "empty" }),
    deleteSettledMarker: () => {
      deletes.push("marker");
      return okAsync({
        kind: "deleted",
        ref: "release-pr/stable",
        markerSha: "d".repeat(40),
      });
    },
    abortOwnedCreation: ({ ownership }) => {
      const mode = options.abort?.(ownership) ?? "deleted";
      if (mode === "mismatch")
        return errAsync({
          type: "CreationCleanupPending",
          ref: ownership.ref,
          ownerGeneration: ownership.ownerGeneration,
          expectedMarkerSha: ownership.expectedMarkerSha,
          plannedBaseSha: ownership.plannedBaseSha,
          reason: "ownership-changed",
        });
      if (mode === "visible")
        return okAsync({
          kind: "pull-request-visible",
          url: "https://github.com/weave-io/weave/pull/141",
          ownership,
        });
      return okAsync({ kind: "marker-absent", ownership });
    },
    recomputePlan: () =>
      errAsync({ type: "InvalidRecomputeRef", ref: RELEASED }),
  };
}

describe("remainingTransitions", () => {
  it("is idempotent for completed work and refuses to cross IntegrityIncident", () => {
    expect(remainingTransitions("Complete", false)).toEqual([]);
    expect(remainingTransitions("CompleteWithIncident", false)).toEqual([]);
    expect(remainingTransitions("IntegrityIncident", false)).toEqual([]);
    expect(remainingTransitions("IntegrityIncident", true)).toEqual([
      "clear-marker",
    ]);
    expect(remainingTransitions("PendingNpm", false)).toEqual([
      "publish",
      "verify-registry",
      "apply-refs",
      "apply-cleanup",
    ]);
    expect(remainingTransitions("PendingTagsOrReleases", false)).toEqual([
      "apply-refs",
      "apply-cleanup",
    ]);
    expect(remainingTransitions("PendingChangesetCleanup", false)).toEqual([
      "apply-cleanup",
    ]);
    expect(remainingTransitions("PendingTagsOrReleases", false)).toEqual([
      "apply-refs",
      "apply-cleanup",
    ]);
    expect(remainingTransitions("PendingNpm", false)).toEqual([
      "publish",
      "verify-registry",
      "apply-refs",
      "apply-cleanup",
    ]);
  });
});

describe("resumeRelease", () => {
  it("resumes only remaining transitions and is a no-op when rerun", async () => {
    const snapshot = authority({ cleanupMerged: false });
    const classified = expectOk(classifyPostMergeState(snapshot));
    const world = ports(() => snapshot);
    const first = await resumeRelease(
      {
        discovered: {
          kind: "merged-release",
          case: "changeset-cleanup-incomplete",
          state: classified,
        },
      },
      world,
    );
    expect(first._unsafeUnwrap().transitions).toEqual(["apply-cleanup"]);
    const complete = authority();
    const second = await resumeRelease(
      {
        discovered: {
          kind: "merged-release",
          case: "changeset-cleanup-incomplete",
          state: expectOk(classifyPostMergeState(complete)),
        },
      },
      ports(() => complete),
    );
    expect(second._unsafeUnwrap()).toEqual({
      state: expectOk(classifyPostMergeState(complete)),
      case: "complete",
      transitions: [],
    });
  });

  it("clears marker cleanup only after merged or closed proof", async () => {
    const unsettled = authority({
      markerPresent: true,
      markerSha: "d".repeat(40),
      associatedPullRequestSettled: false,
      cleanupMerged: false,
    });
    const result = await resumeRelease(
      {
        discovered: {
          kind: "merged-release",
          case: "changeset-cleanup-incomplete",
          state: expectOk(classifyPostMergeState(unsettled)),
        },
      },
      ports(() => unsettled),
    );
    expect(result.isOk()).toBe(true);

    const settled = authority({
      markerPresent: true,
      markerSha: "d".repeat(40),
      associatedPullRequestSettled: true,
    });
    const deletes: string[] = [];
    const cleared = await resumeRelease(
      {
        discovered: {
          kind: "merged-release",
          case: "marker-cleanup-pending",
          state: expectOk(classifyPostMergeState(settled)),
        },
      },
      ports(() => settled, { deletes }),
    );
    expect(cleared._unsafeUnwrap().transitions).toEqual(["clear-marker"]);
    expect(deletes).toEqual(["marker"]);
  });

  it("refuses every non-marker transition on IntegrityIncident", async () => {
    const snapshot = authority({
      members: [member({ rebuiltDigest: REBUILT_BAD })],
    });
    const result = await resumeRelease(
      {
        discovered: {
          kind: "merged-release",
          case: "integrity-incident",
          state: expectOk(classifyPostMergeState(snapshot)),
        },
      },
      ports(() => snapshot),
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "IntegrityIncidentBlocksResume",
      primary: "IntegrityIncident",
      recovery: "incident-resolution",
    });
  });

  it("clears CreationCleanupPending through generation-verified abortOwnedCreation", async () => {
    const ownership: ReleasePrOwnership = {
      ref: "release-pr/stable",
      ownerGeneration: "a".repeat(64),
      expectedMarkerSha: "d".repeat(40),
      plannedBaseSha: "b".repeat(40),
    };
    const visible = await resumeRelease(
      { discovered: { kind: "creation-cleanup-pending", ownership } },
      ports(() => authority(), { abort: () => "visible" }),
    );
    expect(visible._unsafeUnwrap().transitions).toEqual([
      "abort-owned-creation",
    ]);

    const successor: ReleasePrOwnership = {
      ...ownership,
      ownerGeneration: "f".repeat(64),
      expectedMarkerSha: "e".repeat(40),
    };
    const aba = await resumeRelease(
      { discovered: { kind: "creation-cleanup-pending", ownership } },
      ports(() => authority(), { abort: () => "mismatch" }),
    );
    expect(aba._unsafeUnwrapErr().type).toBe("CreationCleanupPending");
    expect(
      creationCleanupOwnershipMatches({
        recorded: ownership,
        live: successor,
      })._unsafeUnwrapErr().type,
    ).toBe("CreationCleanupOwnershipMismatch");
  });

  it("fails closed when stored-plan recompute diverges", async () => {
    const snapshot = authority({ cleanupMerged: false });
    const result = await resumeRelease(
      {
        discovered: {
          kind: "merged-release",
          case: "changeset-cleanup-incomplete",
          state: expectOk(classifyPostMergeState(snapshot)),
        },
        storedPlan: { schemaVersion: 0 },
      },
      ports(() => snapshot),
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "InvalidRecomputeRef",
      ref: RELEASED,
    });
  });

  it("on IntegrityIncident only clears a settled leftover marker", async () => {
    const snapshot = authority({
      members: [member({ rebuiltDigest: REBUILT_BAD })],
      markerPresent: true,
      markerSha: "d".repeat(40),
      associatedPullRequestSettled: true,
    });
    const deletes: string[] = [];
    const result = await resumeRelease(
      {
        discovered: {
          kind: "merged-release",
          case: "integrity-incident",
          state: expectOk(classifyPostMergeState(snapshot)),
        },
      },
      ports(() => snapshot, { deletes }),
    );
    expect(result._unsafeUnwrap().transitions).toEqual(["clear-marker"]);
    expect(deletes).toEqual(["marker"]);
  });
});

describe("acquireArtifacts", () => {
  it("reuses a valid cache after registry checks", async () => {
    const snapshot = authority({
      members: [member({ published: false, registryVerified: false })],
    });
    const result = await acquireArtifacts(
      snapshot,
      ports(() => snapshot, {
        cache: { binding: binding(), digestValid: true, expired: false },
      }),
    );
    expect(result.isOk()).toBe(true);
  });

  it("rebuilds expired cache at releasedSha and requires proof for unpublished members", async () => {
    const snapshot = authority({
      members: [
        member({
          published: false,
          registryDigest: null,
          proofChainComplete: false,
          registryVerified: false,
        }),
      ],
    });
    const result = await acquireArtifacts(
      snapshot,
      ports(() => snapshot, {
        cache: { binding: binding(), digestValid: true, expired: true },
      }),
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "ProofChainRequired",
      packageName: CLI,
      version: "0.1.0",
    });
  });

  it("fails closed when rebuilt published bytes do not match the registry", async () => {
    const snapshot = authority();
    const result = await acquireArtifacts(
      snapshot,
      ports(() => snapshot, {
        cache: null,
        rebuildDigest: REBUILT_BAD,
      }),
    );
    expect(result._unsafeUnwrapErr().type).toBe("ReleasedBytesUnreproducible");
  });
});
