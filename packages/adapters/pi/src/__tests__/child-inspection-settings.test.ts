import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";

import {
  DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
  PiChildInspectionSettingsSchema,
  effectivePiChildInspectionSettings,
  formatPiChildInspectionSettingsIssues,
  parsePiChildInspectionSettings,
  resolvePiChildInspectionSettings,
} from "../child-inspection-settings.js";

const configWithAdapters = (adapters: unknown): WeaveConfig =>
  ({ settings: { adapters } }) as WeaveConfig;

describe("Pi child-inspection settings", () => {
  it("uses the exact Pi adapter defaults and freezes the effective object", () => {
    const result = parsePiChildInspectionSettings({});

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      persist_history: true,
      max_bytes_per_child: 4_194_304,
      max_bytes_total: 67_108_864,
      orphan_retention_days: 30,
      recovery_enabled: true,
      recovery_countdown_seconds: 10,
    });
    expect(result._unsafeUnwrap()).not.toBe(
      DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    );
    expect(Object.isFrozen(result._unsafeUnwrap())).toBe(true);
  });

  it("accepts boundary values and preserves valid Pi-local values", () => {
    const result = parsePiChildInspectionSettings({
      persist_history: false,
      max_bytes_per_child: 65_536,
      max_bytes_total: 1_073_741_824,
      orphan_retention_days: 3_650,
      recovery_enabled: false,
      recovery_countdown_seconds: 0,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().max_bytes_per_child).toBe(65_536);
    expect(result._unsafeUnwrap().max_bytes_total).toBe(1_073_741_824);
  });

  it("aggregates unknown, type, range, and cross-field issues", () => {
    const result = parsePiChildInspectionSettings({
      persist_history: "yes",
      max_bytes_per_child: 65_535,
      max_bytes_total: 1_048_576,
      orphan_retention_days: 3_651,
      recovery_countdown_seconds: 61,
      typo: true,
    });

    expect(result.isErr()).toBe(true);
    const issues = result._unsafeUnwrapErr();
    expect(issues.length).toBe(5);
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "invalid_type",
        "too_small",
        "too_big",
        "unrecognized_keys",
      ]),
    );
    expect(formatPiChildInspectionSettingsIssues(issues)).toContain("typo");
    expect(formatPiChildInspectionSettingsIssues(issues)).toContain(
      "max_bytes_per_child",
    );
  });

  it("reports the total-size relation after applying field defaults", () => {
    const result = parsePiChildInspectionSettings({
      max_bytes_per_child: 67_108_864,
      max_bytes_total: 1_048_576,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toHaveLength(1);
    expect(result._unsafeUnwrapErr()[0]?.path).toEqual(["max_bytes_total"]);
  });

  it("validates only Pi's child block and leaves other adapters opaque", () => {
    const result = resolvePiChildInspectionSettings(
      configWithAdapters({
        other_harness: { unknown: ["values", null] },
        pi: { child_inspection: { recovery_enabled: false } },
      }),
    );

    expect(result.isOk()).toBe(true);
    const resolution = result._unsafeUnwrap();
    expect(resolution.status).toBe("valid");
    if (resolution.status === "valid") {
      expect(resolution.settings.recovery_enabled).toBe(false);
      expect(resolution.settings.max_bytes_total).toBe(
        DEFAULT_PI_CHILD_INSPECTION_SETTINGS.max_bytes_total,
      );
    }
  });

  it("rejects unknown child keys without partially applying valid siblings", () => {
    const parsed = PiChildInspectionSettingsSchema.safeParse({
      max_bytes_per_child: 65_536,
      unknown: 123,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(
        true,
      );
    }
  });

  it("requires an explicit policy for invalid settings", () => {
    const resolution = {
      status: "invalid" as const,
      issues: [
        {
          code: "too_big",
          path: ["max_bytes_total"],
          message: "too large",
        },
      ],
    };
    const defaults = effectivePiChildInspectionSettings(resolution, "defaults");
    const healthOnly = effectivePiChildInspectionSettings(resolution);

    expect(defaults.mode).toBe("defaults");
    expect(healthOnly.mode).toBe("health-only");
    expect(defaults.settings).toBe(DEFAULT_PI_CHILD_INSPECTION_SETTINGS);
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults.settings)).toBe(true);
  });
});
