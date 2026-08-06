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

import type {
  ChildOverlayError,
  ChildOverlayFallbackRequired,
} from "./child-overlay-types.js";

/**
 * Non-fallback `ChildOverlayError` variants that reach the terminal open-error
 * diagnostic branch (after `fallback-required` is handled separately).
 */
export type ChildOverlayOpenTerminalError = Exclude<
  ChildOverlayError,
  ChildOverlayFallbackRequired
>;

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
 * Compile-time exhaustive map from every non-fallback open-error discriminant
 * to its bounded, identifier-free reason code.
 *
 * Adding a member to `ChildOverlayOpenTerminalError` fails typechecking here
 * until a reason code is supplied. Unknown runtime shapes must not use this
 * table directly — call {@link piChildOverlayOpenErrorReasonCodeFromUnknown}.
 */
const PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE = {
  OverlayInvalidChild: "open-invalid-child",
  SourceStartupNotReady: "open-source-not-ready",
  SourceCorrupt: "open-source-corrupt",
  SourceUnavailable: "open-source-unavailable",
  ChildNotFound: "open-child-not-found",
  SourceInvalidCursor: "open-invalid-cursor",
  OverlayCapacityExceeded: "open-capacity-exceeded",
  OverlayNotOpen: "open-not-open",
} as const satisfies Record<
  ChildOverlayOpenTerminalError["type"],
  PiChildOverlayFallbackReasonCode
>;

/**
 * Maps one typed non-fallback `ChildOverlayController.open` error to its
 * bounded subcode.
 *
 * Exhaustive over {@link ChildOverlayOpenTerminalError}: a new closed-union
 * member is a compile error until mapped. No identifier, path, issue path, or
 * operation name reaches a diagnostic.
 */
export function piChildOverlayOpenErrorReasonCode(
  error: ChildOverlayOpenTerminalError,
): PiChildOverlayFallbackReasonCode {
  switch (error.type) {
    case "OverlayInvalidChild":
      return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE.OverlayInvalidChild;
    case "SourceStartupNotReady":
      return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE.SourceStartupNotReady;
    case "SourceCorrupt":
      return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE.SourceCorrupt;
    case "SourceUnavailable":
      return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE.SourceUnavailable;
    case "ChildNotFound":
      return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE.ChildNotFound;
    case "SourceInvalidCursor":
      return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE.SourceInvalidCursor;
    case "OverlayCapacityExceeded":
      return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE.OverlayCapacityExceeded;
    case "OverlayNotOpen":
      return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE.OverlayNotOpen;
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}

/**
 * Boundary for unknown or untrusted runtime shapes.
 *
 * Validates the discriminant against the closed open-error map and returns
 * `open-failed` for anything else. Does not weaken compile-time exhaustiveness
 * of {@link piChildOverlayOpenErrorReasonCode}.
 */
export function piChildOverlayOpenErrorReasonCodeFromUnknown(
  error: unknown,
): PiChildOverlayFallbackReasonCode {
  if (typeof error !== "object" || error === null) {
    return "open-failed";
  }
  const type = Reflect.get(error, "type");
  if (typeof type !== "string") {
    return "open-failed";
  }
  if (type in PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE) {
    return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE[
      type as ChildOverlayOpenTerminalError["type"]
    ];
  }
  return "open-failed";
}
