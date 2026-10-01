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

describe("eval run --models", () => {
  it("parses --models into evalModels", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "run",
      "--models",
      "dev",
    ]);

    expect(result._unsafeUnwrap().flags.evalModels).toBe("dev");
  });

  it("rejects --models with no value", () => {
    const result = parseArgs(["bun", "weave", "eval", "run", "--models"]);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "MissingFlagValue",
      flag: "--models",
    });
  });
});

describe("eval run --repeat", () => {
  it("parses --repeat into evalRepeat, as typed", () => {
    const result = parseArgs(["bun", "weave", "eval", "run", "--repeat", "3"]);

    expect(result._unsafeUnwrap().flags.evalRepeat).toBe("3");
  });

  it("rejects --repeat with no value", () => {
    const result = parseArgs(["bun", "weave", "eval", "run", "--repeat"]);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "MissingFlagValue",
      flag: "--repeat",
    });
  });
});

describe("eval run --track", () => {
  it("parses --track into evalTrack, as typed", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "run",
      "--track",
      "trajectory",
    ]);

    expect(result._unsafeUnwrap().flags.evalTrack).toBe("trajectory");
  });

  it("rejects --track with no value", () => {
    const result = parseArgs(["bun", "weave", "eval", "run", "--track"]);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "MissingFlagValue",
      flag: "--track",
    });
  });
});

describe("eval run --config", () => {
  it("parses --config into evalConfig, as typed", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "run",
      "--config",
      "project",
    ]);

    expect(result._unsafeUnwrap().flags.evalConfig).toBe("project");
  });

  it("rejects --config with no value", () => {
    const result = parseArgs(["bun", "weave", "eval", "run", "--config"]);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "MissingFlagValue",
      flag: "--config",
    });
  });
});

describe("eval compare", () => {
  it("parses the subcommand and keeps the two runs in order", () => {
    const parsed = parseArgs([
      "bun",
      "weave",
      "eval",
      "compare",
      "run-a",
      "eval-bundles/runs/run-b",
    ])._unsafeUnwrap();

    expect(parsed.flags.evalSubcommand).toBe("compare");
    expect(parsed.rest).toEqual(["run-a", "eval-bundles/runs/run-b"]);
  });
});

describe("eval compare-models", () => {
  it("parses the subcommand, the runs and the model flags", () => {
    const parsed = parseArgs([
      "bun",
      "weave",
      "eval",
      "compare-models",
      "run-a",
      "--current",
      "openai/gpt-6-luna",
      "--candidate",
      "openai/gpt-6-sol",
      "--min-repeats",
      "3",
      "--json",
    ])._unsafeUnwrap();

    expect(parsed.flags.evalSubcommand).toBe("compare-models");
    expect(parsed.rest).toEqual(["run-a"]);
    expect(parsed.flags.evalCurrent).toBe("openai/gpt-6-luna");
    expect(parsed.flags.evalCandidate).toBe("openai/gpt-6-sol");
    expect(parsed.flags.evalMinRepeats).toBe("3");
    expect(parsed.flags.json).toBe(true);
  });

  it("rejects --candidate with no value", () => {
    const result = parseArgs([
      "bun",
      "weave",
      "eval",
      "compare-models",
      "run-a",
      "--candidate",
    ]);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "MissingFlagValue",
      flag: "--candidate",
    });
  });
});

describe("eval reindex", () => {
  it("parses the subcommand and --dry-run", () => {
    const parsed = parseArgs([
      "bun",
      "weave",
      "eval",
      "reindex",
      "--dry-run",
    ])._unsafeUnwrap();

    expect(parsed.flags.evalSubcommand).toBe("reindex");
    expect(parsed.flags.dryRun).toBe(true);
  });
});

describe("models pin", () => {
  it("parses --include-qualified", () => {
    const parsed = parseArgs([
      "bun",
      "weave",
      "models",
      "pin",
      "--include-qualified",
      "--yes",
    ])._unsafeUnwrap();

    expect(parsed.flags.modelsSubcommand).toBe("pin");
    expect(parsed.flags.modelsIncludeQualified).toBe(true);
    expect(parsed.flags.yes).toBe(true);
  });
});

describe("models check", () => {
  it("parses the subcommand, the file and every flag", () => {
    const parsed = parseArgs([
      "bun",
      "weave",
      "models",
      "check",
      "models/stable.v1.json",
      "--envelope",
      "--key",
      "b5UhKwU8ugzt7BBcPCHCIXPMaGip85yid0l187r7c8Y=",
      "--expect",
      "models/stable.expect.json",
    ])._unsafeUnwrap();

    expect(parsed.command).toBe("models");
    expect(parsed.flags.modelsSubcommand).toBe("check");
    expect(parsed.flags.modelsEnvelope).toBe(true);
    expect(parsed.flags.modelsKey).toBe(
      "b5UhKwU8ugzt7BBcPCHCIXPMaGip85yid0l187r7c8Y=",
    );
    expect(parsed.flags.modelsExpect).toBe("models/stable.expect.json");
    expect(parsed.rest).toEqual(["models/stable.v1.json"]);
  });

  it("parses --issued-after", () => {
    const parsed = parseArgs([
      "bun",
      "weave",
      "models",
      "check",
      "f",
      "--issued-after",
      "2026-10-01T09:00:00Z",
    ])._unsafeUnwrap();
    expect(parsed.flags.modelsIssuedAfter).toBe("2026-10-01T09:00:00Z");
  });

  it.each([
    "--expect",
    "--key",
    "--issued-after",
  ])("rejects %s without a value", (flag) => {
    const parsed = parseArgs(["bun", "weave", "models", "check", "f", flag]);
    expect(parsed._unsafeUnwrapErr()).toMatchObject({
      type: "MissingFlagValue",
      flag,
    });
  });
});

describe("models status, update, apply and pin", () => {
  it.each([
    "status",
    "update",
    "apply",
    "pin",
  ] as const)("parses %s as a models subcommand", (subcommand) => {
    const parsed = parseArgs([
      "bun",
      "weave",
      "models",
      subcommand,
      "--harness",
      "pi",
      "--project-root",
      "/work",
      "--yes",
    ])._unsafeUnwrap();

    expect(parsed.command).toBe("models");
    expect(parsed.flags.modelsSubcommand).toBe(subcommand);
    expect(parsed.flags.harness).toBe("pi");
    expect(parsed.flags.projectRoot).toBe("/work");
    expect(parsed.flags.yes).toBe(true);
    expect(parsed.rest).toEqual([]);
  });
});
