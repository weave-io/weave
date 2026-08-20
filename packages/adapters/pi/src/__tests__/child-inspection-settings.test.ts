import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";

import {
  childInspectionOverlayKeyOverrides,
  DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
  effectivePiChildInspectionSettings,
  formatPiChildInspectionSettingsIssues,
  PiChildInspectionSettingsSchema,
  parsePiChildInspectionSettings,
  resolvePiChildInspectionSettings,
} from "../child-inspection-settings.js";
import { PI_CHILD_OVERLAY_ACTION_IDS } from "../child-overlay-keys.js";

const configWithAdapters = (adapters: unknown): WeaveConfig =>
  ({ settings: { adapters } }) as WeaveConfig;

describe("Pi child-inspection settings", () => {
  it("uses the exact Pi adapter defaults and freezes the effective object", () => {
    const result = parsePiChildInspectionSettings({});

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      recovery_enabled: true,
      recovery_countdown_seconds: 10,
    });
    expect(result._unsafeUnwrap()).not.toBe(
      DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    );
    expect(Object.isFrozen(result._unsafeUnwrap())).toBe(true);
  });

  it("accepts boundary values and preserves valid Pi-local values", () => {
    const lower = parsePiChildInspectionSettings({
      recovery_enabled: false,
      recovery_countdown_seconds: 0,
    });
    const upper = parsePiChildInspectionSettings({
      recovery_countdown_seconds: 60,
    });

    expect(lower.isOk()).toBe(true);
    expect(lower._unsafeUnwrap().recovery_enabled).toBe(false);
    expect(lower._unsafeUnwrap().recovery_countdown_seconds).toBe(0);
    expect(upper.isOk()).toBe(true);
    expect(upper._unsafeUnwrap().recovery_countdown_seconds).toBe(60);
  });

  it("aggregates unknown, type, and range issues", () => {
    const result = parsePiChildInspectionSettings({
      recovery_enabled: "yes",
      recovery_countdown_seconds: 61,
      typo: true,
    });

    expect(result.isErr()).toBe(true);
    const issues = result._unsafeUnwrapErr();
    expect(issues.length).toBe(3);
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["invalid_type", "too_big", "unrecognized_keys"]),
    );
    expect(formatPiChildInspectionSettingsIssues(issues)).toContain("typo");
    expect(formatPiChildInspectionSettingsIssues(issues)).toContain(
      "recovery_countdown_seconds",
    );
  });

  it("rejects removed quota and retention keys as unknown", () => {
    const result = parsePiChildInspectionSettings({
      persist_history: true,
      max_bytes_per_child: 65_536,
      max_bytes_total: 1_073_741_824,
      orphan_retention_days: 30,
    });

    expect(result.isErr()).toBe(true);
    const formatted = formatPiChildInspectionSettingsIssues(
      result._unsafeUnwrapErr(),
    );
    expect(formatted).toContain("persist_history");
    expect(formatted).toContain("max_bytes_per_child");
    expect(formatted).toContain("max_bytes_total");
    expect(formatted).toContain("orphan_retention_days");
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
      expect(resolution.settings.recovery_countdown_seconds).toBe(
        DEFAULT_PI_CHILD_INSPECTION_SETTINGS.recovery_countdown_seconds,
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
      expect(
        parsed.error.issues.some((issue) => issue.code === "unrecognized_keys"),
      ).toBe(true);
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

  it("formats already-qualified issue paths without duplicating the prefix", () => {
    expect(
      formatPiChildInspectionSettingsIssues([
        {
          code: "invalid_type",
          path: ["settings", "adapters", "pi"],
          message: "expected an object",
        },
      ]),
    ).toBe("settings.adapters.pi: expected an object");
  });

  it("accepts Task 13 key overrides and rejects unknown action ids", () => {
    const parsed = parsePiChildInspectionSettings({
      keys: {
        "weave.child.picker.open": "ctrl+p",
        "weave.child.slot.1": ["alt+1", "ctrl+1"],
      },
    });
    expect(parsed.isOk()).toBe(true);
    const overrides = childInspectionOverlayKeyOverrides(
      parsed._unsafeUnwrap(),
    );
    expect(overrides.get("weave.child.picker.open")).toEqual(["ctrl+p"]);
    expect(overrides.get("weave.child.slot.1")).toEqual(["alt+1", "ctrl+1"]);
    expect(overrides.has("weave.child.sibling.next")).toBe(false);

    const unknown = parsePiChildInspectionSettings({
      keys: { "tui.escape": "escape" },
    });
    expect(unknown.isErr()).toBe(true);
    expect(
      unknown
        ._unsafeUnwrapErr()
        .some((issue) => issue.code === "unrecognized_keys"),
    ).toBe(true);
  });

  it("rejects the removed compact-view toggle instead of silently ignoring it", () => {
    // The compact view is gone and `Ctrl+O` is Pi's own action. A config that
    // still rebinds the old id must fail loudly: parsing it into a binding
    // nothing reads would leave the operator believing the key still works.
    for (const removedId of [
      "weave.child.view.toggle",
      "weave.child.viewMode",
      "weave.child.compact",
    ]) {
      const parsed = parsePiChildInspectionSettings({
        keys: { [removedId]: "ctrl+o" },
      });
      expect(parsed.isErr()).toBe(true);
      const issues = parsed._unsafeUnwrapErr();
      expect(issues.some((issue) => issue.code === "unrecognized_keys")).toBe(
        true,
      );
      // The rejection names the id, so the fix is obvious from the message.
      expect(
        issues.some((issue) => issue.keys?.includes(removedId) === true),
      ).toBe(true);
    }

    // No declared action id can bind ctrl+o either.
    expect(
      PI_CHILD_OVERLAY_ACTION_IDS.some((id) => /view|compact/i.test(id)),
    ).toBe(false);
  });
});
