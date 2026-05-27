import pino from "pino";
import { env } from "./env.js";

/**
 * Resolve the pino destination for the engine logger.
 *
 * When `WEAVE_LOG_FILE` is set, logs are written to that file path instead
 * of stdout. This prevents Weave's structured JSON logs from surfacing in
 * the OpenCode UI (which reads stdout/stderr).
 *
 * When unset, pino uses its default destination (stdout).
 */
function resolveDestination(): pino.DestinationStream | undefined {
  if (!env.WEAVE_LOG_FILE) return undefined;
  return pino.destination({ dest: env.WEAVE_LOG_FILE, sync: false });
}

/**
 * Shared pino logger for the Weave engine.
 *
 * Child loggers are derived from this root instance so that all engine
 * output shares a consistent `name` field and can be filtered uniformly
 * by log level at runtime (e.g. `LOG_LEVEL=debug bun run start`).
 *
 * When `WEAVE_LOG_FILE` is set in the environment, all log output is
 * written to that file instead of stdout. This is the recommended
 * configuration when running as an OpenCode plugin to avoid polluting
 * the OpenCode UI with Weave's structured JSON logs.
 *
 * @example
 * ```ts
 * import { logger } from "./logger.js";
 *
 * const log = logger.child({ module: "runner" });
 * log.info({ agent: "coder" }, "Spawning agent");
 * ```
 */
const destination = resolveDestination();

export const logger = destination
  ? pino({ name: "weave", level: env.LOG_LEVEL }, destination)
  : pino({ name: "weave", level: env.LOG_LEVEL });
