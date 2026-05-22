import { beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, WeaveConfig } from "@weave/core";
import { parseConfig } from "@weave/core";

import { composeAgentDescriptor } from "../compose.js";
import { generateCategoryShuttles } from "../descriptors.js";
import type { CategoryInput } from "../template-context.js";

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
  category?: CategoryInput,
) {
  const result = await composeAgentDescriptor(
    agentName,
    agentConfig,
    config,
    allAgents,
    category,
  );

  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

beforeAll(async () => {
  await Bun.write(tempPromptFilePath, "Prompt loaded from file.");
});

describe("composeAgentDescriptor", () => {
  describe("identity fields", () => {
    it("Builtin_descriptor_keeps_stable_name_and_optional_displayName", async () => {
      const config = cfg(`
        agent loom {
          display_name "Loom"
          prompt "You are loom."
          models ["claude-sonnet-4-5"]
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.name).toBe("loom");
      expect(descriptor.displayName).toBe("Loom");
    });

    it("Builtin_descriptor_without_display_name_omits_displayName", async () => {
      const config = cfg(`
        agent shuttle {
          prompt "Specialist."
          models ["claude-sonnet-4-5"]
        }
      `);

      const descriptor = await descriptorFor(
        "shuttle",
        config.agents.shuttle,
        config,
        config.agents,
      );

      expect(descriptor.name).toBe("shuttle");
      expect(descriptor.displayName).toBeUndefined();
    });
  });

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

    it("Delegation_section_is_formatted_as_markdown_with_mermaid_in_composedPrompt", async () => {
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

      // New format includes Mermaid diagram
      expect(descriptor.composedPrompt).toContain("## Delegation");
      expect(descriptor.composedPrompt).toContain("```mermaid");
      expect(descriptor.composedPrompt).toContain("flowchart TD");
      expect(descriptor.composedPrompt).toContain('A0["router"]');
      expect(descriptor.composedPrompt).toContain('A1["reviewer"]');
      expect(descriptor.composedPrompt).toContain('A2["helper"]');
      expect(descriptor.composedPrompt).toContain("- reviewer: Reviews code");
      expect(descriptor.composedPrompt).toContain(
        "  - Quality: Complex changes",
      );
      expect(descriptor.composedPrompt).toContain(
        "  - Safety: Security-sensitive work",
      );
      expect(descriptor.composedPrompt).toContain("- helper");
      expect(descriptor.composedPrompt).toStartWith("Base prompt.");
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

  describe("stable non-category descriptor contract", () => {
    it("Custom_agent_descriptor_exposes_only_normalized_adapter_fields", async () => {
      const config = cfg(`
        agent router {
          display_name "Task Router"
          description "Routes implementation work"
          prompt "Route with {{agent.name}}."
          models ["model-primary", "model-fallback"]
          mode all
          temperature 0.4
          skills ["tdd", "code-review"]
          tool_policy {
            read allow
            write ask
            execute deny
            delegate allow
            network deny
          }
          triggers [
            { domain "Implementation" trigger "Build feature" }
          ]
        }
        agent helper {
          description "Implementation helper"
          prompt "Help."
          triggers [
            { domain "Code" trigger "Small implementation" }
          ]
        }
      `);

      const descriptor = await descriptorFor(
        "router",
        config.agents.router,
        config,
        config.agents,
      );

      expect(descriptor).toMatchObject({
        name: "router",
        displayName: "Task Router",
        description: "Routes implementation work",
        composedPrompt: expect.stringContaining("Route with router."),
        models: ["model-primary", "model-fallback"],
        mode: "all",
        temperature: 0.4,
        rawToolPolicy: {
          read: "allow",
          write: "ask",
          execute: "deny",
          delegate: "allow",
          network: "deny",
        },
        effectiveToolPolicy: {
          read: "allow",
          write: "ask",
          execute: "deny",
          delegate: "allow",
          network: "deny",
        },
        skills: ["tdd", "code-review"],
      });
      expect(descriptor.delegationTargets).toEqual([
        {
          name: "helper",
          description: "Implementation helper",
          triggers: [{ domain: "Code", trigger: "Small implementation" }],
        },
      ]);
    });

    it("Descriptor_contains_composedPrompt_not_raw_prompt_sources", async () => {
      const config = cfg(`
        agent prompt-source-check {
          prompt "Base {{agent.name}}."
          prompt_append "Append {{agent.mode}}."
        }
      `);

      const descriptor = await descriptorFor(
        "prompt-source-check",
        config.agents["prompt-source-check"],
        config,
        config.agents,
      );
      const descriptorRecord = descriptor as unknown as Record<string, unknown>;

      expect(descriptor.composedPrompt).toBe(
        "Base prompt-source-check.\n\nAppend subagent.",
      );
      expect("prompt" in descriptorRecord).toBe(false);
      expect("prompt_file" in descriptorRecord).toBe(false);
      expect("prompt_append" in descriptorRecord).toBe(false);
    });

    it("Descriptor_skills_are_requested_names_only", async () => {
      const config = cfg(`
        agent skill-check {
          prompt "Skill check."
          skills ["tdd", "security-review"]
        }
      `);

      const descriptor = await descriptorFor(
        "skill-check",
        config.agents["skill-check"],
        config,
        config.agents,
      );
      const serialized = JSON.stringify(descriptor);

      expect(descriptor.skills).toEqual(["tdd", "security-review"]);
      for (const skill of descriptor.skills) {
        expect(typeof skill).toBe("string");
      }
      expect(serialized).not.toContain("prompt_file");
      expect(serialized).not.toContain("/skills/");
      expect(serialized).not.toContain("contents");
      expect(serialized).not.toContain("metadata");
    });
  });

  describe("category metadata", () => {
    it("Generated_category_shuttle_descriptor_includes_normalized_category_metadata", async () => {
      const config = cfg(`
        agent shuttle {
          prompt "Specialist for {{category.name}}."
          models ["model-shuttle"]
        }
        category frontend {
          description "Frontend UI"
          patterns ["src/components/**", "src/pages/**/*.tsx"]
          models ["model-frontend"]
        }
      `);
      const shuttlesResult = generateCategoryShuttles(config);
      if (shuttlesResult.isErr()) throw new Error(shuttlesResult.error.message);
      const allAgents = { ...config.agents, ...shuttlesResult.value };

      const descriptor = await descriptorFor(
        "shuttle-frontend",
        shuttlesResult.value["shuttle-frontend"],
        config,
        allAgents,
        {
          name: "frontend",
          description: config.categories.frontend?.description,
          patterns: config.categories.frontend?.patterns,
        },
      );

      expect(descriptor.name).toBe("shuttle-frontend");
      expect(descriptor.category).toEqual({
        name: "frontend",
        description: "Frontend UI",
        patterns: ["src/components/**", "src/pages/**/*.tsx"],
      });
    });

    it("Regular_agent_descriptor_omits_category_metadata", async () => {
      const config = cfg(`
        agent helper {
          prompt "General helper."
        }
      `);

      const descriptor = await descriptorFor(
        "helper",
        config.agents.helper,
        config,
        config.agents,
      );

      expect(descriptor.category).toBeUndefined();
    });
  });

  describe("template rendering", () => {
    it("Inline_template_renders_agent_name_into_composedPrompt", async () => {
      const config = cfg(`
        agent loom {
          prompt "Hello, I am {{agent.name}}."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.composedPrompt).toBe("Hello, I am loom.");
    });

    it("Inline_template_renders_tool_policy_into_composedPrompt", async () => {
      const config = cfg(`
        agent loom {
          prompt "Read: {{toolPolicy.effective.read}}, Write: {{toolPolicy.effective.write}}."
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

      expect(descriptor.composedPrompt).toBe("Read: allow, Write: deny.");
    });

    it("Prompt_file_template_renders_agent_name_from_file", async () => {
      const templateFilePath = join(tmpdir(), "weave-compose-template-test.md");
      await Bun.write(templateFilePath, "Agent: {{agent.name}}.");

      const config = cfg();
      const agentConfig: AgentConfig = {
        prompt_file: templateFilePath,
      };

      const descriptor = await descriptorFor(
        "file-template-agent",
        agentConfig,
        config,
        { "file-template-agent": agentConfig },
      );

      expect(descriptor.composedPrompt).toBe("Agent: file-template-agent.");
    });

    it("Prompt_append_is_rendered_as_template", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
          prompt_append "Agent is {{agent.name}}."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.composedPrompt).toBe("Base prompt.\n\nAgent is loom.");
    });

    it("Fallback_delegation_section_inserted_when_primary_has_no_delegation_tags", async () => {
      const config = cfg(`
        agent router {
          prompt "Route tasks."
          tool_policy {
            delegate allow
          }
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

      // Fallback delegation section should be appended
      expect(descriptor.composedPrompt).toStartWith("Route tasks.");
      expect(descriptor.composedPrompt).toContain("## Delegation");
      expect(descriptor.composedPrompt).toContain("flowchart TD");
      expect(descriptor.composedPrompt).toContain("- helper");
    });

    it("Fallback_delegation_suppressed_when_primary_references_delegation_tag", async () => {
      const config = cfg(`
        agent router {
          prompt "Route tasks. {{{delegation.section}}}"
          tool_policy {
            delegate allow
          }
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

      // delegation.section is rendered inline — no duplicate fallback
      const delegationCount = (
        descriptor.composedPrompt.match(/## Delegation/g) ?? []
      ).length;
      expect(delegationCount).toBe(1);
    });

    it("Prompt_append_delegation_reference_does_not_suppress_fallback", async () => {
      const config = cfg(`
        agent router {
          prompt "Route tasks."
          prompt_append "Targets: {{#delegation.targets}}{{name}} {{/delegation.targets}}"
          tool_policy {
            delegate allow
          }
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

      // prompt_append references delegation but primary does NOT — fallback should still be inserted
      expect(descriptor.composedPrompt).toContain("## Delegation");
      // The append should also be rendered
      expect(descriptor.composedPrompt).toContain("helper");
    });

    it("Static_prompt_without_mustache_tags_works_unchanged", async () => {
      const config = cfg(`
        agent loom {
          prompt "This is a plain static prompt with no template tags."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.composedPrompt).toBe(
        "This is a plain static prompt with no template tags.",
      );
    });

    it("Template_error_in_primary_prompt_returns_PromptTemplateError", async () => {
      const config = cfg(`
        agent loom {
          prompt "Hello {{unknown.path}}."
        }
      `);

      const result = await composeAgentDescriptor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected template error");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");

      expect(result.error.agentName).toBe("loom");
      expect(result.error.sourceKind).toBe("prompt");
      expect(result.error.message).toBeTypeOf("string");
      expect(result.error.reason.kind).toBe("UnknownPath");
    });

    it("Template_error_in_prompt_file_returns_PromptTemplateError_with_promptFilePath", async () => {
      const templateFilePath = join(
        tmpdir(),
        "weave-compose-template-error-test.md",
      );
      await Bun.write(templateFilePath, "Hello {{unknown.path}}.");

      const config = cfg();
      const agentConfig: AgentConfig = {
        prompt_file: templateFilePath,
      };

      const result = await composeAgentDescriptor(
        "file-error-agent",
        agentConfig,
        config,
        { "file-error-agent": agentConfig },
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected template error");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");

      expect(result.error.agentName).toBe("file-error-agent");
      expect(result.error.sourceKind).toBe("prompt_file");
      expect(result.error.promptFilePath).toBe(templateFilePath);
      expect(result.error.reason.kind).toBe("UnknownPath");
    });

    it("Template_error_in_prompt_append_returns_PromptTemplateError_with_sourceKind_prompt_append", async () => {
      const config = cfg(`
        agent loom {
          prompt "Base prompt."
          prompt_append "Append with {{unknown.path}}."
        }
      `);

      const result = await composeAgentDescriptor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected template error");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");

      expect(result.error.agentName).toBe("loom");
      expect(result.error.sourceKind).toBe("prompt_append");
      expect(result.error.reason.kind).toBe("UnknownPath");
    });

    it("Final_prompt_order_is_rendered_primary_then_fallback_then_rendered_append", async () => {
      const config = cfg(`
        agent router {
          prompt "Primary: {{agent.name}}."
          prompt_append "Append: {{agent.mode}}."
          tool_policy {
            delegate allow
          }
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

      const parts = descriptor.composedPrompt.split("\n\n");
      // First part: rendered primary
      expect(parts[0]).toBe("Primary: router.");
      // Middle part(s): delegation section (may span multiple \n\n)
      expect(descriptor.composedPrompt).toContain("## Delegation");
      // Last part: rendered append
      expect(parts[parts.length - 1]).toBe("Append: subagent.");
    });
  });
});
