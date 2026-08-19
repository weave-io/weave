import { describe, expect, it } from "bun:test";
import {
  CONFIG_PATHS,
  validateApiExtractorConfig,
  validateApiExtractorConfigs,
} from "../../validate-api-extractor-configs.js";

describe("API Extractor configuration", () => {
  it("accepts every declaration rollup configuration", () => {
    expect(validateApiExtractorConfigs().isOk()).toBe(true);
    expect(CONFIG_PATHS).toContain(
      "packages/adapters/pi/api-extractor.cli.json",
    );
  });

  it("rejects unknown declaration configuration", () => {
    expect(
      validateApiExtractorConfig(
        "scripts/release/__fixtures__/invalid-api-extractor.json",
      ).isErr(),
    ).toBe(true);
  });
});
