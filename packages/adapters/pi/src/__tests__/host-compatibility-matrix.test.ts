import { describe, expect, it } from "bun:test";
import {
  HOST_PACKAGE_NAME,
  HOST_VERSION_FLOOR,
} from "../host-compatibility.js";
import {
  EXACT_TESTED_HOST_VERSION,
  PI_HOST_COMPATIBILITY_MATRIX,
  validateHostCompatibilityMatrix,
} from "../host-compatibility-matrix.js";

describe("PI_HOST_COMPATIBILITY_MATRIX", () => {
  it("names the exact host package, range, floor, and tested version (Pi adapter contract)", () => {
    expect(PI_HOST_COMPATIBILITY_MATRIX.package).toBe(HOST_PACKAGE_NAME);
    expect(PI_HOST_COMPATIBILITY_MATRIX.supportedRange).toBe(">=0.81.1");
    expect(PI_HOST_COMPATIBILITY_MATRIX.floorVersion).toBe(HOST_VERSION_FLOOR);
    expect(PI_HOST_COMPATIBILITY_MATRIX.exactTestedVersion).toBe("0.83.0");
    expect(PI_HOST_COMPATIBILITY_MATRIX.exactTestedVersion).toBe(
      EXACT_TESTED_HOST_VERSION,
    );
  });

  it("keeps the tested version off the floor's minor line without moving the floor", () => {
    expect(PI_HOST_COMPATIBILITY_MATRIX.floorVersion).toBe("0.81.1");
    expect(PI_HOST_COMPATIBILITY_MATRIX.exactTestedVersion).not.toBe(
      PI_HOST_COMPATIBILITY_MATRIX.floorVersion,
    );
    expect(
      validateHostCompatibilityMatrix(PI_HOST_COMPATIBILITY_MATRIX).isOk(),
    ).toBe(true);
  });

  it("passes its own validator", () => {
    const result = validateHostCompatibilityMatrix(
      PI_HOST_COMPATIBILITY_MATRIX,
    );
    expect(result.isOk()).toBe(true);
  });

  it("declares the four Spec 33 §16 session capability contracts with the right severity", () => {
    const byId = new Map(
      PI_HOST_COMPATIBILITY_MATRIX.surfaces.map((surface) => [
        surface.id,
        surface,
      ]),
    );
    for (const id of [
      "rpc-persistent-session",
      "rpc-append-entry",
      "rpc-session-tree-read",
      "custom-session-directory",
    ] as const) {
      const surface = byId.get(id);
      expect(surface?.severity).toBe("required-for-delegation");
      expect(surface?.required).toBe(true);
      expect(surface?.fallback).toBeUndefined();
      expect(surface?.contract.length).toBeGreaterThan(0);
      expect(surface?.remediation.length).toBeGreaterThan(0);
    }
  });

  it("represents overlay-only fallback with an overlay lifecycle capability, not a session read", () => {
    const overlayOnly = PI_HOST_COMPATIBILITY_MATRIX.surfaces.filter(
      (surface) => surface.severity === "overlay-only",
    );
    expect(overlayOnly.map((surface) => surface.id)).toEqual([
      "child-overlay-lifecycle",
    ]);
    const overlay = overlayOnly[0];
    expect(overlay?.required).toBe(false);
    expect(overlay?.fallback).toBe("custom-editor");
    expect(overlay?.nativeSupport).toBe(true);
    expect(overlay?.contract.length).toBeGreaterThan(0);
    expect(overlay?.remediation.length).toBeGreaterThan(0);
  });

  it("keeps every surface at the 0.81.1 floor with no maximum", () => {
    for (const surface of PI_HOST_COMPATIBILITY_MATRIX.surfaces) {
      expect(surface.minimumHostVersion).toBe(HOST_VERSION_FLOOR);
    }
    expect(PI_HOST_COMPATIBILITY_MATRIX.supportedRange).toBe(
      `>=${HOST_VERSION_FLOOR}`,
    );
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

  it("rejects a prerelease exact tested version", () => {
    for (const version of ["0.83.0-rc.1", "0.84.0-beta"]) {
      const result = validateHostCompatibilityMatrix({
        ...PI_HOST_COMPATIBILITY_MATRIX,
        exactTestedVersion: version,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr())
        expect(result.error.type).toBe("ExactVersionMalformed");
    }
  });

  it("accepts the stable release-tested version 0.83.0", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      exactTestedVersion: "0.83.0",
    });
    expect(result.isOk()).toBe(true);
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

  it("rejects an overlay-only surface that claims required-for-delegation severity", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      surfaces: PI_HOST_COMPATIBILITY_MATRIX.surfaces.map((surface) =>
        surface.id === "child-overlay-lifecycle"
          ? { ...surface, severity: "required-for-delegation" as const }
          : surface,
      ),
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("SurfaceDrift");
      if (result.error.type === "SurfaceDrift")
        expect(result.error.reason).toBe(
          "surface-policy:child-overlay-lifecycle",
        );
    }
  });

  it("rejects a required session surface that offers a fallback", () => {
    const result = validateHostCompatibilityMatrix({
      ...PI_HOST_COMPATIBILITY_MATRIX,
      surfaces: PI_HOST_COMPATIBILITY_MATRIX.surfaces.map((surface) =>
        surface.id === "rpc-append-entry"
          ? { ...surface, fallback: "custom-editor" as const }
          : surface,
      ),
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("SurfaceDrift");
  });

  it("rejects a surface with an empty contract or remediation", () => {
    for (const patch of [{ contract: "  " }, { remediation: "" }]) {
      const result = validateHostCompatibilityMatrix({
        ...PI_HOST_COMPATIBILITY_MATRIX,
        surfaces: PI_HOST_COMPATIBILITY_MATRIX.surfaces.map((surface) =>
          surface.id === "rpc-persistent-session"
            ? { ...surface, ...patch }
            : surface,
        ),
      });
      expect(result.isErr()).toBe(true);
    }
  });
});
