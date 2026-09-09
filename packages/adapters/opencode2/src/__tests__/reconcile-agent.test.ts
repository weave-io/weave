import { describe, expect, it } from "bun:test";

import { reconcileAgent } from "../reconcile-agent.js";
import type { V2AgentInfo } from "../sdk-types.js";
import { translateAgent, WEAVE_OWNERSHIP_MARKER } from "../translate-agent.js";
import { MockPluginContext } from "./mock-plugin-context.js";

const BASE_MODEL = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-5",
};

function weaveAgentInfo(name = "shuttle"): V2AgentInfo {
  return translateAgent(
    {
      name,
      description: "Shuttle (Domain Specialist)",
      composedPrompt: "You are Shuttle.",
      mode: "subagent",
      effectiveToolPolicy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "deny",
        network: "ask",
      },
    },
    BASE_MODEL,
  );
}

describe("reconcileAgent", () => {
  it("creates a new Weave-owned agent when none exists", async () => {
    const ctx = new MockPluginContext();
    const info = weaveAgentInfo();

    const result = await reconcileAgent(ctx, info);

    expect(result.isOk()).toBe(true);
    const listed = await ctx.agent.list();
    const created = listed.find((a) => a.id === info.id);
    expect(created).toBeDefined();
    expect(created?.description).toContain(WEAVE_OWNERSHIP_MARKER);
  });

  it("updates an existing Weave-owned agent in place", async () => {
    const ctx = new MockPluginContext();
    const initial = weaveAgentInfo();
    const first = await reconcileAgent(ctx, initial);
    expect(first.isOk()).toBe(true);

    const updated = translateAgent(
      {
        name: "shuttle",
        description: "Shuttle (Updated Description)",
        composedPrompt: "You are an updated Shuttle.",
        mode: "subagent",
        effectiveToolPolicy: {
          read: "allow",
          write: "allow",
          execute: "allow",
          delegate: "deny",
          network: "ask",
        },
      },
      BASE_MODEL,
    );

    const second = await reconcileAgent(ctx, updated);
    expect(second.isOk()).toBe(true);

    const listed = await ctx.agent.list();
    const shuttle = listed.find((a) => a.id === updated.id);
    expect(shuttle?.system).toBe("You are an updated Shuttle.");
    expect(shuttle?.description).toContain("Updated Description");
    // Still only one agent with this id, not a duplicate.
    expect(listed.filter((a) => a.id === updated.id)).toHaveLength(1);
  });

  it("hard-errors with ForeignAgentCollision when a same-named foreign agent exists", async () => {
    const ctx = new MockPluginContext();
    // Seed a foreign (non-Weave-owned) agent occupying the same id.
    const foreign = ctx.seedAgent("shuttle");
    (foreign as unknown as { description: string }).description =
      "Some other tool's shuttle agent";

    const info = weaveAgentInfo();
    const result = await reconcileAgent(ctx, info);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ForeignAgentCollision");
      if (result.error.type === "ForeignAgentCollision") {
        expect(result.error.agentId).toBe("shuttle");
        expect(result.error.foreignAgent).toBe(foreign);
      }
    }
  });

  it("does not hard-error when the existing same-id agent is Weave-owned", async () => {
    const ctx = new MockPluginContext();
    const seeded = ctx.seedAgent("shuttle");
    (seeded as unknown as { description: string }).description =
      `${WEAVE_OWNERSHIP_MARKER} Shuttle (Domain Specialist)`;

    const info = weaveAgentInfo();
    const result = await reconcileAgent(ctx, info);

    expect(result.isOk()).toBe(true);
  });

  it("Registration.dispose() removes only the Weave-owned changes from this reconciliation", async () => {
    const ctx = new MockPluginContext();
    const info = weaveAgentInfo();

    const result = await reconcileAgent(ctx, info);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const registration = result.value;
    const beforeDispose = await ctx.agent.list();
    expect(beforeDispose.some((a) => a.id === info.id)).toBe(true);

    await registration.dispose();

    const afterDispose = await ctx.agent.list();
    expect(afterDispose.some((a) => a.id === info.id)).toBe(false);
  });
});
