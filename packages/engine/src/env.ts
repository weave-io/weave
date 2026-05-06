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
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate a raw environment object against the schema.
 *
 * Accepts an explicit `raw` argument so callers in tests can pass
 * arbitrary objects without mutating `process.env`.
 *
 * @throws {Error} with a formatted message listing every invalid field
 *   when validation fails — intended to crash the process at startup.
 */
export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${String(issue.path.join("."))}: ${issue.message}`)
      .join("\n");
    throw new Error(`[weave] Invalid environment variables:\n${issues}`);
  }

  return result.data;
}

/**
 * Validated, typed snapshot of `process.env` for @weave/engine.
 *
 * Evaluated once when the module is first imported. An invalid
 * environment throws synchronously, crashing the process before any
 * agents start.
 */
export const env: Env = parseEnv();
