/**
 * GitHub REST Contents API publisher for eval result bundles.
 *
 * Publishes sanitized eval bundle files to an external GitHub repository
 * using the GitHub REST API `/repos/{owner}/{repo}/contents/{path}` endpoint.
 * The token is passed only as an `Authorization` HTTP request header — it
 * never appears in command-line arguments, shell interpolation, log messages,
 * or serialized error output.
 *
 * # Remote v1 layout
 *
 * All paths in `weave-io/weave-agent-evals` are versioned under a `v1/`
 * segment to allow future breaking changes without destroying existing content.
 *
 * ## Immutable run artifacts
 *
 * Files are written to:
 *
 *   `runs/v1/<runId>/<fileName>`
 *
 * where `<runId>` is the deterministic `<sha7>-<YYYY-MM-DD>-<NNN>` identifier
 * already computed by `ArtifactBundleWriter`, and `<fileName>` must be one of
 * the values in `RUN_ARTIFACT_ALLOWLIST`. No other file names are accepted.
 *
 * Immutable run artifacts are written ONCE and NEVER overwritten. A re-publish
 * of the same run ID is rejected (the GitHub Contents API returns HTTP 422 when
 * SHA is mismatched, which surfaces as `PublishFailed`).
 *
 * Example for run ID `abc1234-2026-06-11-001`:
 *
 *   runs/v1/abc1234-2026-06-11-001/bundle-index.json
 *   runs/v1/abc1234-2026-06-11-001/public-report.json
 *   runs/v1/abc1234-2026-06-11-001/public-report.md
 *
 * `bundle-index.json` enumerates only the allowlisted public files present in
 * that run. It MUST NOT list raw files, non-public artifacts, or files outside
 * `RUN_ARTIFACT_ALLOWLIST`. Website loaders fetch known exact paths
 * (`bundle-index.json` → listed files) — they MUST NOT walk directories.
 *
 * ## Derived index artifacts
 *
 * Index files are written to:
 *
 *   `indexes/v1/<fileName>`
 *
 * where `<fileName>` must be permitted by `isIndexArtifactAllowed()`.
 * The function accepts:
 *   - Exact names: `dashboard-manifest.json`, `latest.json`, `last-N-runs.json`.
 *   - Pattern: `suite-history-<suiteName>.json` (per-suite history).
 *   - Pattern: `model-comparison-<runId>.json` (per-run model comparison).
 *   - Pattern: `scenario-history-<suiteName>.json` (per-suite scenario history).
 * All other names (including any containing `/`, `\`, or `..`) are rejected.
 * Index artifacts are mutable — they are updated atomically after each
 * successful run publication. They are ALWAYS written AFTER all immutable run
 * artifacts for the current run are committed.
 *
 * Example index files:
 *
 *   indexes/v1/dashboard-manifest.json
 *   indexes/v1/latest.json
 *   indexes/v1/last-N-runs.json
 *   indexes/v1/suite-history-loom-routing.json
 *   indexes/v1/model-comparison-abc1234-2026-06-11-001.json
 *   indexes/v1/scenario-history-loom-routing.json
 *
 * Website consumers MUST fetch specific known paths — they MUST NOT enumerate
 * the `indexes/v1/` directory. The exact paths to fetch are declared by the
 * `dashboard-manifest.json` entry point.
 *
 * ## Publish-before-index invariant
 *
 * `publishFiles()` enforces the following ordering contract:
 *   1. All immutable run artifact files (`runs/v1/<runId>/*`) are uploaded first.
 *   2. Only after all run artifacts are committed are index files uploaded.
 *
 * This guarantees that any consumer fetching `indexes/v1/dashboard-manifest.json`
 * will always find complete run artifacts for every run listed in the manifest.
 *
 * # Security invariants
 *
 *   - Token is read from `EVAL_RESULTS_REPO_TOKEN` in the supplied `env` map.
 *   - Token is only placed in the `Authorization: Bearer <token>` HTTP header.
 *   - Token is never interpolated into any string logged by `logger`.
 *   - Token is never included in any error message returned to the caller.
 *   - Token is never serialized to disk or included in artifact content.
 *   - `fetch()` is used directly; no git subprocess is spawned.
 *   - The `Authorization` header is excluded from logged request metadata.
 *   - Error messages are redacted: HTTP response bodies are never surfaced,
 *     only the HTTP status code. Network error `.message` is bounded.
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
import {
  EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
  type RemoteSequenceReader,
} from "./artifact-bundle.js";
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
 * Layout version segment used in all remote paths.
 *
 * Changing this constant migrates all remote paths to a new version without
 * touching existing content. Current layout:
 *   - Run artifacts:  `runs/v1/<runId>/<fileName>`
 *   - Index artifacts: `indexes/v1/<fileName>`
 */
export const REMOTE_LAYOUT_VERSION = "v1";

/**
 * The prefix under which all immutable run bundles are written in the target repo.
 * Files land at `runs/v1/<runId>/<fileName>`.
 */
export const TARGET_RUNS_PREFIX = `runs/${REMOTE_LAYOUT_VERSION}`;

/**
 * The prefix under which all derived index files are written in the target repo.
 * Files land at `indexes/v1/<fileName>`.
 */
export const TARGET_INDEXES_PREFIX = `indexes/${REMOTE_LAYOUT_VERSION}`;

/**
 * Allowlist of file names permitted in immutable run artifact directories.
 *
 * Only these exact file names may appear under `runs/v1/<runId>/`.
 * Any file name NOT in this set is rejected before any upload attempt.
 *
 * Rationale:
 *   - Prevents accidental publication of raw artifacts (e.g. `raw/*.json`).
 *   - Prevents publication of internal bundle files not intended for public
 *     consumption (e.g. `score-*.json`, `provenance-manifest.json`).
 *   - `bundle-index.json` must enumerate only allowlisted files.
 *   - Website loaders MUST NOT walk directories; they fetch known exact paths.
 *
 * To add a new public file: add it here AND update the
 * `INDEX_ARTIFACT_ALLOWLIST` if it is an index-level file.
 */
export const RUN_ARTIFACT_ALLOWLIST: ReadonlySet<string> = new Set([
  "bundle-index.json",
  "public-report.json",
  "public-report.md",
]);

/**
 * Exact file names always permitted in the derived index directory.
 *
 * Website consumers MUST NOT enumerate `indexes/v1/`; they fetch exact known
 * paths starting from `dashboard-manifest.json`.
 */
export const INDEX_ARTIFACT_EXACT_ALLOWLIST: ReadonlySet<string> = new Set([
  "dashboard-manifest.json",
  "latest.json",
  "last-N-runs.json",
]);

/**
 * Pattern for per-suite history index files.
 *
 * Matches: `suite-history-<suiteName>.json`
 * where `<suiteName>` contains only word characters, hyphens, and dots.
 */
export const SUITE_HISTORY_INDEX_PATTERN =
  /^suite-history-[a-zA-Z0-9][\w.-]*\.json$/;

/**
 * Pattern for per-run model comparison index files.
 *
 * Matches: `model-comparison-<runId>.json`
 * where `<runId>` has the form `<sha7>-<YYYY-MM-DD>-<NNN>` or similar
 * safe identifiers containing only word characters, hyphens, and dots.
 */
export const MODEL_COMPARISON_INDEX_PATTERN =
  /^model-comparison-[a-zA-Z0-9][\w.-]*\.json$/;

/**
 * Pattern for per-suite scenario history index files.
 *
 * Matches: `scenario-history-<suiteName>.json`
 * where `<suiteName>` contains only word characters, hyphens, and dots.
 */
export const SCENARIO_HISTORY_INDEX_PATTERN =
  /^scenario-history-[a-zA-Z0-9][\w.-]*\.json$/;

/**
 * Determine whether a file name is permitted in the derived index directory.
 *
 * Accepts:
 *   - Exact names in `INDEX_ARTIFACT_EXACT_ALLOWLIST` (dashboard-manifest.json,
 *     latest.json, last-N-runs.json).
 *   - Names matching `SUITE_HISTORY_INDEX_PATTERN` (suite-history-<suite>.json).
 *   - Names matching `MODEL_COMPARISON_INDEX_PATTERN` (model-comparison-<runId>.json).
 *   - Names matching `SCENARIO_HISTORY_INDEX_PATTERN` (scenario-history-<suite>.json).
 *
 * Rejects everything else — including names with path separators, traversal
 * segments, or arbitrary patterns.
 *
 * @param fileName - The file name to test (relative to `indexes/v1/`).
 * @returns `true` when the file is permitted for publication.
 */
export function isIndexArtifactAllowed(fileName: string): boolean {
  // Reject any name containing path separators or traversal sequences —
  // index file names must be flat (no subdirectories).
  if (
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("..")
  ) {
    return false;
  }

  if (INDEX_ARTIFACT_EXACT_ALLOWLIST.has(fileName)) return true;
  if (SUITE_HISTORY_INDEX_PATTERN.test(fileName)) return true;
  if (MODEL_COMPARISON_INDEX_PATTERN.test(fileName)) return true;
  if (SCENARIO_HISTORY_INDEX_PATTERN.test(fileName)) return true;
  return false;
}

/**
 * @deprecated Use `isIndexArtifactAllowed()` instead.
 *
 * Retained for backward compatibility with code that imports this set.
 * The set only contains the three exact allowlist members; it does not
 * cover suite-history or model-comparison patterns. Call
 * `isIndexArtifactAllowed()` for the complete allowlist check.
 */
export const INDEX_ARTIFACT_ALLOWLIST: ReadonlySet<string> =
  INDEX_ARTIFACT_EXACT_ALLOWLIST;

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
 *   localBundleDir: "/path/to/eval-bundles/runs/abc1234-2026-06-11-001",
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
 *   - Error messages are redacted: HTTP response bodies are never surfaced.
 *
 * ## Remote v1 layout
 *
 * Run artifacts are written to:
 *   `runs/v1/<runId>/<fileName>`
 *
 * Index artifacts are written to:
 *   `indexes/v1/<fileName>`
 *
 * Only files in `RUN_ARTIFACT_ALLOWLIST` (for runs) and files permitted by
 * `isIndexArtifactAllowed()` (for indexes) are uploaded. All other file names
 * are silently filtered out.
 *
 * ## Publish-before-index ordering
 *
 * All immutable run artifacts are uploaded before any index file. This invariant
 * guarantees that `indexes/v1/dashboard-manifest.json` always points to complete
 * run artifact directories.
 *
 * ## Re-publish behavior
 *
 * Re-publishing a run: index files are refreshed (new `updatedAt`, new entries)
 * while immutable run artifacts are left untouched (the GitHub Contents API will
 * reject attempts to overwrite them with mismatched SHA, surfaced as PublishFailed).
 */
export class GitHubContentsPublisher
  implements ResultsRepoPublisher, RemoteSequenceReader
{
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
        (_cause): ResultsRepoError => {
          // Convert any uncaught thrown value to a typed ResultsRepoError.
          // This should not normally occur since publishFiles returns a Result,
          // but this is a safety net for unexpected throws.
          // SECURITY: never include cause details that might contain token or secrets.
          return {
            type: "PublishFailed",
            message: "Unexpected publish error.",
          };
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
    // e.g. "/workspace/eval-bundles/runs/abc1234-2026-06-11-001" → "abc1234-2026-06-11-001"
    const bundleDirName = basename(bundleDir) || "unknown";
    const remotePrefix = `${TARGET_RUNS_PREFIX}/${bundleDirName}`;

    // Determine which files to publish.
    // Requirement: only allowlisted public artifacts from the bundle dir.
    const candidateFileNames =
      request.fileNames ?? (await this.discoverBundleFiles(bundleDir));

    // Filter 1: exclude raw/ paths (belt-and-suspenders against raw artifact leakage)
    const nonRawFileNames = candidateFileNames.filter(
      (f) =>
        !f.includes("raw/") &&
        !f.includes("raw\\") &&
        !f.startsWith("raw/") &&
        !f.startsWith("raw\\"),
    );

    // Filter 2: enforce RUN_ARTIFACT_ALLOWLIST — only approved public files
    const safeFileNames = nonRawFileNames.filter((f) =>
      RUN_ARTIFACT_ALLOWLIST.has(f),
    );

    // Fail-closed: if no publishable files remain after filtering, return a typed error.
    // Returning success with filesPublished: 0 would silently swallow publication failures.
    if (safeFileNames.length === 0) {
      return err({
        type: "PublishFailed" as const,
        message:
          `No publishable files found in bundle directory after allowlist filtering. ` +
          `The bundle must contain at least one file from the public artifact allowlist. ` +
          `Ensure the bundle was written successfully before publishing.`,
      });
    }

    this.log.info(
      { bundleDirName, remotePrefix, fileCount: safeFileNames.length },
      "Starting bundle publication to GitHub repository",
    );

    let filesPublished = 0;
    let lastSha: string | null = null;

    // --- Phase 1: Publish immutable run artifacts under runs/v1/<runId>/ ---
    // ORDERING INVARIANT: run artifacts are ALWAYS uploaded before any index files.
    // This guarantees that when an index file references a run, the run's artifacts
    // are already committed and reachable.
    for (const fileName of safeFileNames) {
      const localPath = join(bundleDir, fileName);
      const remotePath = `${remotePrefix}/${fileName}`;

      // Immutable run artifacts must never overwrite an existing remote file.
      // If the same run ID is re-published, uploadFile rejects with PublishFailed.
      const result = await this.uploadFile(
        localPath,
        remotePath,
        token,
        "immutable",
      );
      if (result.isErr()) {
        // Log the failure (without token) and propagate as typed error.
        // Error message is already redacted by uploadFile.
        this.log.error(
          { remotePath, errorType: result.error.type },
          "File upload failed during bundle publication",
        );
        return err({
          type: "PublishFailed" as const,
          message: `Failed to upload run artifact to ${TARGET_REPO}. Check token permissions or whether this run ID was already published.`,
        });
      }

      const { commitSha } = result.value;
      if (commitSha !== null) {
        lastSha = commitSha;
      }
      filesPublished++;

      this.log.info(
        { remotePath, filesPublished },
        "Run artifact published successfully",
      );
    }

    // --- Phase 2: Publish index artifacts under indexes/v1/ ---
    // Index files are derived from immutable run artifacts and are published
    // AFTER the immutable run artifacts to maintain the ordering invariant.
    // Only allowlisted index file names are uploaded.
    // Index upload failures are non-fatal — the immutable run artifacts are
    // already committed and the indexes will be refreshed on the next run.
    if (
      request.localBundleRoot !== undefined &&
      request.indexFileNames !== undefined &&
      request.indexFileNames.length > 0
    ) {
      // Filter to only allowlisted index file names (exact matches + patterns)
      const allowlistedIndexNames = request.indexFileNames.filter((f) =>
        isIndexArtifactAllowed(f),
      );

      if (allowlistedIndexNames.length > 0) {
        this.log.info(
          { indexFileCount: allowlistedIndexNames.length },
          "Publishing index artifacts under indexes/v1/",
        );

        for (const indexFileName of allowlistedIndexNames) {
          const localPath = join(request.localBundleRoot, indexFileName);
          // Index files are published under the versioned indexes prefix
          const remotePath = `${TARGET_INDEXES_PREFIX}/${indexFileName}`;

          // Index files are mutable — they are updated atomically after each
          // successful run publication using the existing blob SHA from the GET.
          const result = await this.uploadFile(
            localPath,
            remotePath,
            token,
            "mutable",
          );
          if (result.isErr()) {
            this.log.error(
              { remotePath, errorType: result.error.type },
              "Index artifact upload failed",
            );
            // Non-fatal: indexes are always re-generated from immutable run artifacts.
            this.log.warn(
              { remotePath },
              "Continuing after index upload failure; indexes will be refreshed on next publish",
            );
            continue;
          }

          const { commitSha } = result.value;
          if (commitSha !== null) {
            lastSha = commitSha;
          }
          filesPublished++;

          this.log.info(
            { remotePath, filesPublished },
            "Index artifact published successfully",
          );
        }
      }
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
   * ## Upload modes
   *
   * - `"immutable"` — for run artifacts under `runs/v1/<runId>/`. The file
   *   MUST NOT already exist. If the remote file is found (GET returns 200),
   *   the upload is rejected with `PublishFailed` before any PUT is issued.
   *   This enforces that run artifacts are written exactly once and never
   *   silently overwritten.
   *
   * - `"mutable"` — for derived index files under `indexes/v1/`. The existing
   *   remote SHA is resolved and included in the PUT so the file is atomically
   *   updated in place (GitHub Contents API requires the current blob SHA for
   *   updates).
   *
   * SECURITY: Error messages returned by this method are redacted:
   *   - HTTP response bodies are never included (may contain server-side hints).
   *   - Network error `.message` is included only for connection diagnostic purposes.
   *   - The token value never appears in any returned string.
   *
   * @param localPath - Absolute path to the local file to upload.
   * @param remotePath - Repository-relative path for the remote file.
   * @param token - GitHub PAT token (treated as opaque secret).
   * @param mode - `"immutable"` (fail if exists) or `"mutable"` (update if exists).
   * @returns `ok({ commitSha })` on success; `err(ResultsRepoError)` on failure.
   */
  private async uploadFile(
    localPath: string,
    remotePath: string,
    token: string,
    mode: "immutable" | "mutable",
  ): Promise<Result<{ commitSha: string | null }, ResultsRepoError>> {
    // Read local file content
    const fileResult = await this.readLocalFile(localPath);
    if (fileResult.isErr()) {
      // Do not include file content or path details in the error — the path
      // itself may embed run IDs or other metadata. Just signal the failure type.
      return err({
        type: "PublishFailed",
        message: "Could not read local artifact for upload.",
      });
    }
    const fileContent = fileResult.value;

    // Base64-encode the content (required by GitHub Contents API)
    const encodedContent = Buffer.from(fileContent).toString("base64");

    // Resolve the existing remote file SHA.
    //
    // For immutable run artifacts: if the file already exists, reject immediately
    // — re-publishing the same run ID must never silently overwrite an artifact.
    //
    // For mutable index files: resolve the existing SHA to include in the PUT body
    // so the GitHub Contents API can atomically update the file in place.
    const existingResult = await this.checkExistingFile(remotePath, token);

    if (mode === "immutable" && existingResult.exists) {
      // Run artifact already committed — re-publish of same run ID is rejected.
      return err({
        type: "PublishFailed",
        message:
          `Run artifact already exists at remote path: cannot overwrite an immutable run artifact. ` +
          `Each run ID may only be published once. Use a new run ID for subsequent runs.`,
      });
    }

    // Build the API URL — no token in URL
    const apiUrl = `${GITHUB_API_BASE}/repos/${TARGET_REPO}/contents/${remotePath}`;

    const requestBody: Record<string, unknown> = {
      message: `chore: publish eval bundle ${remotePath}`,
      content: encodedContent,
      branch: TARGET_BRANCH,
    };

    // For mutable files: include the existing SHA when updating (required by
    // GitHub API to atomically replace the file). For immutable files: never
    // include a SHA — we already rejected above when the file exists.
    if (mode === "mutable" && existingResult.sha !== null) {
      requestBody.sha = existingResult.sha;
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
      // SECURITY: include only a bounded error message for network diagnosis.
      // Never include the token, response body, or arbitrary cause details.
      const netMsg =
        cause instanceof Error
          ? cause.message.slice(0, 200)
          : "unknown network failure";
      return err({
        type: "PublishFailed",
        message: `Network error uploading artifact: ${netMsg}`,
      });
    }

    if (!response.ok) {
      // SECURITY: include only the HTTP status code — never the response body.
      // The response body may contain server-side error details that could hint
      // at token validity or repo structure.
      return err({
        type: "PublishFailed",
        message:
          `GitHub API returned HTTP ${response.status}. ` +
          `Verify the token has write access to ${TARGET_REPO} on branch "${TARGET_BRANCH}".`,
      });
    }

    // Extract commit SHA from response for the result record
    const commitSha = await this.extractCommitSha(response);

    return ok({ commitSha });
  }

  // ---------------------------------------------------------------------------
  // Private: existing file check (presence + SHA resolution)
  // ---------------------------------------------------------------------------

  /**
   * Check whether a file already exists at `remotePath` in the target repo,
   * and retrieve its current blob SHA if so.
   *
   * Used by `uploadFile()` to:
   *   - Detect conflicts for immutable run artifacts (reject if exists).
   *   - Resolve the current SHA for mutable index file updates.
   *
   * Returns `{ exists: false, sha: null }` when the file does not exist (404)
   * or when the GET request fails for any reason (fail-safe).
   *
   * Token is passed as an `Authorization` header — never in the URL.
   */
  private async checkExistingFile(
    remotePath: string,
    token: string,
  ): Promise<{ exists: boolean; sha: string | null }> {
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
        // File does not exist — safe to create
        return { exists: false, sha: null };
      }
      if (!response.ok) {
        // Non-404 error — treat as "unknown, proceed with create attempt"
        return { exists: false, sha: null };
      }
      // File exists — extract its SHA for mutable updates
      const body = (await response.json()) as Record<string, unknown>;
      const sha = body.sha;
      const resolvedSha =
        typeof sha === "string" && sha.length > 0 ? sha : null;
      return { exists: true, sha: resolvedSha };
    } catch {
      // Network or parse failure — proceed without SHA (create attempt)
      return { exists: false, sha: null };
    }
  }

  // ---------------------------------------------------------------------------
  // Public: remote run ID reader (implements RemoteSequenceReader)
  // ---------------------------------------------------------------------------

  /**
   * Fetch all run IDs from `indexes/v1/dashboard-manifest.json` in the remote
   * results repository that share the given prefix.
   *
   * Implements the `RemoteSequenceReader` interface so that `writeBundle()` can
   * use this publisher directly as the reader without a separate adapter object.
   *
   * Returns `ok([])` on any failure (404, network error, malformed JSON,
   * missing `runs` array) so callers always fall back to local-only allocation
   * safely.
   *
   * Token is passed as an `Authorization: Bearer` header only — never in the
   * URL or logged.
   *
   * @param prefix - The run ID prefix to filter on (e.g. `abc123d-2026-01-15`).
   * @param token  - GitHub PAT token.
   * @returns `ok(runIds)` — always succeeds (empty list on any failure).
   */
  readRemoteRunIds(
    prefix: string,
    token: string,
  ): ResultAsync<string[], never> {
    return ResultAsync.fromSafePromise(
      this.fetchRemoteManifestRunIds(prefix, token),
    );
  }

  /**
   * Internal implementation for `readRemoteRunIds`.
   *
   * Fetches `indexes/v1/dashboard-manifest.json`, parses the JSON, extracts
   * `runs[].runId`, and returns IDs that begin with `${prefix}-`.
   *
   * All errors are swallowed; the function always resolves (never rejects).
   */
  private async fetchRemoteManifestRunIds(
    prefix: string,
    token: string,
  ): Promise<string[]> {
    const manifestPath = `${TARGET_INDEXES_PREFIX}/dashboard-manifest.json`;
    const apiUrl = `${GITHUB_API_BASE}/repos/${TARGET_REPO}/contents/${manifestPath}`;

    let response: Response;
    try {
      const request = new Request(apiUrl, {
        method: "GET",
        headers: {
          // Token in Authorization header ONLY — never in URL or body
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "weave-eval-publisher/1.0",
        },
      });
      response = await this.fetchImpl(request);
    } catch {
      // Network error — fall back to local-only
      return [];
    }

    if (!response.ok) {
      // 404 or other error — manifest not yet published or unavailable; fall back
      return [];
    }

    // The GitHub Contents API returns file metadata including a base64-encoded
    // `content` field.  Decode and parse the manifest JSON.
    let manifestText: string;
    try {
      const body = (await response.json()) as Record<string, unknown>;
      const rawContent = body.content;
      if (typeof rawContent !== "string") return [];
      // GitHub API base64-encodes file content with newlines every 60 chars;
      // strip whitespace before decoding.
      const cleanedContent = rawContent.replace(/\s/g, "");
      manifestText = Buffer.from(cleanedContent, "base64").toString("utf-8");
    } catch {
      return [];
    }

    // Parse the manifest JSON and extract run IDs that match the prefix.
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText);
    } catch {
      return [];
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).runs)
    ) {
      return [];
    }

    const runs = (parsed as Record<string, unknown>).runs as unknown[];
    const matchingIds: string[] = [];
    const prefixDash = `${prefix}-`;

    for (const run of runs) {
      if (typeof run !== "object" || run === null) continue;
      const runId = (run as Record<string, unknown>).runId;
      if (typeof runId !== "string") continue;
      if (runId.startsWith(prefixDash)) {
        matchingIds.push(runId);
      }
    }

    return matchingIds;
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
   * Returns only files whose names are in `RUN_ARTIFACT_ALLOWLIST` at the top
   * level of the bundle directory. The `raw/` subdirectory is never included.
   *
   * Website consumers MUST NOT walk directories — they fetch exact known paths.
   * Discovery here is only used as the fallback when `request.fileNames` is
   * not provided. Callers should always supply explicit file names.
   *
   * The returned names are relative to `bundleDir` (e.g. `bundle-index.json`).
   */
  private async discoverBundleFiles(bundleDir: string): Promise<string[]> {
    // Return only allowlisted file names that are known to exist in the bundle dir.
    // We do not glob: the allowlist is the complete set of valid file names.
    // Check existence by attempting to read each allowlisted file.
    const discovered: string[] = [];
    for (const fileName of RUN_ARTIFACT_ALLOWLIST) {
      // Only JSON files are discovered — .md files must be explicitly listed
      if (!fileName.endsWith(".json")) continue;
      try {
        const filePath = join(bundleDir, fileName);
        await Bun.file(filePath).text();
        discovered.push(fileName);
      } catch {
        // File not present — skip silently
      }
    }
    return discovered;
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
