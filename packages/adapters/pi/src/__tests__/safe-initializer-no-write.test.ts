import { describe, expect, it } from "bun:test";

/**
 * Structural guard for Pi adapter contract: the safe-init/controller
 * foundation MUST NOT touch the filesystem, spawn a process, or start a
 * timer. Rather than trust behavior alone, this scans the compiled sources
 * for forbidden tokens so a future edit that introduces one of these calls
 * fails loudly here instead of silently reintroducing a factory-time side
 * effect.
 */
const FORBIDDEN_TOKENS = [
  "Bun.write(",
  "Bun.file(",
  "Bun.spawn(",
  "Bun.spawnSync(",
  "setTimeout(",
  "setInterval(",
  'require("fs"',
  'from "fs"',
  'from "node:fs"',
];

const GUARDED_FILES = [
  "safe-initializer.ts",
  "controller.ts",
  "capability-prober.ts",
  "capability-declarations.ts",
  "commands.ts",
  "host-inventory.ts",
];

describe("safe initializer / controller no-write invariants", () => {
  for (const file of GUARDED_FILES) {
    it(`${file} contains no filesystem, process, or timer calls`, async () => {
      const path = new URL(`../${file}`, import.meta.url);
      const contents = await Bun.file(path).text();
      for (const token of FORBIDDEN_TOKENS) {
        expect(contents.includes(token)).toBe(false);
      }
    });
  }
});

describe("PiSafeInitializer.preflight call discipline", () => {
  it("does not reprobe or mutate the immutable host report when a required surface is missing", async () => {
    const { PiSafeInitializer } = await import("../safe-initializer.js");
    const { ALL_CAPABILITY_IDS } = await import("@weaveio/weave-engine");
    const { PI_HOST_SURFACE_IDS } = await import(
      "../host-compatibility-matrix.js"
    );
    const { readHostSurfaceReport } = await import("../host-inventory.js");
    const { HOST_PACKAGE_NAME } = await import("../host-compatibility.js");
    const { FakeHostPackageReader } = await import(
      "./fakes/fake-host-package-reader.js"
    );
    const { fakeConfigActivator } = await import("./fakes/fake-pi-host.js");

    let probeCalls = 0;
    const initializer = new PiSafeInitializer({
      delegationAuthority: () => ({ status: "ready" as const }),
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: {
        probe: () => {
          probeCalls += 1;
          return ALL_CAPABILITY_IDS.map((capabilityId) => ({
            capabilityId,
            probeStatus: "ok" as const,
          }));
        },
      },
      configActivator: fakeConfigActivator(),
    });
    const hostSurface = readHostSurfaceReport(
      PI_HOST_SURFACE_IDS.filter((surfaceId) => surfaceId !== "rpc-steer").map(
        (surfaceId) => ({
          surfaceId,
          status: "native" as const,
          details: "fixture",
        }),
      ),
    );

    const result = await initializer.preflight(
      {
        mode: "tui",
        isProjectTrusted: () => true,
        cwd: "/fake/project",
        modelRegistry: { getAvailable: () => [] },
      },
      [],
      hostSurface,
    );
    const preflight = result._unsafeUnwrap();

    expect(preflight.healthOnlyMode).toBe(true);
    expect(probeCalls).toBe(1);
    expect(preflight.healthReport.probeResults).toHaveLength(
      ALL_CAPABILITY_IDS.length,
    );
    expect(Object.isFrozen(hostSurface)).toBe(true);
    expect(Object.isFrozen(hostSurface.probes)).toBe(true);
    expect(hostSurface.probes.every((probe) => Object.isFrozen(probe))).toBe(
      true,
    );
    expect(() => {
      (hostSurface.probes[0] as { status: string }).status = "native";
    }).toThrow();
    expect(() => {
      (hostSurface.probes as unknown as unknown[]).pop();
    }).toThrow();
  });

  it("reads the host package at most once per preflight call", async () => {
    const { PiSafeInitializer } = await import("../safe-initializer.js");
    const { DefaultPiCapabilityProber } = await import(
      "../capability-prober.js"
    );
    const { FakeHostPackageReader } = await import(
      "./fakes/fake-host-package-reader.js"
    );
    const { HOST_PACKAGE_NAME } = await import("../host-compatibility.js");
    const { safeReadHostSurfaceReport } = await import("../host-inventory.js");
    const { fakeConfigActivator } = await import("./fakes/fake-pi-host.js");

    const reader = FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: "0.81.1",
    });
    const initializer = new PiSafeInitializer({
      delegationAuthority: () => ({ status: "ready" as const }),
      hostPackageReader: reader,
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: fakeConfigActivator(),
    });
    await initializer.preflight(
      {
        mode: "tui",
        isProjectTrusted: () => true,
        cwd: "/fake/project",
        modelRegistry: { getAvailable: () => [] },
      },
      [],
    );
    expect(reader.callCount).toBe(1);

    let hostSurfaceReads = 0;
    await safeReadHostSurfaceReport(
      {
        read: () => {
          hostSurfaceReads += 1;
          return Promise.resolve({
            isOk: () => true,
            isErr: () => false,
            value: [],
          }) as never;
        },
      },
      { api: {} as never, ui: {} as never },
    );
    expect(hostSurfaceReads).toBe(1);
  });
});
