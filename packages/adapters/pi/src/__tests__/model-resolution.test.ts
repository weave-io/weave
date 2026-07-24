import { describe, expect, it } from "bun:test";
import type { PiModelInfo } from "../model-resolution.js";
import { PiModelResolver } from "../model-resolution.js";

describe("PiModelResolver", () => {
  const catalog: PiModelInfo[] = [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    },
    { provider: "openai", id: "gpt-5", name: "GPT-5" },
  ];

  it("resolves an exact canonical provider/id match (tier 1)", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["anthropic/claude-sonnet-4-5"], catalog);
    expect(result).toEqual({
      resolved: true,
      model: catalog[0],
      intentEntry: "anthropic/claude-sonnet-4-5",
      source: "canonical",
    });
  });

  it("resolves an exact bare id match when unique (tier 2)", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["gpt-5"], catalog);
    expect(result).toEqual({
      resolved: true,
      model: catalog[1],
      intentEntry: "gpt-5",
      source: "bare-id",
    });
  });

  it("skips an ambiguous bare id and never fuzzy-picks between providers", () => {
    const ambiguousCatalog: PiModelInfo[] = [
      { provider: "anthropic", id: "shared-id" },
      { provider: "openai", id: "shared-id" },
    ];
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["shared-id"], ambiguousCatalog);
    expect(result).toEqual({ resolved: false });
  });

  it("resolves an exact human-readable name match when unique (tier 3)", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["Claude Sonnet 4.5"], catalog);
    expect(result).toEqual({
      resolved: true,
      model: catalog[0],
      intentEntry: "Claude Sonnet 4.5",
      source: "human-name",
    });
  });

  it("skips an ambiguous name match", () => {
    const ambiguousCatalog: PiModelInfo[] = [
      { provider: "anthropic", id: "a", name: "Shared Name" },
      { provider: "openai", id: "b", name: "Shared Name" },
    ];
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["Shared Name"], ambiguousCatalog);
    expect(result).toEqual({ resolved: false });
  });

  it("tries later entries in order when an earlier entry is unavailable", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["missing-model", "gpt-5"], catalog);
    expect(result).toEqual({
      resolved: true,
      model: catalog[1],
      intentEntry: "gpt-5",
      source: "bare-id",
    });
  });

  it("prefers the first resolvable entry over later entries, even out of tier order", () => {
    // "gpt-5" (bare id) appears before the canonical form of the first entry
    // in this intent list — the ordered intent list wins, not the tier.
    const resolver = new PiModelResolver();
    const result = resolver.resolve(
      ["gpt-5", "anthropic/claude-sonnet-4-5"],
      catalog,
    );
    expect(result.resolved).toBe(true);
    expect(result.resolved && result.intentEntry).toBe("gpt-5");
  });

  it("reports resolved: false when no entry matches anything (degraded)", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["nonexistent"], catalog);
    expect(result).toEqual({ resolved: false });
  });

  it("reports resolved: false for an empty model intent", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve([], catalog);
    expect(result).toEqual({ resolved: false });
  });

  it("reports resolved: false for an empty catalog", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["anthropic/claude-sonnet-4-5"], []);
    expect(result).toEqual({ resolved: false });
  });

  it("does not fuzzy match partial or case-differing strings", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["Gpt-5", "gpt"], catalog);
    expect(result).toEqual({ resolved: false });
  });
});
