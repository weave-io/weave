/**
 * Unit tests for `OpenCodeAdapter`.
 *
 * Most of what this class promises is now asserted from outside, in
 * `tests/adapters/opencode-runtime.scenario.test.ts`: construction, `init()`,
 * the SDK create/update/collision paths, `listAgents` failure, and the
 * structured error a caller branches on are all visible in the agents a
 * running OpenCode is left holding. Thirty-one cases are gone, including four
 * that only exercised the test double itself.
 *
 * What stays is what no OpenCode instance can show:
 *
 * | Kept | Why |
 * | --- | --- |
 * | `translatedAgents` | A read-only snapshot with no production reader. It is documented as "NOT the primary materialization path" and nothing downstream consults it, so no OpenCode config reveals it. Kept and flagged rather than deleted — whether it should exist at all is a product decision |
 * | `loadAvailableSkills()` | Harness resource discovery is adapter-owned per `docs/adapter-boundary.md`. The skill list is injected by the host and consumed by the engine; no `.weave` file can produce one and no registered agent reveals it. Same reason `skill-discovery.test.ts` stays |
 * | The `modelContext` cases | `OpenCodeModelContext` — the set of models a live OpenCode can run — is supplied by the host, and the plugin passes `{}`. The fail-fast rule it gates is unreachable from `.weave` source |
 */

import { describe, expect, it } from "bun:test";
import { okAsync, type ResultAsync } from "neverthrow";
import type { OpenCodeClientError, OpenCodeClientFacade } from "../index.js";
import { OpenCodeAdapter } from "../index.js";
import type { OpenCodeAgent, OpenCodeAgentConfig } from "../sdk-types.js";
import { makeDescriptor } from "./support.js";

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
        availableModels: new Set(["anthropic/claude-sonnet-4-5"]),
      },
    });
    await adapter.init();

    await adapter.spawnSubagent(
      makeDescriptor({
        models: ["anthropic/claude-sonnet-4-5"],
        mode: "subagent",
      }),
    );

    const call = mockClient.createAgentCalls[0];
    expect(call?.config.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns err(ModelNotAvailableError) when subagent declares unsupported model", async () => {
    const mockClient = new MockOpenCodeClient();

    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      client: mockClient,
      modelContext: {
        availableModels: new Set(["anthropic/claude-sonnet-4-5"]),
      },
    });
    await adapter.init();

    const result = await adapter.spawnSubagent(
      makeDescriptor({
        models: ["provider/unsupported-model"],
        mode: "subagent",
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("ModelNotAvailableError");
    }
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
