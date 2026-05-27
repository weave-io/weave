/**
 * Unit tests for `reconcile-agent.ts`.
 *
 * Verifies the canonical-identity and ownership-check semantics of the
 * upsert-only reconciliation module:
 *
 * - `classifyExistingAgent` uses `descriptor.name` (Canonical Agent Name) as
 *   the sole identity key — display metadata (`displayName`, `description`)
 *   is not identity.
 * - `tagWithOwnership` appends `WEAVE_OWNERSHIP_TAG` to `description` and is
 *   idempotent.
 * - `reconcileAgent` creates a new agent when none exists.
 * - `reconcileAgent` updates an existing Weave-managed agent in place.
 * - `reconcileAgent` returns a `CollisionError` when a same-named foreign
 *   agent is found — no forced takeover, no delete, no prune.
 * - `reconcileAgent` propagates `ListAgentsError`, `CreateAgentError`, and
 *   `UpdateAgentError` from the client facade.
 *
 * All tests use a `MockOpenCodeClient` — no live OpenCode runtime is required.
 */

import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { OpenCodeClientError, OpenCodeClientFacade } from "../index.js";
import {
  classifyExistingAgent,
  reconcileAgent,
  tagWithOwnership,
  WEAVE_OWNERSHIP_TAG,
} from "../reconcile-agent.js";
import type { OpenCodeAgent, OpenCodeAgentConfig } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// MockOpenCodeClient
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory mock for `OpenCodeClientFacade`.
 *
 * Records calls to each method so tests can assert interaction patterns.
 * Returns configurable responses without requiring a live OpenCode runtime.
 */
class MockOpenCodeClient implements OpenCodeClientFacade {
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

  setListAgentsResult(
    result: ResultAsync<OpenCodeAgent[], OpenCodeClientError>,
  ): void {
    this._listAgentsResult = result;
  }

  setCreateAgentResult(result: ResultAsync<void, OpenCodeClientError>): void {
    this._createAgentResult = result;
  }

  setUpdateAgentResult(result: ResultAsync<void, OpenCodeClientError>): void {
    this._updateAgentResult = result;
  }

  listAgents(): ResultAsync<OpenCodeAgent[], OpenCodeClientError> {
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

/** Builds a minimal `OpenCodeAgentConfig` for testing. */
function makeConfig(
  overrides: Partial<OpenCodeAgentConfig> = {},
): OpenCodeAgentConfig {
  return {
    prompt: "You are a test agent.",
    mode: "subagent",
    ...overrides,
  };
}

/** Builds a Weave-managed `OpenCodeAgent` (has ownership tag in description). */
function makeWeaveManagedAgent(
  name: string,
  extraDescription = "",
): OpenCodeAgent {
  const desc = extraDescription
    ? `${extraDescription} ${WEAVE_OWNERSHIP_TAG}`
    : WEAVE_OWNERSHIP_TAG;
  return { name, description: desc } as OpenCodeAgent;
}

/** Builds a foreign `OpenCodeAgent` (no ownership tag in description). */
function makeForeignAgent(name: string): OpenCodeAgent {
  return { name, description: "A manually created agent" } as OpenCodeAgent;
}

/** Builds an `OpenCodeAgent` with no description field. */
function makeAgentWithoutDescription(name: string): OpenCodeAgent {
  return { name } as OpenCodeAgent;
}

// ---------------------------------------------------------------------------
// Tests: WEAVE_OWNERSHIP_TAG constant
// ---------------------------------------------------------------------------

describe("WEAVE_OWNERSHIP_TAG", () => {
  it("is a non-empty string", () => {
    expect(typeof WEAVE_OWNERSHIP_TAG).toBe("string");
    expect(WEAVE_OWNERSHIP_TAG.length).toBeGreaterThan(0);
  });

  it("contains 'weave' to be human-readable", () => {
    expect(WEAVE_OWNERSHIP_TAG.toLowerCase()).toContain("weave");
  });
});

// ---------------------------------------------------------------------------
// Tests: classifyExistingAgent — canonical identity via name only
// ---------------------------------------------------------------------------

describe("classifyExistingAgent — canonical identity", () => {
  it("returns 'create' when no agent with the given name exists", () => {
    const result = classifyExistingAgent("my-agent", []);
    expect(result).toBe("create");
  });

  it("returns 'create' when existing agents have different names", () => {
    const agents = [
      makeWeaveManagedAgent("other-agent"),
      makeForeignAgent("another-agent"),
    ];
    const result = classifyExistingAgent("my-agent", agents);
    expect(result).toBe("create");
  });

  it("returns 'update' when a Weave-managed agent with the same name exists", () => {
    const agents = [makeWeaveManagedAgent("my-agent")];
    const result = classifyExistingAgent("my-agent", agents);
    expect(result).toBe("update");
  });

  it("returns 'collision' when a foreign agent with the same name exists", () => {
    const agents = [makeForeignAgent("my-agent")];
    const result = classifyExistingAgent("my-agent", agents);
    expect(result).toBe("collision");
  });

  it("matches by name only — different description does not affect identity", () => {
    // Two agents with the same name but different descriptions
    const weaveManagedWithDifferentDesc = {
      name: "my-agent",
      description: `Completely different description ${WEAVE_OWNERSHIP_TAG}`,
    } as OpenCodeAgent;
    const result = classifyExistingAgent("my-agent", [
      weaveManagedWithDifferentDesc,
    ]);
    // Still 'update' because name matches and ownership tag is present
    expect(result).toBe("update");
  });

  it("name match is case-sensitive (exact match required)", () => {
    const agents = [makeWeaveManagedAgent("My-Agent")];
    // 'my-agent' !== 'My-Agent' → no match → create
    const result = classifyExistingAgent("my-agent", agents);
    expect(result).toBe("create");
  });

  it("returns 'collision' when agent has no description (no ownership tag)", () => {
    const agents = [makeAgentWithoutDescription("my-agent")];
    const result = classifyExistingAgent("my-agent", agents);
    expect(result).toBe("collision");
  });

  it("uses first matching agent when multiple agents share the same name", () => {
    // Degenerate case: two agents with the same name (should not happen in
    // practice, but the classifier should handle it gracefully)
    const agents = [
      makeWeaveManagedAgent("my-agent"), // first match → update
      makeForeignAgent("my-agent"), // second match (ignored)
    ];
    const result = classifyExistingAgent("my-agent", agents);
    expect(result).toBe("update");
  });
});

// ---------------------------------------------------------------------------
// Tests: classifyExistingAgent — display metadata is not identity
// ---------------------------------------------------------------------------

describe("classifyExistingAgent — display metadata is not identity", () => {
  it("displayName field does not affect identity classification", () => {
    // An agent with a different displayName but same name → still matches
    const agent = {
      name: "my-agent",
      displayName: "Completely Different Display Name",
      description: WEAVE_OWNERSHIP_TAG,
    } as unknown as OpenCodeAgent;
    const result = classifyExistingAgent("my-agent", [agent]);
    expect(result).toBe("update");
  });

  it("description content (other than ownership tag) does not affect identity", () => {
    // Description can say anything — only the ownership tag matters for
    // the update/collision decision; name is the identity key
    const agent = makeWeaveManagedAgent(
      "my-agent",
      "This description can be anything",
    );
    const result = classifyExistingAgent("my-agent", [agent]);
    expect(result).toBe("update");
  });
});

// ---------------------------------------------------------------------------
// Tests: tagWithOwnership
// ---------------------------------------------------------------------------

describe("tagWithOwnership", () => {
  it("appends WEAVE_OWNERSHIP_TAG to an empty description", () => {
    const config = makeConfig({ description: "" });
    const tagged = tagWithOwnership(config);
    expect(tagged.description).toBe(WEAVE_OWNERSHIP_TAG);
  });

  it("appends WEAVE_OWNERSHIP_TAG to a non-empty description", () => {
    const config = makeConfig({ description: "My agent description" });
    const tagged = tagWithOwnership(config);
    expect(tagged.description).toContain("My agent description");
    expect(tagged.description).toContain(WEAVE_OWNERSHIP_TAG);
  });

  it("is idempotent — does not double-tag an already-tagged description", () => {
    const config = makeConfig({
      description: `My agent ${WEAVE_OWNERSHIP_TAG}`,
    });
    const tagged = tagWithOwnership(config);
    // Tag should appear exactly once
    const tagCount =
      (tagged.description ?? "").split(WEAVE_OWNERSHIP_TAG).length - 1;
    expect(tagCount).toBe(1);
  });

  it("does not mutate the original config", () => {
    const config = makeConfig({ description: "Original" });
    const tagged = tagWithOwnership(config);
    expect(config.description).toBe("Original");
    expect(tagged).not.toBe(config);
  });

  it("handles undefined description by treating it as empty", () => {
    const config = makeConfig({ description: undefined });
    const tagged = tagWithOwnership(config);
    expect(tagged.description).toBe(WEAVE_OWNERSHIP_TAG);
  });

  it("preserves all other config fields unchanged", () => {
    const config = makeConfig({
      prompt: "Custom prompt",
      mode: "primary",
      model: "claude-sonnet-4-5",
      description: "My agent",
    });
    const tagged = tagWithOwnership(config);
    expect(tagged.prompt).toBe("Custom prompt");
    expect(tagged.mode).toBe("primary");
    expect(tagged.model).toBe("claude-sonnet-4-5");
  });
});

// ---------------------------------------------------------------------------
// Tests: reconcileAgent — create path
// ---------------------------------------------------------------------------

describe("reconcileAgent — create path", () => {
  it("calls createAgent() when no existing agent is found", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([]));

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isOk()).toBe(true);
    expect(client.createAgentCalls).toHaveLength(1);
    expect(client.createAgentCalls[0]?.name).toBe("my-agent");
    expect(client.updateAgentCalls).toHaveLength(0);
  });

  it("uses the Canonical Agent Name (descriptor.name) as the create key", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([]));

    await reconcileAgent("canonical-name", makeConfig(), client);

    expect(client.createAgentCalls[0]?.name).toBe("canonical-name");
  });

  it("tags the config with WEAVE_OWNERSHIP_TAG before creating", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([]));

    await reconcileAgent(
      "my-agent",
      makeConfig({ description: "My agent" }),
      client,
    );

    const call = client.createAgentCalls[0];
    expect(call?.config.description).toContain(WEAVE_OWNERSHIP_TAG);
  });

  it("creates with ownership tag even when original description is empty", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([]));

    await reconcileAgent("my-agent", makeConfig({ description: "" }), client);

    const call = client.createAgentCalls[0];
    expect(call?.config.description).toBe(WEAVE_OWNERSHIP_TAG);
  });

  it("returns ok(void) on successful create", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([]));

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isOk()).toBe(true);
  });

  it("returns CreateAgentError when createAgent() fails", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([]));
    client.setCreateAgentResult(
      errAsync({
        type: "CreateAgentError" as const,
        agentName: "my-agent",
        message: "SDK write failed",
      }),
    );

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("CreateAgentError");
      expect(result.error.message).toBe("SDK write failed");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: reconcileAgent — update path
// ---------------------------------------------------------------------------

describe("reconcileAgent — update path", () => {
  it("calls updateAgent() when an existing Weave-managed agent is found", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeWeaveManagedAgent("my-agent")]));

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isOk()).toBe(true);
    expect(client.updateAgentCalls).toHaveLength(1);
    expect(client.updateAgentCalls[0]?.name).toBe("my-agent");
    expect(client.createAgentCalls).toHaveLength(0);
  });

  it("uses the Canonical Agent Name (descriptor.name) as the update key", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(
      okAsync([makeWeaveManagedAgent("canonical-name")]),
    );

    await reconcileAgent("canonical-name", makeConfig(), client);

    expect(client.updateAgentCalls[0]?.name).toBe("canonical-name");
  });

  it("preserves WEAVE_OWNERSHIP_TAG in description on update", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeWeaveManagedAgent("my-agent")]));

    await reconcileAgent(
      "my-agent",
      makeConfig({ description: "Updated description" }),
      client,
    );

    const call = client.updateAgentCalls[0];
    expect(call?.config.description).toContain(WEAVE_OWNERSHIP_TAG);
  });

  it("does not double-tag description on update", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeWeaveManagedAgent("my-agent")]));

    // Config already has the tag (simulating a re-materialization)
    await reconcileAgent(
      "my-agent",
      makeConfig({ description: `My agent ${WEAVE_OWNERSHIP_TAG}` }),
      client,
    );

    const call = client.updateAgentCalls[0];
    const tagCount =
      (call?.config.description ?? "").split(WEAVE_OWNERSHIP_TAG).length - 1;
    expect(tagCount).toBe(1);
  });

  it("returns ok(void) on successful update", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeWeaveManagedAgent("my-agent")]));

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isOk()).toBe(true);
  });

  it("returns UpdateAgentError when updateAgent() fails", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeWeaveManagedAgent("my-agent")]));
    client.setUpdateAgentResult(
      errAsync({
        type: "UpdateAgentError" as const,
        agentName: "my-agent",
        message: "SDK update failed",
      }),
    );

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("UpdateAgentError");
      expect(result.error.message).toBe("SDK update failed");
    }
  });

  it("updates presentation fields (prompt, mode) without changing identity", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeWeaveManagedAgent("my-agent")]));

    await reconcileAgent(
      "my-agent",
      makeConfig({ prompt: "New prompt text", mode: "primary" }),
      client,
    );

    const call = client.updateAgentCalls[0];
    // Identity (name) is unchanged — only presentation fields are updated
    expect(call?.name).toBe("my-agent");
    expect(call?.config.prompt).toBe("New prompt text");
    expect(call?.config.mode).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// Tests: reconcileAgent — collision path (foreign agent protection)
// ---------------------------------------------------------------------------

describe("reconcileAgent — collision path", () => {
  it("returns CollisionError when a foreign agent with the same name exists", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeForeignAgent("my-agent")]));

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("CollisionError");
    }
  });

  it("CollisionError includes the agent name", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeForeignAgent("foreign-agent")]));

    const result = await reconcileAgent("foreign-agent", makeConfig(), client);

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.type === "CollisionError") {
      expect(result.error.agentName).toBe("foreign-agent");
    }
  });

  it("CollisionError message is human-readable", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeForeignAgent("my-agent")]));

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.type === "CollisionError") {
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(result.error.message.toLowerCase()).toContain("my-agent");
    }
  });

  it("does NOT call createAgent() on collision (no forced takeover)", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeForeignAgent("my-agent")]));

    await reconcileAgent("my-agent", makeConfig(), client);

    expect(client.createAgentCalls).toHaveLength(0);
  });

  it("does NOT call updateAgent() on collision (no forced takeover)", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeForeignAgent("my-agent")]));

    await reconcileAgent("my-agent", makeConfig(), client);

    expect(client.updateAgentCalls).toHaveLength(0);
  });

  it("returns CollisionError for agent with no description (no ownership tag)", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(
      okAsync([makeAgentWithoutDescription("my-agent")]),
    );

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("CollisionError");
    }
  });

  it("does not delete or prune foreign agents (upsert-only constraint)", async () => {
    // Verify that reconcileAgent never calls any delete/prune operation.
    // The mock client has no delete method — if reconcileAgent tried to call
    // one, TypeScript would catch it at compile time. This test documents the
    // intent explicitly.
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(
      okAsync([
        makeForeignAgent("my-agent"),
        makeWeaveManagedAgent("other-agent"),
      ]),
    );

    // Only reconcile 'my-agent' — 'other-agent' should be untouched
    await reconcileAgent("my-agent", makeConfig(), client);

    // No create or update calls were made (collision blocked both)
    expect(client.createAgentCalls).toHaveLength(0);
    expect(client.updateAgentCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: reconcileAgent — listAgents failure propagation
// ---------------------------------------------------------------------------

describe("reconcileAgent — listAgents failure", () => {
  it("returns ListAgentsError when listAgents() fails", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(
      errAsync({
        type: "ListAgentsError" as const,
        message: "Connection refused",
      }),
    );

    const result = await reconcileAgent("my-agent", makeConfig(), client);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ListAgentsError");
      expect(result.error.message).toBe("Connection refused");
    }
  });

  it("does not call createAgent() or updateAgent() when listAgents() fails", async () => {
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(
      errAsync({
        type: "ListAgentsError" as const,
        message: "Connection refused",
      }),
    );

    await reconcileAgent("my-agent", makeConfig(), client);

    expect(client.createAgentCalls).toHaveLength(0);
    expect(client.updateAgentCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: first-slice upsert-only constraint
// ---------------------------------------------------------------------------

describe("reconcileAgent — first-slice upsert-only constraint", () => {
  it("never deletes agents not in the current descriptor set", async () => {
    // The mock client has no delete method — this test documents the intent.
    // reconcileAgent only creates or updates the single named agent; it never
    // touches other agents in the list.
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(
      okAsync([
        makeWeaveManagedAgent("agent-a"),
        makeWeaveManagedAgent("agent-b"),
        makeWeaveManagedAgent("agent-c"),
      ]),
    );

    // Only reconcile 'agent-a'
    const result = await reconcileAgent("agent-a", makeConfig(), client);

    expect(result.isOk()).toBe(true);
    // Only one update call for 'agent-a'; 'agent-b' and 'agent-c' are untouched
    expect(client.updateAgentCalls).toHaveLength(1);
    expect(client.updateAgentCalls[0]?.name).toBe("agent-a");
  });

  it("does not prune stale Weave-managed agents", async () => {
    // Even if the current descriptor set no longer includes 'stale-agent',
    // reconcileAgent does not remove it. Pruning is explicitly out of scope
    // for the first slice.
    const client = new MockOpenCodeClient();
    client.setListAgentsResult(okAsync([makeWeaveManagedAgent("stale-agent")]));

    // Reconcile a different agent — 'stale-agent' should remain untouched
    const result = await reconcileAgent("new-agent", makeConfig(), client);

    expect(result.isOk()).toBe(true);
    expect(client.createAgentCalls).toHaveLength(1);
    expect(client.createAgentCalls[0]?.name).toBe("new-agent");
    // No update or delete for 'stale-agent'
    expect(client.updateAgentCalls).toHaveLength(0);
  });
});
