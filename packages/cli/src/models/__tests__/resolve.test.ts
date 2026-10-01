import { describe, expect, it } from "bun:test";
import { CLAUDE_CODE_AVAILABLE_MODELS } from "@weaveio/weave-adapter-claude-code";
import {
  getBuiltinConfig,
  ModelRecommendationsFileSchema,
} from "@weaveio/weave-config";
import { CATALOG_IDS, type CatalogId, PROVIDER_CATALOGS } from "../catalogs.js";
import { RecommendationsResolver } from "../resolve.js";

const resolver = new RecommendationsResolver();
const builtins = getBuiltinConfig()._unsafeUnwrap().agents;

function builtinModels(agent: string): string[] {
  return builtins[agent]?.models ?? [];
}

function resolveBuiltins(catalog: CatalogId): Record<string, string> {
  return Object.fromEntries(
    Object.keys(builtins)
      .sort()
      .map((agent) => [
        agent,
        resolver.resolveInCatalog(
          agent,
          builtinModels(agent),
          PROVIDER_CATALOGS[catalog],
        ).model,
      ]),
  );
}

describe("catalog fixtures", () => {
  it("ship one catalog per provider in the fixed set, plus Copilot + OpenAI", () => {
    expect([...CATALOG_IDS]).toEqual([
      "github-copilot",
      "anthropic",
      "openai",
      "openrouter",
      "github-copilot+openai",
    ]);
  });

  it("list each model once, under the catalog's own provider", () => {
    for (const id of CATALOG_IDS) {
      const catalog = PROVIDER_CATALOGS[id];
      expect(catalog.id).toBe(id);
      expect(catalog.models.length).toBeGreaterThan(0);
      const keys = catalog.models.map((m) => `${m.providerID}/${m.id}`);
      expect(new Set(keys).size).toBe(keys.length);
      if (id === "github-copilot+openai") continue;
      for (const model of catalog.models) expect(model.providerID).toBe(id);
    }
  });

  it("spell Claude versions the way each provider does", () => {
    const ids = (id: CatalogId) =>
      PROVIDER_CATALOGS[id].models.map((m) => m.id);
    expect(ids("github-copilot")).toContain("claude-opus-5.5");
    expect(ids("anthropic")).toContain("claude-opus-5-5");
    expect(ids("openrouter")).toContain("anthropic/claude-opus-5.5");
  });
});

describe("the builtin lists resolve as docs/model-resolution.md describes", () => {
  it("on a Copilot host, every agent gets the model recorded in the 29 Sep live check", () => {
    expect(resolveBuiltins("github-copilot")).toEqual({
      loom: "github-copilot/claude-opus-5.5",
      pattern: "github-copilot/claude-opus-5.5",
      shuttle: "github-copilot/claude-sonnet-5.5",
      spindle: "github-copilot/gpt-6-luna",
      tapestry: "github-copilot/claude-opus-5.5",
      thread: "github-copilot/claude-haiku-4.5",
      warp: "github-copilot/gpt-6-sol",
      weft: "github-copilot/gpt-6-sol",
    });
  });

  it("on an Anthropic-only host, the dashed spelling", () => {
    expect(resolveBuiltins("anthropic")).toEqual({
      loom: "anthropic/claude-opus-5-5",
      pattern: "anthropic/claude-opus-5-5",
      shuttle: "anthropic/claude-sonnet-5-5",
      spindle: "anthropic/claude-haiku-4-5",
      tapestry: "anthropic/claude-opus-5-5",
      thread: "anthropic/claude-haiku-4-5",
      warp: "anthropic/claude-opus-5-5",
      weft: "anthropic/claude-opus-5-5",
    });
  });

  it("on an OpenAI-only host, the OpenAI entry", () => {
    expect(resolveBuiltins("openai")).toEqual({
      loom: "openai/gpt-6-sol",
      pattern: "openai/gpt-6-sol",
      shuttle: "openai/gpt-6-sol",
      spindle: "openai/gpt-6-luna",
      tapestry: "openai/gpt-6-sol",
      thread: "openai/gpt-6-luna",
      warp: "openai/gpt-6-sol",
      weft: "openai/gpt-6-sol",
    });
  });

  it("on OpenRouter, nothing: its IDs carry the vendor, so bare IDs never match", () => {
    for (const model of Object.values(resolveBuiltins("openrouter")))
      expect(model).toBe("none");
  });

  it("with Copilot and OpenAI, the OpenAI IDs are ambiguous and Weft, Warp and Spindle take their Claude fallback", () => {
    const resolved = resolveBuiltins("github-copilot+openai");
    expect(resolved.weft).toBe("github-copilot/claude-opus-5.5");
    expect(resolved.warp).toBe("github-copilot/claude-opus-5.5");
    expect(resolved.spindle).toBe("github-copilot/claude-haiku-4.5");
    expect(resolved.loom).toBe("github-copilot/claude-opus-5.5");
    const weft = resolver.resolveInCatalog(
      "weft",
      builtinModels("weft"),
      PROVIDER_CATALOGS["github-copilot+openai"],
    );
    expect(weft.skipped).toEqual([{ entry: "gpt-6-sol", reason: "ambiguous" }]);
  });

  it("on Claude Code, the tier of the first Anthropic entry", () => {
    const tiers = Object.fromEntries(
      Object.keys(builtins)
        .sort()
        .map((agent) => [
          agent,
          resolver.resolveClaudeCode(agent, builtinModels(agent)).model,
        ]),
    );
    expect(tiers).toEqual({
      loom: "opus",
      pattern: "opus",
      shuttle: "sonnet",
      spindle: "haiku",
      tapestry: "opus",
      thread: "haiku",
      warp: "opus",
      weft: "opus",
    });
  });
});

describe("RecommendationsResolver", () => {
  const copilot = PROVIDER_CATALOGS["github-copilot"];
  const both = PROVIDER_CATALOGS["github-copilot+openai"];

  it("resolves a provider-qualified entry only on that provider", () => {
    expect(
      resolver.resolveInCatalog("a", ["openai/gpt-6-sol"], both).model,
    ).toBe("openai/gpt-6-sol");
    expect(
      resolver.resolveInCatalog("a", ["openai/gpt-6-sol"], copilot).model,
    ).toBe("none");
  });

  it("resolves an OpenRouter entry by its full provider-qualified ID", () => {
    const openrouter = PROVIDER_CATALOGS.openrouter;
    expect(
      resolver.resolveInCatalog(
        "a",
        [
          "anthropic/claude-sonnet-5.5",
          "openrouter/anthropic/claude-sonnet-5.5",
        ],
        openrouter,
      ),
    ).toEqual({
      agent: "a",
      model: "openrouter/anthropic/claude-sonnet-5.5",
      entryIndex: 1,
      skipped: [{ entry: "anthropic/claude-sonnet-5.5", reason: "missing" }],
    });
  });

  it("skips an entry whose #variant the model does not offer", () => {
    const result = resolver.resolveInCatalog(
      "a",
      ["gpt-6-sol#high", "gpt-6-luna"],
      copilot,
    );
    expect(result.model).toBe("github-copilot/gpt-6-luna");
    expect(result.skipped[0]?.reason).toBe("variant-missing");
    const withVariant = resolver.resolveInCatalog("a", ["m#high"], {
      id: "x",
      description: "",
      updated: "",
      models: [{ providerID: "p", id: "m", variants: ["high"] }],
    });
    expect(withVariant.model).toBe("p/m#high");
  });

  it("accepts Claude Code tier names and the adapter's allowlist, and nothing else", () => {
    expect(resolver.resolveClaudeCode("a", ["gpt-6-sol", "sonnet"]).model).toBe(
      "sonnet",
    );
    expect(resolver.resolveClaudeCode("a", ["claude-opus-5.5"]).model).toBe(
      "none",
    );
  });

  it("maps every model in the Claude Code adapter's allowlist to a tier", () => {
    for (const model of CLAUDE_CODE_AVAILABLE_MODELS) {
      expect(["opus", "sonnet", "haiku"]).toContain(
        resolver.resolveClaudeCode("a", [model]).model,
      );
    }
  });

  it("reports each harness on the section it reads", () => {
    const file = ModelRecommendationsFileSchema.parse({
      schema: 1,
      channel: "stable",
      issued: "2026-10-01T09:00:00Z",
      expires: "2026-12-30T09:00:00Z",
      evidence: "https://tryweave.io/evals/runs/1",
      default: { agents: { shuttle: { models: ["claude-sonnet-5.5"] } } },
      harnesses: {
        "claude-code": { agents: { shuttle: { models: ["sonnet"] } } },
      },
    });
    const report = resolver.resolveFile(file);
    const sections = report.map(
      (b) => `${b.harness}:${b.section}:${b.catalog}`,
    );
    expect(sections).toEqual([
      ...CATALOG_IDS.map((c) => `opencode2:default:${c}`),
      "claude-code:claude-code:anthropic",
      ...CATALOG_IDS.map((c) => `pi:default:${c}`),
    ]);
  });
});
