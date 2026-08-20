import { describe, expect, it } from "bun:test";
import { EMPTY_USAGE_AGGREGATE, type PiChildTreeNode } from "../child-tree.js";
import {
  type ChildTreeRenderNodeMetadata,
  renderChildTreeLines,
} from "../child-tree-render.js";

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

function codePointWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    cp === 0x200d
  )
    return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

function visualWidth(value: string): number {
  let width = 0;
  for (const ch of value) {
    width += codePointWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

describe("renderChildTreeLines", () => {
  it("returns an empty array (hides widget) when there are no nodes", () => {
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

  it("includes trusted workflow and step labels from optional metadata", () => {
    const lines = renderChildTreeLines(
      [node({ id: "child-1" })],
      "root",
      EMPTY_USAGE_AGGREGATE,
      {
        nodeMetadata: new Map<string, ChildTreeRenderNodeMetadata>([
          [
            "child-1",
            {
              workflowName: "release-pipeline",
              stepName: "build",
            },
          ],
        ]),
      },
    );

    expect(lines[0]).toContain("[release-pipeline/build]");
  });

  it("shows intervention and queue counts when present", () => {
    const lines = renderChildTreeLines(
      [node({ id: "child-1" })],
      "root",
      EMPTY_USAGE_AGGREGATE,
      {
        nodeMetadata: {
          "child-1": {
            interventionCount: 4,
            queueSize: 2,
          },
        },
      },
    );

    expect(lines[0]).toContain("interventions:4");
    expect(lines[0]).toContain("queue:2");
  });

  it("renders trimmed, recovery, interruption, and terminal markers", () => {
    const lines = renderChildTreeLines(
      [node({ id: "child-1", currentTool: "bash" })],
      "child-1",
      EMPTY_USAGE_AGGREGATE,
      {
        width: 240,
        nodeMetadata: {
          "child-1": {
            trimmed: true,
            recoveryContinuation: true,
            interruptedHistory: true,
            terminal: true,
          },
        },
      },
    );

    expect(lines[0]).toContain("trimmed");
    expect(lines[0]).toContain("recovery");
    expect(lines[0]).toContain("interrupted");
    expect(lines[0]).toContain("terminal");
  });

  it("renders unknown status values without throwing", () => {
    const lines = renderChildTreeLines(
      [
        node({
          id: "child-1",
          status: "unknown" as unknown as PiChildTreeNode["status"],
        }),
      ],
      "root",
      EMPTY_USAGE_AGGREGATE,
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[unknown]");
  });

  it("sanitizes ANSI/control/unicode in names, labels, and tools", () => {
    const lines = renderChildTreeLines(
      [
        node({
          id: "child-1",
          name: "\u001b[31mshutt\x1b[0mle\nchild",
          currentTool: "\x1b[34m\u0007\u001b[0medit\x1b[0m",
          latestOutput: "control-\x00\x07-canary",
        }),
      ],
      "child-1",
      EMPTY_USAGE_AGGREGATE,
      {
        nodeMetadata: {
          "child-1": {
            workflowName: "\u001b[1mrelease\u001b[0m",
            stepName: "子タスク",
          },
        },
      },
    );

    const line = lines[0];
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\x00");
    expect(line).not.toContain("\x07");
    expect(line).toContain("shuttle child");
    expect(line).toContain("edit");
    expect(line).toContain("[release/子タスク]");
    expect(line).not.toContain("\n");
  });

  it("clips lines at width 1, 2, 8, 20, and 80", () => {
    const widths = [1, 2, 8, 20, 80];
    const base = node({
      name: "shuttle-worker",
      currentTool: "toolbox",
      elapsedMs: 65_000,
      currentTurn: 12,
    });
    const meta: ChildTreeRenderNodeMetadata = {
      workflowName: "release",
      stepName: "very-long-step-name",
      interventionCount: 7,
      queueSize: 3,
      trimmed: true,
      recoveryContinuation: true,
      interruptedHistory: true,
      terminal: true,
    };

    for (const width of widths) {
      const lines = renderChildTreeLines(
        [base],
        "root",
        EMPTY_USAGE_AGGREGATE,
        {
          width,
          nodeMetadata: new Map([["child-1", meta]]),
        },
      );
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(visualWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("appends exactly one cumulative line at the end", () => {
    const lines = renderChildTreeLines(
      [node({ id: "child-1" }), node({ id: "child-2", name: "tapestry" })],
      "child-2",
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.5,
      },
    );

    const cumulative = lines.filter((line) => line.includes("cumulative:"));
    expect(lines).toHaveLength(3);
    expect(cumulative).toHaveLength(1);
    expect(lines.at(-1)).toBe(cumulative[0]);
    expect(cumulative[0]).toContain("in:10 out:20");
    for (const line of lines.slice(0, -1)) {
      expect(line.includes("cumulative:")).toBe(false);
    }
  });

  it("never includes raw task content in rendered lines", () => {
    const lines = renderChildTreeLines(
      [
        node({
          id: "child-1",
          latestOutput: "raw task canary: do not show this",
          name: "safe-child",
        }),
      ],
      "root",
      EMPTY_USAGE_AGGREGATE,
      {
        nodeMetadata: {
          "child-1": {
            workflowName: "trusted",
          },
        },
      },
    );

    expect(lines.join("\n")).not.toContain("raw task canary");
    expect(lines[0]).toContain("safe-child");
  });
});
