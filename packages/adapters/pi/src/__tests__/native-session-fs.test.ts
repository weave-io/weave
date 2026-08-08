import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";
import {
  PI_NATIVE_SESSION_MAX_RANGE_LENGTH,
  type PiNativeSessionDirectory,
} from "../child-native-sessions.js";
import {
  createBunPiNativeSessionFs,
  MemoryPiNativeSessionFs,
  setForcedPreadByteLimitForTests,
} from "../native-session-fs.js";
import {
  makeRealTempRoot,
  removeRealTempRoot,
} from "./fakes/real-temp-root.js";

const DIR = "/data/weave/adapters/pi/sessions/child-1";
const FILE = "session.jsonl";
const PAYLOAD = new TextEncoder().encode(
  "abcdefghijklmnopqrstuvwxyz0123456789\n",
);

async function openMemoryDir(
  fs: MemoryPiNativeSessionFs,
  seed: Uint8Array = PAYLOAD,
): Promise<PiNativeSessionDirectory> {
  const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
  (await directory.appendFile(FILE, seed, 0o600))._unsafeUnwrap();
  return directory;
}

describe("MemoryPiNativeSessionFs — openFile descriptor defenses", () => {
  test("openFile returns a handle bound to the identity seen at open", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    expect(handle).toBeDefined();
    if (handle === undefined) return;
    expect(handle.identity).toEqual({
      dev: expect.any(Number),
      ino: expect.any(Number),
      size: PAYLOAD.length,
      mtimeMs: expect.any(Number),
    });
    const range = (await handle.readRange(0, 8))._unsafeUnwrap();
    expect(range.bytes).toEqual(PAYLOAD.slice(0, 8));
    expect(range.identity).toEqual(handle.identity);
    handle.close();
  });

  test("openFile reports a missing leaf as undefined", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    expect((await directory.openFile("absent.jsonl"))._unsafeUnwrap()).toBe(
      undefined,
    );
  });

  test("openFile rejects a symlinked leaf", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    fs.simulateFileSymlink(DIR, FILE);
    expect((await directory.openFile(FILE))._unsafeUnwrapErr()).toEqual({
      type: "symlink-rejected",
    });
  });

  test("openFile rejects a hardlinked leaf", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    fs.simulateExternalHardlink(DIR, FILE);
    expect((await directory.openFile(FILE))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
  });

  test("openFile rejects a permissive leaf", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    fs.simulatePermissiveFile(DIR, FILE);
    expect((await directory.openFile(FILE))._unsafeUnwrapErr()).toEqual({
      type: "permissive-mode",
      kind: "file",
    });
  });

  test("openFile rejects an unsafe name", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    expect((await directory.openFile("../escape"))._unsafeUnwrapErr()).toEqual({
      type: "unsafe-path",
    });
  });

  test("a replaced leaf fails a later read from the same handle", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    fs.simulateFileTruncate(DIR, FILE, 4);
    expect((await handle.readRange(0, 8))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
  });

  test("reads after close fail closed", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    handle.close();
    expect((await handle.readRange(0, 4))._unsafeUnwrapErr()).toEqual({
      type: "unavailable",
      operation: "open",
    });
    expect((await handle.stat())._unsafeUnwrapErr()).toEqual({
      type: "unavailable",
      operation: "open",
    });
  });

  test("readRange rejects an out-of-bounds length", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    expect(
      (
        await handle.readRange(0, PI_NATIVE_SESSION_MAX_RANGE_LENGTH + 1)
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "invalid-range" });
    handle.close();
  });
});

describe("MemoryPiNativeSessionFs — statFile / readFileRange", () => {
  test("statFile returns dev/ino/size/mtime for a regular leaf", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const stat = (await directory.statFile(FILE))._unsafeUnwrap();
    expect(stat).toEqual({
      dev: expect.any(Number),
      ino: expect.any(Number),
      size: PAYLOAD.length,
      mtimeMs: expect.any(Number),
    });
    expect(stat?.size).toBe(PAYLOAD.length);
    directory.close();
  });

  test("statFile returns undefined for a missing leaf", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
    const stat = (await directory.statFile(FILE))._unsafeUnwrap();
    expect(stat).toBeUndefined();
    directory.close();
  });

  test("readFileRange returns an exact partial chunk", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const range = (await directory.readFileRange(FILE, 10, 6))._unsafeUnwrap();
    expect(range).toBeDefined();
    expect(range?.offset).toBe(10);
    expect(range?.identity.size).toBe(PAYLOAD.length);
    expect(new TextDecoder().decode(range?.bytes)).toBe("klmnop");
    directory.close();
  });

  test("readFileRange short-reads at EOF", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const range = (
      await directory.readFileRange(FILE, PAYLOAD.length - 4, 64)
    )._unsafeUnwrap();
    expect(range?.bytes.length).toBe(4);
    expect(new TextDecoder().decode(range?.bytes)).toBe("789\n");
    directory.close();
  });

  test("readFileRange past EOF returns an empty chunk", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const range = (
      await directory.readFileRange(FILE, PAYLOAD.length + 8, 16)
    )._unsafeUnwrap();
    expect(range?.bytes.length).toBe(0);
    expect(range?.identity.size).toBe(PAYLOAD.length);
    directory.close();
  });

  test("readFileRange accepts the max length and rejects one byte over", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const seed = new Uint8Array(PI_NATIVE_SESSION_MAX_RANGE_LENGTH + 8);
    seed.fill(0x41);
    const directory = await openMemoryDir(fs, seed);

    const okRange = (
      await directory.readFileRange(FILE, 0, PI_NATIVE_SESSION_MAX_RANGE_LENGTH)
    )._unsafeUnwrap();
    expect(okRange?.bytes.length).toBe(PI_NATIVE_SESSION_MAX_RANGE_LENGTH);

    const over = await directory.readFileRange(
      FILE,
      0,
      PI_NATIVE_SESSION_MAX_RANGE_LENGTH + 1,
    );
    expect(over._unsafeUnwrapErr()).toEqual({ type: "invalid-range" });
    directory.close();
  });

  test("readFileRange rejects negative and non-integer bounds", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    for (const [offset, length] of [
      [-1, 8],
      [0, -1],
      [1.5, 8],
      [0, 8.2],
      [Number.NaN, 1],
    ] as const) {
      const result = await directory.readFileRange(FILE, offset, length);
      expect(result._unsafeUnwrapErr()).toEqual({ type: "invalid-range" });
    }
    directory.close();
  });

  test("replaced leaf identity fails closed", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    (await directory.statFile(FILE))._unsafeUnwrap();
    fs.simulateFileReplacement(DIR, FILE);
    const stat = await directory.statFile(FILE);
    expect(stat._unsafeUnwrapErr()).toEqual({ type: "identity-changed" });
    const range = await directory.readFileRange(FILE, 0, 4);
    expect(range._unsafeUnwrapErr()).toEqual({ type: "identity-changed" });
    directory.close();
  });

  test("renamed leaf fails closed after prior identity binding", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    (await directory.statFile(FILE))._unsafeUnwrap();
    fs.simulateFileRename(DIR, FILE);

    expect((await directory.statFile(FILE))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    expect(
      (await directory.readFileRange(FILE, 0, 4))._unsafeUnwrapErr(),
    ).toEqual({ type: "identity-changed" });
    directory.close();
  });

  test("external inode and hardlink leaves fail closed", async () => {
    const replacementFs = new MemoryPiNativeSessionFs();
    const replacementDirectory = await openMemoryDir(replacementFs);
    (await replacementDirectory.statFile(FILE))._unsafeUnwrap();
    replacementFs.simulateFileReplacement(DIR, FILE);
    expect(
      (await replacementDirectory.readFileRange(FILE, 0, 4))._unsafeUnwrapErr(),
    ).toEqual({ type: "identity-changed" });
    replacementDirectory.close();

    const hardlinkFs = new MemoryPiNativeSessionFs();
    const hardlinkDirectory = await openMemoryDir(hardlinkFs);
    (await hardlinkDirectory.statFile(FILE))._unsafeUnwrap();
    hardlinkFs.simulateExternalHardlink(DIR, FILE);
    expect((await hardlinkDirectory.statFile(FILE))._unsafeUnwrapErr()).toEqual(
      { type: "identity-changed" },
    );
    hardlinkDirectory.close();
  });

  test("post-validation replacement and rename swaps fail closed", async () => {
    for (const swap of ["replacement", "rename"] as const) {
      const fs = new MemoryPiNativeSessionFs();
      const directory = await openMemoryDir(fs);
      fs.simulatePostValidationSwap(DIR, FILE, swap);
      const range = await directory.readFileRange(FILE, 0, 4);
      expect(range._unsafeUnwrapErr()).toEqual({ type: "identity-changed" });
      directory.close();
    }
  });

  test("mid-read truncate fails closed as identity-changed", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    fs.simulateMidReadTruncate(DIR, FILE, 4);
    const range = await directory.readFileRange(FILE, 0, 16);
    expect(range._unsafeUnwrapErr()).toEqual({ type: "identity-changed" });
    directory.close();
  });

  test("zero-size openFile EOF probe rejects mid-read growth", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, new Uint8Array(), 0o600))._unsafeUnwrap();
    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    expect(handle.identity.size).toBe(0);
    fs.simulateMidReadGrowth(DIR, FILE, 8);
    expect((await handle.readRange(0, 16))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("forced short read then growth rejects before a second content read", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    fs.simulateForcedShortRead(DIR, FILE, 4);
    fs.simulateMidReadGrowth(DIR, FILE, 8);

    const first = (await handle.readRange(0, 16))._unsafeUnwrap();
    expect(first.bytes).toEqual(PAYLOAD.slice(0, 4));

    expect((await handle.readRange(4, 16))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("symlink and unsafe path fail closed", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
    fs.simulateFileSymlink(DIR, FILE);
    expect((await directory.statFile(FILE))._unsafeUnwrapErr()).toEqual({
      type: "symlink-rejected",
    });
    expect(
      (await directory.readFileRange(FILE, 0, 4))._unsafeUnwrapErr(),
    ).toEqual({ type: "symlink-rejected" });
    fs.simulateDirectorySymlink(DIR);
    expect((await directory.statFile(FILE))._unsafeUnwrapErr()).toEqual({
      type: "symlink-rejected",
    });
    expect((await directory.statFile("../escape"))._unsafeUnwrapErr()).toEqual({
      type: "unsafe-path",
    });
    expect(
      (await directory.readFileRange("nested/path", 0, 1))._unsafeUnwrapErr(),
    ).toEqual({ type: "unsafe-path" });
    directory.close();
  });

  test("createExclusiveFile writes once and rejects collisions and bad modes", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
    (await directory.createExclusiveFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();
    expect(
      (
        await directory.createExclusiveFile(FILE, PAYLOAD, 0o600)
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "already-exists" });
    expect(
      (
        await directory.createExclusiveFile("other.jsonl", PAYLOAD, 0o644)
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "permissive-mode", kind: "file" });
    directory.close();
  });
});

describe("BunPiNativeSessionFs — real no-follow range I/O", () => {
  let root: string;

  beforeEach(async () => {
    // A canonical (symlink-free) prefix is required: the no-follow open chain
    // rejects symlink components anywhere below the root.
    root = await makeRealTempRoot("weave-ns");
  });

  afterEach(async () => {
    setForcedPreadByteLimitForTests(undefined);
    await removeRealTempRoot(root);
  });

  test("stat and positional pread return exact chunks with stable identity", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const stat = (await directory.statFile(FILE))._unsafeUnwrap();
    expect(stat?.size).toBe(PAYLOAD.length);

    const range = (await directory.readFileRange(FILE, 3, 5))._unsafeUnwrap();
    expect(new TextDecoder().decode(range?.bytes)).toBe("defgh");
    expect(range?.identity).toEqual(stat);
    expect(range?.offset).toBe(3);

    const eof = (
      await directory.readFileRange(FILE, PAYLOAD.length - 2, 32)
    )._unsafeUnwrap();
    expect(eof?.bytes.length).toBe(2);

    directory.close();
  });

  test("openFile reads exact chunks from one descriptor and closes cleanly", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    expect(handle.identity.size).toBe(PAYLOAD.length);
    expect(handle.identity.mtimeMs).toEqual(expect.any(Number));

    const first = (await handle.readRange(3, 5))._unsafeUnwrap();
    expect(new TextDecoder().decode(first.bytes)).toBe("defgh");
    const eof = (
      await handle.readRange(PAYLOAD.length - 2, 32)
    )._unsafeUnwrap();
    expect(eof.bytes.length).toBe(2);
    expect((await handle.stat())._unsafeUnwrap()).toEqual(handle.identity);

    handle.close();
    expect((await handle.readRange(0, 4))._unsafeUnwrapErr()).toEqual({
      type: "unavailable",
      operation: "open",
    });
    directory.close();
  });

  test("openFile rejects a symlinked leaf and reports a missing leaf", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();
    await $`ln -s ${join(root, FILE)} ${join(root, "handle-link.jsonl")}`.quiet();

    expect(
      (await directory.openFile("handle-link.jsonl"))._unsafeUnwrapErr(),
    ).toEqual({ type: "symlink-rejected" });
    expect((await directory.openFile("absent.jsonl"))._unsafeUnwrap()).toBe(
      undefined,
    );
    expect((await directory.openFile("a/b"))._unsafeUnwrapErr()).toEqual({
      type: "unsafe-path",
    });
    directory.close();
  });

  test("a real file replaced after open never redirects the descriptor", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    // Swap the name to a different inode after validation.
    await $`printf 'zzzz' > ${join(root, "other.jsonl")}`.quiet();
    await $`chmod 600 ${join(root, "other.jsonl")}`.quiet();
    await $`mv ${join(root, "other.jsonl")} ${join(root, FILE)}`.quiet();

    // The descriptor still names the validated inode, which the swap unlinked.
    // The read therefore fails closed; it can never return the swapped file.
    expect((await handle.readRange(0, 8))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("a real leaf renamed away after open fails the leaf check", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    // The descriptor still holds the very same inode with identical metadata,
    // so only a directory-relative leaf check can catch this.
    await $`mv ${join(root, FILE)} ${join(root, "moved.jsonl")}`.quiet();

    expect((await handle.readRange(0, 4))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    expect((await handle.stat())._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("a real leaf deleted after open fails the leaf check", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    await $`rm ${join(root, FILE)}`.quiet();

    expect((await handle.readRange(0, 4))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("a real leaf atomically exchanged after open fails closed", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    // Same byte length and same mode; only the inode behind the name moves.
    const decoy = join(root, "decoy.jsonl");
    await Bun.write(decoy, PAYLOAD);
    await $`chmod 600 ${decoy}`.quiet();
    await $`mv ${decoy} ${join(root, FILE)}`.quiet();

    expect((await handle.readRange(0, 4))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("a real leaf replaced by a symlink after open fails closed", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    const elsewhere = join(root, "elsewhere.jsonl");
    await Bun.write(elsewhere, PAYLOAD);
    await $`chmod 600 ${elsewhere}`.quiet();
    await $`rm ${join(root, FILE)}`.quiet();
    await $`ln -s ${elsewhere} ${join(root, FILE)}`.quiet();

    expect((await handle.readRange(0, 4))._unsafeUnwrapErr()).toEqual({
      type: "symlink-rejected",
    });
    handle.close();
    directory.close();
  });

  test("a new hardlink to the open leaf fails the link-count check", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    // Same inode, same size, same mtime: only st_nlink moves.
    await $`ln ${join(root, FILE)} ${join(root, "second-name.jsonl")}`.quiet();

    expect((await handle.readRange(0, 4))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("a real leaf chmoded after open fails closed", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    await $`chmod 644 ${join(root, FILE)}`.quiet();

    expect((await handle.readRange(0, 4))._unsafeUnwrapErr()).toEqual({
      type: "permissive-mode",
      kind: "file",
    });
    handle.close();
    directory.close();
  });

  test("an untouched real leaf still reads and pages normally", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    const decoder = new TextDecoder();
    const first = (await handle.readRange(0, 4))._unsafeUnwrap();
    const second = (await handle.readRange(4, 4))._unsafeUnwrap();
    const stat = (await handle.stat())._unsafeUnwrap();

    expect(decoder.decode(first.bytes) + decoder.decode(second.bytes)).toBe(
      decoder.decode(PAYLOAD.subarray(0, 8)),
    );
    expect(stat.ino).toBe(handle.identity.ino);
    expect(stat.size).toBe(handle.identity.size);
    handle.close();
    // Closing twice must stay safe, and reads after close must fail closed.
    handle.close();
    expect((await handle.readRange(0, 4))._unsafeUnwrapErr()).toEqual({
      type: "unavailable",
      operation: "open",
    });
    directory.close();
  });

  test("a real file truncated during a read fails closed", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    await $`truncate -s 4 ${join(root, FILE)}`.quiet();

    expect((await handle.readRange(0, 8))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("a real file grown during a read fails closed", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    expect((await handle.readRange(0, 8))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("a real zero-size file still probes EOF and rejects concurrent growth", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, new Uint8Array(), 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    expect(handle.identity.size).toBe(0);

    const eof = (await handle.readRange(0, 16))._unsafeUnwrap();
    expect(eof.bytes).toEqual(new Uint8Array());

    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();
    expect((await handle.readRange(0, 16))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("a real zero-size leaf swapped before the EOF probe fails closed", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, new Uint8Array(), 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    await $`printf 'zzzz' > ${join(root, "other.jsonl")}`.quiet();
    await $`chmod 600 ${join(root, "other.jsonl")}`.quiet();
    await $`mv ${join(root, "other.jsonl")} ${join(root, FILE)}`.quiet();

    expect((await handle.readRange(0, 16))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("forced short pread then rewrite is rejected before a second content read", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const handle = (await directory.openFile(FILE))._unsafeUnwrap();
    if (handle === undefined) throw new Error("expected handle");
    setForcedPreadByteLimitForTests(4);
    const first = (await handle.readRange(0, 16))._unsafeUnwrap();
    expect(first.bytes).toEqual(PAYLOAD.subarray(0, 4));

    // Same size, in-place rewrite through the path: only mtime moves before
    // the retry, so the second readRange must fail closed before content.
    const rewritten = new Uint8Array(PAYLOAD.length);
    rewritten.fill(0x62);
    await Bun.write(join(root, FILE), rewritten);
    await $`chmod 600 ${join(root, FILE)}`.quiet();

    expect((await handle.readRange(4, 16))._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });
    handle.close();
    directory.close();
  });

  test("rejects symlinked leaves and unsafe names", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();
    await $`ln -s ${join(root, FILE)} ${join(root, "link.jsonl")}`.quiet();

    expect((await directory.statFile("link.jsonl"))._unsafeUnwrapErr()).toEqual(
      { type: "symlink-rejected" },
    );
    expect(
      (await directory.readFileRange("link.jsonl", 0, 4))._unsafeUnwrapErr(),
    ).toEqual({ type: "symlink-rejected" });
    expect((await directory.statFile("a/b"))._unsafeUnwrapErr()).toEqual({
      type: "unsafe-path",
    });
    expect(
      (
        await directory.readFileRange(
          FILE,
          0,
          PI_NATIVE_SESSION_MAX_RANGE_LENGTH + 1,
        )
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "invalid-range" });

    directory.close();
  });

  test("rejects a symlinked ancestor directory", async () => {
    const fs = createBunPiNativeSessionFs();
    const target = join(root, "target");
    const link = join(root, "ancestor-link");
    await $`mkdir ${target}`.quiet();
    await $`ln -s ${target} ${link}`.quiet();

    expect((await fs.openDirectory(link, true))._unsafeUnwrapErr()).toEqual({
      type: "symlink-rejected",
    });
  });

  test("renamed leaf after prior bind fails identity check", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();
    (await directory.statFile(FILE))._unsafeUnwrap();

    await $`mv ${join(root, FILE)} ${join(root, "renamed.jsonl")}`.quiet();

    const next = await directory.statFile(FILE);
    expect(next._unsafeUnwrapErr()).toEqual({ type: "identity-changed" });
    directory.close();
  });

  test("external hardlink after prior bind fails identity check", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();
    (await directory.statFile(FILE))._unsafeUnwrap();

    const external = join(root, "external.jsonl");
    await Bun.write(external, PAYLOAD);
    await $`chmod 600 ${external}`.quiet();
    await $`rm ${join(root, FILE)}`.quiet();
    await $`ln ${external} ${join(root, FILE)}`.quiet();

    const next = await directory.statFile(FILE);
    expect(next._unsafeUnwrapErr()).toEqual({ type: "identity-changed" });
    directory.close();
  });
});
