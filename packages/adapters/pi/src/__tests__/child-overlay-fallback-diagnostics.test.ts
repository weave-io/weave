/**
 * Task 20(c) remediation coverage: every native-overlay → custom-editor
 * fallback must record a bounded, identifier-free reason code.
 *
 * The live Herdr run recorded a silent fallback and therefore no cause. These
 * tests pin the code vocabulary and the sanitisation guarantee that lets the
 * next run copy a diagnostic straight into a proof.
 */
import { describe, expect, it } from "bun:test";
import {
  type ChildOverlayOpenTerminalError,
  formatPiChildOverlayFallbackDiagnostic,
  isPiChildOverlayFallbackReasonCode,
  PI_CHILD_OVERLAY_FALLBACK_DIAGNOSTIC_PREFIX,
  PI_CHILD_OVERLAY_FALLBACK_REASON_CODES,
  type PiChildOverlayFallbackReasonCode,
  piChildOverlayFallbackReasonCode,
  piChildOverlayOpenErrorReasonCode,
  piChildOverlayOpenErrorReasonCodeFromUnknown,
} from "../child-overlay-fallback-diagnostics.js";

describe("child overlay fallback diagnostics", () => {
  it("exposes a closed, stable set of reason codes", () => {
    expect([...PI_CHILD_OVERLAY_FALLBACK_REASON_CODES]).toEqual([
      "preflight-not-native",
      "controller-absent",
      "generation-changed",
      "open-failed",
      "open-invalid-child",
      "open-source-not-ready",
      "open-source-corrupt",
      "open-source-unavailable",
      "open-child-not-found",
      "open-invalid-cursor",
      "open-capacity-exceeded",
      "open-not-open",
      "open-source-failed",
      "open-describe-failed",
      "open-describe-child-not-found",
      "open-describe-source-unavailable",
      "open-describe-source-corrupt",
      "open-describe-source-not-ready",
      "open-render-failed",
      "mounted-source-failed",
      "mounted-describe-failed",
      "mounted-render-failed",
      "no-tui-custom-surface",
    ]);
    expect(isPiChildOverlayFallbackReasonCode("open-failed")).toBe(true);
    expect(isPiChildOverlayFallbackReasonCode("something-else")).toBe(false);
  });

  it("formats a prefixed diagnostic carrying no identifier", () => {
    for (const code of PI_CHILD_OVERLAY_FALLBACK_REASON_CODES) {
      const diagnostic = formatPiChildOverlayFallbackDiagnostic(code);
      expect(diagnostic).toBe(
        `${PI_CHILD_OVERLAY_FALLBACK_DIAGNOSTIC_PREFIX} ${code}`,
      );
      // Bounded and free of paths, ids, prompts, and transcript text.
      expect(diagnostic.length).toBeLessThanOrEqual(64);
      expect(diagnostic).not.toContain("/");
      expect(diagnostic).not.toMatch(/[0-9]/);
    }
  });

  it("refuses to echo an unknown code into a diagnostic", () => {
    // A dynamic string is the only way an identifier could reach the ledger.
    const smuggled = "child-abc123 /Users/someone/secret" as never;
    expect(formatPiChildOverlayFallbackDiagnostic(smuggled)).toBe(
      `${PI_CHILD_OVERLAY_FALLBACK_DIAGNOSTIC_PREFIX} open-failed`,
    );
  });

  it("maps controller fallback reasons per stage", () => {
    expect(piChildOverlayFallbackReasonCode("source-failed", "open")).toBe(
      "open-source-failed",
    );
    expect(piChildOverlayFallbackReasonCode("source-failed", "mounted")).toBe(
      "mounted-source-failed",
    );
    expect(piChildOverlayFallbackReasonCode("describe-failed", "open")).toBe(
      "open-describe-failed",
    );
    expect(piChildOverlayFallbackReasonCode("describe-failed", "mounted")).toBe(
      "mounted-describe-failed",
    );
    expect(piChildOverlayFallbackReasonCode("render-failed", "open")).toBe(
      "open-render-failed",
    );
    expect(piChildOverlayFallbackReasonCode("render-failed", "mounted")).toBe(
      "mounted-render-failed",
    );
    // Unknown reasons collapse instead of leaking free-form text.
    expect(piChildOverlayFallbackReasonCode("child-xyz", "open")).toBe(
      "open-failed",
    );
  });

  it("names which source error caused an open describe fallback", () => {
    // Task 20(c): `open-describe-failed` alone could not tell an absent
    // controller from an unknown child, so a live run could not name its
    // blocker. Each fallback-classified source error now has its own subcode.
    expect(
      piChildOverlayFallbackReasonCode(
        "describe-failed",
        "open",
        "ChildNotFound",
      ),
    ).toBe("open-describe-child-not-found");
    expect(
      piChildOverlayFallbackReasonCode(
        "describe-failed",
        "open",
        "SourceUnavailable",
      ),
    ).toBe("open-describe-source-unavailable");
    expect(
      piChildOverlayFallbackReasonCode(
        "describe-failed",
        "open",
        "SourceCorrupt",
      ),
    ).toBe("open-describe-source-corrupt");
    expect(
      piChildOverlayFallbackReasonCode(
        "describe-failed",
        "open",
        "SourceStartupNotReady",
      ),
    ).toBe("open-describe-source-not-ready");
    // SourceInvalidCursor is impossible on the describe-fallback path: open
    // keeps it as a terminal open error (`open-invalid-cursor`), so a
    // smuggled/mismatched describe lookup must stay generic.
    expect(
      piChildOverlayFallbackReasonCode(
        "describe-failed",
        "open",
        "SourceInvalidCursor",
      ),
    ).toBe("open-describe-failed");
    // An absent, unmodelled, or smuggled discriminant stays generic.
    expect(piChildOverlayFallbackReasonCode("describe-failed", "open")).toBe(
      "open-describe-failed",
    );
    expect(
      piChildOverlayFallbackReasonCode(
        "describe-failed",
        "open",
        "child-abc123 /Users/someone",
      ),
    ).toBe("open-describe-failed");
    expect(
      piChildOverlayFallbackReasonCode(
        "describe-failed",
        "open",
        "constructor",
      ),
    ).toBe("open-describe-failed");
    // Other stages and reasons are untouched by the subcode selection.
    expect(
      piChildOverlayFallbackReasonCode(
        "describe-failed",
        "mounted",
        "SourceUnavailable",
      ),
    ).toBe("mounted-describe-failed");
    expect(
      piChildOverlayFallbackReasonCode(
        "source-failed",
        "open",
        "SourceUnavailable",
      ),
    ).toBe("open-source-failed");
  });

  it("rejects non-string describe sourceErrorType values without throwing", () => {
    // Unknown-runtime boundary: typeof === "string" before any map lookup.
    // Coercion, Symbol.toStringTag, or a throwing toString must never run.
    const throwingToString = {
      toString(): string {
        throw new Error("toString must not run");
      },
      valueOf(): string {
        throw new Error("valueOf must not run");
      },
    };
    const cases: readonly unknown[] = [
      undefined,
      null,
      0,
      1,
      true,
      false,
      Symbol("SourceUnavailable"),
      throwingToString,
      ["ChildNotFound"],
      { type: "ChildNotFound" },
      Object.create(null),
    ];
    for (const value of cases) {
      expect(
        piChildOverlayFallbackReasonCode("describe-failed", "open", value),
      ).toBe("open-describe-failed");
    }
    expect(
      piChildOverlayFallbackReasonCode("describe-failed", "open", "toString"),
    ).toBe("open-describe-failed");
    expect(
      piChildOverlayFallbackReasonCode("describe-failed", "open", "__proto__"),
    ).toBe("open-describe-failed");
    expect(
      piChildOverlayFallbackReasonCode(
        "describe-failed",
        "open",
        "constructor",
      ),
    ).toBe("open-describe-failed");
  });

  it("maps every typed non-fallback open error to its own bounded subcode", () => {
    // Typed path: closed-union members only. A new ChildOverlayError variant
    // that reaches this branch fails typecheck until the exhaustive map and
    // never-checked switch are updated.
    const typedCases: readonly {
      readonly error: ChildOverlayOpenTerminalError;
      readonly code: PiChildOverlayFallbackReasonCode;
    }[] = [
      {
        error: { type: "OverlayInvalidChild", issues: ["title"] },
        code: "open-invalid-child",
      },
      {
        error: { type: "SourceStartupNotReady", operation: "loadNewest" },
        code: "open-source-not-ready",
      },
      {
        error: { type: "SourceCorrupt", operation: "loadNewest" },
        code: "open-source-corrupt",
      },
      {
        error: { type: "SourceUnavailable", operation: "describe" },
        code: "open-source-unavailable",
      },
      {
        error: { type: "ChildNotFound", childId: "opaque-child" },
        code: "open-child-not-found",
      },
      {
        error: { type: "SourceInvalidCursor", operation: "loadOlder" },
        code: "open-invalid-cursor",
      },
      {
        error: {
          type: "OverlayCapacityExceeded",
          operation: "entry-content-blocks",
        },
        code: "open-capacity-exceeded",
      },
      {
        error: { type: "OverlayNotOpen" },
        code: "open-not-open",
      },
    ];
    for (const { error, code } of typedCases) {
      expect(piChildOverlayOpenErrorReasonCode(error)).toBe(code);
      // Payload fields never leak into the reason code.
      expect(piChildOverlayOpenErrorReasonCode(error)).not.toContain("/");
      expect(piChildOverlayOpenErrorReasonCode(error)).not.toMatch(/opaque/);
    }
  });

  it("maps known discriminators and rejects unknown runtime shapes safely", () => {
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({
        type: "OverlayInvalidChild",
      }),
    ).toBe("open-invalid-child");
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({
        type: "SourceStartupNotReady",
      }),
    ).toBe("open-source-not-ready");
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({ type: "SourceCorrupt" }),
    ).toBe("open-source-corrupt");
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({
        type: "SourceUnavailable",
      }),
    ).toBe("open-source-unavailable");
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({ type: "ChildNotFound" }),
    ).toBe("open-child-not-found");
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({
        type: "SourceInvalidCursor",
      }),
    ).toBe("open-invalid-cursor");
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({
        type: "OverlayCapacityExceeded",
      }),
    ).toBe("open-capacity-exceeded");
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({ type: "OverlayNotOpen" }),
    ).toBe("open-not-open");
    // Smuggled or unmodelled shapes stay generic rather than echoing anything.
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({
        type: "child-abc123 /Users/someone",
      }),
    ).toBe("open-failed");
    expect(piChildOverlayOpenErrorReasonCodeFromUnknown({})).toBe(
      "open-failed",
    );
    expect(piChildOverlayOpenErrorReasonCodeFromUnknown(null)).toBe(
      "open-failed",
    );
    expect(piChildOverlayOpenErrorReasonCodeFromUnknown("OverlayNotOpen")).toBe(
      "open-failed",
    );
  });

  it("rejects Object.prototype key names at the unknown runtime boundary", () => {
    // `type in map` is true for inherited names; own-key checks must not.
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({ type: "toString" }),
    ).toBe("open-failed");
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({ type: "constructor" }),
    ).toBe("open-failed");
    expect(
      piChildOverlayOpenErrorReasonCodeFromUnknown({ type: "__proto__" }),
    ).toBe("open-failed");
  });
});
