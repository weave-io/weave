import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  parseSessionGoalSnapshot,
  type SessionGoalController,
  type SessionGoalError,
  type SessionGoalSnapshot,
} from "@weaveio/weave-engine";
import type { Result } from "neverthrow";

export const WEAVE_GOAL_STATE_ENTRY_TYPE = "weave-goal-state" as const;

type GoalSessionAPI = Pick<ExtensionAPI, "appendEntry">;
type GoalSessionContext = Pick<ExtensionContext, "sessionManager">;

/** Append the controller's versioned goal envelope to the current Pi branch. */
export function persistGoalState(
  pi: GoalSessionAPI,
  controller: Pick<SessionGoalController, "serialize">,
): void {
  pi.appendEntry(WEAVE_GOAL_STATE_ENTRY_TYPE, controller.serialize());
}

/** Restore the last valid goal snapshot in the current Pi branch. */
export function restoreGoalState(
  ctx: GoalSessionContext,
  controller: Pick<SessionGoalController, "restore">,
): Result<void, SessionGoalError> {
  let restored: SessionGoalSnapshot | null = null;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== WEAVE_GOAL_STATE_ENTRY_TYPE
    ) {
      continue;
    }

    const parsed = parseSessionGoalSnapshot(entry.data);
    if (parsed.isOk()) {
      restored = { version: 1, state: parsed.value };
    }
  }

  return controller.restore(restored);
}
