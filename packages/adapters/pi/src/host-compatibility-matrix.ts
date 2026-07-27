import { err, ok, type Result } from "neverthrow";
import {
  HOST_PACKAGE_NAME,
  HOST_VERSION_FLOOR,
  isSupportedHostVersion,
} from "./host-compatibility.js";

/**
 * Exact-host compatibility matrix (Pi adapter contract PI-PKG).
 *
 * The Pi adapter contract requires exactly one source-controlled compatibility record
 * naming the host package, its supported range, the floor version, and the
 * exact release-tested version. This module is that record. Every other
 * place that needs the "exact tested host version" (release scripts, the
 * acceptance manifest's `host` block, package/clean-room proofs) imports it
 * from here instead of redeclaring it, so the tested version and the
 * supported range can never drift apart from `host-compatibility.ts`.
 */
export interface PiHostCompatibilityMatrix {
  /** The exact npm package name the adapter depends on as a peer. */
  readonly package: string;
  /** The semver range declared as the peer dependency. */
  readonly supportedRange: string;
  /** The inclusive lower bound of the supported range. */
  readonly floorVersion: string;
  /**
   * The exact host version this adapter is release-tested against. Must be
   * inside `supportedRange` and match the `0.81.x` pattern the acceptance
   * manifest schema requires (Pi adapter contract).
   */
  readonly exactTestedVersion: string;
}

export const PI_HOST_COMPATIBILITY_MATRIX: PiHostCompatibilityMatrix = {
  package: HOST_PACKAGE_NAME,
  supportedRange: `>=${HOST_VERSION_FLOOR}`,
  floorVersion: HOST_VERSION_FLOOR,
  exactTestedVersion: "0.81.1",
};

export type HostCompatibilityMatrixError =
  | { type: "PackageMismatch"; expected: string; actual: string }
  | { type: "RangeDrift"; expected: string; actual: string }
  | { type: "FloorDrift"; expected: string; actual: string }
  | { type: "ExactVersionMalformed"; version: string }
  | { type: "ExactVersionOutOfRange"; version: string };

const EXACT_TESTED_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Verifies a compatibility matrix record is internally consistent: the
 * package name and range are exactly the ones `host-compatibility.ts`
 * enforces at runtime, and the exact tested version is both well-formed and
 * inside the supported range. Used by release tooling and the acceptance
 * manifest builder to reject drift before it is committed.
 */
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
  return ok(matrix);
}
