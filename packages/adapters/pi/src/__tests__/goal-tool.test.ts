// biome-ignore-all lint/suspicious/noExplicitAny: isolated Pi registration fake intentionally models only exercised fields.
import { describe, expect, it } from "bun:test";
import {
  type PlanTaskSnapshot,
  SessionGoalController,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import {
  registerWeaveGoalReportTool,
  WEAVE_GOAL_REPORT_TOOL_NAME,
} from "../goal-tool.js";

const plan = (complete: boolean): PlanTaskSnapshot => ({
  planName: "goal",
  contentRevision: "r",
  format: "canonical",
  parents: [
    {
      id: "1",
      title: "Finish",
      state: complete ? "completed" : "pending",
      children: [],
    },
  ],
  totalParentCount: 1,
  complete,
});
function setup(read = () => okAsync(plan(true))) {
  const controller = new SessionGoalController(() => 0);
  controller.start("goal", "r");
  const active = ["other"];
  const entries: unknown[] = [];
  let registration: any;
  const pi = {
    registerTool: (tool: any) => {
      registration = tool;
    },
    getActiveTools: () => active,
    setActiveTools: (names: readonly string[]) => {
      active.splice(0, active.length, ...names);
    },
    appendEntry: (...args: unknown[]) => entries.push(args),
  };
  registerWeaveGoalReportTool({ pi, controller, readSnapshot: read });
  return { controller, active, entries, registration };
}
const ctx = {} as any;

describe("weave_goal_report", () => {
  it("has the fixed schema, sequential mode, and terminate result", async () => {
    const s = setup();
    expect(s.registration.name).toBe(WEAVE_GOAL_REPORT_TOOL_NAME);
    expect(s.registration.executionMode).toBe("sequential");
    expect(s.registration.parameters).toBeDefined();
    const result = await s.registration.execute(
      "call",
      { status: "achieved", evidence: "all tests pass" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.terminate).toBe(true);
    expect(s.controller.current?.status).toBe("achieved");
    expect(s.entries.length).toBe(1);
  });
  it("refuses incomplete achievement but retains evidence", async () => {
    const s = setup(() => okAsync(plan(false)));
    const result = await s.registration.execute(
      "call",
      { status: "achieved", evidence: "I checked the first task" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(s.controller.current?.status).toBe("pursuing");
    expect(s.controller.current?.evidence).toContain("first task");
    expect(s.entries.length).toBe(1);
  });
  it("blocks with reason and handles read failure safely", async () => {
    const blocked = setup();
    const br = await blocked.registration.execute(
      "c",
      { status: "blocked", evidence: "dependency unavailable" },
      undefined,
      undefined,
      ctx,
    );
    expect(br.terminate).toBe(true);
    expect(blocked.controller.current?.status).toBe("blocked");
    expect(blocked.controller.current?.reason).toContain("dependency");
    const failed = setup(() => errAsync({ type: "read-failed" } as never));
    const ar = await failed.registration.execute(
      "c",
      { status: "achieved", evidence: "claim" },
      undefined,
      undefined,
      ctx,
    );
    expect(ar.content[0]).toMatchObject({
      text: "Goal completion could not be verified safely.",
    });
    expect(failed.controller.current?.status).toBe("pursuing");
  });
  it("registers the report tool and preserves unrelated active tools", () => {
    const controller = new SessionGoalController();
    const active = ["other", WEAVE_GOAL_REPORT_TOOL_NAME];
    let registered = false;
    const pi = {
      registerTool: () => {
        registered = true;
      },
      getActiveTools: () => active,
      setActiveTools: (n: readonly string[]) =>
        active.splice(0, active.length, ...n),
      appendEntry: () => {},
    };
    registerWeaveGoalReportTool({
      pi,
      controller,
      readSnapshot: () => okAsync(plan(true)),
    });
    expect(registered).toBe(true);
    expect(active).toEqual(["other"]);
  });
});
