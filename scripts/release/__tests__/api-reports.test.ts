import { describe, expect, it } from "bun:test";
import {
  compareApiReportText,
  parseApiChangeset,
  validateApiReportCompatibility,
} from "../api-reports.js";

const PACKAGE = "@weaveio/weave-adapter-pi";
const CONFIG = "packages/adapters/pi/api-extractor.index.json";
const REPORT = "packages/adapters/pi/etc/weave-adapter-pi-index.api.md";

function comparison(before: string, after: string) {
  return compareApiReportText(before, after, {
    configPath: CONFIG,
    packageName: PACKAGE,
    reportPath: REPORT,
  });
}

describe("API report compatibility", () => {
  it("rejects a public API removal without a changeset", () => {
    const diff = comparison(
      ["// @public", "export declare function removedApi(): void;"].join("\n"),
      "// @public\n",
    );
    expect(diff.breaking).toBe(true);
    const result = validateApiReportCompatibility({
      comparisons: [diff],
      changesets: [],
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ApiReportDriftMissingChangeset");
  });

  it("requires an explicit Breaking marker and minor pre-1.0 bump", () => {
    const diff = comparison("export declare function removedApi(): void;", "");
    const missingMarker = validateApiReportCompatibility({
      comparisons: [diff],
      changesets: [
        {
          path: ".changeset/api.md",
          packageNames: [PACKAGE],
          bump: "minor",
          breaking: false,
        },
      ],
    });
    expect(missingMarker.isErr()).toBe(true);
    if (missingMarker.isErr())
      expect(missingMarker.error.type).toBe("ApiReportBreakingMissingMarker");

    const wrongBump = validateApiReportCompatibility({
      comparisons: [diff],
      changesets: [
        {
          path: ".changeset/api.md",
          packageNames: [PACKAGE],
          bump: "patch",
          breaking: true,
        },
      ],
    });
    expect(wrongBump.isErr()).toBe(true);
    if (wrongBump.isErr())
      expect(wrongBump.error.type).toBe("ApiReportBreakingBumpMismatch");
  });

  it("accepts additive drift with a matching changeset", () => {
    const diff = comparison(
      "",
      ["// @public", "export declare function newApi(): void;"].join("\n"),
    );
    const result = validateApiReportCompatibility({
      comparisons: [diff],
      changesets: [
        {
          path: ".changeset/api.md",
          packageNames: [PACKAGE],
          bump: "patch",
          breaking: false,
        },
      ],
    });
    expect(result.isOk()).toBe(true);
  });

  it("parses quoted package names and the explicit Breaking marker", () => {
    const result = parseApiChangeset(
      ".changeset/api.md",
      [
        "---",
        '"@weaveio/weave-adapter-pi": minor',
        "---",
        "Add a public API.",
        "",
        "Breaking: removed the old entry.",
      ].join("\n"),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.packageNames).toEqual([PACKAGE]);
      expect(result.value.bump).toBe("minor");
      expect(result.value.breaking).toBe(true);
    }
  });
});
