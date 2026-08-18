/**
 * Resume remaining post-merge transitions, never crossing an incident.
 *
 * Each step re-reads authority immediately before acting and is idempotent.
 * `IntegrityIncident` may only clear a leftover marker; every other
 * transition belongs to the protected incident-resolution operation.
 * Creation-phase cleanup re-runs Task 9's generation-verified
 * `abortOwnedCreation` and never deletes a successor's marker.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import type {
  ChangesetCleanupError,
  ChangesetCleanupResult,
} from "./changeset-cleanup.js";
import type {
  PublicationError,
  PublicationReport,
} from "./publish-executor.js";
import type {
  ReleasePlan,
  ReleasePlanBinding,
  ReleasePlanError,
} from "./release-plan.js";
import type {
  AbortOwnedCreationOutcome,
  MarkerDeletionOutcome,
  ReleasePrError,
  ReleasePrOwnership,
} from "./release-pr-contract.js";
import type { ReleaseRefsError, ReleaseRefsResult } from "./release-refs.js";
import {
  classifyPostMergeState,
  type DiscoveredRelease,
  discoveryCaseFor,
  isDiscoverable,
  isTerminalPrimaryState,
  type MergedDiscoveryCase,
  type PackageMemberAuthority,
  type PostMergeReleaseState,
  type PrimaryReleaseState,
  type ReleaseAuthority,
  type ReleaseStateError,
  unreproducibleMembers,
} from "./release-state.js";

export type ResumeError =
  | {
      type: "IntegrityIncidentBlocksResume";
      primary: "IntegrityIncident";
      recovery: "incident-resolution";
    }
  | {
      type: "ReleasedBytesUnreproducible";
      members: ReturnType<typeof unreproducibleMembers>;
    }
  | { type: "ProofChainRequired"; packageName: string; version: string }
  | {
      type: "ResumeAuthorityStale";
      expected: PrimaryReleaseState;
      actual: PrimaryReleaseState;
    }
  | { type: "CreationCleanupOwnershipMismatch"; ownership: ReleasePrOwnership }
  | { type: "MarkerNotSettled"; ref: string }
  | { type: "NothingToResume" }
  | ReleaseStateError
  | PublicationError
  | ReleaseRefsError
  | ChangesetCleanupError
  | ReleasePrError
  | ReleasePlanError;

function failResume(
  error: ResumeError,
): ResultAsync<ResumeResult, ResumeError> {
  return errAsync(error);
}

export interface ArtifactCache {
  binding: ReleasePlanBinding;
  digestValid: boolean;
  expired: boolean;
}

export interface ArtifactAcquisitionResult {
  binding: ReleasePlanBinding | null;
  rebuilt: boolean;
  unpublishedRequireProof: readonly {
    packageName: string;
    version: string;
  }[];
}

export interface ResumeTransitionPorts {
  rereadAuthority(): ResultAsync<ReleaseAuthority, ReleaseStateError>;
  readCache(): ResultAsync<ArtifactCache | null, ResumeError>;
  rebuildAt(releasedSha: string): ResultAsync<
    {
      members: readonly {
        packageName: string;
        version: string;
        digest: string;
      }[];
      binding: ReleasePlanBinding;
    },
    ResumeError
  >;
  publishRemaining(input: {
    authority: ReleaseAuthority;
    binding: ReleasePlanBinding;
  }): ResultAsync<PublicationReport, PublicationError>;
  verifyRegistry(authority: ReleaseAuthority): ResultAsync<void, ResumeError>;
  applyRefs(
    authority: ReleaseAuthority,
  ): ResultAsync<ReleaseRefsResult, ReleaseRefsError>;
  applyCleanup(
    authority: ReleaseAuthority,
  ): ResultAsync<ChangesetCleanupResult, ChangesetCleanupError>;
  deleteSettledMarker(input: {
    authority: ReleaseAuthority;
  }): ResultAsync<MarkerDeletionOutcome, ReleasePrError>;
  abortOwnedCreation(input: {
    ownership: ReleasePrOwnership;
    reconcile?: boolean;
  }): ResultAsync<AbortOwnedCreationOutcome, ReleasePrError>;
  recomputePlan(input: {
    stored: unknown;
    releasedSha: string;
  }): ResultAsync<ReleasePlan, ReleasePlanError>;
}

export interface ResumeRequest {
  discovered: DiscoveredRelease;
  storedPlan?: unknown;
}

export interface ResumeResult {
  state: PostMergeReleaseState | null;
  case: MergedDiscoveryCase | "creation-cleanup-pending" | "complete";
  transitions: readonly ResumeTransitionName[];
}

export type ResumeTransitionName =
  | "rebuild-or-reuse-cache"
  | "publish"
  | "verify-registry"
  | "apply-refs"
  | "apply-cleanup"
  | "clear-marker"
  | "abort-owned-creation";

export function remainingTransitions(
  primary: PrimaryReleaseState,
  markerCleanupPending: boolean,
): readonly ResumeTransitionName[] {
  if (primary === "IntegrityIncident")
    return markerCleanupPending ? ["clear-marker"] : [];
  if (primary === "Complete" || primary === "CompleteWithIncident")
    return markerCleanupPending ? ["clear-marker"] : [];
  const transitions: ResumeTransitionName[] = [];
  if (primary === "PendingArtifactsOrProof")
    transitions.push("rebuild-or-reuse-cache");
  if (primary === "PendingArtifactsOrProof" || primary === "PendingNpm")
    transitions.push("publish");
  if (
    primary === "PendingArtifactsOrProof" ||
    primary === "PendingNpm" ||
    primary === "PendingRegistryVerification"
  )
    transitions.push("verify-registry");
  if (
    primary === "PendingArtifactsOrProof" ||
    primary === "PendingNpm" ||
    primary === "PendingRegistryVerification" ||
    primary === "PendingTagsOrReleases"
  )
    transitions.push("apply-refs");
  transitions.push("apply-cleanup");
  if (markerCleanupPending) transitions.push("clear-marker");
  return transitions;
}

export function resumeRelease(
  request: ResumeRequest,
  ports: ResumeTransitionPorts,
): ResultAsync<ResumeResult, ResumeError> {
  if (request.discovered.kind === "creation-cleanup-pending")
    return resumeCreationCleanup(request.discovered.ownership, ports);
  return resumeMerged(request, ports);
}

function resumeCreationCleanup(
  ownership: ReleasePrOwnership,
  ports: ResumeTransitionPorts,
): ResultAsync<ResumeResult, ResumeError> {
  return ports
    .abortOwnedCreation({ ownership, reconcile: true })
    .andThen((outcome) => {
      if (outcome.kind === "pull-request-visible")
        return okAsync({
          state: null,
          case: "creation-cleanup-pending" as const,
          transitions: ["abort-owned-creation" as const],
        });
      return okAsync({
        state: null,
        case: "creation-cleanup-pending" as const,
        transitions: ["abort-owned-creation" as const],
      });
    });
}

function resumeMerged(
  request: ResumeRequest,
  ports: ResumeTransitionPorts,
): ResultAsync<ResumeResult, ResumeError> {
  if (request.discovered.kind !== "merged-release")
    return failResume({ type: "NothingToResume" });
  const initial = request.discovered.state;
  return ports.rereadAuthority().andThen((authority) => {
    const classified = classifyPostMergeState(authority);
    if (classified.isErr()) return failResume(classified.error);
    const current = classified.value;
    if (current.primary !== initial.primary)
      return failResume({
        type: "ResumeAuthorityStale",
        expected: initial.primary,
        actual: current.primary,
      });
    if (current.primary === "IntegrityIncident")
      return resumeIntegrityIncident(current, authority, ports);
    if (
      isTerminalPrimaryState(current.primary) &&
      !current.markerCleanupPending
    )
      return okAsync({
        state: current,
        case: "complete" as const,
        transitions: [],
      });
    const remaining = [
      ...remainingTransitions(current.primary, current.markerCleanupPending),
    ];
    if (request.storedPlan === undefined)
      return runRemaining(authority, ports, remaining);
    return ports
      .recomputePlan({
        stored: request.storedPlan,
        releasedSha: current.releasedSha,
      })
      .andThen(() => runRemaining(authority, ports, remaining));
  });
}

function resumeIntegrityIncident(
  state: PostMergeReleaseState,
  authority: ReleaseAuthority,
  ports: ResumeTransitionPorts,
): ResultAsync<ResumeResult, ResumeError> {
  if (!state.markerCleanupPending)
    return errAsync({
      type: "IntegrityIncidentBlocksResume",
      primary: "IntegrityIncident",
      recovery: "incident-resolution",
    });
  return clearMarker(authority, ports).andThen(() =>
    ports.rereadAuthority().andThen((next) => {
      const classified = classifyPostMergeState(next);
      if (classified.isErr()) return errAsync(classified.error);
      return okAsync({
        state: classified.value,
        case: "integrity-incident" as const,
        transitions: ["clear-marker" as const],
      });
    }),
  );
}

function runRemaining(
  authority: ReleaseAuthority,
  ports: ResumeTransitionPorts,
  transitions: ResumeTransitionName[],
): ResultAsync<ResumeResult, ResumeError> {
  return transitions
    .reduce<ResultAsync<ReleaseAuthority, ResumeError>>(
      (chain, transition) =>
        chain.andThen(() => executeTransition(transition, ports)),
      okAsync(authority),
    )
    .andThen((finalAuthority) => {
      const classified = classifyPostMergeState(finalAuthority);
      if (classified.isErr()) return errAsync(classified.error);
      const discoveredCase: ResumeResult["case"] =
        discoveryCaseFor(classified.value, finalAuthority) ??
        (isDiscoverable(classified.value)
          ? "no-packages-published"
          : "complete");
      return okAsync({
        state: classified.value,
        case: discoveredCase,
        transitions,
      });
    });
}

function executeTransition(
  transition: ResumeTransitionName,
  ports: ResumeTransitionPorts,
): ResultAsync<ReleaseAuthority, ResumeError> {
  return ports.rereadAuthority().andThen((live) => {
    const classified = classifyPostMergeState(live);
    if (classified.isErr()) return errAsync(classified.error);
    if (classified.value.primary === "IntegrityIncident")
      return transition === "clear-marker"
        ? clearMarker(live, ports).map(() => live)
        : errAsync({
            type: "IntegrityIncidentBlocksResume" as const,
            primary: "IntegrityIncident" as const,
            recovery: "incident-resolution" as const,
          });
    switch (transition) {
      case "rebuild-or-reuse-cache":
        return acquireArtifacts(live, ports);
      case "publish":
        return publish(live, ports);
      case "verify-registry":
        return ports.verifyRegistry(live).map(() => live);
      case "apply-refs":
        return ports.applyRefs(live).map(() => live);
      case "apply-cleanup":
        return ports.applyCleanup(live).map(() => live);
      case "clear-marker":
        return clearMarker(live, ports).map(() => live);
      case "abort-owned-creation":
        return okAsync(live);
    }
  });
}

export function acquireArtifacts(
  authority: ReleaseAuthority,
  ports: Pick<ResumeTransitionPorts, "readCache" | "rebuildAt">,
): ResultAsync<ReleaseAuthority, ResumeError> {
  return ports.readCache().andThen((cache) => {
    if (cache?.digestValid === true && cache.expired === false) {
      const checked = checkPublishedAgainstCache(authority, cache.binding);
      if (checked.isErr()) return errAsync(checked.error);
      return okAsync(authority);
    }
    return ports.rebuildAt(authority.releasedSha).andThen((rebuilt) => {
      const compared = applyRebuildComparison(authority, rebuilt.members);
      if (compared.isErr()) return errAsync(compared.error);
      const unpublished = compared.value.members.filter(
        (member) => !member.published,
      );
      const missingProof = unpublished.filter(
        (member) => !member.proofChainComplete,
      );
      if (missingProof.length > 0)
        return errAsync({
          type: "ProofChainRequired" as const,
          packageName: missingProof[0]?.packageName ?? "",
          version: missingProof[0]?.version ?? "",
        });
      return okAsync(compared.value);
    });
  });
}

function checkPublishedAgainstCache(
  authority: ReleaseAuthority,
  binding: ReleasePlanBinding,
): Result<void, ResumeError> {
  for (const member of authority.members) {
    if (!member.published || member.registryDigest === null) continue;
    const bound = binding.tarballs.find(
      (tarball) =>
        tarball.packageName === member.packageName &&
        tarball.version === member.version,
    );
    if (bound !== undefined && bound.sha256 !== member.registryDigest)
      return err({
        type: "ReleasedBytesUnreproducible",
        members: [
          {
            packageName: member.packageName,
            version: member.version,
            registryDigest: member.registryDigest,
            rebuiltDigest: bound.sha256,
          },
        ],
      });
  }
  return ok(undefined);
}

function applyRebuildComparison(
  authority: ReleaseAuthority,
  rebuilt: readonly { packageName: string; version: string; digest: string }[],
): Result<ReleaseAuthority, ResumeError> {
  const members: PackageMemberAuthority[] = authority.members.map((member) => {
    const match = rebuilt.find(
      (item) =>
        item.packageName === member.packageName &&
        item.version === member.version,
    );
    return match === undefined
      ? member
      : { ...member, rebuiltDigest: match.digest };
  });
  const unreproducible = unreproducibleMembers(members);
  if (unreproducible.length > 0)
    return err({
      type: "ReleasedBytesUnreproducible",
      members: unreproducible,
    });
  return ok({ ...authority, members });
}

function publish(
  authority: ReleaseAuthority,
  ports: ResumeTransitionPorts,
): ResultAsync<ReleaseAuthority, ResumeError> {
  return ports.readCache().andThen((cache) => {
    if (cache === null || !cache.digestValid)
      return errAsync({
        type: "ProofChainRequired" as const,
        packageName: authority.members[0]?.packageName ?? "",
        version: authority.members[0]?.version ?? "",
      });
    const unpublished = authority.members.filter((member) => !member.published);
    const unproven = unpublished.filter((member) => !member.proofChainComplete);
    if (unproven.length > 0)
      return errAsync({
        type: "ProofChainRequired" as const,
        packageName: unproven[0]?.packageName ?? "",
        version: unproven[0]?.version ?? "",
      });
    return ports
      .publishRemaining({ authority, binding: cache.binding })
      .map(() => authority);
  });
}

function clearMarker(
  authority: ReleaseAuthority,
  ports: ResumeTransitionPorts,
): ResultAsync<MarkerDeletionOutcome, ResumeError> {
  if (!authority.associatedPullRequestSettled)
    return errAsync({
      type: "MarkerNotSettled",
      ref: "release-pr/stable",
    });
  return ports.deleteSettledMarker({ authority });
}

export function creationCleanupOwnershipMatches(input: {
  recorded: ReleasePrOwnership;
  live: ReleasePrOwnership;
}): Result<void, ResumeError> {
  if (input.recorded.ownerGeneration !== input.live.ownerGeneration)
    return err({
      type: "CreationCleanupOwnershipMismatch",
      ownership: input.live,
    });
  if (input.recorded.expectedMarkerSha !== input.live.expectedMarkerSha)
    return err({
      type: "CreationCleanupOwnershipMismatch",
      ownership: input.live,
    });
  return ok(undefined);
}
