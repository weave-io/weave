/**
 * `weave models` — published model recommendations (Spec 39).
 *
 * `status`, `update`, `apply` and `pin` are the user's side and live in
 * `model-updates.ts`; this module routes to them and owns `check`.
 *
 * `weave models check <file> [--envelope] [--key <public-key>] [--expect <file>]`
 * validates a recommendations list (or verifies a signed envelope), resolves
 * every harness section against the provider catalog fixtures, prints the
 * model each agent would get, and with `--expect` fails on any difference.
 * The website's publish workflow runs it before signing a list.
 */

import {
  describeModelRecommendationsError,
  getBuiltinConfig,
  type ModelRecommendationsFile,
  ModelRecommendationsVerifier,
} from "@weaveio/weave-config";
import { formatError } from "@weaveio/weave-core";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import type { ParsedArgs } from "../args.js";
import { type CliError, formatCliError } from "../errors.js";
import { BunFileSystem, type FileSystem } from "../fs/file-system.js";
import type { TerminalIO } from "../io/terminal.js";
import {
  compareExpectations,
  describeMismatch,
  type ExpectationMismatch,
  type ModelExpectations,
  ModelExpectationsSchema,
} from "../models/expectations.js";
import type { CliModelRecommendationsDeps } from "../models/recommendations-session.js";
import {
  type CatalogResolution,
  RecommendationsResolver,
} from "../models/resolve.js";
import type { PromptAdapter } from "../prompt/index.js";
import type { ThemeColors } from "../theme/colors.js";

const ISO_UTC = z.iso.datetime();

export interface ModelsContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  /** Positional arguments after the subcommand: the list file. */
  rest: string[];
  fs?: FileSystem;
  /** The clock freshness is checked against. Defaults to the system clock. */
  now?: () => Date;
  /** Network and cache access for status, update, apply and pin. */
  modelRecommendations?: CliModelRecommendationsDeps;
  /** Asks `weave models pin` for confirmation. Defaults to the terminal. */
  prompt?: PromptAdapter;
}

interface CheckReport {
  readonly path: string;
  readonly file: ModelRecommendationsFile;
  readonly signature: "verified" | "not-checked";
  readonly resolutions: readonly CatalogResolution[];
  /** Agents the list names that this version does not define as builtins. */
  readonly notBuiltin: readonly string[];
  /** Present only with `--expect`. */
  readonly mismatches?: readonly ExpectationMismatch[];
}

/** Usage lines for `weave models`. */
export function modelsUsage(theme: ThemeColors): string[] {
  return [
    `${theme.boldYellow("Usage:")} weave models <status|update|apply|pin|check>`,
    "",
    `  ${theme.cyan("weave models status")} ${theme.dim("[--harness <name>] [--project-root <dir>] [--json]")}`,
    `      ${theme.dim("Mode, channel, the applied list, a waiting list, the last check, and each builtin agent's models with their sources")}`,
    `  ${theme.cyan("weave models update")} ${theme.dim("[--harness <name>]")}  ${theme.dim("Check for a newer list now and print what changed")}`,
    `  ${theme.cyan("weave models apply")} ${theme.dim("[--harness <name>]")}   ${theme.dim("Apply a waiting list (notify mode)")}`,
    `  ${theme.cyan("weave models pin")} ${theme.dim("[--harness <name>] [--yes]")} ${theme.dim("Write the applied lists into ~/.weave/config.weave as explicit models")}`,
    `      ${theme.dim("--harness: opencode2 (default), claude-code or pi; opencode and copilot take no recommendations")}`,
    "",
    `  ${theme.cyan("weave models check")} <file> [--envelope] [--key <public-key>] [--expect <expect-file>] [--issued-after <timestamp>] [--json]`,
    "",
    `  ${theme.cyan("<file>")}                  ${theme.dim("A recommendations list (JSON), or with --envelope a signed envelope")}`,
    `  ${theme.cyan("--envelope")}              ${theme.dim("Verify the envelope's Ed25519 signature, then check its list")}`,
    `  ${theme.cyan("--key")} <public-key>      ${theme.dim("Verify against this base64 raw Ed25519 key instead of the built-in keys")}`,
    `  ${theme.cyan("--expect")} <expect-file>  ${theme.dim("Fail unless every agent resolves to the model the file names")}`,
    `  ${theme.cyan("--issued-after")} <timestamp> ${theme.dim("Fail unless the list is issued later than this (the list currently served)")}`,
    `  ${theme.cyan("--json")}                  ${theme.dim("Print the report as JSON")}`,
  ];
}

function readFile(fs: FileSystem, path: string): ResultAsync<string, CliError> {
  const resolved = fs.resolvePath(path);
  return fs
    .exists(resolved)
    .mapErr(
      (error): CliError => ({
        type: "FileReadError",
        path: resolved,
        cause: error,
        message: "Unable to check whether the file exists.",
      }),
    )
    .andThen((exists) => {
      if (!exists)
        return errAsync<string, CliError>({
          type: "MissingFile",
          path: resolved,
          message: "Pass the path of an existing file.",
        });
      return fs.readText(resolved).mapErr(
        (error): CliError => ({
          type: "FileReadError",
          path: resolved,
          cause: error,
          message: "The file exists but could not be read.",
        }),
      );
    });
}

function invalid(path: string, reasons: readonly string[]): CliError {
  return {
    type: "ValidationFailure",
    path,
    errors: [`Error: ${path} is not valid`, ...reasons.map((r) => `  ${r}`)],
  };
}

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  (cause) => (cause instanceof Error ? cause.message : "not JSON"),
);

function parseExpectations(
  path: string,
  text: string,
): Result<ModelExpectations, CliError> {
  const json = parseJson(text);
  if (json.isErr()) return err(invalid(path, [`not JSON: ${json.error}`]));
  const parsed = ModelExpectationsSchema.safeParse(json.value);
  if (parsed.success) return ok(parsed.data);
  return err(
    invalid(
      path,
      parsed.error.issues.map((issue) => {
        const where = issue.path.map(String).join(".");
        return where.length === 0
          ? issue.message
          : `${where}: ${issue.message}`;
      }),
    ),
  );
}

/**
 * Agents the list names that this version does not define as builtins. A
 * builtin DSL that fails to parse is a bug in this release, reported as such.
 */
function notBuiltinAgents(
  file: ModelRecommendationsFile,
): Result<string[], CliError> {
  const builtins = getBuiltinConfig();
  if (builtins.isErr())
    return err({
      type: "ParseFailure",
      path: "builtins",
      errors: builtins.error.map((e) => `builtins:${formatError(e)}`),
    });
  const names = new Set(Object.keys(builtins.value.agents));
  const named = new Set<string>(Object.keys(file.default.agents));
  for (const section of Object.values(file.harnesses ?? {}))
    for (const agent of Object.keys(section?.agents ?? {})) named.add(agent);
  return ok([...named].filter((agent) => !names.has(agent)).sort());
}

function renderReport(report: CheckReport, theme: ThemeColors): string {
  const { file } = report;
  const lines = [
    `${theme.bold("Model recommendations")} ${theme.dim(report.path)}`,
    `  channel    ${file.channel}`,
    `  issued     ${file.issued}`,
    `  expires    ${file.expires}`,
    `  evidence   ${file.evidence}`,
  ];
  if (file.min_config_version !== undefined)
    lines.push(`  needs      ${file.min_config_version} or later`);
  lines.push(
    report.signature === "verified"
      ? `  signature  ${theme.green("verified")}`
      : `  signature  ${theme.dim("not checked (a plain list; pass --envelope to verify a signed one)")}`,
  );

  let harness = "";
  for (const block of report.resolutions) {
    if (block.harness !== harness) {
      lines.push(
        "",
        `${theme.boldCyan(block.harness)} ${theme.dim(`(section: ${block.section})`)}`,
      );
      harness = block.harness;
    }
    lines.push(`  ${theme.bold(block.catalog)}`);
    const width = Math.max(...block.agents.map((a) => a.agent.length));
    for (const agent of block.agents) {
      const model = agent.model === "none" ? theme.yellow("none") : agent.model;
      lines.push(`    ${agent.agent.padEnd(width)}  ${model}`);
    }
  }

  if (report.notBuiltin.length > 0)
    lines.push(
      "",
      `${theme.yellow("Not builtin agents in this version")} ${theme.dim("(clients skip them)")}: ${report.notBuiltin.join(", ")}`,
    );

  if (report.mismatches === undefined) return lines.join("\n");
  const checked = report.resolutions.reduce(
    (count, block) => count + block.agents.length,
    0,
  );
  if (report.mismatches.length === 0)
    lines.push("", theme.green(`All ${checked} expectations match.`));
  return lines.join("\n");
}

function jsonReport(report: CheckReport): string {
  return JSON.stringify(
    {
      path: report.path,
      channel: report.file.channel,
      issued: report.file.issued,
      expires: report.file.expires,
      evidence: report.file.evidence,
      min_config_version: report.file.min_config_version,
      signature: report.signature,
      not_builtin: report.notBuiltin,
      resolutions: report.resolutions,
      mismatches: report.mismatches,
    },
    null,
    2,
  );
}

class ModelsCheck {
  private readonly fs: FileSystem;
  private readonly verifier: ModelRecommendationsVerifier;

  constructor(private readonly ctx: ModelsContext) {
    this.fs = ctx.fs ?? new BunFileSystem();
    this.verifier = new ModelRecommendationsVerifier({
      ...(ctx.flags.modelsKey === undefined
        ? {}
        : { publicKeys: [ctx.flags.modelsKey] }),
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    });
  }

  run(path: string): ResultAsync<CheckReport, CliError> {
    const resolved = this.fs.resolvePath(path);
    return readFile(this.fs, path)
      .andThen((text) => this.verify(resolved, text))
      .andThen(({ file, signature }) => {
        const notBuiltin = notBuiltinAgents(file);
        if (notBuiltin.isErr())
          return errAsync<CheckReport, CliError>(notBuiltin.error);
        const resolutions = new RecommendationsResolver().resolveFile(file);
        const report: CheckReport = {
          path: resolved,
          file,
          signature,
          resolutions,
          notBuiltin: notBuiltin.value,
        };
        const expectPath = this.ctx.flags.modelsExpect;
        if (expectPath === undefined) return okAsync(report);
        return readFile(this.fs, expectPath)
          .andThen((text) =>
            parseExpectations(this.fs.resolvePath(expectPath), text),
          )
          .map((expectations) => ({
            ...report,
            mismatches: compareExpectations(resolutions, expectations),
          }));
      });
  }

  private verify(
    path: string,
    text: string,
  ): ResultAsync<
    { file: ModelRecommendationsFile; signature: CheckReport["signature"] },
    CliError
  > {
    const toCliError = (
      error: Parameters<typeof describeModelRecommendationsError>[0],
    ) => invalid(path, [describeModelRecommendationsError(error)]);
    const context = {
      ...(this.ctx.flags.modelsIssuedAfter === undefined
        ? {}
        : { appliedIssued: this.ctx.flags.modelsIssuedAfter }),
    };
    if (this.ctx.flags.modelsEnvelope)
      return this.verifier
        .verifyEnvelope(text, context)
        .map((file) => ({ file, signature: "verified" as const }))
        .mapErr(toCliError);
    const result = this.verifier
      .validateList(text, context)
      .map((file) => ({ file, signature: "not-checked" as const }))
      .mapErr(toCliError);
    return result.isOk() ? okAsync(result.value) : errAsync(result.error);
  }
}

/** Run `weave models <subcommand>`. Exit codes are documented in docs/cli.md. */
export async function runModels(
  ctx: ModelsContext,
): Promise<Result<number, CliError>> {
  const subcommand = ctx.flags.modelsSubcommand;
  if (subcommand === undefined) {
    ctx.terminal.stderr(modelsUsage(ctx.theme).join("\n"));
    return ok(1);
  }
  if (subcommand !== "check") {
    if (ctx.rest.length > 0) {
      ctx.terminal.stderr(
        [
          formatCliError({
            type: "InvalidArgs",
            message: `unexpected arguments: ${ctx.rest.join(" ")}`,
          }),
          "",
          ...modelsUsage(ctx.theme),
        ].join("\n"),
      );
      return ok(1);
    }
    const { runModelUpdates } = await import("./model-updates.js");
    return runModelUpdates(ctx, subcommand);
  }
  const [path, ...extra] = ctx.rest;
  if (path === undefined || extra.length > 0) {
    ctx.terminal.stderr(
      [
        formatCliError({
          type: "InvalidArgs",
          message:
            path === undefined
              ? "weave models check needs the path of a list"
              : `unexpected arguments: ${extra.join(" ")}`,
        }),
        "",
        ...modelsUsage(ctx.theme),
      ].join("\n"),
    );
    return ok(1);
  }
  if (ctx.flags.modelsKey !== undefined && !ctx.flags.modelsEnvelope) {
    ctx.terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message: "--key verifies a signature, so it needs --envelope",
      }),
    );
    return ok(1);
  }

  const issuedAfter = ctx.flags.modelsIssuedAfter;
  if (issuedAfter !== undefined && !ISO_UTC.safeParse(issuedAfter).success) {
    ctx.terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message: `--issued-after must be an ISO 8601 UTC timestamp such as 2026-10-01T09:00:00Z, got "${issuedAfter}"`,
      }),
    );
    return ok(1);
  }

  const result = await new ModelsCheck(ctx).run(path);
  if (result.isErr()) {
    ctx.terminal.stderr(formatCliError(result.error));
    return ok(1);
  }

  const report = result.value;
  ctx.terminal.stdout(
    ctx.flags.json ? jsonReport(report) : renderReport(report, ctx.theme),
  );
  const mismatches = report.mismatches ?? [];
  if (mismatches.length === 0) return ok(0);
  ctx.terminal.stderr(
    [
      `Error: ${mismatches.length} resolution${mismatches.length === 1 ? "" : "s"} differ from ${ctx.flags.modelsExpect}`,
      ...mismatches.map((mismatch) => `  ${describeMismatch(mismatch)}`),
    ].join("\n"),
  );
  return ok(1);
}
