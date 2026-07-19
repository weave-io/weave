import { describe, expect, it } from "bun:test";
import {
  validateApiExtractorConfig,
  validateApiExtractorConfigs,
} from "../../validate-api-extractor-configs.js";

describe("API Extractor configuration", () => {
  it("accepts every declaration rollup configuration", () => {
    expect(validateApiExtractorConfigs().isOk()).toBe(true);
  });

  it("rejects unknown declaration configuration", () => {
    expect(
      validateApiExtractorConfig(
        "scripts/release/__fixtures__/invalid-api-extractor.json",
      ).isErr(),
    ).toBe(true);
  });
});
