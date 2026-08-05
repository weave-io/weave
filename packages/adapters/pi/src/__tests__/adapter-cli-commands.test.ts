import { describe, expect, it } from "bun:test";
import { dispatchAdapterCommand } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync } from "neverthrow";
import {
  createPiAdapterCommandHandlers,
  createPiAdapterCommandRegistry,
  createPiChildrenCommandPort,
  createPlaceholderDoctorPort,
  looksLikeFilesystemPath,
  PI_ADAPTER_COMMAND_BOUNDS,
  PI_ADAPTER_COMMAND_NAMES,
  stripPathsUnlessDiagnostic,
  type PiAdapterChildrenPort,
  type PiAdapterChildListItem,
} from "../adapter-cli-commands.js";
import {
  decodePiNativeSessionEntryCursor,
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS,
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  type PiNativeSessionHostPort,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import type { PiChildMetadataRecord } from "../child-metadata-cache.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";

const child = (
  overrides: Partial<PiAdapterChildListItem> = {},
): PiAdapterChildListItem => ({
  childId: overrides.childId ?? "child-1",
  threadId: overrides.threadId ?? "thread-1",
  title: overrides.title ?? "Title",
  status: overrides.status ?? "completed",
  createdAt: overrides.createdAt ?? 1_000,
  updatedAt: overrides.updatedAt ?? 2_000,
  originParentSessionId: overrides.originParentSessionId ?? "parent-1",
  tombstoned: overrides.tombstoned ?? false,
  stale: overrides.stale ?? false,
});

function fakeChildren(options: {
  readonly list?: PiAdapterChildListItem[];
  readonly entries?: readonly { id: string; type: string }[];
  readonly sessionPath?: string;
}): PiAdapterChildrenPort {
  const rows = [...(options.list ?? [child()])];
  const entries = options.entries ?? [
    { id: "e1", type: "message" },
    { id: "e2", type: "message" },
  ];
  return {
    list(input) {
      const limited = rows
        .filter((row) => input.includeTombstoned === true || !row.tombstoned)
        .slice(0, PI_ADAPTER_COMMAND_BOUNDS.listPageSize);
      return okAsync({
        children: limited,
        ...(rows.length > PI_ADAPTER_COMMAND_BOUNDS.listPageSize
          ? { nextCursor: "cursor-next" }
          : {}),
      });
    },
    show(input) {
      const found = rows.find((row) => row.childId === input.childId);
      if (found === undefined) {
        return errAsync({
          type: "NotFound" as const,
          message: `child not found: ${input.childId}`,
        });
      }
      const page = entries.slice(-PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize);
      return okAsync({
        child: found,
        entries: page.map((entry, index) => ({
          index,
          id: entry.id,
          type: entry.type,
        })),
        ...(entries.length > PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize
          ? { nextCursor: "entry-cursor" }
          : {}),
        ...(input.diagnostic === true
          ? {
              sessionPath:
                options.sessionPath ?? "/tmp/weave/adapters/pi/sessions/x.jsonl",
              sessionRef: `${found.childId}/session.jsonl`,
            }
          : {}),
      });
    },
    delete(input) {
      if (!input.confirmed) {
        return errAsync({
          type: "ConfirmationRequired" as const,
          message: "delete requires confirmation or --yes",
        });
      }
      const found = rows.find((row) => row.childId === input.childId);
      if (found === undefined) {
        return errAsync({
          type: "NotFound" as const,
          message: `child not found: ${input.childId}`,
        });
      }
      found.tombstoned = true;
      found.status = "tombstoned";
      return okAsync({
        childId: input.childId,
        tombstoned: true as const,
        deletedAt: "2026-08-05T00:00:00.000Z",
      });
    },
  };
}

describe("Pi adapter-cli-commands", () => {
  it("lists at most 50 children through engine dispatch", async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      child({
        childId: `child-${index}`,
        threadId: `thread-${index}`,
        updatedAt: 3_000 - index,
      }),
    );
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({ list: many }),
    });
    const result = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenList,
      payloadJson: JSON.stringify({ workspaceKey: "ws" }),
    });
    expect(result.isOk()).toBe(true);
    const body = JSON.parse(result._unsafeUnwrap().resultJson) as {
      children: unknown[];
      nextCursor?: string;
    };
    expect(body.children).toHaveLength(50);
    expect(body.nextCursor).toBe("cursor-next");
  });

  it("shows at most 100 entries and a cursor when more remain", async () => {
    const entries = Array.from({ length: 120 }, (_, index) => ({
      id: `e-${index}`,
      type: "message",
    }));
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({ entries }),
    });
    const result = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
      }),
    });
    const body = JSON.parse(result._unsafeUnwrap().resultJson) as {
      entries: unknown[];
      nextCursor?: string;
      sessionPath?: string;
    };
    expect(body.entries).toHaveLength(100);
    expect(body.nextCursor).toBe("entry-cursor");
    expect(body.sessionPath).toBeUndefined();
  });

  it("omits filesystem paths by default and includes them with diagnostic", async () => {
    const path = "/Users/jose/.local/share/weave/adapters/pi/sessions/a.jsonl";
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({ sessionPath: path }),
    });

    const defaultShow = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
      }),
    });
    const defaultBody = defaultShow._unsafeUnwrap().resultJson;
    expect(defaultBody).not.toContain(path);
    expect(defaultBody).not.toContain("/Users/");

    const diagnosticShow = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
        diagnostic: true,
      }),
    });
    expect(diagnosticShow._unsafeUnwrap().resultJson).toContain(path);
  });

  it("requires confirmation for delete and tombstones on confirm", async () => {
    const port = fakeChildren({});
    const handlers = createPiAdapterCommandHandlers({ children: port });
    const refused = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenDelete]!(
      JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: "parent-1",
        confirmed: false,
      }),
    );
    expect(refused.isErr()).toBe(true);

    const deleted = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenDelete]!(
      JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: "parent-1",
        confirmed: true,
      }),
    );
    expect(JSON.parse(deleted._unsafeUnwrap())).toEqual({
      kind: "children.delete",
      childId: "child-1",
      tombstoned: true,
      deletedAt: "2026-08-05T00:00:00.000Z",
    });

    const listed = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenList]!(
      JSON.stringify({ workspaceKey: "ws", includeTombstoned: true }),
    );
    const body = JSON.parse(listed._unsafeUnwrap()) as {
      children: PiAdapterChildListItem[];
    };
    expect(body.children[0]?.tombstoned).toBe(true);
    expect(body.children[0]?.status).toBe("tombstoned");
  });

  it("exposes an injectable doctor shell for Task 15", async () => {
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({}),
      doctor: createPlaceholderDoctorPort(),
    });
    const result = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.doctor,
      payloadJson: JSON.stringify({}),
    });
    const body = JSON.parse(result._unsafeUnwrap().resultJson) as {
      kind: string;
      status: string;
    };
    expect(body.kind).toBe("doctor");
    expect(body.status).toBe("not_implemented");
  });

  it("stripPathsUnlessDiagnostic removes absolute paths", () => {
    expect(looksLikeFilesystemPath("/tmp/x")).toBe(true);
    expect(looksLikeFilesystemPath("child-1/session.jsonl")).toBe(false);
    const cleaned = stripPathsUnlessDiagnostic(
      { sessionPath: "/tmp/x", ok: true } as {
        sessionPath?: string;
        ok: boolean;
      },
      false,
    );
    expect(cleaned).toEqual({ ok: true });
    expect("sessionPath" in cleaned).toBe(false);
  });
});

describe("createPiChildrenCommandPort children.show paging", () => {
  const ROOT = "/data/weave/adapters/pi/sessions";
  const PARENT = "parent-session-1";
  const REF = "child-1/session.jsonl";
  const DIR = `${ROOT}/child-1`;
  const FILE = "session.jsonl";
  const textEncoder = new TextEncoder();

  function headerLine(): string {
    return JSON.stringify({
      type: "session",
      version: 3,
      id: "native-session-1",
      cwd: "/repo",
      parentSession: PARENT,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  }

  function entryLine(index: number): string {
    return JSON.stringify({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", content: `n=${index}` },
    });
  }

  async function seed(entryCount: number): Promise<PiNativeSessionStore> {
    const fs = new MemoryPiNativeSessionFs();
    const lines = [headerLine()];
    for (let index = 0; index < entryCount; index += 1) {
      lines.push(entryLine(index));
    }
    const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
    (
      await directory.appendFile(
        FILE,
        textEncoder.encode(`${lines.join("\n")}\n`),
        0o600,
      )
    )._unsafeUnwrap();
    directory.close();
    return new PiNativeSessionStore({
      root: ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host: {
        create(): PiNativeSessionHandle {
          throw new Error("host.create unused");
        },
        open(): PiNativeSessionHandle {
          throw new Error("host.open unused by paged show");
        },
      } satisfies PiNativeSessionHostPort,
    });
  }

  function metadataRecord(): PiChildMetadataRecord {
    return {
      childId: "child-1",
      threadId: "thread-1",
      nativeSessionId: "native-session-1",
      sessionRef: REF,
      originParentSessionId: PARENT,
      originEntryId: "origin-entry-1",
      workspaceKey: "ws",
      title: "Title",
      status: "completed",
      createdAt: 1_000,
      updatedAt: 2_000,
      runCount: 1,
      stale: false,
      tombstoned: false,
      cachedAt: 2_000,
    };
  }

  function fakeCache(record: PiChildMetadataRecord) {
    return {
      list: () => ok({ records: [record], nextCursor: undefined }),
      get: () => okAsync(record),
      tombstone: () =>
        err({ type: "CacheUnavailable" as const, reason: "io" as const }),
    };
  }

  it("pages >10k entries through readSessionEntryPage only with opaque cursors", async () => {
    const entryCount = 10_500;
    const store = await seed(entryCount);
    let fullReads = 0;
    const sessions = {
      openSession: (ref: string, parent?: string) =>
        store.openSession(ref, parent),
      readSessionEntryPage: (
        ref: string,
        parent: string | undefined,
        options: Parameters<PiNativeSessionStore["readSessionEntryPage"]>[2],
      ) => store.readSessionEntryPage(ref, parent, options),
      readSessionEntries: () => {
        fullReads += 1;
        return errAsync({
          type: "SessionCorrupt" as const,
          ref: REF,
          reason: "unreadable" as const,
        });
      },
      deleteSession: () =>
        errAsync({
          type: "SessionConfirmationRequired" as const,
          ref: REF,
        }),
    };
    const port = createPiChildrenCommandPort({
      cache: fakeCache(metadataRecord()),
      sessions,
    });

    const newest = (
      await port.show({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
      })
    )._unsafeUnwrap();
    expect(fullReads).toBe(0);
    expect(newest.entries).toHaveLength(
      PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize,
    );
    expect(newest.entries[0]?.id).toBe(
      `entry-${entryCount - PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize}`,
    );
    expect(newest.entries[newest.entries.length - 1]?.id).toBe(
      `entry-${entryCount - 1}`,
    );
    expect(newest.nextCursor).toBeDefined();
    expect(newest.sessionPath).toBeUndefined();

    const decoded = decodePiNativeSessionEntryCursor(
      newest.nextCursor ?? "",
      REF,
    )._unsafeUnwrap();
    expect(decoded.anchor).toBe("older");
    expect("path" in decoded).toBe(false);

    const older = (
      await port.show({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
        cursor: newest.nextCursor,
      })
    )._unsafeUnwrap();
    expect(fullReads).toBe(0);
    expect(older.entries).toHaveLength(
      PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize,
    );
    expect(older.entries[older.entries.length - 1]?.id).toBe(
      `entry-${entryCount - PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize - 1}`,
    );
    const newestIds = new Set(newest.entries.map((entry) => entry.id));
    for (const entry of older.entries) {
      expect(newestIds.has(entry.id)).toBe(false);
    }
  });

  it("keeps show reads inside the page byte/line budget", async () => {
    const store = await seed(400);
    const port = createPiChildrenCommandPort({
      cache: fakeCache(metadataRecord()),
      sessions: store,
    });
    const page = (
      await port.show({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
      })
    )._unsafeUnwrap();
    expect(page.entries.length).toBeLessThanOrEqual(
      PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize,
    );
    // Bound is enforced inside readSessionEntryPage; show must not ask for more.
    expect(PI_ADAPTER_COMMAND_BOUNDS.showEntryPageSize).toBe(
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLimit,
    );
  });

  it("exposes diagnostic sessionPath only via openSession, never full entry materialization", async () => {
    const store = await seed(20);
    let entryPageCalls = 0;
    let openCalls = 0;
    const port = createPiChildrenCommandPort({
      cache: fakeCache(metadataRecord()),
      sessions: {
        openSession: (ref, parent) => {
          openCalls += 1;
          expect(ref).toBe(REF);
          expect(parent).toBe(PARENT);
          return okAsync({
            childId: "child-1",
            sessionId: "native-session-1",
            ref: REF,
            path: `${ROOT}/${REF}`,
            parentSession: PARENT,
            cwd: "/repo",
          });
        },
        readSessionEntryPage: (ref, parent, options) => {
          entryPageCalls += 1;
          return store.readSessionEntryPage(ref, parent, options);
        },
        deleteSession: () =>
          errAsync({
            type: "SessionConfirmationRequired" as const,
            ref: REF,
          }),
      },
    });

    const normal = await port.show({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
    });
    expect(normal._unsafeUnwrap().sessionPath).toBeUndefined();
    expect(entryPageCalls).toBe(1);
    expect(openCalls).toBe(0);

    const diagnostic = (
      await port.show({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
        diagnostic: true,
      })
    )._unsafeUnwrap();
    expect(entryPageCalls).toBe(2);
    expect(openCalls).toBe(1);
    expect(diagnostic.sessionPath).toBe(`${ROOT}/${REF}`);
    expect(diagnostic.sessionRef).toBe(REF);
  });
});
