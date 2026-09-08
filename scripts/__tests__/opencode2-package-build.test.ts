import { describe, expect, it } from "bun:test";
import packageManifest from "../../packages/adapters/opencode/package.json";
import {
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_RUNTIME_EXTERNALS,
} from "../constants.js";

describe("OpenCode 2 package build", () => {
  const build = PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-opencode"];

  it("ships separate server, RPC, and Solid TUI entries with declarations", () => {
    expect(build.entries.map((entry) => entry.output)).toEqual([
      "packages/adapters/opencode/dist/index.js",
      "packages/adapters/opencode/dist/plugin.js",
      "packages/adapters/opencode/dist/rpc.js",
      "packages/adapters/opencode/dist/tui.js",
    ]);
    const tui = build.entries.find((entry) => entry.output.endsWith("tui.js"));
    expect(tui !== undefined && "solid" in tui && tui.solid).toBe(true);
    expect(build.declarations.map((entry) => entry.output)).toContain(
      "packages/adapters/opencode/dist/rpc.d.ts",
    );
    expect(build.declarations.map((entry) => entry.output)).toContain(
      "packages/adapters/opencode/dist/tui.d.ts",
    );
    expect(packageManifest.files).toEqual(
      expect.arrayContaining(["server.js", "rpc.js", "tui.js"]),
    );
  });

  it("externalizes every host and UI runtime", () => {
    for (const dependency of [
      "@opencode-ai/client",
      "@opencode-ai/plugin",
      "@opentui/core",
      "@opentui/solid",
      "solid-js",
    ] as const) {
      expect(PUBLIC_RUNTIME_EXTERNALS).toContain(dependency);
    }
  });
});
