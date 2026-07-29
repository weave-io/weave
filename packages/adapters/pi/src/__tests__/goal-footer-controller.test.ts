// biome-ignore-all lint/suspicious/noExplicitAny: isolated timer fake intentionally records opaque handles.
import { describe, expect, it } from "bun:test";
import {
  type PlanTaskSnapshot,
  SessionGoalController,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import {
  GOAL_FOOTER_REFRESH_INTERVAL_MS,
  PiGoalFooterController,
} from "../goal-footer-controller.js";

const snap: PlanTaskSnapshot = {
  planName: "goal",
  contentRevision: "r",
  format: "canonical",
  parents: [{ id: "1", title: "Task", state: "pending", children: [] }],
  totalParentCount: 1,
  complete: false,
};
function setup(read = () => okAsync(snap), child = false) {
  const controller = new SessionGoalController(() => 0);
  controller.start("goal", "r");
  const statuses: unknown[] = [];
  const timers: any[] = [];
  const footer = new PiGoalFooterController({
    controller,
    readSnapshot: read,
    setStatus: (_k, v) => statuses.push(v),
    isChildMode: () => child,
    timer: {
      schedule: (cb, delay) => {
        const t = {
          cb,
          delay,
          cancel: () => {
            t.cancelled = true;
          },
          unref: () => {
            t.unreffed = true;
          },
          cancelled: false,
          unreffed: false,
        };
        timers.push(t);
        return t;
      },
    },
  });
  return { controller, footer, statuses, timers };
}
describe("PiGoalFooterController", () => {
  it("deduplicates status, refreshes cold/warm failures, and reuses cache", async () => {
    const s = setup();
    await s.footer.refreshFromPlan();
    const count = s.statuses.length;
    s.footer.refreshFromCache();
    expect(s.statuses.length).toBe(count);
    await s.footer.refreshFromPlan();
    expect(s.statuses.length).toBe(count);
    const failure = setup(() => errAsync({ code: "read" } as never));
    await failure.footer.refreshFromPlan();
    expect(failure.statuses.at(-1)).toContain("plan unavailable");
  });
  it("keeps warm cache on read failure, reuses unchanged revisions, and writes the first undefined state", async () => {
    let fail = false;
    let reads = 0;
    const s = setup(() => {
      reads += 1;
      return fail ? errAsync({ code: "read" } as never) : okAsync(snap);
    });
    await s.footer.refreshFromPlan();
    const first = s.statuses.at(-1);
    fail = true;
    await s.footer.refreshFromPlan();
    expect(s.statuses.at(-1)).toBe(first);
    expect(reads).toBe(2);
    s.controller.clear();
    const beforeClear = s.statuses.length;
    s.footer.refreshFromCache();
    expect(s.statuses.length).toBeGreaterThan(beforeClear);
    expect(s.statuses[s.statuses.length - 1]).toBeUndefined();
  });

  it("schedules only pursuing updates, unreferences them, and clears stale generations", async () => {
    const s = setup();
    await s.footer.refreshFromPlan();
    expect(s.timers[0].delay).toBe(GOAL_FOOTER_REFRESH_INTERVAL_MS);
    expect(s.timers[0].unreffed).toBe(true);
    const statusBeforeTimer = s.statuses.length;
    s.timers[0].cb();
    expect(s.statuses.length).toBe(statusBeforeTimer);
    s.controller.pause("hold");
    s.footer.refreshFromCache();
    expect(s.timers.at(-1)?.cancelled).toBe(true);
    const stale = s.timers[0];
    const statusBeforeStale = s.statuses.length;
    stale.cb();
    expect(s.statuses.length).toBe(statusBeforeStale);
  });
  it("restore and clear repaint, while child mode is inert", async () => {
    const s = setup();
    await s.footer.restore();
    s.controller.clear();
    s.footer.clear();
    expect(s.statuses.at(-1)).toBeUndefined();
    const child = setup(undefined, true);
    await child.footer.refreshFromPlan();
    child.footer.refreshFromCache();
    child.footer.restore();
    child.footer.clear();
    expect(child.statuses).toEqual([]);
  });
});
