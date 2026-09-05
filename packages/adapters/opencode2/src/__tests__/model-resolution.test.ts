import { describe, expect, it } from "bun:test";
import { resolveModelContext } from "../model-resolution.js";
import { MockPluginContext } from "./mock-plugin-context.js";

async function seedModel(
  ctx: MockPluginContext,
  providerID: string,
  modelID: string,
): Promise<void> {
  await ctx.catalog.transform((editor) => {
    editor.provider.update(providerID, (provider) => {
      (provider as unknown as { id: string }).id = providerID;
      (provider as unknown as { name: string }).name = providerID;
    });
    editor.model.update(providerID, modelID, (model) => {
      (model as unknown as { id: string }).id = modelID;
      (model as unknown as { modelID: string }).modelID = modelID;
      (model as unknown as { providerID: string }).providerID = providerID;
      (model as unknown as { name: string }).name = modelID;
    });
  });
}

async function setDefault(
  ctx: MockPluginContext,
  providerID: string,
  modelID: string,
): Promise<void> {
  await ctx.catalog.transform((editor) => {
    editor.model.default.set(providerID, modelID);
  });
}

describe("resolveModelContext", () => {
  it("returns err(MissingCatalogEntry) for an unknown explicit model on a subagent", async () => {
    const ctx = new MockPluginContext();
    await seedModel(ctx, "anthropic", "claude-sonnet-4-5");

    const result = await resolveModelContext(ctx, {
      name: "shuttle",
      mode: "subagent",
      models: ["nonexistent-model"],
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("MissingCatalogEntry");
      if (result.error.type === "MissingCatalogEntry") {
        expect(result.error.agentId).toBe("shuttle");
        expect(result.error.modelId).toBe("nonexistent-model");
      }
    }
  });

  it("falls back to the catalog default for a primary agent with no explicit model", async () => {
    const ctx = new MockPluginContext();
    await seedModel(ctx, "anthropic", "claude-sonnet-4-5");
    await setDefault(ctx, "anthropic", "claude-sonnet-4-5");

    const result = await resolveModelContext(ctx, {
      name: "loom",
      mode: "primary",
      models: [],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
      });
    }
  });

  it("uses the explicit model when valid for a primary agent", async () => {
    const ctx = new MockPluginContext();
    await seedModel(ctx, "anthropic", "claude-sonnet-4-5");
    await seedModel(ctx, "openai", "gpt-5");
    await setDefault(ctx, "anthropic", "claude-sonnet-4-5");

    const result = await resolveModelContext(ctx, {
      name: "loom",
      mode: "primary",
      models: ["gpt-5"],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        providerID: "openai",
        modelID: "gpt-5",
      });
    }
  });
});
