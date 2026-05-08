import pino from "pino";

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
 * @example
 * ```ts
 * import { logger } from "./logger.js";
 * const log = logger.child({ module: "discovery" });
 * log.debug({ path }, "Checking config file");
 * ```
 */
export const logger = pino({
  name: "weave:config",
  level: process.env.LOG_LEVEL ?? "info",
});
