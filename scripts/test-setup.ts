/**
 * Bun test preload — runs before any test file is imported.
 *
 * Sets LOG_LEVEL=silent so that pino does not emit structured JSON logs
 * to stdout during test runs, keeping test output clean.
 */
process.env.LOG_LEVEL = "silent";
