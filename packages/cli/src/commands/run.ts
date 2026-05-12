/**
 * `weave run` compatibility shim.
 *
 * Exits with code 1 and a message explaining that Weave configures
 * harnesses through `weave init` and does not run them directly.
 * This aligns with the product vision documented in docs/product-vision.md.
 */

import { ok, type Result } from "neverthrow";
import type { CliError } from "../errors.js";
import type { TerminalIO } from "../io/terminal.js";
import type { ThemeColors } from "../theme/colors.js";

export interface RunContext {
  terminal: TerminalIO;
  theme: ThemeColors;
}

export function runRun(ctx: RunContext): Result<number, CliError> {
  ctx.terminal.stderr(
    [
      `${ctx.theme.boldYellow("Weave does not run harness runtimes directly.")}`,
      "",
      `  Weave configures third-party harnesses through ${ctx.theme.cyan("weave init")}.`,
      "  To start a harness, use its own launch command:",
      "",
      `    ${ctx.theme.dim("$")} opencode          ${ctx.theme.dim("# OpenCode")}`,
      `    ${ctx.theme.dim("$")} claude             ${ctx.theme.dim("# Claude Code")}`,
      `    ${ctx.theme.dim("$")} pi                 ${ctx.theme.dim("# Pi")}`,
      "",
      `  Run ${ctx.theme.cyan("weave init")} to configure your harnesses.`,
      `  Run ${ctx.theme.cyan("weave --help")} for available commands.`,
    ].join("\n"),
  );
  return ok(1);
}
