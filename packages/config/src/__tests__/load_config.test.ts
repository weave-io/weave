import { describe, expect, it } from "bun:test";
import { isAbsolute } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import { BUILTIN_AGENT_NAMES } from "../builtins.js";
import type { FileReader } from "../discovery.js";
import { loadConfig } from "../loader.js";

// ---------------------------------------------------------------------------
// Mock file reader helpers
// ---------------------------------------------------------------------------

type FileMap = Record<string, string | "ERROR">;

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

const HOME = "/home/testuser";
const PROJECT = "/my/project";
const GLOBAL_PATH = `${HOME}/.weave/config.weave`;
const PROJECT_PATH = `${PROJECT}/.weave/config.weave`;

function withHome<T>(fn: () => T): T {
  const orig = process.env.HOME;
  process.env.HOME = HOME;
  try {
    return fn();
  } finally {
    process.env.HOME = orig;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("(a) zero-config: no user files → returns ok with all 8 builtin agents", async () => {
    const reader = mockReader({});
    const result = await withHome(() => loadConfig(PROJECT, reader));

    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    const agentNames = Object.keys(config.agents).sort();
    expect(agentNames).toEqual([...BUILTIN_AGENT_NAMES].sort());
  });

  it("(a) zero-config: prompt_file paths are absolute", async () => {
    const reader = mockReader({});
    const result = await withHome(() => loadConfig(PROJECT, reader));

    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();

    for (const [, agent] of Object.entries(config.agents)) {
      if (agent.prompt_file !== undefined) {
        expect(isAbsolute(agent.prompt_file)).toBe(true);
      }
    }
  });

  it("(b) project override: temperature overrides builtin, other fields preserved", async () => {
    const reader = mockReader({
      [PROJECT_PATH]: `agent loom { temperature 0.5 }`,
    });
    const result = await withHome(() => loadConfig(PROJECT, reader));

    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    const loom = config.agents.loom;

    expect(loom?.temperature).toBe(0.5);
    // prompt_file should come from builtin (absolute path), not overridden
    expect(loom?.prompt_file).toBeDefined();
    expect(isAbsolute(loom?.prompt_file ?? "")).toBe(true);
  });

  it("(c) global custom agent: merged config contains all 8 builtins + custom agent", async () => {
    const reader = mockReader({
      [GLOBAL_PATH]: `agent my-helper { prompt "I help" models ["gpt-4o"] }`,
    });
    const result = await withHome(() => loadConfig(PROJECT, reader));

    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();

    // All builtins present
    for (const name of BUILTIN_AGENT_NAMES) {
      expect(config.agents[name]).toBeDefined();
    }
    // Custom agent also present
    expect(config.agents["my-helper"]).toBeDefined();
    expect(config.agents["my-helper"]?.prompt).toBe("I help");
  });

  it("(d) both configs: three-layer merge — project settings.log_level and loom temperature win", async () => {
    const reader = mockReader({
      [GLOBAL_PATH]: `settings { log_level INFO }`,
      [PROJECT_PATH]: `
        settings { log_level DEBUG }
        agent loom { temperature 0.9 }
      `,
    });
    const result = await withHome(() => loadConfig(PROJECT, reader));

    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();

    expect(config.settings.log_level).toBe("DEBUG");
    expect(config.agents.loom?.temperature).toBe(0.9);
    // builtin models still present (not overridden)
    expect(config.agents.loom?.models).toContain("claude-sonnet-4-5");
  });

  it("(e) parse error: project config has invalid DSL → returns err with ParseError", async () => {
    const reader = mockReader({
      [PROJECT_PATH]: `agent {`, // invalid — missing name
    });
    const result = await withHome(() => loadConfig(PROJECT, reader));

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.length).toBeGreaterThan(0);
    const parseErrors = errors.filter((e) => e.type === "ParseError");
    expect(parseErrors.length).toBeGreaterThan(0);
    const pe = parseErrors[0];
    if (pe?.type === "ParseError") {
      expect(pe.path).toBe(PROJECT_PATH);
    }
  });

  it("(f) I/O error: file read throws → returns err with FileReadError", async () => {
    const reader = mockReader({
      [PROJECT_PATH]: "ERROR",
    });
    const result = await withHome(() => loadConfig(PROJECT, reader));

    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    const ioErrors = errors.filter((e) => e.type === "FileReadError");
    expect(ioErrors.length).toBeGreaterThan(0);
    const fe = ioErrors[0];
    if (fe?.type === "FileReadError") {
      expect(fe.path).toBe(PROJECT_PATH);
    }
  });

  it("(g) all prompt_file values in returned config are absolute paths", async () => {
    const reader = mockReader({
      [PROJECT_PATH]: `agent loom { prompt_file "loom.md" }`,
    });
    const result = await withHome(() => loadConfig(PROJECT, reader));

    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();

    for (const [, agent] of Object.entries(config.agents)) {
      if (agent.prompt_file !== undefined) {
        expect(isAbsolute(agent.prompt_file)).toBe(true);
      }
    }
  });
});
