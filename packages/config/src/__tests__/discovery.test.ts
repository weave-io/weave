import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { FileReader } from "../discovery.js";
import {
  discoverAndParse,
  GLOBAL_CONFIG_DIR_ENV,
  globalConfigDir,
} from "../discovery.js";

// ---------------------------------------------------------------------------
// Mock file reader helpers
// ---------------------------------------------------------------------------

const VALID_DSL = `
agent my-agent {
  prompt "Hello"
  models ["gpt-4o"]
}
`;

const INVALID_DSL = `agent {`; // missing name

type FileMap = Record<string, string | "ERROR">;

/**
 * Builds a mock FileReader from a map of path → content.
 * If the value is "ERROR", `read()` returns a FileReadError.
 * If the path is absent from the map, `exists()` returns false.
 */
function mockReader(files: FileMap): FileReader {
  return {
    exists: async (path) => path in files,
    read: (path) => {
      const content = files[path];
      if (content === "ERROR" || content === undefined) {
        const cause = new Error(
          content === "ERROR" ? "disk failure" : "not found",
        );
        return errAsync({ type: "FileReadError" as const, path, cause });
      }
      return okAsync(content);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const HOME = "/home/testuser";
const PROJECT = "/my/project";
const GLOBAL_PATH = `${HOME}/.weave/config.weave`;
const PROJECT_PATH = `${PROJECT}/.weave/config.weave`;

/**
 * Runs `callback` with the home-directory variables set to `values`.
 *
 * `WEAVE_GLOBAL_CONFIG_DIR` is cleared for the duration, because the test
 * preload sets it globally and it takes precedence over `HOME`. These tests
 * exercise the home-directory fallback specifically; the override has its own
 * cases below.
 */
function withEnv<T>(
  values: { HOME?: string; USERPROFILE?: string },
  callback: () => T,
): T {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalGlobalDir = process.env[GLOBAL_CONFIG_DIR_ENV];
  try {
    delete process.env[GLOBAL_CONFIG_DIR_ENV];
    if (values.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = values.HOME;
    if (values.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = values.USERPROFILE;
    return callback();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalGlobalDir === undefined)
      delete process.env[GLOBAL_CONFIG_DIR_ENV];
    else process.env[GLOBAL_CONFIG_DIR_ENV] = originalGlobalDir;
  }
}

describe("discoverAndParse", () => {
  it("(a) both files exist → returns 2 entries, global first", async () => {
    const reader = mockReader({
      [GLOBAL_PATH]: VALID_DSL,
      [PROJECT_PATH]: VALID_DSL,
    });
    // Override HOME for this call via projectRoot only; set HOME in env
    const origHome = process.env.HOME;
    const origGlobalDir = process.env[GLOBAL_CONFIG_DIR_ENV];
    process.env.HOME = HOME;
    delete process.env[GLOBAL_CONFIG_DIR_ENV];

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;
    if (origGlobalDir !== undefined)
      process.env[GLOBAL_CONFIG_DIR_ENV] = origGlobalDir;

    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.scope.kind).toBe("global");
    expect(entries[1]?.scope.kind).toBe("project");
  });

  it("(b) only global exists → returns 1 entry with kind global", async () => {
    const reader = mockReader({ [GLOBAL_PATH]: VALID_DSL });
    const origHome = process.env.HOME;
    const origGlobalDir = process.env[GLOBAL_CONFIG_DIR_ENV];
    process.env.HOME = HOME;
    delete process.env[GLOBAL_CONFIG_DIR_ENV];

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;
    if (origGlobalDir !== undefined)
      process.env[GLOBAL_CONFIG_DIR_ENV] = origGlobalDir;

    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope.kind).toBe("global");
  });

  it("uses USERPROFILE for global config when HOME is unavailable", async () => {
    const userProfile = "C:/Users/weave-test";
    const reader = mockReader({
      [`${userProfile}/.weave/config.weave`]: VALID_DSL,
    });

    const result = await withEnv(
      { HOME: undefined, USERPROFILE: userProfile },
      () => discoverAndParse(PROJECT, reader),
    );

    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope.kind).toBe("global");
  });

  it("(c) only project exists → returns 1 entry with kind project", async () => {
    const reader = mockReader({ [PROJECT_PATH]: VALID_DSL });
    const origHome = process.env.HOME;
    const origGlobalDir = process.env[GLOBAL_CONFIG_DIR_ENV];
    process.env.HOME = HOME;
    delete process.env[GLOBAL_CONFIG_DIR_ENV];

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;
    if (origGlobalDir !== undefined)
      process.env[GLOBAL_CONFIG_DIR_ENV] = origGlobalDir;

    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope.kind).toBe("project");
  });

  it("(d) neither file exists → returns empty array, not an error", async () => {
    const reader = mockReader({});
    const origHome = process.env.HOME;
    const origGlobalDir = process.env[GLOBAL_CONFIG_DIR_ENV];
    process.env.HOME = HOME;
    delete process.env[GLOBAL_CONFIG_DIR_ENV];

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;
    if (origGlobalDir !== undefined)
      process.env[GLOBAL_CONFIG_DIR_ENV] = origGlobalDir;

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(0);
  });

  it("(e) file exists but read fails → returns err with FileReadError containing the path", async () => {
    const reader = mockReader({ [PROJECT_PATH]: "ERROR" });
    const origHome = process.env.HOME;
    const origGlobalDir = process.env[GLOBAL_CONFIG_DIR_ENV];
    process.env.HOME = HOME;
    delete process.env[GLOBAL_CONFIG_DIR_ENV];

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;
    if (origGlobalDir !== undefined)
      process.env[GLOBAL_CONFIG_DIR_ENV] = origGlobalDir;

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type).toBe("FileReadError");
    expect((errors[0] as { type: "FileReadError"; path: string })?.path).toBe(
      PROJECT_PATH,
    );
  });

  it("(f) file reads but has invalid DSL → returns err with ParseError containing path and errors", async () => {
    const reader = mockReader({ [PROJECT_PATH]: INVALID_DSL });
    const origHome = process.env.HOME;
    const origGlobalDir = process.env[GLOBAL_CONFIG_DIR_ENV];
    process.env.HOME = HOME;
    delete process.env[GLOBAL_CONFIG_DIR_ENV];

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;
    if (origGlobalDir !== undefined)
      process.env[GLOBAL_CONFIG_DIR_ENV] = origGlobalDir;

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(1);
    const error = errors[0];
    expect(error?.type).toBe("ParseError");
    if (error?.type === "ParseError") {
      expect(error.path).toBe(PROJECT_PATH);
      expect(error.errors.length).toBeGreaterThan(0);
    }
  });

  it("(g) global parse error does not prevent project discovery — errors aggregated", async () => {
    const reader = mockReader({
      [GLOBAL_PATH]: INVALID_DSL,
      [PROJECT_PATH]: VALID_DSL,
    });
    const origHome = process.env.HOME;
    const origGlobalDir = process.env[GLOBAL_CONFIG_DIR_ENV];
    process.env.HOME = HOME;
    delete process.env[GLOBAL_CONFIG_DIR_ENV];

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;
    if (origGlobalDir !== undefined)
      process.env[GLOBAL_CONFIG_DIR_ENV] = origGlobalDir;

    // Global parse error means entire result is err (aggregated)
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type).toBe("ParseError");
  });

  it("(h) both files have invalid DSL → err with 2 errors, both paths present", async () => {
    const reader = mockReader({
      [GLOBAL_PATH]: INVALID_DSL,
      [PROJECT_PATH]: INVALID_DSL,
    });
    const origHome = process.env.HOME;
    const origGlobalDir = process.env[GLOBAL_CONFIG_DIR_ENV];
    process.env.HOME = HOME;
    delete process.env[GLOBAL_CONFIG_DIR_ENV];

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;
    if (origGlobalDir !== undefined)
      process.env[GLOBAL_CONFIG_DIR_ENV] = origGlobalDir;

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(2);

    const paths = errors.map((e) => (e.type === "ParseError" ? e.path : ""));
    expect(paths).toContain(GLOBAL_PATH);
    expect(paths).toContain(PROJECT_PATH);
  });
});

// ---------------------------------------------------------------------------
// WEAVE_GLOBAL_CONFIG_DIR
// ---------------------------------------------------------------------------

/**
 * Runs `callback` with `WEAVE_GLOBAL_CONFIG_DIR` set to `value` (or unset) and
 * `HOME` pinned to the fixture home, so the two can be told apart.
 */
function withGlobalConfigDir<T>(
  value: string | undefined,
  callback: () => T,
): T {
  const original = process.env[GLOBAL_CONFIG_DIR_ENV];
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = HOME;
    if (value === undefined) delete process.env[GLOBAL_CONFIG_DIR_ENV];
    else process.env[GLOBAL_CONFIG_DIR_ENV] = value;
    return callback();
  } finally {
    if (original === undefined) delete process.env[GLOBAL_CONFIG_DIR_ENV];
    else process.env[GLOBAL_CONFIG_DIR_ENV] = original;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
}

describe("globalConfigDir", () => {
  it("falls back to ~/.weave when the override is unset", () => {
    withGlobalConfigDir(undefined, () => {
      expect(globalConfigDir()).toBe(`${HOME}/.weave`);
    });
  });

  it("falls back to ~/.weave when the override is blank", () => {
    withGlobalConfigDir("   ", () => {
      expect(globalConfigDir()).toBe(`${HOME}/.weave`);
    });
  });

  it("uses the override directory when it is set", () => {
    withGlobalConfigDir("/somewhere/else", () => {
      expect(globalConfigDir()).toBe("/somewhere/else");
    });
  });
});

describe("discoverAndParse — WEAVE_GLOBAL_CONFIG_DIR", () => {
  it("reads the global config from the override, not from the home directory", async () => {
    const reader = mockReader({
      "/sandbox/global/config.weave": VALID_DSL,
      [GLOBAL_PATH]: INVALID_DSL,
      [PROJECT_PATH]: VALID_DSL,
    });

    const result = await withGlobalConfigDir("/sandbox/global", () =>
      discoverAndParse(PROJECT, reader),
    );

    expect(result.isOk()).toBe(true);
    const discovered = result._unsafeUnwrap();
    expect(discovered).toHaveLength(2);
    expect(discovered[0]?.scope.kind).toBe("global");
    expect(discovered[0]?.scope.rootDir).toBe("/sandbox/global");
  });

  it("drops the global layer when the override directory holds no config", async () => {
    const reader = mockReader({
      [GLOBAL_PATH]: VALID_DSL,
      [PROJECT_PATH]: VALID_DSL,
    });

    const result = await withGlobalConfigDir("/sandbox/empty", () =>
      discoverAndParse(PROJECT, reader),
    );

    expect(result.isOk()).toBe(true);
    const discovered = result._unsafeUnwrap();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.scope.kind).toBe("project");
  });

  it("keeps a broken config in the real home directory from reaching discovery", async () => {
    const reader = mockReader({
      [GLOBAL_PATH]: INVALID_DSL,
      [PROJECT_PATH]: VALID_DSL,
    });

    const result = await withGlobalConfigDir("/sandbox/empty", () =>
      discoverAndParse(PROJECT, reader),
    );

    expect(result.isOk()).toBe(true);
  });
});
