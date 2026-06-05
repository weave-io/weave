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
  configLoader: () => ReturnType<NonNullable<Parameters<typeof runPrompt>[0]["configLoader"]>> =
    () => okAsync(testConfig),
) {
  const terminal = new BufferTerminal();
  return {
    terminal,
    ctx: {
      terminal,
      theme,
      flags: flags(overrides),
      configLoader,
    },
  };
}

describe("prompt command", () => {
  it("Should_show_usage_and_exit_1_when_no_subcommand", async () => {
    const { terminal, ctx } = context();

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("Usage: weave prompt <subcommand>");
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
    expect(terminal.err.join("\n")).toContain("Usage: weave prompt <subcommand>");
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
    const { terminal, ctx } = context(
      { promptSubcommand: "list" },
      () => errAsync(configErrors),
    );

    const result = await runPrompt(ctx);

    expect(result._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("/test/config.weave");
    expect(terminal.err.join("\n")).toContain("could not read config");
  });
});
