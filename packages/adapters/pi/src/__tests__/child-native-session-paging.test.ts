import { afterEach, describe, expect, test } from "bun:test";
import type { ResultAsync } from "neverthrow";
import {
  decodePiNativeSessionEntryCursor,
  encodePiNativeSessionEntryCursor,
  PI_NATIVE_SESSION_ENTRY_CURSOR_VERSION,
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS,
  PI_NATIVE_SESSION_MAX_RANGE_LENGTH,
  type PiNativeSessionDirectory,
  type PiNativeSessionFileHandle,
  type PiNativeSessionFsError,
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  type PiNativeSessionHostPort,
  type PiNativeSessionPagedEntry,
  PiNativeSessionStore,
  setPiNativeSessionMaxRangeLengthForTests,
} from "../child-native-sessions.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const PARENT = "parent-session-1";
const REF = "child-1/session.jsonl";
const DIR = `${ROOT}/child-1`;
const FILE = "session.jsonl";

const textEncoder = new TextEncoder();

function headerLine(): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "native-session-1",
    cwd: "/repo",
    parentSession: PARENT,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
}

function entryLine(index: number): string {
  return JSON.stringify({
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", content: `n=${index}` },
  });
}

async function seedJsonl(
  fs: MemoryPiNativeSessionFs,
  body: string,
): Promise<void> {
  const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
  (
    await directory.appendFile(FILE, textEncoder.encode(body), 0o600)
  )._unsafeUnwrap();
  directory.close();
}

function buildSession(entryCount: number): string {
  const lines = [headerLine()];
  for (let index = 0; index < entryCount; index += 1) {
    lines.push(entryLine(index));
  }
  return `${lines.join("\n")}\n`;
}

/** Host that throws if getEntries/open are used — paging must stay FS-only. */
class ForbiddenHost implements PiNativeSessionHostPort {
  create(): PiNativeSessionHandle {
    throw new Error("host.create must not be called by paging");
  }
  open(): PiNativeSessionHandle {
    throw new Error("host.open must not be called by paging");
  }
}

function pagingStore(fs: PiNativeSessionFsPort): PiNativeSessionStore {
  return new PiNativeSessionStore({
    root: ROOT,
    fs,
    host: new ForbiddenHost(),
  });
}

/**
 * Records every positional read through an opened descriptor so tests can
 * prove short-window assembly retries via public `readRange`.
 */
class RecordingFs implements PiNativeSessionFsPort {
  readonly requestedOffsets: number[] = [];
  readonly requestedLengths: number[] = [];

  constructor(private readonly inner: MemoryPiNativeSessionFs) {}

  openDirectory(
    path: string,
    create: boolean,
  ): ResultAsync<PiNativeSessionDirectory, PiNativeSessionFsError> {
    return this.inner.openDirectory(path, create).map((directory) => {
      const recorder = this;
      const wrapped: PiNativeSessionDirectory = {
        ...directory,
        openFile(
          name: string,
        ): ResultAsync<
          PiNativeSessionFileHandle | undefined,
          PiNativeSessionFsError
        > {
          return directory.openFile(name).map((handle) => {
            if (handle === undefined) return undefined;
            return {
              identity: handle.identity,
              stat: () => handle.stat(),
              readRange: (offset: number, length: number) => {
                recorder.requestedOffsets.push(offset);
                recorder.requestedLengths.push(length);
                return handle.readRange(offset, length);
              },
              close: () => handle.close(),
            } satisfies PiNativeSessionFileHandle;
          });
        },
      };
      return wrapped;
    });
  }
}

function entryIds(entries: readonly PiNativeSessionPagedEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.kind !== "entry") return `corrupt:${entry.reason}`;
    const value = entry.value as { id?: unknown };
    return typeof value.id === "string" ? value.id : "?";
  });
}

describe("PiNativeSessionEntryCursor", () => {
  test("round-trips a strict opaque cursor", () => {
    const encoded = encodePiNativeSessionEntryCursor({
      version: PI_NATIVE_SESSION_ENTRY_CURSOR_VERSION,
      dev: 1,
      ino: 42,
      size: 1000,
      offset: 128,
      anchor: "older",
    })._unsafeUnwrap();
    const decoded = decodePiNativeSessionEntryCursor(
      encoded,
      REF,
    )._unsafeUnwrap();
    expect(decoded).toEqual({
      version: 1,
      dev: 1,
      ino: 42,
      size: 1000,
      offset: 128,
      anchor: "older",
    });
  });

  test("rejects unknown keys and wrong version", () => {
    const withExtra = btoa(
      JSON.stringify({
        version: 1,
        dev: 1,
        ino: 1,
        size: 1,
        offset: 0,
        anchor: "older",
        path: "/evil",
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
    expect(
      decodePiNativeSessionEntryCursor(withExtra, REF)._unsafeUnwrapErr(),
    ).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "invalid-cursor",
    });

    const wrongVersion = btoa(
      JSON.stringify({
        version: 2,
        dev: 1,
        ino: 1,
        size: 1,
        offset: 0,
        anchor: "older",
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
    expect(
      decodePiNativeSessionEntryCursor(wrongVersion, REF)._unsafeUnwrapErr(),
    ).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "invalid-cursor",
    });
  });
});

describe("readSessionEntryPage", () => {
  test("pages newest/older/newer across >10k entries without duplicates", async () => {
    const entryCount = 10_500;
    const fs = new MemoryPiNativeSessionFs();
    await seedJsonl(fs, buildSession(entryCount));
    const store = pagingStore(fs);

    const newest = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 50,
      })
    )._unsafeUnwrap();
    expect(newest.entries).toHaveLength(50);
    expect(entryIds(newest.entries)).toEqual(
      Array.from({ length: 50 }, (_, i) => `entry-${entryCount - 50 + i}`),
    );
    expect(newest.olderCursor).toBeDefined();
    expect(newest.newerCursor).toBeDefined();
    expect(newest.bytesRead).toBeLessThanOrEqual(
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned,
    );
    expect(newest.linesScanned).toBeLessThanOrEqual(
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLinesScanned,
    );

    const older = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "older",
        cursor: newest.olderCursor,
        limit: 50,
      })
    )._unsafeUnwrap();
    expect(older.entries).toHaveLength(50);
    expect(entryIds(older.entries)).toEqual(
      Array.from({ length: 50 }, (_, i) => `entry-${entryCount - 100 + i}`),
    );
    const newestSet = new Set(entryIds(newest.entries));
    for (const id of entryIds(older.entries)) {
      expect(newestSet.has(id)).toBe(false);
    }

    const newer = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "newer",
        cursor: older.newerCursor,
        limit: 50,
      })
    )._unsafeUnwrap();
    expect(entryIds(newer.entries)).toEqual(entryIds(newest.entries));

    const olderCursor = decodePiNativeSessionEntryCursor(
      newest.olderCursor ?? "",
      REF,
    )._unsafeUnwrap();
    expect(olderCursor.anchor).toBe("older");
    expect(olderCursor.offset).toBe(newest.entries[0]?.offset);
    const olderNewest = older.entries[older.entries.length - 1];
    expect(olderNewest?.offset).toBeLessThan(newest.entries[0]?.offset ?? 0);
  });

  test("caps limit at 100", async () => {
    const fs = new MemoryPiNativeSessionFs();
    await seedJsonl(fs, buildSession(250));
    const store = pagingStore(fs);
    const page = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 10_000,
      })
    )._unsafeUnwrap();
    expect(page.entries).toHaveLength(100);
  });

  test("bytes/lines budget stays independent of file size", async () => {
    const fs = new MemoryPiNativeSessionFs();
    // Large entries so a few lines exceed the byte budget quickly.
    const big = "x".repeat(8_000);
    const lines = [headerLine()];
    for (let index = 0; index < 400; index += 1) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `big-${index}`,
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "assistant", content: big },
        }),
      );
    }
    await seedJsonl(fs, `${lines.join("\n")}\n`);
    const store = pagingStore(fs);
    const page = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 100,
      })
    )._unsafeUnwrap();
    expect(page.bytesRead).toBeLessThanOrEqual(
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned,
    );
    expect(page.linesScanned).toBeLessThanOrEqual(
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLinesScanned,
    );
    expect(page.bytesRead).toBeGreaterThan(0);
    // File is far larger than the scan budget.
    const size = (
      await (await fs.openDirectory(DIR, false))._unsafeUnwrap().statFile(FILE)
    )._unsafeUnwrap()?.size;
    expect(size).toBeGreaterThan(
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned,
    );
    expect(page.bytesRead).toBeLessThan(size ?? 0);
  });

  test("handles UTF-8 characters that straddle 64KiB chunk boundaries", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const emoji = "😀"; // 4 UTF-8 bytes
    const header = `${headerLine()}\n`;
    const headerBytes = textEncoder.encode(header);
    const entryStart = headerBytes.length;

    // Measure fixed JSON prefix before the content pad with a probe encode.
    const probePad = "";
    const probe = textEncoder.encode(
      `${JSON.stringify({
        type: "message",
        id: "utf8-entry",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: `${probePad}${emoji}tail` },
      })}\n`,
    );
    const emojiBytes = textEncoder.encode(emoji);
    let emojiInProbe = -1;
    for (let i = 0; i < probe.length - 3; i += 1) {
      if (
        probe[i] === emojiBytes[0] &&
        probe[i + 1] === emojiBytes[1] &&
        probe[i + 2] === emojiBytes[2] &&
        probe[i + 3] === emojiBytes[3]
      ) {
        emojiInProbe = i;
        break;
      }
    }
    expect(emojiInProbe).toBeGreaterThan(0);

    // Choose pad length so the emoji's first byte is the last byte of a chunk.
    const targetMod = PI_NATIVE_SESSION_MAX_RANGE_LENGTH - 1;
    const current =
      (entryStart + emojiInProbe) % PI_NATIVE_SESSION_MAX_RANGE_LENGTH;
    const padLen =
      (targetMod - current + PI_NATIVE_SESSION_MAX_RANGE_LENGTH) %
      PI_NATIVE_SESSION_MAX_RANGE_LENGTH;
    const pad = "a".repeat(padLen);
    const line = `${JSON.stringify({
      type: "message",
      id: "utf8-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: `${pad}${emoji}tail` },
    })}\n`;
    const encodedLine = textEncoder.encode(line);
    let emojiInLine = -1;
    for (let i = 0; i < encodedLine.length - 3; i += 1) {
      if (
        encodedLine[i] === emojiBytes[0] &&
        encodedLine[i + 1] === emojiBytes[1] &&
        encodedLine[i + 2] === emojiBytes[2] &&
        encodedLine[i + 3] === emojiBytes[3]
      ) {
        emojiInLine = i;
        break;
      }
    }
    expect(
      (entryStart + emojiInLine) % PI_NATIVE_SESSION_MAX_RANGE_LENGTH,
    ).toBe(targetMod);

    const fillerLines = Array.from({ length: 30 }, (_, i) => entryLine(i + 1));
    await seedJsonl(fs, `${header}${line}${fillerLines.join("\n")}\n`);

    const store = pagingStore(fs);
    const page = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 40,
      })
    )._unsafeUnwrap();
    expect(entryIds(page.entries)).toContain("utf8-entry");
    const utf8 = page.entries.find(
      (entry) =>
        entry.kind === "entry" &&
        (entry.value as { id?: unknown }).id === "utf8-entry",
    );
    expect(utf8?.kind).toBe("entry");
    if (utf8?.kind === "entry") {
      const content = (utf8.value as { message?: { content?: string } }).message
        ?.content;
      expect(content?.includes(emoji)).toBe(true);
      expect(content?.endsWith("tail")).toBe(true);
    }
  });

  test("types corrupt lines and fails closed on overlong lines", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const body = [
      headerLine(),
      "{not-json",
      "",
      entryLine(0),
      "null",
      entryLine(1),
    ].join("\n");
    await seedJsonl(fs, `${body}\n`);
    const store = pagingStore(fs);
    const page = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 20,
      })
    )._unsafeUnwrap();
    const kinds = page.entries.map((entry) => entry.kind);
    expect(kinds).toContain("corrupt");
    expect(kinds).toContain("entry");
    expect(entryIds(page.entries)).toEqual(
      expect.arrayContaining(["entry-0", "entry-1"]),
    );

    const longFs = new MemoryPiNativeSessionFs();
    const longLine = "a".repeat(
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes + 8,
    );
    await seedJsonl(longFs, `${headerLine()}\n${longLine}\n`);
    const longStore = pagingStore(longFs);
    const longResult = await longStore.readSessionEntryPage(REF, PARENT, {
      direction: "newest",
      limit: 10,
    });
    expect(longResult._unsafeUnwrapErr()).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "line-too-long",
    });
  });

  test("rejects stale cursors after truncate or identity replacement", async () => {
    const fs = new MemoryPiNativeSessionFs();
    await seedJsonl(fs, buildSession(40));
    const store = pagingStore(fs);
    const newest = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 5,
      })
    )._unsafeUnwrap();
    expect(newest.olderCursor).toBeDefined();

    const cursor = decodePiNativeSessionEntryCursor(
      newest.olderCursor ?? "",
      REF,
    )._unsafeUnwrap();
    // Keep a valid header but shrink below the cursor's size snapshot.
    fs.simulateFileTruncate(
      DIR,
      FILE,
      Math.max(cursor.offset, Math.floor(cursor.size / 2)),
    );
    const truncated = await store.readSessionEntryPage(REF, PARENT, {
      direction: "older",
      cursor: newest.olderCursor,
      limit: 5,
    });
    expect(truncated._unsafeUnwrapErr()).toMatchObject({
      type: "SessionCorrupt",
      reason: "stale-cursor",
    });

    const fs2 = new MemoryPiNativeSessionFs();
    await seedJsonl(fs2, buildSession(40));
    const store2 = pagingStore(fs2);
    const page = (
      await store2.readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 5,
      })
    )._unsafeUnwrap();
    fs2.simulateFileReplacement(DIR, FILE);
    const replaced = await store2.readSessionEntryPage(REF, PARENT, {
      direction: "older",
      cursor: page.olderCursor,
      limit: 5,
    });
    expect(replaced._unsafeUnwrapErr()).toMatchObject({
      type: "SessionCorrupt",
      reason: "stale-cursor",
    });
  });

  test("rejects missing parent, bad cursor, and never opens the host", async () => {
    const fs = new MemoryPiNativeSessionFs();
    await seedJsonl(fs, buildSession(5));
    const store = pagingStore(fs);

    const parentMismatch = await store.readSessionEntryPage(REF, "other", {
      direction: "newest",
      limit: 5,
    });
    expect(parentMismatch._unsafeUnwrapErr()).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "parent-session-mismatch",
    });

    const badCursor = await store.readSessionEntryPage(REF, PARENT, {
      direction: "older",
      cursor: "!!!",
      limit: 5,
    });
    expect(badCursor._unsafeUnwrapErr()).toMatchObject({
      type: "SessionCorrupt",
      reason: "invalid-cursor",
    });

    const missingCursor = await store.readSessionEntryPage(REF, PARENT, {
      direction: "newer",
      limit: 5,
    });
    expect(missingCursor._unsafeUnwrapErr()).toMatchObject({
      type: "SessionCorrupt",
      reason: "invalid-cursor",
    });
  });

  test("skips the session header and preserves trailing-newline sessions", async () => {
    const fs = new MemoryPiNativeSessionFs();
    await seedJsonl(fs, buildSession(3));
    const store = pagingStore(fs);
    const page = (
      await store.readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 10,
      })
    )._unsafeUnwrap();
    expect(entryIds(page.entries)).toEqual(["entry-0", "entry-1", "entry-2"]);
    for (const entry of page.entries) {
      if (entry.kind !== "entry") continue;
      expect((entry.value as { type?: unknown }).type).not.toBe("session");
    }
  });

  describe("small-chunk backward assembly", () => {
    afterEach(() => {
      setPiNativeSessionMaxRangeLengthForTests(undefined);
    });

    test("eight-entry newest page stays chronological under forced 7-byte chunks", async () => {
      // Pre-fix multi-chunk assembly returned a scrambled page (e.g. 3,2,4,6,5,7
      // after reverse) because the unterminated right fragment was emitted after
      // older newline-terminated segments in the same merge.
      setPiNativeSessionMaxRangeLengthForTests(7);
      const fs = new MemoryPiNativeSessionFs();
      await seedJsonl(fs, buildSession(8));
      const store = pagingStore(fs);
      const page = (
        await store.readSessionEntryPage(REF, PARENT, {
          direction: "newest",
          limit: 8,
        })
      )._unsafeUnwrap();
      expect(entryIds(page.entries)).toEqual([
        "entry-0",
        "entry-1",
        "entry-2",
        "entry-3",
        "entry-4",
        "entry-5",
        "entry-6",
        "entry-7",
      ]);
    });

    test("property-ish: chunk and page sizes preserve order without dup/gap", async () => {
      const entryCount = 24;
      const expectedAll = Array.from(
        { length: entryCount },
        (_, index) => `entry-${index}`,
      );
      const fs = new MemoryPiNativeSessionFs();
      await seedJsonl(fs, buildSession(entryCount));
      const store = pagingStore(fs);

      for (const chunkSize of [1, 2, 3, 4, 5, 7, 8, 11, 16, 32, 64, 128]) {
        setPiNativeSessionMaxRangeLengthForTests(chunkSize);
        for (const pageSize of [1, 2, 3, 5, 8, 13, entryCount]) {
          const newest = (
            await store.readSessionEntryPage(REF, PARENT, {
              direction: "newest",
              limit: pageSize,
            })
          )._unsafeUnwrap();
          const newestIds = entryIds(newest.entries);
          expect(newestIds).toEqual(expectedAll.slice(entryCount - pageSize));

          if (newest.olderCursor === undefined) {
            expect(pageSize).toBeGreaterThanOrEqual(entryCount);
            continue;
          }

          const older = (
            await store.readSessionEntryPage(REF, PARENT, {
              direction: "older",
              cursor: newest.olderCursor,
              limit: pageSize,
            })
          )._unsafeUnwrap();
          const olderIds = entryIds(older.entries);
          const newestSet = new Set(newestIds);
          for (const id of olderIds) {
            expect(newestSet.has(id)).toBe(false);
          }
          if (olderIds.length > 0) {
            const olderStart = expectedAll.indexOf(olderIds[0]!);
            expect(olderIds).toEqual(
              expectedAll.slice(olderStart, olderStart + olderIds.length),
            );
            expect(olderIds[olderIds.length - 1]).toBe(
              expectedAll[entryCount - pageSize - 1],
            );
          }

          const newer = (
            await store.readSessionEntryPage(REF, PARENT, {
              direction: "newer",
              cursor: older.newerCursor ?? newest.newerCursor,
              limit: pageSize,
            })
          )._unsafeUnwrap();
          if (olderIds.length > 0) {
            expect(entryIds(newer.entries)).toEqual(newestIds);
          }
        }
      }
    });

    test("UTF-8 straddling forced small chunks keeps chronological pages", async () => {
      setPiNativeSessionMaxRangeLengthForTests(5);
      const fs = new MemoryPiNativeSessionFs();
      const emoji = "😀";
      const body = [
        headerLine(),
        entryLine(0),
        JSON.stringify({
          type: "message",
          id: "utf8-mid",
          parentId: "entry-0",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: `pre${emoji}post` },
        }),
        entryLine(2),
      ].join("\n");
      await seedJsonl(fs, `${body}\n`);
      const store = pagingStore(fs);
      const page = (
        await store.readSessionEntryPage(REF, PARENT, {
          direction: "newest",
          limit: 10,
        })
      )._unsafeUnwrap();
      expect(entryIds(page.entries)).toEqual([
        "entry-0",
        "utf8-mid",
        "entry-2",
      ]);
      const mid = page.entries[1];
      expect(mid?.kind).toBe("entry");
      if (mid?.kind === "entry") {
        const content = (mid.value as { message?: { content?: string } })
          .message?.content;
        expect(content).toBe(`pre${emoji}post`);
      }
    });

    test("sessions without trailing newline stay ordered under tiny chunks", async () => {
      setPiNativeSessionMaxRangeLengthForTests(3);
      const fs = new MemoryPiNativeSessionFs();
      const lines = [headerLine()];
      for (let index = 0; index < 8; index += 1) {
        lines.push(entryLine(index));
      }
      // No final newline — unterminated last line must still be newest.
      await seedJsonl(fs, lines.join("\n"));
      const store = pagingStore(fs);
      const page = (
        await store.readSessionEntryPage(REF, PARENT, {
          direction: "newest",
          limit: 8,
        })
      )._unsafeUnwrap();
      expect(entryIds(page.entries)).toEqual([
        "entry-0",
        "entry-1",
        "entry-2",
        "entry-3",
        "entry-4",
        "entry-5",
        "entry-6",
        "entry-7",
      ]);
    });
  });

  describe("forced short reads in backward paging", () => {
    test("two-entry newest page retries short body window and returns entry-1", async () => {
      // Pre-fix: a short body window returned the older prefix and jumped
      // past the unread suffix, so newest(limit=1) yielded entry-0 / corrupt
      // instead of entry-1.
      const fs = new MemoryPiNativeSessionFs();
      await seedJsonl(fs, buildSession(2));
      const recording = new RecordingFs(fs);
      // Spare the header scan at offset 0; short only the body window.
      fs.simulateForcedShortRead(DIR, FILE, 140, 1);

      const newestOne = (
        await pagingStore(recording).readSessionEntryPage(REF, PARENT, {
          direction: "newest",
          limit: 1,
        })
      )._unsafeUnwrap();
      expect(entryIds(newestOne.entries)).toEqual(["entry-1"]);

      // First body request is the full window; the retry continues at
      // offset + short with the unread remainder — never skips the suffix.
      const bodyReads = recording.requestedOffsets
        .map((offset, index) => ({
          offset,
          length: recording.requestedLengths[index] ?? 0,
        }))
        .filter((read) => read.offset > 0);
      expect(bodyReads.length).toBeGreaterThanOrEqual(2);
      expect(bodyReads[0]?.length).toBeGreaterThan(140);
      expect(bodyReads[1]?.offset).toBe((bodyReads[0]?.offset ?? 0) + 140);
      expect(bodyReads[1]?.length).toBe((bodyReads[0]?.length ?? 0) - 140);

      const fsBoth = new MemoryPiNativeSessionFs();
      await seedJsonl(fsBoth, buildSession(2));
      fsBoth.simulateForcedShortRead(DIR, FILE, 140, 1);
      const newestBoth = (
        await pagingStore(fsBoth).readSessionEntryPage(REF, PARENT, {
          direction: "newest",
          limit: 2,
        })
      )._unsafeUnwrap();
      expect(entryIds(newestBoth.entries)).toEqual(["entry-0", "entry-1"]);
    });

    test("older cursor paging under forced short reads preserves prior entry order", async () => {
      const fs = new MemoryPiNativeSessionFs();
      await seedJsonl(fs, buildSession(3));
      const store = pagingStore(fs);
      const newest = (
        await store.readSessionEntryPage(REF, PARENT, {
          direction: "newest",
          limit: 1,
        })
      )._unsafeUnwrap();
      expect(entryIds(newest.entries)).toEqual(["entry-2"]);
      expect(newest.olderCursor).toBeDefined();

      fs.simulateForcedShortRead(DIR, FILE, 140, 1);
      const older = (
        await store.readSessionEntryPage(REF, PARENT, {
          direction: "older",
          cursor: newest.olderCursor,
          limit: 1,
        })
      )._unsafeUnwrap();
      expect(entryIds(older.entries)).toEqual(["entry-1"]);

      fs.simulateForcedShortRead(DIR, FILE, 140, 1);
      const olderTwo = (
        await store.readSessionEntryPage(REF, PARENT, {
          direction: "older",
          cursor: newest.olderCursor,
          limit: 2,
        })
      )._unsafeUnwrap();
      expect(entryIds(olderTwo.entries)).toEqual(["entry-0", "entry-1"]);
    });

    test("growth between short chunk and retry rejects with no partial page", async () => {
      const fs = new MemoryPiNativeSessionFs();
      await seedJsonl(fs, buildSession(2));
      fs.simulateForcedShortRead(DIR, FILE, 32, 1);
      fs.simulateMidReadGrowth(DIR, FILE, 64);

      const failure = (
        await pagingStore(fs).readSessionEntryPage(REF, PARENT, {
          direction: "newest",
          limit: 2,
        })
      )._unsafeUnwrapErr();

      expect(failure).toEqual({
        type: "SessionCorrupt",
        ref: REF,
        reason: "unreadable",
      });
    });

    test("rewrite and path swap between short chunk and retry reject closed", async () => {
      for (const arm of [
        (fs: MemoryPiNativeSessionFs) => fs.simulateMidReadRewrite(DIR, FILE),
        (fs: MemoryPiNativeSessionFs) =>
          fs.simulateMidReadLeafSwap(DIR, FILE, "replacement"),
      ] as const) {
        const fs = new MemoryPiNativeSessionFs();
        await seedJsonl(fs, buildSession(2));
        fs.simulateForcedShortRead(DIR, FILE, 32, 1);
        arm(fs);

        const failure = (
          await pagingStore(fs).readSessionEntryPage(REF, PARENT, {
            direction: "newest",
            limit: 2,
          })
        )._unsafeUnwrapErr();

        expect(failure).toEqual({
          type: "SessionCorrupt",
          ref: REF,
          reason: "unreadable",
        });
      }
    });

    test("premature zero-length body read fails typed with no throw", async () => {
      const fs = new MemoryPiNativeSessionFs();
      await seedJsonl(fs, buildSession(2));
      fs.simulateForcedShortRead(DIR, FILE, 0, 1);

      const result = await pagingStore(fs).readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 1,
      });
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toEqual({
        type: "SessionCorrupt",
        ref: REF,
        reason: "unreadable",
      });
    });
  });
});
