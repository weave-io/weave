import { expect, test } from "bun:test";
import {
  MemoryPiChildHistoryFs,
  resolvePiChildHistoryRoot,
} from "../child-history-fs.js";
import { PI_CHILD_HISTORY_LAYOUT } from "../child-history-schema.js";
import { PiChildHistoryStore } from "../child-history-store.js";
import {
  DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
  resolvePiChildInspectionSettings,
} from "../child-inspection-settings.js";

const utf8 = (value: string) => new TextEncoder().encode(value);

test("missing adapter settings and history root retain ephemeral behavior", async () => {
  const resolved = resolvePiChildInspectionSettings({
    settings: { adapters: {} },
  } as Parameters<typeof resolvePiChildInspectionSettings>[0]);
  expect(resolved.isOk()).toBe(true);
  if (resolved.isOk() && resolved.value.status === "valid") {
    expect(resolved.value.settings).toEqual(
      DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    );
  }
  expect(
    resolvePiChildHistoryRoot({
      parentSessionId: "isolated",
      env: {},
      homeDir: "/tmp/task-13-home",
    }).isOk(),
  ).toBe(true);

  const opened = await PiChildHistoryStore.open(
    "ephemeral",
    { ...DEFAULT_PI_CHILD_INSPECTION_SETTINGS, persist_history: false },
    { fs: new MemoryPiChildHistoryFs(), now: () => 1 },
  );
  expect(opened.isOk()).toBe(true);
  if (opened.isOk()) {
    expect(opened.value.isPersistenceDisabled()).toBe(true);
    opened.value.close();
  }
});

test("v0 and missing indexes migrate without losing safe child behavior", async () => {
  const fs = new MemoryPiChildHistoryFs();
  const root = resolvePiChildHistoryRoot({
    parentSessionId: "legacy",
    env: {},
    homeDir: "/tmp/task-13-home",
  }).unwrapOr("");
  const childPath = `${root}/children/orphan`;
  const session = utf8('{"type":"text","text":"private"}\n');
  const directory = (await fs.openDirectory(childPath, true)).unwrapOr(
    undefined,
  );
  expect(directory).toBeDefined();
  if (!directory) return;
  expect(
    (
      await directory.writeFileAtomic(
        PI_CHILD_HISTORY_LAYOUT.sessionFile,
        session,
        PI_CHILD_HISTORY_LAYOUT.fileMode,
      )
    ).isOk(),
  ).toBe(true);
  directory.close();

  const opened = await PiChildHistoryStore.open(
    "legacy",
    DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    {
      fs,
      now: () => 100,
      env: {},
      home: "/tmp/task-13-home",
    },
  );
  expect(opened.isOk()).toBe(true);
  if (opened.isErr()) return;
  expect(opened.value.getIndex().records).toEqual([]);
  expect(fs.files(childPath).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(
    true,
  );
  const restored = await opened.value.upsertRecord({
    childId: "orphan",
    parentSessionId: "legacy",
    kind: "ordinary",
    status: "settled",
    workflow: {},
    sessionPath: "children/orphan/session.jsonl",
    checkpointCursor: 0,
    branchAncestry: [],
    interventionCount: 0,
    finalOutput: "safe migrated output",
    trim: { trimmed: false, markerCount: 0 },
    quarantine: { quarantined: false },
    clear: { cleared: false },
    recovery: { eligible: true, count: 0 },
    bytes: {
      session: session.byteLength,
      checkpoint: 0,
      total: session.byteLength,
    },
    createdAt: 1,
    updatedAt: 1,
  });
  expect(restored.isOk()).toBe(true);
  const retained = await opened.value.readSessionEvents("orphan");
  expect(retained.isOk()).toBe(true);
  if (retained.isOk()) {
    expect(retained.value).toHaveLength(1);
    expect(retained.value[0]).toEqual({
      type: "text",
      text: "private",
    });
  }
  expect(fs.files(childPath).get(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toEqual(
    session,
  );
  opened.value.close();
});

test("unsupported history is quarantined without returning its canary", async () => {
  const fs = new MemoryPiChildHistoryFs();
  const root = resolvePiChildHistoryRoot({
    parentSessionId: "quarantine",
    env: {},
    homeDir: "/tmp/task-13-home",
  }).unwrapOr("");
  const directory = (await fs.openDirectory(root, true)).unwrapOr(undefined);
  expect(directory).toBeDefined();
  if (!directory) return;
  const canary = "MIGRATION-PRIVATE-CANARY";
  await directory.writeFileAtomic(
    PI_CHILD_HISTORY_LAYOUT.indexFile,
    utf8(JSON.stringify({ schemaVersion: 99, canary })),
    PI_CHILD_HISTORY_LAYOUT.fileMode,
  );
  directory.close();
  const opened = await PiChildHistoryStore.open(
    "quarantine",
    DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    { fs, now: () => 10 },
  );
  expect(opened.isOk()).toBe(true);
  if (opened.isOk()) {
    expect(JSON.stringify(opened.value.getIndex())).not.toContain(canary);
    expect(opened.value.getIndex().records).toEqual([]);
    opened.value.close();
  }
});
