import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
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
  maxItems: 300,
} as const;

export type PullRequestBounds = {
  -readonly [Key in keyof typeof PULL_REQUEST_BOUNDS]: number;
};

export const GITHUB_REST_READ_LIMITS = {
  requestTimeoutMs: 10_000,
  jsonResponseBytes: 512 * 1024,
  binaryResponseBytes: 8 * 1024 * 1024,
  stringLength: 16 * 1024,
  pageItems: 100,
  collectionItems: 300,
} as const;

const GITHUB_RESPONSE_BOUNDS = {
  responseBytes: GITHUB_REST_READ_LIMITS.binaryResponseBytes,
  textLength: 512 * 1024,
  arrayItems: 1_024,
} as const;

const GitHubTextSchema = z.string().max(GITHUB_RESPONSE_BOUNDS.textLength);
const GitHubIdentifierSchema = z
  .string()
  .min(1)
  .max(GITHUB_RESPONSE_BOUNDS.textLength);
const PositiveIntSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const NonNegativeIntSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const ShaSchema = z.string().min(1).max(256);
const FullShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .refine((value) => value !== "0".repeat(40));
const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  });

const WorkflowRunResponseSchema = z
  .object({
    repository: z.object({ id: PositiveIntSchema }).strip(),
    id: PositiveIntSchema,
    run_attempt: PositiveIntSchema,
    event: GitHubIdentifierSchema,
    head_branch: GitHubIdentifierSchema,
    head_sha: ShaSchema,
    conclusion: GitHubIdentifierSchema.nullable().optional(),
    path: GitHubIdentifierSchema,
  })
  .strip();
const WorkflowJobResponseSchema = z
  .object({
    id: PositiveIntSchema,
    name: GitHubIdentifierSchema,
    conclusion: GitHubIdentifierSchema.nullable().optional(),
  })
  .strip();
const WorkflowJobsResponseSchema = z
  .object({
    jobs: z
      .array(WorkflowJobResponseSchema)
      .max(GITHUB_RESPONSE_BOUNDS.arrayItems),
  })
  .strip();
const ArtifactResponseSchema = z
  .object({
    id: PositiveIntSchema,
    name: GitHubIdentifierSchema,
    digest: GitHubIdentifierSchema.optional(),
    expired: z.boolean(),
    size_in_bytes: PositiveIntSchema,
  })
  .strip();
const ArtifactsResponseSchema = z
  .object({
    artifacts: z
      .array(ArtifactResponseSchema)
      .max(GITHUB_RESPONSE_BOUNDS.arrayItems),
  })
  .strip();
const RefResponseSchema = z
  .object({ object: z.object({ sha: FullShaSchema }).strip() })
  .strip();
const NodeResponseSchema = z
  .object({ node_id: GitHubIdentifierSchema })
  .strip();
const MembershipResponseSchema = z
  .object({ state: GitHubIdentifierSchema })
  .strip();
const ShaResponseSchema = z.object({ sha: FullShaSchema }).strip();
const CommitMessageResponseSchema = z
  .object({ message: GitHubTextSchema })
  .strip();
const CommitTreeResponseSchema = z
  .object({ tree: z.object({ sha: FullShaSchema }).strip() })
  .strip();
const TreeResponseSchema = z.object({ sha: FullShaSchema }).strip();
const ContentsResponseSchema = z
  .object({
    type: z.literal("file"),
    encoding: z.literal("base64"),
    content: z.string().max(GITHUB_RESPONSE_BOUNDS.textLength),
  })
  .strip();
const TreeListingResponseSchema = z
  .object({
    truncated: z.literal(false),
    tree: z
      .array(z.object({ path: GitHubIdentifierSchema }).strip())
      .max(GITHUB_REST_READ_LIMITS.collectionItems * 16),
  })
  .strip();
const ComparisonResponseSchema = z
  .object({
    status: z.enum(["identical", "ahead", "behind", "diverged"]),
  })
  .strip();
const ReleaseAssetResponseSchema = z
  .object({
    id: PositiveIntSchema,
    name: GitHubIdentifierSchema,
    size: PositiveIntSchema,
    digest: GitHubIdentifierSchema.optional(),
  })
  .strip();
const ReleaseResponseSchema = z
  .object({
    id: PositiveIntSchema,
    tag_name: GitHubIdentifierSchema,
    target_commitish: GitHubIdentifierSchema,
    body: GitHubTextSchema,
    draft: z.boolean(),
    immutable: z.boolean(),
    assets: z
      .array(ReleaseAssetResponseSchema)
      .max(GITHUB_RESPONSE_BOUNDS.arrayItems),
  })
  .strip();
const LabelResponseSchema = z.object({ name: GitHubIdentifierSchema }).strip();
const PullRequestResponseSchema = z
  .object({
    number: PositiveIntSchema,
    html_url: GitHubIdentifierSchema,
    state: z.enum(["open", "closed"]),
    merged: z.boolean().optional(),
    merged_at: TimestampSchema.nullable(),
    closed_at: TimestampSchema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    merge_commit_sha: FullShaSchema.nullable(),
    head: z
      .object({ ref: GitHubIdentifierSchema, sha: FullShaSchema })
      .strip(),
    base: z
      .object({ ref: GitHubIdentifierSchema, sha: FullShaSchema })
      .strip(),
    title: GitHubTextSchema,
    body: GitHubTextSchema,
    labels: z.array(LabelResponseSchema).max(32),
  })
  .strip()
  .superRefine((value, context) => {
    const isMerged = value.merged_at !== null;
    if (value.state === "open" && value.closed_at !== null)
      context.addIssue({ code: "custom", message: "open pull request is closed" });
    if (value.state === "closed" && value.closed_at === null)
      context.addIssue({ code: "custom", message: "closed pull request has no closed_at" });
    if (isMerged && value.state !== "closed")
      context.addIssue({ code: "custom", message: "merged pull request is open" });
    if (value.merged !== undefined && value.merged !== isMerged)
      context.addIssue({ code: "custom", message: "merged flag conflicts with merged_at" });
    if (isMerged !== (value.merge_commit_sha !== null))
      context.addIssue({ code: "custom", message: "merge SHA conflicts with merged_at" });
  });
const PullRequestPageSchema = z
  .array(PullRequestResponseSchema)
  .max(GITHUB_RESPONSE_BOUNDS.arrayItems);
const CreatePullRequestResponseSchema = z.union([
  PullRequestResponseSchema,
  z.object({}).strip(),
]);
const NamedCheckResponseSchema = z
  .object({
    context: GitHubIdentifierSchema,
    app_id: PositiveIntSchema.nullable().optional(),
    integration_id: PositiveIntSchema.nullable().optional(),
  })
  .strip();
const ProtectionChecksResponseSchema = z
  .object({
    checks: z
      .array(NamedCheckResponseSchema)
      .max(GITHUB_RESPONSE_BOUNDS.arrayItems)
      .optional()
      .default([]),
    contexts: z
      .array(GitHubIdentifierSchema)
      .max(GITHUB_RESPONSE_BOUNDS.arrayItems)
      .optional()
      .default([]),
  })
  .strip();
const RuleResponseSchema = z
  .object({
    type: GitHubIdentifierSchema,
    parameters: z
      .object({
        required_status_checks: z
          .array(NamedCheckResponseSchema)
          .max(GITHUB_RESPONSE_BOUNDS.arrayItems)
          .optional(),
      })
      .strip()
      .optional(),
  })
  .strip();
const RulesResponseSchema = z
  .array(RuleResponseSchema)
  .max(GITHUB_RESPONSE_BOUNDS.arrayItems);
const CommitStatusResponseSchema = z
  .object({
    context: GitHubIdentifierSchema,
    state: GitHubIdentifierSchema,
    updated_at: GitHubTextSchema.optional(),
    created_at: GitHubTextSchema.optional(),
  })
  .strip();
const CommitStatusesResponseSchema = z
  .array(CommitStatusResponseSchema)
  .max(GITHUB_RESPONSE_BOUNDS.arrayItems);
const CheckRunResponseSchema = z
  .object({
    name: GitHubIdentifierSchema,
    status: GitHubIdentifierSchema,
    conclusion: GitHubIdentifierSchema.nullable().optional(),
    started_at: GitHubTextSchema.optional(),
    id: PositiveIntSchema.optional(),
    app: z
      .object({ id: PositiveIntSchema.optional() })
      .strip()
      .nullable()
      .optional(),
  })
  .strip();
const CheckRunsResponseSchema = z
  .object({
    check_runs: z
      .array(CheckRunResponseSchema)
      .max(GITHUB_RESPONSE_BOUNDS.arrayItems),
    total_count: NonNegativeIntSchema.optional(),
  })
  .strip();
const LabelsResponseSchema = z
  .array(LabelResponseSchema)
  .max(GITHUB_RESPONSE_BOUNDS.arrayItems);
const AttestationsResponseSchema = z
  .object({
    attestations: z
      .array(z.object({}).strip())
      .max(GITHUB_RESPONSE_BOUNDS.arrayItems),
  })
  .strip();
const GraphqlErrorSchema = z.object({ message: GitHubTextSchema }).strip();
const GraphqlPayloadSchema = z
  .object({
    data: z
      .object({
        updateRefs: z
          .object({ clientMutationId: GitHubTextSchema.nullable().optional() })
          .strip()
          .nullable(),
      })
      .strip()
      .optional(),
    errors: z.array(GraphqlErrorSchema).max(32).optional(),
  })
  .strip();

type WorkflowRunResponse = z.infer<typeof WorkflowRunResponseSchema>;
type WorkflowJobResponse = z.infer<typeof WorkflowJobResponseSchema>;
type ArtifactResponse = z.infer<typeof ArtifactResponseSchema>;
type ReleaseResponse = z.infer<typeof ReleaseResponseSchema>;
type ReleaseAssetResponse = z.infer<typeof ReleaseAssetResponseSchema>;
type PullRequestResponse = z.infer<typeof PullRequestResponseSchema>;
type ProtectionChecksResponse = z.infer<typeof ProtectionChecksResponseSchema>;
type RuleResponse = z.infer<typeof RuleResponseSchema>;
type NamedCheckResponse = z.infer<typeof NamedCheckResponseSchema>;
type CommitStatusResponse = z.infer<typeof CommitStatusResponseSchema>;
type CheckRunResponse = z.infer<typeof CheckRunResponseSchema>;
type GraphqlPayload = z.infer<typeof GraphqlPayloadSchema>;
type GraphqlError = z.infer<typeof GraphqlErrorSchema>;

interface GraphqlVariables {
  input: {
    repositoryId: string;
    refUpdates: readonly [
      {
        name: string;
        afterOid: string;
        beforeOid: string;
        force: boolean;
      },
    ];
  };
}

const ZERO_GIT_OID = "0".repeat(40);
const FULL_BRANCH_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const GIT_OBJECT_SHA = /^[0-9a-f]{40}$/;
const UPDATE_REFS_MUTATION = `mutation UpdateRefWithLease($input: UpdateRefsInput!) {
  updateRefs(input: $input) {
    clientMutationId
  }
}`;

export interface GitHubRestClientOptions {
  /**
   * Precise required-check policy. When set, the client does not read branch
   * protection or rulesets; the caller already knows which checks must pass.
   */
  requiredChecks?: readonly GitHubRequiredCheck[];
  greenHeadBounds?: Partial<GreenMainHeadBounds>;
  pullRequestBounds?: Partial<PullRequestBounds>;
  requestTimeoutMs?: number;
  jsonResponseBytes?: number;
  binaryResponseBytes?: number;
  stringLength?: number;
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
  private readonly requestTimeoutMs: number;
  private readonly jsonResponseBytes: number;
  private readonly binaryResponseBytes: number;
  private readonly stringLength: number;

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
    this.requestTimeoutMs = positiveLimit(
      options.requestTimeoutMs,
      GITHUB_REST_READ_LIMITS.requestTimeoutMs,
    );
    this.jsonResponseBytes = positiveLimit(
      options.jsonResponseBytes,
      GITHUB_REST_READ_LIMITS.jsonResponseBytes,
    );
    this.binaryResponseBytes = positiveLimit(
      options.binaryResponseBytes,
      GITHUB_REST_READ_LIMITS.binaryResponseBytes,
    );
    this.stringLength = positiveLimit(
      options.stringLength,
      GITHUB_REST_READ_LIMITS.stringLength,
    );
  }

  getWorkflowRun(runId: number): ResultAsync<WorkflowRunMetadata, GitHubError> {
    return this.requestJson(
      `/actions/runs/${runId}`,
      WorkflowRunResponseSchema,
    ).andThen((value) => {
      const run = parseWorkflowRun(value);
      if (run === undefined)
        return errAsync(invalidResponse(`/actions/runs/${runId}`));
      return okAsync(run);
    });
  }

  getPullRequest(
    number: number,
  ): ResultAsync<GitHubPullRequestSummary, GitHubError> {
    const path = `/pulls/${number}`;
    return this.requestJson(path, PullRequestResponseSchema).andThen((value) => {
      const pull = parsePullRequest(value);
      const expectedUrl = `https://github.com/${this.repository}/pull/${number}`;
      if (
        pull.url !== expectedUrl ||
        pull.title.length > this.stringLength ||
        pull.body.length > this.stringLength * 8 ||
        pull.headRef.length > this.stringLength ||
        pull.baseRef.length > this.stringLength
      )
        return errAsync(invalidResponse(path));
      return okAsync(pull);
    });
  }

  readFileAtRef(path: string, ref: string): ResultAsync<string, GitHubError> {
    const operation = `/contents/${path}`;
    if (!safeGitHubPath(path) || !isFullSha(ref))
      return errAsync(invalidResponse(operation));
    const requestPath = `${operation}?ref=${encodeURIComponent(ref)}`;
    return this.requestJson(requestPath, ContentsResponseSchema).andThen(
      (value) => {
        const decoded = decodeBase64Utf8(value.content);
        return decoded === undefined
          ? errAsync(invalidResponse(requestPath))
          : okAsync(decoded);
      },
    );
  }

  listTreePaths(sha: string): ResultAsync<readonly string[], GitHubError> {
    const path = `/git/trees/${sha}?recursive=1`;
    if (!isFullSha(sha)) return errAsync(invalidResponse(path));
    return this.requestJson(path, TreeListingResponseSchema).andThen((value) =>
      okAsync(value.tree.map((entry) => entry.path)),
    );
  }

  listCommitTreePaths(
    sha: string,
  ): ResultAsync<readonly string[], GitHubError> {
    if (!isFullSha(sha))
      return errAsync(invalidResponse(`/git/commits/${sha}`));
    return this.readCommitTree(sha).andThen((treeSha) =>
      this.listTreePaths(treeSha),
    );
  }

  listWorkflowRunJobs(
    runId: number,
  ): ResultAsync<readonly WorkflowJobMetadata[], GitHubError> {
    return this.requestJson(
      `/actions/runs/${runId}/jobs`,
      WorkflowJobsResponseSchema,
    ).andThen((value) => okAsync(value.jobs.map(parseWorkflowJob)));
  }

  listRunArtifacts(
    runId: number,
  ): ResultAsync<readonly ActionsArtifactMetadata[], GitHubError> {
    const path = `/actions/runs/${runId}/artifacts`;
    return this.requestJson(path, ArtifactsResponseSchema).andThen((value) =>
      okAsync(value.artifacts.map(parseArtifact)),
    );
  }

  getArtifact(
    artifactId: number,
  ): ResultAsync<ActionsArtifactMetadata, GitHubError> {
    const path = `/actions/artifacts/${artifactId}`;
    return this.requestJson(path, ArtifactResponseSchema).andThen((value) => {
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
    }).andThen(() => completeGitHubRequest("/releases"));
  }

  createTag(tag: string, sha: string): ResultAsync<void, GitHubError> {
    return this.request("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
    }).andThen(() => completeGitHubRequest("/git/refs"));
  }

  getRef(ref: string): ResultAsync<string, GitHubError> {
    const path = `/git/ref/${ref.replace(/^refs\//, "")}`;
    return this.requestJson(path, RefResponseSchema).andThen((value) =>
      okAsync(value.object.sha),
    );
  }

  createRef(ref: string, sha: string): ResultAsync<void, GitHubError> {
    return this.request("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/${ref.replace(/^refs\//, "")}`, sha }),
    }).andThen(() => completeGitHubRequest("/git/refs"));
  }
  deleteRef(ref: string): ResultAsync<void, GitHubError> {
    const path = `/git/refs/${ref.replace(/^refs\//, "")}`;
    return this.request(path, {
      method: "DELETE",
    }).andThen(() => completeGitHubRequest(path));
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
      }).andThen(() => completeGitHubRequest(path));
    });
  }

  isMergedToMain(sha: string): ResultAsync<boolean, GitHubError> {
    const path = `/compare/${sha}...main`;
    return this.requestJson(path, ComparisonResponseSchema).andThen((value) =>
      okAsync(value.status === "identical" || value.status === "behind"),
    );
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
      .andThen(() => completeGitHubRequest("/git/refs"))
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
      return errAsync<undefined, GitHubRefWriteError>({
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
            return errAsync<undefined, GitHubRefWriteError>(lost);
          return errAsync<undefined, GitHubRefWriteError>({
            type: "GitHubError",
            operation,
            message: graphqlErrorMessage(errors),
          });
        }
        if (payload.data === undefined || payload.data.updateRefs === null)
          return errAsync<undefined, GitHubRefWriteError>({
            type: "GitHubError",
            operation,
            message: "invalid GitHub GraphQL response",
          });
        return ResultAsync.fromPromise(Promise.resolve(), () => ({
          type: "GitHubError" as const,
          operation,
          message: "lease result unavailable",
        }));
      });
  }

  private repositoryGraphId(): ResultAsync<string, GitHubError> {
    if (this.cachedRepositoryId !== undefined)
      return okAsync(this.cachedRepositoryId);
    const path = `/repos/${this.repository}`;
    return this.requestAbsoluteJson(
      `${this.apiUrl}${path}`,
      { method: "GET" },
      NodeResponseSchema,
    ).andThen((value) => {
      this.cachedRepositoryId = value.node_id;
      return okAsync(value.node_id);
    });
  }

  private requestGraphql(
    query: string,
    variables: GraphqlVariables,
  ): ResultAsync<GraphqlPayload, GitHubError> {
    const url = `${this.apiUrl}/graphql`;
    return this.requestAbsoluteJson(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      },
      GraphqlPayloadSchema,
    );
  }

  createCommitOnBase(input: {
    baseSha: string;
    message: string;
    files?: readonly GitHubCommitFile[];
  }): ResultAsync<string, GitHubError> {
    return this.readCommitTree(input.baseSha)
      .andThen((baseTree) => this.buildTree(baseTree, input.files ?? []))
      .andThen((tree) =>
        this.requestJsonWithInit(
          "/git/commits",
          {
            method: "POST",
            body: JSON.stringify({
              message: input.message,
              tree,
              parents: [input.baseSha],
            }),
          },
          ShaResponseSchema,
        ),
      )
      .andThen((value) => okAsync(value.sha));
  }

  readCommitMessage(sha: string): ResultAsync<string, GitHubError> {
    const path = `/git/commits/${sha}`;
    return this.requestJson(path, CommitMessageResponseSchema).andThen(
      (value) => okAsync(value.message),
    );
  }

  compareCommits(
    base: string,
    head: string,
  ): ResultAsync<GitHubComparisonStatus, GitHubError> {
    const path = `/compare/${base}...${head}`;
    return this.requestJson(path, ComparisonResponseSchema).andThen((value) =>
      okAsync(value.status),
    );
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
      PullRequestPageSchema,
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
      PullRequestPageSchema,
      (value, pagePath) => parsePullRequestPage(value, pagePath),
      this.pullRequestBounds,
    ).map((pulls) =>
      pulls.filter((pull) => pull.headRef === headRef && pull.state === state),
    );
  }

  createPullRequest(
    input: GitHubPullRequestCreateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError> {
    return this.requestJsonWithInit(
      "/pulls",
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.headRef,
          base: input.baseRef,
        }),
      },
      CreatePullRequestResponseSchema,
    )
      .mapErr(toPullRequestWriteError("createPullRequest"))
      .andThen((value) => {
        const parsed = PullRequestResponseSchema.safeParse(value);
        if (!parsed.success)
          return errAsync<
            GitHubPullRequestSummary,
            GitHubPullRequestWriteError
          >(
            ambiguousPullRequestWrite(
              "createPullRequest",
              "created pull request could not be parsed",
            ),
          );
        const pull = parsePullRequest(parsed.data);
        return this.addLabels(pull, input.labels).orElse(() =>
          errAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError>(
            ambiguousPullRequestWrite(
              "addLabels",
              "pull request label update failed",
            ),
          ),
        );
      });
  }

  updatePullRequest(
    input: GitHubPullRequestUpdateInput,
  ): ResultAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError> {
    const path = `/pulls/${input.number}`;
    return this.requestJsonWithInit(
      path,
      {
        method: "PATCH",
        body: JSON.stringify({ title: input.title, body: input.body }),
      },
      PullRequestResponseSchema,
    )
      .mapErr(toPullRequestWriteError("updatePullRequest"))
      .andThen((value) =>
        okAsync<GitHubPullRequestSummary, GitHubPullRequestWriteError>(
          parsePullRequest(value),
        ),
      );
  }

  addPullRequestLabels(
    number: number,
    labels: readonly string[],
  ): ResultAsync<readonly string[], GitHubPullRequestWriteError> {
    if (labels.length === 0)
      return okAsync<readonly string[], GitHubPullRequestWriteError>([]);
    return this.requestJsonWithInit(
      `/issues/${number}/labels`,
      {
        method: "POST",
        body: JSON.stringify({ labels: [...labels] }),
      },
      LabelsResponseSchema,
    )
      .mapErr(toPullRequestWriteError("addLabels"))
      .andThen((value) => okAsync(value.map((label) => label.name)));
  }

  isTeamMember(input: {
    organization: string;
    teamSlug: string;
    login: string;
  }): ResultAsync<boolean, GitHubError> {
    const url = `${this.apiUrl}/orgs/${encodeURIComponent(input.organization)}/teams/${encodeURIComponent(input.teamSlug)}/memberships/${encodeURIComponent(input.login)}`;
    return this.requestAbsoluteJson(
      url,
      { method: "GET" },
      MembershipResponseSchema,
    )
      .map((value) => value.state === "active")
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
    return this.requestJson(path, CommitTreeResponseSchema).andThen((value) =>
      okAsync(value.tree.sha),
    );
  }

  private buildTree(
    baseTree: string,
    files: readonly GitHubCommitFile[],
  ): ResultAsync<string, GitHubError> {
    if (files.length === 0) return okAsync(baseTree);
    return this.requestJsonWithInit(
      "/git/trees",
      {
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
      },
      TreeResponseSchema,
    ).andThen((value) => okAsync(value.sha));
  }

  getRelease(tag: string): ResultAsync<GitHubRelease, GitHubError> {
    const path = `/releases/tags/${encodeURIComponent(tag)}`;
    return this.requestJson(path, ReleaseResponseSchema).andThen((value) => {
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
    return this.requestJsonWithInit(
      "/releases",
      {
        method: "POST",
        body: JSON.stringify({
          tag_name: input.tag,
          target_commitish: input.targetSha,
          name: input.name,
          body: input.notes,
          draft: true,
        }),
      },
      ReleaseResponseSchema,
    ).andThen((value) => {
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
    return this.requestAbsoluteJson(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Blob([bytes.slice()]),
      },
      ReleaseAssetResponseSchema,
    ).andThen((value) => {
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
    const path = `/releases/${releaseId}/assets/${assetId}`;
    return this.request(path, {
      method: "DELETE",
    }).andThen(() => completeGitHubRequest(path));
  }

  publishRelease(releaseId: number): ResultAsync<GitHubRelease, GitHubError> {
    const path = `/releases/${releaseId}`;
    return this.requestJsonWithInit(
      path,
      {
        method: "PATCH",
        body: JSON.stringify({ draft: false }),
      },
      ReleaseResponseSchema,
    ).andThen((value) => {
      const release = parseRelease(value);
      return release === undefined
        ? errAsync(invalidResponse(path))
        : okAsync(release);
    });
  }

  hasReleaseAttestation(releaseId: number): ResultAsync<boolean, GitHubError> {
    const path = `/releases/${releaseId}/attestations`;
    return this.requestJson(path, AttestationsResponseSchema).andThen((value) =>
      okAsync(value.attestations.length > 0),
    );
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
    return this.requestJson(path, ProtectionChecksResponseSchema)
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
    return this.requestJson(path, RulesResponseSchema)
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
          if (proved.isErr())
            return errAsync<undefined, GitHubError>(proved.error);
        }
        return ResultAsync.fromPromise(Promise.resolve(), () => ({
          type: "GitHubError" as const,
          operation: "proveRequiredChecksGreen",
          message: "check proof result unavailable",
        }));
      }),
    );
  }

  private listCommitStatuses(
    sha: string,
  ): ResultAsync<readonly CommitStatusReading[], GitHubError> {
    const path = `/commits/${sha}/statuses?per_page=${this.greenHeadBounds.pageSize}`;
    return this.collectPages(
      path,
      CommitStatusesResponseSchema,
      (value, pagePath) => parseCommitStatusPage(value, pagePath),
    ).map(latestCommitStatuses);
  }

  private listCheckRuns(
    sha: string,
  ): ResultAsync<readonly CheckRunReading[], GitHubError> {
    const path = `/commits/${sha}/check-runs?per_page=${this.greenHeadBounds.pageSize}&filter=latest`;
    return this.collectPages(path, CheckRunsResponseSchema, (value, pagePath) =>
      parseCheckRunPage(value, pagePath),
    ).map(latestCheckRuns);
  }

  private collectPages<T, P>(
    startPath: string,
    schema: z.ZodType<P>,
    parsePage: (
      value: P,
      path: string,
    ) => Result<{ items: readonly T[]; totalCount?: number }, GitHubError>,
    bounds: {
      maxPages: number;
      pageSize?: number;
      maxItems?: number;
    } = this.greenHeadBounds,
  ): ResultAsync<readonly T[], GitHubError> {
    return fromAsync(async () => {
      const startUrl = this.repoUrl(startPath);
      const initialUrl = parsePaginationUrl(startUrl, startUrl);
      if (initialUrl.isErr()) return err(initialUrl.error);
      const collected: T[] = [];
      let url: string | null = startUrl;
      for (let page = 1; page <= bounds.maxPages; page += 1) {
        if (url === null) break;
        const pageDocument = await settle(
          this.requestJsonDocument(url, schema),
        );
        if (pageDocument.isErr()) return err(pageDocument.error);
        const parsed = parsePage(pageDocument.value.value, url);
        if (parsed.isErr()) return err(parsed.error);
        const pageSize = bounds.pageSize ?? GITHUB_REST_READ_LIMITS.pageItems;
        const maxItems = bounds.maxItems ?? bounds.maxPages * pageSize;
        if (
          parsed.value.items.length > pageSize ||
          collected.length + parsed.value.items.length > maxItems
        )
          return err(
            truncatedResponse(
              url,
              `response contains too many items (page limit ${pageSize}, collection limit ${maxItems})`,
            ),
          );
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

  private requestJsonDocument<P>(
    url: string,
    schema: z.ZodType<P>,
  ): ResultAsync<{ value: P; nextUrl: string | null }, GitHubError> {
    const headers = new Headers();
    headers.set("accept", "application/vnd.github+json");
    if (this.token !== undefined)
      headers.set("authorization", `Bearer ${this.token}`);
    return ResultAsync.fromThrowable(
      () =>
        withTimeout(
          () => this.requestFetch(url, { method: "GET", headers }),
          this.requestTimeoutMs,
        ),
      () => transportFailure(url),
    )()
      .andThen((response) => {
        if (!response.ok)
          return errAsync({
            type: "GitHubError" as const,
            operation: url,
            status: response.status,
            message: "GitHub request failed",
          });
        return ResultAsync.fromPromise(response.arrayBuffer(), () =>
          invalidResponse(url),
        ).andThen((bytes) =>
          bytes.byteLength > this.jsonResponseBytes
            ? errAsync<{ bytes: ArrayBuffer; link: string | null }, GitHubError>(
                truncatedResponse(url, "JSON response is too large"),
              )
            : okAsync({ bytes, link: response.headers.get("link") }),
        );
      })
      .andThen(({ bytes, link }) =>
        parseJsonBytes(bytes, schema, url).andThen((value) =>
          nextLink(link, url).map((nextUrl) => ({ value, nextUrl })),
        ),
      );
  }

  private repoUrl(path: string): string {
    return `${this.apiUrl}/repos/${this.repository}${path}`;
  }

  private requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
  ): ResultAsync<T, GitHubError> {
    return this.request(path, undefined, this.jsonResponseBytes).andThen(
      (response) => parseJsonBytes(response, schema, path),
    );
  }

  private requestJsonWithInit<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): ResultAsync<T, GitHubError> {
    return this.request(path, init, this.jsonResponseBytes).andThen((response) =>
      parseJsonBytes(response, schema, path),
    );
  }
  private requestAbsoluteJson<T>(
    url: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): ResultAsync<T, GitHubError> {
    return this.requestAbsolute(
      url,
      init,
      url,
      this.jsonResponseBytes,
    ).andThen((response) => parseJsonBytes(response, schema, url));
  }

  private requestAbsolute(
    url: string,
    init: RequestInit = {},
    operation = url,
    maxBytes = this.binaryResponseBytes,
  ): ResultAsync<ArrayBuffer, GitHubError> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    if (this.token !== undefined)
      headers.set("authorization", `Bearer ${this.token}`);
    return ResultAsync.fromThrowable(
      () =>
        withTimeout(
          () => this.requestFetch(url, { ...init, headers }),
          this.requestTimeoutMs,
        ),
      () => transportFailure(operation),
    )().andThen((response) => {
      if (!response.ok)
        return errAsync({
          type: "GitHubError" as const,
          operation,
          status: response.status,
          message: "GitHub request failed",
        });
      return ResultAsync.fromPromise(response.arrayBuffer(), () =>
        invalidResponse(operation),
      ).andThen((bytes) => {
        if (bytes.byteLength > maxBytes)
          return errAsync<ArrayBuffer, GitHubError>({
            type: "GitHubError",
            operation,
            message: "GitHub response is too large or truncated",
          });
        return okAsync<ArrayBuffer, GitHubError>(bytes);
      });
    });
  }

  private request(
    path: string,
    init?: RequestInit,
    maxBytes = this.binaryResponseBytes,
  ): ResultAsync<ArrayBuffer, GitHubError> {
    return this.requestAbsolute(
      `${this.apiUrl}/repos/${this.repository}${path}`,
      init,
      path,
      maxBytes,
    );
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function isFullSha(value: string): boolean {
  return GIT_OBJECT_SHA.test(value) && value !== ZERO_GIT_OID;
}

function safeGitHubPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= GITHUB_REST_READ_LIMITS.stringLength &&
    !value.startsWith("/") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("\\") &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

function decodeBase64Utf8(value: string): string | undefined {
  const normalized = value.replace(/\s/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return undefined;
  const decoded = Result.fromThrowable(
    () => atob(normalized),
    () => undefined,
  )();
  if (decoded.isErr()) return undefined;
  const bytes = Uint8Array.from(decoded.value, (character) =>
    character.charCodeAt(0),
  );
  const text = Result.fromThrowable(
    () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    () => undefined,
  )();
  return text.isOk() ? text.value : undefined;
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`GitHub request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation(), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function parseJsonBytes<T>(
  bytes: ArrayBuffer,
  schema: z.ZodType<T>,
  operation: string,
): Result<T, GitHubError> {
  if (bytes.byteLength > GITHUB_RESPONSE_BOUNDS.responseBytes)
    return err({
      type: "GitHubError",
      operation,
      message: "GitHub response is too large",
    });
  const decoded = Result.fromThrowable(
    () => JSON.parse(new TextDecoder().decode(bytes)),
    () => invalidResponse(operation),
  )();
  if (decoded.isErr()) return err(decoded.error);
  const parsed = schema.safeParse(decoded.value);
  return parsed.success ? ok(parsed.data) : err(invalidResponse(operation));
}

function transportFailure(operation: string): GitHubError {
  return {
    type: "GitHubError",
    operation,
    message: "GitHub request failed before a response was received",
  };
}

function completeGitHubRequest(
  operation: string,
): ResultAsync<void, GitHubError> {
  return ResultAsync.fromPromise(Promise.resolve(), () =>
    invalidResponse(operation),
  );
}

function parseWorkflowRun(
  value: WorkflowRunResponse,
): WorkflowRunMetadata | undefined {
  const separator = value.path.lastIndexOf("@");
  if (separator <= 0) return;
  return {
    repositoryId: value.repository.id,
    id: value.id,
    runAttempt: value.run_attempt,
    event: value.event,
    headRef: value.head_branch,
    headSha: value.head_sha,
    conclusion: value.conclusion ?? null,
    workflowPath: value.path.slice(0, separator),
    workflowSha: value.path.slice(separator + 1),
  };
}

function parseWorkflowJob(value: WorkflowJobResponse): WorkflowJobMetadata {
  return {
    id: value.id,
    name: value.name,
    conclusion: value.conclusion ?? null,
  };
}

function parseArtifact(value: ArtifactResponse): ActionsArtifactMetadata {
  return {
    id: value.id,
    name: value.name,
    digest: value.digest,
    expired: value.expired,
    sizeInBytes: value.size_in_bytes,
  };
}
function parseRelease(value: ReleaseResponse): GitHubRelease {
  return {
    id: value.id,
    tag: value.tag_name,
    targetSha: value.target_commitish,
    notes: value.body,
    draft: value.draft,
    immutable: value.immutable,
    assets: value.assets.map(parseReleaseAsset),
  };
}
function parseReleaseAsset(value: ReleaseAssetResponse): GitHubReleaseAsset {
  return {
    id: value.id,
    name: value.name,
    size: value.size,
    digest: value.digest,
  };
}

function parsePullRequestPage(
  value: readonly PullRequestResponse[],
  _operation: string,
): Result<{ items: readonly GitHubPullRequestSummary[] }, GitHubError> {
  return ok({ items: value.map(parsePullRequest) });
}

function parsePullRequest(
  value: PullRequestResponse,
): GitHubPullRequestSummary {
  return {
    number: value.number,
    url: value.html_url,
    state: value.state,
    merged: value.merged_at !== null,
    mergeCommitSha: value.merge_commit_sha,
    headRef: value.head.ref,
    headSha: value.head.sha,
    baseRef: value.base.ref,
    title: value.title,
    body: value.body,
    labels: value.labels.map((label) => label.name),
  };
}

function toPullRequestWriteError(
  operation: string,
): (error: GitHubError) => GitHubPullRequestWriteError {
  // A response the client never saw may still have been applied server-side.
  return (error) =>
    error.status === undefined
      ? ambiguousPullRequestWrite(
          operation,
          "GitHub request outcome was not observed",
        )
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
  errors: readonly GraphqlError[],
  ref: string,
  expectedSha: string,
): Extract<GitHubRefWriteError, { type: "ReferenceLeaseLost" }> | undefined {
  for (const error of errors) {
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

function graphqlErrorMessage(errors: readonly GraphqlError[]): string {
  return errors.length === 0
    ? "invalid GitHub GraphQL response"
    : "GitHub GraphQL mutation failed";
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
    if (
      check.appId !== undefined &&
      (!Number.isSafeInteger(check.appId) || check.appId <= 0)
    )
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
  value: ProtectionChecksResponse,
  operation: string,
  bounds: GreenMainHeadBounds,
): ResultAsync<readonly RequiredCheck[], GitHubError> {
  const fromChecks = value.checks.map((entry) => parseNamedCheck(entry));
  const named = new Set(fromChecks.map((check) => check.name));
  const fromContexts = value.contexts.flatMap((context) =>
    named.has(context) ? [] : [{ name: context, source: "either" as const }],
  );
  return mergeRequiredChecks(
    [...fromChecks, ...fromContexts],
    operation,
    bounds,
  ).orElse((error) =>
    error.message === "main has no required checks"
      ? okAsync<readonly RequiredCheck[], GitHubError>([])
      : errAsync<readonly RequiredCheck[], GitHubError>(error),
  );
}

function parseRuleChecks(
  value: readonly RuleResponse[],
  operation: string,
  bounds: GreenMainHeadBounds,
): ResultAsync<readonly RequiredCheck[], GitHubError> {
  const checks: RequiredCheck[] = [];
  for (const rule of value) {
    if (rule.type !== "required_status_checks") continue;
    const required = rule.parameters?.required_status_checks;
    if (required === undefined) return errAsync(invalidResponse(operation));
    checks.push(...required.map((entry) => parseNamedCheck(entry)));
  }
  return mergeRequiredChecks(checks, operation, bounds).orElse((error) =>
    error.message === "main has no required checks"
      ? okAsync<readonly RequiredCheck[], GitHubError>([])
      : errAsync<readonly RequiredCheck[], GitHubError>(error),
  );
}

function parseNamedCheck(value: NamedCheckResponse): RequiredCheck {
  const appId = value.app_id ?? value.integration_id;
  const check: RequiredCheck = {
    name: value.context,
    source: appId === undefined || appId === null ? "either" : "check-run",
  };
  if (appId !== undefined && appId !== null) check.appId = appId;
  return check;
}

function parseCommitStatusPage(
  value: readonly CommitStatusResponse[],
  _operation: string,
): Result<{ items: readonly CommitStatusReading[] }, GitHubError> {
  return ok({ items: value.map(parseCommitStatus) });
}

function parseCommitStatus(value: CommitStatusResponse): CommitStatusReading {
  return {
    context: value.context,
    state: value.state,
    updatedAt: value.updated_at ?? value.created_at ?? "",
  };
}

function parseCheckRunPage(
  value: z.infer<typeof CheckRunsResponseSchema>,
  _operation: string,
): Result<
  { items: readonly CheckRunReading[]; totalCount?: number },
  GitHubError
> {
  return ok({
    items: value.check_runs.map(parseCheckRun),
    totalCount: value.total_count,
  });
}

function parseCheckRun(value: CheckRunResponse): CheckRunReading {
  const check: CheckRunReading = {
    name: value.name,
    status: value.status,
    conclusion: value.conclusion ?? null,
    startedAt: value.started_at ?? "",
    id: value.id ?? 0,
  };
  const appId = value.app?.id;
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
  return ok(void 0);
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
  return ok(void 0);
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
  return ok(void 0);
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
