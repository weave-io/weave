/**
 * Argument parsing for the Weave CLI.
 *
 * Parses `Bun.argv` (or a provided array) into a structured
 * command + flags object. Intentionally minimal — no external
 * arg-parsing library required.
 */

import { err, ok, type Result } from "neverthrow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Command =
  | "help"
  | "version"
  | "init"
  | "validate"
  | "run"
  | "runtime"
  | "unknown";

export interface ParsedArgs {
  command: Command;
  /** The raw unknown command string (only set when command === "unknown"). */
  unknownCommand?: string;
  /** Remaining positional and flag arguments after the command. */
  rest: string[];
  /** Global flags parsed from anywhere in argv. */
  flags: {
    help: boolean;
    version: boolean;
    json: boolean;
    yes: boolean;
    force: boolean;
    /** --scope global|local */
    scope?: "global" | "local";
    /** --path <file> */
    path?: string;
    /** --install-dir <dir> */
    installDir?: string;
    /** --harness <name> */
    harness?: string;
    /** --all-harnesses */
    allHarnesses: boolean;
    /** --project flag for validate */
    project: boolean;
    /** --global flag for validate */
    global: boolean;
    /** --limit <n> for runtime journal */
    limit?: number;
    /** runtime subcommand: status | journal */
    runtimeSubcommand?: "status" | "journal";
    /**
     * init submode: "migrate" when `weave init migrate` is invoked.
     * Undefined for ordinary `weave init`.
     */
    initSubmode?: "migrate";
  };
}

export type ArgParseError =
  | {
      type: "MissingFlagValue";
      flag: string;
      message: string;
    }
  | {
      type: "InvalidFlagValue";
      flag: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw argv array into structured CLI arguments.
 * Expects the standard `[runtime, script, ...userArgs]` format.
 */
export function parseArgs(argv: string[]): Result<ParsedArgs, ArgParseError> {
  // Strip runtime and script path
  const args = argv.slice(2);

  const flags: ParsedArgs["flags"] = {
    help: false,
    version: false,
    json: false,
    yes: false,
    force: false,
    allHarnesses: false,
    project: false,
    global: false,
  };

  let command: Command | undefined;
  let unknownCommand: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Global flags
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      flags.version = true;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--force") {
      flags.force = true;
      continue;
    }
    if (arg === "--all-harnesses") {
      flags.allHarnesses = true;
      continue;
    }
    if (arg === "--project") {
      flags.project = true;
      continue;
    }
    if (arg === "--global") {
      flags.global = true;
      continue;
    }

    // Value flags
    if (arg === "--scope") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--scope",
          message: "--scope requires a value: global or local",
        });
      }
      if (val === "global" || val === "local") {
        flags.scope = val;
      }
      continue;
    }
    if (arg === "--path") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--path",
          message: "--path requires a file path",
        });
      }
      flags.path = val;
      continue;
    }
    if (arg === "--install-dir") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--install-dir",
          message: "--install-dir requires a directory path",
        });
      }
      flags.installDir = val;
      continue;
    }
    if (arg === "--harness") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--harness",
          message: "--harness requires a harness name",
        });
      }
      flags.harness = val;
      continue;
    }
    if (arg === "--limit") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--limit",
          message: "--limit requires a positive integer",
        });
      }
      const parsed = parseInt(val, 10);
      if (
        !Number.isInteger(parsed) ||
        parsed <= 0 ||
        String(parsed) !== val.trim()
      ) {
        return err({
          type: "InvalidFlagValue" as const,
          flag: "--limit",
          message: "--limit requires a positive integer",
        });
      }
      flags.limit = parsed;
      continue;
    }

    // Commands
    if (!command) {
      switch (arg) {
        case "init":
          command = "init";
          break;
        case "validate":
          command = "validate";
          break;
        case "run":
          command = "run";
          break;
        case "runtime":
          command = "runtime";
          break;
        default:
          command = "unknown";
          unknownCommand = arg;
          break;
      }
      continue;
    }

    // init submode: "migrate" — parsed as the first positional after "init"
    if (command === "init" && flags.initSubmode === undefined) {
      if (arg === "migrate") {
        flags.initSubmode = "migrate";
        continue;
      }
    }

    // runtime subcommands: status, journal
    if (command === "runtime" && flags.runtimeSubcommand === undefined) {
      if (arg === "status" || arg === "journal") {
        flags.runtimeSubcommand = arg;
        continue;
      }
    }

    // Everything else goes into rest
    rest.push(arg);
  }

  // --help or --version as top-level override
  if (flags.help) {
    command = "help";
  } else if (flags.version && !command) {
    command = "version";
  }

  return ok({
    command: command ?? "help",
    unknownCommand,
    rest,
    flags,
  });
}
