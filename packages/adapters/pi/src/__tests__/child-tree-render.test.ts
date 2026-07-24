import { describe, expect, it } from "bun:test";
import { EMPTY_USAGE_AGGREGATE, type PiChildTreeNode } from "../child-tree.js";
import { renderChildTreeLines } from "../child-tree-render.js";

function node(overrides: Partial<PiChildTreeNode> = {}): PiChildTreeNode {
  return {
    id: "child-1",
    parentId: "root",
    name: "shuttle",
    status: "running",
    currentTurn: 1,
    currentTool: undefined,
    startedAtMs: 0,
    elapsedMs: 1_500,
    usage: EMPTY_USAGE_AGGREGATE,
    latestOutput: "",
    ...overrides,
  };
}

describe("renderChildTreeLines", () => {
  it("returns an empty array (hides the widget) when there are no nodes", () => {
    expect(renderChildTreeLines([], "root", EMPTY_USAGE_AGGREGATE)).toEqual([]);
  });

  it("marks exactly the selected node", () => {
    const lines = renderChildTreeLines(
      [node({ id: "child-1" }), node({ id: "child-2", name: "tapestry" })],
      "child-2",
      EMPTY_USAGE_AGGREGATE,
    );
    expect(lines[0].startsWith(" ")).toBe(true);
    expect(lines[1].startsWith("\u25b6")).toBe(true);
  });

  it("includes status, current tool (when present), turn, and elapsed time", () => {
    const lines = renderChildTreeLines(
      [node({ currentTool: "bash", currentTurn: 3, elapsedMs: 65_000 })],
      "root",
      EMPTY_USAGE_AGGREGATE,
    );
    expect(lines[0]).toContain("[running]");
    expect(lines[0]).toContain("tool:bash");
    expect(lines[0]).toContain("turn:3");
    expect(lines[0]).toContain("elapsed:1m5s");
  });

  it("omits the tool segment when no tool is currently active", () => {
    const lines = renderChildTreeLines(
      [node({ currentTool: undefined })],
      "root",
      EMPTY_USAGE_AGGREGATE,
    );
    expect(lines[0]).not.toContain("tool:");
  });

  it("appends exactly one trailing cumulative-usage summary line", () => {
    const lines = renderChildTreeLines(
      [node(), node({ id: "child-2" })],
      "root",
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.5,
      },
    );
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain("cumulative:");
    expect(lines[2]).toContain("in:10 out:20");
    expect(lines[2]).toContain("cost:0.5000");
  });
});
