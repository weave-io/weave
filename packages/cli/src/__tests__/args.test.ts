import { describe, expect, it } from "bun:test";
import { parseArgs } from "../args.js";

describe("prompt command", () => {
  it("Should_parse_prompt_inspect_with_agent_name", () => {
    const result = parseArgs(["bun", "weave", "prompt", "inspect", "loom"]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "prompt",
      flags: { promptSubcommand: "inspect", agentName: "loom" },
    });
  });

  it("Should_parse_prompt_list", () => {
    const result = parseArgs(["bun", "weave", "prompt", "list"]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "prompt",
      flags: { promptSubcommand: "list" },
    });
  });

  it("Should_parse_prompt_inspect_with_agent_name_and_json", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "prompt",
      "inspect",
      "loom",
      "--json",
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "prompt",
      flags: {
        promptSubcommand: "inspect",
        agentName: "loom",
        json: true,
      },
    });
  });

  it("Should_parse_prompt_without_subcommand", () => {
    const result = parseArgs(["bun", "weave", "prompt"]);

    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("prompt");
    expect(parsed.flags.promptSubcommand).toBeUndefined();
    expect(parsed.flags.agentName).toBeUndefined();
  });

  it("Should_parse_prompt_inspect_without_agent_name", () => {
    const result = parseArgs(["bun", "weave", "prompt", "inspect"]);

    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("prompt");
    expect(parsed.flags.promptSubcommand).toBe("inspect");
    expect(parsed.flags.agentName).toBeUndefined();
  });

  it("Should_parse_prompt_inspect_with_hyphenated_agent_name", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "prompt",
      "inspect",
      "shuttle-backend",
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "prompt",
      flags: { promptSubcommand: "inspect", agentName: "shuttle-backend" },
    });
  });
});

describe("prompt self-modify subcommand", () => {
  it("Should_parse_prompt_self_modify", () => {
    const result = parseArgs(["bun", "weave", "prompt", "self-modify"]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "prompt",
      flags: { promptSubcommand: "self-modify" },
    });
  });

  it("Should_parse_prompt_self_modify_with_scope_global", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "prompt",
      "self-modify",
      "--scope",
      "global",
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "prompt",
      flags: { promptSubcommand: "self-modify", scope: "global" },
    });
  });

  it("Should_parse_prompt_self_modify_with_scope_local", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "prompt",
      "self-modify",
      "--scope",
      "local",
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "prompt",
      flags: { promptSubcommand: "self-modify", scope: "local" },
    });
  });

  it("Should_error_on_missing_scope_value", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "prompt",
      "self-modify",
      "--scope",
    ]);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("MissingFlagValue");
    expect(error.flag).toBe("--scope");
  });

  it("Should_error_on_invalid_scope_value", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "prompt",
      "self-modify",
      "--scope",
      "project",
    ]);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("InvalidFlagValue");
    expect(error.flag).toBe("--scope");
    expect(error.message).toContain("project");
  });

  it("Should_capture_extra_positionals_in_rest", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "prompt",
      "self-modify",
      "--scope",
      "global",
      "extra-arg",
      "another",
    ]);

    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.flags.promptSubcommand).toBe("self-modify");
    expect(parsed.flags.scope).toBe("global");
    expect(parsed.rest).toEqual(["extra-arg", "another"]);
  });
});

describe("eval command parsing", () => {
  it("Should_parse_eval_run_subcommand", () => {
    const result = parseArgs(["bun", "weave", "eval", "run"]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "eval",
      flags: { evalSubcommand: "run" },
    });
  });

  it("Should_parse_eval_without_subcommand", () => {
    const result = parseArgs(["bun", "weave", "eval"]);

    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.command).toBe("eval");
    expect(parsed.flags.evalSubcommand).toBeUndefined();
  });

  it("Should_parse_eval_run_with_agent_flag", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "run",
      "--agent",
      "loom",
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "eval",
      flags: { evalSubcommand: "run", evalAgent: "loom" },
    });
  });

  it("Should_parse_eval_run_with_model_flag", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "run",
      "--model",
      "claude-sonnet-4-5",
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "eval",
      flags: { evalSubcommand: "run", evalModel: "claude-sonnet-4-5" },
    });
  });

  it("Should_parse_eval_run_with_case_flag", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "run",
      "--case",
      "case-01",
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "eval",
      flags: { evalSubcommand: "run", evalCase: "case-01" },
    });
  });

  it("Should_parse_eval_run_with_dry_run_flag", () => {
    const result = parseArgs(["bun", "weave", "eval", "run", "--dry-run"]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "eval",
      flags: { evalSubcommand: "run", dryRun: true },
    });
  });

  it("Should_parse_eval_run_with_raw_artifacts_flag", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "run",
      "--raw-artifacts",
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "eval",
      flags: { evalSubcommand: "run", rawArtifacts: true },
    });
  });

  it("Should_parse_eval_run_with_all_filters", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "run",
      "--agent",
      "shuttle",
      "--model",
      "gpt-4o",
      "--case",
      "smoke",
      "--dry-run",
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "eval",
      flags: {
        evalSubcommand: "run",
        evalAgent: "shuttle",
        evalModel: "gpt-4o",
        evalCase: "smoke",
        dryRun: true,
      },
    });
  });

  it("Should_default_dryRun_to_false_when_not_specified", () => {
    const result = parseArgs(["bun", "weave", "eval", "run"]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().flags.dryRun).toBe(false);
  });

  it("Should_default_rawArtifacts_to_false_when_not_specified", () => {
    const result = parseArgs(["bun", "weave", "eval", "run"]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().flags.rawArtifacts).toBe(false);
  });

  it("Should_return_error_for_missing_agent_value", () => {
    const result = parseArgs(["bun", "weave", "eval", "run", "--agent"]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("MissingFlagValue");
    expect(e.flag).toBe("--agent");
  });

  it("Should_return_error_for_missing_model_value", () => {
    const result = parseArgs(["bun", "weave", "eval", "run", "--model"]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("MissingFlagValue");
    expect(e.flag).toBe("--model");
  });

  it("Should_return_error_for_missing_case_value", () => {
    const result = parseArgs(["bun", "weave", "eval", "run", "--case"]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("MissingFlagValue");
    expect(e.flag).toBe("--case");
  });

  it("Should_not_mistake_next_flag_as_agent_value", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "run",
      "--agent",
      "--dry-run",
    ]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("MissingFlagValue");
  });
});

describe("existing commands remain unaffected", () => {
  it("Should_keep_unknown_command_parsing_unchanged", () => {
    const result = parseArgs(["bun", "weave", "frobnicate"]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      command: "unknown",
      unknownCommand: "frobnicate",
    });
  });
});
