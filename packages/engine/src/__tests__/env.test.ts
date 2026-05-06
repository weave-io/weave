import { describe, expect, test } from "bun:test";
import { parseEnv } from "../env.js";

describe("parseEnv", () => {
  test("defaults LOG_LEVEL to 'info' when not set", () => {
    const result = parseEnv({});
    expect(result.LOG_LEVEL).toBe("info");
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
      expect(result.LOG_LEVEL).toBe(level);
    }
  });

  test("throws with a descriptive message for an invalid LOG_LEVEL", () => {
    expect(() => parseEnv({ LOG_LEVEL: "verbose" })).toThrow(
      "LOG_LEVEL must be one of:",
    );
  });

  test("throws listing all invalid fields", () => {
    expect(() => parseEnv({ LOG_LEVEL: "bad" })).toThrow(
      "[weave] Invalid environment variables:",
    );
  });

  test("ignores unrelated environment variables", () => {
    const result = parseEnv({ LOG_LEVEL: "debug", HOME: "/home/user" });
    expect(result.LOG_LEVEL).toBe("debug");
  });
});
