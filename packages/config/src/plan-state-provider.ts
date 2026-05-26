/**
 * BunFilesystemPlanStateProvider — default Bun-backed implementation of
 * `PlanStateProvider` from `@weave/engine`.
 *
 * Checks plan file state by reading `.weave/plans/<planName>.md` from the
 * filesystem using `Bun.file()`. All filesystem I/O lives here — the engine
 * never calls `Bun.file()` directly for plan state.
 *
 * @see docs/specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md
 * @see docs/adapter-boundary.md — Plan State Provider subsection
 */

import type { PlanStateError, PlanStateProvider } from "@weave/engine";
import { errAsync, ResultAsync } from "neverthrow";

// ---------------------------------------------------------------------------
// Safe-name validation
// ---------------------------------------------------------------------------

/** Regex for safe plan names: alphanumeric, hyphens, underscores only. */
const SAFE_PLAN_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate that `planName` is safe to use in a filesystem path.
 *
 * Rejects names containing `/`, `..`, `\0`, or any character outside the
 * alphanumeric + hyphen + underscore set to prevent path traversal attacks.
 *
 * Returns `true` when safe, `false` otherwise.
 */
function isSafePlanName(planName: string): boolean {
  return SAFE_PLAN_NAME_RE.test(planName);
}

// ---------------------------------------------------------------------------
// BunFilesystemPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * Default `PlanStateProvider` implementation backed by `Bun.file()`.
 *
 * Plan files are expected at `<projectRoot>/.weave/plans/<planName>.md`.
 * When `projectRoot` is omitted the current working directory is used,
 * which is equivalent to the previous behaviour.
 *
 * Safe-name validation runs before any filesystem path is constructed to
 * prevent path traversal attacks.
 */
export class BunFilesystemPlanStateProvider implements PlanStateProvider {
  /** Absolute path to the project root directory. */
  private readonly projectRoot: string;

  /**
   * @param projectRoot - Absolute path to the project root. Defaults to
   *   `process.cwd()` when omitted, preserving the original behaviour of
   *   resolving plan files relative to the current working directory.
   */
  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.cwd();
  }

  /**
   * Check whether the plan file for `planName` exists.
   *
   * Returns `ok(true)` when the file exists, `ok(false)` when it does not,
   * `err({ type: "InvalidPlanName" })` for unsafe names, or
   * `err({ type: "ProviderUnavailable" })` for I/O errors.
   */
  planExists(planName: string): ResultAsync<boolean, PlanStateError> {
    if (!isSafePlanName(planName)) {
      return errAsync({ type: "InvalidPlanName" as const, planName });
    }

    const planPath = `${this.projectRoot}/.weave/plans/${planName}.md`;
    return ResultAsync.fromPromise(
      Bun.file(planPath).exists(),
      (cause): PlanStateError => ({
        type: "ProviderUnavailable",
        cause: cause instanceof Error ? cause : { message: String(cause) },
      }),
    );
  }

  /**
   * Check whether the plan file for `planName` has no incomplete checkboxes.
   *
   * Returns `ok(true)` when all checkboxes are checked (or there are none),
   * `ok(false)` when at least one `- [ ]` remains,
   * `err({ type: "InvalidPlanName" })` for unsafe names, or
   * `err({ type: "ProviderUnavailable" })` for I/O errors.
   */
  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError> {
    if (!isSafePlanName(planName)) {
      return errAsync({ type: "InvalidPlanName" as const, planName });
    }

    const planPath = `${this.projectRoot}/.weave/plans/${planName}.md`;
    return ResultAsync.fromPromise(
      Bun.file(planPath).text(),
      (cause): PlanStateError => ({
        type: "ProviderUnavailable",
        cause: cause instanceof Error ? cause : { message: String(cause) },
      }),
    ).map((content) => {
      const incompleteMatches = content.match(/- \[ \]/g);
      const incompleteCount = incompleteMatches?.length ?? 0;
      return incompleteCount === 0;
    });
  }
}
