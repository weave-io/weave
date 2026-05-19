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

  it("(g) builtin config has no categories or disabled entries", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    expect(Object.keys(config.categories)).toHaveLength(0);
    expect(config.disabled.agents).toHaveLength(0);
    expect(config.disabled.hooks).toHaveLength(0);
    expect(config.disabled.skills).toHaveLength(0);
  });

  it("(g2) builtin config has 3 standard workflows", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    expect(Object.keys(config.workflows)).toHaveLength(3);
    expect(config.workflows["plan-and-execute"]).toBeDefined();
    expect(config.workflows["quick-fix"]).toBeDefined();
    expect(config.workflows["tapestry-execution"]).toBeDefined();
  });

  it("(h) BUILTIN_WEAVE_SOURCE is valid DSL — parseConfig returns no errors", () => {
    const result = parseConfig(BUILTIN_WEAVE_SOURCE);
    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Trigger assertions
  // ---------------------------------------------------------------------------

  const SPECIALIST_AGENTS = [
    "shuttle",
    "pattern",
    "thread",
    "spindle",
    "weft",
    "warp",
  ] as const;

  const ORCHESTRATOR_AGENTS = ["loom", "tapestry"] as const;

  it("(i) specialist agents (shuttle, pattern, thread, spindle, weft, warp) each have at least one trigger", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    for (const name of SPECIALIST_AGENTS) {
      const agent = config.agents[name];
      expect(agent).toBeDefined();
      expect(agent?.triggers).toBeDefined();
      expect(agent?.triggers?.length).toBeGreaterThan(0);
    }
  });

  it("(j) orchestrator agents (loom, tapestry) do NOT have triggers", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    for (const name of ORCHESTRATOR_AGENTS) {
      const agent = config.agents[name];
      expect(agent).toBeDefined();
      // triggers should be undefined or empty for orchestrators
      const hasTriggers =
        agent?.triggers !== undefined && agent.triggers.length > 0;
      expect(hasTriggers).toBe(false);
    }
  });

  it("(k) each specialist trigger has non-empty domain and trigger strings", () => {
    const config = getBuiltinConfig()._unsafeUnwrap();
    for (const name of SPECIALIST_AGENTS) {
      const agent = config.agents[name];
      for (const t of agent?.triggers ?? []) {
        expect(t.domain.trim().length).toBeGreaterThan(0);
        expect(t.trigger.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
