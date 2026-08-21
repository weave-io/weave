/** Tests for the translation-only OpenCode adapter. */

import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  EffectiveToolPolicy,
} from "@weaveio/weave-engine";
import { OpenCodeAdapter } from "../index.js";

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

describe("OpenCodeAdapter — construction and initialization", () => {
  it("can be constructed without live SDK state", () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.translatedAgents.size).toBe(0);
    expect(adapter.planStateProvider).toBeUndefined();
  });

  it("accepts project root, model context, and injected skills", async () => {
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/test-project",
      modelContext: { availableModels: new Set(["claude-sonnet-4-5"]) },
      availableSkills: [{ name: "tdd" }],
    });

    await adapter.init();

    expect(adapter.planStateProvider).toBeDefined();
    expect(await adapter.loadAvailableSkills()).toEqual([{ name: "tdd" }]);
  });

  it("does not scan the filesystem for skills", async () => {
    const adapter = new OpenCodeAdapter({
      projectRoot: "/tmp/project-with-no-injected-skills",
    });
    await adapter.init();

    expect(await adapter.loadAvailableSkills()).toEqual([]);
  });

  it("returns a defensive copy of injected skills", async () => {
    const adapter = new OpenCodeAdapter({
      availableSkills: [{ name: "tdd" }],
    });
    const first = await adapter.loadAvailableSkills();
    first.push({ name: "caller-added" });

    expect(await adapter.loadAvailableSkills()).toEqual([{ name: "tdd" }]);
  });
});

describe("OpenCodeAdapter — spawnSubagent translation", () => {
  it("translates and records an agent without SDK calls", async () => {
    const adapter = new OpenCodeAdapter({ projectRoot: "/tmp/test-project" });
    await adapter.init();

    const result = await adapter.spawnSubagent(makeDescriptor());

    expect(result.isOk()).toBe(true);
    expect(adapter.translatedAgents.get("test-agent")).toMatchObject({
      prompt: "You are a test agent.",
      mode: "subagent",
    });
  });

  it("records multiple translated agents independently", async () => {
    const adapter = new OpenCodeAdapter();

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

  it("uses the resolved model from the supplied model context", async () => {
    const adapter = new OpenCodeAdapter({
      modelContext: {
        availableModels: new Set(["claude-sonnet-4-5"]),
      },
    });

    await adapter.spawnSubagent(makeDescriptor());

    expect(adapter.translatedAgents.get("test-agent")?.model).toBe(
      "claude-sonnet-4-5",
    );
  });

  it("returns a typed error when an explicit model is unavailable", async () => {
    const adapter = new OpenCodeAdapter({
      modelContext: {
        availableModels: new Set(["claude-sonnet-4-5"]),
      },
    });

    const result = await adapter.spawnSubagent(
      makeDescriptor({ models: ["unsupported-model"] }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ModelResolutionError");
      expect(result.error.message).toContain("unsupported-model");
    }
    expect(adapter.translatedAgents.size).toBe(0);
  });

  it("uses the adapter fallback when no model context is provided", async () => {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.spawnSubagent(makeDescriptor({ models: [] }));

    expect(result.isOk()).toBe(true);
    expect(adapter.translatedAgents.has("test-agent")).toBe(true);
  });

  it("does not apply subagent availability fail-fast to primary agents", async () => {
    const adapter = new OpenCodeAdapter({
      modelContext: {
        availableModels: new Set(["claude-sonnet-4-5"]),
      },
    });

    const result = await adapter.spawnSubagent(
      makeDescriptor({ mode: "primary", models: ["unavailable-model"] }),
    );

    expect(result.isOk()).toBe(true);
  });
});

describe("OpenCodeAdapter — unsupported fast intent", () => {
  it("records a bounded unsupported report only for fast agents", async () => {
    const adapter = new OpenCodeAdapter();

    await adapter.spawnSubagent(makeDescriptor({ name: "plain" }));
    await adapter.spawnSubagent(makeDescriptor({ name: "fast", fast: true }));

    expect(adapter.fastActivationReports.has("plain")).toBe(false);
    expect(adapter.fastActivationReports.get("fast")).toEqual({
      capability: "provider-fast-activation",
      state: "unsupported",
      reason: "response-proof-unavailable",
      evidenceKind: "none",
      evidenceOutcome: "inaccessible",
    });
  });

  it("does not add an acceleration control to translated config", async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.spawnSubagent(makeDescriptor({ name: "fast", fast: true }));

    const config = adapter.translatedAgents.get("fast");
    expect(config).toBeDefined();
    for (const field of ["fast", "speed", "service_tier", "priority"]) {
      expect(Object.hasOwn(config ?? {}, field)).toBe(false);
    }
  });

  it("clears a stale unsupported report when fast intent is removed", async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.spawnSubagent(makeDescriptor({ name: "agent", fast: true }));
    await adapter.spawnSubagent(makeDescriptor({ name: "agent" }));

    expect(adapter.fastActivationReports.has("agent")).toBe(false);
  });
});
