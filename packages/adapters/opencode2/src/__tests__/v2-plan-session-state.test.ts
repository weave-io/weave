import { describe, expect, it } from "bun:test";
import type { PlanTaskSnapshot } from "@weaveio/weave-engine";
import type { OpenCode2Context } from "../v2/host-types.js";
import {
  OpenCode2PlanSessionState,
  selectionFromSnapshot,
} from "../v2/plan-session-state.js";

class MemoryStorage {
  readonly values = new Map<
    string,
    Awaited<ReturnType<OpenCode2Context["storage"]["get"]>>
  >();
  readonly removed: string[] = [];
  async get(key: string) {
    return this.values.get(key);
  }
  async set(
    key: string,
    value: Parameters<OpenCode2Context["storage"]["set"]>[1],
  ) {
    this.values.set(key, value);
  }
  async remove(key: string) {
    this.removed.push(key);
    this.values.delete(key);
  }
}

const snapshot: PlanTaskSnapshot = {
  planName: "release",
  contentRevision: "a".repeat(64),
  format: "canonical",
  parents: [
    { id: "1", title: "Build", state: "completed", children: [] },
    { id: "2", title: "Ship", state: "pending", children: [] },
  ],
  totalParentCount: 2,
  totalTaskCount: 2,
  completedTaskCount: 1,
  complete: false,
};

describe("OpenCode2PlanSessionState", () => {
  it("stores only bounded display metadata under the session key", async () => {
    const storage = new MemoryStorage();
    const state = new OpenCode2PlanSessionState(storage);
    const selection = selectionFromSnapshot(
      "session",
      "/project",
      "workspace",
      snapshot,
    );
    expect((await state.set(selection)).isOk()).toBe(true);
    expect((await state.get("session"))._unsafeUnwrap()).toEqual({
      ...selection,
      currentTitle: "Ship",
    });
    expect(JSON.stringify(storage.values)).not.toContain("parents");
  });

  it("clears invalid stored values instead of trusting them", async () => {
    const storage = new MemoryStorage();
    storage.values.set("plan/session", { version: 99 });
    const state = new OpenCode2PlanSessionState(storage);
    expect((await state.get("session"))._unsafeUnwrap()).toBeUndefined();
    expect(storage.removed).toEqual(["plan/session"]);
  });
});
