import type { SessionGoalStatus } from "./session-goal.js";

export interface SessionGoalContinuationInput {
  readonly status: SessionGoalStatus;
  readonly isIdle: boolean;
  readonly hasPendingMessages: boolean;
  readonly lastRunWasContinuation: boolean;
  readonly lastRunMadeToolCall: boolean;
  readonly planComplete: boolean;
  readonly durableWorkflowActive: boolean;
  readonly continuations: number;
  readonly maxContinuations: number;
}

export type SessionGoalContinuationDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "hold" }
  | { readonly kind: "pause"; readonly reason: string }
  | { readonly kind: "budget-limited"; readonly reason: string }
  | { readonly kind: "achieved" };

const NO_TOOL_CALL_REASON =
  "Automatic continuation stopped because the last continuation made no tool call.";

export function decideSessionGoalContinuation(
  input: Readonly<SessionGoalContinuationInput>,
): SessionGoalContinuationDecision {
  if (input.status !== "pursuing") return { kind: "hold" };

  if (input.durableWorkflowActive) {
    return {
      kind: "pause",
      reason: "A durable workflow took over this session.",
    };
  }

  if (input.planComplete) return { kind: "achieved" };

  if (!input.isIdle || input.hasPendingMessages) return { kind: "hold" };

  if (input.lastRunWasContinuation && !input.lastRunMadeToolCall) {
    return { kind: "pause", reason: NO_TOOL_CALL_REASON };
  }

  if (input.continuations >= input.maxContinuations) {
    return {
      kind: "budget-limited",
      reason: `Automatic continuation budget reached (${input.maxContinuations}).`,
    };
  }

  return { kind: "continue" };
}
