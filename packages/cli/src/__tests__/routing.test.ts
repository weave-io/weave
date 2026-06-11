import { describe, expect, it } from "bun:test";
import { run } from "../cli.js";
import { BufferTerminal } from "../io/terminal.js";

function cli(args: string[]) {
  const terminal = new BufferTerminal();
  const argv = ["bun", "weave", ...args];
  return { terminal, result: run({ argv, terminal, colorEnabled: false }) };
}

describe("CLI routing", () => {
  it("Should_exit_0_and_list_init_and_validate_for_help", async () => {
    const { terminal, result } = cli(["--help"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("init");
    expect(out).toContain("validate");
  });

  it("Should_treat_h_as_an_alias_for_help", async () => {
    const { terminal, result } = cli(["-h"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("COMMANDS");
  });

  it("Should_show_help_when_no_arguments_are_provided", async () => {
    const { terminal, result } = cli([]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("USAGE");
  });

  it("Should_exit_0_and_print_version_for_version", async () => {
    const { terminal, result } = cli(["--version"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("Should_treat_v_as_an_alias_for_version", async () => {
    const { terminal, result } = cli(["-V"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("Should_exit_1_with_error_message_for_unknown_command", async () => {
    const { terminal, result } = cli(["frobnicate"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(1);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("frobnicate");
    expect(errOut).toContain("Unknown command");
  });

  it("Should_exit_1_with_product_vision_message_for_run_command", async () => {
    const { terminal, result } = cli(["run"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(1);
    const errOut = terminal.err.join("\n");
    expect(errOut).toContain("does not run harness runtimes");
    expect(errOut).toContain("weave init");
  });

  it("Should_allow_help_to_override_a_command", async () => {
    const { terminal, result } = cli(["validate", "--help"]);
    const r = await result;
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    const out = terminal.out.join("\n");
    expect(out).toContain("COMMANDS");
  });

  it("Should_include_examples_section_in_help_output", async () => {
    const { terminal, result } = cli(["--help"]);
    await result;
    const out = terminal.out.join("\n");
    expect(out).toContain("EXAMPLES");
    expect(out).toContain("weave init");
    expect(out).toContain("weave validate");
  });

  it("Should_not_show_unknown_command_for_prompt", async () => {
    const { terminal, result } = cli(["prompt"]);

    const r = await result;

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).not.toContain("Unknown command");
  });

  it("Should_show_usage_for_bare_prompt_command", async () => {
    const { terminal, result } = cli(["prompt"]);

    const r = await result;
    const combinedOutput = [...terminal.out, ...terminal.err].join("\n");

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(1);
    expect(combinedOutput).toContain("weave prompt inspect");
  });

  it("Should_dispatch_prompt_list_without_unknown_command_error", async () => {
    const { terminal, result } = cli(["prompt", "list"]);

    const r = await result;

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    expect(terminal.err.join("\n")).not.toContain("Unknown command");
  });

  it("Should_dispatch_prompt_self_modify_without_unknown_command_error", async () => {
    const { terminal, result } = cli(["prompt", "self-modify"]);

    const r = await result;

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    expect(terminal.err.join("\n")).not.toContain("Unknown command");
  });

  it("Should_include_self_modify_in_bare_prompt_usage", async () => {
    const { terminal, result } = cli(["prompt"]);

    await result;
    const combinedOutput = [...terminal.out, ...terminal.err].join("\n");

    expect(combinedOutput).toContain("self-modify");
  });

  it("Should_include_prompt_self_modify_in_top_level_help", async () => {
    const { terminal, result } = cli(["--help"]);

    await result;
    const out = terminal.out.join("\n");

    expect(out).toContain("prompt self-modify");
  });

  it("Should_exit_0_for_prompt_self_modify_with_explicit_global_scope", async () => {
    const { terminal, result } = cli([
      "prompt",
      "self-modify",
      "--scope",
      "global",
    ]);

    const r = await result;

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    expect(terminal.err.join("\n")).not.toContain("Unknown command");
    expect(terminal.out.join("\n")).toContain("global (~/.weave/)");
  });

  it("Should_exit_0_for_prompt_self_modify_with_local_scope", async () => {
    const { terminal, result } = cli([
      "prompt",
      "self-modify",
      "--scope",
      "local",
    ]);

    const r = await result;

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(0);
    expect(terminal.err.join("\n")).not.toContain("Unknown command");
    expect(terminal.out.join("\n")).toContain("local (.weave/)");
  });

  it("Should_exit_1_and_write_error_to_stderr_for_prompt_self_modify_with_json_flag", async () => {
    const { terminal, result } = cli(["prompt", "self-modify", "--json"]);

    const r = await result;

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain("does not support --json");
    expect(terminal.out).toHaveLength(0);
  });

  it("Should_exit_1_and_write_error_to_stderr_for_prompt_self_modify_with_extra_arg", async () => {
    const { terminal, result } = cli([
      "prompt",
      "self-modify",
      "unexpected-arg",
    ]);

    const r = await result;

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(1);
    expect(terminal.err.join("\n")).toContain(
      "does not accept extra arguments",
    );
    expect(terminal.err.join("\n")).toContain("unexpected-arg");
    expect(terminal.out).toHaveLength(0);
  });

  it("Should_include_scope_flag_hint_in_bare_prompt_self_modify_usage", async () => {
    const { terminal, result } = cli(["prompt"]);

    await result;
    const combinedOutput = [...terminal.out, ...terminal.err].join("\n");

    expect(combinedOutput).toContain("--scope");
  });
});
