/**
 * Stable release-PR facade and discovery coordinator.
 *
 * Lifecycle mutations live in focused creation, regeneration, and metadata
 * modules. This facade owns only composition, discovery, authorization, and
 * the shared read/marker-lifecycle protocol.
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
  GitHubPullRequestState,
  GitHubPullRequestSummary,
} from "./github-client.js";
import {
  type AbortOwnedCreationOutcome,
  type CreatedReleasePr,
  type CreationPreparer,
  classifyReleaseCompletionState,
  cleanupPending,
  type DiscoveryRequest,
  defaultOwnerGeneration,
  fromAsync,
  GITHUB_LOGIN,
  isBlocking,
  MAIN_BRANCH,
  type MarkerDeletionOutcome,
  type MarkerObservation,
  type MergedReleaseObservation,
  markerRefPath,
  type PreparedRelease,
  parseReleasePrEnvelope,
  portFailure,
  prMetadataGaps,
  RELEASE_MAINTAINER_ORGANIZATION,
  RELEASE_MAINTAINER_TEAM,
  RELEASE_PR_BOUNDS,
  RELEASE_PR_LABEL,
  RELEASE_PR_MARKER_REF,
  type RegenerationBuilder,
  type RegenerationOutcome,
  type ReleasePrBounds,
  type ReleasePrEnvelope,
  type ReleasePrError,
  type ReleasePrManagerOptions,
  type ReleasePrOwnership,
  type ReleasePrPorts,
  type ReleasePrState,
  settle,
} from "./release-pr-contract.js";
import { ReleasePrCreationLifecycle } from "./release-pr-creation.js";
import { ReleasePrMetadataLifecycle } from "./release-pr-metadata.js";
import { ReleasePrRegenerationLifecycle } from "./release-pr-regeneration.js";

export * from "./release-pr-contract.js";

export class StableReleasePrManager {
  private readonly bounds: ReleasePrBounds;
  private readonly refPath = markerRefPath();
  private readonly generateOwnerGeneration: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maintainerTeam: { organization: string; teamSlug: string };
  private readonly metadata: ReleasePrMetadataLifecycle;
  private readonly creation: ReleasePrCreationLifecycle;
  private readonly regeneration: ReleasePrRegenerationLifecycle;

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
    this.metadata = new ReleasePrMetadataLifecycle({
      ports: this.ports,
      bounds: this.bounds,
      sleep: this.sleep,
      readMarker: () => this.readMarker(),
      readEnvelopeAt: (sha) => this.readEnvelopeAt(sha),
    });
    this.creation = new ReleasePrCreationLifecycle({
      ports: this.ports,
      bounds: this.bounds,
      refPath: this.refPath,
      generateOwnerGeneration: this.generateOwnerGeneration,
      sleep: this.sleep,
      discover: (request) => this.discover(request),
      readGreenMainHead: () => this.readGreenMainHead(),
      readMarker: () => this.readMarker(),
      readMarkerGeneration: (sha) => this.readMarkerGeneration(sha),
      readOpenReleasePullRequest: () => this.readOpenReleasePullRequest(),
      pollForOpenReleasePullRequest: () => this.pollForOpenReleasePullRequest(),
      reconcileOpenReleasePullRequest: (attempts, ownership) =>
        this.reconcileOpenReleasePullRequest(attempts, ownership),
    });
    this.regeneration = new ReleasePrRegenerationLifecycle({
      ports: this.ports,
      bounds: this.bounds,
      refPath: this.refPath,
      sleep: this.sleep,
      discover: (request) => this.discover(request),
      readMarker: () => this.readMarker(),
      readEnvelopeAt: (sha) => this.readEnvelopeAt(sha),
      readGreenMainHead: () => this.readGreenMainHead(),
      pollForOpenReleasePullRequest: () => this.pollForOpenReleasePullRequest(),
      metadata: this.metadata,
    });
  }

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
    return this.creation.createStableReleasePr(request);
  }

  acquireCreationOwnership(request: {
    plannedBaseSha: string;
  }): ResultAsync<ReleasePrOwnership, ReleasePrError> {
    return this.creation.acquireCreationOwnership(request);
  }

  finalizeCreation(request: {
    ownership: ReleasePrOwnership;
    prepared: PreparedRelease;
  }): ResultAsync<CreatedReleasePr, ReleasePrError> {
    return this.creation.finalizeCreation(request);
  }

  abortOwnedCreation(request: {
    ownership: ReleasePrOwnership;
    reconcile?: boolean;
  }): ResultAsync<AbortOwnedCreationOutcome, ReleasePrError> {
    return this.creation.abortOwnedCreation(request);
  }

  regenerate(request: {
    builder: RegenerationBuilder;
  }): ResultAsync<RegenerationOutcome, ReleasePrError> {
    return this.regeneration.regenerate(request);
  }

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
}
