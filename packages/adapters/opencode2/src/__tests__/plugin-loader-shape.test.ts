/**
 * Scenarios in `tests/adapters/opencode2.scenario.test.ts` cover what a
 * user observes of this adapter.
 *
 * Kept, but read the note: this module is imported by nothing and
 * exported from no package entry point, so it is reachable only from this
 * test. See `docs/testing-strategy.md`.
 */

import { describe, expect, it } from "bun:test";

import plugin from "../plugin.js";

describe("plugin loader shape", () => {
  it("exports a Plugin-shaped default without booting a real host", () => {
    expect(typeof plugin.id).toBe("string");
    expect(plugin.id).toBe("weave");
    expect(typeof plugin.setup).toBe("function");
  });
});
