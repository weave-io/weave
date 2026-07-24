import { describe, expect, it } from "bun:test";

/**
 * Structural guard for Spec 33 §6/§7.1/§7.2: the safe-init/controller
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
  it("reads the host package at most once per preflight call", async () => {
    const { PiSafeInitializer } = await import("../safe-initializer.js");
    const { DefaultPiCapabilityProber } = await import(
      "../capability-prober.js"
    );
    const { FakeHostPackageReader } = await import(
      "./fakes/fake-host-package-reader.js"
    );
    const { HOST_PACKAGE_NAME } = await import("../host-compatibility.js");
    const { fakeConfigActivator } = await import("./fakes/fake-pi-host.js");

    const reader = FakeHostPackageReader.ok({
      name: HOST_PACKAGE_NAME,
      version: "0.81.1",
    });
    const initializer = new PiSafeInitializer({
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
      [],
    );
    expect(reader.callCount).toBe(1);
  });
});
