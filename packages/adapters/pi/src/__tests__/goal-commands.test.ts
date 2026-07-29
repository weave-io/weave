// biome-ignore-all lint/suspicious/noExplicitAny: isolated host fakes intentionally model only exercised ports.
import { describe, expect, it } from "bun:test";
import {
  type PlanTaskSnapshot,
  SessionGoalController,
} from "@weaveio/weave-engine";
import { okAsync } from "neverthrow";
import { handleWeaveGoal } from "../goal-commands.js";
import { FakePiPlanCatalogPort } from "../plan-catalog.js";

const snapshot: PlanTaskSnapshot = {
  planName: "alpha",
  contentRevision: "r",
  format: "canonical",
  parents: [{ id: "1", title: "Task", state: "pending", children: [] }],
  totalParentCount: 1,
  complete: false,
};
function setup(active: SessionGoalController = new SessionGoalController()) {
  const notices: string[] = [];
  const entries: unknown[] = [];
  const sent: unknown[] = [];
  const order: string[] = [];
  const deps: any = {
    pi: {
      appendEntry: (_t: string, d: unknown) => {
        order.push("persist");
        entries.push(d);
      },
      getActiveTools: () => [],
      setActiveTools: () => {
        order.push("tool sync");
      },
      sendMessage: (m: unknown) => {
        order.push("send");
        sent.push(m);
      },
    },
    controller: active,
    catalog: new FakePiPlanCatalogPort(["alpha", "status"]),
    projectRoot: "/virtual",
    readSnapshot: () => okAsync(snapshot),
    footer: {
      refreshFromPlan: () => {
        order.push("footer refresh");
      },
      clear: () => {},
    },
  };
  return {
    deps,
    ui: { notify: (m: string) => notices.push(m) } as any,
    notices,
    entries,
    sent,
    order,
  };
}
describe("handleWeaveGoal", () => {
  it("handles the /weave:goal command lifecycle without durable execution", async () => {
    const s = setup();
    await handleWeaveGoal("alpha", s.ui, s.deps);
    expect(s.deps.controller.current?.planName).toBe("alpha");
  });
  it("handles start ordering and status metrics without durable or authorization calls", async () => {
    const s = setup();
    const forbidden = [
      "startExecution",
      "resumeExecution",
      "confirmStep",
      "approveArtifact",
      "reconcile",
      "mintAuthorization",
    ];
    for (const name of forbidden)
      (s.deps as any)[name] = () => {
        throw new Error(name);
      };
    await handleWeaveGoal("alpha", s.ui, s.deps);
    expect(s.deps.controller.current?.planName).toBe("alpha");
    expect(s.entries.length).toBe(1);
    expect(s.sent.length).toBe(1);
    expect(s.order).toEqual(["persist", "tool sync", "footer refresh", "send"]);
    await handleWeaveGoal("status", s.ui, s.deps);
    expect(s.notices.join("\n")).toContain("Turns:");
  });
  it("supports pause, resume direction, pursuing no-op, and every clear alias", async () => {
    const s = setup();
    await handleWeaveGoal("alpha", s.ui, s.deps);
    await handleWeaveGoal("pause", s.ui, s.deps);
    expect(s.deps.controller.current?.status).toBe("paused");
    await handleWeaveGoal("resume new direction", s.ui, s.deps);
    expect(s.deps.controller.current?.status).toBe("pursuing");
    await handleWeaveGoal("resume", s.ui, s.deps);
    for (const alias of ["stop", "off", "reset", "none", "cancel", "clear"]) {
      await handleWeaveGoal(alias, s.ui, s.deps);
      expect(s.deps.controller.current).toBeUndefined();
      await handleWeaveGoal("alpha", s.ui, s.deps);
    }
  });
  it("reports invalid input and collision hints without changing durable state", async () => {
    const s = setup();
    await handleWeaveGoal("status", s.ui, s.deps);
    expect(s.notices[0]).toContain("-- status");
    const before = s.entries.length;
    await handleWeaveGoal("bad/name", s.ui, s.deps);
    expect(s.entries.length).toBe(before);
    expect(s.notices.at(-1)).toContain("Invalid goal command");
  });
});
