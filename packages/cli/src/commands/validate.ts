import { dirname, resolve } from "node:path";
import {
  type ConfigScope,
  getResolvedBuiltinConfig,
  loadConfig,
  mergeConfigsResult,
  resolvePromptPaths,
} from "@weaveio/weave-config";
import {
  formatError,
  parseConfig,
  type WeaveConfig,
} from "@weaveio/weave-core";
import {
  type MaterializationError,
  materializeAgents,
  type PromptFileReader,
} from "@weaveio/weave-engine";
import {
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import type { ParsedArgs } from "../args.js";
import { type CliError, formatCliError } from "../errors.js";
import { BunFileSystem, type FileSystem } from "../fs/file-system.js";
import type { TerminalIO } from "../io/terminal.js";
import type { ThemeColors } from "../theme/colors.js";

export interface ValidateContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  fs?: FileSystem;
}

type ValidateError = CliError;

type ValidatedConfig = {
  path: string;
  config: WeaveConfig;
};

function validateExplicitPath(
  path: string,
  fs: FileSystem,
  kind: ConfigScope["kind"],
): ResultAsync<ValidatedConfig, ValidateError> {
  const resolved = fs.resolvePath(path);
  return fs
    .exists(resolved)
    .mapErr(
      (error): ValidateError => ({
        type: "FileReadError",
        path: resolved,
        cause: error,
        message: "Unable to check whether the file exists.",
      }),
    )
    .andThen((exists) => {
      if (!exists) {
        return errAsync<ValidatedConfig, ValidateError>({
          type: "MissingFile",
          path: resolved,
          message: "Create the file or pass a different --path value.",
        });
      }

      return fs
        .readText(resolved)
        .mapErr(
          (error): ValidateError => ({
            type: "FileReadError",
            path: resolved,
            cause: error,
            message: "The file exists but could not be read.",
          }),
        )
        .andThen((source) => {
          const parsed = parseConfig(source);
          if (parsed.isErr()) {
            return errAsync<ValidatedConfig, ValidateError>({
              type: "ParseFailure",
              path: resolved,
              errors: parsed.error.map(
                (error) => `${resolved}:${formatError(error)}`,
              ),
            });
          }
          return checkFileAgentsMaterialize(
            resolved,
            parsed.value,
            kind,
            fs,
          ).map(() => ({ path: resolved, config: parsed.value }));
        });
    });
}

function formatSummary(config: WeaveConfig): string {
  const disabledAgents = config.disabled.agents.length;
  const disabledHooks = config.disabled.hooks.length;
  const disabledSkills = config.disabled.skills.length;
  const disabledTotal = disabledAgents + disabledHooks + disabledSkills;
  return [
    "Weave config is valid.",
    `agents: ${Object.keys(config.agents).length}`,
    `categories: ${Object.keys(config.categories).length}`,
    `workflows: ${Object.keys(config.workflows).length}`,
    `disabled: ${disabledTotal}`,
    `log_level: ${config.settings.log_level}`,
  ].join("\n");
}

function resolveValidationTarget(
  flags: ParsedArgs["flags"],
  fs: FileSystem,
): { path: string; kind: ConfigScope["kind"] } | undefined {
  if (flags.path !== undefined) return { path: flags.path, kind: "project" };
  if (flags.global)
    return { path: resolve(fs.home(), ".weave/config.weave"), kind: "global" };
  if (flags.project)
    return { path: resolve(fs.cwd(), ".weave/config.weave"), kind: "project" };
  return undefined;
}

function validateEffective(
  fs: FileSystem,
): ResultAsync<ValidatedConfig, ValidateError> {
  return loadConfig(fs.cwd())
    .mapErr(
      (errors): ValidateError => ({
        type: "ParseFailure",
        path: fs.cwd(),
        errors: errors.flatMap((error) => {
          if (error.type === "FileReadError")
            return [`${error.path}: could not read config`];
          if (error.type === "BuiltinParseError")
            return error.errors.map((e) => `builtins:${formatError(e)}`);
          if (error.type === "MergeError")
            return error.errors.flatMap((e) =>
              e.type === "ConfigValidationError"
                ? e.errors.map(
                    (issue) => `merge:${e.layer}:${formatError(issue)}`,
                  )
                : [`merge:${e.type}:${e.error.type}`],
            );
          return error.errors.map((e) => `${error.path}:${formatError(e)}`);
        }),
      }),
    )
    .andThen((config) => checkAgentsMaterialize(fs.cwd(), config))
    .map((config) => ({ path: fs.cwd(), config }));
}

/**
 * Harness adapters skip agents whose descriptors cannot be composed (for
 * example an agent with no prompt, or a prompt_file that does not exist).
 * Report those agents instead of letting them disappear at runtime.
 */
export function checkAgentsMaterialize(
  path: string,
  config: WeaveConfig,
): ResultAsync<WeaveConfig, ValidateError> {
  return materializeAgents({ config }).andThen((plan) =>
    materializationResult(path, config, plan.errors),
  );
}

/**
 * The same check for one config file: the file is merged onto the builtins,
 * its prompt paths resolve against its own directory (`.weave/config.weave`
 * reads `.weave/prompts/`), and only failures of agents and categories the
 * file declares are reported, so a problem in another scope is not blamed on
 * this one.
 */
function checkFileAgentsMaterialize(
  path: string,
  config: WeaveConfig,
  kind: ConfigScope["kind"],
  fs: FileSystem,
): ResultAsync<WeaveConfig, ValidateError> {
  const builtins = getResolvedBuiltinConfig();
  if (builtins.isErr())
    return errAsync({
      type: "ParseFailure",
      path: "builtins",
      errors: builtins.error.map((e) => `builtins:${formatError(e)}`),
    });
  const scoped = resolvePromptPaths(config, { kind, rootDir: dirname(path) });
  const merged = mergeConfigsResult(builtins.value, scoped);
  if (merged.isErr())
    return errAsync({
      type: "ValidationFailure",
      path,
      errors: merged.error.map((e) =>
        e.type === "ConfigValidationError"
          ? e.errors.map((issue) => formatError(issue)).join("; ")
          : `${e.type}:${e.error.type}`,
      ),
    });
  const declared = new Set([
    ...Object.keys(config.agents),
    ...Object.keys(config.categories).map((name) => `shuttle-${name}`),
  ]);
  return materializeAgents({
    config: merged.value,
    promptFileReader: fileSystemPromptReader(fs),
  }).andThen((plan) =>
    materializationResult(
      path,
      config,
      plan.errors.filter(
        (error) =>
          error.type !== "DescriptorCompositionFailure" ||
          declared.has(error.agentName),
      ),
    ),
  );
}

function fileSystemPromptReader(fs: FileSystem): PromptFileReader {
  return {
    read: (path) =>
      fs.readText(path).mapErr(() => ({
        message: `could not read ${path}`,
      })),
  };
}

function materializationResult(
  path: string,
  config: WeaveConfig,
  errors: readonly MaterializationError[],
): ResultAsync<WeaveConfig, ValidateError> {
  if (errors.length === 0) return okAsync(config);
  return errAsync<WeaveConfig, ValidateError>({
    type: "ValidationFailure",
    path,
    errors: errors.map((error) =>
      error.type === "DescriptorCompositionFailure"
        ? `agent "${error.agentName}" cannot be registered by harness adapters: ${error.cause.message}`
        : error.conflict.message,
    ),
  });
}

export async function runValidate(
  ctx: ValidateContext,
): Promise<Result<number, CliError>> {
  const fs = ctx.fs ?? new BunFileSystem();
  const target = resolveValidationTarget(ctx.flags, fs);
  const result = await (target === undefined
    ? validateEffective(fs)
    : validateExplicitPath(target.path, fs, target.kind));

  if (result.isErr()) {
    ctx.terminal.stderr(formatCliError(result.error));
    return ok(1);
  }

  if (ctx.flags.json) {
    ctx.terminal.stdout(JSON.stringify(result.value.config, null, 2));
    return ok(0);
  }

  ctx.terminal.stdout(formatSummary(result.value.config));
  return ok(0);
}
