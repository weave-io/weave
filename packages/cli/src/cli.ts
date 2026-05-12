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
import { getTheme } from "./theme/colors.js";
import { renderHelp, renderVersion } from "./theme/render.js";

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
    argv: typeof Bun !== "undefined" ? Bun.argv : process.argv,
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

  const theme = getTheme(colorEnabled);

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

  const { command, unknownCommand, flags } = parsed.value;

  switch (command) {
    case "help": {
      const lines = renderHelp(theme);
      terminal.stdout(lines.join("\n"));
      return ok(0);
    }

    case "version": {
      terminal.stdout(renderVersion());
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
      const lines = renderHelp(theme);
      terminal.stdout(lines.join("\n"));
      return ok(0);
    }
  }
}
