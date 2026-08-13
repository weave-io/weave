import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { translateAgentToMarkdown } from "../agent-translation.js";

function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "You are a test agent.",
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

describe("translateAgentToMarkdown", () => {
  it("produces valid frontmatter with name and model", () => {
    const result = translateAgentToMarkdown({
      descriptor: makeDescriptor(),
      resolvedModel: "claude-sonnet-4-5",
      allowedTools: ["Read", "Write"],
    });

    expect(result).toContain("---\nname: test-agent");
    expect(result).toContain("model: sonnet");
    expect(result).toContain("tools:\n  - Read\n  - Write");
    expect(result).toContain("---\n\nYou are a test agent.\n");
  });

  it("includes description when present", () => {
    const result = translateAgentToMarkdown({
      descriptor: makeDescriptor({ description: "A helpful agent" }),
      resolvedModel: "claude-sonnet-4-5",
      allowedTools: [],
    });

    expect(result).toContain("description: A helpful agent");
  });

  it("omits description when not present", () => {
    const result = translateAgentToMarkdown({
      descriptor: makeDescriptor(),
      resolvedModel: "claude-sonnet-4-5",
      allowedTools: [],
    });

    expect(result).not.toContain("description:");
  });

  it("omits tools section when allowedTools is empty", () => {
    const result = translateAgentToMarkdown({
      descriptor: makeDescriptor(),
      resolvedModel: "claude-sonnet-4-5",
      allowedTools: [],
    });

    expect(result).not.toContain("tools:");
  });

  it("handles category shuttle agents the same as normal agents", () => {
    const result = translateAgentToMarkdown({
      descriptor: makeDescriptor({
        name: "shuttle-backend",
        description: "Backend specialist",
        category: { name: "backend", description: "Backend APIs" },
      }),
      resolvedModel: "claude-opus-4",
      allowedTools: ["Read", "Write", "Edit", "Bash"],
    });

    expect(result).toContain("name: shuttle-backend");
    expect(result).toContain("description: Backend specialist");
    expect(result).toContain("model: opus");
  });

  it("produces output identical to no-intent parity when fast is declared", () => {
    const baseline = translateAgentToMarkdown({
      descriptor: makeDescriptor({ description: "A helpful agent" }),
      resolvedModel: "claude-sonnet-4-5",
      allowedTools: ["Read"],
    });
    const withFast = translateAgentToMarkdown({
      descriptor: makeDescriptor({
        description: "A helpful agent",
        fast: true,
      }),
      resolvedModel: "claude-sonnet-4-5",
      allowedTools: ["Read"],
    });

    expect(withFast).toBe(baseline);
  });

  it("never encodes fast frontmatter, environment, or prompt instructions", () => {
    const result = translateAgentToMarkdown({
      descriptor: makeDescriptor({ fast: true }),
      resolvedModel: "claude-sonnet-4-5",
      allowedTools: ["Read"],
    });

    expect(result).not.toContain("fast");
    expect(result).not.toContain("Fast");
    expect(result).not.toContain("fastMode");
    expect(result).not.toContain("service_tier");
    expect(result).not.toContain("speed");
    expect(result).not.toContain("anthropic-beta");
    expect(result).not.toContain("env:");
  });

  it("omits string delegation triggers from generated frontmatter", () => {
    const result = translateAgentToMarkdown({
      descriptor: makeDescriptor({
        delegationTargets: [
          {
            name: "shuttle-backend",
            description: "Backend APIs",
            triggers: ["ship patch", "review code"],
            isCategory: true,
          },
        ],
      }),
      resolvedModel: "claude-sonnet-4-5",
      allowedTools: [],
    });

    expect(result).not.toContain("triggers");
    expect(result).not.toContain("ship patch");
    expect(result).not.toContain("routing_hint");
    expect(result).not.toContain("domain");
  });

  it("emits no category pattern routing for a generated category shuttle", () => {
    const result = translateAgentToMarkdown({
      descriptor: makeDescriptor({
        name: "shuttle-backend",
        description: "Backend specialist",
        category: { name: "backend", description: "Backend APIs" },
        fast: true,
      }),
      resolvedModel: "claude-opus-4",
      allowedTools: [],
    });

    expect(result).not.toContain("patterns");
    expect(result).not.toContain("src/api/**");
    expect(result).not.toContain("fast");
    expect(result).toContain("name: shuttle-backend");
  });

  describe("toClaudeCodeModel alias mapping", () => {
    it.each([
      ["claude-sonnet-4-5", "sonnet"],
      ["claude-sonnet-4-20250514", "sonnet"],
      ["claude-sonnet-4-5-20250514", "sonnet"],
      ["claude-opus-4", "opus"],
      ["claude-opus-4-20250918", "opus"],
      ["claude-opus-4-5", "opus"],
      ["claude-haiku-3-5", "haiku"],
      ["claude-haiku-3-5-20241022", "haiku"],
    ])("maps %s → %s", (input, expected) => {
      const result = translateAgentToMarkdown({
        descriptor: makeDescriptor(),
        resolvedModel: input,
        allowedTools: [],
      });
      expect(result).toContain(`model: ${expected}`);
    });

    it("passes through unknown model strings verbatim", () => {
      const result = translateAgentToMarkdown({
        descriptor: makeDescriptor(),
        resolvedModel: "gpt-4o",
        allowedTools: [],
      });
      expect(result).toContain("model: gpt-4o");
    });
  });
});
