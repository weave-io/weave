/**
 * Regression test: `@weave/adapter-opencode/plugin` loader shape.
 *
 * OpenCode's `getLegacyPlugins` loader iterates **all** named exports of the
 * plugin module and throws `TypeError: Plugin export is not a function` for
 * any export that is not a function. This test mirrors that behaviour so that
 * adding a non-function export to `plugin.ts` (e.g. a string constant, an
 * object, or a class instance) will fail here before it reaches production.
 *
 * ## What is asserted
 *
 * 1. Every named export from `../plugin.ts` is a function.
 * 2. The default export is a function (the `Plugin` entry point).
 * 3. The `server` export is a function (the `PluginModule.server` alias).
 * 4. The `WeavePlugin` export is a function.
 *
 * ## Why this matters
 *
 * The bare `@weave/adapter-opencode` entry (`dist/index.js`) exports
 * `WEAVE_OWNERSHIP_TAG` (a string) and other non-function values. That caused
 * OpenCode to throw at startup. The `./plugin` subpath (`dist/plugin.js`) was
 * introduced to export only functions. This test is the regression guard that
 * keeps the plugin subpath safe.
 *
 * See: docs/adr/0003-opencode-adapter-materialization-shape.md §1
 * See: docs/adapter-readiness-status.md — Installation and runtime story
 */

import { describe, expect, it } from "bun:test";

// Import the plugin module as a namespace so we can iterate all exports.
// This mirrors how OpenCode's getLegacyPlugins loader inspects the module.
import * as pluginModule from "../plugin.js";

// ---------------------------------------------------------------------------
// Regression: every export from the plugin entry must be a function
// ---------------------------------------------------------------------------

describe("plugin subpath — OpenCode getLegacyPlugins loader shape", () => {
  it("every named export is a function (mirrors getLegacyPlugins check)", () => {
    // OpenCode iterates all exports and throws TypeError for non-functions.
    // If this test fails, a non-function value was added to plugin.ts and
    // would break OpenCode's plugin loader at startup.
    const nonFunctionExports: string[] = [];

    for (const [key, value] of Object.entries(pluginModule)) {
      if (typeof value !== "function") {
        nonFunctionExports.push(`${key}: ${typeof value} (${String(value)})`);
      }
    }

    expect(nonFunctionExports).toEqual([]);
  });

  it("default export is a function (the Plugin entry point)", () => {
    // OpenCode calls the default export as the plugin function.
    expect(typeof pluginModule.default).toBe("function");
  });

  it("server export is a function (PluginModule.server alias)", () => {
    // PluginModule shape: { id?: string; server: Plugin; tui?: never }
    // OpenCode also accepts { server: Plugin } as a PluginModule.
    expect(typeof pluginModule.server).toBe("function");
  });

  it("WeavePlugin export is a function", () => {
    expect(typeof pluginModule.WeavePlugin).toBe("function");
  });

  it("createWeavePlugin export is a function", () => {
    expect(typeof pluginModule.createWeavePlugin).toBe("function");
  });

  it("default, server, and WeavePlugin are the same function", () => {
    // All three are aliases for the same plugin instance.
    expect(pluginModule.default).toBe(pluginModule.WeavePlugin);
    expect(pluginModule.server).toBe(pluginModule.WeavePlugin);
  });

  it("module has no non-function named exports (exhaustive check)", () => {
    // Explicit exhaustive list — if a new export is added to plugin.ts,
    // this test will catch it if it is not a function.
    const exportNames = Object.keys(pluginModule).sort();

    // All known exports are functions. If this list grows with a non-function,
    // the 'every named export is a function' test above will fail first.
    for (const name of exportNames) {
      const value = pluginModule[name as keyof typeof pluginModule];
      expect(
        typeof value,
        `export '${name}' must be a function to satisfy OpenCode getLegacyPlugins loader`,
      ).toBe("function");
    }
  });
});
