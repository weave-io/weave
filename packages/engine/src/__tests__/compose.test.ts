import { beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentConfig,
  WeaveConfig,
  WorkflowConfig,
  WorkflowStep,
} from "@weave/core";
import { parseConfig } from "@weave/core";

import {
  type AppendCollision,
  type CategoryMetadata,
  composeAgentDescriptor,
  composeWorkflowStepPrompt,
  detectAppendCollisions,
} from "../compose.js";
import { generateCategoryShuttles } from "../descriptors.js";
import { buildTemplateContext } from "../template-context.js";
import { evaluateEffectiveToolPolicy } from "../tool-policy.js";

const tempPromptFilePath = join(
  tmpdir(),
  "weave-compose-agent-descriptor-prompt.md",
);

const tempAppendFilePath = join(
  tmpdir(),
  "weave-compose-agent-descriptor-append.md",
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
  category?: CategoryMetadata,
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
  await Bun.write(tempAppendFilePath, "Append loaded from file.");
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

  describe("prompt_append_file", () => {
    it("Prompt_append_file_loads_file_content_and_appends_after_primary", async () => {
      const config = cfg();
      const agentConfig: AgentConfig = {
        prompt: "Base prompt.",
        prompt_append_file: tempAppendFilePath,
      };

      const descriptor = await descriptorFor(
        "append-file-agent",
        agentConfig,
        config,
        { "append-file-agent": agentConfig },
      );

      expect(descriptor.composedPrompt).toBe(
        "Base prompt.\n\nAppend loaded from file.",
      );
    });

    it("Prompt_append_file_templates_are_rendered", async () => {
      const templateAppendFilePath = join(
        tmpdir(),
        "weave-compose-append-template-test.md",
      );
      await Bun.write(templateAppendFilePath, "Agent is {{agent.name}}.");

      const config = cfg();
      const agentConfig: AgentConfig = {
        prompt: "Base prompt.",
        prompt_append_file: templateAppendFilePath,
      };

      const descriptor = await descriptorFor(
        "append-template-agent",
        agentConfig,
        config,
        { "append-template-agent": agentConfig },
      );

      expect(descriptor.composedPrompt).toBe(
        "Base prompt.\n\nAgent is append-template-agent.",
      );
    });

    it("Unreadable_prompt_append_file_returns_PromptFileReadError", async () => {
      const missingAppendFilePath = join(
        tmpdir(),
        "weave-compose-missing-append.md",
      );
      const config = cfg();
      const agentConfig: AgentConfig = {
        prompt: "Base prompt.",
        prompt_append_file: missingAppendFilePath,
      };

      const result = await composeAgentDescriptor(
        "append-missing-agent",
        agentConfig,
        config,
        { "append-missing-agent": agentConfig },
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptFileReadError");

      expect(result.error.type).toBe("PromptFileReadError");
      if (result.error.type !== "PromptFileReadError")
        throw new Error("wrong error type");
      expect(result.error.agentName).toBe("append-missing-agent");
      expect(result.error.promptFilePath).toBe(missingAppendFilePath);
      expect(result.error.fileErrorMessage).toBeTypeOf("string");
      expect(result.error.fileErrorMessage.length).toBeGreaterThan(0);
    });

    it("Template_error_in_prompt_append_file_returns_PromptTemplateError_with_sourceKind_prompt_append_file", async () => {
      const badTemplateAppendFilePath = join(
        tmpdir(),
        "weave-compose-append-bad-template.md",
      );
      await Bun.write(
        badTemplateAppendFilePath,
        "Append with {{unknown.path}}.",
      );

      const config = cfg();
      const agentConfig: AgentConfig = {
        prompt: "Base prompt.",
        prompt_append_file: badTemplateAppendFilePath,
      };

      const result = await composeAgentDescriptor(
        "append-template-error-agent",
        agentConfig,
        config,
        { "append-template-error-agent": agentConfig },
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");
      expect(result.error.agentName).toBe("append-template-error-agent");
      expect(result.error.sourceKind).toBe("prompt_append_file");
      expect(result.error.promptFilePath).toBe(badTemplateAppendFilePath);
      expect(result.error.reason.kind).toBe("UnknownPath");
    });

    it("No_prompt_append_file_does_not_add_extra_section", async () => {
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

    it("Shuttle_agent_excludes_shuttle_category_agents_from_delegation_targets", async () => {
      const config = cfg(`
        agent shuttle {
          prompt "Shuttle prompt."
          mode all
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

    it("Mode_all_agent_with_non_shuttle_prefix_excludes_category_shuttles_from_delegation_targets", async () => {
      const config = cfg(`
        agent loom-shuttle {
          prompt "Loom-shuttle prompt."
          mode all
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
        "loom-shuttle",
        config.agents["loom-shuttle"],
        config,
        config.agents,
      );

      expect(descriptor.delegationTargets.map((target) => target.name)).toEqual(
        ["helper"],
      );
    });

    it("Agent_named_shuttle_with_mode_primary_does_not_exclude_category_shuttles", async () => {
      const config = cfg(`
        agent shuttle {
          prompt "Shuttle prompt."
          mode primary
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

      // mode primary targets are excluded from delegation, so shuttle-frontend and shuttle-backend
      // are included (they have no mode set, defaulting to subagent), but shuttle itself is excluded
      // (same agent). The key assertion: category shuttles are NOT excluded because source mode is primary.
      expect(descriptor.delegationTargets.map((target) => target.name)).toEqual(
        ["shuttle-frontend", "shuttle-backend", "helper"],
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

  describe("category metadata", () => {
    it("Descriptor_composed_with_category_input_carries_category_metadata", async () => {
      const config = cfg(`
        agent shuttle {
          prompt "Frontend specialist."
        }
      `);

      const descriptor = await descriptorFor(
        "shuttle-frontend",
        config.agents.shuttle,
        config,
        { "shuttle-frontend": config.agents.shuttle },
        {
          name: "frontend",
          description: "Frontend UI, styling, accessibility",
          patterns: ["src/components/**", "**/*.tsx"],
          isCategory: true,
        },
      );

      expect(descriptor.category).toEqual({
        name: "frontend",
        description: "Frontend UI, styling, accessibility",
        patterns: ["src/components/**", "**/*.tsx"],
      });
    });

    it("Descriptor_composed_without_category_input_has_undefined_category", async () => {
      const config = cfg(`
        agent loom {
          prompt "Regular agent."
        }
      `);

      const descriptor = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );

      expect(descriptor.category).toBeUndefined();
    });

    it("Category_context_renders_in_prompt_for_category_shuttles", async () => {
      const config = cfg(`
        agent shuttle {
          prompt "Category? {{agent.isCategory}}. Name: {{category.name}}. Description: {{category.description}}."
        }
      `);

      const descriptor = await descriptorFor(
        "shuttle-frontend",
        config.agents.shuttle,
        config,
        { "shuttle-frontend": config.agents.shuttle },
        {
          name: "frontend",
          description: "Frontend UI",
          patterns: ["src/components/**"],
          isCategory: true,
        },
      );

      expect(descriptor.composedPrompt).toBe(
        "Category? true. Name: frontend. Description: Frontend UI.",
      );
    });

    it("Regular_agents_and_base_shuttle_have_no_category_context", async () => {
      const config = cfg(`
        agent loom {
          prompt "Regular."
        }
        agent shuttle {
          prompt "Base shuttle."
        }
      `);

      const loom = await descriptorFor(
        "loom",
        config.agents.loom,
        config,
        config.agents,
      );
      const shuttle = await descriptorFor(
        "shuttle",
        config.agents.shuttle,
        config,
        config.agents,
      );

      expect(loom.category).toBeUndefined();
      expect(shuttle.category).toBeUndefined();
    });
  });

  describe("delegation_exclude routing", () => {
    it("Excluded_target_absent_from_agent_delegation_list", async () => {
      const config = cfg(`
        agent router {
          prompt "Router prompt."
          tool_policy {
            delegate allow
          }
          routing {
            delegation_exclude ["warp"]
          }
        }
        agent warp {
          prompt "Warp prompt."
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

      const names = descriptor.delegationTargets.map((t) => t.name);
      expect(names).not.toContain("warp");
      expect(names).toContain("helper");
    });

    it("Excluded_target_still_appears_in_other_agents_delegation_list", async () => {
      const config = cfg(`
        agent router {
          prompt "Router prompt."
          tool_policy {
            delegate allow
          }
          routing {
            delegation_exclude ["warp"]
          }
        }
        agent other-router {
          prompt "Other router prompt."
          tool_policy {
            delegate allow
          }
        }
        agent warp {
          prompt "Warp prompt."
        }
        agent helper {
          prompt "Helper prompt."
        }
      `);

      // router excludes warp
      const routerDescriptor = await descriptorFor(
        "router",
        config.agents.router,
        config,
        config.agents,
      );
      expect(
        routerDescriptor.delegationTargets.map((t) => t.name),
      ).not.toContain("warp");

      // other-router does NOT exclude warp — warp should appear
      const otherDescriptor = await descriptorFor(
        "other-router",
        config.agents["other-router"],
        config,
        config.agents,
      );
      expect(otherDescriptor.delegationTargets.map((t) => t.name)).toContain(
        "warp",
      );
    });

    it("Excluding_non_existent_target_is_a_noop", async () => {
      const config = cfg(`
        agent router {
          prompt "Router prompt."
          tool_policy {
            delegate allow
          }
          routing {
            delegation_exclude ["ghost-agent"]
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

      // ghost-agent doesn't exist — helper should still be present
      expect(descriptor.delegationTargets.map((t) => t.name)).toEqual([
        "helper",
      ]);
    });

    it("Empty_delegation_exclude_includes_all_eligible_targets", async () => {
      const config = cfg(`
        agent router {
          prompt "Router prompt."
          tool_policy {
            delegate allow
          }
          routing {
            delegation_exclude []
          }
        }
        agent helper {
          prompt "Helper prompt."
        }
        agent reviewer {
          prompt "Reviewer prompt."
        }
      `);

      const descriptor = await descriptorFor(
        "router",
        config.agents.router,
        config,
        config.agents,
      );

      const names = descriptor.delegationTargets.map((t) => t.name);
      expect(names).toContain("helper");
      expect(names).toContain("reviewer");
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
          isCategory: false,
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
      const generatedAgents = Object.fromEntries(
        Object.entries(shuttlesResult.value).map(([name, generated]) => [
          name,
          generated.config,
        ]),
      );
      const allAgents = { ...config.agents, ...generatedAgents };

      const descriptor = await descriptorFor(
        "shuttle-frontend",
        shuttlesResult.value["shuttle-frontend"].config,
        config,
        allAgents,
        {
          name: "frontend",
          description: config.categories.frontend?.description,
          patterns: config.categories.frontend?.patterns,
          isCategory: true,
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

    it("Delegation_section_path_in_primary_prompt_returns_PromptTemplateError_UnknownPath", async () => {
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

      const result = await composeAgentDescriptor(
        "router",
        config.agents.router,
        config,
        config.agents,
      );

      // {{{delegation.section}}} is no longer a known path — must produce PromptTemplateError
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");

      expect(result.error.agentName).toBe("router");
      expect(result.error.reason.kind).toBe("UnknownPath");
      if (result.error.reason.kind !== "UnknownPath")
        throw new Error("wrong reason kind");
      expect(result.error.reason.path).toBe("delegation.section");
    });

    it("Prompt_append_delegation_targets_iterates_and_no_delegation_heading_inserted", async () => {
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

      // delegation.targets in prompt_append is iterated correctly
      expect(descriptor.composedPrompt).toContain("helper");
      // No fallback delegation heading is inserted
      expect(descriptor.composedPrompt).not.toContain("## Delegation");
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

    it("Final_prompt_order_is_rendered_primary_then_rendered_append", async () => {
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
      // Last part: rendered append (no delegation section in between)
      expect(parts[parts.length - 1]).toBe("Append: subagent.");
      // No fallback delegation heading
      expect(descriptor.composedPrompt).not.toContain("## Delegation");
    });
  });
});

// ---------------------------------------------------------------------------
// composeAgentDescriptor — trust boundary for prompt_append
// ---------------------------------------------------------------------------

describe("composeAgentDescriptor — trust boundary for prompt_append", () => {
  it("Agent_prompt_append_cannot_reference_artifact_contents", async () => {
    // artifact.contents is not in the bounded context — must be rejected
    const config = cfg(`
      agent loom {
        prompt "Base prompt."
        prompt_append "Artifact: {{artifact.contents}}."
      }
    `);

    const result = await composeAgentDescriptor(
      "loom",
      config.agents.loom,
      config,
      config.agents,
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected PromptTemplateError");

    expect(result.error.type).toBe("PromptTemplateError");
    if (result.error.type !== "PromptTemplateError")
      throw new Error("wrong error type");
    expect(result.error.sourceKind).toBe("prompt_append");
    expect(result.error.reason.kind).toBe("UnknownPath");
    if (result.error.reason.kind !== "UnknownPath")
      throw new Error("wrong reason kind");
    expect(result.error.reason.path).toBe("artifact.contents");
  });

  it("Agent_prompt_append_cannot_reference_chat_history", async () => {
    // chat.history is not in the bounded context — must be rejected
    const config = cfg(`
      agent loom {
        prompt "Base prompt."
        prompt_append "History: {{chat.history}}."
      }
    `);

    const result = await composeAgentDescriptor(
      "loom",
      config.agents.loom,
      config,
      config.agents,
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected PromptTemplateError");

    expect(result.error.type).toBe("PromptTemplateError");
    if (result.error.type !== "PromptTemplateError")
      throw new Error("wrong error type");
    expect(result.error.sourceKind).toBe("prompt_append");
    expect(result.error.reason.kind).toBe("UnknownPath");
    if (result.error.reason.kind !== "UnknownPath")
      throw new Error("wrong reason kind");
    expect(result.error.reason.path).toBe("chat.history");
  });

  it("Agent_prompt_append_cannot_reference_raw_prompt", async () => {
    // raw.prompt is not in the bounded context — must be rejected
    const config = cfg(`
      agent loom {
        prompt "Base prompt."
        prompt_append "Raw: {{raw.prompt}}."
      }
    `);

    const result = await composeAgentDescriptor(
      "loom",
      config.agents.loom,
      config,
      config.agents,
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected PromptTemplateError");

    expect(result.error.type).toBe("PromptTemplateError");
    if (result.error.type !== "PromptTemplateError")
      throw new Error("wrong error type");
    expect(result.error.sourceKind).toBe("prompt_append");
    expect(result.error.reason.kind).toBe("UnknownPath");
    if (result.error.reason.kind !== "UnknownPath")
      throw new Error("wrong reason kind");
    expect(result.error.reason.path).toBe("raw.prompt");
  });

  it("Agent_prompt_append_cannot_use_partials_to_escape_bounded_context", async () => {
    // Partials are unsupported — cannot be used to load external content
    const config = cfg(`
      agent loom {
        prompt "Base prompt."
        prompt_append "{{> external-content}}"
      }
    `);

    const result = await composeAgentDescriptor(
      "loom",
      config.agents.loom,
      config,
      config.agents,
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected PromptTemplateError");

    expect(result.error.type).toBe("PromptTemplateError");
    if (result.error.type !== "PromptTemplateError")
      throw new Error("wrong error type");
    expect(result.error.sourceKind).toBe("prompt_append");
    expect(result.error.reason.kind).toBe("UnsupportedTag");
  });

  it("Agent_prompt_append_cannot_use_unsafe_prototype_paths", async () => {
    // Prototype traversal is always rejected regardless of allowed paths
    const config = cfg(`
      agent loom {
        prompt "Base prompt."
        prompt_append "Unsafe: {{__proto__}}."
      }
    `);

    const result = await composeAgentDescriptor(
      "loom",
      config.agents.loom,
      config,
      config.agents,
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected PromptTemplateError");

    expect(result.error.type).toBe("PromptTemplateError");
    if (result.error.type !== "PromptTemplateError")
      throw new Error("wrong error type");
    expect(result.error.sourceKind).toBe("prompt_append");
    expect(result.error.reason.kind).toBe("UnsafePath");
  });

  it("Agent_prompt_append_can_reference_bounded_agent_name", async () => {
    // agent.name is in the bounded context — must be accepted
    const config = cfg(`
      agent loom {
        prompt "Base prompt."
        prompt_append "Agent: {{agent.name}}."
      }
    `);

    const descriptor = await descriptorFor(
      "loom",
      config.agents.loom,
      config,
      config.agents,
    );

    expect(descriptor.composedPrompt).toBe("Base prompt.\n\nAgent: loom.");
  });

  it("Agent_prompt_append_static_text_passes_through_unchanged", async () => {
    // Static append text without Mustache tags is always safe
    const config = cfg(`
      agent loom {
        prompt "Base prompt."
        prompt_append "This is static guidance with no template tags."
      }
    `);

    const descriptor = await descriptorFor(
      "loom",
      config.agents.loom,
      config,
      config.agents,
    );

    expect(descriptor.composedPrompt).toBe(
      "Base prompt.\n\nThis is static guidance with no template tags.",
    );
  });
});

// ---------------------------------------------------------------------------
// composeWorkflowStepPrompt — Spec 22 Unit 4
// ---------------------------------------------------------------------------

/**
 * Build a minimal bounded template context for workflow step composition tests.
 * Uses a fixed agent name and default tool policy.
 */
function makeStepTemplateContext(agentName = "shuttle") {
  const effectiveToolPolicy = evaluateEffectiveToolPolicy(undefined);
  const contextResult = buildTemplateContext({
    agentName,
    mode: "subagent",
    skills: [],
    effectiveToolPolicy,
    delegationTargets: [],
  });
  if (contextResult.isErr()) throw new Error(contextResult.error.message);
  return contextResult.value;
}

/**
 * Build a minimal WorkflowStep for testing.
 */
function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: "test-step",
    type: "autonomous",
    agent: "shuttle",
    prompt: "Execute the task.",
    completion: { method: "agent_signal" },
    ...overrides,
  };
}

/**
 * Build a minimal WorkflowConfig for testing.
 */
function makeWorkflow(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    version: 1,
    steps: [],
    ...overrides,
  };
}

describe("composeWorkflowStepPrompt — Spec 22 Unit 4", () => {
  describe("no appends", () => {
    it("Step_with_no_appends_returns_step_prompt_unchanged", async () => {
      const step = makeStep({ prompt: "Do the work." });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe("Do the work.");
      expect(result.value.appendScope).toBe("none");
    });

    it("Step_prompt_is_rendered_as_template", async () => {
      const step = makeStep({ prompt: "Agent: {{agent.name}}." });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext("my-agent");

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe("Agent: my-agent.");
    });
  });

  describe("workflow-scope append only", () => {
    it("Workflow_scope_append_is_applied_when_step_has_no_append", async () => {
      const step = makeStep({ prompt: "Step prompt." });
      const workflow = makeWorkflow({ prompt_append: "Workflow guidance." });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nWorkflow guidance.",
      );
      expect(result.value.appendScope).toBe("workflow");
    });

    it("Workflow_scope_append_is_rendered_as_template", async () => {
      const step = makeStep({ prompt: "Step prompt." });
      const workflow = makeWorkflow({
        prompt_append: "Agent is {{agent.name}}.",
      });
      const ctx = makeStepTemplateContext("my-agent");

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nAgent is my-agent.",
      );
      expect(result.value.appendScope).toBe("workflow");
    });

    it("Workflow_scope_append_file_is_loaded_and_applied", async () => {
      const workflowAppendFilePath = join(
        tmpdir(),
        "weave-compose-workflow-append-test.md",
      );
      await Bun.write(workflowAppendFilePath, "Workflow file guidance.");

      const step = makeStep({ prompt: "Step prompt." });
      const workflow = makeWorkflow({
        prompt_append_file: workflowAppendFilePath,
      });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nWorkflow file guidance.",
      );
      expect(result.value.appendScope).toBe("workflow");
    });
  });

  describe("step-scope append only", () => {
    it("Step_scope_append_is_applied_when_workflow_has_no_append", async () => {
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Step guidance.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nStep guidance.",
      );
      expect(result.value.appendScope).toBe("step");
    });

    it("Step_scope_append_is_rendered_as_template", async () => {
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Mode: {{agent.mode}}.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nMode: subagent.",
      );
      expect(result.value.appendScope).toBe("step");
    });

    it("Step_scope_append_file_is_loaded_and_applied", async () => {
      const stepAppendFilePath = join(
        tmpdir(),
        "weave-compose-step-append-test.md",
      );
      await Bun.write(stepAppendFilePath, "Step file guidance.");

      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append_file: stepAppendFilePath,
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nStep file guidance.",
      );
      expect(result.value.appendScope).toBe("step");
    });
  });

  describe("step-local precedence (Spec 22 Unit 4 core rule)", () => {
    it("Step_scope_append_takes_precedence_over_workflow_scope_append", async () => {
      // Both scopes have an append — step-local wins
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Step-local guidance.",
      });
      const workflow = makeWorkflow({ prompt_append: "Workflow guidance." });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      // Step-local append is used; workflow append is suppressed
      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nStep-local guidance.",
      );
      expect(result.value.appendScope).toBe("step");
      // Workflow guidance must NOT appear
      expect(result.value.composedPrompt).not.toContain("Workflow guidance.");
    });

    it("Step_scope_append_file_takes_precedence_over_workflow_scope_append", async () => {
      const stepAppendFilePath = join(
        tmpdir(),
        "weave-compose-step-precedence-test.md",
      );
      await Bun.write(stepAppendFilePath, "Step file guidance wins.");

      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append_file: stepAppendFilePath,
      });
      const workflow = makeWorkflow({ prompt_append: "Workflow guidance." });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nStep file guidance wins.",
      );
      expect(result.value.appendScope).toBe("step");
      expect(result.value.composedPrompt).not.toContain("Workflow guidance.");
    });

    it("Step_scope_append_takes_precedence_over_workflow_scope_append_file", async () => {
      const workflowAppendFilePath = join(
        tmpdir(),
        "weave-compose-workflow-precedence-test.md",
      );
      await Bun.write(workflowAppendFilePath, "Workflow file guidance.");

      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Step inline wins.",
      });
      const workflow = makeWorkflow({
        prompt_append_file: workflowAppendFilePath,
      });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nStep inline wins.",
      );
      expect(result.value.appendScope).toBe("step");
      expect(result.value.composedPrompt).not.toContain(
        "Workflow file guidance.",
      );
    });

    it("Workflow_scope_append_is_used_when_step_has_no_append_even_if_workflow_has_one", async () => {
      // Step has no append — workflow-scope fallback applies
      const step = makeStep({ prompt: "Step prompt." });
      const workflow = makeWorkflow({ prompt_append: "Workflow fallback." });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nWorkflow fallback.",
      );
      expect(result.value.appendScope).toBe("workflow");
    });
  });

  describe("same-scope last-append-wins (config-merge layer responsibility)", () => {
    it("Single_workflow_scope_append_is_applied_as_is", async () => {
      // The config-merge layer resolves multiple appends to a single value.
      // This test verifies the composition layer handles the already-resolved value.
      const step = makeStep({ prompt: "Step prompt." });
      const workflow = makeWorkflow({
        prompt_append: "Last workflow append wins.",
      });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nLast workflow append wins.",
      );
      expect(result.value.appendScope).toBe("workflow");
    });

    it("Single_step_scope_append_is_applied_as_is", async () => {
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Last step append wins.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nLast step append wins.",
      );
      expect(result.value.appendScope).toBe("step");
    });
  });

  describe("trust boundary — bounded template context", () => {
    it("Append_cannot_reference_unknown_paths_outside_bounded_context", async () => {
      // Spec 22 Unit 4: appends are rendered against bounded template context only
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Untrusted: {{artifact.contents}}.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      // Must fail — artifact.contents is not in the bounded allowed paths
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");
      expect(result.error.reason.kind).toBe("UnknownPath");
      if (result.error.reason.kind !== "UnknownPath")
        throw new Error("wrong reason kind");
      expect(result.error.reason.path).toBe("artifact.contents");
    });

    it("Append_cannot_reference_chat_history_path", async () => {
      // chat.history is not in the bounded context — must be rejected
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "History: {{chat.history}}.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");
      expect(result.error.reason.kind).toBe("UnknownPath");
      if (result.error.reason.kind !== "UnknownPath")
        throw new Error("wrong reason kind");
      expect(result.error.reason.path).toBe("chat.history");
    });

    it("Workflow_scope_append_cannot_reference_raw_prompt_path", async () => {
      // raw.prompt is not in the bounded context — must be rejected
      const step = makeStep({ prompt: "Step prompt." });
      const workflow = makeWorkflow({
        prompt_append: "Untrusted: {{raw.prompt}}.",
      });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");
      expect(result.error.reason.kind).toBe("UnknownPath");
      if (result.error.reason.kind !== "UnknownPath")
        throw new Error("wrong reason kind");
      expect(result.error.reason.path).toBe("raw.prompt");
    });

    it("Append_can_reference_bounded_agent_context_paths", async () => {
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Agent: {{agent.name}}, Mode: {{agent.mode}}.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext("my-agent");

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nAgent: my-agent, Mode: subagent.",
      );
    });

    it("Append_can_reference_bounded_tool_policy_paths", async () => {
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Read: {{toolPolicy.effective.read}}.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      // Default tool policy resolves all capabilities to "ask"
      expect(result.value.composedPrompt).toBe("Step prompt.\n\nRead: ask.");
    });

    it("Append_cannot_use_unsafe_prototype_paths", async () => {
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Unsafe: {{__proto__}}.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");
      expect(result.error.reason.kind).toBe("UnsafePath");
    });

    it("Append_cannot_use_partials_to_escape_bounded_context", async () => {
      // Partials are unsupported — cannot be used to load external content
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "{{> external-content}}",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");
      expect(result.error.reason.kind).toBe("UnsupportedTag");
    });

    it("Append_cannot_use_delimiter_changes_to_bypass_path_validation", async () => {
      // Delimiter changes are unsupported — cannot be used to bypass path validation
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "{{= <% %> =}}<%artifact.contents%>",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");
      expect(result.error.reason.kind).toBe("UnsupportedTag");
    });

    it("Static_append_text_without_template_tags_passes_through_unchanged", async () => {
      // Static append text without Mustache tags is always safe
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "This is static guidance with no template tags.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      expect(result.value.composedPrompt).toBe(
        "Step prompt.\n\nThis is static guidance with no template tags.",
      );
    });
  });

  describe("error cases", () => {
    it("Unreadable_step_append_file_returns_PromptFileReadError", async () => {
      const missingFilePath = join(
        tmpdir(),
        `weave-compose-step-missing-append-${randomUUID()}.md`,
      );
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append_file: missingFilePath,
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptFileReadError");

      expect(result.error.type).toBe("PromptFileReadError");
      if (result.error.type !== "PromptFileReadError")
        throw new Error("wrong error type");
      expect(result.error.promptFilePath).toBe(missingFilePath);
    });

    it("Unreadable_workflow_append_file_returns_PromptFileReadError", async () => {
      const missingFilePath = join(
        tmpdir(),
        `weave-compose-workflow-missing-append-${randomUUID()}.md`,
      );
      const step = makeStep({ prompt: "Step prompt." });
      const workflow = makeWorkflow({ prompt_append_file: missingFilePath });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptFileReadError");

      expect(result.error.type).toBe("PromptFileReadError");
      if (result.error.type !== "PromptFileReadError")
        throw new Error("wrong error type");
      expect(result.error.promptFilePath).toBe(missingFilePath);
    });

    it("Template_error_in_step_prompt_returns_PromptTemplateError", async () => {
      const step = makeStep({ prompt: "Bad: {{unknown.path}}." });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");
      expect(result.error.sourceKind).toBe("prompt");
      expect(result.error.reason.kind).toBe("UnknownPath");
    });

    it("Template_error_in_step_append_returns_PromptTemplateError_with_sourceKind_prompt_append", async () => {
      const step = makeStep({
        prompt: "Step prompt.",
        prompt_append: "Bad: {{unknown.path}}.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected PromptTemplateError");

      expect(result.error.type).toBe("PromptTemplateError");
      if (result.error.type !== "PromptTemplateError")
        throw new Error("wrong error type");
      expect(result.error.sourceKind).toBe("prompt_append");
      expect(result.error.reason.kind).toBe("UnknownPath");
    });
  });

  describe("append order", () => {
    it("Composed_prompt_order_is_step_prompt_then_append", async () => {
      const step = makeStep({
        prompt: "First: step prompt.",
        prompt_append: "Second: step append.",
      });
      const workflow = makeWorkflow();
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      const parts = result.value.composedPrompt.split("\n\n");
      expect(parts[0]).toBe("First: step prompt.");
      expect(parts[1]).toBe("Second: step append.");
    });

    it("Workflow_scope_append_appears_after_step_prompt", async () => {
      const step = makeStep({ prompt: "First: step prompt." });
      const workflow = makeWorkflow({
        prompt_append: "Second: workflow append.",
      });
      const ctx = makeStepTemplateContext();

      const result = await composeWorkflowStepPrompt(
        "test-step",
        step,
        workflow,
        ctx,
      );

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(JSON.stringify(result.error));

      const parts = result.value.composedPrompt.split("\n\n");
      expect(parts[0]).toBe("First: step prompt.");
      expect(parts[1]).toBe("Second: workflow append.");
    });
  });
});

// ---------------------------------------------------------------------------
// detectAppendCollisions — Spec 22 Unit 4 collision surfacing
// ---------------------------------------------------------------------------

describe("detectAppendCollisions", () => {
  describe("no collisions", () => {
    it("Returns_empty_array_for_empty_config_list", () => {
      const result = detectAppendCollisions([]);
      expect(result).toEqual([]);
    });

    it("Returns_empty_array_for_single_config_with_no_workflows", () => {
      const result = detectAppendCollisions([cfg()]);
      expect(result).toEqual([]);
    });

    it("Returns_empty_array_when_only_one_config_defines_workflow_append", () => {
      const base = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append "Base guidance."
        }
      `);
      const result = detectAppendCollisions([base]);
      expect(result).toEqual([]);
    });

    it("Returns_empty_array_when_configs_define_different_workflows", () => {
      const a = cfg(`
        workflow wf-a {
          version 1
          step s1 {
            name "S1"
            type autonomous
            agent shuttle
            prompt "Do A."
            completion agent_signal
          }
          prompt_append "Guidance A."
        }
      `);
      const b = cfg(`
        workflow wf-b {
          version 1
          step s1 {
            name "S1"
            type autonomous
            agent shuttle
            prompt "Do B."
            completion agent_signal
          }
          prompt_append "Guidance B."
        }
      `);
      const result = detectAppendCollisions([a, b]);
      expect(result).toEqual([]);
    });

    it("Returns_empty_array_when_configs_define_different_steps", () => {
      const a = cfg(`
        workflow my-wf {
          version 1
          step step-a {
            name "Step A"
            type autonomous
            agent shuttle
            prompt "Do A."
            completion agent_signal
            prompt_append "Step A guidance."
          }
        }
      `);
      const b = cfg(`
        workflow my-wf {
          version 1
          step step-b {
            name "Step B"
            type autonomous
            agent shuttle
            prompt "Do B."
            completion agent_signal
            prompt_append "Step B guidance."
          }
        }
      `);
      const result = detectAppendCollisions([a, b]);
      expect(result).toEqual([]);
    });
  });

  describe("workflow-scope collisions", () => {
    it("Detects_collision_when_two_configs_define_workflow_prompt_append", () => {
      const base = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append "Base guidance."
        }
      `);
      const override = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append "Override guidance."
        }
      `);

      const result = detectAppendCollisions([base, override]);

      expect(result).toHaveLength(1);
      const collision = result[0] as AppendCollision;
      expect(collision.scope).toBe("workflow");
      expect(collision.workflowName).toBe("my-wf");
      expect(collision.stepName).toBeUndefined();
      expect(collision.field).toBe("prompt_append");
      expect(collision.losingValue).toBe("Base guidance.");
      expect(collision.winningValue).toBe("Override guidance.");
      expect(collision.loserIndex).toBe(0);
      expect(collision.winnerIndex).toBe(1);
    });

    it("Detects_collision_when_two_configs_define_workflow_prompt_append_file", () => {
      const base = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append_file "base-guidance.md"
        }
      `);
      const override = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append_file "override-guidance.md"
        }
      `);

      const result = detectAppendCollisions([base, override]);

      expect(result).toHaveLength(1);
      const collision = result[0] as AppendCollision;
      expect(collision.scope).toBe("workflow");
      expect(collision.workflowName).toBe("my-wf");
      expect(collision.field).toBe("prompt_append_file");
      expect(collision.losingValue).toBe("base-guidance.md");
      expect(collision.winningValue).toBe("override-guidance.md");
      expect(collision.loserIndex).toBe(0);
      expect(collision.winnerIndex).toBe(1);
    });

    it("Detects_collision_across_three_configs_reports_last_two", () => {
      // Three configs all define the same workflow-level prompt_append.
      // The collision is between the second (loser) and third (winner).
      const first = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append "First guidance."
        }
      `);
      const second = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append "Second guidance."
        }
      `);
      const third = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append "Third guidance."
        }
      `);

      const result = detectAppendCollisions([first, second, third]);

      expect(result).toHaveLength(1);
      const collision = result[0] as AppendCollision;
      expect(collision.losingValue).toBe("Second guidance.");
      expect(collision.winningValue).toBe("Third guidance.");
      expect(collision.loserIndex).toBe(1);
      expect(collision.winnerIndex).toBe(2);
    });
  });

  describe("step-scope collisions", () => {
    it("Detects_collision_when_two_configs_define_step_prompt_append", () => {
      const base = cfg(`
        workflow my-wf {
          version 1
          step my-step {
            name "My step"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
            prompt_append "Base step guidance."
          }
        }
      `);
      const override = cfg(`
        workflow my-wf {
          version 1
          step my-step {
            name "My step"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
            prompt_append "Override step guidance."
          }
        }
      `);

      const result = detectAppendCollisions([base, override]);

      expect(result).toHaveLength(1);
      const collision = result[0] as AppendCollision;
      expect(collision.scope).toBe("step");
      expect(collision.workflowName).toBe("my-wf");
      expect(collision.stepName).toBe("my-step");
      expect(collision.field).toBe("prompt_append");
      expect(collision.losingValue).toBe("Base step guidance.");
      expect(collision.winningValue).toBe("Override step guidance.");
      expect(collision.loserIndex).toBe(0);
      expect(collision.winnerIndex).toBe(1);
    });

    it("Detects_collision_when_two_configs_define_step_prompt_append_file", () => {
      const base = cfg(`
        workflow my-wf {
          version 1
          step my-step {
            name "My step"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
            prompt_append_file "base-step.md"
          }
        }
      `);
      const override = cfg(`
        workflow my-wf {
          version 1
          step my-step {
            name "My step"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
            prompt_append_file "override-step.md"
          }
        }
      `);

      const result = detectAppendCollisions([base, override]);

      expect(result).toHaveLength(1);
      const collision = result[0] as AppendCollision;
      expect(collision.scope).toBe("step");
      expect(collision.workflowName).toBe("my-wf");
      expect(collision.stepName).toBe("my-step");
      expect(collision.field).toBe("prompt_append_file");
      expect(collision.losingValue).toBe("base-step.md");
      expect(collision.winningValue).toBe("override-step.md");
    });
  });

  describe("multiple collisions", () => {
    it("Detects_both_workflow_and_step_collisions_in_one_call", () => {
      const base = cfg(`
        workflow my-wf {
          version 1
          step my-step {
            name "My step"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
            prompt_append "Base step guidance."
          }
          prompt_append "Base workflow guidance."
        }
      `);
      const override = cfg(`
        workflow my-wf {
          version 1
          step my-step {
            name "My step"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
            prompt_append "Override step guidance."
          }
          prompt_append "Override workflow guidance."
        }
      `);

      const result = detectAppendCollisions([base, override]);

      // Two collisions: one at workflow scope, one at step scope
      expect(result).toHaveLength(2);

      const workflowCollision = result.find((c) => c.scope === "workflow");
      expect(workflowCollision).toBeDefined();
      expect(workflowCollision?.field).toBe("prompt_append");
      expect(workflowCollision?.losingValue).toBe("Base workflow guidance.");
      expect(workflowCollision?.winningValue).toBe(
        "Override workflow guidance.",
      );

      const stepCollision = result.find((c) => c.scope === "step");
      expect(stepCollision).toBeDefined();
      expect(stepCollision?.stepName).toBe("my-step");
      expect(stepCollision?.field).toBe("prompt_append");
      expect(stepCollision?.losingValue).toBe("Base step guidance.");
      expect(stepCollision?.winningValue).toBe("Override step guidance.");
    });

    it("Detects_collisions_across_multiple_workflows", () => {
      const base = cfg(`
        workflow wf-a {
          version 1
          step s1 {
            name "S1"
            type autonomous
            agent shuttle
            prompt "Do A."
            completion agent_signal
          }
          prompt_append "Base A."
        }
        workflow wf-b {
          version 1
          step s1 {
            name "S1"
            type autonomous
            agent shuttle
            prompt "Do B."
            completion agent_signal
          }
          prompt_append "Base B."
        }
      `);
      const override = cfg(`
        workflow wf-a {
          version 1
          step s1 {
            name "S1"
            type autonomous
            agent shuttle
            prompt "Do A."
            completion agent_signal
          }
          prompt_append "Override A."
        }
        workflow wf-b {
          version 1
          step s1 {
            name "S1"
            type autonomous
            agent shuttle
            prompt "Do B."
            completion agent_signal
          }
          prompt_append "Override B."
        }
      `);

      const result = detectAppendCollisions([base, override]);

      expect(result).toHaveLength(2);
      const wfACollision = result.find((c) => c.workflowName === "wf-a");
      expect(wfACollision?.losingValue).toBe("Base A.");
      expect(wfACollision?.winningValue).toBe("Override A.");

      const wfBCollision = result.find((c) => c.workflowName === "wf-b");
      expect(wfBCollision?.losingValue).toBe("Base B.");
      expect(wfBCollision?.winningValue).toBe("Override B.");
    });
  });

  describe("no false positives", () => {
    it("Does_not_flag_collision_when_only_one_config_defines_append_for_a_workflow", () => {
      // base has no append; override has one — no collision
      const base = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
        }
      `);
      const override = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append "Only override has this."
        }
      `);

      const result = detectAppendCollisions([base, override]);
      expect(result).toEqual([]);
    });

    it("Does_not_flag_collision_when_different_fields_are_used_in_each_config", () => {
      // base uses prompt_append; override uses prompt_append_file — different fields, no collision
      const base = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append "Base inline guidance."
        }
      `);
      const override = cfg(`
        workflow my-wf {
          version 1
          step do-it {
            name "Do it"
            type autonomous
            agent shuttle
            prompt "Do the thing."
            completion agent_signal
          }
          prompt_append_file "override-guidance.md"
        }
      `);

      const result = detectAppendCollisions([base, override]);
      // prompt_append: only base defines it → no collision
      // prompt_append_file: only override defines it → no collision
      expect(result).toEqual([]);
    });
  });
});
