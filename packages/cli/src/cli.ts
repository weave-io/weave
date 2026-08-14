/**
 * Top-level CLI router.
 *
 * Parses global flags, dispatches to command handlers, and returns
 * an exit code. The actual `process.exit()` call lives only in
 * `main.ts` — this module is fully testable.
 */

import { ok, type Result } from "neverthrow";
import { parseArgs } from "./args.js";
import { type CliError, formatCliError } from "./errors.js";
import { RealTerminal, type TerminalIO } from "./io/terminal.js";
import { defaultThemeManager } from "./theme/colors.js";
import { defaultThemeRenderer } from "./theme/render.js";

// ---------------------------------------------------------------------------
// Dependencies — injectable for testing
// ---------------------------------------------------------------------------

export interface CliDeps {
  argv: string[];
  terminal: TerminalIO;
  colorEnabled?: boolean;
}

function defaultDeps(): CliDeps {
  return {
    argv: Bun.argv,
    terminal: new RealTerminal(),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Run the CLI with the given (or default) dependencies.
 * Returns an exit code: 0 for success, 1 for errors.
 */
export async function run(
  deps?: Partial<CliDeps>,
): Promise<Result<number, CliError>> {
  const { argv, terminal, colorEnabled } = {
    ...defaultDeps(),
    ...deps,
  };

  const theme = defaultThemeManager.getTheme(colorEnabled);

  const parsed = parseArgs(argv);
  if (parsed.isErr()) {
    terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message: parsed.error.message,
      }),
    );
    return ok(1);
  }

  const { command, unknownCommand, flags, rest } = parsed.value;

  switch (command) {
    case "help": {
      // If --help was requested while in init migrate context, show migrate help
      if (flags.initSubmode === "migrate") {
        terminal.stdout(renderMigrateHelp(theme).join("\n"));
        return ok(0);
      }
      const lines = defaultThemeRenderer.renderHelp(theme);
      terminal.stdout(lines.join("\n"));
      return ok(0);
    }

    case "version": {
      terminal.stdout(defaultThemeRenderer.renderVersion());
      return ok(0);
    }

    case "run": {
      terminal.stderr(
        [
          `${theme.boldYellow("Weave does not run harness runtimes directly.")}`,
          "",
          `  Weave configures third-party harnesses through ${theme.cyan("weave init")}.`,
          "  To start a harness, use its own launch command:",
          "",
          `    ${theme.dim("$")} opencode          ${theme.dim("# OpenCode")}`,
          `    ${theme.dim("$")} claude             ${theme.dim("# Claude Code")}`,
          `    ${theme.dim("$")} pi                 ${theme.dim("# Pi")}`,
          "",
          `  Run ${theme.cyan("weave init")} to configure your harnesses.`,
          `  Run ${theme.cyan("weave --help")} for available commands.`,
        ].join("\n"),
      );
      return ok(1);
    }

    case "validate": {
      // Delegate to validate command — imported dynamically to keep
      // this router lean and avoid circular deps during init
      const { runValidate } = await import("./commands/validate.js");
      return runValidate({ terminal, theme, flags });
    }

    case "init": {
      const { runInit } = await import("./commands/init.js");
      return runInit({ terminal, theme, flags });
    }

    case "runtime": {
      const { runRuntime } = await import("./commands/runtime.js");
      const subcommand = flags.runtimeSubcommand;
      if (!subcommand) {
        terminal.stderr(
          [
            `${theme.boldYellow("Usage:")} weave runtime <subcommand>`,
            "",
            `  ${theme.cyan("weave runtime status")}              ${theme.dim("Show runtime store status")}`,
            `  ${theme.cyan("weave runtime journal")} ${theme.dim("[--limit <n>]")}  ${theme.dim("Show recent journal entries")}`,
          ].join("\n"),
        );
        return ok(1);
      }
      return runRuntime({
        terminal,
        theme,
        subcommand,
        limit: flags.limit,
      });
    }

    case "adapter": {
      const { parseAdapterTarget, renderAdapterHelp, runAdapter } =
        await import("./commands/adapter.js");
      const { resolveProductionAdapterCliRegistry } = await import(
        "@weaveio/weave-adapter-pi/cli"
      );
      if (rest.length === 0 || flags.help) {
        terminal.stdout(renderAdapterHelp(theme));
        return ok(rest.length === 0 ? 1 : 0);
      }
      const target = parseAdapterTarget(rest);
      if (target.isErr()) {
        terminal.stderr(formatCliError(target.error));
        terminal.stderr(renderAdapterHelp(theme));
        return ok(1);
      }
      let resolved = target.value;
      if (
        resolved.action === "children.show" &&
        (flags.cursor !== undefined ||
          flags.parentSession !== undefined ||
          flags.content === true ||
          flags.contentCursor !== undefined)
      ) {
        resolved = {
          ...resolved,
          ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
          ...(flags.content === true ? { content: true } : {}),
          ...(flags.contentCursor === undefined
            ? {}
            : { contentCursor: flags.contentCursor }),
          ...(flags.parentSession === undefined
            ? {}
            : { parentSessionId: flags.parentSession }),
        };
      }
      if (
        resolved.action === "children.result" &&
        (flags.cursor !== undefined || flags.parentSession !== undefined)
      ) {
        resolved = {
          ...resolved,
          ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
          ...(flags.parentSession === undefined
            ? {}
            : { parentSessionId: flags.parentSession }),
        };
      }
      if (
        resolved.action === "children.delete" &&
        flags.parentSession !== undefined
      ) {
        resolved = {
          ...resolved,
          parentSessionId: flags.parentSession,
        };
      }
      const workspaceKey = process.cwd();
      // Delete is gated inside resolveProductionAdapterCliRegistry before
      // createProductionPorts / any cache or ref open.
      const productionRegistry = await resolveProductionAdapterCliRegistry({
        action: resolved.action,
        workspaceKey,
        accessMode: "read",
      });
      if (productionRegistry.isErr()) {
        const error = productionRegistry.error;
        const message =
          error.type === "RequiredCapabilityUnavailable"
            ? `RequiredCapabilityUnavailable: ${error.capabilityId} (${error.reason})`
            : `Pi adapter command ports unavailable: ${error.type} (${error.reason})`;
        terminal.stderr(
          formatCliError({
            type: "InvalidArgs",
            message,
          }),
        );
        return ok(1);
      }
      return runAdapter({
        terminal,
        theme,
        target: resolved,
        json: flags.json,
        yes: flags.yes,
        diagnostic: flags.diagnostic === true,
        workspaceKey,
        registry: productionRegistry.value,
      });
    }

    case "prompt": {
      const { runPrompt } = await import("./commands/prompt.js");
      const subcommand = flags.promptSubcommand;
      if (!subcommand) {
        terminal.stderr(
          [
            `${theme.boldYellow("Usage:")} weave prompt <subcommand>`,
            "",
            `  ${theme.cyan("weave prompt inspect <agent>")}                    ${theme.dim("Render the composed prompt for an agent")}`,
            `  ${theme.cyan("weave prompt inspect <agent> --json")}             ${theme.dim("Output prompt + metadata as JSON")}`,
            `  ${theme.cyan("weave prompt list")}                               ${theme.dim("List all available agent names")}`,
            `  ${theme.cyan("weave prompt list --json")}                        ${theme.dim("List agents as JSON")}`,
            `  ${theme.cyan("weave prompt self-modify")}                        ${theme.dim("Print the Weave self-modification guide")}`,
            `  ${theme.cyan("weave prompt self-modify --scope global|local")}   ${theme.dim("Choose config scope")}`,
          ].join("\n"),
        );
        return ok(1);
      }
      return runPrompt({ terminal, theme, flags, rest });
    }

    case "eval": {
      const { runEval } = await import("./commands/eval.js");
      return runEval({ terminal, theme, flags });
    }

    case "compose": {
      const { runCompose } = await import("./commands/compose.js");
      return runCompose({ terminal, theme, flags });
    }

    case "unknown": {
      const errMsg = formatCliError({
        type: "UnknownCommand",
        command: unknownCommand ?? "???",
        message: 'Run "weave --help" to see available commands.',
      });
      terminal.stderr(errMsg);
      return ok(1);
    }

    default: {
      const lines = defaultThemeRenderer.renderHelp(theme);
      terminal.stdout(lines.join("\n"));
      return ok(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Migrate help text
// ---------------------------------------------------------------------------

function renderMigrateHelp(
  theme: ReturnType<typeof defaultThemeManager.getTheme>,
): string[] {
  return [
    "",
    `  ${theme.bold("weave init migrate")} ${theme.dim("— migrate legacy OpenCode JSONC config to .weave DSL")}`,
    "",
    `  ${theme.boldCyan("USAGE")}`,
    "",
    `    ${theme.dim("$")} weave init migrate ${theme.dim("[--scope global|local] [--yes]")}`,
    "",
    `  ${theme.boldCyan("DESCRIPTION")}`,
    "",
    "    Reads the legacy weave-opencode.jsonc file for the chosen scope and",
    "    converts it into a canonical config.weave file.",
    "",
    "    Scope-aware legacy sources:",
    `      global  ${theme.dim("~/.config/opencode/weave-opencode.jsonc")}`,
    `      local   ${theme.dim("./.opencode/weave-opencode.jsonc")}`,
    "",
    "    Canonical migration destinations (always enforced):",
    `      global  ${theme.dim("~/.weave/config.weave")}`,
    `      local   ${theme.dim("./.weave/config.weave")}`,
    "",
    `    ${theme.boldYellow("Note:")} --install-dir is ignored in migrate mode.`,
    "    Migration always writes to the canonical scope destination above.",
    "",
    `  ${theme.boldCyan("OPTIONS")}`,
    "",
    `    ${theme.cyan("--scope")} global|local  ${theme.dim("Choose migration scope (default: global)")}`,
    `    ${theme.cyan("--yes, -y")}            ${theme.dim("Non-interactive: skip confirmation prompt")}`,
    `    ${theme.cyan("--force")}              ${theme.dim("Overwrite destination even if it exists (backup created)")}`,
    "",
    `  ${theme.boldCyan("EXAMPLES")}`,
    "",
    `    ${theme.dim("$")} weave init migrate                         ${theme.dim("# Interactive local migration")}`,
    `    ${theme.dim("$")} weave init migrate --scope global          ${theme.dim("# Interactive global migration")}`,
    `    ${theme.dim("$")} weave init migrate --scope local --yes     ${theme.dim("# Non-interactive local migration")}`,
    "",
  ];
}
