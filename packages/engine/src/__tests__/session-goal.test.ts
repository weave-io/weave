import { describe, expect, test } from "bun:test";
import type { Result } from "neverthrow";
import {
  DEFAULT_MAX_GOAL_CONTINUATIONS,
  formatDuration,
  formatTokenCount,
  parseSessionGoalSnapshot,
  SESSION_GOAL_STATE_VERSION,
  SessionGoalController,
  type SessionGoalError,
  type SessionGoalState,
} from "../session-goal.js";

function errorOf<T>(result: Result<T, SessionGoalError>): SessionGoalError {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) return result.error;
  throw new Error("expected an error result");
}

function state(status: SessionGoalState["status"]): SessionGoalState {
  return {
    version: SESSION_GOAL_STATE_VERSION,
    planName: "release",
    planContentRevision: "rev-1",
    status,
    startedAt: 1_000,
    elapsedMs: 2_000,
    turns: 3,
    tokens: 400,
    continuations: 2,
  };
}

describe("SessionGoalController", () => {
  test("accounts only for active periods", () => {
    let now = 1_000;
    const controller = new SessionGoalController(() => now);

    expect(controller.start(" Release ", "rev-1").isOk()).toBe(true);
    now = 6_000;
    expect(controller.elapsedMs()).toBe(5_000);
    expect(controller.pause("wait").isOk()).toBe(true);
    now = 20_000;
    expect(controller.elapsedMs()).toBe(5_000);
    expect(controller.resume().isOk()).toBe(true);
    now = 23_000;
    expect(controller.elapsedMs()).toBe(8_000);
    expect(controller.clear().isOk()).toBe(true);
    expect(controller.current).toBeUndefined();
  });

  test("supports every legal transition and start replacement", () => {
    const controller = new SessionGoalController(() => 1_000);
    expect(controller.start("one", "a").isOk()).toBe(true);
    expect(controller.pause().isOk()).toBe(true);
    expect(controller.resume().isOk()).toBe(true);
    expect(controller.block("blocked").isOk()).toBe(true);
    expect(controller.resume().isOk()).toBe(true);
    expect(controller.limitBudget("limited").isOk()).toBe(true);
    expect(controller.resume().isOk()).toBe(true);
    expect(controller.achieve(" done ").isOk()).toBe(true);
    expect(controller.current).toMatchObject({
      status: "achieved",
      evidence: "done",
    });
    expect(controller.start("two", "b").isOk()).toBe(true);
    expect(controller.current).toMatchObject({
      planName: "two",
      status: "pursuing",
    });
  });

  test("rejects every illegal transition without changing state", () => {
    const controller = new SessionGoalController(() => 1_000);
    expect(errorOf(controller.pause())).toEqual({ type: "NoActiveGoal" });
    expect(errorOf(controller.resume())).toEqual({ type: "NoActiveGoal" });
    expect(errorOf(controller.achieve("e"))).toEqual({ type: "NoActiveGoal" });
    expect(errorOf(controller.block("r"))).toEqual({ type: "NoActiveGoal" });
    expect(errorOf(controller.limitBudget("r"))).toEqual({
      type: "NoActiveGoal",
    });
    expect(errorOf(controller.clear())).toEqual({ type: "NoActiveGoal" });
    expect(controller.start("goal", "rev").isOk()).toBe(true);
    expect(errorOf(controller.resume())).toEqual({
      type: "IllegalTransition",
      from: "pursuing",
      to: "pursuing",
    });
    expect(controller.recordContinuation().isOk()).toBe(true);
    expect(controller.pause().isOk()).toBe(true);
    expect(errorOf(controller.pause())).toEqual({
      type: "IllegalTransition",
      from: "paused",
      to: "paused",
    });
    expect(controller.achieve("ignored").isErr()).toBe(true);
    expect(controller.resume().isOk()).toBe(true);
    expect(controller.achieve("done").isOk()).toBe(true);
    expect(errorOf(controller.resume())).toEqual({
      type: "IllegalTransition",
      from: "achieved",
      to: "pursuing",
    });
    expect(errorOf(controller.block("again"))).toEqual({
      type: "IllegalTransition",
      from: "achieved",
      to: "blocked",
    });
    expect(errorOf(controller.limitBudget("again"))).toEqual({
      type: "IllegalTransition",
      from: "achieved",
      to: "budget-limited",
    });
  });

  test("rejects unresolved plans and incomplete achievement", () => {
    const controller = new SessionGoalController(() => 1_000);
    expect(errorOf(controller.start(" ", "rev"))).toEqual({
      type: "PlanNotResolved",
      planName: " ",
      planContentRevision: "rev",
    });
    expect(errorOf(controller.start("goal", " "))).toEqual({
      type: "PlanNotResolved",
      planName: "goal",
      planContentRevision: " ",
    });
    expect(controller.start("goal", "rev").isOk()).toBe(true);
    expect(errorOf(controller.achieve("evidence", false))).toEqual({
      type: "PlanIncomplete",
      reason: "The plan is not complete.",
    });
    expect(controller.current?.status).toBe("pursuing");
  });

  test("restores snapshots and strictly rejects malformed values", () => {
    const controller = new SessionGoalController(() => 10_000);
    const valid = {
      version: SESSION_GOAL_STATE_VERSION,
      state: state("paused"),
    } as const;
    expect(controller.restore(valid).isOk()).toBe(true);
    expect(controller.current).toEqual(state("paused"));
    expect(
      parseSessionGoalSnapshot({
        version: SESSION_GOAL_STATE_VERSION,
        state: null,
      })._unsafeUnwrap(),
    ).toBeNull();

    const invalidValues: unknown[] = [
      null,
      { version: 2, state: null },
      { version: SESSION_GOAL_STATE_VERSION, state: "bad" },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), version: 2 },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), planName: " " },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), planContentRevision: " " },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), status: "unknown" },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), startedAt: Number.NaN },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), elapsedMs: -1 },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), turns: Infinity },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), tokens: "400" },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), continuations: -1 },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), evidence: 1 },
      },
      {
        version: SESSION_GOAL_STATE_VERSION,
        state: { ...state("paused"), reason: 1 },
      },
    ];
    for (const value of invalidValues) {
      expect(parseSessionGoalSnapshot(value).isErr()).toBe(true);
    }
    expect(
      errorOf(controller.restore(invalidValues[1] as never)),
    ).toMatchObject({ type: "InvalidSnapshot" });
  });

  test("tracks turns, token floors, continuation budget, and serialization", () => {
    let now = 1_000;
    const controller = new SessionGoalController(() => now, {
      maxContinuations: 2,
    });
    expect(controller.start("goal", "rev").isOk()).toBe(true);
    expect(controller.recordTurn(1_250.9).isOk()).toBe(true);
    expect(errorOf(controller.recordTurn(-1))).toMatchObject({
      type: "InvalidSnapshot",
    });
    expect(controller.recordContinuation().isOk()).toBe(true);
    expect(controller.budgetReason()).toBeUndefined();
    expect(controller.recordContinuation().isOk()).toBe(true);
    expect(controller.budgetReason()).toBe(
      "Automatic continuation budget reached (2).",
    );
    now = 4_000;
    expect(controller.serialize()).toEqual({
      version: SESSION_GOAL_STATE_VERSION,
      state: {
        version: SESSION_GOAL_STATE_VERSION,
        planName: "goal",
        planContentRevision: "rev",
        status: "pursuing",
        startedAt: 1_000,
        elapsedMs: 3_000,
        turns: 1,
        tokens: 1_250,
        continuations: 2,
      },
    });
  });

  test("formats duration and token metrics", () => {
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_250)).toBe("1.3k");
    expect(formatTokenCount(25_000)).toBe("25k");
    expect(formatTokenCount(1_250_000)).toBe("1.3m");
    expect(DEFAULT_MAX_GOAL_CONTINUATIONS).toBe(100);
  });

  test("constructs the remaining typed error variant", () => {
    const providerUnavailable: SessionGoalError = {
      type: "ProviderUnavailable",
      reason: "fixture",
      cause: new Error("fixture"),
    };
    expect(providerUnavailable.type).toBe("ProviderUnavailable");
  });
});
