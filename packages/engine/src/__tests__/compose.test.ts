import { beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, WeaveConfig } from "@weave/core";
import { parseConfig } from "@weave/core";

import { composeAgentDescriptor } from "../compose.js";

const tempPromptFilePath = join(
  tmpdir(),
  "weave-compose-agent-descriptor-prompt.md",
);

function cfg(source = ""): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function descriptorFor(
  agentName: string,
  agentConfig: AgentConfig,
  config: WeaveConfig,
  allAgents: Record<string, AgentConfig>,
) {
  const result = await composeAgentDescriptor(
    agentName,
    agentConfig,
    config,
    allAgents,
  );

  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

beforeAll(async () => {
  await Bun.write(tempPromptFilePath, "Prompt loaded from file.");
});

describe("composeAgentDescriptor", () => {
  describe("prompt source", () => {
    it("Inline_prompt_produces_correct_composedPrompt", async () => {
      const config = cfg(`
        agent loom {
          prompt "Inline prompt."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.composedPrompt).toBe("Inline prompt.");
    });

    it("Prompt_file_loads_file_content_from_disk", async () => {
      const config = cfg();
      const agentConfig: AgentConfig = {
        prompt_file: tempPromptFilePath,
      };

      const descriptor = await descriptorFor(
        "file-agent",
        agentConfig,
        config,
        { "file-agent": agentConfig },
      );

      expect(descriptor.composedPrompt).toBe("Prompt loaded from file.");
    });

    it("Missing_prompt_and_prompt_file_returns_PromptSourceMissingError", async () => {
      const config = cfg();
      const agentConfig: AgentConfig = {
        models: ["claude-sonnet-4-5"],
      };

      const result = await composeAgentDescriptor(
        "missing-prompt",
        agentConfig,
        config,
        { "missing-prompt": agentConfig },
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected prompt source error");

      expect(result.error).toEqual({
        type: "PromptSourceMissingError",
        agentName: "missing-prompt",
        message:
          'Agent "missing-prompt" must define either prompt or prompt_file.',
      });
    });

    it("Unreadable_prompt_file_returns_PromptFileReadError", async () => {
      const config = cfg();
      const promptFilePath = join(
        tmpdir(),
        "weave-compose-agent-descriptor-missing-prompt.md",
      );
      const agentConfig: AgentConfig = {
        prompt_file: promptFilePath,
      };

      const result = await composeAgentDescriptor(
        "unreadable-file-agent",
        agentConfig,
        config,
        { "unreadable-file-agent": agentConfig },
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected prompt file read error");

      expect(result.error.type).toBe("PromptFileReadError");
      expect(result.error.agentName).toBe("unreadable-file-agent");
      if (result.error.type !== "PromptFileReadError")
        throw new Error("wrong error type");
      expect(result.error.promptFilePath).toBe(promptFilePath);
      expect(result.error.message).toBe(
        `Failed to read prompt file for agent "unreadable-file-agent": ${promptFilePath}`,
      );
      if (result.error.type !== "PromptFileReadError")
        throw new Error("wrong error type");
      expect(result.error.fileErrorMessage).toBeTypeOf("string");
      expect(result.error.fileErrorMessage.length).toBeGreaterThan(0);
    });
  });

  describe("prompt_append", () => {
    it("Prompt_append_is_appended_after_prompt_source", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
          prompt_append "Additional guidance."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.composedPrompt).toBe(
        "Base prompt.\n\nAdditional guidance.",
      );
    });

    it("No_prompt_append_does_not_add_extra_section", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.composedPrompt).toBe("Base prompt.");
    });
  });

  describe("delegation targets", () => {
    it("Agent_with_no_delegate_allow_has_empty_delegation_targets", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
          tool_policy {
            delegate ask
          }
        }
        agent helper {
          prompt "Helper prompt."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.delegationTargets).toEqual([]);
      expect(descriptor.composedPrompt).toBe("Base prompt.");
    });

    it("Agent_with_delegate_allow_includes_eligible_sibling_agents", async () => {
      const config = cfg(`
        agent router {
          prompt "Router prompt."
          tool_policy {
            delegate allow
          }
        }
        agent helper {
          prompt "Helper prompt."
        }
        agent reviewer {
          prompt "Reviewer prompt."
          mode all
        }
        agent loom {
          prompt "Primary prompt."
          mode primary
        }
      `);

      const descriptor = await descriptorFor(
        "router",
        config.agents.router,
        config,
        config.agents,
      );

      expect(descriptor.delegationTargets.map((target) => target.name)).toEqual(
        ["helper", "reviewer"],
      );
    });

    it("Self_is_excluded_from_delegation_targets", async () => {
      const config = cfg(`
        agent router {
          prompt "Router prompt."
          tool_policy {
            delegate allow
          }
        }
      `);

      const descriptor = await descriptorFor(
        "router",
        config.agents.router,
        config,
        config.agents,
      );

      expect(descriptor.delegationTargets).toEqual([]);
    });

    it("Disabled_agents_are_excluded_from_delegation_targets", async () => {
      const config = cfg(`
        agent router {
          prompt "Router prompt."
          tool_policy {
            delegate allow
          }
        }
        agent helper {
          prompt "Helper prompt."
        }
        agent reviewer {
          prompt "Reviewer prompt."
        }
        disable agents ["helper"]
      `);

      const descriptor = await descriptorFor(
        "router",
        config.agents.router,
        config,
        config.agents,
      );

      expect(descriptor.delegationTargets.map((target) => target.name)).toEqual(
        ["reviewer"],
      );
    });

    it("Primary_mode_agents_are_excluded_from_delegation_targets", async () => {
      const config = cfg(`
        agent router {
          prompt "Router prompt."
          tool_policy {
            delegate allow
          }
        }
        agent helper {
          prompt "Helper prompt."
        }
        agent loom {
          prompt "Primary prompt."
          mode primary
        }
      `);

      const descriptor = await descriptorFor(
        "router",
        config.agents.router,
        config,
        config.agents,
      );

      expect(descriptor.delegationTargets.map((target) => target.name)).toEqual(
        ["helper"],
      );
    });

    it("Delegation_section_is_formatted_as_markdown_in_composedPrompt", async () => {
      const config = cfg(`
        agent router {
          prompt "Base prompt."
          tool_policy {
            delegate allow
          }
        }
        agent reviewer {
          prompt "Reviewer prompt."
          description "Reviews code"
          triggers [
            { domain "Quality" trigger "Complex changes" }
            { domain "Safety" trigger "Security-sensitive work" }
          ]
        }
        agent helper {
          prompt "Helper prompt."
        }
      `);

      const descriptor = await descriptorFor(
        "router",
        config.agents.router,
        config,
        config.agents,
      );

      expect(descriptor.composedPrompt).toBe(
        "Base prompt.\n\n## Delegation\n\n- reviewer: Reviews code\n  - Quality: Complex changes\n  - Safety: Security-sensitive work\n- helper",
      );
    });

    it("Shuttle_agent_excludes_shuttle_category_agents_from_delegation_targets", async () => {
      const config = cfg(`
        agent shuttle {
          prompt "Shuttle prompt."
          tool_policy {
            delegate allow
          }
        }
        agent shuttle-frontend {
          prompt "Frontend shuttle prompt."
        }
        agent shuttle-backend {
          prompt "Backend shuttle prompt."
        }
        agent helper {
          prompt "Helper prompt."
        }
      `);

      const descriptor = await descriptorFor(
        "shuttle",
        config.agents.shuttle,
        config,
        config.agents,
      );

      expect(descriptor.delegationTargets.map((target) => target.name)).toEqual(
        ["helper"],
      );
    });

    it("Category_shuttle_excludes_other_category_shuttles_from_delegation_targets", async () => {
      const config = cfg(`
        agent shuttle-frontend {
          prompt "Frontend shuttle prompt."
          tool_policy {
            delegate allow
          }
        }
        agent shuttle-backend {
          prompt "Backend shuttle prompt."
        }
        agent shuttle-data {
          prompt "Data shuttle prompt."
        }
        agent helper {
          prompt "Helper prompt."
        }
      `);

      const descriptor = await descriptorFor(
        "shuttle-frontend",
        config.agents["shuttle-frontend"],
        config,
        config.agents,
      );

      expect(descriptor.delegationTargets.map((target) => target.name)).toEqual(
        ["helper"],
      );
    });
  });

  describe("skills passthrough", () => {
    it("Skills_array_is_passed_through_unchanged", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
          skills ["review", "summarize", "handoff"]
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.skills).toEqual(["review", "summarize", "handoff"]);
    });

    it("Missing_skills_defaults_to_empty_array", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.skills).toEqual([]);
    });
  });

  describe("tool policy", () => {
    it("EffectiveToolPolicy_resolves_all_5_capabilities_when_all_declared", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
          tool_policy {
            read allow
            write deny
            execute ask
            delegate allow
            network deny
          }
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.effectiveToolPolicy).toEqual({
        read: "allow",
        write: "deny",
        execute: "ask",
        delegate: "allow",
        network: "deny",
      });
    });

    it("EffectiveToolPolicy_defaults_undeclared_capabilities_to_ask", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
          tool_policy {
            read allow
            write deny
          }
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.effectiveToolPolicy).toEqual({
        read: "allow",
        write: "deny",
        execute: "ask",
        delegate: "ask",
        network: "ask",
      });
    });

    it("RawToolPolicy_is_preserved_as_is_from_config", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
          tool_policy {
            read allow
            network deny
          }
        }
      `);
      const agentConfig = config.agents.loom;

      const descriptor = await descriptorFor(
        "loom",
        agentConfig,
        config,
        config.agents,
      );

      expect(descriptor.rawToolPolicy).toBe(agentConfig.tool_policy);
      expect(descriptor.rawToolPolicy).toEqual({
        read: "allow",
        network: "deny",
      });
    });

    it("Agent_with_no_tool_policy_has_undefined_rawToolPolicy", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.rawToolPolicy).toBeUndefined();
    });
  });
});
