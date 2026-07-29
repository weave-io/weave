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
] as const;
export type PiHostSurfaceId = (typeof PI_HOST_SURFACE_IDS)[number];

export interface PiHostSurfaceDeclaration {
  readonly id: PiHostSurfaceId;
  readonly required: boolean;
  readonly nativeSupport: boolean;
  readonly minimumHostVersion: string;
  readonly fallback?: "pi-default";
}

const rendering = (id: PiHostSurfaceId): PiHostSurfaceDeclaration => ({
  id,
  required: false,
  nativeSupport: false,
  minimumHostVersion: HOST_VERSION_FLOOR,
  fallback: "pi-default",
});
const requiredNative = (id: PiHostSurfaceId): PiHostSurfaceDeclaration => ({
  id,
  required: true,
  nativeSupport: true,
  minimumHostVersion: HOST_VERSION_FLOOR,
});

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
  exactTestedVersion: "0.81.1",
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
    const renderingSurface =
      surface.id.endsWith("-rendering") || surface.id === "status-rendering";
    if (
      renderingSurface !== !surface.required ||
      (renderingSurface && surface.fallback !== "pi-default") ||
      (!renderingSurface && surface.fallback !== undefined) ||
      surface.nativeSupport !== !renderingSurface
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
