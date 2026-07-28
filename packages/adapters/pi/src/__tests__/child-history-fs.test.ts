import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { platform } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  BunPiChildHistoryFs,
  MemoryPiChildHistoryFs,
  resolvePiChildHistoryRoot,
  safeParentSessionComponent,
} from "../child-history-fs.js";

const env = {} as const;
const homeDir = "/home/tester";

function resolve(input: {
  readonly parentSessionId: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}): string {
  return resolvePiChildHistoryRoot({
    parentSessionId: input.parentSessionId,
    env: input.env ?? env,
    homeDir: input.homeDir ?? homeDir,
  }).unwrapOr("");
}

describe("resolvePiChildHistoryRoot", () => {
  test("uses the default XDG data path", () => {
    expect(resolve({ parentSessionId: "parent-123" })).toBe(
      join(
        homeDir,
        ".local",
        "share",
        "weave",
        "adapters",
        "pi",
        "child-history",
        "parent-123",
      ),
    );
  });

  test("uses an absolute XDG_DATA_HOME override", () => {
    expect(
      resolve({
        parentSessionId: "parent-123",
        env: { XDG_DATA_HOME: "/var/lib/data" },
      }),
    ).toBe("/var/lib/data/weave/adapters/pi/child-history/parent-123");
  });

  test("overrides only the data prefix", () => {
    const defaultPath = resolve({ parentSessionId: "parent-123" });
    const overriddenPath = resolve({
      parentSessionId: "parent-123",
      env: { XDG_DATA_HOME: "/var/lib/data" },
    });

    expect(
      overriddenPath.replace("/var/lib/data", join(homeDir, ".local", "share")),
    ).toBe(defaultPath);
  });

  test("hashes unsafe and overlong session IDs into one path component", () => {
    const unsafe = resolve({ parentSessionId: "parent/session" });
    const overlong = resolve({ parentSessionId: "a".repeat(65) });

    expect(unsafe).toBe(
      "/home/tester/.local/share/weave/adapters/pi/child-history/" +
        "b9eed5ae0757dc74566b82c89c93a52a94ba74011416dcce7d02a9219fca8b64",
    );
    expect(overlong).toMatch(/child-history\/[0-9a-f]{64}$/);
    expect(overlong.includes("/".repeat(2))).toBe(false);
  });

  test.each([
    [".", "dot"],
    ["..", "dot-dot"],
    ["parent/session", "slash"],
    [String.raw`parent\\session`, "backslash"],
    ["", "empty"],
    ["こんにちは", "Unicode"],
    ["nul\0like", "NUL-like"],
  ])("maps %s input to one safe component (%s)", (input) => {
    const result = safeParentSessionComponent(input);
    const repeated = safeParentSessionComponent(input);

    expect(result.isOk()).toBe(true);
    expect(repeated.isOk()).toBe(true);
    const component = result.unwrapOr("");
    const repeatedComponent = repeated.unwrapOr("");
    expect(component).toBe(repeatedComponent);
    expect(component).not.toBe("");
    expect(component).not.toBe(".");
    expect(component).not.toBe("..");
    expect(component).not.toContain("/");
    expect(component).not.toContain("\\");
    expect(component).not.toContain("\0");
  });

  test("uses a safe component for an empty session ID", () => {
    expect(resolve({ parentSessionId: "" })).toMatch(
      /child-history\/[0-9a-f]{64}$/,
    );
  });

  test("returns an error for a relative XDG_DATA_HOME", () => {
    const result = resolvePiChildHistoryRoot({
      parentSessionId: "parent-123",
      env: { XDG_DATA_HOME: "relative/data" },
      homeDir,
    });

    expect(result.isErr()).toBe(true);
    expect(result.isErr() ? result.error : undefined).toEqual({
      type: "relative-xdg-data-home",
    });
  });

  test("returns an error for an empty home", () => {
    const result = resolvePiChildHistoryRoot({
      parentSessionId: "parent-123",
      env,
      homeDir: "",
    });

    expect(result.isErr()).toBe(true);
    expect(result.isErr() ? result.error : undefined).toEqual({
      type: "empty-home",
    });
  });
});

describe("BunPiChildHistoryFs — real filesystem conformance", () => {
  let root: string;

  beforeEach(async () => {
    const tempParent = platform() === "darwin" ? "/private/tmp" : "/tmp";
    const result = await $`mktemp -d ${join(tempParent, "weave-child-history-test.XXXXXX")}`.quiet();
    root = result.text().trim();
  });

  afterEach(async () => {
    await $`rm -rf ${root}`.quiet();
  });

  async function openDirectory(path: string, create = true) {
    const result = await new BunPiChildHistoryFs().openDirectory(path, create);
    if (result.isErr()) throw new Error(`open failed: ${JSON.stringify(result.error)}`);
    expect(result.isOk()).toBe(true);
    return result.value;
  }

  async function modeOf(path: string): Promise<number> {
    const stat = await Bun.file(path).stat();
    return stat.mode & 0o7777;
  }

  test("creates private directories and files, then atomically reads and deletes them", async () => {
    const path = join(root, "history", "nested");
    const directory = await openDirectory(path);
    try {
      expect(await modeOf(join(root, "history"))).toBe(0o700);
      expect(await modeOf(path)).toBe(0o700);

      const bytes = new TextEncoder().encode("safe history bytes");
      expect(
        (await directory.writeFileAtomic("session.log", bytes, 0o600)).isOk(),
      ).toBe(true);
      expect(await modeOf(join(path, "session.log"))).toBe(0o600);
      const read = await directory.readFile("session.log");
      expect(read.isOk()).toBe(true);
      if (read.isOk()) expect(read.value).toEqual(bytes);
      expect((await directory.deleteFile("session.log")).isOk()).toBe(true);
      const missing = await directory.readFile("session.log");
      expect(missing.isOk()).toBe(true);
      if (missing.isOk()) expect(missing.value).toBeUndefined();
    } finally {
      directory.close();
    }
  });

  test("rejects symlinked directory and file nodes without exposing seeded content", async () => {
    const outside = join(root, "outside");
    await $`mkdir -p ${outside}`.quiet();
    const seeded = "seeded raw content must stay private";
    await Bun.write(join(outside, "secret.log"), seeded);
    await $`chmod 600 ${join(outside, "secret.log")}`.quiet();
    await $`ln -s ${outside} ${join(root, "linked-directory")}`.quiet();

    const linkedDirectory = await new BunPiChildHistoryFs().openDirectory(
      join(root, "linked-directory"),
      false,
    );
    expect(linkedDirectory.isErr()).toBe(true);
    expect(JSON.stringify(linkedDirectory)).not.toContain(seeded);

    const directory = await openDirectory(join(root, "history"));
    try {
      await $`ln -s ${join(outside, "secret.log")} ${join(join(root, "history"), "linked.log")}`.quiet();
      const read = await directory.readFile("linked.log");
      expect(read.isErr()).toBe(true);
      expect(JSON.stringify(read)).not.toContain(seeded);

      const write = await directory.writeFileAtomic(
        "linked.log",
        new TextEncoder().encode("replacement"),
        0o600,
      );
      expect(write.isErr()).toBe(true);
      expect(JSON.stringify(write)).not.toContain(seeded);
    } finally {
      directory.close();
    }
  });

  test("detects a directory replaced after its handle is acquired before mutation", async () => {
    const path = join(root, "history");
    const directory = await openDirectory(path);
    try {
      const oldPath = join(root, "history-old");
      await $`mv ${path} ${oldPath}`.quiet();
      await $`mkdir ${path} && chmod 700 ${path}`.quiet();

      const result = await directory.writeFileAtomic(
        "new.log",
        new TextEncoder().encode("directory replacement secret"),
        0o600,
      );
      expect(result.isErr()).toBe(true);
      expect(result.isErr() ? result.error : undefined).toEqual({
        type: "identity-changed",
      });
      expect(await Bun.file(join(path, "new.log")).exists()).toBe(false);
      expect(JSON.stringify(result)).not.toContain("directory replacement secret");
    } finally {
      directory.close();
    }
  });

  test("detects a file replaced after its identity was captured", async () => {
    const path = join(root, "history");
    const directory = await openDirectory(path);
    try {
      await directory.writeFileAtomic(
        "session.log",
        new TextEncoder().encode("original"),
        0o600,
      );
      expect((await directory.readFile("session.log")).isOk()).toBe(true);

      const file = join(path, "session.log");
      const oldFile = join(path, "session.log-old");
      const seededReplacement = "replaced file secret";
      await $`mv ${file} ${oldFile}`.quiet();
      await Bun.write(file, seededReplacement);
      await $`chmod 600 ${file}`.quiet();

      const result = await directory.readFile("session.log");
      expect(result.isErr()).toBe(true);
      expect(result.isErr() ? result.error : undefined).toEqual({
        type: "identity-changed",
      });
      expect(JSON.stringify(result)).not.toContain(seededReplacement);
    } finally {
      directory.close();
    }
  });

  test("rejects permissive pre-existing directories and files instead of repairing them", async () => {
    const directoryPath = join(root, "history");
    await $`mkdir ${directoryPath} && chmod 755 ${directoryPath}`.quiet();
    const directoryResult = await new BunPiChildHistoryFs().openDirectory(
      directoryPath,
      true,
    );
    expect(directoryResult.isErr()).toBe(true);
    expect(directoryResult.isErr() ? directoryResult.error : undefined).toEqual({
      type: "permissive-mode",
      kind: "directory",
    });
    expect(await modeOf(directoryPath)).toBe(0o755);

    const safeDirectory = await openDirectory(join(root, "safe-history"));
    try {
      const file = join(root, "safe-history", "session.log");
      await Bun.write(file, "permissive file secret");
      await $`chmod 644 ${file}`.quiet();
      const result = await safeDirectory.readFile("session.log");
      expect(result.isErr()).toBe(true);
      expect(result.isErr() ? result.error : undefined).toEqual({
        type: "permissive-mode",
        kind: "file",
      });
      expect(await modeOf(file)).toBe(0o644);
      expect(JSON.stringify(result)).not.toContain("permissive file secret");
    } finally {
      safeDirectory.close();
    }
  });

  test("rejects traversal names before touching the filesystem", async () => {
    const directory = await openDirectory(join(root, "history"));
    try {
      const escapedDirectory = await new BunPiChildHistoryFs().openDirectory(
        `${root}/../escaped-history`,
        true,
      );
      expect(escapedDirectory.isErr()).toBe(true);
      expect(escapedDirectory.isErr() ? escapedDirectory.error : undefined).toEqual({
        type: "unsafe-path",
      });
      const unsafeRead = await directory.readFile("../secret.log");
      expect(unsafeRead.isErr()).toBe(true);
      if (unsafeRead.isErr())
        expect(unsafeRead.error).toEqual({ type: "unsafe-path" });
      const unsafeWrite = await directory.writeFileAtomic(
        "nested/secret.log",
        new Uint8Array([1]),
        0o600,
      );
      expect(unsafeWrite.isErr()).toBe(true);
      if (unsafeWrite.isErr())
        expect(unsafeWrite.error).toEqual({ type: "unsafe-path" });
    } finally {
      directory.close();
    }
  });
});

describe("MemoryPiChildHistoryFs hardening", () => {
  const path = "/tmp/weave-child-history";

  async function openDirectory(fs: MemoryPiChildHistoryFs) {
    const opened = await fs.openDirectory(path, true);
    if (opened.isErr()) throw opened.error;
    return opened.value;
  }

  test("rejects replaced, symlinked, and permissive directories", async () => {
    const replacedFs = new MemoryPiChildHistoryFs();
    const replaced = await openDirectory(replacedFs);
    replacedFs.simulateDirectoryReplacement(path);
    expect((await replaced.identity())._unsafeUnwrapErr()).toEqual({
      type: "identity-changed",
    });

    const symlinkFs = new MemoryPiChildHistoryFs();
    const symlinked = await openDirectory(symlinkFs);
    symlinkFs.simulateDirectorySymlink(path);
    expect((await symlinked.identity())._unsafeUnwrapErr()).toEqual({
      type: "symlink-rejected",
    });
    expect(
      (await symlinkFs.openDirectory(path, false))._unsafeUnwrapErr(),
    ).toEqual({
      type: "symlink-rejected",
    });

    const permissiveFs = new MemoryPiChildHistoryFs();
    const permissive = await openDirectory(permissiveFs);
    permissiveFs.simulatePermissiveDirectory(path);
    expect((await permissive.identity())._unsafeUnwrapErr()).toEqual({
      type: "permissive-mode",
      kind: "directory",
    });
  });

  test("rejects existing unsafe files without exposing their content", async () => {
    const symlinkFs = new MemoryPiChildHistoryFs();
    const symlinkDirectory = await openDirectory(symlinkFs);
    symlinkFs.simulateFileSymlink(path, "session.log");
    expect(
      (await symlinkDirectory.readFile("session.log"))._unsafeUnwrapErr(),
    ).toEqual({
      type: "symlink-rejected",
    });
    expect(
      (
        await symlinkDirectory.writeFileAtomic(
          "session.log",
          new TextEncoder().encode("secret"),
          0o600,
        )
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "symlink-rejected" });

    const permissiveFs = new MemoryPiChildHistoryFs();
    const permissiveDirectory = await openDirectory(permissiveFs);
    await permissiveDirectory.writeFileAtomic(
      "session.log",
      new TextEncoder().encode("secret"),
      0o600,
    );
    permissiveFs.simulatePermissiveFile(path, "session.log");
    const result = await permissiveDirectory.readFile("session.log");
    expect(result.isErr()).toBe(true);
    expect(result.isErr() ? result.error : undefined).toEqual({
      type: "permissive-mode",
      kind: "file",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("detects file identity replacement and validates atomic targets", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const directory = await openDirectory(fs);
    await directory.writeFileAtomic("index.json", new Uint8Array([1]), 0o600);
    expect((await directory.readFile("index.json"))._unsafeUnwrap()).toEqual(
      new Uint8Array([1]),
    );

    fs.simulateFileReplacement(path, "index.json");
    expect((await directory.readFile("index.json"))._unsafeUnwrapErr()).toEqual(
      {
        type: "identity-changed",
      },
    );
    expect(
      (
        await directory.writeFileAtomic(
          "index.json",
          new Uint8Array([2]),
          0o600,
        )
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "identity-changed" });

    const tempFs = new MemoryPiChildHistoryFs();
    const tempDirectory = await openDirectory(tempFs);
    tempFs.simulateFileSymlink(path, ".index.json.tmp-recovery");
    expect(
      (
        await tempDirectory.writeFileAtomic(
          ".index.json.tmp-recovery",
          new Uint8Array([3]),
          0o600,
        )
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "symlink-rejected" });
  });

  test("creates private file contents and rejects wrong kinds", async () => {
    const fs = new MemoryPiChildHistoryFs();
    const directory = await openDirectory(fs);
    await directory.appendFile("session.log", new Uint8Array([1]), 0o600);
    await directory.appendFile("session.log", new Uint8Array([2]), 0o600);
    expect(fs.files(path).get("session.log")).toEqual(new Uint8Array([1, 2]));

    fs.simulateDirectoryFile(path, "directory-node");
    expect(
      (await directory.readFile("directory-node"))._unsafeUnwrapErr(),
    ).toEqual({
      type: "wrong-kind",
      kind: "file",
    });
  });
});
