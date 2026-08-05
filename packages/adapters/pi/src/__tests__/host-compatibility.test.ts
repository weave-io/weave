import { describe, expect, it } from "bun:test";
import {
  checkHostCompatibility,
  HOST_PACKAGE_NAME,
  HOST_VERSION_FLOOR,
  type HostCapabilityGapDiagnostic,
  isSupportedHostVersion,
  parseSemver,
  renderHostCapabilityGapDiagnostic,
  UNKNOWN_HOST_VERSION,
} from "../host-compatibility.js";

describe("renderHostCapabilityGapDiagnostic", () => {
  const diagnostic: HostCapabilityGapDiagnostic = {
    capability: "rpc-append-entry",
    hostVersion: "0.83.0",
    contract: "Spec 33 §16 appendEntry",
    probeResult: "unavailable:surface-missing",
    mode: "health-only",
    remediation: "Upgrade the Pi host.",
  };

  it("names the capability, host version, contract, probe result, mode, and remediation", () => {
    const line = renderHostCapabilityGapDiagnostic(diagnostic);
    expect(line).toContain("capability: rpc-append-entry");
    expect(line).toContain("host version: 0.83.0");
    expect(line).toContain(`supported >=${HOST_VERSION_FLOOR}, no maximum`);
    expect(line).toContain("contract: Spec 33 §16 appendEntry");
    expect(line).toContain("probe: unavailable:surface-missing");
    expect(line).toContain("mode: health-only");
    expect(line).toContain("remediation: Upgrade the Pi host.");
  });

  it("still names a version field when the host version is unknown", () => {
    const line = renderHostCapabilityGapDiagnostic({
      ...diagnostic,
      hostVersion: UNKNOWN_HOST_VERSION,
    });
    expect(line).toContain("host version: unknown");
  });

  it("reports the custom-editor fallback mode for an overlay-only gap", () => {
    const line = renderHostCapabilityGapDiagnostic({
      ...diagnostic,
      capability: "rpc-session-tree-read",
      mode: "custom-editor-fallback",
    });
    expect(line).toContain("mode: custom-editor-fallback");
    expect(line).not.toContain("mode: health-only");
  });
});

describe("BunHostPackageReader", () => {
  it("reads host identity through Pi's root virtual module without package JSON", async () => {
    const hostCompatibilityPath = new URL(
      "../host-compatibility.ts",
      import.meta.url,
    ).pathname;
    const buildResult = await Bun.build({
      entrypoints: ["virtual:host-reader-test"],
      format: "esm",
      target: "bun",
      plugins: [
        {
          name: "pi-host-virtual-module",
          setup(build) {
            build.onResolve({ filter: /^virtual:host-reader-test$/ }, () => ({
              namespace: "test",
              path: "host-reader-test",
            }));
            build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
              loader: "ts",
              contents: `
                import { BunHostPackageReader } from ${JSON.stringify(hostCompatibilityPath)};

                export async function readHost() {
                  const result = await new BunHostPackageReader().read();
                  return result.match(
                    (value) => ({ ok: true, value }),
                    (error) => ({ ok: false, error }),
                  );
                }
              `,
            }));
            build.onResolve(
              { filter: /^@earendil-works\/pi-coding-agent$/ },
              () => ({ namespace: "pi-host", path: "pi-coding-agent" }),
            );
            build.onLoad({ filter: /.*/, namespace: "pi-host" }, () => ({
              loader: "js",
              contents: 'export const VERSION = "0.82.1";',
            }));
          },
        },
      ],
    });

    expect(buildResult.success).toBe(true);
    const bundledModule = await buildResult.outputs[0]?.text();
    expect(bundledModule).toBeDefined();
    const moduleUrl = URL.createObjectURL(
      new Blob([bundledModule ?? ""], { type: "text/javascript" }),
    );
    try {
      const readerModule = (await import(moduleUrl)) as {
        readHost(): Promise<{
          readonly ok: boolean;
          readonly value?: { readonly name: string; readonly version: string };
        }>;
      };

      expect(await readerModule.readHost()).toEqual({
        ok: true,
        value: { name: HOST_PACKAGE_NAME, version: "0.82.1" },
      });
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  });
});

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

  it("accepts the local 0.82.1 host above the original tested minor", () => {
    expect(isSupportedHostVersion("0.82.1")).toBe(true);
  });

  it("accepts later stable major versions because support has no ceiling", () => {
    expect(isSupportedHostVersion("1.0.0")).toBe(true);
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
      version: "0.81.0",
    });
    const failure = result._unsafeUnwrapErr();
    expect(failure.impact).toBe("health-only");
    expect(failure.retryable).toBe(false);
  });
});
