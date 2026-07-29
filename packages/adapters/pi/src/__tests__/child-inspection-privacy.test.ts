import { expect, test } from "bun:test";
import { MemoryPiChildHistoryFs } from "../child-history-fs.js";
import type { PiChildHistoryRecord } from "../child-history-schema.js";
import { PiChildHistoryStore } from "../child-history-store.js";
import {
  MAX_LATEST_OUTPUT_BYTES,
  truncateLatestOutput,
} from "../child-tree.js";

const PRIVATE = "RAW-PRIVATE-INTERVENTION-CANARY";
const base: PiChildHistoryRecord = {
  childId: "child",
  parentSessionId: "parent",
  kind: "ordinary",
  status: "settled",
  workflow: {},
  sessionPath: "children/child/session.jsonl",
  checkpointCursor: 0,
  branchAncestry: [],
  interventionCount: 1,
  finalOutput: "safe final output",
  trim: { trimmed: false, markerCount: 0 },
  quarantine: { quarantined: false },
  clear: { cleared: false },
  recovery: { eligible: true, count: 0 },
  bytes: { session: 0, checkpoint: 0, total: 0 },
  createdAt: 1,
  updatedAt: 1,
};

test("private canaries stay out of every parent-facing history projection", async () => {
  const fs = new MemoryPiChildHistoryFs();
  const opened = await PiChildHistoryStore.open(
    "parent",
    {
      persist_history: true,
      max_bytes_per_child: 4 * 1024 * 1024,
      max_bytes_total: 64 * 1024 * 1024,
      orphan_retention_days: 30,
    },
    { fs, now: () => 10 },
  );
  expect(opened.isOk()).toBe(true);
  if (opened.isErr()) return;
  const store = opened.value;
  expect((await store.upsertRecord(base)).isOk()).toBe(true);
  expect(
    (
      await store.appendSessionEvent("child", {
        type: "follow-up",
        text: PRIVATE,
        at: 2,
      })
    ).isOk(),
  ).toBe(true);
  expect(
    (
      await store.appendCheckpoint(
        "child",
        [{ id: "root", kind: "message", payload: PRIVATE }],
        "root",
      )
    ).isOk(),
  ).toBe(true);

  const forbiddenSinks = [
    JSON.stringify(store.getIndex()),
    JSON.stringify(store.getIndex().records[0]),
    JSON.stringify({
      usage: { input: 3, output: 4 },
      health: "ok",
      failures: [],
      recovery: { childId: "child" },
    }),
    JSON.stringify({
      telemetry: { event: "child.settled", childId: "child" },
      diagnostics: [],
      acceptance: true,
    }),
  ];
  expect(forbiddenSinks.every((sink) => !sink.includes(PRIVATE))).toBe(true);
  expect(truncateLatestOutput(PRIVATE.repeat(100)).length).toBeLessThanOrEqual(
    MAX_LATEST_OUTPUT_BYTES,
  );
  const events = await store.readSessionEvents("child");
  expect(events.isOk()).toBe(true);
  if (events.isOk()) expect(JSON.stringify(events.value)).toContain(PRIVATE);
  store.close();
});

test("parent result is the store's terminal projection plus numeric metadata", async () => {
  const fs = new MemoryPiChildHistoryFs();
  const opened = await PiChildHistoryStore.open(
    "projection-parent",
    {
      persist_history: true,
      max_bytes_per_child: 4 * 1024 * 1024,
      max_bytes_total: 64 * 1024 * 1024,
      orphan_retention_days: 30,
    },
    { fs, now: () => 10 },
  );
  expect(opened.isOk()).toBe(true);
  if (opened.isErr()) return;
  expect((await opened.value.upsertRecord(base)).isOk()).toBe(true);
  const projection = opened.value.getIndex().records[0];
  expect(projection).toBeDefined();
  if (projection === undefined) return;
  expect(projection.finalOutput).toBe("safe final output");
  expect(projection.interventionCount).toBe(1);
  expect(
    Object.values(projection).every(
      (value) => typeof value !== "string" || value !== PRIVATE,
    ),
  ).toBe(true);
  expect(JSON.stringify(projection)).not.toContain(PRIVATE);
  opened.value.close();
});
