import { resolve } from "node:path";
import { loadConfig } from "@weave/config";
import { formatError, parseConfig, type WeaveConfig } from "@weave/core";
import { errAsync, ok, type Result, ResultAsync } from "neverthrow";
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
          return ResultAsync.fromSafePromise(
            Promise.resolve({ path: resolved, config: parsed.value }),
          );
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
): string | undefined {
  if (flags.path !== undefined) return flags.path;
  if (flags.global) return resolve(fs.home(), ".weave/config.weave");
  if (flags.project) return resolve(fs.cwd(), ".weave/config.weave");
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
          return error.errors.map((e) => `${error.path}:${formatError(e)}`);
        }),
      }),
    )
    .map((config) => ({ path: fs.cwd(), config }));
}

export async function runValidate(
  ctx: ValidateContext,
): Promise<Result<number, CliError>> {
  const fs = ctx.fs ?? new BunFileSystem();
  const target = resolveValidationTarget(ctx.flags, fs);
  const result = await (target === undefined
    ? validateEffective(fs)
    : validateExplicitPath(target, fs));

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
