import { type ConfigLoadError, loadConfig } from "@weaveio/weave-config";
import { formatError, type WeaveConfig } from "@weaveio/weave-core";
import {
  type AgentDescriptor,
  type MaterializationPlan,
  materializeAgents,
} from "@weaveio/weave-engine";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { ParsedArgs } from "../args.js";
import { type CliError, formatCliError } from "../errors.js";
import type { TerminalIO } from "../io/terminal.js";
import { renderSelfModifyPrompt } from "../prompts/self-modify.js";
import type { ThemeColors } from "../theme/colors.js";

const PROMPT_USAGE = [
  "Usage: weave prompt <subcommand>",
  "",
  "  weave prompt inspect <agent>         Render the composed prompt for an agent",
  "  weave prompt inspect <agent> --json  Output prompt + metadata as JSON",
  "  weave prompt list                    List all available agent names",
  "  weave prompt list --json             List agents as JSON",
  "  weave prompt self-modify             Print the Weave self-modification guide",
  "  weave prompt self-modify --scope global|local",
].join("\n");

export interface PromptContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  /** Extra positional arguments after the subcommand (from ParsedArgs.rest). */
  rest?: string[];
  /** Injectable for testing. Defaults to loadConfig(process.cwd()). */
  configLoader?: () => ResultAsync<WeaveConfig, ConfigLoadError[]>;
  /** Current working directory. Defaults to process.cwd(). */
  cwd?: string;
}

type PromptError = CliError;

type PromptInspectJson = {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  models: string[];
  temperature?: number;
  effectiveToolPolicy: {
    read: "allow" | "deny" | "ask";
    write: "allow" | "deny" | "ask";
    execute: "allow" | "deny" | "ask";
    delegate: "allow" | "deny" | "ask";
    network: "allow" | "deny" | "ask";
  };
  skills: string[];
  delegationTargets: string[];
  composedPrompt: string;
};

function mapConfigLoadErrors(
  cwd: string,
  errors: ConfigLoadError[],
): PromptError {
  return {
    type: "ParseFailure",
    path: cwd,
    errors: errors.flatMap((error) => {
      if (error.type === "FileReadError") {
        return [`${error.path}: could not read config`];
      }

      if (error.type === "BuiltinParseError") {
        return error.errors.map(
          (parseError) => `builtins:${formatError(parseError)}`,
        );
      }

      if (error.type === "MergeError") {
        return error.errors.map(
          (mergeError) => `merge:${mergeError.type}:${mergeError.error.type}`,
        );
      }

      return error.errors.map(
        (parseError) => `${error.path}:${formatError(parseError)}`,
      );
    }),
  };
}

function loadPromptConfig(
  ctx: PromptContext,
): ResultAsync<WeaveConfig, PromptError> {
  const cwd = ctx.cwd ?? process.cwd();
  const configLoader = ctx.configLoader ?? (() => loadConfig(cwd));
  return configLoader().mapErr((errors) => mapConfigLoadErrors(cwd, errors));
}

async function getMaterializationPlan(
  config: WeaveConfig,
): Promise<Result<MaterializationPlan, CliError>> {
  const plan = (await materializeAgents({ config }))._unsafeUnwrap();

  // Surface the first conflict error as a CLI error — duplicate agent names are
  // unrecoverable from a user perspective.
  const conflictError = plan.errors.find(
    (e) =>
      e.type === "ReviewVariantConflict" ||
      e.type === "CategoryShuttleConflict",
  );
  if (conflictError !== undefined) {
    return err<MaterializationPlan, CliError>({
      type: "InvalidArgs",
      message: conflictError.conflict.message,
    });
  }

  return ok(plan);
}

function toInspectJson(descriptor: AgentDescriptor): PromptInspectJson {
  return {
    name: descriptor.name,
    description: descriptor.description,
    mode: descriptor.mode,
    models: descriptor.models,
    temperature: descriptor.temperature,
    effectiveToolPolicy: descriptor.effectiveToolPolicy,
    skills: descriptor.skills,
    delegationTargets: descriptor.delegationTargets.map(
      (target) => target.name,
    ),
    composedPrompt: descriptor.composedPrompt,
  };
}

async function runPromptList(
  ctx: PromptContext,
): Promise<Result<number, CliError>> {
  const configResult = await loadPromptConfig(ctx);

  if (configResult.isErr()) {
    ctx.terminal.stderr(formatCliError(configResult.error));
    return ok(1);
  }

  const planResult = await getMaterializationPlan(configResult.value);
  if (planResult.isErr()) {
    ctx.terminal.stderr(formatCliError(planResult.error));
    return ok(1);
  }

  const agents = planResult.value.agents
    .map((agent) => ({
      name: agent.agentName,
      description: agent.descriptor.description,
      mode: agent.descriptor.mode,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (ctx.flags.json) {
    ctx.terminal.stdout(JSON.stringify({ agents }, null, 2));
    return ok(0);
  }

  ctx.terminal.stdout(agents.map((agent) => agent.name).join("\n"));
  return ok(0);
}

async function runPromptInspect(
  ctx: PromptContext,
): Promise<Result<number, CliError>> {
  if (ctx.flags.agentName === undefined) {
    ctx.terminal.stderr(PROMPT_USAGE);
    return ok(1);
  }

  const configResult = await loadPromptConfig(ctx);
  if (configResult.isErr()) {
    ctx.terminal.stderr(formatCliError(configResult.error));
    return ok(1);
  }

  const planResult = await getMaterializationPlan(configResult.value);
  if (planResult.isErr()) {
    ctx.terminal.stderr(formatCliError(planResult.error));
    return ok(1);
  }

  const requestedAgent = planResult.value.agents.find(
    (a) => a.agentName === ctx.flags.agentName,
  );

  if (requestedAgent === undefined) {
    ctx.terminal.stderr(
      formatCliError({
        type: "AgentNotFound",
        agentName: ctx.flags.agentName,
        message: `Agent "${ctx.flags.agentName}" was not found.`,
      }),
    );
    return ok(1);
  }

  if (ctx.flags.json) {
    ctx.terminal.stdout(
      JSON.stringify(toInspectJson(requestedAgent.descriptor), null, 2),
    );
    return ok(0);
  }

  ctx.terminal.stdout(requestedAgent.descriptor.composedPrompt);
  return ok(0);
}

async function runPromptSelfModify(
  ctx: PromptContext,
): Promise<Result<number, CliError>> {
  if (ctx.flags.json) {
    ctx.terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message: "'weave prompt self-modify' does not support --json",
      }),
    );
    return ok(1);
  }

  if (ctx.rest !== undefined && ctx.rest.length > 0) {
    ctx.terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message: `'weave prompt self-modify' does not accept extra arguments: ${ctx.rest.join(" ")}`,
      }),
    );
    return ok(1);
  }

  const scope = ctx.flags.scope ?? "global";
  const projectRoot = ctx.cwd ?? process.cwd();

  ctx.terminal.stdout(renderSelfModifyPrompt({ scope, projectRoot }));
  return ok(0);
}

export async function runPrompt(
  ctx: PromptContext,
): Promise<Result<number, CliError>> {
  if (ctx.flags.promptSubcommand === undefined) {
    ctx.terminal.stderr(PROMPT_USAGE);
    return ok(1);
  }

  switch (ctx.flags.promptSubcommand) {
    case "list":
      return runPromptList(ctx);
    case "self-modify":
      return runPromptSelfModify(ctx);
    default:
      return runPromptInspect(ctx);
  }
}
