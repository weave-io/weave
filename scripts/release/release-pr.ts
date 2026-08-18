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
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { ChangelogEntry, ChangelogEvidence } from "./changelog-format.js";
import type { ChangesetIdentity } from "./changeset-policy.js";
import {
  NPM_DIGEST_PREFIX,
  PUBLIC_PACKAGES,
  RELEASE_CONTROL_REF,
  RELEASE_PR_MARKER_REF,
  RELEASE_REPOSITORY,
} from "./constants.js";
import type { GitHubError } from "./errors.js";
import type {
  GitHubCommitFile,
  GitHubMainBranchClient,
  GitHubMarkerRefClient,
  GitHubPullRequestClient,
  GitHubPullRequestState,
  GitHubPullRequestSummary,
  GitHubPullRequestWriteError,
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
const MAIN_BRANCH = RELEASE_CONTROL_REF.slice("refs/heads/".length);

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

const FULL_SHA = /^[0-9a-f]{40}$/;
const OWNER_GENERATION = /^[0-9a-f]{64}$/;
const DIGEST = new RegExp(`^${NPM_DIGEST_PREFIX}[0-9a-f]{64}$`);
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\[bot\])?$/;
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

interface PublishedPrAuthority {
  markerSha: string;
  envelope: ReleasePrEnvelope;
}

interface PublishedPrTarget extends PublishedPrAuthority {
  title: string;
  body: string;
}

interface RenderedPrMetadata {
  title: string;
  body: string;
}

interface PublishedPrMetadata extends PublishedPrAuthority {
  pullRequest: GitHubPullRequestSummary;
  superseded: boolean;
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export class StableReleasePrManager {
  private readonly bounds: ReleasePrBounds;
  private readonly refPath = markerRefPath();
  private readonly generateOwnerGeneration: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maintainerTeam: { organization: string; teamSlug: string };

  constructor(
    private readonly ports: ReleasePrPorts,
    options: ReleasePrManagerOptions = {},
  ) {
    this.bounds = { ...RELEASE_PR_BOUNDS, ...options.bounds };
    this.generateOwnerGeneration =
      options.generateOwnerGeneration ?? defaultOwnerGeneration;
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
    this.maintainerTeam = options.maintainerTeam ?? {
      organization: RELEASE_MAINTAINER_ORGANIZATION,
      teamSlug: RELEASE_MAINTAINER_TEAM,
    };
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** Reads the whole lifecycle state without mutating anything. */
  discover(
    request: DiscoveryRequest = {},
  ): ResultAsync<ReleasePrState, ReleasePrError> {
    return fromAsync(() => this.runDiscover(request));
  }

  private async runDiscover(
    request: DiscoveryRequest,
  ): Promise<Result<ReleasePrState, ReleasePrError>> {
    const marker = await this.readMarker();
    if (marker.isErr()) return err(marker.error);
    const open = await this.readOpenReleasePullRequest();
    if (open.isErr()) return err(open.error);
    const merged = await this.readMergedRelease();
    if (merged.isErr()) return err(merged.error);
    const mergedRelease = merged.value;
    const markerSha = marker.value;
    const pullRequest = open.value;

    if (markerSha === null && pullRequest !== null)
      return err({
        type: "ReleasePrProtocolAnomaly",
        ref: RELEASE_PR_MARKER_REF,
        url: pullRequest.url,
      });
    if (markerSha === null) {
      if (mergedRelease !== null && isBlocking(mergedRelease))
        return ok({ kind: "pending-merged-release", mergedRelease });
      return ok({ kind: "absent", mergedRelease });
    }
    const observation: MarkerObservation = {
      ref: RELEASE_PR_MARKER_REF,
      sha: markerSha,
    };
    if (pullRequest !== null) {
      const envelope = await this.readEnvelopeAt(markerSha);
      if (envelope.isErr()) return err(envelope.error);
      const pending = prMetadataGaps(pullRequest, envelope.value);
      if (pending.length > 0)
        return ok({
          kind: "pr-metadata-pending",
          marker: observation,
          pullRequest,
          pending,
          mergedRelease,
        });
      return ok({
        kind: "live",
        marker: observation,
        pullRequest,
        mergedRelease,
      });
    }
    const settled = await this.readSettledReleasePullRequest(markerSha);
    if (settled.isErr()) return err(settled.error);
    // The marker ref outlives individual releases, so a settled PR only
    // explains *this* marker when it is the associated lock on this head.
    // Otherwise this is a fresh claim standing next to an old merged release.
    if (settled.value !== null && settled.value.headSha === markerSha)
      return ok({
        kind: "marker-cleanup-pending",
        marker: observation,
        pullRequest: settled.value,
        mergedRelease,
      });
    if (request.recordedCleanup !== undefined) {
      const generation = await this.readMarkerGeneration(markerSha);
      if (generation.isErr()) return err(generation.error);
      return ok({
        kind: "creation-cleanup-pending",
        marker: observation,
        recordedCleanup: request.recordedCleanup,
        generationMatches:
          generation.value === request.recordedCleanup.ownerGeneration &&
          markerSha === request.recordedCleanup.expectedMarkerSha,
        mergedRelease,
      });
    }
    if (request.creationPollExhausted === true)
      return ok({
        kind: "orphan-marker",
        marker: observation,
        mergedRelease,
      });
    return ok({
      kind: "creation-in-progress",
      marker: observation,
      mergedRelease,
    });
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * The whole creation event: ownership, bounded creator-owned replan, and a
   * transactional abort on exhaustion.
   *
   * The caller's workflow may also drive the phases individually — Task 23
   * unrolls them into separate jobs so the AI key and the App token never sit
   * in the same job — which is why every phase below is public too.
   */
  createStableReleasePr(request: {
    plannedBaseSha: string;
    preparer: CreationPreparer;
  }): ResultAsync<CreatedReleasePr, ReleasePrError> {
    return fromAsync(() => this.runCreate(request));
  }

  private async runCreate(request: {
    plannedBaseSha: string;
    preparer: CreationPreparer;
  }): Promise<Result<CreatedReleasePr, ReleasePrError>> {
    const acquired = await this.runAcquireOwnership(request.plannedBaseSha);
    if (acquired.isErr()) return err(acquired.error);
    let ownership = acquired.value;
    let baseSha = request.plannedBaseSha;
    let previous: PreparedRelease | null = null;
    for (
      let attempt = 1;
      attempt <= this.bounds.freshnessAttempts;
      attempt += 1
    ) {
      const prepared: Result<PreparedRelease, PreparationFailure> =
        await settle(request.preparer.prepare({ baseSha, previous }));
      if (prepared.isErr())
        return err(
          await this.failAfterOwnership(ownership, {
            type: "ReleasePreparationFailed",
            stage: prepared.error.stage,
            message: prepared.error.message,
            retryable: prepared.error.retryable ?? true,
          }),
        );
      const finalized = await this.runFinalize({
        ownership,
        prepared: prepared.value,
      });
      if (finalized.isOk()) return ok(finalized.value);
      if (finalized.error.type !== "PreparationStale")
        return err(finalized.error);
      baseSha = finalized.error.newHead;
      // The branch may already carry this attempt's release commit, so the
      // replan leases against the head finalize left behind, never the
      // superseded marker SHA it started from.
      ownership = finalized.error.ownership;
      previous = prepared.value;
    }
    const cleanup = await this.runAbort({ ownership, reconcile: false });
    if (cleanup.isErr()) return err(cleanup.error);
    if (cleanup.value.kind === "pull-request-visible")
      return err({ type: "ReleasePrExists", url: cleanup.value.url });
    return err({
      type: "PreparationFreshnessExhausted",
      attempts: this.bounds.freshnessAttempts,
      retryable: true,
      cleanup: cleanup.value.kind,
    });
  }

  /**
   * Wins — or loses — the atomic marker race.
   *
   * The winner returns an ownership identity; every loser polls for the
   * winner's PR and returns typed `ReleasePrExists { url }` without mutating
   * the ref or the PR. A loser that never sees a PR is looking at a crashed
   * creator, not a race, and says so.
   */
  acquireCreationOwnership(request: {
    plannedBaseSha: string;
  }): ResultAsync<ReleasePrOwnership, ReleasePrError> {
    return fromAsync(() => this.runAcquireOwnership(request.plannedBaseSha));
  }

  private async runAcquireOwnership(
    plannedBaseSha: string,
  ): Promise<Result<ReleasePrOwnership, ReleasePrError>> {
    if (!FULL_SHA.test(plannedBaseSha))
      return err({
        type: "ReleasePreparationFailed",
        stage: "plan-rebinding",
        message: `plannedBaseSha must be a full SHA, got ${plannedBaseSha}`,
        retryable: false,
      });
    const state = await this.runDiscover({});
    if (state.isErr()) return err(state.error);
    const blocked = preparationBlock(state.value);
    if (blocked !== null) return err(blocked);

    const ownerGeneration = this.generateOwnerGeneration();
    if (!OWNER_GENERATION.test(ownerGeneration))
      return err({
        type: "InvalidReleasePrEnvelope",
        issues: ["ownerGeneration must be 64 lowercase hex characters"],
      });
    const envelope = renderReleasePrEnvelope({
      schemaVersion: RELEASE_PR_ENVELOPE_SCHEMA_VERSION,
      ref: RELEASE_PR_MARKER_REF,
      ownerGeneration,
      plannedBaseSha,
      baseSha: plannedBaseSha,
      regeneratedFrom: [],
      entryProse: [],
      // The marker claims the lock; it renders no entries and cites nothing.
      evidenceDigest: evidenceDigest({}),
    });
    if (envelope.isErr()) return err(envelope.error);
    const marker = await settle(
      this.ports.refs.createCommitOnBase({
        baseSha: plannedBaseSha,
        message: `${OWNERSHIP_MARKER_SUBJECT}\n\n${envelope.value}\n`,
      }),
    );
    if (marker.isErr())
      return err(portFailure("createCommitOnBase", marker.error));
    const created = await settle(
      this.ports.refs.createRefAtomic(this.refPath, marker.value),
    );
    if (created.isOk())
      return ok({
        ref: RELEASE_PR_MARKER_REF,
        ownerGeneration,
        expectedMarkerSha: marker.value,
        plannedBaseSha,
      });
    if (created.error.type !== "ReferenceAlreadyExists")
      return err(portFailure("createRefAtomic", created.error));
    // Lost the race: observe, never mutate. The marker commit written above is
    // an unreferenced object — no ref, branch, or PR ever points at it — so the
    // loser leaves the winner's state exactly as it found it.
    const polled = await this.pollForOpenReleasePullRequest();
    if (polled.isErr()) return err(polled.error);
    if (polled.value !== null)
      return err({ type: "ReleasePrExists", url: polled.value.url });
    return err({
      type: "ReleasePrCreationStalled",
      ref: RELEASE_PR_MARKER_REF,
      attempts: this.bounds.creationPollAttempts,
    });
  }

  /**
   * Pushes the prepared release and opens the PR, or refuses because the trunk
   * moved.
   *
   * The live green trunk is re-read at all three boundaries where stale content
   * could otherwise escape: before the prepared commit is built, after it is
   * built and immediately before the branch compare-and-swap, and after that
   * swap and immediately before the PR is opened. A moved trunk returns
   * `PreparationStale { newHead, ownership }` **with the marker retained**,
   * because the caller owns the bounded replan and must keep its lock — and its
   * current head — while replanning. No PR is ever opened on a superseded base.
   */
  finalizeCreation(request: {
    ownership: ReleasePrOwnership;
    prepared: PreparedRelease;
  }): ResultAsync<CreatedReleasePr, ReleasePrError> {
    return fromAsync(() => this.runFinalize(request));
  }

  private async runFinalize(request: {
    ownership: ReleasePrOwnership;
    prepared: PreparedRelease;
  }): Promise<Result<CreatedReleasePr, ReleasePrError>> {
    const { ownership, prepared } = request;
    const content = validatePreparedRelease(prepared);
    if (content.isErr())
      return err(await this.failAfterOwnership(ownership, content.error));

    const fresh = await this.requireFreshTrunkOrCleanup(
      prepared.baseSha,
      ownership,
    );
    if (fresh.isErr()) return err(fresh.error);

    const envelope = renderReleasePrEnvelope({
      schemaVersion: RELEASE_PR_ENVELOPE_SCHEMA_VERSION,
      ref: RELEASE_PR_MARKER_REF,
      ownerGeneration: ownership.ownerGeneration,
      plannedBaseSha: ownership.plannedBaseSha,
      baseSha: prepared.baseSha,
      regeneratedFrom: [],
      entryProse: [...recordEntryProse(prepared.entries)],
      evidenceDigest: evidenceDigest(prepared.evidence),
    });
    if (envelope.isErr())
      return err(await this.failAfterOwnership(ownership, envelope.error));

    const commit = await settle(
      this.ports.refs.createCommitOnBase({
        baseSha: prepared.baseSha,
        message: `${prepared.commitSubject}\n\n${envelope.value}\n`,
        files: prepared.files,
      }),
    );
    if (commit.isErr())
      return err(
        await this.failAfterOwnership(ownership, {
          type: "ReleasePreparationFailed",
          stage: "prepared-commit",
          message: commit.error.message,
          retryable: true,
        }),
      );

    // The trunk may have moved while the commit was being built.
    const stillFresh = await this.requireFreshTrunkOrCleanup(
      prepared.baseSha,
      ownership,
    );
    if (stillFresh.isErr()) return err(stillFresh.error);

    const pushed = await settle(
      this.ports.refs.updateRefWithLease(
        this.refPath,
        commit.value,
        ownership.expectedMarkerSha,
      ),
    );
    if (pushed.isErr())
      return err(
        await this.failAfterOwnership(ownership, {
          type: "ReleasePreparationFailed",
          stage: "branch-push",
          message: describeRefWriteError(pushed.error),
          retryable: true,
        }),
      );

    const owned: ReleasePrOwnership = {
      ...ownership,
      expectedMarkerSha: commit.value,
    };

    // The swap succeeded, but opening a PR is a separate round trip and the
    // trunk may have moved during it. Publishing now would announce content
    // bound to an already-superseded base, so the run hands its *updated*
    // ownership back to the replan and opens nothing.
    const freshForPullRequest = await this.requireFreshTrunkOrCleanup(
      prepared.baseSha,
      owned,
    );
    if (freshForPullRequest.isErr()) return err(freshForPullRequest.error);

    const opened = await settle(
      this.ports.pullRequests.createPullRequest({
        title: prepared.title,
        body: `${prepared.body}\n\n${envelope.value}\n`,
        headRef: RELEASE_PR_MARKER_REF,
        baseRef: MAIN_BRANCH,
        labels: [RELEASE_PR_LABEL],
      }),
    );
    if (opened.isErr())
      return err(
        await this.recoverFromCreateFailure(owned, prepared, opened.error),
      );

    const verified = await this.verifyCreatedPullRequest(
      opened.value,
      commit.value,
    );
    if (verified.isErr()) return err(verified.error);
    return ok({
      pullRequest: verified.value,
      ownership: owned,
      baseSha: prepared.baseSha,
    });
  }

  private async verifyCreatedPullRequest(
    created: GitHubPullRequestSummary,
    commitSha: string,
  ): Promise<Result<GitHubPullRequestSummary, ReleasePrError>> {
    // Defence in depth: exactly one open release PR may exist, and it must be
    // the one this run just pushed.
    const open = await this.readOpenReleasePullRequest();
    if (open.isErr()) {
      if (open.error.type === "DuplicateReleasePr") return err(open.error);
      // The PR exists and this run holds its identity, so the marker is never
      // deleted here: only the verification is pending.
      return err({
        type: "ReleasePrVerificationPending",
        url: created.url,
        message: describeError(open.error),
      });
    }
    const live = open.value ?? created;
    if (live.headSha !== "" && live.headSha !== commitSha)
      return err({
        type: "UnexpectedReleasePrHead",
        url: live.url,
        expected: commitSha,
        actual: live.headSha,
      });
    return ok(live);
  }

  private async recoverFromCreateFailure(
    ownership: ReleasePrOwnership,
    prepared: PreparedRelease,
    failure: GitHubPullRequestWriteError,
  ): Promise<ReleasePrError> {
    // Create and label are separate writes. A parse or label failure after a
    // successful POST may still have left a live PR, so every create failure
    // reconciles by the owner-qualified head before any delete.
    const cleanup = await this.runAbort({ ownership, reconcile: true });
    if (cleanup.isErr()) return cleanup.error;
    if (cleanup.value.kind === "pull-request-visible")
      return { type: "ReleasePrExists", url: cleanup.value.url };
    return {
      type: "ReleasePreparationFailed",
      stage: "pull-request-create",
      message: `${describeError(failure)} at ${prepared.baseSha}`,
      retryable: true,
    };
  }

  /**
   * The single cleanup transaction between marker ownership and a visible PR.
   *
   * Nothing here claims success it cannot prove: ownership is re-verified by
   * generation, the PR query is authoritative (and bounded-retried after an
   * ambiguous create), a visible PR keeps the marker, and only a matching
   * owned marker is CAS-deleted. Anything else is typed
   * `CreationCleanupPending` carrying the whole ownership identity.
   */
  abortOwnedCreation(request: {
    ownership: ReleasePrOwnership;
    reconcile?: boolean;
  }): ResultAsync<AbortOwnedCreationOutcome, ReleasePrError> {
    return fromAsync(() => this.runAbort(request));
  }

  private async runAbort(request: {
    ownership: ReleasePrOwnership;
    reconcile?: boolean;
  }): Promise<Result<AbortOwnedCreationOutcome, ReleasePrError>> {
    const { ownership } = request;
    const attempts =
      request.reconcile === true ? this.bounds.reconciliationAttempts : 1;
    const head = await this.readMarker();
    if (head.isErr())
      return err(cleanupPending(ownership, "unverifiable-ownership"));
    if (head.value === null) {
      const absent = await this.reconcileOpenReleasePullRequest(
        attempts,
        ownership,
      );
      if (absent.isErr()) {
        if (absent.error.type === "DuplicateReleasePr")
          return err(absent.error);
        return err(cleanupPending(ownership, "unverifiable-pull-request"));
      }
      if (absent.value !== null)
        return ok({
          kind: "pull-request-visible",
          url: absent.value.url,
          ownership,
        });
      return ok({ kind: "marker-absent", ownership });
    }
    if (head.value !== ownership.expectedMarkerSha)
      return err(cleanupPending(ownership, "ownership-changed"));
    const generation = await this.readMarkerGeneration(head.value);
    if (generation.isErr())
      return err(cleanupPending(ownership, "unverifiable-ownership"));
    if (generation.value === null)
      return err(cleanupPending(ownership, "unverifiable-ownership"));
    if (generation.value !== ownership.ownerGeneration)
      return err(cleanupPending(ownership, "ownership-changed"));

    const pullRequest = await this.reconcileOpenReleasePullRequest(
      attempts,
      ownership,
    );
    if (pullRequest.isErr()) {
      if (pullRequest.error.type === "DuplicateReleasePr")
        return err(pullRequest.error);
      return err(cleanupPending(ownership, "unverifiable-pull-request"));
    }
    if (pullRequest.value !== null)
      return ok({
        kind: "pull-request-visible",
        url: pullRequest.value.url,
        ownership,
      });
    const deleted = await settle(
      this.ports.refs.deleteRefWithLease(
        this.refPath,
        ownership.expectedMarkerSha,
      ),
    );
    if (deleted.isErr())
      return err(cleanupPending(ownership, "cas-delete-failed"));
    return ok({ kind: "marker-deleted", ownership });
  }

  // -------------------------------------------------------------------------
  // Regeneration
  // -------------------------------------------------------------------------

  /**
   * Rebuilds the open release PR against the newest green trunk. Never creates.
   *
   * The compare-and-swap loop is the whole point: a lease failure means another
   * writer won, so this run re-reads state and either converges as
   * `RegenerationSuperseded` (the survivor already covers a same-or-newer base)
   * or retries against the newer head. The monotonic guard refuses to replace a
   * head whose embedded `baseSha` is newer than this run's, so an older
   * regeneration can never land on top of a newer one.
   */
  regenerate(request: {
    builder: RegenerationBuilder;
  }): ResultAsync<RegenerationOutcome, ReleasePrError> {
    return fromAsync(() => this.runRegenerate(request.builder));
  }

  private async runRegenerate(
    builder: RegenerationBuilder,
  ): Promise<Result<RegenerationOutcome, ReleasePrError>> {
    const state = await this.runDiscover({});
    if (state.isErr()) return err(state.error);
    const live = await this.resolveRegenerationTarget(state.value);
    if (live.isErr()) return err(live.error);
    if (live.value === null) return ok({ kind: "NoReleasePrToRegenerate" });
    let pullRequest = live.value;

    const markerSha = await this.readMarker();
    if (markerSha.isErr()) return err(markerSha.error);
    if (markerSha.value === null)
      return ok({ kind: "NoReleasePrToRegenerate" });
    let expectedHead = markerSha.value;

    for (
      let attempt = 1;
      attempt <= this.bounds.regenerationAttempts;
      attempt += 1
    ) {
      const envelope = await this.readEnvelopeAt(expectedHead);
      if (envelope.isErr()) return err(envelope.error);
      const head = await this.readGreenMainHead();
      if (head.isErr()) return err(head.error);
      const baseSha = head.value;

      const guard = await this.monotonicGuard(envelope.value.baseSha, baseSha);
      if (guard.isErr()) return err(guard.error);
      if (guard.value !== null) {
        if (guard.value.kind !== "RegenerationSuperseded")
          return ok(guard.value);
        return this.concludeSuperseded(
          pullRequest,
          expectedHead,
          envelope.value,
          builder,
          guard.value,
        );
      }

      const built = await settle(builder.build({ baseSha, expectedHead }));
      if (built.isErr())
        return err({
          type: "ReleasePreparationFailed",
          stage: built.error.stage,
          message: built.error.message,
          retryable: built.error.retryable ?? true,
        });
      if (built.value.docsAuditedSha !== baseSha)
        return err({
          type: "DocsAuditNotBoundToBase",
          auditedSha: built.value.docsAuditedSha,
          baseSha,
        });

      const resolved = resolveRegeneratedEntries({
        generated: built.value.generated,
        current: built.value.current,
        recorded: envelope.value.entryProse,
        recordedEvidenceDigest: envelope.value.evidenceDigest,
        evidence: built.value.evidence,
      });
      if (resolved.isErr()) return err(resolved.error);

      const rendered = await settle(
        builder.render({ baseSha, entries: resolved.value.entries }),
      );
      if (rendered.isErr())
        return err({
          type: "ReleasePreparationFailed",
          stage: rendered.error.stage,
          message: rendered.error.message,
          retryable: rendered.error.retryable ?? true,
        });
      const content = validatePreparedRelease(rendered.value);
      if (content.isErr()) return err(content.error);

      const nextEnvelope = renderReleasePrEnvelope({
        ...envelope.value,
        baseSha,
        regeneratedFrom: [
          ...envelope.value.regeneratedFrom,
          envelope.value.baseSha,
        ].slice(-this.bounds.auditTrail),
        entryProse: [...resolved.value.entryProse],
        evidenceDigest: resolved.value.evidenceDigest,
      });
      if (nextEnvelope.isErr()) return err(nextEnvelope.error);

      const commit = await settle(
        this.ports.refs.createCommitOnBase({
          baseSha,
          message: `${rendered.value.commitSubject}\n\n${nextEnvelope.value}\n`,
          files: rendered.value.files,
        }),
      );
      if (commit.isErr())
        return err(portFailure("createCommitOnBase", commit.error));

      // Building the commit is a network round trip of its own, so the trunk is
      // rechecked here — after the commit exists and immediately before the
      // compare-and-swap. A moved trunk makes the built commit stale: it is
      // discarded unreferenced and the attempt restarts at the newer head.
      const recheck = await this.readGreenMainHead();
      if (recheck.isErr()) return err(recheck.error);
      if (recheck.value !== baseSha) continue;

      const swapped = await settle(
        this.ports.refs.updateRefWithLease(
          this.refPath,
          commit.value,
          expectedHead,
        ),
      );
      if (swapped.isErr()) {
        if (swapped.error.type !== "ReferenceLeaseLost")
          return err(portFailure("updateRefWithLease", swapped.error));
        const rebased = await this.afterLeaseLoss(baseSha);
        if (rebased.isErr()) return err(rebased.error);
        if (rebased.value.outcome !== null) {
          if (
            rebased.value.head === null ||
            rebased.value.outcome.kind !== "RegenerationSuperseded"
          )
            return ok(rebased.value.outcome);
          const surviving = await this.readEnvelopeAt(rebased.value.head);
          if (surviving.isErr()) return err(surviving.error);
          return this.concludeSuperseded(
            pullRequest,
            rebased.value.head,
            surviving.value,
            builder,
            rebased.value.outcome,
          );
        }
        if (rebased.value.head === null)
          return ok({ kind: "NoReleasePrToRegenerate" });
        expectedHead = rebased.value.head;
        continue;
      }

      const parsedNext = parseReleasePrEnvelope(nextEnvelope.value);
      if (parsedNext.isErr()) return err(parsedNext.error);
      const published = await this.publishPullRequestMetadata({
        pullRequest,
        title: rendered.value.title,
        body: `${rendered.value.body}\n\n${nextEnvelope.value}\n`,
        expected: parsedNext.value,
        expectedHead: commit.value,
        builder,
      });
      if (published.isErr())
        return err({
          type: "ReleasePrMetadataPending",
          url: pullRequest.url,
          pending: prMetadataGaps(pullRequest, parsedNext.value),
          message: describeError(published.error),
        });
      pullRequest = published.value.pullRequest;
      if (published.value.superseded)
        return ok({
          kind: "PrMetadataReconciled",
          pullRequest,
          baseSha: published.value.envelope.baseSha,
          commitSha: published.value.markerSha,
          pending: prMetadataGaps(pullRequest, published.value.envelope),
        });
      return ok({
        kind: "Regenerated",
        pullRequest,
        baseSha,
        commitSha: commit.value,
        regeneratedFrom: parsedNext.value.regeneratedFrom,
        preserved: resolved.value.preserved,
      });
    }
    return err({
      type: "RegenerationRetriesExhausted",
      attempts: this.bounds.regenerationAttempts,
    });
  }

  private async resolveRegenerationTarget(
    state: ReleasePrState,
  ): Promise<Result<GitHubPullRequestSummary | null, ReleasePrError>> {
    if (state.kind === "live" || state.kind === "pr-metadata-pending")
      return ok(state.pullRequest);
    if (state.kind === "absent" || state.kind === "pending-merged-release")
      return ok(null);
    if (state.kind === "marker-cleanup-pending")
      return err({
        type: "MarkerCleanupPending",
        ref: state.marker.ref,
        markerSha: state.marker.sha,
        reason: "delete-failed",
      });
    if (state.kind === "creation-cleanup-pending")
      return err(
        cleanupPending(state.recordedCleanup, "unverifiable-pull-request"),
      );
    if (state.kind === "orphan-marker")
      return err({
        type: "ReleasePrCreationStalled",
        ref: state.marker.ref,
        attempts: 0,
      });
    // Creation in progress, possibly mid-replan: wait boundedly, never mutate.
    const polled = await this.pollForOpenReleasePullRequest();
    if (polled.isErr()) return err(polled.error);
    if (polled.value !== null) return ok(polled.value);
    return err({
      type: "ReleasePrCreationStalled",
      ref: state.marker.ref,
      attempts: this.bounds.creationPollAttempts,
    });
  }

  /**
   * Refuses to replace a head that already covers a newer trunk commit.
   *
   * This is the guard that makes regeneration monotonic: it holds on the
   * ordinary path *and* after a lease loss, so no interleaving can leave the PR
   * describing an older `main` than one already accepted.
   */
  private async monotonicGuard(
    survivingBaseSha: string,
    candidateBaseSha: string,
  ): Promise<Result<RegenerationOutcome | null, ReleasePrError>> {
    if (survivingBaseSha === candidateBaseSha)
      return ok({
        kind: "RegenerationSuperseded",
        survivingBaseSha,
        baseSha: candidateBaseSha,
      });
    const compared = await settle(
      this.ports.refs.compareCommits(candidateBaseSha, survivingBaseSha),
    );
    if (compared.isErr())
      return err(portFailure("compareCommits", compared.error));
    // "ahead" means the surviving base is ahead of this run's candidate base.
    if (compared.value === "ahead" || compared.value === "identical")
      return ok({
        kind: "RegenerationSuperseded",
        survivingBaseSha,
        baseSha: candidateBaseSha,
      });
    return ok(null);
  }

  private async afterLeaseLoss(
    baseSha: string,
  ): Promise<
    Result<
      { outcome: RegenerationOutcome | null; head: string | null },
      ReleasePrError
    >
  > {
    const head = await this.readMarker();
    if (head.isErr()) return err(head.error);
    if (head.value === null) return ok({ outcome: null, head: null });
    const envelope = await this.readEnvelopeAt(head.value);
    if (envelope.isErr()) return err(envelope.error);
    const guard = await this.monotonicGuard(envelope.value.baseSha, baseSha);
    if (guard.isErr()) return err(guard.error);
    if (guard.value !== null)
      return ok({ outcome: guard.value, head: head.value });
    return ok({ outcome: null, head: head.value });
  }

  // -------------------------------------------------------------------------
  // Marker lifecycle
  // -------------------------------------------------------------------------

  /**
   * Deletes the active-PR lock after its PR merged or closed.
   *
   * Deletion first proves no open PR exists on the owner-qualified marker
   * head, then authorizes only from the associated settled stable release PR:
   * exact head SHA, `release:stable` label, `main` base, and an ownership
   * envelope consistent with the current marker commit. A newer closed PR on
   * the same head cannot hide an older open one or stand in for the lock.
   * A failed delete is typed `MarkerCleanupPending` that resume clears later
   * — it never blocks tags, releases, or publication.
   */
  deleteMarkerRef(): ResultAsync<MarkerDeletionOutcome, ReleasePrError> {
    return fromAsync(() => this.runDeleteMarker());
  }

  private async runDeleteMarker(): Promise<
    Result<MarkerDeletionOutcome, ReleasePrError>
  > {
    const head = await this.readMarker();
    if (head.isErr()) return err(head.error);
    if (head.value === null)
      return ok({ kind: "already-absent", ref: RELEASE_PR_MARKER_REF });
    const settled = await this.readAssociatedSettledReleasePullRequest(
      head.value,
    );
    if (settled.isErr()) return err(settled.error);
    const deleted = await settle(
      this.ports.refs.deleteRefWithLease(this.refPath, head.value),
    );
    if (deleted.isErr())
      return err({
        type: "MarkerCleanupPending",
        ref: RELEASE_PR_MARKER_REF,
        markerSha: head.value,
        reason:
          deleted.error.type === "ReferenceLeaseLost"
            ? "lease-lost"
            : "delete-failed",
      });
    return ok({
      kind: "deleted",
      ref: RELEASE_PR_MARKER_REF,
      markerSha: head.value,
    });
  }

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  /**
   * The maintainer gate for the one request entry point.
   *
   * It fails closed: an unreadable membership is a refusal, not an assumption,
   * and the push-triggered regeneration path never calls this at all.
   */
  assertStableRequestAuthorized(
    actor: string,
  ): ResultAsync<string, ReleasePrError> {
    const team = `${this.maintainerTeam.organization}/${this.maintainerTeam.teamSlug}`;
    if (
      actor.length > RELEASE_PR_BOUNDS.actorLength ||
      !GITHUB_LOGIN.test(actor)
    )
      return errAsync({
        type: "UnauthorizedStableRequest",
        actor,
        team,
        reason: "invalid-actor",
      });
    return this.ports.team
      .isTeamMember({
        organization: this.maintainerTeam.organization,
        teamSlug: this.maintainerTeam.teamSlug,
        login: actor,
      })
      .mapErr(
        (): ReleasePrError => ({
          type: "UnauthorizedStableRequest",
          actor,
          team,
          reason: "membership-unverifiable",
        }),
      )
      .andThen((member) =>
        member
          ? okAsync<string, ReleasePrError>(actor)
          : errAsync<string, ReleasePrError>({
              type: "UnauthorizedStableRequest",
              actor,
              team,
              reason: "not-a-member",
            }),
      );
  }

  // -------------------------------------------------------------------------
  // Shared reads
  // -------------------------------------------------------------------------

  private async requireFreshTrunk(
    baseSha: string,
    ownership: ReleasePrOwnership,
  ): Promise<Result<string, ReleasePrError>> {
    const head = await this.readGreenMainHead();
    if (head.isErr()) return err(head.error);
    if (head.value !== baseSha)
      return err({
        type: "PreparationStale",
        newHead: head.value,
        baseSha,
        ownership,
      });
    return ok(head.value);
  }

  /**
   * Freshness that is not a replan signal is a post-ownership failure: keep
   * `PreparationStale` so the caller can replan with the lock, and abort every
   * other read failure so a generic port error cannot leave `(marker, no PR)`.
   */
  private async requireFreshTrunkOrCleanup(
    baseSha: string,
    ownership: ReleasePrOwnership,
  ): Promise<Result<string, ReleasePrError>> {
    const fresh = await this.requireFreshTrunk(baseSha, ownership);
    if (fresh.isOk()) return fresh;
    if (fresh.error.type === "PreparationStale") return fresh;
    return err(await this.failAfterOwnership(ownership, fresh.error));
  }

  private async readGreenMainHead(): Promise<Result<string, ReleasePrError>> {
    const head = await settle(this.ports.main.readGreenMainHead());
    return head.mapErr((failure) => portFailure("readGreenMainHead", failure));
  }

  private async readMarker(): Promise<Result<string | null, ReleasePrError>> {
    const head = await settle(this.ports.refs.readRefOptional(this.refPath));
    return head.mapErr((failure) => portFailure("readRefOptional", failure));
  }

  private async readMarkerGeneration(
    sha: string,
  ): Promise<Result<string | null, ReleasePrError>> {
    const message = await settle(this.ports.refs.readCommitMessage(sha));
    if (message.isErr())
      return err(portFailure("readCommitMessage", message.error));
    const envelope = parseReleasePrEnvelope(message.value);
    if (envelope.isErr()) return ok(null);
    return ok(envelope.value.ownerGeneration);
  }

  private async readEnvelopeAt(
    sha: string,
  ): Promise<Result<ReleasePrEnvelope, ReleasePrError>> {
    const message = await settle(this.ports.refs.readCommitMessage(sha));
    if (message.isErr())
      return err(portFailure("readCommitMessage", message.error));
    return parseReleasePrEnvelope(message.value);
  }

  /**
   * The labeled identity of the live release PR.
   *
   * Duplicate detection stays on this labeled set. Cleanup and partial-create
   * reconciliation use {@link readOpenReleasePullRequestOnHead} so an unlabeled
   * PR on the marker head cannot be mistaken for absence.
   */
  private async readOpenReleasePullRequest(): Promise<
    Result<GitHubPullRequestSummary | null, ReleasePrError>
  > {
    const listed = await settle(
      this.ports.pullRequests.listOpenPullRequestsByLabel(RELEASE_PR_LABEL),
    );
    if (listed.isErr())
      return err(portFailure("listOpenPullRequestsByLabel", listed.error));
    // Inspect the complete labeled set before narrowing to the canonical head.
    // A stable-labeled PR on another branch is a protocol identity, not an
    // irrelevant PR: ignoring it would make creation report a false absence.
    const labeled = listed.value;
    if (labeled.length > 1)
      return err({
        type: "DuplicateReleasePr",
        urls: labeled.map((pull) => pull.url),
      });
    const labeledPull = labeled[0];
    if (labeledPull !== undefined) {
      if (labeledPull.headRef !== RELEASE_PR_MARKER_REF)
        return err({
          type: "ReleasePrProtocolAnomaly",
          ref: RELEASE_PR_MARKER_REF,
          url: labeledPull.url,
        });
      return ok(labeledPull);
    }
    // Create and label are separate writes. An unlabeled PR on the marker
    // head is still the lock; label-only discovery would stall forever.
    const onHead = await this.listReleasePullRequestsForHead("open");
    if (onHead.isErr()) return err(onHead.error);
    if (onHead.value.length > 1)
      return err({
        type: "DuplicateReleasePr",
        urls: onHead.value.map((pull) => pull.url),
      });
    return ok(onHead.value[0] ?? null);
  }

  private async listReleasePullRequestsForHead(
    state: GitHubPullRequestState,
  ): Promise<Result<readonly GitHubPullRequestSummary[], ReleasePrError>> {
    const listed = await settle(
      this.ports.pullRequests.listPullRequestsForHead(
        RELEASE_PR_MARKER_REF,
        state,
      ),
    );
    return listed.mapErr((failure) =>
      portFailure("listPullRequestsForHead", failure),
    );
  }

  private async readSettledReleasePullRequest(
    markerSha: string,
  ): Promise<Result<GitHubPullRequestSummary | null, ReleasePrError>> {
    const open = await this.listReleasePullRequestsForHead("open");
    if (open.isErr()) return err(open.error);
    if (open.value.length > 1)
      return err({
        type: "DuplicateReleasePr",
        urls: open.value.map((pull) => pull.url),
      });
    if (open.value.length > 0) return ok(null);
    const associated =
      await this.findAssociatedSettledReleasePullRequest(markerSha);
    if (associated.isErr()) {
      if (associated.error.type === "MarkerDeletionNotAuthorized")
        return ok(null);
      return err(associated.error);
    }
    return ok(associated.value);
  }

  private async readAssociatedSettledReleasePullRequest(
    markerSha: string,
  ): Promise<Result<GitHubPullRequestSummary, ReleasePrError>> {
    const open = await this.listReleasePullRequestsForHead("open");
    if (open.isErr()) return err(open.error);
    if (open.value.length > 1)
      return err({
        type: "DuplicateReleasePr",
        urls: open.value.map((pull) => pull.url),
      });
    if (open.value.length > 0)
      return err({
        type: "MarkerDeletionNotAuthorized",
        ref: RELEASE_PR_MARKER_REF,
        reason: "pull-request-open",
      });
    return this.findAssociatedSettledReleasePullRequest(markerSha);
  }

  private async findAssociatedSettledReleasePullRequest(
    markerSha: string,
  ): Promise<Result<GitHubPullRequestSummary, ReleasePrError>> {
    const closed = await this.listReleasePullRequestsForHead("closed");
    if (closed.isErr()) return err(closed.error);
    if (closed.value.length === 0)
      return err({
        type: "MarkerDeletionNotAuthorized",
        ref: RELEASE_PR_MARKER_REF,
        reason: "no-settled-pull-request",
      });
    const markerEnvelope = await this.readEnvelopeAt(markerSha);
    if (markerEnvelope.isErr()) return err(markerEnvelope.error);
    const matchingSha = closed.value.filter(
      (pull) => pull.headSha === markerSha,
    );
    if (matchingSha.length === 0)
      return err({
        type: "MarkerDeletionNotAuthorized",
        ref: RELEASE_PR_MARKER_REF,
        reason: "marker-head-mismatch",
      });
    const accepted: GitHubPullRequestSummary[] = [];
    let identityReason:
      | "missing-stable-label"
      | "unexpected-base"
      | "ownership-mismatch"
      | null = null;
    for (const pull of matchingSha) {
      const reason = this.settledReleaseIdentityReason(
        pull,
        markerEnvelope.value,
      );
      if (reason === null) accepted.push(pull);
      else identityReason ??= reason;
    }
    if (accepted.length > 1)
      return err({
        type: "DuplicateReleasePr",
        urls: accepted.map((pull) => pull.url),
      });
    const associated = accepted[0];
    if (associated === undefined)
      return err({
        type: "MarkerDeletionNotAuthorized",
        ref: RELEASE_PR_MARKER_REF,
        reason: identityReason ?? "no-settled-pull-request",
      });
    return ok(associated);
  }

  private settledReleaseIdentityReason(
    pull: GitHubPullRequestSummary,
    markerEnvelope: ReleasePrEnvelope,
  ): "missing-stable-label" | "unexpected-base" | "ownership-mismatch" | null {
    if (!pull.labels.includes(RELEASE_PR_LABEL)) return "missing-stable-label";
    if (pull.baseRef !== MAIN_BRANCH) return "unexpected-base";
    const envelope = parseReleasePrEnvelope(pull.body);
    if (envelope.isErr()) return "ownership-mismatch";
    if (
      envelope.value.ownerGeneration !== markerEnvelope.ownerGeneration ||
      envelope.value.plannedBaseSha !== markerEnvelope.plannedBaseSha ||
      envelope.value.ref !== markerEnvelope.ref
    )
      return "ownership-mismatch";
    return null;
  }

  private async readMergedRelease(): Promise<
    Result<MergedReleaseObservation | null, ReleasePrError>
  > {
    const observed = await settle(
      this.ports.completion.readMergedReleaseCompletion(),
    );
    if (observed.isErr())
      return err(portFailure("readMergedReleaseCompletion", observed.error));
    if (observed.value === null) return ok(null);
    const classified = classifyReleaseCompletionState(observed.value.state);
    if (classified.isErr()) return err(classified.error);
    return ok(observed.value);
  }

  private async pollForOpenReleasePullRequest(): Promise<
    Result<GitHubPullRequestSummary | null, ReleasePrError>
  > {
    for (
      let attempt = 1;
      attempt <= this.bounds.creationPollAttempts;
      attempt += 1
    ) {
      const open = await this.readOpenReleasePullRequest();
      if (open.isErr()) return err(open.error);
      if (open.value !== null) return ok(open.value);
      if (attempt < this.bounds.creationPollAttempts)
        await this.sleep(this.bounds.pollDelayMs);
    }
    return ok(null);
  }

  /**
   * The authoritative "does a release PR exist" question, bounded.
   *
   * After an ambiguous or partial create the answer may still be arriving, so a
   * transient read failure is retried. The query is the owner-qualified head
   * ref, not the label: create and label are separate writes, and an unlabeled
   * PR must still preserve the marker. Only an exhausted budget is
   * unverifiable, and an unverifiable answer never authorizes a delete.
   */
  private async reconcileOpenReleasePullRequest(
    attempts: number,
    ownership: ReleasePrOwnership,
  ): Promise<Result<GitHubPullRequestSummary | null, ReleasePrError>> {
    let last: ReleasePrError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const open = await this.readOpenReleasePullRequestOnHead(ownership);
      if (open.isOk() && open.value !== null) return ok(open.value);
      if (open.isOk() && attempt === attempts) return ok(null);
      if (open.isErr()) {
        // A live PR that failed the head/envelope check is not a transient miss.
        if (
          open.error.type === "CreationCleanupPending" ||
          open.error.type === "DuplicateReleasePr"
        )
          return err(open.error);
        last = open.error;
      }
      if (attempt < attempts) await this.sleep(this.bounds.pollDelayMs);
    }
    return last === null ? ok(null) : err(last);
  }

  /**
   * Finds an open PR on the marker head, then requires that PR to sit on this
   * run's expected marker SHA with this run's ownership envelope.
   *
   * A live PR that fails that envelope is still a lock: the result is typed
   * unverifiable so cleanup cannot delete under it.
   */
  private async readOpenReleasePullRequestOnHead(
    ownership: ReleasePrOwnership,
  ): Promise<Result<GitHubPullRequestSummary | null, ReleasePrError>> {
    const open = await this.listReleasePullRequestsForHead("open");
    if (open.isErr()) return err(open.error);
    if (open.value.length > 1)
      return err({
        type: "DuplicateReleasePr",
        urls: open.value.map((pull) => pull.url),
      });
    const pull = open.value[0];
    if (pull === undefined) return ok(null);
    return this.acceptReconciledPullRequest(pull, ownership);
  }

  private acceptReconciledPullRequest(
    pull: GitHubPullRequestSummary,
    ownership: ReleasePrOwnership,
  ): Result<GitHubPullRequestSummary, ReleasePrError> {
    if (pull.headSha !== ownership.expectedMarkerSha)
      return err(cleanupPending(ownership, "unverifiable-pull-request"));
    const envelope = parseReleasePrEnvelope(pull.body);
    if (envelope.isErr())
      return err(cleanupPending(ownership, "unverifiable-pull-request"));
    if (envelope.value.ownerGeneration !== ownership.ownerGeneration)
      return err(cleanupPending(ownership, "unverifiable-pull-request"));
    return ok(pull);
  }

  private async concludeSuperseded(
    pullRequest: GitHubPullRequestSummary,
    expectedHead: string,
    envelope: ReleasePrEnvelope,
    builder: RegenerationBuilder,
    outcome: Extract<RegenerationOutcome, { kind: "RegenerationSuperseded" }>,
  ): Promise<Result<RegenerationOutcome, ReleasePrError>> {
    const reconciled = await this.reconcilePullRequestMetadata({
      pullRequest,
      expectedHead,
      envelope,
      builder,
    });
    if (reconciled.isErr()) return err(reconciled.error);
    if (!reconciled.value.repaired) return ok(outcome);
    return ok({
      kind: "PrMetadataReconciled",
      pullRequest: reconciled.value.pullRequest,
      baseSha: reconciled.value.envelope.baseSha,
      commitSha: reconciled.value.markerSha,
      pending: reconciled.value.pending,
    });
  }

  /**
   * When the marker head already covers the trunk, PR title/body/labels can
   * still lag. Repair those derived fields against the authoritative envelope
   * before declaring the event superseded.
   */
  private async reconcilePullRequestMetadata(input: {
    pullRequest: GitHubPullRequestSummary;
    expectedHead: string;
    envelope: ReleasePrEnvelope;
    builder: RegenerationBuilder;
  }): Promise<
    Result<
      {
        repaired: boolean;
        pullRequest: GitHubPullRequestSummary;
        markerSha: string;
        envelope: ReleasePrEnvelope;
        pending: readonly PrMetadataGap[];
      },
      ReleasePrError
    >
  > {
    const pending = prMetadataGaps(input.pullRequest, input.envelope);
    if (pending.length === 0)
      return ok({
        repaired: false,
        pullRequest: input.pullRequest,
        markerSha: input.expectedHead,
        envelope: input.envelope,
        pending,
      });

    let title = input.pullRequest.title;
    let body = input.pullRequest.body;
    if (pending.includes("envelope")) {
      const rendered = await this.renderMetadataForMarker({
        markerSha: input.expectedHead,
        envelope: input.envelope,
        builder: input.builder,
      });
      if (rendered.isErr()) return err(rendered.error);
      title = rendered.value.title;
      body = rendered.value.body;
    }
    const published = await this.publishPullRequestMetadata({
      pullRequest: input.pullRequest,
      title,
      body,
      expected: input.envelope,
      expectedHead: input.expectedHead,
      builder: input.builder,
      writeMetadata: pending.includes("envelope"),
    });
    if (published.isErr())
      return err({
        type: "ReleasePrMetadataPending",
        url: input.pullRequest.url,
        pending,
        message: describeError(published.error),
      });
    return ok({
      repaired: true,
      pullRequest: published.value.pullRequest,
      markerSha: published.value.markerSha,
      envelope: published.value.envelope,
      pending,
    });
  }

  /**
   * Publishes derived PR metadata only after proving which marker envelope is
   * authoritative. Every successful PATCH and label repair is followed by a
   * fresh marker read. If another writer moved the marker, this loop rebuilds
   * title/body from that newer envelope before it writes again. Thus a stale
   * writer can converge the PR, but it cannot report `Regenerated` for its
   * superseded commit.
   */
  private async publishPullRequestMetadata(input: {
    pullRequest: GitHubPullRequestSummary;
    title: string;
    body: string;
    expected: ReleasePrEnvelope;
    expectedHead: string;
    builder: RegenerationBuilder;
    writeMetadata?: boolean;
  }): Promise<Result<PublishedPrMetadata, ReleasePrError>> {
    let pullRequest = input.pullRequest;
    let target: PublishedPrTarget = {
      markerSha: input.expectedHead,
      envelope: input.expected,
      title: input.title,
      body: input.body,
    };
    let superseded = false;
    let writeMetadata = input.writeMetadata ?? true;
    let lastError: ReleasePrError | null = null;
    let lastAuthoritative: PublishedPrTarget = target;

    for (
      let attempt = 1;
      attempt <= this.bounds.metadataRepairAttempts;
      attempt += 1
    ) {
      const before = await this.readAuthoritativePrMetadata(
        input.pullRequest.url,
      );
      if (before.isErr()) {
        lastError = before.error;
        if (attempt < this.bounds.metadataRepairAttempts)
          await this.sleep(this.bounds.pollDelayMs);
        continue;
      }
      lastAuthoritative = {
        ...lastAuthoritative,
        markerSha: before.value.markerSha,
        envelope: before.value.envelope,
      };
      if (
        before.value.markerSha !== target.markerSha ||
        !releasePrEnvelopesMatch(before.value.envelope, target.envelope)
      ) {
        const rebuilt = await this.renderMetadataForMarker({
          markerSha: before.value.markerSha,
          envelope: before.value.envelope,
          builder: input.builder,
        });
        if (rebuilt.isErr()) return err(rebuilt.error);
        target = {
          markerSha: before.value.markerSha,
          envelope: before.value.envelope,
          title: rebuilt.value.title,
          body: rebuilt.value.body,
        };
        superseded = true;
        writeMetadata = true;
      }

      const metadataNeedsWrite =
        writeMetadata ||
        pullRequest.title !== target.title ||
        pullRequest.body !== target.body;
      if (metadataNeedsWrite) {
        const updated = await settle(
          this.ports.pullRequests.updatePullRequest({
            number: pullRequest.number,
            title: target.title,
            body: target.body,
          }),
        );
        if (updated.isErr()) {
          lastError = {
            type: "ReleasePrPortFailed",
            port: "updatePullRequest",
            message: describeError(updated.error),
          };
          if (attempt < this.bounds.metadataRepairAttempts)
            await this.sleep(this.bounds.pollDelayMs);
          continue;
        }
        pullRequest = updated.value;
        // The PATCH may have raced a marker CAS. Never trust its response as
        // authority; read the marker immediately after the write.
        const afterPatch = await this.readAuthoritativePrMetadata(
          input.pullRequest.url,
        );
        if (afterPatch.isErr()) {
          lastError = afterPatch.error;
          if (attempt < this.bounds.metadataRepairAttempts)
            await this.sleep(this.bounds.pollDelayMs);
          continue;
        }
        lastAuthoritative = {
          ...lastAuthoritative,
          markerSha: afterPatch.value.markerSha,
          envelope: afterPatch.value.envelope,
        };
        if (
          afterPatch.value.markerSha !== target.markerSha ||
          !releasePrEnvelopesMatch(afterPatch.value.envelope, target.envelope)
        ) {
          const rebuilt = await this.renderMetadataForMarker({
            markerSha: afterPatch.value.markerSha,
            envelope: afterPatch.value.envelope,
            builder: input.builder,
          });
          if (rebuilt.isErr()) return err(rebuilt.error);
          target = {
            markerSha: afterPatch.value.markerSha,
            envelope: afterPatch.value.envelope,
            title: rebuilt.value.title,
            body: rebuilt.value.body,
          };
          superseded = true;
          writeMetadata = true;
          if (attempt < this.bounds.metadataRepairAttempts)
            await this.sleep(this.bounds.pollDelayMs);
          continue;
        }
        writeMetadata = false;
      }

      if (!pullRequest.labels.includes(RELEASE_PR_LABEL)) {
        const labeled = await this.repairPullRequestLabels(pullRequest);
        if (labeled.isErr()) {
          lastError = labeled.error;
          // Label POSTs are writes too. Re-read the marker before retrying so
          // an ambiguous label result cannot hide a newer owner.
          const afterLabelFailure = await this.readAuthoritativePrMetadata(
            input.pullRequest.url,
          );
          if (afterLabelFailure.isOk())
            lastAuthoritative = {
              ...lastAuthoritative,
              markerSha: afterLabelFailure.value.markerSha,
              envelope: afterLabelFailure.value.envelope,
            };
          if (attempt < this.bounds.metadataRepairAttempts)
            await this.sleep(this.bounds.pollDelayMs);
          continue;
        }
        pullRequest = labeled.value;
        const afterLabel = await this.readAuthoritativePrMetadata(
          input.pullRequest.url,
        );
        if (afterLabel.isErr()) {
          lastError = afterLabel.error;
          if (attempt < this.bounds.metadataRepairAttempts)
            await this.sleep(this.bounds.pollDelayMs);
          continue;
        }
        lastAuthoritative = {
          ...lastAuthoritative,
          markerSha: afterLabel.value.markerSha,
          envelope: afterLabel.value.envelope,
        };
        if (
          afterLabel.value.markerSha !== target.markerSha ||
          !releasePrEnvelopesMatch(afterLabel.value.envelope, target.envelope)
        ) {
          const rebuilt = await this.renderMetadataForMarker({
            markerSha: afterLabel.value.markerSha,
            envelope: afterLabel.value.envelope,
            builder: input.builder,
          });
          if (rebuilt.isErr()) return err(rebuilt.error);
          target = {
            markerSha: afterLabel.value.markerSha,
            envelope: afterLabel.value.envelope,
            title: rebuilt.value.title,
            body: rebuilt.value.body,
          };
          superseded = true;
          writeMetadata = true;
          if (attempt < this.bounds.metadataRepairAttempts)
            await this.sleep(this.bounds.pollDelayMs);
          continue;
        }
      }

      // Verify the complete envelope, title, labels, and marker once more
      // before returning. This closes the check-to-PATCH race even when the
      // initial read happened just before another writer's CAS.
      const final = await this.readAuthoritativePrMetadata(
        input.pullRequest.url,
      );
      if (final.isErr()) {
        lastError = final.error;
        if (attempt < this.bounds.metadataRepairAttempts)
          await this.sleep(this.bounds.pollDelayMs);
        continue;
      }
      lastAuthoritative = {
        ...lastAuthoritative,
        markerSha: final.value.markerSha,
        envelope: final.value.envelope,
      };
      if (
        final.value.markerSha !== target.markerSha ||
        !releasePrEnvelopesMatch(final.value.envelope, target.envelope)
      ) {
        const rebuilt = await this.renderMetadataForMarker({
          markerSha: final.value.markerSha,
          envelope: final.value.envelope,
          builder: input.builder,
        });
        if (rebuilt.isErr()) return err(rebuilt.error);
        target = {
          markerSha: final.value.markerSha,
          envelope: final.value.envelope,
          title: rebuilt.value.title,
          body: rebuilt.value.body,
        };
        superseded = true;
        writeMetadata = true;
        if (attempt < this.bounds.metadataRepairAttempts)
          await this.sleep(this.bounds.pollDelayMs);
        continue;
      }
      const pending = prMetadataGaps(pullRequest, final.value.envelope);
      if (
        pending.length === 0 &&
        pullRequest.title === target.title &&
        pullRequest.body === target.body
      )
        return ok({
          pullRequest,
          markerSha: final.value.markerSha,
          envelope: final.value.envelope,
          superseded,
        });
      lastError = {
        type: "ReleasePrMetadataPending",
        url: input.pullRequest.url,
        pending,
        message: "pull request metadata does not match the marker envelope",
      };
      writeMetadata = true;
      if (attempt < this.bounds.metadataRepairAttempts)
        await this.sleep(this.bounds.pollDelayMs);
    }

    const pending = prMetadataGaps(pullRequest, lastAuthoritative.envelope);
    return err(
      lastError ?? {
        type: "ReleasePrMetadataPending",
        url: input.pullRequest.url,
        pending,
        message: "pull request metadata repair exhausted",
      },
    );
  }

  private async readAuthoritativePrMetadata(
    url: string,
  ): Promise<Result<PublishedPrAuthority, ReleasePrError>> {
    const marker = await this.readMarker();
    if (marker.isErr()) return err(marker.error);
    if (marker.value === null)
      return err({
        type: "ReleasePrMetadataPending",
        url,
        pending: ["envelope"],
        message: "the authoritative release marker is absent",
      });
    const envelope = await this.readEnvelopeAt(marker.value);
    if (envelope.isErr()) return err(envelope.error);
    return ok({ markerSha: marker.value, envelope: envelope.value });
  }

  private async renderMetadataForMarker(input: {
    markerSha: string;
    envelope: ReleasePrEnvelope;
    builder: RegenerationBuilder;
  }): Promise<Result<RenderedPrMetadata, ReleasePrError>> {
    const built = await settle(
      input.builder.build({
        baseSha: input.envelope.baseSha,
        expectedHead: input.markerSha,
      }),
    );
    if (built.isErr())
      return err({
        type: "ReleasePreparationFailed",
        stage: built.error.stage,
        message: built.error.message,
        retryable: built.error.retryable ?? true,
      });
    if (built.value.docsAuditedSha !== input.envelope.baseSha)
      return err({
        type: "DocsAuditNotBoundToBase",
        auditedSha: built.value.docsAuditedSha,
        baseSha: input.envelope.baseSha,
      });
    const resolved = resolveRegeneratedEntries({
      generated: built.value.generated,
      current: built.value.current,
      recorded: input.envelope.entryProse,
      recordedEvidenceDigest: input.envelope.evidenceDigest,
      evidence: built.value.evidence,
    });
    if (resolved.isErr()) return err(resolved.error);
    const rendered = await settle(
      input.builder.render({
        baseSha: input.envelope.baseSha,
        entries: resolved.value.entries,
      }),
    );
    if (rendered.isErr())
      return err({
        type: "ReleasePreparationFailed",
        stage: rendered.error.stage,
        message: rendered.error.message,
        retryable: rendered.error.retryable ?? true,
      });
    const hidden = renderReleasePrEnvelope(input.envelope);
    if (hidden.isErr()) return err(hidden.error);
    return ok({
      title: rendered.value.title,
      body: `${rendered.value.body}\n\n${hidden.value}\n`,
    });
  }

  private async repairPullRequestLabels(
    pullRequest: GitHubPullRequestSummary,
  ): Promise<Result<GitHubPullRequestSummary, ReleasePrError>> {
    if (pullRequest.labels.includes(RELEASE_PR_LABEL)) return ok(pullRequest);
    const labeled = await settle(
      this.ports.pullRequests.addPullRequestLabels(pullRequest.number, [
        RELEASE_PR_LABEL,
      ]),
    );
    if (labeled.isErr())
      return err({
        type: "ReleasePrPortFailed",
        port: "addPullRequestLabels",
        message: describeError(labeled.error),
      });
    return ok({
      ...pullRequest,
      labels: [...new Set([...pullRequest.labels, ...labeled.value])],
    });
  }

  private async failAfterOwnership(
    ownership: ReleasePrOwnership,
    error: ReleasePrError,
  ): Promise<ReleasePrError> {
    const cleanup = await this.runAbort({ ownership, reconcile: false });
    if (cleanup.isErr()) return cleanup.error;
    if (cleanup.value.kind === "pull-request-visible")
      return { type: "ReleasePrExists", url: cleanup.value.url };
    return error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Which discovered states forbid starting a new preparation. */
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

function prMetadataGaps(
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

function releasePrEnvelopesMatch(
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

function isBlocking(merged: MergedReleaseObservation): boolean {
  return (
    classifyReleaseCompletionState(merged.state).unwrapOr("blocking") ===
    "blocking"
  );
}

function validatePreparedRelease(
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

function recordEntryProse(
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

function cleanupPending(
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

function portFailure(port: string, failure: unknown): ReleasePrError {
  return {
    type: "ReleasePrPortFailed",
    port,
    message: describeError(failure),
  };
}

function describeRefWriteError(failure: GitHubRefWriteError): string {
  if (failure.type === "ReferenceAlreadyExists")
    return `reference ${failure.ref} already exists`;
  if (failure.type === "ReferenceLeaseLost")
    return `lease lost on ${failure.ref}: expected ${failure.expectedSha}, found ${failure.actualSha ?? "nothing"}`;
  return failure.message;
}

function describeError(failure: unknown): string {
  if (typeof failure !== "object" || failure === null) return String(failure);
  const record = failure as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.type === "string") return record.type;
  return JSON.stringify(failure);
}

function defaultOwnerGeneration(): string {
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
function settle<T, E>(operation: ResultAsync<T, E>): Promise<Result<T, E>> {
  return operation.match<Result<T, E>>(
    (value) => ok(value),
    (error) => err(error),
  );
}

/** Runs an async state-machine step without ever leaving `Result` behind. */
function fromAsync<T>(
  run: () => Promise<Result<T, ReleasePrError>>,
): ResultAsync<T, ReleasePrError> {
  return ResultAsync.fromSafePromise(run()).andThen((result) => result);
}
