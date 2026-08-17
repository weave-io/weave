import { describe, expect, it } from "bun:test";
import {
  BunHostPackageReader,
  checkHostCompatibility,
  HOST_PACKAGE_NAME,
  HOST_RUNTIME_DUPLICATE_REASON,
  HOST_VERSION_FLOOR,
  type HostCapabilityGapDiagnostic,
  hostRuntimeHealthLineFromOutcome,
  isSupportedHostVersion,
  parseSemver,
  renderHostCapabilityGapDiagnostic,
  renderHostRuntimeHealthLine,
  resolveReportedHostIdentity,
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

describe("resolveReportedHostIdentity", () => {
  it("lets the proven host version win over a mismatched imported VERSION", () => {
    const identity = resolveReportedHostIdentity({
      importedVersion: "0.81.1",
      provenVersion: "0.84.2",
    });
    expect(identity.version).toBe("0.84.2");
    expect(identity.diagnostic).toEqual({
      type: HOST_RUNTIME_DUPLICATE_REASON,
      importedVersion: "0.81.1",
      provenVersion: "0.84.2",
      mode: "warning",
    });
    expect(identity.diagnostic?.mode).not.toBe("health-only");
  });

  it("records no diagnostic when imported VERSION matches the proven host", () => {
    const identity = resolveReportedHostIdentity({
      importedVersion: "0.84.2",
      provenVersion: "0.84.2",
    });
    expect(identity.version).toBe("0.84.2");
    expect(identity.diagnostic).toBeUndefined();
  });

  it("keeps the imported VERSION when the host package was not proven", () => {
    const identity = resolveReportedHostIdentity({
      importedVersion: "0.81.1",
    });
    expect(identity.version).toBe("0.81.1");
    expect(identity.diagnostic).toBeUndefined();
  });
});

describe("renderHostRuntimeHealthLine", () => {
  it("renders the single-copy state with the redirected count", () => {
    const line = renderHostRuntimeHealthLine({
      importedVersion: "0.84.2",
      provenVersion: "0.84.2",
      redirectedCount: 3,
    });
    expect(line).toBe("host runtime: single-copy; redirected 3");
    expect(line).not.toContain("health-only");
    expect(line.includes("/")).toBe(false);
  });

  it("renders the duplicate-detected state with a bounded reason", () => {
    const line = renderHostRuntimeHealthLine({
      importedVersion: "0.81.1",
      provenVersion: "0.84.2",
      redirectedCount: 0,
    });
    expect(line).toBe(
      "host runtime: duplicate-detected (host-runtime-duplicate); redirected 0",
    );
    expect(line).not.toContain("health-only");
    expect(line.includes("/")).toBe(false);
  });

  it("treats a missing outcome as single-copy with zero redirects", () => {
    expect(hostRuntimeHealthLineFromOutcome(undefined)).toBe(
      "host runtime: single-copy; redirected 0",
    );
  });
});

describe("BunHostPackageReader proven-version precedence", () => {
  it("returns the proven version and records a warning-only diagnostic", async () => {
    const recorded: unknown[] = [];
    const reader = new BunHostPackageReader({
      importedVersion: "0.81.1",
      provenVersion: "0.84.2",
      onDuplicateDiagnostic: (diagnostic) => {
        recorded.push(diagnostic);
      },
    });
    const result = await reader.read();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      name: HOST_PACKAGE_NAME,
      version: "0.84.2",
    });
    expect(reader.duplicateDiagnostic()?.type).toBe(
      HOST_RUNTIME_DUPLICATE_REASON,
    );
    expect(reader.duplicateDiagnostic()?.mode).toBe("warning");
    expect(reader.duplicateDiagnostic()?.mode).not.toBe("health-only");
    expect(recorded).toEqual([reader.duplicateDiagnostic()]);
    expect(checkHostCompatibility(result._unsafeUnwrap()).isOk()).toBe(true);
  });

  it("does not treat a matching pair as a duplicate", async () => {
    const reader = new BunHostPackageReader({
      importedVersion: "0.84.2",
      provenVersion: "0.84.2",
    });
    const result = await reader.read();
    expect(result._unsafeUnwrap().version).toBe("0.84.2");
    expect(reader.duplicateDiagnostic()).toBeUndefined();
  });
});
