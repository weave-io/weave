/**
 * Focused regeneration/CAS convergence lifecycle for the stable release PR.
 *
 * This module owns the retry loop, monotonic freshness guard, and lease-loss
 * convergence. Metadata repair is an injected collaborator.
 */
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import {
  appendAiAuditMetadata,
  describeAiAuditError,
} from "./ai/audit-metadata.js";
import type { GitHubPullRequestSummary } from "./github-client.js";
import {
  cleanupPending,
  type DiscoveryRequest,
  describeError,
  fromAsync,
  parseReleasePrEnvelope,
  portFailure,
  prMetadataGaps,
  type RegenerationBuilder,
  type RegenerationOutcome,
  type ReleasePrBounds,
  type ReleasePrEnvelope,
  type ReleasePrError,
  type ReleasePrPorts,
  type ReleasePrState,
  renderReleasePrEnvelope,
  resolveRegeneratedEntries,
  settle,
  validatePreparedRelease,
} from "./release-pr-contract.js";
import type { ReleasePrMetadataPort } from "./release-pr-metadata.js";

export interface ReleasePrRegenerationContext {
  ports: ReleasePrPorts;
  bounds: ReleasePrBounds;
  refPath: string;
  sleep: (milliseconds: number) => Promise<void>;
  discover: (
    request: DiscoveryRequest,
  ) => ResultAsync<ReleasePrState, ReleasePrError>;
  readMarker: () => Promise<Result<string | null, ReleasePrError>>;
  readEnvelopeAt: (
    sha: string,
  ) => Promise<Result<ReleasePrEnvelope, ReleasePrError>>;
  readGreenMainHead: () => Promise<Result<string, ReleasePrError>>;
  pollForOpenReleasePullRequest: () => Promise<
    Result<GitHubPullRequestSummary | null, ReleasePrError>
  >;
  metadata: ReleasePrMetadataPort;
}

export class ReleasePrRegenerationLifecycle {
  constructor(private readonly context: ReleasePrRegenerationContext) {}

  regenerate(request: {
    builder: RegenerationBuilder;
  }): ResultAsync<RegenerationOutcome, ReleasePrError> {
    return fromAsync(() => this.runRegenerate(request.builder));
  }

  private async runRegenerate(
    builder: RegenerationBuilder,
  ): Promise<Result<RegenerationOutcome, ReleasePrError>> {
    const state = await this.context.discover({});
    if (state.isErr()) return err(state.error);
    const live = await this.resolveRegenerationTarget(state.value);
    if (live.isErr()) return err(live.error);
    if (live.value === null) return ok({ kind: "NoReleasePrToRegenerate" });
    let pullRequest = live.value;

    const markerSha = await this.context.readMarker();
    if (markerSha.isErr()) return err(markerSha.error);
    if (markerSha.value === null)
      return ok({ kind: "NoReleasePrToRegenerate" });
    let expectedHead = markerSha.value;

    for (
      let attempt = 1;
      attempt <= this.context.bounds.regenerationAttempts;
      attempt += 1
    ) {
      const envelope = await this.context.readEnvelopeAt(expectedHead);
      if (envelope.isErr()) return err(envelope.error);
      const head = await this.context.readGreenMainHead();
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
        ].slice(-this.context.bounds.auditTrail),
        entryProse: [...resolved.value.entryProse],
        evidenceDigest: resolved.value.evidenceDigest,
      });
      if (nextEnvelope.isErr()) return err(nextEnvelope.error);

      const commit = await settle(
        this.context.ports.refs.createCommitOnBase({
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
      const recheck = await this.context.readGreenMainHead();
      if (recheck.isErr()) return err(recheck.error);
      if (recheck.value !== baseSha) continue;

      const swapped = await settle(
        this.context.ports.refs.updateRefWithLease(
          this.context.refPath,
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
          const surviving = await this.context.readEnvelopeAt(
            rebased.value.head,
          );
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
      const body = appendAiAuditMetadata(
        `${rendered.value.body}\n\n${nextEnvelope.value}\n`,
        rendered.value.aiAudit,
      );
      if (body.isErr())
        return err({
          type: "ReleasePreparationFailed",
          stage: "changelog-ai",
          message: describeAiAuditError(body.error),
          retryable: false,
        });
      const published = await this.context.metadata.publishPullRequestMetadata({
        pullRequest,
        title: rendered.value.title,
        body: body.value,
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
      attempts: this.context.bounds.regenerationAttempts,
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
    const polled = await this.context.pollForOpenReleasePullRequest();
    if (polled.isErr()) return err(polled.error);
    if (polled.value !== null) return ok(polled.value);
    return err({
      type: "ReleasePrCreationStalled",
      ref: state.marker.ref,
      attempts: this.context.bounds.creationPollAttempts,
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
      this.context.ports.refs.compareCommits(
        candidateBaseSha,
        survivingBaseSha,
      ),
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
    const head = await this.context.readMarker();
    if (head.isErr()) return err(head.error);
    if (head.value === null) return ok({ outcome: null, head: null });
    const envelope = await this.context.readEnvelopeAt(head.value);
    if (envelope.isErr()) return err(envelope.error);
    const guard = await this.monotonicGuard(envelope.value.baseSha, baseSha);
    if (guard.isErr()) return err(guard.error);
    if (guard.value !== null)
      return ok({ outcome: guard.value, head: head.value });
    return ok({ outcome: null, head: head.value });
  }
  private async concludeSuperseded(
    pullRequest: GitHubPullRequestSummary,
    expectedHead: string,
    envelope: ReleasePrEnvelope,
    builder: RegenerationBuilder,
    outcome: Extract<RegenerationOutcome, { kind: "RegenerationSuperseded" }>,
  ): Promise<Result<RegenerationOutcome, ReleasePrError>> {
    const reconciled = await this.context.metadata.reconcilePullRequestMetadata(
      {
        pullRequest,
        expectedHead,
        envelope,
        builder,
      },
    );
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
}
