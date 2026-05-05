import pino from "pino";

/**
 * Shared pino logger for the Weave engine.
 *
 * Child loggers are derived from this root instance so that all engine
 * output shares a consistent `name` field and can be filtered uniformly
 * by log level at runtime (e.g. `LOG_LEVEL=debug bun run start`).
 *
 * @example
 * ```ts
 * import { logger } from "./logger.js";
 *
 * const log = logger.child({ module: "runner" });
 * log.info({ agent: "coder" }, "Spawning agent");
 * ```
 */
export const logger = pino({
	name: "weave",
	level: process.env["LOG_LEVEL"] ?? "info",
});
