/**
 * Post-merge release state: recomputed from authority, never from cache.
 *
 * A merged stable release walks
 * `PendingArtifactsOrProof → PendingNpm → PendingRegistryVerification →
 * PendingTagsOrReleases → PendingChangesetCleanup → Complete`.
 * Published bytes that cannot be reproduced from `releasedSha` become
 * `IntegrityIncident`, and only the separately authorized incident-resolution
 * operation can exit to `CompleteWithIncident`. `MarkerCleanupPending` is
 * orthogonal: a terminal primary state with a leftover marker stays
 * discoverable until the safe delete succeeds.
 *
 * Workflow artifacts, PR comments, and status checks may cache a result.
 * They are never authority.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import type { PublicPackageName } from "./constants.js";
import { PUBLIC_PACKAGES, RELEASE_INPUT_LIMITS } from "./constants.js";
import type { GitHubError } from "./errors.js";
import { releaseTagName } from "./notes-wrapper.js";
import type { ReleasePlan, ReleasePlanError } from "./release-plan.js";
import {
  type MergedReleaseObservation,
  RELEASE_COMPLETION_STATES,
  RELEASE_PR_MARKER_REF,
  type ReleaseCompletionPort,
  type ReleaseCompletionState,
  type ReleasePrOwnership,
  TERMINAL_RELEASE_COMPLETION_STATES,
} from "./release-pr-contract.js";

export const POST_MERGE_PRIMARY_STATES = RELEASE_COMPLETION_STATES;

export type PrimaryReleaseState = ReleaseCompletionState;

export const RELEASE_STATE_BOUNDS = {
  members: RELEASE_INPUT_LIMITS.packageCount,
  messageBytes: 512,
  pathLength: RELEASE_INPUT_LIMITS.identifierLength,
  urlLength: 2_048,
  commentBytes: 4_096,
} as const;

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type ReleaseStateError =
  | { type: "InvalidReleasedSha"; sha: string }
  | { type: "InvalidReleaseAuthority"; issues: readonly string[] }
  | { type: "PlanRecomputeFailed"; error: ReleasePlanError }
  | {
      type: "ReleasedBytesUnreproducible";
      members: readonly UnreproducibleMember[];
    }
  | { type: "UnknownReleaseCompletionState"; state: string }
  | GitHubError;

export interface UnreproducibleMember {
  packageName: PublicPackageName;
  version: string;
  registryDigest: string;
  rebuiltDigest: string;
}

export interface MergedReleasePullRequestAuthority {
  number: number;
  url: string;
  merged: boolean;
  closed: boolean;
  mergeCommitSha: string;
  headRef: string;
}

export interface PackageMemberAuthority {
  packageName: PublicPackageName;
  version: string;
  published: boolean;
  registryDigest: string | null;
  provenanceSubjectDigest: string | null;
  recordedDigest: string | null;
  deprecated: string | null;
  cacheDigest: string | null;
  cacheValid: boolean;
  rebuiltDigest: string | null;
  proofChainComplete: boolean;
  registryVerified: boolean;
}

export interface IncidentAuthorityEvidence {
  requiredMessage: string;
  affected: readonly {
    packageName: PublicPackageName;
    version: string;
    digest: string;
  }[];
  checkRunAtReleasedSha: boolean;
  releasesCarryNotice: boolean;
  deprecationsMatch: boolean;
}

export interface ReleaseAuthority {
  pullRequest: MergedReleasePullRequestAuthority;
  releasedSha: string;
  channel: "stable";
  members: readonly PackageMemberAuthority[];
  tags: Readonly<Record<string, { commitSha: string }>>;
  releases: Readonly<Record<string, { targetSha: string; notes: string }>>;
  cleanupMerged: boolean;
  cleanupRequired: boolean;
  markerPresent: boolean;
  markerSha: string | null;
  associatedPullRequestSettled: boolean;
  incident: IncidentAuthorityEvidence | null;
  /** Accepted only so tests can prove comments are never authority. */
  comments: readonly string[];
}

export interface PostMergeReleaseState {
  primary: PrimaryReleaseState;
  markerCleanupPending: boolean;
  releasedSha: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  unreproducible: readonly UnreproducibleMember[];
}

export type DiscoveredRelease =
  | {
      kind: "merged-release";
      case: MergedDiscoveryCase;
      state: PostMergeReleaseState;
    }
  | {
      kind: "creation-cleanup-pending";
      ownership: ReleasePrOwnership;
    };

export type MergedDiscoveryCase =
  | "no-packages-published"
  | "partial-npm"
  | "registry-verification-incomplete"
  | "tags-or-releases-incomplete"
  | "changeset-cleanup-incomplete"
  | "marker-cleanup-pending"
  | "integrity-incident";

const PackageNameSchema = z.enum(
  Object.keys(PUBLIC_PACKAGES) as [PublicPackageName, ...PublicPackageName[]],
);

const MemberAuthoritySchema = z
  .object({
    packageName: PackageNameSchema,
    version: z.string().min(1).max(64),
    published: z.boolean(),
    registryDigest: z.string().regex(DIGEST).nullable(),
    provenanceSubjectDigest: z.string().regex(DIGEST).nullable(),
    recordedDigest: z.string().regex(DIGEST).nullable(),
    deprecated: z.string().max(RELEASE_STATE_BOUNDS.messageBytes).nullable(),
    cacheDigest: z.string().regex(DIGEST).nullable(),
    cacheValid: z.boolean(),
    rebuiltDigest: z.string().regex(DIGEST).nullable(),
    proofChainComplete: z.boolean(),
    registryVerified: z.boolean(),
  })
  .strict();

export const ReleaseAuthoritySchema = z
  .object({
    pullRequest: z
      .object({
        number: z.number().int().positive(),
        url: z.string().min(1).max(RELEASE_STATE_BOUNDS.urlLength),
        merged: z.boolean(),
        closed: z.boolean(),
        mergeCommitSha: z.string().regex(FULL_SHA),
        headRef: z.string().min(1).max(RELEASE_STATE_BOUNDS.pathLength),
      })
      .strict(),
    releasedSha: z.string().regex(FULL_SHA),
    channel: z.literal("stable"),
    members: z
      .array(MemberAuthoritySchema)
      .min(1)
      .max(RELEASE_STATE_BOUNDS.members),
    tags: z.record(
      z.string(),
      z.object({ commitSha: z.string().regex(FULL_SHA) }).strict(),
    ),
    releases: z.record(
      z.string(),
      z
        .object({
          targetSha: z.string().regex(FULL_SHA),
          notes: z.string().max(64 * 1024),
        })
        .strict(),
    ),
    cleanupMerged: z.boolean(),
    cleanupRequired: z.boolean(),
    markerPresent: z.boolean(),
    markerSha: z.string().regex(FULL_SHA).nullable(),
    associatedPullRequestSettled: z.boolean(),
    incident: z
      .object({
        requiredMessage: z
          .string()
          .min(1)
          .max(RELEASE_STATE_BOUNDS.messageBytes),
        affected: z
          .array(
            z
              .object({
                packageName: PackageNameSchema,
                version: z.string().min(1).max(64),
                digest: z.string().regex(DIGEST),
              })
              .strict(),
          )
          .min(1)
          .max(RELEASE_STATE_BOUNDS.members),
        checkRunAtReleasedSha: z.boolean(),
        releasesCarryNotice: z.boolean(),
        deprecationsMatch: z.boolean(),
      })
      .strict()
      .nullable(),
    comments: z
      .array(z.string().max(RELEASE_STATE_BOUNDS.commentBytes))
      .max(32),
  })
  .strict();

export function isTerminalPrimaryState(state: PrimaryReleaseState): boolean {
  return (TERMINAL_RELEASE_COMPLETION_STATES as readonly string[]).includes(
    state,
  );
}

export function blocksPreparation(state: PrimaryReleaseState): boolean {
  return !isTerminalPrimaryState(state);
}

export function validateReleaseAuthority(
  input: unknown,
): Result<ReleaseAuthority, ReleaseStateError> {
  const parsed = ReleaseAuthoritySchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidReleaseAuthority",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  if (parsed.data.releasedSha !== parsed.data.pullRequest.mergeCommitSha)
    return err({
      type: "InvalidReleasedSha",
      sha: parsed.data.releasedSha,
    });
  return ok(parsed.data);
}

/**
 * Pure classifier over an already-gathered authority snapshot.
 *
 * Comments are ignored. Cache fields only decide whether unpublished
 * members still need a rebuild or proof; published members are decided
 * from registry bytes plus provenance.
 */
export function classifyPostMergeState(
  input: unknown,
): Result<PostMergeReleaseState, ReleaseStateError> {
  const authority = validateReleaseAuthority(input);
  if (authority.isErr()) return err(authority.error);
  const snapshot = authority.value;
  const unreproducible = unreproducibleMembers(snapshot.members);
  const incidentResolved = isCompleteWithIncident(snapshot);
  let primary: PrimaryReleaseState;
  if (incidentResolved) primary = "CompleteWithIncident";
  else if (unreproducible.length > 0 || snapshot.incident !== null)
    primary = "IntegrityIncident";
  else primary = classifyNormalPrimary(snapshot);
  return ok({
    primary,
    markerCleanupPending: isMarkerCleanupPending(snapshot),
    releasedSha: snapshot.releasedSha,
    pullRequestUrl: snapshot.pullRequest.url,
    pullRequestNumber: snapshot.pullRequest.number,
    unreproducible,
  });
}

function classifyNormalPrimary(
  authority: ReleaseAuthority,
): PrimaryReleaseState {
  if (needsArtifactsOrProof(authority.members))
    return "PendingArtifactsOrProof";
  if (authority.members.some((member) => !member.published))
    return "PendingNpm";
  if (authority.members.some((member) => !member.registryVerified))
    return "PendingRegistryVerification";
  if (!refsComplete(authority)) return "PendingTagsOrReleases";
  if (authority.cleanupRequired && !authority.cleanupMerged)
    return "PendingChangesetCleanup";
  return "Complete";
}

export function unreproducibleMembers(
  members: readonly PackageMemberAuthority[],
): readonly UnreproducibleMember[] {
  const found: UnreproducibleMember[] = [];
  for (const member of members) {
    if (!member.published || member.registryDigest === null) continue;
    const provenanceMismatch =
      member.provenanceSubjectDigest !== null &&
      member.provenanceSubjectDigest !== member.registryDigest;
    const rebuildMismatch =
      member.rebuiltDigest !== null &&
      member.rebuiltDigest !== member.registryDigest;
    if (!provenanceMismatch && !rebuildMismatch) continue;
    found.push({
      packageName: member.packageName,
      version: member.version,
      registryDigest: member.registryDigest,
      rebuiltDigest: member.rebuiltDigest ?? member.registryDigest,
    });
  }
  return found;
}

function needsArtifactsOrProof(
  members: readonly PackageMemberAuthority[],
): boolean {
  return members.some((member) => {
    if (member.published) return false;
    if (member.cacheValid && member.proofChainComplete) return false;
    return true;
  });
}

function refsComplete(authority: ReleaseAuthority): boolean {
  return authority.members.every((member) => {
    const tag = releaseTagName(member.packageName, member.version);
    const existingTag = authority.tags[tag];
    const existingRelease = authority.releases[tag];
    return (
      existingTag?.commitSha === authority.releasedSha &&
      existingRelease?.targetSha === authority.releasedSha
    );
  });
}

function isCompleteWithIncident(authority: ReleaseAuthority): boolean {
  const incident = authority.incident;
  if (incident === null) return false;
  if (!incident.deprecationsMatch) return false;
  if (!incident.checkRunAtReleasedSha) return false;
  if (!incident.releasesCarryNotice) return false;
  if (authority.cleanupRequired && !authority.cleanupMerged) return false;
  if (!refsComplete(authority)) return false;
  if (unreproducibleMembers(authority.members).length === 0) return false;
  const affected = new Map(
    incident.affected.map((entry) => [
      `${entry.packageName}@${entry.version}`,
      entry,
    ]),
  );
  for (const [key, entry] of affected) {
    const member = authority.members.find(
      (item) => `${item.packageName}@${item.version}` === key,
    );
    if (member === undefined || !member.published) return false;
    if (member.registryDigest !== entry.digest) return false;
    if (member.deprecated !== incident.requiredMessage) return false;
  }
  return true;
}

export function isMarkerCleanupPending(authority: ReleaseAuthority): boolean {
  return authority.markerPresent && authority.associatedPullRequestSettled;
}

export function discoveryCaseFor(
  state: PostMergeReleaseState,
  authority: ReleaseAuthority,
): MergedDiscoveryCase | null {
  if (isTerminalPrimaryState(state.primary) && !state.markerCleanupPending)
    return null;
  if (state.primary === "IntegrityIncident") return "integrity-incident";
  if (state.markerCleanupPending && isTerminalPrimaryState(state.primary))
    return "marker-cleanup-pending";
  if (state.primary === "PendingChangesetCleanup")
    return "changeset-cleanup-incomplete";
  if (state.primary === "PendingTagsOrReleases")
    return "tags-or-releases-incomplete";
  if (state.primary === "PendingRegistryVerification")
    return "registry-verification-incomplete";
  const published = authority.members.filter((member) => member.published);
  if (published.length === 0) return "no-packages-published";
  if (published.length < authority.members.length) return "partial-npm";
  if (state.markerCleanupPending) return "marker-cleanup-pending";
  return "no-packages-published";
}

export function isDiscoverable(state: PostMergeReleaseState): boolean {
  return !isTerminalPrimaryState(state.primary) || state.markerCleanupPending;
}

export interface ReleaseStatePorts {
  listMergedStableReleasePullRequests(): ResultAsync<
    readonly MergedReleasePullRequestAuthority[],
    GitHubError
  >;
  readMarkerRef(): ResultAsync<{ sha: string } | null, GitHubError>;
  readOpenStableReleasePullRequest(): ResultAsync<
    { number: number; url: string } | null,
    GitHubError
  >;
  readCreationCleanupIdentity(): ResultAsync<
    ReleasePrOwnership | null,
    GitHubError
  >;
  readAuthority(
    pullRequest: MergedReleasePullRequestAuthority,
  ): ResultAsync<ReleaseAuthority, ReleaseStateError>;
  recomputePlan(input: {
    stored: unknown;
    releasedSha: string;
    pullRequestNumber: number;
  }): ResultAsync<ReleasePlan, ReleasePlanError>;
}

export function discoverIncompleteReleases(
  ports: ReleaseStatePorts,
): ResultAsync<readonly DiscoveredRelease[], ReleaseStateError> {
  return ports
    .listMergedStableReleasePullRequests()
    .mapErr((error): ReleaseStateError => error)
    .andThen((merged) =>
      ports
        .readOpenStableReleasePullRequest()
        .andThen((open) =>
          ports
            .readMarkerRef()
            .andThen((marker) =>
              ports
                .readCreationCleanupIdentity()
                .andThen((ownership) =>
                  discoverFrom(ports, merged, open, marker, ownership),
                ),
            ),
        ),
    );
}

function discoverFrom(
  ports: ReleaseStatePorts,
  merged: readonly MergedReleasePullRequestAuthority[],
  open: { number: number; url: string } | null,
  marker: { sha: string } | null,
  ownership: ReleasePrOwnership | null,
): ResultAsync<readonly DiscoveredRelease[], ReleaseStateError> {
  const newest = newestMerged(merged);
  if (newest === undefined) {
    if (marker !== null && open === null && ownership !== null)
      return okAsync([
        { kind: "creation-cleanup-pending" as const, ownership },
      ]);
    return okAsync([]);
  }
  return ports.readAuthority(newest).andThen((authority) => {
    const classified = classifyPostMergeState(authority);
    if (classified.isErr()) return errAsync(classified.error);
    const state = classified.value;
    if (!isDiscoverable(state)) return okAsync([]);
    const discoveredCase = discoveryCaseFor(state, authority);
    if (discoveredCase === null) return okAsync([]);
    return okAsync([
      {
        kind: "merged-release" as const,
        case: discoveredCase,
        state,
      },
    ]);
  });
}

function newestMerged(
  merged: readonly MergedReleasePullRequestAuthority[],
): MergedReleasePullRequestAuthority | undefined {
  return [...merged].sort((left, right) => right.number - left.number)[0];
}

export function createReleaseCompletionPort(
  ports: ReleaseStatePorts,
): ReleaseCompletionPort {
  return {
    readMergedReleaseCompletion(): ResultAsync<
      MergedReleaseObservation | null,
      GitHubError
    > {
      return discoverIncompleteReleases(ports)
        .mapErr(
          (error): GitHubError =>
            error.type === "GitHubError"
              ? error
              : {
                  type: "GitHubError",
                  operation: "readMergedReleaseCompletion",
                  message: error.type,
                },
        )
        .andThen((discovered) => {
          const merged = discovered.find(
            (item) => item.kind === "merged-release",
          );
          if (merged === undefined || merged.kind !== "merged-release") {
            return ports
              .listMergedStableReleasePullRequests()
              .andThen((all) => {
                const newest = newestMerged(all);
                if (newest === undefined) return okAsync(null);
                return ports
                  .readAuthority(newest)
                  .mapErr(
                    (error): GitHubError =>
                      error.type === "GitHubError"
                        ? error
                        : {
                            type: "GitHubError",
                            operation: "readMergedReleaseCompletion",
                            message: error.type,
                          },
                  )
                  .andThen((authority) => {
                    const classified = classifyPostMergeState(authority);
                    if (classified.isErr())
                      return errAsync({
                        type: "GitHubError" as const,
                        operation: "readMergedReleaseCompletion",
                        message: classified.error.type,
                      });
                    return okAsync(toObservation(classified.value));
                  });
              });
          }
          return okAsync(toObservation(merged.state));
        });
    },
  };
}

function toObservation(state: PostMergeReleaseState): MergedReleaseObservation {
  return {
    url: state.pullRequestUrl,
    state: state.primary,
    markerCleanupPending: state.markerCleanupPending,
  };
}

export function memberTagName(
  packageName: PublicPackageName,
  version: string,
): string {
  return releaseTagName(packageName, version);
}

export const MARKER_REF = RELEASE_PR_MARKER_REF;
