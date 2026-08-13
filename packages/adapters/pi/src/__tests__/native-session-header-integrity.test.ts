import { describe, expect, test } from "bun:test";

import {
  type PiNativeSessionFsPort,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import { validatePiNativeSessionHeader } from "../native-session-header.js";
import {
  createPiNativeSessionHost,
  type PiSessionManagerInstance,
} from "../native-session-host.js";

const SUPPORTED_HEADER = {
  type: "session",
  version: 3,
  id: "pi-session-1",
  timestamp: "2026-08-11T00:00:00.000Z",
  cwd: "/repo",
  parentSession: "parent-session-1",
} as const;

/**
 * Reads one header through the production host adapter. The adapter is the
 * only place a host header is copied, so this is exactly the path the
 * deferred-header bridge persists from.
 */
function readHeader(header: unknown): unknown {
  const instance = {
    getSessionId: () => "pi-session-1",
    getSessionFile: () => "/data/weave/sessions/child-1/pi.jsonl",
    getSessionDir: () => "/data/weave/sessions/child-1",
    getHeader: () =>
      header as ReturnType<PiSessionManagerInstance["getHeader"]>,
    getEntries: () => [],
    isPersisted: () => true,
    getLeafId: () => null,
    appendCustomEntry: () => "entry-1",
  } satisfies PiSessionManagerInstance;
  return createPiNativeSessionHost({
    create: () => instance,
    open: () => instance,
  })
    .create("/repo", "/data/weave/sessions/child-1", {})
    .getHeader();
}

describe("Pi v3 header integrity", () => {
  test("preserves the exact supported header, byte for byte, in the host's own key order", () => {
    const reordered = {
      id: "pi-session-1",
      cwd: "/repo",
      type: "session",
      version: 3,
      timestamp: "2026-08-11T00:00:00.000Z",
      parentSession: "parent-session-1",
    };

    expect(JSON.stringify(readHeader(SUPPORTED_HEADER))).toBe(
      JSON.stringify(SUPPORTED_HEADER),
    );
    // Serialization must follow the host, not an adapter-chosen order, or the
    // persisted bytes would differ from the header Pi generated.
    expect(JSON.stringify(readHeader(reordered))).toBe(
      JSON.stringify(reordered),
    );
  });

  test("accepts a root header that omits the optional parent link", () => {
    const { parentSession: _parentSession, ...root } = SUPPORTED_HEADER;

    expect(JSON.stringify(readHeader(root))).toBe(JSON.stringify(root));
  });

  test("rejects an unknown field instead of silently dropping it", () => {
    expect(
      readHeader({ ...SUPPORTED_HEADER, injected: "must-not-persist" }),
    ).toBeNull();
    // An own `__proto__` data key is an unknown field like any other.
    expect(
      readHeader(
        Object.defineProperty({ ...SUPPORTED_HEADER }, "__proto__", {
          value: { polluted: true },
          enumerable: true,
          configurable: true,
          writable: true,
        }),
      ),
    ).toBeNull();
    expect(readHeader({ ...SUPPORTED_HEADER, "constructor ": "x" })).toBeNull();
  });

  test("rejects an inherited supported field that is not an own property", () => {
    const inherited = Object.create({
      type: "session",
      version: 3,
      id: "pi-session-1",
      timestamp: "2026-08-11T00:00:00.000Z",
      cwd: "/repo",
    }) as Record<string, unknown>;

    expect(readHeader(inherited)).toBeNull();
  });

  test("rejects accessor and non-data descriptors on supported fields", () => {
    const accessor = Object.defineProperties(
      {},
      {
        type: { value: "session", enumerable: true },
        version: { value: 3, enumerable: true },
        id: {
          get: () => "pi-session-1",
          enumerable: true,
        },
        timestamp: {
          value: "2026-08-11T00:00:00.000Z",
          enumerable: true,
        },
        cwd: { value: "/repo", enumerable: true },
      },
    );

    expect(readHeader(accessor)).toBeNull();
  });

  test("rejects a symbol-keyed field", () => {
    const symbolKeyed = {
      ...SUPPORTED_HEADER,
      [Symbol.for("weave.injected")]: "must-not-persist",
    };

    expect(readHeader(symbolKeyed)).toBeNull();
  });

  test("rejects a missing required field", () => {
    for (const field of ["type", "version", "id", "timestamp", "cwd"]) {
      const partial: Record<string, unknown> = { ...SUPPORTED_HEADER };
      delete partial[field];
      expect(readHeader(partial)).toBeNull();
      expect(
        readHeader({ ...SUPPORTED_HEADER, [field]: undefined }),
      ).toBeNull();
    }
  });

  test("rejects wrong types, wrong version, empty and hostile string values", () => {
    const hostile: readonly Record<string, unknown>[] = [
      { type: "fork" },
      { type: 3 },
      { version: 2 },
      { version: "3" },
      { id: "" },
      { id: 1 },
      { cwd: "" },
      { timestamp: "" },
      { timestamp: "2026-08-11T00:00:00.000Z\u0000extra" },
      { cwd: "x".repeat(4_097) },
      { parentSession: "" },
      { parentSession: 7 },
    ];

    for (const overrides of hostile) {
      expect({
        overrides,
        header: readHeader({ ...SUPPORTED_HEADER, ...overrides }),
      }).toEqual({ overrides, header: null });
    }
  });

  test("rejects a non-object header value", () => {
    for (const value of ["header", 3, true, []]) {
      expect(readHeader(value)).toBeNull();
    }
  });
});

describe("one strict validator guards every lifecycle path", () => {
  const ROOT = "/data/weave/adapters/pi/sessions";
  const PARENT = "parent-session-1";
  const REF = "child-1/session.jsonl";

  function readOnlyStore(fs: MemoryPiNativeSessionFs): PiNativeSessionStore {
    return new PiNativeSessionStore({
      root: ROOT,
      launch: { mode: "read-only" },
      fs: fs as unknown as PiNativeSessionFsPort,
      host: {
        create: () => {
          throw new Error("host.create must not run on a read path");
        },
        open: () => {
          throw new Error("host.open must not run on a read path");
        },
      },
    });
  }

  async function seed(headerLine: string): Promise<MemoryPiNativeSessionFs> {
    const fs = new MemoryPiNativeSessionFs();
    const directory = (
      await fs.openDirectory(`${ROOT}/child-1`, true)
    )._unsafeUnwrap();
    (
      await directory.appendFile(
        "session.jsonl",
        new TextEncoder().encode(`${headerLine}\n`),
        0o600,
      )
    )._unsafeUnwrap();
    directory.close();
    return fs;
  }

  test("rejects a non-enumerable own field a key walk would miss", () => {
    const hidden = Object.defineProperty({ ...SUPPORTED_HEADER }, "toJSON", {
      value: () => ({ type: "session" }),
      enumerable: false,
    });

    expect(Object.keys(hidden)).not.toContain("toJSON");
    expect(readHeader(hidden)).toBeNull();
    expect(validatePiNativeSessionHeader(hidden).isErr()).toBe(true);
  });

  test("rejects an exotic prototype even when every field is right", () => {
    class HostileHeader {
      type = "session";
      version = 3;
      id = "pi-session-1";
      timestamp = "2026-08-11T00:00:00.000Z";
      cwd = "/repo";
      parentSession = PARENT;
    }

    expect(validatePiNativeSessionHeader(new HostileHeader()).isErr()).toBe(
      true,
    );
    expect(
      validatePiNativeSessionHeader(
        Object.assign(Object.create({ evil: true }), SUPPORTED_HEADER),
      ).isErr(),
    ).toBe(true);
  });

  test("rejects a timestamp the host could not have generated", () => {
    for (const timestamp of [
      "2026-08-11T00:00:00Z",
      "2026-08-11",
      "2026-13-40T00:00:00.000Z",
      "not-a-time",
    ]) {
      expect(
        validatePiNativeSessionHeader({
          ...SUPPORTED_HEADER,
          timestamp,
        })._unsafeUnwrapErr(),
      ).toBe("invalid-timestamp");
    }
  });

  test("returns a frozen copy a caller cannot mutate after validation", () => {
    const validated = validatePiNativeSessionHeader(
      SUPPORTED_HEADER,
    )._unsafeUnwrap() as { cwd: string };

    expect(() => {
      validated.cwd = "/hostile";
    }).toThrow();
  });

  test("refuses an incomplete on-disk header on the descriptor read path", async () => {
    const incomplete = await seed(
      JSON.stringify({
        type: "session",
        id: "pi-session-1",
        parentSession: PARENT,
      }),
    );

    expect(
      (
        await readOnlyStore(incomplete).readSessionEntries(REF, PARENT)
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionCorrupt", ref: REF, reason: "missing-header" });
  });

  test("refuses an unknown on-disk header field on the descriptor read path", async () => {
    const injected = await seed(
      JSON.stringify({ ...SUPPORTED_HEADER, parentSession: PARENT, x: 1 }),
    );

    expect(
      (
        await readOnlyStore(injected).openSession(REF, PARENT)
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionCorrupt", ref: REF, reason: "missing-header" });
  });

  test("refuses the same header on the bounded paging path", async () => {
    const injected = await seed(
      JSON.stringify({ ...SUPPORTED_HEADER, parentSession: PARENT, x: 1 }),
    );

    const page = await readOnlyStore(injected).readSessionEntryPage(
      REF,
      PARENT,
      { direction: "newest" },
    );

    expect(page._unsafeUnwrapErr()).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "missing-header",
    });
  });

  test("refuses a partial header reported by the host on reopen", async () => {
    const fs = await seed(
      JSON.stringify({ ...SUPPORTED_HEADER, parentSession: PARENT }),
    );
    const store = new PiNativeSessionStore({
      root: ROOT,
      launch: { mode: "read-only" },
      fs: fs as unknown as PiNativeSessionFsPort,
      host: {
        create: () => {
          throw new Error("unused");
        },
        // A host that reports a v3-looking header without `cwd`/`timestamp`.
        open: () => ({
          getSessionId: () => "pi-session-1",
          getSessionFile: () => `${ROOT}/${REF}`,
          getSessionDir: () => `${ROOT}/child-1`,
          getHeader: () =>
            ({
              type: "session",
              version: 3,
              id: "pi-session-1",
              parentSession: PARENT,
            }) as never,
          getEntries: () => [],
          isPersisted: () => true,
          getLeafId: () => "leaf-1",
          appendCustomEntry: () => "entry-1",
        }),
      },
    });

    const result = await store.establishThreadLeaf(
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

    expect(result._unsafeUnwrapErr()).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "missing-header",
    });
  });
});
