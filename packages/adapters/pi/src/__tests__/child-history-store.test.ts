import { describe, expect, test } from "bun:test";
import { DEFAULT_PI_CHILD_INSPECTION_SETTINGS } from "../child-inspection-settings.js";
import type { PiChildInspectionSettings } from "../child-inspection-settings.js";
import { MemoryPiChildHistoryFs, resolvePiChildHistoryRoot } from "../child-history-fs.js";
import type { PiChildHistoryDirectory } from "../child-history-fs.js";
import { PI_CHILD_HISTORY_LAYOUT } from "../child-history-schema.js";
import { PiChildHistoryStore } from "../child-history-store.js";
import type { PiChildHistoryRecord } from "../child-history-schema.js";
import type { PiChildSessionCheckpoint } from "../child-session-checkpoint.js";

const record = (
  childId: string,
  status: PiChildHistoryRecord["status"] = "settled",
  bytes = 0,
  overrides: Partial<PiChildHistoryRecord> = {},
): PiChildHistoryRecord => ({
  childId,
  parentSessionId: "parent",
  kind: "ordinary",
  status,
  workflow: {},
  sessionPath: `children/${childId}/session.jsonl`,
  checkpointCursor: 0,
  branchAncestry: [],
  interventionCount: 0,
  finalOutput: "bounded output",
  trim: { trimmed: false, markerCount: 0 },
  quarantine: { quarantined: false },
  clear: { cleared: false },
  recovery: { eligible: true, count: 0 },
  bytes: { session: bytes, checkpoint: 0, total: bytes },
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const quotaSettings = (
  maxBytesPerChild: number,
  maxBytesTotal: number,
  orphanRetentionDays: number = DEFAULT_PI_CHILD_INSPECTION_SETTINGS.orphan_retention_days,
): PiChildInspectionSettings => ({
  ...DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
  max_bytes_per_child: maxBytesPerChild,
  max_bytes_total: maxBytesTotal,
  orphan_retention_days: orphanRetentionDays,
});

async function openStore(
  fs = new MemoryPiChildHistoryFs(),
  now = 10,
  settings: PiChildInspectionSettings = DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
  options: { activeParentSessionId?: string; activeChildId?: string; inspectedChildId?: string } = {},
) {
  return PiChildHistoryStore.open("parent", settings, { fs, now: () => now, ...options });
}

class TrackingMemoryPiChildHistoryFs extends MemoryPiChildHistoryFs {
  activeChildHandles = 0;

  override openDirectory(path: string, create: boolean) {
    return super.openDirectory(path, create).map((directory) => {
      const isChild = path.includes("/children/");
      if (isChild) this.activeChildHandles += 1;
      let closed = false;
      const tracked: PiChildHistoryDirectory = {
        ...directory,
        close: () => {
          if (closed) return;
          closed = true;
          if (isChild) this.activeChildHandles -= 1;
          directory.close();
        },
      };
      return tracked;
    });
  }
}

class AtomicWriteTrackingMemoryPiChildHistoryFs extends MemoryPiChildHistoryFs {
  atomicWrites: string[] = [];

  override openDirectory(path: string, create: boolean) {
    return super.openDirectory(path, create).map((directory) => ({
      ...directory,
      writeFileAtomic: (name: string, bytes: Uint8Array, mode: number) => {
        this.atomicWrites.push(`${directory.path}/${name}`);
        return directory.writeFileAtomic(name, bytes, mode);
      },
    }));
  }
}

async function writeBytes(fs: MemoryPiChildHistoryFs, path: string, name: string, bytes: Uint8Array): Promise<void> {
  const opened = await fs.openDirectory(path, true);
  const directory = opened.unwrapOr(undefined);
  expect(directory).toBeDefined();
  if (!directory) return;
  const written = await directory.writeFileAtomic(name, bytes, PI_CHILD_HISTORY_LAYOUT.fileMode);
  expect(written.isOk()).toBe(true);
  directory.close();
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("Pi child history store", () => {
  test("appends checkpoints and restores the alternate branch", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const store = (await openStore(fs)).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    await store.upsertRecord(record("child"));
    await store.appendCheckpoint("child", [{ id: "root", kind: "message", payload: "x" }, { id: "a", parentId: "root", kind: "message", payload: "a" }], "a");
    await store.appendCheckpoint("child", [{ id: "b", parentId: "root", kind: "message", payload: "b" }], "b");
    const checkpointResult = await store.readCheckpointFor("child");
    expect(checkpointResult.isOk()).toBe(true);
    if (checkpointResult.isErr()) return;
    const checkpoint: PiChildSessionCheckpoint = checkpointResult.value;
    expect(checkpoint.activeLeaf).toBe("b");
    expect(checkpoint.entries.map((entry) => entry.id)).toEqual(["root", "a", "b"]);
    store.close();
  });

  test("opens an absent index as an empty V1 store without losing child history", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const rootPath = resolvePiChildHistoryRoot("parent").unwrapOr("");
    const childPath = `${rootPath}/children/orphan`;
    const session = utf8('{"type":"text","text":"preserve me"}\n');
    await writeBytes(fs, childPath, PI_CHILD_HISTORY_LAYOUT.sessionFile, session);

    const result = await openStore(fs, 10);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.getIndex()).toEqual({
      schemaVersion: 1,
      parentSessionId: "parent",
      records: [],
      updatedAt: 10,
    });
    expect(fs.files(childPath).get(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toEqual(session);
    expect(fs.files(rootPath).has(PI_CHILD_HISTORY_LAYOUT.indexFile)).toBe(false);
    result.value.close();
  });

  test("migrates V0 indexes deterministically and atomically to bounded V1 data", async () => {
    const legacy = {
      schemaVersion: 0,
      parentSessionId: "legacy-parent",
      secretPrompt: "must not be copied",
      records: [{
        childId: "nested-child",
        parentChildId: "root-child",
        kind: "nested",
        status: "interrupted",
        workflow: { workflow: "release", step: "deploy", secretPrompt: "hidden" },
        sessionPath: "legacy/path/session.jsonl",
        activeLeaf: "leaf-child",
        checkpointCursor: 3.8,
        branchAncestry: [
          { childId: "root-child", parentChildId: "ancestor", checkpoint: 4.9 },
          { childId: "branch-child", checkpoint: 8 },
        ],
        interventionCount: 2.7,
        finalOutput: "x".repeat(5_000),
        createdAt: 42,
        updatedAt: 999,
      }],
    };
    const legacyBytes = utf8(JSON.stringify(legacy));
    const firstFs = new AtomicWriteTrackingMemoryPiChildHistoryFs();
    const rootPath = resolvePiChildHistoryRoot("parent").unwrapOr("");
    await writeBytes(firstFs, rootPath, PI_CHILD_HISTORY_LAYOUT.indexFile, legacyBytes);
    firstFs.atomicWrites = [];

    const first = await openStore(firstFs, 10);
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;
    const migrated = first.value.getIndex();
    expect(migrated).toEqual({
      schemaVersion: 1,
      parentSessionId: "parent",
      records: [{
        childId: "nested-child",
        parentSessionId: "parent",
        parentChildId: "root-child",
        kind: "nested",
        status: "interrupted",
        workflow: { workflow: "release", step: "deploy" },
        sessionPath: "children/nested-child/session.jsonl",
        activeLeaf: "leaf-child",
        checkpointCursor: 3,
        branchAncestry: [
          { childId: "root-child", parentChildId: "ancestor", checkpoint: 4 },
          { childId: "branch-child", checkpoint: 8 },
        ],
        interventionCount: 2,
        finalOutput: "x".repeat(4_096),
        trim: { trimmed: false, markerCount: 0 },
        quarantine: { quarantined: false },
        clear: { cleared: false },
        recovery: { eligible: true, count: 0 },
        bytes: { session: 0, checkpoint: 0, total: 0 },
        createdAt: 42,
        updatedAt: 10,
      }],
      updatedAt: 10,
    });
    const firstIndexBytes = firstFs.files(rootPath).get(PI_CHILD_HISTORY_LAYOUT.indexFile);
    expect(firstIndexBytes).toBeDefined();
    expect(firstFs.files(rootPath).has("index.v1.json.tmp")).toBe(false);
    expect(firstFs.atomicWrites).toEqual([
      `${rootPath}/index.v1.json.tmp`,
      `${rootPath}/index.v1.json`,
    ]);
    if (firstIndexBytes) {
      expect(new TextDecoder().decode(firstIndexBytes)).not.toContain("secretPrompt");
      expect(JSON.parse(new TextDecoder().decode(firstIndexBytes)).schemaVersion).toBe(1);
    }

    const invalidFs = new MemoryPiChildHistoryFs();
    await writeBytes(invalidFs, rootPath, PI_CHILD_HISTORY_LAYOUT.indexFile, utf8(JSON.stringify({
      schemaVersion: 0,
      records: [{ childId: 42, secretPrompt: "must not enter the error" }],
    })));
    const invalid = await openStore(invalidFs, 10);
    expect(invalid.isErr()).toBe(true);
    if (invalid.isErr()) expect(JSON.stringify(invalid.error)).not.toContain("must not enter the error");

    const secondFs = new MemoryPiChildHistoryFs();
    await writeBytes(secondFs, rootPath, PI_CHILD_HISTORY_LAYOUT.indexFile, legacyBytes);
    const second = await openStore(secondFs, 10);
    expect(second.isOk()).toBe(true);
    if (second.isOk()) {
      expect(second.value.getIndex()).toEqual(migrated);
      expect(secondFs.files(rootPath).get(PI_CHILD_HISTORY_LAYOUT.indexFile)).toEqual(firstIndexBytes);
      second.value.close();
    }
    first.value.close();
  });

  test("quarantines malformed index without returning its bytes", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const rootPath = resolvePiChildHistoryRoot("parent").unwrapOr("");
    const root = (await fs.openDirectory(rootPath, true)).unwrapOr(undefined);
    expect(root).toBeDefined();
    if (!root) return;
    await root.writeFileAtomic("index.v1.json", new TextEncoder().encode("{\"secretPrompt\":"), 0o600);
    root.close();
    const result = await PiChildHistoryStore.open("parent", DEFAULT_PI_CHILD_INSPECTION_SETTINGS, { fs });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(JSON.stringify(result.error)).not.toContain("secretPrompt");
  });

  test("closes child handles on successful and failing operations", async () => {
    const fs = new TrackingMemoryPiChildHistoryFs();
    const store = (await openStore(fs)).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    await store.upsertRecord(record("child"));
    await store.appendCheckpoint("child", [{ id: "root", kind: "message", payload: "x" }], "root");
    expect(fs.activeChildHandles).toBe(0);
    await store.appendSessionEvent("child", { type: "text", text: "hello" });
    expect(fs.activeChildHandles).toBe(0);
    await store.readSessionEvents("child");
    await store.readCheckpointFor("child");
    expect(fs.activeChildHandles).toBe(0);
    await writeBytes(fs, `${store.getRootPath()}/children/child`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8('{"broken":'));
    const failed = await store.appendSessionEvent("child", { type: "text", text: "must-not-append" });
    expect(failed.isErr()).toBe(true);
    expect(fs.activeChildHandles).toBe(0);
    await store.clear("child");
    expect(fs.activeChildHandles).toBe(0);
    store.close();
  });

  test("quarantines malformed and unsupported session JSONL before appending", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const store = (await openStore(fs)).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    await store.upsertRecord(record("child"));
    await store.appendSessionEvent("child", { type: "text", text: "valid" });
    await writeBytes(fs, `${store.getRootPath()}/children/child`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8('{"secretPrompt":'));
    const result = await store.appendSessionEvent("child", { type: "text", text: "must-not-append" });
    expect(result.isErr()).toBe(true);
    expect([...fs.files(`${store.getRootPath()}/children/child`).keys()].some((name) => name.includes("session.jsonl.quarantine-"))).toBe(true);
    if (result.isErr()) expect(JSON.stringify(result.error)).not.toContain("secretPrompt");
    await writeBytes(fs, `${store.getRootPath()}/children/child`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8('{"type":"text","text":42,"secretPrompt":"hidden"}'));
    const unsupported = await store.appendSessionEvent("child", { type: "text", text: "must-not-append" });
    expect(unsupported.isErr()).toBe(true);
    if (unsupported.isErr()) expect(JSON.stringify(unsupported.error)).not.toContain("hidden");
    store.close();
  });

  test("quarantines corrupt and unsupported checkpoint data", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const store = (await openStore(fs)).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    await store.upsertRecord(record("child"));
    await store.appendCheckpoint("child", [{ id: "root", kind: "message", payload: "x" }], "root");
    const childPath = `${store.getRootPath()}/children/child`;
    await writeBytes(fs, childPath, PI_CHILD_HISTORY_LAYOUT.checkpointFile, utf8('{"secretPrompt":'));
    const corrupt = await store.readCheckpointFor("child");
    expect(corrupt.isErr()).toBe(true);
    if (corrupt.isErr()) expect(JSON.stringify(corrupt.error)).not.toContain("secretPrompt");
    await writeBytes(fs, childPath, PI_CHILD_HISTORY_LAYOUT.checkpointFile, utf8('{"schemaVersion":99,"secretPrompt":"hidden"}'));
    const unsupported = await store.readCheckpointFor("child");
    expect(unsupported.isErr()).toBe(true);
    if (unsupported.isErr()) expect(JSON.stringify(unsupported.error)).not.toContain("hidden");
    store.close();
  });

  test("quarantines an unsupported index without exposing its bytes", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const rootPath = resolvePiChildHistoryRoot("parent").unwrapOr("");
    await writeBytes(fs, rootPath, PI_CHILD_HISTORY_LAYOUT.indexFile, utf8('{"schemaVersion":99,"secretPrompt":"hidden"}'));
    const result = await openStore(fs);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(JSON.stringify(result.error)).not.toContain("hidden");
    expect([...fs.files(rootPath).keys()].some((name) => name.includes("index.v1.json.quarantine-") || name.includes("index.v1.json.tmp.quarantine-"))).toBe(true);
  });

  test("recovers from torn index and temp writes deterministically", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const initial = (await openStore(fs)).unwrapOr(undefined);
    expect(initial).toBeDefined();
    if (!initial) return;
    await initial.upsertRecord(record("child"));
    const rootPath = initial.getRootPath();
    const valid = fs.files(rootPath).get(PI_CHILD_HISTORY_LAYOUT.indexFile);
    expect(valid).toBeDefined();
    if (!valid) return;
    initial.close();

    await writeBytes(fs, rootPath, PI_CHILD_HISTORY_LAYOUT.indexFile, utf8('{"schemaVersion":99,"secretPrompt":"torn-index"}'));
    await writeBytes(fs, rootPath, "index.v1.json.tmp", valid);
    const fromTemp = await openStore(fs);
    expect(fromTemp.isOk()).toBe(true);
    if (fromTemp.isOk()) {
      expect(fromTemp.value.getIndex().records.map((item) => item.childId)).toEqual(["child"]);
      fromTemp.value.close();
    }
    expect(fs.files(rootPath).has("index.v1.json.tmp")).toBe(false);

    await writeBytes(fs, rootPath, "index.v1.json.tmp", utf8('{"schemaVersion":'));
    const fromIndex = await openStore(fs);
    expect(fromIndex.isOk()).toBe(true);
    if (fromIndex.isOk()) fromIndex.value.close();
    expect(fs.files(rootPath).has("index.v1.json.tmp")).toBe(false);
  });

  test("enforces the per-child ceiling from persisted bytes and records a trim marker", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const store = (await openStore(fs, 10, quotaSettings(10, 100))).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    await store.upsertRecord(record("oversized", "settled", 0));
    await writeBytes(fs, `${store.getRootPath()}/children/oversized`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("12345678901"));

    const result = await store.enforceQuotas();
    expect(result.isOk()).toBe(true);
    expect(fs.files(`${store.getRootPath()}/children/oversized`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(false);
    const saved = store.getIndex().records[0];
    expect(saved?.bytes.total).toBe(0);
    expect(saved?.trim).toMatchObject({ trimmed: true, markerCount: 1 });
    store.close();
  });

  test("trims oldest complete history using actual total bytes, not stale counters", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const store = (await openStore(fs, 10, quotaSettings(100, 10))).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    await store.upsertRecord(record("old", "settled", 0, { createdAt: 1, updatedAt: 1 }));
    await store.upsertRecord(record("new", "settled", 0, { createdAt: 2, updatedAt: 2 }));
    await writeBytes(fs, `${store.getRootPath()}/children/old`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("123456"));
    await writeBytes(fs, `${store.getRootPath()}/children/new`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("abcdef"));

    const result = await store.enforceQuotas();
    expect(result.isOk()).toBe(true);
    expect(fs.files(`${store.getRootPath()}/children/old`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(false);
    expect(fs.files(`${store.getRootPath()}/children/new`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(true);
    expect(store.getIndex().records.find((item) => item.childId === "old")?.trim.trimmed).toBe(true);
    expect(store.getIndex().records.reduce((sum, item) => sum + item.bytes.total, 0)).toBe(6);
    store.close();
  });

  test("preserves active and inspected views, and fails closed when protected state exceeds total quota", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const store = (await openStore(fs, 10, quotaSettings(100, 10), { activeChildId: "active", inspectedChildId: "inspected" })).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    await store.upsertRecord(record("parent-branch", "settled", 0));
    await store.upsertRecord(record("active", "settled", 0, { parentChildId: "parent-branch" }));
    await store.upsertRecord(record("inspected"));
    await writeBytes(fs, `${store.getRootPath()}/children/parent-branch`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("parent!"));
    await writeBytes(fs, `${store.getRootPath()}/children/active`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("active!"));
    await writeBytes(fs, `${store.getRootPath()}/children/inspected`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("inspect"));

    const result = await store.enforceQuotas();
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toEqual({ type: "quota-exceeded", scope: "total" });
    expect(fs.files(`${store.getRootPath()}/children/parent-branch`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(true);
    expect(fs.files(`${store.getRootPath()}/children/active`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(true);
    expect(fs.files(`${store.getRootPath()}/children/inspected`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(true);
    store.close();
  });

  test("trims unprotected history without breaking the active branch", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const store = (await openStore(fs, 10, quotaSettings(100, 12), { activeChildId: "active" })).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    await store.upsertRecord(record("parent-branch", "settled", 0, { createdAt: 2, updatedAt: 2 }));
    await store.upsertRecord(record("active", "settled", 0, { parentChildId: "parent-branch", createdAt: 3, updatedAt: 3 }));
    await store.upsertRecord(record("old", "settled", 0, { createdAt: 1, updatedAt: 1 }));
    await writeBytes(fs, `${store.getRootPath()}/children/parent-branch`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("parent"));
    await writeBytes(fs, `${store.getRootPath()}/children/active`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("active"));
    await writeBytes(fs, `${store.getRootPath()}/children/old`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("old!!!"));

    const result = await store.enforceQuotas();
    expect(result.isOk()).toBe(true);
    expect(fs.files(`${store.getRootPath()}/children/old`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(false);
    expect(fs.files(`${store.getRootPath()}/children/parent-branch`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(true);
    expect(fs.files(`${store.getRootPath()}/children/active`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(true);
    store.close();
  });

  test("physically clears terminal history but refuses running and queued children", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const store = (await openStore(fs)).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    await store.upsertRecord(record("done"));
    await writeBytes(fs, `${store.getRootPath()}/children/done`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("session"));
    await writeBytes(fs, `${store.getRootPath()}/children/done`, PI_CHILD_HISTORY_LAYOUT.checkpointFile, utf8("checkpoint"));
    const cleared = await store.clear("done");
    expect(cleared.isOk()).toBe(true);
    expect(store.getIndex().records.some((item) => item.childId === "done")).toBe(false);
    expect(fs.files(`${store.getRootPath()}/children/done`).size).toBe(0);

    for (const status of ["running", "queued"] as const) {
      await store.upsertRecord(record(status, status));
      const result = await store.clear(status);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error).toEqual({ type: "clear-refused", status });
    }
    store.close();
  });

  test("prunes only strictly older orphaned terminal records", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const now = 172_800_000;
    const cutoff = now - 86_400_000;
    const initial = (await openStore(fs, now, quotaSettings(100, 100, 1))).unwrapOr(undefined);
    expect(initial).toBeDefined();
    if (!initial) return;
    const rootPath = initial.getRootPath();
    initial.close();

    const entries = [
      record("boundary", "settled", 0, { parentSessionId: "orphan-parent", updatedAt: cutoff }),
      record("old", "settled", 0, { parentSessionId: "orphan-parent", updatedAt: cutoff - 1 }),
      record("active-parent", "settled", 0, { parentSessionId: "active-parent", updatedAt: cutoff - 1 }),
      record("running-old", "running", 0, { parentSessionId: "orphan-parent", updatedAt: cutoff - 1 }),
    ];
    const index = { schemaVersion: 1 as const, parentSessionId: "parent", records: entries, updatedAt: now };
    await writeBytes(fs, rootPath, PI_CHILD_HISTORY_LAYOUT.indexFile, utf8(JSON.stringify(index)));
    for (const entry of entries) {
      await writeBytes(fs, `${rootPath}/children/${entry.childId}`, PI_CHILD_HISTORY_LAYOUT.sessionFile, utf8("history"));
    }

    const store = (await openStore(fs, now, quotaSettings(100, 100, 1), { activeParentSessionId: "active-parent" })).unwrapOr(undefined);
    expect(store).toBeDefined();
    if (!store) return;
    const result = await store.pruneOrphans(now);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe(1);
    expect(store.getIndex().records.map((item) => item.childId).sort()).toEqual(["active-parent", "boundary", "running-old"]);
    expect(fs.files(`${rootPath}/children/old`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(false);
    expect(fs.files(`${rootPath}/children/boundary`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(true);
    expect(fs.files(`${rootPath}/children/active-parent`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(true);
    expect(fs.files(`${rootPath}/children/running-old`).has(PI_CHILD_HISTORY_LAYOUT.sessionFile)).toBe(true);
    store.close();
  });
});
