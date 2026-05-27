import { err, ok, type Result } from "neverthrow";
import pino from "pino";
import { z } from "zod";

/**
 * Valid pino log levels. Kept in sync with pino's Level type so the
 * engine logger accepts exactly what pino understands.
 */
const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

/**
 * Schema for all environment variables consumed by @weave/engine.
 *
 * Add new variables here as the engine grows. Every variable is
 * validated once at process start so the rest of the codebase works
 * with typed values rather than `string | undefined`.
 */
export const envSchema = z.object({
  LOG_LEVEL: z
    .enum(LOG_LEVELS, {
      error: () => ({
        message: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`,
      }),
    })
    .optional()
    .default("info"),

  /**
   * Optional absolute path to a log file.
   *
   * When set, all Weave engine and config log output is written to this file
   * instead of stdout. This prevents Weave's structured JSON logs from
   * surfacing in the OpenCode UI (which reads stdout/stderr).
   *
   * Example: `WEAVE_LOG_FILE=/tmp/weave.log bun run start`
   *
   * When unset (the default), pino writes to stdout as usual.
   */
  WEAVE_LOG_FILE: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Typed error returned when environment validation fails.
 */
export type EnvValidationError = {
  type: "InvalidEnv";
  issues: { path: string; message: string }[];
};

/**
 * Parse and validate a raw environment object against the schema.
 *
 * Accepts an explicit `raw` argument so callers in tests can pass
 * arbitrary objects without mutating `process.env`.
 *
 * Returns `ok(Env)` on success or `err(EnvValidationError)` on failure.
 */
export function parseEnv(
  raw: Record<string, string | undefined> = Bun.env,
): Result<Env, EnvValidationError> {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: String(issue.path.join(".")),
      message: issue.message,
    }));
    return err({ type: "InvalidEnv", issues });
  }

  return ok(result.data);
}

/**
 * Validated, typed snapshot of `process.env` for @weave/engine.
 *
 * Evaluated once when the module is first imported. An invalid
 * environment logs a fatal message and exits the process before any
 * agents start.
 *
 * Note: uses pino directly (not the shared logger) to avoid a circular
 * dependency — logger.ts imports env.ts to read LOG_LEVEL.
 *
 * When `WEAVE_LOG_FILE` is set, the startup fatal message is also written
 * to that file instead of stdout, consistent with the shared logger.
 */
export const env: Env = parseEnv().match(
  (e) => e,
  (envErr) => {
    const logFile = Bun.env.WEAVE_LOG_FILE;
    const startupLogger = logFile
      ? pino({ name: "weave" }, pino.destination({ dest: logFile, sync: true }))
      : pino({ name: "weave" });
    startupLogger.fatal(
      { err: envErr },
      "[weave] Invalid environment variables",
    );
    process.exit(1);
  },
);
