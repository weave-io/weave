/**
 * The single stable release PR, as an explicit optimistic state machine.
 *
 * Exactly one stable release PR may exist, and GitHub workflow `concurrency`
 * cannot enforce that: a concurrency group holds at most one pending run and
 * silently replaces older ones, so requests would be dropped rather than
 * answered. Correctness here comes from Git ref atomicity instead, and from
 * one fixed marker ref, {@link RELEASE_PR_MARKER_REF}:
 *
 * - **Creation is an atomic race with exactly one winner.** Each attempt first
 *   writes its own *ownership marker commit* — a commit whose message carries a
 *   validated envelope with a cryptographically random `ownerGeneration` and
 *   the `plannedBaseSha` — and then atomically creates the marker ref at that
 *   unique object. Every loser observes `ReferenceAlreadyExists`, polls for the
 *   winner's PR, and returns typed `ReleasePrExists { url }` without mutating
 *   anything.
 * - **Ownership is ABA-safe.** The ref never points at the shared
 *   `plannedBaseSha`, so a delete-and-recreate at the same base still yields a
 *   different marker object and a different generation. A delayed cleanup from
 *   an older creator therefore fails a generation check instead of deleting a
 *   successor's marker.
 * - **Every update is compare-and-swap.** Regeneration leases against the
 *   exact expected head — the expected-old-SHA comparison happens on the
 *   server, inside the operation that moves the ref — rechecks the live green
 *   trunk immediately before the swap, and refuses to replace a head whose
 *   embedded `baseSha` is newer than its own. An older regeneration can never
 *   overwrite a newer one.
 * - **Every post-ownership failure is transactional.**
 *   {@link StableReleasePrManager.abortOwnedCreation} is the single cleanup
 *   path between winning the marker and an authoritatively visible PR. It
 *   proves ownership, authoritatively queries for the PR, and then either
 *   keeps the marker and reports the URL, CAS-deletes its own marker, or
 *   returns typed `CreationCleanupPending` carrying the full ownership
 *   identity. It never claims a cleanup it cannot prove, so no interleaving
 *   silently leaves a `(marker, no PR)` orphan.
 *
 * The marker ref is a lock for the active PR only. It is deleted at merge and
 * at close alike, its deletion is independent of tags, releases, and
 * publication, and it is never publication authority.
 *
 * Two boundaries keep this module's dependencies honest: the merged-release
 * completion state (Task 14) arrives through {@link ReleaseCompletionPort} as
 * a validated state string rather than an import, and every GitHub effect is
 * an injected port, so the whole state machine is testable without a live
 * GitHub.
 */
import { err, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { AiAuditMetadata } from "./ai/audit-metadata.js";
import type { ChangelogEntry, ChangelogEvidence } from "./changelog-format.js";
import type { ChangesetIdentity } from "./changeset-policy.js";
import {
  NPM_DIGEST_PREFIX,
  PUBLIC_PACKAGES,
  RELEASE_CONTROL_REF,
  RELEASE_PR_MARKER_REF,
  RELEASE_REPOSITORY,
} from "./constants.js";

export { RELEASE_PR_MARKER_REF };

import type { GitHubError } from "./errors.js";
import type {
  GitHubCommitFile,
  GitHubMainBranchClient,
  GitHubMarkerRefClient,
  GitHubPullRequestClient,
  GitHubPullRequestSummary,
  GitHubRefWriteError,
  GitHubTeamClient,
} from "./github-client.js";

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** The label that makes a pull request the stable release PR. */
export const RELEASE_PR_LABEL = "release:stable" as const;

/** The label of the follow-up PR that deletes ledger-consumed changesets. */
export const RELEASE_CLEANUP_PR_LABEL = "release:cleanup" as const;

/** Opening word of the hidden release-PR ownership envelope. */
export const RELEASE_PR_ENVELOPE_MARKER = "weave-release-pr" as const;

/** Schema version of the envelope contract this module reads and writes. */
export const RELEASE_PR_ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Subject line of every ownership marker commit. */
export const OWNERSHIP_MARKER_SUBJECT =
  "chore(release): claim stable release-pr marker" as const;

/** The team whose membership authorizes a maintainer stable request. */
export const RELEASE_MAINTAINER_TEAM = "release-maintainers" as const;

/** The organization that owns the release-maintainer team. */
export const RELEASE_MAINTAINER_ORGANIZATION =
  RELEASE_REPOSITORY.split("/")[0] ?? "weave-io";

/** The branch a release PR always targets. */
export const MAIN_BRANCH = RELEASE_CONTROL_REF.slice("refs/heads/".length);

/** Every bound, so no poll, retry, or envelope is unbounded. */
export const RELEASE_PR_BOUNDS = {
  /** Attempts a losing creator polls for the winner's PR. */
  creationPollAttempts: 8,
  /** Attempts the transactional cleanup spends proving PR existence. */
  reconciliationAttempts: 4,
  /** Replan iterations a creator may spend chasing a moving trunk. */
  freshnessAttempts: 3,
  /** Compare-and-swap attempts one regeneration event may spend. */
  regenerationAttempts: 4,
  /** Attempts one event may spend repairing stale PR title, body, or labels. */
  metadataRepairAttempts: 3,
  pollDelayMs: 2_000,
  envelopeBytes: 128 * 1024,
  auditTrail: 128,
  entryProse: 512,
  entryKeyLength: 8_192,
  proseLength: 4_000,
  actorLength: 64,
  pathLength: 256,
  diffFiles: 64,
} as const;

/**
 * The post-merge states Task 14 recomputes, as a string contract.
 *
 * This module never imports Task 14. The completion port reports a state name,
 * {@link classifyReleaseCompletionState} validates it against this list, and an
 * unknown name fails closed — a state this module cannot classify must never
 * be silently treated as terminal.
 */
export const RELEASE_COMPLETION_STATES = [
  "PendingArtifactsOrProof",
  "PendingNpm",
  "PendingRegistryVerification",
  "PendingTagsOrReleases",
  "PendingChangesetCleanup",
  "IntegrityIncident",
  "Complete",
  "CompleteWithIncident",
] as const;

export type ReleaseCompletionState = (typeof RELEASE_COMPLETION_STATES)[number];

/** The only two states that let a new stable preparation start. */
export const TERMINAL_RELEASE_COMPLETION_STATES = [
  "Complete",
  "CompleteWithIncident",
] as const satisfies readonly ReleaseCompletionState[];

/** The full git ref path of the marker; the identity keeps the short name. */
export function markerRefPath(): string {
  return `refs/heads/${RELEASE_PR_MARKER_REF}`;
}

export const FULL_SHA = /^[0-9a-f]{40}$/;
export const OWNER_GENERATION = /^[0-9a-f]{64}$/;
const DIGEST = new RegExp(`^${NPM_DIGEST_PREFIX}[0-9a-f]{64}$`);
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\[bot\])?$/;
const CHANGESET_FILE = /^\.changeset\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const ENVELOPE_HEADER = new RegExp(`^${RELEASE_PR_ENVELOPE_MARKER}:(\\d+)$`);

// ---------------------------------------------------------------------------
// Ownership identity and the hidden release-PR envelope
// ---------------------------------------------------------------------------

/**
 * One creation attempt's claim on the marker ref.
 *
 * All four fields travel together through creation, every compare-and-swap,
 * cleanup, doctor reporting, and resume: the ref alone identifies a lock, but
 * only the generation identifies *whose* lock it is.
 */
export interface ReleasePrOwnership {
  ref: string;
  ownerGeneration: string;
  expectedMarkerSha: string;
  plannedBaseSha: string;
}

const RecordedProseSchema = z
  .object({
    key: z.string().min(1).max(RELEASE_PR_BOUNDS.entryKeyLength),
    digest: z.string().regex(DIGEST),
  })
  .strict();

/**
 * The validated payload carried by the marker commit, every release commit,
 * and the release PR body.
 *
 * `plannedBaseSha` is fixed at creation and is part of the ownership identity;
 * `baseSha` moves with each regeneration and is what the monotonic freshness
 * guard compares. `entryProse` records the digest of the *generated* prose of
 * every entry, which is the only way a later regeneration can tell a human
 * edit from its own previous output, and `evidenceDigest` records the evidence
 * that prose was generated from, which is the only way a later regeneration can
 * tell that the same entry now describes different refs.
 */
export const ReleasePrEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_PR_ENVELOPE_SCHEMA_VERSION),
    ref: z.literal(RELEASE_PR_MARKER_REF),
    ownerGeneration: z.string().regex(OWNER_GENERATION),
    plannedBaseSha: z.string().regex(FULL_SHA),
    baseSha: z.string().regex(FULL_SHA),
    regeneratedFrom: z
      .array(z.string().regex(FULL_SHA))
      .max(RELEASE_PR_BOUNDS.auditTrail),
    entryProse: z.array(RecordedProseSchema).max(RELEASE_PR_BOUNDS.entryProse),
    /** Canonical digest of the evidence set `entryProse` was generated from. */
    evidenceDigest: z.string().regex(DIGEST),
  })
  .strict()
  .superRefine((envelope, context) => {
    const keys = envelope.entryProse.map((record) => record.key);
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["entryProse"],
        message: "every entry key must appear once",
      });
  });

export type ReleasePrEnvelope = z.infer<typeof ReleasePrEnvelopeSchema>;

/** One entry's generated prose digest, keyed by its changeset identity set. */
export type RecordedProse = z.infer<typeof RecordedProseSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Where a creation run failed, so cleanup and reporting stay attributable. */
export const CREATION_STAGES = [
  "plan-rebinding",
  "docs-gate",
  "changelog-ai",
  "prepared-commit",
  "branch-push",
  "pull-request-create",
  "post-create-verification",
] as const;

export type CreationStage = (typeof CREATION_STAGES)[number];

/** Why a cleanup could not prove it finished. */
export type CleanupPendingReason =
  | "ownership-changed"
  | "unverifiable-ownership"
  | "unverifiable-pull-request"
  | "cas-delete-failed";

/** What the live PR is still missing relative to the authoritative marker head. */
export type PrMetadataGap = "label" | "envelope";

export interface EditConflictEntry {
  key: string;
  changesetId: string;
  human: string;
  generated: string;
}

export type ReleasePrError =
  /** Discovery. */
  | { type: "ReleasePrProtocolAnomaly"; ref: string; url: string }
  | { type: "DuplicateReleasePr"; urls: readonly string[] }
  | { type: "PendingReleaseBlocksPrep"; url: string; state: string }
  | { type: "UnknownReleaseCompletionState"; state: string }
  /** Creation. */
  | { type: "ReleasePrExists"; url: string }
  | { type: "ReleasePrCreationStalled"; ref: string; attempts: number }
  /**
   * The trunk moved, so this content may not be published.
   *
   * It carries the run's ownership as it stands *now*: a stale trunk observed
   * after the branch compare-and-swap leaves the marker at the new release
   * commit, and the replan must keep leasing against that head rather than the
   * superseded marker SHA.
   */
  | {
      type: "PreparationStale";
      newHead: string;
      baseSha: string;
      ownership: ReleasePrOwnership;
    }
  | {
      type: "PreparationFreshnessExhausted";
      attempts: number;
      retryable: true;
      cleanup: "marker-deleted" | "marker-absent";
    }
  | {
      type: "ReleasePreparationFailed";
      stage: CreationStage;
      message: string;
      retryable: boolean;
    }
  | {
      type: "CreationCleanupPending";
      ref: string;
      ownerGeneration: string;
      expectedMarkerSha: string;
      plannedBaseSha: string;
      reason: CleanupPendingReason;
    }
  | { type: "DocsAuditNotBoundToBase"; auditedSha: string; baseSha: string }
  | {
      type: "UnexpectedReleasePrHead";
      url: string;
      expected: string;
      actual: string;
    }
  /** The PR is authoritatively visible; only its verification is unproven. */
  | { type: "ReleasePrVerificationPending"; url: string; message: string }
  /**
   * The marker head is authority, but the PR's labels or hidden envelope do
   * not yet reflect it. Discovery types this; regenerate repairs it.
   */
  | {
      type: "ReleasePrMetadataPending";
      url: string;
      pending: readonly PrMetadataGap[];
      message: string;
    }
  /** Regeneration. */
  | { type: "EditConflict"; entries: readonly EditConflictEntry[] }
  | { type: "RegenerationRetriesExhausted"; attempts: number }
  /** Marker lifecycle. */
  | {
      type: "MarkerCleanupPending";
      ref: string;
      markerSha: string;
      reason: "delete-failed" | "lease-lost";
    }
  | {
      type: "MarkerDeletionNotAuthorized";
      ref: string;
      reason:
        | "no-settled-pull-request"
        | "pull-request-open"
        | "marker-head-mismatch"
        | "missing-stable-label"
        | "unexpected-base"
        | "ownership-mismatch";
    }
  /** Authorization. */
  | {
      type: "UnauthorizedStableRequest";
      actor: string;
      team: string;
      reason: "invalid-actor" | "not-a-member" | "membership-unverifiable";
    }
  /** Diff surfaces. */
  | { type: "EmptyReleaseDiff"; surface: "release" | "cleanup" }
  | { type: "ForbiddenReleasePrPath"; path: string }
  | { type: "ChangesetTouchedInReleasePr"; path: string }
  | { type: "ForbiddenManifestField"; path: string; field: string }
  | { type: "UndeclaredManifestFields"; path: string }
  | {
      type: "ForbiddenReleaseChangeStatus";
      surface: "release" | "cleanup";
      path: string;
      status: ReleaseChangeStatus;
    }
  | { type: "ForbiddenCleanupPrPath"; path: string }
  | { type: "UnconsumedChangesetDeletion"; path: string }
  | { type: "UndeclaredCommitFile"; path: string }
  /** Envelope. */
  | { type: "MissingReleasePrEnvelope" }
  | { type: "MultipleReleasePrEnvelopes"; count: number }
  | { type: "UnsupportedReleasePrEnvelope"; schemaVersion: number }
  | { type: "InvalidReleasePrEnvelope"; issues: readonly string[] }
  | { type: "ReleasePrEnvelopeTooLarge"; bytes: number; limit: number }
  /** Ports. */
  | { type: "ReleasePrPortFailed"; port: string; message: string };

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type ReleasePrRefPort = GitHubMarkerRefClient;
export type ReleasePrPullRequestPort = GitHubPullRequestClient;
export type ReleasePrMainPort = GitHubMainBranchClient;
export type ReleasePrTeamPort = GitHubTeamClient;

/** What the completion port reports about the newest merged release PR. */
export interface MergedReleaseObservation {
  url: string;
  /** A {@link RELEASE_COMPLETION_STATES} name; validated, never trusted. */
  state: string;
  /** Set when the route job's marker deletion failed. */
  markerCleanupPending: boolean;
}

/**
 * Task 14's recomputed post-merge state, as an injected port.
 *
 * Keeping this a port rather than an import is what lets the release-PR state
 * machine depend only on lower-numbered work while still blocking preparation
 * on an incomplete merged release.
 */
export interface ReleaseCompletionPort {
  readMergedReleaseCompletion(): ResultAsync<
    MergedReleaseObservation | null,
    GitHubError
  >;
}

export interface ReleasePrPorts {
  refs: ReleasePrRefPort;
  pullRequests: ReleasePrPullRequestPort;
  main: ReleasePrMainPort;
  completion: ReleaseCompletionPort;
  team: ReleasePrTeamPort;
}

/** The bounds a caller may narrow; every one of them is a plain number. */
export type ReleasePrBounds = {
  -readonly [Key in keyof typeof RELEASE_PR_BOUNDS]: number;
};

export interface ReleasePrManagerOptions {
  bounds?: Partial<ReleasePrBounds>;
  /** Injected so tests are deterministic; production uses `crypto`. */
  generateOwnerGeneration?: () => string;
  /** Injected so bounded polls cost no wall-clock time in tests. */
  sleep?: (milliseconds: number) => Promise<void>;
  maintainerTeam?: { organization: string; teamSlug: string };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface MarkerObservation {
  ref: string;
  sha: string;
}

/**
 * Everything the marker ref plus the open release PRs plus the completion port
 * can say about the release-PR lifecycle.
 *
 * Discovery is advisory: no mutation ever trusts one of these reads. Creation
 * relies on atomic `createRef`, and every update relies on compare-and-swap.
 */
export type ReleasePrState =
  | { kind: "absent"; mergedRelease: MergedReleaseObservation | null }
  | {
      kind: "creation-in-progress";
      marker: MarkerObservation;
      mergedRelease: MergedReleaseObservation | null;
    }
  | {
      kind: "live";
      marker: MarkerObservation;
      pullRequest: GitHubPullRequestSummary;
      mergedRelease: MergedReleaseObservation | null;
    }
  | {
      kind: "pr-metadata-pending";
      marker: MarkerObservation;
      pullRequest: GitHubPullRequestSummary;
      pending: readonly PrMetadataGap[];
      mergedRelease: MergedReleaseObservation | null;
    }
  | {
      kind: "orphan-marker";
      marker: MarkerObservation;
      mergedRelease: MergedReleaseObservation | null;
    }
  | {
      kind: "creation-cleanup-pending";
      marker: MarkerObservation;
      recordedCleanup: ReleasePrOwnership;
      generationMatches: boolean;
      mergedRelease: MergedReleaseObservation | null;
    }
  | {
      kind: "marker-cleanup-pending";
      marker: MarkerObservation;
      pullRequest: GitHubPullRequestSummary;
      mergedRelease: MergedReleaseObservation | null;
    }
  | {
      kind: "pending-merged-release";
      mergedRelease: MergedReleaseObservation;
    };

export interface DiscoveryRequest {
  /**
   * A creation-phase cleanup identity doctor or resume already holds. Its
   * generation is compared against the live marker, so a stale record against
   * a successor's marker is reported as a mismatch rather than acted on.
   */
  recordedCleanup?: ReleasePrOwnership;
  /**
   * Set by callers that already spent the creation poll bound, which is what
   * turns "creation in progress" into "orphan/stalled".
   */
  creationPollExhausted?: boolean;
}

/** Validates a completion state name and says whether it blocks preparation. */
export function classifyReleaseCompletionState(
  state: string,
): Result<"terminal" | "blocking", ReleasePrError> {
  const known = RELEASE_COMPLETION_STATES.find((name) => name === state);
  if (known === undefined)
    return err({ type: "UnknownReleaseCompletionState", state });
  const terminal = TERMINAL_RELEASE_COMPLETION_STATES.some(
    (name) => name === known,
  );
  return ok(terminal ? "terminal" : "blocking");
}

// ---------------------------------------------------------------------------
// Diff surfaces
// ---------------------------------------------------------------------------

export type ReleaseChangeStatus = "added" | "modified" | "removed";

/** One file a pull request's diff touches. */
export interface ReleaseChange {
  path: string;
  status: ReleaseChangeStatus;
  /** Required for a package manifest: which top-level fields moved. */
  manifestFields?: readonly string[];
}

const RELEASE_MANIFEST_PATHS = Object.values(PUBLIC_PACKAGES).map(
  (entry) => `${entry.directory}/package.json`,
);
const RELEASE_CHANGELOG_PATHS = Object.values(PUBLIC_PACKAGES).map(
  (entry) => `${entry.directory}/CHANGELOG.md`,
);

/**
 * The exact release-PR surface: public package versions and public changelogs.
 *
 * Nothing else may ride along — least of all a `.changeset/` deletion, which
 * gets its own error because consumption is a ledger transition, not a file
 * operation inside the release PR.
 */
export function validateReleasePrDiff(
  changes: readonly ReleaseChange[],
): Result<void, ReleasePrError> {
  if (changes.length === 0)
    return err({ type: "EmptyReleaseDiff", surface: "release" });
  for (const change of changes) {
    if (change.path.startsWith(".changeset/"))
      return err({ type: "ChangesetTouchedInReleasePr", path: change.path });
    if (RELEASE_MANIFEST_PATHS.includes(change.path)) {
      const manifest = validateManifestChange(change);
      if (manifest.isErr()) return manifest;
      continue;
    }
    if (RELEASE_CHANGELOG_PATHS.includes(change.path)) {
      if (change.status === "removed")
        return err({
          type: "ForbiddenReleaseChangeStatus",
          surface: "release",
          path: change.path,
          status: change.status,
        });
      continue;
    }
    return err({ type: "ForbiddenReleasePrPath", path: change.path });
  }
  return ok(undefined);
}

function validateManifestChange(
  change: ReleaseChange,
): Result<void, ReleasePrError> {
  if (change.status !== "modified")
    return err({
      type: "ForbiddenReleaseChangeStatus",
      surface: "release",
      path: change.path,
      status: change.status,
    });
  if (change.manifestFields === undefined || change.manifestFields.length === 0)
    return err({ type: "UndeclaredManifestFields", path: change.path });
  for (const field of change.manifestFields)
    if (field !== "version")
      return err({ type: "ForbiddenManifestField", path: change.path, field });
  return ok(undefined);
}

/**
 * The changeset-cleanup surface: deletions of ledger-consumed files, nothing
 * else. A deletion of a file the ledger never consumed would erase a pending
 * changeset, so it is rejected by identity rather than by shape alone.
 */
export function validateCleanupPrDiff(input: {
  changes: readonly ReleaseChange[];
  consumedPaths: readonly string[];
}): Result<void, ReleasePrError> {
  if (input.changes.length === 0)
    return err({ type: "EmptyReleaseDiff", surface: "cleanup" });
  const consumed = new Set(input.consumedPaths);
  for (const change of input.changes) {
    if (!CHANGESET_FILE.test(change.path))
      return err({ type: "ForbiddenCleanupPrPath", path: change.path });
    if (change.status !== "removed")
      return err({
        type: "ForbiddenReleaseChangeStatus",
        surface: "cleanup",
        path: change.path,
        status: change.status,
      });
    if (!consumed.has(change.path))
      return err({ type: "UnconsumedChangesetDeletion", path: change.path });
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Prepared release content
// ---------------------------------------------------------------------------

/** Deterministic content one preparation or regeneration produced. */
export interface PreparedRelease {
  /** The green trunk head this content was built at. */
  baseSha: string;
  title: string;
  body: string;
  commitSubject: string;
  files: readonly GitHubCommitFile[];
  changes: readonly ReleaseChange[];
  /** The docs-release-audit outcome's audited SHA (Task 19). */
  docsAuditedSha: string;
  /** The changelog entries this content renders. */
  entries: readonly ChangelogEntry[];
  /** The refs the prose was allowed to cite. */
  evidence: ChangelogEvidence;
  /** Task 18 changelog-AI provenance, when this content was AI-authored. */
  aiAudit?: AiAuditMetadata;
}

export interface PreparationFailure {
  stage: CreationStage;
  message: string;
  retryable?: boolean;
}

/**
 * The caller's deterministic plan + docs gate + AI pipeline, as a port.
 *
 * The manager never decides what a release says; it decides when that content
 * may be pushed and whose lock it is pushed under. `previous` is supplied so a
 * replan can reuse prose under {@link planProseReuse}'s rule.
 */
export interface CreationPreparer {
  prepare(input: {
    baseSha: string;
    previous: PreparedRelease | null;
  }): ResultAsync<PreparedRelease, PreparationFailure>;
}

export interface RegenerationDraft {
  /** Freshly generated entries for the new head. */
  generated: readonly ChangelogEntry[];
  /** The entries as they currently stand on the PR, human edits included. */
  current: readonly ChangelogEntry[];
  /** The refs the fresh prose was allowed to cite. */
  evidence: ChangelogEvidence;
  docsAuditedSha: string;
}

export interface RegenerationBuilder {
  build(input: {
    baseSha: string;
    expectedHead: string;
  }): ResultAsync<RegenerationDraft, PreparationFailure>;
  render(input: {
    baseSha: string;
    entries: readonly ChangelogEntry[];
  }): ResultAsync<PreparedRelease, PreparationFailure>;
}

// ---------------------------------------------------------------------------
// Entry identity, prose reuse, and edit preservation
// ---------------------------------------------------------------------------

/** The identity of one entry: its full `{ id, sourceDigest }` set, canonical. */
export function entryIdentityKey(
  sources: readonly ChangesetIdentity[],
): string {
  return [...sources]
    .map((source) => `${source.id}@${source.sourceDigest}`)
    .sort(compareText)
    .join("|");
}

/** Canonical digest of an evidence set, so "unchanged evidence" is decidable. */
export function evidenceDigest(evidence: ChangelogEvidence): string {
  return digestOf(
    JSON.stringify({
      pullRequests: [...(evidence.pullRequests ?? [])].sort(
        (left, right) => left - right,
      ),
      commits: [...(evidence.commits ?? [])].sort(compareText),
    }),
  );
}

export interface ProseReusePlan {
  reused: readonly { index: number; entry: ChangelogEntry }[];
  regenerate: readonly {
    index: number;
    sources: readonly ChangesetIdentity[];
  }[];
}

/**
 * Decides which prose a replan may keep.
 *
 * Reuse is allowed only when an entry's **full** changeset identity set and
 * the evidence set are both unchanged. An unseen or re-digested changeset
 * forces fresh generation, which is what stops stale AI prose from being
 * rebased onto code it never saw.
 */
export function planProseReuse(input: {
  previous: readonly ChangelogEntry[];
  previousEvidence: ChangelogEvidence;
  candidates: readonly (readonly ChangesetIdentity[])[];
  evidence: ChangelogEvidence;
}): ProseReusePlan {
  const sameEvidence =
    evidenceDigest(input.previousEvidence) === evidenceDigest(input.evidence);
  const previous = new Map(
    input.previous.map((entry) => [
      entryIdentityKey(entry.sourceChangesets),
      entry,
    ]),
  );
  const reused: { index: number; entry: ChangelogEntry }[] = [];
  const regenerate: {
    index: number;
    sources: readonly ChangesetIdentity[];
  }[] = [];
  for (const [index, sources] of input.candidates.entries()) {
    const match = previous.get(entryIdentityKey(sources));
    if (sameEvidence && match !== undefined)
      reused.push({ index, entry: match });
    else regenerate.push({ index, sources });
  }
  return { reused, regenerate };
}

export interface ResolvedRegeneration {
  entries: readonly ChangelogEntry[];
  /** Identity keys whose human prose survived this regeneration. */
  preserved: readonly string[];
  /** The generated-prose digests the next regeneration compares against. */
  entryProse: readonly RecordedProse[];
  /** The evidence digest the next regeneration compares against. */
  evidenceDigest: string;
}

/**
 * Merges freshly generated entries with what a human may have written.
 *
 * Prose may be preserved only when **both** halves of what produced it are
 * unchanged: the entry's full `{ id, sourceDigest }` set *and* the evidence the
 * prose was allowed to cite. Either one moving means the current words describe
 * something the release no longer says.
 *
 * - Identity and evidence unchanged: the current prose wins, so human edits
 *   survive every regeneration.
 * - Either moved while the prose is human-edited: an {@link EditConflict}
 *   carrying both renderings. Silently overwriting a human's words is not
 *   recoverable; blocking is.
 * - Either moved while the prose is still this module's own recorded output:
 *   regenerate, because nothing a human wrote is at risk.
 *
 * A current entry with no recorded generated digest is treated as human-written
 * for the same reason.
 */
export function resolveRegeneratedEntries(input: {
  generated: readonly ChangelogEntry[];
  current: readonly ChangelogEntry[];
  recorded: readonly RecordedProse[];
  /** The evidence digest recorded alongside `recorded`; null when unknown. */
  recordedEvidenceDigest: string | null;
  /** The evidence the freshly generated entries were allowed to cite. */
  evidence: ChangelogEvidence;
}): Result<ResolvedRegeneration, ReleasePrError> {
  const nextEvidenceDigest = evidenceDigest(input.evidence);
  const evidenceUnchanged = input.recordedEvidenceDigest === nextEvidenceDigest;
  const recorded = new Map(
    input.recorded.map((record) => [record.key, record.digest]),
  );
  const currentByKey = new Map(
    input.current.map((entry) => [
      entryIdentityKey(entry.sourceChangesets),
      entry,
    ]),
  );
  const entries: ChangelogEntry[] = [];
  const preserved: string[] = [];
  const conflicts: EditConflictEntry[] = [];
  for (const generated of input.generated) {
    const key = entryIdentityKey(generated.sourceChangesets);
    const unchanged = currentByKey.get(key);
    if (unchanged !== undefined) {
      if (evidenceUnchanged) {
        entries.push(unchanged);
        if (unchanged.prose !== generated.prose) preserved.push(key);
        continue;
      }
      const conflict = evidenceConflict(unchanged, generated, recorded);
      if (conflict !== null) conflicts.push(conflict);
      else entries.push(generated);
      continue;
    }
    const conflict = findEditConflict(generated, input.current, recorded);
    if (conflict !== null) {
      conflicts.push(conflict);
      continue;
    }
    entries.push(generated);
  }
  if (conflicts.length > 0)
    return err({ type: "EditConflict", entries: conflicts });
  return ok({
    entries,
    preserved,
    entryProse: input.generated.map((entry) => ({
      key: entryIdentityKey(entry.sourceChangesets),
      digest: digestOf(entry.prose),
    })),
    evidenceDigest: nextEvidenceDigest,
  });
}

/** The evidence moved under an entry whose identity set did not. */
function evidenceConflict(
  current: ChangelogEntry,
  generated: ChangelogEntry,
  recorded: ReadonlyMap<string, string>,
): EditConflictEntry | null {
  if (current.prose === generated.prose) return null;
  if (!isHumanEdited(current, recorded)) return null;
  return {
    key: entryIdentityKey(current.sourceChangesets),
    changesetId: leadChangesetId(current),
    human: current.prose,
    generated: generated.prose,
  };
}

function findEditConflict(
  generated: ChangelogEntry,
  current: readonly ChangelogEntry[],
  recorded: ReadonlyMap<string, string>,
): EditConflictEntry | null {
  const generatedIds = new Map(
    generated.sourceChangesets.map((source) => [
      source.id,
      source.sourceDigest,
    ]),
  );
  for (const entry of current) {
    const shared = entry.sourceChangesets.find(
      (source) =>
        generatedIds.has(source.id) &&
        generatedIds.get(source.id) !== source.sourceDigest,
    );
    if (shared === undefined) continue;
    if (!isHumanEdited(entry, recorded)) continue;
    return {
      key: entryIdentityKey(entry.sourceChangesets),
      changesetId: shared.id,
      human: entry.prose,
      generated: generated.prose,
    };
  }
  return null;
}

/** An entry no longer matching its recorded generated digest is a human's. */
function isHumanEdited(
  entry: ChangelogEntry,
  recorded: ReadonlyMap<string, string>,
): boolean {
  const baseline = recorded.get(entryIdentityKey(entry.sourceChangesets));
  return baseline === undefined || baseline !== digestOf(entry.prose);
}

function leadChangesetId(entry: ChangelogEntry): string {
  return (
    entry.sourceChangesets.map((source) => source.id).sort(compareText)[0] ?? ""
  );
}

// ---------------------------------------------------------------------------
// Envelope rendering and parsing
// ---------------------------------------------------------------------------

/** Returns the UTF-8 byte length used by the envelope carrier bound. */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Renders the hidden ownership envelope a commit message or PR body carries. */
export function renderReleasePrEnvelope(
  envelope: ReleasePrEnvelope,
): Result<string, ReleasePrError> {
  const parsed = ReleasePrEnvelopeSchema.safeParse(envelope);
  if (!parsed.success)
    return err({
      type: "InvalidReleasePrEnvelope",
      issues: describeIssues(parsed.error.issues),
    });
  const body = JSON.stringify(sortValue(parsed.data), null, 2);
  const text = `${COMMENT_OPEN} ${RELEASE_PR_ENVELOPE_MARKER}:${RELEASE_PR_ENVELOPE_SCHEMA_VERSION}\n${body}\n${COMMENT_CLOSE}`;
  const bytes = utf8ByteLength(text);
  if (bytes > RELEASE_PR_BOUNDS.envelopeBytes)
    return err({
      type: "ReleasePrEnvelopeTooLarge",
      bytes,
      limit: RELEASE_PR_BOUNDS.envelopeBytes,
    });
  return ok(text);
}

/**
 * Reads the one hidden ownership envelope out of a commit message or PR body.
 *
 * Two envelopes are a typed failure: a body that claims two owners has no
 * single owner, and a cleanup must never guess which one it is.
 */
export function parseReleasePrEnvelope(
  text: string,
): Result<ReleasePrEnvelope, ReleasePrError> {
  const bytes = utf8ByteLength(text);
  if (bytes > RELEASE_PR_BOUNDS.envelopeBytes)
    return err({
      type: "ReleasePrEnvelopeTooLarge",
      bytes,
      limit: RELEASE_PR_BOUNDS.envelopeBytes,
    });
  const blocks = collectEnvelopeBlocks(text);
  if (blocks.length === 0) return err({ type: "MissingReleasePrEnvelope" });
  if (blocks.length > 1)
    return err({ type: "MultipleReleasePrEnvelopes", count: blocks.length });
  return readEnvelopeBlock(blocks[0] ?? "");
}

function collectEnvelopeBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(COMMENT_OPEN, cursor);
    if (open === -1) break;
    const close = text.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    if (close === -1) break;
    const inner = text.slice(open + COMMENT_OPEN.length, close).trim();
    cursor = close + COMMENT_CLOSE.length;
    if (inner.startsWith(RELEASE_PR_ENVELOPE_MARKER)) blocks.push(inner);
  }
  return blocks;
}

function readEnvelopeBlock(
  block: string,
): Result<ReleasePrEnvelope, ReleasePrError> {
  const newline = block.indexOf("\n");
  const header = (newline === -1 ? block : block.slice(0, newline)).trim();
  const match = ENVELOPE_HEADER.exec(header);
  if (match === null)
    return err({
      type: "InvalidReleasePrEnvelope",
      issues: [`expected ${RELEASE_PR_ENVELOPE_MARKER}:<schema version>`],
    });
  const schemaVersion = Number(match[1]);
  if (schemaVersion !== RELEASE_PR_ENVELOPE_SCHEMA_VERSION)
    return err({ type: "UnsupportedReleasePrEnvelope", schemaVersion });
  const parsedJson = parseJson(newline === -1 ? "" : block.slice(newline + 1));
  if (parsedJson.isErr()) return err(parsedJson.error);
  const parsed = ReleasePrEnvelopeSchema.safeParse(parsedJson.value);
  if (!parsed.success)
    return err({
      type: "InvalidReleasePrEnvelope",
      issues: describeIssues(parsed.error.issues),
    });
  return ok(parsed.data);
}

const parseJson = Result.fromThrowable(
  (source: string) => JSON.parse(source) as unknown,
  (cause): ReleasePrError => ({
    type: "InvalidReleasePrEnvelope",
    issues: [cause instanceof Error ? cause.message : String(cause)],
  }),
);

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export interface CreatedReleasePr {
  pullRequest: GitHubPullRequestSummary;
  ownership: ReleasePrOwnership;
  baseSha: string;
}

export type AbortOwnedCreationOutcome =
  | { kind: "marker-deleted"; ownership: ReleasePrOwnership }
  | { kind: "marker-absent"; ownership: ReleasePrOwnership }
  | {
      kind: "pull-request-visible";
      url: string;
      ownership: ReleasePrOwnership;
    };

export type RegenerationOutcome =
  | { kind: "NoReleasePrToRegenerate" }
  | {
      kind: "Regenerated";
      pullRequest: GitHubPullRequestSummary;
      baseSha: string;
      commitSha: string;
      regeneratedFrom: readonly string[];
      preserved: readonly string[];
    }
  | {
      kind: "RegenerationSuperseded";
      survivingBaseSha: string;
      baseSha: string;
    }
  | {
      kind: "PrMetadataReconciled";
      pullRequest: GitHubPullRequestSummary;
      baseSha: string;
      commitSha: string;
      pending: readonly PrMetadataGap[];
    };

export type MarkerDeletionOutcome =
  | { kind: "deleted"; ref: string; markerSha: string }
  | { kind: "already-absent"; ref: string };

// Shared contract helpers used by the lifecycle modules.
export function preparationBlock(state: ReleasePrState): ReleasePrError | null {
  if (state.kind === "live" || state.kind === "pr-metadata-pending")
    return { type: "ReleasePrExists", url: state.pullRequest.url };
  const merged = state.mergedRelease;
  if (merged !== null && isBlocking(merged))
    return {
      type: "PendingReleaseBlocksPrep",
      url: merged.url,
      state: merged.state,
    };
  return null;
}

export function prMetadataGaps(
  pull: GitHubPullRequestSummary,
  envelope: ReleasePrEnvelope,
): readonly PrMetadataGap[] {
  const pending: PrMetadataGap[] = [];
  if (!pull.labels.includes(RELEASE_PR_LABEL)) pending.push("label");
  const parsed = parseReleasePrEnvelope(pull.body);
  if (parsed.isErr() || !releasePrEnvelopesMatch(parsed.value, envelope))
    pending.push("envelope");
  return pending;
}

export function releasePrEnvelopesMatch(
  left: ReleasePrEnvelope,
  right: ReleasePrEnvelope,
): boolean {
  return (
    left.ownerGeneration === right.ownerGeneration &&
    left.plannedBaseSha === right.plannedBaseSha &&
    left.baseSha === right.baseSha &&
    left.evidenceDigest === right.evidenceDigest &&
    left.regeneratedFrom.length === right.regeneratedFrom.length &&
    left.regeneratedFrom.every(
      (sha, index) => sha === right.regeneratedFrom[index],
    ) &&
    left.entryProse.length === right.entryProse.length &&
    left.entryProse.every(
      (record, index) =>
        record.key === right.entryProse[index]?.key &&
        record.digest === right.entryProse[index]?.digest,
    )
  );
}

export function isBlocking(merged: MergedReleaseObservation): boolean {
  return (
    classifyReleaseCompletionState(merged.state).unwrapOr("blocking") ===
    "blocking"
  );
}

export function validatePreparedRelease(
  prepared: PreparedRelease,
): Result<void, ReleasePrError> {
  if (!FULL_SHA.test(prepared.baseSha))
    return err({
      type: "ReleasePreparationFailed",
      stage: "prepared-commit",
      message: `baseSha must be a full SHA, got ${prepared.baseSha}`,
      retryable: false,
    });
  if (prepared.docsAuditedSha !== prepared.baseSha)
    return err({
      type: "DocsAuditNotBoundToBase",
      auditedSha: prepared.docsAuditedSha,
      baseSha: prepared.baseSha,
    });
  const surface = validateReleasePrDiff(prepared.changes);
  if (surface.isErr()) return surface;
  const declared = new Set(prepared.changes.map((change) => change.path));
  for (const file of prepared.files)
    if (!declared.has(file.path))
      return err({ type: "UndeclaredCommitFile", path: file.path });
  return ok(undefined);
}

export function recordEntryProse(
  entries: readonly ChangelogEntry[],
): readonly RecordedProse[] {
  const records = new Map<string, string>();
  for (const entry of entries)
    records.set(
      entryIdentityKey(entry.sourceChangesets),
      digestOf(entry.prose),
    );
  return [...records].map(([key, digest]) => ({ key, digest }));
}

export function cleanupPending(
  ownership: ReleasePrOwnership,
  reason: CleanupPendingReason,
): ReleasePrError {
  return {
    type: "CreationCleanupPending",
    ref: ownership.ref,
    ownerGeneration: ownership.ownerGeneration,
    expectedMarkerSha: ownership.expectedMarkerSha,
    plannedBaseSha: ownership.plannedBaseSha,
    reason,
  };
}

export function portFailure(port: string, failure: unknown): ReleasePrError {
  return {
    type: "ReleasePrPortFailed",
    port,
    message: describeError(failure),
  };
}

export function describeRefWriteError(failure: GitHubRefWriteError): string {
  if (failure.type === "ReferenceAlreadyExists")
    return `reference ${failure.ref} already exists`;
  if (failure.type === "ReferenceLeaseLost")
    return `lease lost on ${failure.ref}: expected ${failure.expectedSha}, found ${failure.actualSha ?? "nothing"}`;
  return failure.message;
}

export function describeError(failure: unknown): string {
  if (typeof failure !== "object" || failure === null) return String(failure);
  const record = failure as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.type === "string") return record.type;
  return JSON.stringify(failure);
}

export function defaultOwnerGeneration(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digestOf(value: string): string {
  return `${NPM_DIGEST_PREFIX}${new Bun.CryptoHasher("sha256")
    .update(value)
    .digest("hex")}`;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareText)
      .map((key) => [key, sortValue(record[key])]),
  );
}

function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): readonly string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  });
}

/** Awaits a `ResultAsync` as a plain `Result`, so steps read top to bottom. */
export function settle<T, E>(
  operation: ResultAsync<T, E>,
): Promise<Result<T, E>> {
  return operation.match<Result<T, E>>(
    (value) => ok(value),
    (error) => err(error),
  );
}

/** Runs an async state-machine step without ever leaving `Result` behind. */
export function fromAsync<T>(
  run: () => Promise<Result<T, ReleasePrError>>,
): ResultAsync<T, ReleasePrError> {
  return ResultAsync.fromSafePromise(run()).andThen((result) => result);
}
