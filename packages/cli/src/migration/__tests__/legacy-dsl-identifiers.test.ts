/**
 * Identifier contract tests for legacy conversion name emission.
 */

import { describe, expect, it } from "bun:test";
import {
  classifyDslName,
  isDangerousDslName,
  isDslIdentifierShape,
  isEmittableDslName,
  MAX_DSL_IDENTIFIER_LENGTH,
} from "../legacy-dsl-identifiers.js";

describe("legacy DSL identifier contract", () => {
  it("accepts current lexer identifier shapes", () => {
    for (const name of ["loom", "my-helper", "backend", "_ok", "a1", "A_b-c"]) {
      expect(classifyDslName(name)).toBe("ok");
      expect(isEmittableDslName(name)).toBe(true);
    }
  });

  it("rejects braces, newlines, control characters, and other invalid shapes", () => {
    for (const name of [
      'helper} agent evil { prompt "injected"',
      "has\nnewline",
      "has\rreturn",
      "has\ttab",
      "has space",
      "1leading",
      "dot.name",
      "slash/name",
      "",
      "a".repeat(MAX_DSL_IDENTIFIER_LENGTH + 1),
    ]) {
      expect(isDslIdentifierShape(name)).toBe(false);
      expect(classifyDslName(name)).toBe("invalid");
      expect(isEmittableDslName(name)).toBe(false);
    }
  });

  it("rejects dangerous names even when they match identifier shape", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(isDangerousDslName(name)).toBe(true);
      expect(isDslIdentifierShape(name)).toBe(true);
      expect(classifyDslName(name)).toBe("dangerous");
      expect(isEmittableDslName(name)).toBe(false);
    }
  });
});
