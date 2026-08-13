import { describe, expect, it } from "bun:test";

/**
 * Package-isolated consumption test (Pi adapter contract, narrowed to what a
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
    expect("HOST_VERSION_CEILING" in pkg).toBe(false);
    expect(pkg.WEAVE_COMMAND_NAMES).toHaveLength(14);
    expect(pkg.WEAVE_INSPECT_COMMAND_NAME).toBe("weave:inspect");
    expect(pkg.WEAVE_CLEAR_CHILDREN_COMMAND_NAME).toBe("weave:clear-children");
    expect(pkg.WEAVE_RECOVERY_COMMAND_NAME).toBe("weave:recover-children");
    expect(pkg.PI_ADAPTER_CAPABILITY_CONTRACT.capabilities).toHaveLength(21);
    expect(typeof pkg.createPiExtension).toBe("function");
  });

  it("exposes and exercises stable inspection and probe services", async () => {
    const pkg = await import("@weaveio/weave-adapter-pi");
    expect(typeof pkg.PiChildInspector).toBe("function");
    expect(typeof pkg.PiChildSlots).toBe("function");
    expect(typeof pkg.buildChildPickerEntries).toBe("function");
    expect(typeof pkg.createPiSanitizedChildIndex).toBe("function");
    expect(typeof pkg.safeReadHostSurfaceReport).toBe("function");
    expect(pkg.WEAVE_COMMAND_NAMES).toEqual([
      "weave:start",
      "weave:run",
      "weave:status",
      "weave:abort",
      "weave:advance",
      "weave:health",
      "weave:resume",
      "weave:plan",
      "weave:artifact",
      "weave:inspect",
      "weave:history",
      "weave:doctor",
      "weave:clear-children",
      "weave:recover-children",
    ]);

    const slots = new pkg.PiChildSlots();
    expect(
      slots.assign([
        {
          childId: "child",
          name: "child",
          kind: "ordinary",
          status: "running",
          live: true,
        },
      ]),
    ).toEqual(new Map([[1, "child"]]));
    const picker = pkg.buildChildPickerEntries({
      live: [
        {
          childId: "child",
          name: "child",
          kind: "ordinary",
          status: "running",
          live: true,
        },
      ],
    });
    expect(picker.isOk()).toBe(true);
    const exported = pkg.createPiSanitizedChildIndex([
      {
        id: "child",
        name: "child",
        kind: "ordinary",
        status: "running",
        currentTurn: 1,
        startedAtMs: 0,
        elapsedMs: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
        interventionCount: 0,
      },
    ]);
    expect(exported.isOk()).toBe(true);
    const hostReport = await pkg.safeReadHostSurfaceReport(
      new pkg.DefaultPiHostSurfaceReader(),
      { api: {} as never, ui: {} as never, rootExports: { VERSION: "0.81.1" } },
    );
    expect(hostReport.isOk()).toBe(true);
    for (const forbidden of [
      "MAX_SANITIZED_IDENTIFIER_BYTES",
      "projectEntry",
      "truncateUtf8",
      "hostVersionIsValid",
    ]) {
      expect(forbidden in pkg).toBe(false);
    }
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
