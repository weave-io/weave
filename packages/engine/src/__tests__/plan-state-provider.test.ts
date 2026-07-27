import { describe, expect, it } from "bun:test";
import {
  applyAuthorizedPlanTransition,
  authorizePlanCoordinator,
  derivePlanParentState,
  isAllowedPlanLeafTransition,
  isPlanSnapshotComplete,
  PLAN_TASK_STATES,
  type PlanStateError,
  type PlanStateProvider,
  type PlanTaskSnapshot,
  type PlanTaskState,
  type PlanTaskTransition,
  validatePlanTransition,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";

function snapshot(): PlanTaskSnapshot {
  return {
    planName: "feature",
    contentRevision: "rev-1",
    format: "canonical",
    parents: [
      {
        id: "1",
        title: "Parent",
        state: "in_progress",
        children: [
          { id: "1.a", title: "Pending", state: "pending", children: [] },
          {
            id: "1.b",
            title: "Active",
            state: "in_progress",
            children: [],
          },
        ],
      },
      { id: "2", title: "Done", state: "completed", children: [] },
    ],
    totalParentCount: 2,
    complete: false,
  };
}

function transition(
  overrides: Partial<PlanTaskTransition> = {},
): PlanTaskTransition {
  return {
    planName: "feature",
    taskId: "1.a",
    expectedRevision: "rev-1",
    toState: "in_progress",
    coordinatorAgent: "tapestry",
    ...overrides,
  };
}

class RecordingPlanProvider implements PlanStateProvider {
  readonly calls: string[] = [];

  constructor(
    private readonly current: PlanTaskSnapshot = snapshot(),
    private readonly failure?: PlanStateError,
  ) {}

  readSnapshot() {
    this.calls.push("readSnapshot");
    if (this.failure !== undefined) return errAsync(this.failure);
    return okAsync(this.current);
  }

  applyTransition() {
    this.calls.push("applyTransition");
    return okAsync({
      ...this.current,
      contentRevision: "rev-2",
    });
  }

  planExists() {
    return okAsync(true);
  }

  isPlanComplete() {
    return okAsync(this.current.complete);
  }
}

describe("revisioned plan transition semantics", () => {
  it("PLAN_TASK_STATES exhaustively covers every PlanTaskState (Pi adapter contract plan markers)", () => {
    const members: readonly PlanTaskState[] = PLAN_TASK_STATES;
    expect(new Set(members)).toEqual(
      new Set([
        "pending",
        "in_progress",
        "completed",
      ] satisfies PlanTaskState[]),
    );
    expect(members).toHaveLength(3);
  });

  it("accepts only the closed leaf transition graph", () => {
    expect(isAllowedPlanLeafTransition("pending", "in_progress")).toBe(true);
    expect(isAllowedPlanLeafTransition("in_progress", "completed")).toBe(true);
    expect(isAllowedPlanLeafTransition("in_progress", "pending")).toBe(true);
    expect(isAllowedPlanLeafTransition("pending", "completed")).toBe(false);
    expect(isAllowedPlanLeafTransition("completed", "in_progress")).toBe(false);
    expect(isAllowedPlanLeafTransition("completed", "pending")).toBe(false);
    expect(isAllowedPlanLeafTransition("pending", "pending")).toBe(false);
  });

  it("derives parent and snapshot completion from leaf state", () => {
    expect(derivePlanParentState(["pending", "pending"])).toBe("pending");
    expect(derivePlanParentState(["completed", "completed"])).toBe("completed");
    expect(derivePlanParentState(["pending", "completed"])).toBe("in_progress");
    expect(isPlanSnapshotComplete(snapshot().parents)).toBe(false);
    expect(
      isPlanSnapshotComplete([
        { id: "1", title: "Done", state: "completed", children: [] },
      ]),
    ).toBe(true);
  });

  it("authorizes only the configured coordinator", () => {
    expect(authorizePlanCoordinator("tapestry", "feature").isOk()).toBe(true);
    expect(authorizePlanCoordinator("custom", "feature", "custom").isOk()).toBe(
      true,
    );
    expect(
      authorizePlanCoordinator("shuttle", "feature")._unsafeUnwrapErr().type,
    ).toBe("UnauthorizedCoordinator");
  });

  it("rejects stale revisions, non-leaf parents, unknown tasks, and invalid edges", () => {
    expect(
      validatePlanTransition(
        snapshot(),
        transition({ expectedRevision: "stale" }),
      )._unsafeUnwrapErr().type,
    ).toBe("PlanRevisionStale");
    expect(
      validatePlanTransition(
        snapshot(),
        transition({ taskId: "1" }),
      )._unsafeUnwrapErr().type,
    ).toBe("TaskNotFound");
    expect(
      validatePlanTransition(
        snapshot(),
        transition({ taskId: "missing" }),
      )._unsafeUnwrapErr().type,
    ).toBe("TaskNotFound");
    expect(
      validatePlanTransition(
        snapshot(),
        transition({ taskId: "2", toState: "in_progress" }),
      )._unsafeUnwrapErr().type,
    ).toBe("InvalidTransition");
  });

  it("delegates durable mutation only after engine authorization", async () => {
    const provider = new RecordingPlanProvider();
    const result = await applyAuthorizedPlanTransition(provider, transition());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().contentRevision).toBe("rev-2");
    expect(provider.calls).toEqual(["readSnapshot", "applyTransition"]);

    const denied = new RecordingPlanProvider();
    const deniedResult = await applyAuthorizedPlanTransition(
      denied,
      transition({ coordinatorAgent: "worker" }),
    );
    expect(deniedResult._unsafeUnwrapErr().type).toBe(
      "UnauthorizedCoordinator",
    );
    expect(denied.calls).toEqual(["readSnapshot"]);
  });

  it("propagates typed provider failures without calling mutation", async () => {
    const failure: PlanStateError = {
      type: "PlanReadFailed",
      planName: "feature",
      reason: "fixture",
    };
    const provider = new RecordingPlanProvider(snapshot(), failure);
    const result = await applyAuthorizedPlanTransition(provider, transition());
    expect(result._unsafeUnwrapErr()).toEqual(failure);
    expect(provider.calls).toEqual(["readSnapshot"]);
  });
});
