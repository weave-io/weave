/**
 * Focused creation lifecycle for the stable release PR.
 *
 * This module owns marker acquisition, freshness-bound finalization, and the
 * transactional pre-PR abort. The facade supplies only typed reads and ports.
 */
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import {
  appendAiAuditMetadata,
  describeAiAuditError,
} from "./ai/audit-metadata.js";
import type {
  GitHubPullRequestSummary,
  GitHubPullRequestWriteError,
} from "./github-client.js";
import {
  type AbortOwnedCreationOutcome,
  type CreatedReleasePr,
  type CreationPreparer,
  cleanupPending,
  type DiscoveryRequest,
  describeError,
  describeRefWriteError,
  evidenceDigest,
  FULL_SHA,
  fromAsync,
  MAIN_BRANCH,
  OWNER_GENERATION,
  OWNERSHIP_MARKER_SUBJECT,
  type PreparationFailure,
  type PreparedRelease,
  portFailure,
  preparationBlock,
  RELEASE_PR_ENVELOPE_SCHEMA_VERSION,
  RELEASE_PR_LABEL,
  RELEASE_PR_MARKER_REF,
  type ReleasePrBounds,
  type ReleasePrError,
  type ReleasePrOwnership,
  type ReleasePrPorts,
  type ReleasePrState,
  recordEntryProse,
  renderReleasePrEnvelope,
  settle,
  validatePreparedRelease,
} from "./release-pr-contract.js";

export interface ReleasePrCreationContext {
  ports: ReleasePrPorts;
  bounds: ReleasePrBounds;
  refPath: string;
  generateOwnerGeneration: () => string;
  sleep: (milliseconds: number) => Promise<void>;
  discover: (
    request: DiscoveryRequest,
  ) => ResultAsync<ReleasePrState, ReleasePrError>;
  readGreenMainHead: () => Promise<Result<string, ReleasePrError>>;
  readMarker: () => Promise<Result<string | null, ReleasePrError>>;
  readMarkerGeneration: (
    sha: string,
  ) => Promise<Result<string | null, ReleasePrError>>;
  readOpenReleasePullRequest: () => Promise<
    Result<GitHubPullRequestSummary | null, ReleasePrError>
  >;
  pollForOpenReleasePullRequest: () => Promise<
    Result<GitHubPullRequestSummary | null, ReleasePrError>
  >;
  reconcileOpenReleasePullRequest: (
    attempts: number,
    ownership: ReleasePrOwnership,
  ) => Promise<Result<GitHubPullRequestSummary | null, ReleasePrError>>;
}

export class ReleasePrCreationLifecycle {
  constructor(private readonly context: ReleasePrCreationContext) {}

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
      attempt <= this.context.bounds.freshnessAttempts;
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
      attempts: this.context.bounds.freshnessAttempts,
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
    const state = await this.context.discover({});
    if (state.isErr()) return err(state.error);
    const blocked = preparationBlock(state.value);
    if (blocked !== null) return err(blocked);

    const ownerGeneration = this.context.generateOwnerGeneration();
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
      this.context.ports.refs.createCommitOnBase({
        baseSha: plannedBaseSha,
        message: `${OWNERSHIP_MARKER_SUBJECT}\n\n${envelope.value}\n`,
      }),
    );
    if (marker.isErr())
      return err(portFailure("createCommitOnBase", marker.error));
    const created = await settle(
      this.context.ports.refs.createRefAtomic(
        this.context.refPath,
        marker.value,
      ),
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
    const polled = await this.context.pollForOpenReleasePullRequest();
    if (polled.isErr()) return err(polled.error);
    if (polled.value !== null)
      return err({ type: "ReleasePrExists", url: polled.value.url });
    return err({
      type: "ReleasePrCreationStalled",
      ref: RELEASE_PR_MARKER_REF,
      attempts: this.context.bounds.creationPollAttempts,
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
      this.context.ports.refs.createCommitOnBase({
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
      this.context.ports.refs.updateRefWithLease(
        this.context.refPath,
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

    const body = appendAiAuditMetadata(
      `${prepared.body}\n\n${envelope.value}\n`,
      prepared.aiAudit,
    );
    if (body.isErr())
      return err({
        type: "ReleasePreparationFailed",
        stage: "changelog-ai",
        message: describeAiAuditError(body.error),
        retryable: false,
      });
    const opened = await settle(
      this.context.ports.pullRequests.createPullRequest({
        title: prepared.title,
        body: body.value,
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
    const open = await this.context.readOpenReleasePullRequest();
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
      request.reconcile === true
        ? this.context.bounds.reconciliationAttempts
        : 1;
    const head = await this.context.readMarker();
    if (head.isErr())
      return err(cleanupPending(ownership, "unverifiable-ownership"));
    if (head.value === null) {
      const absent = await this.context.reconcileOpenReleasePullRequest(
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
    const generation = await this.context.readMarkerGeneration(head.value);
    if (generation.isErr())
      return err(cleanupPending(ownership, "unverifiable-ownership"));
    if (generation.value === null)
      return err(cleanupPending(ownership, "unverifiable-ownership"));
    if (generation.value !== ownership.ownerGeneration)
      return err(cleanupPending(ownership, "ownership-changed"));

    const pullRequest = await this.context.reconcileOpenReleasePullRequest(
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
      this.context.ports.refs.deleteRefWithLease(
        this.context.refPath,
        ownership.expectedMarkerSha,
      ),
    );
    if (deleted.isErr())
      return err(cleanupPending(ownership, "cas-delete-failed"));
    return ok({ kind: "marker-deleted", ownership });
  }
  private async requireFreshTrunk(
    baseSha: string,
    ownership: ReleasePrOwnership,
  ): Promise<Result<string, ReleasePrError>> {
    const head = await this.context.readGreenMainHead();
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

  private async requireFreshTrunkOrCleanup(
    baseSha: string,
    ownership: ReleasePrOwnership,
  ): Promise<Result<string, ReleasePrError>> {
    const fresh = await this.requireFreshTrunk(baseSha, ownership);
    if (fresh.isOk()) return fresh;
    if (fresh.error.type === "PreparationStale") return fresh;
    return err(await this.failAfterOwnership(ownership, fresh.error));
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
