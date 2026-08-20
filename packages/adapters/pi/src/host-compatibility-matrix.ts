import { err, ok, type Result } from "neverthrow";
import {
  HOST_PACKAGE_NAME,
  HOST_VERSION_FLOOR,
  isSupportedHostVersion,
} from "./host-compatibility.js";

export const PI_HOST_SURFACE_IDS = [
  "assistant-rendering",
  "tool-rendering",
  "markdown-rendering",
  "image-rendering",
  "usage-rendering",
  "queue-rendering",
  "status-rendering",
  "editor-composition",
  "rpc-steer",
  "rpc-follow-up",
  "rpc-get-entries",
  "session-restore",
  "extension-ui-response",
  "rpc-persistent-session",
  "rpc-append-entry",
  "rpc-session-tree-read",
  "custom-session-directory",
  "child-overlay-lifecycle",
  "runtime-model-fallback",
] as const;
export type PiHostSurfaceId = (typeof PI_HOST_SURFACE_IDS)[number];

/**
 * How a gap in one surface degrades the adapter (Spec 33 §16).
 *
 * - `required-for-delegation`: the adapter cannot run delegated children
 *   without it, so a gap enters health-only mode.
 * - `overlay-only`: only the native full-screen child overlay's own
 *   mount/unmount lifecycle needs it, so a gap routes to the existing
 *   custom-editor fallback (§7) and never forces health-only mode. Session
 *   *reads* are never overlay-only: delegation itself depends on them.
 * - `rendering-fallback`: Pi's own default rendering covers the gap.
 * - `feature-only`: an optional host feature. A gap must not enter
 *   health-only mode and must not select the overlay fallback; behavior
 *   stays on legacy visible/child settlement.
 */
export type PiHostSurfaceSeverity =
  | "required-for-delegation"
  | "overlay-only"
  | "rendering-fallback"
  | "feature-only";

export type PiHostSurfaceFallback = "pi-default" | "custom-editor";

export interface PiHostSurfaceDeclaration {
  readonly id: PiHostSurfaceId;
  readonly required: boolean;
  readonly nativeSupport: boolean;
  readonly minimumHostVersion: string;
  readonly severity: PiHostSurfaceSeverity;
  /** Human-readable contract this surface implements, used in diagnostics. */
  readonly contract: string;
  /** Operator-facing remediation used in health-only diagnostics. */
  readonly remediation: string;
  readonly fallback?: PiHostSurfaceFallback;
}

const rendering = (id: PiHostSurfaceId): PiHostSurfaceDeclaration => ({
  id,
  required: false,
  nativeSupport: false,
  minimumHostVersion: HOST_VERSION_FLOOR,
  severity: "rendering-fallback",
  contract: "Spec 33 §7 native rendering",
  remediation: "Pi default rendering is used; no operator action is required.",
  fallback: "pi-default",
});
const requiredNative = (
  id: PiHostSurfaceId,
  contract = "Spec 33 §16 required host surface",
  remediation = `Upgrade the Pi host to a version that provides ${id}, or disable Weave delegation.`,
): PiHostSurfaceDeclaration => ({
  id,
  required: true,
  nativeSupport: true,
  minimumHostVersion: HOST_VERSION_FLOOR,
  severity: "required-for-delegation",
  contract,
  remediation,
});
const overlayOnly = (
  id: PiHostSurfaceId,
  contract: string,
  remediation: string,
): PiHostSurfaceDeclaration => ({
  id,
  required: false,
  nativeSupport: true,
  minimumHostVersion: HOST_VERSION_FLOOR,
  severity: "overlay-only",
  contract,
  remediation,
  fallback: "custom-editor",
});
const featureOnly = (
  id: PiHostSurfaceId,
  contract: string,
  remediation: string,
): PiHostSurfaceDeclaration => ({
  id,
  required: false,
  nativeSupport: true,
  minimumHostVersion: HOST_VERSION_FLOOR,
  severity: "feature-only",
  contract,
  remediation,
});

/**
 * The one host version the release was actually tested against. It must be a
 * stable version inside the supported range, but it is deliberately not tied
 * to the floor's minor line: the floor states what the adapter supports, while
 * this states what was proved (Spec 33 §16).
 *
 * Task 15 must prove this pin on real Pi 0.84.2. Version alone is never
 * capability evidence; `runtime-model-fallback` is optional and feature-only.
 */
export const EXACT_TESTED_HOST_VERSION = "0.84.2";

export interface PiHostCompatibilityMatrix {
  readonly package: string;
  readonly supportedRange: string;
  readonly floorVersion: string;
  readonly exactTestedVersion: string;
  readonly surfaces: readonly PiHostSurfaceDeclaration[];
}

export const PI_HOST_COMPATIBILITY_MATRIX: PiHostCompatibilityMatrix = {
  package: HOST_PACKAGE_NAME,
  supportedRange: `>=${HOST_VERSION_FLOOR}`,
  floorVersion: HOST_VERSION_FLOOR,
  exactTestedVersion: EXACT_TESTED_HOST_VERSION,
  surfaces: Object.freeze([
    rendering("assistant-rendering"),
    rendering("tool-rendering"),
    rendering("markdown-rendering"),
    rendering("image-rendering"),
    rendering("usage-rendering"),
    rendering("queue-rendering"),
    rendering("status-rendering"),
    requiredNative("editor-composition"),
    requiredNative("rpc-steer"),
    requiredNative("rpc-follow-up"),
    requiredNative("rpc-get-entries"),
    requiredNative("session-restore"),
    requiredNative("extension-ui-response"),
    requiredNative(
      "rpc-persistent-session",
      "Spec 33 §16 persistent RPC session and restore",
      "Upgrade the Pi host to one that keeps RPC child sessions across restore, or disable Weave delegation.",
    ),
    requiredNative(
      "rpc-append-entry",
      "Spec 33 §16 appendEntry",
      "Upgrade the Pi host to one that exposes pi.appendEntry, or disable Weave delegation.",
    ),
    requiredNative(
      "rpc-session-tree-read",
      "Spec 33 §16 get_entries/get_tree",
      "Upgrade the Pi host to one that answers get_entries/get_tree, or disable Weave delegation.",
    ),
    requiredNative(
      "custom-session-directory",
      "Spec 33 §16 custom session directory support",
      "Upgrade the Pi host to one that accepts a custom session directory, or disable Weave delegation.",
    ),
    overlayOnly(
      "child-overlay-lifecycle",
      "Spec 33 §7 native full-screen child overlay mount and editor restore",
      "Upgrade the Pi host to one that exposes the overlay UI and editor-restore lifecycle; until then the custom-editor child inspection fallback is used.",
    ),
    featureOnly(
      "runtime-model-fallback",
      "Public Pi surfaces for optional runtime model fallback: agent_settled registration, terminal message_end, replacement-returning context, message_start, model_select, callable setModel, fire-and-forget sendMessage, and callable idle/pending helpers. Surface presence is not lifecycle proof.",
      "Missing or unproven public fallback surfaces keep ready health and legacy visible/child settlement. Exact-tested behavior is claimed only for Pi 0.84.2 after live proof.",
    ),
  ]),
} as const;
export type HostCompatibilityMatrixError =
  | { type: "PackageMismatch"; expected: string; actual: string }
  | { type: "RangeDrift"; expected: string; actual: string }
  | { type: "FloorDrift"; expected: string; actual: string }
  | { type: "ExactVersionMalformed"; version: string }
  | { type: "ExactVersionOutOfRange"; version: string }
  | { type: "SurfaceDrift"; reason: string };

const EXACT_TESTED_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function validateHostCompatibilityMatrix(
  matrix: PiHostCompatibilityMatrix,
): Result<PiHostCompatibilityMatrix, HostCompatibilityMatrixError> {
  if (matrix.package !== HOST_PACKAGE_NAME)
    return err({
      type: "PackageMismatch",
      expected: HOST_PACKAGE_NAME,
      actual: matrix.package,
    });
  const expectedRange = `>=${HOST_VERSION_FLOOR}`;
  if (matrix.supportedRange !== expectedRange)
    return err({
      type: "RangeDrift",
      expected: expectedRange,
      actual: matrix.supportedRange,
    });
  if (matrix.floorVersion !== HOST_VERSION_FLOOR)
    return err({
      type: "FloorDrift",
      expected: HOST_VERSION_FLOOR,
      actual: matrix.floorVersion,
    });
  if (!EXACT_TESTED_VERSION_PATTERN.test(matrix.exactTestedVersion))
    return err({
      type: "ExactVersionMalformed",
      version: matrix.exactTestedVersion,
    });
  if (!isSupportedHostVersion(matrix.exactTestedVersion))
    return err({
      type: "ExactVersionOutOfRange",
      version: matrix.exactTestedVersion,
    });
  if (matrix.surfaces.length !== PI_HOST_SURFACE_IDS.length)
    return err({ type: "SurfaceDrift", reason: "surface-count" });
  const seen = new Set<string>();
  for (const surface of matrix.surfaces) {
    if (!PI_HOST_SURFACE_IDS.includes(surface.id) || seen.has(surface.id))
      return err({
        type: "SurfaceDrift",
        reason: "surface-unknown-or-duplicate",
      });
    seen.add(surface.id);
    if (
      !EXACT_TESTED_VERSION_PATTERN.test(surface.minimumHostVersion) ||
      !isSupportedHostVersion(surface.minimumHostVersion)
    )
      return err({
        type: "SurfaceDrift",
        reason: `surface-min-version:${surface.id}`,
      });
    const renderingSurface = surface.severity === "rendering-fallback";
    const overlaySurface = surface.severity === "overlay-only";
    const featureSurface = surface.severity === "feature-only";
    const knownSeverity =
      surface.severity === "required-for-delegation" ||
      overlaySurface ||
      renderingSurface ||
      featureSurface;
    const expectedFallback = ((): PiHostSurfaceFallback | undefined => {
      if (renderingSurface) return "pi-default";
      if (overlaySurface) return "custom-editor";
      return undefined;
    })();
    if (
      !knownSeverity ||
      renderingSurface !== surface.id.endsWith("-rendering") ||
      surface.required !== (surface.severity === "required-for-delegation") ||
      surface.fallback !== expectedFallback ||
      surface.nativeSupport !== !renderingSurface ||
      (featureSurface && surface.fallback !== undefined) ||
      surface.contract.trim().length === 0 ||
      surface.remediation.trim().length === 0
    )
      return err({
        type: "SurfaceDrift",
        reason: `surface-policy:${surface.id}`,
      });
    if (surface.minimumHostVersion !== HOST_VERSION_FLOOR)
      return err({
        type: "SurfaceDrift",
        reason: `surface-min-version-drift:${surface.id}`,
      });
  }
  if (seen.size !== PI_HOST_SURFACE_IDS.length)
    return err({ type: "SurfaceDrift", reason: "surface-missing" });
  return ok(matrix);
}
