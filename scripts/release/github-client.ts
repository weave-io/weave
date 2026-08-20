import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { RELEASE_CONTROL_REF } from "./constants.js";
import type { GitHubError } from "./errors.js";

export interface WorkflowRunMetadata {
  repositoryId: number;
  id: number;
  runAttempt: number;
  event: string;
  headRef: string;
  headSha: string;
  conclusion: string | null;
  workflowPath: string;
  workflowSha: string;
}

/** A completed job is the live proof available while the containing run is active. */
export interface WorkflowJobMetadata {
  id: number;
  name: string;
  conclusion: string | null;
}

export interface ActionsArtifactMetadata {
  id: number;
  name: string;
  digest?: string;
  expired: boolean;
  sizeInBytes: number;
}

export interface GitHubClient {
  getWorkflowRun(runId: number): ResultAsync<WorkflowRunMetadata, GitHubError>;
  listWorkflowRunJobs?(
    runId: number,
  ): ResultAsync<readonly WorkflowJobMetadata[], GitHubError>;
  listRunArtifacts(
    runId: number,
  ): ResultAsync<readonly ActionsArtifactMetadata[], GitHubError>;
  getArtifact(
    artifactId: number,
  ): ResultAsync<ActionsArtifactMetadata, GitHubError>;
  downloadArtifact(artifactId: number): ResultAsync<Uint8Array, GitHubError>;
  createRelease(tag: string, name: string): ResultAsync<void, GitHubError>;
  createTag(tag: string, sha: string): ResultAsync<void, GitHubError>;
}

/** Privileged release-refs surface. It is intentionally separate from artifact readers. */
export interface GitHubRefClient {
  getRef(ref: string): ResultAsync<string, GitHubError>;
  createRef(ref: string, sha: string): ResultAsync<void, GitHubError>;
  deleteRef(ref: string): ResultAsync<void, GitHubError>;
  /** CAS is implemented by reading the ref then using GitHub's ordinary non-force update. */
  updateRef(
    ref: string,
    sha: string,
    expectedHeadSha: string,
  ): ResultAsync<void, GitHubError>;
  isMergedToMain(sha: string): ResultAsync<boolean, GitHubError>;
}

export interface GitHubReleaseAsset {
  id: number;
  name: string;
  size: number;
  digest?: string;
}
export interface GitHubRelease {
  id: number;
  tag: string;
  targetSha: string;
  notes: string;
  draft: boolean;
  immutable: boolean;
  assets: readonly GitHubReleaseAsset[];
}
/**
 * App-only release surface. It deliberately has no ref update/delete or release
 * update method: stable release references are create-once and published releases
 * are immutable inputs to verification, never mutation targets.
 */
export interface GitHubReleaseClient {
  getRef(ref: string): ResultAsync<string, GitHubError>;
  createRef(ref: string, sha: string): ResultAsync<void, GitHubError>;
  getRelease(tag: string): ResultAsync<GitHubRelease, GitHubError>;
  createDraftRelease(input: {
    tag: string;
    targetSha: string;
    name: string;
    notes: string;
  }): ResultAsync<GitHubRelease, GitHubError>;
  uploadReleaseAsset(
    releaseId: number,
    name: string,
    bytes: Uint8Array,
  ): ResultAsync<GitHubReleaseAsset, GitHubError>;
  deleteReleaseAsset(
    releaseId: number,
    assetId: number,
  ): ResultAsync<void, GitHubError>;
  publishRelease(releaseId: number): ResultAsync<GitHubRelease, GitHubError>;
  /** GitHub endpoint assumption: GET /releases/{id}/attestations returns attestations. */
  hasReleaseAttestation(releaseId: number): ResultAsync<boolean, GitHubError>;
  /** App-created lightweight refs are expected to be unsigned unless GitHub reports otherwise. */
  getTagVerification(
    tag: string,
  ): ResultAsync<"verified" | "unsigned", GitHubError>;
}

// ---------------------------------------------------------------------------
// Atomic marker-ref, pull-request, and team surfaces (Task 9)
// ---------------------------------------------------------------------------

/**
 * Ref writes the optimistic release-PR state machine must tell apart by type.
 *
 * `ReferenceAlreadyExists` is the losing side of the atomic `createRef` race —
 * a normal, expected outcome, never an incident — and `ReferenceLeaseLost` is
 * the compare-and-swap refusal that makes an older writer converge instead of
 * overwriting a newer one.
 */
export type GitHubRefWriteError =
  | GitHubError
  | { type: "ReferenceAlreadyExists"; ref: string }
  | {
      type: "ReferenceLeaseLost";
      ref: string;
      expectedSha: string;
      actualSha: string | null;
    };

/**
 * A create request whose outcome the client could not observe.
 *
 * A transport failure may still have created the pull request server-side, so
 * it is reported as ambiguous rather than as a definite failure: the caller
 * owes a bounded reconciliation query before it cleans anything up.
 */
export type GitHubPullRequestWriteError =
  | GitHubError
  | { type: "PullRequestWriteAmbiguous"; operation: string; message: string };

/** One file a generated commit writes, as UTF-8 text. */
export interface GitHubCommitFile {
  path: string;
  contents: string;
}

/** GitHub's comparison verdict, from the base's point of view. */
export type GitHubComparisonStatus =
  | "identical"
  | "ahead"
  | "behind"
  | "diverged";

export type GitHubPullRequestState = "open" | "closed";

/** What the release-PR manager needs to know about one pull request. */
export interface GitHubPullRequestSummary {
  number: number;
  url: string;
  state: GitHubPullRequestState;
  merged: boolean;
  /** GitHub's merge commit, when the pull request has merged. */
  mergeCommitSha?: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  title: string;
  body: string;
  labels: readonly string[];
}

export interface GitHubPullRequestCreateInput {
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  labels: readonly string[];
}

export interface GitHubPullRequestUpdateInput {
  number: number;
  title: string;
  body: string;
}

/**
 * The atomic ref surface the marker protocol is built on.
 *
 * Creation is atomic through GitHub's `createRef`, which fails closed for every
 * loser of the race. Update and delete are **server-atomic compare-and-swap**:
 * they run GitHub's GraphQL `updateRefs` mutation with `beforeOid` set to the
 * expected old SHA and `afterOid` set to the new SHA (or the all-zero OID for a
 * delete). The expected-old comparison happens on the server, inside the same
 * operation that moves the ref. A GitHub-only object created by
 * {@link createCommitOnBase} is already in that object store, so the swap does
 * not depend on a local git object database. A read-then-write pair would only
 * narrow the race window; this closes it, and `ReferenceLeaseLost` is returned
 * only for a rejection the server proved stale.
 */
export interface GitHubMarkerRefClient {
  /** The ref's head, or null when the ref does not exist. */
  readRefOptional(ref: string): ResultAsync<string | null, GitHubError>;
  /** Atomic: exactly one concurrent creator wins; the rest observe a conflict. */
  createRefAtomic(
    ref: string,
    sha: string,
  ): ResultAsync<void, GitHubRefWriteError>;
  updateRefWithLease(
    ref: string,
    sha: string,
    expectedSha: string,
  ): ResultAsync<void, GitHubRefWriteError>;
  deleteRefWithLease(
    ref: string,
    expectedSha: string,
  ): ResultAsync<void, GitHubRefWriteError>;
  /** Creates a commit on `baseSha`; with no files it reuses the base tree. */
  createCommitOnBase(input: {
    baseSha: string;
    message: string;
    files?: readonly GitHubCommitFile[];
  }): ResultAsync<string, GitHubError>;
  readCommitMessage(sha: string): ResultAsync<string, GitHubError>;
  compareCommits(
    base: string,
    head: string,
  ): ResultAsync<GitHubComparisonStatus, GitHubError>;
}

/** The live green trunk head every release generation binds itself to. */
export interface GitHubMainBranchClient {
  readGreenMainHead(): ResultAsync<string, GitHubError>;
}

/** Where a required trunk check is allowed to appear. */
export type GitHubRequiredCheckSource = "status" | "check-run" | "either";

/** One required check the trunk head must satisfy before it is green. */
export interface GitHubRequiredCheck {
  name: string;
  source?: GitHubRequiredCheckSource;
  /** Provider App ID when the check-run policy identifies one. */
  appId?: number;
}

/** Bounds so a green-head proof cannot walk GitHub without a stop. */
export const GREEN_MAIN_HEAD_BOUNDS = {
  pageSize: 100,
  maxPages: 3,
  requiredChecks: 32,
  checkNameLength: 256,
} as const;

export type GreenMainHeadBounds = {
  -readonly [Key in keyof typeof GREEN_MAIN_HEAD_BOUNDS]: number;
};

/** Bounds for every pull-request collection; Link pagination is fail-closed. */
export const PULL_REQUEST_BOUNDS = {
  pageSize: 100,
  maxPages: 3,
} as const;

export type PullRequestBounds = {
  -readonly [Key in keyof typeof PULL_REQUEST_BOUNDS]: number;
};

export interface GitHubRestClientOptions {
  /**
   * Precise required-check policy. When set, the client does not read branch
   * protection or rulesets; the caller already knows which checks must pass.
   */
  requiredChecks?: readonly GitHubRequiredCheck[];
  greenHeadBounds?: Partial<GreenMainHeadBounds>;
  pullRequestBounds?: Partial<PullRequestBounds>;
}

export interface GitHubPullRequestClient {
  listOpenPullRequestsByLabel(
    label: string,
  ): ResultAsync<readonly GitHubPullRequestSummary[], GitHubError>;
  /**
   * Pull requests opened from `headRef` in exactly `state`.
   *
   * GitHub's `head` filter is `<owner>:<ref>`. Cleanup must ask for `open`
   * here: a shared `state=all` newest-PR lookup can hide an older open PR
   * behind a newer closed one and authorize a delete under a live lock.
   */
  listPullRequestsForHead(
    headRef: string,
    state: GitHubPullRequestState,
  ): ResultAsync<readonly GitHubPullRequestSummary[], GitHubError>;
  createPullRequest(
    input: GitHubPullRequestCreateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError>;
  updatePullRequest(
    input: GitHubPullRequestUpdateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError>;
  addPullRequestLabels(
    number: number,
    labels: readonly string[],
  ): ResultAsync<readonly string[], GitHubPullRequestWriteError>;
}

/** Read-only org team membership: the authorization source for stable requests. */
export interface GitHubTeamClient {
  isTeamMember(input: {
    organization: string;
    teamSlug: string;
    login: string;
  }): ResultAsync<boolean, GitHubError>;
}

export type GitHubFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Minimal REST client; callers inject fetch in tests so no live GitHub is needed. */
export class GitHubRestClient
  implements
    GitHubClient,
    GitHubRefClient,
    GitHubReleaseClient,
    GitHubMarkerRefClient,
    GitHubMainBranchClient,
    GitHubPullRequestClient,
    GitHubTeamClient
{
  private cachedRepositoryId: string | undefined;
  private readonly greenHeadBounds: GreenMainHeadBounds;
  private readonly pullRequestBounds: PullRequestBounds;

  constructor(
    private readonly repository: string,
    private readonly token?: string,
    private readonly requestFetch: GitHubFetch = fetch,
    private readonly apiUrl = "https://api.github.com",
    private readonly options: GitHubRestClientOptions = {},
  ) {
    this.greenHeadBounds = {
      ...GREEN_MAIN_HEAD_BOUNDS,
      ...options.greenHeadBounds,
    };
    this.pullRequestBounds = {
      ...PULL_REQUEST_BOUNDS,
      ...options.pullRequestBounds,
    };
  }

  getWorkflowRun(runId: number): ResultAsync<WorkflowRunMetadata, GitHubError> {
    return this.requestJson(`/actions/runs/${runId}`).andThen((value) => {
      const run = parseWorkflowRun(value);
      if (run === undefined)
        return errAsync(invalidResponse(`/actions/runs/${runId}`));
      return okAsync(run);
    });
  }

  listWorkflowRunJobs(
    runId: number,
  ): ResultAsync<readonly WorkflowJobMetadata[], GitHubError> {
    return this.requestJson(`/actions/runs/${runId}/jobs`).andThen((value) => {
      if (!isRecord(value) || !Array.isArray(value.jobs))
        return errAsync(invalidResponse(`/actions/runs/${runId}/jobs`));
      const jobs = value.jobs.map(parseWorkflowJob);
      if (jobs.some((job) => job === undefined))
        return errAsync(invalidResponse(`/actions/runs/${runId}/jobs`));
      return okAsync(jobs as readonly WorkflowJobMetadata[]);
    });
  }

  listRunArtifacts(
    runId: number,
  ): ResultAsync<readonly ActionsArtifactMetadata[], GitHubError> {
    const path = `/actions/runs/${runId}/artifacts`;
    return this.requestJson(path).andThen((value) => {
      if (!isRecord(value) || !Array.isArray(value.artifacts))
        return errAsync(invalidResponse(path));
      const artifacts = value.artifacts.map(parseArtifact);
      if (artifacts.some((artifact) => artifact === undefined))
        return errAsync(invalidResponse(path));
      return okAsync(artifacts as ActionsArtifactMetadata[]);
    });
  }

  getArtifact(
    artifactId: number,
  ): ResultAsync<ActionsArtifactMetadata, GitHubError> {
    const path = `/actions/artifacts/${artifactId}`;
    return this.requestJson(path).andThen((value) => {
      const artifact = parseArtifact(value);
      if (artifact === undefined) return errAsync(invalidResponse(path));
      return okAsync(artifact);
    });
  }

  downloadArtifact(artifactId: number): ResultAsync<Uint8Array, GitHubError> {
    return this.request(`/actions/artifacts/${artifactId}/zip`).map(
      (response) => new Uint8Array(response),
    );
  }

  createRelease(tag: string, name: string): ResultAsync<void, GitHubError> {
    return this.request("/releases", {
      method: "POST",
      body: JSON.stringify({ tag_name: tag, name }),
    }).map(() => undefined);
  }

  createTag(tag: string, sha: string): ResultAsync<void, GitHubError> {
    return this.request("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
    }).map(() => undefined);
  }

  getRef(ref: string): ResultAsync<string, GitHubError> {
    const path = `/git/ref/${ref.replace(/^refs\//, "")}`;
    return this.requestJson(path).andThen((value) => {
      if (
        !isRecord(value) ||
        !isRecord(value.object) ||
        !isString(value.object.sha)
      )
        return errAsync(invalidResponse(path));
      return okAsync(value.object.sha);
    });
  }

  createRef(ref: string, sha: string): ResultAsync<void, GitHubError> {
    return this.request("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/${ref.replace(/^refs\//, "")}`, sha }),
    }).map(() => undefined);
  }
  deleteRef(ref: string): ResultAsync<void, GitHubError> {
    return this.request(`/git/refs/${ref.replace(/^refs\//, "")}`, {
      method: "DELETE",
    }).map(() => undefined);
  }

  updateRef(
    ref: string,
    sha: string,
    expectedHeadSha: string,
  ): ResultAsync<void, GitHubError> {
    return this.getRef(ref).andThen((current) => {
      if (current !== expectedHeadSha)
        return errAsync({
          type: "GitHubError" as const,
          operation: `CAS ${ref}`,
          message: `stale head: expected ${expectedHeadSha}, found ${current}`,
        });
      const path = `/git/refs/${ref.replace(/^refs\//, "")}`;
      // Deliberately omit `force`: GitHub defaults it to false, rejecting non-FF updates.
      return this.request(path, {
        method: "PATCH",
        body: JSON.stringify({ sha }),
      }).map(() => undefined);
    });
  }

  isMergedToMain(sha: string): ResultAsync<boolean, GitHubError> {
    const path = `/compare/${sha}...main`;
    return this.requestJson(path).andThen((value) => {
      if (!isRecord(value) || !isString(value.status))
        return errAsync(invalidResponse(path));
      return okAsync(value.status === "identical" || value.status === "behind");
    });
  }

  readRefOptional(ref: string): ResultAsync<string | null, GitHubError> {
    return this.getRef(ref)
      .map((sha): string | null => sha)
      .orElse((error) =>
        error.status === 404
          ? okAsync<string | null, GitHubError>(null)
          : errAsync<string | null, GitHubError>(error),
      );
  }

  createRefAtomic(
    ref: string,
    sha: string,
  ): ResultAsync<void, GitHubRefWriteError> {
    return this.request("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/${stripRefPrefix(ref)}`, sha }),
    })
      .map(() => undefined)
      .mapErr(
        (error): GitHubRefWriteError =>
          error.status === 422
            ? { type: "ReferenceAlreadyExists", ref }
            : error,
      );
  }

  /**
   * Moves the ref to `sha` only if the remote still has `expectedSha`.
   *
   * The comparison happens on the server, inside the same `updateRefs`
   * mutation that moves the ref, so no concurrent writer can slip between a
   * check and a write. `sha` is a GitHub object id — typically the result of
   * {@link createCommitOnBase} — and does not need to exist in a local git
   * object database.
   */
  updateRefWithLease(
    ref: string,
    sha: string,
    expectedSha: string,
  ): ResultAsync<void, GitHubRefWriteError> {
    return this.swapRefWithLease("updateRefWithLease", ref, expectedSha, sha);
  }

  /** Deletes the ref only if the remote still has `expectedSha`. */
  deleteRefWithLease(
    ref: string,
    expectedSha: string,
  ): ResultAsync<void, GitHubRefWriteError> {
    return this.swapRefWithLease("deleteRefWithLease", ref, expectedSha, null);
  }

  /**
   * Server-atomic expected-old-SHA compare-and-swap via GraphQL `updateRefs`.
   *
   * `source` is the new object for an update and `null` for a delete (the
   * all-zero OID). Only a rejection the server itself reported as an expected
   * current-OID mismatch that names this exact `expectedSha` becomes
   * `ReferenceLeaseLost`; every other failure stays a plain GitHub error, so
   * a permission, missing-object, generic mismatch, or network fault is never
   * mistaken for a lost race.
   */
  private swapRefWithLease(
    operation: string,
    ref: string,
    expectedSha: string,
    source: string | null,
  ): ResultAsync<void, GitHubRefWriteError> {
    const rejected = validateLeaseInputs(ref, expectedSha, source);
    if (rejected !== undefined)
      return errAsync<void, GitHubRefWriteError>({
        type: "GitHubError",
        operation,
        message: rejected,
      });
    return this.repositoryGraphId()
      .mapErr((error): GitHubRefWriteError => error)
      .andThen((repositoryId) =>
        this.requestGraphql(UPDATE_REFS_MUTATION, {
          input: {
            repositoryId,
            refUpdates: [
              {
                name: ref,
                afterOid: source ?? ZERO_GIT_OID,
                beforeOid: expectedSha,
                force: true,
              },
            ],
          },
        }),
      )
      .andThen((payload) => {
        const errors = payload.errors;
        if (errors !== undefined && errors.length > 0) {
          const lost = leaseLostFromGraphql(errors, ref, expectedSha);
          if (lost !== undefined)
            return errAsync<void, GitHubRefWriteError>(lost);
          return errAsync<void, GitHubRefWriteError>({
            type: "GitHubError",
            operation,
            message: graphqlErrorMessage(errors),
          });
        }
        if (!isRecord(payload.data) || payload.data.updateRefs == null)
          return errAsync<void, GitHubRefWriteError>({
            type: "GitHubError",
            operation,
            message: "invalid GitHub GraphQL response",
          });
        return okAsync<void, GitHubRefWriteError>(undefined);
      });
  }

  private repositoryGraphId(): ResultAsync<string, GitHubError> {
    if (this.cachedRepositoryId !== undefined)
      return okAsync(this.cachedRepositoryId);
    const path = `/repos/${this.repository}`;
    return this.requestAbsoluteJson(`${this.apiUrl}${path}`, {
      method: "GET",
    }).andThen((value) => {
      if (!isRecord(value) || !isString(value.node_id) || value.node_id === "")
        return errAsync(invalidResponse(path));
      this.cachedRepositoryId = value.node_id;
      return okAsync(value.node_id);
    });
  }

  private requestGraphql(
    query: string,
    variables: Record<string, unknown>,
  ): ResultAsync<GraphqlPayload, GitHubError> {
    const url = `${this.apiUrl}/graphql`;
    return this.requestAbsoluteJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }).andThen((value) => {
      if (!isRecord(value)) return errAsync(invalidResponse(url));
      const errors = value.errors;
      if (errors !== undefined && !Array.isArray(errors))
        return errAsync(invalidResponse(url));
      return okAsync({
        data: value.data,
        errors: errors as readonly unknown[] | undefined,
      });
    });
  }

  createCommitOnBase(input: {
    baseSha: string;
    message: string;
    files?: readonly GitHubCommitFile[];
  }): ResultAsync<string, GitHubError> {
    return this.readCommitTree(input.baseSha)
      .andThen((baseTree) => this.buildTree(baseTree, input.files ?? []))
      .andThen((tree) =>
        this.requestJsonWithInit("/git/commits", {
          method: "POST",
          body: JSON.stringify({
            message: input.message,
            tree,
            parents: [input.baseSha],
          }),
        }),
      )
      .andThen((value) => {
        if (!isRecord(value) || !isString(value.sha))
          return errAsync(invalidResponse("/git/commits"));
        return okAsync(value.sha);
      });
  }

  readCommitMessage(sha: string): ResultAsync<string, GitHubError> {
    const path = `/git/commits/${sha}`;
    return this.requestJson(path).andThen((value) => {
      if (!isRecord(value) || !isString(value.message))
        return errAsync(invalidResponse(path));
      return okAsync(value.message);
    });
  }

  compareCommits(
    base: string,
    head: string,
  ): ResultAsync<GitHubComparisonStatus, GitHubError> {
    const path = `/compare/${base}...${head}`;
    return this.requestJson(path).andThen((value) => {
      if (!isRecord(value) || !isComparisonStatus(value.status))
        return errAsync(invalidResponse(path));
      return okAsync(value.status);
    });
  }

  /**
   * The trunk head, and proof that every required check is green.
   *
   * Combined commit status is not enough: GitHub Actions check runs never
   * appear there. The proof reads the required-check policy (injected, or
   * branch protection plus rulesets), then both legacy statuses and Actions
   * check runs. A missing, pending, failing, unknown, or truncated reading
   * is a typed refusal rather than a SHA.
   */
  readGreenMainHead(): ResultAsync<string, GitHubError> {
    return this.getRef(RELEASE_CONTROL_REF).andThen((sha) =>
      this.readRequiredChecks().andThen((required) =>
        this.proveRequiredChecksGreen(sha, required).map(() => sha),
      ),
    );
  }

  listOpenPullRequestsByLabel(
    label: string,
  ): ResultAsync<readonly GitHubPullRequestSummary[], GitHubError> {
    const path = `/pulls?state=open&per_page=${this.pullRequestBounds.pageSize}`;
    return this.collectPages(
      path,
      (value, pagePath) => parsePullRequestPage(value, pagePath),
      this.pullRequestBounds,
    ).map((pulls) => pulls.filter((pull) => pull.labels.includes(label)));
  }

  /**
   * Pull requests opened from `headRef` in exactly `state`.
   *
   * GitHub's `head` filter is matched as `<owner>:<ref>`; a bare ref name
   * silently matches nothing, which would report a live release PR as absent.
   * The client-side head and state filters stay as defence in depth. The
   * caller, not this method, decides what "associated" means.
   */
  listPullRequestsForHead(
    headRef: string,
    state: GitHubPullRequestState,
  ): ResultAsync<readonly GitHubPullRequestSummary[], GitHubError> {
    const owner = this.repository.split("/")[0] ?? "";
    const path = `/pulls?state=${encodeURIComponent(state)}&per_page=${this.pullRequestBounds.pageSize}&head=${encodeURIComponent(`${owner}:${headRef}`)}`;
    return this.collectPages(
      path,
      (value, pagePath) => parsePullRequestPage(value, pagePath),
      this.pullRequestBounds,
    ).map((pulls) =>
      pulls.filter((pull) => pull.headRef === headRef && pull.state === state),
    );
  }

  createPullRequest(
    input: GitHubPullRequestCreateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError> {
    return this.requestJsonWithInit("/pulls", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.headRef,
        base: input.baseRef,
      }),
    })
      .mapErr(toPullRequestWriteError("createPullRequest"))
      .andThen((value) => {
        const pull = parsePullRequest(value);
        if (pull === undefined)
          return errAsync<
            GitHubPullRequestSummary,
            GitHubPullRequestWriteError
          >(
            ambiguousPullRequestWrite(
              "createPullRequest",
              "created pull request could not be parsed",
            ),
          );
        return this.addLabels(pull, input.labels).orElse((error) =>
          errAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError>(
            ambiguousPullRequestWrite("addLabels", error.message),
          ),
        );
      });
  }

  updatePullRequest(
    input: GitHubPullRequestUpdateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError> {
    const path = `/pulls/${input.number}`;
    return this.requestJsonWithInit(path, {
      method: "PATCH",
      body: JSON.stringify({ title: input.title, body: input.body }),
    })
      .mapErr(toPullRequestWriteError("updatePullRequest"))
      .andThen((value) => {
        const pull = parsePullRequest(value);
        return pull === undefined
          ? errAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError>(
              invalidResponse(path),
            )
          : okAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError>(
              pull,
            );
      });
  }

  addPullRequestLabels(
    number: number,
    labels: readonly string[],
  ): ResultAsync<readonly string[], GitHubPullRequestWriteError> {
    if (labels.length === 0)
      return okAsync<readonly string[], GitHubPullRequestWriteError>([]);
    return this.requestJsonWithInit(`/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [...labels] }),
    })
      .mapErr(toPullRequestWriteError("addLabels"))
      .andThen((value) => {
        const names = parseLabelNames(value);
        return names === undefined
          ? errAsync<readonly string[], GitHubPullRequestWriteError>(
              invalidResponse(`/issues/${number}/labels`),
            )
          : okAsync<readonly string[], GitHubPullRequestWriteError>(names);
      });
  }

  isTeamMember(input: {
    organization: string;
    teamSlug: string;
    login: string;
  }): ResultAsync<boolean, GitHubError> {
    const url = `${this.apiUrl}/orgs/${encodeURIComponent(input.organization)}/teams/${encodeURIComponent(input.teamSlug)}/memberships/${encodeURIComponent(input.login)}`;
    return this.requestAbsoluteJson(url, { method: "GET" })
      .map((value) => isRecord(value) && value.state === "active")
      .orElse((error) =>
        error.status === 404
          ? okAsync<boolean, GitHubError>(false)
          : errAsync<boolean, GitHubError>(error),
      );
  }

  private addLabels(
    pull: GitHubPullRequestSummary,
    labels: readonly string[],
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError> {
    return this.addPullRequestLabels(pull.number, labels).map((names) => ({
      ...pull,
      labels: names.length === 0 ? pull.labels : names,
    }));
  }

  private readCommitTree(sha: string): ResultAsync<string, GitHubError> {
    const path = `/git/commits/${sha}`;
    return this.requestJson(path).andThen((value) => {
      if (
        !isRecord(value) ||
        !isRecord(value.tree) ||
        !isString(value.tree.sha)
      )
        return errAsync(invalidResponse(path));
      return okAsync(value.tree.sha);
    });
  }

  private buildTree(
    baseTree: string,
    files: readonly GitHubCommitFile[],
  ): ResultAsync<string, GitHubError> {
    if (files.length === 0) return okAsync(baseTree);
    return this.requestJsonWithInit("/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTree,
        tree: files.map((file) => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          content: file.contents,
        })),
      }),
    }).andThen((value) => {
      if (!isRecord(value) || !isString(value.sha))
        return errAsync(invalidResponse("/git/trees"));
      return okAsync(value.sha);
    });
  }

  getRelease(tag: string): ResultAsync<GitHubRelease, GitHubError> {
    const path = `/releases/tags/${encodeURIComponent(tag)}`;
    return this.requestJson(path).andThen((value) => {
      const release = parseRelease(value);
      return release === undefined
        ? errAsync(invalidResponse(path))
        : okAsync(release);
    });
  }

  createDraftRelease(input: {
    tag: string;
    targetSha: string;
    name: string;
    notes: string;
  }): ResultAsync<GitHubRelease, GitHubError> {
    return this.requestJsonWithInit("/releases", {
      method: "POST",
      body: JSON.stringify({
        tag_name: input.tag,
        target_commitish: input.targetSha,
        name: input.name,
        body: input.notes,
        draft: true,
      }),
    }).andThen((value) => {
      const release = parseRelease(value);
      return release === undefined
        ? errAsync(invalidResponse("/releases"))
        : okAsync(release);
    });
  }

  uploadReleaseAsset(
    releaseId: number,
    name: string,
    bytes: Uint8Array,
  ): ResultAsync<GitHubReleaseAsset, GitHubError> {
    const url = `${this.apiUrl}/repos/${this.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    return this.requestAbsoluteJson(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes as unknown as BodyInit,
    }).andThen((value) => {
      const asset = parseReleaseAsset(value);
      return asset === undefined
        ? errAsync(invalidResponse(`/releases/${releaseId}/assets`))
        : okAsync(asset);
    });
  }

  deleteReleaseAsset(
    releaseId: number,
    assetId: number,
  ): ResultAsync<void, GitHubError> {
    return this.request(`/releases/${releaseId}/assets/${assetId}`, {
      method: "DELETE",
    }).map(() => undefined);
  }

  publishRelease(releaseId: number): ResultAsync<GitHubRelease, GitHubError> {
    const path = `/releases/${releaseId}`;
    return this.requestJsonWithInit(path, {
      method: "PATCH",
      body: JSON.stringify({ draft: false }),
    }).andThen((value) => {
      const release = parseRelease(value);
      return release === undefined
        ? errAsync(invalidResponse(path))
        : okAsync(release);
    });
  }

  hasReleaseAttestation(releaseId: number): ResultAsync<boolean, GitHubError> {
    const path = `/releases/${releaseId}/attestations`;
    return this.requestJson(path).andThen((value) => {
      if (!isRecord(value) || !Array.isArray(value.attestations))
        return errAsync(invalidResponse(path));
      return okAsync(value.attestations.length > 0);
    });
  }

  getTagVerification(
    _tag: string,
  ): ResultAsync<"verified" | "unsigned", GitHubError> {
    // The refs API creates lightweight tags and does not expose a verification object.
    return okAsync("unsigned");
  }

  private readRequiredChecks(): ResultAsync<
    readonly RequiredCheck[],
    GitHubError
  > {
    if (this.options.requiredChecks !== undefined)
      return normalizeRequiredChecks(
        this.options.requiredChecks,
        "requiredChecks",
        this.greenHeadBounds,
      );
    return this.readProtectionChecks().andThen((protection) =>
      this.readRuleChecks().andThen((rules) =>
        mergeRequiredChecks(
          [...protection, ...rules],
          "required-status-checks",
          this.greenHeadBounds,
        ),
      ),
    );
  }

  private readProtectionChecks(): ResultAsync<
    readonly RequiredCheck[],
    GitHubError
  > {
    const path = `/branches/${mainBranchName()}/protection/required_status_checks`;
    return this.requestJson(path)
      .andThen((value) =>
        parseProtectionChecks(value, path, this.greenHeadBounds),
      )
      .orElse((error) =>
        error.status === 404
          ? okAsync<readonly RequiredCheck[], GitHubError>([])
          : errAsync<readonly RequiredCheck[], GitHubError>(error),
      );
  }

  private readRuleChecks(): ResultAsync<readonly RequiredCheck[], GitHubError> {
    const path = `/rules/branches/${mainBranchName()}`;
    return this.requestJson(path)
      .andThen((value) => parseRuleChecks(value, path, this.greenHeadBounds))
      .orElse((error) =>
        error.status === 404
          ? okAsync<readonly RequiredCheck[], GitHubError>([])
          : errAsync<readonly RequiredCheck[], GitHubError>(error),
      );
  }

  private proveRequiredChecksGreen(
    sha: string,
    required: readonly RequiredCheck[],
  ): ResultAsync<void, GitHubError> {
    return this.listCommitStatuses(sha).andThen((statuses) =>
      this.listCheckRuns(sha).andThen((runs) => {
        for (const check of required) {
          const proved = proveOneRequiredCheck(sha, check, statuses, runs);
          if (proved.isErr()) return errAsync<void, GitHubError>(proved.error);
        }
        return okAsync<void, GitHubError>(undefined);
      }),
    );
  }

  private listCommitStatuses(
    sha: string,
  ): ResultAsync<readonly CommitStatusReading[], GitHubError> {
    const path = `/commits/${sha}/statuses?per_page=${this.greenHeadBounds.pageSize}`;
    return this.collectPages(path, (value, pagePath) =>
      parseCommitStatusPage(value, pagePath),
    ).map(latestCommitStatuses);
  }

  private listCheckRuns(
    sha: string,
  ): ResultAsync<readonly CheckRunReading[], GitHubError> {
    const path = `/commits/${sha}/check-runs?per_page=${this.greenHeadBounds.pageSize}&filter=latest`;
    return this.collectPages(path, (value, pagePath) =>
      parseCheckRunPage(value, pagePath),
    ).map(latestCheckRuns);
  }

  private collectPages<T>(
    startPath: string,
    parsePage: (
      value: unknown,
      path: string,
    ) => Result<{ items: readonly T[]; totalCount?: number }, GitHubError>,
    bounds: { maxPages: number } = this.greenHeadBounds,
  ): ResultAsync<readonly T[], GitHubError> {
    return fromAsync(async () => {
      const startUrl = this.repoUrl(startPath);
      const initialUrl = parsePaginationUrl(startUrl, startUrl);
      if (initialUrl.isErr()) return err(initialUrl.error);
      const collected: T[] = [];
      let url: string | null = startUrl;
      for (let page = 1; page <= bounds.maxPages; page += 1) {
        if (url === null) break;
        const pageDocument: Result<
          { value: unknown; nextUrl: string | null },
          GitHubError
        > = await settle(this.requestJsonDocument(url));
        if (pageDocument.isErr()) return err(pageDocument.error);
        const parsed = parsePage(pageDocument.value.value, url);
        if (parsed.isErr()) return err(parsed.error);
        collected.push(...parsed.value.items);
        if (
          parsed.value.totalCount !== undefined &&
          parsed.value.totalCount > collected.length &&
          pageDocument.value.nextUrl === null
        )
          return err(
            truncatedResponse(
              url,
              `reported ${parsed.value.totalCount} items but only ${collected.length} were returned`,
            ),
          );
        if (pageDocument.value.nextUrl !== null) {
          const next = validatePaginationContinuation(
            pageDocument.value.nextUrl,
            initialUrl.value,
            url,
            page,
          );
          if (next.isErr()) return err(next.error);
          url = next.value;
        } else {
          url = null;
        }
        if (url !== null && page === bounds.maxPages)
          return err(
            truncatedResponse(url, `exceeded ${bounds.maxPages} pages`),
          );
      }
      return ok(collected);
    });
  }

  private requestJsonDocument(
    url: string,
  ): ResultAsync<{ value: unknown; nextUrl: string | null }, GitHubError> {
    const headers = new Headers();
    headers.set("accept", "application/vnd.github+json");
    if (this.token !== undefined)
      headers.set("authorization", `Bearer ${this.token}`);
    return ResultAsync.fromPromise(
      this.requestFetch(url, { method: "GET", headers }),
      (cause) => ({
        type: "GitHubError" as const,
        operation: url,
        message: String(cause),
      }),
    ).andThen((response) => {
      if (!response.ok)
        return errAsync<
          {
            value: unknown;
            nextUrl: string | null;
          },
          GitHubError
        >({
          type: "GitHubError",
          operation: url,
          status: response.status,
          message: response.statusText,
        });
      return ResultAsync.fromThrowable(
        () => response.json(),
        () => invalidResponse(url),
      )().andThen((value) => {
        const next = nextLink(response.headers.get("link"), url);
        if (next.isErr())
          return errAsync<
            { value: unknown; nextUrl: string | null },
            GitHubError
          >(next.error);
        return okAsync({ value, nextUrl: next.value });
      });
    });
  }

  private repoUrl(path: string): string {
    return `${this.apiUrl}/repos/${this.repository}${path}`;
  }

  private requestJson(path: string): ResultAsync<unknown, GitHubError> {
    return this.request(path).andThen((response) =>
      ResultAsync.fromThrowable(
        () => Promise.resolve(JSON.parse(new TextDecoder().decode(response))),
        () => invalidResponse(path),
      )(),
    );
  }

  private requestJsonWithInit(
    path: string,
    init: RequestInit,
  ): ResultAsync<unknown, GitHubError> {
    return this.request(path, init).andThen((response) =>
      ResultAsync.fromThrowable(
        () => Promise.resolve(JSON.parse(new TextDecoder().decode(response))),
        () => invalidResponse(path),
      )(),
    );
  }
  private requestAbsoluteJson(
    url: string,
    init: RequestInit,
  ): ResultAsync<unknown, GitHubError> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    if (this.token !== undefined)
      headers.set("authorization", `Bearer ${this.token}`);
    return ResultAsync.fromPromise(
      this.requestFetch(url, { ...init, headers }),
      (cause) => ({
        type: "GitHubError" as const,
        operation: url,
        message: String(cause),
      }),
    ).andThen((response) =>
      response.ok
        ? ResultAsync.fromThrowable(
            () => response.json(),
            () => invalidResponse(url),
          )()
        : errAsync({
            type: "GitHubError" as const,
            operation: url,
            status: response.status,
            message: response.statusText,
          }),
    );
  }

  private request(
    path: string,
    init?: RequestInit,
  ): ResultAsync<ArrayBuffer, GitHubError> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/vnd.github+json");
    if (this.token !== undefined)
      headers.set("authorization", `Bearer ${this.token}`);
    return ResultAsync.fromPromise(
      this.requestFetch(`${this.apiUrl}/repos/${this.repository}${path}`, {
        ...init,
        headers,
      }),
      (cause) => ({
        type: "GitHubError" as const,
        operation: path,
        message: String(cause),
      }),
    ).andThen((response) =>
      response.ok
        ? ResultAsync.fromPromise(response.arrayBuffer(), (cause) => ({
            type: "GitHubError" as const,
            operation: path,
            message: String(cause),
          }))
        : errAsync({
            type: "GitHubError" as const,
            operation: path,
            status: response.status,
            message: response.statusText,
          }),
    );
  }
}

function parseWorkflowRun(value: unknown): WorkflowRunMetadata | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.repository) ||
    typeof value.path !== "string"
  )
    return undefined;
  const separator = value.path.lastIndexOf("@");
  if (separator <= 0) return undefined;
  if (
    !isPositiveInt(value.repository.id) ||
    !isPositiveInt(value.id) ||
    !isPositiveInt(value.run_attempt)
  )
    return undefined;
  if (
    !isString(value.event) ||
    !isString(value.head_branch) ||
    !isString(value.head_sha) ||
    (value.conclusion !== null && !isString(value.conclusion))
  )
    return undefined;
  return {
    repositoryId: value.repository.id,
    id: value.id,
    runAttempt: value.run_attempt,
    event: value.event,
    headRef: value.head_branch,
    headSha: value.head_sha,
    conclusion: value.conclusion,
    workflowPath: value.path.slice(0, separator),
    workflowSha: value.path.slice(separator + 1),
  };
}

function parseWorkflowJob(value: unknown): WorkflowJobMetadata | undefined {
  if (!isRecord(value) || !isPositiveInt(value.id) || !isString(value.name))
    return undefined;
  if (value.conclusion !== null && !isString(value.conclusion))
    return undefined;
  return { id: value.id, name: value.name, conclusion: value.conclusion };
}

function parseArtifact(value: unknown): ActionsArtifactMetadata | undefined {
  if (
    !isRecord(value) ||
    !isPositiveInt(value.id) ||
    !isString(value.name) ||
    typeof value.expired !== "boolean" ||
    !isPositiveInt(value.size_in_bytes)
  )
    return undefined;
  if (value.digest !== undefined && !isString(value.digest)) return undefined;
  return {
    id: value.id,
    name: value.name,
    digest: value.digest,
    expired: value.expired,
    sizeInBytes: value.size_in_bytes,
  };
}
function parseRelease(value: unknown): GitHubRelease | undefined {
  if (
    !isRecord(value) ||
    !isPositiveInt(value.id) ||
    !isString(value.tag_name) ||
    !isString(value.target_commitish) ||
    !isString(value.body) ||
    typeof value.draft !== "boolean" ||
    typeof value.immutable !== "boolean" ||
    !Array.isArray(value.assets)
  )
    return undefined;
  const assets = value.assets.map(parseReleaseAsset);
  if (assets.some((asset) => asset === undefined)) return undefined;
  return {
    id: value.id,
    tag: value.tag_name,
    targetSha: value.target_commitish,
    notes: value.body,
    draft: value.draft,
    immutable: value.immutable,
    assets: assets as GitHubReleaseAsset[],
  };
}
function parseReleaseAsset(value: unknown): GitHubReleaseAsset | undefined {
  if (
    !isRecord(value) ||
    !isPositiveInt(value.id) ||
    !isString(value.name) ||
    !isPositiveInt(value.size)
  )
    return undefined;
  if (value.digest !== undefined && !isString(value.digest)) return undefined;
  return {
    id: value.id,
    name: value.name,
    size: value.size,
    digest: value.digest,
  };
}

function parsePullRequestPage(
  value: unknown,
  operation: string,
): Result<{ items: readonly GitHubPullRequestSummary[] }, GitHubError> {
  if (!Array.isArray(value)) return err(invalidResponse(operation));
  const pulls = value.map(parsePullRequest);
  if (pulls.some((pull) => pull === undefined))
    return err(invalidResponse(operation));
  return ok({ items: pulls as readonly GitHubPullRequestSummary[] });
}

function parsePullRequest(
  value: unknown,
): GitHubPullRequestSummary | undefined {
  if (
    !isRecord(value) ||
    !isPositiveInt(value.number) ||
    !isString(value.html_url) ||
    !isString(value.title) ||
    !isRecord(value.head) ||
    !isString(value.head.ref) ||
    !isString(value.head.sha) ||
    !isRecord(value.base) ||
    !isString(value.base.ref)
  )
    return undefined;
  if (value.state !== "open" && value.state !== "closed") return undefined;
  const labels = Array.isArray(value.labels)
    ? value.labels.map((label) =>
        isRecord(label) && isString(label.name) ? label.name : undefined,
      )
    : [];
  if (labels.some((label) => label === undefined)) return undefined;
  if (
    value.merge_commit_sha !== undefined &&
    value.merge_commit_sha !== null &&
    !isString(value.merge_commit_sha)
  )
    return undefined;
  let mergeCommitSha: string | null | undefined;
  if (isString(value.merge_commit_sha)) mergeCommitSha = value.merge_commit_sha;
  else if (value.merge_commit_sha === null) mergeCommitSha = null;
  return {
    number: value.number,
    url: value.html_url,
    state: value.state,
    merged: value.merged === true || isString(value.merged_at),
    mergeCommitSha,
    headRef: value.head.ref,
    headSha: value.head.sha,
    baseRef: value.base.ref,
    title: value.title,
    body: isString(value.body) ? value.body : "",
    labels: labels as string[],
  };
}

function toPullRequestWriteError(
  operation: string,
): (error: GitHubError) => GitHubPullRequestWriteError {
  // A response the client never saw may still have been applied server-side.
  return (error) =>
    error.status === undefined
      ? ambiguousPullRequestWrite(operation, error.message)
      : error;
}

function ambiguousPullRequestWrite(
  operation: string,
  message: string,
): GitHubPullRequestWriteError {
  return { type: "PullRequestWriteAmbiguous", operation, message };
}

function stripRefPrefix(ref: string): string {
  return ref.replace(/^refs\//, "");
}

const ZERO_GIT_OID = "0".repeat(40);
const FULL_BRANCH_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const GIT_OBJECT_SHA = /^[0-9a-f]{40}$/;
const UPDATE_REFS_MUTATION = `mutation UpdateRefWithLease($input: UpdateRefsInput!) {
  updateRefs(input: $input) {
    clientMutationId
  }
}`;

interface GraphqlPayload {
  data?: unknown;
  errors?: readonly unknown[];
}

/**
 * Every value that reaches the GraphQL mutation, checked before any request.
 *
 * A rejected value never becomes a network call, so a malformed ref or SHA
 * cannot be confused with a server-side lease loss.
 */
function validateLeaseInputs(
  ref: string,
  expectedSha: string,
  source: string | null,
): string | undefined {
  if (!FULL_BRANCH_REF.test(ref) || ref.includes("..") || ref.includes("//"))
    return `ref must be a full branch ref, got ${ref}`;
  if (ref.endsWith(".lock") || ref.endsWith("/"))
    return `ref must not be a lock or directory path, got ${ref}`;
  if (!isGitObjectSha(expectedSha))
    return `expectedSha must be a full object SHA, got ${expectedSha}`;
  if (source !== null && !isGitObjectSha(source))
    return `sha must be a full object SHA, got ${source}`;
  return undefined;
}

function isGitObjectSha(value: string): boolean {
  return GIT_OBJECT_SHA.test(value) && value !== ZERO_GIT_OID;
}

/**
 * True only when the server itself rejected this exact expected oid.
 *
 * Generic update failures — including “does not match expected value” — stay
 * untyped-as-lease so a caller cannot converge on a writer that never existed.
 */
function leaseLostFromGraphql(
  errors: readonly unknown[],
  ref: string,
  expectedSha: string,
): Extract<GitHubRefWriteError, { type: "ReferenceLeaseLost" }> | undefined {
  for (const error of errors) {
    if (!isRecord(error) || !isString(error.message)) continue;
    if (!isExpectedOidMismatch(error.message, expectedSha)) continue;
    return {
      type: "ReferenceLeaseLost",
      ref,
      expectedSha,
      actualSha: actualShaFromMismatch(error.message),
    };
  }
  return undefined;
}

function isExpectedOidMismatch(message: string, expectedSha: string): boolean {
  if (!message.includes(expectedSha)) return false;
  const lower = message.toLowerCase();
  const mentionsCurrentOid =
    lower.includes("current oid") ||
    lower.includes("beforeoid") ||
    lower.includes("before oid");
  const mentionsExpectedOid =
    lower.includes("expected oid") || lower.includes("specified expected oid");
  const mentionsMismatch =
    lower.includes("does not match") ||
    lower.includes("doesn't match") ||
    lower.includes("did not match");
  return mentionsCurrentOid && mentionsExpectedOid && mentionsMismatch;
}

function actualShaFromMismatch(message: string): string | null {
  const match = message.match(/current oid of \S+ is ([0-9a-f]{40})/i);
  return match?.[1] ?? null;
}

function graphqlErrorMessage(errors: readonly unknown[]): string {
  const messages = errors.flatMap((error) =>
    isRecord(error) && isString(error.message) ? [error.message] : [],
  );
  return messages.length === 0
    ? "invalid GitHub GraphQL response"
    : messages.join("; ");
}

function isComparisonStatus(value: unknown): value is GitHubComparisonStatus {
  return (
    value === "identical" ||
    value === "ahead" ||
    value === "behind" ||
    value === "diverged"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function invalidResponse(operation: string): GitHubError {
  return {
    type: "GitHubError",
    operation,
    message: "invalid GitHub API response",
  };
}

function truncatedResponse(operation: string, message: string): GitHubError {
  return {
    type: "GitHubError",
    operation,
    message: `truncated GitHub API response: ${message}`,
  };
}

function mainBranchName(): string {
  return RELEASE_CONTROL_REF.slice("refs/heads/".length);
}

interface RequiredCheck {
  name: string;
  source: GitHubRequiredCheckSource;
  /** Provider App ID for check-run requirements, when policy supplies one. */
  appId?: number;
}

interface CommitStatusReading {
  context: string;
  state: string;
  updatedAt: string;
}

interface CheckRunReading {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string;
  id: number;
  /** GitHub reports the check-run provider as `app.id`. */
  appId?: number;
}

const KNOWN_STATUS_STATES = new Set(["success", "pending", "failure", "error"]);
const KNOWN_CHECK_STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
const KNOWN_CHECK_CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);

function normalizeRequiredChecks(
  checks: readonly GitHubRequiredCheck[],
  operation: string,
  bounds: GreenMainHeadBounds,
): ResultAsync<readonly RequiredCheck[], GitHubError> {
  const normalized = checks.map((check) => {
    const required: RequiredCheck = {
      name: check.name,
      source:
        check.appId !== undefined ? "check-run" : (check.source ?? "either"),
    };
    if (check.appId !== undefined) required.appId = check.appId;
    return required;
  });
  return mergeRequiredChecks(normalized, operation, bounds);
}

function mergeRequiredChecks(
  checks: readonly RequiredCheck[],
  operation: string,
  bounds: GreenMainHeadBounds,
): ResultAsync<readonly RequiredCheck[], GitHubError> {
  const merged = new Map<string, RequiredCheck>();
  for (const check of checks) {
    if (check.name.length === 0 || check.name.length > bounds.checkNameLength)
      return errAsync({
        type: "GitHubError",
        operation,
        message: `required check name must be 1..${bounds.checkNameLength} characters`,
      });
    if (check.appId !== undefined && !isPositiveInt(check.appId))
      return errAsync({
        type: "GitHubError",
        operation,
        message: "required check provider App ID must be a positive integer",
      });
    const existing = merged.get(check.name);
    if (existing === undefined) {
      merged.set(check.name, check);
      continue;
    }
    if (
      existing.appId !== undefined &&
      check.appId !== undefined &&
      existing.appId !== check.appId
    )
      return errAsync({
        type: "GitHubError",
        operation,
        message: `required check ${check.name} has conflicting provider App IDs`,
      });
    const appId = existing.appId ?? check.appId;
    const mergedCheck: RequiredCheck = {
      name: check.name,
      source:
        appId === undefined
          ? narrowerSource(existing.source, check.source)
          : "check-run",
    };
    if (appId !== undefined) mergedCheck.appId = appId;
    merged.set(check.name, mergedCheck);
  }
  if (merged.size === 0)
    return errAsync({
      type: "GitHubError",
      operation,
      message: "main has no required checks",
    });
  if (merged.size > bounds.requiredChecks)
    return errAsync(
      truncatedResponse(
        operation,
        `required ${merged.size} checks, limit ${bounds.requiredChecks}`,
      ),
    );
  return okAsync([...merged.values()]);
}

function narrowerSource(
  left: GitHubRequiredCheckSource,
  right: GitHubRequiredCheckSource,
): GitHubRequiredCheckSource {
  if (left === right) return left;
  if (left === "either") return right;
  if (right === "either") return left;
  return left;
}

function parseProtectionChecks(
  value: unknown,
  operation: string,
  bounds: GreenMainHeadBounds,
): ResultAsync<readonly RequiredCheck[], GitHubError> {
  if (!isRecord(value)) return errAsync(invalidResponse(operation));
  const fromChecks = Array.isArray(value.checks)
    ? value.checks.map((entry) => parseNamedCheck(entry, "context"))
    : [];
  if (fromChecks.some((check) => check === undefined))
    return errAsync(invalidResponse(operation));
  const named = new Set(
    (fromChecks as RequiredCheck[]).map((check) => check.name),
  );
  const fromContexts = Array.isArray(value.contexts)
    ? value.contexts.flatMap((context) => {
        if (!isString(context)) return [undefined];
        if (named.has(context)) return [];
        return [{ name: context, source: "either" as const }];
      })
    : [];
  if (fromContexts.some((check) => check === undefined))
    return errAsync(invalidResponse(operation));
  return mergeRequiredChecks(
    [...(fromChecks as RequiredCheck[]), ...(fromContexts as RequiredCheck[])],
    operation,
    bounds,
  ).orElse((error) =>
    error.message === "main has no required checks"
      ? okAsync<readonly RequiredCheck[], GitHubError>([])
      : errAsync<readonly RequiredCheck[], GitHubError>(error),
  );
}

function parseRuleChecks(
  value: unknown,
  operation: string,
  bounds: GreenMainHeadBounds,
): ResultAsync<readonly RequiredCheck[], GitHubError> {
  if (!Array.isArray(value)) return errAsync(invalidResponse(operation));
  const checks: RequiredCheck[] = [];
  for (const rule of value) {
    if (!isRecord(rule) || !isString(rule.type)) {
      return errAsync(invalidResponse(operation));
    }
    if (rule.type !== "required_status_checks") continue;
    if (
      !isRecord(rule.parameters) ||
      !Array.isArray(rule.parameters.required_status_checks)
    )
      return errAsync(invalidResponse(operation));
    for (const entry of rule.parameters.required_status_checks) {
      const parsed = parseNamedCheck(entry, "context");
      if (parsed === undefined) return errAsync(invalidResponse(operation));
      checks.push(parsed);
    }
  }
  return mergeRequiredChecks(checks, operation, bounds).orElse((error) =>
    error.message === "main has no required checks"
      ? okAsync<readonly RequiredCheck[], GitHubError>([])
      : errAsync<readonly RequiredCheck[], GitHubError>(error),
  );
}

function parseNamedCheck(
  value: unknown,
  nameKey: "context",
): RequiredCheck | undefined {
  if (!isRecord(value) || !isString(value[nameKey])) return undefined;
  const appId = value.app_id ?? value.integration_id;
  if (appId !== undefined && appId !== null && !isPositiveInt(appId))
    return undefined;
  const check: RequiredCheck = {
    name: value[nameKey],
    source: isPositiveInt(appId) ? "check-run" : "either",
  };
  if (isPositiveInt(appId)) check.appId = appId;
  return check;
}

function parseCommitStatusPage(
  value: unknown,
  operation: string,
): Result<{ items: readonly CommitStatusReading[] }, GitHubError> {
  if (!Array.isArray(value)) return err(invalidResponse(operation));
  const items = value.map(parseCommitStatus);
  if (items.some((item) => item === undefined))
    return err(invalidResponse(operation));
  return ok({ items: items as CommitStatusReading[] });
}

function parseCommitStatus(value: unknown): CommitStatusReading | undefined {
  if (!isRecord(value) || !isString(value.context) || !isString(value.state))
    return undefined;
  let updatedAt = "";
  if (isString(value.updated_at)) updatedAt = value.updated_at;
  else if (isString(value.created_at)) updatedAt = value.created_at;
  return { context: value.context, state: value.state, updatedAt };
}

function parseCheckRunPage(
  value: unknown,
  operation: string,
): Result<
  { items: readonly CheckRunReading[]; totalCount?: number },
  GitHubError
> {
  if (!isRecord(value) || !Array.isArray(value.check_runs))
    return err(invalidResponse(operation));
  if (value.total_count !== undefined && !isNonNegativeInt(value.total_count))
    return err(invalidResponse(operation));
  const items = value.check_runs.map(parseCheckRun);
  if (items.some((item) => item === undefined))
    return err(invalidResponse(operation));
  return ok({
    items: items as CheckRunReading[],
    totalCount: value.total_count,
  });
}

function parseCheckRun(value: unknown): CheckRunReading | undefined {
  if (!isRecord(value) || !isString(value.name) || !isString(value.status))
    return undefined;
  if (value.conclusion !== null && !isString(value.conclusion))
    return undefined;
  if (value.id !== undefined && !isPositiveInt(value.id)) return undefined;
  let appId: number | undefined;
  if (value.app !== undefined && value.app !== null) {
    if (!isRecord(value.app)) return undefined;
    if (value.app.id !== undefined && !isPositiveInt(value.app.id))
      return undefined;
    appId = isPositiveInt(value.app.id) ? value.app.id : undefined;
  }
  const check: CheckRunReading = {
    name: value.name,
    status: value.status,
    conclusion: value.conclusion ?? null,
    startedAt: isString(value.started_at) ? value.started_at : "",
    id: isPositiveInt(value.id) ? value.id : 0,
  };
  if (appId !== undefined) check.appId = appId;
  return check;
}

function latestCommitStatuses(
  statuses: readonly CommitStatusReading[],
): readonly CommitStatusReading[] {
  const latest = new Map<string, CommitStatusReading>();
  for (const status of statuses) {
    const current = latest.get(status.context);
    if (current === undefined || status.updatedAt >= current.updatedAt)
      latest.set(status.context, status);
  }
  return [...latest.values()];
}

function latestCheckRuns(
  runs: readonly CheckRunReading[],
): readonly CheckRunReading[] {
  // Keep provider identities separate. A newer run from the wrong App must
  // not hide an older run from the App required by branch protection.
  const latest = new Map<string, CheckRunReading>();
  for (const run of runs) {
    const key = `${run.name}\u0000${run.appId ?? ""}`;
    const current = latest.get(key);
    if (current === undefined || compareCheckRuns(run, current) >= 0)
      latest.set(key, run);
  }
  return [...latest.values()];
}

function compareCheckRuns(
  left: CheckRunReading,
  right: CheckRunReading,
): number {
  if (left.startedAt !== right.startedAt)
    return left.startedAt < right.startedAt ? -1 : 1;
  return left.id - right.id;
}

function proveOneRequiredCheck(
  sha: string,
  check: RequiredCheck,
  statuses: readonly CommitStatusReading[],
  runs: readonly CheckRunReading[],
): Result<void, GitHubError> {
  const status = statuses.find((entry) => entry.context === check.name);
  const run = runs.find(
    (entry) =>
      entry.name === check.name &&
      (check.appId === undefined || entry.appId === check.appId),
  );
  const operation = `/commits/${sha}`;
  if (check.source === "status")
    return status === undefined
      ? missingCheck(operation, check.name, "status")
      : proveCommitStatus(operation, check.name, status);
  if (check.source === "check-run")
    return run === undefined
      ? missingCheck(
          operation,
          check.appId === undefined
            ? check.name
            : `${check.name} (App ${check.appId})`,
          "check-run",
        )
      : proveCheckRun(operation, check.name, run);
  if (status === undefined && run === undefined)
    return missingCheck(
      operation,
      check.appId === undefined
        ? check.name
        : `${check.name} (App ${check.appId})`,
      "either",
    );
  if (status !== undefined) {
    const proved = proveCommitStatus(operation, check.name, status);
    if (proved.isErr()) return proved;
  }
  if (run !== undefined) {
    const proved = proveCheckRun(operation, check.name, run);
    if (proved.isErr()) return proved;
  }
  return ok(undefined);
}

function proveCommitStatus(
  operation: string,
  name: string,
  status: CommitStatusReading,
): Result<void, GitHubError> {
  if (!KNOWN_STATUS_STATES.has(status.state))
    return err({
      type: "GitHubError",
      operation,
      message: `required status ${name} has unknown state ${status.state}`,
    });
  if (status.state === "pending")
    return err({
      type: "GitHubError",
      operation,
      message: `required status ${name} is pending`,
    });
  if (status.state !== "success")
    return err({
      type: "GitHubError",
      operation,
      message: `required status ${name} is not green: ${status.state}`,
    });
  return ok(undefined);
}

function proveCheckRun(
  operation: string,
  name: string,
  run: CheckRunReading,
): Result<void, GitHubError> {
  if (!KNOWN_CHECK_STATUSES.has(run.status))
    return err({
      type: "GitHubError",
      operation,
      message: `required check ${name} has unknown status ${run.status}`,
    });
  if (run.status !== "completed")
    return err({
      type: "GitHubError",
      operation,
      message: `required check ${name} is ${run.status}`,
    });
  if (run.conclusion === null || !KNOWN_CHECK_CONCLUSIONS.has(run.conclusion))
    return err({
      type: "GitHubError",
      operation,
      message: `required check ${name} has unknown conclusion ${run.conclusion ?? "null"}`,
    });
  if (run.conclusion !== "success")
    return err({
      type: "GitHubError",
      operation,
      message: `required check ${name} is not green: ${run.conclusion}`,
    });
  return ok(undefined);
}

function missingCheck(
  operation: string,
  name: string,
  source: GitHubRequiredCheckSource,
): Result<void, GitHubError> {
  return err({
    type: "GitHubError",
    operation,
    message: `required ${source} ${name} is missing`,
  });
}

function parseLabelNames(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.map((label) =>
    isRecord(label) && isString(label.name) ? label.name : undefined,
  );
  return names.some((name) => name === undefined)
    ? undefined
    : (names as string[]);
}

interface ParsedLinkValue {
  target: string;
  relations: readonly string[];
}

/**
 * Parses the Link header before the collector considers whether to continue.
 * A missing header is the only complete-page signal for "no next page";
 * present-but-invalid syntax is always a typed refusal.
 */
function nextLink(
  header: string | null,
  operation: string,
): Result<string | null, GitHubError> {
  if (header === null) return ok(null);
  if (header.trim().length === 0)
    return err(paginationError(operation, "Link header is empty"));

  const parsed = parseLinkValues(header, operation);
  if (parsed.isErr()) return err(parsed.error);
  let next: string | undefined;
  for (const link of parsed.value) {
    const nextRelations = link.relations.filter(
      (relation) => relation.toLowerCase() === "next",
    );
    if (nextRelations.length > 1)
      return err(
        paginationError(operation, "a link contains duplicate rel=next values"),
      );
    if (nextRelations.length === 0) continue;
    if (next !== undefined)
      return err(
        paginationError(
          operation,
          "Link header contains multiple rel=next links",
        ),
      );
    next = link.target;
  }
  return ok(next ?? null);
}

function parseLinkValues(
  header: string,
  operation: string,
): Result<readonly ParsedLinkValue[], GitHubError> {
  const links: ParsedLinkValue[] = [];
  let index = 0;
  while (index < header.length) {
    while (isLinkWhitespace(header[index])) index += 1;
    if (index >= header.length)
      return err(
        paginationError(operation, "Link header has a trailing comma"),
      );
    if (header[index] !== "<")
      return err(paginationError(operation, "Link value must start with '<'"));
    index += 1;
    const targetStart = index;
    while (index < header.length && header[index] !== ">") {
      if (header[index] === "\r" || header[index] === "\n")
        return err(
          paginationError(operation, "Link URI contains a line break"),
        );
      index += 1;
    }
    if (index >= header.length)
      return err(paginationError(operation, "Link URI is not closed"));
    const target = header.slice(targetStart, index);
    if (target.length === 0 || /\s/.test(target))
      return err(paginationError(operation, "Link URI is malformed"));
    index += 1;

    const parameters = new Map<string, string>();
    let nextEntry = false;
    while (true) {
      while (isLinkWhitespace(header[index])) index += 1;
      if (index >= header.length) break;
      if (header[index] === ",") {
        index += 1;
        nextEntry = true;
        break;
      }
      if (header[index] !== ";")
        return err(
          paginationError(
            operation,
            "Link parameters must be separated by ';'",
          ),
        );
      index += 1;
      while (isLinkWhitespace(header[index])) index += 1;
      const nameStart = index;
      while (index < header.length && isLinkTokenChar(header[index]))
        index += 1;
      if (nameStart === index)
        return err(
          paginationError(operation, "Link parameter name is missing"),
        );
      const name = header.slice(nameStart, index).toLowerCase();
      while (isLinkWhitespace(header[index])) index += 1;
      if (header[index] !== "=")
        return err(
          paginationError(operation, `Link parameter ${name} has no value`),
        );
      index += 1;
      while (isLinkWhitespace(header[index])) index += 1;
      const parameter = readLinkParameterValue(header, index);
      if (parameter === undefined)
        return err(
          paginationError(operation, `Link parameter ${name} is malformed`),
        );
      index = parameter.nextIndex;
      if (parameters.has(name))
        return err(
          paginationError(operation, `Link parameter ${name} is duplicated`),
        );
      parameters.set(name, parameter.value);
    }
    const rel = parameters.get("rel");
    const relations =
      rel === undefined
        ? []
        : rel.split(/[ \t]+/u).filter((relation) => relation.length > 0);
    if (rel !== undefined && relations.length === 0)
      return err(paginationError(operation, "Link rel is empty"));
    links.push({ target, relations });
    if (!nextEntry) break;
  }
  return ok(links);
}

function readLinkParameterValue(
  header: string,
  start: number,
): { value: string; nextIndex: number } | undefined {
  if (header[start] === '"') {
    let index = start + 1;
    let value = "";
    while (index < header.length) {
      const character = header[index];
      if (character === "\\") {
        if (index + 1 >= header.length) return undefined;
        value += header[index + 1];
        index += 2;
        continue;
      }
      if (character === '"') return { value, nextIndex: index + 1 };
      if (character === "\r" || character === "\n") return undefined;
      value += character;
      index += 1;
    }
    return undefined;
  }
  let index = start;
  while (
    index < header.length &&
    !isLinkWhitespace(header[index]) &&
    header[index] !== ";" &&
    header[index] !== ","
  ) {
    if (!isLinkTokenChar(header[index])) return undefined;
    index += 1;
  }
  if (index === start) return undefined;
  return { value: header.slice(start, index), nextIndex: index };
}

function isLinkWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t";
}

function isLinkTokenChar(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9!#$%&'*+\-.^_`|~]$/u.test(value);
}

function parsePaginationUrl(
  value: string,
  operation: string,
  base?: string,
): Result<URL, GitHubError> {
  return Result.fromThrowable(
    () => (base === undefined ? new URL(value) : new URL(value, base)),
    () => paginationError(operation, "URL is malformed"),
  )();
}

function validatePaginationContinuation(
  nextUrl: string,
  initialUrl: URL,
  currentUrl: string,
  currentPage: number,
): Result<string, GitHubError> {
  const parsed = parsePaginationUrl(nextUrl, currentUrl, currentUrl);
  if (parsed.isErr()) return err(parsed.error);
  const candidate = parsed.value;
  if (candidate.origin !== initialUrl.origin)
    return err(
      paginationError(
        currentUrl,
        "next URL is outside the configured API origin",
      ),
    );
  if (
    candidate.username !== "" ||
    candidate.password !== "" ||
    hasRawUrlUserinfo(nextUrl)
  )
    return err(paginationError(currentUrl, "next URL contains userinfo"));
  if (candidate.hash !== "" || nextUrl.includes("#"))
    return err(paginationError(currentUrl, "next URL contains a fragment"));
  if (candidate.pathname !== initialUrl.pathname)
    return err(
      paginationError(
        currentUrl,
        "next URL does not target the initial repository collection",
      ),
    );

  const initialQuery = queryEntries(initialUrl, currentUrl);
  if (initialQuery.isErr()) return err(initialQuery.error);
  const continuationQuery = queryEntries(candidate, currentUrl);
  if (continuationQuery.isErr()) return err(continuationQuery.error);

  const initialNonPage = new Map(
    initialQuery.value.filter(([name]) => name !== "page"),
  );
  const continuationNonPage = new Map(
    continuationQuery.value.filter(([name]) => name !== "page"),
  );
  if (initialNonPage.size !== continuationNonPage.size)
    return err(
      paginationError(currentUrl, "next URL changes the collection query"),
    );
  for (const [name, value] of initialNonPage) {
    if (continuationNonPage.get(name) !== value)
      return err(
        paginationError(currentUrl, "next URL changes the collection query"),
      );
  }

  const initialPage = initialQuery.value.find(([name]) => name === "page")?.[1];
  if (initialPage !== undefined) {
    if (
      rawQueryValue(initialUrl, "page") !== initialPage ||
      parseCanonicalPage(initialPage) !== 1
    )
      return err(
        paginationError(
          currentUrl,
          "initial page must be the canonical page 1",
        ),
      );
  }
  const continuationPage = continuationQuery.value.find(
    ([name]) => name === "page",
  )?.[1];
  if (continuationPage === undefined)
    return err(paginationError(currentUrl, "next URL has no page parameter"));
  if (rawQueryValue(candidate, "page") !== continuationPage)
    return err(
      paginationError(currentUrl, "next URL page must use canonical encoding"),
    );
  const page = parseCanonicalPage(continuationPage);
  if (page === undefined)
    return err(
      paginationError(
        currentUrl,
        "next URL page must be a canonical positive integer",
      ),
    );
  if (page !== currentPage + 1)
    return err(
      paginationError(
        currentUrl,
        `next URL page must advance to ${currentPage + 1}`,
      ),
    );
  return ok(candidate.href);
}

function hasRawUrlUserinfo(value: string): boolean {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.exec(value);
  let authorityPrefix = -1;
  if (scheme !== null) authorityPrefix = scheme[0].length;
  else if (value.startsWith("//")) authorityPrefix = 0;
  if (
    authorityPrefix < 0 ||
    value.slice(authorityPrefix, authorityPrefix + 2) !== "//"
  )
    return false;
  const authorityStart = authorityPrefix + 2;
  let authorityEnd = value.length;
  for (const delimiter of ["/", "?", "#"]) {
    const index = value.indexOf(delimiter, authorityStart);
    if (index >= 0) authorityEnd = Math.min(authorityEnd, index);
  }
  return value.slice(authorityStart, authorityEnd).includes("@");
}

function queryEntries(
  url: URL,
  operation: string,
): Result<readonly [string, string][], GitHubError> {
  const rawQuery = url.search.slice(1);
  if (rawQuery !== "" && rawQuery.split("&").some((part) => part === ""))
    return err(paginationError(operation, "query contains an empty parameter"));
  const entries: [string, string][] = [];
  const names = new Set<string>();
  for (const [name, value] of url.searchParams.entries()) {
    if (names.has(name))
      return err(
        paginationError(operation, `query parameter ${name} is duplicated`),
      );
    names.add(name);
    entries.push([name, value]);
  }
  return ok(entries);
}

function rawQueryValue(url: URL, name: string): string | undefined {
  for (const part of url.search.slice(1).split("&")) {
    const separator = part.indexOf("=");
    const rawName = separator === -1 ? part : part.slice(0, separator);
    if (rawName === name)
      return separator === -1 ? "" : part.slice(separator + 1);
  }
  return undefined;
}

function parseCanonicalPage(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(value)) return undefined;
  const page = Number(value);
  return Number.isSafeInteger(page) && String(page) === value
    ? page
    : undefined;
}

function paginationError(operation: string, message: string): GitHubError {
  return {
    type: "GitHubError",
    operation,
    message: `invalid GitHub pagination: ${message}`,
  };
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function settle<T, E>(operation: ResultAsync<T, E>): Promise<Result<T, E>> {
  return operation.match<Result<T, E>>(
    (value) => ok(value),
    (error) => err(error),
  );
}

function fromAsync<T>(
  run: () => Promise<Result<T, GitHubError>>,
): ResultAsync<T, GitHubError> {
  return ResultAsync.fromSafePromise(run()).andThen((result) => result);
}
