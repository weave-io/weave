import { describe, expect, it } from "bun:test";
import {
  checkHostCompatibility,
  HOST_PACKAGE_NAME,
  isSupportedHostVersion,
  parseSemver,
} from "../host-compatibility.js";

describe("isSupportedHostVersion", () => {
  it("accepts the exact floor 0.81.1", () => {
    expect(isSupportedHostVersion("0.81.1")).toBe(true);
  });

  it("accepts a patch above the floor within the same minor", () => {
    expect(isSupportedHostVersion("0.81.99")).toBe(true);
  });

  it("rejects below the floor", () => {
    expect(isSupportedHostVersion("0.81.0")).toBe(false);
  });

  it("rejects the exclusive ceiling 0.82.0", () => {
    expect(isSupportedHostVersion("0.82.0")).toBe(false);
  });

  it("rejects a version above the ceiling", () => {
    expect(isSupportedHostVersion("0.83.0")).toBe(false);
  });

  it("rejects a prerelease at the floor (no force/ignore override)", () => {
    expect(isSupportedHostVersion("0.81.1-beta.1")).toBe(false);
  });

  it("rejects an unparseable version string", () => {
    expect(isSupportedHostVersion("not-a-version")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSupportedHostVersion("")).toBe(false);
  });
});

describe("parseSemver", () => {
  it("parses major/minor/patch", () => {
    const result = parseSemver("1.2.3");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: undefined,
    });
  });

  it("parses a prerelease suffix", () => {
    const result = parseSemver("1.2.3-rc.1");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().prerelease).toBe("rc.1");
  });

  it("fails on garbage input", () => {
    expect(parseSemver("garbage").isErr()).toBe(true);
  });
});

describe("checkHostCompatibility", () => {
  it("accepts the exact package name and a version in range", () => {
    const result = checkHostCompatibility({
      name: HOST_PACKAGE_NAME,
      version: "0.81.5",
    });
    expect(result.isOk()).toBe(true);
  });

  it("rejects an unknown host identity", () => {
    const result = checkHostCompatibility({
      name: "@mariozechner/pi-coding-agent",
      version: "0.81.5",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("HostIdentityUnknown");
  });

  it("rejects a missing host package info", () => {
    const result = checkHostCompatibility(undefined);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("HostIdentityUnknown");
  });

  it("rejects an out-of-range version on the correct package", () => {
    const result = checkHostCompatibility({
      name: HOST_PACKAGE_NAME,
      version: "0.80.0",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("HostVersionUnsupported");
  });

  it("produces a failure with health-only impact and no retry", () => {
    const result = checkHostCompatibility({
      name: HOST_PACKAGE_NAME,
      version: "0.82.0",
    });
    const failure = result._unsafeUnwrapErr();
    expect(failure.impact).toBe("health-only");
    expect(failure.retryable).toBe(false);
  });
});
