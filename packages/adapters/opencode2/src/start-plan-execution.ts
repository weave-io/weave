/**
 * Start Plan Execution — the `/weave:start` command handler.
 *
 * Composes the Loom-agent activation prompt for a named plan and delivers it
 * via `facade.session.prompt(...)`. This module is the V2 adapter's thin
 * projection of the `/weave:start` delivery path — it does not duplicate any
 * engine lifecycle logic (workflow instance creation, step dispatch, etc.);
 * that remains `run-workflow.ts`'s responsibility once the activated Loom
 * agent begins delegating tasks.
 *
 * Implemented independently from the V1 OpenCode adapter's
 * `start-plan-execution.ts` (which delegates to the engine's `startPlan`
 * command operation directly). The V2 adapter's `/weave:start` command
 * activates Loom via a session prompt; Loom itself drives delegation inside
 * the session, matching how V2 commands are prompt/session-based rather than
 * lifecycle-operation-based (see `./command-templates.ts` header).
 *
 * This module MUST NOT import from `packages/adapters/opencode/` (the V1
 * adapter) — see `./errors.ts` header for the independent V2 error union
 * rationale.
 */

import { ResultAsync } from "neverthrow";
import { type OpenCode2AdapterError, sessionOperationError } from "./errors.js";
import type { PluginContextFacade } from "./plugin-context.js";
import type { V2SessionPromptOutput } from "./sdk-types.js";

// ---------------------------------------------------------------------------
// § 1 — Loom activation prompt composition
// ---------------------------------------------------------------------------

/**
 * Compose the Loom-agent activation prompt for a named plan.
 *
 * Pure — no I/O. Kept internal to this module because the loom-activation
 * framing is `/weave:start`-specific (unlike `composeDelegatedPrompt` in
 * `./projection-helpers`, which is shared across step-dispatch prompts).
 */
function composeLoomActivationPrompt(planName: string): string {
  return `<weave-plan-activation>
You are being activated to execute the Weave plan "${planName}".
Read the plan and delegate each unchecked task to Shuttle until every task is complete.
</weave-plan-activation>`;
}

// ---------------------------------------------------------------------------
// § 2 — startPlanExecution — main entry point
// ---------------------------------------------------------------------------

/** Input for `startPlanExecution`. */
export interface StartPlanExecutionInput {
  /** Target session for the Loom activation prompt. */
  readonly sessionID: string;
  /** Name of the plan to execute (rendered into the activation prompt). */
  readonly planName: string;
  /** Delivery mode for the activation prompt. Defaults to `"queue"`. */
  readonly delivery?: "steer" | "queue";
}

/**
 * Activate Loom to execute a named plan by delivering the loom-activation
 * prompt via `facade.session.prompt(...)`.
 *
 * @param facade - Narrow facade over the V2 plugin context.
 * @param input - Plan name and target session for the activation prompt.
 * @returns `ok(V2SessionPromptOutput)` on success, or
 *   `err(OpenCode2AdapterError)` (`SessionOperationError`) if the prompt call
 *   rejects.
 */
export function startPlanExecution(
  facade: PluginContextFacade,
  input: StartPlanExecutionInput,
): ResultAsync<V2SessionPromptOutput, OpenCode2AdapterError> {
  const { sessionID, planName, delivery = "queue" } = input;
  const text = composeLoomActivationPrompt(planName);

  return ResultAsync.fromPromise(
    facade.session.prompt({
      sessionID,
      text,
      delivery,
    } as Parameters<PluginContextFacade["session"]["prompt"]>[0]),
    (cause) => sessionOperationError("prompt", sessionID, cause),
  );
}
