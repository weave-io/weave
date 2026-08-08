import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import {
  isDisjointFromDefaultSessionTree,
  nativeSessionDeletionToken,
  PI_NATIVE_SESSION_LAYOUT,
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  type PiNativeSessionHeader,
  type PiNativeSessionHostPort,
  type PiNativeSessionRecord,
  type PiNativeSessionStorageUnavailable,
  PiNativeSessionStore,
  resolvePiNativeSessionRoot,
  safeNativeSessionComponent,
  verifyNativeSessionRef,
} from "../child-native-sessions.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import {
  FakePiTrustedDataRootPort,
  IdentityPiTrustedDataRootPort,
} from "../trusted-data-root.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const PARENT = "parent-session-1";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const RECORD: PiNativeSessionRecord = {
  childId: "child-1",
  sessionId: "native-session-1",
  ref: "child-1/session.jsonl",
  path: `${ROOT}/child-1/session.jsonl`,
  parentSession: PARENT,
  cwd: "/repo",
};

function defaultHeader(
  cwd: string,
  parentSession: string | undefined = PARENT,
): PiNativeSessionHeader {
  return {
    type: "session",
    id: "native-session-1",
    cwd,
    version: 3,
    timestamp: TIMESTAMP,
    parentSession,
  };
}

interface FakeHostOptions {
  readonly fileName?: string;
  readonly persisted?: boolean;
  readonly header?: PiNativeSessionHeader | null;
  readonly headerForOpen?: PiNativeSessionHeader | null;
  readonly createThrows?: boolean;
  readonly openThrows?: boolean;
  readonly entriesThrow?: boolean;
  readonly entries?: readonly unknown[];
  readonly fileOverride?: string;
}

function handleFor(
  file: string | undefined,
  dir: string,
  header: PiNativeSessionHeader | null,
  persisted: boolean,
  entries: readonly unknown[] = [],
  entriesThrow = false,
): PiNativeSessionHandle {
  return {
    getSessionId: () => header?.id ?? "",
    getSessionFile: () => file,
    getSessionDir: () => dir,
    getHeader: () => header,
    getEntries: () => {
      if (entriesThrow) throw new Error("entries failed");
      return entries;
    },
    isPersisted: () => persisted,
    getLeafId: () => null,
    appendCustomEntry: () => "leaf-custom-1",
  };
}

/**
 * Scripted stand-in for Pi's `SessionManager`. It never starts a real harness.
 * The store exclusive-creates the header when the generated path is absent.
 */
class FakeHost implements PiNativeSessionHostPort {
  requireDescriptorSafeSessionIo(): Result<
    void,
    PiNativeSessionStorageUnavailable
  > {
    // Test-only memory host: every byte goes through the injected in-memory
    // no-follow filesystem, so descriptor-safe storage is provable here.
    return ok(undefined);
  }

  readonly created: {
    cwd: string;
    dir: string;
    options: { parentSession?: string; id?: string };
  }[] = [];
  readonly opened: { path: string; dir: string }[] = [];
  private openCount = 0;

  constructor(private readonly options: FakeHostOptions = {}) {}

  create(
    cwd: string,
    sessionDir: string,
    options: { parentSession?: string; id?: string },
  ): PiNativeSessionHandle {
    this.created.push({ cwd, dir: sessionDir, options });
    if (this.options.createThrows) throw new Error("host failure");
    const persisted = this.options.persisted ?? true;
    const fileName = this.options.fileName ?? "session.jsonl";
    const file =
      this.options.fileOverride ??
      (persisted ? `${sessionDir}/${fileName}` : undefined);
    const header =
      this.options.header === undefined
        ? defaultHeader(cwd, options.parentSession)
        : this.options.header;
    return handleFor(
      file,
      sessionDir,
      header,
      persisted,
      this.options.entries ?? [],
      this.options.entriesThrow ?? false,
    );
  }

  open(path: string, sessionDir: string): PiNativeSessionHandle {
    this.opened.push({ path, dir: sessionDir });
    this.openCount += 1;
    // Create-path reopen must succeed; openSession overrides apply afterward.
    const afterCreate = this.openCount > 1;
    if (afterCreate && this.options.openThrows) {
      throw new Error("unreadable");
    }
    const header =
      afterCreate && Object.hasOwn(this.options, "headerForOpen")
        ? (this.options.headerForOpen as PiNativeSessionHeader | null)
        : defaultHeader("/repo", PARENT);
    return handleFor(
      path,
      sessionDir,
      header,
      true,
      this.options.entries ?? [],
      this.options.entriesThrow ?? false,
    );
  }
}

/** A hostile host used to prove the storage-authority guard is the first seam. */
class DenyingHost implements PiNativeSessionHostPort {
  preflightCalls = 0;
  createCalls = 0;
  openCalls = 0;

  requireDescriptorSafeSessionIo(): Result<
    void,
    PiNativeSessionStorageUnavailable
  > {
    this.preflightCalls += 1;
    return err({
      type: "SessionStorageUnavailable",
      reason: "path-only-session-api",
    });
  }

  create(
    ..._args: Parameters<PiNativeSessionHostPort["create"]>
  ): ReturnType<PiNativeSessionHostPort["create"]> {
    this.createCalls += 1;
    throw new Error("SessionManager.create must not be called");
  }

  open(
    ..._args: Parameters<PiNativeSessionHostPort["open"]>
  ): ReturnType<PiNativeSessionHostPort["open"]> {
    this.openCalls += 1;
    throw new Error("SessionManager.open must not be called");
  }
}

function throwingFilesystem(calls: {
  openDirectory: number;
}): PiNativeSessionFsPort {
  return {
    openDirectory: () => {
      calls.openDirectory += 1;
      throw new Error("filesystem mutation must not be attempted");
    },
  } as unknown as PiNativeSessionFsPort;
}

/** Pre-occupies a session leaf so create can assert collision. */
async function seedSessionFile(
  fs: MemoryPiNativeSessionFs,
  directoryPath: string,
  fileName = "session.jsonl",
  body = '{"type":"session"}\n',
): Promise<void> {
  const directory = (
    await fs.openDirectory(directoryPath, true)
  )._unsafeUnwrap();
  (
    await directory.appendFile(fileName, new TextEncoder().encode(body), 0o600)
  )._unsafeUnwrap();
  directory.close();
}

/**
 * Appends raw JSONL body bytes to an existing session leaf. The descriptor
 * read path parses these exact bytes, so entry fixtures live on disk rather
 * than in the host handle.
 */
async function appendSessionBody(
  fs: MemoryPiNativeSessionFs,
  directoryPath: string,
  fileName: string,
  body: string,
): Promise<void> {
  const directory = (
    await fs.openDirectory(directoryPath, false)
  )._unsafeUnwrap();
  (
    await directory.appendFile(fileName, new TextEncoder().encode(body), 0o600)
  )._unsafeUnwrap();
  directory.close();
}

/** Serializes entries as one JSONL line each. */
function jsonl(entries: readonly unknown[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/**
 * Replaces a session leaf's whole contents, used to stage a corrupt or
 * header-less file the descriptor read path must reject.
 */
async function overwriteSessionFile(
  fs: MemoryPiNativeSessionFs,
  directoryPath: string,
  fileName: string,
  body: string,
): Promise<void> {
  const directory = (
    await fs.openDirectory(directoryPath, false)
  )._unsafeUnwrap();
  (await directory.deleteFile(fileName))._unsafeUnwrap();
  (
    await directory.appendFile(fileName, new TextEncoder().encode(body), 0o600)
  )._unsafeUnwrap();
  directory.close();
}

interface Harness {
  readonly store: PiNativeSessionStore;
  readonly fs: MemoryPiNativeSessionFs;
  readonly host: FakeHost;
  create(
    childId?: string,
  ): Promise<Awaited<ReturnType<PiNativeSessionStore["createChildSession"]>>>;
}

function harness(options: FakeHostOptions = {}): Harness {
  const fs = new MemoryPiNativeSessionFs();
  const host = new FakeHost(options);
  const store = new PiNativeSessionStore({
    root: ROOT,
    // Structural stand-in until Task 16 removes the legacy JSONL FS module.
    fs: fs as unknown as PiNativeSessionFsPort,
    host,
    now: () => new Date(TIMESTAMP),
  });
  return {
    store,
    fs,
    host,
    async create(childId = "child-1") {
      return store.createChildSession({
        childId,
        parentSession: PARENT,
        cwd: "/repo",
      });
    },
  };
}

describe("resolvePiNativeSessionRoot", () => {
  const identityRoot = new IdentityPiTrustedDataRootPort();

  test("uses XDG_DATA_HOME when absolute", async () => {
    const resolved = await resolvePiNativeSessionRoot({
      env: { XDG_DATA_HOME: "/xdg" },
      homeDir: "/home/user",
      trustedRoot: identityRoot,
    });
    expect(resolved._unsafeUnwrap()).toBe("/xdg/weave/adapters/pi/sessions");
  });

  test("defaults to ~/.local/share", async () => {
    const resolved = await resolvePiNativeSessionRoot({
      env: {},
      homeDir: "/home/user",
      trustedRoot: identityRoot,
    });
    expect(resolved._unsafeUnwrap()).toBe(
      "/home/user/.local/share/weave/adapters/pi/sessions",
    );
  });

  test("rejects a relative XDG_DATA_HOME", async () => {
    const resolved = await resolvePiNativeSessionRoot({
      env: { XDG_DATA_HOME: "relative/data" },
      homeDir: "/home/user",
      trustedRoot: identityRoot,
    });
    expect(resolved._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "relative-xdg-data-home",
    });
  });

  test("rejects an empty home with no XDG_DATA_HOME", async () => {
    const resolved = await resolvePiNativeSessionRoot({
      env: {},
      homeDir: "",
      trustedRoot: identityRoot,
    });
    expect(resolved._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "empty-home",
    });
  });

  test("stores under the canonical target of a symlinked base", async () => {
    const resolved = await resolvePiNativeSessionRoot({
      env: { XDG_DATA_HOME: "/home/user/.local/share" },
      trustedRoot: new FakePiTrustedDataRootPort(
        new Map([
          ["/home/user/.local/share", ok("/home/user/dotfiles/.local/share")],
        ]),
      ),
    });
    expect(resolved._unsafeUnwrap()).toBe(
      "/home/user/dotfiles/.local/share/weave/adapters/pi/sessions",
    );
  });

  test.each([
    ["unresolvable-data-root" as const, "unresolvable-data-root" as const],
    ["non-directory-data-root" as const, "non-directory-data-root" as const],
    ["foreign-data-root" as const, "foreign-data-root" as const],
    ["writable-data-root" as const, "writable-data-root" as const],
  ])("maps an untrusted base (%s) to a typed root violation", async (violation, reason) => {
    const resolved = await resolvePiNativeSessionRoot({
      env: { XDG_DATA_HOME: "/xdg" },
      trustedRoot: new FakePiTrustedDataRootPort(
        new Map([["/xdg", err(violation)]]),
      ),
    });
    expect(resolved._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason,
    });
  });

  test("reports storage unavailable when canonicalization cannot run", async () => {
    const resolved = await resolvePiNativeSessionRoot({
      env: { XDG_DATA_HOME: "/xdg" },
      trustedRoot: new FakePiTrustedDataRootPort(
        new Map([["/xdg", err("data-root-unavailable" as const)]]),
      ),
    });
    expect(resolved._unsafeUnwrapErr()).toEqual({
      type: "SessionStorageUnavailable",
      reason: "filesystem-unavailable",
    });
  });
});

describe("containment", () => {
  test.each([
    ["../escape/session.jsonl"],
    ["child/../../escape/session.jsonl"],
    ["/absolute/session.jsonl"],
    [""],
  ])("rejects unsafe ref %p", (ref) => {
    const verified = verifyNativeSessionRef(ref);
    expect(verified.isErr()).toBe(true);
    expect(verified._unsafeUnwrapErr().type).toBe("SessionRootViolation");
  });

  test("accepts a safe root-relative ref", () => {
    expect(
      verifyNativeSessionRef("child-1/session.jsonl")._unsafeUnwrap(),
    ).toBe("child-1/session.jsonl");
  });

  test("hashes an unsafe child id into one safe component", () => {
    expect(
      safeNativeSessionComponent("../../etc/passwd")._unsafeUnwrap(),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects an empty child id", () => {
    expect(safeNativeSessionComponent("")._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "unsafe-component",
    });
  });

  test("rejects a symlinked child directory", async () => {
    const { store, fs, create } = harness();
    (await create())._unsafeUnwrap();
    fs.simulateDirectorySymlink(`${ROOT}/child-1`);
    const result = await store.openSession("child-1/session.jsonl");
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "symlink-rejected",
    });
  });

  test("rejects a session file the host places outside the child directory", async () => {
    const { create } = harness({ fileOverride: "/elsewhere/session.jsonl" });
    const result = await create();
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "path-escape",
    });
  });

  test("keeps an unsafe child id inside the root", async () => {
    const { store, host } = harness();
    const component =
      safeNativeSessionComponent("../../escape")._unsafeUnwrap();
    const record = (
      await store.createChildSession({
        childId: "../../escape",
        parentSession: PARENT,
        cwd: "/repo",
      })
    )._unsafeUnwrap();
    expect(record.path).toBe(`${ROOT}/${component}/session.jsonl`);
    expect(host.created[0]?.dir).toBe(`${ROOT}/${component}`);
  });
});

describe("descriptor-safe storage preflight", () => {
  test("returns before host, filesystem, or clock work", async () => {
    const host = new DenyingHost();
    const filesystemCalls = { openDirectory: 0 };
    let clockCalls = 0;
    const store = new PiNativeSessionStore({
      root: ROOT,
      fs: throwingFilesystem(filesystemCalls),
      host,
      now: () => {
        clockCalls += 1;
        return new Date(TIMESTAMP);
      },
    });
    const unavailable: PiNativeSessionStorageUnavailable = {
      type: "SessionStorageUnavailable",
      reason: "path-only-session-api",
    };

    const results = [
      await store.createChildSession({
        childId: "../escape",
        parentSession: PARENT,
        cwd: "/repo",
      }),
      await store.establishThreadLeaf(
        "../escape/session.jsonl",
        {
          threadId: "thread-1",
          agentName: "agent",
          parentId: "parent-1",
          parentAgentName: "parent-agent",
          parentDepth: 0,
          ownerParentSessionId: "owner-1",
          cwd: "/repo",
          createdAt: 0,
        },
        PARENT,
      ),
      await store.deleteSession(
        { ...RECORD, ref: "../escape/session.jsonl" },
        "wrong",
      ),
      await store.appendTombstone({
        ...RECORD,
        ref: "../escape/session.jsonl",
      }),
    ];

    for (const result of results) {
      expect(result._unsafeUnwrapErr()).toEqual(unavailable);
    }
    expect(host.preflightCalls).toBe(4);
    expect(host.createCalls).toBe(0);
    expect(host.openCalls).toBe(0);
    expect(filesystemCalls.openDirectory).toBe(0);
    expect(clockCalls).toBe(0);
  });

  test("keeps descriptor-only reads available when the host is unavailable", async () => {
    const fs = new MemoryPiNativeSessionFs();
    await seedSessionFile(
      fs,
      `${ROOT}/child-1`,
      "session.jsonl",
      jsonl([defaultHeader("/repo")]),
    );
    const host = new DenyingHost();
    const store = new PiNativeSessionStore({
      root: ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host,
    });

    const result = await store.readSessionEntries(
      "child-1/session.jsonl",
      PARENT,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().entries).toEqual([]);
    expect(host.preflightCalls).toBe(0);
    expect(host.openCalls).toBe(0);
  });
});

describe("createChildSession", () => {
  test("persists the host header under the isolated root before reopen", async () => {
    const { host, fs, create } = harness();
    const record = (await create())._unsafeUnwrap();

    expect(host.created).toHaveLength(1);
    expect(host.created[0]?.dir).toBe(`${ROOT}/child-1`);
    expect(host.created[0]?.cwd).toBe("/repo");
    expect(host.created[0]?.options.parentSession).toBe(PARENT);
    expect(host.opened).toEqual([
      { path: `${ROOT}/child-1/session.jsonl`, dir: `${ROOT}/child-1` },
    ]);
    expect(record.ref).toBe("child-1/session.jsonl");
    expect(record.path).toBe(`${ROOT}/child-1/session.jsonl`);
    expect(record.parentSession).toBe(PARENT);
    expect(record.sessionId).toBe("native-session-1");

    const expected = `${JSON.stringify(defaultHeader("/repo"))}\n`;
    const bytes = fs.files(`${ROOT}/child-1`).get("session.jsonl");
    expect(new TextDecoder().decode(bytes)).toBe(expected);
    expect(expected).not.toContain('"role":"assistant"');
  });

  test("fails when the host did not persist the session", async () => {
    const { create } = harness({ persisted: false });
    expect((await create())._unsafeUnwrapErr()).toEqual({
      type: "SessionCreateFailed",
      reason: "not-persisted",
    });
  });

  test("exclusive-creates when the generated path is absent", async () => {
    const { store, fs } = harness();
    const result = await store.createChildSession({
      childId: "child-1",
      parentSession: PARENT,
      cwd: "/repo",
    });
    expect(result.isOk()).toBe(true);
    expect(fs.files(`${ROOT}/child-1`).has("session.jsonl")).toBe(true);
  });

  test("fails when the host throws", async () => {
    const { create } = harness({ createThrows: true });
    expect((await create())._unsafeUnwrapErr()).toEqual({
      type: "SessionCreateFailed",
      reason: "host-threw",
    });
  });

  test("rejects a header without a parentSession link as unusable", async () => {
    const { create } = harness({
      header: {
        type: "session",
        id: "native-session-1",
        cwd: "/repo",
        version: 3,
        timestamp: TIMESTAMP,
      },
    });
    expect((await create())._unsafeUnwrapErr()).toEqual({
      type: "SessionCreateFailed",
      reason: "header-unusable",
    });
  });

  test("rejects a non-v3 session header as unusable", async () => {
    const { create } = harness({
      header: {
        type: "session",
        id: "native-session-1",
        cwd: "/repo",
        version: 2,
        timestamp: TIMESTAMP,
        parentSession: PARENT,
      },
    });
    expect((await create())._unsafeUnwrapErr()).toEqual({
      type: "SessionCreateFailed",
      reason: "header-unusable",
    });
  });

  test("rejects a missing host timestamp as unusable", async () => {
    const { create } = harness({
      header: {
        type: "session",
        id: "native-session-1",
        cwd: "/repo",
        version: 3,
        parentSession: PARENT,
      },
    });
    expect((await create())._unsafeUnwrapErr()).toEqual({
      type: "SessionCreateFailed",
      reason: "header-unusable",
    });
  });

  test("rejects collision when the generated path is already occupied", async () => {
    const { store, fs } = harness();
    await seedSessionFile(fs, `${ROOT}/child-1`);
    const result = await store.createChildSession({
      childId: "child-1",
      parentSession: PARENT,
      cwd: "/repo",
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionCreateFailed",
      reason: "collision",
    });
  });

  test("rejects an exclusive-create race as collision", async () => {
    const { store, fs } = harness();
    (await fs.openDirectory(`${ROOT}/child-1`, true))._unsafeUnwrap().close();
    fs.simulateExclusiveCreateFailure(`${ROOT}/child-1`, "session.jsonl", {
      type: "already-exists",
    });
    const result = await store.createChildSession({
      childId: "child-1",
      parentSession: PARENT,
      cwd: "/repo",
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionCreateFailed",
      reason: "collision",
    });
  });

  test("rejects exclusive-create write failure as io", async () => {
    const { store, fs } = harness();
    (await fs.openDirectory(`${ROOT}/child-1`, true))._unsafeUnwrap().close();
    fs.simulateExclusiveCreateFailure(`${ROOT}/child-1`, "session.jsonl", {
      type: "io",
    });
    const result = await store.createChildSession({
      childId: "child-1",
      parentSession: PARENT,
      cwd: "/repo",
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionCreateFailed",
      reason: "io",
    });
  });

  test("rejects a symlinked generated leaf", async () => {
    const { store, fs } = harness();
    (await fs.openDirectory(`${ROOT}/child-1`, true))._unsafeUnwrap().close();
    fs.simulateFileSymlink(`${ROOT}/child-1`, "session.jsonl");
    const result = await store.createChildSession({
      childId: "child-1",
      parentSession: PARENT,
      cwd: "/repo",
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "symlink-rejected",
    });
  });

  test("rejects exclusive-create permissive-mode failures", async () => {
    const { store, fs } = harness();
    (await fs.openDirectory(`${ROOT}/child-1`, true))._unsafeUnwrap().close();
    fs.simulateExclusiveCreateFailure(`${ROOT}/child-1`, "session.jsonl", {
      type: "permissive-mode",
      kind: "file",
    });
    const result = await store.createChildSession({
      childId: "child-1",
      parentSession: PARENT,
      cwd: "/repo",
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionPermissionError",
      kind: "file",
    });
  });

  test("does not fabricate assistant entries when persisting the header", async () => {
    const { fs, create } = harness();
    (await create())._unsafeUnwrap();
    const text = new TextDecoder().decode(
      fs.files(`${ROOT}/child-1`).get("session.jsonl"),
    );
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(defaultHeader("/repo"));
    expect(text).not.toMatch(/assistant/);
  });

  test("rejects an empty parent session before touching storage", async () => {
    const { store, host } = harness();
    const result = await store.createChildSession({
      childId: "child-1",
      parentSession: "",
      cwd: "/repo",
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionCreateFailed",
      reason: "not-persisted",
    });
    expect(host.created).toHaveLength(0);
  });
});

describe("permission modes", () => {
  test("layout pins user-only modes", () => {
    expect(PI_NATIVE_SESSION_LAYOUT.directoryMode).toBe(0o700);
    expect(PI_NATIVE_SESSION_LAYOUT.fileMode).toBe(0o600);
  });

  test("reports a permissive child directory instead of repairing it", async () => {
    const { store, fs, create } = harness();
    (await create())._unsafeUnwrap();
    fs.simulatePermissiveDirectory(`${ROOT}/child-1`);
    const result = await store.openSession("child-1/session.jsonl");
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionPermissionError",
      kind: "directory",
    });
  });

  test("reports a permissive session file", async () => {
    const { store, fs, create } = harness();
    (await create())._unsafeUnwrap();
    fs.simulatePermissiveFile(`${ROOT}/child-1`, "session.jsonl");
    const result = await store.openSession("child-1/session.jsonl");
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionPermissionError",
      kind: "file",
    });
  });

  test("reports a permissive tombstone ledger", async () => {
    const { store, fs } = harness();
    (await store.appendTombstone(RECORD))._unsafeUnwrap();
    fs.simulatePermissiveFile(ROOT, PI_NATIVE_SESSION_LAYOUT.tombstoneFile);
    const appended = await store.appendTombstone(RECORD);
    expect(appended._unsafeUnwrapErr()).toEqual({
      type: "TombstoneAppendFailed",
      reason: "permission",
    });
  });
});

describe("openSession", () => {
  test("reads a persisted session from descriptor bytes without a host open", async () => {
    const { store, host, create } = harness();
    (await create())._unsafeUnwrap();
    const openedAfterCreate = host.opened.length;
    const record = (
      await store.openSession("child-1/session.jsonl", PARENT)
    )._unsafeUnwrap();
    expect(record.sessionId).toBe("native-session-1");
    expect(record.parentSession).toBe(PARENT);
    expect(record.path).toBe(`${ROOT}/child-1/session.jsonl`);
    // The descriptor path parses the file itself, so no additional
    // SessionManager.open happens beyond the create-path reopen.
    expect(host.opened).toHaveLength(openedAfterCreate);
  });

  test("returns SessionMissing for an unknown child directory", async () => {
    const { store } = harness();
    expect(
      (await store.openSession("child-9/session.jsonl"))._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionMissing", ref: "child-9/session.jsonl" });
  });

  test("returns SessionMissing when the directory exists but the file does not", async () => {
    const { store, create } = harness();
    (await create())._unsafeUnwrap();
    expect(
      (await store.openSession("child-1/other.jsonl"))._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionMissing", ref: "child-1/other.jsonl" });
  });

  test("returns SessionCorrupt when a body line is not readable JSONL", async () => {
    const { store, fs, create } = harness();
    const created = (await create())._unsafeUnwrap();
    await appendSessionBody(
      fs,
      `${ROOT}/child-1`,
      created.ref.slice(created.ref.lastIndexOf("/") + 1),
      "not-json\n",
    );
    expect(
      (await store.openSession("child-1/session.jsonl"))._unsafeUnwrapErr(),
    ).toEqual({
      type: "SessionCorrupt",
      ref: "child-1/session.jsonl",
      reason: "unreadable",
    });
  });

  test("returns SessionCorrupt when the header is absent", async () => {
    const { store, fs, create } = harness();
    (await create())._unsafeUnwrap();
    await overwriteSessionFile(
      fs,
      `${ROOT}/child-1`,
      "session.jsonl",
      jsonl([{ type: "message", role: "user", content: "orphan" }]),
    );
    expect(
      (await store.openSession("child-1/session.jsonl"))._unsafeUnwrapErr(),
    ).toEqual({
      type: "SessionCorrupt",
      ref: "child-1/session.jsonl",
      reason: "missing-header",
    });
  });

  test("returns SessionCorrupt when the parent link does not match", async () => {
    const { store, create } = harness();
    (await create())._unsafeUnwrap();
    const result = await store.openSession(
      "child-1/session.jsonl",
      "other-parent",
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionCorrupt",
      ref: "child-1/session.jsonl",
      reason: "parent-session-mismatch",
    });
  });

  test("rejects a traversal ref before any storage access", async () => {
    const { store, host } = harness();
    const result = await store.openSession("../escape/session.jsonl");
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "path-escape",
    });
    expect(host.opened).toHaveLength(0);
  });
});

describe("readSessionEntries", () => {
  const liveEntries = Object.freeze([
    { type: "message", role: "user", content: "live" },
    { type: "message", role: "assistant", content: "ok" },
  ]);

  test("returns descriptor-parsed entries for a live session without adapter copies", async () => {
    const { store, fs, host, create } = harness();
    const created = (await create())._unsafeUnwrap();
    await appendSessionBody(
      fs,
      `${ROOT}/child-1`,
      created.ref.slice(created.ref.lastIndexOf("/") + 1),
      jsonl(liveEntries),
    );
    const filesBefore = new Map(fs.files(`${ROOT}/child-1`));
    const openedAfterCreate = host.opened.length;
    const result = (
      await store.readSessionEntries(created.ref, PARENT)
    )._unsafeUnwrap();

    expect(result.record.sessionId).toBe("native-session-1");
    expect(result.entries).toEqual(liveEntries);
    // Reading is descriptor-only: no extra SessionManager.open, and no bytes
    // copied into adapter-owned storage.
    expect(host.opened).toHaveLength(openedAfterCreate);
    expect(fs.files(`${ROOT}/child-1`)).toEqual(filesBefore);
    expect(fs.files(ROOT).has("transcript-copy.jsonl")).toBe(false);
  });

  test("returns descriptor-parsed entries for a historical reopen", async () => {
    const historical = Object.freeze([{ type: "custom", name: "done" }]);
    const { store, fs, create } = harness();
    const created = (await create())._unsafeUnwrap();
    await appendSessionBody(
      fs,
      `${ROOT}/child-1`,
      created.ref.slice(created.ref.lastIndexOf("/") + 1),
      jsonl(historical),
    );
    const first = (
      await store.readSessionEntries("child-1/session.jsonl", PARENT)
    )._unsafeUnwrap();
    const second = (
      await store.readSessionEntries("child-1/session.jsonl", PARENT)
    )._unsafeUnwrap();

    expect(first.entries).toEqual(historical);
    expect(second.entries).toEqual(historical);
    expect(second.record.ref).toBe("child-1/session.jsonl");
  });

  test("maps an unparseable body line to SessionCorrupt", async () => {
    const { store, fs, create } = harness();
    const created = (await create())._unsafeUnwrap();
    await appendSessionBody(
      fs,
      `${ROOT}/child-1`,
      created.ref.slice(created.ref.lastIndexOf("/") + 1),
      "{ broken\n",
    );
    expect(
      (
        await store.readSessionEntries("child-1/session.jsonl", PARENT)
      )._unsafeUnwrapErr(),
    ).toEqual({
      type: "SessionCorrupt",
      ref: "child-1/session.jsonl",
      reason: "unreadable",
    });
  });

  test("returns SessionMissing for an absent historical session", async () => {
    const { store } = harness();
    expect(
      (
        await store.readSessionEntries("child-9/session.jsonl", PARENT)
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionMissing", ref: "child-9/session.jsonl" });
  });

  test("returns SessionCorrupt when the historical header is absent", async () => {
    const { store, fs, create } = harness();
    (await create())._unsafeUnwrap();
    await overwriteSessionFile(
      fs,
      `${ROOT}/child-1`,
      "session.jsonl",
      jsonl(liveEntries),
    );
    expect(
      (
        await store.readSessionEntries("child-1/session.jsonl", PARENT)
      )._unsafeUnwrapErr(),
    ).toEqual({
      type: "SessionCorrupt",
      ref: "child-1/session.jsonl",
      reason: "missing-header",
    });
  });

  test("returns SessionCorrupt when the parent link does not match", async () => {
    const { store, create } = harness();
    (await create())._unsafeUnwrap();
    expect(
      (
        await store.readSessionEntries("child-1/session.jsonl", "other-parent")
      )._unsafeUnwrapErr(),
    ).toEqual({
      type: "SessionCorrupt",
      ref: "child-1/session.jsonl",
      reason: "parent-session-mismatch",
    });
  });
});

describe("listByRef", () => {
  test("returns typed states per ref and never scans the tree", async () => {
    const { store, create } = harness();
    (await create())._unsafeUnwrap();
    const states = (
      await store.listByRef(["child-1/session.jsonl", "child-2/session.jsonl"])
    )._unsafeUnwrap();
    expect(states).toHaveLength(2);
    expect(states[0]?.state).toBe("available");
    expect(states[1]).toEqual({
      state: "missing",
      ref: "child-2/session.jsonl",
    });
  });

  test("reports corrupt refs without failing the whole listing", async () => {
    const { store, fs, create } = harness();
    (await create())._unsafeUnwrap();
    await overwriteSessionFile(
      fs,
      `${ROOT}/child-1`,
      "session.jsonl",
      jsonl([{ type: "message", role: "user", content: "orphan" }]),
    );
    const states = (
      await store.listByRef(["child-1/session.jsonl"])
    )._unsafeUnwrap();
    expect(states[0]).toEqual({
      state: "corrupt",
      ref: "child-1/session.jsonl",
      reason: "missing-header",
    });
  });

  test("bounds the listing by the caller limit", async () => {
    const { store } = harness();
    const refs = Array.from(
      { length: 10 },
      (_, index) => `child-${index}/session.jsonl`,
    );
    expect(
      (await store.listByRef(refs, { limit: 3 }))._unsafeUnwrap(),
    ).toHaveLength(3);
  });

  test("clamps to the hard ceiling regardless of the caller limit", async () => {
    const { store } = harness();
    const refs = Array.from(
      { length: PI_NATIVE_SESSION_LAYOUT.maxListedSessions + 25 },
      (_, index) => `child-${index}/session.jsonl`,
    );
    const states = (
      await store.listByRef(refs, { limit: 10_000 })
    )._unsafeUnwrap();
    expect(states).toHaveLength(PI_NATIVE_SESSION_LAYOUT.maxListedSessions);
  });

  test("marks an unsafe ref unavailable instead of resolving it", async () => {
    const { store } = harness();
    const states = (
      await store.listByRef(["../escape/session.jsonl"])
    )._unsafeUnwrap();
    expect(states[0]?.state).toBe("unavailable");
  });
});

describe("deletion and tombstones", () => {
  test("refuses deletion without the confirmation token", async () => {
    const { store, create } = harness();
    (await create())._unsafeUnwrap();
    const result = await store.deleteSession(RECORD, "wrong-token");
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionConfirmationRequired",
      ref: RECORD.ref,
    });
    expect((await store.openSession(RECORD.ref, PARENT)).isOk()).toBe(true);
    expect((await store.readTombstones())._unsafeUnwrap()).toEqual([]);
  });

  test("deletes with the confirmation token and appends a tombstone", async () => {
    const { store, create } = harness();
    (await create())._unsafeUnwrap();
    const token = nativeSessionDeletionToken(RECORD.ref);
    const tombstone = (
      await store.deleteSession(RECORD, token)
    )._unsafeUnwrap();
    expect(tombstone).toEqual({
      version: 1,
      ref: RECORD.ref,
      childId: "child-1",
      parentSession: PARENT,
      deletedAt: "2026-01-01T00:00:00.000Z",
      reason: "explicit-user-deletion",
    });
    expect(
      (await store.openSession(RECORD.ref, PARENT))._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionMissing", ref: RECORD.ref });
  });

  test("appends without rewriting prior tombstone records", async () => {
    const { store, fs } = harness();
    (await store.appendTombstone(RECORD))._unsafeUnwrap();
    (
      await store.appendTombstone({ ...RECORD, childId: "child-2" })
    )._unsafeUnwrap();
    const raw = fs.files(ROOT).get(PI_NATIVE_SESSION_LAYOUT.tombstoneFile);
    const lines = new TextDecoder()
      .decode(raw ?? new Uint8Array())
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    const ledger = (await store.readTombstones())._unsafeUnwrap();
    expect(ledger.map((entry) => entry.childId)).toEqual([
      "child-1",
      "child-2",
    ]);
  });

  test("reads an empty ledger when nothing was ever deleted", async () => {
    const { store } = harness();
    expect((await store.readTombstones())._unsafeUnwrap()).toEqual([]);
  });

  test("skips malformed tombstone lines without throwing", async () => {
    const { store, fs } = harness();
    (await store.appendTombstone(RECORD))._unsafeUnwrap();
    const directory = (await fs.openDirectory(ROOT, true))._unsafeUnwrap();
    (
      await directory.appendFile(
        PI_NATIVE_SESSION_LAYOUT.tombstoneFile,
        new TextEncoder().encode("not json\n"),
        0o600,
      )
    )._unsafeUnwrap();
    directory.close();
    expect((await store.readTombstones())._unsafeUnwrap()).toHaveLength(1);
  });

  test("refuses to delete through an unsafe ref", async () => {
    const { store } = harness();
    const unsafe = { ...RECORD, ref: "../escape/session.jsonl" };
    const result = await store.deleteSession(
      unsafe,
      nativeSessionDeletionToken(unsafe.ref),
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "path-escape",
    });
  });

  test("confirmation tokens are ref-specific and stable", () => {
    const token = nativeSessionDeletionToken("child-1/session.jsonl");
    expect(token).toBe(nativeSessionDeletionToken("child-1/session.jsonl"));
    expect(token).not.toBe(nativeSessionDeletionToken("child-2/session.jsonl"));
  });
});

describe("default session tree isolation", () => {
  test("the Weave root is disjoint from Pi's default session directory", async () => {
    const root = (
      await resolvePiNativeSessionRoot({
        env: {},
        homeDir: "/home/user",
        trustedRoot: new IdentityPiTrustedDataRootPort(),
      })
    )._unsafeUnwrap();
    expect(
      isDisjointFromDefaultSessionTree(
        root,
        "/home/user/.pi/agent/sessions/-home-user-repo",
      ),
    ).toBe(true);
  });

  test("a root nested in the default tree is reported as visible", () => {
    expect(
      isDisjointFromDefaultSessionTree(
        "/home/user/.pi/agent/sessions/weave",
        "/home/user/.pi/agent/sessions",
      ),
    ).toBe(false);
  });

  test("created sessions live under the Weave root, never the default tree", async () => {
    const { store, host, create } = harness();
    const record = (await create())._unsafeUnwrap();
    expect(record.path.startsWith(`${ROOT}/`)).toBe(true);
    expect(store.sessionRoot()).toBe(ROOT);
    expect(host.created[0]?.dir.startsWith(`${ROOT}/`)).toBe(true);
    expect(
      isDisjointFromDefaultSessionTree(
        store.sessionRoot(),
        "/home/user/.pi/agent/sessions",
      ),
    ).toBe(true);
  });
});
