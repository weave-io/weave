/**
 * Focused PR metadata-reconciliation lifecycle.
 *
 * The marker envelope is authoritative. This module repairs title, body, and
 * labels only after each write is checked against the current marker.
 */
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { GitHubPullRequestSummary } from "./github-client.js";
import {
  describeError,
  fromAsync,
  type PrMetadataGap,
  prMetadataGaps,
  RELEASE_PR_LABEL,
  type RegenerationBuilder,
  type ReleasePrBounds,
  type ReleasePrEnvelope,
  type ReleasePrError,
  type ReleasePrPorts,
  releasePrEnvelopesMatch,
  renderReleasePrEnvelope,
  resolveRegeneratedEntries,
  settle,
} from "./release-pr-contract.js";

export interface ReleasePrMetadataContext {
  ports: ReleasePrPorts;
  bounds: ReleasePrBounds;
  sleep: (milliseconds: number) => Promise<void>;
  readMarker: () => Promise<Result<string | null, ReleasePrError>>;
  readEnvelopeAt: (
    sha: string,
  ) => Promise<Result<ReleasePrEnvelope, ReleasePrError>>;
}

export interface PublishedPrAuthority {
  markerSha: string;
  envelope: ReleasePrEnvelope;
}

export interface PublishedPrMetadata extends PublishedPrAuthority {
  pullRequest: GitHubPullRequestSummary;
  superseded: boolean;
}

interface PublishedPrTarget extends PublishedPrAuthority {
  title: string;
  body: string;
}

interface RenderedPrMetadata {
  title: string;
  body: string;
}

export interface ReconciledPrMetadata extends PublishedPrAuthority {
  repaired: boolean;
  pullRequest: GitHubPullRequestSummary;
  pending: readonly PrMetadataGap[];
}

export interface ReleasePrMetadataPort {
  reconcilePullRequestMetadata(input: {
    pullRequest: GitHubPullRequestSummary;
    expectedHead: string;
    envelope: ReleasePrEnvelope;
    builder: RegenerationBuilder;
  }): ResultAsync<ReconciledPrMetadata, ReleasePrError>;
  publishPullRequestMetadata(input: {
    pullRequest: GitHubPullRequestSummary;
    title: string;
    body: string;
    expected: ReleasePrEnvelope;
    expectedHead: string;
    builder: RegenerationBuilder;
    writeMetadata?: boolean;
  }): ResultAsync<PublishedPrMetadata, ReleasePrError>;
}

export class ReleasePrMetadataLifecycle implements ReleasePrMetadataPort {
  constructor(private readonly context: ReleasePrMetadataContext) {}

  reconcilePullRequestMetadata(input: {
    pullRequest: GitHubPullRequestSummary;
    expectedHead: string;
    envelope: ReleasePrEnvelope;
    builder: RegenerationBuilder;
  }): ResultAsync<ReconciledPrMetadata, ReleasePrError> {
    return fromAsync(() => this.runReconcilePullRequestMetadata(input));
  }

  publishPullRequestMetadata(input: {
    pullRequest: GitHubPullRequestSummary;
    title: string;
    body: string;
    expected: ReleasePrEnvelope;
    expectedHead: string;
    builder: RegenerationBuilder;
    writeMetadata?: boolean;
  }): ResultAsync<PublishedPrMetadata, ReleasePrError> {
    return fromAsync(() => this.runPublishPullRequestMetadata(input));
  }

  private async runReconcilePullRequestMetadata(input: {
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
    const published = await this.runPublishPullRequestMetadata({
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
  private async runPublishPullRequestMetadata(input: {
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
      attempt <= this.context.bounds.metadataRepairAttempts;
      attempt += 1
    ) {
      const before = await this.readAuthoritativePrMetadata(
        input.pullRequest.url,
      );
      if (before.isErr()) {
        lastError = before.error;
        if (attempt < this.context.bounds.metadataRepairAttempts)
          await this.context.sleep(this.context.bounds.pollDelayMs);
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
          this.context.ports.pullRequests.updatePullRequest({
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
          if (attempt < this.context.bounds.metadataRepairAttempts)
            await this.context.sleep(this.context.bounds.pollDelayMs);
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
          if (attempt < this.context.bounds.metadataRepairAttempts)
            await this.context.sleep(this.context.bounds.pollDelayMs);
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
          if (attempt < this.context.bounds.metadataRepairAttempts)
            await this.context.sleep(this.context.bounds.pollDelayMs);
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
          if (attempt < this.context.bounds.metadataRepairAttempts)
            await this.context.sleep(this.context.bounds.pollDelayMs);
          continue;
        }
        pullRequest = labeled.value;
        const afterLabel = await this.readAuthoritativePrMetadata(
          input.pullRequest.url,
        );
        if (afterLabel.isErr()) {
          lastError = afterLabel.error;
          if (attempt < this.context.bounds.metadataRepairAttempts)
            await this.context.sleep(this.context.bounds.pollDelayMs);
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
          if (attempt < this.context.bounds.metadataRepairAttempts)
            await this.context.sleep(this.context.bounds.pollDelayMs);
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
        if (attempt < this.context.bounds.metadataRepairAttempts)
          await this.context.sleep(this.context.bounds.pollDelayMs);
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
        if (attempt < this.context.bounds.metadataRepairAttempts)
          await this.context.sleep(this.context.bounds.pollDelayMs);
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
      if (attempt < this.context.bounds.metadataRepairAttempts)
        await this.context.sleep(this.context.bounds.pollDelayMs);
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
    const marker = await this.context.readMarker();
    if (marker.isErr()) return err(marker.error);
    if (marker.value === null)
      return err({
        type: "ReleasePrMetadataPending",
        url,
        pending: ["envelope"],
        message: "the authoritative release marker is absent",
      });
    const envelope = await this.context.readEnvelopeAt(marker.value);
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
      this.context.ports.pullRequests.addPullRequestLabels(pullRequest.number, [
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
}
