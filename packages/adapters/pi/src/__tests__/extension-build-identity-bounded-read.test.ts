import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { $ } from "bun";
import {
  type BoundedFile,
  type BoundedFileStat,
  readBoundedFileObject,
} from "../bounded-file-read.js";
import { readArtifactSha256 } from "../extension-build-identity-manifest.js";
import { MAX_EXTENSION_BUILD_OUTPUT_BYTES } from "../extension-build-identity-types.js";
import {
  makeRealTempRoot,
  removeRealTempRoot,
} from "./fakes/real-temp-root.js";

const encoder = new TextEncoder();
const roots: string[] = [];

function stat(
  size: number,
  overrides: Partial<BoundedFileStat> = {},
): BoundedFileStat {
  return {
    dev: 1,
    ino: 2,
    mode: 0o100600,
    nlink: 1,
    size,
    mtimeMs: 1,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

class ScriptedFile implements BoundedFile {
  readonly sliceCalls: { readonly start: number; readonly end: number }[] = [];
  private statIndex = 0;

  constructor(
    private readonly contents: Uint8Array,
    private readonly stats: readonly BoundedFileStat[],
    private readonly readFailure?: unknown,
  ) {}

  stat(): Promise<BoundedFileStat> {
    const value = this.stats[Math.min(this.statIndex, this.stats.length - 1)];
    this.statIndex += 1;
    if (value === undefined) return Promise.reject(new Error("missing stat"));
    return Promise.resolve(value);
  }

  slice(
    start: number,
    end: number,
  ): {
    arrayBuffer(): Promise<ArrayBuffer>;
  } {
    this.sliceCalls.push({ start, end });
    const bytes = this.contents.slice(start, end);
    return {
      arrayBuffer: async () => {
        if (this.readFailure !== undefined) {
          throw this.readFailure;
        }
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      },
    };
  }
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await removeRealTempRoot(root);
  }
});

describe("descriptor-like identity bounded reads", () => {
  test("reads the exact bound and requests only bound plus one", async () => {
    const file = new ScriptedFile(encoder.encode("four"), [stat(4), stat(4)]);

    const result = await readBoundedFileObject(file, 4);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(encoder.encode("four"));
    expect(file.sliceCalls).toEqual([{ start: 0, end: 5 }]);
  });

  test("rejects a file at bound plus one before reading", async () => {
    const file = new ScriptedFile(encoder.encode("12345"), [stat(5)]);

    const result = await readBoundedFileObject(file, 4);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("file-too-large");
    expect(file.sliceCalls).toHaveLength(0);
  });

  test("rejects a huge sparse-sized stat without allocation or a read", async () => {
    const file = new ScriptedFile(new Uint8Array(), [
      stat(Number.MAX_SAFE_INTEGER),
    ]);

    const result = await readBoundedFileObject(file, 16);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("file-too-large");
    expect(file.sliceCalls).toHaveLength(0);
  });

  test("rejects growth after the stat with the sentinel byte", async () => {
    const file = new ScriptedFile(encoder.encode("12345"), [stat(4)]);

    const result = await readBoundedFileObject(file, 4);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("file-too-large");
    expect(file.sliceCalls).toEqual([{ start: 0, end: 5 }]);
  });

  test("rejects a stat-small/read-grows change even below the ceiling", async () => {
    const file = new ScriptedFile(encoder.encode("1234"), [stat(3)]);

    const result = await readBoundedFileObject(file, 8);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("file-changed");
    expect(file.sliceCalls).toEqual([{ start: 0, end: 9 }]);
  });

  test("rejects truncation after the stat", async () => {
    const file = new ScriptedFile(encoder.encode("12"), [stat(4)]);

    const result = await readBoundedFileObject(file, 8);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("file-changed");
  });

  test("rejects symlinks and non-regular files before reading", async () => {
    const symlink = new ScriptedFile(encoder.encode("secret"), [
      stat(6, { isSymbolicLink: () => true }),
    ]);
    const directory = new ScriptedFile(encoder.encode("secret"), [
      stat(6, { isFile: () => false }),
    ]);

    const symlinkResult = await readBoundedFileObject(symlink, 16);
    const directoryResult = await readBoundedFileObject(directory, 16);

    expect(symlinkResult._unsafeUnwrapErr()).toBe("not-regular");
    expect(directoryResult._unsafeUnwrapErr()).toBe("not-regular");
    expect(symlink.sliceCalls).toHaveLength(0);
    expect(directory.sliceCalls).toHaveLength(0);
  });

  test("closes read rejection without exposing its exception text", async () => {
    const file = new ScriptedFile(
      encoder.encode("secret"),
      [stat(6)],
      new Error("/private/path contains a secret sentinel"),
    );

    const result = await readBoundedFileObject(file, 16);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("read-failed");
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
      "private/path",
    );
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain("secret");
  });
});

describe("no-follow production identity reads", () => {
  test("rejects symlink and directory identity inputs", async () => {
    const root = await makeRealTempRoot("weave-identity-bounded-read");
    roots.push(root);
    const real = join(root, "real.js");
    const link = join(root, "link.js");
    const directory = join(root, "directory");
    const fifo = join(root, "pipe");
    await Bun.write(real, "identity");
    await $`ln -s ${real} ${link}`.quiet();
    await $`mkdir ${directory}`.quiet();
    await $`mkfifo ${fifo}`.quiet();

    const symlinkResult = await readArtifactSha256(link);
    const directoryResult = await readArtifactSha256(directory);
    const fifoResult = await readArtifactSha256(fifo);

    expect(symlinkResult.isErr()).toBe(true);
    expect(directoryResult.isErr()).toBe(true);
    expect(fifoResult.isErr()).toBe(true);
  });

  test("rejects a sparse file larger than the identity output ceiling", async () => {
    const root = await makeRealTempRoot("weave-identity-sparse-read");
    roots.push(root);
    const sparse = join(root, "sparse.js");
    await $`truncate -s ${MAX_EXTENSION_BUILD_OUTPUT_BYTES + 1} ${sparse}`.quiet();

    const result = await readArtifactSha256(sparse);

    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(root);
  });
});
