import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weave/core";
import { parseConfig } from "@weave/core";
import { mergeConfigs } from "../merge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a .weave source string and unwrap — throws on invalid input. */
function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const emptyConfig = cfg("");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mergeConfigs", () => {
  // -------------------------------------------------------------------------
  // Scalars
  // -------------------------------------------------------------------------

  it("(a) scalar override: last-defined log_level wins", () => {
    const a = cfg("log_level INFO");
    const b = cfg("log_level DEBUG");
    const merged = mergeConfigs(a, b);
    expect(merged.log_level).toBe("DEBUG");
  });

  it("(b) three-layer scalar: only third layer sets log_level → third value wins", () => {
    const a = cfg("");
    const b = cfg("");
    const c = cfg("log_level WARN");
    const merged = mergeConfigs(a, b, c);
    expect(merged.log_level).toBe("WARN");
  });

  // -------------------------------------------------------------------------
  // Agent deep-merge
  // -------------------------------------------------------------------------

  it("(c) agent deep-merge: partial override preserves unset fields", () => {
    const base = cfg(`
      agent loom {
        prompt_file "loom.md"
        models ["claude-sonnet-4-5"]
        temperature 0.1
      }
    `);
    const override = cfg(`
      agent loom {
        temperature 0.5
      }
    `);
    const merged = mergeConfigs(base, override);
    const loom = merged.agents.loom;
    expect(loom?.temperature).toBe(0.5);
    expect(loom?.prompt_file).toBe("loom.md");
    expect(loom?.models).toEqual(["claude-sonnet-4-5"]);
  });

  it("(d) agent addition: agents from different scopes both present in merged config", () => {
    const base = cfg(
      `agent loom { prompt "I am loom" models ["claude-sonnet-4-5"] }`,
    );
    const addition = cfg(
      `agent my-helper { prompt "I help" models ["gpt-4o"] }`,
    );
    const merged = mergeConfigs(base, addition);
    expect(merged.agents.loom).toBeDefined();
    expect(merged.agents["my-helper"]).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Array union-merge
  // -------------------------------------------------------------------------

  it("(e) array union-merge (models): override entries first, then base", () => {
    const base = cfg(`agent loom { prompt "x" models ["gpt-4o"] }`);
    const override = cfg(
      `agent loom { prompt "x" models ["claude-sonnet-4-5"] }`,
    );
    const merged = mergeConfigs(base, override);
    expect(merged.agents.loom?.models).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
  });

  it("(f) array union-merge (disabled.agents): union across scopes, override first", () => {
    const global = cfg(`disable agents ["warp"]`);
    const project = cfg(`disable agents ["spindle"]`);
    const merged = mergeConfigs(global, project);
    // project is override so spindle comes first
    expect(merged.disabled.agents).toEqual(["spindle", "warp"]);
  });

  it("(g) array union-merge dedup: duplicate model appears exactly once", () => {
    const base = cfg(
      `agent loom { prompt "x" models ["claude-sonnet-4-5", "gpt-4o"] }`,
    );
    const override = cfg(
      `agent loom { prompt "x" models ["claude-sonnet-4-5"] }`,
    );
    const merged = mergeConfigs(base, override);
    const models = merged.agents.loom?.models ?? [];
    const claudeCount = models.filter((m) => m === "claude-sonnet-4-5").length;
    expect(claudeCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("(h) empty config merges: valid empty config returned", () => {
    const merged = mergeConfigs(emptyConfig, emptyConfig);
    expect(merged.agents).toEqual({});
    expect(merged.disabled.agents).toEqual([]);
  });

  it("(i) single config: returns equivalent config", () => {
    const single = cfg(`
      agent shuttle { prompt "I shuttle" models ["claude-sonnet-4-5"] }
    `);
    const merged = mergeConfigs(single);
    expect(merged.agents.shuttle).toBeDefined();
    expect(merged.agents.shuttle?.prompt).toBe("I shuttle");
  });

  it("(j) zero configs: returns default empty WeaveConfig", () => {
    const merged = mergeConfigs();
    expect(merged.agents).toEqual({});
    expect(merged.categories).toEqual({});
    expect(merged.disabled.agents).toEqual([]);
  });

  it("(k) immutability: inputs are not mutated after merge", () => {
    const base = cfg(`
      agent loom {
        prompt_file "loom.md"
        models ["claude-sonnet-4-5"]
        temperature 0.1
      }
    `);
    const override = cfg(`agent loom { temperature 0.5 }`);

    // Snapshot the original values
    const originalBaseTemp = base.agents.loom?.temperature;
    const originalBasePromptFile = base.agents.loom?.prompt_file;

    mergeConfigs(base, override);

    expect(base.agents.loom?.temperature).toBe(originalBaseTemp);
    expect(base.agents.loom?.prompt_file).toBe(originalBasePromptFile);
  });

  it("(l) tool_policy deep-merge: base policy + extra key from override, all keys present", () => {
    const base = cfg(`
      agent loom {
        prompt "x"
        tool_policy {
          read allow
          write allow
        }
      }
    `);
    const override = cfg(`
      agent loom {
        prompt "x"
        tool_policy {
          search ask
        }
      }
    `);
    const merged = mergeConfigs(base, override);
    const policy = merged.agents.loom?.tool_policy;
    expect(policy?.read).toBe("allow");
    expect(policy?.write).toBe("allow");
    expect(policy?.search).toBe("ask");
  });
});
