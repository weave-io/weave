/**
 * Unit tests for `OpenCodeAdapter` construction and initialization.
 *
 * Verifies:
 * - The adapter can be constructed without a client (translation-only mode).
 * - The adapter can be constructed with a mocked `OpenCodeClientFacade`.
 * - `init()` completes successfully in both modes.
 * - The injected client is stored and accessible (no hidden global state).
 * - `spawnSubagent()` translates a descriptor and stores it in `translatedAgents`.
 *
 * All tests use a `MockOpenCodeClient` — no live OpenCode runtime is required.
 */

import { describe, expect, it } from "bun:test";
import type { AgentDescriptor, EffectiveToolPolicy } from "@weave/engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { OpenCodeClientError, OpenCodeClientFacade } from "../index.js";
import { OpenCodeAdapter } from "../index.js";
import type { OpenCodeAgent, OpenCodeAgentConfig } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// MockOpenCodeClient
// ---------------------------------------------------------------------------

/**
 * In-memory mock for `OpenCodeClientFacade`.
 *
 * Records calls to each method so tests can assert interaction patterns.
 * Returns configurable responses without requiring a live OpenCode runtime.
 */
class MockOpenCodeClient implements OpenCodeClientFacade {
  readonly listAgentsCalls: number[] = [];
  readonly createAgentCalls: Array<{
    name: string;
    config: OpenCodeAgentConfig;
  }> = [];
  readonly updateAgentCalls: Array<{
    name: string;
    config: OpenCodeAgentConfig;
  }> = [];

  private _listAgentsResult: ResultAsync<OpenCodeAgent[], OpenCodeClientError> =
    okAsync([]);

  /** Override the result returned by `listAgents()` for a specific test. */
  setListAgentsResult(
    result: ResultAsync<OpenCodeAgent[], OpenCodeClientError>,
  ): void {
    this._listAgentsResult = result;
  }

  listAgents(): ResultAsync<OpenCodeAgent[], OpenCodeClientError> {
    this.listAgentsCalls.push(Date.now());
    return this._listAgentsResult;
  }

  createAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError> {
    this.createAgentCalls.push({ name, config });
    return okAsync(undefined);
  }

  updateAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError> {
    this.updateAgentCalls.push({ name, config });
    return okAsync(undefined);
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_POLICY: EffectiveToolPolicy = {
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "deny",
  network: "ask",
};

function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "You are a test agent.",
    models: ["claude-sonnet-4-5"],
    mode: "subagent",
    temperature: 0.2,
    description: "A test agent",
    effectiveToolPolicy: DEFAULT_TOOL_POLICY,
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: construction
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — construction", () => {
  it("can be constructed without options (translation-only mode)", () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter).toBeDefined();
    expect(adapter.translatedAgents.size).toBe(0);
    expect(adapter.planStateProvider).toBeUndefined();
  });

  it("can be constructed with an empty options object", () => {
    const adapter = new OpenCodeAdapter({});
    expect(adapter).toBeDefined();
  });

  it("can be constructed with a mocked injected client", () => {
    const mockClient = new MockOpenCodeClient();
    const adapter = new OpenCodeAdapter({ client: mockClient });
    expect(adapter).toBeDefined();
  });

  it("can be constructed with projectRoot and client together", () => {
    const mockClient = new MockOpenCodeClient();
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    expect(adapter).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: init()
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — init()", () => {
  it("completes without error in translation-only mode (no client)", async () => {
    const adapter = new OpenCodeAdapter({ projectRoot: "/tmp/test-project" });
    await expect(adapter.init()).resolves.toBeUndefined();
    expect(adapter.planStateProvider).toBeDefined();
  });

  it("completes without error when a mocked client is injected", async () => {
    const mockClient = new MockOpenCodeClient();
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await expect(adapter.init()).resolves.toBeUndefined();
    expect(adapter.planStateProvider).toBeDefined();
  });

  it("does not call listAgents() during init()", async () => {
    const mockClient = new MockOpenCodeClient();
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();
    expect(mockClient.listAgentsCalls).toHaveLength(0);
  });

  it("sets planStateProvider after init()", async () => {
    const adapter = new OpenCodeAdapter({ projectRoot: "/tmp/test-project" });
    expect(adapter.planStateProvider).toBeUndefined();
    await adapter.init();
    expect(adapter.planStateProvider).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: injected client is stored (no hidden global state)
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — injected client isolation", () => {
  it("two adapters with different clients are independent", async () => {
    const clientA = new MockOpenCodeClient();
    const clientB = new MockOpenCodeClient();

    const adapterA = new OpenCodeAdapter({
      projectRoot: "/tmp/project-a",
      client: clientA,
    });
    const adapterB = new OpenCodeAdapter({
      projectRoot: "/tmp/project-b",
      client: clientB,
    });

    await adapterA.init();
    await adapterB.init();

    // Neither client should have been called during init
    expect(clientA.listAgentsCalls).toHaveLength(0);
    expect(clientB.listAgentsCalls).toHaveLength(0);

    // translatedAgents maps are independent
    expect(adapterA.translatedAgents).not.toBe(adapterB.translatedAgents);
  });

  it("adapter without client does not share state with adapter with client", async () => {
    const mockClient = new MockOpenCodeClient();
    const adapterWithClient = new OpenCodeAdapter({ client: mockClient });
    const adapterWithoutClient = new OpenCodeAdapter();

    await adapterWithClient.init();
    await adapterWithoutClient.init();

    // Both should have independent planStateProviders
    expect(adapterWithClient.planStateProvider).toBeDefined();
    expect(adapterWithoutClient.planStateProvider).toBeDefined();
    expect(adapterWithClient.planStateProvider).not.toBe(
      adapterWithoutClient.planStateProvider,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: spawnSubagent()
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — spawnSubagent()", () => {
  it("translates a descriptor and stores it in translatedAgents", async () => {
    const mockClient = new MockOpenCodeClient();
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    const descriptor = makeDescriptor();
    await adapter.spawnSubagent(descriptor);

    expect(adapter.translatedAgents.has("test-agent")).toBe(true);
    const config = adapter.translatedAgents.get("test-agent");
    expect(config).toBeDefined();
    expect(config?.prompt).toBe("You are a test agent.");
    expect(config?.mode).toBe("subagent");
  });

  it("stores multiple agents independently", async () => {
    const adapter = new OpenCodeAdapter({ projectRoot: "/tmp/test-project" });
    await adapter.init();

    await adapter.spawnSubagent(
      makeDescriptor({ name: "agent-a", composedPrompt: "Prompt A" }),
    );
    await adapter.spawnSubagent(
      makeDescriptor({ name: "agent-b", composedPrompt: "Prompt B" }),
    );

    expect(adapter.translatedAgents.size).toBe(2);
    expect(adapter.translatedAgents.get("agent-a")?.prompt).toBe("Prompt A");
    expect(adapter.translatedAgents.get("agent-b")?.prompt).toBe("Prompt B");
  });

  it("does not call createAgent() or updateAgent() during spawnSubagent() (task 2 behavior)", async () => {
    const mockClient = new MockOpenCodeClient();
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    await adapter.spawnSubagent(makeDescriptor());

    // SDK-backed materialization is task 2; task 1 only stores in memory
    expect(mockClient.createAgentCalls).toHaveLength(0);
    expect(mockClient.updateAgentCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadAvailableSkills()
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — loadAvailableSkills()", () => {
  it("returns an empty array (stub implementation)", async () => {
    const adapter = new OpenCodeAdapter({ projectRoot: "/tmp/test-project" });
    await adapter.init();
    const skills = await adapter.loadAvailableSkills();
    expect(skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: MockOpenCodeClient facade contract
// ---------------------------------------------------------------------------

describe("MockOpenCodeClient — facade contract", () => {
  it("listAgents() returns ok([]) by default", async () => {
    const client = new MockOpenCodeClient();
    const result = await client.listAgents();
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual([]);
    }
  });

  it("createAgent() returns ok(undefined)", async () => {
    const client = new MockOpenCodeClient();
    const config: OpenCodeAgentConfig = {
      prompt: "Test prompt",
      mode: "subagent",
    };
    const result = await client.createAgent("test-agent", config);
    expect(result.isOk()).toBe(true);
    expect(client.createAgentCalls).toHaveLength(1);
    expect(client.createAgentCalls[0]?.name).toBe("test-agent");
  });

  it("updateAgent() returns ok(undefined)", async () => {
    const client = new MockOpenCodeClient();
    const config: OpenCodeAgentConfig = {
      prompt: "Updated prompt",
      mode: "subagent",
    };
    const result = await client.updateAgent("test-agent", config);
    expect(result.isOk()).toBe(true);
    expect(client.updateAgentCalls).toHaveLength(1);
    expect(client.updateAgentCalls[0]?.name).toBe("test-agent");
  });

  it("listAgents() can be configured to return an error", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(
      errAsync({
        type: "ListAgentsError",
        message: "Connection refused",
      }),
    );
    const result = await client.listAgents();
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ListAgentsError");
      expect(result.error.message).toBe("Connection refused");
    }
  });
});
