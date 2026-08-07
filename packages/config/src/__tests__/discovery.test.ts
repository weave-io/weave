import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { FileReader } from "../discovery.js";
import { discoverAndParse } from "../discovery.js";

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

function withEnv<T>(
  values: { HOME?: string; USERPROFILE?: string },
  callback: () => T,
): T {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  try {
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
    process.env.HOME = HOME;

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;

    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.scope.kind).toBe("global");
    expect(entries[1]?.scope.kind).toBe("project");
  });

  it("(b) only global exists → returns 1 entry with kind global", async () => {
    const reader = mockReader({ [GLOBAL_PATH]: VALID_DSL });
    const origHome = process.env.HOME;
    process.env.HOME = HOME;

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;

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
    process.env.HOME = HOME;

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;

    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope.kind).toBe("project");
  });

  it("(d) neither file exists → returns empty array, not an error", async () => {
    const reader = mockReader({});
    const origHome = process.env.HOME;
    process.env.HOME = HOME;

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(0);
  });

  it("(e) file exists but read fails → returns err with FileReadError containing the path", async () => {
    const reader = mockReader({ [PROJECT_PATH]: "ERROR" });
    const origHome = process.env.HOME;
    process.env.HOME = HOME;

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;

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
    process.env.HOME = HOME;

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;

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
    process.env.HOME = HOME;

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;

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
    process.env.HOME = HOME;

    const result = await discoverAndParse(PROJECT, reader);

    process.env.HOME = origHome;

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(2);

    const paths = errors.map((e) => (e.type === "ParseError" ? e.path : ""));
    expect(paths).toContain(GLOBAL_PATH);
    expect(paths).toContain(PROJECT_PATH);
  });
});
