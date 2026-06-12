/**
 * Local-only raw artifact writer for `weave eval`.
 *
 * Provides a controlled write path for short-lived debugging artifacts:
 * `RawCaseResultArtifact` and `RawPromptArtifact` values that contain raw
 * transcript content, composed prompt text, and full dimension rationales.
 *
 * # Scope and safety contract
 *
 * Raw artifacts MUST NEVER be published to any external repository or included
 * in any publishable bundle. They exist solely for local debugging. The writer
 * enforces this:
 *
 *   1. `RawArtifactsWriter` is a distinct class that is **never imported by**
 *      `ArtifactBundleWriter`, `ResultsRepoPublisher`, or any publish-path code.
 *   2. The constructor requires `rawArtifactsEnabled: true` as an explicit
 *      opt-in. Calling any write method when disabled returns a typed
 *      `RawArtifactsDisabled` error — never throws.
 *   3. Raw artifact files are written to a separate `raw/` subdirectory
 *      within the local bundle directory. The `raw/` directory is
 *      `.gitignore`-able and excluded from publish paths by convention.
 *
 * # File naming
 *
 * Raw case result artifacts:
 *   `raw/case-<caseId>-<modelId>-<timestamp>.json`
 *
 * Raw prompt artifacts:
 *   `raw/prompt-<agentName>-<timestamp>.json`
 *
 * The timestamp component is the full ISO datetime with milliseconds
 * (`YYYY-MM-DDTHH-MM-SS-mmmZ`), colons replaced with hyphens for filesystem
 * safety. Using millisecond precision ensures that reruns on the same date
 * produce distinct filenames instead of overwriting or leaving stale files
 * from a previous run that share only the date portion.
 *
 * # Sensitive field marker check
 *
 * To prevent accidental publish of raw artifacts through copy/paste errors,
 * raw artifact JSON is checked to ensure it CONTAINS the marker strings
 * `"composedPrompt"` or `"rawContent"` (i.e. it is genuinely raw). If neither
 * is present, the write is blocked to avoid writing misleading "raw" artifacts
 * that are actually empty.
 *
 * Conversely, the publish path (`ArtifactBundleWriter`) verifies that
 * published JSON does NOT contain these markers. This two-direction check
 * means the raw/published paths cannot be swapped by accident.
 */

import { join, normalize, resolve } from "node:path";
import { err, ResultAsync } from "neverthrow";
import type {
  RawArtifactWriteError,
  RawCaseResultArtifact,
  RawPromptArtifact,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Subdirectory name for raw artifacts within a local bundle directory.
 * Files in this directory are local-only and must not be published.
 */
export const RAW_ARTIFACTS_SUBDIR = "raw";

// ---------------------------------------------------------------------------
// FileWriter seam — injectable for testing
// ---------------------------------------------------------------------------

/**
 * Minimal file-write interface used by `RawArtifactsWriter`.
 *
 * The production implementation delegates to `Bun.write()`. Tests inject a
 * `MemoryFileWriter` (or any in-memory stub) so no real files are written.
 *
 * The interface intentionally mirrors the Bun.write signature for the common
 * case (path + content string). Return type is `Promise<void>` for simplicity;
 * the production wrapper converts Bun's `Promise<number>` automatically.
 */
export interface RawFileWriter {
  /**
   * Write `content` to `path`, creating intermediate directories if needed.
   *
   * @param path - Absolute path to the destination file.
   * @param content - UTF-8 string content to write.
   * @returns A promise that resolves when the write is complete, or rejects on error.
   */
  write(path: string, content: string): Promise<void>;
}

/**
 * Production `RawFileWriter` that delegates to `Bun.write()`.
 * This is the default used when no writer is injected.
 */
export const bunFileWriter: RawFileWriter = {
  write(path: string, content: string): Promise<void> {
    return Bun.write(path, content).then(() => undefined);
  },
};

// ---------------------------------------------------------------------------
// Filename helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use as a filename component (no path separators,
 * no traversal segments).
 *
 * Strategy (deterministic replacement — never throws):
 *   1. Replace forward slashes and backslashes with `_`.
 *   2. Replace any remaining character that is not alphanumeric, dot, hyphen,
 *      or underscore with `_`.
 *   3. Replace sequences of `..` (after the above) with `__` so that a
 *      sanitized component can never resolve as a parent-directory reference.
 *   4. Strip any leading/trailing dots and hyphens to avoid hidden-file names
 *      and names that start with `-` (which confuse some CLI tools).
 *   5. If the result is empty, substitute `_`.
 *
 * The existing behaviour of replacing modelId `/` with `_` is preserved and
 * extended to backslashes and other unsafe chars.
 *
 * @param raw - Raw identifier string (caseId, modelId, agentName, …).
 * @returns A safe, non-empty string suitable for use in a filename.
 */
export function sanitizeFilenamePart(raw: string): string {
  let s = raw;
  // Step 1: forward slash and backslash → underscore
  s = s.replace(/[/\\]/g, "_");
  // Step 2: anything not alphanumeric, dot, hyphen, or underscore → underscore
  s = s.replace(/[^A-Za-z0-9._-]/g, "_");
  // Step 3: collapse parent-dir traversal sequences
  s = s.replace(/\.\./g, "__");
  // Step 4: strip leading/trailing dots and hyphens
  s = s.replace(/^[.-]+|[.-]+$/g, "");
  // Step 5: fallback for empty result
  return s.length > 0 ? s : "_";
}

/**
 * Compute the filename for a raw case result artifact.
 *
 * Format: `case-<safeCaseId>-<safeModelId>-<datetimeMs>.json`
 *
 * Both `caseId` and `modelId` are sanitized via `sanitizeFilenamePart` to
 * produce valid, traversal-free filename components. The existing behavior of
 * replacing modelId `/` with `_` is preserved and extended to backslashes and
 * other unsafe chars. The datetime component is derived from the ISO timestamp
 * with millisecond precision and colons/dots replaced with hyphens for
 * filesystem safety (e.g. `2026-06-11T14-32-07-123Z`). Using millisecond
 * precision ensures reruns on the same date produce distinct filenames and
 * do not overwrite or leave stale files from a previous same-day run.
 *
 * @param caseId - The eval case ID.
 * @param modelId - The model identifier used for the run.
 * @param date - ISO 8601 timestamp (full precision).
 * @returns A valid filename string.
 */
export function rawCaseResultFilename(
  caseId: string,
  modelId: string,
  date: string,
): string {
  const safeCaseId = sanitizeFilenamePart(caseId);
  const safeModelId = sanitizeFilenamePart(modelId);
  const datetimeComponent = isoToFilesafeDatetime(date);
  return `case-${safeCaseId}-${safeModelId}-${datetimeComponent}.json`;
}

/**
 * Compute the filename for a raw prompt artifact.
 *
 * Format: `prompt-<safeAgentName>-<datetimeMs>.json`
 *
 * `agentName` is sanitized via `sanitizeFilenamePart` to remove path
 * separators and traversal sequences.
 *
 * @param agentName - The agent name.
 * @param date - ISO 8601 timestamp (full precision).
 * @returns A valid filename string.
 */
export function rawPromptFilename(agentName: string, date: string): string {
  const safeAgentName = sanitizeFilenamePart(agentName);
  const datetimeComponent = isoToFilesafeDatetime(date);
  return `prompt-${safeAgentName}-${datetimeComponent}.json`;
}

/**
 * Convert an ISO 8601 timestamp to a filesystem-safe datetime string.
 *
 * Replaces colons (`:`) and dots (`.`) with hyphens so the result is safe
 * on all platforms that prohibit colons in filenames (e.g. Windows, FAT).
 * Preserves millisecond precision so consecutive reruns on the same date
 * produce unique filenames.
 *
 * Examples:
 *   `"2026-06-11T14:32:07.123Z"` → `"2026-06-11T14-32-07-123Z"`
 *   `"2026-01-15"` → `"2026-01-15"` (date-only falls through unchanged)
 *
 * @param iso - ISO 8601 timestamp string.
 * @returns Filesystem-safe datetime string.
 */
export function isoToFilesafeDatetime(iso: string): string {
  return iso.replace(/:/g, "-").replace(/\./g, "-");
}

// ---------------------------------------------------------------------------
// RawArtifactsWriter
// ---------------------------------------------------------------------------

/**
 * Local-only raw artifact writer.
 *
 * Writes `RawCaseResultArtifact` and `RawPromptArtifact` values to the `raw/`
 * subdirectory of a local bundle directory. These files are for short-lived
 * debugging only and must never be published.
 *
 * ## Enabling raw artifacts
 *
 * Raw artifact writing is opt-in. The constructor requires
 * `rawArtifactsEnabled: true`. When `false`, all write methods return a
 * typed `RawArtifactsDisabled` error rather than writing any files.
 *
 * ## Sensitive field marker validation
 *
 * Before writing, the writer verifies:
 *   - The artifact JSON contains at least one known raw content marker
 *     (`"composedPrompt"` or `"rawContent"`) to confirm it is genuinely raw.
 *   - The artifact JSON does NOT contain any publish-path artifact markers
 *     that would indicate a bundle artifact was accidentally routed here.
 *
 * ## Testability
 *
 * The `fileWriter` constructor parameter is an injectable `RawFileWriter`
 * seam. Tests pass a `MemoryFileWriter` to capture writes in-memory without
 * touching the real file system. Production callers omit the parameter to use
 * the default `bunFileWriter` (which delegates to `Bun.write()`).
 *
 * ## Usage
 *
 * ```ts
 * // Production — uses real Bun.write() by default
 * const rawWriter = new RawArtifactsWriter("/tmp/local-bundles/abc1234-2026-01-01", true);
 *
 * // Tests — inject in-memory writer
 * const memWriter = new MemoryFileWriter();
 * const rawWriter = new RawArtifactsWriter("/tmp/bundle", true, memWriter);
 *
 * const result = await rawWriter.writeCaseResultArtifact(artifact, "2026-01-01");
 * if (result.isErr()) { ... }
 * ```
 */
export class RawArtifactsWriter {
  private readonly rawDir: string;
  private readonly fileWriter: RawFileWriter;

  /**
   * @param localBundleDir - The local bundle directory path. Raw artifacts are
   *   written to `<localBundleDir>/raw/`.
   * @param rawArtifactsEnabled - Must be `true` to enable writes. When `false`,
   *   all write methods return `RawArtifactsDisabled`.
   * @param fileWriter - Optional file-write backend. Defaults to `bunFileWriter`
   *   (real `Bun.write()` calls). Inject a `MemoryFileWriter` in tests.
   */
  constructor(
    localBundleDir: string,
    private readonly rawArtifactsEnabled: boolean,
    fileWriter?: RawFileWriter,
  ) {
    this.rawDir = join(localBundleDir, RAW_ARTIFACTS_SUBDIR);
    this.fileWriter = fileWriter ?? bunFileWriter;
  }

  /**
   * Write a `RawCaseResultArtifact` to the raw artifacts directory.
   *
   * @param artifact - The raw artifact to write.
   * @param timestamp - ISO 8601 timestamp for the filename date component.
   *   Defaults to `new Date().toISOString()`.
   * @returns `ResultAsync<string, RawArtifactWriteError>` — the written file path on success.
   */
  writeCaseResultArtifact(
    artifact: RawCaseResultArtifact,
    timestamp: string = new Date().toISOString(),
  ): ResultAsync<string, RawArtifactWriteError> {
    if (!this.rawArtifactsEnabled) {
      return new ResultAsync(
        Promise.resolve(
          err<string, RawArtifactWriteError>({
            type: "RawArtifactsDisabled",
            message:
              "Raw artifact writing is disabled. " +
              "Enable it by constructing RawArtifactsWriter with rawArtifactsEnabled: true, " +
              "and ensure the runner was invoked with rawArtifacts: true.",
          }),
        ),
      );
    }

    const fileName = rawCaseResultFilename(
      artifact.caseId,
      artifact.modelId,
      timestamp,
    );
    const filePath = join(this.rawDir, fileName);

    // Containment check: resolved path must remain under rawDir
    const containmentCheck = assertPathContained(this.rawDir, filePath);
    if (containmentCheck.isErr()) {
      return new ResultAsync(
        Promise.resolve(
          err<string, RawArtifactWriteError>({
            type: "RawArtifactWriteError",
            path: filePath,
            message: containmentCheck.error,
          }),
        ),
      );
    }

    const json = JSON.stringify(artifact, null, 2);

    // Verify the artifact JSON contains raw content markers (sanity check)
    const markerCheck = assertRawContentPresent(
      json,
      `case-${artifact.caseId}`,
    );
    if (markerCheck.isErr()) {
      return new ResultAsync(
        Promise.resolve(
          err<string, RawArtifactWriteError>({
            type: "RawArtifactWriteError",
            path: filePath,
            message: markerCheck.error,
          }),
        ),
      );
    }

    return ResultAsync.fromPromise(
      this.fileWriter.write(filePath, json).then(() => filePath),
      (cause): RawArtifactWriteError => ({
        type: "RawArtifactWriteError",
        path: filePath,
        message:
          `Failed to write raw case result artifact to "${filePath}": ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    );
  }

  /**
   * Write a `RawPromptArtifact` to the raw artifacts directory.
   *
   * @param artifact - The raw prompt artifact to write.
   * @param timestamp - ISO 8601 timestamp for the filename date component.
   *   Defaults to `new Date().toISOString()`.
   * @returns `ResultAsync<string, RawArtifactWriteError>` — the written file path on success.
   */
  writePromptArtifact(
    artifact: RawPromptArtifact,
    timestamp: string = new Date().toISOString(),
  ): ResultAsync<string, RawArtifactWriteError> {
    if (!this.rawArtifactsEnabled) {
      return new ResultAsync(
        Promise.resolve(
          err<string, RawArtifactWriteError>({
            type: "RawArtifactsDisabled",
            message:
              "Raw artifact writing is disabled. " +
              "Enable it by constructing RawArtifactsWriter with rawArtifactsEnabled: true, " +
              "and ensure the runner was invoked with rawArtifacts: true.",
          }),
        ),
      );
    }

    const fileName = rawPromptFilename(artifact.agentName, timestamp);
    const filePath = join(this.rawDir, fileName);

    // Containment check: resolved path must remain under rawDir
    const containmentCheck = assertPathContained(this.rawDir, filePath);
    if (containmentCheck.isErr()) {
      return new ResultAsync(
        Promise.resolve(
          err<string, RawArtifactWriteError>({
            type: "RawArtifactWriteError",
            path: filePath,
            message: containmentCheck.error,
          }),
        ),
      );
    }

    const json = JSON.stringify(artifact, null, 2);

    // Verify the artifact JSON contains raw content markers
    const markerCheck = assertRawContentPresent(
      json,
      `prompt-${artifact.agentName}`,
    );
    if (markerCheck.isErr()) {
      return new ResultAsync(
        Promise.resolve(
          err<string, RawArtifactWriteError>({
            type: "RawArtifactWriteError",
            path: filePath,
            message: markerCheck.error,
          }),
        ),
      );
    }

    return ResultAsync.fromPromise(
      this.fileWriter.write(filePath, json).then(() => filePath),
      (cause): RawArtifactWriteError => ({
        type: "RawArtifactWriteError",
        path: filePath,
        message:
          `Failed to write raw prompt artifact to "${filePath}": ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    );
  }

  /**
   * Write a batch of `RawCaseResultArtifact` values sequentially.
   *
   * Continues writing even when individual artifacts fail. Failures are
   * collected and returned alongside successes.
   *
   * @param artifacts - Array of raw case result artifacts to write.
   * @param timestamp - ISO 8601 timestamp for filename date components.
   * @returns `ResultAsync<{ written: string[]; errors: RawArtifactWriteError[] }, never>`.
   */
  writeCaseResultArtifacts(
    artifacts: RawCaseResultArtifact[],
    timestamp: string = new Date().toISOString(),
  ): ResultAsync<
    { written: string[]; errors: RawArtifactWriteError[] },
    never
  > {
    const written: string[] = [];
    const errors: RawArtifactWriteError[] = [];

    const writeSequentially = async (): Promise<void> => {
      for (const artifact of artifacts) {
        const result = await this.writeCaseResultArtifact(artifact, timestamp);
        if (result.isOk()) {
          written.push(result.value);
        } else {
          errors.push(result.error);
        }
      }
    };

    return ResultAsync.fromSafePromise<
      { written: string[]; errors: RawArtifactWriteError[] },
      never
    >(writeSequentially().then(() => ({ written, errors })));
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assert that `filePath` is contained within `rawDir` after normalization.
 *
 * Uses `resolve()` to convert both paths to absolute representations and
 * then checks that the resolved file path starts with the resolved directory
 * prefix (with a trailing separator) — this prevents a path like
 * `/bundle/rawsomething` from matching `/bundle/raw`.
 *
 * @param rawDir  - The allowed base directory.
 * @param filePath - The candidate file path to validate.
 * @returns `ok(undefined)` when contained; `err(message)` otherwise.
 */
function assertPathContained(
  rawDir: string,
  filePath: string,
): { isOk(): boolean; isErr(): boolean; error: string } {
  const resolvedDir = resolve(rawDir) + "/";
  const resolvedFile = normalize(resolve(filePath));
  if (!resolvedFile.startsWith(resolvedDir)) {
    return {
      isOk: () => false,
      isErr: () => true,
      error:
        `Path containment check failed: "${resolvedFile}" is outside the ` +
        `allowed raw artifact directory "${rawDir}". ` +
        `The filename components may contain path traversal sequences.`,
    };
  }
  return { isOk: () => true, isErr: () => false, error: "" };
}

/**
 * Assert that a JSON string contains at least one raw content marker.
 *
 * Raw artifact JSON must contain `"composedPrompt"` or `"rawContent"` to
 * be considered genuinely raw. If neither is present, the write is blocked
 * to avoid creating misleading "raw" files that are actually empty or partial.
 *
 * @param json - The serialized JSON string.
 * @param context - Description of the artifact (for error messages).
 * @returns `ok(undefined)` when markers are present; `err(message)` otherwise.
 */
function assertRawContentPresent(
  json: string,
  context: string,
): { isOk(): boolean; isErr(): boolean; error: string } {
  const hasComposedPrompt = json.includes('"composedPrompt"');
  const hasRawContent = json.includes('"rawContent"');

  if (!hasComposedPrompt && !hasRawContent) {
    return {
      isOk: () => false,
      isErr: () => true,
      error:
        `Raw artifact check failed for "${context}": ` +
        `the artifact JSON contains neither "composedPrompt" nor "rawContent". ` +
        `Raw artifacts must contain at least one raw content field. ` +
        `Verify the artifact was produced with rawArtifacts: true.`,
    };
  }

  return { isOk: () => true, isErr: () => false, error: "" };
}

// ---------------------------------------------------------------------------
// MemoryFileWriter — for unit tests (no real I/O)
// ---------------------------------------------------------------------------

/**
 * In-memory `RawFileWriter` for use in unit tests.
 *
 * Stores all written content in `writes` (a `Map<path, content>`) so tests
 * can assert on the paths written, the content produced, and the write count
 * without touching the real file system.
 *
 * ## Usage in tests
 *
 * ```ts
 * const mem = new MemoryFileWriter();
 * const writer = new RawArtifactsWriter("/bundle", true, mem);
 *
 * await writer.writeCaseResultArtifact(artifact, "2026-01-01T00:00:00.000Z");
 *
 * expect(mem.writes.size).toBe(1);
 * const [path, content] = [...mem.writes.entries()][0];
 * expect(path).toContain("raw/case-");
 * expect(JSON.parse(content).caseId).toBe("my-case");
 * ```
 */
export class MemoryFileWriter implements RawFileWriter {
  /** All writes captured so far: absolute path → UTF-8 content string. */
  readonly writes: Map<string, string> = new Map();

  /** @inheritdoc */
  write(path: string, content: string): Promise<void> {
    this.writes.set(path, content);
    return Promise.resolve();
  }

  /**
   * Convenience: retrieve the content written to `path`, or `undefined`.
   */
  getContent(path: string): string | undefined {
    return this.writes.get(path);
  }

  /**
   * Convenience: retrieve all written paths as a sorted array.
   */
  allPaths(): string[] {
    return [...this.writes.keys()].sort();
  }

  /**
   * Convenience: clear all captured writes (for multi-phase tests).
   */
  clear(): void {
    this.writes.clear();
  }
}
