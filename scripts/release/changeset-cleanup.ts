/**
 * Post-publish changeset-cleanup PR: delete ledger-consumed files only.
 *
 * Consumption authority is the changelog ledger, so leftover `.changeset/*.md`
 * files are hygiene, not correctness. This module computes the files the
 * ledger already spent that are still on `main`, validates that the proposed
 * diff is deletion-only, and opens one App-token PR. A consumed file whose
 * bytes no longer match the ledger is typed `ConsumedChangesetModified` and
 * blocks the automatic PR. An empty set is a no-op.
 *
 * Call this only after a successful refs batch on a stable release. The
 * marker-ref lifecycle is independent and is never touched here.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import {
  type ChangesetConsumptionError,
  type ModifiedConsumedChangeset,
  subtractConsumedLedger,
} from "./changeset-consumption.js";
import type { ValidatedChangeset } from "./changeset-policy.js";
import type { ReleaseChannel } from "./constants.js";
import type { ConsumptionLedger } from "./consumption-ledger.js";
import type { GitHubError } from "./errors.js";
import type {
  GitHubPullRequestCreateInput,
  GitHubPullRequestSummary,
  GitHubPullRequestWriteError,
  GitHubRefWriteError,
} from "./github-client.js";
import {
  MAIN_BRANCH,
  RELEASE_CLEANUP_PR_LABEL,
  type ReleaseChange,
  type ReleasePrError,
  validateCleanupPrDiff,
} from "./release-pr-contract.js";

export const CHANGESET_CLEANUP_TITLE =
  "chore(release): remove consumed changesets" as const;
export const CHANGESET_CLEANUP_BRANCH_PREFIX = "changeset-cleanup" as const;

const FULL_SHA = /^[0-9a-f]{40}$/;
const CHANGESET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ChangesetCleanupError =
  | Extract<ChangesetConsumptionError, { type: "ConsumedChangesetModified" }>
  | ReleasePrError
  | { type: "InvalidCleanupReleasedSha"; sha: string }
  | { type: "InvalidConsumedChangesetPath"; path: string }
  | GitHubError
  | GitHubRefWriteError
  | GitHubPullRequestWriteError;

export interface ChangesetCleanupGitHub {
  readRefOptional(ref: string): ResultAsync<string | null, GitHubError>;
  createDeletionCommit(input: {
    baseSha: string;
    message: string;
    deletedPaths: readonly string[];
  }): ResultAsync<string, GitHubError>;
  createRefAtomic(
    ref: string,
    sha: string,
  ): ResultAsync<void, GitHubRefWriteError>;
  listOpenPullRequestsByLabel(
    label: string,
  ): ResultAsync<readonly GitHubPullRequestSummary[], GitHubError>;
  createPullRequest(
    input: GitHubPullRequestCreateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError>;
}

export interface ChangesetCleanupInput {
  channel: ReleaseChannel;
  releasedSha: string;
  /** Current `.changeset/*.md` files on `main`, already policy-validated. */
  changesets: readonly ValidatedChangeset[];
  ledger: ConsumptionLedger;
}

export interface ChangesetCleanupPlan {
  status: "ready";
  paths: readonly string[];
  changes: readonly ReleaseChange[];
}

export type ChangesetCleanupResult =
  | { status: "skipped"; reason: "not-stable" | "empty" }
  | {
      status: "existing";
      pullRequest: GitHubPullRequestSummary;
      paths: readonly string[];
    }
  | {
      status: "opened";
      pullRequest: GitHubPullRequestSummary;
      paths: readonly string[];
    };

/** Deterministic head ref for one released SHA's cleanup PR. */
export function changesetCleanupBranch(releasedSha: string): string {
  return `${CHANGESET_CLEANUP_BRANCH_PREFIX}/${releasedSha}`;
}

/** Ledger identity to the only path the cleanup surface may delete. */
export function consumedChangesetPath(id: string): string {
  return `.changeset/${id}.md`;
}

/**
 * Ledger-consumed files still present, as a deletion-only surface.
 *
 * Modified consumptions fail typed. An empty remainder is a no-op, not an
 * `EmptyReleaseDiff` — the validator rejects empty diffs, and that is the
 * wrong answer when there is nothing left to delete.
 */
export function planChangesetCleanup(input: {
  changesets: readonly ValidatedChangeset[];
  ledger: ConsumptionLedger;
}): Result<ChangesetCleanupPlan | { status: "empty" }, ChangesetCleanupError> {
  const set = subtractConsumedLedger({
    changesets: input.changesets,
    ledger: input.ledger,
  });
  if (set.modified.length > 0)
    return err({
      type: "ConsumedChangesetModified",
      changesets: set.modified,
    });
  const paths = uniqueSorted(
    set.consumedPresent.map((changeset) => changeset.path),
  );
  const invalid = paths.find((path) => !isCleanupPath(path));
  if (invalid !== undefined)
    return err({ type: "InvalidConsumedChangesetPath", path: invalid });
  if (paths.length === 0) return ok({ status: "empty" });
  const changes: readonly ReleaseChange[] = paths.map((path) => ({
    path,
    status: "removed",
  }));
  const surface = validateCleanupPrDiff({ changes, consumedPaths: paths });
  if (surface.isErr()) return err(surface.error);
  return ok({ status: "ready", paths, changes });
}

/** Opens one cleanup PR after refs, or reports the empty/existing no-op. */
export class ChangesetCleanupController {
  constructor(private readonly github: ChangesetCleanupGitHub) {}

  apply(
    input: ChangesetCleanupInput,
  ): ResultAsync<ChangesetCleanupResult, ChangesetCleanupError> {
    if (input.channel !== "stable")
      return okAsync({ status: "skipped", reason: "not-stable" });
    if (!FULL_SHA.test(input.releasedSha))
      return errAsync({
        type: "InvalidCleanupReleasedSha",
        sha: input.releasedSha,
      });
    const planned = planChangesetCleanup(input);
    if (planned.isErr()) return errAsync(planned.error);
    if (planned.value.status === "empty")
      return okAsync({ status: "skipped", reason: "empty" });
    return this.openOrReuse(input.releasedSha, planned.value);
  }

  private openOrReuse(
    releasedSha: string,
    plan: ChangesetCleanupPlan,
  ): ResultAsync<ChangesetCleanupResult, ChangesetCleanupError> {
    const headRef = changesetCleanupBranch(releasedSha);
    return this.github
      .listOpenPullRequestsByLabel(RELEASE_CLEANUP_PR_LABEL)
      .andThen((pulls) => {
        const existing = pulls.find((pull) => pull.headRef === headRef);
        if (existing !== undefined)
          return okAsync({
            status: "existing" as const,
            pullRequest: existing,
            paths: plan.paths,
          });
        return this.createPr(releasedSha, headRef, plan);
      });
  }

  private createPr(
    releasedSha: string,
    headRef: string,
    plan: ChangesetCleanupPlan,
  ): ResultAsync<ChangesetCleanupResult, ChangesetCleanupError> {
    const refPath = `refs/heads/${headRef}`;
    return this.github
      .readRefOptional(refPath)
      .andThen((existing) =>
        existing === null
          ? this.github
              .createDeletionCommit({
                baseSha: releasedSha,
                message: CHANGESET_CLEANUP_TITLE,
                deletedPaths: plan.paths,
              })
              .andThen((sha) =>
                this.github.createRefAtomic(refPath, sha).map(() => sha),
              )
          : okAsync(existing),
      )
      .andThen(() =>
        this.github.createPullRequest({
          title: CHANGESET_CLEANUP_TITLE,
          body: cleanupBody(plan.paths),
          headRef,
          baseRef: MAIN_BRANCH,
          labels: [RELEASE_CLEANUP_PR_LABEL],
        }),
      )
      .map((pullRequest) => ({
        status: "opened" as const,
        pullRequest,
        paths: plan.paths,
      }));
  }
}

function cleanupBody(paths: readonly string[]): string {
  const list = paths.map((path) => `- ${path}`).join("\n");
  return [
    "Delete changeset files the published consumption ledger already spent.",
    "",
    "The diff is deletions only. Pending changesets are untouched.",
    "",
    list,
    "",
  ].join("\n");
}

function uniqueSorted(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort((left, right) => {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

function isCleanupPath(path: string): boolean {
  if (!path.startsWith(".changeset/") || !path.endsWith(".md")) return false;
  const id = path.slice(".changeset/".length, -".md".length);
  return CHANGESET_ID.test(id);
}

export type { ModifiedConsumedChangeset };
