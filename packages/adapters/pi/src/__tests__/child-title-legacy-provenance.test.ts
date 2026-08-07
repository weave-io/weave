/**
 * Legacy durable-title provenance (Threat Model T6, Warp blocker 1).
 *
 * Refs and cache rows written before the durable-title fix stored a bounded
 * first line of the delegated task. Those rows still exist on disk, so a
 * stored title is prompt content until its provenance is proven from trusted
 * identity. Every test here starts from a *real serialized* legacy shape - the
 * exact JSON a pre-fix adapter appended into a parent session or wrote into
 * the SQLite cache - and asserts the sentinel cannot reach any sink.
 */

import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  createPiAdapterCommandHandlers,
  createPiChildrenCommandPort,
  PI_ADAPTER_COMMAND_NAMES,
} from "../adapter-cli-commands.js";
import {
  childMetadataRecordFromRef,
  FakePiChildMetadataCacheFs,
  openBunChildMetadataDatabase,
  openPiChildMetadataCache,
  parseChildMetadataRecord,
} from "../child-metadata-cache.js";
import {
  buildChildPickerMetadataEntries,
  collectChildPickerCandidates,
} from "../child-picker.js";
import {
  mergeReconstructedHistoryRows,
  reconstructParentLocalChildren,
  renderReconstructedStatusLines,
} from "../child-session-reconstruction.js";
import {
  PI_CHILD_REF_ENTRY_TYPE,
  PI_CHILD_REF_SCHEMA_VERSION,
  type PiChildRefAppendPort,
  type PiChildRefEntryReadPort,
  type PiChildRefRecord,
  type PiChildRefScan,
  PiChildSessionRefStore,
  parseChildRefEnvelope,
  parseChildRefRecord,
} from "../child-session-refs.js";
import {
  enforceDurableChildTitle,
  isProvenDurableChildTitle,
  resolveDurableChildTitle,
} from "../child-title.js";

// ---------------------------------------------------------------------------
// The legacy row
// ---------------------------------------------------------------------------

const PARENT = "parent-session-legacy";
const WORKSPACE = "workspace-legacy";
const CHILD_ID = "child-legacy-77";
const THREAD_ID = "thread-legacy-77";
const SESSION_REF = "child-legacy-77/session.jsonl";

/** Unique sentinel standing in for the task text a legacy title captured. */
const TASK_SENTINEL = "LEGACY_TASK_SENTINEL_WARP_T6_77";

/** Exactly what `childPickerTaskFirstLine(task)` used to persist. */
const LEGACY_TITLE = `Investigate ${TASK_SENTINEL} in packages/adapters/pi`;

/** The only title this row may ever expose once its provenance is checked. */
const SAFE_TITLE = resolveDurableChildTitle({ threadId: THREAD_ID });

/** A post-fix title for the same row: trusted agent identity plus suffix. */
const PROVEN_TITLE = resolveDurableChildTitle({
  agentName: "shuttle",
  threadId: THREAD_ID,
});

function expectSentinelAbsent(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(TASK_SENTINEL);
  expect(text).not.toContain("Investigate ");
}

/** The serialized parent custom entry a pre-fix adapter actually appended. */
function legacyEntryJson(title: string = LEGACY_TITLE): string {
  return JSON.stringify({
    type: "custom",
    customType: PI_CHILD_REF_ENTRY_TYPE,
    data: {
      schemaVersion: PI_CHILD_REF_SCHEMA_VERSION,
      entryType: PI_CHILD_REF_ENTRY_TYPE,
      kind: "new-child",
      sequence: 1,
      appendedAt: 1_000,
      record: {
        childId: CHILD_ID,
        threadId: THREAD_ID,
        nativeSessionId: "native-legacy-77",
        sessionRef: SESSION_REF,
        originParentSessionId: PARENT,
        originEntryId: "entry-legacy-77",
        title,
        status: "completed",
        createdAt: 1_000,
        updatedAt: 2_000,
        settledAt: 2_000,
        runs: [{ run: 1, action: "start", startedAt: 1_000 }],
      },
    },
  });
}

/** The serialized cache row a pre-fix adapter actually stored. */
function legacyCacheRowJson(title: string = LEGACY_TITLE): string {
  return JSON.stringify({
    childId: CHILD_ID,
    threadId: THREAD_ID,
    nativeSessionId: "native-legacy-77",
    sessionRef: SESSION_REF,
    originParentSessionId: PARENT,
    originEntryId: "entry-legacy-77",
    workspaceKey: WORKSPACE,
    title,
    status: "completed",
    createdAt: 1_000,
    updatedAt: 2_000,
    settledAt: 2_000,
    runCount: 1,
    latestRunAction: "start",
    latestRunAt: 1_000,
    stale: false,
    tombstoned: false,
    cachedAt: 3_000,
  });
}

class FakeParentSession
  implements PiChildRefAppendPort, PiChildRefEntryReadPort
{
  private readonly entries: unknown[] = [];

  appendEntry(customType: string, data: unknown): void {
    this.entries.push({ type: "custom", customType, data });
  }

  getEntries(): readonly unknown[] {
    return this.entries;
  }

  seedRaw(entry: unknown): void {
    this.entries.push(entry);
  }
}

function legacyRefRecord(title: string = LEGACY_TITLE): PiChildRefRecord {
  const parsed = parseChildRefEnvelope(
    (JSON.parse(legacyEntryJson(title)) as { data: unknown }).data,
  );
  if (parsed.isErr()) throw new Error(JSON.stringify(parsed.error));
  return parsed.value.record;
}

// ---------------------------------------------------------------------------
// Proof itself
// ---------------------------------------------------------------------------

describe("stored durable title provenance", () => {
  it("never proves a legacy task-derived title", () => {
    expect(
      isProvenDurableChildTitle({ title: LEGACY_TITLE, threadId: THREAD_ID }),
    ).toBe(false);
    // Nor a bare identity with no binding to this row's own thread id.
    expect(
      isProvenDurableChildTitle({ title: "shuttle", threadId: THREAD_ID }),
    ).toBe(false);
    // Nor an identity bound to somebody else's thread id.
    expect(
      isProvenDurableChildTitle({
        title: resolveDurableChildTitle({
          agentName: "shuttle",
          threadId: "thread-other-99",
        }),
        threadId: THREAD_ID,
      }),
    ).toBe(false);
    // Nor a task line that merely ends with identity-looking text.
    expect(
      isProvenDurableChildTitle({
        title: `${TASK_SENTINEL} ${PROVEN_TITLE}`,
        threadId: THREAD_ID,
      }),
    ).toBe(false);
  });

  it("proves post-fix titles and leaves them byte-identical", () => {
    expect(
      isProvenDurableChildTitle({ title: PROVEN_TITLE, threadId: THREAD_ID }),
    ).toBe(true);
    expect(
      enforceDurableChildTitle({ title: PROVEN_TITLE, threadId: THREAD_ID }),
    ).toBe(PROVEN_TITLE);
    // The safe fallback is itself proven, so enforcement never drifts.
    expect(
      enforceDurableChildTitle({ title: SAFE_TITLE, threadId: THREAD_ID }),
    ).toBe(SAFE_TITLE);
    expect(
      enforceDurableChildTitle({
        title: enforceDurableChildTitle({
          title: LEGACY_TITLE,
          threadId: THREAD_ID,
        }),
        threadId: THREAD_ID,
      }),
    ).toBe(SAFE_TITLE);
  });

  it("has no anchor without a thread id, so it fails closed", () => {
    expect(isProvenDurableChildTitle({ title: PROVEN_TITLE })).toBe(false);
    expect(enforceDurableChildTitle({ title: LEGACY_TITLE })).toBe("child");
    expectSentinelAbsent(enforceDurableChildTitle({ title: LEGACY_TITLE }));
  });

  it("replaces the legacy title with identity-only text", () => {
    const safe = enforceDurableChildTitle({
      title: LEGACY_TITLE,
      threadId: THREAD_ID,
    });
    expect(safe).toBe(SAFE_TITLE);
    expect(safe).toBe("child-legacy77");
    expectSentinelAbsent(safe);
  });
});

// ---------------------------------------------------------------------------
// Boundary 1: refs
// ---------------------------------------------------------------------------

describe("ref boundary suppresses unproven legacy titles", () => {
  it("sanitizes a real serialized legacy envelope on parse", () => {
    const entry = JSON.parse(legacyEntryJson()) as { data: unknown };
    const parsed = parseChildRefEnvelope(entry.data);
    expect(parsed.isOk()).toBe(true);
    if (!parsed.isOk()) return;
    expect(parsed.value.record.title).toBe(SAFE_TITLE);
    expectSentinelAbsent(parsed.value);
    expectSentinelAbsent(JSON.stringify(parsed.value));
  });

  it("sanitizes a legacy record parsed on its own", () => {
    const record = JSON.parse(legacyEntryJson()) as {
      data: { record: unknown };
    };
    const parsed = parseChildRefRecord(record.data.record);
    expect(parsed.isOk()).toBe(true);
    if (!parsed.isOk()) return;
    expect(parsed.value.title).toBe(SAFE_TITLE);
    expectSentinelAbsent(parsed.value);
  });

  it("never returns a legacy title from a parent entry scan", async () => {
    const session = new FakeParentSession();
    session.seedRaw(JSON.parse(legacyEntryJson()));
    const store = new PiChildSessionRefStore({
      parentSessionId: PARENT,
      append: session,
      read: session,
      authority: { checkSource: () => okAsync("available" as const) },
      now: () => 5_000,
      newEntryId: () => "entry-new",
    });

    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.refs).toHaveLength(1);
    expect(scan.value.refs[0]?.title).toBe(SAFE_TITLE);
    expectSentinelAbsent(scan.value);
    expectSentinelAbsent(JSON.stringify(scan.value));
  });

  it("cannot re-persist a legacy title through a lifecycle update", async () => {
    const session = new FakeParentSession();
    const store = new PiChildSessionRefStore({
      parentSessionId: PARENT,
      append: session,
      read: session,
      authority: { checkSource: () => okAsync("available" as const) },
      now: () => 5_000,
      newEntryId: () => "entry-new",
    });
    const created = await store.appendNewChild({
      childId: CHILD_ID,
      threadId: THREAD_ID,
      nativeSessionId: "native-legacy-77",
      sessionRef: SESSION_REF,
      title: LEGACY_TITLE,
    });
    expect(created.isOk()).toBe(true);
    if (!created.isOk()) return;
    expect(created.value.title).toBe(SAFE_TITLE);

    const settled = await store.appendLifecycle(created.value, {
      status: "completed",
      title: LEGACY_TITLE,
    });
    expect(settled.isOk()).toBe(true);
    if (!settled.isOk()) return;
    expect(settled.value.title).toBe(SAFE_TITLE);
    expectSentinelAbsent(session.getEntries());
  });

  it("keeps a proven title stable across serialize and reparse", () => {
    const entry = JSON.parse(legacyEntryJson(PROVEN_TITLE)) as {
      data: unknown;
    };
    const parsed = parseChildRefEnvelope(entry.data);
    expect(parsed.isOk()).toBe(true);
    if (!parsed.isOk()) return;
    expect(parsed.value.record.title).toBe(PROVEN_TITLE);
    const again = parseChildRefEnvelope(
      JSON.parse(JSON.stringify(parsed.value)),
    );
    expect(again.isOk() && again.value.record.title).toBe(PROVEN_TITLE);
  });
});

// ---------------------------------------------------------------------------
// Boundary 2: cache
// ---------------------------------------------------------------------------

describe("cache boundary suppresses unproven legacy titles", () => {
  it("sanitizes a real serialized legacy cache row on parse", () => {
    const parsed = parseChildMetadataRecord(JSON.parse(legacyCacheRowJson()));
    expect(parsed.isOk()).toBe(true);
    if (!parsed.isOk()) return;
    expect(parsed.value.title).toBe(SAFE_TITLE);
    expectSentinelAbsent(parsed.value);
  });

  it("sanitizes independently of the ref boundary", () => {
    // A hand-built ref value that never passed `parseChildRefRecord` must not
    // reintroduce the sentinel through the cache projection: bypassing one
    // layer does not bypass the other.
    const unparsedRef = JSON.parse(legacyEntryJson()) as {
      data: { record: PiChildRefRecord };
    };
    expect(unparsedRef.data.record.title).toBe(LEGACY_TITLE);
    const projected = childMetadataRecordFromRef({
      ref: unparsedRef.data.record,
      workspaceKey: WORKSPACE,
      cachedAt: 3_000,
    });
    expect(projected.isOk()).toBe(true);
    if (!projected.isOk()) return;
    expect(projected.value.title).toBe(SAFE_TITLE);
    expectSentinelAbsent(projected.value);
  });

  it("never lists, shows, or reconstructs a legacy title from SQLite", async () => {
    const legacyRef = JSON.parse(legacyEntryJson()) as {
      data: { record: PiChildRefRecord };
    };
    const ref = legacyRef.data.record;
    const cacheOpen = await openPiChildMetadataCache({
      root: "/tmp/weave-task21-legacy-title",
      fs: new FakePiChildMetadataCacheFs(),
      authority: { checkSource: () => okAsync("available" as const) },
      source: {
        workspaceKey: WORKSPACE,
        parentSessionId: PARENT,
        readRefs: () => okAsync<readonly PiChildRefRecord[], never>([ref]),
      },
      openDatabase: () => openBunChildMetadataDatabase(":memory:"),
      now: () => 3_000,
    });
    if (cacheOpen.isErr()) throw new Error(JSON.stringify(cacheOpen.error));
    if (cacheOpen.value.mode !== "active") {
      throw new Error(JSON.stringify(cacheOpen.value.error));
    }
    const cache = cacheOpen.value.cache;
    expect(cache.upsertRef(ref, WORKSPACE).isOk()).toBe(true);

    const listed = cache.list({
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      limit: 10,
    });
    if (listed.isErr()) throw new Error(JSON.stringify(listed.error));
    expect(listed.value.records).toHaveLength(1);
    expect(listed.value.records[0]?.title).toBe(SAFE_TITLE);
    expectSentinelAbsent(listed.value.records);

    const scan: PiChildRefScan = {
      refs: [ref],
      issues: [],
      counts: {
        scannedEntries: 1,
        candidateEntries: 1,
        malformedEntries: 0,
        originMismatchedChildren: 0,
        conflictingChildren: 0,
        duplicateEntries: 0,
        unusableSourceChildren: 0,
        usableRefs: 1,
      },
    };
    const reconstructed = await reconstructParentLocalChildren({
      refs: {
        liveParentSessionId: () => PARENT,
        readRefs: () => okAsync(scan),
      },
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      cache,
    });
    if (reconstructed.isErr()) {
      throw new Error(JSON.stringify(reconstructed.error));
    }
    const summary = reconstructed.value;
    expect(summary.children[0]?.title).toBe(SAFE_TITLE);
    expectSentinelAbsent(summary);
    // `/weave:status` and `/weave:history` render from the same summary.
    expectSentinelAbsent(renderReconstructedStatusLines([], summary));
    expectSentinelAbsent(mergeReconstructedHistoryRows([], summary));

    // `children list`, `children show`, and `children find` project the same
    // cache rows through the adapter CLI.
    const handlers = createPiAdapterCommandHandlers({
      children: createPiChildrenCommandPort({
        cache,
        sessions: {
          openSession: () =>
            errAsync({ type: "SessionMissing" as const, ref: SESSION_REF }),
          readSessionEntryPage: () =>
            okAsync({ entries: [], bytesRead: 0, linesScanned: 0 }),
          deleteSession: () =>
            errAsync({ type: "SessionMissing" as const, ref: SESSION_REF }),
        },
        now: () => new Date(0),
      }),
    });
    const listResult = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenList](
      JSON.stringify({ workspaceKey: WORKSPACE }),
    );
    if (listResult.isErr()) throw new Error(JSON.stringify(listResult.error));
    expect(listResult.value).toContain(SAFE_TITLE);
    expectSentinelAbsent(listResult.value);
    expectSentinelAbsent(JSON.parse(listResult.value));

    const showResult = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenShow](
      JSON.stringify({ workspaceKey: WORKSPACE, childId: CHILD_ID }),
    );
    if (showResult.isErr()) throw new Error(JSON.stringify(showResult.error));
    expectSentinelAbsent(showResult.value);
    expectSentinelAbsent(JSON.parse(showResult.value));

    const findResult = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenResolve](
      JSON.stringify({ workspaceKey: WORKSPACE, childId: CHILD_ID }),
    );
    if (findResult.isErr()) throw new Error(JSON.stringify(findResult.error));
    expectSentinelAbsent(findResult.value);
    expectSentinelAbsent(JSON.parse(findResult.value));
  });
});

// ---------------------------------------------------------------------------
// Boundary 3: picker
// ---------------------------------------------------------------------------

describe("picker suppresses unproven legacy titles", () => {
  it("renders identity-only text for a legacy ref row", async () => {
    // The picker proves provenance for itself, so this row is handed to it
    // without passing the ref or cache parse boundary at all.
    const raw = JSON.parse(legacyEntryJson()) as {
      data: { record: PiChildRefRecord };
    };
    const candidates = await collectChildPickerCandidates({
      active: [],
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      refs: {
        readRefs: () =>
          okAsync<readonly PiChildRefRecord[], never>([raw.data.record]),
      },
    });
    if (candidates.isErr()) throw new Error(JSON.stringify(candidates.error));
    expect(candidates.value).toHaveLength(1);
    expect(candidates.value[0]?.explicitTitle).toBe(SAFE_TITLE);
    expect(candidates.value[0]?.agent).toBe(SAFE_TITLE);
    expectSentinelAbsent(candidates.value);

    const entries = buildChildPickerMetadataEntries({
      candidates: candidates.value,
      formatTimestamp: () => "now",
    });
    if (entries.isErr()) throw new Error(JSON.stringify(entries.error));
    expectSentinelAbsent(entries.value);
    expectSentinelAbsent(entries.value.map((entry) => entry.title));
  });

  it("keeps a proven ref title in the picker", async () => {
    const candidates = await collectChildPickerCandidates({
      active: [],
      workspaceKey: WORKSPACE,
      parentSessionId: PARENT,
      refs: {
        readRefs: () =>
          okAsync<readonly PiChildRefRecord[], never>([
            legacyRefRecord(PROVEN_TITLE),
          ]),
      },
    });
    if (candidates.isErr()) throw new Error(JSON.stringify(candidates.error));
    expect(candidates.value[0]?.explicitTitle).toBe(PROVEN_TITLE);
  });
});
