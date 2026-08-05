import { describe, expect, it } from "bun:test";
import { MemoryPiChildHistoryFs } from "../child-history-fs.js";
import type { PiChildHistoryRecord } from "../child-history-schema.js";
import { PiChildHistoryStore } from "../child-history-store.js";
import { DEFAULT_PI_CHILD_INSPECTION_SETTINGS } from "../child-inspection-settings.js";
import {
  buildChildPickerEntries,
  sanitizeChildPickerPreview,
} from "../child-picker.js";
import {
  classifyWeaveCommand,
  WEAVE_CLEAR_CHILDREN_COMMAND_NAME,
  WEAVE_COMMAND_NAMES,
  WEAVE_INSPECT_COMMAND_NAME,
  WEAVE_RECOVERY_COMMAND_NAME,
} from "../commands.js";

const record = (
  childId: string,
  status: PiChildHistoryRecord["status"],
): PiChildHistoryRecord => ({
  childId,
  parentSessionId: "parent",
  kind: "ordinary",
  status,
  workflow: {},
  descriptorName: "loom",
  sessionPath: `children/${childId}/session.jsonl`,
  activeLeaf: "leaf",
  checkpointCursor: 0,
  branchAncestry: [],
  interventionCount: 0,
  finalOutput: "output",
  trim: { trimmed: false, markerCount: 0 },
  quarantine: { quarantined: false },
  clear: { cleared: false },
  recovery: { eligible: status === "interrupted", count: 0 },
  bytes: { session: 0, checkpoint: 0, total: 0 },
  createdAt: 1,
  updatedAt: 1,
});

async function openStore(
  fs = new MemoryPiChildHistoryFs(),
): Promise<PiChildHistoryStore> {
  const result = await PiChildHistoryStore.open(
    "parent",
    DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    { fs, now: () => 2 },
  );
  expect(result.isOk()).toBe(true);
  if (result.isErr()) throw new Error("store failed to open");
  return result.value;
}

describe("Pi command, history, and picker integration proof", () => {
  it("has one exact command tuple with classifications", async () => {
    await Promise.resolve();
    expect(WEAVE_INSPECT_COMMAND_NAME).toBe("weave:inspect");
    expect(WEAVE_CLEAR_CHILDREN_COMMAND_NAME).toBe("weave:clear-children");
    expect(WEAVE_RECOVERY_COMMAND_NAME).toBe("weave:recover-children");
    expect(WEAVE_COMMAND_NAMES).toEqual([
      "weave:start",
      "weave:run",
      "weave:status",
      "weave:abort",
      "weave:advance",
      "weave:health",
      "weave:resume",
      "weave:plan",
      "weave:artifact",
      "weave:inspect",
      "weave:history",
      "weave:doctor",
      "weave:clear-children",
      "weave:recover-children",
    ]);
    expect(new Set(WEAVE_COMMAND_NAMES).size).toBe(14);
    expect(classifyWeaveCommand("weave:inspect")).toBe("read-only");
    expect(classifyWeaveCommand("weave:history")).toBe("read-only");
    expect(classifyWeaveCommand("weave:doctor")).toBe("read-only");
    expect(classifyWeaveCommand("weave:clear-children")).toBe(
      "idempotent-cleanup",
    );
    expect(classifyWeaveCommand("weave:recover-children")).toBe("mutating");
  });

  it("clears terminal bytes and index references while preserving live records", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const store = await openStore(fs);
    for (const item of [
      record("done", "settled"),
      record("stopped", "interrupted"),
      record("live", "running"),
      record("waiting", "queued"),
    ]) {
      const result = await store.upsertRecord(item);
      expect(result.isOk()).toBe(true);
    }
    const cleared = await store.clearTerminal();
    expect(cleared._unsafeUnwrap()).toBe(2);
    expect(store.getIndex().records.map((item) => item.childId)).toEqual([
      "live",
      "waiting",
    ]);
    expect(fs.files(`${store.getRootPath()}/children/done`).size).toBe(0);
    expect(fs.files(`${store.getRootPath()}/children/stopped`).size).toBe(0);
  });

  it("keeps clear errors bounded for missing and live children", async () => {
    const store = await openStore();
    const missing = await store.clear("missing");
    expect(missing.isErr() && missing.error.type).toBe("clear-refused");
    await store.upsertRecord(record("live", "running"));
    const running = await store.clear("live");
    expect(running.isErr() && running.error.type).toBe("clear-refused");
  });

  it("builds inspect options from trusted live and history breadcrumbs only", async () => {
    await Promise.resolve();
    const result = buildChildPickerEntries({
      live: [
        {
          childId: "live",
          name: "nested",
          kind: "nested",
          parentId: "root",
          status: "running",
          live: true,
          workflowInstanceId: "wf",
          stepName: "step",
        },
      ],
      history: [
        {
          childId: "old",
          name: "old",
          kind: "workflow-step",
          status: "settled",
          live: false,
          workflowInstanceId: "wf",
          stepName: "done",
        },
      ],
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((entry) => entry.label).join(" ")).toContain(
        "wf / step",
      );
      expect(result.value.map((entry) => entry.id)).not.toContain("session");
      expect(result.value.map((entry) => entry.id)).not.toContain("checkpoint");
      expect(result.value.map((entry) => entry.id)).not.toContain("task");
    }
  });

  it("exposes recover, resume, and clear actions for selected children", async () => {
    await Promise.resolve();
    const result = buildChildPickerEntries({
      live: [
        {
          childId: "child",
          name: "child",
          kind: "ordinary",
          status: "running",
          live: true,
          resumable: true,
        },
      ],
      history: [
        {
          childId: "old",
          name: "old",
          kind: "ordinary",
          status: "interrupted",
          live: false,
          recoverable: true,
        },
      ],
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((entry) => entry.action)).toEqual([
        undefined,
        undefined,
        "resume",
        undefined,
        "recover",
        "clear",
      ]);
      expect(
        result.value.find((entry) => entry.action === "recover")?.node?.childId,
      ).toBe("old");
    }
  });

  it("sanitizes picker previews without leaking control bytes", async () => {
    await Promise.resolve();
    expect(sanitizeChildPickerPreview("\u001b[31msecret\u001b[0m\nnext")).toBe(
      "secret next",
    );
  });

  it("rejects duplicate live/history IDs before picker mutation", async () => {
    await Promise.resolve();
    const result = buildChildPickerEntries({
      live: [
        {
          childId: "same",
          name: "a",
          kind: "ordinary",
          status: "running",
          live: true,
        },
      ],
      history: [
        {
          childId: "same",
          name: "b",
          kind: "ordinary",
          status: "settled",
          live: false,
        },
      ],
    });
    expect(result.isErr()).toBe(true);
  });

  it("preserves live records when terminal cleanup is repeated", async () => {
    const store = await openStore();
    await store.upsertRecord(record("live", "running"));
    expect((await store.clearTerminal())._unsafeUnwrap()).toBe(0);
    expect((await store.clearTerminal())._unsafeUnwrap()).toBe(0);
    expect(store.getIndex().records[0]?.childId).toBe("live");
  });
});
