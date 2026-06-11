import { describe, expect, it } from "bun:test";
import type { ConfigLoadError } from "@weave/config";
import type { WeaveConfig } from "@weave/core";
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
