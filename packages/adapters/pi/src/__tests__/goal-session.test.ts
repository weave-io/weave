// biome-ignore-all lint/suspicious/noExplicitAny: isolated session host fake intentionally models only the branch port.
import { describe, expect, it } from "bun:test";
import { SessionGoalController } from "@weaveio/weave-engine";
import {
  persistGoalState,
  restoreGoalState,
  WEAVE_GOAL_STATE_ENTRY_TYPE,
} from "../goal-session.js";

const entry = (data: unknown) => ({
  type: "custom",
  customType: WEAVE_GOAL_STATE_ENTRY_TYPE,
  data,
});
const branch = (entries: readonly unknown[]) =>
  ({ sessionManager: { getBranch: () => entries } }) as any;

describe("goal session persistence", () => {
  it("restores the last valid snapshot, skipping malformed entries", () => {
    const source = new SessionGoalController(() => 1_000);
    source.start("plan", "rev");
    source.pause("old");
    const newer = new SessionGoalController(() => 2_000);
    newer.start("plan", "rev");
    newer.pause("new");
    const target = new SessionGoalController();
    const result = restoreGoalState(
      branch([
        entry(source.serialize()),
        entry({ bad: true }),
        { type: "message" },
        entry(newer.serialize()),
      ]),
      target,
    );
    expect(result.isOk()).toBe(true);
    expect(target.current?.reason).toBe("new");
  });
  it("clears state when there are no valid goal entries and persists a clear envelope", () => {
    const controller = new SessionGoalController();
    controller.start("plan", "rev");
    const result = restoreGoalState(
      branch([{ type: "message" }, entry({ version: 99, state: null })]),
      controller,
    );
    expect(result.isOk()).toBe(true);
    expect(controller.current).toBeUndefined();
    const calls: unknown[] = [];
    persistGoalState(
      { appendEntry: (...args: unknown[]) => calls.push(args) },
      controller,
    );
    expect(calls).toEqual([
      [WEAVE_GOAL_STATE_ENTRY_TYPE, { version: 1, state: null }],
    ]);
  });
});
