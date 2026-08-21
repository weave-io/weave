import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type {
  PiModelApplyPort,
  PiModelInfo,
  PiThinkingApplyPort,
} from "../model-resolution.js";
import {
  PiModelActivator,
  PiModelResolver,
  resolvePiOrderedDistinctModels,
} from "../model-resolution.js";

const catalog: PiModelInfo[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
  },
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
];

describe("PiModelResolver", () => {
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

  it("strips the suffix before canonical, bare-id, and human-name matching", () => {
    const resolver = new PiModelResolver();

    expect(
      resolver.resolve(["anthropic/claude-sonnet-4-5#high"], catalog),
    ).toEqual({
      resolved: true,
      model: catalog[0],
      intentEntry: "anthropic/claude-sonnet-4-5#high",
      source: "canonical",
      thinkingLevel: "high",
    });
    expect(resolver.resolve(["gpt-5#medium"], catalog)).toEqual({
      resolved: true,
      model: catalog[1],
      intentEntry: "gpt-5#medium",
      source: "bare-id",
      thinkingLevel: "medium",
    });
    expect(resolver.resolve(["Claude Sonnet 4.5#low"], catalog)).toEqual({
      resolved: true,
      model: catalog[0],
      intentEntry: "Claude Sonnet 4.5#low",
      source: "human-name",
      thinkingLevel: "low",
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

  it("preserves ordered fallback semantics and the winning suffix", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve(
      ["missing-model#high", "gpt-5#low", "anthropic/claude-sonnet-4-5#max"],
      catalog,
    );
    expect(result).toEqual({
      resolved: true,
      model: catalog[1],
      intentEntry: "gpt-5#low",
      source: "bare-id",
      thinkingLevel: "low",
    });
  });

  it("matches a plain id without adding a thinking level", () => {
    const result = new PiModelResolver().resolve(["gpt-5"], catalog);
    expect(result).toEqual({
      resolved: true,
      model: catalog[1],
      intentEntry: "gpt-5",
      source: "bare-id",
    });
  });

  it("unescapes a literal hash before matching and does not infer a level", () => {
    const escapedHashModel: PiModelInfo = {
      provider: "custom",
      id: "weird#model",
      name: "Weird hash model",
    };
    const result = new PiModelResolver().resolve(
      ["weird\\#model"],
      [escapedHashModel],
    );
    expect(result).toEqual({
      resolved: true,
      model: escapedHashModel,
      intentEntry: "weird\\#model",
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

  it("resolves an ordered distinct list through the exact cascade", () => {
    const resolver = new PiModelResolver();
    const orderedCatalog: PiModelInfo[] = [
      {
        provider: "openai",
        id: "shared",
        name: "OpenAI Shared",
        contextWindow: 128_000,
      },
      {
        provider: "anthropic",
        id: "shared",
        name: "Anthropic Shared",
        contextWindow: 200_000,
      },
      {
        provider: "custom",
        id: "named",
        name: "Friendly Name",
        contextWindow: 64_000,
      },
    ];

    const result = resolver.resolveOrderedDistinct(
      [
        "openai/shared#high",
        "shared#low", // ambiguous bare id; it must be skipped.
        "Friendly Name#medium",
        "custom/named#max", // same canonical identity; first winner remains.
        "OpenAI Shared#xhigh", // same identity through the name tier.
      ],
      orderedCatalog,
    );

    expect(result).toEqual([
      {
        resolved: true,
        model: orderedCatalog[0],
        intentEntry: "openai/shared#high",
        source: "canonical",
        thinkingLevel: "high",
      },
      {
        resolved: true,
        model: orderedCatalog[2],
        intentEntry: "Friendly Name#medium",
        source: "human-name",
        thinkingLevel: "medium",
      },
    ]);
  });

  it("preserves order when aliases resolve to different canonical identities", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolveOrderedDistinct(
      ["Friendly Name#low", "openai/shared#high"],
      [
        {
          provider: "openai",
          id: "shared",
          name: "OpenAI Shared",
        },
        {
          provider: "custom",
          id: "named",
          name: "Friendly Name",
        },
      ],
    );

    expect(result.map((candidate) => candidate.model.provider)).toEqual([
      "custom",
      "openai",
    ]);
    expect(result.map((candidate) => candidate.thinkingLevel)).toEqual([
      "low",
      "high",
    ]);
  });

  it("returns no duplicate canonical identities even when the catalog repeats one", () => {
    const resolver = new PiModelResolver();
    const duplicate = {
      provider: "openai",
      id: "gpt-5",
      name: "GPT-5",
    };
    const result = resolver.resolveOrderedDistinct(
      ["openai/gpt-5", "GPT-5", "gpt-5"],
      [duplicate, { ...duplicate, name: "GPT-5 duplicate" }],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.model).toBe(duplicate);
  });

  it("does not change resolve semantics while resolving ordered candidates", () => {
    const resolver = new PiModelResolver();
    const catalogWithAliases: PiModelInfo[] = [
      { provider: "one", id: "same", name: "First" },
      { provider: "two", id: "same", name: "Second" },
    ];
    expect(resolver.resolve(["same"], catalogWithAliases)).toEqual({
      resolved: false,
    });
    expect(
      resolver.resolveOrderedDistinct(["same"], catalogWithAliases),
    ).toEqual([]);
  });

  it("exposes the same bounded ordered resolution through the pure helper", () => {
    const intent = ["anthropic/claude-sonnet-4-5", "gpt-5"];
    expect(resolvePiOrderedDistinctModels(intent, catalog)).toEqual([
      {
        resolved: true,
        model: catalog[0],
        intentEntry: intent[0],
        source: "canonical",
      },
      {
        resolved: true,
        model: catalog[1],
        intentEntry: intent[1],
        source: "bare-id",
      },
    ]);
  });

  it("does not fuzzy match partial or case-differing strings", () => {
    const resolver = new PiModelResolver();
    const result = resolver.resolve(["Gpt-5", "gpt"], catalog);
    expect(result).toEqual({ resolved: false });
  });

  it("rehydrates a compact identity to the exact full catalog object", () => {
    const fullModel = {
      provider: "anthropic",
      id: "claude-sonnet-5",
      baseUrl: "https://api.anthropic.com",
    };
    const result = new PiModelResolver().resolveIdentity(
      { provider: fullModel.provider, id: fullModel.id },
      [fullModel],
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(fullModel);
  });

  it("fails closed when a compact identity is absent from the catalog", () => {
    const result = new PiModelResolver().resolveIdentity(
      { provider: "anthropic", id: "missing" },
      catalog,
    );

    expect(result._unsafeUnwrapErr()).toEqual({
      type: "ModelIdentityUnavailable",
    });
  });

  it("fails closed when a compact canonical identity is duplicated", () => {
    const duplicate = { provider: "anthropic", id: "duplicate" };
    const result = new PiModelResolver().resolveIdentity(duplicate, [
      duplicate,
      { ...duplicate, name: "Duplicate" },
    ]);

    expect(result._unsafeUnwrapErr()).toEqual({
      type: "ModelIdentityAmbiguous",
    });
  });
});

describe("PiModelActivator thinking-level activation", () => {
  it("applies the model first, then thinking, and reports both successes", async () => {
    const calls: string[] = [];
    const modelApplier: PiModelApplyPort = {
      applyModel: (model) => {
        calls.push(`model:${model.id}`);
        return okAsync(undefined);
      },
    };
    const thinkingApplier: PiThinkingApplyPort = {
      applyThinkingLevel: (level) => {
        calls.push(`thinking:${level}`);
        return okAsync(undefined);
      },
    };

    const result = await new PiModelActivator().activate(
      ["anthropic/claude-sonnet-4-5#high"],
      catalog,
      undefined,
      modelApplier,
      thinkingApplier,
    );

    expect(result._unsafeUnwrap()).toEqual({
      status: "applied",
      model: catalog[0],
      intentEntry: "anthropic/claude-sonnet-4-5#high",
      source: "canonical",
      thinkingLevel: "high",
      thinkingApplied: true,
    });
    expect(calls).toEqual(["model:claude-sonnet-4-5", "thinking:high"]);
  });

  it("reports model success without invoking thinking when no level was requested", async () => {
    const thinkingApplier: PiThinkingApplyPort = {
      applyThinkingLevel: () => {
        throw new Error("thinking must not be applied");
      },
    };
    const result = await new PiModelActivator().activate(
      ["gpt-5"],
      catalog,
      undefined,
      { applyModel: () => okAsync(undefined) },
      thinkingApplier,
    );

    expect(result._unsafeUnwrap()).toEqual({
      status: "applied",
      model: catalog[1],
      intentEntry: "gpt-5",
      source: "bare-id",
    });
  });

  it("keeps model success when the thinking port returns a failure", async () => {
    const calls: string[] = [];
    const thinkingApplier: PiThinkingApplyPort = {
      applyThinkingLevel: (level) => {
        calls.push(level);
        return errAsync(new Error("thinking rejected"));
      },
    };
    const result = await new PiModelActivator().activate(
      ["gpt-5#xhigh"],
      catalog,
      undefined,
      {
        applyModel: () => {
          calls.push("model");
          return okAsync(undefined);
        },
      },
      thinkingApplier,
    );

    expect(result._unsafeUnwrap()).toEqual({
      status: "applied",
      model: catalog[1],
      intentEntry: "gpt-5#xhigh",
      source: "bare-id",
      thinkingLevel: "xhigh",
      thinkingApplied: false,
    });
    expect(calls).toEqual(["model", "xhigh"]);
  });

  it("keeps model success when an injected thinking port throws synchronously", async () => {
    const result = await new PiModelActivator().activate(
      ["gpt-5#medium"],
      catalog,
      undefined,
      { applyModel: () => okAsync(undefined) },
      {
        applyThinkingLevel: () => {
          throw new Error("sync thinking failure");
        },
      },
    );

    expect(result._unsafeUnwrap()).toEqual({
      status: "applied",
      model: catalog[1],
      intentEntry: "gpt-5#medium",
      source: "bare-id",
      thinkingLevel: "medium",
      thinkingApplied: false,
    });
  });
});
