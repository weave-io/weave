import { describe, expect, it } from "bun:test";
import type { PlanTaskSnapshot } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import { resolveGoalPlan } from "../goal-plan-resolver.js";
import { FakePiPlanCatalogPort } from "../plan-catalog.js";

const snapshot = (planName: string): PlanTaskSnapshot => ({
  planName,
  contentRevision: "rev-1",
  format: "canonical",
  parents: [],
  totalParentCount: 0,
  complete: true,
});

describe("resolveGoalPlan", () => {
  it("resolves a known plan and reports safe available count for an unknown plan", async () => {
    const catalog = new FakePiPlanCatalogPort(["alpha", "safe_name"]);
    const readSnapshot = (name: string) => okAsync(snapshot(name));
    expect(
      (
        await resolveGoalPlan({
          planName: "alpha",
          catalog,
          projectRoot: "/project",
          readSnapshot,
        })
      )._unsafeUnwrap(),
    ).toEqual(snapshot("alpha"));
    const missing = await resolveGoalPlan({
      planName: "missing",
      catalog,
      projectRoot: "/project",
      readSnapshot,
    });
    expect(missing._unsafeUnwrapErr()).toMatchObject({
      code: "PlanMissing",
      correlation: { availablePlanCount: 2 },
    });
  });
  it("propagates catalog failure and does not read a real directory", async () => {
    let reads = 0;
    const failure = {
      type: "PlanCatalogUnavailable",
      reason: "no access",
    } as never;
    const result = await resolveGoalPlan({
      planName: "alpha",
      catalog: new FakePiPlanCatalogPort([], failure),
      projectRoot: "/does-not-exist",
      readSnapshot: () => {
        reads++;
        return okAsync(snapshot("alpha"));
      },
    });
    expect(result.isErr()).toBe(true);
    expect(reads).toBe(0);
  });
  it("propagates snapshot, malformed, and legacy failures", async () => {
    const catalog = new FakePiPlanCatalogPort(["alpha"]);
    for (const failure of [
      { type: "PlanReadFailed" },
      { type: "PlanTreeMalformed" },
      { type: "LegacyPlanUnsupported" },
    ] as const) {
      const result = await resolveGoalPlan({
        planName: "alpha",
        catalog,
        projectRoot: "/project",
        readSnapshot: () => errAsync(failure as never),
      });
      expect(result.isErr()).toBe(true);
    }
  });
});
