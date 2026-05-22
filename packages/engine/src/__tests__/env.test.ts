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
});
