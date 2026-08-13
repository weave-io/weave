/**
 * Integrity coverage for durable child results.
 *
 * Three properties are proven here, each of which a bounded, paged reader can
 * otherwise quietly lose:
 *
 * 1. **Exact-cap recovery.** A group at the retained aggregate ceiling must be
 *    provable even when every payload byte takes its worst-case JSON escape.
 *    The scan budget is derived from what *paging* that encoded maximum costs,
 *    per pass, so it cannot be exhausted by an earlier pass or by the bounded
 *    bytes each page boundary re-reads.
 * 2. **Retrieval identity.** A read is authorized by the exact child, native
 *    session, and origin parent, never by reachability; every byte of the
 *    read comes from that one authorized leaf; and a continuation cursor is
 *    bound to that identity and to the exact commit.
 * 3. **Commit atomicity.** A commit that reached a leaf other than the one it
 *    was authorized against is never acceptable, so a replacement during the
 *    commit leaves no readable committed result.
 */

import { describe, expect, test } from "bun:test";
import {
  PI_NATIVE_RESULT_GROUP_BOUNDS,
  PI_NATIVE_RESULT_MAX_ENCODED_ENTRY_BYTES,
  PI_NATIVE_RESULT_MAX_ENCODED_GROUP_BYTES,
  PI_NATIVE_RESULT_SCHEMA_VERSION,
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS,
  PI_NATIVE_SESSION_MAX_RANGE_LENGTH,
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  type PiNativeSessionHostPort,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";
import {
  RESULT_FIXTURE_CHUNK_BYTES,
  seedResultGroupSession,
  splitResultFixtureChunks,
} from "./fakes/result-group-fixture.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const PARENT = "parent-session-1";
const REF = "child-1/session.jsonl";
const DIR = `${ROOT}/child-1`;
const FILE = "session.jsonl";
const textEncoder = new TextEncoder();

const IDENTITY = {
  childId: "child-1",
  nativeSessionId: "native-session-1",
  parentSession: PARENT,
} as const;

function headerLine(): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: IDENTITY.nativeSessionId,
    cwd: "/repo",
    parentSession: PARENT,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
}

class ForbiddenHost implements PiNativeSessionHostPort {
  create(): PiNativeSessionHandle {
    throw new Error("host.create must not be called by a bounded read");
  }

  open(): PiNativeSessionHandle {
    throw new Error("host.open must not be called by a bounded read");
  }
}

function storeFor(fs: PiNativeSessionFsPort): PiNativeSessionStore {
  return new PiNativeSessionStore({
    root: ROOT,
    fs,
    host: new ForbiddenHost(),
  });
}

/** Counts the session bytes each scan pass actually asks the port for. */
class PassRecordingFs implements PiNativeSessionFsPort {
  readonly readLengths: number[] = [];

  constructor(private readonly inner: MemoryPiNativeSessionFs) {}

  get readTotal(): number {
    return this.readLengths.reduce((total, next) => total + next, 0);
  }

  openDirectory(path: string, create: boolean) {
    return this.inner.openDirectory(path, create).map((directory) => {
      const recorder = this;
      return {
        ...directory,
        openFile(name: string) {
          return directory.openFile(name).map((handle) => {
            if (handle === undefined) return undefined;
            return {
              identity: handle.identity,
              stat: () => handle.stat(),
              readRange: (offset: number, length: number) => {
                recorder.readLengths.push(length);
                return handle.readRange(offset, length);
              },
              close: () => handle.close(),
            };
          });
        },
      };
    });
  }
}

/**
 * Replaces the session leaf exactly once, immediately after the read's Nth
 * content read. Also records how many times the leaf was resolved by name and
 * which storage identities the read actually pulled bytes from.
 */
class LeafSwapAfterReadsFs implements PiNativeSessionFsPort {
  /** Storage inode of every leaf this read resolved by name. */
  readonly openedInodes: number[] = [];
  /** Distinct storage inodes the read actually pulled bytes from. */
  readonly readInodes = new Set<number>();
  private reads = 0;
  private swapped = false;

  constructor(
    private readonly inner: MemoryPiNativeSessionFs,
    private readonly directory: string,
    private readonly fileName: string,
    private readonly swapAfterReads: number,
  ) {}

  openDirectory(path: string, create: boolean) {
    return this.inner.openDirectory(path, create).map((directory) => {
      const recorder = this;
      return {
        ...directory,
        openFile(name: string) {
          return directory.openFile(name).map((handle) => {
            if (handle === undefined) return undefined;
            recorder.openedInodes.push(handle.identity.ino);
            return {
              identity: handle.identity,
              stat: () => handle.stat(),
              readRange: (offset: number, length: number) =>
                handle.readRange(offset, length).map((range) => {
                  recorder.readInodes.add(range.identity.ino);
                  recorder.reads += 1;
                  if (
                    !recorder.swapped &&
                    recorder.reads >= recorder.swapAfterReads
                  ) {
                    recorder.swapped = true;
                    recorder.inner.simulateFileReplacement(
                      recorder.directory,
                      recorder.fileName,
                    );
                  }
                  return range;
                }),
              close: () => handle.close(),
            };
          });
        },
      };
    });
  }
}

// ---------------------------------------------------------------------------
// 1. Exact-cap recovery
// ---------------------------------------------------------------------------

/**
 * Models what one bounded pass actually reads while paging a session region.
 *
 * A pass does not read the region once. Each page stops on its own byte
 * ceiling (leaving a partial line the next page reads again) or on its entry
 * limit (leaving the tail of the range chunk it already pulled). So a pass
 * pays for every region byte once *plus* a bounded re-read per page boundary,
 * and the page count is driven by how much a page is guaranteed to consume.
 */
function modelPass(input: {
  readonly regionBytes: number;
  readonly regionEntries: number;
}): {
  readonly reread: number;
  readonly progressFloor: number;
  readonly pages: number;
  readonly bytes: number;
} {
  const reread =
    PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes +
    PI_NATIVE_SESSION_MAX_RANGE_LENGTH;
  const progressFloor =
    PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned - reread;
  const pages =
    Math.ceil(input.regionBytes / progressFloor) +
    Math.ceil(
      input.regionEntries / PI_NATIVE_RESULT_GROUP_BOUNDS.scanPageSize,
    ) +
    2;
  return {
    reread,
    progressFloor,
    pages,
    bytes: input.regionBytes + pages * reread,
  };
}

describe("result scan budgets clear the retained cap at worst-case encoding", () => {
  /**
   * Builds one real chunk entry whose payload is entirely `U+0001`, the byte
   * with the longest JSON escape. This is the exact production line shape, so
   * the measurement below is of real encoded bytes and not of an estimate.
   */
  function worstCaseChunkLineBytes(): number {
    const line = JSON.stringify({
      type: "custom",
      customType: "weave.child.result-chunk",
      data: {
        schemaVersion: PI_NATIVE_RESULT_SCHEMA_VERSION,
        resultId: "44444444-4444-4444-8444-444444444444",
        index: 1_365,
        total: 1_366,
        byteLength: 64 * 1_024 * 1_024,
        digest: "a".repeat(64),
        content: "\u0001".repeat(RESULT_FIXTURE_CHUNK_BYTES),
      },
    });
    // The JSONL record is the line plus its terminating newline.
    return textEncoder.encode(line).byteLength + 1;
  }

  test("one fully escaped chunk still fits the per-entry and per-line ceilings", () => {
    const measured = worstCaseChunkLineBytes();

    expect({
      withinDerivedEntryCeiling:
        measured <= PI_NATIVE_RESULT_MAX_ENCODED_ENTRY_BYTES,
      withinPageLineCeiling:
        measured <= PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes,
      // A page must be able to hold at least one such line, or no scan could
      // ever make progress through an escape-heavy group.
      pageCanHoldOne:
        measured <= PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned,
    }).toEqual({
      withinDerivedEntryCeiling: true,
      withinPageLineCeiling: true,
      pageCanHoldOne: true,
    });
  });

  test("the per-pass byte budget clears the paged cost of a fully escaped group", () => {
    // Measured worst case for a whole 64 MiB group: every chunk fully
    // escaped, plus the commit line. This is the *group* size, which is not
    // by itself what a pass reads - see `modelPass`.
    const worstCaseGroupBytes =
      worstCaseChunkLineBytes() * (PI_NATIVE_RESULT_GROUP_BOUNDS.maxChunks + 1);
    const modeled = modelPass({
      regionBytes: worstCaseGroupBytes,
      regionEntries: PI_NATIVE_RESULT_GROUP_BOUNDS.maxChunks + 1,
    });

    expect({
      derivedCeilingCoversMeasured:
        PI_NATIVE_RESULT_MAX_ENCODED_GROUP_BYTES >= worstCaseGroupBytes,
      // The budget must cover paged I/O, not just the group's raw size.
      passBudgetCoversPagedCost:
        PI_NATIVE_RESULT_GROUP_BOUNDS.maxScanBytesPerPass >= modeled.bytes,
      passPageBudgetCoversPagedPages:
        PI_NATIVE_RESULT_GROUP_BOUNDS.maxScanPagesPerPass >= modeled.pages,
      // Regression guard on the reproduced defect: a budget sized as "group
      // plus slack" (438,098,944 bytes) is below what paging this group
      // actually costs, because a fully escaped entry is ~295 KiB and only a
      // few fit in one 1 MiB page.
      rawGroupSizedBudgetWouldHaveFailed: 438_098_944 < modeled.bytes,
      // The reproduced worst case needed at least 604,340,224 bytes.
      coversReproducedRequirement:
        PI_NATIVE_RESULT_GROUP_BOUNDS.maxScanBytesPerPass >= 604_340_224,
      // Regression guard on the earlier defect: a single shared budget of
      // 128 MiB could not have covered even one pass of this group.
      oldSharedBudgetWouldHaveFailed:
        128 * 1_024 * 1_024 <
        worstCaseGroupBytes * PI_NATIVE_RESULT_GROUP_BOUNDS.scanPasses,
      // Every pass gets the full budget, so no pass inherits another's spend.
      passesAreIndependent: PI_NATIVE_RESULT_GROUP_BOUNDS.scanPasses === 2,
    }).toEqual({
      derivedCeilingCoversMeasured: true,
      passBudgetCoversPagedCost: true,
      passPageBudgetCoversPagedPages: true,
      rawGroupSizedBudgetWouldHaveFailed: true,
      coversReproducedRequirement: true,
      oldSharedBudgetWouldHaveFailed: true,
      passesAreIndependent: true,
    });
  });

  test("the paging model the budget is derived from is itself finite", () => {
    const measuredLine = worstCaseChunkLineBytes();
    const modeled = modelPass({
      regionBytes: measuredLine * (PI_NATIVE_RESULT_GROUP_BOUNDS.maxChunks + 1),
      regionEntries: PI_NATIVE_RESULT_GROUP_BOUNDS.maxChunks + 1,
    });

    expect({
      // A page consumes region bytes only because its ceiling is larger than
      // the bytes a boundary can re-read; without this the page count would
      // not converge.
      progressFloorPositive:
        PI_NATIVE_RESULT_GROUP_BOUNDS.scanPageProgressFloorBytes > 0,
      productionFloorMatchesModel:
        PI_NATIVE_RESULT_GROUP_BOUNDS.scanPageProgressFloorBytes ===
        modeled.progressFloor,
      productionRereadMatchesModel:
        PI_NATIVE_RESULT_GROUP_BOUNDS.scanPageRereadBytes === modeled.reread,
      // Every page still fits at least one whole worst-case entry, so a scan
      // always advances.
      pageHoldsOneWorstCaseEntry:
        measuredLine <=
        PI_NATIVE_RESULT_GROUP_BOUNDS.scanPageProgressFloorBytes,
      // Bounds stay finite: pages and bytes are both real numbers, not
      // "unbounded until the file ends".
      pagesFinite: Number.isSafeInteger(
        PI_NATIVE_RESULT_GROUP_BOUNDS.maxScanPagesPerPass,
      ),
      bytesFinite: Number.isSafeInteger(
        PI_NATIVE_RESULT_GROUP_BOUNDS.maxScanBytesPerPass,
      ),
      // Memory per page is unchanged; only the I/O ceiling grew.
      pageMemoryUnchanged:
        PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned === 1_024 * 1_024,
    }).toEqual({
      progressFloorPositive: true,
      productionFloorMatchesModel: true,
      productionRereadMatchesModel: true,
      pageHoldsOneWorstCaseEntry: true,
      pagesFinite: true,
      bytesFinite: true,
      pageMemoryUnchanged: true,
    });
  });

  test("a real escape-heavy read stays inside the modeled paged budget", async () => {
    // The model is only worth anything if measured paging obeys it. This
    // reads a real multi-page group whose entry lines are large enough that
    // only a few fit in one page - the shape that broke the old budget.
    const output = "\u0001".repeat(RESULT_FIXTURE_CHUNK_BYTES * 8);
    const memory = new MemoryPiNativeSessionFs();
    const seeded = await seedResultGroupSession({
      fs: memory,
      directory: DIR,
      fileName: FILE,
      headerLine: headerLine(),
      identity: IDENTITY,
      output,
    });
    const recording = new PassRecordingFs(memory);
    const store = storeFor(recording);

    const group = (
      await store.readResultGroup(REF, IDENTITY, { content: true })
    )._unsafeUnwrap();
    const encodedBytes =
      (
        await memory
          .openDirectory(DIR, false)
          .andThen((directory) => directory.statFile(FILE))
      )._unsafeUnwrap()?.size ?? 0;
    const modeled = modelPass({
      regionBytes: encodedBytes,
      regionEntries: seeded.total + 2,
    });

    expect({
      status: group.status,
      entryLinesExceedAThirdOfAPage:
        encodedBytes / seeded.total >
        PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned / 4,
      withinModeledPasses:
        recording.readTotal <=
        modeled.bytes * PI_NATIVE_RESULT_GROUP_BOUNDS.scanPasses,
      // Sequential paging reads the session about twice - once backward, once
      // forward - instead of paying an anchor re-read on every page.
      noAnchorRereadBlowup:
        recording.readTotal <
        encodedBytes * PI_NATIVE_RESULT_GROUP_BOUNDS.scanPasses +
          PI_NATIVE_RESULT_GROUP_BOUNDS.scanPageRereadBytes * 8,
    }).toEqual({
      status: "complete",
      entryLinesExceedAThirdOfAPage: true,
      withinModeledPasses: true,
      noAnchorRereadBlowup: true,
    });
  });

  test("verifies and returns escape-heavy content exactly through bounded pages", async () => {
    // Real end-to-end proof at a size the in-memory port can hold: content
    // made only of the worst-escaping byte, spanning many chunks.
    const output = "\u0001".repeat(RESULT_FIXTURE_CHUNK_BYTES * 4 + 17);
    const memory = new MemoryPiNativeSessionFs();
    const seeded = await seedResultGroupSession({
      fs: memory,
      directory: DIR,
      fileName: FILE,
      headerLine: headerLine(),
      identity: IDENTITY,
      output,
    });
    const recording = new PassRecordingFs(memory);
    const store = storeFor(recording);

    let cursor: string | undefined;
    let reconstructed = "";
    let pages = 0;
    for (;;) {
      const page = (
        await store.readResultGroup(REF, IDENTITY, {
          content: true,
          // Two chunks per window, so the exact bytes are reassembled across
          // several bounded continuations rather than one whole read.
          maxContentBytes: RESULT_FIXTURE_CHUNK_BYTES * 2,
          ...(cursor === undefined ? {} : { cursor }),
        })
      )._unsafeUnwrap();
      if (page.status !== "complete") throw new Error(page.reason);
      reconstructed += page.content ?? "";
      pages += 1;
      cursor = page.nextCursor;
      if (cursor === undefined) break;
      if (pages > 32) throw new Error("unbounded paging");
    }

    expect({
      exact: reconstructed === output,
      chunks: seeded.total,
      multiplePages: pages > 1,
      // Every continuation is itself a bounded two-pass read, and each one
      // stays inside the modeled paged cost of this session.
      withinPassBudget:
        recording.readTotal <=
        modelPass({
          regionBytes: RESULT_FIXTURE_CHUNK_BYTES * 6 * (seeded.total + 2),
          regionEntries: seeded.total + 2,
        }).bytes *
          PI_NATIVE_RESULT_GROUP_BOUNDS.scanPasses *
          pages,
    }).toEqual({
      exact: true,
      chunks: 5,
      multiplePages: true,
      withinPassBudget: true,
    });
  });

  test("accepts a group whose encoded size exceeds the old shared budget", async () => {
    // The encoded session here is larger than one old-style shared budget
    // slice would have allowed a two-pass scan to spend, at a size the test
    // can actually materialize.
    const output = "\u0001".repeat(2 * 1_024 * 1_024);
    const memory = new MemoryPiNativeSessionFs();
    await seedResultGroupSession({
      fs: memory,
      directory: DIR,
      fileName: FILE,
      headerLine: headerLine(),
      identity: IDENTITY,
      output,
    });
    const store = storeFor(memory);

    const group = (await store.readResultGroup(REF, IDENTITY))._unsafeUnwrap();
    const encodedBytes = (
      await memory
        .openDirectory(DIR, false)
        .andThen((directory) => directory.statFile(FILE))
    )._unsafeUnwrap()?.size;

    expect({
      status: group.status,
      byteLength: group.status === "complete" ? group.summary.byteLength : 0,
      encodedIsMuchLarger: (encodedBytes ?? 0) > 6 * 1_024 * 1_024,
    }).toEqual({
      status: "complete",
      byteLength: textEncoder.encode(output).byteLength,
      encodedIsMuchLarger: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Retrieval identity
// ---------------------------------------------------------------------------

describe("durable result retrieval is authorized by identity, not reachability", () => {
  async function seeded(): Promise<{
    readonly store: PiNativeSessionStore;
    readonly digest: string;
    readonly resultId: string;
  }> {
    const memory = new MemoryPiNativeSessionFs();
    const group = await seedResultGroupSession({
      fs: memory,
      directory: DIR,
      fileName: FILE,
      headerLine: headerLine(),
      identity: IDENTITY,
      output: "AUTHORITATIVE",
    });
    return {
      store: storeFor(memory),
      digest: group.digest,
      resultId: group.resultId,
    };
  }

  function encodeCursor(value: Record<string, unknown>): string {
    return btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
  }

  test("returns the result only for the exact proven identity", async () => {
    const { store } = await seeded();

    const exact = (await store.readResultGroup(REF, IDENTITY))._unsafeUnwrap();

    expect({
      status: exact.status,
      content: (
        await store.readResultGroup(REF, IDENTITY, { content: true })
      )._unsafeUnwrap(),
    }).toMatchObject({
      status: "complete",
      content: { status: "complete", content: "AUTHORITATIVE" },
    });
  });

  test("refuses a sibling child or a different native session under the same parent", async () => {
    const { store } = await seeded();

    const siblingChild = await store.readResultGroup(REF, {
      ...IDENTITY,
      childId: "child-2",
    });
    const otherSession = await store.readResultGroup(REF, {
      ...IDENTITY,
      nativeSessionId: "native-session-2",
    });
    const otherParent = await store.readResultGroup(REF, {
      ...IDENTITY,
      parentSession: "parent-session-2",
    });

    expect({
      siblingChild: siblingChild._unsafeUnwrapErr(),
      otherSession: otherSession._unsafeUnwrapErr(),
      otherParent: otherParent._unsafeUnwrapErr(),
    }).toEqual({
      siblingChild: {
        type: "SessionCorrupt",
        ref: REF,
        reason: "identity-mismatch",
      },
      otherSession: {
        type: "SessionCorrupt",
        ref: REF,
        reason: "identity-mismatch",
      },
      // A different origin parent is refused by the session header itself.
      otherParent: {
        type: "SessionCorrupt",
        ref: REF,
        reason: "parent-session-mismatch",
      },
    });
  });

  test("mints continuation cursors bound to the identity and the exact commit", async () => {
    const memory = new MemoryPiNativeSessionFs();
    const group = await seedResultGroupSession({
      fs: memory,
      directory: DIR,
      fileName: FILE,
      headerLine: headerLine(),
      identity: IDENTITY,
      output: "P".repeat(RESULT_FIXTURE_CHUNK_BYTES * 3),
    });
    const store = storeFor(memory);

    const first = (
      await store.readResultGroup(REF, IDENTITY, {
        content: true,
        maxContentBytes: RESULT_FIXTURE_CHUNK_BYTES,
      })
    )._unsafeUnwrap();
    if (first.status !== "complete" || first.nextCursor === undefined) {
      throw new Error("expected a continuation cursor");
    }
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(first.nextCursor.replace(/-/g, "+").replace(/_/g, "/")),
          (character) => character.charCodeAt(0),
        ),
      ),
    ) as Record<string, unknown>;

    expect(decoded).toEqual({
      v: 2,
      childId: IDENTITY.childId,
      nativeSessionId: IDENTITY.nativeSessionId,
      parentSession: IDENTITY.parentSession,
      resultId: group.resultId,
      digest: group.digest,
      chunkIndex: 1,
    });
  });

  test("refuses a cursor from another child, another session, or a changed commit", async () => {
    const { store, digest, resultId } = await seeded();
    const base = {
      v: 2,
      ...IDENTITY,
      resultId,
      digest,
      chunkIndex: 0,
    };

    const crossChild = await store.readResultGroup(REF, IDENTITY, {
      content: true,
      cursor: encodeCursor({ ...base, childId: "child-2" }),
    });
    const crossSession = await store.readResultGroup(REF, IDENTITY, {
      content: true,
      cursor: encodeCursor({ ...base, nativeSessionId: "native-session-2" }),
    });
    const crossParent = await store.readResultGroup(REF, IDENTITY, {
      content: true,
      cursor: encodeCursor({ ...base, parentSession: "parent-session-2" }),
    });
    const changedCommitDigest = await store.readResultGroup(REF, IDENTITY, {
      content: true,
      cursor: encodeCursor({ ...base, digest: "0".repeat(64) }),
    });
    const changedCommitResult = await store.readResultGroup(REF, IDENTITY, {
      content: true,
      cursor: encodeCursor({
        ...base,
        resultId: "55555555-5555-4555-8555-555555555555",
      }),
    });
    // A version 1 cursor no longer carries identity at all, so it is not a
    // stale continuation; it is undecodable.
    const legacy = await store.readResultGroup(REF, IDENTITY, {
      content: true,
      cursor: encodeCursor({ v: 1, resultId, chunkIndex: 0 }),
    });

    const identityMismatch = {
      type: "SessionCorrupt",
      ref: REF,
      reason: "identity-mismatch",
    } as const;
    const staleCursor = {
      type: "SessionCorrupt",
      ref: REF,
      reason: "stale-cursor",
    } as const;
    expect({
      crossChild: crossChild._unsafeUnwrapErr(),
      crossSession: crossSession._unsafeUnwrapErr(),
      crossParent: crossParent._unsafeUnwrapErr(),
      changedCommitDigest: changedCommitDigest._unsafeUnwrapErr(),
      changedCommitResult: changedCommitResult._unsafeUnwrapErr(),
      legacy: legacy._unsafeUnwrapErr(),
    }).toEqual({
      crossChild: identityMismatch,
      crossSession: identityMismatch,
      crossParent: identityMismatch,
      changedCommitDigest: staleCursor,
      changedCommitResult: staleCursor,
      legacy: {
        type: "SessionCorrupt",
        ref: REF,
        reason: "invalid-cursor",
      } as const,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Commit atomicity
// ---------------------------------------------------------------------------

/**
 * A host whose appends land as real JSONL lines in the memory port, so a
 * commit written during a leaf swap is genuinely durable and can be read back
 * by an independent reader afterwards.
 */
class WritingHost implements PiNativeSessionHostPort {
  /** Runs immediately before the named custom entry is written. */
  beforeAppend: ((customType: string) => void) | undefined;

  constructor(private readonly fs: MemoryPiNativeSessionFs) {}

  create(): PiNativeSessionHandle {
    throw new Error("host.create unused");
  }

  open(): PiNativeSessionHandle {
    const fs = this.fs;
    return {
      getSessionId: () => IDENTITY.nativeSessionId,
      getSessionFile: () => `${DIR}/${FILE}`,
      getSessionDir: () => DIR,
      getHeader: () => ({
        type: "session",
        version: 3,
        id: IDENTITY.nativeSessionId,
        cwd: "/repo",
        parentSession: PARENT,
      }),
      getEntries: () => [],
      isPersisted: () => true,
      getLeafId: () => "leaf-1",
      appendCustomEntry: (customType: string, data?: unknown): string => {
        this.beforeAppend?.(customType);
        const line = `${JSON.stringify({ type: "custom", customType, data })}\n`;
        void fs
          .openDirectory(DIR, false)
          .andThen((directory) =>
            directory
              .appendFile(FILE, textEncoder.encode(line), 0o600)
              .map(() => directory.close()),
          );
        return "leaf-1";
      },
    };
  }
}

describe("a commit is acceptable only from the leaf it was bound to", () => {
  test("a leaf replaced at the commit write leaves a durable commit no reader accepts", async () => {
    // The chunks and the identity-bound commit are written for real, and the
    // leaf is swapped in the exact window between the writer's last check and
    // the commit append - the one window a writer-side check cannot cover.
    const memory = new MemoryPiNativeSessionFs();
    const opened = (await memory.openDirectory(DIR, true))._unsafeUnwrap();
    (
      await opened.appendFile(
        FILE,
        textEncoder.encode(`${headerLine()}\n`),
        0o600,
      )
    )._unsafeUnwrap();
    opened.close();

    const host = new WritingHost(memory);
    host.beforeAppend = (customType) => {
      if (customType.endsWith("result-commit")) {
        memory.simulateFileReplacement(DIR, FILE);
      }
    };
    const store = new PiNativeSessionStore({
      root: ROOT,
      fs: memory as unknown as PiNativeSessionFsPort,
      host,
    });

    const write = await store.appendResultOutput(
      REF,
      "AUTHORITATIVE",
      IDENTITY,
    );
    // Fresh reader, no knowledge of the write: the durable file is all it has.
    const read = await storeFor(memory).readResultGroup(REF, IDENTITY);
    const withContent = await storeFor(memory).readResultGroup(REF, IDENTITY, {
      content: true,
    });

    expect({
      writeFailed: write.isErr(),
      // The commit really is on disk; acceptance is not decided by whether
      // the write returned an error.
      commitIsDurable: read.isOk(),
      status: read.isOk() ? read.value.status : "",
      reason:
        read.isOk() && read.value.status === "incomplete"
          ? read.value.reason
          : "",
      contentReturned:
        withContent.isOk() && withContent.value.status === "complete"
          ? withContent.value.content
          : undefined,
    }).toEqual({
      writeFailed: true,
      commitIsDurable: true,
      status: "incomplete",
      reason: "identity-mismatch",
      contentReturned: undefined,
    });
  });

  test("a commit that reached a replaced leaf leaves no readable committed result", async () => {
    // Deterministic commit-time replacement: the chunks and the commit are
    // written exactly as production writes them, and the leaf is then
    // replaced, so the committed record names a `{dev,ino}` it no longer
    // lives in - which is precisely the state a swap during the commit
    // window produces.
    const memory = new MemoryPiNativeSessionFs();
    const seeded = await seedResultGroupSession({
      fs: memory,
      directory: DIR,
      fileName: FILE,
      headerLine: headerLine(),
      identity: IDENTITY,
      output: "AUTHORITATIVE",
    });
    const store = storeFor(memory);
    const before = (await store.readResultGroup(REF, IDENTITY))._unsafeUnwrap();

    memory.simulateFileReplacement(DIR, FILE);

    const after = (await store.readResultGroup(REF, IDENTITY))._unsafeUnwrap();
    const withContent = (
      await store.readResultGroup(REF, IDENTITY, { content: true })
    )._unsafeUnwrap();
    const leafAfter = (
      await memory
        .openDirectory(DIR, false)
        .andThen((directory) => directory.statFile(FILE))
    )._unsafeUnwrap();

    expect({
      beforeStatus: before.status,
      leafChanged: leafAfter?.ino !== seeded.leaf.ino,
      afterStatus: after.status,
      afterReason: after.status === "incomplete" ? after.reason : "",
      // No path returns bytes for a group that is no longer acceptable.
      contentStatus: withContent.status,
      content:
        withContent.status === "complete" ? withContent.content : undefined,
    }).toEqual({
      beforeStatus: "complete",
      leafChanged: true,
      afterStatus: "incomplete",
      afterReason: "identity-mismatch",
      contentStatus: "incomplete",
      content: undefined,
    });
  });

  test("a commit forged for another child or session is never complete", async () => {
    const memory = new MemoryPiNativeSessionFs();
    await seedResultGroupSession({
      fs: memory,
      directory: DIR,
      fileName: FILE,
      headerLine: headerLine(),
      identity: IDENTITY,
      output: "AUTHORITATIVE",
      options: { commitIdentity: { childId: "child-2" } },
    });
    const store = storeFor(memory);

    const forged = (await store.readResultGroup(REF, IDENTITY))._unsafeUnwrap();

    expect({
      status: forged.status,
      reason: forged.status === "incomplete" ? forged.reason : "",
    }).toEqual({ status: "incomplete", reason: "identity-mismatch" });
  });

  test("a commit bound to another leaf inode is never complete", async () => {
    const memory = new MemoryPiNativeSessionFs();
    await seedResultGroupSession({
      fs: memory,
      directory: DIR,
      fileName: FILE,
      headerLine: headerLine(),
      identity: IDENTITY,
      output: "AUTHORITATIVE",
      options: { commitIdentity: { leafIno: 999_999 } },
    });
    const store = storeFor(memory);

    const forged = (await store.readResultGroup(REF, IDENTITY))._unsafeUnwrap();

    expect({
      status: forged.status,
      reason: forged.status === "incomplete" ? forged.reason : "",
    }).toEqual({ status: "incomplete", reason: "identity-mismatch" });
  });

  test("a leaf replaced after read-time authorization never returns content", async () => {
    // The reproduced defect: the read authorized one leaf `{dev,ino}` and then
    // reopened the name for every scan page, so a replacement after
    // authorization was scanned as if it were the authorized file, and its
    // commit - which still named the authorized `{dev,ino}` - was accepted as
    // complete. The replacement here is deterministic: it fires as soon as the
    // read has authorized the leaf and read its header.
    /** One fresh session, one read, one replacement after authorization. */
    async function runSwapScenario(content: boolean): Promise<{
      readonly read: Awaited<
        ReturnType<PiNativeSessionStore["readResultGroup"]>
      >;
      readonly swapping: LeafSwapAfterReadsFs;
      readonly seededIno: number;
      readonly leafChanged: boolean;
    }> {
      const scenarioMemory = new MemoryPiNativeSessionFs();
      const group = await seedResultGroupSession({
        fs: scenarioMemory,
        directory: DIR,
        fileName: FILE,
        headerLine: headerLine(),
        identity: IDENTITY,
        output: "AUTHORITATIVE",
      });
      const swapping = new LeafSwapAfterReadsFs(
        scenarioMemory,
        DIR,
        FILE,
        // The header read is the first content read of the scan, so the leaf
        // is replaced immediately after the read authorized it.
        1,
      );
      const read = await storeFor(swapping).readResultGroup(
        REF,
        IDENTITY,
        content ? { content: true } : {},
      );
      const leafAfter = (
        await scenarioMemory
          .openDirectory(DIR, false)
          .andThen((directory) => directory.statFile(FILE))
      )._unsafeUnwrap();
      return {
        read,
        swapping,
        seededIno: group.leaf.ino,
        leafChanged: leafAfter?.ino !== group.leaf.ino,
      };
    }

    const summary = await runSwapScenario(false);
    const withContent = await runSwapScenario(true);
    const read = summary.read;
    const swapping = summary.swapping;
    const seeded = { leaf: { ino: summary.seededIno } };

    expect({
      leafChangedForContentRead: withContent.leafChanged,
      leafReallyChanged: summary.leafChanged,
      // Typed failure, not a group and not content.
      error: read._unsafeUnwrapErr(),
      completed: read.isOk() && read.value.status === "complete",
      contentReturned:
        withContent.read.isOk() && withContent.read.value.status === "complete"
          ? withContent.read.value.content
          : undefined,
      // The whole read ran on one authorized descriptor: one name resolution,
      // and every byte it read came from that exact leaf.
      openedPerRead: swapping.openedInodes.length,
      readInodes: [...swapping.readInodes],
      authorizedInode: [seeded.leaf.ino],
    }).toEqual({
      leafChangedForContentRead: true,
      leafReallyChanged: true,
      error: { type: "SessionCorrupt", ref: REF, reason: "unreadable" },
      completed: false,
      contentReturned: undefined,
      openedPerRead: 1,
      readInodes: [seeded.leaf.ino],
      authorizedInode: [seeded.leaf.ino],
    });
  });

  test("splits fixture chunks exactly as the writer does", () => {
    // Guards the fixture itself: a mis-split fixture would prove nothing.
    const output = `${"界".repeat(40_000)}tail`;
    const parts = splitResultFixtureChunks(output);

    expect({
      rejoins: parts.join("") === output,
      bounded: parts.every(
        (part) =>
          textEncoder.encode(part).byteLength <= RESULT_FIXTURE_CHUNK_BYTES,
      ),
    }).toEqual({ rejoins: true, bounded: true });
  });
});
