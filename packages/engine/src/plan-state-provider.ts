/**
 * PlanStateProvider — abstract interface for querying plan file state.
 *
 * The engine owns this interface; adapters (or the default Bun-backed
 * implementation in `@weave/config`) own the concrete implementation.
 *
 * This separation keeps `Bun.file()` calls out of the engine and makes
 * plan-state checks testable with mock providers.
 *
 * @see docs/specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md
 * @see docs/adapter-boundary.md — Plan State Provider subsection
 */

import type { ResultAsync } from "neverthrow";

// ---------------------------------------------------------------------------
// PlanStateError — discriminated union
// ---------------------------------------------------------------------------

/**
 * Errors that a `PlanStateProvider` implementation may return.
 *
 * - `InvalidPlanName` — the supplied plan name failed the safe-name check
 *   (contains `/`, `..`, `\0`, or other unsafe characters).
 * - `ProviderUnavailable` — an I/O or infrastructure error prevented the
 *   provider from answering the query.
 */
export type PlanStateError =
  | { readonly type: "InvalidPlanName"; readonly planName: string }
  | { readonly type: "ProviderUnavailable"; readonly cause: unknown };

// ---------------------------------------------------------------------------
// PlanStateProvider — interface
// ---------------------------------------------------------------------------

/**
 * Abstract provider for querying the state of a plan file.
 *
 * Implementations must:
 * 1. Validate `planName` against the safe-name allowlist before constructing
 *    any filesystem path (prevents path traversal).
 * 2. Return `err({ type: "InvalidPlanName" })` for unsafe names.
 * 3. Return `err({ type: "ProviderUnavailable" })` for I/O failures.
 *
 * The engine calls `planExists` for `plan_created` completion checks and
 * `isPlanComplete` for `plan_complete` completion checks.
 */
export interface PlanStateProvider {
  /**
   * Check whether the plan file for `planName` exists.
   *
   * Returns `ok(true)` when the file exists, `ok(false)` when it does not,
   * or an error when the name is invalid or the check cannot be performed.
   */
  planExists(planName: string): ResultAsync<boolean, PlanStateError>;

  /**
   * Check whether the plan file for `planName` has no incomplete checkboxes.
   *
   * Returns `ok(true)` when all checkboxes are checked (or there are none),
   * `ok(false)` when at least one `- [ ]` remains, or an error when the name
   * is invalid or the file cannot be read.
   */
  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError>;
}
