/**
 * Adversarial coverage for the host-backed reopen path of
 * `PiNativeSessionStore` (Spec 33 path-session design §5.2–5.3).
 *
 * `SessionManager.open` returns a handle whose identity getters are host
 * code. Validating only the header leaves `getSessionId`, `getSessionFile`,
 * `getSessionDir`, and `isPersisted` unchecked, so a host could hand back a
 * record that names a different file, a different directory, or a different
 * session than the one this store proved on disk. Every identity surface is
 * read behind one throw boundary and must agree exactly with the proven
 * root/dir/file/ref/session/header before a record is granted.
 */

import { describe, expect, test } from "bun:test";

import {
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";

const ROOT = "/data/weave/sessions";
const PARENT = "parent-session-1";
const REF = "child-1/session.jsonl";
const CHILD_DIR = `${ROOT}/child-1`;
const SESSION_PATH = `${ROOT}/${REF}`;

const SUPPORTED_HEADER = {
  type: "session",
  version: 3,
  id: "pi-session-1",
  timestamp: "2026-08-11T00:00:00.000Z",
  cwd: "/repo",
  parentSession: PARENT,
} as const;

interface HostileHandleOverrides {
  readonly sessionId?: () => string;
  readonly sessionFile?: () => string | undefined;
  readonly sessionDir?: () => string;
  readonly persisted?: () => boolean;
}

function hostileHandle(
  overrides: HostileHandleOverrides = {},
): PiNativeSessionHandle {
  return {
    getSessionId: overrides.sessionId ?? (() => SUPPORTED_HEADER.id),
    getSessionFile: overrides.sessionFile ?? (() => SESSION_PATH),
    getSessionDir: overrides.sessionDir ?? (() => CHILD_DIR),
    getHeader: () => ({ ...SUPPORTED_HEADER }),
    getEntries: () => [],
    isPersisted: overrides.persisted ?? (() => true),
    getLeafId: () => "leaf-1",
    appendCustomEntry: () => "entry-1",
  };
}

async function seedStore(
  handle: PiNativeSessionHandle,
): Promise<PiNativeSessionStore> {
  const fs = new MemoryPiNativeSessionFs();
  const directory = (await fs.openDirectory(CHILD_DIR, true))._unsafeUnwrap();
  (
    await directory.appendFile(
      "session.jsonl",
      new TextEncoder().encode(`${JSON.stringify(SUPPORTED_HEADER)}\n`),
      0o600,
    )
  )._unsafeUnwrap();
  directory.close();
  return new PiNativeSessionStore({
    root: ROOT,
    launch: { mode: "read-only" },
    fs: fs as unknown as PiNativeSessionFsPort,
    host: {
      create: () => {
        throw new Error("create must not run on a reopen path");
      },
      open: () => handle,
    },
  });
}

function establish(store: PiNativeSessionStore) {
  return store.establishThreadLeaf(
    REF,
    {
      threadId: "thread-1",
      agentName: "shuttle",
      parentId: "parent-1",
      parentAgentName: "loom",
      parentDepth: 0,
      ownerParentSessionId: PARENT,
      cwd: "/repo",
      createdAt: 0,
    },
    PARENT,
  );
}

describe("host-backed reopen validates every identity surface", () => {
  test("a truthful host still reopens", async () => {
    const result = await establish(await seedStore(hostileHandle()));

    expect(result._unsafeUnwrap().record.ref).toBe(REF);
  });

  test("a host that reports another session file fails closed", async () => {
    const store = await seedStore(
      hostileHandle({ sessionFile: () => `${ROOT}/child-2/session.jsonl` }),
    );

    expect((await establish(store))._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "path-escape",
    });
  });

  test("a host that reports no session file fails closed", async () => {
    const store = await seedStore(
      hostileHandle({ sessionFile: () => undefined }),
    );

    expect((await establish(store))._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "path-escape",
    });
  });

  test("a host that reports another session directory fails closed", async () => {
    const store = await seedStore(
      hostileHandle({ sessionDir: () => `${ROOT}/child-2` }),
    );

    expect((await establish(store))._unsafeUnwrapErr()).toEqual({
      type: "SessionRootViolation",
      reason: "path-escape",
    });
  });

  test("a host that reports a session id the header contradicts fails closed", async () => {
    const store = await seedStore(
      hostileHandle({ sessionId: () => "pi-session-2" }),
    );

    expect((await establish(store))._unsafeUnwrapErr()).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });

  test("a host that reports an unpersisted session fails closed", async () => {
    const store = await seedStore(hostileHandle({ persisted: () => false }));

    expect((await establish(store))._unsafeUnwrapErr()).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "not-persisted",
    });
  });

  test.each([
    ["getSessionId", { sessionId: () => raise() }],
    ["getSessionFile", { sessionFile: () => raise() }],
    ["getSessionDir", { sessionDir: () => raise() }],
    ["isPersisted", { persisted: () => raise() }],
  ] as const)("a throwing %s is a typed failure", async (_name, overrides) => {
    const store = await seedStore(
      hostileHandle(overrides as HostileHandleOverrides),
    );

    expect((await establish(store))._unsafeUnwrapErr()).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });

  test("a throwing getHeader is a typed failure", async () => {
    const handle: PiNativeSessionHandle = {
      ...hostileHandle(),
      getHeader: () => raise(),
    };

    expect(
      (await establish(await seedStore(handle)))._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionCorrupt", ref: REF, reason: "unreadable" });
  });
});

function raise(): never {
  throw new Error("hostile getter");
}
