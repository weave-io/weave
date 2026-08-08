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
  ChildOverlaySourceErrorType,
} from "./child-overlay-types.js";

/**
 * Non-fallback `ChildOverlayError` variants that reach the terminal open-error
 * diagnostic branch (after `fallback-required` is handled separately).
 */
export type ChildOverlayOpenTerminalError = Exclude<
  ChildOverlayError,
  ChildOverlayFallbackRequired
>;

/**
 * Source-error discriminants that `ChildOverlayController.open` may convert
 * into a describe-failed fallback.
 *
 * `SourceInvalidCursor` is deliberately excluded: describe never yields an
 * invalid pagination cursor, so that discriminant stays on the terminal
 * open-error path (`open-invalid-cursor`) instead of a describe subcode.
 */
export type ChildOverlayDescribeFallbackSourceErrorType = Exclude<
  ChildOverlaySourceErrorType,
  "SourceInvalidCursor"
>;

type AssertNever<T extends never> = T;

/** Compile-time proof that SourceInvalidCursor cannot key the describe map. */
type _SourceInvalidCursorImpossibleForDescribe = AssertNever<
  Extract<ChildOverlayDescribeFallbackSourceErrorType, "SourceInvalidCursor">
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
  /** `open` describe fallback: no such child is known to the controller. */
  "open-describe-child-not-found",
  /** `open` describe fallback: the describe source was unavailable. */
  "open-describe-source-unavailable",
  /** `open` describe fallback: the describe source was corrupt. */
  "open-describe-source-corrupt",
  /** `open` describe fallback: the describe source was not ready yet. */
  "open-describe-source-not-ready",
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
 * Compile-time exhaustive map from every describe-fallback source-error
 * discriminant to its `open` describe subcode.
 *
 * Keyed by {@link ChildOverlayDescribeFallbackSourceErrorType}. Adding a
 * member to that closed set fails typechecking here until a subcode is
 * supplied. `SourceInvalidCursor` is excluded (see that type). Unknown
 * runtime keys must not index this table directly — use
 * {@link openDescribeSubcodeFromUnknownSourceErrorType}.
 */
const OPEN_DESCRIBE_SUBCODE_BY_SOURCE_ERROR = {
  ChildNotFound: "open-describe-child-not-found",
  SourceUnavailable: "open-describe-source-unavailable",
  SourceCorrupt: "open-describe-source-corrupt",
  SourceStartupNotReady: "open-describe-source-not-ready",
} as const satisfies Record<
  ChildOverlayDescribeFallbackSourceErrorType,
  PiChildOverlayFallbackReasonCode
>;

/**
 * Maps one typed describe-fallback source-error discriminant to its bounded
 * subcode. Exhaustive over {@link ChildOverlayDescribeFallbackSourceErrorType}.
 */
function openDescribeSubcodeForKnownSourceError(
  type: ChildOverlayDescribeFallbackSourceErrorType,
): PiChildOverlayFallbackReasonCode {
  switch (type) {
    case "ChildNotFound":
      return OPEN_DESCRIBE_SUBCODE_BY_SOURCE_ERROR.ChildNotFound;
    case "SourceUnavailable":
      return OPEN_DESCRIBE_SUBCODE_BY_SOURCE_ERROR.SourceUnavailable;
    case "SourceCorrupt":
      return OPEN_DESCRIBE_SUBCODE_BY_SOURCE_ERROR.SourceCorrupt;
    case "SourceStartupNotReady":
      return OPEN_DESCRIBE_SUBCODE_BY_SOURCE_ERROR.SourceStartupNotReady;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/**
 * Unknown-runtime boundary for a describe-fallback `sourceErrorType`.
 *
 * Verifies `typeof sourceErrorType === "string"` before any lookup. Non-string
 * values, symbols, objects (including those whose `toString` throws),
 * Object.prototype key names, `SourceInvalidCursor`, and unknown strings all
 * collapse to `open-describe-failed` without throwing.
 */
function openDescribeSubcodeFromUnknownSourceErrorType(
  sourceErrorType: unknown,
): PiChildOverlayFallbackReasonCode {
  if (typeof sourceErrorType !== "string") {
    return "open-describe-failed";
  }
  // Own-key only: `in` also matches Object.prototype names (toString,
  // constructor, __proto__), which would resolve to inherited functions
  // instead of collapsing to the opaque describe-failed code.
  if (Object.hasOwn(OPEN_DESCRIBE_SUBCODE_BY_SOURCE_ERROR, sourceErrorType)) {
    return openDescribeSubcodeForKnownSourceError(
      sourceErrorType as ChildOverlayDescribeFallbackSourceErrorType,
    );
  }
  return "open-describe-failed";
}

/**
 * Maps a controller fallback reason to its `open`-time or mounted reason code.
 * Unknown reasons collapse to the generic open failure rather than being
 * echoed, so no free-form text can reach a diagnostic.
 *
 * When the fallback came from a source error, `sourceErrorType` selects a
 * describe subcode instead of the indistinguishable `open-describe-failed`.
 * A single code cannot tell an absent source from an unknown child, which is
 * exactly the distinction a live run needs. Only the `open` describe stage has
 * subcodes today; every other stage keeps its existing code.
 *
 * `sourceErrorType` is `unknown` at this boundary: callers may pass metadata
 * from an untrusted runtime shape. Non-string values never reach the map.
 */
export function piChildOverlayFallbackReasonCode(
  reason: string,
  stage: "open" | "mounted",
  sourceErrorType?: unknown,
): PiChildOverlayFallbackReasonCode {
  if (reason === "source-failed") {
    return stage === "open" ? "open-source-failed" : "mounted-source-failed";
  }
  if (reason === "describe-failed") {
    if (stage === "mounted") return "mounted-describe-failed";
    return openDescribeSubcodeFromUnknownSourceErrorType(sourceErrorType);
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
  // Own-key only: `in` also matches Object.prototype names (toString,
  // constructor, __proto__), which would resolve to inherited functions
  // instead of collapsing to the opaque open-failed code.
  if (Object.hasOwn(PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE, type)) {
    return PI_CHILD_OVERLAY_OPEN_ERROR_REASON_BY_TYPE[
      type as ChildOverlayOpenTerminalError["type"]
    ];
  }
  return "open-failed";
}
