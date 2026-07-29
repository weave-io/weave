import { describe, expect, test } from "bun:test";
import {
  decideSessionGoalContinuation,
  type SessionGoalContinuationInput,
} from "../session-goal-continuation.js";

function input(
  overrides: Partial<SessionGoalContinuationInput> = {},
): SessionGoalContinuationInput {
  return {
    status: "pursuing",
    isIdle: true,
    hasPendingMessages: false,
    lastRunWasContinuation: false,
    lastRunMadeToolCall: true,
    planComplete: false,
    durableWorkflowActive: false,
    continuations: 0,
    maxContinuations: 100,
    ...overrides,
  };
}

describe("session goal continuation decisions", () => {
  test("holds every non-pursuing status", () => {
    for (const status of [
      "paused",
      "blocked",
      "achieved",
      "budget-limited",
    ] as const) {
      expect(decideSessionGoalContinuation(input({ status }))).toEqual({
        kind: "hold",
      });
    }
  });

  test("uses precedence for durable workflows, completion, and user activity", () => {
    expect(
      decideSessionGoalContinuation(input({ durableWorkflowActive: true })),
    ).toEqual({
      kind: "pause",
      reason: "A durable workflow took over this session.",
    });
    expect(
      decideSessionGoalContinuation(input({ planComplete: true })),
    ).toEqual({ kind: "achieved" });
    expect(
      decideSessionGoalContinuation(
        input({ durableWorkflowActive: true, planComplete: true }),
      ),
    ).toEqual({
      kind: "pause",
      reason: "A durable workflow took over this session.",
    });
    expect(decideSessionGoalContinuation(input({ isIdle: false }))).toEqual({
      kind: "hold",
    });
    expect(
      decideSessionGoalContinuation(input({ hasPendingMessages: true })),
    ).toEqual({ kind: "hold" });
    expect(
      decideSessionGoalContinuation(
        input({ isIdle: false, hasPendingMessages: true, planComplete: true }),
      ),
    ).toEqual({
      kind: "achieved",
    });
  });

  test("pauses a continuation that made no tool call", () => {
    expect(
      decideSessionGoalContinuation(
        input({ lastRunWasContinuation: true, lastRunMadeToolCall: false }),
      ),
    ).toEqual({
      kind: "pause",
      reason:
        "Automatic continuation stopped because the last continuation made no tool call.",
    });
    expect(
      decideSessionGoalContinuation(
        input({
          lastRunWasContinuation: true,
          lastRunMadeToolCall: false,
          planComplete: true,
        }),
      ),
    ).toEqual({
      kind: "achieved",
    });
  });

  test("enforces the continuation budget after safety checks", () => {
    expect(
      decideSessionGoalContinuation(input({ continuations: 100 })),
    ).toEqual({
      kind: "budget-limited",
      reason: "Automatic continuation budget reached (100).",
    });
    expect(
      decideSessionGoalContinuation(
        input({ continuations: 101, maxContinuations: 1 }),
      ),
    ).toEqual({
      kind: "budget-limited",
      reason: "Automatic continuation budget reached (1).",
    });
    expect(
      decideSessionGoalContinuation(
        input({
          continuations: 100,
          lastRunWasContinuation: true,
          lastRunMadeToolCall: false,
        }),
      ),
    ).toMatchObject({
      kind: "pause",
    });
  });

  test("continues only when every gate permits it", () => {
    expect(decideSessionGoalContinuation(input())).toEqual({
      kind: "continue",
    });
    expect(
      decideSessionGoalContinuation(
        input({ lastRunWasContinuation: true, lastRunMadeToolCall: true }),
      ),
    ).toEqual({
      kind: "continue",
    });
  });
});
