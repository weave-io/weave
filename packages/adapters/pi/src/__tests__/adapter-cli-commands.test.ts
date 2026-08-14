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
  type PiAdapterChildListItem,
  type PiAdapterChildrenPort,
  stripPathsUnlessDiagnostic,
} from "../adapter-cli-commands.js";
import type { PiChildMetadataRecord } from "../child-metadata-cache.js";
import {
  decodePiNativeSessionEntryCursor,
  nativeSessionDeletionToken,
  PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
  PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS,
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  type PiNativeSessionHostPort,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import { createOpenSessionMutationGate } from "../required-capability-gate.js";
import {
  type ResultGroupFixtureOptions,
  seedResultGroupSession,
} from "./fakes/result-group-fixture.js";

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
              diagnostics: {
                nativeSessionId: `native-${found.childId}`,
                originParentSessionId: found.originParentSessionId,
                sessionHeader: "verified" as const,
                sessionHealth: "available" as const,
              },
            }
          : {}),
      });
    },
    result() {
      return errAsync({
        type: "Unavailable" as const,
        message: "result retrieval unavailable",
      });
    },
    resolve(input) {
      const matches = rows
        .filter((row) => {
          if (row.childId !== input.childId) return false;
          if (input.includeTombstoned === true) return true;
          return !row.tombstoned;
        })
        .slice(0, PI_ADAPTER_COMMAND_BOUNDS.resolveMatchCap);
      return okAsync({ matches });
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
      diagnostics?: unknown;
    };
    expect(body.entries).toHaveLength(100);
    expect(body.nextCursor).toBe("entry-cursor");
    expect(body.diagnostics).toBeUndefined();
  });

  it("keeps children.show path-free in both default and diagnostic modes", async () => {
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({}),
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
    expect(defaultBody).not.toContain("/");
    expect(JSON.parse(defaultBody).diagnostics).toBeUndefined();

    const diagnosticShow = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
        diagnostic: true,
      }),
    });
    const diagnosticBody = diagnosticShow._unsafeUnwrap().resultJson;
    // Path-free even under --diagnostic: no absolute path, no root-relative
    // session ref, and no `sessionPath`/`sessionRef` key at all.
    expect(diagnosticBody).not.toContain("/");
    expect(diagnosticBody).not.toContain("sessionPath");
    expect(diagnosticBody).not.toContain("sessionRef");
    expect(JSON.parse(diagnosticBody).diagnostics).toEqual({
      nativeSessionId: "native-child-1",
      originParentSessionId: "parent-1",
      sessionHeader: "verified",
      sessionHealth: "available",
    });
  });

  it("resolves a child older than the newest list page without paths", async () => {
    const many = Array.from({ length: 55 }, (_, index) =>
      child({
        childId: `child-${String(index).padStart(2, "0")}`,
        threadId: `thread-${index}`,
        originParentSessionId: `parent-${index}`,
        updatedAt: 3_000 - index,
      }),
    );
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({ list: many }),
    });
    const listed = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenList,
      payloadJson: JSON.stringify({ workspaceKey: "ws" }),
    });
    const listBody = JSON.parse(listed._unsafeUnwrap().resultJson) as {
      children: PiAdapterChildListItem[];
    };
    expect(listBody.children.some((row) => row.childId === "child-54")).toBe(
      false,
    );

    const resolved = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenResolve,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "child-54",
        includeTombstoned: true,
      }),
    });
    const body = JSON.parse(resolved._unsafeUnwrap().resultJson) as {
      kind: string;
      matches: PiAdapterChildListItem[];
      diagnostics?: unknown;
    };
    expect(body.kind).toBe("children.resolve");
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]?.originParentSessionId).toBe("parent-54");
    expect(body.diagnostics).toBeUndefined();
    expect(resolved._unsafeUnwrap().resultJson).not.toContain("/tmp/");
  });

  it("resolves duplicate-parent child ids as multiple matches", async () => {
    const registry = createPiAdapterCommandRegistry({
      children: fakeChildren({
        list: [
          child({
            childId: "shared-child",
            threadId: "thread-a",
            originParentSessionId: "parent-a",
          }),
          child({
            childId: "shared-child",
            threadId: "thread-b",
            originParentSessionId: "parent-b",
          }),
        ],
      }),
    });
    const resolved = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenResolve,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "shared-child",
      }),
    });
    const body = JSON.parse(resolved._unsafeUnwrap().resultJson) as {
      matches: PiAdapterChildListItem[];
    };
    expect(body.matches).toHaveLength(2);
    expect(body.matches.map((row) => row.originParentSessionId).sort()).toEqual(
      ["parent-a", "parent-b"],
    );
  });

  it("requires confirmation for delete and tombstones on confirm", async () => {
    const port = fakeChildren({});
    const handlers = createPiAdapterCommandHandlers({
      children: port,
      sessionMutationGate: createOpenSessionMutationGate(),
    });
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

  function entryLine(index: number, content = `n=${index}`): string {
    return JSON.stringify({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", content },
    });
  }

  async function seed(
    entryCount: number,
    content?: (index: number) => string,
    fs = new MemoryPiNativeSessionFs(),
  ): Promise<PiNativeSessionStore> {
    const lines = [headerLine()];
    for (let index = 0; index < entryCount; index += 1) {
      lines.push(entryLine(index, content?.(index)));
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
      launch: { mode: "read-only" },
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

  async function seedCustom(
    entries: readonly unknown[],
    fs = new MemoryPiNativeSessionFs(),
  ): Promise<PiNativeSessionStore> {
    const lines = [headerLine(), ...entries.map((entry) => JSON.stringify(entry))];
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
      launch: { mode: "read-only" },
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
      findByChildId: () => ok([record]),
      tombstone: () =>
        err({ type: "CacheUnavailable" as const, reason: "io" as const }),
    };
  }

  function contentCursor(entry: string, offset = 0): string {
    return btoa(JSON.stringify({ v: 1, entry, offset }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
  }

  it("rejects malformed and stale native cursors inside valid content cursors without restarting paging", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const store = await seed(5, undefined, fs);
    const newest = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 1,
      })
    )._unsafeUnwrap();
    const staleNativeCursor = newest.olderCursor ?? "";
    expect(staleNativeCursor).not.toBe("");
    fs.simulateFileTruncate(DIR, FILE, headerLine().length + 1);

    const readOptions: Array<
      Parameters<PiNativeSessionStore["readSessionEntryPage"]>[2]
    > = [];
    let newestReads = 0;
    const sessions = {
      openSession: () => {
        throw new Error("show must not open or restart the session");
      },
      readSessionEntryPage: (
        ref: string,
        parent: string | undefined,
        options: Parameters<PiNativeSessionStore["readSessionEntryPage"]>[2],
      ) => {
        readOptions.push(options);
        if (options.direction === "newest") newestReads += 1;
        return store.readSessionEntryPage(ref, parent, options);
      },
      deleteSession: () =>
        errAsync({ type: "SessionConfirmationRequired" as const, ref: REF }),
    };
    const port = createPiChildrenCommandPort({
      cache: fakeCache(metadataRecord()),
      sessions,
    });

    const malformedNativeCursor = "syntactically-valid-outer-payload";
    const malformed = await port.show({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
      content: true,
      contentCursor: contentCursor(malformedNativeCursor),
    });
    expect(malformed._unsafeUnwrapErr()).toEqual({
      type: "InvalidPayload",
      message: "invalid content cursor",
    });

    const stale = await port.show({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
      content: true,
      contentCursor: contentCursor(staleNativeCursor),
    });
    expect(stale._unsafeUnwrapErr()).toEqual({
      type: "Conflict",
      message: "stale content cursor",
    });
    expect(readOptions).toEqual([
      { direction: "at", cursor: malformedNativeCursor, limit: 3 },
      { direction: "at", cursor: staleNativeCursor, limit: 3 },
    ]);
    expect(newestReads).toBe(0);
  });

  it("pages one large entry without losing content and redacts embedded paths", async () => {
    const source = `path=/home/user/secret ${"界".repeat(30_000)}`;
    const store = await seed(1, () => source);
    const sessions = {
      openSession: (ref: string, parent?: string) =>
        store.openSession(ref, parent),
      readSessionEntryPage: (
        ref: string,
        parent: string | undefined,
        options: Parameters<PiNativeSessionStore["readSessionEntryPage"]>[2],
      ) => store.readSessionEntryPage(ref, parent, options),
      deleteSession: () =>
        errAsync({ type: "SessionConfirmationRequired" as const, ref: REF }),
    };
    const port = createPiChildrenCommandPort({
      cache: fakeCache(metadataRecord()),
      sessions,
    });

    const first = (
      await port.show({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
        content: true,
      })
    )._unsafeUnwrap();
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]?.content).not.toContain("/home/user/secret");
    expect(first.entries[0]?.contentComplete).toBe(false);
    expect(first.entries[0]?.contentByteLength).toBeGreaterThan(65_536);
    expect(first.entries[0]?.contentCursor).toBeDefined();

    const second = (
      await port.show({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
        content: true,
        contentCursor: first.entries[0]?.contentCursor,
      })
    )._unsafeUnwrap();
    expect(second.entries[0]?.contentComplete).toBe(true);
    expect(second.entries[0]?.contentCursor).toBeUndefined();
    expect(
      `${first.entries[0]?.content ?? ""}${second.entries[0]?.content ?? ""}`,
    ).toBe(source.replace("/home/user/secret", "[path]"));
  });

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
    expect(newest.diagnostics).toBeUndefined();

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

  it("reads path-free session diagnostics only via openSession, never full entry materialization", async () => {
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
    expect(normal._unsafeUnwrap().diagnostics).toBeUndefined();
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
    // Identity, lineage, header proof, and health survive; the absolute path
    // and the root-relative ref never leave the port.
    expect(diagnostic.diagnostics).toEqual({
      nativeSessionId: "native-session-1",
      originParentSessionId: PARENT,
      sessionHeader: "verified",
      sessionHealth: "available",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(ROOT);
    expect(JSON.stringify(diagnostic)).not.toContain(REF);
  });

  /** The exact identity every seeded result group in this suite is bound to. */
  const RESULT_IDENTITY = {
    childId: "child-1",
    nativeSessionId: "native-session-1",
    parentSession: PARENT,
  } as const;

  /**
   * Seeds one durable result group exactly as `appendResultOutput` writes it:
   * 48 KiB UTF-8-safe chunks, then a commit bound to the child identity and
   * to the storage leaf the chunks actually landed in.
   */
  async function seedResultStore(
    output: string,
    options: ResultGroupFixtureOptions = {},
  ): Promise<PiNativeSessionStore> {
    const fs = new MemoryPiNativeSessionFs();
    await seedResultGroupSession({
      fs,
      directory: DIR,
      fileName: "session.jsonl",
      headerLine: headerLine(),
      identity: RESULT_IDENTITY,
      output,
      options,
    });
    return new PiNativeSessionStore({
      launch: { mode: "read-only" },
      root: ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host: {
        create(): PiNativeSessionHandle {
          throw new Error("host.create unused");
        },
        open(): PiNativeSessionHandle {
          throw new Error("host.open unused by paged reads");
        },
      } satisfies PiNativeSessionHostPort,
    });
  }

  function resultPort(
    store: PiNativeSessionStore,
    record: PiChildMetadataRecord = metadataRecord(),
  ) {
    return createPiChildrenCommandPort({
      cache: fakeCache(record),
      sessions: {
        openSession: (ref: string, parent?: string) =>
          store.openSession(ref, parent),
        readSessionEntryPage: (
          ref: string,
          parent: string | undefined,
          options: Parameters<PiNativeSessionStore["readSessionEntryPage"]>[2],
        ) => store.readSessionEntryPage(ref, parent, options),
        readResultGroup: (
          ref: string,
          expected: Parameters<PiNativeSessionStore["readResultGroup"]>[1],
          options?: Parameters<PiNativeSessionStore["readResultGroup"]>[2],
        ) => store.readResultGroup(ref, expected, options),
        deleteSession: () =>
          errAsync({ type: "SessionConfirmationRequired" as const, ref: REF }),
      },
    });
  }

  it("reconstructs a result larger than two chunks exactly across bounded pages", async () => {
    // Five 48 KiB chunks: far more than any single history page can hold, and
    // more than the two chunks a page-local group check could ever prove.
    const output = `HEAD ${"界".repeat(80_000)} TAIL`;
    const store = await seedResultStore(output);
    const port = resultPort(store);

    let cursor: string | undefined;
    let reconstructed = "";
    let pages = 0;
    let total = 0;
    let byteLength = 0;
    for (;;) {
      const page = (
        await port.result({
          workspaceKey: "ws",
          childId: "child-1",
          parentSessionId: PARENT,
          ...(cursor === undefined ? {} : { cursor }),
        })
      )._unsafeUnwrap();
      expect(page.status).toBe("complete");
      if (page.status !== "complete") return;
      expect(page.exact).toBe(true);
      expect(page.contentByteOffset).toBe(
        textEncoder.encode(reconstructed).byteLength,
      );
      reconstructed += page.content ?? "";
      total = page.total ?? 0;
      byteLength = page.byteLength ?? 0;
      pages += 1;
      cursor = page.nextCursor;
      if (cursor === undefined) break;
      expect(pages).toBeLessThan(20);
    }

    expect({
      chunks: total,
      byteLength,
      exactRoundTrip: reconstructed === output,
      multiplePages: pages > 1,
    }).toEqual({
      chunks: 5,
      byteLength: textEncoder.encode(output).byteLength,
      exactRoundTrip: true,
      multiplePages: true,
    });
  });

  it("returns authoritative bytes verbatim while show only projects sanitized text", async () => {
    // Control sequences and path-like tokens are exactly what the display
    // projection rewrites. The authoritative result must keep them.
    const output = "wrote /home/user/secret.txt\u001b[31m done";
    const store = await seedResultStore(output);
    const port = resultPort(store);

    const exact = (
      await port.result({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
      })
    )._unsafeUnwrap();
    const projected = (
      await port.show({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
        content: true,
      })
    )._unsafeUnwrap();
    const chunkEntry = projected.entries.find(
      (entry) => entry.type === PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
    );

    expect(exact.status).toBe("complete");
    if (exact.status !== "complete") return;
    expect(exact.content).toBe(output);
    expect(exact.digest).toBe(
      new Bun.CryptoHasher("sha256")
        .update(textEncoder.encode(output))
        .digest("hex"),
    );
    expect(chunkEntry?.contentKind).toBe("sanitized-projection");
    expect(chunkEntry?.content).not.toBe(output);
    expect(chunkEntry?.content).not.toContain("/home/user/secret.txt");
  });

  it("refuses to return content for an interrupted or corrupt result group", async () => {
    const interrupted = resultPort(
      await seedResultStore("ab", { omitCommit: true }),
    );
    const corrupt = resultPort(
      await seedResultStore("ab", { digest: "0".repeat(64) }),
    );

    const interruptedResult = (
      await interrupted.result({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
      })
    )._unsafeUnwrap();
    const corruptResult = (
      await corrupt.result({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
      })
    )._unsafeUnwrap();

    expect({
      interrupted: {
        status: interruptedResult.status,
        reason:
          interruptedResult.status === "incomplete"
            ? interruptedResult.reason
            : "",
        content: interruptedResult.content,
      },
      corrupt: {
        status: corruptResult.status,
        reason:
          corruptResult.status === "incomplete" ? corruptResult.reason : "",
        content: corruptResult.content,
      },
    }).toEqual({
      interrupted: {
        status: "incomplete",
        reason: "missing-commit",
        content: undefined,
      },
      corrupt: {
        status: "incomplete",
        reason: "digest-mismatch",
        content: undefined,
      },
    });
  });

  /** Encodes an opaque result cursor the way the store does. */
  function encodeCursor(value: Record<string, unknown>): string {
    return btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
  }

  it("rejects a cursor minted for a different result group", async () => {
    const store = await seedResultStore("ab");
    const foreignCursor = encodeCursor({
      v: 2,
      ...RESULT_IDENTITY,
      resultId: "55555555-5555-4555-8555-555555555555",
      digest: "0".repeat(64),
      chunkIndex: 0,
    });

    const stale = await resultPort(store).result({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
      cursor: foreignCursor,
    });

    expect(stale._unsafeUnwrapErr()).toEqual({
      type: "Conflict",
      message: "stale result cursor",
    });
  });

  it("rejects a cursor minted for another child under the same parent", async () => {
    const store = await seedResultStore("ab");
    const commit = new Bun.CryptoHasher("sha256")
      .update(textEncoder.encode("ab"))
      .digest("hex");

    const siblingChild = await resultPort(store).result({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
      cursor: encodeCursor({
        v: 2,
        ...RESULT_IDENTITY,
        childId: "child-2",
        resultId: "44444444-4444-4444-8444-444444444444",
        digest: commit,
        chunkIndex: 0,
      }),
    });
    const otherSession = await resultPort(store).result({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
      cursor: encodeCursor({
        v: 2,
        ...RESULT_IDENTITY,
        nativeSessionId: "native-session-2",
        resultId: "44444444-4444-4444-8444-444444444444",
        digest: commit,
        chunkIndex: 0,
      }),
    });

    expect({
      siblingChild: siblingChild._unsafeUnwrapErr(),
      otherSession: otherSession._unsafeUnwrapErr(),
    }).toEqual({
      siblingChild: { type: "Conflict", message: "result identity mismatch" },
      otherSession: { type: "Conflict", message: "result identity mismatch" },
    });
  });

  it("refuses to serve one child's result to a sibling row of the same parent", async () => {
    // The seeded group belongs to `child-1`. A cache row that reaches the
    // same ref while naming a different child or native session must not be
    // handed this result: reachability is not authority.
    const store = await seedResultStore("ab");

    const siblingChild = await resultPort(store, {
      ...metadataRecord(),
      childId: "child-2",
    }).result({
      workspaceKey: "ws",
      childId: "child-2",
      parentSessionId: PARENT,
    });
    const siblingSession = await resultPort(store, {
      ...metadataRecord(),
      nativeSessionId: "native-session-2",
    }).result({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
    });

    expect({
      siblingChild: siblingChild._unsafeUnwrapErr(),
      siblingSession: siblingSession._unsafeUnwrapErr(),
    }).toEqual({
      siblingChild: { type: "Conflict", message: "result identity mismatch" },
      siblingSession: { type: "Conflict", message: "result identity mismatch" },
    });
  });
});

describe("createPiChildrenCommandPort children.delete status gate", () => {
  const REF = "child-1/session.jsonl";
  const PARENT = "parent-session-1";

  function metadataRecord(
    overrides: Partial<PiChildMetadataRecord> = {},
  ): PiChildMetadataRecord {
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
      ...overrides,
    };
  }

  function trackingSessions() {
    let openCalls = 0;
    let deleteCalls = 0;
    return {
      openCalls: () => openCalls,
      deleteCalls: () => deleteCalls,
      openSession: () => {
        openCalls += 1;
        return errAsync({
          type: "SessionMissing" as const,
          ref: REF,
        });
      },
      readSessionEntryPage: () =>
        errAsync({
          type: "SessionMissing" as const,
          ref: REF,
        }),
      deleteSession: () => {
        deleteCalls += 1;
        return errAsync({
          type: "SessionConfirmationRequired" as const,
          ref: REF,
        });
      },
    };
  }

  it("rejects queued, running, tombstoned, unknown, and missing status before confirmation or mutation", async () => {
    const cases = [
      {
        name: "queued",
        record: metadataRecord({ status: "queued" }),
        expected: {
          type: "Conflict",
          message: "child-not-terminal:queued",
        },
      },
      {
        name: "running",
        record: metadataRecord({ status: "running" }),
        expected: {
          type: "Conflict",
          message: "child-not-terminal:running",
        },
      },
      {
        name: "tombstoned",
        record: metadataRecord({ status: "tombstoned", tombstoned: true }),
        expected: {
          type: "Conflict",
          message: "child-already-tombstoned",
        },
      },
      {
        name: "unknown",
        record: {
          ...metadataRecord(),
          status: "settled",
        } as unknown as PiChildMetadataRecord,
        expected: {
          type: "Conflict",
          message: "child-status-unknown",
        },
      },
      {
        name: "missing",
        record: {
          ...metadataRecord(),
          status: "",
        } as unknown as PiChildMetadataRecord,
        expected: {
          type: "Conflict",
          message: "child-status-missing",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const sessions = trackingSessions();
      let tombstoneCalls = 0;
      const port = createPiChildrenCommandPort({
        cache: {
          list: () => ok({ records: [testCase.record], nextCursor: undefined }),
          get: () => okAsync(testCase.record),
          findByChildId: () => ok([testCase.record]),
          tombstone: () => {
            tombstoneCalls += 1;
            return ok(undefined);
          },
        },
        sessions,
      });
      const refused = await port.delete({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
        confirmed: true,
      });
      expect({
        name: testCase.name,
        error: refused.isErr() ? refused.error : "unexpected-success",
        openCalls: sessions.openCalls(),
        deleteCalls: sessions.deleteCalls(),
        tombstoneCalls,
      }).toEqual({
        name: testCase.name,
        error: testCase.expected,
        openCalls: 0,
        deleteCalls: 0,
        tombstoneCalls: 0,
      });
    }
  });

  it("rejects a malformed cache row before confirmation or mutation", async () => {
    const sessions = trackingSessions();
    let tombstoneCalls = 0;
    const port = createPiChildrenCommandPort({
      cache: {
        list: () => ok({ records: [], nextCursor: undefined }),
        get: () =>
          errAsync({
            type: "CacheRecordInvalid" as const,
            issues: ["status"],
          }),
        findByChildId: () =>
          err({
            type: "CacheRecordInvalid" as const,
            issues: ["status"],
          }),
        tombstone: () => {
          tombstoneCalls += 1;
          return ok(undefined);
        },
      },
      sessions,
    });
    const refused = await port.delete({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
      confirmed: true,
    });
    expect({
      error: refused.isErr() ? refused.error : "unexpected-success",
      openCalls: sessions.openCalls(),
      deleteCalls: sessions.deleteCalls(),
      tombstoneCalls,
    }).toEqual({
      error: { type: "Unavailable", message: "CacheRecordInvalid" },
      openCalls: 0,
      deleteCalls: 0,
      tombstoneCalls: 0,
    });
  });

  it("deletes from the held cache ref without reopening the native session", async () => {
    const record = metadataRecord();
    let openCalls = 0;
    let deleteCalls = 0;
    let tombstoneCalls = 0;
    const port = createPiChildrenCommandPort({
      cache: {
        list: () => ok({ records: [record], nextCursor: undefined }),
        get: () => okAsync(record),
        findByChildId: () => ok([record]),
        tombstone: () => {
          tombstoneCalls += 1;
          return ok(undefined);
        },
      },
      sessions: {
        openSession: () => {
          openCalls += 1;
          return errAsync({
            type: "SessionMissing" as const,
            ref: REF,
          });
        },
        readSessionEntryPage: () =>
          errAsync({
            type: "SessionMissing" as const,
            ref: REF,
          }),
        deleteSession: (session, token) => {
          deleteCalls += 1;
          expect(session.ref).toBe(REF);
          expect(session.childId).toBe("child-1");
          expect(session.parentSession).toBe(PARENT);
          expect(token).toBe(nativeSessionDeletionToken(REF));
          return okAsync({
            version: 1 as const,
            ref: REF,
            childId: "child-1",
            parentSession: PARENT,
            deletedAt: "2026-01-01T00:00:00.000Z",
            reason: "explicit-user-deletion" as const,
            phase: "completed" as const,
          });
        },
      },
    });
    const deleted = (
      await port.delete({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: PARENT,
        confirmed: true,
      })
    )._unsafeUnwrap();
    expect({
      deleted,
      openCalls,
      deleteCalls,
      tombstoneCalls,
    }).toEqual({
      deleted: {
        childId: "child-1",
        tombstoned: true,
        deletedAt: "2026-01-01T00:00:00.000Z",
      },
      openCalls: 0,
      deleteCalls: 1,
      tombstoneCalls: 1,
    });
  });

  it("does not mark the cache tombstoned when native deletion is still pending", async () => {
    const record = metadataRecord();
    let tombstoneCalls = 0;
    const port = createPiChildrenCommandPort({
      cache: {
        list: () => ok({ records: [record], nextCursor: undefined }),
        get: () => okAsync(record),
        findByChildId: () => ok([record]),
        tombstone: () => {
          tombstoneCalls += 1;
          return ok(undefined);
        },
      },
      sessions: {
        openSession: () =>
          errAsync({ type: "SessionMissing" as const, ref: REF }),
        readSessionEntryPage: () =>
          errAsync({ type: "SessionMissing" as const, ref: REF }),
        deleteSession: () =>
          errAsync({
            type: "SessionUnlinkFailed" as const,
            ref: REF,
            reason: "io" as const,
          }),
      },
    });
    const refused = await port.delete({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
      confirmed: true,
    });
    expect({
      error: refused.isErr() ? refused.error : "unexpected-success",
      tombstoneCalls,
    }).toEqual({
      error: { type: "Unavailable", message: "SessionUnlinkFailed" },
      tombstoneCalls: 0,
    });
  });

  it("retries cache tombstone after a durable native completion without reporting false success", async () => {
    const record = metadataRecord();
    let deleteCalls = 0;
    let tombstoneCalls = 0;
    const port = createPiChildrenCommandPort({
      cache: {
        list: () => ok({ records: [record], nextCursor: undefined }),
        get: () => okAsync(record),
        findByChildId: () => ok([record]),
        tombstone: () => {
          tombstoneCalls += 1;
          return tombstoneCalls === 1
            ? err({ type: "CacheUnavailable" as const, reason: "io" as const })
            : ok(undefined);
        },
      },
      sessions: {
        openSession: () =>
          errAsync({ type: "SessionMissing" as const, ref: REF }),
        readSessionEntryPage: () =>
          errAsync({ type: "SessionMissing" as const, ref: REF }),
        deleteSession: () => {
          deleteCalls += 1;
          return okAsync({
            version: 1 as const,
            ref: REF,
            childId: "child-1",
            parentSession: PARENT,
            deletedAt: "2026-01-01T00:00:00.000Z",
            reason: "explicit-user-deletion" as const,
            phase: "completed" as const,
          });
        },
      },
    });
    const first = await port.delete({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
      confirmed: true,
    });
    const second = await port.delete({
      workspaceKey: "ws",
      childId: "child-1",
      parentSessionId: PARENT,
      confirmed: true,
    });
    expect({
      first: first.isErr() ? first.error : "unexpected-success",
      second: second.isOk() ? second.value : "unexpected-failure",
      deleteCalls,
      tombstoneCalls,
    }).toEqual({
      first: { type: "Unavailable", message: "CacheUnavailable" },
      second: {
        childId: "child-1",
        tombstoned: true,
        deletedAt: "2026-01-01T00:00:00.000Z",
      },
      deleteCalls: 2,
      tombstoneCalls: 2,
    });
  });
});
