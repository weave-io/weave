/**
 * External results repository publisher for `weave eval`.
 *
 * Manages publication of publishable eval result bundles to an external
 * git repository. Publication is strictly token-gated: the publisher will not
 * attempt any external push without a valid `EVAL_RESULTS_REPO_TOKEN`.
 *
 * # Responsibilities
 *
 * The `ResultsRepoPublisher` owns:
 *   - Token presence validation (hard fail without token)
 *   - Dry-run bundle publication blocking (dry-run results are local-only)
 *   - Unsanitized bundle detection (belt-and-suspenders before external push)
 *   - Coordinating bundle path resolution for the external repo
 *
 * The `ResultsRepoPublisher` does NOT own:
 *   - Sanitization of individual artifact fields (owned by `sanitizer.ts`)
 *   - Bundle assembly (owned by `artifact-bundle.ts`)
 *   - Raw artifact writing (owned by `raw-artifacts.ts`)
 *   - Git subprocess calls (owned by `bunGitShaProvider` in `provenance.ts`)
 *
 * # Token requirement
 *
 * The token must be present in `EVAL_RESULTS_REPO_TOKEN`. In tests, inject a
 * mock `ResultsRepoPublisher` or the `StubResultsRepoPublisher` to avoid any
 * real network calls. The token value is treated as a secret — never logged,
 * printed, or serialized.
 *
 * # Publish policy
 *
 * Before any external push, the publisher enforces:
 *   1. Token is present and non-empty.
 *   2. Bundle is not a dry-run result.
 *   3. Bundle JSON does not contain any sensitive field names.
 *   4. Bundle has at least one score file.
 *
 * Any policy violation returns a typed `ResultsRepoError` — no exceptions.
 *
 * # Test doubles
 *
 * `StubResultsRepoPublisher` is exported for use in tests. It records all
 * `publish()` calls and returns configurable responses without network access.
 */

import { err, ok, ResultAsync } from "neverthrow";
import { EVAL_RESULTS_REPO_TOKEN_ENV_VAR } from "./artifact-bundle.js";
import { assertJsonPublishSafe } from "./sanitizer.js";
import type {
  EvalBundle,
  ResultsRepoConfig,
  ResultsRepoError,
} from "./types.js";

// ---------------------------------------------------------------------------
// ResultsRepoPublisher interface
// ---------------------------------------------------------------------------

/**
 * A request to publish a bundle to the external results repository.
 */
export interface PublishBundleRequest {
  /**
   * The assembled `EvalBundle` to publish.
   * Must be a sanitized bundle (produced by `ArtifactBundleWriter`).
   */
  bundle: EvalBundle;
  /**
   * The local directory where the bundle files were already written.
   * The publisher reads from this directory and pushes to the external repo.
   */
  localBundleDir: string;
  /**
   * Names of the files to include in the external push (relative to `localBundleDir`).
   * When omitted, the publisher uses all `.json` files in the bundle directory.
   */
  fileNames?: string[];
  /**
   * The local root directory containing dashboard index files.
   * When provided together with `indexFileNames`, the publisher also uploads
   * index files from this directory at the repository root level (not under
   * `runs/<bundleDirName>/`).
   *
   * Only set when `generateIndexes: true` was passed to `ArtifactBundleWriter`.
   * Omitted by default.
   */
  localBundleRoot?: string;
  /**
   * Names of dashboard index files to publish (relative to `localBundleRoot`).
   * E.g. `["dashboard-manifest.json", "latest.json", "last-N-runs.json"]`.
   *
   * When provided, each file is uploaded at `<fileName>` (repo root level)
   * rather than under `runs/<bundleDirName>/`. This allows index files to be
   * updated atomically after each run publication.
   *
   * Only set when `generateIndexes: true` was passed to `ArtifactBundleWriter`.
   */
  indexFileNames?: string[];
  /**
   * Environment variable override for token lookup.
   * Defaults to `Bun.env`. Inject a mock in tests.
   */
  env?: Record<string, string | undefined>;
}

/**
 * The result of a successful bundle publication.
 */
export interface PublishBundleResult {
  /** The commit SHA in the external repository (when available). */
  commitSha: string | null;
  /** The branch that was updated. */
  branch: string;
  /** Number of files pushed. */
  filesPublished: number;
  /** Whether the publish was simulated (stub mode). */
  simulated: boolean;
}

/**
 * Interface for publishing eval bundles to an external results repository.
 *
 * Implementations must:
 *   - Validate the publish token before any external push.
 *   - Reject dry-run bundles.
 *   - Reject unsanitized bundles.
 */
export interface ResultsRepoPublisher {
  /**
   * Publish a bundle to the external results repository.
   *
   * @param request - The publish request.
   * @returns `ResultAsync<PublishBundleResult, ResultsRepoError>`.
   */
  publish(
    request: PublishBundleRequest,
  ): ResultAsync<PublishBundleResult, ResultsRepoError>;
}

// ---------------------------------------------------------------------------
// Policy enforcement helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a publish token is present and non-empty.
 *
 * @param env - Environment variable map to look up the token in.
 * @returns `ok(token)` when the token is present; `err(ResultsRepoError)` otherwise.
 */
export function validatePublishToken(
  env: Record<string, string | undefined>,
): ResultAsync<string, ResultsRepoError> {
  const token = env[EVAL_RESULTS_REPO_TOKEN_ENV_VAR];
  if (token === undefined || token.trim() === "") {
    return new ResultAsync(
      Promise.resolve(
        err<string, ResultsRepoError>({
          type: "TokenMissing",
          envVar: EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
          message:
            `${EVAL_RESULTS_REPO_TOKEN_ENV_VAR} is required for external bundle publication but was not set. ` +
            `Set this environment variable to a valid repository token. ` +
            `For local-only writes, use mode: "local" on ArtifactBundleWriter.`,
        }),
      ),
    );
  }
  return ResultAsync.fromSafePromise(Promise.resolve(token.trim()));
}

/**
 * Validate that a `ResultsRepoConfig` is well-formed.
 *
 * Validates:
 *   - `repoUrl` starts with `https://` (no HTTP or relative URLs).
 *
 * @param config - The repo configuration to validate.
 * @returns `ok(undefined)` when valid; `err(ResultsRepoError)` otherwise.
 */
export function validateRepoConfig(
  config: ResultsRepoConfig,
): ResultAsync<undefined, ResultsRepoError> {
  if (!config.repoUrl.startsWith("https://")) {
    return new ResultAsync(
      Promise.resolve(
        err<undefined, ResultsRepoError>({
          type: "RepoConfigInvalid",
          message:
            `ResultsRepoConfig.repoUrl must start with "https://". ` +
            `Only HTTPS URLs are accepted for external repository publication. ` +
            `Check the "repoUrl" field in your ResultsRepoConfig.`,
        }),
      ),
    );
  }
  return ResultAsync.fromSafePromise(Promise.resolve(undefined));
}

/**
 * Enforce all publish policy checks on a bundle before external push.
 *
 * Checks (in order):
 *   1. Bundle is not a dry-run result → `DryRunPublishBlocked`.
 *   2. Bundle has at least one score file → `NoScoreFilesToPublish`.
 *   3. Bundle JSON does not contain sensitive fields → `UnsanitizedBundleBlocked`.
 *
 * @param bundle - The bundle to validate.
 * @returns `ok(undefined)` when all checks pass; `err(ResultsRepoError)` on the first failure.
 */
export function enforcePublishPolicy(
  bundle: EvalBundle,
): ResultAsync<undefined, ResultsRepoError> {
  // Check 1: dry-run bundles must not be published externally
  if (bundle.dryRun) {
    return new ResultAsync(
      Promise.resolve(
        err<undefined, ResultsRepoError>({
          type: "DryRunPublishBlocked",
          message:
            "Dry-run bundles must not be published to external repositories. " +
            "Only bundles produced by real model runs (dryRun: false) may be published.",
        }),
      ),
    );
  }

  // Check 2: bundle must contain at least one score file
  if (bundle.scoreFiles.length === 0) {
    return new ResultAsync(
      Promise.resolve(
        err<undefined, ResultsRepoError>({
          type: "NoScoreFilesToPublish",
          message:
            "Bundle has no score files. A publishable bundle must contain at least one score file. " +
            "Ensure the runner produced results before submitting for publication.",
        }),
      ),
    );
  }

  // Check 3: belt-and-suspenders serialization check
  const bundleJson = JSON.stringify(bundle);
  const jsonSafetyResult = assertJsonPublishSafe(bundleJson, "EvalBundle");
  if (jsonSafetyResult.isErr()) {
    const safetyError = jsonSafetyResult.error;
    return new ResultAsync(
      Promise.resolve(
        err<undefined, ResultsRepoError>({
          type: "UnsanitizedBundleBlocked",
          message: safetyError.message,
          field: "field" in safetyError ? safetyError.field : "unknown",
        }),
      ),
    );
  }

  return ResultAsync.fromSafePromise(Promise.resolve(undefined));
}

// ---------------------------------------------------------------------------
// NoOpResultsRepoPublisher — local-only stub
// ---------------------------------------------------------------------------

/**
 * A `ResultsRepoPublisher` that records publish calls but performs no real push.
 *
 * Used in dry-run mode and when external publication is not configured.
 * Returns a simulated `PublishBundleResult` without contacting any external
 * service or running git commands.
 *
 * Enforces the same policy checks as the real publisher — publish token,
 * dry-run blocking, and sanitization — so callers can't bypass policy by
 * using the no-op publisher.
 */
export class NoOpResultsRepoPublisher implements ResultsRepoPublisher {
  /** All publish requests received (for inspection in tests/diagnostics). */
  readonly publishCalls: PublishBundleRequest[] = [];

  publish(
    request: PublishBundleRequest,
  ): ResultAsync<PublishBundleResult, ResultsRepoError> {
    this.publishCalls.push(request);

    // Enforce policy (token, dry-run, sanitization) even in no-op mode
    const env = request.env ?? Bun.env;
    return validatePublishToken(env)
      .andThen(() => enforcePublishPolicy(request.bundle))
      .map(
        (): PublishBundleResult => ({
          commitSha: null,
          branch: "main",
          filesPublished: request.fileNames?.length ?? 0,
          simulated: true,
        }),
      );
  }
}

// ---------------------------------------------------------------------------
// StubResultsRepoPublisher — test double
// ---------------------------------------------------------------------------

/**
 * A configurable `ResultsRepoPublisher` stub for use in tests.
 *
 * Allows tests to specify per-call responses without any real network or
 * git calls. Responses are consumed in FIFO order; the queue falls back
 * to a `defaultResult` when exhausted. When neither is configured, returns
 * a `PublishFailed` error.
 *
 * Importantly, this stub does NOT enforce publish policy (token, dry-run,
 * sanitization) — it is purely a controllable response source for testing
 * calling code's handling of publisher responses.
 *
 * For tests that need policy enforcement, use `NoOpResultsRepoPublisher`
 * or construct a `StubResultsRepoPublisher` with a pre-configured success result.
 */
export class StubResultsRepoPublisher implements ResultsRepoPublisher {
  /** All publish requests received. */
  readonly calls: PublishBundleRequest[] = [];

  /** @internal */
  private readonly queue: Array<
    | { ok: true; result: PublishBundleResult }
    | { ok: false; error: ResultsRepoError }
  > = [];

  /** @internal */
  private defaultEntry:
    | { ok: true; result: PublishBundleResult }
    | { ok: false; error: ResultsRepoError }
    | undefined = undefined;

  /** Enqueue a successful publish result. Consumed by the next `publish()` call. */
  enqueueSuccess(result: PublishBundleResult): void {
    this.queue.push({ ok: true, result });
  }

  /** Enqueue an error result. Consumed by the next `publish()` call. */
  enqueueError(error: ResultsRepoError): void {
    this.queue.push({ ok: false, error });
  }

  /** Set the default result used when the queue is exhausted. */
  setDefaultSuccess(result: PublishBundleResult): void {
    this.defaultEntry = { ok: true, result };
  }

  /** Set the default error used when the queue is exhausted. */
  setDefaultError(error: ResultsRepoError): void {
    this.defaultEntry = { ok: false, error };
  }

  publish(
    request: PublishBundleRequest,
  ): ResultAsync<PublishBundleResult, ResultsRepoError> {
    this.calls.push(request);

    const entry = this.queue.shift() ?? this.defaultEntry;

    if (entry === undefined) {
      return new ResultAsync(
        Promise.resolve(
          err<PublishBundleResult, ResultsRepoError>({
            type: "PublishFailed",
            message:
              `StubResultsRepoPublisher: no response configured for call ${this.calls.length}. ` +
              `Use enqueueSuccess(), enqueueError(), setDefaultSuccess(), or setDefaultError().`,
          }),
        ),
      );
    }

    if (entry.ok) {
      return new ResultAsync(Promise.resolve(ok(entry.result)));
    }
    return new ResultAsync(Promise.resolve(err(entry.error)));
  }
}
