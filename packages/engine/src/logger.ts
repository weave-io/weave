import pino from "pino";
import { env } from "./env.js";

/**
 * A minimal duck-typed stream that pino accepts as a destination.
 *
 * Pino calls `write(chunk)` directly on the destination object — it does not
 * go through Node.js stream machinery. This means we can use a plain object
 * with a `write` method instead of a full `Writable` subclass, avoiding the
 * async `_write` dispatch that would break synchronous file writes.
 *
 * The inner sink is replaceable via `redirectTo()`. All subsequent `write()`
 * calls go to the new sink. This is the mechanism that lets
 * `redirectLogsToFile` work without recreating the pino logger.
 */
interface PinoWritable {
  write(chunk: string): boolean;
}

class MutableDestination {
  private _sink: PinoWritable;

  constructor(initialSink: PinoWritable) {
    this._sink = initialSink;
  }

  /**
   * Replace the inner sink. All subsequent writes go to `newSink`.
   * The previous sink is NOT closed — callers are responsible for lifecycle.
   */
  redirectTo(newSink: PinoWritable): void {
    this._sink = newSink;
  }

  write(chunk: string): boolean {
    return this._sink.write(chunk);
  }

  /**
   * Flush the inner sink if it supports flushing (e.g. SonicBoom).
   * No-op if the sink does not support flushing.
   */
  flush(callback?: (err?: Error) => void): void {
    const sink = this._sink as PinoWritable & {
      flush?: (cb?: (err?: Error) => void) => void;
    };
    if (typeof sink.flush === "function") {
      sink.flush(callback);
    } else {
      callback?.();
    }
  }

  /**
   * Synchronously flush the inner sink if it supports sync flushing
   * (e.g. SonicBoom's `flushSync`). No-op if the sink does not support it.
   */
  flushSync(): void {
    const sink = this._sink as PinoWritable & { flushSync?: () => void };
    if (typeof sink.flushSync === "function") {
      sink.flushSync();
    }
  }
}

/**
 * Build the initial inner sink for the logger.
 *
 * Priority:
 * 1. `WEAVE_LOG_FILE` env var — explicit override, always wins.
 * 2. `process.stdout` — default when no env var is set.
 *
 * When `WEAVE_LOG_FILE` is set we use `pino.destination()` (SonicBoom) for
 * high-throughput async file writes. For stdout we use `process.stdout`
 * directly so the default path has zero overhead.
 */
function buildInitialSink(): PinoWritable {
  if (env.WEAVE_LOG_FILE) {
    return pino.destination({
      dest: env.WEAVE_LOG_FILE,
      sync: false,
      mkdir: true,
    });
  }
  return process.stdout;
}

/**
 * Shared mutable destination used by the engine logger.
 *
 * Exported so that `redirectLogsToFile` can call `redirectTo()` on it.
 * Do not write to this directly — use the `logger` export instead.
 */
export const logDestination = new MutableDestination(buildInitialSink());

/**
 * Shared pino logger for the Weave engine.
 *
 * Child loggers are derived from this root instance so that all engine
 * output shares a consistent `name` field and can be filtered uniformly
 * by log level at runtime (e.g. `LOG_LEVEL=debug bun run start`).
 *
 * **Default behavior**: logs go to stdout unless `WEAVE_LOG_FILE` is set
 * or `redirectLogsToFile()` is called before the first log write.
 *
 * **OpenCode plugin path**: the plugin entry point calls
 * `redirectLogsToFile(join(directory, '.weave', 'weave.log'))` at startup
 * so that all Weave logs are written to a project-local file instead of
 * stdout. This prevents structured JSON logs from surfacing in the OpenCode
 * UI. `WEAVE_LOG_FILE` overrides this automatic path.
 *
 * @example
 * ```ts
 * import { logger } from "./logger.js";
 *
 * const log = logger.child({ module: "runner" });
 * log.info({ agent: "coder" }, "Spawning agent");
 * ```
 */
export const logger = pino(
  { name: "weave", level: env.LOG_LEVEL },
  logDestination as unknown as pino.DestinationStream,
);

/**
 * Redirect all Weave log output to a file.
 *
 * Swaps the inner sink of the shared `MutableDestination` to a new
 * `pino.destination()` (SonicBoom) stream pointing at `filePath`. All
 * subsequent log writes — from the root logger and any child loggers — go
 * to the file.
 *
 * Uses `sync: true` so that each write is flushed to disk before returning.
 * This is slightly slower than async writes but ensures log lines are
 * visible immediately — important for a plugin that may be killed at any
 * time by the harness. For a log file (not a hot path), the overhead is
 * acceptable.
 *
 * Returns a `Promise<void>` that resolves when the file sink is open and
 * ready to accept writes. Awaiting this promise ensures the file exists
 * before any log calls are made.
 *
 * **When to call**: call this once, as early as possible in the process
 * lifecycle — ideally before any log statements execute. The OpenCode plugin
 * entry point calls this at the very start of `createWeavePlugin`.
 *
 * **Idempotency**: calling this multiple times is safe; each call replaces
 * the sink. The last call wins.
 *
 * **`WEAVE_LOG_FILE` takes precedence**: the caller is responsible for
 * checking `env.WEAVE_LOG_FILE` before calling this function if it wants
 * to preserve the env-var override semantics. The plugin does this check
 * explicitly.
 *
 * @param filePath - Absolute path to the log file. Parent directories are
 *   created automatically (`mkdir: true` is set on the SonicBoom destination).
 * @returns A `Promise<void>` that resolves when the file sink is ready.
 */
export function redirectLogsToFile(filePath: string): Promise<void> {
  const fileSink = pino.destination({
    dest: filePath,
    sync: true,
    mkdir: true,
  });
  logDestination.redirectTo(fileSink);
  // Wait for SonicBoom to open the file before resolving. This ensures that
  // callers who await this function can safely write to the file immediately.
  return new Promise<void>((resolve, reject) => {
    fileSink.once("ready", resolve);
    fileSink.once("error", reject);
  });
}
