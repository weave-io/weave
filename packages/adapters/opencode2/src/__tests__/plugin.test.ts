import { describe, expect, it, mock } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";

import { setupWeavePlugin } from "../plugin.js";
import { MockPluginContext } from "./mock-plugin-context.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDescriptor(name: string): AgentDescriptor {
  return {
    name,
    composedPrompt: `You are ${name}.`,
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
  };
}

/**
 * Seed the mock context with a matching provider/model so
 * `resolveModelContext` can match the descriptor's requested model — the
 * MockPluginContext catalog is empty by default. Without this seeding,
 * `spawnSubagent` would fail with `MissingCatalogEntry` / `CatalogUnavailable`
 * for any descriptor that requests a specific model.
 */
async function seedCatalog(ctx: MockPluginContext): Promise<void> {
  await ctx.catalog.transform((editor) => {
    editor.provider.update("anthropic", (provider) => {
      (provider as unknown as { id: string }).id = "anthropic";
      (provider as unknown as { name: string }).name = "anthropic";
    });
    editor.model.update("anthropic", "claude-sonnet-4-5", (model) => {
      (model as unknown as { id: string }).id = "claude-sonnet-4-5";
      (model as unknown as { modelID: string }).modelID = "claude-sonnet-4-5";
      (model as unknown as { providerID: string }).providerID = "anthropic";
      (model as unknown as { name: string }).name = "claude-sonnet-4-5";
    });
    editor.model.default.set("anthropic", "claude-sonnet-4-5");
  });
}

/** Empty stub WeaveConfig — only its identity matters to the stub materializer. */
const stubConfig = {} as WeaveConfig;

/** Stub materializer returning a fixed two-agent plan with no errors. */
function stubMaterializerFor(descriptors: AgentDescriptor[]) {
  return mock(() =>
    okAsync({
      agents: descriptors.map((d) => ({
        agentName: d.name,
        descriptor: d,
        source: "explicit" as const,
      })),
      errors: [] as const,
    }),
  ) as unknown as Parameters<typeof setupWeavePlugin>[1] extends infer O
    ? O extends { materializeAgents?: infer F }
      ? NonNullable<F>
      : never
    : never;
}

// ---------------------------------------------------------------------------
// § 1 — Existing lifecycle behaviour
// ---------------------------------------------------------------------------

describe("setupWeavePlugin — lifecycle", () => {
  it("initializes the adapter (registers built-in commands) via facade.command.transform", async () => {
    const facade = new MockPluginContext();

    await setupWeavePlugin(facade, {
      directory: "/tmp/no-such-project",
      loadConfig: mock(() =>
        errAsync([{ type: "BuiltinParseError", errors: [] }]),
      ) as never,
      materializeAgents: stubMaterializerFor([]),
    });

    const commandTransformCalls = facade.calls.filter(
      (call) => call.method === "command.transform",
    );
    expect(commandTransformCalls.length).toBeGreaterThan(0);
  });

  it("subscribes to events with an AbortSignal", async () => {
    const facade = new MockPluginContext();

    await setupWeavePlugin(facade, {
      directory: "/tmp/no-such-project",
      loadConfig: mock(() =>
        errAsync([{ type: "BuiltinParseError", errors: [] }]),
      ) as never,
      materializeAgents: stubMaterializerFor([]),
    });

    const subscribeCalls = facade.calls.filter(
      (call) => call.method === "event.subscribe",
    );
    expect(subscribeCalls.length).toBe(1);
    const [options] = subscribeCalls[0]?.args ?? [];
    expect(
      (options as { signal?: AbortSignal } | undefined)?.signal,
    ).toBeInstanceOf(AbortSignal);
  });

  it("cleanup aborts the subscription controller and disposes every registration", async () => {
    const disposed: string[] = [];
    const facade = new MockPluginContext();
    const originalCommandTransform = facade.command.transform.bind(
      facade.command,
    );
    (facade as unknown as { command: typeof facade.command }).command = {
      transform: async (
        callback: Parameters<typeof originalCommandTransform>[0],
      ) => {
        const registration = await originalCommandTransform(callback);
        return {
          dispose: async () => {
            disposed.push("command");
            await registration.dispose();
          },
        };
      },
    };

    const cleanup = await setupWeavePlugin(facade, {
      directory: "/tmp/no-such-project",
      loadConfig: mock(() =>
        errAsync([{ type: "BuiltinParseError", errors: [] }]),
      ) as never,
      materializeAgents: stubMaterializerFor([]),
    });

    await cleanup();

    const subscribeCalls = facade.calls.filter(
      (call) => call.method === "event.subscribe",
    );
    const [options] = subscribeCalls[0]?.args ?? [];
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal?.aborted).toBe(true);

    expect(disposed.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// § 2 — Agent materialization (0.1.1)
// ---------------------------------------------------------------------------

describe("setupWeavePlugin — agent materialization", () => {
  it("calls spawnSubagent for every descriptor in the plan", async () => {
    const facade = new MockPluginContext();
    await seedCatalog(facade);

    const descriptors = [makeDescriptor("loom"), makeDescriptor("shuttle")];

    await setupWeavePlugin(facade, {
      directory: "/tmp/project",
      loadConfig: mock(() => okAsync(stubConfig)) as never,
      materializeAgents: stubMaterializerFor(descriptors),
    });

    const agentTransformCalls = facade.calls.filter(
      (call) => call.method === "agent.transform",
    );
    expect(agentTransformCalls.length).toBe(descriptors.length);

    const listed = await facade.agent.list();
    const names = new Set<string>(
      listed.map((a) => a.name as unknown as string),
    );
    expect(names.has("loom")).toBe(true);
    expect(names.has("shuttle")).toBe(true);
  });

  it("degrades gracefully when loadConfig fails — no agent.transform calls, cleanup still valid", async () => {
    const facade = new MockPluginContext();

    const materialize = stubMaterializerFor([makeDescriptor("loom")]);
    const cleanup = await setupWeavePlugin(facade, {
      directory: "/tmp/project",
      loadConfig: mock(() =>
        errAsync([{ type: "BuiltinParseError", errors: [] }]),
      ) as never,
      materializeAgents: materialize,
    });

    // Config load failed → materializer must never be invoked.
    expect(
      (materialize as unknown as { mock: { calls: unknown[] } }).mock.calls
        .length,
    ).toBe(0);

    // And no agents were registered via the facade.
    const agentTransformCalls = facade.calls.filter(
      (call) => call.method === "agent.transform",
    );
    expect(agentTransformCalls.length).toBe(0);

    // Cleanup must still be a callable that doesn't throw.
    await cleanup();
  });

  it("continues past plan.errors and still spawns remaining descriptors", async () => {
    const facade = new MockPluginContext();
    await seedCatalog(facade);

    const descriptors = [makeDescriptor("loom"), makeDescriptor("shuttle")];

    const materializeWithErrors = mock(() =>
      okAsync({
        agents: descriptors.map((d) => ({
          agentName: d.name,
          descriptor: d,
          source: "explicit" as const,
        })),
        errors: [
          {
            type: "DescriptorCompositionFailure" as const,
            agentName: "ghost",
            cause: {
              type: "PromptSourceMissingError" as const,
              agentName: "ghost",
              message: "no prompt",
            },
          },
        ],
      }),
    ) as never;

    await setupWeavePlugin(facade, {
      directory: "/tmp/project",
      loadConfig: mock(() => okAsync(stubConfig)) as never,
      materializeAgents: materializeWithErrors,
    });

    const agentTransformCalls = facade.calls.filter(
      (call) => call.method === "agent.transform",
    );
    expect(agentTransformCalls.length).toBe(2);
  });

  it("continues past a per-agent spawn failure and still spawns subsequent agents", async () => {
    const facade = new MockPluginContext();
    await seedCatalog(facade);

    // Seed a foreign (non-Weave-owned) agent at id "shuttle" so reconciliation
    // for that descriptor hard-fails with ForeignAgentCollision. `loom` and
    // `weft` must still get materialized around it.
    facade.seedAgent("shuttle");

    const descriptors = [
      makeDescriptor("loom"),
      makeDescriptor("shuttle"),
      makeDescriptor("weft"),
    ];

    await setupWeavePlugin(facade, {
      directory: "/tmp/project",
      loadConfig: mock(() => okAsync(stubConfig)) as never,
      materializeAgents: stubMaterializerFor(descriptors),
    });

    const listed = await facade.agent.list();
    const names = new Set<string>(
      listed.map((a) => a.name as unknown as string),
    );
    expect(names.has("loom")).toBe(true);
    expect(names.has("weft")).toBe(true);
    // `shuttle` was foreign and remained; but no new Weave-owned overwrite
    // happened for it. The remaining descriptors DID get materialized —
    // that's the invariant.
  });
});
