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
  formatPiChildOverlayFallbackDiagnostic,
  isPiChildOverlayFallbackReasonCode,
  PI_CHILD_OVERLAY_FALLBACK_DIAGNOSTIC_PREFIX,
  PI_CHILD_OVERLAY_FALLBACK_REASON_CODES,
  piChildOverlayFallbackReasonCode,
  piChildOverlayOpenErrorReasonCode,
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

  it("maps every non-fallback open error to its own bounded subcode", () => {
    // Task 20(c): the historical overlay failed with a single opaque
    // `open-failed`, which could not tell a rejected descriptor apart from an
    // unready, corrupt, or unknown source.
    expect(
      piChildOverlayOpenErrorReasonCode({ type: "OverlayInvalidChild" }),
    ).toBe("open-invalid-child");
    expect(
      piChildOverlayOpenErrorReasonCode({ type: "SourceStartupNotReady" }),
    ).toBe("open-source-not-ready");
    expect(piChildOverlayOpenErrorReasonCode({ type: "SourceCorrupt" })).toBe(
      "open-source-corrupt",
    );
    expect(
      piChildOverlayOpenErrorReasonCode({ type: "SourceUnavailable" }),
    ).toBe("open-source-unavailable");
    expect(piChildOverlayOpenErrorReasonCode({ type: "ChildNotFound" })).toBe(
      "open-child-not-found",
    );
    expect(
      piChildOverlayOpenErrorReasonCode({ type: "SourceInvalidCursor" }),
    ).toBe("open-invalid-cursor");
    expect(
      piChildOverlayOpenErrorReasonCode({ type: "OverlayCapacityExceeded" }),
    ).toBe("open-capacity-exceeded");
    expect(piChildOverlayOpenErrorReasonCode({ type: "OverlayNotOpen" })).toBe(
      "open-not-open",
    );
    // An unmodelled shape stays generic rather than echoing anything.
    expect(
      piChildOverlayOpenErrorReasonCode({
        type: "child-abc123 /Users/someone",
      }),
    ).toBe("open-failed");
    expect(piChildOverlayOpenErrorReasonCode({})).toBe("open-failed");
  });
});
