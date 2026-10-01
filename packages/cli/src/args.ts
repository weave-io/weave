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
  | "prompt"
  | "runtime"
  | "eval"
  | "compose"
  | "models"
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
    /** prompt subcommand: inspect | list | self-modify */
    promptSubcommand?: "inspect" | "list" | "self-modify";
    /** agent name for `prompt inspect <agent>` */
    agentName?: string;
    /**
     * init submode: "migrate" when `weave init migrate` is invoked.
     * Undefined for ordinary `weave init`.
     */
    initSubmode?: "migrate";
    /**
     * eval subcommand: `"run"` for `weave eval run`, `"compare"` for
     * `weave eval compare <baseline> <candidate>` (the two runs are left in
     * `rest`, in order), `"compare-models"` for
     * `weave eval compare-models <run> [<run>]` (the runs are left in
     * `rest`), `"reindex"` for `weave eval reindex`.
     */
    evalSubcommand?: "run" | "compare" | "compare-models" | "reindex";
    /** --agent <name> filter for `weave eval run` */
    evalAgent?: string;
    /** --model <id> filter for `weave eval run` */
    evalModel?: string;
    /** --models <set> model set for `weave eval run` (`default` or `dev`) */
    evalModels?: string;
    /** --case <id> filter for `weave eval run` */
    evalCase?: string;
    /** --repeat <n> for `weave eval run`, as typed; validated by the eval command */
    evalRepeat?: string;
    /** --track for `weave eval run` (`text` or `trajectory`); validated by the eval command */
    evalTrack?: string;
    /** --config for `weave eval run` (`builtin` or `project`); validated by the eval command */
    evalConfig?: string;
    /** --current <model-id> for `weave eval compare-models` */
    evalCurrent?: string;
    /** --candidate <model-id> for `weave eval compare-models` */
    evalCandidate?: string;
    /** --min-repeats <n> for `weave eval compare-models`, as typed; validated by the eval command */
    evalMinRepeats?: string;
    /** --dry-run flag for `weave eval run` — skips actual execution */
    dryRun?: boolean;
    /** --raw-artifacts flag for `weave eval run` — explicit local-only opt-in */
    rawArtifacts?: boolean;
    /** --adapter <name> for `weave compose` */
    adapter?: string;
    /** --project-root <path> for `weave compose` */
    projectRoot?: string;
    /** --out-dir <path> for `weave compose` */
    outDir?: string;
    /** --init flag for `weave compose` — copies bootstrap plugin into the project */
    init?: boolean;
    /** --bootstrap-dir <path> for `weave compose --init` — overrides default output path */
    bootstrapDir?: string;
    /**
     * models subcommand: `"check"` for `weave models check <file>` (the file
     * is left in `rest`), or `status`, `update`, `apply`, `pin`.
     */
    modelsSubcommand?: "check" | "status" | "update" | "apply" | "pin";
    /** --envelope for `weave models check` — the file is a signed envelope */
    modelsEnvelope?: boolean;
    /** --expect <file> for `weave models check` — the expectations file */
    modelsExpect?: string;
    /** --key <public-key> for `weave models check` — verify against this key */
    modelsKey?: string;
    /** --issued-after <timestamp> for `weave models check` — the served list's `issued` */
    modelsIssuedAfter?: string;
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
    dryRun: false,
    rawArtifacts: false,
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
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (arg === "--raw-artifacts") {
      flags.rawArtifacts = true;
      continue;
    }
    if (arg === "--adapter") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--adapter",
          message: "--adapter requires an adapter name (e.g. claude-code)",
        });
      }
      flags.adapter = val;
      continue;
    }
    if (arg === "--project-root") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--project-root",
          message: "--project-root requires a directory path",
        });
      }
      flags.projectRoot = val;
      continue;
    }
    if (arg === "--out-dir") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--out-dir",
          message: "--out-dir requires a directory path",
        });
      }
      flags.outDir = val;
      continue;
    }
    if (arg === "--init") {
      flags.init = true;
      continue;
    }
    if (arg === "--envelope") {
      flags.modelsEnvelope = true;
      continue;
    }
    if (arg === "--expect") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--expect",
          message: "--expect requires the path of an expectations file",
        });
      }
      flags.modelsExpect = val;
      continue;
    }
    if (arg === "--key") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--key",
          message: "--key requires a base64 Ed25519 public key",
        });
      }
      flags.modelsKey = val;
      continue;
    }
    if (arg === "--issued-after") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--issued-after",
          message:
            "--issued-after requires the issued timestamp of the list currently served",
        });
      }
      flags.modelsIssuedAfter = val;
      continue;
    }
    if (arg === "--bootstrap-dir") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--bootstrap-dir",
          message: "--bootstrap-dir requires a directory path",
        });
      }
      flags.bootstrapDir = val;
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
      if (val !== "global" && val !== "local") {
        return err({
          type: "InvalidFlagValue" as const,
          flag: "--scope",
          message: `--scope must be "global" or "local", got "${val}"`,
        });
      }
      flags.scope = val;
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
    if (arg === "--agent") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--agent",
          message: "--agent requires an agent name",
        });
      }
      flags.evalAgent = val;
      continue;
    }
    if (arg === "--model") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--model",
          message: "--model requires a model identifier",
        });
      }
      flags.evalModel = val;
      continue;
    }
    if (arg === "--models") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--models",
          message: "--models requires a model set name (default or dev)",
        });
      }
      flags.evalModels = val;
      continue;
    }
    if (arg === "--case") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--case",
          message: "--case requires a case identifier",
        });
      }
      flags.evalCase = val;
      continue;
    }
    if (arg === "--repeat") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--repeat",
          message: "--repeat requires a number of repeats",
        });
      }
      flags.evalRepeat = val;
      continue;
    }
    if (arg === "--track") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--track",
          message: "--track requires a track name (text or trajectory)",
        });
      }
      flags.evalTrack = val;
      continue;
    }
    if (arg === "--current") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--current",
          message: "--current requires the model ID the agent uses today",
        });
      }
      flags.evalCurrent = val;
      continue;
    }
    if (arg === "--candidate") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--candidate",
          message: "--candidate requires the model ID that would replace it",
        });
      }
      flags.evalCandidate = val;
      continue;
    }
    if (arg === "--min-repeats") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--min-repeats",
          message: "--min-repeats requires a number of repeats",
        });
      }
      flags.evalMinRepeats = val;
      continue;
    }
    if (arg === "--config") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        return err({
          type: "MissingFlagValue" as const,
          flag: "--config",
          message: "--config requires a config mode (builtin or project)",
        });
      }
      flags.evalConfig = val;
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
        case "prompt":
          command = "prompt";
          break;
        case "runtime":
          command = "runtime";
          break;
        case "eval":
          command = "eval";
          break;
        case "compose":
          command = "compose";
          break;
        case "models":
          command = "models";
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

    // prompt subcommands: inspect, list, self-modify
    if (command === "prompt" && flags.promptSubcommand === undefined) {
      if (arg === "inspect" || arg === "list" || arg === "self-modify") {
        flags.promptSubcommand = arg;
        continue;
      }
    }

    // prompt inspect agent name — parsed as the first positional after "inspect"
    if (
      command === "prompt" &&
      flags.promptSubcommand === "inspect" &&
      flags.agentName === undefined
    ) {
      flags.agentName = arg;
      continue;
    }

    // eval subcommands: "run", "compare", "compare-models", "reindex"
    if (command === "eval" && flags.evalSubcommand === undefined) {
      if (
        arg === "run" ||
        arg === "compare" ||
        arg === "compare-models" ||
        arg === "reindex"
      ) {
        flags.evalSubcommand = arg;
        continue;
      }
    }

    // models subcommands: "check", "status", "update", "apply", "pin"
    if (command === "models" && flags.modelsSubcommand === undefined) {
      if (
        arg === "check" ||
        arg === "status" ||
        arg === "update" ||
        arg === "apply" ||
        arg === "pin"
      ) {
        flags.modelsSubcommand = arg;
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
