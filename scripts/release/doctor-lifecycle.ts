/**
 * Recomputes release-lock and merged-release state for the doctor.
 *
 * This collector performs bounded, read-only GitHub discovery, hands the
 * result to Task 14's own classifier, and never mutates a ref, a pull request,
 * a release, or the registry. A merged release is authoritative only when the
 * Task 14 authority reader also returns a snapshot bound to the exact requested
 * pull request; comments and workflow artifacts are never consulted.
 *
 * It lives apart from `doctor.ts` so the pure verifier and the authoritative
 * collector can be read, reviewed, and tested without each other.
 */
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { RELEASE_PR_MARKER_REF, RELEASE_REPOSITORY } from "./constants.js";
import {
  type DoctorAuthorityContext,
  type DoctorAuthorityRequest,
  readProductionReleaseAuthority,
} from "./doctor-authority.js";
import { readDurableCreationCleanup } from "./doctor-creation-cleanup.js";
import {
  type DoctorPortError,
  doctorPortError,
  resolveGitHubApiUrl,
} from "./doctor-transports.js";
import type { GitHubError } from "./errors.js";
import { type GitHubFetch, GitHubRestClient } from "./github-client.js";
import type { ReleasePlan, ReleasePlanError } from "./release-plan.js";
import {
  FULL_SHA,
  MAIN_BRANCH,
  markerRefPath,
  OWNER_GENERATION,
  parseReleasePrEnvelope,
  RELEASE_PR_LABEL,
  type ReleasePrEnvelope,
  type ReleasePrOwnership,
} from "./release-pr-contract.js";
import {
  classifyPostMergeState,
  type DiscoveredRelease,
  discoverIncompleteReleases,
  type MergedReleasePullRequestAuthority,
  type ReleaseAuthority,
  type ReleaseStateError,
  type ReleaseStatePorts,
  validateReleaseAuthority,
} from "./release-state.js";

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export interface DoctorMarkerObservation {
  readonly present: boolean;
  readonly markerSha?: string;
  readonly ownerGeneration?: string;
  readonly plannedBaseSha?: string;
  readonly openReleasePr: boolean;
  readonly associatedPullRequestSettled?: boolean;
  readonly creationPollExhausted?: boolean;
  readonly recordedCleanup?: ReleasePrOwnership | null;
  readonly markerCleanupPending?: boolean;
}

export interface DoctorMergedReleaseObservation {
  readonly state: string;
  readonly url?: string;
  readonly markerCleanupPending: boolean;
  readonly incidentAuthorizationRecordPresent?: boolean;
  readonly incidentDeprecatedVerified?: boolean;
}

export interface DoctorReleaseLifecycleObservation {
  readonly authoritative: boolean;
  readonly marker: DoctorMarkerObservation;
  readonly mergedRelease?: DoctorMergedReleaseObservation | null;
  /** Task 14's recomputed discovery is preferred over cached comments/artifacts. */
  readonly discovered?: readonly DiscoveredRelease[];
}

/**
 * Authority seam for a merged release.
 *
 * Production reads the merged commit, registry, provenance, tags, releases,
 * incident check run, and trees through the read-only Task 14 reader. Tests may
 * inject this seam to exercise classifier states without treating comments or
 * workflow artifacts as authority.
 */
export interface DoctorReleaseAuthorityRequest extends DoctorAuthorityRequest {}

export type DoctorReleaseAuthorityReader = (
  pullRequest: DoctorReleaseAuthorityRequest,
) => ResultAsync<ReleaseAuthority, ReleaseStateError>;

/** Reads the durable creation-phase cleanup record and the PR it was bound to. */
export type DoctorCreationCleanupReader = () => ResultAsync<
  { ownership: ReleasePrOwnership; pullRequestNumber: number | null } | null,
  DoctorPortError
>;

export interface DoctorLifecycleCollectorInput {
  readonly token?: string;
  readonly fetchImpl?: GitHubFetch;
  readonly apiUrl?: string;
  readonly registryFetch?: GitHubFetch;
  readonly readAuthority?: DoctorReleaseAuthorityReader;
  /** Reads a previously recorded Task 14 CreationCleanupPending record. */
  readonly readCreationCleanupIdentity?: DoctorCreationCleanupReader;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/**
 * Recomputes the release lock and merged-release state from bounded GitHub
 * reads. It performs no mutation.
 */
export function collectAuthoritativeReleaseLifecycle(
  input: DoctorLifecycleCollectorInput,
): ResultAsync<DoctorReleaseLifecycleObservation, DoctorPortError> {
  if (input.token === undefined || input.token.length === 0)
    return errAsync(
      doctorPortError(
        "release.lifecycle.credentials",
        "GITHUB_TOKEN is missing",
      ),
    );
  // The credential is attached only after the origin proves it is the official
  // GitHub API. A hostile GITHUB_API_URL is refused, never normalized.
  const apiUrl = resolveGitHubApiUrl(input.apiUrl);
  if (apiUrl.isErr()) return errAsync(apiUrl.error);
  const client = new GitHubRestClient(
    RELEASE_REPOSITORY,
    input.token,
    input.fetchImpl,
    apiUrl.value,
  );
  return ResultAsync.fromPromise(
    readAuthoritativeReleaseLifecycle(client, {
      registryFetch: input.registryFetch,
      readAuthority: input.readAuthority,
      readCreationCleanupIdentity: input.readCreationCleanupIdentity,
    }),
    (cause): DoctorPortError =>
      doctorPortError(
        "release.lifecycle",
        cause instanceof Error ? cause.message : String(cause),
      ),
  ).andThen((result) => result);
}

interface AuthoritativeLifecycleReaders {
  readonly registryFetch?: GitHubFetch;
  readonly readAuthority?: DoctorReleaseAuthorityReader;
  readonly readCreationCleanupIdentity?: DoctorCreationCleanupReader;
}

async function readAuthoritativeReleaseLifecycle(
  client: GitHubRestClient,
  readers: AuthoritativeLifecycleReaders,
): Promise<Result<DoctorReleaseLifecycleObservation, DoctorPortError>> {
  const markerResult = await client.readRefOptional(markerRefPath());
  if (markerResult.isErr())
    return err(githubLifecycleFailure("read marker ref", markerResult.error));
  const markerSha = markerResult.value;
  if (markerSha !== null && !isFullSha(markerSha))
    return err(
      lifecycleFailure(
        "read marker ref",
        "GitHub returned a malformed marker SHA",
      ),
    );

  const [openResult, closedResult] = await Promise.all([
    client.listPullRequestsForHead(RELEASE_PR_MARKER_REF, "open"),
    client.listPullRequestsForHead(RELEASE_PR_MARKER_REF, "closed"),
  ]);
  if (openResult.isErr())
    return err(
      githubLifecycleFailure("list open release PRs", openResult.error),
    );
  if (closedResult.isErr())
    return err(
      githubLifecycleFailure("list closed release PRs", closedResult.error),
    );
  if (openResult.value.length > 1)
    return err(
      lifecycleFailure(
        "list open release PRs",
        "GitHub returned more than one open stable release PR",
      ),
    );
  const openPull = openResult.value[0];

  let markerEnvelope: ReleasePrEnvelope | undefined;
  if (markerSha !== null) {
    const messageResult = await client.readCommitMessage(markerSha);
    if (messageResult.isErr())
      return err(
        githubLifecycleFailure("read marker commit", messageResult.error),
      );
    const parsed = parseReleasePrEnvelope(messageResult.value);
    if (parsed.isErr())
      return err(
        lifecycleFailure(
          "read marker commit",
          `marker ownership envelope is invalid (${parsed.error.type})`,
        ),
      );
    if (parsed.value.ref !== RELEASE_PR_MARKER_REF)
      return err(
        lifecycleFailure(
          "read marker commit",
          "marker ownership envelope names an unexpected ref",
        ),
      );
    markerEnvelope = parsed.value;
  }

  if (openPull !== undefined) {
    if (markerSha === null)
      return err(
        lifecycleFailure(
          "validate open release PR",
          "an open stable release PR was found without the marker ref",
        ),
      );
    if (
      openPull.state !== "open" ||
      openPull.merged ||
      openPull.baseRef !== MAIN_BRANCH ||
      !hasExactStableReleaseLabel(openPull.labels) ||
      openPull.headRef !== RELEASE_PR_MARKER_REF ||
      openPull.headSha !== markerSha ||
      openPull.url !== canonicalPullRequestUrl(openPull.number)
    )
      return err(
        lifecycleFailure(
          "validate open release PR",
          "open release PR identity does not match the marker ref",
        ),
      );
    const pullEnvelope = parseReleasePrEnvelope(openPull.body);
    if (
      pullEnvelope.isErr() ||
      markerEnvelope === undefined ||
      pullEnvelope.value.ownerGeneration !== markerEnvelope.ownerGeneration ||
      pullEnvelope.value.plannedBaseSha !== markerEnvelope.plannedBaseSha ||
      pullEnvelope.value.ref !== markerEnvelope.ref
    )
      return err(
        lifecycleFailure(
          "validate open release PR",
          "open release PR ownership metadata does not match the marker",
        ),
      );
  }

  const mergedPulls = closedResult.value.filter(
    (pull) =>
      pull.state === "closed" &&
      pull.merged &&
      pull.headRef === RELEASE_PR_MARKER_REF &&
      pull.baseRef === MAIN_BRANCH &&
      hasExactStableReleaseLabel(pull.labels),
  );
  const mergedAuthorities: MergedReleasePullRequestAuthority[] = [];
  const mergedByIdentity = new Map<number, (typeof mergedPulls)[number]>();
  for (const pull of mergedPulls) {
    if (pull.url !== canonicalPullRequestUrl(pull.number))
      return err(
        lifecycleFailure(
          "read merged release PR",
          `pull request #${pull.number} has a non-canonical repository URL`,
        ),
      );
    if (mergedByIdentity.has(pull.number))
      return err(
        lifecycleFailure(
          "read merged release PR",
          `GitHub returned duplicate stable release PR #${pull.number}`,
        ),
      );
    mergedByIdentity.set(pull.number, pull);
    if (
      pull.mergeCommitSha === undefined ||
      pull.mergeCommitSha === null ||
      !isFullSha(pull.mergeCommitSha)
    )
      return err(
        lifecycleFailure(
          "read merged release PR",
          `merged pull request #${pull.number} has no valid merge commit SHA`,
        ),
      );
    mergedAuthorities.push({
      number: pull.number,
      url: pull.url,
      merged: pull.merged,
      closed: pull.state === "closed",
      mergeCommitSha: pull.mergeCommitSha,
      headRef: pull.headRef,
    });
  }

  const settledMarkerPulls =
    markerSha === null
      ? []
      : closedResult.value.filter(
          (pull) =>
            pull.state === "closed" &&
            pull.headRef === RELEASE_PR_MARKER_REF &&
            pull.headSha === markerSha &&
            pull.baseRef === MAIN_BRANCH &&
            hasExactStableReleaseLabel(pull.labels),
        );
  if (settledMarkerPulls.length > 1)
    return err(
      lifecycleFailure(
        "associate settled release PR",
        "more than one exact stable release PR is associated with the live marker",
      ),
    );
  if (openPull !== undefined && settledMarkerPulls.length > 0)
    return err(
      lifecycleFailure(
        "associate settled release PR",
        "the live marker is associated with both open and closed stable release PRs",
      ),
    );
  const associatedPullRequestSettled = settledMarkerPulls.length === 1;
  const associatedPullRequestNumber =
    openPull?.number ?? settledMarkerPulls[0]?.number ?? null;

  const cleanupRecordResult = await readCreationCleanup(
    readers.readCreationCleanupIdentity ?? defaultCreationCleanupReader,
  );
  if (cleanupRecordResult.isErr()) return err(cleanupRecordResult.error);
  const cleanupRecord = cleanupRecordResult.value;
  if (cleanupRecord !== null) {
    if (!isReleasePrOwnership(cleanupRecord.ownership))
      return err(
        lifecycleFailure(
          "read creation cleanup",
          "the durable store returned a malformed CreationCleanupPending identity",
        ),
      );
    // A creation-cleanup record claims creation never produced a pull request.
    // Live GitHub evidence of an associated stable release PR contradicts the
    // durable record, and a contradiction is a failure, not a preference.
    if (associatedPullRequestNumber !== null)
      return err(
        lifecycleFailure(
          "read creation cleanup",
          `a durable CreationCleanupPending record exists while stable release PR #${associatedPullRequestNumber} is associated with the marker`,
        ),
      );
    if (
      cleanupRecord.pullRequestNumber !== null &&
      !mergedByIdentity.has(cleanupRecord.pullRequestNumber) &&
      cleanupRecord.pullRequestNumber !== associatedPullRequestNumber
    )
      return err(
        lifecycleFailure(
          "read creation cleanup",
          `the durable CreationCleanupPending record names pull request #${cleanupRecord.pullRequestNumber}, which is not an authoritative stable release PR`,
        ),
      );
  }
  const recordedCleanup = cleanupRecord?.ownership ?? null;

  const authorityContext: DoctorAuthorityContext = {
    client,
    ...(readers.registryFetch === undefined
      ? {}
      : { registryFetch: readers.registryFetch }),
    markerPresent: markerSha !== null,
    markerSha,
    associatedPullRequestSettled,
  };
  const authorityReader =
    readers.readAuthority ??
    ((request: DoctorReleaseAuthorityRequest) =>
      readProductionReleaseAuthority(authorityContext, request));

  let authority: ReleaseAuthority | undefined;
  const ports: ReleaseStatePorts = {
    listMergedStableReleasePullRequests: () => okAsync(mergedAuthorities),
    readMarkerRef: () =>
      okAsync(markerSha === null ? null : { sha: markerSha }),
    readOpenStableReleasePullRequest: () =>
      okAsync(
        openPull === undefined
          ? null
          : { number: openPull.number, url: openPull.url },
      ),
    readCreationCleanupIdentity: () => okAsync(recordedCleanup),
    readAuthority: (pullRequest) => {
      const candidate = mergedByIdentity.get(pullRequest.number);
      if (
        candidate === undefined ||
        candidate.url !== pullRequest.url ||
        candidate.mergeCommitSha !== pullRequest.mergeCommitSha ||
        candidate.headRef !== pullRequest.headRef
      )
        return errAsync<ReleaseAuthority, ReleaseStateError>({
          type: "InvalidReleaseAuthority",
          issues: [
            "the requested stable release PR is not an exact member of the authoritative closed PR set",
          ],
        });
      const request: DoctorReleaseAuthorityRequest = {
        ...pullRequest,
        labels: [...candidate.labels],
      };
      const attempted = Result.fromThrowable(
        () => authorityReader(request),
        (cause): ReleaseStateError => ({
          type: "InvalidReleaseAuthority",
          issues: [
            cause instanceof Error
              ? cause.message
              : "Task 14 authority reader failed",
          ],
        }),
      )();
      if (attempted.isErr()) return errAsync(attempted.error);
      return ResultAsync.fromPromise(
        Promise.resolve(attempted.value),
        (cause): ReleaseStateError => ({
          type: "InvalidReleaseAuthority",
          issues: [
            cause instanceof Error
              ? cause.message
              : "Task 14 authority reader failed",
          ],
        }),
      )
        .andThen((result) => result)
        .andThen((value) => {
          const bound = validateAuthorityIdentity(value, request);
          if (bound.isErr())
            return errAsync<ReleaseAuthority, ReleaseStateError>(bound.error);
          authority = bound.value;
          return okAsync<ReleaseAuthority, ReleaseStateError>(bound.value);
        });
    },
    recomputePlan: (planInput) =>
      errAsync<ReleasePlan, ReleasePlanError>({
        type: "InvalidRecomputeRef",
        ref: planInput.releasedSha,
      }),
  };
  const discoveredResult = await discoverIncompleteReleases(ports);
  if (discoveredResult.isErr())
    return err(lifecycleStateFailure(discoveredResult.error));

  let mergedRelease: DoctorMergedReleaseObservation | null = null;
  if (authority !== undefined) {
    const classified = classifyPostMergeState(authority);
    if (classified.isErr()) return err(lifecycleStateFailure(classified.error));
    mergedRelease = {
      state: classified.value.primary,
      url: authority.pullRequest.url,
      markerCleanupPending: classified.value.markerCleanupPending,
      incidentAuthorizationRecordPresent: authority.incident !== null,
      incidentDeprecatedVerified:
        authority.incident?.deprecationsMatch ?? undefined,
    };
  }

  return ok({
    authoritative: true,
    marker: {
      present: markerSha !== null,
      ...(markerSha === null ? {} : { markerSha }),
      ...(markerEnvelope === undefined
        ? {}
        : {
            ownerGeneration: markerEnvelope.ownerGeneration,
            plannedBaseSha: markerEnvelope.plannedBaseSha,
          }),
      openReleasePr: openPull !== undefined,
      ...(recordedCleanup === null ? {} : { recordedCleanup }),
      associatedPullRequestSettled,
      creationPollExhausted:
        markerSha !== null &&
        openPull === undefined &&
        !associatedPullRequestSettled,
      markerCleanupPending: markerSha !== null && associatedPullRequestSettled,
    },
    mergedRelease,
    discovered: discoveredResult.value,
  });
}

const defaultCreationCleanupReader: DoctorCreationCleanupReader = () =>
  readDurableCreationCleanup();

async function readCreationCleanup(
  reader: DoctorCreationCleanupReader,
): Promise<
  Result<
    { ownership: ReleasePrOwnership; pullRequestNumber: number | null } | null,
    DoctorPortError
  >
> {
  const attempted = Result.fromThrowable(
    () => reader(),
    (cause): DoctorPortError =>
      doctorPortError(
        "release.lifecycle.creation-cleanup",
        cause instanceof Error ? cause.message : String(cause),
      ),
  )();
  if (attempted.isErr()) return err(attempted.error);
  return ResultAsync.fromPromise(
    Promise.resolve(attempted.value),
    (cause): DoctorPortError =>
      doctorPortError(
        "release.lifecycle.creation-cleanup",
        cause instanceof Error ? cause.message : String(cause),
      ),
  ).andThen((result) => result);
}

// ---------------------------------------------------------------------------
// Identity binding
// ---------------------------------------------------------------------------

export function canonicalPullRequestUrl(number: number): string {
  return `https://github.com/${RELEASE_REPOSITORY}/pull/${number}`;
}

function hasExactStableReleaseLabel(labels: readonly string[]): boolean {
  return (
    labels.filter((label) => label === RELEASE_PR_LABEL).length === 1 &&
    labels.every((label) => label.length <= 256)
  );
}

function isReleasePrOwnership(value: unknown): value is ReleasePrOwnership {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return (
    record !== undefined &&
    record.ref === RELEASE_PR_MARKER_REF &&
    typeof record.ownerGeneration === "string" &&
    OWNER_GENERATION.test(record.ownerGeneration) &&
    isFullSha(record.expectedMarkerSha) &&
    isFullSha(record.plannedBaseSha)
  );
}

/** Binds a Task 14 authority snapshot to the exact pull request requested. */
export function validateAuthorityIdentity(
  input: unknown,
  request: DoctorReleaseAuthorityRequest,
): Result<ReleaseAuthority, ReleaseStateError> {
  const validated = validateReleaseAuthority(input);
  if (validated.isErr()) return err(validated.error);
  const authority = validated.value;
  const expectedUrl = canonicalPullRequestUrl(request.number);
  const actual = authority.pullRequest;
  const issues: string[] = [];
  if (actual.number !== request.number)
    issues.push("pull request number mismatch");
  if (actual.url !== expectedUrl || request.url !== expectedUrl)
    issues.push("pull request URL/repository mismatch");
  if (!actual.merged || !actual.closed || !request.merged || !request.closed)
    issues.push("stable release pull request is not merged and closed");
  if (actual.mergeCommitSha !== request.mergeCommitSha)
    issues.push("merge commit SHA mismatch");
  if (authority.releasedSha !== request.mergeCommitSha)
    issues.push("released SHA does not match the requested merge commit");
  if (
    actual.headRef !== RELEASE_PR_MARKER_REF ||
    request.headRef !== RELEASE_PR_MARKER_REF
  )
    issues.push("stable release head ref mismatch");
  if (!hasExactStableReleaseLabel(request.labels))
    issues.push("stable release label is missing or ambiguous");
  if (issues.length > 0)
    return err({ type: "InvalidReleaseAuthority", issues });
  return ok(authority);
}

// ---------------------------------------------------------------------------
// Failure shaping
// ---------------------------------------------------------------------------

export function unavailableReleaseLifecycle(): DoctorReleaseLifecycleObservation {
  return {
    authoritative: false,
    marker: { present: false, openReleasePr: false },
    discovered: [],
  };
}

function lifecycleFailure(operation: string, message: string): DoctorPortError {
  return doctorPortError(`release.lifecycle.${operation}`, message);
}

function githubLifecycleFailure(
  operation: string,
  error: GitHubError,
): DoctorPortError {
  return lifecycleFailure(
    operation,
    error.status === undefined
      ? error.message
      : `${error.status}: ${error.message}`,
  );
}

function lifecycleStateFailure(error: ReleaseStateError): DoctorPortError {
  if (error.type === "GitHubError")
    return githubLifecycleFailure("state", error);
  if (error.type === "InvalidReleaseAuthority")
    return lifecycleFailure("state", error.issues.join("; "));
  if (error.type === "PlanRecomputeFailed")
    return lifecycleFailure(
      "state",
      `plan recomputation failed (${error.error.type})`,
    );
  return lifecycleFailure(
    "state",
    `Task 14 state is unverifiable (${error.type})`,
  );
}

function isFullSha(value: unknown): value is string {
  return (
    typeof value === "string" &&
    FULL_SHA.test(value) &&
    value !== "0".repeat(40)
  );
}
