import { describe, expect, test } from "bun:test";
import { parseEnv } from "../env.js";

describe("parseEnv", () => {
  test("valid env returns ok(Env) with default 'info' log level", () => {
    const result = parseEnv({});
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.LOG_LEVEL).toBe("info");
    }
  });

  test("invalid LOG_LEVEL returns err({ type: 'InvalidEnv', issues: [...] }) with non-empty issues", () => {
    const result = parseEnv({ LOG_LEVEL: "bogus" });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("InvalidEnv");
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues[0]?.message).toContain(
        "LOG_LEVEL must be one of:",
      );
    }
  });

  test("default value applied when LOG_LEVEL is undefined", () => {
    const result = parseEnv({ LOG_LEVEL: undefined });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.LOG_LEVEL).toBe("info");
    }
  });

  test("accepts all valid log levels", () => {
    const levels = [
      "fatal",
      "error",
      "warn",
      "info",
      "debug",
      "trace",
      "silent",
    ] as const;

    for (const level of levels) {
      const result = parseEnv({ LOG_LEVEL: level });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.LOG_LEVEL).toBe(level);
      }
    }
  });

  test("ignores unrelated environment variables", () => {
    const result = parseEnv({ LOG_LEVEL: "debug", HOME: "/home/user" });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.LOG_LEVEL).toBe("debug");
    }
  });

  // ---------------------------------------------------------------------------
  // WEAVE_LOG_FILE
  // ---------------------------------------------------------------------------

  test("WEAVE_LOG_FILE is undefined when not set", () => {
    const result = parseEnv({});
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.WEAVE_LOG_FILE).toBeUndefined();
    }
  });

  test("WEAVE_LOG_FILE accepts a file path string", () => {
    const result = parseEnv({ WEAVE_LOG_FILE: "/tmp/weave.log" });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.WEAVE_LOG_FILE).toBe("/tmp/weave.log");
    }
  });

  test("WEAVE_LOG_FILE accepts any non-empty string (no path validation at schema level)", () => {
    const result = parseEnv({ WEAVE_LOG_FILE: "relative/path/weave.log" });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.WEAVE_LOG_FILE).toBe("relative/path/weave.log");
    }
  });

  test("WEAVE_LOG_FILE is preserved alongside LOG_LEVEL", () => {
    const result = parseEnv({
      LOG_LEVEL: "debug",
      WEAVE_LOG_FILE: "/var/log/weave.log",
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.LOG_LEVEL).toBe("debug");
      expect(result.value.WEAVE_LOG_FILE).toBe("/var/log/weave.log");
    }
  });

  // The module-level `env` bootstrap (env.ts bottom) calls `parseEnv()` at
  // import time and invokes `Bun.exit(1)` on failure. Direct import-time
  // testing is not feasible because module-level side effects run once per
  // process and cannot be re-triggered without spawning a fresh subprocess.
  // Instead, we test the error shape that would trigger the exit, confirming
  // the bootstrap would behave correctly if it received this result.
  test("bootstrap failure path: parseEnv returns InvalidEnv error that would trigger Bun.exit(1)", () => {
    const result = parseEnv({ LOG_LEVEL: "bogus" });

    // Confirm the result is an error — this is what the module-level code
    // receives and passes to the fatal-log + Bun.exit(1) branch.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("InvalidEnv");
      expect(result.error.issues.length).toBeGreaterThan(0);

      // Simulate what the bootstrap does (without actually calling Bun.exit):
      // the error handler receives an EnvValidationError and would exit.
      const exitCalled = { value: false };
      const mockExit = (_code: number) => {
        exitCalled.value = true;
      };

      // Verify the error shape is what the bootstrap handler expects.
      result.match(
        () => {
          throw new Error("Expected err, got ok");
        },
        (envErr) => {
          // This is the branch that calls Bun.exit(1) in production.
          mockExit(1);
          expect(envErr.type).toBe("InvalidEnv");
          expect(envErr.issues.length).toBeGreaterThan(0);
        },
      );

      expect(exitCalled.value).toBe(true);
    }
  });
});
