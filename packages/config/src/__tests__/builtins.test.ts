import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weave/core";
import {
  BUILTIN_AGENT_NAMES,
  BUILTIN_WEAVE_SOURCE,
  getBuiltinConfig,
} from "../builtins.js";

describe("getBuiltinConfig", () => {
  it("(a) returns ok — not err", () => {
    const result = getBuiltinConfig();
    expect(result.isOk()).toBe(true);
  });

  it("(b) result contains exactly 8 agents matching BUILTIN_AGENT_NAMES", () => {
    const result = getBuiltinConfig();
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    const names = Object.keys(config.agents).sort();
    expect(names).toEqual([...BUILTIN_AGENT_NAMES].sort());
    expect(names).toHaveLength(8);
  });

  it("(c) loom has temperature 0.1 and prompt_file loom.md", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const loom = config.agents.loom;
    expect(loom).toBeDefined();
    expect(loom?.temperature).toBe(0.1);
    expect(loom?.prompt_file).toBe("loom.md");
  });

  it("(d) shuttle has temperature 0.2 and prompt_file shuttle.md", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const shuttle = config.agents.shuttle;
    expect(shuttle).toBeDefined();
    expect(shuttle?.temperature).toBe(0.2);
    expect(shuttle?.prompt_file).toBe("shuttle.md");
  });

  it("(e) thread has temperature 0.0", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const thread = config.agents.thread;
    expect(thread).toBeDefined();
    expect(thread?.temperature).toBe(0);
  });

  it("(f) pattern has temperature 0.3", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    const pattern = config.agents.pattern;
    expect(pattern).toBeDefined();
    expect(pattern?.temperature).toBe(0.3);
  });

  it("(g) builtin config has no categories, workflows, or disabled entries", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    expect(Object.keys(config.categories)).toHaveLength(0);
    expect(Object.keys(config.workflows ?? {})).toHaveLength(0);
    expect(config.disabled.agents).toHaveLength(0);
    expect(config.disabled.hooks).toHaveLength(0);
    expect(config.disabled.skills).toHaveLength(0);
  });

  it("(h) BUILTIN_WEAVE_SOURCE is valid DSL — parseConfig returns no errors", () => {
    const result = parseConfig(BUILTIN_WEAVE_SOURCE);
    expect(result.isOk()).toBe(true);
  });
});
