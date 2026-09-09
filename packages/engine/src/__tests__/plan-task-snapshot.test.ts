import { describe, expect, it } from "bun:test";
import type { PlanTaskSnapshot } from "../plan-task-snapshot.js";

describe("PlanTaskSnapshot", () => {
  it("represents immutable read-only progress without changing PlanStateProvider", () => {
    const snapshot: PlanTaskSnapshot = {
      planName: "release",
      contentRevision: "a".repeat(64),
      format: "canonical",
      parents: [],
      totalParentCount: 0,
      totalTaskCount: 0,
      completedTaskCount: 0,
      complete: true,
    };
    expect(snapshot.complete).toBe(true);
  });
});
