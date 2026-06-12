/**
 * GitHub REST Contents API publisher for eval result bundles.
 *
 * Publishes sanitized eval bundle files to an external GitHub repository
 * using the GitHub REST API `/repos/{owner}/{repo}/contents/{path}` endpoint.
 * The token is passed only as an `Authorization` HTTP request header — it
 * never appears in command-line arguments, shell interpolation, log messages,
 * or serialized error output.
 *
 * # Target layout
 *
 * Files are written under:
 *
 *   `runs/<bundleDirName>/<fileName>`
 *
 * where `bundleDirName` is the deterministic `<sha7>-<YYYY-MM-DD>` directory
 * name already computed by `ArtifactBundleWriter`, and `<fileName>` is one of
 * the sanitized bundle files (e.g. `bundle-index.json`, `run-summary.json`).
 *
 * Example for bundle directory `abc1234-2026-06-11`:
 *
 *   runs/abc1234-2026-06-11/bundle-index.json
 *   runs/abc1234-2026-06-11/run-summary.json
 *   runs/abc1234-2026-06-11/score-loom-routing.json
 *   runs/abc1234-2026-06-11/score-tapestry-execution.json
 *   runs/abc1234-2026-06-11/prompt-hashes.json
 *   runs/abc1234-2026-06-11/provenance-manifest.json
 *
 * The `runs/` prefix keeps all eval run artifacts under a single directory in
 * the target repository, making it easy to list all historical runs with a
 * single directory listing API call.
 *
 * # Security invariants
 *
 *   - Token is only placed in the `Authorization: Bearer <token>` HTTP header.
 *   - Token is never interpolated into any string logged by `logger`.
 *   - Token is never included in any error message returned to the caller.
 *   - Token is never serialized to disk or included in artifact content.
 *   - `fetch()` is used directly; no git subprocess is spawned.
 *   - The `Authorization` header is excluded from logged request metadata.
 *
 * # Retry behaviour
 *
 * Each file upload is attempted once. On HTTP errors (4xx, 5xx), the error
 * type and status code are included in the typed `ResultsRepoError`. On
 * network failures, the error is wrapped and returned without rethrowing.
 *
 * # Test doubles
 *
 * The `fetchImpl` constructor parameter replaces the default `fetch`. Inject a
 * stub in tests to return controlled HTTP responses without any real network
 * call. The stub receives the same `Request` object passed to the real `fetch`.
 *
 * See also: `results-repo.ts` for the `ResultsRepoPublisher` interface and
 * the `StubResultsRepoPublisher` test double.
 */

import { basename, join } from "node:path";
import { logger } from "@weave/engine";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { EVAL_RESULTS_REPO_TOKEN_ENV_VAR } from "./artifact-bundle.js";
import {
  enforcePublishPolicy,
  type PublishBundleRequest,
  type PublishBundleResult,
  type ResultsRepoPublisher,
} from "./results-repo.js";
import type { ResultsRepoError } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The GitHub repository to publish eval results to.
 * Format: `<owner>/<repo>`.
 */
export const TARGET_REPO = "weave-io/weave-agent-evals";

/**
 * The default branch to write files to.
 */
export const TARGET_BRANCH = "main";

/**
 * The prefix under which all run bundles are written in the target repo.
 * Files land at `runs/<bundleDirName>/<fileName>`.
 */
export const TARGET_RUNS_PREFIX = "runs";

/**
 * GitHub REST API base URL.
 */
const GITHUB_API_BASE = "https://api.github.com";

// ---------------------------------------------------------------------------
// Internal fetch type
// ---------------------------------------------------------------------------

/**
 * Minimal fetch interface — compatible with the global `fetch` signature.
 * Injected in tests to avoid real network calls.
 */
export type FetchImpl = (input: Request) => Promise<Response>;

/**
 * File reader function type.
 *
 * Reads a file at the given absolute path and returns its content as a string.
 * The default implementation uses `Bun.file(path).text()`.
 * Injected in tests to avoid real file-system reads.
 */
export type FileReader = (path: string) => Promise<string>;

// ---------------------------------------------------------------------------
// GitHubContentsPublisher
// ---------------------------------------------------------------------------

/**
 * Publishes sanitized eval bundle files to `weave-io/weave-agent-evals` via
 * the GitHub REST Contents API.
 *
 * ## Usage
 *
 * ```ts
 * const publisher = new GitHubContentsPublisher();
 * const result = await publisher.publish({
 *   bundle,
 *   localBundleDir: "/path/to/eval-bundles/abc1234-2026-06-11",
 *   env: { EVAL_RESULTS_REPO_TOKEN: "ghp_..." },
 * });
 * ```
 *
 * ## Security
 *
 *   - Token is read from `EVAL_RESULTS_REPO_TOKEN` in the supplied `env` map.
 *   - Token is placed ONLY in the `Authorization: Bearer` HTTP header.
 *   - Token value is never included in error messages or log output.
 *   - Log entries record only the file path and HTTP status code.
 *
 * ## Publish layout
 *
 * Files are written to:
 *   `runs/<bundleDirName>/<fileName>`
 *
 * where `bundleDirName` is derived from the local bundle directory name
 * (the last path segment of `localBundleDir`), and `<fileName>` is each
 * file listed in `request.fileNames` (or all `.json` files discovered
 * from the bundle).
 */
export class GitHubContentsPublisher implements ResultsRepoPublisher {
  private readonly log = logger.child({ module: "github-contents-publisher" });

  constructor(
    /**
     * Optional fetch implementation override.
     * Defaults to the global `fetch`. Inject in tests for isolation.
     */
    private readonly fetchImpl: FetchImpl = (req) => fetch(req),
    /**
     * Optional file reader override.
     * Defaults to reading via `Bun.file(path).text()`.
     * Inject in tests to provide file content without real disk reads.
     */
    private readonly fileReader: FileReader = (path) => Bun.file(path).text(),
  ) {}

  publish(
    request: PublishBundleRequest,
  ): ResultAsync<PublishBundleResult, ResultsRepoError> {
    const env = request.env ?? Bun.env;

    // Read token from env — never log the token value
    const rawToken = env[EVAL_RESULTS_REPO_TOKEN_ENV_VAR];
    if (rawToken === undefined || rawToken.trim() === "") {
      return new ResultAsync(
        Promise.resolve(
          err<PublishBundleResult, ResultsRepoError>({
            type: "TokenMissing",
            envVar: EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
            message:
              `${EVAL_RESULTS_REPO_TOKEN_ENV_VAR} is required for external bundle publication but was not set. ` +
              `Set this environment variable to a valid repository token before publishing. ` +
              `For local-only writes, use WEAVE_EVAL_PUBLISH_MODE=local (the default).`,
          }),
        ),
      );
    }

    // Token is validated: trim whitespace, but never log the value
    const token = rawToken.trim();

    // Enforce publish policy: dry-run, score files, sanitization
    return enforcePublishPolicy(request.bundle).andThen(() =>
      ResultAsync.fromPromise(
        this.publishFiles(request, token),
        (cause): ResultsRepoError => {
          // Convert any uncaught thrown value to a typed ResultsRepoError.
          // This should not normally occur since publishFiles returns a Result,
          // but this is a safety net for unexpected throws.
          if (cause instanceof Error) {
            return { type: "PublishFailed", message: cause.message };
          }
          if (
            typeof cause === "object" &&
            cause !== null &&
            "message" in cause
          ) {
            return {
              type: "PublishFailed",
              message: String((cause as Record<string, unknown>).message),
            };
          }
          return { type: "PublishFailed", message: String(cause) };
        },
      ).andThen((r) => r),
    );
  }

  // ---------------------------------------------------------------------------
  // Private: file upload orchestration
  // ---------------------------------------------------------------------------

  private async publishFiles(
    request: PublishBundleRequest,
    token: string,
  ): Promise<Result<PublishBundleResult, ResultsRepoError>> {
    const bundleDir = request.localBundleDir;
    // Derive the remote path prefix from the local bundle dir name using
    // `basename()` for separator-agnostic normalization (handles both / and \).
    // e.g. "/workspace/eval-bundles/abc1234-2026-06-11" → "abc1234-2026-06-11"
    const bundleDirName = basename(bundleDir) || "unknown";
    const remotePrefix = `${TARGET_RUNS_PREFIX}/${bundleDirName}`;

    // Determine which files to publish.
    // Requirement: only sanitized bundle files from the bundle dir; never raw/.
    const fileNames =
      request.fileNames ?? (await this.discoverBundleFiles(bundleDir));

    // Filter: never include anything under raw/ subdirectory (handles both / and \ separators)
    const safeFileNames = fileNames.filter(
      (f) =>
        !f.includes("raw/") &&
        !f.includes("raw\\") &&
        !f.startsWith("raw/") &&
        !f.startsWith("raw\\"),
    );

    // Fail-closed: if no publishable files remain after filtering, return a typed error.
    // Returning success with filesPublished: 0 would silently swallow publication failures
    // (e.g. all files were under raw/, bundle dir was empty, or discovery returned nothing).
    // A non-dry-run bundle with no publishable files is always an error.
    if (safeFileNames.length === 0) {
      return err({
        type: "PublishFailed" as const,
        message:
          `No publishable files found in bundle directory "${bundleDir}". ` +
          `The bundle must contain at least one non-raw JSON file to publish. ` +
          `Ensure the bundle was written successfully before publishing.`,
      });
    }

    this.log.info(
      { bundleDirName, remotePrefix, fileCount: safeFileNames.length },
      "Starting bundle publication to GitHub repository",
    );

    let filesPublished = 0;
    let lastSha: string | null = null;

    for (const fileName of safeFileNames) {
      const localPath = join(bundleDir, fileName);
      const remotePath = `${remotePrefix}/${fileName}`;

      const result = await this.uploadFile(localPath, remotePath, token);
      if (result.isErr()) {
        // Log the failure (without token) and propagate as typed error
        this.log.error(
          { remotePath, errorType: result.error.type },
          "File upload failed during bundle publication",
        );
        return err({
          type: "PublishFailed" as const,
          message: `Failed to upload "${remotePath}" to ${TARGET_REPO}: ${result.error.message}`,
        });
      }

      const { commitSha } = result.value;
      if (commitSha !== null) {
        lastSha = commitSha;
      }
      filesPublished++;

      this.log.info(
        { remotePath, filesPublished },
        "File published successfully",
      );
    }

    this.log.info(
      {
        bundleDirName,
        filesPublished,
        repo: TARGET_REPO,
        branch: TARGET_BRANCH,
      },
      "Bundle publication complete",
    );

    return ok({
      commitSha: lastSha,
      branch: TARGET_BRANCH,
      filesPublished,
      simulated: false,
    });
  }

  // ---------------------------------------------------------------------------
  // Private: single file upload via GitHub Contents API
  // ---------------------------------------------------------------------------

  /**
   * Upload a single file to the GitHub Contents API.
   *
   * Reads the local file content, base64-encodes it, and sends a PUT request
   * to create or update the file at `remotePath` in `TARGET_REPO`.
   *
   * The `Authorization: Bearer <token>` header is the ONLY location where
   * the token is used. It is never included in log output or error messages.
   *
   * @param localPath - Absolute path to the local file to upload.
   * @param remotePath - Repository-relative path for the remote file.
   * @param token - GitHub PAT token (treated as opaque secret).
   * @returns `ok({ commitSha })` on success; `err(ResultsRepoError)` on failure.
   */
  private async uploadFile(
    localPath: string,
    remotePath: string,
    token: string,
  ): Promise<Result<{ commitSha: string | null }, ResultsRepoError>> {
    // Read local file content
    const fileResult = await this.readLocalFile(localPath);
    if (fileResult.isErr()) {
      return err({
        type: "PublishFailed",
        message: `Could not read local file for upload: ${fileResult.error}`,
      });
    }
    const fileContent = fileResult.value;

    // Base64-encode the content (required by GitHub Contents API)
    const encodedContent = Buffer.from(fileContent).toString("base64");

    // Resolve any existing file SHA (needed for updates; omitted for creates)
    const existingSha = await this.resolveExistingFileSha(remotePath, token);

    // Build the API URL — no token in URL
    const apiUrl = `${GITHUB_API_BASE}/repos/${TARGET_REPO}/contents/${remotePath}`;

    const requestBody: Record<string, unknown> = {
      message: `chore: publish eval bundle ${remotePath}`,
      content: encodedContent,
      branch: TARGET_BRANCH,
    };

    // Include the existing file SHA when updating (required by GitHub API)
    if (existingSha !== null) {
      requestBody.sha = existingSha;
    }

    // Construct the Request object.
    // SECURITY: token is in the Authorization header ONLY — never in the URL,
    // never in the request body, never logged.
    const request = new Request(apiUrl, {
      method: "PUT",
      headers: {
        // Token is here and nowhere else
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "weave-eval-publisher/1.0",
      },
      body: JSON.stringify(requestBody),
    });

    // Execute the request — token is only visible in the Request object's
    // headers, which is not logged anywhere in this code path.
    let response: Response;
    try {
      response = await this.fetchImpl(request);
    } catch (cause) {
      return err({
        type: "PublishFailed",
        message:
          `Network error uploading "${remotePath}": ` +
          `${cause instanceof Error ? cause.message : "unknown network failure"}`,
      });
    }

    if (!response.ok) {
      // Log status code only — no response body (may contain token hints)
      return err({
        type: "PublishFailed",
        message:
          `GitHub API returned HTTP ${response.status} for "${remotePath}". ` +
          `Verify the token has write access to ${TARGET_REPO} on branch "${TARGET_BRANCH}".`,
      });
    }

    // Extract commit SHA from response for the result record
    const commitSha = await this.extractCommitSha(response);

    return ok({ commitSha });
  }

  // ---------------------------------------------------------------------------
  // Private: existing file SHA resolution (for updates)
  // ---------------------------------------------------------------------------

  /**
   * Resolve the existing blob SHA for a file path in the target repo.
   *
   * Required when updating an existing file via the GitHub Contents API — the
   * `sha` of the current blob must be supplied in the PUT request body.
   *
   * Returns `null` when the file does not exist (first-time create) or when
   * the GET request fails for any reason (fail-safe: a missing SHA on create
   * is fine; on update it will produce a 409 which we surface as PublishFailed).
   *
   * Token is passed as an `Authorization` header — never in the URL.
   */
  private async resolveExistingFileSha(
    remotePath: string,
    token: string,
  ): Promise<string | null> {
    const apiUrl = `${GITHUB_API_BASE}/repos/${TARGET_REPO}/contents/${remotePath}`;

    const request = new Request(apiUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "weave-eval-publisher/1.0",
      },
    });

    try {
      const response = await this.fetchImpl(request);
      if (response.status === 404) {
        // File does not exist — create mode
        return null;
      }
      if (!response.ok) {
        // Non-404 error — assume we cannot determine SHA; proceed with create
        return null;
      }
      const body = (await response.json()) as Record<string, unknown>;
      const sha = body.sha;
      if (typeof sha === "string" && sha.length > 0) {
        return sha;
      }
      return null;
    } catch {
      // Network or parse failure — proceed without SHA (create attempt)
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: response commit SHA extraction
  // ---------------------------------------------------------------------------

  private async extractCommitSha(response: Response): Promise<string | null> {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      const commit = body.commit as Record<string, unknown> | undefined;
      if (commit !== undefined) {
        const sha = commit.sha;
        if (typeof sha === "string") return sha;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: bundle file discovery
  // ---------------------------------------------------------------------------

  /**
   * Discover publishable bundle files in the local bundle directory.
   *
   * Returns only `.json` files at the top level of the bundle directory —
   * the `raw/` subdirectory is never included (policy: raw artifacts are
   * local-only).
   *
   * The returned names are relative to `bundleDir` (e.g. `bundle-index.json`).
   */
  private async discoverBundleFiles(bundleDir: string): Promise<string[]> {
    try {
      const glob = new Bun.Glob("*.json");
      const files: string[] = [];
      for await (const file of glob.scan({ cwd: bundleDir, onlyFiles: true })) {
        // Exclude anything under raw/ (belt-and-suspenders — glob pattern
        // already restricts to top-level *.json, but guard explicitly)
        if (!file.startsWith("raw/") && !file.includes("/raw/")) {
          files.push(file);
        }
      }
      return files;
    } catch {
      // If discovery fails, return empty list — caller will publish nothing
      // (which is safe: better than publishing wrong files)
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private: local file reading
  // ---------------------------------------------------------------------------

  private async readLocalFile(path: string): Promise<Result<string, string>> {
    return ResultAsync.fromPromise(this.fileReader(path), (cause) =>
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}
