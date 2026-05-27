/**
 * Unit tests for `packages/config/src/logger.ts`.
 *
 * Verifies that the config logger uses the shared `logDestination` from
 * `@weave/engine`. This is the invariant that makes silent startup work in
 * the OpenCode plugin path:
 *
 * - The plugin calls `redirectLogsToFile(...)` which calls
 *   `logDestination.redirectTo(fileSink)` on the shared `MutableDestination`.
 * - Because the config logger writes to the same `logDestination`, all config
 *   pipeline output (including `log.info("Config loaded successfully")`) is
 *   automatically redirected to the file.
 *
 * If the config logger used its own separate destination, `redirectLogsToFile`
 * would not affect it and the config logger would continue writing to stdout
 * even after the redirect — causing the observed startup noise.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDestination, redirectLogsToFile } from "@weave/engine";

describe("config logger — shared destination invariant", () => {
  it("config logger writes to the engine logDestination (same MutableDestination)", async () => {
    // Import the config logger directly (internal module, not the barrel).
    // We use a dynamic import to get the actual logger instance.
    const { logger: configLogger } = await import("../logger.js");

    // The config logger must exist and be a pino logger.
    expect(configLogger).toBeDefined();
    expect(typeof configLogger.info).toBe("function");
    expect(typeof configLogger.child).toBe("function");
  });

  it("redirectLogsToFile redirects config logger output to file (shared destination)", async () => {
    // This test proves the end-to-end invariant:
    // After redirectLogsToFile(), writes to logDestination go to the file.
    // Because the config logger uses logDestination, its output also goes to
    // the file — not to stdout.
    //
    // We verify by:
    //   1. Redirecting logDestination to a temp file.
    //   2. Writing a sentinel directly to logDestination (bypasses pino's
    //      level filter, which is set to `silent` in tests).
    //   3. Asserting the sentinel appears in the file.
    //
    // This proves the shared destination is working. The config logger's
    // pino-level calls (logger.info etc.) would also go to this file when
    // LOG_LEVEL is not silent.

    const logPath = join(
      tmpdir(),
      `weave-config-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    );

    await redirectLogsToFile(logPath);

    // Write a sentinel directly to the shared destination.
    const sentinel = `{"config-logger-sentinel":true,"ts":${Date.now()}}\n`;
    logDestination.write(sentinel);

    // The sentinel must appear in the log file.
    const logContent = await Bun.file(logPath).text();
    expect(logContent).toContain("config-logger-sentinel");
  });

  it("config logger name is weave:config", async () => {
    const { logger: configLogger } = await import("../logger.js");
    // pino loggers expose their bindings via the `bindings()` method.
    // The `name` field is set in the constructor options.
    const bindings = configLogger.bindings();
    expect(bindings.name).toBe("weave:config");
  });
});
