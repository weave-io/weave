import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";

import {
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  type PiNativeSessionHostPort,
  type PiNativeSessionRecord,
  PiNativeSessionStore,
  type PiNativeSessionStoreLaunchMode,
} from "../child-native-sessions.js";
import {
  createPiChildSessionLaunchAuthority,
  mintPiChildSessionLaunchGrant,
  type PiChildSessionLaunchAuthority,
  type PiChildSessionLaunchDetails,
  type PiChildSessionLaunchRejection,
  redeemPiChildSessionLaunchGrant,
} from "../child-session-launch.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const DIR = `${ROOT}/child-1`;
const FILE = `${DIR}/pi-generated.jsonl`;

function authority(root: string = ROOT): PiChildSessionLaunchAuthority {
  const created = createPiChildSessionLaunchAuthority({
    scopeId: "test-scope",
    sessionRoot: root,
  });
  if (created.isErr()) throw new Error(`unexpected: ${created.error}`);
  return created.value;
}

function details(
  overrides: Partial<PiChildSessionLaunchDetails> = {},
): PiChildSessionLaunchDetails {
  return {
    childId: "child-1",
    sessionId: "pi-session-1",
    ref: "child-1/pi-generated.jsonl",
    sessionDir: DIR,
    sessionPath: FILE,
    activeLeafId: "leaf-1",
    ...overrides,
  };
}

describe("Pi child session launch authority", () => {
  test("refuses a session root that is not canonical, absolute, or bounded", () => {
    for (const root of [
      "relative/root",
      "",
      "/",
      "/root/../escape",
      "/root/./here",
      "/root/",
      "/root\u0000",
      "/root\\escape",
    ]) {
      expect(
        createPiChildSessionLaunchAuthority({
          scopeId: "test-scope",
          sessionRoot: root,
        }).isErr(),
      ).toBe(true);
    }
  });

  test("a hand-built look-alike authority cannot mint", () => {
    const forged = {
      scopeId: "test-scope",
      sessionRoot: ROOT,
    } as PiChildSessionLaunchAuthority;

    expect(
      mintPiChildSessionLaunchGrant(forged, details())._unsafeUnwrapErr(),
    ).toBe("authority-unrecognized");
  });
});

describe("Pi child session launch grants", () => {
  test("mints only for an exact immediate-child session file inside the root", () => {
    const granted = authority();
    const cases: readonly [
      PiChildSessionLaunchRejection,
      Partial<PiChildSessionLaunchDetails>,
    ][] = [
      // Prefix confusion: a sibling directory that merely starts with the root.
      [
        "session-path-not-in-root",
        {
          sessionDir: `${ROOT}-evil/child-1`,
          sessionPath: `${ROOT}-evil/child-1/pi-generated.jsonl`,
        },
      ],
      // Nested one level too deep: not an immediate child of the root.
      [
        "session-path-not-in-root",
        {
          sessionDir: `${ROOT}/child-1/nested`,
          sessionPath: `${ROOT}/child-1/nested/pi-generated.jsonl`,
          ref: "nested/pi-generated.jsonl",
        },
      ],
      // Directory entirely outside the validated root.
      [
        "session-path-not-in-root",
        { sessionDir: "/tmp/child-1", sessionPath: "/tmp/child-1/x.jsonl" },
      ],
      // The file is not an immediate child of the stated directory.
      [
        "invalid-session-path",
        { sessionPath: `${DIR}/nested/pi-generated.jsonl` },
      ],
      // Traversal, relative, NUL, and backslash paths.
      ["invalid-session-path", { sessionPath: `${DIR}/../escape.jsonl` }],
      ["invalid-session-path", { sessionPath: "pi-generated.jsonl" }],
      ["invalid-session-path", { sessionPath: `${DIR}/pi\u0000.jsonl` }],
      ["invalid-session-path", { sessionPath: `${DIR}/pi\\generated.jsonl` }],
      // Wrong extension.
      ["invalid-session-path", { sessionPath: `${DIR}/pi-generated.txt` }],
      // Ref must name exactly `<component>/<basename>`.
      ["invalid-ref", { ref: "child-1/other.jsonl" }],
      ["invalid-ref", { ref: `${DIR}/pi-generated.jsonl` }],
      // Identity bounds.
      ["invalid-identity", { childId: "" }],
      ["invalid-identity", { sessionId: "" }],
      ["invalid-identity", { activeLeafId: "leaf\u00001" }],
      ["invalid-identity", { childId: "c".repeat(257) }],
      // Cursor bounds.
      ["invalid-checkpoint-cursor", { checkpointCursor: -1 }],
      ["invalid-checkpoint-cursor", { checkpointCursor: 1.5 }],
    ];

    for (const [reason, overrides] of cases) {
      const minted = mintPiChildSessionLaunchGrant(granted, details(overrides));
      expect({ overrides, reason: minted._unsafeUnwrapErr() }).toEqual({
        overrides,
        reason,
      });
    }
  });

  test("redeems only for the minting authority and the named child", () => {
    const granted = authority();
    const other = authority();
    const grant = mintPiChildSessionLaunchGrant(
      granted,
      details({ checkpointCursor: 7 }),
    )._unsafeUnwrap();

    expect(
      redeemPiChildSessionLaunchGrant(grant, {
        childId: "child-1",
        authority: granted,
      })._unsafeUnwrap(),
    ).toEqual(details({ checkpointCursor: 7 }));
    expect(
      redeemPiChildSessionLaunchGrant(grant, {
        childId: "child-1",
        authority: other,
      })._unsafeUnwrapErr(),
    ).toBe("authority-mismatch");
    expect(
      redeemPiChildSessionLaunchGrant(grant, {
        childId: "child-2",
        authority: granted,
      })._unsafeUnwrapErr(),
    ).toBe("child-mismatch");
    expect(
      redeemPiChildSessionLaunchGrant(grant, {
        childId: "child-1",
        authority: { scopeId: "test-scope", sessionRoot: ROOT },
      })._unsafeUnwrapErr(),
    ).toBe("authority-unrecognized");
  });

  test("refuses every value that was not minted here", () => {
    const granted = authority();
    for (const forged of [
      undefined,
      null,
      "grant",
      42,
      {},
      { kind: "pi-child-session-launch-grant" },
      { kind: "pi-child-session-launch-grant", sessionPath: FILE },
      Object.create({ kind: "pi-child-session-launch-grant" }),
    ]) {
      expect(
        redeemPiChildSessionLaunchGrant(forged, {
          childId: "child-1",
          authority: granted,
        })._unsafeUnwrapErr(),
      ).toBe("grant-unrecognized");
    }
  });

  test("a redeemed grant never exposes a mutable view of its payload", () => {
    const granted = authority();
    const grant = mintPiChildSessionLaunchGrant(
      granted,
      details(),
    )._unsafeUnwrap();
    const redeemed = redeemPiChildSessionLaunchGrant(grant, {
      childId: "child-1",
      authority: granted,
    })._unsafeUnwrap() as { sessionPath: string };

    expect(() => {
      redeemed.sessionPath = "/tmp/hostile.jsonl";
    }).toThrow();
    expect(
      redeemPiChildSessionLaunchGrant(grant, {
        childId: "child-1",
        authority: granted,
      })._unsafeUnwrap().sessionPath,
    ).toBe(FILE);
  });
});

describe("PiNativeSessionStore launch minting", () => {
  const PARENT = "parent-1";
  const CWD = "/repo";
  const CHILD = "child-1";

  function memoryHost(
    overrides: { readonly openSessionId?: string } = {},
  ): PiNativeSessionHostPort {
    const handle = (
      file: string,
      dir: string,
      id: string,
    ): PiNativeSessionHandle => ({
      getSessionId: () => id,
      getSessionFile: () => file,
      getSessionDir: () => dir,
      getHeader: () => ({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: CWD,
        parentSession: PARENT,
      }),
      getEntries: () => [],
      isPersisted: () => true,
      getLeafId: () => "leaf-1",
      appendCustomEntry: () => "entry-1",
    });
    return {
      create: (_cwd, sessionDir) =>
        handle(`${sessionDir}/session.jsonl`, sessionDir, "pi-session-1"),
      open: (path, sessionDir) =>
        handle(path, sessionDir, overrides.openSessionId ?? "pi-session-1"),
    };
  }

  async function storeWith(options: {
    readonly launch: PiNativeSessionStoreLaunchMode;
    readonly host?: PiNativeSessionHostPort;
    readonly fs?: MemoryPiNativeSessionFs;
  }): Promise<{
    readonly store: PiNativeSessionStore;
    readonly fs: MemoryPiNativeSessionFs;
  }> {
    const fs = options.fs ?? new MemoryPiNativeSessionFs();
    const store = new PiNativeSessionStore({
      root: ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host: options.host ?? memoryHost(),
      launch: options.launch,
    });
    return { store, fs };
  }

  /** A session this store itself created, validated, and returned. */
  async function provenRecord(
    store: PiNativeSessionStore,
  ): Promise<PiNativeSessionRecord> {
    return (
      await store.createChildSession({
        childId: CHILD,
        parentSession: PARENT,
        cwd: CWD,
      })
    )._unsafeUnwrap();
  }

  test("refuses to mint without a launch authority", async () => {
    const { store } = await storeWith({ launch: { mode: "read-only" } });
    const record = await provenRecord(store);

    expect(
      (
        await store.mintLaunchGrant({
          childId: "run-child-9",
          record,
          activeLeafId: "leaf-1",
        })
      )._unsafeUnwrapErr(),
    ).toEqual({
      type: "SessionGrantRefused",
      reason: "authority-unavailable",
    });
  });

  test("refuses an authority bound to a different root", async () => {
    const { store } = await storeWith({
      launch: { mode: "authorized", authority: authority("/other/root") },
    });
    const record = await provenRecord(store);

    expect(
      (
        await store.mintLaunchGrant({
          childId: "run-child-9",
          record,
          activeLeafId: "leaf-1",
        })
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionGrantRefused", reason: "authority-mismatch" });
  });

  test("refuses a caller-built record that only looks like a validated one", async () => {
    const granted = authority();
    const { store } = await storeWith({
      launch: { mode: "authorized", authority: granted },
    });
    const proven = await provenRecord(store);
    // Same fields, different object: the structural shape a public caller can
    // build. It carries no store provenance at all.
    const forged: PiNativeSessionRecord = { ...proven };

    expect(
      (
        await store.mintLaunchGrant({
          childId: "run-child-9",
          record: forged,
          activeLeafId: "leaf-1",
        })
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionGrantRefused", reason: "unproven-session" });
  });

  test("refuses a record another store validated", async () => {
    const granted = authority();
    const fs = new MemoryPiNativeSessionFs();
    const { store } = await storeWith({
      fs,
      launch: { mode: "authorized", authority: granted },
    });
    const other = new PiNativeSessionStore({
      root: ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host: memoryHost(),
      launch: { mode: "authorized", authority: granted },
    });
    const foreign = await provenRecord(other);

    expect(
      (
        await store.mintLaunchGrant({
          childId: "run-child-9",
          record: foreign,
          activeLeafId: "leaf-1",
        })
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionGrantRefused", reason: "unproven-session" });
  });

  test("refuses when reopening no longer yields the validated identity", async () => {
    const granted = authority();
    const fs = new MemoryPiNativeSessionFs();
    const { store } = await storeWith({
      fs,
      launch: { mode: "authorized", authority: granted },
    });
    const record = await provenRecord(store);
    // A store whose host now reports a different session on reopen.
    const drifted = new PiNativeSessionStore({
      root: ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host: memoryHost({ openSessionId: "pi-session-2" }),
      launch: { mode: "authorized", authority: granted },
    });
    const driftedRecord = (
      await drifted.readSessionEntries(`${CHILD}/session.jsonl`, PARENT)
    )._unsafeUnwrap().record;

    // The on-disk header still names the original session, so the drifted
    // host's reopen cannot agree with what the store validated.
    expect(driftedRecord.sessionId).toBe("pi-session-1");
    expect(
      (
        await drifted.mintLaunchGrant({
          childId: "run-child-9",
          record: driftedRecord,
          activeLeafId: "leaf-1",
        })
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "SessionGrantRefused", reason: "identity-mismatch" });
    expect(record.ref).toBe(`${CHILD}/session.jsonl`);
  });

  test("binds the grant to the launching child, not the session owner", async () => {
    const granted = authority();
    const { store } = await storeWith({
      launch: { mode: "authorized", authority: granted },
    });
    const record = await provenRecord(store);

    const grant = (
      await store.mintLaunchGrant({
        childId: "run-child-9",
        record,
        activeLeafId: "leaf-1",
      })
    )._unsafeUnwrap();

    expect(
      redeemPiChildSessionLaunchGrant(grant, {
        childId: "run-child-9",
        authority: granted,
      }).map((launch) => launch.sessionPath),
    ).toEqual(ok(`${ROOT}/${CHILD}/session.jsonl`));
    expect(
      redeemPiChildSessionLaunchGrant(grant, {
        childId: record.childId,
        authority: granted,
      })._unsafeUnwrapErr(),
    ).toBe("child-mismatch");
  });

  test("refuses an invalid active leaf even for a proven session", async () => {
    const granted = authority();
    const { store } = await storeWith({
      launch: { mode: "authorized", authority: granted },
    });
    const record = await provenRecord(store);

    expect(
      (
        await store.mintLaunchGrant({
          childId: "run-child-9",
          record,
          activeLeafId: "",
        })
      )._unsafeUnwrapErr(),
    ).toEqual({
      type: "SessionGrantRefused",
      reason: "invalid-launch-identity",
    });
  });
});
