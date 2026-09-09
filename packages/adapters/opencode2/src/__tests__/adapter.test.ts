import { describe, expect, it } from "bun:test";
import type { AgentDescriptor, HarnessAdapter } from "@weaveio/weave-engine";

import { OpenCode2Adapter } from "../adapter.js";
import { WEAVE_OWNERSHIP_MARKER } from "../translate-agent.js";
import { MockPluginContext } from "./mock-plugin-context.js";

function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "shuttle",
    composedPrompt: "You are Shuttle.",
    models: ["claude-sonnet-4-5"],
    mode: "subagent",
    effectiveToolPolicy: {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "deny",
      network: "ask",
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
    ...overrides,
  };
}

async function seedCatalog(
  ctx: MockPluginContext,
  providerID = "anthropic",
  modelID = "claude-sonnet-4-5",
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
    editor.model.default.set(providerID, modelID);
  });
}

// ---------------------------------------------------------------------------
// § 1 — Type-level HarnessAdapter conformance
// ---------------------------------------------------------------------------

describe("OpenCode2Adapter — HarnessAdapter conformance", () => {
  it("satisfies the HarnessAdapter interface at the type level", () => {
    const ctx = new MockPluginContext();
    const adapter: HarnessAdapter = new OpenCode2Adapter(ctx);
    expect(adapter).toBeInstanceOf(OpenCode2Adapter);
  });
});

// ---------------------------------------------------------------------------
// § 2 — init()
// ---------------------------------------------------------------------------

describe("OpenCode2Adapter#init", () => {
  it("registers built-in commands and sets up a plan state provider", async () => {
    const ctx = new MockPluginContext();
    const adapter = new OpenCode2Adapter(ctx, { projectRoot: "/tmp/project" });

    await adapter.init();

    const commandCalls = ctx.calls.filter(
      (c) => c.method === "command.transform",
    );
    expect(commandCalls.length).toBeGreaterThan(0);
    expect(adapter.planStateProvider).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// § 3 — loadAvailableSkills()
// ---------------------------------------------------------------------------

describe("OpenCode2Adapter#loadAvailableSkills", () => {
  it("returns skill names present in the mock context", async () => {
    const ctx = new MockPluginContext();
    ctx.seedSkill("code-review");
    const adapter = new OpenCode2Adapter(ctx);

    const skills = await adapter.loadAvailableSkills();

    expect(skills.map((s) => s.name)).toEqual(["code-review"]);
  });
});

// ---------------------------------------------------------------------------
// § 4 — spawnSubagent()
// ---------------------------------------------------------------------------

describe("OpenCode2Adapter#spawnSubagent", () => {
  it("chains translate + reconcile and materializes a new agent", async () => {
    const ctx = new MockPluginContext();
    // Seed a catalog model so resolveModelContext can match.
    await seedCatalog(ctx);

    const adapter = new OpenCode2Adapter(ctx);
    const descriptor = makeDescriptor();

    const result = await adapter.spawnSubagent(descriptor);

    expect(result.isOk()).toBe(true);
    const agentTransformCalls = ctx.calls.filter(
      (c) => c.method === "agent.transform",
    );
    expect(agentTransformCalls.length).toBe(1);

    const listed = await ctx.agent.list();
    const created = listed.find((a) => a.id === descriptor.name);
    expect(created).toBeDefined();
    expect(created?.description).toContain(WEAVE_OWNERSHIP_MARKER);
  });

  it("propagates ForeignAgentCollision as err()", async () => {
    const ctx = new MockPluginContext();
    // Seed a foreign (non-Weave-owned) agent occupying the target id.
    ctx.seedAgent("shuttle");

    await seedCatalog(ctx);

    const adapter = new OpenCode2Adapter(ctx);
    const descriptor = makeDescriptor({ name: "shuttle" });

    const result = await adapter.spawnSubagent(descriptor);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ForeignAgentCollision");
      // Bridged error also satisfies the structural `Error` shape required
      // by `HarnessAdapter.spawnSubagent()`.
      expect(typeof result.error.message).toBe("string");
      expect(typeof result.error.name).toBe("string");
    }
  });

  it("propagates MissingCatalogEntry when no model matches", async () => {
    const ctx = new MockPluginContext();
    const adapter = new OpenCode2Adapter(ctx);
    const descriptor = makeDescriptor({ models: ["nonexistent-model"] });

    const result = await adapter.spawnSubagent(descriptor);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("MissingCatalogEntry");
    }
  });
});

// ---------------------------------------------------------------------------
// § 5 — dispose()
// ---------------------------------------------------------------------------

describe("OpenCode2Adapter#dispose", () => {
  it("disposes every accumulated registration", async () => {
    const ctx = new MockPluginContext();
    await seedCatalog(ctx);

    const adapter = new OpenCode2Adapter(ctx);
    await adapter.init();
    const spawnResult = await adapter.spawnSubagent(makeDescriptor());
    expect(spawnResult.isOk()).toBe(true);

    // Sanity: agent exists prior to disposal.
    const beforeDispose = await ctx.agent.list();
    expect(beforeDispose.find((a) => a.id === "shuttle")).toBeDefined();

    const disposeResult = await adapter.dispose();

    expect(disposeResult.isOk()).toBe(true);
    const afterDispose = await ctx.agent.list();
    expect(afterDispose.find((a) => a.id === "shuttle")).toBeUndefined();
  });

  it("returns ok(undefined) when no registrations were accumulated", async () => {
    const ctx = new MockPluginContext();
    const adapter = new OpenCode2Adapter(ctx);

    const result = await adapter.dispose();

    expect(result.isOk()).toBe(true);
  });
});
