import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";
import { okAsync, type ResultAsync } from "neverthrow";
import {
  BunPiChildMetadataCacheFs,
  childMetadataRecordFromRef,
  createChildMetadataBypass,
  FakePiChildMetadataCacheFs,
  openBunChildMetadataDatabase,
  openPiChildMetadataCache,
  PI_CHILD_METADATA_CACHE_BOUNDS,
  PI_CHILD_METADATA_CACHE_COLUMNS,
  PI_CHILD_METADATA_CACHE_LAYOUT,
  PI_CHILD_METADATA_FORBIDDEN_COLUMN_TOKENS,
  type PiChildMetadataCache,
  type PiChildMetadataCacheError,
  type PiChildMetadataDatabase,
  type PiChildMetadataRecord,
  type PiChildMetadataSource,
  parseChildMetadataRecord,
  resolvePiChildMetadataCacheRoot,
} from "../child-metadata-cache.js";
import type {
  PiChildRefRecord,
  PiChildRefSourceAuthority,
  PiChildRefSourceState,
} from "../child-session-refs.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE = "workspace-alpha";
const PARENT = "parent-session-1";

function makeRef(overrides: Partial<PiChildRefRecord> = {}): PiChildRefRecord {
  const childId = overrides.childId ?? "child-a";
  return {
    childId,
    threadId: overrides.threadId ?? childId,
    nativeSessionId: overrides.nativeSessionId ?? `native-${childId}`,
    sessionRef: overrides.sessionRef ?? `${childId}/session.jsonl`,
    originParentSessionId: overrides.originParentSessionId ?? PARENT,
    originEntryId: overrides.originEntryId ?? `entry-${childId}`,
    title: overrides.title ?? `Title ${childId}`,
    status: overrides.status ?? "completed",
    createdAt: overrides.createdAt ?? 1_000,
    updatedAt: overrides.updatedAt ?? 2_000,
    ...(overrides.settledAt === undefined
      ? {}
      : { settledAt: overrides.settledAt }),
    runs: overrides.runs ?? [
      { run: 1, action: "start", startedAt: 1_100, model: "gpt" },
    ],
  };
}

/** Scriptable source authority over Task 5's read-only contract. */
class FakeAuthority implements PiChildRefSourceAuthority {
  readonly states = new Map<string, PiChildRefSourceState>();
  readonly calls: string[] = [];

  checkSource(
    sessionRef: string,
    expectedParentSessionId: string,
  ): ResultAsync<PiChildRefSourceState, never> {
    this.calls.push(`${sessionRef}|${expectedParentSessionId}`);
    return okAsync(this.states.get(sessionRef) ?? "available");
  }
}

class FakeSource implements PiChildMetadataSource {
  constructor(
    readonly workspaceKey: string,
    readonly parentSessionId: string,
    private refs: readonly PiChildRefRecord[],
  ) {}

  set(refs: readonly PiChildRefRecord[]): void {
    this.refs = refs;
  }

  readRefs(): ResultAsync<
    readonly PiChildRefRecord[],
    PiChildMetadataCacheError
  > {
    return okAsync(this.refs);
  }
}

interface Harness {
  readonly cache: PiChildMetadataCache;
  readonly authority: FakeAuthority;
  readonly source: FakeSource;
}

const openHarness = async (
  refs: readonly PiChildRefRecord[] = [],
  overrides: {
    readonly workspaceKey?: string;
    readonly parentSessionId?: string;
  } = {},
): Promise<Harness> => {
  const authority = new FakeAuthority();
  const source = new FakeSource(
    overrides.workspaceKey ?? WORKSPACE,
    overrides.parentSessionId ?? PARENT,
    refs,
  );
  const outcome = await openPiChildMetadataCache({
    root: "/tmp/never-touched",
    fs: new FakePiChildMetadataCacheFs(),
    authority,
    source,
    openDatabase: () => openBunChildMetadataDatabase(":memory:"),
    now: () => 5_000,
  });
  expect(outcome.isOk()).toBe(true);
  const value = outcome._unsafeUnwrap();
  if (value.mode !== "active") throw new Error("expected an active cache");
  return { cache: value.cache, authority, source };
};

function seed(
  cache: PiChildMetadataCache,
  refs: readonly PiChildRefRecord[],
  workspaceKey = WORKSPACE,
): readonly PiChildMetadataRecord[] {
  return refs.map((ref) => {
    const written = cache.upsertRef(ref, workspaceKey);
    expect(written.isOk()).toBe(true);
    return written._unsafeUnwrap();
  });
}

// ---------------------------------------------------------------------------
// Schema shape
// ---------------------------------------------------------------------------

describe("child metadata cache — metadata-only schema", () => {
  it("declares exactly the documented columns and no transcript column", async () => {
    const { cache } = await openHarness();
    const columns = cache.columns();
    expect(columns.isOk()).toBe(true);
    expect([...columns._unsafeUnwrap()].sort()).toEqual(
      [...PI_CHILD_METADATA_CACHE_COLUMNS].sort(),
    );
    for (const column of columns._unsafeUnwrap()) {
      for (const token of PI_CHILD_METADATA_FORBIDDEN_COLUMN_TOKENS) {
        expect(column.includes(token)).toBe(false);
      }
    }
    cache.close();
  });

  it("grep of the CREATE TABLE statement finds no transcript-like field", async () => {
    const source = await Bun.file(
      new URL("../child-metadata-cache.ts", import.meta.url).pathname,
    ).text();
    const start = source.indexOf("CREATE TABLE IF NOT EXISTS children");
    expect(start).toBeGreaterThan(0);
    const table = source.slice(start, source.indexOf(");", start));
    for (const token of PI_CHILD_METADATA_FORBIDDEN_COLUMN_TOKENS) {
      expect(table.includes(token)).toBe(false);
    }
  });

  it("rejects a record carrying an unknown (content-shaped) field", () => {
    const record = parseChildMetadataRecord({
      ...childMetadataRecordFromRef({
        ref: makeRef(),
        workspaceKey: WORKSPACE,
        cachedAt: 1,
      })._unsafeUnwrap(),
      transcript: "secret prompt text",
    });
    expect(record.isErr()).toBe(true);
  });

  it("rejects absolute and traversing session refs on parse and upsert", async () => {
    const base = childMetadataRecordFromRef({
      ref: makeRef(),
      workspaceKey: WORKSPACE,
      cachedAt: 1,
    })._unsafeUnwrap();
    for (const sessionRef of [
      "/tmp/escape/session.jsonl",
      "../escape/session.jsonl",
      "child-a/../other/session.jsonl",
    ]) {
      const parsed = parseChildMetadataRecord({ ...base, sessionRef });
      expect(parsed.isErr()).toBe(true);
      expect(parsed._unsafeUnwrapErr().type).toBe("CacheRecordInvalid");
    }

    const { cache } = await openHarness();
    const upserted = cache.upsert({
      ...base,
      sessionRef: "/absolute/session.jsonl",
    });
    expect(upserted.isErr()).toBe(true);
    expect(upserted._unsafeUnwrapErr().type).toBe("CacheRecordInvalid");
    expect(
      cache.list({ workspaceKey: WORKSPACE })._unsafeUnwrap().records,
    ).toEqual([]);
    cache.close();
  });

  it("keys the children table on workspace, parent, and child id", async () => {
    const source = await Bun.file(
      new URL("../child-metadata-cache.ts", import.meta.url).pathname,
    ).text();
    expect(source).toContain(
      "PRIMARY KEY (workspace_key, origin_parent_session, child_id)",
    );
    expect(source).toContain(
      "ON CONFLICT (workspace_key, origin_parent_session, child_id)",
    );
    expect(source).not.toContain("Buffer.from");
  });
});

// ---------------------------------------------------------------------------
// Root containment
// ---------------------------------------------------------------------------

describe("child metadata cache — root resolution", () => {
  it("roots the cache under an absolute XDG data home", () => {
    const root = resolvePiChildMetadataCacheRoot({
      env: { XDG_DATA_HOME: "/data/home" },
    });
    expect(root._unsafeUnwrap()).toBe(
      join("/data/home", ...PI_CHILD_METADATA_CACHE_LAYOUT.segments),
    );
  });

  it("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
    const root = resolvePiChildMetadataCacheRoot({
      env: {},
      homeDir: "/home/dev",
    });
    expect(root._unsafeUnwrap()).toBe(
      join(
        "/home/dev/.local/share",
        ...PI_CHILD_METADATA_CACHE_LAYOUT.segments,
      ),
    );
  });

  it("refuses a relative XDG_DATA_HOME instead of re-basing it", () => {
    const root = resolvePiChildMetadataCacheRoot({
      env: { XDG_DATA_HOME: "relative/data" },
    });
    expect(root._unsafeUnwrapErr()).toEqual({
      type: "CacheRootViolation",
      reason: "relative-xdg-data-home",
    });
  });

  it("refuses a relative homeDir instead of returning a relative cache root", () => {
    const root = resolvePiChildMetadataCacheRoot({
      env: {},
      homeDir: "relative/home",
    });
    expect(root._unsafeUnwrapErr()).toEqual({
      type: "CacheRootViolation",
      reason: "relative-home",
    });
  });

  it("refuses an empty home", () => {
    const root = resolvePiChildMetadataCacheRoot({ env: {}, homeDir: "" });
    expect(root._unsafeUnwrapErr()).toEqual({
      type: "CacheRootViolation",
      reason: "empty-home",
    });
  });
});

// ---------------------------------------------------------------------------
// Real filesystem permission modes
// ---------------------------------------------------------------------------

describe("child metadata cache — real filesystem modes", () => {
  const scratch: string[] = [];

  afterEach(async () => {
    for (const path of scratch.splice(0)) {
      await $`rm -rf ${path}`.quiet();
    }
  });

  const tempRoot = async (): Promise<string> => {
    const made = await $`mktemp -d`.quiet();
    const created = made.text().trim();
    // macOS temp dirs live behind the /var -> /private/var symlink, which the
    // no-follow chain refuses by design; the test needs the real path.
    const resolved = await $`realpath ${created}`.quiet();
    const path = resolved.text().trim();
    scratch.push(path);
    return path;
  };

  it("creates the cache directory 0700 and the database file 0600", async () => {
    const base = await tempRoot();
    const root = join(base, "weave", "adapters", "pi", "cache");
    const outcome = await openPiChildMetadataCache({
      root,
      fs: new BunPiChildMetadataCacheFs(),
      authority: new FakeAuthority(),
      source: new FakeSource(WORKSPACE, PARENT, []),
    });
    const value = outcome._unsafeUnwrap();
    expect(value.mode).toBe("active");
    if (value.mode !== "active") return;
    const databasePath = join(
      root,
      PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile,
    );
    const fileStat = await Bun.file(databasePath).stat();
    expect(fileStat.mode & 0o7777).toBe(0o600);
    const directoryStat = await Bun.file(root).stat();
    expect(directoryStat.mode & 0o7777).toBe(0o700);
    expect(value.cache.close().isOk()).toBe(true);
  });

  it("degrades instead of widening a database file with loose permissions", async () => {
    const base = await tempRoot();
    const root = join(base, "cache");
    await $`mkdir -p ${root} && chmod 700 ${root}`.quiet();
    const databasePath = join(
      root,
      PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile,
    );
    await Bun.write(databasePath, "");
    await $`chmod 644 ${databasePath}`.quiet();
    const outcome = await openPiChildMetadataCache({
      root,
      fs: new BunPiChildMetadataCacheFs(),
      authority: new FakeAuthority(),
      source: new FakeSource(WORKSPACE, PARENT, []),
    });
    const value = outcome._unsafeUnwrap();
    expect(value.mode).toBe("degraded");
    if (value.mode !== "degraded") return;
    expect(value.error).toEqual({
      type: "CacheUnavailable",
      reason: "permission",
    });
    const stat = await Bun.file(databasePath).stat();
    expect(stat.mode & 0o7777).toBe(0o644);
  });

  it("degrades to a bypass when the database file is corrupt", async () => {
    const base = await tempRoot();
    const root = join(base, "cache");
    await $`mkdir -p ${root} && chmod 700 ${root}`.quiet();
    const databasePath = join(
      root,
      PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile,
    );
    await Bun.write(databasePath, "this is definitely not a sqlite database");
    await $`chmod 600 ${databasePath}`.quiet();
    const source = new FakeSource(WORKSPACE, PARENT, [makeRef()]);
    const outcome = await openPiChildMetadataCache({
      root,
      fs: new BunPiChildMetadataCacheFs(),
      authority: new FakeAuthority(),
      source,
    });
    const value = outcome._unsafeUnwrap();
    expect(value.mode).toBe("degraded");
    if (value.mode !== "degraded") return;
    expect(value.error).toEqual({
      type: "CacheUnavailable",
      reason: "corrupt",
    });
    const page = await value.bypass.list({ workspaceKey: WORKSPACE });
    expect(page._unsafeUnwrap().records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Degraded modes and bypass
// ---------------------------------------------------------------------------

describe("child metadata cache — degraded modes", () => {
  it("degrades when the filesystem boundary refuses the root", async () => {
    const source = new FakeSource(WORKSPACE, PARENT, [makeRef()]);
    const outcome = await openPiChildMetadataCache({
      root: "/tmp/whatever",
      fs: new FakePiChildMetadataCacheFs({ type: "symlink-rejected" }),
      authority: new FakeAuthority(),
      source,
    });
    const value = outcome._unsafeUnwrap();
    expect(value.mode).toBe("degraded");
    if (value.mode !== "degraded") return;
    expect(value.error).toEqual({
      type: "CacheRootViolation",
      reason: "path-escape",
    });
    expect(value.bypass.reason).toBe("root-violation");
  });

  it("degrades when opening the database throws", async () => {
    const source = new FakeSource(WORKSPACE, PARENT, [
      makeRef({ childId: "child-a" }),
      makeRef({ childId: "child-b", updatedAt: 3_000 }),
    ]);
    const outcome = await openPiChildMetadataCache({
      root: "/tmp/whatever",
      fs: new FakePiChildMetadataCacheFs(),
      authority: new FakeAuthority(),
      source,
      openDatabase: () => {
        throw new Error("cannot open");
      },
    });
    const value = outcome._unsafeUnwrap();
    expect(value.mode).toBe("degraded");
    if (value.mode !== "degraded") return;
    expect(value.error).toEqual({
      type: "CacheUnavailable",
      reason: "open-failed",
    });
    const page = await value.bypass.list({ workspaceKey: WORKSPACE });
    expect(page._unsafeUnwrap().records.map((r) => r.childId)).toEqual([
      "child-b",
      "child-a",
    ]);
  });

  it("degrades on a stored schema version mismatch", async () => {
    const database = openBunChildMetadataDatabase(":memory:");
    database.run(
      "CREATE TABLE IF NOT EXISTS cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    database.run("INSERT INTO cache_meta (key, value) VALUES (?, ?)", [
      "schema_version",
      "999",
    ]);
    const outcome = await openPiChildMetadataCache({
      root: "/tmp/whatever",
      fs: new FakePiChildMetadataCacheFs(),
      authority: new FakeAuthority(),
      source: new FakeSource(WORKSPACE, PARENT, []),
      openDatabase: () => database,
    });
    const value = outcome._unsafeUnwrap();
    expect(value.mode).toBe("degraded");
    if (value.mode !== "degraded") return;
    expect(value.error).toEqual({
      type: "CacheUnavailable",
      reason: "schema-mismatch",
    });
    expect(value.bypass.degraded).toBe(true);
  });

  it("degrades on a query failure after opening, without throwing", async () => {
    const broken: PiChildMetadataDatabase = {
      run: () => undefined,
      all: () => {
        throw new Error("disk I/O error");
      },
      close: () => undefined,
    };
    const outcome = await openPiChildMetadataCache({
      root: "/tmp/whatever",
      fs: new FakePiChildMetadataCacheFs(),
      authority: new FakeAuthority(),
      source: new FakeSource(WORKSPACE, PARENT, []),
      openDatabase: () => broken,
    });
    const value = outcome._unsafeUnwrap();
    expect(value.mode).toBe("degraded");
    if (value.mode !== "degraded") return;
    expect(value.error).toEqual({
      type: "CacheUnavailable",
      reason: "corrupt",
    });
  });

  it("bypass pages match cache ordering for the same source", async () => {
    const refs = [
      makeRef({ childId: "child-a", updatedAt: 3_000 }),
      makeRef({ childId: "child-b", updatedAt: 2_000 }),
      makeRef({ childId: "child-c", updatedAt: 1_000 }),
    ];
    const { cache } = await openHarness(refs);
    seed(cache, refs);
    const cachePage = cache.list({ workspaceKey: WORKSPACE, limit: 2 });
    const bypass = createChildMetadataBypass(
      new FakeSource(WORKSPACE, PARENT, refs),
      "open-failed",
      () => 5_000,
    );
    const bypassPage = await bypass.list({ workspaceKey: WORKSPACE, limit: 2 });
    expect(
      bypassPage._unsafeUnwrap().records.map((record) => record.childId),
    ).toEqual(
      cachePage._unsafeUnwrap().records.map((record) => record.childId),
    );
    expect(bypassPage._unsafeUnwrap().nextCursor).toBe(
      cachePage._unsafeUnwrap().nextCursor as string,
    );
    cache.close();
  });

  it("bypass never answers for another workspace", async () => {
    const bypass = createChildMetadataBypass(
      new FakeSource(WORKSPACE, PARENT, [makeRef()]),
      "io",
    );
    const page = await bypass.list({ workspaceKey: "other-workspace" });
    expect(page._unsafeUnwrap().records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scoping and pagination
// ---------------------------------------------------------------------------

describe("child metadata cache — scoping and pagination", () => {
  it("never returns rows from another workspace or parent", async () => {
    const { cache } = await openHarness();
    seed(cache, [makeRef({ childId: "mine" })], WORKSPACE);
    seed(cache, [makeRef({ childId: "theirs" })], "workspace-beta");
    seed(cache, [
      makeRef({
        childId: "other-parent",
        originParentSessionId: "parent-session-2",
      }),
    ]);

    const mine = cache.list({ workspaceKey: WORKSPACE });
    expect(
      mine
        ._unsafeUnwrap()
        .records.map((r) => r.childId)
        .sort(),
    ).toEqual(["mine", "other-parent"]);

    const scoped = cache.list({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
    });
    expect(scoped._unsafeUnwrap().records.map((r) => r.childId)).toEqual([
      "mine",
    ]);

    const theirs = cache.list({ workspaceKey: "workspace-beta" });
    expect(theirs._unsafeUnwrap().records.map((r) => r.childId)).toEqual([
      "theirs",
    ]);
    cache.close();
  });

  it("findByChildId returns bounded matches including older rows and duplicate parents", async () => {
    const refs = Array.from({ length: 55 }, (_, index) =>
      makeRef({
        childId: `child-${String(index).padStart(2, "0")}`,
        originParentSessionId: `parent-${index}`,
        updatedAt: 10_000 - index,
      }),
    );
    refs.push(
      makeRef({
        childId: "child-54",
        originParentSessionId: "parent-duplicate",
        updatedAt: 1,
        title: "Duplicate older",
      }),
    );
    const { cache } = await openHarness();
    seed(cache, refs);

    const page = cache.list({ workspaceKey: WORKSPACE, limit: 50 });
    expect(
      page
        ._unsafeUnwrap()
        .records.some((record) => record.childId === "child-54"),
    ).toBe(false);

    const found = cache.findByChildId({
      workspaceKey: WORKSPACE,
      childId: "child-54",
      includeTombstoned: true,
      limit: 16,
    });
    expect(found.isOk()).toBe(true);
    if (found.isErr()) return;
    expect(found.value).toHaveLength(2);
    expect(
      found.value.map((record) => record.originParentSessionId).sort(),
    ).toEqual(["parent-54", "parent-duplicate"]);

    const scoped = cache.findByChildId({
      workspaceKey: WORKSPACE,
      childId: "child-54",
      parentSessionId: "parent-54",
      includeTombstoned: true,
    });
    expect(scoped._unsafeUnwrap()).toHaveLength(1);
    expect(scoped._unsafeUnwrap()[0]?.originParentSessionId).toBe("parent-54");

    const forged = cache.findByChildId({
      workspaceKey: WORKSPACE,
      childId: "child-54",
      parentSessionId: "forged-parent",
      includeTombstoned: true,
    });
    expect(forged._unsafeUnwrap()).toHaveLength(0);
  });

  it("keeps the same child id under two parents without cross-contamination", async () => {
    const parentA = "parent-session-a";
    const parentB = "parent-session-b";
    const sharedId = "shared-child";
    const refA = makeRef({
      childId: sharedId,
      originParentSessionId: parentA,
      title: "froma-redchild",
      updatedAt: 3_000,
    });
    const refB = makeRef({
      childId: sharedId,
      originParentSessionId: parentB,
      title: "fromb-redchild",
      updatedAt: 4_000,
    });
    const { cache } = await openHarness();
    seed(cache, [refA, refB]);

    const crossSession = cache.list({ workspaceKey: WORKSPACE });
    expect(
      crossSession
        ._unsafeUnwrap()
        .records.map((record) => record.originParentSessionId)
        .sort(),
    ).toEqual([parentA, parentB]);

    const listedA = cache.list({
      workspaceKey: WORKSPACE,
      parentSessionId: parentA,
    });
    expect(listedA._unsafeUnwrap().records).toHaveLength(1);
    expect(listedA._unsafeUnwrap().records[0]?.title).toBe("froma-redchild");

    const listedB = cache.list({
      workspaceKey: WORKSPACE,
      parentSessionId: parentB,
    });
    expect(listedB._unsafeUnwrap().records).toHaveLength(1);
    expect(listedB._unsafeUnwrap().records[0]?.title).toBe("fromb-redchild");

    const gotA = await cache.get(
      { workspaceKey: WORKSPACE, parentSessionId: parentA },
      sharedId,
    );
    expect(gotA._unsafeUnwrap().title).toBe("froma-redchild");
    expect(gotA._unsafeUnwrap().originParentSessionId).toBe(parentA);

    expect(
      cache
        .tombstone(
          { workspaceKey: WORKSPACE, parentSessionId: parentA },
          sharedId,
        )
        .isOk(),
    ).toBe(true);

    const tombstonedA = await cache.get(
      { workspaceKey: WORKSPACE, parentSessionId: parentA },
      sharedId,
    );
    expect(tombstonedA._unsafeUnwrapErr()).toEqual({
      type: "CacheEntryUnusable",
      childId: sharedId,
      state: "tombstoned",
    });

    const survivingB = await cache.get(
      { workspaceKey: WORKSPACE, parentSessionId: parentB },
      sharedId,
    );
    expect(survivingB._unsafeUnwrap().title).toBe("fromb-redchild");
    expect(survivingB._unsafeUnwrap().tombstoned).toBe(false);

    expect(
      cache
        .markStale(
          { workspaceKey: WORKSPACE, parentSessionId: parentA },
          sharedId,
        )
        .isOk(),
    ).toBe(true);
    expect(
      cache
        .list({
          workspaceKey: WORKSPACE,
          parentSessionId: parentB,
        })
        ._unsafeUnwrap()
        .records.map((record) => record.childId),
    ).toEqual([sharedId]);

    const parentOmittedGet = await cache.get(
      { workspaceKey: WORKSPACE },
      sharedId,
    );
    expect(parentOmittedGet._unsafeUnwrapErr()).toEqual({
      type: "CacheRecordInvalid",
      issues: ["parentSessionId"],
    });
    expect(
      cache.tombstone({ workspaceKey: WORKSPACE }, sharedId)._unsafeUnwrapErr(),
    ).toEqual({
      type: "CacheRecordInvalid",
      issues: ["parentSessionId"],
    });
    cache.close();
  });

  it("paginates deterministically across ties", async () => {
    const refs = ["a", "b", "c", "d", "e"].map((suffix) =>
      makeRef({
        childId: `child-${suffix}`,
        updatedAt: 2_000,
        createdAt: 1_000,
      }),
    );
    const { cache } = await openHarness(refs);
    seed(cache, refs);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const input =
        cursor === undefined
          ? { workspaceKey: WORKSPACE, limit: 2 }
          : { workspaceKey: WORKSPACE, limit: 2, cursor };
      const result = cache.list(input);
      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();
      seen.push(...value.records.map((record) => record.childId));
      cursor = value.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual([
      "child-a",
      "child-b",
      "child-c",
      "child-d",
      "child-e",
    ]);
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length);
    cache.close();
  });

  it("clamps the page size to the hard bound", async () => {
    const refs = Array.from({ length: 5 }, (_, index) =>
      makeRef({ childId: `child-${index}`, updatedAt: 2_000 + index }),
    );
    const { cache } = await openHarness(refs);
    seed(cache, refs);
    const page = cache.list({
      workspaceKey: WORKSPACE,
      limit: PI_CHILD_METADATA_CACHE_BOUNDS.maxPageSize + 5_000,
    });
    expect(page._unsafeUnwrap().records).toHaveLength(5);
    const single = cache.list({ workspaceKey: WORKSPACE, limit: 0 });
    expect(single._unsafeUnwrap().records).toHaveLength(1);
    cache.close();
  });

  it("rejects a malformed cursor and a cursor minted for another scope", async () => {
    const refs = [
      makeRef({ childId: "child-a" }),
      makeRef({ childId: "child-b" }),
    ];
    const { cache } = await openHarness(refs);
    seed(cache, refs);
    const scoped = cache.list({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      limit: 1,
    });
    const cursor = scoped._unsafeUnwrap().nextCursor;
    expect(cursor).toBeDefined();

    const wrongScope = cache.list({
      workspaceKey: WORKSPACE,
      limit: 1,
      cursor: cursor as string,
    });
    expect(wrongScope._unsafeUnwrapErr()).toEqual({
      type: "CacheCursorInvalid",
    });

    const malformed = cache.list({
      workspaceKey: WORKSPACE,
      cursor: "not-a-cursor",
    });
    expect(malformed._unsafeUnwrapErr()).toEqual({
      type: "CacheCursorInvalid",
    });

    const oversized = cache.list({
      workspaceKey: WORKSPACE,
      cursor: "x".repeat(PI_CHILD_METADATA_CACHE_BOUNDS.maxCursorLength + 1),
    });
    expect(oversized._unsafeUnwrapErr()).toEqual({
      type: "CacheCursorInvalid",
    });
    cache.close();
  });
});

// ---------------------------------------------------------------------------
// Source validation
// ---------------------------------------------------------------------------

describe("child metadata cache — source validation on specific access", () => {
  const scoped = {
    workspaceKey: WORKSPACE,
    parentSessionId: PARENT,
  } as const;

  it("validates a specific child against source before returning it", async () => {
    const ref = makeRef();
    const { cache, authority } = await openHarness([ref]);
    seed(cache, [ref]);
    const record = await cache.get(scoped, ref.childId);
    expect(record._unsafeUnwrap().childId).toBe(ref.childId);
    expect(authority.calls).toContain(`${ref.sessionRef}|${PARENT}`);
    cache.close();
  });

  it("marks the row stale and refuses it when the source is missing", async () => {
    const ref = makeRef();
    const { cache, authority } = await openHarness([ref]);
    seed(cache, [ref]);
    authority.states.set(ref.sessionRef, "missing");
    const record = await cache.get(scoped, ref.childId);
    expect(record._unsafeUnwrapErr()).toEqual({
      type: "CacheEntryUnusable",
      childId: ref.childId,
      state: "missing",
    });
    const listed = cache.list({ workspaceKey: WORKSPACE });
    expect(listed._unsafeUnwrap().records[0]?.stale).toBe(true);
    cache.close();
  });

  it("marks the row tombstoned when the source is tombstoned", async () => {
    const ref = makeRef();
    const { cache, authority } = await openHarness([ref]);
    seed(cache, [ref]);
    authority.states.set(ref.sessionRef, "tombstoned");
    const first = await cache.get(scoped, ref.childId);
    expect(first._unsafeUnwrapErr()).toEqual({
      type: "CacheEntryUnusable",
      childId: ref.childId,
      state: "tombstoned",
    });
    const listed = cache.list({
      workspaceKey: WORKSPACE,
      includeTombstoned: true,
    });
    expect(listed._unsafeUnwrap().records[0]?.tombstoned).toBe(true);
    expect(listed._unsafeUnwrap().records[0]?.status).toBe("tombstoned");
    cache.close();
  });

  it("clears a stale marker once the source is available again", async () => {
    const ref = makeRef();
    const { cache, authority } = await openHarness([ref]);
    seed(cache, [ref]);
    authority.states.set(ref.sessionRef, "corrupt");
    await cache.get(scoped, ref.childId);
    authority.states.delete(ref.sessionRef);
    const refreshed = await cache.get(scoped, ref.childId);
    expect(refreshed._unsafeUnwrap().stale).toBe(false);
    const listed = cache.list({ workspaceKey: WORKSPACE });
    expect(listed._unsafeUnwrap().records[0]?.stale).toBe(false);
    cache.close();
  });

  it("reports an unknown child as missing without consulting source", async () => {
    const { cache, authority } = await openHarness();
    const record = await cache.get(scoped, "nope");
    expect(record._unsafeUnwrapErr()).toEqual({
      type: "CacheEntryMissing",
      childId: "nope",
    });
    expect(authority.calls).toEqual([]);
    cache.close();
  });

  it("never returns a child scoped to another workspace", async () => {
    const ref = makeRef();
    const { cache } = await openHarness([ref]);
    seed(cache, [ref], "workspace-beta");
    const record = await cache.get(scoped, ref.childId);
    expect(record._unsafeUnwrapErr()).toEqual({
      type: "CacheEntryMissing",
      childId: ref.childId,
    });
    cache.close();
  });
});

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

describe("child metadata cache — rebuild", () => {
  it("produces query results equivalent to incremental writes", async () => {
    const refs = [
      makeRef({ childId: "child-a", updatedAt: 3_000 }),
      makeRef({ childId: "child-b", updatedAt: 2_000 }),
      makeRef({ childId: "child-c", updatedAt: 1_000 }),
    ];
    const { cache } = await openHarness(refs);
    seed(cache, refs);
    const before = cache.list({ workspaceKey: WORKSPACE })._unsafeUnwrap();

    const report = await cache.rebuild();
    expect(report._unsafeUnwrap()).toEqual({
      scannedRefs: 3,
      writtenRows: 3,
      staleRows: 0,
      retainedTombstones: 0,
      skippedRefs: 0,
    });
    const after = cache.list({ workspaceKey: WORKSPACE })._unsafeUnwrap();
    expect(after).toEqual(before);
    cache.close();
  });

  it("drops rows whose ref disappeared from source", async () => {
    const refs = [
      makeRef({ childId: "child-a" }),
      makeRef({ childId: "child-b" }),
    ];
    const { cache, source } = await openHarness(refs);
    seed(cache, refs);
    source.set([refs[0] as PiChildRefRecord]);
    const report = await cache.rebuild();
    expect(report._unsafeUnwrap().writtenRows).toBe(1);
    const listed = cache.list({ workspaceKey: WORKSPACE });
    expect(listed._unsafeUnwrap().records.map((r) => r.childId)).toEqual([
      "child-a",
    ]);
    cache.close();
  });

  it("marks rebuilt rows stale when their source is unusable", async () => {
    const ref = makeRef();
    const { cache, authority } = await openHarness([ref]);
    authority.states.set(ref.sessionRef, "corrupt");
    const report = await cache.rebuild();
    expect(report._unsafeUnwrap().staleRows).toBe(1);
    const listed = cache.list({ workspaceKey: WORKSPACE });
    expect(listed._unsafeUnwrap().records[0]?.stale).toBe(true);
    cache.close();
  });

  it("leaves other workspaces and other parents untouched", async () => {
    const mine = makeRef({ childId: "mine" });
    const { cache } = await openHarness([mine]);
    seed(cache, [makeRef({ childId: "theirs" })], "workspace-beta");
    seed(cache, [
      makeRef({
        childId: "other-parent",
        originParentSessionId: "parent-session-2",
      }),
    ]);
    await cache.rebuild();
    const beta = cache.list({ workspaceKey: "workspace-beta" });
    expect(beta._unsafeUnwrap().records.map((r) => r.childId)).toEqual([
      "theirs",
    ]);
    const otherParent = cache.list({
      workspaceKey: WORKSPACE,
      parentSessionId: "parent-session-2",
    });
    expect(otherParent._unsafeUnwrap().records.map((r) => r.childId)).toEqual([
      "other-parent",
    ]);
    cache.close();
  });

  it("ignores refs originating in another parent session", async () => {
    const foreign = makeRef({
      childId: "foreign",
      originParentSessionId: "parent-session-9",
    });
    const { cache } = await openHarness([
      makeRef({ childId: "mine" }),
      foreign,
    ]);
    const report = await cache.rebuild();
    expect(report._unsafeUnwrap().skippedRefs).toBe(1);
    const listed = cache.list({ workspaceKey: WORKSPACE });
    expect(listed._unsafeUnwrap().records.map((r) => r.childId)).toEqual([
      "mine",
    ]);
    cache.close();
  });
});

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

describe("child metadata cache — tombstones", () => {
  const scoped = {
    workspaceKey: WORKSPACE,
    parentSessionId: PARENT,
  } as const;

  it("hides tombstoned rows by default and lists them on request", async () => {
    const ref = makeRef();
    const { cache } = await openHarness([ref]);
    seed(cache, [ref]);
    expect(cache.tombstone(scoped, ref.childId).isOk()).toBe(true);
    expect(
      cache.list({ workspaceKey: WORKSPACE })._unsafeUnwrap().records,
    ).toEqual([]);
    const withTombstones = cache.list({
      workspaceKey: WORKSPACE,
      includeTombstoned: true,
    });
    expect(withTombstones._unsafeUnwrap().records[0]?.tombstoned).toBe(true);
    cache.close();
  });

  it("never resurrects a tombstoned child through rebuild or upsert", async () => {
    const ref = makeRef();
    const { cache } = await openHarness([ref]);
    seed(cache, [ref]);
    cache.tombstone(scoped, ref.childId);

    const report = await cache.rebuild();
    expect(report._unsafeUnwrap().retainedTombstones).toBe(1);
    expect(report._unsafeUnwrap().skippedRefs).toBe(1);
    expect(
      cache.list({ workspaceKey: WORKSPACE })._unsafeUnwrap().records,
    ).toEqual([]);

    cache.upsertRef({ ...ref, status: "running" }, WORKSPACE);
    const listed = cache.list({
      workspaceKey: WORKSPACE,
      includeTombstoned: true,
    });
    expect(listed._unsafeUnwrap().records[0]?.tombstoned).toBe(true);
    expect(listed._unsafeUnwrap().records[0]?.status).toBe("tombstoned");
    expect(
      cache.list({ workspaceKey: WORKSPACE })._unsafeUnwrap().records,
    ).toEqual([]);

    const fetched = await cache.get(scoped, ref.childId);
    expect(fetched._unsafeUnwrapErr()).toEqual({
      type: "CacheEntryUnusable",
      childId: ref.childId,
      state: "tombstoned",
    });
    cache.close();
  });

  it("keeps a real on-disk tombstone across a reopen", async () => {
    const made = await $`mktemp -d`.quiet();
    const resolved = await $`realpath ${made.text().trim()}`.quiet();
    const base = resolved.text().trim();
    try {
      const root = join(base, "cache");
      const databasePath = join(
        root,
        PI_CHILD_METADATA_CACHE_LAYOUT.databaseFile,
      );
      const ref = makeRef();
      const first = await openPiChildMetadataCache({
        root,
        fs: new BunPiChildMetadataCacheFs(),
        authority: new FakeAuthority(),
        source: new FakeSource(WORKSPACE, PARENT, [ref]),
      });
      const opened = first._unsafeUnwrap();
      if (opened.mode !== "active") throw new Error("expected active");
      opened.cache.upsertRef(ref, WORKSPACE);
      opened.cache.tombstone(scoped, ref.childId);
      opened.cache.close();

      const second = await openPiChildMetadataCache({
        root,
        fs: new BunPiChildMetadataCacheFs(),
        authority: new FakeAuthority(),
        source: new FakeSource(WORKSPACE, PARENT, [ref]),
      });
      const reopened = second._unsafeUnwrap();
      if (reopened.mode !== "active") throw new Error("expected active");
      await reopened.cache.rebuild();
      expect(
        reopened.cache.list({ workspaceKey: WORKSPACE })._unsafeUnwrap()
          .records,
      ).toEqual([]);
      reopened.cache.close();

      const raw = new Database(databasePath, { readonly: true });
      const rows = raw
        .query("SELECT tombstoned FROM children WHERE child_id = ?")
        .all(ref.childId);
      raw.close();
      expect(rows).toHaveLength(1);
    } finally {
      await $`rm -rf ${base}`.quiet();
    }
  });
});
