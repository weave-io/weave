/**
 * Execution Lifecycle — authorization validation helpers.
 *
 * Validates execution and reconciliation authorization sources against the
 * engine's closed authorization contract (ADR 0004, Spec 22 Unit 3).
 *
 * @see docs/adr/0004-workflow-first-execution-contract.md
 * @see docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md
 */

import type { ReconciliationReason } from "@weave/core";
import { err, ok, type Result } from "neverthrow";
import { lifecyclePolicyDecisionError } from "./errors.js";
import type {
  ExecutionAuthorizationSource,
  LifecyclePolicyDecisionError,
  ReconciliationAuthorizationSource,
} from "./types.js";

/**
 * The only authorization source that the engine accepts for execution
 * transitions. All other sources are rejected with a `policy_decision` error.
 */
const AUTHORIZED_EXECUTION_SOURCE: ExecutionAuthorizationSource = "user";

/**
 * Validate that the authorization source is explicitly user-authorized.
 *
 * Returns `ok(undefined)` when `source === "user"`.
 * Returns a typed `policy_decision` error for any other source.
 */
export function validateAuthorizationSource(
  source: ExecutionAuthorizationSource,
  operation: "startExecution" | "resumeExecution",
): Result<undefined, LifecyclePolicyDecisionError> {
  if (source === AUTHORIZED_EXECUTION_SOURCE) return ok(undefined);
  return err(
    lifecyclePolicyDecisionError(
      `${operation} requires explicit user authorization (source: "${source}" is not permitted). ` +
        `Only source: "user" is accepted. Agents, hooks, and events may not self-start durable execution. ` +
        `See docs/adr/0004-workflow-first-execution-contract.md.`,
      "authorizationSource",
    ),
  );
}

/**
 * Map from reconciliation reason to its single authorized source.
 */
const RECONCILIATION_AUTHORIZED_SOURCES: Readonly<
  Record<ReconciliationReason, ReconciliationAuthorizationSource>
> = {
  "execution-mismatch": "runtime",
  "user-revision-request": "user",
  "review-rejection": "review-gate",
  "security-rejection": "security-gate",
};

/**
 * Validate that the reconciliation source is authorized for the given reason.
 *
 * Returns `ok(undefined)` when the source matches the authorized source for
 * the reason. Returns a typed `policy_decision` error otherwise.
 */
export function validateReconciliationSource(
  reason: ReconciliationReason,
  source: ReconciliationAuthorizationSource,
): Result<undefined, LifecyclePolicyDecisionError> {
  const authorized = RECONCILIATION_AUTHORIZED_SOURCES[reason];
  if (source === authorized) return ok(undefined);
  return err(
    lifecyclePolicyDecisionError(
      `Reconciliation reason "${reason}" requires source "${authorized}" but received "${source}". ` +
        `Only the authorized source may trigger this reconciliation reason. ` +
        `See docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md Unit 3.`,
      "reconciliationSource",
    ),
  );
}
