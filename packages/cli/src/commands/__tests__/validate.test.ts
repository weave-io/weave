import { describe, expect, it } from "bun:test";
import { MemoryFileSystem } from "../../fs/file-system.js";
import { BufferTerminal } from "../../io/terminal.js";
import { getTheme } from "../../theme/colors.js";
import { runValidate } from "../validate.js";

const fixtureRoot = new URL("../../__fixtures__/", import.meta.url);
const validConfig = await Bun.file(new URL("valid.weave", fixtureRoot)).text();
const invalidConfig = await Bun.file(
  new URL("invalid.weave", fixtureRoot),
).text();

function flags(
  overrides: Partial<Parameters<typeof runValidate>[0]["flags"]> = {},
) {
  return {
    help: false,
    version: false,
    json: false,
    yes: false,
    force: false,
    allHarnesses: false,
    project: false,
    global: false,
    ...overrides,
  };
}

function context(
  fs: MemoryFileSystem,
  overrides: Partial<Parameters<typeof runValidate>[0]["flags"]> = {},
) {
  const terminal = new BufferTerminal();
  return {
    terminal,
    ctx: {
      terminal,
      theme: getTheme(false),
      flags: flags(overrides),
      fs,
    },
  };
}

describe("validate command", () => {
  it("validates explicit paths", async () => {
    const fs = new MemoryFileSystem({ "/project/valid.weave": validConfig });
    const { terminal, ctx } = context(fs, { path: "/project/valid.weave" });
    const result = await runValidate(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("Weave config is valid");
    expect(terminal.out.join("\n")).toContain("agents: 1");
  });

  it("validates project config", async () => {
    const fs = new MemoryFileSystem({
      "/project/.weave/config.weave": validConfig,
    });
    const { terminal, ctx } = context(fs, { project: true });
    const result = await runValidate(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("categories: 1");
  });

  it("validates global config", async () => {
    const fs = new MemoryFileSystem({
      "/home/user/.weave/config.weave": validConfig,
    });
    const { terminal, ctx } = context(fs, { global: true });
    const result = await runValidate(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("workflows: 1");
  });

  it("prints file line and column for invalid DSL", async () => {
    const fs = new MemoryFileSystem({
      "/project/invalid.weave": invalidConfig,
    });
    const { terminal, ctx } = context(fs, { path: "/project/invalid.weave" });
    const result = await runValidate(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("/project/invalid.weave:");
    expect(terminal.err.join("\n")).toMatch(/\d+:\d+:/);
  });

  it("prints missing file errors", async () => {
    const fs = new MemoryFileSystem();
    const { terminal, ctx } = context(fs, { path: "/project/missing.weave" });
    const result = await runValidate(ctx);
    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("File not found");
  });

  it("emits parseable JSON", async () => {
    const fs = new MemoryFileSystem({ "/project/valid.weave": validConfig });
    const { terminal, ctx } = context(fs, {
      path: "/project/valid.weave",
      json: true,
    });
    const result = await runValidate(ctx);
    expect(result._unsafeUnwrap()).toBe(0);
    const parsed = JSON.parse(terminal.out.join("\n")) as {
      agents: Record<string, unknown>;
    };
    expect(Object.keys(parsed.agents)).toContain("helper");
  });
});
