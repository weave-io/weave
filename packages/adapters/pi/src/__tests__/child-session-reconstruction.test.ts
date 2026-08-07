/**
 * Regression coverage for Task 20 item (i): a source parent that returns after
 * a `/clone` or `/fork` transition must report its own completed children again
 * in `/weave:status` and `/weave:history`, while the clone/fork destination
 * still excludes every source-origin ref.
 *
 * The seam under test is the composed one the live defect exercised: the
 * authoritative parent ref store (Task 5), the derivative metadata cache
 * (Task 6), and the pure status/history merges the extension renders.
 */

import { describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import {
  FakePiChildMetadataCacheFs,
  openBunChildMetadataDatabase,
  openPiChildMetadataCache,
  type PiChildMetadataCache,
} from "../child-metadata-cache.js";
import {
  clearChildReconstruction,
  countParentLocalChildren,
  createChildReconstructionCell,
  describeChildReconstructionError,
  mergeReconstructedHistoryRows,
  PI_CHILD_RECONSTRUCTION_BOUNDS,
  type PiChildReconstructionCachePort,
  type PiHistoryRow,
  publishChildReconstruction,
  readChildReconstruction,
  reconstructedChildrenNotLive,
  reconstructParentLocalChildren,
  renderReconstructedStatusLines,
} from "../child-session-reconstruction.js";
import {
  type PiChildRefAppendPort,
  type PiChildRefEntryReadPort,
  type PiChildRefRecord,
  type PiChildRefSourceAuthority,
  type PiChildRefSourceState,
  PiChildSessionRefStore,
} from "../child-session-refs.js";
import { PI_CHILD_TITLE_PROVENANCE } from "../child-title.js";
import { TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE = "/workspace/weave";
const SOURCE_PARENT = "source-parent-session";
const DESTINATION_PARENT = "clone-destination-session";
const SOURCE_GENERATION = "generation-source-1";
const RETURN_GENERATION = "generation-source-2";
const DESTINATION_GENERATION = "generation-destination-1";

/**
 * One Pi parent session's entry ledger. A `/clone` copies the origin session's
 * entries into the destination, which is exactly why the destination sees
 * source-origin refs it must exclude.
 */
class FakeParentSession
  implements PiChildRefAppendPort, PiChildRefEntryReadPort
{
  private readonly entries: {
    readonly customType: string;
    readonly data: unknown;
  }[] = [];

  appendEntry(customType: string, data: unknown): void {
    this.entries.push({ customType, data });
  }

  getEntries(): readonly unknown[] {
    return this.entries.map((entry) => ({
      type: "custom",
      customType: entry.customType,
      data: entry.data,
    }));
  }

  /** Models Pi's `/clone`: the destination inherits the origin's entries. */
  cloneInto(other: FakeParentSession): void {
    for (const entry of this.entries) {
      other.appendEntry(entry.customType, entry.data);
    }
  }
}

function availableAuthority(): PiChildRefSourceAuthority {
  return {
    checkSource: () => okAsync<PiChildRefSourceState, never>("available"),
  };
}

function unusableAuthority(
  state: Exclude<PiChildRefSourceState, "available">,
): PiChildRefSourceAuthority {
  return { checkSource: () => okAsync<PiChildRefSourceState, never>(state) };
}

let clock = 1_000;
const tick = (): number => (clock += 10);

function refStore(
  session: FakeParentSession,
  parentSessionId: string,
  authority: PiChildRefSourceAuthority = availableAuthority(),
): PiChildSessionRefStore {
  let entryId = 0;
  return new PiChildSessionRefStore({
    storage: TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY,
    parentSessionId,
    append: session,
    read: session,
    authority,
    now: tick,
    newEntryId: () => {
      entryId += 1;
      return `${parentSessionId}-entry-${entryId}`;
    },
  });
}

async function openCache(): Promise<PiChildMetadataCache> {
  const outcome = await openPiChildMetadataCache({
    root: "/tmp/never-touched",
    fs: new FakePiChildMetadataCacheFs(),
    authority: availableAuthority(),
    source: {
      workspaceKey: WORKSPACE,
      parentSessionId: SOURCE_PARENT,
      readRefs: () => okAsync([]),
    },
    openDatabase: () => openBunChildMetadataDatabase(":memory:"),
    now: () => 5_000,
  });
  expect(outcome.isOk()).toBe(true);
  const value = outcome._unsafeUnwrap();
  if (value.mode !== "active") throw new Error("expected an active cache");
  return value.cache;
}

/**
 * Runs one completed `shuttle-mini` child in the source parent, exactly as the
 * live proof did: append the new child ref, then settle it as `completed`.
 */
async function runCompletedChild(
  store: PiChildSessionRefStore,
  childId = "child-shuttle-mini-1",
): Promise<PiChildRefRecord> {
  const created = await store.appendNewChild({
    childId,
    nativeSessionId: `native-${childId}`,
    sessionRef: `${childId}/session.jsonl`,
    title: "shuttle-tlemini1",
    titleProvenance: PI_CHILD_TITLE_PROVENANCE,
    status: "running",
  });
  expect(created.isOk()).toBe(true);
  const settled = await store.appendLifecycle(created._unsafeUnwrap(), {
    status: "completed",
    settledAt: tick(),
  });
  expect(settled.isOk()).toBe(true);
  return settled._unsafeUnwrap();
}

/** The `/weave:history` rows a cache-backed `children.list` would render. */
function cacheHistoryRows(
  cache: PiChildMetadataCache,
): readonly PiHistoryRow[] {
  const listed = cache.list({
    workspaceKey: WORKSPACE,
    includeTombstoned: true,
  });
  expect(listed.isOk()).toBe(true);
  return listed._unsafeUnwrap().records.map((row) => ({
    childId: row.childId,
    status: row.status,
    title: row.title,
    tombstoned: row.tombstoned,
  }));
}

// ---------------------------------------------------------------------------
// The item (i) regression
// ---------------------------------------------------------------------------

describe("source return after clone/fork — status and history reconstruction", () => {
  test("a returning source parent counts and lists its own completed child", async () => {
    const source = new FakeParentSession();
    const sourceStore = refStore(source, SOURCE_PARENT);
    const child = await runCompletedChild(sourceStore);

    // The source generation is revoked by the transition: the returning
    // generation has an empty live tree and an empty derivative cache, which
    // is exactly the state the live proof recorded.
    const returningCache = await openCache();
    const liveTree: readonly { readonly id: string }[] = [];

    // Pre-fix behaviour, reproduced exactly. `/weave:status` counted only the
    // live tree and `/weave:history` rendered only cache rows, so a returning
    // source parent reported the recorded blocker: children 0, rows 0.
    expect(liveTree.length).toBe(0);
    expect(cacheHistoryRows(returningCache)).toEqual([]);

    // The reconstruction is what turns the authoritative ref back into
    // status and history.
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      cache: returningCache,
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);
    const value = summary._unsafeUnwrap();

    expect(value.parentSessionId).toBe(SOURCE_PARENT);
    expect(value.children.map((entry) => entry.childId)).toEqual([
      child.childId,
    ]);
    expect(value.children[0]?.status).toBe("completed");
    expect(value.counts.reconstructedChildren).toBe(1);
    expect(value.counts.cachedRows).toBe(1);
    expect(value.counts.originMismatchedChildren).toBe(0);

    // `/weave:status` counts the parent-local child against an empty tree.
    expect(countParentLocalChildren(liveTree, value)).toBe(1);
    expect(renderReconstructedStatusLines(liveTree, value)).toEqual([
      `  ${child.childId}  completed  shuttle-tlemini1`,
    ]);

    // `/weave:history` lists the completed row from bounded authoritative data.
    const rows = mergeReconstructedHistoryRows(
      cacheHistoryRows(returningCache),
      value,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      childId: child.childId,
      status: "completed",
      title: "shuttle-tlemini1",
      tombstoned: false,
    });
    returningCache.close();
  });

  test("history still lists the child when the metadata cache is unavailable", async () => {
    const source = new FakeParentSession();
    const sourceStore = refStore(source, SOURCE_PARENT);
    const child = await runCompletedChild(sourceStore);

    // A degraded cache open leaves the extension with no `children.list`
    // rows at all. The authoritative refs must still answer.
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);
    const value = summary._unsafeUnwrap();
    expect(value.counts.cachedRows).toBe(0);
    expect(countParentLocalChildren([], value)).toBe(1);
    expect(
      mergeReconstructedHistoryRows([], value).map((row) => row.childId),
    ).toEqual([child.childId]);
  });

  test("a throwing cache degrades the projection without failing reconstruction", async () => {
    const source = new FakeParentSession();
    await runCompletedChild(refStore(source, SOURCE_PARENT));
    const throwingCache: PiChildReconstructionCachePort = {
      upsertRef: () => {
        throw new Error("cache exploded");
      },
    };
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      cache: throwingCache,
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);
    expect(summary._unsafeUnwrap().counts.cachedRows).toBe(0);
    expect(summary._unsafeUnwrap().counts.reconstructedChildren).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Origin exclusion at the destination
// ---------------------------------------------------------------------------

describe("clone/fork destination — source-origin refs stay excluded", () => {
  test("a cloned destination reconstructs nothing from inherited source refs", async () => {
    const source = new FakeParentSession();
    await runCompletedChild(refStore(source, SOURCE_PARENT));

    // `/clone` copies the origin entries into the destination session.
    const destination = new FakeParentSession();
    source.cloneInto(destination);

    const destinationCache = await openCache();
    const summary = await reconstructParentLocalChildren({
      refs: refStore(destination, DESTINATION_PARENT),
      cache: destinationCache,
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);
    const value = summary._unsafeUnwrap();

    expect(value.children).toEqual([]);
    expect(value.counts.reconstructedChildren).toBe(0);
    expect(value.counts.cachedRows).toBe(0);
    expect(value.counts.originMismatchedChildren).toBe(1);
    expect(countParentLocalChildren([], value)).toBe(0);
    expect(renderReconstructedStatusLines([], value)).toEqual([]);
    expect(mergeReconstructedHistoryRows([], value)).toEqual([]);
    expect(cacheHistoryRows(destinationCache)).toEqual([]);
    destinationCache.close();
  });

  test("a mismatched explicit parent excludes refs the port would return", async () => {
    const source = new FakeParentSession();
    await runCompletedChild(refStore(source, SOURCE_PARENT));
    // Defence in depth: the ref port belongs to the source, but the live
    // parent is the destination.
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: WORKSPACE,
      parentSessionId: DESTINATION_PARENT,
    });
    expect(summary.isOk()).toBe(true);
    expect(summary._unsafeUnwrap().children).toEqual([]);
    expect(
      summary._unsafeUnwrap().counts.originMismatchedChildren,
    ).toBeGreaterThan(0);
  });

  test("destination children never appear in the source after return", async () => {
    const source = new FakeParentSession();
    await runCompletedChild(refStore(source, SOURCE_PARENT), "source-child");

    const destination = new FakeParentSession();
    source.cloneInto(destination);
    await runCompletedChild(
      refStore(destination, DESTINATION_PARENT),
      "destination-child",
    );

    const returned = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: WORKSPACE,
    });
    expect(returned.isOk()).toBe(true);
    expect(returned._unsafeUnwrap().children.map((c) => c.childId)).toEqual([
      "source-child",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Idempotence and generation scoping
// ---------------------------------------------------------------------------

describe("repeated transitions stay idempotent", () => {
  test("reconstructing three times writes no duplicate cache or history rows", async () => {
    const source = new FakeParentSession();
    await runCompletedChild(refStore(source, SOURCE_PARENT));
    const cache = await openCache();

    for (let pass = 0; pass < 3; pass += 1) {
      const summary = await reconstructParentLocalChildren({
        refs: refStore(source, SOURCE_PARENT),
        cache,
        workspaceKey: WORKSPACE,
      });
      expect(summary.isOk()).toBe(true);
      expect(summary._unsafeUnwrap().children).toHaveLength(1);
      const rows = mergeReconstructedHistoryRows(
        cacheHistoryRows(cache),
        summary._unsafeUnwrap(),
      );
      expect(rows).toHaveLength(1);
      expect(countParentLocalChildren([], summary._unsafeUnwrap())).toBe(1);
    }
    expect(cacheHistoryRows(cache)).toHaveLength(1);
    cache.close();
  });

  test("a live child is never double-counted by its own reconstructed ref", async () => {
    const source = new FakeParentSession();
    const child = await runCompletedChild(refStore(source, SOURCE_PARENT));
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);
    const tree = [{ id: child.childId }];
    expect(countParentLocalChildren(tree, summary._unsafeUnwrap())).toBe(1);
    expect(reconstructedChildrenNotLive(tree, summary._unsafeUnwrap())).toEqual(
      [],
    );
  });

  test("cache rows win over reconstructed rows on the same child id", async () => {
    const source = new FakeParentSession();
    const child = await runCompletedChild(refStore(source, SOURCE_PARENT));
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);
    const rows = mergeReconstructedHistoryRows(
      [
        {
          childId: child.childId,
          status: "tombstoned",
          title: "cached title",
          tombstoned: true,
        },
      ],
      summary._unsafeUnwrap(),
    );
    expect(rows).toEqual([
      {
        childId: child.childId,
        status: "tombstoned",
        title: "cached title",
        tombstoned: true,
      },
    ]);
  });
});

describe("generation scoping", () => {
  test("only the owning generation and live parent may read a summary", async () => {
    const source = new FakeParentSession();
    await runCompletedChild(refStore(source, SOURCE_PARENT));
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);

    const cell = createChildReconstructionCell();
    expect(
      readChildReconstruction(cell, SOURCE_GENERATION, SOURCE_PARENT),
    ).toBeUndefined();

    publishChildReconstruction(
      cell,
      SOURCE_GENERATION,
      summary._unsafeUnwrap(),
    );
    expect(
      readChildReconstruction(cell, SOURCE_GENERATION, SOURCE_PARENT),
    ).toBeDefined();
    // A stale callback from a revoked generation reads nothing.
    expect(
      readChildReconstruction(cell, RETURN_GENERATION, SOURCE_PARENT),
    ).toBeUndefined();
    // A destination generation holding the cell reads nothing.
    expect(
      readChildReconstruction(cell, SOURCE_GENERATION, DESTINATION_PARENT),
    ).toBeUndefined();
    expect(
      readChildReconstruction(cell, DESTINATION_GENERATION, DESTINATION_PARENT),
    ).toBeUndefined();
    expect(
      readChildReconstruction(cell, SOURCE_GENERATION, undefined),
    ).toBeUndefined();
    expect(
      readChildReconstruction(cell, undefined, SOURCE_PARENT),
    ).toBeUndefined();

    clearChildReconstruction(cell);
    expect(
      readChildReconstruction(cell, SOURCE_GENERATION, SOURCE_PARENT),
    ).toBeUndefined();
    // Idempotent.
    clearChildReconstruction(cell);
    expect(cell.generationId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fail-closed diagnostics and bounds
// ---------------------------------------------------------------------------

describe("fail-closed, bounded, metadata-only", () => {
  test("an unusable authoritative source yields no reconstructed child", async () => {
    const source = new FakeParentSession();
    await runCompletedChild(refStore(source, SOURCE_PARENT));
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT, unusableAuthority("missing")),
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);
    expect(summary._unsafeUnwrap().children).toEqual([]);
    expect(summary._unsafeUnwrap().counts.usableRefs).toBe(0);
  });

  test("a corrupt parent ledger fails closed with a typed bounded diagnostic", async () => {
    const throwingSession = {
      getEntries: () => {
        throw new Error("session unavailable");
      },
      appendEntry: () => undefined,
    };
    const store = new PiChildSessionRefStore({
      storage: TEST_ONLY_DESCRIPTOR_SAFE_SESSION_STORAGE_AUTHORITY,
      parentSessionId: SOURCE_PARENT,
      append: throwingSession,
      read: throwingSession,
      authority: availableAuthority(),
    });
    const summary = await reconstructParentLocalChildren({
      refs: store,
      workspaceKey: WORKSPACE,
    });
    expect(summary.isErr()).toBe(true);
    const error = summary._unsafeUnwrapErr();
    expect(error.type).toBe("ReconstructionRefsUnreadable");
    const message = describeChildReconstructionError(error);
    expect(message.includes("session unavailable")).toBe(false);
    expect(message.length).toBeLessThan(200);
  });

  test("an empty parent session id or workspace key fails closed", async () => {
    const source = new FakeParentSession();
    const emptyParent = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: WORKSPACE,
      parentSessionId: "",
    });
    expect(emptyParent.isErr()).toBe(true);
    expect(emptyParent._unsafeUnwrapErr()).toEqual({
      type: "ReconstructionParentUnavailable",
      reason: "empty-parent-session-id",
    });

    const emptyWorkspace = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: "",
    });
    expect(emptyWorkspace.isErr()).toBe(true);
    expect(emptyWorkspace._unsafeUnwrapErr()).toEqual({
      type: "ReconstructionParentUnavailable",
      reason: "empty-workspace-key",
    });
  });

  test("reconstructed children and rendered surfaces carry no transcript text", async () => {
    const source = new FakeParentSession();
    await runCompletedChild(refStore(source, SOURCE_PARENT));
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);
    const child = summary._unsafeUnwrap().children[0];
    expect(child).toBeDefined();
    expect(Object.keys(child ?? {}).sort()).toEqual(
      [
        "childId",
        "createdAt",
        "originParentSessionId",
        "settledAt",
        "status",
        "threadId",
        "title",
        "titleProvenance",
        "updatedAt",
      ].sort(),
    );
  });

  test("history and status renders stay inside their declared bounds", async () => {
    const source = new FakeParentSession();
    const store = refStore(source, SOURCE_PARENT);
    const total = PI_CHILD_RECONSTRUCTION_BOUNDS.maxStatusLines + 5;
    for (let index = 0; index < total; index += 1) {
      await runCompletedChild(store, `child-${index}`);
    }
    const summary = await reconstructParentLocalChildren({
      refs: refStore(source, SOURCE_PARENT),
      workspaceKey: WORKSPACE,
    });
    expect(summary.isOk()).toBe(true);
    const value = summary._unsafeUnwrap();
    expect(value.children).toHaveLength(total);

    const lines = renderReconstructedStatusLines([], value);
    expect(lines).toHaveLength(
      PI_CHILD_RECONSTRUCTION_BOUNDS.maxStatusLines + 1,
    );
    expect(lines.at(-1)).toBe("  … 5 more");

    const rows = mergeReconstructedHistoryRows([], value);
    expect(rows.length).toBeLessThanOrEqual(
      PI_CHILD_RECONSTRUCTION_BOUNDS.maxHistoryRows,
    );
  });
});
