import { logDestination } from "@weaveio/weave-engine";
import pino from "pino";

/**
 * Package-local pino logger for `@weaveio/weave-config`.
 *
 * All log output from the config discovery, merge, and loading pipeline is
 * emitted under the `"weave:config"` name so it can be filtered independently
 * from the engine logger.
 *
 * ## Shared destination
 *
 * This logger writes to the **same** `MutableDestination` instance exported
 * by `@weaveio/weave-engine`. This is the key invariant that makes silent startup work
 * in the OpenCode plugin path:
 *
 * 1. The plugin calls `redirectLogsToFile(join(directory, '.weave/weave.log'))`
 *    at the very start of `createWeavePlugin`.
 * 2. `redirectLogsToFile` calls `logDestination.redirectTo(fileSink)` on the
 *    shared `MutableDestination`.
 * 3. Because this logger uses the same `logDestination`, all subsequent writes
 *    from the config pipeline (including `log.info("Config loaded successfully")`)
 *    go to the file — not to stdout.
 *
 * If this logger used its own separate destination (as it did before this
 * change), `redirectLogsToFile` would not affect it and the config logger
 * would continue writing to stdout even after the redirect.
 *
 * ## Log level
 *
 * Log level is controlled at runtime via the `LOG_LEVEL` environment variable
 * (default: `"info"`). The test setup preload sets `LOG_LEVEL=silent` so that
 * pino output does not pollute test results.
 *
 * ## WEAVE_LOG_FILE
 *
 * When `WEAVE_LOG_FILE` is set, the engine's `buildInitialSink()` already
 * points `logDestination` at that file before this module is imported. No
 * additional handling is needed here — the shared destination handles it.
 *
 * @example
 * ```ts
 * import { logger } from "./logger.js";
 * const log = logger.child({ module: "discovery" });
 * log.debug({ path }, "Checking config file");
 * ```
 */
export const logger = pino(
  {
    name: "weave:config",
    level: process.env.LOG_LEVEL ?? "info",
  },
  logDestination as unknown as pino.DestinationStream,
);
