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

export interface ActionsArtifactMetadata {
  id: number;
  name: string;
  digest?: string;
  expired: boolean;
  sizeInBytes: number;
}

export interface GitHubClient {
  getWorkflowRun(runId: number): ResultAsync<WorkflowRunMetadata, GitHubError>;
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

export type GitHubFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Minimal REST client; callers inject fetch in tests so no live GitHub is needed. */
export class GitHubRestClient implements GitHubClient, GitHubRefClient {
  constructor(
    private readonly repository: string,
    private readonly token?: string,
    private readonly requestFetch: GitHubFetch = fetch,
  ) {}

  getWorkflowRun(runId: number): ResultAsync<WorkflowRunMetadata, GitHubError> {
    return this.requestJson(`/actions/runs/${runId}`).andThen((value) => {
      const run = parseWorkflowRun(value);
      if (run === undefined)
        return errAsync(invalidResponse(`/actions/runs/${runId}`));
      return okAsync(run);
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

  private requestJson(path: string): ResultAsync<unknown, GitHubError> {
    return this.request(path).andThen((response) =>
      ResultAsync.fromPromise(
        Promise.resolve(JSON.parse(new TextDecoder().decode(response))),
        () => invalidResponse(path),
      ),
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
      this.requestFetch(
        `https://api.github.com/repos/${this.repository}${path}`,
        { ...init, headers },
      ),
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
    !isString(value.conclusion)
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
