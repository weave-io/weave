import { afterEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { BunFileSystem, MemoryFileSystem } from "../fs/file-system.js";

describe("BunFileSystem", () => {
  const originalFile = Bun.file;

  function withEnv<T>(
    values: { HOME?: string; USERPROFILE?: string },
    callback: () => T,
  ): T {
    const originalHome = Bun.env.HOME;
    const originalUserProfile = Bun.env.USERPROFILE;
    try {
      if (values.HOME === undefined) delete Bun.env.HOME;
      else Bun.env.HOME = values.HOME;
      if (values.USERPROFILE === undefined) delete Bun.env.USERPROFILE;
      else Bun.env.USERPROFILE = values.USERPROFILE;
      return callback();
    } finally {
      if (originalHome === undefined) delete Bun.env.HOME;
      else Bun.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete Bun.env.USERPROFILE;
      else Bun.env.USERPROFILE = originalUserProfile;
    }
  }

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

  it("falls back to the OS home directory when HOME is unavailable", () => {
    withEnv({ HOME: undefined, USERPROFILE: undefined }, () => {
      const fileSystem = new BunFileSystem();

      expect(fileSystem.home()).toBe(homedir());
    });
  });

  it("uses USERPROFILE when HOME is unavailable", () => {
    withEnv({ HOME: undefined, USERPROFILE: "C:\\Users\\weave-test" }, () => {
      const fileSystem = new BunFileSystem();

      expect(fileSystem.home()).toBe("C:\\Users\\weave-test");
    });
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

  it("normalizes Windows backslashes in relative paths", () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/example");

    expect(fs.resolvePath("src\\foo\\bar.ts")).toBe("/project/src/foo/bar.ts");
  });

  it("normalizes Windows backslashes in tilde paths", () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/example");

    expect(fs.resolvePath("~\\.weave\\config.weave")).toBe(
      "/home/example/.weave/config.weave",
    );
  });

  it("resolves files written with backslash paths via posix keys", async () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/example");

    await fs.writeText("src\\config.weave", "content");

    const result = await fs.readText("src/config.weave");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("content");
  });
});
