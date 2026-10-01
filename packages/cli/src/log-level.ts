/**
 * The log level the `weave` executable uses when `LOG_LEVEL` is unset.
 *
 * Engine and config logs go to stderr as pino JSON lines, warnings and up by
 * default. `weave models` is the exception: everything the config package
 * warns about there (a failed check, a skipped recommendations layer) comes
 * back to the command as a result, and the command prints it in words. The
 * JSON line would repeat it, with the host name and pid, so these commands
 * log errors only. `LOG_LEVEL` still overrides this.
 *
 * This module must not import a logger: `main.ts` calls it before the engine
 * and config loggers are created, because their child loggers keep the level
 * they were created with.
 */

import { parseArgs } from "./args.js";

export type CliLogLevel = "warn" | "error";

export function defaultLogLevel(argv: string[]): CliLogLevel {
  const parsed = parseArgs(argv);
  if (parsed.isErr()) return "warn";
  if (parsed.value.command === "models") return "error";
  return "warn";
}
