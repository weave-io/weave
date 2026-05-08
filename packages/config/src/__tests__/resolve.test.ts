import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weave/core";
import { parseConfig } from "@weave/core";
import { resolvePromptPaths } from "../resolve.js";
import type { ConfigScope } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolvePromptPaths", () => {
  it("(a) builtin scope: resolves prompt_file relative to rootDir/prompts/", () => {
    const config = cfg(
      `agent loom { prompt_file "loom.md" models ["claude-sonnet-4-5"] }`,
    );
    const scope: ConfigScope = { kind: "builtin", rootDir: "/pkg/config" };
    const resolved = resolvePromptPaths(config, scope);
    expect(resolved.agents.loom?.prompt_file).toBe(
      "/pkg/config/prompts/loom.md",
    );
  });

  it("(b) global scope: resolves prompt_file to ~/.weave/prompts/<file>", () => {
    const config = cfg(
      `agent custom { prompt_file "custom.md" models ["gpt-4o"] }`,
    );
    const scope: ConfigScope = { kind: "global", rootDir: "/home/user/.weave" };
    const resolved = resolvePromptPaths(config, scope);
    expect(resolved.agents.custom?.prompt_file).toBe(
      "/home/user/.weave/prompts/custom.md",
    );
  });

  it("(c) project scope: resolves prompt_file to <projectRoot>/.weave/prompts/<file>", () => {
    const config = cfg(
      `agent shuttle { prompt_file "shuttle.md" models ["claude-sonnet-4-5"] }`,
    );
    const scope: ConfigScope = { kind: "project", rootDir: "/proj/.weave" };
    const resolved = resolvePromptPaths(config, scope);
    expect(resolved.agents.shuttle?.prompt_file).toBe(
      "/proj/.weave/prompts/shuttle.md",
    );
  });

  it("(d) agent without prompt_file is left unchanged", () => {
    const config = cfg(`agent helper { prompt "I help" models ["gpt-4o"] }`);
    const scope: ConfigScope = { kind: "project", rootDir: "/proj/.weave" };
    const resolved = resolvePromptPaths(config, scope);
    expect(resolved.agents.helper?.prompt_file).toBeUndefined();
    expect(resolved.agents.helper?.prompt).toBe("I help");
  });

  it("(e) mixed agents: only agent with prompt_file is resolved", () => {
    const config = cfg(`
      agent with-file { prompt_file "agent.md" models ["claude-sonnet-4-5"] }
      agent without-file { prompt "Inline prompt" models ["gpt-4o"] }
    `);
    const scope: ConfigScope = { kind: "project", rootDir: "/proj/.weave" };
    const resolved = resolvePromptPaths(config, scope);
    expect(resolved.agents["with-file"]?.prompt_file).toBe(
      "/proj/.weave/prompts/agent.md",
    );
    expect(resolved.agents["without-file"]?.prompt_file).toBeUndefined();
    expect(resolved.agents["without-file"]?.prompt).toBe("Inline prompt");
  });

  it("(f) immutability: original config not mutated", () => {
    const config = cfg(
      `agent loom { prompt_file "loom.md" models ["claude-sonnet-4-5"] }`,
    );
    const originalPromptFile = config.agents.loom?.prompt_file;
    const scope: ConfigScope = { kind: "project", rootDir: "/proj/.weave" };

    resolvePromptPaths(config, scope);

    expect(config.agents.loom?.prompt_file).toBe(originalPromptFile);
  });
});
