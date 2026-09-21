/**
 * compose.test.ts
 *
 * `composeAgentDescriptor` is gone from this file: everything it promises a
 * user is visible in the agents a `.weave` config resolves to, and
 * `tests/dsl/` asserts it there — prompt sources and ordering, the template
 * language, delegation, categories, tool policy, and the descriptor fields an
 * adapter receives.
 *
 * What is left covers two exported functions with **no production caller**:
 *
 * - `composeWorkflowStepPrompt()` — the workflow-step append precedence rules
 *   from Spec 22. Workflow execution renders its step prompt through
 *   `renderTemplate()` in `execution-lifecycle/prompt-context.ts` and never
 *   calls this, so no workflow run exercises step-local precedence,
 *   workflow-scope fallback, or the append scope it reports.
 * - `detectAppendCollisions()` — surfaces a same-scope `prompt_append`
 *   collision across the merge stack for tooling that does not exist yet;
 *   nothing in the CLI, the config loader or any adapter calls it.
 *
 * Both are kept rather than deleted because that is a product decision, not a
 * testing one. See the no-caller findings in `docs/testing-strategy.md`.
 */

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WeaveConfig,
  WorkflowConfig,
  WorkflowStep,
} from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";

import {
  type AppendCollision,
  composeWorkflowStepPrompt,
  detectAppendCollisions,
} from "../compose.js";
import { buildTemplateContext } from "../template-context.js";
import { evaluateEffectiveToolPolicy } from "../tool-policy.js";

function cfg(source = ""): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

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

describe("composeWorkflowStepPrompt", () => {
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

  describe("step-local precedence", () => {
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
