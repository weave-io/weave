import { describe, expect, it } from "bun:test";
import type { ConfigLoadError } from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import { errAsync, okAsync } from "neverthrow";
import type { ParsedArgs } from "../../args.js";
import { BufferTerminal } from "../../io/terminal.js";
import { ThemeManager } from "../../theme/colors.js";
import { runPrompt } from "../prompt.js";

const themeManager = new ThemeManager({ isTty: () => false });
const theme = themeManager.getTheme(false);

const testConfig: WeaveConfig = {
  agents: {
    "test-agent": {
      prompt: "You are {{agent.name}}.",
      models: ["test-model"],
      mode: "subagent",
    },
  },

  categories: {
    backend: {
      description: "Backend category",
      models: ["test-model"],
      patterns: ["src/api/**"],
      temperature: 0.2,
    },
  },
  workflows: {},
  disabled: { agents: [], hooks: [], skills: [] },
  settings: { log_level: "INFO", runtime: { journal: { strict: false } } },
  extend_before_plan: { steps: [] },
};

function flags(
  overrides: Partial<ParsedArgs["flags"]> = {},
): ParsedArgs["flags"] {
  return {
    help: false,
    version: false,
    json: false,
    yes: false,
    force: false,
    allHarnesses: false,
    project: false,
    global: false,
    ...overrides,
  };
}

function context(
  overrides: Partial<ParsedArgs["flags"]> = {},
  configLoader: () => ReturnType<
    NonNullable<Parameters<typeof runPrompt>[0]["configLoader"]>
  > = () => okAsync(testConfig),
  rest: string[] = [],
  cwd?: string,
) {
  const terminal = new BufferTerminal();
  return {
    terminal,
    ctx: {
      terminal,
      theme,
      flags: flags(overrides),
      rest,
      configLoader,
      ...(cwd !== undefined ? { cwd } : {}),
    },
  };
}

describe("prompt command", () => {
  it("Should_show_usage_and_exit_1_when_no_subcommand", async () => {
    const { terminal, ctx } = context();

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain(
      "Usage: weave prompt <subcommand>",
    );
    expect(terminal.out).toHaveLength(0);
  });

  it("Should_list_agent_names_plain_when_subcommand_is_list", async () => {
    const { terminal, ctx } = context({ promptSubcommand: "list" });

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const outputLines = terminal.out.join("\n").split("\n").filter(Boolean);
    expect(outputLines).toContain("test-agent");

    if (outputLines.includes("shuttle-backend")) {
      expect(outputLines).toContain("shuttle-backend");
    }
  });

  it("Should_list_agents_as_json_when_list_and_json_flag", async () => {
    const { terminal, ctx } = context({ promptSubcommand: "list", json: true });

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const parsed = JSON.parse(terminal.out.join("\n")) as {
      agents: Array<{ name: string }>;
    };
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(parsed.agents.map((agent) => agent.name)).toContain("test-agent");
  });

  it("Should_inspect_and_output_composed_prompt", async () => {
    const { terminal, ctx } = context({
      promptSubcommand: "inspect",
      agentName: "test-agent",
    });

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    expect(terminal.out.join("\n")).toContain("You are test-agent.");
  });

  it("Should_inspect_and_output_json_when_json_flag", async () => {
    const { terminal, ctx } = context({
      promptSubcommand: "inspect",
      agentName: "test-agent",
      json: true,
    });

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(0);
    const parsed = JSON.parse(terminal.out.join("\n")) as {
      composedPrompt: string;
      name: string;
    };
    expect(parsed.name).toBe("test-agent");
    expect(parsed.composedPrompt).toBe("You are test-agent.");
  });

  it("Should_exit_1_with_agent_not_found_error", async () => {
    const { terminal, ctx } = context({
      promptSubcommand: "inspect",
      agentName: "unknown-agent",
    });

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("unknown-agent");
  });

  it("Should_exit_1_when_inspect_has_no_agent_name", async () => {
    const { terminal, ctx } = context({ promptSubcommand: "inspect" });

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain(
      "Usage: weave prompt <subcommand>",
    );
    expect(terminal.out).toHaveLength(0);
  });

  it("Should_exit_1_on_config_load_failure", async () => {
    const configErrors: ConfigLoadError[] = [
      {
        type: "FileReadError",
        path: "/test/config.weave",
        cause: new Error("boom"),
      },
    ];
    const { terminal, ctx } = context({ promptSubcommand: "list" }, () =>
      errAsync(configErrors),
    );

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("/test/config.weave");
    expect(terminal.err.join("\n")).toContain("could not read config");
  });

  describe("review variant agents", () => {
    const reviewConfig: WeaveConfig = {
      agents: {
        weft: {
          prompt: "You are {{agent.name}}.",
          models: ["model-a"],
          mode: "primary",
          review_models: ["openai/gpt-5", "anthropic/claude-4"],
        },
      },
      categories: {},
      workflows: {},
      disabled: { agents: [], hooks: [], skills: [] },
      settings: { log_level: "INFO", runtime: { journal: { strict: false } } },
      extend_before_plan: { steps: [] },
    };

    it("Should_include_review_variant_agents_in_prompt_list", async () => {
      const { terminal, ctx } = context({ promptSubcommand: "list" }, () =>
        okAsync(reviewConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toContain("weft-openai-gpt-5");
      expect(output).toContain("weft-anthropic-claude-4");
    });

    it("Should_include_review_variant_agents_in_json_list", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "list", json: true },
        () => okAsync(reviewConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const parsed = JSON.parse(terminal.out.join("\n")) as {
        agents: Array<{ name: string }>;
      };
      const names = parsed.agents.map((a) => a.name);
      expect(names).toContain("weft-openai-gpt-5");
      expect(names).toContain("weft-anthropic-claude-4");
    });

    it("Should_inspect_review_variant_agent_and_output_prompt", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "inspect", agentName: "weft-openai-gpt-5" },
        () => okAsync(reviewConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      expect(terminal.out.join("\n")).toContain("You are weft-openai-gpt-5.");
    });

    it("Should_exclude_disabled_review_variant_agents_from_list", async () => {
      const configWithDisabled: WeaveConfig = {
        ...reviewConfig,
        disabled: {
          agents: ["weft-openai-gpt-5"],
          hooks: [],
          skills: [],
        },
      };
      const { terminal, ctx } = context({ promptSubcommand: "list" }, () =>
        okAsync(configWithDisabled),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).not.toContain("weft-openai-gpt-5");
      expect(output).toContain("weft-anthropic-claude-4");
    });

    it("Should_exit_1_with_clear_error_when_review_variant_conflicts_with_explicit_agent_on_list", async () => {
      // "weft-openai-gpt-5" is both an explicit agent and would be generated
      // as a review variant for "weft" + "openai/gpt-5". buildCombinedAgents must
      // surface this as an error rather than returning partial/misleading output.
      const conflictConfig: WeaveConfig = {
        agents: {
          weft: {
            prompt: "You are {{agent.name}}.",
            models: ["model-a"],
            mode: "primary",
            review_models: ["openai/gpt-5"],
          },
          "weft-openai-gpt-5": {
            prompt: "I am an explicit agent that collides.",
            models: ["model-b"],
            mode: "subagent",
          },
        },
        categories: {},
        workflows: {},
        disabled: { agents: [], hooks: [], skills: [] },
        settings: {
          log_level: "INFO",
          runtime: { journal: { strict: false } },
        },
        extend_before_plan: { steps: [] },
      };
      const { terminal, ctx } = context({ promptSubcommand: "list" }, () =>
        okAsync(conflictConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(1);
      const errOutput = terminal.err.join("\n");
      expect(errOutput).toContain("weft-openai-gpt-5");
      expect(terminal.out).toHaveLength(0);
    });

    it("Should_exit_1_with_clear_error_when_review_variant_conflicts_with_explicit_agent_on_inspect", async () => {
      const conflictConfig: WeaveConfig = {
        agents: {
          weft: {
            prompt: "You are {{agent.name}}.",
            models: ["model-a"],
            mode: "primary",
            review_models: ["openai/gpt-5"],
          },
          "weft-openai-gpt-5": {
            prompt: "I am an explicit agent that collides.",
            models: ["model-b"],
            mode: "subagent",
          },
        },
        categories: {},
        workflows: {},
        disabled: { agents: [], hooks: [], skills: [] },
        settings: {
          log_level: "INFO",
          runtime: { journal: { strict: false } },
        },
        extend_before_plan: { steps: [] },
      };
      const { terminal, ctx } = context(
        { promptSubcommand: "inspect", agentName: "weft" },
        () => okAsync(conflictConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(1);
      const errOutput = terminal.err.join("\n");
      expect(errOutput).toContain("weft-openai-gpt-5");
      expect(terminal.out).toHaveLength(0);
    });
  });

  describe("review routing in composed prompt", () => {
    // loom-like primary agent with {{#reviewRouting}} in its inline prompt,
    // weft as a delegation target, weft has review_models.
    const reviewRoutingPrompt = [
      "# {{agent.name}}",
      "{{#reviewRouting}}",
      "## Adversarial Review Routing",
      "{{#groups}}",
      "### {{sourceAgent}}",
      "Run all of the following reviewers:",
      "- `{{sourceAgent}}` (base reviewer)",
      "{{#variants}}",
      "- `{{name}}` (model: {{{model}}})",
      "{{/variants}}",
      "{{/groups}}",
      "**Rules:**",
      "- Always run the base reviewer AND all listed variants. Do not replace the base reviewer with a variant.",
      "{{/reviewRouting}}",
    ].join("\n");

    const reviewRoutingConfig: WeaveConfig = {
      agents: {
        loom: {
          prompt: reviewRoutingPrompt,
          models: ["orchestrator-model"],
          mode: "primary",
          tool_policy: { delegate: "allow" },
        },
        tapestry: {
          prompt: reviewRoutingPrompt,
          models: ["orchestrator-model"],
          mode: "primary",
          tool_policy: { delegate: "allow" },
        },
        weft: {
          prompt: "You are {{agent.name}}.",
          models: ["model-a"],
          mode: "subagent",
          review_models: ["openai/gpt-5", "anthropic/claude-4"],
        },
        warp: {
          prompt: "You are {{agent.name}}.",
          models: ["model-b"],
          mode: "subagent",
          review_models: ["github-copilot/gpt-5.5"],
        },
      },
      categories: {},
      workflows: {},
      disabled: { agents: [], hooks: [], skills: [] },
      settings: { log_level: "INFO", runtime: { journal: { strict: false } } },
      extend_before_plan: { steps: [] },
    };

    it("Should_include_Adversarial_Review_Routing_in_loom_when_review_models_configured", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "inspect", agentName: "loom" },
        () => okAsync(reviewRoutingConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toContain("Adversarial Review Routing");
      expect(output).toContain("weft-openai-gpt-5");
      expect(output).toContain("weft-anthropic-claude-4");
    });

    it("Should_include_Adversarial_Review_Routing_in_tapestry_when_review_models_configured", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "inspect", agentName: "tapestry" },
        () => okAsync(reviewRoutingConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toContain("Adversarial Review Routing");
      expect(output).toContain("weft-openai-gpt-5");
      expect(output).toContain("weft-anthropic-claude-4");
    });

    it("Should_not_include_Adversarial_Review_Routing_in_loom_when_no_review_models", async () => {
      const configNoReview: WeaveConfig = {
        agents: {
          loom: {
            prompt: reviewRoutingPrompt,
            models: ["orchestrator-model"],
            mode: "primary",
          },
          weft: {
            prompt: "You are {{agent.name}}.",
            models: ["model-a"],
            mode: "subagent",
            // no review_models
          },
        },
        categories: {},
        workflows: {},
        disabled: { agents: [], hooks: [], skills: [] },
        settings: {
          log_level: "INFO",
          runtime: { journal: { strict: false } },
        },
        extend_before_plan: { steps: [] },
      };
      const { terminal, ctx } = context(
        { promptSubcommand: "inspect", agentName: "loom" },
        () => okAsync(configNoReview),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).not.toContain("Adversarial Review Routing");
    });

    it("Should_include_correct_variant_names_and_source_agent_names_in_review_routing", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "inspect", agentName: "loom" },
        () => okAsync(reviewRoutingConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      // Source agent name
      expect(output).toContain("weft");
      // Variant names
      expect(output).toContain("weft-openai-gpt-5");
      expect(output).toContain("weft-anthropic-claude-4");
    });

    it("Should_include_base_reviewer_alongside_variants_for_weft", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "inspect", agentName: "loom" },
        () => okAsync(reviewRoutingConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      // Base reviewer must appear as its own entry
      expect(output).toContain("`weft` (base reviewer)");
      // Variants must also appear
      expect(output).toContain("weft-openai-gpt-5");
      expect(output).toContain("weft-anthropic-claude-4");
      // Rules text
      expect(output).toContain("base reviewer AND all listed variants");
    });

    it("Should_include_base_reviewer_alongside_variants_for_warp", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "inspect", agentName: "loom" },
        () => okAsync(reviewRoutingConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      // Base warp reviewer must appear
      expect(output).toContain("`warp` (base reviewer)");
      // Variant must also appear (github-copilot/gpt-5.5 → github-copilot-gpt-5-5)
      expect(output).toContain("warp-github-copilot-gpt-5-5");
    });

    it("Should_render_model_names_without_HTML_escaping", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "inspect", agentName: "loom" },
        () => okAsync(reviewRoutingConfig),
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      // Model names with slashes must NOT be HTML-escaped
      expect(output).toContain("github-copilot/gpt-5.5");
      expect(output).not.toContain("github-copilot&#x2F;gpt-5.5");
      expect(output).not.toContain("github-copilot&amp;");
    });
  });

  describe("self-modify subcommand", () => {
    it("Should_succeed_without_calling_configLoader", async () => {
      // configLoader always fails — self-modify must not call it
      const failingLoader = () => errAsync([] as ConfigLoadError[]);
      const { terminal, ctx } = context(
        { promptSubcommand: "self-modify" },
        failingLoader,
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      expect(terminal.out.join("\n")).toContain(
        "Weave Self-Modification Guide",
      );
      expect(terminal.err).toHaveLength(0);
    });

    it("Should_default_scope_to_global_when_no_scope_flag", async () => {
      const { terminal, ctx } = context({ promptSubcommand: "self-modify" });

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toContain("global (~/.weave/)");
      expect(output).toContain(".weave/config.weave");
    });

    it("Should_include_global_config_path_in_stdout", async () => {
      const { terminal, ctx } = context({ promptSubcommand: "self-modify" });

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      // Full path must appear — not just a partial fragment
      expect(output).toMatch(/\.weave[/\\]config\.weave/);
      expect(output).toMatch(/\.weave[/\\]prompts/);
    });

    it("Should_include_doc_references_in_global_scope_stdout", async () => {
      const { terminal, ctx } = context({ promptSubcommand: "self-modify" });

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toContain("docs/dsl-reference.md");
      expect(output).toContain("docs/config-loading.md");
      expect(output).toContain("docs/prompt-composition.md");
    });

    it("Should_use_explicit_global_scope_when_scope_flag_is_global", async () => {
      const { terminal, ctx } = context({
        promptSubcommand: "self-modify",
        scope: "global",
      });

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toContain("global (~/.weave/)");
      expect(output).toContain("all projects");
    });

    it("Should_use_local_scope_when_scope_flag_is_local", async () => {
      const { terminal, ctx } = context({
        promptSubcommand: "self-modify",
        scope: "local",
      });

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toContain("local (.weave/)");
    });

    it("Should_include_local_config_path_in_stdout", async () => {
      const { terminal, ctx } = context({
        promptSubcommand: "self-modify",
        scope: "local",
      });

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toMatch(/\.weave[/\\]config\.weave/);
      expect(output).toMatch(/\.weave[/\\]prompts/);
    });

    it("Should_include_doc_references_in_local_scope_stdout", async () => {
      const { terminal, ctx } = context({
        promptSubcommand: "self-modify",
        scope: "local",
      });

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toContain("docs/dsl-reference.md");
      expect(output).toContain("docs/config-loading.md");
      expect(output).toContain("docs/prompt-composition.md");
    });

    it("Should_use_injected_cwd_for_local_scope_paths", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "self-modify", scope: "local" },
        () => okAsync(testConfig),
        [],
        "/injected/project/root",
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(0);
      const output = terminal.out.join("\n");
      expect(output).toContain("/injected/project/root");
    });

    it("Should_exit_1_and_reject_json_flag", async () => {
      const { terminal, ctx } = context({
        promptSubcommand: "self-modify",
        json: true,
      });

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(1);
      expect(terminal.err.join("\n")).toContain("does not support --json");
      expect(terminal.out).toHaveLength(0);
    });

    it("Should_write_json_rejection_to_stderr_not_stdout", async () => {
      const { terminal, ctx } = context({
        promptSubcommand: "self-modify",
        json: true,
      });

      await runPrompt(ctx);

      // Error must be on stderr only — stdout must be empty
      expect(terminal.out).toHaveLength(0);
      expect(terminal.err.join("\n")).toContain("--json");
    });

    it("Should_exit_1_when_unexpected_rest_args_are_present", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "self-modify" },
        () => okAsync(testConfig),
        ["unexpected-arg"],
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(1);
      expect(terminal.err.join("\n")).toContain(
        "does not accept extra arguments",
      );
      expect(terminal.err.join("\n")).toContain("unexpected-arg");
      expect(terminal.out).toHaveLength(0);
    });

    it("Should_write_extra_args_rejection_to_stderr_not_stdout", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "self-modify" },
        () => okAsync(testConfig),
        ["some-object"],
      );

      await runPrompt(ctx);

      // Error must be on stderr only — stdout must be empty
      expect(terminal.out).toHaveLength(0);
      expect(terminal.err.join("\n")).toContain("some-object");
    });

    it("Should_include_multiple_extra_args_in_rejection_message", async () => {
      const { terminal, ctx } = context(
        { promptSubcommand: "self-modify" },
        () => okAsync(testConfig),
        ["arg1", "arg2"],
      );

      const result = await runPrompt(ctx);

      expect(result._unsafeUnwrap()).toBe(1);
      const errOutput = terminal.err.join("\n");
      expect(errOutput).toContain("arg1");
      expect(errOutput).toContain("arg2");
    });
  });
});
