import { dirname, resolve } from "node:path";
import {
  type ConfigLoadDiagnostic,
  type ConfigScope,
  getResolvedBuiltinConfig,
  mergeConfigsResult,
  type RecommendationsHarness,
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
import {
  chooseHarness,
  type HarnessChoice,
  unsupportedMessage,
} from "../models/harness.js";
import {
  type CliModelRecommendationsDeps,
  RecommendationsSession,
} from "../models/recommendations-session.js";
import { validateSummaryLines } from "../models/report.js";
import type { ThemeColors } from "../theme/colors.js";

export interface ValidateContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  fs?: FileSystem;
  /** The clock applied model recommendations are checked against. */
  now?: () => Date;
  /** Cache access for reporting model recommendations (Spec 39). */
  modelRecommendations?: CliModelRecommendationsDeps;
}

type ValidateError = CliError;

type ValidatedConfig = {
  path: string;
  config: WeaveConfig;
  /** The effective config's diagnostics, when the effective config was loaded. */
  diagnostics?: readonly ConfigLoadDiagnostic[];
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
  session: RecommendationsSession,
  fs: FileSystem,
  harness: RecommendationsHarness | undefined,
): ResultAsync<ValidatedConfig, ValidateError> {
  const cwd = fs.cwd();
  return session.load(cwd, harness).andThen(({ config, diagnostics }) =>
    checkAgentsMaterialize(cwd, config, fileSystemPromptReader(fs)).map(() => ({
      path: cwd,
      config,
      diagnostics,
    })),
  );
}

/**
 * The model recommendations lines (Spec 39): the effective mode, the applied
 * list's date, or why the layer is pending or skipped. Every form of the
 * command reports the effective config's setting, since that is what the
 * harnesses use. Empty when the effective config has no `model_updates`
 * block, or does not load (the file form then still reports its own result).
 */
async function modelUpdatesLines(
  session: RecommendationsSession,
  cwd: string,
  choice: HarnessChoice,
  validated: ValidatedConfig,
): Promise<string[]> {
  const harness = choice.type === "supported" ? choice.harness : undefined;
  const effective =
    validated.diagnostics === undefined
      ? await session.load(cwd, harness)
      : ok({ config: validated.config, diagnostics: validated.diagnostics });
  if (effective.isErr()) return [];
  const { config, diagnostics } = effective.value;
  const lines = validateSummaryLines(config, diagnostics);
  const optedIn =
    config.settings.model_updates !== undefined &&
    config.settings.model_updates.mode !== "off";
  if (choice.type === "unsupported" && optedIn)
    lines.push(`model_recommendations: ${unsupportedMessage(choice)}`);
  return lines;
}

/**
 * Harness adapters skip agents whose descriptors cannot be composed (for
 * example an agent with no prompt, or a prompt_file that does not exist).
 * Report those agents instead of letting them disappear at runtime. Prompt
 * files are read through `promptFileReader`, the command's filesystem, when
 * given.
 */
export function checkAgentsMaterialize(
  path: string,
  config: WeaveConfig,
  promptFileReader?: PromptFileReader,
): ResultAsync<WeaveConfig, ValidateError> {
  return materializeAgents({
    config,
    ...(promptFileReader === undefined ? {} : { promptFileReader }),
  }).andThen((plan) => materializationResult(path, config, plan.errors));
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
  const choice = chooseHarness(ctx.flags.harness);
  if (choice.isErr()) {
    ctx.terminal.stderr(formatCliError(choice.error));
    return ok(1);
  }
  const session = new RecommendationsSession(
    fs,
    ctx.modelRecommendations,
    ctx.now,
  );
  const harness =
    choice.value.type === "supported" ? choice.value.harness : undefined;
  const target = resolveValidationTarget(ctx.flags, fs);
  const result = await (target === undefined
    ? validateEffective(session, fs, harness)
    : validateExplicitPath(target.path, fs, target.kind));

  if (result.isErr()) {
    ctx.terminal.stderr(formatCliError(result.error));
    return ok(1);
  }

  const modelUpdates = await modelUpdatesLines(
    session,
    fs.cwd(),
    choice.value,
    result.value,
  );

  if (ctx.flags.json) {
    // stdout stays the config document; the report goes to stderr.
    ctx.terminal.stdout(JSON.stringify(result.value.config, null, 2));
    if (modelUpdates.length > 0) ctx.terminal.stderr(modelUpdates.join("\n"));
    return ok(0);
  }

  ctx.terminal.stdout(
    [formatSummary(result.value.config), ...modelUpdates].join("\n"),
  );
  return ok(0);
}
