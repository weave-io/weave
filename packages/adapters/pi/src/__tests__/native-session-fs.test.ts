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
} from "../native-session-fs.js";

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

describe("MemoryPiNativeSessionFs — statFile / readFileRange", () => {
  test("statFile returns dev/ino/size for a regular leaf", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    const stat = (await directory.statFile(FILE))._unsafeUnwrap();
    expect(stat).toEqual({
      dev: expect.any(Number),
      ino: expect.any(Number),
      size: PAYLOAD.length,
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
    const range = (
      await directory.readFileRange(FILE, 10, 6)
    )._unsafeUnwrap();
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

  test("mid-read truncate fails closed as identity-changed", async () => {
    const fs = new MemoryPiNativeSessionFs();
    const directory = await openMemoryDir(fs);
    fs.simulateMidReadTruncate(DIR, FILE, 4);
    const range = await directory.readFileRange(FILE, 0, 16);
    expect(range._unsafeUnwrapErr()).toEqual({ type: "identity-changed" });
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
    expect((await directory.statFile("../escape"))._unsafeUnwrapErr()).toEqual({
      type: "unsafe-path",
    });
    expect(
      (await directory.readFileRange("nested/path", 0, 1))._unsafeUnwrapErr(),
    ).toEqual({ type: "unsafe-path" });
    directory.close();
  });
});

describe("BunPiNativeSessionFs — real no-follow range I/O", () => {
  let root: string;

  beforeEach(async () => {
    // Prefer a real (non-symlinked) prefix. On Darwin `/tmp` → `/private/tmp`,
    // and the no-follow open chain rejects symlink components.
    root = (await $`mktemp -d /private/tmp/weave-ns-XXXXXX`.quiet())
      .text()
      .trim();
  });

  afterEach(async () => {
    await $`rm -rf ${root}`.quiet();
  });

  test("stat and positional pread return exact chunks with stable identity", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();

    const stat = (await directory.statFile(FILE))._unsafeUnwrap();
    expect(stat?.size).toBe(PAYLOAD.length);

    const range = (
      await directory.readFileRange(FILE, 3, 5)
    )._unsafeUnwrap();
    expect(new TextDecoder().decode(range?.bytes)).toBe("defgh");
    expect(range?.identity).toEqual(stat);
    expect(range?.offset).toBe(3);

    const eof = (
      await directory.readFileRange(FILE, PAYLOAD.length - 2, 32)
    )._unsafeUnwrap();
    expect(eof?.bytes.length).toBe(2);

    directory.close();
  });

  test("rejects symlinked leaves and unsafe names", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();
    await $`ln -s ${join(root, FILE)} ${join(root, "link.jsonl")}`.quiet();

    expect(
      (await directory.statFile("link.jsonl"))._unsafeUnwrapErr(),
    ).toEqual({ type: "symlink-rejected" });
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

  test("replaced leaf after prior bind fails identity check", async () => {
    const fs = createBunPiNativeSessionFs();
    const directory = (await fs.openDirectory(root, true))._unsafeUnwrap();
    (await directory.appendFile(FILE, PAYLOAD, 0o600))._unsafeUnwrap();
    const first = (await directory.statFile(FILE))._unsafeUnwrap();
    expect(first).toBeDefined();

    await $`rm ${join(root, FILE)}`.quiet();
    await Bun.write(join(root, FILE), PAYLOAD);
    await $`chmod 600 ${join(root, FILE)}`.quiet();

    const next = await directory.statFile(FILE);
    expect(next._unsafeUnwrapErr()).toEqual({ type: "identity-changed" });
    directory.close();
  });
});
