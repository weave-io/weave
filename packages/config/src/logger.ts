import pino from "pino";

/**
 * Resolve the pino destination for the config logger.
 *
 * When `WEAVE_LOG_FILE` is set, logs are written to that file path instead
 * of stdout. This prevents Weave's structured JSON logs from surfacing in
 * the OpenCode UI (which reads stdout/stderr).
 *
 * When unset, pino uses its default destination (stdout).
 *
 * Note: reads directly from `process.env` to avoid a circular dependency
 * with `@weave/engine` (which owns the validated `env` object).
 */
function resolveDestination(): pino.DestinationStream | undefined {
  const logFile = process.env.WEAVE_LOG_FILE;
  if (!logFile) return undefined;
  return pino.destination({ dest: logFile, sync: false });
}

/**
 * Package-local pino logger for `@weave/config`.
 *
 * All log output from the config discovery, merge, and loading pipeline is
 * emitted under the `"weave:config"` name so it can be filtered independently
 * from the engine logger.
 *
 * Log level is controlled at runtime via the `LOG_LEVEL` environment variable
 * (default: `"info"`). The test setup preload sets `LOG_LEVEL=silent` so that
 * pino output does not pollute test results.
 *
 * When `WEAVE_LOG_FILE` is set in the environment, all log output is written
 * to that file instead of stdout. This is the recommended configuration when
 * running as an OpenCode plugin to avoid polluting the OpenCode UI with
 * Weave's structured JSON logs.
 *
 * @example
 * ```ts
 * import { logger } from "./logger.js";
 * const log = logger.child({ module: "discovery" });
 * log.debug({ path }, "Checking config file");
 * ```
 */
const destination = resolveDestination();

export const logger = destination
  ? pino(
      { name: "weave:config", level: process.env.LOG_LEVEL ?? "info" },
      destination,
    )
  : pino({ name: "weave:config", level: process.env.LOG_LEVEL ?? "info" });
