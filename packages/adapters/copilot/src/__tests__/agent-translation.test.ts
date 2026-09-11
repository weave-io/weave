import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { translateAgentToCopilotMarkdown } from "../agent-translation.js";

function makeDescriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "test-agent",
    composedPrompt: "You are a test agent.",
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

describe("translateAgentToCopilotMarkdown", () => {
  it("produces valid frontmatter with name only allowed keys", () => {
    const result = translateAgentToCopilotMarkdown({
      descriptor: makeDescriptor(),
      resolvedModel: "claude-sonnet-5",
      allowedTools: ["read", "edit"],
      mcpServers: [],
    });

    expect(result).toContain("---\nname: test-agent");
    expect(result).toContain("tools:\n  - read\n  - edit");
    expect(result).toContain("---\n\nYou are a test agent.\n");
  });

  it("includes description when present", () => {
    const result = translateAgentToCopilotMarkdown({
      descriptor: makeDescriptor({ description: "A helpful agent" }),
      resolvedModel: "claude-sonnet-5",
      allowedTools: [],
      mcpServers: [],
    });

    expect(result).toContain("description: A helpful agent");
  });

  it("omits description when not present", () => {
    const result = translateAgentToCopilotMarkdown({
      descriptor: makeDescriptor(),
      resolvedModel: "claude-sonnet-5",
      allowedTools: [],
      mcpServers: [],
    });

    expect(result).not.toContain("description:");
  });

  it("omits tools section when allowedTools is empty", () => {
    const result = translateAgentToCopilotMarkdown({
      descriptor: makeDescriptor(),
      resolvedModel: "claude-sonnet-5",
      allowedTools: [],
      mcpServers: [],
    });

    expect(result).not.toContain("tools:");
  });

  it("omits mcp-servers section when mcpServers is empty", () => {
    const result = translateAgentToCopilotMarkdown({
      descriptor: makeDescriptor(),
      resolvedModel: "claude-sonnet-5",
      allowedTools: [],
      mcpServers: [],
    });

    expect(result).not.toContain("mcp-servers:");
  });

  it("includes mcp-servers section when mcpServers is non-empty", () => {
    const result = translateAgentToCopilotMarkdown({
      descriptor: makeDescriptor(),
      resolvedModel: "claude-sonnet-5",
      allowedTools: [],
      mcpServers: ["server-1", "server-2"],
    });

    expect(result).toContain("mcp-servers:\n  - server-1\n  - server-2");
  });

  it("never emits model, trust, or approved keys", () => {
    const result = translateAgentToCopilotMarkdown({
      descriptor: makeDescriptor({ description: "desc" }),
      resolvedModel: "claude-sonnet-5",
      allowedTools: ["read"],
      mcpServers: ["server-1"],
    });

    expect(result).not.toContain("model:");
    expect(result).not.toContain("trust:");
    expect(result).not.toContain("approved:");
  });

  it("name/filename invariant: name matches descriptor.name exactly", () => {
    const result = translateAgentToCopilotMarkdown({
      descriptor: makeDescriptor({ name: "shuttle-backend" }),
      resolvedModel: "claude-sonnet-5",
      allowedTools: [],
      mcpServers: [],
    });

    expect(result).toContain("name: shuttle-backend");
  });

  describe("plugin agent id qualification (github/app#3685)", () => {
    it("qualifies name as `<sourceId>:<agent-name>` when pluginAgentIdQualifier is provided", () => {
      const result = translateAgentToCopilotMarkdown({
        descriptor: makeDescriptor({ name: "loom" }),
        resolvedModel: "claude-sonnet-5",
        allowedTools: [],
        mcpServers: [],
        pluginAgentIdQualifier: "weave",
      });

      expect(result).toContain("---\nname: weave:loom");
    });

    it("leaves name bare when pluginAgentIdQualifier is omitted", () => {
      const result = translateAgentToCopilotMarkdown({
        descriptor: makeDescriptor({ name: "loom" }),
        resolvedModel: "claude-sonnet-5",
        allowedTools: [],
        mcpServers: [],
      });

      expect(result).toContain("---\nname: loom");
      expect(result).not.toContain(":loom");
    });

    it("never qualifies the description or any other frontmatter field", () => {
      const result = translateAgentToCopilotMarkdown({
        descriptor: makeDescriptor({
          name: "loom",
          description: "Orchestrator",
        }),
        resolvedModel: "claude-sonnet-5",
        allowedTools: ["read"],
        mcpServers: [],
        pluginAgentIdQualifier: "weave",
      });

      expect(result).toContain("description: Orchestrator");
      expect(result).not.toContain("description: weave:Orchestrator");
    });
  });

  describe("YAML escaping", () => {
    it("quotes description containing a colon", () => {
      const result = translateAgentToCopilotMarkdown({
        descriptor: makeDescriptor({ description: "Backend: APIs" }),
        resolvedModel: "claude-sonnet-5",
        allowedTools: [],
        mcpServers: [],
      });

      expect(result).toContain('description: "Backend: APIs"');
    });

    it("quotes description containing a hash", () => {
      const result = translateAgentToCopilotMarkdown({
        descriptor: makeDescriptor({ description: "Handles #tags" }),
        resolvedModel: "claude-sonnet-5",
        allowedTools: [],
        mcpServers: [],
      });

      expect(result).toContain('description: "Handles #tags"');
    });

    it("escapes embedded double quotes", () => {
      const result = translateAgentToCopilotMarkdown({
        descriptor: makeDescriptor({ description: 'Says "hello": always' }),
        resolvedModel: "claude-sonnet-5",
        allowedTools: [],
        mcpServers: [],
      });

      expect(result).toContain('description: "Says \\"hello\\": always"');
    });

    it("leaves safe descriptions unquoted", () => {
      const result = translateAgentToCopilotMarkdown({
        descriptor: makeDescriptor({ description: "A safe description" }),
        resolvedModel: "claude-sonnet-5",
        allowedTools: [],
        mcpServers: [],
      });

      expect(result).toContain("description: A safe description");
      expect(result).not.toContain('description: "');
    });
  });

  it("produces an exact snapshot of a canonical descriptor", () => {
    const result = translateAgentToCopilotMarkdown({
      descriptor: makeDescriptor({
        name: "shuttle",
        description: "Domain specialist",
        composedPrompt: "You are Shuttle.",
      }),
      resolvedModel: "claude-sonnet-5",
      allowedTools: ["read", "edit", "execute"],
      mcpServers: ["github"],
    });

    expect(result).toBe(
      [
        "---",
        "name: shuttle",
        "description: Domain specialist",
        "tools:",
        "  - read",
        "  - edit",
        "  - execute",
        "mcp-servers:",
        "  - github",
        "---",
        "",
        "You are Shuttle.",
        "",
      ].join("\n"),
    );
  });
});
