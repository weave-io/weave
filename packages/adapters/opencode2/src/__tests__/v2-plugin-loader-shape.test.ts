/**
 * Scenarios in `tests/adapters/opencode2.scenario.test.ts` cover what a
 * user observes of this adapter.
 *
 * Kept: a packaging guard. That `./server`'s default export,
 * `server` and `WeavePlugin` are one and the same definition is a property of
 * the published entry point, not of anything the plugin does once loaded.
 */

import { describe, expect, it } from "bun:test";
import plugin, { server, WeavePlugin } from "../server.js";

describe("OpenCode 2 plugin loader shape", () => {
  it("exports one native plugin definition through every server alias", () => {
    expect(plugin).toBe(WeavePlugin);
    expect(server).toBe(WeavePlugin);
    expect(WeavePlugin.id).toBe("weave");
    expect(typeof WeavePlugin.setup).toBe("function");
  });
});
