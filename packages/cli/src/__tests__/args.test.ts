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
