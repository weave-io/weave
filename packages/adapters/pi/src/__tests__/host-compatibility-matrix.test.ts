import { describe, expect, it } from "bun:test";
import {
  HOST_PACKAGE_NAME,
  HOST_VERSION_FLOOR,
} from "../host-compatibility.js";
import {
  PI_HOST_COMPATIBILITY_MATRIX,
  validateHostCompatibilityMatrix,
} from "../host-compatibility-matrix.js";

describe("PI_HOST_COMPATIBILITY_MATRIX", () => {
  it("names the exact host package, range, floor, and tested version (Pi adapter contract)", () => {
    expect(PI_HOST_COMPATIBILITY_MATRIX.package).toBe(HOST_PACKAGE_NAME);
    expect(PI_HOST_COMPATIBILITY_MATRIX.supportedRange).toBe(">=0.81.1");
    expect(PI_HOST_COMPATIBILITY_MATRIX.floorVersion).toBe(HOST_VERSION_FLOOR);
    expect(PI_HOST_COMPATIBILITY_MATRIX.exactTestedVersion).toBe("0.81.1");
  });

  it("passes its own validator", () => {
    const result = validateHostCompatibilityMatrix(
      PI_HOST_COMPATIBILITY_MATRIX,
    );
    expect(result.isOk()).toBe(true);
  });
});

describe("validateHostCompatibilityMatrix", () => {
  it("rejects a package name that has drifted from host-compatibility.ts", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      package: "@earendil-works/pi-coding-agent-fork",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("PackageMismatch");
  });

  it("rejects a supported range that has drifted from the floor constant", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      supportedRange: ">=0.80.0",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("RangeDrift");
  });

  it("rejects a floor version that no longer matches host-compatibility.ts", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      floorVersion: "0.81.0",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("FloorDrift");
  });

  it("rejects a malformed exact tested version", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      exactTestedVersion: "0.81",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("ExactVersionMalformed");
  });

  it("rejects an exact tested version below the floor", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      exactTestedVersion: "0.81.0",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ExactVersionOutOfRange");
  });

  it("accepts an exact tested version in a later minor", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      exactTestedVersion: "0.82.1",
    });
    expect(result.isOk()).toBe(true);
  });

  it("accepts a later exact tested patch still inside the supported range", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      exactTestedVersion: "0.81.9",
    });
    expect(result.isOk()).toBe(true);
  });

  it("rejects surface count, duplicate, unknown, policy, and minimum-version drift", () => {
    const surfaces = [...PI_HOST_COMPATIBILITY_MATRIX.surfaces];
    expect(
      validateHostCompatibilityMatrix({
        ...PI_HOST_COMPATIBILITY_MATRIX,
        surfaces: surfaces.slice(1),
      }).isErr(),
    ).toBe(true);
    expect(
      validateHostCompatibilityMatrix({
        ...PI_HOST_COMPATIBILITY_MATRIX,
        surfaces: [
          ...surfaces.slice(0, -1),
          surfaces[0] as (typeof surfaces)[number],
        ],
      }).isErr(),
    ).toBe(true);
    expect(
      validateHostCompatibilityMatrix({
        ...PI_HOST_COMPATIBILITY_MATRIX,
        surfaces: surfaces.map((surface, index) =>
          index === 0 ? { ...surface, id: "unknown" as never } : surface,
        ),
      }).isErr(),
    ).toBe(true);
    expect(
      validateHostCompatibilityMatrix({
        ...PI_HOST_COMPATIBILITY_MATRIX,
        surfaces: surfaces.map((surface, index) =>
          index === 0 ? { ...surface, nativeSupport: true } : surface,
        ),
      }).isErr(),
    ).toBe(true);
    expect(
      validateHostCompatibilityMatrix({
        ...PI_HOST_COMPATIBILITY_MATRIX,
        surfaces: surfaces.map((surface, index) =>
          index === 0 ? { ...surface, minimumHostVersion: "0.80.0" } : surface,
        ),
      }).isErr(),
    ).toBe(true);
  });
});
