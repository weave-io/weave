/**
 * Adversarial coverage for descriptor-native bounded reads.
 *
 * Every read-only native session consumer must read through an already
 * validated descriptor in bounded chunks: the file is opened once, the byte
 * ceiling is enforced against descriptor metadata before allocation, and any
 * growth, truncation, in-place rewrite, or post-validation path swap fails
 * closed with a typed error instead of yielding a partial projection. The leaf
 * name itself is re-checked with no-follow, directory-relative metadata around
 * every chunk, so a rename, replacement, deletion, symlink, or hardlink of the
 * name is rejected even though content only ever comes from the open
 * descriptor.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ok, type Result, type ResultAsync } from "neverthrow";
import {
  PI_NATIVE_SESSION_MAX_FILE_BYTES,
  PI_NATIVE_SESSION_MAX_RANGE_LENGTH,
  type PiNativeSessionDirectory,
  type PiNativeSessionFileHandle,
  type PiNativeSessionFsError,
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  type PiNativeSessionHostPort,
  type PiNativeSessionStorageUnavailable,
  PiNativeSessionStore,
  setPiNativeSessionMaxRangeLengthForTests,
} from "../child-native-sessions.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";

const ROOT = "/data/weave/adapters/pi/sessions";
const PARENT = "parent-session-1";
const REF = "child-1/session.jsonl";
const DIR = `${ROOT}/child-1`;
const FILE = "session.jsonl";
/** Mirrors `MAX_DESCRIPTOR_SESSION_LINES` in the bounded reader. */
const MAX_DESCRIPTOR_SESSION_LINES = 32_768;

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

function buildSession(entryCount: number): string {
  const lines = [headerLine()];
  for (let index = 0; index < entryCount; index += 1) {
    lines.push(entryLine(index));
  }
  return `${lines.join("\n")}\n`;
}

async function seedBytes(
  fs: MemoryPiNativeSessionFs,
  bytes: Uint8Array,
): Promise<void> {
  const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
  (await directory.appendFile(FILE, bytes, 0o600))._unsafeUnwrap();
  directory.close();
}

async function seedJsonl(
  fs: MemoryPiNativeSessionFs,
  body: string,
): Promise<void> {
  await seedBytes(fs, textEncoder.encode(body));
}

/** Host that throws if create/open are used — these reads must stay FS-only. */
class ForbiddenHost implements PiNativeSessionHostPort {
  requireDescriptorSafeSessionIo(): Result<
    void,
    PiNativeSessionStorageUnavailable
  > {
    return ok(undefined);
  }

  create(): PiNativeSessionHandle {
    throw new Error("host.create must not be called by a descriptor read");
  }

  open(): PiNativeSessionHandle {
    throw new Error("host.open must not be called by a descriptor read");
  }
}

/**
 * Records every positional read length requested through an opened descriptor,
 * so a test can prove how many bytes a read actually asked the port for.
 */
class RecordingFs implements PiNativeSessionFsPort {
  readonly requestedLengths: number[] = [];
  readonly opened: string[] = [];

  constructor(private readonly inner: MemoryPiNativeSessionFs) {}

  get requestedTotal(): number {
    return this.requestedLengths.reduce((total, next) => total + next, 0);
  }

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
          recorder.opened.push(name);
          return directory.openFile(name).map((handle) => {
            if (handle === undefined) return undefined;
            return {
              identity: handle.identity,
              stat: () => handle.stat(),
              readRange: (offset: number, length: number) => {
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

function storeFor(fs: PiNativeSessionFsPort): PiNativeSessionStore {
  return new PiNativeSessionStore({
    root: ROOT,
    fs,
    host: new ForbiddenHost(),
  });
}

afterEach(() => {
  setPiNativeSessionMaxRangeLengthForTests(undefined);
});

describe("descriptor-native bounded whole-session reads", () => {
  test("reads a normal multiline JSONL session in bounded chunks", async () => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    const body = buildSession(40);
    await seedJsonl(memory, body);
    const recording = new RecordingFs(memory);

    const entries = (
      await storeFor(recording).readSessionEntries(REF, PARENT)
    )._unsafeUnwrap();

    expect(entries.entries).toHaveLength(40);
    expect(entries.record.ref).toBe(REF);
    expect(recording.opened).toEqual([FILE]);
    expect(recording.requestedLengths.length).toBeGreaterThan(1);
    for (const length of recording.requestedLengths) {
      expect(length).toBeLessThanOrEqual(256);
    }
    // Every chunk is bounded, and the scan never asks for materially more than
    // the file itself plus the final short chunk and one EOF probe.
    expect(recording.requestedTotal).toBeLessThanOrEqual(body.length + 2 * 256);
  });

  test("never exceeds the production range ceiling per chunk", async () => {
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(200));
    const recording = new RecordingFs(memory);

    (await storeFor(recording).readSessionEntries(REF, PARENT))._unsafeUnwrap();

    for (const length of recording.requestedLengths) {
      expect(length).toBeLessThanOrEqual(PI_NATIVE_SESSION_MAX_RANGE_LENGTH);
    }
  });

  test("an oversized file fails from metadata before any body byte is read", async () => {
    const memory = new MemoryPiNativeSessionFs();
    const oversized = new Uint8Array(PI_NATIVE_SESSION_MAX_FILE_BYTES + 1);
    oversized.fill(0x61);
    oversized[0] = 0x0a;
    await seedBytes(memory, oversized);
    const recording = new RecordingFs(memory);

    const failure = (
      await storeFor(recording).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "file-too-large",
    });
    // The ceiling is enforced against descriptor metadata: zero body bytes
    // were ever requested, so nothing was allocated for the payload.
    expect(recording.opened).toEqual([FILE]);
    expect(recording.requestedLengths).toEqual([]);
    expect(recording.requestedTotal).toBe(0);
  });

  test("a file with too many lines fails closed while streaming", async () => {
    const memory = new MemoryPiNativeSessionFs();
    const newlines = new Uint8Array(40_000);
    newlines.fill(0x0a);
    await seedBytes(memory, newlines);
    const recording = new RecordingFs(memory);

    const failure = (
      await storeFor(recording).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
    for (const length of recording.requestedLengths) {
      expect(length).toBeLessThanOrEqual(PI_NATIVE_SESSION_MAX_RANGE_LENGTH);
    }
  });

  test("exactly the line ceiling is accepted by the line budget", async () => {
    const memory = new MemoryPiNativeSessionFs();
    // First line is valid JSON but not a session header, so parsing reports
    // `missing-header`. Total lines are exactly the ceiling, all newline
    // terminated, so the line budget must not fire.
    const notAHeader = JSON.stringify({ type: "message", id: "x" });
    const body = `${notAHeader}${"\n".repeat(MAX_DESCRIPTOR_SESSION_LINES)}`;
    await seedJsonl(memory, body);

    const failure = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    // Reaching the parser at all proves the bounded read accepted 32,768 lines.
    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "missing-header",
    });
  });

  test("the ceiling of terminated lines plus an unterminated final line fails closed", async () => {
    const memory = new MemoryPiNativeSessionFs();
    // Byte-for-byte the previous payload plus one unterminated final line:
    // 32,768 newline-terminated lines and one more, so 32,769 in total.
    const notAHeader = JSON.stringify({ type: "message", id: "x" });
    const body = `${notAHeader}${"\n".repeat(MAX_DESCRIPTOR_SESSION_LINES)}{`;
    await seedJsonl(memory, body);

    const failure = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    // `unreadable`, not the `missing-header` the parser would have produced:
    // the line budget rejected the file before concatenation and parsing.
    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });

  test("a valid session whose final line lacks a newline still reads", async () => {
    const memory = new MemoryPiNativeSessionFs();
    const body = buildSession(6);
    expect(body.endsWith("\n")).toBe(true);
    await seedJsonl(memory, body.slice(0, -1));

    const entries = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrap();

    expect(entries.entries).toHaveLength(6);
  });

  test("a trailing newline is not counted as an extra empty line", async () => {
    const memory = new MemoryPiNativeSessionFs();
    const body = buildSession(4);
    expect(body.endsWith("\n")).toBe(true);
    await seedJsonl(memory, body);

    const entries = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrap();

    expect(entries.entries).toHaveLength(4);
  });

  test("growth during a chunked read fails closed with no partial projection", async () => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(40));
    memory.simulateMidReadGrowth(DIR, FILE, 512);

    const failure = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });

  test("truncation during a chunked read fails closed", async () => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(40));
    memory.simulateMidReadTruncate(DIR, FILE, 100);

    const failure = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });

  test("a same-size in-place rewrite during a read fails closed", async () => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(40));
    memory.simulateMidReadRewrite(DIR, FILE);

    const failure = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });

  test("a path swapped after validation is rejected, never projected", async () => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(12));
    memory.simulatePostValidationSwap(DIR, FILE, "replacement");

    const failure = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    // The name no longer resolves to the descriptor we hold open, so the read
    // fails closed instead of projecting either file.
    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });

  test("a leaf renamed after validation is rejected, never projected", async () => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(9));
    memory.simulatePostValidationSwap(DIR, FILE, "rename");

    const failure = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });

  test.each([
    ["replacement", { type: "SessionCorrupt", ref: REF, reason: "unreadable" }],
    ["rename", { type: "SessionCorrupt", ref: REF, reason: "unreadable" }],
    ["symlink", { type: "SessionRootViolation", reason: "symlink-rejected" }],
    ["hardlink", { type: "SessionCorrupt", ref: REF, reason: "unreadable" }],
  ] as const)("%s of the leaf during an in-flight read fails closed", async (swap, expected) => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(40));
    memory.simulateMidReadLeafSwap(DIR, FILE, swap);

    const failure = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual(expected);
  });

  test("a missing session reports SessionMissing without a body read", async () => {
    const memory = new MemoryPiNativeSessionFs();
    (await memory.openDirectory(DIR, true))._unsafeUnwrap().close();
    const recording = new RecordingFs(memory);

    const failure = (
      await storeFor(recording).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual({ type: "SessionMissing", ref: REF });
    expect(recording.requestedLengths).toEqual([]);
  });

  test("an initially empty file still issues a guarded EOF probe", async () => {
    const memory = new MemoryPiNativeSessionFs();
    await seedBytes(memory, new Uint8Array());
    const recording = new RecordingFs(memory);

    const failure = (
      await storeFor(recording).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    // Empty content reaches the parser only after a real EOF readRange.
    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "missing-header",
    });
    expect(recording.opened).toEqual([FILE]);
    expect(recording.requestedLengths.length).toBe(1);
    expect(recording.requestedLengths[0]).toBeGreaterThan(0);
  });

  test.each([
    [
      "growth",
      (fs: MemoryPiNativeSessionFs) => fs.simulateMidReadGrowth(DIR, FILE, 32),
      { type: "SessionCorrupt", ref: REF, reason: "unreadable" },
    ],
    [
      "rewrite",
      (fs: MemoryPiNativeSessionFs) => fs.simulateMidReadRewrite(DIR, FILE),
      { type: "SessionCorrupt", ref: REF, reason: "unreadable" },
    ],
    [
      "replacement",
      (fs: MemoryPiNativeSessionFs) =>
        fs.simulateMidReadLeafSwap(DIR, FILE, "replacement"),
      { type: "SessionCorrupt", ref: REF, reason: "unreadable" },
    ],
    [
      "rename",
      (fs: MemoryPiNativeSessionFs) =>
        fs.simulateMidReadLeafSwap(DIR, FILE, "rename"),
      { type: "SessionCorrupt", ref: REF, reason: "unreadable" },
    ],
    [
      "symlink",
      (fs: MemoryPiNativeSessionFs) =>
        fs.simulateMidReadLeafSwap(DIR, FILE, "symlink"),
      { type: "SessionRootViolation", reason: "symlink-rejected" },
    ],
    [
      "hardlink",
      (fs: MemoryPiNativeSessionFs) =>
        fs.simulateMidReadLeafSwap(DIR, FILE, "hardlink"),
      { type: "SessionCorrupt", ref: REF, reason: "unreadable" },
    ],
  ] as const)("zero-size EOF probe rejects concurrent %s with no empty projection", async (_kind, arm, expected) => {
    const memory = new MemoryPiNativeSessionFs();
    await seedBytes(memory, new Uint8Array());
    arm(memory);

    const failure = (
      await storeFor(memory).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual(expected);
  });

  test.each([
    [
      "growth",
      (fs: MemoryPiNativeSessionFs) => fs.simulateMidReadGrowth(DIR, FILE, 64),
    ],
    [
      "rewrite",
      (fs: MemoryPiNativeSessionFs) => fs.simulateMidReadRewrite(DIR, FILE),
    ],
    [
      "replacement",
      (fs: MemoryPiNativeSessionFs) =>
        fs.simulateMidReadLeafSwap(DIR, FILE, "replacement"),
    ],
    [
      "rename",
      (fs: MemoryPiNativeSessionFs) =>
        fs.simulateMidReadLeafSwap(DIR, FILE, "rename"),
    ],
  ] as const)("forced short read then %s is rejected before a second content read", async (_kind, armMutation) => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    const body = buildSession(40);
    await seedJsonl(memory, body);
    const recording = new RecordingFs(memory);
    memory.simulateForcedShortRead(DIR, FILE, 32);
    armMutation(memory);

    const failure = (
      await storeFor(recording).readSessionEntries(REF, PARENT)
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
    // First range returned a short chunk; the retry's check pair rejected
    // before any further content was accepted into a projection.
    expect(recording.requestedLengths[0]).toBe(256);
    expect(recording.requestedLengths.length).toBeGreaterThanOrEqual(2);
  });
});

describe("descriptor-native bounded paging", () => {
  test("pages newest entries through one opened descriptor", async () => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(30));
    const recording = new RecordingFs(memory);

    const page = (
      await storeFor(recording).readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 5,
      })
    )._unsafeUnwrap();

    expect(page.entries).toHaveLength(5);
    // One open for the whole page: the validated leaf is never reopened.
    expect(recording.opened).toEqual([FILE]);
    for (const length of recording.requestedLengths) {
      expect(length).toBeLessThanOrEqual(256);
    }
  });

  test("paging fails closed when the file grows mid-page", async () => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(30));
    memory.simulateMidReadGrowth(DIR, FILE, 256);

    const failure = (
      await storeFor(memory).readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 5,
      })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });

  test("paging fails closed when the file truncates mid-page", async () => {
    setPiNativeSessionMaxRangeLengthForTests(256);
    const memory = new MemoryPiNativeSessionFs();
    await seedJsonl(memory, buildSession(30));
    memory.simulateMidReadTruncate(DIR, FILE, 120);

    const failure = (
      await storeFor(memory).readSessionEntryPage(REF, PARENT, {
        direction: "newest",
        limit: 5,
      })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SessionCorrupt",
      ref: REF,
      reason: "unreadable",
    });
  });
});
