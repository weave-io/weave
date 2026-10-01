/**
 * The Bun-backed cache I/O behind `ModelRecommendations` (Spec 39, "Cache").
 *
 * This is the one model-recommendations test that touches a real disk: it
 * pins the two properties the cache's safety rests on, in a fresh directory
 * under the test temp directory (`TMPDIR`):
 *
 * - Bun Shell's builtin `mv` replaces a file in the same directory by renaming
 *   it, so the inode moves with it and a reader sees the old file or the new
 *   one, never a partial write.
 * - Bun Shell's `mkdir` (without `-p`) fails when the directory exists, which
 *   is what makes `lock/` exclusive.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunModelRecommendationsFiles,
  BunModelRecommendationsShell,
} from "../model-recommendations-cache-io.js";

const files = new BunModelRecommendationsFiles();
const shell = new BunModelRecommendationsShell();
let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `weave-model-recommendations-${crypto.randomUUID()}`);
  (await shell.makeDirs(dir))._unsafeUnwrap();
});

afterEach(async () => {
  (await shell.remove(dir))._unsafeUnwrap();
});

describe("Bun Shell mv", () => {
  it("replaces a file in the same directory by renaming it", async () => {
    const target = `${dir}/applied.json`;
    const temp = `${dir}/.applied.json.tmp`;
    (await files.write(target, "old"))._unsafeUnwrap();
    (await files.write(temp, "new"))._unsafeUnwrap();
    const tempInode = (await Bun.file(temp).stat()).ino;

    (await shell.move(temp, target))._unsafeUnwrap();

    expect(await Bun.file(target).text()).toBe("new");
    expect((await Bun.file(target).stat()).ino).toBe(tempInode);
    expect((await files.exists(temp))._unsafeUnwrap()).toBe(false);
  });

  it("reports a move whose source is missing as an error", async () => {
    const result = await shell.move(`${dir}/missing`, `${dir}/applied.json`);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "CacheIoError",
      operation: "move",
    });
  });
});

describe("Bun Shell mkdir", () => {
  it("creates a directory once and reports that it already exists after", async () => {
    const lock = `${dir}/lock`;
    expect((await shell.makeDir(lock))._unsafeUnwrap()).toBe(true);
    expect((await shell.makeDir(lock))._unsafeUnwrap()).toBe(false);
  });

  it("reports a parent that does not exist as an error, not as a held lock", async () => {
    const result = await shell.makeDir(`${dir}/missing/lock`);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "CacheIoError",
      operation: "mkdir",
    });
  });
});

describe("BunModelRecommendationsFiles", () => {
  it("gives a directory's modified time, and undefined for nothing", async () => {
    const before = Date.now();
    (await shell.makeDir(`${dir}/lock`))._unsafeUnwrap();
    const mtime = (await files.modifiedAt(`${dir}/lock`))._unsafeUnwrap();
    expect(mtime).toBeGreaterThanOrEqual(before - 1000);
    expect(
      (await files.modifiedAt(`${dir}/missing`))._unsafeUnwrap(),
    ).toBeUndefined();
  });

  it("reads back what it wrote", async () => {
    (await files.write(`${dir}/state.json`, "{}"))._unsafeUnwrap();
    expect((await files.exists(`${dir}/state.json`))._unsafeUnwrap()).toBe(
      true,
    );
    expect((await files.read(`${dir}/state.json`))._unsafeUnwrap()).toBe("{}");
  });
});
