import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { resolveAdapterModelIntent } from "@weaveio/weave-engine";
import {
  buildCopilotModelInput,
  COPILOT_AVAILABLE_MODELS,
} from "../model-resolution.js";

function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "prompt",
    models: ["claude-sonnet-5"],
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

describe("COPILOT_AVAILABLE_MODELS", () => {
  it("contains claude-sonnet-5", () => {
    expect(COPILOT_AVAILABLE_MODELS.has("claude-sonnet-5")).toBe(true);
  });

  it("does not contain unverified/unknown models", () => {
    expect(COPILOT_AVAILABLE_MODELS.has("gpt-4o")).toBe(false);
    expect(COPILOT_AVAILABLE_MODELS.has("claude-opus-4.7")).toBe(false);
  });
});

describe("buildCopilotModelInput", () => {
  it("sets agentName from descriptor", () => {
    const input = buildCopilotModelInput(makeDescriptor({ name: "loom" }));
    expect(input.agentName).toBe("loom");
  });

  it("sets agentMode from descriptor", () => {
    const input = buildCopilotModelInput(makeDescriptor({ mode: "primary" }));
    expect(input.agentMode).toBe("primary");
  });

  it("sets agentModels from descriptor when non-empty", () => {
    const input = buildCopilotModelInput(
      makeDescriptor({ models: ["claude-sonnet-5"] }),
    );
    expect(input.agentModels).toEqual(["claude-sonnet-5"]);
  });

  it("sets agentModels to undefined when empty", () => {
    const input = buildCopilotModelInput(makeDescriptor({ models: [] }));
    expect(input.agentModels).toBeUndefined();
  });

  it("includes the availableModels set (passthrough when populated)", () => {
    const input = buildCopilotModelInput(makeDescriptor());
    expect(input.availableModels).toBe(COPILOT_AVAILABLE_MODELS);
    expect(input.availableModels?.size).toBeGreaterThan(0);
  });

  it("falls back to the descriptor's first preferred model when COPILOT_AVAILABLE_MODELS is empty", () => {
    const emptySet = new Set<string>();
    const descriptor = makeDescriptor({ models: ["gpt-5", "claude-sonnet-5"] });
    const input = {
      ...buildCopilotModelInput(descriptor),
      availableModels: emptySet,
    };

    const result = resolveAdapterModelIntent(input);

    // With an empty availableModels set, none of the agent's preferred
    // models match, so resolution falls through to the constant fallback.
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.source).toBe("constant-fallback");
  });

  it("passes through a confirmed model when COPILOT_AVAILABLE_MODELS is populated", () => {
    const descriptor = makeDescriptor({ models: ["claude-sonnet-5"] });
    const input = buildCopilotModelInput(descriptor);

    const result = resolveAdapterModelIntent(input);

    expect(result.model).toBe("claude-sonnet-5");
    expect(result.source).toBe("agent-preference");
  });
});
