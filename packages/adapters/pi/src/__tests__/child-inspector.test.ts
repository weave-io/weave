import { describe, expect, it } from "bun:test";
import { okAsync, ResultAsync } from "neverthrow";
import {
  PiChildInspector,
  type PiInspectorChild,
  type PiInspectorRpc,
} from "../child-inspector.js";

const child = (
  childId: string,
  status: PiInspectorChild["status"] = "running",
  extra: Partial<PiInspectorChild> = {},
): PiInspectorChild => ({
  childId,
  name: childId,
  kind: "ordinary",
  status,
  live: status === "running",
  generationId: `g-${childId}`,
  ...extra,
});
const rpc: PiInspectorRpc = {
  steer: () => okAsync(undefined),
  followUp: () => okAsync(undefined),
  cancel: () => okAsync(undefined),
};

describe("PiChildInspector", () => {
  it("keeps view state exact across switches", () => {
    const inspector = new PiChildInspector("root", rpc);
    const a = child("a");
    const b = child("b");
    inspector.open("a", [a, b]);
    inspector.updateState("a", {
      draft: "draft",
      scrollOffset: 12,
      expandedTools: ["tool"],
      thinkingVisible: false,
      imagesVisible: false,
      queue: ["queued"],
    });
    inspector.open("b", [a, b]);
    inspector.open("a", [a, b]);
    expect(inspector.state("a")).toEqual({
      draft: "draft",
      scrollOffset: 12,
      expandedTools: ["tool"],
      thinkingVisible: false,
      imagesVisible: false,
      queue: ["queued"],
    });
  });

  it("releases slots on queued or terminal transitions and keeps IDs stable under reorder", () => {
    const inspector = new PiChildInspector("root", rpc);
    const a = child("a");
    const b = child("b");
    const queued = child("q", "queued");
    expect([
      ...inspector
        .setChildren({ ...child("root"), descendants: [a, b, queued] })
        .entries(),
    ]).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    inspector.setChildren({
      ...child("root"),
      descendants: [
        { ...b, status: "running" },
        { ...a, status: "queued" },
        queued,
      ],
    });
    expect(inspector.slots.childAt(1)).toBeUndefined();
    expect(inspector.slots.childAt(2)).toBe("b");
    inspector.setChildren({
      ...child("root"),
      descendants: [
        { ...queued, status: "running" },
        { ...b, status: "running" },
        { ...a, status: "settled" },
      ],
    });
    expect(inspector.slots.childAt(1)).toBe("q");
    expect(inspector.slots.childAt(2)).toBe("b");
  });

  it("confirms and cancels only the selected subtree", async () => {
    let message = "";
    let cancelled = "";
    const cancelRpc: PiInspectorRpc = {
      ...rpc,
      cancel: (id) => {
        cancelled = id;
        return okAsync(undefined);
      },
    };
    const inspector = new PiChildInspector("root", cancelRpc);
    const selected = child("a", "running", {
      currentTool: "shell",
      descendants: [child("desc")],
    });
    const confirmation = {
      confirm: (text: string) => {
        message = text;
        return okAsync(true);
      },
    };
    const result = await inspector.escape(selected, "g-a", confirmation);
    expect(result.isOk()).toBe(true);
    expect(cancelled).toBe("a");
    expect(message).toContain("shell");
    expect(message).toContain("desc");
  });

  it("maps confirmation throws and rejections without cancelling", async () => {
    let cancelled = 0;
    const inspector = new PiChildInspector("root", {
      ...rpc,
      cancel: () => {
        cancelled += 1;
        return okAsync(undefined);
      },
    });
    const selected = child("a");
    const thrown = await inspector.escape(selected, "g-a", {
      confirm: () => {
        throw new Error("boom");
      },
    });
    const rejected = await inspector.escape(selected, "g-a", {
      confirm: () =>
        ResultAsync.fromPromise(
          Promise.reject(new Error("boom")),
          () => new Error("boom"),
        ),
    });
    expect(thrown.isErr() && thrown.error.type).toBe("cancel-rejected");
    expect(rejected.isErr() && rejected.error.type).toBe("cancel-rejected");
    expect(cancelled).toBe(0);
  });
});
