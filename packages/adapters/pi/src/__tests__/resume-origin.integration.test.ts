import { describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import {
  type PiChildRefAppendPort,
  type PiChildRefEntryReadPort,
  type PiChildRefSourceAuthority,
  PiChildSessionRefStore,
} from "../child-session-refs.js";
import {
  type PiParentSessionState,
  PiPrimarySession,
} from "../primary-session.js";
import { PiSkillCatalog } from "../skill-catalog.js";
import type { PiSessionManagerPort } from "../types.js";
import { RecordingLogger } from "./fakes/fake-pi-host.js";
import { TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

// ---------------------------------------------------------------------------
// Durable session-file fixture
//
// These tests exercise the *integration* between the host session probe
// (`PiPrimarySession` -> `probeParentSession`) and the ref reader
// (`PiChildSessionRefStore`), because resume-origin correctness is only
// observable where the two meet: the probed identity becomes the ref store's
// origin authority, and the ref reader filters on it.
//
// The fixture models the one fact the real regression turned on: a Pi session
// file carries a stable `header.id`, while the manager's *runtime* session id
// is minted per process and differs after a restart.
// ---------------------------------------------------------------------------

interface SessionFile {
  /** The persisted header. `undefined` models a host exposing no header. */
  header: unknown;
  /** Appended custom entries, as Pi's `getEntries()` would return them. */
  readonly entries: unknown[];
}

function newSessionFile(headerId: string, parentSession?: string): SessionFile {
  return {
    header: {
      type: "session",
      id: headerId,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/w",
      ...(parentSession === undefined ? {} : { parentSession }),
    },
    entries: [],
  };
}

/**
 * Forks a session file the way Pi does: the entries are carried over, and a
 * *new* header id is minted while the source is recorded in `parentSession`.
 */
function forkSessionFile(source: SessionFile, headerId: string): SessionFile {
  return {
    header: {
      type: "session",
      id: headerId,
      timestamp: "2026-01-02T00:00:00.000Z",
      cwd: "/w",
      parentSession: "/sessions/source.jsonl",
    },
    entries: [...source.entries],
  };
}

interface RuntimeOptions {
  /** Freshly minted per process, exactly as the real host behaves. */
  readonly runtimeId: string;
  readonly file?: SessionFile;
  readonly path?: string;
  /** Model a host whose header probe throws. */
  readonly headerThrows?: boolean;
  /** Model an older host that exposes no `getHeader` at all. */
  readonly omitGetHeader?: boolean;
}

/**
 * One process lifetime over a session file: a session manager double shaped
 * like Pi's public `SessionManager` surface, plus the append/read ports the
 * ref store binds to.
 */
function openRuntime(options: RuntimeOptions) {
  const file = options.file ?? newSessionFile("header-default");
  const path = options.path ?? "/sessions/a.jsonl";

  const manager: PiSessionManagerPort = {
    getSessionId: () => options.runtimeId,
    getSessionFile: () => path,
    isPersisted: () => true,
    ...(options.omitGetHeader === true
      ? {}
      : {
          getHeader: () => {
            if (options.headerThrows === true) {
              throw new Error("header read exploded");
            }
            return file.header as { id?: unknown } | null;
          },
        }),
  };

  const append: PiChildRefAppendPort = {
    appendEntry: (customType, data) => {
      file.entries.push({ type: "custom", customType, data });
    },
  };
  const read: PiChildRefEntryReadPort = {
    getEntries: () => file.entries,
  };

  const session = new PiPrimarySession({
    skillCatalog: new PiSkillCatalog(),
    logger: new RecordingLogger(),
    parentSessionProbe: manager,
  });

  return { file, manager, append, read, session, path };
}

const availableAuthority: PiChildRefSourceAuthority = {
  checkSource: () => okAsync("available"),
};

/**
 * Builds the ref store exactly as the extension does: origin authority is the
 * probed parent `sessionId`, never the runtime id and never a caller-chosen
 * value.
 */
function refStoreFor(
  runtime: ReturnType<typeof openRuntime>,
): PiChildSessionRefStore {
  const parent = runtime.session.getParentSession();
  if (parent.persistence !== "persistent") {
    throw new Error(`expected persistent parent, got ${parent.persistence}`);
  }
  return new PiChildSessionRefStore({
    storage: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    parentSessionId: parent.sessionId,
    append: runtime.append,
    read: runtime.read,
    authority: availableAuthority,
  });
}

async function visibleChildIds(
  store: PiChildSessionRefStore,
): Promise<readonly string[]> {
  // Scan order is an implementation detail of the reader; identity is what
  // these tests assert, so compare as a stable set.
  return store.readRefs().match(
    (scan) => [...scan.refs.map((ref) => ref.childId)].sort(),
    (error) => {
      throw new Error(`readRefs failed: ${error.type}`);
    },
  );
}

async function seedChild(
  store: PiChildSessionRefStore,
  childId: string,
): Promise<void> {
  await store
    .appendNewChild({
      childId,
      nativeSessionId: `native-${childId}`,
      sessionRef: `${childId}/session.jsonl`,
      title: `work for ${childId}`,
    })
    .match(
      () => undefined,
      (error) => {
        throw new Error(`appendNewChild failed: ${error.type}`);
      },
    );
}

// ---------------------------------------------------------------------------
// 1. Resume: same file/header, different runtime id
// ---------------------------------------------------------------------------

describe("resume origin: same session file under a new runtime id", () => {
  test("resolves the refs the session itself wrote before the restart", async () => {
    const file = newSessionFile("header-stable");

    const first = openRuntime({ runtimeId: "runtime-boot-1", file });
    const firstStore = refStoreFor(first);
    await seedChild(firstStore, "child-1");
    await seedChild(firstStore, "child-2");
    expect(await visibleChildIds(firstStore)).toEqual(["child-1", "child-2"]);

    // Restart: same durable file, brand-new ephemeral runtime id. This is the
    // exact shape that regressed - the runtime id no longer matches the id
    // historical refs were written against.
    const resumed = openRuntime({ runtimeId: "runtime-boot-2", file });
    const resumedParent = resumed.session.getParentSession();
    expect(resumedParent).toEqual({
      persistence: "persistent",
      sessionId: "header-stable",
      runtimeSessionId: "runtime-boot-2",
      identitySource: "session-header",
      sessionFile: "/sessions/a.jsonl",
    } satisfies PiParentSessionState);

    const resumedStore = refStoreFor(resumed);
    expect(await visibleChildIds(resumedStore)).toEqual(["child-1", "child-2"]);

    const scan = await resumedStore.readRefs().match(
      (value) => value,
      (error) => {
        throw new Error(error.type);
      },
    );
    expect(scan.counts.originMismatchedChildren).toBe(0);
    expect(scan.issues).toEqual([]);
  });

  test("still writes new refs under the stable header origin, not the runtime id", async () => {
    const file = newSessionFile("header-stable");
    const first = openRuntime({ runtimeId: "runtime-boot-1", file });
    await seedChild(refStoreFor(first), "child-1");

    const resumed = openRuntime({ runtimeId: "runtime-boot-2", file });
    const resumedStore = refStoreFor(resumed);
    expect(resumedStore.liveParentSessionId()).toBe("header-stable");
    await seedChild(resumedStore, "child-3");

    // A third boot sees both generations: one origin, never two.
    const third = openRuntime({ runtimeId: "runtime-boot-3", file });
    expect(await visibleChildIds(refStoreFor(third))).toEqual([
      "child-1",
      "child-3",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Fork/clone: new header id over imported entries
// ---------------------------------------------------------------------------

describe("fork origin: a new header id excludes imported source refs", () => {
  test("excludes every ref carried over from the source session", async () => {
    const source = newSessionFile("header-source");
    const sourceRuntime = openRuntime({
      runtimeId: "runtime-src",
      file: source,
    });
    await seedChild(refStoreFor(sourceRuntime), "child-source");
    expect(source.entries.length).toBe(1);

    const forked = forkSessionFile(source, "header-fork");
    const forkRuntime = openRuntime({
      runtimeId: "runtime-fork",
      file: forked,
      path: "/sessions/fork.jsonl",
    });

    const forkParent = forkRuntime.session.getParentSession();
    expect(
      forkParent.persistence === "persistent" && forkParent.sessionId,
    ).toBe("header-fork");

    const forkStore = refStoreFor(forkRuntime);
    // The imported entry is present in the file but is not this session's.
    expect(await visibleChildIds(forkStore)).toEqual([]);

    const scan = await forkStore.readRefs().match(
      (value) => value,
      (error) => {
        throw new Error(error.type);
      },
    );
    expect(scan.counts.originMismatchedChildren).toBe(1);
    expect(scan.issues).toContainEqual({
      kind: "origin-mismatch",
      childId: "child-source",
    });
  });

  test("a fork's own refs stay separate from the source session's view", async () => {
    const source = newSessionFile("header-source");
    const sourceRuntime = openRuntime({
      runtimeId: "runtime-src",
      file: source,
    });
    const sourceStore = refStoreFor(sourceRuntime);
    await seedChild(sourceStore, "child-source");

    const forked = forkSessionFile(source, "header-fork");
    const forkRuntime = openRuntime({
      runtimeId: "runtime-fork",
      file: forked,
      path: "/sessions/fork.jsonl",
    });
    await seedChild(refStoreFor(forkRuntime), "child-fork");

    // The source never gains the fork's children, and the fork never gains
    // the source's. Exactly one origin is honoured on each side.
    expect(await visibleChildIds(sourceStore)).toEqual(["child-source"]);
    expect(await visibleChildIds(refStoreFor(forkRuntime))).toEqual([
      "child-fork",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. A genuinely new session inherits nothing
// ---------------------------------------------------------------------------

describe("new session origin", () => {
  test("does not inherit refs from any prior session", async () => {
    const previous = newSessionFile("header-previous");
    await seedChild(
      refStoreFor(openRuntime({ runtimeId: "runtime-prev", file: previous })),
      "child-previous",
    );

    const fresh = openRuntime({
      runtimeId: "runtime-new",
      file: newSessionFile("header-new"),
      path: "/sessions/new.jsonl",
    });
    expect(await visibleChildIds(refStoreFor(fresh))).toEqual([]);
  });

  test("a new session that reuses a prior file path still uses its own header", async () => {
    const previous = newSessionFile("header-previous");
    await seedChild(
      refStoreFor(openRuntime({ runtimeId: "runtime-prev", file: previous })),
      "child-previous",
    );

    // Same path, different session file identity: origin follows the header,
    // never the path.
    const replaced = openRuntime({
      runtimeId: "runtime-prev",
      file: newSessionFile("header-replacement"),
      path: "/sessions/a.jsonl",
    });
    expect(refStoreFor(replaced).liveParentSessionId()).toBe(
      "header-replacement",
    );
    expect(await visibleChildIds(refStoreFor(replaced))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Absent / invalid header: bounded runtime fallback only
// ---------------------------------------------------------------------------

describe("header fallback is bounded to the live runtime identity", () => {
  const invalidHeaders: ReadonlyArray<readonly [string, unknown]> = [
    ["absent header", null],
    ["undefined header", undefined],
    ["non-object header", "header-stable"],
    ["empty id", { type: "session", id: "" }],
    ["non-string id", { type: "session", id: 7 }],
    ["oversized id", { type: "session", id: "x".repeat(257) }],
  ];

  for (const [name, header] of invalidHeaders) {
    test(`falls back to the runtime id for ${name}`, async () => {
      const file: SessionFile = { header, entries: [] };
      const runtime = openRuntime({ runtimeId: "runtime-only-1", file });
      const parent = runtime.session.getParentSession();
      expect(parent).toEqual({
        persistence: "persistent",
        sessionId: "runtime-only-1",
        runtimeSessionId: "runtime-only-1",
        identitySource: "runtime",
        sessionFile: "/sessions/a.jsonl",
      } satisfies PiParentSessionState);

      // The fallback is usable *within* this runtime.
      const store = refStoreFor(runtime);
      await seedChild(store, "child-1");
      expect(await visibleChildIds(store)).toEqual(["child-1"]);
    });
  }

  test("a host with no getHeader at all keeps the runtime identity", () => {
    const runtime = openRuntime({
      runtimeId: "runtime-legacy",
      omitGetHeader: true,
    });
    expect(runtime.session.getParentSession()).toEqual({
      persistence: "persistent",
      sessionId: "runtime-legacy",
      runtimeSessionId: "runtime-legacy",
      identitySource: "runtime",
      sessionFile: "/sessions/a.jsonl",
    } satisfies PiParentSessionState);
  });

  test("the runtime fallback never adopts a prior origin across restarts", async () => {
    // Without a usable header there is no stable persisted authority, so the
    // safe answer is to see nothing rather than to guess an old origin.
    const file: SessionFile = { header: null, entries: [] };
    const first = openRuntime({ runtimeId: "runtime-only-1", file });
    await seedChild(refStoreFor(first), "child-1");

    const second = openRuntime({ runtimeId: "runtime-only-2", file });
    const secondStore = refStoreFor(second);
    expect(secondStore.liveParentSessionId()).toBe("runtime-only-2");
    expect(await visibleChildIds(secondStore)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Throwing header probe fails closed
// ---------------------------------------------------------------------------

describe("throwing header probe", () => {
  test("yields unknown persistence and never fabricates an origin", () => {
    const runtime = openRuntime({
      runtimeId: "runtime-boom",
      headerThrows: true,
    });
    expect(runtime.session.getParentSession()).toEqual({
      persistence: "unknown",
      reason: "probe-failed",
    } satisfies PiParentSessionState);
  });

  test("blocks every child-owning mutation, so no ref store is ever built", () => {
    const runtime = openRuntime({
      runtimeId: "runtime-boom",
      headerThrows: true,
    });
    for (const operation of [
      "delegate",
      "steer",
      "follow-up",
      "retry",
      "continue",
      "delete",
    ] as const) {
      expect(runtime.session.requirePersistentParent(operation).isErr()).toBe(
        true,
      );
    }
    expect(() => refStoreFor(runtime)).toThrow(/expected persistent parent/);
  });

  test("a later successful probe recovers without inheriting anything", async () => {
    const file = newSessionFile("header-stable");
    const throwing = openRuntime({
      runtimeId: "runtime-boom",
      file,
      headerThrows: true,
    });
    expect(throwing.session.getParentSession().persistence).toBe("unknown");

    const healthy = openRuntime({ runtimeId: "runtime-ok", file });
    const store = refStoreFor(healthy);
    expect(store.liveParentSessionId()).toBe("header-stable");
    expect(await visibleChildIds(store)).toEqual([]);
  });
});
