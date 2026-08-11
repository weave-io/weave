import { describe, expect, it } from "bun:test";
import {
  type PiNativeSessionHeader,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import {
  createPiNativeSessionHost,
  type PiSessionManagerInstance,
  type PiSessionManagerStatic,
} from "../native-session-host.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const CHILD_ID = "child-1";
const CHILD_DIR = `${ROOT}/${CHILD_ID}`;
const SESSION_FILE = `${CHILD_DIR}/pi-generated.jsonl`;
const SESSION_ID = "pi-session-1";
const PARENT_SESSION = "parent-session-1";
const CWD = "/repo";
const HEADER_BYTES =
  '{"type":"session","version":3,"id":"pi-session-1","timestamp":"2026-08-11T00:00:00.000Z","cwd":"/repo","parentSession":"parent-session-1"}\n';

const GENERATED_HEADER: PiNativeSessionHeader = {
  type: "session",
  version: 3,
  id: SESSION_ID,
  timestamp: "2026-08-11T00:00:00.000Z",
  cwd: CWD,
  parentSession: PARENT_SESSION,
};

type IdentityGetterCalls = {
  sessionFile: number;
  sessionDir: number;
  sessionId: number;
  header: number;
  persisted: number;
};

class ScriptedSessionManagerHandle implements PiSessionManagerInstance {
  readonly calls: IdentityGetterCalls = {
    sessionFile: 0,
    sessionDir: 0,
    sessionId: 0,
    header: 0,
    persisted: 0,
  };

  constructor(
    private readonly sessionFile: string,
    private readonly sessionDir: string,
    private readonly sessionId: string,
    private readonly header: PiNativeSessionHeader,
  ) {}

  getSessionId(): string {
    this.calls.sessionId += 1;
    return this.sessionId;
  }

  getSessionFile(): string {
    this.calls.sessionFile += 1;
    return this.sessionFile;
  }

  getSessionDir(): string {
    this.calls.sessionDir += 1;
    return this.sessionDir;
  }

  getHeader(): PiNativeSessionHeader {
    this.calls.header += 1;
    return this.header;
  }

  getEntries(): readonly unknown[] {
    return [];
  }

  isPersisted(): boolean {
    this.calls.persisted += 1;
    return true;
  }

  getLeafId(): string | null {
    return null;
  }

  appendCustomEntry(): string {
    return "unused-entry";
  }
}

class ScriptedSessionManager implements PiSessionManagerStatic {
  readonly createCalls: Array<{
    cwd: string;
    sessionDir: string;
    options?: { parentSession?: string };
  }> = [];
  readonly openCalls: Array<{ sessionFile: string; sessionDir?: string }> = [];
  createdHandle: ScriptedSessionManagerHandle | undefined;
  openedHandle: ScriptedSessionManagerHandle | undefined;

  create(
    cwd: string,
    sessionDir: string,
    options?: { parentSession?: string },
  ): PiSessionManagerInstance {
    this.createCalls.push({ cwd, sessionDir, options });
    this.createdHandle = new ScriptedSessionManagerHandle(
      SESSION_FILE,
      sessionDir,
      SESSION_ID,
      GENERATED_HEADER,
    );
    return this.createdHandle;
  }

  open(sessionFile: string, sessionDir?: string): PiSessionManagerInstance {
    this.openCalls.push({ sessionFile, sessionDir });
    this.openedHandle = new ScriptedSessionManagerHandle(
      sessionFile,
      sessionDir ?? CHILD_DIR,
      SESSION_ID,
      GENERATED_HEADER,
    );
    return this.openedHandle;
  }
}

function allIdentityGettersWereRead(
  handle: ScriptedSessionManagerHandle | undefined,
): boolean {
  return (
    handle !== undefined &&
    Object.values(handle.calls).every((callCount) => callCount > 0)
  );
}

function makeHarness(): {
  fs: MemoryPiNativeSessionFs;
  manager: ScriptedSessionManager;
  store: PiNativeSessionStore;
} {
  const fs = new MemoryPiNativeSessionFs();
  const manager = new ScriptedSessionManager();
  const store = new PiNativeSessionStore({
    root: ROOT,
    fs,
    host: createPiNativeSessionHost(manager),
    now: () => new Date("2026-08-11T00:00:00.000Z"),
  });
  return { fs, manager, store };
}

async function createChildSession(store: PiNativeSessionStore) {
  return await store.createChildSession({
    childId: CHILD_ID,
    parentSession: PARENT_SESSION,
    cwd: CWD,
  });
}

describe("Pi-native deferred-header session contract", () => {
  it("persists Pi's exact generated header and revalidates the reopened identity", async () => {
    const { fs, manager, store } = makeHarness();

    const result = await createChildSession(store);
    const storedBytes = fs.files(CHILD_DIR).get("pi-generated.jsonl");

    expect({
      result: result.isOk()
        ? {
            sessionId: result.value.sessionId,
            ref: result.value.ref,
            parentSession: result.value.parentSession,
            cwd: result.value.cwd,
          }
        : result.error,
      createCalls: manager.createCalls,
      openCalls: manager.openCalls,
      exactHeaderBytes:
        storedBytes === undefined
          ? undefined
          : new TextDecoder().decode(storedBytes),
      createIdentityRead: allIdentityGettersWereRead(manager.createdHandle),
      openIdentityRead: allIdentityGettersWereRead(manager.openedHandle),
    }).toEqual({
      result: {
        sessionId: SESSION_ID,
        ref: "child-1/pi-generated.jsonl",
        parentSession: PARENT_SESSION,
        cwd: CWD,
      },
      createCalls: [
        {
          cwd: CWD,
          sessionDir: CHILD_DIR,
          options: { parentSession: PARENT_SESSION },
        },
      ],
      openCalls: [{ sessionFile: SESSION_FILE, sessionDir: CHILD_DIR }],
      exactHeaderBytes: HEADER_BYTES,
      createIdentityRead: true,
      openIdentityRead: true,
    });
  });

  it("rejects an occupied Pi-generated leaf before reopen or launch handoff", async () => {
    const { fs, manager, store } = makeHarness();
    const directory = (await fs.openDirectory(CHILD_DIR, true))._unsafeUnwrap();
    (
      await directory.appendFile(
        "pi-generated.jsonl",
        new TextEncoder().encode("occupied\n"),
        0o600,
      )
    )._unsafeUnwrap();
    directory.close();

    const result = await createChildSession(store);
    const storedBytes = fs.files(CHILD_DIR).get("pi-generated.jsonl");

    expect({
      result: result.isErr() ? result.error : "unexpected-success",
      createCalls: manager.createCalls.length,
      openCalls: manager.openCalls.length,
      preservedCollisionBytes:
        storedBytes === undefined
          ? undefined
          : new TextDecoder().decode(storedBytes),
    }).toEqual({
      result: { type: "SessionCreateFailed", reason: "collision" },
      createCalls: 1,
      openCalls: 0,
      preservedCollisionBytes: "occupied\n",
    });
  });
});
