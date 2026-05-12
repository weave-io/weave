import { afterEach, describe, expect, it } from "bun:test";
import { BunFileSystem, MemoryFileSystem } from "../fs/file-system.js";

describe("BunFileSystem", () => {
  const originalFile = Bun.file;

  afterEach(() => {
    Bun.file = originalFile;
  });

  it("uses typed missing-file causes", async () => {
    const missingFile = {
      text: () =>
        Promise.reject(
          Object.assign(new Error("ENOENT: no such file or directory"), {
            code: "ENOENT",
          }),
        ),
    } as ReturnType<typeof Bun.file>;
    Bun.file = (() => missingFile) as typeof Bun.file;

    const fileSystem = new BunFileSystem();
    const result = await fileSystem.readText("/project/missing.weave");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().cause.kind).toBe("MissingFile");
  });
});

describe("MemoryFileSystem", () => {
  it("creates ancestor directories for initial files", async () => {
    const fs = new MemoryFileSystem({ "/project/a/b/c.txt": "content" });

    expect((await fs.exists("/project/a"))._unsafeUnwrap()).toBe(true);
    expect((await fs.exists("/project/a/b"))._unsafeUnwrap()).toBe(true);
  });

  it("creates ancestor directories when writing files", async () => {
    const fs = new MemoryFileSystem();

    await fs.writeText("/project/a/b/c.txt", "content");

    expect((await fs.exists("/project/a"))._unsafeUnwrap()).toBe(true);
    expect((await fs.exists("/project/a/b"))._unsafeUnwrap()).toBe(true);
  });

  it("uses typed missing-file causes", async () => {
    const fs = new MemoryFileSystem();
    const result = await fs.readText("/project/missing.weave");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().cause.kind).toBe("MissingFile");
  });

  it("expands only bare tilde and slash-prefixed tilde paths", () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/example");

    expect(fs.resolvePath("~")).toBe("/home/example");
    expect(fs.resolvePath("~/.weave/config.weave")).toBe(
      "/home/example/.weave/config.weave",
    );
    expect(fs.resolvePath("~user/.weave/config.weave")).toBe(
      "/project/~user/.weave/config.weave",
    );
  });
});
