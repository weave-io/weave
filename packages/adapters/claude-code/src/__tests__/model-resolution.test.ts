import { describe, expect, it } from "bun:test";
import { buildClaudeCodeModelInput, CLAUDE_CODE_AVAILABLE_MODELS } from "../model-resolution.js";
import type { AgentDescriptor } from "@weaveio/weave-engine";

function makeDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "prompt",
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

describe("CLAUDE_CODE_AVAILABLE_MODELS", () => {
  it("contains claude-sonnet-4-5", () => {
    expect(CLAUDE_CODE_AVAILABLE_MODELS.has("claude-sonnet-4-5")).toBe(true);
  });

  it("contains claude-opus-4", () => {
    expect(CLAUDE_CODE_AVAILABLE_MODELS.has("claude-opus-4")).toBe(true);
  });

  it("does not contain unknown models", () => {
    expect(CLAUDE_CODE_AVAILABLE_MODELS.has("gpt-4o")).toBe(false);
  });
});

describe("buildClaudeCodeModelInput", () => {
  it("sets agentName from descriptor", () => {
    const input = buildClaudeCodeModelInput(makeDescriptor({ name: "loom" }));
    expect(input.agentName).toBe("loom");
  });

  it("sets agentMode from descriptor", () => {
    const input = buildClaudeCodeModelInput(makeDescriptor({ mode: "primary" }));
    expect(input.agentMode).toBe("primary");
  });

  it("sets agentModels from descriptor when non-empty", () => {
    const input = buildClaudeCodeModelInput(makeDescriptor({ models: ["claude-opus-4"] }));
    expect(input.agentModels).toEqual(["claude-opus-4"]);
  });

  it("sets agentModels to undefined when empty", () => {
    const input = buildClaudeCodeModelInput(makeDescriptor({ models: [] }));
    expect(input.agentModels).toBeUndefined();
  });

  it("includes availableModels set", () => {
    const input = buildClaudeCodeModelInput(makeDescriptor());
    expect(input.availableModels).toBe(CLAUDE_CODE_AVAILABLE_MODELS);
  });
});
