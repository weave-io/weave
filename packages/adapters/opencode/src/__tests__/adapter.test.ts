/**
 * Unit tests for `OpenCodeAdapter` construction, initialization, and
 * SDK-backed materialization.
 *
 * Verifies:
 * - The adapter can be constructed without a client (translation-only mode).
 * - The adapter can be constructed with a mocked `OpenCodeClientFacade`.
 * - `init()` completes successfully in both modes.
 * - The injected client is stored and accessible (no hidden global state).
 * - `spawnSubagent()` translates a descriptor and stores it in `translatedAgents`.
 * - `spawnSubagent()` calls `createAgent()` when no existing agent is found (create path).
 * - `spawnSubagent()` calls `updateAgent()` when an existing Weave-managed agent is found (update path).
 * - `spawnSubagent()` throws a collision error when a foreign agent blocks the write.
 * - `spawnSubagent()` skips SDK calls in translation-only mode (no client).
 *
 * All tests use a `MockOpenCodeClient` — no live OpenCode runtime is required.
 */

import { describe, expect, it } from "bun:test";
import type { AgentDescriptor, EffectiveToolPolicy } from "@weaveio/weave-engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { OpenCodeClientError, OpenCodeClientFacade } from "../index.js";
import {
  OpenCodeAdapter,
  type OpenCodeAdapterError,
  WEAVE_OWNERSHIP_TAG,
} from "../index.js";
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

  private _createAgentResult: ResultAsync<void, OpenCodeClientError> =
    okAsync(undefined);

  private _updateAgentResult: ResultAsync<void, OpenCodeClientError> =
    okAsync(undefined);

  /** Override the result returned by `listAgents()` for a specific test. */
  setListAgentsResult(
    result: ResultAsync<OpenCodeAgent[], OpenCodeClientError>,
  ): void {
    this._listAgentsResult = result;
  }

  /** Override the result returned by `createAgent()` for a specific test. */
  setCreateAgentResult(result: ResultAsync<void, OpenCodeClientError>): void {
    this._createAgentResult = result;
  }

  /** Override the result returned by `updateAgent()` for a specific test. */
  setUpdateAgentResult(result: ResultAsync<void, OpenCodeClientError>): void {
    this._updateAgentResult = result;
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
    return this._createAgentResult;
  }

  updateAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError> {
    this.updateAgentCalls.push({ name, config });
    return this._updateAgentResult;
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

/**
 * Builds a mock `OpenCodeAgent` that looks like a Weave-managed agent.
 * The description includes `WEAVE_OWNERSHIP_TAG` so the reconciler treats it
 * as an existing Weave-managed agent (update path).
 */
function makeWeaveManagedAgent(name: string): OpenCodeAgent {
  return {
    name,
    description: `A Weave-managed agent ${WEAVE_OWNERSHIP_TAG}`,
  } as OpenCodeAgent;
}

/**
 * Builds a mock `OpenCodeAgent` that looks like a manually created (foreign)
 * agent — no ownership tag in the description.
 */
function makeForeignAgent(name: string): OpenCodeAgent {
  return {
    name,
    description: "A manually created agent",
  } as OpenCodeAgent;
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
// Tests: spawnSubagent() — translation-only mode (no client)
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — spawnSubagent() translation-only mode", () => {
  it("translates a descriptor and stores it in translatedAgents", async () => {
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
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

  it("does not call createAgent() or updateAgent() when no client is injected", async () => {
    // No client — translation-only mode
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
    });
    await adapter.init();

    // Should complete without error even without a client
    const result = await adapter.spawnSubagent(makeDescriptor());
    expect(result.isOk()).toBe(true);
    // translatedAgents is still populated
    expect(adapter.translatedAgents.has("test-agent")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: spawnSubagent() — SDK-backed create path
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — spawnSubagent() SDK create path", () => {
  it("calls createAgent() when no existing agent is found", async () => {
    const mockClient = new MockOpenCodeClient();
    // listAgents returns empty list → create path
    mockClient.setListAgentsResult(okAsync([]));

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    await adapter.spawnSubagent(makeDescriptor());

    // listAgents was called once during reconciliation
    expect(mockClient.listAgentsCalls).toHaveLength(1);
    // createAgent was called with the correct agent name
    expect(mockClient.createAgentCalls).toHaveLength(1);
    expect(mockClient.createAgentCalls[0]?.name).toBe("test-agent");
    // updateAgent was NOT called
    expect(mockClient.updateAgentCalls).toHaveLength(0);
  });

  it("passes the translated config to createAgent()", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(okAsync([]));

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    await adapter.spawnSubagent(
      makeDescriptor({ composedPrompt: "Custom prompt text" }),
    );

    const call = mockClient.createAgentCalls[0];
    expect(call).toBeDefined();
    expect(call?.config.prompt).toBe("Custom prompt text");
    expect(call?.config.mode).toBe("subagent");
  });

  it("tags the config with WEAVE_OWNERSHIP_TAG on create", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(okAsync([]));

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    await adapter.spawnSubagent(makeDescriptor({ description: "My agent" }));

    const call = mockClient.createAgentCalls[0];
    expect(call?.config.description).toContain(WEAVE_OWNERSHIP_TAG);
  });

  it("stores translated config in translatedAgents even on create path", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(okAsync([]));

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    await adapter.spawnSubagent(makeDescriptor());

    expect(adapter.translatedAgents.has("test-agent")).toBe(true);
  });

  it("returns err when createAgent() returns an error", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(okAsync([]));
    mockClient.setCreateAgentResult(
      errAsync({
        type: "CreateAgentError" as const,
        agentName: "test-agent",
        message: "SDK write failed",
      }),
    );

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(makeDescriptor());
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("SDK write failed");
    }
  });

  it("returns err(OpenCodeAdapterError) with structured context on create failure", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(okAsync([]));
    mockClient.setCreateAgentResult(
      errAsync({
        type: "CreateAgentError" as const,
        agentName: "test-agent",
        message: "SDK write failed",
      }),
    );

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(makeDescriptor());
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        name: "OpenCodeAdapterError",
        type: "ReconcileAgentError",
        agentName: "test-agent",
        message:
          'Failed to materialize agent "test-agent" via OpenCode SDK: [CreateAgentError] SDK write failed',
      } satisfies Partial<OpenCodeAdapterError>);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: spawnSubagent() — SDK-backed update path
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — spawnSubagent() SDK update path", () => {
  it("calls updateAgent() when an existing Weave-managed agent is found", async () => {
    const mockClient = new MockOpenCodeClient();
    // listAgents returns a Weave-managed agent with the same name → update path
    mockClient.setListAgentsResult(
      okAsync([makeWeaveManagedAgent("test-agent")]),
    );

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    await adapter.spawnSubagent(makeDescriptor());

    // listAgents was called once during reconciliation
    expect(mockClient.listAgentsCalls).toHaveLength(1);
    // updateAgent was called with the correct agent name
    expect(mockClient.updateAgentCalls).toHaveLength(1);
    expect(mockClient.updateAgentCalls[0]?.name).toBe("test-agent");
    // createAgent was NOT called
    expect(mockClient.createAgentCalls).toHaveLength(0);
  });

  it("passes the translated config to updateAgent()", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(
      okAsync([makeWeaveManagedAgent("test-agent")]),
    );

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    await adapter.spawnSubagent(
      makeDescriptor({ composedPrompt: "Updated prompt" }),
    );

    const call = mockClient.updateAgentCalls[0];
    expect(call).toBeDefined();
    expect(call?.config.prompt).toBe("Updated prompt");
  });

  it("preserves WEAVE_OWNERSHIP_TAG in description on update", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(
      okAsync([makeWeaveManagedAgent("test-agent")]),
    );

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    await adapter.spawnSubagent(makeDescriptor({ description: "My agent" }));

    const call = mockClient.updateAgentCalls[0];
    expect(call?.config.description).toContain(WEAVE_OWNERSHIP_TAG);
  });

  it("returns err when updateAgent() returns an error", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(
      okAsync([makeWeaveManagedAgent("test-agent")]),
    );
    mockClient.setUpdateAgentResult(
      errAsync({
        type: "UpdateAgentError" as const,
        agentName: "test-agent",
        message: "SDK update failed",
      }),
    );

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(makeDescriptor());
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("SDK update failed");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: spawnSubagent() — collision path
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — spawnSubagent() collision path", () => {
  it("returns err with CollisionError when a foreign agent blocks the write", async () => {
    const mockClient = new MockOpenCodeClient();
    // listAgents returns a foreign agent (no ownership tag) with the same name
    mockClient.setListAgentsResult(okAsync([makeForeignAgent("test-agent")]));

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(makeDescriptor());
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("CollisionError");
    }
  });

  it("does not call createAgent() or updateAgent() on collision", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(okAsync([makeForeignAgent("test-agent")]));

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(makeDescriptor());
    expect(result.isErr()).toBe(true);

    expect(mockClient.createAgentCalls).toHaveLength(0);
    expect(mockClient.updateAgentCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: spawnSubagent() — listAgents failure
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — spawnSubagent() listAgents failure", () => {
  it("returns err when listAgents() returns an error", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(
      errAsync({
        type: "ListAgentsError" as const,
        message: "Connection refused",
      }),
    );

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(makeDescriptor());
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Connection refused");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: loadAvailableSkills() — harness-injection architecture
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — loadAvailableSkills()", () => {
  it("returns an empty array when no skills are injected", async () => {
    // No availableSkills option → harness provided nothing → empty list
    const adapter = new OpenCodeAdapter({ projectRoot: "/tmp/test-project" });
    await adapter.init();
    const skills = await adapter.loadAvailableSkills();
    expect(skills).toEqual([]);
  });

  it("returns the injected harness-provided skill list", async () => {
    const harnessSkills = [
      { name: "tdd" },
      { name: "code-review" },
      { name: "security" },
    ];
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      availableSkills: harnessSkills,
    });
    await adapter.init();
    const skills = await adapter.loadAvailableSkills();
    expect(skills).toHaveLength(3);
    expect(skills.map((s) => s.name)).toEqual([
      "tdd",
      "code-review",
      "security",
    ]);
  });

  it("returns injected skills with metadata intact", async () => {
    const harnessSkills = [
      { name: "tdd", metadata: { source: "harness", path: "/skills/tdd.md" } },
    ];
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      availableSkills: harnessSkills,
    });
    await adapter.init();
    const skills = await adapter.loadAvailableSkills();
    expect(skills[0]?.name).toBe("tdd");
    expect((skills[0]?.metadata as { source: string })?.source).toBe("harness");
  });

  it("returns the same list on repeated calls (no filesystem side effects)", async () => {
    const harnessSkills = [{ name: "tdd" }, { name: "code-review" }];
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      availableSkills: harnessSkills,
    });
    await adapter.init();
    const first = await adapter.loadAvailableSkills();
    const second = await adapter.loadAvailableSkills();
    expect(first).toEqual(second);
  });

  it("does not scan the filesystem — returns empty list for non-existent project root", async () => {
    // Even if the project root has skill directories, the adapter must NOT scan them.
    // Skills come only from the injected list.
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project-with-no-skills",
    });
    await adapter.init();
    const skills = await adapter.loadAvailableSkills();
    // No injected skills → empty list, regardless of filesystem state
    expect(skills).toEqual([]);
  });

  it("returns a defensive copy — mutating the returned array does not affect subsequent calls", async () => {
    const harnessSkills = [{ name: "tdd" }, { name: "code-review" }];
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      availableSkills: harnessSkills,
    });
    await adapter.init();

    const first = await adapter.loadAvailableSkills();
    // Mutate the returned array
    first.push({ name: "injected-by-caller" });

    // Second call must return the original list, unaffected by the mutation
    const second = await adapter.loadAvailableSkills();
    expect(second).toHaveLength(2);
    expect(second.map((s) => s.name)).toEqual(["tdd", "code-review"]);
  });

  it("two adapters with different injected skills are independent", async () => {
    const adapterA = new OpenCodeAdapter({
      availableSkills: [{ name: "tdd" }],
    });
    const adapterB = new OpenCodeAdapter({
      availableSkills: [{ name: "code-review" }, { name: "security" }],
    });
    await adapterA.init();
    await adapterB.init();

    const skillsA = await adapterA.loadAvailableSkills();
    const skillsB = await adapterB.loadAvailableSkills();

    expect(skillsA).toHaveLength(1);
    expect(skillsA[0]?.name).toBe("tdd");
    expect(skillsB).toHaveLength(2);
    expect(skillsB.map((s) => s.name)).toEqual(["code-review", "security"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: spawnSubagent() — model resolution
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter — spawnSubagent() model resolution", () => {
  it("uses resolved model from modelContext when available", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(okAsync([]));

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
      modelContext: {
        availableModels: new Set(["claude-sonnet-4-5"]),
      },
    });
    await adapter.init();

    await adapter.spawnSubagent(
      makeDescriptor({ models: ["claude-sonnet-4-5"], mode: "subagent" }),
    );

    const call = mockClient.createAgentCalls[0];
    expect(call?.config.model).toBe("claude-sonnet-4-5");
  });

  it("returns err(ModelNotAvailableError) when subagent declares unsupported model", async () => {
    const mockClient = new MockOpenCodeClient();

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
      modelContext: {
        availableModels: new Set(["claude-sonnet-4-5"]),
      },
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(
      makeDescriptor({ models: ["unsupported-model"], mode: "subagent" }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("ModelNotAvailableError");
    }
  });

  it("does not call createAgent() when model resolution fails", async () => {
    const mockClient = new MockOpenCodeClient();

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
      modelContext: {
        availableModels: new Set(["claude-sonnet-4-5"]),
      },
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(
      makeDescriptor({ models: ["unsupported-model"], mode: "subagent" }),
    );
    expect(result.isErr()).toBe(true);

    expect(mockClient.createAgentCalls).toHaveLength(0);
    expect(mockClient.updateAgentCalls).toHaveLength(0);
  });

  it("succeeds when no modelContext is provided (falls back to constant fallback)", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(okAsync([]));

    // No modelContext — falls back to DEFAULT_FALLBACK_MODEL
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(makeDescriptor({ models: [] }));
    expect(result.isOk()).toBe(true);

    expect(mockClient.createAgentCalls).toHaveLength(1);
  });

  it("succeeds for primary mode agent with unavailable model (no fail-fast)", async () => {
    const mockClient = new MockOpenCodeClient();
    mockClient.setListAgentsResult(okAsync([]));

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
      modelContext: {
        availableModels: new Set(["claude-sonnet-4-5"]),
      },
    });
    await adapter.init();

    // primary mode: fail-fast does not apply
    const result = await adapter.spawnSubagent(
      makeDescriptor({ models: ["unavailable-model"], mode: "primary" }),
    );
    expect(result.isOk()).toBe(true);
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
