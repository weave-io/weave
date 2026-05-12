/**
 * Public API for @weave/cli.
 *
 * Exports command handlers and testable modules for programmatic
 * use and testing. End users invoke the CLI through the `weave`
 * binary (main.ts), not this barrel.
 */

export type { ArgParseError, Command, ParsedArgs } from "./args.js";
// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
export { parseArgs } from "./args.js";
export type { CliDeps } from "./cli.js";
// ---------------------------------------------------------------------------
// CLI router
// ---------------------------------------------------------------------------
export { run } from "./cli.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------
export type {
  CliError,
  FileReadError,
  InvalidArgsError,
  MissingFileError,
  ParseFailureError,
  UnknownCommandError,
  ValidationFailureError,
} from "./errors.js";
export { formatCliError } from "./errors.js";

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------
export type { TerminalIO } from "./io/terminal.js";
export { BufferTerminal, RealTerminal } from "./io/terminal.js";
export {
  LOGO_WIDTH,
  PLAIN_LOGO_LINES,
  renderLogo,
} from "./theme/ascii-logo.js";
export type { ThemeColors, ThemeManagerDeps } from "./theme/colors.js";
// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
export { defaultThemeManager, ThemeManager } from "./theme/colors.js";
export type { VersionSource } from "./theme/render.js";
export { defaultThemeRenderer, ThemeRenderer } from "./theme/render.js";
