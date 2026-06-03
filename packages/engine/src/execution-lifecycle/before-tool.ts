/**
 * Execution Lifecycle — beforeTool implementation.
 *
 * Pure policy evaluation for tool calls. Does NOT access the Runtime Store.
 * The adapter maps concrete harness tool names to abstract capabilities and
 * supplies the fully-resolved `effectiveToolPolicy`. The engine reads
 * `effectiveToolPolicy[toolCapability]` and returns the decision.
 */

import { errAsync, okAsync } from "neverthrow";
import { ABSTRACT_CAPABILITIES } from "../tool-policy.js";
import { lifecycleValidationError } from "./errors.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  BeforeToolInput,
  BeforeToolOutput,
  BeforeToolResult,
  LifecycleError,
} from "./types.js";

/**
 * Evaluate the abstract tool policy for a tool call that is about to execute.
 *
 * This is a pure policy evaluation — it does NOT access the Runtime Store.
 * The adapter has already mapped the concrete harness tool name to an abstract
 * capability (`toolCapability`) and supplied the fully-resolved
 * `effectiveToolPolicy`. The engine reads `effectiveToolPolicy[toolCapability]`
 * and returns the corresponding `allow` / `deny` / `ask` decision.
 *
 * ## Adapter / Engine Boundary
 *
 * - **Adapters own** concrete tool-name mapping.
 * - **The engine owns** abstract policy decisions.
 * - `toolName` in `BeforeToolInput` is for audit/logging only.
 *
 * @param input - Tool call context from the adapter.
 * @returns `okAsync({ decision })` on success, or a typed `LifecycleError`.
 */
export function beforeTool(input: BeforeToolInput): BeforeToolResult {
  if (!input.workflowInstanceId) {
    return errAsync(
      lifecycleValidationError(
        "workflowInstanceId is required",
        "workflowInstanceId",
      ),
    );
  }
  if (!input.leaseId) {
    return errAsync(lifecycleValidationError("leaseId is required", "leaseId"));
  }
  if (!input.toolCapability) {
    return errAsync(
      lifecycleValidationError("toolCapability is required", "toolCapability"),
    );
  }
  if (!input.toolName) {
    return errAsync(
      lifecycleValidationError("toolName is required", "toolName"),
    );
  }
  if (!input.effectiveToolPolicy) {
    return errAsync(
      lifecycleValidationError(
        "effectiveToolPolicy is required",
        "effectiveToolPolicy",
      ),
    );
  }

  if (
    !(ABSTRACT_CAPABILITIES as readonly string[]).includes(input.toolCapability)
  ) {
    return errAsync(
      lifecycleValidationError(
        `toolCapability '${input.toolCapability}' is not a recognized abstract capability`,
        "toolCapability",
      ),
    );
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  const decision = input.effectiveToolPolicy[input.toolCapability];

  return okAsync({ decision });
}
