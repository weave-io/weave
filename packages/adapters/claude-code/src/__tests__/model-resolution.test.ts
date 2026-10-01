import { describe, expect, it } from "bun:test";
import {
  type AgentDescriptor,
  resolveAdapterModelIntent,
} from "@weaveio/weave-engine";
import { translateAgentToMarkdown } from "../agent-translation.js";
import {
  buildClaudeCodeModelInput,
  CLAUDE_CODE_AVAILABLE_MODELS,
} from "../model-resolution.js";

function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
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
describe("buildClaudeCodeModelInput", () => {
  it("sets agentName from descriptor", () => {
    const input = buildClaudeCodeModelInput(makeDescriptor({ name: "loom" }));
    expect(input.agentName).toBe("loom");
  });

  it("sets agentMode from descriptor", () => {
    const input = buildClaudeCodeModelInput(
      makeDescriptor({ mode: "primary" }),
    );
    expect(input.agentMode).toBe("primary");
  });

  it("sets agentModels from descriptor when non-empty", () => {
    const input = buildClaudeCodeModelInput(
      makeDescriptor({ models: ["claude-opus-4"] }),
    );
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

/** The tiers a `claude-code` recommendations section may name (Spec 39). */
const CLAUDE_CODE_MODEL_TIERS = ["opus", "sonnet", "haiku"] as const;

describe("Claude Code tier entries (Spec 39)", () => {
  it("accepts every tier a recommendations section may name", () => {
    for (const tier of CLAUDE_CODE_MODEL_TIERS) {
      expect(CLAUDE_CODE_AVAILABLE_MODELS.has(tier)).toBe(true);
    }
  });

  it("resolves a tier entry ahead of the builtin IDs behind it", () => {
    const input = buildClaudeCodeModelInput(
      makeDescriptor({ models: ["sonnet", "claude-opus-5-5"] }),
    );
    expect(resolveAdapterModelIntent(input)).toEqual({
      model: "sonnet",
      source: "agent-preference",
    });
  });

  it("writes each tier through unchanged", () => {
    for (const tier of CLAUDE_CODE_MODEL_TIERS) {
      const markdown = translateAgentToMarkdown({
        descriptor: makeDescriptor({ models: [tier] }),
        resolvedModel: tier,
        allowedTools: [],
      });
      expect(markdown).toContain(`\nmodel: ${tier}\n`);
    }
  });

  it("skips a user's unknown entry and lands on the tier", () => {
    const input = buildClaudeCodeModelInput(
      makeDescriptor({ models: ["not-a-claude-model", "haiku"] }),
    );
    expect(resolveAdapterModelIntent(input).model).toBe("haiku");
  });
});
