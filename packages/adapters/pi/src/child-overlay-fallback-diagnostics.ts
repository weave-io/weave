/**
 * Bounded reason codes for every native-overlay → custom-editor fallback.
 *
 * Task 20(c) failed in a live Herdr run with the selected historical child
 * landing in the custom-editor fallback, and the run recorded no reason: the
 * adapter switched paths silently. Offline reproduction was not possible, so
 * the decision itself is now instrumented.
 *
 * Every code here is a fixed literal. Nothing in this module accepts or formats
 * a child id, thread id, session id, filesystem path, prompt, or transcript
 * text, so a diagnostic can be read out of a live session and copied into a
 * proof without sanitisation.
 */

export const PI_CHILD_OVERLAY_FALLBACK_REASON_CODES = Object.freeze([
  /** Preflight resolved the custom editor, so the native path never ran. */
  "preflight-not-native",
  /** No overlay controller exists for this generation. */
  "controller-absent",
  /** The generation changed between selection and activation. */
  "generation-changed",
  /** `ChildOverlayController.open` rejected the child. */
  "open-failed",
  /** `open` rejected the described child: it failed descriptor validation. */
  "open-invalid-child",
  /** `open` rejected the child: the page source is not ready yet. */
  "open-source-not-ready",
  /** `open` rejected the child: the page source is corrupt. */
  "open-source-corrupt",
  /** `open` rejected the child: the page source is unavailable. */
  "open-source-unavailable",
  /** `open` rejected the child: no such child is known. */
  "open-child-not-found",
  /** `open` rejected the child: the pagination cursor is invalid. */
  "open-invalid-cursor",
  /** `open` rejected the child: a bounded overlay capacity was exceeded. */
  "open-capacity-exceeded",
  /** `open` rejected the child: no overlay was open when one was required. */
  "open-not-open",
  /** `open` asked for the fallback: the page source failed. */
  "open-source-failed",
  /** `open` asked for the fallback: the child could not be described. */
  "open-describe-failed",
  /** `open` asked for the fallback: rendering failed. */
  "open-render-failed",
  /** The mounted native overlay asked for the fallback: source failure. */
  "mounted-source-failed",
  /** The mounted native overlay asked for the fallback: describe failure. */
  "mounted-describe-failed",
  /** The mounted native overlay asked for the fallback: render failure. */
  "mounted-render-failed",
  /** The host has no TUI custom-surface, so no overlay can mount. */
  "no-tui-custom-surface",
] as const);

export type PiChildOverlayFallbackReasonCode =
  (typeof PI_CHILD_OVERLAY_FALLBACK_REASON_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(
  PI_CHILD_OVERLAY_FALLBACK_REASON_CODES,
);

export function isPiChildOverlayFallbackReasonCode(
  value: string,
): value is PiChildOverlayFallbackReasonCode {
  return KNOWN_CODES.has(value);
}

/** Stable prefix a proof can grep for in `/weave:health` output. */
export const PI_CHILD_OVERLAY_FALLBACK_DIAGNOSTIC_PREFIX =
  "weave overlay fallback:";

/**
 * Formats one fallback decision as a bounded, identifier-free diagnostic.
 *
 * The code is validated against the closed set, so a caller cannot smuggle a
 * dynamic string (and therefore an identifier) into the diagnostics ledger.
 */
export function formatPiChildOverlayFallbackDiagnostic(
  code: PiChildOverlayFallbackReasonCode,
): string {
  const safe = isPiChildOverlayFallbackReasonCode(code) ? code : "open-failed";
  return `${PI_CHILD_OVERLAY_FALLBACK_DIAGNOSTIC_PREFIX} ${safe}`;
}

/**
 * Maps a controller fallback reason to its `open`-time or mounted reason code.
 * Unknown reasons collapse to the generic open failure rather than being
 * echoed, so no free-form text can reach a diagnostic.
 */
export function piChildOverlayFallbackReasonCode(
  reason: string,
  stage: "open" | "mounted",
): PiChildOverlayFallbackReasonCode {
  if (reason === "source-failed") {
    return stage === "open" ? "open-source-failed" : "mounted-source-failed";
  }
  if (reason === "describe-failed") {
    return stage === "open"
      ? "open-describe-failed"
      : "mounted-describe-failed";
  }
  if (reason === "render-failed") {
    return stage === "open" ? "open-render-failed" : "mounted-render-failed";
  }
  return "open-failed";
}

/**
 * Maps one non-fallback `ChildOverlayController.open` error to its bounded
 * subcode.
 *
 * Every historical overlay failure used to collapse into the single
 * `open-failed` code, which could not distinguish a descriptor that failed
 * validation from a source that was not ready, corrupt, or unknown. The
 * discriminant is a closed union, so the mapping stays exhaustive and no
 * identifier, path, issue path, or operation name ever reaches a diagnostic.
 */
export function piChildOverlayOpenErrorReasonCode(error: {
  readonly type?: string;
}): PiChildOverlayFallbackReasonCode {
  switch (error.type) {
    case "OverlayInvalidChild":
      return "open-invalid-child";
    case "SourceStartupNotReady":
      return "open-source-not-ready";
    case "SourceCorrupt":
      return "open-source-corrupt";
    case "SourceUnavailable":
      return "open-source-unavailable";
    case "ChildNotFound":
      return "open-child-not-found";
    case "SourceInvalidCursor":
      return "open-invalid-cursor";
    case "OverlayCapacityExceeded":
      return "open-capacity-exceeded";
    case "OverlayNotOpen":
      return "open-not-open";
    default:
      return "open-failed";
  }
}
