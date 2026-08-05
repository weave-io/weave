import { describe, expect, test } from "bun:test";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import {
  FakePiChildMetadataCacheFs,
  openBunChildMetadataDatabase,
} from "../child-metadata-cache.js";
import type {
  PiNativeSessionFsPort,
  PiNativeSessionHandle,
  PiNativeSessionHeader,
  PiNativeSessionHostPort,
} from "../child-native-sessions.js";
import type {
  PiChildRefAppendPort,
  PiChildRefEntryReadPort,
} from "../child-session-refs.js";
import { openPiThreadSources } from "../thread-sources.js";

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
  create(
    cwd: string,
    sessionDir: string,
    options: { parentSession?: string; id?: string },
  ): PiNativeSessionHandle {
    return handleFor(
      `${sessionDir}/session.jsonl`,
      sessionDir,
      {
        id: options.id ?? "native-session-1",
        cwd,
        version: 3,
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
        id: "native-session-1",
        cwd: WORKSPACE,
        version: 3,
        parentSession: PARENT,
      },
      true,
    );
  }
}

function memoryFs(): PiNativeSessionFsPort {
  return new MemoryPiNativeSessionFs();
}

async function seedSessionFile(
  fs: MemoryPiNativeSessionFs,
  directoryPath: string,
): Promise<void> {
  const directory = (
    await fs.openDirectory(directoryPath, true)
  )._unsafeUnwrap();
  (
    await directory.appendFile(
      "session.jsonl",
      new TextEncoder().encode('{"type":"session"}\n'),
      0o600,
    )
  )._unsafeUnwrap();
  directory.close();
}

describe("openPiThreadSources", () => {
  test("builds native store, parent ref store, and active cache from memory seams", async () => {
    const parent = new FakeParentEntries();
    const historyFs = new MemoryPiNativeSessionFs();
    await seedSessionFile(historyFs, `${ROOT}/child-1`);
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      append: parent,
      read: parent,
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
  });

  test("degraded cache stays non-blocking and still returns refs + sessions", async () => {
    const parent = new FakeParentEntries();
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      append: parent,
      read: parent,
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

  test("fails closed when the session root cannot be resolved", async () => {
    const parent = new FakeParentEntries();
    const result = await openPiThreadSources({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      append: parent,
      read: parent,
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
});
