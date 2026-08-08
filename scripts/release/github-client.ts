import { errAsync, okAsync, ResultAsync } from "neverthrow";
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

export type GitHubFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Minimal REST client; callers inject fetch in tests so no live GitHub is needed. */
export class GitHubRestClient
  implements GitHubClient, GitHubRefClient, GitHubReleaseClient
{
  constructor(
    private readonly repository: string,
    private readonly token?: string,
    private readonly requestFetch: GitHubFetch = fetch,
    private readonly apiUrl = "https://api.github.com",
  ) {}

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
