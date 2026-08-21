/**
 * Native session leaf-id fallback error handling.
 *
 * Task 11 review blocker D: when `appendCustomEntry` returned no usable id,
 * `establishThreadLeaf` called the host's optional `getLeafId()` bare, outside
 * any neverthrow boundary. A throwing host getter therefore escaped as an
 * exception through a `ResultAsync` chain instead of becoming a typed session
 * error, and the caller's cleanup was skipped.
 *
 * These tests pin both paths: a throwing fallback getter becomes the same
 * typed, path-free session error as any other unreadable leaf, and a normal
 * fallback getter still supplies the leaf id.
 */

import { describe, expect, test } from "bun:test";
import {
  type PiNativeSessionHandle,
  type PiNativeSessionHeader,
  type PiNativeSessionHostPort,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const PARENT = "parent-session-leaf-1";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** A path-shaped secret the host getter throws; it must never surface. */
const HOSTILE_THROW_MESSAGE =
  "getLeafId failed for /Users/example/.local/share/weave/adapters/pi/sessions/child-1/session.jsonl";

function header(cwd: string): PiNativeSessionHeader {
  return {
    type: "session",
    id: "native-session-leaf-1",
    cwd,
    version: 3,
    timestamp: TIMESTAMP,
    parentSession: PARENT,
  };
}

interface LeafHostOptions {
  /** What `appendCustomEntry` returns; a non-string forces the fallback. */
  readonly appendReturns: unknown;
  /** How the optional fallback getter behaves. */
  readonly leaf: "throws" | "value" | "null" | "absent";
}

/**
 * Scripted `SessionManager` stand-in whose append result and optional leaf
 * getter are both controlled. Never starts a real harness.
 */
class LeafFallbackHost implements PiNativeSessionHostPort {
  leafCalls = 0;

  constructor(private readonly options: LeafHostOptions) {}

  private handle(file: string, dir: string): PiNativeSessionHandle {
    const base = {
      getSessionId: () => header(dir).id,
      getSessionFile: () => file,
      getSessionDir: () => dir,
      getHeader: () => header("/repo"),
      getEntries: () => [],
      isPersisted: () => true,
      appendCustomEntry: () => this.options.appendReturns as unknown as string,
    };
    if (this.options.leaf === "absent") return base as PiNativeSessionHandle;
    return {
      ...base,
      getLeafId: () => {
        this.leafCalls += 1;
        if (this.options.leaf === "throws") {
          throw new Error(HOSTILE_THROW_MESSAGE);
        }
        return this.options.leaf === "value" ? "leaf-from-getter" : null;
      },
    } as PiNativeSessionHandle;
  }

  create(_cwd: string, sessionDir: string): PiNativeSessionHandle {
    return this.handle(`${sessionDir}/session.jsonl`, sessionDir);
  }

  open(path: string, sessionDir: string): PiNativeSessionHandle {
    return this.handle(path, sessionDir);
  }
}

async function storeWith(host: PiNativeSessionHostPort): Promise<{
  readonly store: PiNativeSessionStore;
  readonly ref: string;
}> {
  const fs = new MemoryPiNativeSessionFs();
  const store = new PiNativeSessionStore({
    root: ROOT,
    fs,
    host,
    launch: { mode: "read-only" },
  });
  const created = (
    await store.createChildSession({
      childId: "child-1",
      parentSession: PARENT,
      cwd: "/repo",
    })
  )._unsafeUnwrap();
  return { store, ref: created.ref };
}

const METADATA = {
  threadId: "child-1",
  agentName: "shuttle-mini",
  parentId: "root",
  parentAgentName: "loom",
  parentDepth: 0,
  ownerParentSessionId: PARENT,
  cwd: "/repo",
  createdAt: 1_700_000_000_000,
} as const;

describe("establishThreadLeaf leaf-id fallback", () => {
  test("maps a throwing fallback getter to a typed, path-free session error", async () => {
    const host = new LeafFallbackHost({
      appendReturns: undefined,
      leaf: "throws",
    });
    const { store, ref } = await storeWith(host);

    const established = await store.establishThreadLeaf(ref, METADATA, PARENT);
    const rendered = established.isErr()
      ? JSON.stringify(established.error)
      : "unexpected-success";

    expect({
      failed: established.isErr(),
      error: established.isErr() ? established.error : undefined,
      fallbackAttempted: host.leafCalls,
      leakedThrowMessage: rendered.includes("getLeafId failed"),
      leakedPath: rendered.includes("/Users/example"),
    }).toEqual({
      failed: true,
      error: { type: "SessionCorrupt", ref, reason: "unreadable" },
      fallbackAttempted: 1,
      leakedThrowMessage: false,
      leakedPath: false,
    });
  });

  test("uses the fallback getter's leaf id when the append returns none", async () => {
    const host = new LeafFallbackHost({
      appendReturns: undefined,
      leaf: "value",
    });
    const { store, ref } = await storeWith(host);

    const established = await store.establishThreadLeaf(ref, METADATA, PARENT);

    expect({
      established: established.isOk(),
      leafId: established.isOk() ? established.value.leafId : undefined,
      recordRef: established.isOk() ? established.value.record.ref : undefined,
      fallbackAttempted: host.leafCalls,
    }).toEqual({
      established: true,
      leafId: "leaf-from-getter",
      recordRef: ref,
      fallbackAttempted: 1,
    });
  });

  test("prefers the append result and never consults the fallback getter", async () => {
    const host = new LeafFallbackHost({
      appendReturns: "leaf-from-append",
      leaf: "throws",
    });
    const { store, ref } = await storeWith(host);

    const established = await store.establishThreadLeaf(ref, METADATA, PARENT);

    expect({
      established: established.isOk(),
      leafId: established.isOk() ? established.value.leafId : undefined,
      fallbackAttempted: host.leafCalls,
    }).toEqual({
      established: true,
      leafId: "leaf-from-append",
      fallbackAttempted: 0,
    });
  });

  test("fails closed when the fallback getter yields no id", async () => {
    const host = new LeafFallbackHost({
      appendReturns: undefined,
      leaf: "null",
    });
    const { store, ref } = await storeWith(host);

    const established = await store.establishThreadLeaf(ref, METADATA, PARENT);

    expect({
      failed: established.isErr(),
      error: established.isErr() ? established.error : undefined,
      fallbackAttempted: host.leafCalls,
    }).toEqual({
      failed: true,
      error: { type: "SessionCorrupt", ref, reason: "unreadable" },
      fallbackAttempted: 1,
    });
  });

  test("fails closed when the host exposes no fallback getter at all", async () => {
    const host = new LeafFallbackHost({
      appendReturns: undefined,
      leaf: "absent",
    });
    const { store, ref } = await storeWith(host);

    const established = await store.establishThreadLeaf(ref, METADATA, PARENT);

    expect({
      failed: established.isErr(),
      error: established.isErr() ? established.error : undefined,
    }).toEqual({
      failed: true,
      error: { type: "SessionCorrupt", ref, reason: "unreadable" },
    });
  });
});
