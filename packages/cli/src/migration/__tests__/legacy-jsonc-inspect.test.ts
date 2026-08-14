/**
 * JSONC CST inspection tests: duplicates, dangerous keys, and source bounds.
 */

import { describe, expect, it } from "bun:test";
import {
  CONVERSION_REASON,
  PATH_SOURCE,
} from "../legacy-conversion-diagnostics.js";
import { MAX_LEGACY_SOURCE_LENGTH } from "../legacy-graph-copy.js";
import { inspectLegacyJsonc } from "../legacy-jsonc-inspect.js";

describe("inspectLegacyJsonc", () => {
  it("accepts unique keys including comments and trailing commas", () => {
    const result = inspectLegacyJsonc(
      `{ "log_level": "INFO", /* c */ "agents": { "loom": { "temperature": 0.1, } } }`,
    );
    expect(result.isOk()).toBe(true);
  });

  it("rejects duplicate keys at every object level before collapse", () => {
    const result = inspectLegacyJsonc(
      `{ "log_level": "INFO", "log_level": "DEBUG", "agents": { "loom": { "temperature": 0.1 }, "loom": { "temperature": 0.9 } } }`,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("UnsafeStructure");
      const fields = result.error.warnings.map((warning) => warning.field);
      expect(fields).toContain("log_level");
      expect(fields).toContain("agents.loom");
      expect(
        result.error.warnings.every(
          (warning) =>
            warning.reason === CONVERSION_REASON.duplicateKey ||
            warning.field === "<diagnostics>",
        ),
      ).toBe(true);
    }
  });

  it("rejects nested duplicate keys inside arrays", () => {
    const result = inspectLegacyJsonc(
      `{ "agents": { "loom": { "triggers": [ { "domain": "a", "domain": "b" } ] } } }`,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(
        result.error.warnings.some(
          (warning) =>
            warning.field === "agents.loom.triggers.0.domain" &&
            warning.reason === CONVERSION_REASON.duplicateKey,
        ),
      ).toBe(true);
    }
  });

  it("rejects dangerous object keys without echoing them as functions", () => {
    const result = inspectLegacyJsonc(
      `{ "constructor": 1, "agents": { "__proto__": { "temperature": 0.1 } } }`,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("UnsafeStructure");
      expect(
        result.error.warnings.every((warning) =>
          warning.reason.includes("dangerous"),
        ),
      ).toBe(true);
      const blob = JSON.stringify(result.error.warnings);
      expect(blob).not.toContain("[native code]");
      expect(blob).not.toContain("function ");
    }
  });

  it("rejects oversized source text before visit", () => {
    const result = inspectLegacyJsonc("x".repeat(MAX_LEGACY_SOURCE_LENGTH + 1));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("SourceTooLarge");
      expect(result.error.warnings[0]?.field).toBe(PATH_SOURCE);
      expect(result.error.warnings[0]?.reason).toBe(
        CONVERSION_REASON.sourceTooLarge,
      );
    }
  });

  it("maps malformed JSONC to a parse failure", () => {
    const result = inspectLegacyJsonc("{ invalid json !!!");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ParseFailed");
      expect(result.error.warnings[0]?.reason).toBe(
        CONVERSION_REASON.parseFailed,
      );
    }
  });
});
