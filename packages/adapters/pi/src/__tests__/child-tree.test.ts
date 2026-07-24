import { describe, expect, it } from "bun:test";
import {
  addUsage,
  applyTreeControlKey,
  EMPTY_USAGE_AGGREGATE,
  extractAssistantStopReason,
  extractAssistantTextDeltaPreview,
  MAX_LATEST_OUTPUT_BYTES,
  type PiChildTreeNode,
  ROOT_NODE_ID,
  subtreeIds,
  truncateLatestOutput,
} from "../child-tree.js";

function node(
  overrides: Partial<PiChildTreeNode> & { id: string },
): PiChildTreeNode {
  return {
    parentId: ROOT_NODE_ID,
    name: overrides.id,
    status: "running",
    currentTurn: 0,
    currentTool: undefined,
    startedAtMs: 0,
    elapsedMs: 0,
    usage: EMPTY_USAGE_AGGREGATE,
    latestOutput: "",
    ...overrides,
  };
}

describe("addUsage", () => {
  it("sums each token/cost field, defaulting missing fields to 0", () => {
    const result = addUsage(EMPTY_USAGE_AGGREGATE, {
      inputTokens: 5,
      cost: 0.1,
    });
    expect(result).toEqual({
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.1,
    });
  });

  it("accumulates across repeated calls", () => {
    let total = EMPTY_USAGE_AGGREGATE;
    total = addUsage(total, { inputTokens: 1 });
    total = addUsage(total, { inputTokens: 2, outputTokens: 3 });
    expect(total.inputTokens).toBe(3);
    expect(total.outputTokens).toBe(3);
  });
});

describe("truncateLatestOutput", () => {
  it("leaves short text untouched", () => {
    expect(truncateLatestOutput("hello")).toBe("hello");
  });

  it("truncates to at most 4 KiB of UTF-8 bytes", () => {
    const long = "a".repeat(MAX_LATEST_OUTPUT_BYTES + 500);
    const truncated = truncateLatestOutput(long);
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(
      MAX_LATEST_OUTPUT_BYTES,
    );
  });

  it("never splits a multi-byte code point at the truncation boundary", () => {
    // A 3-byte UTF-8 character repeated so the cut point would otherwise
    // land mid-character; the truncated output must still be valid UTF-8
    // with no U+FFFD replacement characters introduced by a bad split.
    const long = "\u2603".repeat(Math.ceil((MAX_LATEST_OUTPUT_BYTES + 30) / 3));
    const truncated = truncateLatestOutput(long);
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(
      MAX_LATEST_OUTPUT_BYTES,
    );
    expect(truncated.includes("\uFFFD")).toBe(false);
  });
});

describe("applyTreeControlKey", () => {
  function buildNodes(): Map<string, PiChildTreeNode> {
    const map = new Map<string, PiChildTreeNode>();
    map.set("root", node({ id: "root", parentId: undefined, name: "root" }));
    map.set("c1", node({ id: "c1", parentId: "root", startedAtMs: 10 }));
    map.set("c2", node({ id: "c2", parentId: "root", startedAtMs: 20 }));
    map.set("c3", node({ id: "c3", parentId: "root", startedAtMs: 30 }));
    map.set("g1", node({ id: "g1", parentId: "c1", startedAtMs: 40 }));
    return map;
  }

  it("Alt+1..Alt+9 selects the Nth direct child ordered by spawn time", () => {
    const nodes = buildNodes();
    expect(
      applyTreeControlKey(nodes, "root", {
        kind: "select-direct-child",
        index: 1,
      }),
    ).toEqual({ kind: "selected", nodeId: "c1" });
    expect(
      applyTreeControlKey(nodes, "root", {
        kind: "select-direct-child",
        index: 2,
      }),
    ).toEqual({ kind: "selected", nodeId: "c2" });
    expect(
      applyTreeControlKey(nodes, "root", {
        kind: "select-direct-child",
        index: 3,
      }),
    ).toEqual({ kind: "selected", nodeId: "c3" });
  });

  it("reports no-target for an out-of-range direct-child index", () => {
    const nodes = buildNodes();
    expect(
      applyTreeControlKey(nodes, "root", {
        kind: "select-direct-child",
        index: 9,
      }),
    ).toEqual({ kind: "no-target" });
  });

  it("Backspace selects the parent of the selected node", () => {
    const nodes = buildNodes();
    expect(applyTreeControlKey(nodes, "c1", { kind: "select-parent" })).toEqual(
      {
        kind: "selected",
        nodeId: "root",
      },
    );
  });

  it("Backspace at root preserves host-default behavior", () => {
    const nodes = buildNodes();
    expect(
      applyTreeControlKey(nodes, "root", { kind: "select-parent" }),
    ).toEqual({
      kind: "host-default",
    });
  });

  it("Esc on a non-root selected node requests cancellation", () => {
    const nodes = buildNodes();
    expect(
      applyTreeControlKey(nodes, "c1", { kind: "cancel-selected" }),
    ).toEqual({
      kind: "cancel-requested",
      nodeId: "c1",
    });
  });

  it("Esc at root preserves host-default behavior", () => {
    const nodes = buildNodes();
    expect(
      applyTreeControlKey(nodes, ROOT_NODE_ID, { kind: "cancel-selected" }),
    ).toEqual({
      kind: "host-default",
    });
  });

  it("Esc on an unknown selected node id reports no-target", () => {
    const nodes = buildNodes();
    expect(
      applyTreeControlKey(nodes, "missing", { kind: "cancel-selected" }),
    ).toEqual({
      kind: "no-target",
    });
  });
});

describe("subtreeIds", () => {
  it("returns the node id plus every descendant, inclusive", () => {
    const nodes = new Map<string, PiChildTreeNode>();
    nodes.set("root", node({ id: "root", parentId: undefined }));
    nodes.set("c1", node({ id: "c1", parentId: "root" }));
    nodes.set("c2", node({ id: "c2", parentId: "root" }));
    nodes.set("g1", node({ id: "g1", parentId: "c1" }));
    nodes.set("g2", node({ id: "g2", parentId: "g1" }));

    expect(new Set(subtreeIds(nodes, "root"))).toEqual(
      new Set(["root", "c1", "c2", "g1", "g2"]),
    );
    expect(new Set(subtreeIds(nodes, "c1"))).toEqual(
      new Set(["c1", "g1", "g2"]),
    );
    expect(subtreeIds(nodes, "c2")).toEqual(["c2"]);
  });
});

describe("extractAssistantTextDeltaPreview (Task 9 finding 1)", () => {
  it("reads delta.text when present", () => {
    expect(
      extractAssistantTextDeltaPreview({
        type: "message_update",
        delta: { text: "hello" },
      }),
    ).toBe("hello");
  });

  it("returns undefined when delta is missing", () => {
    expect(
      extractAssistantTextDeltaPreview({ type: "message_update" }),
    ).toBeUndefined();
  });

  it("returns undefined when delta is not an object", () => {
    expect(
      extractAssistantTextDeltaPreview({
        type: "message_update",
        delta: "not-an-object",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when delta.text is not a string", () => {
    expect(
      extractAssistantTextDeltaPreview({
        type: "message_update",
        delta: { text: 42 },
      }),
    ).toBeUndefined();
  });
});

describe("extractAssistantStopReason (Task 9 finding 2)", () => {
  it("reads message.stopReason for an assistant message", () => {
    expect(
      extractAssistantStopReason({
        type: "message_end",
        message: { role: "assistant", stopReason: "error" },
      }),
    ).toBe("error");
  });

  it("returns undefined for a non-assistant message", () => {
    expect(
      extractAssistantStopReason({
        type: "message_end",
        message: { role: "toolResult", stopReason: "error" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when message is missing", () => {
    expect(extractAssistantStopReason({ type: "message_end" })).toBeUndefined();
  });

  it("returns undefined when stopReason is not a string", () => {
    expect(
      extractAssistantStopReason({
        type: "message_end",
        message: { role: "assistant", stopReason: 1 },
      }),
    ).toBeUndefined();
  });

  it("reads every documented stop reason value verbatim", () => {
    for (const stopReason of [
      "stop",
      "length",
      "toolUse",
      "error",
      "aborted",
    ]) {
      expect(
        extractAssistantStopReason({
          type: "message_end",
          message: { role: "assistant", stopReason },
        }),
      ).toBe(stopReason);
    }
  });
});
