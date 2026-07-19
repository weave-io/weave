import { errAsync, ResultAsync } from "neverthrow";
import type { GitHubError } from "./errors.js";

export interface GitHubClient {
  downloadArtifact(artifactId: number): ResultAsync<Uint8Array, GitHubError>;
  createRelease(tag: string, name: string): ResultAsync<void, GitHubError>;
  createTag(tag: string, sha: string): ResultAsync<void, GitHubError>;
}
export class GitHubRestClient implements GitHubClient {
  constructor(
    private readonly repository: string,
    private readonly token?: string,
  ) {}
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
  private request(
    path: string,
    init?: RequestInit,
  ): ResultAsync<ArrayBuffer, GitHubError> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/vnd.github+json");
    if (this.token !== undefined)
      headers.set("authorization", `Bearer ${this.token}`);
    return ResultAsync.fromPromise(
      fetch(`https://api.github.com/repos/${this.repository}${path}`, {
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
