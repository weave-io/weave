import { describe, expect, it } from "bun:test";
import type { AgentConfig, WeaveConfig } from "@weave/core";
import { composeAgentDescriptor } from "../compose.js";

const tempDirectoryPath = "C:\\Users\\piete\\AppData\\Local\\Temp\\opencode";

function createConfig(agents: Record<string, AgentConfig>): WeaveConfig {
  return {
    agents,
    categories: {},
    disabled: {
      agents: [],
      hooks: [],
      skills: [],
    },
    workflows: {},
  };
}

describe("composeAgentDescriptor", () => {
  it("Should_return_composed_prompt_when_inline_prompt_set", async () => {
    const agentConfig: AgentConfig = {
      prompt: "You are the inline prompt.",
    };

    const result = await composeAgentDescriptor(
      "loom",
      agentConfig,
      createConfig({ loom: agentConfig }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.composedPrompt).toBe("You are the inline prompt.");
  });

  it("Should_read_prompt_file_when_prompt_file_set", async () => {
    const promptFilePath = `${tempDirectoryPath}\\compose-agent-descriptor-${crypto.randomUUID()}.md`;
    await Bun.write(promptFilePath, "You are the file prompt.");

    const agentConfig: AgentConfig = {
      prompt_file: promptFilePath,
    };

    const result = await composeAgentDescriptor(
      "shuttle",
      agentConfig,
      createConfig({ shuttle: agentConfig }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.composedPrompt).toBe("You are the file prompt.");
  });

  it("Should_append_delegation_section_when_delegate_allowed", async () => {
    const agentConfig: AgentConfig = {
      prompt: "Delegate work when appropriate.",
      tool_policy: {
        delegate: "allow",
      },
    };

    const config = createConfig({
      loom: agentConfig,
      shuttle: {
        description: "Frontend specialist",
        prompt: "Frontend prompt",
        triggers: [{ domain: "Frontend", trigger: "UI changes" }],
      },
      warp: {
        description: "Reviewer",
        prompt: "Review prompt",
      },
    });

    const result = await composeAgentDescriptor("loom", agentConfig, config);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.composedPrompt).toBe(
      "Delegate work when appropriate.\n\n## Delegation\n\n- shuttle: Frontend specialist\n  - Frontend: UI changes\n- warp: Reviewer\n  - Triggers: none specified",
    );
    expect(result.value.delegationTargets.map((target) => target.name)).toEqual([
      "shuttle",
      "warp",
    ]);
  });

  it("Should_not_append_delegation_section_when_delegate_denied", async () => {
    const agentConfig: AgentConfig = {
      prompt: "Do not delegate.",
      tool_policy: {
        delegate: "deny",
      },
    };

    const config = createConfig({
      loom: agentConfig,
      shuttle: {
        prompt: "Frontend prompt",
      },
    });

    const result = await composeAgentDescriptor("loom", agentConfig, config);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.composedPrompt).toBe("Do not delegate.");
    expect(result.value.composedPrompt.includes("## Delegation")).toBe(false);
    expect(result.value.delegationTargets).toEqual([]);
  });

  it("Should_append_prompt_append_after_prompt_content", async () => {
    const agentConfig: AgentConfig = {
      prompt: "Base prompt.",
      prompt_append: "Additional instructions.",
    };

    const result = await composeAgentDescriptor(
      "shuttle",
      agentConfig,
      createConfig({ shuttle: agentConfig }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.composedPrompt).toBe(
      "Base prompt.\n\nAdditional instructions.",
    );
  });

  it("Should_return_compose_error_when_prompt_source_missing", async () => {
    const agentConfig: AgentConfig = {
      description: "Missing prompt source",
    };

    const result = await composeAgentDescriptor(
      "warp",
      agentConfig,
      createConfig({ warp: agentConfig }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;

    expect(result.error.type).toBe("PromptSourceMissingError");
    expect(result.error.agentName).toBe("warp");
    expect(result.error.message).toContain("must define either prompt or prompt_file");
  });
});
