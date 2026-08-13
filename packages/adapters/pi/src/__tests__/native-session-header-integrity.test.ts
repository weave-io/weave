import { describe, expect, test } from "bun:test";

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
