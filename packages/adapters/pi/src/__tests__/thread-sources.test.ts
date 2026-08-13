import { describe, expect, test } from "bun:test";
import { ok, type Result } from "neverthrow";
import {
  FakePiChildMetadataCacheFs,
  openBunChildMetadataDatabase,
} from "../child-metadata-cache.js";
import type {
  PiNativeSessionFsPort,
  PiNativeSessionHandle,
  PiNativeSessionHeader,
  PiNativeSessionHostPort,
  PiNativeSessionStorageUnavailable,
} from "../child-native-sessions.js";
import type {
  PiChildRefAppendPort,
  PiChildRefEntryReadPort,
} from "../child-session-refs.js";
import { createPiChildSessionStorageAuthority } from "../child-session-storage-authority.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import { openPiThreadSources } from "../thread-sources.js";
import { TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const CACHE_ROOT = "/data/weave/adapters/pi/cache";
const PARENT = "parent-session-1";
const WORKSPACE = "/repo";

class FakeParentEntries
  implements PiChildRefAppendPort, PiChildRefEntryReadPort
{
  readonly appended: { customType: string; data: unknown }[] = [];

  appendEntry(customType: string, data: unknown): void {
    this.appended.push({ customType, data });
  }

  getEntries(): readonly unknown[] {
    return this.appended.map((entry) => ({
      type: "custom",
      customType: entry.customType,
      data: entry.data,
    }));
  }
}

function handleFor(
  file: string | undefined,
  dir: string,
  header: PiNativeSessionHeader | null,
  persisted: boolean,
): PiNativeSessionHandle {
  return {
    getSessionId: () => header?.id ?? "",
    getSessionFile: () => file,
    getSessionDir: () => dir,
    getHeader: () => header,
    getEntries: () => [],
    isPersisted: () => persisted,
    getLeafId: () => "leaf-1",
    appendCustomEntry: () => "entry-1",
  };
}

/** Task 4 memory host — never touches a real harness or filesystem. */
class MemoryHost implements PiNativeSessionHostPort {
  requireDescriptorSafeSessionIo(): Result<
    void,
    PiNativeSessionStorageUnavailable
  > {
    // Test-only memory host: every byte goes through the injected in-memory
    // no-follow filesystem, so descriptor-safe storage is provable here.
    return ok(undefined);
  }

  create(
    cwd: string,
    sessionDir: string,
    options: { parentSession?: string; id?: string },
  ): PiNativeSessionHandle {
    return handleFor(
      `${sessionDir}/session.jsonl`,
      sessionDir,
      {
        type: "session",
        id: options.id ?? "native-session-1",
        cwd,
        version: 3,
        timestamp: "2026-01-01T00:00:00.000Z",
        parentSession: options.parentSession,
      },
      true,
    );
  }

  open(path: string, sessionDir: string): PiNativeSessionHandle {
    return handleFor(
      path,
      sessionDir,
      {
        type: "session",
        id: "native-session-1",
        cwd: WORKSPACE,
        version: 3,
        timestamp: "2026-01-01T00:00:00.000Z",
        parentSession: PARENT,
      },
      true,
    );
  }
}

function memoryFs(): PiNativeSessionFsPort {
  return new MemoryPiNativeSessionFs();
}

describe("openPiThreadSources", () => {
  test("builds native store, parent ref store, and active cache from memory seams", async () => {
    const parent = new FakeParentEntries();
    const historyFs = new MemoryPiNativeSessionFs();
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      append: parent,
      read: parent,
      storageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      sessionRoot: ROOT,
      fs: historyFs,
      host: new MemoryHost(),
      cacheRoot: CACHE_ROOT,
      cacheFs: new FakePiChildMetadataCacheFs(),
      openDatabase: () => openBunChildMetadataDatabase(":memory:"),
      now: () => 1_700_000_000_000,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("expected ok");
    expect(result.value.cacheMode).toBe("active");
    expect(result.value.refs.liveParentSessionId()).toBe(PARENT);

    const created = await result.value.sessions.createChildSession({
      childId: "child-1",
      parentSession: PARENT,
      cwd: WORKSPACE,
    });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) throw new Error("expected create ok");
    expect(created.value.parentSession).toBe(PARENT);
    expect(created.value.ref).toBe("child-1/session.jsonl");
    expect(historyFs.files(`${ROOT}/child-1`).has("session.jsonl")).toBe(true);
  });

  test("degraded cache stays non-blocking and still returns refs + sessions", async () => {
    const parent = new FakeParentEntries();
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      append: parent,
      read: parent,
      storageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      sessionRoot: ROOT,
      fs: memoryFs(),
      host: new MemoryHost(),
      cacheRoot: CACHE_ROOT,
      cacheFs: new FakePiChildMetadataCacheFs({ type: "io" }),
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("expected ok");
    expect(result.value.cacheMode).toBe("degraded");
    expect(result.value.refs.liveParentSessionId()).toBe(PARENT);
    const upsert = result.value.cache.upsertRef(
      {
        childId: "child-1",
        threadId: "child-1",
        nativeSessionId: "native-1",
        sessionRef: "child-1/session.jsonl",
        originParentSessionId: PARENT,
        originEntryId: "entry-1",
        title: "t",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        runs: [],
      },
      WORKSPACE,
    );
    expect(upsert.isOk()).toBe(true);
  });

  test("fails closed on empty parent session id", async () => {
    const parent = new FakeParentEntries();
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: "",
      append: parent,
      read: parent,
      storageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      sessionRoot: ROOT,
      fs: memoryFs(),
      host: new MemoryHost(),
      cacheRoot: CACHE_ROOT,
      cacheFs: new FakePiChildMetadataCacheFs(),
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "ParentSessionUnavailable",
      reason: "empty-parent-session-id",
    });
  });

  test("fails closed when the authority proved no session root", async () => {
    const parent = new FakeParentEntries();
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      append: parent,
      read: parent,
      // An authority that proved nothing cannot hand sources a root, so no
      // store is built over an asserted path.
      storageAuthority: createPiChildSessionStorageAuthority(),
      env: { XDG_DATA_HOME: "relative-xdg", HOME: "" },
      host: new MemoryHost(),
      cacheRoot: CACHE_ROOT,
      cacheFs: new FakePiChildMetadataCacheFs(),
    });
    expect(result._unsafeUnwrapErr().type).toBe("SessionRootUnavailable");
  });

  test("fails closed when SessionManager static constructors are missing", async () => {
    const parent = new FakeParentEntries();
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      append: parent,
      read: parent,
      storageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      sessionRoot: ROOT,
      fs: memoryFs(),
      cacheRoot: CACHE_ROOT,
      cacheFs: new FakePiChildMetadataCacheFs(),
      SessionManager: { create: 1, open: 2 } as never,
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "NativeHostUnavailable",
      reason: "session-manager-missing",
    });
  });

  test("wires parent appendEntry through the ref store and refuses missing sources", async () => {
    const parent = new FakeParentEntries();
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      append: parent,
      read: parent,
      storageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      sessionRoot: ROOT,
      fs: memoryFs(),
      host: new MemoryHost(),
      cacheRoot: CACHE_ROOT,
      cacheFs: new FakePiChildMetadataCacheFs(),
      openDatabase: () => openBunChildMetadataDatabase(":memory:"),
      now: () => 1_000,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("expected ok");

    // Authority marks the session missing; appendNewChild fails closed with
    // zero parent writes when the native source is unavailable.
    const appended = await result.value.refs.appendNewChild({
      childId: "child-1",
      nativeSessionId: "native-1",
      sessionRef: "child-1/session.jsonl",
      title: "task",
    });
    expect(appended.isErr()).toBe(true);
    expect(parent.appended).toHaveLength(0);
  });

  test("readOnly open on an absent cache never creates dirs/files or opens a database", async () => {
    const parent = new FakeParentEntries();
    const cacheFs = new FakePiChildMetadataCacheFs(undefined, [], "absent");
    let openDatabaseCalls = 0;
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      append: parent,
      read: parent,
      storageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      sessionRoot: ROOT,
      fs: memoryFs(),
      host: new MemoryHost(),
      cacheRoot: CACHE_ROOT,
      cacheFs,
      readOnly: true,
      openDatabase: () => {
        openDatabaseCalls += 1;
        return openBunChildMetadataDatabase(":memory:");
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("expected ok");
    expect(result.value.cacheMode).toBe("degraded");
    expect(openDatabaseCalls).toBe(0);
    expect(cacheFs.calls.some((call) => call.startsWith("dir:"))).toBe(false);
    expect(cacheFs.calls.some((call) => call.startsWith("file:"))).toBe(false);
    expect(cacheFs.calls.some((call) => call.startsWith("probe:"))).toBe(true);
    const upsert = result.value.cache.upsertRef(
      {
        childId: "child-1",
        threadId: "child-1",
        nativeSessionId: "native-1",
        sessionRef: "child-1/session.jsonl",
        originParentSessionId: PARENT,
        originEntryId: "entry-1",
        title: "t",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        runs: [],
      },
      WORKSPACE,
    );
    // Degraded NOOP cache never throws; mutation-capable open is what creates.
    expect(upsert.isOk()).toBe(true);
  });
});
