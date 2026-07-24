import { describe, expect, it } from "bun:test";

/**
 * Package-isolated consumption test (Spec 33 §24 layer F, narrowed to what a
 * clean-room consumer can exercise without a packed tarball): imports only
 * through the published entry points (`@weaveio/weave-adapter-pi` and its
 * `/extension` subpath), the same way an external consumer's `package.json`
 * `exports` map resolves them, instead of reaching into internal modules.
 */
describe("public package entry points", () => {
  it("exposes the controller/initializer/host-compatibility surface from the root entry", async () => {
    const pkg = await import("@weaveio/weave-adapter-pi");
    expect(typeof pkg.PiExtensionController).toBe("function");
    expect(typeof pkg.PiSafeInitializer).toBe("function");
    expect(typeof pkg.checkHostCompatibility).toBe("function");
    expect(typeof pkg.isSupportedHostVersion).toBe("function");
    expect(pkg.HOST_PACKAGE_NAME).toBe("@earendil-works/pi-coding-agent");
    expect(pkg.HOST_VERSION_FLOOR).toBe("0.81.1");
    expect(pkg.HOST_VERSION_CEILING).toBe("0.82.0");
    expect(pkg.WEAVE_COMMAND_NAMES).toHaveLength(9);
    expect(pkg.PI_ADAPTER_CAPABILITY_CONTRACT.capabilities).toHaveLength(19);
    expect(typeof pkg.createPiExtension).toBe("function");
  });

  it("exposes exactly one default extension factory from the /extension subpath", async () => {
    const extensionModule = await import("@weaveio/weave-adapter-pi/extension");
    expect(typeof extensionModule.default).toBe("function");
    expect(typeof extensionModule.createPiExtension).toBe("function");
  });

  it("the default extension factory is safe to construct repeatedly without side effects", async () => {
    const { createPiExtension } = await import("@weaveio/weave-adapter-pi");
    const first = createPiExtension();
    const second = createPiExtension();
    expect(typeof first).toBe("function");
    expect(typeof second).toBe("function");
    expect(first).not.toBe(second);
  });
});
