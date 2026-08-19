import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  addUsage,
  applyTreeControlKey,
  EMPTY_USAGE_AGGREGATE,
  extractAssistantStopReason,
  MAX_LATEST_OUTPUT_BYTES,
  type PiChildInspectionHistoryPort,
  type PiChildInspectionRegistration,
  PiChildInspectionRegistry,
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

// The `message_update` carrier readers that used to live in `child-tree.ts`
// now have exactly one authority. Their behaviour is covered, mutual
// exclusion included, in `message-update-carrier.test.ts`.

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

/**
 * Since ADR 0014 there is no adapter-owned history store. The registry writes
 * through an injected port, so tests observe the port calls directly.
 */
interface RecordedChild {
  readonly childId: string;
  workflow?: { workflow?: string; step?: string };
  finalOutput: string;
  status: string;
}

function recordingHistoryPort(): {
  port: PiChildInspectionHistoryPort;
  records: RecordedChild[];
} {
  const records: RecordedChild[] = [];
  const registrations = new Map<string, PiChildInspectionRegistration>();
  const find = (childId: string) =>
    records.find((entry) => entry.childId === childId);
  const port: PiChildInspectionHistoryPort = {
    register: (registration) => {
      registrations.set(registration.id, registration);
      records.push({
        childId: registration.id,
        workflow: {
          workflow: registration.workflowInstanceId,
          step: registration.stepName,
        },
        finalOutput: "",
        status: "running",
      });
      return okAsync(undefined);
    },
    checkpoint: () => okAsync(undefined),
    interrupted: (id) => {
      const record = find(id);
      if (record) record.status = "interrupted";
      return okAsync(undefined);
    },
    terminal: (id, snapshot, finalOutput) => {
      const record = find(id);
      if (record) {
        record.status =
          snapshot.status === "completed" ? "settled" : "interrupted";
        if (finalOutput !== undefined) record.finalOutput = finalOutput;
      }
      return okAsync(undefined);
    },
  };
  return { port, records };
}

describe("PiChildInspectionRegistry persistence", () => {
  it("uses one valid ROOT topology for ordinary, nested, and workflow-step registrations", async () => {
    const registrations: string[] = [];
    const registry = new PiChildInspectionRegistry({
      register: (entry) => {
        registrations.push(`${entry.id}:${entry.parentId}:${entry.kind}`);
        return okAsync(undefined);
      },
    });
    await registry.register({
      id: "ordinary",
      parentId: ROOT_NODE_ID,
      name: "ordinary",
      kind: "ordinary",
      snapshot: () => node({ id: "ordinary" }),
    });
    await registry.register({
      id: "nested",
      parentId: "ordinary",
      name: "nested",
      kind: "nested",
      snapshot: () => node({ id: "nested", parentId: "ordinary" }),
    });
    await registry.register({
      id: "step",
      parentId: ROOT_NODE_ID,
      name: "step",
      kind: "workflow-step",
      workflowInstanceId: "workflow-1",
      stepName: "step-1",
      snapshot: () => node({ id: "step" }),
    });
    await registry.drain();
    expect(registrations).toEqual([
      "ordinary:root:ordinary",
      "nested:ordinary:nested",
      "step:root:workflow-step",
    ]);
    expect(registry.snapshotLive().map((entry) => entry.id)).toEqual([
      "ordinary",
      "nested",
      "step",
    ]);
  });

  it("updates provider and model together for an authenticated applied transition", async () => {
    const registry = new PiChildInspectionRegistry();
    await registry.register({
      id: "child",
      parentId: ROOT_NODE_ID,
      name: "child",
      kind: "ordinary",
      snapshot: () => node({ id: "child" }),
      model: "model-a",
      provider: "origin",
    });
    const result = registry.updateModelIdentity("child", {
      provider: "fallback",
      id: "model-b",
      name: "Fallback",
    });
    expect(result.isOk()).toBe(true);
    expect(registry.getChildRuntimeMeta("child")).toEqual({
      model: "model-b",
      provider: "fallback",
      modelIdentity: {
        provider: "fallback",
        id: "model-b",
        name: "Fallback",
      },
    });
    expect(
      registry
        .updateModelIdentity("missing", {
          provider: "fallback",
          id: "model-b",
        })
        .isErr(),
    ).toBe(true);
  });

  it("rejects duplicate and closed recovered attachments without history writes", async () => {
    const writes: string[] = [];
    const registry = new PiChildInspectionRegistry({
      register: () => okAsync(undefined),
      checkpoint: () => okAsync(undefined),
    });
    const registration = {
      id: "recovered",
      parentId: ROOT_NODE_ID,
      name: "ordinary",
      kind: "ordinary" as const,
      snapshot: () => node({ id: "recovered" }),
    };
    expect((await registry.attachRecovered(registration)).isOk()).toBe(true);
    expect((await registry.attachRecovered(registration)).isErr()).toBe(true);
    registry.closeGeneration();
    expect(
      (
        await registry.attachRecovered({ ...registration, id: "closed" })
      ).isErr(),
    ).toBe(true);
    expect(writes).toEqual([]);
  });

  it("keeps trusted workflow metadata when checkpoint events contain forged fields", async () => {
    const { port, records } = recordingHistoryPort();
    const registry = new PiChildInspectionRegistry(port);
    await registry.register({
      id: "step",
      parentId: ROOT_NODE_ID,
      name: "step",
      kind: "workflow-step",
      workflowInstanceId: "trusted-workflow",
      stepName: "trusted-step",
      snapshot: () => node({ id: "step" }),
    });
    await registry.checkpointEvent("step", {
      type: "status",
      status: "running",
      workflowInstanceId: "forged-workflow",
      stepName: "forged-step",
    });
    await registry.drain();
    const record = records.find((entry) => entry.childId === "step");
    expect(record?.workflow).toEqual({
      workflow: "trusted-workflow",
      step: "trusted-step",
    });
  });

  it("notifies a transcript listener so a live inspection view can repaint", async () => {
    const registry = new PiChildInspectionRegistry();
    await registry.register({
      id: "child",
      parentId: ROOT_NODE_ID,
      name: "child",
      kind: "ordinary",
      snapshot: () => node({ id: "child" }),
    });
    const seen: string[] = [];
    registry.onTranscriptUpdate((childId) => seen.push(childId));
    await registry.checkpointEvent("child", { type: "text", text: "one" });
    await registry.checkpointEvent("missing", { type: "text", text: "skip" });
    registry.onTranscriptUpdate(undefined);
    await registry.checkpointEvent("child", { type: "text", text: "two" });
    await registry.drain();

    expect(seen).toEqual(["child"]);
    expect(registry.getTranscriptState("child").entries.length).toBeGreaterThan(
      1,
    );
  });

  it("keeps intermediate latestOutput out of finalOutput and persists terminal output", async () => {
    const { port, records } = recordingHistoryPort();
    const registry = new PiChildInspectionRegistry(port);
    await registry.register({
      id: "child",
      parentId: ROOT_NODE_ID,
      name: "child",
      kind: "ordinary",
      snapshot: () => node({ id: "child", latestOutput: "intermediate" }),
    });
    await registry.checkpoint("child");
    await registry.drain();
    expect(
      records.find((entry) => entry.childId === "child")?.finalOutput,
    ).toBe("");
    await registry.retainTerminal(
      "child",
      node({ id: "child", status: "completed" }),
      "authenticated final",
    );
    await registry.drain();
    expect(
      records.find((entry) => entry.childId === "child")?.finalOutput,
    ).toBe("authenticated final");
  });

  it("rejects registration after close while retaining terminal history", async () => {
    const { port, records } = recordingHistoryPort();
    const registry = new PiChildInspectionRegistry(port);
    await registry.register({
      id: "old",
      parentId: ROOT_NODE_ID,
      name: "old",
      kind: "ordinary",
      snapshot: () => node({ id: "old" }),
    });
    await registry.retainTerminal(
      "old",
      node({ id: "old", status: "completed" }),
      "done",
    );
    registry.closeGeneration();
    await registry.register({
      id: "new",
      parentId: ROOT_NODE_ID,
      name: "new",
      kind: "ordinary",
      snapshot: () => node({ id: "new" }),
    });
    await registry.drain();
    expect(registry.snapshotLive()).toEqual([]);
    expect(records.map((entry) => entry.childId)).toEqual(["old"]);
  });
});

describe("PiChildInspectionRegistry persistence queue", () => {
  it("continues in order after a checkpoint failure and reports the first failure", async () => {
    const calls: string[] = [];
    const failure = {
      kind: "history-write-failed" as const,
      operation: "checkpoint" as const,
      reason: "unavailable" as const,
    };
    let checkpointCalls = 0;
    const registry = new PiChildInspectionRegistry({
      register: () => {
        calls.push("register");
        return okAsync(undefined);
      },
      checkpoint: () => {
        calls.push("checkpoint");
        checkpointCalls += 1;
        return checkpointCalls === 1 ? errAsync(failure) : okAsync(undefined);
      },
      interrupted: () => {
        calls.push("interrupted");
        return okAsync(undefined);
      },
      terminal: (_id, _snapshot, output) => {
        calls.push(`terminal:${output ?? ""}`);
        return okAsync(undefined);
      },
    });
    const snapshot = () => node({ id: "child", status: "completed" });
    await registry.register({
      id: "child",
      parentId: ROOT_NODE_ID,
      name: "child",
      kind: "ordinary",
      snapshot,
    });
    void registry.checkpoint("child");
    void registry.checkpoint("child");
    void registry.markInterrupted("child");
    void registry.retainTerminal("child", snapshot(), "final");
    const result = await registry.drain();
    expect(calls).toEqual([
      "register",
      "checkpoint",
      "checkpoint",
      "interrupted",
      "terminal:final",
    ]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(failure);
    expect(registry.snapshotLive()).toHaveLength(0);
  });
});
